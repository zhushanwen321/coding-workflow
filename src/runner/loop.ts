/**
 * 通用调度循环（u7 验收文档 docs/rewrite/acceptance/u7-acceptance.md 锁定；
 * canon《design-rewrite-architecture.md》§3.3 D4「runner 无智能无状态：状态全在
 * 账本」、§3.4 组件分层「调度循环 = frontier → 全量批次 spawn → 等退出 → 证据
 * 回收 → 重算」）。
 *
 * 对 M0 human-loop（u5b）的泛化：后端无关——不感知适配器类型（human / pi /
 * 测试专用一视同仁，差异被 AgentSpawn 契约隔离在 types.ts）。循环自身只读账本
 * 投影 + 生成 brief + 派发 + 等待；全部 agent 阶段的状态推进由被派发 agent（经
 * 适配器起的真实进程）写账本完成——账本即状态，Ctrl-C 中断重跑即续。唯一例外是
 * u8 的内部节点集成（canon §3.3 D6「内部节点 build = runner merge 子树」）：集成
 * 是确定性代码无智能，不派 agent，由本循环直接执行 runIntegrationVerify 并以其
 * 结果写 root 的 VerifyRan（pass/fail 都入账；fail 留审计，下轮重派重试，与
 * builder 重派同待遇）。
 *
 * 派发对象规则（每轮对投影重算，子树 BFS 序）：
 *   - created 且无 spec      → designer（一次完成建子（root 无子时，fx-3 R5.2
 *     任务书第 0 步）+ spec 提交 + spec-review）
 *   - created 且有 spec 且最后一条 SpecSubmitted 之后无 spec-review pass → designer
 *     （fx-1 R2 第四分支：重提 spec / 提交后未审 → 派 designer 补审——不依赖 agent
 *     记性去补 review 事件，消除「created + specs>0」派发真空导致的死区）
 *   - spec-frozen 内部节点（split 非空且不含自身）且 split 声明的子有未 created
 *     者 → designer（fx-3 R5.3 派发兜底：补建子任务书——处理 R5.1 gate 生效前
 *     的历史账本/旁路数据；先于集成等待分支拦截，子不齐不集成）
 *   - spec-frozen 叶子（split 空）且（无子 ∨ 子全部 closed）→ builder agent
 *     （rootLast：子的产出是 root 验收的输入，root 的 build 等子树收尾）
 *   - spec-frozen 内部节点（split 非空且不含自身）且子全部 verified → 不派 agent，
 *     直接 runIntegrationVerify（u8 rootLast 升级：集成的物理前提是子证据齐——
 *     verified 即证据链闭合，不必等 exec-review 收尾 closed）。连续 fail 达上限
 *     （fx-2 R4a，2 次）→ 停止自动重派，改派 designer 处置契约漂移（brief 含失败
 *     契约清单与二选一处置路径）。split 含自身
 *     unitId = 自引用（gate 规则⑥ fx-1 已拒新账本）→ 记 stderr 警告并按叶子语义
 *     参与派发，绝不作为内部节点等待子树（fx-1 R1 loop 级防御）
 *   - verified 且未 closed   → reviewer（exec-review）
 *
 * 等待期间零锁（canon D4：等待 spawn 期间持锁会饿死子进程的账本写入）。
 * 失败语义只看四态退出（types.ts）：exit≠0 / TIMEOUT / CRASH 可重派（下轮重算
 * 自然再次进入派发集合）；SPAWN_ERROR 配置错误不重试，kill 全部 in-flight 后
 * exit 1。
 *
 * M1 简化（验收文档锁定）：workdir = cwd 本身（无独立 worktree，M2 集成时升级）；
 * 循环不亲自创建 split 子 unit（fx-3 后子创建职责归 designer：首派任务书第 0 步
 * 指令化建子，spec gate 强制先建子后提 spec；循环仅在子未建时派 designer 兜底）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fold } from "../core/fold.js";
import type {
  Contract,
  DiscriminatedEvent,
  LedgerEvent,
  SequencedProjection,
  SequencedUnitProjection,
  VerifyRanPayload,
} from "../events/types.js";
import { loadLedger, unitStatus } from "../readonly/load.js";
import { EventLedger } from "../store/events-log.js";
import { getCwHome, ledgerPath } from "../store/project.js";
import { timeoutForAcceptance } from "../verify/run.js";
import { integrationRecoveryGuidance, readIntegrateReport, runIntegrationVerify } from "./integrate.js";
import type {
  AgentRole,
  AgentSpawnAdapter,
  SpawnHandle,
  SpawnResult,
} from "./spawn/types.js";

/** 账本轮询间隔默认值（--poll-ms；验收文档：默认 1000） */
export const DEFAULT_LOOP_POLL_MS = 1_000;
/** 无账本进展上限默认值（--max-idle-ms；验收文档：默认 30min） */
export const DEFAULT_LOOP_MAX_IDLE_MS = 1_800_000;
/** 同批 in-flight spawn 上限默认值（--max-concurrency；验收文档：默认 3） */
export const DEFAULT_LOOP_MAX_CONCURRENCY = 3;
/** 单次 agent spawn 超时（验收文档循环逻辑 3：timeoutMs 固定 30min） */
const AGENT_SPAWN_TIMEOUT_MS = 1_800_000;
/**
 * 同一内部节点集成的连续 fail 重派上限（fx-2 R4a，验收文档锁定 2 次）：达到后
 * 不再自动重派集成，改派 designer 处置契约漂移。R4b 的修复即此上限本身——集成
 * fail 的 VerifyRan 审计事件会持续喂活 idle 进展判定（totalEvents 每轮 +1），
 * 无上限时 maxIdleMs 永不触发 = 无限循环烧 CPU；有上限后账本不再自我喂食，
 * designer 若也无进展，maxIdleMs 正常触发 exit 1（回归「有界空转」语义）。
 */
const INTEGRATION_MAX_CONSECUTIVE_FAILS = 2;

export interface RunLoopOptions {
  rootId: string;
  adapter: AgentSpawnAdapter;
  cwd: string;
  pollMs?: number;
  maxIdleMs?: number;
  maxConcurrency?: number;
}

/** in-flight 派发（同 unitId 不同 role 可并存——canon「每单元最多 1 builder + 1 reviewer」） */
interface InFlightSpawn {
  role: AgentRole;
  unitId: string;
  handle: SpawnHandle;
}

interface DispatchTarget {
  role: AgentRole;
  unitId: string;
  /**
   * u8（canon D6）：内部节点（spec.split 非空）的 builder 不派 agent，由循环直接
   * 执行 runIntegrationVerify（确定性代码）。不占 in-flight 并发额度（不是 spawn）。
   */
  integration: boolean;
}

/** race 的产出：任一 spawn 退出时携带其 flight 与四态结果；poll 到点为 null */
interface FinishedWatch {
  flight: InFlightSpawn;
  result: SpawnResult;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function emit(lines: readonly string[]): void {
  process.stdout.write(`${lines.join("\n")}\n`);
}

function emitErr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * root 子树的 unit 列表（BFS 序 = root 先、子按账本创建序）。实现与 human-loop
 * 的同名私有函数一致（泛化期两处并存，human-loop 退役后单一化）。
 */
function subtreeUnits(
  projection: SequencedProjection,
  rootId: string,
): SequencedUnitProjection[] {
  const childrenOf = new Map<string, string[]>();
  for (const unit of projection.units.values()) {
    if (unit.parentId !== null) {
      const siblings = childrenOf.get(unit.parentId) ?? [];
      siblings.push(unit.unitId);
      childrenOf.set(unit.parentId, siblings);
    }
  }
  const units: SequencedUnitProjection[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const unit = projection.units.get(current);
    if (unit === undefined) break; // 不可达：BFS 只入账内 id
    units.push(unit);
    queue.push(...(childrenOf.get(current) ?? []));
  }
  return units;
}

/** builder 的 rootLast 等待条件（叶子路径）：该 unit 的全部子 unit（按账本 parentId）已 closed */
function childrenAllClosed(
  subtree: readonly SequencedUnitProjection[],
  unit: SequencedUnitProjection,
): boolean {
  return subtree.every(
    (candidate) => candidate.parentId !== unit.unitId || unitStatus(candidate) === "closed",
  );
}

/** 内部节点判定 = 最后一条冻结 spec 的 split 非空（canon D1：层级是数据不是代码） */
function splitOf(unit: SequencedUnitProjection): SequencedUnitProjection["specs"][number]["split"] {
  return unit.specs[unit.specs.length - 1]?.split ?? [];
}

/**
 * 内部节点的集成等待条件（u8 rootLast 升级）：split 声明的全部子 unit 已 verified
 * （closed 蕴含 verified，同样放行——证据链已闭合）。子以 split 为权威集合而非
 * 账本 parentId：split 声明了但子尚未创建时，parentId 集合的「部分子全 verified」
 * 会放行一次缺子集成（静默漏掉一个子树），split 口径下未创建 = 未 verified = 等待。
 */
function splitChildrenAllVerified(
  projection: SequencedProjection,
  unit: SequencedUnitProjection,
): boolean {
  return splitOf(unit).every((entry) => {
    const child = projection.units.get(entry.unitId);
    if (child === undefined) {
      return false;
    }
    const status = unitStatus(child);
    return status === "verified" || status === "closed";
  });
}

/** split 自引用判定（fx-1 R1）：任一条目 unitId === 自身 unitId */
function splitSelfReferences(unit: SequencedUnitProjection): boolean {
  return splitOf(unit).some((entry) => entry.unitId === unit.unitId);
}

/**
 * split 声明但尚未 created 的子 unitId 清单（fx-3 R5.3 派发兜底的判定输入）。
 * 与 splitChildrenAllVerified 同口径以 split 为权威集合（非账本 parentId）。
 */
function splitChildrenNotCreated(
  projection: SequencedProjection,
  unit: SequencedUnitProjection,
): string[] {
  return splitOf(unit)
    .filter((entry) => !projection.units.has(entry.unitId))
    .map((entry) => entry.unitId);
}

/**
 * 最后一条 SpecSubmitted 之后是否存在 spec-review pass verdict。与 deriveStatus
 * 的「之后存在」语义同口径（fold.ts 禁改，此处按 SequencedUnitProjection 的顺序
 * 锚点重算）——fx-1 R2 第四分支的判定输入：重提 spec = 打回重审，旧 pass 不计数。
 */
function hasSpecReviewPassAfterLastSpec(unit: SequencedUnitProjection): boolean {
  const lastSpecSeq = unit.lastSpecSeq;
  if (lastSpecSeq === null) {
    return false;
  }
  return unit.verdicts.some(
    (verdict, i) =>
      unit.verdictSeqs[i] > lastSpecSeq &&
      verdict.verdictKind === "spec-review" &&
      verdict.verdict === "pass",
  );
}

/**
 * 各 unit 的连续 VerifyRan fail 计数（fx-2 R4a 重派上限的判定输入）：自该 unit
 * 上一条 SpecSubmitted / result=pass 的 VerifyRan 之后连续 fail 的次数（任何
 * pass / 新 spec 提交清零——验收文档锁定的口径）。SpecSubmitted 与 VerifyRan
 * 的相对顺序在 fold 投影里已丢失（平行数组），须从原始事件流重放；与
 * hasSpecReviewPassAfterLastSpec 的「之后存在」语义同族。
 */
function consecutiveIntegrationFails(events: readonly LedgerEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of events) {
    const event = record as DiscriminatedEvent;
    if (event.type === "SpecSubmitted") {
      counts.set(event.payload.unitId, 0);
    } else if (event.type === "VerifyRan") {
      const previous = counts.get(event.payload.unitId) ?? 0;
      counts.set(
        event.payload.unitId,
        event.payload.result === "fail" ? previous + 1 : 0,
      );
    }
  }
  return counts;
}

/**
 * 派发对象集合（纯函数；规则见模块头）。in-flight 的同 (unitId, role) 不重复派。
 * consecutiveFails = 各 unit 连续 VerifyRan fail 计数（fx-2 R4a 上限判定输入）。
 */
function computeDispatchTargets(
  projection: SequencedProjection,
  rootId: string,
  inFlight: readonly InFlightSpawn[],
  consecutiveFails: ReadonlyMap<string, number>,
): DispatchTarget[] {
  const subtree = subtreeUnits(projection, rootId);
  const targets: DispatchTarget[] = [];
  for (const unit of subtree) {
    const status = unitStatus(unit);
    let role: AgentRole | undefined;
    let integration = false;
    if (status === "created" && unit.specs.length === 0) {
      role = "designer";
    } else if (
      status === "created" &&
      unit.specs.length > 0 &&
      !hasSpecReviewPassAfterLastSpec(unit)
    ) {
      // fx-1 R2 第四分支：spec 已提交待审（builder 重提 spec / designer 半途退出）
      // → 派 designer 补审（brief 见 renderBrief 的补审任务书），不再空转
      role = "designer";
    } else if (status === "spec-frozen") {
      // fx-1 R1 loop 级防御：split 含自身 = 自引用（gate 规则⑥已拒新账本，此处为
      // 纵深防御）→ 不按内部节点处理（等待「自己 verified」永不满足 = 死锁），
      // 记一行 stderr 警告后按叶子语义参与派发
      const selfReferencing = splitSelfReferences(unit);
      if (selfReferencing) {
        emitErr(
          `[runner] 警告：unit "${unit.unitId}" 的 spec.split 含自身（自引用——gate 规则⑥应拒，` +
            "账本可能建于该规则生效前或被旁路写入）——不作为内部节点等待子树，按叶子语义派发。\n",
        );
      }
      if (!selfReferencing && splitOf(unit).length > 0) {
        const missingChildren = splitChildrenNotCreated(projection, unit);
        if (missingChildren.length > 0) {
          // fx-3 R5.3 派发兜底出口：spec 声明了子但未创建（历史账本/旁路写入
          // 绕过 fx-3 R5.1 gate 的数据）→ 派 designer 补建子。必须在集成等待
          // 分支之前拦截——子不齐不集成，且 splitChildrenAllVerified 对未创建
          // 子永 false = 派发真空（终验第 3 次空转 45 分钟的根因）
          role = "designer";
        } else if (splitChildrenAllVerified(projection, unit)) {
          // 内部节点：子全 verified 即集成（u8 派发时机升级，不等子 closed）
          if ((consecutiveFails.get(unit.unitId) ?? 0) >= INTEGRATION_MAX_CONSECUTIVE_FAILS) {
            // fx-2 R4a：集成连续 fail 达上限——不再自动重派（fail 审计事件每轮
            // 喂活 idle 判定 = R4b 无限循环），改派 designer 处置契约漂移（brief
            // = integrationDriftTasks：失败事实清单 + 二选一处置路径）
            role = "designer";
          } else {
            role = "builder";
            integration = true;
          }
        }
      } else if (childrenAllClosed(subtree, unit)) {
        // 叶子：现行 rootLast 不变（无子 ∨ 子全部 closed）
        role = "builder";
      }
    } else if (status === "verified") {
      role = "reviewer";
    }
    if (role === undefined) {
      continue;
    }
    const alreadyInFlight = inFlight.some(
      (flight) => flight.unitId === unit.unitId && flight.role === role,
    );
    if (alreadyInFlight) {
      continue;
    }
    targets.push({ role, unitId: unit.unitId, integration });
  }
  return targets;
}

// ---- 内部节点集成（u8 / canon D6：集成 = 内部节点的 verify，确定性代码不派 agent） ----

/** 集成等待的一个子 build 锚点（unitId + 其最后一条 build 证据的 commit） */
interface IntegrationChild {
  unitId: string;
  commit: string;
}

/**
 * 集成契约集合：root spec 契约 ∪ 各子 spec 契约（跨节点承诺由 provider 的 spec
 * 冻结——root 声明集成级契约，子声明自己提供的契约，两者都属「切分时冻结的
 * 承诺」）。同 id 冲突以 root 为先（root 是集成契约的 owner；冲突本身是分解
 * 缺陷，M2 不展开，报告里的比对结果会暴露不一致的那份）。
 */
function collectIntegrationContracts(
  root: SequencedUnitProjection,
  children: readonly SequencedUnitProjection[],
): Contract[] {
  const owners = [root, ...children];
  const seen = new Set<string>();
  const contracts: Contract[] = [];
  for (const owner of owners) {
    for (const contract of owner.specs[owner.specs.length - 1]?.contracts ?? []) {
      if (seen.has(contract.id)) {
        continue;
      }
      seen.add(contract.id);
      contracts.push(contract);
    }
  }
  return contracts;
}

/**
 * 执行一次内部节点集成并写 root 的 VerifyRan（pass/fail 都入账——与 u4a verify
 * 「fail 也是打回依据，审计必需」同语义）。失败不抛错：fail VerifyRan 留审计，
 * unit 停在 spec-frozen，下轮重算自然重派集成（与 builder 重派同待遇）。
 * 入账失败（锁竞争等）也只出声不炸循环——产物已落盘，下轮重试自愈。
 */
async function runIntegrationDispatch(
  cwd: string,
  projection: SequencedProjection,
  unitId: string,
): Promise<void> {
  const unit = projection.units.get(unitId);
  const spec = unit?.specs[unit.specs.length - 1];
  if (unit === undefined || spec === undefined) {
    return; // 不可达（target 来自同一投影且已过 spec-frozen 判定）
  }

  const children: IntegrationChild[] = [];
  const childUnits: SequencedUnitProjection[] = [];
  for (const entry of spec.split) {
    const child = projection.units.get(entry.unitId);
    const lastEvidence = child?.evidences[child.evidences.length - 1];
    if (child === undefined || lastEvidence === undefined) {
      emitErr(
        `[runner] 集成前置不变式破坏：unit "${entry.unitId}"（"${unitId}" 的 split 子节点）` +
          "无 build 证据——verified 状态不可能缺失 evidence，账本疑似被外部改动。" +
          `恢复动作：cw status / cw report --unit "${entry.unitId}" 核对证据链。\n`,
      );
      return;
    }
    children.push({ unitId: entry.unitId, commit: lastEvidence.commit });
    childUnits.push(child);
  }

  emit([
    `[runner] ${new Date().toISOString()} 集成验证 unit "${unitId}"（内部节点 build = 子树集成，不派 agent）`,
  ]);
  const result = await runIntegrationVerify({
    cwd,
    rootId: unitId,
    children,
    rootAcceptance: spec.acceptance,
    contracts: collectIntegrationContracts(unit, childUnits),
    // 集成批次混装各 type 验收而 runIntegrationVerify 只收单一 timeoutMs（必填
    // number，src/runner/integrate.ts 非本任务领地），取分档上限（e2e 30min）防
    // 最慢档被误杀；其参数可选化后此处改传 undefined 即恢复逐条分档
    timeoutMs: timeoutForAcceptance("e2e-real"),
  });

  // acceptanceIds：pass = 覆盖的验收 id（子 ∪ root，manual 免机器验证一并入）；
  // fail = 仅 root manual（整轮集成未通过，机器判定 pass 集记空；逐条结果见
  // integrate-report.json 与 stderr 失败清单）
  const childIds = childUnits.flatMap(
    (child) => child.specs[child.specs.length - 1]?.acceptance.map((ac) => ac.id) ?? [],
  );
  const rootIds = spec.acceptance.map((ac) => ac.id);
  const acceptanceIds = result.ok
    ? [...new Set([...childIds, ...rootIds])]
    : spec.acceptance.filter((ac) => ac.type === "manual").map((ac) => ac.id);

  const payload: VerifyRanPayload = {
    unitId,
    runId: result.runId,
    reportHash: sha256OfFile(result.reportPath),
    result: result.ok ? "pass" : "fail",
    acceptanceIds,
  };
  const ledger = new EventLedger(ledgerPath(getCwHome(), cwd));
  try {
    ledger.append("VerifyRan", payload);
  } catch (e) {
    emitErr(
      `[runner] 集成结果入账失败（unit "${unitId}"，产物保存在 ${result.reportPath}）：` +
        `${e instanceof Error ? e.message : String(e)}。恢复动作：按上方账本错误处理（通常是锁竞争），` +
        "下轮会重跑集成自愈。\n",
    );
    return;
  }

  if (result.ok) {
    emit([
      `[runner] 集成验证 unit "${unitId}" result=pass runId=${result.runId}`,
      `[runner] report: ${result.reportPath}`,
    ]);
    return;
  }
  emitErr(
    [
      `[runner] 集成验证 unit "${unitId}" 失败（${result.failures.length} 项，已写 fail VerifyRan 留审计，` +
        `下轮重派重试——连续 fail 达 ${INTEGRATION_MAX_CONSECUTIVE_FAILS} 次后停止自动重派、转派 designer 处置）：`,
      ...result.failures.map((f) => `  ${f}`),
      `[runner] report: ${result.reportPath}`,
      "",
    ].join("\n"),
  );
}

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ---- brief 生成（循环六步之 2：unit 上下文 + role 任务书模板，file-based 传递） ----

const ROLE_TASKS: Record<Exclude<AgentRole, "designer">, (unitId: string) => string> = {
  builder: (unitId) => [
    "## 你的任务（builder）",
    "1. 在 workdir 实现该 unit 冻结验收要求的目标并 git commit（取 hash：git rev-parse HEAD）。",
    `2. 提交 build 证据：cw evidence submit --kind build --unit ${unitId} --commit <hash> --run-id <自拟唯一 runId> [--file <产物路径>...]`,
    `3. 触发干净重跑验证：cw verify --unit ${unitId}`,
    "完成标志：unit 进入 verified。",
  ].join("\n"),
  reviewer: (unitId) => [
    "## 你的任务（reviewer）",
    `对该 unit 提交 exec-review 结论（审查依据：cw report --unit ${unitId} 的证据链与 verify 结果）：`,
    `cw review submit --unit ${unitId} --verdict-kind exec-review --verdict pass|fail [--comment <意见>]`,
    "完成标志：verdict 为 pass 时 unit 进入 closed。",
  ].join("\n"),
};

/**
 * designer 首派任务书（created 且 specs===0）。fx-3 R5.2：root 无子时追加第 0 步
 * 建子指令——建子职责从 brief 实施建议的「建议」措辞（print 模式 agent 会停下
 * 询问，终验第 3 次现场）升级为系统任务书的指令化步骤，与 fx-3 R5.1 gate
 * （先建子后提 spec）口径对齐。条件收窄到 root 无子：已有子的 root 重派 /
 * 叶子首派不重复教建子。
 */
function designerFirstTasks(unit: SequencedUnitProjection, projection: SequencedProjection): string {
  const isRootWithoutChildren =
    unit.parentId === null &&
    ![...projection.units.values()].some((candidate) => candidate.parentId === unit.unitId);
  const stepZero = isRootWithoutChildren
    ? [
        `0. 本 unit 是根节点且尚无子 unit——若任务书/brief 含拆分建议：先为每个子执行`,
        `   cw create --id <slug> --brief <子brief文件> --parent ${unit.unitId}（子 brief 可为占位文件），`,
        "   再进入第 1 步（spec.split 声明的子必须已创建，否则提交会被拒）。",
      ]
    : [];
  return [
    "## 你的任务（designer）",
    ...stepZero,
    `1. 撰写该 unit 的 spec.json。验收五规则（src/gates/spec-rules.ts）：验收非空；`,
    "   核心 case 的 type 须为 e2e-real / e2e-mock 且带可执行 command；含 mock 须附",
    "   mock 保真度说明；至少一条 unit 级用例。",
    `2. 提交 spec：cw evidence submit --kind spec --unit ${unit.unitId} --file spec.json`,
    `3. 提交 spec 审查：cw review submit --unit ${unit.unitId} --verdict-kind spec-review --verdict pass`,
    "完成标志：unit 进入 spec-frozen（cw status 可查）。",
  ].join("\n");
}

/**
 * fx-3 R5.3 兜底出口的任务书（spec-frozen 且 split 子未建的 designer）：清单式
 * 建子指令。designer 建完子即完成本任务书退出——子 unit 的 spec 由下轮首派的
 * designer 撰写，本 unit 的冻结 spec 无需改动。
 */
function missingChildrenTasks(unit: SequencedUnitProjection, missing: readonly string[]): string {
  return [
    "## 你的任务（designer：补建 split 子 unit）",
    "",
    `unit "${unit.unitId}" 的冻结 spec 声明了 ${splitOf(unit).length} 个子 unit 但 ${missing.length} 个未创建`,
    "（子不齐则集成永不发生，分解树无法建立）——请先创建缺失子：",
    ...missing.map((childId) => `  cw create --id ${childId} --brief <文件> --parent ${unit.unitId}`),
    "",
    "子 brief 可为占位文件；建完即完成本任务书，无需改动本 unit 的冻结 spec。",
    `完成标志：cw status 中上述子 unit 均为 created。`,
  ].join("\n");
}

/**
 * fx-1 R2 第四分支的任务书（spec 已提交待审时的 designer）：只审不重写——重新
 * 撰写并提交新 spec 会再次触发「新 spec 无过审」回到同态状态，补审才是出口。
 */
function reReviewTasks(unitId: string): string {
  return [
    "## 你的任务（designer：spec 补审）",
    "spec 已提交待审——请审查该 spec 并执行 cw review submit --verdict-kind spec-review --verdict pass|fail",
    `（审查对象：cw report --unit ${unitId} 中最后一条 SpecSubmitted；pass 后 unit 进入 spec-frozen，勿重新提交 spec）`,
  ].join("\n");
}

/**
 * fx-2 R4a 上限出口的任务书（集成连续 fail 达上限后的 designer）：内嵌最近一次
 * 集成报告的失败事实（契约清单 + 失败验收 id）与二选一处置指引——契约漂移的
 * 归属（改 spec 契约还是修 provider 实现）需要语义判断，是 designer 的职责而非
 * runner 的（canon D4：runner 无智能）。报告不可读时降级为冻结 spec 的契约全集
 * + 指向查证命令（错误可操作闭环）。
 */
function integrationDriftTasks(unit: SequencedUnitProjection, cwd: string): string {
  const lastFailRun = [...unit.verifyRuns]
    .reverse()
    .find((run) => run.result === "fail" && run.runId.startsWith("integrate-"));
  const read =
    lastFailRun === undefined
      ? null
      : readIntegrateReport(cwd, unit.unitId, lastFailRun.runId);

  const factLines: string[] = [];
  if (read === null) {
    const contracts = unit.specs[unit.specs.length - 1]?.contracts ?? [];
    factLines.push(
      `- 最近一次集成报告不可读——失败明细见 cw report --unit ${unit.unitId}；当前冻结 spec 的契约全集：`,
      ...(contracts.length === 0
        ? ["  （无契约——fail 来自验收红或 commit 可达性，见失败明细）"]
        : contracts.map(
            (c) => `  - ${c.id}: signature "${c.signature}" 期望文件 ${c.file ?? "（全树搜索）"}`,
          )),
    );
  } else {
    const contractFailures = read.report.contracts.failures;
    factLines.push(
      ...(contractFailures.length === 0
        ? ["- 契约比对无失败项（fail 来自验收红或 commit 可达性，见失败明细）"]
        : [
            "- 契约比对失败清单（机器判定原文，含 id + signature + 期望文件）：",
            ...contractFailures.map((f) => `  - ${f}`),
          ]),
    );
    const failedAcceptances = read.report.acceptanceBatches.flatMap((batch) =>
      batch.results
        .filter((r) => r.status === "fail")
        .map((r) => `${r.id}（unit ${batch.unitId}）`),
    );
    factLines.push(
      failedAcceptances.length === 0
        ? "- 失败验收：无（验收批次全绿，fail 全部来自契约比对）"
        : `- 失败验收：${failedAcceptances.join("、")}`,
    );
    factLines.push(`- 完整报告：${read.reportPath}`);
  }

  return [
    "## 你的任务（designer：集成契约漂移处置）",
    "",
    `unit "${unit.unitId}" 的集成已连续 fail ${INTEGRATION_MAX_CONSECUTIVE_FAILS} 次（重派上限），`,
    "runner 已停止自动重派集成——契约漂移的归属需要语义判断，由你按下述指引处置。",
    "",
    "### 集成失败事实（最近一次集成报告）",
    ...factLines,
    "",
    "### 处置指引（二选一）",
    integrationRecoveryGuidance(unit.unitId),
  ].join("\n");
}

function renderBrief(
  projection: SequencedProjection,
  unit: SequencedUnitProjection,
  role: AgentRole,
  cwd: string,
): string {
  let briefContent: string;
  try {
    briefContent = readFileSync(unit.briefRef, "utf-8");
  } catch {
    briefContent = `(原始任务书文件不可读：${unit.briefRef})`;
  }
  // 四类 designer 任务书按派发分支的入口状态区分（口径与 computeDispatchTargets
  // 同一投影）：spec-frozen + split 子未建 = fx-3 R5.3 兜底出口（补建子）；其余
  // spec-frozen = fx-2 R4a 集成上限出口（契约漂移处置）；created 且 specs>0 =
  // fx-1 R2 第四分支（补审）；created 且 specs===0 = 首派（撰写 spec，root 无子
  // 时含 fx-3 R5.2 第 0 步建子指令）
  const roleTasks =
    role === "designer" && unitStatus(unit) === "spec-frozen"
      ? splitChildrenNotCreated(projection, unit).length > 0
        ? missingChildrenTasks(unit, splitChildrenNotCreated(projection, unit))
        : integrationDriftTasks(unit, cwd)
      : role === "designer" && unit.specs.length > 0
        ? reReviewTasks(unit.unitId)
        : role === "designer"
          ? designerFirstTasks(unit, projection)
          : ROLE_TASKS[role](unit.unitId);
  return [
    `# ${role} 任务书：unit "${unit.unitId}"`,
    "",
    "## Unit 上下文",
    `- unitId: ${unit.unitId}`,
    `- parentId: ${unit.parentId ?? "（根节点）"}`,
    `- 当前状态: ${unitStatus(unit)}`,
    `- 原始任务书: ${unit.briefRef}`,
    "",
    "### 原始任务书内容",
    briefContent,
    "",
    roleTasks,
    "",
    "## 环境约定",
    `- workdir: ${cwd}（M1 简化 = 仓库本身，无独立 worktree）`,
    "- 账本命令：在 workdir 下执行 cw …（状态推进全部经账本命令入账）",
    "",
  ].join("\n");
}

/** brief 落盘到 <workdir>/.cw-spawn/<unitId>.<role>.brief.md（验收文档循环逻辑 2） */
function writeBriefFile(
  cwd: string,
  target: DispatchTarget,
  unit: SequencedUnitProjection,
  projection: SequencedProjection,
): string {
  const path = join(cwd, ".cw-spawn", `${target.unitId}.${target.role}.brief.md`);
  mkdirSync(join(cwd, ".cw-spawn"), { recursive: true });
  writeFileSync(path, renderBrief(projection, unit, target.role, cwd));
  return path;
}

// ---- 终止与汇总 ----

/**
 * 兜底回收（root closed / 空转超时 / SPAWN_ERROR 三个出口共用）：best-effort——
 * 逐个 kill、单个失败记录后继续。kill 目标常为「已自然退出但 race 未结算」的
 * flight，macOS 对已退出进程组的 kill(-pgid) 返回 EPERM（而非 ESRCH），而
 * lifecycle.killTree 只豁免 ESRCH——清理失败炸掉正常退出流程比残留一个已死
 * 进程的 kill 企图更糟（进程已死则无需清理；真残留由其自身 timeout 兜底）。
 * 与 killTree 的「确保死」是两层语义：那边是 u6a 的进程级强杀，这里只需尽力回收。
 */
function killAll(inFlight: readonly InFlightSpawn[]): void {
  for (const flight of inFlight) {
    try {
      flight.handle.kill();
    } catch (err) {
      process.stderr.write(
        `[runner] 兜底 kill 失败（${flight.role} unit "${flight.unitId}"）：` +
          `${err instanceof Error ? err.message : String(err)}——目标进程多半已退出，忽略。\n`,
      );
    }
  }
}

/** root closed 的汇总（验收文档循环逻辑 5：每 unit 状态行） */
function emitSummary(projection: SequencedProjection, rootId: string): void {
  const units = subtreeUnits(projection, rootId);
  const rows = units.map((unit) => {
    const lastVerify =
      unit.verifyRuns.length > 0 ? unit.verifyRuns[unit.verifyRuns.length - 1].result : "-";
    return `[runner]   ${unit.unitId}  ${unitStatus(unit)}  lastVerify:${lastVerify}`;
  });
  emit([
    `[runner] root "${rootId}" 已 closed——调度循环结束（exit 0）。汇总（root 子树 ${units.length} 个 unit）：`,
    ...rows,
    `[runner] 证据链详情：cw report（全量）或 cw report --unit ${rootId}`,
  ]);
}

function idleFailureMessage(rootId: string, maxIdleMs: number, totalEvents: number): string {
  return (
    `cw run: root "${rootId}" 超过 ${maxIdleMs}ms 无账本进展（totalEvents 停在 ${totalEvents}，` +
    "被派发 agent 未产出任何事件）。恢复动作：查看 <workdir>/.cw-spawn/ 下各 agent 的 " +
    `stdout / stderr 定位卡点，或 cw status 查看现状；排除故障后重新运行 cw run --root ${rootId} 继续（账本即状态，重跑即续）。`
  );
}

function spawnErrorMessage(rootId: string, unitId: string, role: AgentRole): string {
  return (
    `cw run: unit "${unitId}" 的 ${role} 派发返回 SPAWN_ERROR（agent 起不来——配置错误，重试无意义）。` +
    "恢复动作：核对适配器配置（可执行是否存在 / 模型可用），修正后重新运行 " +
    `cw run --root ${rootId} 继续（已完成的事件不丢失）。`
  );
}

function describeExit(exitCode: SpawnResult["exitCode"]): string {
  if (exitCode === 0) {
    return "exit 0";
  }
  if (exitCode === "SPAWN_ERROR") {
    return "SPAWN_ERROR";
  }
  const retryable = exitCode === "TIMEOUT" || exitCode === "CRASH" ? "，可重派" : "";
  return `${String(exitCode)}${retryable}`;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `runLoop: 非法参数 ${name}=${value}：须为正数。恢复动作：检查 cw run 的对应 flag（--poll-ms / --max-idle-ms / --max-concurrency）取值。`,
    );
  }
}

/**
 * 通用调度循环：root closed → 汇总返回 0；无进展超 maxIdleMs → stderr + 返回 1；
 * SPAWN_ERROR（配置错误）→ kill 全部 in-flight + stderr + 返回 1。
 * root 不在账本 → 抛可操作错误（调用方负责转 exit 1）。
 */
export async function runLoop(opts: RunLoopOptions): Promise<number> {
  const pollMs = opts.pollMs ?? DEFAULT_LOOP_POLL_MS;
  const maxIdleMs = opts.maxIdleMs ?? DEFAULT_LOOP_MAX_IDLE_MS;
  const maxConcurrency = opts.maxConcurrency ?? DEFAULT_LOOP_MAX_CONCURRENCY;
  assertPositive("pollMs", pollMs);
  assertPositive("maxIdleMs", maxIdleMs);
  assertPositive("maxConcurrency", maxConcurrency);

  const initial = loadLedger(opts.cwd);
  if (!initial.projection.units.has(opts.rootId)) {
    throw new Error(
      `runLoop: root "${opts.rootId}" 不存在（账本内无其 UnitCreated 事件）。` +
        `恢复动作：运行 cw status 查看全部 unit 确认 id，或 cw create --id ${opts.rootId} --brief <路径> 创建。`,
    );
  }

  emit([
    `[runner] 循环启动：root=${opts.rootId} adapter=${opts.adapter.name} ` +
      `poll=${pollMs}ms max-idle=${maxIdleMs}ms max-concurrency=${maxConcurrency}`,
  ]);

  const inFlight: InFlightSpawn[] = [];
  let lastTotalEvents = initial.projection.totalEvents;
  let lastProgressAt = Date.now();

  while (true) {
    // 每轮重读投影（子进程 agent 与本循环并发写账本，投影必须重新装载）。保留
    // 原始事件流：fx-2 R4a 的连续集成 fail 计数需要 SpecSubmitted 与 VerifyRan
    // 的跨类型账本顺序（fold 投影是平行数组，相对顺序已丢失），从事件重放
    const events = new EventLedger(ledgerPath(getCwHome(), opts.cwd)).readAll();
    const projection = fold(events);
    const root = projection.units.get(opts.rootId);
    if (root === undefined) {
      // append-only 账本里 UnitCreated 不会消失；走到这里说明账本被外部改动
      emitErr(
        `cw run: root "${opts.rootId}" 在循环中途从账本消失（账本被外部改动？）。` +
          "恢复动作：cw status 查看现存 unit 后重新运行 cw run --root <id>。",
      );
      killAll(inFlight);
      return 1;
    }
    if (unitStatus(root) === "closed") {
      // u8：内部节点派发时机升级为「子全 verified」后，root 的 exec-review 可能
      // 先于子的 exec-review 入账（u7 时代 root builder 等子全 closed，不可能）。
      // 验收文档的 closed 公式 = root verified ∧ root exec-review ∧ 子全 closed，
      // 而 deriveStatus（禁改的既有语义）不含最后一项——退出条件在这里补齐，
      // 否则 root 先 closed 会在退出时 kill 未收尾的子 reviewer，子永远停在
      // verified。u7 各场景两者天然同时成立（rootLast 排序），行为不变。
      const subtreeAllClosed = subtreeUnits(projection, opts.rootId).every(
        (unit) => unitStatus(unit) === "closed",
      );
      if (subtreeAllClosed) {
        // 正常路径 in-flight 已空；外部（如人工）直接推 closed 时的兜底回收
        killAll(inFlight);
        emitSummary(projection, opts.rootId);
        return 0;
      }
      // root closed 但子未收尾：子的 reviewer 仍可派发，等子树收齐再退（无进展
      // 由 maxIdleMs 兜底，不会死等）
    }

    // 派发（六步之 1-3）：frontier 重算 → 内部节点直跑集成（确定性代码，不派
    // agent、不占并发额度）→ brief 落盘 → spawn，同批 ≤ maxConcurrency
    for (const target of computeDispatchTargets(
      projection,
      opts.rootId,
      inFlight,
      consecutiveIntegrationFails(events),
    )) {
      if (target.integration) {
        // 集成在本轮同步完成（含 VerifyRan 入账）；后续 target 仍按本轮开头投影
        // 派发，集成引起的状态跃迁由下一轮重算接手
        await runIntegrationDispatch(opts.cwd, projection, target.unitId);
        continue;
      }
      if (inFlight.length >= maxConcurrency) {
        break;
      }
      const unit = projection.units.get(target.unitId);
      if (unit === undefined) {
        continue; // 不可达（target 来自同一投影）
      }
      if (target.role === "designer" && unitStatus(unit) === "spec-frozen") {
        // designer × spec-frozen 两个出口的可观测性（终验日志里明确「为何派 designer」）：
        // fx-3 R5.3 兜底（split 子未建）优先于 fx-2 R4a 上限（集成连续 fail）判定
        const missingChildren = splitChildrenNotCreated(projection, unit);
        if (missingChildren.length > 0) {
          emit([
            `[runner] unit "${target.unitId}" 的 spec 声明了 ${splitOf(unit).length} 个子 unit 但 ${missingChildren.length} 个未创建` +
              `（${missingChildren.join("、")}）——派 designer 补建子（子不齐不集成）`,
          ]);
        } else {
          emit([
            `[runner] unit "${target.unitId}" 集成连续 fail 达上限（${INTEGRATION_MAX_CONSECUTIVE_FAILS} 次）` +
              "——停止自动重派集成，转派 designer 处置契约漂移（处置路径见 brief）",
          ]);
        }
      }
      const briefPath = writeBriefFile(opts.cwd, target, unit, projection);
      const handle = await opts.adapter.spawn({
        role: target.role,
        unitId: target.unitId,
        workdir: opts.cwd,
        briefPath,
        timeoutMs: AGENT_SPAWN_TIMEOUT_MS,
      });
      inFlight.push({ role: target.role, unitId: target.unitId, handle });
      emit([
        `[runner] ${new Date().toISOString()} 派发 ${target.role} → unit "${target.unitId}"（brief: ${briefPath}）`,
      ]);
    }

    // 等待（六步之 4）：任一 spawn 退出或 poll 到点，先到者唤醒重算
    const finished = await Promise.race<FinishedWatch | null>([
      ...inFlight.map(async (flight) => ({ flight, result: await flight.handle.wait() })),
      sleep(pollMs).then(() => null),
    ]);

    if (finished !== null) {
      inFlight.splice(inFlight.indexOf(finished.flight), 1);
      emit([
        `[runner] ${new Date().toISOString()} ${finished.flight.role} unit "${finished.flight.unitId}" 退出 ${describeExit(finished.result.exitCode)}`,
      ]);
      if (finished.result.exitCode === "SPAWN_ERROR") {
        emitErr(spawnErrorMessage(opts.rootId, finished.flight.unitId, finished.flight.role));
        killAll(inFlight);
        return 1;
      }
    }

    // 进展检查（六步之 5 的空转出口）：任一账本事件推进即视为有进展
    const totalEvents = loadLedger(opts.cwd).projection.totalEvents;
    if (totalEvents !== lastTotalEvents) {
      lastTotalEvents = totalEvents;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= maxIdleMs) {
      emitErr(idleFailureMessage(opts.rootId, maxIdleMs, totalEvents));
      killAll(inFlight);
      return 1;
    }
  }
}

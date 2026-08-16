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
 * 派发对象规则（每轮对投影重算，子树 BFS 序；就绪判定输入 = readonly/frontier.ts
 * 的 computeFrontier——与 `cw frontier` 命令同一出处，维度 → 派发形态的映射见
 * DISPATCH_SHAPE）：
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
 * 失败语义只看四态退出（types.ts）：exit≠0 / CRASH 可重派（下轮重算自然再次
 * 进入派发集合）；TIMEOUT 可重派但有封顶——同一 unit 连续 2 次 TIMEOUT（期间
 * 无任何该 unit 的账本进展）即转人工：不再派发，其余 unit 继续，stderr 打印
 * 转人工指引（canon 语义：不自动换模型重试，防静默降级）；SPAWN_ERROR 配置错误
 * 不重试，kill 全部 in-flight 后 exit 1。无可派发且无 in-flight 且存在转人工
 * unit → 循环以 exit 1 收束并汇总转人工清单。
 * 重派前工作区清理（共享 cwd 时代的近似，W3 将整体删除）：无 in-flight 时对项目
 * cwd 的 tracked 脏改动 git reset --hard（详见 checkWorkspaceForDispatch 注释），
 * untracked 一律不动；unit worktree 的精确清理（reset --hard + clean -fd
 * -e .cw-spawn）已由派发点的 ensureUnitWorktree 承担。
 *
 * worktree 语义（wt-2 起，docs/rewrite/design-worktree-isolation.md D1/D2/D3）：每个
 * 被派发 unit 在 <CW_WORKTREE_HOME>/<encoded-cwd>/<unitId> 的专属 git worktree
 * （分支双空间命名——root unit = cw-root/<rootId>、子 unit = cw/<rootId>/<unitId>，
 * base = run 启动时项目 HEAD 快照）里干活；账本与仓库操作锚定项目 cwd（D3 双路径）。循环不亲自创建 split 子 unit（fx-3 后子创建职责归
 * designer：首派任务书第 0 步指令化建子，spec gate 强制先建子后提 spec；循环仅
 * 在子未建时派 designer 兜底）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
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
import {
  computeFrontier,
  consecutiveIntegrationFails,
  type FrontierGroups,
  INTEGRATION_MAX_CONSECUTIVE_FAILS,
  splitChildrenNotCreated,
  splitOf,
  splitSelfReferences,
} from "../readonly/frontier.js";
import { loadLedger, treeStatuses, unitStatus } from "../readonly/load.js";
import { EventLedger } from "../store/events-log.js";
import {
  encodeCwd,
  getCwHome,
  getCwWorktreeHome,
  ledgerPath,
  worktreePath,
} from "../store/project.js";
import { integrationRecoveryGuidance, readIntegrateReport, runIntegrationVerify } from "./integrate.js";
import type {
  AgentRole,
  AgentSpawnAdapter,
  SpawnHandle,
  SpawnResult,
} from "./spawn/types.js";
import { ensureUnitWorktree, unitBranchName } from "./worktree.js";

/** 账本轮询间隔默认值（--poll-ms；验收文档：默认 1000） */
export const DEFAULT_LOOP_POLL_MS = 1_000;
/** 无账本进展上限默认值（--max-idle-ms；验收文档：默认 30min） */
export const DEFAULT_LOOP_MAX_IDLE_MS = 1_800_000;
/** 同批 in-flight spawn 上限默认值（--max-concurrency；验收文档：默认 3） */
export const DEFAULT_LOOP_MAX_CONCURRENCY = 3;
/** 单次 agent spawn 超时（验收文档循环逻辑 3：timeoutMs 固定 30min） */
const AGENT_SPAWN_TIMEOUT_MS = 1_800_000;
/**
 * 同一 unit 连续 spawn TIMEOUT 的转人工阈值（连续 2 次）：期间无任何该 unit 的
 * 账本进展即累计；该 unit 一旦出现新账本事件（agent 被超时 kill 前已有产出）
 * 计数清零。计数是单进程内存态——TIMEOUT 是 spawn 失败不入账本，跨进程累计
 * 物理不可得（Ctrl-C 重跑后从 0 重新计，属可接受损失：封顶防的是单次运行内
 * 的无限重派烧 token）。转人工 = 不再派发（canon：不自动换模型，防静默降级）。
 */
const AGENT_TIMEOUT_ESCALATION_AFTER = 2;

/** 单步 git 操作超时（与 integrate.ts 同口径：本地操作毫秒级，上限防挂死） */
const GIT_STEP_TIMEOUT_MS = 120_000;
/** ms → min 换算（转人工指引文案用） */
const MS_PER_MINUTE = 60_000;
/** git status --porcelain 状态码宽度（XY 两列 + 空格 + 路径） */
const PORCELAIN_STATUS_WIDTH = 2;
/**
 * emitExitOutput 的回调等待上限：正常路径回调毫秒级到达；高负载下（集成验证
 * 的连续 spawnSync 阻塞 + 全量并行）libuv 线程池的写队列积压可达数秒。超时后
 * 走 writeSync 兜底而非无限等待（进程内直调测试场景 collector 透传回调，
 * 同步到达，不吃此上限）。
 */
const FLUSH_BARRIER_TIMEOUT_MS = 5_000;

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
 * 退出路径关键输出的落盘屏障：node 对文件/管道 fd 的 stdout/stderr 写入是异步
 * 提交（libuv 线程池队列），cli.ts 的显式 process.exit 不等 flush——高负载下
 * 队列积压可达数秒且无上界，exit 时排队中的写全部丢弃（实测全量测试负载下
 * root closed 的汇总与其前的尾部输出整段丢失而 exit code 正常）。
 * 两级防线：① 常规 write + 等回调（流按调用序串行 flush，回调到达 = 含此前
 * 队列已全部落盘；测试 collector 经 write 捕获，亦走此路径）；② 回调超时
 * （timer unref 不挂进程）则 writeSync 直写同一内容——数据完整优先于极端
 * 场景下队列随后 flush 造成的重复。
 */
/** 退出路径输出的目标流（两者的实际类型都自带 fd 字面量，供 writeSync 兜底） */
type ExitStream = typeof process.stdout | typeof process.stderr;

async function emitExitOutput(text: string, stream: ExitStream): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        writeSync(stream.fd, text);
      } catch (err) {
        // 兜底失败不抛（数据已尽力），但必须出声——此刻常规 write 队列已不可信，
        // 只剩 stderr 裸 write 一次尝试让错误事实可见
        emitErr(`[runner] 退出输出 writeSync 兜底失败（fd=${stream.fd}）：${String(err)}\n`);
      }
      resolve();
    }, FLUSH_BARRIER_TIMEOUT_MS);
    timer.unref();
    stream.write(text, () => {
      finish();
    });
  });
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

/** frontier 维度 → 派发形态（role 与集成直跑标记）。维度语义单一出处 = readonly/frontier.ts */
const DISPATCH_SHAPE: Record<keyof FrontierGroups, { role: AgentRole; integration: boolean }> = {
  specReady: { role: "designer", integration: false },
  reReview: { role: "designer", integration: false },
  missingChildren: { role: "designer", integration: false },
  integrationDrift: { role: "designer", integration: false },
  integrationReady: { role: "builder", integration: true },
  buildReady: { role: "builder", integration: false },
  execReviewReady: { role: "reviewer", integration: false },
};

/**
 * 派发对象集合：消费 readonly/frontier.ts 的 computeFrontier（与 `cw frontier`
 * 命令同一就绪判定，A4「零上下文接手」场景输出与真实派发一致），限定 root
 * 子树、按 BFS 序展开为 (role, unitId, integration)。in-flight 的同
 * (unitId, role) 不重复派；excluded = 转人工 unit（连续 TIMEOUT 封顶后不再
 * 派发）。spec-frozen 自引用的 stderr 警告保持每轮可见——判定半边在共享函数
 * （按叶子语义入组），此处只保留可观测性半边（fx-1 R1 loop 级防御）。
 */
function computeDispatchTargets(
  projection: SequencedProjection,
  rootId: string,
  inFlight: readonly InFlightSpawn[],
  consecutiveFails: ReadonlyMap<string, number>,
  excluded: ReadonlySet<string>,
): DispatchTarget[] {
  const groups = computeFrontier(projection, {
    consecutiveIntegrationFails: consecutiveFails,
  });
  const dimensionOf = new Map<string, keyof FrontierGroups>();
  for (const key of Object.keys(groups) as Array<keyof FrontierGroups>) {
    for (const unitId of groups[key]) {
      dimensionOf.set(unitId, key);
    }
  }
  const subtree = subtreeUnits(projection, rootId);
  const targets: DispatchTarget[] = [];
  for (const unit of subtree) {
    if (unitStatus(unit) === "spec-frozen" && splitSelfReferences(unit)) {
      emitErr(
        `[runner] 警告：unit "${unit.unitId}" 的 spec.split 含自身（自引用——gate 规则⑥应拒，` +
          "账本可能建于该规则生效前或被旁路写入）——不作为内部节点等待子树，按叶子语义派发。\n",
      );
    }
    if (excluded.has(unit.unitId)) {
      continue;
    }
    const dimension = dimensionOf.get(unit.unitId);
    if (dimension === undefined) {
      continue;
    }
    const shape = DISPATCH_SHAPE[dimension];
    const alreadyInFlight = inFlight.some(
      (flight) => flight.unitId === unit.unitId && flight.role === shape.role,
    );
    if (alreadyInFlight) {
      continue;
    }
    targets.push({ role: shape.role, unitId: unit.unitId, integration: shape.integration });
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
    // timeoutMs 省略：透传 runAcceptances 的逐条按验收 type 分档语义（单测 10min /
    // e2e 30min）——集成批次混装各 type 验收，单一统一档会误杀快档或放跑慢档
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
  rootId: string,
  projectCwd: string,
  workdir: string,
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
        : integrationDriftTasks(unit, projectCwd)
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
    `- workdir: ${workdir}（unit 专属 git worktree，分支 ${unitBranchName(rootId, unit.unitId)}）`,
    `- 账本命令：直接在 workdir 下执行 cw …（CW_PROJECT_DIR 已注入 env，自动锚定项目账本 ${projectCwd}）`,
    "",
  ].join("\n");
}

/** brief 落盘到 <worktreeDir>/.cw-spawn/<unitId>.<role>.brief.md（wt-2 起产物根随 workdir 迁 worktree） */
function writeBriefFile(
  worktreeDir: string,
  target: DispatchTarget,
  unit: SequencedUnitProjection,
  projection: SequencedProjection,
  rootId: string,
  projectCwd: string,
): string {
  const path = join(worktreeDir, ".cw-spawn", `${target.unitId}.${target.role}.brief.md`);
  mkdirSync(join(worktreeDir, ".cw-spawn"), { recursive: true });
  writeFileSync(
    path,
    renderBrief(projection, unit, target.role, rootId, projectCwd, worktreeDir),
  );
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

/** root closed 的汇总文本（验收文档循环逻辑 5：每 unit 状态行，树感知口径） */
function summaryText(projection: SequencedProjection, rootId: string): string {
  const units = subtreeUnits(projection, rootId);
  const statuses = treeStatuses(projection);
  const rows = units.map((unit) => {
    const lastVerify =
      unit.verifyRuns.length > 0 ? unit.verifyRuns[unit.verifyRuns.length - 1].result : "-";
    return `[runner]   ${unit.unitId}  ${statuses.get(unit.unitId)}  lastVerify:${lastVerify}`;
  });
  return [
    `[runner] root "${rootId}" 已 closed——调度循环结束（exit 0）。汇总（root 子树 ${units.length} 个 unit）：`,
    ...rows,
    `[runner] 证据链详情：cw report（全量）或 cw report --unit ${rootId}`,
    "",
  ].join("\n");
}

function idleFailureMessage(rootId: string, maxIdleMs: number, totalEvents: number, cwd: string): string {
  // agent 产物随 wt-2 迁到各 unit 的 worktree（<CW_WORKTREE_HOME>/<encoded-cwd>/<unitId>/.cw-spawn/）
  const spawnProbeDir = join(getCwWorktreeHome(), encodeCwd(cwd), "<unitId>", ".cw-spawn");
  return (
    `cw run: root "${rootId}" 超过 ${maxIdleMs}ms 无账本进展（totalEvents 停在 ${totalEvents}，` +
    "被派发 agent 未产出任何事件）。恢复动作：查看各 unit 的 worktree（" +
    `${spawnProbeDir}）下 agent 的 stdout / stderr 定位卡点，或 cw status 查看现状；` +
    `排除故障后重新运行 cw run --root ${rootId} 继续（账本即状态，重跑即续）。`
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
  const capped =
    exitCode === "TIMEOUT"
      ? `，可重派（连续 ${AGENT_TIMEOUT_ESCALATION_AFTER} 次后转人工）`
      : exitCode === "CRASH"
        ? "，可重派"
        : "";
  return `${String(exitCode)}${capped}`;
}

/**
 * 各 unit 的最新事件 seq 高水位（连续 TIMEOUT 计数的进展清零输入）：五类事件
 * payload 均含 unitId，任何类型的新事件（SpecSubmitted / EvidenceSubmitted /
 * VerdictSubmitted / VerifyRan / UnitCreated）都视为该 unit 有进展。
 */
function unitEventHighWaterSeqs(events: readonly LedgerEvent[]): Map<string, number> {
  const seqs = new Map<string, number>();
  for (const record of events) {
    const event = record as DiscriminatedEvent;
    if (event.seq > (seqs.get(event.payload.unitId) ?? 0)) {
      seqs.set(event.payload.unitId, event.seq);
    }
  }
  return seqs;
}

/** 同一 unit 连续 TIMEOUT 的计数条目（role = 最近一次 TIMEOUT 的派发 role） */
interface TimeoutStreak {
  count: number;
  role: AgentRole;
}

/**
 * 转人工指引（连续 TIMEOUT 封顶时逐 unit 打印；错误指向恢复动作，规则 16）。
 * spawn 超时是 src/runner/loop.ts 的固定常量（30min），cw run 无调大 flag——
 * 如实告知现状而非指向不存在的入口。
 */
function escalationMessage(rootId: string, unitId: string, role: AgentRole, cwd: string): string {
  // 产物根随 wt-2 迁 unit worktree（D3）：stdout/stderr 在 worktree 的 .cw-spawn/ 下
  const stdoutPath = join(
    worktreePath(getCwWorktreeHome(), cwd, unitId),
    ".cw-spawn",
    `${unitId}.${role}.stdout`,
  );
  return (
    `cw run: unit "${unitId}" 的 ${role} 连续 ${AGENT_TIMEOUT_ESCALATION_AFTER} 次 spawn TIMEOUT` +
    "（期间无该 unit 的任何账本进展）——停止自动重派，转人工处理（canon：不自动换模型重试，" +
    "防静默降级；本循环继续处理其余 unit）。恢复动作（按序）：\n" +
    `  1. 人工接手该 unit：重新运行 cw run --root ${rootId} --spawn human（按打印的指令手工推进；账本即状态，已完成进度不丢）\n` +
    `  2. 定位卡点：查看 ${stdoutPath} 与同级 .stderr（历次运行的完整输出）\n` +
    `  3. 若任务量确超单次 spawn 上限（${AGENT_SPAWN_TIMEOUT_MS / MS_PER_MINUTE}min 固定值，cw run 暂无调大入口）：` +
    "人工接手完成该 unit，或拆小任务另建 unit"
  );
}

/** 转人工收束的退出汇总（无可自动推进的 unit 且存在转人工 unit → exit 1） */
function escalationExitMessage(rootId: string, escalated: ReadonlyMap<string, AgentRole>): string {
  return (
    `cw run: root "${rootId}" 已无可自动推进的 unit（无 in-flight、无待派发），转人工 unit 共 ` +
    `${escalated.size} 个：\n` +
    [...escalated]
      .map(([unitId, role]) => `  - ${unitId}（最后派发 role：${role}）`)
      .join("\n") +
    `\n恢复动作：按各 unit 的转人工指引处理（cw run --root ${rootId} --spawn human 人工接手），` +
    "完成后重新运行 cw run --root ${rootId} 继续（账本即状态，重跑即续）。"
  );
}

// ---- 重派前工作区清理（共享 cwd 下的安全近似） ----

/**
 * git status --porcelain 的 tracked 脏行（worktree 列非 `?` 非空——untracked 的 ?? 排除）。
 * --no-optional-locks：默认 git status 会乘机刷新 index（创建 .git/index.lock），
 * 与并发的人/agent git 操作（commit 等）撞锁直接失败——实测全量负载下与测试
 * 「人」的 git commit 偶发互斥失败。此 flag 让 status 完全不拿锁（git 为并发
 * 读场景设计的开关）。
 */
function trackedDirtyLines(cwd: string): string[] | null {
  const status = spawnSync(
    "git",
    ["--no-optional-locks", "-C", cwd, "status", "--porcelain"],
    {
      encoding: "utf-8",
      timeout: GIT_STEP_TIMEOUT_MS,
    },
  );
  if (status.error !== undefined || status.status !== 0) {
    emitErr(
      `[runner] 工作区清理检查失败（git status，${cwd}）：` +
        `${status.error?.message ?? (status.stderr ?? "").trim()}。恢复动作：确认 cwd 是可用 git 仓库后重跑；本次派发继续（跳过清理）。`,
    );
    return null;
  }
  return (status.stdout ?? "")
    .split("\n")
    .filter(
      (line) =>
        line.length >= PORCELAIN_STATUS_WIDTH &&
        line[1] !== "?" &&
        line[1] !== " ",
    );
}

/**
 * 派发新 agent 前的工作区卫生检查：失败 builder 的未提交 tracked 半成品若不清，
 * 会原样进入下一轮任意 unit 的派发（共享 cwd 无隔离）。完整语义（按 unit 隔离
 * 产出）依赖独立 worktree，M2 集成时升级——本近似只处理最痛的「脏 tracked 污染
 * 下一个 agent」：无 in-flight 时 git reset --hard HEAD（untracked 一律不动，
 * 防误删用户/认知外文件）；有 in-flight 时仅提示不清理（避免误伤并行 agent 的
 * 进行中工作）。每轮派发循环只检查一次（调用方用标志去重）。
 */
function checkWorkspaceForDispatch(cwd: string, hasInFlight: boolean): void {
  const dirty = trackedDirtyLines(cwd);
  if (dirty === null || dirty.length === 0) {
    return;
  }
  if (hasInFlight) {
    emit([
      `[runner] 提示：工作区有 ${dirty.length} 项 tracked 脏改动，但有 agent 在跑——暂不清理` +
        "（避免误伤进行中的工作），待无 in-flight 的派发轮再 reset。",
    ]);
    return;
  }
  const reset = spawnSync("git", ["-C", cwd, "reset", "--hard", "HEAD"], {
    encoding: "utf-8",
    timeout: GIT_STEP_TIMEOUT_MS,
  });
  if (reset.status !== 0) {
    emitErr(
      `[runner] 工作区清理失败（git reset --hard HEAD，${cwd}）：${(reset.stderr ?? "").trim()}。` +
        "恢复动作：人工执行 git status / git reset 处理上述 tracked 修改后重跑 cw run" +
        "（untracked 文件与 .cw-spawn/ 产物不受 reset 影响）。",
    );
    return;
  }
  emit([
    `[runner] 派发前清理：检测到 ${dirty.length} 项 tracked 脏改动（上一 agent 的未提交半成品），已 git reset --hard HEAD（untracked 不动）。明细：`,
    ...dirty.map((line) => `  ${line}`),
  ]);
}


/**
 * R1（D2）：run 启动时项目 HEAD 一次性快照——本轮全部 unit 的 worktree 同 base
 * （兄弟并行、集成兜底一致性；run 期间项目 cwd 无人 commit，快照恒定）。
 * 非 git 仓库 / 无 HEAD → throw 可操作错误：git 是证据链硬依赖，fail-fast 优于
 * 空转到 idle 超时。
 */
function snapshotHeadCommit(cwd: string): string {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
    encoding: "utf-8",
    timeout: GIT_STEP_TIMEOUT_MS,
  });
  const head = (res.stdout ?? "").trim();
  if (res.error !== undefined || res.status !== 0 || head === "") {
    throw new Error(
      `runLoop: 无法读取项目 HEAD（git -C ${cwd} rev-parse HEAD 失败：` +
        `${res.error?.message ?? ((res.stderr ?? "").trim() || `exit ${String(res.status)}`)}）。` +
        "恢复动作：cw 依赖 git 仓库（evidence/verify 均需），在项目仓库内运行 cw run，" +
        "或先 git init + commit。",
    );
  }
  return head;
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
 * SPAWN_ERROR（配置错误）→ kill 全部 in-flight + stderr + 返回 1；连续 TIMEOUT
 * 封顶的 unit 转人工（不再派发），无可自动推进且存在转人工 unit → stderr 汇总 +
 * 返回 1。
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

  // R1：base 快照在 root 存在性检查之后、首个派发之前一次性取得（全部 unit 同 base）
  const baseCommit = snapshotHeadCommit(opts.cwd);

  emit([
    `[runner] 循环启动：root=${opts.rootId} adapter=${opts.adapter.name} ` +
      `poll=${pollMs}ms max-idle=${maxIdleMs}ms max-concurrency=${maxConcurrency}`,
  ]);

  const inFlight: InFlightSpawn[] = [];
  let lastTotalEvents = initial.projection.totalEvents;
  let lastProgressAt = Date.now();
  // 连续 TIMEOUT 计数（单进程内存态；语义见 AGENT_TIMEOUT_ESCALATION_AFTER 注释）。
  // escalated 单向：一经转人工，本次运行内不再自动派发（人工接手期间 loop 插足
  // 会与人工操作冲突；进展清零只作用于计数，不撤销转人工）
  const timeoutStreaks = new Map<string, TimeoutStreak>();
  const escalated = new Map<string, AgentRole>();
  let lastUnitSeqs = new Map<string, number>();

  while (true) {
    // 每轮重读投影（子进程 agent 与本循环并发写账本，投影必须重新装载）。保留
    // 原始事件流：fx-2 R4a 的连续集成 fail 计数需要 SpecSubmitted 与 VerifyRan
    // 的跨类型账本顺序（fold 投影是平行数组，相对顺序已丢失），从事件重放
    const events = new EventLedger(ledgerPath(getCwHome(), opts.cwd)).readAll();
    const projection = fold(events);
    const root = projection.units.get(opts.rootId);
    if (root === undefined) {
      // append-only 账本里 UnitCreated 不会消失；走到这里说明账本被外部改动
      killAll(inFlight);
      await emitExitOutput(
        `cw run: root "${opts.rootId}" 在循环中途从账本消失（账本被外部改动？）。` +
          "恢复动作：cw status 查看现存 unit 后重新运行 cw run --root <id>。\n",
        process.stderr,
      );
      return 1;
    }
    if (treeStatuses(projection).get(opts.rootId) === "closed") {
      // 退出条件 = 树感知 closed（canon D2 完整公式：root verified ∧ exec-review
      // pass ∧ 全部直接子节点 closed），与 readonly 四命令同一投影口径。u8 时代
      // 「子全 closed」是本循环的补偿逻辑（当时 deriveStatus 够不到子节点），已
      // 归位 fold 层——root 的 exec-review 先于子收尾入账时循环不退，子的
      // reviewer 继续派发，无进展由 maxIdleMs 兜底
      // 正常路径 in-flight 已空；外部（如人工）直接推 closed 时的兜底回收
      killAll(inFlight);
      await emitExitOutput(summaryText(projection, opts.rootId), process.stdout);
      return 0;
    }

    // 连续 TIMEOUT 计数的进展清零 + 转人工判定（在派发计算之前：被超时 kill 的
    // agent 若死前已写账本，本轮先清零——不冤枉有产出的 agent；清零后仍达阈值的
    // 才转人工，本轮流派发即排除）。顺序不能反：先判定后清零会把「有产出的
    // 第二次 TIMEOUT」也误转人工
    const unitSeqs = unitEventHighWaterSeqs(events);
    for (const [unitId, seq] of unitSeqs) {
      if (seq > (lastUnitSeqs.get(unitId) ?? 0)) {
        timeoutStreaks.delete(unitId);
      }
    }
    lastUnitSeqs = unitSeqs;
    for (const [unitId, streak] of timeoutStreaks) {
      if (streak.count >= AGENT_TIMEOUT_ESCALATION_AFTER && !escalated.has(unitId)) {
        escalated.set(unitId, streak.role);
        emitErr(escalationMessage(opts.rootId, unitId, streak.role, opts.cwd));
      }
    }

    // 派发（六步之 1-3）：frontier 重算 → 内部节点直跑集成（确定性代码，不派
    // agent、不占并发额度）→ brief 落盘 → spawn，同批 ≤ maxConcurrency
    const targets = computeDispatchTargets(
      projection,
      opts.rootId,
      inFlight,
      consecutiveIntegrationFails(events),
      new Set(escalated.keys()),
    );
    if (targets.length === 0 && inFlight.length === 0 && escalated.size > 0) {
      // 转人工收束：root 子树已无 machine 推进路径（转人工 unit 可能阻塞其祖先
      // 的集成等待，祖先同样无解），继续循环只剩空转烧 CPU——汇总退出交人工
      await emitExitOutput(
        `${escalationExitMessage(opts.rootId, escalated)}\n`,
        process.stderr,
      );
      return 1;
    }
    let workspaceChecked = false;
    for (const target of targets) {
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
      if (!workspaceChecked) {
        // 派发新 agent 前的 tracked 半成品清理（每轮一次）：无 in-flight →
        // reset --hard（untracked 不动）；有 in-flight → 仅提示
        workspaceChecked = true;
        checkWorkspaceForDispatch(opts.cwd, inFlight.length > 0);
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
      // wt-2（D5 四格矩阵）：派发前确保 unit worktree 就绪；失败不炸循环——error 原文
      // （含恢复指引）落 stderr，跳过该 unit 本轮派发（不 push inFlight），其余
      // unit 继续；下轮重算重试，无人处理时由 maxIdle 兜底退出
      const wtDir = worktreePath(getCwWorktreeHome(), opts.cwd, target.unitId);
      const ensured = ensureUnitWorktree(
        opts.cwd,
        wtDir,
        opts.rootId,
        target.unitId,
        baseCommit,
      );
      if (!ensured.ok) {
        emitErr(
          `[runner] unit "${target.unitId}" worktree 就绪失败，跳过本轮派发：${ensured.error}\n`,
        );
        continue;
      }
      const briefPath = writeBriefFile(wtDir, target, unit, projection, opts.rootId, opts.cwd);
      const handle = await opts.adapter.spawn({
        role: target.role,
        unitId: target.unitId,
        workdir: wtDir,
        projectCwd: opts.cwd,
        briefPath,
        timeoutMs: AGENT_SPAWN_TIMEOUT_MS,
      });
      inFlight.push({ role: target.role, unitId: target.unitId, handle });
      emit([
        `[runner] ${new Date().toISOString()} 派发 ${target.role} → unit "${target.unitId}"（worktree: ${wtDir}，brief: ${briefPath}）`,
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
        killAll(inFlight);
        await emitExitOutput(
          `${spawnErrorMessage(opts.rootId, finished.flight.unitId, finished.flight.role)}\n`,
          process.stderr,
        );
        return 1;
      }
      if (finished.result.exitCode === "TIMEOUT") {
        // 连续计数只记不判：是否转人工由下一轮开头（进展清零之后）判定——被
        // kill 的 agent 若死前已写账本，下一轮先清零，避免误转人工
        const previous = timeoutStreaks.get(finished.flight.unitId);
        timeoutStreaks.set(finished.flight.unitId, {
          count: (previous?.count ?? 0) + 1,
          role: finished.flight.role,
        });
      }
    }

    // 进展检查（六步之 5 的空转出口）：任一账本事件推进即视为有进展
    const totalEvents = loadLedger(opts.cwd).projection.totalEvents;
    if (totalEvents !== lastTotalEvents) {
      lastTotalEvents = totalEvents;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= maxIdleMs) {
      killAll(inFlight);
      await emitExitOutput(
        `${idleFailureMessage(opts.rootId, maxIdleMs, totalEvents, opts.cwd)}\n`,
        process.stderr,
      );
      return 1;
    }
  }
}

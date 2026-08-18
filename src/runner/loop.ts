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
 *     （fx-2 R4a 引入，rv-4 起上限 1：集成 fail 是确定性失败，无瞬时态可重试）
 *     → 停止自动重派，改派 designer 处置契约漂移（brief 含 merge 冲突清单、失败
 *     契约清单与二选一处置路径；人工窗口期间 loop 不再触发集成、不 reset root
 *     worktree）。split 含自身
 *     unitId = 自引用（gate 规则⑥ fx-1 已拒新账本）→ 记 stderr 警告并按叶子语义
 *     参与派发，绝不作为内部节点等待子树（fx-1 R1 loop 级防御）
 *   - spec-frozen 且当前 spec 周期内某 e2e 级验收连挂 ≥2 次（flakeReview，rv-5）
 *     → 不派任何 agent（builder 打回循环对随机挂无解），stderr 转人工判定指引
 *     （列出连挂用例 id 与逐次 fail 的 runId；处置 = 修稳定性 / 声明
 *     nondeterministic 重提 spec / 修真 bug）。复用 fx-2 上限出口的审计-不喂
 *     -idle 模式：停派后无新 VerifyRan，若树内无其他目标由 maxIdleMs 收束；
 *     人工处置写入账本后投影自然消失，运行中的循环下轮自愈
 *   - verified 且未 closed   → reviewer（exec-review）
 *
 * 等待期间零锁（canon D4：等待 spawn 期间持锁会饿死子进程的账本写入）。
 * 失败语义只看四态退出（types.ts）：exit≠0 / CRASH 可重派（下轮重算自然再次
 * 进入派发集合）；TIMEOUT 可重派但有封顶——同一 unit 连续 2 次 TIMEOUT（期间
 * 无任何该 unit 的账本进展）即转人工：不再派发，其余 unit 继续，stderr 打印
 * 转人工指引（canon 语义：不自动换模型重试，防静默降级）；SPAWN_ERROR 配置错误
 * 不重试，kill 全部 in-flight 后 exit 1。无可派发且无 in-flight 且存在转人工
 * unit → 循环以 exit 1 收束并汇总转人工清单。
 * 半成品清理由派发点 ensureUnitWorktree（reset --hard + clean -fd，裸形态——
 * worktree 内不存在任何 cw 想保护的东西）承担；项目 cwd 属于用户，runner 不触碰。
 *
 * worktree 语义（wt-2 起，docs/rewrite/design-worktree-isolation.md D1/D2/D3）：每个
 * 被派发 unit 在 <CW_WORKTREE_HOME>/<encoded-cwd>/<unitId> 的专属 git worktree
 * （分支双空间命名——root unit = cw-root/<rootId>、子 unit = cw/<rootId>/<unitId>，
 * base = run 启动时项目 HEAD 快照）里干活；账本与仓库操作锚定项目 cwd（D3 双路径）。循环不亲自创建 split 子 unit（fx-3 后子创建职责归
 * designer：首派任务书第 0 步指令化建子，spec gate 强制先建子后提 spec；循环仅
 * 在子未建时派 designer 兜底）。
 * worktree 生命周期闭环（wt-4 D5/D6 + fx-5 成对回收）：closed 子 unit 的资源
 * （worktree 目录 + 子分支）延迟一轮回收（pendingReclaim）+ 启动孤儿清扫（跨 run
 * 兜底，目录与 ref 双扫），root 自身的永不回收（回流载体）；子产出经
 * runIntegrationVerify 内聚的 merge 汇聚到 root 分支，merge 点不删子分支（fx-5：
 * 删除统一由终态回收承担——「冲突→人工解→重跑」路径上已达跳过会绕过 merge 点
 * 删除，造成分支永久残留）；root closed 汇总输出回收清单与 git merge 回流指引（G5）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { fold } from "../core/fold.js";
import type {
  DiscriminatedEvent,
  LedgerEvent,
  SequencedProjection,
  SequencedUnitProjection,
  VerifyRanPayload,
} from "../events/types.js";
import {
  computeFrontier,
  consecutiveIntegrationFails,
  type FlakeReviewFact,
  flakeReviewFacts,
  type FrontierGroups,
  INTEGRATION_MAX_CONSECUTIVE_FAILS,
  splitChildrenNotCreated,
  splitOf,
  splitSelfReferences,
} from "../readonly/frontier.js";
import { loadLedger, treeStatuses, unitStatus } from "../readonly/load.js";
import { EventLedger } from "../store/events-log.js";
import {
  getCwHome,
  getCwWorktreeHome,
  ledgerPath,
  topicDir,
  worktreePath,
} from "../store/project.js";
import type { OwnedContract } from "../verify/contract-match.js";
import { integrationRecoveryGuidance, readIntegrateReport, runIntegrationVerify } from "./integrate.js";
import type {
  AgentRole,
  AgentSpawnAdapter,
  SpawnHandle,
  SpawnResult,
} from "./spawn/types.js";
import {
  ensureUnitWorktree,
  listUnitBranchRefs,
  listUnitWorktreeIds,
  reclaimUnit,
  removeWorktree,
  unitBranchName,
} from "./worktree.js";

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

/** frontier 维度 → 派发形态（role 与集成直跑标记）。维度语义单一出处 = readonly/frontier.ts。
 * flakeReview 无条目（rv-5）：它是转人工维度——不派任何 agent（打回循环对随机挂
 * 无解），转人工指引由 runLoopMain 的 flakeEscalationMessage 出声。 */
const DISPATCH_SHAPE: Record<
  Exclude<keyof FrontierGroups, "flakeReview">,
  { role: AgentRole; integration: boolean }
> = {
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
 * 派发）。flakeReview 维度（rv-5）同样不派发——转人工指引由 runLoopMain 出声，
 * 此处只负责不进 targets。spec-frozen 自引用的 stderr 警告保持每轮可见——判定
 * 半边在共享函数（按叶子语义入组），此处只保留可观测性半边（fx-1 R1 loop 级防御）。
 */
function computeDispatchTargets(
  projection: SequencedProjection,
  rootId: string,
  inFlight: readonly InFlightSpawn[],
  consecutiveFails: ReadonlyMap<string, number>,
  flakeFacts: ReadonlyMap<string, readonly FlakeReviewFact[]>,
  excluded: ReadonlySet<string>,
): DispatchTarget[] {
  const groups = computeFrontier(projection, {
    consecutiveIntegrationFails: consecutiveFails,
    flakeReviewFacts: flakeFacts,
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
    if (dimension === undefined || dimension === "flakeReview") {
      // flakeReview：e2e 连挂转人工（rv-5）——不派任何 agent，打回循环停摆等人工
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
 * 集成契约集合：root spec 契约 ∪ 各子 spec 契约，全量带 owner 保留（rv-4：废除
 * 「同 id root 优先去重」——同 id 多 owner 版本并存时，冲突由契约比对的两道组合
 * 判定显性暴露：root 版 provider 指向子 → 与子冻结版配对比对；树内同 id 任一版本
 * 命中即过）。owner 标记是配对第一道（consumer ≡ provider 冻结）的输入。
 */
function collectIntegrationContracts(
  root: SequencedUnitProjection,
  children: readonly SequencedUnitProjection[],
): OwnedContract[] {
  const owners = [root, ...children];
  const contracts: OwnedContract[] = [];
  for (const owner of owners) {
    for (const contract of owner.specs[owner.specs.length - 1]?.contracts ?? []) {
      contracts.push({ contract, ownerUnitId: owner.unitId });
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
        `连续 fail 达 ${INTEGRATION_MAX_CONSECUTIVE_FAILS} 次上限——停止自动重派，下轮转派 designer 处置；` +
        `处置完成（新 spec 过审后计数清零）前不再自动重跑集成）：`,
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
    `3. 触发干净重跑验证：cw verify --unit ${unitId}（默认含红阶段检查——新测试在旧代码树必须 fail，恒真测试会被拒）。`,
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
 * 集成报告的失败事实（merge 冲突清单 + 契约清单 + 失败验收 id）与二选一处置指引
 * ——契约漂移/冲突的归属（改 spec 契约还是修实现/人工解冲突）需要语义判断，是
 * designer 的职责而非 runner 的（canon D4：runner 无智能）。报告不可读时降级为
 * 冻结 spec 的契约全集 + 指向查证命令（错误可操作闭环）。rv-4 起 MAX=1：首次
 * fail 即进入本出口（确定性失败无瞬时态可重试），且 merge 冲突事实（报告
 * mergeFailures 节）不再退化为「契约比对无失败项」类笼统文案。
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
        ? ["  （无契约——fail 来自 merge 冲突、验收红或 commit 可达性，见失败明细）"]
        : contracts.map(
            (c) => `  - ${c.id}: signature "${c.signature}" 期望文件 ${c.file ?? "（全树搜索）"}`,
          )),
    );
  } else {
    // rv-4：merge 冲突事实独立提取（报告 mergeFailures 节；旧报告无该节按空清单）
    const mergeFailures = read.report.mergeFailures ?? [];
    if (mergeFailures.length > 0) {
      factLines.push(
        "- merge 冲突清单（步骤 0 汇聚失败原文，含冲突子 unitId 与 root worktree 路径）：",
        ...mergeFailures.map((f) => `  - ${f}`),
      );
    }
    const contractFailures = read.report.contracts.failures;
    factLines.push(
      ...(contractFailures.length === 0
        ? [
            mergeFailures.length > 0
              ? "- 契约比对无失败项（fail 的机器事实见上方 merge 冲突清单与失败验收）"
              : "- 契约比对无失败项（fail 来自验收红或 commit 可达性，见失败明细）",
          ]
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
    "runner 已停止自动重派集成——契约漂移/merge 冲突的处置需要语义判断，由你按下述指引处置。",
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

/**
 * brief 落盘到 <artifactDir>/<unitId>.<role>.brief.md（fx-4：产物根随 run 级 topic
 * 目录，worktree 内不再有任何 cw 自身文件）。覆盖写语义不变——brief 内容随投影
 * 变化，append 会拼接出多版本任务书（设计 D2）。
 */
function writeBriefFile(
  artifactDir: string,
  target: DispatchTarget,
  unit: SequencedUnitProjection,
  projection: SequencedProjection,
  rootId: string,
  projectCwd: string,
  workdir: string,
): string {
  const path = join(artifactDir, `${target.unitId}.${target.role}.brief.md`);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    path,
    renderBrief(projection, unit, target.role, rootId, projectCwd, workdir),
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

// ---- rv-1：信号中断回收（Ctrl-C/SIGTERM 孤儿清理） ----

/** 信号中断的约定退出码（shell 惯例 128+signum：SIGINT=2 → 130、SIGTERM=15 → 143） */
const LOOP_SIGNAL_EXIT_CODES: Record<"SIGINT" | "SIGTERM", number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * runLoop 的信号 handler（SIGINT/SIGTERM 共用，rv-1）：Ctrl-C/SIGTERM 后 agent
 * 子进程会成孤儿继续写账本，用户重跑 `cw run` 对同一 worktree reset + 二次 spawn
 * 就是双 agent 混卷——所以 runner 必须主动回收全部在飞 spawn 再退出，「重跑即续」
 * 对进程维度也成立。只做回收：不写任何账本事件、不动 worktree/分支（回收 worktree
 * 是既有延迟回收逻辑的事，信号路径不额外触发 reclaim）。
 *
 * 退出路径三步与顺序（验收锁定）：提示行先于 killAll 打印（writeSync 同步落 stderr，
 * 用户立即看到响应——常规异步 write 在 process.exit 时可能被丢弃）→ best-effort
 * killAll（沿用既有语义：单个 kill 失败记录继续，不因清理失败改变退出码）→
 * process.exit(130|143)。
 */
function makeLoopSignalHandler(
  rootId: string,
  inFlight: readonly InFlightSpawn[],
): (signal: NodeJS.Signals) => void {
  return (signal) => {
    const exitCode = signal === "SIGINT" ? LOOP_SIGNAL_EXIT_CODES.SIGINT : LOOP_SIGNAL_EXIT_CODES.SIGTERM;
    try {
      writeSync(
        process.stderr.fd,
        `[runner] 收到 ${signal}：回收 ${inFlight.length} 个在飞派发后以 exit ${exitCode} 退出。` +
          `账本即状态——重跑 cw run --root ${rootId} 即续。\n`,
      );
    } catch (err) {
      // writeSync 失败（fd 异常等）不能阻断回收——回收与退出码是承诺；降级为常规
      // 异步 write 再试一次（尽力而为，即使 exit 时被队列丢弃也不影响回收路径）
      process.stderr.write(
        `[runner] 收到 ${signal}（提示行 writeSync 失败：${err instanceof Error ? err.message : String(err)}）：` +
          `回收 ${inFlight.length} 个在飞派发后以 exit ${exitCode} 退出。\n`,
      );
    }
    killAll(inFlight);
    process.exit(exitCode);
  };
}

/** summaryText 的 unit 资源回收统计（wt-4 J3/J4 + fx-5：run 生命周期内的回收清单） */
interface ReclaimSummary {
  /** 本 run 目录回收成功的 unit id（启动孤儿清扫 + 循环延迟回收 + 退出清尾；分支保守保留的情形经 stderr 指引人工确认） */
  reclaimed: readonly string[];
  /** run 结束时仍存在的本 root 子树 unit worktree 目录 id（root 自身 = 回流载体必在其列） */
  kept: readonly string[];
}

/** root closed 的汇总文本（验收文档循环逻辑 5：每 unit 状态行，树感知口径；wt-4 G5 回流指引） */
function summaryText(projection: SequencedProjection, rootId: string, reclaim: ReclaimSummary): string {
  const units = subtreeUnits(projection, rootId);
  const statuses = treeStatuses(projection);
  const rows = units.map((unit) => {
    const lastVerify =
      unit.verifyRuns.length > 0 ? unit.verifyRuns[unit.verifyRuns.length - 1].result : "-";
    return `[runner]   ${unit.unitId}  ${statuses.get(unit.unitId)}  lastVerify:${lastVerify}`;
  });
  const list = (ids: readonly string[]): string => (ids.length === 0 ? "" : `（${ids.join("、")}）`);
  const rootBranch = unitBranchName(rootId, rootId);
  return [
    `[runner] root "${rootId}" 已 closed——调度循环结束（exit 0）。汇总（root 子树 ${units.length} 个 unit）：`,
    ...rows,
    `[runner] 已回收 unit 资源（worktree 目录+子分支）× ${reclaim.reclaimed.length}${list(reclaim.reclaimed)}；` +
      `保留 worktree × ${reclaim.kept.length}${list(reclaim.kept)}`,
    `[runner] 成果分支：${rootBranch}（含全部已集成子产出）`,
    `[runner] 回流主分支：git merge ${rootBranch}`,
    `[runner] 证据链详情：cw report（全量）或 cw report --unit ${rootId}`,
    "",
  ].join("\n");
}

// ---- unit 资源回收（wt-4 J3 启动孤儿清扫 / J4 延迟回收，design D5 + fx-5 成对回收） ----

/**
 * unitId → rootId：沿账本投影的 parentId 链上溯至 null（fx-5：reclaimUnit 需要
 * rootId 拼分支名并锚定可达性判定的 root 分支）。账本内不存在、链断裂或成环返回
 * null（append-only 正常账本不会出现后两者——旁路写入的防御）。
 */
function rootIdOfUnit(projection: SequencedProjection, unitId: string): string | null {
  const seen = new Set<string>();
  let unit = projection.units.get(unitId);
  while (unit !== undefined && unit.parentId !== null && !seen.has(unit.unitId)) {
    seen.add(unit.unitId);
    unit = projection.units.get(unit.parentId);
  }
  return unit === undefined || seen.has(unit.unitId) ? null : unit.unitId;
}

/** 成对回收清单条目（rootId 由调用方解析：清扫路 ref 优先、账本次之；延迟路恒账本） */
interface ReclaimEntry {
  unitId: string;
  rootId: string;
}

/**
 * 回收动作（J3/J4 共用，fx-5 成对）：逐 unit 调 reclaimUnit（worktree 目录 + 子
 * 分支）——目录成功即计入本 run 回收清单（清单语义 unit 级）；任一侧失败出声
 * （error 原文含恢复指引；分支侧失败 = 保守保留，产出未确认回流前不删）后继续，
 * 不炸循环。返回目录回收成功的 id。
 */
function reclaimUnits(cwd: string, entries: Iterable<ReclaimEntry>): string[] {
  const reclaimed: string[] = [];
  for (const { unitId, rootId } of entries) {
    const res = reclaimUnit(cwd, rootId, unitId);
    if (res.worktree.ok) {
      reclaimed.push(unitId);
    } else {
      emitErr(`[runner] unit "${unitId}" 的 worktree 回收失败——${res.worktree.error}\n`);
    }
    if (!res.branch.ok) {
      emitErr(`[runner] unit "${unitId}" 的子分支回收失败（保守保留）——${res.branch.error}\n`);
    }
  }
  return reclaimed;
}

/**
 * J4 延迟回收的账本内解析：closed 清单恒来自账本（closed 是账本事实），上溯失败
 * 属账本异常——跳过并出声（不猜 rootId：锚错 root 分支会让可达性判定失真）。
 */
function reclaimPendingUnits(
  cwd: string,
  projection: SequencedProjection,
  unitIds: Iterable<string>,
): string[] {
  const entries: ReclaimEntry[] = [];
  for (const unitId of unitIds) {
    const rootId = rootIdOfUnit(projection, unitId);
    if (rootId === null) {
      emitErr(
        `[runner] unit "${unitId}" 的资源回收跳过：账本内无法上溯其 root（unit 不存在或 parentId 链断裂）。` +
          `恢复动作：cw status 核对账本后重跑；确认无未保存产出后可手动清理残留` +
          `（git worktree remove --force <路径> / git branch -D <分支>）。\n`,
      );
      continue;
    }
    entries.push({ unitId, rootId });
  }
  return reclaimUnits(cwd, entries);
}

/**
 * J3 启动孤儿清扫（D5 跨 run 兜底，fx-5 双扫）：「上一轮 closed」的内存态判断跨
 * run 不可靠（Ctrl-C 反复中断会堆积残留），启动时按目录扫描（现状）+ ref 扫描
 * （fx-5：「目录已亡分支残留」的孤儿——M3 gate 残留形态的发现源）取 unitId 并集，
 * 全账本树感知状态统一判定——已 closed 或账本内不存在（旁路残留）→ 回收；未
 * closed（含其他 root 的 unit——判定查全账本而非本 root 子树）→ 保留。本 run 的
 * root 永不回收（worktree 是回流载体；cw-root/ 成果分支不在 cw/ 命名空间，天然
 * 不在 ref 扫描结果内）。无主 unit 的 rootId：ref 路直接有、目录路账本上溯；两侧
 * 都拿不到时目录回收照做（J3 原语义），分支侧无 ref 即不存在、无需处理。同步执行
 * （量级 = 目录数 + ref 数，不阻塞主循环）。
 */
function sweepOrphanWorktrees(cwd: string, rootId: string): string[] {
  const home = getCwWorktreeHome();
  const dirIds = listUnitWorktreeIds(home, cwd);
  const branchRefs = listUnitBranchRefs(cwd);
  if (dirIds.length === 0 && branchRefs.length === 0) {
    return [];
  }
  const projection = loadLedger(cwd).projection;
  const statuses = treeStatuses(projection);
  const rootIdByRef = new Map<string, string>();
  for (const ref of branchRefs) {
    if (!rootIdByRef.has(ref.unitId)) {
      rootIdByRef.set(ref.unitId, ref.rootId);
    }
  }
  const entries: ReclaimEntry[] = [];
  const ghostDirOnly: string[] = [];
  for (const unitId of [...new Set([...dirIds, ...rootIdByRef.keys()])].sort()) {
    if (unitId === rootId) {
      continue;
    }
    const status = statuses.get(unitId);
    if (status !== undefined && status !== "closed") {
      continue;
    }
    const knownRoot = rootIdByRef.get(unitId) ?? rootIdOfUnit(projection, unitId);
    if (knownRoot === null) {
      ghostDirOnly.push(unitId);
      continue;
    }
    entries.push({ unitId, rootId: knownRoot });
  }
  const reclaimed = reclaimUnits(cwd, entries);
  for (const unitId of ghostDirOnly) {
    const res = removeWorktree(cwd, worktreePath(home, cwd, unitId));
    if (res.ok) {
      reclaimed.push(unitId);
    } else {
      emitErr(`[runner] unit "${unitId}" 的 worktree 回收失败——${res.error}\n`);
    }
  }
  if (reclaimed.length > 0) {
    emit([
      `[runner] 启动孤儿清扫：回收 ${reclaimed.length} 个已 closed/无主 unit 的 worktree 目录与子分支` +
        `（${reclaimed.join("、")}）`,
    ]);
  }
  return reclaimed;
}

function idleFailureMessage(rootId: string, maxIdleMs: number, totalEvents: number, artifactDir: string): string {
  // 产物根随 fx-4 迁 run 级 topic 目录（stdout/stderr 按 <unitId>.<role>.* 落盘其下）
  return (
    `cw run: root "${rootId}" 超过 ${maxIdleMs}ms 无账本进展（totalEvents 停在 ${totalEvents}，` +
    "被派发 agent 未产出任何事件）。恢复动作：查看本次 run 的 agent 输出（" +
    `${artifactDir}/ 下各 <unitId>.<role>.stdout / .stderr）定位卡点，或 cw status 查看现状；` +
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
function escalationMessage(rootId: string, unitId: string, role: AgentRole, artifactDir: string): string {
  // 产物根随 fx-4 迁 run 级 topic 目录（stdout/stderr append 累积本 run 历次输出）
  const stdoutPath = join(artifactDir, `${unitId}.${role}.stdout`);
  return (
    `cw run: unit "${unitId}" 的 ${role} 连续 ${AGENT_TIMEOUT_ESCALATION_AFTER} 次 spawn TIMEOUT` +
    "（期间无该 unit 的任何账本进展）——停止自动重派，转人工处理（canon：不自动换模型重试，" +
    "防静默降级；本循环继续处理其余 unit）。恢复动作（按序）：\n" +
    `  1. 人工接手该 unit：重新运行 cw run --root ${rootId} --spawn human（按打印的指令手工推进；账本即状态，已完成进度不丢）\n` +
    `  2. 定位卡点：查看 ${stdoutPath} 与同级 .stderr（本次 run 的历次输出；跨 run 历史在 ~/.cw/topic/ 下按 runTs 目录可查）\n` +
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
    `\n恢复动作：按各 Unit 的转人工指引处理（cw run --root ${rootId} --spawn human 人工接手），` +
    "完成后重新运行 cw run --root ${rootId} 继续（账本即状态，重跑即续）。"
  );
}

/**
 * e2e 连挂转人工指引（rv-5，canon §5.2「连挂 2 次的 e2e 用例标 flake 转人工，
 * 不自动豁免，防 Goodhart」）：列出连挂用例 id 与逐次 fail 的 runId，人工判定
 * 动作二选一（判 flake → 修稳定性或声明 nondeterministic 重提 spec；判真 bug →
 * 人工修复）。出口形态复用 fx-2 上限出口的「审计-不喂-idle」模式：停止派发后
 * 不再产生新 VerifyRan 喂活 idle 判定——若树内无其他可推进目标，空转由
 * maxIdleMs 收束退出；人工处置（新 verify pass / 新 spec 过审）写入账本后投影
 * 自然消失，运行中的循环下轮自愈。
 */
function flakeEscalationMessage(
  rootId: string,
  unitId: string,
  facts: readonly FlakeReviewFact[],
): string {
  const factLines = facts.map(
    (f) =>
      `  - 验收 ${f.acceptanceId}：当前 spec 周期内连续 ${f.consecutiveFails} 次 fail（runId：${f.runIds.join("、")}）`,
  );
  return (
    `cw run: unit "${unitId}" 的 e2e 验收连挂 2 次以上（flake 疑似）——停止对该 unit 派发 builder（打回循环对随机挂无解），` +
    "转人工判定（canon §5.2：不自动豁免，防 Goodhart；本循环继续处理其余 unit）：\n" +
    factLines.join("\n") +
    "\n人工判定动作（按序）：\n" +
    `  1. 查看逐次产物：cw report --unit ${unitId}（各 runId 的 report.json 与 stdout/stderr）\n` +
    "  2. 判定为 flake（测试随机性不稳定）→ 修测试稳定性，或声明 nondeterministic 后重提 spec 并重新过审：\n" +
    `     cw evidence submit --kind spec --unit ${unitId} --file spec.json（新 spec 提交即清零连挂计数）\n` +
    "  3. 判定为真 bug → 人工修复实现后重新提交 build 证据并 cw verify\n" +
    "处置完成投影自然重算（账本即状态）：运行中的循环下轮自愈；已退出的重新运行 " +
    `cw run --root ${rootId} 即续。`
  );
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
 * runLoop 导出入口（rv-1 起是主循环体的信号处理外壳）：入口即注册 SIGINT/SIGTERM
 * handler（早于参数校验与首个派发——校验/清扫阶段的信号同样有回收出口），
 * try/finally 保证全部正常出口与异常出口（throw）都 process.off 移除——runLoop
 * 是库化函数（tests 直接调用），handler 泄漏会把下一次 Ctrl-C 变成本 run 的退出。
 * 信号到达时 handler 自行 writeSync + killAll + process.exit，不经过 finally
 * （process.exit 不回卷栈），这是设计行为而非泄漏。
 */
export async function runLoop(opts: RunLoopOptions): Promise<number> {
  // inFlight 提升到外壳：信号 handler 需要在主循环体启动前就持有同一引用
  //（循环未起来时的信号 → killAll 空集 no-op，同样打印提示行并按约定码退出）
  const inFlight: InFlightSpawn[] = [];
  const signalHandler = makeLoopSignalHandler(opts.rootId, inFlight);
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);
  try {
    return await runLoopMain(opts, inFlight);
  } finally {
    process.off("SIGINT", signalHandler);
    process.off("SIGTERM", signalHandler);
  }
}

/**
 * 通用调度循环：root closed → 汇总返回 0；无进展超 maxIdleMs → stderr + 返回 1；
 * SPAWN_ERROR（配置错误）→ kill 全部 in-flight + stderr + 返回 1；连续 TIMEOUT
 * 封顶的 unit 转人工（不再派发），无可自动推进且存在转人工 unit → stderr 汇总 +
 * 返回 1。
 * root 不在账本 → 抛可操作错误（调用方负责转 exit 1）。
 */
async function runLoopMain(opts: RunLoopOptions, inFlight: InFlightSpawn[]): Promise<number> {
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

  // wt-4 J3：启动孤儿清扫（HEAD 快照之后、首次派发之前）——跨 run 兜底回收
  // 已 closed / 账本不存在的 unit worktree；本 run root 的永不回收（回流载体）
  const reclaimedIds: string[] = [...sweepOrphanWorktrees(opts.cwd, opts.rootId)];

  // fx-4：run 级 topic 目录——spawn 过程产物（brief/stdout/stderr）的归档根。
  // 启动创建一次、全 run 复用：同 run 重派共用（stdout/stderr append 累积、brief
  // 覆盖写）；跨 run（≥1 秒）自然新目录，同秒碰撞由 topicDir 的 -N 递增后缀消解。
  // 产物落在 CW_HOME 内，worktree 从此只承载 agent 业务产出与 commit（纯化）
  const artifactsDir = topicDir(getCwHome(), opts.cwd, opts.rootId);
  mkdirSync(artifactsDir, { recursive: true });

  emit([
    `[runner] 循环启动：root=${opts.rootId} adapter=${opts.adapter.name} ` +
      `poll=${pollMs}ms max-idle=${maxIdleMs}ms max-concurrency=${maxConcurrency}`,
  ]);

  let lastTotalEvents = initial.projection.totalEvents;
  let lastProgressAt = Date.now();
  // 连续 TIMEOUT 计数（单进程内存态；语义见 AGENT_TIMEOUT_ESCALATION_AFTER 注释）。
  // escalated 单向：一经转人工，本次运行内不再自动派发（人工接手期间 loop 插足
  // 会与人工操作冲突；进展清零只作用于计数，不撤销转人工）
  const timeoutStreaks = new Map<string, TimeoutStreak>();
  const escalated = new Map<string, AgentRole>();
  // rv-5 flake 转人工的出声去重：unitId → 最近一次已出声的连挂签名（各 fact 的
  // acceptanceId@最新 runId）。投影事实每轮重算（账本即状态），同一连挂只出声
  // 一次；人工处置后连挂消失、再连挂（新 runId）时签名变化重新出声
  const announcedFlake = new Map<string, string>();
  let lastUnitSeqs = new Map<string, number>();
  // wt-4 J4 延迟回收：pendingReclaim = 本轮发现的 closed 子 unit（下轮开头回收，
  // debug 翻看现场留一轮窗口）；reclaimTried = 已尝试回收的（成败均不再重试——
  // closed 是持续状态，fx-5 起 reclaim 虽幂等（目录/分支已亡均 ok），但分支保守
  // 保留（tip 未回流）的场景每轮重试只会重复刷同一条 stderr 指引，残留由下次
  // run 的启动清扫按「可达性已满足」再收）
  const pendingReclaim = new Set<string>();
  const reclaimTried = new Set<string>(reclaimedIds);

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
    // wt-4 J4 延迟回收（D5，fx-5 成对）：每轮循环开头回收「上一轮收集的 closed 子
    // unit 资源（worktree 目录 + 子分支）」（root 自身永不入列——回流载体，run 结束
    // 保留）；再收集本轮新 closed 的（下轮开头回收）。放在 root closed 检查之前：
    // 退出前 pending 已清空
    reclaimedIds.push(...reclaimPendingUnits(opts.cwd, projection, pendingReclaim));
    for (const unitId of pendingReclaim) {
      reclaimTried.add(unitId);
    }
    pendingReclaim.clear();
    const statuses = treeStatuses(projection);
    for (const unit of subtreeUnits(projection, opts.rootId)) {
      if (unit.unitId === opts.rootId || reclaimTried.has(unit.unitId)) {
        continue;
      }
      if (
        statuses.get(unit.unitId) === "closed" &&
        existsSync(worktreePath(getCwWorktreeHome(), opts.cwd, unit.unitId))
      ) {
        pendingReclaim.add(unit.unitId);
      }
    }

    if (statuses.get(opts.rootId) === "closed") {
      // 退出条件 = 树感知 closed（canon D2 完整公式：root verified ∧ exec-review
      // pass ∧ 全部直接子节点 closed），与 readonly 四命令同一投影口径。u8 时代
      // 「子全 closed」是本循环的补偿逻辑（当时 deriveStatus 够不到子节点），已
      // 归位 fold 层——root 的 exec-review 先于子收尾入账时循环不退，子的
      // reviewer 继续派发，无进展由 maxIdleMs 兜底
      // 正常路径 in-flight 已空；外部（如人工）直接推 closed 时的兜底回收
      killAll(inFlight);
      // 退出清尾：run 已结束，本轮刚收集的 closed 子现场一并回收（延迟窗口语义
      // 已过点——产出已 merge 进 root 分支且证据链闭合，D5：现场无保留价值；
      // fx-5 成对：目录与子分支一起收）
      reclaimedIds.push(...reclaimPendingUnits(opts.cwd, projection, pendingReclaim));
      pendingReclaim.clear();
      // 保留清单 = 本 root 子树在 run 结束时仍存在的 worktree（root 自身 = 回流载体）
      const subtreeIds = new Set(subtreeUnits(projection, opts.rootId).map((u) => u.unitId));
      const kept = listUnitWorktreeIds(getCwWorktreeHome(), opts.cwd).filter((id) =>
        subtreeIds.has(id),
      );
      await emitExitOutput(
        summaryText(projection, opts.rootId, { reclaimed: reclaimedIds, kept }),
        process.stdout,
      );
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
        emitErr(escalationMessage(opts.rootId, unitId, streak.role, artifactsDir));
      }
    }

    // rv-5 flakeReview 出口：e2e 验收连挂 ≥2 的 root 子树 unit 转人工（不派
    // builder）。事实来自账本重放（flakeReviewFacts），人工处置写入新事件
    //（pass / 新 spec）后投影自然消失、循环自愈；出声按连挂签名去重
    const flakes = flakeReviewFacts(events);
    const subtreeIds = new Set(subtreeUnits(projection, opts.rootId).map((u) => u.unitId));
    for (const [unitId, facts] of flakes) {
      if (!subtreeIds.has(unitId)) {
        continue; // 其他 root 的 unit（同一账本多 root）：不在本 run 职责内
      }
      const signature = facts
        .map((f) => `${f.acceptanceId}@${f.runIds[f.runIds.length - 1] ?? ""}`)
        .join("|");
      if (announcedFlake.get(unitId) !== signature) {
        announcedFlake.set(unitId, signature);
        emitErr(flakeEscalationMessage(opts.rootId, unitId, facts));
      }
    }

    // 派发（六步之 1-3）：frontier 重算 → 内部节点直跑集成（确定性代码，不派
    // agent、不占并发额度）→ brief 落盘 → spawn，同批 ≤ maxConcurrency
    const targets = computeDispatchTargets(
      projection,
      opts.rootId,
      inFlight,
      consecutiveIntegrationFails(events),
      flakes,
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
      const briefPath = writeBriefFile(artifactsDir, target, unit, projection, opts.rootId, opts.cwd, wtDir);
      const handle = await opts.adapter.spawn({
        role: target.role,
        unitId: target.unitId,
        workdir: wtDir,
        projectCwd: opts.cwd,
        artifactDir: artifactsDir,
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
        `${idleFailureMessage(opts.rootId, maxIdleMs, totalEvents, artifactsDir)}\n`,
        process.stderr,
      );
      return 1;
    }
  }
}

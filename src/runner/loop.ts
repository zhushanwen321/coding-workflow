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
 *   - created 且无 spec      → designer（建子（root 无子时，fx-3 R5.2 任务书第
 *     0 步）+ spec 提交；完成标志 = spec 入账——spec-review 由下轮独立 reviewer 接手）
 *   - created 且有 spec 且最后一条 SpecSubmitted 之后无任何 spec-review verdict
 *     → reviewer（mx-1 specReviewPending：spec-review 一律由独立 reviewer spawn
 *     提交——审查视角 brief + 可选异源模型，canon §1.3 信任链的结构隔离落地）
 *   - created 且有 spec 且最后 spec 后最近的 role=reviewer spec-review verdict
 *     是 fail → designer（mx-1 specFixPending：修 spec 重提——任务书内嵌 reviewer
 *     fail verdict 的 comment 全文作失败事实；重提后自然回流 specReviewPending
 *     由 reviewer 再审）
 *   - created 且账本内 spec-review 打回代数 ≥2（mx-1 specReviewDeadlock；mx-3 起
 *     按代数计数——同条 SpecSubmitted 后多条 fail 只计 1 代，MF2 教训由代数累计
 *     保持：重提不清零）→ 不派任何 agent（打回循环活锁对机器无解），stderr
 *     转人工 escalation（各代打回意见摘要 + 人工处置动作）；复用 fx-2 上限出口
 *     的审计-不喂-idle 模式，人工 pass verdict 后投影自然消失
 *   - 派发 gate（mx-1 S1）：同 unit 存在任意 role 的 in-flight spawn 时本轮缓派
 *     该 unit 的全部新派发（reviewer 派发的 worktree reset 会清在飞 designer 的
 *     现场；同时修复既有 designer→builder 转换竞态）。等待窗口 ≤ 一个 poll 周期
 *     （in-flight spawn 必然 wait() 结算或 TIMEOUT，无死等路径）
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
 *   - verified 且未 closed   → reviewer（exec-review；任务书含 rv-2 必填的
 *     --evidence-refs 与 mx-1 的 --role reviewer 自报）
 *
 * 抢答可见性（mx-1 S7；mx-3 豁免收紧）：本 run 期间新入账的 spec-review
 * VerdictSubmitted，若其入账时刻不在该 unit 任何 reviewer flight 的存活窗口
 * （spawn→结算）内、且非 specFixPending 流转 → stderr 一行警告（不阻断不入账
 * ——role 自报可伪造，结构隔离之外的唯一可见性增强）。原「本 run 派发过该
 * unit 的 reviewer 即永久豁免」已废除（M4 gate §5.1 的绕过正是被它吞掉警告）；
 * 正常 reviewer spawn 内的提交豁免不误报，晚到提交 / builder in-flight 期间的
 * 自审提交告警。
 *
 * 异源模型链（mx-1 S3，pi.ts 零改动）：RunLoopOptions.reviewerModel（cw run
 * --reviewer-model）> 进程环境 CW_REVIEWER_MODEL > 不注入（reviewer spawn 回落
 * builder 同款模型链）。注入点 = reviewer role 的 spawn req.env.CW_AGENT_MODEL，
 * 复用 resolvePiModel 既有四级链的 req.env 级。
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
import { existsSync, mkdirSync, readFileSync, writeSync } from "node:fs";
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
  latestSpecReviewAfterLastSpec,
  SPEC_REVIEW_DEADLOCK_FAILS,
  specReviewFailCounts,
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
import { type DispatchDimension, writeBriefFile } from "./brief.js";
import { runIntegrationVerify } from "./integrate.js";
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
  /**
   * reviewer spawn 的异源模型（mx-1 S3，可选项——未配置时回落 builder 同款模型链，
   * 结构隔离不依赖模型异源）。CLI 来源 = --reviewer-model flag（优先）或进程环境
   * CW_REVIEWER_MODEL；注入点 = reviewer role 的 spawn req.env.CW_AGENT_MODEL
   * （复用 pi 适配器 resolvePiModel 既有四级链，pi.ts 零改动）。
   */
  reviewerModel?: string;
}

/** in-flight 派发（mx-1 派发 gate 后同 unit 任意时刻至多一个在飞 spawn） */
interface InFlightSpawn {
  role: AgentRole;
  unitId: string;
  handle: SpawnHandle;
  /**
   * reviewer flight 的存活窗口（mx-3 抢答豁免收紧）：role=reviewer 的 flight
   * 在派发时创建并挂到本对象，结算时填 settledAt——窗口登记表与 flight 生命
   * 周期一对一同步。非 reviewer 的 flight 恒 undefined。
   */
  reviewerWindow?: ReviewerFlightWindow;
}

interface DispatchTarget {
  role: AgentRole;
  unitId: string;
  /** 派发依据的 frontier 维度（任务书模板按维度选择，mx-1 起 reviewer 有两种形态） */
  dimension: DispatchDimension;
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
 * specReviewDeadlock / flakeReview 无条目（mx-1 / rv-5）：两者都是转人工维度——
 * 不派任何 agent（打回循环对活锁/随机挂无解），转人工指引由 runLoopMain 的
 * specDeadlockEscalationMessage / flakeEscalationMessage 出声。
 * mx-1：specReviewPending（spec 审）与 execReviewReady（执行审）都派 reviewer，
 * 但任务书形态不同（renderBrief 按 dimension 区分）。 */
const DISPATCH_SHAPE: Record<
  DispatchDimension,
  { role: AgentRole; integration: boolean }
> = {
  specReady: { role: "designer", integration: false },
  specReviewPending: { role: "reviewer", integration: false },
  specFixPending: { role: "designer", integration: false },
  missingChildren: { role: "designer", integration: false },
  integrationDrift: { role: "designer", integration: false },
  integrationReady: { role: "builder", integration: true },
  buildReady: { role: "builder", integration: false },
  execReviewReady: { role: "reviewer", integration: false },
};

/**
 * 派发对象集合：消费 readonly/frontier.ts 的 computeFrontier（与 `cw frontier`
 * 命令同一就绪判定，A4「零上下文接手」场景输出与真实派发一致），限定 root
 * 子树、按 BFS 序展开为 (role, unitId, dimension, integration)。派发 gate
 * （mx-1 S1）：同 unit 存在任意 role 的 in-flight spawn 时本轮缓派该 unit 的
 * 全部新角色——reviewer 派发前的 worktree reset 会清在飞 designer 的现场，
 * 同理修复既有 designer→builder 转换竞态；等待窗口 ≤ 一个 poll 周期。
 * excluded = 转人工 unit（连续 TIMEOUT 封顶后不再派发）。specReviewDeadlock /
 * flakeReview 维度同样不派发——转人工指引由 runLoopMain 出声，此处只负责不进
 * targets。spec-frozen 自引用的 stderr 警告保持每轮可见——判定半边在共享函数
 * （按叶子语义入组），此处只保留可观测性半边（fx-1 R1 loop 级防御）。
 */
function computeDispatchTargets(
  projection: SequencedProjection,
  rootId: string,
  inFlight: readonly InFlightSpawn[],
  consecutiveFails: ReadonlyMap<string, number>,
  flakeFacts: ReadonlyMap<string, readonly FlakeReviewFact[]>,
  specFails: ReadonlyMap<string, number>,
  excluded: ReadonlySet<string>,
): DispatchTarget[] {
  const groups = computeFrontier(projection, {
    consecutiveIntegrationFails: consecutiveFails,
    flakeReviewFacts: flakeFacts,
    specReviewFailCounts: specFails,
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
    if (
      dimension === undefined ||
      dimension === "flakeReview" ||
      dimension === "specReviewDeadlock"
    ) {
      // 转人工维度（rv-5 flake / mx-1 spec 打回复审活锁）——不派任何 agent，
      // 打回循环停摆等人工处置后投影自然消失
      continue;
    }
    const shape = DISPATCH_SHAPE[dimension];
    const unitInFlight = inFlight.some(
      (flight) => flight.unitId === unit.unitId,
    );
    if (unitInFlight) {
      continue;
    }
    targets.push({
      role: shape.role,
      unitId: unit.unitId,
      dimension,
      integration: shape.integration,
    });
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
 * spec-review 打回活锁转人工指引（mx-1 MF2 引入，mx-3 计数改按打回代数，防
 * ping-pong：fail → designer 修 → fail → 修 → … 的无限循环对机器无解）。列出
 * 各代打回的首条 fail verdict comment 摘要（审计事实，同代试探性提交不重复
 * 列出）与人工处置动作。出口形态复用 fx-2 上限出口的「审计-不喂-idle」模式：
 * 停止派发后不再产生新事件——若树内无其他可推进目标，空转由 maxIdleMs 收束
 * 退出；人工处置（人工以 reviewer 身份提交 pass verdict，或改写后人工过审）
 * 写入账本后 unit 离开 created 态，投影自然消失，运行中的循环下轮自愈。
 */
function specDeadlockEscalationMessage(
  rootId: string,
  unitId: string,
  failComments: readonly string[],
): string {
  const commentLines = failComments.map(
    (comment, i) => `  - 第 ${i + 1} 代打回的意见：${comment}`,
  );
  return (
    `cw run: unit "${unitId}" 的 spec-review 已打回 ${failComments.length} 代（≥${SPEC_REVIEW_DEADLOCK_FAILS}，重提 spec 不清零代数累计）` +
    "——判定 designer-reviewer 打回循环活锁，停止对该 unit 派发（继续循环只会重演），转人工处置" +
    "（canon：不自动换模型重试，防静默降级；本循环继续处理其余 unit）：\n" +
    commentLines.join("\n") +
    "\n人工处置动作（按序）：\n" +
    `  1. 人工接手该 unit：cw run --root ${rootId} --spawn human（按打印的指令手工推进；账本即状态，已完成进度不丢）\n` +
    `  2. 人工审查该 spec：cw report --unit ${unitId}（原文副本见 evidence 目录 attachments/）\n` +
    `  3. 处置三选一：人工修 spec 重提后由你以 reviewer 身份判定（cw evidence submit --kind spec --unit ${unitId} --file spec.json + ` +
    `cw review submit --unit ${unitId} --verdict-kind spec-review --verdict pass --role reviewer——mx-3 起 spec-review 必须携带 --role reviewer）；` +
    "或判定任务书本身不可行，人工关闭/重构该 unit；或确认 reviewer 判定有误，人工提交 pass verdict\n" +
    "处置完成（unit 离开 created 态）投影自然重算（账本即状态）：运行中的循环下轮自愈；已退出的重新运行 " +
    `cw run --root ${rootId} 即续。`
  );
}

/**
 * 该 unit 各打回代数的首条 fail comment（mx-3：只认 role=reviewer 的 fail、按
 * SpecSubmitted 代数取每代首条——与 specReviewFailCounts 的计数口径完全同构，
 * 转人工指引列出的意见数 = 打回代数；缺 comment 时给可定位占位）。需原始事件
 * 流（fold 投影的平行数组丢失跨类型顺序）。
 */
function specReviewFailComments(
  events: readonly LedgerEvent[],
  unitId: string,
): string[] {
  const comments: string[] = [];
  let countedInGeneration = false;
  for (const record of events) {
    const event = record as DiscriminatedEvent;
    if (event.type === "SpecSubmitted" && event.payload.unitId === unitId) {
      countedInGeneration = false;
    } else if (
      event.type === "VerdictSubmitted" &&
      event.payload.unitId === unitId &&
      event.payload.verdictKind === "spec-review" &&
      event.payload.verdict === "fail" &&
      event.payload.role === "reviewer"
    ) {
      if (!countedInGeneration) {
        comments.push(
          event.payload.comment ??
            "（该次 fail 未附 comment——按 cw report --unit 的 verdict 时间线核对）",
        );
        countedInGeneration = true;
      }
    }
  }
  return comments;
}

/**
 * 抢答警告行（mx-1 S7；mx-3 豁免收紧）：spec-review verdict 入账时刻，该 unit
 * 无在场的 reviewer spawn（in-flight 或其 spawn 窗口内）且非 specFixPending 流转
 * （fail 的打回修复有 loop 的收敛出口）——唯一可见性增强，不阻断不入账。
 * mx-3 收紧点：原「本 run 派发过该 unit 的 reviewer 即永久豁免」废除（M4 gate
 * §5.1 三因之一——builder 重提 spec 后的自审被该豁免吞掉警告）；正常 reviewer
 * spawn 内的提交（verdict ts 落在该 reviewer flight 的 spawn→结算窗口内）豁免
 * 不误报。
 */
function prematureVerdictWarningLine(unitId: string): string {
  return (
    `[runner] 警告：unit "${unitId}" 出现新的 spec-review verdict，但该 verdict 入账时该 unit 无在场的 ` +
    "reviewer spawn（不在任何 reviewer flight 的存活窗口内）且非 fail 打回流转——疑似非独立 reviewer 提交（designer 自审 / " +
    "builder 越权 / 人工抢答）。role 字段是自报弱声明可伪造；本警告仅审计可见性，不阻断。\n"
  );
}

/**
 * reviewer flight 的存活窗口（mx-3 抢答豁免收紧的判定输入）：spawnedAt = 派发
 * 时刻，settledAt = wait() 结算时刻（null = 仍在飞）。verdict 的入账 ts 落在
 * [spawnedAt, settledAt] 内即视为「reviewer 在场期间提交」——正常 reviewer 流
 * （worker 在 spawn 内写完 verdict 再退出）不误报；reviewer 已结算后的晚到提交、
 * builder in-flight 期间的自审提交（无匹配窗口）都会告警。
 */
interface ReviewerFlightWindow {
  spawnedAt: number;
  settledAt: number | null;
}

/**
 * VerdictSubmitted 的 seq → 入账时刻映射（mx-3 S7 抢答检查的输入）：fold 投影
 * 不含 ts，从原始事件流提取；ts 不可解析的条目不入表（消费侧保守告警）。
 */
function specVerdictTsBySeq(events: readonly LedgerEvent[]): Map<number, number> {
  const tsBySeq = new Map<number, number>();
  for (const record of events) {
    const event = record as DiscriminatedEvent;
    if (event.type === "VerdictSubmitted") {
      const ts = Date.parse(event.ts);
      if (Number.isFinite(ts)) {
        tsBySeq.set(event.seq, ts);
      }
    }
  }
  return tsBySeq;
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

  // mx-1 S3：reviewer 异源模型链——flag（--reviewer-model）优先于进程环境
  // CW_REVIEWER_MODEL，都未设则不注入（reviewer 回落 builder 同款模型链）。
  // 读取点在启动时一次性定格（与 CW_HOME 等环境语义一致，运行中改 env 不生效）
  const envReviewerModel = process.env.CW_REVIEWER_MODEL;
  const reviewerModel =
    opts.reviewerModel ??
    (envReviewerModel !== undefined && envReviewerModel !== "" ? envReviewerModel : undefined);

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
  // rv-5 flake 转人工的出声去重（mx-3 改按「消息文本 + unitId」复合签名——文本
  // 含 unitId 与连挂事实，同签名不重播；人工处置后连挂消失、再连挂（新事实改变
  // 文本）时重新出声。修复 M4 gate §5.5：in-flight builder 的第三次连挂使旧
  // runId 签名失效导致整段消息重复打印）
  const announcedFlake = new Map<string, string>();
  // mx-1 MF2 spec 打回活锁转人工的出声去重（mx-3 同样改消息文本签名，语义同上）
  const announcedDeadlock = new Map<string, string>();
  // mx-1 S7 抢答警告的去重水位：unitId → 已评估过的最高 spec-review verdict seq。
  // 初始值取本 run 启动时的账本现状（重跑场景下历史 verdict 不追警告，只看本
  // run 期间新入账的）
  const seenSpecVerdictSeq = new Map<string, number>();
  for (const unit of initial.projection.units.values()) {
    for (let i = 0; i < unit.verdicts.length; i += 1) {
      const verdict = unit.verdicts[i];
      if (verdict?.verdictKind === "spec-review") {
        const seq = unit.verdictSeqs[i] ?? 0;
        seenSpecVerdictSeq.set(unit.unitId, Math.max(seenSpecVerdictSeq.get(unit.unitId) ?? 0, seq));
      }
    }
  }
  // mx-3 S7 豁免收紧：reviewer flight 存活窗口登记表（unitId → 本 run 全部
  // reviewer flight 的窗口）。取代原「本 run 派发过即永久豁免」的 Set——豁免
  // 只认「verdict 入账时刻 reviewer 在场」，builder in-flight 期间的自审提交、
  // reviewer 结算后的晚到提交都会告警（可见性增强，不阻断）
  const reviewerFlightWindows = new Map<string, ReviewerFlightWindow[]>();
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
    //（pass / 新 spec）后投影自然消失、循环自愈；出声按「消息文本 + unitId」
    // 复合签名去重（mx-3：修复 M4 gate §5.5 消息重复打印——in-flight builder
    // 追加的连挂事实不改变已出声消息时不再重播）
    const flakes = flakeReviewFacts(events);
    const subtreeIds = new Set(subtreeUnits(projection, opts.rootId).map((u) => u.unitId));
    for (const [unitId, facts] of flakes) {
      if (!subtreeIds.has(unitId)) {
        continue; // 其他 root 的 unit（同一账本多 root）：不在本 run 职责内
      }
      const message = flakeEscalationMessage(opts.rootId, unitId, facts);
      if (announcedFlake.get(unitId) !== message) {
        announcedFlake.set(unitId, message);
        emitErr(message);
      }
    }

    // mx-1 MF2 specReviewDeadlock 出口：spec-review 打回代数 ≥ 阈值的 root 子树
    // unit 转人工（computeDispatchTargets 同口径不派）。事实来自账本重放
    //（specReviewFailCounts——mx-3 起按打回代数计数，重提不清零），人工 pass
    // verdict 写入后 unit 离开 created 态、投影自然消失；出声按消息文本签名去重
    const specFails = specReviewFailCounts(events);
    for (const [unitId, failCount] of specFails) {
      if (!subtreeIds.has(unitId) || failCount < SPEC_REVIEW_DEADLOCK_FAILS) {
        continue;
      }
      const message = specDeadlockEscalationMessage(
        opts.rootId,
        unitId,
        specReviewFailComments(events, unitId),
      );
      if (announcedDeadlock.get(unitId) !== message) {
        announcedDeadlock.set(unitId, message);
        emitErr(message);
      }
    }

    // mx-1 S7 抢答可见性（mx-3 豁免收紧）：本 run 期间新入账的 spec-review
    // verdict，若其入账时刻不落在该 unit 任何 reviewer flight 的存活窗口内、且非
    // fail 打回流转（fail 有 specFixPending 收敛出口）→ stderr 一行警告（不阻断
    // 不入账）。verdict 的入账 ts 取自原始事件流（fold 投影不含 ts），与本进程的
    // 窗口时刻同机同钟可比
    // verdict 的入账 ts 取自原始事件流（fold 投影不含 ts），与本进程的
    // 窗口时刻同机同钟可比
    const verdictTsBySeq = specVerdictTsBySeq(events);
    for (const unit of subtreeUnits(projection, opts.rootId)) {
      const watermark = seenSpecVerdictSeq.get(unit.unitId) ?? 0;
      let latestSeq = watermark;
      const newSpecVerdictSeqs: number[] = [];
      for (let i = 0; i < unit.verdicts.length; i += 1) {
        const verdict = unit.verdicts[i];
        const seq = unit.verdictSeqs[i] ?? 0;
        if (verdict?.verdictKind === "spec-review" && seq > watermark) {
          newSpecVerdictSeqs.push(seq);
          latestSeq = Math.max(latestSeq, seq);
        }
      }
      if (newSpecVerdictSeqs.length === 0) {
        continue;
      }
      seenSpecVerdictSeq.set(unit.unitId, latestSeq);
      const windows = reviewerFlightWindows.get(unit.unitId) ?? [];
      const inReviewerWindow = (seq: number): boolean => {
        const ts = verdictTsBySeq.get(seq);
        if (ts === undefined) {
          return false; // ts 不可解析的 verdict 保守告警（可见性优先）
        }
        return windows.some(
          (w) => ts >= w.spawnedAt && (w.settledAt === null || ts <= w.settledAt),
        );
      };
      const failRecoveryFlow =
        unitStatus(unit) === "created" &&
        unit.specs.length > 0 &&
        latestSpecReviewAfterLastSpec(unit) === "fail";
      if (!newSpecVerdictSeqs.every(inReviewerWindow) && !failRecoveryFlow) {
        emitErr(prematureVerdictWarningLine(unit.unitId));
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
      specFails,
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
      } else if (target.dimension === "specReviewPending") {
        // mx-1：spec-review 独立 reviewer 派发的可观测性（信任链关键跳变）
        emit([
          `[runner] unit "${target.unitId}" 的 spec 待审——派独立 reviewer 执行 spec-review（designer 不自审）`,
        ]);
      } else if (target.dimension === "specFixPending") {
        // mx-1 MF1：fail 打回后的修复出口（brief 内嵌 fail comment 全文）
        emit([
          `[runner] unit "${target.unitId}" 的 spec-review fail——派 designer 按打回意见修 spec 重提（重提后由 reviewer 再审）`,
        ]);
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
      // mx-1 S3：reviewer role 注入异源模型（复用 pi 的 CW_AGENT_MODEL → --model
      // 翻译链，req.env 级；未配置时不注入——reviewer 与 builder 同模型链）。
      // mx-3 S7：reviewer flight 的存活窗口登记（抢答豁免收紧后，豁免只认
      // 「verdict 入账时刻 reviewer 在场」——本窗口是唯一豁免依据）
      let reviewerWindow: ReviewerFlightWindow | undefined;
      if (target.role === "reviewer") {
        reviewerWindow = { spawnedAt: Date.now(), settledAt: null };
        const windows = reviewerFlightWindows.get(target.unitId) ?? [];
        windows.push(reviewerWindow);
        reviewerFlightWindows.set(target.unitId, windows);
      }
      const handle = await opts.adapter.spawn({
        role: target.role,
        unitId: target.unitId,
        workdir: wtDir,
        projectCwd: opts.cwd,
        artifactDir: artifactsDir,
        briefPath,
        ...(target.role === "reviewer" && reviewerModel !== undefined
          ? { env: { CW_AGENT_MODEL: reviewerModel } }
          : {}),
        timeoutMs: AGENT_SPAWN_TIMEOUT_MS,
      });
      inFlight.push({ role: target.role, unitId: target.unitId, handle, reviewerWindow });
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
      // mx-3 S7：reviewer flight 结算时刻封窗（此后到达的 verdict 属「晚到提交」，
      // 抢答检查按窗口判定会告警）
      if (finished.flight.reviewerWindow !== undefined) {
        finished.flight.reviewerWindow.settledAt = Date.now();
      }
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

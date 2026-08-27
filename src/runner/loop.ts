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
 * developer 重派同待遇）。
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
 *   - created 且账本内 spec-review 打回代数 ≥ 阈值（默认 10，mx-4 放宽；cw run
 *     --max-spec-rejects 可注入更紧运行策略值——只影响本循环，只读命令恒用默认）
 *     （mx-1 specReviewDeadlock；mx-3 起按代数计数——同条 SpecSubmitted 后多条
 *     fail 只计 1 代，MF2 教训由代数累计保持：重提不清零）→ 不派任何 agent（打回
 *     循环活锁对机器无解），stderr 转人工 escalation（各代打回意见摘要 + 人工处置
 *     动作）；复用 fx-2 上限出口的审计-不喂-idle 模式，人工 pass verdict 后投影
 *     自然消失
 *   - 派发 gate（mx-1 S1）：同 unit 存在任意 role 的 in-flight spawn 时本轮缓派
 *     该 unit 的全部新派发（reviewer 派发的 worktree reset 会清在飞 designer 的
 *     现场；同时修复既有 designer→developer 转换竞态）。等待窗口 ≤ 一个 poll 周期
 *     （in-flight spawn 必然 wait() 结算或 TIMEOUT，无死等路径）
 *   - spec-frozen 内部节点（split 非空且不含自身）且 split 声明的子有未 created
 *     者 → designer（fx-3 R5.3 派发兜底：补建子任务书——处理 R5.1 gate 生效前
 *     的历史账本/旁路数据；先于集成等待分支拦截，子不齐不集成）
 *   - spec-frozen 叶子（split 空）且（无子 ∨ 子全部 closed）→ developer agent
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
 *     → 不派任何 agent（developer 打回循环对随机挂无解），stderr 转人工判定指引
 *     （列出连挂用例 id 与逐次 fail 的 runId；处置 = 修稳定性 / 声明
 *     nondeterministic 重提 spec / 修真 bug）。复用 fx-2 上限出口的审计-不喂
 *     -idle 模式：停派后无新 VerifyRan，若树内无其他目标由 maxIdleMs 收束；
 *     人工处置写入账本后投影自然消失，运行中的循环下轮自愈。连挂输入排除
 *     解析失败条目（mx5-2：解析失败走 specContractBroken 回炉，不再误判 flake）
 *   - spec-frozen 且当前 spec 周期内某验收带确定性缺陷信号（解析失败 ∪ 无区分力，
 *     fa-3 D3）连挂 ≥2 ∧ 回炉代数 <2（specContractBroken，mx5-2）→ designer 回炉
 *     修 spec 的验收命令契约（任务书内嵌当前周期逐轮机器原文 + 规则⑨式恢复指引；新 spec 照旧
 *     过独立 reviewer 再审——回炉不建新信任机制）。回炉代数 =「连挂 ≥2 → 新
 *     SpecSubmitted」累计次数，新 spec 只清连挂计数不清代数
 *   - spec-frozen 且确定性缺陷信号连挂 ≥2 ∧ 回炉代数 ≥2（specContractDeadlock，
 *     mx5-2）→ 不派任何 agent（两轮修复均经 verify 检验仍失败，判 spec/brief
 *     层更深问题），stderr 转人工（含 2 代回炉事实与恢复指引）；复用审计-不喂
 *     -idle 模式，人工处置（新 spec 过审 / 人工关闭）写入账本后投影自然消失
 *   - spec-frozen 且当前 spec 周期内 build 证据 ≥K（默认 5，--max-build-attempts
 *     可注入）且无 pass verify（buildDrift，lv-2）→ 不派任何 agent（缓慢进展：
 *     每轮有产出但期望完成时间发散，布尔进展判定失明），stderr 转人工（三选一：
 *     人工接手 / 拆 unit / 调大 K 续跑）；复用审计-不喂-idle 模式（停派后无新
 *     developer spawn 即无新 build 证据，空转由 maxIdleMs 收束；账本态跨 run
 *     持久——Ctrl-C 重跑计数不丢；--max-build-attempts 调大重跑即续，无账本副作用）
 *   - verified 且未 closed   → reviewer（exec-review；任务书含 rv-2 必填的
 *     --evidence-refs 与 mx-1 的 --role reviewer 自报）
 *
 * 抢答可见性（mx-1 S7；mx-3 豁免收紧）：本 run 期间新入账的 spec-review
 * VerdictSubmitted，若其入账时刻不在该 unit 任何 reviewer flight 的存活窗口
 * （spawn→结算）内、且非 specFixPending 流转 → stderr 一行警告（不阻断不入账
 * ——role 自报可伪造，结构隔离之外的唯一可见性增强）。原「本 run 派发过该
 * unit 的 reviewer 即永久豁免」已废除（M4 gate §5.1 的绕过正是被它吞掉警告）；
 * 正常 reviewer spawn 内的提交豁免不误报，晚到提交 / developer in-flight 期间的
 * 自审提交告警。
 *
 * 异源模型链（mx-1 S3，pi.ts 零改动）：RunLoopOptions.reviewerModel（cw run
 * --reviewer-model）> 进程环境 CW_REVIEWER_MODEL > 不注入（reviewer spawn 回落
 * developer 同款模型链）。注入点 = reviewer role 的 spawn req.env.CW_AGENT_MODEL，
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

import { fold } from "../core/fold.js";
import type {
  LedgerEvent,
  SequencedProjection,
  SequencedUnitProjection,
  VerifyRanPayload,
} from "../events/types.js";
import {
  BUILD_DRIFT_MAX_ATTEMPTS,
  buildDriftFacts,
  computeFrontier,
  consecutiveIntegrationFails,
  type FrontierGroups,
  INTEGRATION_MAX_CONSECUTIVE_FAILS,
  latestSpecReviewAfterLastSpec,
  reflectionDone,
  SPEC_CONTRACT_MAX_GENERATIONS,
  SPEC_REVIEW_DEADLOCK_FAILS,
  type SpecContractFacts,
  specReviewFailComments,
  specVerdictTsBySeq,
  splitChildrenNotCreated,
  splitOf,
  splitSelfReferences,
  stoppedDispatchState,
  subtreeUnits,
  unitEventHighWaterSeqs,
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
import {
  announceManualEscalations,
  escalationExitMessage,
  escalationMessage,
} from "./escalations.js";
import { runIntegrationVerify } from "./integrate.js";
import { acquireRunnerLock, type RunnerLock } from "./lock.js";
import type {
  AgentRole,
  AgentSpawnAdapter,
  InteractiveSpawnHandle,
  SpawnHandle,
  SpawnResult,
} from "./spawn/types.js";
import { isInteractiveSpawnHandle } from "./spawn/types.js";
import {
  ensureUnitWorktree,
  listUnitBranchRefs,
  listUnitWorktreeIds,
  reclaimUnit,
  removeWorktree,
  unitBranchName,
  type UnitBranchRef,
} from "./worktree.js";

/** 账本轮询间隔默认值（--poll-ms；验收文档：默认 1000） */
export const DEFAULT_LOOP_POLL_MS = 1_000;
/** 无账本进展上限默认值（--max-idle-ms；验收文档：默认 30min） */
export const DEFAULT_LOOP_MAX_IDLE_MS = 1_800_000;
/** 同批 in-flight spawn 上限默认值（--max-concurrency；验收文档：默认 3） */
export const DEFAULT_LOOP_MAX_CONCURRENCY = 3;
/** 单次 agent spawn 超时（验收文档循环逻辑 3：timeoutMs 固定 30min）。
 * fx-6 F1 起 escalations.ts 的转人工指引文案共用本常量（spawn 上限事实单一出处），
 * 故 export。 */
export const AGENT_SPAWN_TIMEOUT_MS = 1_800_000;
/**
 * 同一 unit 连续 spawn TIMEOUT 的转人工阈值（连续 2 次）：期间无任何该 unit 的
 * 账本进展即累计；该 unit 一旦出现新账本事件（agent 被超时 kill 前已有产出）
 * 计数清零。计数是单进程内存态——TIMEOUT 是 spawn 失败不入账本，跨进程累计
 * 物理不可得（Ctrl-C 重跑后从 0 重新计，属可接受损失：封顶防的是单次运行内
 * 的无限重派烧 token）。转人工 = 不再派发（canon：不自动换模型，防静默降级）。
 * fx-6 F1 起 escalations.ts 的转人工指引文案共用本常量，故 export。
 */
export const AGENT_TIMEOUT_ESCALATION_AFTER = 2;

/** 单步 git 操作超时（与 integrate.ts 同口径：本地操作毫秒级，上限防挂死） */
const GIT_STEP_TIMEOUT_MS = 120_000;
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
  /**
   * u-i2-a（design-hi-cw-runner-extension §3.2 R2）：进度事件发射器——库形态
   * 消费者（pi extension）的 widget/notify/对账数据源。加法可选项：CLI 壳
   * （handlers/run.ts）不传 = 行为不变（硬约束）。回调抛错由循环吞掉不炸主循环
   * （stderr 记录）——发射器是观测面不是信任边界。cw 核心不知道 pi 存在（G4），
   * 事件表最小集：每条对应一个 UI 消费点，无消费点的不发。
   */
  onEvent?: (ev: LoopEvent) => void;
  pollMs?: number;
  maxIdleMs?: number;
  maxConcurrency?: number;
  /**
   * reviewer spawn 的异源模型（mx-1 S3，可选项——未配置时回落 developer 同款模型链，
   * 结构隔离不依赖模型异源）。CLI 来源 = --reviewer-model flag（优先）或进程环境
   * CW_REVIEWER_MODEL；注入点 = reviewer role 的 spawn req.env.CW_AGENT_MODEL
   * （复用 pi 适配器 resolvePiModel 既有四级链，pi.ts 零改动）。
   */
  reviewerModel?: string;
  /**
   * spec 打回代数的转人工预算（mx-4，可选项——缺省回落 frontier.ts 的
   * SPEC_REVIEW_DEADLOCK_FAILS 默认 10）。只影响本循环的 specReviewDeadlock
   * 判定与 escalation 出声；只读命令（frontier/status）恒用默认值——转人工预算
   * 是运行策略，默认值是投影展示语义。CLI 来源 = cw run --max-spec-rejects。
   */
  maxSpecRejects?: number;
  /**
   * buildDrift 的停派预算 K（lv-2，可选项——缺省回落 frontier.ts 的
   * BUILD_DRIFT_MAX_ATTEMPTS 默认 5）。只影响本循环的 buildDrift 判定与
   * escalation 出声；只读命令（frontier/status）恒用默认值——停派预算是运行
   * 策略，默认值是投影展示语义。CLI 来源 = cw run --max-build-attempts。
   */
  maxBuildAttempts?: number;
  /**
   * 单次 agent spawn 超时上限（lv-2，可选项——缺省回落本文件 AGENT_SPAWN_TIMEOUT_MS
   * 默认 30min）。只改超时上限不改任何判定语义。CLI 来源 = cw run
   * --spawn-timeout-ms flag（优先）或进程环境 CW_SPAWN_TIMEOUT_MS（handleRun
   * 层合流后传入）。
   */
  spawnTimeoutMs?: number;
  /**
   * u-i1-d（R5）：跨进程派发锁的显式接管通道（cw run --force-dispatch）。true 时
   * 跳过锁持有进程的存活检查强制覆盖；缺省 false（活锁拒启）。锁不入账本
   * （易失进程态非事实，总纲 D8 裁决）。
   */
  forceDispatch?: boolean;
  /**
   * P0-1（extension 编程停止通道）：库形态消费者（pi extension 跑在宿主进程内，
   * 不允许被 runner 杀死）的编程停止入口。runLoop 初始化（锁获取之前）调用它，
   * 把循环自身的停止函数交付出去；消费者调用该函数 = 与 SIGINT/SIGTERM handler
   * 同一套收尾（提示行 + killAll + 锁释放），但主 promise 以约定码（130）resolve
   * 而非 process.exit。传入本选项时真实 SIGINT/SIGTERM 也走同一收尾并以约定码
   * resolve（不 exit）。CLI 壳不传 = 行为完全不变（信号路径照旧 process.exit）。
   */
  onStopRequest?: (stop: () => void) => void;
}

/**
 * u-i2-a（R2 最小集）：runLoop 的进度事件表——库形态消费者的结构化数据源。
 * round = 每轮 frontier 重算摘要（widget）；dispatch/settled = spawn 生命周期
 * （面板对账）；stopped = 停派转人工命中（notify/收件箱）；reflection = 反思
 * followUp 已发（七问轮次可见）；error = 循环内非致命错误路径的出声镜像。
 */
export type LoopEvent =
  /** 轮次开始（frontier 维度 → 该维度 unit 数；维度语义单一出处 = frontier.ts） */
  | { kind: "round"; seq: number; frontierSummary: Record<string, number> }
  /** 派发成功入 in-flight（subagentSlug = `${unitId}-${role}`，面板对账锚） */
  | { kind: "dispatch"; unitId: string; role: AgentRole; subagentSlug: string }
  /** spawn 结算（四态退出码原样透传） */
  | { kind: "settled"; unitId: string; role: AgentRole; result: SpawnResult }
  /** 停派转人工命中（五类停派维度之一；每 unit×维度只发一次） */
  | { kind: "stopped"; unitId: string; dimension: string; reason: string }
  /** 反思轮次已发（followUp 链挂接或占位 ReflectionRan 代写） */
  | { kind: "reflection"; unitId: string; round: number }
  /** 非致命错误路径（出声 + 跳过本轮，循环继续） */
  | { kind: "error"; stage: string; message: string };

/** stopped 事件的维度集（停派五类中的四类投影维度；TIMEOUT 封顶走 loop 内判定） */
const STOPPED_DISPATCH_DIMENSIONS = [
  "specReviewDeadlock",
  "flakeReview",
  "specContractDeadlock",
  "buildDrift",
] as const;

/** stopped 事件的 reason 文案（短句；完整恢复指引在 stderr 转人工消息里） */
const STOPPED_REASONS: Record<(typeof STOPPED_DISPATCH_DIMENSIONS)[number], string> = {
  specReviewDeadlock: "spec-review 打回代数达预算（designer-reviewer 活锁），停派转人工",
  flakeReview: "e2e 验收连挂 ≥2（flake 疑似），停派 developer 转人工判定",
  specContractDeadlock: "确定性 spec 缺陷信号 2 代回炉仍连挂，停派转人工",
  buildDrift: "build 证据达预算无 pass verify（缓慢进展），停派转人工",
};

/** round 事件的 frontier 摘要（维度 → 该维度 unit 数；仅本 root 子树外的也不排除——全账本口径与 `cw frontier` 一致） */
function summarizeFrontier(groups: FrontierGroups): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const key of Object.keys(groups) as Array<keyof FrontierGroups>) {
    summary[key] = groups[key].length;
  }
  return summary;
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
   * u8（canon D6）：内部节点（spec.split 非空）的 developer 不派 agent，由循环直接
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

/** fx-6 F1 起 escalations.ts 的转人工出声共用本函数（stderr 单一出口），故 export */
export function emitErr(message: string): void {
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

/** frontier 维度 → 派发形态（role 与集成直跑标记）。维度语义单一出处 = readonly/frontier.ts。
 * specReviewDeadlock / flakeReview / specContractDeadlock / buildDrift 无条目
 * （mx-1 / rv-5 / mx5-2 / lv-2）：四者都是转人工维度——不派任何 agent（打回
 * 活锁 / 随机挂 / 回炉活锁 / 缓慢进展对机器无解），转人工指引由 runLoopMain 的
 * specDeadlockEscalationMessage / flakeEscalationMessage /
 * specContractDeadlockEscalationMessage / buildDriftEscalationMessage 出声。
 * lv-3 回收完整 Record：buildDrift 已入 DispatchDimension 的 Exclude 清单
 * （brief.ts——四处停派维度单一事实源），computeDispatchTargets 的派发排除
 * 黑名单先 continue 封死停派维度的到表路径，本表对 DispatchDimension 必然满射
 * ——lv-2 的 Partial 化与 shape === undefined 防御分支随之退役（类型即证明）。
 * mx-1：specReviewPending（spec 审）与 execReviewReady（执行审）都派 reviewer，
 * 但任务书形态不同（renderBrief 按 dimension 区分）。mx5-2：specContractBroken
 * 复用 specFixPending 的 designer 派发形态（修 spec 重提），任务书是独立的回炉
 * 模板（内嵌确定性缺陷信号机器原文，非 reviewer comment）。ph-i1 R4：reflectionPending
 * 派 designer——派发后 loop 对句柄探测 followUp 能力并走反思链（见
 * startReflectionFollowUp），完成后 loop 自己写 ReflectionRan 再派 reviewer。 */
const DISPATCH_SHAPE: Record<
  DispatchDimension,
  { role: AgentRole; integration: boolean }
> = {
  specReady: { role: "designer", integration: false },
  reflectionPending: { role: "designer", integration: false },
  specReviewPending: { role: "reviewer", integration: false },
  specFixPending: { role: "designer", integration: false },
  specContractBroken: { role: "designer", integration: false },
  missingChildren: { role: "designer", integration: false },
  integrationDrift: { role: "designer", integration: false },
  integrationReady: { role: "developer", integration: true },
  buildReady: { role: "developer", integration: false },
  execReviewReady: { role: "reviewer", integration: false },
};

/**
 * 连续 TIMEOUT 计数的进展清零 + 转人工判定（runLoopMain 每轮派发计算之前调用）。
 * 清零先于判定：被超时 kill 的 agent 若死前已写账本，本轮先清零——不冤枉有产出
 * 的 agent；清零后仍达阈值的才转人工（本轮派发计算即排除）。顺序不能反：先判定
 * 后清零会把「有产出的第二次 TIMEOUT」也误转人工。返回最新水位（调用侧回写）。
 */
function settleTimeoutEscalations(
  events: readonly LedgerEvent[],
  timeoutStreaks: Map<string, TimeoutStreak>,
  lastUnitSeqs: Map<string, number>,
  escalated: Map<string, AgentRole>,
  rootId: string,
  artifactDir: string,
  spawnTimeoutMs: number,
  onStopped?: (unitId: string, role: AgentRole) => void,
): Map<string, number> {
  const unitSeqs = unitEventHighWaterSeqs(events);
  for (const [unitId, seq] of unitSeqs) {
    if (seq > (lastUnitSeqs.get(unitId) ?? 0)) {
      timeoutStreaks.delete(unitId);
    }
  }
  for (const [unitId, streak] of timeoutStreaks) {
    if (streak.count >= AGENT_TIMEOUT_ESCALATION_AFTER && !escalated.has(unitId)) {
      escalated.set(unitId, streak.role);
      // lv-2：文案第 3 条显示本循环实际的 spawn 超时值与调大入口
      emitErr(escalationMessage(rootId, unitId, streak.role, artifactDir, spawnTimeoutMs));
      // u-i2-a：停派五类的 TIMEOUT 封顶档（单进程内存态，无投影维度）——onEvent 出声
      onStopped?.(unitId, streak.role);
    }
  }
  return unitSeqs;
}

/**
 * brief 落盘（lv-3 起带审查上下文取数）：specReviewPending 形态注入历代打回
 * 意见——历史重建需原始事件流（投影无跨类型顺序），loop 侧用
 * specReviewFailComments 算好传入，渲染层保持纯函数；其他形态不注入
 * （writeBriefFile 的可选参透传，无该段渲染）
 */
function writeBriefWithHistory(
  artifactDir: string,
  target: DispatchTarget,
  unit: SequencedUnitProjection,
  projection: SequencedProjection,
  rootId: string,
  projectCwd: string,
  workdir: string,
  events: readonly LedgerEvent[],
): string {
  return writeBriefFile(
    artifactDir,
    target,
    unit,
    projection,
    rootId,
    projectCwd,
    workdir,
    target.dimension === "specReviewPending"
      ? specReviewFailComments(events, target.unitId)
      : undefined,
  );
}

/**
 * 派发对象集合：消费 readonly/frontier.ts 的 computeFrontier（与 `cw frontier`
 * 命令同一就绪判定，A4「零上下文接手」场景输出与真实派发一致），限定 root
 * 子树、按 BFS 序展开为 (role, unitId, dimension, integration)。派发 gate
 * （mx-1 S1）：同 unit 存在任意 role 的 in-flight spawn 时本轮缓派该 unit 的
 * 全部新角色——reviewer 派发前的 worktree reset 会清在飞 designer 的现场，
 * 同理修复既有 designer→developer 转换竞态；等待窗口 ≤ 一个 poll 周期。
 * excluded = 转人工 unit（连续 TIMEOUT 封顶后不再派发）。specReviewDeadlock /
 * flakeReview / specContractDeadlock / buildDrift 维度同样不派发——转人工指引
 * 由 runLoopMain 出声，此处只负责不进 targets。spec-frozen 自引用的 stderr
 * 警告保持每轮可见——判定半边在共享函数（按叶子语义入组），此处只保留可观测
 * 性半边（fx-1 R1 loop 级防御）。
 */
function computeDispatchTargets(
  groups: FrontierGroups,
  projection: SequencedProjection,
  rootId: string,
  inFlight: readonly InFlightSpawn[],
  excluded: ReadonlySet<string>,
): DispatchTarget[] {
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
      dimension === "reflectionPending" ||
      dimension === "flakeReview" ||
      dimension === "specReviewDeadlock" ||
      dimension === "specContractDeadlock" ||
      dimension === "buildDrift"
    ) {
      // 转人工维度（rv-5 flake / mx-1 spec 打回活锁 / mx5-2 回炉活锁 / lv-2
      // 缓慢进展）——不派任何 agent，停摆等人工处置后投影自然消失。
      // ph-i1 R4：reflectionPending 也不进派发表——反思由 runLoopMain 的反思接缝
      // 处理（对在飞长驻句柄 followUp，无在飞则代写占位 ReflectionRan），不派新 spawn
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
 * unit 停在 spec-frozen，下轮重算自然重派集成（与 developer 重派同待遇）。
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

/**
 * fb-2（M7 设计 D9，观察 C10）：停派维度命中的 unit 在飞 spawn 回收——killAll
 * 的 per-unit 过滤版（按 InFlightSpawn.unitId 匹配，全 role），尽力回收语义
 * 逐行照抄 killAll：try/catch 单失败记录后继续，不炸循环（kill 目标常为「已
 * 自然退出但 race 未结算」的 flight，macOS 对已退出进程组返回 EPERM 而非 ESRCH
 * 的既有事实见 killAll 注释）。为什么必须回收在飞本体：停派维度在
 * computeDispatchTargets 只挡新派发（continue），在飞 designer 迟交的
 * SpecSubmitted 会顶掉人工重提的 spec（C10 主案例）——入账层守卫（fb-1）管
 * verdict 管不到 SpecSubmitted，竞态口只能在循环层堵。
 *
 * 出声时序（设计检查点③的定夺，两处一致）：调用点固定在转人工指引出声
 * （announceManualEscalations / settleTimeoutEscalations 的 escalationMessage）
 * 与 stopped 事件发射之后——stderr 上人工先看到指引、随后看到回收记录；回收
 * 行自身只带维度短名 + C10 原因短句，完整恢复指引不在本行重复（指引已出）。
 *
 * 去重键 = unitId、粒度 = 停派 episode（设计 D9 只钉死「停派维度命中时回收
 * 该 unit 在飞 spawn」，未钉死去重粒度；episode 是实施层选择，理由在此记
 * 档）：连续停派轮次 = 一个接管 episode（Set 去重防对同一已 kill / 已结算的
 * flight 空转刷屏）；离开本轮停派命中集（四维 + timeoutEscalation 全集，
 * 即 stoppedUnitDimension）= 自愈完成、登记清出——同 run 内二次停派命中 =
 * 新接管现场（新 spawn 可能已派发），必须重新回收，否则 C10 竞态口二次重开
 * （人工第二轮处置同样会被迟交产出顶掉）。仍处 escalated 而本轮无四维命中
 * 的 unit 留在命中集内（接管未结束，保持已回收态不清）；其余残余面——
 * 回收与人工处置入账几乎同轮时新 spawn 尚未派发，只能等下轮命中再回收
 * （人工在场，maxIdleMs / SPAWN_ERROR 出口兜底）。
 *
 * reflectionPending 不在回收范围（反思接缝对在飞句柄 followUp 是合法等待态，
 * 非转人工）——由调用侧的维度枚举（STOPPED_DISPATCH_DIMENSIONS + escalated）
 * 结构性保证。
 */
function recallStoppedUnitSpawns(
  inFlight: readonly InFlightSpawn[],
  stoppedUnitDimension: ReadonlyMap<string, string>,
  recalled: Set<string>,
): void {
  // episode 收尾：离开本轮停派命中集的登记一并清出（自愈完成）——下一次
  // 再命中 = 新接管现场，重新回收。escalated（timeoutEscalation）档已由调用
  // 侧并入 stoppedUnitDimension（四维 + escalated 全集基准），仍处 escalated
  // 的 unit 不会在此被清（接管未结束，保持已回收态）。Set 迭代中删除当前
  // 元素安全（ES 规范：已访问元素的删除不影响迭代）
  for (const unitId of recalled) {
    if (!stoppedUnitDimension.has(unitId)) {
      recalled.delete(unitId);
    }
  }
  for (const [unitId, dimension] of stoppedUnitDimension) {
    if (recalled.has(unitId)) {
      continue; // 本 episode 已回收过——连续停派轮次内去重（见函数头注释）
    }
    recalled.add(unitId);
    for (const flight of inFlight) {
      if (flight.unitId !== unitId) {
        continue;
      }
      try {
        flight.handle.kill();
        emitErr(
          `[runner] 停派转人工（${dimension}）：回收 unit "${unitId}" 的在飞 ${flight.role} spawn` +
            "——停派只挡新派发，在飞产出迟交会顶掉人工处置（C10）；人工处置见上方指引，处置入账后下轮自愈。\n",
        );
      } catch (err) {
        process.stderr.write(
          `[runner] 停派回收 kill 失败（${flight.role} unit "${unitId}"，维度 ${dimension}）：` +
            `${err instanceof Error ? err.message : String(err)}——目标进程多半已退出，忽略。\n`,
        );
      }
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
 * designer × spec-frozen 派发出口的可观测性出声（fx-7 从 runLoopMain 抽出，行为
 * 零变更——判定序与 computeFrontier 单组归属同步：mx5-2 契约回炉 → fx-3 R5.3
 * 兜底（split 子未建）→ fx-2 R4a 上限（集成连续 fail），终验日志里明确「为何派
 * designer」）。
 */
function emitSpecFrozenDesignerRationale(
  target: DispatchTarget,
  unit: SequencedUnitProjection,
  projection: SequencedProjection,
  contractFacts: ReadonlyMap<string, SpecContractFacts>,
): void {
  if (target.dimension === "specContractBroken") {
    const fact = contractFacts.get(target.unitId);
    emit([
      // fa-3 双信号口径（D-1 同款第四处）：解析失败 / 无区分力同座触发本维度，
      // 信号名不得只报其一；逐轮原文分流取数见 brief.ts contractFailFactsOf
      `[runner] unit "${target.unitId}" 的确定性 spec 缺陷信号连挂 ≥2（条目 ` +
        `${fact?.streaks.map((s) => s.acceptanceId).join("、") ?? "（未知）"}；spec 契约回炉，` +
        `代数 ${fact?.generations ?? 0}/${SPEC_CONTRACT_MAX_GENERATIONS}）` +
        "——转派 designer 修 spec 的验收命令契约（逐轮信号原文见 brief）",
    ]);
    return;
  }
  const missingChildren = splitChildrenNotCreated(projection, unit);
  if (missingChildren.length > 0) {
    emit([
      `[runner] unit "${target.unitId}" 的 spec 声明了 ${splitOf(unit).length} 个子 unit 但 ${missingChildren.length} 个未创建` +
        `（${missingChildren.join("、")}）——派 designer 补建子（子不齐不集成）`,
    ]);
    return;
  }
  emit([
    `[runner] unit "${target.unitId}" 集成连续 fail 达上限（${INTEGRATION_MAX_CONSECUTIVE_FAILS} 次）` +
      "——停止自动重派集成，转派 designer 处置契约漂移（处置路径见 brief）",
  ]);
}

/**
 * P0-1（extension 编程停止通道）：库形态停止状态。onStopRequest 在场时，
 * SIGINT/SIGTERM 与编程停止都不 process.exit（宿主进程不允许被 runner 杀死），
 * 而是置位 state（主循环每轮 poll 顶部检查后以约定码返回）+ settle 兑现
 * （runLoop 以 Promise.race 先到先得，停止先到即返回约定码）。
 */
interface LoopStopChannel {
  state: { requested: boolean; code: number };
  settle: (code: number) => void;
}

/**
 * 信号/编程停止的共用收尾三步（顺序与 rv-1 验收锁定一致）：提示行 writeSync →
 * best-effort killAll → 锁释放。退出方式（process.exit vs resolve）由调用点分支。
 */
function loopStopCleanup(
  rootId: string,
  inFlight: readonly InFlightSpawn[],
  releaseLock: (() => void) | undefined,
  label: string,
  exitCode: number,
): void {
  try {
    writeSync(
      process.stderr.fd,
      `[runner] 收到 ${label}：回收 ${inFlight.length} 个在飞派发后以 exit ${exitCode} 退出。` +
        `账本即状态——重跑 cw run --root ${rootId} 即续。\n`,
    );
  } catch (err) {
    // writeSync 失败（fd 异常等）不能阻断回收——回收与退出码是承诺；降级为常规
    // 异步 write 再试一次（尽力而为，即使 exit 时被队列丢弃也不影响回收路径）
    process.stderr.write(
      `[runner] 收到 ${label}（提示行 writeSync 失败：${err instanceof Error ? err.message : String(err)}）：` +
        `回收 ${inFlight.length} 个在飞派发后以 exit ${exitCode} 退出。\n`,
    );
  }
  killAll(inFlight);
  releaseLock?.(); // u-i1-d R5：信号退出同样释放派发锁（unlink）
}

/**
 * runLoop 的信号 handler（SIGINT/SIGTERM 共用，rv-1）：Ctrl-C/SIGTERM 后 agent
 * 子进程会成孤儿继续写账本，用户重跑 `cw run` 对同一 worktree reset + 二次 spawn
 * 就是双 agent 混卷——所以 runner 必须主动回收全部在飞 spawn 再退出，「重跑即续」
 * 对进程维度也成立。只做回收：不写任何账本事件、不动 worktree/分支（回收 worktree
 * 是既有延迟回收逻辑的事，信号路径不额外触发 reclaim）。
 *
 * P0-1 起带 stop 通道（onStopRequest 在场）：收尾后不 process.exit，改置位 +
 * settle（宿主进程存活，主 promise 以约定码 resolve）。stop 缺席 = 行为零变更。
 */
function makeLoopSignalHandler(
  rootId: string,
  inFlight: readonly InFlightSpawn[],
  releaseLock?: () => void,
  stop?: LoopStopChannel,
): (signal: NodeJS.Signals) => void {
  return (signal) => {
    const exitCode = signal === "SIGINT" ? LOOP_SIGNAL_EXIT_CODES.SIGINT : LOOP_SIGNAL_EXIT_CODES.SIGTERM;
    loopStopCleanup(rootId, inFlight, releaseLock, signal, exitCode);
    if (stop !== undefined) {
      stop.state.requested = true;
      stop.state.code = exitCode;
      stop.settle(exitCode);
      return;
    }
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
  let branchRefs: UnitBranchRef[];
  try {
    branchRefs = listUnitBranchRefs(cwd);
  } catch (err) {
    // fx-7：ref 扫描命令级失败 ≠ 无分支——出声后按「跳过分支侧、目录侧继续」保守
    // 降级（不误删、不阻塞 run 启动），孤儿分支由扫描恢复后的下次 run 再扫再收
    emitErr(
      "[runner] 启动清扫的分支扫描失败，本次跳过分支侧（目录侧继续）：" +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    branchRefs = [];
  }
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

// ---- ph-i1 R4：反思 followUp 派发（占位形态，TODO(ph-i2) 接四流程七问） ----

/**
 * 反思 followUp 的注入文案（占位）。反思问题集（四流程七问）属 ph-2 领地，本波次
 * 只打通「长驻句柄 followUp → ReflectionRan 入账」链路。
 */
const REFLECTION_PLACEHOLDER_PROMPT = [
  "## 反思（reflection，占位提示）",
  "请基于你刚完成的 spec 撰写过程做简短反思：哪些假设未验证、验收是否有真空、拆分是否合理。",
  "如有修订需要，按原流程重提 spec；无需修订则简述结论即可。",
  "（TODO(ph-i2)：本提示为占位文案，四流程七问接入后替换。）",
].join("\n");

/** 反思完成日志里 specHash 的展示前缀长度（非语义，仅日志可读性） */
const SPEC_HASH_PREVIEW_LEN = 8;

/**
 * 反思链（R4/R3 §3.1 正常时序的后半段）：对 reflectionPending unit 的在飞长驻句柄
 * （调用方已 isInteractiveSpawnHandle 探测）——等 brief 阶段流式结束 → followUp 反思
 * 文案 → 等 agent_settled → 经 events-log 文件锁短事务写 ReflectionRan（round =
 * 派发时刻投影的 reflections 长度 + 1，sessionFile 取握手锚）→ done() 优雅收尾
 * （进程退出，flight 正常结算）。后台异步执行不阻塞主循环；链上任一步失败 →
 * kill + stderr 出声（结算视适配器实现为 TIMEOUT/CRASH，均属可重派态，不静默）。
 */
function startReflectionFollowUp(
  cwd: string,
  rootId: string,
  unitId: string,
  handle: SpawnHandle,
  specHash: string,
  round: number,
  timeoutMs: number,
): void {
  void rootId;
  if (!isInteractiveSpawnHandle(handle)) {
    // 防御：调用方已探测，走到这里说明句柄能力中途消失（不可达分支）——出声不静默
    emitErr(`[runner] unit "${unitId}" 的反思句柄失去交互能力（不可达分支，出声不静默）。\n`);
    handle.kill();
    return;
  }
  const interactive: InteractiveSpawnHandle = handle;
  void (async () => {
    try {
      if (!(await interactive.waitForIdle(timeoutMs))) {
        throw new Error(`brief 阶段 waitForIdle(${timeoutMs}ms) 超时`);
      }
      await interactive.followUp(REFLECTION_PLACEHOLDER_PROMPT);
      if (!(await interactive.waitForIdle(timeoutMs))) {
        throw new Error(`反思 followUp 后 waitForIdle(${timeoutMs}ms) 超时`);
      }
      const anchor = interactive.sessionAnchor;
      new EventLedger(ledgerPath(getCwHome(), cwd)).append("ReflectionRan", {
        unitId,
        specHash,
        round,
        ...(anchor !== undefined && anchor.sessionFile !== ""
          ? { sessionFile: anchor.sessionFile }
          : {}),
      });
      emit([
        `[runner] unit "${unitId}" 反思完成（round ${round}，specHash ${specHash.slice(0, SPEC_HASH_PREVIEW_LEN)}…）` +
          "——ReflectionRan 已入账，下轮派独立 reviewer spec-review",
      ]);
      await interactive.done();
    } catch (err) {
      emitErr(
        `[runner] unit "${unitId}" 的反思 followUp 链失败（已 kill，可重派）：` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
      interactive.kill();
    }
  })();
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

/**
 * spawn 退出的结算描述（D6 文案诚实化，mx5-2）：TIMEOUT 且该 unit 处于停派态
 * （frontier.stoppedDispatchState 的投影判定）时改述真实行为——停派态下「可
 * 重派」承诺不兑现（三跑现场五：flake 停派中的 developer TIMEOUT 结算行写可重派
 * ，死局）。只改文案，超时计数与转人工判定的优先级行为零变更（行为重估列观察
 * 项，见设计 mx-5 D6）。非停派态输出与历史逐字节一致（u7b 锁定）。
 */
function describeExit(exitCode: SpawnResult["exitCode"], stopState: string | null): string {
  if (exitCode === 0) {
    return "exit 0";
  }
  if (exitCode === "SPAWN_ERROR") {
    return "SPAWN_ERROR";
  }
  if (exitCode === "TIMEOUT" && stopState !== null) {
    return (
      `TIMEOUT——该 unit 当前处于 ${stopState} 停派态，本次超时不触发重派；` +
      "恢复动作：按该停派态的转人工指引处理（cw frontier 查看分组），处置写入账本后重跑 cw run 即续"
    );
  }
  const capped =
    exitCode === "TIMEOUT"
      ? `，可重派（连续 ${AGENT_TIMEOUT_ESCALATION_AFTER} 次后转人工）`
      : exitCode === "CRASH"
        ? "，可重派"
        : "";
  return `${String(exitCode)}${capped}`;
}

/** 同一 unit 连续 TIMEOUT 的计数条目（role = 最近一次 TIMEOUT 的派发 role） */
interface TimeoutStreak {
  count: number;
  role: AgentRole;
}


/**
 * 抢答警告行（mx-1 S7；mx-3 豁免收紧）：spec-review verdict 入账时刻，该 unit
 * 无在场的 reviewer spawn（in-flight 或其 spawn 窗口内）且非 specFixPending 流转
 * （fail 的打回修复有 loop 的收敛出口）——唯一可见性增强，不阻断不入账。
 * mx-3 收紧点：原「本 run 派发过该 unit 的 reviewer 即永久豁免」废除（M4 gate
 * §5.1 三因之一——developer 重提 spec 后的自审被该豁免吞掉警告）；正常 reviewer
 * spawn 内的提交（verdict ts 落在该 reviewer flight 的 spawn→结算窗口内）豁免
 * 不误报。
 */
function prematureVerdictWarningLine(unitId: string): string {
  return (
    `[runner] 警告：unit "${unitId}" 出现新的 spec-review verdict，但该 verdict 入账时该 unit 无在场的 ` +
    "reviewer spawn（不在任何 reviewer flight 的存活窗口内）且非 fail 打回流转——疑似非独立 reviewer 提交（designer 自审 / " +
    "developer 越权 / 人工抢答）。role 字段是自报弱声明可伪造；本警告仅审计可见性，不阻断。\n"
  );
}

/**
 * reviewer flight 的存活窗口（mx-3 抢答豁免收紧的判定输入）：spawnedAt = 派发
 * 时刻，settledAt = wait() 结算时刻（null = 仍在飞）。verdict 的入账 ts 落在
 * [spawnedAt, settledAt] 内即视为「reviewer 在场期间提交」——正常 reviewer 流
 * （worker 在 spawn 内写完 verdict 再退出）不误报；reviewer 已结算后的晚到提交、
 * developer in-flight 期间的自审提交（无匹配窗口）都会告警。
 */
interface ReviewerFlightWindow {
  spawnedAt: number;
  settledAt: number | null;
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
      `runLoop: 非法参数 ${name}=${value}：须为正数。恢复动作：检查 cw run 的对应 flag（--poll-ms / --max-idle-ms / --max-concurrency / --max-spec-rejects / --max-build-attempts / --spawn-timeout-ms）取值。`,
    );
  }
}

/**
 * 停派态判定的运行预算（F1 修复：与 runLoopMain 解析后的注入值同源）。结算行的
 * stoppedDispatchState 判定必须用派发侧同一预算，否则注入非默认值时结算行与下一轮
 * 派发实态分叉（结算行谎报停派/谎报可重派）。
 */
interface DispatchBudgets {
  maxBuildAttempts: number;
  maxSpecRejects: number;
}

/**
 * spawn 结算的公共出声（fx-6 X3a 从常规结算路径抽出）：移出 inFlight + reviewer
 * flight 封窗（mx-3 S7）+ 按四态打印结算行（TIMEOUT 的停派态描述 = mx5-2 D6
 * 诚实化，判定输入 events 由调用方给——常规路径传结算时刻重读的账本，收束路径
 * 传本轮已读账本）。抽出的动机：末位 spawn（如 root exec-reviewer）退出与 poll
 * 到点竞争，race 的 sleep 分支先返回时循环顶部先命中 root closed 收束，结算行
 * 从未打印（M4 gate 四跑异常-2——session/verdict 在场仅缺行）；收束路径复用本
 * 函数只补打印，收束行为零变更。
 */
function settleFlightOutput(
  inFlight: InFlightSpawn[],
  flight: InFlightSpawn,
  result: SpawnResult,
  events: readonly LedgerEvent[],
  budgets: DispatchBudgets,
  onEvent?: (ev: LoopEvent) => void,
): void {
  const index = inFlight.indexOf(flight);
  if (index >= 0) {
    inFlight.splice(index, 1);
  }
  if (flight.reviewerWindow !== undefined) {
    flight.reviewerWindow.settledAt = Date.now();
  }
  const stopState =
    result.exitCode === "TIMEOUT"
      ? stoppedDispatchState(events, flight.unitId, budgets)
      : null;
  emit([
    `[runner] ${new Date().toISOString()} ${flight.role} unit "${flight.unitId}" 退出 ${describeExit(result.exitCode, stopState)}`,
  ]);
  onEvent?.({ kind: "settled", unitId: flight.unitId, role: flight.role, result });
}

/**
 * 收束路径的末位结算行补打印（fx-6 X3a）：对 inFlight 中已自然退出的 spawn 逐个
 * 打印结算行。非阻塞——sleep(0) 的 macrotask 兜底 vs wait() 的微任务：已 settle
 * 的 wait()（两适配器均 waitPromise 缓存式，重复调用返回同一 promise）必先到达；
 * 未退出的 spawn 返回 null 留给 killAll，等待窗口 ≤ 一个空转 tick。
 */
async function reportSettledFlights(
  inFlight: InFlightSpawn[],
  events: readonly LedgerEvent[],
  budgets: DispatchBudgets,
  onEvent?: (ev: LoopEvent) => void,
): Promise<void> {
  for (const flight of [...inFlight]) {
    const settled = await Promise.race<SpawnResult | null>([
      flight.handle.wait(),
      sleep(0).then(() => null),
    ]);
    if (settled !== null) {
      settleFlightOutput(inFlight, flight, settled, events, budgets, onEvent);
    }
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
  let runnerLock: RunnerLock | null = null;
  // P0-1：库形态停止通道（onStopRequest 缺席时 stop 为 undefined，行为零变更）
  const stopState: { requested: boolean; code: number } = { requested: false, code: LOOP_SIGNAL_EXIT_CODES.SIGINT };
  let stop: LoopStopChannel | undefined;
  let stopPromise: Promise<number> | undefined;
  if (opts.onStopRequest !== undefined) {
    let settleFn: ((code: number) => void) | undefined;
    stopPromise = new Promise<number>((resolve) => {
      settleFn = resolve;
    });
    stop = { state: stopState, settle: (code) => settleFn?.(code) };
    // 把循环自身的停止函数交付出去（在锁获取之前——覆盖启动竞态窗口内的 stop）
    opts.onStopRequest(() => {
      loopStopCleanup(opts.rootId, inFlight, () => runnerLock?.release(), "STOP", LOOP_SIGNAL_EXIT_CODES.SIGINT);
      stopState.requested = true;
      stopState.code = LOOP_SIGNAL_EXIT_CODES.SIGINT;
      stop?.settle(LOOP_SIGNAL_EXIT_CODES.SIGINT);
    });
  }
  const signalHandler = makeLoopSignalHandler(opts.rootId, inFlight, () => runnerLock?.release(), stop);
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);
  try {
    // u-i1-d R5：跨进程派发锁——启动 O_EXCL 获取；活锁拒启（exit 1 + 指引
    // --force-dispatch）、陈锁/force 覆盖 + 告警；锁不入账本（D8）。获取先于
    // 首个派发，root 缺失等抛错路径经 finally 释放，不留陈锁以外的副作用
    const acquired = acquireRunnerLock({
      cwHome: getCwHome(),
      cwd: opts.cwd,
      rootId: opts.rootId,
      form: "cli",
      force: opts.forceDispatch === true,
    });
    if (!acquired.ok) {
      await emitExitOutput(`${acquired.message}\n`, process.stderr);
      return 1;
    }
    runnerLock = acquired.lock;
    if (acquired.takeoverWarning !== undefined) {
      emitErr(acquired.takeoverWarning);
    }
    // P0-1：停止在锁获取/清扫阶段到达（主循环未启动）→ 直接以约定码返回
    if (stopState.requested) return stopState.code;
    const main = runLoopMain(opts, inFlight, runnerLock, stopState);
    if (stopPromise === undefined) return await main;
    // 库形态：停止兑现与主循环自然结束先到先得。停止先到时主循环仍在收尾
    //（killAll 解锁 await 后按 stopState 返回），其后续 reject 对调用方不再有
    // 意义——标记已处理防 unhandledRejection
    main.catch(() => undefined);
    return await Promise.race([main, stopPromise]);
  } finally {
    runnerLock?.release();
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
async function runLoopMain(
  opts: RunLoopOptions,
  inFlight: InFlightSpawn[],
  lock: { heartbeat(): void },
  stopState?: { requested: boolean; code: number },
): Promise<number> {
  const pollMs = opts.pollMs ?? DEFAULT_LOOP_POLL_MS;
  const maxIdleMs = opts.maxIdleMs ?? DEFAULT_LOOP_MAX_IDLE_MS;
  const maxConcurrency = opts.maxConcurrency ?? DEFAULT_LOOP_MAX_CONCURRENCY;
  // mx-4：spec 打回代数转人工预算（缺省回落常量默认 10——与只读命令同源，
  // flag 注入时仅本循环判定变紧/变宽，投影展示语义不变）
  const maxSpecRejects = opts.maxSpecRejects ?? SPEC_REVIEW_DEADLOCK_FAILS;
  // lv-2：buildDrift 停派预算（默认 5）与单次 spawn 超时上限（默认 30min；
  // flag/env 合流已在 handleRun 层完成——直调方非法值由 assertPositive 拦截）
  const maxBuildAttempts = opts.maxBuildAttempts ?? BUILD_DRIFT_MAX_ATTEMPTS;
  const spawnTimeoutMs = opts.spawnTimeoutMs ?? AGENT_SPAWN_TIMEOUT_MS;
  assertPositive("pollMs", pollMs);
  assertPositive("maxIdleMs", maxIdleMs);
  assertPositive("maxConcurrency", maxConcurrency);
  assertPositive("maxSpecRejects", maxSpecRejects);
  assertPositive("maxBuildAttempts", maxBuildAttempts);
  assertPositive("spawnTimeoutMs", spawnTimeoutMs);

  const initial = loadLedger(opts.cwd);
  if (!initial.projection.units.has(opts.rootId)) {
    throw new Error(
      `runLoop: root "${opts.rootId}" 不存在（账本内无其 UnitCreated 事件）。` +
        `恢复动作：运行 cw status 查看全部 unit 确认 id，或 cw create --id ${opts.rootId} --brief <路径> 创建。`,
    );
  }

  // mx-1 S3：reviewer 异源模型链——flag（--reviewer-model）优先于进程环境
  // CW_REVIEWER_MODEL，都未设则不注入（reviewer 回落 developer 同款模型链）。
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
      `poll=${pollMs}ms max-idle=${maxIdleMs}ms max-concurrency=${maxConcurrency} max-spec-rejects=${maxSpecRejects} ` +
      `max-build-attempts=${maxBuildAttempts} spawn-timeout-ms=${spawnTimeoutMs}ms`,
  ]);

  let lastTotalEvents = initial.projection.totalEvents;
  let lastProgressAt = Date.now();
  // 连续 TIMEOUT 计数（单进程内存态；语义见 AGENT_TIMEOUT_ESCALATION_AFTER 注释）。
  // escalated 单向：一经转人工，本次运行内不再自动派发（人工接手期间 loop 插足
  // 会与人工操作冲突；进展清零只作用于计数，不撤销转人工）
  const timeoutStreaks = new Map<string, TimeoutStreak>();
  const escalated = new Map<string, AgentRole>();
  // rv-5 flake 转人工的出声去重（fx-6 X5 改稳定签名：map 键 unitId + 值存排序后
  // acceptanceId 集合串——同一组条目连挂时 runId 单调追加不再重出，新增条目进入
  // 连挂才重出；修复 M4 gate 四跑异常-1「连挂 runId 增长致消息重复出声 19 条」。
  // 消息文本不变（含 runIds 与恢复指引），签名与消息分离）
  const announcedFlake = new Map<string, string>();
  // mx-1 MF2 spec 打回活锁转人工的出声去重（维持 mx-3 完整消息文本签名：各代
  // 打回意见不同是有意重出，fx-6 X5 明确不改本维度）
  const announcedDeadlock = new Map<string, string>();
  // lv-3 spec-review 代数中间档出声去重（完整文本比较：代数进文本必然逐代不同，同代数不重出）
  const announcedSpecProgress = new Map<string, string>();
  // mx5-2 解析失败回炉活锁转人工的出声去重（fx-6 X5 改稳定签名：排序后条目
  // 集合 + 代数档，runId 追加与上限内代数增长不重出）
  const announcedContractDeadlock = new Map<string, string>();
  // lv-2 buildDrift 缓慢进展转人工的出声去重（签名 = specEpoch:capped——必须含
  // specEpoch：新 spec 周期再次达预算时签名变化重出声，防「回炉后二次触发静默」；
  // 同周期内证据数继续增长不重出）
  const announcedBuildDrift = new Map<string, string>();
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
  // 只认「verdict 入账时刻 reviewer 在场」，developer in-flight 期间的自审提交、
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
  // ph-i1 R4：反思 followUp 的已挂接登记（unitId → 已挂接的 specHash）——防同轮/
  // 跨轮对同一在飞句柄重复追问；新 spec（新 hash）自然重新挂接
  const attachedReflection = new Map<string, string>();
  // u-i2-a：onEvent 发射器（回调抛错吞掉不炸主循环——观测面不是信任边界）+
  // round 事件的轮次序号 + stopped 事件的 unit×维度去重（每命中只发一次）
  const emitEvent = (ev: LoopEvent): void => {
    if (opts.onEvent === undefined) {
      return;
    }
    try {
      opts.onEvent(ev);
    } catch (err) {
      emitErr(
        `[runner] onEvent 回调抛错（已忽略，循环继续）：${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };
  let roundSeq = 0;
  const announcedStopped = new Set<string>();
  // fb-2（D9）：停派回收的 episode 去重登记（键 = unitId；连续停派轮次 = 同一
  // episode，离开停派集时由 recallStoppedUnitSpawns 清出——语义与依据见其
  // 函数头注释）
  const recalledStoppedSpawns = new Set<string>();

  while (true) {
    // P0-1：编程停止/信号（库形态）已请求 → 在飞已 killAll，以约定码收束
    if (stopState?.requested === true) return stopState.code;
    // u-i1-d R5：每轮 poll 重写心跳（活锁判定输入——他进程见 heartbeatTs 停滞
    // 属陈锁抢占路径的人工判断辅助，机器侧判定仍以 pid 存活为准）
    lock.heartbeat();
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
      // 正常路径 in-flight 已空；外部（如人工）直接推 closed 时的兜底回收。
      // fx-6 X3a：killAll 前先补打印已退出 spawn 的结算行——race 的 sleep 分支
      // 先到点而 spawn 已退出时，末位（如 root exec-reviewer）的结算行会在此
      // 收束分支被跳过（四跑异常-2），此处兜底出声
      await reportSettledFlights(inFlight, events, { maxBuildAttempts, maxSpecRejects }, emitEvent);
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

    // 连续 TIMEOUT 计数的进展清零 + 转人工判定（在派发计算之前——顺序语义见
    // settleTimeoutEscalations 注释）
    lastUnitSeqs = settleTimeoutEscalations(
      events,
      timeoutStreaks,
      lastUnitSeqs,
      escalated,
      opts.rootId,
      artifactsDir,
      spawnTimeoutMs,
      (unitId, role) =>
        emitEvent({
          kind: "stopped",
          unitId,
          dimension: "timeoutEscalation",
          reason: `连续 ${AGENT_TIMEOUT_ESCALATION_AFTER} 次 spawn TIMEOUT 封顶（最后派发 role：${role}），停止自动重派转人工`,
        }),
    );

    // 四类转人工维度的出声与事实计算（rv-5 flake / mx5-2 回炉活锁 / mx-1 spec
    // 打回活锁 / lv-2 buildDrift 缓慢进展——语义与去重见 announceManualEscalations
    // 注释）。buildDriftFacts 每轮只算一次：出声与派发计算消费同一份（对齐
    // flakes/contractFacts 复用模式）；人工处置写入新事件后投影自然消失、循环自愈
    const subtreeIds = new Set(subtreeUnits(projection, opts.rootId).map((u) => u.unitId));
    const driftFacts = buildDriftFacts(events, maxBuildAttempts);
    const escalatedFacts = announceManualEscalations(
      opts.rootId,
      events,
      subtreeIds,
      { maxSpecRejects, driftFacts, maxBuildAttempts, artifactDir: artifactsDir },
      {
        flake: announcedFlake,
        contract: announcedContractDeadlock,
        spec: announcedDeadlock,
        specProgress: announcedSpecProgress,
        buildDrift: announcedBuildDrift,
      },
    );
    // u-i2-a：frontier 每轮只算一次——round 事件（widget 数据源）、stopped 事件
    //（停派四维命中）与派发计算（computeDispatchTargets）消费同一份投影（同源）
    const groups = computeFrontier(projection, {
      consecutiveIntegrationFails: consecutiveIntegrationFails(events),
      flakeReviewFacts: escalatedFacts.flakes,
      specContractFacts: escalatedFacts.contractFacts,
      specReviewFailCounts: escalatedFacts.specFails,
      maxSpecRejects,
      buildDriftFacts: driftFacts,
    });
    roundSeq += 1;
    emitEvent({ kind: "round", seq: roundSeq, frontierSummary: summarizeFrontier(groups) });
    for (const dimension of STOPPED_DISPATCH_DIMENSIONS) {
      for (const unitId of groups[dimension]) {
        if (!subtreeIds.has(unitId)) {
          continue;
        }
        const dedupeKey = `${unitId}|${dimension}`;
        if (announcedStopped.has(dedupeKey)) {
          continue;
        }
        announcedStopped.add(dedupeKey);
        emitEvent({
          kind: "stopped",
          unitId,
          dimension,
          reason: STOPPED_REASONS[dimension],
        });
      }
    }

    // fb-2（D9，C10）：停派维度命中即回收该 unit 在飞 spawn（全 role）。出声
    // 时序定夺（设计检查点③，与 recallStoppedUnitSpawns 函数头注释一致）：
    // 调用点在本轮转人工指引出声（settleTimeoutEscalations 的 escalationMessage /
    // 上方 announceManualEscalations）与 stopped 事件之后——「人工先看到指引、
    // 随后看到回收记录」（实测排布依据：指引在 stderr 先落盘，回收行走同一
    // stderr 流，行序即人工视读序）。TIMEOUT 封顶档（escalated）也入回收集——
    // 该档触发时刻 unit 必无在飞（单飞门 + 结算后才计 streak，检查点④已核），
    // 属防御性兑底（空转无害），且后写覆盖四维条目（同时命中时以先触发的
    // TIMEOUT 档出声）；维度名与 stopped 事件同用 timeoutEscalation
    const stoppedUnitDimension = new Map<string, string>();
    for (const dimension of STOPPED_DISPATCH_DIMENSIONS) {
      for (const unitId of groups[dimension]) {
        if (subtreeIds.has(unitId)) {
          stoppedUnitDimension.set(unitId, dimension);
        }
      }
    }
    for (const unitId of escalated.keys()) {
      if (subtreeIds.has(unitId)) {
        stoppedUnitDimension.set(unitId, "timeoutEscalation");
      }
    }
    recallStoppedUnitSpawns(inFlight, stoppedUnitDimension, recalledStoppedSpawns);

    // mx-1 S7 抢答可见性（mx-3 豁免收紧）：本 run 期间新入账的 spec-review
    // verdict，若其入账时刻不落在该 unit 任何 reviewer flight 的存活窗口内、且非
    // fail 打回流转（fail 有 specFixPending 收敛出口）→ stderr 一行警告（不阻断
    // 不入账）。verdict 的入账 ts 取自原始事件流（fold 投影不含 ts），与本进程的
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

    // ph-i1 R4：反思接缝——reflectionPending 不进派发表（computeDispatchTargets
    // 已 skip），在此处理：有在飞长驻句柄 → followUp 链（同进程追问，上下文全保留）；
    // 无在飞（一次性后端已结算）→ loop 代写占位 ReflectionRan 放行（降级出声，
    // 诚实边界：无 sessionFile 审计锚；反思实质属 ph-i2 四流程）。代写失败只出声，
    // 下轮重试（reflectionPending 持续可见）
    for (const unit of subtreeUnits(projection, opts.rootId)) {
      // 无 verdict 条件与 frontier.reflectionPending 判定同步（adversarial R5）：
      // 最新 spec 已有 spec-review verdict 的 unit（specFixPending 等）不属
      // reflectionPending——对其发 followUp 会劫持修 spec 的在飞会话、或对旧账本
      // fail-v 存量 unit 代写占位 ReflectionRan
      if (
        unitStatus(unit) !== "created" ||
        unit.specs.length === 0 ||
        reflectionDone(unit) ||
        latestSpecReviewAfterLastSpec(unit) !== null
      ) {
        continue;
      }
      const spec = unit.specs[unit.specs.length - 1];
      if (spec === undefined) {
        continue;
      }
      const flight = inFlight.find((f) => f.unitId === unit.unitId);
      if (flight !== undefined) {
        if (
          isInteractiveSpawnHandle(flight.handle) &&
          attachedReflection.get(unit.unitId) !== spec.specHash
        ) {
          attachedReflection.set(unit.unitId, spec.specHash);
          emit([
            `[runner] unit "${unit.unitId}" 处于 reflectionPending 且有在飞长驻句柄——发反思 followUp（完成后写 ReflectionRan 再派 reviewer）`,
          ]);
          startReflectionFollowUp(
            opts.cwd,
            opts.rootId,
            unit.unitId,
            flight.handle,
            spec.specHash,
            unit.reflections.length + 1,
            spawnTimeoutMs,
          );
          emitEvent({
            kind: "reflection",
            unitId: unit.unitId,
            round: unit.reflections.length + 1,
          });
        }
        // 非交互在飞：等本轮结算后走代写路径（不抢跑 agent 未完成的现场）
        continue;
      }
      try {
        new EventLedger(ledgerPath(getCwHome(), opts.cwd)).append("ReflectionRan", {
          unitId: unit.unitId,
          specHash: spec.specHash,
          round: unit.reflections.length + 1,
          placeholder: true,
        });
        emitEvent({
          kind: "reflection",
          unitId: unit.unitId,
          round: unit.reflections.length + 1,
        });
        emitErr(
          `[runner] unit "${unit.unitId}" reflectionPending 但无在飞长驻句柄（一次性后端）` +
            "——loop 代写占位 ReflectionRan 放行（无反思实质，TODO(ph-i2) 四流程接入）。" +
            `恢复动作：需真实反思链时用 cw run --root ${opts.rootId} --spawn pi-rpc。\n`,
        );
      } catch (err) {
        emitErr(
          `[runner] unit "${unit.unitId}" 的占位 ReflectionRan 入账失败（下轮重试）：` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    // 派发（六步之 1-3）：frontier 重算 → 内部节点直跑集成（确定性代码，不派
    // agent、不占并发额度）→ brief 落盘 → spawn，同批 ≤ maxConcurrency
    const targets = computeDispatchTargets(
      groups,
      projection,
      opts.rootId,
      inFlight,
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
        try {
          await runIntegrationDispatch(opts.cwd, projection, target.unitId);
        } catch (err) {
          // fx-7：集成路径 env 级 throw（evidence 目录建失败 / 报告写入失败等）
          // 不炸循环——降级为该 unit 本轮集成失败，与下方 worktree 就绪失败同款
          // 「出声 + 跳过本轮」；下轮重算 frontier 自然重试。账本入账失败已在
          // runIntegrationDispatch 内部出声处理，此处只兜其未覆盖的 env 级异常
          emitErr(
            `[runner] unit "${target.unitId}" 的集成派发异常（本轮跳过，下轮重算自动重试）：` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
          emitEvent({
            kind: "error",
            stage: "integration",
            message: `unit "${target.unitId}" 的集成派发异常：${err instanceof Error ? err.message : String(err)}`,
          });
        }
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
        // designer × spec-frozen 出口的可观测性（终验日志里明确「为何派 designer」）。
        // 判定序与 computeFrontier 单组归属同步：mx5-2 契约回炉 → fx-3 R5.3 兜底
        //（split 子未建）→ fx-2 R4a 上限（集成连续 fail）
        emitSpecFrozenDesignerRationale(target, unit, projection, escalatedFacts.contractFacts);
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
        emitEvent({
          kind: "error",
          stage: "worktree",
          message: `unit "${target.unitId}" worktree 就绪失败：${ensured.error}`,
        });
        continue;
      }
      const briefPath = writeBriefWithHistory(artifactsDir, target, unit, projection, opts.rootId, opts.cwd, wtDir, events);
      // mx-1 S3：reviewer role 注入异源模型（复用 pi 的 CW_AGENT_MODEL → --model
      // 翻译链，req.env 级；未配置时不注入——reviewer 与 developer 同模型链）。
      // mx-3 S7：reviewer flight 的存活窗口登记（抢答豁免收紧后，豁免只认
      // 「verdict 入账时刻 reviewer 在场」——本窗口是唯一豁免依据）
      let reviewerWindow: ReviewerFlightWindow | undefined;
      if (target.role === "reviewer") {
        reviewerWindow = { spawnedAt: Date.now(), settledAt: null };
        const windows = reviewerFlightWindows.get(target.unitId) ?? [];
        windows.push(reviewerWindow);
        reviewerFlightWindows.set(target.unitId, windows);
      }
      let handle: SpawnHandle;
      try {
        handle = await opts.adapter.spawn({
          role: target.role,
          unitId: target.unitId,
          workdir: wtDir,
          projectCwd: opts.cwd,
          artifactDir: artifactsDir,
          briefPath,
          ...(target.role === "reviewer" && reviewerModel !== undefined
            ? { env: { CW_AGENT_MODEL: reviewerModel } }
            : {}),
          // lv-2：超时用本循环解析后的值（--spawn-timeout-ms / CW_SPAWN_TIMEOUT_MS 注入）
          timeoutMs: spawnTimeoutMs,
        });
      } catch (err) {
        // fx-7：适配器同步 throw（human 适配器 brief 落盘 IO 失败等 env 级异常）
        // 不炸循环——与上方 worktree 就绪失败同款「出声 + 跳过本轮」，下轮重算
        // 重试。throw 时该 unit 未入 in-flight（结算 / killAll 不受牵连，其余
        // unit 的等待与结算照常）；reviewer 窗口立即封窗——spawn 未成立，不能让
        // 永久 open 的窗口吞掉后续抢答告警（mx-3 豁免只认「verdict 时 reviewer
        // 在场」）
        if (reviewerWindow !== undefined) {
          reviewerWindow.settledAt = Date.now();
        }
        emitErr(
          `[runner] unit "${target.unitId}" 的 ${target.role} 派发 spawn 异常（本轮跳过，下轮重算自动重试）：` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
        emitEvent({
          kind: "error",
          stage: "spawn",
          message: `unit "${target.unitId}" 的 ${target.role} 派发 spawn 异常：${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      inFlight.push({ role: target.role, unitId: target.unitId, handle, reviewerWindow });
      emit([
        `[runner] ${new Date().toISOString()} 派发 ${target.role} → unit "${target.unitId}"（worktree: ${wtDir}，brief: ${briefPath}）`,
      ]);
      emitEvent({
        kind: "dispatch",
        unitId: target.unitId,
        role: target.role,
        subagentSlug: `${target.unitId}-${target.role}`,
      });
    }

    // 等待（六步之 4）：任一 spawn 退出或 poll 到点，先到者唤醒重算
    const finished = await Promise.race<FinishedWatch | null>([
      ...inFlight.map(async (flight) => ({ flight, result: await flight.handle.wait() })),
      sleep(pollMs).then(() => null),
    ]);

    if (finished !== null) {
      // D6（mx5-2）：TIMEOUT 结算行诚实化——该 unit 此刻若处于停派态（转人工
      // 维度），「可重派」承诺不兑现，改述真实行为。只在 TIMEOUT 时现算（其余
      // 退出码的消费口径不变）；结算时刻重读账本，被 kill 的 agent 死前的处置
      // 写入已可见（stoppedDispatchState 是 frontier 的只读投影）。
      // fx-6 X3a：出声部分抽出 settleFlightOutput（与收束路径共用）
      settleFlightOutput(
        inFlight,
        finished.flight,
        finished.result,
        finished.result.exitCode === "TIMEOUT"
          ? new EventLedger(ledgerPath(getCwHome(), opts.cwd)).readAll()
          : events,
        { maxBuildAttempts, maxSpecRejects },
        emitEvent,
      );
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

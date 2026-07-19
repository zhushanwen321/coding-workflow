/**
 * ScopeConfig —— cw 1.0 通用引擎的层特定配置。
 *
 * 设计意图：把 cw 0.x 散落在 state-machine.ts / actions.ts / shapes/ 的硬编码配置
 * （TRANSITIONS / TaskShape / turn limits / collection 写入语义）统一打包成一个声明。
 *
 * 一个 ScopeConfig 实例 = 一层（L3-topic / L3-wave / L4-spec / L5-effort）的完整行为配置。
 * UnitStateMachine 接收 ScopeConfig，零 topic 假设地驱动任意层。
 *
 * 与 cw 0.x 的对应关系：
 *   - transitions ← TRANSITIONS（state-machine.ts:217，直接平移）
 *   - phases.clarify/review/lock/split ← buildNextAction 的 switch 隐含的阶段
 *   - coverageGates + evidenceGates ← gate.ts 的具名函数 + handler 内联 gate
 *   - freezeRules ← validateAppendOnly + VerificationStrategy.replanGuard
 *   - loops ← REVIEW_TURN_LIMIT / TEST_TURN_LIMIT + countConsecutiveGateFails
 *   - collections ← store.ts 散落的 append/replace/merge/freeze 方法语义
 *   - fogConfig ← plan.md §5.5 的 L5 fog of war（通用化后所有层都有）
 *
 * @typeParam S - status 字面量联合
 * @typeParam A - action 字面量联合
 * @typeParam P - payload 类型
 */
import type { Unit } from "./unit.js";

/**
 * 声明式状态转换规则。
 *
 * 直接平移 cw 0.x 的 TransitionRule（state-machine.ts:197-204）。
 * expectedStatuses: 允许的当前 status 集合（create 为空数组）。
 * nextStatus: 流转后 status。
 * progressive: 若当前已在 nextStatus 则原地停留（不回退）—— cw 0.x 已验证的语义。
 */
export interface TransitionRule<S extends string> {
  expectedStatuses: readonly S[];
  nextStatus: S;
  progressive?: boolean;
}

/**
 * 阶段配置 —— 四步通用骨架的参数化。
 *
 * 每层都有 clarify → review → lock → split 四步骨架，差异在每步的粒度、重复性、可省略性。
 * 见 plan.md 风险分析 §「挖 5: phase 顺序」。
 */
export interface PhaseConfig<A extends string> {
  /** 该阶段对应的主 action（如 L3 clarify 阶段的 action 是 "plan"）。 */
  action: A;
  /**
   * 粒度：整 unit 一次，还是 per-child。
   * - unit：L4 spec lock 一次锁整个 spec
   * - per-child：L5 ticket resolve 一张一张解
   */
  granularity: "unit" | "per-child";
  /**
   * 重复性：一次还是循环。
   * - once：L4 spec lock 一次定型
   * - loop：L5 ticket resolve 循环解多张
   */
  repetition: "once" | "loop";
  /** 是否可省略（叶子层 clarify/split 可省）。 */
  skippable?: boolean;
  /** 是否与下一步合并（L3 topic lock 和 execute 合并）。 */
  mergedWithNext?: A;
}

/**
 * 循环控制配置 —— fix loop / progressive 重入的边界。
 *
 * 对应 cw 0.x 的 *_TURN_LIMIT（state-machine.ts:47-50）+ GATE_RETRY_LIMIT（state-machine.ts:40）。
 * 达 limit 后强制前推（escape）或换熔断文案（circuitBreak）。
 */
export interface LoopConfig {
  /** turn 计数器在 payload 里的字段名（如 "reviewTurn"）。 */
  turnField: string;
  /** loop 上限（如 review=3, test=5）。 */
  limit: number;
  /** 达上限后强制前推到的 action（escape valve）。 */
  escapeAction: string;
}

/**
 * 产物 collection 写入语义。
 *
 * 替代 cw 0.x 散落在 store 方法名里的写入语义约定（appendXxx / replaceXxx / setXxx）。
 * ScopeConfig.collections 声明每个 collection 的写入模式，引擎按声明分发。
 *
 * 四种模式（对应 plan.md §「挖 1: append-only」的四子类）：
 *   - append：事件日志（gateHistory / clarifyRecords / driftLog / statusHistory）
 *   - replace：版本快照（specSections / testCases，replace 时归档旧版本）
 *   - merge：部分字段更新（artifacts）
 *   - freeze：状态冻结（evidence，closeout 后不可改）
 */
export interface CollectionSpec {
  writeMode: "append" | "replace" | "merge" | "freeze";
  /** freeze 模式：哪个事件触发冻结（如 "closeout"）。 */
  freezeEvent?: string;
  /** replace 模式：是否归档旧版本（如 specHistory）。 */
  versioned?: boolean;
  /** 受 FreezeRule 保护时不可改的字段（与 FreezeRule.immutableFields 对齐）。 */
  protectedFields?: readonly string[];
}

/**
 * 完整的层配置 —— 一层状态机的完整声明。
 *
 * @typeParam S - status 字面量联合
 * @typeParam A - action 字面量联合
 * @typeParam P - payload 类型
 */
export interface ScopeConfig<
  S extends string,
  A extends string,
  P,
> {
  /** 层标识。 */
  readonly scope: string;

  // ── 状态机配置 ──

  /** 声明式转换表（替代 cw 0.x TRANSITIONS）。 */
  transitions: Record<A, TransitionRule<S>>;
  /** 初始 status（create 后）。 */
  initStatus: S;
  /** 终态集合（不可流转出去）。 */
  terminalStatuses: ReadonlySet<S>;

  // ── 四步阶段配置 ──

  phases: {
    clarify?: PhaseConfig<A>;
    review?: PhaseConfig<A>;
    lock?: PhaseConfig<A>;
    split?: PhaseConfig<A>;
  };

  // ── 通用机制配置（按需启用）──

  /**
   * 覆盖性 gate（类别 A）：parents → children 覆盖检查。
   * 如 L4 FR → AC、L3 AC → testCase。
   * cw 0.x 的 checkFrCoverage / checkAcMapping 是 warning 版本，L4 lock gate 计划硬阻断。
   */
  coverageGates?: ReadonlyArray<CoverageGateSpec<P>>;

  /**
   * 证据锚定 gate（类别 B）：机器可验证证据。
   * 如 L3 commit-anchor（git commit hash）/ TDD red light / judgeByExpected。
   * cw 0.x 的 GitValidator.validate / redLightCheck / testCheck 都属此类。
   */
  evidenceGates?: ReadonlyArray<EvidenceGateSpec<P>>;

  /**
   * 不可篡改规则（类别 C）：append-only / 版本快照 / 状态冻结。
   * 替代 cw 0.x validateAppendOnly 的硬编码 5 种违规类型。
   */
  freezeRules?: ReadonlyArray<FreezeRule<P>>;

  /**
   * 渐进清晰 / fog（类别 D）：通用增量识别。
   * L5 强（Not-yet-specified），L3 弱（plan 未覆盖的实现难点）。
   * 见 plan.md §「挖 fog」。
   */
  fogConfig?: FogConfig<P>;

  /**
   * 类型分发（类别 E）：按 type 走子流程。
   * cw 0.x 的 TaskShape（full-tdd / delete-only / doc-only）+ L5 ticket type 都属此类。
   */
  typeDispatch?: ReadonlyMap<string, SubFlowConfig>;

  /**
   * 跨层 drift 检测配置。
   * 检测 parentLockVersion 变化，标下游 drifted。
   */
  driftConfig?: DriftSpec;

  // ── loop 控制 ──

  /** fix loop / progressive 重入的边界（替代 cw 0.x 散落的 *_TURN_LIMIT）。 */
  loops?: Record<string, LoopConfig>;

  /** gate 连续 fail 上限（cw 0.x GATE_RETRY_LIMIT=5，达上限换熔断文案不阻断）。 */
  gateRetryLimit?: number;

  // ── 产物 collection 声明 ──

  /**
   * 每个 collection 的写入语义。
   * 替代 cw 0.x store.ts 散落的 append/replace/merge/freeze 方法名约定。
   */
  collections: Record<string, CollectionSpec>;

  // ── action → gate 映射 ──

  /**
   * 每个 action 触发哪些 gate（替代 cw 0.x handler 内硬编码 gate 调用）。
   * 引擎按此表查 gate，调 GateRunner 统一执行。
   */
  actionGates?: Readonly<Record<A, readonly string[]>>;
}

/**
 * 覆盖性 gate 声明。
 *
 * @typeParam P - payload 类型（gate 可能读 payload 数据）
 */
export interface CoverageGateSpec<P> {
  id: string;
  /** 覆盖维度（"fr-ac" / "ac-testCase" / "fr-wave" 等）。 */
  dimension: string;
  /** 父项集合的 collection 名（如 "specSections"）。 */
  parentCollection: string;
  /** 子项集合的 collection 名（如 "testCases"）。 */
  childCollection: string;
  /**
   * 校验函数：返回未覆盖的父项列表。空数组 = pass。
   * 替代 cw 0.x checkFrCoverage 的宽松子串匹配，1.0 计划硬阻断。
   */
  check: (unit: Unit<string, P>) => { uncovered: string[]; report: string };
}

/**
 * 证据锚定 gate 声明。
 */
export interface EvidenceGateSpec<P> {
  id: string;
  /** 证据类型（"git-commit" / "content-hash" / "tdd-red-light" / "judge-expected"）。 */
  evidenceKind: "git-commit" | "content-hash" | "tdd-red-light" | "judge-expected" | "non-empty";
  /** 校验函数。 */
  check: (unit: Unit<string, P>, input: unknown) => { passed: boolean; report: string };
}

/**
 * 不可篡改规则声明。
 *
 * 替代 cw 0.x validateAppendOnly 的硬编码。每个规则保护一个 collection 里满足 predicate 的元素。
 */
export interface FreezeRule<P> {
  id: string;
  /** 受保护的 collection 名（"waves" / "testCases"）。 */
  collection: string;
  /** 元素是否受保护（如 wave.committed !== null）。 */
  predicate: (item: unknown, unit: Unit<string, P>) => boolean;
  /** 受保护后不可改的字段（["committed", "changes", "dependsOn"]）。 */
  immutableFields: readonly string[];
  /** 违规类型标识（与 cw 0.x AppendOnlyViolation.type 对齐）。 */
  violationType: string;
}

/**
 * fog 配置 —— 渐进清晰机制。
 *
 * L5 强：Not-yet-specified 显式管理，graduate 成 ticket。
 * L3 弱：plan 未覆盖的实现难点，dev 时发现 → replan 加新 wave。
 */
export interface FogConfig<P> {
  /** fog 字段在 payload 里的位置（如 L5 的 "notYetSpecified"）。 */
  fogField: string;
  /** graduate 成什么 collection 的元素（"tickets" / "waves"）。 */
  graduateTarget: string;
  /**
   * graduate 触发条件检查。
   * 返回应 graduate 的 fog 项列表（空数组 = 无需 graduate）。
   */
  shouldGraduate: (unit: Unit<string, P>) => string[];
}

/**
 * 类型分发到子流程的配置。
 *
 * cw 0.x 的 TaskShape 是实例：full-tdd 走完整 TDD 流程，delete-only 走 existence 流程。
 * 1.0 泛化为：按 unit.type 查 SubFlowConfig，走不同的 gates / freezeRules 子集。
 */
export interface SubFlowConfig {
  /** 该子流程启用的 gate id 子集。 */
  enabledGates: readonly string[];
  /** 该子流程启用的 freezeRule id 子集。 */
  enabledFreezeRules: readonly string[];
}

/**
 * drift 检测配置。
 */
export interface DriftSpec {
  /** 上游层标识（如 L3-topic 的上游是 L4-spec）。 */
  upstreamScope: string;
  /** 上游 status 变化时触发 drift 的事件（"unlock" / "supersede" 等）。 */
  triggerEvents: readonly string[];
  /** drifted 状态阻塞的 action（如 L3 closeout）。 */
  blockingActions: readonly string[];
}

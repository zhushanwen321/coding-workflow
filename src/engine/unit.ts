/**
 * 通用 Unit 抽象 —— cw 1.0 通用引擎的核心数据载体。
 *
 * 设计意图：把 cw 0.x 的 topic / wave / spec / ticket 统一为一个概念。
 * 每层（L1-L5）的产物都是 Unit<S, P> 实例，差异仅在：
 *   - S（status 字面量联合）—— 各层有自己的状态集合
 *   - P（payload 类型）—— 各层 frontmatter 扩展
 *   - ScopeConfig（行为配置）—— 各层有自己的 transitions / gates / freezeRules
 *
 * 一个 UnitStateMachine 实例化不同 ScopeConfig，即可驱动任意层。
 *
 * 关键设计点：
 *   - collections: Record<string, unknown[]> 把 cw 0.x 的 gateHistory/waves/testCases/reviewIssues
 *     等内嵌数组统一为通用 append-only 容器。写入语义由 ScopeConfig.collections[name].writeMode 控制。
 *   - parentUnitId / childUnitIds / derivedFromId 是跨层指针，解耦递归嵌套。
 *     wave→topic、topic→spec、spec→effort 通过这些字符串指针关联，不通过对象引用。
 *   - parentLockVersion + driftStatus + driftLog 是跨层 drift 检测基础设施（原型预留接口）。
 *   - lockVersion 用于 L4 spec（unlock/re-lock 递增），其他层可选。
 */

/**
 * Scope id —— 标识 Unit 属于哪一层。
 *
 * 对应 plan.md §4.2 的 5 层 + L3 内部细分（topic vs wave）。
 * L1 decision / L2 problem 是无状态服务，不走状态机，但也可有 Unit 记录（如 ADR）。
 */
export type ScopeId =
  | "L5-effort"
  | "L4-spec"
  | "L3-topic"
  | "L3-wave"
  | "L2-research"
  | "L2-prototype"
  | "L1-adr"
  | "L1-glossary";

/**
 * drift 状态 —— 跨层逆向影响传播的下游标记。
 *
 * - clean：上游未变，或下游已跟上（rebase 后）
 * - drifted：上游变了，下游还没处理。**阻塞 closeout gate**（硬约束，数据完整性底线）
 * - acknowledged：人类/agent 显式决定保持现状。可 closeout，但 retrospect 必须记录 drift 决策
 *
 * 检测方式：上游 action（如 L4 spec unlock）的 handler 内主动扫描下游 + 标记 drifted。
 * 不是查询时临时算（避免中间状态不一致，gate 无法校验）。
 */
export type DriftStatus = "clean" | "drifted" | "acknowledged";

/**
 * status 变更事件 —— statusHistory[] 的单条记录。
 *
 * append-only，每次 status 流转都追加。用于完整追溯 unit 的生命周期。
 * 对应 cw 0.x 的 statusHistory 概念（散落在各处，这里统一）。
 */
export interface StatusEvent {
  /** ISO timestamp。 */
  at: string;
  /** 触发流转的 action。 */
  action: string;
  /** 流转前 status（init 时为 null）。 */
  from: string | null;
  /** 流转后 status。 */
  to: string;
  /** 流转原因（可选，replan/abort/unlock 等逆向 action 必填）。 */
  reason?: string;
}

/**
 * drift 事件 —— driftLog[] 的单条记录。
 *
 * append-only，每次 driftStatus 变化都追加。
 * retrospect 可分析 drift 频次 + 处理方式。
 */
export interface DriftEvent {
  at: string;
  from: DriftStatus;
  to: DriftStatus;
  /** drift 来源（上游 unit id）。 */
  causeUnitId: string;
  /** 触发原因（"spec unlock v2" / "spec superseded" 等）。 */
  cause: string;
  /** acknowledged 时必填，rebase 时为 null。 */
  reason?: string;
}

/**
 * 通用 Unit —— 所有层产物的统一数据载体。
 *
 * @typeParam S - status 字面量联合（每层自定义）
 * @typeParam P - payload 类型（每层 frontmatter 扩展）
 */
export interface Unit<S extends string, P> {
  /** 全局唯一 id，格式 "{scope}:{slug}" 或 "{scope}:{parentId}-{localId}"。 */
  id: string;
  /** 所属层。 */
  scope: ScopeId;
  /** 人类可读 slug（topic 用 slug，wave 用 "{topicSlug}-w{n}"）。 */
  slug: string;
  /** 当前 status（状态机当前态）。 */
  status: S;
  /** status 变更日志，append-only。 */
  statusHistory: StatusEvent[];

  // ── 跨层指针（解耦递归嵌套）──

  /** 父 unit id（wave→topic / topic→spec / spec→effort）。根 unit 为 undefined。 */
  parentUnitId?: string;
  /** 子 unit id 列表（topic→waves / spec→topics / effort→tickets）。 */
  childUnitIds: string[];
  /** 上游 unit id（split/collapse 时的源 unit，用于 drift 追溯）。 */
  derivedFromId?: string;

  // ── drift 基础设施（跨层逆向影响传播）──

  /** 创建时 parent 的 lock 版本（drift 检测的快照指针）。 */
  parentLockVersion?: number;
  /** 当前 drift 状态。 */
  driftStatus: DriftStatus;
  /** drift 事件日志，append-only。 */
  driftLog: DriftEvent[];

  // ── lock 版本（L4 spec unlock/re-lock 用，其他层可选）──

  /** 当前 lock 版本（每次 unlock + re-lock 递增）。 */
  lockVersion?: number;

  // ── 类型分发（ticket type / TaskShape / spec type）──

  /** 子流程类型标识，配合 ScopeConfig.typeDispatch 走不同子流程。 */
  type?: string;

  // ── 层特定产物 + 通用集合容器 ──

  /** 层特定 frontmatter（每层自定义类型）。 */
  payload: P;
  /**
   * 通用 append-only / replaceable 集合容器。
   *
   * 替代 cw 0.x 内嵌在 topic 上的 waves/testCases/gateHistory/clarifyRecords/reviewIssues/testFixLog 等。
   * 每层的 ScopeConfig.collections 声明有哪些 collection + 写入语义（append/replace/merge/freeze）。
   */
  collections: Record<string, unknown[]>;
}

/**
 * 创建新 Unit 的工厂辅助函数 —— 统一初始化通用字段。
 *
 * 调用方只需提供 scope/slug/status/payload，通用字段（statusHistory/childUnitIds/driftLog/collections）
 * 自动初始化为空数组 / clean 状态。
 */
export function createUnit<S extends string, P>(args: {
  scope: ScopeId;
  slug: string;
  status: S;
  payload: P;
  parentUnitId?: string;
  derivedFromId?: string;
  type?: string;
  createdAt?: string;
}): Unit<S, P> {
  const now = args.createdAt ?? new Date().toISOString();
  const id = `${args.scope}:${args.slug}`;
  return {
    id,
    scope: args.scope,
    slug: args.slug,
    status: args.status,
    statusHistory: [
      { at: now, action: "create", from: null, to: args.status },
    ],
    parentUnitId: args.parentUnitId,
    childUnitIds: [],
    derivedFromId: args.derivedFromId,
    driftStatus: "clean",
    driftLog: [],
    type: args.type,
    payload: args.payload,
    collections: {},
  };
}

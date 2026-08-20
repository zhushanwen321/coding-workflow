/**
 * v1 状态 + 变更记录 + status→action 映射（领域模型，零依赖）。
 *
 * 来源：v5 model §3.1/§3.2（状态枚举）、§4.4（StatusChange）、§5.6.1（AbandonedRef）。
 *
 * 映射表（WAVE_STATUS_TO_ACTION / PLANNING_STATUS_TO_ACTION / TERMINAL_STATUSES）是
 * frontier.ts（core 层）与 render.ts（readonly 层）的共享单一定义源——此前两处各维护
 * 一份同源表靠手维护，无交叉校验，status 枚举新增时易漏改一处。core 层不能 import
 * rules/state-machine.ts 的 WaveAction/PlanningAction（会破坏 core→rules 依赖方向），
 * 故映射值用 string；readonly 层消费时按需 as 收窄到具体 action 类型。
 */
// ═══════════════════════════════════════════════════════════════
// 状态枚举
// ═══════════════════════════════════════════════════════════════

/** model §3.1 — PlanningUnit（epic/feature/slice）的 7 状态。本 topic 不实现 PlanningUnit 流程，但类型预留。 */
export type PlanningStatus =
  | "created"
  | "designing"
  | "design-reviewed"
  | "executing"
  | "retrospected"
  | "closed"
  | "aborted";

/** model §3.2 — ExecutionUnit（wave）的 9 状态。 */
export type ExecutionStatus =
  | "created"
  | "designing"
  | "design-reviewed"
  | "executing"
  | "tested"
  | "exec-reviewed"
  | "retrospected"
  | "closed"
  | "aborted";

/** 通用 status（两种联合）。 */
export type WorkUnitStatus = PlanningStatus | ExecutionStatus;

// ═══════════════════════════════════════════════════════════════
// StatusChange（statusHistory 元素，append-only）
// ═══════════════════════════════════════════════════════════════

/**
 * model §4.4 — statusHistory 的元素。
 *
 * append-only 的「所有变更」流（不只是状态转换）。
 * replan 旁路 action 不改 status，但仍 append 一条（from=to，见 model §4.4.1）。
 */
export interface StatusChange {
  /** 流转前 status。create 时无（从无到有）。 */
  from?: WorkUnitStatus;
  /** 流转后 status。replan 时 = from（不变）。 */
  to: WorkUnitStatus;
  /** ISO 8601 时间戳。 */
  at: string;
  /** 触发变更的 action（create/design/.../replan/abort）。 */
  action: string;
  /** 可选说明（replan 原因 / abort 原因）。 */
  note?: string;
}

// ═══════════════════════════════════════════════════════════════
// AbandonedRef（被上游 replan 影响的废弃记录）
// ═══════════════════════════════════════════════════════════════

/**
 * model §5.6.1 — 被 WorkUnit 被上游 replan 影响到的废弃记录。
 *
 * 纯历史记录，用于 status/report 追溯「何时、因哪个上游条目废弃而被影响」。
 * 不阻塞任何流程（cw 在 replan 时已直接 abort，无中间态）。
 */
export interface AbandonedRef {
  /** 被废弃的上游条目 id（来自 WorkUnitItem.id）。 */
  workUnitItemId: string;
  /** 何时被废弃影响（ISO 8601 时间戳）。 */
  abandonedAt: string;
}

// ═══════════════════════════════════════════════════════════════
// status → action 映射表（frontier + render 共享单一定义源）
// ═══════════════════════════════════════════════════════════════

/**
 * wave（ExecutionStatus）→ WaveAction。
 *
 * execute 完成后 status=executing，下一步是 test（不是 execute）。
 * 终态（closed/aborted）为 undefined。
 */
export const WAVE_STATUS_TO_ACTION: Readonly<Record<string, string | undefined>> = {
  created: "design",
  designing: "design",
  "design-reviewed": "execute",
  executing: "test",
  tested: "exec-review",
  "exec-reviewed": "retrospect",
  retrospected: "closeout",
  closed: undefined,
  aborted: undefined,
};

/**
 * planning（PlanningStatus，epic/feature/slice 共用）→ PlanningAction。
 *
 * planning 无 test/exec-review：execute 下沉子层后 status=executing，
 * 下一步直接是 retrospect。终态（closed/aborted）为 undefined。
 */
export const PLANNING_STATUS_TO_ACTION: Readonly<Record<string, string | undefined>> = {
  created: "design",
  designing: "design",
  "design-reviewed": "execute",
  executing: "retrospect",
  retrospected: "closeout",
  closed: undefined,
  aborted: undefined,
};

/** 终态 status 集合（frontier 不输出这些节点；render 不输出「下一步」段）。 */
export const TERMINAL_STATUSES = new Set(["closed", "aborted"]);

/** design-review action 之前的状态（design 尚未定稿）。
 *
 * created/designing——design-review 是 design→execute 的 gate，处于此两种状态的
 * unit 其 plan.files 尚不确定，跨 wave 冲突 gate 不应纳入。design-reviewed 及其之后的状态
 * 才算「已过 design-review」（plan.files 已定）。 */
export const PRE_DESIGN_REVIEW_STATUSES = new Set([
  "created",
  "designing",
]);

/** 判断 status 是否「已过 design-review」（plan 已定稿，plan.files 确定）。
 *
 * 派生自状态机单源：非终态 且 非 pre-design-review。被 design-review handler 的跨 wave
 * 冲突 gate 筛选兄弟 wave 时消费，避免各 handler 手抄 status 字面量数组——未来新增
 * design-review 之后的非终态 status 会自动跟进。 */
export function isPostDesignReview(status: string): boolean {
  return (
    !TERMINAL_STATUSES.has(status) && !PRE_DESIGN_REVIEW_STATUSES.has(status)
  );
}

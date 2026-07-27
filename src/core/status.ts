/**
 * v1 状态 + 变更记录（领域模型，零依赖）。
 *
 * 来源：v5 model §3.1/§3.2（状态枚举）、§4.4（StatusChange）、§5.6.1（AbandonedRef）。
 */
// ═══════════════════════════════════════════════════════════════
// 状态枚举
// ═══════════════════════════════════════════════════════════════

/** model §3.1 — PlanningUnit（epic/feature/slice）的 8 状态。本 topic 不实现 PlanningUnit 流程，但类型预留。 */
export type PlanningStatus =
  | "created"
  | "clarifying"
  | "planning"
  | "design-reviewed"
  | "executing"
  | "retrospected"
  | "closed"
  | "aborted";

/** model §3.2 — ExecutionUnit（wave）的 10 状态。 */
export type ExecutionStatus =
  | "created"
  | "clarifying"
  | "planning"
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
  /** 触发变更的 action（create/clarify/plan/.../replan/abort）。 */
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

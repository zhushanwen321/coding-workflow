/**
 * v1 guidance — planning retrospect 阶段模板（三层 PlanningUnit 共用）。
 *
 * 来源：v5 cli-and-guidance §4.x + design-v5-slice §7。
 *
 * 职责：定义 retrospect 阶段的一句话目标 + 关键约束。
 *      PlanningUnit 的 retrospect 兼验收子层交付（PlanningRetrospectData）+ 对照 design-review 回顾。
 *
 * 设计原则：与 WaveStageTemplate 同构。纯静态文本。
 */
import type { PlanningStageTemplate } from "./index.js";

/**
 * retrospect 阶段模板（验收子层 + 对照 design-review 回顾）。
 *
 * 三层共用 PlanningRetrospectData（含 deliveryVerdict / childUnitIdsEvidence / splitFulfillment，
 * 验收子层交付）。reviewedItems 必须覆盖 design-review 的所有 tradeoffs/risks id。
 */
export const PLANNING_RETROSPECT_TEMPLATE: PlanningStageTemplate = {
  goal: "复盘并验收子层交付。对照 design-review judgment 逐项回顾，填 PlanningRetrospectData。",
  constraint:
    "关键约束：reviewedItems 必须覆盖 design-review 的所有 id（tradeoffs/risks）；deliveryVerdict 据实填 delivered/partial/failed；splitFulfillment 逐条验收 split 的交付结果。",
};

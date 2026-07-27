/**
 * v1 guidance — planning design-review 阶段模板（三层 PlanningUnit 共用）。
 *
 * 来源：v5 cli-and-guidance §4.x + design-v5-slice §4。
 *
 * 职责：定义 design-review 阶段的一句话目标 + 关键约束。
 *      designReviewJudgment 的 5 字段（necessity/sufficiency/alternatives/tradeoffs/risks）必填，
 *      layerSpecific 非空（各层专属判断）。
 *
 * 设计原则：与 WaveStageTemplate 同构。纯静态文本。
 */
import type { PlanningStageTemplate } from "./index.js";

/**
 * design-review 阶段模板（写 designReviewJudgment）。
 *
 * 三层共用同一 DesignReviewJudgment 结构，layerSpecific 各层不同
 *（wave=WaveDesignReviewLayerSpecific，slice=SliceDesignReviewLayerSpecific，feature/epic 各自专属）。
 */
export const PLANNING_DESIGN_REVIEW_TEMPLATE: PlanningStageTemplate = {
  goal: "设计审查。对照需求验 plan 是否必要、充分、MECE、有替代/取舍/风险。",
  constraint:
    "关键约束：designReviewJudgment 的 5 个字段都必须填（necessity/sufficiency/alternatives/tradeoffs/risks）；layerSpecific 不能为空（各层专属判断）；tradeoffs 和 risks 的 id 会被后续 retrospect 引用。",
};

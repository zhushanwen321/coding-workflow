/**
 * v1 guidance — planning closeout 阶段模板（三层 PlanningUnit 共用）。
 *
 * 来源：v5 cli-and-guidance §4.x + design-v5-slice §8。
 *
 * 职责：定义 closeout 阶段的一句话目标 + 关键约束。
 *      补 evidence 主观部分 + artifacts 校验 + 冻结。
 *
 * 设计原则：与 WaveStageTemplate 同构。纯静态文本。
 */
import type { PlanningStageTemplate } from "./index.js";

/**
 * closeout 阶段模板（evidence 冻结 + artifacts 校验）。
 *
 * 三层共用：closeout 后 evidence.frozenAt 填入，整个 evidence 不可再改；
 * cw 校验每个 artifacts[].ref 是否存在。
 */
export const PLANNING_CLOSEOUT_TEMPLATE: PlanningStageTemplate = {
  goal: "冻结交付，补充 evidence 主观部分（summary + artifacts）。",
  constraint:
    "关键约束：closeout 后 evidence.frozenAt 填入，整个 evidence 不可再改；cw 会校验每个 artifacts[].ref 是否存在。",
};

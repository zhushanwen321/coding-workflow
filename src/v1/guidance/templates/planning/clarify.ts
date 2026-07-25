/**
 * v1 guidance — planning clarify 阶段模板（三层 PlanningUnit 共用）。
 *
 * 来源：v5 cli-and-guidance §4.x + wave WAVE_CLARIFY_TEMPLATE 的 planning 对应。
 *
 * 职责：定义 PlanningUnit（slice/feature/epic）clarify 阶段的一句话目标 + 关键约束。
 *      progressive append 语义三层一致（Clarification 追加，不改历史）。
 *
 * 设计原则：与 WaveStageTemplate 同构（goal + constraint）。纯静态文本，零动态内容。
 */
import type { PlanningStageTemplate } from "./index.js";

/**
 * clarify 阶段模板（progressive append clarifications）。
 *
 * 三层共用：slice 接收 Clarification[]（裸数组），feature 接收 FeatureClarification
 *（{ clarifications, spec } 容器），epic 同 slice 裸数组。progressive append 语义一致。
 */
export const PLANNING_CLARIFY_TEMPLATE: PlanningStageTemplate = {
  goal: "澄清需求边界，补充 clarifications（progressive，可多次追加）。",
  constraint:
    "关键约束：clarifications 是 append-only——只能追加，不能改历史条目；feature 层额外需填 spec（FeatureSpec）。\n" +
    "spec.functionalRequirements[].ac 必填（引用 AC id 的 string 数组），是 FR-AC 强引用 gate 的基础；" +
    "缺失 ac 会在 design-review 阶段崩溃。示例：\n" +
    'FR: { id: "FR1", status: "active", title: "...", detail: "...", ac: ["AC1"] }\n' +
    'AC: { id: "AC1", status: "active", condition: "系统应...", verification: "review" }',
};

/**
 * v1 guidance — planning design 阶段模板（三层 PlanningUnit 共用）。
 *
 * 来源：v5 cli-and-guidance §4.x + §6.1（replan 三层渐进第 1 层：告知选项）+
 *      design-v5-slice §2（SlicePlan）/ feature §3（feature Plan 基类）。
 *
 * 职责：定义 design 阶段的一句话目标 + 关键约束。design 合并了原 clarify 与 plan 两阶段——
 *      同时接收 clarifications（progressive append 澄清）与 Split/技术方案（写 plan），
 *      故本模板吸收原 PLANNING_CLARIFY_TEMPLATE 的 goal+constraint（去重，append-only 语义）。
 *      §6 replan 第 1 层告知保留——design 阶段必须告知 agent：split 非空 + 条目 execute 后
 *      冻结 + replan 是改 plan 唯一途径。
 *
 * 设计原则：与 WaveStageTemplate 同构。纯静态文本。
 */
import type { PlanningStageTemplate } from "./index.js";

/**
 * design 阶段模板（clarifications 澄清 + 写 Split + 各层技术方案）。
 *
 * 三层差异：slice 写 techChoices/interfaces/dataModels/errorSpecs + split（拆 wave）；
 * feature/epic 只写 split（拆下层）。共性：clarifications append-only + split 不能为空 +
 * 冻结契约 + replan 选项存在。
 *
 * ADR-0010 补充：design input 带 --abandonParentItems 可声明脱离 parent 条目（设计阶段就能用，
 * 不必等到 execute 才发现——设计阶段发现就该声明，早声明早豁免后续 parent replan 的级联误伤）。
 */
export const PLANNING_DESIGN_TEMPLATE: PlanningStageTemplate = {
  goal:
    "澄清需求边界（补充 clarifications，progressive 可多次追加），编写计划定义 split（拆下层清单）；" +
    "slice 层额外写技术方案（techChoices/interfaces/dataModels/errorSpecs）。",
  constraint:
    "关键约束：clarifications 是 append-only——只能追加，不能改历史条目；" +
    "feature 层额外需填 spec（FeatureSpec）：spec.functionalRequirements[].ac 必填（引用 AC id 的 string 数组），" +
    "是 FR-AC 强引用 gate 的基础；缺失 ac 会在 design-review 阶段崩溃。示例：\n" +
    'FR: { id: "FR1", status: "active", title: "...", detail: "...", ac: ["AC1"] }\n' +
    'AC: { id: "AC1", status: "active", condition: "系统应...", verification: "review" }\n' +
    "split 不能为空；条目一旦 execute 就被冻结（append-only），修改只能走 replan（replan 是改 plan 的唯一途径）。" +
    "如果你设计 design 时发现 parent 的某个条目实际不适用（如 slice 发现 feature 的某个 AC 不可行、wave 发现 slice 的 interface 定义错了），" +
    "在 design input 里带 abandonParentItems: [\"<条目id>\"] 声明脱离（CLI 用 --abandonParentItems '[\"TC1\"]'）。" +
    "这是 append-only 的——一旦声明不可撤回。不确定是否需要脱离时不要声明——错误声明不可撤回，会让本该被 abort 的单元逃过级联。声明后后续 parent replan 废弃该条目时，cw 不会误 abort 你（基于历史 basedOnParent 的级联判定会跳过你）。" +
    "设计阶段（design/design-review）发现就该声明，不必等到 execute——早声明早豁免，避免后续 parent replan 的级联误伤。",
};

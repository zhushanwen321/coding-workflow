/**
 * v1 guidance — planning plan 阶段模板（三层 PlanningUnit 共用）。
 *
 * 来源：v5 cli-and-guidance §4.x + §6.1（replan 三层渐进第 1 层：告知选项）+
 *      design-v5-slice §2（SlicePlan）/ feature §3（feature Plan 基类）。
 *
 * 职责：定义 plan 阶段的一句话目标 + 关键约束。含 §6 replan 第 1 层告知——
 *      plan 阶段必须告知 agent：split 非空 + 条目 execute 后冻结 + replan 是改 plan 唯一途径。
 *
 * 设计原则：与 WaveStageTemplate 同构。纯静态文本。
 */
import type { PlanningStageTemplate } from "./index.js";

/**
 * plan 阶段模板（写 Split + 各层技术方案）。
 *
 * 三层差异：slice 写 techChoices/interfaces/dataModels/errorSpecs + split（拆 wave）；
 * feature/epic 只写 split（拆下层）。共性：split 不能为空 + 冻结契约 + replan 选项存在。
 *
 * ADR-0010 补充：plan input 带 --abandonParentItems 可声明脱离 parent 条目（设计阶段就能用，
 * 不必等到 execute 才发现——设计阶段发现就该声明，早声明早豁免后续 parent replan 的级联误伤）。
 */
export const PLANNING_PLAN_TEMPLATE: PlanningStageTemplate = {
  goal: "编写计划，定义 split（拆下层清单）；slice 层额外写技术方案（techChoices/interfaces/dataModels/errorSpecs）。",
  constraint:
    "关键约束：split 不能为空；条目一旦 execute 就被冻结（append-only），修改只能走 replan（replan 是改 plan 的唯一途径）。" +
    "如果你设计 plan 时发现 parent 的某个条目实际不适用（如 slice 发现 feature 的某个 AC 不可行、wave 发现 slice 的 interface 定义错了），" +
    "在 plan input 里带 abandonParentItems: [\"<条目id>\"] 声明脱离（CLI 用 --abandonParentItems '[\"TC1\"]'）。" +
    "这是 append-only 的——一旦声明不可撤回。不确定是否需要脱离时不要声明——错误声明不可撤回，会让本该被 abort 的单元逃过级联。声明后后续 parent replan 废弃该条目时，cw 不会误 abort 你（基于历史 basedOnParent 的级联判定会跳过你）。" +
    "设计阶段（plan/design-review）发现就该声明，不必等到 execute——早声明早豁免，避免后续 parent replan 的级联误伤。",
};

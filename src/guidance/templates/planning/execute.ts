/**
 * v1 guidance — planning execute 阶段模板（三层 PlanningUnit 共用）。
 *
 * 来源：v5 cli-and-guidance §4.x + design-v5-slice §5（slice execute 下沉 wave）。
 *
 * 职责：定义 execute 阶段的一句话目标 + 关键约束。
 *      PlanningUnit 的 execute 不写代码（wave 才写）——按 plan.split 自动创建子层 unit（下沉导航）。
 *
 * 设计原则：与 WaveStageTemplate 同构。纯静态文本。
 */
import type { PlanningStageTemplate } from "./index.js";

/**
 * execute 阶段模板（按 plan.split 自动下沉创建子层 unit）。
 *
 * 三层差异：slice execute 下沉创建 child wave；feature execute 下沉创建 child slice；
 * epic execute 下沉创建 child feature。共性：execute 是 plan 冻结点，按 split 自动创建子层。
 */
export const PLANNING_EXECUTE_TEMPLATE: PlanningStageTemplate = {
  goal: "按 plan.split 自动创建子层 unit（下沉导航），不直接写代码。",
  constraint:
    "关键约束：execute 是 plan 的冻结点——split 条目从此被冻结（append-only），修改只能走 replan；execute 不接收 input（按 split 自动创建 child，cw 返回 crossLayer.descend 导航）。" +
    "【递归下沉】execute 已创建子 unit。execute 本身是编排决策（主 agent 完成，不委派）。下沉到子层后，子层的后续 action（从 clarify 开始）适合委派递归 subagent（详见 AGENTS.md「递归子 agent 编排模板」）。若 guidance 含「## 并行调度」段（parallelTargets 有多个就绪目标），并行创建子 subagent 分别推进子层。",
};

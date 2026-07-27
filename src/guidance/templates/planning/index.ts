/**
 * v1 guidance — planning 静态方法论模板（三层 PlanningUnit：slice/feature/epic）。
 *
 * 来源：v5 cli-and-guidance §4.x + design-v5-slice/feature/epic 各阶段方法论。
 *
 * 职责：每个 PlanningAction 一个模板，含「一句话目标」+「关键约束」段。纯静态文本，零动态内容
 *      （schema 由 schema-injector 注入，prefix 由 prefix-builder 注入，命令由调用方填）。
 *
 * 设计原则（§3.2）：模板只放「agent 主动决策需要的」信息。与 wave 的 WAVE_STAGE_TEMPLATES
 *      完全同构（WaveStageTemplate → PlanningStageTemplate）。PlanningUnit 7 步流程
 *      （无 test/exec-review，由 child wave 承担）故只有 6 个阶段模板（无 replan 模板——
 *      replan 的 guidance 复用 plan 模板的 constraint 段，w2 接入时处理）。
 *
 * 对应文件：wave → templates/wave.ts；planning → 本目录。
 */

/**
 * planning 阶段模板：一句话目标 + 关键约束段。
 *
 * 与 WaveStageTemplate 完全同构（goal + constraint）。
 *
 * - goal：填入正常 guidance「下一步」段的「一句话目标」。
 * - constraint：填入「input schema + 关键约束」段的关键约束文本（可空）。
 */
export interface PlanningStageTemplate {
  /** 一句话目标（填正常 guidance 的「下一步」段第一行）。 */
  goal: string;
  /** 关键约束段（填正常 guidance 的「关键约束」部分；无约束时为空字符串）。 */
  constraint: string;
}

// ═══════════════════════════════════════════════════════════════
// 各阶段模板（6 阶段主链）
// ═══════════════════════════════════════════════════════════════

export { PLANNING_CLARIFY_TEMPLATE } from "./clarify.js";
export { PLANNING_CLOSEOUT_TEMPLATE } from "./closeout.js";
export { PLANNING_DESIGN_REVIEW_TEMPLATE } from "./design-review.js";
export { PLANNING_EXECUTE_TEMPLATE } from "./execute.js";
export { PLANNING_PLAN_TEMPLATE } from "./plan.js";
export { PLANNING_RETROSPECT_TEMPLATE } from "./retrospect.js";

import { PLANNING_CLARIFY_TEMPLATE } from "./clarify.js";
import { PLANNING_CLOSEOUT_TEMPLATE } from "./closeout.js";
import { PLANNING_DESIGN_REVIEW_TEMPLATE } from "./design-review.js";
import { PLANNING_EXECUTE_TEMPLATE } from "./execute.js";
import { PLANNING_PLAN_TEMPLATE } from "./plan.js";
import { PLANNING_RETROSPECT_TEMPLATE } from "./retrospect.js";

/**
 * planning 各 action 名 → 对应阶段模板。
 *
 * create 无 guidance（入口 action，下一步即 clarify）。replan 复用 plan 模板的 constraint
 *（replan 改完 plan 重走 design-review，§6.1）——w2 接入时由调用方决定是否单独取 constraint。
 *
 * key 是 PlanningAction 名（create/clarify/plan/design-review/execute/retrospect/closeout/abort/replan），
 * create/abort/replan 无独立模板（undefined），查表时调用方自行降级。
 */
export const PLANNING_STAGE_TEMPLATES: Readonly<Record<string, PlanningStageTemplate>> = {
  clarify: PLANNING_CLARIFY_TEMPLATE,
  plan: PLANNING_PLAN_TEMPLATE,
  "design-review": PLANNING_DESIGN_REVIEW_TEMPLATE,
  execute: PLANNING_EXECUTE_TEMPLATE,
  retrospect: PLANNING_RETROSPECT_TEMPLATE,
  closeout: PLANNING_CLOSEOUT_TEMPLATE,
};

/**
 * prompts 模块入口 — 聚合所有阶段提示词。
 *
 * 提示词与 state-machine.ts 强耦合（guidance 内容直接拼进 nextAction 返回），
 * 故放 src/prompts/ 而非外部文档。engine 不假设调用方有 skill 加载机制。
 */

export { CLARIFY_PROMPT } from "./clarify.js";
export { CONFIRM_CLARIFY_PROMPT } from "./confirm-clarify.js";
export { DEV_PLAN_PROMPT, PLAN_PROMPT } from "./dev-plan.js";
export { EXECUTE_PROMPT } from "./execute.js";
export { EXISTENCE_PLAN_PROMPT } from "./existence-plan.js";
export { NO_VERIFY_PROMPT } from "./no-verify.js";
export { PLAN_REVIEW_PROMPT } from "./plan-review.js";
export { RETROSPECT_PROMPT } from "./retrospect.js";
export { REVIEW_PROMPT } from "./review.js";
export { SPEC_REVIEW_PROMPT } from "./spec-review.js";
export { TDD_PLAN_PROMPT } from "./tdd-plan.js";

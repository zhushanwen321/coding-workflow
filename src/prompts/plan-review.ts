/**
 * plan_review 提示词 — plan gate 通过后返回，指导 agent 审查 plan 是否完整覆盖 spec、架构是否合理。
 *
 * 触发点：state-machine.ts buildNextAction 的 plan / plan_review / plan_review_fix 分支。
 * 交付物：plan_review issues（通过 stdin 传入的结构化问题清单），由 cw(plan_review) 消费。
 *
 * W3 占位版本：空字符串，W5 填充实际内容。
 */
export const PLAN_REVIEW_PROMPT = ``;

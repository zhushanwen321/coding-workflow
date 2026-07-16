/**
 * spec_review 提示词 — clarify_confirmed 后返回，指导 agent 审查 spec 的完整性和合理性。
 *
 * 触发点：state-machine.ts buildNextAction 的 confirm_clarify / spec_review / spec_review_fix 分支。
 * 交付物：spec_review issues（通过 stdin 传入的结构化问题清单），由 cw(spec_review) 消费。
 *
 * W3 占位版本：空字符串，W5 填充实际内容。
 */
export const SPEC_REVIEW_PROMPT = ``;

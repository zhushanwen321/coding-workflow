/**
 * v1 guidance — wave（ExecutionUnit）9 阶段 + replan 的静态方法论模板。
 *
 * 来源：v5 cli-and-guidance §4.x（正常 guidance 示例）+ §6.1（replan 第 3 层）+
 *      design-v5-wave §1-§8（各阶段方法论）。
 *
 * 职责：每个阶段一个模板，含「一句话目标」+「关键约束」段。纯静态文本，零动态内容
 *      （schema 由 schema-injector 注入，prefix 由 prefix-builder 注入，命令由调用方填）。
 *      build-guidance 负责把 templateText 和 schema/prefix/command 组装成最终 guidance。
 *
 * 设计原则（§3.2）：模板只放「agent 主动决策需要的」信息——agent 不看就会漏掉某个动作的信息
 *      （如 plan 阶段必须告知「条目 execute 后冻结 + replan 是改 plan 的唯一途径」）。
 *      cw 主动返回的信息（gate 结果等）由异常 guidance 在 fail 时给，不放这里。
 */

/**
 * wave 阶段模板：一句话目标 + 关键约束段。
 *
 * - goal：填入正常 guidance「下一步」段的「一句话目标」。
 * - constraint：填入「input schema + 关键约束」段的关键约束文本（可空）。
 */
export interface WaveStageTemplate {
  /** 一句话目标（填正常 guidance 的「下一步」段第一行）。 */
  goal: string;
  /** 关键约束段（填正常 guidance 的「关键约束」部分；无约束时为空字符串）。 */
  constraint: string;
}

// ═══════════════════════════════════════════════════════════════
// 各阶段模板（9 阶段主链 + replan 旁路）
// ═══════════════════════════════════════════════════════════════

/** clarify 阶段（progressive append clarifications）。 */
export const WAVE_CLARIFY_TEMPLATE: WaveStageTemplate = {
  goal: "澄清需求边界，补充 clarifications（progressive，可多次追加）。",
  constraint: "clarifications 是 append-only——只能追加，不能改历史条目。",
};

/**
 * plan 阶段（写 WavePlan 4 类条目）。
 *
 * 关键约束（§4.1）：testCases 不能为空 + 冻结契约 + replan 选项存在。
 * 这是 §6 replan 三层渐进的「第 1 层：告知选项」——plan 阶段必须告知 replan 存在，
 * 否则 agent 遇到 plan 问题时不知道能改。
 */
export const WAVE_PLAN_TEMPLATE: WaveStageTemplate = {
  goal: "编写执行计划，定义 testCases / tasks / files / contracts。",
  constraint:
    "关键约束：testCases 不能为空；条目一旦 execute 就被冻结，修改只能走 replan。",
};

/** design-review 阶段（7 gate + 写 designReviewJudgment）。 */
export const WAVE_DESIGN_REVIEW_TEMPLATE: WaveStageTemplate = {
  goal: "设计审查。对照 testCases 验 plan 是否必要、充分、MECE、有替代/取舍/风险。",
  constraint:
    "关键约束：designReviewJudgment 的每个字段都必须填（necessity/sufficiency/alternatives/tradeoffs/risks）；tradeoffs 和 risks 的 id 会被后续 test/retrospect 引用。",
};

/**
 * execute 阶段（写代码 + commitHash 关联 + evidence 客观字段）。
 *
 * §4.1 / design-v5-wave §4。execute 是 plan 冻结点——条目从此不可改。
 */
export const WAVE_EXECUTE_TEMPLATE: WaveStageTemplate = {
  goal: "写代码并提交，把 commitHash 关联到 wave（evidence 客观字段同时生成）。",
  constraint:
    "关键约束：execute 是 plan 的冻结点——条目从此被冻结（append-only），修改只能走 replan；commitHash 必须真实存在（cw 会校验）。",
};

/** test 阶段（跑测试 + 3 gate + 写 testJudgment）。 */
export const WAVE_TEST_TEMPLATE: WaveStageTemplate = {
  goal: "代码品味审查的前置：先确认功能对（cw 自动跑测试），再填 testJudgment 对照 design-review 验收。",
  constraint:
    "关键约束：tradeoffCostRealized 的 tradeoffRef 和 riskOutcome 的 riskRef 必须引用 design-review 里定义过的 id。",
};

/** exec-review 阶段（4 gate + 写 execReviewJudgment，纯人审代码品味）。 */
export const WAVE_EXEC_REVIEW_TEMPLATE: WaveStageTemplate = {
  goal: "代码品味审查（可读性/架构/代码味道），overallVerdict=pass 或 needs-followup。",
  constraint:
    "关键约束：score 是 1-5 整数；overallVerdict=needs-followup 时 followupActions 不能为空。",
};

/** retrospect 阶段（2 gate + 写 retrospectData，对照 design-review 逐项回顾）。 */
export const WAVE_RETROSPECT_TEMPLATE: WaveStageTemplate = {
  goal: "复盘。对照 design-review judgment 逐项回顾（necessity/sufficiency/alternatives + 每个 tradeoff/risk），提炼经验。",
  constraint:
    "关键约束：reviewedItems 必须覆盖 design-review 的所有 id（tradeoffs/risks 的 id 都要回顾）；outcome 据实填 fulfilled/unfulfilled/over-delivered。",
};

/** closeout 阶段（补 evidence 主观部分 + drift 检查 + 冻结）。 */
export const WAVE_CLOSEOUT_TEMPLATE: WaveStageTemplate = {
  goal: "冻结交付，补充 evidence 主观部分（summary + artifacts）。",
  constraint:
    "关键约束：closeout 后 evidence.frozenAt 填入，整个 evidence 不可再改；cw 会校验每个 artifacts[].ref 是否存在。",
};

/**
 * replan 第 3 层模板（replan action 触发后的 guidance，§6.1）。
 *
 * replan 的完整操作细节——agent 决定 replan 了才需要知道。
 * 含「重走 design-review」提示（design-v5-wave §8.3 用户决策）。
 */
export const WAVE_REPLAN_TEMPLATE: WaveStageTemplate = {
  goal:
    "replan 已废弃指定条目并计算影响面。重新编写 plan，把废弃条目的意图承接进新条目。",
  constraint:
    "关键约束：replan 改完 plan 后必须重新 design-review（plan → design-review → execute 完整重走），designReviewJudgment 要刷新匹配新 plan；废弃条目标 status=\"abandoned\" 保留（append-only，不可删不可复活）。",
};

// ═══════════════════════════════════════════════════════════════
// 阶段名 → 模板 查找表（build-guidance 用）
// ═══════════════════════════════════════════════════════════════

/** wave 各 action 名 → 对应阶段模板。create 无 guidance（入口 action，下一步即 clarify）。 */
export const WAVE_STAGE_TEMPLATES: Readonly<Record<string, WaveStageTemplate>> = {
  clarify: WAVE_CLARIFY_TEMPLATE,
  plan: WAVE_PLAN_TEMPLATE,
  "design-review": WAVE_DESIGN_REVIEW_TEMPLATE,
  execute: WAVE_EXECUTE_TEMPLATE,
  test: WAVE_TEST_TEMPLATE,
  "exec-review": WAVE_EXEC_REVIEW_TEMPLATE,
  retrospect: WAVE_RETROSPECT_TEMPLATE,
  closeout: WAVE_CLOSEOUT_TEMPLATE,
  replan: WAVE_REPLAN_TEMPLATE,
};

/**
 * v1 rules 领域规则统一导出（wave 层纯函数规则集）。
 *
 * 来源：v5 wave 附录 A（状态机 + 各阶段 gate 清单）、model §5.6（replan 机制 + append-only）。
 *
 * 层职责：rules 层是 wave 领域的纯函数规则——状态转换表 / gate 校验 / freeze 校验 / 影响面计算。
 *      零 IO（所有外部数据通过参数注入，如 git 校验 / 测试结果）。
 *
 * 模块索引：
 * - state-machine：WAVE_TRANSITIONS 状态转换表 + guardWave + nextWaveStatus + isWaveTerminal
 * - gates/：各阶段 gate（design-review / test / exec-review / retrospect）
 * - freeze：replan 时 append-only 不变量校验（checkFreeze）
 * - replan：replan 影响面计算（computeImpact）
 */
// 状态机（wave 附录 A §9）
export type {
  GuardVerdict,
  WaveAction,
  WaveTransition,
} from "./state-machine.js";
export {
  guardWave,
  isWaveTerminal,
  nextWaveStatus,
  WAVE_TRANSITIONS,
} from "./state-machine.js";

// gate 共享类型
export type { GateResult } from "./gates/types.js";

// design-review 阶段 gate（wave 附录 A §11 / §2.7）
export {
  designReviewAlternativesNonEmpty,
  designReviewNecessityNonEmpty,
  designReviewRisksPresent,
  designReviewSufficiencyComplete,
  designReviewTradeoffsPresent,
  testCasesHaveExpected,
  testCasesNonEmpty,
} from "./gates/design-review.js";

// test 阶段 gate（wave 附录 A §11 / §5.5）
export type { GitValidator } from "./gates/test.js";
export {
  commitExists,
  testReferencesDesignReview,
  testsAllPass,
} from "./gates/test.js";

// exec-review 阶段 gate（wave 附录 A §11 / §6.4）
export {
  execReviewArchitectureNonEmpty,
  execReviewFollowupActionsWhenNeeded,
  execReviewOverallVerdictNonEmpty,
  execReviewReadabilityNonEmpty,
} from "./gates/exec-review.js";

// retrospect 阶段 gate（wave 附录 A §11 / §7.3）
export {
  lessonsLearnedNonEmpty,
  retrospectCoversJudgments,
} from "./gates/retrospect.js";

// freeze（replan 时 append-only 校验）
export type { FreezeViolation } from "./freeze.js";
export { checkFreeze } from "./freeze.js";

// replan 影响面计算
export type { ReplanImpact } from "./replan.js";
export { computeImpact } from "./replan.js";

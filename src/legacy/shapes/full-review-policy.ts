/**
 * FullReviewPolicy —— 全量三阶段 review 策略实现。
 *
 * 对应 full-tdd shape 的 review 维度：spec_review + plan_review + review 三段全开，
 * dimensions 含代码审查的 6 个维度（review 阶段用）。
 *
 * spec/plan 审查的维度（completeness/consistency/...）由 stages 启用隐含——
 * 这里只列 review 阶段（代码审查）的维度，用于事后盲区统计。
 */

import type { ReviewDimension } from "../types.js";
import type { ReviewStage,ReviewStagePolicy } from "./types.js";

export class FullReviewPolicy implements ReviewStagePolicy {
  readonly id = "full-review";
  readonly stages: readonly ReviewStage[] = ["spec_review", "plan_review", "review"];
  /** 代码审查的 6 个维度（review 阶段用，不含 spec/plan 审查维度）。 */
  readonly dimensions: readonly ReviewDimension[] = [
    "type-safety",
    "error-handling",
    "edge-case",
    "test-coverage",
    "plan-completeness",
    "design-consistency",
  ];
}

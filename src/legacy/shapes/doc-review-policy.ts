/**
 * DocReviewPolicy —— doc-only shape 的 review 策略实现。
 *
 * 纯文档任务（写 ADR / README / 迁移文档）无代码风险，review 只看「设计一致性」——
 * 文档描述是否与实际系统行为一致（文档写错比不写更误导）。dimensions 只含 design-consistency。
 *
 * stages 只含 "review"（与 lean-review 一致，不走 spec/plan review）。
 */

import type { ReviewDimension } from "../types.js";
import type { ReviewStage,ReviewStagePolicy } from "./types.js";

export class DocReviewPolicy implements ReviewStagePolicy {
  readonly id = "doc-review";
  readonly stages: readonly ReviewStage[] = ["review"];
  /** 文档任务聚焦单一维度：设计一致性（文档描述 vs 实际系统行为）。 */
  readonly dimensions: readonly ReviewDimension[] = ["design-consistency"];
}

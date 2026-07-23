/**
 * LeanReviewPolicy —— delete-only shape 的 review 策略实现。
 *
 * 删除任务（删旧文件 / 清理废弃代码）逻辑简单、风险低，只需单阶段 review（不走
 * spec_review / plan_review——那些在 plan 阶段已隐含覆盖）。dimensions 聚焦
 * 删除任务的易错点：设计一致性（删了 A 是否漏删依赖 A 的 B）+ 边界情况（删了
 * 配置文件是否破坏初始化路径）。
 *
 * stages 只含 "review"——与 full-review 的三段（spec_review + plan_review + review）
 * 区分。步骤 4 阶段裁剪后，stages 不含的阶段不仅是「review 维度不适用」，而是被
 * 状态机真正跳过：delete-only 的流程是 clarify → plan → tdd_plan → dev → review → test
 * → retrospect → closeout，spec_review/plan_review 阶段完全不进入（buildNextAction
 * 的 plan/replan case 用 isStageEnabled 判定后直接推到 tdd_plan）。
 */

import type { ReviewDimension } from "../types.js";
import type { ReviewStage,ReviewStagePolicy } from "./types.js";

export class LeanReviewPolicy implements ReviewStagePolicy {
  readonly id = "lean-review";
  readonly stages: readonly ReviewStage[] = ["review"];
  /** 删除任务聚焦的两个维度：设计一致性 + 边界情况。 */
  readonly dimensions: readonly ReviewDimension[] = [
    "design-consistency",
    "edge-case",
  ];
}

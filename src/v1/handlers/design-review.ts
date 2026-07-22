/**
 * v1 wave handler — design-review action（跑 7 个 gate + 写 designReviewJudgment）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、§2.7 + §11（WAVE_DESIGN_REVIEW_GATES 7 个 gate 清单）、
 *      state-machine WAVE_TRANSITIONS["design-review"]（progressive，planning/design-reviewed → design-reviewed）。
 *
 * 职责：
 * 1. 跑 7 个 design-review gate（2 个 testCases 结构 gate + 5 个 judgment 非空 gate）
 * 2. 任一 gate fail → 短路返回 ok=false + gateResults（不改 status、不 save、不写 judgment）
 * 3. 全 pass → 写 designReviewJudgment → status 流转（→ design-reviewed）→ save
 *
 * gate fail 短路语义：gate 是状态流转的前置条件，fail 时不改任何状态。
 */
import type { ExecutionUnit } from "../core/workunit.js";
import {
  designReviewAlternativesNonEmpty,
  designReviewNecessityNonEmpty,
  designReviewRisksPresent,
  designReviewSufficiencyComplete,
  designReviewTradeoffsPresent,
  testCasesHaveExpected,
  testCasesNonEmpty,
} from "../rules/gates/design-review.js";
import {
  appendFailRecord,
  buildFailureNextAction,
  buildNextAction,
  saveUnit,
  transitionStatus,
} from "./internal.js";
import type { ActionResult, DesignReviewInput,V1Deps } from "./types.js";

/**
 * 执行 design-review action。
 *
 * @param unit 已加载的 ExecutionUnit（status ∈ {planning, design-reviewed}）
 * @param input designReviewJudgment
 * @param deps 依赖注入（store / clock）
 */
export function handleDesignReview(
  unit: ExecutionUnit,
  input: DesignReviewInput,
  deps: V1Deps,
): ActionResult {
  // ── 跑 7 个 gate ──
  // 先跑 testCases 结构 gate（designReviewJudgment 还没写，先验 plan 产物）
  const gateResults = [
    testCasesNonEmpty(unit),
    testCasesHaveExpected(unit),
    designReviewNecessityNonEmpty(input.designReviewJudgment),
    designReviewSufficiencyComplete(input.designReviewJudgment),
    designReviewAlternativesNonEmpty(input.designReviewJudgment),
    designReviewTradeoffsPresent(input.designReviewJudgment),
    designReviewRisksPresent(input.designReviewJudgment),
  ];

  // 短路：任一 fail → 不改 status、不写 judgment，但 append fail 记录 + 异常 guidance
  const failed = gateResults.filter((g) => !g.passed);
  if (failed.length > 0) {
    const reason = failed.map((g) => g.report).join("; ");
    appendFailRecord(deps, unit, "design-review", reason);
    const { nextAction, failureCount } = buildFailureNextAction(
      unit,
      "design-review",
      reason,
    );
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `design-review gate failed: ${reason}`,
      nextAction,
      failureCount,
    };
  }

  // ── 全 pass：写 judgment → status 流转 → save ──
  unit.designReviewJudgment = input.designReviewJudgment;
  transitionStatus(unit, "design-review", deps.clock.now());

  saveUnit(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
    nextAction: buildNextAction(unit, "design-review"),
  };
}

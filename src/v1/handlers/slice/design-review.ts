/**
 * v1 slice handler — design-review action（跑 9 个 gate + 写 designReviewJudgment）。
 *
 * 设计来源：rules gates/design-review.runSliceDesignReviewGates（9 个 gate 清单）、
 * PLANNING_TRANSITIONS["design-review"]（progressive，planning/design-reviewed → design-reviewed）。
 *
 * 职责：
 * 1. 写 unit.designReviewJudgment = input.designReviewJudgment（先写，gate 里 layerSpecific 校验依赖它）
 * 2. 跑 runSliceDesignReviewGates(unit)（9 个 gate：3 结构 + 5 judgment + 1 layerSpecific）
 * 3. 任一 gate fail → 短路返回 ok=false（不流转 status、但 append fail 记录供 failureCount 派生）
 * 4. 全 pass → status 流转（→ design-reviewed）→ save
 *
 * gate fail 短路语义同 wave design-review：gate 是状态流转前置，fail 时不改 status。
 *
 * 与 wave design-review 的差异：
 * - judgment 先写后跑 gate（wave 的 layerSpecific 校验也在 judgment 写入后跑）
 * - 9 个 gate（wave 是 7 个），多 split DAG 无环 + layerSpecific 6 字段
 */
import type { Slice } from "../../core/workunit.js";
import { runSliceDesignReviewGates } from "../../rules/gates/design-review.js";
import type { ActionResult, DesignReviewInput, V1Deps } from "../types.js";
import {
  appendSliceFailRecord,
  buildSliceFailureNextAction,
  buildSliceNextAction,
  saveSlice,
  sliceTransition,
} from "./slice-internal.js";

/**
 * 执行 slice design-review action。
 *
 * @param unit 已加载的 Slice（status ∈ {planning, design-reviewed}）
 * @param input designReviewJudgment
 * @param deps 依赖注入（store / clock）
 */
export function handleDesignReviewSlice(
  unit: Slice,
  input: DesignReviewInput,
  deps: V1Deps,
): ActionResult {
  // 先写 judgment（gate 里 layerSpecificNonEmpty 依赖已写入的 designReviewJudgment.layerSpecific）
  unit.designReviewJudgment = input.designReviewJudgment;

  const gateResults = runSliceDesignReviewGates(unit);

  const failed = gateResults.filter((g) => !g.passed);
  if (failed.length > 0) {
    const reason = failed.map((g) => g.report).join("; ");
    appendSliceFailRecord(deps, unit, "design-review", reason);
    const { nextAction, failureCount } = buildSliceFailureNextAction(unit, "design-review");
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `slice design-review gate failed: ${reason}`,
      nextAction,
      failureCount,
    };
  }

  sliceTransition(unit, "design-review", deps.clock.now());

  saveSlice(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
    nextAction: buildSliceNextAction(unit, "design-review"),
  };
}

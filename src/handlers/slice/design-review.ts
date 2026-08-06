/**
 * v1 slice handler — design-review action（跑 14 个 gate + 写 designReviewJudgment）。
 *
 * 设计来源：rules gates/design-review.runSliceDesignReviewGates（14 个 gate 清单）、
 * PLANNING_TRANSITIONS["design-review"]（progressive，planning/design-reviewed → design-reviewed）。
 *
 * 职责：
 * 1. 写 unit.designReviewJudgment = input.designReviewJudgment（先写，gate 里 layerSpecific 校验依赖它）
 * 2. 跑 runSliceDesignReviewGates(unit)（14 个 gate：5 结构 + 3 决策/inherited + 5 judgment + 1 layerSpecific）
 * 3. 任一 gate fail → 短路返回 ok=false（不流转 status、但 append fail 记录供 failureCount 派生）
 * 4. 全 pass → status 流转（→ design-reviewed）→ save
 *
 * gate fail 短路语义同 wave design-review：gate 是状态流转前置，fail 时不改 status。
 *
 * 与 wave design-review 的差异：
 * - judgment 先写后跑 gate（wave 的 layerSpecific 校验也在 judgment 写入后跑）
 * - 14 个 gate（wave 是 10 个），多 split DAG 无环 + layerSpecific 6 字段
 */
import type { Slice } from "../../core/workunit.js";
import { runSliceDesignReviewGates } from "../../rules/gates/design-review.js";
import type { ActionResult, CwDeps,DesignReviewInput } from "../types.js";
import { validateInput } from "../validate-input.js";
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
  deps: CwDeps,
): ActionResult {
  validateInput("design-review", "slice", input);
  // 先写 judgment（gate 里 layerSpecificNonEmpty 依赖已写入的 designReviewJudgment.layerSpecific）
  unit.designReviewJudgment = input.designReviewJudgment;

  const gateResults = runSliceDesignReviewGates(unit);

  const failed = gateResults.filter((g) => !g.passed);
  if (failed.length > 0) {
    const reason = failed.map((g) => g.report).join("; ");
    appendSliceFailRecord(deps, unit, "design-review", reason);
    const { nextAction, failureCount } = buildSliceFailureNextAction(unit, "design-review", reason);
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

  const nextAction = buildSliceNextAction(unit, "design-review");
  // E6 warn gate surfacing：severity==="warn" 的 gate（如 inheritedItemIdsDeclared）passed=true，
  // 被上面 filter(!g.passed) 天然排除，其 report 默认被静默丢弃。成功路径在此把 warn report
  // 以独立「## 需注意」段追加进 guidance（不阻断流转），让 agent 看到软提醒。用 `## 需注意`
  // markdown 段（与 buildNormalGuidance 的 `## 段落` 结构一致），追加新段不破坏既有段落
  //（位置/下一步/schema+约束），下游消费者按段解析。
  const warnReports = gateResults
    .filter((g) => g.passed && g.severity === "warn")
    .map((g) => g.report);
  if (warnReports.length > 0) {
    nextAction.guidance += `\n\n## 需注意\n${warnReports.map((r) => `- ${r}`).join("\n")}`;
  }

  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
    nextAction,
  };
}

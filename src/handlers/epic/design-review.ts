/**
 * v1 epic handler — design-review action（跑 epic gate + 写 designReviewJudgment）。
 *
 * 设计来源：rules gates/design-review.runEpicDesignReviewGates（8 个 gate 清单）、
 * PLANNING_TRANSITIONS["design-review"]（progressive，planning/design-reviewed → design-reviewed）。
 *
 * 职责：
 * 1. 写 unit.designReviewJudgment = input.designReviewJudgment（先写，gate 里 layerSpecific 校验依赖它）
 * 2. 跑 runEpicDesignReviewGates(unit)（8 个 gate：split 结构 2 + judgment 5 + layerSpecific 1）
 * 3. 任一 gate fail → 短路返回 ok=false（不流转 status、但 append fail 记录供 failureCount 派生）
 * 4. 全 pass → status 流转（→ design-reviewed）→ save
 *
 * gate fail 短路语义同 slice/feature design-review：gate 是状态流转前置，fail 时不改 status。
 *
 * 与 feature design-review 的差异：
 * - 用 runEpicDesignReviewGates（不是 runFeatureDesignReviewGates）
 * - 8 个 gate（feature 是 10 个），epic 无 FR-AC 强引用校验（epic 不产 spec，无 FR/AC/UC），
 *   只有 split 结构（epicSplitNonEmpty/epicSplitDagValid）+ judgment 5 + layerSpecific 1
 */
import type { Epic } from "../../core/workunit.js";
import { runEpicDesignReviewGates } from "../../rules/gates/design-review.js";
import type { ActionResult, CwDeps,DesignReviewInput } from "../types.js";
import { validateInput } from "../validate-input.js";
import {
  appendEpicFailRecord,
  buildEpicFailureNextAction,
  buildEpicNextAction,
  epicTransition,
  saveEpic,
} from "./epic-internal.js";

/**
 * 执行 epic design-review action。
 *
 * @param unit 已加载的 Epic（status ∈ {planning, design-reviewed}）
 * @param input designReviewJudgment
 * @param deps 依赖注入（store / clock）
 */
export function handleDesignReviewEpic(
  unit: Epic,
  input: DesignReviewInput,
  deps: CwDeps,
): ActionResult {
  validateInput("design-review", "epic", input);
  // 先写 judgment（gate 里 epicLayerSpecificNonEmpty 依赖已写入的 designReviewJudgment.layerSpecific）
  unit.designReviewJudgment = input.designReviewJudgment;

  const gateResults = runEpicDesignReviewGates(unit);

  const failed = gateResults.filter((g) => !g.passed);
  if (failed.length > 0) {
    const reason = failed.map((g) => g.report).join("; ");
    appendEpicFailRecord(deps, unit, "design-review", reason);
    const { nextAction, failureCount } = buildEpicFailureNextAction(unit, "design-review", reason);
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `epic design-review gate failed: ${reason}`,
      nextAction,
      failureCount,
    };
  }

  epicTransition(unit, "design-review", deps.clock.now());

  saveEpic(deps, unit);

  const nextAction = buildEpicNextAction(unit, "design-review");
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

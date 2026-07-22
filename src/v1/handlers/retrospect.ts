/**
 * v1 wave handler — retrospect action（跑 2 个 gate + 写 retrospectData）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、§7.3 + §11（WAVE_RETROSPECT_GATES 2 个 gate）、
 *      model §5.8（reviewedItems ref 约定：裸字段→字段名，数组元素→元素 id）、
 *      state-machine WAVE_TRANSITIONS.retrospect（exec-reviewed → retrospected）。
 *
 * 职责：
 * 1. 跑 2 个 retrospect gate：
 *    - lessonsLearnedNonEmpty（没提炼经验的 retrospect 是失败的 retrospect）
 *    - retrospectCoversJudgments（reviewedItems 覆盖 designReviewJudgment 核心项）
 * 2. 任一 gate fail → 短路返回 ok=false + gateResults（不改 status、不 save、不写 retrospectData）
 * 3. 全 pass → 写 retrospectData → status 流转（→ retrospected）→ save
 *
 * gate fail 短路语义：gate 是状态流转前置，fail 时不改任何状态。
 */
import type { ExecutionUnit } from "../core/workunit.js";
import {
  lessonsLearnedNonEmpty,
  retrospectCoversJudgments,
} from "../rules/gates/retrospect.js";
import { saveUnit,transitionStatus } from "./internal.js";
import type { ActionResult, RetrospectInput,V1Deps } from "./types.js";

/**
 * 执行 retrospect action。
 *
 * @param unit 已加载的 ExecutionUnit（status = exec-reviewed）
 * @param input retrospectData
 * @param deps 依赖注入（store / clock）
 */
export function handleRetrospect(
  unit: ExecutionUnit,
  input: RetrospectInput,
  deps: V1Deps,
): ActionResult {
  // ── 跑 2 个 gate ──
  const gateResults = [
    lessonsLearnedNonEmpty(input.retrospectData),
    retrospectCoversJudgments(input.retrospectData, unit.designReviewJudgment),
  ];

  // 短路：任一 fail → 不改 status、不 save、不写 retrospectData
  const failed = gateResults.filter((g) => !g.passed);
  if (failed.length > 0) {
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `retrospect gate failed: ${failed.map((g) => g.report).join("; ")}`,
    };
  }

  // ── 全 pass：写 retrospectData → status 流转 → save ──
  unit.retrospectData = input.retrospectData;
  transitionStatus(unit, "retrospect", deps.clock.now());

  saveUnit(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
  };
}

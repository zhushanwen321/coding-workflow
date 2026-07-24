/**
 * v1 feature handler — retrospect action（查 child slice 状态 + 跑 6 个 gate + 写 retrospectData）。
 *
 * 设计来源：feature-internal.runFeatureRetrospectGates（6 个 gate 聚合，复用 slice 的 6 个子 gate）、
 * PLANNING_TRANSITIONS.retrospect（executing → retrospected）、core judgments.PlanningRetrospectData。
 *
 * 职责：
 * 1. 查 child slice 状态：deps.store.findChildren(unit.id) → 收集每个 child 的 status
 * 2. 写 unit.retrospectData = input.retrospectData
 * 3. 跑 runFeatureRetrospectGates(unit, childStatuses)（6 个 gate：allWavesClosed + lessons + cover + splitFulfillment + childUnitEvidence + deliveryVerdict）
 * 4. 任一 gate fail → 短路返回 ok=false（不流转 status、append fail 记录）
 * 5. 全 pass → status 流转（executing → retrospected）→ save
 *
 * rules 层零 IO：allWavesClosed 需查 child slice 状态，但 rules 不查 store，故 childStatuses 由
 * 本 handler 从 store 查询后注入（同 slice 版模式）。
 *
 * 与 slice retrospect 的差异：
 * - 用 runFeatureRetrospectGates（feature-internal 组装，rules/gates/retrospect.ts 无 feature 专用版）
 * - child 是 slice（slice 版 child 是 wave），allWavesClosed 语义不变（child 终态 = closed/aborted）
 * - gate 子函数完全复用（PlanningRetrospectData / Split[] / DesignReviewJudgment 类型与 slice 同型）
 */
import type { Feature } from "../../core/workunit.js";
import type { ActionResult, RetrospectFeatureInput, V1Deps } from "../types.js";
import {
  appendFeatureFailRecord,
  buildFeatureFailureNextAction,
  buildFeatureNextAction,
  featureTransition,
  runFeatureRetrospectGates,
  saveFeature,
} from "./feature-internal.js";

/**
 * 执行 feature retrospect action。
 *
 * @param unit 已加载的 Feature（status = executing）
 * @param input PlanningRetrospectData（含 splitFulfillment 验收子 slice）
 * @param deps 依赖注入（store / clock）
 */
export function handleRetrospectFeature(
  unit: Feature,
  input: RetrospectFeatureInput,
  deps: V1Deps,
): ActionResult {
  // ── 查 child slice 状态（rules 层零 IO，由 handler 注入 gate）──
  const children = deps.store.findChildren(unit.id);
  const childStatuses = children.map((c) => {
    const s = c.status;
    return typeof s === "string" ? s : "created";
  });

  // 先写 retrospectData（gate 里 splitFulfillmentCoversPlan 校验依赖已写入的 splitFulfillment）
  unit.retrospectData = input.retrospectData;

  const gateResults = runFeatureRetrospectGates(unit, childStatuses);

  const failed = gateResults.filter((g) => !g.passed);
  if (failed.length > 0) {
    const reason = failed.map((g) => g.report).join("; ");
    appendFeatureFailRecord(deps, unit, "retrospect", reason);
    const { nextAction, failureCount } = buildFeatureFailureNextAction(unit, "retrospect", reason);
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `feature retrospect gate failed: ${reason}`,
      nextAction,
      failureCount,
    };
  }

  featureTransition(unit, "retrospect", deps.clock.now());

  saveFeature(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
    nextAction: buildFeatureNextAction(unit, "retrospect"),
  };
}

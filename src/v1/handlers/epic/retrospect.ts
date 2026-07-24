/**
 * v1 epic handler — retrospect action（查 child feature 状态 + 跑 6 个 gate + 写 retrospectData）。
 *
 * 设计来源：epic-internal.runEpicRetrospectGates（6 个 gate 聚合，复用 slice/feature 的 6 个子 gate）、
 * PLANNING_TRANSITIONS.retrospect（executing → retrospected）、core judgments.PlanningRetrospectData。
 *
 * 职责：
 * 1. 查 child feature 状态：deps.store.findChildren(unit.id) → 收集每个 child 的 status
 * 2. 写 unit.retrospectData = input.retrospectData
 * 3. 跑 runEpicRetrospectGates(unit, childStatuses)（6 个 gate：allWavesClosed + lessons + cover + splitFulfillment + childUnitEvidence + deliveryVerdict）
 * 4. 任一 gate fail → 短路返回 ok=false（不流转 status、append fail 记录）
 * 5. 全 pass → status 流转（executing → retrospected）→ save
 *
 * rules 层零 IO：allWavesClosed 需查 child feature 状态，但 rules 不查 store，故 childStatuses 由
 * 本 handler 从 store 查询后注入（同 slice/feature 版模式）。
 *
 * 与 feature retrospect 的差异：
 * - 用 runEpicRetrospectGates（epic-internal 组装，rules/gates/retrospect.ts 无 epic 专用版）
 * - child 是 feature（feature 版 child 是 slice），allWavesClosed 语义不变（child 终态 = closed/aborted）
 * - gate 子函数完全复用（PlanningRetrospectData / Split[] / DesignReviewJudgment 类型与 feature 同型）
 */
import type { Epic } from "../../core/workunit.js";
import type { ActionResult, RetrospectFeatureInput, V1Deps } from "../types.js";
import {
  appendEpicFailRecord,
  buildEpicFailureNextAction,
  buildEpicNextAction,
  epicTransition,
  runEpicRetrospectGates,
  saveEpic,
} from "./epic-internal.js";

/**
 * 执行 epic retrospect action。
 *
 * @param unit 已加载的 Epic（status = executing）
 * @param input PlanningRetrospectData（含 splitFulfillment 验收子 feature）
 * @param deps 依赖注入（store / clock）
 */
export function handleRetrospectEpic(
  unit: Epic,
  input: RetrospectFeatureInput,
  deps: V1Deps,
): ActionResult {
  // ── 查 child feature 状态（rules 层零 IO，由 handler 注入 gate）──
  const children = deps.store.findChildren(unit.id);
  const childStatuses = children.map((c) => {
    const s = c.status;
    return typeof s === "string" ? s : "created";
  });

  // 先写 retrospectData（gate 里 splitFulfillmentCoversPlan 校验依赖已写入的 splitFulfillment）
  unit.retrospectData = input.retrospectData;

  const gateResults = runEpicRetrospectGates(unit, childStatuses);

  const failed = gateResults.filter((g) => !g.passed);
  if (failed.length > 0) {
    const reason = failed.map((g) => g.report).join("; ");
    appendEpicFailRecord(deps, unit, "retrospect", reason);
    const { nextAction, failureCount } = buildEpicFailureNextAction(unit, "retrospect", reason);
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `epic retrospect gate failed: ${reason}`,
      nextAction,
      failureCount,
    };
  }

  epicTransition(unit, "retrospect", deps.clock.now());

  saveEpic(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
    nextAction: buildEpicNextAction(unit, "retrospect"),
  };
}

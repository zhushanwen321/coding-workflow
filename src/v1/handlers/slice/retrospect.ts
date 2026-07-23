/**
 * v1 slice handler — retrospect action（查 child wave 状态 + 跑 4 个 gate + 写 retrospectData）。
 *
 * 设计来源：rules gates/retrospect.runSliceRetrospectGates(unit, childStatuses)（4 个 gate 清单）、
 * PLANNING_TRANSITIONS.retrospect（executing → retrospected）、core judgments.PlanningRetrospectData。
 *
 * 职责：
 * 1. 查 child wave 状态：deps.store.findChildren(unit.id) → 收集每个 child 的 status
 * 2. 写 unit.retrospectData = input.retrospectData
 * 3. 跑 runSliceRetrospectGates(unit, childStatuses)（4 个 gate：allWavesClosed + lessons + cover + splitFulfillment）
 * 4. 任一 gate fail → 短路返回 ok=false（不流转 status、append fail 记录）
 * 5. 全 pass → status 流转（executing → retrospected）→ save
 *
 * rules 层零 IO：allWavesClosed 需查 child wave 状态，但 rules 不查 store，故 childStatuses 由
 * 本 handler 从 store 查询后注入。
 *
 * 与 wave retrospect 的差异：
 * - 入参 PlanningRetrospectData（比 RetrospectData 宽：含 deliveryVerdict/splitFulfillment）
 * - 多查 child wave 状态注入 gate
 * - 4 个 gate（wave 是 2 个）
 */
import type { Slice } from "../../core/workunit.js";
import { runSliceRetrospectGates } from "../../rules/gates/retrospect.js";
import type { ActionResult, RetrospectSliceInput, V1Deps } from "../types.js";
import {
  appendSliceFailRecord,
  buildSliceFailureNextAction,
  buildSliceNextAction,
  saveSlice,
  sliceTransition,
} from "./slice-internal.js";

/**
 * 执行 slice retrospect action。
 *
 * @param unit 已加载的 Slice（status = executing）
 * @param input PlanningRetrospectData（含 splitFulfillment 验收子 wave）
 * @param deps 依赖注入（store / clock）
 */
export function handleRetrospectSlice(
  unit: Slice,
  input: RetrospectSliceInput,
  deps: V1Deps,
): ActionResult {
  // ── 查 child wave 状态（rules 层零 IO，由 handler 注入 gate）──
  const children = deps.store.findChildren(unit.id);
  const childStatuses = children.map((c) => {
    const s = c.status;
    return typeof s === "string" ? s : "created";
  });

  // 先写 retrospectData（gate 里 splitFulfillmentCoversPlan 校验依赖已写入的 splitFulfillment）
  unit.retrospectData = input.retrospectData;

  const gateResults = runSliceRetrospectGates(unit, childStatuses);

  const failed = gateResults.filter((g) => !g.passed);
  if (failed.length > 0) {
    const reason = failed.map((g) => g.report).join("; ");
    appendSliceFailRecord(deps, unit, "retrospect", reason);
    const { nextAction, failureCount } = buildSliceFailureNextAction(unit, "retrospect");
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `slice retrospect gate failed: ${reason}`,
      nextAction,
      failureCount,
    };
  }

  sliceTransition(unit, "retrospect", deps.clock.now());

  saveSlice(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
    nextAction: buildSliceNextAction(unit, "retrospect"),
  };
}

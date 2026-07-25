/**
 * v1 slice handler — plan action（写 SlicePlan 5 字段 + split + decisions 投影）。
 *
 * 设计来源：core plan.SlicePlan（techChoices/interfaces/dataModels/errorSpecs/split + decisions）、
 * core clarifications.Decision（投影自 Clarification，model §5.10）、
 * PLANNING_TRANSITIONS.plan（progressive，clarifying/planning/design-reviewed → planning）。
 *
 * 职责：
 * 1. 写 SlicePlan 5 字段：techChoices/interfaces/dataModels/errorSpecs/split
 * 2. decisions：input 提供 → 用；否则从 unit.clarifications 投影（每个有 resolution 的 Clarification
 *    生成一条 Decision，最小投影：id/decision/sourceClarification = Clarification.id，rationale 取 resolution）
 * 3. status 流转 → planning（progressive 原地）→ save
 *
 * 不跑独立 gate（split 结构在 design-review 阶段验，见 design-review.ts）。
 */
import type { Decision } from "../../core/clarifications.js";
import type { Slice } from "../../core/workunit.js";
import type { ActionResult, PlanSliceInput, V1Deps } from "../types.js";
import { buildSliceNextAction, saveSlice, sliceTransition } from "./slice-internal.js";

/**
 * 执行 slice plan action（progressive）。
 *
 * @param unit 已加载的 Slice（status ∈ {clarifying, planning, design-reviewed}）
 * @param input SlicePlan 5 字段 + split + 可选 decisions
 * @param deps 依赖注入（store / clock）
 */
export function handlePlanSlice(
  unit: Slice,
  input: PlanSliceInput,
  deps: V1Deps,
): ActionResult {
  const decisions = input.decisions ?? projectDecisionsFromClarifications(unit);

  unit.plan = {
    split: input.split,
    techChoices: input.techChoices,
    interfaces: input.interfaces,
    dataModels: input.dataModels,
    errorSpecs: input.errorSpecs,
    decisions,
  };

  sliceTransition(unit, "plan", deps.clock.now());

  saveSlice(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    nextAction: buildSliceNextAction(unit, "plan"),
  };
}

/**
 * 从 unit.clarifications 投影 Decision 列表（model §5.10）。
 *
 * 规则：每个有非空 resolution 的 Clarification 生成一条 Decision：
 *   - id = sourceClarification = Clarification.id
 *   - decision = resolution
 *   - rationale = resolution（最小投影——agent 可在后续 overwrite，无独立 rationale 字段时复用）
 *
 * 已答（resolution 非空）才投影；未答的跳过。
 */
function projectDecisionsFromClarifications(unit: Slice): Decision[] {
  const decisions: Decision[] = [];
  for (const c of unit.clarifications) {
    if (c.resolution === undefined || c.resolution.trim() === "") continue;
    decisions.push({
      id: c.id,
      decision: c.resolution,
      rationale: c.resolution,
      sourceClarification: c.id,
    });
  }
  return decisions;
}

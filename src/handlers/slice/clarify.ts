/**
 * v1 slice handler — clarify action（progressive append clarifications）。
 *
 * 设计来源：PLANNING_TRANSITIONS.clarify（progressive，created/clarifying → clarifying）。
 *
 * 职责：append input.clarifications 到 unit.clarifications → status 流转 → save。
 * progressive 语义：可重复触发，已 clarifying 时 status 原地。
 * 不跑 gate（只 append），guard 在 dispatch 层做。
 *
 * 与 wave clarify 同构（slice 的 clarifications 也是 Clarification[]）。
 */
import type { Slice } from "../../core/workunit.js";
import type { ActionResult, ClarifyInput, CwDeps } from "../types.js";
import { validateInput } from "../validate-input.js";
import { buildSliceNextAction, saveSlice, sliceTransition } from "./slice-internal.js";

/**
 * 执行 slice clarify action（progressive）。
 *
 * @param unit 已加载的 Slice（status ∈ {created, clarifying}）
 * @param input clarifications to append
 * @param deps 依赖注入（store / clock）
 */
export function handleClarifySlice(
  unit: Slice,
  input: ClarifyInput,
  deps: CwDeps,
): ActionResult {
  validateInput("clarify", "slice", input);
  // append clarifications（progressive，不覆盖历史）
  unit.clarifications = [...unit.clarifications, ...input.clarifications];

  sliceTransition(unit, "clarify", deps.clock.now());

  saveSlice(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    nextAction: buildSliceNextAction(unit, "clarify"),
  };
}

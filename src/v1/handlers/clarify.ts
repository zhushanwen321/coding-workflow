/**
 * v1 wave handler — clarify action（progressive append clarifications）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、state-machine WAVE_TRANSITIONS.clarify（progressive）。
 *
 * 职责：append input.clarifications 到 unit.clarifications → status 流转（created/clarifying → clarifying）
 *      → save。progressive 语义：可重复触发，已 clarifying 时 status 原地。
 *
 * 不变量：clarify 无 gate（只 append），guard 已在 dispatch 层做过。
 */
import type { ExecutionUnit } from "../core/workunit.js";
import { saveUnit,transitionStatus } from "./internal.js";
import type { ActionResult, ClarifyInput,V1Deps } from "./types.js";

/**
 * 执行 clarify action（progressive）。
 *
 * @param unit 已加载的 ExecutionUnit（status ∈ {created, clarifying}）
 * @param input clarifications to append
 * @param deps 依赖注入（store / clock）
 */
export function handleClarify(
  unit: ExecutionUnit,
  input: ClarifyInput,
  deps: V1Deps,
): ActionResult {
  // 写产物：append clarifications（progressive，不覆盖历史）
  unit.clarifications = [...unit.clarifications, ...input.clarifications];

  // status 流转：created/clarifying → clarifying（progressive 原地）+ append statusHistory
  transitionStatus(unit, "clarify", deps.clock.now());

  saveUnit(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
  };
}

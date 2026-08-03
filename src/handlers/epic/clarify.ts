/**
 * v1 epic handler — clarify action（progressive append clarifications）。
 *
 * 设计来源：PLANNING_TRANSITIONS.clarify（progressive，created/clarifying → clarifying）。
 *
 * 职责：append input.clarifications 到 unit.clarifications → status 流转 → save。
 * progressive 语义：可重复触发，已 clarifying 时 status 原地。
 * 不跑 gate（只 append），guard 在 dispatch 层做。
 *
 * 关键差异：epic 的 clarifications 是 Clarification[] 数组（同 slice/wave），不是 feature 的
 * FeatureClarification 容器对象——故 epic clarify 走数组 push（同 slice clarify），不走 feature
 * 的容器整体覆盖。epic 不产 spec（FR/AC/UC 是 feature 的事），clarify 产物只是战略决策的
 * Clarification 数组。
 */
import type { Epic } from "../../core/workunit.js";
import type { ActionResult, ClarifyInput, CwDeps } from "../types.js";
import { validateInput } from "../validate-input.js";
import { buildEpicNextAction, epicTransition, saveEpic } from "./epic-internal.js";

/**
 * 执行 epic clarify action（progressive append）。
 *
 * @param unit 已加载的 Epic（status ∈ {created, clarifying}）
 * @param input clarifications to append
 * @param deps 依赖注入（store / clock）
 */
export function handleClarifyEpic(
  unit: Epic,
  input: ClarifyInput,
  deps: CwDeps,
): ActionResult {
  validateInput("clarify", "epic", input);
  // append clarifications（progressive，不覆盖历史——同 slice 模式，非 feature 容器覆盖）
  unit.clarifications = [...unit.clarifications, ...input.clarifications];

  epicTransition(unit, "clarify", deps.clock.now());

  saveEpic(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    nextAction: buildEpicNextAction(unit, "clarify"),
  };
}

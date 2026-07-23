/**
 * v1 feature handler — clarify action（容器对象整体覆盖写入）。
 *
 * 设计来源：PLANNING_TRANSITIONS.clarify（progressive，created/clarifying → clarifying）、
 * core clarifications.FeatureClarification（容器对象 { clarifications, spec }）。
 *
 * 职责：整体覆盖写入 unit.clarifications → status 流转 → save。
 *
 * 与 slice/wave clarify 的关键差异：slice/wave 是 `unit.clarifications.push(...input.clarifications)`
 *（数组追加，progressive 累积）；feature 是容器对象整体覆盖写入
 * `unit.clarifications = { clarifications, spec }`——feature 的 clarify 产物形态不对称
 *（含 spec），agent 每次提交完整的 FeatureClarification，handler 直接覆盖（不追加）。
 * progressive 语义仍在：可重复触发，已 clarifying 时 status 原地。
 *
 * 不跑 gate（只覆盖写入），guard 在 dispatch 层做。
 */
import type { Feature } from "../../core/workunit.js";
import type { ActionResult, FeatureClarifyInput, V1Deps } from "../types.js";
import { buildFeatureNextAction, featureTransition, saveFeature } from "./feature-internal.js";

/**
 * 执行 feature clarify action（容器对象整体覆盖）。
 *
 * @param unit 已加载的 Feature（status ∈ {created, clarifying}）
 * @param input 完整的 FeatureClarification（clarifications + spec，整体覆盖写入）
 * @param deps 依赖注入（store / clock）
 */
export function handleClarifyFeature(
  unit: Feature,
  input: FeatureClarifyInput,
  deps: V1Deps,
): ActionResult {
  // 容器对象整体覆盖写入（feature 的 clarify 产物形态不对称，含 spec，非数组追加）
  unit.clarifications = {
    clarifications: input.clarifications,
    spec: input.spec,
  };

  featureTransition(unit, "clarify", deps.clock.now());

  saveFeature(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    nextAction: buildFeatureNextAction(unit, "clarify"),
  };
}

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
 * 结构校验：写入前先 validateFeatureSpec(input.spec)，畸形结构短路返回 ok=false
 * （参考 design-review 的 gate fail 短路：appendFeatureFailRecord + buildFeatureFailureNextAction，
 * 不改 status、不 save spec）。防 agent 提交缺 ac 数组的 FR 等畸形 spec 直接入库，
 * 到 design-review gate 访问 fr.ac.length 时 undefined 崩溃。
 */
import type { Feature } from "../../core/workunit.js";
import { validateFeatureSpec } from "../../rules/spec-schema.js";
import type { ActionResult, FeatureClarifyInput, V1Deps } from "../types.js";
import {
  appendFeatureFailRecord,
  buildFeatureFailureNextAction,
  buildFeatureNextAction,
  featureTransition,
  saveFeature,
} from "./feature-internal.js";

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
  // 写入前先校验 spec 结构（防畸形 spec 入库导致下游 gate undefined 崩溃）。
  // 校验失败短路：不覆盖 unit.clarifications.spec、不改 status，只 append fail 记录
  // 供 failureCount 派生，返回可读 error（含具体字段路径）让 agent 修正后重提。
  const validation = validateFeatureSpec(input.spec);
  if (!validation.valid) {
    const reason = `feature spec 结构校验失败: ${validation.errors.join("; ")}`;
    appendFeatureFailRecord(deps, unit, "clarify", reason);
    const { nextAction, failureCount } = buildFeatureFailureNextAction(unit, "clarify", reason);
    return {
      unitId: unit.id,
      status: unit.status,
      ok: false,
      error: reason,
      nextAction,
      failureCount,
    };
  }

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

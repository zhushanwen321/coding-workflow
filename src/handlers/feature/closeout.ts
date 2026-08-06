/**
 * v1 feature handler — closeout action（补 evidence 主观部分 + drift 检查 + 冻结 + 回溯父单元）。
 *
 * 设计来源：model §5.11.1（evidence 跨阶段生命周期）、
 * PLANNING_TRANSITIONS.closeout（retrospected → closed）、guidance cross-layer（closeout 后回溯）。
 *
 * 职责：
 * 1. 补 evidence 主观部分：summary（若有）+ artifacts（缺省保留原值）
 * 2. drift 检查：artifacts[].ref 非空且 deps.fileExists.exists(ref) 为 true，否则记 drift
 *    —— 有 drift → 短路返回 ok=false（不冻结、不流转 status）
 * 3. 冻结 evidence：写 frozenAt = now（之后整个 evidence 不可再改，rollup 也会跳过已冻结 parent）
 * 4. status 流转（retrospected → closed）→ save
 * 5. nextAction：action=undefined（终态）+ crossLayer.ascend（有 parent 回溯；无 parent 孤立终点）
 *
 * 与 slice closeout 的差异：crossLayer 用 ascend（feature closeout 后回父 epic），slice closeout
 * 回父 feature——两者都是 ascend 到父单元，逻辑同构。
 */
import { assertEvidenceNotFrozen } from "../../core/evidence.js";
import type { Feature } from "../../core/workunit.js";
import type { GateResult } from "../../rules/gates/types.js";
import { rollupChildDelivery } from "../rollup.js";
import type { ActionResult, CloseoutInput, CwDeps, CwNextAction } from "../types.js";
import { validateInput } from "../validate-input.js";
import {
  appendFeatureFailRecord,
  buildFeatureFailureNextAction,
  buildFeatureNextAction,
  featureTransition,
  saveFeature,
} from "./feature-internal.js";

/**
 * 执行 feature closeout action。
 *
 * @param unit 已加载的 Feature（status = retrospected）
 * @param input summary + artifacts（evidence 主观部分）
 * @param deps 依赖注入（store / clock / fileExists）
 */
export function handleCloseoutFeature(
  unit: Feature,
  input: CloseoutInput,
  deps: CwDeps,
): ActionResult {
  validateInput("closeout", "feature", input);
  // ── 检查 evidence 是否已冻结（防止重复 closeout） ──
  assertEvidenceNotFrozen(unit.evidence, "closeout");

  // ── 补 evidence 主观部分 ──
  if (input.summary !== undefined) {
    unit.evidence.summary = input.summary;
  }
  const artifacts = input.artifacts ?? unit.evidence.artifacts;
  unit.evidence.artifacts = artifacts;

  // ── drift 检查 ──
  const driftReports: string[] = [];
  for (const art of artifacts) {
    if (!art.ref || art.ref.trim() === "") {
      driftReports.push(`artifact(kind=${art.kind}) ref 为空（drift：交付物引用缺失）`);
      continue;
    }
    if (!deps.fileExists.exists(art.ref)) {
      driftReports.push(`artifact(kind=${art.kind}) ref="${art.ref}" 不存在（drift：交付物引用悬空）`);
    }
  }

  const gateResults: GateResult[] = [
    {
      passed: driftReports.length === 0,
      report:
        driftReports.length === 0
          ? `artifacts-drift-check: 全部 ${artifacts.length} 个 artifact ref 存在`
          : `artifacts-drift-check: ${driftReports.length} 个 artifact drift（${driftReports.join("; ")}）`,
    },
  ];

  if (driftReports.length > 0) {
    const reason = driftReports.join("; ");
    appendFeatureFailRecord(deps, unit, "closeout", reason);
    const { nextAction, failureCount } = buildFeatureFailureNextAction(unit, "closeout", reason);
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `feature closeout drift check failed: ${reason}`,
      nextAction,
      failureCount,
    };
  }

  // ── 冻结 evidence + status 流转 → closed ──
  const frozenAt = deps.clock.now();
  unit.evidence.frozenAt = frozenAt;
  featureTransition(unit, "closeout", frozenAt);

  saveFeature(deps, unit);

  // feature closeout 完成（status→closed）→ rollup 到 parent（epic）的 childDelivery。
  if (unit.parentUnitId !== undefined && unit.parentUnitId !== "") {
    rollupChildDelivery(deps, unit.id);
  }

  // ── crossLayer：回溯父单元（无 parent 则孤立终点；serial 模式）──
  // G5：recursive 模式（多 agent 并行 + steer 唤醒）不填 ascend——closeout 后该结束，
  // 让 steer 唤醒父 agent（不自己回溯）。serial 模式保持现状。
  // 注：该层 ascend 是 handler 内独立计算（最小回溯，不查 sibling），不走 cross-layer.ts 的
  // sibling/ascend 复合路由——故 recursive 抑制分支保留在此，不下沉到 cross-layer.ts。
  // （wave 层 sibling/ascend 复合路由的 recursive 抑制已下沉到 cross-layer.ts，v5 §五 line241。）
  const crossLayer: CwNextAction["crossLayer"] | undefined =
    deps.orchestration === "recursive"
      ? undefined
      : unit.parentUnitId !== undefined && unit.parentUnitId !== ""
        ? {
            kind: "ascend",
            targetUnitId: unit.parentUnitId,
            reason: `feature 已 closeout，回溯父单元 ${unit.parentUnitId}`,
          }
        : undefined;

  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
    nextAction: buildFeatureNextAction(unit, "closeout", {
      crossLayer,
      orchestration: deps.orchestration,
    }),
  };
}

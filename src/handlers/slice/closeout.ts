/**
 * v1 slice handler — closeout action（补 evidence 主观部分 + drift 检查 + 冻结 + 回溯父单元）。
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
 * drift 短路语义同 wave closeout：closeout 是终态转换（→ closed 不可逆），drift 不允许冻结。
 *
 * 与 wave closeout 的差异：
 * - crossLayer 探测就绪兄弟（§3.1.4.2）：有就绪兄弟 → sibling（锚定 parallelTargets[0]），
 *   无就绪兄弟 → ascend（回父 feature/epic），无 parent → undefined（孤立终点）。
 *   wave closeout 走 guidance 的 computeCrossLayerAfterCloseout（非终态判据）+ 守卫降级，
 *   slice 只用就绪判据驱动（天然无发散态）。
 */
import { assertEvidenceNotFrozen } from "../../core/evidence.js";
import type { Slice } from "../../core/workunit.js";
import { computeParallelSiblingsAfterCloseout } from "../../guidance/index.js";
import type { GateResult } from "../../rules/gates/types.js";
import { rollupChildDelivery } from "../rollup.js";
import type { ActionResult, CloseoutInput, CwDeps, CwNextAction } from "../types.js";
import { validateInput } from "../validate-input.js";
import {
  appendSliceFailRecord,
  buildSliceFailureNextAction,
  buildSliceNextAction,
  saveSlice,
  sliceTransition,
} from "./slice-internal.js";

/**
 * 执行 slice closeout action。
 *
 * @param unit 已加载的 Slice（status = retrospected）
 * @param input summary + artifacts（evidence 主观部分）
 * @param deps 依赖注入（store / clock / fileExists）
 */
export function handleCloseoutSlice(
  unit: Slice,
  input: CloseoutInput,
  deps: CwDeps,
): ActionResult {
  validateInput("closeout", "slice", input);
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
    appendSliceFailRecord(deps, unit, "closeout", reason);
    const { nextAction, failureCount } = buildSliceFailureNextAction(unit, "closeout", reason);
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `slice closeout drift check failed: ${reason}`,
      nextAction,
      failureCount,
    };
  }

  // ── 冻结 evidence + status 流转 → closed ──
  const frozenAt = deps.clock.now();
  unit.evidence.frozenAt = frozenAt;
  sliceTransition(unit, "closeout", frozenAt);

  saveSlice(deps, unit);

  // slice closeout 完成（status→closed）→ rollup 到 parent（feature/epic）的 childDelivery。
  // rollupChildDelivery 内部判断 parent 是否 PlanningUnit / 是否已冻结，非 PlanningUnit parent 静默跳过。
  if (unit.parentUnitId !== undefined && unit.parentUnitId !== "") {
    rollupChildDelivery(deps, unit.id);
  }

  // ── crossLayer + parallelTargets：探测就绪兄弟（§3.1.4.2 / §3.1.6）──
  // 有就绪兄弟 → sibling（锚定 parallelTargets[0]）；无 → ascend（回父）；无 parent → undefined。
  // 三层 closeout 天然无发散态：只用就绪判据（computeParallelSiblingsAfterCloseout）驱动 crossLayer，
  // 不调 computeCrossLayerAfterCloseout（非终态判据），故不会出现「sibling 指向被阻塞兄弟」。
  const hasParent =
    unit.parentUnitId !== undefined && unit.parentUnitId !== "";
  const parallelTargets = hasParent
    ? computeParallelSiblingsAfterCloseout({
        store: deps.store,
        unitId: unit.id,
        parentUnitId: unit.parentUnitId,
      })
    : [];

  const crossLayer: CwNextAction["crossLayer"] | undefined = parallelTargets.length > 0
    ? {
        kind: "sibling",
        targetUnitId: parallelTargets[0].unitId,
        reason: `slice 已 closeout，有 ${parallelTargets.length} 个就绪兄弟，横向推进`,
      }
    : hasParent
      ? {
          kind: "ascend",
          targetUnitId: unit.parentUnitId,
          reason: `slice 已 closeout，回溯父单元 ${unit.parentUnitId}`,
        }
      : undefined;

  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
    nextAction: buildSliceNextAction(unit, "closeout", { crossLayer, parallelTargets }),
  };
}

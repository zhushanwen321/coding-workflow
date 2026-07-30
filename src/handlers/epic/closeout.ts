/**
 * v1 epic handler — closeout action（补 evidence 主观部分 + drift 检查 + 冻结 + 回溯父单元）。
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
 * 关键差异：epic 是 4 层顶层无父层，createEpic 不写入 parentUnitId（永远 undefined），
 * 故 crossLayer 恒为 undefined（孤立终点）——代码逻辑与 feature 版完全一致（feature 版的三元判断
 * `unit.parentUnitId !== undefined && !== ""` 对 epic 天然走 undefined 分支），无需特判。
 */
import { assertEvidenceNotFrozen } from "../../core/evidence.js";
import type { Epic } from "../../core/workunit.js";
import type { GateResult } from "../../rules/gates/types.js";
import { rollupChildDelivery } from "../rollup.js";
import type { ActionResult, CloseoutInput, CwDeps, CwNextAction } from "../types.js";
import {
  appendEpicFailRecord,
  buildEpicFailureNextAction,
  buildEpicNextAction,
  epicTransition,
  saveEpic,
} from "./epic-internal.js";

/**
 * 执行 epic closeout action。
 *
 * @param unit 已加载的 Epic（status = retrospected）
 * @param input summary + artifacts（evidence 主观部分）
 * @param deps 依赖注入（store / clock / fileExists）
 */
export function handleCloseoutEpic(
  unit: Epic,
  input: CloseoutInput,
  deps: CwDeps,
): ActionResult {
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
    appendEpicFailRecord(deps, unit, "closeout", reason);
    const { nextAction, failureCount } = buildEpicFailureNextAction(unit, "closeout", reason);
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `epic closeout drift check failed: ${reason}`,
      nextAction,
      failureCount,
    };
  }

  // ── 冻结 evidence + status 流转 → closed ──
  const frozenAt = deps.clock.now();
  unit.evidence.frozenAt = frozenAt;
  epicTransition(unit, "closeout", frozenAt);

  saveEpic(deps, unit);

  // epic closeout 完成（status→closed）→ rollup 到 parent 的 childDelivery。
  // epic 通常顶层（parentUnitId 为空），rollupChildDelivery 内部静默跳过；保持对称接入。
  if (unit.parentUnitId !== undefined && unit.parentUnitId !== "") {
    rollupChildDelivery(deps, unit.id);
  }

  // ── crossLayer：回溯父单元（epic 顶层无 parent，天然 undefined——孤立终点）──
  const crossLayer: CwNextAction["crossLayer"] | undefined =
    unit.parentUnitId !== undefined && unit.parentUnitId !== ""
      ? {
          kind: "ascend",
          targetUnitId: unit.parentUnitId,
          reason: `epic 已 closeout，回溯父单元 ${unit.parentUnitId}`,
        }
      : undefined;

  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
    nextAction: buildEpicNextAction(unit, "closeout", { crossLayer }),
  };
}

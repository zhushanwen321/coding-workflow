/**
 * v1 wave handler — closeout action（补 evidence 主观部分 + drift 检查 + 冻结）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、model §5.11.1（evidence 跨阶段生命周期）：
 *      - execute/test 完成时填客观部分（commitHash/changedFiles/generatedAt/testRunResult）
 *      - closeout 阶段补主观部分（summary/artifacts）+ 校验 artifacts drift + 冻结（frozenAt）
 *      state-machine WAVE_TRANSITIONS.closeout（retrospected → closed）。
 *
 * 职责：
 * 1. 补 evidence 主观部分：summary + artifacts（从 input，artifacts 缺省保留原值）
 * 2. drift 检查：artifacts[].ref 必须非空且指向真实存在（deps.fileExists 校验）
 *    —— 任一 ref drift（空或不存在）→ 短路返回 ok=false（gateResults 记录 drift）
 * 3. 冻结 evidence：写 frozenAt = deps.clock.now()（之后整个 evidence 不可再改，由调用方保证）
 * 4. status 流转（retrospected → closed）→ save
 *
 * drift 短路语义：closeout 是终态转换（→ closed 不可逆），drift 即交付物不一致，不允许冻结。
 */
import { assertEvidenceNotFrozen } from "../core/evidence.js";
import type { ExecutionUnit } from "../core/workunit.js";
import {
  computeCrossLayerAfterCloseout,
  computeParallelSiblingsAfterCloseout,
} from "../guidance/index.js";
import type { GateResult } from "../rules/gates/types.js";
import {
  appendFailRecord,
  buildFailureNextAction,
  buildNextAction,
  saveUnit,
  transitionStatus,
} from "./internal.js";
import { rollupChildDelivery } from "./rollup.js";
import type { ActionResult, CloseoutInput, CwDeps } from "./types.js";

/**
 * 执行 closeout action。
 *
 * @param unit 已加载的 ExecutionUnit（status = retrospected）
 * @param input summary + artifacts（evidence 主观部分）
 * @param deps 依赖注入（store / clock / fileExists）
 */
export function handleCloseout(
  unit: ExecutionUnit,
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

  // ── drift 检查：artifacts[].ref 非空且指向真实存在 ──
  // commit kind 用 gitValidator.exists 校验（commit hash 不是文件路径），
  // 其他 kind 用 fileExists.exists 校验（文件路径 / URL）。
  const driftReports: string[] = [];
  for (const art of artifacts) {
    if (!art.ref || art.ref.trim() === "") {
      driftReports.push(
        `artifact(kind=${art.kind}) ref 为空（drift：交付物引用缺失）`,
      );
      continue;
    }
    if (art.kind === "commit") {
      if (!deps.gitValidator.exists(art.ref)) {
        driftReports.push(
          `artifact(kind=commit) hash="${art.ref}" 不存在（drift：commit 引用悬空）`,
        );
      }
    } else {
      if (!deps.fileExists.exists(art.ref)) {
        driftReports.push(
          `artifact(kind=${art.kind}) ref="${art.ref}" 不存在（drift：交付物引用悬空）`,
        );
      }
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

  // 短路：有 drift → 不冻结、不改 status，但 append fail 记录 + 异常 guidance
  if (driftReports.length > 0) {
    const reason = driftReports.join("; ");
    appendFailRecord(deps, unit, "closeout", reason);
    const { nextAction, failureCount } = buildFailureNextAction(unit, "closeout", reason);
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `closeout drift check failed: ${reason}`,
      nextAction,
      failureCount,
    };
  }

  // ── 冻结 evidence + status 流转 → closed ──
  unit.evidence.frozenAt = deps.clock.now();
  transitionStatus(unit, "closeout", unit.evidence.frozenAt);

  saveUnit(deps, unit);

  // child wave closeout 完成（status→closed）→ rollup 到 parent PlanningUnit 的 childDelivery。
  // rollupChildDelivery 内部判断 parent 是否 PlanningUnit / 是否已冻结，非 PlanningUnit parent 静默跳过，
  // 故有 parentUnitId 即调用（无 parent 的独立 wave parentUnitId 为空，不进此分支）。
  if (unit.parentUnitId) {
    rollupChildDelivery(deps, unit.id);
  }

  // closeout 后回溯父单元（wave 是叶子，closeout 后按 §7.3 算 crossLayer + §3.1.4.1 并行就绪兄弟）。
  // 先算两个视图：crossLayer（非终态判据，sibling/ascend/undefined 三态）+ parallelTargets（就绪判据）。
  const parallelTargets = computeParallelSiblingsAfterCloseout({
    store: deps.store,
    unitId: unit.id,
    parentUnitId: unit.parentUnitId,
  });
  let crossLayer = computeCrossLayerAfterCloseout({
    store: deps.store,
    unitId: unit.id,
    parentUnitId: unit.parentUnitId,
  });

  // 一致性守卫（§3.1.4.1 / §3.1.6）：消除 crossLayer 与 parallelTargets 的发散态。
  // computeCrossLayerAfterCloseout 用「非终态」判据，可能把 sibling 指向「非终态但被依赖阻塞」的
  // 兄弟（死胡同）；computeParallelSiblingsAfterCloseout 用「就绪」判据，被阻塞的兄弟不算就绪。
  // - 有就绪兄弟 → crossLayer 锚定 parallelTargets[0]（真正可推进的目标，一致性规则 §3.1.6）
  // - 兄弟非终态但全被依赖阻塞 → 降级 ascend（回 parent 等待，不指向死胡同）
  // parentUnitId 此处必非空：computeCrossLayerAfterCloseout 无 parent 时返回 undefined（cross-layer.ts:66-68），
  // 进入 sibling 分支说明有 parent。
  if (crossLayer?.kind === "sibling") {
    if (parallelTargets.length > 0) {
      crossLayer = { ...crossLayer, targetUnitId: parallelTargets[0].unitId };
    } else {
      crossLayer = {
        kind: "ascend",
        targetUnitId: unit.parentUnitId!,
        reason: `兄弟 wave 均被依赖阻塞，回父单元 ${unit.parentUnitId} 等待`,
      };
    }
  }

  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
    nextAction: buildNextAction(unit, "closeout", { crossLayer, parallelTargets }),
  };
}

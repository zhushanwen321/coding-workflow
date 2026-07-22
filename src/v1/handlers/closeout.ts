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
import type { ExecutionUnit } from "../core/workunit.js";
import type { GateResult } from "../rules/gates/types.js";
import { saveUnit,transitionStatus } from "./internal.js";
import type { ActionResult, CloseoutInput,V1Deps } from "./types.js";

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
  deps: V1Deps,
): ActionResult {
  // ── 补 evidence 主观部分 ──
  if (input.summary !== undefined) {
    unit.evidence.summary = input.summary;
  }
  const artifacts = input.artifacts ?? unit.evidence.artifacts;
  unit.evidence.artifacts = artifacts;

  // ── drift 检查：artifacts[].ref 非空且指向真实存在 ──
  const driftReports: string[] = [];
  for (const art of artifacts) {
    if (!art.ref || art.ref.trim() === "") {
      driftReports.push(
        `artifact(kind=${art.kind}) ref 为空（drift：交付物引用缺失）`,
      );
      continue;
    }
    if (!deps.fileExists.exists(art.ref)) {
      driftReports.push(
        `artifact(kind=${art.kind}) ref="${art.ref}" 不存在（drift：交付物引用悬空）`,
      );
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

  // 短路：有 drift → 不冻结、不改 status、不 save
  if (driftReports.length > 0) {
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `closeout drift check failed: ${driftReports.join("; ")}`,
    };
  }

  // ── 冻结 evidence + status 流转 → closed ──
  unit.evidence.frozenAt = deps.clock.now();
  transitionStatus(unit, "closeout", unit.evidence.frozenAt);

  saveUnit(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
  };
}

/**
 * v1 wave handler — execute action（记录 commitHash + 填 evidence 客观部分）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、§4（execute 产物 ExecuteResult.commitHash）、
 *      model §5.11.1（evidence 客观部分：commitHash/changedFiles/generatedAt）、
 *      state-machine WAVE_TRANSITIONS.execute（design-reviewed → executing）。
 *
 * 职责：
 * 1. 记录 commitHash 到 executeResult（真实存在性校验在 test gate 做，execute 只记录非空）
 * 2. 填 evidence 客观部分：commitHash + changedFiles（从 input 注入，或留空数组）
 * 3. 填 evidence.generatedAt（首次生成时间；若已填则保留，不覆盖——progressive 场景）
 * 4. status 流转（design-reviewed → executing）→ save
 *
 * 不变量：execute 不跑 gate（commit 存在性在 test gate 验，避免 executing 状态因 commit 无效卡死）。
 */
import type { ExecutionUnit } from "../core/workunit.js";
import { buildNextAction, saveUnit,transitionStatus } from "./internal.js";
import type { ActionResult, ExecuteInput,V1Deps } from "./types.js";

/**
 * 执行 execute action。
 *
 * @param unit 已加载的 ExecutionUnit（status = design-reviewed）
 * @param input commitHash + changedFiles（可选）
 * @param deps 依赖注入（store / clock）
 */
export function handleExecute(
  unit: ExecutionUnit,
  input: ExecuteInput,
  deps: V1Deps,
): ActionResult {
  // 写 executeResult（commitHash 记录，存在性在 test gate 验）
  unit.executeResult = { commitHash: input.commitHash };

  // 填 evidence 客观部分
  const at = deps.clock.now();
  unit.evidence.commitHash = input.commitHash;
  unit.evidence.changedFiles = input.changedFiles ?? [];
  // generatedAt 首次生成时间（已填则保留，不覆盖——progressive 场景下 execute 可能重跑）
  if (!unit.evidence.generatedAt) {
    unit.evidence.generatedAt = at;
  }

  // status 流转 → executing + append statusHistory
  transitionStatus(unit, "execute", at);

  saveUnit(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    nextAction: buildNextAction(unit, "execute"),
  };
}

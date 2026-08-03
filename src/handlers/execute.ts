/**
 * v1 wave handler — execute action（记录 commitHash + 填 evidence 客观部分）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、§4（execute 产物 ExecuteResult.commitHash）、
 *      model §5.11.1（evidence 客观部分：commitHash/changedFiles/generatedAt）、
 *      state-machine WAVE_TRANSITIONS.execute（design-reviewed → executing）。
 *
 * 职责：
 * 1. 前置校验 commitHash 存在性（#8：入口先验，失败 → CwError 停留 design-reviewed 可重试；test gate 保留纵深防御）
 * 2. 记录 commitHash 到 executeResult
 * 3. 填 evidence 客观部分：commitHash + changedFiles（cw 从 commit 提取，§4.4 客观字段，不靠 agent 声明）
 * 4. 填 evidence.generatedAt（首次生成时间；若已填则保留，不覆盖——progressive 场景）
 * 5. status 流转（design-reviewed → executing）→ save
 *
 * 不变量：execute 不跑 gate（仅前置 commitExists 校验；其余 gate 在 test 阶段验，避免 executing 状态因无效 commit 卡死）。
 */
import { CwError } from "../core/errors.js";
import type { WaveEvidence } from "../core/evidence.js";
import { assertEvidenceNotFrozen } from "../core/evidence.js";
import { extractChangedFiles, parseAbandonMarkers } from "../core/git.js";
import type { ExecutionUnit } from "../core/workunit.js";
import { commitExists } from "../rules/gates/test.js";
import { buildNextAction, mergeAbandonParentItems, saveUnit, transitionStatus } from "./internal.js";
import type { ActionResult, CwDeps,ExecuteInput } from "./types.js";
import { validateInput } from "./validate-input.js";

/**
 * 执行 execute action。
 *
 * @param unit 已加载的 ExecutionUnit（status = design-reviewed）
 * @param input commitHash（changedFiles 已废弃，cw 从 commit 提取）
 * @param deps 依赖注入（store / clock / workspacePath）
 */
export function handleExecute(
  unit: ExecutionUnit,
  input: ExecuteInput,
  deps: CwDeps,
): ActionResult {
  validateInput("execute", "wave", input);
  // ── #8 前置校验：commit 存在性在 execute 入口先验（transition 之前，任何 mutation 之前）。
  //    失败 → CwError，status 停留 design-reviewed 可重试（不产生 executing 卡死态）；
  //    test gate 的 commitExists 保留纵深防御（前置失败 ≠ 移除 test 层检查）。
  const commitCheck = commitExists(input.commitHash, deps.gitValidator);
  if (!commitCheck.passed) {
    throw new CwError(commitCheck.report);
  }

  // ── 检测 replan 后重新 execute：旧 commitHash 需要 append 进 statusHistory ──
  const oldCommitHash = unit.executeResult?.commitHash;
  if (oldCommitHash && oldCommitHash !== input.commitHash) {
    unit.statusHistory.push({
      to: unit.status,
      at: deps.clock.now(),
      action: "execute",
      note: `commitHash changed: ${oldCommitHash} → ${input.commitHash}`,
    });
  }

  // 写 executeResult（commitHash 记录，存在性在 test gate 验）
  unit.executeResult = { commitHash: input.commitHash };

  // 填 evidence 客观部分
  // 检查 evidence 是否已冻结（frozenAt 非空后不可再改）
  assertEvidenceNotFrozen(unit.evidence, "write commitHash/changedFiles/generatedAt");
  const at = deps.clock.now();
  unit.evidence.commitHash = input.commitHash;
  // changedFiles 由 cw 从 commit 提取（§4.4 客观字段，不靠 agent 声明；input.changedFiles 已废弃将被忽略）
  const { changedFiles, note: extractNote } = extractChangedFiles(
    deps.workspacePath,
    input.commitHash,
  );
  unit.evidence.changedFiles = changedFiles;
  if (extractNote) {
    // 提取失败记入 evidence 供人审（不阻断 execute——commit 存在性由 test gate commitExists 兜底）
    (unit.evidence as WaveEvidence).extractionNote = extractNote;
  }

  // ── Cw-Abandon trailer 解析：从 commit message 提取 wave 声明废弃的 parent 条目 id ──
  // 失败降级返回空数组（不阻断 execute）。复用 mergeAbandonParentItems 做 append-only 合并。
  // 这是 wave execute 的「顺便通道」（ADR-0010）——主通道是 plan/replan 的显式 input。
  const abandonMarkers = parseAbandonMarkers(deps.workspacePath, input.commitHash);
  mergeAbandonParentItems(unit, { abandonParentItems: abandonMarkers });

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

/**
 * v1 wave handler — exec-review action（跑 4 个 gate + 写 execReviewJudgment）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、§6.4 + §11（WAVE_EXEC_REVIEW_GATES 4 个 gate）、
 *      §6.5（exec-review 纯人审，不阻塞 closeout，但 gate 验结构）、
 *      state-machine WAVE_TRANSITIONS["exec-review"]（tested → exec-reviewed）。
 *
 * 职责：
 * 1. 跑 4 个 exec-review gate（readability/architecture 非空 + overallVerdict 非空 + needs-followup 时 followupActions 必填）
 * 2. 任一 gate fail → 短路返回 ok=false + gateResults（不改 status、不 save、不写 judgment）
 * 3. 全 pass → 写 execReviewJudgment → status 流转（→ exec-reviewed）→ save
 *
 * gate fail 短路语义：gate 是结构校验前置，fail 时不改任何状态。
 * 注（wave §6.5）：overallVerdict="needs-followup" 也 pass（不阻塞），只是 followupActions 必填。
 */
import type { ExecutionUnit } from "../core/workunit.js";
import {
  execReviewArchitectureNonEmpty,
  execReviewFollowupActionsWhenNeeded,
  execReviewOverallVerdictNonEmpty,
  execReviewReadabilityNonEmpty,
} from "../rules/gates/exec-review.js";
import {
  appendFailRecord,
  buildFailureNextAction,
  buildNextAction,
  saveUnit,
  transitionStatus,
} from "./internal.js";
import type { ActionResult, ExecReviewInput,V1Deps } from "./types.js";

/**
 * 执行 exec-review action。
 *
 * @param unit 已加载的 ExecutionUnit（status = tested）
 * @param input execReviewJudgment
 * @param deps 依赖注入（store / clock）
 */
export function handleExecReview(
  unit: ExecutionUnit,
  input: ExecReviewInput,
  deps: V1Deps,
): ActionResult {
  // ── 跑 4 个 gate ──
  const gateResults = [
    execReviewReadabilityNonEmpty(input.execReviewJudgment),
    execReviewArchitectureNonEmpty(input.execReviewJudgment),
    execReviewOverallVerdictNonEmpty(input.execReviewJudgment),
    execReviewFollowupActionsWhenNeeded(input.execReviewJudgment),
  ];

  // 短路：任一 fail → 不改 status、不写 judgment，但 append fail 记录 + 异常 guidance
  const failed = gateResults.filter((g) => !g.passed);
  if (failed.length > 0) {
    const reason = failed.map((g) => g.report).join("; ");
    appendFailRecord(deps, unit, "exec-review", reason);
    const { nextAction, failureCount } = buildFailureNextAction(unit, "exec-review", reason);
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `exec-review gate failed: ${reason}`,
      nextAction,
      failureCount,
    };
  }

  // ── 全 pass：写 judgment → status 流转 → save ──
  unit.execReviewJudgment = input.execReviewJudgment;
  transitionStatus(unit, "exec-review", deps.clock.now());

  saveUnit(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
    nextAction: buildNextAction(unit, "exec-review"),
  };
}

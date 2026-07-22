/**
 * v1 wave exec-review 阶段 gate 纯函数（领域规则，零 IO）。
 *
 * 来源：v5 wave 附录 A §11 line 1255-1264（WAVE_EXEC_REVIEW_GATES 清单）、
 *      wave §6.4（overallVerdict 判定 + 机器 gate 边界）、§6.5（诚实说明）。
 *
 * 职责：exec-review 阶段验必填字段非空 + needs-followup 时 followupActions 必填。
 *
 * 重要（wave §6.5）：exec-review 是**纯人审，不阻塞 closeout**——overallVerdict="needs-followup" 也能
 * 进 retrospect / closeout（只是 followupActions 必须填）。gate 只验结构，不验 score 合理性 / 内容质量。
 *
 * 不变量：rules 层零 IO。所有 gate 接收已加载的 ExecReviewJudgment，返回 GateResult。
 */
import type { ExecReviewJudgment } from "../../core/judgments.js";
import type { GateResult } from "./types.js";

// 重新导出 GateResult，便于 `import { GateResult } from "./gates/exec-review.js"`
export type { GateResult };

// ═══════════════════════════════════════════════════════════════
// readability / architecture / overallVerdict 非空（必填字段）
// ═══════════════════════════════════════════════════════════════

/**
 * 附录 A `exec-review-readability-non-empty` — readability.score 非空（在 1-5 范围）。
 *
 * wave §6.1 定稿：readability 从可选改为必填（每个 wave 的 exec-review 都要给分）。
 * score 是 1|2|3|4|5 联合类型，类型层面保证非空；gate 验 score 在合法范围（1-5）。
 * issues 可选（spec 简化：score 合法即 passed）。
 */
export function execReviewReadabilityNonEmpty(
  judgment: ExecReviewJudgment,
): GateResult {
  const score = judgment.readability?.score;
  if (score === undefined || score === null) {
    return {
      passed: false,
      report: "exec-review-readability-non-empty: readability.score 缺失",
    };
  }
  if (score < 1 || score > 5) {
    return {
      passed: false,
      report: `exec-review-readability-non-empty: readability.score=${score} 超出 1-5 范围`,
    };
  }
  return {
    passed: true,
    report: `exec-review-readability-non-empty: readability.score=${score}`,
  };
}

/**
 * 附录 A `exec-review-architecture-non-empty` — architecture.score 非空（在 1-5 范围）。
 *
 * 同 readability：wave §6.1 定稿为必填，gate 验 score 合法范围。
 */
export function execReviewArchitectureNonEmpty(
  judgment: ExecReviewJudgment,
): GateResult {
  const score = judgment.architecture?.score;
  if (score === undefined || score === null) {
    return {
      passed: false,
      report: "exec-review-architecture-non-empty: architecture.score 缺失",
    };
  }
  if (score < 1 || score > 5) {
    return {
      passed: false,
      report: `exec-review-architecture-non-empty: architecture.score=${score} 超出 1-5 范围`,
    };
  }
  return {
    passed: true,
    report: `exec-review-architecture-non-empty: architecture.score=${score}`,
  };
}

/**
 * 附录 A `exec-review-overall-verdict-non-empty` — overallVerdict 非空。
 *
 * overallVerdict 是 "pass" | "needs-followup" 联合类型，类型保证非空。
 * 简化（spec）：始终 passed（类型层面已保证）。保留函数完整性 + 为 report 提供诊断信息。
 */
export function execReviewOverallVerdictNonEmpty(
  judgment: ExecReviewJudgment,
): GateResult {
  const verdict = judgment.overallVerdict;
  if (verdict !== "pass" && verdict !== "needs-followup") {
    return {
      passed: false,
      report: `exec-review-overall-verdict-non-empty: overallVerdict="${verdict}" 不合法（应为 "pass" | "needs-followup"）`,
    };
  }
  return {
    passed: true,
    report: `exec-review-overall-verdict-non-empty: overallVerdict="${verdict}"`,
  };
}

// ═══════════════════════════════════════════════════════════════
// followupActions（needs-followup 时必填）
// ═══════════════════════════════════════════════════════════════

/**
 * 附录 A `exec-review-followup-actions-when-needed` — overallVerdict="needs-followup" 时 followupActions 至少 1 条。
 *
 * 规则（wave §6.4 机器 gate）：
 * - overallVerdict="needs-followup" → followupActions 至少 1 条
 * - overallVerdict="pass" → passed=true（followupActions 建议留空，但不强制）
 *
 * 注意（wave §6.5）：exec-review 不阻塞 closeout——needs-followup 也能进 closeout，
 * 但 followupActions 必须填（让技术债可见可追踪）。
 */
export function execReviewFollowupActionsWhenNeeded(
  judgment: ExecReviewJudgment,
): GateResult {
  if (judgment.overallVerdict === "needs-followup") {
    const count = judgment.followupActions?.length ?? 0;
    if (count < 1) {
      return {
        passed: false,
        report:
          'exec-review-followup-actions-when-needed: overallVerdict="needs-followup" 但 followupActions 为空（至少 1 条）',
      };
    }
    return {
      passed: true,
      report: `exec-review-followup-actions-when-needed: needs-followup 时 followupActions 有 ${count} 条`,
    };
  }
  // overallVerdict="pass"：followupActions 建议留空但不强制
  const count = judgment.followupActions?.length ?? 0;
  return {
    passed: true,
    report: `exec-review-followup-actions-when-needed: overallVerdict="pass"（followupActions ${count} 条）`,
  };
}

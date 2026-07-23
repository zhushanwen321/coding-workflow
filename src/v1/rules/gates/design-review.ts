/**
 * v1 wave design-review 阶段 gate 纯函数（领域规则，零 IO）。
 *
 * 来源：v5 wave 附录 A §11 line 1227-1239（WAVE_DESIGN_REVIEW_GATES 清单）、
 *      wave §2.7（机器 gate 清单 + 取舍说明）、§3（layerSpecific 非空 gate）。
 *
 * 职责：design-review 阶段对 plan 产物（testCases）+ designReviewJudgment 的机器 gate。
 *      只验结构（非空 / 完整），不验内容质量（内容靠人审）。
 *
 * 不变量：rules 层零 IO。所有 gate 接收已加载的数据（ExecutionUnit / DesignReviewJudgment），
 *      返回统一的 GateResult { passed, report }。
 */
import type { DesignReviewJudgment } from "../../core/judgments.js";
import type { ExecutionUnit } from "../../core/workunit.js";
import type { GateResult } from "./types.js";

// 重新导出 GateResult，便于 `import { GateResult } from "./gates/design-review.js"`
export type { GateResult };

// ═══════════════════════════════════════════════════════════════
// 结构完整性 gate（testCases）
// ═══════════════════════════════════════════════════════════════

/**
 * wave §2.7 / 附录 A `test-cases-non-empty` — testCases 至少 1 条。
 *
 * testCases 是 TDD 硬前提（没测试 execute 不了），必须机器验。
 */
export function testCasesNonEmpty(unit: ExecutionUnit): GateResult {
  const count = unit.plan.testCases.length;
  if (count < 1) {
    return {
      passed: false,
      report: "test-cases-non-empty: testCases 为空（TDD 要求至少 1 条测试用例）",
    };
  }
  return {
    passed: true,
    report: `test-cases-non-empty: testCases 有 ${count} 条`,
  };
}

/**
 * wave §2.7 / 附录 A `test-cases-have-expected` — 每个 WaveTestCase.expected 非空。
 *
 * TDD 红灯前提：expected 由 agent 自填，cw 只验填了（不验对错，§5.2）。
 */
export function testCasesHaveExpected(unit: ExecutionUnit): GateResult {
  const empty = unit.plan.testCases.filter((tc) => !tc.expected || tc.expected.trim() === "");
  if (empty.length > 0) {
    return {
      passed: false,
      report: `test-cases-have-expected: ${empty.length} 条 testCases 的 expected 为空（ids: ${empty.map((t) => t.id).join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: `test-cases-have-expected: 全部 ${unit.plan.testCases.length} 条 testCases 的 expected 非空`,
  };
}

// ═══════════════════════════════════════════════════════════════
// 业务判断非空 gate（designReviewJudgment，model §5.8 通用要求）
// ═══════════════════════════════════════════════════════════════

/**
 * 附录 A `design-review-necessity-non-empty` — designReviewJudgment.necessity 非空。
 *
 * necessity 是「这个 wave 对 slice 的贡献」判断，model §5.8 必填。
 */
export function designReviewNecessityNonEmpty(
  judgment: DesignReviewJudgment,
): GateResult {
  if (!judgment.necessity || judgment.necessity.trim() === "") {
    return {
      passed: false,
      report: "design-review-necessity-non-empty: necessity 为空",
    };
  }
  return {
    passed: true,
    report: "design-review-necessity-non-empty: necessity 非空",
  };
}

/**
 * 附录 A `design-review-sufficiency-complete` — sufficiency 的 gaps/overlaps/meceNote 完整。
 *
 * meceNote 非空是核心（gaps/overlaps 可为空数组，但 MECE 判断说明必须给）。
 */
export function designReviewSufficiencyComplete(
  judgment: DesignReviewJudgment,
): GateResult {
  const s = judgment.sufficiency;
  if (!s) {
    return {
      passed: false,
      report: "design-review-sufficiency-complete: sufficiency 缺失",
    };
  }
  if (!s.meceNote || s.meceNote.trim() === "") {
    return {
      passed: false,
      report: "design-review-sufficiency-complete: sufficiency.meceNote 为空（MECE 判断说明必填）",
    };
  }
  return {
    passed: true,
    report: `design-review-sufficiency-complete: meceNote 非空（gaps=${s.gaps.length}, overlaps=${s.overlaps.length}）`,
  };
}

/**
 * 附录 A `design-review-alternatives-non-empty` — alternatives 非空。
 *
 * alternatives 是「考虑过的替代方案」判断，model §5.8 必填。
 */
export function designReviewAlternativesNonEmpty(
  judgment: DesignReviewJudgment,
): GateResult {
  if (!judgment.alternatives || judgment.alternatives.trim() === "") {
    return {
      passed: false,
      report: "design-review-alternatives-non-empty: alternatives 为空",
    };
  }
  return {
    passed: true,
    report: "design-review-alternatives-non-empty: alternatives 非空",
  };
}

/**
 * 附录 A `design-review-tradeoffs-present` — tradeoffs 至少 1 条或显式声明。
 *
 * 简化（按 spec）：tradeoffs 数组非空即可。
 * 完整语义应是「至少 1 条或显式声明『无』+ 理由」，但 v5 wave 附录 A 的 gate 清单
 * 只验 present，具体内容由 agent 自负责（machine gate 只验结构，§6.5 诚实说明）。
 */
export function designReviewTradeoffsPresent(
  judgment: DesignReviewJudgment,
): GateResult {
  if (judgment.tradeoffs.length < 1) {
    return {
      passed: false,
      report: "design-review-tradeoffs-present: tradeoffs 为空（至少 1 条，或显式声明「无」+ 理由）",
    };
  }
  return {
    passed: true,
    report: `design-review-tradeoffs-present: tradeoffs 有 ${judgment.tradeoffs.length} 条`,
  };
}

/**
 * 附录 A `design-review-risks-present` — risks 至少 1 条或显式声明。
 *
 * 简化（按 spec）：risks 数组非空即可（同 tradeoffs 的处理逻辑）。
 */
export function designReviewRisksPresent(
  judgment: DesignReviewJudgment,
): GateResult {
  if (judgment.risks.length < 1) {
    return {
      passed: false,
      report: "design-review-risks-present: risks 为空（至少 1 条，或显式声明「无」+ 理由）",
    };
  }
  return {
    passed: true,
    report: `design-review-risks-present: risks 有 ${judgment.risks.length} 条`,
  };
}

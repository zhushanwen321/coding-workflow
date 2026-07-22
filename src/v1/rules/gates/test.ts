/**
 * v1 wave test 阶段 gate 纯函数（领域规则，零 IO）。
 *
 * 来源：v5 wave 附录 A §11 line 1241-1253（WAVE_TEST_GATES 清单）、
 *      wave §5.5（机器 gate 清单 + 引用一致性）、§4（commit 存在性机制）、§5.8（testRunResult 归宿）。
 *
 * 职责：test 阶段验「commit 存在 + 测试全过 + testJudgment 对照 designReviewJudgment」。
 *      这是整个 cw 唯一真正机器验证业务正确性的 gate 集合（wave §5.1）。
 *
 * 不变量：rules 层零 IO。
 * - commit 存在性：gate 不调 git，由调用方注入 gitValidator（IO 在 handlers 层做）。
 * - 测试运行结果：gate 不跑测试，testRunResult 由调用方注入（cw 在 handlers 层实跑后传入）。
 */
import type { TestRunResult } from "../../core/evidence.js";
import type { TestJudgment, DesignReviewJudgment } from "../../core/judgments.js";
import type { GateResult } from "./types.js";

// 重新导出 GateResult，便于 `import { GateResult } from "./gates/test.js"`
export type { GateResult };

// ═══════════════════════════════════════════════════════════════
// commit-exists（wave §4 / 附录 A）
// ═══════════════════════════════════════════════════════════════

/**
 * git commit 校验器（IO 注入点）。
 *
 * gate 不做 IO——调用方（handlers 层）注入一个 `exists` 实现
 * （典型：`git cat-file -e <hash>` 的封装）。
 */
export interface GitValidator {
  /** 校验给定 commit hash 在当前仓库真实存在。 */
  exists: (hash: string) => boolean;
}

/**
 * wave §4.2 / 附录 A `commit-exists` — commitHash 非空且 git 校验存在。
 *
 * 机制（wave §4.2）：agent stdin 传 hash → cw `git cat-file -e` 验存在。
 * gate 本身不调 git，gitValidator 注入校验结果。
 */
export function commitExists(
  commitHash: string,
  gitValidator: GitValidator,
): GateResult {
  if (!commitHash || commitHash.trim() === "") {
    return {
      passed: false,
      report: "commit-exists: commitHash 为空（execute 未产出 commit）",
    };
  }
  if (!gitValidator.exists(commitHash)) {
    return {
      passed: false,
      report: `commit-exists: commitHash "${commitHash}" 在仓库中不存在`,
    };
  }
  return {
    passed: true,
    report: `commit-exists: commitHash "${commitHash}" 存在`,
  };
}

// ═══════════════════════════════════════════════════════════════
// tests-all-pass（wave §5.1 / §5.5 — 核心机器 gate）
// ═══════════════════════════════════════════════════════════════

/**
 * wave §5.5 / 附录 A `tests-all-pass` — testRunResult 存在且 passed=true。
 *
 * 这是整个 cw 唯一真正机器验证业务正确性的 gate（wave §5.1）。
 * cw 实跑 wave 测试套件，验所有非 manual WaveTestCase 的测试都 pass（fail 数 = 0）。
 * gate 不跑测试，testRunResult 由调用方注入（cw 在 handlers 层实跑后传入）。
 *
 * testRunResult=undefined 表示「还没跑测试」，gate fail。
 */
export function testsAllPass(
  testRunResult: TestRunResult | undefined,
): GateResult {
  if (!testRunResult) {
    return {
      passed: false,
      report: "tests-all-pass: testRunResult 缺失（测试未运行）",
    };
  }
  if (!testRunResult.passed) {
    return {
      passed: false,
      report: `tests-all-pass: 测试未全部通过（passed=${testRunResult.passedCount}, failed=${testRunResult.failedCount}）`,
    };
  }
  return {
    passed: true,
    report: `tests-all-pass: 全部通过（passed=${testRunResult.passedCount}, failed=${testRunResult.failedCount}）`,
  };
}

// ═══════════════════════════════════════════════════════════════
// test-references-design-review（wave §5.5 引用一致性）
// ═══════════════════════════════════════════════════════════════

/**
 * wave §5.5 / 附录 A `test-references-design-review` — testJudgment 逐条对照 designReviewJudgment。
 *
 * 校验（诚实区分两类，wave §5.5）：
 * - **真引用一致（机器验 id 匹配）**：
 *   - 每个 designReviewJudgment.tradeoffs[i].id 都有一条 testJudgment.tradeoffCostRealized[k].tradeoffRef 对应
 *   - 每个 designReviewJudgment.risks[i].id 都有一条 testJudgment.riskOutcome[k].riskRef 对应
 * - **只验非空（对应关系靠 agent 自检）**：
 *   - testJudgment.necessityMet / sufficiencyMet / alternativesReconsidered 非空
 */
export function testReferencesDesignReview(
  testJudgment: TestJudgment,
  designReviewJudgment: DesignReviewJudgment,
): GateResult {
  // 1. 字符串字段非空（只验填了）
  const emptyFields: string[] = [];
  if (!testJudgment.necessityMet || testJudgment.necessityMet.trim() === "") {
    emptyFields.push("necessityMet");
  }
  if (
    !testJudgment.alternativesReconsidered ||
    testJudgment.alternativesReconsidered.trim() === ""
  ) {
    emptyFields.push("alternativesReconsidered");
  }
  // sufficiencyMet 结构体非空（gapsConfirmed/gapsNewlyFound/overlapsConfirmed 是数组，可为空，但结构体本身必填）
  if (!testJudgment.sufficiencyMet) {
    emptyFields.push("sufficiencyMet");
  }
  if (emptyFields.length > 0) {
    return {
      passed: false,
      report: `test-references-design-review: 字符串/结构体字段为空（${emptyFields.join(", ")}）`,
    };
  }

  // 2. tradeoff id 覆盖（真引用一致）
  const tradeoffRefs = new Set(
    testJudgment.tradeoffCostRealized.map((t) => t.tradeoffRef),
  );
  const missingTradeoffs = designReviewJudgment.tradeoffs
    .filter((t) => !tradeoffRefs.has(t.id))
    .map((t) => t.id);
  if (missingTradeoffs.length > 0) {
    return {
      passed: false,
      report: `test-references-design-review: tradeoffCostRealized 未覆盖 tradeoffs（缺失 refs: ${missingTradeoffs.join(", ")}）`,
    };
  }

  // 3. risk id 覆盖（真引用一致）
  const riskRefs = new Set(testJudgment.riskOutcome.map((r) => r.riskRef));
  const missingRisks = designReviewJudgment.risks
    .filter((r) => !riskRefs.has(r.id))
    .map((r) => r.id);
  if (missingRisks.length > 0) {
    return {
      passed: false,
      report: `test-references-design-review: riskOutcome 未覆盖 risks（缺失 refs: ${missingRisks.join(", ")}）`,
    };
  }

  return {
    passed: true,
    report: `test-references-design-review: tradeoffs(${designReviewJudgment.tradeoffs.length})/risks(${designReviewJudgment.risks.length}) 全覆盖`,
  };
}

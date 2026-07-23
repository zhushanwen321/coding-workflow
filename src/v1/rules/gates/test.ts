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
import type { DesignReviewJudgment,TestJudgment } from "../../core/judgments.js";
import type { WaveTestCase } from "../../core/plan.js";
import type { ExecutionUnit } from "../../core/workunit.js";
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

// ═══════════════════════════════════════════════════════════════
// test-cases-executed（wave §5.5 / 附录 A line 1244）
// ═══════════════════════════════════════════════════════════════

/**
 * wave §5.5 / 附录 A `test-cases-executed` — 所有 WaveTestCase 都被执行了。
 *
 * 两层校验：
 * - **非 manual 类**：testRunResult 有执行记录（passedCount + failedCount 覆盖非 manual 数量）
 * - **manual 类**：在 testJudgment.sufficiencyMet.note 有验收记录（manual 测试不机器跑，走退化验证，wave §5.3/§5.8）
 *
 * manual 类 WaveTestCase 的验收记录归宿在 testJudgment.sufficiencyMet.note（wave §5.8 line 533）。
 */
export function testCasesExecuted(
  unit: ExecutionUnit,
  testRunResult: TestRunResult | undefined,
  testJudgment: TestJudgment,
): GateResult {
  const testCases: WaveTestCase[] = unit.plan.testCases;
  const nonManual = testCases.filter((tc) => tc.type !== "manual");
  const manual = testCases.filter((tc) => tc.type === "manual");

  // 非 manual 类：验 testRunResult 有足够执行记录
  const executedCount = testRunResult
    ? testRunResult.passedCount + testRunResult.failedCount
    : 0;
  if (nonManual.length > 0 && executedCount < nonManual.length) {
    return {
      passed: false,
      report: `test-cases-executed: 非 manual 测试用例 ${nonManual.length} 个，但 testRunResult 只记录了 ${executedCount} 次执行`,
    };
  }

  // manual 类：验 sufficiencyMet.note 有验收记录
  if (manual.length > 0) {
    const note = testJudgment.sufficiencyMet.note;
    if (!note || note.trim() === "") {
      return {
        passed: false,
        report: `test-cases-executed: 有 ${manual.length} 个 manual 类 WaveTestCase，但 testJudgment.sufficiencyMet.note 为空（manual 测试验收记录归宿，wave §5.8）`,
      };
    }
  }

  return {
    passed: true,
    report: `test-cases-executed: 非 manual(${nonManual.length}) 全执行 + manual(${manual.length}) 有验收记录`,
  };
}

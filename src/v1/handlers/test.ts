/**
 * v1 wave handler — test action（跑测试 + 跑 3 个 gate + 填 testRunResult/testJudgment）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、§5.1/§5.5 + §11（WAVE_TEST_GATES 3 个 gate）、
 *      §4（commit 存在性机制）、§5.8（testRunResult 归 evidence，testJudgment 独立产物）、
 *      state-machine WAVE_TRANSITIONS.test（executing → tested）。
 *
 * 职责：
 * 1. deps.testRunner.run(unit) 实跑测试拿 TestRunResult
 * 2. 跑 3 个 test gate：
 *    - commitExists(executeResult.commitHash, deps.gitValidator)（commit 真实存在性，整个 cw 唯一 git 校验点）
 *    - testsAllPass(testRunResult)（核心：业务正确性机器验证）
 *    - testReferencesDesignReview(testJudgment, designReviewJudgment)（引用一致性）
 * 3. 任一 gate fail → 短路返回 ok=false + gateResults（不改 status、不 save、不写 judgment/testRunResult）
 * 4. 全 pass → 填 evidence.testRunResult + 写 testJudgment → status 流转（→ tested）→ save
 *
 * gate fail 短路语义：fail 时不改任何状态（test 是 executing → tested 的关键转换，fail 即业务未通过）。
 */
import type { ExecutionUnit } from "../core/workunit.js";
import {
  commitExists,
  testCasesExecuted,
  testReferencesDesignReview,
  testsAllPass,
} from "../rules/gates/test.js";
import {
  appendFailRecord,
  buildFailureNextAction,
  buildNextAction,
  saveUnit,
  transitionStatus,
} from "./internal.js";
import type { ActionResult, TestInput,V1Deps } from "./types.js";

/**
 * 执行 test action。
 *
 * @param unit 已加载的 ExecutionUnit（status = executing）
 * @param input testJudgment
 * @param deps 依赖注入（store / clock / testRunner / gitValidator）
 */
export function handleTest(
  unit: ExecutionUnit,
  input: TestInput,
  deps: V1Deps,
): ActionResult {
  // ── 跑测试（IO 通过 deps 注入）──
  const testRunResult = deps.testRunner.run(unit);

  // ── 跑 4 个 gate ──
  const gateResults = [
    commitExists(unit.executeResult.commitHash, deps.gitValidator),
    testsAllPass(testRunResult),
    testCasesExecuted(unit, testRunResult, input.testJudgment),
    testReferencesDesignReview(input.testJudgment, unit.designReviewJudgment),
  ];

  // 短路：任一 fail → 不改 status、不写产物，但 append fail 记录 + 异常 guidance
  const failed = gateResults.filter((g) => !g.passed);
  if (failed.length > 0) {
    const reason = failed.map((g) => g.report).join("; ");
    appendFailRecord(deps, unit, "test", reason);
    const { nextAction, failureCount } = buildFailureNextAction(unit, "test", reason);
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `test gate failed: ${reason}`,
      nextAction,
      failureCount,
    };
  }

  // ── 全 pass：填 testRunResult + 写 testJudgment → status 流转 → save ──
  unit.evidence.testRunResult = testRunResult;
  unit.testJudgment = input.testJudgment;
  transitionStatus(unit, "test", deps.clock.now());

  saveUnit(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
    nextAction: buildNextAction(unit, "test"),
  };
}

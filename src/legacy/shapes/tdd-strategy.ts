/**
 * TddVerificationStrategy —— full-tdd shape 的验证策略实现。
 *
 * 把现有散落在 gate.ts / actions.ts / state-machine.ts 里的 TDD 判定逻辑，
 * 用 VerificationStrategy 接口包装成可路由的策略对象。state-machine / actions
 * 通过 topic.taskShape 拿到策略实例后调对应方法，不再硬编码 TDD 分支。
 *
 * 方法映射：
 *   - preDevCheck → tddPlanCheck（透传，等价性由 shapes-tdd-strategy.test.ts 锁定）
 *   - postDevVerify → 抽取自 handleTest 的「执行测试 + judgeByExpected 判定」逻辑
 *     （topic 2 把 W2 占位补全为真实实现，等价性由 postdev-extract-equivalence.test.ts 锁定）
 *   - replanGuard → validateAppendOnly（适配 2-arg 策略签名到 4-arg 原始签名）
 *   - isDevVerified → computeGatePassed("test") 的等价逻辑（testCases 全 passed）
 *   - applyPreDevResult → handleTddPlan 事务内 insertTestCases + setTestRunner 的等价写入
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import {
  type AppendOnlyViolation,
  readExitStatus,
  validateAppendOnly,
} from "../actions.js";
import { isPathInsideWorkspace, runTestRunner, tddPlanCheck, testCheck } from "../gate.js";
import type {
  Actual,
  TestCaseSeed,
  TestRunnerConfig,
  Topic,
  WaveSeed,
} from "../types.js";
import type {
  ApplyPreDevResultStore,
  GateResult,
  VerificationStrategy,
  VerifyResult,
  Violation,
} from "./types.js";

/** exit_zero / script 模式 CW 自动执行的结果（exact 模式不在此表，沿用 agent actual）。 */
type AutoExecResult = { actual: Actual } | { error: string };

export class TddVerificationStrategy implements VerificationStrategy {
  readonly id = "tdd";
  readonly preDevGateName = "test-json-schema";
  readonly postDevGateName = "test-runner";

  preDevCheck(topic: Topic, payload: unknown): GateResult {
    // 原样透传 tddPlanCheck——签名 (testJson, specSections, workspacePath)。
    // 等价性（result/parsed/report 关键词与 tddPlanCheck 直调一致）由
    // shapes-tdd-strategy.test.ts AC-5 锁定。
    return tddPlanCheck(payload, topic.specSections, topic.workspacePath);
  }

  postDevVerify(topic: Topic): VerifyResult[] {
    // 抽取自 handleTest（actions.ts 1113-1297）的「执行测试 + judgeByExpected 判定」逻辑。
    // 纯函数：只读 topic，不写 store——返回每个 case 的 VerifyResult，
    // 由 handleTest 在事务内映射到 store.updateTestCase。
    //
    // 等价性约束（postdev-extract-equivalence.test.ts AC-3/AC-5）：
    //   - exit_zero：去重执行一次 testRunner（同 command 跑一次），归一化 exitCode 给每个 exit_zero case
    //   - script：各自执行 expected.path（execFileSync 直接执行，不经 shell）
    //   - 每个 case 调 testCheck（judgeByExpected）判定，返回 { caseId, passed, actual, failureReason }
    //
    // handleTest 调用此方法时，对 exit_zero/script case 直接用返回的 VerifyResult；
    // 对 exact case（需 agent 提交的 actual）和 requiresScreenshot case（需 screenshotPath）
    // 仍走 handleTest 自己的 testCheck——postDevVerify 这里对 exact 的判定结果会被 handleTest 覆盖，
    // 所以 exact 分支的 actual 传 undefined（testCheck 兜底判 failed，但不影响 handleTest 等价性）。
    // topic.testCases 防御性取值——运行时 topic 来自 store.loadTopic（恒有 testCases 数组），
    // 但策略可被任意 topic 调用（如 review-only 红灯测试传空对象 fixture 走 TDD 回退），
    // 缺 testCases 时按「无 case 可验证」返回空数组而非崩溃。
    if (!topic.testCases || topic.testCases.length === 0) return [];

    const workspacePath = topic.workspacePath;

    // ── 收集 exit_zero / script case 的自动执行结果（与 handleTest 1156-1225 等价） ──
    const executedActualByCaseId = new Map<string, AutoExecResult>();

    // exit_zero：去重执行一次 testRunner，把同一 exitCode 归一化给每个 exit_zero case。
    // expected 防御性取值（与 testCheck 的 testCase.expected ?? {} 兜底对齐）——
    // 运行时 topic.testCases 总有 expected（TestCaseSeed schema 保证），但策略可被
    // 任意 topic 调用（如 review-only 红灯测试传畸形 fixture 走 TDD 回退），缺 expected
    // 时归到「无 auto exec」分支而非崩溃。
    const exitZeroCases = topic.testCases.filter(
      (tc) => (tc.expected?.type ?? "") === "exit_zero",
    );
    if (exitZeroCases.length > 0) {
      let runOutcome: AutoExecResult;
      if (!topic.testRunner) {
        runOutcome = {
          error: "exit_zero case 缺 testRunner 配置（tdd_plan 阶段必须写入 testRunner）",
        };
      } else {
        try {
          const ran = runTestRunner(topic.testRunner, workspacePath);
          runOutcome = { actual: { exitCode: ran.exitCode } };
        } catch (e) {
          runOutcome = {
            error: `testRunner 执行异常：${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }
      for (const tc of exitZeroCases) executedActualByCaseId.set(tc.id, runOutcome);
    }

    // script：各自执行 expected.path（execFileSync 直接执行，不经 shell）。
    // 沙箱二次校验（R1 symlink 绕过修复）：执行前 isPathInsideWorkspace + realpath 校验。
    for (const tc of topic.testCases) {
      const expected = tc.expected;
      if (!expected || expected.type !== "script") continue;
      const relPath = expected.path;
      if (!isPathInsideWorkspace(relPath, workspacePath)) {
        executedActualByCaseId.set(tc.id, {
          error: `script.path 越出 workspace 沙箱（含 symlink 绕过）：${relPath}`,
        });
        continue;
      }
      const absPath = resolve(workspacePath, relPath);
      try {
        execFileSync(absPath, {
          cwd: workspacePath,
          stdio: "ignore",
          timeout: 30000,
          encoding: "utf8",
        });
        executedActualByCaseId.set(tc.id, { actual: { exitCode: 0 } });
      } catch (e) {
        const code = readExitStatus(e);
        if (code !== null) {
          executedActualByCaseId.set(tc.id, { actual: { exitCode: code } });
        } else {
          executedActualByCaseId.set(tc.id, {
            error: `script 执行异常（${relPath}）：${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    }

    // ── 遍历 testCases，调 testCheck 判定，构造 VerifyResult（与 handleTest 1230-1268 等价） ──
    const results: VerifyResult[] = [];
    for (const tc of topic.testCases) {
      const autoExec = executedActualByCaseId.get(tc.id);
      let passed: boolean;
      let failureReason: string | undefined;
      let actual: unknown;

      if (autoExec && "error" in autoExec) {
        // 执行基础设施异常（spawn 失败/testRunner 缺失）→ 直接 failed。
        passed = false;
        failureReason = autoExec.error;
        actual = undefined;
      } else {
        actual = autoExec ? autoExec.actual : undefined;
        // postDevVerify 无 submission（screenshotPath/agent actual），
        // screenshotPath 传 undefined——requiresScreenshot case 会判 failed，
        // 但 handleTest 对这类 case 会用自己的 testCheck 覆盖（带 screenshotPath），等价性不破。
        const judged = testCheck(tc, actual as Actual | undefined, undefined);
        passed = judged.status === "passed";
        failureReason = passed ? undefined : judged.reason;
      }

      results.push({
        caseId: tc.id,
        passed,
        actual,
        failureReason,
      });
    }
    return results;
  }

  replanGuard(oldTopic: Topic, newPayload: unknown): Violation[] {
    // 适配：策略接口是 (oldTopic, newPayload)，原始 validateAppendOnly 是
    // (newWaves, newCases, oldWaves, oldTestCases)。从 newPayload 防御性提取
    // waves/testCases（replan 的 plan.json / test.json 形态），oldWaves/oldTestCases
    // 从 oldTopic 取。提取失败（payload 结构不符）时传空数组——validateAppendOnly
    // 空入参不产生违规，安全降级。
    const { newWaves, newCases } = extractReplanInputs(newPayload);
    const rawViolations = validateAppendOnly(
      newWaves,
      newCases,
      oldTopic.waves,
      oldTopic.testCases,
    );
    return rawViolations.map(toViolation);
  }

  isDevVerified(topic: Topic): boolean {
    // 等价于 state-machine.ts computeGatePassed("test", topic)：
    // testCases 非空且全 passed。空 testCases → false（没测 = 未验证）。
    return (
      topic.testCases.length > 0 &&
      topic.testCases.every((c) => c.status === "passed")
    );
  }

  applyPreDevResult(
    topicId: string,
    store: ApplyPreDevResultStore,
    parsed: unknown,
  ): void {
    // handleTddPlan gate pass 后，把 parsed payload 应用到 store——
    // 替代原 handleTddPlan 事务内硬编码的 insertTestCases + setTestRunner。
    // parsed 形态由 preDevCheck（tddPlanCheck）保证：{ testCases, testRunner? }。
    const p = parsed as {
      testCases: TestCaseSeed[];
      testRunner?: TestRunnerConfig;
    };
    store.insertTestCases(topicId, p.testCases);
    if (p.testRunner) {
      store.setTestRunner(topicId, p.testRunner);
    }
  }
}

/**
 * 从 replan 的 newPayload 防御性提取 newWaves / newCases。
 *
 * payload 在 replan 场景是 plan.json 或 test.json 原始内容（parse 前的 unknown）：
 *   - plan.json：{ waves: WaveSeed[], legacyTestCases?: TestCaseSeed[] }
 *   - test.json：{ testCases: TestCaseSeed[] }
 *   - 混合：--test 模式只校验 testCases，waves 传空跳过 wave 校验
 *
 * 结构不符时返回空——validateAppendOnly 空入参不产生违规，安全降级（W3/W4 接入
 * 实际 replan 路径时若需要更严格的结构校验再补）。
 */
function extractReplanInputs(payload: unknown): {
  newWaves: WaveSeed[];
  newCases: TestCaseSeed[];
} {
  if (typeof payload !== "object" || payload === null) {
    return { newWaves: [], newCases: [] };
  }
  const obj = payload as Record<string, unknown>;
  const waves = Array.isArray(obj.waves) ? (obj.waves as WaveSeed[]) : [];
  const testCases = Array.isArray(obj.testCases)
    ? (obj.testCases as TestCaseSeed[])
    : Array.isArray(obj.legacyTestCases)
      ? (obj.legacyTestCases as TestCaseSeed[])
      : [];
  return { newWaves: waves, newCases: testCases };
}

/** AppendOnlyViolation → Violation 适配（字段对齐：type/reason 直传，caseId/waveId 按 type 填）。 */
function toViolation(v: AppendOnlyViolation): Violation {
  return {
    type: v.type,
    caseId: "caseId" in v ? v.caseId : undefined,
    waveId: "waveId" in v ? v.waveId : undefined,
    reason: v.reason,
  };
}

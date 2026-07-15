/**
 * e2e-test-fix 测试 — E7（test 失败 → test_fix loop → turn 上限熔断）。
 *
 * 覆盖分支：
 *   E7a: test 失败 → nextAction=test_fix，testTurn 仍 0（inc 在 test_fix）
 *   E7b: test_fix 修复 → testTurn 0→1，nextAction=test
 *   E7c: 完整 loop——test(失败)→fix→test(pass)→nextAction=retrospect
 *   E7d: turn 上限熔断——连续 5 次 test_fix → 强制转 retrospect
 *   E7e: 非法——test 传不存在的 caseId → exit≠0
 *
 * test 的 cases 用 --cases flag（JSON 字符串），test_fix 的 fixes 从 stdin 读。
 * expected.text 来自 makeValidTestJson：E1="expected-output"，E2="real-output"。
 * 失败传 actual.text="wrong" 即可触发 judgeByExpected mismatch。
 *
 * 真实子进程跑 dist/cli.js，独立隔离环境。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createE2eEnv,
  disposeE2eEnv,
  type E2eEnv,
  parseStdout,
  runCli,
  setupToReviewed,
} from "./helpers/e2e.js";

let e: E2eEnv;

beforeAll(() => {
  e = createE2eEnv();
});

afterAll(() => {
  disposeE2eEnv(e);
});

/** test 提交 cases（--cases flag），E1 失败（actual 不匹配）。 */
function testFail(topicId: string): Record<string, unknown> {
  return parseStdout(
    runCli(
      ["test", "--topicId", topicId, "--cases", JSON.stringify([
        { caseId: "E1", actual: { text: "wrong-output" } },
      ])],
      e,
    ),
  );
}

/** test 提交 cases，E1+E2 全 pass（actual 匹配 expected）。 */
function testPass(topicId: string): Record<string, unknown> {
  return parseStdout(
    runCli(
      ["test", "--topicId", topicId, "--cases", JSON.stringify([
        { caseId: "E1", actual: { text: "expected-output" } },
        { caseId: "E2", actual: { text: "real-output" } },
      ])],
      e,
    ),
  );
}

/** test_fix 提交 fixes（stdin 读）。 */
function testFix(
  topicId: string,
  fixes: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return parseStdout(
    runCli(["test_fix", "--topicId", topicId], e, {
      input: JSON.stringify(fixes),
    }),
  );
}

// ── E7a: test 失败 → nextAction=test_fix ────────────────────

describe("E7a: test 失败 → nextAction=test_fix, testTurn 仍 0", () => {
  it("actual 不匹配 → tested, nextAction=test_fix", () => {
    const { topicId } = setupToReviewed(e, "e7a-fail");
    const result = testFail(topicId);

    expect(result.status).toBe("tested");
    expect((result.nextAction as Record<string, unknown>).action).toBe("test_fix");
    // testTurn 不在 ActionResult 直接暴露，但 test_fix 后会通过 guidance 体现
  });
});

// ── E7b: test_fix 修复 → testTurn+1, nextAction=test ────────

describe("E7b: test_fix 修复 → nextAction=test", () => {
  it("提交 test_fix({caseId:E1}) → nextAction=test（重跑）", () => {
    const { topicId } = setupToReviewed(e, "e7b-fix");
    testFail(topicId);

    const result = testFix(topicId, [
      { caseId: "E1", commitHash: "fix123", resolution: "修正了输出" },
    ]);
    expect((result.nextAction as Record<string, unknown>).action).toBe("test");
    expect(result.status).toBe("tested");
  });
});

// ── E7c: 完整 test loop ─────────────────────────────────────

describe("E7c: 完整 loop——test(失败)→fix→test(pass)→nextAction=retrospect", () => {
  it("修复后重跑 pass → nextAction=retrospect", () => {
    const { topicId } = setupToReviewed(e, "e7c-loop");

    // test 失败
    testFail(topicId);
    // test_fix
    testFix(topicId, [
      { caseId: "E1", commitHash: "c1", resolution: "已修" },
    ]);
    // 重跑 test，全 pass
    const result = testPass(topicId);

    expect(result.gatePassed).toMatchObject({ test: true });
    expect((result.nextAction as Record<string, unknown>).action).toBe("retrospect");
  });
});

// ── E7d: turn 上限熔断（TEST_TURN_LIMIT=5）────────────────

describe("E7d: 连续 5 次 test_fix → 强制转 retrospect", () => {
  it("testTurn 达 5 上限 → nextAction 强制转 retrospect", () => {
    const { topicId } = setupToReviewed(e, "e7d-limit");

    // 第 1 次 test 失败（testTurn=0）
    testFail(topicId);

    // 连续 5 次 test_fix（每次 inc testTurn）+ 中间 test 失败保持 fail 状态
    // test_fix → test(失败) → test_fix → test(失败) → ... 直到 testTurn=5
    for (let i = 0; i < 5; i++) {
      const fixResult = testFix(topicId, [
        { caseId: "E1", commitHash: `c${i}`, resolution: `fix ${i}` },
      ]);
      // 第 5 次 test_fix 后 testTurn=5，test 分支会强制转 retrospect
      if (i < 4) {
        // 前 4 次：test_fix 后 nextAction=test，继续 test(失败)
        expect((fixResult.nextAction as Record<string, unknown>).action).toBe("test");
        testFail(topicId); // 再次失败，推进
      } else {
        // 第 5 次 test_fix：testTurn 达上限
        // test_fix 后仍 nextAction=test，但调 test 时会触发 retrospect
        const testResult = testFail(topicId);
        // 达上限 → 强制进 retrospect（而非 test_fix）
        expect((testResult.nextAction as Record<string, unknown>).action).toBe(
          "retrospect",
        );
        const guidance = (testResult.nextAction as Record<string, unknown>)
          .guidance as string;
        expect(guidance).toContain("上限");
      }
    }
  });
});

// ── E7e: 非法——test 传不存在的 caseId ───────────────────────

describe("E7e: test 传不存在的 caseId → exit≠0", () => {
  it("caseId E99 不存在 → exit≠0, stderr 含 case not found", () => {
    const { topicId } = setupToReviewed(e, "e7e-illegal");

    const result = runCli(
      ["test", "--topicId", topicId, "--cases", JSON.stringify([
        { caseId: "E99", actual: { text: "x" } },
      ])],
      e,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("case not found");
  });
});

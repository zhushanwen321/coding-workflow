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
  setupToTested,
} from "./helpers/e2e.js";

let e: E2eEnv;

beforeAll(() => {
  e = createE2eEnv();
});

afterAll(() => {
  disposeE2eEnv(e);
});

/** test 提交 cases（--cases flag），E1 失败（actual 不匹配），E2 pass。 */
function testFail(topicId: string): Record<string, unknown> {
  return parseStdout(
    runCli(
      ["test", "--topicId", topicId, "--cases", JSON.stringify([
        { caseId: "E1", actual: { text: "wrong-output" } },
        { caseId: "E2", actual: { text: "real-output" } },
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
  it("actual 不匹配 → post_dev_verified, nextAction=test_fix", () => {
    const { topicId } = setupToReviewed(e, "e7a-fail");
    const result = testFail(topicId);

    expect(result.status).toBe("post_dev_verified");
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
    expect(result.status).toBe("post_dev_verified");
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
  // CI 慢机上 spawn 多个子进程累计耗时：setup(~10 cli) + 1 test + 5×(test_fix + test) ≈ 21 次子进程，
  // 本地 ~1.6s，CI 慢机可达 30s+。vitest 单测默认 5s 超时，此处放宽到 60s。
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
    // 60s：21 次子进程 spawn 在 CI 慢机上累计耗时远超 vitest 默认 5s
  }, 60000);
});

// ── E7e: 非法——test 传不存在的 caseId ───────────────────────

describe("E7e: test 传不存在的 caseId → exit≠0", () => {
  it("caseId E99 不存在 → exit≠0, stderr 含集合不一致（D 全覆盖校验先于逐条 not found）", () => {
    const { topicId } = setupToReviewed(e, "e7e-illegal");

    const result = runCli(
      ["test", "--topicId", topicId, "--cases", JSON.stringify([
        { caseId: "E99", actual: { text: "x" } },
      ])],
      e,
    );
    expect(result.exitCode).not.toBe(0);
    // D 全覆盖校验先抛"不一致/多余"（E99 是多余 id），而非旧的逐条 "case not found"
    expect(result.stderr).toMatch(/不一致|多余/);
  });
});

// ── [BUG-HUNT] test_fix 校验缺口 + test progressive merge ─────
//
// bug-hunt 测试：发现真 bug（红色失败暴露代码缺陷），非覆盖率填充。
// 对照组：验证已知正确的实现（绿色通过）。

// [BUG-HUNT] test_fix 缺 status=failed 守门——对称性破坏
//
// review_fix 校验 issue 必须 status=open（已 fixed 的不能再 fix），
// 但 test_fix 只校验 caseId 存在，不校验 status 是否 failed。
// 后果：对已 passed 的 case 提交 fix 会污染 testFixLog + 虚增 testTurn，
// 累积到 TEST_TURN_LIMIT 后可误触熔断，把一个全 pass 的 topic 强制推进 retrospect。
describe("[BUG-HUNT] test_fix 对已 passed case 提交——应被拒绝", () => {
  it("test 全 pass 后，对已 passed case 调 test_fix → 应拒绝（而非污染审计）", () => {
    const { topicId } = setupToTested(e, "bh-passed-fix");

    // 对已 passed 的 E1 提交 test_fix
    const result = runCli(["test_fix", "--topicId", topicId], e, {
      input: JSON.stringify([
        { caseId: "E1", commitHash: "fake", resolution: "不该被接受的 fix" },
      ]),
    });

    // 期望：被拒绝（exit≠0），与 review_fix 的 status=open 守门对称
    expect(
      result.exitCode,
      "test_fix 对已 passed case 提交应被拒绝（对称 review_fix 的 status=open 守门）。" +
        `实际 exitCode=${result.exitCode}，说明 test_fix 缺 status=failed 守门——这是确认的 bug。`,
    ).not.toBe(0);
  });

  it("若未被拒绝 → testCase.status 不应被污染", () => {
    const { topicId } = setupToTested(e, "bh-status-check");

    runCli(["test_fix", "--topicId", topicId], e, {
      input: JSON.stringify([
        { caseId: "E1", commitHash: "fake", resolution: "虚增 turn" },
      ]),
    });

    const status = parseStdout(runCli(["status", "--topicId", topicId], e));
    const testCases = status.testCases as Array<{ id: string; status: string }>;
    const e1 = testCases.find((c) => c.id === "E1");
    expect(e1!.status).toBe("passed");
  });
});

// test progressive merge——对照组（验证正确的 merge 语义，非 bug）
// D 全覆盖校验后，每次 cw test 必须提交全部 testCase id（禁止部分提交）。
// progressive 语义通过"重跑全部 case"验证：已 passed 的 case 重跑仍 passed。
describe("test 全覆盖重跑——已 pass case 不丢失（对照组）", () => {
  it("第一次 E1(pass)+E2(fail)，第二次 E1(pass)+E2(pass) → 两个都 passed", () => {
    const { topicId } = setupToReviewed(e, "bh-progressive");

    // 第一次：E1 pass，E2 fail
    runCli(
      ["test", "--topicId", topicId, "--cases", JSON.stringify([
        { caseId: "E1", actual: { text: "expected-output" } },
        { caseId: "E2", actual: { text: "wrong" } },
      ])],
      e,
    );

    // 中间状态：E1 passed, E2 failed, gate=false
    let status = parseStdout(runCli(["status", "--topicId", topicId], e));
    let cases = status.testCases as Array<{ id: string; status: string }>;
    expect(cases.find((c) => c.id === "E1")!.status).toBe("passed");
    expect(cases.find((c) => c.id === "E2")!.status).toBe("failed");

    // 第二次：全覆盖重跑，E1 仍 pass，E2 转 pass
    const result = parseStdout(
      runCli(
        ["test", "--topicId", topicId, "--cases", JSON.stringify([
          { caseId: "E1", actual: { text: "expected-output" } },
          { caseId: "E2", actual: { text: "real-output" } },
        ])],
        e,
      ),
    );

    expect(result.gatePassed).toMatchObject({ test: true });
    status = parseStdout(runCli(["status", "--topicId", topicId], e));
    cases = status.testCases as Array<{ id: string; status: string }>;
    expect(cases.find((c) => c.id === "E1")!.status).toBe("passed");
    expect(cases.find((c) => c.id === "E2")!.status).toBe("passed");
  });

  it("E1(pass)+E2(fail) 后重跑全覆盖 → E1 的 passed 不丢失", () => {
    const { topicId } = setupToReviewed(e, "bh-retry");

    runCli(
      ["test", "--topicId", topicId, "--cases", JSON.stringify([
        { caseId: "E1", actual: { text: "expected-output" } },
        { caseId: "E2", actual: { text: "wrong" } },
      ])],
      e,
    );

    const result = parseStdout(
      runCli(
        ["test", "--topicId", topicId, "--cases", JSON.stringify([
          { caseId: "E1", actual: { text: "expected-output" } },
          { caseId: "E2", actual: { text: "real-output" } },
        ])],
        e,
      ),
    );

    expect(result.gatePassed).toMatchObject({ test: true });
    const status = parseStdout(runCli(["status", "--topicId", topicId], e));
    const cases = status.testCases as Array<{ id: string; status: string }>;
    expect(cases.find((c) => c.id === "E1")!.status).toBe("passed");
    expect(cases.find((c) => c.id === "E2")!.status).toBe("passed");
  });
});

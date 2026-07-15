/**
 * e2e-review-fix 测试 — E6（review 带 issues → review_fix loop → turn 上限熔断）。
 *
 * 覆盖分支：
 *   E6a: review 带 2 条 issues → nextAction=review_fix，R1/R2 open，reviewTurn=1
 *   E6b: review_fix 修 R1 → R1=fixed，nextAction=review
 *   E6c: 完整 loop——review(issues)→fix→review(空)→nextAction=test
 *   E6d: turn 上限熔断——连续 3 轮 review 带 issues → 强制转 test
 *   E6e: 非法——review_fix 传不存在的 issueId → exit≠0
 *
 * review 的 issues 从 stdin 读（JSON 数组），review_fix 的 fixes 从 stdin 读。
 * reviewPath 可选——不传时 fileCheck pass（省去建文件）。
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
  setupToDeveloped,
} from "./helpers/e2e.js";

let e: E2eEnv;

beforeAll(() => {
  e = createE2eEnv();
});

afterAll(() => {
  disposeE2eEnv(e);
});

/** review 带 issues（stdin 传 JSON 数组），不传 reviewPath。 */
function reviewWithIssues(
  topicId: string,
  issues: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return parseStdout(
    runCli(["review", "--topicId", topicId], e, {
      input: JSON.stringify(issues),
    }),
  );
}

/** review 不带 issues（无 stdin → 空数组 = 无问题 → gate pass）。 */
function reviewNoIssues(topicId: string): Record<string, unknown> {
  return parseStdout(runCli(["review", "--topicId", topicId], e));
}

/** review_fix 提交 fixes（stdin 传 JSON 数组）。 */
function reviewFix(
  topicId: string,
  fixes: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return parseStdout(
    runCli(["review_fix", "--topicId", topicId], e, {
      input: JSON.stringify(fixes),
    }),
  );
}

// ── E6a: review 带 2 条 issues ──────────────────────────────

describe("E6a: review 带 2 条 issues → nextAction=review_fix, R1/R2 open", () => {
  it("提交 2 条 issues → reviewed, reviewTurn=1, nextAction=review_fix", () => {
    const { topicId } = setupToDeveloped(e, "e6a-issues");
    const result = reviewWithIssues(topicId, [
      { severity: "must-fix", description: "问题1", file: "src/a.ts" },
      { severity: "should-fix", description: "问题2" },
    ]);

    expect(result.status).toBe("reviewed");
    expect((result.nextAction as Record<string, unknown>).action).toBe("review_fix");

    // nextAction guidance 提到 2 个 open issue（review 发现的）
    const guidance = (result.nextAction as Record<string, unknown>).guidance as string;
    expect(guidance).toContain("2");
  });
});

// ── E6b: review_fix 修 R1 ───────────────────────────────────

describe("E6b: review_fix 修 R1 → R1=fixed, nextAction=review", () => {
  it("提交 review_fix({issueId:R1}) → nextAction=review", () => {
    const { topicId } = setupToDeveloped(e, "e6b-fix");
    reviewWithIssues(topicId, [
      { severity: "must-fix", description: "问题1" },
    ]);

    const result = reviewFix(topicId, [
      { issueId: "R1", commitHash: "abc1234", resolution: "修复了空指针" },
    ]);
    expect((result.nextAction as Record<string, unknown>).action).toBe("review");
    expect(result.status).toBe("reviewed");
  });
});

// ── E6c: 完整 review loop ───────────────────────────────────

describe("E6c: 完整 loop——review(issues)→fix→review(空)→nextAction=test", () => {
  it("修完 issue 后重新 review 无新问题 → gate pass → test", () => {
    const { topicId } = setupToDeveloped(e, "e6c-loop");

    // review 发现 1 条 issue
    reviewWithIssues(topicId, [
      { severity: "must-fix", description: "问题1" },
    ]);
    // review_fix 修掉
    reviewFix(topicId, [
      { issueId: "R1", commitHash: "abc1234", resolution: "已修" },
    ]);
    // 重新 review，无新问题（空 issues）
    const result = reviewNoIssues(topicId);

    expect(result.status).toBe("reviewed");
    expect((result.nextAction as Record<string, unknown>).action).toBe("test");
    expect(result.gatePassed).toMatchObject({ review: true });
  });
});

// ── E6d: turn 上限熔断（REVIEW_TURN_LIMIT=3）──────────────

describe("E6d: 连续 3 轮 review 带 issues → 强制转 test", () => {
  it("reviewTurn 达 3 上限 → nextAction 强制转 test（含上限提示）", () => {
    const { topicId } = setupToDeveloped(e, "e6d-limit");

    // 第 1 轮：review 带 issues → reviewTurn=1
    reviewWithIssues(topicId, [{ severity: "must-fix", description: "round1" }]);
    // 修（不重新 review，直接开第 2 轮 review）
    reviewFix(topicId, [{ issueId: "R1", commitHash: "abc1234", resolution: "r1" }]);

    // 第 2 轮：又发现新 issues → reviewTurn=2
    reviewWithIssues(topicId, [{ severity: "must-fix", description: "round2" }]);
    reviewFix(topicId, [{ issueId: "R2", commitHash: "def5678", resolution: "r2" }]);

    // 第 3 轮：又发现新 issues → reviewTurn=3 达上限
    const result = reviewWithIssues(topicId, [
      { severity: "must-fix", description: "round3" },
    ]);

    // 达上限 → 强制进 test（而非 review_fix）
    expect((result.nextAction as Record<string, unknown>).action).toBe("test");
    const guidance = (result.nextAction as Record<string, unknown>).guidance as string;
    expect(guidance).toContain("上限");
  });
});

// ── E6e: 非法——review_fix 传不存在的 issueId ───────────────

describe("E6e: review_fix 传不存在的 issueId → exit≠0", () => {
  it("issueId R99 不存在 → exit≠0, stderr 含不存在", () => {
    const { topicId } = setupToDeveloped(e, "e6e-illegal");
    reviewWithIssues(topicId, [{ severity: "must-fix", description: "问题1" }]);

    const result = runCli(["review_fix", "--topicId", topicId], e, {
      input: JSON.stringify([
        { issueId: "R99", commitHash: "x", resolution: "不存在的 issue" },
      ]),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("不存在");
  });
});

// ── E6f: review issues schema 校验（reviewIssueCheck）─────────

describe("E6f: review issues schema 校验 → 无效输入 exit≠0", () => {
  it("severity 不在枚举 → exit≠0, stderr 含 severity", () => {
    const { topicId } = setupToDeveloped(e, "e6f-bad-severity");
    const result = runCli(["review", "--topicId", topicId], e, {
      input: JSON.stringify([
        { severity: "blocker", description: "问题1" },
      ]),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("severity");
  });

  it("description 缺失 → exit≠0, stderr 含 description", () => {
    const { topicId } = setupToDeveloped(e, "e6f-missing-desc");
    const result = runCli(["review", "--topicId", topicId], e, {
      input: JSON.stringify([
        { severity: "must-fix" },
      ]),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("description");
  });

  it("非对象元素（字符串）→ exit≠0", () => {
    const { topicId } = setupToDeveloped(e, "e6f-non-object");
    const result = runCli(["review", "--topicId", topicId], e, {
      input: JSON.stringify(["just-a-string"]),
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("有效 issues（含可选 category）→ 正常通过", () => {
    const { topicId } = setupToDeveloped(e, "e6f-valid-category");
    const result = reviewWithIssues(topicId, [
      { severity: "must-fix", description: "问题1", category: "type-safety" },
    ]);
    expect(result.status).toBe("reviewed");
    const na = result.nextAction as Record<string, unknown>;
    expect(na.action).toBe("review_fix");
  });

  it("category 不在枚举 → exit≠0, stderr 含 category", () => {
    const { topicId } = setupToDeveloped(e, "e6f-bad-category");
    const result = runCli(["review", "--topicId", topicId], e, {
      input: JSON.stringify([
        { severity: "must-fix", description: "问题1", category: "unknown" },
      ]),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("category");
  });
});

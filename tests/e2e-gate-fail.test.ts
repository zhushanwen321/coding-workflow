/**
 * e2e-gate-fail 测试 — E11（gate fail retry + circuit breaker）。
 *
 * 覆盖分支：
 *   E11a: plan gate fail（format 非 lite）→ status 仍 created, nextAction=plan retry
 *   E11b: circuit breaker——连续 5 次 plan gate fail → guidance 含"熔断"
 *   E11c: fail 后重试成功——fail 1 次 → 修 format=lite → status=planned
 *
 * plan gate fail 触发方式：planJson 的 format 不是 "lite"（如 "mid-clarify"）。
 * GATE_RETRY_LIMIT=5，连续 fail >=5 次后 guidance 换熔断文案（但不阻断重试）。
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
} from "./helpers/e2e.js";
import { makeValidDevPlanJson } from "./helpers/plan.js";

let e: E2eEnv;

beforeAll(() => {
  e = createE2eEnv();
});

afterAll(() => {
  disposeE2eEnv(e);
});

/** create 一个 topic（status=created）。 */
function createTopic(slug: string): string {
  const result = parseStdout(
    runCli(
      ["create", "--slug", slug, "--objective", `gate ${slug}`, "--workspace", e.workspaceDir],
      e,
    ),
  );
  return result.topicId as string;
}

// ── E11a: plan gate fail ────────────────────────────────────

describe("E11a: plan gate fail（format 非 lite）→ status 仍 created, retry", () => {
  it("format=mid-clarify → status=created, nextAction=plan", () => {
    const topicId = createTopic("e11a-fail");
    const result = parseStdout(
      runCli(["plan", "--topicId", topicId], e, {
        input: JSON.stringify({ ...makeValidDevPlanJson(), format: "mid-clarify" }),
      }),
    );

    // status 不变（仍 created）
    expect(result.status).toBe("created");
    // nextAction 指回 plan（retry）
    expect((result.nextAction as Record<string, unknown>).action).toBe("plan");
    // guidance 提示 FAIL
    const guidance = (result.nextAction as Record<string, unknown>).guidance as string;
    expect(guidance.toLowerCase()).toContain("fail");
  });
});

// ── E11b: circuit breaker（连续 5 次 fail）─────────────────

describe("E11b: 连续 5 次 plan gate fail → guidance 含熔断", () => {
  it("第 5 次 fail 后 guidance 触发熔断文案", () => {
    const topicId = createTopic("e11b-circuit");

    const badPlan = JSON.stringify({
      ...makeValidDevPlanJson(),
      format: "mid-clarify",
    });

    // 连续 5 次传非法 planJson
    let lastGuidance = "";
    for (let i = 0; i < 5; i++) {
      const result = parseStdout(
        runCli(["plan", "--topicId", topicId], e, { input: badPlan }),
      );
      lastGuidance = (result.nextAction as Record<string, unknown>).guidance as string;
    }

    // 第 5 次（GATE_RETRY_LIMIT=5）触发熔断
    expect(lastGuidance).toContain("熔断");
  });
});

// ── E11c: fail 后重试成功 ───────────────────────────────────

describe("E11c: fail 1 次后重试成功 → status=planned", () => {
  it("先 fail（format 错）再 pass（format=lite）→ planned", () => {
    const topicId = createTopic("e11c-retry");

    // 第 1 次：fail
    const failResult = parseStdout(
      runCli(["plan", "--topicId", topicId], e, {
        input: JSON.stringify({ ...makeValidDevPlanJson(), format: "bad" }),
      }),
    );
    expect(failResult.status).toBe("created");

    // 第 2 次：修 format=lite → pass
    const passResult = parseStdout(
      runCli(["plan", "--topicId", topicId], e, {
        input: JSON.stringify(makeValidDevPlanJson()),
      }),
    );
    expect(passResult.status).toBe("planned");
    expect((passResult.nextAction as Record<string, unknown>).action).toBe("tdd_plan");
  });
});

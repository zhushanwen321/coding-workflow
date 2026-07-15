/**
 * e2e-clarify 测试 — E5（clarify action，create 后 plan 前的澄清 loop）。
 *
 * 覆盖分支：
 *   E5a: pending clarifyJson（无 answer）→ CL1 pending，nextAction 仍 clarify
 *   E5b: resolved clarifyJson（带 answer）→ resolved，nextAction 转 plan
 *   E5c: progressive——先 pending 后 resolved，2 条记录，有 pending 时仍 clarify
 *   E5d: 全 resolved 后 plan 合法（验证 clarify gatePassed 不阻断 plan）
 *   E5e: 非法状态——planned 后调 clarify → illegal_transition
 *
 * 真实子进程跑 dist/cli.js，独立隔离环境。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createE2eEnv,
  disposeE2eEnv,
  type E2eEnv,
  makeValidClarifyJson,
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

/** create 一个 topic（status=created），返回 topicId。 */
function createTopic(slug: string): string {
  const result = parseStdout(
    runCli(
      ["create", "--slug", slug, "--objective", `clarify ${slug}`, "--workspace", e.workspaceDir],
      e,
    ),
  );
  return result.topicId as string;
}

// ── E5a: pending clarifyJson ────────────────────────────────

describe("E5a: pending clarifyJson（无 answer）→ CL1 pending, nextAction 仍 clarify", () => {
  it("提交无 answer 的 clarifyJson → status=created 不变，CL1 pending", () => {
    const topicId = createTopic("e5a-pending");
    const result = parseStdout(
      runCli(["clarify", "--topicId", topicId], e, {
        input: JSON.stringify(makeValidClarifyJson()),
      }),
    );
    expect(result.status).toBe("created");
    // 有 pending 记录 → nextAction 仍指向 clarify
    expect((result.nextAction as Record<string, unknown>).action).toBe("clarify");

    // clarifyProgress 含 CL1 pending
    const progress = result.clarifyProgress as Array<{
      id: string;
      status: string;
    }>;
    expect(progress).toBeDefined();
    expect(progress.length).toBe(1);
    expect(progress[0]!.id).toBe("CL1");
    expect(progress[0]!.status).toBe("pending");
  });
});

// ── E5b: resolved clarifyJson ───────────────────────────────

describe("E5b: resolved clarifyJson（带 answer）→ nextAction 转 confirm_clarify", () => {
  it("提交带 answer 的 clarifyJson → resolved，nextAction=confirm_clarify", () => {
    const topicId = createTopic("e5b-resolved");
    const result = parseStdout(
      runCli(["clarify", "--topicId", topicId], e, {
        input: JSON.stringify(makeValidClarifyJson({ answer: "迁移 SQLite，并发更好" })),
      }),
    );
    expect(result.status).toBe("created");
    // 全 resolved → nextAction 推荐 confirm_clarify（FR-1: plan 前必须 confirm）
    expect((result.nextAction as Record<string, unknown>).action).toBe("confirm_clarify");

    const progress = result.clarifyProgress as Array<{
      id: string;
      status: string;
    }>;
    expect(progress[0]!.status).toBe("resolved");
  });
});

// ── E5c: progressive（先 pending 后 resolved）──────────────

describe("E5c: progressive——先 pending 后 resolved，有 pending 时仍 clarify", () => {
  it("2 次提交（CL1 pending + CL2 resolved）→ nextAction 仍 clarify", () => {
    const topicId = createTopic("e5c-progressive");

    // 第 1 次：pending（无 answer）
    const r1 = parseStdout(
      runCli(["clarify", "--topicId", topicId], e, {
        input: JSON.stringify(makeValidClarifyJson({ topic: "主题1" })),
      }),
    );
    expect((r1.nextAction as Record<string, unknown>).action).toBe("clarify");

    // 第 2 次：resolved（带 answer）
    const r2 = parseStdout(
      runCli(["clarify", "--topicId", topicId], e, {
        input: JSON.stringify(
          makeValidClarifyJson({ topic: "主题2", answer: "答案2" }),
        ),
      }),
    );
    // CL1 仍 pending → nextAction 仍 clarify（有未解决的澄清）
    expect((r2.nextAction as Record<string, unknown>).action).toBe("clarify");

    const progress = r2.clarifyProgress as Array<{
      id: string;
      status: string;
    }>;
    expect(progress.length).toBe(2);
    const statuses = progress.map((p) => p.status).sort();
    expect(statuses).toEqual(["pending", "resolved"]);
  });
});

// ── E5d: 全 resolved + confirm_clarify 后 plan 合法 ─────────

describe("E5d: 全 resolved + confirm_clarify 后调 plan → 合法进 planned", () => {
  it("clarify 全 resolved → confirm_clarify → plan 成功，status=planned", () => {
    const topicId = createTopic("e5d-then-plan");

    // 提交 1 条 resolved clarify
    parseStdout(
      runCli(["clarify", "--topicId", topicId], e, {
        input: JSON.stringify(makeValidClarifyJson({ answer: "已澄清" })),
      }),
    );

    // FR-1: plan 前必须 confirm_clarify（否则 created → plan 非法）
    const confirmResult = parseStdout(
      runCli(["confirm_clarify", "--topicId", topicId], e),
    );
    expect(confirmResult.status).toBe("clarify_confirmed");

    // confirm 后调 plan 合法
    const planResult = parseStdout(
      runCli(["plan", "--topicId", topicId], e, {
        input: JSON.stringify(makeValidDevPlanJson()),
      }),
    );
    expect(planResult.status).toBe("planned");
  });
});

// ── E5e: 非法状态（planned 后调 clarify）─────────────────

describe("E5e: 非法状态——planned 后调 clarify → illegal_transition", () => {
  it("planned 状态下调 clarify → exit≠0, stderr 含 illegal_transition", () => {
    const topicId = createTopic("e5e-illegal");

    // 先走到 planned（FR-1: plan 前必须 confirm_clarify）
    runCli(["clarify", "--topicId", topicId], e, {
      input: JSON.stringify(makeValidClarifyJson({ answer: "已澄清" })),
    });
    runCli(["confirm_clarify", "--topicId", topicId], e);
    runCli(["plan", "--topicId", topicId], e, {
      input: JSON.stringify(makeValidDevPlanJson()),
    });

    // planned 后调 clarify（只允许 created/clarify_confirmed）→ guard 拒绝
    const result = runCli(["clarify", "--topicId", topicId], e, {
      input: JSON.stringify(makeValidClarifyJson()),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("illegal_transition");
  });
});

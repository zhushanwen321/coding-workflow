/**
 * e2e-stage-pruning 测试 — AC-12/AC-13 步骤 4：Review 阶段裁剪路径。
 *
 * 覆盖 AC：
 *   - AC-12: delete-only shape 从 confirm_clarify 后跳过 spec_review/plan_review，
 *     status 序列 clarify_confirmed → planned → pre_dev_verified（不经过 spec_reviewed/plan_reviewed）
 *   - AC-13: doc-only shape 同上
 *
 * 与 e2e-delete-only.test.ts 的区别：
 *   e2e-delete-only 走全链 setup（setupToPlanReviewed 走 spec_review + plan_review）然后注入 shape，
 *   测的是 existence 策略的验证逻辑（postDevVerify / existenceArtifacts）。
 *   本测试聚焦裁剪路径——create 后立即注入 shape，验证 guidance 分流跳过 spec/plan review。
 *
 * TDD 红灯阶段：
 *   - buildNextAction 的 confirm_clarify/plan case 尚未按 stages 分流（当前恒推 spec_review/plan_review）
 *   - 所以 delete-only/doc-only 的 nextAction.action 仍是 spec_review/plan_review（红灯）
 *   - 实现由后续 subagent 完成，转绿后保留测试作为回归
 *
 * 测试规范（AGENTS.md）：真实子进程跑 dist/cli.js，独立隔离环境，零 mock。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveDbPath } from "../src/cli.js";
import {
  createE2eEnv,
  disposeE2eEnv,
  type E2eEnv,
  parseStdout,
  runCli,
} from "./helpers/e2e.js";

let e: E2eEnv;

beforeAll(() => {
  e = createE2eEnv();
});

afterAll(() => {
  disposeE2eEnv(e);
});

/**
 * 在 _cw.json 里把 topic 的 taskShape 改成目标值。
 *
 * create 命令没有 --taskShape flag，create 后默认 full-tdd。
 * 测试手动注入模拟「create 时传了 --taskShape」的效果。
 */
function injectTaskShape(topicId: string, taskShape: string): void {
  const dbPath = resolveDbPath(e.workspaceDir, e.cwHome);
  const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
    topics: Array<Record<string, unknown>>;
  };
  const t = raw.topics.find((x) => x.topicId === topicId);
  expect(t, `topic ${topicId} 应存在于 _cw.json`).toBeDefined();
  t!.taskShape = taskShape;
  writeFileSync(dbPath, JSON.stringify(raw));
}

/**
 * create topic + 注入 taskShape（在 confirm_clarify 之前注入）。
 *
 * 关键：注入时机在 create 之后、clarify 之前——这样 confirm_clarify pass 时
 * buildNextAction 按 shape 的 stages 分流 guidance。
 */
function createWithShape(slug: string, taskShape: string): string {
  const createResult = parseStdout(
    runCli(
      ["create", "--slug", slug, "--objective", `E2E pruning ${slug}`, "--workspace", e.workspaceDir],
      e,
    ),
  );
  const topicId = createResult.topicId as string;
  injectTaskShape(topicId, taskShape);
  return topicId;
}

/**
 * 走最小化 clarify → confirm_clarify 流程（不带 specSections，只过 gate）。
 *
 * 裁剪 shape 的 confirm_clarify pass 出口应该直接推荐 plan（跳 spec_review）。
 */
function clarifyAndConfirm(topicId: string): { confirmResult: Record<string, unknown> } {
  // 先提交一条最小 clarifyRecord（confirm gate 要求至少 1 条 resolved/skipped）
  const clarifyPayload = JSON.stringify({
    kind: "technical",
    topic: "裁剪测试",
    assessment: "测试裁剪路径",
    question: "测试用",
    answer: "测试",
  });
  runCli(["clarify", "--topicId", topicId], e, { input: clarifyPayload });

  // gen-spec（confirm gate 要求 confirmSpec 存在）
  runCli(["gen-spec", "--topicId", topicId, "--no-open"], e);

  // confirm_clarify
  const confirmResult = parseStdout(
    runCli(["confirm_clarify", "--topicId", topicId], e),
  );
  return { confirmResult };
}

/**
 * 提交最小 dev-plan.json（单 wave），过 plan gate。
 * 裁剪 shape 的 plan pass 出口应该直接推荐 tdd_plan（跳 plan_review）。
 */
function submitMinimalPlan(topicId: string): Record<string, unknown> {
  const plan = {
    format: "lite",
    objective: "pruning test",
    waves: [
      {
        id: "W1",
        changes: [
          { file: "README.md", action: "modify", description: "noop change" },
        ],
        dependsOn: [],
        priority: "P0",
      },
    ],
  };
  return parseStdout(
    runCli(["plan", "--topicId", topicId], e, { input: JSON.stringify(plan) }),
  );
}

// ── AC-12: delete-only 裁剪路径 ───────────────────────────────

describe("AC-12: delete-only shape 裁剪路径", () => {
  it("confirm_clarify pass → nextAction 推 plan（跳 spec_review），status=clarify_confirmed", () => {
    const topicId = createWithShape("ac12-del-confirm", "delete-only");
    const { confirmResult } = clarifyAndConfirm(topicId);

    expect(confirmResult.status).toBe("clarify_confirmed");

    const nextAction = confirmResult.nextAction as { action: string };
    expect(nextAction.action).toBe("plan");
    expect(nextAction.action).not.toBe("spec_review");
  });

  it("plan pass → nextAction 推 tdd_plan（跳 plan_review），status=planned", () => {
    const topicId = createWithShape("ac12-del-plan", "delete-only");
    clarifyAndConfirm(topicId);

    const planResult = submitMinimalPlan(topicId);
    expect(planResult.status).toBe("planned");

    const nextAction = planResult.nextAction as { action: string };
    expect(nextAction.action).toBe("tdd_plan");
    expect(nextAction.action).not.toBe("plan_review");
  });

  it("完整裁剪路径：status 序列不经过 spec_reviewed/plan_reviewed", () => {
    const topicId = createWithShape("ac12-del-path", "delete-only");
    clarifyAndConfirm(topicId);
    const planResult = submitMinimalPlan(topicId);

    // plan pass 后 status=planned（不是 plan_reviewed）
    expect(planResult.status).toBe("planned");

    // 从 status 流转看，delete-only 的路径是：
    // created → clarify_confirmed → planned → pre_dev_verified
    // 不经过 spec_reviewed / plan_reviewed
    // gateHistory 是 _cw.json 顶层独立数组（通过 topicId 关联），不在 topic 对象内。
    const dbPath = resolveDbPath(e.workspaceDir, e.cwHome);
    const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
      gateHistory: Array<{ topicId: string; phase: string }>;
    };
    const phases = raw.gateHistory
      .filter((g) => g.topicId === topicId)
      .map((g) => g.phase);
    expect(phases).not.toContain("spec_review");
    expect(phases).not.toContain("plan_review");
  });
});

// ── AC-13: doc-only 裁剪路径 ──────────────────────────────────

describe("AC-13: doc-only shape 裁剪路径", () => {
  it("confirm_clarify pass → nextAction 推 plan（跳 spec_review）", () => {
    const topicId = createWithShape("ac13-doc-confirm", "doc-only");
    const { confirmResult } = clarifyAndConfirm(topicId);

    expect(confirmResult.status).toBe("clarify_confirmed");

    const nextAction = confirmResult.nextAction as { action: string };
    expect(nextAction.action).toBe("plan");
    expect(nextAction.action).not.toBe("spec_review");
  });

  it("plan pass → nextAction 推 tdd_plan（跳 plan_review）", () => {
    const topicId = createWithShape("ac13-doc-plan", "doc-only");
    clarifyAndConfirm(topicId);

    const planResult = submitMinimalPlan(topicId);
    expect(planResult.status).toBe("planned");

    const nextAction = planResult.nextAction as { action: string };
    expect(nextAction.action).toBe("tdd_plan");
    expect(nextAction.action).not.toBe("plan_review");
  });
});

// ── 回归：full-tdd 不裁剪（路径不变） ─────────────────────────

describe("回归：full-tdd shape 路径不变", () => {
  it("full-tdd（默认）confirm_clarify pass → nextAction 推 spec_review（不裁剪）", () => {
    // create 不注入 taskShape（默认 full-tdd）
    const createResult = parseStdout(
      runCli(
        ["create", "--slug", "ac-regression-full", "--objective", "regression", "--workspace", e.workspaceDir],
        e,
      ),
    );
    const topicId = createResult.topicId as string;

    // gen-spec + confirm
    runCli(["gen-spec", "--topicId", topicId, "--no-open"], e);
    const confirmResult = parseStdout(
      runCli(["confirm_clarify", "--topicId", topicId], e),
    );

    const nextAction = confirmResult.nextAction as { action: string };
    // full-tdd 仍推 spec_review（不裁剪）
    expect(nextAction.action).toBe("spec_review");
  });
});

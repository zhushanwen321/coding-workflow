/**
 * stage-pruning 单测 — 步骤 4：Review 阶段裁剪。
 *
 * 覆盖：
 *   - AC-1/AC-2: TRANSITIONS 扩展（plan 含 clarify_confirmed，tdd_plan 含 planned）
 *   - AC-3/AC-4: delete-only shape guidance 分流（跳 spec_review / plan_review）
 *   - AC-5: doc-only shape 同上
 *   - AC-6: full-tdd shape guidance 路径不变（回归）
 *
 * 裁剪机制（ADR-0004）：扩展 expectedStatuses + buildNextAction 按 stages 分流 guidance。
 * agent 不感知裁剪——guidance 是唯一导航。
 */

import { describe, expect, it } from "vitest";

import { getShape } from "../src/legacy/shapes/registry.js";
import { buildNextAction, checkLinear, getDevIncompleteMessage, getTestIncompleteMessage, TRANSITIONS } from "../src/legacy/state-machine.js";
import type { Topic } from "../src/legacy/types.js";

// ── 测试夹具 ────────────────────────────────────────────────

/** 构造空 Topic（status / taskShape 可定制）。 */
function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    topicId: "cw-test",
    slug: "test",
    objective: "test objective",
    workspacePath: "/tmp",
    topicDir: "/tmp/.xyz-harness/test",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "created",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
    clarifyRecords: [],
    specSections: [],
    adrs: [],
    reviewIssues: [],
    reviewTurn: 0,
    specHistory: [],
    specReviewIssues: [],
    specReviewTurn: 0,
    planReviewIssues: [],
    planReviewTurn: 0,
    testFixLog: [],
    testTurn: 0,
    assessments: [],
    ...overrides,
  };
}

// ── AC-1/AC-2: TRANSITIONS 扩展 ────────────────────────────

describe("AC-1/AC-2: TRANSITIONS expectedStatuses 扩展", () => {
  it("AC-1: plan.expectedStatuses 含 clarify_confirmed（裁剪 shape 跳 spec_review 时合法）", () => {
    expect(TRANSITIONS.plan.expectedStatuses).toContain("clarify_confirmed");
  });

  it("AC-1: checkLinear(plan, clarify_confirmed) → ok（裁剪路径合法）", () => {
    const verdict = checkLinear("plan", "clarify_confirmed");
    expect(verdict.ok).toBe(true);
  });

  it("AC-1: full-tdd 路径不受影响——checkLinear(plan, spec_reviewed) 仍 ok", () => {
    const verdict = checkLinear("plan", "spec_reviewed");
    expect(verdict.ok).toBe(true);
  });

  it("AC-2: tdd_plan.expectedStatuses 含 planned（裁剪 shape 跳 plan_review 时合法）", () => {
    expect(TRANSITIONS.tdd_plan.expectedStatuses).toContain("planned");
  });

  it("AC-2: checkLinear(tdd_plan, planned) → ok（裁剪路径合法）", () => {
    const verdict = checkLinear("tdd_plan", "planned");
    expect(verdict.ok).toBe(true);
  });

  it("AC-2: full-tdd 路径不受影响——checkLinear(tdd_plan, plan_reviewed) 仍 ok", () => {
    const verdict = checkLinear("tdd_plan", "plan_reviewed");
    expect(verdict.ok).toBe(true);
  });
});

// ── AC-3/AC-4: delete-only shape guidance 分流 ─────────────

describe("AC-3/AC-4: delete-only shape guidance 分流", () => {
  it("AC-3: delete-only confirm_clarify pass → guidance 推 plan（跳 spec_review）", () => {
    const topic = makeTopic({
      taskShape: "delete-only",
      status: "clarify_confirmed",
      gateHistory: [
        { id: 0, ts: "2026-01-01T00:00:00.000Z", phase: "confirm_clarify", action: "confirm_clarify", gate: "confirm-gate", result: "pass", progressive: false },
      ],
    });
    const na = buildNextAction("confirm_clarify", topic);
    expect(na.action).toBe("plan");
    expect(na.action).not.toBe("spec_review");
  });

  it("AC-4: delete-only plan pass → guidance 推 tdd_plan（跳 plan_review）", () => {
    const topic = makeTopic({
      taskShape: "delete-only",
      status: "planned",
      gateHistory: [
        { id: 0, ts: "2026-01-01T00:00:00.000Z", phase: "plan", action: "plan", gate: "dev-plan-schema", result: "pass", progressive: false },
      ],
      waves: [{ id: "W1", changes: [], dependsOn: [], committed: null }],
    });
    const na = buildNextAction("plan", topic);
    expect(na.action).toBe("tdd_plan");
    expect(na.action).not.toBe("plan_review");
  });
});

// ── AC-5: doc-only shape 同 delete-only ────────────────────

describe("AC-5: doc-only shape guidance 分流", () => {
  it("AC-5a: doc-only confirm_clarify pass → guidance 推 plan（跳 spec_review）", () => {
    const topic = makeTopic({
      taskShape: "doc-only",
      status: "clarify_confirmed",
      gateHistory: [
        { id: 0, ts: "2026-01-01T00:00:00.000Z", phase: "confirm_clarify", action: "confirm_clarify", gate: "confirm-gate", result: "pass", progressive: false },
      ],
    });
    const na = buildNextAction("confirm_clarify", topic);
    expect(na.action).toBe("plan");
  });

  it("AC-5b: doc-only plan pass → guidance 推 tdd_plan（跳 plan_review）", () => {
    const topic = makeTopic({
      taskShape: "doc-only",
      status: "planned",
      gateHistory: [
        { id: 0, ts: "2026-01-01T00:00:00.000Z", phase: "plan", action: "plan", gate: "dev-plan-schema", result: "pass", progressive: false },
      ],
      waves: [{ id: "W1", changes: [], dependsOn: [], committed: null }],
    });
    const na = buildNextAction("plan", topic);
    expect(na.action).toBe("tdd_plan");
  });
});

// ── AC-6: full-tdd shape guidance 路径不变（回归） ─────────

describe("AC-6: full-tdd shape guidance 路径不变（回归）", () => {
  it("AC-6a: full-tdd confirm_clarify pass → guidance 推 spec_review（路径不变）", () => {
    const topic = makeTopic({
      taskShape: "full-tdd",
      status: "clarify_confirmed",
      gateHistory: [
        { id: 0, ts: "2026-01-01T00:00:00.000Z", phase: "confirm_clarify", action: "confirm_clarify", gate: "confirm-gate", result: "pass", progressive: false },
      ],
    });
    const na = buildNextAction("confirm_clarify", topic);
    expect(na.action).toBe("spec_review");
  });

  it("AC-6b: full-tdd plan pass → guidance 推 plan_review（路径不变）", () => {
    const topic = makeTopic({
      taskShape: "full-tdd",
      status: "planned",
      gateHistory: [
        { id: 0, ts: "2026-01-01T00:00:00.000Z", phase: "plan", action: "plan", gate: "dev-plan-schema", result: "pass", progressive: false },
      ],
      waves: [{ id: "W1", changes: [], dependsOn: [], committed: null }],
    });
    const na = buildNextAction("plan", topic);
    expect(na.action).toBe("plan_review");
  });

  it("AC-6c: 默认 taskShape（undefined）→ 降级 full-tdd（路径不变）", () => {
    const topic = makeTopic({
      // taskShape 不设——模拟存量 topic
      status: "clarify_confirmed",
      gateHistory: [
        { id: 0, ts: "2026-01-01T00:00:00.000Z", phase: "confirm_clarify", action: "confirm_clarify", gate: "confirm-gate", result: "pass", progressive: false },
      ],
    });
    const na = buildNextAction("confirm_clarify", topic);
    expect(na.action).toBe("spec_review");
  });
});

// ── stages 声明验证（辅助） ────────────────────────────────

describe("stages 声明一致性", () => {
  it("delete-only shape 声明 stages 不含 spec_review/plan_review", () => {
    const stages = getShape("delete-only").review.stages;
    expect(stages).not.toContain("spec_review");
    expect(stages).not.toContain("plan_review");
    expect(stages).toContain("review");
  });

  it("doc-only shape 声明 stages 不含 spec_review/plan_review", () => {
    const stages = getShape("doc-only").review.stages;
    expect(stages).not.toContain("spec_review");
    expect(stages).not.toContain("plan_review");
    expect(stages).toContain("review");
  });

  it("full-tdd shape 声明 stages 含全部三段", () => {
    const stages = getShape("full-tdd").review.stages;
    expect(stages).toContain("spec_review");
    expect(stages).toContain("plan_review");
    expect(stages).toContain("review");
  });
});

// ── AC-11: assertPhasePrerequisite 去 TDD 措辞（FR-6） ──────
//
// getDevIncompleteMessage / getTestIncompleteMessage（W1 加到 state-machine.ts）
// 被 assertPhasePrerequisite 用于替代硬编码 TDD 文案。这两个 helper 按 verification
// 策略 id 选文案：tdd 提 wave/testCase（TDD 专属概念），existence 提产物，review-only
// 用通用文案。本块验证文案与 shape 对齐——裁剪后的 shape 不会把 wave/testCase 概念
// 硬塞给无这些概念的 shape。

describe("AC-11: assertPhasePrerequisite 去 TDD 措辞（getDevIncompleteMessage/getTestIncompleteMessage）", () => {
  it("delete-only shape 的 getDevIncompleteMessage 不含 wave（existence 策略提产物）", () => {
    const topic = makeTopic({ taskShape: "delete-only" });
    const msg = getDevIncompleteMessage(topic);
    expect(msg).not.toContain("wave");
    expect(msg).toContain("产物");
  });

  it("doc-only shape 的 getDevIncompleteMessage 不含 wave（review-only 策略通用文案）", () => {
    const topic = makeTopic({ taskShape: "doc-only" });
    const msg = getDevIncompleteMessage(topic);
    expect(msg).not.toContain("wave");
  });

  it("full-tdd shape 的 getDevIncompleteMessage 仍含 wave（TDD 策略不变）", () => {
    const topic = makeTopic({ taskShape: "full-tdd" });
    const msg = getDevIncompleteMessage(topic);
    expect(msg).toContain("wave");
  });

  it("delete-only shape 的 getTestIncompleteMessage 不含 testCase（existence 策略提产物清单）", () => {
    const topic = makeTopic({ taskShape: "delete-only" });
    const msg = getTestIncompleteMessage(topic);
    expect(msg).not.toContain("testCase");
    expect(msg).toContain("产物清单");
  });

  it("full-tdd shape 的 getTestIncompleteMessage 仍含 testCase（TDD 策略不变）", () => {
    const topic = makeTopic({ taskShape: "full-tdd" });
    const msg = getTestIncompleteMessage(topic);
    expect(msg).toContain("testCase");
  });

  it("默认 shape（undefined → 降级 full-tdd）的 getDevIncompleteMessage 含 wave（回归）", () => {
    // makeTopic 不传 taskShape 模拟存量 topic（taskShape undefined）。
    const topic = makeTopic();
    const msg = getDevIncompleteMessage(topic);
    expect(msg).toContain("wave");
  });
});

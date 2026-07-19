/**
 * state-machine 单测 — U1-U11 + U9b/U9c（progressive）。
 *
 * 覆盖：TRANSITIONS 转换表、checkLinear 单重 guard、computeGatePassed、
 * computeNextStatus（progressive 原地停留）、buildNextAction（6 个 action 分支）。
 */

import { describe, expect,it } from "vitest";

import {
  buildNextAction,
  checkLinear,
  computeGatePassed,
  computeNextStatus,
  guard,
  TRANSITIONS,
} from "../src/state-machine.js";
import type { Status,Topic } from "../src/types.js";

// ── 测试夹具 ────────────────────────────────────────────────

/** 构造空 Topic（status 可定制）。 */
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

// ── U1-U5: checkLinear 单重 guard ──────────────────────────

describe("checkLinear / guard（U1-U5）", () => {
  it("U1: create action, status=undefined → guard 通过", () => {
    const verdict = checkLinear("create", undefined);
    expect(verdict.ok).toBe(true);
  });

  it("U1: create 的 nextStatus=created", () => {
    expect(TRANSITIONS.create.nextStatus).toBe("created");
  });

  it("U2: plan action, status=spec_reviewed → guard 通过（FR-4 spec_review 前置）", () => {
    // FR-4: plan 的前置从 clarify_confirmed 改为 spec_reviewed
    const verdict = checkLinear("plan", "spec_reviewed");
    expect(verdict.ok).toBe(true);
  });

  it("AC-1: plan action, status=created（未 confirm）→ guard 拒绝（FR-1 核心防跳过 gate）", () => {
    const verdict = checkLinear("plan", "created");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("illegal_transition");
    }
  });

  it("U3: dev action, status=created → guard 拒绝(illegal_transition)", () => {
    const verdict = checkLinear("dev", "created");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("illegal_transition");
    }
  });

  it("U4: test action, status=planned → guard 拒绝(illegal_transition)", () => {
    const verdict = checkLinear("test", "planned");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("illegal_transition");
      // v2 修订：单重 guard 不产生 phase_incomplete，code 是 illegal_transition
      expect(verdict.reason).toContain("test");
      expect(verdict.reason).toContain("planned");
    }
  });

  it("U5: closeout action, status=developed → guard 拒绝(illegal_transition)", () => {
    const verdict = checkLinear("closeout", "developed");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("illegal_transition");
    }
  });

  it("guard(null) 对 create 通过，对其他拒绝", () => {
    expect(guard("create", null).ok).toBe(true);
    const planVerdict = guard("plan", null);
    expect(planVerdict.ok).toBe(false);
    if (!planVerdict.ok) {
      expect(planVerdict.code).toBe("illegal_transition");
    }
  });
});

// ── U6-U8: computeGatePassed ────────────────────────────────

describe("computeGatePassed（U6-U8）", () => {
  it("U6: dev 全 wave committed → true", () => {
    const topic = makeTopic({
      waves: [
        { id: "W1", dependsOn: [], committed: "abc123", changes: [] },
        { id: "W2", dependsOn: ["W1"], committed: "def456", changes: [] },
      ],
    });
    expect(computeGatePassed("dev", topic)).toBe(true);
  });

  it("U7: dev 有 1 wave 未 committed → false", () => {
    const topic = makeTopic({
      waves: [
        { id: "W1", dependsOn: [], committed: "abc123", changes: [] },
        { id: "W2", dependsOn: ["W1"], committed: null, changes: [] },
      ],
    });
    expect(computeGatePassed("dev", topic)).toBe(false);
  });

  it("U7 补充: dev 无 wave → false", () => {
    const topic = makeTopic({ waves: [] });
    expect(computeGatePassed("dev", topic)).toBe(false);
  });

  it("U8: test 全 testCase passed → true", () => {
    const topic = makeTopic({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s1",
          steps: "steps",
          expected: { type: "exact", text: "hi" },
          executor: "agent",
          status: "passed",
          requiresScreenshot: false,
          dependsOn: [],
        },
      ],
    });
    expect(computeGatePassed("test", topic)).toBe(true);
  });

  it("U8 补充: test 有 pending case → false", () => {
    const topic = makeTopic({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s1",
          steps: "steps",
          expected: { type: "exact", text: "hi" },
          executor: "agent",
          status: "passed",
          requiresScreenshot: false,
          dependsOn: [],
        },
        {
          id: "E2",
          layer: "mock",
          scenario: "s2",
          steps: "steps",
          expected: { type: "exact", text: "hi" },
          executor: "agent",
          status: "pending",
          requiresScreenshot: false,
          dependsOn: [],
        },
      ],
    });
    expect(computeGatePassed("test", topic)).toBe(false);
  });

  it("single-shot: plan gate 有 pass 记录 → true", () => {
    const topic = makeTopic({
      gateHistory: [
        {
          id: 1,
          phase: "plan",
          action: "plan",
          gate: "lite-plan-schema",
          result: "pass",
          ts: "2026-01-01T00:00:00.000Z",
          progressive: false,
        },
      ],
    });
    expect(computeGatePassed("plan", topic)).toBe(true);
  });

  it("create/replan 永远 false", () => {
    const topic = makeTopic();
    expect(computeGatePassed("create", topic)).toBe(false);
    expect(computeGatePassed("replan", topic)).toBe(false);
  });
});

// ── U9b/U9c: computeNextStatus progressive ──────────────────

describe("computeNextStatus progressive（U9b/U9c）", () => {
  it("U9b: dev 在 developed 再调 → 仍 developed（progressive 原地停留）", () => {
    const next = computeNextStatus("dev", "developed");
    expect(next).toBe("developed");
  });

  it("U9b 补充: dev 在 planned 调 → developed（正常前进）", () => {
    const next = computeNextStatus("dev", "planned");
    expect(next).toBe("developed");
  });

  it("U9c: test 在 post_dev_verified 再调 → 仍 post_dev_verified（progressive 原地停留）", () => {
    const next = computeNextStatus("test", "post_dev_verified");
    expect(next).toBe("post_dev_verified");
  });

  it("U9c 补充: test 在 developed 调 → post_dev_verified（正常前进）", () => {
    const next = computeNextStatus("test", "developed");
    expect(next).toBe("post_dev_verified");
  });

  it("replan 总回退 planned（非原地停留）", () => {
    expect(computeNextStatus("replan", "developed")).toBe("planned");
    expect(computeNextStatus("replan", "planned")).toBe("planned");
  });
});

// ── U9-U11: buildNextAction ─────────────────────────────────

describe("buildNextAction（U9-U11）", () => {
  it("U9: create 后 → nextAction.action=clarify, guidance 含 clarify 提示词", () => {
    const topic = makeTopic({ status: "created" });
    const na = buildNextAction("create", topic);
    expect(na.action).toBe("clarify");
    // guidance 含 clarify 提示词（探索→预判→提问→ADR）
    expect(na.guidance).toContain("[clarify 阶段]");
    expect(na.guidance).toContain("澄清需求");
    // FR-1: plan 不再作为 alternative（created 状态下 plan 会 illegal_transition）
    // 必须先 clarify → confirm_clarify → plan
  });

  it("U10: plan gate pass 后 → nextAction.action=plan_review（FR-5 新增 plan_review 前置）, waves 列表返回", () => {
    const topic = makeTopic({
      status: "planned",
      waves: [
        { id: "W1", dependsOn: [], committed: null, changes: [] },
        { id: "W2", dependsOn: ["W1"], committed: null, changes: [] },
      ],
      gateHistory: [
        {
          id: 1,
          phase: "plan",
          action: "plan",
          gate: "lite-plan-schema",
          result: "pass",
          ts: "2026-01-01T00:00:00.000Z",
          progressive: false,
        },
      ],
    });
    const na = buildNextAction("plan", topic);
    // FR-5: plan gate 通过 → 进入 plan_review 阶段（不再直接到 tdd_plan）
    expect(na.action).toBe("plan_review");
    expect(na.waves).toBeDefined();
    expect(na.waves).toHaveLength(2);
    expect(na.waves![0]).toEqual({ id: "W1", committed: false });
    // plan 通过后 status=planned，replan 合法 → 作为 alternative 暴露
    expect(na.alternatives).toHaveLength(1);
    expect(na.alternatives![0].action).toBe("replan");
    expect(na.alternatives![0].guidance).toContain("cw replan");
  });

  it("U10 新增: tdd_plan gate pass 后 → nextAction.action=dev, testCases 列表返回", () => {
    const topic = makeTopic({
      status: "pre_dev_verified",
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out" },
          executor: "agent",
          status: "pending",
          requiresScreenshot: false,
          dependsOn: [],
        },
      ],
      gateHistory: [
        {
          id: 1,
          phase: "tdd_plan",
          action: "tdd_plan",
          gate: "test-json-schema",
          result: "pass",
          ts: "2026-01-01T00:00:00.000Z",
          progressive: false,
        },
      ],
    });
    const na = buildNextAction("tdd_plan", topic);
    // tdd_plan gate 通过 → 进入 dev 阶段
    expect(na.action).toBe("dev");
    expect(na.testCases).toBeDefined();
    expect(na.testCases).toHaveLength(1);
    expect(na.alternatives).toHaveLength(1);
    expect(na.alternatives![0].action).toBe("replan");
  });

  it("U10 新增: tdd_plan gate fail → nextAction 指回 tdd_plan retry", () => {
    const topic = makeTopic({
      status: "planned",
      gateHistory: [
        {
          id: 1,
          phase: "tdd_plan",
          action: "tdd_plan",
          gate: "test-json-schema",
          result: "fail",
          ts: "2026-01-01T00:00:00.000Z",
          progressive: false,
        },
      ],
    });
    const na = buildNextAction("tdd_plan", topic);
    expect(na.action).toBe("tdd_plan");
  });

  it("test gate fail → nextAction.action=test_fix（进 test_fix loop，不再回 dev）", () => {
    const topic = makeTopic({
      status: "post_dev_verified",
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out" },
          executor: "agent",
          status: "failed",
          requiresScreenshot: false,
          dependsOn: [],
        },
      ],
    });
    const na = buildNextAction("test", topic);
    // test 有 case 未通过 → 进 test_fix loop（不再回 dev）
    expect(na.action).toBe("test_fix");
    expect(na.testCases).toBeDefined();
  });

  it("dev 从 post_dev_verified 状态非法（test 失败走 test_fix，不回 dev）", () => {
    // 回归测试：dev.expectedStatuses 不含 post_dev_verified。
    // 新设计：test 失败 → test_fix loop（所有 Wave 已 committed，dev 没有新任务）。
    const verdict = checkLinear("dev", "post_dev_verified");
    expect(verdict.ok).toBe(false);
  });

  it("dev 从 reviewed 状态非法（review 失败走 review_fix，不回 dev）", () => {
    // 回归测试：dev.expectedStatuses 不含 reviewed。
    // 新设计：review 失败 → review_fix loop。
    const verdict = checkLinear("dev", "reviewed");
    expect(verdict.ok).toBe(false);
  });

  it("replan 后 nextAction 指向 plan_review（status=planned 时, D7 改造）", () => {
    // D7: replan 后 status=planned → nextAction 指向 plan_review（FR-5 新增 plan_review 前置）
    // 不再直接指向 tdd_plan（tdd_plan 前置改为 plan_reviewed）
    const topic = makeTopic({ status: "planned" });
    const na = buildNextAction("replan", topic);
    expect(na.action).toBe("plan_review");
  });

  it("U10 补充: plan gate fail → nextAction 指回 plan retry", () => {
    const topic = makeTopic({
      status: "created",
      gateHistory: [
        {
          id: 1,
          phase: "plan",
          action: "plan",
          gate: "lite-plan-schema",
          result: "fail",
          ts: "2026-01-01T00:00:00.000Z",
          progressive: false,
        },
      ],
    });
    const na = buildNextAction("plan", topic);
    expect(na.action).toBe("plan");
  });

  it("U11: dev 全 committed 后 → nextAction.action=review", () => {
    const topic = makeTopic({
      status: "developed",
      waves: [
        { id: "W1", dependsOn: [], committed: "abc", changes: [] },
      ],
    });
    const na = buildNextAction("dev", topic);
    expect(na.action).toBe("review");
    // dev 全 committed 后 nextAction 带 waves 进度摘要（指向 review 阶段）
    expect(na.waves).toBeDefined();
    expect(na.waves).toHaveLength(1);
    // status=developed，replan 合法 → 作为 alternative 暴露（即使 dev 全 committed）
    expect(na.alternatives).toHaveLength(1);
    expect(na.alternatives![0].action).toBe("replan");
  });

  it("U11 补充: dev 未全 committed → nextAction 指回 dev", () => {
    const topic = makeTopic({
      status: "developed",
      waves: [
        { id: "W1", dependsOn: [], committed: "abc", changes: [] },
        { id: "W2", dependsOn: ["W1"], committed: null, changes: [] },
      ],
    });
    const na = buildNextAction("dev", topic);
    expect(na.action).toBe("dev");
    // status=developed，replan 合法 → 作为 alternative 暴露
    expect(na.alternatives).toHaveLength(1);
    expect(na.alternatives![0].action).toBe("replan");
  });
});

// ── 状态机全链路 status 校验 ─────────────────────────────────

describe("状态机线性转换完整性", () => {
  it("线性序列合法（含 clarify_confirmed + spec_review + plan_review）", () => {
    // FR-1: plan 前必须经过 confirm_clarify
    // FR-4/5: confirm_clarify → spec_review → plan → plan_review → tdd_plan
    const sequence: Array<{ status: Status; action: string }> = [
      { status: "created", action: "confirm_clarify" },
      { status: "clarify_confirmed", action: "spec_review" },
      { status: "spec_reviewed", action: "plan" },
      { status: "planned", action: "plan_review" },
      { status: "plan_reviewed", action: "tdd_plan" },
      { status: "pre_dev_verified", action: "dev" },
      { status: "developed", action: "review" },
      { status: "reviewed", action: "test" },
      { status: "post_dev_verified", action: "retrospect" },
    ];

    for (const { status, action } of sequence) {
      const verdict = checkLinear(action as never, status);
      expect(verdict.ok, `${action} from ${status} should pass`).toBe(true);
    }
  });

  it("TRANSITIONS 含全部 action（含 spec_review/plan_review + fix）", () => {
    const actions = [
      "create",
      "clarify",
      "confirm_clarify",
      "spec_review",
      "spec_review_fix",
      "plan",
      "plan_review",
      "plan_review_fix",
      "tdd_plan",
      "dev",
      "review",
      "review_fix",
      "test",
      "test_fix",
      "retrospect",
      "closeout",
      "replan",
      "abort",
      "assess",
    ];
    for (const a of actions) {
      expect(TRANSITIONS).toHaveProperty(a);
    }
  });
});

// ── tdd_plan 转换 + guard ───────────────────────────────────

describe("tdd_plan 转换与 guard", () => {
  it("tdd_plan 从 plan_reviewed 调 → guard 通过, nextStatus=pre_dev_verified（FR-5 plan_review 前置）", () => {
    // FR-5: tdd_plan 的前置从 planned 改为 plan_reviewed
    expect(checkLinear("tdd_plan", "plan_reviewed").ok).toBe(true);
    expect(TRANSITIONS.tdd_plan.nextStatus).toBe("pre_dev_verified");
    expect(computeNextStatus("tdd_plan", "plan_reviewed")).toBe("pre_dev_verified");
  });

  it("tdd_plan 从 planned 调 → guard 通过（步骤 4 裁剪：delete-only/doc-only 跳过 plan_review）", () => {
    // 步骤 4 扩展 tdd_plan.expectedStatuses 加 planned——裁剪 shape（stages 不含 plan_review）
    // 从 plan 直接进 tdd_plan 合法。full-tdd 仍走 plan_review→tdd_plan。
    expect(checkLinear("tdd_plan", "planned").ok).toBe(true);
  });

  it("tdd_plan 从 created 调 → guard 拒绝(illegal_transition)", () => {
    const verdict = checkLinear("tdd_plan", "created");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("illegal_transition");
      expect(verdict.reason).toContain("tdd_plan");
    }
  });

  it("tdd_plan 从 developed 调 → guard 拒绝(illegal_transition)", () => {
    const verdict = checkLinear("tdd_plan", "developed");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("illegal_transition");
    }
  });

  it("dev 从 planned（未过 tdd_plan）调 → guard 拒绝(illegal_transition)", () => {
    const verdict = checkLinear("dev", "planned");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("illegal_transition");
      expect(verdict.reason).toContain("dev");
      expect(verdict.reason).toContain("planned");
    }
  });

  it("dev 从 pre_dev_verified 调 → guard 通过", () => {
    expect(checkLinear("dev", "pre_dev_verified").ok).toBe(true);
  });

  it("replan 从 pre_dev_verified 调 → guard 通过", () => {
    expect(checkLinear("replan", "pre_dev_verified").ok).toBe(true);
  });

  it("tdd_plan gate 有 pass 记录 → computeGatePassed=true", () => {
    const topic = makeTopic({
      status: "pre_dev_verified",
      gateHistory: [
        {
          id: 1,
          phase: "tdd_plan",
          action: "tdd_plan",
          gate: "test-json-schema",
          result: "pass",
          ts: "2026-01-01T00:00:00.000Z",
          progressive: false,
        },
      ],
    });
    expect(computeGatePassed("tdd_plan", topic)).toBe(true);
  });

  it("tdd_plan 无 pass 记录 → computeGatePassed=false", () => {
    const topic = makeTopic({ status: "planned" });
    expect(computeGatePassed("tdd_plan", topic)).toBe(false);
  });
});

// ── clarify 状态机（TRANSITIONS / computeGatePassed / buildNextAction） ──

describe("clarify 状态机", () => {
  it("checkLinear(\"clarify\", \"created\") → ok=true", () => {
    // clarify 在 created 状态合法（progressive，可多次调）。
    expect(checkLinear("clarify", "created").ok).toBe(true);
  });

  it("checkLinear(\"clarify\", \"clarify_confirmed\") → ok=true（FR-1 回头修改）", () => {
    // FR-1: clarify 在 clarify_confirmed 也合法（用户看了确认文档后改 spec 再重新 confirm）。
    expect(checkLinear("clarify", "clarify_confirmed").ok).toBe(true);
  });

  it("checkLinear(\"clarify\", \"planned\") → ok=false, code=\"illegal_transition\"", () => {
    // clarify 只在 created/clarify_confirmed 合法，plan 之后不再允许。
    const verdict = checkLinear("clarify", "planned");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("illegal_transition");
    }
  });

  it("AC-1: checkLinear(\"confirm_clarify\", \"created\") → ok=true（FR-1 状态流转）", () => {
    expect(checkLinear("confirm_clarify", "created").ok).toBe(true);
  });

  it("confirm_clarify progressive：checkLinear(\"confirm_clarify\", \"clarify_confirmed\") → ok=true", () => {
    // FR-1: confirm_clarify 在 clarify_confirmed 也合法（重新 confirm 覆盖旧 md）。
    expect(checkLinear("confirm_clarify", "clarify_confirmed").ok).toBe(true);
  });

  it("abort 从各 status 合法（FR-3）", () => {
    // FR-3: abort 从所有非终态 status 合法
    const nonTerminal: Status[] = [
      "created",
      "clarify_confirmed",
      "planned",
      "pre_dev_verified",
      "developed",
      "reviewed",
      "post_dev_verified",
      "retrospected",
    ];
    for (const s of nonTerminal) {
      const verdict = checkLinear("abort", s);
      expect(verdict.ok, `abort from ${s} should pass`).toBe(true);
    }
    // abort 从终态不合法
    expect(checkLinear("abort", "closed").ok).toBe(false);
    expect(checkLinear("abort", "aborted").ok).toBe(false);
  });

  it("computeGatePassed(\"clarify\", topic) 空 clarifyRecords → true", () => {
    // 空数组（没走过 clarify）也算 pass——清晰需求可直接 plan。
    const topic = makeTopic({ clarifyRecords: [] });
    expect(computeGatePassed("clarify", topic)).toBe(true);
  });

  it("computeGatePassed(\"clarify\", topic) 全 resolved → true", () => {
    const topic = makeTopic({
      clarifyRecords: [
        {
          id: "CL1",
          kind: "technical",
          topic: "存储方案",
          assessment: "a",
          question: "q?",
          status: "resolved",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(computeGatePassed("clarify", topic)).toBe(true);
  });

  it("computeGatePassed(\"clarify\", topic) 有 pending → false", () => {
    const topic = makeTopic({
      clarifyRecords: [
        {
          id: "CL1",
          kind: "technical",
          topic: "存储方案",
          assessment: "a",
          question: "q?",
          status: "resolved",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "CL2",
          kind: "requirement",
          topic: "重试上限",
          assessment: "a",
          question: "q?",
          status: "pending",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(computeGatePassed("clarify", topic)).toBe(false);
  });

  it("buildNextAction(\"clarify\", topic) 有 pending → action=\"clarify\"", () => {
    const topic = makeTopic({
      clarifyRecords: [
        {
          id: "CL1",
          kind: "technical",
          topic: "存储方案",
          assessment: "a",
          question: "q?",
          status: "pending",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const na = buildNextAction("clarify", topic);
    expect(na.action).toBe("clarify");
  });

  it("buildNextAction(\"clarify\", topic) 全 resolved → action=\"plan\", alternatives 含 clarify", () => {
    const topic = makeTopic({
      clarifyRecords: [
        {
          id: "CL1",
          kind: "technical",
          topic: "存储方案",
          assessment: "a",
          question: "q?",
          status: "resolved",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const na = buildNextAction("clarify", topic);
    // FR-1: 有 resolved 记录 → 推荐 confirm_clarify（不再直接 plan）
    expect(na.action).toBe("confirm_clarify");
    expect(na.alternatives).toBeDefined();
    expect(na.alternatives!.some((a) => a.action === "clarify")).toBe(true);
  });

    it("buildNextAction(\"clarify\", topic) 空 clarifyRecords → action=\"clarify\"", () => {
    // FR-1: 空数组时不能 confirm（gate 会拒）→ 继续指向 clarify。
    const topic = makeTopic({ clarifyRecords: [] });
    const na = buildNextAction("clarify", topic);
    expect(na.action).toBe("clarify");
  });
});

// ── W1: review_fix / test_fix 状态机转换 + progressive review ──

describe("review_fix / test_fix 状态机", () => {
  describe("TRANSITIONS 定义", () => {
    it("TRANSITIONS 含 review_fix 和 test_fix", () => {
      expect(TRANSITIONS).toHaveProperty("review_fix");
      expect(TRANSITIONS).toHaveProperty("test_fix");
    });

    it("review_fix: expectedStatuses=[reviewed], nextStatus=reviewed, progressive=true", () => {
      expect(TRANSITIONS.review_fix.expectedStatuses).toEqual(["reviewed"]);
      expect(TRANSITIONS.review_fix.nextStatus).toBe("reviewed");
      expect(TRANSITIONS.review_fix.progressive).toBe(true);
    });

    it("test_fix: expectedStatuses=[post_dev_verified], nextStatus=post_dev_verified, progressive=true", () => {
      expect(TRANSITIONS.test_fix.expectedStatuses).toEqual(["post_dev_verified"]);
      expect(TRANSITIONS.test_fix.nextStatus).toBe("post_dev_verified");
      expect(TRANSITIONS.test_fix.progressive).toBe(true);
    });

    it("review 改为 progressive（expectedStatuses 含 reviewed）", () => {
      expect(TRANSITIONS.review.expectedStatuses).toContain("reviewed");
      expect(TRANSITIONS.review.nextStatus).toBe("reviewed");
      expect(TRANSITIONS.review.progressive).toBe(true);
    });

    it("test 仍是 progressive（expectedStatuses=[reviewed, post_dev_verified]）", () => {
      expect(TRANSITIONS.test.expectedStatuses).toEqual(["reviewed", "post_dev_verified"]);
      expect(TRANSITIONS.test.nextStatus).toBe("post_dev_verified");
      expect(TRANSITIONS.test.progressive).toBe(true);
    });
  });

  describe("review_fix 转换（reviewed → reviewed progressive）", () => {
    it("checkLinear(\"review_fix\", \"reviewed\") → ok=true", () => {
      expect(checkLinear("review_fix", "reviewed").ok).toBe(true);
    });

    it("computeNextStatus(\"review_fix\", \"reviewed\") → reviewed（progressive 原地停留）", () => {
      expect(computeNextStatus("review_fix", "reviewed")).toBe("reviewed");
    });
  });

  describe("test_fix 转换（post_dev_verified → post_dev_verified progressive）", () => {
    it("checkLinear(\"test_fix\", \"post_dev_verified\") → ok=true", () => {
      expect(checkLinear("test_fix", "post_dev_verified").ok).toBe(true);
    });

    it("computeNextStatus(\"test_fix\", \"post_dev_verified\") → post_dev_verified（progressive 原地停留）", () => {
      expect(computeNextStatus("test_fix", "post_dev_verified")).toBe("post_dev_verified");
    });
  });

  describe("review_fix guard（非法 status）", () => {
    it("checkLinear(\"review_fix\", \"developed\") → ok=false, code=illegal_transition", () => {
      const verdict = checkLinear("review_fix", "developed");
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.code).toBe("illegal_transition");
        expect(verdict.reason).toContain("review_fix");
        expect(verdict.reason).toContain("developed");
      }
    });

    it("checkLinear(\"review_fix\", \"post_dev_verified\") → ok=false（test_fix 只接 reviewed）", () => {
      const verdict = checkLinear("review_fix", "post_dev_verified");
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.code).toBe("illegal_transition");
      }
    });

    it("checkLinear(\"review_fix\", undefined) → ok=false（需已存在 topic）", () => {
      const verdict = checkLinear("review_fix", undefined);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.code).toBe("illegal_transition");
      }
    });
  });

  describe("test_fix guard（非法 status）", () => {
    it("checkLinear(\"test_fix\", \"reviewed\") → ok=false, code=illegal_transition", () => {
      const verdict = checkLinear("test_fix", "reviewed");
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.code).toBe("illegal_transition");
        expect(verdict.reason).toContain("test_fix");
        expect(verdict.reason).toContain("reviewed");
      }
    });

    it("checkLinear(\"test_fix\", \"developed\") → ok=false", () => {
      const verdict = checkLinear("test_fix", "developed");
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.code).toBe("illegal_transition");
      }
    });

    it("checkLinear(\"test_fix\", undefined) → ok=false", () => {
      const verdict = checkLinear("test_fix", undefined);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.code).toBe("illegal_transition");
      }
    });
  });

  describe("review progressive（多轮 review loop）", () => {
    it("checkLinear(\"review\", \"reviewed\") → ok=true（fix 后可再 review）", () => {
      // review 改为 progressive 后，reviewed 状态下再次 review 合法（fix 后重审）。
      expect(checkLinear("review", "reviewed").ok).toBe(true);
    });

    it("checkLinear(\"review\", \"developed\") → ok=true（首次 review 仍合法）", () => {
      expect(checkLinear("review", "developed").ok).toBe(true);
    });

    it("checkLinear(\"review\", \"post_dev_verified\") → ok=false（review 不接 post_dev_verified）", () => {
      const verdict = checkLinear("review", "post_dev_verified");
      expect(verdict.ok).toBe(false);
    });
  });

  describe("buildNextAction review_fix / test_fix 导航", () => {
    it("buildNextAction(\"review_fix\", topic) 未达上限 → action=review（重审）", () => {
      const topic = makeTopic({ status: "reviewed", reviewTurn: 1 });
      const na = buildNextAction("review_fix", topic);
      expect(na.action).toBe("review");
      expect(na.guidance).toContain("review_fix");
    });

    it("buildNextAction(\"review_fix\", topic) 达上限 → guidance 含上限告警, alternatives 含 replan", () => {
      const topic = makeTopic({ status: "reviewed", reviewTurn: 3 });
      const na = buildNextAction("review_fix", topic);
      expect(na.guidance).toMatch(/上限|replan|ask_user/);
      expect(na.alternatives).toBeDefined();
      expect(na.alternatives!.some((a) => a.action === "replan")).toBe(true);
    });

    it("buildNextAction(\"test_fix\", topic) 未达上限 → action=test（重跑）", () => {
      const topic = makeTopic({ status: "post_dev_verified", testTurn: 1 });
      const na = buildNextAction("test_fix", topic);
      expect(na.action).toBe("test");
      expect(na.guidance).toContain("test_fix");
    });

    it("buildNextAction(\"test_fix\", topic) 达上限 → action 仍为 test（overLimit 判定在 test 分支）", () => {
      const topic = makeTopic({ status: "post_dev_verified", testTurn: 5 });
      const na = buildNextAction("test_fix", topic);
      // test_fix 总是指向 test（重跑），达上限的强制前推在 test 分支判定（→ retrospect）
      expect(na.action).toBe("test");
    });
  });
});

// ── W5: buildNextAction review/test/review_fix/test_fix 改造 ──

describe("buildNextAction review/test loop（W5）", () => {
  it("W5-1: review 有 open issue → nextAction=review_fix", () => {
    const topic = makeTopic({
      status: "reviewed",
      reviewTurn: 1,
      reviewIssues: [
        {
          id: "R1",
          severity: "must-fix",
          description: "问题",
          dimension: "error-handling",
          status: "open",
          foundAtTurn: 1,
        },
      ],
    });
    const na = buildNextAction("review", topic);
    expect(na.action).toBe("review_fix");
  });

  it("W5-2: review 无 issue（空数组）→ nextAction=test", () => {
    const topic = makeTopic({
      status: "reviewed",
      reviewTurn: 0,
      reviewIssues: [],
    });
    const na = buildNextAction("review", topic);
    expect(na.action).toBe("test");
  });

  it("W5-3: review 无 issue（全已 fixed）→ nextAction=test", () => {
    const topic = makeTopic({
      status: "reviewed",
      reviewTurn: 1,
      reviewIssues: [
        {
          id: "R1",
          severity: "must-fix",
          description: "问题",
          dimension: "error-handling",
          status: "fixed",
          foundAtTurn: 1,
          fix: { commitHash: "abc", resolution: "已修", fixedAtTurn: 1 },
        },
      ],
    });
    const na = buildNextAction("review", topic);
    expect(na.action).toBe("test");
  });

  it("W5-4: review 达上限（reviewTurn>=3）+ open issues → nextAction=test（强制进 test）", () => {
    const topic = makeTopic({
      status: "reviewed",
      reviewTurn: 3,
      reviewIssues: [
        {
          id: "R1",
          severity: "must-fix",
          description: "未修",
          dimension: "error-handling",
          status: "open",
          foundAtTurn: 3,
        },
      ],
    });
    const na = buildNextAction("review", topic);
    expect(na.action).toBe("test");
    // guidance 标注未修复的 must-fix
    expect(na.guidance).toMatch(/must-fix|强制/);
  });

  it("W5-5: review_fix → nextAction=review（下一轮复查）", () => {
    const topic = makeTopic({ status: "reviewed", reviewTurn: 1 });
    const na = buildNextAction("review_fix", topic);
    expect(na.action).toBe("review");
  });

  it("W5-6: test fail → nextAction=test_fix（不再回 dev）", () => {
    const topic = makeTopic({
      status: "post_dev_verified",
      testTurn: 0,
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out" },
          executor: "agent",
          status: "failed",
          requiresScreenshot: false,
          dependsOn: [],
        },
      ],
    });
    const na = buildNextAction("test", topic);
    expect(na.action).toBe("test_fix");
  });

  it("W5-7: test_fix → nextAction=test（重跑）", () => {
    const topic = makeTopic({ status: "post_dev_verified", testTurn: 1 });
    const na = buildNextAction("test_fix", topic);
    expect(na.action).toBe("test");
  });

  it("W5-8: test 达上限（testTurn>=5）+ failed → 强制进 retrospect（打破死循环）", () => {
    const topic = makeTopic({
      status: "post_dev_verified",
      testTurn: 5,
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out" },
          executor: "agent",
          status: "failed",
          requiresScreenshot: false,
          dependsOn: [],
        },
      ],
    });
    const na = buildNextAction("test", topic);
    // overLimit 时强制 action=retrospect（不再 test_fix），打破 test↔test_fix 死循环
    expect(na.action).toBe("retrospect");
    expect(na.guidance).toMatch(/上限|强制/);
  });
});

// ── FR-1: buildNextAction confirm_clarify 分支 ───────────────

describe("FR-1: buildNextAction confirm_clarify 分支", () => {
  it("created 状态（有 resolved clarifyRecord）→ nextAction=confirm_clarify", () => {
    const topic = makeTopic({
      status: "created",
      clarifyRecords: [
        {
          id: "CL1",
          kind: "technical",
          topic: "test",
          assessment: "背景",
          question: "Q?",
          status: "resolved",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const na = buildNextAction("clarify", topic);
    // 有 resolved 记录 → 主推荐 confirm_clarify（不再停在 clarify）
    expect(na.action).toBe("confirm_clarify");
  });

  it("created 状态（无 clarifyRecord）→ nextAction 仍 clarify（还没探索）", () => {
    const topic = makeTopic({ status: "created", clarifyRecords: [] });
    const na = buildNextAction("clarify", topic);
    expect(na.action).toBe("clarify");
  });

  it("created 状态（有 pending clarifyRecord）→ nextAction 仍 clarify（等用户回答）", () => {
    const topic = makeTopic({
      status: "created",
      clarifyRecords: [
        {
          id: "CL1",
          kind: "technical",
          topic: "test",
          assessment: "背景",
          question: "Q?",
          status: "pending",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const na = buildNextAction("clarify", topic);
    expect(na.action).toBe("clarify");
  });
});

// ── FR-3: buildNextAction abort 分支 ─────────────────────────

describe("FR-3: buildNextAction abort 分支", () => {
  it("abort 后 nextAction.action 为空（终态）", () => {
    const topic = makeTopic({ status: "aborted" });
    const na = buildNextAction("abort", topic);
    expect(na.action).toBeUndefined();
  });
});

// ── FR-4: spec_review 转换 + guard + buildNextAction ─────────

describe("FR-4: spec_review 状态机", () => {
  it("spec_review 从 clarify_confirmed 调 → guard 通过, nextStatus=spec_reviewed", () => {
    expect(checkLinear("spec_review" as never, "clarify_confirmed").ok).toBe(true);
    expect(TRANSITIONS.spec_review.nextStatus).toBe("spec_reviewed");
    expect(computeNextStatus("spec_review" as never, "clarify_confirmed" as never)).toBe("spec_reviewed");
  });

  it("spec_review 从 spec_reviewed 调 → guard 通过（progressive，多轮 loop）", () => {
    expect(checkLinear("spec_review" as never, "spec_reviewed" as never).ok).toBe(true);
  });

  it("spec_review 从 created 调 → guard 拒绝（必须先 confirm_clarify）", () => {
    const verdict = checkLinear("spec_review" as never, "created");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("illegal_transition");
      expect(verdict.reason).toContain("spec_review");
      expect(verdict.reason).toContain("created");
    }
  });

  it("spec_review 从 planned 调 → guard 拒绝（spec_review 在 plan 之前）", () => {
    expect(checkLinear("spec_review" as never, "planned" as never).ok).toBe(false);
  });

  it("spec_review_fix 从 spec_reviewed 调 → guard 通过（progressive 留在 reviewed）", () => {
    expect(checkLinear("spec_review_fix" as never, "spec_reviewed" as never).ok).toBe(true);
  });

  it("spec_review_fix 从 clarify_confirmed 调 → guard 拒绝", () => {
    expect(checkLinear("spec_review_fix" as never, "clarify_confirmed").ok).toBe(false);
  });

  it("spec_review_fix 的 nextStatus=spec_reviewed（progressive 留原地）", () => {
    expect(TRANSITIONS.spec_review_fix.nextStatus).toBe("spec_reviewed");
  });

  it("plan 从 spec_reviewed 调 → guard 通过（spec_review 是 plan 前置）", () => {
    expect(checkLinear("plan", "spec_reviewed" as never).ok).toBe(true);
  });

  it("plan 从 clarify_confirmed 调 → guard 通过（步骤 4 裁剪：delete-only/doc-only 跳过 spec_review）", () => {
    // 步骤 4 扩展 plan.expectedStatuses 加 clarify_confirmed——裁剪 shape（stages 不含 spec_review）
    // 从 confirm_clarify 直接进 plan 合法。full-tdd 仍走 spec_review→plan。
    expect(checkLinear("plan", "clarify_confirmed").ok).toBe(true);
  });

  it("buildNextAction spec_review 无 open issue → 指向 plan", () => {
    const topic = makeTopic({
      status: "spec_reviewed" as never,
      specReviewIssues: [],
    });
    const na = buildNextAction("spec_review" as never, topic);
    expect(na.action).toBe("plan");
  });

  it("buildNextAction spec_review 有 open issue 未达上限 → 指向 spec_review_fix", () => {
    const topic = makeTopic({
      status: "spec_reviewed" as never,
      specReviewTurn: 0,
      specReviewIssues: [
        {
          id: "SR1",
          dimension: "completeness" as never,
          severity: "must-fix",
          description: "UC-1 缺异常流程",
          status: "open",
          foundAtTurn: 1,
        },
      ],
    });
    const na = buildNextAction("spec_review" as never, topic);
    expect(na.action).toBe("spec_review_fix");
  });
});

// ── FR-5: plan_review 转换 + guard + buildNextAction ─────────

describe("FR-5: plan_review 状态机", () => {
  it("plan_review 从 planned 调 → guard 通过, nextStatus=plan_reviewed", () => {
    expect(checkLinear("plan_review" as never, "planned").ok).toBe(true);
    expect(TRANSITIONS.plan_review.nextStatus).toBe("plan_reviewed");
  });

  it("plan_review 从 plan_reviewed 调 → guard 通过（progressive）", () => {
    expect(checkLinear("plan_review" as never, "plan_reviewed" as never).ok).toBe(true);
  });

  it("plan_review 从 pre_dev_verified 调 → guard 拒绝（plan_review 在 tdd_plan 之前）", () => {
    expect(checkLinear("plan_review" as never, "pre_dev_verified").ok).toBe(false);
  });

  it("plan_review_fix 从 plan_reviewed 调 → guard 通过", () => {
    expect(checkLinear("plan_review_fix" as never, "plan_reviewed" as never).ok).toBe(true);
  });

  it("tdd_plan 从 plan_reviewed 调 → guard 通过（plan_review 是 tdd_plan 前置）", () => {
    expect(checkLinear("tdd_plan", "plan_reviewed" as never).ok).toBe(true);
  });

  it("tdd_plan 从 planned 调 → guard 通过（步骤 4 裁剪：跳过 plan_review）", () => {
    // 步骤 4 扩展 tdd_plan.expectedStatuses 加 planned——裁剪 shape 跳过 plan_review 时合法。
    expect(checkLinear("tdd_plan", "planned").ok).toBe(true);
  });

  it("buildNextAction plan_review 无 open issue → 指向 tdd_plan", () => {
    const topic = makeTopic({
      status: "plan_reviewed" as never,
      planReviewIssues: [],
    });
    const na = buildNextAction("plan_review" as never, topic);
    expect(na.action).toBe("tdd_plan");
  });

  it("buildNextAction plan_review 有 open issue 未达上限 → 指向 plan_review_fix", () => {
    const topic = makeTopic({
      status: "plan_reviewed" as never,
      planReviewTurn: 0,
      planReviewIssues: [
        {
          id: "PR1",
          dimension: "coverage" as never,
          severity: "must-fix",
          description: "FR-3 无对应 Wave",
          status: "open",
          foundAtTurn: 1,
        },
      ],
    });
    const na = buildNextAction("plan_review" as never, topic);
    expect(na.action).toBe("plan_review_fix");
  });
});

// ── FR-4/5 turn 上限强制前推 ────────────────────────────────

describe("FR-4/5: spec_review/plan_review turn 上限强制前推", () => {
  it("spec_review 达上限 + 有 open issue → 强制前推到 plan", () => {
    const topic = makeTopic({
      status: "spec_reviewed" as never,
      specReviewTurn: 2,
      specReviewIssues: [
        {
          id: "SR1",
          dimension: "completeness" as never,
          severity: "must-fix",
          description: "未闭环",
          status: "open",
          foundAtTurn: 1,
        },
      ],
    });
    const na = buildNextAction("spec_review" as never, topic);
    expect(na.action).toBe("plan");
  });

  it("plan_review 达上限 + 有 open issue → 强制前推到 tdd_plan", () => {
    const topic = makeTopic({
      status: "plan_reviewed" as never,
      planReviewTurn: 2,
      planReviewIssues: [
        {
          id: "PR1",
          dimension: "coverage" as never,
          severity: "must-fix",
          description: "未闭环",
          status: "open",
          foundAtTurn: 1,
        },
      ],
    });
    const na = buildNextAction("plan_review" as never, topic);
    expect(na.action).toBe("tdd_plan");
  });
});

// ── D7: replan 条件回退 ─────────────────────────────────────

describe("D7: replan 条件回退（hasPlan→planned, hasTest only→plan_reviewed）", () => {
  it("replan 从 plan_reviewed 调 → guard 通过", () => {
    expect(checkLinear("replan", "plan_reviewed" as never).ok).toBe(true);
  });

  it("replan 从 planned 调 → guard 通过（plan 阶段直接 replan）", () => {
    expect(checkLinear("replan", "planned").ok).toBe(true);
  });

  it("replan 从 clarify_confirmed 调 → guard 拒绝（replan 不能回退到 spec_review 之前）", () => {
    expect(checkLinear("replan", "clarify_confirmed").ok).toBe(false);
  });
});

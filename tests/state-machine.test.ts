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
    adrs: [],
    reviewIssues: [],
    reviewTurn: 0,
    testFixLog: [],
    testTurn: 0,
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

  it("U2: plan action, status=created → guard 通过", () => {
    const verdict = checkLinear("plan", "created");
    expect(verdict.ok).toBe(true);
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
          expected: { text: "hi" },
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
          expected: { text: "hi" },
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
          expected: { text: "hi" },
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

  it("U9c: test 在 tested 再调 → 仍 tested（progressive 原地停留）", () => {
    const next = computeNextStatus("test", "tested");
    expect(next).toBe("tested");
  });

  it("U9c 补充: test 在 developed 调 → tested（正常前进）", () => {
    const next = computeNextStatus("test", "developed");
    expect(next).toBe("tested");
  });

  it("replan 总回退 planned（非原地停留）", () => {
    expect(computeNextStatus("replan", "developed")).toBe("planned");
    expect(computeNextStatus("replan", "planned")).toBe("planned");
  });
});

// ── U9-U11: buildNextAction ─────────────────────────────────

describe("buildNextAction（U9-U11）", () => {
  it("U9: create 后 → nextAction.action=clarify, alternatives 含 plan, guidance 含 clarify 提示词", () => {
    const topic = makeTopic({ status: "created" });
    const na = buildNextAction("create", topic);
    expect(na.action).toBe("clarify");
    // guidance 含 clarify 提示词（探索→预判→提问→ADR）
    expect(na.guidance).toContain("[clarify 阶段]");
    expect(na.guidance).toContain("澄清需求");
    // plan 作为 alternative（清晰需求可直接跳过 clarify）
    expect(na.alternatives).toBeDefined();
    expect(na.alternatives!.length).toBeGreaterThanOrEqual(1);
    expect(na.alternatives!.some((a) => a.action === "plan")).toBe(true);
  });

  it("U10: plan gate pass 后 → nextAction.action=tdd_plan, waves 列表返回", () => {
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
    // plan gate 通过 → 进入 tdd_plan 阶段（不再直接到 dev）
    expect(na.action).toBe("tdd_plan");
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
      status: "tdd_inited",
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "out" },
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
      status: "tested",
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "out" },
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

  it("test gate fail → dev 从 tested 状态合法（不 illegal_transition）", () => {
    // 回归测试：dev.expectedStatuses 必须含 tested，否则 test fail 后回 dev 死锁
    const verdict = checkLinear("dev", "tested");
    expect(verdict.ok).toBe(true);
  });

  it("test gate fail → dev 从 reviewed 状态合法（不 illegal_transition）", () => {
    // 回归测试：dev.expectedStatuses 必须含 reviewed
    const verdict = checkLinear("dev", "reviewed");
    expect(verdict.ok).toBe(true);
  });

  it("replan 后 nextAction 指向 tdd_plan（不是 dev）", () => {
    // 回归测试：replan 后 status=planned，nextAction 必须指向 tdd_plan
    // 否则 agent 调 cw dev 会 illegal_transition（dev 不接受 planned）
    const topic = makeTopic({ status: "planned" });
    const na = buildNextAction("replan", topic);
    expect(na.action).toBe("tdd_plan");
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
  it("8 个 status 的线性序列合法", () => {
    const statuses: Status[] = [
      "created",
      "planned",
      "tdd_inited",
      "developed",
      "reviewed",
      "tested",
      "retrospected",
      "closed",
    ];
    // 每个 status 对应的合法 action（非 progressive 路径）
    const actionByStatus: Record<
      Status,
      "plan" | "tdd_plan" | "dev" | "review" | "test" | "retrospect" | "closeout"
    > = {
      created: "plan",
      planned: "tdd_plan",
      tdd_inited: "dev",
      developed: "review",
      reviewed: "test",
      tested: "retrospect",
      retrospected: "closeout",
      closed: "closeout", // closed 是终态，仅用于穷尽
    };

    for (const status of statuses.slice(0, 7)) {
      const action = actionByStatus[status];
      const verdict = checkLinear(action, status);
      expect(verdict.ok, `${action} from ${status} should pass`).toBe(true);
    }
  });

  it("TRANSITIONS 含全部 9 个 action", () => {
    const actions = [
      "create",
      "plan",
      "tdd_plan",
      "dev",
      "review",
      "test",
      "retrospect",
      "closeout",
      "replan",
    ];
    for (const a of actions) {
      expect(TRANSITIONS).toHaveProperty(a);
    }
  });
});

// ── tdd_plan 转换 + guard ───────────────────────────────────

describe("tdd_plan 转换与 guard", () => {
  it("tdd_plan 从 planned 调 → guard 通过, nextStatus=tdd_inited", () => {
    expect(checkLinear("tdd_plan", "planned").ok).toBe(true);
    expect(TRANSITIONS.tdd_plan.nextStatus).toBe("tdd_inited");
    expect(computeNextStatus("tdd_plan", "planned")).toBe("tdd_inited");
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

  it("dev 从 tdd_inited 调 → guard 通过", () => {
    expect(checkLinear("dev", "tdd_inited").ok).toBe(true);
  });

  it("replan 从 tdd_inited 调 → guard 通过", () => {
    expect(checkLinear("replan", "tdd_inited").ok).toBe(true);
  });

  it("tdd_plan gate 有 pass 记录 → computeGatePassed=true", () => {
    const topic = makeTopic({
      status: "tdd_inited",
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

  it("checkLinear(\"clarify\", \"planned\") → ok=false, code=\"illegal_transition\"", () => {
    // clarify 只在 created 合法，plan 之后不再允许。
    const verdict = checkLinear("clarify", "planned");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("illegal_transition");
    }
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
    expect(na.action).toBe("plan");
    expect(na.alternatives).toBeDefined();
    expect(na.alternatives!.some((a) => a.action === "clarify")).toBe(true);
  });

    it("buildNextAction(\"clarify\", topic) 空 clarifyRecords → action=\"plan\"", () => {
    // 空数组也算完成，推荐直接进 plan（无需澄清）。
    const topic = makeTopic({ clarifyRecords: [] });
    const na = buildNextAction("clarify", topic);
    expect(na.action).toBe("plan");
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

    it("test_fix: expectedStatuses=[tested], nextStatus=tested, progressive=true", () => {
      expect(TRANSITIONS.test_fix.expectedStatuses).toEqual(["tested"]);
      expect(TRANSITIONS.test_fix.nextStatus).toBe("tested");
      expect(TRANSITIONS.test_fix.progressive).toBe(true);
    });

    it("review 改为 progressive（expectedStatuses 含 reviewed）", () => {
      expect(TRANSITIONS.review.expectedStatuses).toContain("reviewed");
      expect(TRANSITIONS.review.nextStatus).toBe("reviewed");
      expect(TRANSITIONS.review.progressive).toBe(true);
    });

    it("test 仍是 progressive（expectedStatuses=[reviewed, tested]）", () => {
      expect(TRANSITIONS.test.expectedStatuses).toEqual(["reviewed", "tested"]);
      expect(TRANSITIONS.test.nextStatus).toBe("tested");
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

  describe("test_fix 转换（tested → tested progressive）", () => {
    it("checkLinear(\"test_fix\", \"tested\") → ok=true", () => {
      expect(checkLinear("test_fix", "tested").ok).toBe(true);
    });

    it("computeNextStatus(\"test_fix\", \"tested\") → tested（progressive 原地停留）", () => {
      expect(computeNextStatus("test_fix", "tested")).toBe("tested");
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

    it("checkLinear(\"review_fix\", \"tested\") → ok=false（test_fix 只接 reviewed）", () => {
      const verdict = checkLinear("review_fix", "tested");
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

    it("checkLinear(\"review\", \"tested\") → ok=false（review 不接 tested）", () => {
      const verdict = checkLinear("review", "tested");
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
      const topic = makeTopic({ status: "tested", testTurn: 1 });
      const na = buildNextAction("test_fix", topic);
      expect(na.action).toBe("test");
      expect(na.guidance).toContain("test_fix");
    });

    it("buildNextAction(\"test_fix\", topic) 达上限 → guidance 含上限告警", () => {
      const topic = makeTopic({ status: "tested", testTurn: 5 });
      const na = buildNextAction("test_fix", topic);
      expect(na.guidance).toMatch(/上限|replan|ask_user/);
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
      status: "tested",
      testTurn: 0,
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "out" },
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
    const topic = makeTopic({ status: "tested", testTurn: 1 });
    const na = buildNextAction("test_fix", topic);
    expect(na.action).toBe("test");
  });

  it("W5-8: test 达上限（testTurn>=5）+ failed → guidance 含熔断提示", () => {
    const topic = makeTopic({
      status: "tested",
      testTurn: 5,
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "out" },
          executor: "agent",
          status: "failed",
          requiresScreenshot: false,
          dependsOn: [],
        },
      ],
    });
    const na = buildNextAction("test", topic);
    // action 仍为 test_fix（不阻断），但 guidance 含熔断
    expect(na.action).toBe("test_fix");
    expect(na.guidance).toMatch(/上限|ask_user|replan/);
  });
});

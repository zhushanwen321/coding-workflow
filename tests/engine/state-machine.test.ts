/**
 * state-machine.ts 单测 — 声明式转换表 + 三重 guard + nextAction（Wave 1，#2 方案 A / D-009 / D-017）。
 *
 * 覆盖来源 A 功能用例（mock 层，guard 是纯内存函数）：
 *   T2.4       guard 非法状态（tested 调 plan → illegal_transition）
 *   T2.6       第三重缓存不一致 self-check（缓存与 gateHistory 重算矛盾 → cache_inconsistent，D-017 store bug 指示）
 *   T2.10/T5.4 终态不可逆（closed 调任何 action → illegal_transition）
 *   T2.14      guard 错误码区分（illegal_transition vs phase_incomplete）
 *   T4.6       跨阶段级联失败（dev 有 Wave 未 committed 调 test → phase_incomplete）
 *
 * 另含 TRANSITIONS / checkLinear / computeNextStatus / computeGatePassed / checkPhaseCascade /
 * checkCacheConsistency / buildNextAction 的直接单测（叶子函数逐个验证）。
 *
 * store 参数：guard 第三重 self-check 在本实现中 void store（重算用 topic 内原始数据，
 * store 留未来扩展），故传真实 :memory: CwStore 仅满足签名——D-017 已明确第三重是数据
 * 完整性 self-check（捕捉 store 层 bug），非安全机制。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildNextAction,
  checkCacheConsistency,
  checkLinear,
  checkPhaseCascade,
  computeGatePassed,
  computeNextStatus,
  guard,
  TRANSITIONS,
} from "../../src/engine/state-machine.js";
import { CwStore } from "../../src/engine/store.js";
import type {
  CwAction,
  CwTopic,
  GateHistoryEntry,
  TestCase,
  Wave,
} from "../../src/engine/types.js";

// ── fixtures ─────────────────────────────────────────────────

function makeTopic(overrides: Partial<CwTopic> = {}): CwTopic {
  return {
    schemaVersion: 1,
    topicId: "t-1",
    slug: "demo",
    tier: "lite",
    objective: "build X",
    workspacePath: "/tmp/ws",
    createdAt: "2026-07-04T00:00:00.000Z",
    status: "created",
    planFormat: "lite",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
    ...overrides,
  };
}

function makeWave(overrides: Partial<Wave> = {}): Wave {
  return {
    id: "w1",
    dependsOn: [],
    committed: null,
    changes: [],
    issues: [],
    ...overrides,
  };
}

function makeTestCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "E1",
    layer: "real",
    scenario: "登录成功",
    steps: "打开 /login → 提交",
    executor: "vitest",
    status: "pending",
    ...overrides,
  };
}

function makeGateEntry(overrides: Partial<GateHistoryEntry> = {}): GateHistoryEntry {
  return {
    id: 1,
    phase: "plan",
    action: "plan",
    gate: "check_plan",
    tier: "weak-structural",
    result: "pass",
    ts: "2026-07-04T00:00:00.000Z",
    progressive: false,
    ...overrides,
  };
}

// guard 签名要求 CwStore；本实现第三重 void store，用 :memory: 满足签名。
let store: CwStore;
beforeEach(() => {
  store = new CwStore(":memory:");
});
afterEach(() => {
  store.close();
});

// ── TRANSITIONS 表（声明式，§4.2 1:1 编码） ──────────────────

describe("TRANSITIONS — 声明式转换表", () => {
  it("create 允许无前置状态", () => {
    expect(TRANSITIONS.create?.expectedStatuses).toEqual([]);
    expect(TRANSITIONS.create?.nextStatus).toBe("created");
  });

  it("dev/test/retrospect 标记 progressive", () => {
    expect(TRANSITIONS.dev?.progressive).toBe(true);
    expect(TRANSITIONS.test?.progressive).toBe(true);
    expect(TRANSITIONS.retrospect?.progressive).toBe(true);
  });

  it("test requirePhaseComplete=dev；retrospect requirePhaseComplete=test", () => {
    expect(TRANSITIONS.test?.requirePhaseComplete).toBe("dev");
    expect(TRANSITIONS.retrospect?.requirePhaseComplete).toBe("test");
  });
});

// ── checkLinear（第一重，D-009） ─────────────────────────────

describe("checkLinear — 线性 expectedStatus 校验", () => {
  it("create 允许 current=undefined（无 topic）", () => {
    expect(checkLinear("create", undefined)).toEqual({ ok: true });
  });

  it("合法：created 调 plan", () => {
    expect(checkLinear("plan", "created")).toEqual({ ok: true });
  });

  it("合法：developed 调 test", () => {
    expect(checkLinear("test", "developed")).toEqual({ ok: true });
  });

  it("非法：tested 调 plan → illegal_transition", () => {
    const v = checkLinear("plan", "tested");
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("illegal_transition");
      expect(v.reason).toContain("plan");
    }
  });

  it("非法：created 调 test（test 需 developed/tested）→ illegal_transition", () => {
    const v = checkLinear("test", "created");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("illegal_transition");
  });

  it("非 create action 要求 current 非 undefined", () => {
    const v = checkLinear("plan", undefined);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("illegal_transition");
  });
});

// ── computeNextStatus（progressive 态内推进，§4.3） ──────────

describe("computeNextStatus — 流转后状态", () => {
  it("plan: created → planned", () => {
    expect(computeNextStatus("plan", "created")).toBe("planned");
  });

  it("clarify: created → clarified", () => {
    expect(computeNextStatus("clarify", "created")).toBe("clarified");
  });

  it("detail: clarified → detailed", () => {
    expect(computeNextStatus("detail", "clarified")).toBe("detailed");
  });

  it("dev 首次：planned → developed", () => {
    expect(computeNextStatus("dev", "planned")).toBe("developed");
  });

  it("dev 态内推进：developed → developed（progressive 原地停留）", () => {
    expect(computeNextStatus("dev", "developed")).toBe("developed");
  });

  it("dev 从 detailed → developed", () => {
    expect(computeNextStatus("dev", "detailed")).toBe("developed");
  });

  it("test 首次：developed → tested", () => {
    expect(computeNextStatus("test", "developed")).toBe("tested");
  });

  it("test 态内推进：tested → tested", () => {
    expect(computeNextStatus("test", "tested")).toBe("tested");
  });

  it("retrospect: tested → retrospected", () => {
    expect(computeNextStatus("retrospect", "tested")).toBe("retrospected");
  });

  it("closeout: retrospected → closed", () => {
    expect(computeNextStatus("closeout", "retrospected")).toBe("closed");
  });
});

// ── computeGatePassed（叶子：逻辑模型聚合，§4.3 完成信号） ────

describe("computeGatePassed — phase 完成信号", () => {
  it("dev：全 Wave committed（≥1）→ true", () => {
    const topic = makeTopic({
      waves: [
        makeWave({ id: "w1", committed: "abc123" }),
        makeWave({ id: "w2", committed: "def456" }),
      ],
    });
    expect(computeGatePassed("dev", topic)).toBe(true);
  });

  it("dev：有 Wave 未 committed → false", () => {
    const topic = makeTopic({
      waves: [
        makeWave({ id: "w1", committed: "abc123" }),
        makeWave({ id: "w2", committed: null }),
      ],
    });
    expect(computeGatePassed("dev", topic)).toBe(false);
  });

  it("dev：空 waves → false（防退化路径：无 Wave 不算 dev 完成）", () => {
    const topic = makeTopic({ waves: [] });
    expect(computeGatePassed("dev", topic)).toBe(false);
  });

  it("test：全 testCase passed（≥1）→ true", () => {
    const topic = makeTopic({
      testCases: [
        makeTestCase({ id: "E1", status: "passed" }),
        makeTestCase({ id: "E2", status: "passed" }),
      ],
    });
    expect(computeGatePassed("test", topic)).toBe(true);
  });

  it("test：有 case 未 passed → false", () => {
    const topic = makeTopic({
      testCases: [
        makeTestCase({ id: "E1", status: "passed" }),
        makeTestCase({ id: "E2", status: "pending" }),
      ],
    });
    expect(computeGatePassed("test", topic)).toBe(false);
  });

  it("test：有 case failed → false", () => {
    const topic = makeTopic({
      testCases: [makeTestCase({ id: "E1", status: "failed" })],
    });
    expect(computeGatePassed("test", topic)).toBe(false);
  });

  it("test：空 testCases → false", () => {
    const topic = makeTopic({ testCases: [] });
    expect(computeGatePassed("test", topic)).toBe(false);
  });

  it("single-shot（plan）：gateHistory 有 plan pass 记录 → true", () => {
    const topic = makeTopic({
      gateHistory: [makeGateEntry({ phase: "plan", result: "pass" })],
    });
    expect(computeGatePassed("plan", topic)).toBe(true);
  });

  it("single-shot（plan）：gateHistory 仅有 fail 记录 → false", () => {
    const topic = makeTopic({
      gateHistory: [makeGateEntry({ phase: "plan", result: "fail" })],
    });
    expect(computeGatePassed("plan", topic)).toBe(false);
  });

  it("single-shot（plan）：gateHistory 有其他 phase 的 pass → false", () => {
    const topic = makeTopic({
      gateHistory: [makeGateEntry({ phase: "detail", result: "pass" })],
    });
    expect(computeGatePassed("plan", topic)).toBe(false);
  });

  it("single-shot（detail）：gateHistory 有 detail pass → true", () => {
    const topic = makeTopic({
      gateHistory: [makeGateEntry({ phase: "detail", result: "pass" })],
    });
    expect(computeGatePassed("detail", topic)).toBe(true);
  });

  it("single-shot（retrospect）：gateHistory 有 retrospect pass → true", () => {
    const topic = makeTopic({
      gateHistory: [makeGateEntry({ phase: "retrospect", result: "pass" })],
    });
    expect(computeGatePassed("retrospect", topic)).toBe(true);
  });

  it("create：无 gate 记录 → false", () => {
    expect(computeGatePassed("create", makeTopic())).toBe(false);
  });
});

// ── checkPhaseCascade（第二重，跨阶段级联） ──────────────────

describe("checkPhaseCascade — 跨阶段 gatePassed 级联", () => {
  it("无 requirePhaseComplete 的 action → 永远 ok", () => {
    const topic = makeTopic();
    expect(checkPhaseCascade("plan", topic)).toEqual({ ok: true });
    expect(checkPhaseCascade("dev", topic)).toEqual({ ok: true });
    expect(checkPhaseCascade("create", topic)).toEqual({ ok: true });
  });

  it("T4.6：test 需 dev 完成；dev 有 Wave 未 committed → phase_incomplete", () => {
    const topic = makeTopic({
      status: "developed",
      waves: [makeWave({ id: "w1", committed: null })],
    });
    const v = checkPhaseCascade("test", topic);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("phase_incomplete");
      expect(v.reason).toContain("dev");
    }
  });

  it("test：dev 全 committed → ok", () => {
    const topic = makeTopic({
      status: "developed",
      waves: [makeWave({ id: "w1", committed: "abc" })],
    });
    expect(checkPhaseCascade("test", topic)).toEqual({ ok: true });
  });

  it("retrospect 需 test 完成；有 case 未 passed → phase_incomplete", () => {
    const topic = makeTopic({
      status: "tested",
      testCases: [makeTestCase({ id: "E1", status: "pending" })],
    });
    const v = checkPhaseCascade("retrospect", topic);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("phase_incomplete");
      expect(v.reason).toContain("test");
    }
  });

  it("retrospect：全 case passed → ok", () => {
    const topic = makeTopic({
      status: "tested",
      testCases: [makeTestCase({ id: "E1", status: "passed" })],
    });
    expect(checkPhaseCascade("retrospect", topic)).toEqual({ ok: true });
  });
});

// ── checkCacheConsistency（第三重，D-017 self-check） ─────────

describe("checkCacheConsistency — 数据完整性 self-check（D-017）", () => {
  it("T2.6：缓存 gatePassed.plan=true 与 gateHistory 重算（false）矛盾 → cache_inconsistent", () => {
    // store bug 场景：updateGatePassed 写了 plan=true，但 gateHistory 未追加 pass 记录。
    const topic = makeTopic({
      status: "planned",
      gatePassed: { plan: true }, // 缓存声称 plan 已过
      gateHistory: [], // 实际无 pass 记录 → 重算 false
    });
    const v = checkCacheConsistency(topic, store);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("cache_inconsistent");
      expect(v.reason).toContain("plan");
    }
  });

  it("缓存与重算一致 → ok", () => {
    const topic = makeTopic({
      status: "planned",
      gatePassed: { plan: true },
      gateHistory: [makeGateEntry({ phase: "plan", result: "pass" })],
    });
    expect(checkCacheConsistency(topic, store)).toEqual({ ok: true });
  });

  it("dev 缓存=true 但 waves 未全 committed → cache_inconsistent（store bug 指示）", () => {
    const topic = makeTopic({
      status: "developed",
      gatePassed: { dev: true },
      waves: [makeWave({ id: "w1", committed: null })],
    });
    const v = checkCacheConsistency(topic, store);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("cache_inconsistent");
  });

  it("dev 缓存=false 且 waves 未全 committed → 一致 → ok", () => {
    const topic = makeTopic({
      status: "developed",
      gatePassed: { dev: false },
      waves: [makeWave({ id: "w1", committed: null })],
    });
    expect(checkCacheConsistency(topic, store)).toEqual({ ok: true });
  });

  it("空 gatePassed → ok（无缓存可比对）", () => {
    expect(checkCacheConsistency(makeTopic(), store)).toEqual({ ok: true });
  });
});

// ── guard（三重串行，fail 短路） ─────────────────────────────

describe("guard — 三重串行 fail 短路", () => {
  it("T2.4：tested 调 plan → illegal_transition（第一重拦，不跑 gate）", () => {
    const topic = makeTopic({ status: "tested" });
    const v = guard("plan", topic, store);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("illegal_transition");
  });

  it("T2.10/T5.4：closed 终态调任何 action → illegal_transition", () => {
    const topic = makeTopic({ status: "closed" });
    const actions: CwAction[] = [
      "plan",
      "clarify",
      "detail",
      "dev",
      "test",
      "retrospect",
      "closeout",
    ];
    for (const action of actions) {
      const v = guard(action, topic, store);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("illegal_transition");
    }
  });

  it("T2.14：非法状态 → illegal_transition；跨阶段未完成 → phase_incomplete（错误码区分）", () => {
    // illegal_transition：created 调 test（test 需 developed/tested）
    const v1 = guard("test", makeTopic({ status: "created" }), store);
    expect(v1.ok).toBe(false);
    if (!v1.ok) expect(v1.code).toBe("illegal_transition");

    // phase_incomplete：developed 调 test，但 dev 有 Wave 未 committed
    const v2 = guard(
      "test",
      makeTopic({
        status: "developed",
        waves: [makeWave({ id: "w1", committed: null })],
        gatePassed: { dev: false }, // 缓存与重算一致，让 cascade 是唯一失败点
      }),
      store,
    );
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.code).toBe("phase_incomplete");

    // 两者错误码不同（可观测性：agent 据 code 区分修复方向）
    if (!v1.ok && !v2.ok) {
      expect(v1.code).not.toBe(v2.code);
    }
  });

  it("T4.6：dev 有 Wave 未 committed 调 test → phase_incomplete", () => {
    const topic = makeTopic({
      status: "developed",
      waves: [
        makeWave({ id: "w1", committed: "abc" }),
        makeWave({ id: "w2", committed: null }),
      ],
      gatePassed: { dev: false },
    });
    const v = guard("test", topic, store);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("phase_incomplete");
  });

  it("T2.6：缓存不一致 → cache_inconsistent（第三重，D-017 store bug 指示）", () => {
    const topic = makeTopic({
      status: "planned",
      gatePassed: { plan: true },
      gateHistory: [],
    });
    const v = guard("dev", topic, store);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("cache_inconsistent");
  });

  it("合法路径：created 调 plan，缓存一致 → ok", () => {
    const topic = makeTopic({ status: "created", gatePassed: {} });
    expect(guard("plan", topic, store)).toEqual({ ok: true });
  });

  it("create 允许 topic=null", () => {
    expect(guard("create", null, store)).toEqual({ ok: true });
  });
});

// ── buildNextAction（叶子：#9 扁平结构，§10.4 skill 映射） ────

describe("buildNextAction — tier+status+gatePassed 推导（#9 扁平）", () => {
  it("create + lite → plan / lite-plan", () => {
    const topic = makeTopic({ tier: "lite", status: "created" });
    const n = buildNextAction("create", topic);
    expect(n.action).toBe("plan");
    expect(n.skill).toBe("lite-plan");
    expect(typeof n.guidance).toBe("string");
    expect(n.guidance.length).toBeGreaterThan(0);
  });

  it("create + mid → clarify / mid-plan", () => {
    const topic = makeTopic({ tier: "mid", status: "created" });
    const n = buildNextAction("create", topic);
    expect(n.action).toBe("clarify");
    expect(n.skill).toBe("mid-plan");
  });

  it("plan gate 通过 → dev / coding-execute + waves 进度", () => {
    const topic = makeTopic({
      status: "planned",
      waves: [
        makeWave({ id: "w1", committed: "abc" }),
        makeWave({ id: "w2", committed: null }),
      ],
      gateHistory: [makeGateEntry({ phase: "plan", result: "pass" })],
    });
    const n = buildNextAction("plan", topic);
    expect(n.action).toBe("dev");
    expect(n.skill).toBe("coding-execute");
    expect(n.waves).toEqual([
      { id: "w1", committed: true },
      { id: "w2", committed: false },
    ]);
  });

  it("plan gate FAIL（gateHistory 无 pass 记录）→ retry plan / lite-plan（不撞 illegal_transition）", () => {
    const topic = makeTopic({
      status: "created", // gate fail 时 status 未流转
      gateHistory: [makeGateEntry({ phase: "plan", result: "fail" })],
    });
    const n = buildNextAction("plan", topic);
    expect(n.action).toBe("plan"); // retry 当前 action，不是 dev
    expect(n.skill).toBe("lite-plan");
    expect(n.guidance).toContain("FAIL");
  });

  it("clarify gate 通过 → detail / mid-detail-plan", () => {
    const topic = makeTopic({
      tier: "mid",
      status: "clarified",
      gateHistory: [makeGateEntry({ phase: "clarify", result: "pass" })],
    });
    const n = buildNextAction("clarify", topic);
    expect(n.action).toBe("detail");
    expect(n.skill).toBe("mid-detail-plan");
  });

  it("clarify gate FAIL → retry clarify / mid-plan（不撞 illegal_transition）", () => {
    const topic = makeTopic({
      tier: "mid",
      status: "created",
      gateHistory: [makeGateEntry({ phase: "clarify", result: "fail" })],
    });
    const n = buildNextAction("clarify", topic);
    expect(n.action).toBe("clarify");
    expect(n.skill).toBe("mid-plan");
    expect(n.guidance).toContain("FAIL");
  });

  it("detail gate 通过 → dev / coding-execute", () => {
    const topic = makeTopic({
      tier: "mid",
      status: "detailed",
      gateHistory: [makeGateEntry({ phase: "detail", result: "pass" })],
    });
    const n = buildNextAction("detail", topic);
    expect(n.action).toBe("dev");
    expect(n.skill).toBe("coding-execute");
  });

  it("detail gate FAIL → retry detail / mid-detail-plan（不撞 illegal_transition）", () => {
    const topic = makeTopic({
      tier: "mid",
      status: "clarified",
      gateHistory: [makeGateEntry({ phase: "detail", result: "fail" })],
    });
    const n = buildNextAction("detail", topic);
    expect(n.action).toBe("detail");
    expect(n.skill).toBe("mid-detail-plan");
    expect(n.guidance).toContain("FAIL");
  });

  it("detail gate 连续失败超阈值 → guidance 含熔断提示（建议人工介入）", () => {
    const fails = Array.from({ length: 6 }, (_, i) =>
      makeGateEntry({ id: i + 1, phase: "detail", result: "fail" }),
    );
    const topic = makeTopic({
      tier: "mid",
      status: "clarified",
      gateHistory: fails,
    });
    const n = buildNextAction("detail", topic);
    expect(n.guidance).toContain("熔断");
    expect(n.guidance).toContain("连续失败 6 次");
    // 不阻断 action 调用——agent 仍可重调，只是 guidance 变了
    expect(n.action).toBe("detail");
  });

  it("detail gate 连续失败未超阈值 → guidance 不含熔断提示（正常重试引导）", () => {
    const fails = Array.from({ length: 4 }, (_, i) =>
      makeGateEntry({ id: i + 1, phase: "detail", result: "fail" }),
    );
    const topic = makeTopic({
      tier: "mid",
      status: "clarified",
      gateHistory: fails,
    });
    const n = buildNextAction("detail", topic);
    expect(n.guidance).not.toContain("熔断");
    expect(n.guidance).toContain("FAIL");
  });

  it("detail gate 连续失败恰好达阈值（5 次）→ 触发熔断（>= 边界）", () => {
    const fails = Array.from({ length: 5 }, (_, i) =>
      makeGateEntry({ id: i + 1, phase: "detail", result: "fail" }),
    );
    const topic = makeTopic({
      tier: "mid",
      status: "clarified",
      gateHistory: fails,
    });
    const n = buildNextAction("detail", topic);
    expect(n.guidance).toContain("熔断");
    expect(n.guidance).toContain("达熔断阈值 5");
  });

  it("detail gate 连续失败被 pass 打断 → 重新计数（不触发熔断）", () => {
    // 6 次 fail 后 1 次 pass，再 1 次 fail——pass 打断了连续失败
    const history = [
      ...Array.from({ length: 6 }, (_, i) =>
        makeGateEntry({ id: i + 1, phase: "detail", result: "fail" }),
      ),
      makeGateEntry({ id: 7, phase: "detail", result: "pass" }),
      makeGateEntry({ id: 8, phase: "detail", result: "fail" }),
    ];
    const topic = makeTopic({
      tier: "mid",
      status: "clarified",
      gateHistory: history,
    });
    const n = buildNextAction("detail", topic);
    // pass 后重新计数，最近只连续 1 次 fail，不触发熔断
    expect(n.guidance).not.toContain("熔断");
  });

  it("dev 全 committed → test / coding-execute（test 阶段对齐 SKILL.md）+ waves 全 committed + testCases 预览", () => {
    const topic = makeTopic({
      status: "developed",
      waves: [makeWave({ id: "w1", committed: "abc" })],
      testCases: [
        makeTestCase({ id: "E1", status: "pending" }),
        makeTestCase({ id: "E2", status: "passed" }),
      ],
    });
    const n = buildNextAction("dev", topic);
    expect(n.action).toBe("test");
    expect(n.skill).toBe("coding-execute");
    expect(n.waves).toEqual([{ id: "w1", committed: true }]);
    expect(n.testCases).toEqual([
      { id: "E1", status: "pending" },
      { id: "E2", status: "passed" },
    ]);
  });

  it("dev 未全 committed → 继续dev / coding-execute + waves 进度", () => {
    const topic = makeTopic({
      status: "developed",
      waves: [
        makeWave({ id: "w1", committed: "abc" }),
        makeWave({ id: "w2", committed: null }),
      ],
    });
    const n = buildNextAction("dev", topic);
    expect(n.action).toBe("dev");
    expect(n.skill).toBe("coding-execute");
    expect(n.waves).toEqual([
      { id: "w1", committed: true },
      { id: "w2", committed: false },
    ]);
  });

  it("test 全 passed → retrospect / coding-retrospect", () => {
    const topic = makeTopic({
      status: "tested",
      testCases: [makeTestCase({ id: "E1", status: "passed" })],
    });
    const n = buildNextAction("test", topic);
    expect(n.action).toBe("retrospect");
    expect(n.skill).toBe("coding-retrospect");
  });

  it("test 未全 passed → 继续test / coding-execute（对齐 SKILL.md）+ testCases 进度", () => {
    const topic = makeTopic({
      status: "tested",
      testCases: [
        makeTestCase({ id: "E1", status: "passed" }),
        makeTestCase({ id: "E2", status: "pending" }),
      ],
    });
    const n = buildNextAction("test", topic);
    expect(n.action).toBe("test");
    expect(n.skill).toBe("coding-execute");
    expect(n.testCases).toEqual([
      { id: "E1", status: "passed" },
      { id: "E2", status: "pending" },
    ]);
  });

  it("retrospect gate 通过 → closeout / coding-closeout", () => {
    const topic = makeTopic({
      status: "retrospected",
      gateHistory: [makeGateEntry({ phase: "retrospect", result: "pass" })],
    });
    const n = buildNextAction("retrospect", topic);
    expect(n.action).toBe("closeout");
    expect(n.skill).toBe("coding-closeout");
  });

  it("retrospect gate FAIL → retry retrospect / coding-retrospect（不撞 illegal_transition）", () => {
    const topic = makeTopic({
      status: "tested",
      gateHistory: [makeGateEntry({ phase: "retrospect", result: "fail" })],
    });
    const n = buildNextAction("retrospect", topic);
    expect(n.action).toBe("retrospect");
    expect(n.skill).toBe("coding-retrospect");
    expect(n.guidance).toContain("FAIL");
  });

  it("closeout gate 通过 → guidance 提示 topic 已关闭，无 action/skill", () => {
    const topic = makeTopic({
      status: "closed",
      gateHistory: [makeGateEntry({ phase: "closeout", result: "pass" })],
    });
    const n = buildNextAction("closeout", topic);
    expect(n.action).toBeUndefined();
    expect(n.skill).toBeUndefined();
    expect(n.guidance).toContain("关闭");
  });

  it("closeout gate FAIL → retry closeout / coding-closeout（status 仍 retrospected）", () => {
    const topic = makeTopic({
      status: "retrospected",
      gateHistory: [makeGateEntry({ phase: "closeout", result: "fail" })],
    });
    const n = buildNextAction("closeout", topic);
    expect(n.action).toBe("closeout"); // retry，不是 undefined
    expect(n.skill).toBe("coding-closeout");
    expect(n.guidance).toContain("FAIL");
  });
});

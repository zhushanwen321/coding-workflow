/**
 * plan-parser.test.ts — 3 套 JSON schema 解析（Wave 2，#5 方案 A typebox，D-003 tier 锁）。
 *
 * Mock 层（无外部依赖被 mock — typebox 是纯函数库，alias 到 pi-ai 依赖图的 typebox build）。
 * 覆盖来源 A + 来源 B 用例：
 *   T2.2/T2.18  tier mismatch（format !== tier 锁定值）→ throw；status 不变
 *   T2.3       schema 缺必填字段 → throw
 *   T2.9       mid clarify 不写任务清单（只确认 tier + deliverables）
 *   T2.17      size guard（>1MB）→ throw，不解析
 *   T2.29      深嵌套 JSON 爆栈防护 → throw（不崩进程）
 *   另含合法 LitePlan/MidClarify/MidDetail 解析出 waves/testCases/deliverables 的正向用例。
 */

import { describe, expect, it } from "vitest";

import {
  parseLitePlan,
  parseMidClarify,
  parseMidDetail,
} from "../../src/engine/plan-parser.js";

// ── fixtures ─────────────────────────────────────────────────

function makeLitePlan(overrides: Record<string, unknown> = {}): unknown {
  return {
    format: "lite",
    objective: "build demo feature",
    waves: [
      { id: "W1", changes: ["c1", "c2"], dependsOn: [] },
      { id: "W2", changes: ["c3"], dependsOn: ["W1"], parallelGroup: "g1" },
    ],
    testCases: [
      {
        id: "E1",
        layer: "real",
        scenario: "用户登录",
        steps: "打开 /login → 提交",
        expected: { url: "/dashboard", text: "欢迎" },
        executor: "vitest",
        requiresScreenshot: true,
      },
      {
        id: "E2",
        layer: "mock",
        scenario: "API mock",
        steps: "mock 返回 200",
        expected: { text: "ok" },
        executor: "vitest",
        requiresScreenshot: false,
      },
    ],
    ...overrides,
  };
}

function makeMidClarify(overrides: Record<string, unknown> = {}): unknown {
  return {
    format: "mid-clarify",
    objective: "mid 需求 + 架构",
    deliverables: {
      requirements: "requirements.md",
      systemArchitecture: "system-architecture.md",
    },
    ...overrides,
  };
}

function makeMidDetail(overrides: Record<string, unknown> = {}): unknown {
  return {
    format: "mid-detail",
    objective: "mid 详细设计",
    waves: [{ id: "W1", issues: ["#3", "#4"], dependsOn: [] }],
    testCases: [
      {
        id: "T1.1",
        layer: "integration",
        scenario: "gate 串行",
        steps: "跑 4 checker",
        assertion: "任一 fail 则 fail-fast",
        executor: "vitest",
      },
    ],
    deliverables: {
      issues: "issues.md",
      nonFunctional: "non-functional-design.md",
      codeArchitecture: "code-architecture.md",
      executionPlan: "execution-plan.md",
    },
    ...overrides,
  };
}

// ── parseLitePlan ────────────────────────────────────────────

describe("parseLitePlan", () => {
  it("合法 LitePlan → waves + testCases 提取正确", () => {
    const parsed = parseLitePlan(makeLitePlan(), "lite");
    expect(parsed.waves).toHaveLength(2);
    expect(parsed.waves[0]).toMatchObject({ id: "W1", changes: ["c1", "c2"], dependsOn: [] });
    // lite wave 无 issues 字段 → seed 填 []
    expect(parsed.waves[0]!.issues).toEqual([]);
    expect(parsed.waves[1]!.parallelGroup).toBe("g1");
    expect(parsed.testCases).toHaveLength(2);
    expect(parsed.testCases[0]).toMatchObject({
      id: "E1",
      layer: "real",
      executor: "vitest",
    });
    expect(parsed.testCases[0]!.expected).toEqual({ url: "/dashboard", text: "欢迎" });
  });

  it("T2.2 / T2.18 — format !== tier 锁定值（format=mid 但 tier=lite）→ throw tier mismatch", () => {
    const json = makeLitePlan({ format: "mid" });
    expect(() => parseLitePlan(json, "lite")).toThrow(/tier mismatch/);
  });

  it("T2.2 反向 — tier=mid 但传 lite plan → throw（D-003 tier 锁）", () => {
    // parseLitePlan 期望 format==="lite"；tier=mid 时 format 仍必须是 "lite"
    // 但 mid topic 不会调 parseLitePlan（dispatch 路由不同）。此处验证 format 锁本身：
    expect(() => parseLitePlan(makeLitePlan({ format: "mid-detail" }), "lite")).toThrow(
      /tier mismatch/,
    );
  });

  it("T2.3 — schema 缺必填字段（无 waves）→ throw invalid", () => {
    const json = makeLitePlan({ waves: undefined });
    expect(() => parseLitePlan(json, "lite")).toThrow(/invalid lite plan json/i);
  });

  it("T2.3 — testCases 缺 expected 子结构 → throw", () => {
    const json = makeLitePlan({
      testCases: [{ id: "E1", layer: "real", scenario: "x", steps: "y", executor: "z", requiresScreenshot: true }],
    });
    expect(() => parseLitePlan(json, "lite")).toThrow(/invalid lite plan json/i);
  });

  it("P0 — testCases 缺 requiresScreenshot → throw（screenshot 要求由 plan 声明，必填）", () => {
    const json = makeLitePlan({
      testCases: [
        { id: "E1", layer: "real", scenario: "x", steps: "y", expected: { text: "ok" }, executor: "z" },
      ],
    });
    expect(() => parseLitePlan(json, "lite")).toThrow(/invalid lite plan json/i);
  });

  it("非对象输入 → throw", () => {
    expect(() => parseLitePlan("not an object", "lite")).toThrow(/not an object/i);
    expect(() => parseLitePlan(null, "lite")).toThrow(/not an object/i);
  });

  it("T2.17 — size guard：>1MB 输入 → throw，不解析", () => {
    const huge = makeLitePlan({ objective: "x".repeat(1_100_000) });
    expect(() => parseLitePlan(huge, "lite")).toThrow(/too large|size/i);
  });

  it("T2.29 — 深嵌套 JSON 爆栈防护 → throw（不崩进程）", () => {
    // 构造深嵌套（迭代，非递归，测试进程不爆栈）
    let deep: unknown = "leaf";
    for (let i = 0; i < 100_000; i++) deep = { n: deep };
    const json = makeLitePlan({ objective: deep });
    expect(() => parseLitePlan(json, "lite")).toThrow();
  });

  // ── ADR-029 决策 4：dependsOn 环检测 ──────────────────────
  it("dependsOn 环 → throw（fail-fast 在 plan 阶段，不等 workflow 运行时）", () => {
    const json = makeLitePlan({
      waves: [
        { id: "W1", changes: ["c1"], dependsOn: ["W3"] },
        { id: "W2", changes: ["c2"], dependsOn: ["W1"] },
        { id: "W3", changes: ["c3"], dependsOn: ["W2"] },
      ],
    });
    expect(() => parseLitePlan(json, "lite")).toThrow(/有环/);
  });

  it("dependsOn 引用不存在的 id → throw", () => {
    const json = makeLitePlan({
      waves: [{ id: "W1", changes: ["c1"], dependsOn: ["WX"] }],
    });
    expect(() => parseLitePlan(json, "lite")).toThrow(/unknown id "WX"/);
  });

  it("testCases dependsOn 环 → throw", () => {
    const json = makeLitePlan({
      testCases: [
        { id: "E1", layer: "mock", scenario: "s1", steps: "s", expected: { text: "ok" }, executor: "vitest", requiresScreenshot: false, dependsOn: ["E2"] },
        { id: "E2", layer: "mock", scenario: "s2", steps: "s", expected: { text: "ok" }, executor: "vitest", requiresScreenshot: false, dependsOn: ["E1"] },
      ],
    });
    expect(() => parseLitePlan(json, "lite")).toThrow(/testCases.*有环/);
  });
});

// ── parseMidClarify ──────────────────────────────────────────

describe("parseMidClarify", () => {
  it("T2.9 — 合法 MidClarify 只含 deliverables，不含 waves/testCases", () => {
    const parsed = parseMidClarify(makeMidClarify(), "mid");
    expect(parsed.deliverables).toEqual({
      requirements: "requirements.md",
      systemArchitecture: "system-architecture.md",
    });
    // ParsedMidClarify 类型本身不含 waves/testCases（编译期保证），此处再断言运行期也无
    expect((parsed as Record<string, unknown>).waves).toBeUndefined();
    expect((parsed as Record<string, unknown>).testCases).toBeUndefined();
  });

  it("T2.2 — format !== mid-clarify → throw tier mismatch", () => {
    expect(() => parseMidClarify(makeMidClarify({ format: "mid-detail" }), "mid")).toThrow(
      /tier mismatch/,
    );
  });

  it("T2.3 — deliverables 缺 systemArchitecture → throw", () => {
    const json = makeMidClarify({ deliverables: { requirements: "requirements.md" } });
    expect(() => parseMidClarify(json, "mid")).toThrow(/invalid mid clarify json/i);
  });

  it("T2.17 — size guard：>1MB → throw", () => {
    const huge = makeMidClarify({ objective: "x".repeat(1_100_000) });
    expect(() => parseMidClarify(huge, "mid")).toThrow(/too large|size/i);
  });
});

// ── parseMidDetail ───────────────────────────────────────────

describe("parseMidDetail", () => {
  it("合法 MidDetail → waves + testCases + deliverables 提取正确", () => {
    const parsed = parseMidDetail(makeMidDetail(), "mid");
    expect(parsed.waves).toHaveLength(1);
    // mid wave 无 changes → seed 填 []
    expect(parsed.waves[0]).toMatchObject({ id: "W1", issues: ["#3", "#4"], dependsOn: [] });
    expect(parsed.waves[0]!.changes).toEqual([]);
    expect(parsed.testCases).toHaveLength(1);
    expect(parsed.testCases[0]).toMatchObject({ id: "T1.1", layer: "integration" });
    // mid testCase 用 assertion（自然语言），无 expected
    expect(parsed.testCases[0]!.assertion).toBe("任一 fail 则 fail-fast");
    expect(parsed.testCases[0]!.expected).toBeUndefined();
    expect(parsed.deliverables).toEqual({
      issues: "issues.md",
      nonFunctional: "non-functional-design.md",
      codeArchitecture: "code-architecture.md",
      executionPlan: "execution-plan.md",
    });
  });

  it("T2.2 — format !== mid-detail → throw tier mismatch", () => {
    expect(() => parseMidDetail(makeMidDetail({ format: "mid-clarify" }), "mid")).toThrow(
      /tier mismatch/,
    );
  });

  it("T2.3 — 缺 deliverables → throw", () => {
    const json = makeMidDetail({ deliverables: undefined });
    expect(() => parseMidDetail(json, "mid")).toThrow(/invalid mid detail json/i);
  });

  it("T2.3 — testCase layer 非法值 → throw", () => {
    const json = makeMidDetail({
      testCases: [
        { id: "T1.1", layer: "bogus", scenario: "x", steps: "y", assertion: "z", executor: "e" },
      ],
    });
    expect(() => parseMidDetail(json, "mid")).toThrow(/invalid mid detail json/i);
  });

  it("T2.17 — size guard：>1MB → throw", () => {
    const huge = makeMidDetail({ objective: "x".repeat(1_100_000) });
    expect(() => parseMidDetail(huge, "mid")).toThrow(/too large|size/i);
  });
});

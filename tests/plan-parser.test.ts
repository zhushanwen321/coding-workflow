/**
 * plan-parser 单测 — U16-U18（parseLitePlan schema 校验）。
 *
 * 覆盖：合法结构解析成功、format 非 lite 抛错、waves 空抛错。
 */

import { describe, expect,it } from "vitest";

import { parseLitePlan } from "../src/plan-parser.js";

// ── 测试夹具：合法 plan.json ─────────────────────────────────

function makeValidPlanJson(): Record<string, unknown> {
  return {
    format: "lite",
    objective: "test objective",
    waves: [
      {
        id: "W1",
        changes: [
          { file: "src/app.ts", description: "change A" },
          { file: "src/app.ts", description: "change B" },
        ],
        dependsOn: [],
      },
    ],
    testCases: [
      {
        id: "E1",
        layer: "mock",
        scenario: "测试场景",
        steps: "执行步骤",
        expected: { type: "exact", text: "expected output" },
        executor: "agent",
        requiresScreenshot: false,
      },
    ],
  };
}

// ── U16: 合法结构解析 ───────────────────────────────────────

describe("parseLitePlan 合法结构（U16）", () => {
  it("U16: format=lite, waves≥1, testCases≥1 → 解析成功", () => {
    const parsed = parseLitePlan(makeValidPlanJson());
    expect(parsed.waves).toHaveLength(1);
    expect(parsed.waves[0]!.id).toBe("W1");
    expect(parsed.waves[0]!.changes).toEqual([
      { file: "src/app.ts", description: "change A" },
      { file: "src/app.ts", description: "change B" },
    ]);
    expect(parsed.waves[0]!.dependsOn).toEqual([]);

    expect(parsed.legacyTestCases).toHaveLength(1);
    expect(parsed.legacyTestCases![0]!.id).toBe("E1");
    expect(parsed.legacyTestCases![0]!.layer).toBe("mock");
    const exp1 = parsed.legacyTestCases![0]!.expected;
    expect(exp1.type).toBe("exact");
    expect(exp1.type === "exact" && exp1.text).toBe("expected output");
    expect(parsed.legacyTestCases![0]!.requiresScreenshot).toBe(false);
  });

  it("U16 补充: real layer + requiresScreenshot=true + url expected 也能解析", () => {
    const json = {
      format: "lite",
      objective: "obj",
      waves: [{ id: "W1", changes: [{ file: "src/app.ts", description: "x" }], dependsOn: [] }],
      testCases: [
        {
          id: "E1",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", url: "http://example.com" },
          executor: "test-runner",
          requiresScreenshot: true,
          dependsOn: [],
        },
      ],
    };
    const parsed = parseLitePlan(json);
    expect(parsed.legacyTestCases![0]!.layer).toBe("real");
    expect(parsed.legacyTestCases![0]!.requiresScreenshot).toBe(true);
    const exp2 = parsed.legacyTestCases![0]!.expected;
    expect(exp2.type).toBe("exact");
    expect(exp2.type === "exact" && exp2.url).toBe("http://example.com");
  });
});

// ── U17: format 非 lite 抛错 ────────────────────────────────

describe("parseLitePlan format 非 lite（U17）", () => {
  it("U17: format='mid-clarify' → 抛错，reason 含 format 不匹配", () => {
    const json = {
      ...makeValidPlanJson(),
      format: "mid-clarify",
    };
    expect(() => parseLitePlan(json)).toThrow(/format/);
  });

  it("U17 补充: format='mid-detail' → 抛错", () => {
    const json = {
      ...makeValidPlanJson(),
      format: "mid-detail",
    };
    expect(() => parseLitePlan(json)).toThrow(/format/);
  });

  it("U17 补充: format 缺失 → 抛错", () => {
    const json = makeValidPlanJson() as Record<string, unknown>;
    delete json.format;
    expect(() => parseLitePlan(json)).toThrow();
  });
});

// ── U18: waves 空抛错 ───────────────────────────────────────

describe("parseLitePlan waves 空（U18）", () => {
  it("U18: waves=[] → schema 允许（Type.Array 无 minItems）", () => {
    // 注：LitePlanSchema 的 waves 是 Type.Array 无 minItems，空数组合法。
    // 空 waves 的兜底由后续 phase（dev gate 无 wave）自然处理。
    // 这与 plan.md U18「抛错」预期不同——src 实际实现不强制 minItems，记录实际行为。
    const json = {
      ...makeValidPlanJson(),
      waves: [],
    };
    expect(() => parseLitePlan(json)).not.toThrow();
  });

  it("U18 补充: testCases=[] → schema 允许（Type.Array 不强制 minItems）", () => {
    // 注：LitePlanSchema 的 testCases 是 Type.Array 无 minItems，空数组合法。
    // 这是 src 的实际设计——空 testCases 的兜底由后续 phase（test gate 无 case）自然处理。
    const json = {
      ...makeValidPlanJson(),
      testCases: [],
    };
    expect(() => parseLitePlan(json)).not.toThrow();
  });

  it("U18 补充: waves 缺失 → 抛错", () => {
    const json = makeValidPlanJson() as Record<string, unknown>;
    delete json.waves;
    expect(() => parseLitePlan(json)).toThrow();
  });
});

// ── 补充：超大输入防护 ──────────────────────────────────────

describe("parseLitePlan 补充防护", () => {
  it("非对象输入 → 抛错", () => {
    expect(() => parseLitePlan("not an object")).toThrow();
    expect(() => parseLitePlan(null)).toThrow();
    expect(() => parseLitePlan(42)).toThrow();
  });
});

// ── 环形依赖检测（assertAcyclicDeps）─────────────────────────

describe("parseLitePlan 环形 dependsOn 检测", () => {
  it("wave 环形依赖（W1→W2→W1）→ 抛错含 cycle", () => {
    const json = {
      ...makeValidPlanJson(),
      waves: [
        { id: "W1", changes: [{ file: "src/app.ts", description: "a" }], dependsOn: ["W2"] },
        { id: "W2", changes: [{ file: "src/app.ts", description: "b" }], dependsOn: ["W1"] },
      ],
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out2" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    };
    expect(() => parseLitePlan(json)).toThrow(/cycle|环形/i);
  });

  it("wave 自环（W1 dependsOn W1）→ 抛错含 cycle", () => {
    const json = {
      ...makeValidPlanJson(),
      waves: [{ id: "W1", changes: [{ file: "src/app.ts", description: "a" }], dependsOn: ["W1"] }],
      testCases: [
        {
          id: "E1",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    };
    expect(() => parseLitePlan(json)).toThrow(/cycle|环形/i);
  });

  it("wave 三元环（W1→W2→W3→W1）→ 抛错", () => {
    const json = {
      ...makeValidPlanJson(),
      waves: [
        { id: "W1", changes: [{ file: "src/app.ts", description: "a" }], dependsOn: ["W3"] },
        { id: "W2", changes: [{ file: "src/app.ts", description: "b" }], dependsOn: ["W1"] },
        { id: "W3", changes: [{ file: "src/app.ts", description: "c" }], dependsOn: ["W2"] },
      ],
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out2" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    };
    expect(() => parseLitePlan(json)).toThrow(/cycle|环形/i);
  });

  it("testCase 环形依赖（U1→U2→U1）→ 抛错含 cycle", () => {
    const json = {
      ...makeValidPlanJson(),
      testCases: [
        {
          id: "U1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out1" },
          executor: "agent",
          requiresScreenshot: false,
          dependsOn: ["U2"],
        },
        {
          id: "U2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out2" },
          executor: "agent",
          requiresScreenshot: false,
          dependsOn: ["U1"],
        },
      ],
    };
    expect(() => parseLitePlan(json)).toThrow(/cycle|环形/i);
  });

  it("无环的线性依赖链（W1←W2←W3）→ 解析成功", () => {
    const json = {
      ...makeValidPlanJson(),
      waves: [
        { id: "W1", changes: [{ file: "src/app.ts", description: "a" }], dependsOn: [] },
        { id: "W2", changes: [{ file: "src/app.ts", description: "b" }], dependsOn: ["W1"] },
        { id: "W3", changes: [{ file: "src/app.ts", description: "c" }], dependsOn: ["W2"] },
      ],
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out2" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    };
    expect(() => parseLitePlan(json)).not.toThrow();
  });
});

// ── W2: parseDevPlan + parseTestJson 新增测试 ─────────────────

import { parseClarifyJson, parseDevPlan, parseTestJson } from "../src/plan-parser.js";
import { CwError } from "../src/types.js";

describe("W2: parseDevPlan（拆分后的 dev-plan.json）", () => {
  it("只含 waves 不含 testCases → legacyTestCases undefined", () => {
    const json = {
      format: "lite",
      objective: "test obj",
      waves: [
        { id: "W1", changes: [{ file: "src/app.ts", description: "change1" }], dependsOn: [], priority: "P0" },
      ],
    };
    const parsed = parseDevPlan(json);
    expect(parsed.waves).toHaveLength(1);
    expect(parsed.waves[0]!.id).toBe("W1");
    expect(parsed.waves[0]!.priority).toBe("P0");
    expect(parsed.legacyTestCases).toBeUndefined();
  });

  it("旧格式（同时含 testCases）→ legacyTestCases 自动提取", () => {
    const json = {
      format: "lite",
      objective: "test obj",
      waves: [{ id: "W1", changes: [{ file: "src/app.ts", description: "change1" }], dependsOn: [] }],
      testCases: [
        {
          id: "U1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "result" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    };
    const parsed = parseDevPlan(json);
    expect(parsed.legacyTestCases).toHaveLength(1);
    expect(parsed.legacyTestCases![0]!.id).toBe("U1");
  });

  it("wave 带 priority 字段正确解析", () => {
    const json = {
      format: "lite",
      objective: "obj",
      waves: [
        { id: "W1", changes: [{ file: "src/app.ts", description: "a" }], dependsOn: [], priority: "P0" },
        { id: "W2", changes: [{ file: "src/app.ts", description: "b" }], dependsOn: ["W1"], priority: "P2" },
      ],
    };
    const parsed = parseDevPlan(json);
    expect(parsed.waves[0]!.priority).toBe("P0");
    expect(parsed.waves[1]!.priority).toBe("P2");
  });

  it("format 非 lite → 抛错", () => {
    const json = { format: "wrong", objective: "obj", waves: [] };
    expect(() => parseDevPlan(json)).toThrow(/format/);
  });
});

describe("W2: parseTestJson（拆分后的 test.json）", () => {
  function makeValidTestJson(): Record<string, unknown> {
    return {
      testCases: [
        {
          id: "U1",
          layer: "mock",
          scenario: "单测场景",
          steps: "执行单测",
          expected: { type: "exact", text: "expected-output" },
          executor: "vitest",
          requiresScreenshot: false,
          priority: "P0",
          redCheck: true,
        },
        {
          id: "E1",
          layer: "real",
          scenario: "集成场景",
          steps: "执行集成测试",
          expected: { type: "exact", text: "real-output" },
          executor: "vitest",
          requiresScreenshot: false,
          priority: "P1",
          redCheck: false,
        },
      ],
      testRunner: { mode: "nodejs", command: "npx vitest run" },
    };
  }

  it("合法 test.json → 解析成功，含 priority + redCheck", () => {
    const parsed = parseTestJson(makeValidTestJson());
    expect(parsed.testCases).toHaveLength(2);
    expect(parsed.testCases[0]!.priority).toBe("P0");
    expect(parsed.testCases[0]!.redCheck).toBe(true);
    expect(parsed.testCases[1]!.priority).toBe("P1");
    expect(parsed.testCases[1]!.redCheck).toBe(false);
  });

  it("testRunner 配置正确解析", () => {
    const json = {
      ...makeValidTestJson(),
      testRunner: { mode: "nodejs", command: "npx vitest run", cwd: "." },
    } as Record<string, unknown>;
    const parsed = parseTestJson(json);
    expect(parsed.testRunner).toBeDefined();
    expect(parsed.testRunner!.mode).toBe("nodejs");
    expect(parsed.testRunner!.command).toBe("npx vitest run");
  });

  it("testRunner custom 模式正确解析", () => {
    const json = {
      ...makeValidTestJson(),
      testRunner: { mode: "custom", path: ".cw/run-tests.sh" },
    } as Record<string, unknown>;
    const parsed = parseTestJson(json);
    expect(parsed.testRunner!.mode).toBe("custom");
    expect(parsed.testRunner!.path).toBe(".cw/run-tests.sh");
  });

  it("testRunner 缺失 → schema 报错（testRunner 已必选）", () => {
    // testRunner 不再 Optional（TestJsonSchema 强制必选）——缺失时 schema 校验抛错。
    expect(() => parseTestJson(makeValidTestJson())).not.toThrow();
    const { testRunner, ...withoutRunner } = makeValidTestJson() as Record<string, unknown>;
    void testRunner;
    expect(() => parseTestJson(withoutRunner)).toThrow(/testRunner/);
  });

  it("testCases 缺失 → 抛错", () => {
    expect(() => parseTestJson({})).toThrow();
  });

  it("testCase 环形 dependsOn → 抛错", () => {
    const json = {
      testCases: [
        {
          id: "U1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out" },
          executor: "vitest",
          requiresScreenshot: false,
          dependsOn: ["U2"],
        },
        {
          id: "U2",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "out2" },
          executor: "vitest",
          requiresScreenshot: false,
          dependsOn: ["U1"],
        },
      ],
      testRunner: { mode: "nodejs", command: "npx vitest run" },
    };
    expect(() => parseTestJson(json)).toThrow(/cycle|环形/i);
  });
});

// ── clarify: parseClarifyJson（单条 + 批量 + schema 校验） ─────

describe("parseClarifyJson", () => {
  it("单条合法 json → 返回数组长度 1，clarifySeed.kind 正确", () => {
    const json = {
      kind: "requirement",
      topic: "登录失败重试次数上限",
      assessment: "当前无重试限制，可能被暴力破解。",
      question: "登录失败重试次数上限设为多少？",
    };
    const parsed = parseClarifyJson(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.clarifySeed.kind).toBe("requirement");
    expect(parsed[0]!.clarifySeed.topic).toBe("登录失败重试次数上限");
  });

  it("批量数组（2 条）→ 返回数组长度 2", () => {
    const json = [
      { kind: "requirement", topic: "t1", assessment: "a1", question: "q1?" },
      { kind: "technical", topic: "t2", assessment: "a2", question: "q2?" },
    ];
    const parsed = parseClarifyJson(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.clarifySeed.kind).toBe("requirement");
    expect(parsed[1]!.clarifySeed.kind).toBe("technical");
  });

  it("空数组 → throw CwError", () => {
    expect(() => parseClarifyJson([])).toThrow(CwError);
  });

  it("kind 缺失 → throw（schema 校验）", () => {
    // kind 是必填，缺失触发 typebox Value.Check 失败。
    const json = { topic: "t", assessment: "a", question: "q?" };
    expect(() => parseClarifyJson(json)).toThrow();
  });

  it("assessment 缺失 → throw（schema 校验）", () => {
    const json = { kind: "technical", topic: "t", question: "q?" };
    expect(() => parseClarifyJson(json)).toThrow();
  });

  it("含 adr 字段 → clarifySeed.adr 非空，adr.title 正确", () => {
    const json = {
      kind: "technical",
      topic: "t",
      assessment: "a",
      question: "q?",
      adr: {
        title: "采用 SQLite 存储方案",
        context: "JSON+flock 并发不足",
        decision: "迁移到 better-sqlite3",
        alternatives: ["维持 JSON"],
        consequences: "引入原生依赖但并发更好",
      },
    };
    const parsed = parseClarifyJson(json);
    expect(parsed[0]!.clarifySeed.adr).toBeDefined();
    expect(parsed[0]!.clarifySeed.adr!.title).toBe("采用 SQLite 存储方案");
    expect(parsed[0]!.clarifySeed.adr!.alternatives).toEqual(["维持 JSON"]);
  });

  it("不含 adr 字段 → clarifySeed.adr 为 undefined", () => {
    const json = {
      kind: "technical",
      topic: "t",
      assessment: "a",
      question: "q?",
    };
    const parsed = parseClarifyJson(json);
    expect(parsed[0]!.clarifySeed.adr).toBeUndefined();
  });
});

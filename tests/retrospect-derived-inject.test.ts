/**
 * derived 摘要注入 + RETROSPECT_PROMPT 四段结构单测 — W4（FR-1 / FR-2 / AC-1 / AC-2 / AC-8）。
 *
 * 覆盖 AC：
 *   - AC-1: test gate pass 后进 retrospect，guidance 含 derived 摘要数字
 *   - AC-2: retrospect gate fail retry 时 guidance 同样含 derived 摘要
 *   - AC-8: RETROSPECT_PROMPT 含四段结构标记 + 第 1 段引用 derived 异常数
 *
 * 测什么：
 *   - buildNextAction("test", topic) test gate pass 出口 → guidance 含 derived 摘要关键词（AC-1）
 *   - buildNextAction("test", topic) testTurn 达上限强制出口 → guidance 含 derived 摘要（AC-1）
 *   - buildNextAction("retrospect", topic) gate fail retry 出口 → guidance 含 derived 摘要（AC-2）
 *   - derived 摘要含异常归因提示（gateFailCount>0 时）
 *   - RETROSPECT_PROMPT 含四段结构标记（grep 关键词）（AC-8）
 *   - buildDerivedSummary 纯函数输出格式稳定
 *
 * 防的 bug：
 *   - derived 没注入（agent 写反思时看不到本 topic 客观数据——偏差 1）。
 *   - 注入位置错（漏了某个出口：test pass 出口 / testTurn 上限出口 / retrospect retry 出口）。
 *   - prompt 四段结构标记缺失（偏差 2/3：processIssues 退化为 bug 复述、knownRisks 聚焦代码细节）。
 *
 * 测试模式：纯函数 buildNextAction + buildDerivedSummary 直接 import（照 stats.test.ts / state-machine.test.ts 模式）。
 * 不依赖 dispatch，直接构造 Topic 夹具。
 */

import { describe, expect, it } from "vitest";

import { RETROSPECT_PROMPT } from "../src/prompts/retrospect.js";
import { buildDerivedSummary, buildNextAction } from "../src/state-machine.js";
import type {
  GateHistoryEntry,
  TestCase,
  Topic,
  Wave,
} from "../src/types.js";

// ── 测试夹具（照 state-machine.test.ts / stats.test.ts 模式）────

function makeGateEntry(
  id: number,
  phase: GateHistoryEntry["phase"],
  gate: string,
  result: "pass" | "fail",
): GateHistoryEntry {
  return {
    id,
    phase,
    action: phase,
    gate,
    result,
    ts: "2026-01-01T00:00:00.000Z",
    progressive: false,
  };
}

function makePassedCase(id: string): TestCase {
  return {
    id,
    layer: "mock",
    scenario: "s",
    steps: "st",
    expected: { type: "exact", text: "out" },
    executor: "vitest",
    status: "passed",
    requiresScreenshot: false,
    dependsOn: [],
  };
}

function makeCommittedWave(id: string): Wave {
  return {
    id,
    dependsOn: [],
    committed: "hash" + id,
    changes: [{ file: `src/${id}.ts`, action: "create", description: "change" }],
  };
}

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    topicId: "cw-retro-inject",
    slug: "retro-inject",
    objective: "test derived inject",
    workspacePath: "/tmp",
    topicDir: "/tmp/.xyz-harness/retro-inject",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "post_dev_verified",
    waves: [makeCommittedWave("W1")],
    testCases: [makePassedCase("E1")],
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

// ── AC-1: test gate pass 出口注入 derived 摘要 ─────────────────

describe("AC-1: test gate pass 出口含 derived 摘要（W4 / FR-1）", () => {
  it("test 全 passed → nextAction.action=retrospect, guidance 含 derived 摘要数字", () => {
    // 全 passed → computeGatePassed("test")=true → 进 retrospect 出口。
    const topic = makeTopic({
      testCases: [makePassedCase("E1"), makePassedCase("E2")],
      waves: [makeCommittedWave("W1")],
      gateHistory: [
        makeGateEntry(1, "plan", "lite-plan-schema", "pass"),
        makeGateEntry(2, "dev", "medium-git", "pass"),
      ],
    });

    const na = buildNextAction("test", topic);
    expect(na.action).toBe("retrospect");
    // guidance 含 derived 摘要关键词：至少含 totalWaves / gateFailCount / firstTryPassRate 之一
    expect(na.guidance).toMatch(/totalWaves|gateFailCount|firstTryPassRate|derived/i);
  });

  it("derived 摘要含具体数字（如 totalWaves=1）", () => {
    const topic = makeTopic({
      testCases: [makePassedCase("E1")],
      waves: [makeCommittedWave("W1")],
    });

    const na = buildNextAction("test", topic);
    // 摘要含 totalWaves 的具体值（1 个 wave）
    expect(na.guidance).toMatch(/totalWaves\s*[=：]\s*1/);
  });

  it("gateFailCount>0 时 derived 摘要含异常归因提示", () => {
    // 构造一个有 gate fail 的 topic：dev fail 一次后 pass。
    const topic = makeTopic({
      testCases: [makePassedCase("E1")],
      waves: [makeCommittedWave("W1")],
      gateHistory: [
        makeGateEntry(1, "dev", "medium-git", "fail"),
        makeGateEntry(2, "dev", "medium-git", "pass"),
      ],
    });

    const na = buildNextAction("test", topic);
    expect(na.action).toBe("retrospect");
    // gateFailCount=1 > 0 → 摘要含异常归因提示（⚠️ 或 归因 关键词）
    expect(na.guidance).toMatch(/异常|归因|⚠️|重点/);
  });

  it("derived 摘要插入在 RETROSPECT_PROMPT 之前", () => {
    const topic = makeTopic({
      testCases: [makePassedCase("E1")],
      waves: [makeCommittedWave("W1")],
    });

    const na = buildNextAction("test", topic);
    // derived 摘要在 RETROSPECT_PROMPT（[retrospect 阶段]）之前
    const derivedIdx = na.guidance.search(/totalWaves|derived 摘要/i);
    const promptIdx = na.guidance.indexOf("[retrospect 阶段]");
    expect(derivedIdx).toBeGreaterThan(-1);
    expect(promptIdx).toBeGreaterThan(-1);
    expect(derivedIdx).toBeLessThan(promptIdx);
  });
});

// ── AC-1 补充: testTurn 达上限强制出口也注入 derived 摘要 ───────

describe("AC-1 补充: testTurn 达上限强制出口含 derived 摘要（W4 / FR-1）", () => {
  it("testTurn 达上限 + 有未通过 case → 强制进 retrospect, guidance 含 derived 摘要", () => {
    // testTurn 达上限 + 有 case 未通过 → 强制进 retrospect 出口。
    const topic = makeTopic({
      status: "post_dev_verified",
      testCases: [
        { ...makePassedCase("E1"), status: "failed" },
      ],
      testTurn: 99, // 远超 TEST_TURN_LIMIT，确保走 overLimit 分支
    });

    const na = buildNextAction("test", topic);
    expect(na.action).toBe("retrospect");
    // 强制出口同样注入 derived 摘要
    expect(na.guidance).toMatch(/totalWaves|gateFailCount|derived/i);
  });
});

// ── AC-2: retrospect gate fail retry 出口注入 derived 摘要 ──────

describe("AC-2: retrospect gate fail retry 出口含 derived 摘要（W4 / FR-1）", () => {
  it("retrospect gate 未 pass → retry 出口 guidance 含 derived 摘要", () => {
    // retrospect gate 未 pass（gateHistory 无 retrospect pass）→ retry 出口。
    const topic = makeTopic({
      status: "post_dev_verified",
      testCases: [makePassedCase("E1")],
      gateHistory: [
        // retrospect 有一条 fail 记录（无 pass）
        makeGateEntry(1, "retrospect", "file-exists+non-empty", "fail"),
      ],
    });

    const na = buildNextAction("retrospect", topic);
    expect(na.action).toBe("retrospect"); // retry 指回 retrospect
    // retry 出口同样注入 derived 摘要（AC-2）
    expect(na.guidance).toMatch(/totalWaves|gateFailCount|derived/i);
  });

  it("retrospect retry 出口 derived 摘要在 RETROSPECT_PROMPT 之前", () => {
    const topic = makeTopic({
      status: "post_dev_verified",
      testCases: [makePassedCase("E1")],
      gateHistory: [
        makeGateEntry(1, "retrospect", "file-exists+non-empty", "fail"),
      ],
    });

    const na = buildNextAction("retrospect", topic);
    const derivedIdx = na.guidance.search(/totalWaves|derived 摘要/i);
    const promptIdx = na.guidance.indexOf("[retrospect 阶段]");
    if (promptIdx > -1) {
      expect(derivedIdx).toBeLessThan(promptIdx);
    }
  });
});

// ── AC-8: RETROSPECT_PROMPT 四段结构标记 ──────────────────────

describe("AC-8: RETROSPECT_PROMPT 四段结构标记（W4 / FR-2）", () => {
  it("prompt 含「可泛化流程模式」段标记（第 2 段）", () => {
    // FR-2: 推荐四段结构，第 2 段引导从操作失误抽象出可泛化流程模式。
    // 防 processIssues 退化为 bug 复述（偏差 2）。
    expect(RETROSPECT_PROMPT).toMatch(/可泛化流程模式|可泛化.*模式|流程模式/);
  });

  it("prompt 含「设计级风险」段标记（第 3 段）", () => {
    // FR-2: 第 3 段引导从代码位置抽象到架构/接口/数据流层面，设计级优先。
    // 防 knownRisks 聚焦代码细节（偏差 3）。
    expect(RETROSPECT_PROMPT).toMatch(/设计级风险|设计级|架构.*接口.*数据流/);
  });

  it("prompt 第 1 段明确引用 derived 异常数（grep 校验）", () => {
    // FR-2 / AC-8: 第 1 段文案明确引用「derived 异常数（见上方 derived 摘要）」。
    expect(RETROSPECT_PROMPT).toMatch(/derived 异常数|derived 摘要|异常指标|对应.*derived/);
  });

  it("prompt 含「未闭环评估」段标记（第 4 段）", () => {
    // FR-2: 第 4 段承接现有 review issue 提醒（未闭环评估）。
    expect(RETROSPECT_PROMPT).toMatch(/未闭环|未闭环评估/);
  });

  it("prompt 含 processIssues 对象数组示例（type + description）", () => {
    // FR-2: processIssues 示例从 string[] 改为 [{type, description}] 对象数组。
    expect(RETROSPECT_PROMPT).toMatch(/"type"\s*:/);
    expect(RETROSPECT_PROMPT).toMatch(/pattern|oneOff/);
  });
});

// ── buildDerivedSummary 纯函数输出格式稳定 ────────────────────

describe("buildDerivedSummary 纯函数（W4 / FR-1）", () => {
  it("输出含 derived 摘要标题 + totalWaves/gateFailCount/firstTryPassRate 等指标", () => {
    const topic = makeTopic({
      waves: [makeCommittedWave("W1"), makeCommittedWave("W2")],
      testCases: [makePassedCase("E1"), makePassedCase("E2")],
      gateHistory: [
        makeGateEntry(1, "plan", "lite-plan-schema", "pass"),
      ],
    });

    const summary = buildDerivedSummary(topic);
    expect(typeof summary).toBe("string");
    // 含 totalWaves
    expect(summary).toMatch(/totalWaves/);
    expect(summary).toMatch(/totalWaves\s*[=：]\s*2/);
    // 含 gateFailCount
    expect(summary).toMatch(/gateFailCount/);
    // 含 firstTryPassRate
    expect(summary).toMatch(/firstTryPassRate/);
  });

  it("无异常指标时（全 pass）不含异常归因提示", () => {
    const topic = makeTopic({
      waves: [makeCommittedWave("W1")],
      testCases: [makePassedCase("E1")],
      gateHistory: [
        makeGateEntry(1, "plan", "lite-plan-schema", "pass"),
        makeGateEntry(2, "dev", "medium-git", "pass"),
        makeGateEntry(3, "tdd_plan", "tdd-red-light", "pass"),
      ],
    });

    const summary = buildDerivedSummary(topic);
    expect(summary).toMatch(/totalWaves\s*[=：]\s*1/);
    // gateFailCount=0, firstTryPassRate=1 → 无异常归因提示
    expect(summary).not.toMatch(/异常|⚠️|必须给出至少 1 条归因/);
  });

  it("有异常指标时（gateFailCount>0）含归因提示", () => {
    const topic = makeTopic({
      waves: [makeCommittedWave("W1")],
      testCases: [makePassedCase("E1")],
      gateHistory: [
        makeGateEntry(1, "dev", "medium-git", "fail"),
        makeGateEntry(2, "dev", "medium-git", "pass"),
      ],
    });

    const summary = buildDerivedSummary(topic);
    // gateFailCount=1 > 0 → 含异常归因提示
    expect(summary).toMatch(/异常|归因|⚠️/);
  });
});

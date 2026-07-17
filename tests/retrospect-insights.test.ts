/**
 * cw stats --all retrospectInsights 聚合单测 — W5（FR-6 / AC-6）。
 *
 * 覆盖 AC：
 *   - AC-6: cw stats --all 输出含 retrospectInsights 段，含 type 分桶统计 + pattern Top N 高频模式
 *
 * 测什么（纯函数 computeStatsAll 直接 import，照 stats.test.ts 跨 topic 聚合模式）：
 *   - computeStatsAll 输出含 retrospectInsights 字段
 *   - typeBuckets 四计数器正确（pattern/oneOff/observation/uncategorized 各几个）
 *   - 跨 topic 聚合（多 topic 的 processIssues 合并统计）
 *   - topPatterns 按 pattern 的 description 词频排序取 Top N
 *   - 排除 aborted topic
 *   - 无 retrospectData 的 topic 不崩
 *
 * 防的 bug：
 *   - 聚合漏算（某 type 没计数）。
 *   - 词频统计错（大小写未归一 / 未分词）。
 *   - aborted topic 污染聚合。
 *   - 空数据崩（无 retrospectData 的 topic）。
 *   - 旧 string[] 未迁移导致聚合崩（依赖 W2 迁移，这里用对象数组测已迁移后路径）。
 *
 * 测试模式：纯函数 computeStatsAll 直接 import（照 stats.test.ts computeStatsAll 测试）。
 * Topic 夹具含 retrospectData.processIssues（对象数组，模拟 W2 迁移后的格式）。
 */

import { describe, expect, it } from "vitest";

import { computeStatsAll } from "../src/stats.js";
import type {
  RetrospectData,
  RetrospectInsights,
  RuntimeEnv,
  Topic,
} from "../src/types.js";

// ── 测试夹具（照 stats.test.ts 模式）──────────────────────────

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    topicId: "cw-test-topic",
    slug: "test",
    objective: "test objective",
    workspacePath: "/tmp",
    topicDir: "/tmp/.xyz-harness/test",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "closed",
    waves: [
      { id: "W1", dependsOn: [], committed: "abc", changes: [{ file: "src/a.ts", description: "c" }] },
    ],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
    clarifyRecords: [],
    specSections: [],
    adrs: [],
    reviewIssues: [],
    reviewTurn: 0,
    testFixLog: [],
    testTurn: 0,
    assessments: [],
    ...overrides,
  };
}

function makeRetrospectData(
  processIssues: RetrospectData["processIssues"],
): RetrospectData {
  return {
    derived: {
      totalWaves: 1,
      totalCases: 0,
      gateFailCount: 0,
      devRetryCount: 0,
      testRetryCount: 0,
      redLightConfirmed: false,
      firstTryPassRate: 1,
    },
    knownRisks: [],
    processIssues,
  };
}

const SAMPLE_ENV: RuntimeEnv = {
  agent: "Pi",
  llm: "GLM-5.2",
  cwVersion: "0.0.1",
};

// ── retrospectInsights 字段存在性 ─────────────────────────────

describe("computeStatsAll — retrospectInsights 字段（W5 / AC-6）", () => {
  it("输出含 retrospectInsights 顶层字段", () => {
    const topics = [
      makeTopic({
        topicId: "t1",
        runtimeEnv: SAMPLE_ENV,
        retrospectData: makeRetrospectData([]),
      }),
    ];
    const output = computeStatsAll(topics);
    // FR-6: retrospectInsights 是顶层字段（聚合跨 RuntimeEnv，不按 group 分组）
    expect(output).toHaveProperty("retrospectInsights");
    expect(output.retrospectInsights).toBeDefined();
  });

  it("retrospectInsights 含 typeBuckets + topPatterns 结构", () => {
    const topics = [
      makeTopic({
        topicId: "t1",
        runtimeEnv: SAMPLE_ENV,
        retrospectData: makeRetrospectData([
          { type: "pattern", description: "subagent 行为不可控" },
        ]),
      }),
    ];
    const output = computeStatsAll(topics);
    const insights = output.retrospectInsights as RetrospectInsights;
    expect(insights).toHaveProperty("typeBuckets");
    expect(insights).toHaveProperty("topPatterns");
    expect(insights.typeBuckets).toHaveProperty("pattern");
    expect(insights.typeBuckets).toHaveProperty("oneOff");
    expect(insights.typeBuckets).toHaveProperty("observation");
    expect(insights.typeBuckets).toHaveProperty("uncategorized");
    expect(Array.isArray(insights.topPatterns)).toBe(true);
  });

  it("无 retrospectData 的 topic → retrospectInsights 仍存在（空桶，不崩）", () => {
    const topics = [
      makeTopic({ topicId: "t1", runtimeEnv: SAMPLE_ENV }), // 无 retrospectData
    ];
    const output = computeStatsAll(topics);
    expect(output.retrospectInsights).toBeDefined();
    const insights = output.retrospectInsights as RetrospectInsights;
    expect(insights.typeBuckets.pattern).toBe(0);
    expect(insights.typeBuckets.oneOff).toBe(0);
    expect(insights.typeBuckets.observation).toBe(0);
    expect(insights.typeBuckets.uncategorized).toBe(0);
    expect(insights.topPatterns).toEqual([]);
  });

  it("空 topics → retrospectInsights 空桶（不崩）", () => {
    const output = computeStatsAll([]);
    expect(output.retrospectInsights).toBeDefined();
    expect((output.retrospectInsights as RetrospectInsights).typeBuckets.pattern).toBe(0);
  });
});

// ── typeBuckets 四计数器 ─────────────────────────────────────

describe("computeStatsAll — typeBuckets 四计数器（W5 / AC-6）", () => {
  it("单 topic 四种 type 各 1 条 → 四计数器各 1", () => {
    const topics = [
      makeTopic({
        topicId: "t1",
        runtimeEnv: SAMPLE_ENV,
        retrospectData: makeRetrospectData([
          { type: "pattern", description: "模式 1" },
          { type: "oneOff", description: "失误 1" },
          { type: "observation", description: "观察 1" },
          { type: "uncategorized", description: "迁移 1" },
        ]),
      }),
    ];
    const output = computeStatsAll(topics);
    const buckets = (output.retrospectInsights as RetrospectInsights).typeBuckets;
    expect(buckets.pattern).toBe(1);
    expect(buckets.oneOff).toBe(1);
    expect(buckets.observation).toBe(1);
    expect(buckets.uncategorized).toBe(1);
  });

  it("跨 topic 聚合：2 个 topic 的 processIssues 合并统计", () => {
    const topics = [
      makeTopic({
        topicId: "t1",
        runtimeEnv: SAMPLE_ENV,
        retrospectData: makeRetrospectData([
          { type: "pattern", description: "topic1 模式" },
          { type: "oneOff", description: "topic1 失误" },
        ]),
      }),
      makeTopic({
        topicId: "t2",
        runtimeEnv: SAMPLE_ENV,
        retrospectData: makeRetrospectData([
          { type: "pattern", description: "topic2 模式" },
          { type: "pattern", description: "topic2 模式 2" },
          { type: "observation", description: "topic2 观察" },
        ]),
      }),
    ];
    const output = computeStatsAll(topics);
    const buckets = (output.retrospectInsights as RetrospectInsights).typeBuckets;
    // pattern: 1 (t1) + 2 (t2) = 3
    expect(buckets.pattern).toBe(3);
    expect(buckets.oneOff).toBe(1);
    expect(buckets.observation).toBe(1);
    expect(buckets.uncategorized).toBe(0);
  });

  it("跨 RuntimeEnv 聚合（retrospectInsights 不按 group 分组）", () => {
    // FR-6: 流程问题是 agent 通用问题，retrospectInsights 聚合跨 RuntimeEnv。
    const envA: RuntimeEnv = { agent: "Pi", llm: "GLM-5.2", cwVersion: "0.1.0" };
    const envB: RuntimeEnv = { agent: "Claude", llm: "Sonnet", cwVersion: "0.1.0" };
    const topics = [
      makeTopic({
        topicId: "t1",
        runtimeEnv: envA,
        retrospectData: makeRetrospectData([
          { type: "pattern", description: "envA 模式" },
        ]),
      }),
      makeTopic({
        topicId: "t2",
        runtimeEnv: envB,
        retrospectData: makeRetrospectData([
          { type: "pattern", description: "envB 模式" },
        ]),
      }),
    ];
    const output = computeStatsAll(topics);
    const buckets = (output.retrospectInsights as RetrospectInsights).typeBuckets;
    // 跨 env 聚合：pattern=2（不是按 env 分组各 1）
    expect(buckets.pattern).toBe(2);
  });
});

// ── topPatterns 词频排序 ─────────────────────────────────────

describe("computeStatsAll — topPatterns 词频统计（W5 / AC-6）", () => {
  it("pattern 的 description 词频统计 → topPatterns 按词频降序", () => {
    // 3 条 pattern description 都含 "subagent" 词，1 条含 2 个 "plan" 词。
    // plan 故意出现 2 次（count=2）：R5 引入中文 bigram 后 token 数从 ~6 涨到 ~27，
    // count=1 的英文词会被中文 bigram 挤出 Top 10；让 plan count=2 稳进 Top 10，
    // 同时 subagent（count=3）仍是最高频。
    const topics = [
      makeTopic({
        topicId: "t1",
        runtimeEnv: SAMPLE_ENV,
        retrospectData: makeRetrospectData([
          { type: "pattern", description: "subagent 切分支导致丢失改动" },
          { type: "pattern", description: "subagent 行为不可控" },
          { type: "pattern", description: "subagent 超时未处理" },
          { type: "pattern", description: "plan 拆分粒度过细，plan 需重构" },
        ]),
      }),
    ];
    const output = computeStatsAll(topics);
    const topPatterns = (output.retrospectInsights as RetrospectInsights).topPatterns;
    expect(topPatterns.length).toBeGreaterThan(0);
    // subagent 出现 3 次（最高频），plan 出现 2 次，都应进 Top 10
    const subagent = topPatterns.find((p) => p.word === "subagent");
    const plan = topPatterns.find((p) => p.word === "plan");
    expect(subagent).toBeDefined();
    expect(subagent!.count).toBe(3);
    expect(plan).toBeDefined();
    expect(plan!.count).toBe(2);
    // subagent 词频 > plan → 排在前
    const subagentIdx = topPatterns.findIndex((p) => p.word === "subagent");
    const planIdx = topPatterns.findIndex((p) => p.word === "plan");
    expect(subagentIdx).toBeLessThan(planIdx);
  });

  it("topPatterns 只统计 type=pattern，不含 oneOff/observation 的词", () => {
    const topics = [
      makeTopic({
        topicId: "t1",
        runtimeEnv: SAMPLE_ENV,
        retrospectData: makeRetrospectData([
          { type: "pattern", description: "patternword 模式" },
          { type: "oneOff", description: "oneoffword 失误" },
          { type: "observation", description: "obsword 观察" },
        ]),
      }),
    ];
    const output = computeStatsAll(topics);
    const topPatterns = (output.retrospectInsights as RetrospectInsights).topPatterns;
    const words = topPatterns.map((p) => p.word);
    // patternword 可能被切分，但 oneoffword / obsword 不应出现（只在 pattern 里统计）
    expect(words).not.toContain("oneoffword");
    expect(words).not.toContain("obsword");
  });

  it("词频统计大小写归一（pattern description 大小写不同算同一词）", () => {
    const topics = [
      makeTopic({
        topicId: "t1",
        runtimeEnv: SAMPLE_ENV,
        retrospectData: makeRetrospectData([
          { type: "pattern", description: "Subagent 切分支" },
          { type: "pattern", description: "subagent 超时" },
        ]),
      }),
    ];
    const output = computeStatsAll(topics);
    const topPatterns = (output.retrospectInsights as RetrospectInsights).topPatterns;
    // Subagent / subagent 归一为同一词，count=2
    const subagent = topPatterns.find((p) => p.word === "subagent");
    expect(subagent).toBeDefined();
    expect(subagent!.count).toBe(2);
  });
});

// ── aborted topic 排除 ───────────────────────────────────────

describe("computeStatsAll — 排除 aborted topic（W5 / AC-6）", () => {
  it("aborted topic 的 processIssues 不计入 retrospectInsights 聚合", () => {
    const topics = [
      makeTopic({
        topicId: "t1",
        runtimeEnv: SAMPLE_ENV,
        retrospectData: makeRetrospectData([
          { type: "pattern", description: "正常 topic 模式" },
        ]),
      }),
      makeTopic({
        topicId: "t2",
        status: "aborted", // 废弃 topic
        runtimeEnv: SAMPLE_ENV,
        retrospectData: makeRetrospectData([
          { type: "pattern", description: "aborted topic 不应计入" },
          { type: "oneOff", description: "aborted 失误" },
        ]),
      }),
    ];
    const output = computeStatsAll(topics);
    const buckets = (output.retrospectInsights as RetrospectInsights).typeBuckets;
    // aborted topic 不污染聚合：只有 t1 的 1 条 pattern
    expect(buckets.pattern).toBe(1);
    expect(buckets.oneOff).toBe(0);
  });
});

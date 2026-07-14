/**
 * stats 单测 — computeStats 纯函数。
 *
 * 覆盖：复杂度分桶（simple/medium/complex）、首次正确率、早期拦截率、
 * dev/test 重试计数、杠杆健康度（pass/fail/not-run）。
 *
 * 遵循项目测试模式：纯函数直接 import，无需 tmp 目录或 mock。
 */

import { describe, expect, it } from "vitest";

import { SCOPE_WARN_FILES, SCOPE_WARN_WAVES } from "../src/gate.js";
import { computeStats, computeStatsAll } from "../src/stats.js";
import type {
  GateHistoryEntry,
  RetrospectData,
  RuntimeEnv,
  Topic,
} from "../src/types.js";

// ── 测试夹具 ────────────────────────────────────────────────

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    topicId: "cw-test-topic",
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
    // review/test-fix 机制的空默认值（与 review-fix wave 并行开发的 types 字段）。
    reviewIssues: [],
    reviewTurn: 0,
    testFixLog: [],
    testTurn: 0,
    assessments: [],
    ...overrides,
  };
}

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
    ts: new Date().toISOString(),
    progressive: false,
  };
}

const SAMPLE_ENV: RuntimeEnv = {
  agent: "Pi",
  llm: "GLM-5.2",
  cwVersion: "0.0.1",
};

// ── 复杂度分桶 ──────────────────────────────────────────────

describe("computeStats — 复杂度分桶", () => {
  it("simple: 1 wave, 1 file", () => {
    const topic = makeTopic({
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: null,
          changes: ["修改 src/foo.ts"],
        },
      ],
    });
    const stats = computeStats(topic);
    expect(stats.complexity.level).toBe("simple");
    expect(stats.complexity.waves).toBe(1);
    expect(stats.complexity.estimatedFiles).toBe(1);
  });

  it("simple: 3 waves, 5 files（边界值）", () => {
    const topic = makeTopic({
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: null,
          changes: ["修改 src/a.ts", "修改 src/b.ts"],
        },
        {
          id: "W2",
          dependsOn: ["W1"],
          committed: null,
          changes: ["修改 src/c.ts"],
        },
        {
          id: "W3",
          dependsOn: ["W1"],
          committed: null,
          changes: ["修改 src/d.ts", "修改 src/e.ts"],
        },
      ],
    });
    const stats = computeStats(topic);
    expect(stats.complexity.level).toBe("simple");
    expect(stats.complexity.waves).toBe(3);
    expect(stats.complexity.estimatedFiles).toBe(5);
  });

  it("medium: 5 waves, 8 files", () => {
    const waves = Array.from({ length: 5 }, (_, i) => ({
      id: `W${i + 1}`,
      dependsOn: [],
      committed: null,
      changes: [`修改 src/file${i}.ts`],
    }));
    // 额外加几个文件让总数 > 5
    waves[0]!.changes.push("修改 src/extra1.ts", "修改 src/extra2.ts", "修改 src/extra3.ts");
    const stats = computeStats(makeTopic({ waves }));
    expect(stats.complexity.level).toBe("medium");
  });

  it(`complex: waves >= ${SCOPE_WARN_WAVES}`, () => {
    const waves = Array.from({ length: SCOPE_WARN_WAVES }, (_, i) => ({
      id: `W${i + 1}`,
      dependsOn: [],
      committed: null,
      changes: [`修改 src/f${i}.ts`],
    }));
    const stats = computeStats(makeTopic({ waves }));
    expect(stats.complexity.level).toBe("complex");
    expect(stats.complexity.waves).toBe(SCOPE_WARN_WAVES);
  });

  it(`complex: files >= ${SCOPE_WARN_FILES}`, () => {
    const changes = Array.from(
      { length: SCOPE_WARN_FILES },
      (_, i) => `修改 src/f${i}.ts`,
    );
    const topic = makeTopic({
      waves: [
        { id: "W1", dependsOn: [], committed: null, changes },
      ],
    });
    const stats = computeStats(topic);
    expect(stats.complexity.level).toBe("complex");
    expect(stats.complexity.estimatedFiles).toBe(SCOPE_WARN_FILES);
  });

  it("runtimeEnv 传递到 stats output", () => {
    const topic = makeTopic({ runtimeEnv: SAMPLE_ENV });
    const stats = computeStats(topic);
    expect(stats.runtimeEnv).toEqual(SAMPLE_ENV);
  });

  it("无 runtimeEnv（旧 topic）→ runtimeEnv undefined", () => {
    const stats = computeStats(makeTopic());
    expect(stats.runtimeEnv).toBeUndefined();
  });
});

// ── 过程效率 ────────────────────────────────────────────────

describe("computeStats — 过程效率", () => {
  it("空 gateHistory → earlyInterceptionRate=1, 无 fail", () => {
    const stats = computeStats(makeTopic());
    expect(stats.efficiency.earlyInterceptionRate).toBe(1);
    expect(stats.efficiency.totalGateFails).toBe(0);
    expect(stats.efficiency.devRetryCount).toBe(0);
    expect(stats.efficiency.testRetryCount).toBe(0);
    expect(Object.keys(stats.efficiency.firstTryPass)).toHaveLength(0);
  });

  it("首次正确率：plan 首次 pass, dev 首次 fail", () => {
    const topic = makeTopic({
      gateHistory: [
        makeGateEntry(1, "plan", "lite-plan-schema", "pass"),
        makeGateEntry(2, "dev", "medium-git", "fail"),
        makeGateEntry(3, "dev", "medium-git", "pass"),
      ],
    });
    const stats = computeStats(topic);
    expect(stats.efficiency.firstTryPass["plan"]).toBe(true);
    expect(stats.efficiency.firstTryPass["dev"]).toBe(false);
  });

  it("早期拦截率：dev+test fail 占总 fail 比例", () => {
    const topic = makeTopic({
      gateHistory: [
        makeGateEntry(1, "dev", "medium-git", "fail"),
        makeGateEntry(2, "dev", "medium-git", "pass"),
        makeGateEntry(3, "test", "judgeByExpected", "fail"),
        makeGateEntry(4, "test", "judgeByExpected", "pass"),
        makeGateEntry(5, "review", "file-exists+non-empty", "fail"),
      ],
    });
    const stats = computeStats(topic);
    // 3 个 fail，2 个在 dev+test → 2/3
    expect(stats.efficiency.earlyInterceptionRate).toBeCloseTo(2 / 3);
    expect(stats.efficiency.totalGateFails).toBe(3);
    expect(stats.efficiency.devRetryCount).toBe(1);
    expect(stats.efficiency.testRetryCount).toBe(1);
  });

  it("全部在晚期 fail（review/closeout）→ earlyInterceptionRate=0", () => {
    const topic = makeTopic({
      gateHistory: [
        makeGateEntry(1, "review", "file-exists+non-empty", "fail"),
        makeGateEntry(2, "closeout", "topicDir-exists", "fail"),
      ],
    });
    const stats = computeStats(topic);
    expect(stats.efficiency.earlyInterceptionRate).toBe(0);
    expect(stats.efficiency.totalGateFails).toBe(2);
  });

  it("晚期返工率：review+closeout fail 占总 fail 比例", () => {
    const topic = makeTopic({
      gateHistory: [
        makeGateEntry(1, "dev", "medium-git", "fail"),
        makeGateEntry(2, "dev", "medium-git", "pass"),
        makeGateEntry(3, "review", "file-exists+non-empty", "fail"),
        makeGateEntry(4, "closeout", "topicDir-exists", "fail"),
      ],
    });
    const stats = computeStats(topic);
    // 3 fail，2 个在 review+closeout → 2/3
    expect(stats.efficiency.lateReworkRate).toBeCloseTo(2 / 3);
  });

  it("晚期返工率：无 fail 时为 0（不是 1）", () => {
    const topic = makeTopic({
      gateHistory: [
        makeGateEntry(1, "dev", "medium-git", "pass"),
        makeGateEntry(2, "test", "judgeByExpected", "pass"),
      ],
    });
    const stats = computeStats(topic);
    expect(stats.efficiency.lateReworkRate).toBe(0);
  });

  it("晚期返工率：全部早期 fail → lateReworkRate=0", () => {
    const topic = makeTopic({
      gateHistory: [
        makeGateEntry(1, "dev", "medium-git", "fail"),
        makeGateEntry(2, "test", "judgeByExpected", "fail"),
      ],
    });
    const stats = computeStats(topic);
    // 全 fail 在 dev+test，review/closeout 无 fail → 0/2 = 0
    expect(stats.efficiency.lateReworkRate).toBe(0);
  });

  it("晚期返工率与早期拦截率互补", () => {
    const topic = makeTopic({
      gateHistory: [
        makeGateEntry(1, "dev", "medium-git", "fail"),
        makeGateEntry(2, "review", "file-exists+non-empty", "fail"),
      ],
    });
    const stats = computeStats(topic);
    // 1 早期 + 1 晚期 → 各 0.5
    expect(stats.efficiency.earlyInterceptionRate).toBeCloseTo(0.5);
    expect(stats.efficiency.lateReworkRate).toBeCloseTo(0.5);
  });
});

// ── plan 完成度 + 覆盖率 flag ───────────────────────────────

describe("computeStats — plan 完成度 + 覆盖率 flag", () => {
  it("planCompletionRate：全部 committed → 1", () => {
    const topic = makeTopic({
      waves: [
        { id: "W1", dependsOn: [], committed: "abc123", changes: [] },
        { id: "W2", dependsOn: ["W1"], committed: "def456", changes: [] },
      ],
    });
    const stats = computeStats(topic);
    expect(stats.efficiency.planCompletionRate).toBe(1);
  });

  it("planCompletionRate：部分 committed", () => {
    const topic = makeTopic({
      waves: [
        { id: "W1", dependsOn: [], committed: "abc123", changes: [] },
        { id: "W2", dependsOn: ["W1"], committed: null, changes: [] },
        { id: "W3", dependsOn: ["W1"], committed: "ghi789", changes: [] },
      ],
    });
    const stats = computeStats(topic);
    // 2/3 committed
    expect(stats.efficiency.planCompletionRate).toBeCloseTo(2 / 3);
  });

  it("planCompletionRate：全部未 committed → 0", () => {
    const topic = makeTopic({
      waves: [
        { id: "W1", dependsOn: [], committed: null, changes: [] },
        { id: "W2", dependsOn: ["W1"], committed: null, changes: [] },
      ],
    });
    const stats = computeStats(topic);
    expect(stats.efficiency.planCompletionRate).toBe(0);
  });

  it("planCompletionRate：无 waves → 0", () => {
    const stats = computeStats(makeTopic());
    expect(stats.efficiency.planCompletionRate).toBe(0);
  });

  it("coverageFlag：coverage < 0.5 → true", () => {
    const topic = makeTopic({
      evidence: { closedAt: "2026-01-01T00:00:00.000Z", coverage: 0.3, gateHistory: [] },
    });
    const stats = computeStats(topic);
    expect(stats.efficiency.coverageFlag).toBe(true);
  });

  it("coverageFlag：coverage = 0.5 → false（边界值，< 0.5 才 flag）", () => {
    const topic = makeTopic({
      evidence: { closedAt: "2026-01-01T00:00:00.000Z", coverage: 0.5, gateHistory: [] },
    });
    const stats = computeStats(topic);
    expect(stats.efficiency.coverageFlag).toBe(false);
  });

  it("coverageFlag：coverage > 0.5 → false", () => {
    const topic = makeTopic({
      evidence: { closedAt: "2026-01-01T00:00:00.000Z", coverage: 0.8, gateHistory: [] },
    });
    const stats = computeStats(topic);
    expect(stats.efficiency.coverageFlag).toBe(false);
  });

  it("coverageFlag：无 evidence → false", () => {
    const stats = computeStats(makeTopic());
    expect(stats.efficiency.coverageFlag).toBe(false);
  });
});

// ── 杠杆健康度 ─────────────────────────────────────────────

describe("computeStats — 杠杆健康度", () => {
  it("无 gateHistory → 全部 not-run", () => {
    const stats = computeStats(makeTopic());
    expect(stats.leverHealth.length).toBeGreaterThan(0);
    expect(stats.leverHealth.every((l) => l.status === "not-run")).toBe(true);
  });

  it("TDD 红灯 pass → tdd-red-light gate 状态 pass", () => {
    const topic = makeTopic({
      gateHistory: [
        makeGateEntry(1, "tdd_plan", "tdd-red-light", "pass"),
      ],
    });
    const stats = computeStats(topic);
    const tddLever = stats.leverHealth.find((l) => l.gate === "tdd-red-light");
    expect(tddLever?.status).toBe("pass");
  });

  it("同一 gate 多条记录 → 取最新", () => {
    const topic = makeTopic({
      gateHistory: [
        makeGateEntry(1, "tdd_plan", "tdd-red-light", "fail"),
        makeGateEntry(2, "tdd_plan", "tdd-red-light", "pass"),
      ],
    });
    const stats = computeStats(topic);
    const tddLever = stats.leverHealth.find((l) => l.gate === "tdd-red-light");
    // 最新（id=2）是 pass
    expect(tddLever?.status).toBe("pass");
  });

  it("杠杆列表含核心机制", () => {
    const stats = computeStats(makeTopic());
    const leverNames = stats.leverHealth.map((l) => l.lever);
    expect(leverNames).toContain("TDD 红灯先行");
    expect(leverNames).toContain("dev commit 锚定");
    expect(leverNames).toContain("test 机器重算");
    expect(leverNames).toContain("append-only 安全");
    expect(leverNames).toContain("retrospect 结构化");
  });

  it("retrospect 杠杆：有 retrospectData → pass", () => {
    const retrospectData: RetrospectData = {
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
      processIssues: [],
    };
    const topic = makeTopic({ retrospectData });
    const stats = computeStats(topic);
    const lever = stats.leverHealth.find((l) => l.lever === "retrospect 结构化");
    expect(lever?.status).toBe("pass");
  });

  it("retrospect 杠杆：无 retrospectData → not-run（即使 gate pass）", () => {
    // gateHistory 含 file-exists+non-empty pass（review 阶段），但无 retrospectData。
    // retrospect 杠杆不该跟 review 共用 gate 状态——看 retrospectData 而非 gate。
    const topic = makeTopic({
      gateHistory: [
        makeGateEntry(1, "review", "file-exists+non-empty", "pass"),
      ],
    });
    const stats = computeStats(topic);
    const lever = stats.leverHealth.find((l) => l.lever === "retrospect 结构化");
    expect(lever?.status).toBe("not-run");
    // review 存在性 lever 仍按 gate 走 → pass
    const reviewLever = stats.leverHealth.find((l) => l.lever === "review 存在性");
    expect(reviewLever?.status).toBe("pass");
  });

  it("retrospect 杠杆：无 gateHistory 无 retrospectData → not-run", () => {
    const stats = computeStats(makeTopic());
    const lever = stats.leverHealth.find((l) => l.lever === "retrospect 结构化");
    expect(lever?.status).toBe("not-run");
  });
});

// ── 跨 topic 聚合（computeStatsAll）─────────────────────────

describe("computeStatsAll — 跨 topic 聚合", () => {
  function makeCommittedWave(id: string, file: string): Topic["waves"][number] {
    return {
      id,
      dependsOn: [],
      committed: "abc" + id,
      changes: [`修改 src/${file}.ts`],
    };
  }

  it("空 topics → 空 groups", () => {
    const output = computeStatsAll([]);
    expect(output.groups).toEqual([]);
  });

  it("不同 runtimeEnv → 不同分组", () => {
    const envA: RuntimeEnv = { agent: "Pi", llm: "GLM-5.2", cwVersion: "0.1.0" };
    const envB: RuntimeEnv = { agent: "Claude", llm: "Sonnet", cwVersion: "0.1.0" };
    const topics = [
      makeTopic({ topicId: "t1", runtimeEnv: envA }),
      makeTopic({ topicId: "t2", runtimeEnv: envB }),
    ];
    const output = computeStatsAll(topics);
    expect(output.groups).toHaveLength(2);
    expect(output.groups[0]).toMatchObject({ agent: "Pi", llm: "GLM-5.2", cwVersion: "0.1.0" });
    expect(output.groups[1]).toMatchObject({ agent: "Claude", llm: "Sonnet", cwVersion: "0.1.0" });
  });

  it("同 runtimeEnv 归入同一分组（agent 相同但 llm 不同 → 不同组）", () => {
    const envA: RuntimeEnv = { agent: "Pi", llm: "GLM-5.2", cwVersion: "0.1.0" };
    const envB: RuntimeEnv = { agent: "Pi", llm: "GLM-5.0", cwVersion: "0.1.0" };
    const topics = [
      makeTopic({ topicId: "t1", runtimeEnv: envA }),
      makeTopic({ topicId: "t2", runtimeEnv: envA }),
      makeTopic({ topicId: "t3", runtimeEnv: envB }),
    ];
    const output = computeStatsAll(topics);
    expect(output.groups).toHaveLength(2);
    // 第一组（envA）含 2 个 topic
    const groupA = output.groups.find(
      (g) => g.llm === "GLM-5.2",
    );
    expect(groupA?.topicCount).toBe(2);
    const groupB = output.groups.find(
      (g) => g.llm === "GLM-5.0",
    );
    expect(groupB?.topicCount).toBe(1);
  });

  it("旧 topic（无 runtimeEnv）归入 unknown 分组", () => {
    const env: RuntimeEnv = { agent: "Pi", llm: "GLM-5.2", cwVersion: "0.1.0" };
    const topics = [
      makeTopic({ topicId: "t1", runtimeEnv: env }),
      makeTopic({ topicId: "t2" }), // 无 runtimeEnv
      makeTopic({ topicId: "t3" }), // 无 runtimeEnv
    ];
    const output = computeStatsAll(topics);
    expect(output.groups).toHaveLength(2);
    const unknownGroup = output.groups.find((g) => g.agent === "unknown");
    expect(unknownGroup).toBeDefined();
    expect(unknownGroup?.agent).toBe("unknown");
    expect(unknownGroup?.llm).toBe("unknown");
    expect(unknownGroup?.cwVersion).toBe("unknown");
    expect(unknownGroup?.runtimeEnv).toBeUndefined();
    expect(unknownGroup?.topicCount).toBe(2);
  });

  it("同组内按复杂度分桶，桶内算均值", () => {
    const env: RuntimeEnv = { agent: "Pi", llm: "GLM-5.2", cwVersion: "0.1.0" };
    // 2 个 simple topic（1 wave 1 file，committed）
    const simpleTopic = (id: string): Topic =>
      makeTopic({
        topicId: id,
        runtimeEnv: env,
        waves: [makeCommittedWave("W1", `f${id}`)],
      });
    // 1 个 complex topic（>= SCOPE_WARN_WAVES 个 wave）
    const complexWaves = Array.from({ length: SCOPE_WARN_WAVES }, (_, i) => ({
      id: `W${i}`,
      dependsOn: [],
      committed: "c" + i,
      changes: [`修改 src/cf${i}.ts`],
    }));
    const complexTopic = makeTopic({
      topicId: "cx",
      runtimeEnv: env,
      waves: complexWaves,
    });
    const topics = [simpleTopic("s1"), simpleTopic("s2"), complexTopic];
    const output = computeStatsAll(topics);
    expect(output.groups).toHaveLength(1);
    const group = output.groups[0]!;
    expect(group.topicCount).toBe(3);
    // 三个桶顺序固定：simple / medium / complex
    expect(group.buckets.map((b) => b.level)).toEqual(["simple", "medium", "complex"]);
    const simpleBucket = group.buckets.find((b) => b.level === "simple");
    expect(simpleBucket?.topicCount).toBe(2);
    const mediumBucket = group.buckets.find((b) => b.level === "medium");
    expect(mediumBucket?.topicCount).toBe(0);
    expect(mediumBucket?.avgTotalGateFails).toBe(0);
    const complexBucket = group.buckets.find((b) => b.level === "complex");
    expect(complexBucket?.topicCount).toBe(1);
  });

  it("桶内 avgTotalGateFails 均值", () => {
    const env: RuntimeEnv = { agent: "Pi", llm: "GLM-5.2", cwVersion: "0.1.0" };
    const mkSimple = (id: string, fails: number): Topic =>
      makeTopic({
        topicId: id,
        runtimeEnv: env,
        waves: [makeCommittedWave("W1", `f${id}`)],
        gateHistory: Array.from({ length: fails }, (_, i) =>
          makeGateEntry(i + 1, "dev", "medium-git", "fail"),
        ),
      });
    // 2 个 simple topic：0 fail + 2 fail → 均值 1
    const topics = [mkSimple("a", 0), mkSimple("b", 2)];
    const output = computeStatsAll(topics);
    const simpleBucket = output.groups[0]!.buckets.find((b) => b.level === "simple");
    expect(simpleBucket?.topicCount).toBe(2);
    expect(simpleBucket?.avgTotalGateFails).toBe(1);
  });

  it("桶内 avgFirstTryPassRate 均值", () => {
    const env: RuntimeEnv = { agent: "Pi", llm: "GLM-5.2", cwVersion: "0.1.0" };
    // topic A：plan 首次 pass + dev 首次 fail → 1/2 = 0.5
    const topicA = makeTopic({
      topicId: "a",
      runtimeEnv: env,
      waves: [makeCommittedWave("W1", "fa")],
      gateHistory: [
        makeGateEntry(1, "plan", "lite-plan-schema", "pass"),
        makeGateEntry(2, "dev", "medium-git", "fail"),
        makeGateEntry(3, "dev", "medium-git", "pass"),
      ],
    });
    // topic B：无 gateHistory → firstTryPassRate = 1
    const topicB = makeTopic({
      topicId: "b",
      runtimeEnv: env,
      waves: [makeCommittedWave("W1", "fb")],
    });
    const output = computeStatsAll([topicA, topicB]);
    const simpleBucket = output.groups[0]!.buckets.find((b) => b.level === "simple");
    // (0.5 + 1) / 2 = 0.75
    expect(simpleBucket?.avgFirstTryPassRate).toBeCloseTo(0.75);
  });

  it("runtimeEnv 透传到分组（非 unknown 组）", () => {
    const env: RuntimeEnv = { agent: "Pi", llm: "GLM-5.2", cwVersion: "0.1.0" };
    const output = computeStatsAll([makeTopic({ topicId: "t1", runtimeEnv: env })]);
    expect(output.groups[0]!.runtimeEnv).toEqual(env);
  });

  it("分组顺序按首次出现（保持插入序）", () => {
    const envA: RuntimeEnv = { agent: "AgentA", llm: "L1", cwVersion: "0.1.0" };
    const envB: RuntimeEnv = { agent: "AgentB", llm: "L2", cwVersion: "0.1.0" };
    const topics = [
      makeTopic({ topicId: "t2", runtimeEnv: envB }),
      makeTopic({ topicId: "t1", runtimeEnv: envA }),
      makeTopic({ topicId: "t3", runtimeEnv: envB }),
    ];
    const output = computeStatsAll(topics);
    // B 先出现 → B 在前
    expect(output.groups[0]!.agent).toBe("AgentB");
    expect(output.groups[0]!.topicCount).toBe(2);
    expect(output.groups[1]!.agent).toBe("AgentA");
  });
});

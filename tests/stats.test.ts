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
import { computeStats } from "../src/stats.js";
import type { GateHistoryEntry, RuntimeEnv, Topic } from "../src/types.js";

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
  });
});

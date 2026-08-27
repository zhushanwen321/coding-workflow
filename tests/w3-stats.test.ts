/**
 * W3/T3.3：`cw gate stats` 渲染核心验收（requirements UC-6 / AC-6.1-6.2）。
 *
 * 零 mock：手工构造真实 GateEvent 信封（与账本 JSONL 反序列化形态同构）喂
 * 真实 foldGate 投影，断言输出数字与手算 durationMs 分组和一致——不 mock
 * fold、不 mock 事件结构。
 *
 * 用例 → 验收映射：
 *   数字与手算一致 + totalMs 降序           AC-6.1
 *   fail 执行计入、hit/step 事件不计入     AC-6.1（durationStats 口径）
 *   空账本 → 结构化空形态                  AC-6.2
 */
import { describe, expect, it } from "vitest";

import { EMPTY_STATS_PLACEHOLDER, renderStats } from "../src/gate/stats.js";
import type { GateEvent } from "../src/gate/types.js";

// ─── 事件构造（字段全量真实，与 GateCheckRanPayload 契约一致） ───────────────

let seqCounter = 0;

function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

function checkRanEvent(
  check: string,
  durationMs: number,
  result: "pass" | "fail" = "pass",
): GateEvent {
  const seq = nextSeq();
  return {
    seq,
    ts: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    type: "GateCheckRan",
    payload: {
      check,
      baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseRef: "origin/main",
      scope: ["src/"],
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      command: ["npm", "run", "check"],
      runId: `run-${seq}`,
      result,
      exitCode: result === "pass" ? 0 : 1,
      durationMs,
      reportRef: `gate-artifacts/${check}/run-${seq}/report.json`,
      reportSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
  };
}

function cacheHitEvent(check: string): GateEvent {
  return {
    seq: nextSeq(),
    ts: "2026-01-01T00:00:30Z",
    type: "GateCacheHit",
    payload: {
      check,
      baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseRef: "origin/main",
      scope: ["src/"],
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      sourceRunId: "run-source",
      reportRef: `gate-artifacts/${check}/run-hit/report.json`,
      reportSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
  };
}

function pipelineStepEvent(): GateEvent {
  return {
    seq: nextSeq(),
    ts: "2026-01-01T00:00:31Z",
    type: "PipelineStepRan",
    payload: {
      pipeline: ".cw-pipeline.json",
      manifestSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      step: "typecheck",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      runId: "run-step",
      result: "pass",
      viaCache: false,
      durationMs: 999_999,
    },
  };
}

// ─── 用例 ───────────────────────────────────────────────────────────────────

describe("W3/T3.3 renderStats（UC-6 stats 计时聚合）", () => {
  it("AC-6.1: durationMs 分组求和/均值与手算一致，行按 totalMs 降序", () => {
    const events = [
      checkRanEvent("typecheck", 100),
      checkRanEvent("build", 1_000),
      checkRanEvent("typecheck", 300),
      checkRanEvent("lint", 50),
      checkRanEvent("typecheck", 200), // typecheck: 3 runs, totalMs 600, avg 200
      checkRanEvent("build", 400), // build: 2 runs, totalMs 1400, avg 700
    ];

    const output = renderStats(events);
    const lines = output.split("\n");

    expect(lines[0]).toContain("check");
    expect(lines[0]).toContain("runs");
    expect(lines[0]).toContain("totalMs");
    expect(lines[0]).toContain("avgMs");
    // 降序：build(1400) → typecheck(600) → lint(50)
    expect(lines[1]).toMatch(/^build\s+2\s+1400\s+700$/);
    expect(lines[2]).toMatch(/^typecheck\s+3\s+600\s+200$/);
    expect(lines[3]).toMatch(/^lint\s+1\s+50\s+50$/);
  });

  it("AC-6.1 口径: fail 执行计入聚合，GateCacheHit 与 PipelineStepRan 不计入", () => {
    const events = [
      checkRanEvent("typecheck", 500, "fail"), // fail 也入 durationStats（真实执行）
      cacheHitEvent("typecheck"), // hit 无 durationMs，不进聚合
      cacheHitEvent("lint"), // 纯 hit 的 check 不产生行
      pipelineStepEvent(), // step 事件锚不同，不进 check 聚合
    ];

    const output = renderStats(events);
    const lines = output.split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("check");
    expect(lines[1]).toMatch(/^typecheck\s+1\s+500\s+500$/);
    expect(output).not.toContain("lint");
  });

  it("AC-6.2: 空账本输出结构化空形态而非报错", () => {
    expect(renderStats([])).toBe(EMPTY_STATS_PLACEHOLDER);
  });

  it("AC-6.2 同口径: 仅含非 GateCheckRan 事件的账本也是空形态", () => {
    expect(renderStats([cacheHitEvent("typecheck"), pipelineStepEvent()])).toBe(
      EMPTY_STATS_PLACEHOLDER,
    );
  });
});

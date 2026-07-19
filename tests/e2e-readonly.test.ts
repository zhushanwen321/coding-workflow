/**
 * e2e-readonly 测试 — E9（stats / status / list 只读子命令）。
 *
 * 覆盖分支：
 *   E9a: stats 单 topic → StatsOutput 结构
 *   E9b: stats --all 跨 topic 聚合 → StatsAllOutput
 *   E9c: status 不存在的 topicId → exit≠0
 *   E9d: list 空库 → []；非空 → ListEntry 结构
 *
 * 只读子命令不经 dispatch，不触发状态变更、不写 gateHistory。
 *
 * 真实子进程跑 dist/cli.js，独立隔离环境。
 */

import { existsSync, readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createE2eEnv,
  disposeE2eEnv,
  type E2eEnv,
  parseStdout,
  runCli,
  setupToClosed,
  setupToTested,
} from "./helpers/e2e.js";

let e: E2eEnv;
let emptyEnv: E2eEnv; // 专测空库 list/stats --all
let topicId: string;
let closedTopicId: string;
let closedSlug: string;

beforeAll(() => {
  e = createE2eEnv();
  emptyEnv = createE2eEnv();
  // 走到一个有完整 gate 数据的 topic（post_dev_verified 阶段 gate 齐全）
  topicId = setupToTested(e, "e9-stats").topicId;
  // 走到 closed 的 topic（report 需要完整数据）
  const closed = setupToClosed(e, "e9-report");
  closedTopicId = closed.topicId;
  closedSlug = closed.slug;
});

afterAll(() => {
  disposeE2eEnv(e);
  disposeE2eEnv(emptyEnv);
});

// ── E9a: stats 单 topic ─────────────────────────────────────

describe("E9a: stats 单 topic → StatsOutput 结构", () => {
  it("stats --topicId 返回 complexity/efficiency/leverHealth", () => {
    const result = parseStdout(
      runCli(["stats", "--topicId", topicId], e),
    );
    // StatsOutput：topicId + complexity + efficiency + leverHealth
    expect(result.topicId).toBe(topicId);
    expect(result).toHaveProperty("complexity");
    expect(result).toHaveProperty("efficiency");
    expect(result).toHaveProperty("leverHealth");
  });
});

// ── E9b: stats --all 跨 topic 聚合 ───────────────────────────

describe("E9b: stats --all 跨 topic 聚合", () => {
  it("stats --all 返回 groups 数组，含至少 1 个分组", () => {
    const result = parseStdout(runCli(["stats", "--all"], e));
    // StatsAllOutput：{ groups: GroupAgg[] }
    const groups = result.groups as unknown[];
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThan(0);
  });

  it("空库 stats --all → groups 空数组（不报错）", () => {
    const result = parseStdout(runCli(["stats", "--all"], emptyEnv));
    const groups = result.groups as unknown[];
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBe(0);
  });
});

// ── E9c: status 不存在的 topicId ────────────────────────────

describe("E9c: status 不存在的 topicId → exit≠0", () => {
  it("不存在的 topicId → exit≠0, stderr 含 topic not found", () => {
    const result = runCli(["status", "--topicId", "cw-9999-01-01-nope"], e);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("topic not found");
  });
});

// ── E9d: list 空库 vs 非空 ───────────────────────────────────

describe("E9d: list 空库 → []；非空 → ListEntry 结构", () => {
  it("空库 list → []", () => {
    const result = parseStdout(runCli(["list"], emptyEnv));
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown as unknown[]).length).toBe(0);
  });

  it("非空 list → 数组含 ListEntry（topicId/slug/status/createdAt）", () => {
    const result = parseStdout(runCli(["list"], e));
    expect(Array.isArray(result)).toBe(true);
    const entries = result as unknown as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    const first = entries[0]!;
    expect(first.topicId).toBeDefined();
    expect(first.slug).toBeDefined();
    expect(first.status).toBeDefined();
    expect(first.createdAt).toBeDefined();
  });
});

// ── E9e: report 生成 HTML 报告 ───────────────────────────────

describe("E9e: report 生成可视化 HTML", () => {
  it("report --topicId → 返回 reportPath，HTML 文件存在且含关键内容", () => {
    const result = parseStdout(
      // --no-open：测试环境不弹窗（report 默认会 open）
      runCli(["report", "--topicId", closedTopicId, "--no-open"], e),
    );
    expect(result.topicId).toBe(closedTopicId);
    expect(result.reportPath).toBeDefined();
    expect(typeof result.reportPath).toBe("string");

    const reportPath = result.reportPath as string;
    expect(existsSync(reportPath)).toBe(true);

    // 读 HTML 内容，验证关键字段已注入
    const html = readFileSync(reportPath, "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(closedSlug);
    expect(html).toContain("Gate Execution Trail");
    expect(html).toContain("Wave Changes");
    expect(html).toContain("Test Cases");
    expect(html).toContain("Retrospect");
    // 暗色主题验证
    expect(html).toContain("--bg:");
  });

  it("report 不存在的 topicId → exit≠0, stderr 含 topic not found", () => {
    const result = runCli(["report", "--topicId", "cw-9999-01-01-nope"], e);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("topic not found");
  });

  it("report 缺 --topicId → exit≠0", () => {
    const result = runCli(["report"], e);
    expect(result.exitCode).not.toBe(0);
  });

  // FR-9: report 默认自动 open HTML；测试 helper runCli 全局注入 CW_NO_OPEN=1 禁用弹窗。
  // 这里验证：无论 --no-open flag 还是 CW_NO_OPEN env，都不阻断主流程，stdout 正常返回 reportPath。
  it("report --no-open → 不弹窗，stdout 正常返回 reportPath", () => {
    const result = parseStdout(
      runCli(["report", "--topicId", closedTopicId, "--no-open"], e),
    );
    expect(result.reportPath).toBeDefined();
    expect(existsSync(result.reportPath as string)).toBe(true);
  });

  // runCli 默认注入 CW_NO_OPEN=1，等价于「默认不弹窗」场景，验证不挂起 + 路径返回。
  it("report 默认（CW_NO_OPEN=1 via helper）→ 不挂起，stdout 正常返回 reportPath", () => {
    const result = parseStdout(
      runCli(["report", "--topicId", closedTopicId], e),
    );
    expect(result.reportPath).toBeDefined();
    expect(existsSync(result.reportPath as string)).toBe(true);
  });
});

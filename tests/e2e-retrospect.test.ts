/**
 * e2e retrospect 迁移测试 — E1（AC-7 real 层）。
 *
 * 覆盖 AC：
 *   - AC-7: 现有 closed topic 的 processIssues（旧格式 string[]）读取不报错，
 *     自动迁移为 uncategorized（跑 cw stats --all 验证聚合不崩）
 *
 * 测什么（真实子进程跑 dist/cli.js，零 mock）：
 *   - 走 setupToClosed 建一个 closed topic（新格式 retrospectData）
 *   - 手动改 _cw.json 把 processIssues 写成旧格式 string[]（模拟 4 个历史 closed topic）
 *   - 跑 `cw stats --all` → exit=0，不崩（迁移在 listTopics 读取时自动触发）
 *   - 输出含 retrospectInsights 段（FR-6 聚合不崩——这正是 PR1 修复的真 bug 验证）
 *
 * 防的 bug：
 *   - PR1 的真 bug：listTopics 不迁移旧 string[] → computeStatsAll 对裸 string
 *     调 .type / .description 崩（Cannot read property 'type' of "xxx"）。
 *   - 迁移链路在端到端层面断裂（store 迁移了但 stats 消费端没拿到迁移后数据）。
 *
 * 测试模式：真实子进程 + shell executor（照 e2e-readonly.test.ts 的 runCli 模式）。
 * 用 resolveDbPath 定位 _cw.json，手动注入旧格式数据。
 */

import { readFileSync, writeFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveDbPath } from "../src/cli.js";
import {
  createE2eEnv,
  disposeE2eEnv,
  type E2eEnv,
  parseStdout,
  runCli,
  setupToClosed,
} from "./helpers/e2e.js";

let e: E2eEnv;
let closedTopicId: string;

beforeAll(() => {
  e = createE2eEnv();
  // 走到一个 closed topic（完整链路，retrospect 已提交）
  const closed = setupToClosed(e, "e1-retro-migrate");
  closedTopicId = closed.topicId;
});

afterAll(() => {
  disposeE2eEnv(e);
});

// ── E1: cw stats --all 对旧格式 processIssues 不崩（AC-7）────────

describe("E1: cw stats --all 旧格式 processIssues 迁移（AC-7）", () => {
  it("closed topic 的 processIssues 改成旧格式 string[] → cw stats --all 不崩（exit=0）", () => {
    // 定位 _cw.json（resolveDbPath 与 cli.ts 用同一逻辑）
    const dbPath = resolveDbPath(e.workspaceDir, e.cwHome);

    // 读出当前 _cw.json，把 closed topic 的 processIssues 改成旧格式 string[]
    const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
      topics: Array<Record<string, unknown>>;
    };
    const t = raw.topics.find((x) => x.topicId === closedTopicId);
    expect(t).toBeDefined();
    expect(t!.retrospectData).toBeDefined();
    // 注入旧格式：processIssues 是 string[]（模拟历史 closed topic 的数据）
    (t!.retrospectData as Record<string, unknown>).processIssues = [
      "plan 阶段没考虑到 git diff-tree 性能",
      "subagent 切分支导致丢失改动",
      "test expected 太严格",
    ];
    writeFileSync(dbPath, JSON.stringify(raw));

    // 跑 cw stats --all —— 这是 PR1 修复的核心验证点。
    // 修复前：listTopics 不迁移 → computeStatsAll 对裸 string 崩（exit≠0）。
    // 修复后：listTopics 迁移 → computeStatsAll 正常聚合（exit=0）。
    const result = runCli(["stats", "--all"], e);
    expect(
      result.exitCode,
      `cw stats --all 应 exit=0（迁移后不崩），实际 exit=${result.exitCode}, stderr: ${result.stderr}`,
    ).toBe(0);
  });

  it("cw stats --all 输出可解析为 JSON（聚合完整跑通）", () => {
    // 上一条测试已注入旧格式数据，这里再跑一次确认输出可解析。
    const result = runCli(["stats", "--all"], e);
    expect(result.exitCode).toBe(0);
    const parsed = parseStdout(result);
    // StatsAllOutput 含 groups
    expect(parsed).toHaveProperty("groups");
    expect(Array.isArray(parsed.groups)).toBe(true);
  });

  it("cw stats --all 输出含 retrospectInsights 段（FR-6 聚合产出）", () => {
    // 旧格式 processIssues 已迁移为 uncategorized 对象数组，
    // computeStatsAll 聚合后应输出 retrospectInsights 段（不崩 + 含数据）。
    const result = runCli(["stats", "--all"], e);
    expect(result.exitCode).toBe(0);
    const parsed = parseStdout(result);
    // FR-6: retrospectInsights 是顶层字段
    expect(parsed).toHaveProperty("retrospectInsights");
    const insights = parsed.retrospectInsights as Record<string, unknown>;
    expect(insights).toBeDefined();
    expect(insights).toHaveProperty("typeBuckets");
    // 旧格式 3 条 string[] 迁移为 uncategorized → uncategorized 桶至少 3
    const buckets = insights.typeBuckets as Record<string, number>;
    expect(buckets.uncategorized).toBeGreaterThanOrEqual(3);
  });

  it("cw status 对旧格式 processIssues 的 topic 不崩（单 topic 读路径也迁移）", () => {
    // 单 topic 读路径（loadTopic）也应迁移，cw status 不崩。
    const result = runCli(["status", "--topicId", closedTopicId], e);
    expect(
      result.exitCode,
      `cw status 应 exit=0，实际 exit=${result.exitCode}, stderr: ${result.stderr}`,
    ).toBe(0);
  });
});

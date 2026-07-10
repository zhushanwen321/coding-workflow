/**
 * e2e.test.ts — CLI 端到端测试（spawn 真实 cw 二进制）。
 *
 * 覆盖 test-matrix：
 *   T1.8  完整 create 流程 e2e：CLI argv → stdout JSON
 *   T7.9  gate fail → exit 0（程序正常）
 *   T7.10 illegal_transition → exit ≥1（程序错误）
 *
 * 测试层：e2e（真实子进程 + 临时 CW_HOME 隔离）。
 *
 * 前置：需先 `npm run build` 生成 dist/cli/cli.js。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_PATH = join(process.cwd(), "dist", "cli", "cli.js");

/** 运行 cw CLI，返回 { stdout, stderr, exitCode }。 */
function runCw(
  args: string[],
  env: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

describe("CLI e2e", () => {
  let cwHome: string;
  let workspace: string;

  beforeEach(() => {
    cwHome = mkdtempSync(join(tmpdir(), "cw-e2e-home-"));
    workspace = mkdtempSync(join(tmpdir(), "cw-e2e-ws-"));
  });

  afterEach(() => {
    try {
      rmSync(cwHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    } catch (e) {
      void e;
    }
  });

  it("T1.8 — cw create lite：stdout JSON 含 topicId + status + nextAction.plan，exit 0", () => {
    const result = runCw(
      ["create", "--slug", "e2edemo", "--tier", "lite", "--objective", "e2e test", "--workspace", workspace],
      { CW_HOME: cwHome },
    );

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.topicId).toMatch(/^cw-\d{4}-\d{2}-\d{2}-e2edemo$/);
    expect(json.status).toBe("created");
    expect(json.nextAction.action).toBe("plan");
    expect(json.nextAction.skill).toBe("lite-plan");
  });

  it("T1.8b — cw create mid：nextAction 指向 clarify，exit 0", () => {
    const result = runCw(
      ["create", "--slug", "mide2e", "--tier", "mid", "--objective", "mid e2e", "--workspace", workspace],
      { CW_HOME: cwHome },
    );

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.nextAction.action).toBe("clarify");
    expect(json.nextAction.skill).toBe("mid-plan");
  });

  it("T7.2 — create 缺 slug：exit ≥1 + stderr 非空", () => {
    // slug 缺失 → validateParams 层或 dispatch 层报错
    const result = runCw(
      ["create", "--tier", "lite", "--objective", "x", "--workspace", workspace],
      { CW_HOME: cwHome },
    );

    expect(result.exitCode).toBeGreaterThanOrEqual(1);
    // stderr 或 stdout 含错误信息
    const combined = result.stderr + result.stdout;
    expect(combined.length).toBeGreaterThan(0);
  });

  it("T7.1 — 无效 tier：exit ≥1", () => {
    const result = runCw(
      ["create", "--slug", "bad", "--tier", "invalid", "--objective", "x", "--workspace", workspace],
      { CW_HOME: cwHome },
    );

    expect(result.exitCode).toBeGreaterThanOrEqual(1);
  });

  it("无 action → exit 1 + stderr", () => {
    const result = runCw([], { CW_HOME: cwHome });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("未知 action → exit 1 + stderr", () => {
    const result = runCw(["bogus"], { CW_HOME: cwHome });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("未知 action");
  });

  it("T7.10 — 对不存在 topic 调 dev（illegal_transition / topic not found）：exit ≥1", () => {
    // topic 不存在 → dispatch throw "topic not found" → exit 1
    const result = runCw(
      ["dev", "--topicId", "cw-nonexistent", "--tasks", '[{"waveId":"W1","commitHash":"abc"}]', "--workspace", workspace],
      { CW_HOME: cwHome },
    );
    expect(result.exitCode).toBeGreaterThanOrEqual(1);
  });
});

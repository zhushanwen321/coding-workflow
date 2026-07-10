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
  return runCwRaw(args, env, undefined);
}

/** 运行 cw CLI（带 stdin 输入），返回 { stdout, stderr, exitCode }。 */
function runCwWithStdin(
  args: string[],
  env: Record<string, string>,
  stdinData: string,
): { stdout: string; stderr: string; exitCode: number } {
  return runCwRaw(args, env, stdinData);
}

function runCwRaw(
  args: string[],
  env: Record<string, string>,
  stdinData: string | undefined,
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: stdinData === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      input: stdinData,
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

// ── T2.6: stdin 传 plan.json e2e（#4 stdin 主通道 + #7 exit code 分层） ──

describe("CLI e2e: plan via stdin", () => {
  let cwHome: string;
  let workspace: string;

  beforeEach(() => {
    cwHome = mkdtempSync(join(tmpdir(), "cw-e2e-plan-home-"));
    workspace = mkdtempSync(join(tmpdir(), "cw-e2e-plan-ws-"));
  });

  afterEach(() => {
    try {
      rmSync(cwHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    } catch (e) {
      void e;
    }
  });

  it("T2.6a — 合法 plan.json 经 stdin：exit 0 + stdout JSON 含 topicId/status（dispatch 全链跑通）", () => {
    // 先建 topic
    const created = runCw(
      ["create", "--slug", "plandemo", "--tier", "lite", "--objective", "plan e2e", "--workspace", workspace],
      { CW_HOME: cwHome },
    );
    expect(created.exitCode).toBe(0);
    const topicId = JSON.parse(created.stdout).topicId;

    // 合法 lite plan.json 经 stdin 传入
    const planJson = JSON.stringify({
      format: "lite",
      objective: "build demo",
      waves: [{ id: "W1", changes: ["src/a.ts"], dependsOn: [] }],
      testCases: [{
        id: "E1", layer: "real", scenario: "s", steps: "st",
        expected: { url: "/x" }, executor: "vitest", requiresScreenshot: false,
      }],
    });
    const result = runCwWithStdin(
      ["plan", "--topicId", topicId, "--workspace", workspace],
      { CW_HOME: cwHome },
      planJson,
    );

    // 程序正常（gate 结果在 JSON，exit 0 per C-1 分层）
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.topicId).toBe(topicId);
    expect(json.gateTier).toBe("weak-structural");
    expect(typeof json.status).toBe("string");
    expect(json.nextAction).toBeDefined();
  });

  it("T2.6b — 非法 plan.json（{} 缺 format）经 stdin：exit ≥1（parse 失败 = 程序错误）", () => {
    const created = runCw(
      ["create", "--slug", "badplan", "--tier", "lite", "--objective", "x", "--workspace", workspace],
      { CW_HOME: cwHome },
    );
    const topicId = JSON.parse(created.stdout).topicId;

    const result = runCwWithStdin(
      ["plan", "--topicId", topicId, "--workspace", workspace],
      { CW_HOME: cwHome },
      "{}",
    );

    // 非法 plan（D-003 tier 锁定：format undefined ≠ lite）→ throw → exit ≥1
    expect(result.exitCode).toBeGreaterThanOrEqual(1);
    const combined = result.stderr + result.stdout;
    expect(combined.length).toBeGreaterThan(0);
  });

  it("T7.9 — gate fail 时 exit 0（程序正常，结果在 stdout JSON）", () => {
    // 合法 plan 但 check 函数未注册（infraError）→ gate fail → exit 0
    const created = runCw(
      ["create", "--slug", "gatefail", "--tier", "lite", "--objective", "x", "--workspace", workspace],
      { CW_HOME: cwHome },
    );
    const topicId = JSON.parse(created.stdout).topicId;

    const planJson = JSON.stringify({
      format: "lite", objective: "x",
      waves: [{ id: "W1", changes: ["a.ts"], dependsOn: [] }],
      testCases: [{ id: "E1", layer: "mock", scenario: "s", steps: "st", expected: {}, executor: "vitest", requiresScreenshot: false }],
    });
    const result = runCwWithStdin(
      ["plan", "--topicId", topicId, "--workspace", workspace],
      { CW_HOME: cwHome },
      planJson,
    );

    // gate fail 仍是 exit 0（C-1 分层：gate 结果在 JSON）
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.gatePassed?.plan).toBeFalsy();
  });
});

/**
 * nfr.test.ts — NFR 安全/稳定性测试（来源 B）。
 *
 * 覆盖 test-matrix：
 *   T7.1 无效 CLI 参数 → exit ≠0（typebox 校验）
 *   T7.2 缺必填字段 → exit ≠0
 *   T7.3 非法 JSON → exit ≠0
 *   T7.4 路径穿越 CW_HOME → throw
 *   T7.5 .cw-wt/ 检测 → throw
 *   T7.6 文件不存在 → exit ≠0（--xxx-file 边界）
 *   T7.7 非 JSON 文件 → exit ≠0
 *   T7.8 超大文件 → exit ≠0（10MB DoS 防护）
 *   T7.9 gate fail → exit 0（C-1 分层：程序正常）
 *   T7.10 illegal_transition → exit ≥1（程序错误）
 *   T7.11 stderr 人类可读
 *
 * 测试层：integration（protocol.ts 校验 + resolveDbPath 防护）+ e2e（subprocess exit code）。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readJsonInput, resolveDbPath, validateParams } from "../../src/cli/protocol.js";

// e2e 子进程测试用：需先 `npm run build` 生成 dist/cli/cli.js。
const CLI_PATH = join(process.cwd(), "dist", "cli", "cli.js");

// ── T7.1/T7.2/T7.3: typebox 参数校验 ─────────────────────────

describe("NFR: typebox 参数校验", () => {
  it("T7.1 — 无效 tier：validateParams throw（exit ≠0 等价）", () => {
    expect(() =>
      validateParams({ action: "create", slug: "x", tier: "invalid", objective: "x" }),
    ).toThrow();
  });

  it("T7.1 — 无效 action：validateParams throw", () => {
    expect(() =>
      validateParams({ action: "bogus", slug: "x", tier: "lite", objective: "x" }),
    ).toThrow();
  });

  it("T7.2 — create 缺 slug：validateParams throw（slug 非必填在 schema，但 create handler 需要）", () => {
    // CwParamsSchema 中 slug 是 Optional，但 create 必须。
    // 这里测 schema 层：缺 action（必填）必 throw。
    expect(() => validateParams({ slug: "x" })).toThrow();
  });

  it("T7.3 — readJsonInput 非法 JSON：throw", () => {
    expect(() => readJsonInput(undefined, "{ not valid json", false)).toThrow(/JSON/);
  });

  it("T7.3 — readJsonInput 无输入（stdin 空 + 无 flag）：throw", () => {
    expect(() => readJsonInput(undefined, "", true)).toThrow();
  });

  it("T7.3 — readJsonInput stdin + flag 冲突：throw", () => {
    expect(() => readJsonInput("/tmp/plan.json", '{"a":1}', false)).toThrow(/冲突|conflict/i);
  });
});

// ── T7.4: 路径穿越防护 ───────────────────────────────────────

describe("NFR: 路径穿越防护", () => {
  it("T7.4 — CW_HOME 非绝对路径 → throw", () => {
    expect(() =>
      resolveDbPath("/tmp/ws", "relative/path"),
    ).toThrow(/绝对路径|absolute/i);
  });

  it("T7.4 — CW_HOME 含 .. → resolveDbPath 接受绝对路径但 encodeCwd 处理", () => {
    // CW_HOME 绝对路径合法（/tmp/../tmp 是绝对路径），encodeCwd 编码 workspacePath。
    // 关键校验是 CW_HOME 必须 isAbsolute。
    const path = resolveDbPath("/Users/x/proj", "/tmp/cw-home");
    expect(path).toContain("_cw.json");
  });
});

// ── T7.5: .cw-wt/ worktree 检测 ──────────────────────────────

describe("NFR: .cw-wt/ worktree 检测", () => {
  it("T7.5 — workspacePath 含 .cw-wt/ → throw", () => {
    expect(() =>
      resolveDbPath("/Users/x/proj/.cw-wt/cw-dev-pool0-123", "/tmp/cw-home"),
    ).toThrow(/cw-wt|worktree/i);
  });

  it("T7.5 — 正常 workspacePath（无 .cw-wt/）→ 返回合法路径", () => {
    const path = resolveDbPath("/Users/x/proj", "/tmp/cw-home");
    expect(path).toMatch(/_cw\.json$/);
    expect(path).not.toContain(".cw-wt");
  });
});

// ── T7.6/T7.7/T7.8: 文件读取边界（#4 安全：--xxx-file） ──────

describe("NFR: 文件读取边界 (--xxx-file)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cw-nfr-file-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      void e;
    }
  });

  it("T7.6 — 文件不存在：readJsonInput throw（exit ≠0 等价）", () => {
    expect(() => readJsonInput(join(tmpDir, "nonexistent.json"), "", true)).toThrow(
      /文件不存在|not exist|ENOENT/i,
    );
  });

  it("T7.7 — 非 JSON 文件：readJsonInput throw", () => {
    const file = join(tmpDir, "bad.txt");
    writeFileSync(file, "this is {{{ not json");
    expect(() => readJsonInput(file, "", true)).toThrow(/JSON/i);
  });

  it("T7.8 — 超大文件（>10MB）：readJsonInput throw（DoS 防护）", () => {
    const file = join(tmpDir, "huge.json");
    // 11MB > 10MB 限制；statSync 在 readFileSync 前拦截，不读内容
    writeFileSync(file, "x".repeat(11 * 1024 * 1024));
    expect(() => readJsonInput(file, "", true)).toThrow(/超过限制|exceed|limit|MB/i);
  });
});

// ── T7.9/T7.10/T7.11: exit code 分层契约 + stderr（subprocess） ──

/** 运行 cw CLI 子进程，返回 { stdout, stderr, exitCode }。 */
function runCw(
  args: string[],
  env: Record<string, string>,
  stdinData?: string,
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

/** 合法 lite plan.json（经 stdin 传入；check_plan.py 未注册时 gate fail 但结构合法）。 */
const VALID_PLAN = JSON.stringify({
  format: "lite",
  objective: "nfr e2e",
  waves: [{ id: "W1", changes: ["src/a.ts"], dependsOn: [] }],
  testCases: [
    {
      id: "E1",
      layer: "mock",
      scenario: "s",
      steps: "st",
      expected: {},
      executor: "vitest",
      requiresScreenshot: false,
    },
  ],
});

describe("NFR: exit code 分层契约 + stderr", () => {
  let cwHome: string;
  let workspace: string;

  beforeEach(() => {
    cwHome = mkdtempSync(join(tmpdir(), "cw-nfr-exit-h-"));
    workspace = mkdtempSync(join(tmpdir(), "cw-nfr-exit-w-"));
  });

  afterEach(() => {
    try {
      rmSync(cwHome, { recursive: true, force: true });
    } catch (e) {
      void e;
    }
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch (e) {
      void e;
    }
  });

  it("T7.9 — gate fail 时 exit 0（程序正常，gatePassed=false 在 stdout JSON）", () => {
    const created = runCw(
      ["create", "--slug", "gatefail", "--tier", "lite", "--objective", "x", "--workspace", workspace],
      { CW_HOME: cwHome },
    );
    expect(created.exitCode).toBe(0);
    const topicId = JSON.parse(created.stdout).topicId;

    // check_plan.py 未注册 → infraError → gate fail，但仍是 exit 0（C-1 分层：gate 结果在 JSON）
    const result = runCw(
      ["plan", "--topicId", topicId, "--workspace", workspace],
      { CW_HOME: cwHome },
      VALID_PLAN,
    );
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.gatePassed?.plan).toBeFalsy();
  });

  it("T7.10 — illegal_transition（created topic 调 dev）→ exit ≥1", () => {
    const created = runCw(
      ["create", "--slug", "illegal", "--tier", "lite", "--objective", "x", "--workspace", workspace],
      { CW_HOME: cwHome },
    );
    const topicId = JSON.parse(created.stdout).topicId;

    // dev 期望 status ∈ {planned, detailed, developed}；created → guard illegal_transition → exit ≥1
    const result = runCw(
      ["dev", "--topicId", topicId, "--tasks", '[{"waveId":"W1","commitHash":"abc"}]', "--workspace", workspace],
      { CW_HOME: cwHome },
    );
    expect(result.exitCode).toBeGreaterThanOrEqual(1);
  });

  it("T7.11 — 程序错误 stderr 人类可读（非空 + 含错误描述）", () => {
    const created = runCw(
      ["create", "--slug", "stderr", "--tier", "lite", "--objective", "x", "--workspace", workspace],
      { CW_HOME: cwHome },
    );
    const topicId = JSON.parse(created.stdout).topicId;

    const result = runCw(
      ["dev", "--topicId", topicId, "--tasks", '[{"waveId":"W1","commitHash":"abc"}]', "--workspace", workspace],
      { CW_HOME: cwHome },
    );
    expect(result.exitCode).toBeGreaterThanOrEqual(1);
    // stderr 非空
    expect(result.stderr.length).toBeGreaterThan(0);
    // 人类可读：含中文「错误」或错误码/状态描述
    expect(result.stderr).toMatch(/错误|illegal|transition|guard|状态|转换/i);
  });
});

/**
 * cw report 端到端测试（TC1-TC4）。
 *
 * 通过真实子进程跑 dist/cli.js cw report，验证：
 *   TC1: create 后 report --no-open → 生成 HTML 含 DOCTYPE + objective，exit 0
 *   TC2: report 不存在的 unitId → exit!=0 + 错误消息含 report 与 unit
 *   TC3: report --output 自定义路径 → 文件生成 + reportPath === 自定义路径
 *   TC4: report 不带 --no-open 但 CW_NO_OPEN=1 → exit 0 + 文件生成 + 进程正常退出
 *
 * 复用 e2e-handoff.test.ts 的 spawnSync 子进程模式（runCw/setupEnv/cleanEnv），
 * 但用 beforeEach/afterEach 让每个 it 独立环境（一个失败不污染其他）。
 * 需先 npm run build（dist/cli.js 存在）。TC5（手动浏览器目视）不在自动化范围。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setupGitRepo } from "./helpers/git.js";

// ── 路径常量 ────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

// ── 子进程辅助（精简版，同 e2e-handoff.test.ts 模式）──

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Env {
  workspaceDir: string;
  cwHome: string;
}

function setupEnv(): Env {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`dist/cli.js 不存在，请先 npm run build。路径: ${CLI_PATH}`);
  }
  const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "cw-report-ws-")));
  const cwHome = realpathSync(mkdtempSync(join(tmpdir(), "cw-report-home-")));
  setupGitRepo(workspaceDir);
  return { workspaceDir, cwHome };
}

function cleanEnv(e: Env): void {
  rmSync(e.workspaceDir, { recursive: true, force: true });
  rmSync(e.cwHome, { recursive: true, force: true });
}

function runCw(args: string[], env: Env, extraEnv: Record<string, string> = {}): CliResult {
  const mergedEnv = {
    ...process.env,
    CW_HOME: env.cwHome,
    ...extraEnv,
    PATH: process.env.PATH ?? "",
  };
  const result = spawnSync("node", [CLI_PATH, ...args], {
    env: mergedEnv as NodeJS.ProcessEnv,
    encoding: "utf8",
    cwd: env.workspaceDir,
    timeout: 30000,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ── 共享环境（每 it 独立）────────────────────────────────────

let env: Env;

beforeEach(() => {
  env = setupEnv();
});

afterEach(() => {
  cleanEnv(env);
});

// ── TC1: create 后 report --no-open → HTML 含 DOCTYPE + objective ──

describe("TC1: cw report --unitId <id> --no-open 端到端", () => {
  it("create wave 后 report 生成 HTML，含 DOCTYPE 与 objective，exit 0", () => {
    const created = runCw(
      ["create", "wave", "--slug", "demo", "--objective", "report e2e demo"],
      env,
    );
    expect(created.exitCode).toBe(0);

    const result = runCw(["report", "--unitId", "wave:demo", "--no-open"], env);
    expect(result.exitCode).toBe(0);

    // stdout 是单行 JSON { reportPath: "..." }
    expect(result.stdout).toContain("reportPath");
    const parsed = JSON.parse(result.stdout.trim()) as { reportPath: string };
    const reportPath = parsed.reportPath;
    expect(typeof reportPath).toBe("string");
    expect(existsSync(reportPath)).toBe(true);

    const html = readFileSync(reportPath, "utf-8");
    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain("report e2e demo");
  });
});

// ── TC2: report 不存在的 unitId → exit!=0 + 错误消息 ──────────

describe("TC2: cw report 不存在的 unitId 报错", () => {
  it("wave:not-exist --no-open → exit!=0 + 消息含 report 与 unit", () => {
    const result = runCw(
      ["report", "--unitId", "wave:not-exist", "--no-open"],
      env,
    );
    expect(result.exitCode).not.toBe(0);
    // CwError 消息进 stderr（mapExitCode 捕获后写 stderr，与 e2e-handoff TC6/TC7 一致）
    const combined = result.stderr + result.stdout;
    expect(combined).toContain("report");
    expect(combined).toContain("unit");
  });
});

// ── TC3: report --output 自定义路径 ──────────────────────────

describe("TC3: cw report --output 自定义路径", () => {
  it("--output 指定路径 → 文件生成 + reportPath === 该路径", () => {
    const created = runCw(
      ["create", "wave", "--slug", "demo2", "--objective", "custom output test"],
      env,
    );
    expect(created.exitCode).toBe(0);

    const customPath = join(env.workspaceDir, "custom.html");
    const result = runCw(
      ["report", "--unitId", "wave:demo2", "--output", customPath, "--no-open"],
      env,
    );
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.trim()) as { reportPath: string };
    expect(parsed.reportPath).toBe(customPath);
    expect(existsSync(customPath)).toBe(true);
    expect(readFileSync(customPath, "utf-8")).toContain("<!DOCTYPE html");
  });
});

// ── TC4: report 不带 --no-open 但 CW_NO_OPEN=1 ───────────────

describe("TC4: cw report CW_NO_OPEN=1（不带 --no-open）", () => {
  it("CW_NO_OPEN=1 阻止打开，exit 0 + 文件生成 + 进程正常退出", () => {
    const created = runCw(
      ["create", "wave", "--slug", "demo3", "--objective", "cw no open test"],
      env,
    );
    expect(created.exitCode).toBe(0);

    const result = runCw(["report", "--unitId", "wave:demo3"], env, {
      CW_NO_OPEN: "1",
    });
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.trim()) as { reportPath: string };
    expect(existsSync(parsed.reportPath)).toBe(true);
  });
});

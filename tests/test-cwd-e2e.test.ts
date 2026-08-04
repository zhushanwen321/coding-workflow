/**
 * v1 testCwd e2e 回归测试（#4，T1.12 / AC-3.4）。
 *
 * 背景：retrospect 数据多处提及「testRunner --testCwd 未生效，monorepo 根目录跑全量」，
 * 但 3 路 review + 实机验证（marker 文件验证 spawnSync cwd）证明当前链完整：
 *   cli.ts --testCwd flag → constructCwDeps resolvedTestCwd → runnerCwd → spawnSync cwd。
 * 本测试用 marker 脚本把 testRunner 子进程的真实 process.cwd() 落盘，
 * 断言 `cw test --testCwd <dir>` 时实际运行目录 = <dir>——锁定行为防回归。
 *
 * 真实子进程跑 dist/cli.js（需先 npm run build），复用 cli.test.ts 的子进程模式。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  makeValidContract,
  makeValidDesignReviewJudgment,
  makeValidFile,
  makeValidTask,
  makeValidTestCase,
  makeValidTestJudgment,
} from "./helpers/env.js";
import { setupGitRepo } from "./helpers/git.js";

// ── 路径常量 ────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

// ── 子进程辅助（同 cli.test.ts 模式） ───────────────────────

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CwCliEnv {
  workspaceDir: string;
  cwHome: string;
  env: Record<string, string>;
  commitHash: string;
}

function runCwCli(
  args: string[],
  env: CwCliEnv,
  options: { input?: string; cwd?: string } = {},
): CliResult {
  const mergedEnv = {
    ...process.env,
    ...env.env,
    PATH: process.env.PATH ?? "",
  };
  const result = spawnSync("node", [CLI_PATH, ...args], {
    env: mergedEnv as NodeJS.ProcessEnv,
    encoding: "utf8",
    cwd: options.cwd ?? env.workspaceDir,
    input: options.input,
    timeout: 30000,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function createCwCliEnv(): CwCliEnv {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`dist/cli.js 不存在，请先 npm run build。路径: ${CLI_PATH}`);
  }
  const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "cw-testcwd-ws-")));
  const cwHome = realpathSync(mkdtempSync(join(tmpdir(), "cw-testcwd-home-")));
  const env = { CW_HOME: cwHome };
  const commitHash = setupGitRepo(workspaceDir);
  return { workspaceDir, cwHome, env, commitHash };
}

function disposeCwCliEnv(e: CwCliEnv): void {
  rmSync(e.workspaceDir, { recursive: true, force: true });
  rmSync(e.cwHome, { recursive: true, force: true });
}

/** 把 input JSON 写到 workspaceDir/.cw/<slug>/<action>.json 并返回文件路径。 */
function writeInputJson(e: CwCliEnv, slug: string, action: string, input: unknown): string {
  const dir = join(e.workspaceDir, ".cw", slug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${action}.json`);
  writeFileSync(file, JSON.stringify(input), "utf8");
  return file;
}

// ── 共享测试环境 ────────────────────────────────────────────

let e: CwCliEnv;

beforeAll(() => {
  e = createCwCliEnv();
});

afterAll(() => {
  disposeCwCliEnv(e);
});

// ── T1.12：--testCwd 真实运行目录 ────────────────────────────

describe("W8: cw test --testCwd 真实运行目录（#4，T1.12）", () => {
  it("testRunner 子进程实际 cwd = --testCwd 指定目录（marker 文件验证）", () => {
    const slug = "tcwd";
    const unitId = `wave:${slug}`;
    const testCwdDir = join(e.workspaceDir, "packages", "renderer");
    mkdirSync(testCwdDir, { recursive: true });

    // marker 脚本：把 spawnSync 的真实 cwd 落盘 + 打印 vitest 风格计数（1 passed，exit 0）
    const marker = [
      'const fs = require("fs");',
      'const path = require("path");',
      'fs.writeFileSync(path.join(process.cwd(), "cwd-marker.txt"), process.cwd());',
      'console.log("Tests  1 passed");',
      "process.exit(0);",
    ].join("\n");
    writeFileSync(join(testCwdDir, "marker.js"), marker, "utf8");

    // 配置 testRunner.command（相对于 runnerCwd 解析，marker.js 在 testCwdDir 内）
    writeFileSync(
      join(e.workspaceDir, "cw.config.json"),
      JSON.stringify({ testRunner: { command: "node marker.js" } }),
      "utf8",
    );

    // ── 1. 真实 CLI 全链推进到 executing ──
    const created = runCwCli(
      ["create", "wave", "--slug", slug, "--objective", "testCwd e2e"],
      e,
    );
    expect(created.exitCode, created.stderr).toBe(0);

    const clarifyInput = writeInputJson(e, slug, "clarify", { clarifications: [] });
    const clarified = runCwCli(
      ["clarify", "--unitId", unitId, "--input", clarifyInput],
      e,
    );
    expect(clarified.exitCode, clarified.stderr).toBe(0);

    const planInput = writeInputJson(e, slug, "plan", {
      testCases: [makeValidTestCase("TC1")],
      tasks: [makeValidTask("TK1")],
      files: [makeValidFile("F1")],
      contracts: [makeValidContract("C1")],
      // per-wave 设计：testCommand 决定跑什么，--testCwd 决定在哪跑。
      // marker 脚本写 cwd 落盘，验证 spawnSync 的 cwd = --testCwd 指定目录。
      testCommand: "node marker.js",
    });
    const planned = runCwCli(
      ["plan", "--unitId", unitId, "--input", planInput],
      e,
    );
    expect(planned.exitCode, planned.stderr).toBe(0);

    const drInput = writeInputJson(e, slug, "design-review", {
      designReviewJudgment: makeValidDesignReviewJudgment(),
    });
    const dr = runCwCli(
      ["design-review", "--unitId", unitId, "--input", drInput],
      e,
    );
    expect(dr.exitCode, dr.stderr).toBe(0);

    const executed = runCwCli(
      ["execute", "--unitId", unitId, "--commitHash", e.commitHash],
      e,
    );
    expect(executed.exitCode, executed.stderr).toBe(0);

    // ── 2. 关键断言：test 用 --testCwd 指定 monorepo 子包目录 ──
    const testInput = writeInputJson(e, slug, "test", {
      testJudgment: makeValidTestJudgment(),
    });
    const tested = runCwCli(
      ["test", "--unitId", unitId, "--testCwd", "packages/renderer", "--input", testInput],
      e,
    );
    expect(tested.exitCode, tested.stderr).toBe(0);

    // 结果 status=tested（gate 全过）
    const result = JSON.parse(tested.stdout.trim()) as Record<string, unknown>;
    expect(result.status).toBe("tested");

    // marker 文件在 --testCwd 目录下生成，内容 = 该目录的绝对路径
    const markerFile = join(testCwdDir, "cwd-marker.txt");
    expect(existsSync(markerFile), "marker 文件应落在 --testCwd 目录").toBe(true);
    const recordedCwd = readFileSync(markerFile, "utf8").trim();
    expect(recordedCwd).toBe(testCwdDir);
    // 显式断言非工作区根目录（防「没生效退回根目录」的回归）
    expect(recordedCwd).not.toBe(e.workspaceDir);
  });

  it("无 --testCwd 时 runner 回退到 workspacePath（对照）", () => {
    const slug = "tcwd-default";
    const unitId = `wave:${slug}`;

    const created = runCwCli(
      ["create", "wave", "--slug", slug, "--objective", "default cwd"],
      e,
    );
    expect(created.exitCode, created.stderr).toBe(0);

    const clarifyInput = writeInputJson(e, slug, "clarify", { clarifications: [] });
    expect(runCwCli(["clarify", "--unitId", unitId, "--input", clarifyInput], e).exitCode).toBe(0);

    const planInput = writeInputJson(e, slug, "plan", {
      testCases: [makeValidTestCase("TC1")],
      tasks: [makeValidTask("TK1")],
      files: [makeValidFile("F1")],
      contracts: [makeValidContract("C1")],
      // 无 --testCwd 时 runner 回退 workspacePath；testCommand 是 marker 脚本验证 cwd。
      testCommand: "node marker.js",
    });
    expect(runCwCli(["plan", "--unitId", unitId, "--input", planInput], e).exitCode).toBe(0);

    const drInput = writeInputJson(e, slug, "design-review", {
      designReviewJudgment: makeValidDesignReviewJudgment(),
    });
    expect(runCwCli(["design-review", "--unitId", unitId, "--input", drInput], e).exitCode).toBe(0);

    expect(
      runCwCli(["execute", "--unitId", unitId, "--commitHash", e.commitHash], e).exitCode,
    ).toBe(0);

    // marker.js 在 workspace 根（runnerCwd 默认 = workspacePath）
    writeFileSync(
      join(e.workspaceDir, "marker.js"),
      'const fs = require("fs");\nfs.writeFileSync("cwd-marker-default.txt", process.cwd());\nconsole.log("Tests  1 passed");\nprocess.exit(0);\n',
      "utf8",
    );
    writeFileSync(
      join(e.workspaceDir, "cw.config.json"),
      JSON.stringify({ testRunner: { command: "node marker.js" } }),
      "utf8",
    );

    const testInput = writeInputJson(e, slug, "test", {
      testJudgment: makeValidTestJudgment(),
    });
    const tested = runCwCli(["test", "--unitId", unitId, "--input", testInput], e);
    expect(tested.exitCode, tested.stderr).toBe(0);

    const markerFile = join(e.workspaceDir, "cwd-marker-default.txt");
    expect(existsSync(markerFile)).toBe(true);
    expect(readFileSync(markerFile, "utf8").trim()).toBe(e.workspaceDir);
  });
});

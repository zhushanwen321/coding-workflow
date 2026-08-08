/**
 * v1 testCwd e2e 回归测试（#4，T1.12 / AC-3.4）。
 *
 * 背景：retrospect 数据多处提及「testRunner cwd 未生效，monorepo 根目录跑全量」,
 * 原 testCwd flag 链路已废除，testCwd 下沉为 per-wave 属性。新链路：
 *   design/replan 阶段在 input 填 testCwd → 写入 unit.plan.testCwd → testRunner.run 读
 *   unit.plan.testCwd（缺省 = workspacePath，相对路径 resolve(workspacePath)）→ spawnSync cwd。
 * 本测试用 marker 脚本把 testRunner 子进程的真实 process.cwd() 落盘，
 * 断言 design 填 testCwd 后 `cw test` 实际运行目录 = testCwd 指定目录——锁定行为防回归。
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

// ── T1.12：per-wave testCwd 真实运行目录 ────────────────────────────

describe("W8: cw test per-wave testCwd 真实运行目录（#4，T1.12）", () => {
  it("testRunner 子进程实际 cwd = plan.testCwd 指定目录（marker 文件验证）", () => {
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

    // ── 1. 真实 CLI 全链推进到 executing ──
    const created = runCwCli(
      ["create", "wave", "--slug", slug, "--objective", "testCwd e2e"],
      e,
    );
    expect(created.exitCode, created.stderr).toBe(0);

    // design 合并原 clarify + plan：clarifications + WavePlan 4 类条目 + testCommand 一次提交
    const planInput = writeInputJson(e, slug, "design", {
      testCases: [makeValidTestCase("TC1")],
      tasks: [makeValidTask("TK1")],
      files: [makeValidFile("F1")],
      contracts: [makeValidContract("C1")],
      clarifications: [],
      // per-wave 设计：testCommand 决定跑什么，testCwd 决定在哪跑。
      // marker 脚本写 cwd 落盘，验证 spawnSync 的 cwd = plan.testCwd 指定目录。
      testCommand: "node marker.js",
      testCwd: "packages/renderer",
    });
    const designed = runCwCli(
      ["design", "--unitId", unitId, "--input", planInput],
      e,
    );
    expect(designed.exitCode, designed.stderr).toBe(0);

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

    // ── 2. 关键断言：design 已填 testCwd 指定子包目录，cw test 直接跑 ──
    const testInput = writeInputJson(e, slug, "test", {
      testJudgment: makeValidTestJudgment(),
    });
    const tested = runCwCli(
      ["test", "--unitId", unitId, "--input", testInput],
      e,
    );
    expect(tested.exitCode, tested.stderr).toBe(0);

    // 结果 status=tested（gate 全过）
    const result = JSON.parse(tested.stdout.trim()) as Record<string, unknown>;
    expect(result.status).toBe("tested");

    // marker 文件在 plan.testCwd 目录下生成，内容 = 该目录的绝对路径
    const markerFile = join(testCwdDir, "cwd-marker.txt");
    expect(existsSync(markerFile), "marker 文件应落在 plan.testCwd 目录").toBe(true);
    const recordedCwd = readFileSync(markerFile, "utf8").trim();
    expect(recordedCwd).toBe(testCwdDir);
    // 显式断言非工作区根目录（防「没生效退回根目录」的回归）
    expect(recordedCwd).not.toBe(e.workspaceDir);
  });

  it("无 testCwd 时 runner 回退到 workspacePath（对照）", () => {
    const slug = "tcwd-default";
    const unitId = `wave:${slug}`;

    const created = runCwCli(
      ["create", "wave", "--slug", slug, "--objective", "default cwd"],
      e,
    );
    expect(created.exitCode, created.stderr).toBe(0);

    // design 合并原 clarify + plan：clarifications + WavePlan 4 类条目一次提交
    const planInput = writeInputJson(e, slug, "design", {
      testCases: [makeValidTestCase("TC1")],
      tasks: [makeValidTask("TK1")],
      files: [makeValidFile("F1")],
      contracts: [makeValidContract("C1")],
      clarifications: [],
      // 无 testCwd 时 runner 回退 workspacePath；testCommand 是 marker 脚本验证 cwd。
      testCommand: "node marker.js",
    });
    expect(runCwCli(["design", "--unitId", unitId, "--input", planInput], e).exitCode).toBe(0);

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

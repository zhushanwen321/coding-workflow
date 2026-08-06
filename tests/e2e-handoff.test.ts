/**
 * cw handoff 端到端测试（TC5-TC7）。
 *
 * 通过真实子进程跑 dist/cli.js v1 handoff，验证：
 *   TC5: create 后 handoff → 五段式纯文本 + 含下一步 guidance
 *   TC6: handoff 缺 --unitId → exit 1
 *   TC7: handoff 不存在的 unitId → exit 1 + unit not found
 *
 * 复用 cli.test.ts 的子进程模式（runCwCli/createCwCliEnv）。
 * 需先 npm run build（dist/cli.js 存在）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupGitRepo } from "./helpers/git.js";

// ── 路径常量 ────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

// ── 子进程辅助（精简版，同 cli.test.ts 模式）──

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

function runCwCli(args: string[], env: CwCliEnv): CliResult {
  const mergedEnv = { ...process.env, ...env.env, PATH: process.env.PATH ?? "" };
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

function createCwCliEnv(): CwCliEnv {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`dist/cli.js 不存在，请先 npm run build。路径: ${CLI_PATH}`);
  }
  const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "cw-handoff-ws-")));
  const cwHome = realpathSync(mkdtempSync(join(tmpdir(), "cw-handoff-home-")));
  const env = { CW_HOME: cwHome };
  const commitHash = setupGitRepo(workspaceDir);
  return { workspaceDir, cwHome, env, commitHash };
}

function disposeCwCliEnv(e: CwCliEnv): void {
  rmSync(e.workspaceDir, { recursive: true, force: true });
  rmSync(e.cwHome, { recursive: true, force: true });
}

// ── 共享环境 ────────────────────────────────────────────────

let e: CwCliEnv;

beforeAll(() => {
  e = createCwCliEnv();
});

afterAll(() => {
  disposeCwCliEnv(e);
});

// ── TC5: create 后 handoff → 五段式纯文本 ───────────────────

describe("TC5: cw handoff --unitId <id> 端到端", () => {
  it("create 后 handoff 输出五段式 + 含下一步 guidance，exit 0", () => {
    // 先 create 一个 wave
    const created = runCwCli(
      ["create", "wave", "--slug", "tc5-wave", "--objective", "TC5 交接测试"],
      e,
    );
    expect(created.exitCode).toBe(0);

    // handoff
    const result = runCwCli(["handoff", "--unitId", "wave:tc5-wave"], e);

    expect(result.exitCode).toBe(0);
    const out = result.stdout;

    // 标题段
    expect(out).toContain("# Handoff: wave:tc5-wave [created]");
    // 目标段
    expect(out).toContain("## 目标");
    expect(out).toContain("TC5 交接测试");
    // 当前位置与下一步段（含明确命令 + 阶段 guidance）
    expect(out).toContain("## 当前位置与下一步");
    expect(out).toContain("状态：created");
    expect(out).toContain("下一步执行：cw design --unitId wave:tc5-wave");
    expect(out).toContain("阶段提示");
    // 历史段
    expect(out).toContain("## 历史与变更");
    expect(out).toContain("create → created");
  });

  it("create 后 handoff 的 schema 段保持当前 action（#1 例外路径锁定，T1.4）", () => {
    // handoff 重建「当前步」认知：阶段 guidance 用 build*CurrentActionGuidance，
    // schema 必须保持当前 action（design）而非 nextAction——create 完成后手交，
    // 接手 agent 要跑的是 design，需要 design 的 input schema。
    const created = runCwCli(
      ["create", "wave", "--slug", "tc5-handoff-schema", "--objective", "handoff schema"],
      e,
    );
    expect(created.exitCode).toBe(0);

    const result = runCwCli(["handoff", "--unitId", "wave:tc5-handoff-schema"], e);
    expect(result.exitCode).toBe(0);
    const out = result.stdout;

    expect(out).toContain("下一步执行：cw design --unitId wave:tc5-handoff-schema");
    // 阶段 guidance 含 design 的 input schema（clarifications 数组）
    expect(out).toContain("clarifications");
    // 不得出现 create 的扁平提示（slug/objective）
    expect(out).not.toContain("slug: string");
    expect(out).not.toContain("objective: string");
  });
});

// ── TC6: handoff 缺 --unitId → exit 1 ───────────────────────

describe("TC6: cw handoff 缺 --unitId 报错", () => {
  it("不带 --unitId → exit 1 + stderr 含 handoff 需要 --unitId", () => {
    const result = runCwCli(["handoff"], e);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("handoff 需要 --unitId");
  });
});

// ── TC7: handoff 不存在的 unitId → exit 1 ──────────────────

describe("TC7: cw handoff 不存在的 unitId 报错", () => {
  it("wave:nope → exit 1 + stderr 含 unit not found", () => {
    const result = runCwCli(["handoff", "--unitId", "wave:nope"], e);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unit not found");
  });
});

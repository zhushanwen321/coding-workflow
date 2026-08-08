/**
 * v1 CLI 层 3 烟雾测试（spawnSync 真实子进程）。
 *
 * 仅保留必须经真实 `dist/cli.js` 子进程验证的端到端烟雾：argv 解析 → dispatch →
 * stdout/exit 全链路。纯逻辑（参数构造 / flag 解析 / help 渲染 / testRunner 守卫 /
 * status 截断 等）已下沉到层 1/2：
 *   - tests/cli-wiring.test.ts（层 2，in-process import，25 test ~28ms）
 *   - tests/dispatch-e2e.test.ts（dispatch 路由 / guard / unit_not_found / illegal_transition）
 *   - tests/cli-params.test.ts（flag 白名单）、tests/validate-input.test.ts（input shape）
 *
 * 保留的烟雾（10 个，原 cli.test.ts 序号）：
 *   #1  create wave happy-path（JSON + nextAction + store 落盘）
 *   #5  create 缺 layer → exit 0 + 选层 guidance
 *   #9  未知 action → exit 1
 *   #12 cw version → exit 0 + 版本号
 *   #15 cw help → exit 0 + 用法
 *   #19 create → design --input @file.json → designing + 落盘
 *   #22 design 不存在 unitId → exit 1 + unit not found（CwEngineError CLI 接线）
 *   #23 create 后 execute 非法跳步 → exit 1 + not allowed（CwEngineError CLI 接线）
 *   #33 拼错 flag --unid → exit 1 + unknown flag（validateFlags CLI 接线）
 *   #42 buildLayerPromptGuidance 纯函数（层 1，保留不动）
 *
 * 注意：e2e 测试需要先 npm run build（dist/cli.js 存在）。测试文件顶部断言。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildLayerPromptGuidance } from "../src/cli.js";
import {
  makeValidContract,
  makeValidFile,
  makeValidTask,
  makeValidTestCase,
} from "./helpers/env.js";
import { setupGitRepo } from "./helpers/git.js";

// ── 路径常量 ────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

// ── 子进程辅助（v1 专用，与 0.x 的 E2eEnv 隔离用独立 CW_HOME） ──

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CwCliEnv {
  /** 工作目录（cwd）：v1 store/git/testRunner 都绑它。 */
  workspaceDir: string;
  /** v1 存储根（CW_HOME），per-cwd 隔离。 */
  cwHome: string;
  /** 传给子进程的环境变量。 */
  env: Record<string, string>;
  /** setupGitRepo 产出的初始 commit hash（execute/test 场景用）。 */
  commitHash: string;
}

/**
 * runCwCli — 真实子进程调 dist/cli.js（args 直接是 action 起的参数，无 v1 前缀）。
 *
 * cwd 默认 env.workspaceDir（CLI 默认 workspacePath=process.cwd()，
 * v1 store 的 encodeCwd(workspacePath) 必须与落盘路径一致）。
 */
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

/** 解析 CLI stdout 为 JSON，要求 exitCode=0 且 stdout 非空。 */
function parseStdout(result: CliResult): Record<string, unknown> {
  expect(
    result.exitCode,
    `CLI exit code should be 0, stderr: ${result.stderr}`,
  ).toBe(0);
  const trimmed = result.stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed) as Record<string, unknown>;
}

/**
 * 创建独立隔离的 v1 测试环境（独立 tmp workspace + CW_HOME + git repo）。
 *
 * git repo 仅 execute/test 的真实 git 校验需要；create/design 等不依赖 git。
 */
function createCwCliEnv(): CwCliEnv {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`dist/cli.js 不存在，请先 npm run build。路径: ${CLI_PATH}`);
  }
  const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "cw-v1cli-ws-")));
  const cwHome = realpathSync(mkdtempSync(join(tmpdir(), "cw-v1cli-home-")));
  // 设 CW_HOME：v1 命令写 CW_HOME
  const env = { CW_HOME: cwHome };
  const commitHash = setupGitRepo(workspaceDir);
  return { workspaceDir, cwHome, env, commitHash };
}

function disposeCwCliEnv(e: CwCliEnv): void {
  rmSync(e.workspaceDir, { recursive: true, force: true });
  rmSync(e.cwHome, { recursive: true, force: true });
}

// ── 共享测试环境 ────────────────────────────────────────────

let e: CwCliEnv;

beforeAll(() => {
  e = createCwCliEnv();
});

afterAll(() => {
  disposeCwCliEnv(e);
});

// ── 测试 ────────────────────────────────────────────────────

describe("W8: cw create wave（happy path，#1）", () => {
  it("返回 JSON 含 status=created + nextAction.guidance 非空", () => {
    const result = parseStdout(
      runCwCli(
        ["create", "wave", "--slug", "w8-create", "--objective", "W8 接入测试"],
        e,
      ),
    );

    // 基本字段
    expect(result.ok).toBe(true);
    expect(result.status).toBe("created");
    expect(result.unitId).toBe("wave:w8-create");

    // nextAction.guidance 非空（agent 靠它推进）
    const nextAction = result.nextAction as Record<string, unknown> | undefined;
    expect(nextAction).toBeDefined();
    expect(typeof nextAction!.guidance).toBe("string");
    expect((nextAction!.guidance as string).length).toBeGreaterThan(0);
    // create 后推荐 design
    expect(nextAction!.action).toBe("design");

    // unitPath 结构化字段
    const unitPath = nextAction!.unitPath as Record<string, unknown>;
    expect(unitPath.layer).toBe("wave");
    expect(unitPath.unitId).toBe("wave:w8-create");

    // store 落盘验证：store.json 在 CW_HOME/<encodedCwd>/store.json
    const v1Json = findStoreJson(e.cwHome);
    expect(v1Json).not.toBeNull();
    const data = JSON.parse(readStoreJson(v1Json!)) as { workUnits: unknown[] };
    expect(data.workUnits.length).toBeGreaterThan(0);
  });
});

describe("W8: cw create 缺 layer → 选层 guidance（#5）", () => {
  it("缺 layer → exit 0 + 返回选层 guidance（规模表/层级树/反模式/命令）", () => {
    // layer 完全缺失（create 后无位置参数）：返回选层 guidance 引导 agent 选层。
    const result = runCwCli(["create", "--slug", "x", "--objective", "y"], e);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("规模");
    expect(result.stdout).toContain("epic → feature → slice → wave");
    expect(result.stdout).toContain("反模式");
    expect(result.stdout).toContain("cw create <layer>");
    // 不应进 dispatch：stdout 不是 JSON（无 unitId/nextAction）。
    expect(result.stdout).not.toContain("unitId");
  });
});

describe("W8: cw 未知 action → exit 1（#9）", () => {
  it("未知 action → exit 1 + 错误信息", () => {
    const result = runCwCli(["frobnicate", "--unitId", "wave:x"], e);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("未知 action");
  });
});

describe("W8: cw version / help（#12 / #15）", () => {
  // package.json version 字段（与 dist/cli.js 读到的同一份，用于 version 断言）。
  const pkgPath = join(__dirname, "..", "package.json");
  const expectedVersion = (
    JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string }
  ).version;

  it("cw version → exit 0 + stdout 含 `cw` 和版本号", () => {
    const result = runCwCli(["version"], e);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("cw");
    expect(result.stdout).toContain(expectedVersion);
    // 格式：单行 `cw <version>`
    expect(result.stdout.trim()).toBe(`cw ${expectedVersion}`);
  });

  it("cw help → exit 0 + stdout 含用法/create/list 等关键词", () => {
    const result = runCwCli(["help"], e);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const keyword of ["用法", "create", "list", "help", "version"]) {
      expect(result.stdout).toContain(keyword);
    }
  });
});

describe("W8: cw design（推进 action，--input @file 管道，#19）", () => {
  it("create → design（--input @file.json）→ status=designing + WavePlan 落盘", () => {
    // 1. 先 create 一个 wave
    const created = parseStdout(
      runCwCli(["create", "wave", "--slug", "w8-design", "--objective", "o"], e),
    );
    expect(created.ok).toBe(true);
    const unitId = created.unitId as string;

    // 2. design：input 写文件，用 --input @file.json 传（含 clarifications + WavePlan 4 类条目）
    const inputFile = join(e.workspaceDir, "design-input.json");
    writeFileSync(
      inputFile,
      JSON.stringify({
        clarifications: [
          {
            id: "Q1",
            status: "active",
            question: "use JWT?",
            resolution: "yes",
            type: "grilling",
          },
        ],
        testCases: [makeValidTestCase()],
        tasks: [makeValidTask()],
        files: [makeValidFile()],
        contracts: [makeValidContract()],
        testCommand: "npx vitest run",
      }),
    );
    const designed = parseStdout(
      runCwCli(["design", "--unitId", unitId, "--input", `${inputFile}`], e),
    );
    expect(designed.ok).toBe(true);
    expect(designed.status).toBe("designing");
    expect(designed.unitId).toBe(unitId);
    const nextAction = designed.nextAction as Record<string, unknown>;
    expect(typeof nextAction.guidance).toBe("string");
    expect((nextAction.guidance as string).length).toBeGreaterThan(0);
    // 落盘验证：store 里该 unit 的 clarifications 应有 1 条
    const v1Json = findStoreJson(e.cwHome);
    expect(v1Json).not.toBeNull();
    const data = JSON.parse(readStoreJson(v1Json!)) as {
      workUnits: Array<{ id: string; clarifications?: unknown[] }>;
    };
    const persisted = data.workUnits.find((u) => u.id === unitId);
    expect(persisted).toBeDefined();
    expect(Array.isArray(persisted!.clarifications)).toBe(true);
    expect(persisted!.clarifications!.length).toBe(1);
  });
});

describe("W8: cw unit not found / 非法跳步 → exit 1（#22 / #23，CwEngineError CLI 接线）", () => {
  it("design 一个不存在的 unitId → exit 1 + unit_not_found", () => {
    const inputFile = join(e.workspaceDir, "ghost-input.json");
    writeFileSync(
      inputFile,
      JSON.stringify({
        testCases: [],
        tasks: [],
        files: [],
        contracts: [],
        testCommand: "npx vitest run",
      }),
    );
    const result = runCwCli(
      ["design", "--unitId", "wave:ghost", "--input", `${inputFile}`],
      e,
    );
    expect(result.exitCode).toBe(1);
    // CwEngineError message 含 unit not found（exit code 由 mapExitCode 映射，CwEngineError → 1）
    expect(result.stderr).toContain("unit not found");
  });

  it("create 后直接 execute（非法跳步）→ exit 1 + illegal_transition", () => {
    const created = parseStdout(
      runCwCli(["create", "wave", "--slug", "w8-illegal", "--objective", "o"], e),
    );
    const unitId = created.unitId as string;
    const result = runCwCli(
      ["execute", "--unitId", unitId, "--commitHash", e.commitHash],
      e,
    );
    expect(result.exitCode).toBe(1);
    // CwEngineError 的 message 是 guard 的 reason（"action X not allowed from status Y"）。
    expect(result.stderr).toContain("not allowed");
  });
});

describe("W2: unknown flag 白名单校验（#33，validateFlags CLI 接线）", () => {
  it("拼错 flag（--unid）→ exit 1 + unknown flag + 合法 flag 列表", () => {
    // validateFlags 在 buildParams 之前拦截：不报「需要 --unitId」而是报 unknown flag
    const result = runCwCli(["design", "--unid", "wave:x"], e);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown flag --unid");
    expect(result.stderr).toContain("unitId");
  });
});

describe("W7b: buildLayerPromptGuidance 纯函数（#42，层 1）", () => {
  it("返回非空字符串，含四个 layer 名 + 规模表 + 反模式", () => {
    const guidance = buildLayerPromptGuidance();
    expect(typeof guidance).toBe("string");
    expect(guidance.length).toBeGreaterThan(0);
    // 四个 layer 名都出现（选层表 + 命令示例都会命中）
    for (const layer of ["wave", "slice", "feature", "epic"]) {
      expect(guidance).toContain(layer);
    }
    // 选层决策框架的三个标志性段落
    expect(guidance).toContain("规模");
    expect(guidance).toContain("epic → feature → slice → wave");
    expect(guidance).toContain("反模式");
  });
});

// ── 辅助：在 CW_HOME 树里找 store.json ────────────────────────

function findStoreJson(dir: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findStoreJson(full);
      if (found) return found;
    } else if (entry.name === "store.json") {
      return full;
    }
  }
  return null;
}

function readStoreJson(path: string): string {
  return readFileSync(path, "utf-8");
}

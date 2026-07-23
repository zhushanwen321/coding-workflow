/**
 * v1 CLI 接入 e2e 测试（W8）。
 *
 * 通过真实子进程跑 `dist/cli.js v1 <action>`，验证：
 *   - cw v1 create wave → JSON 含 nextAction.guidance 非空
 *   - 缺少必填参数 → exit 1 + 错误信息
 *   - v1 与 0.x 命令并存互不干扰（cw create 走 0.x，cw v1 create 走 v1）
 *   - 推进 action（clarify）的 --input @file.json 管道
 *   - unit not found → exit 1 + V1Error 语义
 *
 * 复用 tests/helpers/e2e.ts 的 runCli / parseStdout / setupGitRepo
 * （这些 helper 是 v1/0.x 无关的通用子进程基建）。
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

import { setupGitRepo } from "../helpers/git.js";

// ── 路径常量 ────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, "..", "..", "dist", "cli.js");

// ── 子进程辅助（v1 专用，与 0.x 的 E2eEnv 隔离用独立 V1_HOME） ──

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface V1CliEnv {
  /** 工作目录（cwd）：v1 store/git/testRunner 都绑它。 */
  workspaceDir: string;
  /** v1 存储根（V1_HOME），per-cwd 隔离。 */
  v1Home: string;
  /** 0.x 存储根（CW_HOME），并存测试隔离用（避免污染真实 ~/.cw）。 */
  cwHome: string;
  /** 传给子进程的环境变量。 */
  env: Record<string, string>;
  /** setupGitRepo 产出的初始 commit hash（execute/test 场景用）。 */
  commitHash: string;
}

/**
 * runV1Cli — 真实子进程调 dist/cli.js（args 可带或不带 "v1" 前缀）。
 *
 * cwd 默认 env.workspaceDir（CLI 默认 workspacePath=process.cwd()，
 * v1 store 的 encodeCwd(workspacePath) 必须与落盘路径一致）。
 */
function runV1Cli(
  args: string[],
  env: V1CliEnv,
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
 * 创建独立隔离的 v1 测试环境（独立 tmp workspace + V1_HOME + git repo）。
 *
 * git repo 仅 execute/test 的真实 git 校验需要；create/clarify 等不依赖 git。
 */
function createV1CliEnv(): V1CliEnv {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`dist/cli.js 不存在，请先 npm run build。路径: ${CLI_PATH}`);
  }
  const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "cw-v1cli-ws-")));
  const v1Home = realpathSync(mkdtempSync(join(tmpdir(), "cw-v1cli-home-")));
  const cwHome = realpathSync(mkdtempSync(join(tmpdir(), "cw-v1cli-cwh-")));
  // 同时设 V1_HOME + CW_HOME：v1 命令写 V1_HOME，0.x 命令写 CW_HOME，两套并存互不污染。
  const env = { V1_HOME: v1Home, CW_HOME: cwHome };
  const commitHash = setupGitRepo(workspaceDir);
  return { workspaceDir, v1Home, cwHome, env, commitHash };
}

function disposeV1CliEnv(e: V1CliEnv): void {
  rmSync(e.workspaceDir, { recursive: true, force: true });
  rmSync(e.v1Home, { recursive: true, force: true });
  rmSync(e.cwHome, { recursive: true, force: true });
}

// ── 共享测试环境 ────────────────────────────────────────────

let e: V1CliEnv;

beforeAll(() => {
  e = createV1CliEnv();
});

afterAll(() => {
  disposeV1CliEnv(e);
});

// ── 测试 ────────────────────────────────────────────────────

describe("W8: cw v1 create wave（happy path）", () => {
  it("返回 JSON 含 status=created + nextAction.guidance 非空", () => {
    const result = parseStdout(
      runV1Cli(
        [
          "v1",
          "create",
          "wave",
          "--slug",
          "w8-create",
          "--objective",
          "W8 接入测试",
        ],
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
    // create 后推荐 clarify
    expect(nextAction!.action).toBe("clarify");

    // unitPath 结构化字段
    const unitPath = nextAction!.unitPath as Record<string, unknown>;
    expect(unitPath.layer).toBe("wave");
    expect(unitPath.unitId).toBe("wave:w8-create");

    // store 落盘验证：_v1.json 在 V1_HOME/<encodedCwd>/_v1.json
    const v1Json = findV1Json(e.v1Home);
    expect(v1Json).not.toBeNull();
    const data = JSON.parse(readV1Json(v1Json!)) as { workUnits: unknown[] };
    expect(data.workUnits.length).toBeGreaterThan(0);
  });

  it("带 --parent + --basedOnParent 的 create 也能落盘 parentUnitId", () => {
    const result = parseStdout(
      runV1Cli(
        [
          "v1",
          "create",
          "wave",
          "--slug",
          "w8-parented",
          "--objective",
          "with parent",
          "--parent",
          "slice:auth",
          "--basedOnParent",
          '["TC1","TC2"]',
        ],
        e,
      ),
    );
    const unit = result.unit as Record<string, unknown>;
    expect(unit.parentUnitId).toBe("slice:auth");
    expect(unit.basedOnParent).toEqual(["TC1", "TC2"]);
  });
});

describe("W8: cw v1 create 缺必填参数 → exit 1", () => {
  it("缺 --objective → exit 1 + 错误信息含 objective", () => {
    const result = runV1Cli(
      ["v1", "create", "wave", "--slug", "no-obj"],
      e,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("objective");
  });

  it("缺 --slug → exit 1 + 错误信息含 slug", () => {
    const result = runV1Cli(
      ["v1", "create", "wave", "--objective", "x"],
      e,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("slug");
  });

  it("缺 layer → exit 1 + 错误信息含 layer", () => {
    const result = runV1Cli(
      ["v1", "create", "--slug", "x", "--objective", "y"],
      e,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("layer");
  });

  it("非法 layer → exit 1 + 错误信息", () => {
    const result = runV1Cli(
      ["v1", "create", "bogus", "--slug", "x", "--objective", "y"],
      e,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("layer");
  });

  it("未实现的 layer（slice）→ exit 1 + 明确提示未实现", () => {
    const result = runV1Cli(
      ["v1", "create", "slice", "--slug", "x", "--objective", "y"],
      e,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("尚未实现");
  });
});

describe("W8: cw v1 <action> 未知/缺 unitId → exit 1", () => {
  it("未知 v1 action → exit 1 + 错误信息", () => {
    const result = runV1Cli(
      ["v1", "frobnicate", "--unitId", "wave:x"],
      e,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("未知 v1 action");
  });

  it("只打 cw v1 不带 action → exit 1 + 错误信息", () => {
    const result = runV1Cli(["v1"], e);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("action");
  });

  it("推进 action 缺 --unitId → exit 1", () => {
    const result = runV1Cli(
      ["v1", "clarify", "--input", "-"],
      e,
      { input: JSON.stringify({ clarifications: [] }) },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unitId");
  });
});

describe("W8: cw v1 clarify（推进 action，--input @file 管道）", () => {
  it("create → clarify（--input @file.json）→ status=clarifying + clarifications 落盘", () => {
    // 1. 先 create 一个 wave
    const created = parseStdout(
      runV1Cli(
        ["v1", "create", "wave", "--slug", "w8-clarify", "--objective", "o"],
        e,
      ),
    );
    expect(created.ok).toBe(true);
    const unitId = created.unitId as string;

    // 2. clarify：input 写文件，用 --input @file.json 传
    const inputFile = join(e.workspaceDir, "clarify-input.json");
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
      }),
    );
    const clarified = parseStdout(
      runV1Cli(
        ["v1", "clarify", "--unitId", unitId, "--input", `@${inputFile}`],
        e,
      ),
    );
    expect(clarified.ok).toBe(true);
    expect(clarified.status).toBe("clarifying");
    expect(clarified.unitId).toBe(unitId);
    // clarify handler 不回吐整个 unit（只 create 才带 unit）；
    // 验证状态推进（status=clarifying）+ nextAction 指向下一步。
    const nextAction = clarified.nextAction as Record<string, unknown>;
    expect(typeof nextAction.guidance).toBe("string");
    expect((nextAction.guidance as string).length).toBeGreaterThan(0);
    // 落盘验证：store 里该 unit 的 clarifications 应有 1 条
    const v1Json = findV1Json(e.v1Home);
    expect(v1Json).not.toBeNull();
    const data = JSON.parse(readV1Json(v1Json!)) as {
      workUnits: Array<{ id: string; clarifications?: unknown[] }>;
    };
    const persisted = data.workUnits.find((u) => u.id === unitId);
    expect(persisted).toBeDefined();
    expect(Array.isArray(persisted!.clarifications)).toBe(true);
    expect(persisted!.clarifications!.length).toBe(1);
  });

  it("clarify 用 stdin 传 input 也能跑通", () => {
    const created = parseStdout(
      runV1Cli(
        ["v1", "create", "wave", "--slug", "w8-stdin", "--objective", "o"],
        e,
      ),
    );
    const unitId = created.unitId as string;
    const clarified = parseStdout(
      runV1Cli(
        ["v1", "clarify", "--unitId", unitId, "--input", "-"],
        e,
        { input: JSON.stringify({ clarifications: [] }) },
      ),
    );
    expect(clarified.ok).toBe(true);
    expect(clarified.status).toBe("clarifying");
  });

  it("推进 action 无 input（stdin 空 + 无 --input）→ exit 1", () => {
    const created = parseStdout(
      runV1Cli(
        ["v1", "create", "wave", "--slug", "w8-noinput", "--objective", "o"],
        e,
      ),
    );
    const unitId = created.unitId as string;
    // stdin 为空（runV1Cli 不传 input 且子进程 stdin 无 pipe）→ 报缺 input
    const result = runV1Cli(["v1", "plan", "--unitId", unitId], e);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("input");
  });
});

describe("W8: cw v1 unit not found → exit 1（V1Error 语义）", () => {
  it("clarify 一个不存在的 unitId → exit 1 + unit_not_found", () => {
    const inputFile = join(e.workspaceDir, "ghost-input.json");
    writeFileSync(inputFile, JSON.stringify({ clarifications: [] }));
    const result = runV1Cli(
      [
        "v1",
        "clarify",
        "--unitId",
        "wave:ghost",
        "--input",
        `@${inputFile}`,
      ],
      e,
    );
    expect(result.exitCode).toBe(1);
    // V1Error message 含 unit not found（exit code 由 mapExitCode 映射，V1Error → 1）
    expect(result.stderr).toContain("unit not found");
  });

  it("create 后直接 execute（非法跳步）→ exit 1 + illegal_transition", () => {
    const created = parseStdout(
      runV1Cli(
        ["v1", "create", "wave", "--slug", "w8-illegal", "--objective", "o"],
        e,
      ),
    );
    const unitId = created.unitId as string;
    const result = runV1Cli(
      ["v1", "execute", "--unitId", unitId, "--commitHash", e.commitHash],
      e,
    );
    expect(result.exitCode).toBe(1);
    // V1Error 的 message 是 guard 的 reason（"action X not allowed from status Y"），
    // 由 mapExitCode 映射 exit 1。断言 reason 关键词，不断言 code 字段（code 不在 message 里）。
    expect(result.stderr).toContain("not allowed");
  });
});

describe("W8: 0.x 命令与 v1 并存（向后兼容）", () => {
  it("cw create（不带 v1 前缀）仍走 0.x → 返回 topicId（cw-<date>-<slug>）", () => {
    // 0.x create 用 CW_HOME（这里也隔离，避免污染），不碰 V1_HOME。
    const result = runV1Cli(
      ["create", "--slug", "legacy-coexist", "--objective", "0.x"],
      e,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed.topicId).toMatch(/^cw-\d{4}-\d{2}-\d{2}-legacy-coexist$/);
    expect(parsed.status).toBe("created");
    // 0.x nextAction.action 是 clarify（与 v1 的字段语义一致但来自不同 dispatch）
    const nextAction = parsed.nextAction as Record<string, unknown>;
    expect(nextAction.action).toBe("clarify");
  });

  it("v1 和 0.x 写各自的存储（V1_HOME vs CW_HOME）互不污染", () => {
    // v1 create 写 _v1.json（V1_HOME 下）
    runV1Cli(
      ["v1", "create", "wave", "--slug", "iso-v1", "--objective", "o"],
      e,
    );
    // v1 存储存在
    expect(findV1Json(e.v1Home)).not.toBeNull();

    // 0.x 存储路径不同（CW_HOME，未设则默认 ~/.cw），不会写到 V1_HOME。
    // 这里只验证 v1 侧 _v1.json 里只有 v1 的 workUnits（无 0.x topic 字段）。
    const v1Data = JSON.parse(readV1Json(findV1Json(e.v1Home)!)) as Record<
      string,
      unknown
    >;
    expect(Array.isArray(v1Data.workUnits)).toBe(true);
    expect(v1Data.topics).toBeUndefined(); // 0.x 的字段不在 v1 store
  });
});

// ── 辅助：在 V1_HOME 树里找 _v1.json ────────────────────────

function findV1Json(dir: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findV1Json(full);
      if (found) return found;
    } else if (entry.name === "_v1.json") {
      return full;
    }
  }
  return null;
}

function readV1Json(path: string): string {
  return readFileSync(path, "utf-8");
}

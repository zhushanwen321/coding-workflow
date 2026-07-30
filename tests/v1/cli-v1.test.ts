/**
 * v1 CLI 接入 e2e 测试（W8）。
 *
 * 通过真实子进程跑 `dist/cli.js v1 <action>`，验证：
 *   - cw create wave → JSON 含 nextAction.guidance 非空
 *   - 缺少必填参数 → exit 1 + 错误信息
 *   - v1 与 0.x 命令并存互不干扰（cw create 走 0.x，cw create 走 v1）
 *   - 推进 action（clarify）的 --input @file.json 管道
 *   - unit not found → exit 1 + CwEngineError 语义
 *
 * 复用 tests/v1/helpers/git.ts 的 setupGitRepo（git 仓库初始化，v1/0.x 无关的通用基建）。
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

import { buildLayerPromptGuidance } from "../../src/cli.js";
import { setupGitRepo } from "./helpers/git.js";
import {
  makeValidSliceDesignReviewJudgment,
  makeValidSlicePlan,
} from "./helpers/slice-env.js";
import {
  makeValidContract,
  makeValidFile,
  makeValidTask,
  makeValidTestCase,
} from "./helpers/v1-env.js";

// ── 路径常量 ────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, "..", "..", "dist", "cli.js");

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
 * git repo 仅 execute/test 的真实 git 校验需要；create/clarify 等不依赖 git。
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

describe("W8: cw create wave（happy path）", () => {
  it("返回 JSON 含 status=created + nextAction.guidance 非空", () => {
    const result = parseStdout(
      runCwCli(
        [
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

    // store 落盘验证：_v1.json 在 CW_HOME/<encodedCwd>/_v1.json
    const v1Json = findV1Json(e.cwHome);
    expect(v1Json).not.toBeNull();
    const data = JSON.parse(readV1Json(v1Json!)) as { workUnits: unknown[] };
    expect(data.workUnits.length).toBeGreaterThan(0);
  });

  it("带 --parent + --basedOnParent 的 create 也能落盘 parentUnitId", () => {
    const result = parseStdout(
      runCwCli(
        [
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

describe("W8: cw create 缺必填参数 → exit 1", () => {
  it("缺 --objective → exit 1 + 错误信息含 objective", () => {
    const result = runCwCli(
      ["create", "wave", "--slug", "no-obj"],
      e,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("objective");
  });

  it("缺 --slug → exit 1 + 错误信息含 slug", () => {
    const result = runCwCli(
      ["create", "wave", "--objective", "x"],
      e,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("slug");
  });

  it("缺 layer → exit 0 + 返回选层 guidance（规模表/层级树/反模式/命令）", () => {
    // layer 完全缺失（create 后无位置参数）：返回选层 guidance 引导 agent 选层。
    // 与下方「非法 layer 字符串 → exit 1」区分：缺失走 guidance，非法值走 throw。
    const result = runCwCli(
      ["create", "--slug", "x", "--objective", "y"],
      e,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("规模");
    expect(result.stdout).toContain("epic → feature → slice → wave");
    expect(result.stdout).toContain("反模式");
    expect(result.stdout).toContain("cw create <layer>");
    // 不应进 dispatch：stdout 不是 JSON（无 unitId/nextAction）。
    expect(result.stdout).not.toContain("unitId");
  });

  it("create 后无任何参数 → exit 0 + 选层 guidance", () => {
    // argv[3] === undefined 的形态（cw create 后什么都不跟）。
    const result = runCwCli(["create"], e);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("选择 layer");
  });

  it("非法 layer → exit 1 + 错误信息", () => {
    const result = runCwCli(
      ["create", "bogus", "--slug", "x", "--objective", "y"],
      e,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("layer");
  });

  it("非法 layer 名 → exit 1 + 明确提示非法", () => {
    // epic 已实现，改用虚构 layer 名验证「未知 layer 被拒」防御逻辑
    const result = runCwCli(
      ["create", "bogus-layer", "--slug", "x", "--objective", "y"],
      e,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("非法");
  });
});

describe("W8: cw <action> 未知/缺 unitId → exit 1", () => {
  it("未知 v1 action → exit 1 + 错误信息", () => {
    const result = runCwCli(
      ["frobnicate", "--unitId", "wave:x"],
      e,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("未知 action");
  });

  it("只打 cw v1（旧前缀）→ exit 1 + 错误信息（v1 不再是合法 action）", () => {
    const result = runCwCli(["v1"], e);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("未知 action");
    expect(result.stderr).toContain("v1");
  });

  it("推进 action 缺 --unitId → exit 1", () => {
    const result = runCwCli(
      ["clarify", "--input", "-"],
      e,
      { input: JSON.stringify({ clarifications: [] }) },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unitId");
  });
});

describe("W8: cw clarify（推进 action，--input @file 管道）", () => {
  it("create → clarify（--input @file.json）→ status=clarifying + clarifications 落盘", () => {
    // 1. 先 create 一个 wave
    const created = parseStdout(
      runCwCli(
        ["create", "wave", "--slug", "w8-clarify", "--objective", "o"],
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
      runCwCli(
        ["clarify", "--unitId", unitId, "--input", `${inputFile}`],
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
    const v1Json = findV1Json(e.cwHome);
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
      runCwCli(
        ["create", "wave", "--slug", "w8-stdin", "--objective", "o"],
        e,
      ),
    );
    const unitId = created.unitId as string;
    const clarified = parseStdout(
      runCwCli(
        ["clarify", "--unitId", unitId, "--input", "-"],
        e,
        { input: JSON.stringify({ clarifications: [] }) },
      ),
    );
    expect(clarified.ok).toBe(true);
    expect(clarified.status).toBe("clarifying");
  });

  it("推进 action 无 input（stdin 空 + 无 --input）→ exit 1", () => {
    const created = parseStdout(
      runCwCli(
        ["create", "wave", "--slug", "w8-noinput", "--objective", "o"],
        e,
      ),
    );
    const unitId = created.unitId as string;
    // stdin 为空（runCwCli 不传 input 且子进程 stdin 无 pipe）→ 报缺 input
    const result = runCwCli(["plan", "--unitId", unitId], e);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("input");
  });
});

describe("W8: cw unit not found → exit 1（CwEngineError 语义）", () => {
  it("clarify 一个不存在的 unitId → exit 1 + unit_not_found", () => {
    const inputFile = join(e.workspaceDir, "ghost-input.json");
    writeFileSync(inputFile, JSON.stringify({ clarifications: [] }));
    const result = runCwCli(
      [
        "clarify",
        "--unitId",
        "wave:ghost",
        "--input",
        `${inputFile}`,
      ],
      e,
    );
    expect(result.exitCode).toBe(1);
    // CwEngineError message 含 unit not found（exit code 由 mapExitCode 映射，CwEngineError → 1）
    expect(result.stderr).toContain("unit not found");
  });

  it("create 后直接 execute（非法跳步）→ exit 1 + illegal_transition", () => {
    const created = parseStdout(
      runCwCli(
        ["create", "wave", "--slug", "w8-illegal", "--objective", "o"],
        e,
      ),
    );
    const unitId = created.unitId as string;
    const result = runCwCli(
      ["execute", "--unitId", unitId, "--commitHash", e.commitHash],
      e,
    );
    expect(result.exitCode).toBe(1);
    // CwEngineError 的 message 是 guard 的 reason（"action X not allowed from status Y"），
    // 由 mapExitCode 映射 exit 1。断言 reason 关键词，不断言 code 字段（code 不在 message 里）。
    expect(result.stderr).toContain("not allowed");
  });
});

describe("W8: v1 前缀已切断（Wave 3 起 cw 直接跟 action）", () => {
  it("cw v1 create（旧前缀）被拒为「未知 action v1」→ exit 1 + 提示改用 cw <action>", () => {
    // Wave 3 起去掉 v1 前缀：v1 不再是合法 action，走 main 的「未知 action」分支。
    const result = runCwCli(
      ["v1", "create", "--slug", "legacy-coexist", "--objective", "0.x"],
      e,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("未知 action");
    expect(result.stderr).toContain("v1");
  });

  it("v1 和 0.x 写各自的存储（CW_HOME）互不污染", () => {
    // v1 create 写 _v1.json（CW_HOME 下）
    runCwCli(
      ["create", "wave", "--slug", "iso-v1", "--objective", "o"],
      e,
    );
    // v1 存储存在
    expect(findV1Json(e.cwHome)).not.toBeNull();

    // 存储路径在 CW_HOME 下，不会写到其他地方。
    // 这里只验证 v1 侧 _v1.json 里只有 v1 的 workUnits（无 0.x topic 字段）。
    const v1Data = JSON.parse(readV1Json(findV1Json(e.cwHome)!)) as Record<
      string,
      unknown
    >;
    expect(Array.isArray(v1Data.workUnits)).toBe(true);
    expect(v1Data.topics).toBeUndefined(); // 0.x 的字段不在 v1 store
  });
});

describe("W8: cw execute slice（无 --commitHash，按 plan.split 创建 child wave）", () => {
  it("slice create→clarify→plan→design-review→execute（无 commitHash）→ status=executing + childUnitIds", () => {
    // slice execute 不需 --commitHash（wave 才需），CLI 需按 scope 区分。
    // 1. create slice
    const created = parseStdout(
      runCwCli(
        ["create", "slice", "--slug", "cli-slice-exec", "--objective", "o"],
        e,
      ),
    );
    expect(created.ok).toBe(true);
    const unitId = created.unitId as string;
    expect(unitId).toMatch(/^slice:/);

    // 2. clarify
    const clarifyInput = join(e.workspaceDir, "slice-clarify.json");
    writeFileSync(
      clarifyInput,
      JSON.stringify({
        clarifications: [
          { id: "Q1", status: "active", question: "token 存哪", resolution: "httpOnly cookie", type: "grilling" },
        ],
      }),
    );
    const clarified = parseStdout(
      runCwCli(["clarify", "--unitId", unitId, "--input", `${clarifyInput}`], e),
    );
    expect(clarified.status).toBe("clarifying");

    // 3. plan（合法 SlicePlan）
    const planInput = join(e.workspaceDir, "slice-plan.json");
    writeFileSync(planInput, JSON.stringify(makeValidSlicePlan()));
    const planned = parseStdout(
      runCwCli(["plan", "--unitId", unitId, "--input", `${planInput}`], e),
    );
    expect(planned.status).toBe("planning");

    // 4. design-review（过 gate → design-reviewed）
    const drInput = join(e.workspaceDir, "slice-dr.json");
    writeFileSync(
      drInput,
      JSON.stringify({ designReviewJudgment: makeValidSliceDesignReviewJudgment() }),
    );
    const dr = parseStdout(
      runCwCli(["design-review", "--unitId", unitId, "--input", `${drInput}`], e),
    );
    expect(dr.status).toBe("design-reviewed");

    // 5. execute（slice，不传 --commitHash）——核心修复验证点
    const executed = parseStdout(
      runCwCli(["execute", "--unitId", unitId], e),
    );
    expect(executed.ok).toBe(true);
    expect(executed.status).toBe("executing");
    // crossLayer.descend 指向第一个 child wave（execute handler 创建后填入 nextAction）
    const nextAction = executed.nextAction as { crossLayer?: { kind?: string; targetLayer?: string; targetUnitId?: string } };
    expect(nextAction.crossLayer).toBeDefined();
    expect(nextAction.crossLayer!.kind).toBe("descend");
    expect(nextAction.crossLayer!.targetLayer).toBe("wave");
    expect(typeof nextAction.crossLayer!.targetUnitId).toBe("string");
    // 落盘验证：slice 的 executeResult.childUnitIds 非空
    const v1Json = findV1Json(e.cwHome);
    expect(v1Json).not.toBeNull();
    const data = JSON.parse(readV1Json(v1Json!)) as {
      workUnits: Array<{ id: string; executeResult?: { childUnitIds?: string[] } }>;
    };
    const persisted = data.workUnits.find((u) => u.id === unitId);
    expect(persisted).toBeDefined();
    expect(persisted!.executeResult!.childUnitIds!.length).toBeGreaterThan(0);
    expect(persisted!.executeResult!.childUnitIds!).toContain(nextAction.crossLayer!.targetUnitId);
  });

  it("wave execute 仍要求 --commitHash（slice 修复不影响 wave）", () => {
    const created = parseStdout(
      runCwCli(["create", "wave", "--slug", "w8-wave-exec", "--objective", "o"], e),
    );
    const unitId = created.unitId as string;
    // wave execute 不传 --commitHash → exit 1
    const result = runCwCli(["execute", "--unitId", unitId], e);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--commitHash");
  });
});

describe("W8: cw plan --abandonParentItems flag 解析（ADR-0010 声明通道）", () => {
  // 共享辅助：create wave → clarify → 返回 unitId（plan.from 需 clarifying，必须先 clarify）。
  function createWaveToClarifying(slug: string): string {
    const created = parseStdout(
      runCwCli(["create", "wave", "--slug", slug, "--objective", "o"], e),
    );
    expect(created.ok).toBe(true);
    const unitId = created.unitId as string;
    const clarifyInput = join(e.workspaceDir, `${slug}-clarify.json`);
    writeFileSync(clarifyInput, JSON.stringify({ clarifications: [] }));
    parseStdout(
      runCwCli(
        ["clarify", "--unitId", unitId, "--input", `${clarifyInput}`],
        e,
      ),
    );
    return unitId;
  }

  // 共享辅助：写合法 WavePlan 到文件，返回路径。
  function writeWavePlan(fileName: string): string {
    const planInput = join(e.workspaceDir, fileName);
    writeFileSync(
      planInput,
      JSON.stringify({
        testCases: [makeValidTestCase()],
        tasks: [makeValidTask()],
        files: [makeValidFile()],
        contracts: [makeValidContract()],
      }),
    );
    return planInput;
  }

  // 共享辅助：从 store 读某 unit 的 abandonedParentItems。
  function readAbandonedParentItems(unitId: string): string[] {
    const v1Json = findV1Json(e.cwHome);
    expect(v1Json).not.toBeNull();
    const data = JSON.parse(readV1Json(v1Json!)) as {
      workUnits: Array<{ id: string; abandonedParentItems?: string[] }>;
    };
    const persisted = data.workUnits.find((u) => u.id === unitId);
    expect(persisted).toBeDefined();
    return persisted!.abandonedParentItems ?? [];
  }

  it("wave plan 带 --abandonParentItems '[\"TC1\"]' → input.abandonParentItems 被解析并落盘到 wave.abandonedParentItems", () => {
    const unitId = createWaveToClarifying("w8-abandon-flag");
    const planInput = writeWavePlan("wave-plan-abandon.json");

    const planned = parseStdout(
      runCwCli(
        [
          "plan",
          "--unitId",
          unitId,
          "--input",
          `${planInput}`,
          "--abandonParentItems",
          '["TC1"]',
        ],
        e,
      ),
    );
    expect(planned.ok).toBe(true);
    expect(planned.status).toBe("planning");

    // flag 经 parseJsonArg 解析 → handler 写入 store
    expect(readAbandonedParentItems(unitId)).toEqual(["TC1"]);
  });

  it("wave plan 带 --abandon-parent-items（kebab-case）→ 与 camelCase 等价（flag 兼容两种写法）", () => {
    // flag() 同时查 camelCase 和 kebab-case，验证 kebab-case 也能解析。
    const unitId = createWaveToClarifying("w8-abandon-kebab");
    const planInput = writeWavePlan("wave-plan-kebab.json");

    const planned = parseStdout(
      runCwCli(
        [
          "plan",
          "--unitId",
          unitId,
          "--input",
          `${planInput}`,
          "--abandon-parent-items",
          '["TC2","TC3"]',
        ],
        e,
      ),
    );
    expect(planned.ok).toBe(true);

    expect(readAbandonedParentItems(unitId)).toEqual(["TC2", "TC3"]);
  });

  it("wave plan 不带 --abandonParentItems → wave.abandonedParentItems 保持 [] （工厂初始化值）", () => {
    const unitId = createWaveToClarifying("w8-abandon-none");
    const planInput = writeWavePlan("wave-plan-none.json");

    const planned = parseStdout(
      runCwCli(
        ["plan", "--unitId", unitId, "--input", `${planInput}`],
        e,
      ),
    );
    expect(planned.ok).toBe(true);

    expect(readAbandonedParentItems(unitId)).toEqual([]);
  });

  it("--abandonParentItems 非 JSON 字符串 → exit 1 + JSON 解析失败提示", () => {
    // parseJsonArg 对非 JSON 字符串抛 CwError → exit 1（在 plan 落到 handler 之前）
    const unitId = createWaveToClarifying("w8-abandon-bad");
    const planInput = writeWavePlan("wave-plan-bad.json");

    const result = runCwCli(
      [
        "plan",
        "--unitId",
        unitId,
        "--input",
        `${planInput}`,
        "--abandonParentItems",
        "not-valid-json",
      ],
      e,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("abandonParentItems");
    expect(result.stderr).toContain("JSON");
  });
});

describe("W8: cw list --all 与 --cwd 互斥（TC-B6，cli 层 e2e）", () => {
  it("--all + --cwd 同时传 → exit 1 + 互斥错误信息", () => {
    // cli.ts:841-843 的互斥检查：--all 跨 cwd 遍历，--cwd 锁定单 cwd，语义冲突
    const result = runCwCli(
      ["list", "--all", "--cwd", e.workspaceDir],
      e,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mutually exclusive");
  });
});

// ── 辅助：在 CW_HOME 树里找 store.json ────────────────────────

function findV1Json(dir: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findV1Json(full);
      if (found) return found;
    } else if (entry.name === "store.json") {
      return full;
    }
  }
  return null;
}

function readV1Json(path: string): string {
  return readFileSync(path, "utf-8");
}

describe("W7b: buildLayerPromptGuidance 纯函数（create 缺 layer 的 guidance 内容）", () => {
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

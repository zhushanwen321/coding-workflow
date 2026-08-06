/**
 * v1 CLI 接入 e2e 测试（W8）。
 *
 * 通过真实子进程跑 `dist/cli.js v1 <action>`，验证：
 *   - cw create wave → JSON 含 nextAction.guidance 非空
 *   - 缺少必填参数 → exit 1 + 错误信息
 *   - v1 与 0.x 命令并存互不干扰（cw create 走 0.x，cw create 走 v1）
 *   - 推进 action（design）的 --input @file.json 管道
 *   - unit not found → exit 1 + CwEngineError 语义
 *
 * 复用 tests/helpers/git.ts 的 setupGitRepo（git 仓库初始化，v1/0.x 无关的通用基建）。
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
  makeValidDesignReviewJudgment,
  makeValidFile,
  makeValidTask,
  makeValidTestCase,
  makeValidTestJudgment,
} from "./helpers/env.js";
import { setupGitRepo } from "./helpers/git.js";
import {
  makeValidSliceDesignReviewJudgment,
  makeValidSlicePlan,
} from "./helpers/slice-env.js";

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
      ["design", "--input", "-"],
      e,
      { input: JSON.stringify({ testCases: [], tasks: [], files: [], contracts: [], testCommand: "npx vitest run" }) },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unitId");
  });
});

describe("W8: cw help / version（标准命令）", () => {
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

  it("cw --version → 同 cw version", () => {
    const result = runCwCli(["--version"], e);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(`cw ${expectedVersion}`);
  });

  it("cw -v → 同 cw version", () => {
    const result = runCwCli(["-v"], e);
    expect(result.exitCode).toBe(0);
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

  it("cw --help → 同 cw help", () => {
    const result = runCwCli(["--help"], e);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("用法");
  });

  it("cw -h → 同 cw help", () => {
    const result = runCwCli(["-h"], e);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("用法");
  });

  it("cw（无参）→ exit 0 + stdout 显示 help（Unix 惯例）", () => {
    const result = runCwCli([], e);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("用法");
    expect(result.stdout).toContain("create");
  });
});

describe("W8: cw design（推进 action，--input @file 管道）", () => {
  it("create → design（--input @file.json）→ status=designing + WavePlan 落盘", () => {
    // 1. 先 create 一个 wave
    const created = parseStdout(
      runCwCli(
        ["create", "wave", "--slug", "w8-design", "--objective", "o"],
        e,
      ),
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
      runCwCli(
        ["design", "--unitId", unitId, "--input", `${inputFile}`],
        e,
      ),
    );
    expect(designed.ok).toBe(true);
    expect(designed.status).toBe("designing");
    expect(designed.unitId).toBe(unitId);
    // design handler 不回吐整个 unit（只 create 才带 unit）；
    // 验证状态推进（status=designing）+ nextAction 指向下一步。
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

  it("design 用 stdin 传 input 也能跑通", () => {
    const created = parseStdout(
      runCwCli(
        ["create", "wave", "--slug", "w8-stdin", "--objective", "o"],
        e,
      ),
    );
    const unitId = created.unitId as string;
    const designed = parseStdout(
      runCwCli(
        ["design", "--unitId", unitId, "--input", "-"],
        e,
        {
          input: JSON.stringify({
            testCases: [makeValidTestCase()],
            tasks: [makeValidTask()],
            files: [makeValidFile()],
            contracts: [makeValidContract()],
            testCommand: "npx vitest run",
            clarifications: [],
          }),
        },
      ),
    );
    expect(designed.ok).toBe(true);
    expect(designed.status).toBe("designing");
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
    const result = runCwCli(["design", "--unitId", unitId], e);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("input");
  });
});

describe("W8: cw unit not found → exit 1（CwEngineError 语义）", () => {
  it("design 一个不存在的 unitId → exit 1 + unit_not_found", () => {
    const inputFile = join(e.workspaceDir, "ghost-input.json");
    writeFileSync(inputFile, JSON.stringify({ testCases: [], tasks: [], files: [], contracts: [], testCommand: "npx vitest run" }));
    const result = runCwCli(
      [
        "design",
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
    // create 写 store.json（CW_HOME 下）
    runCwCli(
      ["create", "wave", "--slug", "iso-v1", "--objective", "o"],
      e,
    );
    // 存储存在
    expect(findStoreJson(e.cwHome)).not.toBeNull();

    // 存储路径在 CW_HOME 下，不会写到其他地方。
    // 这里只验证 store.json 里只有当前 workUnits（无 0.x topic 字段）。
    const v1Data = JSON.parse(readStoreJson(findStoreJson(e.cwHome)!)) as Record<
      string,
      unknown
    >;
    expect(Array.isArray(v1Data.workUnits)).toBe(true);
    expect(v1Data.topics).toBeUndefined(); // 0.x 的字段不在 v1 store
  });
});

describe("W8: cw execute slice（无 --commitHash，按 plan.split 创建 child wave）", () => {
  it("slice create→design→design-review→execute（无 commitHash）→ status=executing + childUnitIds", () => {
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

    // 2. design（含 clarifications + 合法 SlicePlan）
    const designInput = join(e.workspaceDir, "slice-design.json");
    writeFileSync(
      designInput,
      JSON.stringify({
        ...makeValidSlicePlan(),
        clarifications: [
          { id: "Q1", status: "active", question: "token 存哪", resolution: "httpOnly cookie", type: "grilling" },
        ],
      }),
    );
    const designed = parseStdout(
      runCwCli(["design", "--unitId", unitId, "--input", `${designInput}`], e),
    );
    expect(designed.status).toBe("designing");

    // 3. design-review（过 gate → design-reviewed）
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
    const v1Json = findStoreJson(e.cwHome);
    expect(v1Json).not.toBeNull();
    const data = JSON.parse(readStoreJson(v1Json!)) as {
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

describe("W8: cw design --abandonParentItems flag 解析（ADR-0010 声明通道）", () => {
  // 共享辅助：create wave → design（带 clarifications + 合法 WavePlan）→ 返回 unitId（design.from 需 created，先 design 一次）。
  function createWaveToDesigning(slug: string): string {
    const created = parseStdout(
      runCwCli(["create", "wave", "--slug", slug, "--objective", "o"], e),
    );
    expect(created.ok).toBe(true);
    const unitId = created.unitId as string;
    const designInput = join(e.workspaceDir, `${slug}-design.json`);
    writeFileSync(
      designInput,
      JSON.stringify({
        ...JSON.parse(readFileSync(writeWavePlan(`${slug}-design-plan.json`), "utf-8")),
        clarifications: [],
      }),
    );
    parseStdout(
      runCwCli(
        ["design", "--unitId", unitId, "--input", `${designInput}`],
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
        testCommand: "npx vitest run",
      }),
    );
    return planInput;
  }

  // 共享辅助：从 store 读某 unit 的 abandonedParentItems。
  function readAbandonedParentItems(unitId: string): string[] {
    const v1Json = findStoreJson(e.cwHome);
    expect(v1Json).not.toBeNull();
    const data = JSON.parse(readStoreJson(v1Json!)) as {
      workUnits: Array<{ id: string; abandonedParentItems?: string[] }>;
    };
    const persisted = data.workUnits.find((u) => u.id === unitId);
    expect(persisted).toBeDefined();
    return persisted!.abandonedParentItems ?? [];
  }

  it("wave design 带 --abandonParentItems '[\"TC1\"]' → input.abandonParentItems 被解析并落盘到 wave.abandonedParentItems", () => {
    const unitId = createWaveToDesigning("w8-abandon-flag");
    const planInput = writeWavePlan("wave-plan-abandon.json");

    const designed = parseStdout(
      runCwCli(
        [
          "design",
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
    expect(designed.ok).toBe(true);
    expect(designed.status).toBe("designing");

    // flag 经 parseJsonArg 解析 → handler 写入 store
    expect(readAbandonedParentItems(unitId)).toEqual(["TC1"]);
  });

  it("wave design 带 --abandon-parent-items（kebab-case）→ 与 camelCase 等价（flag 兼容两种写法）", () => {
    // flag() 同时查 camelCase 和 kebab-case，验证 kebab-case 也能解析。
    const unitId = createWaveToDesigning("w8-abandon-kebab");
    const planInput = writeWavePlan("wave-plan-kebab.json");

    const designed = parseStdout(
      runCwCli(
        [
          "design",
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
    expect(designed.ok).toBe(true);

    expect(readAbandonedParentItems(unitId)).toEqual(["TC2", "TC3"]);
  });

  it("wave design 不带 --abandonParentItems → wave.abandonedParentItems 保持 [] （工厂初始化值）", () => {
    const unitId = createWaveToDesigning("w8-abandon-none");
    const planInput = writeWavePlan("wave-plan-none.json");

    const designed = parseStdout(
      runCwCli(
        ["design", "--unitId", unitId, "--input", `${planInput}`],
        e,
      ),
    );
    expect(designed.ok).toBe(true);

    expect(readAbandonedParentItems(unitId)).toEqual([]);
  });

  it("--abandonParentItems 非 JSON 字符串 → exit 1 + JSON 解析失败提示", () => {
    // parseJsonArg 对非 JSON 字符串抛 CwError → exit 1（在 design 落到 handler 之前）
    const unitId = createWaveToDesigning("w8-abandon-bad");
    const planInput = writeWavePlan("wave-plan-bad.json");

    const result = runCwCli(
      [
        "design",
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

// ═══════════════════════════════════════════════════════════════
// W2: flag 白名单 + per-command help（#5，D-019 合并 #11）
// ═══════════════════════════════════════════════════════════════

describe("W2: unknown flag 白名单校验（#5）", () => {
  it("T2.1: 拼错 flag（--unid）→ exit 1 + unknown flag + 合法 flag 列表", () => {
    // validateFlags 在 buildParams 之前拦截：不报「需要 --unitId」而是报 unknown flag
    const result = runCwCli(["design", "--unid", "wave:x"], e);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown flag --unid");
    expect(result.stderr).toContain("unitId");
  });

  it("T2.1: readonly action 同样拦截未知 flag（--bogus-flag 不再被静默忽略）", () => {
    const result = runCwCli(["list", "--bogus-flag"], e);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown flag --bogus-flag");
  });

  it("T2.3: 全局基础集全放行（--help/-h/--version/--workspace/--verbose）", () => {
    // --help → per-command help（exit 0，非 unknown flag）
    const help = runCwCli(["status", "--help"], e);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("合法 flags");
    // -h 同
    const h = runCwCli(["status", "-h"], e);
    expect(h.exitCode).toBe(0);
    expect(h.stdout).toContain("合法 flags");
    // --version → 版本输出
    const ver = runCwCli(["status", "--version"], e);
    expect(ver.exitCode).toBe(0);
    expect(ver.stdout).toContain("cw ");
    // --verbose + --workspace：list 正常渲染（不报 unknown flag）
    const list = runCwCli(["list", "--verbose", "--workspace", e.workspaceDir], e);
    expect(list.exitCode).toBe(0);
    expect(list.stderr).not.toContain("unknown flag");
  });

  it("create 缺 layer + 合法 flag → 仍走选层 guidance（validateFlags 不误伤，K-7）", () => {
    const result = runCwCli(["create", "--slug", "x", "--objective", "y"], e);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("选择 layer");
  });
});

describe("W2: per-command help 双入口（#11 并入 #5）", () => {
  it("T3.4: cw help <action> 显示合法 flag 列表（AC-6.1）", () => {
    const result = runCwCli(["help", "execute"], e);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("合法 flags");
    expect(result.stdout).toContain("--commitHash");
    expect(result.stdout).toContain("--unitId");
  });

  it("T3.5: cw <action> --help 与 cw help <action> 等价（AC-6.2）", () => {
    const a = runCwCli(["help", "execute"], e);
    const b = runCwCli(["execute", "--help"], e);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(b.stdout).toBe(a.stdout);
  });

  it("T3.6: cw help <未知> → exit 1（AC-6.3）", () => {
    const result = runCwCli(["help", "bogus-action"], e);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bogus-action");
  });

  it("cw help / cw --help / cw -h 仍是全局 help", () => {
    for (const args of [["help"], ["--help"], ["-h"]] as const) {
      const result = runCwCli([...args], e);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("工作流 action");
    }
  });
});

describe("W2: handler input shape 校验（#6，e2e）", () => {
  it("T2.4: design {} → CwError「input.testCases …」exit 1（非 crash exit 2）", () => {
    const created = parseStdout(
      runCwCli(
        ["create", "wave", "--slug", "w2-shape", "--objective", "shape e2e"],
        e,
      ),
    );
    const unitId = created.unitId as string;
    const result = runCwCli(["design", "--unitId", unitId, "--input", "-"], e, {
      input: "{}",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("input.testCases");
    // 非内部异常：不输出堆栈（exit 2 才有堆栈）
    expect(result.stderr).not.toContain("堆栈");
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

// ═══════════════════════════════════════════════════════════════
// W3（#10）：cw status 大字段默认截断 + --full 全量（T3.3，AC-4.3）
// ═══════════════════════════════════════════════════════════════

describe("W3: cw status 大字段默认截断 + --full 全量（#10，T3.3）", () => {
  it("status 默认截断大字段 + 提示 --full；--full 输出全量（AC-4.3）", () => {
    const unitId = "wave:w3-status";
    runCwCli(["create", "wave", "--slug", "w3-status", "--objective", "W3 状态截断测试"], e);
    // design 填超长 clarifications（触发大字段截断）
    const design = runCwCli(
      ["design", "--unitId", unitId],
      e,
      {
        input: JSON.stringify({
          clarifications: [
            { id: "Q1", status: "active", question: "x".repeat(600), resolution: "y".repeat(600), type: "grilling" },
          ],
          testCases: [makeValidTestCase()],
          tasks: [makeValidTask()],
          files: [makeValidFile()],
          contracts: [makeValidContract()],
          testCommand: "npx vitest run",
        }),
      },
    );
    expect(design.exitCode).toBe(0);

    // 默认：首行截断提示（设计 #10：输出首行提示），其余行仍是合法 JSON
    const s1 = runCwCli(["status", "--unitId", unitId], e);
    expect(s1.exitCode).toBe(0);
    expect(s1.stdout).toMatch(/^（字段已截断，用 --full 查看全量）/);
    const truncated = JSON.parse(
      s1.stdout.split("\n").slice(1).join("\n"),
    ) as { id: string };
    expect(truncated.id).toBe(unitId);

    // --full：无截断提示，clarifications 完整（question 长度 600）
    const s2 = runCwCli(["status", "--unitId", unitId, "--full"], e);
    expect(s2.exitCode).toBe(0);
    expect(s2.stdout).not.toMatch(/已截断/);
    const full = JSON.parse(s2.stdout) as {
      clarifications: Array<{ question: string }>;
    };
    expect(full.clarifications[0].question.length).toBe(600);
  });
});

// ═══════════════════════════════════════════════════════════════
// per-wave testCommand：testRunner 翻转（W2）
// ═══════════════════════════════════════════════════════════════

describe("W2(testCommand): testRunner 执行 per-wave plan.testCommand（翻转）", () => {
  /**
   * 独立 env 全链推进到 test（create → design → design-review → execute → test）。
   *
   * 用独立 env 而非共享 e：cw.config.json 写入会污染其他测试的 workspace。
   * gate 全过模式：testCases 默认 manual + testJudgment.note 非空（echo 无 vitest 计数，
   * testCasesExecuted 走 manual 退化验证分支），testsAllPass 只依赖 exit code。
   */
  function runWaveTest(
    opts: {
      testCommand: string;
      configCommand?: string;
      testCases?: Array<Record<string, unknown>>;
      testJudgment?: Record<string, unknown>;
      /** false 时停在 executing（test 由调用方控制时序，守卫场景用）。 */
      runTest?: boolean;
    },
  ): { result: CliResult; env: CwCliEnv; unitId: string; testInputPath: string } {
    const local = createCwCliEnv();
    if (opts.configCommand !== undefined) {
      writeFileSync(
        join(local.workspaceDir, "cw.config.json"),
        JSON.stringify({ testRunner: { command: opts.configCommand } }),
        "utf8",
      );
    }
    const slug = `tc-${Math.random().toString(36).slice(2, 8)}`;
    const unitId = `wave:${slug}`;
    // create → design
    const created = runCwCli(
      ["create", "wave", "--slug", slug, "--objective", "testCommand e2e"],
      local,
    );
    expect(created.exitCode, created.stderr).toBe(0);
    // design → designing（含 clarifications + WavePlan）
    const designInput = join(local.workspaceDir, `${slug}-design.json`);
    writeFileSync(
      designInput,
      JSON.stringify({
        clarifications: [],
        testCases: opts.testCases ?? [
          { ...makeValidTestCase("TC1"), type: "manual" },
        ],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
        testCommand: opts.testCommand,
      }),
    );
    const designed = runCwCli(
      ["design", "--unitId", unitId, "--input", designInput],
      local,
    );
    expect(designed.exitCode, designed.stderr).toBe(0);
    // design-review → design-reviewed
    const drInput = join(local.workspaceDir, `${slug}-dr.json`);
    writeFileSync(
      drInput,
      JSON.stringify({ designReviewJudgment: makeValidDesignReviewJudgment() }),
    );
    const dr = runCwCli(
      ["design-review", "--unitId", unitId, "--input", drInput],
      local,
    );
    expect(dr.exitCode, dr.stderr).toBe(0);
    // execute → executing
    const executed = runCwCli(
      ["execute", "--unitId", unitId, "--commitHash", local.commitHash],
      local,
    );
    expect(executed.exitCode, executed.stderr).toBe(0);
    // test
    const testInputPath = join(local.workspaceDir, `${slug}-test.json`);
    const judgment = opts.testJudgment ?? {
      ...makeValidTestJudgment(),
      sufficiencyMet: {
        ...makeValidTestJudgment().sufficiencyMet,
        note: "manual verified",
      },
    };
    writeFileSync(testInputPath, JSON.stringify({ testJudgment: judgment }));
    if (opts.runTest === false) {
      // 停在 executing：守卫场景由调用方改 store 模拟在途 wave 后再跑 test。
      return { result: executed, env: local, unitId, testInputPath };
    }
    const result = runCwCli(
      ["test", "--unitId", unitId, "--input", testInputPath],
      local,
    );
    return { result, env: local, unitId, testInputPath };
  }

  /** 从 store 改 plan.testCommand（模拟存量在途 wave 的 testCommand 形态）。 */
  function mutateStoredTestCommand(
    env: CwCliEnv,
    unitId: string,
    value: string | undefined,
  ): void {
    const v1Json = findStoreJson(env.cwHome)!;
    const data = JSON.parse(readStoreJson(v1Json)) as {
      workUnits: Array<{ id: string; plan?: Record<string, unknown> }>;
    };
    const unit = data.workUnits.find((u) => u.id === unitId);
    expect(unit).toBeDefined();
    if (value === undefined) {
      // 存量在途 wave：plan 无 testCommand 字段，加载为 undefined
      delete unit!.plan!.testCommand;
    } else {
      unit!.plan!.testCommand = value;
    }
    writeFileSync(v1Json, JSON.stringify(data, null, 2));
  }

  it("config.testRunner.command 废弃：CLI stderr 含「已废弃」warning（值不再用于执行）", () => {
    const local = createCwCliEnv();
    try {
      writeFileSync(
        join(local.workspaceDir, "cw.config.json"),
        JSON.stringify({ testRunner: { command: "npx vitest run" } }),
        "utf8",
      );
      // create 走 constructCwDeps → loadCwConfig → 发射 warning
      const created = runCwCli(
        ["create", "wave", "--slug", "cfg-dep", "--objective", "o"],
        local,
      );
      expect(created.exitCode, created.stderr).toBe(0);
      expect(created.stderr).toContain("已废弃");
    } finally {
      disposeCwCliEnv(local);
    }
  });

  it("testRunner 执行 unit.plan.testCommand 而非 config.command（shell 复合命令 + 故意必败 config 命令）", () => {
    const { result, env: local } = runWaveTest({
      testCommand: "echo a && echo b",
      // 若 testRunner 仍执行 config.command → testsAllPass fail；翻转后执行 echo → exit 0
      configCommand: "node -e \"process.exit(1)\"",
    });
    try {
      expect(result.exitCode, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as {
        status: string;
        gateResults?: Array<{ report: string; passed: boolean }>;
      };
      expect(parsed.status).toBe("tested");
      const allPass = parsed.gateResults?.find((g) =>
        g.report.startsWith("tests-all-pass"),
      );
      expect(allPass).toBeDefined();
      expect(allPass!.passed).toBe(true);
    } finally {
      disposeCwCliEnv(local);
    }
  });

  /** 解析 test action 的 stdout JSON，断言守卫短路语义（ok:false + testsAllPass 计数 0/0）。 */
  function expectGuardShortCircuit(result: CliResult): void {
    // gate fail 不是进程级错误：ok:false 序列化到 stdout，exit 0（crash 才是 exit 2 + 堆栈）
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      gateResults?: Array<{ report: string; passed: boolean }>;
    };
    expect(parsed.ok).toBe(false);
    const allPass = parsed.gateResults?.find((g) =>
      g.report.startsWith("tests-all-pass"),
    );
    expect(allPass).toBeDefined();
    expect(allPass!.passed).toBe(false);
    // 守卫短路返回 {passed:false, 0/0 计数}（而非 spawn 后真实计数）
    expect(allPass!.report).toContain("passed=0, failed=0");
    expect(result.stderr).not.toContain("堆栈");
  }

  it("testRunner 守卫：空串 testCommand → {passed:false, 0/0 计数}（不 spawn）", () => {
    // plan 阶段空串过不了 design-review 的 testCommandNonEmpty gate——
    // 空 testCommand 只能以在途 wave 形态存在（plan 时合法，之后被清空/迁移）。
    const { env: local, unitId, testInputPath } = runWaveTest({
      testCommand: "npx vitest run",
      runTest: false,
    });
    try {
      mutateStoredTestCommand(local, unitId, "");
      const result = runCwCli(
        ["test", "--unitId", unitId, "--input", testInputPath],
        local,
      );
      expectGuardShortCircuit(result);
    } finally {
      disposeCwCliEnv(local);
    }
  });

  it("testRunner 守卫：纯空白 testCommand → 同上短路（不跑空命令假通过）", () => {
    const { env: local, unitId, testInputPath } = runWaveTest({
      testCommand: "npx vitest run",
      runTest: false,
    });
    try {
      mutateStoredTestCommand(local, unitId, "   ");
      const result = runCwCli(
        ["test", "--unitId", unitId, "--input", testInputPath],
        local,
      );
      expectGuardShortCircuit(result);
    } finally {
      disposeCwCliEnv(local);
    }
  });

  it("testRunner 守卫：undefined testCommand（存量在途 wave 迁移场景）→ 同上短路", () => {
    const { env: local, unitId, testInputPath } = runWaveTest({
      testCommand: "npx vitest run",
      runTest: false,
    });
    try {
      // 存量在途 wave：plan 已过 design-review 但持久化 JSON 无 testCommand 字段（加载为 undefined）
      mutateStoredTestCommand(local, unitId, undefined);
      // 重跑 test → 守卫短路，不 crash（spawnSync(undefined, {shell:true}) 会抛 TypeError）
      const retry = runCwCli(
        ["test", "--unitId", unitId, "--input", testInputPath],
        local,
      );
      expectGuardShortCircuit(retry);
      // fail hint 同步给根因诊断（非误导性覆盖不足报告）
      const parsed = JSON.parse(retry.stdout.trim()) as { error?: string };
      expect(parsed.error).toContain("plan.testCommand 缺失");
    } finally {
      disposeCwCliEnv(local);
    }
  });
});

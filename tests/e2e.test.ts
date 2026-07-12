/**
 * e2e 测试 — E1-E4（真实子进程跑 dist/cli.js）。
 *
 * 测试策略：
 *   - 每个测试 beforeAll: git init tmp 目录 + 创建非空 commit（供 dev gate GitValidator 校验）
 *   - CW_HOME 指向 tmp 子目录，env 传递给子进程（per-cwd 隔离）
 *   - 用 spawnSync 真实 node 子进程调 dist/cli.js
 *   - 验证全链路：create → plan → dev → review → test → retrospect → closeout
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── 路径常量 ────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

// ── 子进程辅助 ──────────────────────────────────────────────

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * runCli — 真实子进程调 dist/cli.js。
 *
 * 关键：cwd 默认设为 workspaceDir，这样不传 --workspace 时，CLI 默认 workspacePath=process.cwd()
 * = workspaceDir，encodeCwd(workspaceDir) 一致，db 路径跨子命令一致。
 */
function runCli(
  args: string[],
  env: Record<string, string>,
  options: { input?: string; cwd?: string } = {},
): CliResult {
  const mergedEnv = {
    ...process.env,
    ...env,
    PATH: process.env.PATH ?? "",
  };
  const result = spawnSync("node", [CLI_PATH, ...args], {
    env: mergedEnv as NodeJS.ProcessEnv,
    encoding: "utf8",
    // cwd 默认 workspaceDir（CLI 默认 workspacePath=process.cwd()，保证 encodeCwd 一致）
    cwd: options.cwd ?? workspaceDir,
    input: options.input,
    timeout: 30000,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** 解析 CLI stdout 为 JSON。 */
function parseStdout(result: CliResult): Record<string, unknown> {
  expect(result.exitCode, `CLI exit code should be 0, stderr: ${result.stderr}`).toBe(0);
  const trimmed = result.stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed) as Record<string, unknown>;
}

// ── git 仓库辅助 ────────────────────────────────────────────

/** 在 tmp 目录 git init + 配置 + 创建非空 commit，返回 commit hash。 */
function setupGitRepo(repoDir: string): string {
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  git(["init"]);
  git(["config", "user.email", "e2e@test.com"]);
  git(["config", "user.name", "E2E Test"]);
  writeFileSync(join(repoDir, "README.md"), "# E2E test repo\n");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);
  return git(["rev-parse", "HEAD"]);
}

// ── 共享测试环境 ────────────────────────────────────────────

let workspaceDir: string;
let cwHome: string;
let env: Record<string, string>;
let commitHash: string;

beforeAll(() => {
  // 确认 dist/cli.js 已 build
  if (!existsSync(CLI_PATH)) {
    throw new Error(`dist/cli.js 不存在，请先 npm run build。路径: ${CLI_PATH}`);
  }

  workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "cw-e2e-ws-")));
  cwHome = realpathSync(mkdtempSync(join(tmpdir(), "cw-e2e-home-")));
  env = { CW_HOME: cwHome };
  commitHash = setupGitRepo(workspaceDir);
});

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(cwHome, { recursive: true, force: true });
});

// ── E1: 全链子进程跑通 ──────────────────────────────────────

describe("E1: create→plan→dev→review→test→retrospect→closeout 全链子进程跑通", () => {
  it("完整流程走通，最终 status=closed, evidence 写入", () => {
    // 1. create
    const createResult = parseStdout(
      runCli(
        ["create", "--slug", "e1-full", "--objective", "E2E 全链测试", "--workspace", workspaceDir],
        env,
      ),
    );
    expect(createResult.status).toBe("created");
    expect(createResult.topicId).toMatch(/^cw-\d{4}-\d{2}-\d{2}-e1-full$/);
    const topicId = createResult.topicId as string;
    const nextAction = createResult.nextAction as Record<string, unknown>;
    expect(nextAction.action).toBe("plan");

    // 2. plan（stdin 传 planJson）
    const planJson = JSON.stringify({
      format: "lite",
      objective: "E2E 全链测试",
      waves: [{ id: "W1", changes: ["实现功能"], dependsOn: [] }],
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "验证全链",
          steps: "跑 cw 命令",
          expected: { text: "exit code 0, output verified" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "real layer integration",
          steps: "run integration check",
          expected: { text: "integration verified" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const planResult = parseStdout(
      runCli(["plan", "--topicId", topicId], env, { input: planJson }),
    );
    expect(planResult.status).toBe("planned");
    expect((planResult.nextAction as Record<string, unknown>).action).toBe("dev");
    // plan 通过后 status=planned，replan 作为 alternative 暴露
    const planAlts = (planResult.nextAction as Record<string, unknown>).alternatives as
      | Array<{ action: string }>
      | undefined;
    expect(planAlts).toBeDefined();
    expect(planAlts![0].action).toBe("replan");

    // 3. dev
    const devResult = parseStdout(
      runCli(
        [
          "dev",
          "--topicId",
          topicId,
          "--tasks",
          JSON.stringify([{ waveId: "W1", commitHash }]),
        ],
        env,
      ),
    );
    expect(devResult.status).toBe("developed");
    expect(devResult.gatePassed).toMatchObject({ dev: true });
    // dev 全 committed 后 nextAction 指向 review（新状态机插在 dev/test 之间）
    expect((devResult.nextAction as Record<string, unknown>).action).toBe("review");

    // 4. review（需 review.md 文件，写到 .xyz-harness/<slug>/changes/review.md）
    const reviewDir = join(workspaceDir, ".xyz-harness", "e1-full", "changes");
    mkdirSync(reviewDir, { recursive: true });
    const reviewPath = join(reviewDir, "review.md");
    writeFileSync(reviewPath, "# Code Review\n\n审查通过");
    const reviewResult = parseStdout(
      runCli(
        ["review", "--topicId", topicId, "--reviewPath", reviewPath],
        env,
      ),
    );
    expect(reviewResult.status).toBe("reviewed");
    expect(reviewResult.gatePassed).toMatchObject({ review: true });
    expect((reviewResult.nextAction as Record<string, unknown>).action).toBe("test");

    // 5. test
    const testResult = parseStdout(
      runCli(
        [
          "test",
          "--topicId",
          topicId,
          "--cases",
          JSON.stringify([
            { caseId: "E1", actual: { text: "exit code 0, output verified" } },
            { caseId: "E2", actual: { text: "integration verified" } },
          ]),
        ],
        env,
      ),
    );
    expect(testResult.status).toBe("tested");
    expect(testResult.gatePassed).toMatchObject({ test: true });

    // 6. retrospect（需 retrospect.md 文件）
    const retrospectDir = join(workspaceDir, ".xyz-harness", "e1-full");
    mkdirSync(retrospectDir, { recursive: true });
    const retrospectPath = join(retrospectDir, "retrospect.md");
    writeFileSync(retrospectPath, "# Retrospect\n\nE2E 复盘内容");
    const retroResult = parseStdout(
      runCli(
        ["retrospect", "--topicId", topicId, "--retrospect-path", retrospectPath],
        env,
      ),
    );
    expect(retroResult.status).toBe("retrospected");
    expect((retroResult.nextAction as Record<string, unknown>).action).toBe("closeout");

    // 7. closeout
    const closeoutResult = parseStdout(
      runCli(["closeout", "--topicId", topicId], env),
    );
    expect(closeoutResult.status).toBe("closed");
    expect(closeoutResult.evidence).toBeDefined();
    const evidence = closeoutResult.evidence as Record<string, unknown>;
    expect(evidence.gateHistory).toBeDefined();
    expect((evidence.gateHistory as unknown[]).length).toBeGreaterThan(0);

    // 8. status 查询验证（只读子命令）
    const statusResult = parseStdout(
      runCli(["status", "--topicId", topicId], env),
    );
    expect(statusResult.status).toBe("closed");
  });
});

// ── E2: dev 阶段渐进式提交 ──────────────────────────────────

describe("E2: dev 阶段渐进式提交（progressive）", () => {
  it("多 wave 分多次 cw dev 调用，第二次 dev 不报 illegal_transition", () => {
    // create + plan（2 个 wave）
    const createResult = parseStdout(
      runCli(
        ["create", "--slug", "e2-progressive", "--objective", "渐进式测试", "--workspace", workspaceDir],
        env,
      ),
    );
    const topicId = createResult.topicId as string;

    const planJson = JSON.stringify({
      format: "lite",
      objective: "渐进式测试",
      waves: [
        { id: "W1", changes: ["wave1"], dependsOn: [] },
        { id: "W2", changes: ["wave2"], dependsOn: ["W1"] },
      ],
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "exit code 0, wave committed" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "real layer integration",
          steps: "run integration check",
          expected: { text: "integration verified" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    runCli(["plan", "--topicId", topicId], env, { input: planJson });

    // 第一次 dev：只提交 W1
    const dev1 = parseStdout(
      runCli(
        ["dev", "--topicId", topicId, "--tasks", JSON.stringify([{ waveId: "W1", commitHash }])],
        env,
      ),
    );
    expect(dev1.status).toBe("developed");
    expect(dev1.gatePassed).toMatchObject({ dev: false }); // W2 还没提交

    // 第二次 dev：提交 W2（progressive，不应报 illegal_transition）
    const dev2 = parseStdout(
      runCli(
        ["dev", "--topicId", topicId, "--tasks", JSON.stringify([{ waveId: "W2", commitHash }])],
        env,
      ),
    );
    expect(dev2.status).toBe("developed"); // 原地停留
    expect(dev2.gatePassed).toMatchObject({ dev: true }); // 全部 committed
    // dev 全 committed 后 nextAction 指向 review（新状态机插在 dev/test 之间）
    expect((dev2.nextAction as Record<string, unknown>).action).toBe("review");
  });
});

// ── E3: 非法跳步被拒绝 ──────────────────────────────────────

describe("E3: 非法跳步（created 直接到 test）被拒绝", () => {
  it("exit code 非 0 + stderr 含 illegal_transition", () => {
    const createResult = parseStdout(
      runCli(
        ["create", "--slug", "e3-skip", "--objective", "跳步测试", "--workspace", workspaceDir],
        env,
      ),
    );
    const topicId = createResult.topicId as string;

    // created 直接到 test（跳过 plan/dev）
    const result = runCli(
      ["test", "--topicId", topicId, "--cases", JSON.stringify([{ caseId: "E1", actual: {} }])],
      env,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("illegal_transition");
  });
});

// ── E4: replan 场景 ─────────────────────────────────────────

describe("E4: replan 场景（dev 中追加 wave）", () => {
  it("replan 追加 wave → status 回退 planned, append-only 校验生效", () => {
    // create + plan + dev W1
    const createResult = parseStdout(
      runCli(
        ["create", "--slug", "e4-replan", "--objective", "replan 测试", "--workspace", workspaceDir],
        env,
      ),
    );
    const topicId = createResult.topicId as string;

    const planJson = JSON.stringify({
      format: "lite",
      objective: "replan 测试",
      waves: [{ id: "W1", changes: ["w1"], dependsOn: [] }],
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "exit code 0, wave committed" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "real layer integration",
          steps: "run integration check",
          expected: { text: "integration verified" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    runCli(["plan", "--topicId", topicId], env, { input: planJson });
    runCli(
      ["dev", "--topicId", topicId, "--tasks", JSON.stringify([{ waveId: "W1", commitHash }])],
      env,
    );

    // replan：追加 W2（保留 W1）
    const newPlan = JSON.stringify({
      format: "lite",
      objective: "replan 测试（追加 W2）",
      waves: [
        { id: "W1", changes: ["w1"], dependsOn: [] },
        { id: "W2", changes: ["w2"], dependsOn: ["W1"] },
      ],
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "exit code 0, wave committed" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "real layer integration",
          steps: "run integration check",
          expected: { text: "integration verified" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const replanResult = parseStdout(
      runCli(["replan", "--topicId", topicId], env, { input: newPlan }),
    );
    // status 回退 planned（developed → planned）
    expect(replanResult.status).toBe("planned");

    // 验证 status 子命令看到 W1 + W2
    const statusResult = parseStdout(
      runCli(["status", "--topicId", topicId], env),
    );
    const waves = statusResult.waves as Array<{ id: string; committed: boolean }>;
    const waveIds = waves.map((w) => w.id).sort();
    expect(waveIds).toEqual(["W1", "W2"]);
    const w1 = waves.find((w) => w.id === "W1");
    expect(w1!.committed).toBe(true);

    // append-only 违规：删除已 committed 的 W1 → 应被拒绝
    const deletePlan = JSON.stringify({
      format: "lite",
      objective: "删 W1",
      waves: [],
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "exit code 0, wave committed" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "real layer integration",
          steps: "run integration check",
          expected: { text: "integration verified" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const deleteResult = runCli(
      ["replan", "--topicId", topicId],
      env,
      { input: deletePlan },
    );
    expect(deleteResult.exitCode).not.toBe(0);
    expect(deleteResult.stderr).toContain("wave_deleted_committed");
  });
});

// ── 补充：list 只读查询 ─────────────────────────────────────

describe("补充: list 只读查询子命令", () => {
  it("list 返回所有 topic 数组", () => {
    const result = parseStdout(runCli(["list"], env));
    expect(Array.isArray(result)).toBe(true);
    // E1-E4 已创建多个 topic，list 应非空
    expect((result as unknown[]).length).toBeGreaterThan(0);
  });
});

// ── 补充：db 文件确实落盘 ───────────────────────────────────

describe("补充: db 文件落盘验证", () => {
  it("_cw.json 存在于 CW_HOME 下", () => {
    // 编码后的 cwd 目录应存在 _cw.json
    const findDb = (dir: string): string | null => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = findDb(fullPath);
          if (found) return found;
        } else if (entry.name === "_cw.json") {
          return fullPath;
        }
      }
      return null;
    };
    const dbFile = findDb(cwHome);
    expect(dbFile).not.toBeNull();
    // 验证是合法 JSON
    const content = readFileSync(dbFile!, "utf8");
    const data = JSON.parse(content) as { topics: unknown[] };
    expect(data.topics.length).toBeGreaterThan(0);
  });
});

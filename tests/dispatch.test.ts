/**
 * dispatch 单测 — U19-U30（含 replan 4 拒绝路径 + gate fail 不变 + screenshot + test 渐进式）。
 *
 * 测试策略（src 设计决定）：
 *   - src 的 handleDev 调用 gate.ts 的 devCheck，devCheck 内部 `new GitValidator(workspacePath)`
 *     直接跑真实 git 子命令，不走 ActionDeps.git 注入。因此 dev gate 必须用真实 git 仓库。
 *   - store 用真实 CwStore 指向 tmp 文件。
 *   - git 用真实 GitValidator（在 git init 过的 tmp workspace 上跑）。
 *   - fileExistsCheck (retrospect/closeout) 用 tmp 文件真实验证。
 *
 * 注：ActionDeps.git 字段在 src 中实际未被任何 handler 使用（devCheck 自建 GitValidator），
 *     是 src 的设计冗余，测试中传入真实 GitValidator 即可。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { dispatch, GuardError } from "../src/dispatch.js";
import { CwStore } from "../src/store.js";
import { GitValidator } from "../src/gate.js";
import type { ActionDeps } from "../src/types.js";

// ── 真实 git 仓库辅助 ───────────────────────────────────────

/**
 * 在 tmp 目录 git init + 配置 user + 创建一个非空 commit，返回 commit hash。
 * 供 dev gate 的 GitValidator.validate 校验用（需真实存在的非空 commit）。
 */
function setupGitRepo(repoDir: string): string {
  // git 子命令在 repoDir 内执行
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  git(["init"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "user.name", "Test"]);

  // 创建一个非空文件并提交（保证 commit 非空，diff-tree 有内容）
  writeFileSync(join(repoDir, "README.md"), "# Test repo\n");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);
  return git(["rev-parse", "HEAD"]);
}

// ── 测试夹具 ────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;
let realCommitHash: string;

function makeDeps(): { deps: ActionDeps; store: CwStore } {
  const store = new CwStore(dbPath);
  const git = new GitValidator(tmpDir);
  const deps: ActionDeps = { store, git, workspacePath: tmpDir };
  return { deps, store };
}

function makeValidPlanJson(overrides: Record<string, unknown> = {}): unknown {
  return {
    format: "lite",
    objective: "test objective",
    waves: [
      { id: "W1", changes: ["change1"], dependsOn: [] },
    ],
    testCases: [
      {
        id: "E1",
        layer: "mock",
        scenario: "场景",
        steps: "步骤",
        expected: { text: "expected-output" },
        executor: "agent",
        requiresScreenshot: false,
      },
      {
        id: "E2",
        layer: "real",
        scenario: "集成场景",
        steps: "步骤",
        expected: { text: "real-output" },
        executor: "agent",
        requiresScreenshot: false,
      },
    ],
    ...overrides,
  };
}

/**
 * 在 developed 之后、test 之前手动注入 review gate pass（跳过文件创建）。
 *
 * 状态机新增 review action（插在 dev 和 test 之间）：test 的 expectedStatuses
 * 从 ["developed", "tested"] 改为 ["reviewed", "tested"]。所以测试里调 test 前
 * 必须先把 status 推进到 reviewed + 写一条 review pass 的 gateHistory。
 *
 * 直接操作 store 而非调 dispatch review（避免每个测试都建 review.md 文件）。
 */
function passReviewGate(store: CwStore, topicId: string): void {
  store.updateStatus(topicId, "reviewed");
  store.updateGatePassed(topicId, "review", true);
  store.appendGateHistory(topicId, {
    phase: "review",
    action: "review",
    gate: "file-exists+non-empty",
    result: "pass",
    progressive: false,
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cw-dispatch-test-"));
  dbPath = join(tmpDir, "cw.json");
  realCommitHash = setupGitRepo(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── U19: dispatch plan 合法 ─────────────────────────────────

describe("dispatch plan（U19）", () => {
  it("U19: 合法 planJson → 写入 waves/testCases, status=planned, nextAction=dev", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "u19", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;

    const result = dispatch(
      { action: "plan", topicId, planJson: makeValidPlanJson() },
      deps,
    );

    expect(result.status).toBe("planned");
    expect(result.nextAction.action).toBe("dev");

    const topic = store.loadTopic(topicId);
    expect(topic!.waves).toHaveLength(1);
    expect(topic!.waves[0]!.id).toBe("W1");
    expect(topic!.testCases).toHaveLength(2);
    expect(topic!.gatePassed.plan).toBe(true);
  });
});

// ── U19b: dispatch plan gate fail ───────────────────────────

describe("dispatch plan gate fail（U19b）", () => {
  it("U19b: format 非 lite → status 不变(仍 created), gateHistory append fail, nextAction 指回 plan", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "u19b", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;

    const result = dispatch(
      {
        action: "plan",
        topicId,
        planJson: { ...makeValidPlanJson(), format: "mid-clarify" },
      },
      deps,
    );

    expect(result.status).toBe("created");
    expect(result.nextAction.action).toBe("plan");
    const topic = store.loadTopic(topicId);
    const planFails = topic!.gateHistory.filter(
      (g) => g.phase === "plan" && g.result === "fail",
    );
    expect(planFails.length).toBeGreaterThanOrEqual(1);
    expect(topic!.gatePassed.plan).toBeFalsy();
  });
});

// ── U20-U21: dispatch dev ───────────────────────────────────

describe("dispatch dev（U20-U21）", () => {
  it("U20: 合法 commitHash → wave.committed 写入, gatePassed.dev 重算", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "u20", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);

    const result = dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );

    expect(result.status).toBe("developed");
    expect(result.gatePassed.dev).toBe(true);

    const topic = store.loadTopic(topicId);
    expect(topic!.waves[0]!.committed).toBe(realCommitHash);
  });

  it("U21: 无效 commitHash(不存在) → 该 wave 不写 committed, gate fail", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "u21", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);

    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: "nonexistent000000000000000000000000000000000000" }] },
      deps,
    );

    const topic = store.loadTopic(topicId);
    expect(topic!.waves[0]!.committed).toBeNull();
    // status 前进到 developed（progressive 语义），但 dev gate=false
    expect(topic!.status).toBe("developed");
  });

  it("U21b: 两个 wave 传同一 commitHash → 都 committed 但标记 extraCommitReuse warning", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "u21b", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    // plan 含 W1 + W2（无依赖）
    const twoWavePlan = makeValidPlanJson({
      waves: [
        { id: "W1", changes: ["change1"], dependsOn: [] },
        { id: "W2", changes: ["change2"], dependsOn: [] },
      ],
    });
    dispatch({ action: "plan", topicId, planJson: twoWavePlan }, deps);

    // W1 和 W2 传同一个 commitHash
    const result = dispatch(
      {
        action: "dev",
        topicId,
        tasks: [
          { waveId: "W1", commitHash: realCommitHash },
          { waveId: "W2", commitHash: realCommitHash },
        ],
      },
      deps,
    );

    // 两个 wave 都 committed（不阻断）
    const topic = store.loadTopic(topicId);
    expect(topic!.waves.find((w) => w.id === "W1")!.committed).toBe(realCommitHash);
    expect(topic!.waves.find((w) => w.id === "W2")!.committed).toBe(realCommitHash);

    // taskResults 标记 extraCommitReuse warning
    const taskResults = (result as Record<string, unknown>).taskResults as Array<{
      waveId: string;
      validation: { extraCommitReuse?: string[] };
    }>;
    expect(taskResults).toBeDefined();
    const w1Result = taskResults.find((t) => t.waveId === "W1")!;
    const w2Result = taskResults.find((t) => t.waveId === "W2")!;
    expect(w1Result.validation.extraCommitReuse).toContain("W2");
    expect(w2Result.validation.extraCommitReuse).toContain("W1");
  });
});

// ── U22-U24c: dispatch test ─────────────────────────────────

describe("dispatch test（U22-U24c）", () => {
  function setupTestTopic(): { topicId: string; deps: ActionDeps; store: CwStore } {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "test-u22", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    // 新状态机：test 要求 status=reviewed，dev 后先过 review gate。
    passReviewGate(store, topicId);
    return { topicId, deps, store };
  }

  it("U22: actual 匹配 expected → status=passed, gatePassed.test 重算", () => {
    const { topicId, deps, store } = setupTestTopic();
    const result = dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1", actual: { text: "expected-output" } },
          { caseId: "E2", actual: { text: "real-output" } },
        ],
      },
      deps,
    );

    const topic = store.loadTopic(topicId);
    expect(topic!.testCases[0]!.status).toBe("passed");
    expect(result.gatePassed.test).toBe(true);
    expect(result.status).toBe("tested");
  });

  it("U23: actual 不匹配 expected → status=failed, reason 含 mismatch", () => {
    const { topicId, deps, store } = setupTestTopic();
    const result = dispatch(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "E1", actual: { text: "wrong-output" } }],
      },
      deps,
    );

    const topic = store.loadTopic(topicId);
    expect(topic!.testCases[0]!.status).toBe("failed");
    expect(topic!.testCases[0]!.failureReason).toMatch(/text/);
    expect(result.gatePassed.test).toBe(false);

    const caseResults = (result as Record<string, unknown>).caseResults as Array<{
      status: string;
      failureReason?: string;
    }>;
    expect(caseResults[0]!.status).toBe("failed");
  });

  it("U24: caseId 不存在于 topic → throw not found", () => {
    const { topicId, deps } = setupTestTopic();
    expect(() =>
      dispatch(
        {
          action: "test",
          topicId,
          cases: [{ caseId: "E999-nonexistent", actual: { text: "x" } }],
        },
        deps,
      ),
    ).toThrow(/case not found/);
  });

  it("U24b: requiresScreenshot=true 但 screenshotPath 缺失 → status=failed", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "u24b", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    const planJson = {
      format: "lite",
      objective: "obj",
      waves: [{ id: "W1", changes: ["c"], dependsOn: [] }],
      testCases: [
        {
          id: "U1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "mock-output" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E1",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { text: "expected-output" },
          executor: "runner",
          requiresScreenshot: true,
        },
      ],
    };
    dispatch({ action: "plan", topicId, planJson }, deps);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    // 新状态机：test 要求 status=reviewed，dev 后先过 review gate。
    passReviewGate(store, topicId);

    // 不提供 screenshotPath
    const result = dispatch(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "E1", actual: { text: "expected-output" } }],
      },
      deps,
    );

    const topic = store.loadTopic(topicId);
    expect(topic!.testCases.find((c) => c.id === "E1")!.status).toBe("failed");
    expect(topic!.testCases.find((c) => c.id === "E1")!.failureReason).toMatch(/screenshot/i);
    expect(result.gatePassed.test).toBe(false);
  });

  it("U24b 补充: requiresScreenshot=true 且 screenshotPath 指向存在的文件 → passed", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "u24b-pass", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    const planJson = {
      format: "lite",
      objective: "obj",
      waves: [{ id: "W1", changes: ["c"], dependsOn: [] }],
      testCases: [
        {
          id: "U1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "mock-output" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E1",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { text: "expected-output" },
          executor: "runner",
          requiresScreenshot: true,
        },
      ],
    };
    dispatch({ action: "plan", topicId, planJson }, deps);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    // 新状态机：test 要求 status=reviewed，dev 后先过 review gate。
    passReviewGate(store, topicId);

    const screenshotPath = join(tmpDir, "screenshot.png");
    writeFileSync(screenshotPath, "fake png content");

    const result = dispatch(
      {
        action: "test",
        topicId,
        cases: [
          {
            caseId: "U1",
            actual: { text: "mock-output" },
          },
          {
            caseId: "E1",
            actual: { text: "expected-output" },
            screenshotPath,
          },
        ],
      },
      deps,
    );

    expect(result.gatePassed.test).toBe(true);
  });

  it("U24c: 第二次 test 提交（status=tested, progressive）→ 不报 illegal_transition", () => {
    const { topicId, deps } = setupTestTopic();
    dispatch(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "E1", actual: { text: "expected-output" } }],
      },
      deps,
    );

    // 第二次 test（progressive）不应报 illegal_transition
    expect(() =>
      dispatch(
        {
          action: "test",
          topicId,
          cases: [{ caseId: "E1", actual: { text: "expected-output" } }],
        },
        deps,
      ),
    ).not.toThrow();
  });
});

// ── dispatch review ─────────────────────────────────────────

describe("dispatch review", () => {
  function setupDevelopedTopic(): { topicId: string; deps: ActionDeps; store: CwStore } {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "review-test", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    return { topicId, deps, store };
  }

  it("review gate pass：传存在的报告文件 → status=reviewed, nextAction=test", () => {
    const { topicId, deps, store } = setupDevelopedTopic();
    // 创建 review.md 文件
    const reviewPath = join(tmpDir, "review.md");
    writeFileSync(reviewPath, "# Code Review\n审查通过");

    const result = dispatch(
      { action: "review", topicId, reviewPath },
      deps,
    );

    expect(result.status).toBe("reviewed");
    expect(result.gatePassed.review).toBe(true);
    expect(result.nextAction.action).toBe("test");

    // artifacts 记录了 review.md 路径 + 时间戳
    const topic = store.loadTopic(topicId);
    expect(topic!.artifacts?.reviewPath).toBe(reviewPath);
    expect(topic!.artifacts?.reviewAt).toBeDefined();
  });

  it("review gate fail：传不存在的路径 → status=developed, nextAction=review retry", () => {
    const { topicId, deps } = setupDevelopedTopic();

    const result = dispatch(
      { action: "review", topicId, reviewPath: "/nonexistent/review.md" },
      deps,
    );

    expect(result.status).toBe("developed");
    expect(result.gatePassed.review).toBeFalsy();
    expect(result.nextAction.action).toBe("review");
    expect((result as Record<string, unknown>).mustFix).toBeDefined();
  });
});

// ── U25-U29: dispatch replan ────────────────────────────────

describe("dispatch replan（U25-U29）", () => {
  function setupDevTopic(): { topicId: string; deps: ActionDeps; store: CwStore } {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "replan-test", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);
    return { topicId, deps, store };
  }

  it("U25: 合法追加 wave → replaceUncommittedWaves, status 回退 planned, gatePassed 重算", () => {
    const { topicId, deps, store } = setupDevTopic();
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    expect(store.loadTopic(topicId)!.status).toBe("developed");

    // replan 追加 W2（保留 W1）。新 plan 含 W1（已 committed，不变）+ W2（新增未 committed）。
    const newPlan = {
      format: "lite",
      objective: "obj",
      waves: [
        { id: "W1", changes: ["change1"], dependsOn: [] },
        { id: "W2", changes: ["change2"], dependsOn: ["W1"] },
      ],
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { text: "expected-output" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { text: "real-output" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    const result = dispatch({ action: "replan", topicId, planJson: newPlan }, deps);

    expect(result.status).toBe("planned");

    const topic = store.loadTopic(topicId);
    const waveIds = topic!.waves.map((w) => w.id).sort();
    expect(waveIds).toEqual(["W1", "W2"]);
    const w1 = topic!.waves.find((w) => w.id === "W1");
    expect(w1!.committed).toBe(realCommitHash);
    expect(topic!.gatePassed.dev).toBe(false);
  });

  it("U26: 新 plan 删除已 committed 的 wave → throw (wave_deleted_committed)", () => {
    const { topicId, deps } = setupDevTopic();
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );

    const newPlan = {
      format: "lite",
      objective: "obj",
      waves: [],
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { text: "expected-output" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { text: "real-output" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    expect(() => dispatch({ action: "replan", topicId, planJson: newPlan }, deps)).toThrow(
      /wave_deleted_committed/,
    );
  });

  it("U27: 新 plan 修改已 committed wave 的 changes → throw (wave_modified_committed)", () => {
    const { topicId, deps } = setupDevTopic();
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );

    const newPlan = {
      format: "lite",
      objective: "obj",
      waves: [
        { id: "W1", changes: ["modified-change"], dependsOn: [] },
      ],
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { text: "expected-output" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { text: "real-output" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    expect(() => dispatch({ action: "replan", topicId, planJson: newPlan }, deps)).toThrow(
      /wave_modified_committed/,
    );
  });

  it("U28: 新 plan 删除已 passed 的 testCase → throw (case_deleted_passed)", () => {
    const { topicId, deps, store } = setupDevTopic();
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    // 新状态机：test 要求 status=reviewed，dev 后先过 review gate。
    passReviewGate(store, topicId);
    dispatch(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "E1", actual: { text: "expected-output" } }],
      },
      deps,
    );
    // status=tested，replan guard 不允许。手动回退到 developed + 标记 E1 passed。
    store.updateTestCase(topicId, "E1", { status: "passed" });
    store.updateStatus(topicId, "developed");

    const newPlan = {
      format: "lite",
      objective: "obj",
      waves: [{ id: "W1", changes: ["change1"], dependsOn: [] }],
      testCases: [
        { id: "E2", layer: "mock", scenario: "s", steps: "st", expected: { text: "mock-output" }, executor: "agent", requiresScreenshot: false },
        { id: "E3", layer: "real", scenario: "s", steps: "st", expected: { text: "real-output" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    expect(() => dispatch({ action: "replan", topicId, planJson: newPlan }, deps)).toThrow(
      /case_deleted_passed/,
    );
  });

  it("U29: 新 plan 修改已 passed testCase 的 expected → throw (case_modified_passed)", () => {
    const { topicId, deps, store } = setupDevTopic();
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    // 新状态机：test 要求 status=reviewed，dev 后先过 review gate。
    passReviewGate(store, topicId);
    dispatch(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "E1", actual: { text: "expected-output" } }],
      },
      deps,
    );
    store.updateTestCase(topicId, "E1", { status: "passed" });
    store.updateStatus(topicId, "developed");

    const newPlan = {
      format: "lite",
      objective: "obj",
      waves: [{ id: "W1", changes: ["change1"], dependsOn: [] }],
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { text: "modified-expected" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { text: "real-output" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    expect(() => dispatch({ action: "replan", topicId, planJson: newPlan }, deps)).toThrow(
      /case_modified_passed/,
    );
  });

  it("replan 从 tested 状态可调用（rename 后改 expected 场景）→ status 回退 planned", () => {
    const { topicId, deps, store } = setupDevTopic();
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    // 推进到 reviewed（模拟 review gate pass）
    store.updateStatus(topicId, "reviewed");
    store.updateGatePassed(topicId, "review", true);
    // 推进到 tested（模拟 test gate pass）
    store.updateStatus(topicId, "tested");
    store.updateGatePassed(topicId, "test", true);
    expect(store.loadTopic(topicId)!.status).toBe("tested");

    // 从 tested 调 replan，修改未 passed 的 testCase expected
    // （原 plan 的 E1/E2 还没真正 passed via dispatch test，这里手动改 status 模拟）
    const newPlan = {
      format: "lite",
      objective: "obj",
      waves: [{ id: "W1", changes: ["change1"], dependsOn: [] }],
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { text: "corrected-expected" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { text: "corrected-real" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    const result = dispatch({ action: "replan", topicId, planJson: newPlan }, deps);

    expect(result.status).toBe("planned");
  });
});

// ── U30: dispatch closeout ──────────────────────────────────

describe("dispatch closeout（U30）", () => {
  it("U30: 合法归档 → evidence 写入(含 gateHistory 快照), status=closed", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "u30", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    // 新状态机：test 要求 status=reviewed，dev 后先过 review gate。
    passReviewGate(store, topicId);
    dispatch(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "E1", actual: { text: "expected-output" } }],
      },
      deps,
    );

    // retrospect（需提供 retrospect.md 文件）
    const retrospectDir = join(tmpDir, ".xyz-harness", "u30");
    mkdirSync(retrospectDir, { recursive: true });
    const retrospectPath = join(retrospectDir, "retrospect.md");
    writeFileSync(retrospectPath, "# Retrospect\n\n复盘内容");
    dispatch({ action: "retrospect", topicId, retrospectPath }, deps);

    // closeout：topicDir = tmpDir/.xyz-harness/u30（目录，已由上面 mkdir 创建）
    const result = dispatch({ action: "closeout", topicId }, deps);

    expect(result.status).toBe("closed");
    expect(result.gatePassed.closeout).toBe(true);

    const topic = store.loadTopic(topicId);
    expect(topic!.status).toBe("closed");
    expect(topic!.evidence).toBeDefined();
    expect(topic!.evidence!.gateHistory.length).toBeGreaterThan(0);
    const phases = topic!.evidence!.gateHistory.map((g) => g.phase);
    expect(phases).toContain("plan");
    expect(phases).toContain("dev");
    expect(phases).toContain("review");
    expect(phases).toContain("test");
    // retrospect artifact 记录了路径 + 时间戳
    expect(topic!.artifacts?.retrospectPath).toBe(retrospectPath);
    expect(topic!.artifacts?.retrospectAt).toBeDefined();
    expect(phases).toContain("retrospect");
    expect(phases).toContain("closeout");
  });
});

// ── 补充：guard 拒绝路径（GuardError） ──────────────────────

describe("dispatch guard 拒绝（GuardError）", () => {
  it("非法跳步 → throw GuardError(code=illegal_transition)", () => {
    const { deps } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "guard-test", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    expect(() =>
      dispatch(
        {
          action: "test",
          topicId,
          cases: [{ caseId: "E1", actual: {} }],
        },
        deps,
      ),
    ).toThrow(GuardError);
  });

  it("topic 不存在（非 create）→ throw", () => {
    const { deps } = makeDeps();
    expect(() =>
      dispatch(
        {
          action: "plan",
          topicId: "cw-nonexistent",
          planJson: makeValidPlanJson(),
        },
        deps,
      ),
    ).toThrow(/topic not found/);
  });
});

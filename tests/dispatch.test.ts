/**
 * dispatch 单测 — U19-U30（含 replan 4 拒绝路径 + gate fail 不变 + screenshot + test 渐进式）。
 *
 * 测试策略（src 设计决定）：
 *   - handleDev 调 devCheck(deps.git, ...)，devCheck 用注入的 GitValidator 跑真实 git 子命令。
 *     dev gate 必须用真实 git 仓库（GitValidator.validate 调 git rev-parse/cat-file/diff-tree）。
 *   - store 用真实 CwStore 指向 tmp 文件。
 *   - git 用真实 GitValidator（在 git init 过的 tmp workspace 上跑）。
 *   - fileExistsCheck (retrospect/closeout) 用 tmp 文件真实验证。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach,beforeEach, describe, expect, it } from "vitest";

import { dispatch, GuardError } from "../src/dispatch.js";
import { GitValidator } from "../src/gate.js";
import { CwStore } from "../src/store.js";
import type { ActionDeps, Expected } from "../src/types.js";
import { setupGitRepo } from "./helpers/git.js";
import {
  makeValidClarifyJson,
  makeValidDevPlanJson,
  makeValidPlanJson,
  makeValidTestJson,
} from "./helpers/plan.js";

// ── 测试夹具（setupGitRepo/makeValidPlanJson 从 helpers/ import） ──

let tmpDir: string;
let dbPath: string;
let realCommitHash: string;

function makeDeps(): { deps: ActionDeps; store: CwStore } {
  const store = new CwStore(dbPath);
  const git = new GitValidator(tmpDir);
  const deps: ActionDeps = { store, git, workspacePath: tmpDir };
  return { deps, store };
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

/**
 * 在 plan 之后、dev 之前手动注入 tdd_plan gate pass（跳过 test.json 提交）。
 *
 * 状态机新增 tdd_plan action（插在 plan 和 dev 之间）：dev 的 expectedStatuses
 * 从 ["planned", "developed"] 改为 ["tdd_inited", "developed"]。所以测试里调 dev 前
 * 必须先把 status 推进到 tdd_inited + 写 testCases + 一条 tdd_plan pass 的 gateHistory。
 *
 * 直接操作 store 而非调 dispatch tdd_plan（避免每个测试都构造 test.json + 过 gate）。
 */
function passTddPlanGate(store: CwStore, topicId: string): void {
  store.insertTestCases(topicId, [
    {
      id: "E1",
      layer: "mock",
      scenario: "单测场景",
      steps: "执行单测",
      expected: { type: "exact", text: "expected-output" },
      executor: "vitest",
      requiresScreenshot: false,
    },
    {
      id: "E2",
      layer: "real",
      scenario: "集成场景",
      steps: "执行集成测试",
      expected: { type: "exact", text: "real-output" },
      executor: "vitest",
      requiresScreenshot: false,
    },
  ]);
  store.updateStatus(topicId, "tdd_inited");
  store.updateGatePassed(topicId, "tdd_plan", true);
  store.appendGateHistory(topicId, {
    phase: "tdd_plan",
    action: "tdd_plan",
    gate: "test-json-schema",
    result: "pass",
    progressive: false,
  });
}

/**
 * 仅推进 tdd_plan gate 状态（不重新 insertTestCases）。
 *
 * 用于 testCases 已通过 legacy plan.json 路径写入的场景（U24b 系列），
 * 避免重复插入造成主键冲突。只更新 status / gatePassed / gateHistory。
 */
function passTddPlanGateStatus(store: CwStore, topicId: string): void {
  store.updateStatus(topicId, "tdd_inited");
  store.updateGatePassed(topicId, "tdd_plan", true);
  store.appendGateHistory(topicId, {
    phase: "tdd_plan",
    action: "tdd_plan",
    gate: "test-json-schema",
    result: "pass",
    progressive: false,
  });
}

/**
 * 在 create 之后、plan 之前手动注入 confirm_clarify gate pass（跳过 confirm gate）。
 *
 * 状态机新增 confirm_clarify action（插在 create 和 plan 之间）：plan 的
 * expectedStatuses 从 ["created"] 改为 ["clarify_confirmed", "planned"]。所以测试里
 * 调 plan 前必须先把 status 推进到 clarify_confirmed + 标记 confirm_clarify gate pass。
 *
 * 直接操作 store 而非调 dispatch confirm_clarify（这些测试不是测 clarify 流程的，
 * 避免每个测试都先构造 resolved clarifyRecord 过 confirm gate）。
 */
function confirmClarify(store: CwStore, topicId: string): void {
  store.updateStatus(topicId, "clarify_confirmed");
  store.updateGatePassed(topicId, "confirm_clarify", true);
}

/**
 * FR-4: 在 confirm_clarify 之后、plan 之前手动注入 spec_review gate pass。
 *
 * 状态机新增 spec_review action（插在 confirm_clarify 和 plan 之间）：plan 的
 * expectedStatuses 从 ["clarify_confirmed", "planned"] 改为 ["spec_reviewed", "planned"]。
 * 所以测试里调 plan 前必须先把 status 推进到 spec_reviewed + 标记 spec_review gate pass。
 *
 * 直接操作 store 而非调 dispatch spec_review（这些测试不是测 spec_review 流程的，
 * 避免每个测试都先构造 spec-review.md 文件 + 空 issues）。
 */
function passSpecReview(store: CwStore, topicId: string): void {
  store.updateStatus(topicId, "spec_reviewed");
  store.updateGatePassed(topicId, "spec_review", true);
}

/**
 * FR-5: 在 plan 之后、tdd_plan 之前手动注入 plan_review gate pass。
 *
 * 状态机新增 plan_review action（插在 plan 和 tdd_plan 之间）：tdd_plan 的
 * expectedStatuses 从 ["planned", "tdd_inited"] 改为 ["plan_reviewed", "tdd_inited"]。
 * 所以测试里调 tdd_plan（或 passTddPlanGate）前必须先把 status 推进到 plan_reviewed
 * + 标记 plan_review gate pass。
 *
 * 直接操作 store 而非调 dispatch plan_review（这些测试不是测 plan_review 流程的，
 * 避免每个测试都先构造 plan-review.md 文件 + 空 issues）。
 */
function passPlanReview(store: CwStore, topicId: string): void {
  store.updateStatus(topicId, "plan_reviewed");
  store.updateGatePassed(topicId, "plan_review", true);
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
  it("U19: 合法 planJson → 写入 waves, status=planned, nextAction=tdd_plan", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "u19", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);

    const result = dispatch(
      { action: "plan", topicId, planJson: makeValidPlanJson() },
      deps,
    );

    expect(result.status).toBe("planned");
    // plan gate 通过 → 进入 plan_review 阶段（FR-5: 审查 plan 是否覆盖 spec）
    expect(result.nextAction.action).toBe("plan_review");

    const topic = store.loadTopic(topicId);
    expect(topic!.waves).toHaveLength(1);
    expect(topic!.waves[0]!.id).toBe("W1");
    // 向后兼容：旧格式 plan.json 含 testCases → 自动提取为 legacyTestCases 写入
    expect(topic!.testCases).toHaveLength(2);
    expect(topic!.gatePassed.plan).toBe(true);
  });

  it("U19 补充: 新格式 dev-plan.json（只含 waves，无 testCases）→ testCases 为空, status=planned", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "u19-new", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);

    const result = dispatch(
      { action: "plan", topicId, planJson: makeValidDevPlanJson() },
      deps,
    );

    expect(result.status).toBe("planned");
    expect(result.nextAction.action).toBe("plan_review");

    const topic = store.loadTopic(topicId);
    expect(topic!.waves).toHaveLength(1);
    // 新格式不含 testCases → testCases 为空（等 tdd_plan 阶段提交）
    expect(topic!.testCases).toHaveLength(0);
    expect(topic!.gatePassed.plan).toBe(true);
  });
});

// ── U19b: dispatch plan gate fail ───────────────────────────

describe("dispatch plan gate fail（U19b）", () => {
  it("U19b: format 非 lite → status 不变(仍 clarify_confirmed), gateHistory append fail, nextAction 指回 plan", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "u19b", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);

    const result = dispatch(
      {
        action: "plan",
        topicId,
        planJson: { ...makeValidPlanJson(), format: "mid-clarify" },
      },
      deps,
    );

    expect(result.status).toBe("spec_reviewed");
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
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);
    // 新状态机：dev 要求 status=tdd_inited，plan 后先过 plan_review → tdd_plan gate。
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);

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
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);
    // 新状态机：dev 要求 status=tdd_inited，plan 后先过 plan_review → tdd_plan gate。
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);

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
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    // plan 含 W1 + W2（无依赖）
    const twoWavePlan = makeValidPlanJson({
      waves: [
        { id: "W1", changes: [{ file: "src/app.ts", description: "change1" }], dependsOn: [] },
        { id: "W2", changes: [{ file: "src/app.ts", description: "change2" }], dependsOn: [] },
      ],
    });
    dispatch({ action: "plan", topicId, planJson: twoWavePlan }, deps);
    // 新状态机：dev 要求 status=tdd_inited，plan 后先过 plan_review → tdd_plan gate。
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);

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
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    // 新格式 dev-plan.json（不含 testCases），testCases 由 passTddPlanGate 注入。
    dispatch({ action: "plan", topicId, planJson: makeValidDevPlanJson() }, deps);
    // 新状态机：dev 要求 status=tdd_inited，plan 后先过 plan_review → tdd_plan gate（同时写 testCases）。
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);
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
        cases: [
          { caseId: "E1", actual: { text: "wrong-output" } },
          { caseId: "E2", actual: { text: "real-output" } },
        ],
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

  it("U24: caseId 不存在于 topic → throw（D 全覆盖校验：多余 id）", () => {
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
    ).toThrow(/不一致|多余/);
  });

  it("U24b: requiresScreenshot=true 但 screenshotPath 缺失 → status=failed", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "u24b", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    const planJson = {
      format: "lite",
      objective: "obj",
      waves: [{ id: "W1", changes: [{ file: "src/app.ts", description: "c" }], dependsOn: [] }],
      testCases: [
        {
          id: "U1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "mock-output" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E1",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "expected-output" },
          executor: "runner",
          requiresScreenshot: true,
        },
      ],
    };
    dispatch({ action: "plan", topicId, planJson }, deps);
    // 新状态机：dev 要求 status=tdd_inited，plan 后先过 plan_review。
    // 这里 testCases 已通过 legacy 路径写入，只需推进 status + gate（不重复 insert）。
    passPlanReview(store, topicId);
    passTddPlanGateStatus(store, topicId);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    // 新状态机：test 要求 status=reviewed，dev 后先过 review gate。
    passReviewGate(store, topicId);

    // 不提供 screenshotPath（E1 requiresScreenshot=true）
    const result = dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "U1", actual: { text: "mock-output" } },
          { caseId: "E1", actual: { text: "expected-output" } },
        ],
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
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    const planJson = {
      format: "lite",
      objective: "obj",
      waves: [{ id: "W1", changes: [{ file: "src/app.ts", description: "c" }], dependsOn: [] }],
      testCases: [
        {
          id: "U1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "mock-output" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E1",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "expected-output" },
          executor: "runner",
          requiresScreenshot: true,
        },
      ],
    };
    dispatch({ action: "plan", topicId, planJson }, deps);
    // 新状态机：dev 要求 status=tdd_inited，plan 后先过 plan_review（testCases 已 via legacy 写入，只推进 status）。
    passPlanReview(store, topicId);
    passTddPlanGateStatus(store, topicId);
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
        cases: [
          { caseId: "E1", actual: { text: "expected-output" } },
          { caseId: "E2", actual: { text: "real-output" } },
        ],
      },
      deps,
    );

    // 第二次 test（progressive）不应报 illegal_transition
    expect(() =>
      dispatch(
        {
          action: "test",
          topicId,
          cases: [
            { caseId: "E1", actual: { text: "expected-output" } },
            { caseId: "E2", actual: { text: "real-output" } },
          ],
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
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);
    // 新状态机：dev 要求 status=tdd_inited，plan 后先过 plan_review → tdd_plan gate。
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    return { topicId, deps, store };
  }

  it("review gate pass：传存在的报告文件 + issues=[] → status=reviewed, nextAction=test", () => {
    const { topicId, deps, store } = setupDevelopedTopic();
    // 创建 review.md 文件
    const reviewPath = join(tmpDir, "review.md");
    writeFileSync(reviewPath, "# Code Review\n审查通过");

    const result = dispatch(
      { action: "review", topicId, reviewPath, issues: [] },
      deps,
    );

    expect(result.status).toBe("reviewed");
    expect(result.gatePassed.review).toBe(true);
    expect(result.nextAction.action).toBe("test");

    // artifacts 记录了 review.md 路径 + 时间戳（FR-1 重构后为嵌套结构 review.path/review.at）
    const topic = store.loadTopic(topicId);
    expect(topic!.artifacts?.review?.path).toBe(reviewPath);
    expect(topic!.artifacts?.review?.at).toBeDefined();
  });

  it("review gate fail：传不存在的路径 → status=developed, nextAction=review retry", () => {
    const { topicId, deps } = setupDevelopedTopic();

    const result = dispatch(
      { action: "review", topicId, reviewPath: "/nonexistent/review.md", issues: [] },
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
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);
    // 新状态机：dev 要求 status=tdd_inited，plan 后先过 plan_review → tdd_plan gate。
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);
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
        { id: "W1", changes: [{ file: "src/app.ts", description: "change1" }], dependsOn: [] },
        { id: "W2", changes: [{ file: "src/app.ts", description: "change2" }], dependsOn: ["W1"] },
      ],
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { type: "exact", text: "expected-output" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { type: "exact", text: "real-output" }, executor: "agent", requiresScreenshot: false },
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
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { type: "exact", text: "expected-output" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { type: "exact", text: "real-output" }, executor: "agent", requiresScreenshot: false },
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
        { id: "W1", changes: [{ file: "src/app.ts", description: "modified-change" }], dependsOn: [] },
      ],
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { type: "exact", text: "expected-output" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { type: "exact", text: "real-output" }, executor: "agent", requiresScreenshot: false },
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
        cases: [
          { caseId: "E1", actual: { text: "expected-output" } },
          { caseId: "E2", actual: { text: "real-output" } },
        ],
      },
      deps,
    );
    // status=tested，replan guard 不允许。手动回退到 developed + 标记 E1 passed。
    store.updateTestCase(topicId, "E1", { status: "passed" });
    store.updateStatus(topicId, "developed");

    const newPlan = {
      format: "lite",
      objective: "obj",
      waves: [{ id: "W1", changes: [{ file: "src/app.ts", description: "change1" }], dependsOn: [] }],
      testCases: [
        { id: "E2", layer: "mock", scenario: "s", steps: "st", expected: { type: "exact", text: "mock-output" }, executor: "agent", requiresScreenshot: false },
        { id: "E3", layer: "real", scenario: "s", steps: "st", expected: { type: "exact", text: "real-output" }, executor: "agent", requiresScreenshot: false },
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
        cases: [
          { caseId: "E1", actual: { text: "expected-output" } },
          { caseId: "E2", actual: { text: "real-output" } },
        ],
      },
      deps,
    );
    store.updateTestCase(topicId, "E1", { status: "passed" });
    store.updateStatus(topicId, "developed");

    const newPlan = {
      format: "lite",
      objective: "obj",
      waves: [{ id: "W1", changes: [{ file: "src/app.ts", description: "change1" }], dependsOn: [] }],
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { type: "exact", text: "modified-expected" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { type: "exact", text: "real-output" }, executor: "agent", requiresScreenshot: false },
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
      waves: [{ id: "W1", changes: [{ file: "src/app.ts", description: "change1" }], dependsOn: [] }],
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { type: "exact", text: "corrected-expected" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { type: "exact", text: "corrected-real" }, executor: "agent", requiresScreenshot: false },
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
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);
    // 新状态机：dev 要求 status=tdd_inited，plan 后先过 plan_review → tdd_plan gate。
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);
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
        cases: [
          { caseId: "E1", actual: { text: "expected-output" } },
          { caseId: "E2", actual: { text: "real-output" } },
        ],
      },
      deps,
    );

    // retrospect（需提供 retrospect.md 文件 + retrospectData 结构化数据）
    const retrospectDir = join(tmpDir, ".xyz-harness", "u30");
    mkdirSync(retrospectDir, { recursive: true });
    const retrospectPath = join(retrospectDir, "retrospect.md");
    writeFileSync(retrospectPath, "# Retrospect\n\n复盘内容");
    dispatch(
      {
        action: "retrospect",
        topicId,
        retrospectPath,
        retrospectData: { knownRisks: [], processIssues: [] },
      },
      deps,
    );

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
    expect(topic!.artifacts?.retrospect?.path).toBe(retrospectPath);
    expect(topic!.artifacts?.retrospect?.at).toBeDefined();
    expect(phases).toContain("retrospect");
    expect(phases).toContain("closeout");
  });

  it("U30 补充: closeout 后 evidence.coverage 填充测试通过率（杠杆 4）", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "u30-cov", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    // 用 makeValidDevPlanJson（不含 testCases），避免 legacy testCases 与 passTddPlanGate 重复写入
    dispatch({ action: "plan", topicId, planJson: makeValidDevPlanJson() }, deps);
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    // 全部 testCase passed（E1 + E2）
    dispatch(
      { action: "test", topicId, cases: [
        { caseId: "E1", actual: { text: "expected-output" } },
        { caseId: "E2", actual: { text: "real-output" } },
      ] },
      deps,
    );
    const retrospectDir = join(tmpDir, ".xyz-harness", "u30-cov");
    mkdirSync(retrospectDir, { recursive: true });
    const retrospectPath = join(retrospectDir, "retrospect.md");
    writeFileSync(retrospectPath, "# Retrospect\n\n复盘内容");
    dispatch(
      {
        action: "retrospect",
        topicId,
        retrospectPath,
        retrospectData: { knownRisks: [], processIssues: [] },
      },
      deps,
    );
    dispatch({ action: "closeout", topicId }, deps);

    const topic = store.loadTopic(topicId);
    // 杠杆 4：coverage 不再是 undefined，且全 passed 时 = 1
    expect(topic!.evidence!.coverage).toBeDefined();
    expect(topic!.evidence!.coverage).toBe(1);
  });

  it("AC-5: artifacts 记录了 review.path 但文件不存在 → closeout gate fail（artifacts-exist）", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "u30-artifacts-fail", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidDevPlanJson() }, deps);
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    dispatch(
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
    // 推进到 retrospected（retrospect gate pass，topicDir 存在）
    const retrospectDir = join(tmpDir, ".xyz-harness", "u30-artifacts-fail");
    mkdirSync(retrospectDir, { recursive: true });
    const retrospectPath = join(retrospectDir, "retrospect.md");
    writeFileSync(retrospectPath, "# Retrospect\n\n复盘内容");
    dispatch(
      {
        action: "retrospect",
        topicId,
        retrospectPath,
        retrospectData: { knownRisks: [], processIssues: [] },
      },
      deps,
    );
    expect(store.loadTopic(topicId)!.status).toBe("retrospected");

    // 在 store 里设 artifacts.review.path 指向不存在的文件（模拟 review.md 被删除）
    store.transaction(() => {
      store.setArtifacts(topicId, {
        review: { path: "/nonexistent/review.md", at: "2026-01-01T00:00:00.000Z" },
      });
    });

    // closeout 应 gate fail（artifacts-exist），status 不变（仍 retrospected）
    const result = dispatch({ action: "closeout", topicId }, deps);
    expect(result.status).toBe("retrospected");
    expect(result.gatePassed.closeout).toBeFalsy();
    const mustFix = (result as Record<string, unknown>).mustFix;
    expect(mustFix).toBeDefined();
    expect(String(mustFix)).toContain("review");
    expect(String(mustFix)).toContain("nonexistent");
    // nextAction 指回 closeout retry
    expect(result.nextAction.action).toBe("closeout");

    // gateHistory 有 closeout phase 的 fail 记录（gate=artifacts-exist）
    const topic = store.loadTopic(topicId);
    const failEntries = topic!.gateHistory.filter(
      (g) => g.phase === "closeout" && g.gate === "artifacts-exist" && g.result === "fail",
    );
    expect(failEntries.length).toBeGreaterThanOrEqual(1);
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

// ── dispatch tdd_plan ───────────────────────────────────────

describe("dispatch tdd_plan", () => {
  function setupPlannedTopic(): { topicId: string; deps: ActionDeps; store: CwStore } {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "tdd-plan-test", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidDevPlanJson() }, deps);
    // 新状态机：tdd_plan 要求 status=plan_reviewed，plan 后先过 plan_review gate。
    passPlanReview(store, topicId);
    return { topicId, deps, store };
  }

  it("合法 test.json → testCases 写入, status=tdd_inited, nextAction=dev", () => {
    const { topicId, deps, store } = setupPlannedTopic();
    const result = dispatch(
      { action: "tdd_plan", topicId, testJson: makeValidTestJson() },
      deps,
    );

    expect(result.status).toBe("tdd_inited");
    expect(result.nextAction.action).toBe("dev");
    expect(result.gatePassed.tdd_plan).toBe(true);

    const topic = store.loadTopic(topicId);
    expect(topic!.testCases).toHaveLength(2);
    expect(topic!.testCases.map((c) => c.id).sort()).toEqual(["E1", "E2"]);
    expect(topic!.gatePassed.tdd_plan).toBe(true);
  });

  it("gate fail：空 testCases → status 不变(仍 plan_reviewed), mustFix 返回, nextAction 指回 tdd_plan", () => {
    const { topicId, deps, store } = setupPlannedTopic();
    const result = dispatch(
      { action: "tdd_plan", topicId, testJson: { testCases: [] } },
      deps,
    );

    expect(result.status).toBe("plan_reviewed");
    expect(result.nextAction.action).toBe("tdd_plan");
    expect(result.gatePassed.tdd_plan).toBeFalsy();
    expect((result as Record<string, unknown>).mustFix).toBeDefined();

    const topic = store.loadTopic(topicId);
    expect(topic!.status).toBe("plan_reviewed");
    // gate fail → testCases 不写入
    expect(topic!.testCases).toHaveLength(0);
    const tddFails = topic!.gateHistory.filter(
      (g) => g.phase === "tdd_plan" && g.result === "fail",
    );
    expect(tddFails.length).toBeGreaterThanOrEqual(1);
  });

  it("gate fail：缺 real 层 → 报分层不完整", () => {
    const { topicId, deps } = setupPlannedTopic();
    const result = dispatch(
      {
        action: "tdd_plan",
        topicId,
        testJson: {
          testCases: [
            {
              id: "E1",
              layer: "mock",
              scenario: "s",
              steps: "st",
              expected: { type: "exact", text: "expected-output" },
              executor: "vitest",
              requiresScreenshot: false,
            },
          ],
          testRunner: { mode: "nodejs", command: "npx vitest run" },
        },
      },
      deps,
    );

    expect(result.status).toBe("plan_reviewed");
    expect((result as Record<string, unknown>).mustFix).toMatch(/real/);
  });
});

// ── dispatch tdd_plan + testRunner 存储 + 红灯校验 ──────────

describe("dispatch tdd_plan testRunner 存储 + 红灯校验", () => {
  function setupPlannedTopic(): { topicId: string; deps: ActionDeps; store: CwStore } {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "tdd-runner-test", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidDevPlanJson() }, deps);
    // 新状态机：tdd_plan 要求 status=plan_reviewed，plan 后先过 plan_review gate。
    passPlanReview(store, topicId);
    return { topicId, deps, store };
  }

  it("含 testRunner 的 test.json → topic.testRunner 被存储", () => {
    const { topicId, deps, store } = setupPlannedTopic();
    const testJson = {
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "expected-output" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "real-output" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
      testRunner: { mode: "nodejs", command: "npx vitest run" },
    };
    const result = dispatch({ action: "tdd_plan", topicId, testJson }, deps);

    expect(result.status).toBe("tdd_inited");
    expect(result.gatePassed.tdd_plan).toBe(true);

    const topic = store.loadTopic(topicId);
    expect(topic!.testRunner).toBeDefined();
    expect(topic!.testRunner!.mode).toBe("nodejs");
    expect(topic!.testRunner!.command).toBe("npx vitest run");
  });

  it("testRunner + redCheck=true + 测试命令 exit 1 → 红灯确认, 不报 mustFix", () => {
    const { topicId, deps, store } = setupPlannedTopic();
    // 测试命令 exit 1（模拟测试失败）→ redLightCheck redLight=true（红灯确认）→ 无 warning。
    const testJson = {
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "expected-output" },
          executor: "vitest",
          requiresScreenshot: false,
          redCheck: true,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "real-output" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
      testRunner: { mode: "nodejs", command: 'node -e "process.exit(1)"' },
    };
    const result = dispatch({ action: "tdd_plan", topicId, testJson }, deps);

    // status 仍正常流转到 tdd_inited（红灯校验失败不阻断流转）
    expect(result.status).toBe("tdd_inited");
    expect(result.gatePassed.tdd_plan).toBe(true);
    // 红灯确认 → 没有 mustFix warning
    expect((result as Record<string, unknown>).mustFix).toBeUndefined();

    // testRunner 仍被存储
    const topic = store.loadTopic(topicId);
    expect(topic!.testRunner!.command).toBe('node -e "process.exit(1)"');

    // 杠杆 1：红灯确认 → gateHistory 含 tdd-red-light pass 记录
    const redGate = topic!.gateHistory.filter((g) => g.gate === "tdd-red-light");
    expect(redGate).toHaveLength(1);
    expect(redGate[0]!.result).toBe("pass");
  });

  it("testRunner + redCheck=true + 测试命令 exit 0（意外通过）→ 红灯校验阻断, status 回退 plan_reviewed, gatePassed.tdd_plan=false", () => {
    const { topicId, deps, store } = setupPlannedTopic();
    // 测试命令 exit 0（模拟测试意外通过 = 绿灯 = 违反 TDD）→ redLightCheck redLight=false。
    // 新行为：红灯校验阻断 status 流转——回退到 plan_reviewed（FR-5 tdd_plan 前置），gatePassed.tdd_plan=false。
    const testJson = {
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "expected-output" },
          executor: "vitest",
          requiresScreenshot: false,
          redCheck: true,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "real-output" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
      testRunner: { mode: "nodejs", command: 'node -e "process.exit(0)"' },
    };
    const result = dispatch({ action: "tdd_plan", topicId, testJson }, deps);

    // 红灯校验失败 → status 回退到 plan_reviewed（FR-5: tdd_plan 前置变更）
    expect(result.status).toBe("plan_reviewed");
    expect(result.gatePassed.tdd_plan).toBe(false);
    // mustFix 含红灯校验失败信息（阻断提示）
    const mustFix = (result as Record<string, unknown>).mustFix;
    expect(mustFix).toBeDefined();
    expect(String(mustFix)).toMatch(/红灯校验失败/);
    // nextAction 指回 tdd_plan retry
    expect(result.nextAction.action).toBe("tdd_plan");

    const topic = store.loadTopic(topicId);
    expect(topic!.status).toBe("plan_reviewed");

    // 红灯失败 → gateHistory 含 tdd-red-light fail 记录（含 report）
    const redGate = topic!.gateHistory.filter((g) => g.gate === "tdd-red-light");
    expect(redGate).toHaveLength(1);
    expect(redGate[0]!.result).toBe("fail");
    expect(redGate[0]!.report).toMatch(/红灯校验未通过/);
  });

  it("testRunner 必选——缺失时 schema 拒绝（gate fail）", () => {
    const { topicId, deps } = setupPlannedTopic();
    // testRunner 不再 Optional（TestJsonSchema 强制必选）——缺失时 tddPlanCheck 转 gate fail。
    const { testRunner, ...withoutRunner } = {
      testRunner: { mode: "nodejs", command: "npx vitest run" },
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "expected-output" },
          executor: "vitest",
          requiresScreenshot: false,
          redCheck: true,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "real-output" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    } as Record<string, unknown>;
    void testRunner;
    const result = dispatch(
      { action: "tdd_plan", topicId, testJson: withoutRunner },
      deps,
    );

    // 缺 testRunner → schema 校验失败 → gate fail，status 不变（仍 plan_reviewed）
    expect(result.status).toBe("plan_reviewed");
    expect(result.gatePassed.tdd_plan).toBeFalsy();
    const mustFix = (result as Record<string, unknown>).mustFix;
    expect(mustFix).toBeDefined();
    expect(String(mustFix)).toMatch(/testRunner/);
  });
});

// ── dispatch replan --test ──────────────────────────────────

describe("dispatch replan --test（testCases 更新）", () => {
  it("只传 testJson → testCases 更新, waves 不变, status 回退 planned", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "replan-test-json", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidDevPlanJson() }, deps);
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);
    // 此时 status=tdd_inited，testCases=[E1,E2]

    // replan --test：把 E2 的 expected 改为 new-output，新增 E3。
    // E1/E2 是 pending（未 passed），所以 append-only 不拦截。
    const newTestJson = {
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "new-output" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "new-real" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "E3",
          layer: "mock",
          scenario: "s3",
          steps: "st",
          expected: { type: "exact", text: "case3-output" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
      testRunner: { mode: "nodejs", command: "npx vitest run" },
    };
    const result = dispatch(
      { action: "replan", topicId, testJson: newTestJson },
      deps,
    );

    // status 回退 plan_reviewed（replan --test 语义：plan 未改，plan_review 仍有效）
    expect(result.status).toBe("plan_reviewed");

    const topic = store.loadTopic(topicId);
    // waves 不变（replan --test 不碰 waves）
    expect(topic!.waves).toHaveLength(1);
    expect(topic!.waves[0]!.id).toBe("W1");
    // testCases 更新：E3 新增
    const caseIds = topic!.testCases.map((c) => c.id).sort();
    expect(caseIds).toEqual(["E1", "E2", "E3"]);
  });

  it("replan --test 在 wave 全 committed 时不触发 wave 违规（回归测试）", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "replan-test-committed", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidDevPlanJson() }, deps);
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);
    // 模拟 wave 已 committed + testCase 已 passed 的场景
    store.transaction(() => {
      store.setWaveCommitted(topicId, "W1", "fake-hash");
      for (const tc of store.loadTopic(topicId)!.testCases) {
        store.updateTestCase(topicId, tc.id, { status: "passed" });
      }
    });

    // replan --test 只改 testCases，不应触发 wave_deleted_committed
    // E1/E2 已 passed → 必须保持原 scenario/steps/expected 不变（append-only）
    // E3 是新增 case（合法）
    const newTestJson = {
      testCases: [
        { id: "E1", layer: "mock", scenario: "单测场景", steps: "执行单测",
          expected: { type: "exact", text: "expected-output" }, executor: "vitest", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "集成场景", steps: "执行集成测试",
          expected: { type: "exact", text: "real-output" }, executor: "vitest", requiresScreenshot: false },
        { id: "E3", layer: "mock", scenario: "s3", steps: "st",
          expected: { type: "exact", text: "new-case" }, executor: "vitest", requiresScreenshot: false },
      ],
      testRunner: { mode: "nodejs", command: "npx vitest run" },
    };
    // 不应 throw（E1/E2 已 passed 但 expected 未变 → 合法；E3 新增）
    const result = dispatch(
      { action: "replan", topicId, testJson: newTestJson },
      deps,
    );
    // replan --test（plan 未改）→ 回退 plan_reviewed（plan_review 仍有效）
    expect(result.status).toBe("plan_reviewed");
    const topic = store.loadTopic(topicId);
    expect(topic!.waves).toHaveLength(1); // waves 不变
    expect(topic!.testCases.map((c) => c.id).sort()).toEqual(["E1", "E2", "E3"]);
  });

  it("replan 不传 plan 也不传 test → throw CwError", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "replan-empty", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidDevPlanJson() }, deps);
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);

    expect(() =>
      dispatch({ action: "replan", topicId }, deps),
    ).toThrow(/requires --plan or --test/);
  });
});

// ── SF-1: replan --plan 重置 plan_review loop ─────────────────

describe("dispatch replan --plan 重置 planReviewLoop（SF-1）", () => {
  it("SF-1: replan --plan 重置 planReviewIssues/planReviewTurn（清空 + 归零）", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "replan-plan-reset", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidDevPlanJson() }, deps);
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);

    // 注入 planReviewIssues + planReviewTurn（模拟走过 plan_review loop）
    store.transaction(() => {
      store.appendPlanReviewIssues(topicId, 1, [
        { severity: "must-fix", description: "wave 缺依赖", dimension: "coverage", ref: "W1" },
        { severity: "nit", description: "命名问题", dimension: "architecture" },
      ]);
      store.incPlanReviewTurn(topicId);
    });
    expect(store.loadTopic(topicId)!.planReviewIssues).toHaveLength(2);
    expect(store.loadTopic(topicId)!.planReviewTurn).toBe(1);

    // replan --plan：追加一个未 committed 的 wave（保留 W1）+ 重置 plan_review loop
    const newPlan = {
      format: "lite",
      objective: "obj",
      waves: [
        { id: "W1", changes: [{ file: "src/app.ts", description: "change1" }], dependsOn: [] },
        { id: "W2", changes: [{ file: "src/app.ts", description: "change2" }], dependsOn: ["W1"] },
      ],
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { type: "exact", text: "expected-output" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { type: "exact", text: "real-output" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    dispatch({ action: "replan", topicId, planJson: newPlan }, deps);

    // replan --plan 后 planReviewIssues 清空、planReviewTurn 归零
    const topic = store.loadTopic(topicId);
    expect(topic!.planReviewIssues).toEqual([]);
    expect(topic!.planReviewTurn).toBe(0);
    // 同时 review loop 也被重置（plan 改了，代码会变）
    expect(topic!.reviewIssues).toEqual([]);
    expect(topic!.reviewTurn).toBe(0);
  });
});

// ── dispatch clarify ───────────────────────────────────────

describe("dispatch clarify", () => {
  it("合法 clarifyJson（pending）→ clarifyRecords 写入 1 条, status 仍 created, nextAction 仍 clarify", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "clarify-pending", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;

    const result = dispatch(
      { action: "clarify", topicId, clarifyJson: makeValidClarifyJson() },
      deps,
    );

    // status 不流转（progressive），仍 created
    expect(result.status).toBe("created");
    // 有 pending 记录 → nextAction 仍是 clarify（继续提问或带 answer 提交）
    expect(result.nextAction.action).toBe("clarify");

    const topic = store.loadTopic(topicId);
    expect(topic!.clarifyRecords).toHaveLength(1);
    expect(topic!.clarifyRecords[0]!.status).toBe("pending");
    // clarifyRecords[0] 含 kind/assessment/question，不含 answer
    expect(topic!.clarifyRecords[0]!.kind).toBe("technical");
    expect(topic!.clarifyRecords[0]!.assessment).toBeDefined();
    expect(topic!.clarifyRecords[0]!.answer).toBeUndefined();
  });

  it("含 answer → resolved, nextAction=confirm_clarify（全 resolved，FR-1: plan 前必须 confirm）", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "clarify-resolved", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;

    const result = dispatch(
      {
        action: "clarify",
        topicId,
        clarifyJson: makeValidClarifyJson({ answer: "迁移 SQLite，并发更好" }),
      },
      deps,
    );

    expect(result.status).toBe("created");
    // 全 resolved → nextAction 推进到 confirm_clarify（FR-1: plan 前必须先 confirm）
    expect(result.nextAction.action).toBe("confirm_clarify");

    const topic = store.loadTopic(topicId);
    expect(topic!.clarifyRecords).toHaveLength(1);
    expect(topic!.clarifyRecords[0]!.status).toBe("resolved");
    expect(topic!.clarifyRecords[0]!.answer).toBe("迁移 SQLite，并发更好");
    expect(topic!.clarifyRecords[0]!.resolvedAt).toBeDefined();
  });

  it("含 adr + projectPath 文件存在 → 双写 clarifyRecords + adrs, clarifyRecord.adrId 非空", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "clarify-adr", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;

    // 先在 workspace 写一个 adr md 文件（clarifyCheck 用 fileExistsCheck 校验存在）
    const adrPath = join(tmpDir, "adr-0001.md");
    writeFileSync(adrPath, "# ADR: 迁移 SQLite\n决策内容");

    const result = dispatch(
      {
        action: "clarify",
        topicId,
        clarifyJson: makeValidClarifyJson({
          answer: "迁移 SQLite",
          adr: {
            title: "状态存储迁移 SQLite",
            context: "JSON + flock 并发弱",
            decision: "迁移 better-sqlite3",
            alternatives: ["维持 JSON + flock"],
            consequences: "并发好，引入原生依赖",
            projectPath: adrPath,
          },
        }),
      },
      deps,
    );

    const topic = store.loadTopic(topicId);
    // clarifyRecords 写入 1 条
    expect(topic!.clarifyRecords).toHaveLength(1);
    // adrs 写入 1 条
    expect(topic!.adrs).toHaveLength(1);
    // clarifyRecord.adrId 回填为分配的 adr id
    expect(topic!.clarifyRecords[0]!.adrId).toBeDefined();
    expect(topic!.clarifyRecords[0]!.adrId).toBe(topic!.adrs[0]!.id);
    // clarifyProgress 暴露在 result（含 adrId）
    const progress = (result as Record<string, unknown>).clarifyProgress as Array<{
      id: string;
      adrId?: string;
    }>;
    expect(progress[0]!.adrId).toBe(topic!.adrs[0]!.id);
  });

  it("含 adr + projectPath 文件不存在 → gate fail, gateHistory 有 fail 记录, mustFix 含文件不存在", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "clarify-adr-missing", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;

    const result = dispatch(
      {
        action: "clarify",
        topicId,
        clarifyJson: makeValidClarifyJson({
          answer: "迁移 SQLite",
          adr: {
            title: "状态存储迁移 SQLite",
            context: "JSON + flock 并发弱",
            decision: "迁移 better-sqlite3",
            alternatives: ["维持 JSON + flock"],
            consequences: "并发好，引入原生依赖",
            projectPath: join(tmpDir, "不存在的路径.md"),
          },
        }),
      },
      deps,
    );

    // gate fail：status 仍 created（progressive 不流转），clarifyRecords 未写入
    expect(result.status).toBe("created");
    const topic = store.loadTopic(topicId);
    expect(topic!.clarifyRecords).toHaveLength(0);
    // gateHistory 有 clarify phase 的 fail 记录
    const clarifyFails = topic!.gateHistory.filter(
      (g) => g.phase === "clarify" && g.result === "fail",
    );
    expect(clarifyFails.length).toBeGreaterThanOrEqual(1);
    // mustFix 含 "文件不存在"
    const mustFix = (result as Record<string, unknown>).mustFix;
    expect(mustFix).toBeDefined();
    expect(String(mustFix)).toMatch(/文件不存在/);
  });

  it("批量 clarifyJson（数组 2 条）→ clarifyRecords 写入 2 条", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "clarify-batch", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;

    // 数组传 2 条：第 1 条含 answer（resolved），第 2 条不含 answer（pending）
    const batch = [
      makeValidClarifyJson({ topic: "主题1", answer: "答案1" }),
      makeValidClarifyJson({ topic: "主题2" }),
    ];
    const result = dispatch(
      { action: "clarify", topicId, clarifyJson: batch },
      deps,
    );

    const topic = store.loadTopic(topicId);
    expect(topic!.clarifyRecords).toHaveLength(2);
    expect(topic!.clarifyRecords[0]!.topic).toBe("主题1");
    expect(topic!.clarifyRecords[0]!.status).toBe("resolved");
    expect(topic!.clarifyRecords[1]!.topic).toBe("主题2");
    expect(topic!.clarifyRecords[1]!.status).toBe("pending");
    // 有 pending → nextAction 仍 clarify
    expect(result.nextAction.action).toBe("clarify");
  });

  it("confirm_clarify 后 plan：create → confirm_clarify → plan（无需先提 clarifyRecord）→ plan gate 通过, status=planned", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "clarify-skip", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    // confirm_clarify gate（直接操作 store 跳过 confirm gate 检查）
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);

    // confirm 后直接 plan
    const result = dispatch(
      { action: "plan", topicId, planJson: makeValidPlanJson() },
      deps,
    );

    // plan gate 通过，status=planned
    expect(result.status).toBe("planned");
    expect(result.nextAction.action).toBe("plan_review");
    expect(result.gatePassed.plan).toBe(true);
  });

  it("progressive 多次 clarify → clarifyRecords 有 2 条, status 仍 created", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "clarify-progressive", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;

    // 第 1 条 clarify
    dispatch(
      {
        action: "clarify",
        topicId,
        clarifyJson: makeValidClarifyJson({ topic: "主题1" }),
      },
      deps,
    );
    // 第 2 条 clarify
    dispatch(
      {
        action: "clarify",
        topicId,
        clarifyJson: makeValidClarifyJson({ topic: "主题2" }),
      },
      deps,
    );

    const topic = store.loadTopic(topicId);
    // clarifyRecords 有 2 条（progressive append-only）
    expect(topic!.clarifyRecords).toHaveLength(2);
    expect(topic!.clarifyRecords[0]!.id).toBe("CL1");
    expect(topic!.clarifyRecords[1]!.id).toBe("CL2");
    // status 仍 created（progressive 不流转）
    expect(topic!.status).toBe("created");
  });

  it("AC-9: --replaceSpec flag 提供但 clarifyJson 无 specSections → result 含 warning（不阻断）", () => {
    const { deps } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "clarify-replacespec-warn", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;

    // 提交一条带 replaceSpec 但 clarifyJson 无 specSections 的 clarify
    const result = dispatch(
      {
        action: "clarify",
        topicId,
        clarifyJson: makeValidClarifyJson({ answer: "迁移 SQLite" }),
        replaceSpec: "想替换但没带内容",
      },
      deps,
    );

    // FR-9: warning 不阻断 gate（status 仍推进，clarifyRecord 正常写入）
    expect(result.status).toBe("created");
    expect((result as Record<string, unknown>).warning).toBeDefined();
    expect(
      String((result as Record<string, unknown>).warning),
    ).toContain("replaceSpec 已设但未提供 specSections");
    // mustFix 不应触发（gate pass，只是 warning）
    expect((result as Record<string, unknown>).mustFix).toBeUndefined();
  });
});

// ── W3/W4/W5: review/review_fix/test/test_fix/replan reset ───

describe("dispatch review loop（W3：review + review_fix）", () => {
  /** 推进到 developed（dev gate pass），返回 topicId/deps/store。 */
  function setupDevelopedTopic(): { topicId: string; deps: ActionDeps; store: CwStore } {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "review-loop", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    return { topicId, deps, store };
  }

  it("W3-1: review 带 issues=[R1,R2] → nextAction=review_fix，reviewIssues 存储 2 条, reviewTurn=1", () => {
    const { topicId, deps, store } = setupDevelopedTopic();

    const result = dispatch(
      {
        action: "review",
        topicId,
        issues: [
          { severity: "must-fix", description: "问题1", file: "src/a.ts" },
          { severity: "should-fix", description: "问题2" },
        ],
      },
      deps,
    );

    expect(result.status).toBe("reviewed");
    expect(result.nextAction.action).toBe("review_fix");

    const topic = store.loadTopic(topicId);
    expect(topic!.reviewIssues).toHaveLength(2);
    expect(topic!.reviewIssues[0]!.id).toBe("R1");
    expect(topic!.reviewIssues[0]!.severity).toBe("must-fix");
    expect(topic!.reviewIssues[0]!.status).toBe("open");
    expect(topic!.reviewIssues[0]!.foundAtTurn).toBe(1);
    expect(topic!.reviewIssues[1]!.id).toBe("R2");
    expect(topic!.reviewTurn).toBe(1);
  });

  it("W3-2: review 带 issues=[] → nextAction=test（无问题 gate pass）", () => {
    const { topicId, deps } = setupDevelopedTopic();

    const result = dispatch(
      { action: "review", topicId, issues: [] },
      deps,
    );

    expect(result.status).toBe("reviewed");
    expect(result.nextAction.action).toBe("test");

    // issues 为空 → 无 reviewIssues 写入，reviewTurn 仍 0
    const topic = deps.store.loadTopic(topicId);
    expect(topic!.reviewIssues).toHaveLength(0);
    expect(topic!.reviewTurn).toBe(0);
  });

  it("W3-3: review_fix 标记 R1 fixed → nextAction=review，reviewIssues[0].status=fixed, 含 fix 证据", () => {
    const { topicId, deps, store } = setupDevelopedTopic();
    dispatch(
      {
        action: "review",
        topicId,
        issues: [{ severity: "must-fix", description: "问题1", file: "src/a.ts" }],
      },
      deps,
    );

    const result = dispatch(
      {
        action: "review_fix",
        topicId,
        fixes: [
          {
            issueId: "R1",
            commitHash: "abc1234",
            resolution: "修复了空指针",
          },
        ],
      },
      deps,
    );

    expect(result.nextAction.action).toBe("review");
    expect(result.status).toBe("reviewed");

    const topic = store.loadTopic(topicId);
    expect(topic!.reviewIssues[0]!.status).toBe("fixed");
    expect(topic!.reviewIssues[0]!.fix).toBeDefined();
    expect(topic!.reviewIssues[0]!.fix!.commitHash).toBe("abc1234");
    expect(topic!.reviewIssues[0]!.fix!.resolution).toBe("修复了空指针");
    expect(topic!.reviewIssues[0]!.fix!.fixedAtTurn).toBe(1);
  });

  it("W3-4: review 达上限（reviewTurn=3）+ open issues → nextAction=test（强制进 test）", () => {
    const { topicId, deps, store } = setupDevelopedTopic();
    // 先过一轮 review 把 status 推到 reviewed + 开启 loop。
    dispatch(
      {
        action: "review",
        topicId,
        issues: [{ severity: "must-fix", description: "问题1" }],
      },
      deps,
    );
    // incReviewTurn 到 3：当前已 1，再 inc 2 次，模拟已达 REVIEW_TURN_LIMIT
    store.incReviewTurn(topicId);
    store.incReviewTurn(topicId);
    expect(store.loadTopic(topicId)!.reviewTurn).toBe(3);

    // 再 review（progressive，reviewed 合法）带新 issues → buildNextAction 应判 overLimit → test
    const result = dispatch(
      {
        action: "review",
        topicId,
        issues: [{ severity: "must-fix", description: "新问题" }],
      },
      deps,
    );

    expect(result.nextAction.action).toBe("test");
  });

  it("W3-5: review_fix 从 developed 调 → illegal_transition（GuardError）", () => {
    const { topicId, deps } = setupDevelopedTopic();
    // status=developed，review_fix 要求 reviewed
    expect(() =>
      dispatch(
        {
          action: "review_fix",
          topicId,
          fixes: [{ issueId: "R1", commitHash: "x", resolution: "y" }],
        },
        deps,
      ),
    ).toThrow(GuardError);
  });

  it("W3-6: review_fix 对不存在的 issueId → throw CwError", () => {
    const { topicId, deps } = setupDevelopedTopic();
    // 先过 review（status → reviewed）但 issues=[]（无 R1）
    dispatch({ action: "review", topicId, issues: [] }, deps);

    expect(() =>
      dispatch(
        {
          action: "review_fix",
          topicId,
          fixes: [{ issueId: "R999-不存在", commitHash: "x", resolution: "y" }],
        },
        deps,
      ),
    ).toThrow(/不存在/);
  });
});

describe("dispatch test loop（W4：test + test_fix）", () => {
  /** 推进到 reviewed（review gate pass），返回 topicId/deps/store。 */
  function setupReviewedTopic(): { topicId: string; deps: ActionDeps; store: CwStore } {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "test-loop", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    return { topicId, deps, store };
  }

  it("W4-1: test fail → nextAction=test_fix, testTurn 仍为 0（inc 在 test_fix）", () => {
    const { topicId, deps, store } = setupReviewedTopic();

    const result = dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1", actual: { text: "wrong-output" } },
          { caseId: "E2", actual: { text: "real-output" } },
        ],
      },
      deps,
    );

    expect(result.nextAction.action).toBe("test_fix");
    const topic = store.loadTopic(topicId);
    // testTurn 在 test_fix 时 inc（不在 test 时），首次 fail 仍为 0
    expect(topic!.testTurn).toBe(0);
  });

  it("W4-2: test_fix 记录审计 → nextAction=test，testFixLog 有 1 条, testTurn 从 0→1", () => {
    const { topicId, deps, store } = setupReviewedTopic();
    // 先 test 让 E1 fail + 进入 tested 状态
    dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1", actual: { text: "wrong-output" } },
          { caseId: "E2", actual: { text: "real-output" } },
        ],
      },
      deps,
    );

    const result = dispatch(
      {
        action: "test_fix",
        topicId,
        fixes: [
          {
            caseId: "E1",
            commitHash: "fix123",
            resolution: "修正了输出",
          },
        ],
      },
      deps,
    );

    expect(result.nextAction.action).toBe("test");
    expect(result.status).toBe("tested");

    const topic = store.loadTopic(topicId);
    expect(topic!.testFixLog).toHaveLength(1);
    expect(topic!.testFixLog[0]!.caseId).toBe("E1");
    expect(topic!.testFixLog[0]!.commitHash).toBe("fix123");
    // turn 记录用的是 inc 前的值（0），inc 后 testTurn=1
    expect(topic!.testFixLog[0]!.turn).toBe(0);
    expect(topic!.testTurn).toBe(1);
  });

  it("W4-3: test 达上限（testTurn=5）+ failed → 强制进 retrospect（打破死循环）", () => {
    const { topicId, deps, store } = setupReviewedTopic();
    // 先 test 让 E1 fail
    dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1", actual: { text: "wrong-output" } },
          { caseId: "E2", actual: { text: "real-output" } },
        ],
      },
      deps,
    );
    // 手动把 testTurn 拉到 LIMIT（5）
    store.incTestTurn(topicId);
    store.incTestTurn(topicId);
    store.incTestTurn(topicId);
    store.incTestTurn(topicId);
    store.incTestTurn(topicId);
    expect(store.loadTopic(topicId)!.testTurn).toBe(5);

    // 再 test（progressive）E1 仍 fail → buildNextAction 判 overLimit → 强制进 retrospect
    const result = dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1", actual: { text: "still-wrong" } },
          { caseId: "E2", actual: { text: "real-output" } },
        ],
      },
      deps,
    );

    // overLimit 时 action=retrospect（不再 test_fix），打破 test↔test_fix 死循环
    expect(result.nextAction.action).toBe("retrospect");
    expect(result.nextAction.guidance).toMatch(/上限|强制/);
  });

  it("W4-4: test_fix 从 reviewed 调 → illegal_transition（GuardError）", () => {
    const { topicId, deps } = setupReviewedTopic();
    // status=reviewed，test_fix 要求 tested
    expect(() =>
      dispatch(
        {
          action: "test_fix",
          topicId,
          fixes: [{ caseId: "E1", commitHash: "x", resolution: "y" }],
        },
        deps,
      ),
    ).toThrow(GuardError);
  });
});

describe("dispatch replan reset loop（W5e：resetReviewLoop/resetTestLoop）", () => {
  it("W5e: replan 清空 reviewIssues/testFixLog → reviewTurn=0, testTurn=0", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "replan-reset", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );

    // 注入 reviewIssues + reviewTurn + testFixLog + testTurn（模拟走过 review/test loop）
    store.appendReviewIssues(topicId, 1, [
      { severity: "must-fix", description: "问题1" },
    ]);
    store.incReviewTurn(topicId);
    store.appendTestFix(topicId, {
      caseId: "E1",
      commitHash: "x",
      resolution: "y",
      turn: 1,
    });
    store.incTestTurn(topicId);
    expect(store.loadTopic(topicId)!.reviewIssues).toHaveLength(1);
    expect(store.loadTopic(topicId)!.reviewTurn).toBe(1);
    expect(store.loadTopic(topicId)!.testFixLog).toHaveLength(1);
    expect(store.loadTopic(topicId)!.testTurn).toBe(1);

    // replan（追加一个未 committed 的 wave，保留 W1）
    const newPlan = {
      format: "lite",
      objective: "obj",
      waves: [
        { id: "W1", changes: [{ file: "src/app.ts", description: "change1" }], dependsOn: [] },
        { id: "W2", changes: [{ file: "src/app.ts", description: "change2" }], dependsOn: ["W1"] },
      ],
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { type: "exact", text: "expected-output" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { type: "exact", text: "real-output" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    dispatch({ action: "replan", topicId, planJson: newPlan }, deps);

    // replan 后 reviewIssues/testFixLog 清空，turn 归零
    const topic = store.loadTopic(topicId);
    expect(topic!.reviewIssues).toHaveLength(0);
    expect(topic!.reviewTurn).toBe(0);
    expect(topic!.testFixLog).toHaveLength(0);
    expect(topic!.testTurn).toBe(0);
  });
});

// ── W5: post-closeout 评估（assess） ──────────────────────

describe("dispatch assess（W5：post-closeout 评估）", () => {
  /** 推进到 closed（closeout gate pass），返回 topicId/deps/store。 */
  function setupClosedTopic(slug = "assess-topic"): {
    topicId: string;
    deps: ActionDeps;
    store: CwStore;
  } {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug, objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidPlanJson() }, deps);
    passPlanReview(store, topicId);
    passTddPlanGate(store, topicId);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    dispatch(
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
    // retrospect（需提供 retrospect.md 文件 + retrospectData 结构化数据）
    const retrospectDir = join(tmpDir, ".xyz-harness", slug);
    mkdirSync(retrospectDir, { recursive: true });
    const retrospectPath = join(retrospectDir, "retrospect.md");
    writeFileSync(retrospectPath, "# Retrospect\n\n复盘内容");
    dispatch(
      {
        action: "retrospect",
        topicId,
        retrospectPath,
        retrospectData: { knownRisks: [], processIssues: [] },
      },
      deps,
    );
    dispatch({ action: "closeout", topicId }, deps);
    return { topicId, deps, store };
  }

  it("W5-1: assess type=quality + score → 写入 AS1, status 仍 closed, assessments 含 1 条", () => {
    const { topicId, deps, store } = setupClosedTopic();

    const result = dispatch(
      {
        action: "assess",
        topicId,
        type: "quality",
        score: 4,
        notes: "代码结构清晰，类型安全到位",
      },
      deps,
    );

    // progressive：status 不变（始终 closed）
    expect(result.status).toBe("closed");
    // 不走 gate 机制，gatePassed 不变
    expect(result.gatePassed.assess).toBeUndefined();
    // assess 不进 nextAction 导航（action 为空）
    expect(result.nextAction.action).toBeUndefined();
    // 返回分配的 assessmentId
    expect((result as Record<string, unknown>).assessmentId).toBe("AS1");

    const topic = store.loadTopic(topicId);
    expect(topic!.assessments).toHaveLength(1);
    expect(topic!.assessments[0]!.id).toBe("AS1");
    expect(topic!.assessments[0]!.type).toBe("quality");
    expect(topic!.assessments[0]!.score).toBe(4);
    expect(topic!.assessments[0]!.notes).toBe("代码结构清晰，类型安全到位");
    expect(topic!.assessments[0]!.defect).toBeUndefined();
    expect(topic!.assessments[0]!.assessedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("W5-2: assess progressive——多次调用追加 AS1/AS2/AS3, status 不变", () => {
    const { topicId, deps, store } = setupClosedTopic();

    dispatch(
      { action: "assess", topicId, type: "quality", score: 4, notes: "质量好" },
      deps,
    );
    dispatch(
      { action: "assess", topicId, type: "test", score: 3, notes: "测试覆盖一般" },
      deps,
    );
    dispatch(
      { action: "assess", topicId, type: "stability", notes: "稳定，无并发问题" },
      deps,
    );

    const topic = store.loadTopic(topicId);
    expect(topic!.assessments).toHaveLength(3);
    expect(topic!.assessments.map((a) => a.id)).toEqual(["AS1", "AS2", "AS3"]);
    expect(topic!.assessments[0]!.type).toBe("quality");
    expect(topic!.assessments[1]!.type).toBe("test");
    expect(topic!.assessments[2]!.type).toBe("stability");
    expect(topic!.assessments[2]!.score).toBeUndefined();
    // status 始终 closed
    expect(topic!.status).toBe("closed");
  });

  it("W5-3: assess type=defect + defect 详情 → 写入完整缺陷记录, foundInReview=false", () => {
    const { topicId, deps, store } = setupClosedTopic();

    const result = dispatch(
      {
        action: "assess",
        topicId,
        type: "defect",
        notes: "并发场景下数据丢失",
        defect: {
          severity: "major",
          area: "store.ts",
          rootCause: "边界遗漏",
          foundInReview: false,
        },
      },
      deps,
    );

    expect((result as Record<string, unknown>).assessmentId).toBe("AS1");

    const topic = store.loadTopic(topicId);
    const a = topic!.assessments[0]!;
    expect(a.type).toBe("defect");
    expect(a.defect).toBeDefined();
    expect(a.defect!.severity).toBe("major");
    expect(a.defect!.area).toBe("store.ts");
    expect(a.defect!.rootCause).toBe("边界遗漏");
    expect(a.defect!.foundInReview).toBe(false);
  });

  it("W5-4: assess type=defect 但缺 defect 字段 → throw CwError", () => {
    const { topicId, deps } = setupClosedTopic();

    expect(() =>
      dispatch(
        { action: "assess", topicId, type: "defect", notes: "有缺陷但不填详情" },
        deps,
      ),
    ).toThrow(/defect 必填/);
  });

  it("W5-5: assess notes 为空 → throw CwError", () => {
    const { topicId, deps } = setupClosedTopic();

    expect(() =>
      dispatch(
        { action: "assess", topicId, type: "quality", notes: "   " },
        deps,
      ),
    ).toThrow(/notes.*空/);
  });

  it("W5-6: assess 非法 type → throw CwError", () => {
    const { topicId, deps } = setupClosedTopic();

    expect(() =>
      dispatch(
        { action: "assess", topicId, type: "performance" as never, notes: "x" },
        deps,
      ),
    ).toThrow(/type 非法/);
  });

  it("W5-7: assess score 超范围（6）→ throw CwError", () => {
    const { topicId, deps } = setupClosedTopic();

    expect(() =>
      dispatch(
        { action: "assess", topicId, type: "quality", score: 6, notes: "x" },
        deps,
      ),
    ).toThrow(/score.*1-5/);
  });

  it("W5-8: assess 非 defect type 带 defect → throw CwError", () => {
    const { topicId, deps } = setupClosedTopic();

    expect(() =>
      dispatch(
        {
          action: "assess",
          topicId,
          type: "quality",
          notes: "x",
          defect: {
            severity: "minor",
            area: "a",
            rootCause: "b",
            foundInReview: true,
          },
        },
        deps,
      ),
    ).toThrow(/仅在 type=defect/);
  });

  it("W5-9: assess 从非 closed 状态调 → illegal_transition（GuardError）", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "assess-guard", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    // status=created（未 closeout），assess 要求 closed
    expect(() =>
      dispatch(
        { action: "assess", topicId, type: "quality", notes: "x" },
        deps,
      ),
    ).toThrow(GuardError);
    // 确认未写入任何 assessment
    expect(store.loadTopic(topicId)!.assessments).toHaveLength(0);
  });

  it("W5-10: assess defect.severity 非法 → throw CwError", () => {
    const { topicId, deps } = setupClosedTopic();

    expect(() =>
      dispatch(
        {
          action: "assess",
          topicId,
          type: "defect",
          notes: "x",
          defect: {
            severity: "critical" as never,
            area: "a",
            rootCause: "b",
            foundInReview: false,
          },
        },
        deps,
      ),
    ).toThrow(/severity 非法/);
  });

  it("W5-11: assess 返回 assessments 摘要含全部已有记录", () => {
    const { topicId, deps } = setupClosedTopic();

    dispatch(
      { action: "assess", topicId, type: "quality", score: 5, notes: "好" },
      deps,
    );
    const result = dispatch(
      {
        action: "assess",
        topicId,
        type: "defect",
        notes: "小问题",
        defect: {
          severity: "minor",
          area: "types.ts",
          rootCause: "类型错误",
          foundInReview: true,
        },
      },
      deps,
    );

    const assessments = (result as Record<string, unknown>).assessments as Array<{
      id: string;
      type: string;
      defect?: { foundInReview: boolean };
    }>;
    expect(assessments).toHaveLength(2);
    expect(assessments[0]!.id).toBe("AS1");
    expect(assessments[1]!.id).toBe("AS2");
    expect(assessments[1]!.defect!.foundInReview).toBe(true);
  });
});

// ── expected 多模式 dispatch 层（topic: cw-2026-07-17-expected-multi-mode） ──
//
// AC-6 / AC-9 / AC-10 / exit_zero 共享归因的 dispatch 层锚点。
// expected-multi-mode.test.ts 已覆盖 happy path（exit_zero/script 执行 pass/fail）+
// AC-9（noactual.sh 行为验证）；这里补的是 dispatch.test.ts 主文件里的回归契约：
//   - AC-6: 明确 assert error code === "case_expected_tampered_failed"（PR5）——
//     防止 violation 类型被误改成 case_modified_passed 导致 failed-case 保护降级。
//   - exit_zero 共享归因（PR3）: 多个 exit_zero case → testRunner 只跑一次，
//     所有 case 共享同一 exitCode。这是 handleTest 的去重契约，纯函数层测不到。
//   - AC-10 不经 shell: 通过行为验证（shell 元字符注入串按字面路径失败），
//     补充 expected-multi-mode.test.ts 的静态源码断言。

describe("dispatch expected 多模式（AC-6 / exit_zero 共享归因 / AC-10 行为）", () => {
  /**
   * 推进到 reviewed + 注入自定义 expected 的 testCases（多模式场景）。
   * 与 expected-multi-mode.test.ts 的 passTddPlanGateWith 同构。
   */
  function setupReviewedWith(
    slug: string,
    cases: Array<{ id: string; expected: Expected }>,
  ): { topicId: string; deps: ActionDeps; store: CwStore } {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug, objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: makeValidDevPlanJson() }, deps);
    passPlanReview(store, topicId);
    store.insertTestCases(
      topicId,
      cases.map((c, i) => ({
        id: c.id,
        layer: i % 2 === 0 ? ("mock" as const) : ("real" as const),
        scenario: "s",
        steps: "st",
        expected: c.expected,
        executor: "vitest",
        requiresScreenshot: false,
      })),
    );
    store.updateStatus(topicId, "tdd_inited");
    store.updateGatePassed(topicId, "tdd_plan", true);
    store.appendGateHistory(topicId, {
      phase: "tdd_plan",
      action: "tdd_plan",
      gate: "test-json-schema",
      result: "pass",
      progressive: false,
    });
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    return { topicId, deps, store };
  }

  /** 在 tmpDir（workspace）下建带 shebang + 可执行位的脚本。relPath 相对 tmpDir。 */
  function makeRunnableScript(relPath: string, body: string): string {
    const abs = join(tmpDir, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
    chmodSync(abs, 0o755);
    return abs;
  }

  // ── AC-6: replan 改 failed case 的 expected.type → case_expected_tampered_failed ──

  it("AC-6: 已 failed 的 exit_zero case 被 replan 改 type 为 exact → throw error code case_expected_tampered_failed", () => {
    const { topicId, deps, store } = setupReviewedWith("w5-ac6", [
      { id: "E1", expected: { type: "exit_zero" } },
      { id: "E2", expected: { type: "exact", text: "real-out" } },
    ]);
    // 跑 test：E1 exit_zero failed（testRunner exit 1），E2 exact mismatch 也 failed。
    store.setTestRunner(topicId, { mode: "nodejs", command: 'node -e "process.exit(1)"' });
    dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1" }, // exit_zero 无需 actual
          { caseId: "E2", actual: { text: "wrong" } },
        ],
      },
      deps,
    );
    // E1 当前 status=failed。replan --test 把 E1 的 type 从 exit_zero 改成 exact（防作弊路径）。
    store.updateStatus(topicId, "developed");
    const newTestJson = {
      testRunner: { mode: "nodejs", command: "npx vitest run" },
      testCases: [
        // 篡改：E1 原 type=exit_zero → 改成 exact+text=exit-1（企图让原 actual 对上）
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { type: "exact", text: "exit-1" }, executor: "vitest", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { type: "exact", text: "real-out" }, executor: "vitest", requiresScreenshot: false },
      ],
    };
    // PR5: 明确 assert error code === "case_expected_tampered_failed"。
    // 不能用模糊的 /append-only/ 或 /modified/ —— 那会让 failed-case 保护降级成
    // case_modified_passed（只保护 passed）而不报错。必须精确断言 failed 专属的 code。
    expect(() =>
      dispatch({ action: "replan", topicId, testJson: newTestJson }, deps),
    ).toThrow(/\[case_expected_tampered_failed\]/);
  });

  it("AC-6 反面: 已 passed 的 exit_zero case 被 replan 改 type → throw case_modified_passed（不是 case_expected_tampered_failed）", () => {
    // 反面回归：passed 的 case 改 type 应报 case_modified_passed（passed 保护），
    // 不应误报成 case_expected_tampered_failed（failed 专属）。两个 code 语义不同不能混。
    const { topicId, deps, store } = setupReviewedWith("w5-ac6-passed", [
      { id: "E1", expected: { type: "exit_zero" } },
      { id: "E2", expected: { type: "exact", text: "real-out" } },
    ]);
    store.setTestRunner(topicId, { mode: "nodejs", command: 'node -e "process.exit(0)"' });
    dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1" },
          { caseId: "E2", actual: { text: "real-out" } },
        ],
      },
      deps,
    );
    // E1 现在 passed。replan 改 E1 type → 应报 case_modified_passed。
    store.updateStatus(topicId, "developed");
    const newTestJson = {
      testRunner: { mode: "nodejs", command: "npx vitest run" },
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { type: "exact", text: "x" }, executor: "vitest", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { type: "exact", text: "real-out" }, executor: "vitest", requiresScreenshot: false },
      ],
    };
    expect(() =>
      dispatch({ action: "replan", topicId, testJson: newTestJson }, deps),
    ).toThrow(/\[case_modified_passed\]/);
  });

  // ── exit_zero 共享归因（PR3）: 多个 exit_zero case 共享一次 testRunner 执行 ──

  it("exit_zero 共享归因: 2 个 exit_zero case → 同一 exitCode 归一化（testRunner exit 0 → 两 case 都 passed）", () => {
    // PR3 去重契约：handleTest 对 exit_zero 去重执行一次 testRunner，把同一 exitCode
    // 归一化给每个 exit_zero case。这是纯函数 testCheck 测不到的（它只看 actual.exitCode）。
    // 关键 bug 面：若去重失败（每个 case 各跑一次），exit 0 时仍都 pass（掩盖 bug），
    // 但 exit 1 时若只归因给第一个 case，第二个 case 会 pending/未判 —— 这里断言两 case 同 pass。
    const { topicId, deps, store } = setupReviewedWith("w5-shared-0", [
      { id: "E1", expected: { type: "exit_zero" } },
      { id: "E3", expected: { type: "exit_zero" } },
    ]);
    store.setTestRunner(topicId, { mode: "nodejs", command: 'node -e "process.exit(0)"' });
    const result = dispatch(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "E1" }, { caseId: "E3" }],
      },
      deps,
    );
    const topic = store.loadTopic(topicId);
    expect(topic!.testCases.find((c) => c.id === "E1")!.status).toBe("passed");
    expect(topic!.testCases.find((c) => c.id === "E3")!.status).toBe("passed");
    expect(result.gatePassed.test).toBe(true);
  });

  it("exit_zero 共享归因: 2 个 exit_zero case + testRunner exit 1 → 两 case 都 failed（共享同一非零 exitCode）", () => {
    // 共享归因的失败侧：exit 1 时两个 exit_zero case 必须都 failed。
    // bug 面：若只把 exitCode 归因给第一个 case，第二个会因无 actual 被判成别的状态。
    const { topicId, deps, store } = setupReviewedWith("w5-shared-1", [
      { id: "E1", expected: { type: "exit_zero" } },
      { id: "E3", expected: { type: "exit_zero" } },
    ]);
    store.setTestRunner(topicId, { mode: "nodejs", command: 'node -e "process.exit(1)"' });
    const result = dispatch(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "E1" }, { caseId: "E3" }],
      },
      deps,
    );
    const topic = store.loadTopic(topicId);
    expect(topic!.testCases.find((c) => c.id === "E1")!.status).toBe("failed");
    expect(topic!.testCases.find((c) => c.id === "E3")!.status).toBe("failed");
    expect(result.gatePassed.test).toBe(false);
  });

  it("exit_zero 共享归因只作用于 exit_zero case: 混合 exact + exit_zero → 各自独立判定", () => {
    // 边界回归：去重只对 exit_zero 生效。同批里的 exact case 用自己的 actual.text 判定，
    // 不受 testRunner exitCode 影响。
    const { topicId, deps, store } = setupReviewedWith("w5-mixed", [
      { id: "E1", expected: { type: "exit_zero" } },
      { id: "E2", expected: { type: "exact", text: "real-out" } },
    ]);
    // testRunner exit 0 → E1 passed；E2 用 actual.text="real-out" 匹配 → passed。
    store.setTestRunner(topicId, { mode: "nodejs", command: 'node -e "process.exit(0)"' });
    dispatch(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "E1" }, { caseId: "E2", actual: { text: "real-out" } }],
      },
      deps,
    );
    const topic = store.loadTopic(topicId);
    expect(topic!.testCases.find((c) => c.id === "E1")!.status).toBe("passed");
    expect(topic!.testCases.find((c) => c.id === "E2")!.status).toBe("passed");
  });

  // ── AC-10 行为验证: script 执行不经 shell（shell 元字符按字面路径失败） ──

  it("AC-10: script.path 含 shell 元字符 $(...) → 按字面路径执行失败（不经 shell 解析）", () => {
    // AC-10 行为验证（补 expected-multi-mode.test.ts 的静态源码断言）：
    // 若 handleTest 用 shell:true 执行 script，path 里的 $(echo evil) 会被 shell 先解析。
    // 不经 shell（execFileSync shell 默认 false）则把整个串当文件名 → spawn ENOENT → case failed。
    // 关键：脚本不能 passed（那样说明 shell 解析了注入串）。必须 failed（字面路径不存在）。
    const { topicId, deps, store } = setupReviewedWith("w5-ac10-noshell", [
      { id: "E1", expected: { type: "script", path: "$(echo evil).sh" } },
      { id: "E2", expected: { type: "exact", text: "real-out" } },
    ]);
    dispatch(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "E1" }, { caseId: "E2", actual: { text: "real-out" } }],
      },
      deps,
    );
    const topic = store.loadTopic(topicId);
    const e1 = topic!.testCases.find((c) => c.id === "E1")!;
    expect(e1.status).toBe("failed");
    // 失败原因应指向脚本执行异常（spawn ENOENT / 文件不存在），而非 shell 解析后的成功。
    expect(e1.failureReason).toBeTruthy();
  });

  it("AC-9: script 执行不传 agent actual（脚本 argv/stdin/env 不含 actual 数据）", () => {
    // AC-9 dispatch 层锚点：expected-multi-mode.test.ts 已用 noactual.sh 通过完整 dispatch
    // 验证过此契约（脚本检查 $# 和 $ACTUAL env）。这里在 dispatch.test.ts 主文件里
    // 复测同一行为契约，确保 future 重构 handleTest 的 script 执行路径时不漏此保护。
    // 脚本：有任何 argv 或 ACTUAL env → exit 1（检测到 actual 污染）；否则 exit 0。
    makeRunnableScript(
      "scripts/noactual.sh",
      '#!/usr/bin/env bash\nif [ "$#" -gt 0 ] || [ -n "$ACTUAL" ]; then exit 1; fi\nexit 0\n',
    );
    const { topicId, deps, store } = setupReviewedWith("w5-ac9", [
      { id: "E1", expected: { type: "script", path: "scripts/noactual.sh" } },
      { id: "E2", expected: { type: "exact", text: "real-out" } },
    ]);
    // 故意提交 actual，验证 handleTest 执行 script 时不会把它传给脚本（argv/env）。
    dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1", actual: { text: "should-be-ignored" } },
          { caseId: "E2", actual: { text: "real-out" } },
        ],
      },
      deps,
    );
    const topic = store.loadTopic(topicId);
    // passed 说明脚本没检测到 actual 污染（argv 空、ACTUAL env 空）。
    expect(topic!.testCases.find((c) => c.id === "E1")!.status).toBe("passed");
  });
});

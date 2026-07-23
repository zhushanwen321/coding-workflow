/**
 * gate-leak-hardening 测试 — 纵向 gate 链(A) + handleTest 全覆盖(D) + guidance 兜底(B)。
 *
 * 防的 bug：blind follower agent 可绕过未完成的 gate 越权跳阶段。
 * 例如 status=developed 但 dev gate=false（有 wave 未 committed）时，
 * agent 仍可调 cw(review) 越权进入——因为 checkLinear 只防 status 跳步，
 * 不查前序阶段完成度。
 *
 * 测试策略（零 mock，同 dispatch.test.ts）：
 *   - store 用真实 CwStore 指向 tmp 文件
 *   - git 用真实 GitValidator（git init 过的 tmp workspace）
 *   - 前置 gate 用 store 直接推进（passTddPlanGate / passReviewGate 等 helper）
 *
 * 红灯预期：实现尚未写，以下测试应全 fail（throw 的是 illegal_transition 或未 throw，
 * guidance 不含核心句，handleTest 不做集合校验）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/legacy/dispatch.js";
import { GitValidator } from "../src/legacy/gate.js";
import { buildNextAction, REVIEW_TURN_LIMIT, TEST_TURN_LIMIT } from "../src/legacy/state-machine.js";
import { CwStore } from "../src/legacy/store.js";
import type { ActionDeps, Topic } from "../src/legacy/types.js";
import { CwError } from "../src/legacy/types.js";
import { setupGitRepo } from "./helpers/git.js";
import { makeValidDevPlanJson } from "./helpers/plan.js";

// ── 测试夹具 ──────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;
let realCommitHash: string;

function makeDeps(): { deps: ActionDeps; store: CwStore } {
  const store = new CwStore(dbPath);
  const git = new GitValidator(tmpDir);
  const deps: ActionDeps = { store, git, workspacePath: tmpDir };
  return { deps, store };
}

function confirmClarify(store: CwStore, topicId: string): void {
  store.updateStatus(topicId, "clarify_confirmed");
  store.updateGatePassed(topicId, "confirm_clarify", true);
}

function passSpecReview(store: CwStore, topicId: string): void {
  store.updateStatus(topicId, "spec_reviewed");
  store.updateGatePassed(topicId, "spec_review", true);
}

function passPlanReview(store: CwStore, topicId: string): void {
  store.updateStatus(topicId, "plan_reviewed");
  store.updateGatePassed(topicId, "plan_review", true);
}

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
  store.updateStatus(topicId, "pre_dev_verified");
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
 * 把 W1 commit 掉（让 dev gate = true），status 推进到 developed。
 * 用于「正常路径」基线。
 */
function commitAllWavesAndReachDeveloped(
  store: CwStore,
  topicId: string,
  commitHash: string,
): void {
  store.setWaveCommitted(topicId, "W1", commitHash, ["src/app.ts"]);
  store.updateStatus(topicId, "developed");
  store.updateGatePassed(topicId, "dev", true);
}

/**
 * 推进到 developed 但 W1 仍未 committed（dev gate = false）。
 * 这是越权场景的关键前置：status 合法但 dev 未完成。
 */
function reachDevelopedWithoutCommit(store: CwStore, topicId: string): void {
  // 不 setWaveCommitted → W1.committed = null → dev gate = false
  store.updateStatus(topicId, "developed");
}

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
 * 建一个 topic 并推进到指定阶段。返回 topicId + store + deps。
 * stopAt 决定推进到哪个状态。
 */
function setupTopic(
  stopAt:
    | "developed-committed"
    | "developed-uncommitted"
    | "reviewed"
    | "post_dev_verified"
    | "retrospected",
): { deps: ActionDeps; store: CwStore; topicId: string } {
  const { deps, store } = makeDeps();
  const createResult = dispatch(
    { action: "create", slug: "leak-test", objective: "obj", workspacePath: tmpDir },
    deps,
  );
  const topicId = createResult.topicId;
  confirmClarify(store, topicId);
  passSpecReview(store, topicId);

  // plan（写入 W1）
  dispatch(
    { action: "plan", topicId, planJson: makeValidDevPlanJson() },
    deps,
  );
  passPlanReview(store, topicId);
  passTddPlanGate(store, topicId);

  if (stopAt === "developed-uncommitted") {
    reachDevelopedWithoutCommit(store, topicId);
    return { deps, store, topicId };
  }

  if (stopAt === "developed-committed") {
    commitAllWavesAndReachDeveloped(store, topicId, realCommitHash);
    return { deps, store, topicId };
  }

  if (stopAt === "reviewed") {
    commitAllWavesAndReachDeveloped(store, topicId, realCommitHash);
    passReviewGate(store, topicId);
    return { deps, store, topicId };
  }

  // post_dev_verified：review 过 + 所有 testCase passed
  if (stopAt === "post_dev_verified") {
    commitAllWavesAndReachDeveloped(store, topicId, realCommitHash);
    passReviewGate(store, topicId);
    // 把两个 testCase 都标 passed
    store.updateTestCase(topicId, "E1", { status: "passed" });
    store.updateTestCase(topicId, "E2", { status: "passed" });
    store.updateStatus(topicId, "post_dev_verified");
    store.updateGatePassed(topicId, "test", true);
    return { deps, store, topicId };
  }

  // retrospected：test 全过 + retrospect gate 通过
  if (stopAt === "retrospected") {
    commitAllWavesAndReachDeveloped(store, topicId, realCommitHash);
    passReviewGate(store, topicId);
    store.updateTestCase(topicId, "E1", { status: "passed" });
    store.updateTestCase(topicId, "E2", { status: "passed" });
    store.updateStatus(topicId, "post_dev_verified");
    store.updateGatePassed(topicId, "test", true);
    // 推进到 retrospected + retrospect gate pass。
    // computeGatePassed("retrospect") 查 gateHistory 的 pass 记录（非 gatePassed 缓存），必须 append。
    store.updateStatus(topicId, "retrospected");
    store.updateGatePassed(topicId, "retrospect", true);
    store.appendGateHistory(topicId, {
      phase: "retrospect",
      action: "retrospect",
      gate: "file-exists+non-empty",
      result: "pass",
      progressive: false,
    });
    return { deps, store, topicId };
  }

  return { deps, store, topicId };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cw-leak-test-"));
  dbPath = join(tmpDir, "cw.json");
  realCommitHash = setupGitRepo(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── A: 纵向 gate 链 — 前序阶段未完成时硬拒绝 ───────────────────────

describe("A-纵向 gate 链：前序未完成时 throw phase_prerequisite_failed", () => {
  it("AC-1: developed 但 dev gate=false（W1 未 committed）时，cw(review) throw phase_prerequisite_failed", () => {
    const { deps, topicId } = setupTopic("developed-uncommitted");

    // review 需要 reviewPath 文件——先建一个占位（本测试不关心 review 自身 gate，
    // 只关心前置 dev gate 检查是否先 throw）
    const reviewPath = join(tmpDir, "review.md");
    writeFileSync(reviewPath, "# review\nplaceholder");

    expect(() =>
      dispatch(
        {
          action: "review",
          topicId,
          reviewPath,
          issues: [],
        },
        deps,
      ),
    ).toThrowError(
      // 期望 throw GuardError with code=phase_prerequisite_failed
      // 红灯：当前不 throw（或 throw illegal_transition，因为 status 合法）
      expect.objectContaining({ code: "phase_prerequisite_failed" }),
    );
  });

  it("AC-2: reviewed 但 review 有 open issue 且 reviewTurn<REVIEW_TURN_LIMIT 时，cw(test) throw phase_prerequisite_failed", () => {
    const { deps, store, topicId } = setupTopic("reviewed");

    // 注入一个 open issue（未闭环）。appendReviewIssues(topicId, turn, issues[])。
    store.appendReviewIssues(topicId, 0, [
      {
        severity: "should-fix",
        dimension: "completeness",
        description: "未闭环的 issue",
      },
    ]);
    // reviewTurn 保持 0（未达上限）

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
    ).toThrowError(
      expect.objectContaining({ code: "phase_prerequisite_failed" }),
    );
  });

  it("AC-3: post_dev_verified 但 test 有未 passed case 且 testTurn<TEST_TURN_LIMIT 时，cw(retrospect) throw phase_prerequisite_failed", () => {
    const { deps, store, topicId } = setupTopic("reviewed");

    // 只让 E1 passed，E2 保持 pending → test gate = false
    store.updateTestCase(topicId, "E1", { status: "passed" });
    // E2 仍 pending（未跑）
    store.updateStatus(topicId, "post_dev_verified");
    // testTurn 保持 0（未达上限）

    // retrospect 需要 retrospectPath + retrospectData
    const retrospectPath = join(tmpDir, "retrospect.md");
    writeFileSync(retrospectPath, "# retrospect\nplaceholder");

    expect(() =>
      dispatch(
        {
          action: "retrospect",
          topicId,
          retrospectPath,
          retrospectData: {
            knownRisks: [],
            processIssues: [],
          },
        },
        deps,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "phase_prerequisite_failed" }),
    );
  });
});

// ── A: 逃生阀放行（turn-limit 达上限不堵）──────────────────────────

describe("A-逃生阀：turn-limit 达上限时放行越权", () => {
  it("AC-5a: testTurn>=TEST_TURN_LIMIT 时 cw(retrospect) 放行（带 failed case 进复盘）", () => {
    const { deps, store, topicId } = setupTopic("reviewed");

    // E1 passed，E2 仍 pending（test gate false），但 testTurn 达上限
    store.updateTestCase(topicId, "E1", { status: "passed" });
    store.updateStatus(topicId, "post_dev_verified");
    // 把 testTurn 推到上限（TEST_TURN_LIMIT=5），用 incTestTurn
    for (let i = 0; i < TEST_TURN_LIMIT; i++) {
      store.incTestTurn(topicId);
    }

    const retrospectPath = join(tmpDir, "retrospect.md");
    writeFileSync(retrospectPath, "# retrospect\nplaceholder");

    // 逃生阀放行 → 不 throw，正常推进到 retrospected
    const result = dispatch(
      {
        action: "retrospect",
        topicId,
        retrospectPath,
        retrospectData: {
          knownRisks: [],
          processIssues: [],
        },
      },
      deps,
    );
    expect(result.status).toBe("retrospected");
  });

  it("AC-5b: reviewTurn>=REVIEW_TURN_LIMIT 时 cw(test) 放行（带 open issue 进 test）", () => {
    const { deps, store, topicId } = setupTopic("reviewed");

    // 注入 open issue 但 reviewTurn 达上限
    store.appendReviewIssues(topicId, 0, [
      {
        severity: "should-fix",
        dimension: "completeness",
        description: "未闭环",
      },
    ]);
    // reviewTurn 推到上限（REVIEW_TURN_LIMIT=3），用 incReviewTurn
    for (let i = 0; i < REVIEW_TURN_LIMIT; i++) {
      store.incReviewTurn(topicId);
    }

    // 逃生阀放行 → test 正常执行（不 throw phase_prerequisite_failed）
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
    // test 执行成功（不管 case pass/fail，关键是没被前置检查拦住）
    expect(result.status).toBe("post_dev_verified");
  });
});

// ── D: handleTest 全覆盖校验 ──────────────────────────────────

describe("D-handleTest：params.cases 必须覆盖全部 testCase id", () => {
  it("AC-4: 缺失某 testCase id 时 throw CwError，不更新任何 testCase", () => {
    const { deps, topicId } = setupTopic("reviewed");

    // topic 有 E1 + E2，但只提交 E1（缺 E2）
    expect(() =>
      dispatch(
        {
          action: "test",
          topicId,
          cases: [{ caseId: "E1", actual: { text: "expected-output" } }],
        },
        deps,
      ),
    ).toThrow(CwError);

    // 确认 throw 前无副作用：所有 testCase 保持 pending + status 不变 + gateHistory 不变
    const topic = deps.store.loadTopic(topicId);
    expect(topic!.testCases.every((c) => c.status === "pending")).toBe(true);
    expect(topic!.status).toBe("reviewed");
  });

  it("AC-D1.3: 多余 caseId（params.cases 含未定义的 testCase id）时 throw CwError", () => {
    const { deps, topicId } = setupTopic("reviewed");

    // 提交 E1 + E2 + 不存在的 E3
    expect(() =>
      dispatch(
        {
          action: "test",
          topicId,
          cases: [
            { caseId: "E1", actual: { text: "expected-output" } },
            { caseId: "E2", actual: { text: "real-output" } },
            { caseId: "E3", actual: { text: "ghost" } },
          ],
        },
        deps,
      ),
    ).toThrow(/不一致|多余/);
  });
});

// ── B: guidance 完成度提示 ────────────────────────────────────

describe("B-guidance：retrospect 显式说明可带未全过 test closeout", () => {
  it("AC-6: test 有未过 case 进 retrospect 时，guidance 含「可带未全过 test closeout」说明", () => {
    const { store, topicId } = setupTopic("reviewed");

    // E1 passed，E2 pending（test gate false），testTurn 达上限（逃生阀放行进 retrospect）
    store.updateTestCase(topicId, "E1", { status: "passed" });
    store.updateStatus(topicId, "post_dev_verified");
    for (let i = 0; i < TEST_TURN_LIMIT; i++) {
      store.incTestTurn(topicId);
    }

    const topic = store.loadTopic(topicId) as Topic;
    const result = buildNextAction("test", topic);

    // retrospect guidance 应含核心止血句（AC-6 核心验收点）
    expect(result.guidance).toContain("closeout");
    // 红灯：当前 guidance 不含「coverage」或「未全过」相关说明
    expect(result.guidance.toLowerCase()).toMatch(/coverage|未全过|未通过.*closeout/);
  });
});

// ── 补充：closeout 关卡 + happy path + 重复 caseId + gateHistory + 低 coverage ───

describe("A-closeout 关卡：retrospect gate 未过时 throw", () => {
  it("AC-closeout: status=retrospected 但 retrospect gate 未过 → cw(closeout) throw phase_prerequisite_failed", () => {
    const { deps, store, topicId } = setupTopic("post_dev_verified");

    // 推进到 retrospected 但不写 retrospect gate pass 记录
    store.updateStatus(topicId, "retrospected");
    // gatePassed.retrospect 保持 false（无 pass 记录）

    expect(() =>
      dispatch({ action: "closeout", topicId }, deps),
    ).toThrowError(
      expect.objectContaining({ code: "phase_prerequisite_failed" }),
    );
  });
});

describe("A-happy path：前序阶段完成时各关卡正常放行（不 throw）", () => {
  it("review 关卡 happy path: dev gate=true → cw(review) 正常执行不 throw", () => {
    const { deps, topicId } = setupTopic("developed-committed");
    const reviewPath = join(tmpDir, "review.md");
    writeFileSync(reviewPath, "# review\nplaceholder");

    expect(() =>
      dispatch(
        { action: "review", topicId, reviewPath, issues: [] },
        deps,
      ),
    ).not.toThrow();
  });

  it("test 关卡 happy path: review gate=true 且无 open issue → cw(test) 正常执行", () => {
    const { deps, topicId } = setupTopic("reviewed");

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
    expect(result.status).toBe("post_dev_verified");
  });

  it("retrospect 关卡 happy path: test gate=true → cw(retrospect) 正常执行", () => {
    const { deps, topicId } = setupTopic("post_dev_verified");
    const retrospectPath = join(tmpDir, "retrospect.md");
    writeFileSync(retrospectPath, "# retrospect\nplaceholder");

    expect(() =>
      dispatch(
        {
          action: "retrospect",
          topicId,
          retrospectPath,
          retrospectData: { knownRisks: [], processIssues: [] },
        },
        deps,
      ),
    ).not.toThrow();
  });

  it("closeout 关卡 happy path: retrospect gate=true → cw(closeout) 正常执行", () => {
    const { deps, topicId } = setupTopic("retrospected");
    // closeout 的 topicDir-exists gate 要求 topicDir 存在
    const topicDir = join(tmpDir, ".xyz-harness", "leak-test");
    mkdirSync(topicDir, { recursive: true });

    const result = dispatch({ action: "closeout", topicId }, deps);
    expect(result.status).toBe("closed");
  });
});

describe("D-重复 caseId + gateHistory 不变 + 低 coverage 告警", () => {
  it("CRITICAL-fix: 重复 caseId（params.cases 含同一个 id 两次）→ throw CwError", () => {
    const { deps, store, topicId } = setupTopic("reviewed");

    // topic 有 E1+E2，提交 E1 两次 + E2 一次（E1 重复）
    expect(() =>
      dispatch(
        {
          action: "test",
          topicId,
          cases: [
            { caseId: "E1", actual: { text: "expected-output" } },
            { caseId: "E1", actual: { text: "expected-output" } },
            { caseId: "E2", actual: { text: "real-output" } },
          ],
        },
        deps,
      ),
    ).toThrow(/重复/);

    // 确认无副作用
    const topic = store.loadTopic(topicId);
    expect(topic!.testCases.every((c) => c.status === "pending")).toBe(true);
  });

  it("W5: phase_prerequisite_failed throw 后 gateHistory 不变（不记 guard 拒绝）", () => {
    const { deps, store, topicId } = setupTopic("developed-uncommitted");
    const historyBefore = store.loadTopic(topicId)!.gateHistory.length;

    const reviewPath = join(tmpDir, "review.md");
    writeFileSync(reviewPath, "# review\nplaceholder");

    expect(() =>
      dispatch(
        { action: "review", topicId, reviewPath, issues: [] },
        deps,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "phase_prerequisite_failed" }),
    );

    // guard 拒绝不进 gateHistory（与 gate fail 路径区分）
    const historyAfter = store.loadTopic(topicId)!.gateHistory.length;
    expect(historyAfter).toBe(historyBefore);
  });

  it("W2-低coverage告警: test 全 pending + testTurn 达上限 → guidance 含低 coverage 告警", () => {
    const { store, topicId } = setupTopic("reviewed");

    // 所有 testCase 保持 pending（coverage=0%），testTurn 达上限
    store.updateStatus(topicId, "post_dev_verified");
    for (let i = 0; i < TEST_TURN_LIMIT; i++) {
      store.incTestTurn(topicId);
    }

    const topic = store.loadTopic(topicId) as Topic;
    const result = buildNextAction("test", topic);

    // 低 coverage（<50%）应触发告警文案
    expect(result.guidance).toMatch(/coverage=0%|ask_user/);
  });
});

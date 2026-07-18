/**
 * retrospect 校验 + gate 轻校验单测 — W3（FR-3 / FR-5 / AC-4 / AC-5）。
 *
 * 覆盖 AC：
 *   - AC-4: validateRetrospectData 校验 type 合法性，非法 type 触发 gate fail
 *   - AC-5: processIssues 全 oneOff 无 pattern → gate 仍 pass 但 gateHistory 记 warning
 *
 * 测什么（走 dispatch 完整路径测 handleRetrospect，不直接调 handler）：
 *   - 合法 type（pattern/oneOff/observation/uncategorized）→ gate pass
 *   - 非法 type（"bug"/"critical"）→ gate fail，mustFix 含校验失败信息
 *   - description 空字符串 → gate fail
 *   - 缺 type 字段 → gate fail
 *   - 全 oneOff 无 pattern → gate pass + gateHistory 含 warning 记录
 *   - 有 pattern → gate pass + 无 warning
 *
 * 防的 bug：
 *   - 校验漏过非法 type（processIssues.type 退化为自由文本）。
 *   - warning 该记没记（FR-5 软引导失效）。
 *   - warning 误阻断 gate（FR-5 明确 result=pass 不阻断）。
 *
 * 测试模式：真实 CwStore + 真实 GitValidator + tmp git 仓库（照 dispatch.test.ts 模式）。
 * 走 dispatch 函数，不直接调 handleRetrospect。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import { GitValidator } from "../src/gate.js";
import { CwStore } from "../src/store.js";
import type { ActionDeps } from "../src/types.js";
import { setupGitRepo } from "./helpers/git.js";
import { makeValidDevPlanJson } from "./helpers/plan.js";

// ── 测试夹具（照 dispatch.test.ts 模式）──────────────────────────

let tmpDir: string;
let dbPath: string;
let realCommitHash: string;

function makeDeps(): { deps: ActionDeps; store: CwStore } {
  const store = new CwStore(dbPath);
  const git = new GitValidator(tmpDir);
  const deps: ActionDeps = { store, git, workspacePath: tmpDir };
  return { deps, store };
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

function passTddPlanGate(store: CwStore, topicId: string): void {
  store.insertTestCases(topicId, [
    {
      id: "E1",
      layer: "mock",
      scenario: "单测",
      steps: "run",
      expected: { type: "exact", text: "expected-output" },
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

/**
 * 推进 topic 到 tested 状态（test gate pass），retrospect 前置就绪。
 * 走 dispatch 全链，照 dispatch.test.ts U30 模式。
 */
function setupToTested(slug: string): { topicId: string; deps: ActionDeps; store: CwStore } {
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
      cases: [{ caseId: "E1", actual: { text: "expected-output" } }],
    },
    deps,
  );
  return { topicId, deps, store };
}

/** 写 retrospect.md 文件（fileExistsCheck 要求存在 + 非空）。 */
function writeRetrospectMd(slug: string): string {
  const retrospectDir = join(tmpDir, ".xyz-harness", slug);
  mkdirSync(retrospectDir, { recursive: true });
  const retrospectPath = join(retrospectDir, "retrospect.md");
  writeFileSync(retrospectPath, "# Retrospect\n\n复盘内容");
  return retrospectPath;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cw-retro-valid-test-"));
  dbPath = join(tmpDir, "cw.json");
  realCommitHash = setupGitRepo(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── AC-4: validateRetrospectData type 合法性校验 ───────────────

describe("validateRetrospectData type 合法性（W3 / AC-4）", () => {
  it("合法 type 四值（pattern/oneOff/observation/uncategorized）→ gate pass", () => {
    const { topicId, deps, store } = setupToTested("valid-types");
    const retrospectPath = writeRetrospectMd("valid-types");

    const result = dispatch(
      {
        action: "retrospect",
        topicId,
        retrospectPath,
        retrospectData: {
          knownRisks: [],
          processIssues: [
            { type: "pattern", description: "可泛化流程模式" },
            { type: "oneOff", description: "一次性失误" },
            { type: "observation", description: "观察性陈述" },
            { type: "uncategorized", description: "迁移标记" },
          ],
        },
      },
      deps,
    );

    // gate pass → status 流转到 retrospected
    expect(result.status).toBe("retrospected");
    expect(result.gatePassed.retrospect).toBe(true);
    // retrospectData 存入 topic
    const topic = store.loadTopic(topicId);
    expect(topic!.retrospectData).toBeDefined();
    expect(topic!.retrospectData!.processIssues).toHaveLength(4);
  });

  it("非法 type（如 \"bug\"）→ gate fail，mustFix 含校验失败信息", () => {
    const { topicId, deps } = setupToTested("invalid-type");
    const retrospectPath = writeRetrospectMd("invalid-type");

    const result = dispatch(
      {
        action: "retrospect",
        topicId,
        retrospectPath,
        retrospectData: {
          knownRisks: [],
          processIssues: [
            { type: "bug", description: "拼写错的 type" },
          ],
        },
      },
      deps,
    );

    // gate fail → status 不变（仍 tested）
    expect(result.status).toBe("tested");
    expect(result.gatePassed.retrospect).toBeFalsy();
    // mustFix 含校验失败信息（AC-4 验证点）
    expect((result as Record<string, unknown>).mustFix).toBeDefined();
    const mustFix = String((result as Record<string, unknown>).mustFix);
    expect(mustFix).toContain("retrospectData 校验失败");
    expect(mustFix).toMatch(/type|bug/i);
  });

  it("非法 type（如 \"critical\"）→ gate fail", () => {
    const { topicId, deps } = setupToTested("invalid-type-2");
    const retrospectPath = writeRetrospectMd("invalid-type-2");

    const result = dispatch(
      {
        action: "retrospect",
        topicId,
        retrospectPath,
        retrospectData: {
          knownRisks: [],
          processIssues: [{ type: "critical", description: "severity 误用为 type" }],
        },
      },
      deps,
    );

    expect(result.status).toBe("tested");
    expect((result as Record<string, unknown>).mustFix).toBeDefined();
  });

  it("description 空字符串 → gate fail", () => {
    const { topicId, deps } = setupToTested("empty-desc");
    const retrospectPath = writeRetrospectMd("empty-desc");

    const result = dispatch(
      {
        action: "retrospect",
        topicId,
        retrospectPath,
        retrospectData: {
          knownRisks: [],
          processIssues: [{ type: "pattern", description: "" }],
        },
      },
      deps,
    );

    expect(result.status).toBe("tested");
    const mustFix = String((result as Record<string, unknown>).mustFix);
    expect(mustFix).toContain("retrospectData 校验失败");
  });

  it("description 仅空白字符（trim 后为空）→ gate fail", () => {
    const { topicId, deps } = setupToTested("whitespace-desc");
    const retrospectPath = writeRetrospectMd("whitespace-desc");

    const result = dispatch(
      {
        action: "retrospect",
        topicId,
        retrospectPath,
        retrospectData: {
          knownRisks: [],
          processIssues: [{ type: "pattern", description: "   " }],
        },
      },
      deps,
    );

    expect(result.status).toBe("tested");
    expect((result as Record<string, unknown>).mustFix).toBeDefined();
  });

  it("缺 type 字段 → gate fail", () => {
    const { topicId, deps } = setupToTested("missing-type");
    const retrospectPath = writeRetrospectMd("missing-type");

    const result = dispatch(
      {
        action: "retrospect",
        topicId,
        retrospectPath,
        retrospectData: {
          knownRisks: [],
          // 只有 description，缺 type
          processIssues: [{ description: "缺 type 字段" }] as unknown as never,
        },
      },
      deps,
    );

    expect(result.status).toBe("tested");
    const mustFix = String((result as Record<string, unknown>).mustFix);
    expect(mustFix).toContain("retrospectData 校验失败");
  });
});

// ── AC-5: gate 轻校验（至少 1 条 pattern，软引导不阻断）─────────

describe("handleRetrospect pattern 轻校验 warning（W3 / FR-5 / AC-5）", () => {
  it("processIssues 全 oneOff 无 pattern → gate pass 但 gateHistory 记 warning", () => {
    const { topicId, deps, store } = setupToTested("all-oneoff");
    const retrospectPath = writeRetrospectMd("all-oneoff");

    const result = dispatch(
      {
        action: "retrospect",
        topicId,
        retrospectPath,
        retrospectData: {
          knownRisks: [],
          processIssues: [
            { type: "oneOff", description: "偶发失误 1" },
            { type: "oneOff", description: "偶发失误 2" },
          ],
        },
      },
      deps,
    );

    // 关键断言 1：gate 仍 pass（FR-5 不阻断）
    expect(result.status).toBe("retrospected");
    expect(result.gatePassed.retrospect).toBe(true);

    // 关键断言 2：gateHistory 含 warning 记录（result=pass + report 含 warning 字样）
    const topic = store.loadTopic(topicId);
    const retrospectGates = topic!.gateHistory.filter((g) => g.phase === "retrospect");
    // 找到那条 pattern-check 的 warning 记录
    const warningEntry = retrospectGates.find(
      (g) => g.report !== undefined && /warning|pattern/i.test(g.report),
    );
    expect(warningEntry).toBeDefined();
    expect(warningEntry!.result).toBe("pass"); // result 是 pass 不是 fail
    expect(warningEntry!.report).toMatch(/pattern/i);
  });

  it("processIssues 含至少 1 条 pattern → gate pass 无 pattern-check warning", () => {
    const { topicId, deps, store } = setupToTested("has-pattern");
    const retrospectPath = writeRetrospectMd("has-pattern");

    const result = dispatch(
      {
        action: "retrospect",
        topicId,
        retrospectPath,
        retrospectData: {
          knownRisks: [],
          processIssues: [
            { type: "pattern", description: "可泛化流程模式" },
            { type: "oneOff", description: "偶发失误" },
          ],
        },
      },
      deps,
    );

    expect(result.status).toBe("retrospected");
    expect(result.gatePassed.retrospect).toBe(true);

    // 有 pattern → 不应追加 pattern-check warning
    const topic = store.loadTopic(topicId);
    const retrospectGates = topic!.gateHistory.filter((g) => g.phase === "retrospect");
    const warningEntry = retrospectGates.find(
      (g) => g.report !== undefined &&
        /warning.*pattern|无 type=pattern/i.test(g.report),
    );
    expect(warningEntry).toBeUndefined();
  });

  it("processIssues 含 observation + oneOff 无 pattern → 同样记 warning（pattern 缺席即提醒）", () => {
    const { topicId, deps, store } = setupToTested("obs-oneoff");
    const retrospectPath = writeRetrospectMd("obs-oneoff");

    dispatch(
      {
        action: "retrospect",
        topicId,
        retrospectPath,
        retrospectData: {
          knownRisks: [],
          processIssues: [
            { type: "observation", description: "观察" },
            { type: "oneOff", description: "失误" },
          ],
        },
      },
      deps,
    );

    const topic = store.loadTopic(topicId);
    const retrospectGates = topic!.gateHistory.filter((g) => g.phase === "retrospect");
    const warningEntry = retrospectGates.find(
      (g) => g.report !== undefined && /pattern/i.test(g.report),
    );
    expect(warningEntry).toBeDefined();
    expect(warningEntry!.result).toBe("pass");
  });
});

/**
 * dimension-subset-validation 单测 — 步骤 4 W4：ReviewIssue.dimension 子集校验（AC-10）。
 *
 * 背景：REVIEW_PROMPT 按 shape 声明的 dimensions 子集展示维度表（W3），但 gate 的
 * reviewIssueCheck 只校验 dimension 是合法的 ReviewDimension 枚举（全 12 值）——agent
 * 可提交 shape 不关心的 dimension（如 delete-only 提 type-safety）。本测试验证 handler
 * 层的子集校验（AC-10）：
 *   - delete-only（LeanReviewPolicy: design-consistency + edge-case）提交子集外 dimension → gate fail
 *   - full-tdd（FullReviewPolicy: 全 6 维）提交任意 6 维 → pass
 *
 * 职责分离：gate.reviewIssueCheck = 结构校验（dimension 合法），handleReview = 子集校验
 *（dimension 在 shape 声明内）。两层正交，本测试只覆盖子集层。
 *
 * 测试策略：直接调 handleReview（export），用真实 CwStore + 临时 db 构造 developed + dev gate
 * pass 的 topic（绕过 dispatch guard，聚焦子集校验）。git/workspacePath 不参与 review 的
 * dimension 校验，deps.git 传一个指向 tmp 的 GitValidator 占位即可（handleReview 不调它）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleReview } from "../src/actions.js";
import { GitValidator } from "../src/gate.js";
import { CwStore } from "../src/store.js";
import type { ActionDeps, ReviewIssueSubmission, Topic } from "../src/types.js";

// ── 测试夹具 ────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cw-dim-subset-"));
  dbPath = `${tmpDir}/cw.db`;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 构造一个 dev gate pass 的 topic 并写入 store：
 *   - status=developed（review 的合法前置状态）
 *   - waves: 1 个已 committed 的 wave（让 computeGatePassed("dev")=true）
 *   - taskShape 按 shape 参数（默认 full-tdd）
 *
 * 直接 insertTopic + insertWaves + setWaveCommitted 写入，跳过 plan/dev handler，
 * 聚焦 review 子集校验。waves 走子表（insertWaves），而非内联在 topic record——
 * 与 CwStore 的持久化模型一致（loadTopic 从 waves 子表组装 topic.waves）。
 */
function setupDevelopedTopic(
  store: CwStore,
  shape: Topic["taskShape"] = "full-tdd",
): string {
  const topicId = "cw-2026-01-01-dim-subset";
  const base: Topic = {
    topicId,
    slug: "dim-subset",
    objective: "test objective",
    workspacePath: tmpDir,
    topicDir: `${tmpDir}/.xyz-harness/dim-subset`,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "developed",
    runtimeEnv: undefined,
    taskShape: shape,
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
    clarifyRecords: [],
    adrs: [],
    reviewIssues: [],
    reviewTurn: 0,
    specReviewIssues: [],
    specReviewTurn: 0,
    planReviewIssues: [],
    planReviewTurn: 0,
    testFixLog: [],
    testTurn: 0,
    assessments: [],
    specSections: [],
    specHistory: [],
  };
  store.insertTopic(base);
  // committed wave 让 computeGatePassed("dev")=true（waves 非空 + 全 committed !== null）。
  store.insertWaves(topicId, [{ id: "W1", changes: [], dependsOn: [] }]);
  store.setWaveCommitted(topicId, "W1", "0123456789abcdef0123456789abcdef01234567", []);
  return topicId;
}

function makeDeps(): { deps: ActionDeps; store: CwStore } {
  const store = new CwStore(dbPath);
  const deps: ActionDeps = {
    store,
    git: new GitValidator(tmpDir),
    workspacePath: tmpDir,
  };
  return { deps, store };
}

/** 构造一条 ReviewIssueSubmission（dimension 必填，其它字段给默认）。 */
function issue(
  dimension: ReviewIssueSubmission["dimension"],
  overrides: Partial<ReviewIssueSubmission> = {},
): ReviewIssueSubmission {
  return {
    dimension,
    severity: "must-fix",
    description: "发现一个问题",
    ...overrides,
  };
}

// ── AC-10: dimension 子集校验 ──────────────────────────────

describe("AC-10: ReviewIssue.dimension 子集校验（handleReview）", () => {
  it("AC-10a: delete-only shape 提交 dimension 在子集内（design-consistency）→ gate pass", () => {
    const { deps, store } = makeDeps();
    const topicId = setupDevelopedTopic(store, "delete-only");

    const result = handleReview(
      {
        action: "review",
        topicId,
        // LeanReviewPolicy.dimensions = ["design-consistency", "edge-case"]
        issues: [issue("design-consistency")],
      },
      store.loadTopic(topicId)!,
      deps,
    );

    // 子集内 → gate pass，status 流转 reviewed。
    expect(result.status).toBe("reviewed");
    expect(result.gatePassed.review).toBe(true);
    // mustFix 不应被设置（gate pass）。
    expect((result as Record<string, unknown>).mustFix).toBeUndefined();
  });

  it("AC-10b: delete-only shape 提交 dimension 在子集内（edge-case）→ gate pass", () => {
    const { deps, store } = makeDeps();
    const topicId = setupDevelopedTopic(store, "delete-only");

    const result = handleReview(
      {
        action: "review",
        topicId,
        issues: [issue("edge-case", { severity: "should-fix" })],
      },
      store.loadTopic(topicId)!,
      deps,
    );

    expect(result.status).toBe("reviewed");
    expect(result.gatePassed.review).toBe(true);
  });

  it("AC-10c: delete-only shape 提交子集外 dimension（type-safety）→ gate fail，status 不变", () => {
    const { deps, store } = makeDeps();
    const topicId = setupDevelopedTopic(store, "delete-only");

    const result = handleReview(
      {
        action: "review",
        topicId,
        // type-safety 不在 LeanReviewPolicy 的 [design-consistency, edge-case] 子集内。
        issues: [issue("type-safety")],
      },
      store.loadTopic(topicId)!,
      deps,
    );

    // 子集外 → gate fail，status 保持 developed，mustFix 含违规 dimension 提示。
    expect(result.status).toBe("developed");
    expect(result.gatePassed.review).toBeUndefined();
    const mustFix = (result as Record<string, unknown>).mustFix as string;
    expect(mustFix).toContain("type-safety");
    expect(mustFix).toContain("design-consistency");
  });

  it("AC-10d: delete-only shape 混合提交（1 条子集内 + 1 条子集外）→ gate fail", () => {
    const { deps, store } = makeDeps();
    const topicId = setupDevelopedTopic(store, "delete-only");

    const result = handleReview(
      {
        action: "review",
        topicId,
        issues: [
          issue("design-consistency"),
          issue("error-handling"), // 不在 [design-consistency, edge-case] 子集内
        ],
      },
      store.loadTopic(topicId)!,
      deps,
    );

    expect(result.status).toBe("developed");
    const mustFix = (result as Record<string, unknown>).mustFix as string;
    expect(mustFix).toContain("error-handling");
  });

  it("AC-10e: full-tdd shape 提交全 6 维内的 dimension → gate pass（回归，不误伤全链）", () => {
    const { deps, store } = makeDeps();
    const topicId = setupDevelopedTopic(store, "full-tdd");

    // FullReviewPolicy.dimensions = 全 6 维，逐个提交都该 pass。
    const allDims: ReviewIssueSubmission["dimension"][] = [
      "type-safety",
      "error-handling",
      "edge-case",
      "test-coverage",
      "plan-completeness",
      "design-consistency",
    ];
    const result = handleReview(
      {
        action: "review",
        topicId,
        issues: allDims.map((d) => issue(d)),
      },
      store.loadTopic(topicId)!,
      deps,
    );

    expect(result.status).toBe("reviewed");
    expect(result.gatePassed.review).toBe(true);
    expect((result as Record<string, unknown>).mustFix).toBeUndefined();
  });

  it("AC-10f: full-tdd shape 提交 spec/plan 审查维度（completeness）→ gate fail（不在 review 6 维内）", () => {
    const { deps, store } = makeDeps();
    const topicId = setupDevelopedTopic(store, "full-tdd");

    const result = handleReview(
      {
        action: "review",
        topicId,
        // completeness 是 spec/plan 审查维度，不在 full-review 的代码审查 6 维里。
        issues: [issue("completeness")],
      },
      store.loadTopic(topicId)!,
      deps,
    );

    expect(result.status).toBe("developed");
    const mustFix = (result as Record<string, unknown>).mustFix as string;
    expect(mustFix).toContain("completeness");
  });

  it("AC-10g: 无 issues（空数组）→ gate pass（子集校验不作用于空数组）", () => {
    const { deps, store } = makeDeps();
    const topicId = setupDevelopedTopic(store, "delete-only");

    const result = handleReview(
      { action: "review", topicId, issues: [] },
      store.loadTopic(topicId)!,
      deps,
    );

    expect(result.status).toBe("reviewed");
    expect(result.gatePassed.review).toBe(true);
  });
});

/**
 * v1 feature retrospect 测试。
 *
 * 测 feature retrospect 的验收逻辑（feature-internal.runFeatureRetrospectGates，4 个 gate）：
 * - allWavesClosed（child slice 未全 closed/aborted → fail）
 * - sliceLessonsLearnedNonEmpty（lessonsLearned 空 → fail）
 * - reviewedItemsCoverDesignReview（reviewedItems 未覆盖 designReviewJudgment 核心项 → fail）
 * - splitFulfillmentCoversPlan（splitFulfillment 未覆盖 plan.split 全部 slug → fail）
 *
 * 另通过 dispatch 集成验：child slice 未全 close 时 retrospect ok=false 不流转；
 * splitFulfillment 覆盖所有 split 时通过。
 *
 * 真实 store + stub V1Deps。零 mock 框架。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PlanningRetrospectData } from "../../src/v1/core/judgments.js";
import { createFeature, type Feature } from "../../src/v1/core/workunit.js";
import { dispatch } from "../../src/v1/dispatch.js";
import { runFeatureRetrospectGates } from "../../src/v1/handlers/feature/feature-internal.js";
import {
  createV1Env,
  makeValidFeatureDesignReviewJudgment,
  makeValidFeatureRetrospectData,
  setupFeatureWithClosedSlices,
  setupToFeatureExecuting,
} from "./helpers/feature-env.js";
import type { V1Env } from "./helpers/v1-env.js";

let env: V1Env;

beforeEach(() => {
  env = createV1Env();
});

afterEach(() => {
  env.cleanup();
});

// ── 辅助：构造一个已填好 judgment 的 feature（retrospect gate 基线）──

/** 构造合法 feature（designReviewJudgment + plan.split 已填，retrospect 基线，retrospectData 待填）。 */
function featureForRetrospect(): Feature {
  // 直接构造 unit（不走 store），designReviewJudgment + plan.split 填合法值
  const unit = createFeature({ slug: "retro-feature", objective: "o" });
  unit.designReviewJudgment = makeValidFeatureDesignReviewJudgment();
  unit.plan = {
    split: [
      { slug: "s1", description: "s1", dependsOn: [], inheritedItemIds: ["FR1"] },
      { slug: "s2", description: "s2", dependsOn: ["s1"], inheritedItemIds: ["AC1"] },
    ],
  };
  return unit;
}

// ═══════════════════════════════════════════════════════════════
// allWavesClosed（child slice 终态判定）
// ═══════════════════════════════════════════════════════════════

describe("runFeatureRetrospectGates: allWavesClosed", () => {
  it("child slice 全 closed → pass", () => {
    const unit = featureForRetrospect();
    unit.retrospectData = makeValidFeatureRetrospectDataForSplits(["s1", "s2"]);
    const results = runFeatureRetrospectGates(unit, ["closed", "closed"]);
    const allWaves = results[0]!;
    expect(allWaves.passed).toBe(true);
  });

  it("child slice 含 created（未终态）→ fail", () => {
    const unit = featureForRetrospect();
    unit.retrospectData = makeValidFeatureRetrospectDataForSplits(["s1", "s2"]);
    const results = runFeatureRetrospectGates(unit, ["closed", "created"]);
    expect(results[0]!.passed).toBe(false);
  });

  it("child slice 全 aborted 也算终态 → pass", () => {
    const unit = featureForRetrospect();
    unit.retrospectData = makeValidFeatureRetrospectDataForSplits(["s1", "s2"]);
    const results = runFeatureRetrospectGates(unit, ["aborted", "aborted"]);
    expect(results[0]!.passed).toBe(true);
  });

  it("childStatuses 为空（无 child slice）→ fail", () => {
    const unit = featureForRetrospect();
    unit.retrospectData = makeValidFeatureRetrospectDataForSplits(["s1", "s2"]);
    const results = runFeatureRetrospectGates(unit, []);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.report).toMatch(/没有 child/);
  });

  it("child slice 含 executing（中间态）→ fail", () => {
    const unit = featureForRetrospect();
    unit.retrospectData = makeValidFeatureRetrospectDataForSplits(["s1", "s2"]);
    const results = runFeatureRetrospectGates(unit, ["closed", "executing"]);
    expect(results[0]!.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// sliceLessonsLearnedNonEmpty
// ═══════════════════════════════════════════════════════════════

describe("runFeatureRetrospectGates: lessonsLearnedNonEmpty", () => {
  it("lessonsLearned 非空 → pass", () => {
    const unit = featureForRetrospect();
    const rd = makeValidFeatureRetrospectDataForSplits(["s1", "s2"]);
    unit.retrospectData = rd;
    const results = runFeatureRetrospectGates(unit, ["closed", "closed"]);
    expect(results[1]!.passed).toBe(true);
  });

  it("lessonsLearned 空 → fail", () => {
    const unit = featureForRetrospect();
    const rd = makeValidFeatureRetrospectDataForSplits(["s1", "s2"]);
    rd.lessonsLearned = "";
    unit.retrospectData = rd;
    const results = runFeatureRetrospectGates(unit, ["closed", "closed"]);
    expect(results[1]!.passed).toBe(false);
    expect(results[1]!.report).toMatch(/lessons-learned/);
  });

  it("lessonsLearned 纯空白 → fail", () => {
    const unit = featureForRetrospect();
    const rd = makeValidFeatureRetrospectDataForSplits(["s1", "s2"]);
    rd.lessonsLearned = "   ";
    unit.retrospectData = rd;
    const results = runFeatureRetrospectGates(unit, ["closed", "closed"]);
    expect(results[1]!.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// reviewedItemsCoverDesignReview
// ═══════════════════════════════════════════════════════════════

describe("runFeatureRetrospectGates: reviewedItemsCoverDesignReview", () => {
  it("reviewedItems 覆盖全部核心项（necessity/sufficiency/alternatives/TF1/RK1）→ pass", () => {
    const unit = featureForRetrospect();
    unit.retrospectData = makeValidFeatureRetrospectDataForSplits(["s1", "s2"]);
    const results = runFeatureRetrospectGates(unit, ["closed", "closed"]);
    expect(results[2]!.passed).toBe(true);
  });

  it("reviewedItems 缺 TF1 → fail（report 提及 TF1）", () => {
    const unit = featureForRetrospect();
    const rd = makeValidFeatureRetrospectDataForSplits(["s1", "s2"]);
    rd.reviewedItems = rd.reviewedItems.filter((r) => r.itemId !== "TF1");
    unit.retrospectData = rd;
    const results = runFeatureRetrospectGates(unit, ["closed", "closed"]);
    expect(results[2]!.passed).toBe(false);
    expect(results[2]!.report).toMatch(/TF1/);
  });

  it("reviewedItems 缺 necessity → fail", () => {
    const unit = featureForRetrospect();
    const rd = makeValidFeatureRetrospectDataForSplits(["s1", "s2"]);
    rd.reviewedItems = rd.reviewedItems.filter((r) => r.itemId !== "necessity");
    unit.retrospectData = rd;
    const results = runFeatureRetrospectGates(unit, ["closed", "closed"]);
    expect(results[2]!.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// splitFulfillmentCoversPlan
// ═══════════════════════════════════════════════════════════════

describe("runFeatureRetrospectGates: splitFulfillmentCoversPlan", () => {
  it("splitFulfillment 覆盖 split 全部 slug（s1, s2）→ pass", () => {
    const unit = featureForRetrospect();
    unit.retrospectData = makeValidFeatureRetrospectDataForSplits(["s1", "s2"]);
    const results = runFeatureRetrospectGates(unit, ["closed", "closed"]);
    expect(results[3]!.passed).toBe(true);
  });

  it("splitFulfillment 缺 s2 → fail（report 提及 s2）", () => {
    const unit = featureForRetrospect();
    unit.retrospectData = makeValidFeatureRetrospectDataForSplits(["s1"]);
    const results = runFeatureRetrospectGates(unit, ["closed", "closed"]);
    expect(results[3]!.passed).toBe(false);
    expect(results[3]!.report).toMatch(/s2/);
  });

  it("splitFulfillment 全空 → fail（report 提及 s1, s2）", () => {
    const unit = featureForRetrospect();
    unit.retrospectData = makeValidFeatureRetrospectDataForSplits([]);
    const results = runFeatureRetrospectGates(unit, ["closed", "closed"]);
    expect(results[3]!.passed).toBe(false);
    expect(results[3]!.report).toMatch(/s1/);
  });
});

// ═══════════════════════════════════════════════════════════════
// runFeatureRetrospectGates 聚合
// ═══════════════════════════════════════════════════════════════

describe("runFeatureRetrospectGates 聚合（6 个 gate）", () => {
  it("合法 retrospectData + child 全 closed → 6 个 gate 全 pass", () => {
    const unit = featureForRetrospect();
    unit.retrospectData = makeValidFeatureRetrospectDataForSplits(["s1", "s2"]);
    const results = runFeatureRetrospectGates(unit, ["closed", "closed"]);
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("child 未全 closed + lessonsLearned 空 + 缺 reviewedItems + 缺 splitFulfillment → 4 gate 全 fail", () => {
    const unit = featureForRetrospect();
    unit.retrospectData = {
      reviewedItems: [],
      lessonsLearned: "",
      deliveryVerdict: "failed",
      childUnitIdsEvidence: [],
      splitFulfillment: [],
    };
    const failed = runFeatureRetrospectGates(unit, ["created"]).filter((r) => !r.passed);
    // 原 4 个 gate fail；新增 childUnitEvidenceComplete（childUnitIds 空 → pass）+ deliveryVerdictNonEmpty（"failed" → pass）
    expect(failed).toHaveLength(4);
  });
});

// ═══════════════════════════════════════════════════════════════
// dispatch 集成：child slice 未全 close 时 retrospect 短路
// ═══════════════════════════════════════════════════════════════

describe("dispatch 集成：child slice 未全 close → retrospect ok=false 不流转", () => {
  it("execute 后 child slice 仍 created（未推进）→ retrospect ok=false，status 仍 executing", () => {
    const unitId = setupToFeatureExecuting(env.deps, "retro-integration");
    // 不推进 child slice，直接 retrospect
    const result = dispatch(
      {
        action: "retrospect",
        unitId,
        input: { retrospectData: makeValidFeatureRetrospectData() },
      },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.gateResults).toBeDefined();
    expect(result.gateResults!.some((g) => /all-waves-closed/.test(g.report))).toBe(true);
    // status 未推进（仍 executing）
    const feature = env.store.load(unitId) as unknown as { status: string };
    expect(feature.status).toBe("executing");
  });

  it("child slice 全 closed → retrospect ok=true 流转到 retrospected", () => {
    const unitId = setupFeatureWithClosedSlices(env.deps, "retro-ok");
    const feature = env.store.load(unitId) as unknown as {
      executeResult: { childUnitIds: string[] };
      plan: { split: { slug: string }[] };
    };
    const result = dispatch(
      {
        action: "retrospect",
        unitId,
        input: {
          retrospectData: makeValidFeatureRetrospectData(
            feature.executeResult.childUnitIds,
            feature.plan.split.map((s) => s.slug),
          ),
        },
      },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("retrospected");
  });
});

// ── 辅助：按指定 split slug 构造合法 PlanningRetrospectData ──

/**
 * 构造合法 PlanningRetrospectData（reviewedItems 覆盖 makeValidFeatureDesignReviewJudgment 的
 * necessity/sufficiency/alternatives/TF1/RK1，lessonsLearned 非空），splitFulfillment 按
 * 传入的 splitSlugs 填充。
 */
function makeValidFeatureRetrospectDataForSplits(splitSlugs: string[]): PlanningRetrospectData {
  return {
    reviewedItems: [
      { itemId: "necessity", outcome: "fulfilled" },
      { itemId: "sufficiency", outcome: "fulfilled" },
      { itemId: "alternatives", outcome: "fulfilled" },
      { itemId: "TF1", outcome: "fulfilled" },
      { itemId: "RK1", outcome: "fulfilled" },
    ],
    lessonsLearned: "feature spec gave slices clear contract",
    deliveryVerdict: "delivered",
    childUnitIdsEvidence: splitSlugs.map((slug) => ({
      childId: `slice:retro-feature::${slug}`,
      status: "closed" as const,
    })),
    splitFulfillment: splitSlugs.map((slug) => ({ splitSlug: slug, verdict: "delivered" as const })),
  };
}

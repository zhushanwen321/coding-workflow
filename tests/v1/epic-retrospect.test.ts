/**
 * v1 epic retrospect 测试。
 *
 * 测 epic retrospect 的验收逻辑（epic-internal.runEpicRetrospectGates，7 个 gate）：
 * - allWavesClosed（child feature 未全 closed/aborted → fail）
 * - sliceLessonsLearnedNonEmpty（lessonsLearned 空 → fail）
 * - reviewedItemsCoverDesignReview（reviewedItems 未覆盖 designReviewJudgment 核心项 → fail）
 * - splitFulfillmentCoversPlan（splitFulfillment 未覆盖 plan.split 全部 slug → fail）
 *
 * 另通过 dispatch 集成验：child feature 未全 close 时 retrospect ok=false 不流转；
 * splitFulfillment 覆盖所有 split 时通过。
 *
 * 真实 store + stub V1Deps。零 mock 框架。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PlanningRetrospectData } from "../../src/core/judgments.js";
import { createEpic, type Epic } from "../../src/core/workunit.js";
import { dispatch } from "../../src/dispatch.js";
import { runEpicRetrospectGates } from "../../src/handlers/epic/epic-internal.js";
import type { V1Deps } from "../../src/handlers/types.js";
import {
  createV1Env,
  makeValidClarification,
  makeValidEpicDesignReviewJudgment,
  makeValidEpicRetrospectData,
  makeValidEpicSplit,
  setupEpicWithClosedFeatures,
  setupToEpicExecuting,
} from "./helpers/epic-env.js";
import {
  makeFeatureClarifyInput,
  makeValidFeatureDesignReviewJudgment,
  makeValidFeaturePlan,
} from "./helpers/feature-env.js";
import {
  advanceWaveToClosed,
  makeValidSliceDesignReviewJudgment,
  makeValidSlicePlan,
} from "./helpers/slice-env.js";
import type { V1Env } from "./helpers/v1-env.js";

let env: V1Env;

beforeEach(() => {
  env = createV1Env();
});

afterEach(() => {
  env.cleanup();
});

// ── 辅助：构造一个已填好 judgment 的 epic（retrospect gate 基线）──

/** 构造合法 epic（designReviewJudgment + plan.split 已填，retrospect 基线，retrospectData 待填）。 */
function epicForRetrospect(): Epic {
  // 直接构造 unit（不走 store），designReviewJudgment + plan.split 填合法值
  const unit = createEpic({ slug: "retro-epic", objective: "o" });
  unit.designReviewJudgment = makeValidEpicDesignReviewJudgment();
  unit.plan = {
    split: [
      { slug: "f1", description: "f1", dependsOn: [], inheritedItemIds: ["Q1"] },
      { slug: "f2", description: "f2", dependsOn: ["f1"], inheritedItemIds: ["Q1"] },
    ],
  };
  return unit;
}

// ═══════════════════════════════════════════════════════════════
// allWavesClosed（child feature 终态判定）
// ═══════════════════════════════════════════════════════════════

describe("runEpicRetrospectGates: allWavesClosed", () => {
  it("child feature 全 closed → pass", () => {
    const unit = epicForRetrospect();
    unit.retrospectData = makeValidEpicRetrospectDataForSplits(["f1", "f2"]);
    const results = runEpicRetrospectGates(unit, ["closed", "closed"]);
    const allWaves = results[0]!;
    expect(allWaves.passed).toBe(true);
  });

  it("child feature 含 created（未终态）→ fail", () => {
    const unit = epicForRetrospect();
    unit.retrospectData = makeValidEpicRetrospectDataForSplits(["f1", "f2"]);
    const results = runEpicRetrospectGates(unit, ["closed", "created"]);
    expect(results[0]!.passed).toBe(false);
  });

  it("child feature 全 aborted 也算终态 → pass", () => {
    const unit = epicForRetrospect();
    unit.retrospectData = makeValidEpicRetrospectDataForSplits(["f1", "f2"]);
    const results = runEpicRetrospectGates(unit, ["aborted", "aborted"]);
    expect(results[0]!.passed).toBe(true);
  });

  it("childStatuses 为空（无 child feature）→ fail", () => {
    const unit = epicForRetrospect();
    unit.retrospectData = makeValidEpicRetrospectDataForSplits(["f1", "f2"]);
    const results = runEpicRetrospectGates(unit, []);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.report).toMatch(/没有 child/);
  });

  it("child feature 含 executing（中间态）→ fail", () => {
    const unit = epicForRetrospect();
    unit.retrospectData = makeValidEpicRetrospectDataForSplits(["f1", "f2"]);
    const results = runEpicRetrospectGates(unit, ["closed", "executing"]);
    expect(results[0]!.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// lessonsLearnedNonEmpty
// ═══════════════════════════════════════════════════════════════

describe("runEpicRetrospectGates: lessonsLearnedNonEmpty", () => {
  it("lessonsLearned 非空 → pass", () => {
    const unit = epicForRetrospect();
    const rd = makeValidEpicRetrospectDataForSplits(["f1", "f2"]);
    unit.retrospectData = rd;
    const results = runEpicRetrospectGates(unit, ["closed", "closed"]);
    expect(results[1]!.passed).toBe(true);
  });

  it("lessonsLearned 空 → fail", () => {
    const unit = epicForRetrospect();
    const rd = makeValidEpicRetrospectDataForSplits(["f1", "f2"]);
    rd.lessonsLearned = "";
    unit.retrospectData = rd;
    const results = runEpicRetrospectGates(unit, ["closed", "closed"]);
    expect(results[1]!.passed).toBe(false);
    expect(results[1]!.report).toMatch(/lessons-learned/);
  });

  it("lessonsLearned 纯空白 → fail", () => {
    const unit = epicForRetrospect();
    const rd = makeValidEpicRetrospectDataForSplits(["f1", "f2"]);
    rd.lessonsLearned = "   ";
    unit.retrospectData = rd;
    const results = runEpicRetrospectGates(unit, ["closed", "closed"]);
    expect(results[1]!.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// reviewedItemsCoverDesignReview
// ═══════════════════════════════════════════════════════════════

describe("runEpicRetrospectGates: reviewedItemsCoverDesignReview", () => {
  it("reviewedItems 覆盖全部核心项（necessity/sufficiency/alternatives/TF1/RK1）→ pass", () => {
    const unit = epicForRetrospect();
    unit.retrospectData = makeValidEpicRetrospectDataForSplits(["f1", "f2"]);
    const results = runEpicRetrospectGates(unit, ["closed", "closed"]);
    expect(results[2]!.passed).toBe(true);
  });

  it("reviewedItems 缺 TF1 → fail（report 提及 TF1）", () => {
    const unit = epicForRetrospect();
    const rd = makeValidEpicRetrospectDataForSplits(["f1", "f2"]);
    rd.reviewedItems = rd.reviewedItems.filter((r) => r.itemId !== "TF1");
    unit.retrospectData = rd;
    const results = runEpicRetrospectGates(unit, ["closed", "closed"]);
    expect(results[2]!.passed).toBe(false);
    expect(results[2]!.report).toMatch(/TF1/);
  });

  it("reviewedItems 缺 necessity → fail", () => {
    const unit = epicForRetrospect();
    const rd = makeValidEpicRetrospectDataForSplits(["f1", "f2"]);
    rd.reviewedItems = rd.reviewedItems.filter((r) => r.itemId !== "necessity");
    unit.retrospectData = rd;
    const results = runEpicRetrospectGates(unit, ["closed", "closed"]);
    expect(results[2]!.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// splitFulfillmentCoversPlan
// ═══════════════════════════════════════════════════════════════

describe("runEpicRetrospectGates: splitFulfillmentCoversPlan", () => {
  it("splitFulfillment 覆盖 split 全部 slug（f1, f2）→ pass", () => {
    const unit = epicForRetrospect();
    unit.retrospectData = makeValidEpicRetrospectDataForSplits(["f1", "f2"]);
    const results = runEpicRetrospectGates(unit, ["closed", "closed"]);
    expect(results[3]!.passed).toBe(true);
  });

  it("splitFulfillment 缺 f2 → fail（report 提及 f2）", () => {
    const unit = epicForRetrospect();
    unit.retrospectData = makeValidEpicRetrospectDataForSplits(["f1"]);
    const results = runEpicRetrospectGates(unit, ["closed", "closed"]);
    expect(results[3]!.passed).toBe(false);
    expect(results[3]!.report).toMatch(/f2/);
  });

  it("splitFulfillment 全空 → fail（report 提及 f1, f2）", () => {
    const unit = epicForRetrospect();
    unit.retrospectData = makeValidEpicRetrospectDataForSplits([]);
    const results = runEpicRetrospectGates(unit, ["closed", "closed"]);
    expect(results[3]!.passed).toBe(false);
    expect(results[3]!.report).toMatch(/f1/);
  });
});

// ═══════════════════════════════════════════════════════════════
// runEpicRetrospectGates 聚合
// ═══════════════════════════════════════════════════════════════

describe("runEpicRetrospectGates 聚合（7 个 gate）", () => {
  it("合法 retrospectData + child 全 closed → 7 个 gate 全 pass", () => {
    const unit = epicForRetrospect();
    unit.retrospectData = makeValidEpicRetrospectDataForSplits(["f1", "f2"]);
    const results = runEpicRetrospectGates(unit, ["closed", "closed"]);
    expect(results).toHaveLength(7);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("child 未全 closed + lessonsLearned 空 + 缺 reviewedItems + 缺 splitFulfillment → 4 gate fail（新增 2 gate 仍 pass）", () => {
    const unit = epicForRetrospect();
    unit.retrospectData = {
      reviewedItems: [],
      lessonsLearned: "",
      deliveryVerdict: "failed",
      childUnitIdsEvidence: [],
      splitFulfillment: [],
    };
    const failed = runEpicRetrospectGates(unit, ["created"]).filter((r) => !r.passed);
    // allWavesClosed + lessons + cover + splitFulfillment 这 4 个 fail；childUnitEvidenceComplete（childUnitIds 空 → pass）+ deliveryVerdictNonEmpty（"failed" → pass）+ childDeliveryConsistency（childDelivery 空 → pass）
    expect(failed).toHaveLength(4);
  });
});

// ═══════════════════════════════════════════════════════════════
// dispatch 集成：child feature 未全 close 时 retrospect 短路
// ═══════════════════════════════════════════════════════════════

describe("dispatch 集成：child feature 未全 close → retrospect ok=false 不流转", () => {
  it("execute 后 child feature 仍 created（未推进）→ retrospect ok=false，status 仍 executing", () => {
    const unitId = setupToEpicExecuting(env.deps, "retro-integration");
    // 不推进 child feature，直接 retrospect
    const result = dispatch(
      {
        action: "retrospect",
        unitId,
        input: { retrospectData: makeValidEpicRetrospectData() },
      },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.gateResults).toBeDefined();
    expect(result.gateResults!.some((g) => /all-waves-closed/.test(g.report))).toBe(true);
    // status 未推进（仍 executing）
    const epic = env.store.load(unitId) as unknown as { status: string };
    expect(epic.status).toBe("executing");
  });

  it("child feature 全 closed → retrospect ok=true 流转到 retrospected", () => {
    const unitId = setupEpicWithClosedFeatures(env.deps, "retro-ok");
    const epic = env.store.load(unitId) as unknown as {
      executeResult: { childUnitIds: string[] };
      plan: { split: { slug: string }[] };
    };
    const result = dispatch(
      {
        action: "retrospect",
        unitId,
        input: {
          retrospectData: makeValidEpicRetrospectData(
            epic.executeResult.childUnitIds,
            epic.plan.split.map((s) => s.slug),
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
 * 构造合法 PlanningRetrospectData（reviewedItems 覆盖 makeValidEpicDesignReviewJudgment 的
 * necessity/sufficiency/alternatives/TF1/RK1，lessonsLearned 非空），splitFulfillment 按
 * 传入的 splitSlugs 填充。
 */
function makeValidEpicRetrospectDataForSplits(splitSlugs: string[]): PlanningRetrospectData {
  return {
    reviewedItems: [
      { itemId: "necessity", outcome: "fulfilled" },
      { itemId: "sufficiency", outcome: "fulfilled" },
      { itemId: "alternatives", outcome: "fulfilled" },
      { itemId: "TF1", outcome: "fulfilled" },
      { itemId: "RK1", outcome: "fulfilled" },
    ],
    lessonsLearned: "epic split gave features clear contract",
    deliveryVerdict: "delivered",
    childUnitIdsEvidence: splitSlugs.map((slug) => ({
      childId: `feature:retro-epic::${slug}`,
      status: "closed" as const,
    })),
    splitFulfillment: splitSlugs.map((slug) => ({ splitSlug: slug, verdict: "delivered" as const })),
  };
}

// ═══════════════════════════════════════════════════════════════
// T9d: epic retrospect 混合终态（部分 closed + 部分 aborted）
// ═══════════════════════════════════════════════════════════════

describe("T9d: epic retrospect 混合终态（closed + aborted）", () => {
  it("child f1 closed + child f2 aborted → allWavesClosed gate pass（混合终态）", () => {
    const { epicId, childClosedId, childAbortedId } = setupEpicWithMixedTerminal(env);

    const retrospectData: PlanningRetrospectData = {
      reviewedItems: [
        { itemId: "necessity", outcome: "fulfilled" },
        { itemId: "sufficiency", outcome: "fulfilled" },
        { itemId: "alternatives", outcome: "fulfilled" },
        { itemId: "TF1", outcome: "fulfilled" },
        { itemId: "RK1", outcome: "fulfilled" },
      ],
      lessonsLearned: "mixed terminal: f1 delivered, f2 abandoned for scope reduction",
      deliveryVerdict: "partial",
      childUnitIdsEvidence: [
        { childId: childClosedId, status: "closed" },
        { childId: childAbortedId, status: "aborted" },
      ],
      splitFulfillment: [
        { splitSlug: "f1", verdict: "delivered" },
        { splitSlug: "f2", verdict: "failed" },
      ],
    };

    const result = dispatch(
      { action: "retrospect", unitId: epicId, input: { retrospectData } },
      env.deps,
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("retrospected");
  });

  it("混合终态 retrospect gate 全 pass（6 gate）", () => {
    const { epicId, childClosedId, childAbortedId } = setupEpicWithMixedTerminal(env);

    const unit = env.store.load(epicId) as unknown as Epic;
    unit.retrospectData = {
      reviewedItems: [
        { itemId: "necessity", outcome: "fulfilled" },
        { itemId: "sufficiency", outcome: "fulfilled" },
        { itemId: "alternatives", outcome: "fulfilled" },
        { itemId: "TF1", outcome: "fulfilled" },
        { itemId: "RK1", outcome: "fulfilled" },
      ],
      lessonsLearned: "mixed terminal state handled correctly",
      deliveryVerdict: "partial",
      childUnitIdsEvidence: [
        { childId: childClosedId, status: "closed" },
        { childId: childAbortedId, status: "aborted" },
      ],
      splitFulfillment: [
        { splitSlug: "f1", verdict: "delivered" },
        { splitSlug: "f2", verdict: "failed" },
      ],
    };

    const results = runEpicRetrospectGates(unit, ["closed", "aborted"], [
      { splitSlug: "f1", childUnitId: childClosedId, childStatus: "closed" },
      { splitSlug: "f2", childUnitId: childAbortedId, childStatus: "aborted" },
    ]);
    expect(results).toHaveLength(7);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("混合终态 + deliveryVerdict=partial → deliveryVerdictNonEmpty gate pass", () => {
    const { epicId, childClosedId, childAbortedId } = setupEpicWithMixedTerminal(env);

    const unit = env.store.load(epicId) as unknown as Epic;
    unit.retrospectData = {
      reviewedItems: [
        { itemId: "necessity", outcome: "fulfilled" },
        { itemId: "sufficiency", outcome: "fulfilled" },
        { itemId: "alternatives", outcome: "fulfilled" },
        { itemId: "TF1", outcome: "fulfilled" },
        { itemId: "RK1", outcome: "fulfilled" },
      ],
      lessonsLearned: "partial delivery",
      deliveryVerdict: "partial",
      childUnitIdsEvidence: [
        { childId: childClosedId, status: "closed" },
        { childId: childAbortedId, status: "aborted" },
      ],
      splitFulfillment: [
        { splitSlug: "f1", verdict: "delivered" },
        { splitSlug: "f2", verdict: "failed" },
      ],
    };

    const results = runEpicRetrospectGates(unit, ["closed", "aborted"], [
      { splitSlug: "f1", childUnitId: childClosedId, childStatus: "closed" },
      { splitSlug: "f2", childUnitId: childAbortedId, childStatus: "aborted" },
    ]);
    expect(results[4]!.passed).toBe(true);
  });

  it("混合终态 childUnitIdsEvidence 缺失 aborted child → childUnitEvidenceComplete gate fail", () => {
    const { epicId, childClosedId, childAbortedId } = setupEpicWithMixedTerminal(env);

    const unit = env.store.load(epicId) as unknown as Epic;
    unit.retrospectData = {
      reviewedItems: [
        { itemId: "necessity", outcome: "fulfilled" },
        { itemId: "sufficiency", outcome: "fulfilled" },
        { itemId: "alternatives", outcome: "fulfilled" },
        { itemId: "TF1", outcome: "fulfilled" },
        { itemId: "RK1", outcome: "fulfilled" },
      ],
      lessonsLearned: "partial delivery",
      deliveryVerdict: "partial",
      childUnitIdsEvidence: [
        { childId: childClosedId, status: "closed" },
      ],
      splitFulfillment: [
        { splitSlug: "f1", verdict: "delivered" },
        { splitSlug: "f2", verdict: "failed" },
      ],
    };

    const results = runEpicRetrospectGates(unit, ["closed", "aborted"], [
      { splitSlug: "f1", childUnitId: childClosedId, childStatus: "closed" },
      { splitSlug: "f2", childUnitId: childAbortedId, childStatus: "aborted" },
    ]);
    const childUnitGate = results[4]!;
    expect(childUnitGate.passed).toBe(false);
    expect(childUnitGate.report).toMatch(/childUnitIds/);
  });
});

// ── T9d 辅助 ──

function setupEpicWithMixedTerminal(
  testEnv: V1Env,
): { epicId: string; childClosedId: string; childAbortedId: string } {
  const { deps } = testEnv;
  const slug = "mixed-retro-epic";
  const epicId = `epic:${slug}`;
  dispatch(
    { action: "create", input: { slug, objective: `obj ${slug}`, layer: "epic" } },
    deps,
  );
  dispatch(
    { action: "clarify", unitId: epicId, input: { clarifications: [makeValidClarification()] } },
    deps,
  );
  dispatch(
    {
      action: "plan",
      unitId: epicId,
      input: { split: [makeValidEpicSplit("f1"), makeValidEpicSplit("f2")] },
    },
    deps,
  );
  dispatch(
    { action: "design-review", unitId: epicId, input: { designReviewJudgment: makeValidEpicDesignReviewJudgment() } },
    deps,
  );
  dispatch(
    { action: "execute", unitId: epicId, input: {} } as unknown as Parameters<typeof dispatch>[0],
    deps,
  );

  const epicRecord = deps.store.load(epicId) as unknown as {
    executeResult: { childUnitIds: string[] };
  };
  const childClosedId = epicRecord.executeResult.childUnitIds[0]!;
  const childAbortedId = epicRecord.executeResult.childUnitIds[1]!;

  advanceChildFeatureToClosed(deps, childClosedId);

  dispatch(
    { action: "abort", unitId: childAbortedId, input: { reason: "scope reduction" } },
    deps,
  );

  return { epicId, childClosedId, childAbortedId };
}

function advanceChildFeatureToClosed(deps: V1Deps, featureId: string): void {
  dispatch(
    { action: "clarify", unitId: featureId, input: makeFeatureClarifyInput() },
    deps,
  );
  dispatch(
    { action: "plan", unitId: featureId, input: makeValidFeaturePlan() },
    deps,
  );
  dispatch(
    { action: "design-review", unitId: featureId, input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() } },
    deps,
  );
  dispatch(
    { action: "execute", unitId: featureId, input: {} } as unknown as Parameters<typeof dispatch>[0],
    deps,
  );

  const featureRecord = deps.store.load(featureId) as unknown as {
    executeResult: { childUnitIds: string[] };
    plan: { split: { slug: string }[] };
  };
  for (const sliceId of featureRecord.executeResult.childUnitIds) {
    advanceSliceToClosed(deps, sliceId);
  }

  dispatch(
    {
      action: "retrospect",
      unitId: featureId,
      input: {
        retrospectData: {
          reviewedItems: [
            { itemId: "necessity", outcome: "fulfilled" },
            { itemId: "sufficiency", outcome: "fulfilled" },
            { itemId: "alternatives", outcome: "fulfilled" },
            { itemId: "TF1", outcome: "fulfilled" },
            { itemId: "RK1", outcome: "fulfilled" },
          ],
          lessonsLearned: "feature done",
          deliveryVerdict: "delivered",
          childUnitIdsEvidence: featureRecord.executeResult.childUnitIds.map((id) => ({ childId: id, status: "closed" as const })),
          splitFulfillment: featureRecord.plan.split.map((s) => ({ splitSlug: s.slug, verdict: "delivered" as const })),
        },
      },
    },
    deps,
  );
  dispatch(
    { action: "closeout", unitId: featureId, input: { artifacts: [] } },
    deps,
  );
}

function advanceSliceToClosed(deps: V1Deps, sliceId: string): void {
  dispatch({ action: "clarify", unitId: sliceId, input: { clarifications: [] } }, deps);
  dispatch({ action: "plan", unitId: sliceId, input: makeValidSlicePlan() }, deps);
  dispatch({ action: "design-review", unitId: sliceId, input: { designReviewJudgment: makeValidSliceDesignReviewJudgment() } }, deps);
  dispatch({ action: "execute", unitId: sliceId, input: {} } as unknown as Parameters<typeof dispatch>[0], deps);

  const sliceRecord = deps.store.load(sliceId) as unknown as {
    executeResult: { childUnitIds: string[] };
    plan: { split: { slug: string }[] };
  };
  for (const waveId of sliceRecord.executeResult.childUnitIds) {
    advanceWaveToClosed(deps, waveId);
  }

  dispatch(
    {
      action: "retrospect",
      unitId: sliceId,
      input: {
        retrospectData: {
          reviewedItems: [
            { itemId: "necessity", outcome: "fulfilled" },
            { itemId: "sufficiency", outcome: "fulfilled" },
            { itemId: "alternatives", outcome: "fulfilled" },
            { itemId: "TF1", outcome: "fulfilled" },
            { itemId: "RK1", outcome: "fulfilled" },
          ],
          lessonsLearned: "slice done",
          deliveryVerdict: "delivered",
          childUnitIdsEvidence: sliceRecord.executeResult.childUnitIds.map((id) => ({ childId: id, status: "closed" as const })),
          splitFulfillment: sliceRecord.plan.split.map((s) => ({ splitSlug: s.slug, verdict: "delivered" as const })),
        },
      },
    },
    deps,
  );
  dispatch({ action: "closeout", unitId: sliceId, input: { artifacts: [] } }, deps);
}

/**
 * feature 测试基建 — feature unit 工厂 + 合法 FeatureSpec/Plan/Judgment/RetrospectData 产物工厂
 * + 阶段推进 helper。
 *
 * 复用 v1-env.ts 的 createV1Env / makeStubDeps（隔离环境 + stub V1Deps）。
 * 复用 slice-env.ts 的 makeValidSlicePlan / makeValidSliceDesignReviewJudgment /
 * makeValidPlanningRetrospectData / advanceWaveToClosed（feature 的 child 是 slice，
 * 推进 child slice 复用 slice 的合法产物工厂 + wave 推进 helper）。
 *
 * 本文件只加 feature 专属：
 * - makeFeatureUnit / makeFeatureSpec / makeFeatureClarifyInput / makeValidFeaturePlan /
 *   makeValidFeatureDesignReviewJudgment / makeValidFeatureRetrospectData
 * - 阶段推进 helper：setupToFeaturePlanning / setupToFeatureDesignReviewed /
 *   setupToFeatureExecuting / setupFeatureWithClosedSlices（调 dispatch 推进到各状态）。
 *
 * 零 mock 框架：真实 V1Store + tmp 目录（同 v1-env.ts 约定）。
 */
import type {
  AcceptanceCriterion,
  BusinessCase,
  Clarification,
  FeatureSpec,
  FunctionalRequirement,
} from "../../../src/core/clarifications.js";
import type {
  DesignReviewJudgment,
  FeatureDesignReviewLayerSpecific,
  PlanningRetrospectData,
} from "../../../src/core/judgments.js";
import type { Split } from "../../../src/core/plan.js";
import type { Feature } from "../../../src/core/workunit.js";
import { createFeature } from "../../../src/core/workunit.js";
import { dispatch } from "../../../src/dispatch.js";
import type { V1Deps } from "../../../src/handlers/types.js";
import {
  advanceWaveToClosed,
  makeValidPlanningRetrospectData,
  makeValidSliceDesignReviewJudgment,
  makeValidSlicePlan,
} from "./slice-env.js";
import {
  createV1Env,
  makeStubDeps,
  STUB_NOW,
} from "./v1-env.js";

export {
  createV1Env,
  makeStubDeps,
  STUB_NOW,
};

// ═══════════════════════════════════════════════════════════════
// feature unit 工厂
// ═══════════════════════════════════════════════════════════════

/** 构造一个 feature unit（初始 status=created，空 FeatureClarification 容器 + 空 plan）。 */
export function makeFeatureUnit(slug = "test-feature"): Feature {
  return createFeature({
    slug,
    objective: `objective for ${slug}`,
    createdAt: STUB_NOW,
  });
}

// ═══════════════════════════════════════════════════════════════
// 合法 FeatureSpec 条目工厂（构造能过 design-review 的 FR-AC 强引用 gate）
// ═══════════════════════════════════════════════════════════════

/** 合法的 AcceptanceCriterion（active，condition 非空）。 */
export function makeValidAcceptanceCriterion(id = "AC1"): AcceptanceCriterion {
  return {
    id,
    status: "active",
    condition: `系统应满足 ${id}`,
    verification: "review",
  };
}

/** 合法的 FunctionalRequirement（active，title/detail 非空，ac 强引用 AC1）。 */
export function makeValidFunctionalRequirement(id = "FR1"): FunctionalRequirement {
  return {
    id,
    status: "active",
    title: `功能需求 ${id}`,
    detail: `${id} 的详细描述`,
    ac: ["AC1"], // 强引用 AC1，满足 frAcCoverage gate
  };
}

/** 合法的 BusinessCase（active）。 */
export function makeValidBusinessCase(id = "BC1"): BusinessCase {
  return {
    id,
    status: "active",
    actor: "终端用户",
    scenario: `用户执行 ${id}`,
    expectedResult: `预期结果 ${id}`,
  };
}

/** 合法的 Clarification（research 类，已答）。 */
export function makeValidClarification(id = "Q1"): Clarification {
  return {
    id,
    status: "active",
    question: `${id} 需要澄清吗`,
    resolution: `${id} 的决议`,
    type: "research",
  };
}

/**
 * 合法的 FeatureSpec（过 feature design-review 的 3 个 FR-AC 强引用 gate）。
 *
 * 满足：
 * - frAcCoverage：每个 active FR.ac 非空且 id 存在（FR1→AC1）
 * - acReachableFromFr：每个 active AC 被至少一个 active FR 引用（AC1←FR1）
 * - acNonEmpty：active AC 至少 1 条（AC1）
 *
 * 含 1 FR + 1 AC + 1 BC + decisions 空数组 + outOfScope。
 */
export function makeFeatureSpec(overrides?: Partial<FeatureSpec>): FeatureSpec {
  const base: FeatureSpec = {
    functionalRequirements: [makeValidFunctionalRequirement()],
    acceptanceCriteria: [makeValidAcceptanceCriterion()],
    businessCases: [makeValidBusinessCase()],
    decisions: [],
    outOfScope: ["不在本 feature 范围内的内容"],
  };
  return { ...base, ...overrides };
}

/**
 * 合法的 FeatureClarifyInput（clarifications + spec，整体覆盖写入）。
 *
 * spec 用 makeFeatureSpec（满足 FR-AC 强引用 gate）。
 */
export function makeFeatureClarifyInput(overrides?: {
  clarifications?: Clarification[];
  spec?: FeatureSpec;
}): {
  clarifications: Clarification[];
  spec: FeatureSpec;
} {
  return {
    clarifications: overrides?.clarifications ?? [makeValidClarification()],
    spec: overrides?.spec ?? makeFeatureSpec(),
  };
}

/**
 * 合法的 feature Split（slug + description + dependsOn + inheritedItemIds）。
 *
 * inheritedItemIds 引用 FR/AC id，execute 时写入 child slice 的 basedOnParent
 *（replan 影响面计算的基础）。
 */
export function makeValidFeatureSplit(slug = "s1"): Split {
  return {
    slug,
    description: `slice ${slug} 实现`,
    dependsOn: [],
    inheritedItemIds: ["FR1", "AC1"],
  };
}

/**
 * 合法的 feature plan（Plan 基类，只 split）。
 *
 * 过 feature design-review 的 split 结构 gate（featureSplitNonEmpty + featureSplitDagValid）。
 * 含 1 split（slug=s1，无依赖）。
 */
export function makeValidFeaturePlan(): { split: Split[] } {
  return {
    split: [makeValidFeatureSplit("s1")],
  };
}

// ═══════════════════════════════════════════════════════════════
// 合法 judgment / retrospectData 工厂
// ═══════════════════════════════════════════════════════════════

/**
 * 合法的 FeatureDesignReviewLayerSpecific（6 字段全非空）。
 *
 * 注意：DesignReviewJudgment.layerSpecific 基类类型是 WaveDesignReviewLayerSpecific
 *（已知坑4，slice 也同样如此）。返回为 feature 子类型，调用方写入 judgment 时需
 * `as unknown as DesignReviewJudgment["layerSpecific"]`（与 slice 工厂做法一致）。
 */
export function makeValidFeatureLayerSpecific(): FeatureDesignReviewLayerSpecific {
  return {
    specMeceNote: "FR/AC/BC MECE：FR1 由 AC1 验收，无遗漏无重叠",
    sliceSplitRationale: "拆 1 个 slice 兑现 FR1，边界清晰",
    acVerifiabilityNote: "AC1 可 review 验证，verification 字段已填",
    consistencyNote: "spec 各字段自洽，FR.ac 引用的 AC id 均存在",
    frAcCoverageNote: "FR1→AC1 强引用完整，无孤儿 AC",
    sliceSpecCoverageNote: "split.inheritedItemIds 覆盖 FR1+AC1，无悬空",
  };
}

/**
 * 合法的 DesignReviewJudgment（feature 版，过 5 个 judgment gate + featureLayerSpecificNonEmpty）。
 *
 * 与 slice 的 makeValidSliceDesignReviewJudgment 同构（necessity/sufficiency/alternatives/
 * tradeoffs/risks 都填），layerSpecific 用 feature 专属 6 字段（makeValidFeatureLayerSpecific）。
 * 含 TF1/RK1 便于 retrospect 覆盖引用。
 */
export function makeValidFeatureDesignReviewJudgment(): DesignReviewJudgment {
  return {
    necessity: "this feature delivers the oauth login feature spec",
    sufficiency: {
      gaps: [],
      overlaps: [],
      meceNote: "MECE: FR1 login + token, no overlap",
    },
    alternatives: "considered session-based feature, rejected for stateless",
    tradeoffs: [
      { id: "TF1", decision: "oauth over session", reason: "stateless", cost: "revocation harder" },
    ],
    risks: [
      { id: "RK1", item: "provider downtime", severity: "medium", mitigation: "fallback cache" },
    ],
    layerSpecific: makeValidFeatureLayerSpecific() as unknown as DesignReviewJudgment["layerSpecific"],
  };
}

/**
 * 合法的 PlanningRetrospectData（feature 版，过 feature retrospect 6 gate）。
 *
 * reviewedItems 覆盖 necessity/sufficiency/alternatives/TF1/RK1（对应 makeValidFeatureDesignReviewJudgment）。
 * splitFulfillment 覆盖 makeValidFeaturePlan 的 split slug "s1"。
 * childUnitIdsEvidence 默认指向 child slice（slice:test-feature::s1）。
 *
 * 可选参数（advance helper 推进完 child slice 后从 store 读真实 id/slug 传入）：
 * - childUnitIds：传则按真实 childUnitIds 构造 childUnitIdsEvidence；不传用默认 "slice:test-feature::s1"
 * - splitSlugs：传则按真实 plan.split slug 构造 splitFulfillment；不传用默认 "s1"
 */
export function makeValidFeatureRetrospectData(
  childUnitIds?: string[],
  splitSlugs?: string[],
): PlanningRetrospectData {
  const ids = childUnitIds ?? ["slice:test-feature::s1"];
  const slugs = splitSlugs ?? ["s1"];
  return {
    reviewedItems: [
      { itemId: "necessity", outcome: "fulfilled" },
      { itemId: "sufficiency", outcome: "fulfilled" },
      { itemId: "alternatives", outcome: "fulfilled" },
      { itemId: "TF1", outcome: "fulfilled" },
      { itemId: "RK1", outcome: "fulfilled", note: "provider fallback added" },
    ],
    lessonsLearned: "feature spec gave slice clear contract, minimal rework",
    deliveryVerdict: "delivered",
    childUnitIdsEvidence: ids.map((id) => ({ childId: id, status: "closed" as const })),
    splitFulfillment: slugs.map((slug) => ({ splitSlug: slug, verdict: "delivered" as const })),
  };
}

/**
 * 从 store 读 feature 的真实 childUnitIds + plan.split slugs，构造过全部 gate 的 feature PlanningRetrospectData。
 *
 * e2e / state-machine 测试做 feature retrospect 前用这个，避免 childUnitIdsEvidence
 * 与动态生成的 child slice id 不匹配导致 childUnitEvidenceComplete gate fail。
 */
export function makeFeatureRetrospectDataFromStore(
  deps: V1Deps,
  unitId: string,
): PlanningRetrospectData {
  const record = deps.store.load(unitId) as unknown as {
    executeResult: { childUnitIds: string[] };
    plan: { split: { slug: string }[] };
  };
  return makeValidFeatureRetrospectData(
    record.executeResult.childUnitIds,
    record.plan.split.map((s) => s.slug),
  );
}

// ═══════════════════════════════════════════════════════════════
// 阶段推进 helper（通过 dispatch 推进到各状态，e2e/gates/retrospect 测试复用）
// ═══════════════════════════════════════════════════════════════

/** feature execute 按 split 创建 child slice，不接收 input。V1Params execute 分支锁 ExecuteInput，故断言。 */
type DispatchParams = Parameters<typeof dispatch>[0];

/** feature execute 的 dispatch 参数（无 input，handler 忽略）。 */
function featureExecute(unitId: string): DispatchParams {
  return { action: "execute", unitId, input: {} } as unknown as DispatchParams;
}

/**
 * 推进 feature 到 clarifying 状态（create → clarify）。
 *
 * 用 dispatch 走完整路径（create → clarify），写入合法 FeatureClarification。
 * 返回 feature unit id。
 *
 * @param deps stub V1Deps（store 注入）
 * @param slug feature slug（默认 test-feature）
 */
export function setupToFeatureClarified(deps: V1Deps, slug = "test-feature"): string {
  const unitId = `feature:${slug}`;
  dispatch(
    { action: "create", input: { slug, objective: `obj ${slug}`, layer: "feature" } },
    deps,
  );
  dispatch(
    {
      action: "clarify",
      unitId,
      input: makeFeatureClarifyInput(),
    },
    deps,
  );
  return unitId;
}

/**
 * 推进 feature 到 planning 状态（+ plan）。
 * 返回 feature unit id（status=planning，plan.split 已写入）。
 */
export function setupToFeaturePlanning(deps: V1Deps, slug = "test-feature"): string {
  const unitId = setupToFeatureClarified(deps, slug);
  dispatch(
    { action: "plan", unitId, input: makeValidFeaturePlan() },
    deps,
  );
  return unitId;
}

/**
 * 推进 feature 到 design-reviewed 状态（+ design-review 过 gate）。
 * 返回 feature unit id（status=design-reviewed，可直接 execute）。
 */
export function setupToFeatureDesignReviewed(deps: V1Deps, slug = "test-feature"): string {
  const unitId = setupToFeaturePlanning(deps, slug);
  dispatch(
    {
      action: "design-review",
      unitId,
      input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() },
    },
    deps,
  );
  return unitId;
}

/**
 * 推进 feature 到 executing 状态（+ execute 创建 child slice）。
 * 返回 feature unit id（status=executing，child slice 已创建）。
 */
export function setupToFeatureExecuting(deps: V1Deps, slug = "test-feature"): string {
  const unitId = setupToFeatureDesignReviewed(deps, slug);
  dispatch(featureExecute(unitId), deps);
  return unitId;
}

/**
 * 推进 feature 的所有 child slice 到 closed（走完 slice 7 步）。
 *
 * feature execute 按 plan.split 创建 child slice（status=created）。这里逐个 child slice
 * 走完整生命周期（clarify→plan→design-review→execute→[child wave closed]→retrospect→closeout）
 * 到 closed，使 feature 的 retrospect allWavesClosed gate 可通过。
 *
 * 注意：child slice closeout 不自动 rollup 到 parent feature（slice closeout 未接入 rollup，
 * 只有 wave abort 接入）。但 feature retrospect 的 allWavesClosed 从 store.findChildren 读实时
 * status（不依赖 childDelivery），故只要 child slice 真的 closed 即可通过。
 *
 * @param deps stub V1Deps
 * @param featureId feature unit id
 * @returns child slice id 列表
 */
export function advanceChildSlicesToClosed(deps: V1Deps, featureId: string): string[] {
  const record = deps.store.load(featureId);
  if (!record) throw new Error(`feature not found: ${featureId}`);
  const childUnitIds = (record as unknown as {
    executeResult: { childUnitIds: string[] };
  }).executeResult.childUnitIds;

  for (const childId of childUnitIds) {
    // child slice 走完整生命周期到 closed（复用 slice 的 dispatch 流程）
    dispatch(
      { action: "clarify", unitId: childId, input: { clarifications: [] } },
      deps,
    );
    // slice plan 用合法 SlicePlan（复用 slice-env 的 makeValidSlicePlan）
    dispatch(
      { action: "plan", unitId: childId, input: makeValidSlicePlan() },
      deps,
    );
    dispatch(
      {
        action: "design-review",
        unitId: childId,
        input: { designReviewJudgment: makeValidSliceDesignReviewJudgment() },
      },
      deps,
    );
    dispatch(
      { action: "execute", unitId: childId, input: {} } as unknown as DispatchParams,
      deps,
    );
    // 推进 child slice 的 child wave 到 closed
    const sliceRecord = deps.store.load(childId) as unknown as {
      executeResult: { childUnitIds: string[] };
      plan: { split: { slug: string }[] };
    };
    for (const waveId of sliceRecord.executeResult.childUnitIds) {
      advanceWaveToClosed(deps, waveId);
    }
    dispatch(
      {
        action: "retrospect",
        unitId: childId,
        input: {
          retrospectData: makeValidPlanningRetrospectData(
            sliceRecord.executeResult.childUnitIds,
            sliceRecord.plan.split.map((s) => s.slug),
          ),
        },
      },
      deps,
    );
    dispatch(
      { action: "closeout", unitId: childId, input: { artifacts: [] } },
      deps,
    );
  }

  return childUnitIds;
}

/**
 * 推进 feature 到可 retrospect 的完整场景（executing + 所有 child slice closed）。
 *
 * 流程：setupToFeatureExecuting → advanceChildSlicesToClosed。
 * 返回 feature unit id（所有 child slice 已 closed，可过 retrospect allWavesClosed gate）。
 *
 * @param deps stub V1Deps
 * @param slug feature slug
 */
export function setupFeatureWithClosedSlices(deps: V1Deps, slug = "test-feature"): string {
  const featureId = setupToFeatureExecuting(deps, slug);
  advanceChildSlicesToClosed(deps, featureId);
  return featureId;
}

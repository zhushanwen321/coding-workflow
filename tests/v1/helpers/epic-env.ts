/**
 * epic 测试基建 — epic unit 工厂 + 合法 EpicSplit/Plan/Judgment/RetrospectData 产物工厂
 * + 阶段推进 helper。
 *
 * 复用 v1-env.ts 的 createCwEnv / makeStubDeps（隔离环境 + stub CwDeps）。
 * 复用 feature-env.ts 的 setupFeatureWithClosedSlices（epic 的 child 是 feature，推进 child feature
 * 走完整 feature 7 步到 closed 复用 feature 的 setup）。
 * 复用 slice-env.ts 的 advanceWaveToClosed（feature 推进 child slice 时复用）。
 *
 * 本文件只加 epic 专属：
 * - makeEpicUnit / makeValidEpicSplit / makeValidEpicPlan / makeValidEpicLayerSpecific /
 *   makeValidEpicDesignReviewJudgment / makeValidEpicRetrospectData
 * - 阶段推进 helper：setupToEpicClarified / setupToEpicPlanning / setupToEpicDesignReviewed /
 *   setupToEpicExecuting / advanceChildFeaturesToClosed / setupEpicWithClosedFeatures
 *
 * 零 mock 框架：真实 CwStore + tmp 目录（同 v1-env.ts 约定）。
 */
import type {
  Clarification,
} from "../../../src/core/clarifications.js";
import type {
  DesignReviewJudgment,
  EpicDesignReviewLayerSpecific,
  PlanningRetrospectData,
} from "../../../src/core/judgments.js";
import type { Split } from "../../../src/core/plan.js";
import type { Epic } from "../../../src/core/workunit.js";
import { createEpic } from "../../../src/core/workunit.js";
import { dispatch } from "../../../src/dispatch.js";
import type { CwDeps } from "../../../src/handlers/types.js";
import {
  createCwEnv,
  makeFeatureClarifyInput,
  makeStubDeps,
  makeValidClarification,
  makeValidFeatureDesignReviewJudgment,
  makeValidFeaturePlan,
  makeValidFeatureRetrospectData,
  STUB_NOW,
} from "./feature-env.js";
import {
  advanceWaveToClosed,
  makeValidPlanningRetrospectData,
  makeValidSliceDesignReviewJudgment,
  makeValidSlicePlan,
} from "./slice-env.js";

export {
  createCwEnv,
  makeStubDeps,
  makeValidClarification,
  STUB_NOW,
};

// ═══════════════════════════════════════════════════════════════
// epic unit 工厂
// ═══════════════════════════════════════════════════════════════

/**
 * 构造一个 epic unit（初始 status=created，空 clarifications 数组 + 空 plan）。
 *
 * 注意：epic 是顶层无父层，createEpic 忽略 parentUnitId/basedOnParent（即使传也忽略），
 * 故本工厂不传这些参数。
 */
export function makeEpicUnit(slug = "test-epic"): Epic {
  return createEpic({
    slug,
    objective: `objective for ${slug}`,
    createdAt: STUB_NOW,
  });
}

// ═══════════════════════════════════════════════════════════════
// 合法 epic Split / Plan 工厂（构造能过 design-review 的 split 结构 gate）
// ═══════════════════════════════════════════════════════════════

/**
 * 合法的 epic Split（slug + description + dependsOn + inheritedItemIds）。
 *
 * inheritedItemIds 引用 epic Clarification id（execute 时写入 child feature 的 basedOnParent，
 * replan 影响面计算的基础）。
 */
export function makeValidEpicSplit(slug = "f1"): Split {
  return {
    slug,
    description: `feature ${slug} 实现`,
    dependsOn: [],
    inheritedItemIds: ["Q1"],
  };
}

/**
 * 合法的 epic plan（Plan 基类，只 split）。
 *
 * 过 epic design-review 的 split 结构 gate（epicSplitNonEmpty + epicSplitDagValid）。
 * 含 1 split（slug=f1，无依赖）。
 */
export function makeValidEpicPlan(): { split: Split[] } {
  return {
    split: [makeValidEpicSplit("f1")],
  };
}

// ═══════════════════════════════════════════════════════════════
// 合法 layerSpecific / judgment / retrospectData 工厂
// ═══════════════════════════════════════════════════════════════

/**
 * 合法的 EpicDesignReviewLayerSpecific（5 字段全非空）。
 *
 * 注意：DesignReviewJudgment.layerSpecific 基类类型是 WaveDesignReviewLayerSpecific
 *（已知坑4，与 slice/feature 同）。返回为 epic 子类型，调用方写入 judgment 时需
 * `as unknown as DesignReviewJudgment["layerSpecific"]`（与 slice/feature 工厂做法一致）。
 */
export function makeValidEpicLayerSpecific(): EpicDesignReviewLayerSpecific {
  return {
    strategicAlignment: "对齐 2026 Q3 登录体系升级，支撑 SSO 落地",
    featureSplitRationale: "拆 1 个 feature 兑现核心登录，边界清晰无重叠",
    scopeBoundary: "epic 不覆盖支付与通知，仅认证授权链路",
    priorityRationale: "f1 无前置依赖，可立即启动",
    resourceEstimate: "约 2 人周，单 feature 可控",
  };
}

/**
 * 合法的 DesignReviewJudgment（epic 版，过 5 个 judgment gate + epicLayerSpecificNonEmpty）。
 *
 * 与 slice/feature 的 judgment 工厂同构（necessity/sufficiency/alternatives/tradeoffs/risks 都填），
 * layerSpecific 用 epic 专属 5 字段（makeValidEpicLayerSpecific）。
 * 含 TF1/RK1 便于 retrospect 覆盖引用。
 */
export function makeValidEpicDesignReviewJudgment(): DesignReviewJudgment {
  return {
    necessity: "this epic delivers the login system with oauth support",
    sufficiency: {
      gaps: [],
      overlaps: [],
      meceNote: "MECE: oauth feature covers full login, no overlap",
    },
    alternatives: "considered session-based epic, rejected for stateless",
    tradeoffs: [
      { id: "TF1", decision: "oauth over session", reason: "stateless", cost: "revocation harder" },
    ],
    risks: [
      { id: "RK1", item: "provider downtime", severity: "medium", mitigation: "fallback cache" },
    ],
    layerSpecific: makeValidEpicLayerSpecific() as unknown as DesignReviewJudgment["layerSpecific"],
  };
}

/**
 * 合法的 PlanningRetrospectData（epic 版，过 epic retrospect 6 gate）。
 *
 * reviewedItems 覆盖 necessity/sufficiency/alternatives/TF1/RK1（对应 makeValidEpicDesignReviewJudgment）。
 * splitFulfillment 覆盖 makeValidEpicPlan 的 split slug "f1"。
 * childUnitIdsEvidence 默认指向 child feature（feature:test-epic::f1）。
 *
 * 可选参数（advance helper 推进完 child feature 后从 store 读真实 id/slug 传入）：
 * - childUnitIds：传则按真实 childUnitIds 构造 childUnitIdsEvidence；不传用默认 "feature:test-epic::f1"
 * - splitSlugs：传则按真实 plan.split slug 构造 splitFulfillment；不传用默认 "f1"
 */
export function makeValidEpicRetrospectData(
  childUnitIds?: string[],
  splitSlugs?: string[],
): PlanningRetrospectData {
  const ids = childUnitIds ?? ["feature:test-epic::f1"];
  const slugs = splitSlugs ?? ["f1"];
  return {
    reviewedItems: [
      { itemId: "necessity", outcome: "fulfilled" },
      { itemId: "sufficiency", outcome: "fulfilled" },
      { itemId: "alternatives", outcome: "fulfilled" },
      { itemId: "TF1", outcome: "fulfilled" },
      { itemId: "RK1", outcome: "fulfilled", note: "provider fallback added" },
    ],
    lessonsLearned: "epic split gave features clear contract, minimal rework",
    deliveryVerdict: "delivered",
    childUnitIdsEvidence: ids.map((id) => ({ childId: id, status: "closed" as const })),
    splitFulfillment: slugs.map((slug) => ({ splitSlug: slug, verdict: "delivered" as const })),
  };
}

/**
 * 从 store 读 epic 的真实 childUnitIds + plan.split slugs，构造过全部 gate 的 epic PlanningRetrospectData。
 *
 * e2e / state-machine 测试做 epic retrospect 前用这个，避免 childUnitIdsEvidence
 * 与动态生成的 child feature id 不匹配导致 childUnitEvidenceComplete gate fail。
 */
export function makeEpicRetrospectDataFromStore(
  deps: CwDeps,
  unitId: string,
): PlanningRetrospectData {
  const record = deps.store.load(unitId) as unknown as {
    executeResult: { childUnitIds: string[] };
    plan: { split: { slug: string }[] };
  };
  return makeValidEpicRetrospectData(
    record.executeResult.childUnitIds,
    record.plan.split.map((s) => s.slug),
  );
}

// ═══════════════════════════════════════════════════════════════
// 阶段推进 helper（通过 dispatch 推进到各状态，e2e/gates/retrospect 测试复用）
// ═══════════════════════════════════════════════════════════════

/** dispatch 参数类型（execute 无 input，handler 忽略）。 */
type DispatchParams = Parameters<typeof dispatch>[0];

/** epic execute 的 dispatch 参数（无 input，handler 忽略）。 */
function epicExecute(unitId: string): DispatchParams {
  return { action: "execute", unitId, input: {} } as unknown as DispatchParams;
}

/**
 * 推进 epic 到 clarifying 状态（create → clarify）。
 *
 * epic clarify 用通用 ClarifyInput（数组形态），走数组 push 累积（非 feature 的容器覆盖）。
 * 返回 epic unit id。
 *
 * @param deps stub CwDeps（store 注入）
 * @param slug epic slug（默认 test-epic）
 */
export function setupToEpicClarified(deps: CwDeps, slug = "test-epic"): string {
  const unitId = `epic:${slug}`;
  dispatch(
    { action: "create", input: { slug, objective: `obj ${slug}`, layer: "epic" } },
    deps,
  );
  dispatch(
    {
      action: "clarify",
      unitId,
      input: { clarifications: [makeValidClarification()] },
    },
    deps,
  );
  return unitId;
}

/**
 * 推进 epic 到 planning 状态（+ plan）。
 * 返回 epic unit id（status=planning，plan.split 已写入）。
 */
export function setupToEpicPlanning(deps: CwDeps, slug = "test-epic"): string {
  const unitId = setupToEpicClarified(deps, slug);
  dispatch(
    { action: "plan", unitId, input: makeValidEpicPlan() },
    deps,
  );
  return unitId;
}

/**
 * 推进 epic 到 design-reviewed 状态（+ design-review 过 gate）。
 * 返回 epic unit id（status=design-reviewed，可直接 execute）。
 */
export function setupToEpicDesignReviewed(deps: CwDeps, slug = "test-epic"): string {
  const unitId = setupToEpicPlanning(deps, slug);
  dispatch(
    {
      action: "design-review",
      unitId,
      input: { designReviewJudgment: makeValidEpicDesignReviewJudgment() },
    },
    deps,
  );
  return unitId;
}

/**
 * 推进 epic 到 executing 状态（+ execute 创建 child feature）。
 * 返回 epic unit id（status=executing，child feature 已创建）。
 */
export function setupToEpicExecuting(deps: CwDeps, slug = "test-epic"): string {
  const unitId = setupToEpicDesignReviewed(deps, slug);
  dispatch(epicExecute(unitId), deps);
  return unitId;
}

/** feature execute 的 dispatch 参数（无 input，handler 忽略）。 */
function featureExecute(unitId: string): DispatchParams {
  return { action: "execute", unitId, input: {} } as unknown as DispatchParams;
}

/**
 * 推进 epic 的所有 child feature 到 closed（走完 feature 7 步）。
 *
 * epic execute 按 plan.split 创建 child feature（status=created，slug=`epicSlug::splitSlug`，
 * parentUnitId=epicId）。这里对每个已存在的 child feature 直接 dispatch 走完整生命周期
 *（clarify→plan→design-review→execute→[推进其 child slice closed]→retrospect→closeout）
 * 到 closed，使 epic 的 retrospect allWavesClosed gate 可通过。
 *
 * 注意：不重新 create child feature（epic execute 已创建且写入了 parentUnitId=epicId，
 * 重新 create 会覆盖 parentUnitId 导致 epic retrospect 的 findChildren 找不到）。
 * child feature 的 child slice 推进复用 feature-env.advanceChildSlicesToClosed 的逻辑（内联，
 * 避免循环依赖——feature-env 的 advanceChildSlicesToClosed 也是 dispatch 流程）。
 *
 * @param deps stub CwDeps
 * @param epicId epic unit id
 * @returns child feature id 列表
 */
export function advanceChildFeaturesToClosed(deps: CwDeps, epicId: string): string[] {
  const record = deps.store.load(epicId);
  if (!record) throw new Error(`epic not found: ${epicId}`);
  const childUnitIds = (record as unknown as {
    executeResult: { childUnitIds: string[] };
  }).executeResult.childUnitIds;

  for (const childId of childUnitIds) {
    // child feature 走完整生命周期到 closed（直接 dispatch，不重新 create）
    dispatch(
      { action: "clarify", unitId: childId, input: makeFeatureClarifyInput() },
      deps,
    );
    dispatch(
      { action: "plan", unitId: childId, input: makeValidFeaturePlan() },
      deps,
    );
    dispatch(
      {
        action: "design-review",
        unitId: childId,
        input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() },
      },
      deps,
    );
    dispatch(featureExecute(childId), deps);

    // 推进 child feature 的 child slice 到 closed（内联 feature-env.advanceChildSlicesToClosed 逻辑）
    const featureRecord = deps.store.load(childId) as unknown as {
      executeResult: { childUnitIds: string[] };
      plan: { split: { slug: string }[] };
    };
    for (const sliceId of featureRecord.executeResult.childUnitIds) {
      advanceFeatureChildSliceToClosed(deps, sliceId);
    }

    dispatch(
      {
        action: "retrospect",
        unitId: childId,
        input: {
          retrospectData: makeValidFeatureRetrospectData(
            featureRecord.executeResult.childUnitIds,
            featureRecord.plan.split.map((s) => s.slug),
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
 * 推进 epic 到可 retrospect 的完整场景（executing + 所有 child feature closed）。
 *
 * 流程：setupToEpicExecuting → advanceChildFeaturesToClosed。
 * 返回 epic unit id（所有 child feature 已 closed，可过 retrospect allWavesClosed gate）。
 *
 * @param deps stub CwDeps
 * @param slug epic slug
 */
export function setupEpicWithClosedFeatures(deps: CwDeps, slug = "test-epic"): string {
  const epicId = setupToEpicExecuting(deps, slug);
  advanceChildFeaturesToClosed(deps, epicId);
  return epicId;
}

/** 用于类型断言的 re-export（部分测试需要引用 Clarification 类型）。 */
export type { Clarification };

// ═══════════════════════════════════════════════════════════════
// 内部辅助：推进 child feature 的 child slice 到 closed
// ═══════════════════════════════════════════════════════════════

/**
 * 推进 feature 的一个 child slice 到 closed（走完 slice 7 步）。
 *
 * 内联 feature-env.advanceChildSlicesToClosed 的单 slice 推进逻辑（避免循环依赖）。
 * slice 的 child wave 推进复用 slice-env.advanceWaveToClosed。
 */
function advanceFeatureChildSliceToClosed(deps: CwDeps, sliceId: string): void {
  dispatch(
    { action: "clarify", unitId: sliceId, input: { clarifications: [] } },
    deps,
  );
  dispatch(
    { action: "plan", unitId: sliceId, input: makeValidSlicePlan() },
    deps,
  );
  dispatch(
    {
      action: "design-review",
      unitId: sliceId,
      input: { designReviewJudgment: makeValidSliceDesignReviewJudgment() },
    },
    deps,
  );
  dispatch(
    { action: "execute", unitId: sliceId, input: {} } as unknown as DispatchParams,
    deps,
  );
  // 推进 child slice 的 child wave 到 closed
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
        retrospectData: makeValidPlanningRetrospectData(
          sliceRecord.executeResult.childUnitIds,
          sliceRecord.plan.split.map((s) => s.slug),
        ),
      },
    },
    deps,
  );
  dispatch(
    { action: "closeout", unitId: sliceId, input: { artifacts: [] } },
    deps,
  );
}

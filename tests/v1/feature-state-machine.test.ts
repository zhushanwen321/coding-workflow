/**
 * v1 feature（PlanningUnit）状态机测试。
 *
 * feature 复用 slice 的 PLANNING_TRANSITIONS（同型状态机，7 步流程），但通过 dispatch
 * 实际推进来验 feature 专属路径：
 * - clarify 写入 FeatureClarification 容器对象（非数组追加，整体覆盖）
 * - plan 写入 Plan 基类（只 split，无技术方案）
 * - design-review 跑 feature 11 个 gate（FR-AC 强引用 3 + split 结构 2 + judgment 5 + layerSpecific 1）
 * - execute 创建 child slice（scope=slice，targetLayer='slice'）
 * - retrospect 查 child slice 状态
 * - closeout 写 frozenAt
 *
 * progressive 语义（同 status 可重提）+ 非法转换抛 illegal_transition。
 *
 * 真实 store + stub V1Deps。零 mock 框架。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Feature } from "../../src/v1/core/workunit.js";
import { dispatch, V1Error } from "../../src/v1/dispatch.js";
import {
  createV1Env,
  makeFeatureClarifyInput,
  makeValidFeatureDesignReviewJudgment,
  makeValidFeaturePlan,
  makeValidFeatureRetrospectData,
  setupFeatureWithClosedSlices,
  setupToFeatureClarified,
  setupToFeatureDesignReviewed,
  setupToFeatureExecuting,
  setupToFeaturePlanning,
  STUB_NOW,
} from "./helpers/feature-env.js";
import type { V1Env } from "./helpers/v1-env.js";

let env: V1Env;

beforeEach(() => {
  env = createV1Env();
});

afterEach(() => {
  env.cleanup();
});

/** 从 store 读最新 feature。 */
function loadFeature(id: string): Feature {
  const r = env.store.load(id);
  return r as unknown as Feature;
}

/** feature execute 的 dispatch 参数（无 input，handler 忽略）。 */
function featureExecute(unitId: string): Parameters<typeof dispatch>[0] {
  return { action: "execute", unitId, input: {} } as unknown as Parameters<typeof dispatch>[0];
}

// ═══════════════════════════════════════════════════════════════
// 主链 7 步流转（dispatch 实际推进）
// ═══════════════════════════════════════════════════════════════

describe("feature 主链 7 步状态流转（create→closeout）", () => {
  it("create → created，nextAction=clarify", () => {
    const result = dispatch(
      { action: "create", input: { slug: "sm-create", objective: "o", layer: "feature" } },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("created");
    expect(result.nextAction?.action).toBe("clarify");
    expect(result.nextAction?.unitPath.layer).toBe("feature");

    const unit = loadFeature("feature:sm-create");
    expect(unit.scope).toBe("feature");
    expect(unit.statusHistory.at(-1)?.action).toBe("create");
    // 初始 clarifications 是空容器对象
    expect(unit.clarifications.clarifications).toEqual([]);
    expect(unit.clarifications.spec.functionalRequirements).toEqual([]);
    expect(unit.plan.split).toEqual([]);
  });

  it("clarify → clarifying，FeatureClarification 容器对象整体覆盖写入", () => {
    const unitId = "feature:sm-clarify";
    dispatch(
      { action: "create", input: { slug: "sm-clarify", objective: "o", layer: "feature" } },
      env.deps,
    );

    const result = dispatch(
      { action: "clarify", unitId, input: makeFeatureClarifyInput() },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("clarifying");
    expect(result.nextAction?.action).toBe("plan");

    const unit = loadFeature(unitId);
    // 容器对象写入（非数组追加）
    expect(unit.clarifications.clarifications).toHaveLength(1);
    expect(unit.clarifications.spec.functionalRequirements).toHaveLength(1);
    expect(unit.clarifications.spec.acceptanceCriteria).toHaveLength(1);
  });

  it("plan → planning，Plan 基类（只 split）写入", () => {
    const unitId = setupToFeatureClarified(env.deps, "sm-plan");
    const result = dispatch(
      { action: "plan", unitId, input: makeValidFeaturePlan() },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("planning");
    expect(result.nextAction?.action).toBe("design-review");

    const unit = loadFeature(unitId);
    expect(unit.plan.split).toHaveLength(1);
    expect(unit.plan.split[0]?.slug).toBe("s1");
    // feature plan 无技术方案字段（Plan 基类）
    expect("techChoices" in unit.plan).toBe(false);
  });

  it("design-review → design-reviewed（gate 全过）", () => {
    const unitId = setupToFeaturePlanning(env.deps, "sm-dr");
    const result = dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() },
      },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("design-reviewed");
    expect(result.nextAction?.action).toBe("execute");

    const unit = loadFeature(unitId);
    expect(unit.designReviewJudgment.necessity).toBeTruthy();
  });

  it("execute → executing（创建 child slice，targetLayer=slice）", () => {
    const unitId = setupToFeatureDesignReviewed(env.deps, "sm-exec");
    const result = dispatch(featureExecute(unitId), env.deps);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("executing");
    // execute 后 nextAction.action=undefined（下沉），crossLayer.descend 指向 child slice
    expect(result.nextAction?.action).toBeUndefined();
    expect(result.nextAction?.crossLayer?.kind).toBe("descend");
    expect(result.nextAction?.crossLayer?.targetLayer).toBe("slice");

    const unit = loadFeature(unitId);
    expect(unit.executeResult.childUnitIds.length).toBeGreaterThan(0);
    // child 是 slice
    const childId = unit.executeResult.childUnitIds[0]!;
    const child = env.store.load(childId) as unknown as { scope: string };
    expect(child.scope).toBe("slice");
    // childDelivery 初始快照 childStatus=pending
    expect(unit.evidence.childDelivery.every((r) => r.childStatus === "pending")).toBe(true);
  });

  it("retrospect → retrospected（child slice 全 closed）", () => {
    const unitId = setupFeatureWithClosedSlices(env.deps, "sm-retro");
    const result = dispatch(
      {
        action: "retrospect",
        unitId,
        input: { retrospectData: makeValidFeatureRetrospectData() },
      },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("retrospected");
    expect(result.nextAction?.action).toBe("closeout");
  });

  it("closeout → closed（frozenAt 写入）", () => {
    const unitId = setupFeatureWithClosedSlices(env.deps, "sm-close");
    dispatch(
      {
        action: "retrospect",
        unitId,
        input: { retrospectData: makeValidFeatureRetrospectData() },
      },
      env.deps,
    );
    const result = dispatch(
      { action: "closeout", unitId, input: { artifacts: [] } },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("closed");

    const unit = loadFeature(unitId);
    expect(unit.evidence.frozenAt).toBe(STUB_NOW);
    // 完整 statusHistory 序列
    expect(unit.statusHistory.map((h) => h.action)).toEqual([
      "create", "clarify", "plan", "design-review", "execute", "retrospect", "closeout",
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// progressive 语义（同 status 可重提）
// ═══════════════════════════════════════════════════════════════

describe("feature progressive 语义", () => {
  it("clarifying 再次 clarify → 仍 clarifying（容器对象覆盖）", () => {
    const unitId = setupToFeatureClarified(env.deps, "sm-prog-clarify");
    const before = loadFeature(unitId);
    expect(before.status).toBe("clarifying");

    const result = dispatch(
      { action: "clarify", unitId, input: makeFeatureClarifyInput() },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("clarifying");
  });

  it("planning 再次 plan → 仍 planning", () => {
    const unitId = setupToFeaturePlanning(env.deps, "sm-prog-plan");
    const result = dispatch(
      { action: "plan", unitId, input: makeValidFeaturePlan() },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("planning");
  });

  it("design-reviewed 再次 design-review → 仍 design-reviewed", () => {
    const unitId = setupToFeatureDesignReviewed(env.deps, "sm-prog-dr");
    const result = dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() },
      },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("design-reviewed");
  });
});

// ═══════════════════════════════════════════════════════════════
// 非法转换 → illegal_transition
// ═══════════════════════════════════════════════════════════════

describe("feature 非法转换抛 illegal_transition", () => {
  it("created 直接 execute → throw V1Error(illegal_transition)", () => {
    const unitId = "feature:sm-illegal-exec";
    dispatch(
      { action: "create", input: { slug: "sm-illegal-exec", objective: "o", layer: "feature" } },
      env.deps,
    );
    expect(() => dispatch(featureExecute(unitId), env.deps)).toThrow(V1Error);
    try {
      dispatch(featureExecute(unitId), env.deps);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as V1Error).code).toBe("illegal_transition");
    }
  });

  it("planning 直接 closeout → throw V1Error(illegal_transition)", () => {
    const unitId = setupToFeaturePlanning(env.deps, "sm-illegal-close");
    expect(() =>
      dispatch({ action: "closeout", unitId, input: { artifacts: [] } }, env.deps),
    ).toThrow(V1Error);
  });

  it("design-reviewed 直接 retrospect（未 execute）→ throw V1Error", () => {
    const unitId = setupToFeatureDesignReviewed(env.deps, "sm-illegal-retro");
    expect(() =>
      dispatch(
        { action: "retrospect", unitId, input: { retrospectData: makeValidFeatureRetrospectData() } },
        env.deps,
      ),
    ).toThrow(V1Error);
  });

  it("closed 后任何 action → throw V1Error（终态不可逆）", () => {
    const unitId = setupFeatureWithClosedSlices(env.deps, "sm-terminal");
    dispatch(
      { action: "retrospect", unitId, input: { retrospectData: makeValidFeatureRetrospectData() } },
      env.deps,
    );
    dispatch({ action: "closeout", unitId, input: { artifacts: [] } }, env.deps);
    expect(loadFeature(unitId).status).toBe("closed");

    expect(() => dispatch(featureExecute(unitId), env.deps)).toThrow(V1Error);
  });

  it("feature unit not found → throw V1Error(unit_not_found)", () => {
    expect(() =>
      dispatch(
        { action: "clarify", unitId: "feature:ghost", input: makeFeatureClarifyInput() },
        env.deps,
      ),
    ).toThrow(V1Error);
    try {
      dispatch(
        { action: "clarify", unitId: "feature:ghost", input: makeFeatureClarifyInput() },
        env.deps,
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as V1Error).code).toBe("unit_not_found");
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 派生字段：execute 后 child slice 的 basedOnParent 来自 split.inheritedItemIds
// ═══════════════════════════════════════════════════════════════

describe("feature execute child slice 基于配置", () => {
  it("child slice slug = featureSlug::splitSlug，basedOnParent = split.inheritedItemIds", () => {
    const unitId = setupToFeatureExecuting(env.deps, "sm-child");
    const unit = loadFeature(unitId);
    const childId = unit.executeResult.childUnitIds[0]!;
    // slug 格式 featureSlug::splitSlug
    expect(childId).toBe("slice:sm-child::s1");
    const child = env.store.load(childId) as unknown as {
      basedOnParent: string[];
      parentUnitId: string;
      objective: string;
    };
    expect(child.basedOnParent).toEqual(["FR1", "AC1"]);
    expect(child.parentUnitId).toBe(unitId);
    // objective = split.description
    expect(child.objective).toBe(unit.plan.split[0]?.description);
  });
});

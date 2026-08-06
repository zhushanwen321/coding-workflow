/**
 * v1 feature dispatch e2e 测试。
 *
 * 通过 dispatch 统一入口跑完整 feature 生命周期（create→design→design-review→
 * execute→[推进 child slice closed]→retrospect→closeout），验证编排层正确串联 feature handler。
 *
 * 另测：
 * - create 按 input.layer=feature 路由（→ handleCreateFeature，scope=feature）
 * - dispatch 拒绝 feature 的 test/exec-review → throw CwEngineError(illegal_transition)
 * - gate fail 短路（构造 fail 的 spec/judgment，design-review 返回 ok=false 不流转）
 * - execute 创建的 child 是 slice（scope=slice，basedOnParent=split.inheritedItemIds）
 * - childDelivery 初始快照（childStatus=pending）
 *
 * 真实 store + stub CwDeps（外部依赖注入接口）。零 mock 框架。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Feature } from "../src/core/workunit.js";
import { CwEngineError,dispatch } from "../src/dispatch.js";
import type { CwEnv } from "./helpers/env.js";
import {
  advanceChildSlicesToClosed,
  createCwEnv,
  makeFeatureDesignInput,
  makeFeatureRetrospectDataFromStore,
  makeFeatureSpec,
  makeValidFeatureDesignReviewJudgment,
  setupFeatureWithClosedSlices,
  setupToFeatureDesigning,
  STUB_NOW,
} from "./helpers/feature-env.js";

let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
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
// dispatch 完整 feature 生命周期
// ═══════════════════════════════════════════════════════════════

describe("dispatch 完整 feature 生命周期", () => {
  it("create→design→design-review→execute→[child slice closed]→retrospect→closeout → closed", () => {
    const unitId = "feature:e2e-happy";

    // 1. create（layer='feature'）
    const created = dispatch(
      {
        action: "create",
        input: { slug: "e2e-happy", objective: "deliver oauth feature", layer: "feature" },
      },
      env.deps,
    );
    expect(created.ok).toBe(true);
    expect(created.status).toBe("created");
    // create 返回的 unit 是 feature
    expect((created as { unit?: { scope: string } }).unit?.scope).toBe("feature");

    // 2. design（合并原 clarify+plan：spec 覆盖写 + clarifications append + 写 split）
    const design = dispatch(
      { action: "design", unitId, input: makeFeatureDesignInput() },
      env.deps,
    );
    expect(design.ok).toBe(true);
    expect(design.status).toBe("designing");
    expect(loadFeature(unitId).clarifications.spec.functionalRequirements).toHaveLength(1);
    expect(loadFeature(unitId).plan.split).toHaveLength(1);

    // 4. design-review（16 个 gate 全过）
    const dr = dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() },
      },
      env.deps,
    );
    expect(dr.ok).toBe(true);
    expect(dr.status).toBe("design-reviewed");
    expect(dr.gateResults).toHaveLength(16);

    // 5. execute（创建 child slice）
    const execute = dispatch(featureExecute(unitId), env.deps);
    expect(execute.ok).toBe(true);
    expect(execute.status).toBe("executing");

    const executingFeature = loadFeature(unitId);
    expect(executingFeature.executeResult.childUnitIds.length).toBeGreaterThan(0);
    // child 是 slice（scope=slice）
    const childId = executingFeature.executeResult.childUnitIds[0]!;
    const child = env.store.load(childId) as unknown as {
      scope: string;
      basedOnParent: string[];
      parentUnitId: string;
    };
    expect(child.scope).toBe("slice");
    expect(child.basedOnParent).toEqual(["FR1", "AC1"]);
    expect(child.parentUnitId).toBe(unitId);
    // childDelivery 初始全 pending
    expect(executingFeature.evidence.childDelivery.length).toBeGreaterThan(0);
    expect(executingFeature.evidence.childDelivery.every((r) => r.childStatus === "pending")).toBe(true);
    // crossLayer.descend 指向第一个 child slice
    expect(execute.nextAction?.crossLayer?.kind).toBe("descend");
    expect(execute.nextAction?.crossLayer?.targetLayer).toBe("slice");
    expect(execute.nextAction?.crossLayer?.targetUnitId).toBe(childId);

    // 6. 推进 child slice 到 closed
    advanceChildSlicesToClosed(env.deps, unitId);

    // 7. retrospect（allWavesClosed 从 findChildren 读 child slice 实时 status，全 closed → pass）
    const retrospect = dispatch(
      {
        action: "retrospect",
        unitId,
        input: { retrospectData: makeFeatureRetrospectDataFromStore(env.deps, unitId) },
      },
      env.deps,
    );
    expect(retrospect.ok).toBe(true);
    expect(retrospect.status).toBe("retrospected");

    // 8. closeout（drift 检查 pass）
    const closeout = dispatch(
      { action: "closeout", unitId, input: { artifacts: [] } },
      env.deps,
    );
    expect(closeout.ok).toBe(true);
    expect(closeout.status).toBe("closed");

    // 最终断言：status=closed + frozenAt 写入 + 完整 statusHistory
    const finalFeature = loadFeature(unitId);
    expect(finalFeature.status).toBe("closed");
    expect(finalFeature.evidence.frozenAt).toBe(STUB_NOW);
    expect(finalFeature.statusHistory.map((h) => h.action)).toEqual([
      "create", "design", "design-review", "execute", "retrospect", "closeout",
    ]);
  });

  it("feature 有 parentUnitId → closeout 后 crossLayer.ascend 指向 parent", () => {
    const unitId = "feature:e2e-ascend";
    dispatch(
      {
        action: "create",
        input: {
          slug: "e2e-ascend",
          objective: "o",
          layer: "feature",
          parentUnitId: "epic:parent",
        },
      },
      env.deps,
    );
    dispatch({ action: "design", unitId, input: makeFeatureDesignInput() }, env.deps);
    dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() } },
      env.deps,
    );
    dispatch(featureExecute(unitId), env.deps);
    advanceChildSlicesToClosed(env.deps, unitId);
    dispatch(
      { action: "retrospect", unitId, input: { retrospectData: makeFeatureRetrospectDataFromStore(env.deps, unitId) } },
      env.deps,
    );
    const closeout = dispatch({ action: "closeout", unitId, input: { artifacts: [] } }, env.deps);

    expect(closeout.ok).toBe(true);
    expect(closeout.nextAction?.crossLayer).toBeDefined();
    expect(closeout.nextAction!.crossLayer!.kind).toBe("ascend");
    expect(closeout.nextAction!.crossLayer!.targetUnitId).toBe("epic:parent");
  });
});

// ═══════════════════════════════════════════════════════════════
// create 按 input.layer 路由
// ═══════════════════════════════════════════════════════════════

describe("dispatch create 按 input.layer 路由", () => {
  it("layer=feature → handleCreateFeature，scope=feature", () => {
    const result = dispatch(
      { action: "create", input: { slug: "route-feature", objective: "o", layer: "feature" } },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.unitId).toBe("feature:route-feature");
    expect((result as { unit?: { scope: string } }).unit?.scope).toBe("feature");
  });

  it("layer=slice → handleCreateSlice（feature 不误触）", () => {
    const result = dispatch(
      { action: "create", input: { slug: "route-slice", objective: "o", layer: "slice" } },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.unitId).toBe("slice:route-slice");
    expect((result as { unit?: { scope: string } }).unit?.scope).toBe("slice");
  });

  it("layer 省略 → 默认 wave（feature 不误触）", () => {
    const result = dispatch(
      { action: "create", input: { slug: "route-wave", objective: "o" } },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.unitId).toBe("wave:route-wave");
    expect((result as { unit?: { scope: string } }).unit?.scope).toBe("wave");
  });
});

// ═══════════════════════════════════════════════════════════════
// dispatch 拒绝 feature 的 test/exec-review
// ═══════════════════════════════════════════════════════════════

describe("dispatch 拒绝 feature 的 test/exec-review", () => {
  it("feature dispatch test → throw CwEngineError(illegal_transition)", () => {
    const unitId = "feature:e2e-no-test";
    dispatch(
      { action: "create", input: { slug: "e2e-no-test", objective: "o", layer: "feature" } },
      env.deps,
    );

    expect(() =>
      dispatch(
        {
          action: "test",
          unitId,
          input: {
            testJudgment: {
              necessityMet: "x",
              sufficiencyMet: { gapsConfirmed: [], gapsNewlyFound: [], overlapsConfirmed: [] },
              alternativesReconsidered: "",
              tradeoffCostRealized: [],
              riskOutcome: [],
            },
          },
        },
        env.deps,
      ),
    ).toThrow(CwEngineError);

    try {
      dispatch(
        {
          action: "test",
          unitId,
          input: {
            testJudgment: {
              necessityMet: "x",
              sufficiencyMet: { gapsConfirmed: [], gapsNewlyFound: [], overlapsConfirmed: [] },
              alternativesReconsidered: "",
              tradeoffCostRealized: [],
              riskOutcome: [],
            },
          },
        },
        env.deps,
      );
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as CwEngineError;
      expect(err.code).toBe("illegal_transition");
      expect(err.message).toMatch(/test/);
    }
  });

  it("feature dispatch exec-review → throw CwEngineError(illegal_transition)", () => {
    const unitId = "feature:e2e-no-execreview";
    dispatch(
      { action: "create", input: { slug: "e2e-no-execreview", objective: "o", layer: "feature" } },
      env.deps,
    );

    expect(() =>
      dispatch(
        {
          action: "exec-review",
          unitId,
          input: {
            execReviewJudgment: { readability: { score: 4 }, architecture: { score: 4 }, overallVerdict: "pass" },
          },
        },
        env.deps,
      ),
    ).toThrow(CwEngineError);
  });
});

// ═══════════════════════════════════════════════════════════════
// dispatch gate fail 短路（构造 fail 的 spec/judgment，验 ok=false 不流转）
// ═══════════════════════════════════════════════════════════════

describe("dispatch feature gate fail 短路（design-review 返回 ok=false 不流转）", () => {
  it("spec 空（FR/AC 全空）→ design-review ok=false，status 不变（仍 designing）", () => {
    const unitId = "feature:e2e-gate-spec";
    dispatch(
      { action: "create", input: { slug: "e2e-gate-spec", objective: "o", layer: "feature" } },
      env.deps,
    );
    // design 写入空 spec（FR/AC 都空），触发 acNonEmpty fail
    dispatch(
      {
        action: "design",
        unitId,
        input: makeFeatureDesignInput({ spec: makeFeatureSpec({
          functionalRequirements: [],
          acceptanceCriteria: [],
        }) }),
      },
      env.deps,
    );

    const result = dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() },
      },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.gateResults).toBeDefined();
    expect(result.gateResults!.some((g) => !g.passed)).toBe(true);
    // status 未推进（仍 designing）
    expect(loadFeature(unitId).status).toBe("designing");
  });

  it("judgment layerSpecific undefined → design-review ok=false，含 layer-specific-non-empty fail", () => {
    const unitId = setupToFeatureDesigning(env.deps, "e2e-gate-ls");
    const judgment = makeValidFeatureDesignReviewJudgment();
    judgment.layerSpecific = undefined;

    const result = dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: judgment } },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.gateResults!.some((g) => /layer-specific-non-empty/.test(g.report))).toBe(true);
    expect(loadFeature(unitId).status).toBe("designing");
  });

  it("split 有环 → design-review ok=false，含 split-dag-valid fail", () => {
    const unitId = "feature:e2e-gate-cycle";
    dispatch(
      { action: "create", input: { slug: "e2e-gate-cycle", objective: "o", layer: "feature" } },
      env.deps,
    );
    // design split 有环
    dispatch(
      {
        action: "design",
        unitId,
        input: makeFeatureDesignInput({
          split: [
            { slug: "a", description: "a", dependsOn: ["b"], inheritedItemIds: [] },
            { slug: "b", description: "b", dependsOn: ["a"], inheritedItemIds: [] },
          ],
        }),
      },
      env.deps,
    );

    const result = dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() } },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.gateResults!.some((g) => /split-dag-valid/.test(g.report))).toBe(true);
  });

  it("FR.ac 引用不存在 → design-review ok=false，含 fr-ac-coverage fail", () => {
    const unitId = "feature:e2e-gate-frac";
    dispatch(
      { action: "create", input: { slug: "e2e-gate-frac", objective: "o", layer: "feature" } },
      env.deps,
    );
    dispatch(
      {
        action: "design",
        unitId,
        input: makeFeatureDesignInput({
          spec: makeFeatureSpec({
            functionalRequirements: [
              { id: "FR1", status: "active", title: "t", detail: "d", ac: ["GHOST_AC"] },
            ],
          }),
        }),
      },
      env.deps,
    );

    const result = dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() } },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.gateResults!.some((g) => /fr-ac-coverage/.test(g.report))).toBe(true);
  });

  it("failureCount 累计（连续 fail 派生）", () => {
    const unitId = "feature:e2e-gate-count";
    dispatch(
      { action: "create", input: { slug: "e2e-gate-count", objective: "o", layer: "feature" } },
      env.deps,
    );
    // design 写入空 spec，触发 acNonEmpty fail
    dispatch(
      {
        action: "design",
        unitId,
        input: makeFeatureDesignInput({ spec: makeFeatureSpec({
          functionalRequirements: [],
          acceptanceCriteria: [],
        }) }),
      },
      env.deps,
    );

    const first = dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() } },
      env.deps,
    );
    expect(first.ok).toBe(false);
    expect(first.failureCount).toBe(1);

    // 再次 fail（同 action 连续）
    const second = dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() } },
      env.deps,
    );
    expect(second.ok).toBe(false);
    expect(second.failureCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// dispatch 非法跳步
// ═══════════════════════════════════════════════════════════════

describe("dispatch feature 非法跳步", () => {
  it("feature create 后直接 execute → throw CwEngineError(illegal_transition)", () => {
    const unitId = "feature:e2e-illegal";
    dispatch(
      { action: "create", input: { slug: "e2e-illegal", objective: "o", layer: "feature" } },
      env.deps,
    );
    expect(() => dispatch(featureExecute(unitId), env.deps)).toThrow(CwEngineError);
  });

  it("feature unit not found → throw CwEngineError(unit_not_found)", () => {
    expect(() =>
      dispatch(
        { action: "design", unitId: "feature:ghost", input: makeFeatureDesignInput() },
        env.deps,
      ),
    ).toThrow(CwEngineError);

    try {
      dispatch(
        { action: "design", unitId: "feature:ghost", input: makeFeatureDesignInput() },
        env.deps,
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CwEngineError).code).toBe("unit_not_found");
    }
  });

  it("closed 后任何 action → throw CwEngineError（终态不可逆）", () => {
    const unitId = setupFeatureWithClosedSlices(env.deps, "e2e-terminal");
    dispatch(
      { action: "retrospect", unitId, input: { retrospectData: makeFeatureRetrospectDataFromStore(env.deps, unitId) } },
      env.deps,
    );
    dispatch({ action: "closeout", unitId, input: { artifacts: [] } }, env.deps);
    expect(loadFeature(unitId).status).toBe("closed");

    expect(() => dispatch(featureExecute(unitId), env.deps)).toThrow(CwEngineError);
  });

  it("unsupported scope（未实现的 scope）→ throw CwEngineError(unsupported_scope)", () => {
    // 手动存一个 scope='custom-unknown' 的 record，loadWorkUnit 会抛 unsupported_scope
    //（epic 已实现，改用虚构 scope 验证未知 scope 的防御逻辑）
    env.store.save({
      id: "custom-unknown:fake",
      scope: "custom-unknown",
      slug: "fake",
      status: "created",
      statusHistory: [],
      basedOnParent: [],
      abandonedRefs: [],
      objective: "",
    } as unknown as Parameters<typeof env.store.save>[0]);

    expect(() =>
      dispatch(
        { action: "design", unitId: "custom-unknown:fake", input: makeFeatureDesignInput() },
        env.deps,
      ),
    ).toThrow(CwEngineError);

    try {
      dispatch(
        { action: "design", unitId: "custom-unknown:fake", input: makeFeatureDesignInput() },
        env.deps,
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CwEngineError).code).toBe("unsupported_scope");
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// execute 产物：multi-split 创建多个 child slice
// ═══════════════════════════════════════════════════════════════

describe("dispatch feature execute multi-split", () => {
  it("split 多项 → execute 创建多个 child slice，childDelivery 数量匹配", () => {
    const unitId = "feature:e2e-multi";
    dispatch(
      { action: "create", input: { slug: "e2e-multi", objective: "o", layer: "feature" } },
      env.deps,
    );
    // design 合并原 clarify+plan：合法 spec（过 FR-AC gate）+ 2-split
    dispatch(
      {
        action: "design",
        unitId,
        input: makeFeatureDesignInput({
          split: [
            { slug: "s1", description: "slice 1", dependsOn: [], inheritedItemIds: ["FR1"] },
            { slug: "s2", description: "slice 2", dependsOn: ["s1"], inheritedItemIds: ["AC1"] },
          ],
        }),
      },
      env.deps,
    );
    dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() } },
      env.deps,
    );

    const execute = dispatch(featureExecute(unitId), env.deps);
    expect(execute.ok).toBe(true);

    const feature = loadFeature(unitId);
    expect(feature.executeResult.childUnitIds).toHaveLength(2);
    expect(feature.evidence.childDelivery).toHaveLength(2);
    // 每个 split 对应一条 childDelivery，childStatus=pending
    expect(feature.evidence.childDelivery.every((r) => r.childStatus === "pending")).toBe(true);
    // splitSlug 映射正确
    const slugs = feature.evidence.childDelivery.map((r) => r.splitSlug).sort();
    expect(slugs).toEqual(["s1", "s2"]);
    // generatedAt 首次写入
    expect(feature.evidence.generatedAt).toBe(STUB_NOW);
  });
});

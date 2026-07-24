/**
 * v1 epic dispatch e2e 测试。
 *
 * 通过 dispatch 统一入口跑完整 epic 生命周期（create→clarify→plan→design-review→
 * execute→[推进 child feature closed]→retrospect→closeout），验证编排层正确串联 epic handler。
 *
 * 另测：
 * - create 按 input.layer=epic 路由（→ handleCreateEpic，scope=epic）
 * - dispatch 拒绝 epic 的 test/exec-review → throw V1Error(illegal_transition)
 * - gate fail 短路（构造 fail 的 judgment，design-review 返回 ok=false 不流转）
 * - execute 创建的 child 是 feature（scope=feature，basedOnParent=split.inheritedItemIds，
 *   crossLayer.targetLayer='feature'）
 * - closeout 后 crossLayer undefined（epic 顶层无父，孤立终点——与 feature 的 ascend 对比）
 *
 * 真实 store + stub V1Deps（外部依赖注入接口）。零 mock 框架。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Epic } from "../../src/v1/core/workunit.js";
import { dispatch, V1Error } from "../../src/v1/dispatch.js";
import {
  advanceChildFeaturesToClosed,
  createV1Env,
  makeEpicRetrospectDataFromStore,
  makeValidClarification,
  makeValidEpicDesignReviewJudgment,
  makeValidEpicLayerSpecific,
  makeValidEpicPlan,
  setupEpicWithClosedFeatures,
  setupToEpicPlanning,
  STUB_NOW,
} from "./helpers/epic-env.js";
import type { V1Env } from "./helpers/v1-env.js";

let env: V1Env;

beforeEach(() => {
  env = createV1Env();
});

afterEach(() => {
  env.cleanup();
});

/** 从 store 读最新 epic。 */
function loadEpic(id: string): Epic {
  const r = env.store.load(id);
  return r as unknown as Epic;
}

/** epic execute 的 dispatch 参数（无 input，handler 忽略）。 */
function epicExecute(unitId: string): Parameters<typeof dispatch>[0] {
  return { action: "execute", unitId, input: {} } as unknown as Parameters<typeof dispatch>[0];
}

// ═══════════════════════════════════════════════════════════════
// dispatch 完整 epic 生命周期
// ═══════════════════════════════════════════════════════════════

describe("dispatch 完整 epic 生命周期", () => {
  it("create→clarify→plan→design-review→execute→[child feature closed]→retrospect→closeout → closed", () => {
    const unitId = "epic:e2e-happy";

    // 1. create（layer='epic'）
    const created = dispatch(
      {
        action: "create",
        input: { slug: "e2e-happy", objective: "deliver login epic", layer: "epic" },
      },
      env.deps,
    );
    expect(created.ok).toBe(true);
    expect(created.status).toBe("created");
    // create 返回的 unit 是 epic
    expect((created as { unit?: { scope: string } }).unit?.scope).toBe("epic");

    // 2. clarify（Clarification 数组 push）
    const clarify = dispatch(
      {
        action: "clarify",
        unitId,
        input: { clarifications: [makeValidClarification()] },
      },
      env.deps,
    );
    expect(clarify.ok).toBe(true);
    expect(clarify.status).toBe("clarifying");
    expect(loadEpic(unitId).clarifications).toHaveLength(1);

    // 3. plan（Plan 基类，只 split）
    const plan = dispatch(
      { action: "plan", unitId, input: makeValidEpicPlan() },
      env.deps,
    );
    expect(plan.ok).toBe(true);
    expect(plan.status).toBe("planning");
    expect(loadEpic(unitId).plan.split).toHaveLength(1);

    // 4. design-review（10 个 gate 全过）
    const dr = dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidEpicDesignReviewJudgment() },
      },
      env.deps,
    );
    expect(dr.ok).toBe(true);
    expect(dr.status).toBe("design-reviewed");
    expect(dr.gateResults).toHaveLength(10);

    // 5. execute（创建 child feature）
    const execute = dispatch(epicExecute(unitId), env.deps);
    expect(execute.ok).toBe(true);
    expect(execute.status).toBe("executing");

    const executingEpic = loadEpic(unitId);
    expect(executingEpic.executeResult.childUnitIds.length).toBeGreaterThan(0);
    // child 是 feature（scope=feature）
    const childId = executingEpic.executeResult.childUnitIds[0]!;
    expect(childId).toBe("feature:e2e-happy::f1");
    const child = env.store.load(childId) as unknown as {
      scope: string;
      basedOnParent: string[];
      parentUnitId: string;
    };
    expect(child.scope).toBe("feature");
    expect(child.basedOnParent).toEqual(["Q1"]);
    expect(child.parentUnitId).toBe(unitId);
    // childDelivery 初始全 pending
    expect(executingEpic.evidence.childDelivery.length).toBeGreaterThan(0);
    expect(executingEpic.evidence.childDelivery.every((r) => r.childStatus === "pending")).toBe(true);
    // crossLayer.descend 指向第一个 child feature
    expect(execute.nextAction?.crossLayer?.kind).toBe("descend");
    expect(execute.nextAction?.crossLayer?.targetLayer).toBe("feature");
    expect(execute.nextAction?.crossLayer?.targetUnitId).toBe(childId);

    // 6. 推进 child feature 到 closed
    advanceChildFeaturesToClosed(env.deps, unitId);

    // 7. retrospect（allWavesClosed 从 findChildren 读 child feature 实时 status，全 closed → pass）
    const retrospect = dispatch(
      {
        action: "retrospect",
        unitId,
        input: { retrospectData: makeEpicRetrospectDataFromStore(env.deps, unitId) },
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
    const finalEpic = loadEpic(unitId);
    expect(finalEpic.status).toBe("closed");
    expect(finalEpic.evidence.frozenAt).toBe(STUB_NOW);
    expect(finalEpic.statusHistory.map((h) => h.action)).toEqual([
      "create", "clarify", "plan", "design-review", "execute", "retrospect", "closeout",
    ]);
    // epic 顶层无父：closeout 后 crossLayer undefined（孤立终点，与 feature 的 ascend 对比）
    expect(closeout.nextAction?.crossLayer).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// create 按 input.layer 路由
// ═══════════════════════════════════════════════════════════════

describe("dispatch create 按 input.layer 路由", () => {
  it("layer=epic → handleCreateEpic，scope=epic", () => {
    const result = dispatch(
      { action: "create", input: { slug: "route-epic", objective: "o", layer: "epic" } },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.unitId).toBe("epic:route-epic");
    expect((result as { unit?: { scope: string } }).unit?.scope).toBe("epic");
  });

  it("layer=feature → handleCreateFeature（epic 不误触）", () => {
    const result = dispatch(
      { action: "create", input: { slug: "route-feature", objective: "o", layer: "feature" } },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.unitId).toBe("feature:route-feature");
    expect((result as { unit?: { scope: string } }).unit?.scope).toBe("feature");
  });

  it("layer 省略 → 默认 wave（epic 不误触）", () => {
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
// dispatch 拒绝 epic 的 test/exec-review
// ═══════════════════════════════════════════════════════════════

describe("dispatch 拒绝 epic 的 test/exec-review", () => {
  it("epic dispatch test → throw V1Error(illegal_transition)", () => {
    const unitId = "epic:e2e-no-test";
    dispatch(
      { action: "create", input: { slug: "e2e-no-test", objective: "o", layer: "epic" } },
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
    ).toThrow(V1Error);

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
      const err = e as V1Error;
      expect(err.code).toBe("illegal_transition");
      expect(err.message).toMatch(/test/);
    }
  });

  it("epic dispatch exec-review → throw V1Error(illegal_transition)", () => {
    const unitId = "epic:e2e-no-execreview";
    dispatch(
      { action: "create", input: { slug: "e2e-no-execreview", objective: "o", layer: "epic" } },
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
    ).toThrow(V1Error);
  });
});

// ═══════════════════════════════════════════════════════════════
// dispatch gate fail 短路（构造 fail 的 judgment，验 ok=false 不流转）
// ═══════════════════════════════════════════════════════════════

describe("dispatch epic gate fail 短路（design-review 返回 ok=false 不流转）", () => {
  it("split 空 → design-review ok=false，status 不变（仍 planning）", () => {
    const unitId = "epic:e2e-gate-split";
    dispatch(
      { action: "create", input: { slug: "e2e-gate-split", objective: "o", layer: "epic" } },
      env.deps,
    );
    dispatch(
      { action: "clarify", unitId, input: { clarifications: [makeValidClarification()] } },
      env.deps,
    );
    // plan 写空 split，触发 epicSplitNonEmpty fail
    dispatch(
      { action: "plan", unitId, input: { split: [] } },
      env.deps,
    );

    const result = dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidEpicDesignReviewJudgment() },
      },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.gateResults).toBeDefined();
    expect(result.gateResults!.some((g) => !g.passed)).toBe(true);
    // status 未推进（仍 planning）
    expect(loadEpic(unitId).status).toBe("planning");
  });

  it("judgment layerSpecific undefined → design-review ok=false，含 layer-specific-non-empty fail", () => {
    const unitId = setupToEpicPlanning(env.deps, "e2e-gate-ls");
    const judgment = makeValidEpicDesignReviewJudgment();
    judgment.layerSpecific = undefined;

    const result = dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: judgment } },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.gateResults!.some((g) => /layer-specific-non-empty/.test(g.report))).toBe(true);
    expect(loadEpic(unitId).status).toBe("planning");
  });

  it("split 有环 → design-review ok=false，含 split-dag-valid fail", () => {
    const unitId = "epic:e2e-gate-cycle";
    dispatch(
      { action: "create", input: { slug: "e2e-gate-cycle", objective: "o", layer: "epic" } },
      env.deps,
    );
    dispatch(
      { action: "clarify", unitId, input: { clarifications: [makeValidClarification()] } },
      env.deps,
    );
    // plan split 有环
    dispatch(
      {
        action: "plan",
        unitId,
        input: {
          split: [
            { slug: "a", description: "a", dependsOn: ["b"], inheritedItemIds: [] },
            { slug: "b", description: "b", dependsOn: ["a"], inheritedItemIds: [] },
          ],
        },
      },
      env.deps,
    );

    const result = dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidEpicDesignReviewJudgment() } },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.gateResults!.some((g) => /split-dag-valid/.test(g.report))).toBe(true);
  });

  it("layerSpecific 缺一字段（strategicAlignment 空）→ design-review ok=false", () => {
    const unitId = setupToEpicPlanning(env.deps, "e2e-gate-ls-field");
    const judgment = makeValidEpicDesignReviewJudgment();
    const ls = { ...makeValidEpicLayerSpecific(), strategicAlignment: "" };
    judgment.layerSpecific = ls as unknown as typeof judgment.layerSpecific;

    const result = dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: judgment } },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.gateResults!.some((g) => /strategicAlignment/.test(g.report))).toBe(true);
  });

  it("failureCount 累计（连续 fail 派生）", () => {
    const unitId = "epic:e2e-gate-count";
    dispatch(
      { action: "create", input: { slug: "e2e-gate-count", objective: "o", layer: "epic" } },
      env.deps,
    );
    dispatch(
      { action: "clarify", unitId, input: { clarifications: [makeValidClarification()] } },
      env.deps,
    );
    // plan 写空 split，触发 fail
    dispatch(
      { action: "plan", unitId, input: { split: [] } },
      env.deps,
    );

    const first = dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidEpicDesignReviewJudgment() } },
      env.deps,
    );
    expect(first.ok).toBe(false);
    expect(first.failureCount).toBe(1);

    // 再次 fail（同 action 连续）
    const second = dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidEpicDesignReviewJudgment() } },
      env.deps,
    );
    expect(second.ok).toBe(false);
    expect(second.failureCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// dispatch 非法跳步
// ═══════════════════════════════════════════════════════════════

describe("dispatch epic 非法跳步", () => {
  it("epic create 后直接 execute → throw V1Error(illegal_transition)", () => {
    const unitId = "epic:e2e-illegal";
    dispatch(
      { action: "create", input: { slug: "e2e-illegal", objective: "o", layer: "epic" } },
      env.deps,
    );
    expect(() => dispatch(epicExecute(unitId), env.deps)).toThrow(V1Error);
  });

  it("epic unit not found → throw V1Error(unit_not_found)", () => {
    expect(() =>
      dispatch(
        { action: "clarify", unitId: "epic:ghost", input: { clarifications: [] } },
        env.deps,
      ),
    ).toThrow(V1Error);

    try {
      dispatch(
        { action: "clarify", unitId: "epic:ghost", input: { clarifications: [] } },
        env.deps,
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as V1Error).code).toBe("unit_not_found");
    }
  });

  it("closed 后任何 action → throw V1Error（终态不可逆）", () => {
    const unitId = setupEpicWithClosedFeatures(env.deps, "e2e-terminal");
    dispatch(
      { action: "retrospect", unitId, input: { retrospectData: makeEpicRetrospectDataFromStore(env.deps, unitId) } },
      env.deps,
    );
    dispatch({ action: "closeout", unitId, input: { artifacts: [] } }, env.deps);
    expect(loadEpic(unitId).status).toBe("closed");

    expect(() => dispatch(epicExecute(unitId), env.deps)).toThrow(V1Error);
  });
});

// ═══════════════════════════════════════════════════════════════
// execute 产物：multi-split 创建多个 child feature
// ═══════════════════════════════════════════════════════════════

describe("dispatch epic execute multi-split", () => {
  it("split 多项 → execute 创建多个 child feature，childDelivery 数量匹配", () => {
    const unitId = "epic:e2e-multi";
    dispatch(
      { action: "create", input: { slug: "e2e-multi", objective: "o", layer: "epic" } },
      env.deps,
    );
    dispatch(
      { action: "clarify", unitId, input: { clarifications: [makeValidClarification()] } },
      env.deps,
    );
    dispatch(
      {
        action: "plan",
        unitId,
        input: {
          split: [
            { slug: "f1", description: "feature 1", dependsOn: [], inheritedItemIds: ["Q1"] },
            { slug: "f2", description: "feature 2", dependsOn: ["f1"], inheritedItemIds: ["Q1"] },
          ],
        },
      },
      env.deps,
    );
    dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidEpicDesignReviewJudgment() } },
      env.deps,
    );

    const execute = dispatch(epicExecute(unitId), env.deps);
    expect(execute.ok).toBe(true);

    const epic = loadEpic(unitId);
    expect(epic.executeResult.childUnitIds).toHaveLength(2);
    expect(epic.evidence.childDelivery).toHaveLength(2);
    // 每个 split 对应一条 childDelivery，childStatus=pending
    expect(epic.evidence.childDelivery.every((r) => r.childStatus === "pending")).toBe(true);
    // splitSlug 映射正确
    const slugs = epic.evidence.childDelivery.map((r) => r.splitSlug).sort();
    expect(slugs).toEqual(["f1", "f2"]);
    // child id 格式 feature:epicSlug::splitSlug
    expect(epic.executeResult.childUnitIds[0]).toBe("feature:e2e-multi::f1");
    expect(epic.executeResult.childUnitIds[1]).toBe("feature:e2e-multi::f2");
    // generatedAt 首次写入
    expect(epic.evidence.generatedAt).toBe(STUB_NOW);
  });
});

// ═══════════════════════════════════════════════════════════════
// closeout 后 crossLayer undefined（epic 顶层无父，孤立终点）
// ═══════════════════════════════════════════════════════════════

describe("dispatch epic closeout 顶层无父 crossLayer=undefined", () => {
  it("epic 无 parentUnitId → closeout 后 crossLayer undefined（孤立终点）", () => {
    const unitId = setupEpicWithClosedFeatures(env.deps, "e2e-orphan");
    dispatch(
      { action: "retrospect", unitId, input: { retrospectData: makeEpicRetrospectDataFromStore(env.deps, unitId) } },
      env.deps,
    );
    const closeout = dispatch(
      { action: "closeout", unitId, input: { artifacts: [] } },
      env.deps,
    );

    expect(closeout.ok).toBe(true);
    // epic 顶层无父：closeout 后 crossLayer undefined（与 feature 的 ascend 对比）
    expect(closeout.nextAction?.crossLayer).toBeUndefined();
    // 但 action 字段也是 undefined（终态）
    expect(closeout.nextAction?.action).toBeUndefined();
  });

  it("epic 即使 create 时传 parentUnitId → closeout 仍 undefined（parentUnitId 被忽略）", () => {
    // 用带 parentUnitId 的 create 入参，验证 createEpic 忽略后顶层无父
    const unitId = "epic:e2e-fake-parent";
    dispatch(
      {
        action: "create",
        input: { slug: "e2e-fake-parent", objective: "o", layer: "epic", parentUnitId: "epic:fake" },
      },
      env.deps,
    );
    // 确认 createEpic 忽略了 parentUnitId（顶层语义）
    expect(loadEpic(unitId).parentUnitId).toBeUndefined();

    // 后续阶段直接调 dispatch（不再 create），推进到 closeout
    dispatch(
      { action: "clarify", unitId, input: { clarifications: [makeValidClarification()] } },
      env.deps,
    );
    dispatch({ action: "plan", unitId, input: makeValidEpicPlan() }, env.deps);
    dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidEpicDesignReviewJudgment() } },
      env.deps,
    );
    dispatch(epicExecute(unitId), env.deps);
    advanceChildFeaturesToClosed(env.deps, unitId);
    dispatch(
      { action: "retrospect", unitId, input: { retrospectData: makeEpicRetrospectDataFromStore(env.deps, unitId) } },
      env.deps,
    );
    const closeout = dispatch(
      { action: "closeout", unitId, input: { artifacts: [] } },
      env.deps,
    );

    expect(closeout.ok).toBe(true);
    expect(closeout.nextAction?.crossLayer).toBeUndefined();
  });
});

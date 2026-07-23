/**
 * v1 slice dispatch e2e 测试。
 *
 * 通过 dispatch 统一入口跑完整 slice 生命周期（create→clarify→plan→design-review→
 * execute→[推进 child wave]→retrospect→closeout），验证编排层正确串联 slice handler。
 *
 * 另测 dispatch 拒绝 slice 的 test/exec-review（slice 是 PlanningUnit，无此 action）→
 * throw V1Error(illegal_transition)。
 *
 * 真实 store + stub V1Deps（外部依赖注入接口）。零 mock 框架。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Slice } from "../../src/v1/core/workunit.js";
import { dispatch, V1Error } from "../../src/v1/dispatch.js";
import {
  advanceWaveToClosed,
  createV1Env,
  makeValidPlanningRetrospectData,
  makeValidSliceDesignReviewJudgment,
  makeValidSlicePlan,
  STUB_NOW,
} from "./helpers/slice-env.js";
import type { V1Env } from "./helpers/v1-env.js";

let env: V1Env;

beforeEach(() => {
  env = createV1Env();
});

afterEach(() => {
  env.cleanup();
});

/** 从 store 读最新 slice。 */
function loadSlice(id: string): Slice {
  const r = env.store.load(id);
  return r as unknown as Slice;
}

/**
 * 构造 slice execute 的 dispatch 参数。
 *
 * slice execute 按 plan.split 自动创建 child wave，不接收 input（handler 忽略 params.input）。
 * 但 V1Params 联合的 execute 分支类型是 ExecuteInput（wave 专属，需 commitHash），
 * TS 无法从 action tag 区分 wave/slice 的 execute。故此处显式断言为 V1Params。
 */
function sliceExecute(unitId: string): Parameters<typeof dispatch>[0] {
  return { action: "execute", unitId, input: {} } as unknown as Parameters<typeof dispatch>[0];
}

describe("dispatch 完整 slice 生命周期", () => {
  it("create→clarify→plan→design-review→execute→[child closed]→retrospect→closeout → closed", () => {
    const unitId = "slice:e2e-happy";

    // 1. create（layer='slice'）
    const created = dispatch(
      {
        action: "create",
        input: { slug: "e2e-happy", objective: "deliver oauth slice", layer: "slice" },
      },
      env.deps,
    );
    expect(created.ok).toBe(true);
    expect(created.status).toBe("created");

    // 2. clarify
    const clarify = dispatch(
      {
        action: "clarify",
        unitId,
        input: {
          clarifications: [
            { id: "Q1", status: "active", question: "token 存哪", resolution: "httpOnly cookie", type: "grilling" },
          ],
        },
      },
      env.deps,
    );
    expect(clarify.ok).toBe(true);
    expect(clarify.status).toBe("clarifying");
    expect(loadSlice(unitId).clarifications).toHaveLength(1);

    // 3. plan（SlicePlan 5 字段 + split）
    const plan = dispatch(
      { action: "plan", unitId, input: makeValidSlicePlan() },
      env.deps,
    );
    expect(plan.ok).toBe(true);
    expect(plan.status).toBe("planning");
    expect(loadSlice(unitId).plan.techChoices).toHaveLength(1);

    // 4. design-review
    const dr = dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidSliceDesignReviewJudgment() },
      },
      env.deps,
    );
    expect(dr.ok).toBe(true);
    expect(dr.status).toBe("design-reviewed");
    expect(loadSlice(unitId).designReviewJudgment.necessity).toBeTruthy();

    // 5. execute（slice execute 无 input，按 split 自动创建 child wave）
    const execute = dispatch(sliceExecute(unitId), env.deps);
    expect(execute.ok).toBe(true);
    expect(execute.status).toBe("executing");

    const executingSlice = loadSlice(unitId);
    expect(executingSlice.executeResult.childUnitIds.length).toBeGreaterThan(0);
    // childDelivery 初始全 pending
    expect(executingSlice.evidence.childDelivery.every((r) => r.childStatus === "pending")).toBe(true);
    // crossLayer.descend 指向第一个 child
    expect(execute.nextAction?.crossLayer).toBeDefined();
    expect(execute.nextAction!.crossLayer!.kind).toBe("descend");
    expect(execute.nextAction!.crossLayer!.targetLayer).toBe("wave");
    expect(execute.nextAction!.crossLayer!.targetUnitId).toBe(executingSlice.executeResult.childUnitIds[0]);

    // 6. 推进 child wave 到 closed（用 advanceWaveToClosed helper）
    for (const childId of executingSlice.executeResult.childUnitIds) {
      advanceWaveToClosed(env.deps, childId);
    }
    // child wave closeout 时已 rollup 到 slice.childDelivery
    const afterChildren = loadSlice(unitId);
    expect(afterChildren.evidence.childDelivery.every((r) => r.childStatus === "closed")).toBe(true);

    // 7. retrospect（all-waves-closed pass）
    const retrospect = dispatch(
      {
        action: "retrospect",
        unitId,
        input: { retrospectData: makeValidPlanningRetrospectData() },
      },
      env.deps,
    );
    expect(retrospect.ok).toBe(true);
    expect(retrospect.status).toBe("retrospected");

    // 8. closeout（drift 检查 pass，fileExists stub 始终 true）
    const closeout = dispatch(
      { action: "closeout", unitId, input: { artifacts: [] } },
      env.deps,
    );
    expect(closeout.ok).toBe(true);
    expect(closeout.status).toBe("closed");

    // 最终断言：status=closed + frozenAt 非空 + crossLayer.ascend
    const finalSlice = loadSlice(unitId);
    expect(finalSlice.status).toBe("closed");
    expect(finalSlice.evidence.frozenAt).toBe(STUB_NOW);
    // slice 无 parent（create 未传 parentUnitId）→ crossLayer 无 ascend target，但应有 ascend kind？
    // 实际：无 parentUnitId 时 closeout handler 不填 crossLayer（孤立终点）。验 statusHistory 完整。
    const actions = finalSlice.statusHistory.map((h) => h.action);
    expect(actions).toEqual([
      "create", "clarify", "plan", "design-review", "execute", "retrospect", "closeout",
    ]);
  });

  it("slice 有 parentUnitId → closeout 后 crossLayer.ascend 指向 parent", () => {
    const unitId = "slice:e2e-ascend";
    dispatch(
      {
        action: "create",
        input: {
          slug: "e2e-ascend",
          objective: "o",
          layer: "slice",
          parentUnitId: "feature:parent",
        },
      },
      env.deps,
    );
    dispatch({ action: "clarify", unitId, input: { clarifications: [] } }, env.deps);
    dispatch({ action: "plan", unitId, input: makeValidSlicePlan() }, env.deps);
    dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidSliceDesignReviewJudgment() } },
      env.deps,
    );
    dispatch(sliceExecute(unitId), env.deps);
    for (const childId of loadSlice(unitId).executeResult.childUnitIds) {
      advanceWaveToClosed(env.deps, childId);
    }
    dispatch(
      { action: "retrospect", unitId, input: { retrospectData: makeValidPlanningRetrospectData() } },
      env.deps,
    );
    const closeout = dispatch({ action: "closeout", unitId, input: { artifacts: [] } }, env.deps);

    expect(closeout.ok).toBe(true);
    expect(closeout.nextAction?.crossLayer).toBeDefined();
    expect(closeout.nextAction!.crossLayer!.kind).toBe("ascend");
    expect(closeout.nextAction!.crossLayer!.targetUnitId).toBe("feature:parent");
  });
});

describe("dispatch 拒绝 slice 的 test/exec-review", () => {
  it("slice dispatch test → throw V1Error(illegal_transition)", () => {
    const unitId = "slice:e2e-no-test";
    dispatch(
      { action: "create", input: { slug: "e2e-no-test", objective: "o", layer: "slice" } },
      env.deps,
    );

    expect(() =>
      dispatch(
        { action: "test", unitId, input: { testJudgment: { necessityMet: "x", sufficiencyMet: { gapsConfirmed: [], gapsNewlyFound: [], overlapsConfirmed: [] }, alternativesReconsidered: "", tradeoffCostRealized: [], riskOutcome: [] } } },
        env.deps,
      ),
    ).toThrow(V1Error);

    try {
      dispatch(
        { action: "test", unitId, input: { testJudgment: { necessityMet: "x", sufficiencyMet: { gapsConfirmed: [], gapsNewlyFound: [], overlapsConfirmed: [] }, alternativesReconsidered: "", tradeoffCostRealized: [], riskOutcome: [] } } },
        env.deps,
      );
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as V1Error;
      expect(err.code).toBe("illegal_transition");
      expect(err.message).toMatch(/test/);
    }
  });

  it("slice dispatch exec-review → throw V1Error(illegal_transition)", () => {
    const unitId = "slice:e2e-no-execreview";
    dispatch(
      { action: "create", input: { slug: "e2e-no-execreview", objective: "o", layer: "slice" } },
      env.deps,
    );

    expect(() =>
      dispatch(
        {
          action: "exec-review",
          unitId,
          input: { execReviewJudgment: { readability: { score: 4 }, architecture: { score: 4 }, overallVerdict: "pass" } },
        },
        env.deps,
      ),
    ).toThrow(V1Error);
  });
});

describe("dispatch slice 非法跳步 + gate fail", () => {
  it("slice create 后直接 execute → throw V1Error(illegal_transition)", () => {
    const unitId = "slice:e2e-illegal";
    dispatch(
      { action: "create", input: { slug: "e2e-illegal", objective: "o", layer: "slice" } },
      env.deps,
    );
    expect(() =>
      dispatch(sliceExecute(unitId), env.deps),
    ).toThrow(V1Error);
  });

  it("slice design-review gate fail（techChoices 空）→ ActionResult(ok=false)，status 不变", () => {
    const unitId = "slice:e2e-gate";
    dispatch(
      { action: "create", input: { slug: "e2e-gate", objective: "o", layer: "slice" } },
      env.deps,
    );
    dispatch({ action: "clarify", unitId, input: { clarifications: [] } }, env.deps);
    // plan 空 techChoices（design-review 会 fail tech-choice-non-empty）
    dispatch(
      {
        action: "plan",
        unitId,
        input: { techChoices: [], interfaces: [], dataModels: [], errorSpecs: [], split: [] },
      },
      env.deps,
    );

    const result = dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidSliceDesignReviewJudgment() },
      },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.gateResults).toBeDefined();
    expect(result.gateResults!.some((g) => !g.passed)).toBe(true);
    // status 未推进（仍 planning）
    expect(loadSlice(unitId).status).toBe("planning");
  });

  it("slice unit not found → throw V1Error(unit_not_found)", () => {
    expect(() =>
      dispatch(
        { action: "clarify", unitId: "slice:ghost", input: { clarifications: [] } },
        env.deps,
      ),
    ).toThrow(V1Error);

    try {
      dispatch(
        { action: "clarify", unitId: "slice:ghost", input: { clarifications: [] } },
        env.deps,
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as V1Error).code).toBe("unit_not_found");
    }
  });

  it("closed 后任何 action → throw V1Error（终态不可逆）", () => {
    const unitId = "slice:e2e-terminal";
    dispatch(
      { action: "create", input: { slug: "e2e-terminal", objective: "o", layer: "slice" } },
      env.deps,
    );
    dispatch({ action: "clarify", unitId, input: { clarifications: [] } }, env.deps);
    dispatch({ action: "plan", unitId, input: makeValidSlicePlan() }, env.deps);
    dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidSliceDesignReviewJudgment() } },
      env.deps,
    );
    dispatch(sliceExecute(unitId), env.deps);
    for (const childId of loadSlice(unitId).executeResult.childUnitIds) {
      advanceWaveToClosed(env.deps, childId);
    }
    dispatch(
      { action: "retrospect", unitId, input: { retrospectData: makeValidPlanningRetrospectData() } },
      env.deps,
    );
    dispatch({ action: "closeout", unitId, input: { artifacts: [] } }, env.deps);
    expect(loadSlice(unitId).status).toBe("closed");

    // closed 后再 execute → illegal
    expect(() =>
      dispatch(sliceExecute(unitId), env.deps),
    ).toThrow(V1Error);
  });
});

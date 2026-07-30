/**
 * v1 epic（PlanningUnit 顶层）状态机测试。
 *
 * epic 复用 slice/feature 的 PLANNING_TRANSITIONS（同型状态机，7 步流程），但通过 dispatch
 * 实际推进来验 epic 专属路径：
 * - clarify 数组 push 累积（非 feature 的容器覆盖）—— epic vs feature 核心差异
 * - plan 写入 Plan 基类（只 split，无技术方案）
 * - design-review 跑 epic 10 个 gate（split 结构 2 + 决策/inherited 2 + judgment 5 + layerSpecific 1）
 * - execute 创建 child feature（scope=feature，targetLayer='feature'）
 * - retrospect 查 child feature 状态
 * - closeout 写 frozenAt（顶层无父，crossLayer 天然 undefined）
 *
 * progressive 语义（同 status 可重提）+ 非法转换抛 illegal_transition + replan 旁路 + abort 终态。
 *
 * 真实 store + stub CwDeps。零 mock 框架。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Epic } from "../../src/core/workunit.js";
import { CwEngineError,dispatch } from "../../src/dispatch.js";
import {
  createCwEnv,
  makeEpicRetrospectDataFromStore,
  makeValidClarification,
  makeValidEpicDesignReviewJudgment,
  makeValidEpicPlan,
  makeValidEpicRetrospectData,
  setupEpicWithClosedFeatures,
  setupToEpicClarified,
  setupToEpicDesignReviewed,
  setupToEpicExecuting,
  setupToEpicPlanning,
  STUB_NOW,
} from "./helpers/epic-env.js";
import type { CwEnv } from "./helpers/v1-env.js";

let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
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
// 主链 7 步流转（dispatch 实际推进）
// ═══════════════════════════════════════════════════════════════

describe("epic 主链 7 步状态流转（create→closeout）", () => {
  it("create → created，nextAction=clarify（epic 空态：scope=epic，无 parentUnitId，basedOnParent=[]）", () => {
    const result = dispatch(
      { action: "create", input: { slug: "sm-create", objective: "o", layer: "epic" } },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("created");
    expect(result.nextAction?.action).toBe("clarify");
    expect(result.nextAction?.unitPath.layer).toBe("epic");

    const unit = loadEpic("epic:sm-create");
    expect(unit.scope).toBe("epic");
    expect(unit.statusHistory.at(-1)?.action).toBe("create");
    // epic 顶层无父：parentUnitId 永远 undefined（即使 create 时传也忽略）
    expect(unit.parentUnitId).toBeUndefined();
    // basedOnParent / abandonedRefs 永远 []
    expect(unit.basedOnParent).toEqual([]);
    expect(unit.abandonedRefs).toEqual([]);
    // 初始 clarifications 是空数组（非 feature 的容器对象）
    expect(unit.clarifications).toEqual([]);
    expect(unit.plan.split).toEqual([]);
  });

  it("create 时传 parentUnitId/basedOnParent → 被 createEpic 忽略（顶层语义）", () => {
    dispatch(
      {
        action: "create",
        input: {
          slug: "sm-top",
          objective: "o",
          layer: "epic",
          parentUnitId: "epic:parent",
          basedOnParent: ["X1"],
        },
      },
      env.deps,
    );

    const unit = loadEpic("epic:sm-top");
    expect(unit.parentUnitId).toBeUndefined();
    expect(unit.basedOnParent).toEqual([]);
    expect(unit.abandonedRefs).toEqual([]);
  });

  it("clarify → clarifying，clarifications 数组 push 累积（非 feature 容器覆盖）", () => {
    const unitId = "epic:sm-clarify";
    dispatch(
      { action: "create", input: { slug: "sm-clarify", objective: "o", layer: "epic" } },
      env.deps,
    );

    const result = dispatch(
      {
        action: "clarify",
        unitId,
        input: { clarifications: [makeValidClarification("Q1")] },
      },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("clarifying");
    expect(result.nextAction?.action).toBe("plan");

    const unit = loadEpic(unitId);
    // 数组 push（累积，length=1）
    expect(unit.clarifications).toHaveLength(1);
    expect(unit.clarifications[0]?.id).toBe("Q1");
  });

  it("plan → planning，Plan 基类（只 split）写入", () => {
    const unitId = setupToEpicClarified(env.deps, "sm-plan");
    const result = dispatch(
      { action: "plan", unitId, input: makeValidEpicPlan() },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("planning");
    expect(result.nextAction?.action).toBe("design-review");

    const unit = loadEpic(unitId);
    expect(unit.plan.split).toHaveLength(1);
    expect(unit.plan.split[0]?.slug).toBe("f1");
    // epic plan 无技术方案字段（Plan 基类）
    expect("techChoices" in unit.plan).toBe(false);
  });

  it("design-review → design-reviewed（10 个 gate 全过）", () => {
    const unitId = setupToEpicPlanning(env.deps, "sm-dr");
    const result = dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidEpicDesignReviewJudgment() },
      },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("design-reviewed");
    expect(result.nextAction?.action).toBe("execute");
    expect(result.gateResults).toHaveLength(10);

    const unit = loadEpic(unitId);
    expect(unit.designReviewJudgment.necessity).toBeTruthy();
  });

  it("execute → executing（创建 child feature，targetLayer=feature）", () => {
    const unitId = setupToEpicDesignReviewed(env.deps, "sm-exec");
    const result = dispatch(epicExecute(unitId), env.deps);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("executing");
    // execute 后 nextAction.action=undefined（下沉），crossLayer.descend 指向 child feature
    expect(result.nextAction?.action).toBeUndefined();
    expect(result.nextAction?.crossLayer?.kind).toBe("descend");
    expect(result.nextAction?.crossLayer?.targetLayer).toBe("feature");

    const unit = loadEpic(unitId);
    expect(unit.executeResult.childUnitIds.length).toBeGreaterThan(0);
    // child 是 feature
    const childId = unit.executeResult.childUnitIds[0]!;
    const child = env.store.load(childId) as unknown as { scope: string };
    expect(child.scope).toBe("feature");
    // childDelivery 初始快照 childStatus=pending
    expect(unit.evidence.childDelivery.every((r) => r.childStatus === "pending")).toBe(true);
  });

  it("retrospect → retrospected（child feature 全 closed）", () => {
    const unitId = setupEpicWithClosedFeatures(env.deps, "sm-retro");
    const result = dispatch(
      {
        action: "retrospect",
        unitId,
        input: { retrospectData: makeEpicRetrospectDataFromStore(env.deps, unitId) },
      },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("retrospected");
    expect(result.nextAction?.action).toBe("closeout");
  });

  it("closeout → closed（frozenAt 写入，顶层无父 crossLayer=undefined）", () => {
    const unitId = setupEpicWithClosedFeatures(env.deps, "sm-close");
    dispatch(
      {
        action: "retrospect",
        unitId,
        input: { retrospectData: makeEpicRetrospectDataFromStore(env.deps, unitId) },
      },
      env.deps,
    );
    const result = dispatch(
      { action: "closeout", unitId, input: { artifacts: [] } },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("closed");

    const unit = loadEpic(unitId);
    expect(unit.evidence.frozenAt).toBe(STUB_NOW);
    // 完整 statusHistory 序列
    expect(unit.statusHistory.map((h) => h.action)).toEqual([
      "create", "clarify", "plan", "design-review", "execute", "retrospect", "closeout",
    ]);
    // epic 顶层无父：closeout 后 crossLayer 天然 undefined（孤立终点）
    expect(result.nextAction?.crossLayer).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// clarify 数组 push 累积（epic vs feature 核心差异）
// ═══════════════════════════════════════════════════════════════

describe("epic clarify 数组 push 累积（非 feature 容器覆盖）", () => {
  it("第一次 clarify 传 [Q1] → clarifications.length===1；第二次 clarify 传 [Q2] → length===2（累积）", () => {
    const unitId = "epic:sm-accum";
    dispatch(
      { action: "create", input: { slug: "sm-accum", objective: "o", layer: "epic" } },
      env.deps,
    );

    // 第一次 clarify：传 [Q1]
    dispatch(
      { action: "clarify", unitId, input: { clarifications: [makeValidClarification("Q1")] } },
      env.deps,
    );
    let unit = loadEpic(unitId);
    expect(unit.clarifications).toHaveLength(1);
    expect(unit.clarifications.map((c) => c.id)).toEqual(["Q1"]);

    // 第二次 clarify：传 [Q2]，累积（length=2，非覆盖）
    dispatch(
      { action: "clarify", unitId, input: { clarifications: [makeValidClarification("Q2")] } },
      env.deps,
    );
    unit = loadEpic(unitId);
    expect(unit.clarifications).toHaveLength(2);
    expect(unit.clarifications.map((c) => c.id)).toEqual(["Q1", "Q2"]);
  });

  it("单次 clarify 传多个 → 全部 push（[Q1,Q2] → length===2）", () => {
    const unitId = "epic:sm-multi";
    dispatch(
      { action: "create", input: { slug: "sm-multi", objective: "o", layer: "epic" } },
      env.deps,
    );
    dispatch(
      {
        action: "clarify",
        unitId,
        input: { clarifications: [makeValidClarification("Q1"), makeValidClarification("Q2")] },
      },
      env.deps,
    );
    const unit = loadEpic(unitId);
    expect(unit.clarifications).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// progressive 语义（同 status 可重提）
// ═══════════════════════════════════════════════════════════════

describe("epic progressive 语义", () => {
  it("clarifying 再次 clarify → 仍 clarifying", () => {
    const unitId = setupToEpicClarified(env.deps, "sm-prog-clarify");
    const before = loadEpic(unitId);
    expect(before.status).toBe("clarifying");

    const result = dispatch(
      { action: "clarify", unitId, input: { clarifications: [makeValidClarification("Q9")] } },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("clarifying");
  });

  it("planning 再次 plan → 仍 planning", () => {
    const unitId = setupToEpicPlanning(env.deps, "sm-prog-plan");
    const result = dispatch(
      { action: "plan", unitId, input: makeValidEpicPlan() },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("planning");
  });

  it("design-reviewed 再次 design-review → 仍 design-reviewed", () => {
    const unitId = setupToEpicDesignReviewed(env.deps, "sm-prog-dr");
    const result = dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidEpicDesignReviewJudgment() },
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

describe("epic 非法转换抛 illegal_transition", () => {
  it("created 直接 execute → throw CwEngineError(illegal_transition)", () => {
    const unitId = "epic:sm-illegal-exec";
    dispatch(
      { action: "create", input: { slug: "sm-illegal-exec", objective: "o", layer: "epic" } },
      env.deps,
    );
    expect(() => dispatch(epicExecute(unitId), env.deps)).toThrow(CwEngineError);
    try {
      dispatch(epicExecute(unitId), env.deps);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CwEngineError).code).toBe("illegal_transition");
    }
  });

  it("planning 直接 closeout → throw CwEngineError(illegal_transition)", () => {
    const unitId = setupToEpicPlanning(env.deps, "sm-illegal-close");
    expect(() =>
      dispatch({ action: "closeout", unitId, input: { artifacts: [] } }, env.deps),
    ).toThrow(CwEngineError);
  });

  it("design-reviewed 直接 retrospect（未 execute）→ throw CwEngineError", () => {
    const unitId = setupToEpicDesignReviewed(env.deps, "sm-illegal-retro");
    expect(() =>
      dispatch(
        { action: "retrospect", unitId, input: { retrospectData: makeValidEpicRetrospectData() } },
        env.deps,
      ),
    ).toThrow(CwEngineError);
  });

  it("closed 后任何 action → throw CwEngineError（终态不可逆）", () => {
    const unitId = setupEpicWithClosedFeatures(env.deps, "sm-terminal");
    dispatch(
      { action: "retrospect", unitId, input: { retrospectData: makeEpicRetrospectDataFromStore(env.deps, unitId) } },
      env.deps,
    );
    dispatch({ action: "closeout", unitId, input: { artifacts: [] } }, env.deps);
    expect(loadEpic(unitId).status).toBe("closed");

    expect(() => dispatch(epicExecute(unitId), env.deps)).toThrow(CwEngineError);
  });

  it("epic unit not found → throw CwEngineError(unit_not_found)", () => {
    expect(() =>
      dispatch(
        { action: "clarify", unitId: "epic:ghost", input: { clarifications: [] } },
        env.deps,
      ),
    ).toThrow(CwEngineError);
    try {
      dispatch(
        { action: "clarify", unitId: "epic:ghost", input: { clarifications: [] } },
        env.deps,
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CwEngineError).code).toBe("unit_not_found");
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// replan 旁路（status 不变）
// ═══════════════════════════════════════════════════════════════

describe("epic replan 旁路（status 不变）", () => {
  it("design-reviewed replan → status 仍 design-reviewed，nextAction.action=plan", () => {
    const unitId = setupToEpicDesignReviewed(env.deps, "sm-replan");
    const before = loadEpic(unitId);
    expect(before.status).toBe("design-reviewed");

    const result = dispatch(
      {
        action: "replan",
        unitId,
        input: { abandonedIds: ["Q1"], note: "战略调整" },
      },
      env.deps,
    );
    expect(result.ok).toBe(true);
    // replan 是旁路，status 不变
    expect(result.status).toBe("design-reviewed");
    expect(result.nextAction?.action).toBe("plan");
    // replanImpact 有返回
    expect(result.replanImpact).toBeDefined();

    // 本地标记：abandonedIds 命中的 epic Clarification 标 status='abandoned'（append-only，不删）
    const after = loadEpic(unitId);
    const hit = after.clarifications.filter((c) => c.id === "Q1");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.status).toBe("abandoned");
    // 条目仍在数组里（未物理删除）
    expect(after.clarifications.length).toBeGreaterThanOrEqual(1);
  });

  it("executing replan → status 仍 executing", () => {
    const unitId = setupToEpicExecuting(env.deps, "sm-replan-exec");
    const result = dispatch(
      {
        action: "replan",
        unitId,
        input: { abandonedIds: ["Q1"], note: "执行中发现影响面" },
      },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("executing");
    // 本地标记同样生效（与 status 无关，design-reviewed/executing 一致）
    const after = loadEpic(unitId);
    expect(
      after.clarifications.find((c) => c.id === "Q1")?.status,
    ).toBe("abandoned");
  });
});

// ═══════════════════════════════════════════════════════════════
// T9c: epic replan→feature 级联 abort
// ═══════════════════════════════════════════════════════════════

describe("T9c: epic replan→feature 级联 abort", () => {
  it("epic replan 废弃 Q1 → child feature status 变 aborted + abandonedRefs 追加", () => {
    const unitId = setupToEpicExecuting(env.deps, "cascade-epic");
    const unit = loadEpic(unitId);
    const childId = unit.executeResult.childUnitIds[0]!;

    const childBefore = env.store.load(childId) as unknown as { basedOnParent: string[]; status: string };
    expect(childBefore.basedOnParent).toContain("Q1");
    expect(childBefore.status).toBe("created");

    const result = dispatch(
      { action: "replan", unitId, input: { abandonedIds: ["Q1"], note: "Q1 obsolete, cascade child" } },
      env.deps,
    ) as { ok: boolean; replanImpact?: { aborted: string[] } };
    expect(result.ok).toBe(true);
    expect(result.replanImpact!.aborted).toContain(childId);

    const childAfter = env.store.load(childId) as unknown as { status: string; abandonedRefs: Array<{ workUnitItemId: string }> };
    expect(childAfter.status).toBe("aborted");
    expect(childAfter.abandonedRefs.some((r) => r.workUnitItemId === "Q1")).toBe(true);

    const epicAfter = env.store.load(unitId) as unknown as { status: string };
    expect(epicAfter.status).toBe("executing");
  });

  it("epic replan 废弃不存在的 id → aborted 空", () => {
    const unitId = setupToEpicExecuting(env.deps, "cascade-epic-empty");
    const result = dispatch(
      { action: "replan", unitId, input: { abandonedIds: ["GHOST_ID"], note: "no hit" } },
      env.deps,
    ) as { ok: boolean; replanImpact?: { aborted: string[]; pendingRebuild: string[] } };
    expect(result.ok).toBe(true);
    expect(result.replanImpact!.aborted).toEqual([]);
    expect(result.replanImpact!.pendingRebuild).toEqual(["GHOST_ID"]);
  });

  it("已 aborted 的 child 不重复处理（幂等）", () => {
    const unitId = setupToEpicExecuting(env.deps, "cascade-epic-idempotent");
    const unit = loadEpic(unitId);
    const childId = unit.executeResult.childUnitIds[0]!;

    dispatch({ action: "replan", unitId, input: { abandonedIds: ["Q1"], note: "first" } }, env.deps);
    const afterFirst = env.store.load(childId) as unknown as {
      status: string; abandonedRefs: Array<{ workUnitItemId: string }>; statusHistory: Array<{ action: string }>;
    };
    expect(afterFirst.status).toBe("aborted");
    const refsAfterFirst = afterFirst.abandonedRefs.filter((r) => r.workUnitItemId === "Q1").length;
    const historyAfterFirst = afterFirst.statusHistory.length;

    dispatch({ action: "replan", unitId, input: { abandonedIds: ["Q1"], note: "second" } }, env.deps);
    const afterSecond = env.store.load(childId) as unknown as {
      abandonedRefs: Array<{ workUnitItemId: string }>; statusHistory: Array<{ action: string }>;
    };
    expect(afterSecond.abandonedRefs.filter((r) => r.workUnitItemId === "Q1").length).toBe(refsAfterFirst);
    expect(afterSecond.statusHistory.length).toBe(historyAfterFirst);
  });
});

// ═══════════════════════════════════════════════════════════════
// abort 终态
// ═══════════════════════════════════════════════════════════════

describe("epic abort 终态", () => {
  it("planning abort → status=aborted（终态不可逆）", () => {
    const unitId = setupToEpicPlanning(env.deps, "sm-abort");
    const result = dispatch(
      { action: "abort", unitId, input: { reason: "需求取消" } },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("aborted");
    expect(result.nextAction?.action).toBeUndefined();

    // 终态不可逆：再次任何 action 抛 illegal_transition
    expect(() =>
      dispatch({ action: "plan", unitId, input: makeValidEpicPlan() }, env.deps),
    ).toThrow(CwEngineError);
  });

  it("executing abort → 级联 abort 所有 child feature", () => {
    const unitId = setupToEpicExecuting(env.deps, "sm-abort-exec");
    const unit = loadEpic(unitId);
    const childId = unit.executeResult.childUnitIds[0]!;

    const result = dispatch(
      { action: "abort", unitId, input: { reason: "放弃" } },
      env.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("aborted");

    // child feature 也被级联 abort
    const child = env.store.load(childId) as unknown as { status: string };
    expect(child.status).toBe("aborted");
  });
});

// ═══════════════════════════════════════════════════════════════
// 派生字段：execute 后 child feature 的 basedOnParent 来自 split.inheritedItemIds
// ═══════════════════════════════════════════════════════════════

describe("epic execute child feature 基于配置", () => {
  it("child feature slug = epicSlug::splitSlug，basedOnParent = split.inheritedItemIds", () => {
    const unitId = setupToEpicExecuting(env.deps, "sm-child");
    const unit = loadEpic(unitId);
    const childId = unit.executeResult.childUnitIds[0]!;
    // slug 格式 epicSlug::splitSlug
    expect(childId).toBe("feature:sm-child::f1");
    const child = env.store.load(childId) as unknown as {
      basedOnParent: string[];
      parentUnitId: string;
      objective: string;
    };
    expect(child.basedOnParent).toEqual(["Q1"]);
    expect(child.parentUnitId).toBe(unitId);
    // objective = split.description
    expect(child.objective).toBe(unit.plan.split[0]?.description);
  });
});

/**
 * v1 slice replan 级联影响面测试。
 *
 * 两部分：
 * 1. computeImpactCascade 纯函数测试（src/v1/rules/replan.ts）—— mock loadChildren（手写 stub，非 mock 框架）
 *    - 命中规则：child.basedOnParent 含废弃条目 → aborted
 *    - 级联传播：parent 受影响 → child 也 abort
 *    - pendingRebuild：失去承接的条目
 * 2. handleReplanSlice 集成测试（真实 store）—— slice replan 废弃 IF1 → child wave（basedOnParent 含 IF1）
 *    status 变 aborted + abandonedRefs 追加
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkUnitBase } from "../../src/v1/core/workunit.js";
import { handleExecuteSlice } from "../../src/v1/handlers/slice/execute.js";
import { handleReplanSlice } from "../../src/v1/handlers/slice/replan.js";
import { computeImpactCascade } from "../../src/v1/rules/replan.js";
import type { WorkUnitRecord } from "../../src/v1/store/schema.js";
import {
  createV1Env,
  setupSliceWithClosedWaves,
  setupToSliceDesignReviewed,
} from "./helpers/slice-env.js";
import type { V1Env } from "./helpers/v1-env.js";

let env: V1Env;

beforeEach(() => {
  env = createV1Env();
});

afterEach(() => {
  env.cleanup();
});

// ── 纯函数辅助：构造 WorkUnitBase（只含影响面计算需要的字段）──

function wub(
  id: string,
  parentUnitId: string | undefined,
  basedOnParent: string[],
): WorkUnitBase {
  return {
    id,
    scope: "wave",
    slug: id,
    parentUnitId,
    status: "created",
    statusHistory: [],
    basedOnParent,
    abandonedRefs: [],
    objective: "",
  };
}

/** 把多个 unit 存进一个 mock store（按 parentId 索引），构造 ChildrenLoader。 */
function makeChildLoader(
  byParent: Map<string, WorkUnitBase[]>,
): (parentId: string) => WorkUnitBase[] {
  return (parentId: string) => byParent.get(parentId) ?? [];
}

// ═══════════════════════════════════════════════════════════════
// computeImpactCascade 纯函数
// ═══════════════════════════════════════════════════════════════

describe("computeImpactCascade: 纯函数（mock loadChildren）", () => {
  it("slice 无子孙（loadChildren 恒返回 []）→ aborted/preserved 都空", () => {
    const slice = wub("slice:s", undefined, []);
    const impact = computeImpactCascade({
      unit: slice,
      abandonedIds: ["IF1"],
      loadChildren: () => [],
    });
    expect(impact.aborted).toEqual([]);
    expect(impact.preserved).toEqual([]);
    // IF1 无 preserved 引用 → pendingRebuild
    expect(impact.pendingRebuild).toEqual(["IF1"]);
  });

  it("abandonedIds 空 → 全 preserved，pendingRebuild 空", () => {
    const slice = wub("slice:s", undefined, []);
    const w1 = wub("wave:w1", "slice:s", ["IF1"]);
    const loader = makeChildLoader(new Map([["slice:s", [w1]]]));
    const impact = computeImpactCascade({
      unit: slice,
      abandonedIds: [],
      loadChildren: loader,
    });
    expect(impact.aborted).toEqual([]);
    expect(impact.preserved).toEqual(["wave:w1"]);
    expect(impact.pendingRebuild).toEqual([]);
  });

  it("命中规则：abandonedIds=[IF1]，w1 basedOnParent=[IF1] → w1 abort；w2 basedOnParent=[DM1] → preserved", () => {
    const slice = wub("slice:s", undefined, []);
    const w1 = wub("wave:w1", "slice:s", ["IF1"]);
    const w2 = wub("wave:w2", "slice:s", ["DM1"]);
    const loader = makeChildLoader(new Map([["slice:s", [w1, w2]]]));

    const impact = computeImpactCascade({
      unit: slice,
      abandonedIds: ["IF1"],
      loadChildren: loader,
    });
    expect(impact.aborted).toEqual(["wave:w1"]);
    expect(impact.preserved).toEqual(["wave:w2"]);
    // IF1 被 aborted w1 引用、无 preserved 引用 → pendingRebuild
    expect(impact.pendingRebuild).toEqual(["IF1"]);
  });

  it("级联传播：w1 命中 → w1child（parent=w1）也 abort（parent 受影响→child 级联）", () => {
    const slice = wub("slice:s", undefined, []);
    const w1 = wub("wave:w1", "slice:s", ["IF1"]);
    const w1child = wub("wave:w1c", "wave:w1", ["DM1"]); // 不直接命中 IF1，但 parent=w1 会级联
    const loader = makeChildLoader(
      new Map([
        ["slice:s", [w1]],
        ["wave:w1", [w1child]],
      ]),
    );

    const impact = computeImpactCascade({
      unit: slice,
      abandonedIds: ["IF1"],
      loadChildren: loader,
    });
    expect(impact.aborted).toEqual(["wave:w1", "wave:w1c"]);
    expect(impact.preserved).toEqual([]);
    // w1c 的 basedOnParent=[DM1]，但 w1c 已 aborted → DM1 无 preserved 引用
    // 但 DM1 不在 abandonedIds 里，pendingRebuild 只算 abandonedIds 中的 → 只 IF1
    expect(impact.pendingRebuild).toEqual(["IF1"]);
  });

  it("三级级联：slice → w1 → w1a → w1aa，w1 命中 → 全链 abort", () => {
    const slice = wub("slice:s", undefined, []);
    const w1 = wub("wave:w1", "slice:s", ["IF1"]);
    const w1a = wub("wave:w1a", "wave:w1", []);
    const w1aa = wub("wave:w1aa", "wave:w1a", []);
    const loader = makeChildLoader(
      new Map([
        ["slice:s", [w1]],
        ["wave:w1", [w1a]],
        ["wave:w1a", [w1aa]],
      ]),
    );

    const impact = computeImpactCascade({
      unit: slice,
      abandonedIds: ["IF1"],
      loadChildren: loader,
    });
    expect(impact.aborted).toEqual(["wave:w1", "wave:w1a", "wave:w1aa"]);
  });

  it("pendingRebuild：IF1 有 preserved 引用 → 不进 pendingRebuild", () => {
    const slice = wub("slice:s", undefined, []);
    const w1 = wub("wave:w1", "slice:s", ["IF1"]); // 命中 → abort
    const w2 = wub("wave:w2", "slice:s", ["IF1", "DM1"]); // 也命中 IF1 → abort
    const w3 = wub("wave:w3", "slice:s", ["IF1"]); // 也命中 → abort
    // 没有任何 preserved unit 引用 IF1 → IF1 pendingRebuild
    const loader = makeChildLoader(new Map([["slice:s", [w1, w2, w3]]]));
    const impact = computeImpactCascade({
      unit: slice,
      abandonedIds: ["IF1"],
      loadChildren: loader,
    });
    expect(impact.aborted).toEqual(["wave:w1", "wave:w2", "wave:w3"]);
    expect(impact.pendingRebuild).toEqual(["IF1"]);
  });

  it("pendingRebuild：IF1 有 preserved unit 引用 → 不进 pendingRebuild", () => {
    const slice = wub("slice:s", undefined, []);
    const w1 = wub("wave:w1", "slice:s", ["IF1"]); // 命中 → abort
    const w2 = wub("wave:w2", "slice:s", ["DM1"]); // preserved，但不引用 IF1
    const w3 = wub("wave:w3", "slice:s", ["IF1", "DM1"]); // 命中 IF1 → abort
    // w2 preserved 但不引用 IF1 → IF1 仍无 preserved 引用 → pendingRebuild
    const loader = makeChildLoader(new Map([["slice:s", [w1, w2, w3]]]));
    const impact = computeImpactCascade({
      unit: slice,
      abandonedIds: ["IF1"],
      loadChildren: loader,
    });
    expect(impact.preserved).toEqual(["wave:w2"]);
    expect(impact.pendingRebuild).toEqual(["IF1"]);
  });

  it("多 abandonedIds：IF1 + DM1 同时废弃，分别命中不同 child", () => {
    const slice = wub("slice:s", undefined, []);
    const w1 = wub("wave:w1", "slice:s", ["IF1"]);
    const w2 = wub("wave:w2", "slice:s", ["DM1"]);
    const w3 = wub("wave:w3", "slice:s", ["TC1"]); // 不命中
    const loader = makeChildLoader(new Map([["slice:s", [w1, w2, w3]]]));
    const impact = computeImpactCascade({
      unit: slice,
      abandonedIds: ["IF1", "DM1"],
      loadChildren: loader,
    });
    expect(impact.aborted).toEqual(["wave:w1", "wave:w2"]);
    expect(impact.preserved).toEqual(["wave:w3"]);
    // IF1 + DM1 都无 preserved 引用 → 都 pendingRebuild
    expect(impact.pendingRebuild).toEqual(["IF1", "DM1"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// handleReplanSlice 集成（真实 store）
// ═══════════════════════════════════════════════════════════════

describe("handleReplanSlice 集成：级联 abort child wave", () => {
  it("slice replan 废弃 IF1 → child wave（basedOnParent 含 IF1）status 变 aborted + abandonedRefs 追加", () => {
    // 1. setupToSliceDesignReviewed 后再 execute 创建 child wave
    const slice = setupToSliceDesignReviewed(env.deps, "replan-slice");

    // 改 split 让 child wave basedOnParent 含 IF1（默认 makeValidSplit inheritedItemIds 已含 IF1+DM1）
    // execute 创建 child wave
    handleExecuteSlice(slice, env.deps);

    const childIds = slice.executeResult.childUnitIds;
    expect(childIds.length).toBeGreaterThan(0);
    const childId = childIds[0]!;

    // 验证 child wave basedOnParent 含 IF1（makeValidSplit.inheritedItemIds 默认 ["IF1","DM1"]）
    const childBefore = env.store.load(childId)!;
    expect((childBefore as unknown as { basedOnParent: string[] }).basedOnParent).toContain("IF1");

    // 2. replan 废弃 IF1
    const result = handleReplanSlice(
      slice,
      { abandonedIds: ["IF1"], note: "IF1 obsolete" },
      env.deps,
    );

    expect(result.ok).toBe(true);
    expect(result.replanImpact).toBeDefined();
    expect(result.replanImpact!.aborted).toContain(childId);

    // 3. child wave status 变 aborted
    const childAfter = env.store.load(childId)!;
    expect((childAfter as unknown as { status: string }).status).toBe("aborted");

    // 4. child wave abandonedRefs 追加 IF1
    const abandonedRefs = (childAfter as unknown as { abandonedRefs: Array<{ workUnitItemId: string }> }).abandonedRefs;
    expect(abandonedRefs.some((r) => r.workUnitItemId === "IF1")).toBe(true);

    // 5. slice 自身 IF1 条目标 abandoned（append-only）
    const sliceReloaded = env.store.load(slice.id)! as unknown as {
      plan: { interfaces: Array<{ id: string; status: string }> };
    };
    const if1 = sliceReloaded.plan.interfaces.find((i) => i.id === "IF1");
    expect(if1?.status).toBe("abandoned");

    // 6. status 不变（replan 旁路）—— execute 后 slice 是 executing，replan 后仍 executing
    expect(result.status).toBe("executing");
  });

  it("slice replan 废弃不存在的 id（无 child 命中）→ aborted 空", () => {
    const slice = setupToSliceDesignReviewed(env.deps, "replan-empty");
    handleExecuteSlice(slice, env.deps);

    const result = handleReplanSlice(
      slice,
      { abandonedIds: ["GHOST_ID"], note: "no hit" },
      env.deps,
    );

    expect(result.ok).toBe(true);
    expect(result.replanImpact!.aborted).toEqual([]);
    expect(result.replanImpact!.pendingRebuild).toEqual(["GHOST_ID"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// handleReplanSlice 集成：closed 子孙不再跳过（M2 修复）
// ═══════════════════════════════════════════════════════════════

describe("handleReplanSlice 集成：closed child 不再跳过（slice §6.1）", () => {
  /** 读 record 的 status / statusHistory / abandonedRefs（store 透传，字段类型放宽）。 */
  function readWave(record: WorkUnitRecord): {
    status: string;
    history: Array<{ from?: string; to?: string; action?: string }>;
    abandonedRefs: Array<{ workUnitItemId: string }>;
  } {
    return {
      status: String(record.status ?? ""),
      history: (record.statusHistory ?? []) as Array<{
        from?: string;
        to?: string;
        action?: string;
      }>,
      abandonedRefs: (record.abandonedRefs ?? []) as Array<{
        workUnitItemId: string;
      }>,
    };
  }

  it("TC1：引用废弃条目的已 closed wave 被标 aborted（不再跳过）", () => {
    // setupSliceWithClosedWaves：child wave 走完 9 步到 closed
    const { slice } = setupSliceWithClosedWaves(env.deps, "closed-cascade");
    const childId = slice.executeResult.childUnitIds[0]!;

    // 前置：child wave 确为 closed，且 basedOnParent 含 IF1
    const before = readWave(env.store.load(childId)!);
    expect(before.status).toBe("closed");
    expect(
      (env.store.load(childId)! as unknown as { basedOnParent: string[] })
        .basedOnParent,
    ).toContain("IF1");

    // replan 废弃 IF1
    const result = handleReplanSlice(
      slice,
      { abandonedIds: ["IF1"], note: "IF1 obsolete, cascade closed child" },
      env.deps,
    );

    expect(result.ok).toBe(true);
    expect(result.replanImpact!.aborted).toContain(childId);

    // child wave 由 closed 变 aborted
    const after = readWave(env.store.load(childId)!);
    expect(after.status).toBe("aborted");

    // abandonedRefs 追加 IF1
    expect(after.abandonedRefs.some((r) => r.workUnitItemId === "IF1")).toBe(true);
  });

  it("TC3：closed→aborted 的 statusHistory from=closed 记录正确", () => {
    const { slice } = setupSliceWithClosedWaves(env.deps, "closed-from-rec");
    const childId = slice.executeResult.childUnitIds[0]!;

    handleReplanSlice(
      slice,
      { abandonedIds: ["IF1"], note: "verify from field" },
      env.deps,
    );

    const after = readWave(env.store.load(childId)!);
    // 最后一条 statusHistory 应是 closed→aborted action=abort
    const last = after.history[after.history.length - 1]!;
    expect(last.from).toBe("closed");
    expect(last.to).toBe("aborted");
    expect(last.action).toBe("abort");
  });

  it("TC2：已 aborted 的 child 不重复处理（幂等：不重复 append abandonedRefs）", () => {
    const { slice } = setupSliceWithClosedWaves(env.deps, "aborted-idempotent");
    const childId = slice.executeResult.childUnitIds[0]!;

    // 第一次 replan：closed→aborted，append 一条 IF1 abandonedRef
    handleReplanSlice(
      slice,
      { abandonedIds: ["IF1"], note: "first replan" },
      env.deps,
    );
    const afterFirst = readWave(env.store.load(childId)!);
    expect(afterFirst.status).toBe("aborted");
    const refsAfterFirst = afterFirst.abandonedRefs.filter(
      (r) => r.workUnitItemId === "IF1",
    ).length;
    const historyAfterFirst = afterFirst.history.length;

    // 第二次 replan：child 已 aborted → 跳过，不重复 append
    const reloaded = env.store.load(slice.id)! as unknown as Parameters<
      typeof handleReplanSlice
    >[0];
    handleReplanSlice(
      reloaded,
      { abandonedIds: ["IF1"], note: "second replan" },
      env.deps,
    );

    const afterSecond = readWave(env.store.load(childId)!);
    const refsAfterSecond = afterSecond.abandonedRefs.filter(
      (r) => r.workUnitItemId === "IF1",
    ).length;

    // 幂等：IF1 abandonedRef 数量不变，statusHistory 不追加
    expect(refsAfterSecond).toBe(refsAfterFirst);
    expect(afterSecond.history.length).toBe(historyAfterFirst);
  });
});

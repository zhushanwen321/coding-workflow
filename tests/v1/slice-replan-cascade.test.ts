/**
 * v1 slice replan 级联影响面测试。
 *
 * 两部分：
 * 1. computeImpactCascade 纯函数测试（src/rules/replan.ts）—— mock loadChildren（手写 stub，非 mock 框架）
 *    - 命中规则：child.basedOnParent 含废弃条目 → aborted
 *    - 级联传播：parent 受影响 → child 也 abort
 *    - pendingRebuild：失去承接的条目
 * 2. handleReplanSlice 集成测试（真实 store）—— slice replan 废弃 IF1 → child wave（basedOnParent 含 IF1）
 *    status 变 aborted + abandonedRefs 追加
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkUnitBase } from "../../src/core/workunit.js";
import { createWave } from "../../src/core/workunit.js";
import { handleClarify } from "../../src/handlers/clarify.js";
import { handlePlan } from "../../src/handlers/plan.js";
import { handleExecuteSlice } from "../../src/handlers/slice/execute.js";
import { handleReplanSlice } from "../../src/handlers/slice/replan.js";
import { computeImpactCascade } from "../../src/rules/replan.js";
import type { WorkUnitRecord } from "../../src/store/schema.js";
import {
  createCwEnv,
  setupSliceWithClosedWaves,
  setupToSliceDesignReviewed,
} from "./helpers/slice-env.js";
import type { CwEnv } from "./helpers/v1-env.js";
import {
  makeValidContract,
  makeValidFile,
  makeValidTask,
  makeValidTestCase,
} from "./helpers/v1-env.js";

let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
});

afterEach(() => {
  env.cleanup();
});

// ── 纯函数辅助：构造 WorkUnitBase（只含影响面计算需要的字段）──

function wub(
  id: string,
  parentUnitId: string | undefined,
  basedOnParent: string[],
  abandonedParentItems?: string[],
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
    abandonedParentItems: abandonedParentItems ?? [],
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

  // ── abandonedParentItems 例外：wave 主动声明脱离的 parent 条目不触发 abort ──

  it("abandonedParentItems 例外：wave 声明废弃 TC3 → slice replan 废弃 TC3 时 wave preserved", () => {
    const slice = wub("slice:s", undefined, []);
    const w1 = wub("wave:w1", "slice:s", ["TC1", "TC3"]); // 含 TC3，但未声明废弃
    const w2 = wub("wave:w2", "slice:s", ["TC1", "TC3"], ["TC3"]); // 含 TC3，已声明废弃
    const loader = makeChildLoader(new Map([["slice:s", [w1, w2]]]));

    const impact = computeImpactCascade({
      unit: slice,
      abandonedIds: ["TC3"],
      loadChildren: loader,
    });
    // w1 含 TC3 且未声明废弃 → abort
    // w2 含 TC3 但已声明废弃 → preserved（例外）
    expect(impact.aborted).toEqual(["wave:w1"]);
    expect(impact.preserved).toEqual(["wave:w2"]);
    // TC3 有 w2 preserved 引用 → 不 pendingRebuild
    expect(impact.pendingRebuild).toEqual([]);
  });

  it("abandonedParentItems 例外：废弃多个条目，wave 只声明废弃其中一个", () => {
    const slice = wub("slice:s", undefined, []);
    // w1 含 TC3+TC5，只声明废弃 TC3
    const w1 = wub("wave:w1", "slice:s", ["TC3", "TC5"], ["TC3"]);
    const loader = makeChildLoader(new Map([["slice:s", [w1]]]));

    const impact = computeImpactCascade({
      unit: slice,
      abandonedIds: ["TC3", "TC5"],
      loadChildren: loader,
    });
    // w1 含 TC3(已声明废弃,跳过) + TC5(未声明废弃,命中) → abort
    expect(impact.aborted).toEqual(["wave:w1"]);
    expect(impact.preserved).toEqual([]);
  });

  it("abandonedParentItems 空数组 → 等价于无例外（行为不变）", () => {
    const slice = wub("slice:s", undefined, []);
    const w1 = wub("wave:w1", "slice:s", ["TC3"], []); // 空数组 = 无废弃声明
    const loader = makeChildLoader(new Map([["slice:s", [w1]]]));

    const impact = computeImpactCascade({
      unit: slice,
      abandonedIds: ["TC3"],
      loadChildren: loader,
    });
    // w1 含 TC3，无废弃声明 → 正常 abort（行为与无 abandonedParentItems 一致）
    expect(impact.aborted).toEqual(["wave:w1"]);
  });

  it("abandonedParentItems undefined → 等价于无例外（向后兼容）", () => {
    const slice = wub("slice:s", undefined, []);
    // 不传第 4 参数 → abandonedParentItems = []（wub 默认）
    const w1 = wub("wave:w1", "slice:s", ["TC3"]);
    const loader = makeChildLoader(new Map([["slice:s", [w1]]]));

    const impact = computeImpactCascade({
      unit: slice,
      abandonedIds: ["TC3"],
      loadChildren: loader,
    });
    expect(impact.aborted).toEqual(["wave:w1"]);
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

// ═══════════════════════════════════════════════════════════════
// abandonedParentItems 端到端（真实 store + loadChildrenAsWorkUnitBase）
// ═══════════════════════════════════════════════════════════════
//
// 防回归：C1 bug 是 handleReplanSlice 用的 loadChildrenAsWorkUnitBase 映射器曾遗漏
// abandonedParentItems 字段——纯函数测试（上方 wub() stub 直接注入字段）测不出，
// 必须用真实 store + 真实 handler 写入 + 真实映射器读取才能覆盖端到端路径。
//
// 链路：wave plan input 声明脱离 parent 条目 → slice replan 废弃该条目 → 级联 abort 时
// 该 wave 应被 preserved（例外生效），而不是被 abort。

describe("abandonedParentItems 端到端（真实 store + loadChildrenAsWorkUnitBase）", () => {
  it("wave 先 plan 声明脱离 TC1 → slice replan 废弃 TC1 → 该 wave 被 preserved（不是 aborted）", () => {
    // 1. 建 slice（design-reviewed 状态，含 TechChoice TC1 from makeValidSlicePlan）
    const slice = setupToSliceDesignReviewed(env.deps, "e2e-abandon");
    const sliceId = slice.id;

    // 2. 建 child wave：parentUnitId 指向 slice + basedOnParent 含 TC1（承接 slice 的 TC1）
    const wave = createWave({
      slug: "e2e-child-wave",
      objective: "child wave that declares abandoning TC1",
      parentUnitId: sliceId,
      basedOnParent: ["TC1"],
      createdAt: "2026-07-22T00:00:00.000Z",
    });
    env.store.save(wave as unknown as WorkUnitRecord);
    const waveId = wave.id;

    // 前置：wave 已落盘 + basedOnParent 含 TC1 + abandonedParentItems 初始空
    const waveBefore = env.store.load(waveId)!;
    expect((waveBefore as unknown as { basedOnParent: string[] }).basedOnParent).toContain("TC1");
    expect((waveBefore as unknown as { abandonedParentItems: string[] }).abandonedParentItems).toEqual([]);

    // 3. wave 先 plan 声明脱离 TC1（plan input 带 abandonParentItems: ["TC1"]）
    //    经 mergeAbandonParentItems 写入 wave.abandonedParentItems。
    //    wave 必须在 plan.from ∈ {clarifying, planning, design-reviewed} 才合法——
    //    createWave 初始 created，先 handleClarify 推进到 clarifying，再 handlePlan。
    handleClarify(wave, { clarifications: [] }, env.deps);
    handlePlan(
      wave,
      {
        testCases: [makeValidTestCase()],
        tasks: [makeValidTask()],
        files: [makeValidFile()],
        contracts: [makeValidContract()],
        abandonParentItems: ["TC1"],
      },
      env.deps,
    );

    // 验证 wave.abandonedParentItems 已落盘含 TC1（端到端真实写入路径）
    const waveDeclared = env.store.load(waveId)!;
    expect((waveDeclared as unknown as { abandonedParentItems: string[] }).abandonedParentItems).toEqual(["TC1"]);

    // 4. slice replan 废弃 TC1（真实 handleReplanSlice → computeImpactCascade
    //    → loadChildrenAsWorkUnitBase 从 store 读 wave 并映射）
    const result = handleReplanSlice(
      slice,
      { abandonedIds: ["TC1"], note: "TC1 obsolete, verify wave preserved" },
      env.deps,
    );

    // 5. 断言：例外生效——wave 被 preserved，不被 abort
    expect(result.ok).toBe(true);
    expect(result.replanImpact!.preserved).toContain(waveId);
    expect(result.replanImpact!.aborted).not.toContain(waveId);

    // wave status 保持不变（未被 cascadeAbortUnit 触及）
    const waveAfter = env.store.load(waveId)!;
    expect((waveAfter as unknown as { status: string }).status).not.toBe("aborted");
    // wave.abandonedRefs 不应被追加 TC1（没被级联 abort）
    const abandonedRefs = (waveAfter as unknown as { abandonedRefs: Array<{ workUnitItemId: string }> }).abandonedRefs;
    expect(abandonedRefs.some((r) => r.workUnitItemId === "TC1")).toBe(false);
  });

  it("wave 未声明脱离 TC1 → slice replan 废弃 TC1 → 该 wave 被 abort（对照组）", () => {
    // 对照组：同样的 setup，但 wave 不声明 abandonParentItems → 正常被级联 abort。
    // 验证上一条用例的 preserved 不是「巧合永远 preserved」，而是例外真正生效。
    const slice = setupToSliceDesignReviewed(env.deps, "e2e-abandon-ctrl");
    const sliceId = slice.id;

    const wave = createWave({
      slug: "e2e-child-wave-ctrl",
      objective: "child wave that does NOT declare abandoning",
      parentUnitId: sliceId,
      basedOnParent: ["TC1"],
      createdAt: "2026-07-22T00:00:00.000Z",
    });
    env.store.save(wave as unknown as WorkUnitRecord);
    const waveId = wave.id;

    // wave plan 不带 abandonParentItems
    handleClarify(wave, { clarifications: [] }, env.deps);
    handlePlan(
      wave,
      {
        testCases: [makeValidTestCase()],
        tasks: [makeValidTask()],
        files: [makeValidFile()],
        contracts: [makeValidContract()],
      },
      env.deps,
    );
    // 确认 abandonedParentItems 仍空（未声明脱离）
    const waveDeclared = env.store.load(waveId)!;
    expect((waveDeclared as unknown as { abandonedParentItems: string[] }).abandonedParentItems).toEqual([]);

    const result = handleReplanSlice(
      slice,
      { abandonedIds: ["TC1"], note: "TC1 obsolete, control group" },
      env.deps,
    );

    // 对照：未声明脱离 → 正常被 abort
    expect(result.ok).toBe(true);
    expect(result.replanImpact!.aborted).toContain(waveId);
    expect(result.replanImpact!.preserved).not.toContain(waveId);

    const waveAfter = env.store.load(waveId)!;
    expect((waveAfter as unknown as { status: string }).status).toBe("aborted");
  });
});

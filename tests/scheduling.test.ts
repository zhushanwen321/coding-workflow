/**
 * computeReadyChildren 纯函数单测（core/scheduling.ts）。
 *
 * 覆盖设计文档 §3.1.2 算法的所有分支：
 *   - 无依赖 child 全就绪
 *   - 依赖未终态 → 阻塞
 *   - 依赖终态 → 就绪（被依赖方跳过）
 *   - 全终态 → 空集
 *   - parent 不存在 → 空数组（不 throw）
 *   - slug 失配 → 过滤
 *   - progressive 场景（child status 不同 → action 不同）
 *   - slice→wave 场景（查 WAVE_STATUS_TO_ACTION）
 *
 * 零 mock 框架——computeReadyChildren 只需 store.load，构造内存对象 stub 即可
 *（{ load: (id) => records[id] ?? null }，非 mock 框架，只是普通对象）。
 */
import { describe, expect, it } from "vitest";

import type { ChildDeliveryRecord } from "../src/core/evidence.js";
import type { Split } from "../src/core/plan.js";
import type { SchedulingStore } from "../src/core/scheduling.js";
import { computeReadyChildren } from "../src/core/scheduling.js";
import type { WorkUnitRecord } from "../src/store/schema.js";

// ═══════════════════════════════════════════════════════════════
// 测试 helpers
// ═══════════════════════════════════════════════════════════════

/** 构造内存 store：load 命中 records[id]，否则 null。 */
function makeStore(records: Record<string, WorkUnitRecord>): SchedulingStore {
  return { load: (id) => records[id] ?? null };
}

/** 构造一条 wave record（status 指定，scope=wave）。 */
function wave(id: string, status: string, parentUnitId?: string): WorkUnitRecord {
  return parentUnitId !== undefined
    ? { id, scope: "wave", status, parentUnitId }
    : { id, scope: "wave", status };
}

/**
 * 构造一条 parent slice record（scope=slice），含 plan.split + evidence.childDelivery。
 * slugToChildId 提供 splitSlug → childUnitId 映射，自动生成 childDelivery。
 */
function sliceParent(
  id: string,
  splits: Split[],
  slugToChildId: Record<string, string>,
  status = "executing",
): WorkUnitRecord {
  const childDelivery: ChildDeliveryRecord[] = Object.entries(slugToChildId).map(
    ([splitSlug, childUnitId]) => ({
      splitSlug,
      childUnitId,
      childStatus: "pending" as const,
    }),
  );
  return {
    id,
    scope: "slice",
    status,
    plan: { split: splits },
    evidence: { childDelivery },
  };
}

/** 构造一条 parent feature record（scope=feature），plan.split 拆 child slice。 */
function featureParent(
  id: string,
  splits: Split[],
  slugToChildId: Record<string, string>,
  status = "executing",
): WorkUnitRecord {
  const childDelivery: ChildDeliveryRecord[] = Object.entries(slugToChildId).map(
    ([splitSlug, childUnitId]) => ({
      splitSlug,
      childUnitId,
      childStatus: "pending" as const,
    }),
  );
  return {
    id,
    scope: "feature",
    status,
    plan: { split: splits },
    evidence: { childDelivery },
  };
}

// ═══════════════════════════════════════════════════════════════
// 用例
// ═══════════════════════════════════════════════════════════════

describe("computeReadyChildren", () => {
  it("无依赖的 3 child（全 created）→ 全就绪（3 个 ReadyTarget，action=clarify）", () => {
    const splits: Split[] = [
      { slug: "w1", description: "d1", dependsOn: [], inheritedItemIds: [] },
      { slug: "w2", description: "d2", dependsOn: [], inheritedItemIds: [] },
      { slug: "w3", description: "d3", dependsOn: [], inheritedItemIds: [] },
    ];
    const parent = sliceParent("slice:r", splits, {
      w1: "wave:r::w1",
      w2: "wave:r::w2",
      w3: "wave:r::w3",
    });
    const store = makeStore({
      "slice:r": parent,
      "wave:r::w1": wave("wave:r::w1", "created", "slice:r"),
      "wave:r::w2": wave("wave:r::w2", "created", "slice:r"),
      "wave:r::w3": wave("wave:r::w3", "created", "slice:r"),
    });

    const ready = computeReadyChildren("slice:r", store);

    expect(ready).toEqual([
      { unitId: "wave:r::w1", action: "clarify", satisfiedDependencies: [] },
      { unitId: "wave:r::w2", action: "clarify", satisfiedDependencies: [] },
      { unitId: "wave:r::w3", action: "clarify", satisfiedDependencies: [] },
    ]);
  });

  it("A dependsOn B，B 未终态 → A 阻塞，B 就绪（返回 [B]）", () => {
    const splits: Split[] = [
      { slug: "a", description: "da", dependsOn: ["b"], inheritedItemIds: [] },
      { slug: "b", description: "db", dependsOn: [], inheritedItemIds: [] },
    ];
    const parent = sliceParent("slice:r", splits, {
      a: "wave:r::a",
      b: "wave:r::b",
    });
    const store = makeStore({
      "slice:r": parent,
      "wave:r::a": wave("wave:r::a", "created", "slice:r"),
      "wave:r::b": wave("wave:r::b", "created", "slice:r"),
    });

    const ready = computeReadyChildren("slice:r", store);

    // 仅 B 就绪（A 的依赖 B 未终态 → A 阻塞）；按 split 声明顺序，B 排第二但 A 被过滤
    expect(ready).toEqual([
      { unitId: "wave:r::b", action: "clarify", satisfiedDependencies: [] },
    ]);
  });

  it("A dependsOn B，B closed → A 就绪，B 跳过（返回 [A]，satisfiedDependencies=[B]）", () => {
    const splits: Split[] = [
      { slug: "a", description: "da", dependsOn: ["b"], inheritedItemIds: [] },
      { slug: "b", description: "db", dependsOn: [], inheritedItemIds: [] },
    ];
    const parent = sliceParent("slice:r", splits, {
      a: "wave:r::a",
      b: "wave:r::b",
    });
    const store = makeStore({
      "slice:r": parent,
      "wave:r::a": wave("wave:r::a", "created", "slice:r"),
      "wave:r::b": wave("wave:r::b", "closed", "slice:r"), // B 终态
    });

    const ready = computeReadyChildren("slice:r", store);

    // A 依赖 B 已终态 → A 就绪；B 终态 → 跳过
    expect(ready).toEqual([
      {
        unitId: "wave:r::a",
        action: "clarify",
        satisfiedDependencies: ["wave:r::b"],
      },
    ]);
  });

  it("所有 child 终态 → 空集", () => {
    const splits: Split[] = [
      { slug: "w1", description: "d1", dependsOn: [], inheritedItemIds: [] },
      { slug: "w2", description: "d2", dependsOn: [], inheritedItemIds: [] },
    ];
    const parent = sliceParent("slice:r", splits, {
      w1: "wave:r::w1",
      w2: "wave:r::w2",
    });
    const store = makeStore({
      "slice:r": parent,
      "wave:r::w1": wave("wave:r::w1", "closed", "slice:r"),
      "wave:r::w2": wave("wave:r::w2", "aborted", "slice:r"),
    });

    const ready = computeReadyChildren("slice:r", store);

    expect(ready).toEqual([]);
  });

  it("parent 不存在（load 返回 null）→ 空数组（不 throw）", () => {
    const store = makeStore({}); // 空 store

    const ready = computeReadyChildren("slice:orphan", store);

    expect(ready).toEqual([]);
  });

  it("slug 失配（split.slug 在 childDelivery 无匹配）→ 过滤掉", () => {
    const splits: Split[] = [
      { slug: "w1", description: "d1", dependsOn: [], inheritedItemIds: [] },
      { slug: "w2", description: "d2", dependsOn: [], inheritedItemIds: [] }, // w2 在 childDelivery 无匹配
    ];
    // childDelivery 只覆盖 w1（w2 失配 → childUnitId=undefined → 被过滤）
    const parent = sliceParent("slice:r", splits, { w1: "wave:r::w1" });
    const store = makeStore({
      "slice:r": parent,
      "wave:r::w1": wave("wave:r::w1", "created", "slice:r"),
    });

    const ready = computeReadyChildren("slice:r", store);

    // 只有 w1 就绪，w2 因 slug 失配被过滤
    expect(ready).toEqual([
      { unitId: "wave:r::w1", action: "clarify", satisfiedDependencies: [] },
    ]);
  });

  it("progressive 场景：child 部分推进（created→clarify，planning→plan）", () => {
    const splits: Split[] = [
      { slug: "w1", description: "d1", dependsOn: [], inheritedItemIds: [] },
      { slug: "w2", description: "d2", dependsOn: [], inheritedItemIds: [] },
    ];
    const parent = sliceParent("slice:r", splits, {
      w1: "wave:r::w1",
      w2: "wave:r::w2",
    });
    const store = makeStore({
      "slice:r": parent,
      "wave:r::w1": wave("wave:r::w1", "created", "slice:r"), // → clarify
      "wave:r::w2": wave("wave:r::w2", "planning", "slice:r"), // → plan
    });

    const ready = computeReadyChildren("slice:r", store);

    expect(ready).toEqual([
      { unitId: "wave:r::w1", action: "clarify", satisfiedDependencies: [] },
      { unitId: "wave:r::w2", action: "plan", satisfiedDependencies: [] },
    ]);
  });

  it("slice→wave 场景：parent scope=slice，child 查 WAVE_STATUS_TO_ACTION", () => {
    // slice 的 child 是 wave，status=executing → action=test（WAVE 表特有，PLANNING 表 executing→retrospect）
    const splits: Split[] = [
      { slug: "w1", description: "d1", dependsOn: [], inheritedItemIds: [] },
    ];
    const parent = sliceParent("slice:r", splits, { w1: "wave:r::w1" });
    const store = makeStore({
      "slice:r": parent,
      "wave:r::w1": wave("wave:r::w1", "executing", "slice:r"),
    });

    const ready = computeReadyChildren("slice:r", store);

    // wave 的 executing → test（非 planning 的 retrospect），证明查的是 WAVE_STATUS_TO_ACTION
    expect(ready).toEqual([
      { unitId: "wave:r::w1", action: "test", satisfiedDependencies: [] },
    ]);
  });

  it("feature→slice 场景：parent scope=feature，child slice 查 PLANNING_STATUS_TO_ACTION", () => {
    // feature 的 child 是 slice，status=executing → action=retrospect（PLANNING 表，区别于 wave 的 test）
    const splits: Split[] = [
      { slug: "s1", description: "d1", dependsOn: [], inheritedItemIds: [] },
    ];
    const parent = featureParent("feature:r", splits, { s1: "slice:r::s1" });
    const store = makeStore({
      "feature:r": parent,
      "slice:r::s1": { id: "slice:r::s1", scope: "slice", status: "executing", parentUnitId: "feature:r" },
    });

    const ready = computeReadyChildren("feature:r", store);

    expect(ready).toEqual([
      { unitId: "slice:r::s1", action: "retrospect", satisfiedDependencies: [] },
    ]);
  });

  it("依赖链：C dependsOn B dependsOn A，A 终态、B 未终态 → 仅 A(终态跳过)，B/C 都阻塞 → 空", () => {
    const splits: Split[] = [
      { slug: "a", description: "da", dependsOn: [], inheritedItemIds: [] },
      { slug: "b", description: "db", dependsOn: ["a"], inheritedItemIds: [] },
      { slug: "c", description: "dc", dependsOn: ["b"], inheritedItemIds: [] },
    ];
    const parent = sliceParent("slice:r", splits, {
      a: "wave:r::a",
      b: "wave:r::b",
      c: "wave:r::c",
    });
    const store = makeStore({
      "slice:r": parent,
      "wave:r::a": wave("wave:r::a", "closed", "slice:r"), // A 终态
      "wave:r::b": wave("wave:r::b", "created", "slice:r"), // B 未终态
      "wave:r::c": wave("wave:r::c", "created", "slice:r"), // C 未终态
    });

    const ready = computeReadyChildren("slice:r", store);

    // A 终态跳过；B 依赖 A(终态) → 就绪；C 依赖 B(未终态) → 阻塞
    expect(ready).toEqual([
      { unitId: "wave:r::b", action: "clarify", satisfiedDependencies: ["wave:r::a"] },
    ]);
  });
});

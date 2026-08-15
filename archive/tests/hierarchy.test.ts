/**
 * resolveChildDependsOn 纯函数单测（core/hierarchy.ts）。
 *
 * 覆盖 S1 修复：slug 失配时返回 childUnitId: undefined（而非空串），
 * 让调用方显式过滤失配项。
 *
 * 零 mock——纯函数，直接传结构化参数。
 */
import { describe, expect, it } from "vitest";

import type { ChildDeliveryRecord } from "../src/core/evidence.js";
import { isDependencySatisfied, resolveChildDependsOn } from "../src/core/hierarchy.js";
import type { Split } from "../src/core/plan.js";
import type { WorkUnitRecord } from "../src/store/schema.js";

describe("resolveChildDependsOn", () => {
  it("split.slug 与 childDelivery 匹配 → 返回 childUnitId + dependsOn（childUnitId 列表）", () => {
    const splits: Split[] = [
      { slug: "w1", description: "d1", dependsOn: [], inheritedItemIds: [] },
      { slug: "w2", description: "d2", dependsOn: ["w1"], inheritedItemIds: [] },
    ];
    const delivery: ChildDeliveryRecord[] = [
      { splitSlug: "w1", childUnitId: "wave:r::w1", childStatus: "pending" },
      { splitSlug: "w2", childUnitId: "wave:r::w2", childStatus: "pending" },
    ];

    const result = resolveChildDependsOn(splits, delivery);

    expect(result).toEqual([
      { childUnitId: "wave:r::w1", dependsOn: [] },
      { childUnitId: "wave:r::w2", dependsOn: ["wave:r::w1"] },
    ]);
  });

  it("S1：slug 失配 → childUnitId 为 undefined（而非空串）", () => {
    // split 有 w3，但 childDelivery 只覆盖 w1/w2（w3 失配）
    const splits: Split[] = [
      { slug: "w1", description: "d1", dependsOn: [], inheritedItemIds: [] },
      { slug: "w3", description: "d3", dependsOn: ["w1"], inheritedItemIds: [] },
    ];
    const delivery: ChildDeliveryRecord[] = [
      { splitSlug: "w1", childUnitId: "wave:r::w1", childStatus: "pending" },
      // w3 无对应 childDelivery 记录
    ];

    const result = resolveChildDependsOn(splits, delivery);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ childUnitId: "wave:r::w1", dependsOn: [] });
    // S1 核心断言：失配返回 undefined，不是 ""
    expect(result[1]!.childUnitId).toBeUndefined();
    // dependsOn 仍尝试映射，w1 能映射成功
    expect(result[1]!.dependsOn).toEqual(["wave:r::w1"]);
  });

  it("childDelivery 为空 → 所有 childUnitId 为 undefined，dependsOn 全空", () => {
    const splits: Split[] = [
      { slug: "w1", description: "d1", dependsOn: ["w2"], inheritedItemIds: [] },
    ];
    const delivery: ChildDeliveryRecord[] = [];

    const result = resolveChildDependsOn(splits, delivery);

    expect(result).toEqual([{ childUnitId: undefined, dependsOn: [] }]);
  });

  it("dependsOn 引用的 slug 在 childDelivery 中失配 → 该 dep 被过滤（不出 undefined）", () => {
    const splits: Split[] = [
      { slug: "w1", description: "d1", dependsOn: ["w2"], inheritedItemIds: [] },
    ];
    const delivery: ChildDeliveryRecord[] = [
      { splitSlug: "w1", childUnitId: "wave:r::w1", childStatus: "pending" },
      // w2 无对应 childDelivery（w2 甚至不在 splits 里，模拟孤儿依赖）
    ];

    const result = resolveChildDependsOn(splits, delivery);

    expect(result[0]).toEqual({ childUnitId: "wave:r::w1", dependsOn: [] });
  });
});

// ═══════════════════════════════════════════════════════════════
// isDependencySatisfied — 依赖全终态判定（共享函数，§5.2）
// ═══════════════════════════════════════════════════════════════

/** 构造最小内存 store：load 命中 records[id]，否则 null。非 mock 框架，只是内存对象。 */
function makeStore(records: Record<string, WorkUnitRecord>): {
  load: (id: string) => WorkUnitRecord | null;
} {
  return { load: (id) => records[id] ?? null };
}

/** 构造一条 status 指定的最小 record。 */
function rec(id: string, status: string): WorkUnitRecord {
  return { id, scope: "wave", status };
}

describe("isDependencySatisfied", () => {
  it("空 dependsOn → true（无依赖即满足）", () => {
    const store = makeStore({});
    expect(isDependencySatisfied([], store)).toBe(true);
  });

  it("依赖全部 closed → true", () => {
    const store = makeStore({
      "wave:a": rec("wave:a", "closed"),
      "wave:b": rec("wave:b", "closed"),
    });
    expect(isDependencySatisfied(["wave:a", "wave:b"], store)).toBe(true);
  });

  it("依赖全部 aborted（也是终态）→ true", () => {
    const store = makeStore({
      "wave:a": rec("wave:a", "aborted"),
    });
    expect(isDependencySatisfied(["wave:a"], store)).toBe(true);
  });

  it("依赖含非终态（created）→ false", () => {
    const store = makeStore({
      "wave:a": rec("wave:a", "closed"),
      "wave:b": rec("wave:b", "created"),
    });
    expect(isDependencySatisfied(["wave:a", "wave:b"], store)).toBe(false);
  });

  it("依赖 load 不到（null，不在 store）→ false", () => {
    const store = makeStore({});
    expect(isDependencySatisfied(["wave:missing"], store)).toBe(false);
  });

  it("部分依赖 load 不到 → false（任一 null 即不满足）", () => {
    const store = makeStore({ "wave:a": rec("wave:a", "closed") });
    expect(isDependencySatisfied(["wave:a", "wave:missing"], store)).toBe(false);
  });

  it("status 字段非 string（脏数据）→ 视为非终态 → false", () => {
    const store = makeStore({ "wave:a": { id: "wave:a", scope: "wave", status: 123 } });
    expect(isDependencySatisfied(["wave:a"], store)).toBe(false);
  });
});

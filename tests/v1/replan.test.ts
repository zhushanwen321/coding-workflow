/**
 * v1 wave replan 影响面计算测试（U15）。
 *
 * computeImpact(allUnits, abandonedIds) 纯函数：
 * - 命中规则：unit.basedOnParent 含废弃条目 → aborted
 * - 未命中 → preserved
 * - pendingRebuild：废弃条目里没有 preserved unit 再引用的（失去承接）
 *
 * wave 叶子（无子孙）→ 影响面通常空；构造带 basedOnParent 的 unit → 非空。
 * 对应 test.json U15。
 */
import { describe, expect,it } from "vitest";

import type { ExecutionUnit } from "../../src/v1/core/workunit.js";
import { createWave } from "../../src/v1/core/workunit.js";
import { computeImpact } from "../../src/v1/rules/replan.js";

function wave(slug: string, basedOnParent: string[] = []): ExecutionUnit {
  return createWave({
    slug,
    objective: "o",
    parentUnitId: "slice:s",
    basedOnParent,
  });
}

describe("U15: computeImpact 影响面计算", () => {
  it("wave 叶子（无子孙，basedOnParent 不含废弃条目）→ aborted 为空", () => {
    const leaf = wave("leaf", ["TC1"]); // 基于 TC1，但 TC1 不在 abandonedIds
    const impact = computeImpact([leaf], ["OTHER"]);
    expect(impact.aborted).toEqual([]);
    expect(impact.preserved).toEqual(["wave:leaf"]);
    // "OTHER" 没有任何 preserved unit 引用 → pendingRebuild
    expect(impact.pendingRebuild).toEqual(["OTHER"]);
  });

  it("构造带 basedOnParent 的 unit + 废弃匹配的 id → aborted 非空", () => {
    const dependent = wave("dep", ["TC1", "TK1"]); // 命中 TC1
    const independent = wave("indep", ["TK2"]); // 不命中
    const impact = computeImpact([dependent, independent], ["TC1"]);
    expect(impact.aborted).toEqual(["wave:dep"]);
    expect(impact.preserved).toEqual(["wave:indep"]);
    // TC1 被 aborted unit 引用（失去承接，无 preserved 引用）→ pendingRebuild
    expect(impact.pendingRebuild).toEqual(["TC1"]);
  });

  it("多 unit 命中同一废弃条目 → 都进 aborted", () => {
    const u1 = wave("u1", ["TC1"]);
    const u2 = wave("u2", ["TC1"]);
    const u3 = wave("u3", ["TK1"]);
    const impact = computeImpact([u1, u2, u3], ["TC1"]);
    expect(impact.aborted).toEqual(["wave:u1", "wave:u2"]);
    expect(impact.preserved).toEqual(["wave:u3"]);
  });

  it("引用废弃条目的 unit 都进 aborted（结构上 pendingRebuild = abandonedIds）", () => {
    // 算法（replan.ts Step 1-2）：unit.basedOnParent 命中 abandonedIds 即 aborted。
    // 故 preserved unit 的 basedOnParent 不含任何废弃 id，preservedRefs 也不含废弃 id，
    // pendingRebuild = abandonedIds.filter(id => !preservedRefs.has(id)) 恒等于 abandonedIds。
    const aborted = wave("a", ["TC1"]);
    const alsoAborted = wave("p", ["TC1", "TC2"]); // 引用 TC1 → 也 aborted（非 preserved）
    const impact = computeImpact([aborted, alsoAborted], ["TC1"]);
    expect(impact.aborted).toEqual(["wave:a", "wave:p"]);
    expect(impact.preserved).toEqual([]);
    // pendingRebuild = abandonedIds（无 preserved unit 引用任何废弃 id）
    expect(impact.pendingRebuild).toEqual(["TC1"]);
  });

  it("空 abandonedIds → 全部 preserved，pendingRebuild 为空", () => {
    const u1 = wave("u1", ["TC1"]);
    const u2 = wave("u2", []);
    const impact = computeImpact([u1, u2], []);
    expect(impact.aborted).toEqual([]);
    expect(impact.preserved).toEqual(["wave:u1", "wave:u2"]);
    expect(impact.pendingRebuild).toEqual([]);
  });

  it("空 allUnits → 全部为空", () => {
    const impact = computeImpact([], ["TC1"]);
    expect(impact.aborted).toEqual([]);
    expect(impact.preserved).toEqual([]);
    expect(impact.pendingRebuild).toEqual(["TC1"]);
  });
});

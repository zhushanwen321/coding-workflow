/**
 * ADR-0010 跨层跨时机 abandon parent items 声明通道测试。
 *
 * 覆盖核心契约：plan/replan input 的 abandonParentItems 字段被正确 append-only 合并到
 * unit.abandonedParentItems（model §5.6.6）。
 *
 * 三部分：
 * 1. mergeAbandonParentItems 纯函数（单元）：空 input / 单 id / 多 id / 去重 / undefined 安全
 * 2. plan handler 集成：slice plan（PlanningUnit 代表）+ wave plan 通过 input 写入
 * 3. replan handler 集成：slice replan + wave replan 通过 input 写入
 *
 * trailer 通道（wave execute 解析 commit message）由 parse-abandon-markers.test.ts 覆盖，
 * 本文件不重复。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mergeAbandonParentItems } from "../../src/handlers/internal.js";
import { handlePlan } from "../../src/handlers/plan.js";
import { handleReplan } from "../../src/handlers/replan.js";
import { handlePlanSlice } from "../../src/handlers/slice/plan.js";
import { handleReplanSlice } from "../../src/handlers/slice/replan.js";
import {
  makeValidSlicePlan,
  setupToSliceDesignReviewed,
} from "./helpers/slice-env.js";
import { createV1Env, makeValidContract, makeValidFile, makeValidTask, makeValidTestCase, makeWaveUnit, type V1Env } from "./helpers/v1-env.js";

let env: V1Env;

beforeEach(() => {
  env = createV1Env();
});

afterEach(() => {
  env.cleanup();
});

// ═══════════════════════════════════════════════════════════════
// Part 1: mergeAbandonParentItems 纯函数
// ═══════════════════════════════════════════════════════════════

describe("mergeAbandonParentItems 纯函数", () => {
  it("input 无 abandonParentItems → no-op（unit 不变）", () => {
    const unit: { abandonedParentItems?: string[] } = { abandonedParentItems: ["TC1"] };
    mergeAbandonParentItems(unit, {});
    expect(unit.abandonedParentItems).toEqual(["TC1"]);
  });

  it("input.abandonParentItems = [] → no-op（空数组不触发合并）", () => {
    const unit: { abandonedParentItems?: string[] } = { abandonedParentItems: ["TC1"] };
    mergeAbandonParentItems(unit, { abandonParentItems: [] });
    expect(unit.abandonedParentItems).toEqual(["TC1"]);
  });

  it("input.abandonParentItems = ['TC2'] → 追加到现有 ['TC1']", () => {
    const unit: { abandonedParentItems?: string[] } = { abandonedParentItems: ["TC1"] };
    mergeAbandonParentItems(unit, { abandonParentItems: ["TC2"] });
    expect(unit.abandonedParentItems).toEqual(["TC1", "TC2"]);
  });

  it("重复 id 去重（input 含已有 id）", () => {
    const unit: { abandonedParentItems?: string[] } = { abandonedParentItems: ["TC1"] };
    mergeAbandonParentItems(unit, { abandonParentItems: ["TC1", "TC2"] });
    expect(unit.abandonedParentItems).toEqual(["TC1", "TC2"]);
  });

  it("unit.abandonedParentItems 初始 undefined → 首次写入", () => {
    const unit: { abandonedParentItems?: string[] } = {};
    mergeAbandonParentItems(unit, { abandonParentItems: ["TC1", "TC2"] });
    expect(unit.abandonedParentItems).toEqual(["TC1", "TC2"]);
  });

  it("多次调用累积合并（append-only 语义）", () => {
    const unit: { abandonedParentItems?: string[] } = {};
    mergeAbandonParentItems(unit, { abandonParentItems: ["TC1"] });
    mergeAbandonParentItems(unit, { abandonParentItems: ["TC2"] });
    mergeAbandonParentItems(unit, { abandonParentItems: ["TC3", "TC1"] });
    expect(unit.abandonedParentItems).toEqual(["TC1", "TC2", "TC3"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 2: plan handler 集成
// ═══════════════════════════════════════════════════════════════

describe("plan handler 通过 input 写入 abandonedParentItems", () => {
  it("slice plan input 带 abandonParentItems → unit.abandonedParentItems 被写入", () => {
    const slice = setupToSliceDesignReviewed(env.deps);
    // 先 design-review 通过后回 planning 才能 plan progressive（slice plan from 含 design-reviewed）
    const planInput = {
      ...makeValidSlicePlan(),
      abandonParentItems: ["FR1", "AC2"],
    };

    handlePlanSlice(slice, planInput, env.deps);

    const reloaded = env.deps.store.load(slice.id);
    expect(reloaded?.abandonedParentItems).toEqual(["FR1", "AC2"]);
  });

  it("wave plan input 带 abandonParentItems → unit.abandonedParentItems 被写入", () => {
    // wave plan 需要一个 ExecutionUnit，直接用 helper 构造后 save
    const w = makeWaveUnit("test-wave");
    w.status = "planning";
    env.deps.store.save(w);

    handlePlan(
      w,
      {
        testCases: [makeValidTestCase("TC1")],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
        abandonParentItems: ["TC-slice-1"],
      },
      env.deps,
    );

    const reloaded = env.deps.store.load(w.id);
    expect(reloaded?.abandonedParentItems).toEqual(["TC-slice-1"]);
  });

  it("slice plan 不带 abandonParentItems → unit.abandonedParentItems 保持 [] （工厂初始化值）", () => {
    const slice = setupToSliceDesignReviewed(env.deps);
    const planInput = makeValidSlicePlan();

    handlePlanSlice(slice, planInput, env.deps);

    const reloaded = env.deps.store.load(slice.id);
    expect(reloaded?.abandonedParentItems).toEqual([]);
  });

  it("多次 plan progressive → abandonParentItems append-only 累积", () => {
    const slice = setupToSliceDesignReviewed(env.deps);

    // 第一次 plan 声明脱离 FR1
    handlePlanSlice(
      slice,
      { ...makeValidSlicePlan(), abandonParentItems: ["FR1"] },
      env.deps,
    );
    let reloaded = env.deps.store.load(slice.id);
    expect(reloaded?.abandonedParentItems).toEqual(["FR1"]);

    // 第二次 plan progressive 再声明脱离 AC2 + FR1（去重）
    const reloadedSlice = env.deps.store.load(slice.id) as unknown as Parameters<typeof handlePlanSlice>[0];
    handlePlanSlice(
      reloadedSlice,
      { ...makeValidSlicePlan(), abandonParentItems: ["AC2", "FR1"] },
      env.deps,
    );
    reloaded = env.deps.store.load(slice.id);
    expect(reloaded?.abandonedParentItems).toEqual(["FR1", "AC2"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 3: replan handler 集成
// ═══════════════════════════════════════════════════════════════

describe("replan handler 通过 input 写入 abandonedParentItems", () => {
  it("slice replan input 带 abandonParentItems → unit.abandonedParentItems 被写入", () => {
    const slice = setupToSliceDesignReviewed(env.deps);

    handleReplanSlice(
      slice,
      {
        abandonedIds: ["TC1"],
        note: "测试 replan 声明脱离",
        abandonParentItems: ["FR-parent-1"],
      },
      env.deps,
    );

    const reloaded = env.deps.store.load(slice.id);
    expect(reloaded?.abandonedParentItems).toEqual(["FR-parent-1"]);
  });

  it("wave replan input 带 abandonParentItems → unit.abandonedParentItems 被写入", () => {
    const w = makeWaveUnit("test-wave");
    w.status = "design-reviewed";
    // wave replan 需要 plan 有条目可废弃
    w.plan = {
      split: [],
      testCases: [{ ...makeValidTestCase("TC1"), status: "active" as const }],
      tasks: [],
      files: [],
      contracts: [],
    };
    env.deps.store.save(w);

    handleReplan(
      w,
      {
        abandonedIds: ["TC1"],
        note: "测试 wave replan 声明脱离",
        abandonParentItems: ["TC-slice-if1"],
      },
      env.deps,
    );

    const reloaded = env.deps.store.load(w.id);
    expect(reloaded?.abandonedParentItems).toEqual(["TC-slice-if1"]);
  });

  it("slice replan 不带 abandonParentItems → unit.abandonedParentItems 保持原值（不被清空）", () => {
    const slice = setupToSliceDesignReviewed(env.deps);
    // 预先有值（模拟之前 plan 阶段已声明）
    slice.abandonedParentItems = ["FR1"];
    env.deps.store.save(slice);

    handleReplanSlice(
      slice,
      { abandonedIds: ["TC1"], note: "无 abandonParentItems 的 replan" },
      env.deps,
    );

    const reloaded = env.deps.store.load(slice.id);
    expect(reloaded?.abandonedParentItems).toEqual(["FR1"]);
  });
});

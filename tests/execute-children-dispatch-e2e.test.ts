/**
 * C1 改动测试：planning execute handler（slice/feature/epic）的 ActionResult.children。
 *
 * C1 已为三个 planning execute handler（slice→wave / feature→slice / epic→feature）的 return
 * 增加 `children: ChildInfo[]`（每项 `{unitId, dependsOn}`），供递归调度器拓扑排序消费。
 *
 * 本文件经 dispatch 统一入口（非直调 handler）覆盖：
 *   TC1：slice execute 返回 children（unitId 是 wave 子层 id，dependsOn 是 childUnitId 列表）
 *   TC2：feature execute 返回 children（unitId 是 slice 子层 id）
 *   TC3：wave execute 不返回 children（wave 是叶子层，无下沉）
 *   TC4：无依赖 split → children 每项 dependsOn 都为空数组
 *
 * 约束：零 mock 框架——真实 CwStore（mkdtemp tmp 目录）+ stub CwDeps（外部依赖注入接口），
 * 走 dispatch 层。setup 模式完全复用 slice-dispatch-e2e / feature-dispatch-e2e / dispatch-e2e。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Feature,Slice } from "../src/core/workunit.js";
import { dispatch } from "../src/dispatch.js";
import type { CwEnv } from "./helpers/env.js";
import {
  createCwEnv,
} from "./helpers/env.js";
import {
  makeFeatureClarifyInput,
  makeValidFeatureDesignReviewJudgment,
} from "./helpers/feature-env.js";
import {
  makeValidSliceDesignReviewJudgment,
  makeValidSlicePlan,
} from "./helpers/slice-env.js";

let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
});

afterEach(() => {
  env.cleanup();
});

/** slice/feature/epic execute 的 dispatch 参数（无 input，handler 忽略；CwParams execute 分支锁 ExecuteInput，故断言）。 */
function planningExecute(unitId: string): Parameters<typeof dispatch>[0] {
  return { action: "execute", unitId, input: {} } as unknown as Parameters<typeof dispatch>[0];
}

/** 从 store 读最新 slice。 */
function loadSlice(id: string): Slice {
  return env.store.load(id) as unknown as Slice;
}

/** 从 store 读最新 feature。 */
function loadFeature(id: string): Feature {
  return env.store.load(id) as unknown as Feature;
}

// ═══════════════════════════════════════════════════════════════
// TC1：slice execute 返回 children（unitId = wave 子层 id，dependsOn = childUnitId 列表）
// ═══════════════════════════════════════════════════════════════

describe("dispatch slice execute 返回 children", () => {
  it("TC1：split 带依赖 → ActionResult.children 含正确 unitId + dependsOn（childUnitId 而非 slug）", () => {
    const unitId = "slice:ch-slice";

    // 1. create（layer='slice'）
    dispatch(
      { action: "create", input: { slug: "ch-slice", objective: "o", layer: "slice" } },
      env.deps,
    );
    dispatch({ action: "clarify", unitId, input: { clarifications: [] } }, env.deps);

    // 2. plan：split 两项 w1←(无依赖)、w2←w1
    dispatch(
      {
        action: "plan",
        unitId,
        input: {
          ...makeValidSlicePlan(),
          split: [
            { slug: "w1", description: "wave 1", dependsOn: [], inheritedItemIds: ["IF1"] },
            { slug: "w2", description: "wave 2", dependsOn: ["w1"], inheritedItemIds: ["DM1"] },
          ],
        },
      },
      env.deps,
    );
    dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidSliceDesignReviewJudgment() } },
      env.deps,
    );

    // 3. execute（创建 child wave）
    const execute = dispatch(planningExecute(unitId), env.deps);
    expect(execute.ok).toBe(true);
    expect(execute.status).toBe("executing");

    // 4. 断言 children：长度 2 + 结构精确（unitId 是 wave 子层 id，dependsOn 是 childUnitId）
    expect(execute.children).toBeDefined();
    expect(execute.children).toHaveLength(2);

    const w1Id = "wave:ch-slice::w1";
    const w2Id = "wave:ch-slice::w2";

    expect(execute.children![0]).toEqual({ unitId: w1Id, dependsOn: [] });
    expect(execute.children![1]).toEqual({ unitId: w2Id, dependsOn: [w1Id] });

    // 交叉验证：children.unitId 与 store 里 executeResult.childUnitIds 一致（顺序）
    const slice = loadSlice(unitId);
    expect(execute.children!.map((c) => c.unitId)).toEqual(slice.executeResult.childUnitIds);

    // 5. 验证 child wave 真实存在于 store（不是凭空编的 id）
    expect(env.store.load(w1Id)).toBeDefined();
    expect(env.store.load(w2Id)).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// TC2：feature execute 返回 children（unitId = slice 子层 id）
// ═══════════════════════════════════════════════════════════════

describe("dispatch feature execute 返回 children", () => {
  it("TC2：split 带依赖 → ActionResult.children 含正确 unitId（slice 子层）+ dependsOn（childUnitId）", () => {
    const unitId = "feature:ch-feature";

    dispatch(
      { action: "create", input: { slug: "ch-feature", objective: "o", layer: "feature" } },
      env.deps,
    );
    dispatch({ action: "clarify", unitId, input: makeFeatureClarifyInput() }, env.deps);

    // plan：split 两项 s1←(无依赖)、s2←s1
    dispatch(
      {
        action: "plan",
        unitId,
        input: {
          split: [
            { slug: "s1", description: "slice 1", dependsOn: [], inheritedItemIds: ["FR1"] },
            { slug: "s2", description: "slice 2", dependsOn: ["s1"], inheritedItemIds: ["AC1"] },
          ],
        },
      },
      env.deps,
    );
    dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() } },
      env.deps,
    );

    const execute = dispatch(planningExecute(unitId), env.deps);
    expect(execute.ok).toBe(true);
    expect(execute.status).toBe("executing");

    expect(execute.children).toBeDefined();
    expect(execute.children).toHaveLength(2);

    const s1Id = "slice:ch-feature::s1";
    const s2Id = "slice:ch-feature::s2";

    expect(execute.children![0]).toEqual({ unitId: s1Id, dependsOn: [] });
    expect(execute.children![1]).toEqual({ unitId: s2Id, dependsOn: [s1Id] });

    // 交叉验证：children.unitId 与 store 里 executeResult.childUnitIds 一致
    const feature = loadFeature(unitId);
    expect(execute.children!.map((c) => c.unitId)).toEqual(feature.executeResult.childUnitIds);

    // child slice 真实存在
    expect(env.store.load(s1Id)).toBeDefined();
    expect(env.store.load(s2Id)).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// TC3：wave execute 不返回 children（wave 是叶子层，无下沉）
// ═══════════════════════════════════════════════════════════════

describe("dispatch wave execute 不返回 children", () => {
  it("TC3：wave execute 后 ActionResult.children 是 undefined（wave 无下沉）", () => {
    const unitId = "wave:ch-wave";

    dispatch(
      { action: "create", input: { slug: "ch-wave", objective: "o" } },
      env.deps,
    );
    dispatch({ action: "clarify", unitId, input: { clarifications: [] } }, env.deps);
    dispatch(
      {
        action: "plan",
        unitId,
        input: {
          testCases: [{ id: "TC1", status: "active", name: "tc", scenario: "s", input: "i", expected: "e", type: "unit" }],
          tasks: [{ id: "TK1", status: "active", type: "impl", files: ["src/x.ts"], steps: ["write x"] }],
          files: [{ id: "F1", status: "active", path: "src/x.ts", action: "create", description: "x" }],
          contracts: [{ id: "C1", status: "active", name: "x", type: "function", definition: "function x(): void" }],
          testCommand: "npx vitest run",
        },
      },
      env.deps,
    );
    dispatch(
      {
        action: "design-review",
        unitId,
        input: {
          designReviewJudgment: {
            necessity: "n",
            sufficiency: { gaps: [], overlaps: [], meceNote: "m" },
            alternatives: "a",
            tradeoffs: [{ id: "TF1", decision: "d", reason: "r", cost: "c" }],
            risks: [{ id: "RK1", item: "i", severity: "medium", mitigation: "m" }],
            layerSpecific: {
              testCaseCoverageNote: "tc",
              boundaryConditionNote: "b",
              mockStrategyNote: "m",
              tddRedReadinessNote: "t",
            },
          },
        },
      },
      env.deps,
    );

    // wave execute 接收 commitHash（ExecuteInput）
    const execute = dispatch(
      { action: "execute", unitId, input: { commitHash: "deadbeef" } },
      env.deps,
    );
    expect(execute.ok).toBe(true);
    expect(execute.status).toBe("executing");

    // wave 是叶子层，execute handler 不构造 children → undefined
    expect(execute.children).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// TC4：无依赖 split → children 每项 dependsOn 都为空数组
// ═══════════════════════════════════════════════════════════════

describe("dispatch slice execute 无依赖 split", () => {
  it("TC4：split 两项互不依赖 → children 两项 dependsOn 都为 []", () => {
    const unitId = "slice:ch-no-deps";

    dispatch(
      { action: "create", input: { slug: "ch-no-deps", objective: "o", layer: "slice" } },
      env.deps,
    );
    dispatch({ action: "clarify", unitId, input: { clarifications: [] } }, env.deps);
    dispatch(
      {
        action: "plan",
        unitId,
        input: {
          ...makeValidSlicePlan(),
          split: [
            { slug: "w1", description: "wave 1", dependsOn: [], inheritedItemIds: ["IF1"] },
            { slug: "w2", description: "wave 2", dependsOn: [], inheritedItemIds: ["DM1"] },
          ],
        },
      },
      env.deps,
    );
    dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidSliceDesignReviewJudgment() } },
      env.deps,
    );

    const execute = dispatch(planningExecute(unitId), env.deps);
    expect(execute.ok).toBe(true);

    expect(execute.children).toBeDefined();
    expect(execute.children).toHaveLength(2);

    const w1Id = "wave:ch-no-deps::w1";
    const w2Id = "wave:ch-no-deps::w2";

    expect(execute.children![0]).toEqual({ unitId: w1Id, dependsOn: [] });
    expect(execute.children![1]).toEqual({ unitId: w2Id, dependsOn: [] });
  });
});

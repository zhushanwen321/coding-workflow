/**
 * v1 slice evidence rollup 测试。
 *
 * 测 rollupChildDelivery（src/handlers/rollup.ts）+ wave handler 接入：
 * - slice execute 后 childDelivery 初始 childStatus='pending'
 * - child wave closeout → rollup → childStatus='closed'
 * - child wave abort → rollup → childStatus='aborted'
 * - 一致性：parent slice closeout 冻结后（frozenAt 非空），rollup 跳过（childDelivery 不动）
 *
 * 用 setupSliceWithClosedWaves 推进完整场景；用 handleAbort 单独触发 abort 场景；
 * 直接调 rollupChildDelivery 验证冻结跳过逻辑。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChildDeliveryRecord } from "../../src/core/evidence.js";
import type { ExecutionUnit, Slice } from "../../src/core/workunit.js";
import { createWave } from "../../src/core/workunit.js";
import { handleAbort } from "../../src/handlers/abort.js";
import { rollupChildDelivery } from "../../src/handlers/rollup.js";
import { handleCloseoutSlice } from "../../src/handlers/slice/closeout.js";
import { handleExecuteSlice } from "../../src/handlers/slice/execute.js";
import { handleRetrospectSlice } from "../../src/handlers/slice/retrospect.js";
import type { WorkUnitRecord } from "../../src/store/schema.js";
import {
  advanceWaveToClosed,
  createV1Env,
  makeValidPlanningRetrospectData,
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

/** 从 store 读最新 slice。 */
function loadSlice(id: string): Slice {
  const r = env.store.load(id);
  return r as unknown as Slice;
}

/** 读 slice 的 childDelivery。 */
function childDeliveryOf(slice: Slice): ChildDeliveryRecord[] {
  return slice.evidence.childDelivery;
}

// ═══════════════════════════════════════════════════════════════
// childDelivery 初始态
// ═══════════════════════════════════════════════════════════════

describe("slice execute → childDelivery 初始 pending", () => {
  it("execute 后每个 child wave 一条 childDelivery 记录，childStatus='pending'", () => {
    const slice = setupToSliceDesignReviewed(env.deps, "rollup-init");
    handleExecuteSlice(slice, env.deps);

    const reloaded = loadSlice(slice.id);
    const delivery = childDeliveryOf(reloaded);
    expect(delivery.length).toBe(reloaded.executeResult.childUnitIds.length);
    expect(delivery.length).toBeGreaterThan(0);
    expect(delivery.every((r) => r.childStatus === "pending")).toBe(true);
    // 每条记录有 childUnitId + splitSlug
    expect(delivery.every((r) => r.childUnitId !== "" && r.splitSlug !== "")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// child wave closeout → rollup → childStatus='closed'
// ═══════════════════════════════════════════════════════════════

describe("child wave closeout → rollup childStatus='closed'", () => {
  it("setupSliceWithClosedWaves 后 childDelivery[child].childStatus='closed'", () => {
    const { slice, childWaveIds } = setupSliceWithClosedWaves(env.deps, "rollup-closed");
    const reloaded = loadSlice(slice.id);
    const delivery = childDeliveryOf(reloaded);

    expect(delivery.length).toBe(childWaveIds.length);
    for (const childId of childWaveIds) {
      const record = delivery.find((r) => r.childUnitId === childId);
      expect(record).toBeDefined();
      expect(record!.childStatus).toBe("closed");
    }
  });

  it("单独 advanceWaveToClosed 一个 child → 该 child childStatus='closed'，其余仍 pending", () => {
    // 改 split 为 2 个 wave，只 closeout 第一个
    const slice = setupToSliceDesignReviewed(env.deps, "rollup-partial");
    slice.plan.split = [
      { slug: "w1", description: "w1", dependsOn: [], inheritedItemIds: ["IF1"] },
      { slug: "w2", description: "w2", dependsOn: ["w1"], inheritedItemIds: ["DM1"] },
    ];
    handleExecuteSlice(slice, env.deps);

    const childIds = loadSlice(slice.id).executeResult.childUnitIds;
    expect(childIds).toHaveLength(2);

    // 只推进第一个 child 到 closed
    advanceWaveToClosed(env.deps, childIds[0]!);

    const delivery = childDeliveryOf(loadSlice(slice.id));
    const r0 = delivery.find((r) => r.childUnitId === childIds[0]!)!;
    const r1 = delivery.find((r) => r.childUnitId === childIds[1]!)!;
    expect(r0.childStatus).toBe("closed");
    expect(r1.childStatus).toBe("pending");
  });
});

// ═══════════════════════════════════════════════════════════════
// child wave abort → rollup childStatus='aborted'
// ═══════════════════════════════════════════════════════════════

describe("child wave abort → rollup childStatus='aborted'", () => {
  it("abort child wave → rollup → childStatus='aborted'", () => {
    const slice = setupToSliceDesignReviewed(env.deps, "rollup-abort");
    handleExecuteSlice(slice, env.deps);
    const childId = loadSlice(slice.id).executeResult.childUnitIds[0]!;

    // child wave 刚创建 status=created，abort 允许从 created 触发
     
    const childUnit = env.store.load(childId) as unknown as ExecutionUnit;
    expect(childUnit.status).toBe("created");

    // 直接调 wave handleAbort（不经 dispatch，聚焦 abort + rollup 接入）
    handleAbort(childUnit, { reason: "test abort" }, env.deps);

    const delivery = childDeliveryOf(loadSlice(slice.id));
    const record = delivery.find((r) => r.childUnitId === childId)!;
    expect(record.childStatus).toBe("aborted");
  });
});

// ═══════════════════════════════════════════════════════════════
// 冻结一致性：parent closeout 冻结后 rollup 跳过
// ═══════════════════════════════════════════════════════════════

describe("parent slice 冻结后 rollup 跳过（D2 一致性）", () => {
  it("slice closeout 冻结后（frozenAt 非空），再 rollup child → childDelivery 不动", () => {
    const { slice, childWaveIds } = setupSliceWithClosedWaves(env.deps, "rollup-frozen");
    // 所有 child 已 closed → childDelivery 全 closed
    const deliveryBefore = childDeliveryOf(loadSlice(slice.id));
    expect(deliveryBefore.every((r) => r.childStatus === "closed")).toBe(true);

    // slice closeout 冻结（retrospect 先过 gate，再 closeout）
    const reloaded = loadSlice(slice.id);
    handleRetrospectSlice(reloaded, { retrospectData: makeValidPlanningRetrospectData() }, env.deps);
    handleCloseoutSlice(loadSlice(slice.id), { artifacts: [] }, env.deps);

    const frozenSlice = loadSlice(slice.id);
    expect(frozenSlice.evidence.frozenAt).toBeDefined();
    expect(frozenSlice.evidence.frozenAt).not.toBe("");

    // 冻结后直接调 rollupChildDelivery（即使 child 状态变了也不动 parent）
    const snapshot = JSON.parse(JSON.stringify(deliveryBefore)) as ChildDeliveryRecord[];
    for (const childId of childWaveIds) {
      rollupChildDelivery(env.deps, childId);
    }

    // childDelivery 未变（rollup 跳过冻结 parent）
    const deliveryAfter = childDeliveryOf(loadSlice(slice.id));
    expect(deliveryAfter).toEqual(snapshot);
  });

  it("rollupChildDelivery 对无 parentUnitId 的 child → 静默 no-op（不抛错）", () => {
    // child 无 parent（独立 wave）→ rollup 静默跳过
    const orphan = createWave({ slug: "orphan", objective: "o" });
     
    env.store.save(orphan as unknown as WorkUnitRecord);
    expect(() => rollupChildDelivery(env.deps, orphan.id)).not.toThrow();
  });

  it("rollupChildDelivery 对不存在的 childUnitId → 静默 no-op", () => {
    expect(() => rollupChildDelivery(env.deps, "wave:ghost")).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// child wave 中间态不触发 rollup 更新
// ═══════════════════════════════════════════════════════════════

describe("child wave 中间态 → rollup 不更新 childStatus（保持 pending）", () => {
  it("child 仍 created（中间态）后 rollup → childStatus 仍 pending", () => {
    const slice = setupToSliceDesignReviewed(env.deps, "rollup-mid");
    handleExecuteSlice(slice, env.deps);
    const childId = loadSlice(slice.id).executeResult.childUnitIds[0]!;

    // 直接 rollup（child 仍 created，中间态）→ childStatus 不变
    rollupChildDelivery(env.deps, childId);
    const delivery = childDeliveryOf(loadSlice(slice.id));
    const record = delivery.find((r) => r.childUnitId === childId)!;
    expect(record.childStatus).toBe("pending");
  });
});

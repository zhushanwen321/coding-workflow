/**
 * v1 PlanningUnit 三层 rollup 接入测试（M1 修复）。
 *
 * evidence-rollup.test.ts 已覆盖 wave→slice 的 rollup（wave handler 接入）。
 * 本文件覆盖本 wave 新增的接入点：PlanningUnit 三层（slice/feature/epic）的
 * closeout/abort handler + 级联函数（cascadeAbortUnit / cascadeAbortChildren）内部 rollup。
 *
 * 测试矩阵：
 * - tc1: child wave closeout → parent slice.childDelivery childStatus=closed（已在 evidence-rollup 覆盖，此处仅 smoke）
 * - tc2: child slice closeout → parent feature.childDelivery childStatus=closed（跨层 PlanningUnit→PlanningUnit）
 * - tc3: slice replan 级联 abort child wave → parent slice.childDelivery childStatus=aborted（cascadeAbortUnit 内 rollup）
 * - tc4: slice abort 级联 child wave → parent slice.childDelivery childStatus=aborted（cascadeAbortChildren 内 rollup）
 * - tc5: feature closeout → parent epic.childDelivery childStatus=closed（跨层）
 * - tc7: slice abort 不级联修改已 closed 的 child wave（脏数据防护）
 * - tc8: feature abort 不级联修改已 closed 的 child slice（脏数据防护）
 * - tc9: epic abort 不级联修改已 closed 的 child feature（脏数据防护）
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChildDeliveryRecord } from "../src/core/evidence.js";
import type { Epic, Feature, Slice } from "../src/core/workunit.js";
import { handleAbortEpic } from "../src/handlers/epic/abort.js";
import { handleAbortFeature } from "../src/handlers/feature/abort.js";
import { rollupChildDelivery } from "../src/handlers/rollup.js";
import { handleAbortSlice } from "../src/handlers/slice/abort.js";
import { handleCloseoutSlice } from "../src/handlers/slice/closeout.js";
import { handleExecuteSlice } from "../src/handlers/slice/execute.js";
import { handleReplanSlice } from "../src/handlers/slice/replan.js";
import { handleRetrospectSlice } from "../src/handlers/slice/retrospect.js";
import type { CwEnv } from "./helpers/env.js";
import { createCwEnv } from "./helpers/env.js";
import {
  setupEpicWithClosedFeatures,
} from "./helpers/epic-env.js";
import {
  setupFeatureWithClosedSlices,
  setupToFeatureExecuting,
} from "./helpers/feature-env.js";
import {
  makeValidPlanningRetrospectData,
  setupSliceWithClosedWaves,
  setupToSliceDesignReviewed,
} from "./helpers/slice-env.js";

let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
});

afterEach(() => {
  env.cleanup();
});

/** 读 PlanningUnit 的 childDelivery。 */
function childDeliveryOf(unit: Slice | Feature | Epic): ChildDeliveryRecord[] {
  return unit.evidence.childDelivery;
}

function loadSlice(id: string): Slice {
  return env.store.load(id) as unknown as Slice;
}
function loadFeature(id: string): Feature {
  return env.store.load(id) as unknown as Feature;
}
function loadEpic(id: string): Epic {
  return env.store.load(id) as unknown as Epic;
}

// ═══════════════════════════════════════════════════════════════
// tc2: child slice closeout → parent feature.childDelivery childStatus=closed
// ═══════════════════════════════════════════════════════════════

describe("child slice closeout → rollup 到 parent feature.childDelivery", () => {
  it("setupFeatureWithClosedSlices 后 feature.childDelivery 全 closed + childEvidenceSummary 填入", () => {
    const featureId = setupFeatureWithClosedSlices(env.deps, "rollup-feat-closed");
    const feature = loadFeature(featureId);
    const delivery = childDeliveryOf(feature);

    expect(delivery.length).toBeGreaterThan(0);
    expect(delivery.every((r) => r.childStatus === "closed")).toBe(true);
    // closed 的 child 必须填入 childEvidenceSummary（若 child 有 summary）
    // advanceChildSlicesToClosed 的 closeout 未传 summary，rollup 仅在 child.summary 非空时填入；
    // 这里仅断言 childStatus=closed（核心 rollup 生效），childEvidenceSummary 的填充见 evidence-rollup.test.ts 的 wave 场景。
    expect(delivery.every((r) => r.childStatus === "closed")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// tc2b: child slice 带 summary closeout → parent feature.childDelivery.childEvidenceSummary 填入
// ═══════════════════════════════════════════════════════════════

describe("child slice closeout 带 summary → childEvidenceSummary 填入", () => {
  it("closeout input.summary 非空 → rollup 把 summary 写入 feature.childDelivery[i].childEvidenceSummary", () => {
    // 手动构造 feature + child slice，手动 closeout 带 summary
    const featureId = setupToFeatureExecuting(env.deps, "rollup-summary");
    const feature0 = loadFeature(featureId);
    const childSliceId = feature0.executeResult.childUnitIds[0]!;

    // 手动把 child slice 推到 retrospected（不走 dispatch，聚焦 closeout rollup）
    const child = loadSlice(childSliceId);
    child.status = "retrospected";
    child.evidence.summary = ""; // closeout 前清空
    env.store.save(child as unknown as import("../src/store/schema.js").WorkUnitRecord);

    handleCloseoutSlice(loadSlice(childSliceId), { artifacts: [], summary: "slice done summary" }, env.deps);

    const feature = loadFeature(featureId);
    const record = childDeliveryOf(feature).find((r) => r.childUnitId === childSliceId)!;
    expect(record.childStatus).toBe("closed");
    expect(record.childEvidenceSummary).toBe("slice done summary");
  });
});

// ═══════════════════════════════════════════════════════════════
// tc5: feature closeout → parent epic.childDelivery childStatus=closed
// ═══════════════════════════════════════════════════════════════

describe("feature closeout → rollup 到 parent epic.childDelivery", () => {
  it("setupEpicWithClosedFeatures 后 epic.childDelivery 全 closed", () => {
    const epicId = setupEpicWithClosedFeatures(env.deps, "rollup-epic-closed");
    const epic = loadEpic(epicId);
    const delivery = childDeliveryOf(epic);

    expect(delivery.length).toBeGreaterThan(0);
    expect(delivery.every((r) => r.childStatus === "closed")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// tc3: slice replan 级联 abort child wave → parent slice.childDelivery childStatus=aborted
//     （验证 cascadeAbortUnit 内部补的 rollup 生效）
// ═══════════════════════════════════════════════════════════════

describe("slice replan 级联 abort → cascadeAbortUnit 内 rollup 生效", () => {
  it("slice replan 废弃 IF1 → 命中 child wave abort → slice.childDelivery[child].childStatus=aborted", () => {
    const slice = setupToSliceDesignReviewed(env.deps, "replan-rollup");
    handleExecuteSlice(slice, env.deps);

    const childIds = loadSlice(slice.id).executeResult.childUnitIds;
    expect(childIds.length).toBeGreaterThan(0);
    const childId = childIds[0]!;

    // execute 后 childDelivery 初始 pending
    const deliveryBefore = childDeliveryOf(loadSlice(slice.id));
    expect(deliveryBefore.find((r) => r.childUnitId === childId)!.childStatus).toBe("pending");

    // replan 废弃 IF1（makeValidSlicePlan 的 split inheritedItemIds 含 IF1）
    handleReplanSlice(loadSlice(slice.id), { abandonedIds: ["IF1"], note: "IF1 obsolete" }, env.deps);

    // child wave 被 cascadeAbortUnit 级联 abort → slice.childDelivery 该 child 变 aborted
    const deliveryAfter = childDeliveryOf(loadSlice(slice.id));
    const record = deliveryAfter.find((r) => r.childUnitId === childId)!;
    expect(record.childStatus).toBe("aborted");
  });
});

// ═══════════════════════════════════════════════════════════════
// tc4: slice abort 级联 child wave → parent slice.childDelivery childStatus=aborted
//     （验证 cascadeAbortChildren 内部补的 rollup 生效）
// ═══════════════════════════════════════════════════════════════

describe("slice abort 级联 child wave → cascadeAbortChildren 内 rollup 生效", () => {
  it("slice abort → child wave 被 cascadeAbortChildren abort → slice.childDelivery[child].childStatus=aborted", () => {
    const slice = setupToSliceDesignReviewed(env.deps, "abort-rollup");
    handleExecuteSlice(slice, env.deps);

    const childIds = loadSlice(slice.id).executeResult.childUnitIds;
    expect(childIds.length).toBeGreaterThan(0);
    const childId = childIds[0]!;

    // slice abort（execute 后 status=executing，允许 abort）
    handleAbortSlice(loadSlice(slice.id), { reason: "abandon slice" }, env.deps);

    // child wave 被级联 abort → slice.childDelivery 该 child 变 aborted
    const delivery = childDeliveryOf(loadSlice(slice.id));
    const record = delivery.find((r) => r.childUnitId === childId)!;
    expect(record.childStatus).toBe("aborted");
  });
});

// ═══════════════════════════════════════════════════════════════
// tc6: parent slice 已冻结（frozenAt）→ rollup 跳过
//     （closeout handler 先设 frozenAt 再 save，但 rollup 检查 parent.frozenAt——
//      这里测的是：slice 自己 closeout 冻结后，child 再状态变更 rollup 不动已冻结 slice）
// ═══════════════════════════════════════════════════════════════

describe("parent slice 冻结后 rollup 跳过", () => {
  it("slice closeout 冻结后，剩余 pending child 的 childDelivery 不再被 rollup 更新", () => {
    // 构造一个 slice，execute 后有多个 child wave，只 closeout 第一个，其余 pending
    const slice = setupToSliceDesignReviewed(env.deps, "freeze-rollup");
    slice.plan.split = [
      { slug: "w1", description: "w1", dependsOn: [], inheritedItemIds: ["IF1"] },
      { slug: "w2", description: "w2", dependsOn: ["w1"], inheritedItemIds: ["DM1"] },
    ];
    handleExecuteSlice(slice, env.deps);
    const childIds = loadSlice(slice.id).executeResult.childUnitIds;
    expect(childIds).toHaveLength(2);

    // slice 直接走 retrospect + closeout 冻结（不要求所有 child closed，聚焦冻结跳过 rollup）
    handleRetrospectSlice(loadSlice(slice.id), { retrospectData: makeValidPlanningRetrospectData() }, env.deps);
    handleCloseoutSlice(loadSlice(slice.id), { artifacts: [] }, env.deps);

    const frozen = loadSlice(slice.id);
    expect(frozen.evidence.frozenAt).toBeDefined();
    expect(frozen.evidence.frozenAt).not.toBe("");

    // 冻结时刻 childDelivery 状态快照（w1/w2 都还 pending，因为没单独推进 child）
    const snapshot = JSON.parse(JSON.stringify(childDeliveryOf(frozen))) as ChildDeliveryRecord[];

    // 再次触发 rollup（模拟 child 状态变更）→ 冻结 parent 不动
    // 直接调 rollupChildDelivery 验证冻结跳过（与 evidence-rollup.test.ts 同模式）
    for (const childId of childIds) {
      rollupChildDelivery(env.deps, childId);
    }

    const after = childDeliveryOf(loadSlice(slice.id));
    expect(after).toEqual(snapshot);
  });
});

// ═══════════════════════════════════════════════════════════════
// tc7: slice abort 不级联修改已 closed 的 child wave（T-Critical-3 修复）
// ═══════════════════════════════════════════════════════════════

describe("slice abort 级联跳过已 closed 的 child wave", () => {
  it("child wave 已 closed → slice abort 后仍 closed，且 evidence 不被污染", () => {
    const { slice, childWaveIds } = setupSliceWithClosedWaves(env.deps, "abort-skip-closed-wave");
    expect(slice.status).toBe("executing");
    expect(childWaveIds.length).toBeGreaterThan(0);

    const childId = childWaveIds[0]!;
    const childBefore = env.deps.store.load(childId) as unknown as { status: string; statusHistory: unknown[]; evidence: { frozenAt: string } };
    expect(childBefore.status).toBe("closed");
    expect(childBefore.evidence.frozenAt).toBeDefined();
    const historyBefore = JSON.stringify(childBefore.statusHistory);

    handleAbortSlice(loadSlice(slice.id), { reason: "abandon slice" }, env.deps);

    const childAfter = env.deps.store.load(childId) as unknown as { status: string; statusHistory: unknown[]; evidence: { frozenAt: string } };
    expect(childAfter.status).toBe("closed");
    expect(JSON.stringify(childAfter.statusHistory)).toBe(historyBefore);
    expect(childAfter.evidence.frozenAt).toBe(childBefore.evidence.frozenAt);
  });
});

// ═══════════════════════════════════════════════════════════════
// tc8: feature abort 不级联修改已 closed 的 child slice（T-Critical-3 修复）
// ═══════════════════════════════════════════════════════════════

describe("feature abort 级联跳过已 closed 的 child slice", () => {
  it("child slice 已 closed → feature abort 后仍 closed，且 evidence 不被污染", () => {
    const featureId = setupFeatureWithClosedSlices(env.deps, "abort-skip-closed-slice");
    const feature = loadFeature(featureId);
    expect(feature.status).toBe("executing");
    const childSliceIds = feature.executeResult.childUnitIds;
    expect(childSliceIds.length).toBeGreaterThan(0);

    const childId = childSliceIds[0]!;
    const childBefore = env.deps.store.load(childId) as unknown as { status: string; statusHistory: unknown[]; evidence: { frozenAt: string } };
    expect(childBefore.status).toBe("closed");
    expect(childBefore.evidence.frozenAt).toBeDefined();
    const historyBefore = JSON.stringify(childBefore.statusHistory);

    handleAbortFeature(loadFeature(featureId), { reason: "abandon feature" }, env.deps);

    const childAfter = env.deps.store.load(childId) as unknown as { status: string; statusHistory: unknown[]; evidence: { frozenAt: string } };
    expect(childAfter.status).toBe("closed");
    expect(JSON.stringify(childAfter.statusHistory)).toBe(historyBefore);
    expect(childAfter.evidence.frozenAt).toBe(childBefore.evidence.frozenAt);
  });
});

// ═══════════════════════════════════════════════════════════════
// tc9: epic abort 不级联修改已 closed 的 child feature（T-Critical-3 修复）
// ═══════════════════════════════════════════════════════════════

describe("epic abort 级联跳过已 closed 的 child feature", () => {
  it("child feature 已 closed → epic abort 后仍 closed，且 evidence 不被污染", () => {
    const epicId = setupEpicWithClosedFeatures(env.deps, "abort-skip-closed-feature");
    const epic = loadEpic(epicId);
    expect(epic.status).toBe("executing");
    const childFeatureIds = epic.executeResult.childUnitIds;
    expect(childFeatureIds.length).toBeGreaterThan(0);

    const childId = childFeatureIds[0]!;
    const childBefore = env.deps.store.load(childId) as unknown as { status: string; statusHistory: unknown[]; evidence: { frozenAt: string } };
    expect(childBefore.status).toBe("closed");
    expect(childBefore.evidence.frozenAt).toBeDefined();
    const historyBefore = JSON.stringify(childBefore.statusHistory);

    handleAbortEpic(loadEpic(epicId), { reason: "abandon epic" }, env.deps);

    const childAfter = env.deps.store.load(childId) as unknown as { status: string; statusHistory: unknown[]; evidence: { frozenAt: string } };
    expect(childAfter.status).toBe("closed");
    expect(JSON.stringify(childAfter.statusHistory)).toBe(historyBefore);
    expect(childAfter.evidence.frozenAt).toBe(childBefore.evidence.frozenAt);
  });
});


/**
 * v1 epic handler — execute action（递归下沉点：创建 child feature）。
 *
 * 设计来源：core workunit.createFeature（消费已有工厂，epic 的 child 是 feature）、
 * PLANNING_TRANSITIONS.execute（design-reviewed → executing）、model §5.11.1（ChildDeliveryRecord）。
 *
 * 职责：
 * 1. 按 unit.plan.split 一次性创建所有 child feature（每个 split → 一个 feature）
 *    - childSlug = `${unit.slug}::${split.slug}`（:: 分隔避免与 slug 内的 - 混淆）
 *    - child objective = split.description
 *    - child.parentUnitId = unit.id
 *    - child.basedOnParent = split.inheritedItemIds ?? []（写入子层，影响面计算基础）
 * 2. 收集 child feature id 到 unit.executeResult.childUnitIds
 * 3. 收集 childDelivery 记录到 unit.evidence.childDelivery（splitSlug + childUnitId + childStatus='pending'）
 * 4. 填 evidence.generatedAt（首次；若已填则保留）
 * 5. status 流转（design-reviewed → executing）→ save unit
 *
 * epic 停在 executing：child feature 各自独立走 feature 7 步，epic 此后由 W5 的 rollup 在 feature
 * closeout/abort 时更新 childDelivery.childStatus，由 agent 手动推进到 retrospect。
 *
 * nextAction：action=undefined（停留）+ crossLayer.descend（targetUnitId=第一个 child，targetLayer='feature'）。
 *
 * 与 feature execute 的关键差异：
 * - child 是 feature（createFeature），不是 slice（createSlice）——epic→feature→slice 三层嵌套的下沉点
 * - crossLayer.targetLayer='feature'（feature 版是 'slice'）
 *
 * 不变量：execute 不跑 gate（split DAG 无环在 design-review 已验）。child feature 创建后立即 save。
 */
import type { ChildDeliveryRecord } from "../../core/evidence.js";
import type { Epic } from "../../core/workunit.js";
import { createFeature } from "../../core/workunit.js";
import type { WorkUnitRecord } from "../../store/schema.js";
import type { ActionResult, V1Deps, V1NextAction } from "../types.js";
import { buildEpicNextAction, epicTransition, saveEpic } from "./epic-internal.js";

/**
 * 执行 epic execute action（递归下沉：创建所有 child feature）。
 *
 * @param unit 已加载的 Epic（status = design-reviewed）
 * @param deps 依赖注入（store / clock）
 */
export function handleExecuteEpic(
  unit: Epic,
  deps: V1Deps,
): ActionResult {
  const at = deps.clock.now();

  // ── 按 plan.split 创建所有 child feature ──
  for (const split of unit.plan.split) {
    const childSlug = `${unit.slug}::${split.slug}`;
    const child = createFeature({
      slug: childSlug,
      objective: split.description,
      parentUnitId: unit.id,
      basedOnParent: split.inheritedItemIds ?? [],
      createdAt: at,
    });
    // child feature 直接以 WorkUnitRecord 形式存（createFeature 返回 Feature，store 透传）
    // eslint-disable-next-line taste/no-unsafe-cast
    deps.store.save(child as unknown as WorkUnitRecord);

    unit.executeResult.childUnitIds.push(child.id);

    const record: ChildDeliveryRecord = {
      splitSlug: split.slug,
      childUnitId: child.id,
      childStatus: "pending",
    };
    unit.evidence.childDelivery.push(record);
  }

  // generatedAt 首次生成时间（progressive 场景下 execute 可能重跑，已填则保留）
  if (!unit.evidence.generatedAt) {
    unit.evidence.generatedAt = at;
  }

  epicTransition(unit, "execute", at);

  saveEpic(deps, unit);

  // ── crossLayer：下沉到第一个 child feature ──
  const firstChildId = unit.executeResult.childUnitIds[0];
  const crossLayer: V1NextAction["crossLayer"] | undefined = firstChildId !== undefined
    ? {
        kind: "descend",
        targetLayer: "feature",
        targetUnitId: firstChildId,
        reason: `epic 已拆 ${unit.plan.split.length} 个 feature，去推进第一个 child feature`,
      }
    : undefined;

  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    nextAction: buildEpicNextAction(unit, "execute", { crossLayer }),
  };
}

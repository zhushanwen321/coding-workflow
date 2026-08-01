/**
 * v1 slice handler — execute action【核心：递归下沉点】。
 *
 * 设计来源：v5 wave 附录 A §10 编排骨架的 slice 对应、core workunit.createWave（消费已有工厂）、
 * PLANNING_TRANSITIONS.execute（design-reviewed → executing）、model §5.11.1（ChildDeliveryRecord）。
 *
 * 职责：
 * 1. 按 unit.plan.split 一次性创建所有 child wave（每个 split → 一个 wave）
 *    - childSlug = `${unit.slug}::${split.slug}`（:: 分隔避免与 slug 内的 - 混淆）
 *    - child objective = split.description
 *    - child.parentUnitId = unit.id
 *    - child.basedOnParent = split.inheritedItemIds ?? []（写入子层，影响面计算基础）
 * 2. 收集 child wave id 到 unit.executeResult.childUnitIds
 * 3. 收集 childDelivery 记录到 unit.evidence.childDelivery（splitSlug + childUnitId + childStatus='pending'）
 * 4. 填 evidence.generatedAt（首次；若已填则保留）
 * 5. status 流转（design-reviewed → executing）→ save unit
 *
 * slice 停在 executing：child wave 各自独立走 wave 9 步，slice 此后由 W5 的 rollup 在 wave
 * closeout/abort 时更新 childDelivery.childStatus，由 agent 手动推进到 retrospect。
 *
 * nextAction：action=undefined（停留）+ crossLayer.descend（targetUnitId=第一个 child，targetLayer='wave'）。
 *
 * 不变量：execute 不跑 gate（split DAG 无环在 design-review 已验）。child wave 创建后立即 save。
 */
import { assertEvidenceNotFrozen, type ChildDeliveryRecord } from "../../core/evidence.js";
import { resolveChildDependsOn } from "../../core/hierarchy.js";
import type { Slice } from "../../core/workunit.js";
import { createWave } from "../../core/workunit.js";
import type { WorkUnitRecord } from "../../store/schema.js";
import type { ActionResult, ChildInfo, CwDeps, CwNextAction } from "../types.js";
import { buildSliceNextAction, saveSlice, sliceTransition } from "./slice-internal.js";

/**
 * 执行 slice execute action（递归下沉：创建所有 child wave）。
 *
 * @param unit 已加载的 Slice（status = design-reviewed）
 * @param deps 依赖注入（store / clock）
 */
export function handleExecuteSlice(
  unit: Slice,
  deps: CwDeps,
): ActionResult {
  const at = deps.clock.now();

  // ── 检查 evidence 是否已冻结（frozenAt 非空后不可再改） ──
  assertEvidenceNotFrozen(unit.evidence, "write childDelivery/generatedAt");

  // ── 按 plan.split 创建所有 child wave ──
  for (const split of unit.plan.split) {
    const childSlug = `${unit.slug}::${split.slug}`;
    const child = createWave({
      slug: childSlug,
      objective: split.description,
      parentUnitId: unit.id,
      basedOnParent: split.inheritedItemIds ?? [],
      createdAt: at,
    });
    // child wave 直接以 WorkUnitRecord 形式存（createWave 返回 ExecutionUnit，store 透传）
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

  // ── 构造 ActionResult.children（供递归调度器消费）──
  // 复用 hierarchy.resolveChildDependsOn（同构：slugToChildId Map + split.dependsOn 映射），
  // 仅返回字段名不同（childUnitId → ChildInfo.unitId），故 .map 适配。
  const children: ChildInfo[] = resolveChildDependsOn(
    unit.plan.split,
    unit.evidence.childDelivery,
  ).map((d) => ({ unitId: d.childUnitId, dependsOn: d.dependsOn }));

  // generatedAt 首次生成时间（progressive 场景下 execute 可能重跑，已填则保留）
  if (!unit.evidence.generatedAt) {
    unit.evidence.generatedAt = at;
  }

  sliceTransition(unit, "execute", at);

  saveSlice(deps, unit);

  // ── crossLayer：下沉到第一个 child wave ──
  const firstChildId = unit.executeResult.childUnitIds[0];
  const crossLayer: CwNextAction["crossLayer"] | undefined = firstChildId !== undefined
    ? {
        kind: "descend",
        targetLayer: "wave",
        targetUnitId: firstChildId,
        reason: `slice 已拆 ${unit.plan.split.length} 个 wave，去推进第一个 child wave`,
      }
    : undefined;

  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    children,
    nextAction: buildSliceNextAction(unit, "execute", { crossLayer }),
  };
}

/**
 * v1 feature handler — execute action（递归下沉点：创建 child slice）。
 *
 * 设计来源：core workunit.createSlice（消费已有工厂，feature 的 child 是 slice 不是 wave）、
 * PLANNING_TRANSITIONS.execute（design-reviewed → executing）、model §5.11.1（ChildDeliveryRecord）。
 *
 * 职责：
 * 1. 按 unit.plan.split 一次性创建所有 child slice（每个 split → 一个 slice）
 *    - childSlug = `${unit.slug}::${split.slug}`（:: 分隔避免与 slug 内的 - 混淆）
 *    - child objective = split.description
 *    - child.parentUnitId = unit.id
 *    - child.basedOnParent = split.inheritedItemIds ?? []（写入子层，影响面计算基础）
 * 2. 收集 child slice id 到 unit.executeResult.childUnitIds
 * 3. 收集 childDelivery 记录到 unit.evidence.childDelivery（splitSlug + childUnitId + childStatus='pending'）
 * 4. 填 evidence.generatedAt（首次；若已填则保留）
 * 5. status 流转（design-reviewed → executing）→ save unit
 *
 * feature 停在 executing：child slice 各自独立走 slice 7 步，feature 此后由 W5 的 rollup 在 slice
 * closeout/abort 时更新 childDelivery.childStatus，由 agent 手动推进到 retrospect。
 *
 * nextAction：action=undefined（停留）+ crossLayer.descend（targetUnitId=第一个 child，targetLayer='slice'）。
 *
 * 与 slice execute 的关键差异：
 * - child 是 slice（createSlice），不是 wave（createWave）——feature→slice→wave 三层嵌套的下沉点
 * - crossLayer.targetLayer='slice'（slice 版是 'wave'）
 *
 * 不变量：execute 不跑 gate（split DAG 无环在 design-review 已验）。child slice 创建后立即 save。
 */
import { assertEvidenceNotFrozen, type ChildDeliveryRecord } from "../../core/evidence.js";
import { type ChildDependency,resolveChildDependsOn } from "../../core/hierarchy.js";
import type { Feature } from "../../core/workunit.js";
import { createSlice } from "../../core/workunit.js";
import type { WorkUnitRecord } from "../../store/schema.js";
import type { ActionResult, ChildInfo, CwDeps, CwNextAction } from "../types.js";
import { buildFeatureNextAction, featureTransition, saveFeature } from "./feature-internal.js";

/**
 * 执行 feature execute action（递归下沉：创建所有 child slice）。
 *
 * @param unit 已加载的 Feature（status = design-reviewed）
 * @param deps 依赖注入（store / clock）
 */
export function handleExecuteFeature(
  unit: Feature,
  deps: CwDeps,
): ActionResult {
  const at = deps.clock.now();

  // ── 检查 evidence 是否已冻结（progressive execute 重跑时防止往已冻结 evidence 写 childDelivery） ──
  assertEvidenceNotFrozen(unit.evidence, "write childDelivery/generatedAt");

  // ── 按 plan.split 创建所有 child slice ──
  for (const split of unit.plan.split) {
    const childSlug = `${unit.slug}::${split.slug}`;
    const child = createSlice({
      slug: childSlug,
      objective: split.description,
      parentUnitId: unit.id,
      basedOnParent: split.inheritedItemIds ?? [],
      createdAt: at,
    });
    // child slice 直接以 WorkUnitRecord 形式存（createSlice 返回 Slice，store 透传）
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
  // 复用 hierarchy.resolveChildDependsOn（同构：slugToChildId Map + split.dependsOn 映射）。
  // plan 决策 D4 原定「execute 内联构建，不经 resolveChildDependsOn」，但实现期发现
  // resolveChildDependsOn 的逻辑与内联构建同构（都用 slug→child.id 映射），复用更 DRY，
  // 故采纳——这是对 D4 的实现期优化（功能等价，消除两套同义映射）。
  // filter 掉 childUnitId undefined 项（slug 失配，该 split 无对应子 unit，不应下沉）。
  const children: ChildInfo[] = resolveChildDependsOn(
    unit.plan.split,
    unit.evidence.childDelivery,
  )
    .filter((d): d is ChildDependency & { childUnitId: string } => d.childUnitId !== undefined)
    .map((d) => ({ unitId: d.childUnitId, dependsOn: d.dependsOn }));

  // generatedAt 首次生成时间（progressive 场景下 execute 可能重跑，已填则保留）
  if (!unit.evidence.generatedAt) {
    unit.evidence.generatedAt = at;
  }

  featureTransition(unit, "execute", at);

  saveFeature(deps, unit);

  // ── crossLayer：下沉到第一个 child slice（serial 模式）──
  // G5：recursive 模式（多 agent 并行 + steer 唤醒）不填 descend——父派 N 个 planning-agent
  // 并行推进子层后空闲等唤醒，不自己 descend。serial 模式保持现状（下沉第一个 child）。
  const firstChildId = unit.executeResult.childUnitIds[0];
  const crossLayer: CwNextAction["crossLayer"] | undefined =
    deps.orchestration === "recursive" || firstChildId === undefined
      ? undefined
      : {
          kind: "descend",
          targetLayer: "slice",
          targetUnitId: firstChildId,
          reason: `feature 已拆 ${unit.plan.split.length} 个 slice，去推进第一个 child slice`,
        };

  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    children,
    nextAction: buildFeatureNextAction(unit, "execute", {
      crossLayer,
      orchestration: deps.orchestration,
    }),
  };
}

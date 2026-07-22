/**
 * v1 wave replan 影响面计算（领域规则，纯函数，零 IO）。
 *
 * 来源：v5 model §5.6.2（replan 流程 Step 2-4：影响面计算 + 级联 abort + 返回给 agent）、
 *      §5.6.1（basedOnParent 是影响面计算基础）、wave §8.1（wave 是叶子，影响面恒为空）。
 *
 * 职责：给定「所有相关 unit + 本次废弃的条目 id」，算出影响面：
 *      哪些 unit 因 basedOnParent 命中废弃条目而受影响（→ aborted）。
 *
 * 机制（model §5.6.2）：
 * - 命中规则：unit.basedOnParent 含已废弃条目 → unit 受影响（加入 aborted）
 * - preserved：未命中的 unit
 * - pendingRebuild：被废弃的条目中，失去承接（没有 preserved unit 引用）的条目 id
 *
 * wave 特性（wave §8.1）：wave 是叶子（无 childUnitIds），影响面计算结果通常为空——
 * 但机制要跑通（本函数对任意 allUnits 通用，不只 wave）。
 *
 * 不变量：rules 层零 IO。纯函数遍历 allUnits。
 */
import type { ExecutionUnit } from "../core/workunit.js";

// ═══════════════════════════════════════════════════════════════
// ReplanImpact
// ═══════════════════════════════════════════════════════════════

/**
 * replan 影响面计算结果（model §5.6.2 Step 4 的返回结构）。
 *
 * - `aborted`：受影响子孙 unit id（basedOnParent 命中废弃条目 → 失去存在前提 → 将被 abort）
 * - `preserved`：未受影响的 unit id（basedOnParent 不含任何废弃条目）
 * - `pendingRebuild`：失去承接的条目 id（被废弃的条目里，没有 preserved unit 再引用它的）
 */
export interface ReplanImpact {
  /** 受影响子孙 unit id（cw 将自动 abort）。 */
  aborted: string[];
  /** 未受影响 unit id（保留原样）。 */
  preserved: string[];
  /** 失去承接的条目 id（提示 agent 需重建）。 */
  pendingRebuild: string[];
}

// ═══════════════════════════════════════════════════════════════
// computeImpact（主入口）
// ═══════════════════════════════════════════════════════════════

/**
 * 计算 replan 影响面（model §5.6.2）。
 *
 * 算法：
 * 1. 遍历 allUnits，对每个 unit 检查 basedOnParent 是否含 abandonedIds 中的 id
 *    - 命中（交集非空）→ 加入 aborted
 *    - 未命中 → 加入 preserved
 * 2. 计算 pendingRebuild：abandonedIds 中，没有任何 preserved unit 的 basedOnParent 引用它的条目 id
 *    （即「失去承接」——被废弃且没有保留的 unit 再承接的条目，提示 agent 重建）
 *
 * @param allUnits 所有相关 unit（含自身 + 子孙；由 handlers 层负责收集传入）
 * @param abandonedIds 本次废弃的条目 id（WorkUnitItem.id，来自上游 spec 条目）
 */
export function computeImpact(
  allUnits: ExecutionUnit[],
  abandonedIds: string[],
): ReplanImpact {
  const abandonedSet = new Set(abandonedIds);

  const aborted: string[] = [];
  const preserved: string[] = [];

  // Step 1：分类每个 unit（命中规则：basedOnParent 含废弃条目 → aborted）
  for (const unit of allUnits) {
    const hits = unit.basedOnParent.some((id) => abandonedSet.has(id));
    if (hits) {
      aborted.push(unit.id);
    } else {
      preserved.push(unit.id);
    }
  }

  // Step 2：计算 pendingRebuild（失去承接的条目）
  // 收集所有 preserved unit 还在引用的条目 id（这些条目仍有承接，不算 pendingRebuild）
  const preservedRefs = new Set<string>();
  for (const unit of allUnits) {
    if (aborted.includes(unit.id)) continue;
    for (const id of unit.basedOnParent) {
      preservedRefs.add(id);
    }
  }
  // pendingRebuild = 废弃条目里，没有被任何 preserved unit 引用的（失去承接）
  const pendingRebuild = abandonedIds.filter((id) => !preservedRefs.has(id));

  return { aborted, preserved, pendingRebuild };
}

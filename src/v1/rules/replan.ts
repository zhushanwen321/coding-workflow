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
import type { ExecutionUnit, WorkUnitBase } from "../core/workunit.js";

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
 * [WAVE-ONLY STUB] model §5.6.2 Step 2 的级联规则要求「父标记受影响 → 所有子孙级联受影响」。
 * 当前实现只做单层 basedOnParent × abandonedIds 命中判定，不含 parent→child 级联传播。
 * wave 是叶子（无 childUnitIds），影响面恒空，此简化当前无害。
 * 上接 slice/feature/epic 层时需补：首批命中后，把 parent 在 aborted 里的 unit 也加入 aborted，
 * 迭代到不动点（实现多层级联传播）。
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

// ═══════════════════════════════════════════════════════════════
// computeImpactCascade（slice/PlanningUnit 级联传播，model §5.6.2 Step 2-4）
// ═══════════════════════════════════════════════════════════════
// 来源：design-v5-model.md §5.6.2（replan 流程，Step 2 级联规则）、§5.6.1（basedOnParent）。
//
// 关键设计决策（D5）：wave 的 computeImpact 是单层命中（wave 是叶子，无子孙，简化无害）。
// slice 是第一个有子孙的层（child 是 wave），replan 需补齐「迭代到不动点」的级联传播：
//   首批命中后，把 parent 在受影响集里的 unit 也加入受影响集，迭代到不动点。
//
// rules 层零 IO：不能直接用 store。childrenLoader 由 handler 注入
// （handler 调 store.findChildren，逐层展开）。

/**
 * childrenLoader：给定 parentId，返回该 unit 的直接子 unit（由 handler 用 store.findChildren 注入）。
 *
 * rules 层零 IO——store 通过此函数参数注入。返回 WorkUnitBase[]（只需 id / basedOnParent）。
 */
export type ChildrenLoader = (parentId: string) => WorkUnitBase[];

/**
 * computeImpactCascade 的入参。
 *
 * - `unit`：发起 replan 的 WorkUnit（slice/feature/epic，有子孙）
 * - `abandonedIds`：本次废弃的条目 id（发起层自己的 WorkUnitItem.id）
 * - `loadChildren`：子 unit 加载器（handler 注入 store.findChildren）
 */
export interface ComputeImpactCascadeParams {
  unit: WorkUnitBase;
  abandonedIds: string[];
  loadChildren: ChildrenLoader;
}

/**
 * 计算多层级联 replan 影响面（model §5.6.2 Step 2-4）。
 *
 * 算法（「迭代到不动点」）：
 *
 * 1. **Step1 本地命中**：对发起 unit 的所有子孙（递归 loadChildren 展开），
 *    首轮判定——child.basedOnParent 含任一 abandonedIds → 标记受影响。
 *
 * 2. **Step2 级联传播**：受影响的 child 的所有子孙同样受影响（父废弃，子无意义，model §5.6.2 级联规则）。
 *    迭代：每一轮把「parent 在受影响集里」的 child 并入受影响集，直到受影响集不再增长（不动点）。
 *
 * 3. **Step3 pendingRebuild**：abandonedIds 中，没有任何 preserved（未受影响）子孙 basedOnParent
 *    引用的条目 → 失去承接，提示 agent 重建。
 *
 * 与 computeImpact（wave 单层）的关系：
 * - wave 是叶子（loadChildren 恒返回 []），级联结果等价于单层命中 → 可统一用 cascade。
 * - 但现有 wave 测试依赖 computeImpact 的精确行为（入参是 allUnits 数组），保留向后兼容。
 *
 * @param params 见 ComputeImpactCascadeParams
 */
export function computeImpactCascade(
  params: ComputeImpactCascadeParams,
): ReplanImpact {
  const { unit, abandonedIds, loadChildren } = params;
  const abandonedSet = new Set(abandonedIds);

  // ── 递归收集发起 unit 的所有子孙（广度优先，避免深递归栈）──
  const allDescendants = collectAllDescendants(unit.id, loadChildren);

  // ── Step1+Step2：受影响集迭代到不动点 ──
  // 受影响 = 自身 basedOnParent 命中废弃条目，或 parent 在受影响集里（级联）
  const affected = new Set<string>();

  // parentId 快查表（用于级联判定：parent 受影响 → child 受影响）
  const parentOf = new Map<string, string | undefined>();
  for (const d of allDescendants) {
    parentOf.set(d.id, d.parentUnitId);
  }

  // 首轮：basedOnParent 命中
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of allDescendants) {
      if (affected.has(d.id)) continue;
      const hitByAbandoned = d.basedOnParent.some((id) => abandonedSet.has(id));
      const parentId = parentOf.get(d.id);
      const parentAffected = parentId !== undefined && affected.has(parentId);
      if (hitByAbandoned || parentAffected) {
        affected.add(d.id);
        changed = true;
      }
    }
  }

  // ── 分类 aborted / preserved ──
  const aborted: string[] = [];
  const preserved: string[] = [];
  for (const d of allDescendants) {
    if (affected.has(d.id)) {
      aborted.push(d.id);
    } else {
      preserved.push(d.id);
    }
  }

  // ── Step3：pendingRebuild（失去承接的条目）──
  // 收集所有 preserved 子孙还在引用的条目 id
  const preservedRefs = new Set<string>();
  for (const d of allDescendants) {
    if (affected.has(d.id)) continue;
    for (const id of d.basedOnParent) {
      preservedRefs.add(id);
    }
  }
  const pendingRebuild = abandonedIds.filter((id) => !preservedRefs.has(id));

  return { aborted, preserved, pendingRebuild };
}

/**
 * 递归收集某 unit 的所有子孙（广度优先，避免循环引用死循环）。
 *
 * @param rootId 起始 unit id（不包含自身，只收集子孙）
 * @param loadChildren 子加载器
 */
function collectAllDescendants(
  rootId: string,
  loadChildren: ChildrenLoader,
): WorkUnitBase[] {
  const descendants: WorkUnitBase[] = [];
  const visited = new Set<string>([rootId]); // 防环
  const queue: string[] = [rootId];

  while (queue.length > 0) {
    const parentId = queue.shift()!;
    const children = loadChildren(parentId);
    for (const child of children) {
      if (visited.has(child.id)) continue; // 防环
      visited.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return descendants;
}

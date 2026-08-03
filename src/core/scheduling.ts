/**
 * 并行调度计算：基于 Split.dependsOn DAG + 子 unit 当前状态，算出就绪批次。
 *
 * 与 computeFrontier 的关系（设计文档 §3.1.2）：
 * - frontier 以 root 为根扫描整棵树（全局视图）
 * - scheduling 聚焦单个 parent 的 children（局部视图，更轻量）
 * - scheduling 复用 hierarchy.resolveChildDependsOn 做 slug→childId 映射，
 *   复用 hierarchy.isDependencySatisfied 做「依赖全终态」判定
 *
 * 就绪判定：child 未终态 且 其所有 dependsOn 兄弟已终态（closed/aborted）。
 *
 * 本模块不 import frontier.ts（避免 core 内部模块循环依赖）——本地实现等价的
 * 安全读取辅助函数（scope / split / childDelivery 的安全降级，与 frontier 同模式）。
 */
import type { WorkUnitRecord } from "../store/schema.js";
import type { ChildDeliveryRecord } from "./evidence.js";
import {
  type ChildDependency,
  isDependencySatisfied,
  resolveChildDependsOn,
} from "./hierarchy.js";
import type { Split } from "./plan.js";
import {
  PLANNING_STATUS_TO_ACTION,
  TERMINAL_STATUSES,
  WAVE_STATUS_TO_ACTION,
} from "./status.js";

/** planning 层 scope 集合（epic/feature/slice 共用一套状态机）。 */
const PLANNING_SCOPES = new Set(["epic", "feature", "slice"]);

// ═══════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════

/** frontier/scheduling 需要的 store 接口（与 frontier.ts FrontierStore 同构）。 */
export interface SchedulingStore {
  load(id: string): WorkUnitRecord | null;
}

/** computeReadyChildren 的就绪目标。 */
export interface ReadyTarget {
  unitId: string;
  action: string;
  satisfiedDependencies: string[];
}

// ═══════════════════════════════════════════════════════════════
// 辅助：从宽松的 WorkUnitRecord 安全取字段（与 frontier.ts 同模式，本地实现避免循环依赖）
// ═══════════════════════════════════════════════════════════════

/** 取 string 字段，非 string 时降级为 fallback。 */
function getStringField(
  unit: WorkUnitRecord,
  field: string,
  fallback = "",
): string {
  const v = unit[field];
  return typeof v === "string" ? v : fallback;
}

/** scope 字段收窄为联合类型（非预期值降级为 "wave"——仅用于类型，实际不会触发）。 */
function getScope(unit: WorkUnitRecord): "epic" | "feature" | "slice" | "wave" {
  const s = getStringField(unit, "scope");
  if (s === "epic" || s === "feature" || s === "slice" || s === "wave") {
    return s;
  }
  return "wave";
}

/** 从 unit 取一个字段并断言为 T（null/非 object 时返回 undefined）。与 frontier.ts readField 同模式。 */
function readField<T>(unit: WorkUnitRecord, field: string): T | undefined {
  const v = unit[field];
  return v !== null && typeof v === "object" ? (v as T) : undefined;
}

/** 断言值为数组，非数组返回空数组。与 frontier.ts asArray 同模式。 */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** 从宽松 record 安全读 split[]（plan.split）。 */
function getSplits(unit: WorkUnitRecord): Split[] {
  const plan = readField<{ split?: unknown }>(unit, "plan");
  return plan ? asArray<Split>(plan.split) : [];
}

/** 从宽松 record 安全读 childDelivery[]（evidence.childDelivery）。 */
function getChildDelivery(unit: WorkUnitRecord): ChildDeliveryRecord[] {
  const evidence = readField<{ childDelivery?: unknown }>(unit, "evidence");
  return evidence ? asArray<ChildDeliveryRecord>(evidence.childDelivery) : [];
}

// ═══════════════════════════════════════════════════════════════
// computeReadyChildren — 拓扑排序调度（Kahn 变体，无内存状态，每次从 store 重算）
// ═══════════════════════════════════════════════════════════════

/**
 * 算某 parent 下一批可并行推进的 children（就绪 = 未终态 + 依赖全终态）。
 *
 * 算法（设计文档 §3.1.2）：
 * 1. load(parent)，null → 返回空数组（保守降级，不 throw——parent 可能不在 store，
 *    如测试构造孤儿 parent 字符串）。
 * 2. resolveChildDependsOn(plan.split, childDelivery) → ChildDependency[]。
 * 3. 过滤 childUnitId === undefined（slug 失配：split.slug 在 childDelivery 中无匹配，
 *    该 split 无对应子 unit，不应下沉到调度器。对齐 execute.ts:82 的 .filter）。
 * 4. 遍历每个 child：load(child)，取 status
 *    a. 终态（closed/aborted）→ 跳过（不再推进）
 *    b. 非终态 + isDependencySatisfied(dependsOn, store) → 就绪，查 STATUS_TO_ACTION 得 action
 *    c. 非终态但依赖未满足 → 阻塞，跳过
 * 5. 按 split 声明顺序返回（不重排）。
 *
 * @param parentUnitId parent unit id（须是 PlanningUnit：epic/feature/slice）
 * @param store load 接口
 * @returns 就绪目标数组（可能为空）
 */
export function computeReadyChildren(
  parentUnitId: string,
  store: SchedulingStore,
): ReadyTarget[] {
  const parent = store.load(parentUnitId);
  if (parent === null) {
    // 保守降级：parent 不在 store（孤儿 parent 字符串），无法读 plan.split / childDelivery。
    // 不 throw——调用方拿到空 parallelTargets 后自然走 ascend/退回 childUnitIds[0] 分支。
    return [];
  }

  const splits = getSplits(parent);
  const childDelivery = getChildDelivery(parent);
  const childDeps: ChildDependency[] = resolveChildDependsOn(
    splits,
    childDelivery,
  );

  const ready: ReadyTarget[] = [];
  for (const dep of childDeps) {
    // 步骤 3：过滤 slug 失配（childUnitId === undefined），对齐 execute handler。
    if (dep.childUnitId === undefined) {
      continue;
    }
    const childId = dep.childUnitId;

    const child = store.load(childId);
    if (child === null) {
      // child 不在 store（理论不应发生，但防御）：保守跳过。
      continue;
    }

    const status = getStringField(child, "status");
    // 步骤 4a：终态 child 跳过（不再推进）。
    if (TERMINAL_STATUSES.has(status)) {
      continue;
    }

    // 步骤 4b/4c：判定依赖是否全终态。
    if (!isDependencySatisfied(dep.dependsOn, store)) {
      // 非终态但依赖未满足 → 阻塞，跳过。
      continue;
    }

    // 就绪：按 child 自身 scope 查 status→action 表（§5.3：action 须反映该 child 当前 status
    // 的下一步，不能假设都是 created）。与 frontier.ts 建节点时用 getScope(childRecord) 同模式：
    // epic/feature 的 child 是 planning 层（PLANNING_STATUS_TO_ACTION）；
    // slice 的 child 是 wave（WAVE_STATUS_TO_ACTION）。
    const childScope = getScope(child);
    const actionTable = PLANNING_SCOPES.has(childScope)
      ? PLANNING_STATUS_TO_ACTION
      : WAVE_STATUS_TO_ACTION;
    const action = actionTable[status] ?? "";
    ready.push({
      unitId: childId,
      action,
      satisfiedDependencies: dep.dependsOn,
    });
  }

  return ready;
}

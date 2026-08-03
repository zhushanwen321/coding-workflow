/**
 * 跨父子 WorkUnit 关系的只读遍历/解析工具。
 *
 * core/plan.ts 和 core/workunit.ts 是纯声明（运行时零依赖），
 * 跨实体的组合操作（如 split.dependsOn + childDelivery 反查）放此文件。
 */
import type { WorkUnitRecord } from "../store/schema.js";
import type { ChildDeliveryRecord } from "./evidence.js";
import type { Split } from "./plan.js";
import { TERMINAL_STATUSES } from "./status.js";

/** resolveChildDependsOn 的返回项——子层 unit 及其依赖。
 *
 * childUnitId 为 undefined 表示 split.slug 在 childDelivery 中找不到匹配项（slug 失配），
 * 调用方应跳过该 split——它对应的子 unit 不存在（不应下沉到调度器）。 */
export interface ChildDependency {
  childUnitId: string | undefined;
  dependsOn: string[];
}

/**
 * 从 plan.split + evidence.childDelivery 反查每个子 unit 的依赖（childUnitId 列表）。
 *
 * 只用 childDelivery 的 splitSlug + childUnitId 两字段，不读 childStatus。
 * 被 frontier 算 wave blocked（类型 B）+ execute handler 构造 ActionResult.children 消费。
 *
 * slug 失配（split.slug 在 childDelivery 中无匹配）时返回 childUnitId: undefined，
 * 而非空串——失配项对应的子 unit 不存在，不应被当作合法 children 下沉到调度器。
 */
export function resolveChildDependsOn(
  splits: ReadonlyArray<Split>,
  childDelivery: ReadonlyArray<ChildDeliveryRecord>,
): ChildDependency[] {
  const slugToChildId = new Map(
    childDelivery.map((r) => [r.splitSlug, r.childUnitId] as const),
  );
  return splits.map((s) => ({
    childUnitId: slugToChildId.get(s.slug),
    dependsOn: s.dependsOn
      .map((d) => slugToChildId.get(d))
      .filter((x): x is string => typeof x === "string"),
  }));
}

/**
 * 判断一组依赖（child unit id 列表）是否全部已满足（全部终态）。
 *
 * 终态 = closed / aborted（core/status.ts TERMINAL_STATUSES）。
 * dependsOn 为空 → 满足（true）。任一依赖 load 不到（null）或非终态 → 未满足（false）。
 *
 * 被 frontier（类型 B wave 依赖判定）消费，消除「依赖全终态判定」的重复实现。
 *
 * @param dependsOn 依赖的 child unit id 列表（来自 resolveChildDependsOn 的 ChildDependency.dependsOn）
 * @param store 只读 load 接口（FrontierStore 或 CwStore 均满足）
 */
export function isDependencySatisfied(
  dependsOn: ReadonlyArray<string>,
  store: { load: (id: string) => WorkUnitRecord | null },
): boolean {
  if (dependsOn.length === 0) {
    return true;
  }
  return dependsOn.every((id) => {
    const rec = store.load(id);
    if (rec === null) {
      return false;
    }
    const status = rec.status;
    const s = typeof status === "string" ? status : "";
    return TERMINAL_STATUSES.has(s);
  });
}

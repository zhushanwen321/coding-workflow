/**
 * 跨父子 WorkUnit 关系的只读遍历/解析工具。
 *
 * core/plan.ts 和 core/workunit.ts 是纯声明（运行时零依赖），
 * 跨实体的组合操作（如 split.dependsOn + childDelivery 反查）放此文件。
 */
import type { ChildDeliveryRecord } from "./evidence.js";
import type { Split } from "./plan.js";

/** resolveChildDependsOn 的返回项——子层 unit 及其依赖。 */
export interface ChildDependency {
  childUnitId: string;
  dependsOn: string[];
}

/**
 * 从 plan.split + evidence.childDelivery 反查每个子 unit 的依赖（childUnitId 列表）。
 *
 * 只用 childDelivery 的 splitSlug + childUnitId 两字段，不读 childStatus。
 * 被 frontier 算 wave blocked（类型 B）消费。
 */
export function resolveChildDependsOn(
  splits: ReadonlyArray<Split>,
  childDelivery: ReadonlyArray<ChildDeliveryRecord>,
): ChildDependency[] {
  const slugToChildId = new Map(
    childDelivery.map((r) => [r.splitSlug, r.childUnitId] as const),
  );
  return splits.map((s) => ({
    childUnitId: slugToChildId.get(s.slug) ?? "",
    dependsOn: s.dependsOn
      .map((d) => slugToChildId.get(d))
      .filter((x): x is string => typeof x === "string"),
  }));
}

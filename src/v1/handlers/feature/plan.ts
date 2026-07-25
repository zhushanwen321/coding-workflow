/**
 * v1 feature handler — plan action（写 Plan 基类，只 split）。
 *
 * 设计来源：core plan.Plan（基类，只有 split 字段）、
 * PLANNING_TRANSITIONS.plan（progressive，clarifying/planning/design-reviewed → planning）。
 *
 * 职责：写 unit.plan.split = input.split（Plan 基类）→ status 流转 → save。
 *
 * 与 slice plan 的关键差异：slice 写 SlicePlan（split + techChoices/interfaces/dataModels/
 * errorSpecs + decisions 投影），feature 只写 Plan 基类的 split——feature 不产技术方案，
 * 只拆 slice 清单（split 描述每个子 slice 负责上游的哪些条目，execute 时据此 createSlice）。
 * feature 的 Split 不继承 WorkUnitItem、无 status 字段（plan.ts：「拆分项无 lifecycle，不逐项废弃」）。
 *
 * 不跑独立 gate（split 结构在 design-review 阶段验，见 design-review.ts）。
 */
import type { Feature } from "../../core/workunit.js";
import type { ActionResult, PlanFeatureInput, V1Deps } from "../types.js";
import { buildFeatureNextAction, featureTransition, saveFeature } from "./feature-internal.js";

/**
 * 执行 feature plan action（progressive）。
 *
 * @param unit 已加载的 Feature（status ∈ {clarifying, planning, design-reviewed}）
 * @param input Plan 基类的 split（拆 slice 清单）
 * @param deps 依赖注入（store / clock）
 */
export function handlePlanFeature(
  unit: Feature,
  input: PlanFeatureInput,
  deps: V1Deps,
): ActionResult {
  unit.plan = { split: input.split };

  featureTransition(unit, "plan", deps.clock.now());

  saveFeature(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    nextAction: buildFeatureNextAction(unit, "plan"),
  };
}

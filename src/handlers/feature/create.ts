/**
 * v1 feature handler — create action（入口：从无到有创建 Feature）。
 *
 * 设计来源：core workunit.createFeature 工厂、PLANNING_TRANSITIONS.create（→ created）。
 *
 * 职责：调 createFeature 工厂初始化全部字段为空态 → save → 返回 status=created。
 * 不跑 gate（create 无 gate，guard 在 dispatch 层做，W6 路由 layer=feature 到本 handler）。
 *
 * 与 slice create 的差异：调 createFeature（不是 createSlice），clarifications 初始化为
 * FeatureClarification 容器对象（含空 spec），plan 为 Plan 基类（只 split）。
 */
import { createFeature } from "../../core/workunit.js";
import type { ActionResult, CreateInput, V1Deps } from "../types.js";
import { buildFeatureNextAction, saveFeature } from "./feature-internal.js";

/**
 * 执行 feature create action。
 *
 * @param args CreateInput（slug / objective / parentUnitId / basedOnParent；layer 由 dispatch 路由，本 handler 不读）
 * @param deps 依赖注入（store / clock）
 * @returns 操作结果（status=created）+ 创建的 Feature
 */
export function handleCreateFeature(
  args: CreateInput,
  deps: V1Deps,
): ActionResult & { unit: import("../../core/workunit.js").Feature } {
  const unit = createFeature({
    slug: args.slug,
    objective: args.objective,
    parentUnitId: args.parentUnitId,
    basedOnParent: args.basedOnParent,
    createdAt: deps.clock.now(),
  });
  saveFeature(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    unit,
    nextAction: buildFeatureNextAction(unit, "create"),
  };
}

/**
 * v1 epic handler — create action（入口：从无到有创建 Epic）。
 *
 * 设计来源：core workunit.createEpic 工厂、PLANNING_TRANSITIONS.create（→ created）。
 *
 * 职责：调 createEpic 工厂初始化全部字段为空态 → save → 返回 status=created。
 * 不跑 gate（create 无 gate，guard 在 dispatch 层做，W6 路由 layer=epic 到本 handler）。
 *
 * 与 feature create 的差异：调 createEpic（不是 createFeature），clarifications 初始化为
 * Clarification[] 数组（同 slice/wave，非 feature 的容器对象），plan 为 Plan 基类（只 split）。
 * epic 是 4 层顶层无父层：createEpic 不写入 parentUnitId（即使 args 传也忽略）。
 */
import { createEpic } from "../../core/workunit.js";
import type { ActionResult, CreateInput, V1Deps } from "../types.js";
import { buildEpicNextAction, saveEpic } from "./epic-internal.js";

/**
 * 执行 epic create action。
 *
 * @param args CreateInput（slug / objective / parentUnitId / basedOnParent；layer 由 dispatch 路由，本 handler 不读。
 *             parentUnitId/basedOnParent 语义上对 epic 无效——createEpic 忽略它们）
 * @param deps 依赖注入（store / clock）
 * @returns 操作结果（status=created）+ 创建的 Epic
 */
export function handleCreateEpic(
  args: CreateInput,
  deps: V1Deps,
): ActionResult & { unit: import("../../core/workunit.js").Epic } {
  const unit = createEpic({
    slug: args.slug,
    objective: args.objective,
    parentUnitId: args.parentUnitId,
    basedOnParent: args.basedOnParent,
    createdAt: deps.clock.now(),
  });
  saveEpic(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    unit,
    nextAction: buildEpicNextAction(unit, "create"),
  };
}

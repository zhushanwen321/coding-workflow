/**
 * v1 slice handler — create action（入口：从无到有创建 Slice）。
 *
 * 设计来源：v5 wave 附录 A §10（编排骨架）的 slice 对应、core workunit.createSlice 工厂。
 *
 * 职责：调 createSlice 工厂初始化全部字段为空态 → save → 返回 status=created。
 * 不跑 gate（create 无 gate，guard 在 dispatch 层做，W6 路由 layer=slice 到本 handler）。
 *
 * 与 wave create 的差异：layer='slice' 时走本 handler（createSlice 工厂），
 * layer='wave'（默认）走 wave 的 handleCreate。
 */
import { createSlice } from "../../core/workunit.js";
import type { ActionResult, CreateInput, CwDeps } from "../types.js";
import { buildSliceNextAction, saveSlice } from "./slice-internal.js";

/**
 * 执行 slice create action。
 *
 * @param args CreateInput（slug / objective / parentUnitId / basedOnParent；layer 由 dispatch 路由，本 handler 不读）
 * @param deps 依赖注入（store / clock）
 * @returns 操作结果（status=created）+ 创建的 Slice
 */
export function handleCreateSlice(
  args: CreateInput,
  deps: CwDeps,
): ActionResult & { unit: import("../../core/workunit.js").Slice } {
  const unit = createSlice({
    slug: args.slug,
    objective: args.objective,
    parentUnitId: args.parentUnitId,
    basedOnParent: args.basedOnParent,
    createdAt: deps.clock.now(),
  });
  saveSlice(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    unit,
    nextAction: buildSliceNextAction(unit, "create"),
  };
}

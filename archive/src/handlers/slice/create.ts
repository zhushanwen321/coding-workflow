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
import { PLANNING_STATUS_TO_ACTION } from "../../core/status.js";
import type { Slice } from "../../core/workunit.js";
import { createSlice } from "../../core/workunit.js";
import type { PlanningAction } from "../../rules/state-machine.js";
import { buildCreateIdempotentResult, isCreateEmptyState } from "../internal.js";
import type { ActionResult, CreateInput, CwDeps } from "../types.js";
import {
  buildSliceCurrentActionGuidance,
  buildSliceNextAction,
  saveSlice,
} from "./slice-internal.js";

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
): ActionResult & { unit: Slice } {
  // #2 create 幂等预检（D-002）：按 layer 定界（id=`slice:<slug>`），save 之前 load。
  const existing = deps.store.load(`slice:${args.slug}`);
  if (existing !== null && !isCreateEmptyState(existing)) {
    const status = typeof existing.status === "string" ? existing.status : "created";
    const currentAction = PLANNING_STATUS_TO_ACTION[status];
    const currentGuidance =
      currentAction !== undefined
        ? buildSliceCurrentActionGuidance(
            // eslint-disable-next-line taste/no-unsafe-cast -- 只读 id/status/parentUnitId/slug，record 是具名 unit 超集
            existing as unknown as Slice,
            currentAction as PlanningAction,
          )
        : "";
    return {
      ...buildCreateIdempotentResult({
        existing,
        layer: "slice",
        currentAction,
        currentGuidance,
      }),
      // eslint-disable-next-line taste/no-unsafe-cast -- 同上：existing 字段透传存储，断言安全
      unit: existing as unknown as Slice,
    };
  }

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

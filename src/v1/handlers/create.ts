/**
 * v1 wave handler — create action（入口：从无到有创建 ExecutionUnit）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、core workunit.createWave 工厂（§1.4 / §5.3）。
 *
 * 职责：调 createWave 工厂初始化全部字段为空态 → save → 返回 status=created。
 * 不跑 gate（create 无 gate，guard 已在 dispatch 层做过）。
 *
 * 不变量：create 不接收已有 unit（它是入口）；产物字段全空态，各后续 handler 逐步填充。
 */
import type { ExecutionUnit } from "../core/workunit.js";
import { createWave } from "../core/workunit.js";
import { buildNextAction, saveUnit } from "./internal.js";
import type { ActionResult, CreateInput,V1Deps } from "./types.js";

/**
 * 执行 create action。
 *
 * @param args create 参数（slug / objective / parentUnitId / basedOnParent）
 * @param deps 依赖注入（store / clock）
 * @returns 操作结果（status=created）
 */
export function handleCreate(
  args: CreateInput,
  deps: V1Deps,
): ActionResult & { unit: ExecutionUnit } {
  const unit = createWave({
    slug: args.slug,
    objective: args.objective,
    parentUnitId: args.parentUnitId,
    basedOnParent: args.basedOnParent,
    createdAt: deps.clock.now(),
  });
  saveUnit(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    unit,
    nextAction: buildNextAction(unit, "create"),
  };
}

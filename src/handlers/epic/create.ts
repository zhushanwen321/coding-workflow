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
import { PLANNING_STATUS_TO_ACTION } from "../../core/status.js";
import type { Epic } from "../../core/workunit.js";
import { createEpic } from "../../core/workunit.js";
import type { PlanningAction } from "../../rules/state-machine.js";
import { buildCreateIdempotentResult, isCreateEmptyState } from "../internal.js";
import type { ActionResult, CreateInput, CwDeps } from "../types.js";
import {
  buildEpicCurrentActionGuidance,
  buildEpicNextAction,
  saveEpic,
} from "./epic-internal.js";

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
  deps: CwDeps,
): ActionResult & { unit: Epic } {
  // #2 create 幂等预检（D-002）：按 layer 定界（id=`epic:<slug>`），save 之前 load。
  const existing = deps.store.load(`epic:${args.slug}`);
  if (existing !== null && !isCreateEmptyState(existing)) {
    const status = typeof existing.status === "string" ? existing.status : "created";
    const currentAction = PLANNING_STATUS_TO_ACTION[status];
    const currentGuidance =
      currentAction !== undefined
        ? buildEpicCurrentActionGuidance(
            // eslint-disable-next-line taste/no-unsafe-cast -- 只读 id/status/parentUnitId/slug，record 是具名 unit 超集
            existing as unknown as Epic,
            currentAction as PlanningAction,
          )
        : "";
    return {
      ...buildCreateIdempotentResult({
        existing,
        layer: "epic",
        currentAction,
        currentGuidance,
      }),
      // eslint-disable-next-line taste/no-unsafe-cast -- 同上：existing 字段透传存储，断言安全
      unit: existing as unknown as Epic,
    };
  }

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

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
import { PLANNING_STATUS_TO_ACTION } from "../../core/status.js";
import type { Feature } from "../../core/workunit.js";
import { createFeature } from "../../core/workunit.js";
import type { PlanningAction } from "../../rules/state-machine.js";
import { buildCreateIdempotentResult, isCreateEmptyState } from "../internal.js";
import type { ActionResult, CreateInput, CwDeps } from "../types.js";
import {
  buildFeatureCurrentActionGuidance,
  buildFeatureNextAction,
  saveFeature,
} from "./feature-internal.js";

/**
 * 执行 feature create action。
 *
 * @param args CreateInput（slug / objective / parentUnitId / basedOnParent；layer 由 dispatch 路由，本 handler 不读）
 * @param deps 依赖注入（store / clock）
 * @returns 操作结果（status=created）+ 创建的 Feature
 */
export function handleCreateFeature(
  args: CreateInput,
  deps: CwDeps,
): ActionResult & { unit: Feature } {
  // #2 create 幂等预检（D-002）：按 layer 定界（id=`feature:<slug>`），save 之前 load。
  const existing = deps.store.load(`feature:${args.slug}`);
  if (existing !== null && !isCreateEmptyState(existing)) {
    const status = typeof existing.status === "string" ? existing.status : "created";
    const currentAction = PLANNING_STATUS_TO_ACTION[status];
    const currentGuidance =
      currentAction !== undefined
        ? buildFeatureCurrentActionGuidance(
            // eslint-disable-next-line taste/no-unsafe-cast -- 只读 id/status/parentUnitId/slug，record 是具名 unit 超集
            existing as unknown as Feature,
            currentAction as PlanningAction,
          )
        : "";
    return {
      ...buildCreateIdempotentResult({
        existing,
        layer: "feature",
        currentAction,
        currentGuidance,
      }),
      // eslint-disable-next-line taste/no-unsafe-cast -- 同上：existing 字段透传存储，断言安全
      unit: existing as unknown as Feature,
    };
  }

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

/**
 * v1 epic handler — design action（写 Plan 基类，只 split + append clarifications）。
 *
 * 设计来源：core plan.Plan（基类，只有 split 字段）、
 * PLANNING_TRANSITIONS.design（progressive，created/designing/design-reviewed → designing）。
 *
 * 职责：append input.clarifications（渐进式，承接原 clarify action）→
 *       写 unit.plan.split = input.split（Plan 基类）→ status 流转 → save。
 *
 * 与 feature design 同构：epic 也只写 Plan 基类的 split——epic 不产技术方案也不产 spec，
 * 只拆 feature 清单（split 描述每个子 feature 负责上游的哪些条目，execute 时据此 createFeature）。
 * epic 的 Split 不继承 WorkUnitItem、无 status 字段（plan.ts：「拆分项无 lifecycle，不逐项废弃」）。
 *
 * Input 复用 DesignFeatureInput（epic 与 feature 的 design input 同型，都是 { split: Split[] }），
 * dispatch wave 会导出 DesignEpicInput 别名保持命名对称。
 *
 * 不跑独立 gate（split 结构在 design-review 阶段验，见 design-review.ts）。
 */
import type { Epic } from "../../core/workunit.js";
import type { ActionResult, CwDeps,DesignFeatureInput } from "../types.js";
import { validateInput } from "../validate-input.js";
import { buildEpicNextAction, epicTransition, saveEpic } from "./epic-internal.js";

/**
 * 执行 epic design action（progressive）。
 *
 * @param unit 已加载的 Epic（status ∈ {created, designing, design-reviewed}）
 * @param input Plan 基类的 split（拆 feature 清单）+ 可选 clarifications
 * @param deps 依赖注入（store / clock）
 */
export function handleDesignEpic(
  unit: Epic,
  input: DesignFeatureInput,
  deps: CwDeps,
): ActionResult {
  validateInput("design", "epic", input);
  // 写产物：append clarifications（progressive，不覆盖历史，承接原 clarify action）
  if (input.clarifications?.length) {
    unit.clarifications = [...unit.clarifications, ...input.clarifications];
  }
  unit.plan = { split: input.split };

  epicTransition(unit, "design", deps.clock.now());

  saveEpic(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    nextAction: buildEpicNextAction(unit, "design"),
  };
}

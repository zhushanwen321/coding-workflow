/**
 * v1 feature handler — design action（写 Plan 基类，只 split + spec 覆盖 + append clarifications）。
 *
 * 设计来源：core plan.Plan（基类，只有 split 字段）、
 * PLANNING_TRANSITIONS.design（progressive，created/designing/design-reviewed → designing）。
 *
 * 职责：
 * 1. input.spec 存在时：先 validateFeatureSpec（结构校验，防畸形 spec 入库），通过后覆盖写
 *    unit.clarifications.spec（feature 的 spec 是 design 阶段产物，每次提交整体覆盖——
 *    spec 语义是“当前完整规格”，非渐进追加）
 * 2. append input.clarifications 到 unit.clarifications.clarifications（渐进式）
 * 3. 写 unit.plan.split = input.split（Plan 基类）→ status 流转 → save。
 *
 * 与 slice design 的关键差异：slice 写 SlicePlan（split + techChoices/interfaces/dataModels/
 * errorSpecs + decisions 投影），feature 只写 Plan 基类的 split——feature 不产技术方案，
 * 只拆 slice 清单（split 描述每个子 slice 负责上游的哪些条目，execute 时据此 createSlice）。
 * feature 的 Split 不继承 WorkUnitItem、无 status 字段（plan.ts：「拆分项无 lifecycle，不逐项废弃」）。
 *
 * 不跑独立 gate（split 结构在 design-review 阶段验，见 design-review.ts）。
 */
import type { Feature } from "../../core/workunit.js";
import { validateFeatureSpec } from "../../rules/spec-schema.js";
import { mergeAbandonParentItems } from "../internal.js";
import type { ActionResult, CwDeps,DesignFeatureInput } from "../types.js";
import { validateInput } from "../validate-input.js";
import {
  appendFeatureFailRecord,
  buildFeatureFailureNextAction,
  buildFeatureNextAction,
  featureTransition,
  saveFeature,
} from "./feature-internal.js";

/**
 * 执行 feature design action（progressive）。
 *
 * @param unit 已加载的 Feature（status ∈ {created, designing, design-reviewed}）
 * @param input Plan 基类的 split（拆 slice 清单）+ 可选 spec/clarifications
 * @param deps 依赖注入（store / clock）
 */
export function handleDesignFeature(
  unit: Feature,
  input: DesignFeatureInput,
  deps: CwDeps,
): ActionResult {
  validateInput("design", "feature", input);

  // 写入前先校验 spec 结构（防畸形 spec 入库导致下游 gate undefined 崩溃）。
  // 校验失败短路：不改 status、不写 spec，只 append fail 记录供 failureCount 派生，
  // 返回可读 error（含具体字段路径）让 agent 修正后重提。
  if (input.spec) {
    const validation = validateFeatureSpec(input.spec);
    if (!validation.valid) {
      const reason = `feature spec 结构校验失败: ${validation.errors.join("; ")}`;
      appendFeatureFailRecord(deps, unit, "design", reason);
      const { nextAction, failureCount } = buildFeatureFailureNextAction(unit, "design", reason);
      return {
        unitId: unit.id,
        status: unit.status,
        ok: false,
        error: reason,
        nextAction,
        failureCount,
      };
    }
    // spec 覆盖写（spec 是“当前完整规格”语义，每次提交整体覆盖）
    unit.clarifications = { ...unit.clarifications, spec: input.spec };
  }

  // append clarifications（渐进式，不覆盖历史）
  if (input.clarifications?.length) {
    unit.clarifications = {
      ...unit.clarifications,
      clarifications: [...unit.clarifications.clarifications, ...input.clarifications],
    };
  }

  unit.plan = { split: input.split };

  // abandon parent 条目声明（ADR-0010 跨层跨时机通道）：append-only 合并到 unit.abandonedParentItems
  mergeAbandonParentItems(unit, input);

  featureTransition(unit, "design", deps.clock.now());

  saveFeature(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    nextAction: buildFeatureNextAction(unit, "design"),
  };
}

/**
 * v1 slice handler — design action（写 SlicePlan 5 字段 + split + decisions 投影 + append clarifications）。
 *
 * 设计来源：core plan.SlicePlan（techChoices/interfaces/dataModels/errorSpecs/split + decisions）、
 * core clarifications.Decision（投影自 Clarification，model §5.10）、
 * PLANNING_TRANSITIONS.design（progressive，created/designing/design-reviewed → designing）。
 *
 * 职责：
 * 1. append input.clarifications（渐进式，承接原 clarify action）
 * 2. 写 SlicePlan 5 字段：techChoices/interfaces/dataModels/errorSpecs/split
 * 3. decisions：input 提供 → 用；否则从 unit.clarifications 投影（每个有 resolution 的 Clarification
 *    生成一条 Decision，最小投影：id/decision/sourceClarification = Clarification.id，rationale 取 resolution）
 * 4. status 流转 → designing（progressive 原地）→ save
 *
 * 不跑独立 gate（split 结构在 design-review 阶段验，见 design-review.ts）。
 */
import type { Decision } from "../../core/clarifications.js";
import type { Slice } from "../../core/workunit.js";
import { mergeAbandonParentItems } from "../internal.js";
import type { ActionResult, CwDeps,DesignSliceInput } from "../types.js";
import { validateInput } from "../validate-input.js";
import { buildSliceNextAction, saveSlice, sliceTransition } from "./slice-internal.js";

/**
 * 执行 slice design action（progressive）。
 *
 * @param unit 已加载的 Slice（status ∈ {created, designing, design-reviewed}）
 * @param input SlicePlan 5 字段 + split + 可选 decisions/clarifications
 * @param deps 依赖注入（store / clock）
 */
export function handleDesignSlice(
  unit: Slice,
  input: DesignSliceInput,
  deps: CwDeps,
): ActionResult {
  validateInput("design", "slice", input);
  // 写产物：append clarifications（progressive，不覆盖历史，承接原 clarify action）
  if (input.clarifications?.length) {
    unit.clarifications = [...unit.clarifications, ...input.clarifications];
  }
  const decisions = input.decisions ?? projectDecisionsFromClarifications(unit);

  unit.plan = {
    split: input.split,
    techChoices: input.techChoices,
    interfaces: input.interfaces,
    dataModels: input.dataModels,
    errorSpecs: input.errorSpecs,
    decisions,
  };

  // abandon parent 条目声明（ADR-0010 跨层跨时机通道）：append-only 合并到 unit.abandonedParentItems
  mergeAbandonParentItems(unit, input);

  sliceTransition(unit, "design", deps.clock.now());

  saveSlice(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    nextAction: buildSliceNextAction(unit, "design"),
  };
}

/**
 * 从 unit.clarifications 投影 Decision 列表（model §5.10）。
 *
 * 规则：每个有非空 resolution 的 Clarification 生成一条 Decision：
 *   - id = sourceClarification = Clarification.id
 *   - decision = resolution
 *   - rationale = resolution（最小投影——agent 可在后续 overwrite，无独立 rationale 字段时复用）
 *
 * 已答（resolution 非空）才投影；未答的跳过。
 */
function projectDecisionsFromClarifications(unit: Slice): Decision[] {
  const decisions: Decision[] = [];
  for (const c of unit.clarifications) {
    if (c.resolution === undefined || c.resolution.trim() === "") continue;
    decisions.push({
      id: c.id,
      decision: c.resolution,
      rationale: c.resolution,
      sourceClarification: c.id,
    });
  }
  return decisions;
}

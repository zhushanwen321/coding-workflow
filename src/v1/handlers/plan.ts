/**
 * v1 wave handler — plan action（写 WavePlan 4 类条目）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、§3（WavePlan 4 类条目：testCases/tasks/files/contracts）、
 *      state-machine WAVE_TRANSITIONS.plan（progressive，from 含 design-reviewed）。
 *
 * 职责：写 plan.{testCases,tasks,files,contracts} → status 流转（→ planning）→ save。
 *      progressive：可在 clarifying/planning/design-reviewed 重复触发（wave 特化：design-reviewed 后可回流改 testCases）。
 *
 * 不变量：plan 无独立 gate（testCases 结构在 design-review 阶段才验，见 design-review.ts）。
 */
import type { ExecutionUnit } from "../core/workunit.js";
import { saveUnit,transitionStatus } from "./internal.js";
import type { ActionResult, PlanInput,V1Deps } from "./types.js";

/**
 * 执行 plan action（progressive）。
 *
 * @param unit 已加载的 ExecutionUnit（status ∈ {clarifying, planning, design-reviewed}）
 * @param input WavePlan 4 类条目（testCases/tasks/files/contracts）
 * @param deps 依赖注入（store / clock）
 */
export function handlePlan(
  unit: ExecutionUnit,
  input: PlanInput,
  deps: V1Deps,
): ActionResult {
  // 写产物：整体替换 plan 的 4 类条目（wave 是叶子，split 恒为 []）
  unit.plan = {
    split: [],
    testCases: input.testCases,
    tasks: input.tasks,
    files: input.files,
    contracts: input.contracts,
  };

  // status 流转 → planning（progressive 原地）+ append statusHistory
  transitionStatus(unit, "plan", deps.clock.now());

  saveUnit(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
  };
}

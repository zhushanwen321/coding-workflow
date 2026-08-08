/**
 * v1 wave handler — design action（写 WavePlan 4 类条目 + append clarifications）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、§3（WavePlan 4 类条目：testCases/tasks/files/contracts）、
 *      state-machine WAVE_TRANSITIONS.design（progressive，from 含 design-reviewed）。
 *
 * 职责：append input.clarifications → 写 unit.plan.{testCases,tasks,files,contracts} → status 流转（→ designing）→ save。
 *      progressive：可在 created/designing/design-reviewed 重复触发（wave 特化：design-reviewed 后可回流改 testCases）。
 *      clarifications 是渐进式 append（不覆盖历史，承接 progressive append 的 clarifications 写入）。
 *
 * 不变量：design 无独立 gate（testCases 结构在 design-review 阶段才验，见 design-review.ts）。
 */
import type { ExecutionUnit } from "../core/workunit.js";
import { buildNextAction, mergeAbandonParentItems, saveUnit,transitionStatus } from "./internal.js";
import type { ActionResult, CwDeps,DesignInput } from "./types.js";
import { validateInput } from "./validate-input.js";

/**
 * 执行 design action（progressive）。
 *
 * @param unit 已加载的 ExecutionUnit（status ∈ {created, designing, design-reviewed}）
 * @param input WavePlan 4 类条目（testCases/tasks/files/contracts）+ 可选 clarifications
 * @param deps 依赖注入（store / clock）
 */
export function handleDesign(
  unit: ExecutionUnit,
  input: DesignInput,
  deps: CwDeps,
): ActionResult {
  validateInput("design", "wave", input);
  // 写产物：append clarifications（progressive，不覆盖历史，承接 progressive append 的 clarifications）
  if (input.clarifications?.length) {
    unit.clarifications = [...unit.clarifications, ...input.clarifications];
  }
  // 写 unit.plan：整体替换 unit.plan 的 4 类条目（wave 是叶子，split 恒为 []）
  unit.plan = {
    split: [],
    testCases: input.testCases,
    tasks: input.tasks,
    files: input.files,
    contracts: input.contracts,
    testCommand: input.testCommand,
    testCwd: input.testCwd,
  };

  // abandon parent 条目声明（ADR-0010 跨层跨时机通道）：append-only 合并到 unit.abandonedParentItems
  mergeAbandonParentItems(unit, input);

  // status 流转 → designing（progressive 原地）+ append statusHistory
  transitionStatus(unit, "design", deps.clock.now());

  saveUnit(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    nextAction: buildNextAction(unit, "design"),
  };
}

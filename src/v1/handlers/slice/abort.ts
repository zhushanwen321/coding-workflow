/**
 * v1 slice handler — abort action（级联 abort 所有 child wave + 流转 aborted）。
 *
 * 设计来源：model §5.6（abort 机制：级联 + append-only）、§3.1（aborted 终态不可逆）、
 * PLANNING_TRANSITIONS.abort（from ∈ 非终态集合，→ aborted）。
 *
 * 职责：
 * 1. 级联 abort 所有 child wave（及更深子孙）：findChildren → 每个 non-terminal → 置 'aborted'
 *    + append statusHistory（action='abort', note=reason）→ 递归 → save
 * 2. （可选）append unit.abandonedRefs（若 input 带废弃引用——本 handler 预留，AbortInput 当前无此字段）
 * 3. status 流转（→ aborted）+ append statusHistory（action='abort', note=reason）→ save
 *
 * 与 wave abort 的差异：wave 的 cascadeAbortChildren 复用 wave 的 nextWaveStatus（wave 专属）；
 * slice abort 的 child 是 wave，直接把 child status 字段置为字符串 'aborted'（不调状态机函数，
 * 因为级联 abort 是强制终态转换，绕过 progressive/旁路语义）。机制等价——aborted 是两种状态机的公共终态。
 *
 * 注意：abort 不删任何数据（append-only）。aborted 是终态不可逆。
 */
import type { StatusChange, WorkUnitStatus } from "../../core/status.js";
import type { Slice } from "../../core/workunit.js";
import { rollupChildDelivery } from "../rollup.js";
import type { AbortInput, ActionResult, V1Deps } from "../types.js";
import { buildSliceNextAction, readRecordStatus, readRecordStatusHistory, saveSlice, sliceTransition } from "./slice-internal.js";

/**
 * 执行 slice abort action（级联）。
 *
 * @param unit 已加载的 Slice（status ∈ 非终态集合，见 PLANNING_TRANSITIONS.abort.from）
 * @param input reason（abort 原因，写 statusHistory.note）
 * @param deps 依赖注入（store / clock）
 */
export function handleAbortSlice(
  unit: Slice,
  input: AbortInput,
  deps: V1Deps,
): ActionResult {
  const at = deps.clock.now();

  // ── 自身 status 流转 → aborted ──
  // 先落盘自身（cascadeAbortChildren 内 rollup 会读 parent 的最新状态，避免被后续 saveSlice 覆盖）
  sliceTransition(unit, "abort", at, input.reason);
  saveSlice(deps, unit);

  // ── 级联 abort 所有 child wave（及更深子孙）──
  cascadeAbortChildren(deps, unit.id, at, input.reason);

  // slice 自身 abort 完成（status→aborted）→ rollup 到 parent（feature/epic）的 childDelivery。
  if (unit.parentUnitId !== undefined && unit.parentUnitId !== "") {
    rollupChildDelivery(deps, unit.id);
  }
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    nextAction: buildSliceNextAction(unit, "abort"),
  };
}

/**
 * 递归级联 abort 子孙 unit：置 status='aborted' + append statusHistory，save。
 *
 * 子孙 record 来自 store（扁平结构），直接读写 status / statusHistory 字段并 save。
 * 已是终态（closed/aborted）的子孙跳过（不可逆，无需重复 abort）。
 *
 * @param deps 依赖注入
 * @param parentId 起始父 unit id
 * @param at ISO 时间戳
 * @param reason abort 原因（写 statusHistory.note）
 */
function cascadeAbortChildren(
  deps: V1Deps,
  parentId: string,
  at: string,
  reason: string | undefined,
): void {
  const children = deps.store.findChildren(parentId);
  for (const child of children) {
    const childStatus = readRecordStatus(child);
    // 只跳过已 aborted（幂等：防重复 append abandonedRefs）。
    // closed 不跳过——slice §6.1：引用废弃条目的子孙一律 abort，不区分是否已 closeout。
    if (childStatus === "aborted") continue;

    const change: StatusChange = {
      from: childStatus as WorkUnitStatus,
      to: "aborted",
      at,
      action: "abort",
      note: reason ?? `级联 abort（父 unit ${parentId} 被 abort）`,
    };
    const history = readRecordStatusHistory(child);
    history.push(change);
    child.statusHistory = history;
    child.status = "aborted";
    deps.store.save(child);
    // 级联 abort 的 child（终态变更）→ rollup 到 child 的 parent 的 childDelivery。
    // child 的 parent 可能是当前 slice 或更上层；rollupChildDelivery 内部按 child.parentUnitId 定位。
    if (child.parentUnitId !== undefined && child.parentUnitId !== "") {
      rollupChildDelivery(deps, child.id);
    }

    // 递归下一层
    cascadeAbortChildren(deps, child.id, at, reason);
  }
}

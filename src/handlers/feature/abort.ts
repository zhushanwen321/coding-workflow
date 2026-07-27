/**
 * v1 feature handler — abort action（级联 abort 所有 child slice + 流转 aborted）。
 *
 * 设计来源：model §5.6（abort 机制：级联 + append-only）、§3.1（aborted 终态不可逆）、
 * PLANNING_TRANSITIONS.abort（from ∈ 非终态集合，→ aborted）。
 *
 * 职责：
 * 1. 级联 abort 所有 child slice（及更深子孙 wave）：findChildren → 每个 non-terminal → 置 'aborted'
 *    + append statusHistory（action='abort', note=reason）→ 递归 → save
 * 2. status 流转（→ aborted）+ append statusHistory（action='abort', note=reason）→ save
 *
 * 与 slice abort 的差异：feature 的 child 是 slice（slice 的 child 是 wave）。机制等价——
 * 级联 abort 直接把 child status 字段置为字符串 'aborted'（不调状态机函数，绕过 progressive/旁路
 * 语义，aborted 是所有层状态机的公共终态）。已终态（closed/aborted）的子孙跳过。
 *
 * 注意：abort 不删任何数据（append-only）。aborted 是终态不可逆。
 */
import type { StatusChange, WorkUnitStatus } from "../../core/status.js";
import type { Feature } from "../../core/workunit.js";
import { rollupChildDelivery } from "../rollup.js";
import type { AbortInput, ActionResult, V1Deps } from "../types.js";
import { buildFeatureNextAction, featureTransition, readRecordStatus, readRecordStatusHistory, saveFeature } from "./feature-internal.js";

/**
 * 执行 feature abort action（级联）。
 *
 * @param unit 已加载的 Feature（status ∈ 非终态集合，见 PLANNING_TRANSITIONS.abort.from）
 * @param input reason（abort 原因，写 statusHistory.note）
 * @param deps 依赖注入（store / clock）
 */
export function handleAbortFeature(
  unit: Feature,
  input: AbortInput,
  deps: V1Deps,
): ActionResult {
  const at = deps.clock.now();

  // ── 自身 status 流转 → aborted ──
  // 先落盘自身（cascadeAbortChildren 内 rollup 读 parent 最新状态，避免被后续 saveFeature 覆盖）
  featureTransition(unit, "abort", at, input.reason);
  saveFeature(deps, unit);

  // ── 级联 abort 所有 child slice（及更深子孙 wave）──
  cascadeAbortChildren(deps, unit.id, at, input.reason);

  // feature 自身 abort 完成（status→aborted）→ rollup 到 parent（epic）的 childDelivery。
  if (unit.parentUnitId !== undefined && unit.parentUnitId !== "") {
    rollupChildDelivery(deps, unit.id);
  }
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    nextAction: buildFeatureNextAction(unit, "abort"),
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
    // 已终态跳过（closed/aborted 不可逆，无需重复 abort）
    if (childStatus === "closed" || childStatus === "aborted") continue;

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
    if (child.parentUnitId !== undefined && child.parentUnitId !== "") {
      rollupChildDelivery(deps, child.id);
    }

    // 递归下一层
    cascadeAbortChildren(deps, child.id, at, reason);
  }
}

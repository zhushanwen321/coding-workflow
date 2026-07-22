/**
 * v1 wave handler — abort action（级联 abort 子孙 + append abandonedRefs + status 流转）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、model §5.6（abort 机制：级联 + append-only）、
 *      §5.6.1（abandonedRefs：被上游废弃影响的记录）、§3.2（aborted 终态不可逆）、
 *      wave §8.1（wave 是叶子通常无子孙，但机制跑通）。
 *
 * 职责：
 * 1. 级联 abort 子孙：findChildren → 递归（wave 叶子通常无子孙，但机制通用）
 *    —— 子孙直接置 status="aborted" + append statusHistory，save
 * 2. append abandonedRefs（若有上游废弃引用——本 handler 不直接产出，预留追加入口）
 * 3. status 流转 → aborted（nextWaveStatus("abort", current)）+ append statusHistory（action="abort", note=reason）
 * 4. save
 *
 * 注意：abort 不删任何数据（append-only，commit 留 git，新 wave 可参考）。aborted 是终态不可逆。
 */
import type { ExecutionStatus, StatusChange } from "../core/status.js";
import type { ExecutionUnit } from "../core/workunit.js";
import { nextWaveStatus } from "../rules/state-machine.js";
import type { WorkUnitRecord } from "../store/schema.js";
import { saveUnit } from "./internal.js";
import type { AbortInput,ActionResult, V1Deps } from "./types.js";

/**
 * 执行 abort action（级联）。
 *
 * @param unit 已加载的 ExecutionUnit（status ∈ 非终态集合，见 WAVE_TRANSITIONS.abort.from）
 * @param input reason（abort 原因，写 statusHistory.note）
 * @param deps 依赖注入（store / clock）
 */
export function handleAbort(
  unit: ExecutionUnit,
  input: AbortInput,
  deps: V1Deps,
): ActionResult {
  const at = deps.clock.now();

  // ── 级联 abort 子孙（wave 叶子通常无子孙，机制通用）──
  cascadeAbortChildren(unit.id, at, deps);

  // ── 自身 status 流转 → aborted + append statusHistory ──
  const from = unit.status;
  const next = nextWaveStatus("abort", from);
  unit.statusHistory.push({
    from,
    to: next,
    at,
    action: "abort",
    note: input.reason,
  });
  unit.status = next;

  saveUnit(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
  };
}

/**
 * 递归级联 abort 子孙 unit：置 status="aborted" + append statusHistory，save。
 *
 * 子孙 record 来自 store（扁平结构），直接读写 record 的 status / statusHistory 字段并 save。
 * 已是终态（closed/aborted）的子孙跳过（不可逆，无需重复 abort）。
 */
function cascadeAbortChildren(
  parentId: string,
  at: string,
  deps: V1Deps,
): void {
  const children = deps.store.findChildren(parentId);
  for (const child of children) {
    const childStatus = readStatus(child);
    // 已终态跳过（closed/aborted 不可逆）
    if (childStatus === "closed" || childStatus === "aborted") continue;

    const next = nextWaveStatus("abort", childStatus);
    const change: StatusChange = {
      from: childStatus,
      to: next,
      at,
      action: "abort",
      note: `级联 abort（父 unit ${parentId} 被 abort）`,
    };
    const history = readStatusHistory(child);
    history.push(change);
    child.status = next;
    child.statusHistory = history;
    deps.store.save(child);

    // 递归下一层
    cascadeAbortChildren(child.id, at, deps);
  }
}

/** 从 record 安全读 status（默认 created）。 */
function readStatus(record: WorkUnitRecord): ExecutionStatus {
  const s = record.status;
  return (s ?? "created") as ExecutionStatus;
}

/** 从 record 安全读 statusHistory（默认空数组）。 */
function readStatusHistory(record: WorkUnitRecord): StatusChange[] {
  const h = record.statusHistory;
  return Array.isArray(h) ? [...(h as StatusChange[])] : [];
}

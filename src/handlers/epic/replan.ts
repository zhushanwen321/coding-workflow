/**
 * v1 epic handler — replan action（computeImpactCascade 级联 abort + 旁路 statusHistory）。
 *
 * 设计来源：model §5.6.2（replan 流程 Step 2-4：影响面计算 + 级联 abort）、
 * rules replan.computeImpactCascade（多层级联传播）、
 * PLANNING_TRANSITIONS.replan（旁路，from ∈ {design-reviewed, executing}，to=undefined）。
 *
 * 职责：
 * 1. 本地标记：把 abandonedIds 命中的 epic Clarification 标 status='abandoned'（append-only，不删）。
 *    与 feature replan 标废弃 FR/AC/UC、slice replan 标废弃 plan 条目同构。
 * 2. computeImpactCascade({unit, abandonedIds, loadChildren})：算多层级联影响面
 *    - loadChildren：store.findChildren → 映射 WorkUnitBase[]
 * 3. 对返回的 aborted 列表里每个 child unit：加载、置 status='aborted'、append statusHistory
 *    （action='abort', note='级联 abort'）、append abandonedRefs、save
 * 4. append unit 自己的 statusHistory（from=to=current, action='replan', note=input.note）→ save
 * 5. 返回 ok=true + replanImpact + nextAction.action='plan'（replan 后回 planning 重走 design-review）
 *
 * 与 feature replan 同构（跳过 freeze 校验）：
 * - feature/epic plan 是 Plan 基类，只有 split（Split 不继承 WorkUnitItem、无 status 字段，不可废弃），
 *   故 plan 无可标 abandoned 的条目——没有可被偷偷删改的 WorkUnitItem 条目，
 *   也就不存在可违反的 append-only 约束，跳过 checkFreezePlanning。
 *   根因：checkFreezePlanning 签名锁 Slice（强读 SlicePlan 4 个技术字段），feature/epic plan 无这些字段，
 *   类型不兼容。
 * - abandonedIds 语义：废弃的 epic Clarification id（epic 不产 spec，可废弃条目只有 clarifications 数组
 *   里的 Clarification）。epic execute 时把 split.inheritedItemIds 写入 child feature 的 basedOnParent，
 *   故废弃的 Clarification id 通过 basedOnParent 链路被 computeImpactCascade 命中，触发相关 child feature
 *   级联 abort（核心机制与 feature 一致）。
 */
import type { WorkUnitStatus } from "../../core/status.js";
import type { Epic } from "../../core/workunit.js";
import { computeImpactCascade } from "../../rules/replan.js";
import {
  loadChildrenAsWorkUnitBase,
  readAbandonedRefs,
  readRecordStatusHistory,
} from "../internal.js";
import { rollupChildDelivery } from "../rollup.js";
import type { ActionResult, ReplanInput, V1Deps } from "../types.js";
import {
  buildEpicNextAction,
  epicTransition,
  readRecordStatus,
  saveEpic,
} from "./epic-internal.js";

/**
 * 执行 epic replan action（旁路，不改 status）。
 *
 * @param unit 已加载的 Epic（status ∈ {design-reviewed, executing}）
 * @param input abandonedIds（废弃的 epic Clarification id）+ note（replan 原因）
 * @param deps 依赖注入（store / clock）
 */
export function handleReplanEpic(
  unit: Epic,
  input: ReplanInput,
  deps: V1Deps,
): ActionResult {
  const at = deps.clock.now();

  // ── 本地变更 Step 1：把 abandonedIds 命中的 epic Clarification 标 status='abandoned'（append-only，不删）──
  // epic 是顶层 PlanningUnit，clarifications 为 Clarification[]（数组形态，非 feature 的 FeatureClarification 容器）。
  // Clarification extends WorkUnitItem 有 status 字段，与 feature replan 标废弃 FR/AC/UC、slice replan 标废弃 plan 条目同构。
  if (input.abandonedIds.length > 0) {
    const abandonedSet = new Set(input.abandonedIds);
    unit.clarifications = unit.clarifications.map((c) =>
      abandonedSet.has(c.id) ? { ...c, status: "abandoned" as const } : c,
    );
  }

  // ── computeImpactCascade：多层级联影响面 ──
  // （epic plan 无可标 abandoned 的 plan 条目，跳过 slice 的 plan 改动 + checkFreezePlanning 步骤）
  const replanImpact = computeImpactCascade({
    unit,
    abandonedIds: input.abandonedIds,
    loadChildren: (parentId) => loadChildrenAsWorkUnitBase(deps.store, parentId, "feature"),
  });

  // ── replan 旁路：status 不变，append statusHistory（from=to=current, action='replan', note）──
  epicTransition(unit, "replan", at, input.note);

  // 先落盘自身（cascadeAbortUnit 内 rollup 读 parent 最新状态，避免被后续 saveEpic 覆盖）
  saveEpic(deps, unit);

  // ── 级联 abort 受影响 child unit ──
  for (const childUnitId of replanImpact.aborted) {
    cascadeAbortUnit(deps, childUnitId, at, input.abandonedIds);
  }
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    replanImpact,
    nextAction: buildEpicNextAction(unit, "replan"),
  };
}

// ═══════════════════════════════════════════════════════════════
// 辅助：级联 abort 单个受影响 child unit（及其子孙）
// ═══════════════════════════════════════════════════════════════

/**
 * 级联 abort 一个受影响 unit：置 status='aborted' + append statusHistory + append abandonedRefs，
 * 递归其子孙。已终态（closed/aborted）跳过。
 *
 * child unit 可能是 feature 或更深 slice/wave，统一按 WorkUnitRecord 读写（扁平存储，字段 unknown 透传）。
 *
 * @param store store（save/findChildren）
 * @param unitId 受影响 unit id
 * @param at ISO 时间戳
 * @param abandonedIds 触发本次级联的废弃条目 id（写入 abandonedRefs.workUnitItemId）
 */
function cascadeAbortUnit(
  deps: V1Deps,
  unitId: string,
  at: string,
  abandonedIds: string[],
): void {
  const store = deps.store;
  const record = store.load(unitId);
  if (record === null) return;

  const currentStatus = readRecordStatus(record);
  // 只跳过已 aborted（幂等：防重复 append abandonedRefs）。
  // closed 不跳过——slice §6.1：引用废弃条目的子孙一律 abort，不区分是否已 closeout。
  if (currentStatus === "aborted") return;

  // append statusHistory（action='abort'）
  const history = readRecordStatusHistory(record);
  history.push({
    from: currentStatus as WorkUnitStatus,
    to: "aborted",
    at,
    action: "abort",
    note: "级联 abort（parent epic replan 废弃条目）",
  });
  record.statusHistory = history;
  record.status = "aborted";

  // append abandonedRefs（每个废弃 id 一条）
  const abandonedRefs = readAbandonedRefs(record);
  for (const itemId of abandonedIds) {
    abandonedRefs.push({ workUnitItemId: itemId, abandonedAt: at });
  }
  record.abandonedRefs = abandonedRefs;

  store.save(record);
  // 级联 abort 的 record（终态变更）→ rollup 到 record 的 parent 的 childDelivery。
  if (record.parentUnitId !== undefined && record.parentUnitId !== "") {
    rollupChildDelivery(deps, record.id);
  }

  // 递归子孙
  const descendants = store.findChildren(unitId);
  for (const desc of descendants) {
    cascadeAbortUnit(deps, desc.id, at, abandonedIds);
  }
}

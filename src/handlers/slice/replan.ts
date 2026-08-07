/**
 * v1 slice handler — replan action（freeze 校验 + 级联影响面计算 + 旁路 statusHistory）。
 *
 * 设计来源：model §5.6.2（replan 流程 Step 2-4：影响面计算 + 级联 abort）、
 * rules freeze.checkFreezePlanning（SlicePlan 4 类条目 append-only 校验）、
 * rules replan.computeImpactCascade（多层级联传播）、
 * PLANNING_TRANSITIONS.replan（旁路，from ∈ {design-reviewed, executing}，to=undefined）。
 *
 * 职责：
 * 1. before = 深拷贝 unit
 * 2. 改 unit.plan：把 abandonedIds 命中的 techChoices/interfaces/dataModels/errorSpecs 条目
 *    status 改为 'abandoned'（append-only，不删；decisions 不继承 WorkUnitItem，跳过）
 * 3. checkFreezePlanning(before, after)：有 violation → 短路返回 ok=false（不 save）
 * 4. computeImpactCascade({unit, abandonedIds, loadChildren})：算多层级联影响面
 *    - loadChildren：store.findChildren → 映射 WorkUnitBase[]
 * 5. 对返回的 aborted 列表里每个 child unit：加载、置 status='aborted'、append statusHistory
 *    （action='abort', note='级联 abort'）、append abandonedRefs、save
 * 6. append unit 自己的 statusHistory（from=to=current, action='replan', note=input.note）→ save
 * 7. 返回 ok=true + replanImpact + nextAction.action='design'（replan 后回 planning 重走 design-review）
 *
 * 与 wave replan 的差异：
 * - 用 checkFreezePlanning（不是 checkFreeze）
 * - 用 computeImpactCascade（多层级联，不是 wave 的 computeImpact 单层）
 * - slice 有子孙（child wave），级联 abort 会实际触发
 */
import type {
  SliceDataModel,
  SliceErrorSpec,
  SliceInterface,
  SliceTechChoice,
} from "../../core/plan.js";
import type { WorkUnitStatus } from "../../core/status.js";
import type { Slice } from "../../core/workunit.js";
import { buildReplanGuidance } from "../../guidance/build-guidance.js";
import { buildPrefix } from "../../guidance/index.js";
import { checkFreezePlanning } from "../../rules/freeze.js";
import { computeImpactCascade } from "../../rules/replan.js";
import { buildCommand, inputFilePath } from "../../utils/command.js";
import {
  loadChildrenAsWorkUnitBase,
  mergeAbandonParentItems,
  readAbandonedRefs,
  readRecordStatusHistory,
} from "../internal.js";
import { rollupChildDelivery } from "../rollup.js";
import type { ActionResult, CwDeps,ReplanInput } from "../types.js";
import { validateInput } from "../validate-input.js";
import {
  appendSliceFailRecord,
  buildSliceFailureNextAction,
  buildSliceNextAction,
  getSliceSchemaText,
  readRecordStatus,
  saveSlice,
  SLICE_STATUS_DISPLAY,
  sliceTransition,
} from "./slice-internal.js";

/**
 * 执行 slice replan action（旁路，不改 status）。
 *
 * @param unit 已加载的 Slice（status ∈ {design-reviewed, executing}）
 * @param input abandonedIds（废弃的 SlicePlan 条目 id）+ note（replan 原因）
 * @param deps 依赖注入（store / clock）
 */
export function handleReplanSlice(
  unit: Slice,
  input: ReplanInput,
  deps: CwDeps,
): ActionResult {
  validateInput("replan", "slice", input);
  // ── before 快照（深拷贝，对比 append-only 不变性）──
  const before = structuredClone(unit);

  // ── 改 unit.plan：把 abandonedIds 命中的条目标 status='abandoned'（不删，append-only）──
  const abandonedSet = new Set(input.abandonedIds);
  unit.plan.techChoices = unit.plan.techChoices.map((it) =>
    abandonedSet.has(it.id) ? ({ ...it, status: "abandoned" } as SliceTechChoice) : it,
  );
  unit.plan.interfaces = unit.plan.interfaces.map((it) =>
    abandonedSet.has(it.id) ? ({ ...it, status: "abandoned" } as SliceInterface) : it,
  );
  unit.plan.dataModels = unit.plan.dataModels.map((it) =>
    abandonedSet.has(it.id) ? ({ ...it, status: "abandoned" } as SliceDataModel) : it,
  );
  unit.plan.errorSpecs = unit.plan.errorSpecs.map((it) =>
    abandonedSet.has(it.id) ? ({ ...it, status: "abandoned" } as SliceErrorSpec) : it,
  );

  // abandon parent 条目声明（ADR-0010 跨层跨时机通道）：append-only 合并到 unit.abandonedParentItems。
  // 放在 freeze 校验之前——freeze 只校验 unit.plan 条目不校验此字段，不会误报 violation。
  mergeAbandonParentItems(unit, input);

  // ── checkFreezePlanning：验 abandoned 条目核心字段未被改/未删 ──
  const freezeViolations = checkFreezePlanning(before, unit);

  if (freezeViolations.length > 0) {
    const reason = freezeViolations.map((v) => v.reason).join("; ");
    appendSliceFailRecord(deps, unit, "replan", reason);
    const { nextAction, failureCount } = buildSliceFailureNextAction(unit, "replan", reason);
    return {
      unitId: unit.id,
      status: unit.status,
      ok: false,
      error: `slice replan freeze violated: ${reason}`,
      freezeViolations,
      nextAction,
      failureCount,
    };
  }

  // ── computeImpactCascade：多层级联影响面 ──
  const at = deps.clock.now();
  const replanImpact = computeImpactCascade({
    unit,
    abandonedIds: input.abandonedIds,
    loadChildren: (parentId) => loadChildrenAsWorkUnitBase(deps.store, parentId, "wave"),
  });

  // ── replan 旁路：status 不变，append statusHistory（from=to=current, action='replan', note）──
  sliceTransition(unit, "replan", at, input.note);

  // 先落盘自身（cascadeAbortUnit 内 rollup 读 parent 最新状态，避免被后续 saveSlice 覆盖）
  saveSlice(deps, unit);

  // ── 级联 abort 受影响 child unit ──
  for (const childUnitId of replanImpact.aborted) {
    cascadeAbortUnit(deps, childUnitId, at, input.abandonedIds);
  }

  // ── 构造含审视引导的 replan guidance ──
  const replanCount = unit.statusHistory.filter((e) => e.action === "replan").length;
  const impactSummary = [
    `aborted: ${replanImpact.aborted.length > 0 ? replanImpact.aborted.join(", ") : "（无）"}`,
    `preserved: ${replanImpact.preserved.length > 0 ? replanImpact.preserved.join(", ") : "（无）"}`,
    `pendingRebuild: ${replanImpact.pendingRebuild.length > 0 ? replanImpact.pendingRebuild.join(", ") : "（无）"}`,
  ].join("\n");
  const base = buildSliceNextAction(unit, "replan");
  // #12：prefix 复用 buildPrefix（含 SLICE_STATUS_DISPLAY 中文映射 + 父单元段），与 buildSliceNextAction 输出一致。
  base.guidance = buildReplanGuidance({
    prefix: buildPrefix({
      layer: "slice",
      unitId: unit.id,
      status: `${SLICE_STATUS_DISPLAY[unit.status] ?? unit.status}（replan 后原地）`,
      parentUnitId: unit.parentUnitId,
    }),
    abandonedIds: input.abandonedIds,
    replanCount,
    impactSummary,
    nextCommand: buildCommand("design", `--unitId ${unit.id}`, `--input ${inputFilePath(unit.slug, "design")}`),
    // #1 D-017：replan 后下一步是 design，透传 design 的 input schema 段。
    schemaText: getSliceSchemaText("design"),
  });

  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    replanImpact,
    nextAction: base,
  };
}

// ═══════════════════════════════════════════════════════════════
// 辅助：级联 abort 单个受影响 child unit（及其子孙）
// ═══════════════════════════════════════════════════════════════

/**
 * 级联 abort 一个受影响 unit：置 status='aborted' + append statusHistory + append abandonedRefs，
 * 递归其子孙。已终态（closed/aborted）跳过。
 *
 * child unit 可能是 wave 或更深 slice，统一按 WorkUnitRecord 读写（扁平存储，字段 unknown 透传）。
 *
 * @param store store（save/findChildren）
 * @param unitId 受影响 unit id
 * @param at ISO 时间戳
 * @param abandonedIds 触发本次级联的废弃条目 id（写入 abandonedRefs.workUnitItemId）
 */
function cascadeAbortUnit(
  deps: CwDeps,
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
    note: "级联 abort（parent slice replan 废弃条目）",
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

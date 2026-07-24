/**
 * v1 feature handler — replan action（spec 条目标 abandoned + freeze 校验 + 级联 abort + 旁路 statusHistory）。
 *
 * 设计来源：model §5.6.2（replan 流程 Step 2-4：影响面计算 + 级联 abort）、
 * rules freeze.checkFreezeFeatureSpec（FeatureSpec 3 类条目 append-only 校验）、
 * rules replan.computeImpactCascade（多层级联传播）、
 * PLANNING_TRANSITIONS.replan（旁路，from ∈ {design-reviewed, executing}，to=undefined）。
 *
 * 职责：
 * 1. before = 深拷贝 unit
 * 2. 改 unit.clarifications.spec：把 abandonedIds 命中的 functionalRequirements /
 *    acceptanceCriteria / businessCases 条目 status 改为 'abandoned'（append-only，不删；
 *    decisions 投影自 Clarification，不逐项废弃，跳过）
 * 3. checkFreezeFeatureSpec(before, after)：有 violation → 短路返回 ok=false（不 save 影响面）
 * 4. computeImpactCascade({unit, abandonedIds, loadChildren})：算多层级联影响面
 *    - loadChildren：store.findChildren → 映射 WorkUnitBase[]
 * 5. 对返回的 aborted 列表里每个 child unit：加载、置 status='aborted'、append statusHistory
 *    （action='abort', note='级联 abort'）、append abandonedRefs、save
 * 6. append unit 自己的 statusHistory（from=to=current, action='replan', note=input.note）→ save
 * 7. 返回 ok=true + replanImpact + nextAction.action='plan'（replan 后回 planning 重走 design-review）
 *
 * 与 slice replan 的差异：
 * - slice 改 plan 4 类条目（techChoices/interfaces/dataModels/errorSpecs），feature 改 spec 3 类条目（FR/AC/UC）
 * - 用 checkFreezeFeatureSpec（不是 checkFreezePlanning）
 * - feature 的 child 是 slice，级联 abort 会实际触发
 *
 * abandonedIds 语义：废弃的 feature spec 条目 id（FR/AC/UC）。feature execute 时把
 * split.inheritedItemIds 写入 child slice 的 basedOnParent，故废弃的 spec 条目通过 basedOnParent
 * 链路被 computeImpactCascade 命中，触发相关 child slice 级联 abort（核心机制与 slice 一致）。
 */
import type {
  AcceptanceCriterion,
  BusinessCase,
  FunctionalRequirement,
} from "../../core/clarifications.js";
import type { AbandonedRef, WorkUnitStatus } from "../../core/status.js";
import type { Feature, WorkUnitBase } from "../../core/workunit.js";
import { checkFreezeFeatureSpec } from "../../rules/freeze.js";
import { computeImpactCascade } from "../../rules/replan.js";
import type { WorkUnitRecord } from "../../store/schema.js";
import type { V1Store } from "../../store/v1-store.js";
import type { ActionResult, ReplanInput, V1Deps } from "../types.js";
import { rollupChildDelivery } from "../rollup.js";
import {
  appendFeatureFailRecord,
  buildFeatureFailureNextAction,
  buildFeatureNextAction,
  featureTransition,
  readRecordStatus,
  readRecordStatusHistory,
  saveFeature,
} from "./feature-internal.js";

/**
 * 执行 feature replan action（旁路，不改 status）。
 *
 * @param unit 已加载的 Feature（status ∈ {design-reviewed, executing}）
 * @param input abandonedIds（废弃的 feature spec 条目 id）+ note（replan 原因）
 * @param deps 依赖注入（store / clock）
 */
export function handleReplanFeature(
  unit: Feature,
  input: ReplanInput,
  deps: V1Deps,
): ActionResult {
  // ── before 快照（深拷贝，对比 append-only 不变性）──
  const before = structuredClone(unit);

  // ── 改 clarifications.spec：把 abandonedIds 命中的 FR/AC/UC 条目标 status='abandoned'（不删，append-only）──
  // decisions 投影自 Clarification（不继承 WorkUnitItem），不逐项废弃，跳过。
  const abandonedSet = new Set(input.abandonedIds);
  const spec = unit.clarifications.spec;
  spec.functionalRequirements = spec.functionalRequirements.map((it) =>
    abandonedSet.has(it.id)
      ? ({ ...it, status: "abandoned" } as FunctionalRequirement)
      : it,
  );
  spec.acceptanceCriteria = spec.acceptanceCriteria.map((it) =>
    abandonedSet.has(it.id)
      ? ({ ...it, status: "abandoned" } as AcceptanceCriterion)
      : it,
  );
  spec.businessCases = spec.businessCases.map((it) =>
    abandonedSet.has(it.id)
      ? ({ ...it, status: "abandoned" } as BusinessCase)
      : it,
  );

  // ── checkFreezeFeatureSpec：验 abandoned 条目未被删/核心字段未被改/status 未复活 ──
  const freezeViolations = checkFreezeFeatureSpec(before, unit);

  if (freezeViolations.length > 0) {
    const reason = freezeViolations.map((v) => v.reason).join("; ");
    appendFeatureFailRecord(deps, unit, "replan", reason);
    const { nextAction, failureCount } = buildFeatureFailureNextAction(
      unit,
      "replan",
    );
    return {
      unitId: unit.id,
      status: unit.status,
      ok: false,
      error: `feature replan freeze violated: ${reason}`,
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
    loadChildren: (parentId) => loadChildrenAsWorkUnitBase(deps.store, parentId),
  });

  // ── replan 旁路：status 不变，append statusHistory（from=to=current, action='replan', note）──
  featureTransition(unit, "replan", at, input.note);

  // 先落盘自身（cascadeAbortUnit 内 rollup 读 parent 最新状态，避免被后续 saveFeature 覆盖）
  saveFeature(deps, unit);

  // ── 级联 abort 受影响 child unit ──
  for (const childUnitId of replanImpact.aborted) {
    cascadeAbortUnit(deps, childUnitId, at, input.abandonedIds);
  }
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    replanImpact,
    nextAction: buildFeatureNextAction(unit, "replan"),
  };
}

// ═══════════════════════════════════════════════════════════════
// 辅助：store.findChildren → WorkUnitBase[]（computeImpactCascade 的 loadChildren 注入）
// ═══════════════════════════════════════════════════════════════

/**
 * 把 store.findChildren 返回的 WorkUnitRecord[] 映射为 WorkUnitBase[]。
 *
 * computeImpactCascade 只读 id / parentUnitId / basedOnParent（影响面计算基础），从 WorkUnitRecord
 * 的 unknown 字段安全提取这些字段。feature 的 child 是 slice，scope 字段回退默认 'slice'。
 */
function loadChildrenAsWorkUnitBase(
  store: V1Store,
  parentId: string,
): WorkUnitBase[] {
  const records = store.findChildren(parentId);
  return records.map((r) => ({
    id: r.id,
    scope: typeof r.scope === "string" ? (r.scope as WorkUnitBase["scope"]) : "slice",
    slug: typeof r.slug === "string" ? r.slug : r.id,
    parentUnitId: r.parentUnitId,
    status: typeof r.status === "string" ? (r.status as WorkUnitBase["status"]) : "created",
    statusHistory: readRecordStatusHistory(r),
    basedOnParent: readBasedOnParent(r),
    abandonedRefs: readAbandonedRefs(r),
    objective: typeof r.objective === "string" ? r.objective : "",
  }));
}

/**
 * 从 WorkUnitRecord 安全读 basedOnParent（string[]，默认空数组）。
 */
function readBasedOnParent(record: WorkUnitRecord): string[] {
  const v = record.basedOnParent;
  return Array.isArray(v) ? (v as string[]) : [];
}

// ═══════════════════════════════════════════════════════════════
// 辅助：级联 abort 单个受影响 child unit（及其子孙）
// ═══════════════════════════════════════════════════════════════

/**
 * 级联 abort 一个受影响 unit：置 status='aborted' + append statusHistory + append abandonedRefs，
 * 递归其子孙。已终态（closed/aborted）跳过。
 *
 * child unit 可能是 slice 或更深 wave，统一按 WorkUnitRecord 读写（扁平存储，字段 unknown 透传）。
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
    note: "级联 abort（parent feature replan 废弃条目）",
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

/**
 * 从 WorkUnitRecord 安全读 abandonedRefs（AbandonedRef[]，默认空数组）。
 */
function readAbandonedRefs(record: WorkUnitRecord): AbandonedRef[] {
  const v = record.abandonedRefs;
  return Array.isArray(v) ? [...(v as AbandonedRef[])] : [];
}

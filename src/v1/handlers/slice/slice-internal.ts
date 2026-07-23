/**
 * v1 slice handlers 内部编排辅助（不对外导出，仅 handlers/slice/ 内部用）。
 *
 * 设计来源：wave 的 handlers/internal.ts 是 wave 专属（接收 ExecutionUnit、调
 * nextWaveStatus、用 wave 的 guidance 模板）。slice 层不能直接复用——按 dev-plan W4
 * 约定，slice handler 暂时自己内联编排（statusHistory push + save），guidance/nextAction
 * 返回最小结构（W6 的 guidance worker 再美化）。W5 会参数化 internal.ts，届时本文件可收敛。
 *
 * 职责（slice 版）：
 * 1. sliceTransition：算 next PlanningStatus + append statusHistory + 更新 unit.status
 * 2. saveSlice：把 Slice 存到 store（unknown 中转，同 wave saveUnit 模式）
 * 3. buildSliceNextAction：返回最小 V1NextAction（action + unitPath.layer='slice' + 占位 guidance）
 * 4. appendSliceFailRecord / buildSliceFailureNextAction：gate/freeze fail 路径的最小异常导航
 *
 * 不变量：本文件只做编排（IO 仅经 deps）+ 最小导航。业务规则在 rules/，guidance 渲染在 W6。
 */
import type { StatusChange } from "../../core/status.js";
import type { Slice } from "../../core/workunit.js";
import type { PlanningAction } from "../../rules/state-machine.js";
import { nextPlanningStatus } from "../../rules/state-machine.js";
import type { WorkUnitRecord } from "../../store/schema.js";
import type { V1Deps, V1NextAction } from "../types.js";

// ═══════════════════════════════════════════════════════════════
// status 流转 + 持久化
// ═══════════════════════════════════════════════════════════════

/**
 * 流转 Slice 的 status：算 next PlanningStatus → append StatusChange → 更新 unit.status。
 *
 * 对 replan 旁路 action 也适用（nextPlanningStatus 返回 current 不变，from=to=current 仍 append）。
 *
 * @param unit 待流转的 Slice（会被 mutate）
 * @param action 触发的 PlanningAction
 * @param at ISO 8601 时间戳（来自 deps.clock.now()）
 * @param note 可选说明（replan 原因 / abort 原因）
 */
export function sliceTransition(
  unit: Slice,
  action: PlanningAction,
  at: string,
  note?: string,
): void {
  const from = unit.status;
  const next = nextPlanningStatus(action, from);
  const change: StatusChange = { from, to: next, at, action };
  if (note !== undefined) {
    change.note = note;
  }
  unit.statusHistory.push(change);
  unit.status = next;
}

/**
 * 把 Slice 存到 store。
 *
 * 同 wave 的 saveUnit 模式：Slice 无索引签名，WorkUnitRecord 带 `[key: string]: unknown`，
 * 需 unknown 中转。语义安全——Slice 字段全 JSON 可序列化，store 不解释不裁剪。
 */
export function saveSlice(
  deps: { store: { save: (u: WorkUnitRecord) => void } },
  unit: Slice,
): void {
  // eslint-disable-next-line taste/no-unsafe-cast
  deps.store.save(unit as unknown as WorkUnitRecord);
}

// ═══════════════════════════════════════════════════════════════
// 最小导航（W6 guidance worker 会美化）
// ═══════════════════════════════════════════════════════════════

/** buildSliceNextAction 可选参数。 */
export interface BuildSliceNextActionOpts {
  /** 覆盖默认下一步 action（execute/终态时调用方传 undefined 表示停留）。 */
  nextActionOverride?: string;
  /** 跨层建议（execute 下沉 / closeout 回溯）。 */
  crossLayer?: V1NextAction["crossLayer"];
}

/**
 * 构建 slice handler 正常路径的最小 V1NextAction。
 *
 * W4 占位：guidance 用最小文本（「<action> 完成，下一步 <nextAction>」），W6 guidance worker
 * 按 slice 阶段模板美化成三段式。
 *
 * @param unit 刚完成流转的 Slice
 * @param action 刚执行完的 PlanningAction
 * @param opts 可选覆盖（下一步 action / crossLayer）
 */
export function buildSliceNextAction(
  unit: Slice,
  action: PlanningAction,
  opts?: BuildSliceNextActionOpts,
): V1NextAction {
  const nextAction = opts?.nextActionOverride ?? SLICE_ACTION_TO_NEXT[action];
  const nextText = nextAction === undefined
    ? "（本层流程到此停留/结束）"
    : `下一步 ${nextAction}`;
  const guidance = `slice ${action} 完成，${nextText}`;
  return {
    action: nextAction,
    guidance,
    unitPath: {
      layer: "slice",
      unitId: unit.id,
      parentUnitId: unit.parentUnitId,
      rootUnitId: unit.id,
    },
    ...(opts?.crossLayer !== undefined ? { crossLayer: opts.crossLayer } : {}),
  };
}

/**
 * PlanningAction → 默认下一步 action（PLANNING_TRANSITIONS 状态机映射）。
 *
 * execute/终态 action（closeout/abort）的下一步不在本层：execute 下沉 child wave，
 * closeout 回溯父单元（crossLayer），abort 流程结束——都返回 undefined 由调用方填 crossLayer。
 */
const SLICE_ACTION_TO_NEXT: Readonly<Record<PlanningAction, string | undefined>> = {
  create: "clarify",
  clarify: "plan",
  plan: "design-review",
  "design-review": "execute",
  execute: undefined, // 下沉 child wave，由调用方填 crossLayer.descend
  retrospect: "closeout",
  closeout: undefined, // 终态，回溯父单元 crossLayer.ascend
  abort: undefined, // 终态
  replan: "plan", // replan 后回 planning 重走 design-review
};

// ═══════════════════════════════════════════════════════════════
// gate/freeze fail 路径（最小异常导航）
// ═══════════════════════════════════════════════════════════════

/**
 * 往 statusHistory append 一条 gate/freeze fail 记录（failureCount 的派生源）。
 *
 * 同 wave appendFailRecord 模式：记录形态 `{ action, to: 当前 status, note: "gate fail: <原因>" }`，
 * 不改 status（fail 诊断记录不是状态转换）。
 */
export function appendSliceFailRecord(
  deps: V1Deps,
  unit: Slice,
  action: PlanningAction,
  reason: string,
): void {
  unit.statusHistory.push({
    to: unit.status,
    at: deps.clock.now(),
    action,
    note: `gate fail: ${reason}`,
  });
  saveSlice(deps, unit);
}

/**
 * 构建 slice handler fail 路径的最小 V1NextAction + failureCount。
 *
 * failureCount 从 statusHistory 派生（含本次——appendSliceFailRecord 已 append）。
 *
 * @param unit 已 appendSliceFailRecord 的 Slice
 * @param action 触发 fail 的 PlanningAction（修正后重提同一 action）
 */
export function buildSliceFailureNextAction(
  unit: Slice,
  action: PlanningAction,
): { nextAction: V1NextAction; failureCount: number } {
  const failureCount = deriveSliceFailureCount(unit.statusHistory, action);
  return {
    nextAction: {
      action,
      guidance: `slice ${action} gate/freeze 失败，请修正后重提 ${action}`,
      unitPath: {
        layer: "slice",
        unitId: unit.id,
        parentUnitId: unit.parentUnitId,
        rootUnitId: unit.id,
      },
    },
    failureCount,
  };
}

/**
 * 从 statusHistory 派生某 action 的连续 fail 次数（§5.1 派生算法，含本次）。
 *
 * 扫描 statusHistory 尾部，连续且 action 匹配、note 含 "gate fail" 的记录计数。
 */
function deriveSliceFailureCount(
  statusHistory: StatusChange[],
  action: string,
): number {
  let count = 0;
  for (let i = statusHistory.length - 1; i >= 0; i--) {
    const change = statusHistory[i];
    if (change.action !== action) break;
    if (change.note === undefined || !change.note.includes("gate fail")) break;
    count++;
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════
// 安全读取辅助（从 WorkUnitRecord 读 status / statusHistory，用于级联 abort）
// ═══════════════════════════════════════════════════════════════

/**
 * 从 WorkUnitRecord 安全读 status 字符串（级联 abort 时读 child 状态用）。
 *
 * child 可能是任意层（wave/slice/...），status 联合类型无法静态收窄，统一按 string 读。
 * 数据缺失时回退 "created"（级联 abort 容错：宁可尝试 abort 也不漏）。
 */
export function readRecordStatus(record: WorkUnitRecord): string {
  const s = record.status;
  return typeof s === "string" ? s : "created";
}

/**
 * 从 WorkUnitRecord 安全读 statusHistory（返回可 mutate 的副本）。
 */
export function readRecordStatusHistory(record: WorkUnitRecord): StatusChange[] {
  const h = record.statusHistory;
  return Array.isArray(h) ? [...(h as StatusChange[])] : [];
}

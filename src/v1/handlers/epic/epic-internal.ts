/**
 * v1 epic handlers 内部编排辅助（不对外导出，仅 handlers/epic/ 内部用）。
 *
 * 设计来源：同 feature-internal.ts，为 epic 层复制一份（参数化 internal.ts 是 W5 的目标，
 * W4 各 PlanningUnit 层各自内联编排）。PlanningAction scope 无关（state-machine 复用），
 * 故流转逻辑与 feature 版完全一致——差异只在 layer 名与 V1NextAction.unitPath.layer。
 *
 * 职责（epic 版）：
 * 1. epicTransition：算 next PlanningStatus + append statusHistory + 更新 unit.status
 *    （复用 nextPlanningStatus，PlanningAction 与 feature 共用，epic 7 步流程状态机一致）
 * 2. saveEpic：把 Epic 存到 store（unknown 中转，同 saveFeature 模式）
 * 3. buildEpicNextAction：返回最小 V1NextAction（layer='epic' + 占位 guidance）
 * 4. appendEpicFailRecord / buildEpicFailureNextAction：gate/freeze fail 路径最小异常导航
 * 5. runEpicRetrospectGates：epic 版 retrospect gate 聚合（rules/gates/retrospect.ts
 *    未提供 epic 专用聚合，epic 与 slice/feature 的 retrospectData / plan.split / judgment 同型，
 *    复用 4 个子 gate 组装；rules 层零 IO，子 gate 均为独立纯函数）
 *
 * 不变量：本文件只做编排（IO 仅经 deps）+ 最小导航 + gate 子函数组装。业务规则在 rules/。
 */
import type { StatusChange } from "../../core/status.js";
import type { Epic } from "../../core/workunit.js";
import {
  allWavesClosed,
  reviewedItemsCoverDesignReview,
  sliceLessonsLearnedNonEmpty,
  splitFulfillmentCoversPlan,
} from "../../rules/gates/retrospect.js";
import type { GateResult } from "../../rules/gates/types.js";
import type { PlanningAction } from "../../rules/state-machine.js";
import { nextPlanningStatus } from "../../rules/state-machine.js";
import type { WorkUnitRecord } from "../../store/schema.js";
import type { V1Deps, V1NextAction } from "../types.js";

// ═══════════════════════════════════════════════════════════════
// status 流转 + 持久化
// ═══════════════════════════════════════════════════════════════

/**
 * 流转 Epic 的 status：算 next PlanningStatus → append StatusChange → 更新 unit.status。
 *
 * PlanningAction scope 无关（epic/feature/slice 共用 PLANNING_TRANSITIONS），故与 featureTransition
 * 逻辑完全一致，只是入参类型收窄为 Epic。
 *
 * @param unit 待流转的 Epic（会被 mutate）
 * @param action 触发的 PlanningAction
 * @param at ISO 8601 时间戳（来自 deps.clock.now()）
 * @param note 可选说明（replan 原因 / abort 原因）
 */
export function epicTransition(
  unit: Epic,
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
 * 把 Epic 存到 store。
 *
 * 同 wave/slice/feature 的 save 模式：Epic 无索引签名，WorkUnitRecord 带 `[key: string]: unknown`，
 * 需 unknown 中转。语义安全——Epic 字段全 JSON 可序列化，store 不解释不裁剪。
 */
export function saveEpic(
  deps: { store: { save: (u: WorkUnitRecord) => void } },
  unit: Epic,
): void {
  // eslint-disable-next-line taste/no-unsafe-cast
  deps.store.save(unit as unknown as WorkUnitRecord);
}

// ═══════════════════════════════════════════════════════════════
// 最小导航（W6 guidance worker 会美化）
// ═══════════════════════════════════════════════════════════════

/** buildEpicNextAction 可选参数。 */
export interface BuildEpicNextActionOpts {
  /** 覆盖默认下一步 action（execute/终态时调用方传 undefined 表示停留）。 */
  nextActionOverride?: string;
  /** 跨层建议（execute 下沉 / closeout 回溯）。 */
  crossLayer?: V1NextAction["crossLayer"];
}

/**
 * 构建 epic handler 正常路径的最小 V1NextAction。
 *
 * W4 占位：guidance 用最小文本，W6 guidance worker 按 epic 阶段模板美化。
 * PlanningAction → 下一步 action 映射与 feature 一致（同一状态机）。
 *
 * @param unit 刚完成流转的 Epic
 * @param action 刚执行完的 PlanningAction
 * @param opts 可选覆盖（下一步 action / crossLayer）
 */
export function buildEpicNextAction(
  unit: Epic,
  action: PlanningAction,
  opts?: BuildEpicNextActionOpts,
): V1NextAction {
  const nextAction = opts?.nextActionOverride ?? EPIC_ACTION_TO_NEXT[action];
  const nextText = nextAction === undefined
    ? "（本层流程到此停留/结束）"
    : `下一步 ${nextAction}`;
  const guidance = `epic ${action} 完成，${nextText}`;
  return {
    action: nextAction,
    guidance,
    unitPath: {
      layer: "epic",
      unitId: unit.id,
      parentUnitId: unit.parentUnitId,
      rootUnitId: unit.id,
    },
    ...(opts?.crossLayer !== undefined ? { crossLayer: opts.crossLayer } : {}),
  };
}

/**
 * PlanningAction → 默认下一步 action（PLANNING_TRANSITIONS 状态机映射，与 feature 共用）。
 *
 * epic 7 步流程（无 test/exec-review）：create→clarify→plan→design-review→execute→
 * retrospect→closeout。execute 下沉 child feature（targetLayer='feature'），closeout 回溯父单元
 *（epic 顶层无父，crossLayer 天然 undefined——孤立终点）。
 */
const EPIC_ACTION_TO_NEXT: Readonly<Record<PlanningAction, string | undefined>> = {
  create: "clarify",
  clarify: "plan",
  plan: "design-review",
  "design-review": "execute",
  execute: undefined, // 下沉 child feature，由调用方填 crossLayer.descend
  retrospect: "closeout",
  closeout: undefined, // 终态，epic 顶层无父单元，crossLayer 天然 undefined
  abort: undefined, // 终态
  replan: "plan", // replan 后回 planning 重走 design-review
};

// ═══════════════════════════════════════════════════════════════
// gate/freeze fail 路径（最小异常导航）
// ═══════════════════════════════════════════════════════════════

/**
 * 往 statusHistory append 一条 gate/freeze fail 记录（failureCount 的派生源）。
 *
 * 同 slice/feature appendFailRecord 模式：记录形态 `{ action, to: 当前 status, note: "gate fail: <原因>" }`，
 * 不改 status（fail 诊断记录不是状态转换）。
 */
export function appendEpicFailRecord(
  deps: V1Deps,
  unit: Epic,
  action: PlanningAction,
  reason: string,
): void {
  unit.statusHistory.push({
    to: unit.status,
    at: deps.clock.now(),
    action,
    note: `gate fail: ${reason}`,
  });
  saveEpic(deps, unit);
}

/**
 * 构建 epic handler fail 路径的最小 V1NextAction + failureCount。
 *
 * failureCount 从 statusHistory 派生（含本次——appendEpicFailRecord 已 append）。
 *
 * @param unit 已 appendEpicFailRecord 的 Epic
 * @param action 触发 fail 的 PlanningAction（修正后重提同一 action）
 */
export function buildEpicFailureNextAction(
  unit: Epic,
  action: PlanningAction,
): { nextAction: V1NextAction; failureCount: number } {
  const failureCount = deriveEpicFailureCount(unit.statusHistory, action);
  return {
    nextAction: {
      action,
      guidance: `epic ${action} gate/freeze 失败，请修正后重提 ${action}`,
      unitPath: {
        layer: "epic",
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
function deriveEpicFailureCount(
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
// epic retrospect gate 聚合
// ═══════════════════════════════════════════════════════════════

/**
 * 跑 epic retrospect 全部 4 个 gate。
 *
 * rules/gates/retrospect.ts 只提供 slice 版聚合（runSliceRetrospectGates，签名锁 Slice），
 * 未提供 epic 专用版。epic 与 slice/feature 的 retrospectData（PlanningRetrospectData）、
 * plan.split（Split[]）、designReviewJudgment（DesignReviewJudgment）类型完全一致，4 个子 gate
 * 均接收这三种入参（不依赖 Slice 特有字段），故 epic 直接复用 4 个子 gate 组装。
 *
 * 语义对应：epic 的 child 是 feature（feature 的 child 是 slice），allWavesClosed 判定
 * 「所有 child 终态」的语义对 epic 同样成立（child feature 终态 = closed/aborted）。
 *
 * @param unit 待校验的 Epic
 * @param childStatuses 所有 child feature 的当前 status（handler 从 store.findChildren 注入）
 */
export function runEpicRetrospectGates(
  unit: Epic,
  childStatuses: ReadonlyArray<"closed" | "aborted" | string>,
): GateResult[] {
  return [
    allWavesClosed(childStatuses),
    sliceLessonsLearnedNonEmpty(unit.retrospectData),
    reviewedItemsCoverDesignReview(unit.retrospectData, unit.designReviewJudgment),
    splitFulfillmentCoversPlan(unit.retrospectData, unit.plan.split),
  ];
}

// ═══════════════════════════════════════════════════════════════
// 安全读取辅助（从 WorkUnitRecord 读 status / statusHistory，用于级联 abort）
// ═══════════════════════════════════════════════════════════════

/**
 * 从 WorkUnitRecord 安全读 status 字符串（级联 abort 时读 child 状态用）。
 *
 * child 可能是任意层（feature/slice/wave/...），status 联合类型无法静态收窄，统一按 string 读。
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

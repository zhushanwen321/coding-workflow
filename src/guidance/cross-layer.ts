/**
 * v1 guidance — 跨层导航计算（子单元 closeout 后的回溯/横向）。
 *
 * 来源：v5 cli-and-guidance §7.3「子单元 closeout 后的回溯/横向」+ §7.4「crossLayer 计算的职责边界」。
 *
 * 职责：closeout handler 调用本函数计算 crossLayer（填 nextAction.crossLayer）。
 *      算法查 store（父/兄弟单元状态），是 IO 依赖——所以放独立函数由 handler 调用，
 *      guidance builder 只渲染不查 store（§7.4）。
 *
 * 路由逻辑（§7.3）：
 *   子单元 closeout 成功
 *     → 无 parent → 返回 undefined（孤立终点，流程结束，§1.3）
 *     → 有 parent → 查 store.findChildren(parentUnitId)
 *       → 有非终态兄弟（过滤 aborted）→ crossLayer = sibling（横向，第一个非终态兄弟）
 *       → 全部终态（closed/aborted）→ crossLayer = ascend（回父单元 retrospect）
 *
 * 注：本函数返回 CwNextAction["crossLayer"]（结构化字段），不渲染文本。
 *      caller（build-guidance）不依赖此返回做渲染——agent 读结构化字段决定下一步（§7.2 路由）。
 */
import {
  computeReadyChildren,
  type ReadyTarget,
  type SchedulingStore,
} from "../core/scheduling.js";
import type { ExecutionStatus } from "../core/status.js";
import type { CwNextAction } from "../handlers/types.js";
import type { CwStore } from "../store/cw-store.js";

// ═══════════════════════════════════════════════════════════════
// 终态判断
// ═══════════════════════════════════════════════════════════════

/** 终态 status 集合（model §3.1/§3.2：closed / aborted 不可逆）。Planning/Execution 共用此终态定义。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>(["closed", "aborted"]);

/**
 * 判定 status 是否为终态（closed / aborted）。
 *
 * 终态 = 不可逆的最终状态（closeout 后 closed / abort 后 aborted）。
 * 用于 cross-layer 判断兄弟是否还需推进 + §7.2 路由的「流程结束」判断。
 */
export function isTerminalStatus(status: ExecutionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ═══════════════════════════════════════════════════════════════
// computeCrossLayerAfterCloseout
// ═══════════════════════════════════════════════════════════════

/** computeCrossLayerAfterCloseout 入参。 */
export interface ComputeCrossLayerArgs {
  /** store（用于查父/兄弟单元状态）。 */
  store: CwStore;
  /** 刚 closeout 的子单元 id（用于在兄弟里排除自身）。 */
  unitId: string;
  /** 父单元 id（无则孤立终点，返回 undefined）。 */
  parentUnitId?: string;
}

/**
 * 子单元 closeout 后计算 crossLayer（§7.3）。
 *
 * @returns crossLayer 结构化字段（sibling/ascend/undefined）。undefined 表示流程结束或孤立终点。
 */
export function computeCrossLayerAfterCloseout(
  args: ComputeCrossLayerArgs,
): CwNextAction["crossLayer"] {
  const { store, unitId, parentUnitId } = args;

  // 无 parent → 孤立终点，流程结束（§1.3，任何层都能无 parent 独立起步）。
  if (parentUnitId === undefined || parentUnitId === "") {
    return undefined;
  }

  // 查父单元的所有子单元（兄弟，含自身）。
  const siblings = store.findChildren(parentUnitId);

  // 找第一个非终态且非自身的兄弟（横向推进目标）。
  // §7.3：aborted 的兄弟跳过（终态，不再推进）；closed 同样是终态，跳过。
  const pendingSibling = siblings.find((sib) => {
    if (sib.id === unitId) {
      return false; // 排除刚 closeout 的自身
    }
    return !isTerminalStatus(readStatus(sib));
  });

  if (pendingSibling !== undefined) {
    return {
      kind: "sibling",
      targetUnitId: pendingSibling.id,
      reason: `父单元 ${parentUnitId} 仍有未完成的兄弟单元 ${pendingSibling.id}，横向推进。`,
    };
  }

  // 全部兄弟终态 → 回父单元 retrospect（回溯，§7.3）。
  return {
    kind: "ascend",
    targetUnitId: parentUnitId,
    reason: `父单元 ${parentUnitId} 的所有子单元已终态，回父单元 retrospect。`,
  };
}

// ═══════════════════════════════════════════════════════════════
// computeParallelSiblingsAfterCloseout
// ═══════════════════════════════════════════════════════════════

/**
 * closeout 后算并行就绪的兄弟批次（复用 computeReadyChildren）。
 *
 * 与 {@link computeCrossLayerAfterCloseout} 的语义差异（设计文档 §3.1.4.1）：
 * - computeCrossLayerAfterCloseout 用「非终态」判据（`store.findChildren` + `.find()` 取第一个，
 *   不管依赖是否满足）。
 * - 本函数用「就绪」判据（非终态 + 依赖全终态，考虑 parent 的 `plan.split.dependsOn`）。
 *
 * 这导致真实命中的发散态：兄弟非终态但被依赖阻塞时，{@link computeCrossLayerAfterCloseout}
 * 返回 `{kind:"sibling", targetUnitId:B}`（B 非终态即命中），而本函数返回 `[]`（B 被阻塞不算就绪）。
 * 调用方（wave closeout handler）需用守卫处理此发散态（§3.1.4.1 分支 2）：crossLayer=sibling
 * 但 parallelTargets 空时降级为 ascend，避免指向死胡同。
 *
 * 实现委托：parent 不在 store（孤儿 parent 字符串）时，{@link computeReadyChildren}
 * 的 `load(parent)` 返回 null → 按保守降级返回空数组（§3.1.2 步骤 1）。该降级让孤儿 parent
 * 的三层 closeout 测试恒走 ascend 分支（§7.6 表），与原硬编码 ascend 行为等价。
 *
 * @returns 就绪兄弟 ReadyTarget 数组（排除自身，可能为空）
 */
export function computeParallelSiblingsAfterCloseout(
  args: ComputeCrossLayerArgs,
): ReadyTarget[] {
  const { store, unitId, parentUnitId } = args;

  // 无 parent → 孤立终点，无兄弟概念，返回空。
  if (parentUnitId === undefined || parentUnitId === "") {
    return [];
  }

  // 复用 computeReadyChildren（兄弟 = parent 的 children 排除自身）。
  // CwStore 满足 SchedulingStore（含 load(id) 方法），结构子类型兼容。
  const schedulingStore: SchedulingStore = store;
  const ready = computeReadyChildren(parentUnitId, schedulingStore);
  return ready.filter((t) => t.unitId !== unitId);
}

// ═══════════════════════════════════════════════════════════════
// 内部：安全读 record.status
// ═══════════════════════════════════════════════════════════════

/**
 * 从 WorkUnitRecord 安全读 status。
 *
 * WorkUnitRecord 带 `[key: string]: unknown` 索引签名，status 字段以 unknown 透传。
 * 这里按 ExecutionStatus 收窄（store 序列化的是合法 ExecutionStatus 字符串）。
 *
 * 数据损坏时（status 缺失或非 string）throw 而非静默回退——避免 cross-layer 把
 * 损坏记录误判为「非终态」而给出错误的推进 guidance。
 */
function readStatus(record: { [key: string]: unknown }): ExecutionStatus {
  const s = record.status;
  if (typeof s === "string") {
    return s as ExecutionStatus;
  }
  throw new Error(
    `数据损坏：WorkUnitRecord "${String(record.id ?? "?")}" 的 status 字段缺失或非 string（got ${typeof s}）`,
  );
}

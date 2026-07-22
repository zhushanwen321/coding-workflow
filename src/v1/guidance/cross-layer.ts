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
 * 注：本函数返回 V1NextAction["crossLayer"]（结构化字段），不渲染文本。
 *      caller（build-guidance）不依赖此返回做渲染——agent 读结构化字段决定下一步（§7.2 路由）。
 */
import type { ExecutionStatus } from "../core/status.js";
import type { V1NextAction } from "../handlers/types.js";
import type { V1Store } from "../store/v1-store.js";

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
  store: V1Store;
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
): V1NextAction["crossLayer"] {
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
// 内部：安全读 record.status
// ═══════════════════════════════════════════════════════════════

/**
 * 从 WorkUnitRecord 安全读 status（默认 "created"）。
 *
 * WorkUnitRecord 带 `[key: string]: unknown` 索引签名，status 字段以 unknown 透传。
 * 这里按 ExecutionStatus 收窄（store 序列化的是合法 ExecutionStatus 字符串）。
 */
function readStatus(record: { [key: string]: unknown }): ExecutionStatus {
  const s = record.status;
  if (typeof s === "string") {
    return s as ExecutionStatus;
  }
  return "created";
}

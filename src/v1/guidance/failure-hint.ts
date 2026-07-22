/**
 * v1 guidance — 递进失败提示（纯函数，零 IO）。
 *
 * 来源：v5 cli-and-guidance §5.1「gate fail 的递进 guidance」+ §5.3「没有熔断」。
 *
 * 职责：按 failureCount 渲染递进提示文本（第 N 次失败追加的「换思路」出口）。
 *      failureCount=0/1 时返回空字符串（只说问题，不加出口）。
 *
 * 不变量：纯函数。不查 store、不读 statusHistory（派生计数由 deriveFailureCount 从
 *      调用方传入的 statusHistory 副本算，buildFailureHint 只接收已算好的数字）。
 *
 * 递进规则（§5.1，非「熔断」状态——cw 永不阻断，只是文案引导）：
 *   - failureCount <= 1：空字符串
 *   - failureCount == 2..4：三个出口（clarify / replan / abort 重选）
 *     （§5.1 示例第 3 次出现，2 和 4 是同档位的容差，避免边界写死 3）
 *   - failureCount >= 5：在三个出口基础上加「强烈建议先 cw abort，跳出当前层重新审视」
 */
// ═══════════════════════════════════════════════════════════════
// buildFailureHint
// ═══════════════════════════════════════════════════════════════

/** gate fail 派生计数用的 statusHistory 条目形态（取自 StatusChange 的子集）。 */
export interface FailureHistoryEntry {
  /** 触发变更的 action（create/clarify/plan/.../replan/abort）。 */
  action: string;
  /** 可选说明；连续 fail 记录的 note 含 "gate fail" 标记。 */
  note?: string;
}

/** 第 1 次 fail 的阈值：<= 此值只说问题，不加出口（§5.1）。 */
const HINT_THRESHOLD_FIRST_FAIL = 1;
/** 触发「强烈建议先 abort」的失败次数阈值（§5.1 末段）。 */
const HINT_THRESHOLD_STRONG_ABORT = 5;

/**
 * 按 failureCount 渲染递进提示文本。
 *
 * @param failureCount 同一 action 的连续 fail 次数（从 statusHistory 派生，§5.1）
 * @returns 递进提示文本；failureCount <= 1 时返回空字符串（调用方据此省略「递进提示」段）
 */
export function buildFailureHint(failureCount: number): string {
  // 第 1 次失败只说问题，不加出口（§5.1 第 1 次示例无「递进提示」段）。
  // 负数视为非法输入，同样返回空（防御性）。
  if (failureCount <= HINT_THRESHOLD_FIRST_FAIL) {
    return "";
  }

  // 三出口（§5.1 第 3 次示例）。
  // unitId 由调用方在更高层拼接（本函数保持纯，不接 unitId 参数），
  // 这里只产出方法论文本，命令中的 unitId 占位由 buildFailureGuidance 填。
  const exits = [
    "连续失败已超过 1 次。考虑：",
    "- 需求本身不明确 → 回到 clarify（cw clarify --unitId <unitId>）",
    "- plan 有根本问题 → replan（cw replan --unitId <unitId> --abandonedIds '[...]' --note \"...\"）",
    "- 选错了层 → cw abort 重选",
  ];

  // failureCount >= HINT_THRESHOLD_STRONG_ABORT：再加「强烈建议先 abort」一句（§5.1 末段）。
  if (failureCount >= HINT_THRESHOLD_STRONG_ABORT) {
    return [
      ...exits,
      "",
      `连续失败已达 ${failureCount} 次，强烈建议先 cw abort，跳出当前层重新审视。`,
    ].join("\n");
  }

  // 中间档位（2..4）：只给三出口。
  return exits.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// deriveFailureCount
// ═══════════════════════════════════════════════════════════════

/**
 * 从 statusHistory 派生同一 action 的连续 fail 次数。
 *
 * 逻辑（§5.1 末段「failureCount 从 statusHistory 派生，统计同一 action 最近连续 fail 次数」）：
 *   从 statusHistory 尾部倒序扫描，统计 note 含 "gate fail" 的连续记录数。
 *   遇到不含 "gate fail" 的记录（或 action 不匹配，或扫到头）即停止。
 *
 * 按 action 分桶统计：只计数 currentAction 的连续 fail 记录。
 * 这避免了「跨 action 交替失败」时计数错误累加的问题
 * （如 design-review fail → test fail → design-review fail 应只算 design-review 的 2 次）。
 *
 * @param statusHistory unit.statusHistory 的浅副本（只读扫描，不 mutate）
 * @param currentAction 当前 action 名（按 action 分桶统计的 key）
 */
export function deriveFailureCount(
  statusHistory: ReadonlyArray<FailureHistoryEntry>,
  currentAction: string,
): number {
  let count = 0;
  for (let i = statusHistory.length - 1; i >= 0; i--) {
    const entry = statusHistory[i];
    if (entry?.action !== currentAction) {
      break;
    }
    const note = entry?.note ?? "";
    if (note.includes("gate fail")) {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

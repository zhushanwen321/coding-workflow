/**
 * v1 wave 状态转换表 + guard + computeNextStatus（领域规则，纯函数，零 IO）。
 *
 * 来源：v5 wave 附录 A §9 line 1171-1197（WAVE_TRANSITIONS 原样），
 *      model §3.2（10 状态）、§3.4（wave 状态机特化）、§4.4.1（replan 旁路语义）。
 *
 * 职责：
 * - 声明 wave 的 11 个 action（9 主流程 + abort + replan）的合法 from/to 集
 * - guardWave：查表校验「当前 status 是否允许触发某 action」
 * - nextWaveStatus：算出触发某 action 后的新 status（progressive / replan bypass 语义）
 * - isWaveTerminal：判定终态
 *
 * 不变量：rules 层零 IO，guard 只做查表（不读 git / 不跑测试）。
 */
import type { ExecutionStatus } from "../core/status.js";

// ═══════════════════════════════════════════════════════════════
// WaveAction（model §3.3 action 列表）
// ═══════════════════════════════════════════════════════════════

/**
 * wave 的全部 action：
 * - 9 个主流程：create / clarify / plan / design-review / execute / test / exec-review / retrospect / closeout
 * - 2 个旁路：abort（→ aborted）/ replan（原地，不改 status）
 */
export type WaveAction =
  | "create"
  | "clarify"
  | "plan"
  | "design-review"
  | "execute"
  | "test"
  | "exec-review"
  | "retrospect"
  | "closeout"
  | "abort"
  | "replan";

// ═══════════════════════════════════════════════════════════════
// WAVE_TRANSITIONS（wave 附录 A §9，原样）
// ═══════════════════════════════════════════════════════════════

/**
 * 单条 transition 定义。
 *
 * - `from`：允许触发该 action 的当前 status 集合（create 为空数组，表示从无到有）
 * - `to`：触发后的目标 status；`undefined` 表示原地不动（replan 旁路，见 model §4.4.1）
 * - `progressive`：可选，true 表示「progressive action」——若 current 已是 `to`，允许在原地再次触发（不改 status）
 */
export interface WaveTransition {
  from: ExecutionStatus[];
  to: ExecutionStatus | undefined;
  progressive?: boolean;
}

/**
 * wave 附录 A §9 line 1171-1197 — wave 状态机转换表（原样）。
 *
 * 关键特化点（vs PlanningUnit 通用规则，model §3.4）：
 * - `plan.from` 含 `design-reviewed`（不含 executing）：wave replan 后回 planning 重走 design-review
 * - `replan.from` 含 `executing`/`tested`/`exec-reviewed`/`retrospected`（执行后可 replan），`to=undefined`（旁路不改 status）
 * - `create.from = []`：从无到有，guardWave 允许 status=undefined
 */
export const WAVE_TRANSITIONS: Record<WaveAction, WaveTransition> = {
  create: { from: [], to: "created" },
  clarify: {
    from: ["created", "clarifying"],
    to: "clarifying",
    progressive: true,
  },
  // ⚠️ wave 特化点：plan 的 from 加 design-reviewed（不含 executing）
  // 原因：wave 是叶子改 testCases 没下游影响面，允许 plan 在 design-reviewed 回流改 testCases（详见 wave §8.5）
  // 不含 executing：避免 executing 状态改 testCases 后 designReviewJudgment 失效的死锁
  plan: {
    from: ["clarifying", "planning", "design-reviewed"],
    to: "planning",
    progressive: true,
  },
  "design-review": {
    from: ["planning", "design-reviewed"],
    to: "design-reviewed",
    progressive: true,
  },
  execute: { from: ["design-reviewed"], to: "executing" },
  test: { from: ["executing"], to: "tested" },
  "exec-review": { from: ["tested"], to: "exec-reviewed" },
  retrospect: { from: ["exec-reviewed"], to: "retrospected" },
  closeout: { from: ["retrospected"], to: "closed" },
  abort: {
    from: [
      "created",
      "clarifying",
      "planning",
      "design-reviewed",
      "executing",
      "tested",
      "exec-reviewed",
      "retrospected",
    ],
    to: "aborted",
  },
  // 注：wave 是叶子，无子孙可销毁（abort 只销毁 wave 自己，代码不删——cw 不管 git，commit 留 git，新 wave 可参考）
  // replan：wave 可调（改自己的 WavePlan 条目：废弃/新增 WaveTestCase/WaveTask/WaveFile/WaveContract）
  // wave 是叶子（无 childUnitIds），影响面计算结果恒为空——replan 只影响 wave 自己，无下游级联
  // 从 design-reviewed 及之后都可调（design-review 前的调整走 plan progressive，见 §8.1 对比表）
  // replan 后 agent 必须回到 planning 重新 design-review（刷新 designReviewJudgment 匹配新 plan，§8.3）
  // status 不变（replan 是旁路 action）
  replan: {
    from: [
      "design-reviewed",
      "executing",
      "tested",
      "exec-reviewed",
      "retrospected",
    ],
    to: undefined /* 原地 */,
    progressive: true,
  },
};

// ═══════════════════════════════════════════════════════════════
// GuardVerdict
// ═══════════════════════════════════════════════════════════════

/**
 * guard 校验结论。
 *
 * - ok=true：action 在当前 status 下允许触发
 * - ok=false：illegal_transition（当前 status 不在该 action 的 from 集合里）
 *
 * 注意：guard 只验状态机合法性，不验业务 gate（gate 由 gates/*.ts 各阶段函数负责）。
 */
export type GuardVerdict =
  | { ok: true }
  | { ok: false; code: "illegal_transition"; reason: string };

// ═══════════════════════════════════════════════════════════════
// guardWave（查表校验）
// ═══════════════════════════════════════════════════════════════

/**
 * 校验「当前 status 是否允许触发某 action」（查 WAVE_TRANSITIONS 表）。
 *
 * 规则：
 * - create-like action（from 为空数组）：允许 status=undefined（从无到有）。非 undefined 则 illegal。
 * - 其余 action：status 必须在 transition.from 列表里，否则 illegal_transition。
 *
 * @param action 待校验的 action
 * @param status 当前 status（create 时为 undefined）
 */
export function guardWave(
  action: WaveAction,
  status: ExecutionStatus | undefined,
): GuardVerdict {
  const transition = WAVE_TRANSITIONS[action];
  // create-like：from 为空，允许 status=undefined
  if (transition.from.length === 0) {
    if (status === undefined) {
      return { ok: true };
    }
    return {
      ok: false,
      code: "illegal_transition",
      reason: `action "${action}" creates a new unit (from=[]), but status is already "${status}"`,
    };
  }
  // 其余 action：status 必须在 from 里
  if (status === undefined) {
    return {
      ok: false,
      code: "illegal_transition",
      reason: `action "${action}" requires an existing status (from=${JSON.stringify(transition.from)}), but status is undefined`,
    };
  }
  if (!transition.from.includes(status)) {
    return {
      ok: false,
      code: "illegal_transition",
      reason: `action "${action}" not allowed from status "${status}" (allowed: ${JSON.stringify(transition.from)})`,
    };
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// nextWaveStatus（progressive + replan bypass 语义）
// ═══════════════════════════════════════════════════════════════

/**
 * 计算触发某 action 后的新 status。
 *
 * 语义（model §4.4.1 + wave 附录 A §9）：
 * - `to` 为 undefined（replan 旁路）：返回 current 不变（replan 不改 status）
 * - `progressive` 且 current 已是 `to`：返回 current 不变（progressive 原地）
 * - 其余：返回 `to`
 *
 * 注意：调用方应先 guardWave 校验合法性；本函数不重复校验，假设调用方已过 guard。
 *
 * @param action 触发的 action
 * @param current 当前 status（replan 旁路 / progressive 原地时返回它）
 */
export function nextWaveStatus(
  action: WaveAction,
  current: ExecutionStatus,
): ExecutionStatus {
  const transition = WAVE_TRANSITIONS[action];
  // replan bypass：to=undefined → 原地不动
  if (transition.to === undefined) {
    return current;
  }
  // progressive 语义：progressive 且 current 已是 to → 原地
  if (transition.progressive && current === transition.to) {
    return current;
  }
  return transition.to;
}

// ═══════════════════════════════════════════════════════════════
// isWaveTerminal
// ═══════════════════════════════════════════════════════════════

/** wave 的终态 status 集合（model §3.2：closed / aborted 不可逆）。 */
const WAVE_TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set<ExecutionStatus>([
  "closed",
  "aborted",
]);

/**
 * 判定 status 是否为 wave 终态（closed / aborted）。
 *
 * 终态不可逆——closeout → closed、abort → aborted 后不再有任何合法 transition。
 */
export function isWaveTerminal(status: ExecutionStatus): boolean {
  return WAVE_TERMINAL_STATUSES.has(status);
}

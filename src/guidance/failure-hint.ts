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
 *   - failureCount == 2..4：三个出口（clarify / replan / abort 重选，或按 action 适配的出口）
 *     （§5.1 示例第 3 次出现，2 和 4 是同档位的容差，避免边界写死 3）
 *   - failureCount >= 5：在三个出口基础上加「强烈建议先 cw abort，跳出当前层重新审视」
 *
 * action-aware 出口（M10）：不同 action 的失败提示不同——
 *   - clarify 失败：没有 plan 可 replan，给「重新拆 layer / abort 重选 / 继续 clarify 调整」
 *   - plan/design-review/execute/test/exec-review/retrospect/closeout 失败：标准三出口
 *     （clarify / replan / abort 重选）
 *   - replan 失败：plan 反复改不动，建议 abort 跳出重建
 *   - abort 失败：罕见，确认状态是否已转 aborted，流程结束
 *   - create 失败：检查参数合法性，建议重试或换更高层创建
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
 * 触发 fail 的 action 类型——wave 和 planning 共用，WaveAction 是超集。
 *
 * WaveAction 已包含 wave 的 11 个 action 和 planning 的 9 个 action（planning 是 wave 子集），
 * 故可直接作为 buildFailureHint 的 action 参数类型。
 */
import type { WaveAction } from "../rules/state-machine.js";
import { buildCommand } from "../utils/command.js";

/**
 * 按 failureCount 渲染递进提示文本。
 *
 * 命令已嵌入真实 unitId（不占位），所有命令由 buildCommand 统一构造（`cw <action> ...`）——agent 可直接复制执行。
 *
 * @param failureCount 同一 action 的连续 fail 次数（从 statusHistory 派生，§5.1）
 * @param unitId 失败 unit 的 id（嵌入到命令里替代 `<unitId>` 占位）
 * @param action 触发 fail 的 action（决定出口集合的形状——M10 action-aware 适配）
 * @returns 递进提示文本；failureCount <= 1 时返回空字符串（调用方据此省略「递进提示」段）
 */
export function buildFailureHint(
  failureCount: number,
  unitId: string,
  action: WaveAction,
): string {
  // 第 1 次失败只说问题，不加出口（§5.1 第 1 次示例无「递进提示」段）。
  // 负数视为非法输入，同样返回空（防御性）。
  if (failureCount <= HINT_THRESHOLD_FIRST_FAIL) {
    return "";
  }

  // 三出口（§5.1 第 3 次示例 + M10 action-aware 适配）。
  const exits = buildExits(action, unitId);

  // failureCount >= HINT_THRESHOLD_STRONG_ABORT：再加「强烈建议先 abort」一句（§5.1 末段）。
  if (failureCount >= HINT_THRESHOLD_STRONG_ABORT) {
    return [
      ...exits,
      "",
      `连续失败已达 ${failureCount} 次，强烈建议先 ${buildCommand("abort", `--unitId ${unitId}`, '--reason "..."')}，跳出当前层重新审视。`,
    ].join("\n");
  }

  // 中间档位（2..4）：只给三出口。
  return exits.join("\n");
}

/**
 * 按 action 返回适配的出口集合（M10 action-aware）。
 *
 * 设计原则：每个 exit 必须对当前 action 语义自洽——
 *   - clarify 失败时不该建议「replan」（还没有 plan 可改）
 *   - replan 失败时不该再建议「replan」（已经是修复手段本身）
 *   - abort 失败时不该建议「abort」（已经是出口本身）
 *
 * @param action 触发 fail 的 action
 * @param unitId 失败 unit 的 id（嵌入到命令里）
 * @returns 出口文案数组（第 0 项是引导句，后续是具体出口）
 */
function buildExits(action: WaveAction, unitId: string): string[] {
  // clarify 失败：没有 plan 可 replan，给「继续 clarify / 重新拆 layer / abort 重选」
  if (action === "clarify") {
    return [
      "连续失败已超过 1 次。考虑：",
      `- 表述不到位 → 继续调整 clarify（${buildCommand("clarify", `--unitId ${unitId}`, "--input @clarify.json")}）`,
      `- 单元定位不对 → ${buildCommand("abort", `--unitId ${unitId}`, '--reason "..."')} 后在父单元拆 layer 重建`,
      `- 选错了层 → 在更高层（epic/feature）建单元`,
    ];
  }

  // replan 失败：plan 反复改不动，建议 abort 跳出重建
  if (action === "replan") {
    return [
      "连续失败已超过 1 次。考虑：",
      `- plan 反复改不动 → 重新拆 layer（${buildCommand("abort", `--unitId ${unitId}`, '--reason "..."')} 后在父单元重建）`,
      `- 当前单元无法推进 → ${buildCommand("abort", `--unitId ${unitId}`, '--reason "..."')} 终止`,
    ];
  }

  // abort 失败：罕见（abort 自身 gate fail），确认状态是否已转 aborted
  if (action === "abort") {
    return [
      "abort 阶段连续失败。建议：",
      `- 检查 unit 状态是否已变 aborted —— 若是终态，流程结束`,
      `- 若仍是异常状态，重跑 ${buildCommand("abort", `--unitId ${unitId}`, '--reason "..."')}`,
    ];
  }

  // create 失败：检查参数合法性，建议重试或换更高层创建
  if (action === "create") {
    return [
      "连续失败已超过 1 次。考虑：",
      `- 单元创建参数不对 → 检查 slug/objective 合法性后重试（${buildCommand("create", "--input @create.json")}）`,
      `- 选错了层 → 在更高层（epic/feature/slice）创建`,
    ];
  }

  // plan / design-review / execute / test / exec-review / retrospect / closeout：
  // 标准三出口——回到 clarify / replan / abort 重选
  return [
    "连续失败已超过 1 次。考虑：",
    `- 需求本身不明确 → 回到 clarify（${buildCommand("clarify", `--unitId ${unitId}`, "--input @clarify.json")}）`,
    `- plan 有根本问题 → replan（${buildCommand("replan", `--unitId ${unitId}`, "--abandonedIds '[...]'", '--note "..."')}）`,
    `- 选错了层 → ${buildCommand("abort", `--unitId ${unitId}`, '--reason "..."')} 重选`,
  ];
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
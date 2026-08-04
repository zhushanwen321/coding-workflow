/**
 * v1 wave handler — replan action（checkFreeze + computeImpact + replan 旁路 statusHistory）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、model §5.6.2（replan 流程 Step 2-4：影响面计算 + 级联 abort）、
 *      §4.1（WorkUnitItem.status: active|abandoned）、§4.4.1（replan 旁路：status 不变仍 append）、
 *      wave §8.1（wave 是叶子，影响面恒为空，但机制要跑通）、§8.3（replan 后回 planning 重走 design-review）。
 *
 * 职责：
 * 1. structuredClone(unit) 作为 before 快照
 * 2. 改 unit.plan：把 abandonedIds 命中的条目标 status="abandoned"（append-only，不删）
 * 3. checkFreeze(before, after)：验 abandoned 条目核心字段未被改/未删
 *    —— 有 violation → 短路返回 ok=false + freezeViolations（不 save，但 plan 的 abandoned 标记也不落盘）
 * 4. computeImpact(loadAll(), abandonedIds)：算影响面（wave 叶子通常空）
 * 5. replan 旁路：status 不变（nextWaveStatus 返回 current），但 append statusHistory（from=to=current, action="replan", note）
 * 6. save → 返回 ActionResult + replanImpact
 *
 * 注意：replan 不改 status（旁路 action）。agent replan 后必须回 planning 重新 design-review
 * （刷新 designReviewJudgment 匹配新 plan，§8.3）——该回流走 plan progressive（plan.from 含 design-reviewed）。
 */
import type {
  WaveContract,
  WaveFile,
  WaveTask,
  WaveTestCase,
} from "../core/plan.js";
import { WAVE_STATUS_TO_ACTION } from "../core/status.js";
import type { ExecutionUnit } from "../core/workunit.js";
import { buildReplanGuidance } from "../guidance/build-guidance.js";
import { buildPrefix } from "../guidance/index.js";
import { checkFreeze } from "../rules/freeze.js";
import { computeImpact } from "../rules/replan.js";
import { buildCommand, inputFilePath } from "../utils/command.js";
import {
  appendFailRecord,
  buildFailureNextAction,
  buildNextAction,
  getSchemaText,
  mergeAbandonParentItems,
  saveUnit,
  STATUS_DISPLAY,
  transitionStatus,
} from "./internal.js";
import type { ActionResult, CwDeps,ReplanInput } from "./types.js";
import { validateInput } from "./validate-input.js";

/**
 * 执行 replan action（旁路，不改 status）。
 *
 * @param unit 已加载的 ExecutionUnit（status ∈ {design-reviewed, executing, tested, exec-reviewed, retrospected}）
 * @param input abandonedIds（废弃的 WavePlan 条目 id）+ note（replan 原因）
 * @param deps 依赖注入（store / clock）
 */
export function handleReplan(
  unit: ExecutionUnit,
  input: ReplanInput,
  deps: CwDeps,
): ActionResult {
  validateInput("replan", "wave", input);
  // ── before 快照（structuredClone 保证深拷贝，对比 append-only 不变性）──
  const before = structuredClone(unit);

  // ── 改 plan：把 abandonedIds 命中的条目标 status="abandoned"（不删，append-only 保历史）──
  const abandonedSet = new Set(input.abandonedIds);
  unit.plan.testCases = unit.plan.testCases.map((it) =>
    abandonedSet.has(it.id) ? ({ ...it, status: "abandoned" } as WaveTestCase) : it,
  );
  unit.plan.tasks = unit.plan.tasks.map((it) =>
    abandonedSet.has(it.id) ? ({ ...it, status: "abandoned" } as WaveTask) : it,
  );
  unit.plan.files = unit.plan.files.map((it) =>
    abandonedSet.has(it.id) ? ({ ...it, status: "abandoned" } as WaveFile) : it,
  );
  unit.plan.contracts = unit.plan.contracts.map((it) =>
    abandonedSet.has(it.id) ? ({ ...it, status: "abandoned" } as WaveContract) : it,
  );

  // abandon parent 条目声明（ADR-0010 跨层跨时机通道）：append-only 合并到 unit.abandonedParentItems。
  // 放在 freeze 校验之前——freeze 只校验 plan 条目不校验此字段，不会误报 violation。
  mergeAbandonParentItems(unit, input);

  // ── checkFreeze：验 abandoned 条目核心字段未被改/未删 ──
  const freezeViolations = checkFreeze(before, unit);

  // 短路：有 violation → 不 save、不改 status，但 append fail 记录 + 异常 guidance
  if (freezeViolations.length > 0) {
    const reason = freezeViolations.map((v) => v.reason).join("; ");
    appendFailRecord(deps, unit, "replan", reason);
    const { nextAction, failureCount } = buildFailureNextAction(unit, "replan", reason);
    return {
      unitId: unit.id,
      status: unit.status,
      ok: false,
      error: `replan freeze violated: ${reason}`,
      freezeViolations,
      nextAction,
      failureCount,
    };
  }

  // ── computeImpact：loadAll → 算影响面（wave 叶子通常空，机制通用）──
  const allRecords = deps.store.loadAll();
  // store 扁平存 ExecutionUnit 全字段；computeImpact 只读 id + basedOnParent（WorkUnitRecord
  // 上具名存在），故按 ExecutionUnit 透传安全。双重断言因 WorkUnitRecord 索引签名缺反向兼容。
  // eslint-disable-next-line taste/no-unsafe-cast
  const allUnits = allRecords as unknown as ExecutionUnit[];
  const replanImpact = computeImpact(allUnits, input.abandonedIds);

  // per-wave testCommand 旁路：executing 状态在途 wave 补测试命令（design-reviewed 走 plan progressive）。
  if (input.testCommand !== undefined) {
    unit.plan.testCommand = input.testCommand;
  }

  // ── replan 旁路：status 不变，但 append statusHistory（from=to=current, action="replan", note）──
  transitionStatus(unit, "replan", deps.clock.now(), input.note);

  saveUnit(deps, unit);

  // ── 构造含审视引导的 replan guidance ──
  const replanCount = unit.statusHistory.filter((e) => e.action === "replan").length;
  const impactSummary = [
    `aborted: ${replanImpact.aborted.length > 0 ? replanImpact.aborted.join(", ") : "（无）"}`,
    `preserved: ${replanImpact.preserved.length > 0 ? replanImpact.preserved.join(", ") : "（无）"}`,
    `pendingRebuild: ${replanImpact.pendingRebuild.length > 0 ? replanImpact.pendingRebuild.join(", ") : "（无）"}`,
  ].join("\n");
  const base = buildNextAction(unit, "replan");
  // 纯 testCommand 补充（无 plan 条目变更）→ 重定向到当前 status 映射的 action（executing→test），
  // 否则 plan 在 executing 状态抛 illegal_transition，恢复路径不可达。
  const testCommandOnly =
    input.abandonedIds.length === 0 &&
    (input.abandonParentItems === undefined || input.abandonParentItems.length === 0) &&
    input.addedSpecItems === undefined;
  // 内容 replan 的合法回流：plan.from 仅含 clarifying/planning/design-reviewed（不含 executing 及之后）。
  // executing 下内容 replan 后 plan/design-review 均 illegal（仅 test/replan/abort 合法），推 cw plan
  // 必抛 illegal_transition、wave 永久卡死 → 改推状态映射的合法 action + guidance 显式提示回流不可达。
  const planReachable = unit.status === "design-reviewed";
  const nextAction =
    testCommandOnly || !planReachable
      ? (WAVE_STATUS_TO_ACTION[unit.status] ?? "test")
      : "plan";
  // 无回流通道的内容 replan：blockedHint 替换「重新提交方案 + 命令」段（plan 语义不适用，不推非法命令）。
  const blockedHint =
    !testCommandOnly && !planReachable
      ? `当前状态（${STATUS_DISPLAY[unit.status] ?? unit.status}）无法回流 replan 内容变更：plan/design-review 在此状态均 illegal，只能先执行 ${nextAction} 或 abort 终止。`
      : "";
  const nextCommand = buildCommand(nextAction, `--unitId ${unit.id}`, `--input ${inputFilePath(unit.slug, nextAction)}`);
  const schemaText = getSchemaText(nextAction);
  // #12：prefix 复用 buildPrefix（含 STATUS_DISPLAY 中文映射 + 父单元段），与 buildNextAction 输出一致。
  base.guidance = buildReplanGuidance({
    prefix: buildPrefix({
      layer: "wave",
      unitId: unit.id,
      status: `${STATUS_DISPLAY[unit.status] ?? unit.status}（replan 后原地）`,
      parentUnitId: unit.parentUnitId,
    }),
    abandonedIds: input.abandonedIds,
    replanCount,
    impactSummary,
    nextCommand,
    // #1 D-017：replan 后下一步是 plan，透传 plan 的 input schema 段。
    schemaText,
    blockedHint,
    // 状态感知审视引导：无回流通道时省略「重新 plan 并重新 design-review」句（与 blockedHint 同屏矛盾）。
    planReachable,
  });

  // 机器可读字段同步重定向：buildNextAction(unit, "replan") 的 action 恒为 "plan"
  // （ACTION_TO_NEXT.replan），但 guidance 已重定向到 nextAction——action 必须一致，
  // 否则结构化消费者按该字段推命令，executing 状态推 "plan" 即 illegal_transition
  // （正是本改造要消除的死锁）。
  base.action = nextAction;

  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    replanImpact,
    nextAction: base,
  };
}

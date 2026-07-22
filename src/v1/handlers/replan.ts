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
import type { ExecutionUnit } from "../core/workunit.js";
import { checkFreeze } from "../rules/freeze.js";
import { computeImpact } from "../rules/replan.js";
import { saveUnit,transitionStatus } from "./internal.js";
import type { ActionResult, ReplanInput,V1Deps } from "./types.js";

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
  deps: V1Deps,
): ActionResult {
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

  // ── checkFreeze：验 abandoned 条目核心字段未被改/未删 ──
  const freezeViolations = checkFreeze(before, unit);

  // 短路：有 violation → 不 save、不改 statusHistory
  if (freezeViolations.length > 0) {
    return {
      unitId: unit.id,
      status: unit.status,
      ok: false,
      error: `replan freeze violated: ${freezeViolations.map((v) => v.reason).join("; ")}`,
      freezeViolations,
    };
  }

  // ── computeImpact：loadAll → 算影响面（wave 叶子通常空，机制通用）──
  const allRecords = deps.store.loadAll();
  // store 扁平存 ExecutionUnit 全字段；computeImpact 只读 id + basedOnParent（WorkUnitRecord
  // 上具名存在），故按 ExecutionUnit 透传安全。双重断言因 WorkUnitRecord 索引签名缺反向兼容。
  // eslint-disable-next-line taste/no-unsafe-cast
  const allUnits = allRecords as unknown as ExecutionUnit[];
  const replanImpact = computeImpact(allUnits, input.abandonedIds);

  // ── replan 旁路：status 不变，但 append statusHistory（from=to=current, action="replan", note）──
  transitionStatus(unit, "replan", deps.clock.now(), input.note);

  saveUnit(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    replanImpact,
  };
}

/**
 * v1 wave handler — design-review action（跑 9 个 gate + 写 designReviewJudgment）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、§2.7 + §11（WAVE_DESIGN_REVIEW_GATES gate 清单）、
 *      §3（layerSpecific 非空 gate）、state-machine WAVE_TRANSITIONS["design-review"]（progressive，planning/design-reviewed → design-reviewed）。
 *      design §3.4（新增跨 wave 文件冲突 gate）。
 *
 * 职责：
 * 1. load 兄弟 wave 的 plan.files（同 parent，已 design-review 之后，plan.files 才确定）注入聚合 gate
 * 2. 跑 9 个 design-review gate（2 个 testCases 结构 gate + 5 个 judgment 非空 gate
 *    + 1 个 wave layerSpecific 非空 gate + 1 个跨 wave 文件冲突 gate）
 * 3. 任一 gate fail → 短路返回 ok=false + gateResults（不改 status、不 save、不写 judgment）
 * 4. 全 pass → 写 designReviewJudgment → status 流转（→ design-reviewed）→ save
 *
 * gate fail 短路语义：gate 是状态流转的前置条件，fail 时不改任何状态。
 *
 * rules 层零 IO：跨 wave 文件冲突 gate 需要兄弟 wave 的 plan.files，但 rules 不查 store，
 * 故 siblingFiles 由本 handler 从 store.findChildren load 后注入（照 retrospect.ts:46-58 模式）。
 */
import type { WaveFile } from "../core/plan.js";
import type { ExecutionUnit } from "../core/workunit.js";
import { runWaveDesignReviewGates } from "../rules/gates/design-review.js";
import {
  appendFailRecord,
  buildFailureNextAction,
  buildNextAction,
  saveUnit,
  transitionStatus,
} from "./internal.js";
import type { ActionResult, CwDeps,DesignReviewInput } from "./types.js";

/**
 * 执行 design-review action。
 *
 * @param unit 已加载的 ExecutionUnit（status ∈ {planning, design-reviewed}）
 * @param input designReviewJudgment
 * @param deps 依赖注入（store / clock）
 */
export function handleDesignReview(
  unit: ExecutionUnit,
  input: DesignReviewInput,
  deps: CwDeps,
): ActionResult {
  // ── 跑 9 个 gate ──
  // 先 load 兄弟 wave 的 plan.files（rules 层零 IO，由 handler 注入聚合 gate）。
  // 照 slice/retrospect.ts:46-58 注入模式：从 store.findChildren load 数据再注入。
  const siblingFiles = unit.parentUnitId
    ? deps.store
        .findChildren(unit.parentUnitId)
        .filter((r) => {
          // 排除自身 + 只取 wave scope + 只取已 design-review 的（plan.files 才确定）
          const id = typeof r.id === "string" ? r.id : "";
          const scope = typeof r.scope === "string" ? r.scope : "";
          if (id === unit.id || scope !== "wave") return false;
          // 兄弟未 design-review 的 plan 可能为空或未定，只查已过 design-review 的
          const status = typeof r.status === "string" ? r.status : "";
          const reviewed = ["design-reviewed", "executing", "tested", "exec-reviewed", "retrospected"].includes(status);
          // 终态（closed/aborted）的兄弟不会并行 execute，跳过
          return reviewed;
        })
        .map((r) => {
          const plan = r.plan as { files?: WaveFile[] } | undefined;
          return {
            unitId: typeof r.id === "string" ? r.id : "",
            files: (plan?.files ?? []) as ReadonlyArray<WaveFile>,
          };
        })
    : [];

  // 聚合跑 9 个 gate（7 原子 + wave layerSpecific + 跨 wave 文件冲突）。
  // judgment / layerSpecific 取自 input（待写入的 designReviewJudgment），而非 unit（此时还未写入）。
  const gateResults = runWaveDesignReviewGates(
    unit,
    input.designReviewJudgment,
    input.designReviewJudgment.layerSpecific,
    siblingFiles,
  );

  // 短路：任一 fail → 不改 status、不写 judgment，但 append fail 记录 + 异常 guidance
  const failed = gateResults.filter((g) => !g.passed);
  if (failed.length > 0) {
    const reason = failed.map((g) => g.report).join("; ");
    appendFailRecord(deps, unit, "design-review", reason);
    const { nextAction, failureCount } = buildFailureNextAction(
      unit,
      "design-review",
      reason,
    );
    return {
      unitId: unit.id,
      status: unit.status,
      gateResults,
      ok: false,
      error: `design-review gate failed: ${reason}`,
      nextAction,
      failureCount,
    };
  }

  // ── 全 pass：写 judgment → status 流转 → save ──
  unit.designReviewJudgment = input.designReviewJudgment;
  transitionStatus(unit, "design-review", deps.clock.now());

  saveUnit(deps, unit);
  return {
    unitId: unit.id,
    status: unit.status,
    gateResults,
    ok: true,
    nextAction: buildNextAction(unit, "design-review"),
  };
}

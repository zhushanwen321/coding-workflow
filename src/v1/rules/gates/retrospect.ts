/**
 * v1 wave retrospect 阶段 gate 纯函数（领域规则，零 IO）。
 *
 * 来源：v5 wave 附录 A §11 line 1266-1271（WAVE_RETROSPECT_GATES 清单）、
 *      wave §7.3（机器 gate + 人审边界）、model §5.8（ref 约定：裸字段→字段名，数组元素→元素 id）。
 *
 * 职责：retrospect 阶段验 lessonsLearned 非空 + reviewedItems 覆盖 designReviewJudgment 核心项。
 *
 * 重要（wave §7.3）：
 * - lessonsLearned 是机器 gate（没提炼经验的 retrospect 是失败的 retrospect）
 * - reviewedItems 覆盖验「每项都有记录」，验不了 verdict 对错 / note 深度（人审）
 *
 * 不变量：rules 层零 IO。所有 gate 接收已加载的 RetrospectData / DesignReviewJudgment，返回 GateResult。
 */
import type {
  DesignReviewJudgment,
  ExecReviewJudgment,
  PlanningRetrospectData,
  RetrospectData,
  TestJudgment,
} from "../../core/judgments.js";
import type { Split } from "../../core/plan.js";
import type { Slice } from "../../core/workunit.js";
import type { GateResult } from "./types.js";

// 重新导出 GateResult，便于 `import { GateResult } from "./gates/retrospect.js"`
export type { GateResult };

// ═══════════════════════════════════════════════════════════════
// lessons-learned-non-empty
// ═══════════════════════════════════════════════════════════════

/**
 * wave §7.3 / 附录 A `lessons-learned-non-empty` — retrospectData.lessonsLearned 非空。
 *
 * 没有提炼出经验的 retrospect 是失败的 retrospect（wave §7.3）。
 * lessonsLearned 保留 string（经验提炼天生叙述性，不拆枚举，model §5.8）。
 */
export function lessonsLearnedNonEmpty(
  retrospectData: RetrospectData,
): GateResult {
  if (
    !retrospectData.lessonsLearned ||
    retrospectData.lessonsLearned.trim() === ""
  ) {
    return {
      passed: false,
      report: "lessons-learned-non-empty: lessonsLearned 为空（必须提炼经验）",
    };
  }
  return {
    passed: true,
    report: "lessons-learned-non-empty: lessonsLearned 非空",
  };
}

// ═══════════════════════════════════════════════════════════════
// retrospect-covers-judgments
// ═══════════════════════════════════════════════════════════════

/**
 * wave §7.3 / 附录 A `retrospect-covers-judgments` — reviewedItems 覆盖 designReviewJudgment 核心项。
 *
 * ref 约定（model §5.8）：
 * - 裸字段（necessity / sufficiency / alternatives）：ref = 字段名本身
 * - 数组元素（tradeoffs / risks 各元素）：ref = 元素 id
 *
 * 本 gate 验 reviewedItems.itemId 覆盖 designReviewJudgment 的核心项集合：
 *   { "necessity", "sufficiency", "alternatives" } ∪ { tradeoff.id... } ∪ { risk.id... }
 *
 * 注意（wave §7.3 人审边界）：机器只验「每项都有记录」，验不了 outcome 对错 / note 深度。
 *
 * 对照三处判断（wave 附录 A §7.1）：reviewedItems 应覆盖 designReviewJudgment + testJudgment
 * + execReviewJudgment 的所有结构化判断项。testJudgment / execReviewJudgment 为可选
 *（仅 ExecutionUnit 拥有；PlanningUnit 不调用本 gate，而用 reviewedItemsCoverDesignReview）。
 */
export function retrospectCoversJudgments(
  retrospectData: RetrospectData,
  designReviewJudgment: DesignReviewJudgment,
  testJudgment?: TestJudgment,
  execReviewJudgment?: ExecReviewJudgment,
): GateResult {
  // 构造期望被覆盖的 itemId 集合（ref 约定：裸字段→字段名，数组元素→元素 id）
  const expected = new Set<string>();
  expected.add("necessity");
  expected.add("sufficiency");
  expected.add("alternatives");
  for (const t of designReviewJudgment.tradeoffs) {
    expected.add(t.id);
  }
  for (const r of designReviewJudgment.risks) {
    expected.add(r.id);
  }

  // testJudgment 对照项（wave 附录 A §5）：sufficiencyMet / alternatives 裸字段名 +
  // tradeoffCostRealized[].tradeoffRef + riskOutcome[].riskRef（这些 ref 本就指向 designReviewJudgment
  // 的 tradeoff/risk id，与上面合并去重，确保验收侧显式覆盖）。
  if (testJudgment) {
    expected.add("necessityMet");
    expected.add("sufficiencyMet");
    expected.add("alternativesReconsidered");
    for (const tc of testJudgment.tradeoffCostRealized) {
      expected.add(tc.tradeoffRef);
    }
    for (const ro of testJudgment.riskOutcome) {
      expected.add(ro.riskRef);
    }
  }

  // execReviewJudgment 对照项（wave 附录 A §6）：readability / architecture 裸字段名 +
  // codeSmells.items 各项 + followupActions[].description。
  if (execReviewJudgment) {
    expected.add("readability");
    expected.add("architecture");
    if (execReviewJudgment.codeSmells) {
      for (const item of execReviewJudgment.codeSmells.items) {
        expected.add(`codeSmell:${item}`);
      }
    }
    if (execReviewJudgment.followupActions) {
      for (const fa of execReviewJudgment.followupActions) {
        expected.add(`followup:${fa.description}`);
      }
    }
  }

  // reviewedItems 实际覆盖的 itemId 集合
  const covered = new Set(retrospectData.reviewedItems.map((r) => r.itemId));

  // 找出期望但未覆盖的项
  const missing: string[] = [];
  for (const id of Array.from(expected)) {
    if (!covered.has(id)) {
      missing.push(id);
    }
  }

  if (missing.length > 0) {
    return {
      passed: false,
      report: `retrospect-covers-judgments: reviewedItems 未覆盖核心判断项（缺失: ${missing.join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: `retrospect-covers-judgments: reviewedItems 覆盖全部 ${expected.size} 项核心判断`,
  };
}

// ═══════════════════════════════════════════════════════════════
// slice retrospect gate（slice 附录 A §11 / slice §5.5）
// ═══════════════════════════════════════════════════════════════
// 来源：design-v5-slice.md §5.5（SLICE_RETROSPECT_GATES 清单）、§5.2（split-fulfillment-covers-plan）。
//
// 重要约束：rules 层零 IO。slice 的 all-waves-closed 需要查 child wave 状态，
// 但 rules 层不查 store——所以这个 gate 的签名接收 childStatuses 参数（由 handler 从 store
// findChildren 拿到后注入），不直接查 store。

/**
 * slice §5.5 / 附录 A `all-waves-closed` — 所有 child wave 都进入终态（closed 或 aborted）。
 *
 * rules 层零 IO：childStatuses 由 handler 注入（handler 调 store.findChildren 后把每个
 * child 的 status 收集成数组传入）。本 gate 只判定「是否全终态」。
 *
 * @param childStatuses 所有 child wave 的当前 status（由 handler 从 store 查询后注入）
 */
export function allWavesClosed(
  childStatuses: ReadonlyArray<"closed" | "aborted" | string>,
): GateResult {
  if (childStatuses.length === 0) {
    return {
      passed: false,
      report: "all-waves-closed: 没有 child wave（slice 必须拆出 wave 并全部走完才可 retrospect）",
    };
  }
  const nonTerminal = childStatuses.filter((s) => s !== "closed" && s !== "aborted");
  if (nonTerminal.length > 0) {
    return {
      passed: false,
      report: `all-waves-closed: ${nonTerminal.length} 个 child wave 未进入终态（status: ${nonTerminal.join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: `all-waves-closed: 全部 ${childStatuses.length} 个 child wave 已终态（closed/aborted）`,
  };
}

/**
 * slice §5.5 `split-fulfillment-covers-plan` — splitFulfillment 覆盖 SlicePlan.split 的所有 slug。
 *
 * 每个 split（对应一个 wave）必须有一条 splitFulfillment 记录。机器只验覆盖（不验 verdict 对错）。
 *
 * @param retrospectData slice 的复盘数据（含 splitFulfillment）
 * @param split SlicePlan.split 的全部项
 */
export function splitFulfillmentCoversPlan(
  retrospectData: PlanningRetrospectData,
  split: ReadonlyArray<Split>,
): GateResult {
  const expected = new Set(split.map((s) => s.slug));
  const covered = new Set(retrospectData.splitFulfillment.map((f) => f.splitSlug));
  const missing: string[] = [];
  for (const slug of Array.from(expected)) {
    if (!covered.has(slug)) {
      missing.push(slug);
    }
  }
  if (missing.length > 0) {
    return {
      passed: false,
      report: `split-fulfillment-covers-plan: splitFulfillment 未覆盖 split 的所有项（缺失: ${missing.join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: `split-fulfillment-covers-plan: splitFulfillment 覆盖全部 ${expected.size} 个 split slug`,
  };
}

/**
 * slice §5.5 `reviewed-items-cover-design-review` — reviewedItems 覆盖 designReviewJudgment 每一项。
 *
 * 与 wave 的 retrospectCoversJudgments 同构（ref 约定：裸字段→字段名，数组元素→元素 id），
 * 只是入参用 slice 的 retrospectData 类型（PlanningRetrospectData，含 splitFulfillment 等
 * 扩展字段，但 reviewedItems 字段继承自基类，逻辑一致）。
 */
export function reviewedItemsCoverDesignReview(
  retrospectData: PlanningRetrospectData,
  designReviewJudgment: DesignReviewJudgment,
): GateResult {
  const expected = new Set<string>();
  expected.add("necessity");
  expected.add("sufficiency");
  expected.add("alternatives");
  for (const t of designReviewJudgment.tradeoffs) {
    expected.add(t.id);
  }
  for (const r of designReviewJudgment.risks) {
    expected.add(r.id);
  }

  const covered = new Set(retrospectData.reviewedItems.map((r) => r.itemId));
  const missing: string[] = [];
  for (const id of Array.from(expected)) {
    if (!covered.has(id)) {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    return {
      passed: false,
      report: `reviewed-items-cover-design-review: reviewedItems 未覆盖 designReviewJudgment 核心项（缺失: ${missing.join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: `reviewed-items-cover-design-review: reviewedItems 覆盖全部 ${expected.size} 项核心判断`,
  };
}

/**
 * slice §5.5 `lessons-learned-non-empty`（slice 版）— PlanningRetrospectData.lessonsLearned 非空。
 *
 * 与 wave 的 lessonsLearnedNonEmpty 同构，入参用 PlanningRetrospectData（lessonsLearned 继承自基类）。
 */
export function sliceLessonsLearnedNonEmpty(
  retrospectData: PlanningRetrospectData,
): GateResult {
  if (!retrospectData.lessonsLearned || retrospectData.lessonsLearned.trim() === "") {
    return {
      passed: false,
      report: "lessons-learned-non-empty: lessonsLearned 为空（必须提炼经验）",
    };
  }
  return {
    passed: true,
    report: "lessons-learned-non-empty: lessonsLearned 非空",
  };
}

/**
 * PlanningUnit §5.5 `child-unit-evidence-complete` — childUnitIdsEvidence 覆盖 executeResult.childUnitIds。
 *
 * 防止 agent 漏验某些子单元：每个 execute 出来的 childUnitId 必须在 retrospectData.childUnitIdsEvidence
 * 里有对应记录（带 closeout 证据摘要）。
 */
export function childUnitEvidenceComplete(
  childUnitIdsEvidence: PlanningRetrospectData["childUnitIdsEvidence"],
  expectedChildUnitIds: ReadonlyArray<string>,
): GateResult {
  const covered = new Set(childUnitIdsEvidence.map((e) => e.childId));
  const missing = expectedChildUnitIds.filter((id) => !covered.has(id));
  if (missing.length > 0) {
    return {
      passed: false,
      report: `child-unit-evidence-complete: ${missing.length} 个 childUnit 未在 childUnitIdsEvidence 覆盖（缺失: ${missing.join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: `child-unit-evidence-complete: 全部 ${expectedChildUnitIds.length} 个 childUnitId 都被 childUnitIdsEvidence 覆盖`,
  };
}

/**
 * PlanningUnit §5.5 `delivery-verdict-non-empty` — PlanningRetrospectData.deliveryVerdict 非空。
 *
 * deliveryVerdict 是枚举（delivered/partial/failed），类型上已禁 undefined，但本 gate 作为显式机器检查
 * 防御运行时被置空（handler 解析输入容错）。
 */
export function deliveryVerdictNonEmpty(
  deliveryVerdict: "delivered" | "partial" | "failed" | undefined,
): GateResult {
  if (!deliveryVerdict) {
    return {
      passed: false,
      report: "delivery-verdict-non-empty: deliveryVerdict 为空",
    };
  }
  return {
    passed: true,
    report: `delivery-verdict-non-empty: deliveryVerdict=${deliveryVerdict}`,
  };
}

/**
 * 跑 slice retrospect 全部 7 个 gate（slice §5.5 SLICE_RETROSPECT_GATES）。
 *
 * childStatuses 由 handler 从 store.findChildren 查询后注入（rules 层零 IO）。
 * evidenceChildDelivery 由 handler 从 unit.evidence.childDelivery 读取后注入（rules 层零 IO）。
 *
 * @param unit 待校验的 Slice
 * @param childStatuses 所有 child wave 的当前 status（handler 注入）
 * @param evidenceChildDelivery evidence.childDelivery 记录（handler 注入，用于一致性校验）
 */
export function runSliceRetrospectGates(
  unit: Slice,
  childStatuses: ReadonlyArray<"closed" | "aborted" | string>,
  evidenceChildDelivery?: ReadonlyArray<{ splitSlug: string; childUnitId: string; childStatus: string }>,
): GateResult[] {
  return [
    allWavesClosed(childStatuses),
    sliceLessonsLearnedNonEmpty(unit.retrospectData),
    reviewedItemsCoverDesignReview(unit.retrospectData, unit.designReviewJudgment),
    splitFulfillmentCoversPlan(unit.retrospectData, unit.plan.split),
    childUnitEvidenceComplete(unit.retrospectData.childUnitIdsEvidence, unit.executeResult.childUnitIds),
    deliveryVerdictNonEmpty(unit.retrospectData.deliveryVerdict),
    childDeliveryConsistency(unit.retrospectData.childUnitIdsEvidence, evidenceChildDelivery ?? []),
  ];
}

/**
 * PlanningUnit §5.5 `child-delivery-consistency` — childUnitIdsEvidence 与 evidence.childDelivery 一致性校验。
 *
 * 防止 agent 填出与客观 childDelivery 矛盾的验收结论：
 * - childUnitIdsEvidence 中的每个 childId 必须在 evidence.childDelivery 中有对应记录
 * - evidence.childDelivery 中的每个 childUnitId 必须在 childUnitIdsEvidence 中有对应记录
 * - 两者的 childStatus 应一致（evidence.childDelivery 是客观状态，childUnitIdsEvidence 是 agent 填的验收状态）
 *
 * @param childUnitIdsEvidence agent 填的验收证据
 * @param evidenceChildDelivery 客观的 childDelivery 记录
 */
export function childDeliveryConsistency(
  childUnitIdsEvidence: ReadonlyArray<{ childId: string; status: string }>,
  evidenceChildDelivery: ReadonlyArray<{ splitSlug: string; childUnitId: string; childStatus: string }>,
): GateResult {
  // evidence.childDelivery 为空时跳过一致性校验（PlanningUnit 的 evidence.childDelivery
  // 由 execute 阶段 rollup 填充，单元未经过 execute 或未接入 rollup 时为空数组，
  // 此时无法做一致性校验，视为“无数据可对照”而非“不一致”。）
  if (evidenceChildDelivery.length === 0) {
    return {
      passed: true,
      report: "child-delivery-consistency: evidence.childDelivery 为空，跳过一致性校验",
    };
  }

  const evidenceChildIds = new Set(evidenceChildDelivery.map((d) => d.childUnitId));
  const evidenceChildIdSet = new Set(childUnitIdsEvidence.map((e) => e.childId));

  const missingInEvidence: string[] = [];
  for (const childId of evidenceChildIdSet) {
    if (!evidenceChildIds.has(childId)) {
      missingInEvidence.push(childId);
    }
  }

  const missingInChildUnitIds: string[] = [];
  for (const childId of evidenceChildIds) {
    if (!evidenceChildIdSet.has(childId)) {
      missingInChildUnitIds.push(childId);
    }
  }

  const statusMismatches: string[] = [];
  for (const delivery of evidenceChildDelivery) {
    const agentRecord = childUnitIdsEvidence.find((e) => e.childId === delivery.childUnitId);
    if (agentRecord && agentRecord.status !== delivery.childStatus) {
      statusMismatches.push(
        `${delivery.childUnitId}: agent=${agentRecord.status} vs evidence=${delivery.childStatus}`
      );
    }
  }

  const issues: string[] = [];
  if (missingInEvidence.length > 0) {
    issues.push(`childUnitIdsEvidence 中的 childId 在 evidence.childDelivery 中缺失: ${missingInEvidence.join(", ")}`);
  }
  if (missingInChildUnitIds.length > 0) {
    issues.push(`evidence.childDelivery 中的 childUnitId 在 childUnitIdsEvidence 中缺失: ${missingInChildUnitIds.join(", ")}`);
  }
  if (statusMismatches.length > 0) {
    issues.push(`childStatus 不一致: ${statusMismatches.join("; ")}`);
  }

  if (issues.length > 0) {
    return {
      passed: false,
      report: `child-delivery-consistency: ${issues.join("; ")}`,
    };
  }

  return {
    passed: true,
    report: `child-delivery-consistency: childUnitIdsEvidence 与 evidence.childDelivery 一致（${evidenceChildIds.size} 个 child）`,
  };
}

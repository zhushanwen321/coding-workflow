/**
 * v1 wave design-review 阶段 gate 纯函数（领域规则，零 IO）。
 *
 * 来源：v5 wave 附录 A §11 line 1227-1239（WAVE_DESIGN_REVIEW_GATES 清单）、
 *      wave §2.7（机器 gate 清单 + 取舍说明）、§3（layerSpecific 非空 gate）。
 *
 * 职责：design-review 阶段对 plan 产物（testCases）+ designReviewJudgment 的机器 gate。
 *      只验结构（非空 / 完整），不验内容质量（内容靠人审）。
 *
 * 不变量：rules 层零 IO。所有 gate 接收已加载的数据（ExecutionUnit / DesignReviewJudgment），
 *      返回统一的 GateResult { passed, report }。
 */
import type { DesignReviewJudgment, SliceDesignReviewLayerSpecific } from "../../core/judgments.js";
import type { ExecutionUnit, Slice } from "../../core/workunit.js";
import type { GateResult } from "./types.js";

// 重新导出 GateResult，便于 `import { GateResult } from "./gates/design-review.js"`
export type { GateResult };

// ═══════════════════════════════════════════════════════════════
// 结构完整性 gate（testCases）
// ═══════════════════════════════════════════════════════════════

/**
 * wave §2.7 / 附录 A `test-cases-non-empty` — testCases 至少 1 条。
 *
 * testCases 是 TDD 硬前提（没测试 execute 不了），必须机器验。
 */
export function testCasesNonEmpty(unit: ExecutionUnit): GateResult {
  const count = unit.plan.testCases.length;
  if (count < 1) {
    return {
      passed: false,
      report: "test-cases-non-empty: testCases 为空（TDD 要求至少 1 条测试用例）",
    };
  }
  return {
    passed: true,
    report: `test-cases-non-empty: testCases 有 ${count} 条`,
  };
}

/**
 * wave §2.7 / 附录 A `test-cases-have-expected` — 每个 WaveTestCase.expected 非空。
 *
 * TDD 红灯前提：expected 由 agent 自填，cw 只验填了（不验对错，§5.2）。
 */
export function testCasesHaveExpected(unit: ExecutionUnit): GateResult {
  const empty = unit.plan.testCases.filter((tc) => !tc.expected || tc.expected.trim() === "");
  if (empty.length > 0) {
    return {
      passed: false,
      report: `test-cases-have-expected: ${empty.length} 条 testCases 的 expected 为空（ids: ${empty.map((t) => t.id).join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: `test-cases-have-expected: 全部 ${unit.plan.testCases.length} 条 testCases 的 expected 非空`,
  };
}

// ═══════════════════════════════════════════════════════════════
// 业务判断非空 gate（designReviewJudgment，model §5.8 通用要求）
// ═══════════════════════════════════════════════════════════════

/**
 * 附录 A `design-review-necessity-non-empty` — designReviewJudgment.necessity 非空。
 *
 * necessity 是「这个 wave 对 slice 的贡献」判断，model §5.8 必填。
 */
export function designReviewNecessityNonEmpty(
  judgment: DesignReviewJudgment,
): GateResult {
  if (!judgment.necessity || judgment.necessity.trim() === "") {
    return {
      passed: false,
      report: "design-review-necessity-non-empty: necessity 为空",
    };
  }
  return {
    passed: true,
    report: "design-review-necessity-non-empty: necessity 非空",
  };
}

/**
 * 附录 A `design-review-sufficiency-complete` — sufficiency 的 gaps/overlaps/meceNote 完整。
 *
 * meceNote 非空是核心（gaps/overlaps 可为空数组，但 MECE 判断说明必须给）。
 */
export function designReviewSufficiencyComplete(
  judgment: DesignReviewJudgment,
): GateResult {
  const s = judgment.sufficiency;
  if (!s) {
    return {
      passed: false,
      report: "design-review-sufficiency-complete: sufficiency 缺失",
    };
  }
  if (!s.meceNote || s.meceNote.trim() === "") {
    return {
      passed: false,
      report: "design-review-sufficiency-complete: sufficiency.meceNote 为空（MECE 判断说明必填）",
    };
  }
  return {
    passed: true,
    report: `design-review-sufficiency-complete: meceNote 非空（gaps=${s.gaps.length}, overlaps=${s.overlaps.length}）`,
  };
}

/**
 * 附录 A `design-review-alternatives-non-empty` — alternatives 非空。
 *
 * alternatives 是「考虑过的替代方案」判断，model §5.8 必填。
 */
export function designReviewAlternativesNonEmpty(
  judgment: DesignReviewJudgment,
): GateResult {
  if (!judgment.alternatives || judgment.alternatives.trim() === "") {
    return {
      passed: false,
      report: "design-review-alternatives-non-empty: alternatives 为空",
    };
  }
  return {
    passed: true,
    report: "design-review-alternatives-non-empty: alternatives 非空",
  };
}

/**
 * 附录 A `design-review-tradeoffs-present` — tradeoffs 至少 1 条或显式声明。
 *
 * 简化（按 spec）：tradeoffs 数组非空即可。
 * 完整语义应是「至少 1 条或显式声明『无』+ 理由」，但 v5 wave 附录 A 的 gate 清单
 * 只验 present，具体内容由 agent 自负责（machine gate 只验结构，§6.5 诚实说明）。
 */
export function designReviewTradeoffsPresent(
  judgment: DesignReviewJudgment,
): GateResult {
  if (judgment.tradeoffs.length < 1) {
    return {
      passed: false,
      report: "design-review-tradeoffs-present: tradeoffs 为空（至少 1 条，或显式声明「无」+ 理由）",
    };
  }
  return {
    passed: true,
    report: `design-review-tradeoffs-present: tradeoffs 有 ${judgment.tradeoffs.length} 条`,
  };
}

/**
 * 附录 A `design-review-risks-present` — risks 至少 1 条或显式声明。
 *
 * 简化（按 spec）：risks 数组非空即可（同 tradeoffs 的处理逻辑）。
 */
export function designReviewRisksPresent(
  judgment: DesignReviewJudgment,
): GateResult {
  if (judgment.risks.length < 1) {
    return {
      passed: false,
      report: "design-review-risks-present: risks 为空（至少 1 条，或显式声明「无」+ 理由）",
    };
  }
  return {
    passed: true,
    report: `design-review-risks-present: risks 有 ${judgment.risks.length} 条`,
  };
}

// ═══════════════════════════════════════════════════════════════
// slice design-review gate（slice 附录 A §11 / slice §5.5）
// ═══════════════════════════════════════════════════════════════
// 来源：design-v5-slice.md §5.5（SLICE_DESIGN_REVIEW_GATES 清单）、§3（layerSpecific 6 字段）。
// 与 wave gate 的差异：
//   - gate 接收 Slice（plan 是 SlicePlan，而非 WavePlan）
//   - 结构完整性验 techChoices / split + split DAG 无环（wave 验 testCases）
//   - 多一条 layer-specific-non-empty（slice 专属 6 字段，wave 无）

/**
 * slice §5.5 / 附录 A `tech-choice-non-empty` — SlicePlan.techChoices 至少 1 条。
 *
 * techChoices 是 slice 技术方案的核心（选型记录），没有选型的 slice 等于没做技术决策。
 */
export function techChoiceNonEmpty(unit: Slice): GateResult {
  const count = unit.plan.techChoices.length;
  if (count < 1) {
    return {
      passed: false,
      report: "tech-choice-non-empty: techChoices 为空（slice 必须有至少 1 条技术选型）",
    };
  }
  return {
    passed: true,
    report: `tech-choice-non-empty: techChoices 有 ${count} 条`,
  };
}

/**
 * slice §5.5 / 附录 A `split-non-empty` — SlicePlan.split 至少 1 项。
 *
 * split 描述 slice 如何拆成 wave（无 split = 没法 execute 创建下层 wave）。
 */
export function splitNonEmpty(unit: Slice): GateResult {
  const count = unit.plan.split.length;
  if (count < 1) {
    return {
      passed: false,
      report: "split-non-empty: split 为空（slice 必须拆出至少 1 个 wave）",
    };
  }
  return {
    passed: true,
    report: `split-non-empty: split 有 ${count} 项`,
  };
}

/**
 * slice §5.5 / 附录 A `split-dag-valid` — split 的 dependsOn 依赖关系无环（拓扑排序 DFS 判环）。
 *
 * split 项之间通过 dependsOn 声明执行顺序依赖（如 wave-b dependsOn wave-a）。
 * 环意味着无法确定执行顺序，execute 会死锁。机器必须验。
 *
 * 判环算法：对 split 的 slug 集合做 DFS，三色标记法（白/灰/黑），
 * 遇到灰节点（在当前 DFS 路径上）即有环。dependsOn 引用不存在的 slug 忽略（不构成环，
 * 是数据完整性问题，由其他校验/人审覆盖）。
 */
export function splitDagValid(unit: Slice): GateResult {
  const splits = unit.plan.split;
  const slugs = new Set(splits.map((s) => s.slug));
  // dependsOn 邻接表：slug → 它依赖的（必须在它之前完成的）slug 列表
  const depsBySlug = new Map<string, string[]>();
  for (const s of splits) {
    depsBySlug.set(
      s.slug,
      (s.dependsOn ?? []).filter((d) => slugs.has(d)),
    );
  }

  // 三色 DFS 判环：COLOR_WHITE=未访问, COLOR_GRAY=访问中（在当前路径）, COLOR_BLACK=已完成
  const COLOR_WHITE = 0;
  const COLOR_GRAY = 1;
  const COLOR_BLACK = 2;
  const color = new Map<string, number>();
  for (const slug of slugs) color.set(slug, COLOR_WHITE);

  let hasCycle = false;
  let cycleSlug = "";
  const visit = (slug: string): void => {
    if (hasCycle) return;
    const c = color.get(slug);
    if (c === COLOR_GRAY) {
      // 回到当前路径上的节点 → 环
      hasCycle = true;
      cycleSlug = slug;
      return;
    }
    if (c === COLOR_BLACK) return; // 已完成，跳过
    color.set(slug, COLOR_GRAY); // 标灰
    for (const dep of depsBySlug.get(slug) ?? []) {
      visit(dep);
      if (hasCycle) return;
    }
    color.set(slug, COLOR_BLACK); // 标黑
  };

  for (const slug of slugs) {
    if (color.get(slug) === COLOR_WHITE) visit(slug);
    if (hasCycle) break;
  }

  if (hasCycle) {
    return {
      passed: false,
      report: `split-dag-valid: split 的 dependsOn 存在环（涉及 slug "${cycleSlug}"，无法确定 wave 执行顺序）`,
    };
  }
  return {
    passed: true,
    report: `split-dag-valid: split 的 dependsOn 无环（${slugs.size} 个 slug 拓扑有序）`,
  };
}

/**
 * slice §5.5 / 附录 A `layer-specific-non-empty` — designReviewJudgment.layerSpecific 的 6 个字段都非空。
 *
 * layerSpecific 是 slice 专属的设计审查维度（SliceDesignReviewLayerSpecific 6 字段），
 * 都是人审判断，gate 只验填了（不验内容质量）。layerSpecific 可能 undefined（空态），需 guard。
 */
export function layerSpecificNonEmpty(unit: Slice): GateResult {
  const ls = unit.designReviewJudgment.layerSpecific as
    | SliceDesignReviewLayerSpecific
    | undefined;
  if (!ls) {
    return {
      passed: false,
      report: "layer-specific-non-empty: designReviewJudgment.layerSpecific 缺失（slice 必须填 6 个专属维度）",
    };
  }
  const requiredKeys: ReadonlyArray<keyof SliceDesignReviewLayerSpecific> = [
    "techChoiceRationale",
    "interfaceContractNote",
    "dataModelSoundness",
    "errorCoverage",
    "testabilityNote",
    "crossWaveContractNote",
  ];
  const empty: string[] = [];
  for (const k of requiredKeys) {
    const v = ls[k];
    if (!v || v.trim() === "") {
      empty.push(k);
    }
  }
  if (empty.length > 0) {
    return {
      passed: false,
      report: `layer-specific-non-empty: layerSpecific 以下字段为空（${empty.join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: `layer-specific-non-empty: layerSpecific 6 个字段都非空`,
  };
}

// ═══════════════════════════════════════════════════════════════
// slice design-review gate 聚合
// ═══════════════════════════════════════════════════════════════

/**
 * 跑 slice design-review 全部 9 个 gate（slice §5.5 SLICE_DESIGN_REVIEW_GATES）。
 *
 * 顺序对应附录清单：结构完整性（3）→ 业务判断非空（5，复用 wave 的 judgment gate）
 * → layerSpecific 非空（1）。返回全部 GateResult，调用方按 passed 过滤 mustFix。
 *
 * @param unit 待校验的 Slice
 */
export function runSliceDesignReviewGates(unit: Slice): GateResult[] {
  const judgment = unit.designReviewJudgment;
  return [
    techChoiceNonEmpty(unit),
    splitNonEmpty(unit),
    splitDagValid(unit),
    designReviewNecessityNonEmpty(judgment),
    designReviewSufficiencyComplete(judgment),
    designReviewAlternativesNonEmpty(judgment),
    designReviewTradeoffsPresent(judgment),
    designReviewRisksPresent(judgment),
    layerSpecificNonEmpty(unit),
  ];
}

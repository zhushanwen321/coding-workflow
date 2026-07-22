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
import type { RetrospectData, DesignReviewJudgment } from "../../core/judgments.js";
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
 * 完整语义应覆盖 designReviewJudgment + testJudgment + execReviewJudgment 三处，
 * 但本 gate 按 spec 简化只覆盖 designReviewJudgment 的核心项（testJudgment / execReviewJudgment
 * 的对照项可由 handlers 层组合调用或后续扩展）。
 */
export function retrospectCoversJudgments(
  retrospectData: RetrospectData,
  designReviewJudgment: DesignReviewJudgment,
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
      report: `retrospect-covers-judgments: reviewedItems 未覆盖 designReviewJudgment 核心项（缺失: ${missing.join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: `retrospect-covers-judgments: reviewedItems 覆盖全部 ${expected.size} 项核心判断`,
  };
}

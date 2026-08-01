/**
 * v1 epic gate 测试。
 *
 * 测 epic design-review 的 11 个 gate（纯函数，零 IO）：
 * - split 结构完整性 3：epicSplitNonEmpty / epicSplitDagValid / epicDuplicateSplitSlug（slug 唯一）
 * - 决策已解决 + inheritedItemIds 有效 2：allDecisionsResolved / inheritedItemIdsValid
 * - judgment 非空 5（复用 wave/slice/feature 的 necessity/sufficiency/alternatives/tradeoffs/risks）
 * - epic layerSpecific 非空 1（epic 专属 5 字段：strategicAlignment/featureSplitRationale/
 *   scopeBoundary/priorityRationale/resourceEstimate）
 *
 * 另测 runEpicDesignReviewGates 聚合：合法 → 11 个全 pass；构造各种 fail 场景验正确 gate fail。
 *
 * 关键差异（epic vs feature）：epic 无 FR-AC 强引用 3 gate（epic 不产 spec），
 * layerSpecific 是 5 字段（feature 是 6 字段）。
 *
 * 用 makeEpicUnit + 合法工厂构造基线，手动设坏字段触发 fail（每个 gate 覆盖 pass + fail）。
 */
import { describe, expect, it } from "vitest";

import type { DesignReviewJudgment } from "../src/core/judgments.js";
import type { Epic } from "../src/core/workunit.js";
import {
  designReviewAlternativesNonEmpty,
  designReviewNecessityNonEmpty,
  designReviewRisksPresent,
  designReviewSufficiencyComplete,
  designReviewTradeoffsPresent,
  epicLayerSpecificNonEmpty,
  epicSplitDagValid,
  epicSplitNonEmpty,
  runEpicDesignReviewGates,
} from "../src/rules/gates/design-review.js";
import {
  makeEpicUnit,
  makeValidClarification,
  makeValidEpicDesignReviewJudgment,
  makeValidEpicLayerSpecific,
  makeValidEpicPlan,
} from "./helpers/epic-env.js";

// ── 辅助：构造一个已填好合法 plan + judgment 的 epic（design-review 全 pass 基线）──

/** 构造合法 epic（plan + judgment 都填好，11 个 design-review gate 全过）。 */
function validEpic(): Epic {
  const unit = makeEpicUnit();
  // clarifications 补 Q1（makeValidEpicPlan 的 split.inheritedItemIds 引用 Q1，需存在）
  unit.clarifications = [makeValidClarification("Q1")];
  // 写入合法 plan（只 split）
  unit.plan = makeValidEpicPlan();
  // 写入合法 judgment
  unit.designReviewJudgment = makeValidEpicDesignReviewJudgment();
  return unit;
}

// ═══════════════════════════════════════════════════════════════
// split 结构完整性（2 个）
// ═══════════════════════════════════════════════════════════════

describe("epic design-review gates: split 结构完整性", () => {
  // epicSplitNonEmpty
  describe("epicSplitNonEmpty", () => {
    it("split 至少 1 项 → pass", () => {
      expect(epicSplitNonEmpty(validEpic()).passed).toBe(true);
    });

    it("split 为空 → fail", () => {
      const unit = validEpic();
      unit.plan.split = [];
      const r = epicSplitNonEmpty(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/feature-split-non-empty/);
    });
  });

  // epicSplitDagValid
  describe("epicSplitDagValid", () => {
    it("无依赖（dependsOn 全空）→ pass", () => {
      expect(epicSplitDagValid(validEpic()).passed).toBe(true);
    });

    it("线性依赖（A→B→C）→ pass", () => {
      const unit = validEpic();
      unit.plan.split = [
        { slug: "a", description: "a", dependsOn: [], inheritedItemIds: [] },
        { slug: "b", description: "b", dependsOn: ["a"], inheritedItemIds: [] },
        { slug: "c", description: "c", dependsOn: ["b"], inheritedItemIds: [] },
      ];
      expect(epicSplitDagValid(unit).passed).toBe(true);
    });

    it("环（A dependsOn B, B dependsOn A）→ fail", () => {
      const unit = validEpic();
      unit.plan.split = [
        { slug: "a", description: "a", dependsOn: ["b"], inheritedItemIds: [] },
        { slug: "b", description: "b", dependsOn: ["a"], inheritedItemIds: [] },
      ];
      const r = epicSplitDagValid(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/split-dag-valid/);
    });

    it("自环（A dependsOn A）→ fail", () => {
      const unit = validEpic();
      unit.plan.split = [
        { slug: "a", description: "a", dependsOn: ["a"], inheritedItemIds: [] },
      ];
      expect(epicSplitDagValid(unit).passed).toBe(false);
    });

    it("dependsOn 引用不存在的 slug（忽略，不构成环）→ pass", () => {
      const unit = validEpic();
      unit.plan.split = [
        { slug: "a", description: "a", dependsOn: ["ghost"], inheritedItemIds: [] },
      ];
      expect(epicSplitDagValid(unit).passed).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// judgment 非空（5 个，复用 wave/slice/feature）
// ═══════════════════════════════════════════════════════════════

describe("epic design-review gates: judgment 非空（5 个，复用 wave/slice/feature）", () => {
  function fullJudgment(): DesignReviewJudgment {
    return makeValidEpicDesignReviewJudgment();
  }

  it("necessity 空 → fail；非空 → pass", () => {
    const j = fullJudgment();
    j.necessity = "";
    expect(designReviewNecessityNonEmpty(j).passed).toBe(false);
    expect(designReviewNecessityNonEmpty(fullJudgment()).passed).toBe(true);
  });

  it("sufficiency.meceNote 空 → fail；非空 → pass", () => {
    const j = fullJudgment();
    j.sufficiency.meceNote = "";
    expect(designReviewSufficiencyComplete(j).passed).toBe(false);
    expect(designReviewSufficiencyComplete(fullJudgment()).passed).toBe(true);
  });

  it("alternatives 空 → fail；非空 → pass", () => {
    const j = fullJudgment();
    j.alternatives = "";
    expect(designReviewAlternativesNonEmpty(j).passed).toBe(false);
    expect(designReviewAlternativesNonEmpty(fullJudgment()).passed).toBe(true);
  });

  it("tradeoffs 空 → fail；非空 → pass", () => {
    const j = fullJudgment();
    j.tradeoffs = [];
    expect(designReviewTradeoffsPresent(j).passed).toBe(false);
    expect(designReviewTradeoffsPresent(fullJudgment()).passed).toBe(true);
  });

  it("risks 空 → fail；非空 → pass", () => {
    const j = fullJudgment();
    j.risks = [];
    expect(designReviewRisksPresent(j).passed).toBe(false);
    expect(designReviewRisksPresent(fullJudgment()).passed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// epic layerSpecific 非空（5 字段，epic 专属）
// ═══════════════════════════════════════════════════════════════

describe("epic design-review gates: epic layerSpecific 非空（5 字段）", () => {
  it("layerSpecific undefined → fail", () => {
    const unit = validEpic();
    unit.designReviewJudgment.layerSpecific = undefined;
    const r = epicLayerSpecificNonEmpty(unit);
    expect(r.passed).toBe(false);
    expect(r.report).toMatch(/layer-specific-non-empty/);
  });

  it("5 字段全填 → pass", () => {
    expect(epicLayerSpecificNonEmpty(validEpic()).passed).toBe(true);
  });

  it("5 字段缺一（strategicAlignment 空）→ fail", () => {
    const unit = validEpic();
    const ls = { ...makeValidEpicLayerSpecific(), strategicAlignment: "" };
    unit.designReviewJudgment.layerSpecific =
      ls as unknown as DesignReviewJudgment["layerSpecific"];
    const r = epicLayerSpecificNonEmpty(unit);
    expect(r.passed).toBe(false);
    expect(r.report).toMatch(/strategicAlignment/);
  });

  it("5 字段缺一（featureSplitRationale 纯空白）→ fail", () => {
    const unit = validEpic();
    const ls = { ...makeValidEpicLayerSpecific(), featureSplitRationale: "   " };
    unit.designReviewJudgment.layerSpecific =
      ls as unknown as DesignReviewJudgment["layerSpecific"];
    expect(epicLayerSpecificNonEmpty(unit).passed).toBe(false);
  });

  it("5 字段缺一（scopeBoundary 空）→ fail", () => {
    const unit = validEpic();
    const ls = { ...makeValidEpicLayerSpecific(), scopeBoundary: "" };
    unit.designReviewJudgment.layerSpecific =
      ls as unknown as DesignReviewJudgment["layerSpecific"];
    const r = epicLayerSpecificNonEmpty(unit);
    expect(r.passed).toBe(false);
    expect(r.report).toMatch(/scopeBoundary/);
  });

  it("5 字段缺一（priorityRationale 空）→ fail", () => {
    const unit = validEpic();
    const ls = { ...makeValidEpicLayerSpecific(), priorityRationale: "" };
    unit.designReviewJudgment.layerSpecific =
      ls as unknown as DesignReviewJudgment["layerSpecific"];
    const r = epicLayerSpecificNonEmpty(unit);
    expect(r.passed).toBe(false);
    expect(r.report).toMatch(/priorityRationale/);
  });

  it("5 字段缺一（resourceEstimate 空）→ fail", () => {
    const unit = validEpic();
    const ls = { ...makeValidEpicLayerSpecific(), resourceEstimate: "" };
    unit.designReviewJudgment.layerSpecific =
      ls as unknown as DesignReviewJudgment["layerSpecific"];
    const r = epicLayerSpecificNonEmpty(unit);
    expect(r.passed).toBe(false);
    expect(r.report).toMatch(/resourceEstimate/);
  });

  it("5 字段全空 → fail（report 列出全部 5 字段）", () => {
    const unit = validEpic();
    const ls: Record<string, string> = {
      strategicAlignment: "",
      featureSplitRationale: "",
      scopeBoundary: "",
      priorityRationale: "",
      resourceEstimate: "",
    };
    unit.designReviewJudgment.layerSpecific =
      ls as unknown as DesignReviewJudgment["layerSpecific"];
    const r = epicLayerSpecificNonEmpty(unit);
    expect(r.passed).toBe(false);
    const report = r.report;
    expect(report).toMatch(/strategicAlignment/);
    expect(report).toMatch(/featureSplitRationale/);
    expect(report).toMatch(/scopeBoundary/);
    expect(report).toMatch(/priorityRationale/);
    expect(report).toMatch(/resourceEstimate/);
  });
});

// ═══════════════════════════════════════════════════════════════
// runEpicDesignReviewGates 聚合（8 个 gate）
// ═══════════════════════════════════════════════════════════════

describe("runEpicDesignReviewGates 聚合（11 个 gate，无 FR-AC 强引用）", () => {
  it("合法 epic → 11 个 gate 全 pass", () => {
    const unit = validEpic();
    const results = runEpicDesignReviewGates(unit);
    expect(results).toHaveLength(11);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("无 FR-AC 强引用 gate（不像 feature 的 14 个）—— gate 数量严格为 11", () => {
    const unit = validEpic();
    const results = runEpicDesignReviewGates(unit);
    // epic 只有 11 个 gate，feature 有 14 个（多 FR-AC 3 gate）
    expect(results).toHaveLength(11);
    // 不含 FR-AC 相关 gate
    const reports = results.map((r) => r.report).join(";");
    expect(reports).not.toMatch(/fr-ac-coverage/);
    expect(reports).not.toMatch(/ac-reachable-from-fr/);
    expect(reports).not.toMatch(/ac-non-empty/);
  });

  it("split 空 → featureSplitNonEmpty fail", () => {
    const unit = validEpic();
    unit.plan.split = [];
    const failed = runEpicDesignReviewGates(unit).filter((r) => !r.passed);
    expect(failed.some((r) => /feature-split-non-empty/.test(r.report))).toBe(true);
  });

  it("split 有环 → epicSplitDagValid fail", () => {
    const unit = validEpic();
    unit.plan.split = [
      { slug: "a", description: "a", dependsOn: ["b"], inheritedItemIds: [] },
      { slug: "b", description: "b", dependsOn: ["a"], inheritedItemIds: [] },
    ];
    const failed = runEpicDesignReviewGates(unit).filter((r) => !r.passed);
    expect(failed.some((r) => /split-dag-valid/.test(r.report))).toBe(true);
  });

  it("layerSpecific undefined → layer-specific-non-empty fail", () => {
    const unit = validEpic();
    unit.designReviewJudgment.layerSpecific = undefined;
    const failed = runEpicDesignReviewGates(unit).filter((r) => !r.passed);
    expect(failed.some((r) => /layer-specific-non-empty/.test(r.report))).toBe(true);
  });

  it("judgment 全空（necessity/alternatives/tradeoffs/risks）→ 5 个 judgment gate fail", () => {
    const unit = validEpic();
    unit.designReviewJudgment = {
      necessity: "",
      sufficiency: { gaps: [], overlaps: [], meceNote: "" },
      alternatives: "",
      tradeoffs: [],
      risks: [],
      // layerSpecific 保留合法（只测 judgment gate）
      layerSpecific: makeValidEpicLayerSpecific() as unknown as DesignReviewJudgment["layerSpecific"],
    };
    const failed = runEpicDesignReviewGates(unit).filter((r) => !r.passed);
    // necessity + sufficiency.meceNote + alternatives + tradeoffs + risks = 5 个 judgment gate
    expect(failed.length).toBe(5);
    const reports = failed.map((f) => f.report).join(";");
    expect(reports).toMatch(/necessity/);
    expect(reports).toMatch(/meceNote|sufficiency/);
    expect(reports).toMatch(/alternatives/);
    expect(reports).toMatch(/tradeoffs/);
    expect(reports).toMatch(/risks/);
  });

  it("split 空 + judgment 全空 + layerSpecific undefined → 7 gate fail（空 split 的 epicSplitDagValid 仍 pass：无环）", () => {
    const unit = validEpic();
    unit.plan.split = [];
    unit.designReviewJudgment = {
      necessity: "",
      sufficiency: { gaps: [], overlaps: [], meceNote: "" },
      alternatives: "",
      tradeoffs: [],
      risks: [],
      layerSpecific: undefined,
    };
    const failed = runEpicDesignReviewGates(unit).filter((r) => !r.passed);
    // epicSplitNonEmpty fail + 5 judgment gate fail + epicLayerSpecificNonEmpty fail = 7
    //（epicSplitDagValid 对空 split 仍 pass：无环）
    expect(failed).toHaveLength(7);
  });
});

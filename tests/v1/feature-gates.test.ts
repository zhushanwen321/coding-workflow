/**
 * v1 feature gate 测试。
 *
 * 测 feature design-review 的 13 个 gate（纯函数，零 IO）：
 * - FR-AC 强引用 3：frAcCoverage / acReachableFromFr / acNonEmpty（feature 专属）
 * - split 结构完整性 2：featureSplitNonEmpty / featureSplitDagValid
 * - 决策已解决 + inheritedItemIds 有效 2：allDecisionsResolved / inheritedItemIdsValid
 * - judgment 非空 5（复用 wave/slice 的 necessity/sufficiency/alternatives/tradeoffs/risks）
 * - feature layerSpecific 非空 1（feature 专属 6 字段）
 *
 * 另测 runFeatureDesignReviewGates 聚合：合法 → 13 个全 pass；构造各种 fail 场景验正确 gate fail。
 *
 * 用 makeFeatureUnit + 合法工厂构造基线，手动设坏字段触发 fail（每个 gate 覆盖 pass + fail）。
 */
import { describe, expect, it } from "vitest";

import type {
  DesignReviewJudgment,
} from "../../src/core/judgments.js";
import type { Feature } from "../../src/core/workunit.js";
import {
  acNonEmpty,
  acReachableFromFr,
  designReviewAlternativesNonEmpty,
  designReviewNecessityNonEmpty,
  designReviewRisksPresent,
  designReviewSufficiencyComplete,
  designReviewTradeoffsPresent,
  featureLayerSpecificNonEmpty,
  featureSplitDagValid,
  featureSplitNonEmpty,
  frAcCoverage,
  runFeatureDesignReviewGates,
} from "../../src/rules/gates/design-review.js";
import {
  makeFeatureUnit,
  makeValidFeatureDesignReviewJudgment,
  makeValidFeatureLayerSpecific,
  makeValidFeaturePlan,
} from "./helpers/feature-env.js";
import { makeFeatureSpec } from "./helpers/feature-env.js";

// ── 辅助：构造一个已填好合法 spec + plan + judgment 的 feature（design-review 全 pass 基线）──

/** 构造合法 feature（spec + plan + judgment 都填好，11 个 design-review gate 全过）。 */
function validFeature(): Feature {
  const unit = makeFeatureUnit();
  // 写入合法 spec（FR1→AC1 强引用）
  unit.clarifications.spec = makeFeatureSpec();
  // 写入合法 plan（只 split）
  unit.plan = makeValidFeaturePlan();
  // 写入合法 judgment
  unit.designReviewJudgment = makeValidFeatureDesignReviewJudgment();
  return unit;
}

// ═══════════════════════════════════════════════════════════════
// FR-AC 强引用 gate（3 个，feature 专属）
// ═══════════════════════════════════════════════════════════════

describe("feature design-review gates: FR-AC 强引用（3 个）", () => {
  // frAcCoverage
  describe("frAcCoverage", () => {
    it("每个 active FR.ac 非空且 id 存在 → pass", () => {
      expect(frAcCoverage(validFeature()).passed).toBe(true);
    });

    it("FR.ac 为空数组 → fail", () => {
      const unit = validFeature();
      unit.clarifications.spec.functionalRequirements[0]!.ac = [];
      const r = frAcCoverage(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/fr-ac-coverage/);
    });

    it("FR.ac 引用不存在的 AC id → fail", () => {
      const unit = validFeature();
      unit.clarifications.spec.functionalRequirements[0]!.ac = ["GHOST_AC"];
      const r = frAcCoverage(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/GHOST_AC/);
    });

    it("abandoned FR 不校验（跳过，即使 ac 空）→ pass", () => {
      const unit = validFeature();
      // 加一个 abandoned FR（ac 空），不破坏 frAcCoverage
      unit.clarifications.spec.functionalRequirements.push({
        id: "FR2",
        status: "abandoned",
        title: "废弃的 FR",
        detail: "x",
        ac: [],
      });
      expect(frAcCoverage(unit).passed).toBe(true);
    });

    it("[BUG-HUNT 修复] FR.ac 字段 undefined（畸形数据绕过 clarify 校验时）→ 可读 fail 而非崩溃", () => {
      // 原崩溃 bug：replan 等路径绕过 clarify 校验，fr.ac 为 undefined，
      // fr.ac.length 访问抛 Cannot read properties of undefined。
      // guard 后应返回可读 fail，不抛异常。
      const unit = validFeature();
      // 强行删除 ac 字段（模拟畸形入库数据）
      const fr = unit.clarifications.spec.functionalRequirements[0]!;
      delete (fr as { ac?: string[] }).ac;
      expect(() => frAcCoverage(unit)).not.toThrow();
      const r = frAcCoverage(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/ac 字段缺失/);
    });
  });

  // acReachableFromFr
  describe("acReachableFromFr", () => {
    it("每个 active AC 被 active FR 引用 → pass", () => {
      expect(acReachableFromFr(validFeature()).passed).toBe(true);
    });

    it("孤儿 AC（无 FR 引用）→ fail", () => {
      const unit = validFeature();
      // 加一个 active AC，不被任何 FR 引用
      unit.clarifications.spec.acceptanceCriteria.push({
        id: "AC_ORPHAN",
        status: "active",
        condition: "孤儿 AC",
      });
      const r = acReachableFromFr(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/AC_ORPHAN/);
    });

    it("abandoned AC 不校验（即使无 FR 引用）→ pass", () => {
      const unit = validFeature();
      unit.clarifications.spec.acceptanceCriteria.push({
        id: "AC_ABANDONED",
        status: "abandoned",
        condition: "废弃 AC",
      });
      expect(acReachableFromFr(unit).passed).toBe(true);
    });
  });

  // acNonEmpty
  describe("acNonEmpty", () => {
    it("active AC 至少 1 条 → pass", () => {
      expect(acNonEmpty(validFeature()).passed).toBe(true);
    });

    it("active AC 为空 → fail", () => {
      const unit = validFeature();
      unit.clarifications.spec.acceptanceCriteria = [];
      const r = acNonEmpty(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/ac-non-empty/);
    });

    it("只有 abandoned AC（无 active）→ fail", () => {
      const unit = validFeature();
      unit.clarifications.spec.acceptanceCriteria = [
        { id: "AC1", status: "abandoned", condition: "全废弃" },
      ];
      expect(acNonEmpty(unit).passed).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// split 结构完整性（2 个）
// ═══════════════════════════════════════════════════════════════

describe("feature design-review gates: split 结构完整性", () => {
  // featureSplitNonEmpty
  describe("featureSplitNonEmpty", () => {
    it("split 至少 1 项 → pass", () => {
      expect(featureSplitNonEmpty(validFeature()).passed).toBe(true);
    });

    it("split 为空 → fail", () => {
      const unit = validFeature();
      unit.plan.split = [];
      const r = featureSplitNonEmpty(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/slice-split-non-empty/);
    });
  });

  // featureSplitDagValid
  describe("featureSplitDagValid", () => {
    it("无依赖（dependsOn 全空）→ pass", () => {
      expect(featureSplitDagValid(validFeature()).passed).toBe(true);
    });

    it("线性依赖（A→B→C）→ pass", () => {
      const unit = validFeature();
      unit.plan.split = [
        { slug: "a", description: "a", dependsOn: [], inheritedItemIds: [] },
        { slug: "b", description: "b", dependsOn: ["a"], inheritedItemIds: [] },
        { slug: "c", description: "c", dependsOn: ["b"], inheritedItemIds: [] },
      ];
      expect(featureSplitDagValid(unit).passed).toBe(true);
    });

    it("环（A dependsOn B, B dependsOn A）→ fail", () => {
      const unit = validFeature();
      unit.plan.split = [
        { slug: "a", description: "a", dependsOn: ["b"], inheritedItemIds: [] },
        { slug: "b", description: "b", dependsOn: ["a"], inheritedItemIds: [] },
      ];
      const r = featureSplitDagValid(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/split-dag-valid/);
    });

    it("自环（A dependsOn A）→ fail", () => {
      const unit = validFeature();
      unit.plan.split = [
        { slug: "a", description: "a", dependsOn: ["a"], inheritedItemIds: [] },
      ];
      expect(featureSplitDagValid(unit).passed).toBe(false);
    });

    it("dependsOn 引用不存在的 slug（忽略，不构成环）→ pass", () => {
      const unit = validFeature();
      unit.plan.split = [
        { slug: "a", description: "a", dependsOn: ["ghost"], inheritedItemIds: [] },
      ];
      expect(featureSplitDagValid(unit).passed).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// judgment 非空（5 个，复用 wave/slice）
// ═══════════════════════════════════════════════════════════════

describe("feature design-review gates: judgment 非空（5 个，复用 wave/slice）", () => {
  function fullJudgment(): DesignReviewJudgment {
    return makeValidFeatureDesignReviewJudgment();
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

  it("[BUG-HUNT 修复] tradeoffs undefined → 可读 fail 而非崩溃", () => {
    const j = fullJudgment() as unknown as { tradeoffs?: unknown };
    delete j.tradeoffs;
    expect(() => designReviewTradeoffsPresent(j as DesignReviewJudgment)).not.toThrow();
    expect(designReviewTradeoffsPresent(j as DesignReviewJudgment).passed).toBe(false);
  });

  it("[BUG-HUNT 修复] risks undefined → 可读 fail 而非崩溃", () => {
    const j = fullJudgment() as unknown as { risks?: unknown };
    delete j.risks;
    expect(() => designReviewRisksPresent(j as DesignReviewJudgment)).not.toThrow();
    expect(designReviewRisksPresent(j as DesignReviewJudgment).passed).toBe(false);
  });

  it("[BUG-HUNT 修复] sufficiency.gaps undefined → 可读 fail 而非崩溃", () => {
    const j = fullJudgment() as unknown as { sufficiency?: { gaps?: unknown } };
    delete j.sufficiency!.gaps;
    expect(() => designReviewSufficiencyComplete(j as DesignReviewJudgment)).not.toThrow();
    expect(designReviewSufficiencyComplete(j as DesignReviewJudgment).passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// feature layerSpecific 非空（6 字段，feature 专属）
// ═══════════════════════════════════════════════════════════════

describe("feature design-review gates: feature layerSpecific 非空（6 字段）", () => {
  it("layerSpecific undefined → fail", () => {
    const unit = validFeature();
    unit.designReviewJudgment.layerSpecific = undefined;
    const r = featureLayerSpecificNonEmpty(unit);
    expect(r.passed).toBe(false);
    expect(r.report).toMatch(/layer-specific-non-empty/);
  });

  it("6 字段全填 → pass", () => {
    expect(featureLayerSpecificNonEmpty(validFeature()).passed).toBe(true);
  });

  it("6 字段缺一（specMeceNote 空）→ fail", () => {
    const unit = validFeature();
    const ls = { ...makeValidFeatureLayerSpecific(), specMeceNote: "" };
    unit.designReviewJudgment.layerSpecific =
      ls as unknown as DesignReviewJudgment["layerSpecific"];
    const r = featureLayerSpecificNonEmpty(unit);
    expect(r.passed).toBe(false);
    expect(r.report).toMatch(/specMeceNote/);
  });

  it("6 字段缺一（sliceSplitRationale 纯空白）→ fail", () => {
    const unit = validFeature();
    const ls = { ...makeValidFeatureLayerSpecific(), sliceSplitRationale: "   " };
    unit.designReviewJudgment.layerSpecific =
      ls as unknown as DesignReviewJudgment["layerSpecific"];
    expect(featureLayerSpecificNonEmpty(unit).passed).toBe(false);
  });

  it("6 字段缺一（frAcCoverageNote 空）→ fail", () => {
    const unit = validFeature();
    const ls = { ...makeValidFeatureLayerSpecific(), frAcCoverageNote: "" };
    unit.designReviewJudgment.layerSpecific =
      ls as unknown as DesignReviewJudgment["layerSpecific"];
    const r = featureLayerSpecificNonEmpty(unit);
    expect(r.passed).toBe(false);
    expect(r.report).toMatch(/frAcCoverageNote/);
  });

  it("6 字段缺一（sliceSpecCoverageNote 空）→ fail", () => {
    const unit = validFeature();
    const ls = { ...makeValidFeatureLayerSpecific(), sliceSpecCoverageNote: "" };
    unit.designReviewJudgment.layerSpecific =
      ls as unknown as DesignReviewJudgment["layerSpecific"];
    expect(featureLayerSpecificNonEmpty(unit).passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// runFeatureDesignReviewGates 聚合（13 个 gate）
// ═══════════════════════════════════════════════════════════════

describe("runFeatureDesignReviewGates 聚合（13 个 gate）", () => {
  it("合法 feature → 13 个 gate 全 pass", () => {
    const unit = validFeature();
    const results = runFeatureDesignReviewGates(unit);
    expect(results).toHaveLength(13);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("FR.ac 引用不存在 + split 空 → 至少 2 个 fail", () => {
    const unit = validFeature();
    unit.clarifications.spec.functionalRequirements[0]!.ac = ["GHOST"];
    unit.plan.split = [];
    const failed = runFeatureDesignReviewGates(unit).filter((r) => !r.passed);
    expect(failed.length).toBeGreaterThanOrEqual(2);
  });

  it("spec 空（FR/AC 全空）→ acNonEmpty fail", () => {
    const unit = validFeature();
    unit.clarifications.spec.functionalRequirements = [];
    unit.clarifications.spec.acceptanceCriteria = [];
    const failed = runFeatureDesignReviewGates(unit).filter((r) => !r.passed);
    const reports = failed.map((f) => f.report).join(";");
    expect(reports).toMatch(/ac-non-empty/);
  });

  it("孤儿 AC → acReachableFromFr fail", () => {
    const unit = validFeature();
    unit.clarifications.spec.acceptanceCriteria.push({
      id: "AC_ORPHAN",
      status: "active",
      condition: "孤儿",
    });
    const failed = runFeatureDesignReviewGates(unit).filter((r) => !r.passed);
    expect(failed.some((r) => /ac-reachable-from-fr/.test(r.report))).toBe(true);
  });

  it("split 有环 → featureSplitDagValid fail", () => {
    const unit = validFeature();
    unit.plan.split = [
      { slug: "a", description: "a", dependsOn: ["b"], inheritedItemIds: [] },
      { slug: "b", description: "b", dependsOn: ["a"], inheritedItemIds: [] },
    ];
    const failed = runFeatureDesignReviewGates(unit).filter((r) => !r.passed);
    expect(failed.some((r) => /split-dag-valid/.test(r.report))).toBe(true);
  });

  it("layerSpecific undefined → layer-specific-non-empty fail", () => {
    const unit = validFeature();
    unit.designReviewJudgment.layerSpecific = undefined;
    const failed = runFeatureDesignReviewGates(unit).filter((r) => !r.passed);
    expect(failed.some((r) => /layer-specific-non-empty/.test(r.report))).toBe(true);
  });

  it("judgment 全空（necessity/alternatives/tradeoffs/risks）→ 4 个 judgment gate fail", () => {
    const unit = validFeature();
    unit.designReviewJudgment = {
      necessity: "",
      sufficiency: { gaps: [], overlaps: [], meceNote: "" },
      alternatives: "",
      tradeoffs: [],
      risks: [],
      // layerSpecific 保留合法（只测 judgment gate）
      layerSpecific: makeValidFeatureLayerSpecific() as unknown as DesignReviewJudgment["layerSpecific"],
    };
    const failed = runFeatureDesignReviewGates(unit).filter((r) => !r.passed);
    // necessity + sufficiency.meceNote + alternatives + tradeoffs + risks = 5 个 judgment gate
    expect(failed.length).toBe(5);
    const reports = failed.map((f) => f.report).join(";");
    expect(reports).toMatch(/necessity/);
    expect(reports).toMatch(/meceNote|sufficiency/);
    expect(reports).toMatch(/alternatives/);
    expect(reports).toMatch(/tradeoffs/);
    expect(reports).toMatch(/risks/);
  });
});

/**
 * v1 slice gate 测试。
 *
 * 测两类 slice gate（纯函数，零 IO）：
 * - design-review 11 gates（runSliceDesignReviewGates + 11 个单 gate）
 *   - 结构完整性 3：techChoiceNonEmpty / splitNonEmpty / splitDagValid（DAG 无环）
 *   - 决策已解决 + inheritedItemIds 有效 2：allDecisionsResolved / inheritedItemIdsValid
 *   - judgment 非空 5（复用 wave 的 necessity/sufficiency/alternatives/tradeoffs/risks）
 *   - layerSpecific 非空 1（slice 专属 6 字段）
 * - retrospect 4 gates（runSliceRetrospectGates + 4 个单 gate）
 *   - allWavesClosed / sliceLessonsLearnedNonEmpty / reviewedItemsCoverDesignReview / splitFulfillmentCoversPlan
 *
 * 用 makeSliceUnit 构造合法 Slice，手动设坏字段触发 fail（每个 gate 覆盖 pass + fail）。
 */
import { describe, expect, it } from "vitest";

import type { DesignReviewJudgment, PlanningRetrospectData } from "../../src/v1/core/judgments.js";
import type { Slice } from "../../src/v1/core/workunit.js";
import {
  designReviewAlternativesNonEmpty,
  designReviewNecessityNonEmpty,
  designReviewRisksPresent,
  designReviewSufficiencyComplete,
  designReviewTradeoffsPresent,
  layerSpecificNonEmpty,
  runSliceDesignReviewGates,
  splitDagValid,
  splitNonEmpty,
  techChoiceNonEmpty,
} from "../../src/v1/rules/gates/design-review.js";
import {
  allWavesClosed,
  reviewedItemsCoverDesignReview,
  runSliceRetrospectGates,
  sliceLessonsLearnedNonEmpty,
  splitFulfillmentCoversPlan,
} from "../../src/v1/rules/gates/retrospect.js";
import {
  makeSliceUnit,
  makeValidSliceDesignReviewJudgment,
  makeValidSlicePlan,
} from "./helpers/slice-env.js";

// ── 辅助：构造一个已填好合法 plan + judgment 的 slice（design-review 全 pass 基线）──

/** 构造合法 slice（plan + judgment 都填好，9 个 design-review gate 全过）。 */
function validSlice(): Slice {
  const unit = makeSliceUnit();
  const plan = makeValidSlicePlan();
  unit.plan = {
    split: plan.split,
    techChoices: plan.techChoices,
    interfaces: plan.interfaces,
    dataModels: plan.dataModels,
    errorSpecs: plan.errorSpecs,
    decisions: [],
  };
  unit.designReviewJudgment = makeValidSliceDesignReviewJudgment();
  return unit;
}

// ═══════════════════════════════════════════════════════════════
// slice design-review gates（9 个）
// ═══════════════════════════════════════════════════════════════

describe("slice design-review gates: 结构完整性", () => {
  // U-techChoiceNonEmpty
  describe("techChoiceNonEmpty", () => {
    it("techChoices 为空 → fail", () => {
      const unit = validSlice();
      unit.plan.techChoices = [];
      const r = techChoiceNonEmpty(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/tech-choice-non-empty/);
    });
    it("techChoices 非空 → pass", () => {
      const unit = validSlice();
      expect(techChoiceNonEmpty(unit).passed).toBe(true);
    });
  });

  // U-splitNonEmpty
  describe("splitNonEmpty", () => {
    it("split 为空 → fail", () => {
      const unit = validSlice();
      unit.plan.split = [];
      const r = splitNonEmpty(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/split-non-empty/);
    });
    it("split 非空 → pass", () => {
      const unit = validSlice();
      expect(splitNonEmpty(unit).passed).toBe(true);
    });
  });

  // U-splitDagValid（依赖关系无环）
  describe("splitDagValid", () => {
    it("无依赖（dependsOn 全空）→ pass", () => {
      const unit = validSlice();
      expect(splitDagValid(unit).passed).toBe(true);
    });

    it("线性依赖（A→B→C）→ pass", () => {
      const unit = validSlice();
      unit.plan.split = [
        { slug: "a", description: "a", dependsOn: [], inheritedItemIds: [] },
        { slug: "b", description: "b", dependsOn: ["a"], inheritedItemIds: [] },
        { slug: "c", description: "c", dependsOn: ["b"], inheritedItemIds: [] },
      ];
      expect(splitDagValid(unit).passed).toBe(true);
    });

    it("环（A dependsOn B, B dependsOn A）→ fail", () => {
      const unit = validSlice();
      unit.plan.split = [
        { slug: "a", description: "a", dependsOn: ["b"], inheritedItemIds: [] },
        { slug: "b", description: "b", dependsOn: ["a"], inheritedItemIds: [] },
      ];
      const r = splitDagValid(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/split-dag-valid/);
    });

    it("自环（A dependsOn A）→ fail", () => {
      const unit = validSlice();
      unit.plan.split = [
        { slug: "a", description: "a", dependsOn: ["a"], inheritedItemIds: [] },
      ];
      expect(splitDagValid(unit).passed).toBe(false);
    });

    it("dependsOn 引用不存在的 slug（忽略，不构成环）→ pass", () => {
      const unit = validSlice();
      unit.plan.split = [
        { slug: "a", description: "a", dependsOn: ["ghost"], inheritedItemIds: [] },
      ];
      expect(splitDagValid(unit).passed).toBe(true);
    });
  });
});

describe("slice design-review gates: judgment 非空（5 个，复用 wave）", () => {
  function fullJudgment(): DesignReviewJudgment {
    return makeValidSliceDesignReviewJudgment();
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

describe("slice design-review gates: layerSpecific 非空（6 字段）", () => {
  it("layerSpecific undefined → fail", () => {
    const unit = validSlice();
    unit.designReviewJudgment.layerSpecific = undefined;
    const r = layerSpecificNonEmpty(unit);
    expect(r.passed).toBe(false);
    expect(r.report).toMatch(/layer-specific-non-empty/);
  });

  it("6 字段缺一（techChoiceRationale 空）→ fail", () => {
    const unit = validSlice();
    const ls = {
      ...((makeValidSliceDesignReviewJudgment().layerSpecific ?? {}) as Record<string, string>),
      techChoiceRationale: "",
    };
    unit.designReviewJudgment.layerSpecific = ls as DesignReviewJudgment["layerSpecific"];
    const r = layerSpecificNonEmpty(unit);
    expect(r.passed).toBe(false);
    expect(r.report).toMatch(/techChoiceRationale/);
  });

  it("6 字段缺一（interfaceContractNote 空）→ fail", () => {
    const unit = validSlice();
    const ls = {
      ...((makeValidSliceDesignReviewJudgment().layerSpecific ?? {}) as Record<string, string>),
      interfaceContractNote: "  ",
    };
    unit.designReviewJudgment.layerSpecific = ls as DesignReviewJudgment["layerSpecific"];
    expect(layerSpecificNonEmpty(unit).passed).toBe(false);
  });

  it("6 字段缺一（crossWaveContractNote 空）→ fail", () => {
    const unit = validSlice();
    const ls = {
      ...((makeValidSliceDesignReviewJudgment().layerSpecific ?? {}) as Record<string, string>),
      crossWaveContractNote: "",
    };
    unit.designReviewJudgment.layerSpecific = ls as DesignReviewJudgment["layerSpecific"];
    expect(layerSpecificNonEmpty(unit).passed).toBe(false);
  });

  it("6 字段全填（makeValidSliceDesignReviewJudgment）→ pass", () => {
    expect(layerSpecificNonEmpty(validSlice()).passed).toBe(true);
  });
});

describe("runSliceDesignReviewGates 聚合（11 个 gate）", () => {
  it("合法 slice → 11 个 gate 全 pass", () => {
    const unit = validSlice();
    const results = runSliceDesignReviewGates(unit);
    expect(results).toHaveLength(11);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("techChoices 空 + split 空 → 至少 2 个 fail", () => {
    const unit = validSlice();
    unit.plan.techChoices = [];
    unit.plan.split = [];
    const failed = runSliceDesignReviewGates(unit).filter((r) => !r.passed);
    expect(failed.length).toBeGreaterThanOrEqual(2);
  });

  it("layerSpecific undefined → 聚合结果含 layer-specific-non-empty fail", () => {
    const unit = validSlice();
    unit.designReviewJudgment.layerSpecific = undefined;
    const failed = runSliceDesignReviewGates(unit).filter((r) => !r.passed);
    expect(failed.some((r) => /layer-specific-non-empty/.test(r.report))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// slice retrospect gates（4 个）
// ═══════════════════════════════════════════════════════════════

describe("slice retrospect gates", () => {
  // allWavesClosed
  describe("allWavesClosed", () => {
    it("childStatuses 全 closed → pass", () => {
      expect(allWavesClosed(["closed"]).passed).toBe(true);
      expect(allWavesClosed(["closed", "closed"]).passed).toBe(true);
    });

    it("childStatuses 含 created（未终态）→ fail", () => {
      const r = allWavesClosed(["created"]);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/all-waves-closed/);
    });

    it("childStatuses 含 aborted 也算终态 → pass", () => {
      expect(allWavesClosed(["closed", "aborted"]).passed).toBe(true);
    });

    it("childStatuses 为空 → fail（slice 必须拆 wave）", () => {
      const r = allWavesClosed([]);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/没有 child wave/);
    });

    it("childStatuses 含 executing（中间态）→ fail", () => {
      expect(allWavesClosed(["closed", "executing"]).passed).toBe(false);
    });
  });

  // sliceLessonsLearnedNonEmpty
  describe("sliceLessonsLearnedNonEmpty", () => {
    function rd(lessons: string): PlanningRetrospectData {
      return {
        reviewedItems: [],
        lessonsLearned: lessons,
        deliveryVerdict: "delivered",
        childUnitIdsEvidence: [],
        splitFulfillment: [],
      };
    }
    it("lessonsLearned 非空 → pass", () => {
      expect(sliceLessonsLearnedNonEmpty(rd("learned")).passed).toBe(true);
    });
    it("lessonsLearned 空 → fail", () => {
      const r = sliceLessonsLearnedNonEmpty(rd(""));
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/lessons-learned-non-empty/);
    });
    it("lessonsLearned 纯空白 → fail", () => {
      expect(sliceLessonsLearnedNonEmpty(rd("   ")).passed).toBe(false);
    });
  });

  // reviewedItemsCoverDesignReview
  describe("reviewedItemsCoverDesignReview", () => {
    function validRd(): PlanningRetrospectData {
      return {
        reviewedItems: [
          { itemId: "necessity", outcome: "fulfilled" },
          { itemId: "sufficiency", outcome: "fulfilled" },
          { itemId: "alternatives", outcome: "fulfilled" },
          { itemId: "TF1", outcome: "fulfilled" },
          { itemId: "RK1", outcome: "fulfilled" },
        ],
        lessonsLearned: "ok",
        deliveryVerdict: "delivered",
        childUnitIdsEvidence: [],
        splitFulfillment: [],
      };
    }
    const dr = makeValidSliceDesignReviewJudgment(); // tradeoffs=[TF1], risks=[RK1]

    it("reviewedItems 覆盖全部核心项 → pass", () => {
      expect(reviewedItemsCoverDesignReview(validRd(), dr).passed).toBe(true);
    });

    it("reviewedItems 缺 TF1 → fail（report 提及 TF1）", () => {
      const rd = validRd();
      rd.reviewedItems = rd.reviewedItems.filter((r) => r.itemId !== "TF1");
      const r = reviewedItemsCoverDesignReview(rd, dr);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/TF1/);
    });
  });

  // splitFulfillmentCoversPlan
  describe("splitFulfillmentCoversPlan", () => {
    function rdWithSplit(splitSlugs: string[]): PlanningRetrospectData {
      return {
        reviewedItems: [],
        lessonsLearned: "ok",
        deliveryVerdict: "delivered",
        childUnitIdsEvidence: [],
        splitFulfillment: splitSlugs.map((slug) => ({ splitSlug: slug, verdict: "delivered" as const })),
      };
    }

    it("splitFulfillment 覆盖 split 全部 slug → pass", () => {
      const unit = validSlice(); // plan.split 含 w1
      expect(splitFulfillmentCoversPlan(rdWithSplit(["w1"]), unit.plan.split).passed).toBe(true);
    });

    it("splitFulfillment 缺 w1 → fail（plan.split 含 w1）", () => {
      const unit = validSlice();
      const r = splitFulfillmentCoversPlan(rdWithSplit([]), unit.plan.split);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/w1/);
    });

    it("多 split 部分覆盖 → fail（缺其一）", () => {
      const unit = validSlice();
      unit.plan.split = [
        { slug: "w1", description: "w1", dependsOn: [], inheritedItemIds: [] },
        { slug: "w2", description: "w2", dependsOn: ["w1"], inheritedItemIds: [] },
      ];
      const r = splitFulfillmentCoversPlan(rdWithSplit(["w1"]), unit.plan.split);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/w2/);
    });
  });
});

describe("runSliceRetrospectGates 聚合（6 个 gate）", () => {
  it("合法 retrospectData + child 全 closed → 6 个 gate 全 pass", () => {
    const unit = validSlice();
    unit.retrospectData = {
      reviewedItems: [
        { itemId: "necessity", outcome: "fulfilled" },
        { itemId: "sufficiency", outcome: "fulfilled" },
        { itemId: "alternatives", outcome: "fulfilled" },
        { itemId: "TF1", outcome: "fulfilled" },
        { itemId: "RK1", outcome: "fulfilled" },
      ],
      lessonsLearned: "slice tech plan gave wave clear contract",
      deliveryVerdict: "delivered",
      childUnitIdsEvidence: [],
      splitFulfillment: [{ splitSlug: "w1", verdict: "delivered" }],
    };
    const results = runSliceRetrospectGates(unit, ["closed"]);
    expect(results).toHaveLength(7);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("child 未全 closed + lessonsLearned 空 + 缺 splitFulfillment → 多 gate fail", () => {
    const unit = validSlice();
    unit.retrospectData = {
      reviewedItems: [],
      lessonsLearned: "",
      deliveryVerdict: "failed",
      childUnitIdsEvidence: [],
      splitFulfillment: [],
    };
    const failed = runSliceRetrospectGates(unit, ["created"]).filter((r) => !r.passed);
    // allWavesClosed fail + lessonsLearned fail + reviewedItemsCover fail + splitFulfillment fail = 4
    // （childUnitEvidenceComplete: childUnitIds 为空无需覆盖 → pass；deliveryVerdictNonEmpty: "failed" 非空 → pass）
    expect(failed.length).toBe(4);
  });
});

/**
 * v1 wave freeze（append-only 不变量）测试（U13-U14）。
 *
 * checkFreeze(before, after) 对 status="abandoned" 的条目校验：
 * - 被删 → wave_deleted_abandoned
 * - 核心字段被改 → wave_modified_abandoned
 * - active 条目改 → 无 violation
 *
 * 对应 test.json U13-U14。
 */
import { describe, expect,it } from "vitest";

import type { AcceptanceCriterion, BusinessCase, FunctionalRequirement } from "../src/core/clarifications.js";
import type {
  WaveContract,
  WaveFile,
  WaveTask,
  WaveTestCase,
} from "../src/core/plan.js";
import type { ExecutionUnit, Feature } from "../src/core/workunit.js";
import { createFeature, createWave } from "../src/core/workunit.js";
import { checkFreeze, checkFreezeFeatureSpec } from "../src/rules/freeze.js";

// ── 辅助构造带 abandoned 条目的 wave ─────────────────────────

function waveWithAbandoned(): ExecutionUnit {
  const u = createWave({
    slug: "freeze-test",
    objective: "o",
    parentUnitId: "slice:s",
    basedOnParent: [],
  });
  const abandonedTc: WaveTestCase = {
    id: "TC1", status: "abandoned", name: "n", scenario: "s", input: "i", expected: "old-expected", type: "unit",
  };
  const abandonedTask: WaveTask = {
    id: "TK1", status: "abandoned", type: "impl", files: [], steps: ["old-step"],
  };
  const abandonedFile: WaveFile = {
    id: "F1", status: "abandoned", path: "old/path.ts", action: "create", description: "d",
  };
  const abandonedContract: WaveContract = {
    id: "C1", status: "abandoned", name: "n", type: "function", definition: "old-def",
  };
  const activeTc: WaveTestCase = {
    id: "TC2", status: "active", name: "n", scenario: "s", input: "i", expected: "active-expected", type: "unit",
  };
  u.plan.testCases = [abandonedTc, activeTc];
  u.plan.tasks = [abandonedTask];
  u.plan.files = [abandonedFile];
  u.plan.contracts = [abandonedContract];
  return u;
}

describe("U13-U14: freeze append-only 校验", () => {
  // U13: abandoned 条目核心字段被改 → violation
  describe("U13: abandoned 条目核心字段被改 → FreezeViolation", () => {
    it("testCase.expected 被改 → wave_modified_abandoned", () => {
      const before = waveWithAbandoned();
      const after = structuredClone(before);
      const abandonedTc = after.plan.testCases.find((t) => t.id === "TC1")!;
      abandonedTc.expected = "tampered-expected";
      const violations = checkFreeze(before, after);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.type).toBe("wave_modified_abandoned");
      expect(violations[0]!.itemId).toBe("TC1");
      expect(violations[0]!.field).toBe("expected");
    });

    it("task.steps 被改 → violation", () => {
      const before = waveWithAbandoned();
      const after = structuredClone(before);
      after.plan.tasks.find((t) => t.id === "TK1")!.steps = ["new-step"];
      expect(checkFreeze(before, after)).toHaveLength(1);
    });

    it("file.path 被改 → violation", () => {
      const before = waveWithAbandoned();
      const after = structuredClone(before);
      after.plan.files.find((t) => t.id === "F1")!.path = "new/path.ts";
      const v = checkFreeze(before, after);
      expect(v).toHaveLength(1);
      expect(v[0]!.field).toBe("path");
    });

    it("contract.definition 被改 → violation", () => {
      const before = waveWithAbandoned();
      const after = structuredClone(before);
      after.plan.contracts.find((t) => t.id === "C1")!.definition = "new-def";
      const v = checkFreeze(before, after);
      expect(v).toHaveLength(1);
      expect(v[0]!.field).toBe("definition");
    });
  });

  // abandoned 条目被删 → violation
  describe("abandoned 条目被删 → FreezeViolation", () => {
    it("删除 abandoned testCase → wave_deleted_abandoned", () => {
      const before = waveWithAbandoned();
      const after = structuredClone(before);
      after.plan.testCases = after.plan.testCases.filter((t) => t.id !== "TC1");
      const violations = checkFreeze(before, after);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.type).toBe("wave_deleted_abandoned");
      expect(violations[0]!.itemId).toBe("TC1");
    });
  });

  // U14: active 条目被改 → 无 violation
  describe("U14: active 条目被改 → 无 violation", () => {
    it("active testCase.expected 被改 → 空 violations", () => {
      const before = waveWithAbandoned();
      const after = structuredClone(before);
      after.plan.testCases.find((t) => t.id === "TC2")!.expected = "changed-active";
      expect(checkFreeze(before, after)).toEqual([]);
    });

    it("abandoned 条目核心字段不变（仅次要字段如 name 改）→ 空 violations", () => {
      const before = waveWithAbandoned();
      const after = structuredClone(before);
      // name 不是核心字段，改了不算 violation
      after.plan.testCases.find((t) => t.id === "TC1")!.name = "changed-name";
      expect(checkFreeze(before, after)).toEqual([]);
    });

    it("before/after 完全一致 → 空 violations", () => {
      const before = waveWithAbandoned();
      const after = structuredClone(before);
      expect(checkFreeze(before, after)).toEqual([]);
    });
  });
});

// ───────────────────────────────────────────────────────────────
// checkFreezeFeatureSpec（FeatureSpec FR/AC/UC append-only 校验）
// ───────────────────────────────────────────────────────────────

/**
 * 构造带 abandoned + active 条目的 FeatureSpec feature（三类各 1 abandoned + FR 额外 1 active）。
 */
function featureWithAbandonedSpec(): Feature {
  const u = createFeature({
    slug: "freeze-feature-test",
    objective: "o",
    parentUnitId: "epic:e",
    basedOnParent: [],
  });
  const abandonedFr: FunctionalRequirement = {
    id: "FR1", status: "abandoned", title: "old-title", detail: "old-detail", ac: ["AC1"],
  };
  const abandonedAc: AcceptanceCriterion = {
    id: "AC1", status: "abandoned", condition: "old-condition", verification: "unit",
  };
  const abandonedUc: BusinessCase = {
    id: "UC1", status: "abandoned", actor: "old-actor", scenario: "old-scenario", expectedResult: "old-result",
  };
  const activeFr: FunctionalRequirement = {
    id: "FR2", status: "active", title: "active-title", detail: "d", ac: [],
  };
  u.clarifications.spec.functionalRequirements = [abandonedFr, activeFr];
  u.clarifications.spec.acceptanceCriteria = [abandonedAc];
  u.clarifications.spec.businessCases = [abandonedUc];
  return u;
}

describe("checkFreezeFeatureSpec: FeatureSpec append-only 校验", () => {
  describe("abandoned 条目核心字段被改 → feature_modified_abandoned", () => {
    it("FR.title 被改 → violation", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      after.clarifications.spec.functionalRequirements.find((f) => f.id === "FR1")!.title = "tampered";
      const v = checkFreezeFeatureSpec(before, after);
      expect(v).toHaveLength(1);
      expect(v[0]!.type).toBe("feature_modified_abandoned");
      expect(v[0]!.itemId).toBe("FR1");
      expect(v[0]!.field).toBe("title");
    });

    it("FR.detail 被改 → violation", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      after.clarifications.spec.functionalRequirements.find((f) => f.id === "FR1")!.detail = "tampered";
      expect(checkFreezeFeatureSpec(before, after)).toHaveLength(1);
    });

    it("FR.ac 数组被改 → violation", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      after.clarifications.spec.functionalRequirements.find((f) => f.id === "FR1")!.ac = ["AC9"];
      const v = checkFreezeFeatureSpec(before, after);
      expect(v).toHaveLength(1);
      expect(v[0]!.field).toBe("ac");
    });

    it("AC.condition 被改 → violation", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      after.clarifications.spec.acceptanceCriteria.find((a) => a.id === "AC1")!.condition = "new";
      const v = checkFreezeFeatureSpec(before, after);
      expect(v).toHaveLength(1);
      expect(v[0]!.field).toBe("condition");
    });

    it("AC.verification 被改 → violation", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      after.clarifications.spec.acceptanceCriteria.find((a) => a.id === "AC1")!.verification = "manual";
      const v = checkFreezeFeatureSpec(before, after);
      expect(v).toHaveLength(1);
      expect(v[0]!.field).toBe("verification");
    });

    it("UC.actor 被改 → violation", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      after.clarifications.spec.businessCases.find((b) => b.id === "UC1")!.actor = "new-actor";
      expect(checkFreezeFeatureSpec(before, after)).toHaveLength(1);
    });

    it("UC.scenario 被改 → violation", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      after.clarifications.spec.businessCases.find((b) => b.id === "UC1")!.scenario = "new-scenario";
      expect(checkFreezeFeatureSpec(before, after)).toHaveLength(1);
    });

    it("UC.expectedResult 被改 → violation", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      after.clarifications.spec.businessCases.find((b) => b.id === "UC1")!.expectedResult = "new-result";
      expect(checkFreezeFeatureSpec(before, after)).toHaveLength(1);
    });
  });

  describe("abandoned 条目被删 → feature_deleted_abandoned", () => {
    it("删除 abandoned FR → violation", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      after.clarifications.spec.functionalRequirements = after.clarifications.spec.functionalRequirements.filter((f) => f.id !== "FR1");
      const v = checkFreezeFeatureSpec(before, after);
      expect(v).toHaveLength(1);
      expect(v[0]!.type).toBe("feature_deleted_abandoned");
      expect(v[0]!.itemId).toBe("FR1");
    });

    it("删除 abandoned AC → violation", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      after.clarifications.spec.acceptanceCriteria = [];
      const v = checkFreezeFeatureSpec(before, after);
      expect(v).toHaveLength(1);
      expect(v[0]!.itemId).toBe("AC1");
    });

    it("删除 abandoned UC → violation", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      after.clarifications.spec.businessCases = [];
      const v = checkFreezeFeatureSpec(before, after);
      expect(v).toHaveLength(1);
      expect(v[0]!.itemId).toBe("UC1");
    });
  });

  describe("abandoned 条目 status 被翻转 → feature_revived_abandoned", () => {
    it("FR abandoned→active → feature_revived_abandoned", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      after.clarifications.spec.functionalRequirements.find((f) => f.id === "FR1")!.status = "active";
      const v = checkFreezeFeatureSpec(before, after);
      expect(v).toHaveLength(1);
      expect(v[0]!.type).toBe("feature_revived_abandoned");
      expect(v[0]!.field).toBe("status");
      expect(v[0]!.itemId).toBe("FR1");
    });

    it("UC abandoned→active → feature_revived_abandoned", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      after.clarifications.spec.businessCases.find((b) => b.id === "UC1")!.status = "active";
      const v = checkFreezeFeatureSpec(before, after);
      expect(v).toHaveLength(1);
      expect(v[0]!.type).toBe("feature_revived_abandoned");
    });
  });

  describe("active 条目被改 → 无 violation", () => {
    it("active FR 核心字段被改 → 空 violations", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      after.clarifications.spec.functionalRequirements.find((f) => f.id === "FR2")!.title = "changed-active";
      expect(checkFreezeFeatureSpec(before, after)).toEqual([]);
    });

    it("before/after 完全一致 → 空 violations", () => {
      const before = featureWithAbandonedSpec();
      const after = structuredClone(before);
      expect(checkFreezeFeatureSpec(before, after)).toEqual([]);
    });
  });
});

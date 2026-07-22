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

import type {
  WaveContract,
  WaveFile,
  WaveTask,
  WaveTestCase,
} from "../../src/v1/core/plan.js";
import type { ExecutionUnit } from "../../src/v1/core/workunit.js";
import { createWave } from "../../src/v1/core/workunit.js";
import { checkFreeze } from "../../src/v1/rules/freeze.js";

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

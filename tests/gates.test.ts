/**
 * v1 wave gate 测试（U8-U12 + 其他）。
 *
 * 测每个 gate 的 pass + fail 场景。gate 是 rules 层纯函数，直接调断言 passed/report。
 * 对应 test.json U8-U12（gate 矩阵）。
 */
import { describe, expect,it } from "vitest";

import type {
  DesignReviewJudgment,
  ExecReviewJudgment,
  PlanningRetrospectData,
  RetrospectData,
  TestJudgment,
} from "../src/core/judgments.js";
import type { WaveFile,WaveTestCase } from "../src/core/plan.js";
import type { ExecutionUnit } from "../src/core/workunit.js";
import { createWave } from "../src/core/workunit.js";
import {
  designReviewAlternativesNonEmpty,
  designReviewNecessityNonEmpty,
  designReviewRisksPresent,
  designReviewSufficiencyComplete,
  designReviewTradeoffsPresent,
  noSiblingWaveFileConflict,
  runWaveDesignReviewGates,
  testCasesHaveExpected,
  testCasesNonEmpty,
  testCommandNonEmpty,
} from "../src/rules/gates/design-review.js";
import {
  execReviewArchitectureNonEmpty,
  execReviewFollowupActionsWhenNeeded,
  execReviewOverallVerdictNonEmpty,
  execReviewReadabilityNonEmpty,
} from "../src/rules/gates/exec-review.js";
import {
  lessonsLearnedNonEmpty,
  retrospectCoversJudgments,
  reviewedItemsCoverDesignReview,
} from "../src/rules/gates/retrospect.js";
import {
  commitExists,
  testCasesExecuted,
  testReferencesDesignReview,
  testsAllPass,
} from "../src/rules/gates/test.js";

// ── 辅助构造 ─────────────────────────────────────────────────

/** 构造一个 status=created 的 wave（plan 空态，便于测 testCases gate）。 */
function emptyWave(): ExecutionUnit {
  return createWave({
    slug: "gate-test",
    objective: "o",
    parentUnitId: "slice:s",
    basedOnParent: [],
  });
}

function tc(id: string, expected = "y"): WaveTestCase {
  return { id, status: "active", name: `tc ${id}`, scenario: "s", input: "x", expected, type: "unit" };
}

function fullDesignReviewJudgment(): DesignReviewJudgment {
  return {
    necessity: "necessary",
    sufficiency: { gaps: [], overlaps: [], meceNote: "mece note" },
    alternatives: "alt",
    tradeoffs: [{ id: "TF1", decision: "d", reason: "r", cost: "c" }],
    risks: [{ id: "RK1", item: "i", severity: "low", mitigation: "m" }],
  };
}

/** 合法的 wave layerSpecific（4 字段都非空，过 wave-layer-specific-non-empty gate）。 */
function fullWaveLayerSpecific() {
  return {
    testCaseCoverageNote: "covered",
    boundaryConditionNote: "boundary",
    mockStrategyNote: "mock",
    tddRedReadinessNote: "ready",
  };
}

/** 构造一个 WaveFile（默认 action="modify"）。 */
function wf(path: string, action: WaveFile["action"] = "modify"): WaveFile {
  return { id: `F-${path}`, status: "active", path, action, description: `file ${path}` };
}

/** 构造一个含合法 plan（testCases/files）的 wave，过 testCases 结构 gate。 */
function waveWithPlan(): ExecutionUnit {
  const unit = emptyWave();
  unit.plan.testCases = [tc("TC1")];
  unit.plan.files = [wf("src/a.ts")];
  unit.plan.testCommand = "npx vitest run";
  return unit;
}

// ═══════════════════════════════════════════════════════════════
// design-review gates
// ═══════════════════════════════════════════════════════════════

describe("design-review gates", () => {
  // U8: testCasesNonEmpty
  describe("U8: testCasesNonEmpty", () => {
    it("testCases 为空 → fail", () => {
      const unit = emptyWave();
      const r = testCasesNonEmpty(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/test-cases-non-empty/);
    });

    it("testCases 非空 → pass", () => {
      const unit = emptyWave();
      unit.plan.testCases = [tc("TC1")];
      const r = testCasesNonEmpty(unit);
      expect(r.passed).toBe(true);
    });
  });

  describe("testCasesHaveExpected", () => {
    it("某条 expected 为空 → fail", () => {
      const unit = emptyWave();
      unit.plan.testCases = [tc("TC1", "y"), tc("TC2", "")];
      const r = testCasesHaveExpected(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/TC2/);
    });

    it("全部 expected 非空 → pass", () => {
      const unit = emptyWave();
      unit.plan.testCases = [tc("TC1", "y"), tc("TC2", "z")];
      const r = testCasesHaveExpected(unit);
      expect(r.passed).toBe(true);
    });
  });

  describe("testCommandNonEmpty", () => {
    it("testCommand 为空串 → fail", () => {
      const unit = emptyWave();
      unit.plan.testCommand = "";
      const r = testCommandNonEmpty(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/test-command-non-empty/);
    });

    it("testCommand 为 undefined → fail", () => {
      const unit = emptyWave();
      unit.plan.testCommand = undefined;
      const r = testCommandNonEmpty(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/test-command-non-empty/);
    });

    it("testCommand 为纯空白串 → fail", () => {
      const unit = emptyWave();
      unit.plan.testCommand = "   ";
      const r = testCommandNonEmpty(unit);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/test-command-non-empty/);
    });

    it("testCommand 非空 → pass", () => {
      const unit = emptyWave();
      unit.plan.testCommand = "npx vitest run src/a.test.ts";
      const r = testCommandNonEmpty(unit);
      expect(r.passed).toBe(true);
      expect(r.report).toMatch(/test-command-non-empty/);
    });
  });

  // U9: judgment 非空 gate（necessity / sufficiency / alternatives / tradeoffs / risks）
  describe("U9: design-review judgment 非空 gate", () => {
    it("necessity 为空 → fail", () => {
      const j = fullDesignReviewJudgment();
      j.necessity = "";
      expect(designReviewNecessityNonEmpty(j).passed).toBe(false);
    });
    it("necessity 非空 → pass", () => {
      expect(designReviewNecessityNonEmpty(fullDesignReviewJudgment()).passed).toBe(true);
    });

    it("sufficiency.meceNote 为空 → fail", () => {
      const j = fullDesignReviewJudgment();
      j.sufficiency.meceNote = "";
      expect(designReviewSufficiencyComplete(j).passed).toBe(false);
    });
    it("sufficiency.meceNote 非空（gaps/overlaps 可空）→ pass", () => {
      const j = fullDesignReviewJudgment();
      j.sufficiency.gaps = [];
      j.sufficiency.overlaps = [];
      expect(designReviewSufficiencyComplete(j).passed).toBe(true);
    });

    it("alternatives 为空 → fail", () => {
      const j = fullDesignReviewJudgment();
      j.alternatives = "";
      expect(designReviewAlternativesNonEmpty(j).passed).toBe(false);
    });
    it("alternatives 非空 → pass", () => {
      expect(designReviewAlternativesNonEmpty(fullDesignReviewJudgment()).passed).toBe(true);
    });

    it("tradeoffs 为空数组 → fail", () => {
      const j = fullDesignReviewJudgment();
      j.tradeoffs = [];
      expect(designReviewTradeoffsPresent(j).passed).toBe(false);
    });
    it("tradeoffs 非空 → pass", () => {
      expect(designReviewTradeoffsPresent(fullDesignReviewJudgment()).passed).toBe(true);
    });

    it("risks 为空数组 → fail", () => {
      const j = fullDesignReviewJudgment();
      j.risks = [];
      expect(designReviewRisksPresent(j).passed).toBe(false);
    });
    it("risks 非空 → pass", () => {
      expect(designReviewRisksPresent(fullDesignReviewJudgment()).passed).toBe(true);
    });
  });

  // 跨 wave 文件冲突 gate（design §3.4）
  describe("noSiblingWaveFileConflict", () => {
    it("无兄弟（siblingFiles 空）→ pass", () => {
      const r = noSiblingWaveFileConflict([wf("src/a.ts")], []);
      expect(r.passed).toBe(true);
      expect(r.report).toMatch(/no-sibling-wave-file-conflict/);
    });

    it("无冲突（path 不交集）→ pass", () => {
      const r = noSiblingWaveFileConflict(
        [wf("src/a.ts")],
        [{ unitId: "wave:sib", files: [wf("src/b.ts")] }],
      );
      expect(r.passed).toBe(true);
    });

    it("path 交集 → fail（report 含冲突 path + 兄弟 unitId）", () => {
      const r = noSiblingWaveFileConflict(
        [wf("src/foo.ts"), wf("src/bar.ts")],
        [{ unitId: "wave:sib-1", files: [wf("src/foo.ts"), wf("src/other.ts")] }],
      );
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/跨 wave 文件冲突/);
      expect(r.report).toContain("src/foo.ts");
      expect(r.report).toContain("wave:sib-1");
      // 没有交集的 path 不出现在 report
      expect(r.report).not.toContain("src/bar.ts");
    });

    it("多个兄弟多个冲突 path → 全列出", () => {
      const r = noSiblingWaveFileConflict(
        [wf("src/x.ts"), wf("src/y.ts")],
        [
          { unitId: "wave:sib-1", files: [wf("src/x.ts")] },
          { unitId: "wave:sib-2", files: [wf("src/y.ts")] },
        ],
      );
      expect(r.passed).toBe(false);
      expect(r.report).toContain("src/x.ts");
      expect(r.report).toContain("wave:sib-1");
      expect(r.report).toContain("src/y.ts");
      expect(r.report).toContain("wave:sib-2");
    });

    it("action=delete 的文件跳过（删除不冲突）", () => {
      // 当前 wave 与兄弟都声明 delete 同一 path → 不算冲突
      const r = noSiblingWaveFileConflict(
        [wf("src/old.ts", "delete")],
        [{ unitId: "wave:sib", files: [wf("src/old.ts", "delete")] }],
      );
      expect(r.passed).toBe(true);
      expect(r.report).toMatch(/全为 delete/);
    });

    it("self delete + sibling modify 同一 path → 不冲突（self 删除不参与）", () => {
      const r = noSiblingWaveFileConflict(
        [wf("src/old.ts", "delete")],
        [{ unitId: "wave:sib", files: [wf("src/old.ts", "modify")] }],
      );
      expect(r.passed).toBe(true);
    });

    it("self modify + sibling delete 同一 path → 不冲突（sibling 删除不参与）", () => {
      const r = noSiblingWaveFileConflict(
        [wf("src/old.ts", "modify")],
        [{ unitId: "wave:sib", files: [wf("src/old.ts", "delete")] }],
      );
      expect(r.passed).toBe(true);
    });

    it("空 selfFiles → pass", () => {
      const r = noSiblingWaveFileConflict([], [{ unitId: "wave:sib", files: [wf("src/a.ts")] }]);
      expect(r.passed).toBe(true);
      expect(r.report).toMatch(/无 plan\.files/);
    });
  });

  // wave design-review 聚合 gate
  describe("runWaveDesignReviewGates", () => {
    it("聚合返回 10 个 GateResult（7 原有 + 1 testCommand + 1 layerSpecific + 1 文件冲突）", () => {
      const unit = waveWithPlan();
      const r = runWaveDesignReviewGates(
        unit,
        fullDesignReviewJudgment(),
        fullWaveLayerSpecific(),
        [],
      );
      expect(r).toHaveLength(10);
      // 全 pass（合法 unit，含非空 testCommand + 无兄弟）
      expect(r.every((g) => g.passed)).toBe(true);
    });

    it("siblingFiles 有冲突 → 最后一个（文件冲突）gate fail", () => {
      const unit = waveWithPlan(); // plan.files 含 src/a.ts
      // 让 self 的 src/a.ts 与兄弟冲突——改 unit.plan.files 的 path 到与兄弟一致
      unit.plan.files = [wf("src/conflict.ts")];
      const r = runWaveDesignReviewGates(
        unit,
        fullDesignReviewJudgment(),
        fullWaveLayerSpecific(),
        [{ unitId: "wave:sib", files: [wf("src/conflict.ts")] }],
      );
      // 前 9 个 pass，最后一个（文件冲突）fail
      expect(r.slice(0, 9).every((g) => g.passed)).toBe(true);
      const last = r[9]!;
      expect(last.passed).toBe(false);
      expect(last.report).toContain("src/conflict.ts");
    });

    it("testCases 空 → 第一个 gate（test-cases-non-empty）fail，其余仍跑（不短路）", () => {
      const unit = emptyWave(); // 空 testCases + 空 files
      const r = runWaveDesignReviewGates(
        unit,
        fullDesignReviewJudgment(),
        fullWaveLayerSpecific(),
        [],
      );
      expect(r[0]!.passed).toBe(false); // test-cases-non-empty
      expect(r[0]!.report).toMatch(/test-cases-non-empty/);
      // 文件冲突 gate 仍执行（聚合不短路）——空 files → pass
      const last = r[9]!;
      expect(last.passed).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// test gates
// ═══════════════════════════════════════════════════════════════

describe("test gates", () => {
  // U10: testsAllPass
  describe("U10: testsAllPass", () => {
    it("passed=true → pass", () => {
      const r = testsAllPass({ passed: true, passedCount: 1, failedCount: 0 });
      expect(r.passed).toBe(true);
    });

    it("passed=false → fail", () => {
      const r = testsAllPass({ passed: false, passedCount: 0, failedCount: 1 });
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/tests-all-pass/);
    });

    it("passed=false 且 failedTests 非空 → report 含失败测试名", () => {
      const r = testsAllPass({
        passed: false,
        passedCount: 0,
        failedCount: 1,
        failedTests: ["some test"],
      });
      expect(r.passed).toBe(false);
      expect(r.report).toContain("some test");
      expect(r.report).toMatch(/失败测试：some test/);
    });

    it("passed=false 且 failedTests 为空 → report 不含失败测试段", () => {
      const r = testsAllPass({
        passed: false,
        passedCount: 0,
        failedCount: 1,
        failedTests: [],
      });
      expect(r.passed).toBe(false);
      expect(r.report).not.toMatch(/失败测试/);
    });

    it("testRunResult 缺失（undefined）→ fail", () => {
      const r = testsAllPass(undefined);
      expect(r.passed).toBe(false);
    });
  });

  // U11: commitExists
  describe("U11: commitExists", () => {
    const ok = { exists: () => true };
    const no = { exists: () => false };

    it("hash 非空 + git 校验通过 → pass", () => {
      expect(commitExists("abc123", ok).passed).toBe(true);
    });

    it("hash 为空 → fail", () => {
      const r = commitExists("", ok);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/commit-exists/);
    });

    it("git 校验不通过 → fail", () => {
      const r = commitExists("abc123", no);
      expect(r.passed).toBe(false);
    });
  });

  // U12: testReferencesDesignReview
  describe("U12: testReferencesDesignReview", () => {
    const dr = fullDesignReviewJudgment(); // tradeoffs=[TF1], risks=[RK1]

    function validTestJudgment(): TestJudgment {
      return {
        necessityMet: "met",
        sufficiencyMet: { gapsConfirmed: [], gapsNewlyFound: [], overlapsConfirmed: [] },
        alternativesReconsidered: "reconsidered",
        tradeoffCostRealized: [{ tradeoffRef: "TF1", costRealized: true }],
        riskOutcome: [{ riskRef: "RK1", outcome: "mitigated" }],
      };
    }

    it("全覆盖（TF1/RK1 + 字符串字段非空）→ pass", () => {
      expect(testReferencesDesignReview(validTestJudgment(), dr).passed).toBe(true);
    });

    it("necessityMet 为空 → fail", () => {
      const tj = validTestJudgment();
      tj.necessityMet = "";
      expect(testReferencesDesignReview(tj, dr).passed).toBe(false);
    });

    it("alternativesReconsidered 为空 → fail", () => {
      const tj = validTestJudgment();
      tj.alternativesReconsidered = "  ";
      expect(testReferencesDesignReview(tj, dr).passed).toBe(false);
    });

    it("sufficiencyMet 缺失 → fail", () => {
      const tj = validTestJudgment();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tj as any).sufficiencyMet = undefined;
      expect(testReferencesDesignReview(tj, dr).passed).toBe(false);
    });

    it("tradeoffCostRealized 未覆盖 TF1 → fail", () => {
      const tj = validTestJudgment();
      tj.tradeoffCostRealized = [];
      expect(testReferencesDesignReview(tj, dr).passed).toBe(false);
    });

    it("riskOutcome 未覆盖 RK1 → fail", () => {
      const tj = validTestJudgment();
      tj.riskOutcome = [];
      expect(testReferencesDesignReview(tj, dr).passed).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// exec-review gates
// ═══════════════════════════════════════════════════════════════

describe("exec-review gates", () => {
  function passJudgment(): ExecReviewJudgment {
    return { readability: { score: 4 }, architecture: { score: 4 }, overallVerdict: "pass" };
  }

  describe("readability / architecture", () => {
    it("score 在 1-5 → pass", () => {
      expect(execReviewReadabilityNonEmpty(passJudgment()).passed).toBe(true);
      expect(execReviewArchitectureNonEmpty(passJudgment()).passed).toBe(true);
    });
    it("score 超范围（0）→ fail", () => {
      const j = passJudgment();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (j.readability as any).score = 0;
      expect(execReviewReadabilityNonEmpty(j).passed).toBe(false);
    });
  });

  describe("overallVerdict", () => {
    it('"pass" → pass', () => {
      expect(execReviewOverallVerdictNonEmpty(passJudgment()).passed).toBe(true);
    });
    it('"needs-followup" → pass', () => {
      const j = passJudgment();
      j.overallVerdict = "needs-followup";
      expect(execReviewOverallVerdictNonEmpty(j).passed).toBe(true);
    });
  });

  // followupActionsWhenNeeded
  describe("followupActionsWhenNeeded", () => {
    it('overallVerdict="needs-followup" + 空 actions → fail', () => {
      const j: ExecReviewJudgment = {
        readability: { score: 3 },
        architecture: { score: 3 },
        overallVerdict: "needs-followup",
        followupActions: [],
      };
      const r = execReviewFollowupActionsWhenNeeded(j);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/needs-followup/);
    });

    it('overallVerdict="needs-followup" + 1 条 action → pass', () => {
      const j: ExecReviewJudgment = {
        readability: { score: 3 },
        architecture: { score: 3 },
        overallVerdict: "needs-followup",
        followupActions: [
          { description: "refactor x", priority: "medium", targetScope: "current-wave-replan" },
        ],
      };
      expect(execReviewFollowupActionsWhenNeeded(j).passed).toBe(true);
    });

    it('overallVerdict="pass" + 空 actions → pass（不强制）', () => {
      const j = passJudgment();
      expect(execReviewFollowupActionsWhenNeeded(j).passed).toBe(true);
    });
  });

  // U13: testCasesExecuted —— 验 passedCount/failedCount 覆盖非 manual 用例数。
  // 特别回归覆盖 vitest 多行输出计数解析 bug：
  //   vitest 输出 `Test Files N passed` 和 `Tests M passed` 两行，
  //   passedCount 必须是 M（用例数）而非 N（文件数），否则本 gate 会误判 fail。
  describe("U13: testCasesExecuted", () => {
    function waveWith(n: number): ExecutionUnit {
      const u = emptyWave();
      u.plan.testCases = Array.from({ length: n }, (_, i) => tc(`TC${i + 1}`));
      return u;
    }
    const okTj: TestJudgment = {
      necessityMet: "met",
      sufficiencyMet: { gapsConfirmed: [], gapsNewlyFound: [], overlapsConfirmed: [] },
      alternativesReconsidered: "reconsidered",
      tradeoffCostRealized: [],
      riskOutcome: [],
    };

    it("非 manual 用例 5 个 + testRunResult 记录 5 次执行 → pass", () => {
      const r = testCasesExecuted(
        waveWith(5),
        { passed: true, passedCount: 5, failedCount: 0 },
        okTj,
      );
      expect(r.passed).toBe(true);
    });

    it("testRunResult 缺失 → fail", () => {
      const r = testCasesExecuted(waveWith(5), undefined, okTj);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/只记录了 0 次执行/);
    });

    it("executedCount < 非 manual 用例数 → fail", () => {
      const r = testCasesExecuted(
        waveWith(5),
        { passed: true, passedCount: 3, failedCount: 0 },
        okTj,
      );
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/只记录了 3 次执行/);
    });

    // 关键回归：vitest 多行输出，passedCount 必须是用例数（Tests 行）而非文件数（Test Files 行）。
    // 模拟 cli.ts testRunner 解析后的 TestRunResult（修复后行为）：936 用例通过 / 110 文件。
    it("[REGRESSION] passedCount 取用例数(936)而非文件数(110) → 非 manual 200 个时 pass", () => {
      // 若解析 bug 复发，passedCount 会是 110（文件数），executedCount=110 < 200 → gate 错误 fail。
      // 本断言锁死：parsed passedCount 必须等于用例数。
      const vitestTestCaseCount = 936;
      const vitestFileCount = 110; // 旧 bug 会错取这个值
      const r = testCasesExecuted(
        waveWith(200),
        { passed: true, passedCount: vitestTestCaseCount, failedCount: 0 },
        okTj,
      );
      expect(r.passed).toBe(true);
      // 反证：若 passedCount 被错取为文件数，gate 会 fail——锁住回归。
      const buggyR = testCasesExecuted(
        waveWith(200),
        { passed: true, passedCount: vitestFileCount, failedCount: 0 },
        okTj,
      );
      expect(buggyR.passed).toBe(false);
    });

    it("manual 类用例走退化验证（sufficiencyMet.note 非空 → pass）", () => {
      const u = emptyWave();
      u.plan.testCases = [{ ...tc("TC1"), type: "manual" }];
      const tj = {
        ...okTj,
        sufficiencyMet: { ...okTj.sufficiencyMet, note: "manual 验收记录" },
      };
      const r = testCasesExecuted(u, undefined, tj);
      expect(r.passed).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// retrospect gates
// ═══════════════════════════════════════════════════════════════

describe("retrospect gates", () => {
  const dr = fullDesignReviewJudgment(); // 核心项 = necessity/sufficiency/alternatives/TF1/RK1

  describe("lessonsLearnedNonEmpty", () => {
    it("lessonsLearned 非空 → pass", () => {
      const rd: RetrospectData = { reviewedItems: [], lessonsLearned: "learned something" };
      expect(lessonsLearnedNonEmpty(rd).passed).toBe(true);
    });
    it("lessonsLearned 为空 → fail", () => {
      const rd: RetrospectData = { reviewedItems: [], lessonsLearned: "" };
      const r = lessonsLearnedNonEmpty(rd);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/lessons-learned-non-empty/);
    });
  });

  describe("retrospectCoversJudgments", () => {
    function coversAll(): RetrospectData {
      return {
        reviewedItems: [
          { itemId: "necessity", outcome: "fulfilled" },
          { itemId: "sufficiency", outcome: "fulfilled" },
          { itemId: "alternatives", outcome: "fulfilled" },
          { itemId: "TF1", outcome: "fulfilled" },
          { itemId: "RK1", outcome: "fulfilled" },
        ],
        lessonsLearned: "ok",
      };
    }

    it("reviewedItems 覆盖全部核心项 → pass", () => {
      expect(retrospectCoversJudgments(coversAll(), dr).passed).toBe(true);
    });

    it("reviewedItems 缺少 TF1 → fail", () => {
      const rd = coversAll();
      rd.reviewedItems = rd.reviewedItems.filter((r) => r.itemId !== "TF1");
      const r = retrospectCoversJudgments(rd, dr);
      expect(r.passed).toBe(false);
      expect(r.report).toMatch(/TF1/);
    });

    it("reviewedItems 缺少 necessity → fail", () => {
      const rd = coversAll();
      rd.reviewedItems = rd.reviewedItems.filter((r) => r.itemId !== "necessity");
      expect(retrospectCoversJudgments(rd, dr).passed).toBe(false);
    });

    // ── #3：codeSmell 稳定 key + followup 容错 + failure 报告扩展（T1.9-T1.11 / T2.7）──

    it("codeSmell 对象元素 → 不产 [object Object] 垃圾 key（T1.9，AC-3.2）", () => {
      const rd = coversAll(); // 未覆盖 codeSmell key → fail，报告含缺失清单
      const erj: ExecReviewJudgment = {
        readability: { score: 4 },
        architecture: { score: 4 },
        overallVerdict: "pass",
        // 运行时类型违规：items 声明 string[]，agent 填了对象
        codeSmells: { items: [{ name: "magic-string", file: "src/a.ts" }] as unknown as string[] },
      };
      const r = retrospectCoversJudgments(rd, dr, undefined, erj);
      expect(r.passed).toBe(false);
      // 缺失清单含稳定序列化 key，而非 [object Object]
      expect(r.report).toContain("codeSmell:");
      expect(r.report).toContain("magic-string");
      expect(r.report).not.toContain("[object Object]");
    });

    it("存量 string codeSmell/followup key 不失配：覆盖后 pass（T1.11）", () => {
      const rd = coversAll();
      rd.reviewedItems = [
        ...rd.reviewedItems,
        { itemId: "readability", outcome: "fulfilled" },
        { itemId: "architecture", outcome: "fulfilled" },
        { itemId: "codeSmell:magic-string", outcome: "fulfilled" },
        { itemId: "followup:extract token service", outcome: "fulfilled" },
      ];
      const erj: ExecReviewJudgment = {
        readability: { score: 4 },
        architecture: { score: 4 },
        overallVerdict: "needs-followup",
        codeSmells: { items: ["magic-string"] },
        followupActions: ["extract token service"] as unknown as ExecReviewJudgment["followupActions"],
      };
      const r = retrospectCoversJudgments(rd, dr, undefined, erj);
      expect(r.passed).toBe(true);
    });

    it("failure 报告含「期望全集 + 缺失子集」两段（T2.7，AC-3.1）", () => {
      const rd = coversAll();
      rd.reviewedItems = rd.reviewedItems.filter((r) => r.itemId !== "TF1");
      const r = retrospectCoversJudgments(rd, dr);
      expect(r.passed).toBe(false);
      // 期望全集（含已覆盖的 necessity/sufficiency/alternatives/RK1）+ 缺失子集（TF1）
      expect(r.report).toContain("期望全集:");
      expect(r.report).toContain("necessity");
      expect(r.report).toContain("RK1");
      expect(r.report).toContain("缺失: TF1");
    });
  });

  describe("reviewedItemsCoverDesignReview（slice 层）", () => {
    function sliceCoversAll(): PlanningRetrospectData {
      return {
        reviewedItems: [
          { itemId: "necessity", outcome: "fulfilled" },
          { itemId: "sufficiency", outcome: "fulfilled" },
          { itemId: "alternatives", outcome: "fulfilled" },
          { itemId: "TF1", outcome: "fulfilled" },
          { itemId: "RK1", outcome: "fulfilled" },
        ],
        lessonsLearned: "ok",
        splitFulfillment: [],
        childUnitIdsEvidence: [],
        deliveryVerdict: "delivered",
      };
    }

    it("缺 id 的 tradeoff/risk 不产 undefined key，failure 含两段（T2.7b，M-6）", () => {
      const rd = sliceCoversAll();
      const drMissingId: DesignReviewJudgment = {
        necessity: "n",
        sufficiency: { gaps: [], overlaps: [], meceNote: "m" },
        alternatives: "a",
        // 类型违规：tradeoff 缺 id（运行时无保障）
        tradeoffs: [{ decision: "JWT over session", reason: "r", cost: "c" } as unknown as DesignReviewJudgment["tradeoffs"][number]],
        risks: [{ item: "token leak", severity: "medium", mitigation: "short TTL" } as unknown as DesignReviewJudgment["risks"][number]],
      };
      const r = reviewedItemsCoverDesignReview(rd, drMissingId);
      expect(r.passed).toBe(false);
      expect(r.report).not.toContain("undefined");
      // 输入验证错误列出缺 id 项
      expect(r.report).toContain("缺少 id");
      // 全量缺失子集格式由下一条用例验证（本用例只有输入验证错误、无缺失项）
    });

    it("slice 层 failure 报告含「期望全集 + 缺失子集」两段", () => {
      const rd = sliceCoversAll();
      rd.reviewedItems = rd.reviewedItems.filter((r) => r.itemId !== "RK1");
      const r = reviewedItemsCoverDesignReview(rd, fullDesignReviewJudgment());
      expect(r.passed).toBe(false);
      expect(r.report).toContain("期望全集:");
      expect(r.report).toContain("缺失: RK1");
    });
  });
});

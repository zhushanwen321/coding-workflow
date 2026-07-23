/**
 * v1 wave evidence 跨阶段生命周期测试（U16-U17）。
 *
 * 通过 handler 串联验证 evidence 的客观/主观/冻结部分逐步填充：
 * - handleExecute → evidence.commitHash + changedFiles + generatedAt
 * - handleTest → evidence.testRunResult
 * - handleCloseout → evidence.frozenAt + summary/artifacts
 *
 * 对应 test.json U16-U17。
 */
import { afterEach,beforeEach, describe, expect, it } from "vitest";

import type { ExecutionUnit } from "../../src/v1/core/workunit.js";
import { handleCloseout } from "../../src/v1/handlers/closeout.js";
import { handleDesignReview } from "../../src/v1/handlers/design-review.js";
import { handleExecReview } from "../../src/v1/handlers/exec-review.js";
import { handleExecute } from "../../src/v1/handlers/execute.js";
import { handlePlan } from "../../src/v1/handlers/plan.js";
import { handleRetrospect } from "../../src/v1/handlers/retrospect.js";
import { handleTest } from "../../src/v1/handlers/test.js";
import type { WorkUnitRecord } from "../../src/v1/store/schema.js";
import {
  createV1Env,
  makeValidContract,
  makeValidDesignReviewJudgment,
  makeValidExecReviewJudgment,
  makeValidFile,
  makeValidRetrospectData,
  makeValidTask,
  makeValidTestCase,
  makeValidTestJudgment,
  makeWaveUnit,
  STUB_NOW,
  type V1Env,
} from "./helpers/v1-env.js";

let env: V1Env;

beforeEach(() => {
  env = createV1Env();
});

afterEach(() => {
  env.cleanup();
});

/**
 * 把 unit 推进到 design-reviewed（跑完 plan + design-review，含合法 gate input）。
 * 返回 store 里最新的 unit（已含 designReviewJudgment）。
 */
function advanceToDesignReviewed(slug: string): ExecutionUnit {
  let unit = makeWaveUnit(slug);
  env.store.save(unit as unknown as WorkUnitRecord);

  // plan：写合法 testCases（过 design-review 的 testCases gate）
  handlePlan(unit, {
    testCases: [makeValidTestCase("TC1")],
    tasks: [makeValidTask("TK1")],
    files: [makeValidFile("F1")],
    contracts: [makeValidContract("C1")],
  }, env.deps);
  unit = loadUnit(unit.id);

  // design-review：写合法 judgment
  handleDesignReview(unit, {
    designReviewJudgment: makeValidDesignReviewJudgment(),
  }, env.deps);
  return loadUnit(unit.id);
}

/** 从 store 读最新 unit。 */
function loadUnit(id: string): ExecutionUnit {
  const r = env.store.load(id);
  return r as unknown as ExecutionUnit;
}

describe("U16: evidence 客观部分（execute + test 填充）", () => {
  it("handleExecute 后 evidence.commitHash + changedFiles + generatedAt 填充", () => {
    const before = advanceToDesignReviewed("ev-execute");
    expect(before.status).toBe("design-reviewed");

    const unit = loadUnit(before.id);
    handleExecute(unit, {
      commitHash: "abc123",
      changedFiles: ["src/foo.ts", "tests/foo.test.ts"],
    }, env.deps);

    const after = loadUnit(unit.id);
    expect(after.status).toBe("executing");
    expect(after.evidence.commitHash).toBe("abc123");
    expect(after.evidence.changedFiles).toEqual(["src/foo.ts", "tests/foo.test.ts"]);
    expect(after.evidence.generatedAt).toBe(STUB_NOW);
    expect(after.executeResult.commitHash).toBe("abc123");
  });

  it("handleExecute 不传 changedFiles → changedFiles 默认空数组", () => {
    const unit = advanceToDesignReviewed("ev-execute2");
    handleExecute(unit, { commitHash: "abc" }, env.deps);
    const after = loadUnit(unit.id);
    expect(after.evidence.changedFiles).toEqual([]);
  });

  it("handleTest 后 evidence.testRunResult 填充", () => {
    // 先推进到 executing
    let unit = advanceToDesignReviewed("ev-test");
    handleExecute(unit, { commitHash: "abc123" }, env.deps);
    unit = loadUnit(unit.id);
    expect(unit.status).toBe("executing");

    // test
    handleTest(unit, { testJudgment: makeValidTestJudgment() }, env.deps);
    const after = loadUnit(unit.id);
    expect(after.status).toBe("tested");
    expect(after.evidence.testRunResult).toBeDefined();
    expect(after.evidence.testRunResult!.passed).toBe(true);
    expect(after.evidence.testRunResult!.passedCount).toBe(1);
    expect(after.evidence.testRunResult!.failedCount).toBe(0);
    // testJudgment 也写入
    expect(after.testJudgment.necessityMet).toBeTruthy();
  });
});

describe("U17: evidence 主观部分 + 冻结（closeout）", () => {
  it("handleCloseout 后 evidence.frozenAt 非空 + summary/artifacts 填充", () => {
    // 完整推进到 retrospected
    let unit = advanceToDesignReviewed("ev-closeout");
    handleExecute(unit, { commitHash: "abc123", changedFiles: ["src/foo.ts"] }, env.deps);
    unit = loadUnit(unit.id);

    handleTest(unit, { testJudgment: makeValidTestJudgment() }, env.deps);
    unit = loadUnit(unit.id);

    handleExecReview(unit, { execReviewJudgment: makeValidExecReviewJudgment() }, env.deps);
    unit = loadUnit(unit.id);

    handleRetrospect(unit, { retrospectData: makeValidRetrospectData() }, env.deps);
    unit = loadUnit(unit.id);
    expect(unit.status).toBe("retrospected");

    // 冻结前 frozenAt 为空
    expect(unit.evidence.frozenAt).toBeUndefined();

    // closeout
    handleCloseout(unit, {
      summary: "delivered auth flow with token refresh",
      artifacts: [
        { kind: "code", ref: "src/foo.ts", note: "main module" },
        { kind: "test", ref: "tests/foo.test.ts" },
      ],
    }, env.deps);
    const after = loadUnit(unit.id);

    expect(after.status).toBe("closed");
    expect(after.evidence.frozenAt).toBe(STUB_NOW);
    expect(after.evidence.summary).toBe("delivered auth flow with token refresh");
    expect(after.evidence.artifacts).toHaveLength(2);
    expect(after.evidence.artifacts[0]!.ref).toBe("src/foo.ts");
    // 客观部分保留（未被覆盖）
    expect(after.evidence.commitHash).toBe("abc123");
    expect(after.evidence.testRunResult).toBeDefined();
  });

  it("frozenAt 在 closeout 前为空（retrospected 状态）", () => {
    let unit = advanceToDesignReviewed("ev-not-frozen");
    handleExecute(unit, { commitHash: "abc" }, env.deps);
    unit = loadUnit(unit.id);
    handleTest(unit, { testJudgment: makeValidTestJudgment() }, env.deps);
    unit = loadUnit(unit.id);
    handleExecReview(unit, { execReviewJudgment: makeValidExecReviewJudgment() }, env.deps);
    unit = loadUnit(unit.id);
    handleRetrospect(unit, { retrospectData: makeValidRetrospectData() }, env.deps);
    unit = loadUnit(unit.id);
    expect(unit.evidence.frozenAt).toBeUndefined();
  });

  it("closeout artifact drift（ref 指向不存在文件）→ 不冻结，ok=false", () => {
    let unit = advanceToDesignReviewed("ev-drift");
    handleExecute(unit, { commitHash: "abc" }, env.deps);
    unit = loadUnit(unit.id);
    handleTest(unit, { testJudgment: makeValidTestJudgment() }, env.deps);
    unit = loadUnit(unit.id);
    handleExecReview(unit, { execReviewJudgment: makeValidExecReviewJudgment() }, env.deps);
    unit = loadUnit(unit.id);
    handleRetrospect(unit, { retrospectData: makeValidRetrospectData() }, env.deps);
    unit = loadUnit(unit.id);

    // 用一个 fileExists 始终 false 的 deps 触发 drift
    const driftDeps = {
      ...env.deps,
      fileExists: { exists: () => false },
    };
    const result = handleCloseout(unit, {
      artifacts: [{ kind: "code", ref: "src/missing.ts" }],
    }, driftDeps);

    expect(result.ok).toBe(false);
    expect(result.gateResults?.[0]?.passed).toBe(false);
    // 未冻结
    expect(loadUnit(unit.id).evidence.frozenAt).toBeUndefined();
    // status 未推进（仍是 retrospected）
    expect(loadUnit(unit.id).status).toBe("retrospected");
  });
});

describe("evidence 客观部分 progressive 语义", () => {
  it("execute 重跑不覆盖已填的 generatedAt（progressive 保留首次）", () => {
    const unit = advanceToDesignReviewed("ev-progressive");
    handleExecute(unit, { commitHash: "first" }, env.deps);
    const first = loadUnit(unit.id);
    expect(first.evidence.generatedAt).toBe(STUB_NOW);

    // 模拟回退到 design-reviewed 再 execute（progressive 场景）
    first.status = "design-reviewed";
    env.store.save(first as unknown as WorkUnitRecord);
    // 用一个不同 clock 的 deps（模拟时间推进）
    const laterDeps = {
      ...env.deps,
      clock: { now: () => "2026-08-01T00:00:00.000Z" },
    };
    handleExecute(first, { commitHash: "second" }, laterDeps);
    const after = loadUnit(unit.id);
    // generatedAt 保留首次（不被 laterDeps 覆盖）
    expect(after.evidence.generatedAt).toBe(STUB_NOW);
    expect(after.evidence.commitHash).toBe("second");
  });
});

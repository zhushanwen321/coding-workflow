/**
 * v1 dispatch e2e 测试（E1-E2）。
 *
 * 通过 dispatch 统一入口跑完整 wave 生命周期，验证编排层正确串联。
 * - E1: create→...→closeout 全链路，断言最终 status=closed + evidence.frozenAt 非空
 * - E2: create 后直接 dispatch execute → V1Error(illegal_transition)
 *
 * 真实 store + stub V1Deps（外部依赖注入接口）。零 mock 框架。
 */
import { afterEach,beforeEach, describe, expect, it } from "vitest";

import type { ExecutionUnit } from "../../src/v1/core/workunit.js";
import { dispatch, V1Error } from "../../src/v1/dispatch.js";
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

/** 从 store 读最新 unit。 */
function loadUnit(id: string): ExecutionUnit {
  const r = env.store.load(id);
  return r as unknown as ExecutionUnit;
}

describe("E1: dispatch 完整 wave 生命周期", () => {
  it("create→clarify→plan→design-review→execute→test→exec-review→retrospect→closeout → closed", () => {
    // 1. create
    const created = dispatch(
      { action: "create", input: {
        slug: "e2e-happy",
        objective: "deliver auth flow",
        parentUnitId: "slice:auth",
        basedOnParent: ["TC1"],
      } },
      env.deps,
    );
    expect(created.ok).toBe(true);
    expect(created.status).toBe("created");
    const unitId = "wave:e2e-happy";

    // 2. clarify
    const clarify = dispatch(
      { action: "clarify", unitId, input: {
        clarifications: [
          { id: "Q1", status: "active", question: "use JWT?", resolution: "yes", type: "grilling" },
        ],
      } },
      env.deps,
    );
    expect(clarify.ok).toBe(true);
    expect(clarify.status).toBe("clarifying");
    expect(loadUnit(unitId).clarifications).toHaveLength(1);

    // 3. plan（写合法 testCases，过 design-review gate）
    const plan = dispatch(
      { action: "plan", unitId, input: {
        testCases: [makeValidTestCase("TC1")],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
      } },
      env.deps,
    );
    expect(plan.ok).toBe(true);
    expect(plan.status).toBe("planning");

    // 4. design-review（合法 judgment）
    const dr = dispatch(
      { action: "design-review", unitId, input: {
        designReviewJudgment: makeValidDesignReviewJudgment(),
      } },
      env.deps,
    );
    expect(dr.ok).toBe(true);
    expect(dr.status).toBe("design-reviewed");
    expect(loadUnit(unitId).designReviewJudgment.necessity).toBeTruthy();

    // 5. execute
    const execute = dispatch(
      { action: "execute", unitId, input: {
        commitHash: "deadbeef",
        changedFiles: ["src/auth.ts"],
      } },
      env.deps,
    );
    expect(execute.ok).toBe(true);
    expect(execute.status).toBe("executing");
    expect(loadUnit(unitId).evidence.commitHash).toBe("deadbeef");

    // 6. test（合法 testJudgment + stub testRunner passed）
    const test = dispatch(
      { action: "test", unitId, input: {
        testJudgment: makeValidTestJudgment(),
      } },
      env.deps,
    );
    expect(test.ok).toBe(true);
    expect(test.status).toBe("tested");
    expect(loadUnit(unitId).evidence.testRunResult!.passed).toBe(true);

    // 7. exec-review
    const execReview = dispatch(
      { action: "exec-review", unitId, input: {
        execReviewJudgment: makeValidExecReviewJudgment(),
      } },
      env.deps,
    );
    expect(execReview.ok).toBe(true);
    expect(execReview.status).toBe("exec-reviewed");

    // 8. retrospect
    const retrospect = dispatch(
      { action: "retrospect", unitId, input: {
        retrospectData: makeValidRetrospectData(),
      } },
      env.deps,
    );
    expect(retrospect.ok).toBe(true);
    expect(retrospect.status).toBe("retrospected");

    // 9. closeout
    const closeout = dispatch(
      { action: "closeout", unitId, input: {
        summary: "auth flow delivered",
        artifacts: [{ kind: "code", ref: "src/auth.ts", note: "main" }],
      } },
      env.deps,
    );
    expect(closeout.ok).toBe(true);
    expect(closeout.status).toBe("closed");

    // 最终断言：status=closed + evidence.frozenAt 非空 + statusHistory 完整
    const finalUnit = loadUnit(unitId);
    expect(finalUnit.status).toBe("closed");
    expect(finalUnit.evidence.frozenAt).toBe(STUB_NOW);
    expect(finalUnit.evidence.summary).toBe("auth flow delivered");
    expect(finalUnit.evidence.commitHash).toBe("deadbeef");

    // statusHistory 应包含全 9 步（create → closeout）
    const actions = finalUnit.statusHistory.map((h) => h.action);
    expect(actions).toEqual([
      "create", "clarify", "plan", "design-review",
      "execute", "test", "exec-review", "retrospect", "closeout",
    ]);
  });
});

describe("E2: dispatch 非法跳步 → V1Error(illegal_transition)", () => {
  it("create 后直接 execute → V1Error(illegal_transition)", () => {
    dispatch(
      { action: "create", input: {
        slug: "e2e-illegal",
        objective: "o",
        parentUnitId: "slice:s",
        basedOnParent: [],
      } },
      env.deps,
    );
    const unitId = "wave:e2e-illegal";

    expect(() =>
      dispatch(
        { action: "execute", unitId, input: { commitHash: "abc" } },
        env.deps,
      ),
    ).toThrow(V1Error);

    try {
      dispatch(
        { action: "execute", unitId, input: { commitHash: "abc" } },
        env.deps,
      );
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as V1Error;
      expect(err.code).toBe("illegal_transition");
      expect(err.message).toMatch(/execute/);
    }
  });

  it("test 从 created 状态 → V1Error(illegal_transition)", () => {
    dispatch(
      { action: "create", input: {
        slug: "e2e-illegal2",
        objective: "o",
        parentUnitId: "slice:s",
        basedOnParent: [],
      } },
      env.deps,
    );

    expect(() =>
      dispatch(
        { action: "test", unitId: "wave:e2e-illegal2", input: {
          testJudgment: makeValidTestJudgment(),
        } },
        env.deps,
      ),
    ).toThrow(V1Error);
  });

  it("closed 后任何 action → V1Error（终态不可逆）", () => {
    // 先跑到 closed（复用 E1 链路的最小版本）
    const unitId = "wave:e2e-terminal";
    const steps: Array<["clarify" | "plan" | "design-review" | "execute" | "test" | "exec-review" | "retrospect" | "closeout", unknown]> = [
      ["clarify", { clarifications: [] }],
      ["plan", {
        testCases: [makeValidTestCase("TC1")],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
      }],
      ["design-review", { designReviewJudgment: makeValidDesignReviewJudgment() }],
      ["execute", { commitHash: "abc", changedFiles: ["x.ts"] }],
      ["test", { testJudgment: makeValidTestJudgment() }],
      ["exec-review", { execReviewJudgment: makeValidExecReviewJudgment() }],
      ["retrospect", { retrospectData: makeValidRetrospectData() }],
      ["closeout", { summary: "s", artifacts: [{ kind: "code", ref: "x.ts" }] }],
    ];
    dispatch({ action: "create", input: {
      slug: "e2e-terminal", objective: "o", parentUnitId: "slice:s", basedOnParent: [],
    } }, env.deps);
    for (const [action, input] of steps) {
      const r = dispatch({ action, unitId, input } as never, env.deps);
      expect(r.ok).toBe(true);
    }
    expect(loadUnit(unitId).status).toBe("closed");

    // closed 后再 execute → illegal
    expect(() =>
      dispatch({ action: "execute", unitId, input: { commitHash: "xyz" } }, env.deps),
    ).toThrow(V1Error);
  });

  it("unit not found → V1Error(unit_not_found)", () => {
    expect(() =>
      dispatch(
        { action: "clarify", unitId: "wave:ghost", input: { clarifications: [] } },
        env.deps,
      ),
    ).toThrow(V1Error);
    try {
      dispatch(
        { action: "clarify", unitId: "wave:ghost", input: { clarifications: [] } },
        env.deps,
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as V1Error).code).toBe("unit_not_found");
    }
  });
});

describe("E: dispatch gate 失败返回 ok=false（不抛错）", () => {
  it("design-review gate fail（testCases 空）→ ActionResult(ok=false)，status 不变", () => {
    const unitId = "wave:e2e-gate";
    dispatch({ action: "create", input: {
      slug: "e2e-gate", objective: "o", parentUnitId: "slice:s", basedOnParent: [],
    } }, env.deps);
    dispatch({ action: "clarify", unitId, input: { clarifications: [] } }, env.deps);
    // plan 空的 testCases（design-review 会 fail test-cases-non-empty）
    dispatch({ action: "plan", unitId, input: {
      testCases: [], tasks: [], files: [], contracts: [],
    } }, env.deps);

    const result = dispatch({ action: "design-review", unitId, input: {
      designReviewJudgment: makeValidDesignReviewJudgment(),
    } }, env.deps);

    expect(result.ok).toBe(false);
    expect(result.gateResults).toBeDefined();
    expect(result.gateResults!.some((g) => !g.passed)).toBe(true);
    // status 未推进（仍是 planning）
    expect(loadUnit(unitId).status).toBe("planning");
    // judgment 未写入
    expect(loadUnit(unitId).designReviewJudgment.necessity).toBe("");
  });
});

describe("E: dispatch replan 旁路（不改 status）", () => {
  it("design-reviewed 后 replan → status 不变（仍 design-reviewed）+ statusHistory append", () => {
    const unitId = "wave:e2e-replan";
    dispatch({ action: "create", input: {
      slug: "e2e-replan", objective: "o", parentUnitId: "slice:s", basedOnParent: [],
    } }, env.deps);
    dispatch({ action: "clarify", unitId, input: { clarifications: [] } }, env.deps);
    dispatch({ action: "plan", unitId, input: {
      testCases: [makeValidTestCase("TC1")],
      tasks: [makeValidTask("TK1")],
      files: [makeValidFile("F1")],
      contracts: [makeValidContract("C1")],
    } }, env.deps);
    dispatch({ action: "design-review", unitId, input: {
      designReviewJudgment: makeValidDesignReviewJudgment(),
    } }, env.deps);
    expect(loadUnit(unitId).status).toBe("design-reviewed");

    const result = dispatch({ action: "replan", unitId, input: {
      abandonedIds: ["TC1"],
      note: "TC1 obsolete",
    } }, env.deps);

    expect(result.ok).toBe(true);
    // 旁路：status 不变
    expect(result.status).toBe("design-reviewed");
    expect(loadUnit(unitId).status).toBe("design-reviewed");
    // statusHistory append 了 replan（from=to=design-reviewed）
    const last = loadUnit(unitId).statusHistory.at(-1)!;
    expect(last.action).toBe("replan");
    expect(last.from).toBe("design-reviewed");
    expect(last.to).toBe("design-reviewed");
    expect(last.note).toBe("TC1 obsolete");
    // TC1 标记为 abandoned
    const tc1 = loadUnit(unitId).plan.testCases.find((t) => t.id === "TC1")!;
    expect(tc1.status).toBe("abandoned");
    // replanImpact（wave 叶子，aborted 为空）
    expect(result.replanImpact).toBeDefined();
    expect(result.replanImpact!.aborted).toEqual([]);
  });
});

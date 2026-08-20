/**
 * v1 dispatch e2e 测试（E1-E2）。
 *
 * 通过 dispatch 统一入口跑完整 wave 生命周期，验证编排层正确串联。
 * - E1: create→...→closeout 全链路，断言最终 status=closed + evidence.frozenAt 非空
 * - E2: create 后直接 dispatch execute → CwEngineError(illegal_transition)
 *
 * 真实 store + stub CwDeps（外部依赖注入接口）。零 mock 框架。
 */
import { afterEach,beforeEach, describe, expect, it } from "vitest";

import { CwError } from "../src/core/errors.js";
import type { ExecutionUnit } from "../src/core/workunit.js";
import { CwEngineError,dispatch } from "../src/dispatch.js";
import {
  createCwEnv,
  type CwEnv,
  makeValidContract,
  makeValidDesignReviewJudgment,
  makeValidExecReviewJudgment,
  makeValidFile,
  makeValidRetrospectData,
  makeValidTask,
  makeValidTestCase,
  makeValidTestJudgment,
  STUB_NOW,
} from "./helpers/env.js";

let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
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
  it("create→design→design-review→execute→test→exec-review→retrospect→closeout → closed", () => {
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

    // 2. design（合并原 clarify+plan：clarifications append + 写合法 testCases，过 design-review gate）
    const design = dispatch(
      { action: "design", unitId, input: {
        clarifications: [
          { id: "Q1", status: "active", question: "use JWT?", resolution: "yes", type: "grilling" },
        ],
        testCases: [makeValidTestCase("TC1")],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
        testCommand: "npx vitest run",
      } },
      env.deps,
    );
    expect(design.ok).toBe(true);
    expect(design.status).toBe("designing");
    expect(loadUnit(unitId).clarifications).toHaveLength(1);

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

    // statusHistory 应包含全 8 步（create → closeout）
    const actions = finalUnit.statusHistory.map((h) => h.action);
    expect(actions).toEqual([
      "create", "design", "design-review",
      "execute", "test", "exec-review", "retrospect", "closeout",
    ]);
  });
});

describe("E2: dispatch 非法跳步 → CwEngineError(illegal_transition)", () => {
  it("create 后直接 execute → CwEngineError(illegal_transition)", () => {
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
    ).toThrow(CwEngineError);

    try {
      dispatch(
        { action: "execute", unitId, input: { commitHash: "abc" } },
        env.deps,
      );
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as CwEngineError;
      expect(err.code).toBe("illegal_transition");
      expect(err.message).toMatch(/execute/);
    }
  });

  it("test 从 created 状态 → CwEngineError(illegal_transition)", () => {
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
    ).toThrow(CwEngineError);
  });

  it("closed 后任何 action → CwEngineError（终态不可逆）", () => {
    // 先跑到 closed（复用 E1 链路的最小版本）
    const unitId = "wave:e2e-terminal";
    const steps: Array<["design" | "design-review" | "execute" | "test" | "exec-review" | "retrospect" | "closeout", unknown]> = [
      ["design", {
        clarifications: [],
        testCases: [makeValidTestCase("TC1")],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
        testCommand: "npx vitest run",
      }],
      ["design-review", { designReviewJudgment: makeValidDesignReviewJudgment() }],
      ["execute", { commitHash: "abc" }],
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
    ).toThrow(CwEngineError);
  });

  it("unit not found → CwEngineError(unit_not_found)", () => {
    // loadWorkUnit 先于 handler 执行，unit 不存在时 input 形态无关（不触达 validateInput）
    const ghostDesign = {
      action: "design", unitId: "wave:ghost", input: { clarifications: [] },
    } as never;
    expect(() => dispatch(ghostDesign, env.deps)).toThrow(CwEngineError);
    try {
      dispatch(ghostDesign, env.deps);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CwEngineError).code).toBe("unit_not_found");
    }
  });
});

describe("E: dispatch gate 失败返回 ok=false（不抛错）", () => {
  it("design-review gate fail（testCases 空）→ ActionResult(ok=false)，status 不变", () => {
    const unitId = "wave:e2e-gate";
    dispatch({ action: "create", input: {
      slug: "e2e-gate", objective: "o", parentUnitId: "slice:s", basedOnParent: [],
    } }, env.deps);
    // design 写空 testCases（design-review 会 fail test-cases-non-empty）
    dispatch({ action: "design", unitId, input: {
      clarifications: [], testCases: [], tasks: [], files: [], contracts: [],
      testCommand: "npx vitest run",
    } }, env.deps);

    const result = dispatch({ action: "design-review", unitId, input: {
      designReviewJudgment: makeValidDesignReviewJudgment(),
    } }, env.deps);

    expect(result.ok).toBe(false);
    expect(result.gateResults).toBeDefined();
    expect(result.gateResults!.some((g) => !g.passed)).toBe(true);
    // status 未推进（仍是 designing）
    expect(loadUnit(unitId).status).toBe("designing");
    // judgment 未写入
    expect(loadUnit(unitId).designReviewJudgment.necessity).toBe("");
  });

  /**
   * M12 验证：wave handler fail 时 appendFailRecord 写入 statusHistory + failureCount 派生。
   *
   * 背景：v1 用 unit.statusHistory（不是 0.x 的 gateHistory）记录 gate fail，appendFailRecord
   * 把 fail 落盘后 deriveFailureCount 才能从 statusHistory 派生连续 fail 次数。
   * 如果 handler 不 appendFailRecord，failureCount 永远为 0、递进提示不工作。
   *
   * 此测试验证 wave design-review fail 路径：连续 2 次 fail → failureCount = 1 / 2，
   * statusHistory 末尾有 gate fail 记录（说明 appendFailRecord 落盘）。
   */
  it("wave design-review 连续 fail → failureCount 累计（1→2）+ statusHistory 落盘", () => {
    const unitId = "wave:m12-failcount";
    dispatch({ action: "create", input: {
      slug: "m12-failcount", objective: "o", parentUnitId: "slice:s", basedOnParent: [],
    } }, env.deps);
    dispatch({ action: "design", unitId, input: {
      clarifications: [], testCases: [], tasks: [], files: [], contracts: [],
      testCommand: "npx vitest run",
    } }, env.deps);

    // 第一次 design-review fail（testCases 空触发 test-cases-non-empty）
    const first = dispatch({ action: "design-review", unitId, input: {
      designReviewJudgment: makeValidDesignReviewJudgment(),
    } }, env.deps);
    expect(first.ok).toBe(false);
    expect(first.failureCount).toBe(1);
    // statusHistory 末尾有 gate fail 记录（验证 appendFailRecord 落盘）
    const historyAfterFirst = loadUnit(unitId).statusHistory;
    const lastAfterFirst = historyAfterFirst[historyAfterFirst.length - 1];
    expect(lastAfterFirst).toBeDefined();
    expect(lastAfterFirst?.note).toMatch(/gate fail/);

    // 第二次同 action fail → failureCount 累计到 2
    const second = dispatch({ action: "design-review", unitId, input: {
      designReviewJudgment: makeValidDesignReviewJudgment(),
    } }, env.deps);
    expect(second.ok).toBe(false);
    expect(second.failureCount).toBe(2);
    // statusHistory 末尾仍是 gate fail（连续两条）
    const historyAfterSecond = loadUnit(unitId).statusHistory;
    const lastAfterSecond = historyAfterSecond[historyAfterSecond.length - 1];
    expect(lastAfterSecond).toBeDefined();
    expect(lastAfterSecond?.note).toMatch(/gate fail/);
  });

  /**
   * design §3.4 验证：跨 wave 文件冲突 gate（dispatch 层）。
   *
   * 场景：同一 parent slice 下的两个兄弟 wave（W1 W2），design.files 都含 path "src/shared.ts"。
   * - W1 先 design-review → 通过（此时无已 design-review 的兄弟，文件冲突 gate pass）
   * - W2 后 design-review → 文件冲突 gate fail（W1 已 design-reviewed，design.files 含 "src/shared.ts"）
   *   → ok=false，status 不变（仍是 designing），judgment 未写入
   */
  it("wave design-review 跨兄弟文件冲突 → ok=false（W1 先过，W2 fail）", () => {
    const parent = "slice:conflict-parent";
    const w1 = "wave:conflict-w1";
    const w2 = "wave:conflict-w2";
    const conflictPath = "src/shared.ts";

    /** 把一个 wave 从 create 推到 designing（design.files 含冲突 path，未 design-review）。 */
    const setupWave = (id: string, slug: string): void => {
      dispatch({ action: "create", input: {
        slug, objective: `obj-${slug}`, parentUnitId: parent, basedOnParent: [],
      } }, env.deps);
      // design 含冲突 path（action="modify"，参与冲突判定）
      dispatch({ action: "design", unitId: id, input: {
        clarifications: [],
        testCases: [makeValidTestCase("TC1")],
        tasks: [makeValidTask("TK1")],
        files: [{ id: "F1", status: "active", path: conflictPath, action: "modify", description: "shared file" }],
        contracts: [makeValidContract("C1")],
        testCommand: "npx vitest run",
      } }, env.deps);
    };

    setupWave(w1, "conflict-w1");
    setupWave(w2, "conflict-w2");

    // W1 先 design-review → 通过（无已 design-review 的兄弟）
    const dr1 = dispatch({ action: "design-review", unitId: w1, input: {
      designReviewJudgment: makeValidDesignReviewJudgment(),
    } }, env.deps);
    expect(dr1.ok).toBe(true);
    expect(dr1.status).toBe("design-reviewed");

    // W2 后 design-review → 跨 wave 文件冲突 gate fail（W1 已 design-reviewed）
    const dr2 = dispatch({ action: "design-review", unitId: w2, input: {
      designReviewJudgment: makeValidDesignReviewJudgment(),
    } }, env.deps);

    expect(dr2.ok).toBe(false);
    expect(dr2.gateResults).toBeDefined();
    // 至少一个 gate fail，且 report 含冲突 path + 兄弟 id
    const failed = dr2.gateResults!.filter((g) => !g.passed);
    expect(failed.length).toBeGreaterThan(0);
    const conflictReport = failed.map((g) => g.report).join("; ");
    expect(conflictReport).toMatch(/跨 wave 文件冲突/);
    expect(conflictReport).toContain(conflictPath);
    expect(conflictReport).toContain(w1);
    // status 未推进（仍是 designing）
    expect(loadUnit(w2).status).toBe("designing");
    // judgment 未写入
    expect(loadUnit(w2).designReviewJudgment.necessity).toBe("");
  });
});

describe("E: dispatch replan 旁路（不改 status）", () => {
  it("design-reviewed 后 replan → status 不变（仍 design-reviewed）+ statusHistory append", () => {
    const unitId = "wave:e2e-replan";
    dispatch({ action: "create", input: {
      slug: "e2e-replan", objective: "o", parentUnitId: "slice:s", basedOnParent: [],
    } }, env.deps);
    dispatch({ action: "design", unitId, input: {
      clarifications: [],
      testCases: [makeValidTestCase("TC1")],
      tasks: [makeValidTask("TK1")],
      files: [makeValidFile("F1")],
      contracts: [makeValidContract("C1")],
      testCommand: "npx vitest run",
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

  it("executing 状态 replan 带 testCommand → plan.testCommand 更新 + status 不变 + statusHistory 追加（§4.6）", () => {
    const unitId = "wave:e2e-replan-testcmd";
    dispatch({ action: "create", input: {
      slug: "e2e-replan-testcmd", objective: "o", parentUnitId: "slice:s", basedOnParent: [],
    } }, env.deps);
    dispatch({ action: "design", unitId, input: {
      clarifications: [],
      testCases: [makeValidTestCase("TC1")],
      tasks: [makeValidTask("TK1")],
      files: [makeValidFile("F1")],
      contracts: [makeValidContract("C1")],
      testCommand: "npx vitest run",
    } }, env.deps);
    dispatch({ action: "design-review", unitId, input: {
      designReviewJudgment: makeValidDesignReviewJudgment(),
    } }, env.deps);
    dispatch({ action: "execute", unitId, input: {
      commitHash: "deadbeef",
    } }, env.deps);
    expect(loadUnit(unitId).status).toBe("executing");
    expect(loadUnit(unitId).plan.testCommand).toBe("npx vitest run");

    const result = dispatch({ action: "replan", unitId, input: {
      abandonedIds: [],
      testCommand: "npx vitest run tests/quota/index.test.ts",
      note: "补 testCommand",
    } }, env.deps);

    expect(result.ok).toBe(true);
    // testCommand 写入 plan
    expect(loadUnit(unitId).plan.testCommand).toBe("npx vitest run tests/quota/index.test.ts");
    // 旁路：status 不变
    expect(result.status).toBe("executing");
    expect(loadUnit(unitId).status).toBe("executing");
    // statusHistory append 了 replan（from=to=executing）
    const last = loadUnit(unitId).statusHistory.at(-1)!;
    expect(last.action).toBe("replan");
    expect(last.from).toBe("executing");
    expect(last.to).toBe("executing");
    expect(last.note).toBe("补 testCommand");
    // 无废弃条目 → TC1 保持 active
    const tc1 = loadUnit(unitId).plan.testCases.find((t) => t.id === "TC1")!;
    expect(tc1.status).toBe("active");
  });
});

describe("E3: execute commitHash 前置校验（#8，W3）", () => {
  /** 推进 wave 到 design-reviewed（合法 design input + 合法 judgment）。 */
  function advanceToDesignReviewed(slug: string): string {
    const unitId = `wave:${slug}`;
    dispatch(
      { action: "create", input: { slug, objective: "o", parentUnitId: "slice:s", basedOnParent: [] } },
      env.deps,
    );
    dispatch(
      { action: "design", unitId, input: {
        clarifications: [],
        testCases: [makeValidTestCase("TC1")],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
        testCommand: "npx vitest run",
      } },
      env.deps,
    );
    dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidDesignReviewJudgment() } },
      env.deps,
    );
    return unitId;
  }

  it("T2.9: 无效 commitHash → 前置失败（CwError），status 停留 design-reviewed（AC-2.5）", () => {
    const unitId = advanceToDesignReviewed("e2e-commitcheck");
    // gitValidator 校验失败（commit 不存在）
    const badDeps = { ...env.deps, gitValidator: { exists: () => false } };

    expect(() =>
      dispatch({ action: "execute", unitId, input: { commitHash: "deadbeef" } }, badDeps),
    ).toThrow(CwError);

    // status 未推进（transition 未发生）+ 产物未写入——不产生 executing 卡死态，可重试
    const unit = loadUnit(unitId);
    expect(unit.status).toBe("design-reviewed");
    expect(unit.evidence.commitHash).toBe("");
    expect(unit.executeResult.commitHash).toBe("");

    // 修复后重试成功（前置校验不阻碍正常路径）
    const retry = dispatch(
      { action: "execute", unitId, input: { commitHash: "deadbeef" } },
      env.deps,
    );
    expect(retry.ok).toBe(true);
    expect(retry.status).toBe("executing");
  });

  it("T2.8: execute 成功后 test gate 仍验 commit 存在（纵深防御保留）", () => {
    const unitId = advanceToDesignReviewed("e2e-depth");
    const exec = dispatch(
      { action: "execute", unitId, input: { commitHash: "abc123" } },
      env.deps,
    );
    expect(exec.ok).toBe(true);
    expect(exec.status).toBe("executing");

    // test 时 git 校验失败 → gate fail（ok=false，不抛错），status 停留 executing
    const badDeps = { ...env.deps, gitValidator: { exists: () => false } };
    const test = dispatch(
      { action: "test", unitId, input: { testJudgment: makeValidTestJudgment() } },
      badDeps,
    );
    expect(test.ok).toBe(false);
    expect(test.gateResults!.some((g) => !g.passed)).toBe(true);
    expect(loadUnit(unitId).status).toBe("executing");
  });
});

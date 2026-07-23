/**
 * v1 wave handler guidance 接入测试（W7）。
 *
 * 验证 11 个 handler 在 ActionResult.nextAction 里正确填充 guidance：
 * - ok=true：正常三段式 guidance 非空（位置 / 下一步 / schema+约束）
 * - ok=false（gate fail）：异常四段式 guidance 非空 + 含「问题」段 + statusHistory 尾部含 fail 记录
 * - closeout：crossLayer 正确计算（有兄弟 → sibling，无兄弟 → ascend）
 * - replan：guidance 含「重走 design-review」提示
 * - abort：guidance 指向流程结束（action=undefined）
 *
 * 通过 dispatch 统一入口跑（连带验证 dispatch 透传 nextAction）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutionUnit } from "../../src/v1/core/workunit.js";
import { dispatch } from "../../src/v1/dispatch.js";
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

/**
 * 把 unit 推到指定 status（用合法 input 走完前置链）。
 *
 * 返回该 unit 的 id。从 created 一路跑到 target——target 决定停在哪步。
 * parentUnitId=null 表示无父单元（孤立起点）。
 */
function advanceTo(
  slug: string,
  target:
    | "created"
    | "clarifying"
    | "planning"
    | "design-reviewed"
    | "executing"
    | "tested"
    | "exec-reviewed"
    | "retrospected",
  parentUnitId: string | null = "slice:parent",
): string {
  const unitId = `wave:${slug}`;
  dispatch(
    {
      action: "create",
      input: {
        slug,
        objective: `obj-${slug}`,
        ...(parentUnitId === null ? {} : { parentUnitId }),
        basedOnParent: [],
      },
    },
    env.deps,
  );
  if (target === "created") return unitId;

  dispatch(
    { action: "clarify", unitId, input: { clarifications: [] } },
    env.deps,
  );
  if (target === "clarifying") return unitId;

  dispatch(
    {
      action: "plan",
      unitId,
      input: {
        testCases: [makeValidTestCase("TC1")],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
      },
    },
    env.deps,
  );
  if (target === "planning") return unitId;

  dispatch(
    {
      action: "design-review",
      unitId,
      input: { designReviewJudgment: makeValidDesignReviewJudgment() },
    },
    env.deps,
  );
  if (target === "design-reviewed") return unitId;

  dispatch(
    {
      action: "execute",
      unitId,
      input: { commitHash: "deadbeef", changedFiles: ["src/x.ts"] },
    },
    env.deps,
  );
  if (target === "executing") return unitId;

  dispatch(
    {
      action: "test",
      unitId,
      input: { testJudgment: makeValidTestJudgment() },
    },
    env.deps,
  );
  if (target === "tested") return unitId;

  dispatch(
    {
      action: "exec-review",
      unitId,
      input: { execReviewJudgment: makeValidExecReviewJudgment() },
    },
    env.deps,
  );
  if (target === "exec-reviewed") return unitId;

  dispatch(
    {
      action: "retrospect",
      unitId,
      input: { retrospectData: makeValidRetrospectData() },
    },
    env.deps,
  );
  return unitId;
}

// ═══════════════════════════════════════════════════════════════
// ok=true：各 handler 正常 guidance 非空 + 结构正确
// ═══════════════════════════════════════════════════════════════

describe("W7: ok=true handler guidance（三段式非空）", () => {
  it("create → nextAction.guidance 非空 + action=clarify + 含位置段", () => {
    const r = dispatch(
      {
        action: "create",
        input: {
          slug: "g-create",
          objective: "o",
          parentUnitId: "slice:p",
          basedOnParent: [],
        },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction).toBeDefined();
    expect(r.nextAction!.guidance).toBeTruthy();
    expect(r.nextAction!.action).toBe("clarify");
    expect(r.nextAction!.guidance).toContain("## 位置");
    expect(r.nextAction!.guidance).toContain("[wave:wave:g-create]");
    expect(r.nextAction!.guidance).toContain("## 下一步");
    expect(r.nextAction!.guidance).toContain("cw clarify --unitId wave:g-create");
  });

  it("clarify → nextAction.guidance 非空 + action=plan + 含 schema 段", () => {
    const unitId = advanceTo("g-clarify", "created");
    const r = dispatch(
      { action: "clarify", unitId, input: { clarifications: [] } },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction!.guidance).toBeTruthy();
    expect(r.nextAction!.action).toBe("plan");
    expect(r.nextAction!.guidance).toContain("## 位置");
    expect(r.nextAction!.guidance).toContain("## input schema + 关键约束");
    expect(r.nextAction!.guidance).toContain("cw plan --unitId wave:g-clarify");
  });

  it("plan → nextAction.guidance 非空 + action=design-review + 含 plan 关键约束", () => {
    const unitId = advanceTo("g-plan", "clarifying");
    const r = dispatch(
      {
        action: "plan",
        unitId,
        input: {
          testCases: [makeValidTestCase("TC1")],
          tasks: [makeValidTask("TK1")],
          files: [makeValidFile("F1")],
          contracts: [makeValidContract("C1")],
        },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction!.action).toBe("design-review");
    expect(r.nextAction!.guidance).toContain("testCases 不能为空");
    expect(r.nextAction!.guidance).toContain("冻结");
    expect(r.nextAction!.guidance).toContain("cw design-review --unitId wave:g-plan");
  });

  it("execute → nextAction.guidance 非空 + action=test", () => {
    const unitId = advanceTo("g-exec", "design-reviewed");
    const r = dispatch(
      { action: "execute", unitId, input: { commitHash: "abc" } },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction!.action).toBe("test");
    expect(r.nextAction!.guidance).toContain("cw test --unitId wave:g-exec");
  });

  it("unitPath 含 layer=wave + unitId + parentUnitId + rootUnitId", () => {
    const r = dispatch(
      {
        action: "create",
        input: {
          slug: "g-path",
          objective: "o",
          parentUnitId: "slice:parent",
          basedOnParent: [],
        },
      },
      env.deps,
    );
    expect(r.nextAction!.unitPath.layer).toBe("wave");
    expect(r.nextAction!.unitPath.unitId).toBe("wave:g-path");
    expect(r.nextAction!.unitPath.parentUnitId).toBe("slice:parent");
    expect(r.nextAction!.unitPath.rootUnitId).toBe("wave:g-path");
  });

  it("无 parent 的 create → unitPath.parentUnitId undefined + prefix 不含「父单元」", () => {
    const r = dispatch(
      {
        action: "create",
        input: { slug: "g-solo", objective: "o", basedOnParent: [] },
      },
      env.deps,
    );
    expect(r.nextAction!.unitPath.parentUnitId).toBeUndefined();
    expect(r.nextAction!.guidance).not.toContain("父单元");
  });
});

// ═══════════════════════════════════════════════════════════════
// ok=false：gate fail 异常 guidance（四段式）+ statusHistory fail 记录
// ═══════════════════════════════════════════════════════════════

describe("W7: ok=false gate fail guidance（四段式 + fail 记录）", () => {
  it("plan 无前置 gate（plan handler 无 gate），用 design-review gate fail 验异常 guidance", () => {
    // plan 本身无 gate。design-review 跑 testCasesNonEmpty gate——空 plan 触发 fail。
    const unitId = advanceTo("g-fail-dr", "planning");
    // plan 已经写过合法 testCases；这里再 plan 空的覆盖 → design-review gate fail
    dispatch(
      {
        action: "plan",
        unitId,
        input: { testCases: [], tasks: [], files: [], contracts: [] },
      },
      env.deps,
    );

    const r = dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidDesignReviewJudgment() },
      },
      env.deps,
    );

    expect(r.ok).toBe(false);
    expect(r.nextAction).toBeDefined();
    expect(r.nextAction!.guidance).toBeTruthy();
    // 四段式含「位置 / 问题 / 怎么修」段
    expect(r.nextAction!.guidance).toContain("## 位置");
    expect(r.nextAction!.guidance).toContain("## 问题");
    expect(r.nextAction!.guidance).toContain("testCases");
    expect(r.nextAction!.guidance).toContain("## 怎么修");
    // action 指向重提同一 action
    expect(r.nextAction!.action).toBe("design-review");
    // failureCount 含本次 fail（首次 = 1）
    expect(r.failureCount).toBe(1);
  });

  it("连续两次 gate fail → failureCount 递增（派生自 statusHistory）", () => {
    const unitId = advanceTo("g-fail-twice", "planning");
    dispatch(
      {
        action: "plan",
        unitId,
        input: { testCases: [], tasks: [], files: [], contracts: [] },
      },
      env.deps,
    );

    // 第 1 次 fail
    const r1 = dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidDesignReviewJudgment() },
      },
      env.deps,
    );
    expect(r1.failureCount).toBe(1);

    // 第 2 次 fail
    const r2 = dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidDesignReviewJudgment() },
      },
      env.deps,
    );
    expect(r2.failureCount).toBe(2);
    // 第 2 次含「递进提示」段（failureCount=2 > 1）
    expect(r2.nextAction!.guidance).toContain("## 递进提示");
    expect(r2.nextAction!.guidance).toContain("cw clarify");
  });

  it("gate fail 后 statusHistory 尾部含 fail 记录（note 含 'gate fail'）", () => {
    const unitId = advanceTo("g-fail-record", "planning");
    dispatch(
      {
        action: "plan",
        unitId,
        input: { testCases: [], tasks: [], files: [], contracts: [] },
      },
      env.deps,
    );

    dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidDesignReviewJudgment() },
      },
      env.deps,
    );

    const tail = loadUnit(unitId).statusHistory.at(-1)!;
    expect(tail.action).toBe("design-review");
    expect(tail.note).toContain("gate fail");
    expect(tail.to).toBe("planning"); // status 未变
  });

  it("gate fail 不改 status（仍是 planning）+ 不写 judgment", () => {
    const unitId = advanceTo("g-fail-nochange", "planning");
    dispatch(
      {
        action: "plan",
        unitId,
        input: { testCases: [], tasks: [], files: [], contracts: [] },
      },
      env.deps,
    );

    dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidDesignReviewJudgment() },
      },
      env.deps,
    );

    expect(loadUnit(unitId).status).toBe("planning");
    expect(loadUnit(unitId).designReviewJudgment.necessity).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════
// closeout：crossLayer 计算正确
// ═══════════════════════════════════════════════════════════════

describe("W7: closeout crossLayer（§7.3 回溯）", () => {
  /** 构造一个指定 status 的 wave record 并 save 到 store（模拟兄弟单元）。 */
  function saveSiblingWave(id: string, status: string, parentUnitId: string): void {
    // 直接 create 一条再改 status（走 create 写入避免手搓 record）。
    dispatch(
      {
        action: "create",
        input: {
          slug: id.replace("wave:", ""),
          objective: `o-${id}`,
          parentUnitId,
          basedOnParent: [],
        },
      },
      env.deps,
    );
    const rec = env.store.load(id)!;
    rec.status = status;
    env.store.save(rec);
  }

  it("closeout 成功 → nextAction.crossLayer 存在（有 parent 时 ascend/sibling）", () => {
    const parent = "slice:cl-parent";
    const unitId = advanceTo("g-closeout", "retrospected", parent);

    const r = dispatch(
      {
        action: "closeout",
        unitId,
        input: {
          summary: "done",
          artifacts: [{ kind: "code", ref: "src/x.ts", note: "main" }],
        },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction).toBeDefined();
    expect(r.nextAction!.crossLayer).toBeDefined();
    // 唯一子单元（自身）closeout 后无兄弟 → ascend 回父
    expect(r.nextAction!.crossLayer!.kind).toBe("ascend");
    expect(r.nextAction!.crossLayer!.targetUnitId).toBe(parent);
    // action=undefined（终态或跨层）
    expect(r.nextAction!.action).toBeUndefined();
  });

  it("closeout 时有未终态兄弟 → crossLayer=sibling 指向该兄弟", () => {
    const parent = "slice:cl-sibling";
    const unitId = advanceTo("g-closeout-a", "retrospected", parent);
    // 另一个兄弟：未终态
    saveSiblingWave("wave:g-closeout-b", "tested", parent);

    const r = dispatch(
      {
        action: "closeout",
        unitId,
        input: {
          summary: "done",
          artifacts: [{ kind: "code", ref: "src/x.ts" }],
        },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction!.crossLayer!.kind).toBe("sibling");
    expect(r.nextAction!.crossLayer!.targetUnitId).toBe("wave:g-closeout-b");
  });

  it("closeout 后无 parent → crossLayer undefined（孤立终点，流程结束）", () => {
    const unitId = advanceTo("g-closeout-solo", "retrospected", null);
    const r = dispatch(
      {
        action: "closeout",
        unitId,
        input: {
          summary: "done",
          artifacts: [{ kind: "code", ref: "src/x.ts" }],
        },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction!.crossLayer).toBeUndefined();
    expect(r.nextAction!.action).toBeUndefined();
  });

  it("closeout drift fail → 异常 guidance + status 不变（仍是 retrospected）", () => {
    const unitId = advanceTo("g-closeout-drift", "retrospected");
    const r = dispatch(
      {
        action: "closeout",
        unitId,
        input: {
          summary: "done",
          // fileExists.exists 默认 true，但空 ref 会 drift
          artifacts: [{ kind: "code", ref: "" }],
        },
      },
      env.deps,
    );
    expect(r.ok).toBe(false);
    expect(r.nextAction).toBeDefined();
    expect(r.nextAction!.guidance).toContain("## 问题");
    expect(r.nextAction!.guidance).toContain("drift");
    expect(r.failureCount).toBe(1);
    expect(loadUnit(unitId).status).toBe("retrospected");
  });
});

// ═══════════════════════════════════════════════════════════════
// replan + abort 特殊 guidance
// ═══════════════════════════════════════════════════════════════

describe("W7: replan guidance（重走 design-review 提示）", () => {
  it("replan ok=true → guidance 含「重新 design-review」+ action=plan", () => {
    const unitId = advanceTo("g-replan", "design-reviewed");
    const r = dispatch(
      {
        action: "replan",
        unitId,
        input: { abandonedIds: ["TC1"], note: "TC1 obsolete" },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction).toBeDefined();
    expect(r.nextAction!.action).toBe("plan");
    // replan 模板的关键约束含「重走 design-review」（§6.1 / wave §8.3）
    expect(r.nextAction!.guidance).toContain("重新 design-review");
    expect(r.nextAction!.guidance).toContain("plan → design-review → execute");
    // replanImpact 仍在
    expect(r.replanImpact).toBeDefined();
  });

  it("replan 后 TC1 标记 abandoned（废弃条目保留，append-only）", () => {
    const unitId = advanceTo("g-replan-abandon", "design-reviewed");
    dispatch(
      {
        action: "replan",
        unitId,
        input: { abandonedIds: ["TC1"], note: "obsolete" },
      },
      env.deps,
    );
    const tc1 = loadUnit(unitId).plan.testCases.find((t) => t.id === "TC1")!;
    expect(tc1.status).toBe("abandoned");
  });
});

describe("W7: abort guidance（流程结束）", () => {
  it("abort ok=true → action=undefined（终态，流程结束）+ guidance 含位置", () => {
    const unitId = advanceTo("g-abort", "planning");
    const r = dispatch(
      { action: "abort", unitId, input: { reason: "wrong layer" } },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.status).toBe("aborted");
    expect(r.nextAction).toBeDefined();
    expect(r.nextAction!.action).toBeUndefined();
    expect(r.nextAction!.guidance).toContain("## 位置");
    expect(r.nextAction!.guidance).toContain("[wave:wave:g-abort]");
    expect(r.nextAction!.guidance).toContain("已结束");
    // 终态无下一步命令
    expect(r.nextAction!.guidance).not.toContain("cw ");
  });
});

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

import type { ExecutionUnit } from "../src/core/workunit.js";
import { dispatch } from "../src/dispatch.js";
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
    | "designing"
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
    {
      action: "design",
      unitId,
      input: {
        testCases: [makeValidTestCase("TC1")],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
        testCommand: "npx vitest run",
        clarifications: [],
      },
    },
    env.deps,
  );
  if (target === "designing") return unitId;

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
      input: { commitHash: "deadbeef" },
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
  it("create → nextAction.guidance 非空 + action=design + 含位置段 + 含 testCommand 提示", () => {
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
    expect(r.nextAction!.action).toBe("design");
    expect(r.nextAction!.guidance).toContain("## 位置");
    expect(r.nextAction!.guidance).toContain("[wave:g-create]");
    expect(r.nextAction!.guidance).toContain("## 下一步");
    expect(r.nextAction!.guidance).toContain("cw design --unitId wave:g-create");
    // create 时追加 testCommand 提示（per-wave testCommand 改造：design 阶段填测试命令）
    expect(r.nextAction!.guidance).toContain("## design 阶段必须填 testCommand");
    expect(r.nextAction!.guidance).toContain("不要跑全量回归");
    // 旧 testRunner config 配置示例已从 hint 移除（cwd 语义由 --testCwd/config.testRunner.cwd 保留，hint 聚焦 testCommand）
    expect(r.nextAction!.guidance).not.toContain("cw.config.json");
    expect(r.nextAction!.guidance).not.toContain("--testCwd");
  });

  it("design → nextAction.guidance 非空 + action=design-review + 含 schema 段", () => {
    const unitId = advanceTo("g-design", "created");
    const r = dispatch(
      {
        action: "design",
        unitId,
        input: {
          testCases: [makeValidTestCase("TC1")],
          tasks: [makeValidTask("TK1")],
          files: [makeValidFile("F1")],
          contracts: [makeValidContract("C1")],
          testCommand: "npx vitest run",
          clarifications: [],
        },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction!.guidance).toBeTruthy();
    expect(r.nextAction!.action).toBe("design-review");
    expect(r.nextAction!.guidance).toContain("## 位置");
    expect(r.nextAction!.guidance).toContain("## input schema + 关键约束");
    expect(r.nextAction!.guidance).toContain("cw design-review --unitId wave:g-design");
  });

  it("design → nextAction.guidance 非空 + action=design-review + 含 design 关键约束", () => {
    const unitId = advanceTo("g-design2", "designing");
    const r = dispatch(
      {
        action: "design",
        unitId,
        input: {
          testCases: [makeValidTestCase("TC1")],
          tasks: [makeValidTask("TK1")],
          files: [makeValidFile("F1")],
          contracts: [makeValidContract("C1")],
          testCommand: "npx vitest run",
          clarifications: [],
        },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction!.action).toBe("design-review");
    expect(r.nextAction!.guidance).toContain("testCases 不能为空");
    expect(r.nextAction!.guidance).toContain("冻结");
    expect(r.nextAction!.guidance).toContain("cw design-review --unitId wave:g-design2");
    // per-wave testCommand 必填约束（WAVE_DESIGN_TEMPLATE 经 buildNextAction 输出）
    expect(r.nextAction!.guidance).toContain("testCommand 必须填");
    expect(r.nextAction!.guidance).toContain("严禁跑全量");
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

  it("design-review 完成 → nextAction=execute + guidance 含 cw execute --commitHash，不含 --input（wave execute 用 commitHash flag）", () => {
    // 守护：wave execute 命令渲染必须用 --commitHash flag，不能拼 --input
    // （CLI src/cli.ts 要求 commitHash；input.json 里没有 commitHash，照 --input 走会立即失败）。
    const unitId = advanceTo("g-exec-cmd", "designing");
    const r = dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidDesignReviewJudgment() },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction!.action).toBe("execute");
    expect(r.nextAction!.guidance).toContain(
      "cw execute --unitId wave:g-exec-cmd --commitHash",
    );
    // execute 命令行不得带 --input（CLI 不读 input.json，commitHash 是 flag）
    expect(r.nextAction!.guidance).not.toContain("--input");
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
// #1 schema 错位修复：guidance 的 schema 段取 nextAction 而非刚完成的 action
// ═══════════════════════════════════════════════════════════════

describe("W8: schema 段取 nextAction（#1）", () => {
  it("create 后 schema 段显示 design 的 testCases 字段，非 create 的 slug/objective（T1.1）", () => {
    const r = dispatch(
      {
        action: "create",
        input: { slug: "s1", objective: "o", basedOnParent: [] },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction!.action).toBe("design");
    expect(r.nextAction!.guidance).toContain("## input schema + 关键约束");
    // design 的 input schema（testCases 等 WavePlan 条目）
    expect(r.nextAction!.guidance).toContain("testCases");
    expect(r.nextAction!.guidance).toContain("testCommand");
    // create 的扁平提示（slug/objective）不得出现在 schema 段
    expect(r.nextAction!.guidance).not.toContain("slug: string");
    expect(r.nextAction!.guidance).not.toContain("objective: string");
  });

  it("replan 后 guidance 含 design 的 schema 段（D-017 透传，T1.1）", () => {
    const unitId = advanceTo("g-replan-schema", "design-reviewed");
    const r = dispatch(
      {
        action: "replan",
        unitId,
        input: { abandonedIds: ["TC1"], note: "obsolete" },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction!.action).toBe("design");
    // replan 后下一步是 design，agent 需要 design 的 input schema
    expect(r.nextAction!.guidance).toContain("## input schema + 关键约束");
    expect(r.nextAction!.guidance).toContain("testCases");
  });

  it("closeout 终态 guidance 无 schema 段（T1.2，终态守卫）", () => {
    const unitId = advanceTo("g-close-schema", "retrospected");
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
    expect(r.nextAction!.action).toBeUndefined();
    expect(r.nextAction!.guidance).not.toContain("## input schema + 关键约束");
  });

  it("design 后 schema 段含 design-review layerSpecific 提示（T1.2b，特判跟随 nextAction）", () => {
    const unitId = advanceTo("g-design-dr", "designing");
    const r = dispatch(
      {
        action: "design",
        unitId,
        input: {
          testCases: [makeValidTestCase("TC1")],
          tasks: [makeValidTask("TK1")],
          files: [makeValidFile("F1")],
          contracts: [makeValidContract("C1")],
          testCommand: "npx vitest run",
        },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction!.action).toBe("design-review");
    // design-review 特判提示（wave 4 key）
    expect(r.nextAction!.guidance).toContain("layerSpecific 建议包含以下 key");
    expect(r.nextAction!.guidance).toContain("testCaseCoverageNote");
  });

  it("abort 终态 guidance 无 schema 段（终态守卫）", () => {
    const unitId = advanceTo("g-abort-schema", "designing");
    const r = dispatch(
      { action: "abort", unitId, input: { reason: "wrong layer" } },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction!.action).toBeUndefined();
    expect(r.nextAction!.guidance).not.toContain("## input schema + 关键约束");
  });
});

// ═══════════════════════════════════════════════════════════════
// ok=false：gate fail 异常 guidance（四段式）+ statusHistory fail 记录
// ═══════════════════════════════════════════════════════════════

describe("W7: ok=false gate fail guidance（四段式 + fail 记录）", () => {
  it("design 无前置 gate（design handler 无 gate），用 design-review gate fail 验异常 guidance", () => {
    // design 本身无 gate。design-review 跑 testCasesNonEmpty gate——空 plan 触发 fail。
    const unitId = advanceTo("g-fail-dr", "designing");
    // design 已经写过合法 testCases；这里再 design 空的覆盖 → design-review gate fail
    dispatch(
      {
        action: "design",
        unitId,
        input: { testCases: [], tasks: [], files: [], contracts: [], testCommand: "npx vitest run" },
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
    const unitId = advanceTo("g-fail-twice", "designing");
    dispatch(
      {
        action: "design",
        unitId,
        input: { testCases: [], tasks: [], files: [], contracts: [], testCommand: "npx vitest run" },
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
    expect(r2.nextAction!.guidance).toContain("cw design");
  });

  it("gate fail 后 statusHistory 尾部含 fail 记录（note 含 'gate fail'）", () => {
    const unitId = advanceTo("g-fail-record", "designing");
    dispatch(
      {
        action: "design",
        unitId,
        input: { testCases: [], tasks: [], files: [], contracts: [], testCommand: "npx vitest run" },
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
    expect(tail.to).toBe("designing"); // status 未变
  });

  it("gate fail 不改 status（仍是 designing）+ 不写 judgment", () => {
    const unitId = advanceTo("g-fail-nochange", "designing");
    dispatch(
      {
        action: "design",
        unitId,
        input: { testCases: [], tasks: [], files: [], contracts: [], testCommand: "npx vitest run" },
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

    expect(loadUnit(unitId).status).toBe("designing");
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

  /**
   * 在 store 里补建一个最小 parent slice record（含 plan.split + evidence.childDelivery），
   * 让 computeCrossLayerAfterCloseout 能查到兄弟（设计文档 §7.6 Direction 2）。
   *
   * splitSlugToChildId 提供 splitSlug → {childUnitId, dependsOn} 映射，自动生成 split + childDelivery。
   * 这样 wave closeout 的 computeCrossLayerAfterCloseout → store.findChildren(parent) 能命中 parent
   * （而非查不到兄弟），正确返回 sibling/ascend 路由。
   */
  function saveParentSlice(
    parentId: string,
    splitSlugToChild: Array<{
      slug: string;
      childUnitId: string;
      dependsOn?: string[];
    }>,
  ): void {
    env.store.save({
      id: parentId,
      scope: "slice",
      status: "executing",
      plan: {
        split: splitSlugToChild.map((c) => ({
          slug: c.slug,
          description: `split ${c.slug}`,
          dependsOn: c.dependsOn ?? [],
          inheritedItemIds: [],
        })),
      },
      evidence: {
        childDelivery: splitSlugToChild.map((c) => ({
          splitSlug: c.slug,
          childUnitId: c.childUnitId,
          childStatus: "pending" as const,
        })),
      },
    });
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

  it("closeout 时有未终态兄弟 → crossLayer=sibling 指向该兄弟（parent 在 store，§7.6 Direction 2）", () => {
    const parent = "slice:cl-sibling";
    const unitId = advanceTo("g-closeout-a", "retrospected", parent);
    // 另一个兄弟：未终态
    saveSiblingWave("wave:g-closeout-b", "tested", parent);
    saveParentSlice(parent, [
      { slug: "g-closeout-a", childUnitId: "wave:g-closeout-a", dependsOn: [] },
      { slug: "g-closeout-b", childUnitId: "wave:g-closeout-b", dependsOn: [] },
    ]);

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
    // 非终态判据（§7.3）：B 未终态 → sibling 指向 B
    expect(r.nextAction!.crossLayer!.kind).toBe("sibling");
    expect(r.nextAction!.crossLayer!.targetUnitId).toBe("wave:g-closeout-b");
  });

  it("closeout 时兄弟非终态但被依赖阻塞 → crossLayer=sibling 指向第一个非终态兄弟（不检查依赖，main 语义）", () => {
    // 回退说明：发散守卫（sibling 但 parallelTargets 空 → 降级 ascend）已随 parallelTargets 删除，
    // 恢复 main 行为——computeCrossLayerAfterCloseout 用非终态判据，不查依赖阻塞。
    // 兄弟 B/C 都非终态且互相 dependsOn（循环）→ 第一个非终态兄弟 B 被选中（死胡同语义回归）。
    const parent = "slice:cl-divergence";
    const unitId = advanceTo("g-divergence-a", "retrospected", parent);
    // 兄弟 B / C：都非终态，互相 dependsOn → 都被阻塞
    saveSiblingWave("wave:g-divergence-b", "tested", parent);
    saveSiblingWave("wave:g-divergence-c", "created", parent);
    saveParentSlice(parent, [
      { slug: "g-divergence-a", childUnitId: "wave:g-divergence-a", dependsOn: [] },
      { slug: "g-divergence-b", childUnitId: "wave:g-divergence-b", dependsOn: ["g-divergence-c"] },
      { slug: "g-divergence-c", childUnitId: "wave:g-divergence-c", dependsOn: ["g-divergence-b"] },
    ]);

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
    // main 行为：sibling 指向第一个非终态兄弟（B），不检查依赖
    expect(r.nextAction!.crossLayer!.kind).toBe("sibling");
    expect(r.nextAction!.crossLayer!.targetUnitId).toBe("wave:g-divergence-b");
  });

  it("wave closeout 正向 sibling：parent 在 store + 无依赖兄弟就绪 → crossLayer=sibling 指向兄弟 B（§7.3）", () => {
    const parent = "slice:cl-positive";
    const unitId = advanceTo("g-positive-a", "retrospected", parent);
    // 兄弟 B：无依赖、非终态（tested）→ 就绪
    saveSiblingWave("wave:g-positive-b", "tested", parent);
    saveParentSlice(parent, [
      { slug: "g-positive-a", childUnitId: "wave:g-positive-a", dependsOn: [] },
      { slug: "g-positive-b", childUnitId: "wave:g-positive-b", dependsOn: [] },
    ]);

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
    // 非终态判据（§7.3）：B 未终态 → sibling 指向 B
    expect(r.nextAction!.crossLayer!.kind).toBe("sibling");
    expect(r.nextAction!.crossLayer!.targetUnitId).toBe("wave:g-positive-b");
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
// #2 create 幂等防护：slug 已存在 → no-op 返回 existing，不覆盖
// ═══════════════════════════════════════════════════════════════

describe("W8: create 幂等防护（#2）", () => {
  it("重复 create 同 slug（tested 态）→ existing unit + idempotent 提示，不覆盖（T1.6）", () => {
    const unitId = advanceTo("g-idem", "tested");
    // 记录原 status，验证不被覆盖
    expect(loadUnit(unitId).status).toBe("tested");

    const r = dispatch(
      {
        action: "create",
        input: { slug: "g-idem", objective: "overwrite attempt", basedOnParent: [] },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.status).toBe("tested");
    expect(r.idempotent).toBe(true);
    // guidance 首行提示「unit 已存在（status=tested），未覆盖」
    expect(r.nextAction!.guidance).toContain("unit 已存在（status=tested），未覆盖");
    // 续行 guidance 是当前步（exec-review），不是 create 的导航
    expect(r.nextAction!.action).toBe("exec-review");
    expect(r.nextAction!.guidance).toContain("cw exec-review --unitId wave:g-idem");
    // store 未被覆盖：status 仍是 tested（不是 created）
    expect(loadUnit(unitId).status).toBe("tested");
  });

  it("重复 create 的 existing 为 aborted 终态 → no-op + guidance 含「重建请用新 slug」（T1.6b，D-015）", () => {
    const unitId = advanceTo("g-idem-abort", "designing");
    dispatch(
      { action: "abort", unitId, input: { reason: "wrong layer" } },
      env.deps,
    );
    expect(loadUnit(unitId).status).toBe("aborted");

    const r = dispatch(
      {
        action: "create",
        input: { slug: "g-idem-abort", objective: "rebuild", basedOnParent: [] },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.status).toBe("aborted");
    expect(r.idempotent).toBe(true);
    expect(r.nextAction!.action).toBeUndefined();
    expect(r.nextAction!.guidance).toContain("unit 已存在（status=aborted）");
    expect(r.nextAction!.guidance).toContain("终态不可续行");
    expect(r.nextAction!.guidance).toContain("重建请用新 slug");
    expect(loadUnit(unitId).status).toBe("aborted");
  });

  it("created 空态重复 create 允许覆盖重建（T1.7，AC-2.4）", () => {
    dispatch(
      { action: "create", input: { slug: "g-idem-empty", objective: "first", basedOnParent: [] } },
      env.deps,
    );
    // created 空态（无 gate fail 记录）→ 允许覆盖
    const r = dispatch(
      {
        action: "create",
        input: { slug: "g-idem-empty", objective: "second", basedOnParent: [] },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.idempotent).toBeUndefined();
    expect(r.status).toBe("created");
    expect(loadUnit("wave:g-idem-empty").objective).toBe("second");
  });

  it("created 但有 gate fail 记录 → no-op（K-4：显式全量扫描）", () => {
    const unitId = "wave:g-idem-fail";
    dispatch(
      { action: "create", input: { slug: "g-idem-fail", objective: "first", basedOnParent: [] } },
      env.deps,
    );
    // 构造 created + fail 记录状态（appendFailRecord 是真实记录通道）
    const unit = loadUnit(unitId);
    unit.statusHistory.push({
      to: "created",
      at: "2026-08-03T00:00:00.000Z",
      action: "design",
      note: "gate fail: simulated",
    });
    env.store.save(unit as unknown as Parameters<typeof env.store.save>[0]);

    const r = dispatch(
      {
        action: "create",
        input: { slug: "g-idem-fail", objective: "second", basedOnParent: [] },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.idempotent).toBe(true);
    expect(r.status).toBe("created");
    expect(r.nextAction!.guidance).toContain("unit 已存在（status=created），未覆盖");
    // 未被覆盖：objective 仍是 first
    expect(loadUnit(unitId).objective).toBe("first");
  });

  it("跨 layer 同 slug 不互扰（wave:auth vs slice:auth，T1.8）", () => {
    dispatch(
      { action: "create", input: { slug: "auth", objective: "wave auth", basedOnParent: [] } },
      env.deps,
    );
    // slice:auth 与 wave:auth 是不同 id，不应触发 wave 的幂等分支
    const r = dispatch(
      {
        action: "create",
        input: { slug: "auth", objective: "slice auth", layer: "slice", basedOnParent: [] },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.idempotent).toBeUndefined();
    expect(r.unitId).toBe("slice:auth");
    expect(r.status).toBe("created");
    expect(loadUnit("wave:auth").objective).toBe("wave auth");
    expect(loadUnit("slice:auth").objective).toBe("slice auth");
  });
});

// ═══════════════════════════════════════════════════════════════
// replan + abort 特殊 guidance
// ═══════════════════════════════════════════════════════════════

describe("W7: replan guidance（重走 design-review 提示）", () => {
  it("replan ok=true → guidance 含「重新 design-review」+ action=design", () => {
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
    expect(r.nextAction!.action).toBe("design");
    // replan 模板的关键约束含「重走 design-review」（§6.1 / wave §8.3）
    expect(r.nextAction!.guidance).toContain("重新 design-review");
    expect(r.nextAction!.guidance).toContain("design → design-review → execute");
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

  it("executing 纯 testCommand 补充 replan → guidance 重定向到 cw test（不含 cw design，§4.6）", () => {
    const unitId = advanceTo("g-replan-testcmd", "executing");
    const r = dispatch(
      {
        action: "replan",
        unitId,
        input: {
          abandonedIds: [],
          testCommand: "npx vitest run tests/quota/index.test.ts",
          note: "补 testCommand",
        },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    // 重定向：executing → test（design 在 executing 状态抛 illegal_transition，恢复路径不可达）
    expect(r.nextAction!.guidance).toContain("cw test --unitId wave:g-replan-testcmd");
    expect(r.nextAction!.guidance).not.toContain("cw design");
    // 机器可读字段与 guidance 同步重定向（action=design 在 executing 状态是 illegal_transition）
    expect(r.nextAction!.action).toBe("test");
  });

  it("design-reviewed 纯 testCommand 补充 replan → nextAction.action=execute（testCommandOnly 重定向）", () => {
    const unitId = advanceTo("g-replan-testcmd-dr", "design-reviewed");
    const r = dispatch(
      {
        action: "replan",
        unitId,
        input: {
          abandonedIds: [],
          testCommand: "npx vitest run tests/quota/index.test.ts",
          note: "补 testCommand",
        },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    // testCommandOnly：design-reviewed 状态映射 action=execute（不推 design，避免无谓重走 design-review）
    expect(r.nextAction!.action).toBe("execute");
    expect(r.nextAction!.guidance).toContain("cw execute --unitId wave:g-replan-testcmd-dr");
  });

  it("executing 内容 replan（含废弃条目）→ guidance 重定向到 cw test + blockedHint 提示回流不可达（不含 cw design）", () => {
    const unitId = advanceTo("g-replan-blocked", "executing");
    const r = dispatch(
      {
        action: "replan",
        unitId,
        input: { abandonedIds: ["TC1"], note: "TC1 obsolete" },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    // 内容 replan @ executing：design.from 不含 executing，推 cw design 必抛 illegal_transition（wave 卡死）
    // → blockedHint 重定向到状态映射 action（executing→test），并显式提示回流不可达
    expect(r.nextAction!.guidance).not.toContain("cw design");
    expect(r.nextAction!.guidance).toContain("无法回流 replan 内容变更");
    expect(r.nextAction!.guidance).toContain("design/design-review 在此状态均 illegal");
    expect(r.nextAction!.guidance).toContain("只能先执行 test 或 abort 终止");
    // blockedHint 替换「重新提交方案 + 命令」段（design 语义不适用，不推非法命令）
    expect(r.nextAction!.guidance).not.toContain("审视完后重新提交方案");
    // 机器可读字段与 guidance 同步重定向（action=design 在 executing 状态是 illegal_transition）
    expect(r.nextAction!.action).toBe("test");
    // 状态感知裁剪：审视引导不含「重新 design 并重新 design-review」句（与 blockedHint 同屏矛盾）
    expect(r.nextAction!.guidance).not.toContain("重新 design 并重新 design-review");
  });

  it("正常 replan（含废弃条目）→ guidance 仍指向 cw design（原行为不变）", () => {
    const unitId = advanceTo("g-replan-normal", "design-reviewed");
    const r = dispatch(
      {
        action: "replan",
        unitId,
        input: { abandonedIds: ["TC1"], note: "TC1 obsolete" },
      },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.nextAction!.guidance).toContain("cw design --unitId wave:g-replan-normal");
  });
});

describe("W7: abort guidance（流程结束）", () => {
  it("abort ok=true → action=undefined（终态，流程结束）+ guidance 含位置", () => {
    const unitId = advanceTo("g-abort", "designing");
    const r = dispatch(
      { action: "abort", unitId, input: { reason: "wrong layer" } },
      env.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.status).toBe("aborted");
    expect(r.nextAction).toBeDefined();
    expect(r.nextAction!.action).toBeUndefined();
    expect(r.nextAction!.guidance).toContain("## 位置");
    expect(r.nextAction!.guidance).toContain("[wave:g-abort]");
    expect(r.nextAction!.guidance).toContain("已结束");
    // 终态无下一步命令
    expect(r.nextAction!.guidance).not.toContain("cw ");
  });
});

describe("W7: test gate fail guidance（testsAllPass 失败时含配置提示）", () => {
  it("testsAllPass 失败 → guidance 含 cw.config.json / --testCwd 提示", () => {
    // 构造 testRunner 返回失败的 deps
    const failEnv = createCwEnv();
    failEnv.deps.testRunner = {
      run: () => ({ passed: false, passedCount: 0, failedCount: 5, failedTests: [] }),
    };
    const unitId = "wave:g-test-fail";
    dispatch(
      {
        action: "create",
        input: { slug: "g-test-fail", objective: "o", parentUnitId: "slice:p", basedOnParent: [] },
      },
      failEnv.deps,
    );
    // 推进到 executing
    dispatch(
      {
        action: "design",
        unitId,
        input: {
          testCases: [makeValidTestCase()],
          tasks: [makeValidTask()],
          files: [makeValidFile()],
          contracts: [makeValidContract()],
          testCommand: "npx vitest run",
          clarifications: [],
        },
      },
      failEnv.deps,
    );
    dispatch(
      { action: "design-review", unitId, input: { designReviewJudgment: makeValidDesignReviewJudgment() } },
      failEnv.deps,
    );
    dispatch(
      { action: "execute", unitId, input: { commitHash: "deadbeef" } },
      failEnv.deps,
    );
    // test action 会因 testRunner 失败而 gate fail
    const r = dispatch(
      { action: "test", unitId, input: { testJudgment: makeValidTestJudgment() } },
      failEnv.deps,
    );
    expect(r.ok).toBe(false);
    expect(r.nextAction).toBeDefined();
    expect(r.nextAction!.guidance).toContain("## 问题");
    expect(r.nextAction!.guidance).toContain("tests-all-pass");
    // 验证配置提示
    expect(r.nextAction!.guidance).toContain("cw.config.json");
    expect(r.nextAction!.guidance).toContain("--testCwd");
    failEnv.cleanup();
  });
});

describe("W2(testCommand): 空 testCommand fail hint 分档（短路优先诊断）", () => {
  it("空 testCommand → guidance 含「plan.testCommand 缺失」根因诊断，而非误导为覆盖不足", () => {
    // 模拟真实 testRunner 守卫：空 testCommand 短路 → passed:false + 0 计数（不 spawn）
    const failEnv = createCwEnv();
    failEnv.deps.testRunner = {
      run: (unit: ExecutionUnit) => {
        const cmd = unit.plan.testCommand?.trim() ?? "";
        return cmd === ""
          ? { passed: false, passedCount: 0, failedCount: 0, failedTests: [] }
          : { passed: false, passedCount: 0, failedCount: 5, failedTests: [] };
      },
    };
    const unitId = "wave:g-test-empty-cmd";
    dispatch(
      {
        action: "create",
        input: { slug: "g-test-empty-cmd", objective: "o", parentUnitId: "slice:p", basedOnParent: [] },
      },
      failEnv.deps,
    );
    // create → designing
    dispatch(
      {
        action: "design",
        unitId,
        input: {
          testCases: [makeValidTestCase()],
          tasks: [makeValidTask()],
          files: [makeValidFile()],
          contracts: [makeValidContract()],
          // 先填合法 testCommand 过 design-review gate（testCommandNonEmpty）；
          // 空 testCommand 的 wave 只能以在途迁移形态存在（下面手工清空模拟存量 wave）。
          testCommand: "npx vitest run",
          clarifications: [],
        },
      },
      failEnv.deps,
    );
    dispatch(
      {
        action: "design-review",
        unitId,
        input: { designReviewJudgment: makeValidDesignReviewJudgment() },
      },
      failEnv.deps,
    );
    dispatch(
      {
        action: "execute",
        unitId,
        input: { commitHash: "deadbeef" },
      },
      failEnv.deps,
    );
    // 模拟存量在途 wave（plan 无 testCommand 字段，加载为 undefined）：执行后手工清空再 test。
    const rec = failEnv.store.load(unitId) as unknown as ExecutionUnit;
    rec.plan.testCommand = "";
    failEnv.store.save(rec as unknown as Parameters<typeof failEnv.store.save>[0]);
    const r = dispatch(
      { action: "test", unitId, input: { testJudgment: makeValidTestJudgment() } },
      failEnv.deps,
    );
    expect(r.ok).toBe(false);
    // 根因诊断优先：空 testCommand 提示（design-reviewed 走 design progressive / executing 走 replan 旁路）
    expect(r.nextAction!.guidance).toContain("plan.testCommand 缺失");
    expect(r.nextAction!.guidance).toContain("replan");
    // 上下文化：双 gate fail 归因到 testCommand 缺失（而非暗示覆盖不足）
    expect(r.nextAction!.guidance).toContain("共同根因");
    // 「0 次执行」gate report 仍机械进 reason，但必须被 hint 上下文化——
    // 根因诊断出现在其后（同一 guidance 内），不误导 agent 去补测试而非补 testCommand。
    const executedZeroIdx = r.nextAction!.guidance.indexOf("只记录了 0 次执行");
    expect(executedZeroIdx).toBeGreaterThanOrEqual(0);
    expect(
      r.nextAction!.guidance.indexOf("plan.testCommand 缺失"),
    ).toBeGreaterThan(executedZeroIdx);
    failEnv.cleanup();
  });
});

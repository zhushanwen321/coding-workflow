/**
 * v1 feature replan — spec 条目 abandoned 标记 + freeze 接入集成测（C2 修复）
 * + addedSpecItems 拆分重建（T9a）+ feature→slice 级联 abort（T9b）。
 *
 * 验证 handleReplanFeature（经 dispatch 完整路径）：
 * - abandonedIds 命中的 FR/AC/UC 条目 status 改 abandoned，未命中仍 active
 * - spec.decisions 不被触碰（投影自 Clarification，不逐项废弃）
 * - 正常 replan 不触发 freeze violation（ok=true，before/after 的 abandoned 条目一致）
 * - replanImpact 正常返回（status 转 planning，nextAction.action=plan）
 * - addedSpecItems：拆分重建（FR1→FR1a+FR1b）+ id 冲突检测
 * - feature→slice 级联 abort：feature replan 废弃 FR → child slice 被级联 aborted
 *
 * 真实 CwStore + tmp 目录 + stub clock。零 mock 框架。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CwEngineError,dispatch } from "../../src/dispatch.js";
import {
  createCwEnv,
  makeFeatureClarifyInput,
  makeFeatureSpec,
  makeValidFeatureDesignReviewJudgment,
  makeValidFeaturePlan,
  makeValidFunctionalRequirement,
} from "./helpers/feature-env.js";
import type { CwEnv } from "./helpers/v1-env.js";

let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
});

afterEach(() => {
  env.cleanup();
});

/**
 * 推进 feature 到 design-reviewed 状态（可 replan），spec 含 FR1+FR2+AC1+UC1（FR2 用于验「未命中仍 active」）。
 */
function setupFeatureWithTwoFRs(slug = "replan-feature"): string {
  const { deps } = env;
  const spec = makeFeatureSpec({
    functionalRequirements: [
      makeValidFunctionalRequirement("FR1"),
      makeValidFunctionalRequirement("FR2"),
    ],
    acceptanceCriteria: [
      { id: "AC1", status: "active", condition: "c1", verification: "review" },
      { id: "AC2", status: "active", condition: "c2", verification: "review" },
    ],
  });
  spec.functionalRequirements[0]!.ac = ["AC1"];
  spec.functionalRequirements[1]!.ac = ["AC2"];
  const unitId = `feature:${slug}`;
  dispatch(
    { action: "create", input: { slug, objective: `obj ${slug}`, layer: "feature" } },
    deps,
  );
  dispatch(
    { action: "clarify", unitId, input: makeFeatureClarifyInput({ spec }) },
    deps,
  );
  dispatch(
    { action: "plan", unitId, input: makeValidFeaturePlan() },
    deps,
  );
  dispatch(
    { action: "design-review", unitId, input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() } },
    deps,
  );
  return unitId;
}

/**
 * 推进 feature 到 executing 状态（有 child slice），spec 含 FR1+FR2+AC1+AC2。
 */
function setupFeatureToExecuting(slug = "exec-feature"): string {
  const { deps } = env;
  const spec = makeFeatureSpec({
    functionalRequirements: [
      makeValidFunctionalRequirement("FR1"),
      makeValidFunctionalRequirement("FR2"),
    ],
    acceptanceCriteria: [
      { id: "AC1", status: "active", condition: "c1", verification: "review" },
      { id: "AC2", status: "active", condition: "c2", verification: "review" },
    ],
  });
  spec.functionalRequirements[0]!.ac = ["AC1"];
  spec.functionalRequirements[1]!.ac = ["AC2"];
  const unitId = `feature:${slug}`;
  dispatch(
    { action: "create", input: { slug, objective: `obj ${slug}`, layer: "feature" } },
    deps,
  );
  dispatch(
    { action: "clarify", unitId, input: makeFeatureClarifyInput({ spec }) },
    deps,
  );
  dispatch(
    { action: "plan", unitId, input: makeValidFeaturePlan() },
    deps,
  );
  dispatch(
    { action: "design-review", unitId, input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() } },
    deps,
  );
  dispatch(
    { action: "execute", unitId, input: {} } as unknown as Parameters<typeof dispatch>[0],
    deps,
  );
  return unitId;
}

// ═══════════════════════════════════════════════════════════════
// C2: feature replan 标 spec 条目 abandoned + freeze 接入
// ═══════════════════════════════════════════════════════════════

describe("C2: feature replan 标 spec 条目 abandoned + checkFreezeFeatureSpec 接入", () => {
  it("abandonedIds 命中 FR1 → FR1.status=abandoned，FR2 仍 active", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();
    const result = dispatch(
      { action: "replan", unitId, input: { abandonedIds: ["FR1"], note: "废弃 FR1" } },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("design-reviewed");
    const record = deps.store.load(unitId)!;
    const spec = (record as unknown as {
      clarifications: { spec: { functionalRequirements: { id: string; status: string }[] } };
    }).clarifications.spec;
    expect(spec.functionalRequirements.find((f) => f.id === "FR1")!.status).toBe("abandoned");
    expect(spec.functionalRequirements.find((f) => f.id === "FR2")!.status).toBe("active");
  });

  it("abandonedIds 命中 AC1 + BC1 → 两类条目均 abandoned", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();
    dispatch(
      { action: "replan", unitId, input: { abandonedIds: ["AC1", "BC1"], note: "废弃 AC+BC" } },
      deps,
    );
    const record = deps.store.load(unitId)!;
    const spec = (record as unknown as {
      clarifications: {
        spec: {
          acceptanceCriteria: { id: string; status: string }[];
          businessCases: { id: string; status: string }[];
        };
      };
    }).clarifications.spec;
    expect(spec.acceptanceCriteria.find((a) => a.id === "AC1")!.status).toBe("abandoned");
    expect(spec.businessCases.find((b) => b.id === "BC1")!.status).toBe("abandoned");
  });

  it("replan 后 spec.decisions 不变（投影自 Clarification，不逐项废弃）", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();
    const beforeRecord = deps.store.load(unitId)!;
    const beforeDecisions = (beforeRecord as unknown as {
      clarifications: { spec: { decisions: unknown[] } };
    }).clarifications.spec.decisions;
    dispatch(
      { action: "replan", unitId, input: { abandonedIds: ["FR1"], note: "x" } },
      deps,
    );
    const afterRecord = deps.store.load(unitId)!;
    const afterDecisions = (afterRecord as unknown as {
      clarifications: { spec: { decisions: unknown[] } };
    }).clarifications.spec.decisions;
    expect(afterDecisions).toEqual(beforeDecisions);
  });

  it("abandonedIds 命中不存在的 id → 静默跳过，ok=true", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();
    const result = dispatch(
      { action: "replan", unitId, input: { abandonedIds: ["NONEXIST"], note: "命中文档不存在的 id" } },
      deps,
    ) as { ok: boolean; status: string };
    expect(result.ok).toBe(true);
    const record = deps.store.load(unitId)!;
    const spec = (record as unknown as {
      clarifications: { spec: { functionalRequirements: { status: string }[] } };
    }).clarifications.spec;
    expect(spec.functionalRequirements.every((f) => f.status === "active")).toBe(true);
  });

  it("正常 replan 不触发 freeze violation", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();
    const result = dispatch(
      { action: "replan", unitId, input: { abandonedIds: ["FR1"], note: "接入验证" } },
      deps,
    ) as { ok: boolean; freezeViolations?: unknown };
    expect(result.ok).toBe(true);
    expect(result.freezeViolations === undefined || (result.freezeViolations as unknown[]).length === 0).toBe(true);
  });

  it("replan 后 nextAction.action=plan", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();
    const result = dispatch(
      { action: "replan", unitId, input: { abandonedIds: ["FR1"], note: "回 planning 重走" } },
      deps,
    ) as { nextAction: { action: string } };
    expect(result.nextAction.action).toBe("plan");
  });
});

// ═══════════════════════════════════════════════════════════════
// T9a: addedSpecItems 拆分重建 + id 冲突检测
// ═══════════════════════════════════════════════════════════════

describe("T9a: feature replan addedSpecItems 拆分重建（§7.4 FR1→FR1a+FR1b）", () => {
  it("FR1 废弃 + addedSpecItems 追加 FR1a/FR1b → spec 含 FR1(abandoned)+FR2(active)+FR1a(active)+FR1b(active)", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();
    const result = dispatch(
      {
        action: "replan",
        unitId,
        input: {
          abandonedIds: ["FR1"],
          addedSpecItems: {
            functionalRequirements: [
              { id: "FR1a", status: "active", title: "拆分需求a", detail: "FR1 拆分出的子需求 a", ac: ["AC1"] },
              { id: "FR1b", status: "active", title: "拆分需求b", detail: "FR1 拆分出的子需求 b", ac: ["AC1"] },
            ],
          },
          note: "FR1 拆成 FR1a+FR1b",
        },
      },
      deps,
    ) as { ok: boolean };
    expect(result.ok).toBe(true);
    const record = deps.store.load(unitId)!;
    const spec = (record as unknown as {
      clarifications: { spec: { functionalRequirements: Array<{ id: string; status: string }> } };
    }).clarifications.spec;
    expect(spec.functionalRequirements.find((f) => f.id === "FR1")!.status).toBe("abandoned");
    expect(spec.functionalRequirements.find((f) => f.id === "FR2")!.status).toBe("active");
    expect(spec.functionalRequirements.find((f) => f.id === "FR1a")).toBeDefined();
    expect(spec.functionalRequirements.find((f) => f.id === "FR1a")!.status).toBe("active");
    expect(spec.functionalRequirements.find((f) => f.id === "FR1b")).toBeDefined();
    expect(spec.functionalRequirements.find((f) => f.id === "FR1b")!.status).toBe("active");
  });

  it("addedSpecItems acceptanceCriteria + businessCases → 正确追加", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();
    const result = dispatch(
      {
        action: "replan",
        unitId,
        input: {
          abandonedIds: [],
          addedSpecItems: {
            acceptanceCriteria: [
              { id: "AC3", status: "active", condition: "新增验收条件", verification: "review" },
            ],
            businessCases: [
              { id: "BC2", status: "active", actor: "管理员", scenario: "管理后台操作", expectedResult: "操作成功" },
            ],
          },
          note: "追加 AC+BC",
        },
      },
      deps,
    ) as { ok: boolean };
    expect(result.ok).toBe(true);
    const record = deps.store.load(unitId)!;
    const spec = (record as unknown as {
      clarifications: {
        spec: {
          acceptanceCriteria: Array<{ id: string; status: string }>;
          businessCases: Array<{ id: string; status: string }>;
        };
      };
    }).clarifications.spec;
    expect(spec.acceptanceCriteria.find((a) => a.id === "AC3")?.status).toBe("active");
    expect(spec.businessCases.find((b) => b.id === "BC2")?.status).toBe("active");
  });

  it("addedSpecItems 传入 status=abandoned → 强制覆盖为 active", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();
    const result = dispatch(
      {
        action: "replan",
        unitId,
        input: {
          abandonedIds: [],
          addedSpecItems: {
            functionalRequirements: [
              { id: "FR99", status: "abandoned" as "active", title: "试探", detail: "试试看 status 会不会被忽略", ac: ["AC1"] },
            ],
          },
          note: "status 覆盖测试",
        },
      },
      deps,
    ) as { ok: boolean };
    expect(result.ok).toBe(true);
    const record = deps.store.load(unitId)!;
    const spec = (record as unknown as {
      clarifications: { spec: { functionalRequirements: Array<{ id: string; status: string }> } };
    }).clarifications.spec;
    expect(spec.functionalRequirements.find((f) => f.id === "FR99")?.status).toBe("active");
  });

  it("addedSpecItems id 冲突（与现有 active FR 重复）→ throw CwEngineError(illegal_argument)", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();
    expect(() =>
      dispatch(
        {
          action: "replan",
          unitId,
          input: {
            abandonedIds: [],
            addedSpecItems: {
              functionalRequirements: [
                { id: "FR1", status: "active", title: "重复的", detail: "id 冲突", ac: ["AC1"] },
              ],
            },
            note: "id 冲突测试",
          },
        },
        deps,
      ),
    ).toThrow(CwEngineError);
    try {
      dispatch(
        {
          action: "replan",
          unitId,
          input: {
            abandonedIds: [],
            addedSpecItems: {
              functionalRequirements: [
                { id: "FR1", status: "active", title: "重复的", detail: "id 冲突", ac: ["AC1"] },
              ],
            },
            note: "id 冲突测试",
          },
        },
        deps,
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CwEngineError).code).toBe("illegal_argument");
      expect((e as CwEngineError).message).toMatch(/FR1/);
    }
  });

  it("addedSpecItems id 冲突（与 abandoned 条目重复）→ throw CwEngineError", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();
    expect(() =>
      dispatch(
        {
          action: "replan",
          unitId,
          input: {
            abandonedIds: ["FR1"],
            addedSpecItems: {
              functionalRequirements: [
                { id: "FR1", status: "active", title: "与废弃条目冲突", detail: "id 冲突", ac: ["AC1"] },
              ],
            },
            note: "abandoned id 也冲突",
          },
        },
        deps,
      ),
    ).toThrow(CwEngineError);
  });

  it("addedSpecItems 跨 FR/AC/UC id 冲突 → throw CwEngineError", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();
    expect(() =>
      dispatch(
        {
          action: "replan",
          unitId,
          input: {
            abandonedIds: [],
            addedSpecItems: {
              functionalRequirements: [
                { id: "AC1", status: "active", title: "与 AC 冲突", detail: "id 跨类型冲突", ac: ["AC1"] },
              ],
            },
            note: "跨类型 id 冲突",
          },
        },
        deps,
      ),
    ).toThrow(CwEngineError);
  });

  it("addedSpecItems 空对象 → 正常废弃，不追加新条目", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();
    const result = dispatch(
      {
        action: "replan",
        unitId,
        input: { abandonedIds: ["FR1"], addedSpecItems: {}, note: "空 addedSpecItems" },
      },
      deps,
    ) as { ok: boolean };
    expect(result.ok).toBe(true);
    const record = deps.store.load(unitId)!;
    const spec = (record as unknown as {
      clarifications: { spec: { functionalRequirements: Array<{ id: string; status: string }> } };
    }).clarifications.spec;
    expect(spec.functionalRequirements.find((f) => f.id === "FR1")?.status).toBe("abandoned");
    expect(spec.functionalRequirements.find((f) => f.id === "FR2")?.status).toBe("active");
    expect(spec.functionalRequirements).toHaveLength(2);
  });

  it("replanImpact 包含 pendingRebuild", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();
    const result = dispatch(
      {
        action: "replan",
        unitId,
        input: {
          abandonedIds: ["FR1"],
          addedSpecItems: {
            functionalRequirements: [
              { id: "FR1a", status: "active", title: "替代", detail: "替代 FR1", ac: ["AC1"] },
            ],
          },
          note: "FR1 拆分重建",
        },
      },
      deps,
    ) as { ok: boolean; replanImpact?: { pendingRebuild: string[] } };
    expect(result.ok).toBe(true);
    expect(result.replanImpact).toBeDefined();
    expect(result.replanImpact!.pendingRebuild).toContain("FR1");
  });
});

// ═══════════════════════════════════════════════════════════════
// T9b: feature→slice 级联 abort
// ═══════════════════════════════════════════════════════════════

describe("T9b: feature replan→slice 级联 abort", () => {
  it("feature replan 废弃 FR1 → child slice status 变 aborted + abandonedRefs 追加", () => {
    const { deps } = env;
    const unitId = setupFeatureToExecuting("cascade-feature");
    const featureRecord = deps.store.load(unitId) as unknown as {
      executeResult: { childUnitIds: string[] };
    };
    const childId = featureRecord.executeResult.childUnitIds[0]!;
    const childBefore = deps.store.load(childId) as unknown as { basedOnParent: string[]; status: string };
    expect(childBefore.basedOnParent).toContain("FR1");
    expect(childBefore.status).toBe("created");

    const result = dispatch(
      { action: "replan", unitId, input: { abandonedIds: ["FR1"], note: "FR1 obsolete, cascade child" } },
      deps,
    ) as { ok: boolean; replanImpact?: { aborted: string[] } };
    expect(result.ok).toBe(true);
    expect(result.replanImpact!.aborted).toContain(childId);

    const childAfter = deps.store.load(childId) as unknown as { status: string; abandonedRefs: Array<{ workUnitItemId: string }> };
    expect(childAfter.status).toBe("aborted");
    expect(childAfter.abandonedRefs.some((r) => r.workUnitItemId === "FR1")).toBe(true);

    const featureAfter = deps.store.load(unitId) as unknown as {
      clarifications: { spec: { functionalRequirements: Array<{ id: string; status: string }> } };
      status: string;
    };
    expect(featureAfter.clarifications.spec.functionalRequirements.find((f) => f.id === "FR1")?.status).toBe("abandoned");
    expect(featureAfter.status).toBe("executing");
  });

  it("feature replan 废弃不存在的 id → aborted 空", () => {
    const { deps } = env;
    const unitId = setupFeatureToExecuting("cascade-empty");
    const result = dispatch(
      { action: "replan", unitId, input: { abandonedIds: ["GHOST_ID"], note: "no hit" } },
      deps,
    ) as { ok: boolean; replanImpact?: { aborted: string[]; pendingRebuild: string[] } };
    expect(result.ok).toBe(true);
    expect(result.replanImpact!.aborted).toEqual([]);
    expect(result.replanImpact!.pendingRebuild).toEqual(["GHOST_ID"]);
  });

  it("feature replan 废弃 AC1 → child slice 同样被级联 abort", () => {
    const { deps } = env;
    const unitId = setupFeatureToExecuting("cascade-ac");
    const featureRecord = deps.store.load(unitId) as unknown as { executeResult: { childUnitIds: string[] } };
    const childId = featureRecord.executeResult.childUnitIds[0]!;
    const result = dispatch(
      { action: "replan", unitId, input: { abandonedIds: ["AC1"], note: "AC1 obsolete" } },
      deps,
    ) as { ok: boolean; replanImpact?: { aborted: string[] } };
    expect(result.ok).toBe(true);
    expect(result.replanImpact!.aborted).toContain(childId);
    const childAfter = deps.store.load(childId) as unknown as { status: string };
    expect(childAfter.status).toBe("aborted");
  });

  it("已 aborted 的 child 不重复处理（幂等）", () => {
    const { deps } = env;
    const unitId = setupFeatureToExecuting("cascade-idempotent");
    const featureRecord = deps.store.load(unitId) as unknown as { executeResult: { childUnitIds: string[] } };
    const childId = featureRecord.executeResult.childUnitIds[0]!;

    dispatch({ action: "replan", unitId, input: { abandonedIds: ["FR1"], note: "first" } }, deps);
    const afterFirst = deps.store.load(childId) as unknown as {
      status: string; abandonedRefs: Array<{ workUnitItemId: string }>; statusHistory: Array<{ action: string }>;
    };
    expect(afterFirst.status).toBe("aborted");
    const refsAfterFirst = afterFirst.abandonedRefs.filter((r) => r.workUnitItemId === "FR1").length;
    const historyAfterFirst = afterFirst.statusHistory.length;

    dispatch({ action: "replan", unitId, input: { abandonedIds: ["FR1"], note: "second" } }, deps);
    const afterSecond = deps.store.load(childId) as unknown as {
      abandonedRefs: Array<{ workUnitItemId: string }>; statusHistory: Array<{ action: string }>;
    };
    expect(afterSecond.abandonedRefs.filter((r) => r.workUnitItemId === "FR1").length).toBe(refsAfterFirst);
    expect(afterSecond.statusHistory.length).toBe(historyAfterFirst);
  });
});

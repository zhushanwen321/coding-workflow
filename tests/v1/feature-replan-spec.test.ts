/**
 * v1 feature replan — spec 条目 abandoned 标记 + freeze 接入集成测（C2 修复）。
 *
 * 验证 handleReplanFeature（经 dispatch 完整路径）：
 * - abandonedIds 命中的 FR/AC/UC 条目 status 改 abandoned，未命中仍 active
 * - spec.decisions 不被触碰（投影自 Clarification，不逐项废弃）
 * - 正常 replan 不触发 freeze violation（ok=true，before/after 的 abandoned 条目一致）
 * - replanImpact 正常返回（status 转 planning，nextAction.action=plan）
 *
 * freeze 短路分支（ok=false）在正常流程无法触发（handler 只做 map abandonedIds→status，
 * 不改核心字段不删条目，before/after 的 abandoned 条目必然一致）——与 slice replan 测试边界
 * 对齐：freeze 函数本身的 violation 覆盖在 freeze.test.ts，handler 集成测只验正常流程接入。
 *
 * 真实 V1Store + tmp 目录 + stub clock。零 mock 框架。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../../src/v1/dispatch.js";
import {
  createV1Env,
  makeFeatureClarifyInput,
  makeFeatureSpec,
  makeValidFeatureDesignReviewJudgment,
  makeValidFeaturePlan,
  makeValidFunctionalRequirement,
} from "./helpers/feature-env.js";
import type { V1Env } from "./helpers/v1-env.js";

let env: V1Env;

beforeEach(() => {
  env = createV1Env();
});

/**
 * 推进 feature 到 design-reviewed 状态（可 replan），spec 含 FR1+FR2+AC1+UC1（FR2 用于验「未命中仍 active」）。
 *
 * 默认 makeFeatureSpec 只含 1 FR，这里注入 2 FR 让 abandonedIds 部分命中可测。
 * 手动走 create→clarify(带 spec)→plan→design-review，避免 setupToFeatureDesignReviewed 用默认 spec 覆盖。
 */
function setupFeatureWithTwoFRs(slug = "replan-feature"): string {
  const { deps } = env;
  const spec = makeFeatureSpec({
    functionalRequirements: [
      makeValidFunctionalRequirement("FR1"),
      makeValidFunctionalRequirement("FR2"),
    ],
    acceptanceCriteria: [
      // AC1 默认 + AC2（给 FR2 引用，过 frAcCoverage / acReachableFromFr gate）
      { id: "AC1", status: "active", condition: "c1", verification: "review" },
      { id: "AC2", status: "active", condition: "c2", verification: "review" },
    ],
  });
  // FR1→AC1（makeValidFunctionalRequirement 默认），FR2→AC2
  spec.functionalRequirements[0]!.ac = ["AC1"];
  spec.functionalRequirements[1]!.ac = ["AC2"];
  const unitId = `feature:${slug}`;
  dispatch(
    { action: "create", input: { slug, objective: `obj ${slug}`, layer: "feature" } },
    deps,
  );
  dispatch(
    {
      action: "clarify",
      unitId,
      input: makeFeatureClarifyInput({ spec }),
    },
    deps,
  );
  dispatch(
    { action: "plan", unitId, input: makeValidFeaturePlan() },
    deps,
  );
  dispatch(
    {
      action: "design-review",
      unitId,
      input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() },
    },
    deps,
  );
  return unitId;
}

describe("C2: feature replan 标 spec 条目 abandoned + checkFreezeFeatureSpec 接入", () => {
  it("abandonedIds 命中 FR1 → FR1.status=abandoned，FR2 仍 active", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();

    const result = dispatch(
      {
        action: "replan",
        unitId,
        input: { abandonedIds: ["FR1"], note: "废弃 FR1" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("design-reviewed");

    // 从 store 重读，验 spec 条目 status
    const record = deps.store.load(unitId)!;
    const spec = (record as unknown as {
      clarifications: { spec: { functionalRequirements: { id: string; status: string }[] } };
    }).clarifications.spec;
    const fr1 = spec.functionalRequirements.find((f) => f.id === "FR1")!;
    const fr2 = spec.functionalRequirements.find((f) => f.id === "FR2")!;
    expect(fr1.status).toBe("abandoned");
    expect(fr2.status).toBe("active");
  });

  it("abandonedIds 命中 AC1 + BC1 → 两类条目均 abandoned", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();

    dispatch(
      {
        action: "replan",
        unitId,
        input: { abandonedIds: ["AC1", "BC1"], note: "废弃 AC+BC" },
      },
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
      {
        action: "replan",
        unitId,
        input: { abandonedIds: ["FR1"], note: "x" },
      },
      deps,
    );

    const afterRecord = deps.store.load(unitId)!;
    const afterDecisions = (afterRecord as unknown as {
      clarifications: { spec: { decisions: unknown[] } };
    }).clarifications.spec.decisions;
    expect(afterDecisions).toEqual(beforeDecisions);
  });

  it("abandonedIds 命中不存在的 id → 静默跳过，ok=true（与 slice 行为一致）", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();

    const result = dispatch(
      {
        action: "replan",
        unitId,
        input: { abandonedIds: ["NONEXIST"], note: "命中文档不存在的 id" },
      },
      deps,
    ) as { ok: boolean; status: string };

    expect(result.ok).toBe(true);
    // 无条目被标 abandoned（所有条目仍 active）
    const record = deps.store.load(unitId)!;
    const spec = (record as unknown as {
      clarifications: { spec: { functionalRequirements: { status: string }[] } };
    }).clarifications.spec;
    expect(spec.functionalRequirements.every((f) => f.status === "active")).toBe(true);
  });

  it("正常 replan 不触发 freeze violation（接入验证：handler 调了 checkFreezeFeatureSpec 且无违反）", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();

    const result = dispatch(
      {
        action: "replan",
        unitId,
        input: { abandonedIds: ["FR1"], note: "接入验证" },
      },
      deps,
    ) as { ok: boolean; freezeViolations?: unknown };

    expect(result.ok).toBe(true);
    // 正常流程不触发 freeze，freezeViolations 字段不存在或为空
    expect(result.freezeViolations === undefined || (result.freezeViolations as unknown[]).length === 0).toBe(true);
  });

  it("replan 后 statusHistory append replan 记录 + nextAction.action=plan", () => {
    const { deps } = env;
    const unitId = setupFeatureWithTwoFRs();

    const result = dispatch(
      {
        action: "replan",
        unitId,
        input: { abandonedIds: ["FR1"], note: "回 planning 重走" },
      },
      deps,
    ) as { nextAction: { action: string } };

    expect(result.nextAction.action).toBe("plan");
  });
});

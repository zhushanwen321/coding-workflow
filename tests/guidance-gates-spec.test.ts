/**
 * C3/C4/C5/C6 四个改动的回归测试。
 *
 * - GTC1（C3）：feature handoff 输出含 FeatureSpec 的 FR/AC（renderDecisionsSection feature 层渲染）
 * - GTC2（C4）：4 层 design-review guidance 含 layerSpecific 字段名（wave/slice/feature/epic 注入点）
 * - GTC3（C5）：subagent-guidance 的 retrospect 从 forbidden → optional
 * - GTC4（C6）：duplicateSplitSlug gate 拦截重复 slug（slice/feature/epic 三 runner）
 * - GTC5（C6）：无重复 slug 时 duplicateSplitSlug gate pass
 *
 * 测法选最直接的：gate 函数是纯函数直接调（传真实 unit record），
 * schema/render/guidance 函数直接调（不绕 dispatch）。
 */
import { describe, expect, it } from "vitest";

import type { FeatureSpec } from "../src/core/clarifications.js";
import type { Epic, Feature, Slice } from "../src/core/workunit.js";
import { createFeature } from "../src/core/workunit.js";
import { buildSubagentGuidance } from "../src/guidance/subagent-guidance.js";
import { buildEpicNextAction } from "../src/handlers/epic/epic-internal.js";
import { buildFeatureNextAction } from "../src/handlers/feature/feature-internal.js";
import { buildNextAction } from "../src/handlers/internal.js";
import { buildSliceNextAction } from "../src/handlers/slice/slice-internal.js";
import { type HandoffStore,renderHandoff } from "../src/readonly/render.js";
import {
  duplicateSplitSlug,
  epicDuplicateSplitSlug,
  featureDuplicateSplitSlug,
} from "../src/rules/gates/design-review.js";
import type { WorkUnitRecord } from "../src/store/schema.js";
import {
  makeEpicUnit,
  makeValidEpicDesignReviewJudgment,
  makeValidEpicPlan,
} from "./helpers/epic-env.js";
import {
  makeFeatureSpec,
  makeFeatureUnit,
  makeValidFeatureDesignReviewJudgment,
  makeValidFeaturePlan,
} from "./helpers/feature-env.js";
import {
  makeSliceUnit,
  makeValidSliceDesignReviewJudgment,
  makeValidSlicePlan,
} from "./helpers/slice-env.js";

/** 把强类型 unit 当 WorkUnitRecord 传（core unit 是 store record 的超集）。 */
function asRecord(unit: unknown): WorkUnitRecord {
  return unit as WorkUnitRecord;
}

/** 空 store stub：scope=self 不触达 store 方法，仅满足签名必传。 */
const emptyStore: HandoffStore = {
  load: () => null,
  findChildren: () => [],
};

/** 构造含 FR1→AC1 的合法 FeatureSpec（满足强引用结构）。 */
function specWithFrAc(): FeatureSpec {
  return makeFeatureSpec({
    functionalRequirements: [
      {
        id: "FR1",
        status: "active",
        title: "用户登录",
        detail: "支持邮箱密码登录",
        ac: ["AC1"],
      },
    ],
    acceptanceCriteria: [
      {
        id: "AC1",
        status: "active",
        condition: "登录成功后跳转首页",
        verification: "review",
      },
    ],
  });
}

// ═══════════════════════════════════════════════════════════════
// GTC1（C3）：feature handoff 输出含 FR/AC
// ═══════════════════════════════════════════════════════════════

describe("GTC1（C3）: feature handoff 输出含 FeatureSpec 的 FR/AC", () => {
  it("feature record 含 spec（FR1+AC1）→ renderHandoff 输出含「功能需求与验收条件」+ FR FR1 + AC AC1", () => {
    const unit = makeFeatureUnit("handoff-fr-ac");
    unit.clarifications.spec = specWithFrAc();

    const out = renderHandoff(asRecord(unit), emptyStore);

    // C3 新增的 feature 层 FR/AC 渲染段标题
    expect(out).toContain("功能需求与验收条件");
    // FR 行：- FR FR1: 用户登录 (验收: AC1)
    expect(out).toContain("FR FR1");
    expect(out).toContain("用户登录");
    expect(out).toContain("验收: AC1");
    // AC 行：- AC AC1: 登录成功后跳转首页
    expect(out).toContain("AC AC1");
    expect(out).toContain("登录成功后跳转首页");
  });

  it("feature 空 spec（无 FR/AC）→ 不输出「功能需求与验收条件」段", () => {
    // createFeature 初始 spec 各数组为空，renderDecisionsSection 应跳过该段
    const unit = createFeature({ slug: "empty-spec", objective: "o" });
    const out = renderHandoff(asRecord(unit), emptyStore);
    expect(out).not.toContain("功能需求与验收条件");
  });

  it("非 feature 层（slice/epic）不渲染 FeatureSpec 段", () => {
    const slice = makeSliceUnit();
    const out = renderHandoff(asRecord(slice), emptyStore);
    expect(out).not.toContain("功能需求与验收条件");
  });
});

// ═══════════════════════════════════════════════════════════════
// GTC2（C4）：4 层 design-review guidance 含 layerSpecific 字段名
// ═══════════════════════════════════════════════════════════════

describe("GTC2（C4）: 4 层 design-review guidance 含 layerSpecific 字段名", () => {
  it("wave design-review 提示（design 后，特判跟随 nextAction）→ guidance 含 wave 4 字段名（建议包含措辞）", () => {
    // #1 后特判跟随 nextAction：design 完成后下一步是 design-review，schema 段才注入 layerSpecific 提示。
    const unit = {
      id: "wave:design-review",
      scope: "wave",
      slug: "design-review",
      status: "designing",
      parentUnitId: "slice:parent",
    } as unknown as Parameters<typeof buildNextAction>[0];
    const { guidance } = buildNextAction(unit, "design");

    expect(guidance).toContain("layerSpecific 建议包含以下 key");
    expect(guidance).toContain("testCaseCoverageNote");
    expect(guidance).toContain("boundaryConditionNote");
    expect(guidance).toContain("mockStrategyNote");
    expect(guidance).toContain("tddRedReadinessNote");
  });

  it("slice design-review 提示（design 后）→ guidance 含 slice 6 字段名（必须包含措辞）", () => {
    const unit = makeSliceUnit();
    const { guidance } = buildSliceNextAction(unit, "design");

    expect(guidance).toContain("layerSpecific 必须包含以下 key");
    expect(guidance).toContain("techChoiceRationale");
    expect(guidance).toContain("interfaceContractNote");
    expect(guidance).toContain("dataModelSoundness");
    expect(guidance).toContain("errorCoverage");
    expect(guidance).toContain("testabilityNote");
    expect(guidance).toContain("crossWaveContractNote");
  });

  it("feature design-review 提示（design 后）→ guidance 含 feature 6 字段名", () => {
    const unit = makeFeatureUnit();
    const { guidance } = buildFeatureNextAction(unit, "design");

    expect(guidance).toContain("layerSpecific 必须包含以下 key");
    expect(guidance).toContain("specMeceNote");
    expect(guidance).toContain("sliceSplitRationale");
    expect(guidance).toContain("acVerifiabilityNote");
    expect(guidance).toContain("consistencyNote");
    expect(guidance).toContain("frAcCoverageNote");
    expect(guidance).toContain("sliceSpecCoverageNote");
  });

  it("epic design-review 提示（design 后）→ guidance 含 epic 5 字段名", () => {
    const unit = makeEpicUnit();
    const { guidance } = buildEpicNextAction(unit, "design");

    expect(guidance).toContain("layerSpecific 必须包含以下 key");
    expect(guidance).toContain("strategicAlignment");
    expect(guidance).toContain("featureSplitRationale");
    expect(guidance).toContain("scopeBoundary");
    expect(guidance).toContain("priorityRationale");
    expect(guidance).toContain("resourceEstimate");
  });

  it("非 design-review next 的 action 不注入 layerSpecific 字段名（确认注入点条件性）", () => {
    const unit = makeSliceUnit();
    // create 后 nextAction=design，不是 design-review → 不注入
    const { guidance } = buildSliceNextAction(unit, "create");
    expect(guidance).not.toContain("layerSpecific 必须包含以下 key");
  });
});

// ═══════════════════════════════════════════════════════════════
// GTC3（C5）：subagent-guidance retrospect 从 forbidden → optional
// ═══════════════════════════════════════════════════════════════

describe("GTC3（C5）: retrospect 委派从 forbidden → optional", () => {
  it("wave retrospect → 按需委派（optional），非 forbidden", () => {
    const g = buildSubagentGuidance("wave", "retrospect");
    // optional 档文案
    expect(g).toContain("【按需委派】");
    expect(g).not.toContain("【不建议委派】");
  });

  it("planning retrospect → 按需委派（optional），非 forbidden", () => {
    const g = buildSubagentGuidance("planning", "retrospect");
    expect(g).toContain("【按需委派】");
    expect(g).not.toContain("【不建议委派】");
  });
});

// ═══════════════════════════════════════════════════════════════
// GTC4（C6）：duplicateSplitSlug gate 拦截重复 slug（三 runner）
// ═══════════════════════════════════════════════════════════════

describe("GTC4（C6）: duplicateSplitSlug gate 拦截重复 slug", () => {
  it("slice：plan.split 含重复 slug w1 → duplicateSplitSlug fail", () => {
    const unit = makeSliceUnit();
    unit.plan = makeValidSlicePlan() as unknown as Slice["plan"];
    unit.plan.split = [
      { slug: "w1", description: "wave 1", dependsOn: [], inheritedItemIds: [] },
      { slug: "w1", description: "wave 1 dup", dependsOn: [], inheritedItemIds: [] },
    ];
    const r = duplicateSplitSlug(unit);
    expect(r.passed).toBe(false);
    expect(r.report).toMatch(/duplicate-split-slug/);
    expect(r.report).toMatch(/w1/);
  });

  it("feature：plan.split 含重复 slug s1 → featureDuplicateSplitSlug fail", () => {
    const unit = makeFeatureUnit();
    unit.plan = makeValidFeaturePlan() as unknown as Feature["plan"];
    unit.plan.split = [
      { slug: "s1", description: "slice 1", dependsOn: [], inheritedItemIds: ["FR1"] },
      { slug: "s1", description: "slice 1 dup", dependsOn: [], inheritedItemIds: [] },
    ];
    const r = featureDuplicateSplitSlug(unit);
    expect(r.passed).toBe(false);
    expect(r.report).toMatch(/duplicate-split-slug/);
    expect(r.report).toMatch(/s1/);
  });

  it("epic：plan.split 含重复 slug f1 → epicDuplicateSplitSlug fail", () => {
    const unit = makeEpicUnit();
    unit.plan = makeValidEpicPlan() as unknown as Epic["plan"];
    unit.plan.split = [
      { slug: "f1", description: "feature 1", dependsOn: [], inheritedItemIds: ["Q1"] },
      { slug: "f1", description: "feature 1 dup", dependsOn: [], inheritedItemIds: [] },
    ];
    const r = epicDuplicateSplitSlug(unit);
    expect(r.passed).toBe(false);
    expect(r.report).toMatch(/duplicate-split-slug/);
    expect(r.report).toMatch(/f1/);
  });

  it("三 runner 聚合注册：runSliceDesignReviewGates / runFeatureDesignReviewGates / runEpicDesignReviewGates 含 duplicate-split-slug gate", async () => {
    // 动态 import 聚合 runner（避免顶部 import 列表过长）
    const { runSliceDesignReviewGates, runFeatureDesignReviewGates, runEpicDesignReviewGates } =
      await import("../src/rules/gates/design-review.js");

    // slice：完整合法 SlicePlan（含 decisions）+ 合法 judgment，再覆盖 split 成重复 slug
    const slice = makeSliceUnit();
    const slicePlan = makeValidSlicePlan();
    slice.plan = {
      split: slicePlan.split,
      techChoices: slicePlan.techChoices,
      interfaces: slicePlan.interfaces,
      dataModels: slicePlan.dataModels,
      errorSpecs: slicePlan.errorSpecs,
      decisions: [],
    };
    slice.designReviewJudgment = makeValidSliceDesignReviewJudgment();
    slice.plan.split = [
      { slug: "w1", description: "a", dependsOn: [], inheritedItemIds: [] },
      { slug: "w1", description: "b", dependsOn: [], inheritedItemIds: [] },
    ];
    const sliceResults = runSliceDesignReviewGates(slice);
    expect(sliceResults.some((r) => /duplicate-split-slug/.test(r.report) && !r.passed)).toBe(true);

    // feature：合法 spec + plan + judgment，覆盖 split 成重复 slug
    const feature = makeFeatureUnit();
    feature.clarifications.spec = makeFeatureSpec();
    feature.plan = makeValidFeaturePlan() as unknown as Feature["plan"];
    feature.designReviewJudgment = makeValidFeatureDesignReviewJudgment();
    feature.plan.split = [
      { slug: "s1", description: "a", dependsOn: [], inheritedItemIds: [] },
      { slug: "s1", description: "b", dependsOn: [], inheritedItemIds: [] },
    ];
    const featureResults = runFeatureDesignReviewGates(feature);
    expect(featureResults.some((r) => /duplicate-split-slug/.test(r.report) && !r.passed)).toBe(true);

    // epic：合法 plan + judgment，覆盖 split 成重复 slug
    const epic = makeEpicUnit();
    epic.plan = makeValidEpicPlan() as unknown as Epic["plan"];
    epic.designReviewJudgment = makeValidEpicDesignReviewJudgment();
    epic.plan.split = [
      { slug: "f1", description: "a", dependsOn: [], inheritedItemIds: [] },
      { slug: "f1", description: "b", dependsOn: [], inheritedItemIds: [] },
    ];
    const epicResults = runEpicDesignReviewGates(epic);
    expect(epicResults.some((r) => /duplicate-split-slug/.test(r.report) && !r.passed)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// GTC5（C6）：无重复 slug 时 gate pass
// ═══════════════════════════════════════════════════════════════

describe("GTC5（C6）: 无重复 slug 时 duplicateSplitSlug gate pass", () => {
  it("slice：split slug 全唯一 → duplicateSplitSlug pass", () => {
    const unit = makeSliceUnit();
    unit.plan = makeValidSlicePlan() as unknown as Slice["plan"];
    unit.plan.split = [
      { slug: "w1", description: "wave 1", dependsOn: [], inheritedItemIds: [] },
      { slug: "w2", description: "wave 2", dependsOn: ["w1"], inheritedItemIds: [] },
    ];
    const r = duplicateSplitSlug(unit);
    expect(r.passed).toBe(true);
  });

  it("feature：split slug 全唯一 → featureDuplicateSplitSlug pass", () => {
    const unit = makeFeatureUnit();
    unit.plan = makeValidFeaturePlan() as unknown as Feature["plan"];
    unit.plan.split = [
      { slug: "s1", description: "slice 1", dependsOn: [], inheritedItemIds: [] },
      { slug: "s2", description: "slice 2", dependsOn: ["s1"], inheritedItemIds: [] },
    ];
    expect(featureDuplicateSplitSlug(unit).passed).toBe(true);
  });

  it("epic：split slug 全唯一 → epicDuplicateSplitSlug pass", () => {
    const unit = makeEpicUnit();
    unit.plan = makeValidEpicPlan() as unknown as Epic["plan"];
    unit.plan.split = [
      { slug: "f1", description: "feature 1", dependsOn: [], inheritedItemIds: [] },
      { slug: "f2", description: "feature 2", dependsOn: ["f1"], inheritedItemIds: [] },
    ];
    expect(epicDuplicateSplitSlug(unit).passed).toBe(true);
  });
});

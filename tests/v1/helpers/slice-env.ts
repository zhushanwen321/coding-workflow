/**
 * slice 测试基建 — slice unit 工厂 + 合法 SlicePlan 产物工厂 + 阶段推进 helper。
 *
 * 复用 v1-env.ts 的 createCwEnv / makeStubDeps（隔离环境 + stub CwDeps）。
 * 本文件只加 slice 专属：makeSliceUnit / 合法 SlicePlan 条目 / 合法 PlanningRetrospectData /
 * 阶段推进 helper（setupToSlicePlanning / setupToSliceDesignReviewed / setupSliceWithClosedWaves）。
 *
 * 零 mock 框架：真实 CwStore + tmp 目录（同 v1-env.ts 约定）。
 */
import type {
  DesignReviewJudgment,
  PlanningRetrospectData,
} from "../../../src/core/judgments.js";
import type {
  SliceDataModel,
  SliceErrorSpec,
  SliceInterface,
  SliceTechChoice,
  Split,
} from "../../../src/core/plan.js";
import type { ExecutionUnit, Slice } from "../../../src/core/workunit.js";
import { createSlice } from "../../../src/core/workunit.js";
import {
  handleClarify,
  handleCloseout,
  handleDesignReview,
  handleExecReview,
  handleExecute,
  handlePlan,
  handleRetrospect,
  handleTest,
} from "../../../src/handlers/index.js";
import { handleClarifySlice } from "../../../src/handlers/slice/clarify.js";
import { handleDesignReviewSlice } from "../../../src/handlers/slice/design-review.js";
import { handleExecuteSlice } from "../../../src/handlers/slice/execute.js";
import { handlePlanSlice } from "../../../src/handlers/slice/plan.js";
import type { CwDeps } from "../../../src/handlers/types.js";
import type { CwStore } from "../../../src/store/cw-store.js";
import type { WorkUnitRecord } from "../../../src/store/schema.js";
import {
  createCwEnv,
  makeStubDeps,
  makeValidContract,
  makeValidDesignReviewJudgment,
  makeValidExecReviewJudgment,
  makeValidFile,
  makeValidRetrospectData,
  makeValidTask,
  makeValidTestCase,
  makeValidTestJudgment,
  STUB_NOW,
} from "./v1-env.js";

export {
  createCwEnv,
  makeStubDeps,
  makeValidContract,
  makeValidDesignReviewJudgment,
  makeValidExecReviewJudgment,
  makeValidFile,
  makeValidRetrospectData,
  makeValidTask,
  makeValidTestCase,
  makeValidTestJudgment,
  STUB_NOW,
};

// ═══════════════════════════════════════════════════════════════
// slice unit 工厂
// ═══════════════════════════════════════════════════════════════

/** 构造一个 slice unit（初始 status=created，空 SlicePlan）。 */
export function makeSliceUnit(slug = "test-slice"): Slice {
  return createSlice({
    slug,
    objective: `objective for ${slug}`,
    createdAt: STUB_NOW,
  });
}

// ═══════════════════════════════════════════════════════════════
// 合法 SlicePlan 条目工厂（构造能过 design-review gate 的条目）
// ═══════════════════════════════════════════════════════════════

/** 合法的 SliceTechChoice（alternatives 非空 + rationale 非空）。 */
export function makeValidTechChoice(id = "TC1"): SliceTechChoice {
  return {
    id,
    status: "active",
    area: "认证库",
    choice: "oauth2-client v3.2",
    alternatives: ["passport-oauth", "自研"],
    rationale: "oauth2-client 文档全、社区活跃，passport-oauth 近一年无维护",
  };
}

/** 合法的 SliceInterface（signature + contract 非空）。 */
export function makeValidInterface(id = "IF1"): SliceInterface {
  return {
    id,
    status: "active",
    name: "exchangeToken",
    signature: "(code: string) => Promise<TokenPair>",
    contract: "输入 code，返回 TokenPair；401 见 ERR1，500 见 ERR2",
  };
}

/** 合法的 SliceDataModel（definition 非空）。 */
export function makeValidDataModel(id = "DM1"): SliceDataModel {
  return {
    id,
    status: "active",
    name: "TokenPair",
    format: "typescript",
    definition: "interface TokenPair { accessToken: string; refreshToken: string; }",
    notes: "accessToken 全局唯一",
  };
}

/** 合法的 SliceErrorSpec（scenario + strategy 非空）。 */
export function makeValidErrorSpec(id = "ERR1"): SliceErrorSpec {
  return {
    id,
    status: "active",
    interfaceId: "IF1",
    scenario: "OAuth 提供商返回 invalid_grant",
    strategy: "返回 401 + 提示重新登录，不重试",
    httpStatus: 401,
    errorCode: "AUTH_INVALID_GRANT",
  };
}

/** 合法的 Split（slug + description + dependsOn）。 */
export function makeValidSplit(slug = "w1"): Split {
  return {
    slug,
    description: `wave ${slug} 实现`,
    dependsOn: [],
    inheritedItemIds: ["IF1", "DM1"],
  };
}

/**
 * 合法的 SlicePlan（过 design-review 的 3 个结构 gate：techChoices/split 非空 + DAG 无环）。
 * 含 1 techChoice + 1 interface + 1 dataModel + 1 errorSpec + 1 split。
 */
export function makeValidSlicePlan(): {
  techChoices: SliceTechChoice[];
  interfaces: SliceInterface[];
  dataModels: SliceDataModel[];
  errorSpecs: SliceErrorSpec[];
  split: Split[];
} {
  return {
    techChoices: [makeValidTechChoice()],
    interfaces: [makeValidInterface()],
    dataModels: [makeValidDataModel()],
    errorSpecs: [makeValidErrorSpec()],
    split: [makeValidSplit("w1")],
  };
}

// ═══════════════════════════════════════════════════════════════
// 合法 judgment / retrospectData 工厂
// ═══════════════════════════════════════════════════════════════

/**
 * 合法的 DesignReviewJudgment（slice 版，过 5 个 judgment gate + layerSpecificNonEmpty）。
 * layerSpecific 6 字段都填。含 TF1/RK1 便于 retrospect 覆盖引用。
 */
export function makeValidSliceDesignReviewJudgment(): DesignReviewJudgment {
  return {
    necessity: "this slice delivers the oauth backend tech solution",
    sufficiency: {
      gaps: [],
      overlaps: [],
      meceNote: "MECE: token exchange + error handling, no overlap",
    },
    alternatives: "considered session-based, rejected for stateless scaling",
    tradeoffs: [
      { id: "TF1", decision: "oauth2-client over passport", reason: "maintained", cost: "less control" },
    ],
    risks: [
      { id: "RK1", item: "provider rate limit", severity: "medium", mitigation: "retry with backoff" },
    ],
    layerSpecific: {
      techChoiceRationale: "oauth2-client selected with clear alternatives comparison",
      interfaceContractNote: "IF1 signature concrete, contract covers input/output/error/side-effect",
      dataModelSoundness: "DM1 TokenPair fields consistent, no conflict",
      errorCoverage: "ERR1 covers IF1 invalid_grant path",
      testabilityNote: "OAuth provider mockable via DI, no real network in tests",
      crossWaveContractNote: "single wave w1 consumes IF1+DM1, no cross-wave drift",
       
      // slice 约定运行时为 SliceDesignReviewLayerSpecific（6 字段），cast 后写入。
    } as unknown as DesignReviewJudgment["layerSpecific"],
  };
}

/**
 * 合法的 PlanningRetrospectData（过 slice retrospect 6 gate）。
 * reviewedItems 覆盖 necessity/sufficiency/alternatives/TF1/RK1。
 * splitFulfillment 覆盖 makeValidSlicePlan 的 split slug "w1"。
 * childUnitIdsEvidence 覆盖 executeResult.childUnitIds。
 *
 * 可选参数：
 * - childUnitIds：传则按真实 childUnitIds 构造 childUnitIdsEvidence（advance helper 推进
 *   完 child wave 后从 store 读真实 id 传入）；不传用默认 "wave:test-slice::w1"（gate 单元测试基线）
 * - splitSlugs：传则按真实 plan.split slug 构造 splitFulfillment；不传用默认 "w1"
 */
export function makeValidPlanningRetrospectData(
  childUnitIds?: string[],
  splitSlugs?: string[],
): PlanningRetrospectData {
  const ids = childUnitIds ?? ["wave:test-slice::w1"];
  const slugs = splitSlugs ?? ["w1"];
  return {
    reviewedItems: [
      { itemId: "necessity", outcome: "fulfilled" },
      { itemId: "sufficiency", outcome: "fulfilled" },
      { itemId: "alternatives", outcome: "fulfilled" },
      { itemId: "TF1", outcome: "fulfilled" },
      { itemId: "RK1", outcome: "fulfilled", note: "risk mitigated via backoff" },
    ],
    lessonsLearned: "slice tech plan gave wave clear contract, minimal rework",
    deliveryVerdict: "delivered",
    childUnitIdsEvidence: ids.map((id) => ({ childId: id, status: "closed" as const })),
    splitFulfillment: slugs.map((slug) => ({ splitSlug: slug, verdict: "delivered" as const })),
  };
}

/**
 * 从 store 读 unit 的真实 childUnitIds + plan.split slugs，构造过全部 gate 的 PlanningRetrospectData。
 *
 * advance helper / e2e / state-machine 测试做 retrospect 前用这个，避免 childUnitIdsEvidence
 * 与动态生成的 childUnitId 不匹配导致 childUnitEvidenceComplete gate fail。
 */
export function makeRetrospectDataFromStore(
  deps: CwDeps,
  unitId: string,
): PlanningRetrospectData {
  const record = deps.store.load(unitId) as unknown as {
    executeResult: { childUnitIds: string[] };
    plan: { split: { slug: string }[] };
  };
  return makeValidPlanningRetrospectData(
    record.executeResult.childUnitIds,
    record.plan.split.map((s) => s.slug),
  );
}

// ═══════════════════════════════════════════════════════════════
// 阶段推进 helper（构造停在某个阶段的 slice，e2e/rollup 测试复用）
// ═══════════════════════════════════════════════════════════════

/**
 * 推进 slice 到 planning 状态（create → clarify → plan）。
 * 返回的 slice 已写入合法 SlicePlan，status=planning。
 *
 * @param deps stub CwDeps（store 注入）
 * @param slug slice slug（默认 test-slice）
 */
export function setupToSlicePlanning(deps: CwDeps, slug = "test-slice"): Slice {
  // create（直接调 handler，不经 dispatch——单元测试聚焦 handler 逻辑）
  const created = createSlice({ slug, objective: `obj ${slug}`, createdAt: STUB_NOW });
   
  deps.store.save(created as unknown as WorkUnitRecord);

  // clarify（append 一条 Clarification）
  handleClarifySlice(
    created,
    { clarifications: [{ id: "Q1", status: "active", question: "token 存哪", resolution: "httpOnly cookie", type: "grilling" }] },
    deps,
  );

  // plan（写合法 SlicePlan）
  const planInput = makeValidSlicePlan();
  handlePlanSlice(created, planInput, deps);

  return created;
}

/**
 * 推进 slice 到 design-reviewed 状态（+ design-review 过 gate）。
 * 返回的 slice status=design-reviewed，可直接 execute。
 */
export function setupToSliceDesignReviewed(deps: CwDeps, slug = "test-slice"): Slice {
  const slice = setupToSlicePlanning(deps, slug);
  handleDesignReviewSlice(slice, { designReviewJudgment: makeValidSliceDesignReviewJudgment() }, deps);
  return slice;
}

/**
 * 推进 slice 到 executing + 所有 child wave 到 closed（模拟 slice 可 retrospect 的完整场景）。
 *
 * 流程：setupToSliceDesignReviewed → execute（创建 child wave）→ 逐个 child wave 走完 wave 9 步到 closed。
 * 返回 { slice, childWaveIds }。
 *
 * child wave 推进复用 wave handler（createWave 已在 execute 时创建并 save，这里 load 后逐阶段推进）。
 * child wave 的 WavePlan 用最小合法形态（1 testCase + 1 task + 1 file，过 design-review gate）。
 *
 * @param deps stub CwDeps（testRunner stub 返回 passed=true）
 * @param slug slice slug
 */
export function setupSliceWithClosedWaves(
  deps: CwDeps,
  slug = "test-slice",
): { slice: Slice; childWaveIds: string[] } {
  const slice = setupToSliceDesignReviewed(deps, slug);
  handleExecuteSlice(slice, deps);

  // 每个 child wave 推进到 closed
  const childWaveIds: string[] = [];
  for (const childId of slice.executeResult.childUnitIds) {
    advanceWaveToClosed(deps, childId);
    childWaveIds.push(childId);
  }

  // child wave closeout 时已 rollup 到 slice.childDelivery（wave closeout handler 接入了 rollup）
  // 重新 load slice 拿最新状态
  const reloaded = deps.store.load(slice.id);
  return {
     
    slice: reloaded as unknown as Slice,
    childWaveIds,
  };
}

/**
 * 把一个 wave 推进到 closed（走完 wave 9 步：plan → design-review → execute → test → exec-review → retrospect → closeout）。
 *
 * wave 在 slice execute 时由 createWave 创建（空 WavePlan），这里先写合法 WavePlan 再逐阶段推进。
 * 用 wave handler（不经 dispatch，聚焦 wave 推进逻辑）。
 *
 * 已 export：e2e/rollup 测试需要单独推进某个 child wave（如只 abort 不 closeout 的场景）。
 */
export function advanceWaveToClosed(deps: CwDeps, waveId: string): void {
   
  const wave = deps.store.load(waveId) as unknown as ExecutionUnit;
  if (!wave) throw new Error(`wave not found: ${waveId}`);

  // plan（wave createWave 时 status=created，先 clarify 再 plan；这里合并 clarify+plan）
  handleClarify(wave, { clarifications: [] }, deps);
  handlePlan(
    wave,
    {
      testCases: [makeValidTestCase()],
      tasks: [makeValidTask()],
      files: [makeValidFile()],
      contracts: [makeValidContract()],
    },
    deps,
  );

  // design-review
  handleDesignReview(wave, { designReviewJudgment: makeValidDesignReviewJudgment() }, deps);

  // execute
  handleExecute(wave, { commitHash: "abc123" }, deps);

  // test
  handleTest(wave, { testJudgment: makeValidTestJudgment() }, deps);

  // exec-review
  handleExecReview(wave, { execReviewJudgment: makeValidExecReviewJudgment() }, deps);

  // retrospect
  handleRetrospect(wave, { retrospectData: makeValidRetrospectData() }, deps);

  // closeout（artifacts 用空数组——fileExists stub 始终 true，空 artifacts 也过 drift gate）
  handleCloseout(wave, { artifacts: [] }, deps);
}

// CwStore 类型重导出（部分测试需要直接操作 store）
export type { CwStore };

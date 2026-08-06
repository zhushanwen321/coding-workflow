/**
 * recursive 编排模式测试（S-2）——锁住 G5 净新增行为分支。
 *
 * 背景：orchestration:"recursive"（cw.config.json，缺省 serial）改变 planning execute /
 * closeout 的 nextAction.crossLayer 与 guidance 输出。此前 tests/ 对 `orchestration:"recursive"`
 * 零覆盖，仅 serial 路径被测。本文件补齐 4 类断言：
 *
 * 1. crossLayer 抑制（execute 三层 slice/feature/epic）：recursive 不返回 crossLayer.descend
 * 2. crossLayer 抑制（closeout 四层 wave/slice/feature/epic）：recursive 不返回 sibling/ascend
 * 3. guidance 派发段（recursive 追加【派发】，MF-1 修复后按 child 层派对 agent + task）：
 *    - slice execute（child=wave）→ wave-agent + wave 全流程（含 test/exec-review）
 *    - feature execute（child=slice）→ planning-agent + planning 流程（不含 test/exec-review）
 *    - epic execute（child=feature）→ planning-agent + planning 流程（不含 test/exec-review）
 * 4. serial 默认不变（向后兼容）：execute 下沉第一个 child（descend 存在）+ guidance 不含【派发】
 *
 * 零 mock 框架：真实 CwStore + tmp 目录（createCwEnv），dispatch 走真实路径，stub CwDeps
 * 经 env.deps.orchestration 切换 serial/recursive。复用 tests/helpers 合法产物工厂 + 阶段推进 helper。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutionUnit } from "../src/core/workunit.js";
import { dispatch } from "../src/dispatch.js";
import {
  handleDesign,
  handleDesignReview,
  handleExecReview,
  handleExecute,
  handleRetrospect,
  handleTest,
} from "../src/handlers/index.js";
import type { CwDeps } from "../src/handlers/types.js";
import type { CwEnv } from "./helpers/env.js";
import {
  makeEpicRetrospectDataFromStore,
  setupEpicWithClosedFeatures,
  setupToEpicDesignReviewed,
} from "./helpers/epic-env.js";
import {
  advanceChildSlicesToClosed,
  makeFeatureDesignInput,
  makeFeatureRetrospectDataFromStore,
  makeValidFeatureDesignReviewJudgment,
  setupToFeatureDesignReviewed,
} from "./helpers/feature-env.js";
import {
  advanceWaveToClosed,
  createCwEnv,
  makeRetrospectDataFromStore,
  makeValidContract,
  makeValidDesignReviewJudgment,
  makeValidExecReviewJudgment,
  makeValidFile,
  makeValidRetrospectData,
  makeValidSliceDesignReviewJudgment,
  makeValidSlicePlan,
  makeValidTask,
  makeValidTestCase,
  makeValidTestJudgment,
  setupToSliceDesignReviewed,
} from "./helpers/slice-env.js";

// ═══════════════════════════════════════════════════════════════
// 共享 helper
// ═══════════════════════════════════════════════════════════════

/** dispatch 参数类型（execute 三层都不接收 input，handler 忽略 params.input）。 */
type DispatchParams = Parameters<typeof dispatch>[0];

/** 构造 planning execute 的 dispatch 参数（slice/feature/epic 共用，input 被忽略）。 */
function executeParams(unitId: string): DispatchParams {
  return { action: "execute", unitId, input: {} } as unknown as DispatchParams;
}

/**
 * 从 guidance 文本中提取【派发】行（recursive 模式 buildSubagentGuidance 追加）。
 * 找不到返回空串（调用方据此断言是否存在）。
 */
function findDispatchSegment(guidance: string): string {
  return guidance.split("\n").find((line) => line.startsWith("【派发】")) ?? "";
}

/**
 * 把一个 wave 推进到 retrospected（advanceWaveToClosed 去掉末尾 closeout 的版本）。
 *
 * 用于 wave closeout 测试：wave 需停在 retrospected，再单独 dispatch closeout 观察其 crossLayer。
 * 复用 env.ts 的 wave 合法产物工厂（design/design-review/execute/test/exec-review/retrospect）。
 */
function advanceWaveToRetrospected(deps: CwDeps, waveId: string): void {
  const wave = deps.store.load(waveId) as unknown as ExecutionUnit | null;
  if (wave === null) throw new Error(`wave not found: ${waveId}`);

  handleDesign(
    wave,
    {
      testCases: [makeValidTestCase()],
      tasks: [makeValidTask()],
      files: [makeValidFile()],
      contracts: [makeValidContract()],
      testCommand: "npx vitest run",
      clarifications: [],
    },
    deps,
  );
  handleDesignReview(wave, { designReviewJudgment: makeValidDesignReviewJudgment() }, deps);
  handleExecute(wave, { commitHash: "abc123" }, deps);
  handleTest(wave, { testJudgment: makeValidTestJudgment() }, deps);
  handleExecReview(wave, { execReviewJudgment: makeValidExecReviewJudgment() }, deps);
  handleRetrospect(wave, { retrospectData: makeValidRetrospectData() }, deps);
}

/**
 * 构造一个有 parent 的 slice 并推进到 executing（child wave 已创建）。
 *
 * closeout 抑制测试需要 parentUnitId：serial 模式下 closeout 会产生 crossLayer.ascend，
 * recursive 抑制为 undefined——有 parent 才能区分两种模式（无 parent 两者都 undefined）。
 *
 * @returns slice unit id（status=executing，child wave 已创建）
 */
function setupSliceExecutingWithParent(
  deps: CwDeps,
  slug: string,
  parentUnitId: string,
): string {
  const unitId = `slice:${slug}`;
  dispatch(
    {
      action: "create",
      input: { slug, objective: `obj ${slug}`, layer: "slice", parentUnitId },
    },
    deps,
  );
  dispatch({ action: "design", unitId, input: makeValidSlicePlan() }, deps);
  dispatch(
    { action: "design-review", unitId, input: { designReviewJudgment: makeValidSliceDesignReviewJudgment() } },
    deps,
  );
  dispatch(executeParams(unitId), deps);
  return unitId;
}

/**
 * 构造一个有 parent 的 feature 并推进到 executing（child slice 已创建）。
 *
 * @returns feature unit id（status=executing，child slice 已创建）
 */
function setupFeatureExecutingWithParent(
  deps: CwDeps,
  slug: string,
  parentUnitId: string,
): string {
  const unitId = `feature:${slug}`;
  dispatch(
    {
      action: "create",
      input: { slug, objective: `obj ${slug}`, layer: "feature", parentUnitId },
    },
    deps,
  );
  dispatch({ action: "design", unitId, input: makeFeatureDesignInput() }, deps);
  dispatch(
    { action: "design-review", unitId, input: { designReviewJudgment: makeValidFeatureDesignReviewJudgment() } },
    deps,
  );
  dispatch(executeParams(unitId), deps);
  return unitId;
}

// ═══════════════════════════════════════════════════════════════
// TC1 + TC3：recursive execute —— crossLayer 抑制 + 派发段按 child 层
// ═══════════════════════════════════════════════════════════════

describe("recursive execute：crossLayer 抑制 + 派发段按 child 层", () => {
  let env: CwEnv;

  beforeEach(() => {
    env = createCwEnv();
    // 切到 recursive（cw.config.json orchestration 字段语义）
    env.deps.orchestration = "recursive";
  });

  afterEach(() => {
    env.cleanup();
  });

  it("slice execute（child=wave）：crossLayer 抑制 + 派 wave-agent + wave 全流程含 test/exec-review", () => {
    const slice = setupToSliceDesignReviewed(env.deps, "rec-ex-slice");
    const exec = dispatch(executeParams(slice.id), env.deps);

    // TC1：crossLayer 抑制（serial 会 descend 到第一个 child wave）
    expect(exec.ok).toBe(true);
    expect(exec.nextAction?.crossLayer).toBeUndefined();

    // TC3：派发段——按 child 层（wave）派 wave-agent，task 含 wave 全流程（test/exec-review）
    const guidance = exec.nextAction?.guidance ?? "";
    const dispatchLine = findDispatchSegment(guidance);
    expect(dispatchLine).not.toBe(""); // recursive execute 必有【派发】段
    expect(dispatchLine).toContain("派 wave-agent");
    // wave 全流程：execute → test → exec-review → retrospect → closeout
    expect(dispatchLine).toContain("execute → test → exec-review");
  });

  it("feature execute（child=slice）：crossLayer 抑制 + 派 planning-agent + planning 流程不含 test/exec-review", () => {
    const featureId = setupToFeatureDesignReviewed(env.deps, "rec-ex-feature");
    const exec = dispatch(executeParams(featureId), env.deps);

    expect(exec.ok).toBe(true);
    expect(exec.nextAction?.crossLayer).toBeUndefined();

    const guidance = exec.nextAction?.guidance ?? "";
    const dispatchLine = findDispatchSegment(guidance);
    expect(dispatchLine).not.toBe("");
    expect(dispatchLine).toContain("派 planning-agent");
    // planning 流程：design → design-review → execute → retrospect → closeout（无 test/exec-review）
    expect(dispatchLine).toContain("execute → retrospect → closeout");
    expect(dispatchLine).not.toContain("exec-review");
    expect(dispatchLine).not.toContain("→ test →");
  });

  it("epic execute（child=feature）：crossLayer 抑制 + 派 planning-agent + planning 流程不含 test/exec-review", () => {
    const epicId = setupToEpicDesignReviewed(env.deps, "rec-ex-epic");
    const exec = dispatch(executeParams(epicId), env.deps);

    expect(exec.ok).toBe(true);
    expect(exec.nextAction?.crossLayer).toBeUndefined();

    const guidance = exec.nextAction?.guidance ?? "";
    const dispatchLine = findDispatchSegment(guidance);
    expect(dispatchLine).not.toBe("");
    expect(dispatchLine).toContain("派 planning-agent");
    expect(dispatchLine).toContain("execute → retrospect → closeout");
    expect(dispatchLine).not.toContain("exec-review");
    expect(dispatchLine).not.toContain("→ test →");
  });
});

// ═══════════════════════════════════════════════════════════════
// TC2：recursive closeout —— crossLayer 抑制（四层）
// ═══════════════════════════════════════════════════════════════

describe("recursive closeout：crossLayer 抑制（wave/slice/feature/epic 四层）", () => {
  let env: CwEnv;

  beforeEach(() => {
    env = createCwEnv();
    env.deps.orchestration = "recursive";
  });

  afterEach(() => {
    env.cleanup();
  });

  it("wave closeout（有 parent）：不返回 crossLayer.sibling/ascend", () => {
    // wave 作为 slice 的 child（自然带 parentUnitId），推进到 retrospected 后 closeout
    const slice = setupToSliceDesignReviewed(env.deps, "rec-co-wave-parent");
    const exec = dispatch(executeParams(slice.id), env.deps);
    const waveId = (exec.children ?? [])[0]?.unitId;
    if (waveId === undefined) throw new Error("slice execute 未创建 child wave");

    advanceWaveToRetrospected(env.deps, waveId);
    const co = dispatch(
      { action: "closeout", unitId: waveId, input: { artifacts: [] } },
      env.deps,
    );

    expect(co.ok).toBe(true);
    // recursive 抑制——serial 下该 wave closeout 会产生 sibling/ascend（见 serial describe 对比）
    expect(co.nextAction?.crossLayer).toBeUndefined();
  });

  it("slice closeout（有 parent）：不返回 crossLayer.ascend", () => {
    const unitId = setupSliceExecutingWithParent(env.deps, "rec-co-slice", "feature:fake-parent");
    // 推进 child wave 到 closed，使 slice 可 retrospect（helper 已 execute，从 store 读 childUnitIds）
    const record = env.deps.store.load(unitId) as unknown as {
      executeResult: { childUnitIds: string[] };
    };
    for (const childId of record.executeResult.childUnitIds) {
      advanceWaveToClosed(env.deps, childId);
    }
    dispatch(
      { action: "retrospect", unitId, input: { retrospectData: makeRetrospectDataFromStore(env.deps, unitId) } },
      env.deps,
    );

    const co = dispatch({ action: "closeout", unitId, input: { artifacts: [] } }, env.deps);

    expect(co.ok).toBe(true);
    // recursive 抑制——serial 下有 parent 的 slice closeout 会 ascend 到 parent
    expect(co.nextAction?.crossLayer).toBeUndefined();
  });

  it("feature closeout（有 parent）：不返回 crossLayer.ascend", () => {
    const unitId = setupFeatureExecutingWithParent(env.deps, "rec-co-feature", "epic:fake-parent");
    // 推进 child slice（及其 child wave）到 closed，使 feature 可 retrospect
    advanceChildSlicesToClosed(env.deps, unitId);
    dispatch(
      { action: "retrospect", unitId, input: { retrospectData: makeFeatureRetrospectDataFromStore(env.deps, unitId) } },
      env.deps,
    );

    const co = dispatch({ action: "closeout", unitId, input: { artifacts: [] } }, env.deps);

    expect(co.ok).toBe(true);
    expect(co.nextAction?.crossLayer).toBeUndefined();
  });

  it("epic closeout（顶层无 parent）：crossLayer 仍 undefined（recursive 不新增）", () => {
    // epic 是顶层无父层（createEpic 不写 parentUnitId），serial 下 closeout 也是 undefined（孤立终点）。
    // 本测试锁住：recursive 不会为 epic closeout 新增任何 crossLayer（防止未来回归）。
    const epicId = setupEpicWithClosedFeatures(env.deps, "rec-co-epic");
    dispatch(
      { action: "retrospect", unitId: epicId, input: { retrospectData: makeEpicRetrospectDataFromStore(env.deps, epicId) } },
      env.deps,
    );

    const co = dispatch({ action: "closeout", unitId: epicId, input: { artifacts: [] } }, env.deps);

    expect(co.ok).toBe(true);
    expect(co.nextAction?.crossLayer).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// TC4：serial 默认不变（向后兼容）
// ═══════════════════════════════════════════════════════════════

describe("serial 默认不变（orchestration 缺省，向后兼容）", () => {
  let env: CwEnv;

  beforeEach(() => {
    env = createCwEnv();
    // orchestration 不设（缺省 serial），与存量测试的 stub deps 完全一致
  });

  afterEach(() => {
    env.cleanup();
  });

  it("slice execute：descend 存在（指向第一个 child wave）+ guidance 不含【派发】", () => {
    const slice = setupToSliceDesignReviewed(env.deps, "serial-ex-slice");
    const exec = dispatch(executeParams(slice.id), env.deps);

    expect(exec.ok).toBe(true);
    expect(exec.nextAction?.crossLayer).toBeDefined();
    expect(exec.nextAction!.crossLayer!.kind).toBe("descend");
    expect(exec.nextAction!.crossLayer!.targetLayer).toBe("wave");
    expect(exec.nextAction!.crossLayer!.targetUnitId).toBe(
      (exec.children ?? [])[0]?.unitId,
    );
    // serial 不渲染派发段（buildSubagentGuidance 在非 recursive 时原样返回）
    expect(findDispatchSegment(exec.nextAction?.guidance ?? "")).toBe("");
  });

  it("feature execute：descend 存在（指向第一个 child slice）+ guidance 不含【派发】", () => {
    const featureId = setupToFeatureDesignReviewed(env.deps, "serial-ex-feature");
    const exec = dispatch(executeParams(featureId), env.deps);

    expect(exec.ok).toBe(true);
    expect(exec.nextAction?.crossLayer).toBeDefined();
    expect(exec.nextAction!.crossLayer!.kind).toBe("descend");
    expect(exec.nextAction!.crossLayer!.targetLayer).toBe("slice");
    expect(findDispatchSegment(exec.nextAction?.guidance ?? "")).toBe("");
  });

  it("epic execute：descend 存在（指向第一个 child feature）+ guidance 不含【派发】", () => {
    const epicId = setupToEpicDesignReviewed(env.deps, "serial-ex-epic");
    const exec = dispatch(executeParams(epicId), env.deps);

    expect(exec.ok).toBe(true);
    expect(exec.nextAction?.crossLayer).toBeDefined();
    expect(exec.nextAction!.crossLayer!.kind).toBe("descend");
    expect(exec.nextAction!.crossLayer!.targetLayer).toBe("feature");
    expect(findDispatchSegment(exec.nextAction?.guidance ?? "")).toBe("");
  });

  it("wave closeout（有 parent）：crossLayer 存在（serial 不抑制——证明 recursive 抑制是真实的）", () => {
    // 同 recursive 的 wave closeout 场景，但 serial 模式——crossLayer 应存在（sibling/ascend）。
    // 这是对 TC2 wave 测试的对照组：证明 recursive 的 undefined 是「抑制」而非「无 parent 导致」。
    const slice = setupToSliceDesignReviewed(env.deps, "serial-co-wave-parent");
    const exec = dispatch(executeParams(slice.id), env.deps);
    const waveId = (exec.children ?? [])[0]?.unitId;
    if (waveId === undefined) throw new Error("slice execute 未创建 child wave");

    advanceWaveToRetrospected(env.deps, waveId);
    const co = dispatch(
      { action: "closeout", unitId: waveId, input: { artifacts: [] } },
      env.deps,
    );

    expect(co.ok).toBe(true);
    expect(co.nextAction?.crossLayer).toBeDefined();
    // slice 仅 1 个 child wave，closeout 后无 pending sibling → ascend 回 parent slice
    expect(["sibling", "ascend"]).toContain(co.nextAction!.crossLayer!.kind);
  });
});

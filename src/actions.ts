/**
 * actions — 7 个 action handler 合并单文件（lite 单轨极简版）。
 *
 * 与旧版的差异（重构 = 推倒重建）：
 * - 7 个 handler 从分散文件（create.ts/plan.ts/dev.ts/test.ts/replan.ts/retrospect.ts/closeout.ts）
 *   合并到单文件——lite 极简版 handler 体量小，分散文件增加导航成本。
 * - 砍掉所有 tier 字段（lite-only 硬编码，gateHistory 不再记 gateTier）。
 * - 砍掉 ClarifyParams / DetailParams（mid 专属）。
 * - gate 检查从 runGate(gateCtx, tier, phase) 改为直接调具名函数（planCheck/devCheck/testCheck/fileExistsCheck）。
 * - parseLitePlan 签名从 (json, tier) 改为 (json)——tier 砍掉。
 * - handleTest 砍掉 mid 分支（信声明 + GitValidator 追溯），只留 lite 的 judgeByExpected 重算。
 *
 * 关键语义（plan.md 约束）：
 * - gate fail 时 status 不变：plan/retrospect/closeout gate fail → 只 appendGateHistory(fail)，
 *   不 updateStatus、不 updateGatePassed。nextAction 指回自己（buildNextAction 内已实现熄断+retry 逻辑）。
 * - gate pass 时才流转 status：updateStatus + insertXxx + appendGateHistory(pass) + updateGatePassed。
 * - progressive 原地停留：dev 在 developed 状态下再调，status 仍为 developed（computeNextStatus 判定）。
 *   test 同理。靠 computeNextStatus，handler 不特殊处理。
 * - handleReplan 事务内必须同步 gatePassed（砍掉 cache_inconsistent guard 后的注释强依赖）。
 */

import { join } from "node:path";

import {
  clarifyCheck,
  devCheck,
  fileExistsCheck,
  planCheck,
  redLightCheck,
  tddPlanCheck,
  testCheck,
} from "./gate.js";
import {
  type ParsedDevPlan,
  parseDevPlan,
  parseTestJson,
} from "./plan-parser.js";
import {
  buildNextAction,
  computeGatePassed,
  computeNextStatus,
} from "./state-machine.js";
import { computeRetrospectDerived } from "./stats.js";
import {
  type ActionDeps,
  type ActionResult,
  type Actual,
  type ClarifyRecord,
  CwError,
  type Evidence,
  type RetrospectData,
  type RetrospectKnownRisk,
  type ReviewFixSubmission,
  type ReviewIssue,
  type ReviewIssueSubmission,
  type RuntimeEnv,
  type TestCase,
  type TestCaseSeed,
  type TestFixSubmission,
  type Topic,
  type Wave,
  type WaveSeed,
} from "./types.js";

// ── 参数类型（7 个 action）──────────────────────────────────

export interface CreateParams {
  action: "create";
  slug: string;
  objective: string;
  workspacePath?: string;
  /** 运行环境 agent 名称（如 "Pi"、"Claude Code"），用于评估指标分组。cli 层合并 env.json/默认值后传入。 */
  agent?: string;
  /** 运行环境 LLM 名称（如 "GLM-5.2"），用途同 agent。 */
  llm?: string;
  /** cw-cli 版本号，cli 层从 package.json 自动读取后传入。 */
  cwVersion?: string;
}

export interface ClarifyParams {
  action: "clarify";
  topicId: string;
  /** clarifyJson 内容（CLI 从 stdin 读为对象，支持单条或批量数组）。 */
  clarifyJson: unknown;
}

export interface PlanParams {
  action: "plan";
  topicId: string;
  /** plan.json 内容（CLI 从 stdin 读为对象）。 */
  planJson: unknown;
}

export interface TddPlanParams {
  action: "tdd_plan";
  topicId: string;
  /** test.json 内容（CLI 从 stdin 读为对象）。 */
  testJson: unknown;
}

export interface DevParams {
  action: "dev";
  topicId: string;
  tasks: Array<{ waveId: string; commitHash: string }>;
}

export interface TestCaseSubmission {
  caseId: string;
  /** 机器重算的真实观测值（judgeByExpected 用）。 */
  actual?: Actual;
  /** 截图绝对路径（requiresScreenshot=true 时校验存在）。 */
  screenshotPath?: string;
}

export interface TestParams {
  action: "test";
  topicId: string;
  cases: TestCaseSubmission[];
}

export interface RetrospectParams {
  action: "retrospect";
  topicId: string;
  /** changes/retrospect.md 绝对路径。 */
  retrospectPath?: string;
  /**
   * 结构化回顾数据（可选，与 retrospect.md 双写）。
   * agent 填 knownRisks + processIssues，derived 由 cw 自动算并覆盖。
   * 不提供时只存 retrospectPath（向后兼容）。
   */
  retrospectData?: unknown;
}

export interface ReviewParams {
  action: "review";
  topicId: string;
  /** changes/review.md 绝对路径。提供时做 fileExistsCheck（review 的前置条件：文件存在）。 */
  reviewPath?: string;
  /**
   * 本次 review 发现的问题列表（必填，空数组 = 无问题，直接进 test）。
   * 非空 = gate「有发现」→ 进 review_fix（未达上限）或强制进 test（达上限）。
   */
  issues: ReviewIssueSubmission[];
}

export interface ReviewFixParams {
  action: "review_fix";
  topicId: string;
  /** 本次修复提交（每条 issueId 指向已存在的 open ReviewIssue）。 */
  fixes: ReviewFixSubmission[];
}

export interface TestFixParams {
  action: "test_fix";
  topicId: string;
  /** 本次修复提交（每条 caseId 指向 failed 的 testCase，只记录审计，不验证 commit 真实性）。 */
  fixes: TestFixSubmission[];
}

export interface CloseoutParams {
  action: "closeout";
  topicId: string;
}

export interface ReplanParams {
  action: "replan";
  topicId: string;
  /** 新版 dev-plan.json（format 必须 === "lite"），整对象传入。可选（与 testJson 二选一或同时提供）。 */
  planJson?: unknown;
  /** 新版 test.json（testCases + 可选 testRunner），整对象传入。可选（与 planJson 二选一或同时提供）。 */
  testJson?: unknown;
}

export type CwParams =
  | CreateParams
  | ClarifyParams
  | PlanParams
  | TddPlanParams
  | DevParams
  | TestParams
  | RetrospectParams
  | ReviewParams
  | ReviewFixParams
  | TestFixParams
  | CloseoutParams
  | ReplanParams;

// ── handleCreate ────────────────────────────────────────────

/**
 * handleCreate — 构造新 Topic 并持久化（入口 action）。
 *
 * 数据流：slug+objective → 构造 Topic（含 runtimeEnv） → store.transaction{insertTopic} → buildNextAction。
 *
 * runtimeEnv 注入：agent/llm/cwVersion 三个字段由 CLI 层 resolveRuntimeEnv 合并后传入。
 * 三者全缺（旧 CLI / 测试未传）时 runtimeEnv 留 undefined，保持旧 topic 兼容。
 *
 * 与旧版差异：砍掉 tier 参数（lite-only 硬编码，不再收 tier）。
 * 失败路径：slug 重复 → insertTopic 抛 UNIQUE 约束错误（propagate 给 CLI 映射 exit code）。
 */
export function handleCreate(params: CreateParams, deps: ActionDeps): ActionResult {
  const topicId = buildTopicId(params.slug);
  const workspacePath = params.workspacePath ?? deps.workspacePath;
  const topicDir = join(workspacePath, ".xyz-harness", params.slug);

  // runtimeEnv：agent/llm/cwVersion 任一存在即构造（三字段通常同时出现，但容错部分缺）。
  const runtimeEnv: RuntimeEnv | undefined =
    params.agent || params.llm || params.cwVersion
      ? {
          agent: params.agent ?? "unknown",
          llm: params.llm ?? "unknown",
          cwVersion: params.cwVersion ?? "unknown",
        }
      : undefined;

  const topic: Topic = {
    topicId,
    slug: params.slug,
    objective: params.objective,
    workspacePath,
    topicDir,
    createdAt: new Date().toISOString(),
    status: "created",
    runtimeEnv,
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
    clarifyRecords: [],
    adrs: [],
    reviewIssues: [],
    reviewTurn: 0,
    testFixLog: [],
    testTurn: 0,
  };

  deps.store.transaction(() => {
    deps.store.insertTopic(topic);
  });

  return {
    topicId,
    status: topic.status,
    gatePassed: topic.gatePassed,
    nextAction: buildNextAction("create", topic),
  };
}

/** 拼接 topicId = cw-YYYY-MM-DD-<slug>。纯函数。 */
function buildTopicId(slug: string): string {
  const ISO_DATE_PREFIX_LEN = 10;
  const date = new Date().toISOString().slice(0, ISO_DATE_PREFIX_LEN);
  return `cw-${date}-${slug}`;
}

// ── handleClarify ───────────────────────────────────────────

/**
 * handleClarify — 渐进式澄清记录提交（progressive，不流转 status）。
 *
 * 数据流：
 *   clarifyCheck(clarifyJson)（结构校验 + ADR projectPath 文件存在）
 *     → 事务{ 逐条 appendClarifyRecord（+ 若含 adr: appendAdr + updateClarifyRecord 回填 adrId）
 *       + appendGateHistory(clarify, pass/fail, progressive:true) }
 *     → reload → buildNextAction("clarify")
 *
 * progressive 语义：status 始终为 created（TRANSITIONS.clarify.nextStatus=created, progressive=true），
 * 可多次调用，每次追加新的澄清记录。
 *
 * gate fail 语义：clarifyCheck 结构校验失败 → gateHistory append fail，nextAction 指回 clarify retry。
 * 与 plan/tdd_plan 的 gate fail 不同：clarify gate fail 时 status 本就不变（created），无需特别处理。
 *
 * ADR 双写流程：
 *   - clarifySeed 含 adr 时，先 appendAdr 拿到分配的 adrId
 *   - 再 appendClarifyRecord 时回填 adrId 到 clarifyRecord
 *   - 注意：appendClarifyRecord 已含 answer → status=resolved，adrId 通过 updateClarifyRecord 回填
 *
 * 失败路径：
 *   - clarifyCheck fail（结构/schema/projectPath 文件不存在）→ status 不变 + gateHistory fail + mustFix
 */
export function handleClarify(
  params: ClarifyParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  // topic 参数由 dispatch 统一签名传入，handleClarify 不读 topic 当前状态
  // （progressive append-only，只追加记录不改状态）。
  void topic;
  const check = clarifyCheck(params.clarifyJson);

  let passed: boolean;
  deps.store.transaction(() => {
    if (check.result === "fail") {
      deps.store.appendGateHistory(params.topicId, {
        phase: "clarify",
        action: "clarify",
        gate: "clarify-schema",
        result: "fail",
        report: check.report,
        progressive: true,
      });
      passed = false;
      return;
    }

    // gate pass：逐条写入 clarifyRecord + 关联 ADR
    const parsed = check.parsed!;
    for (const item of parsed) {
      const seed = item.clarifySeed;

      // 若含 ADR，先 appendAdr 拿到分配的 id
      let adrId: string | undefined;
      if (seed.adr) {
        adrId = deps.store.appendAdr(params.topicId, seed.adr);
      }

      // appendClarifyRecord 返回分配的 clarifyRecord id
      const clarifyId = deps.store.appendClarifyRecord(params.topicId, seed);

      // 回填 adrId 到 clarifyRecord（关联 ADR 与 clarify）
      if (adrId) {
        deps.store.updateClarifyRecord(params.topicId, clarifyId, { adrId });
        // 也回填 clarifyId 到 adr（双向关联）——当前 store 无 updateAdr，通过 appendAdr 时不带 clarifyId
        // 暂时只做单向关联（clarifyRecord.adrId → adr），adr.clarifyId 留空，后续如需可加 updateAdr
      }
    }

    deps.store.appendGateHistory(params.topicId, {
      phase: "clarify",
      action: "clarify",
      gate: "clarify-schema",
      result: "pass",
      progressive: true,
    });
    passed = true;
  });

  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after clarify: ${params.topicId}`);
  }

  const result: ActionResult = {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("clarify", updated),
  };
  // 暴露 clarifyProgress 供调用方查看进度
  (result as Record<string, unknown>).clarifyProgress = updated.clarifyRecords.map(
    (c: ClarifyRecord) => ({
      id: c.id,
      kind: c.kind,
      status: c.status,
      adrId: c.adrId,
    }),
  );
  if (!passed!) {
    (result as Record<string, unknown>).mustFix = check.report;
  }
  return result;
}

// ── gateAdvance（file-gate 深函数）─────────────────────────

/**
 * gateAdvance — 吸收 file-gate handler 的共同骨架。
 *
 * retrospect / closeout 两个 handler 共享同一套编排：
 *   fileExistsCheck → transaction{ appendGateHistory + if pass{ updateStatus + updateGatePassed + onPass } }
 *   → loadTopic reload → buildNextAction → mustFix 装配。
 *
 * 差异只在 phase 名、gate 名、path、pass 时的额外步骤（setArtifacts / setEvidence），
 * 通过参数 + onPass 回调收敛。onPass 在事务内、gate-pass 三联写之后执行，
 * 可通过 deps.store.loadTopic 拿到含本次写入的 topic（closeout 的 evidence 快照用）。
 *
 * 注意：review 不再用 gateAdvance——它的 gate 语义变了（issues 非空 = 「有发现」而非 fail），
 * 见 handleReview 内联实现。
 */
function gateAdvance(
  phase: "retrospect" | "closeout",
  gateName: string,
  path: string,
  topicId: string,
  topic: Topic,
  deps: ActionDeps,
  onPass?: () => void,
): ActionResult {
  const check = fileExistsCheck(path);

  let passed: boolean;
  deps.store.transaction(() => {
    deps.store.appendGateHistory(topicId, {
      phase,
      action: phase,
      gate: gateName,
      result: check.result,
      report: check.result === "fail" ? check.report : undefined,
      progressive: false,
    });
    if (check.result === "fail") {
      passed = false;
      return;
    }
    deps.store.updateStatus(topicId, computeNextStatus(phase, topic.status));
    deps.store.updateGatePassed(topicId, phase, true);
    onPass?.();
    passed = true;
  });

  const updated = deps.store.loadTopic(topicId);
  if (!updated) {
    throw new Error(`topic not found after ${phase}: ${topicId}`);
  }

  const result: ActionResult = {
    topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction(phase, updated),
  };
  // closeout 在事务内写 evidence，updated 已含——带上供调用方使用。
  if (updated.evidence) {
    result.evidence = updated.evidence;
  }
  if (!passed!) {
    (result as Record<string, unknown>).mustFix = check.report;
  }
  return result;
}

// ── handlePlan ──────────────────────────────────────────────

/**
 * handlePlan — lite plan gate + waves 写入 + 状态流转。
 *
 * 数据流：planCheck → 事务{ pass: insertWaves（+legacyTestCases 兼容旧格式）+ 流转 +
 *   gatePassed(plan,true) + gateHistory(pass)
 *   | fail: gateHistory(fail)，status 不变 } → buildNextAction。
 *
 * 改造说明（W4）：planCheck 现在只校验 waves（W3 已改），handlePlan 只调 insertWaves。
 * 向后兼容：如果 parsed.legacyTestCases 存在（旧格式 plan.json 同时含 testCases），
 * 也调 insertTestCases 写入，避免破坏旧流程。新格式 dev-plan.json 不含 testCases，
 * testCases 在 tdd_plan 阶段通过 test.json 单独提交。
 *
 * gate fail 语义（关键约束）：status 不变（仍 created），gateHistory append fail，
 * gatePassed.plan 不设，nextAction 指回 plan retry（buildNextAction 内判定 computeGatePassed("plan")=false）。
 *
 * 失败路径：
 *   - planCheck fail → status 不变 + gateHistory fail（exit 0，agent 按 nextAction retry）
 *   - 注意：parseDevPlan 在 planCheck 内部调用，throw 被 planCheck 捕获转为 fail 结果，
 *     不会 propagate——这是有意的，让 gate fail 走统一路径而非异常路径。
 */
export function handlePlan(
  params: PlanParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const check = planCheck(params.planJson);

  let passed: boolean;
  deps.store.transaction(() => {
    if (check.result === "fail") {
      // gate fail：status 不变，只 append gateHistory(fail)。
      deps.store.appendGateHistory(params.topicId, {
        phase: "plan",
        action: "plan",
        gate: "lite-plan-schema",
        result: "fail",
        report: check.report,
        progressive: false,
      });
      passed = false;
      return;
    }
    // gate pass：解析的任务清单写入 + 状态流转。
    // planCheck 内部已调 parseDevPlan 成功，这里再调一次拿 parsed（parseDevPlan 是纯函数，幂等）。
    const parsed = parseDevPlan(params.planJson);
    deps.store.insertWaves(params.topicId, parsed.waves);
    // 向后兼容：旧格式 plan.json 同时含 testCases（extractDevPlan 提取到 legacyTestCases）。
    // 新格式 dev-plan.json 不含 testCases（test.json 在 tdd_plan 阶段提交），跳过 insertTestCases。
    if (parsed.legacyTestCases && parsed.legacyTestCases.length > 0) {
      deps.store.insertTestCases(params.topicId, parsed.legacyTestCases);
    }
    deps.store.updateStatus(
      params.topicId,
      computeNextStatus("plan", topic.status),
    );
    deps.store.updateGatePassed(params.topicId, "plan", true);
    deps.store.appendGateHistory(params.topicId, {
      phase: "plan",
      action: "plan",
      gate: "lite-plan-schema",
      result: "pass",
      progressive: false,
    });
    passed = true;
  });

  // 重新 load 拿最新 topic（waves/testCases/status/gateHistory 已变）。
  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after plan: ${params.topicId}`);
  }

  const result: ActionResult = {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("plan", updated),
  };
  if (!passed!) {
    // gate fail 时附 mustFix，方便 agent 诊断（不改变 ActionResult 结构契约）。
    (result as Record<string, unknown>).mustFix = check.report;
  } else if (check.warning) {
    // gate pass 但范围可能过大 → warning 挂 mustFix（不阻断 status，agent 可选拆分或继续）。
    (result as Record<string, unknown>).mustFix = `范围守门 warning（不阻断）：${check.warning}`;
  }
  return result;
}

// ── handleTddPlan ───────────────────────────────────────────

/**
 * handleTddPlan — test.json gate + testCases 写入 + 状态流转（planned → tdd_inited）。
 *
 * 数据流：tddPlanCheck(testJson) → 事务{ pass: insertTestCases + (可选)setTestRunner
 *   + updateStatus(tdd_inited) + gatePassed(tdd_plan,true) + gateHistory(pass)
 *   | fail: gateHistory(fail)，status 不变（仍 planned） }
 *   → 事务外对 redCheck=true 的 testCase 跑 redLightCheck（仅当配置了 testRunner）
 *   → buildNextAction("tdd_plan")。
 *
 * 红灯校验（事务外）：testRunner 存在时，对 redCheck=true 的 testCase 跑测试命令，
 * 确认测试如期失败（红灯）。失败（非红灯）只作为 warning 写入 result.mustFix，不阻断
 * status 流转——红灯校验是「锦上添花」的机器验证，失败可能只是 testRunner 配置问题，
 * agent 看到 mustFix 可以选择修测试或忽略。
 *
 * gate fail 语义：status 不变（仍 planned），gateHistory append fail，
 * nextAction 指回 tdd_plan retry。
 *
 * 约束：redLightCheck 调 execFileSync（跑外部命令），必须在事务外执行——
 * execFileSync 的耗时不可控，放在 JSON 事务里会延长锁持有时间。
 *
 * 失败路径：
 *   - tddPlanCheck fail → status 不变 + gateHistory fail（exit 0，agent 按 nextAction retry）
 *   - parseTestJson throw 被 tddPlanCheck 捕获转为 fail 结果，不会 propagate。
 */
export function handleTddPlan(
  params: TddPlanParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const check = tddPlanCheck(params.testJson);

  let passed: boolean;
  deps.store.transaction(() => {
    if (check.result === "fail") {
      // gate fail：status 不变，只 append gateHistory(fail)。
      deps.store.appendGateHistory(params.topicId, {
        phase: "tdd_plan",
        action: "tdd_plan",
        gate: "test-json-schema",
        result: "fail",
        report: check.report,
        progressive: false,
      });
      passed = false;
      return;
    }
    // gate pass：testCases 写入 + 状态流转到 tdd_inited。
    const parsed = check.parsed!;
    deps.store.insertTestCases(params.topicId, parsed.testCases);
    // 存储项目级 testRunner 配置（若 test.json 提供），供 test 阶段 runTestRunner 和红灯校验复用。
    if (parsed.testRunner) {
      deps.store.setTestRunner(params.topicId, parsed.testRunner);
    }
    deps.store.updateStatus(
      params.topicId,
      computeNextStatus("tdd_plan", topic.status),
    );
    deps.store.updateGatePassed(params.topicId, "tdd_plan", true);
    deps.store.appendGateHistory(params.topicId, {
      phase: "tdd_plan",
      action: "tdd_plan",
      gate: "test-json-schema",
      result: "pass",
      progressive: false,
    });
    passed = true;
  });

  // 重新 load 拿最新 topic（testCases/testRunner/status/gateHistory 已变）。
  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after tdd_plan: ${params.topicId}`);
  }

  const result: ActionResult = {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("tdd_plan", updated),
  };
  if (!passed!) {
    (result as Record<string, unknown>).mustFix = check.report;
    return result;
  }

  // 事务外：gate pass 后，对 redCheck=true 的 testCase 跑红灯校验（仅当配置了 testRunner）。
  // 不改变 status（已是 tdd_inited），红灯校验失败只作为 warning 写入 mustFix。
  // 红灯结果追加 gateHistory（独立 gate 名 tdd-red-light），供事后复盘 TDD 纪律执行情况。
  const redWarnings = runRedLightVerification(updated);
  if (redWarnings.length > 0) {
    (result as Record<string, unknown>).mustFix = redWarnings.join("\n");
    deps.store.transaction(() => {
      deps.store.appendGateHistory(params.topicId, {
        phase: "tdd_plan",
        action: "tdd_plan",
        gate: "tdd-red-light",
        result: "fail",
        report: redWarnings.join("\n"),
        progressive: false,
      });
    });
  } else if (updated.testRunner) {
    // 配置了 testRunner 且红灯全通过（含无 redCheck case 的情况）→ 记 pass 证明红灯验证执行过。
    deps.store.transaction(() => {
      deps.store.appendGateHistory(params.topicId, {
        phase: "tdd_plan",
        action: "tdd_plan",
        gate: "tdd-red-light",
        result: "pass",
        progressive: false,
      });
    });
  }
  return result;
}

/**
 * 红灯校验辅助：对 topic 中 redCheck=true 的 testCase 跑测试命令确认红灯。
 *
 * 命令来源：topic.testRunner（tdd_plan 阶段写入）。
 *   - nodejs/python/java 模式：用 testRunner.command，cwd 解析为 join(workspacePath, testRunner.cwd ?? ".")
 *   - custom 模式：用 `bash testRunner.path`，cwd = workspacePath
 * 没配 testRunner（agent 模式）→ 跳过（agent 自己负责红灯），返回空数组。
 *
 * 返回非红灯的 reason 列表（warning），调用方拼入 mustFix。空数组 = 全部红灯确认或无需校验。
 */
function runRedLightVerification(topic: Topic): string[] {
  if (!topic.testRunner) return [];
  const redCases = topic.testCases.filter((c) => c.redCheck === true);
  if (redCases.length === 0) return [];

  const config = topic.testRunner;
  let cmd: string | undefined;
  let cwd: string;
  if (config.mode === "custom") {
    if (!config.path) return [];
    cmd = `bash ${config.path}`;
    cwd = topic.workspacePath;
  } else {
    if (!config.command) return [];
    cmd = config.command;
    cwd = config.cwd
      ? join(topic.workspacePath, config.cwd)
      : topic.workspacePath;
  }

  const failures: string[] = [];
  const redResult = redLightCheck(cmd, cwd);
  if (!redResult.redLight) {
    failures.push(
      `红灯校验未通过（${redCases.map((c) => c.id).join(", ")}）：${redResult.reason}`,
    );
  }
  return failures;
}

// ── handleDev ───────────────────────────────────────────────

/**
 * handleDev — 渐进式 dev 提交（progressive）。
 *
 * 数据流（per task）：
 *   devCheck(commitHash)（GitValidator.validate）
 *     → valid: store.setWaveCommitted(waveId, commitHash)
 *     → invalid: 跳过（wave 保持未 committed）
 *   → store.updateStatus(computeNextStatus)（progressive 原地停留）
 *   → store.appendGateHistory(medium-git 记录，pass/fail 按是否有 invalid task)
 *   → reload → computeGatePassed("dev") → buildNextAction
 *
 * progressive 语义：computeNextStatus("dev", developed) = developed（原地停留），
 * 所以 dev 在 developed 状态下多次调用不会回退，每次提交新的 wave commit。
 *
 * gatePassed.dev 不在这里 updateGatePassed——由 computeGatePassed 实时算（buildNextAction 内调）。
 * 旧版也不写 gatePassed.dev 缓存，靠 computeGatePassed 重算（避免缓存漂移）。
 *
 * 失败路径：单个 commit 无效 → 该 wave 不写 committed，gate 记 fail，agent 按 nextAction 继续提交。
 */
export function handleDev(
  params: DevParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  // Step 1: 逐 task 校验 commit。全量校验，不 short-circuit，便于汇总无效项。
  const taskResults = params.tasks.map((task) => ({
    waveId: task.waveId,
    commitHash: task.commitHash,
    validation: devCheck(deps.git, task.commitHash, task.waveId, topic),
  }));

  // Step 1b: commitHash 唯一性检测（warning，不阻断 committed）。
  // 同一 commitHash 绑定多个 wave = 违反「每 Wave 独立 commit」规范。
  // commit 是 Wave 级验证锚点，共享 commit 让两个 Wave 的验证脱节。
  // 只检测 + 标记（extraCommitReuse），不阻止 committed——因为可能是简单任务 agent 塞了一个 commit。
  // 配合 EXECUTE_PROMPT 的 COMMIT_DISCIPLINE 段做事前预防。
  const hashToWaves = new Map<string, string[]>();
  for (const t of taskResults) {
    const existing = hashToWaves.get(t.commitHash) ?? [];
    existing.push(t.waveId);
    hashToWaves.set(t.commitHash, existing);
  }
  for (const t of taskResults) {
    const sharing = hashToWaves.get(t.commitHash);
    if (sharing && sharing.length > 1) {
      t.validation.extraCommitReuse = sharing.filter((w) => w !== t.waveId);
    }
  }

  const invalidTasks = taskResults.filter((t) => !t.validation.valid);

  // Step 2: 计算流转后状态（progressive：已 developed 则原地停留）。
  const nextStatus = computeNextStatus("dev", topic.status);

  // Step 3: 事务内写入——只 commit 校验通过的 wave。
  deps.store.transaction(() => {
    for (const t of taskResults) {
      if (t.validation.valid) {
        deps.store.setWaveCommitted(
          topic.topicId,
          t.waveId,
          t.commitHash,
          t.validation.changedFiles,
        );
      }
    }
    deps.store.updateStatus(topic.topicId, nextStatus);

    // medium-git gate 记录：本次提交的 commit 全部校验通过 = pass，否则 fail。
    deps.store.appendGateHistory(topic.topicId, {
      phase: "dev",
      action: "dev",
      gate: "medium-git",
      result: invalidTasks.length === 0 ? "pass" : "fail",
      progressive: true,
      report:
        invalidTasks.length > 0
          ? `invalid commits: ${invalidTasks
              .map((t) => `${t.waveId}@${t.commitHash}(${t.validation.reason ?? "unknown"})`)
              .join(", ")}`
          : undefined,
    });
  });

  // Step 4: reload 拿到事务后最新 waves，供 gatePassed/nextAction 计算。
  const updated = deps.store.loadTopic(topic.topicId);
  if (!updated) {
    throw new Error(`topic not found after dev: ${topic.topicId}`);
  }

  // Step 5: 组装 ActionResult。gatePassed.dev 由 computeGatePassed 实时算。
  const devGatePassed = computeGatePassed("dev", updated);
  return {
    topicId: updated.topicId,
    status: updated.status,
    gatePassed: { ...updated.gatePassed, dev: devGatePassed },
    nextAction: buildNextAction("dev", updated),
    taskResults,
  };
}

// ── handleTest ──────────────────────────────────────────────

export interface TestCaseResult {
  caseId: string;
  status: TestCase["status"];
  failureReason?: string;
}

/**
 * handleTest — 渐进式测试结果提交（progressive，strong-recompute）。
 *
 * 数据流（per case）：
 *   testCheck(testCase, actual, screenshotPath)（judgeByExpected 机器重算）
 *     → store.updateTestCase(status/actual/screenshotPath/failureReason)
 *   → computeGatePassed("test") → computeNextStatus（progressive 原地停留）
 *   → updateStatus + updateGatePassed("test") + appendGateHistory
 *   → reload → buildNextAction
 *
 * 砍掉旧版 mid 分支（信声明 + GitValidator 追溯 dev commit）——lite-only，丢 claimedStatus（D-008）。
 *
 * progressive 语义：computeNextStatus("test", tested) = tested（原地停留），
 * test 在 tested 状态下多次调用不报 illegal_transition，剩余 case 继续判定。
 *
 * 失败路径：
 *   - caseId 不存在 → throw（propagate 给 CLI）
 *   - judgeByExpected mismatch / screenshot 缺失 → status=failed + failureReason（不 throw，走 gate fail 路径）
 */
export function handleTest(
  params: TestParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const caseResults: TestCaseResult[] = [];

  deps.store.transaction(() => {
    for (const submission of params.cases) {
      const tc = topic.testCases.find((c) => c.id === submission.caseId);
      if (!tc) {
        throw new CwError(`case not found: ${submission.caseId}`);
      }

      const judged = testCheck(tc, submission.actual, submission.screenshotPath);
      const patch: Partial<TestCase> = {
        status: judged.status,
        actual: submission.actual as object | undefined,
        screenshotPath: submission.screenshotPath,
        ...(judged.status === "failed" ? { failureReason: judged.reason } : {}),
      };
      // judged.status === "passed" 时清理之前的 failureReason（retry 场景）。
      if (judged.status === "passed") {
        patch.failureReason = undefined;
      }
      deps.store.updateTestCase(params.topicId, submission.caseId, patch);
      caseResults.push({
        caseId: submission.caseId,
        status: judged.status,
        failureReason: judged.status === "failed" ? judged.reason : undefined,
      });
    }

    const failedCount = caseResults.filter((c) => c.status !== "passed").length;
    const hasFailures = failedCount > 0;

    // 有 case failed 且是第一次 fail（testTurn=0）→ incTestTurn 开启 test-fix loop 计数。
    // 首次 fail 标记后不再重复 inc（避免同 loop 内多次 test 提交重复计数）。
    // 熔断由 buildNextAction 基于 testTurn >= TEST_TURN_LIMIT 判定（外部可手动设置 turn 触发）。
    if (hasFailures && topic.testTurn === 0) {
      deps.store.incTestTurn(params.topicId);
    }

    // 事务内 reload 拿最新数据算 gatePassed + status。
    const reloaded = deps.store.loadTopic(params.topicId);
    if (!reloaded) {
      throw new Error(`topic not found after test: ${params.topicId}`);
    }
    const gatePassed = computeGatePassed("test", reloaded);
    const nextStatus = computeNextStatus("test", reloaded.status);
    if (nextStatus !== reloaded.status) {
      deps.store.updateStatus(params.topicId, nextStatus);
    }
    deps.store.updateGatePassed(params.topicId, "test", gatePassed);

    deps.store.appendGateHistory(params.topicId, {
      phase: "test",
      action: "test",
      gate: "judgeByExpected",
      result: failedCount === 0 ? "pass" : "fail",
      report: JSON.stringify(caseResults),
      progressive: true,
    });
  });

  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after test: ${params.topicId}`);
  }

  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("test", updated),
    testProgress: updated.testCases.map((c) => ({ id: c.id, status: c.status })),
    caseResults,
  };
}

// ── handleTestFix ───────────────────────────────────────────

/**
 * handleTestFix — test loop 内的修复动作（progressive，status 留在 tested）。
 *
 * 数据流：
 *   校验 fixes[].caseId 存在（不存在的 caseId 抛 CwError）
 *     → 事务{ 逐条 appendTestFix（caseId + commitHash + resolution + turn 审计日志）
 *       + appendGateHistory(test-fix, pass, progressive) }
 *     → reload → buildNextAction("test_fix")（指向 test 重跑失败的 case）。
 *
 * 不做 commit 校验：commitHash 只记录审计，不验证真实性（与 dev 的 commit 校验语义不同）。
 * turn = 当前 testTurn（修复发生在哪一轮 test 之后）。
 *
 * 失败路径：fixes 里某 caseId 不存在于 topic.testCases → throw CwError。
 */
export function handleTestFix(
  params: TestFixParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const fixes = params.fixes ?? [];

  // 校验所有 caseId 存在（校验在事务外做）。
  const caseIds = new Set(topic.testCases.map((c) => c.id));
  for (const fix of fixes) {
    if (!caseIds.has(fix.caseId)) {
      throw new CwError(
        `test_fix caseId 不存在: ${fix.caseId}（不存在于 topic.testCases）`,
      );
    }
  }

  // turn = 当前 testTurn（修复发生在哪一轮 test 之后）。
  const turn = topic.testTurn;

  deps.store.transaction(() => {
    for (const fix of fixes) {
      deps.store.appendTestFix(params.topicId, {
        caseId: fix.caseId,
        commitHash: fix.commitHash,
        resolution: fix.resolution,
        turn,
      });
    }
    deps.store.appendGateHistory(params.topicId, {
      phase: "test_fix",
      action: "test_fix",
      gate: "test-fix",
      result: "pass",
      report: `${fixes.length} case(s) fixed at turn ${turn}`,
      progressive: true,
    });
  });

  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after test_fix: ${params.topicId}`);
  }

  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("test_fix", updated),
  };
}

// ── handleReview ────────────────────────────────────────────

/**
 * handleReview — review 阶段 handler（progressive，多轮 review loop）。
 *
 * gate 语义变了：不再只是 fileExistsCheck，还要看 issues。
 *   - reviewPath 提供时，先做 fileExistsCheck（review 的前置条件：审查报告文件存在）。
 *     fail → 记 gate fail，status 不变，nextAction 指回 review retry。
 *   - issues 为空（无问题）= gate pass → status 流转 reviewed + nextAction=test。
 *   - issues 非空（有发现）= gate「有发现」：
 *     appendReviewIssues（新 turn 的 open issues）+ incReviewTurn + status 流转 reviewed
 *     + nextAction 指向 review_fix（reviewTurn < LIMIT）或 test（达上限强制进 test）。
 *
 * 注意：issues 非空不是 gate fail——review 的目的就是发现问题，发现 = 正常流程。
 * reviewTurn 在 appendReviewIssues 后 inc（turn = 原 reviewTurn+1），appendReviewIssues
 * 传入的 turn 参数对应当前 turn（reviewTurn+1，新开启的这一轮）。
 *
 * progressive 语义：status=reviewed 下再次调 review 合法（fix 后重审，多轮 loop）。
 */
export function handleReview(
  params: ReviewParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const path = params.reviewPath ?? "";
  const issues = params.issues ?? [];
  const hasIssues = issues.length > 0;

  // reviewPath 提供时做 fileExistsCheck（前置条件）。fail → gate fail，status 不变。
  const fileCheck =
    path.length > 0 ? fileExistsCheck(path) : { result: "pass" as const, report: "" };

  let passed: boolean;
  let gateReport: string | undefined;

  deps.store.transaction(() => {
    if (fileCheck.result === "fail") {
      // 前置条件失败 → gate fail，status 不变。
      deps.store.appendGateHistory(params.topicId, {
        phase: "review",
        action: "review",
        gate: "file-exists+non-empty",
        result: "fail",
        report: fileCheck.report,
        progressive: true,
      });
      passed = false;
      gateReport = fileCheck.report;
      return;
    }

    // 前置条件通过 → status 流转 reviewed（progressive）。
    deps.store.updateStatus(
      params.topicId,
      computeNextStatus("review", topic.status),
    );
    deps.store.updateGatePassed(params.topicId, "review", true);

    // 记录 review artifacts（reviewPath + 时间戳）。
    if (path.length > 0) {
      deps.store.setArtifacts(params.topicId, {
        reviewPath: path,
        reviewAt: new Date().toISOString(),
      });
    }

    if (hasIssues) {
      // 有发现：appendReviewIssues + incReviewTurn。
      // turn 参数 = 新开启的这一轮（原 reviewTurn+1），与 appendReviewIssues 后 incReviewTurn 一致。
      const newTurn = topic.reviewTurn + 1;
      deps.store.appendReviewIssues(params.topicId, newTurn, issues);
      deps.store.incReviewTurn(params.topicId);
    }

    // gate 记录：issues 非空记「review-found」（gate 名区分纯文件通过 vs 有发现），
    // issues 为空记「file-exists+non-empty」pass。
    deps.store.appendGateHistory(params.topicId, {
      phase: "review",
      action: "review",
      gate: hasIssues ? "review-found" : "file-exists+non-empty",
      result: "pass",
      report: hasIssues
        ? `${issues.length} issue(s) found in turn ${topic.reviewTurn + 1}`
        : undefined,
      progressive: true,
    });
    passed = true;
  });

  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after review: ${params.topicId}`);
  }

  const result: ActionResult = {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("review", updated),
  };
  if (!passed!) {
    (result as Record<string, unknown>).mustFix = gateReport;
  }
  return result;
}

// ── handleReviewFix ─────────────────────────────────────────

/**
 * handleReviewFix — review loop 内的修复动作（progressive，status 留在 reviewed）。
 *
 * 数据流：
 *   校验 fixes[].issueId 存在且 status=open（不存在/已 fixed 抛 CwError）
 *     → 事务{ 逐条 fixReviewIssue（标记 fixed + 记 commitHash/resolution/fixedAtTurn）
 *       + appendGateHistory(review-fix, pass, progressive) }
 *     → reload → buildNextAction("review_fix")（指向下一轮 review）。
 *
 * 不做 commit 校验：commitHash 只记录审计，不验证真实性（与 dev 的 commit 校验语义不同）。
 * fixedAtTurn = 当前 reviewTurn（修复发生在哪一轮 review 之后）。
 *
 * 失败路径：fixes 里某 issueId 不存在于 topic.reviewIssues 或 status !== open → throw CwError。
 */
export function handleReviewFix(
  params: ReviewFixParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const fixes = params.fixes ?? [];

  // 校验所有 issueId 存在且 status=open（校验在事务外做，避免事务内 throw 触发回滚后又 throw）。
  const issueMap = new Map<string, ReviewIssue>();
  for (const issue of topic.reviewIssues) {
    issueMap.set(issue.id, issue);
  }
  for (const fix of fixes) {
    const issue = issueMap.get(fix.issueId);
    if (!issue) {
      throw new CwError(
        `review_fix issueId 不存在: ${fix.issueId}（不存在于 topic.reviewIssues）`,
      );
    }
    if (issue.status !== "open") {
      throw new CwError(
        `review_fix issueId ${fix.issueId} 状态为 ${issue.status}（只能修 open 的 issue）`,
      );
    }
  }

  // fixedAtTurn = 当前 reviewTurn（修复发生在哪一轮 review 之后）。
  const fixedAtTurn = topic.reviewTurn;

  deps.store.transaction(() => {
    for (const fix of fixes) {
      deps.store.fixReviewIssue(params.topicId, fix.issueId, {
        commitHash: fix.commitHash,
        resolution: fix.resolution,
        fixedAtTurn,
      });
    }
    deps.store.appendGateHistory(params.topicId, {
      phase: "review_fix",
      action: "review_fix",
      gate: "review-fix",
      result: "pass",
      report: `${fixes.length} issue(s) fixed at turn ${fixedAtTurn}`,
      progressive: true,
    });
  });

  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after review_fix: ${params.topicId}`);
  }

  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("review_fix", updated),
  };
}

// ── handleRetrospect ────────────────────────────────────────

/**
 * 校验 agent 提交的 retrospectData（轻量校验，不阻断 gate）。
 *
 * 只校验 knownRisks 和 processIssues 是数组 + 内部结构。derived 不校验——
 * cw 自动算并覆盖，不信任 agent 填的 derived。
 *
 * 校验通过 → 返回 { knownRisks, processIssues }；失败 → 返回 { error }。
 * 调用方（handleRetrospect）按有无 error 决定是否存储 + 是否记 warning。
 */
function validateRetrospectData(
  raw: unknown,
): { knownRisks?: RetrospectKnownRisk[]; processIssues?: string[]; error?: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: "retrospectData 不是对象" };
  }
  const obj = raw as Record<string, unknown>;

  // knownRisks 校验
  let knownRisks: RetrospectKnownRisk[] | undefined;
  if (obj.knownRisks !== undefined) {
    if (!Array.isArray(obj.knownRisks)) {
      return { error: "retrospectData.knownRisks 不是数组" };
    }
    const validated: RetrospectKnownRisk[] = [];
    for (let i = 0; i < obj.knownRisks.length; i++) {
      const item = obj.knownRisks[i] as Record<string, unknown>;
      if (!item || typeof item !== "object") {
        return { error: `knownRisks[${i}] 不是对象` };
      }
      const severity = item.severity;
      if (severity !== "high" && severity !== "medium" && severity !== "low") {
        return { error: `knownRisks[${i}].severity 必须是 high/medium/low` };
      }
      if (typeof item.area !== "string" || typeof item.description !== "string") {
        return { error: `knownRisks[${i}].area/description 必须是字符串` };
      }
      validated.push({
        severity,
        area: item.area,
        description: item.description,
        unverified: item.unverified === true,
      });
    }
    knownRisks = validated;
  }

  // processIssues 校验
  let processIssues: string[] | undefined;
  if (obj.processIssues !== undefined) {
    if (!Array.isArray(obj.processIssues)) {
      return { error: "retrospectData.processIssues 不是数组" };
    }
    for (let i = 0; i < obj.processIssues.length; i++) {
      if (typeof obj.processIssues[i] !== "string") {
        return { error: `processIssues[${i}] 不是字符串` };
      }
    }
    processIssues = obj.processIssues as string[];
  }

  return { knownRisks, processIssues };
}

/**
 * handleRetrospect — weak gate（文件存在 + 非空）+ 可选结构化数据，委托 gateAdvance。
 *
 * gate pass → status=retrospected + 记录 retrospectPath/retrospectAt artifacts +
 *   若提供 retrospectData：校验后存入 topic.retrospectData（derived 由 cw 自动算覆盖）。
 * gate fail → status 不变（仍 tested）+ nextAction 指回 retry。
 *
 * retrospectData 是可选增强，不阻断 gate——校验失败只记 warning，gate 仍 pass。
 */
export function handleRetrospect(
  params: RetrospectParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const path = params.retrospectPath ?? "";
  let retrospectWarning: string | undefined;

  const result = gateAdvance(
    "retrospect",
    "file-exists+non-empty",
    path,
    params.topicId,
    topic,
    deps,
    () => {
      deps.store.setArtifacts(params.topicId, {
        retrospectPath: path,
        retrospectAt: new Date().toISOString(),
      });

      // 结构化数据存储（可选，校验失败不阻断 gate）
      if (params.retrospectData !== undefined) {
        const validated = validateRetrospectData(params.retrospectData);
        if (validated.error) {
          retrospectWarning = `retrospectData 校验失败（已跳过存储）：${validated.error}`;
          return;
        }
        const derived = computeRetrospectDerived(topic);
        const data: RetrospectData = {
          derived,
          knownRisks: validated.knownRisks ?? [],
          processIssues: validated.processIssues ?? [],
        };
        deps.store.setRetrospectData(params.topicId, data);
      }
    },
  );

  // gate pass 但 retrospectData 校验失败 → warning 挂 mustFix（不阻断 status）
  if (retrospectWarning) {
    (result as Record<string, unknown>).mustFix = retrospectWarning;
  }
  return result;
}

// ── handleCloseout ──────────────────────────────────────────

/**
 * handleCloseout — 终态归档 + evidence 填充，委托 gateAdvance。
 *
 * gate pass → status=closed + onPass 回调事务内 reload 取 gateHistory 快照写入 evidence。
 * gate 用 topicDir 存在性（归档目录就绪）。gateAdvance 返回的 result 已含 evidence
 * （事务后 reload 的 updated.evidence）。
 */
export function handleCloseout(
  params: CloseoutParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  return gateAdvance(
    "closeout",
    "topicDir-exists",
    topic.topicDir,
    params.topicId,
    topic,
    deps,
    () => {
      // 事务内 reload：evidence.gateHistory 含全量历史（含本次 closeout pass 记录）。
      const fresh = deps.store.loadTopic(params.topicId);
      if (!fresh) {
        throw new Error(`topic not found after closeout: ${params.topicId}`);
      }
      const evidence: Evidence = {
        closedAt: new Date().toISOString(),
        coverage: fresh.testCases.length > 0
          ? fresh.testCases.filter((c) => c.status === "passed").length /
            fresh.testCases.length
          : 0,
        gateHistory: fresh.gateHistory,
      };
      deps.store.setEvidence(params.topicId, evidence);
    },
  );
}

// ── handleReplan ────────────────────────────────────────────

/**
 * replan 的 append-only 违规类型（4 种，plan.md 约束全保留）。
 */
type AppendOnlyViolation =
  | { type: "wave_deleted_committed"; waveId: string; reason: string }
  | { type: "wave_modified_committed"; waveId: string; reason: string }
  | { type: "case_deleted_passed"; caseId: string; reason: string }
  | { type: "case_modified_passed"; caseId: string; reason: string };

export interface ReplanSummary {
  addedWaves: string[];
  removedWaves: string[];
  addedCases: string[];
  removedCases: string[];
  statusChanged: string | null;
}

/**
 * validateAppendOnly — replan 的核心安全门（4 种违规检测全保留）。
 *
 * 规则：
 *   - 已 committed 的 wave 不可删（wave_deleted_committed）/ 不可改 changes/dependsOn（wave_modified_committed）
 *   - 已 passed 的 testCase 不可删（case_deleted_passed）/ 不可改 expected（case_modified_passed）
 *   - 未 committed/passed 的可删可改（修复残留的机制）
 *
 * 与旧版差异：砍掉 parallelGroup/issues/assertion/file/describe 字段比对（这些字段 lite 版已砍）。
 * wave 只比 changes + dependsOn；testCase 比 expected + layer + scenario + steps + executor +
 * requiresScreenshot + dependsOn（expected 是 judgeByExpected 基准，改了会让已 passed 的 case 失效）。
 */
function validateAppendOnly(
  newWaves: WaveSeed[],
  newCases: TestCaseSeed[],
  oldWaves: Wave[],
  oldTestCases: TestCase[],
): AppendOnlyViolation[] {
  const violations: AppendOnlyViolation[] = [];

  // Wave 校验：已 committed 的不可删/改。
  for (const old of oldWaves) {
    const match = newWaves.find((w) => w.id === old.id);
    if (!match) {
      if (old.committed !== null) {
        violations.push({
          type: "wave_deleted_committed",
          waveId: old.id,
          reason: `已 committed 的 wave ${old.id} 不能删除（commit ${old.committed}）`,
        });
      }
      // 未 committed 的 wave 被删 = 合法（修复残留）。
    } else if (old.committed !== null) {
      // 已 committed 的 wave 全字段不可改（lite 版只剩 changes + dependsOn）。
      const differ: string[] = [];
      if (JSON.stringify(match.changes ?? []) !== JSON.stringify(old.changes)) {
        differ.push("changes");
      }
      if (JSON.stringify(match.dependsOn) !== JSON.stringify(old.dependsOn)) {
        differ.push("dependsOn");
      }
      if (differ.length > 0) {
        violations.push({
          type: "wave_modified_committed",
          waveId: old.id,
          reason: `已 committed 的 wave ${old.id} 的 ${differ.join("/")} 不能修改`,
        });
      }
    }
  }

  // TestCase 校验：已 passed 的不可删/改。
  for (const old of oldTestCases) {
    const match = newCases.find((c) => c.id === old.id);
    if (!match) {
      if (old.status === "passed") {
        violations.push({
          type: "case_deleted_passed",
          caseId: old.id,
          reason: `已 passed 的 testCase ${old.id} 不能删除`,
        });
      }
    } else if (old.status === "passed") {
      // 已 passed 的 testCase 语义字段不可改。
      // expected 是 judgeByExpected 基准——改了会让「已 passed」的判定失效，必须拒绝。
      const differ: string[] = [];
      if (
        JSON.stringify(match.expected ?? {}) !== JSON.stringify(old.expected ?? {})
      ) {
        differ.push("expected");
      }
      if ((match.layer as string) !== (old.layer as string)) differ.push("layer");
      if (match.scenario !== old.scenario) differ.push("scenario");
      if (match.steps !== old.steps) differ.push("steps");
      if (match.executor !== old.executor) differ.push("executor");
      const oldRs = old.requiresScreenshot;
      const newRs = match.requiresScreenshot;
      if (newRs !== oldRs) differ.push("requiresScreenshot");
      if (
        JSON.stringify(match.dependsOn ?? []) !== JSON.stringify(old.dependsOn ?? [])
      ) {
        differ.push("dependsOn");
      }
      if (differ.length > 0) {
        violations.push({
          type: "case_modified_passed",
          caseId: old.id,
          reason: `已 passed 的 testCase ${old.id} 的 ${differ.join("/")} 不能修改`,
        });
      }
    }
  }

  return violations;
}

/**
 * handleReplan — append-only dev-plan.json / test.json 同步。
 *
 * 支持两种输入（可同时提供）：
 *   - planJson → parseDevPlan + validateAppendOnly(waves, [legacyTestCases 兼容])
 *     → replaceUncommittedWaves（+旧格式 plan.json 的 legacyTestCases 也走 replaceUnpassedTestCases）
 *   - testJson → parseTestJson + validateAppendOnly(testCases) → replaceUnpassedTestCases
 *   - 都不提供 → throw CwError("replan requires --plan or --test")
 *
 * 数据流：
 *   parse（planJson→parseDevPlan / testJson→parseTestJson）→ validateAppendOnly（4 违规检测）
 *   → 事务{ replaceUncommittedWaves/replaceUnpassedTestCases → status 回退 planned
 *     → gatePassed 重算（dev+test，事务内同步——砍掉 cache_inconsistent guard 后的强依赖）
 *     → gateHistory(pass) } → buildNextAction
 *
 * status 回退语义：replan 的 nextStatus=planned（TRANSITIONS 表）。
 *   - current=planned → computeNextStatus("replan", planned) = planned（不变）
 *   - current=developed/tdd_inited → computeNextStatus("replan", ...) = planned（回退，让 dev 重新走）
 * replan 后必须重新走 dev（即使之前 developed），因为可能追加了新 wave。
 *
 * 事务内同步 gatePassed（关键约束）：砍掉 cache_inconsistent guard 后，gatePassed 缓存漂移
 * 不再有 guard 兜底。replan 可能新增未 committed wave（dev gate 变 false）或新增 pending case
 * （test gate 变 false），必须在事务内同步 updateGatePassed，否则下次 dev/test 读到陈旧缓存。
 *
 * 失败路径：
 *   - parseDevPlan/parseTestJson throw（format/schema）→ propagate（exit ≥1）
 *   - append-only 违规 → throw（exit ≥1，AC-6.2）
 *   - planJson 和 testJson 都不提供 → throw CwError
 */
export function handleReplan(
  params: ReplanParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const hasPlan = params.planJson !== undefined;
  const hasTest = params.testJson !== undefined;
  if (!hasPlan && !hasTest) {
    throw new CwError("replan requires --plan or --test");
  }

  // 解析 planJson（dev-plan.json，只含 waves + 可选 legacyTestCases）。
  const parsedPlan: ParsedDevPlan | null = hasPlan
    ? parseDevPlan(params.planJson)
    : null;

  // 解析 testJson（testCases + 可选 testRunner）。
  const parsedTest = hasTest ? parseTestJson(params.testJson) : null;

  // append-only 校验（核心安全门，4 违规类型）。
  // waves 来源：parsedPlan.waves（planJson 提供时）；cases 来源：testJson 优先，
  // 回退到 planJson 的 legacyTestCases（旧格式兼容）。
  const newWaves = parsedPlan?.waves ?? [];
  const newCases =
    parsedTest?.testCases ?? parsedPlan?.legacyTestCases ?? [];
  const violations = validateAppendOnly(
    newWaves,
    newCases,
    topic.waves,
    topic.testCases,
  );
  if (violations.length > 0) {
    const mustFix = violations.map((v) => `[${v.type}] ${v.reason}`).join("\n");
    throw new CwError(
      `replan append-only 校验失败：已 committed/passed 的不可删改。\nmustFix:\n${mustFix}`,
    );
  }

  const statusBefore = topic.status;

  // 事务内 append-only 写入 + status 回退 + gatePassed 同步。
  deps.store.transaction(() => {
    // waves replace：只在 planJson 提供时执行。
    if (parsedPlan) {
      const committedWaveIds = new Set(
        topic.waves.filter((w) => w.committed !== null).map((w) => w.id),
      );
      const uncommittedNew = parsedPlan.waves.filter(
        (w) => !committedWaveIds.has(w.id),
      );
      deps.store.replaceUncommittedWaves(params.topicId, uncommittedNew);
    }

    // testCases replace：testJson 或旧格式 planJson 的 legacyTestCases 提供时执行。
    if (newCases.length > 0) {
      const passedCaseIds = new Set(
        topic.testCases.filter((c) => c.status === "passed").map((c) => c.id),
      );
      const unpassedNew = newCases.filter((c) => !passedCaseIds.has(c.id));
      deps.store.replaceUnpassedTestCases(params.topicId, unpassedNew);
    }

    // 重新 load 拿最新数据（replace 已改表）。
    const reloaded = deps.store.loadTopic(params.topicId);
    if (!reloaded) {
      throw new Error(`topic not found after replan replace: ${params.topicId}`);
    }

    // status：developed/tdd_inited → planned（回退，让 dev gate progressive 重新评估）。
    const nextStatus = computeNextStatus("replan", reloaded.status);
    if (nextStatus !== reloaded.status) {
      deps.store.updateStatus(params.topicId, nextStatus);
    }

    // gatePassed 重算：必须在事务内同步。
    const devGatePassed = computeGatePassed("dev", reloaded);
    deps.store.updateGatePassed(params.topicId, "dev", devGatePassed);
    const testGatePassed = computeGatePassed("test", reloaded);
    deps.store.updateGatePassed(params.topicId, "test", testGatePassed);

    // replan 修改了 plan/testCases，旧的 review 闭环 + test 修复轨迹失效，清空重走。
    // resetReviewLoop：reviewIssues=[], reviewTurn=0。
    // resetTestLoop：testFixLog=[], testTurn=0。
    deps.store.resetReviewLoop(params.topicId);
    deps.store.resetTestLoop(params.topicId);

    deps.store.appendGateHistory(params.topicId, {
      phase: "plan",
      action: "replan",
      gate: "append-only-validator",
      result: "pass",
      report: JSON.stringify({
        addedWaves: newWaves
          .filter((w) => !topic.waves.some((o) => o.id === w.id))
          .map((w) => w.id),
        removedWaves: topic.waves
          .filter((w) => !newWaves.some((o) => o.id === w.id))
          .map((w) => w.id),
        addedCases: newCases
          .filter((c) => !topic.testCases.some((o) => o.id === c.id))
          .map((c) => c.id),
        statusChanged: nextStatus !== statusBefore ? `${statusBefore}→${nextStatus}` : null,
      }),
      progressive: true,
    });
  });

  // reload 拿最终状态构造返回。
  const finalTopic = deps.store.loadTopic(params.topicId);
  if (!finalTopic) {
    throw new Error(`topic not found after replan: ${params.topicId}`);
  }

  // buildNextAction("replan", topic) 内部按 dev/test gatePassed 分流。
  return {
    topicId: params.topicId,
    status: finalTopic.status,
    gatePassed: finalTopic.gatePassed,
    nextAction: buildNextAction("replan", finalTopic),
  };
}

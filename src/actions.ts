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

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  clarifyCheck,
  confirmClarifyCheck,
  devCheck,
  fileExistsCheck,
  isPathInsideWorkspace,
  planCheck,
  redLightCheck,
  reviewIssueCheck,
  runTestRunner,
  tddPlanCheck,
  testCheck,
} from "./gate.js";
import { runInit } from "./init.js";
import {
  type ParsedDevPlan,
  parseDevPlan,
  parseTestJson,
} from "./plan-parser.js";
import {
  buildNextAction,
  computeGatePassed,
  computeNextStatus,
  REVIEW_TURN_LIMIT,
  TEST_TURN_LIMIT,
} from "./state-machine.js";
import { computeRetrospectDerived } from "./stats.js";
import {
  type Action,
  type ActionDeps,
  type ActionResult,
  type Actual,
  type Assessment,
  type AssessmentDefect,
  type AssessmentType,
  type ClarifyRecord,
  CwError,
  type DefectSeverity,
  type Evidence,
  GuardError,
  type RetrospectData,
  type RetrospectKnownRisk,
  type ReviewFixSubmission,
  type ReviewIssue,
  type ProcessIssue,
  type ProcessIssueType,
  type ReviewIssueSubmission,
  type RuntimeEnv,
  type Status,
  type TestCase,
  type TestCaseSeed,
  type TestFixSubmission,
  type Topic,
  type Wave,
  type WaveSeed,
} from "./types.js";

// ── 纵向 gate 链：前序阶段完成度前置检查 ──────────────────────

/**
 * checkPhasePrerequisite — 在 handler 开头检查前序阶段完成度。
 *
 * 与 checkLinear（guard 层，防 status 跳步）正交：checkLinear 只看 status 是否合法，
 * 本函数看前序阶段的 gate 是否真过。blind follower agent 可能 status 合法但前序未完成
 * （如 dev progressive 调一次后 status=developed，但 W2 仍未 committed）。
 *
 * 四个关卡（守全部阶段）：
 *   - review  → dev gate（全 wave committed）
 *   - test    → review 完成度（issues 全 closed OR reviewTurn>=REVIEW_TURN_LIMIT 逃生阀）
 *   - retrospect → test 完成度（cases 全 passed OR testTurn>=TEST_TURN_LIMIT 逃生阀）
 *   - closeout → retrospect gate（gateHistory 有 pass 记录）
 *
 * 逃生阀（FR-3）：test/review 达 turn 上限时放行，防 test↔test_fix / review↔review_fix 死循环。
 * dev/retrospect 无逃生阀（dev 是入口无前序；retrospect 是 single-shot gate 无 turn 概念）。
 *
 * 未通过时 throw GuardError(code=phase_prerequisite_failed)，status 不流转、不进 gateHistory
 * （走 guard 拒绝路径，非 gate fail 路径——不留 retry 的 nextAction，agent 需回去补前置阶段）。
 *
 * 设计取舍（WARNING-3）：不记 gateHistory 意味着越权尝试在 closeout 的 evidence 快照里不可见。
 * 这与 illegal_transition（guard 层）历史一致——guard 拒绝都不留痕，只有 gate fail 才记 gateHistory。
 * 若需审计越权行为，应在 CLI 层写独立 audit log，而非破坏 guard 拒绝的一致性。
 */
function assertPhasePrerequisite(action: Action, topic: Topic): void {
  switch (action) {
    case "review": {
      // dev gate = 全 wave committed（≥1 且全 committed !== null）
      if (!computeGatePassed("dev", topic)) {
        throw new GuardError(
          "phase_prerequisite_failed",
          `review 前置失败：dev 阶段未完成（有 wave 未 committed）。需先调 cw(dev) 提交所有 wave 的 commit。`,
          "dev",
          topic.status,
        );
      }
      return;
    }
    case "test": {
      // review 完成度 = reviewIssues 全 closed（无 open）
      // 空数组陷阱防护：从未 review 过时 reviewIssues=[] 且 every() 返回 true，
      // 必须额外要求 computeGatePassed("review")（gateHistory 有 review pass 记录）。
      const reviewGatePassed = computeGatePassed("review", topic);
      const hasOpenIssues = topic.reviewIssues.some((i) => i.status === "open");
      const escapeByTurn = topic.reviewTurn >= REVIEW_TURN_LIMIT;
      if ((!reviewGatePassed || hasOpenIssues) && !escapeByTurn) {
        throw new GuardError(
          "phase_prerequisite_failed",
          `test 前置失败：review 阶段未完成（有 open issue 未闭环或 review 未过 gate）。需先调 cw(review_fix) 修复 issue 或 cw(review) 闭环。`,
          "review",
          topic.status,
        );
      }
      return;
    }
    case "retrospect": {
      // test 完成度 = 全 testCase passed
      const testGatePassed = computeGatePassed("test", topic);
      const escapeByTurn = topic.testTurn >= TEST_TURN_LIMIT;
      if (!testGatePassed && !escapeByTurn) {
        const pending = topic.testCases
          .filter((c) => c.status !== "passed")
          .map((c) => c.id);
        throw new GuardError(
          "phase_prerequisite_failed",
          `retrospect 前置失败：test 阶段未完成（testCase ${pending.join(", ")} 未 passed）。需先调 cw(test_fix) 修复或 cw(test) 重跑。`,
          "test",
          topic.status,
        );
      }
      return;
    }
    case "closeout": {
      // retrospect gate = gateHistory 有 retrospect pass 记录
      if (!computeGatePassed("retrospect", topic)) {
        throw new GuardError(
          "phase_prerequisite_failed",
          `closeout 前置失败：retrospect 阶段未完成（retrospect gate 未过）。需先调 cw(retrospect) 提交复盘。`,
          "retrospect",
          topic.status,
        );
      }
      return;
    }
    default:
      // dev / create / clarify / plan / tdd_plan / *_fix / replan / abort / assess 无前置检查
      return;
  }
}



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
  /**
   * FR-2: spec 替换模式。提供时，CW 调 replaceSpecSections（旧 spec 归档到 specHistory + 替换为新内容），
   * 而非默认的 appendSpecSections。值是替换原因（agent 提供）。
   * 替换内容从 clarifyJson 的 specSections 字段取。
   */
  replaceSpec?: string;
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

/** FR-1: confirm_clarify 参数——用户确认需求后提交，流转 created → clarify_confirmed。 */
export interface ConfirmClarifyParams {
  action: "confirm_clarify";
  topicId: string;
}

/** FR-4: spec_review 参数——提交 spec 审查报告 + 结构化 issue。 */
export interface SpecReviewParams {
  action: "spec_review";
  topicId: string;
  /** spec-review.md 路径（必填，gate 校验存在+非空）。 */
  specReviewPath: string;
  /** 结构化 issue（stdin 传入，空数组=无问题）。 */
  issues?: ReviewIssueSubmission[];
}

/** FR-4: spec_review_fix 参数——提交 issue 修复。 */
export interface SpecReviewFixParams {
  action: "spec_review_fix";
  topicId: string;
  fixes: ReviewFixSubmission[];
}

/** FR-5: plan_review 参数——提交 plan 审查报告 + 结构化 issue。 */
export interface PlanReviewParams {
  action: "plan_review";
  topicId: string;
  /** plan-review.md 路径（必填，gate 校验存在+非空）。 */
  planReviewPath: string;
  /** 结构化 issue（stdin 传入，空数组=无问题）。 */
  issues?: ReviewIssueSubmission[];
}

/** FR-5: plan_review_fix 参数——提交 issue 修复。 */
export interface PlanReviewFixParams {
  action: "plan_review_fix";
  topicId: string;
  fixes: ReviewFixSubmission[];
}

/** FR-3: abort 参数——终止 topic，流转到 aborted 终态。 */
export interface AbortParams {
  action: "abort";
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

export interface AssessParams {
  action: "assess";
  topicId: string;
  type: AssessmentType;
  /** 评分（可选，1-5）。不强制——有些评估是定性的。 */
  score?: number;
  notes: string;
  /** type=defect 时必填。 */
  defect?: {
    severity: DefectSeverity;
    area: string;
    rootCause: string;
    foundInReview: boolean;
  };
}

export type CwParams =
  | CreateParams
  | ClarifyParams
  | ConfirmClarifyParams
  | SpecReviewParams
  | SpecReviewFixParams
  | PlanParams
  | PlanReviewParams
  | PlanReviewFixParams
  | TddPlanParams
  | DevParams
  | TestParams
  | RetrospectParams
  | ReviewParams
  | ReviewFixParams
  | TestFixParams
  | CloseoutParams
  | ReplanParams
  | AbortParams
  | AssessParams;

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
    specReviewIssues: [],
    specReviewTurn: 0,
    planReviewIssues: [],
    planReviewTurn: 0,
    testFixLog: [],
    testTurn: 0,
    assessments: [],
    specSections: [],
    specHistory: [],
  };

  deps.store.transaction(() => {
    deps.store.insertTopic(topic);
  });

  const nextAction = buildNextAction("create", topic);

  // create 后检测项目文档基建（不阻断）。必备文档缺失/骨架态/漂移时，在 guidance 前拼 init 提示。
  // 引导 agent 先调 `cw init` 扫描补齐，再继续 clarify/plan。
  // 这是建议非硬阻断——保持 create 的 guard ok:true 哲学（单重 guard 只防跳步，入口不加硬门槛）。
  const initResult = runInit(deps.workspacePath);
  if (!initResult.ready) {
    const notReady = initResult.docs.filter(
      (d) => d.level === "必备" && d.status !== "ok",
    );
    if (notReady.length > 0) {
      const summary = notReady
        .map((d) => `${d.path}（${d.status === "missing" ? "缺失" : d.status === "skeleton" ? "骨架态" : "漂移"}）`)
        .join("、");
      nextAction.guidance =
        `⚠️ 项目文档基建未就绪。必备文档：${summary}。\n` +
        `建议先调 \`cw init\` 扫描文档基建（返回缺失清单 + 骨架内容），` +
        `按用户确认用 write 工具补齐后再继续。\n` +
        `（建议不阻断——可直接继续 clarify/plan，但文档缺失会影响后续阶段质量）\n\n` +
        nextAction.guidance;
    }
  }

  return {
    topicId,
    status: topic.status,
    gatePassed: topic.gatePassed,
    nextAction,
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

  // FR-9: replaceSpec 提供但未带 specSections 时记录 warning（不阻断，事务后挂到 result）。
  let replaceWarning: string | undefined;
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
    // 聚合所有条目的 specSections（挂在 ParsedClarify 上，不在 ClarifySeed 上）。
    const allSpecSections = parsed.flatMap((item) => item.specSections ?? []);
    if (params.replaceSpec !== undefined) {
      // FR-2: spec 替换模式——旧 spec 整体快照归档到 specHistory，替换为新内容。
      // replaceSpec 值是替换原因（agent 提供）。
      if (allSpecSections.length > 0) {
        deps.store.replaceSpecSections(
          params.topicId,
          allSpecSections,
          params.replaceSpec,
        );
      } else {
        // FR-9: replaceSpec flag 提供但未带 specSections → warning 不阻断。
        replaceWarning =
          "replaceSpec 已设但未提供 specSections，本次未执行替换也未追加。若要替换 spec 需在同一条 clarifyJson 里带完整 specSections。";
      }
    } else {
      // 默认 append 模式——progressive append-only，与 clarifyRecord/adr 同语义。
      if (allSpecSections.length > 0) {
        deps.store.appendSpecSections(params.topicId, allSpecSections);
      }
    }
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
  if (replaceWarning) {
    (result as Record<string, unknown>).warning = replaceWarning;
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
  const check = planCheck(params.planJson, topic.specSections, topic.workspacePath);

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
    // 持久化 objective（如果 dev-plan.json 提供了与 create 时不同的 objective）。
    // create 时存的 objective 可能是占位/草稿，plan 阶段 dev-plan.json 的 objective 更权威——同步覆盖。
    if (parsed.objective && parsed.objective !== topic.objective) {
      deps.store.updateObjective(params.topicId, parsed.objective);
    }
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
 * 红灯校验（事务外）：testRunner 必选（tddPlanCheck 保证），对 redCheck=true 的 testCase 跑测试命令，
 * 确认测试如期失败（红灯）。红灯 fail（绿灯 = 先写了实现）阻断 status 流转——回退到 planned，
 * nextAction 指回 tdd_plan retry，mustFix 提示 agent 确保测试在实现缺失时 fail。
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
  const check = tddPlanCheck(params.testJson, topic.specSections, topic.workspacePath);

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
  } else if (check.warning) {
    // gate pass 但 AC 映射可能未全覆盖 → warning 挂 mustFix（不阻断 status，对称 handlePlan 的 warning 处理）。
    (result as Record<string, unknown>).mustFix = `AC 映射 warning（不阻断）：${check.warning}`;
  }

  // 红灯校验（事务外执行——调 execFileSync 跑测试命令，不能在事务内持锁）。
  // testRunner 已必选（tddPlanCheck 保证），红灯校验阻断 status 流转：
  //   - 红灯 fail（绿灯 = 先写了实现）→ 回退 status 到 plan_reviewed，nextAction 指回 tdd_plan retry
  //   - 红灯 pass 或无 redCheck case → 正常流转到 tdd_inited
  // FR-5: tdd_plan 前置从 planned 改为 plan_reviewed，红灯回退也改为 plan_reviewed。
  const redWarnings = runRedLightVerification(updated);
  if (redWarnings.length > 0) {
    // 红灯校验失败——回退 status（tdd_inited → plan_reviewed），gatePassed 置 false。
    deps.store.transaction(() => {
      deps.store.updateStatus(params.topicId, "plan_reviewed");
      deps.store.updateGatePassed(params.topicId, "tdd_plan", false);
      deps.store.appendGateHistory(params.topicId, {
        phase: "tdd_plan",
        action: "tdd_plan",
        gate: "tdd-red-light",
        result: "fail",
        report: redWarnings.join("\n"),
        progressive: false,
      });
    });
    // reload 拿回退后的状态
    const rolledBack = deps.store.loadTopic(params.topicId);
    if (!rolledBack) {
      throw new Error(`topic not found after red-light rollback: ${params.topicId}`);
    }
    const failResult: ActionResult = {
      topicId: params.topicId,
      status: rolledBack.status,
      gatePassed: rolledBack.gatePassed,
      nextAction: buildNextAction("tdd_plan", rolledBack),
    };
    (failResult as Record<string, unknown>).mustFix =
      `红灯校验失败（测试已 pass = 实现已存在 = 违反 TDD）。必须确保测试在实现缺失时 fail（红灯），再提交。\n${redWarnings.join("\n")}`;
    return failResult;
  }

  // 红灯校验通过（或无 redCheck case）→ 记 pass 到 gateHistory。
  deps.store.transaction(() => {
    deps.store.appendGateHistory(params.topicId, {
      phase: "tdd_plan",
      action: "tdd_plan",
      gate: "tdd-red-light",
      result: "pass",
      progressive: false,
    });
  });
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

/** exit_zero / script 模式 CW 自动执行的结果（exact 模式不在此表，沿用 agent actual）。 */
type AutoExecResult = { actual: Actual } | { error: string };

/** 从 execFileSync 抛出的异常里取退出 status；无 status（spawn 失败/timeout）返回 null。 */
function readExitStatus(e: unknown): number | null {
  if (typeof e === "object" && e !== null && "status" in e) {
    const status = (e as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return null;
}

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
  // 纵向 gate 链：test 前置检查（review 完成度 + 逃生阀）
  assertPhasePrerequisite("test", topic);

  // FR-4: handleTest 全覆盖校验——params.cases 的 caseId 集合必须 == topic.testCases 的 id 集合。
  // 防止 agent 选择性提交（如只跑单测跳过 e2e），导致部分 testCase 永远 pending。
  // 不跑的 case 必须在 tdd_plan/replan 阶段就移除，不能在 test 时静默跳过。
  // 校验在事务外做——throw 前不修改任何 testCase。
  const rawIds = params.cases.map((c) => c.caseId);
  const submittedIds = new Set(rawIds);
  const expectedIds = new Set(topic.testCases.map((c) => c.id));
  // 重复 caseId 检查：Set 去重会掩盖重复提交（[{E1},{E1}] 的 Set 大小=1，与单 testCase topic 匹配，
  // 但事务内循环两次 updateTestCase(E1) 产生脏数据）。用 rawIds.length vs Set.size 捕捉。
  const duplicates = rawIds.filter(
    (id, i) => rawIds.indexOf(id) !== i,
  );
  const missing = [...expectedIds].filter((id) => !submittedIds.has(id));
  const extra = [...submittedIds].filter((id) => !expectedIds.has(id));
  if (duplicates.length > 0 || missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (duplicates.length > 0)
      parts.push(`重复 [${[...new Set(duplicates)].join(", ")}]`);
    if (missing.length > 0) parts.push(`缺失 [${missing.join(", ")}]`);
    if (extra.length > 0) parts.push(`多余 [${extra.join(", ")}]`);
    throw new CwError(
      `handleTest 的 cases 与 topic.testCases 的 id 集合不一致：${parts.join("，")}。每个 testCase 必须提交恰好一次结果（不跑的 case 在 tdd_plan/replan 阶段移除，不能在 test 时跳过）。`,
    );
  }

  // W3: exit_zero / script 模式——CW 自己执行命令/脚本拿 exitCode，不信 agent 提交的 actual。
  // 纯函数 testCheck/judgeByExpected 保持只读 actual.exitCode 判定（AC-8）；执行放这里（AC-2/AC-3）。
  // 返回 caseId → 回填后的 actual；exact 模式不在表里（沿用 agent 提交的 actual.text/url）。
  // spawn 异常（脚本不存在/无执行权限）记为该 case 的 failed reason，不抛断整批。
  const executedActualByCaseId = new Map<string, AutoExecResult>();
  const workspacePath = topic.workspacePath;

  // ── exit_zero：去重执行一次 testRunner，把同一 exitCode 归一化给每个 exit_zero case ──
  // 设计（plan_review PR3）：去重/共享在 handleTest 这层，不在纯函数 testCheck——保护 AC-8。
  const exitZeroCaseIds = params.cases
    .filter((s) => {
      const tc = topic.testCases.find((c) => c.id === s.caseId);
      return tc?.expected.type === "exit_zero";
    })
    .map((s) => s.caseId);

  if (exitZeroCaseIds.length > 0) {
    let runOutcome: AutoExecResult;
    if (!topic.testRunner) {
      runOutcome = {
        error: "exit_zero case 缺 testRunner 配置（tdd_plan 阶段必须写入 testRunner）",
      };
    } else {
      try {
        // runTestRunner（gate.ts）按 mode 执行 testRunner command，可能经 shell（command 串如 "npx vitest run"）。
        // AC-10 只约束 handleTest 体内新增的 script 执行不经 shell；exit_zero 复用既有 runTestRunner。
        const ran = runTestRunner(topic.testRunner, workspacePath);
        runOutcome = { actual: { exitCode: ran.exitCode } };
      } catch (e) {
        // runTestRunner 把 spawn 异常/命令不存在包成 CwError 抛出——基础设施异常，非测试失败。
        runOutcome = {
          error: `testRunner 执行异常：${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    for (const id of exitZeroCaseIds) executedActualByCaseId.set(id, runOutcome);
  }

  // ── script：各自执行 expected.path（execFileSync 直接执行，不经 shell） ──
  // AC-9: 不传 argv、不注入 ACTUAL env（脚本自包含读系统状态）。stdio ignore 不回流 actual 数据。
  // AC-10: execFileSync 直接执行带 shebang+可执行位的脚本，不经 shell 解析（shell 默认 false）。
  // R1（symlink 绕过修复）：path 虽在 tddPlanCheck 沙箱校验过，但 tdd_plan → dev → test 之间
  // path 可能被换成指向 workspace 外的 symlink（tdd_plan 时文件不存在无法 realpath，lexical 通过；
  // dev 阶段写入 symlink 后 real 目标越界）。执行前用 isPathInsideWorkspace 再 realpath 校验一次，
  // 此时文件已存在，realpath 能解析 symlink，拦下运行时替换攻击。
  for (const submission of params.cases) {
    const tc = topic.testCases.find((c) => c.id === submission.caseId);
    if (tc?.expected.type !== "script") continue;
    const relPath = tc.expected.path;
    if (!isPathInsideWorkspace(relPath, workspacePath)) {
      executedActualByCaseId.set(submission.caseId, {
        error: `script.path 越出 workspace 沙箱（含 symlink 绕过）：${relPath}`,
      });
      continue;
    }
    const absPath = resolve(workspacePath, relPath);
    try {
      execFileSync(absPath, {
        cwd: workspacePath,
        stdio: "ignore",
        timeout: 30000,
        encoding: "utf8",
      });
      executedActualByCaseId.set(submission.caseId, { actual: { exitCode: 0 } });
    } catch (e) {
      // execFileSync 非 0 退出抛异常，exit code 在 e.status（业务结果，非基础设施异常）。
      const code = readExitStatus(e);
      if (code !== null) {
        executedActualByCaseId.set(submission.caseId, { actual: { exitCode: code } });
      } else {
        // spawn 异常（脚本不存在/无执行权限/timeout）→ 基础设施异常，记 error（该 case 走 failed）。
        executedActualByCaseId.set(submission.caseId, {
          error: `script 执行异常（${relPath}）：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }

  const caseResults: TestCaseResult[] = [];

  deps.store.transaction(() => {
    for (const submission of params.cases) {
      const tc = topic.testCases.find((c) => c.id === submission.caseId);
      if (!tc) {
        throw new CwError(`case not found: ${submission.caseId}`);
      }

      // exit_zero/script：用 CW 执行回填的 actual（含 exitCode），忽略 agent 提交的 actual。
      // exact：用 agent 提交的 actual.text/url 做 === 比较。
      const autoExec = executedActualByCaseId.get(submission.caseId);
      let judgedStatus: "passed" | "failed";
      let judgedReason: string;
      let judgedActual: Actual | undefined;
      if (autoExec && "error" in autoExec) {
        // 执行基础设施异常（spawn 失败/testRunner 缺失）→ 直接 failed，不走 testCheck。
        judgedStatus = "failed";
        judgedReason = autoExec.error;
        judgedActual = submission.actual;
      } else {
        judgedActual = autoExec ? autoExec.actual : submission.actual;
        const judged = testCheck(tc, judgedActual, submission.screenshotPath);
        judgedStatus = judged.status;
        judgedReason = judged.reason;
      }
      const patch: Partial<TestCase> = {
        status: judgedStatus,
        actual: judgedActual as object | undefined,
        screenshotPath: submission.screenshotPath,
        ...(judgedStatus === "failed" ? { failureReason: judgedReason } : {}),
      };
      // judgedStatus === "passed" 时清理之前的 failureReason（retry 场景）。
      if (judgedStatus === "passed") {
        patch.failureReason = undefined;
      }
      deps.store.updateTestCase(params.topicId, submission.caseId, patch);
      caseResults.push({
        caseId: submission.caseId,
        status: judgedStatus,
        failureReason: judgedStatus === "failed" ? judgedReason : undefined,
      });
    }

    const failedCount = caseResults.filter((c) => c.status !== "passed").length;

    // testTurn 的 inc 不在这里做——改在 handleTestFix 里 inc（每轮修复 = turn+1）。
    // 熔断由 buildNextAction 基于 testTurn >= TEST_TURN_LIMIT 判定。
    // 这里不碰 testTurn，避免 progressive 多次 test 提交重复计数。

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

  // 校验所有 caseId 存在且 status=failed（校验在事务外做）。
  // 对称 review_fix 的 status=open 守门——只允许对真正失败的 case 提交 fix，
  // 防止对已 passed/pending 的 case 提交 fix 污染 testFixLog + 虚增 testTurn。
  const caseMap = new Map(topic.testCases.map((c) => [c.id, c]));
  for (const fix of fixes) {
    const tc = caseMap.get(fix.caseId);
    if (!tc) {
      throw new CwError(
        `test_fix caseId 不存在: ${fix.caseId}（不存在于 topic.testCases）`,
      );
    }
    if (tc.status !== "failed") {
      throw new CwError(
        `test_fix caseId ${fix.caseId} 当前 status=${tc.status}，只有 failed 的 case 才能提交 test_fix` +
          `（对称 review_fix 的 status=open 守门——对已 passed 的 case 提交 fix 会污染审计）`,
      );
    }
  }

  // turn = 当前 testTurn（修复发生在哪一轮 test 之后，记录用）。
  // inc 在事务内做：记录审计用 turn（inc 前的值），inc 后 testTurn = turn+1。
  // 这样每轮 test_fix 推进计数：首次 fail 时 testTurn=0 → test_fix 记 turn=0 + inc→1，
  // 再 fail → test_fix 记 turn=1 + inc→2，…… 达 TEST_TURN_LIMIT 后 buildNextAction 熔断。
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
    // 每轮 test_fix 推进 testTurn 计数（与 review 在 handleReview 里 inc 对称）。
    deps.store.incTestTurn(params.topicId);
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
  // 纵向 gate 链：review 前置检查（dev gate 必须通过）
  assertPhasePrerequisite("review", topic);

  const path = params.reviewPath ?? "";
  const issues = params.issues ?? [];
  const hasIssues = issues.length > 0;

  // reviewPath 提供时做 fileExistsCheck（前置条件）。fail → gate fail，status 不变。
  const fileCheck =
    path.length > 0 ? fileExistsCheck(path) : { result: "pass" as const, report: "" };
  // passed 在 transaction 外算完（fileCheck 已经算完，无需在闭包内赋值）。
  const passed = fileCheck.result === "pass";

  deps.store.transaction(() => {
    if (!passed) {
      // 前置条件失败 → gate fail，status 不变。
      deps.store.appendGateHistory(params.topicId, {
        phase: "review",
        action: "review",
        gate: "file-exists+non-empty",
        result: "fail",
        report: fileCheck.report,
        progressive: true,
      });
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
        review: { path, at: new Date().toISOString() },
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
  if (!passed) {
    (result as Record<string, unknown>).mustFix = fileCheck.report;
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
 * commitHash 只做格式校验（7-40 字符 hex git hash），不做存在性校验——保持 audit-only 语义
 * （与 dev 的 commit 校验语义不同，不调 git 验证真实性）。
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

  // commitHash 格式校验（只查格式，不做存在性校验——保持 audit-only 语义）。
  // git hash：7-40 字符的十六进制字符串（短/长 hash 均允许）。
  // ReviewFixSubmission.commitHash 现在类型上可选（其它 review 阶段不强制），
  // 但 review_fix（代码审查修复）要求必填 commitHash——这里保持必填校验。
  const GIT_HASH_RE = /^[0-9a-f]{7,40}$/;
  for (const fix of fixes) {
    if (!fix.commitHash) {
      throw new CwError(
        `review_fix 需要 commitHash（代码审查修复必须提供 git commit hash）`,
      );
    }
    if (!GIT_HASH_RE.test(fix.commitHash)) {
      throw new CwError(
        `review_fix commitHash 格式无效: "${fix.commitHash}"（应为 7-40 字符十六进制 git hash）`,
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

// ── handleSpecReview ─────────────────────────────────────────

/**
 * handleSpecReview — FR-4: spec 语义审查 handler（progressive，多轮 loop）。
 *
 * gate：fileExistsCheck(specReviewPath) + reviewIssueCheck(issues)。
 * 有 issue 则 appendSpecReviewIssues + incSpecReviewTurn；无 issue → nextAction=plan；
 * 有 issue 未达上限 → spec_review_fix；达上限 → 强制前推 plan。
 *
 * 与 handleReview 的区别：
 *   - specReviewPath 必填（review.reviewPath 可选）
 *   - 用 topic.specReviewIssues / appendSpecReviewIssues / incSpecReviewTurn
 *   - phase="spec_review"，gate 名 "file-exists+issue-schema" / "review-found"
 */
export function handleSpecReview(
  params: SpecReviewParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const path = params.specReviewPath ?? "";
  const issues = params.issues ?? [];
  const hasIssues = issues.length > 0;

  // 先跑 reviewIssueCheck 校验 issue 结构合法性（dimension 必填等）。
  const issueCheck = hasIssues
    ? reviewIssueCheck(issues)
    : {
        result: "pass" as const,
        report: "",
        parsed: [] as ReviewIssueSubmission[],
      };

  const fileCheck =
    path.length > 0
      ? fileExistsCheck(path)
      : { result: "fail" as const, report: "specReviewPath 必填" };
  const passed = fileCheck.result === "pass" && issueCheck.result === "pass";

  deps.store.transaction(() => {
    if (!passed) {
      const failReport =
        fileCheck.result === "fail" ? fileCheck.report : issueCheck.report;
      deps.store.appendGateHistory(params.topicId, {
        phase: "spec_review",
        action: "spec_review",
        gate: "file-exists+issue-schema",
        result: "fail",
        report: failReport,
        progressive: true,
      });
      return;
    }

    deps.store.updateStatus(
      params.topicId,
      computeNextStatus("spec_review", topic.status),
    );
    deps.store.updateGatePassed(params.topicId, "spec_review", true);

    if (path.length > 0) {
      deps.store.setArtifacts(params.topicId, {
        specReview: { path, at: new Date().toISOString() },
      });
    }

    if (hasIssues && issueCheck.parsed) {
      const newTurn = topic.specReviewTurn + 1;
      deps.store.appendSpecReviewIssues(params.topicId, newTurn, issueCheck.parsed);
      deps.store.incSpecReviewTurn(params.topicId);
    }

    deps.store.appendGateHistory(params.topicId, {
      phase: "spec_review",
      action: "spec_review",
      gate: hasIssues ? "review-found" : "file-exists+issue-schema",
      result: "pass",
      report: hasIssues
        ? `${issues.length} issue(s) found in turn ${topic.specReviewTurn + 1}`
        : undefined,
      progressive: true,
    });
  });

  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after spec_review: ${params.topicId}`);
  }

  const result: ActionResult = {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("spec_review", updated),
  };
  if (!passed) {
    const failReport =
      fileCheck.result === "fail" ? fileCheck.report : issueCheck.report;
    (result as Record<string, unknown>).mustFix = failReport;
  }
  return result;
}

// ── handleSpecReviewFix ──────────────────────────────────────

/**
 * handleSpecReviewFix — FR-4: spec_review loop 内的修复动作（progressive）。
 *
 * 与 handleReviewFix 同构，区别：
 *   - 用 topic.specReviewIssues / fixSpecReviewIssue
 *   - commitHash 不校验（spec_review 修复可能走 cw clarify 内部，无独立 commit）
 *   - fixedAtTurn = topic.specReviewTurn；gate 名 "spec-review-fix"
 */
export function handleSpecReviewFix(
  params: SpecReviewFixParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const fixes = params.fixes ?? [];

  // 校验 issueId 存在且 status=open（事务外做，避免事务内 throw 触发回滚后又 throw）。
  const issueMap = new Map<string, ReviewIssue>();
  for (const issue of topic.specReviewIssues) {
    issueMap.set(issue.id, issue);
  }
  for (const fix of fixes) {
    const issue = issueMap.get(fix.issueId);
    if (!issue) {
      throw new CwError(
        `spec_review_fix issueId 不存在: ${fix.issueId}（不存在于 topic.specReviewIssues）`,
      );
    }
    if (issue.status !== "open") {
      throw new CwError(
        `spec_review_fix issueId ${fix.issueId} 状态为 ${issue.status}（只能修 open 的 issue）`,
      );
    }
  }
  // commitHash 不校验（spec_review 修复可选）。

  const fixedAtTurn = topic.specReviewTurn;

  deps.store.transaction(() => {
    for (const fix of fixes) {
      deps.store.fixSpecReviewIssue(params.topicId, fix.issueId, {
        ...(fix.commitHash ? { commitHash: fix.commitHash } : {}),
        resolution: fix.resolution,
        fixedAtTurn,
      });
    }
    deps.store.appendGateHistory(params.topicId, {
      phase: "spec_review_fix",
      action: "spec_review_fix",
      gate: "spec-review-fix",
      result: "pass",
      report: `${fixes.length} issue(s) fixed at turn ${fixedAtTurn}`,
      progressive: true,
    });
  });

  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after spec_review_fix: ${params.topicId}`);
  }

  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("spec_review_fix", updated),
  };
}

// ── handlePlanReview ─────────────────────────────────────────

/**
 * handlePlanReview — FR-5: plan 语义审查 handler（progressive，多轮 loop）。
 *
 * gate：fileExistsCheck(planReviewPath) + reviewIssueCheck(issues)。
 * 有 issue 则 appendPlanReviewIssues + incPlanReviewTurn；无 issue → nextAction=tdd_plan；
 * 有 issue 未达上限 → plan_review_fix；达上限 → 强制前推 tdd_plan。
 *
 * 与 handleSpecReview 同构（spec→plan, specReview→planReview, SR→PR）。
 */
export function handlePlanReview(
  params: PlanReviewParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const path = params.planReviewPath ?? "";
  const issues = params.issues ?? [];
  const hasIssues = issues.length > 0;

  // 先跑 reviewIssueCheck 校验 issue 结构合法性（dimension 必填等）。
  const issueCheck = hasIssues
    ? reviewIssueCheck(issues)
    : {
        result: "pass" as const,
        report: "",
        parsed: [] as ReviewIssueSubmission[],
      };

  const fileCheck =
    path.length > 0
      ? fileExistsCheck(path)
      : { result: "fail" as const, report: "planReviewPath 必填" };
  const passed = fileCheck.result === "pass" && issueCheck.result === "pass";

  deps.store.transaction(() => {
    if (!passed) {
      const failReport =
        fileCheck.result === "fail" ? fileCheck.report : issueCheck.report;
      deps.store.appendGateHistory(params.topicId, {
        phase: "plan_review",
        action: "plan_review",
        gate: "file-exists+issue-schema",
        result: "fail",
        report: failReport,
        progressive: true,
      });
      return;
    }

    deps.store.updateStatus(
      params.topicId,
      computeNextStatus("plan_review", topic.status),
    );
    deps.store.updateGatePassed(params.topicId, "plan_review", true);

    if (path.length > 0) {
      deps.store.setArtifacts(params.topicId, {
        planReview: { path, at: new Date().toISOString() },
      });
    }

    if (hasIssues && issueCheck.parsed) {
      const newTurn = topic.planReviewTurn + 1;
      deps.store.appendPlanReviewIssues(params.topicId, newTurn, issueCheck.parsed);
      deps.store.incPlanReviewTurn(params.topicId);
    }

    deps.store.appendGateHistory(params.topicId, {
      phase: "plan_review",
      action: "plan_review",
      gate: hasIssues ? "review-found" : "file-exists+issue-schema",
      result: "pass",
      report: hasIssues
        ? `${issues.length} issue(s) found in turn ${topic.planReviewTurn + 1}`
        : undefined,
      progressive: true,
    });
  });

  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after plan_review: ${params.topicId}`);
  }

  const result: ActionResult = {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("plan_review", updated),
  };
  if (!passed) {
    const failReport =
      fileCheck.result === "fail" ? fileCheck.report : issueCheck.report;
    (result as Record<string, unknown>).mustFix = failReport;
  }
  return result;
}

// ── handlePlanReviewFix ──────────────────────────────────────

/**
 * handlePlanReviewFix — FR-5: plan_review loop 内的修复动作（progressive）。
 *
 * 与 handleSpecReviewFix 同构（spec→plan, specReview→planReview, SR→PR）。
 */
export function handlePlanReviewFix(
  params: PlanReviewFixParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const fixes = params.fixes ?? [];

  // 校验 issueId 存在且 status=open（事务外做）。
  const issueMap = new Map<string, ReviewIssue>();
  for (const issue of topic.planReviewIssues) {
    issueMap.set(issue.id, issue);
  }
  for (const fix of fixes) {
    const issue = issueMap.get(fix.issueId);
    if (!issue) {
      throw new CwError(
        `plan_review_fix issueId 不存在: ${fix.issueId}（不存在于 topic.planReviewIssues）`,
      );
    }
    if (issue.status !== "open") {
      throw new CwError(
        `plan_review_fix issueId ${fix.issueId} 状态为 ${issue.status}（只能修 open 的 issue）`,
      );
    }
  }
  // commitHash 不校验（plan_review 修复可选）。

  const fixedAtTurn = topic.planReviewTurn;

  deps.store.transaction(() => {
    for (const fix of fixes) {
      deps.store.fixPlanReviewIssue(params.topicId, fix.issueId, {
        ...(fix.commitHash ? { commitHash: fix.commitHash } : {}),
        resolution: fix.resolution,
        fixedAtTurn,
      });
    }
    deps.store.appendGateHistory(params.topicId, {
      phase: "plan_review_fix",
      action: "plan_review_fix",
      gate: "plan-review-fix",
      result: "pass",
      report: `${fixes.length} issue(s) fixed at turn ${fixedAtTurn}`,
      progressive: true,
    });
  });

  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after plan_review_fix: ${params.topicId}`);
  }

  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("plan_review_fix", updated),
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
): {
  knownRisks?: RetrospectKnownRisk[];
  processIssues?: ProcessIssue[];
  error?: string;
} {
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

  // processIssues 校验（FR-3 升级：每条必须是对象 + type 合法 + description 非空）
  // as const satisfies 让本数组与 types.ts 的 ProcessIssueType 同源：
  // 若 ProcessIssueType 加/删值，这里编译期报错，避免硬编码漂移。
  const VALID_ISSUE_TYPES = [
    "pattern",
    "oneOff",
    "observation",
    "uncategorized",
  ] as const satisfies readonly ProcessIssueType[];
  let processIssues: ProcessIssue[] | undefined;
  if (obj.processIssues !== undefined) {
    if (!Array.isArray(obj.processIssues)) {
      return { error: "retrospectData.processIssues 不是数组" };
    }
    const validatedIssues: ProcessIssue[] = [];
    for (let i = 0; i < obj.processIssues.length; i++) {
      const item = obj.processIssues[i];
      if (!item || typeof item !== "object") {
        return { error: `processIssues[${i}] 不是对象` };
      }
      const rec = item as Record<string, unknown>;
      if (
        typeof rec.type !== "string" ||
        !VALID_ISSUE_TYPES.includes(rec.type as ProcessIssueType)
      ) {
        return {
          error: `processIssues[${i}].type 必须是 pattern/oneOff/observation/uncategorized`,
        };
      }
      if (
        typeof rec.description !== "string" ||
        rec.description.trim().length === 0
      ) {
        return { error: `processIssues[${i}].description 必须是非空字符串` };
      }
      validatedIssues.push({
        type: rec.type as ProcessIssueType,
        description: rec.description,
      });
    }
    processIssues = validatedIssues;
  }

  return { knownRisks, processIssues };
}

/**
 * handleRetrospect — weak gate（文件存在 + 非空）+ 必选结构化数据，委托 gateAdvance。
 *
 * gate pass → status=retrospected + 记录 retrospectPath/retrospectAt artifacts +
 *   校验 retrospectData 后存入 topic.retrospectData（derived 由 cw 自动算覆盖）。
 * gate fail → status 不变（仍 tested）+ nextAction 指回 retry。
 *
 * retrospectData 必选——未传或校验失败 = gate fail（阻断 status 流转）。
 */
export function handleRetrospect(
  params: RetrospectParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  // 纵向 gate 链：retrospect 前置检查（test 完成度 + 逃生阀）
  assertPhasePrerequisite("retrospect", topic);

  const path = params.retrospectPath ?? "";

  // retrospectData 必选校验（gate 前置）。
  // 未传 → gate fail。校验失败 → gate fail。
  if (params.retrospectData === undefined) {
    deps.store.transaction(() => {
      deps.store.appendGateHistory(params.topicId, {
        phase: "retrospect",
        action: "retrospect",
        gate: "file-exists+non-empty",
        result: "fail",
        report: "retrospectData 必填——通过 stdin 传入 knownRisks + processIssues JSON",
        progressive: false,
      });
    });
    const updated = deps.store.loadTopic(params.topicId);
    if (!updated) {
      throw new Error(`topic not found after retrospect fail: ${params.topicId}`);
    }
    const failResult: ActionResult = {
      topicId: params.topicId,
      status: updated.status,
      gatePassed: updated.gatePassed,
      nextAction: buildNextAction("retrospect", updated),
    };
    (failResult as Record<string, unknown>).mustFix =
      "retrospectData 必填——通过 stdin 传入 knownRisks + processIssues JSON。\n" +
      "格式：echo '{\"knownRisks\":[...],\"processIssues\":[...]}' | cw retrospect --topicId <id> --retrospectPath <path>";
    return failResult;
  }

  const validated = validateRetrospectData(params.retrospectData);
  if (validated.error) {
    deps.store.transaction(() => {
      deps.store.appendGateHistory(params.topicId, {
        phase: "retrospect",
        action: "retrospect",
        gate: "file-exists+non-empty",
        result: "fail",
        report: `retrospectData 校验失败：${validated.error}`,
        progressive: false,
      });
    });
    const updated = deps.store.loadTopic(params.topicId);
    if (!updated) {
      throw new Error(`topic not found after retrospect fail: ${params.topicId}`);
    }
    const failResult: ActionResult = {
      topicId: params.topicId,
      status: updated.status,
      gatePassed: updated.gatePassed,
      nextAction: buildNextAction("retrospect", updated),
    };
    (failResult as Record<string, unknown>).mustFix =
      `retrospectData 校验失败：${validated.error}`;
    return failResult;
  }

  const result = gateAdvance(
    "retrospect",
    "file-exists+non-empty",
    path,
    params.topicId,
    topic,
    deps,
    () => {
      deps.store.setArtifacts(params.topicId, {
        retrospect: { path, at: new Date().toISOString() },
      });

      const derived = computeRetrospectDerived(topic);
      const data: RetrospectData = {
        derived,
        knownRisks: validated.knownRisks ?? [],
        processIssues: validated.processIssues ?? [],
      };
      deps.store.setRetrospectData(params.topicId, data);

      // FR-5 / AC-5：无 pattern 类型的 processIssue 时追加 warning（不阻断 gate）。
      // processIssues 全 oneOff/observation/uncategorized 时，提示 agent 自省未识别
      // 可泛化流程模式——结果仍为 pass（不阻断流转），只在 gateHistory 留软引导痕迹。
      const hasPattern = (validated.processIssues ?? []).some(
        (issue) => issue.type === "pattern",
      );
      if (!hasPattern) {
        deps.store.appendGateHistory(params.topicId, {
          phase: "retrospect",
          action: "retrospect",
          gate: "process-pattern-check",
          result: "pass",
          report:
            "warning: processIssues 无 type=pattern 条目——自省未识别可泛化流程模式，建议从一次性失误抽象出模式",
          progressive: false,
        });
      }
    },
  );

  return result;
}

// ── handleCloseout ──────────────────────────────────────────

/**
 * handleCloseout — 终态归档 + evidence 填充，委托 gateAdvance。
 *
 * FR-2: closeout 前先校验 artifacts 记录的 review/retrospect 文件存在（如有记录）。
 * 文件缺失 → gate fail（artifacts-exist），status 不变，mustFix 列出缺失路径。
 * artifacts 无记录时不阻断（向后兼容：旧 topic 可能没走过 review/retrospect）。
 *
 * artifacts 校验通过后才走 gateAdvance（topicDir 存在性 gate），gate pass →
 * status=closed + onPass 回调事务内 reload 取 gateHistory 快照写入 evidence。
 */
export function handleCloseout(
  params: CloseoutParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  // 纵向 gate 链：closeout 前置检查（retrospect gate 必须通过）
  assertPhasePrerequisite("closeout", topic);

  // FR-2: 先校验 artifacts 记录的 review/retrospect 文件存在（如果有记录）。
  const missingPaths: string[] = [];
  if (topic.artifacts?.review?.path && !existsSync(topic.artifacts.review.path)) {
    missingPaths.push(`review: ${topic.artifacts.review.path}`);
  }
  if (
    topic.artifacts?.retrospect?.path &&
    !existsSync(topic.artifacts.retrospect.path)
  ) {
    missingPaths.push(`retrospect: ${topic.artifacts.retrospect.path}`);
  }
  if (missingPaths.length > 0) {
    const report = `closeout artifacts 文件不存在: ${missingPaths.join(", ")}`;
    deps.store.transaction(() => {
      deps.store.appendGateHistory(params.topicId, {
        phase: "closeout",
        action: "closeout",
        gate: "artifacts-exist",
        result: "fail",
        report,
        progressive: false,
      });
    });
    const updated = deps.store.loadTopic(params.topicId);
    const failResult: ActionResult = {
      topicId: params.topicId,
      status: updated?.status ?? topic.status,
      gatePassed: updated?.gatePassed ?? topic.gatePassed,
      nextAction: buildNextAction("closeout", updated ?? topic),
    };
    (failResult as Record<string, unknown>).mustFix = report;
    return failResult;
  }

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

// ── handleConfirmClarify ───────────────────────────────────

/**
 * handleConfirmClarify — FR-1: clarify 阶段用户确认 gate。
 *
 * gate 条件：至少 1 条 resolved/skipped 的 clarifyRecord（confirmClarifyCheck）。
 * gate pass → status 流转 created → clarify_confirmed + gatePassed + gateHistory。
 * gate fail → status 不变 + gateHistory(fail) + mustFix。
 *
 * confirm_clarify 不生成文档——文档由 gen-spec 只读命令生成。
 * confirm_clarify 只做 gate + 状态流转。
 */
export function handleConfirmClarify(
  params: ConfirmClarifyParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const check = confirmClarifyCheck(topic);

  let passed: boolean;
  deps.store.transaction(() => {
    if (check.result === "fail") {
      deps.store.appendGateHistory(params.topicId, {
        phase: "confirm_clarify",
        action: "confirm_clarify",
        gate: "has-clarify-record",
        result: "fail",
        report: check.report,
        progressive: false,
      });
      passed = false;
      return;
    }
    deps.store.updateStatus(
      params.topicId,
      computeNextStatus("confirm_clarify", topic.status),
    );
    deps.store.updateGatePassed(params.topicId, "confirm_clarify", true);
    deps.store.appendGateHistory(params.topicId, {
      phase: "confirm_clarify",
      action: "confirm_clarify",
      gate: "has-clarify-record",
      result: "pass",
      progressive: false,
    });
    passed = true;
  });

  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after confirm_clarify: ${params.topicId}`);
  }

  const result: ActionResult = {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("confirm_clarify", updated),
  };
  if (!passed!) {
    (result as Record<string, unknown>).mustFix = check.report;
  }
  return result;
}

// ── handleAbort ────────────────────────────────────────────

/**
 * handleAbort — FR-3: 终止 topic，流转到 aborted 终态。
 *
 * 无 gate（abort 无条件执行——agent 调了就是确认要终止）。
 * status 流转到 aborted，gateHistory 记录 abort 事件。
 * aborted 是终态，不可恢复。
 */
export function handleAbort(
  params: AbortParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  deps.store.transaction(() => {
    deps.store.updateStatus(
      params.topicId,
      computeNextStatus("abort", topic.status),
    );
    deps.store.appendGateHistory(params.topicId, {
      phase: "abort",
      action: "abort",
      gate: "user-requested",
      result: "pass",
      progressive: false,
      report: `aborted from status=${topic.status}`,
    });
  });

  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after abort: ${params.topicId}`);
  }

  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("abort", updated),
  };
}

// ── handleReplan ────────────────────────────────────────────

/**
 * replan 的 append-only 违规类型（4 种，plan.md 约束全保留）。
 */
type AppendOnlyViolation =
  | { type: "wave_deleted_committed"; waveId: string; reason: string }
  | { type: "wave_modified_committed"; waveId: string; reason: string }
  | { type: "case_deleted_passed"; caseId: string; reason: string }
  | { type: "case_modified_passed"; caseId: string; reason: string }
  | { type: "case_expected_tampered_failed"; caseId: string; reason: string };

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

  // TestCase 校验：已 passed 的不可删/改；failed 的 expected 不可改（防作弊）。
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
    } else if (old.status === "failed") {
      // failed 的 testCase expected 不可改——防「fail → 改 expected 匹配 actual → pass」作弊。
      // 其他语义字段（layer/scenario/steps 等）允许调整（replan 可能需要重构测试）。
      if (
        JSON.stringify(match.expected ?? {}) !== JSON.stringify(old.expected ?? {})
      ) {
        violations.push({
          type: "case_expected_tampered_failed",
          caseId: old.id,
          reason:
            `已 failed 的 testCase ${old.id} 的 expected 不能修改` +
            `——防止「fail → 改 expected 匹配 actual → pass」作弊路径`,
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
 * status 回退语义（D7: 条件回退）：
 *   - hasPlan（plan 改了）→ 回退到 planned（plan 变了需重走 plan_review → tdd_plan）
 *   - hasTest only（plan 没变）→ 回退到 plan_reviewed（plan_review 仍有效，直接重走 tdd_plan）
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
  // 只校验本次实际改动的部分：
  //   - planJson 提供时 → 校验 waves（+ legacyTestCases 如有）
  //   - testJson 提供时 → 校验 testCases
  // --test-only 模式不校验 waves（waves 未提交，不参与变更）。
  const violations: AppendOnlyViolation[] = [];
  if (parsedPlan) {
    const newWaves = parsedPlan.waves;
    // planJson 里的 legacyTestCases（旧格式兼容）也要校验。
    // 新格式 dev-plan.json 不含 testCases → legacyCases=[]，此时不碰 testCase 校验
    // （oldTestCases 传 []，避免把 topic 已有的 passed testCase 误判为"被删除"）。
    const legacyCases = parsedPlan.legacyTestCases ?? [];
    violations.push(
      ...validateAppendOnly(
        newWaves,
        legacyCases,
        topic.waves,
        legacyCases.length > 0 ? topic.testCases : [],
      ),
    );
  }
  if (parsedTest) {
    // --test 模式只校验 testCases，waves 传空跳过（oldWaves=[] → 不产生 wave 违规）
    const newCases = parsedTest.testCases;
    violations.push(
      ...validateAppendOnly([], newCases, [], topic.testCases),
    );
  }
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
    const newCases =
      parsedTest?.testCases ?? parsedPlan?.legacyTestCases ?? [];
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

    // D7: replan 条件回退。
    // hasPlan（plan 改了）→ 回退到 planned（需重走 plan_review → tdd_plan）
    // hasTest only（plan 没变）→ 回退到 plan_reviewed（plan_review 仍有效，直接重走 tdd_plan）
    const targetStatus: Status = hasPlan ? "planned" : "plan_reviewed";
    if (targetStatus !== reloaded.status) {
      deps.store.updateStatus(params.topicId, targetStatus);
    }

    // gatePassed 重算：必须在事务内同步。
    const devGatePassed = computeGatePassed("dev", reloaded);
    deps.store.updateGatePassed(params.topicId, "dev", devGatePassed);
    const testGatePassed = computeGatePassed("test", reloaded);
    deps.store.updateGatePassed(params.topicId, "test", testGatePassed);

    // replan 修改了 plan/testCases，旧的闭环数据按改动范围选择性清空：
    //   - hasPlan（代码会变）→ review 审的旧代码失效 → resetReviewLoop
    //     + 旧 testFixLog 是旧代码修复轨迹，新代码下无意义 → resetTestLoop
    //   - hasTest && !hasPlan（只改 testCases，代码没变）→ review 数据仍有效，不 reset
    //     只有 testCases 变了 → resetTestLoop
    // 核心区分：--test only 时代码不变，review 结论（reviewIssues）仍然成立。
    if (hasPlan) {
      deps.store.resetReviewLoop(params.topicId);
      deps.store.resetTestLoop(params.topicId);
      deps.store.resetPlanReviewLoop(params.topicId);
    } else if (hasTest) {
      deps.store.resetTestLoop(params.topicId);
    }

    deps.store.appendGateHistory(params.topicId, {
      phase: "plan",
      action: "replan",
      gate: "append-only-validator",
      result: "pass",
      report: JSON.stringify({
        addedWaves: (parsedPlan?.waves ?? [])
          .filter((w) => !topic.waves.some((o) => o.id === w.id))
          .map((w) => w.id),
        removedWaves: topic.waves
          .filter((w) => !(parsedPlan?.waves ?? []).some((o) => o.id === w.id))
          .map((w) => w.id),
        addedCases: newCases
          .filter((c) => !topic.testCases.some((o) => o.id === c.id))
          .map((c) => c.id),
        statusChanged: targetStatus !== statusBefore ? `${statusBefore}→${targetStatus}` : null,
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

// ── handleAssess ────────────────────────────────────────────

/** 合法的 AssessmentType 集合（校验用）。 */
const VALID_ASSESSMENT_TYPES: ReadonlySet<AssessmentType> = new Set([
  "quality",
  "test",
  "stability",
  "defect",
]);

/** assess score 的合法区间（1-5 整数）。 */
const ASSESS_SCORE_MIN = 1;
const ASSESS_SCORE_MAX = 5;

/** 合法的 DefectSeverity 集合（校验用）。 */
const VALID_DEFECT_SEVERITIES: ReadonlySet<DefectSeverity> = new Set([
  "blocker",
  "major",
  "minor",
]);

/**
 * 校验 AssessParams 的入参完整性。
 *
 * 校验项：
 *   - notes 非空（至少一句话，trim 后长度 > 0）
 *   - type ∈ {quality, test, stability, defect}
 *   - score 若提供则 ∈ [1, 5]（整数）
 *   - type=defect 时 defect 必填且四字段完整（severity 合法 + area/rootCause 非空 + foundInReview 是 boolean）
 *   - type≠defect 时 defect 必须未提供（防止语义混淆）
 *
 * 校验失败 → throw CwError（exit 1），不返回半成品。
 * 与 clarifyCheck 的区别：assess 不走 gate 机制（无 gateHistory 记录），它是纯数据追加。
 */
function validateAssessParams(params: AssessParams): void {
  if (!params.notes || params.notes.trim().length === 0) {
    throw new CwError("assess 的 --notes 不能为空（至少一句话）");
  }

  if (!VALID_ASSESSMENT_TYPES.has(params.type)) {
    throw new CwError(
      `assess 的 --type 非法: ${params.type}（合法值: quality/test/stability/defect）`,
    );
  }

  if (params.score !== undefined) {
    if (
      !Number.isInteger(params.score) ||
      params.score < ASSESS_SCORE_MIN ||
      params.score > ASSESS_SCORE_MAX
    ) {
      throw new CwError(
        `assess 的 --score 必须是 ${ASSESS_SCORE_MIN}-${ASSESS_SCORE_MAX} 的整数（当前: ${params.score}）`,
      );
    }
  }

  if (params.type === "defect") {
    if (!params.defect) {
      throw new CwError("assess 的 type=defect 时 --defect 必填（severity/area/rootCause/foundInReview）");
    }
    const d = params.defect;
    if (!VALID_DEFECT_SEVERITIES.has(d.severity)) {
      throw new CwError(
        `assess defect.severity 非法: ${d.severity}（合法值: blocker/major/minor）`,
      );
    }
    if (typeof d.area !== "string" || d.area.trim().length === 0) {
      throw new CwError("assess defect.area 不能为空");
    }
    if (typeof d.rootCause !== "string" || d.rootCause.trim().length === 0) {
      throw new CwError("assess defect.rootCause 不能为空");
    }
    if (typeof d.foundInReview !== "boolean") {
      throw new CwError("assess defect.foundInReview 必须是 boolean（true/false）");
    }
  } else if (params.defect !== undefined) {
    // type≠defect 时不应提供 defect（防止语义混淆——非缺陷评估带缺陷详情无意义）。
    throw new CwError(
      `assess 的 --defect 仅在 type=defect 时填写（当前 type=${params.type}）`,
    );
  }
}

/**
 * handleAssess — post-closeout 人工评估提交（progressive，不改 status）。
 *
 * 数据流：
 *   validateAssessParams（notes/type/score/defect 完整性）
 *     → 事务{ appendAssessment（store 分配 id AS1/AS2... + assessedAt） }
 *     → reload → buildNextAction("assess")
 *
 * progressive 语义：status 始终为 closed（TRANSITIONS.assess.nextStatus=closed, progressive=true），
 * 可多次调用，每次追加一条评估记录。不进任何 guidance 主链路（人工触发，不在导航里）。
 * 不走 gate 机制（不写 gateHistory）——与 clarify 的 gate 模式不同，assess 是纯数据追加。
 *
 * 失败路径：校验失败 → throw CwError（exit 1），不返回半成品。
 */
export function handleAssess(
  params: AssessParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  // 校验在事务外做（与 handleReviewFix/handleTestFix 的 caseId 校验同模式，
  // 避免事务内 throw 触发回滚后又 throw）。
  validateAssessParams(params);

  void topic; // assess 不读 topic 当前状态（progressive append-only）。

  const defect: AssessmentDefect | undefined = params.defect
    ? {
        severity: params.defect.severity,
        area: params.defect.area,
        rootCause: params.defect.rootCause,
        foundInReview: params.defect.foundInReview,
      }
    : undefined;

  let assignedId = "";
  deps.store.transaction(() => {
    assignedId = deps.store.appendAssessment(params.topicId, {
      type: params.type,
      score: params.score,
      notes: params.notes,
      defect,
    });
  });

  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after assess: ${params.topicId}`);
  }

  const result: ActionResult = {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("assess", updated),
  };
  // 暴露 assessments 摘要供调用方查看进度（id/type/score/defect 概要）。
  (result as Record<string, unknown>).assessmentId = assignedId;
  (result as Record<string, unknown>).assessments = updated.assessments.map(
    (a: Assessment) => ({
      id: a.id,
      type: a.type,
      score: a.score,
      defect: a.defect
        ? {
            severity: a.defect.severity,
            area: a.defect.area,
            rootCause: a.defect.rootCause,
            foundInReview: a.defect.foundInReview,
          }
        : undefined,
    }),
  );
  return result;
}

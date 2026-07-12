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
  type Actual,
  type ActionDeps,
  type ActionResult,
  type Evidence,
  type TestCase,
  type Topic,
  type Wave,
} from "./types.js";
import {
  devCheck,
  fileExistsCheck,
  planCheck,
  testCheck,
} from "./gate.js";
import {
  type ParsedLitePlan,
  parseLitePlan,
} from "./plan-parser.js";
import {
  buildNextAction,
  computeGatePassed,
  computeNextStatus,
} from "./state-machine.js";

// ── 参数类型（7 个 action）──────────────────────────────────

export interface CreateParams {
  action: "create";
  slug: string;
  objective: string;
  workspacePath?: string;
}

export interface PlanParams {
  action: "plan";
  topicId: string;
  /** plan.json 内容（CLI 从 stdin 读为对象）。 */
  planJson: unknown;
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
}

export interface ReviewParams {
  action: "review";
  topicId: string;
  /** changes/review.md 绝对路径。 */
  reviewPath?: string;
}

export interface CloseoutParams {
  action: "closeout";
  topicId: string;
}

export interface ReplanParams {
  action: "replan";
  topicId: string;
  /** 新版 plan.json（format 必须 === "lite"），整对象传入。 */
  planJson: unknown;
}

export type CwParams =
  | CreateParams
  | PlanParams
  | DevParams
  | TestParams
  | RetrospectParams
  | ReviewParams
  | CloseoutParams
  | ReplanParams;

// ── handleCreate ────────────────────────────────────────────

/**
 * handleCreate — 构造新 Topic 并持久化（入口 action）。
 *
 * 数据流：slug+objective → 构造 Topic → store.transaction{insertTopic} → buildNextAction。
 *
 * 与旧版差异：砍掉 tier 参数（lite-only 硬编码，不再收 tier）。
 * 失败路径：slug 重复 → insertTopic 抛 UNIQUE 约束错误（propagate 给 CLI 映射 exit code）。
 */
export function handleCreate(params: CreateParams, deps: ActionDeps): ActionResult {
  const topicId = buildTopicId(params.slug);
  const workspacePath = params.workspacePath ?? deps.workspacePath;
  const topicDir = join(workspacePath, ".xyz-harness", params.slug);

  const topic: Topic = {
    topicId,
    slug: params.slug,
    objective: params.objective,
    workspacePath,
    topicDir,
    createdAt: new Date().toISOString(),
    status: "created",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
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

// ── handlePlan ──────────────────────────────────────────────

/**
 * handlePlan — lite plan gate + 任务清单写入 + 状态流转。
 *
 * 数据流：planCheck → 事务{ pass: insertWaves/insertTestCases + 流转 + gatePassed(plan,true) + gateHistory(pass)
 *   | fail: gateHistory(fail)，status 不变 } → buildNextAction。
 *
 * gate fail 语义（关键约束）：status 不变（仍 created），gateHistory append fail，
 * gatePassed.plan 不设，nextAction 指回 plan retry（buildNextAction 内判定 computeGatePassed("plan")=false）。
 *
 * 失败路径：
 *   - planCheck fail → status 不变 + gateHistory fail（exit 0，agent 按 nextAction retry）
 *   - 注意：parseLitePlan 在 planCheck 内部调用，throw 被 planCheck 捕获转为 fail 结果，
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
    // planCheck 内部已调 parseLitePlan 成功，这里再调一次拿 parsed（parseLitePlan 是纯函数，幂等）。
    const parsed = parseLitePlan(params.planJson);
    deps.store.insertWaves(params.topicId, parsed.waves);
    deps.store.insertTestCases(params.topicId, parsed.testCases);
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
  }
  return result;
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
    validation: devCheck(task.commitHash, deps.workspacePath, task.waveId, topic),
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
        deps.store.setWaveCommitted(topic.topicId, t.waveId, t.commitHash);
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
        throw new Error(`case not found: ${submission.caseId}`);
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

    const failedCount = caseResults.filter((c) => c.status !== "passed").length;
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

// ── handleReview ────────────────────────────────────────────

/**
 * handleReview — weak gate（文件存在 + 非空），与 handleRetrospect 同模式。
 *
 * 插在 dev 和 test 之间。复盘证明「不强制 = 被跳过」——review gate 用文件存在性
 * 强制审查环节存在。reviewPath 不传时默认 .xyz-harness/<slug>/changes/review.md。
 *
 * gate pass → status=reviewed + gatePassed(review,true) + nextAction 指向 test。
 * gate fail → status 不变（仍 developed）+ nextAction 指回 review retry。
 */
export function handleReview(
  params: ReviewParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const path = params.reviewPath ?? "";
  const check = fileExistsCheck(path);

  let passed: boolean;
  deps.store.transaction(() => {
    deps.store.appendGateHistory(params.topicId, {
      phase: "review",
      action: "review",
      gate: "file-exists+non-empty",
      result: check.result,
      report: check.result === "fail" ? check.report : undefined,
      progressive: false,
    });
    if (check.result === "pass") {
      deps.store.updateStatus(
        params.topicId,
        computeNextStatus("review", topic.status),
      );
      deps.store.updateGatePassed(params.topicId, "review", true);
      passed = true;
      return;
    }
    passed = false;
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
    (result as Record<string, unknown>).mustFix = check.report;
  }
  return result;
}

// ── handleRetrospect ────────────────────────────────────────

/**
 * handleRetrospect — weak gate（文件存在 + 非空）。
 *
 * gate fail 语义：status 不变（仍 tested），gateHistory append fail，
 * gatePassed.retrospect 不设，nextAction 指回 retrospect retry。
 *
 * progressive 标记：retrospect 在 TRANSITIONS 里非 progressive（expectedStatuses=["tested"]，
 * nextStatus="retrospected"），但 gate 可多次重试（gate fail 时 status 不变，停在 tested 反复调）。
 */
export function handleRetrospect(
  params: RetrospectParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  const path = params.retrospectPath ?? "";
  const check = fileExistsCheck(path);

  let passed: boolean;
  deps.store.transaction(() => {
    deps.store.appendGateHistory(params.topicId, {
      phase: "retrospect",
      action: "retrospect",
      gate: "file-exists+non-empty",
      result: check.result,
      report: check.result === "fail" ? check.report : undefined,
      progressive: false,
    });
    if (check.result === "pass") {
      deps.store.updateStatus(
        params.topicId,
        computeNextStatus("retrospect", topic.status),
      );
      deps.store.updateGatePassed(params.topicId, "retrospect", true);
      passed = true;
      return;
    }
    passed = false;
  });

  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after retrospect: ${params.topicId}`);
  }

  const result: ActionResult = {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    nextAction: buildNextAction("retrospect", updated),
  };
  if (!passed!) {
    (result as Record<string, unknown>).mustFix = check.report;
  }
  return result;
}

// ── handleCloseout ──────────────────────────────────────────

/**
 * handleCloseout — 终态归档 + evidence 填充（含 gateHistory 快照）。
 *
 * gate pass → status=closed（终态不可逆）+ gatePassed(closeout,true) + gateHistory(pass)
 *   + evidence.gateHistory = 全量 gateHistory 快照（reviewer 指出不能砍，closeout 后回溯用）。
 * gate fail → status 不变 + gateHistory(fail) + nextAction 指回 closeout retry。
 *
 * closeout 的 fileExistsCheck 校验什么文件：plan.md 约束只说「retrospect/closeout gate 验文件存在」，
 * 未明确 closeout 验哪个文件。closeout 是归档动作，归档目标是 .xyz-harness/{slug}/ 目录已就绪——
 * 本轮用 topicDir 存在性作为 closeout gate（目录存在即 pass）。后续如需更细校验可补。
 */
export function handleCloseout(
  params: CloseoutParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  // closeout gate：topicDir 目录存在（归档目标就绪）。
  // 比 retrospect 的单文件校验弱，但 closeout 的实质校验（ARCHIVED 溯源等）本轮砍掉，只留目录存在。
  const check = fileExistsCheck(topic.topicDir);

  let passed: boolean;
  deps.store.transaction(() => {
    deps.store.appendGateHistory(params.topicId, {
      phase: "closeout",
      action: "closeout",
      gate: "topicDir-exists",
      result: check.result,
      report: check.result === "fail" ? check.report : undefined,
      progressive: false,
    });
    if (check.result === "fail") {
      passed = false;
      return;
    }
    deps.store.updateStatus(
      params.topicId,
      computeNextStatus("closeout", topic.status),
    );
    deps.store.updateGatePassed(params.topicId, "closeout", true);

    // 事务内 reload：evidence.gateHistory 含全量历史（含本次 closeout pass 记录）。
    const fresh = deps.store.loadTopic(params.topicId);
    if (!fresh) {
      throw new Error(`topic not found after closeout: ${params.topicId}`);
    }
    const evidence: Evidence = {
      closedAt: new Date().toISOString(),
      gateHistory: fresh.gateHistory,
    };
    deps.store.setEvidence(params.topicId, evidence);
    passed = true;
  });

  const updated = deps.store.loadTopic(params.topicId);
  if (!updated) {
    throw new Error(`topic not found after closeout: ${params.topicId}`);
  }

  const result: ActionResult = {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    evidence: updated.evidence,
    nextAction: buildNextAction("closeout", updated),
  };
  if (!passed!) {
    (result as Record<string, unknown>).mustFix = check.report;
  }
  return result;
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
  newWaves: ParsedLitePlan["waves"],
  newCases: ParsedLitePlan["testCases"],
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
 * handleReplan — append-only plan.json 同步。
 *
 * 数据流：
 *   parseLitePlan（format + schema 校验）→ validateAppendOnly（4 违规检测）
 *   → 事务{ replaceUncommittedWaves/replaceUnpassedTestCases → status 回退 planned
 *     → gatePassed 重算（dev+test，事务内同步——砍掉 cache_inconsistent guard 后的强依赖）
 *     → gateHistory(pass) } → buildNextAction
 *
 * status 回退语义：replan 的 nextStatus=planned（TRANSITIONS 表）。
 *   - current=planned → computeNextStatus("replan", planned) = planned（不变）
 *   - current=developed → computeNextStatus("replan", developed) = planned（回退，让 dev 重新走）
 * replan 后必须重新走 dev（即使之前 developed），因为可能追加了新 wave。
 *
 * 事务内同步 gatePassed（关键约束）：砍掉 cache_inconsistent guard 后，gatePassed 缓存漂移
 * 不再有 guard 兜底。replan 可能新增未 committed wave（dev gate 变 false）或新增 pending case
 * （test gate 变 false），必须在事务内同步 updateGatePassed，否则下次 dev/test 读到陈旧缓存。
 *
 * 失败路径：
 *   - parseLitePlan throw（format/schema）→ propagate（exit ≥1）
 *   - append-only 违规 → throw（exit ≥1，AC-6.2）
 */
export function handleReplan(
  params: ReplanParams,
  topic: Topic,
  deps: ActionDeps,
): ActionResult {
  // 解析新 plan.json（format === "lite" + typebox schema 校验）。
  const parsed = parseLitePlan(params.planJson);

  // append-only 校验（核心安全门，4 违规类型）。
  const violations = validateAppendOnly(
    parsed.waves,
    parsed.testCases,
    topic.waves,
    topic.testCases,
  );
  if (violations.length > 0) {
    const mustFix = violations.map((v) => `[${v.type}] ${v.reason}`).join("\n");
    throw new Error(
      `replan append-only 校验失败：已 committed/passed 的不可删改。\nmustFix:\n${mustFix}`,
    );
  }

  const statusBefore = topic.status;

  // 事务内 append-only 写入 + status 回退 + gatePassed 同步。
  deps.store.transaction(() => {
    // 只 replace 未 committed/passed 的（append-only：已 committed/passed 保留）。
    // replaceUncommittedWaves 内部已 filter 保留已 committed，所以直接传全量 parsed.waves 也行，
    // 但为语义清晰，这里仍只传未 committed 的新增（与旧版一致）。
    const committedWaveIds = new Set(
      topic.waves.filter((w) => w.committed !== null).map((w) => w.id),
    );
    const uncommittedNew = parsed.waves.filter(
      (w) => !committedWaveIds.has(w.id),
    );
    deps.store.replaceUncommittedWaves(params.topicId, uncommittedNew);

    const passedCaseIds = new Set(
      topic.testCases.filter((c) => c.status === "passed").map((c) => c.id),
    );
    const unpassedNew = parsed.testCases.filter(
      (c) => !passedCaseIds.has(c.id),
    );
    deps.store.replaceUnpassedTestCases(params.topicId, unpassedNew);

    // 重新 load 拿最新数据（replace 已改表）。
    const reloaded = deps.store.loadTopic(params.topicId);
    if (!reloaded) {
      throw new Error(`topic not found after replan replace: ${params.topicId}`);
    }

    // status：developed → planned（回退，让 dev gate progressive 重新评估）。
    const nextStatus = computeNextStatus("replan", reloaded.status);
    if (nextStatus !== reloaded.status) {
      deps.store.updateStatus(params.topicId, nextStatus);
    }

    // gatePassed 重算：必须在事务内同步。
    // replan 可能新增未 committed wave（dev gate 变 false）或新增 pending case（test gate 变 false）。
    // 砍掉 cache_inconsistent guard 后，这里是唯一的缓存同步点——不同步会导致下次 dev/test 读陈旧缓存。
    const devGatePassed = computeGatePassed("dev", reloaded);
    deps.store.updateGatePassed(params.topicId, "dev", devGatePassed);
    const testGatePassed = computeGatePassed("test", reloaded);
    deps.store.updateGatePassed(params.topicId, "test", testGatePassed);

    deps.store.appendGateHistory(params.topicId, {
      phase: "plan",
      action: "replan",
      gate: "append-only-validator",
      result: "pass",
      report: JSON.stringify({
        addedWaves: parsed.waves
          .filter((w) => !topic.waves.some((o) => o.id === w.id))
          .map((w) => w.id),
        removedWaves: topic.waves
          .filter((w) => !parsed.waves.some((o) => o.id === w.id))
          .map((w) => w.id),
        addedCases: parsed.testCases
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

  // buildNextAction("replan", topic) 内部按 dev/test gatePassed 分流（W2 已实现）。
  return {
    topicId: params.topicId,
    status: finalTopic.status,
    gatePassed: finalTopic.gatePassed,
    nextAction: buildNextAction("replan", finalTopic),
  };
}

/**
 * dispatch — engine 统一入口（新建，CLI 适配层调用此函数）。
 *
 * 职责：guard 校验 → action handler 分派 → 返回 ActionResult。
 * CLI 适配层只需调 dispatch(params, deps)，不需要知道内部 handler 路由。
 *
 * Level 1 接线：
 *   - loadTopic（非 create 时）
 *   - guard 三重校验
 *   - switch action → 调对应 handler
 *   - nextAction 由 handler 内部调 buildNextAction
 */

import { handleCreate, type CreateParams } from "./actions/create.js";
import { handlePlan, type PlanParams } from "./actions/plan.js";
import { guard } from "./state-machine.js";
import type { ActionDeps, ActionResult, CwAction, CwTopic } from "./types.js";

// ── 各 action 的参数类型（签名级 stub） ──────────────────────

interface ClarifyParams { action: "clarify"; topicId: string; clarifyJson: unknown }
interface DetailParams { action: "detail"; topicId: string; detailJson: unknown }
interface DevParams { action: "dev"; topicId: string; tasks: Array<{ waveId: string; commitHash: string }> }
interface TestParams { action: "test"; topicId: string; cases: Array<{ caseId: string; actual?: unknown; screenshotPath?: string; commitHash?: string; claimedStatus?: string }> }
interface RetrospectParams { action: "retrospect"; topicId: string; retrospectPath?: string }
interface CloseoutParams { action: "closeout"; topicId: string }
interface ReplanParams { action: "replan"; topicId: string; planJson: unknown }

export type CwParams =
  | CreateParams
  | PlanParams
  | ClarifyParams
  | DetailParams
  | DevParams
  | TestParams
  | RetrospectParams
  | CloseoutParams
  | ReplanParams;

/**
 * dispatch — engine 统一入口。
 *
 * 数据流：params → loadTopic（非 create）→ guard → handler → ActionResult。
 * 失败路径：
 *   - topic not found → throw
 *   - guard fail → throw GuardError（含 code + reason）
 *   - handler 异常 → propagate
 *
 * Level 1 接线：loadTopic → guard → switch/handler 调用。
 */
export function dispatch(params: CwParams, deps: ActionDeps): ActionResult {
  const action = params.action as CwAction;

  // create 不需要 loadTopic
  if (action === "create") {
    return handleCreate(params as CreateParams, deps);
  }

  // 非 create：loadTopic
  const nonCreateParams = params as Exclude<typeof params, CreateParams>;
  const topic = deps.store.loadTopic(nonCreateParams.topicId);
  if (!topic) {
    throw new Error(`topic not found: ${nonCreateParams.topicId}`);
  }

  // 三重 guard 校验
  const verdict = guard(action, topic, deps.store);
  if (!verdict.ok) {
    throw new GuardError(verdict.code, verdict.reason);
  }

  // action 分派（Level 1 接线：switch 调对应 handler）
  switch (action) {
    case "plan":
      return handlePlan(params as PlanParams, topic, deps);
    case "clarify":
      return handleClarify(params as ClarifyParams, topic, deps);
    case "detail":
      return handleDetail(params as DetailParams, topic, deps);
    case "dev":
      return handleDev(params as DevParams, topic, deps);
    case "test":
      return handleTest(params as TestParams, topic, deps);
    case "retrospect":
      return handleRetrospect(params as RetrospectParams, topic, deps);
    case "closeout":
      return handleCloseout(params as CloseoutParams, topic, deps);
    case "replan":
      return handleReplan(params as ReplanParams, topic, deps);
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

// ── GuardError（CLI 层按 code 映射 exit code） ─────────────

export class GuardError extends Error {
  constructor(
    public readonly code: string,
    public readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
    this.name = "GuardError";
  }
}

// ── handler stubs（签名级，方法体 throw NotImplementedError） ──

function handleClarify(_params: ClarifyParams, _topic: CwTopic, _deps: ActionDeps): ActionResult {
  throw new Error("NotImplementedError: handleClarify");
}

function handleDetail(_params: DetailParams, _topic: CwTopic, _deps: ActionDeps): ActionResult {
  throw new Error("NotImplementedError: handleDetail");
}

function handleDev(_params: DevParams, _topic: CwTopic, _deps: ActionDeps): ActionResult {
  // 叶子：per task GitValidator.validate → setWaveCommitted → computeNextStatus → buildNextAction
  throw new Error("NotImplementedError: handleDev");
}

function handleTest(_params: TestParams, _topic: CwTopic, _deps: ActionDeps): ActionResult {
  // 叶子：per case judgeByExpected/GitValidator → updateTestCase → buildNextAction
  throw new Error("NotImplementedError: handleTest");
}

function handleRetrospect(_params: RetrospectParams, _topic: CwTopic, _deps: ActionDeps): ActionResult {
  throw new Error("NotImplementedError: handleRetrospect");
}

function handleCloseout(_params: CloseoutParams, _topic: CwTopic, _deps: ActionDeps): ActionResult {
  throw new Error("NotImplementedError: handleCloseout");
}

function handleReplan(_params: ReplanParams, _topic: CwTopic, _deps: ActionDeps): ActionResult {
  // 叶子：append-only 校验 → appendWaves/appendTestCases → buildNextAction
  throw new Error("NotImplementedError: handleReplan");
}

/**
 * dispatch — engine 统一入口（lite 单轨极简版）。
 *
 * 职责：loadTopic（非 create）→ guard（单重 checkLinear）→ action handler 分派 → ActionResult。
 * CLI 适配层（cli.ts，Wave 4）只需调 dispatch(params, deps)，不需要知道内部 handler 路由。
 *
 * 与旧版的差异（重构 = 推倒重建）：
 * - 砍掉 ClarifyParams / DetailParams 分支（mid 专属）
 * - guard 从三重（checkLinear → checkPhaseCascade → checkCacheConsistency）砍为单重（checkLinear）
 * - guard 签名从 (action, topic, store) 改为 (action, topic)——纵深防御 guard 不再需要 store
 * - GuardError.code 类型从 GuardErrorCode 联合（illegal_transition/phase_incomplete/cache_inconsistent）
 *   缩窄为只含 "illegal_transition"（types.ts 已定义）
 *
 * 数据流：params → loadTopic（非 create）→ guard → handler → ActionResult。
 * 失败路径：
 *   - topic not found（非 create）→ throw Error（CLI 映射 exit 1）
 *   - guard fail → throw GuardError(code, reason)（CLI 映射 exit 1，stderr 含 code）
 *   - handler 异常（parse/append-only/case not found）→ propagate（CLI 映射 exit 2 内部异常）
 *
 * 关键约束：不要吞掉异常。GuardError 和 handler throw 都原样上抛，由 CLI 层决定 exit code。
 */

import {
  type AbortParams,
  type AssessParams,
  type ClarifyParams,
  type CloseoutParams,
  type ConfirmClarifyParams,
  type CreateParams,
  type CwParams,
  type DevParams,
  handleAbort,
  handleAssess,
  handleClarify,
  handleCloseout,
  handleConfirmClarify,
  handleCreate,
  handleDev,
  handlePlan,
  handlePlanReview,
  handlePlanReviewFix,
  handleReplan,
  handleRetrospect,
  handleReview,
  handleReviewFix,
  handleSpecReview,
  handleSpecReviewFix,
  handleTddPlan,
  handleTest,
  handleTestFix,
  type PlanParams,
  type PlanReviewParams,
  type PlanReviewFixParams,
  type ReplanParams,
  type RetrospectParams,
  type ReviewFixParams,
  type ReviewParams,
  type SpecReviewParams,
  type SpecReviewFixParams,
  type TddPlanParams,
  type TestFixParams,
  type TestParams,
} from "./actions.js";
import { guard } from "./state-machine.js";
import {
  type ActionDeps,
  type ActionResult,
  CwError,
  type GuardErrorCode,
  type Topic,
} from "./types.js";

// ── GuardError（guard 拒绝，extends CwError 走 exit 1）──────

/**
 * GuardError — guard 拒绝时抛出。
 *
 * code 仅 "illegal_transition"（GuardErrorCode 单值，纵深防御 guard 砍掉后只剩这一种）。
 * extends CwError，CLI 层 mapExitCode 用 instanceof CwError 统一判定 exit code=1。
 */
export class GuardError extends CwError {
  constructor(
    public readonly code: GuardErrorCode,
    public readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
    this.name = "GuardError";
  }
}

// ── dispatch（统一入口）─────────────────────────────────────

/**
 * dispatch — engine 统一入口纯函数。
 *
 * @param params  CwParams 联合类型（7 个 action 之一）
 * @param deps    ActionDeps（store + git + workspacePath）
 * @returns ActionResult（含 status / gatePassed / nextAction）
 *
 * create 特殊处理：不需要 loadTopic（无 topic 即可建）。
 * 非 create：loadTopic → null 则 throw → guard → handler 分派。
 *
 * guard 失败语义：throw GuardError，不返回半成品 ActionResult。
 * agent 按 CLI 的 exit code + stderr 判断是否需 retry，或按上次成功的 nextAction 继续。
 */
export function dispatch(params: CwParams, deps: ActionDeps): ActionResult {
  const action = params.action;

  // create 不需要 loadTopic（入口 action，无前置 topic）。
  if (action === "create") {
    return handleCreate(params as CreateParams, deps);
  }

  // 非 create：loadTopic。null → throw（topic 不存在）。
  const nonCreateParams = params as Exclude<CwParams, CreateParams>;
  const topic: Topic | null = deps.store.loadTopic(nonCreateParams.topicId);
  if (!topic) {
    throw new CwError(`topic not found: ${nonCreateParams.topicId}`);
  }

  // 单重 guard（checkLinear）。fail → throw GuardError，不吞异常。
  const verdict = guard(action, topic);
  if (!verdict.ok) {
    throw new GuardError(verdict.code, verdict.reason);
  }

  // action 分派。
  switch (action) {
    case "clarify":
      return handleClarify(params as ClarifyParams, topic, deps);
    case "plan":
      return handlePlan(params as PlanParams, topic, deps);
    case "plan_review":
      return handlePlanReview(params as PlanReviewParams, topic, deps);
    case "plan_review_fix":
      return handlePlanReviewFix(params as PlanReviewFixParams, topic, deps);
    case "tdd_plan":
      return handleTddPlan(params as TddPlanParams, topic, deps);
    case "dev":
      return handleDev(params as DevParams, topic, deps);
    case "review":
      return handleReview(params as ReviewParams, topic, deps);
    case "review_fix":
      return handleReviewFix(params as ReviewFixParams, topic, deps);
    case "test":
      return handleTest(params as TestParams, topic, deps);
    case "test_fix":
      return handleTestFix(params as TestFixParams, topic, deps);
    case "retrospect":
      return handleRetrospect(params as RetrospectParams, topic, deps);
    case "closeout":
      return handleCloseout(params as CloseoutParams, topic, deps);
    case "confirm_clarify":
      return handleConfirmClarify(params as ConfirmClarifyParams, topic, deps);
    case "spec_review":
      return handleSpecReview(params as SpecReviewParams, topic, deps);
    case "spec_review_fix":
      return handleSpecReviewFix(params as SpecReviewFixParams, topic, deps);
    case "abort":
      return handleAbort(params as AbortParams, topic, deps);
    case "replan":
      return handleReplan(params as ReplanParams, topic, deps);
    case "assess":
      return handleAssess(params as AssessParams, topic, deps);
    default: {
      // 穷尽性检查：CwParams 的 action 联合已全覆盖，default 不可达。
      // 保留兜底防御未来新增 action 忘加 case。
      const _exhaustive: never = action;
      void _exhaustive;
      throw new CwError(`unknown action: ${String(action)}`);
    }
  }
}

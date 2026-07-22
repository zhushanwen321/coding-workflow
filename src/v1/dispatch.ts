/**
 * v1 dispatch — 统一入口（guard → handler 路由 → ActionResult）。
 *
 * 职责：loadWorkUnit（非 create）→ guardWave → action handler 分派 → ActionResult。
 *
 * 与 0.x dispatch.ts 结构相似，但路由到 v1 handlers、用 v1 store、守卫 wave 状态机。
 *
 * 数据流：params → load（非 create）→ guard → handler → ActionResult。
 * 失败路径：
 *   - unit not found（非 create）→ throw V1Error（CLI 映射 exit 1）
 *   - guard fail（illegal_transition）→ throw V1Error（含 code/reason）
 *   - handler gate fail → 返回 ActionResult(ok=false)（不抛错，由调用方决定）
 *
 * 关键约束：guard fail 和 unit not found 抛错（不可恢复），gate fail 返回结果（可 retry）。
 */
import { guardWave, type WaveAction } from "./rules/state-machine.js";
import type { ExecutionUnit } from "./core/workunit.js";
import type { V1Store } from "./store/v1-store.js";
import type { WorkUnitRecord } from "./store/schema.js";
import {
  type AbortInput,
  type ClarifyInput,
  type CloseoutInput,
  type CreateInput,
  type DesignReviewInput,
  type ExecReviewInput,
  type ExecuteInput,
  type PlanInput,
  type ReplanInput,
  type RetrospectInput,
  type TestInput,
  type ActionResult,
  type V1Deps,
  handleAbort,
  handleClarify,
  handleCloseout,
  handleCreate,
  handleDesignReview,
  handleExecReview,
  handleExecute,
  handlePlan,
  handleReplan,
  handleRetrospect,
  handleTest,
} from "./handlers/index.js";

// ── V1Error（guard 拒绝 / unit not found，走 exit 1）──

/** dispatch 层错误（guard fail / unit not found）。CLI 映射 exit 1。 */
export class V1Error extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "V1Error";
  }
}

// ── V1Params 联合类型（所有 action 的入参）──

/** dispatch 入参的联合类型。每个 action 对应一个 { action, unitId?, input }。 */
export type V1Params =
  | { action: "create"; input: CreateInput }
  | { action: "clarify"; unitId: string; input: ClarifyInput }
  | { action: "plan"; unitId: string; input: PlanInput }
  | { action: "design-review"; unitId: string; input: DesignReviewInput }
  | { action: "execute"; unitId: string; input: ExecuteInput }
  | { action: "test"; unitId: string; input: TestInput }
  | { action: "exec-review"; unitId: string; input: ExecReviewInput }
  | { action: "retrospect"; unitId: string; input: RetrospectInput }
  | { action: "closeout"; unitId: string; input: CloseoutInput }
  | { action: "replan"; unitId: string; input: ReplanInput }
  | { action: "abort"; unitId: string; input: AbortInput };

// ── dispatch（统一入口）──

/**
 * dispatch — v1 统一入口纯函数。
 *
 * create 特殊处理：不需要 loadWorkUnit（入口 action）。
 * 非 create：loadWorkUnit → null 则 throw → guard → handler 分派。
 *
 * guard 失败语义：throw V1Error（code=illegal_transition），不返回半成品。
 * gate 失败语义：返回 ActionResult(ok=false)（不抛错，调用方可按 gateResults 决定 retry）。
 *
 * @param params  V1Params 联合类型
 * @param deps    V1Deps（store + gitValidator + testRunner + fileExists + clock）
 * @returns ActionResult（含 status / gateResults / ok）
 */
export function dispatch(params: V1Params, deps: V1Deps): ActionResult {
  const action = params.action;

  // create 不需要 loadWorkUnit（入口 action，无前置 unit）。
  if (action === "create") {
    return handleCreate(params.input, deps);
  }

  // 非 create：loadWorkUnit。null → throw。
  const unit = loadExecutionUnit(deps.store, params.unitId);
  if (!unit) {
    throw new V1Error("unit_not_found", `unit not found: ${params.unitId}`);
  }

  // guard（checkLinear）。fail → throw V1Error。
  const verdict = guardWave(action as WaveAction, unit.status);
  if (!verdict.ok) {
    throw new V1Error(
      verdict.code,
      verdict.reason,
    );
  }

  // action 分派。
  switch (action) {
    case "clarify":
      return handleClarify(unit, params.input, deps);
    case "plan":
      return handlePlan(unit, params.input, deps);
    case "design-review":
      return handleDesignReview(unit, params.input, deps);
    case "execute":
      return handleExecute(unit, params.input, deps);
    case "test":
      return handleTest(unit, params.input, deps);
    case "exec-review":
      return handleExecReview(unit, params.input, deps);
    case "retrospect":
      return handleRetrospect(unit, params.input, deps);
    case "closeout":
      return handleCloseout(unit, params.input, deps);
    case "replan":
      return handleReplan(unit, params.input, deps);
    case "abort":
      return handleAbort(unit, params.input, deps);
    default: {
      // 穷尽性检查：V1Params 的 action 联合已全覆盖（create 已提前 return）。
      const _exhaustive: never = action;
      void _exhaustive;
      throw new V1Error("unknown_action", `unknown action: ${String(action)}`);
    }
  }
}

// ── 辅助：从 store 加载 ExecutionUnit ──

/**
 * 从 store 加载 WorkUnitRecord 并转为 ExecutionUnit。
 *
 * WorkUnitRecord 是 `[key: string]: unknown` 的透传记录，store 不解释字段。
 * 这里转为 ExecutionUnit（字段结构与存入时一致，直接 cast）。
 */
function loadExecutionUnit(store: V1Store, unitId: string): ExecutionUnit | null {
  const record: WorkUnitRecord | null = store.load(unitId);
  if (!record) return null;
  // WorkUnitRecord 直接序列化了 ExecutionUnit 的全部字段，结构一致。
  return record as unknown as ExecutionUnit;
}

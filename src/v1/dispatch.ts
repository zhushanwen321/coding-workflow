/**
 * v1 dispatch — 统一入口（guard → handler 路由 → ActionResult）。
 *
 * 职责：create 按 input.layer 路由（wave/slice），非 create 按 record.scope
 *       loadWorkUnit → 对应层 guard（guardWave / guardPlanning）→ handler 分派 → ActionResult。
 *
 * 多 scope 路由（W6）：dispatch 不再 wave 专属。create 按 `input.layer`（默认 'wave'）
 * 选 handleCreate / handleCreateSlice；非 create 按 `record.scope` 返回 ExecutionUnit / Slice，
 * 再分别走 dispatchWave / dispatchSlice。
 *
 * 与 0.x dispatch.ts 结构相似，但路由到 v1 handlers、用 v1 store、守卫各层状态机。
 *
 * 数据流：params → (create: layer 路由 | 非 create: load → scope 路由 → guard → handler) → ActionResult。
 * 失败路径：
 *   - unit not found（非 create）→ throw V1Error（CLI 映射 exit 1）
 *   - guard fail（illegal_transition）→ throw V1Error（含 code/reason）
 *   - handler gate fail → 返回 ActionResult(ok=false)（不抛错，由调用方决定）
 *
 * 关键约束：guard fail 和 unit not found 抛错（不可恢复），gate fail 返回结果（可 retry）。
 */
import type { ExecutionUnit, Slice } from "./core/workunit.js";
import {
  type AbortInput,
  type ActionResult,
  type ClarifyInput,
  type CloseoutInput,
  type CreateInput,
  type DesignReviewInput,
  type ExecReviewInput,
  type ExecuteInput,
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
  type PlanInput,
  type ReplanInput,
  type RetrospectInput,
  type TestInput,
  type V1Deps,
} from "./handlers/index.js";
import {
  handleAbortSlice,
  handleClarifySlice,
  handleCloseoutSlice,
  handleCreateSlice,
  handleDesignReviewSlice,
  handleExecuteSlice,
  handlePlanSlice,
  handleReplanSlice,
  handleRetrospectSlice,
} from "./handlers/slice/index.js";
import type {
  FeatureClarifyInput,
  PlanFeatureInput,
  PlanSliceInput,
  RetrospectSliceInput,
} from "./handlers/types.js";
import {
  guardPlanning,
  guardWave,
  type PlanningAction,
  type WaveAction,
} from "./rules/state-machine.js";
import type { WorkUnitRecord } from "./store/schema.js";
import type { V1Store } from "./store/v1-store.js";

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

// ── assertUnreachable（穷尽检查辅助）──

/**
 * 穷尽检查辅助——用于 switch 的 default 分支，确保联合已被穷尽覆盖。
 *
 * 参数类型为 `never`：若 switch 漏了某个 union 成员，调用处传入的值不是 never，TS 报错。
 * 运行时若真的到达（不应发生），抛 V1Error 兠底（比静默返回 undefined 安全）。
 */
function assertUnreachable(_: never): never {
  throw new V1Error("unknown_action", `unreachable: unhandled params branch`);
}

// ── V1Params 联合类型（所有 action 的入参）──

/**
 * dispatch 入参的联合类型。每个 action 对应一个 { action, unitId?, input }。
 *
 * action 名 wave/slice/feature 共用（create/clarify/plan/.../abort），input 按层不同：
 * - plan：wave 用 PlanInput、slice 用 PlanSliceInput、feature 用 PlanFeatureInput（三者产物形态完全不同）。
 * - retrospect：wave 用 RetrospectInput、slice/feature 共用 RetrospectSliceInput
 *   （PlanningRetrospectData 比 RetrospectData 宽；feature 与 slice retrospectData 同型）。
 * - clarify：wave/slice 共用 ClarifyInput（裸数组），feature 用 FeatureClarifyInput（容器对象，含 spec）。
 * - 其余 action（design-review/execute/test/exec-review/closeout/replan/abort）
 *   各层共用同一 Input（见 handlers/types.ts 复用说明）。
 *   其中 test/exec-review 是 wave 专属，slice/feature dispatch 收到时抛 illegal_transition。
 * - create：input.layer 决定建哪个层（默认 'wave'，向后兼容；feature 在后续 dispatch wave 接入）。
 */
export type V1Params =
  | { action: "create"; input: CreateInput }
  | { action: "clarify"; unitId: string; input: ClarifyInput | FeatureClarifyInput }
  | { action: "plan"; unitId: string; input: PlanInput | PlanSliceInput | PlanFeatureInput }
  | { action: "design-review"; unitId: string; input: DesignReviewInput }
  | { action: "execute"; unitId: string; input: ExecuteInput }
  | { action: "test"; unitId: string; input: TestInput }
  | { action: "exec-review"; unitId: string; input: ExecReviewInput }
  | { action: "retrospect"; unitId: string; input: RetrospectInput | RetrospectSliceInput }
  | { action: "closeout"; unitId: string; input: CloseoutInput }
  | { action: "replan"; unitId: string; input: ReplanInput }
  | { action: "abort"; unitId: string; input: AbortInput };

/**
 * 排除 create 的 V1Params——dispatchWave/dispatchSlice 的入参类型。
 *
 * create 已在 dispatch 顶层提前 return（不走 loadWorkUnit / 不进 dispatchWave/dispatchSlice），
 * 故这两个子函数只处理非 create action。收窄后 `switch(params.action)` 的 default 才是 never
 *（否则 create 是 V1Params 合法 action 值，default 里 params.action 残留 "create" 无法穷尽）。
 */
export type V1ParamsExcludingCreate = Exclude<V1Params, { action: "create" }>;

// ── dispatch（统一入口）──

/**
 * dispatch — v1 统一入口纯函数。
 *
 * create 特殊处理：不需要 loadWorkUnit（入口 action），按 input.layer 路由。
 * 非 create：loadWorkUnit（按 scope 返回 ExecutionUnit | Slice）→ null 则 throw
 *           → 对应层 guard → 对应层 dispatchWave/dispatchSlice。
 *
 * guard 失败语义：throw V1Error（code=illegal_transition），不返回半成品。
 * gate 失败语义：返回 ActionResult(ok=false)（不抛错，调用方可按 gateResults 决定 retry）。
 *
 * @param params  V1Params 联合类型
 * @param deps    V1Deps（store + gitValidator + testRunner + fileExists + clock）
 * @returns ActionResult（含 status / gateResults / ok）
 */
export function dispatch(params: V1Params, deps: V1Deps): ActionResult {
  // create 不需要 loadWorkUnit（入口 action，无前置 unit），按 input.layer 路由（默认 wave）。
  // 直接判 params.action（不用中间变量）——这样才能让后续代码收窄 params 为 V1ParamsExcludingCreate。
  if (params.action === "create") {
    const layer = params.input.layer ?? "wave";
    if (layer === "slice") {
      return handleCreateSlice(params.input, deps);
    }
    return handleCreate(params.input, deps);
  }

  // 非 create：params 已收窄为 V1ParamsExcludingCreate。loadWorkUnit（按 scope 返回 ExecutionUnit | Slice）。null → throw。
  const unit = loadWorkUnit(deps.store, params.unitId);
  if (!unit) {
    throw new V1Error("unit_not_found", `unit not found: ${params.unitId}`);
  }

  // 按 scope 分派到对应层的 guard + handler switch。
  if (unit.scope === "wave") {
    const verdict = guardWave(params.action as WaveAction, unit.status);
    if (!verdict.ok) {
      throw new V1Error(verdict.code, verdict.reason);
    }
    return dispatchWave(unit, params, deps);
  }

  // slice 分支（unit.scope === "slice"）。
  // test/exec-review 是 wave 专属（PlanningUnit 不跑代码测试 / 不做 exec-review），不在 PlanningAction
  // 联合里。guardPlanning 查 PLANNING_TRANSITIONS 表会拿到 undefined（表里无此键）导致崩溃，
  // 故先拦截这两个 action，抛 illegal_transition（与 dispatchSlice 内部的 case 防御语义一致）。
  if (params.action === "test" || params.action === "exec-review") {
    throw new V1Error(
      "illegal_transition",
      `slice has no ${params.action} action (only wave/ExecutionUnit does)`,
    );
  }
  const verdict = guardPlanning(params.action as PlanningAction, unit.status);
  if (!verdict.ok) {
    throw new V1Error(verdict.code, verdict.reason);
  }
  return dispatchSlice(unit, params, deps);
}

// ── dispatchWave（wave/ExecutionUnit 的 action 分派）──

/**
 * wave（ExecutionUnit）的 action 分派——11 个 wave handler 的 switch。
 *
 * 调用前调用方须已通过 guardWave（状态机合法性已验）。本函数只做 handler 路由。
 *
 * params 作为判别式联合整体传入——switch(params.action) 时 TS 自动按 tag 收窄 params.input
 * 到对应分支的具体 Input 类型，无需手动断言。create 分支已在 dispatch 提前 return。
 *
 * @param unit    ExecutionUnit
 * @param params  V1Params（判别式联合，switch 自动 narrow input）
 * @param deps    V1Deps
 */
function dispatchWave(
  unit: ExecutionUnit,
  params: V1ParamsExcludingCreate,
  deps: V1Deps,
): ActionResult {
  switch (params.action) {
    case "clarify":
      return handleClarify(unit, params.input, deps);
    case "plan":
      // 进 dispatchWave 必是 wave（dispatch 已按 scope 分流），其 plan input 必是 PlanInput。
      // TS 无法从 V1Params 的 plan 分支（PlanInput | PlanSliceInput）推出这点，显式断言。
      return handlePlan(unit, params.input as PlanInput, deps);
    case "design-review":
      return handleDesignReview(unit, params.input, deps);
    case "execute":
      return handleExecute(unit, params.input, deps);
    case "test":
      return handleTest(unit, params.input, deps);
    case "exec-review":
      return handleExecReview(unit, params.input, deps);
    case "retrospect":
      // 同 plan：进 dispatchWave 必是 wave，retrospect input 必是 RetrospectInput。
      return handleRetrospect(unit, params.input as RetrospectInput, deps);
    case "closeout":
      return handleCloseout(unit, params.input, deps);
    case "replan":
      return handleReplan(unit, params.input, deps);
    case "abort":
      return handleAbort(unit, params.input, deps);
    default: {
      // create 已在 dispatch 提前 return；wave 的 9 主流程 + 2 旁路 action 已全覆盖。
      // switch 穷尽 → 此分支不可达（params 在此被 narrow 成 never）。
      assertUnreachable(params);
    }
  }
}

// ── dispatchSlice（slice/PlanningUnit 的 action 分派）──

/**
 * slice（PlanningUnit）的 action 分派——9 个 slice handler 的 switch。
 *
 * 调用前调用方须已通过 guardPlanning。本函数只做 handler 路由。
 *
 * slice 无 test / exec-review（PlanningUnit 不产代码、不做代码品味审查）——收到这两个 action
 * 抛 illegal_transition。slice execute 无 input（按 split 自动创建 child wave），故忽略 params.input。
 *
 * params 作为判别式联合整体传入——switch(params.action) 时 TS 自动按 tag 收窄 params.input
 * 到对应分支的具体 Input 类型。create 分支已在 dispatch 提前 return。
 *
 * @param unit    Slice
 * @param params  V1Params（判别式联合，switch 自动 narrow input；execute 分支忽略 input）
 * @param deps    V1Deps
 */
function dispatchSlice(
  unit: Slice,
  params: V1ParamsExcludingCreate,
  deps: V1Deps,
): ActionResult {
  switch (params.action) {
    case "clarify":
      return handleClarifySlice(unit, params.input, deps);
    case "plan":
      // 进 dispatchSlice 必是 slice，其 plan input 必是 PlanSliceInput（显式断言，同 dispatchWave）。
      return handlePlanSlice(unit, params.input as PlanSliceInput, deps);
    case "design-review":
      return handleDesignReviewSlice(unit, params.input, deps);
    case "execute":
      // slice execute 不接收 input（按 plan.split 自动创建 child wave），忽略 params.input。
      return handleExecuteSlice(unit, deps);
    case "retrospect":
      // 进 dispatchSlice 必是 slice，retrospect input 必是 RetrospectSliceInput。
      return handleRetrospectSlice(unit, params.input as RetrospectSliceInput, deps);
    case "closeout":
      return handleCloseoutSlice(unit, params.input, deps);
    case "replan":
      return handleReplanSlice(unit, params.input, deps);
    case "abort":
      return handleAbortSlice(unit, params.input, deps);
    case "test":
    case "exec-review":
      // slice（PlanningUnit）不跑代码测试、不做 exec-review——这两个 action 是 wave 专属。
      throw new V1Error(
        "illegal_transition",
        `slice has no ${params.action} action (only wave/ExecutionUnit does)`,
      );
    default: {
      // create 已在 dispatch 提前 return；planning 7 主流程 + 2 旁路 + test/exec-review 已全覆盖。
      // switch 穷尽 → 此分支不可达（params 在此被 narrow 成 never）。
      assertUnreachable(params);
    }
  }
}

// ── 辅助：从 store 加载 WorkUnit（按 scope 返回 ExecutionUnit | Slice）──

/**
 * 读取 unit 的 scope（wave/slice/feature/epic）。
 *
 * CLI 层按 scope 区分 execute 参数构造（wave 需 --commitHash，slice 不需要）。
 * 仅读 record.scope，不解释层类型（不抛 unsupported_scope——feature/epic 的 scope
 * 也正常返回，由调用方决定如何处理）。loadWorkUnit 的 scope 读取复用此函数。
 *
 * @returns scope 字符串；unit 不存在时 null
 */
export function getUnitScope(store: V1Store, unitId: string): string | null {
  const record = store.load(unitId);
  return record ? record.scope : null;
}

/**
 * 从 store 加载 WorkUnitRecord 并按 record.scope 返回 ExecutionUnit | Slice。
 *
 * WorkUnitRecord 是 `[key: string]: unknown` 的透传记录，store 不解释字段。这里按 scope
 * 判别层类型并转为 ExecutionUnit（scope='wave'）或 Slice（scope='slice'）。其他 scope
 *（epic/feature 未实现）抛 unsupported_scope。
 *
 * @returns ExecutionUnit | Slice | null（unitId 不存在时 null）
 */
function loadWorkUnit(
  store: V1Store,
  unitId: string,
): ExecutionUnit | Slice | null {
  const record: WorkUnitRecord | null = store.load(unitId);
  if (!record) return null;
  if (record.scope === "wave") {
    // 双重断言必要：WorkUnitRecord 的索引签名 `[key: string]: unknown` 与 ExecutionUnit 的强类型字段结构不兼容，无法直接断言。
    // eslint-disable-next-line taste/no-unsafe-cast
    return record as unknown as ExecutionUnit;
  }
  if (record.scope === "slice") {
    // eslint-disable-next-line taste/no-unsafe-cast
    return record as unknown as Slice;
  }
  throw new V1Error(
    "unsupported_scope",
    `unsupported scope: ${record.scope} (only wave/slice implemented)`,
  );
}

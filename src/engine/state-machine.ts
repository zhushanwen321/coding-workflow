/**
 * UnitStateMachine —— cw 1.0 通用引擎的核心。
 *
 * 设计意图：把 cw 0.x 的 `checkLinear` / `computeNextStatus` / dispatch 流水线
 * 参数化为 `<S, A, P>`（status / action / payload），零 topic 假设。
 * 接收一个 `ScopeConfig<S, A, P>`，即可驱动任意层（L3-topic / L3-wave /
 * L4-spec / L5-effort / ...）。
 *
 * 与 cw 0.x 的对应关系（直接平移算法）：
 *   - `guard`        ← `checkLinear`（state-machine.ts:343-368）
 *   - `computeNextStatus` ← state-machine.ts:397-403（progressive 语义）
 *   - `dispatch`     ← handler 内散落的 guard → gate → freeze → 流转 → 写产物流水线
 *
 * 关键设计决策：
 *   1. **深拷贝隔离**：dispatch 在构造 nextUnit 前用 `structuredClone` 复制入参 unit，
 *      避免外部 mutation 污染 store 中的旧版本。save 时 store 内部会再次深拷贝（InMemoryStore
 *      已这么做）。双重保护：调用方持有 dispatch 入参的引用时，不会被引擎意外改写。
 *   2. **gate 输入注入**：gate list 不放在 ScopeConfig 的 registry 里（避免再引一层映射），
 *      而是由调用方通过 `dispatch(options).gateSpecs` 按 action 提供。ScopeConfig.actionGates
 *      可选用于声明意图，但实际 GateSpec[] 由调用方注入。原型阶段这样最简单。
 *   3. **freeze 检查延迟到流转前**：freeze 比对的是「applyProducts 之后」的 unit，
 *      所以先 productApplicator（写入新产物），再 checkFreeze（比对旧/新）。失败时不 save、
 *      不改 status，但仍 append gateHistory（已发生的 gate 执行是事实，必须留痕）。
 *   4. **guard 不依赖字面量 "create"**：cw 0.x 用 `action === "create"` 特判，1.0 参数化为
 *      `rule.expectedStatuses.length === 0`（任何 expectedStatuses 为空的 transition 都视作
 *      create-like，允许 current=undefined）。这让通用层不必知道任何 action 名。
 *   5. **GateHistory append 由 dispatch 手动做**：DefaultGateRunner 不 mutate unit，
 *      只返回 entries。dispatch 把 entries append 到 nextUnit.collections.gateHistory。
 *
 * @typeParam S - status 字面量联合（每层自定义）
 * @typeParam A - action 字面量联合（每层自定义）
 * @typeParam P - payload 类型（每层 frontmatter 扩展）
 */
import type { Unit } from "./unit.js";
import type { ScopeConfig } from "./scope-config.js";
import type { GateSpec, GateHistoryEntry } from "./gate.js";
import type { FreezeViolation } from "./freeze.js";
import { checkFreeze } from "./freeze.js";
import type { EngineDeps } from "./deps.js";

/**
 * guard 判定结果。
 *
 * ok=true 时其余字段缺省；ok=false 时按 code 携带不同诊断字段：
 *   - `illegal_transition`：status 跳步（guard 阶段，checkLinear 算法）
 *   - `freeze_violation`：append-only/冻结规则违反（freeze 阶段）→ `violations`
 *   - `gate_failed`：gate 校验失败（gate 阶段）→ `gateReports`
 *
 * 与 cw 0.x GuardVerdict 的关系：cw 0.x 用 `{ ok: true } | { ok: false; code; reason }`
 * discriminated union。1.0 扩展为单一 interface 以容纳多失败模式的附加字段
 * （violations / gateReports），保留 code/reason 作通用诊断。
 */
export interface GuardVerdict {
  ok: boolean;
  code?: "illegal_transition" | "freeze_violation" | "gate_failed";
  reason?: string;
  /** code=freeze_violation 时：违规明细。 */
  violations?: FreezeViolation[];
  /** code=gate_failed 时：每个 fail gate 的 report。 */
  gateReports?: string[];
}

/**
 * dispatch 一个 action 的完整结果。
 *
 * 成功时 `unit` / `status` 有值；失败时 `error` 有值。
 * `gateEntries` 无论成功/失败都可能非空（gate 执行过就 append 历史留痕）。
 *
 * @typeParam S - status 字面量联合
 * @typeParam P - payload 类型
 */
export interface DispatchResult<S extends string, P> {
  /** 成功时：流转后的新 unit（已 save 到 store）。 */
  unit?: Unit<S, P>;
  /** 成功时：新 status。 */
  status?: S;
  /** 失败时：guard 判定。 */
  error?: GuardVerdict;
  /** 本次 dispatch 写入的 gateHistory entries（无论 success/fail 都可能有）。 */
  gateEntries?: GateHistoryEntry[];
}

/**
 * dispatch 的可选参数。
 *
 * @typeParam S - status 字面量联合
 * @typeParam A - action 字面量联合
 * @typeParam P - payload 类型
 */
export interface DispatchOptions<S extends string, A extends string, P> {
  /**
   * 产物写入函数：把 params 解析后写入 `unit.collections`（替代 cw 0.x handler 内的
   * `insertXxx` / `appendXxx` 调用）。
   *
   * 在 nextUnit 已深拷贝、status 已流转之后调用；freeze 检查之前调用（这样 freeze
   * 能比对「写入新产物后」的新旧 unit）。
   *
   * 注意：productApplicator 不应再 mutate unit.status / statusHistory，那是引擎职责。
   */
  productApplicator?: (unit: Unit<S, P>, action: A, params: unknown) => void;
  /**
   * 是否触发 freeze 检查。默认 false。
   *
   * replan / supersede 等「回流」类 action 才需要，正向流转 action（plan/dev/...）不查 freeze。
   */
  checkFreeze?: boolean;
  /**
   * 旧 unit 快照（freeze 检查的 before）。
   *
   * 默认用 dispatch 入参的 unit（dispatch 内部会先深拷贝入参作 old snapshot，
   * 然后 productApplicator 改的是新 copy，old 保持原始）。
   */
  oldUnitForFreeze?: Unit<S, P>;
  /**
   * 是否 progressive action 的覆写。
   *
   * 默认查 `config.transitions[action].progressive ?? false`。覆写场景：调用方临时
   * 想强制把某 action 标记为 progressive（影响 gateHistory 中的 progressive 字段）。
   */
  progressiveOverride?: boolean;
  /**
   * 本 action 触发的 gate list（按 action 决定）。
   *
   * 替代「ScopeConfig.actionGates + gateRegistry」的两层查询。
   * 原型阶段由调用方直接提供 GateSpec[]，简单直接。
   * 默认空数组（无 gate）。
   */
  gateSpecs?: ReadonlyArray<GateSpec<P>>;
}

/**
 * 通用 Unit 状态机 —— cw 1.0 核心引擎。
 *
 * 一个实例 = 一个层（ScopeConfig）的运行时驱动器。
 *
 * @typeParam S - status 字面量联合
 * @typeParam A - action 字面量联合
 * @typeParam P - payload 类型
 */
export class UnitStateMachine<
  S extends string,
  A extends string,
  P,
> {
  /**
   * @param config 该层的完整行为声明（transitions / freezeRules / terminalStatuses / ...）
   * @param deps   引擎依赖（store / gateRunner / clock）
   */
  constructor(
    private readonly config: ScopeConfig<S, A, P>,
    private readonly deps: EngineDeps,
  ) {}

  /**
   * 通用 guard —— 平移 cw 0.x `checkLinear`，参数化 S/A。
   *
   * 算法（与 cw 0.x state-machine.ts:343-368 对齐）：
   *   1. 查 `config.transitions[action]` 拿 rule
   *   2. 若 rule.expectedStatuses 为空数组（create-like，无前置 status 约束）
   *      → 允许 current=undefined，直接 pass
   *   3. 否则 current=undefined → illegal_transition
   *   4. current 不在 rule.expectedStatuses → illegal_transition
   *   5. 通过 → { ok: true }
   *
   * 与 cw 0.x 的唯一差异：cw 0.x 用 `action === "create"` 字面量特判，1.0 用
   * `expectedStatuses.length === 0`（语义等价但不依赖任何 action 名）。
   *
   * @param action  要执行的 action
   * @param current 当前 status（create-like action 时可为 undefined）
   * @returns guard 判定
   */
  guard(action: A, current: S | undefined): GuardVerdict {
    const rule = this.config.transitions[action];
    if (!rule) {
      return {
        ok: false,
        code: "illegal_transition",
        reason: `action "${action}" 未在 ScopeConfig.transitions 声明`,
      };
    }
    // create-like：expectedStatuses 为空数组，允许 current=undefined。
    if (rule.expectedStatuses.length === 0) {
      return { ok: true };
    }
    if (current === undefined) {
      return {
        ok: false,
        code: "illegal_transition",
        reason: `${action} 需要已存在的 unit（current=undefined）`,
      };
    }
    if (!rule.expectedStatuses.includes(current)) {
      return {
        ok: false,
        code: "illegal_transition",
        reason: `${action} 期望 status ∈ {${rule.expectedStatuses.join(", ")}}，实际为 ${current}`,
      };
    }
    return { ok: true };
  }

  /**
   * 通用 computeNextStatus —— 平移 cw 0.x state-machine.ts:397-403。
   *
   * progressive 语义：若 action 的 rule 是 progressive 且当前已是 nextStatus，
   * 则原地停留（返回 current，不回退也不前进）。
   *
   * 例：dev 是 progressive、nextStatus=developed。已 developed 时再次调 dev
   * （渐进式提交第二个 wave），status 仍为 developed。
   *
   * @param action  要执行的 action
   * @param current 当前 status（调用前已通过 guard，保证非 undefined）
   * @returns 流转后 status
   */
  computeNextStatus(action: A, current: S): S {
    const rule = this.config.transitions[action];
    if (rule.progressive && current === rule.nextStatus) {
      return current;
    }
    return rule.nextStatus;
  }

  /**
   * status 是否为终态（不可再流转出去）。
   *
   * 用于 nextAction 推导（终态不再有合法后继 action）。
   */
  isTerminal(status: S): boolean {
    return this.config.terminalStatuses.has(status);
  }

  /**
   * 主入口：dispatch 一个 action。
   *
   * 流程（按契约 5 步，含短路）：
   *   1. **guard**：`guard(action, unit.status)` → 不通过 return error
   *   2. **gate runner**：从 `options.gateSpecs` 取 gate list，
   *      `deps.gateRunner.run(unit, action, progressive, gates, params, deps)`
   *   3. **append gateHistory**：把 entries 写入 nextUnit.collections.gateHistory
   *      （无论 pass/fail 都 append，已发生的 gate 执行是事实）
   *   4. **gate fail 短路**：不流转 status、不写产物，return error（带 gateEntries）
   *   5. **computeNextStatus + 深拷贝构造 nextUnit**：应用 progressive 语义
   *   6. **statusHistory append**：追加本次流转事件
   *   7. **productApplicator**：写入层特定产物（若有）
   *   8. **freeze check**：若启用，比对 old/new，违规则 return error（不 save）
   *   9. **deps.store.save(nextUnit)**：持久化
   *  10. return `{ unit, status, gateEntries }`
   *
   * @param unit     当前 unit（dispatch 不会 mutate 入参，内部深拷贝）
   * @param action   要执行的 action
   * @param params   action 输入参数（透传给 gate 和 productApplicator）
   * @param options  可选：gate list / productApplicator / freeze 等
   * @returns 成功带 unit/status，失败带 error；都可能带 gateEntries
   */
  dispatch(
    unit: Unit<S, P>,
    action: A,
    params: unknown,
    options?: DispatchOptions<S, A, P>,
  ): DispatchResult<S, P> {
    const opts = options ?? {};

    // ── Step 1: guard（通用 checkLinear）──
    const verdict = this.guard(action, unit.status);
    if (!verdict.ok) {
      return { error: verdict };
    }

    // ── Step 2: 准备 gate 执行 ──
    const rule = this.config.transitions[action];
    const progressive = opts.progressiveOverride ?? rule.progressive ?? false;
    const gates = opts.gateSpecs ?? [];

    // gateRunner 读 unit.collections.gateHistory 推算 nextId，
    // 入参 unit 即是「执行前」状态，正确。
    const gateOutcome = this.deps.gateRunner.run(
      unit,
      action,
      progressive,
      gates,
      params,
      this.deps,
    );

    // ── Step 3: 构造 nextUnit（深拷贝 + 写入 gateHistory）──
    // 先深拷贝入参 unit 作 old snapshot（freeze 比对用，且保证 dispatch 不 mutate 入参）。
    const oldUnit = opts.oldUnitForFreeze ?? structuredClone(unit);

    // nextUnit 也从入参 unit 深拷贝（独立的 next 状态载体）。
    const nextUnit: Unit<S, P> = structuredClone(unit);
    // append gate entries 到 gateHistory（无论 pass/fail 都留痕）。
    const oldHistory = (nextUnit.collections.gateHistory ?? []) as GateHistoryEntry[];
    nextUnit.collections.gateHistory = [...oldHistory, ...gateOutcome.entries];

    // ── Step 4: gate fail 短路（不流转 status，不写产物）──
    if (!gateOutcome.passed) {
      const gateReports = gateOutcome.results
        .filter((r) => !r.passed)
        .map((r) => r.report);
      return {
        error: {
          ok: false,
          code: "gate_failed",
          reason: `gate 校验失败（${gateReports.length} 个 gate fail）`,
          gateReports,
        },
        gateEntries: gateOutcome.entries,
      };
    }

    // ── Step 5: computeNextStatus（progressive 语义）──
    const nextStatus = this.computeNextStatus(action, unit.status);

    // ── Step 6: status 流转 + statusHistory append ──
    const fromStatus = unit.status;
    nextUnit.status = nextStatus;
    nextUnit.statusHistory = [
      ...unit.statusHistory,
      {
        at: this.deps.clock.now(),
        action,
        from: fromStatus,
        to: nextStatus,
      },
    ];

    // ── Step 7: productApplicator（写入层特定产物）──
    // 在 freeze 检查之前，这样 freeze 能比对「写入新产物后」的新旧 unit。
    if (opts.productApplicator) {
      opts.productApplicator(nextUnit, action, params);
    }

    // ── Step 8: freeze check（可选）──
    if (opts.checkFreeze) {
      const violations = checkFreeze<P>(
        oldUnit as Unit<string, P>,
        nextUnit as Unit<string, P>,
        this.config.freezeRules ?? [],
      );
      if (violations.length > 0) {
        return {
          error: {
            ok: false,
            code: "freeze_violation",
            reason: `freeze 规则违反（${violations.length} 条违规）`,
            violations,
          },
          gateEntries: gateOutcome.entries,
        };
      }
    }

    // ── Step 9: 持久化 ──
    this.deps.store.save(nextUnit as Unit<string, unknown>);

    // ── Step 10: 返回成功 ──
    return {
      unit: nextUnit,
      status: nextStatus,
      gateEntries: gateOutcome.entries,
    };
  }
}

/**
 * GateSpec + GateRunner —— cw 1.0 重建的 gate 抽象层。
 *
 * cw 0.x 砍掉了 GateRegistry/GateRunner（见 gate.ts:5-8 注释），改为 handler 直接 import 具名函数。
 * 这导致 gate↔action 映射散落在各 handler，gate 名是字符串字面量，gateHistory append 分散。
 *
 * 1.0 以新形式重建抽象：GateSpec 声明表 + GateRunner 统一执行器。
 * 原型验证此抽象可行（stub gate 通过 GateRunner 跑通）。
 *
 * 与 cw 0.x 的对应关系：
 *   - GateSpec.check ← gate.ts 的具名函数（planCheck / devCheck / fileExistsCheck / redLightCheck / ...）
 *   - GateSpec.id ← handler 内联的 gate 名字符串字面量（"lite-plan-schema" / "medium-git" / ...）
 *   - GateRunner.run ← handler 内散落的 appendGateHistory + 状态流转逻辑
 *   - actionGates（ScopeConfig）← handler 内硬编码的「该 action 调哪些 gate」
 */
import type { EngineDeps } from "./deps.js";
import type { Unit } from "./unit.js";

/**
 * gate 校验结果。
 *
 * 字段对齐 cw 0.x 的 TddPlanCheckResult / PlanCheckResult 结构（shapes/types.ts:108）。
 * pass 时 parsed 可选填（供 handler 写入产物），fail 时 report 给 agent 看诊断。
 */
export interface GateResult {
  passed: boolean;
  report: string;
  /** pass 时定义（解析后的 payload，供 handler 写 store）。 */
  parsed?: unknown;
  /** pass 但有未全覆盖的 warning（不阻断）。 */
  warning?: string;
}

/**
 * gate id 联合类型 —— 每层 ScopeConfig 声明自己的 gate id 集合。
 *
 * 原型阶段用 string，后续迁移时可细化为层特定的字面量联合。
 */
export type GateId = string;

/**
 * 通用 gate 声明。
 *
 * 把「校验逻辑」从 handler 抽出来变成可声明的数据。
 * ScopeConfig.actionGates 声明每个 action 调哪些 gate id，GateRunner 按声明查 GateSpec 执行。
 *
 * @typeParam P - payload 类型（gate 可能读 payload 数据）
 */
export interface GateSpec<P> {
  /** gate 唯一标识（与 ScopeConfig.actionGates 引用对齐）。 */
  id: GateId;
  /** gate 分类（用于统计和熔断策略）。 */
  kind: "coverage" | "evidence" | "existence" | "schema";
  /**
   * 校验函数 —— 纯函数（无副作用，gateHistory append 由 GateRunner 统一做）。
   *
   * @param unit 当前 unit
   * @param input action 的输入参数（如 plan 的 planJson / dev 的 commitHash）
   * @param deps 引擎依赖（gate 可能调 git 子进程等，通过 deps 注入）
   */
  check: (
    unit: Unit<string, P>,
    input: unknown,
    deps: EngineDeps,
  ) => GateResult;
}

/**
 * gate 历史记录 —— 与 cw 0.x GateHistoryEntry 对齐（types.ts:238-247）。
 *
 * 字段语义直接平移：
 *   - phase/action：触发该 gate 的 action
 *   - gate：gate id（如 "plan-schema" / "tdd-red-light"）
 *   - result：pass / fail
 *   - progressive：是否 progressive action 产生的记录（用于区分重试 vs 推进）
 */
export interface GateHistoryEntry {
  /** 自增 id（per-unit 全局递增）。 */
  id: number;
  /** gate 所属的 phase action。 */
  phase: string;
  /** 触发该 gate 的 action。 */
  action: string;
  /** gate id。 */
  gate: GateId;
  /** 校验结果。 */
  result: "pass" | "fail";
  /** ISO timestamp。 */
  ts: string;
  /** 给 agent 看的判定说明（含失败定位）。 */
  report?: string;
  /** 是否 progressive action 产生的记录。 */
  progressive: boolean;
}

/**
 * GateRunner 统一执行器。
 *
 * 负责：
 *   1. 按 action 找对应的 gate list（从 ScopeConfig.actionGates）
 *   2. 依次执行每个 gate.check
 *   3. 任一 fail → 立即返回（短路），不继续执行后续 gate
 *   4. append gateHistory（无论 pass/fail 都记录）
 *   5. 返回聚合结果
 *
 * 这是 cw 0.x handler 内散落逻辑的统一抽象。
 */
export interface GateRunner {
  /**
   * 执行一组 gate。
   *
   * @param unit 当前 unit（gateHistory 会 append 到 unit.collections.gateHistory）
   * @param action 触发 action（用于 gateHistory 记录）
   * @param progressive 是否 progressive action
   * @param gates 要执行的 gate list（已按 ScopeConfig.actionGates 查出）
   * @param input action 输入
   * @param deps 引擎依赖
   * @returns 所有 gate 的结果 + 总体 passed
   */
  run<S extends string, P>(
    unit: Unit<S, P>,
    action: string,
    progressive: boolean,
    gates: ReadonlyArray<GateSpec<P>>,
    input: unknown,
    deps: EngineDeps,
  ): { passed: boolean; results: GateResult[]; entries: GateHistoryEntry[] };
}

/**
 * 默认 GateRunner 实现。
 *
 * 短路语义：任一 gate fail 立即返回，不执行后续 gate（cw 0.x 行为一致）。
 * gateHistory append 到 unit.collections.gateHistory，id 由现有长度推算。
 */
export class DefaultGateRunner implements GateRunner {
  run<S extends string, P>(
    unit: Unit<S, P>,
    action: string,
    progressive: boolean,
    gates: ReadonlyArray<GateSpec<P>>,
    input: unknown,
    deps: EngineDeps,
  ): { passed: boolean; results: GateResult[]; entries: GateHistoryEntry[] } {
    const results: GateResult[] = [];
    const entries: GateHistoryEntry[] = [];
    const history = (unit.collections.gateHistory ?? []) as GateHistoryEntry[];
    let nextId = history.length > 0 ? Math.max(...history.map((e) => e.id)) + 1 : 1;

    for (const gate of gates) {
      const now = new Date().toISOString();
      const result = gate.check(unit, input, deps);
      results.push(result);
      const entry: GateHistoryEntry = {
        id: nextId++,
        phase: action,
        action,
        gate: gate.id,
        result: result.passed ? "pass" : "fail",
        ts: now,
        report: result.report,
        progressive,
      };
      entries.push(entry);

      if (!result.passed) {
        // 短路：第一个 fail 即返回
        return { passed: false, results, entries };
      }
    }
    return { passed: true, results, entries };
  }
}

/**
 * 永真 gate（原型 stub 用）。
 *
 * 不接 cw 0.x gate.ts 具名函数时，用此 stub 占位。
 * 迁移阶段替换为真实 gate 实现。
 */
export function alwaysPassGate<P>(id: string, kind: GateSpec<P>["kind"] = "schema"): GateSpec<P> {
  return {
    id,
    kind,
    check: () => ({ passed: true, report: `stub gate ${id}: always pass` }),
  };
}

/**
 * 永假 gate（测试 fail 路径用）。
 */
export function alwaysFailGate<P>(
  id: string,
  report: string,
  kind: GateSpec<P>["kind"] = "schema",
): GateSpec<P> {
  return {
    id,
    kind,
    check: () => ({ passed: false, report }),
  };
}

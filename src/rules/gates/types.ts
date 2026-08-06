/**
 * v1 wave gates 共享类型与工具（领域规则，零 IO）。
 *
 * 来源：v5 wave 附录 A §11（所有 gate 返回统一的 GateResult）。
 *
 * 职责：
 * - 定义所有阶段 gate 共享的 GateResult 类型，单一来源。
 * - 提供 `runGateSafely`：聚合函数用它包裹每个子 gate 调用，把异常转成可读的
 *   GateResult（passed=false），防止单点异常击穿 dispatch。
 *
 * 单一来源避免各 gate 文件重复定义 GateResult，也避免 runGateSafely 被复制粘贴
 * 到多个 aggregate 函数里。
 */

/**
 * 所有阶段 gate（design-review / test / exec-review / retrospect）的统一返回类型。
 *
 * - `passed`：gate 是否通过（true=通过，false=失败）
 * - `report`：人类可读的说明（通过/失败原因，用于 mustFix 提示 / report 输出）
 * - `severity`：严重级别，省略默认 `"error"`（阻断）；`"warn"` 用于软 gate——
 *   必须配合 `passed: true`（不阻断，现有 `filter(!g.passed)` 聚合点天然排除，零回归），
 *   调用方如需展示按 `g.severity === "warn"` 收集 report。
 */
export type GateResult = {
  passed: boolean;
  report: string;
  severity?: "error" | "warn";
};

/**
 * 安全执行单个 gate：捕获异常并转换为可读的失败 GateResult。
 *
 * 聚合函数 `run*Gates` 用此 helper 包裹每个子 gate 调用，异常时返回
 * `{ passed: false, report: "gate <gateName> 内部异常: <message>" }`，
 * 让 agent 能按 failure-hint retry，而不是 500/internal error 击穿 dispatch。
 *
 * 正常返回的 GateResult 原样透传，不改变聚合函数返回类型（GateResult[]）。
 */
export function runGateSafely<TArgs extends unknown[]>(
  gateName: string,
  gateFn: (...args: TArgs) => GateResult,
  ...args: TArgs
): GateResult {
  try {
    return gateFn(...args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      report: `gate ${gateName} 内部异常: ${message}`,
    };
  }
}

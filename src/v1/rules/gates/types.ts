/**
 * v1 wave gates 共享类型（领域规则，零 IO）。
 *
 * 来源：v5 wave 附录 A §11（所有 gate 返回统一的 GateResult）。
 *
 * 职责：定义所有阶段 gate 共享的 GateResult 类型，单一来源（避免各 gate 文件重复定义导致
 *      `export *` 时的命名冲突，以及结构相同但身份不同的类型困惑）。
 */

/**
 * 所有阶段 gate（design-review / test / exec-review / retrospect）的统一返回类型。
 *
 * - `passed`：gate 是否通过（true=通过，false=失败）
 * - `report`：人类可读的说明（通过/失败原因，用于 mustFix 提示 / report 输出）
 */
export type GateResult = { passed: boolean; report: string };

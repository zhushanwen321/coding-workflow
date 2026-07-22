/**
 * v1 handlers 内部编排辅助（不对外导出，仅 handlers/ 内部用）。
 *
 * 来源：v5 wave 附录 A §10（统一编排流程）。
 *
 * 职责：封装「算 next status + append statusHistory + 更新 unit.status」这段每个 handler 都重复的
 *      编排逻辑。注意这是 handler 层内部的便利封装，不是业务规则（规则在 rules/state-machine.ts）。
 *
 * 不变量：纯编排，无 IO。时间戳由调用方传入（来自 deps.clock.now()）。
 */
import type { ExecutionUnit } from "../core/workunit.js";
import type { WaveAction } from "../rules/state-machine.js";
import { nextWaveStatus } from "../rules/state-machine.js";
import type { WorkUnitRecord } from "../store/schema.js";

/**
 * 流转 unit status：算 next → append StatusChange → 更新 unit.status。
 *
 * 对 replan 旁路 action 也适用（nextWaveStatus 返回 current 不变，from=to=current 仍 append）。
 *
 * @param unit 待流转的 unit（会被 mutate：push statusHistory + 改 status）
 * @param action 触发的 action
 * @param at ISO 8601 时间戳（来自 deps.clock.now()）
 * @param note 可选说明（replan 原因 / abort 原因）
 */
export function transitionStatus(
  unit: ExecutionUnit,
  action: WaveAction,
  at: string,
  note?: string,
): void {
  const from = unit.status;
  const next = nextWaveStatus(action, from);
  unit.statusHistory.push({
    from,
    to: next,
    at,
    action,
    note,
  });
  unit.status = next;
}

/**
 * 把 ExecutionUnit 存到 store。
 *
 * store 的 WorkUnitRecord 带 `[key: string]: unknown` 索引签名（schema.ts 注释：直接序列化
 * ExecutionUnit 全字段），而 ExecutionUnit 是具名接口无索引签名——TS 结构兼容性要求赋值方也有索引签名，
 * 故需要一次 `unknown` 中转。语义安全：ExecutionUnit 字段全 JSON 可序列化，store 不解释不裁剪。
 *
 * @param deps 依赖注入（取 store）
 * @param unit 待持久化的 ExecutionUnit
 */
export function saveUnit(deps: { store: { save: (u: WorkUnitRecord) => void } }, unit: ExecutionUnit): void {
  // 双重断言是必要的：ExecutionUnit 无索引签名，无法直接赋值给带 `[key: string]: unknown`
  // 的 WorkUnitRecord。store 按 schema.ts 设计直接序列化全字段，语义安全。
  // eslint-disable-next-line taste/no-unsafe-cast
  deps.store.save(unit as unknown as WorkUnitRecord);
}

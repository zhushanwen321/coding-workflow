/**
 * v1 对外类型统一导出。
 *
 * re-export core 领域模型 + handlers 的 params/results + dispatch 的入口类型。
 * 外部消费者（CLI / 测试 / 未来接入）只需 import 此文件。
 */
// core 领域模型
export * from "./core/index.js";

// handlers 共享类型（V1Deps / ActionResult / 各 Input）
export type {
  AbortInput,
  ActionResult,
  ClarifyInput,
  CloseoutInput,
  CreateInput,
  DesignReviewInput,
  ExecReviewInput,
  ExecuteInput,
  PlanInput,
  ReplanInput,
  RetrospectInput,
  TestInput,
  V1Deps,
} from "./handlers/index.js";

// dispatch 入口类型
export type { V1Params } from "./dispatch.js";
export { dispatch,V1Error } from "./dispatch.js";

// store（外部构造 V1Deps 时需要 V1Store）
export type { V1JsonFile,WorkUnitRecord } from "./store/schema.js";
export { V1Store } from "./store/v1-store.js";

// rules（外部测试 / 组合 gate 时需要）
export type { GuardVerdict,WaveAction } from "./rules/state-machine.js";
export {
  guardWave,
  isWaveTerminal,
  nextWaveStatus,
  WAVE_TRANSITIONS,
} from "./rules/state-machine.js";

/**
 * v1 handlers 编排层统一导出（wave 层 11 个 action handler + V1Deps + ActionResult + 各 Input）。
 *
 * 来源：v5 wave 附录 A §10（handler 编排骨架）、各阶段产物归宿。
 *
 * 层职责：handlers 是编排层——每个 action 一个 handler，串 rules（纯函数）+ store（IO）。
 *      handler 自身不含业务逻辑：调 rules 做 gate/freeze/状态机校验，调 store 做持久化。
 *      所有 IO（git 校验 / 跑测试 / 文件存在 / 时钟）通过 V1Deps 注入。
 *
 * 模块索引（11 个 handler）：
 * - create：入口，createWave 工厂初始化空态
 * - clarify：progressive append clarifications
 * - plan：写 WavePlan 4 类条目
 * - design-review：7 个 gate + 写 designReviewJudgment
 * - execute：记录 commitHash + 填 evidence 客观部分
 * - test：跑测试 + 3 个 gate + 填 testRunResult/testJudgment
 * - exec-review：4 个 gate + 写 execReviewJudgment
 * - retrospect：2 个 gate + 写 retrospectData
 * - closeout：补 evidence 主观部分 + drift 检查 + 冻结
 * - replan：checkFreeze + computeImpact + 旁路 statusHistory
 * - abort：级联 abort 子孙 + append abandonedRefs + 流转 aborted
 *
 * 注：internal.ts 是 handler 层内部编排辅助，不对外导出。
 */
// 共享类型
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
} from "./types.js";

// 11 个 handler
export { handleAbort } from "./abort.js";
export { handleClarify } from "./clarify.js";
export { handleCloseout } from "./closeout.js";
export { handleCreate } from "./create.js";
export { handleDesignReview } from "./design-review.js";
export { handleExecReview } from "./exec-review.js";
export { handleExecute } from "./execute.js";
export { handlePlan } from "./plan.js";
export { handleReplan } from "./replan.js";
export { handleRetrospect } from "./retrospect.js";
export { handleTest } from "./test.js";

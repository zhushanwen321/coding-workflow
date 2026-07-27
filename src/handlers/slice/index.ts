/**
 * v1 slice handlers 统一导出（7 主流程 handler + abort + replan + rollup 辅助）。
 *
 * slice 是 PlanningUnit 的具体实现（7 步流程：create/clarify/plan/design-review/execute/
 * retrospect/closeout + abort + replan）。每个 action 一个 handler，串 rules（纯函数）+ store（IO）。
 *
 * 模块索引：
 * - create：入口，createSlice 工厂初始化空态
 * - clarify：progressive append clarifications
 * - plan：写 SlicePlan 5 字段 + decisions 投影
 * - design-review：9 个 gate + 写 designReviewJudgment
 * - execute：【核心】按 split 创建 child wave，递归下沉点
 * - retrospect：查 child wave 状态 + 4 个 gate + 写 PlanningRetrospectData
 * - closeout：补 evidence 主观部分 + drift 检查 + 冻结 + 回溯父单元
 * - replan：freeze 校验 + computeImpactCascade 多层级联 + 旁路 statusHistory
 * - abort：级联 abort child wave + 流转 aborted
 *
 * rollupChildDelivery（在 handlers/rollup.ts）：child wave 状态变更后回写 parent slice 的
 * childDelivery，W5 接入 wave closeout/abort 尾部。
 *
 * 注：slice-internal.ts 是 slice handlers 层内部编排辅助（slice 版的 wave internal.ts），
 * 不对外导出。W5 参数化 internal.ts 后本文件可收敛。
 */

// 9 个 slice handler
export { handleAbortSlice } from "./abort.js";
export { handleClarifySlice } from "./clarify.js";
export { handleCloseoutSlice } from "./closeout.js";
export { handleCreateSlice } from "./create.js";
export { handleDesignReviewSlice } from "./design-review.js";
export { handleExecuteSlice } from "./execute.js";
export { handlePlanSlice } from "./plan.js";
export { handleReplanSlice } from "./replan.js";
export { handleRetrospectSlice } from "./retrospect.js";

// rollup 辅助（实现在 handlers/rollup.ts，W5 接入 wave handler）
export { rollupChildDelivery } from "../rollup.js";

/**
 * v1 feature handlers 统一导出（7 主流程 handler + abort + replan）。
 *
 * feature 是 PlanningUnit 的具体实现（7 步流程：create/clarify/plan/design-review/execute/
 * retrospect/closeout + abort + replan，无 test/exec-review）。每个 action 一个 handler，
 * 串 rules（纯函数）+ store（IO）。
 *
 * 模块索引：
 * - create：入口，createFeature 工厂初始化空态（clarifications 为容器对象、plan 为 Plan 基类）
 * - clarify：容器对象整体覆盖写入（非数组追加）
 * - plan：写 Plan 基类（只 split，无技术方案）
 * - design-review：feature 10 个 gate（FR-AC 强引用 3 + split 结构 2 + judgment 5 + layerSpecific 1）
 * - execute：【核心】按 split 创建 child slice，递归下沉点（targetLayer='slice'）
 * - retrospect：查 child slice 状态 + 7 个 gate + 写 PlanningRetrospectData
 * - closeout：补 evidence 主观部分 + drift 检查 + 冻结 + 回溯父单元
 * - replan：computeImpactCascade 多层级联 + 旁路 statusHistory（feature plan 无可废弃条目，跳过 freeze）
 * - abort：级联 abort child slice + 流转 aborted
 *
 * rollupChildDelivery（在 handlers/rollup.ts）：child slice 状态变更后回写 parent feature 的
 * childDelivery，W5 接入 slice closeout/abort 尾部（已处理 feature scope）。
 *
 * 注：feature-internal.ts 是 feature handlers 层内部编排辅助（feature 版的 slice-internal.ts），
 * 不对外导出。W5 参数化 internal.ts 后本文件可收敛。
 */

// 9 个 feature handler
export { handleAbortFeature } from "./abort.js";
export { handleClarifyFeature } from "./clarify.js";
export { handleCloseoutFeature } from "./closeout.js";
export { handleCreateFeature } from "./create.js";
export { handleDesignReviewFeature } from "./design-review.js";
export { handleExecuteFeature } from "./execute.js";
export { handlePlanFeature } from "./plan.js";
export { handleReplanFeature } from "./replan.js";
export { handleRetrospectFeature } from "./retrospect.js";

// rollup 辅助（实现在 handlers/rollup.ts，W5 接入 slice handler）
export { rollupChildDelivery } from "../rollup.js";

/**
 * v1 epic handlers 统一导出（7 主流程 handler + abort + replan）。
 *
 * epic 是 PlanningUnit 的顶层实现（7 步流程：create/clarify/plan/design-review/execute/
 * retrospect/closeout + abort + replan，无 test/exec-review）。每个 action 一个 handler，
 * 串 rules（纯函数）+ store（IO）。
 *
 * 模块索引：
 * - create：入口，createEpic 工厂初始化空态（clarifications 为数组、plan 为 Plan 基类）
 * - clarify：数组追加（progressive append，同 slice/wave，非 feature 的容器覆盖）
 * - plan：写 Plan 基类（只 split，无技术方案，无 spec）
 * - execute：【核心】按 split 创建 child feature，递归下沉点（targetLayer='feature'）
 * - retrospect：查 child feature 状态 + 7 个 gate + 写 PlanningRetrospectData
 * - closeout：补 evidence 主观部分 + drift 检查 + 冻结 + 回溯父单元（epic 顶层无父，孤立终点）
 * - replan：computeImpactCascade 多层级联 + 旁路 statusHistory（epic plan 无可废弃条目，跳过 freeze）
 * - abort：级联 abort child feature + 流转 aborted
 *
 * rollupChildDelivery（在 handlers/rollup.ts）：child feature 状态变更后回写 parent epic 的
 * childDelivery，W5 接入 feature closeout/abort 尾部（已处理 epic scope）。
 *
 * 注：epic-internal.ts 是 epic handlers 层内部编排辅助（epic 版的 feature-internal.ts），
 * 不对外导出。W5 参数化 internal.ts 后本文件可收敛。
 */

// 9 个 epic handler
export { handleAbortEpic } from "./abort.js";
export { handleClarifyEpic } from "./clarify.js";
export { handleCloseoutEpic } from "./closeout.js";
export { handleCreateEpic } from "./create.js";
export { handleDesignReviewEpic } from "./design-review.js";
export { handleExecuteEpic } from "./execute.js";
export { handlePlanEpic } from "./plan.js";
export { handleReplanEpic } from "./replan.js";
export { handleRetrospectEpic } from "./retrospect.js";

// rollup 辅助（实现在 handlers/rollup.ts，W5 接入 feature handler）
export { rollupChildDelivery } from "../rollup.js";

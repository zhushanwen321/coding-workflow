/**
 * v1 guidance 层入口 — 导出 guidance 系统全部公共 API。
 *
 * 来源：v5 cli-and-guidance §9「代码组织」。
 *
 * 层职责：guidance 是「渲染层」——把 prefix-builder / schema-injector / templates / failure-hint
 *      的产物组装成 agent 可读的 guidance 文本。cross-layer 查 store 算导航（唯一 IO 点）。
 *      handler 调 guidance 系统组装 nextAction.guidance 文本，handler 自己负责推进 status / save。
 *
 * 模块索引：
 * - prefix-builder：位置前缀（纯函数）
 * - failure-hint：递进失败提示 + failureCount 派生（纯函数）
 * - schema-injector：从 core 类型生成 input schema 文本（读源文件，构建时）
 * - templates/wave：wave 9 阶段 + replan 静态方法论模板（纯常量）
 * - cross-layer：跨层导航计算（查 store，唯一 IO 点）
 * - build-guidance：组装 prefix + template + schema → guidance 文本（纯函数）
 */

// 位置前缀
export type { BuildPrefixArgs } from "./prefix-builder.js";
export { buildPrefix } from "./prefix-builder.js";

// 递进失败提示
export type { FailureHistoryEntry } from "./failure-hint.js";
export { buildFailureHint, deriveFailureCount } from "./failure-hint.js";

// schema 自动注入
export type {
  InterfaceDescriptor,
  MemberDescriptor,
} from "./schema-injector.js";
export { injectSchema } from "./schema-injector.js";

// wave 静态方法论模板
export type { WaveStageTemplate } from "./templates/wave.js";
export {
  WAVE_CLARIFY_TEMPLATE,
  WAVE_CLOSEOUT_TEMPLATE,
  WAVE_DESIGN_REVIEW_TEMPLATE,
  WAVE_EXEC_REVIEW_TEMPLATE,
  WAVE_EXECUTE_TEMPLATE,
  WAVE_PLAN_TEMPLATE,
  WAVE_REPLAN_TEMPLATE,
  WAVE_RETROSPECT_TEMPLATE,
  WAVE_STAGE_TEMPLATES,
  WAVE_TEST_TEMPLATE,
} from "./templates/wave.js";

// planning 静态方法论模板（三层 PlanningUnit：slice/feature/epic）
export type { PlanningStageTemplate } from "./templates/planning/index.js";
export {
  PLANNING_CLARIFY_TEMPLATE,
  PLANNING_CLOSEOUT_TEMPLATE,
  PLANNING_DESIGN_REVIEW_TEMPLATE,
  PLANNING_EXECUTE_TEMPLATE,
  PLANNING_PLAN_TEMPLATE,
  PLANNING_RETROSPECT_TEMPLATE,
  PLANNING_STAGE_TEMPLATES,
} from "./templates/planning/index.js";

/**
 * PlanningStatus → 中文展示（三层 PlanningUnit 共用，与 wave 的 STATUS_DISPLAY 对应）。
 *
 * 三层（slice/feature/epic）共用同一份 PlanningStatus（8 状态，无 tested/exec-reviewed），
 * 故中文显示表完全一致，抽到 guidance 层公共常量。
 */
export const PLANNING_STATUS_DISPLAY: Readonly<
  Record<
    | "created"
    | "clarifying"
    | "planning"
    | "design-reviewed"
    | "executing"
    | "retrospected"
    | "closed"
    | "aborted",
    string
  >
> = {
  created: "已创建",
  clarifying: "需求澄清中",
  planning: "计划编写中",
  "design-reviewed": "已过设计审查",
  executing: "执行编码中",
  retrospected: "已复盘",
  closed: "已冻结交付",
  aborted: "已中止",
};

/**
 * PlanningAction → 下一步 action（PLANNING_TRANSITIONS 状态机映射，三层共用）。
 *
 * 三层（slice/feature/epic）共用同一 PLANNING_TRANSITIONS，故 next-action 映射完全一致。
 * execute/终态 action（closeout/abort）的下一步不在本层：execute 下沉 child（crossLayer.descend），
 * closeout 回溯父单元（crossLayer.ascend），abort 流程结束——都返回 undefined 由调用方填 crossLayer。
 */
export const PLANNING_ACTION_TO_NEXT: Readonly<Record<string, string | undefined>> = {
  create: "clarify",
  clarify: "plan",
  plan: "design-review",
  "design-review": "execute",
  execute: undefined, // 下沉 child，由调用方填 crossLayer.descend
  retrospect: "closeout",
  closeout: undefined, // 终态，回溯父单元 crossLayer.ascend
  abort: undefined, // 终态
  replan: "plan", // replan 后回 planning 重走 design-review
};

// 跨层导航
export type { ComputeCrossLayerArgs } from "./cross-layer.js";
export {
  computeCrossLayerAfterCloseout,
  isTerminalStatus,
} from "./cross-layer.js";

// guidance 组装
export type {
  BuildFailureGuidanceArgs,
  BuildNormalGuidanceArgs,
} from "./build-guidance.js";
export { buildFailureGuidance,buildNormalGuidance } from "./build-guidance.js";

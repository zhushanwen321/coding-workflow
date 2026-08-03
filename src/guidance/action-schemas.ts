/**
 * v1 guidance — action 到 input schema 来源的映射表（四层：wave / slice / feature / epic）。
 *
 * 来源：v5 cli-and-guidance §3.6「schema 自动生成」+ §4.x 各示例的 schema 段。
 *
 * 职责：集中管理哪个 action 的 input 对应哪个 core 源文件 + interface，覆盖四层。
 * 放在 guidance 层是因为这是 guidance 渲染 schema block 所需的元数据：
 *   - 被 handlers/internal.ts（wave）+ handlers/{slice,feature,epic}/*-internal.ts 消费以填 guidance；
 *   - 被 guidance/schema-injector.ts 的 buildSchemaGenFile 消费以在 build 阶段预计算 schemas.gen.json。
 *
 * 设计：四层表同处一文件，避免 schema-injector 反向 import handlers/* 造成 ESM 循环依赖
 * （handlers/* import guidance/index.js，guidance/index re-export schema-injector）。
 */

/** 单个 action 的 schema 来源描述。 */
export interface SchemaSource {
  /** core 源文件路径（相对于项目根目录，如 "src/core/plan.ts"）。 */
  sourceFilePath: string;
  /** 要提取的 interface 名（如 "PlanInput"）。 */
  interfaceName: string;
}

/**
 * wave（ExecutionUnit）action → 该 action 的 input schema 来源。
 *
 * injectSchema 从源码自动提取 schema 文本（§3.6），避免类型改了 guidance 漂移。
 * undefined 表示该 action 无结构化 input（create / execute / replan / abort 的
 * 参数是扁平的，不走 schema block）。
 */
export const ACTION_SCHEMA: Readonly<Record<string, SchemaSource | undefined>> = {
  create: undefined,
  clarify: { sourceFilePath: "src/handlers/types.ts", interfaceName: "ClarifyInput" },
  plan: { sourceFilePath: "src/core/plan.ts", interfaceName: "PlanInput" },
  "design-review": { sourceFilePath: "src/handlers/types.ts", interfaceName: "DesignReviewInput" },
  execute: undefined,
  test: { sourceFilePath: "src/handlers/types.ts", interfaceName: "TestInput" },
  "exec-review": { sourceFilePath: "src/handlers/types.ts", interfaceName: "ExecReviewInput" },
  retrospect: { sourceFilePath: "src/handlers/types.ts", interfaceName: "RetrospectInput" },
  closeout: { sourceFilePath: "src/handlers/types.ts", interfaceName: "CloseoutInput" },
  replan: undefined,
  abort: undefined,
};

/**
 * slice action → 该 action 的 input schema 来源。
 *
 * IF5 映射（slice 层）：clarify→Clarification@clarifications.ts、plan→PlanSliceInput@plan.ts。
 * create/execute/replan/abort 无结构化 input（execute 按 split 下沉，不接收 input）。
 */
export const SLICE_ACTION_SCHEMA: Readonly<Record<string, SchemaSource | undefined>> = {
  create: undefined,
  clarify: { sourceFilePath: "src/handlers/types.ts", interfaceName: "ClarifyInput" },
  plan: { sourceFilePath: "src/core/plan.ts", interfaceName: "PlanSliceInput" },
  "design-review": { sourceFilePath: "src/handlers/types.ts", interfaceName: "DesignReviewInput" },
  execute: undefined, // 下沉创建 child wave，不接收 input
  retrospect: { sourceFilePath: "src/handlers/types.ts", interfaceName: "RetrospectSliceInput" },
  closeout: { sourceFilePath: "src/handlers/types.ts", interfaceName: "CloseoutInput" },
  replan: undefined,
  abort: undefined,
};

/**
 * feature action → 该 action 的 input schema 来源。
 *
 * IF5 映射（feature 层）：clarify→FeatureClarification@clarifications.ts、plan→PlanFeatureInput@plan.ts。
 * feature clarify 产物是 FeatureClarification 容器（{ clarifications, spec }），
 * plan 只写 split（Plan 基类，不产技术方案）。
 */
export const FEATURE_ACTION_SCHEMA: Readonly<Record<string, SchemaSource | undefined>> = {
  create: undefined,
  clarify: { sourceFilePath: "src/handlers/types.ts", interfaceName: "FeatureClarifyInput" },
  plan: { sourceFilePath: "src/core/plan.ts", interfaceName: "PlanFeatureInput" },
  "design-review": { sourceFilePath: "src/handlers/types.ts", interfaceName: "DesignReviewInput" },
  execute: undefined, // 下沉创建 child slice，不接收 input
  retrospect: { sourceFilePath: "src/handlers/types.ts", interfaceName: "RetrospectFeatureInput" },
  closeout: { sourceFilePath: "src/handlers/types.ts", interfaceName: "CloseoutInput" },
  replan: undefined,
  abort: undefined,
};

/**
 * epic action → 该 action 的 input schema 来源。
 *
 * IF5 映射（epic 层）：clarify→Clarification@clarifications.ts（裸数组，与 slice 同）、
 * plan→PlanEpicInput@plan.ts（与 feature 同，Plan 基类只拆下层）。
 */
export const EPIC_ACTION_SCHEMA: Readonly<Record<string, SchemaSource | undefined>> = {
  create: undefined,
  clarify: { sourceFilePath: "src/handlers/types.ts", interfaceName: "ClarifyInput" },
  plan: { sourceFilePath: "src/core/plan.ts", interfaceName: "PlanEpicInput" },
  "design-review": { sourceFilePath: "src/handlers/types.ts", interfaceName: "DesignReviewInput" },
  execute: undefined, // 下沉创建 child feature，不接收 input
  retrospect: { sourceFilePath: "src/handlers/types.ts", interfaceName: "RetrospectEpicInput" },
  closeout: { sourceFilePath: "src/handlers/types.ts", interfaceName: "CloseoutInput" },
  replan: undefined,
  abort: undefined,
};

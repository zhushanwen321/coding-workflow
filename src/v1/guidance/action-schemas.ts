/**
 * v1 guidance — action 到 input schema 来源的映射表。
 *
 * 来源：v5 cli-and-guidance §3.6「schema 自动生成」+ §4.x 各示例的 schema 段。
 *
 * 职责：集中管理哪个 action 的 input 对应哪个 core 源文件 + interface。
 * 放在 guidance 层是因为这是 guidance 渲染 schema block 所需的元数据，
 * 被 handlers/internal.ts 消费以填充 nextAction.guidance。
 */

/** 单个 action 的 schema 来源描述。 */
export interface SchemaSource {
  /** core 源文件路径（相对于项目根目录，如 "src/v1/core/plan.ts"）。 */
  sourceFilePath: string;
  /** 要提取的 interface 名（如 "PlanInput"）。 */
  interfaceName: string;
}

/**
 * action → 该 action 的 input schema 来源（core 源文件 + interface 名）。
 *
 * injectSchema 从源码自动提取 schema 文本（§3.6），避免类型改了 guidance 漂移。
 * undefined 表示该 action 无结构化 input（create / execute / replan / abort 的
 * 参数是扁平的，不走 schema block）。
 */
export const ACTION_SCHEMA: Readonly<Record<string, SchemaSource | undefined>> = {
  create: undefined,
  clarify: { sourceFilePath: "src/v1/core/clarifications.ts", interfaceName: "Clarification" },
  plan: { sourceFilePath: "src/v1/core/plan.ts", interfaceName: "PlanInput" },
  "design-review": { sourceFilePath: "src/v1/core/judgments.ts", interfaceName: "DesignReviewJudgment" },
  execute: undefined,
  test: { sourceFilePath: "src/v1/core/judgments.ts", interfaceName: "TestJudgment" },
  "exec-review": { sourceFilePath: "src/v1/core/judgments.ts", interfaceName: "ExecReviewJudgment" },
  retrospect: { sourceFilePath: "src/v1/core/judgments.ts", interfaceName: "RetrospectData" },
  closeout: { sourceFilePath: "src/v1/core/evidence.ts", interfaceName: "ArtifactRef" },
  replan: undefined,
  abort: undefined,
};

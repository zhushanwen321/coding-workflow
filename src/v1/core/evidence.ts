/**
 * v1 Evidence（跨阶段产物，领域模型，零依赖）。
 *
 * 来源：v5 model §5.11（Evidence 类型 + 跨阶段定位）。
 *
 * evidence 跨阶段生命周期：
 * - execute（+ ExecutionUnit 的 test）完成时：cw 自动填客观部分
 * - exec-review/retrospect 阶段：agent 消费 evidence 做审查
 * - closeout 阶段：agent 补主观部分 + cw 校验 artifacts drift + cw 冻结（frozenAt）
 *
 * 不变量：frozenAt 非空后，整个 evidence 对象不可再改（由 handlers 层强制）。
 */
// ═══════════════════════════════════════════════════════════════
// Evidence 基类（所有层共享）
// ═══════════════════════════════════════════════════════════════

/** model §5.11.1 — Evidence 基类。 */
export interface Evidence {
  // === 客观部分（cw 自动填，execute/test 完成时生成）===
  /** ISO 8601，evidence 首次生成时间。 */
  generatedAt: string;

  // === 主观部分（agent 在 closeout 时补充）===
  /** 交付小结（1-2 句话，agent 填）。 */
  summary?: string;
  /** 交付物引用清单（agent 确认/补充）。 */
  artifacts: ArtifactRef[];

  // === 冻结标记（closeout 时填）===
  /** closeout 冻结时间（空=未 closeout，非空=已冻结不再变）。 */
  frozenAt?: string;
}

/** model §5.11.1 — 交付物引用（一条 = 一个交付物）。 */
export interface ArtifactRef {
  kind: "spec" | "plan" | "review-report" | "retrospect-report" | "code" | "test" | "doc" | "other";
  /** 文件路径 / URL / commit hash。 */
  ref: string;
  /** 简短说明（可选）。 */
  note?: string;
}

// ═══════════════════════════════════════════════════════════════
// WaveEvidence（ExecutionUnit）
// ═══════════════════════════════════════════════════════════════

/** model §5.11.1 — wave 的 evidence（+ 客观部分：commitHash/changedFiles/testRunResult）。 */
export interface WaveEvidence extends Evidence {
  // 客观部分（cw 自动填）
  /** execute 后的 commit（cw 验存在性）。 */
  commitHash: string;
  /** 本次 wave 改动的文件清单（从 commit 提取）。 */
  changedFiles: string[];
  /** test 阶段的测试结果（test 完成后填，无 test 则空）。 */
  testRunResult?: TestRunResult;
}

// ═══════════════════════════════════════════════════════════════
// PlanningEvidence（PlanningUnit，类型预留）
// ═══════════════════════════════════════════════════════════════

/**
 * model §5.11.1 — PlanningUnit 的 evidence（+ childDelivery rollup）。
 * 本 topic 不实现 PlanningUnit，但类型预留。
 */
export interface PlanningEvidence extends Evidence {
  /** 每个 split 项对应 child 的交付情况（rollup，cw 自动填）。 */
  childDelivery: ChildDeliveryRecord[];
}

/** model §5.11.1 — 每个 split 项的 child 交付记录。 */
export interface ChildDeliveryRecord {
  splitSlug: string;
  childUnitId: string;
  childStatus: "closed" | "aborted";
  childEvidenceSummary?: string;
}

// ═══════════════════════════════════════════════════════════════
// TestRunResult（test 阶段产物）
// ═══════════════════════════════════════════════════════════════

/** model §5.11.1 — 测试运行结果（ExecutionUnit 才有）。 */
export interface TestRunResult {
  /** 是否全部通过。 */
  passed: boolean;
  passedCount: number;
  failedCount: number;
  skippedCount?: number;
  durationMs?: number;
  /** 触发模式（沿用 cw 0.x TestRunnerMode 命名）。 */
  runnerMode?: string;
  /** 原始报告文件路径 / URL（可选）。 */
  rawReportRef?: string;
}

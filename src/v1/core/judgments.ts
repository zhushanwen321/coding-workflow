/**
 * v1 业务判断字段（领域模型，零依赖）。
 *
 * 来源：v5 model §5.8（designReviewJudgment/testJudgment/execReviewJudgment/retrospectData 共享核心）、
 * wave 附录 A §5-§8（wave 层定稿的具名 interface）。
 */
import type { WorkUnitItem } from "./plan.js";

// ═══════════════════════════════════════════════════════════════
// DesignReviewJudgment（design-review 阶段产物）
// ═══════════════════════════════════════════════════════════════

/** model §5.8 — 执行前的设计判断（审 clarification + plan 合起来的方案合理性）。 */
export interface DesignReviewJudgment {
  necessity: string;
  sufficiency: SufficiencyResult;
  alternatives: string;
  tradeoffs: Tradeoff[];
  risks: Risk[];
  /** 各层专属判断（wave 收紧为 WaveDesignReviewLayerSpecific）。 */
  layerSpecific?: WaveDesignReviewLayerSpecific;
}

/** model §5.8 — 充分性（MECE）。 */
export interface SufficiencyResult {
  gaps: string[];
  overlaps: string[];
  meceNote: string;
}

/** model §5.8 — 权衡与妥协。 */
export interface Tradeoff {
  id: string;
  decision: string;
  reason: string;
  cost: string;
}

/** model §5.8 — 风险。 */
export interface Risk {
  id: string;
  item: string;
  severity: "low" | "medium" | "high";
  mitigation: string;
}

/** wave 附录 A §8 — wave 的 designReviewJudgment.layerSpecific 具名 interface。 */
export interface WaveDesignReviewLayerSpecific {
  testCaseCoverageNote?: string;
  boundaryConditionNote?: string;
  mockStrategyNote?: string;
  tddRedReadinessNote?: string;
}

// ═══════════════════════════════════════════════════════════════
// TestJudgment（test 阶段产物，仅 ExecutionUnit）
// ═══════════════════════════════════════════════════════════════

/**
 * wave 附录 A §5 — 对照 designReviewJudgment 验收。
 * 注意：testRunResult 不在 testJudgment 里——它属于 WaveEvidence。
 */
export interface TestJudgment {
  necessityMet: string;
  sufficiencyMet: SufficiencyMetResult;
  alternativesReconsidered: string;
  tradeoffCostRealized: TradeoffCostRealized[];
  riskOutcome: RiskOutcome[];
}

/** wave 附录 A §5 — 充分性验收（含 manual 类验收记录）。 */
export interface SufficiencyMetResult {
  gapsConfirmed: string[];
  gapsNewlyFound: string[];
  overlapsConfirmed: string[];
  /** manual 类 WaveTestCase 的验收记录归宿。 */
  note?: string;
}

/** wave 附录 A §5 — tradeoff 代价是否兑现（引用 designReviewJudgment.tradeoffs[i].id）。 */
export interface TradeoffCostRealized {
  tradeoffRef: string;
  costRealized: boolean;
  note?: string;
}

/** wave 附录 A §5 — 风险结果（引用 designReviewJudgment.risks[i].id）。 */
export interface RiskOutcome {
  riskRef: string;
  outcome: "materialized" | "not-materialized" | "mitigated";
  note?: string;
}

// ═══════════════════════════════════════════════════════════════
// ExecReviewJudgment（exec-review 阶段产物，仅 ExecutionUnit）
// ═══════════════════════════════════════════════════════════════

/** wave 附录 A §6 — 代码品味审查（纯人审，无机器 gate 验内容）。 */
export interface ExecReviewJudgment {
  readability: { score: 1 | 2 | 3 | 4 | 5; issues?: string[] };
  architecture: { score: 1 | 2 | 3 | 4 | 5; issues?: string[] };
  codeSmells?: { items: string[]; severity?: "low" | "medium" | "high" };
  layerSpecific?: ExecReviewLayerSpecific;
  overallVerdict: "pass" | "needs-followup";
  followupActions?: FollowupAction[];
}

/** wave 附录 A §6 — wave 层 exec-review 专属维度。 */
export interface ExecReviewLayerSpecific {
  testCodeQuality?: { score: 1 | 2 | 3 | 4 | 5; issues?: string[] };
  mockFidelityNote?: string;
}

/** wave 附录 A §6 / model §5.8 — 跟进项（结构化，便于分发到不同后续 scope）。 */
export interface FollowupAction {
  description: string;
  priority: "high" | "medium" | "low";
  targetScope: "current-wave-replan" | "next-wave" | "slice-level-refactor" | "adr-candidate";
}

// ═══════════════════════════════════════════════════════════════
// RetrospectData（retrospect 阶段产物）
// ═══════════════════════════════════════════════════════════════

/** model §5.8 — 复盘数据（共享基类）。wave 用此基类（不扩展）。 */
export interface RetrospectData {
  reviewedItems: ReviewedItem[];
  /** 必填，保留 string（经验提炼天生叙述性）。 */
  lessonsLearned: string;
  wrongJudgments?: WrongJudgment[];
  badTradeoffs?: BadTradeoff[];
  missedGaps?: MissedGap[];
  processIssues?: ProcessIssue[];
}

/** model §5.8 — 逐项回顾（对照 designReviewJudgment）。 */
export interface ReviewedItem {
  /** designReviewJudgment 里某条判断的 id（裸字段→字段名；数组元素→元素 id）。 */
  itemId: string;
  outcome: "fulfilled" | "partial" | "unfulfilled";
  note?: string;
}

/** model §5.8 — 判错的判断（指向 designReviewJudgment 的某条）。 */
export interface WrongJudgment {
  judgmentRef: string;
  whyWrong: string;
  whatActuallyHappened: string;
}

/** model §5.8 — 代价超预期的 tradeoff。 */
export interface BadTradeoff {
  tradeoffRef: string;
  costOverrun: string;
  note?: string;
}

/** model §5.8 — 漏掉的 MECE gap。 */
export interface MissedGap {
  where: "clarify" | "plan" | "design-review" | "execute" | "test";
  gap: string;
}

/** model §5.8 — 流程问题。 */
export interface ProcessIssue {
  type: "clarify" | "plan" | "split" | "replan" | "execute" | "test" | "review" | "other";
  issue: string;
}

/**
 * model §5.8 — PlanningUnit 的 retrospectData 扩展（兼验收）。
 * 本 topic 不实现 PlanningUnit，但类型预留。
 */
export interface PlanningRetrospectData extends RetrospectData {
  deliveryVerdict: "delivered" | "partial" | "failed";
  childUnitIdsEvidence: { childId: string; status: "closed" | "aborted"; closeoutEvidenceSummary?: string }[];
  splitFulfillment: { splitSlug: string; verdict: "delivered" | "partial" | "failed"; note?: string }[];
}

// WorkUnitItem import 保留给未来条目类型扩展引用（当前 judgments 不直接继承 WorkUnitItem）
export type { WorkUnitItem };

/**
 * v1 Clarification + Decision（领域模型，零依赖）。
 *
 * 来源：v5 model §5.9（Clarification）、§5.10（Decision）。
 * FeatureClarification/FeatureSpec 类型预留（本 topic 不实现 feature 层）。
 */
import type { WorkUnitItem } from "./plan.js";

// ═══════════════════════════════════════════════════════════════
// Clarification（clarify 阶段产物）
// ═══════════════════════════════════════════════════════════════

/**
 * model §5.9 — 澄清项（extends WorkUnitItem，可废弃）。
 *
 * resolution 空 = 还没答（progressive 填充，靠字段空/非空判完成度）。
 * type 的语义不在 model 展开——research/grilling 作为 skill 提供。
 */
export interface Clarification extends WorkUnitItem {
  question: string;
  /** 空 = 还没答。 */
  resolution?: string;
  type: "research" | "grilling";
}

// ═══════════════════════════════════════════════════════════════
// Decision（投影自 Clarification）
// ═══════════════════════════════════════════════════════════════

/**
 * model §5.10 — 决策记录。
 *
 * 不继承 WorkUnitItem——跟随 Clarification replan，不独立持有 status。
 * id 直接用源 Clarification 的 id。sourceClarification 指向本层 Clarification。
 */
export interface Decision {
  /** 直接用源 Clarification 的 id（如 "D3"）。 */
  id: string;
  decision: string;
  rationale: string;
  /** 投影自哪个 Clarification（id 和它一样）。 */
  sourceClarification?: string;
}

// ═══════════════════════════════════════════════════════════════
// Feature 层类型预留（本 topic 不实现，仅类型声明避免后续改 core）
// ═══════════════════════════════════════════════════════════════

/**
 * model §6 / wave 附录 A 注释 — feature 的 clarification 容器。
 *
 * feature 的 clarify 产物形态不对称：epic/slice/wave 是 Clarification[]，
 * feature 是 FeatureClarification（容器对象，含 spec）。
 * 本 topic 不实现 feature，但类型预留。
 */
export interface FeatureClarification {
  clarifications: Clarification[];
  spec: FeatureSpec;
}

/**
 * model §6 — feature 的需求规格（FR/AC/UC）。
 * FR/AC/UC 只在 feature 层产生（model §1.3.1）。本 topic 预留类型。
 */
export interface FeatureSpec {
  functionalRequirements: FunctionalRequirement[];
  acceptanceCriteria: AcceptanceCriterion[];
  businessCases: BusinessCase[];
}

/** model §5.7 — 功能需求（extends WorkUnitItem）。 */
export interface FunctionalRequirement extends WorkUnitItem {
  title: string;
  detail: string;
}

/** model §5.7 — 验收标准（extends WorkUnitItem）。 */
export interface AcceptanceCriterion extends WorkUnitItem {
  condition: string;
  /** 验证方式（沿用 cw 0.x 命名，不改名）。 */
  verification: "unit" | "manual" | "review";
}

/** model §5.7 — 业务用例（extends WorkUnitItem）。 */
export interface BusinessCase extends WorkUnitItem {
  actor: string;
  scenario: string;
  expectedResult: string;
}

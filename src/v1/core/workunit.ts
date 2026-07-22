/**
 * v1 WorkUnit 实体 + 工厂（领域模型，依赖 core 内部模块）。
 *
 * 来源：v5 model §1.4（WorkUnit 顶层接口）、§5.3（通用字段）、§2.5（ExecuteResult）。
 */
import type {
  PlanningStatus,
  ExecutionStatus,
  StatusChange,
  AbandonedRef,
} from "./status.js";
import type { Plan, WavePlan } from "./plan.js";
import type {
  Evidence,
  WaveEvidence,
} from "./evidence.js";
import type {
  DesignReviewJudgment,
  TestJudgment,
  ExecReviewJudgment,
  RetrospectData,
} from "./judgments.js";
import type { Clarification, FeatureClarification } from "./clarifications.js";

// ═══════════════════════════════════════════════════════════════
// ExecuteResult（execute 产物基类 + 子类）
// ═══════════════════════════════════════════════════════════════

/** model §2.5 — execute 产物的基类（预留扩展）。 */
export interface ExecuteResult {
  // 共享部分（暂无）
}

/** model §2.5 — PlanningUnit 的 execute 产物。本 topic 预留类型。 */
export interface PlanningExecuteResult extends ExecuteResult {
  childUnitIds: string[];
}

/** model §2.5 / wave 附录 A §2 — ExecutionUnit 的 execute 产物。 */
export interface ExecutionExecuteResult extends ExecuteResult {
  /** dev 写完代码后的 commit hash（cw 验存在性）。 */
  commitHash: string;
}

// ═══════════════════════════════════════════════════════════════
// WorkUnit 基类（所有 WorkUnit 共享字段）
// ═══════════════════════════════════════════════════════════════

/** model §1.4 / §5.3 — 所有 WorkUnit 共享的字段。 */
export interface WorkUnitBase {
  /** WorkUnit 唯一标识（如 "wave:auth-w1"）。 */
  id: string;
  /** 层类型。 */
  scope: "epic" | "feature" | "slice" | "wave";
  /** 人类可读短名。 */
  slug: string;
  /** 父层 WorkUnit 的 id（epic 无）。 */
  parentUnitId?: string;

  // ── lifecycle ──
  status: PlanningStatus | ExecutionStatus;
  /** append-only 变更流。 */
  statusHistory: StatusChange[];

  // ── replan 追踪 ──
  /** 引用父层哪些条目 id（创建时快照，append-only，影响面计算基础）。 */
  basedOnParent: string[];
  /** 被上游 replan 影响的废弃记录（纯历史记录）。 */
  abandonedRefs: AbandonedRef[];

  // ── 主流程产物（逐步填充）──
  objective: string;
}

// ═══════════════════════════════════════════════════════════════
// PlanningUnit（epic/feature/slice）— 接口预留
// ═══════════════════════════════════════════════════════════════

/**
 * model §1.4 — PlanningUnit（epic/feature/slice）。
 * 本 topic 不实现 PlanningUnit 流程，但接口预留（避免后续改 core）。
 */
export interface PlanningUnit extends WorkUnitBase {
  scope: "epic" | "feature" | "slice";
  status: PlanningStatus;
  clarifications: Clarification[] | FeatureClarification;
  plan: Plan;
  designReviewJudgment: DesignReviewJudgment;
  executeResult: PlanningExecuteResult;
  retrospectData: RetrospectData;
  evidence: Evidence;
}

// ═══════════════════════════════════════════════════════════════
// ExecutionUnit（wave）— 本 topic 核心实现目标
// ═══════════════════════════════════════════════════════════════

/**
 * model §1.4 / wave 附录 A §1 — ExecutionUnit（wave）。
 * 三个判别字段（vs PlanningUnit）：executeResult 子类型、有无 testJudgment、有无 execReviewJudgment。
 */
export interface ExecutionUnit extends WorkUnitBase {
  scope: "wave";
  status: ExecutionStatus;
  clarifications: Clarification[];
  plan: WavePlan;
  designReviewJudgment: DesignReviewJudgment;
  executeResult: ExecutionExecuteResult;
  testJudgment: TestJudgment;
  execReviewJudgment: ExecReviewJudgment;
  retrospectData: RetrospectData;
  evidence: WaveEvidence;
}

// ═══════════════════════════════════════════════════════════════
// 工厂函数
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 wave（ExecutionUnit）实例。
 *
 * 初始化通用字段 + statusHistory 首条（create 事件）。
 * 产物字段（plan/judgments/evidence 等）初始化为空态，各 handler 逐步填充。
 */
export function createWave(args: {
  slug: string;
  objective: string;
  parentUnitId: string;
  basedOnParent: string[];
  createdAt?: string;
}): ExecutionUnit {
  const now = args.createdAt ?? new Date().toISOString();
  const id = `wave:${args.slug}`;
  return {
    id,
    scope: "wave",
    slug: args.slug,
    parentUnitId: args.parentUnitId,
    status: "created",
    statusHistory: [
      { at: now, action: "create", to: "created" },
    ],
    basedOnParent: [...args.basedOnParent],
    abandonedRefs: [],
    objective: args.objective,
    // 产物初始化为空态（各 handler 逐步填充）
    clarifications: [],
    plan: { split: [], testCases: [], tasks: [], files: [], contracts: [] },
    designReviewJudgment: emptyDesignReviewJudgment(),
    executeResult: { commitHash: "" },
    testJudgment: emptyTestJudgment(),
    execReviewJudgment: emptyExecReviewJudgment(),
    retrospectData: { reviewedItems: [], lessonsLearned: "" },
    evidence: {
      generatedAt: "",
      artifacts: [],
      commitHash: "",
      changedFiles: [],
    },
  };
}

// ── 空态工厂（产物字段的初始值）──

function emptyDesignReviewJudgment(): DesignReviewJudgment {
  return {
    necessity: "",
    sufficiency: { gaps: [], overlaps: [], meceNote: "" },
    alternatives: "",
    tradeoffs: [],
    risks: [],
  };
}

function emptyTestJudgment(): TestJudgment {
  return {
    necessityMet: "",
    sufficiencyMet: { gapsConfirmed: [], gapsNewlyFound: [], overlapsConfirmed: [] },
    alternativesReconsidered: "",
    tradeoffCostRealized: [],
    riskOutcome: [],
  };
}

function emptyExecReviewJudgment(): ExecReviewJudgment {
  return {
    readability: { score: 1 },
    architecture: { score: 1 },
    overallVerdict: "pass",
  };
}

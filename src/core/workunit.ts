/**
 * v1 WorkUnit 实体 + 工厂（领域模型，依赖 core 内部模块）。
 *
 * 来源：v5 model §1.4（WorkUnit 顶层接口）、§5.3（通用字段）、§2.5（ExecuteResult）。
 */
import type { Clarification, FeatureClarification } from "./clarifications.js";
import type {
  Evidence,
  PlanningEvidence,
  WaveEvidence,
} from "./evidence.js";
import type {
  DesignReviewJudgment,
  ExecReviewJudgment,
  PlanningRetrospectData,
  RetrospectData,
  TestJudgment,
} from "./judgments.js";
import type { Plan, SlicePlan, WavePlan } from "./plan.js";
import type {
  AbandonedRef,
  ExecutionStatus,
  PlanningStatus,
  StatusChange,
} from "./status.js";

// ═══════════════════════════════════════════════════════════════
// ExecuteResult（execute 产物基类 + 子类）
// ═══════════════════════════════════════════════════════════════

/** model §2.5 — execute 产物的基类（预留扩展，当前无共享字段）。 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
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
  /**
   * 本 WorkUnit 主动声明已脱离的 parent 条目 id（append-only）。
   *
   * 跨层跨时机声明通道（ADR-0010 / model §5.6.6）：
   * - 任何层的 plan/replan 时通过 input 的 abandonParentItems 字段写入（主通道）
   * - wave execute 时从 commit message `Cw-Abandon:` trailer 解析写入（辅助通道）
   * - cw 用 Set 去重合并，一旦声明不可撤回
   *
   * 用途：slice/feature replan cascade abort 时，本单元声明过的 parent 条目不触发 abort
   *（基于 basedOnParent 历史快照的命中判定会跳过 abandonedParentItems 白名单）。
   *
   * 注意：epic 无 parent，此字段永远为 []（工厂初始化，epic handler 不写入）。
   */
  abandonedParentItems?: string[];

  // ── 主流程产物（逐步填充）──
  objective: string;
}

// ═══════════════════════════════════════════════════════════════
// PlanningUnit（epic/feature/slice）— 接口预留
// ═══════════════════════════════════════════════════════════════

/**
 * model §1.4 — PlanningUnit（epic/feature/slice）。
 *
 * 通用接口保持宽松（plan: Plan 基类、evidence: Evidence 基类），各具体层
 *（如 Slice）通过 extends 收窄为自己的 plan/evidence/retrospectData 子类型。
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

/**
 * model §1.4 / slice 附录 A — slice（PlanningUnit 的具体实现）。
 *
 * 收窄字段类型：plan: SlicePlan / evidence: PlanningEvidence /
 * clarifications: Clarification[] / retrospectData: PlanningRetrospectData。
 */
export interface Slice extends PlanningUnit {
  scope: "slice";
  status: PlanningStatus;
  clarifications: Clarification[];
  plan: SlicePlan;
  executeResult: PlanningExecuteResult;
  retrospectData: PlanningRetrospectData;
  evidence: PlanningEvidence;
}

/**
 * model §1.4 / feature 附录 A §1 — feature（PlanningUnit 的具体实现）。
 *
 * 收窄字段类型：plan: Plan 基类（只 split）/ evidence: PlanningEvidence /
 * clarifications: FeatureClarification（容器对象，非数组）/ retrospectData: PlanningRetrospectData。
 * 与 slice 相比：feature 的 clarify 产物形态不对称（容器对象含 spec），
 * plan 只用 Plan 基类（feature 不产技术方案，只拆 slice）。
 */
export interface Feature extends PlanningUnit {
  scope: "feature";
  status: PlanningStatus;
  clarifications: FeatureClarification;
  plan: Plan;
  executeResult: PlanningExecuteResult;
  retrospectData: PlanningRetrospectData;
  evidence: PlanningEvidence;
}

/**
 * model §1.4 / epic 附录 A — epic（PlanningUnit 的顶层具体实现）。
 *
 * 收窄字段类型：plan: Plan 基类（只 split）/ evidence: PlanningEvidence /
 * clarifications: Clarification[]（数组形态，同 slice/wave，非 feature 的容器对象）/
 * retrospectData: PlanningRetrospectData。与 feature 相比：epic 是 4 层顶层无父层
 *（parentUnitId 永远 undefined），不产 spec（FR/AC/UC 是 feature 的事），clarify 产物
 * 只是战略决策的 Clarification 数组。epic 的 plan 只用 Plan 基类（拆 feature 清单）。
 */
export interface Epic extends PlanningUnit {
  scope: "epic";
  status: PlanningStatus;
  clarifications: Clarification[];
  plan: Plan;
  executeResult: PlanningExecuteResult;
  retrospectData: PlanningRetrospectData;
  evidence: PlanningEvidence;
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
  /** 父单元 id（可选——任何层都能无 parent 独立起步，§1.3）。 */
  parentUnitId?: string;
  /** 引用父层哪些条目 id（可选，无 parent 时为空数组）。 */
  basedOnParent?: string[];
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
    basedOnParent: args.basedOnParent ? [...args.basedOnParent] : [],
    abandonedRefs: [],
    abandonedParentItems: [],
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

// ═══════════════════════════════════════════════════════════════
// createSlice 工厂（slice 层入口）
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 slice（PlanningUnit）实例。
 *
 * 初始化通用字段 + statusHistory 首条（create 事件）。
 * 产物字段（plan/judgments/evidence）初始化为空态，各 slice handler 逐步填充。
 */
export function createSlice(args: {
  slug: string;
  objective: string;
  /** 父单元 id（可选——任何层都能无 parent 独立起步，§1.3）。 */
  parentUnitId?: string;
  /** 引用父层哪些条目 id（可选，无 parent 时为空数组）。 */
  basedOnParent?: string[];
  createdAt?: string;
}): Slice {
  const now = args.createdAt ?? new Date().toISOString();
  const id = `slice:${args.slug}`;
  return {
    id,
    scope: "slice",
    slug: args.slug,
    parentUnitId: args.parentUnitId,
    status: "created",
    statusHistory: [
      { at: now, action: "create", to: "created" },
    ],
    basedOnParent: args.basedOnParent ? [...args.basedOnParent] : [],
    abandonedRefs: [],
    abandonedParentItems: [],
    objective: args.objective,
    // 产物初始化为空态（各 slice handler 逐步填充）
    clarifications: [],
    plan: { split: [], techChoices: [], interfaces: [], dataModels: [], errorSpecs: [], decisions: [] },
    designReviewJudgment: emptyDesignReviewJudgment(),
    executeResult: { childUnitIds: [] },
    retrospectData: {
      reviewedItems: [],
      lessonsLearned: "",
      deliveryVerdict: "failed",
      childUnitIdsEvidence: [],
      splitFulfillment: [],
    },
    evidence: {
      generatedAt: "",
      artifacts: [],
      childDelivery: [],
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// createFeature 工厂（feature 层入口）
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 feature（PlanningUnit）实例。
 *
 * 初始化通用字段 + statusHistory 首条（create 事件）。
 * 产物字段初始化为空态，各 feature handler 逐步填充。与 createSlice 的区别：
 * - clarifications 是 FeatureClarification 容器对象（含空 spec），不是数组。
 * - plan 只用 Plan 基类（feature 不产技术方案，只拆 slice，无 techChoices 等）。
 * - evidence/retrospectData/executeResult 与 slice 同型（PlanningUnit 共享）。
 */
export function createFeature(args: {
  slug: string;
  objective: string;
  /** 父单元 id（可选——任何层都能无 parent 独立起步，§1.3）。 */
  parentUnitId?: string;
  /** 引用父层哪些条目 id（可选，无 parent 时为空数组）。 */
  basedOnParent?: string[];
  createdAt?: string;
}): Feature {
  const now = args.createdAt ?? new Date().toISOString();
  const id = `feature:${args.slug}`;
  return {
    id,
    scope: "feature",
    slug: args.slug,
    parentUnitId: args.parentUnitId,
    status: "created",
    statusHistory: [
      { at: now, action: "create", to: "created" },
    ],
    basedOnParent: args.basedOnParent ? [...args.basedOnParent] : [],
    abandonedRefs: [],
    abandonedParentItems: [],
    objective: args.objective,
    // 产物初始化为空态（各 feature handler 逐步填充）
    clarifications: {
      clarifications: [],
      spec: {
        functionalRequirements: [],
        acceptanceCriteria: [],
        businessCases: [],
        decisions: [],
        outOfScope: [],
      },
    },
    plan: { split: [] },
    designReviewJudgment: emptyDesignReviewJudgment(),
    executeResult: { childUnitIds: [] },
    retrospectData: {
      reviewedItems: [],
      lessonsLearned: "",
      deliveryVerdict: "failed",
      childUnitIdsEvidence: [],
      splitFulfillment: [],
    },
    evidence: {
      generatedAt: "",
      artifacts: [],
      childDelivery: [],
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// createEpic 工厂（epic 层入口）
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 epic（PlanningUnit 顶层）实例。
 *
 * 初始化通用字段 + statusHistory 首条（create 事件）。
 * 产物字段初始化为空态，各 epic handler 逐步填充。与 createFeature 的区别：
 * - clarifications 是 Clarification[] 数组（同 slice/wave），不是 FeatureClarification 容器对象。
 * - epic 是 4 层顶层无父层：parentUnitId 永远不写入（顶层语义，调用方传也忽略），
 *   basedOnParent/abandonedRefs 永远 []（无上游条目可引用/被废弃）。
 * - plan 只用 Plan 基类（epic 不产 spec 也不产技术方案，只拆 feature 清单）。
 * - evidence/retrospectData/executeResult 与 feature/slice 同型（PlanningUnit 共享）。
 */
export function createEpic(args: {
  slug: string;
  objective: string;
  /**
   * 父单元 id——epic 是顶层无父层，此参数语义上永远 undefined。
   * 保留参数签名仅为与 createFeature/createSlice 对称（便于工厂模式统一），
   * 但 epic handler 调用时不传，createEpic 内部也不写入 parentUnitId 字段。
   */
  parentUnitId?: string;
  /** 引用父层哪些条目 id——epic 无上游，永远 []（传入也忽略）。 */
  basedOnParent?: string[];
  createdAt?: string;
}): Epic {
  const now = args.createdAt ?? new Date().toISOString();
  const id = `epic:${args.slug}`;
  return {
    id,
    scope: "epic",
    slug: args.slug,
    // epic 是顶层无父层——parentUnitId 永远不写入（即使调用方误传也忽略）
    status: "created",
    statusHistory: [
      { at: now, action: "create", to: "created" },
    ],
    // epic 无上游：basedOnParent/abandonedRefs 永远 []（即使调用方误传也忽略）
    basedOnParent: [],
    abandonedRefs: [],
    abandonedParentItems: [],
    objective: args.objective,
    // 产物初始化为空态（各 epic handler 逐步填充）
    clarifications: [],
    plan: { split: [] },
    designReviewJudgment: emptyDesignReviewJudgment(),
    executeResult: { childUnitIds: [] },
    retrospectData: {
      reviewedItems: [],
      lessonsLearned: "",
      deliveryVerdict: "failed",
      childUnitIdsEvidence: [],
      splitFulfillment: [],
    },
    evidence: {
      generatedAt: "",
      artifacts: [],
      childDelivery: [],
    },
  };
}

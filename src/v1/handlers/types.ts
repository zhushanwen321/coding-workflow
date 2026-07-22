/**
 * v1 handlers 共享类型 — handler 编排层的依赖注入接口 + 统一返回 + 各 Input。
 *
 * 来源：v5 wave 附录 A §10-§11（handler 编排骨架）、各阶段产物归宿（plan/judgments/evidence）。
 *
 * 职责：handler 编排层自身不含业务逻辑——调 rules（纯函数）+ store（IO），
 *      所有 IO 能力通过 V1Deps 注入（gitValidator / testRunner / clock / fileExists），
 *      handler 不直接 import node:fs 或调 git。
 *
 * 不变量：本文件只声明类型，零运行时代码。各 handler 文件 import 类型后实现。
 */
import type {
  Clarification,
} from "../core/clarifications.js";
import type { TestRunResult } from "../core/evidence.js";
import type { ArtifactRef } from "../core/evidence.js";
import type {
  DesignReviewJudgment,
  ExecReviewJudgment,
  RetrospectData,
  TestJudgment,
} from "../core/judgments.js";
import type {
  WaveContract,
  WaveFile,
  WaveTask,
  WaveTestCase,
} from "../core/plan.js";
import type { ExecutionStatus } from "../core/status.js";
import type { ExecutionUnit } from "../core/workunit.js";
import type { FreezeViolation } from "../rules/freeze.js";
import type { GateResult } from "../rules/gates/types.js";
import type { ReplanImpact } from "../rules/replan.js";
import type { V1Store } from "../store/v1-store.js";

// ═══════════════════════════════════════════════════════════════
// V1Deps（handler 依赖注入接口）
// ═══════════════════════════════════════════════════════════════

/**
 * handler 的依赖注入接口（IO 能力通过此接口注入，handler 本身不直接做 IO）。
 *
 * - store：JSON 持久化（load / save / loadAll / findChildren）
 * - gitValidator：验 commit hash 是否真实存在（test gate 用）
 * - testRunner：跑测试套件返回结果（test handler 用）
 * - fileExists：验 artifacts[].ref 指向的文件是否存在（closeout drift 检查用）
 * - clock：提供 ISO 8601 时间戳（statusHistory.at / evidence.generatedAt / frozenAt / abandonedAt）
 */
export interface V1Deps {
  store: V1Store;
  gitValidator: { exists: (hash: string) => boolean };
  testRunner: { run: (unit: ExecutionUnit) => TestRunResult };
  /** 验给定 ref（文件路径 / URL）是否存在，用于 closeout 的 artifacts drift 检查。 */
  fileExists: { exists: (ref: string) => boolean };
  clock: { now: () => string };
}

// ═══════════════════════════════════════════════════════════════
// ActionResult（handler 统一返回类型）
// ═══════════════════════════════════════════════════════════════

/**
 * handler 统一返回类型。
 *
 * - ok=true：操作成功（status 已流转、unit 已 save）
 * - ok=false：gate / freeze 校验失败（status 不改、不 save，带 gateResults / freezeViolations 诊断）
 * - replanImpact：仅 replan handler 填（影响面计算结果）
 * - freezeViolations：仅 replan handler 填（append-only 违反）
 * - failureCount：同一 action 连续 fail 次数（从 statusHistory 派生，递进提示用）
 * - nextAction：下一步导航（ok=true 填正常 guidance，ok=false 填异常 guidance）
 */
export interface ActionResult {
  /** 操作后的 WorkUnit id。 */
  unitId: string;
  /** 操作后的 status。 */
  status: ExecutionStatus;
  /** gate 校验结果（如果有跑 gate）。 */
  gateResults?: GateResult[];
  /** 是否成功。 */
  ok: boolean;
  /** 失败原因（ok=false 时）。 */
  error?: string;
  /** replan 的影响面（仅 replan handler 返回）。 */
  replanImpact?: ReplanImpact;
  /** freeze 违规（仅 replan handler 返回）。 */
  freezeViolations?: FreezeViolation[];
  /** 同一 action 连续 fail 次数（从 statusHistory 派生，跨 session 不重置）。 */
  failureCount?: number;
  /** 下一步导航（含 guidance + 结构化字段）。 */
  nextAction?: V1NextAction;
}

// ═══════════════════════════════════════════════════════════════
// V1NextAction（下一步导航结构）
// ═══════════════════════════════════════════════════════════════

/**
 * v5 guidance 系统的下一步导航结构。
 *
 * 设计来源：design-v5-cli-and-guidance.md §8。
 *
 * - action：下一步 action（同层）；undefined 时按三步路由（见注释）
 * - guidance：纯文本（正常三段式 / 异常四段式），agent 优先读这个
 * - unitPath / crossLayer / itemProgress / evidenceProgress：结构化进度字段，供程序化读取
 */
export interface V1NextAction {
  /**
   * 下一步 action（同层）。
   * undefined 时的路由（按序）：
   *   1. crossLayer 非空 → 下一个 unitId = crossLayer.targetUnitId，action 按 kind 推断
   *   2. crossLayer 空 + status 终态 → 流程结束（无 parent 孤立单元 closeout 后落此分支）
   *   3. crossLayer 计算失败 → 兜底 cw tree --unitId <当前> 自查
   */
  action?: string;
  /** guidance 纯文本（正常三段式：位置/下一步/schema+约束；异常四段式：位置/问题/怎么修/递进提示）。 */
  guidance: string;
  /** 当前 unit 在树里的位置。 */
  unitPath: {
    layer: "epic" | "feature" | "slice" | "wave";
    unitId: string;
    /** 无 parent 的孤立单元为空（§1.3，任何层都可无 parent）。 */
    parentUnitId?: string;
    /** 无 parent 时 = 自身。 */
    rootUnitId: string;
  };
  /** 跨层建议（execute 下沉 / closeout 回溯时填）。 */
  crossLayer?: {
    kind: "descend" | "sibling" | "ascend";
    targetLayer?: "epic" | "feature" | "slice" | "wave";
    targetUnitId?: string;
    reason: string;
  };
  /** plan 条目进度。 */
  itemProgress?: Array<{ id: string; status: string }>;
  /** wave 专属：evidence 填充状态。 */
  evidenceProgress?: {
    commitHash: boolean;
    changedFiles: boolean;
    testRunResult: boolean;
    frozen: boolean;
  };
  /** 当前状态下同样合法的可选 action（旁路选项）。 */
  alternatives?: Array<{ action: string; guidance: string }>;
}

// ═══════════════════════════════════════════════════════════════
// 各 handler 的 Input 类型
// ═══════════════════════════════════════════════════════════════

/** create handler 参数（入口 action，不接收已有 unit）。parent 全可选（每层独立起步，§1.3）。 */
export interface CreateInput {
  slug: string;
  objective: string;
  /** 父单元 id（可选——任何层都能无 parent 独立起步）。 */
  parentUnitId?: string;
  /** 引用父层哪些条目 id（创建时快照，影响面计算基础）。无 parent 时为空数组。 */
  basedOnParent?: string[];
}

/** clarify handler 输入（progressive append clarifications）。 */
export interface ClarifyInput {
  clarifications: Clarification[];
}

/** plan handler 输入（写 WavePlan 4 类条目）。 */
export interface PlanInput {
  testCases: WaveTestCase[];
  tasks: WaveTask[];
  files: WaveFile[];
  contracts: WaveContract[];
}

/** design-review handler 输入。 */
export interface DesignReviewInput {
  designReviewJudgment: DesignReviewJudgment;
}

/** execute handler 输入。 */
export interface ExecuteInput {
  commitHash: string;
  /** 本次改动的文件清单（从 commit 提取；可留空数组让后续填）。 */
  changedFiles?: string[];
}

/** test handler 输入。 */
export interface TestInput {
  testJudgment: TestJudgment;
}

/** exec-review handler 输入。 */
export interface ExecReviewInput {
  execReviewJudgment: ExecReviewJudgment;
}

/** retrospect handler 输入。 */
export interface RetrospectInput {
  retrospectData: RetrospectData;
}

/** closeout handler 输入。 */
export interface CloseoutInput {
  /** 交付小结（evidence 主观部分）。 */
  summary?: string;
  /** 交付物引用清单（evidence 主观部分）。 */
  artifacts?: ArtifactRef[];
}

/** replan handler 输入。 */
export interface ReplanInput {
  /** 本次废弃的 WavePlan 条目 id（testCases/tasks/files/contracts 的 WorkUnitItem.id）。 */
  abandonedIds: string[];
  /** replan 原因（写 statusHistory.note）。 */
  note: string;
}

/** abort handler 输入。 */
export interface AbortInput {
  /** abort 原因（写 statusHistory.note）。 */
  reason?: string;
}

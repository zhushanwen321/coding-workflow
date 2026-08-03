/**
 * v1 handlers 共享类型 — handler 编排层的依赖注入接口 + 统一返回 + 各 Input。
 *
 * 来源：v5 wave 附录 A §10-§11（handler 编排骨架）、各阶段产物归宿（plan/judgments/evidence）。
 *
 * 职责：handler 编排层自身不含业务逻辑——调 rules（纯函数）+ store（IO），
 *      所有 IO 能力通过 CwDeps 注入（gitValidator / testRunner / clock / fileExists），
 *      handler 不直接 import node:fs 或调 git。
 *
 * 不变量：本文件只声明类型，零运行时代码。各 handler 文件 import 类型后实现。
 */
import type {
  AcceptanceCriterion,
  BusinessCase,
  Clarification,
  Decision,
  FeatureSpec,
  FunctionalRequirement,
} from "../core/clarifications.js";
import type { TestRunResult } from "../core/evidence.js";
import type { ArtifactRef } from "../core/evidence.js";
import type {
  DesignReviewJudgment,
  ExecReviewJudgment,
  PlanningRetrospectData,
  RetrospectData,
  TestJudgment,
} from "../core/judgments.js";
import type {
  AbandonParentItemsInput,
  SliceDataModel,
  SliceErrorSpec,
  SliceInterface,
  SliceTechChoice,
  Split,
  WaveContract,
  WaveFile,
  WaveTask,
  WaveTestCase,
} from "../core/plan.js";
import type { WorkUnitStatus } from "../core/status.js";
import type { ExecutionUnit } from "../core/workunit.js";
import type { FreezeViolation } from "../rules/freeze.js";
import type { GateResult } from "../rules/gates/types.js";
import type { ReplanImpact } from "../rules/replan.js";
import type { CwStore } from "../store/cw-store.js";

// ═══════════════════════════════════════════════════════════════
// CwDeps（handler 依赖注入接口）
// ═══════════════════════════════════════════════════════════════

/**
 * handler 的依赖注入接口（IO 能力通过此接口注入，handler 本身不直接做 IO）。
 *
 * - store：JSON 持久化（load / save / loadAll / findChildren）
 * - gitValidator：验 commit hash 是否真实存在（test gate 用）
 * - testRunner：跑测试套件返回结果（wave 的 test handler 用，slice 无此阶段故可选）
 * - fileExists：验 artifacts[].ref 指向的文件是否存在（closeout drift 检查用）
 * - clock：提供 ISO 8601 时间戳（statusHistory.at / evidence.generatedAt / frozenAt / abandonedAt）
 * - workspacePath：仓库工作目录（execute handler 提取 changedFiles 时绑 git 子进程 cwd，§4.4）
 */
export interface CwDeps {
  store: CwStore;
  gitValidator: { exists: (hash: string) => boolean };
  /** 跑测试套件返回结果。仅 wave 的 test handler 需要——slice handler 不跑测试，故可选。 wave test handler 使用时做 non-null 断言（slice 不触达）。 */
  testRunner?: { run: (unit: ExecutionUnit) => TestRunResult };
  /** 验给定 ref（文件路径 / URL）是否存在，用于 closeout 的 artifacts drift 检查。 */
  fileExists: { exists: (ref: string) => boolean };
  /** 仓库工作目录（execute handler 提取 changedFiles 时绑 git 子进程 cwd，§4.4）。 */
  workspacePath: string;
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
  /**
   * 操作后的 status。
   *
   * wave handler 返回 ExecutionStatus、slice handler 返回 PlanningStatus；
   * WorkUnitStatus 是两者的联合（core/status.ts），统一容器。
   */
  status: WorkUnitStatus;
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
  /** execute 后新建的子层 unit 信息（仅 epic/feature/slice 三层 planning-execute 返回）。
   * 含 unitId + dependsOn，供递归调度器（如 BFS workflow）拓扑排序消费。 */
  children?: ChildInfo[];
  /** 下一步导航（含 guidance + 结构化字段）。 */
  nextAction?: CwNextAction;
  /** #2 create 幂等：slug 已存在时 no-op 返回 existing（true），未写 store。正常 create 无此字段。 */
  idempotent?: boolean;
}

/** ActionResult.children 的元素类型——execute 返回的子层信息。 */
export interface ChildInfo {
  /** 子层 unit 的 id（如 "wave:xxx::w1"）。 */
  unitId: string;
  /** 该子层依赖的兄弟 unit id 列表（从 plan.split[].dependsOn 的 slug 经 childDelivery 映射转换）。 */
  dependsOn: string[];
}

// ═══════════════════════════════════════════════════════════════
// CwNextAction（下一步导航结构）
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
export interface CwNextAction {
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
  /**
   * 创建哪个层。默认 'wave'（向后兼容）。dispatch 按 layer 决定调 createWave / createSlice / createFeature / createEpic。
   * 取值范围 'wave'|'slice'|'feature'|'epic'（四层全部支持）。
   */
  layer?: "wave" | "slice" | "feature" | "epic";
}

/**
 * 声明脱离 parent 条目的通用能力（跨层跨时机）。
 *
 * 定义已搬入 core/plan.ts（与 Plan*Input 同文件，让 schema-injector 能解析 extends 链）。
 * 此处 re-export 保持现有引用不破坏——PlanInput / ReplanInput / PlanSliceInput /
 * PlanFeatureInput 的 extends 语句无需改动，TS 经此 re-export 能 resolve 到 core。
 *
 * 语义见 core/plan.ts 的 AbandonParentItemsInput 注释，此处不重复。
 */
export type { AbandonParentItemsInput };

/** clarify handler 输入（progressive append clarifications）。 */
export interface ClarifyInput {
  clarifications: Clarification[];
}

/** plan handler 输入（写 WavePlan 4 类条目）。 */
export interface PlanInput extends AbandonParentItemsInput {
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
  /**
   * @deprecated §4.4 changedFiles 由 cw 从 commit 提取，agent 无需传入。
   * 保留字段仅为向后兼容，execute handler 不再读它（传入将被忽略）。
   */
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
export interface ReplanInput extends AbandonParentItemsInput {
  /** 本次废弃的 WavePlan 条目 id（testCases/tasks/files/contracts 的 WorkUnitItem.id）。 */
  abandonedIds: string[];
  /**
   * 新增的 spec 条目（仅 feature 层消费）。
   *
   * 用于「FR1 拆成 FR1a+FR1b」场景：abandonedIds 废弃 FR1，addedSpecItems 追加 FR1a/FR1b（active）。
   * slice/epic replan 不消费此字段，类型兼容留空即可。
   * handler 强制 status='active'，id 由 agent 传入且不得与现有条目 id 冲突（冲突抛 CwEngineError）。
   */
  addedSpecItems?: {
    functionalRequirements?: FunctionalRequirement[];
    acceptanceCriteria?: AcceptanceCriterion[];
    businessCases?: BusinessCase[];
  };
  /** replan 原因（写 statusHistory.note）。 */
  note: string;
}

/** abort handler 输入。 */
export interface AbortInput {
  /** abort 原因（写 statusHistory.note）。 */
  reason?: string;
}

// ═══════════════════════════════════════════════════════════════
// slice 层 handler 的 Input 类型
// ═══════════════════════════════════════════════════════════════
//
// 复用原则：slice 与 wave 产物形态相同的阶段直接复用 wave Input（ClarifyInput /
// DesignReviewInput / CloseoutInput / ReplanInput / AbortInput），只声明 slice 真正
// 不同的（PlanSliceInput / RetrospectSliceInput）。slice execute 不接收 input（按
// split 自动创建 child wave），故无 ExecuteSliceInput。

/**
 * slice plan handler 输入（写 SlicePlan 5 字段 + split）。
 *
 * 与 wave 的 PlanInput 完全不同：wave 写 testCases/tasks/files/contracts，
 * slice 写技术方案（techChoices/interfaces/dataModels/errorSpecs）+ split（拆 wave 清单）。
 *
 * decisions 可选——不传时由 handler 从本层 Clarification 投影（model §5.10）。
 */
export interface PlanSliceInput extends AbandonParentItemsInput {
  techChoices: SliceTechChoice[];
  interfaces: SliceInterface[];
  dataModels: SliceDataModel[];
  errorSpecs: SliceErrorSpec[];
  split: Split[];
  /** 技术决策（投影自本层 Clarification）。可选——不传由 handler 投影。 */
  decisions?: Decision[];
}

/**
 * slice retrospect handler 输入。
 *
 * slice 的 retrospectData 是 PlanningRetrospectData（含 deliveryVerdict / childUnitIdsEvidence /
 * splitFulfillment，验收子 wave 交付），比 wave 的 RetrospectData 宽，无法复用 RetrospectInput。
 */
export interface RetrospectSliceInput {
  retrospectData: PlanningRetrospectData;
}

// ═══════════════════════════════════════════════════════════════
// feature 层 handler 的 Input 类型
// ═══════════════════════════════════════════════════════════════
//
// 复用原则（同 slice）：feature 与其他层产物形态相同的阶段直接复用通用 Input
//（DesignReviewInput / CloseoutInput / ReplanInput / AbortInput），只声明 feature 真正
// 不同的（FeatureClarifyInput / PlanFeatureInput）。feature execute 不接收 input（按
// split 自动创建 child slice），故无 ExecuteFeatureInput。retrospect 直接复用
// RetrospectSliceInput（都是 PlanningRetrospectData），导出类型别名保持命名对称。

/**
 * feature clarify handler 输入（容器对象，形态不对称）。
 *
 * 与通用 ClarifyInput 完全不同：feature 的 clarify 产物是 FeatureClarification 容器
 *（{ clarifications, spec }），不是裸数组。
 */
export interface FeatureClarifyInput {
  clarifications: Clarification[];
  spec: FeatureSpec;
}

/**
 * feature plan handler 输入（Plan 基类，只 split）。
 *
 * 与 slice 的 PlanSliceInput 完全不同：feature 不产技术方案，plan 只拆 slice 清单。
 */
export interface PlanFeatureInput extends AbandonParentItemsInput {
  split: Split[];
}

/**
 * epic plan handler 输入——与 PlanFeatureInput 同型（Plan 基类，只 split）。
 *
 * epic 与 feature 的 plan 都是 Plan 基类（只拆下层清单，不产技术方案），结构完全一致。
 * 导出类型别名保持命名对称，不额外定义结构（运行时 dispatch 按 unit.scope 路由到对应 handler）。
 */
export type PlanEpicInput = PlanFeatureInput;

/**
 * feature retrospect handler 输入——与 RetrospectSliceInput 同型（PlanningRetrospectData）。
 * 导出类型别名保持命名对称，不额外定义结构。
 */
export type RetrospectFeatureInput = RetrospectSliceInput;

/**
 * epic retrospect handler 输入——与 RetrospectSliceInput/RetrospectFeatureInput 同型（PlanningRetrospectData）。
 *
 * epic/feature/slice 三层 PlanningUnit 的 retrospectData 都是 PlanningRetrospectData，结构完全一致。
 * 导出类型别名保持命名对称。
 */
export type RetrospectEpicInput = RetrospectSliceInput;

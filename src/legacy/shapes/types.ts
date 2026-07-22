/**
 * TaskShape 类型层 —— topic: 引入 TaskShape 统一配置轴的纯类型定义。
 *
 * 设计意图：把"如何验证一个 topic"（verification）和"如何审查一个 topic"（review）
 * 从散落在 actions.ts / gate.ts / state-machine.ts 的硬编码 TDD 逻辑里抽出来，
 * 统一成可插拔的策略接口。当前只有 full-tdd（全量 TDD + 全阶段 review），
 * 后续 topic 扩展新 shape（如 spike / migration）只需新增策略实现 + registry 注册。
 *
 * 纯类型，无逻辑，无实现类 import——避免循环依赖（shapes 实现类 import types，
 * types 只 type-only import ../types）。
 */

import type {
  Topic,
  ReviewDimension,
  TestCaseSeed,
  TestRunnerConfig,
} from "../types.js";

/**
 * TaskShape id 联合类型。
 *
 * 当前含：
 *   - "full-tdd"：全量 TDD + 全阶段 review
 *   - "delete-only"：纯删除/存在性验证（existence 策略，W4 注册）
 *   - "doc-only"：纯文档任务（review-only 策略，W4 注册）
 *
 * 后续 topic 扩展新 shape 时往这里加字面量——registry 也要同步加映射，
 * 否则 getShape 会拿到 undefined（回退 full-tdd 降级）。
 */
export type TaskShapeId = "full-tdd" | "delete-only" | "doc-only";

/**
 * ExistenceArtifact — existence 策略声明的产物存在性清单条目。
 *
 * delete-only shape 在 tdd_plan 阶段从 existence.json 写入 topic.existenceArtifacts。
 * postDevVerify 跑 existsSync 验证 path 的实际状态是否符合 expectedState（present/absent），
 * 验证结果缓存到 verified 字段（isDevVerified 读缓存，不跑 IO）。
 *
 * 与 TestCase 平行——existence 策略用 artifact.path 作 caseId 语义（一个 artifact = 一条验证）。
 */
export interface ExistenceArtifact {
  /** 相对 workspacePath 的产物路径。 */
  path: string;
  /** 期望的产物状态：present（应存在）/ absent（应已删除）。 */
  expectedState: "present" | "absent";
  /** postDevVerify 验证后缓存的结果（未跑 postDevVerify 时 undefined）。 */
  verified?: boolean;
}

/**
 * applyPreDevResult 的 store 参数结构化类型（duck typing）。
 *
 * preDevCheck pass 后，applyPreDevResult 把 parsed payload 应用到 store——
 * 替代 handleTddPlan 里硬编码的 insertTestCases/setTestRunner/setExistenceArtifacts。
 * 用结构化类型而非 import CwStore，避免 shapes/types → store 的循环依赖
 * （store → types → shapes/types 已经存在；若 types 再 import store 会成环）。
 *
 * 各 shape 的 applyPreDevResult 按需调自己关心的 setter：
 *   - tdd：insertTestCases + setTestRunner
 *   - existence：setExistenceArtifacts
 *   - review-only：no-op（不调任何 setter）
 */
export interface ApplyPreDevResultStore {
  insertTestCases: (id: string, cases: TestCaseSeed[]) => void;
  setTestRunner: (id: string, r: TestRunnerConfig) => void;
  setExistenceArtifacts: (id: string, a: ExistenceArtifact[]) => void;
}

/**
 * dev 后验证（postDevVerify）返回数组的单条结果。
 *
 * 每个 case 一条——caseId 锁定到 topic.testCases[i].id；passed 是机器重算的布尔判定；
 * actual 是观测值（exitCode/stdout/screenshot 路径等，供 report 渲染和 judgeByExpected 复用）；
 * failureReason 仅在 passed=false 时填，用于 report 定位失败原因。
 */
export interface VerifyResult {
  caseId: string;
  passed: boolean;
  /** 机器重算的真实观测值（exitCode / stdout / 截图路径等）。 */
  actual?: unknown;
  /** passed=false 时的失败原因（供 report 渲染）。 */
  failureReason?: string;
}

/**
 * replanGuard 返回的单条违规。
 *
 * type 是违规类型标识（与原 validateAppendOnly 的 AppendOnlyViolation.type 对齐：
 * wave_deleted_committed / case_modified_passed 等），caseId/waveId 按 type 填其一，
 * reason 是给 agent 看的人类可读说明。
 */
export interface Violation {
  type: string;
  caseId?: string;
  /** wave 违规时填（replanGuard 的 wave_deleted_committed 等）。 */
  waveId?: string;
  reason: string;
}

/**
 * Gate 校验结果——与 gate.ts 的 TddPlanCheckResult 结构兼容。
 *
 * result: pass/fail；report 是给 agent 看的判定说明（含失败定位）；
 * parsed 仅 pass 时 defined（解析后的 payload，供 handler 写入 store）。
 * 字段对齐 TddPlanCheckResult，使 VerificationStrategy.preDevCheck 可直接透传 tddPlanCheck。
 */
export interface GateResult {
  result: "pass" | "fail";
  report: string;
  /** 解析后的 payload（pass 时 defined，结构与具体 strategy 有关）。 */
  parsed?: unknown;
  /** AC 映射 warning（result=pass 但可能未全覆盖，不阻断）。可选。 */
  warning?: string;
}

/**
 * 审查阶段类型（三段）。
 *
 *   - spec_review：spec 章节审查（specReviewIssues / topic.specReviewTurn）
 *   - plan_review：plan 审查（planReviewIssues / topic.planReviewTurn）
 *   - review：代码审查（reviewIssues / topic.reviewTurn）
 *
 * ReviewStagePolicy.stages 是策略声明的启用阶段子集。full-review 三段全开；
 * 轻量 shape（未来）可能只开 review 一段。
 */
export type ReviewStage = "spec_review" | "plan_review" | "review";

/**
 * 验证策略接口——抽象掉 actions.ts / gate.ts 里硬编码的 TDD 逻辑。
 *
 * 四个核心方法对应原 TDD 流程的四个判定点：
 *   - preDevCheck：dev 前的 test.json gate（原 tddPlanCheck）
 *   - postDevVerify：dev 后跑测试 + 判定每个 case（原 handleTest 内联逻辑）
 *   - replanGuard：replan 安全门（原 validateAppendOnly）
 *   - isDevVerified：test gate 是否通过（原 computeGatePassed("test")）
 *
 * 新 shape 注入新策略实现，state-machine / actions 通过 topic.taskShape 路由到对应策略。
 */
export interface VerificationStrategy {
  readonly id: string;
  /** dev 前验证（替代 tdd_plan 的 TDD 逻辑）。payload 是 test.json 内容。 */
  preDevCheck(topic: Topic, payload: unknown): GateResult;
  readonly preDevGateName: string;
  /** dev 后验证（替代 test 的 TDD 逻辑）。返回每个 case 的验证结果。 */
  postDevVerify(topic: Topic): VerifyResult[];
  readonly postDevGateName: string;
  /** replan 安全守卫（替代 validateAppendOnly）。 */
  replanGuard(oldTopic: Topic, newPayload: unknown): Violation[];
  /** gate 判定：dev 验证是否完成（替代 computeGatePassed("test")）。 */
  isDevVerified(topic: Topic): boolean;
  /**
   * preDevCheck pass 后，把 parsed payload 应用到 store。
   *
   * 替代 handleTddPlan 里硬编码的 insertTestCases/setTestRunner（full-tdd）
   * 和 tdd_plan→existence.json 的 setExistenceArtifacts（delete-only）。
   * 各 shape 按自己关心的 parsed 结构调对应 setter——store 用结构化类型 duck typing，
   * 避免 import 整个 CwStore 造成 shapes/types → store 循环依赖。
   */
  applyPreDevResult(
    topicId: string,
    store: ApplyPreDevResultStore,
    parsed: unknown,
  ): void;
}

/**
 * 审查策略接口——抽象掉三阶段 review 的启用配置。
 *
 * stages: 启用的审查阶段（spec_review/plan_review/review 子集）
 * dimensions: 该 shape 关心的审查维度（用于事后统计盲区分布）。
 *   full-review 含代码审查 6 维（不含 spec/plan 审查维度——那些由 stages 启用隐含）。
 */
export interface ReviewStagePolicy {
  readonly id: string;
  readonly stages: readonly ReviewStage[];
  readonly dimensions: readonly ReviewDimension[];
}

/**
 * TaskShape = 验证 ⊕ 审查 的组合。
 *
 * 一个 topic 的"怎么验证 + 怎么审查"由它的 taskShape 字段（TaskShapeId）决定，
 * registry 根据 id 解析出完整 TaskShape。组合而非继承——verification 和 review
 * 可独立演进（未来可能有共用 tdd verification 但不同 review policy 的 shape）。
 */
export interface TaskShape {
  readonly id: TaskShapeId;
  readonly verification: VerificationStrategy;
  readonly review: ReviewStagePolicy;
}

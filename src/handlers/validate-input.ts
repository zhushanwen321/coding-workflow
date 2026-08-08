/* eslint-disable no-magic-numbers -- score 的 1|2|3|4|5 是字面量联合类型约束（类型层），不是运行时魔数（同 core/judgments.ts 模式）。 */
/**
 * v1 handler input shape 校验（#6，W2）。
 *
 * 职责：34 个 handler 入口统一调用 validateInput(action, layer, input)——typebox
 * 全深度严格校验（D-016：嵌套对象全深度 Type.Object，默认 additionalProperties:false），
 * 失败 → CwError「input.<field> 校验失败: <message>」→ CLI 映射 exit 1（非 crash exit 2）。
 *
 * 背景：handler 原本零输入校验。实测传 `{}` → TypeError crash exit 2；
 * 传 `{"clarifications":"hello"}` → 静默存 `['h','e','l','l','o']`。本模块在最早期
 * 阶段（handler 入口、任何 mutation 之前）拦截畸形 input。
 *
 * 与 guidance/action-schemas.ts 的关系：typebox schema 仅做运行时校验，不替换 schema
 * 文本来源（那是 guidance 渲染用）。两套 schema 并存，同源于 handlers/types.ts /
 * core/plan.ts 类型定义。
 *
 * schema 清单（11 个定义，别名复用不重复定义）：
 *   wave 9：DesignInput / DesignReviewInput / ExecuteInput / TestInput /
 *           ExecReviewInput / RetrospectInput / CloseoutInput / ReplanInput / AbortInput
 *   slice：DesignSliceInput / RetrospectSliceInput
 *   feature：DesignFeatureInput（容器形态，含 clarifications + spec；spec 内容由
 *            rules/spec-schema.ts 软校验，保畸形 spec 走 ok=false 可重试路径而非硬 throw）
 *   别名：DesignFeatureInput=DesignEpicInput 共用 DesignFeatureInputSchema；
 *         RetrospectFeatureInput=RetrospectEpicInput=RetrospectSliceInput 共用 RetrospectSliceInputSchema。
 *
 * 显式声明注入字段（F-4）：DesignInput/ReplanInput 含 abandonParentItems?: string[]
 * （buildParams 在 readInput 之后注入，schema 必须显式声明否则 strict 模式误伤）。
 */
import { type TSchema,Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { CwError } from "../core/errors.js";
import {
  AcceptanceCriterionSchema,
  BusinessCaseSchema,
  FunctionalRequirementSchema,
} from "../rules/spec-schema.js";

// ═══════════════════════════════════════════════════════════════
// 基础片段
// ═══════════════════════════════════════════════════════════════

/** WorkUnitItem.status literal（active/abandoned，所有可 replan 追踪条目共用）。 */
const itemStatus = Type.Union([Type.Literal("active"), Type.Literal("abandoned")]);

/** exec-review 的 1|2|3|4|5 score literal。 */
const score5 = Type.Union([
  Type.Literal(1),
  Type.Literal(2),
  Type.Literal(3),
  Type.Literal(4),
  Type.Literal(5),
]);

/** 全深度严格 Object：拒绝未声明的额外字段（D-016，防 agent 拼错字段名被静默忽略）。 */
function strict<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

// ═══════════════════════════════════════════════════════════════
// Clarification（design 共用，四层）
// ═══════════════════════════════════════════════════════════════

const ClarificationSchema = strict({
  id: Type.String(),
  status: itemStatus,
  question: Type.String(),
  resolution: Type.Optional(Type.String()),
  type: Type.Union([Type.Literal("research"), Type.Literal("grilling")]),
});

// ═══════════════════════════════════════════════════════════════
// DesignInput（wave）
// ═══════════════════════════════════════════════════════════════

const WaveTestCaseSchema = strict({
  id: Type.String(),
  status: itemStatus,
  name: Type.String(),
  scenario: Type.String(),
  input: Type.String(),
  expected: Type.String(),
  type: Type.Union([
    Type.Literal("unit"),
    Type.Literal("integration"),
    Type.Literal("e2e"),
    Type.Literal("manual"),
  ]),
  verification: Type.Optional(
    Type.Union([Type.Literal("unit"), Type.Literal("manual"), Type.Literal("review")]),
  ),
});

const WaveTaskSchema = strict({
  id: Type.String(),
  status: itemStatus,
  type: Type.Union([
    Type.Literal("impl"),
    Type.Literal("refactor"),
    Type.Literal("test"),
    Type.Literal("fix"),
    Type.Literal("doc"),
    Type.Literal("other"),
  ]),
  files: Type.Array(Type.String()),
  steps: Type.Array(Type.String()),
  dependsOn: Type.Optional(Type.Array(Type.String())),
});

const WaveFileSchema = strict({
  id: Type.String(),
  status: itemStatus,
  path: Type.String(),
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("modify"),
    Type.Literal("delete"),
  ]),
  description: Type.String(),
});

const WaveContractSchema = strict({
  id: Type.String(),
  status: itemStatus,
  name: Type.String(),
  type: Type.Union([
    Type.Literal("function"),
    Type.Literal("api"),
    Type.Literal("class"),
    Type.Literal("event"),
    Type.Literal("schema"),
    Type.Literal("other"),
  ]),
  definition: Type.String(),
});

/** abandonParentItems 是 buildParams 在 readInput 之后注入的字段（F-4），必须显式声明。 */
const abandonParentItemsField = Type.Optional(Type.Array(Type.String()));

export const DesignInputSchema = strict({
  clarifications: Type.Optional(Type.Array(ClarificationSchema)),
  testCases: Type.Array(WaveTestCaseSchema),
  tasks: Type.Array(WaveTaskSchema),
  files: Type.Array(WaveFileSchema),
  contracts: Type.Array(WaveContractSchema),
  // testCommand 必填：新 design 提交必须带本 wave 测试执行命令（per-wave testCommand 改造 §4.1）。
  testCommand: Type.String(),
  // testCwd 与 ReplanInput 对齐非空校验：纯空白 testCwd 会导致 spawnSync cwd 解析到不存在的目录。
  testCwd: Type.Optional(Type.String({ minLength: 1, pattern: "^\\s*\\S" })),
  abandonParentItems: abandonParentItemsField,
});

// ═══════════════════════════════════════════════════════════════
// DesignSliceInput / DesignFeatureInput（slice / feature / epic design）
// ═══════════════════════════════════════════════════════════════

const SplitSchema = strict({
  slug: Type.String(),
  description: Type.String(),
  dependsOn: Type.Array(Type.String()),
  inheritedItemIds: Type.Optional(Type.Array(Type.String())),
});

const DecisionSchema = strict({
  id: Type.String(),
  decision: Type.String(),
  rationale: Type.String(),
  sourceClarification: Type.Optional(Type.String()),
});

const SliceTechChoiceSchema = strict({
  id: Type.String(),
  status: itemStatus,
  area: Type.String(),
  choice: Type.String(),
  alternatives: Type.Array(Type.String()),
  rationale: Type.String(),
});

const SliceInterfaceSchema = strict({
  id: Type.String(),
  status: itemStatus,
  name: Type.String(),
  signature: Type.String(),
  contract: Type.String(),
});

const SliceDataModelSchema = strict({
  id: Type.String(),
  status: itemStatus,
  name: Type.String(),
  format: Type.Union([
    Type.Literal("typescript"),
    Type.Literal("sql"),
    Type.Literal("json-schema"),
    Type.Literal("protobuf"),
    Type.Literal("freeform"),
  ]),
  definition: Type.String(),
  notes: Type.Optional(Type.String()),
});

const SliceErrorSpecSchema = strict({
  id: Type.String(),
  status: itemStatus,
  interfaceId: Type.Optional(Type.String()),
  scenario: Type.String(),
  strategy: Type.String(),
  httpStatus: Type.Optional(Type.Number()),
  errorCode: Type.Optional(Type.String()),
});

export const DesignSliceInputSchema = strict({
  clarifications: Type.Optional(Type.Array(ClarificationSchema)),
  techChoices: Type.Array(SliceTechChoiceSchema),
  interfaces: Type.Array(SliceInterfaceSchema),
  dataModels: Type.Array(SliceDataModelSchema),
  errorSpecs: Type.Array(SliceErrorSpecSchema),
  split: Type.Array(SplitSchema),
  decisions: Type.Optional(Type.Array(DecisionSchema)),
  abandonParentItems: abandonParentItemsField,
});

/** DesignFeatureInput=DesignEpicInput 共用（feature/epic 的 design 都是 Plan 基类，只拆下层清单）。 */
export const DesignFeatureInputSchema = strict({
  clarifications: Type.Optional(Type.Array(ClarificationSchema)),
  split: Type.Array(SplitSchema),
  // spec 只验「是对象」不深校验内容（Record<string, unknown>）——spec 内容由
  // handler 内 validateFeatureSpec 软校验（畸形 spec 返回 ok=false + failure guidance，
  // agent 可重试），此处深校验会把软失败变成硬 throw。容器形态（clarifications 数组 +
  // spec 对象）仍硬校验——`{}`/`spec:"nope"` 这类结构错误直接 exit 1。
  spec: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  abandonParentItems: abandonParentItemsField,
});

// ═══════════════════════════════════════════════════════════════
// DesignReviewInput（四层共用）
// ═══════════════════════════════════════════════════════════════

const SufficiencyResultSchema = strict({
  gaps: Type.Array(Type.String()),
  overlaps: Type.Array(Type.String()),
  meceNote: Type.String(),
});

const TradeoffSchema = strict({
  id: Type.String(),
  decision: Type.String(),
  reason: Type.String(),
  cost: Type.String(),
});

const RiskSchema = strict({
  id: Type.String(),
  item: Type.String(),
  severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  mitigation: Type.String(),
});

const DesignReviewJudgmentSchema = strict({
  necessity: Type.String(),
  sufficiency: SufficiencyResultSchema,
  alternatives: Type.String(),
  tradeoffs: Type.Array(TradeoffSchema),
  risks: Type.Array(RiskSchema),
  // 各层 layerSpecific 具名 interface 都是 string 值字段，Record 下界即可覆盖。
  layerSpecific: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const DesignReviewInputSchema = strict({
  designReviewJudgment: DesignReviewJudgmentSchema,
});

// ═══════════════════════════════════════════════════════════════
// ExecuteInput（wave）
// ═══════════════════════════════════════════════════════════════

export const ExecuteInputSchema = strict({
  commitHash: Type.String(),
});

// ═══════════════════════════════════════════════════════════════
// TestInput（wave）
// ═══════════════════════════════════════════════════════════════

const SufficiencyMetResultSchema = strict({
  gapsConfirmed: Type.Array(Type.String()),
  gapsNewlyFound: Type.Array(Type.String()),
  overlapsConfirmed: Type.Array(Type.String()),
  note: Type.Optional(Type.String()),
});

const TradeoffCostRealizedSchema = strict({
  tradeoffRef: Type.String(),
  costRealized: Type.Boolean(),
  note: Type.Optional(Type.String()),
});

const RiskOutcomeSchema = strict({
  riskRef: Type.String(),
  outcome: Type.Union([
    Type.Literal("materialized"),
    Type.Literal("not-materialized"),
    Type.Literal("mitigated"),
  ]),
  note: Type.Optional(Type.String()),
});

const TestJudgmentSchema = strict({
  necessityMet: Type.String(),
  sufficiencyMet: SufficiencyMetResultSchema,
  alternativesReconsidered: Type.String(),
  tradeoffCostRealized: Type.Array(TradeoffCostRealizedSchema),
  riskOutcome: Type.Array(RiskOutcomeSchema),
});

export const TestInputSchema = strict({
  testJudgment: TestJudgmentSchema,
});

// ═══════════════════════════════════════════════════════════════
// ExecReviewInput（wave）
// ═══════════════════════════════════════════════════════════════

const ScoreDimensionSchema = strict({
  score: score5,
  issues: Type.Optional(Type.Array(Type.String())),
});

const ExecReviewLayerSpecificSchema = strict({
  testCodeQuality: Type.Optional(ScoreDimensionSchema),
  mockFidelityNote: Type.Optional(Type.String()),
});

const FollowupActionSchema = strict({
  description: Type.String(),
  priority: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
  targetScope: Type.Union([
    Type.Literal("current-wave-replan"),
    Type.Literal("next-wave"),
    Type.Literal("slice-level-refactor"),
    Type.Literal("adr-candidate"),
  ]),
});

const ExecReviewJudgmentSchema = strict({
  readability: ScoreDimensionSchema,
  architecture: ScoreDimensionSchema,
  codeSmells: Type.Optional(
    strict({
      items: Type.Array(Type.String()),
      severity: Type.Optional(
        Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
      ),
    }),
  ),
  layerSpecific: Type.Optional(ExecReviewLayerSpecificSchema),
  overallVerdict: Type.Union([Type.Literal("pass"), Type.Literal("needs-followup")]),
  followupActions: Type.Optional(Type.Array(FollowupActionSchema)),
});

export const ExecReviewInputSchema = strict({
  execReviewJudgment: ExecReviewJudgmentSchema,
});

// ═══════════════════════════════════════════════════════════════
// RetrospectInput（wave）/ RetrospectSliceInput（slice/feature/epic）
// ═══════════════════════════════════════════════════════════════

const ReviewedItemSchema = strict({
  itemId: Type.String(),
  outcome: Type.Union([
    Type.Literal("fulfilled"),
    Type.Literal("partial"),
    Type.Literal("unfulfilled"),
  ]),
  note: Type.Optional(Type.String()),
});

const WrongJudgmentSchema = strict({
  judgmentRef: Type.String(),
  whyWrong: Type.String(),
  whatActuallyHappened: Type.String(),
});

const BadTradeoffSchema = strict({
  tradeoffRef: Type.String(),
  costOverrun: Type.String(),
  note: Type.Optional(Type.String()),
});

const MissedGapSchema = strict({
  where: Type.Union([
    Type.Literal("design"),
    Type.Literal("design-review"),
    Type.Literal("execute"),
    Type.Literal("test"),
  ]),
  gap: Type.String(),
});

const ProcessIssueSchema = strict({
  type: Type.Union([
    Type.Literal("design"),
    Type.Literal("split"),
    Type.Literal("replan"),
    Type.Literal("execute"),
    Type.Literal("test"),
    Type.Literal("review"),
    Type.Literal("other"),
  ]),
  issue: Type.String(),
});

const RetrospectDataSchema = strict({
  reviewedItems: Type.Array(ReviewedItemSchema),
  lessonsLearned: Type.String(),
  wrongJudgments: Type.Optional(Type.Array(WrongJudgmentSchema)),
  badTradeoffs: Type.Optional(Type.Array(BadTradeoffSchema)),
  missedGaps: Type.Optional(Type.Array(MissedGapSchema)),
  processIssues: Type.Optional(Type.Array(ProcessIssueSchema)),
});

export const RetrospectInputSchema = strict({
  retrospectData: RetrospectDataSchema,
});

/**
 * PlanningRetrospectData = RetrospectData 基类字段 + planning 三层专属字段。
 * schema 复用基类字段（spread properties），不重复定义。
 */
const PlanningRetrospectDataSchema = strict({
  ...RetrospectDataSchema.properties,
  deliveryVerdict: Type.Union([
    Type.Literal("delivered"),
    Type.Literal("partial"),
    Type.Literal("failed"),
  ]),
  childUnitIdsEvidence: Type.Array(
    strict({
      childId: Type.String(),
      status: Type.Union([Type.Literal("closed"), Type.Literal("aborted")]),
      closeoutEvidenceSummary: Type.Optional(Type.String()),
    }),
  ),
  splitFulfillment: Type.Array(
    strict({
      splitSlug: Type.String(),
      verdict: Type.Union([
        Type.Literal("delivered"),
        Type.Literal("partial"),
        Type.Literal("failed"),
      ]),
      note: Type.Optional(Type.String()),
    }),
  ),
});

/** RetrospectSliceInput / RetrospectFeatureInput / RetrospectEpicInput 共用。 */
export const RetrospectSliceInputSchema = strict({
  retrospectData: PlanningRetrospectDataSchema,
});

// ═══════════════════════════════════════════════════════════════
// CloseoutInput（四层共用）
// ═══════════════════════════════════════════════════════════════

const ArtifactRefSchema = strict({
  // 注意：kind 是「产物类型分类」（spec/plan/review-report/...），是稳定的产物分类标签。
  // "plan" 指代「设计文档」产物，向后兼容历史 closeout evidence。
  kind: Type.Union([
    Type.Literal("spec"),
    Type.Literal("plan"),
    Type.Literal("review-report"),
    Type.Literal("retrospect-report"),
    Type.Literal("code"),
    Type.Literal("test"),
    Type.Literal("doc"),
    Type.Literal("other"),
    Type.Literal("commit"),
  ]),
  ref: Type.String(),
  note: Type.Optional(Type.String()),
});

export const CloseoutInputSchema = strict({
  summary: Type.Optional(Type.String()),
  artifacts: Type.Optional(Type.Array(ArtifactRefSchema)),
});

// ═══════════════════════════════════════════════════════════════
// ReplanInput（四层共用；addedSpecItems 仅 feature 层消费，schema 统一收）
// ═══════════════════════════════════════════════════════════════

export const ReplanInputSchema = strict({
  abandonedIds: Type.Array(Type.String()),
  // 非空校验（与 design-review gate testCommandNonEmpty 的 trim 判空对齐）：
  // 空串/纯空白 replan 会覆盖清空 executing wave 已有的合法 testCommand（写入条件只判 !== undefined），
  // 且 replan 不改 status 不走 design-review，无 gate 兜底——schema 层直接拒绝。
  // pattern ^\s*\S 拒绝纯空白串（minLength 只拦空串，"   " 长度 3 ≥ 1 会放行）。
  testCommand: Type.Optional(Type.String({ minLength: 1, pattern: "^\\s*\\S" })),
  // testCwd 与 testCommand 同属非空路径：空串/纯空白会覆盖清空已有合法 testCwd，复用 testCommand 的 pattern 对齐。
  testCwd: Type.Optional(Type.String({ minLength: 1, pattern: "^\\s*\\S" })),
  addedSpecItems: Type.Optional(
    strict({
      functionalRequirements: Type.Optional(Type.Array(FunctionalRequirementSchema)),
      acceptanceCriteria: Type.Optional(Type.Array(AcceptanceCriterionSchema)),
      businessCases: Type.Optional(Type.Array(BusinessCaseSchema)),
    }),
  ),
  note: Type.String(),
  abandonParentItems: abandonParentItemsField,
});

// ═══════════════════════════════════════════════════════════════
// AbortInput（四层共用）
// ═══════════════════════════════════════════════════════════════

export const AbortInputSchema = strict({
  reason: Type.Optional(Type.String()),
});

// ═══════════════════════════════════════════════════════════════
// INPUT_SCHEMAS 映射表 + validateInput
// ═══════════════════════════════════════════════════════════════

/** handler 层（unit scope）。 */
export type HandlerLayer = "wave" | "slice" | "feature" | "epic";

/**
 * (layer, action) → schema 映射表。
 *
 * 覆盖全部带 input 的 handler 入口（wave 9 + slice/feature/epic 各 6 = 27）：
 *   - planning 层 execute 无 input 参数（handler 签名无 input），不校验不登记
 *   - create 无 input（flag 构造），不校验不登记
 *   - test/exec-review 是 wave 专属（planning 层 dispatch 已抛 illegal_transition），只登记 wave
 * 全覆盖由 tests/validate-input.test.ts T2.6 断言锁住（防新增 handler 漏接线）。
 */
export const INPUT_SCHEMAS: Readonly<Record<HandlerLayer, Partial<Record<string, TSchema>>>> = {
  wave: {
    design: DesignInputSchema,
    "design-review": DesignReviewInputSchema,
    execute: ExecuteInputSchema,
    test: TestInputSchema,
    "exec-review": ExecReviewInputSchema,
    retrospect: RetrospectInputSchema,
    closeout: CloseoutInputSchema,
    replan: ReplanInputSchema,
    abort: AbortInputSchema,
  },
  slice: {
    design: DesignSliceInputSchema,
    "design-review": DesignReviewInputSchema,
    retrospect: RetrospectSliceInputSchema,
    closeout: CloseoutInputSchema,
    replan: ReplanInputSchema,
    abort: AbortInputSchema,
  },
  feature: {
    design: DesignFeatureInputSchema,
    "design-review": DesignReviewInputSchema,
    retrospect: RetrospectSliceInputSchema,
    closeout: CloseoutInputSchema,
    replan: ReplanInputSchema,
    abort: AbortInputSchema,
  },
  epic: {
    design: DesignFeatureInputSchema,
    "design-review": DesignReviewInputSchema,
    retrospect: RetrospectSliceInputSchema,
    closeout: CloseoutInputSchema,
    replan: ReplanInputSchema,
    abort: AbortInputSchema,
  },
};

/**
 * handler 入口统一 input 校验（纯函数，零 IO）。
 *
 * 每个带 input 的 handler 函数体首行调用（mutation 之前）。校验失败 →
 * CwError「input.<field> 校验失败: <errors[0].message>」（CLI 映射 exit 1，非 crash exit 2）。
 * 错误文案以 `input.<field>` 前缀开头（T2.4 断言前缀匹配），field 取自 typebox errors[0].path
 * （如 /clarifications → clarifications；顶层错误 path 为空 → input）。
 *
 * @param action 当前 action 名（如 "design"）
 * @param layer 当前 unit 的 scope（wave/slice/feature/epic）
 * @param input agent 提交的原始 input（unknown，任意形态）
 */
export function validateInput(action: string, layer: HandlerLayer, input: unknown): void {
  const schema = INPUT_SCHEMAS[layer][action];
  if (schema === undefined) {
    // 映射表缺口 = 开发期接线错误（T2.6 全覆盖断言保证正常路径不会到这）。
    // 抛 CwError 而非静默跳过——静默 = 回到零校验状态，正是本 issue 要消除的。
    throw new CwError(`input 校验失败: 未登记 (${layer}, ${action}) 的 schema`);
  }
  if (Value.Check(schema, input)) return;
  const errors = Array.from(Value.Errors(schema, input));
  const first = errors[0];
  if (!first) {
    // 防御性兜底：Value.Check=false 但 Errors 空迭代（typebox 边界），保持 exit 1 语义
    // （校验失败 → CwError），而非让 first.path 抛 TypeError 被归为 exit 2 内部异常（S6）。
    throw new CwError(
      "input 校验失败: 未知错误（schema 校验未通过但无错误详情）",
    );
  }
  const field = first.path === "" ? "input" : first.path.replace(/^\//, "");
  throw new CwError(`input.${field} 校验失败: ${first.message}`);
}

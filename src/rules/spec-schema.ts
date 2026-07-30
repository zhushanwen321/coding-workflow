/**
 * v1 rules — FeatureSpec 的 typebox schema + 校验纯函数。
 *
 * 设计来源：core/clarifications.ts 的 FeatureSpec interface（feature clarify 阶段的 spec 产物）。
 *
 * 为什么需要它：feature clarify handler 原本对 spec 内部结构零校验，agent 提交畸形 spec
 * （如 FR 字段名拼错、缺 ac 数组）会直接覆盖入库，到 design-review gate 访问 fr.ac.length 时
 * 抛 `Cannot read properties of undefined`，崩在 rules 层（非可读 fail）。schema 在 clarify 写入前
 * 拦截畸形结构，让 agent 在最早阶段看到「字段路径: 错误描述」可读报错。
 *
 * 不变量：零 IO，零 mock，纯函数。schema 启用 strict 模式（additionalProperties: false），拒绝
 * 未声明的额外字段，避免 agent 拼错字段名（如 FR 写成 `acId` 替代 `ac`）时被静默忽略。
 * 已知合法的 agent 附加信息（priority / statement）显式声明为 Optional。
 */
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { FeatureSpec } from "../core/clarifications.js";

// ═══════════════════════════════════════════════════════════════
// FeatureSpec 的 typebox schema（与 FeatureSpec interface 同构）
// ═══════════════════════════════════════════════════════════════

/**
 * WorkUnitItem 的 status literal（active/abandoned，所有可 replan 追踪条目共用）。
 *
 * FR/AC/BC 都 extends WorkUnitItem，status 必须是这两个 literal 之一。
 */
const itemStatus = Type.Union([Type.Literal("active"), Type.Literal("abandoned")]);

/**
 * FunctionalRequirement 的 schema（FR，feature 专属，model §5.7）。
 *
 * 必填：id / status / title / detail / ac（ac 是引用 AC id 的 string 数组，FR-AC 强引用的基础）。
 * ac 缺失是崩溃根因——schema 拒绝缺 ac 的 FR，在 clarify 阶段挡下。
 * 额外字段（priority/statement 等 agent 自创字段）用 Optional 允许：不破坏已入库数据，
 * agent 附加信息无害（gate 不读这些字段）。
 */
const FunctionalRequirementSchema = Type.Object({
  id: Type.String(),
  status: itemStatus,
  title: Type.String(),
  detail: Type.String(),
  ac: Type.Array(Type.String()),
  // 显式声明 agent 已使用的附加字段，避免 strict 模式误伤。
  priority: Type.Optional(Type.Unknown()),
  statement: Type.Optional(Type.Unknown()),
}, { additionalProperties: false });

/**
 * AcceptanceCriterion 的 schema（AC，feature 专属，model §5.7）。
 *
 * 必填：id / status / condition。verification 可选（沿用 cw 0.x 命名）。
 */
const AcceptanceCriterionSchema = Type.Object({
  id: Type.String(),
  status: itemStatus,
  condition: Type.String(),
  verification: Type.Optional(
    Type.Union([Type.Literal("unit"), Type.Literal("manual"), Type.Literal("review")]),
  ),
}, { additionalProperties: false });

/**
 * BusinessCase 的 schema（UC，feature 专属，model §5.7）。
 *
 * 必填：id / status / actor / scenario / expectedResult。
 */
const BusinessCaseSchema = Type.Object({
  id: Type.String(),
  status: itemStatus,
  actor: Type.String(),
  scenario: Type.String(),
  expectedResult: Type.String(),
}, { additionalProperties: false });

/**
 * Decision 的 schema（投影自 Clarification，不继承 WorkUnitItem）。
 *
 * 必填：id / decision / rationale。sourceClarification 可选。
 */
const DecisionSchema = Type.Object({
  id: Type.String(),
  decision: Type.String(),
  rationale: Type.String(),
  sourceClarification: Type.Optional(Type.String()),
}, { additionalProperties: false });

/**
 * FeatureSpec 的 typebox schema（与 FeatureSpec interface 同构）。
 *
 * 结构化条目（必填，数组）：functionalRequirements / acceptanceCriteria / businessCases / decisions。
 * 规格辅助字段：outOfScope 必填（数组）；goals / complexity 可选。
 * md 章节：background / constraints 可选。
 *
 * schema 只验结构（字段存在 + 类型对），不验业务约束（如 FR.ac 引用的 AC id 是否存在——
 * 那是 design-review gate frAcCoverage 的职责，schema 层不重复）。
 */
export const FeatureSpecSchema = Type.Object({
  functionalRequirements: Type.Array(FunctionalRequirementSchema),
  acceptanceCriteria: Type.Array(AcceptanceCriterionSchema),
  businessCases: Type.Array(BusinessCaseSchema),
  decisions: Type.Array(DecisionSchema),
  outOfScope: Type.Array(Type.String()),
  goals: Type.Optional(Type.Array(Type.String())),
  complexity: Type.Optional(
    Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("unknown"),
    ]),
  ),
  background: Type.Optional(Type.String()),
  constraints: Type.Optional(Type.String()),
}, { additionalProperties: false });

// schema 入参类型从 Value.Check 签名派生（避免跨版本 TSchema 导出不稳定，同 plan-parser.ts）。
type SpecSchema = Parameters<typeof Value.Check>[0];

// ═══════════════════════════════════════════════════════════════
// validateFeatureSpec（纯函数校验入口）
// ═══════════════════════════════════════════════════════════════

/** 校验错误上限：截断超长错误列表，避免 guidance 被错误信息淹没（同 plan-parser MAX_SCHEMA_ERRORS）。 */
const MAX_SPEC_ERRORS = 8;

export interface FeatureSpecValidationResult {
  valid: boolean;
  /** 每条错误形如 `字段路径: 错误描述`（如 `/functionalRequirements/0/ac: Expected array`）。valid 时为空数组。 */
  errors: string[];
}

/**
 * 校验 FeatureSpec 结构（纯函数）。
 *
 * 用 Value.Errors 拿结构化错误流，每条转成 `路径: 描述` 字符串，截断到 MAX_SPEC_ERRORS 条。
 * 路径形如 `/functionalRequirements/0/ac`（typebox 错误的 path 字段），agent 可据此定位到
 * 具体哪个 FR 的哪个字段缺了。
 *
 * 入参是 unknown（agent 提交的原始数据，可能任意形态），不假设已通过 TS 类型检查。
 * 返回 valid=true 时，spec 可安全覆盖写入 store（结构合规，gate 访问不会 undefined 崩溃）。
 *
 * @param spec agent 提交的 FeatureSpec（unknown，结构未知）
 * @returns { valid, errors } —— valid=false 时 errors 含具体字段路径
 */
export function validateFeatureSpec(spec: unknown): FeatureSpecValidationResult {
  return validateSchema(FeatureSpecSchema, spec, "");
}

/**
 * 内部共用 schema 校验（参考 plan-parser.ts 的 assertSchema，但不 throw，返回结果对象）。
 *
 * @param schema typebox schema
 * @param value 待校验值
 * @param pathPrefix 错误路径前缀（顶层调用传空串）
 */
function validateSchema(
  schema: SpecSchema,
  value: unknown,
  pathPrefix: string,
): FeatureSpecValidationResult {
  if (Value.Check(schema, value)) {
    return { valid: true, errors: [] };
  }
  const errors = Array.from(Value.Errors(schema, value))
    .map((e) => {
      // typebox 的 path 形如 "/functionalRequirements/0/ac"，顶层缺字段时 path 为空串——补 "spec"
      const p = e.path === "" ? pathPrefix || "spec" : `${pathPrefix || "spec"}${e.path}`;
      return `${p}: ${e.message}`;
    })
    .slice(0, MAX_SPEC_ERRORS);
  return { valid: false, errors };
}

// 重新导出 FeatureSpec 类型，让消费方不必从 core/clarifications 单独引（spec-schema 语义内聚）。
export type { FeatureSpec };

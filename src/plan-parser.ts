/**
 * plan-parser — lite plan.json schema 解析（typebox）。
 *
 * 输入：plan.json（lite-plan skill 产出）。
 * 校验链：size guard → format 字段硬编码 === "lite" → typebox Value.Check 结构校验。
 * 输出：ParsedLitePlan（waves + testCases seed），供 plan action handler 写入 store。
 *
 * 与旧版的差异（重构 = 推倒重建）：
 * - 砍 MidClarifySchema / MidDetailSchema / TestCaseSubmissionSchema（mid 专属）
 * - format 从 `=== tier 锁定值` 改为硬编码 `=== "lite"`（tier 字段彻底砍掉）
 * - 砍 assertAcyclicDeps（环形依赖潜伏到 execute 阶段报错，本轮可接受——
 *   plan gate 不再做依赖无环质量约束，交回 skill 文档管）
 * - WaveSeed 砍 parallelGroup/issues，TestCaseSeed 砍 assertion/parallelGroup/file/describe
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { TestCaseSeed, WaveSeed } from "./types.js";

// ── LitePlanSchema（§12 architecture，typebox 声明） ─────────

/**
 * 导出供 tool schema 复用：tool 层和 parser 层共用同一 schema 定义，避免漂移。
 *
 * format 锁定为 "lite" literal——typebox 在结构校验阶段即拒绝非 lite 的 format 值，
 * parseLitePlan 还有一道显式 assertFormat 做前置 + 给更精确的错误消息。
 */
export const LitePlanSchema = Type.Object({
  format: Type.Literal("lite"),
  objective: Type.String(),
  waves: Type.Array(
    Type.Object({
      id: Type.String(),
      changes: Type.Array(Type.String()),
      dependsOn: Type.Array(Type.String()),
    }),
  ),
  testCases: Type.Array(
    Type.Object({
      id: Type.String(),
      layer: Type.Union([Type.Literal("mock"), Type.Literal("real")]),
      scenario: Type.String(),
      steps: Type.String(),
      expected: Type.Object({
        url: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
      }),
      executor: Type.String(),
      /**
       * 本用例是否要求 screenshotPath（cw test 据此判断缺失即 failed）。
       * plan 阶段 agent 按用例性质决定：mock 层通常 false（无 UI/真实环境），
       * real 层通常 true（验证真实跑通）；但 agent 可按用例需要覆写。
       */
      requiresScreenshot: Type.Boolean(),
      /**
       * 测试调度：执行顺序依赖。本用例依赖哪些前置用例建的数据状态。
       * workflow 据此拓扑排序；是硬依赖（上游 fail 则 abort 下游）。
       * 注意：engine 本次不做依赖无环校验（assertAcyclicDeps 砍掉），
       * 环形依赖潜伏到 execute 报错——交回 skill 文档管。
       */
      dependsOn: Type.Optional(Type.Array(Type.String())),
    }),
  ),
});

// schema 入参类型从 Value.Check 签名派生（避免跨版本 TSchema 导出不稳定）。
type Schema = Parameters<typeof Value.Check>[0];

// ── 解析结果类型 ─────────────────────────────────────────────

export interface ParsedLitePlan {
  waves: WaveSeed[];
  testCases: TestCaseSeed[];
}

// ── size / depth guard（T2.17 超 1MB 拒 / T2.29 深嵌套爆栈防护） ──

const MAX_PLAN_BYTES = 1048576; // 1 MiB

/**
 * 入口 size + depth guard：JSON.stringify 测大小 + 捕 RangeError（深嵌套爆栈）。
 * 放在最前：拒绝超大/深嵌套输入后再做结构校验（安全/性能）。
 */
function assertSafeSize(obj: unknown, label: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(obj);
  } catch (e) {
    if (e instanceof RangeError) {
      throw new Error(
        `invalid ${label}: deeply nested (JSON.stringify stack overflow rejected)`,
      );
    }
    throw e;
  }
  if (serialized.length > MAX_PLAN_BYTES) {
    throw new Error(
      `${label} too large: ${serialized.length} bytes > ${MAX_PLAN_BYTES} (1MB limit, T2.17)`,
    );
  }
}

// ── 共用校验 ─────────────────────────────────────────────────

/**
 * format 硬编码锁定校验：json.format 必须 === "lite"。
 *
 * tier 字段已彻底砍掉（lite-only），不再依赖 topic.tier 做锁定值比对。
 * 放在 typebox schema 校验之前：给更精确的「format 不匹配」错误消息，
 * 而非 typebox 的结构化字段错误（后者对 format 类型的报读不够直观）。
 */
function assertFormat(json: unknown): void {
  if (typeof json !== "object" || json === null) {
    throw new Error("invalid plan json: not an object");
  }
  const format = "format" in json ? json.format : undefined;
  if (format !== "lite") {
    throw new Error(
      `format mismatch: json.format="${String(format)}" but lite-only engine requires "lite" ` +
        `(tier 已砍，format 硬编码锁定)`,
    );
  }
}

/** assertSchema 报错时最多展示的错误条数（防消息爆炸）。 */
const MAX_SCHEMA_ERRORS = 5;

/** typebox Value.Check + 结构化报错（缺字段/类型错）。 */
function assertSchema(schema: Schema, json: unknown, label: string): void {
  if (!Value.Check(schema, json)) {
    const errors = Array.from(Value.Errors(schema, json))
      .map((e) => `${e.path}: ${e.message}`)
      .slice(0, MAX_SCHEMA_ERRORS)
      .join("; ");
    throw new Error(`invalid ${label} json: ${errors}`);
  }
}

// ── 解析函数（入口：size guard → format 锁定 → schema 校验 → extract） ──

/**
 * parseLitePlan — 解析 lite plan.json。
 *
 * 校验链：assertSafeSize → assertFormat（=== "lite"）→ assertSchema（typebox）→ extract。
 * 砍掉 assertAcyclicDeps：环形依赖本轮不检，潜伏到 execute 报错。
 *
 * tier 参数已移除（lite-only 硬编码，不再需要外部传 tier 锁定值）。
 */
export function parseLitePlan(json: unknown): ParsedLitePlan {
  assertSafeSize(json, "lite plan");
  assertFormat(json);
  assertSchema(LitePlanSchema, json, "lite plan");
  return extractLitePlan(json);
}

// ── extract（json 已过 schema 校验，结构安全） ───────────────

function extractLitePlan(json: unknown): ParsedLitePlan {
  const obj = json as {
    waves: Array<{
      id: string;
      changes: string[];
      dependsOn: string[];
    }>;
    testCases: Array<{
      id: string;
      layer: "mock" | "real";
      scenario: string;
      steps: string;
      expected: { url?: string; text?: string };
      executor: string;
      requiresScreenshot: boolean;
      dependsOn?: string[];
    }>;
  };
  return {
    waves: obj.waves.map((w) => ({
      id: w.id,
      dependsOn: w.dependsOn,
      changes: w.changes,
    })),
    testCases: obj.testCases.map((c) => ({
      id: c.id,
      layer: c.layer,
      scenario: c.scenario,
      steps: c.steps,
      expected: c.expected,
      executor: c.executor,
      requiresScreenshot: c.requiresScreenshot,
      dependsOn: c.dependsOn,
    })),
  };
}

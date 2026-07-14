/**
 * plan-parser — dev-plan.json + test.json schema 解析（typebox）。
 *
 * 输入：
 * - dev-plan.json（旧名 plan.json）：format + objective + waves
 * - test.json：testCases + testRunner（可选）
 *
 * 校验链：size guard → format 字段硬编码 === "lite" → typebox Value.Check 结构校验。
 * 输出：ParsedDevPlan（waves）+ ParsedTestJson（testCases），供 action handler 写入 store。
 *
 * 向后兼容：旧版 plan.json 同时含 waves + testCases 时，parseDevPlan 自动提取 testCases
 * 到 ParsedDevPlan.legacyTestCases，由 handlePlan 传给 store。
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { AdrSeed, ClarifySeed, TestCaseSeed, TestRunnerConfig, WaveSeed } from "./types.js";
import { CwError } from "./types.js";

// ── DevPlanSchema（dev-plan.json，只含 waves） ──────────────

/**
 * dev-plan.json 的 typebox schema。
 *
 * 只管 dev 规划（waves），testCases 已移到 test.json（tdd_plan 阶段提交）。
 * format 锁定为 "lite" literal——typebox 在结构校验阶段即拒绝非 lite 的 format 值。
 *
 * 旧版 plan.json 兼容：如果同时含 testCases 字段，schema 不报错（testCases 是 Optional），
 * parseDevPlan 会提取到 legacyTestCases。
 */
export const DevPlanSchema = Type.Object({
  format: Type.Literal("lite"),
  objective: Type.String(),
  waves: Type.Array(
    Type.Object({
      id: Type.String(),
      changes: Type.Array(Type.String()),
      dependsOn: Type.Array(Type.String()),
      priority: Type.Optional(
        Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2")]),
      ),
    }),
  ),
});

// ── TestJsonSchema（test.json，含 testCases + testRunner） ───

/**
 * test.json 的 typebox schema。
 *
 * testCases：测试用例定义（id/layer/scenario/steps/expected/executor/priority/redCheck）。
 * testRunner：可选的项目级测试执行配置（mode/command/cwd/path）。
 */
export const TestJsonSchema = Type.Object({
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
      requiresScreenshot: Type.Boolean(),
      dependsOn: Type.Optional(Type.Array(Type.String())),
      priority: Type.Optional(
        Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2")]),
      ),
      redCheck: Type.Optional(Type.Boolean()),
    }),
  ),
  testRunner: Type.Optional(
    Type.Object({
      mode: Type.Union([
        Type.Literal("nodejs"),
        Type.Literal("python"),
        Type.Literal("java"),
        Type.Literal("custom"),
      ]),
      command: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
    }),
  ),
});

// ── 向后兼容：旧版 LitePlanSchema（同时含 waves + testCases） ──

/**
 * 旧版 plan.json schema（同时含 waves + testCases）。
 *
 * 保留用于向后兼容：旧版 plan.json 调 cw plan 时，handlePlan 检测到 testCases 字段
 * 后自动提取到 store（兼容模式），agent 不需要拆分文件。
 *
 * 新流程推荐使用拆分的 dev-plan.json + test.json。
 */
export const LegacyPlanSchema = Type.Object({
  format: Type.Literal("lite"),
  objective: Type.String(),
  waves: Type.Array(
    Type.Object({
      id: Type.String(),
      changes: Type.Array(Type.String()),
      dependsOn: Type.Array(Type.String()),
      priority: Type.Optional(
        Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2")]),
      ),
    }),
  ),
  testCases: Type.Optional(
    Type.Array(
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
        requiresScreenshot: Type.Boolean(),
        dependsOn: Type.Optional(Type.Array(Type.String())),
        priority: Type.Optional(
          Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2")]),
        ),
        redCheck: Type.Optional(Type.Boolean()),
      }),
    ),
  ),
});

// schema 入参类型从 Value.Check 签名派生（避免跨版本 TSchema 导出不稳定）。
type Schema = Parameters<typeof Value.Check>[0];

// ── 解析结果类型 ─────────────────────────────────────────────

export interface ParsedDevPlan {
  objective: string;
  waves: WaveSeed[];
  /**
   * 旧版兼容：如果 dev-plan.json 同时含 testCases（旧格式），提取到这里。
   * 新格式（拆分后的 dev-plan.json）此字段为 undefined。
   */
  legacyTestCases?: TestCaseSeed[];
}

export interface ParsedTestJson {
  testCases: TestCaseSeed[];
  testRunner?: TestRunnerConfig;
}

// ── size / depth guard（T2.17 超 1MB 拒 / T2.29 深嵌套爆栈防护） ──

const MAX_PLAN_BYTES = 1048576; // 1 MiB

function assertSafeSize(obj: unknown, label: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(obj);
  } catch (e) {
    if (e instanceof RangeError) {
      throw new CwError(
        `invalid ${label}: deeply nested (JSON.stringify stack overflow rejected)`,
      );
    }
    throw e;
  }
  if (serialized.length > MAX_PLAN_BYTES) {
    throw new CwError(
      `${label} too large: ${serialized.length} bytes > ${MAX_PLAN_BYTES} (1MB limit, T2.17)`,
    );
  }
}

// ── 环形依赖检测 ─────────────────────────────────────────────

interface DepNode {
  id: string;
  dependsOn?: string[];
}

function assertAcyclicDeps(items: DepNode[], label: string): void {
  if (items.length === 0) return;

  const nodeMap = new Map<string, DepNode>();
  for (const item of items) {
    nodeMap.set(item.id, item);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const item of items) {
    color.set(item.id, WHITE);
  }

  function dfs(id: string, path: string[]): boolean {
    color.set(id, GRAY);
    const node = nodeMap.get(id);
    const deps = node?.dependsOn ?? [];
    for (const dep of deps) {
      if (!color.has(dep)) continue;
      const depColor = color.get(dep);
      if (depColor === GRAY) {
        const cycleStart = path.indexOf(dep);
        const cycleChain = [...path.slice(cycleStart), id, dep].join("→");
        throw new CwError(
          `${label} 存在环形 dependsOn 依赖（cycle detected）: ${cycleChain}`,
        );
      }
      if (depColor === WHITE) {
        if (dfs(dep, [...path, id])) return true;
      }
    }
    color.set(id, BLACK);
    return false;
  }

  for (const item of items) {
    if (color.get(item.id) === WHITE) {
      dfs(item.id, []);
    }
  }
}

// ── 共用校验 ─────────────────────────────────────────────────

function assertFormat(json: unknown, label: string): void {
  if (typeof json !== "object" || json === null) {
    throw new CwError(`invalid ${label} json: not an object`);
  }
  const format = "format" in json ? json.format : undefined;
  if (format !== "lite") {
    throw new CwError(
      `format mismatch: json.format="${String(format)}" but lite-only engine requires "lite"`,
    );
  }
}

const MAX_SCHEMA_ERRORS = 5;

function assertSchema(schema: Schema, json: unknown, label: string): void {
  if (!Value.Check(schema, json)) {
    const errors = Array.from(Value.Errors(schema, json))
      .map((e) => `${e.path}: ${e.message}`)
      .slice(0, MAX_SCHEMA_ERRORS)
      .join("; ");
    throw new CwError(`invalid ${label} json: ${errors}`);
  }
}

// ── parseDevPlan（dev-plan.json 入口） ───────────────────────

/**
 * parseDevPlan — 解析 dev-plan.json（只含 format + objective + waves）。
 *
 * 向后兼容：如果 json 同时含 testCases 字段（旧版 plan.json），提取到 legacyTestCases。
 * 校验链：assertSafeSize → assertFormat → assertSchema(DevPlanSchema) → extract → assertAcyclicDeps。
 */
export function parseDevPlan(json: unknown): ParsedDevPlan {
  assertSafeSize(json, "dev-plan");
  assertFormat(json, "dev-plan");
  assertSchema(DevPlanSchema, json, "dev-plan");
  const parsed = extractDevPlan(json);
  assertAcyclicDeps(parsed.waves, "wave");
  // 旧版兼容：如果同时含 testCases（旧格式），也做环形检测。
  if (parsed.legacyTestCases) {
    assertAcyclicDeps(parsed.legacyTestCases, "testCase");
  }
  return parsed;
}

function extractDevPlan(json: unknown): ParsedDevPlan {
  const obj = json as {
    objective: string;
    waves: Array<{
      id: string;
      changes: string[];
      dependsOn: string[];
      priority?: "P0" | "P1" | "P2";
    }>;
    testCases?: Array<{
      id: string;
      layer: "mock" | "real";
      scenario: string;
      steps: string;
      expected: { url?: string; text?: string };
      executor: string;
      requiresScreenshot: boolean;
      dependsOn?: string[];
      priority?: "P0" | "P1" | "P2";
      redCheck?: boolean;
    }>;
  };
  return {
    objective: obj.objective,
    waves: obj.waves.map((w) => ({
      id: w.id,
      dependsOn: w.dependsOn,
      changes: w.changes,
      priority: w.priority,
    })),
    legacyTestCases: obj.testCases?.map((c) => ({
      id: c.id,
      layer: c.layer,
      scenario: c.scenario,
      steps: c.steps,
      expected: c.expected,
      executor: c.executor,
      requiresScreenshot: c.requiresScreenshot,
      dependsOn: c.dependsOn,
      priority: c.priority,
      redCheck: c.redCheck,
    })),
  };
}

// ── parseTestJson（test.json 入口） ──────────────────────────

/**
 * parseTestJson — 解析 test.json（testCases + 可选 testRunner）。
 *
 * 校验链：assertSafeSize → assertSchema(TestJsonSchema) → extract → assertAcyclicDeps。
 * 不校验 format 字段（test.json 不含 format，它不是 plan）。
 */
export function parseTestJson(json: unknown): ParsedTestJson {
  assertSafeSize(json, "test.json");
  assertSchema(TestJsonSchema, json, "test.json");
  const parsed = extractTestJson(json);
  assertAcyclicDeps(parsed.testCases, "testCase");
  return parsed;
}

function extractTestJson(json: unknown): ParsedTestJson {
  const obj = json as {
    testCases: Array<{
      id: string;
      layer: "mock" | "real";
      scenario: string;
      steps: string;
      expected: { url?: string; text?: string };
      executor: string;
      requiresScreenshot: boolean;
      dependsOn?: string[];
      priority?: "P0" | "P1" | "P2";
      redCheck?: boolean;
    }>;
    testRunner?: TestRunnerConfig;
  };
  return {
    testCases: obj.testCases.map((c) => ({
      id: c.id,
      layer: c.layer,
      scenario: c.scenario,
      steps: c.steps,
      expected: c.expected,
      executor: c.executor,
      requiresScreenshot: c.requiresScreenshot,
      dependsOn: c.dependsOn,
      priority: c.priority,
      redCheck: c.redCheck,
    })),
    testRunner: obj.testRunner,
  };
}

// ── parseClarifyJson（clarifyJson 入口，支持单条+批量） ──────

/**
 * clarifyJson 的 typebox schema（单条）。
 *
 * kind 锁定为 requirement | technical。
 * assessment 必须非空字符串——禁止空问，提问前 agent 必须先探索技术系统。
 * adr 可选：仅当该澄清产生 ADR 时提供（含 title/context/decision/alternatives/consequences）。
 */
export const ClarifySchema = Type.Object({
  kind: Type.Union([Type.Literal("requirement"), Type.Literal("technical")]),
  topic: Type.String({ minLength: 1 }),
  assessment: Type.String({ minLength: 1 }),
  question: Type.String({ minLength: 1 }),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        label: Type.String(),
        tradeoff: Type.Optional(Type.String()),
      }),
    ),
  ),
  recommendation: Type.Optional(Type.String()),
  presentationPath: Type.Optional(Type.String()),
  answer: Type.Optional(Type.String()),
  adr: Type.Optional(
    Type.Object({
      title: Type.String(),
      status: Type.Optional(
        Type.Union([Type.Literal("proposed"), Type.Literal("accepted")]),
      ),
      context: Type.String(),
      decision: Type.String(),
      alternatives: Type.Array(Type.String()),
      consequences: Type.String(),
      projectPath: Type.Optional(Type.String()),
    }),
  ),
});

export interface ParsedClarify {
  clarifySeed: ClarifySeed;
}

/**
 * parseClarifyJson — 解析 clarifyJson（单条或批量）。
 *
 * 支持两种形态：
 *   - 对象（单条）：渐进式记录一条澄清
 *   - 数组（批量）：一次记录多条
 *
 * 校验链：assertSafeSize → assertSchema(ClarifySchema) → extractClarify。
 * 不校验 format（clarifyJson 不含 format 字段）。
 */
export function parseClarifyJson(json: unknown): ParsedClarify[] {
  assertSafeSize(json, "clarify");
  const items = Array.isArray(json) ? json : [json];
  if (items.length === 0) {
    throw new CwError("clarify json 为空数组：至少需要 1 条记录。");
  }
  return items.map((item, i) => {
    assertSchema(ClarifySchema, item, `clarify[${i}]`);
    return extractClarify(item);
  });
}

function extractClarify(json: unknown): ParsedClarify {
  const obj = json as {
    kind: "requirement" | "technical";
    topic: string;
    assessment: string;
    question: string;
    options?: Array<{ id: string; label: string; tradeoff?: string }>;
    recommendation?: string;
    presentationPath?: string;
    answer?: string;
    adr?: {
      title: string;
      status?: "proposed" | "accepted";
      context: string;
      decision: string;
      alternatives: string[];
      consequences: string;
      projectPath?: string;
    };
  };

  const clarifySeed: ClarifySeed = {
    kind: obj.kind,
    topic: obj.topic,
    assessment: obj.assessment,
    question: obj.question,
    options: obj.options,
    recommendation: obj.recommendation,
    presentationPath: obj.presentationPath,
    answer: obj.answer,
  };

  if (obj.adr) {
    const adrSeed: AdrSeed = {
      title: obj.adr.title,
      status: obj.adr.status,
      context: obj.adr.context,
      decision: obj.adr.decision,
      alternatives: obj.adr.alternatives,
      consequences: obj.adr.consequences,
      projectPath: obj.adr.projectPath,
    };
    clarifySeed.adr = adrSeed;
  }

  return { clarifySeed };
}

// ── 向后兼容别名 ─────────────────────────────────────────────

/**
 * LitePlanSchema — 向后兼容别名，等同 LegacyPlanSchema。
 *
 * 旧代码 import { LitePlanSchema } 可继续工作。新代码应使用 DevPlanSchema / TestJsonSchema。
 * @deprecated 使用 DevPlanSchema 或 TestJsonSchema 代替
 */
export const LitePlanSchema = LegacyPlanSchema;

/**
 * ParsedLitePlan — 向后兼容别名。
 * @deprecated 使用 ParsedDevPlan 代替
 */
export type ParsedLitePlan = ParsedDevPlan;

/**
 * parseLitePlan — 向后兼容别名，等同 parseDevPlan。
 * @deprecated 使用 parseDevPlan 代替
 */
export function parseLitePlan(json: unknown): ParsedDevPlan {
  return parseDevPlan(json);
}

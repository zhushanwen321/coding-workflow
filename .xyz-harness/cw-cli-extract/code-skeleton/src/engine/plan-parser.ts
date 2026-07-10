/**
 * plan-parser — 3 套 JSON schema 解析（骨架 stub）。
 *
 * Level 1 接线：schema 声明（Type.Object 真引 typebox，Tier 2 证伪）。
 * 解析函数签名完整，方法体 throw NotImplementedError（叶子逻辑：Value.Check + 字段映射）。
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { TestCaseSeed, Tier, WaveSeed } from "./types.js";

// ── 3 套 schema（typebox 声明，真引 SDK） ───────────────────

export const LitePlanSchema = Type.Object({
  format: Type.Literal("lite"),
  objective: Type.String(),
  waves: Type.Array(
    Type.Object({
      id: Type.String(),
      changes: Type.Array(Type.String()),
      dependsOn: Type.Array(Type.String()),
      parallelGroup: Type.Optional(Type.String()),
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
      requiresScreenshot: Type.Boolean(),
      dependsOn: Type.Optional(Type.Array(Type.String())),
      parallelGroup: Type.Optional(Type.String()),
      file: Type.Optional(Type.String()),
      describe: Type.Optional(Type.String()),
    }),
  ),
});

export const MidClarifySchema = Type.Object({
  format: Type.Literal("mid-clarify"),
  objective: Type.String(),
  deliverables: Type.Object({
    requirements: Type.String(),
    systemArchitecture: Type.String(),
  }),
});

export const MidDetailSchema = Type.Object({
  format: Type.Literal("mid-detail"),
  objective: Type.String(),
  waves: Type.Array(
    Type.Object({
      id: Type.String(),
      issues: Type.Array(Type.String()),
      dependsOn: Type.Array(Type.String()),
      parallelGroup: Type.Optional(Type.String()),
    }),
  ),
  testCases: Type.Array(
    Type.Object({
      id: Type.String(),
      layer: Type.Union([
        Type.Literal("unit"),
        Type.Literal("integration"),
        Type.Literal("e2e"),
        Type.Literal("perf-chaos"),
      ]),
      scenario: Type.String(),
      steps: Type.String(),
      assertion: Type.String(),
      executor: Type.String(),
      dependsOn: Type.Optional(Type.Array(Type.String())),
      parallelGroup: Type.Optional(Type.String()),
      file: Type.Optional(Type.String()),
      describe: Type.Optional(Type.String()),
    }),
  ),
  deliverables: Type.Object({
    issues: Type.String(),
    nonFunctional: Type.String(),
    codeArchitecture: Type.String(),
    executionPlan: Type.String(),
  }),
});

export const TestCaseSubmissionSchema = Type.Object({
  caseId: Type.String(),
  actual: Type.Optional(Type.Object({
    url: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
  })),
  screenshotPath: Type.Optional(Type.String()),
  commitHash: Type.Optional(Type.String()),
  claimedStatus: Type.Optional(Type.Union([Type.Literal("passed"), Type.Literal("failed")])),
});

// ── 解析结果类型 ─────────────────────────────────────────────

export interface ParsedLitePlan {
  waves: WaveSeed[];
  testCases: TestCaseSeed[];
}

export interface ParsedMidClarify {
  deliverables: { requirements: string; systemArchitecture: string };
}

export interface ParsedMidDetail {
  waves: WaveSeed[];
  testCases: TestCaseSeed[];
  deliverables: {
    issues: string;
    nonFunctional: string;
    codeArchitecture: string;
    executionPlan: string;
  };
}

export interface TestCaseSubmission {
  caseId: string;
  actual?: { url?: string; text?: string };
  screenshotPath?: string;
  commitHash?: string;
  claimedStatus?: "passed" | "failed";
}

// ── 解析函数 ─────────────────────────────────────────────────

/**
 * 校验 tier 锁定（D-003）：plan.json format 字段必须与 topic.tier 一致。
 *
 * 接线：检查 json.format 与 tier 映射关系。
 */
export function assertFormatMatchesTier(format: string, tier: Tier): void {
  // const tierFormatMap: Record<Tier, string> = { lite: "lite", mid: "mid-clarify" };
  // mid 的 detail 阶段用 mid-detail，这里只做基础映射
  if (tier === "lite" && format !== "lite") {
    throw new Error(`format "${format}" 不匹配 tier "${tier}"（D-003 tier 锁定）`);
  }
  if (tier === "mid" && format !== "mid-clarify" && format !== "mid-detail") {
    throw new Error(`format "${format}" 不匹配 tier "${tier}"（D-003 tier 锁定）`);
  }
}

/**
 * parseLitePlan — 解析 plan.json（lite tier）。
 *
 * Level 1 接线：Value.Check 真调 typebox 校验（Tier 2 证伪）。
 * 叶子逻辑：字段映射到 WaveSeed/TestCaseSeed 留 Wave 实现。
 */
export function parseLitePlan(json: unknown): ParsedLitePlan {
  // 接线：typebox Value.Check 校验。
  if (!Value.Check(LitePlanSchema, json)) {
    const errors = [...Value.Errors(LitePlanSchema, json)];
    throw new Error(`plan.json 校验失败: ${errors.map((e) => e.message).join("; ")}`);
  }
  // 叶子：字段映射 WaveSeed/TestCaseSeed。
  const plan = json as { waves: WaveSeed[]; testCases: TestCaseSeed[] };
  return { waves: plan.waves, testCases: plan.testCases };
}

/**
 * parseMidClarify — 解析 clarify.json（mid tier）。
 */
export function parseMidClarify(json: unknown): ParsedMidClarify {
  if (!Value.Check(MidClarifySchema, json)) {
    const errors = [...Value.Errors(MidClarifySchema, json)];
    throw new Error(`clarify.json 校验失败: ${errors.map((e) => e.message).join("; ")}`);
  }
  const data = json as { deliverables: { requirements: string; systemArchitecture: string } };
  return { deliverables: data.deliverables };
}

/**
 * parseMidDetail — 解析 detail.json（mid tier）。
 */
export function parseMidDetail(json: unknown): ParsedMidDetail {
  if (!Value.Check(MidDetailSchema, json)) {
    const errors = [...Value.Errors(MidDetailSchema, json)];
    throw new Error(`detail.json 校验失败: ${errors.map((e) => e.message).join("; ")}`);
  }
  const data = json as ParsedMidDetail;
  return {
    waves: data.waves,
    testCases: data.testCases,
    deliverables: data.deliverables,
  };
}

/**
 * parseTestCaseSubmission — 解析 test action 的 cases 数组。
 */
export function parseTestCaseSubmissions(json: unknown): TestCaseSubmission[] {
  if (!Array.isArray(json)) {
    throw new Error("cases 必须是数组");
  }
  const results: TestCaseSubmission[] = [];
  for (const item of json) {
    if (!Value.Check(TestCaseSubmissionSchema, item)) {
      const errors = [...Value.Errors(TestCaseSubmissionSchema, item)];
      throw new Error(`testCase submission 校验失败: ${errors.map((e) => e.message).join("; ")}`);
    }
    results.push(item as TestCaseSubmission);
  }
  return results;
}

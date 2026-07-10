/**
 * plan-parser — 3 套 JSON schema 解析（D-006，#5 方案 A typebox）。
 *
 * 输入：plan.json / clarify.json / detail.json（skill 阶段产出，§12 architecture）。
 * 校验链：size/depth guard（T2.17/T2.29）→ format 字段 === tier 锁定值（D-003）→ typebox Value.Check 结构。
 * 输出：ParsedXxx，供 action handler 写入 _cw.json（waves/testCases）。
 *
 * 真引 typebox Type + Value（Tier 2 证伪）。
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { TestCaseSeed, Tier, WaveSeed } from "./types.js";

// ── 3 套 schema（§12 architecture，typebox 声明） ────────────

// 导出供 tool schema 复用（src/index.ts 的 planJson/clarifyJson/detailJson 字段引用）。
// 单一来源：tool 层和 parser 层共用同一 schema 定义，避免漂移。
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
      /**
       * 本用例是否要求 screenshotPath（cw test lite 分支据此判断）。
       * plan 阶段 agent 按用例性质决定：mock 层通常 false（无 UI/真实环境），
       * real 层通常 true（验证真实跑通）；但 agent 可按用例需要覆写。
       * 避免「所有 lite case 无差别要求 screenshot」的反工程直觉行为。
       */
      requiresScreenshot: Type.Boolean(),
      /**
       * 测试调度：执行顺序依赖（ADR-029 决策 4）。
       * 本用例依赖哪些前置用例建的数据状态（如 E3 依赖 E1 建的登录态）。
       * workflow 据此拓扑排序，被依赖的先跑；是硬依赖（上游 fail 则 abort 下游）。
       */
      dependsOn: Type.Optional(Type.Array(Type.String())),
      /**
       * 测试调度：资源冲突规避分组（ADR-029 决策 4）。
       * 同 parallelGroup 的用例已确认无资源冲突（不同 chrome profile / DB 表 / 端口），
       * 可并行执行。无此字段视为独占资源（串行）。
       */
      parallelGroup: Type.Optional(Type.String()),
      /** 测试代码位置（可选）：测试文件路径，如 src/__tests__/useChat.test.ts */
      file: Type.Optional(Type.String()),
      /** 测试代码位置（可选）：测试组名，如 "streaming reset" */
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
      /** 测试调度：执行顺序依赖（ADR-029 决策 4，同 LitePlanSchema）。 */
      dependsOn: Type.Optional(Type.Array(Type.String())),
      /** 测试调度：资源冲突规避分组（ADR-029 决策 4，同 LitePlanSchema）。 */
      parallelGroup: Type.Optional(Type.String()),
      /** 测试代码位置（可选）：测试文件路径，如 src/__tests__/useChat.test.ts */
      file: Type.Optional(Type.String()),
      /** 测试代码位置（可选）：测试组名，如 "streaming reset" */
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

/**
 * test action 的 cases 数组元素 schema（TestCaseSubmission 结构契约）。
 * 字段语义见 test.ts 的 TestCaseSubmission interface：
 *   - caseId 必填（lite/mid 共有，匹配 topic 已 seed 的 testCase.id）
 *   - actual/screenshotPath：lite 分支用（judgeByExpected 重算）
 *   - commitHash/claimedStatus：mid 分支用（GitValidator + 信声明）
 * tool 层和 test.ts 共用此 schema，避免漂移。
 */
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

// schema 入参类型从 Value.Check 签名派生（避免跨版本 TSchema 导出不稳定）。
type Schema = Parameters<typeof Value.Check>[0];

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

// ── size / depth guard（T2.17 超 1MB 拒 / T2.29 深嵌套爆栈防护） ──

const MAX_PLAN_BYTES = 1048576; // 1 MiB（单字面量 const 初始化，豁免 no-magic-numbers）

/**
 * 入口 size + depth guard：JSON.stringify 测大小 + 捕 RangeError（深嵌套爆栈）。
 * 放在最前：拒绝超大/深嵌套输入后再做结构校验（安全/性能，#5）。
 */
function assertSafeSize(obj: unknown, label: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(obj);
  } catch (e) {
    if (e instanceof RangeError) {
      throw new Error(`invalid ${label}: deeply nested (JSON.stringify stack overflow rejected)`);
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

/** format 锁定校验（D-003，AC-5.2）：json.format 必须 === tier 锁定值。 */
function assertFormat(json: unknown, expectedFormat: string, tier: Tier): void {
  if (typeof json !== "object" || json === null) {
    throw new Error("invalid plan json: not an object");
  }
  const format = "format" in json ? json.format : undefined;
  if (format !== expectedFormat) {
    throw new Error(
      `tier mismatch: json.format="${String(format)}" but topic.tier="${tier}" ` +
        `(tier locked at create, D-003; 作废重建)`,
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

/**
 * ADR-029 决策 4 / 审查 architecture：dependsOn 环检测。
 * workflow 脚本的 topoSort 会在运行时检环，但那时已在 worktree 建好之后——
 * 在 cw(plan/detail) gate 就拒环形 plan，fail-fast 在 plan 阶段而非 execute 阶段。
 * 同时检「依赖不存在的 id」（topoSort 也会检，这里提前给更精确的错误信息）。
 */
function assertAcyclicDeps(
  items: ReadonlyArray<{ id: string; dependsOn?: ReadonlyArray<string> | string[] }>,
  label: string,
): void {
  const ids = new Set(items.map((i) => i.id));
  // 1. 依赖不存在的 id
  for (const item of items) {
    const deps = Array.isArray(item.dependsOn) ? item.dependsOn : [];
    for (const d of deps) {
      if (!ids.has(d)) {
        throw new Error(
          `invalid ${label}: ${item.id} dependsOn unknown id "${d}"（合法 id: ${[...ids].join(", ")}）`,
        );
      }
    }
  }
  // 2. 环检测（DFS 三色标记）
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const path: string[] = [];
  const visit = (id: string): void => {
    const c = color.get(id) ?? 0;
    if (c === BLACK) return;
    if (c === GRAY) {
      const cycleStart = path.indexOf(id);
      const cycle = path.slice(cycleStart).concat(id).join(" → ");
      throw new Error(`invalid ${label}: dependsOn 有环（${cycle}）`);
    }
    color.set(id, GRAY);
    path.push(id);
    const item = items.find((i) => i.id === id);
    const deps = item && Array.isArray(item.dependsOn) ? item.dependsOn : [];
    for (const d of deps) visit(d);
    path.pop();
    color.set(id, BLACK);
  };
  for (const item of items) visit(item.id);
}

// ── 解析函数（入口：size guard → format 锁定 → schema 校验 → extract） ──

export function parseLitePlan(json: unknown, tier: Tier): ParsedLitePlan {
  assertSafeSize(json, "lite plan");
  assertFormat(json, "lite", tier);
  assertSchema(LitePlanSchema, json, "lite plan");
  const parsed = extractLitePlan(json);
  assertAcyclicDeps(parsed.waves, "lite plan waves");
  assertAcyclicDeps(parsed.testCases, "lite plan testCases");
  return parsed;
}

export function parseMidClarify(json: unknown, tier: Tier): ParsedMidClarify {
  assertSafeSize(json, "mid clarify");
  assertFormat(json, "mid-clarify", tier);
  assertSchema(MidClarifySchema, json, "mid clarify");
  return extractMidClarify(json);
}

export function parseMidDetail(json: unknown, tier: Tier): ParsedMidDetail {
  assertSafeSize(json, "mid detail");
  assertFormat(json, "mid-detail", tier);
  assertSchema(MidDetailSchema, json, "mid detail");
  const parsed = extractMidDetail(json);
  assertAcyclicDeps(parsed.waves, "mid detail waves");
  assertAcyclicDeps(parsed.testCases, "mid detail testCases");
  return parsed;
}

// ── extract（json 已过 schema 校验，结构安全） ───────────────

function extractLitePlan(json: unknown): ParsedLitePlan {
  const obj = json as {
    waves: Array<{
      id: string;
      changes: string[];
      dependsOn: string[];
      parallelGroup?: string;
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
      parallelGroup?: string;
      file?: string;
      describe?: string;
    }>;
  };
  return {
    waves: obj.waves.map((w) => ({
      id: w.id,
      dependsOn: w.dependsOn,
      parallelGroup: w.parallelGroup,
      changes: w.changes,
      // lite wave 无 issues 字段 → seed 填 []（D-006 lite 以 changes 为任务单元）
      issues: [],
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
      parallelGroup: c.parallelGroup,
      file: c.file,
      describe: c.describe,
    })),
  };
}

function extractMidClarify(json: unknown): ParsedMidClarify {
  const obj = json as {
    deliverables: { requirements: string; systemArchitecture: string };
  };
  // T2.9：mid clarify 只确认 tier + 交付物引用，不含 waves/testCases（任务在 detail 阶段解析）
  return { deliverables: obj.deliverables };
}

function extractMidDetail(json: unknown): ParsedMidDetail {
  const obj = json as {
    waves: Array<{
      id: string;
      issues: string[];
      dependsOn: string[];
      parallelGroup?: string;
    }>;
    testCases: Array<{
      id: string;
      layer: "unit" | "integration" | "e2e" | "perf-chaos";
      scenario: string;
      steps: string;
      assertion: string;
      executor: string;
      dependsOn?: string[];
      parallelGroup?: string;
      file?: string;
      describe?: string;
    }>;
    deliverables: {
      issues: string;
      nonFunctional: string;
      codeArchitecture: string;
      executionPlan: string;
    };
  };
  return {
    waves: obj.waves.map((w) => ({
      id: w.id,
      dependsOn: w.dependsOn,
      parallelGroup: w.parallelGroup,
      // mid wave 无 changes 字段 → seed 填 []（D-006 mid 以 issues 为任务单元）
      changes: [],
      issues: w.issues,
    })),
    testCases: obj.testCases.map((c) => ({
      id: c.id,
      layer: c.layer,
      scenario: c.scenario,
      steps: c.steps,
      // mid testCase 用 assertion（自然语言，信声明不重算，D-008），无 expected
      assertion: c.assertion,
      executor: c.executor,
      dependsOn: c.dependsOn,
      parallelGroup: c.parallelGroup,
      file: c.file,
      describe: c.describe,
    })),
    deliverables: obj.deliverables,
  };
}

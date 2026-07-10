/**
 * CW 共享类型 + judgeByExpected 纯函数。
 *
 * 变化轴：跨层共享的数据契约 + 测试判定密封逻辑。
 * 不依赖任何 cw 模块的运行时值（CwStore/GitValidator/GateRunner 仅 type-only 反向引用）。
 */

import { join } from "node:path";

// ── type-only 反向引用 ──
import type { GateRunner, GitValidator } from "./gates.js";
import type { CwStore } from "./store.js";

// ── 状态机值对象 ────────────────────────────────────────────

export type CwStatus =
  | "created"
  | "planned"
  | "clarified"
  | "detailed"
  | "developed"
  | "tested"
  | "retrospected"
  | "closed";

export type Tier = "lite" | "mid";

export type GateTier = "weak-structural" | "medium-git" | "medium-coverage" | "strong-recompute";

export type CwAction =
  | "create"
  | "plan"
  | "clarify"
  | "detail"
  | "dev"
  | "test"
  | "retrospect"
  | "closeout"
  | "replan";

// ── judgeByExpected ─────────────────────────────────────────

export interface Expected {
  url?: string;
  text?: string;
}

export interface Actual {
  url?: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * judgeByExpected — 机器判定基准（lite plan.json 结构化字段）。
 *
 * 匹配严格度：精确字符串相等，不做 fuzzy/substring/trim 容差。
 * lite test 是机器重算门，意图是防 AI 谎报。
 */
export function judgeByExpected(
  expected: Expected,
  actual: Actual,
): { status: "passed" | "failed"; reason: string } {
  // 数据流：expected.url/text 存在则要求 actual 对应字段存在且 ===；任一不一致 → failed + 逐字段 reason。
  // 不变式：expected 无任何 judgeable 字段 → failed「no judgeable field」（plan-parser 应已拦，兜底）。
  const mismatches: string[] = [];

  if (expected.url !== undefined) {
    if (actual.url === undefined) {
      mismatches.push(`url missing (expected "${expected.url}")`);
    } else if (actual.url !== expected.url) {
      mismatches.push(`url: "${actual.url}" !== "${expected.url}"`);
    }
  }

  if (expected.text !== undefined) {
    if (actual.text === undefined) {
      mismatches.push(`text missing (expected "${expected.text}")`);
    } else if (actual.text !== expected.text) {
      mismatches.push(`text: "${actual.text}" !== "${expected.text}"`);
    }
  }

  if (expected.url === undefined && expected.text === undefined) {
    return { status: "failed", reason: "no judgeable field in expected (url/text)" };
  }

  if (mismatches.length > 0) {
    return { status: "failed", reason: mismatches.join("; ") };
  }
  return { status: "passed", reason: "" };
}

// ── 领域模型 ────────────────────────────────────────────────

export interface Wave {
  id: string;
  dependsOn: string[];
  parallelGroup?: string;
  committed: string | null;
  changes: string[];
  issues: string[];
}

export interface TestCase {
  id: string;
  layer: "mock" | "real" | "unit" | "integration" | "e2e" | "perf-chaos";
  scenario: string;
  steps: string;
  expected?: Expected;
  assertion?: string;
  executor: string;
  status: "pending" | "passed" | "failed";
  actual?: Actual;
  screenshotPath?: string;
  commitHash?: string;
  judgedAt?: string;
  failureReason?: string;
  requiresScreenshot?: boolean;
  dependsOn?: string[];
  parallelGroup?: string;
  file?: string;
  describe?: string;
}

export interface GateHistoryEntry {
  id: number;
  phase: CwAction;
  action: CwAction;
  gate: string;
  tier: GateTier;
  result: "pass" | "fail";
  ts: string;
  report?: string;
  progressive: boolean;
}

export interface Evidence {
  closedAt: string;
  coverage?: number;
  gateHistory: GateHistoryEntry[];
}

export interface CwTopic {
  schemaVersion: number;
  topicId: string;
  slug: string;
  tier: Tier;
  objective: string;
  workspacePath: string;
  topicDir: string;
  createdAt: string;
  status: CwStatus;
  planFormat?: "lite" | "mid-clarify" | "mid-detail";
  waves: Wave[];
  testCases: TestCase[];
  gateHistory: GateHistoryEntry[];
  gatePassed: Partial<Record<CwAction, boolean>>;
  evidence?: Evidence;
  coverage?: number;
}

// ── DAO seed 类型 ────────────────────────────────────────────

export interface WaveSeed {
  id: string;
  dependsOn: string[];
  parallelGroup?: string;
  changes?: string[];
  issues?: string[];
}

export interface TestCaseSeed {
  id: string;
  layer: TestCase["layer"];
  scenario: string;
  steps: string;
  expected?: Expected;
  assertion?: string;
  executor: string;
  requiresScreenshot?: boolean;
  dependsOn?: string[];
  parallelGroup?: string;
  file?: string;
  describe?: string;
}

export interface GateHistorySeed {
  phase: CwAction;
  action: CwAction;
  gate: string;
  tier: GateTier;
  result: "pass" | "fail";
  report?: string;
  progressive: boolean;
}

// ── guard 返回 ──────────────────────────────────────────────

export type GuardErrorCode = "illegal_transition" | "phase_incomplete" | "cache_inconsistent";

export type GuardVerdict = { ok: true } | { ok: false; code: GuardErrorCode; reason: string };

// ── nextAction ──────────────────────────────────────────────

export interface NextAction {
  action?: CwAction;
  skill?: string;
  guidance: string;
  waves?: Array<{ id: string; committed: boolean }>;
  testCases?: Array<{ id: string; status: TestCase["status"] }>;
}

// ── action handler 契约 ─────────────────────────────────────

export interface ActionDeps {
  store: CwStore;
  git: GitValidator;
  runner: GateRunner;
  workspacePath: string;
}

export function resolveTopicDir(topic: CwTopic): string {
  return topic.topicDir || join(topic.workspacePath, ".xyz-harness", topic.slug);
}

export interface ActionResult {
  topicId: string;
  status: CwStatus;
  gatePassed: Partial<Record<CwAction, boolean>>;
  gateTier?: GateTier;
  gateHistoryEntry?: GateHistoryEntry;
  nextAction: NextAction;
  [key: string]: unknown;
}

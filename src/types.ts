/**
 * CW 共享类型 + judgeByExpected 纯函数（lite 单轨极简版）。
 *
 * 变化轴：跨层共享的数据契约 + 测试判定密封逻辑。
 * 不依赖任何 cw 模块的运行时值（CwStore/GitValidator 仅 type-only 反向引用）。
 *
 * 与旧版的差异（重构 = 推倒重建）：
 * - tier 字段彻底砍掉（lite-only 硬编码，不再分档）
 * - GuardErrorCode 只剩 illegal_transition（单重 guard，砍 phase_incomplete / cache_inconsistent）
 * - Action 砍 clarify / detail（mid 专属）
 * - Status 砍 clarified / detailed（mid 专属）
 * - TestCase.layer 砍 unit/integration/e2e/perf-chaos（mid 专属），只留 mock/real
 * - Wave 砍 parallelGroup / issues（精简）
 * - TestCase 砍 assertion/file/describe/parallelGroup/judgedAt/commitHash（精简，commitHash 仅 dev 用）
 * - CwTopic 砍 schemaVersion/planFormat/tier/coverage（coverage 移入 Evidence）
 * - Evidence 保留 gateHistory 快照（closeout 回溯用，reviewer 指出不能砍）
 */

import type { CwStore } from "./store.js";
import type { GitValidator } from "./gate.js";

// ── 状态机值对象 ────────────────────────────────────────────

/**
 * lite 单轨的 6 个正向 action + replan（共 7 个）。
 * 砍掉 clarify / detail（mid 专属）。
 */
export type Action =
  | "create"
  | "plan"
  | "dev"
  | "test"
  | "retrospect"
  | "closeout"
  | "replan";

/**
 * lite 单轨的 6 个 status。
 * 砍掉 clarified / detailed（mid 专属）。
 */
export type Status =
  | "created"
  | "planned"
  | "developed"
  | "tested"
  | "retrospected"
  | "closed";

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
 * lite test 是机器重算门，意图是防 AI 谎报——容差一开就失去意义。
 *
 * 数据流：expected.url/text 存在则要求 actual 对应字段存在且 ===；任一不一致 → failed + 逐字段 reason。
 * 不变式：expected 无任何 judgeable 字段 → failed「no judgeable field」（plan-parser 应已拦，兜底）。
 */
export function judgeByExpected(
  expected: Expected,
  actual: Actual,
): { status: "passed" | "failed"; reason: string } {
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

  // plan-parser 应已保证 expected 至少含一个 judgeable 字段；兜底防御。
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
  committed: string | null;
  changes: string[];
}

export interface TestCase {
  id: string;
  layer: "mock" | "real";
  scenario: string;
  steps: string;
  expected: { url?: string; text?: string };
  executor: string;
  status: "pending" | "passed" | "failed";
  actual?: object;
  screenshotPath?: string;
  failureReason?: string;
  requiresScreenshot: boolean;
  dependsOn: string[];
}

export interface GateHistoryEntry {
  id: number;
  phase: Action;
  action: Action;
  gate: string;
  result: "pass" | "fail";
  ts: string;
  report?: string;
  progressive: boolean;
}

export interface Evidence {
  closedAt: string;
  coverage?: number;
  /** gate 历史快照，closeout 后可回溯完整 gate 判定轨迹（reviewer 指出不能砍） */
  gateHistory: GateHistoryEntry[];
}

export interface Topic {
  topicId: string;
  slug: string;
  objective: string;
  workspacePath: string;
  topicDir: string;
  createdAt: string;
  status: Status;
  waves: Wave[];
  testCases: TestCase[];
  gateHistory: GateHistoryEntry[];
  gatePassed: Partial<Record<Action, boolean>>;
  evidence?: Evidence;
}

// ── DAO seed 类型（plan.json 解析后写入 store 的输入形态） ─────

export interface WaveSeed {
  id: string;
  dependsOn: string[];
  changes?: string[];
}

export interface TestCaseSeed {
  id: string;
  layer: "mock" | "real";
  scenario: string;
  steps: string;
  expected: { url?: string; text?: string };
  executor: string;
  requiresScreenshot: boolean;
  dependsOn?: string[];
}

// ── guard 返回 ──────────────────────────────────────────────

/**
 * 单重 guard 错误码。只留 illegal_transition（跨阶段跳步）。
 * 砍掉 phase_incomplete / cache_inconsistent（纵深防御 guard 本次不做）。
 */
export type GuardErrorCode = "illegal_transition";

export type GuardVerdict = { ok: true } | { ok: false; code: GuardErrorCode; reason: string };

// ── nextAction ──────────────────────────────────────────────

/**
 * nextAction 的可选 action 项。
 *
 * 用于表达「当前状态下同时有多个合法 action」的场景（如 plan/dev 阶段，
 * dev 是主推荐，replan 也是合法的旁路——可追加 Wave 或调整未 committed 的 plan 项）。
 * action 字段是主推荐路径，alternatives 补充其他合法选项，agent 按场景选择。
 */
export interface NextActionAlternative {
  action: Action;
  guidance: string;
}

export interface NextAction {
  action?: Action;
  guidance: string;
  waves?: Array<{ id: string; committed: boolean }>;
  testCases?: Array<{ id: string; status: TestCase["status"] }>;
  /** 当前状态下同样合法的可选 action（主推荐在 action 字段）。 */
  alternatives?: NextActionAlternative[];
}

// ── action handler 契约 ─────────────────────────────────────

/**
 * handler 依赖注入。runner 字段砍掉（GateRegistry dispatch 表本次不做，
 * gate 检查内联到各 handler，直接调 planCheck/devCheck 等具名函数）。
 */
export interface ActionDeps {
  store: CwStore;
  git: GitValidator;
  workspacePath: string;
}

export interface ActionResult {
  topicId: string;
  status: Status;
  gatePassed: Partial<Record<Action, boolean>>;
  gateHistoryEntry?: GateHistoryEntry;
  nextAction: NextAction;
  [key: string]: unknown;
}

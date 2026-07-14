/**
 * stats — 评估指标计算模块（纯函数，只读 Topic 数据）。
 *
 * 三层指标架构（与 HANDOFF.md 共识对齐）：
 *   - 第二层 过程效率：首次正确率、早期拦截率、重试次数
 *   - 第三层 杠杆健康度：各 CW 机制 gate 的最终状态
 *   （第一层 交付质量由 post-closeout assessment 提供，不在本模块）
 *
 * 数据源全部来自 topic 内已有数据（gateHistory / waves / testCases），
 * 不依赖外部文件或 post-closeout 回填。
 *
 * 复杂度分桶复用 gate.ts 的 SCOPE_WARN_WAVES / SCOPE_WARN_FILES 阈值，
 * 保持范围守门与复杂度评估的一致性。
 */

import {
  extractFilesFromChanges,
  SCOPE_WARN_FILES,
  SCOPE_WARN_WAVES,
} from "./gate.js";
import type {
  Action,
  GateHistoryEntry,
  RetrospectDerived,
  RuntimeEnv,
  Topic,
} from "./types.js";

// ── 复杂度 ──────────────────────────────────────────────────

export type ComplexityLevel = "simple" | "medium" | "complex";

export interface Complexity {
  level: ComplexityLevel;
  waves: number;
  estimatedFiles: number;
}

/**
 * 复杂度分桶（客观结构信号，不靠主观打分）。
 *
 * - simple：waves ≤ 3 且 files ≤ 5
 * - complex：waves ≥ 10 或 files ≥ 15（复用 SCOPE_WARN 阈值）
 * - medium：其他
 *
 * files 从 waves[].changes 文本提取路径估算（extractFilesFromChanges）。
 */
/** simple 分桶的阈值：waves 和 files 都不超过这些值。 */
const SIMPLE_MAX_WAVES = 3;
const SIMPLE_MAX_FILES = 5;

function computeComplexity(topic: Topic): Complexity {
  const waves = topic.waves.length;
  const allChanges = topic.waves.flatMap((w) => w.changes ?? []);
  const files = extractFilesFromChanges(allChanges).size;

  let level: ComplexityLevel;
  if (waves >= SCOPE_WARN_WAVES || files >= SCOPE_WARN_FILES) {
    level = "complex";
  } else if (waves <= SIMPLE_MAX_WAVES && files <= SIMPLE_MAX_FILES) {
    level = "simple";
  } else {
    level = "medium";
  }

  return { level, waves, estimatedFiles: files };
}

// ── 过程效率 ────────────────────────────────────────────────

export interface Efficiency {
  /** 各 phase 首次调用是否 pass（gateHistory 按 phase 分组取首条 result）。 */
  firstTryPass: Record<string, boolean>;
  /** 早期拦截率 = (dev fail + test fail) / 全 phase fail。无 fail 时 = 1（全程无返工）。 */
  earlyInterceptionRate: number;
  /** dev 阶段 progressive fail 次数（同一 wave 反复提交未通过）。 */
  devRetryCount: number;
  /** test 阶段 progressive fail 次数。 */
  testRetryCount: number;
  /** 全阶段 gate fail 总数。 */
  totalGateFails: number;
}

/**
 * 过程效率指标。
 *
 * 首次正确率：gateHistory 按 phase 分组，每组按 id 排序取首条记录的 result。
 *   没有记录的 phase 不出现在 firstTryPass 里。
 *
 * 早期拦截率：dev/test 阶段的 fail / 全阶段 fail。
 *   早期 fail = 廉价且正向（问题在交付前被抓住）。
 *   晚期 fail（review/closeout 后）才是负面的。
 *   无任何 fail → 返回 1（没有需要拦截的问题）。
 */
function computeEfficiency(topic: Topic): Efficiency {
  // 按 phase 分组（保持插入顺序）
  const phaseGroups = new Map<Action, GateHistoryEntry[]>();
  for (const entry of topic.gateHistory) {
    const list = phaseGroups.get(entry.phase) ?? [];
    list.push(entry);
    phaseGroups.set(entry.phase, list);
  }

  // 首次正确率
  const firstTryPass: Record<string, boolean> = {};
  for (const [phase, entries] of phaseGroups) {
    // entries 已按 id 排序（assembleTopicFromData 内 sort），取首条
    const first = entries[0];
    if (first) {
      firstTryPass[phase] = first.result === "pass";
    }
  }

  // fail 统计
  let devFail = 0;
  let testFail = 0;
  let totalFails = 0;
  for (const entry of topic.gateHistory) {
    if (entry.result === "fail") {
      totalFails++;
      if (entry.phase === "dev") devFail++;
      if (entry.phase === "test") testFail++;
    }
  }

  const earlyInterceptionRate =
    totalFails === 0 ? 1 : (devFail + testFail) / totalFails;

  return {
    firstTryPass,
    earlyInterceptionRate,
    devRetryCount: devFail,
    testRetryCount: testFail,
    totalGateFails: totalFails,
  };
}

// ── 杠杆健康度 ─────────────────────────────────────────────

export type LeverStatus = "pass" | "fail" | "warning" | "not-run";

export interface LeverHealth {
  /** 杠杆名称（人类可读）。 */
  lever: string;
  /** gateHistory 中的 gate 名（用于查找判定记录）。 */
  gate: string;
  status: LeverStatus;
}

/**
 * 杠杆定义表——CW 机制的 9 个干预杠杆。
 *
 * 每个 lever 对应一个 gate 名。从 gateHistory 找该 gate 的最新记录判定状态：
 *   - 无记录 → not-run（该杠杆在本 topic 中未被触发）
 *   - 最新记录 pass → pass
 *   - 最新记录 fail → fail
 *
 * 特殊：lite-plan-schema 同时承载 plan 结构化（pass/fail）和范围守门（warning）。
 * planCheck 返回 warning 时会在 mustFix 里体现，但 gateHistory 只记 pass/fail——
 * warning 是 pass 的一种子状态（status=pass 但 mustFix 含 warning 文本）。
 * 所以 plan gate 的 warning 无法从 gateHistory 单独区分，统一按 pass/fail 报。
 */
const LEVER_TABLE: Array<{ lever: string; gate: string }> = [
  { lever: "spec 范围守门", gate: "lite-plan-schema" },
  { lever: "plan 结构化拆分", gate: "lite-plan-schema" },
  { lever: "TDD 红灯先行", gate: "tdd-red-light" },
  { lever: "expected 可信度", gate: "test-json-schema" },
  { lever: "dev commit 锚定", gate: "medium-git" },
  { lever: "review 存在性", gate: "file-exists+non-empty" },
  { lever: "test 机器重算", gate: "judgeByExpected" },
  { lever: "append-only 安全", gate: "append-only-validator" },
];

/**
 * 杠杆健康度。
 *
 * 从 gateHistory 按 gate 名分组，每组取最新（id 最大）记录的 result。
 * 同一 gate 名对应多个 lever（如 lite-plan-schema → spec 守门 + plan 结构化），
 * 两者状态相同——这是有意的设计，因为它们读同一组 gate 记录。
 */
function computeLeverHealth(topic: Topic): LeverHealth[] {
  // gate 名 → 最新记录的 result
  const gateLatest = new Map<string, "pass" | "fail">();
  for (const entry of topic.gateHistory) {
    gateLatest.set(entry.gate, entry.result);
  }

  return LEVER_TABLE.map(({ lever, gate }) => {
    const result = gateLatest.get(gate);
    const status: LeverStatus = result ?? "not-run";
    return { lever, gate, status };
  });
}

// ── 汇总 ───────────────────────────────────────────────────

export interface StatsOutput {
  topicId: string;
  runtimeEnv?: RuntimeEnv;
  complexity: Complexity;
  efficiency: Efficiency;
  leverHealth: LeverHealth[];
}

/**
 * computeStats — 从 topic 派生评估指标。
 *
 * 纯函数：只读 topic 数据，无副作用，不依赖外部文件。
 * 旧 topic（无 runtimeEnv）的 runtimeEnv 字段为 undefined。
 */
export function computeStats(topic: Topic): StatsOutput {
  return {
    topicId: topic.topicId,
    runtimeEnv: topic.runtimeEnv,
    complexity: computeComplexity(topic),
    efficiency: computeEfficiency(topic),
    leverHealth: computeLeverHealth(topic),
  };
}

// ── retrospect 派生指标（handleRetrospect 自动填充用） ────────

/**
 * computeRetrospectDerived — 从 topic 派生回顾指标，写入 retrospectData.derived。
 *
 * handleRetrospect 在 gate pass 后调用，cw 自动算（agent 不填）。
 * 与 computeEfficiency 共享 firstTryPassRate 的计算逻辑。
 *
 * 纯函数：只读 topic 数据，无副作用。
 */
export function computeRetrospectDerived(topic: Topic): RetrospectDerived {
  const phaseGroups = new Map<Action, GateHistoryEntry[]>();
  for (const entry of topic.gateHistory) {
    const list = phaseGroups.get(entry.phase) ?? [];
    list.push(entry);
    phaseGroups.set(entry.phase, list);
  }

  // firstTryPassRate：各 phase 首条记录中 pass 的比例
  let phaseCount = 0;
  let firstTryPassCount = 0;
  for (const entries of phaseGroups.values()) {
    phaseCount++;
    if (entries[0]?.result === "pass") firstTryPassCount++;
  }
  const firstTryPassRate = phaseCount > 0 ? firstTryPassCount / phaseCount : 1;

  let gateFailCount = 0;
  let devRetryCount = 0;
  let testRetryCount = 0;
  for (const entry of topic.gateHistory) {
    if (entry.result === "fail") {
      gateFailCount++;
      if (entry.phase === "dev") devRetryCount++;
      if (entry.phase === "test") testRetryCount++;
    }
  }

  const redLightConfirmed = topic.gateHistory.some(
    (e) => e.gate === "tdd-red-light" && e.result === "pass",
  );

  return {
    totalWaves: topic.waves.length,
    totalCases: topic.testCases.length,
    gateFailCount,
    devRetryCount,
    testRetryCount,
    redLightConfirmed,
    firstTryPassRate,
  };
}

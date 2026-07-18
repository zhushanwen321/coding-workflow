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
  RetrospectInsights,
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
 * files 从 waves[].changes[].file 结构化字段提取（extractFilesFromChanges）。
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
  /**
   * 晚期返工率 = (review + closeout 阶段的 fail) / 全 phase fail。
   *
   * 与 earlyInterceptionRate 互补——早期 fail 廉价且正向，晚期 fail（交付后才发现）
   * 才是返工代价高的负面信号。无 fail 时 = 0（晚期返工率越低越好，没有问题 = 最佳）。
   */
  lateReworkRate: number;
  /**
   * plan 完成度 = 已 committed waves / 总 waves。
   *
   * 衡量 plan 的兑现度：committed 表示已 dev 通过 commit 锚定，未 committed 的 wave
   * 意味着 plan 承诺未交付。无 waves 时 = 0（空 plan，无兑现度可衡量）。
   */
  planCompletionRate: number;
  /**
   * 覆盖率门槛 flag——topic.evidence?.coverage < 0.5 时为 true（需关注）。
   *
   * closeout 时算的测试通过率（passed testCases / total testCases）。
   * 低于 50% 视为覆盖不足，flag=true 触发关注。无 evidence 时 = false（未到 closeout，尚无数据）。
   */
  coverageFlag: boolean;
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
  let lateFail = 0;
  let totalFails = 0;
  for (const entry of topic.gateHistory) {
    if (entry.result === "fail") {
      totalFails++;
      if (entry.phase === "dev") devFail++;
      if (entry.phase === "test") testFail++;
      // review / closeout 阶段的 fail 属于晚期返工（交付后才发现）。
      if (entry.phase === "review" || entry.phase === "closeout") lateFail++;
    }
  }

  const earlyInterceptionRate =
    totalFails === 0 ? 1 : (devFail + testFail) / totalFails;

  // 晚期返工率：与 earlyInterceptionRate 互补。无 fail 时 = 0（越低越好）。
  const lateReworkRate = totalFails === 0 ? 0 : lateFail / totalFails;

  // plan 完成度：已 committed waves / 总 waves。空 plan 时 = 0。
  const totalWaves = topic.waves.length;
  const committedWaves = topic.waves.filter((w) => w.committed !== null).length;
  const planCompletionRate = totalWaves === 0 ? 0 : committedWaves / totalWaves;

  // 覆盖率门槛：closeout 后才有 evidence.coverage，无 evidence 视为未达标关注=false。
  const coverageFlag =
    topic.evidence?.coverage !== undefined && topic.evidence.coverage < 0.5;

  return {
    firstTryPass,
    earlyInterceptionRate,
    devRetryCount: devFail,
    testRetryCount: testFail,
    totalGateFails: totalFails,
    lateReworkRate,
    planCompletionRate,
    coverageFlag,
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
 *
 * 特殊：retrospect 结构化 lever 的 gate 名（file-exists+non-empty）与 review 共用——
 * gateHistory 按 phase 区分，但 leverHealth 按 gate 名分组查不到 retrospect 专属状态。
 * 改为用 topic.retrospectData 是否存在来判定：有 retrospectData → pass，无 → not-run
 * （即使 file-exists+non-empty gate pass，retrospectData 缺失说明没产出结构化回顾）。
 */
const LEVER_TABLE: Array<{ lever: string; gate: string; special?: "retrospect" }> = [
  { lever: "spec 范围守门", gate: "lite-plan-schema" },
  { lever: "plan 结构化拆分", gate: "lite-plan-schema" },
  { lever: "TDD 红灯先行", gate: "tdd-red-light" },
  { lever: "expected 可信度", gate: "test-json-schema" },
  { lever: "dev commit 锚定", gate: "medium-git" },
  { lever: "review 存在性", gate: "file-exists+non-empty" },
  { lever: "test 机器重算", gate: "judgeByExpected" },
  { lever: "append-only 安全", gate: "append-only-validator" },
  { lever: "retrospect 结构化", gate: "file-exists+non-empty", special: "retrospect" },
];

/**
 * 杠杆健康度。
 *
 * 从 gateHistory 按 gate 名分组，每组取最新（id 最大）记录的 result。
 * 同一 gate 名对应多个 lever（如 lite-plan-schema → spec 守门 + plan 结构化），
 * 两者状态相同——这是有意的设计，因为它们读同一组 gate 记录。
 *
 * retrospect 杠杆特殊：gate 名与 review 共用，无法从 gateHistory 区分。
 * 用 topic.retrospectData 是否存在判定——有则 pass（产出结构化回顾），无则 not-run。
 */
function computeLeverHealth(topic: Topic): LeverHealth[] {
  // gate 名 → 最新记录的 result
  const gateLatest = new Map<string, "pass" | "fail">();
  for (const entry of topic.gateHistory) {
    gateLatest.set(entry.gate, entry.result);
  }

  return LEVER_TABLE.map(({ lever, gate, special }) => {
    // retrospect 杠杆不看 gateHistory，看 retrospectData 是否存在。
    // gate 名与 review 共用，按 gate 查会拿到 review 的状态，语义错位。
    if (special === "retrospect") {
      const status: LeverStatus = topic.retrospectData ? "pass" : "not-run";
      return { lever, gate, status };
    }
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

// ── 跨 topic 聚合（--all）──────────────────────────────────

/** 聚合分组的复合键——agent + llm + cwVersion 三元组唯一标识一个 runtimeEnv 分组。 */
interface GroupKey {
  agent: string;
  llm: string;
  cwVersion: string;
}

/**
 * 单个分组内、按复杂度分桶后的聚合指标（均值）。
 *
 * 均值只在桶内 topic 间计算——不同复杂度的指标本身不可比，分组后才可比。
 */
interface BucketAgg {
  level: ComplexityLevel;
  topicCount: number;
  avgFirstTryPassRate: number;
  avgEarlyInterceptionRate: number;
  avgTotalGateFails: number;
}

/**
 * 一个 runtimeEnv 分组的聚合结果。
 *
 * runtimeEnv 为 undefined（旧 topic）时归入 agent/llm/cwVersion="unknown" 分组。
 */
interface GroupAgg {
  runtimeEnv?: RuntimeEnv;
  agent: string;
  llm: string;
  cwVersion: string;
  topicCount: number;
  buckets: BucketAgg[];
}

export interface StatsAllOutput {
  groups: GroupAgg[];
  /** FR-6: 跨 topic 聚合 processIssues（不按 RuntimeEnv 分组——流程问题是 agent 通用问题）。 */
  retrospectInsights: RetrospectInsights;
}

/** 分组用的 unknown 占位值——旧 topic 无 runtimeEnv 时归入此组。 */
const UNKNOWN = "unknown";

/**
 * 把 topic 归到它的分组键。
 *
 * 旧 topic（无 runtimeEnv）归入 agent=unknown / llm=unknown / cwVersion=unknown。
 * 这是「不迁移、不报错」的兼容策略——旧数据照样能参与聚合。
 */
function groupKeyOf(topic: Topic): GroupKey {
  const env = topic.runtimeEnv;
  return {
    agent: env?.agent ?? UNKNOWN,
    llm: env?.llm ?? UNKNOWN,
    cwVersion: env?.cwVersion ?? UNKNOWN,
  };
}

/**
 * 把 GroupKey 序列化为 map key（agent|llm|cwVersion）。
 * 用分隔符拼字符串比 JSON.stringify 快且可读。三个字段都来自受控来源（env 配置），
 * 不会含分隔符——若未来放开，需改用复合 key 结构。
 */
function groupKeyToString(key: GroupKey): string {
  return `${key.agent}|${key.llm}|${key.cwVersion}`;
}

/**
 * 算单个 topic 的首次正确率（各 phase 首条记录中 pass 的比例）。
 *
 * 与 computeRetrospectDerived 的 firstTryPassRate 同逻辑——聚合时复用此算法。
 * 无任何 gate 记录时返回 1（没有失败即视为首次正确）。
 */
function firstTryPassRateOf(topic: Topic): number {
  const phaseGroups = new Map<Action, GateHistoryEntry[]>();
  for (const entry of topic.gateHistory) {
    const list = phaseGroups.get(entry.phase) ?? [];
    list.push(entry);
    phaseGroups.set(entry.phase, list);
  }
  let phaseCount = 0;
  let firstTryPassCount = 0;
  for (const entries of phaseGroups.values()) {
    phaseCount++;
    if (entries[0]?.result === "pass") firstTryPassCount++;
  }
  return phaseCount > 0 ? firstTryPassCount / phaseCount : 1;
}

/**
 * 在一个分组内按复杂度分桶，桶内算均值。
 *
 * 聚合的指标：
 *   - avgFirstTryPassRate：桶内 topic 的首次正确率均值
 *   - avgEarlyInterceptionRate：桶内 topic 的早期拦截率均值
 *   - avgTotalGateFails：桶内 topic 的 gate fail 总数均值
 *
 * 桶顺序固定为 simple → medium → complex（与单 topic 复杂度分桶一致），空桶也输出
 * （topicCount=0），便于消费方按固定下标对齐跨组对比。
 */
function aggregateBuckets(topics: Topic[]): BucketAgg[] {
  const levels: ComplexityLevel[] = ["simple", "medium", "complex"];
  return levels.map((level) => {
    const bucketTopics = topics.filter(
      (t) => computeComplexity(t).level === level,
    );
    const topicCount = bucketTopics.length;
    if (topicCount === 0) {
      return {
        level,
        topicCount: 0,
        avgFirstTryPassRate: 0,
        avgEarlyInterceptionRate: 0,
        avgTotalGateFails: 0,
      };
    }
    const sumFirstTryPass = bucketTopics.reduce(
      (sum, t) => sum + firstTryPassRateOf(t),
      0,
    );
    const sumEarlyInterception = bucketTopics.reduce(
      (sum, t) => sum + computeEfficiency(t).earlyInterceptionRate,
      0,
    );
    const sumTotalFails = bucketTopics.reduce(
      (sum, t) => sum + computeEfficiency(t).totalGateFails,
      0,
    );
    return {
      level,
      topicCount,
      avgFirstTryPassRate: sumFirstTryPass / topicCount,
      avgEarlyInterceptionRate: sumEarlyInterception / topicCount,
      avgTotalGateFails: sumTotalFails / topicCount,
    };
  });
}

/**
 * computeStatsAll — 跨 topic 聚合指标（cw stats --all）。
 *
 * 按 runtimeEnv（agent + llm + cwVersion）GROUP BY，同组内按复杂度分桶，桶内算均值。
 *
 * 纯函数：只读 topics 数据，无副作用，不依赖外部文件。
 * 旧 topic（无 runtimeEnv）归入 unknown 分组，不报错、不跳过。
 *
 * 分组顺序按首次出现的顺序（Map 保持插入序），桶顺序固定 simple → medium → complex。
 */
export function computeStatsAll(topics: Topic[]): StatsAllOutput {
  // FR-3: 排除 aborted topic（废弃 topic 不污染 stats 聚合）。
  const activeTopics = topics.filter((t) => t.status !== "aborted");

  // 按 GroupKey 字符串分组，保持插入顺序。
  const groupOrder: string[] = [];
  const groupKeyMap = new Map<string, GroupKey>();
  const groupTopicsMap = new Map<string, Topic[]>();

  for (const topic of activeTopics) {
    const key = groupKeyOf(topic);
    const keyStr = groupKeyToString(key);
    if (!groupKeyMap.has(keyStr)) {
      groupOrder.push(keyStr);
      groupKeyMap.set(keyStr, key);
      groupTopicsMap.set(keyStr, []);
    }
    groupTopicsMap.get(keyStr)!.push(topic);
  }

  const groups: GroupAgg[] = groupOrder.map((keyStr) => {
    const key = groupKeyMap.get(keyStr)!;
    const groupTopics = groupTopicsMap.get(keyStr)!;
    const isUnknown = key.agent === UNKNOWN;
    return {
      // 旧 topic 分组的 runtimeEnv 保持 undefined（反映数据真相）。
      runtimeEnv: isUnknown ? undefined : { ...key },
      agent: key.agent,
      llm: key.llm,
      cwVersion: key.cwVersion,
      topicCount: groupTopics.length,
      buckets: aggregateBuckets(groupTopics),
    };
  });

  // FR-6: 跨 topic 聚合 processIssues（不按 RuntimeEnv 分组——
  // 流程问题是 agent 通用问题，跨 env 聚合更有意义）。
  const typeBuckets = {
    pattern: 0,
    oneOff: 0,
    observation: 0,
    uncategorized: 0,
  };
  for (const topic of activeTopics) {
    const issues = topic.retrospectData?.processIssues;
    // 无 retrospectData 或 processIssues 不是数组 → 跳过（不崩）。
    // 依赖 W2 迁移：listTopics 已把旧 string[] 统一为 ProcessIssue[]，
    // 但此处仍做 Array.isArray 防御（直接 import 的纯函数测试可能传未迁移数据）。
    if (!issues || !Array.isArray(issues)) continue;
    for (const issue of issues) {
      const type = issue.type;
      if (type in typeBuckets) typeBuckets[type]++;
    }
  }

  return { groups, retrospectInsights: { typeBuckets } };
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

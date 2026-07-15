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

import type { GitValidator } from "./gate.js";
import type { CwStore } from "./store.js";

// ── 状态机值对象 ────────────────────────────────────────────

/**
 * 正向 action + replan + 修复动作。
 * clarify 插在 create 和 plan 之间——agent 先澄清需求/技术 spec + 记录 ADR，再写 plan。
 * tdd_plan 插在 plan 和 dev 之间——agent 先写测试代码 + test.json（红灯确认），再进 dev 写实现。
 * review_fix / test_fix：review/test loop 内的修复动作（progressive，闭环追踪用）。
 * assess：post-closeout 人工评估（progressive，不进 guidance 主链路，只在命令参考表列出）。
 */
export type Action =
  | "create"
  | "clarify"
  | "plan"
  | "tdd_plan"
  | "dev"
  | "review"
  | "review_fix"
  | "test"
  | "test_fix"
  | "retrospect"
  | "closeout"
  | "replan"
  | "assess";

/**
 * 8 个 status（新增 tdd_inited）。
 * tdd_inited：tdd_plan gate 通过，测试代码 + test.json 已写入，等待 dev 阶段实现。
 */
export type Status =
  | "created"
  | "planned"
  | "tdd_inited"
  | "developed"
  | "reviewed"
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

/**
 * 优先级——排序和评估用，不是跳过的理由。全部 P0/P1/P2 都必须完成。
 * P0=核心路径，P1=重要功能，P2=增强/优化。
 */
export type Priority = "P0" | "P1" | "P2";

/**
 * WaveChange — 结构化的文件变更声明。
 *
 * file 是文件路径（结构化，无歧义），description 是该文件的改动说明（自然语言）。
 * 取代旧版的 changes: string[]——不再用正则从自然语言提取路径。
 */
export interface WaveChange {
  file: string;
  description: string;
}

export interface Wave {
  id: string;
  dependsOn: string[];
  committed: string | null;
  changes: WaveChange[];
  priority?: Priority;
  /**
   * 该 wave 的 commit 实际改动的文件列表（git diff-tree --name-only）。
   * handleDev 在 devCheck 通过后持久化。未 committed 或 diff-tree 异常时为 undefined。
   * 用于 plan 完成度核对、有效产出率、散弹枪修改指数。
   */
  changedFiles?: string[];
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
  priority?: Priority;
  /**
   * tdd_plan 阶段是否对此 case 做红灯校验（跑测试文件确认 exit ≠ 0）。
   * mock 层通常 true（纯逻辑，可立即跑），real 层通常 false（需环境，tdd_plan 时跑不了）。
   */
  redCheck?: boolean;
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
  /** 测试通过率 = passed testCases / total testCases（closeout 时计算）。 */
  coverage?: number;
  /** gate 历史快照，closeout 后可回溯完整 gate 判定轨迹（reviewer 指出不能砍） */
  gateHistory: GateHistoryEntry[];
}

/**
 * 交付物文档记录——存储 review.md / retrospect.md 的路径 + 提交时间戳。
 * 用于后续检索复盘文档，分析 CW 流程的改进点。
 */
export interface Artifacts {
  reviewPath?: string;
  reviewAt?: string;
  retrospectPath?: string;
  retrospectAt?: string;
}

// ── retrospect 结构化数据（test → closeout 之间的 retrospect 阶段） ──

/**
 * RetrospectDerived — cw 自动从 topic 派生的回顾指标。
 *
 * agent 不填，handleRetrospect 从 gateHistory/waves/testCases 计算。
 * 与 stats.ts 的 computeEfficiency 共享部分计算逻辑（computeRetrospectDerived）。
 */
export interface RetrospectDerived {
  totalWaves: number;
  totalCases: number;
  /** 全阶段 gate fail 总数。 */
  gateFailCount: number;
  /** dev 阶段 progressive fail 次数。 */
  devRetryCount: number;
  /** test 阶段 progressive fail 次数。 */
  testRetryCount: number;
  /** TDD 红灯校验是否 pass（gateHistory 含 tdd-red-light pass 记录）。 */
  redLightConfirmed: boolean;
  /** 各 phase 首次调用即 pass 的比例（0-1）。 */
  firstTryPassRate: number;
}

/**
 * RetrospectKnownRisk — agent 自省的已知风险。
 *
 * 交付时已知但未完全解决的问题/假设。用于与 post-closeout assessment 交叉比对，
 * 算"自省准确度"——如果实际缺陷大部分没在 knownRisks 登记，说明自省流程太浅。
 */
export interface RetrospectKnownRisk {
  severity: "high" | "medium" | "low";
  /** 涉及的模块/功能区域。 */
  area: string;
  description: string;
  /** 是否为未经证实的假设（待 post-closeout 验证）。 */
  unverified: boolean;
}

/**
 * RetrospectData — retrospect 阶段的结构化产物（与 retrospect.md 双写）。
 *
 * 与 clarify 阶段的 clarifyJson + ADR 双写同模式：
 *   - retrospect.md（自由 markdown）给人读
 *   - retrospectData（结构化 JSON）给机器读
 *
 * agent 只填 knownRisks + processIssues，derived 由 cw 自动算并覆盖（不信任 agent 填的 derived）。
 */
export interface RetrospectData {
  /** cw 自动算（agent 不填）。 */
  derived: RetrospectDerived;
  /** agent 自省——本次交付中已知但未完全解决的风险。 */
  knownRisks: RetrospectKnownRisk[];
  /** 本次 topic 暴露的流程问题（供 quality-criteria 迭代参考）。 */
  processIssues: string[];
}

// ── 结构化 spec 章节（clarify 阶段产出，plan/review/test 追溯） ──

/**
 * 功能需求——spec 的核心结构化条目。
 * 来自对 118 个真实 spec.md 的统计：67% 文件有 FR-* 子节。
 */
export interface FunctionalRequirement {
  id: string;
  title: string;
  /** 详细描述（可含 md 代码块/表格）。 */
  detail: string;
}

/**
 * 验收标准——可判定的完成条件。
 * 84% 文件有 AC-* 子节。verification 标注如何验证。
 */
export interface AcceptanceCriterion {
  id: string;
  condition: string;
  verification?: "unit" | "manual" | "review";
}

/**
 * 业务用例——Actor 视角的使用场景。
 * 42% 文件有 UC-* 子节。
 */
export interface BusinessCase {
  id: string;
  actor: string;
  scenario: string;
  expectedResult: string;
}

/**
 * 决策记录——spec 阶段的技术/产品决策。
 * 25% 文件有此章节。
 */
export interface SpecDecision {
  id: string;
  decision: string;
  rationale: string;
}

/**
 * 目标——可衡量的业务目标。
 * 19% 文件有目标树结构。
 */
export interface SpecGoal {
  id: string;
  goal: string;
  successCriteria: string;
}

/**
 * SpecSection — spec 的一个章节，progressive append 到 topic.specSections。
 *
 * 分三类：
 *   1. 结构化章节（CW 校验内容 + report 模板渲染）：FR/AC/UC/decisions/complexity/outOfScope/goals
 *   2. md 章节（CW 只存不校验 + report mdToHtml）：background/constraints
 *   3. 兜底章节（agent 自定义章节名）：section
 *
 * 设计依据：对 ~/Code 下 6 个项目 118 个 spec.md 的内容模式统计。
 */
export type SpecSection =
  // 结构化章节
  | { type: "functionalRequirements"; items: FunctionalRequirement[] }
  | { type: "acceptanceCriteria"; items: AcceptanceCriterion[] }
  | { type: "businessCases"; items: BusinessCase[] }
  | { type: "decisions"; items: SpecDecision[] }
  | { type: "complexity"; rating: "low" | "medium" | "high"; rationale: string }
  | { type: "outOfScope"; items: string[] }
  | { type: "goals"; items: SpecGoal[] }
  // md 章节
  | { type: "background"; content: string }
  | { type: "constraints"; content: string }
  // 兜底章节
  | { type: "section"; sectionName: string; content: string };

// ── 澄清记录 + ADR（create → plan 之间的 clarify 阶段） ─────

/**
 * 澄清分类。
 * - requirement：需求 spec 澄清，阻塞串联业务用例的逻辑歧义。
 * - technical：技术 spec 澄清，涉及技术选型、架构设计、关键 ADR。
 */
export type ClarifyKind = "requirement" | "technical";

/**
 * 简单问题的选项（对应 AskUserQuestion 工具的选项式提问）。
 */
export interface ClarifyOption {
  id: string;
  label: string;
  /** 该选项的取舍点，帮助用户决策。 */
  tradeoff?: string;
}

/**
 * ClarifyRecord — create→plan 之间 progressive 记录的澄清条目。
 *
 * 设计参考 mattpocock 的 grill-with-docs（先探索后提问 + 留下 paper trail），
 * 适配 cw 的 agent-agnostic 约束：cw 只提供记录机制，不强制 agent 真去问用户。
 * 每条记录由 agent 调 cw clarify 时写入，渐进式（progressive），status 不流转。
 *
 * 禁止空问：assessment 字段必须非空——提问前 agent 必须先探索技术系统，
 * 形成背景 + 预判 + 推荐。空问 = 把探索成本转嫁给用户。
 */
export interface ClarifyRecord {
  /** CL1, CL2... cw 在 topic 内自增分配。 */
  id: string;
  kind: ClarifyKind;
  /** 一句话主题，便于检索。 */
  topic: string;
  /** agent 探索后的技术背景 + 预判和推荐。禁止空。 */
  assessment: string;
  question: string;
  /** 简单问题：选项式（对应 AskUserQuestion）。复杂问题留空，用 presentationPath。 */
  options?: ClarifyOption[];
  /** 推荐的 option.id。 */
  recommendation?: string;
  /** 复杂问题：方案对比 md/html 路径（.xyz-harness/{slug}/clarify-CL1.md）。 */
  presentationPath?: string;
  /** 用户回答（agent 转述）。pending 阶段为空。 */
  answer?: string;
  status: "pending" | "resolved" | "skipped";
  resolvedAt?: string;
  /** 若该澄清产生了 ADR，指向 AdrRecord.id。 */
  adrId?: string;
  createdAt: string;
}

/**
 * ADR — 架构决策记录，clarify 阶段的双写产物之一。
 *
 * 双写机制：agent 写项目 docs/adr/{id}-{title}.md（人可读，git tracked），
 * cw clarify 带 adr 字段（含 projectPath），cw 用 fileExistsCheck 校验文件存在后
 * 写入 topic.adrs（结构化数据，machine-readable）。
 *
 * 触发条件（采用 mattpocock domain-modeling 三条原则）：
 * 只有同时满足①难以逆转②没有上下文会让人觉得意外③真实取舍，才记 ADR。
 * 任一缺失则跳过。多数 session 产生 0-1 个 ADR 是正常的。
 */
export interface AdrRecord {
  /** 0001, 0002... cw 在 topic 内自增分配，padStart(4, "0")。 */
  id: string;
  title: string;
  status: "proposed" | "accepted";
  /** 决策背景（为什么需要做这个决策）。 */
  context: string;
  /** 决策内容。 */
  decision: string;
  /** 考虑过的替代方案。 */
  alternatives: string[];
  /** 决策后果（正面 + 负面）。 */
  consequences: string;
  /** 来源 ClarifyRecord.id。 */
  clarifyId?: string;
  /** agent 写的项目 docs/adr/ 文件路径，cw 用 fileExistsCheck 校验。 */
  projectPath?: string;
  createdAt: string;
}

/**
 * RuntimeEnv — 运行环境元数据，评估指标的分组维度。
 *
 * create 时注入，后续不可变。用于跨 topic 聚合时按 agent+llm+cwVersion 分组对比——
 * 不同 agent/LLM 组合之间没有可比性，只比较同组内不同 cwVersion 的差异。
 *
 * 取值优先级（cli.ts resolveRuntimeEnv 实现）：
 *   命令行 --agent / --llm  >  ~/.cw/<encodeCwd>/env.json  >  硬编码默认（Pi / GLM-5.2）
 *   cwVersion 始终从 package.json 自动读，不走命令行/env.json 路径。
 *
 * 旧 topic 兼容：已存在的 _cw.json topic 无 runtimeEnv 字段，loadTopic 时为 undefined。
 * stats 聚合时归入 agent=unknown / llm=unknown 分组。不迁移、不报错。
 */
export interface RuntimeEnv {
  agent: string;
  llm: string;
  /** 从 package.json 自动读取，不让人填。 */
  cwVersion: string;
}

// ── review / test issue tracking（闭环追踪） ───────────────

/**
 * ReviewIssueCategory — review issue 的审查维度分类。
 *
 * 用于事后统计 review 盲区分布（哪些维度的 issue 被遗漏）。agent 可选填，
 * 不提供时 CW 不报错（向后兼容旧数据）。
 */
export type ReviewIssueCategory =
  | "type-safety"
  | "error-handling"
  | "edge-case"
  | "test-coverage"
  | "plan-completeness"
  | "design-consistency";

/**
 * ReviewIssue — Review 阶段 agent 声明的问题（主观，CW 不验证内容，只追踪闭环）。
 *
 * 设计：CW 不判定 issue 的内容是否合理（review 是主观的），只追踪「声明的 issue 是否
 * 有对应的修复 commit」。severity 由 agent 自填，CW 不介入。
 * status=open → 还没修；status=fixed → 带 fix 证据（commitHash + resolution）。
 */
export interface ReviewIssue {
  /** R1, R2... cw 在 topic 内自增分配。 */
  id: string;
  severity: "must-fix" | "should-fix" | "nit";
  description: string;
  /** 关联代码位置，如 "src/types.ts:42"。 */
  file?: string;
  /** 审查维度（可选），用于事后统计 review 盲区分布。 */
  category?: ReviewIssueCategory;
  status: "open" | "fixed";
  /** 第几轮 review 发现的（1-based）。 */
  foundAtTurn: number;
  /** 修复证据（status=fixed 时必填）。 */
  fix?: {
    commitHash: string;
    resolution: string;
    fixedAtTurn: number;
  };
}

/**
 * TestFixEntry — Test 修复审计日志条目。
 *
 * 每次 test_fix 提交一条审计记录（caseId + commitHash + resolution + turn）。
 * 用于事后回溯「哪个 case 在哪轮被修复、怎么修的」，与 testCase.status 互补
 * （status 只反映当前态，testFixLog 是完整修复轨迹）。
 */
export interface TestFixEntry {
  caseId: string;
  commitHash: string;
  resolution: string;
  turn: number;
}

// ── post-closeout 评估（assess 阶段产物） ──────────────────

/** Assessment 类型——交付后评估的分类。 */
export type AssessmentType = "quality" | "test" | "stability" | "defect";

/** 缺陷严重度。 */
export type DefectSeverity = "blocker" | "major" | "minor";

/**
 * 缺陷详情——AssessmentType=defect 时填写。
 * foundInReview 是校准核心字段：标记该缺陷在 review 阶段是否已被发现。
 * 积累后可算 review 召回率 = review 发现的缺陷 / 总缺陷。
 */
export interface AssessmentDefect {
  severity: DefectSeverity;
  /** 涉及的模块/功能区域。 */
  area: string;
  /** 根因分类（如"边界遗漏"/"类型错误"/"需求理解偏差"等）。 */
  rootCause: string;
  /** review 阶段是否已发现该问题。true=review 抓到了但没修干净 / false=review 完全漏了。 */
  foundInReview: boolean;
}

/**
 * Assessment — post-closeout 评估记录。
 * progressive：closeout 后可多次调用，每次追加一条。
 * 不改变 topic.status（始终为 closed）。
 */
export interface Assessment {
  /** AS1, AS2... cw 在 topic 内自增分配。 */
  id: string;
  assessedAt: string;
  type: AssessmentType;
  /** 评分（可选，1-5）。不强制——有些评估是定性的。 */
  score?: number;
  notes: string;
  /** type=defect 时填写。 */
  defect?: AssessmentDefect;
}

export interface Topic {
  topicId: string;
  slug: string;
  objective: string;
  workspacePath: string;
  topicDir: string;
  createdAt: string;
  status: Status;
  /** create 时注入的运行环境元数据（评估指标分组维度）。旧 topic 可能为 undefined。 */
  runtimeEnv?: RuntimeEnv;
  waves: Wave[];
  testCases: TestCase[];
  gateHistory: GateHistoryEntry[];
  gatePassed: Partial<Record<Action, boolean>>;
  evidence?: Evidence;
  artifacts?: Artifacts;
  /** retrospect 阶段的结构化数据（与 retrospect.md 双写）。agent 填 knownRisks + processIssues，cw 自动算 derived。 */
  retrospectData?: RetrospectData;
  /** tdd_plan 阶段从 test.json 写入的项目级测试执行配置。 */
  testRunner?: TestRunnerConfig;
  /** clarify 阶段的澄清记录（progressive，create→plan 之间）。 */
  clarifyRecords: ClarifyRecord[];
  /** clarify 阶段产出的结构化 spec 章节（progressive，与 clarifyRecords 独立）。 */
  specSections: SpecSection[];
  /** clarify 阶段产生的 ADR 记录（与 docs/adr/ md 文件双写）。 */
  adrs: AdrRecord[];
  /** review 阶段声明的问题列表（闭环追踪，CW 不验证内容只追踪 fixed）。 */
  reviewIssues: ReviewIssue[];
  /** 当前是第几轮 review（初始 0，第一次 review 后变 1）。 */
  reviewTurn: number;
  /** test 阶段的修复审计日志（每次 test_fix 追加一条）。 */
  testFixLog: TestFixEntry[];
  /** 当前是第几轮 test（初始 0，第一次 test 后变 1）。 */
  testTurn: number;
  /** post-closeout 评估记录（progressive，每次 cw assess 追加一条，不改变 status）。 */
  assessments: Assessment[];
}

// ── DAO seed 类型（plan.json 解析后写入 store 的输入形态） ─────

export interface WaveSeed {
  id: string;
  dependsOn: string[];
  changes?: WaveChange[];
  priority?: Priority;
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
  priority?: Priority;
  redCheck?: boolean;
}

/**
 * ClarifySeed — clarifyJson 解析后写入 store 的输入形态。
 * 不含 id/createdAt/status——由 cw 在 appendClarifyRecord 时填充。
 */
export interface ClarifySeed {
  kind: ClarifyKind;
  topic: string;
  assessment: string;
  question: string;
  options?: ClarifyOption[];
  recommendation?: string;
  presentationPath?: string;
  /** 用户回答。非空时 cw 自动设 status=resolved + resolvedAt。 */
  answer?: string;
  /** 关联的 ADR seed（若该澄清产生了 ADR）。 */
  adr?: AdrSeed;
}

/**
 * AdrSeed — ClarifySeed.adr 字段的输入形态。
 * 不含 id/createdAt/clarifyId——由 cw 在 appendAdr 时填充。
 */
export interface AdrSeed {
  title: string;
  status?: "proposed" | "accepted";
  context: string;
  decision: string;
  alternatives: string[];
  consequences: string;
  /** 项目 docs/adr/ 文件路径，cw 用 fileExistsCheck 校验存在。 */
  projectPath?: string;
}

// ── review / test 修复 submission（actions.ts 输入形态） ────

/**
 * ReviewIssueSubmission — review action 提交的 issue 输入形态。
 * 不含 id/status/foundAtTurn/fix——由 cw 在 appendReviewIssues 时填充。
 */
export interface ReviewIssueSubmission {
  severity: "must-fix" | "should-fix" | "nit";
  description: string;
  file?: string;
  /** 审查维度（可选），用于事后统计 review 盲区分布。 */
  category?: ReviewIssueCategory;
}

/**
 * ReviewFixSubmission — review_fix action 提交的单条修复。
 * issueId 指向已存在的 ReviewIssue.id。
 */
export interface ReviewFixSubmission {
  issueId: string;
  commitHash: string;
  resolution: string;
}

/**
 * TestFixSubmission — test_fix action 提交的单条修复。
 */
export interface TestFixSubmission {
  caseId: string;
  commitHash: string;
  resolution: string;
}

// ── TestRunner 配置（test.json 顶层，定义如何执行测试） ──────

/**
 * 测试执行器模式。
 * - nodejs：Node.js 生态（vitest/jest/mocha），command 字段指定测试命令
 * - python：Python 生态（pytest/unittest），command 字段指定测试命令
 * - java：Java 生态（JUnit/TestNG/Maven），command 字段指定测试命令
 * - custom：用户自定义脚本，path 字段指定脚本路径
 */
export type TestRunnerMode = "nodejs" | "python" | "java" | "custom";

/**
 * TestRunnerConfig — test.json 的 testRunner 字段，定义项目的测试执行策略。
 *
 * 不配置时 CW 不自动执行测试（agent 模式，agent 自己跑测试后提交 actual）。
 * 配置后 CW engine 在 test 阶段可自动执行 command/path，获取 exit code 判定 pass/fail。
 */
export interface TestRunnerConfig {
  mode: TestRunnerMode;
  /** nodejs/python/java 模式的测试命令（如 "npx vitest run"、"python -m pytest"）。 */
  command?: string;
  /** 命令执行的工作目录（相对 workspacePath），默认 "."。 */
  cwd?: string;
  /** custom 模式的脚本路径（相对 workspacePath，如 ".cw/run-tests.sh"）。 */
  path?: string;
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
  /** clarify 阶段的澄清记录进度摘要。 */
  clarifyProgress?: Array<{
    id: string;
    kind: ClarifyKind;
    status: ClarifyRecord["status"];
    adrId?: string;
  }>;
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

// ── CwError（预期错误标记）──────────────────────────────────

/**
 * CwError — 预期错误（agent 可修正的输入/状态问题）。
 *
 * CLI 层 mapExitCode 按 instanceof CwError 判定 exit code=1（而非 18 条字符串前缀匹配）。
 * GuardError extends CwError，所以 guard 拒绝也走同一条路径。
 *
 * 抛 CwError 的场景：参数缺失、topic not found、replan append-only 违规、
 * JSON 解析失败、slug 重复（UNIQUE constraint）等。
 *
 * 不抛 CwError 的场景（保持普通 Error → exit 2 内部异常）：
 *   - 事务后 topic 消失（不变式违反，理论上不可能）
 *   - lock 获取失败（基础设施问题）
 */
export class CwError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CwError";
  }
}

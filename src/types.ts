/**
 * CW 共享类型 + judgeByExpected 纯函数（lite 单轨极简版）。
 *
 * 变化轴：跨层共享的数据契约 + 测试判定密封逻辑。
 * 不依赖任何 cw 模块的运行时值（CwStore/GitValidator 仅 type-only 反向引用）。
 *
 * 与旧版的差异（重构 = 推倒重建）：
 * - tier 字段彻底砍掉（lite-only 硬编码，不再分档）
 * - GuardErrorCode 含 illegal_transition（跨阶段跳步）+ phase_prerequisite_failed（前序阶段未完成，handler 层前置检查）
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
  | "confirm_clarify"
  | "spec_review"
  | "spec_review_fix"
  | "plan"
  | "plan_review"
  | "plan_review_fix"
  | "tdd_plan"
  | "dev"
  | "review"
  | "review_fix"
  | "test"
  | "test_fix"
  | "retrospect"
  | "closeout"
  | "replan"
  | "abort"
  | "assess";

/**
 * 10 个 status（新增 clarify_confirmed + aborted）。
 * clarify_confirmed：clarify gate 通过（用户确认需求），允许进 plan。
 * aborted：终止态（agent 主动放弃 topic），不可恢复。
 * tdd_inited：tdd_plan gate 通过，测试代码 + test.json 已写入，等待 dev 阶段实现。
 */
export type Status =
  | "created"
  | "clarify_confirmed"
  | "spec_reviewed"
  | "planned"
  | "plan_reviewed"
  | "tdd_inited"
  | "developed"
  | "reviewed"
  | "tested"
  | "retrospected"
  | "closed"
  | "aborted";

// ── judgeByExpected ─────────────────────────────────────────

/**
 * Expected — 测试用例的机器判定基准（判别联合，按 type 字段分支）。
 *
 * 三种模式：
 *   - exact：精确字符串 === 比较（url 和/或 text）。与旧 {url?,text?} 行为完全一致。
 *   - exit_zero：按 actual.exitCode 判定（0→passed，非0→failed）。命令执行在 W3 handleTest，
 *     此处只做纯函数判定（actual 形状含 exitCode，由执行层回填）。
 *   - script：执行 expected.path 指向的脚本，按 exitCode 判定（0→passed，非0→failed）。
 *     执行在 W3 handleTest；此处纯函数判定读 actual.exitCode。
 *
 * 判别联合必须用 type alias（interface 无法表达 union），但 import 语义与 interface 兼容
 * （`import { type Expected }` / `import type { Expected }` 均可用）。
 */
export type Expected =
  | { type: "exact"; url?: string; text?: string }
  | { type: "exit_zero" }
  | { type: "script"; path: string };

export interface Actual {
  url?: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * judgeByExpected — 机器判定基准（lite plan.json 结构化字段）。
 *
 * 纯函数约束（AC-8）：本函数体内不得 import 或调用任何子进程执行 API（spawn/exec 系）。
 * 命令/脚本执行在 W3 handleTest，此处只做判定归一化。
 *
 * 分支：
 *   - exact：expected.url/text 存在则要求 actual 对应字段存在且 ===（精确，无 fuzzy/trim 容差）；
 *     任一不一致 → failed + 逐字段 reason；无 judgeable 字段 → failed「no judgeable field」（兜底）。
 *   - exit_zero：读 actual.exitCode（number）；0 → passed，非 0/缺失 → failed。
 *     不报「no judgeable field」（exit_zero 本身是合法判据，未执行不与 exact 兜底混淆）。
 *   - script：同 exit_zero，读 actual.exitCode（脚本执行由 handleTest 回填）。
 *   - 未知 type → failed「unknown expected type」（防御，plan-parser schema 应已拦）。
 *
 * actual.exitCode 通过 Actual 的索引签名 [key: string]: unknown 访问；显式提取并校验为 number。
 */
export function judgeByExpected(
  expected: Expected,
  actual: Actual,
): { status: "passed" | "failed"; reason: string } {
  switch (expected.type) {
    case "exact": {
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

      // plan-parser 应已保证 exact 至少含一个 judgeable 字段；兜底防御。
      if (expected.url === undefined && expected.text === undefined) {
        return { status: "failed", reason: "no judgeable field in expected (url/text)" };
      }

      if (mismatches.length > 0) {
        return { status: "failed", reason: mismatches.join("; ") };
      }
      return { status: "passed", reason: "" };
    }

    case "exit_zero":
    case "script": {
      // actual.exitCode 由 handleTest（W3）执行命令/脚本后回填。
      // 未提供 / 非 number / 非 0 一律 failed（reason 含实际 exitCode 便于排查）。
      const code = actual.exitCode;
      if (typeof code !== "number" || !Number.isFinite(code)) {
        return {
          status: "failed",
          reason: `${expected.type}: actual.exitCode missing or non-number (got ${String(code)})`,
        };
      }
      if (code === 0) {
        return { status: "passed", reason: "" };
      }
      return { status: "failed", reason: `${expected.type}: exitCode=${code} (expected 0)` };
    }

    default: {
      // 未知 type 兜底（plan-parser schema 应已拦截；运行时防御）。
      // switch 已覆盖 exact/exit_zero/script 三种 type，此分支理论上不可达（expected 此处为 never）；
      // 仍保留兜底，读取 type 字段做诊断（断言为含必填 type 的形状，避免全可选断言绕过校验）。
      const unknownExpected = expected as { type: unknown };
      return {
        status: "failed",
        reason: `unknown expected type: ${String(unknownExpected.type)}`,
      };
    }
  }
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
  expected: Expected;
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
 * 单个审查阶段产物的文档记录（路径 + 时间戳）。
 */
export interface ArtifactDoc {
  path: string;
  at: string;
}

/**
 * Artifacts — 所有阶段交付物文档的统一记录。
 *
 * FR-1 重构：从旧版平铺（reviewPath/reviewAt/retrospectPath/retrospectAt）改为
 * 按 phase 分组的嵌套结构。每个 phase 含 path + at。
 * confirmSpec（FR-8 gen-spec 产物）也纳入此处。
 * 旧 _cw.json 平铺格式在 store 加载时迁移（store.ts migrateArtifacts）。
 */
export interface Artifacts {
  /** FR-8: gen-spec 产出的确认文档（confirm gate 校验存在性）。 */
  confirmSpec?: ArtifactDoc;
  /** FR-4: spec_review 阶段的审查报告。 */
  specReview?: ArtifactDoc;
  /** FR-5: plan_review 阶段的审查报告。 */
  planReview?: ArtifactDoc;
  /** dev 后 review 阶段的审查报告。 */
  review?: ArtifactDoc;
  /** retrospect 阶段的复盘报告。 */
  retrospect?: ArtifactDoc;
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
 * ProcessIssueType — 结构化流程问题的分类维度（FR-3 / D5）。
 *
 * 四值语义：
 *   - pattern：可泛化的流程模式（跨 topic 可复现，有迭代 quality-criteria 的价值）
 *   - oneOff：一次性失误（偶发，无泛化价值，仅记录）
 *   - observation：观察性陈述（非问题性陈述，记录现象供回溯）
 *   - uncategorized：旧 string[] 迁移标记（W2 migrateProcessIssues 把历史裸字符串
 *     包装成本对象时打上的兜底标签，新数据禁止用——agent 自省时必须显式选前三类）
 *
 * 用字面量联合类型（而非 enum）：供 W3 state-machine 校验 type 合法值时可直接
 * `value in PROCESS_ISSUE_TYPES` 集合判定，且 ts 存档体积更小。
 */
export type ProcessIssueType = "pattern" | "oneOff" | "observation" | "uncategorized";

/**
 * ProcessIssue — 结构化流程问题（FR-3 升级后的 processIssues 元素类型）。
 *
 * 原 RetrospectData.processIssues 为 string[]，FR-3 破坏性升级为对象数组：
 * 每条流程问题带上 type 分类，便于 W5 cw stats --all 按 type 分桶统计 + 提取
 * pattern 类的高频词做流程改进挖掘。旧 string[] 由 W2 migrateProcessIssues
 * 迁移为 `{ type: "uncategorized", description: <原字符串> }`。
 */
export interface ProcessIssue {
  type: ProcessIssueType;
  description: string;
}

/**
 * RetrospectData — retrospect 阶段的结构化产物（与 retrospect.md 双写）。
 *
 * 与 clarify 阶段的 clarifyJson + ADR 双写同模式：
 *   - retrospect.md（自由 markdown）给人读
 *   - retrospectData（结构化 JSON）给机器读
 *
 * agent 只填 knownRisks + processIssues，derived 由 cw 自动算并覆盖（不信任 agent 填的 derived）。
 *
 * FR-3 破坏性升级：processIssues 从 string[] 升级为 ProcessIssue[]（带 type 分类），
 * 便于 W5 cw stats --all 按 type 分桶统计 + pattern 词频挖掘。
 * 旧 _cw.json 中的 string[] 由 W2 migrateProcessIssues 在 store 加载时迁移为
 * `{ type: "uncategorized", description: <原字符串> }` 数组，迁移后此字段恒为对象数组。
 */
export interface RetrospectData {
  /** cw 自动算（agent 不填）。 */
  derived: RetrospectDerived;
  /** agent 自省——本次交付中已知但未完全解决的风险。 */
  knownRisks: RetrospectKnownRisk[];
  /** 本次 topic 暴露的流程问题（FR-3 升级：对象数组，带 type 分类；旧 string[] 由 W2 迁移）。 */
  processIssues: ProcessIssue[];
}

/**
 * RetrospectInsights — cw stats --all 的 retrospectInsights 段（FR-6 / AC-6）。
 *
 * 跨 topic 聚合 RetrospectData.processIssues 产出的流程洞察，作为 StatsAllOutput
 * 顶层字段（不按 RuntimeEnv 分组——流程问题是 agent 通用问题，跨 env 聚合更有意义）。
 * 定义在此处供 W5 的 StatsAllOutput 引用；StatsAllOutput 本体扩展在 src/stats.ts（W5 改）。
 *
 * 聚合规则（W5 computeStatsAll 实现）：
 *   - 排除 status=aborted 的废弃 topic
 *   - 无 retrospectData 的 topic 贡献空桶（不崩）
 */
export interface RetrospectInsights {
  /** 按 ProcessIssueType 分桶统计（pattern/oneOff/observation/uncategorized 各多少条）。 */
  typeBuckets: {
    pattern: number;
    oneOff: number;
    observation: number;
    uncategorized: number;
  };
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

/**
 * SpecVersion — spec 历史版本快照（spec 替换时归档）。
 *
 * spec 是规划产物（非执行产物），允许修改。每次 replaceSpecSections 时，
 * 当前 specSections 整体快照推入 specHistory，version 自增。
 * report/retrospect 可引用 specHistory 看 spec 变更轨迹。
 */
export interface SpecVersion {
  /** 版本号（1-based，首次替换归档 v1）。 */
  version: number;
  /** 归档时间。 */
  archivedAt: string;
  /** 归档时的 spec 快照。 */
  sections: SpecSection[];
  /** 替换原因（agent 提供）。 */
  reason: string;
}

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
 * ReviewDimension — 审查维度分类（FR-3 统一升级）。
 *
 * 三阶段共用（review/spec_review/plan_review），共 12 个值：
 *   - 代码审查 6 值（原 ReviewIssueCategory，review 阶段用）
 *   - spec 审查 3 值（spec_review 阶段用）
 *   - plan 审查 3 值（plan_review 阶段用）
 *
 * 用于事后统计审查盲区分布（哪些维度的 issue 被遗漏）。
 * FR-3 升级后 dimension 必填（原 category 可选）——强制 agent 按维度归类发现。
 */
export type ReviewDimension =
  // 代码审查维度（review 阶段）
  | "type-safety"
  | "error-handling"
  | "edge-case"
  | "test-coverage"
  | "plan-completeness"
  | "design-consistency"
  // spec 审查维度（spec_review 阶段，FR-4）
  | "completeness"
  | "consistency"
  | "reasonableness"
  // plan 审查维度（plan_review 阶段，FR-5）
  | "coverage"
  | "architecture"
  | "feasibility";

/**
 * ReviewIssue — 审查阶段 agent 声明的问题（主观，CW 不验证内容，只追踪闭环）。
 *
 * FR-3 统一升级后，三阶段（review/spec_review/plan_review）共用此结构：
 *   - dimension 必填（原 category 可选）——强制按维度归类
 *   - ref 泛化（原 file 限代码路径，现可为 spec 条目 ID 如 FR-3 / W2）
 *   - fix.commitHash 改可选（代码 review 必填，spec/plan review 可选因修复可能走 cw 内部）
 *
 * 各阶段用独立数组存储（topic.reviewIssues / specReviewIssues / planReviewIssues），
 * id 前缀区分（R / SR / PR）。
 */
export interface ReviewIssue {
  /** R1, R2...(review) / SR1, SR2...(spec_review) / PR1, PR2...(plan_review) cw 自增分配。 */
  id: string;
  /** FR-3: 审查维度（必填），用于事后统计盲区分布。 */
  dimension: ReviewDimension;
  severity: "must-fix" | "should-fix" | "nit";
  description: string;
  /** 关联位置：代码审查填文件路径（如 "src/types.ts:42"），spec/plan 审查填条目 ID（如 "FR-3" / "W2"）。 */
  ref?: string;
  status: "open" | "fixed";
  /** 第几轮审查发现的（1-based）。 */
  foundAtTurn: number;
  /** 修复证据（status=fixed 时必填）。 */
  fix?: {
    /** commitHash：代码 review 必填，spec/plan review 可选（修复可能走 cw 内部无独立 commit）。 */
    commitHash?: string;
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
  /** spec 替换时的历史版本快照（replaceSpecSections 归档，report 渲染变更日志）。 */
  specHistory: SpecVersion[];
  /** clarify 阶段产生的 ADR 记录（与 docs/adr/ md 文件双写）。 */
  adrs: AdrRecord[];
  /** review 阶段声明的问题列表（闭环追踪，CW 不验证内容只追踪 fixed）。 */
  reviewIssues: ReviewIssue[];
  /** 当前是第几轮 review（初始 0，第一次 review 后变 1）。 */
  reviewTurn: number;
  /** FR-4: spec_review 阶段的审查 issue 列表（与 reviewIssues 平行，id 前缀 SR）。 */
  specReviewIssues: ReviewIssue[];
  /** FR-4: 当前是第几轮 spec_review（初始 0）。 */
  specReviewTurn: number;
  /** FR-5: plan_review 阶段的审查 issue 列表（与 reviewIssues 平行，id 前缀 PR）。 */
  planReviewIssues: ReviewIssue[];
  /** FR-5: 当前是第几轮 plan_review（初始 0）。 */
  planReviewTurn: number;
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
  expected: Expected;
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
 * ReviewIssueSubmission — review/spec_review/plan_review action 提交的 issue 输入形态。
 * 不含 id/status/foundAtTurn/fix——由 cw 在 append 时填充。
 * FR-3 统一升级：dimension 必填，ref 泛化。
 */
export interface ReviewIssueSubmission {
  /** FR-3: 审查维度（必填）。 */
  dimension: ReviewDimension;
  severity: "must-fix" | "should-fix" | "nit";
  description: string;
  /** 关联位置（可选）：代码路径或 spec/plan 条目 ID。 */
  ref?: string;
}

/**
 * ReviewFixSubmission — review_fix/spec_review_fix/plan_review_fix action 提交的单条修复。
 * issueId 指向已存在的 ReviewIssue.id。
 * FR-3: commitHash 改可选（代码 review 必填，spec/plan review 可选）。
 */
export interface ReviewFixSubmission {
  issueId: string;
  /** commitHash：代码 review 必填（handler 校验格式），spec/plan review 可选。 */
  commitHash?: string;
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
 * guard 错误码。
 * - illegal_transition：status 跳步（checkLinear 产生，状态序非法）
 * - phase_prerequisite_failed：status 合法但前序阶段未完成（handler 层前置检查产生，
 *   如 developed 但 dev gate=false 时调 review）。两者正交，互补。
 */
export type GuardErrorCode = "illegal_transition" | "phase_prerequisite_failed";

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
  /** clarify 阶段产出的 spec 章节进度摘要。 */
  specProgress?: Array<{ type: string; itemCount?: number }>;
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

/**
 * GuardError — guard / 前置检查拒绝时抛出，extends CwError 走 exit 1。
 *
 * code 两种：
 * - illegal_transition：status 跳步（checkLinear 产生）
 * - phase_prerequisite_failed：status 合法但前序阶段未完成（handler 前置检查产生）
 *
 * 定义在 types.ts（而非 dispatch.ts）以避免 actions↔dispatch 循环依赖：
 * actions.ts 的 handler 需要抛 phase_prerequisite_failed，而 dispatch.ts import actions.ts。
 */
export class GuardError extends CwError {
  constructor(
    public readonly code: GuardErrorCode,
    public readonly reason: string,
    /** phase_prerequisite_failed 专属：缺失的前序阶段。illegal_transition 时 undefined。 */
    public readonly missingPhase?: "dev" | "review" | "test" | "retrospect",
    /** phase_prerequisite_failed 专属：当前 status。 */
    public readonly currentStatus?: Status,
  ) {
    super(`${code}: ${reason}`);
    this.name = "GuardError";
  }
}

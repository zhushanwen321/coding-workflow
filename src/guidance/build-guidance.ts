/**
 * v1 guidance — guidance 文本组装器（prefix + template + schema → guidance 文本）。
 *
 * 来源：v5 cli-and-guidance §3.4「正常 guidance 的固定结构」+ §3.5「异常 guidance 的结构」。
 *
 * 职责：把 prefix-builder / schema-injector / templates 的产物 + 命令组装成最终 guidance 文本。
 *      纯函数零 IO——所有片段由调用方（handler）传入，本函数只做拼接。
 *
 * 两种输出形态：
 *   - 正常三段式（§3.4）：位置 / 下一步 / input schema + 关键约束
 *   - 异常四段式（§3.5）：位置 / 问题 / 怎么修 / 递进提示（递进提示为空时省略）
 *
 * 设计原则（§3.1）：每次 guidance 只含 agent 当前决策需要的最小信息，短而聚焦。
 */
// ═══════════════════════════════════════════════════════════════
// 正常 guidance（ok=true，三段式）
// ═══════════════════════════════════════════════════════════════

/** buildNormalGuidance 入参。各片段均由调用方算好后传入。 */
export interface BuildNormalGuidanceArgs {
  /** 位置前缀（来自 prefix-builder）。 */
  prefix: string;
  /** 下一步 action 名（如 "plan"）。用于「下一步」段的语义。 */
  nextAction: string;
  /** 一句话目标（来自 template.goal，描述当前阶段要做什么）。 */
  goal: string;
  /** 完整命令（如 "cw plan --unitId wave:x --input .cw/<slug>/plan.json"）。 */
  command: string;
  /** input schema 文本（来自 schema-injector）。 */
  schemaText: string;
  /** 模板文本（来自 templates/wave.ts 的关键约束段）。 */
  templateText: string;
  /**
   * 通用引导段（来自 subagent-guidance.buildSubagentGuidance，描述本 action 的 subagent 委派建议）。
   * 为空/undefined 时不渲染第 4 段，保持三段式（§3.1 最小信息原则）。
   */
  commonGuidance?: string;
}

/**
 * 组装正常 guidance（三段式：位置 / 下一步 / input schema + 关键约束；commonGuidance 非空时追加第 4 段）。
 *
 * 输出结构（§3.4 / §4.x）：
 * ```
 * ## 位置
 * {prefix}
 *
 * ## 下一步
 * {goal}
 * 命令：{command}
 *
 * ## input schema + 关键约束
 * {schemaText}
 * {templateText 的关键约束段}
 *
 * ## 中间产物管理        ← 仅当 command 含 --input 时才输出此段
 * （固定文案：.cw/ 不进 git 等）
 *
 * ## subagent 调度        ← 仅当 commonGuidance 非空时才输出此段
 * {commonGuidance}
 * ```
 *
 * 注：goal 来自 template.goal（一句话目标），由调用方从 template 取出后传入。
 *      templateText 是 constraint 段（关键约束），整段附在 schema 后。
 *      commonGuidance 是 subagent 委派建议（按 action 性质分强制/建议/禁止三档），为空时省略。
 *      「中间产物管理」段在 command 含 --input（即该 action 产生中间产物 JSON）时自动追加，
 *      无需调用方传参——文案固定，所有有 input 的 action 共用。
 */
const ARTIFACT_HINT = [
  "## 中间产物管理",
  "- `.cw/` 目录是机器消费的中间产物（clarify/plan/design-review 等 input JSON），**不要 git 提交**（已在 .gitignore）。",
  "- 如已误提交历史产物，用 `git rm --cached -r .cw/` 清理追踪（不删本地文件）。",
  "- 报告类产物（handoff 交接文档、retrospect 经验总结）是人读的，由你视情况存到 docs/ 目录。",
].join("\n");

export function buildNormalGuidance(args: BuildNormalGuidanceArgs): string {
  const { prefix, goal, command, schemaText, templateText, commonGuidance } = args;
  // 约束段为空时不留空行；非空时前缀换行。
  const constraintSection = templateText.trim() !== ""
    ? `\n${templateText.trim()}`
    : "";

  const sections = [
    "## 位置",
    prefix,
    "",
    "## 下一步",
    goal,
    `命令：${command}`,
  ];

  // #1 终态守卫：schemaText 为空（nextAction=undefined）时不渲染 schema block
  // （closeout/abort 后无「下一步 input」可展示，空段只会产生噪声）。
  if (schemaText.trim() !== "") {
    sections.push("", "## input schema + 关键约束", schemaText, constraintSection);
  } else if (constraintSection !== "") {
    sections.push("", constraintSection);
  }

  // command 含 --input（该 action 产生中间产物 JSON）时追加「中间产物管理」段。
  if (command.includes("--input")) {
    sections.push("", ARTIFACT_HINT);
  }

  // 通用引导段为空时省略此段（§3.1 最小信息原则）。
  const common = commonGuidance?.trim() ?? "";
  if (common !== "") {
    sections.push("", "## subagent 调度", common);
  }

  return sections.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// 异常 guidance（ok=false，四段式）
// ═══════════════════════════════════════════════════════════════

/** buildFailureGuidance 入参。 */
export interface BuildFailureGuidanceArgs {
  /** 位置前缀（来自 prefix-builder）。 */
  prefix: string;
  /** gate fail 的具体问题（哪个字段/哪个条件没满足）。 */
  problem: string;
  /** 修正后重新提交同一 action 的命令。 */
  fixCommand: string;
  /** 递进提示文本（来自 failure-hint，可能为空）。 */
  failureHint: string;
}

/**
 * 组装异常 guidance（四段式：位置 / 问题 / 怎么修 / 递进提示）。
 *
 * 输出结构（§3.5 / §5.1）：
 * ```
 * ## 位置
 * {prefix}
 *
 * ## 问题
 * {problem}
 *
 * ## 怎么修
 * {fixCommand}
 *
 * ## 递进提示        ← 仅当 failureHint 非空时才输出此段
 * {failureHint}
 * ```
 *
 * failureHint 为空（failureCount <= 1）时省略「递进提示」段（§5.1 第 1 次示例无此段）。
 */
export function buildFailureGuidance(args: BuildFailureGuidanceArgs): string {
  const { prefix, problem, fixCommand, failureHint } = args;

  const sections = [
    "## 位置",
    prefix,
    "",
    "## 问题",
    problem,
    "",
    "## 怎么修",
    fixCommand,
  ];

  // 递进提示为空时省略此段（§3.5 + §5.1）。
  const hint = failureHint.trim();
  if (hint !== "") {
    sections.push("", "## 递进提示", hint);
  }

  return sections.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// replan guidance（审视引导 + 影响面 + 下一步）
// ═══════════════════════════════════════════════════════════════

/** buildReplanGuidance 入参。 */
export interface BuildReplanGuidanceArgs {
  /** 位置前缀（来自 prefix-builder）。 */
  prefix: string;
  /** 本次废弃的条目 id 列表。 */
  abandonedIds: string[];
  /** replan 次数（渐进式提示用）。 */
  replanCount: number;
  /** replan 影响面描述（aborted/preserved/pendingRebuild）。 */
  impactSummary: string;
  /** 下一步命令（如 "cw plan --unitId slice:auth --input .cw/<slug>/plan.json"）。 */
  nextCommand: string;
  /**
   * 下一步的 input schema 文本（#1 D-017：replan 后下一步是 plan，agent 需要 plan 的 input schema）。
   * 由调用方按层取 getSchemaText("plan") 传入；不传/为空则不渲染 schema 段。
   */
  schemaText?: string;
}

/**
 * 组装 replan guidance（审视引导 + 影响面 + 下一步）。
 *
 * 输出结构：
 * ```
 * ## 位置
 * {prefix}
 *
 * ## 你刚发起了 replan
 * 审视引导（单点 vs 方向性 + 三维度）
 *
 * ## 影响面
 * {impactSummary}
 *
 * ## 下一步
 * {nextCommand}
 * ```
 *
 * 审视引导文本来自 replan-review.ts 模板（渐进式：第 2 次加警告，第 3 次建议 abort）。
 */
export function buildReplanGuidance(args: BuildReplanGuidanceArgs): string {
  const { prefix, abandonedIds, replanCount, impactSummary, nextCommand, schemaText } = args;

  // 审视引导来自模板
  const reviewText = buildReplanReviewTextInner(abandonedIds, replanCount);

  const sections = [
    "## 位置",
    prefix,
    "",
    reviewText,
    "",
    "## 影响面",
    impactSummary,
  ];

  // #1 D-017：replan 后下一步是 plan，透传 plan 的 input schema 段（agent 重新提交方案需要）。
  const schema = schemaText?.trim() ?? "";
  if (schema !== "") {
    sections.push("", "## input schema + 关键约束", schema);
  }

  sections.push(
    "",
    "## 下一步",
    "审视完后重新提交方案：",
    `命令：${nextCommand}`,
  );

  return sections.join("\n");
}

// 内部函数：直接调模板（避免循环依赖——模板是纯文本，这里直接 import）
import { buildReplanReviewText } from "./templates/replan-review.js";

function buildReplanReviewTextInner(
  abandonedIds: string[],
  replanCount: number,
): string {
  return buildReplanReviewText({ abandonedIds, replanCount });
}

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
  /** 完整命令（如 "cw plan --unitId wave:x --input @plan.json"）。 */
  command: string;
  /** input schema 文本（来自 schema-injector）。 */
  schemaText: string;
  /** 模板文本（来自 templates/wave.ts 的关键约束段）。 */
  templateText: string;
}

/**
 * 组装正常 guidance（三段式：位置 / 下一步 / input schema + 关键约束）。
 *
 * 输出结构（§3.4 / §4.x）：
 * ```
 * ## 位置
 * {prefix}
 *
 * ## 下一步
 * {一句话目标}
 * 命令：{command}
 *
 * ## input schema + 关键约束
 * {schemaText}
 * {templateText 的关键约束段}
 * ```
 *
 * 注：一句话目标来自 templateText 的 goal，由调用方拆出——本函数把 templateText
 *      作为「关键约束段」整段附在 schema 后（goal 单独由调用方填入「下一步」段）。
 *      若调用方把 goal 已含在 nextAction 之外的文案里，可直接传空 templateText。
 */
export function buildNormalGuidance(args: BuildNormalGuidanceArgs): string {
  const { prefix, nextAction, command, schemaText, templateText } = args;
  // 约束段为空时不留空行；非空时前缀换行。
  const constraintSection = templateText.trim() !== ""
    ? `\n${templateText.trim()}`
    : "";

  return [
    "## 位置",
    prefix,
    "",
    "## 下一步",
    `（${nextAction} 阶段）`,
    `命令：${command}`,
    "",
    "## input schema + 关键约束",
    schemaText,
    constraintSection,
  ].join("\n");
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

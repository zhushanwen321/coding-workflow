/**
 * CW check 脚本共享基础设施（移植自 skills/full-clarity/scripts/_shared_check_lib.py）。
 *
 * 提供：
 *   - CheckReport：累积检查结果 + 渲染 markdown 报告 + 转 CheckOutput
 *   - md 解析四件套：readText / parseFrontmatter / extractSection / hasHeading / findAll
 *   - 结构性五件套：checkFileExists / checkFrontmatterVerdict / checkRequiredSections /
 *     checkNoPlaceholders / checkReviewVerdict
 *   - 占位符检测（含代码块内 TODO 豁免）
 *   - 源码文件遍历（iterSourceFiles / countLines）
 *   - 引用 ID 提取（extractIssueIds / extractUcIds / extractTestIds / extractPLevels / extractBlockedBy）
 *
 * 设计原则（与 python 版一致）：
 *   - 零运行时依赖（纯 node:fs + RegExp）
 *   - frontmatter 只支持扁平 key:value（设计交付物 frontmatter 都是扁平的）
 *   - 失败硬阻断：toOutput 返回 passed:false，GateRunner 据此记 gate fail
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── CheckOutput（与 gates.ts 的 CheckOutput 结构兼容，单一来源） ──

export interface CheckOutput {
  passed: boolean;
  report?: string;
  /** crash / 解析失败 / 文件缺失等基础设施异常（业务 fail vs infra，#6 方案 A）。 */
  infraError?: string;
}

// ── 常量 ─────────────────────────────────────────────────────

const PASS = "✅ PASS";
const FAIL = "❌ FAIL";
const SKIP = "⏭️ SKIP";

/**
 * 占位符模式：{xxx} / {{xxx}} / TODO / TBD / FIXME / XXX（全大写独立词）。
 * 与 python _PLACEHOLDER_RE 1:1 对齐。
 *
 * python 版有 LEGIT_MARKERS 白名单（[AMBIGUOUS]/[UNRESOLVED]/[DEVIATED]），
 * 但实际未在 _is_legit_placeholder 中使用（占位符检测走 PLACEHOLDER_RE，这些
 * 方括号标记不在模式范围内）。TS 版省略该未使用常量。
 */
const PLACEHOLDER_RE =
  /\{\{[^}]+\}\}|\{[a-zA-Z_][a-zA-Z0-9_.\-]*\}|\b(TODO|TBD|FIXME|XXX)\b/g;

/** 错误清单显示截断（避免单条报错过长淹没输出）。 */
const ERROR_LIST_TRUNCATE = 5;
/** 代码块围栏成对判定基数（``` 围栏成对出现，奇数 = 在代码块内）。 */
const PAIR_BASE = 2;

// ── CheckReport ──────────────────────────────────────────────

export interface CheckResult {
  name: string;
  /** 带 emoji 的状态值（与 python CheckResult 一致，渲染 markdown 表格用）。 */
  status: typeof PASS | typeof FAIL | typeof SKIP;
  detail: string;
}

export class CheckReport {
  private readonly phase: string;
  private readonly checks: CheckResult[] = [];

  constructor(phase: string) {
    this.phase = phase;
  }

  add(result: CheckResult): void {
    this.checks.push(result);
  }

  addPass(name: string, detail = ""): void {
    this.add({ name, status: PASS, detail });
  }

  addFail(name: string, detail = ""): void {
    this.add({ name, status: FAIL, detail });
  }

  addSkip(name: string, detail = ""): void {
    this.add({ name, status: SKIP, detail });
  }

  get failed(): boolean {
    return this.checks.some((c) => c.status === FAIL);
  }

  /** 检查项总数（用于 verdict 行）。 */
  get total(): number {
    return this.checks.length;
  }

  /** 失败检查项数。 */
  get failCount(): number {
    return this.checks.filter((c) => c.status === FAIL).length;
  }

  /** stdout verdict 行（`[{phase}] machine check: N/M passed → PASS|FAIL`）。 */
  verdictLine(): string {
    const passed = this.total - this.failCount;
    return `[${this.phase}] machine check: ${passed}/${this.total} passed → ${this.failed ? "FAIL" : "PASS"}`;
  }

  /**
   * fail 项摘要（mustFix 用，Bug 3 修复）。
   *
   * verdictLine 只有汇总行（N/M passed → FAIL），agent 看不到具体哪几项挂了。本方法把所有
   * FAIL 项的 name + detail 拼成多行文本，让 handler 的 mustFix 字段带可操作信息
   * （「6 必须章节 ❌ 缺失: ["E2E"]」而非只有「machine check: 5/11 passed → FAIL」）。
   *
   * PASS/SKIP 项不列（mustFix 的语义是「需要修的」，不是「全部检查结果」）。完整含 PASS 的
   * 报告在 changes/machine-check-{phase}.md，agent 需要全量去那里看。
   */
  failSummary(): string {
    const fails = this.checks.filter((c) => c.status === FAIL);
    if (fails.length === 0) return "";
    return fails
      .map((c) => `- ${c.name}${c.detail ? `：${c.detail}` : ""}`)
      .join("\n");
  }

  /** 渲染 markdown 报告（写 changes/machine-check-{phase}.md 用）。 */
  render(): string {
    const lines = [
      "---",
      `phase: ${this.phase}`,
      `machine_check: ${this.failed ? "FAIL" : "PASS"}`,
      "---",
      "",
      `# 机器检查报告 — ${this.phase}`,
      "",
      `**Verdict:** ${this.failed ? "FAIL" : "PASS"}`,
      "",
      "| 检查项 | 结果 | 详情 |",
      "|--------|------|------|",
    ];
    for (const c of this.checks) {
      const detail = c.detail ? c.detail.replace(/\|/g, "\\|") : "";
      lines.push(`| ${c.name} | ${c.status} | ${detail} |`);
    }
    lines.push("");
    if (this.failed) {
      lines.push(
        "> ⚠️ 存在机器可证的硬伤。review subagent 必须 CHANGES_REQUESTED，不许 APPROVED（硬阻断）。",
      );
    } else {
      lines.push("> ✅ 机器检查全过。可进入 6 维 LLM 审查。");
    }
    return lines.join("\n");
  }

  /**
   * 替代 python finalize_and_exit。
   *
   * @param opts.writeReport true → 写 changes/machine-check-{phase}.md（标准 8 个 gate 脚本）
   *                         false → 不写（closeout/init 用，避免污染已清理的 changes/）
   * @param opts.topicDir    writeReport=true 时必填，报告写到 topicDir/changes/
   * @param opts.topicDir    用于写报告的基准目录
   * @returns CheckOutput（passed/report/infraError），GateRunner 直接消费
   */
  toOutput(opts: { writeReport: boolean; topicDir?: string }): CheckOutput {
    if (opts.writeReport) {
      if (!opts.topicDir) {
        return {
          passed: false,
          infraError: `toOutput(writeReport=true) requires topicDir (phase=${this.phase})`,
        };
      }
      try {
        const changesDir = join(opts.topicDir, "changes");
        mkdirSync(changesDir, { recursive: true });
        const outPath = join(changesDir, `machine-check-${this.phase}.md`);
        writeFileSync(outPath, this.render(), "utf8");
      } catch (e) {
        return {
          passed: false,
          infraError: `failed to write report: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    // fail 时 report 不只给 verdict 行（汇总），还要带 failSummary（具体哪几项挂）。
    // Bug 3 修复：旧版只有 verdictLine，handler 把它拼进 mustFix，agent 看到
    // 「machine check: 5/11 passed → FAIL」却不知道哪 6 项挂——信息链路断裂。
    // failSummary 让 mustFix 带可操作信息（如「6 必须章节：缺失: ["E2E"]」）。
    const verdict = this.verdictLine();
    const summary = this.failSummary();
    return {
      passed: !this.failed,
      report: summary ? `${verdict}\n${summary}` : verdict,
    };
  }
}

// ── Markdown / frontmatter 解析（无三方依赖） ────────────────

/** 读文件，不存在返回 ""（与 python read_text 一致）。 */
export function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as { code: string }).code === "ENOENT") {
      return "";
    }
    throw e;
  }
}

/**
 * 解析 markdown frontmatter（--- 包裹的 yaml 块）。
 *
 * 只支持扁平 key: value（设计交付物的 frontmatter 都是扁平的）。
 * 不支持嵌套/数组（backfed_from 的 `[②, ⑤]` 形式作为字符串原样保留）。
 * 与 python parse_frontmatter 1:1 对齐：跳过 # 注释行、剥离行内 ` #'` 注释、去首尾同引号。
 */
export function parseFrontmatter(mdPath: string): Record<string, string> {
  const content = readText(mdPath);
  if (!content) return {};
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m || m[1] === undefined) return {};
  const block = m[1];
  const result: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    if (!line.includes(":")) continue;
    const idx = line.indexOf(":");
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // 去行内注释（` #'` 分隔）
    if (val.includes(" #")) {
      val = val.split(" #")[0]!.trim();
    }
    // 去首尾同引号（至少 2 字符才可能成对包裹）
    const MIN_QUOTED_LEN = 2;
    if (val.length >= MIN_QUOTED_LEN && val[0] && val[0] === val[val.length - 1] && /^[\"']$/.test(val[0])) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

/**
 * 提取匹配 headingPattern 的 ##（或 ###）章节内容。
 *
 * 返回从该标题到下一个同级/更高级标题之间的内容。
 * 与 python extract_section 1:1 对齐。
 *
 * @param mdPath 文件路径
 * @param headingPattern 正则片段（匹配标题行文本，不含 ## 前缀）
 */
export function extractSection(mdPath: string, headingPattern: string): string {
  const content = readText(mdPath);
  if (!content) return "";
  const lines = content.split(/\r?\n/);
  const pattern = new RegExp(headingPattern);
  let collecting = false;
  let targetLevel = 0;
  const out: string[] = [];
  for (const line of lines) {
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      const level = hm[1]!.length;
      const title = hm[2]!;
      if (collecting && level <= targetLevel) break;
      if (!collecting && pattern.test(title)) {
        collecting = true;
        targetLevel = level;
        out.push(line);
        continue;
      }
    }
    if (collecting) out.push(line);
  }
  return out.join("\n");
}

/** 文档是否含匹配 headingPattern 的标题。 */
export function hasHeading(mdPath: string, headingPattern: string): boolean {
  const content = readText(mdPath);
  if (!content) return false;
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m && new RegExp(headingPattern).test(m[1]!)) return true;
  }
  return false;
}

/**
 * 返回文档中所有正则匹配的单捕获组内容。
 *
 * 与 python find_all 行为对齐：re.findall 单捕获组返回 group(1) 字符串列表。
 * JS 用 matchAll + 取 m[1]。
 */
export function findAll(mdPath: string, pattern: string): string[] {
  const content = readText(mdPath);
  if (!content) return [];
  const re = new RegExp(pattern, "g");
  const out: string[] = [];
  for (const m of content.matchAll(re)) {
    out.push(m[1] ?? m[0]);
  }
  return out;
}

// ── 通用检查（结构性五件套） ─────────────────────────────────

export function checkFileExists(report: CheckReport, name: string, path: string): boolean {
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    isFile = false;
  }
  if (isFile) {
    report.addPass(name, path);
    return true;
  }
  report.addFail(name, `文件不存在: ${path}`);
  return false;
}

export function checkFrontmatterVerdict(
  report: CheckReport,
  mdPath: string,
  expected = "pass",
): Record<string, string> | null {
  if (!existsSync(mdPath)) {
    report.addFail("frontmatter verdict", `文件不存在: ${mdPath}`);
    return null;
  }
  const fm = parseFrontmatter(mdPath);
  // C2: verdict 大小写不敏感（trim + toUpperCase 后比对）
  const verdict = (fm.verdict ?? "").trim().toUpperCase();
  if (verdict === expected.toUpperCase()) {
    report.addPass("frontmatter verdict", `verdict: ${fm.verdict ?? ""}`);
    return fm;
  }
  report.addFail("frontmatter verdict", `期望 verdict: ${expected}，实际: '${fm.verdict ?? ""}'（${mdPath}）`);
  return null;
}

export function checkRequiredSections(
  report: CheckReport,
  mdPath: string,
  sectionName: string,
  requiredHeadings: readonly string[],
): void {
  const missing = requiredHeadings.filter((h) => !hasHeading(mdPath, h));
  if (missing.length > 0) {
    report.addFail(sectionName, `缺失章节: ${JSON.stringify(missing)}`);
  } else {
    report.addPass(sectionName, `全部 ${requiredHeadings.length} 个必须章节存在`);
  }
}

/**
 * 检查无未替换占位符（{xxx} / TODO / TBD），合法标记除外。
 *
 * TODO/TBD/FIXME/XXX 在代码块（``` 围栏）内不算占位符（骨架代码注释）。
 * {xxx} 形式永远算未替换（模板变量）。
 */
export function checkNoPlaceholders(report: CheckReport, name: string, mdPath: string): void {
  if (!existsSync(mdPath)) {
    report.addFail(name, `文件不存在: ${mdPath}`);
    return;
  }
  const content = readText(mdPath);
  const matches = content.match(PLACEHOLDER_RE) ?? [];
  const real = matches.filter((m) => !isLegitPlaceholder(content, m));
  if (real.length > 0) {
    report.addFail(name, `发现 ${real.length} 处占位符: ${JSON.stringify(real.slice(0, ERROR_LIST_TRUNCATE))}`);
  } else {
    report.addPass(name, "无未替换占位符");
  }
}

/**
 * 判断 TODO/TBD 匹配是否在代码块内（合法上下文）。
 *
 * 代码块判定：匹配位置之前 ``` 出现次数为奇数 → 在围栏内。
 * {xxx} 形式永远算未替换（不是 TODO 类标记）。
 */
function isLegitPlaceholder(content: string, match: string): boolean {
  if (match === "TODO" || match === "TBD" || match === "FIXME" || match === "XXX") {
    const idx = content.indexOf(match);
    if (idx >= 0) {
      const before = content.slice(0, idx);
      const fenceCount = (before.match(/```/g) ?? []).length;
      // 围栏成对出现：奇数个 = 在代码块内（合法 TODO 上下文）
      if (fenceCount % PAIR_BASE === 1) return true;
    }
  }
  return false;
}

/**
 * 检查 changes/review-{phase}.md 存在且 verdict 达标。
 *
 * @param topicDir topic 目录（changes/ 的父目录）
 * @param phaseSlug review 桩 slug（如 "clarity"）
 * @param expected 期望的 verdict 值（默认 APPROVED）
 */
export function checkReviewVerdict(
  report: CheckReport,
  topicDir: string,
  phaseSlug: string,
  expected = "APPROVED",
): void {
  const reviewPath = join(topicDir, "changes", `review-${phaseSlug}.md`);
  if (!existsSync(reviewPath)) {
    report.addFail(`review-${phaseSlug} 存在`, `文件不存在: ${reviewPath}`);
    return;
  }
  const fm = parseFrontmatter(reviewPath);
  // C2: verdict 大小写不敏感（trim + toUpperCase 后比对，防 "approved"/"Approved" 静默 FAIL）
  const verdict = (fm.verdict ?? "").trim().toUpperCase();
  if (verdict === expected.toUpperCase()) {
    report.addPass(`review-${phaseSlug} verdict`, `verdict: ${fm.verdict ?? ""}`);
  } else {
    report.addFail(
      `review-${phaseSlug} verdict`,
      `期望 verdict: ${expected}，实际: '${fm.verdict ?? ""}'`,
    );
  }
}

// ── 源码文件遍历（check-code-arch / check-init 用） ──────────

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "__pycache__", ".next"]);
const DEFAULT_SOURCE_EXTS = [".ts", ".tsx", ".py", ".rs", ".js", ".jsx"] as const;

/**
 * 遍历 root 下指定扩展名的源文件（跳过 node_modules/dist/.git 等）。
 * 与 python iter_source_files 1:1 对齐。
 */
export function iterSourceFiles(
  root: string,
  exts: readonly string[] = DEFAULT_SOURCE_EXTS,
): string[] {
  const out: string[] = [];
  if (!isDir(root)) return out;
  walk(root, out, exts);
  return out;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function walk(dir: string, out: string[], exts: readonly string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        walk(full, out, exts);
      } else if (exts.some((e) => entry.name.endsWith(e))) {
        out.push(full);
      }
    } catch (e) {
      // stat 失败（symlink 等），跳过——遍历不因单个坏文件中断
      void e;
    }
  }
}

/** 文件行数（不存在返回 0）。 */
export function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  const content = readText(path);
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

// ── 引用 ID 提取（check-issues / check-nfr 用） ──────────────

/** 提取所有 issue 编号（#N 形式），返回 ['1', '3', ...]。 */
export function extractIssueIds(mdPath: string): string[] {
  return findAll(mdPath, "#(\\d+)");
}

/** 提取所有 UC 编号（UC-N 形式），返回 ['1', '2', ...]。 */
export function extractUcIds(mdPath: string): string[] {
  return findAll(mdPath, "UC-(\\d+)");
}

/** 提取所有测试用例 ID（T{UC}.{N} 形式），返回 ['1.1', '1.2', ...]。 */
export function extractTestIds(mdPath: string): string[] {
  return findAll(mdPath, "T(\\d+\\.\\d+)");
}

/**
 * 提取每个 issue 的 P 级。
 *
 * 按 `## #N` 或 `### #N` 标题分段（issue-template.md 用 2 井号，
 * deliverable-template.md 嵌套示例用 3 井号，B3 修复：原正则只匹配 2 井号
 * 导致 agent 按嵌套写则 P 级检查静默 SKIP），找段内 `**P 级**: PX`。
 * 与 python extract_p_levels 1:1 对齐（含 (?=^##\s+#\d+|\Z) 的 \Z 处理）。
 */
export function extractPLevels(mdPath: string): Record<string, string> {
  const content = readText(mdPath);
  const result: Record<string, string> = {};
  // \Z → (?![\s\S])；re.DOTALL|MULTILINE → s+m flag
  // B3: 正则 ^#{2,3}\s+#(\d+) 同时匹配 ## #N 与 ### #N（与 ISSUE_HEADING_RE 对齐）
  const re = /^#{2,3}\s+#(\d+)[^\n]*\n([\s\S]*?)(?=^#{2,3}\s+#\d+|(?![\s\S]))/gm;
  for (const m of content.matchAll(re)) {
    const issueNum = m[1]!;
    const body = m[2]!;
    const pm = body.match(/\**\s*P\s*级\s*\**\s*[:：]\s*(P[0-3])/);
    if (pm) result[issueNum] = pm[1]!;
  }
  return result;
}

/**
 * 提取每个 issue 的 blocked_by 依赖。
 *
 * 返回 { issue_num: ['2', '3'] }（去自引用）。
 * 与 python extract_blocked_by 1:1 对齐。
 * B3: 正则 ^#{2,3}\s+#(\d+) 同时匹配 ## #N 与 ### #N（与 ISSUE_HEADING_RE 对齐）。
 */
export function extractBlockedBy(mdPath: string): Record<string, string[]> {
  const content = readText(mdPath);
  const result: Record<string, string[]> = {};
  const re = /^#{2,3}\s+#(\d+)[^\n]*\n([\s\S]*?)(?=^#{2,3}\s+#\d+|(?![\s\S]))/gm;
  for (const m of content.matchAll(re)) {
    const issueNum = m[1]!;
    const body = m[2]!;
    const bm = body.match(/\**\s*[Bb]locked\s*by\s*\**\s*[:：]\s*([^\n]+)/);
    if (bm) {
      const deps = (bm[1]!.match(/\d+/g) ?? []).filter((d) => d !== issueNum);
      result[issueNum] = deps;
    } else {
      result[issueNum] = [];
    }
  }
  return result;
}

// ── 共享常量（供各 check 脚本复用） ──────────────────────────

/**
 * issue 分段正则片段（提取 `## #N` 或 `### #N` 标题定义的「真 issue」）。
 * 区分表格引用（行中 #N）和标题定义（行首 ## #N）。
 *
 * 用法：`new RegExp(ISSUE_HEADING_RE)` 或 findAll(mdPath, ISSUE_HEADING_RE)。
 */
export const ISSUE_HEADING_RE = "^#{2,3}\\s+#(\\d+)";

/**
 * 从 topicDir 推算 project_root（`.xyz-harness` 上层）。check-closeout 用。
 *
 * topicDir 由 create.ts 算好存入 CwTopic（= workspacePath/.xyz-harness/{slug}），
 * ROOT-01 修复后永远含 `.xyz-harness` 段，走 if 分支正确取项目根。
 *
 * fallback（topicDir 不含 `.xyz-harness`，如旧库迁移、自定义路径）修法（RESOLVE-PROJECTROOT-01）：
 * 原实现 `return dirname(topicDir)` 在 topicDir=<project_root> 时返回其**父目录**（错误），
 * 与注释承诺的「topicDir 可能就是 project_root」矛盾。改为返回 topicDir 本身——
 * topicDir 不含 `.xyz-harness` 时，它本身就是 project_root 的合理推测（向上找祖先不可靠，
 * 且 check-closeout 的 findDoc 会兜底 statSync 校验文件是否存在）。
 */
export function resolveProjectRoot(topicDir: string): string {
  if (topicDir.includes(".xyz-harness")) {
    const idx = topicDir.indexOf(".xyz-harness");
    const root = topicDir.slice(0, idx).replace(/\/+$/, "");
    return root || "/";
  }
  // fallback：topicDir 不含 .xyz-harness 时，视为 project_root 本身（非其父目录）。
  return topicDir.replace(/\/+$/, "");
}

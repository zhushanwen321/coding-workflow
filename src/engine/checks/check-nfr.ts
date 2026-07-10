/**
 * full-nfr（④非功能性设计）硬规则机器验证。
 *
 * 移植自 skills/full-nfr/scripts/check_nfr.py。
 * 入参：topicDir（含 non-functional-design.md + changes/review-nfr.md + issues.md）。
 *
 * 检查项：
 *   ①结构性：交付物存在 / verdict:pass / 关键章节 / 无占位符 / review-nfr APPROVED
 *   ②引用：
 *     - 缓解项回灌表每行有「验收方式」列且值 ∈ {代码测试, 骨架约束, 性能混沌, 运维项}
 *     - 无 ❌（不可接受）项残留
 *     - 回灌表「回灌去向=③issue」的行，#N 真实存在于 issues.md（PHANTOM 形式检查）
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { extractRealIssueIds } from "./check-issues.js";
import {
  checkFileExists,
  checkFrontmatterVerdict,
  checkNoPlaceholders,
  type CheckOutput,
  CheckReport,
  checkRequiredSections,
  checkReviewVerdict,
  extractSection,
  readText,
} from "./shared.js";

const DELIVERABLE = "non-functional-design.md";
const VALID_ACCEPTANCE = new Set(["代码测试", "骨架约束", "性能混沌", "运维项"]);
/** 报错清单截断（避免单条报错过长）。 */
const ERR_LIST_MAX = 5;

export function runCheckNfr(topicDir: string): CheckOutput {
  const report = new CheckReport("nfr");
  const mdPath = join(topicDir, DELIVERABLE);

  // ① 结构性
  if (!checkFileExists(report, `${DELIVERABLE} 存在`, mdPath)) {
    return report.toOutput({ writeReport: true, topicDir });
  }
  checkFrontmatterVerdict(report, mdPath, "pass");
  checkRequiredSections(report, mdPath, "关键章节", [
    "分析矩阵|风险矩阵",
    "缓解项回灌|Mitigation",
  ]);
  checkNoPlaceholders(report, "无占位符", mdPath);
  checkReviewVerdict(report, topicDir, "nfr", "APPROVED");

  // ② 缓解项回灌表每行有验收方式列且值合法
  const mitigationSection = extractSection(mdPath, "缓解项回灌|Mitigation");
  if (mitigationSection) {
    // 提取表格行（含「验收方式」列，跳过表头和分隔行）
    const tableRows = mitigationSection
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith("|") && !l.includes("----") && !l.includes("验收方式"));
    if (tableRows.length > 0) {
      const invalidAcceptance: string[] = [];
      for (const row of tableRows) {
        const cells = row.split("|").slice(1, -1).map((c) => c.trim());
        // 找验收方式列（倒数第2列）
        const MIN_NFR_TABLE_CELLS = 2;
        if (cells.length >= MIN_NFR_TABLE_CELLS) {
          const acceptance = cells[cells.length - MIN_NFR_TABLE_CELLS] ?? "";
          const matched = [...VALID_ACCEPTANCE].filter((v) => acceptance.includes(v));
          if (matched.length === 0) {
            invalidAcceptance.push(`'${acceptance}'`);
          }
        }
      }
      if (invalidAcceptance.length > 0) {
        report.addFail(
          "验收方式列合法",
          `${invalidAcceptance.length} 行验收方式不合法: ${JSON.stringify(invalidAcceptance.slice(0, ERR_LIST_MAX))}` +
            `（应 ∈ ${JSON.stringify([...VALID_ACCEPTANCE])}）` +
            `。期望格式：缓解项回灌表「验收方式」列填 代码测试 / 骨架约束 / 性能混沌 / 运维项 之一（四选一，见模板「验收方式取值」表）；` +
            `修复建议：校验/拦截/降级类填「代码测试」，签名/字段/锁存在性填「骨架约束」，压测/混沌 SLA 填「性能混沌」，纯部署配置填「运维项」`,
        );
      } else {
        report.addPass("验收方式列合法", `${tableRows.length} 行缓解项均标了合法验收方式`);
      }
    } else {
      report.addFail("缓解项回灌表", "缓解项回灌章节无表格行");
    }
  } else {
    report.addFail("缓解项回灌表", "无「缓解项回灌登记」章节（MANDATORY）");
  }

  // ② 无 ❌（不可接受）项残留
  //
  // nfr 模板自身含合法 ❌ 字符（B1 修复）：
  //   - 图例行：`（✅ 无风险 / ⚠️ 有风险已缓解 / ❌ 不可接受需回退 / — 不适用+理由）`
  //   - 回灌指针表说明行：`❌ ⑤还没写，查不了` / `❌ ⑥还没编排，查不了`（延期承诺标记）
  // 全文 grep ❌ 会误伤这些合法说明行，导致 agent 保留模板图例就 FAIL。
  //
  // 过滤策略（按行扫描，跳过说明性 ❌）：
  //   1. 图例行：同一行同时含 ✅ 和 ⚠️（4 个状态符号并列）→ 跳过
  //   2. 回灌指针表延期承诺说明：含「还没」/「查不了」→ 跳过
  //   3. 元描述（描述 ❌ 自身含义）：含「无风险」/「有风险已缓解」/「不适用」/
  //      「不残留」/「不可接受需回退」→ 跳过
  //   4. 兜底原过滤：「无 ❌」前缀（如"无 ❌ 项"）→ 跳过
  const content = readText(mdPath);
  const realUnacceptable: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.includes("❌")) continue;
    // 图例行（4 状态符号并列）
    if (rawLine.includes("✅") && rawLine.includes("⚠️")) continue;
    // 回灌指针表延期承诺说明
    if (rawLine.includes("还没") || rawLine.includes("查不了")) continue;
    // 元描述：解释 ❌ 含义的说明文字
    if (
      rawLine.includes("无风险") ||
      rawLine.includes("有风险已缓解") ||
      rawLine.includes("不适用") ||
      rawLine.includes("不残留") ||
      rawLine.includes("不可接受需回退")
    ) {
      continue;
    }
    // 兜底原过滤：「无 ❌」前缀（如"无 ❌ 项"）
    // 「无 ❌」前缀检测窗口（向前看 3 字符容纳「无 ❌」及混合空白）
    const PREFIX_WINDOW = 3;
    const idx = rawLine.indexOf("❌");
    const before = rawLine.slice(Math.max(0, idx - PREFIX_WINDOW), idx);
    if (before.includes("无")) continue;
    realUnacceptable.push(rawLine.trim());
  }
  if (realUnacceptable.length > 0) {
    report.addFail(
      "无 ❌ 不可接受项",
      `残留 ${realUnacceptable.length} 处 ❌（不可接受项应已回 Step 3 重选方案）: ${JSON.stringify(realUnacceptable.slice(0, ERR_LIST_MAX))}` +
        `。❌ 必须在 ③issues 前置阶段消解（重选方案或降级风险），不可残留到 ④detail gate；` +
        `修复建议：回 issues.md 对应 issue 补「方案 A/方案 B」对比重选，或在本表「残余风险登记」登记接受理由并改标 ⚠️`,
    );
  } else {
    report.addPass("无 ❌ 不可接受项", "无不可接受项残留");
  }

  // ③ 回灌指针 PHANTOM 形式检查
  if (mitigationSection) {
    checkBackfeedPhantom(report, topicDir, mitigationSection);
  }

  return report.toOutput({ writeReport: true, topicDir });
}

/**
 * 回灌指针 PHANTOM 形式检查。
 *
 * 回灌表「回灌去向=③issue」的行，提取 #N，核对是否在 issues.md 的 issue 定义里真实存在。
 * 机器只查 PHANTOM（指针断裂）；MISMATCH（属性不符）+ ORPHAN 靠 Step2 重建器。
 * issues.md 不存在时降级为 SKIP。
 */
function checkBackfeedPhantom(
  report: CheckReport,
  topicDir: string,
  mitigationSection: string,
): void {
  const issuesPath = join(topicDir, "issues.md");
  if (!existsSync(issuesPath)) {
    report.addSkip(
      "回灌③指针 PHANTOM",
      "issues.md 不存在，跳过（MISMATCH/ORPHAN 仍由 Step2 重建器查）",
    );
    return;
  }

  const issuesContent = readText(issuesPath);
  const realIssueIds = new Set(extractRealIssueIds(issuesContent));

  // 从回灌表提取「回灌去向」含 ③/issue 的行里的 #N 引用
  const tableRows = mitigationSection
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("|") && !l.includes("----"));
  const phantomRefs: string[] = [];
  let checked = 0;
  for (const row of tableRows) {
    const cells = row.split("|").slice(1, -1).map((c) => c.trim());
    // 跳过「回灌去向」表头行
    if (cells.some((c) => c.includes("回灌去向") || c.includes("去向"))) continue;
    // 只看声明指向 ③ 的行（回灌去向列含「③」或「issue」且含 #N）
    const targets3 = cells.filter(
      (c) => (c.includes("③") || c.toLowerCase().includes("issue")) && /#\d+/.test(c),
    );
    for (const cell of targets3) {
      for (const m of cell.matchAll(/#(\d+)/g)) {
        checked++;
        const ref = m[1]!;
        if (!realIssueIds.has(ref)) {
          phantomRefs.push(`#${ref}`);
        }
      }
    }
  }

  if (phantomRefs.length > 0) {
    report.addFail(
      "回灌③指针 PHANTOM",
      `${phantomRefs.length} 处回灌指针指向不存在的 issue: ${JSON.stringify(phantomRefs.slice(0, ERR_LIST_MAX))}（issues.md 无此编号）` +
        `。期望格式：回灌表「回灌去向=③issue」的行写 #issue-id（如 #7），且 issues.md 中必须存在对应 ## #N 标题定义；` +
        `修复建议：补建缺失的 issue（带 ## #N 标题 + P 级 + 方案对比），或修正指针指向已存在的编号`,
    );
  } else if (checked > 0) {
    report.addPass("回灌③指针 PHANTOM", `${checked} 处回灌③指针均指向真实存在的 issue`);
  } else {
    report.addSkip("回灌③指针 PHANTOM", "回灌表无指向 ③issue 的行（可能全去⑤/运维项）");
  }
}

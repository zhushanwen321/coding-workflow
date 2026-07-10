/**
 * full-issues（③Issue 拆分）硬规则机器验证。
 *
 * 移植自 skills/full-issues/scripts/check_issues.py。
 * 入参：topicDir（含 issues.md + changes/review-issues.md）。
 *
 * 检查项：
 *   ①结构性：交付物存在 / verdict:pass / 关键章节 / 无占位符 / review-issues APPROVED
 *   ②引用：P0/P1 issue ≥2 方案对比 / blocked_by 无幽灵依赖 / P 级一致性
 *   ③覆盖核验表（形式）：表存在、每行有 #issue 或 N/A+理由、无 ❌ 待补残留
 */

import { join } from "node:path";

import {
  checkFileExists,
  checkFrontmatterVerdict,
  checkNoPlaceholders,
  type CheckOutput,
  CheckReport,
  checkRequiredSections,
  checkReviewVerdict,
  extractBlockedBy,
  extractIssueIds,
  extractPLevels,
  extractSection,
  readText,
} from "./shared.js";

const DELIVERABLE = "issues.md";

export function runCheckIssues(topicDir: string): CheckOutput {
  const report = new CheckReport("issues");
  const mdPath = join(topicDir, DELIVERABLE);

  // ① 结构性
  if (!checkFileExists(report, `${DELIVERABLE} 存在`, mdPath)) {
    return report.toOutput({ writeReport: true, topicDir });
  }
  checkFrontmatterVerdict(report, mdPath, "pass");
  checkRequiredSections(report, mdPath, "关键章节", [
    "地图总览|DAG|决策图",
    "#\\d+|[Ii]ssue",
  ]);
  checkNoPlaceholders(report, "无占位符", mdPath);
  checkReviewVerdict(report, topicDir, "issues", "APPROVED");

  // ② P0/P1 issue 有 ≥2 方案对比
  const pLevels = extractPLevels(mdPath);
  const content = readText(mdPath);
  const insufficientSolutions: string[] = [];
  // 精确匹配 ## #N 或 ### #N 标题分段（\Z → (?![\s\S])；DOTALL|MULTILINE → gs flag）
  // B3: 正则 ^#{2,3}\s+#(\d+) 同时匹配 ## #N 与 ### #N（与 ISSUE_HEADING_RE 对齐）
  const issueSegmentRe = /^#{2,3}\s+#(\d+)[^\n]*\n([\s\S]*?)(?=^#{2,3}\s+#\d+|(?![\s\S]))/gm;
  for (const m of content.matchAll(issueSegmentRe)) {
    const issueNum = m[1]!;
    const body = m[2]!;
    const level = pLevels[issueNum];
    if (level === "P0" || level === "P1") {
      const solutionCount = (body.match(/方案\s*[A-Z]|####\s*方案/g) ?? []).length;
      const MIN_SOLUTIONS_FOR_P0P1 = 2; // P0/P1 issue 至少 2 方案对比
      if (solutionCount < MIN_SOLUTIONS_FOR_P0P1) {
        insufficientSolutions.push(`#${issueNum}(${level}): 仅 ${solutionCount} 方案`);
      }
    }
  }
  if (insufficientSolutions.length > 0) {
    report.addFail(
      "P0/P1 issue ≥2 方案对比",
      `${insufficientSolutions.join("; ")}。期望格式：P0/P1 issue 段内含 ≥2 个方案对比（#### 方案 A / #### 方案 B，参考 issue-template.md「方案对比」章节）；` +
        `修复建议：补 #### 方案 B（含改动/优点/缺点/适用场景），与方案 A 横向对比后给「取舍决策」`,
    );
  } else if (Object.keys(pLevels).length > 0) {
    report.addPass("P0/P1 issue ≥2 方案对比", "全部 P0/P1 issue 有 ≥2 方案");
  } else {
    report.addSkip("P0/P1 issue ≥2 方案对比", "无 P0/P1 issue");
  }

  // ② blocked_by 引用的 issue 都存在（无幽灵依赖）
  const allIssueIds = new Set(extractIssueIds(mdPath));
  const blockedBy = extractBlockedBy(mdPath);
  const ghostDeps: string[] = [];
  for (const [issueNum, deps] of Object.entries(blockedBy)) {
    for (const dep of deps) {
      if (!allIssueIds.has(dep)) {
        ghostDeps.push(`#${issueNum} blocked_by #${dep}（#${dep} 不存在）`);
      }
    }
  }
  if (ghostDeps.length > 0) {
    report.addFail(
      "blocked_by 无幽灵依赖",
      `${ghostDeps.join("; ")}。期望格式：**Blocked by**: #N, #M（N/M 必须是 issues.md 内 ## #N 标题定义的真实编号，无依赖写「无」）；` +
        `修复建议：补建缺失的 issue（## #N 标题 + P 级 + 方案对比），或修正引用指向已存在的编号`,
    );
  } else {
    report.addPass("blocked_by 无幽灵依赖", "所有 blocked_by 引用都存在");
  }

  // ② P 级一致性：P0 不 blocked_by P2/P3（高优先级不应依赖低优先级）
  const levelOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const levelViolations: string[] = [];
  for (const [issueNum, deps] of Object.entries(blockedBy)) {
    const myLevel = pLevels[issueNum];
    if (myLevel === undefined || !(myLevel in levelOrder)) continue;
    for (const dep of deps) {
      const depLevel = pLevels[dep];
      if (depLevel !== undefined && depLevel in levelOrder) {
        if (levelOrder[myLevel]! < levelOrder[depLevel]!) {
          levelViolations.push(`#${issueNum}(${myLevel}) blocked_by #${dep}(${depLevel})`);
        }
      }
    }
  }
  if (levelViolations.length > 0) {
    report.addFail(
      "P 级一致性",
      `${levelViolations.join("; ")}（高优先级不应依赖低优先级）` +
        `。期望格式：**P 级**: P0/P1/P2/P3（MoSCoW 语义，P0 阻塞项→最前 Wave 无依赖前置，P1→依赖 P0，P2/P3 可后置）；` +
        `修复建议：下调被依赖项的 P 级至 ≤ 依赖方（如 P0 依赖的项不得为 P2/P3），或拆出 P0 子项先行解决`,
    );
  } else {
    report.addPass("P 级一致性", "P 级与 blocked_by 一致");
  }

  // ③ 覆盖核验表形式检查
  // 真 issue 定义 = 出现在 ## #N / ### #N 标题里的编号（非表格引用）
  const realIssueIds = new Set(extractRealIssueIds(content));
  checkCoverageTable(report, mdPath, realIssueIds);

  return report.toOutput({ writeReport: true, topicDir });
}

/**
 * 提取「真 issue 定义」编号：`^#{2,3}\s+#(\d+)` 标题里的 #N。
 * 区分表格引用（行中 #N）和标题定义（行首 ## #N）。
 */
export function extractRealIssueIds(content: string): string[] {
  const re = /^#{2,3}\s+#(\d+)/gm;
  const out: string[] = [];
  for (const m of content.matchAll(re)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/**
 * 覆盖核验表形式检查。
 *
 * 只验形式——查不了漏行/虚标/弱理由（实质靠 Step2 独立重建）。
 * realIssueIds = 从 ## #N / ### #N 章节标题提取的「真 issue 定义」编号集合。
 */
function checkCoverageTable(
  report: CheckReport,
  mdPath: string,
  realIssueIds: Set<string>,
): void {
  const section = extractSection(mdPath, "上游覆盖核验");
  if (!section) {
    report.addFail("覆盖核验表存在", "缺「上游覆盖核验」章节（MANDATORY）");
    return;
  }

  const lines = section.split(/\r?\n/).filter((ln) => ln.trim().startsWith("|"));
  let issueCol: number | null = null;
  let statusCol: number | null = null;
  let reasonCol: number | null = null;
  const dataRows: string[][] = [];

  for (const s of lines) {
    // 分隔行（纯 -/: 组合）
    if (/^\|[\s:|-]+\|?$/.test(s.trim())) continue;
    const cells = s.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.length > 0 && cells[0] === "上游元素") {
      // 表头
      for (let idx = 0; idx < cells.length; idx++) {
        const c = cells[idx]!;
        const low = c.toLowerCase();
        if (issueCol === null && (low.includes("issue") || c.includes("对应"))) issueCol = idx;
        if (statusCol === null && c === "状态") statusCol = idx;
        if (reasonCol === null && (c.includes("理由") || (low.includes("n/a") && c.includes("理由")))) {
          reasonCol = idx;
        }
      }
      continue;
    }
    dataRows.push(cells);
  }

  if (dataRows.length === 0) {
    report.addFail("覆盖核验表存在", "「上游覆盖核验」章节无数据行（至少 1 行）");
    return;
  }

  /** 单元格是否为空理由：— / - / 空 / 裸 N/A。 */
  const isEmpty = (cell: string): boolean => cell.replace(/[—\-\sN/A/]/gi, "").length === 0;

  const problems: string[] = [];
  const pendingRows: string[] = [];
  dataRows.forEach((cells, i) => {
    const row = cells.join(" | ");
    // 残留 ❌ 待补 = 终稿硬伤
    if (row.includes("❌") || row.includes("待补")) {
      pendingRows.push(`行${i + 1}: ${row}`);
      return;
    }

    const issueCell = issueCol !== null && issueCol < cells.length ? cells[issueCol]! : "";
    const statusCell = statusCol !== null && statusCol < cells.length ? cells[statusCol]! : "";
    const reasonCell = reasonCol !== null && reasonCol < cells.length ? cells[reasonCol]! : "";

    // 全行搜 #issue 号
    const issueRefs = cells.join(" ").match(/#(\d+)/g) ?? [];
    const issueRefNums = issueRefs.map((r) => r.slice(1));
    const isNa = statusCell.includes("N/A") || issueCell.includes("N/A") || row.includes("N/A");

    if (issueRefNums.length === 0 && !isNa) {
      problems.push(`行${i + 1}: 既无 #issue 也无 N/A — ${row}`);
      return;
    }

    // N/A 行（无 issue）必须带实质理由
    if (isNa && issueRefNums.length === 0) {
      if (isEmpty(reasonCell)) {
        problems.push(`行${i + 1}: N/A 无理由（理由列须写一句话）— ${row}`);
      }
    }

    // 有 #issue 但指向不存在的编号 → 幽灵
    for (const ref of issueRefNums) {
      if (!realIssueIds.has(ref)) {
        problems.push(`行${i + 1}: #${ref} 不存在（幽灵引用）— ${row}`);
      }
    }
  });

  if (pendingRows.length > 0) {
    report.addFail(
      "覆盖核验表无待补残留",
      `${pendingRows.join("; ")}（终稿前必须转 ✅ 或 N/A）`,
    );
  } else if (problems.length > 0) {
    report.addFail("覆盖核验表形式", problems.join("; "));
  } else {
    report.addPass(
      "覆盖核验表形式",
      `${dataRows.length} 行，每行有 #issue 或 N/A+理由，无待补残留`,
    );
  }
}

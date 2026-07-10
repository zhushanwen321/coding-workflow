/**
 * coding-closeout（设计收尾）硬规则机器验证。
 *
 * 移植自 skills/coding-closeout/scripts/check_closeout.py。
 * 入参：topicDir（含 ARCHIVED.md + closeout-report.md；project_root = .xyz-harness 上层）。
 *
 * 检查项：
 *   ①归档完整性：ARCHIVED.md + closeout-report.md 存在；ARCHIVED.md 提及去向文档
 *     （PRODUCT/ARCHITECTURE/NFR/TEST-STRATEGY/CONTEXT/ADR）
 *   ②溯源：去向文档含 [from: {topic}]（在 project_root/ 或 docs/ 找，ADR 扫 adr 目录所有 .md）
 *   ③NFR 验证字段：按 ### [A-Z]-\d+ 分块 NFR.md，过滤含本次溯源的块，每块须有「验证」
 *   ④UNVERIFIED 一致性：closeout-report.md frontmatter unverified_count == 文中非标题行 [UNVERIFIED] 数
 *   ⑤DESIGN-LOG.md 中该 topic 行状态含 archived
 *   ⑥清理：changes/ 已空 + 无 .html（SKIP 不阻断）
 *
 * 注意：不写 changes/machine-check-closeout.md（closeout 不走 review gate，且 changes/ 应已清理）。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import {
  type CheckOutput,
  CheckReport,
  parseFrontmatter,
  readText,
  resolveProjectRoot,
} from "./shared.js";

/** 可能的沉淀去向文档（ADR 单独处理，因其在子目录）。 */
const DOC_NAMES = ["PRODUCT.md", "ARCHITECTURE.md", "NFR.md", "TEST-STRATEGY.md", "CONTEXT.md"];

/** 在 project_root/ 或 project_root/docs/ 找文档，返回路径或 null。 */
function findDoc(projectRoot: string, name: string): string | null {
  for (const c of [join(projectRoot, name), join(projectRoot, "docs", name)]) {
    try {
      if (statSync(c).isFile()) return c;
    } catch (e) {
      /* not found */
      void e;
    }
  }
  return null;
}

/** 找 ADR 目录（docs/adr 或 adr），返回路径或 null。 */
function findAdrDir(projectRoot: string): string | null {
  for (const c of [join(projectRoot, "docs", "adr"), join(projectRoot, "adr")]) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch (e) {
      /* not found */
      void e;
    }
  }
  return null;
}

export function runCheckCloseout(topicDir: string): CheckOutput {
  const report = new CheckReport("closeout");
  const topic = basename(topicDir.replace(/\/+$/, ""));
  const projectRoot = resolveProjectRoot(topicDir);

  const archivedPath = join(topicDir, "ARCHIVED.md");
  const reportPath = join(topicDir, "closeout-report.md");
  const trace = `[from: ${topic}`;

  // ① 归档完整性：ARCHIVED.md / closeout-report.md 存在
  if (existsSync(archivedPath)) {
    report.addPass("ARCHIVED.md 存在", archivedPath);
  } else {
    report.addFail("ARCHIVED.md 存在", `文件不存在: ${archivedPath}`);
  }
  if (existsSync(reportPath)) {
    report.addPass("closeout-report.md 存在", reportPath);
  } else {
    report.addFail("closeout-report.md 存在", `文件不存在: ${reportPath}`);
  }

  // ①b ARCHIVED.md 去向清单
  const archivedContent = readText(archivedPath);
  const mentioned = DOC_NAMES.filter((d) => archivedContent.includes(d));
  const adrMentioned = archivedContent.includes("ADR");
  if (mentioned.length > 0 || adrMentioned) {
    const listed = [...mentioned, ...(adrMentioned ? ["ADR"] : [])];
    report.addPass("ARCHIVED.md 去向清单", `列出 ${JSON.stringify(listed)}`);
  } else {
    report.addFail("ARCHIVED.md 去向清单", "未列出任何沉淀去向文档");
  }

  // ② 溯源：去向文档含 [from: {topic}]
  let checkedAny = false;
  for (const docName of DOC_NAMES) {
    if (!archivedContent.includes(docName)) continue;
    checkedAny = true;
    const docPath = findDoc(projectRoot, docName);
    if (!docPath) {
      report.addSkip(`溯源 ${docName}`, `${docName} 不存在（未沉淀到此？）`);
    } else if (readText(docPath).includes(trace)) {
      report.addPass(`溯源 ${docName}`, `含 ${trace}...]`);
    } else {
      report.addFail(`溯源 ${docName}`, `${docPath} 缺 ${trace}...]`);
    }
  }
  if (adrMentioned) {
    checkedAny = true;
    const adrDir = findAdrDir(projectRoot);
    if (!adrDir) {
      report.addSkip("溯源 ADR", "无 adr 目录");
    } else {
      const found = readdirSync(adrDir)
        .filter((f) => f.endsWith(".md"))
        .some((f) => readText(join(adrDir, f)).includes(trace));
      if (found) {
        report.addPass("溯源 ADR", `存在含 ${trace}...]`);
      } else {
        report.addFail("溯源 ADR", `${adrDir} 无 ADR 含 ${trace}...]`);
      }
    }
  }
  if (!checkedAny) {
    report.addSkip("溯源检查", "ARCHIVED.md 未列具体去向文档");
  }

  // ③ NFR 约束验证字段（本次沉淀的约束必须有「验证」）
  const nfrPath = findDoc(projectRoot, "NFR.md");
  if (nfrPath) {
    const nfrContent = readText(nfrPath);
    // 按 ### 约束标题分段，过滤含本次溯源的块
    const parts = nfrContent.split(/\n(?=###\s+[A-Z]-\d+)/);
    const topicBlocks = parts.filter((p) => p.includes(trace));
    if (topicBlocks.length > 0) {
      const missing: string[] = [];
      for (const p of topicBlocks) {
        const m = p.match(/###\s+([A-Z]-\d+)/);
        if (m && !p.includes("验证")) missing.push(m[1]!);
      }
      if (missing.length > 0) {
        report.addFail("NFR 约束验证字段", `缺验证: ${JSON.stringify(missing)}`);
      } else {
        report.addPass("NFR 约束验证字段", `${topicBlocks.length} 条约束均有验证字段`);
      }
    } else {
      report.addSkip("NFR 约束验证字段", "NFR.md 无本次 topic 沉淀");
    }
  } else {
    report.addSkip("NFR 约束验证字段", "无 NFR.md");
  }

  // ④ UNVERIFIED 一致性
  if (existsSync(reportPath)) {
    const fm = parseFrontmatter(reportPath);
    const parsed = Number.parseInt((fm.unverified_count ?? "0") || "0", 10);
    const fmCount = Number.isNaN(parsed) ? -1 : parsed;
    const nonHeading = readText(reportPath)
      .split(/\r?\n/)
      .filter((l) => !l.trimStart().startsWith("#"));
    const actual = nonHeading.reduce((sum, l) => sum + l.split("[UNVERIFIED]").length - 1, 0);
    if (fmCount === actual) {
      report.addPass("UNVERIFIED 一致性", `frontmatter ${fmCount} = 文中 ${actual}`);
    } else {
      report.addFail(
        "UNVERIFIED 一致性",
        `frontmatter unverified_count=${fmCount} ≠ 文中 ${actual}`,
      );
    }
  } else {
    report.addSkip("UNVERIFIED 一致性", "无 closeout-report.md");
  }

  // ⑤ DESIGN-LOG 状态
  const logPath = findDoc(projectRoot, "DESIGN-LOG.md");
  if (logPath) {
    const logLines = readText(logPath)
      .split(/\r?\n/)
      .filter((l) => l.includes(topic));
    if (logLines.length === 0) {
      report.addFail("DESIGN-LOG 状态", `无 ${topic} 行`);
    } else if (logLines.some((l) => l.toLowerCase().includes("archived"))) {
      report.addPass("DESIGN-LOG 状态", "topic 行状态 archived");
    } else {
      report.addFail("DESIGN-LOG 状态", `未标 archived: ${logLines[0]!.trim()}`);
    }
  } else {
    report.addSkip("DESIGN-LOG 状态", "无 DESIGN-LOG.md");
  }

  // ⑥ 清理（警告级 SKIP，不阻断）
  const changesDir = join(topicDir, "changes");
  let changesLeft: string[] = [];
  try {
    changesLeft = readdirSync(changesDir);
  } catch {
    changesLeft = [];
  }
  if (changesLeft.length === 0) {
    report.addPass("changes/ 已清理", "changes/ 不存在或空");
  } else {
    report.addSkip("changes/ 已清理", `仍有 ${changesLeft.length} 项（建议清理过程产物）`);
  }
  const htmlFiles = readdirSync(topicDir).filter((f) => f.endsWith(".html"));
  if (htmlFiles.length === 0) {
    report.addPass("*.html 已清理", "无 .html");
  } else {
    report.addSkip("*.html 已清理", `仍有 ${htmlFiles.length} 个（可重新生成）`);
  }

  // 不写 machine-check 报告文件（避免污染已清理的 changes/）
  return report.toOutput({ writeReport: false });
}

/**
 * full-clarity（①需求澄清）硬规则机器验证。
 *
 * 移植自 skills/full-clarity/scripts/check_clarity.py。
 * 入参：topicDir（含 requirements.md + changes/review-clarity.md）。
 *
 * 检查项（①结构性）：
 *   - requirements.md 存在
 *   - frontmatter verdict: pass
 *   - 关键章节（业务目标 / 业务用例 / 数据流转 / 约束）
 *   - 无未替换占位符
 *   - review-clarity.md verdict: APPROVED
 *   - 每 UC 有 ≥1 条 AC
 *   - 未含系统实现（无 API/数据库 schema——①铁律）
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
  findAll,
} from "./shared.js";

const DELIVERABLE = "requirements.md";

export function runCheckClarity(topicDir: string): CheckOutput {
  const report = new CheckReport("clarity");
  const mdPath = join(topicDir, DELIVERABLE);

  // ① 结构性：交付物存在（不存在则提前返回，后续检查无意义）
  if (!checkFileExists(report, `${DELIVERABLE} 存在`, mdPath)) {
    return report.toOutput({ writeReport: true, topicDir });
  }

  // ① 结构性：frontmatter verdict
  checkFrontmatterVerdict(report, mdPath, "pass");

  // ① 结构性：关键章节
  checkRequiredSections(report, mdPath, "关键章节", [
    "业务目标|Business Goals",
    "业务用例|Use Case",
    "数据流转|Data Flow",
    "约束|Constraints",
  ]);

  // ① 结构性：无占位符
  checkNoPlaceholders(report, "无占位符", mdPath);

  // ① 结构性：review-clarity.md verdict
  checkReviewVerdict(report, topicDir, "clarity", "APPROVED");

  // ② 业务约束：每 UC 有 ≥1 条 AC
  const ucIds = new Set(findAll(mdPath, "UC-(\\d+)"));
  const acIds = new Set(findAll(mdPath, "AC-(\\d+\\.\\d+)"));
  if (ucIds.size > 0) {
    const ucsWithAc = new Set<string>();
    for (const ac of acIds) {
      const ucNum = ac.split(".")[0];
      if (ucNum) ucsWithAc.add(ucNum);
    }
    const missingAc = [...ucIds].filter((uc) => !ucsWithAc.has(uc));
    if (missingAc.length > 0) {
      report.addFail(
        "每 UC 有 ≥1 条 AC",
        `UC ${JSON.stringify(missingAc.sort((a, b) => Number(a) - Number(b)))} 无对应 AC`,
      );
    } else {
      report.addPass("每 UC 有 ≥1 条 AC", `${ucIds.size} 个 UC 均有 AC`);
    }
  } else {
    report.addSkip("每 UC 有 ≥1 条 AC", "无 UC（可能未到用例建模）");
  }

  // ② 业务约束：未含系统实现（①铁律——不应有 API 契约/数据库 schema）
  const implMarkers: string[] = [];
  const patterns: Array<[string, string]> = [
    ["数据库\\s*schema|database\\s*schema|CREATE\\s+TABLE", "数据库schema"],
    ["API\\s*(契约|contract|签名|signature)", "API契约"],
  ];
  for (const [pat, label] of patterns) {
    if (findAll(mdPath, pat).length > 0) {
      implMarkers.push(label);
    }
  }
  if (implMarkers.length > 0) {
    report.addFail(
      "未含系统实现（①铁律）",
      `发现系统实现内容: ${JSON.stringify(implMarkers)}（属 Step 2-5，①不应出现）`,
    );
  } else {
    report.addPass("未含系统实现（①铁律）", "无 API/DB schema 越界内容");
  }

  return report.toOutput({ writeReport: true, topicDir });
}

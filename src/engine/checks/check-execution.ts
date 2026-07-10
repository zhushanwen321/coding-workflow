/**
 * full-execution-plan（⑥执行计划）硬规则机器验证。
 *
 * 移植自 skills/full-execution-plan/scripts/check_execution.py。
 * 入参：topicDir（含 execution-plan.md + changes/review-execution.md）。
 *
 * 检查项：
 *   ①结构性：交付物存在 / verdict:pass / 关键章节 / 无占位符 / review-execution APPROVED
 *           consistency-final.md 存在且 verdict: CONSISTENT（Step 6c 总闸门）
 *   ②引用：测试验收清单用例 ID 集合 == ⑤test-matrix 全量（集合相等）
 *
 * 与 python 版差异：忽略 --no-consistency-final（CW gate 总是跑全量，6c 总闸门必检）。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  checkFileExists,
  checkFrontmatterVerdict,
  checkNoPlaceholders,
  type CheckOutput,
  CheckReport,
  checkRequiredSections,
  checkReviewVerdict,
  extractSection,
  parseFrontmatter,
} from "./shared.js";

const DELIVERABLE = "execution-plan.md";
// FAIL 报错清单截断上限（避免 detail 过长刷屏）
const ERR_LIST_MAX = 5;

export function runCheckExecution(topicDir: string): CheckOutput {
  const report = new CheckReport("execution");
  const mdPath = join(topicDir, DELIVERABLE);

  // ① 结构性五件套
  if (!checkFileExists(report, `${DELIVERABLE} 存在`, mdPath)) {
    return report.toOutput({ writeReport: true, topicDir });
  }
  checkFrontmatterVerdict(report, mdPath, "pass");
  checkRequiredSections(report, mdPath, "关键章节", [
    "Wave 编排|DAG|调度表",
    "测试验收清单|Test Acceptance",
  ]);
  checkNoPlaceholders(report, "无占位符", mdPath);
  checkReviewVerdict(report, topicDir, "execution", "APPROVED");

  // ① consistency-final.md（Step 6c 总闸门）—— TS 版忽略 --no-consistency-final
  const consistencyPath = join(topicDir, "changes", "consistency-final.md");
  if (existsSync(consistencyPath)) {
    const fm = parseFrontmatter(consistencyPath);
    const verdict = (fm.verdict ?? "").trim();
    if (verdict === "CONSISTENT") {
      report.addPass("consistency-final CONSISTENT", "Step 6c 总闸门通过");
    } else {
      report.addFail(
        "consistency-final CONSISTENT",
        `verdict: '${verdict}'（期望 CONSISTENT）`,
      );
    }
  } else {
    report.addFail(
      "consistency-final 存在",
      "无 changes/consistency-final.md（Step 6c 总闸门）",
    );
  }

  // ② 测试验收清单用例 ID 集合 == ⑤test-matrix 全量（集合相等）
  const manifestSection = extractSection(mdPath, "测试验收清单|Test Acceptance");
  const manifestIds = extractTestIds(manifestSection);

  const codeArchPath = join(topicDir, "code-architecture.md");
  const tmSection = existsSync(codeArchPath)
    ? extractSection(codeArchPath, "测试矩阵|Test Matrix")
    : "";
  const testmatrixIds = extractTestIds(tmSection);

  if (manifestSection) {
    if (testmatrixIds.size > 0) {
      const missing = [...testmatrixIds].filter((id) => !manifestIds.has(id));
      const extra = [...manifestIds].filter((id) => !testmatrixIds.has(id));
      if (missing.length > 0) {
        report.addFail(
          "验收清单 = ⑤test-matrix 全量",
          `清单缺 ${missing.length} 个用例: ${JSON.stringify(missing.slice(0, ERR_LIST_MAX))}`,
        );
      } else if (extra.length > 0) {
        report.addFail(
          "验收清单 = ⑤test-matrix 全量",
          `清单多 ${extra.length} 个用例（⑤无）: ${JSON.stringify(extra.slice(0, ERR_LIST_MAX))}`,
        );
      } else {
        report.addPass(
          "验收清单 = ⑤test-matrix 全量",
          `集合完全相等（${manifestIds.size} 个用例）`,
        );
      }
    } else {
      report.addSkip("验收清单 = ⑤test-matrix 全量", "⑤无 test-matrix，无法比对");
    }
  } else {
    report.addFail("测试验收清单", "无「测试验收清单」章节（MANDATORY）");
  }

  return report.toOutput({ writeReport: true, topicDir });
}

/** 从文本提取所有 T{N}.{M} 用例 ID，返回去重集合。 */
function extractTestIds(text: string): Set<string> {
  const ids = new Set<string>();
  if (!text) return ids;
  for (const m of text.matchAll(/T(\d+\.\d+)/g)) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}

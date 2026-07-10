/**
 * full-architecture（②系统设计）硬规则机器验证。
 *
 * 移植自 skills/full-architecture/scripts/check_architecture.py。
 * 入参：topicDir（含 system-architecture.md + changes/review-architecture.md）。
 *
 * 检查项：
 *   ①结构性：交付物存在 / verdict:pass / 关键章节 / 无占位符 / review-architecture APPROVED
 *   ②引用：设计立场回答「核心计算是什么」/ 核心模型有类型标注 / 状态机 Status/Reason 正交
 *   ③模型关联图（条件强制）：核心模型 ≥ 2 且存在聚合/引用关系时必须 mermaid classDiagram
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
  extractSection,
  findAll,
  hasHeading,
  readText,
} from "./shared.js";

const DELIVERABLE = "system-architecture.md";

export function runCheckArchitecture(topicDir: string): CheckOutput {
  const report = new CheckReport("architecture");
  const mdPath = join(topicDir, DELIVERABLE);

  // ① 结构性
  if (!checkFileExists(report, `${DELIVERABLE} 存在`, mdPath)) {
    return report.toOutput({ writeReport: true, topicDir });
  }
  checkFrontmatterVerdict(report, mdPath, "pass");
  checkRequiredSections(report, mdPath, "关键章节", [
    "目标转换",
    "设计立场",
    "核心模型",
    "分层架构",
  ]);
  checkNoPlaceholders(report, "无占位符", mdPath);
  checkReviewVerdict(report, topicDir, "architecture", "APPROVED");

  // ② 设计立场回答了「核心计算是什么」
  const stanceExists = hasHeading(mdPath, "设计立场");
  if (stanceExists) {
    if (readText(mdPath).includes("核心计算")) {
      report.addPass("设计立场回答核心计算", "「核心计算」已明确");
    } else {
      report.addFail("设计立场回答核心计算", "设计立场未提及「核心计算是什么」");
    }
  } else {
    report.addFail("设计立场回答核心计算", "无「设计立场」章节");
  }

  // ② 核心模型有类型标注（aggregate/实体/值对象/DTO/技术封装）
  const modelSection = extractSection(mdPath, "核心模型");
  if (modelSection) {
    const typeKeywords = [
      "aggregate", "实体", "值对象", "DTO", "技术封装",
      "Aggregate", "Entity", "ValueObject",
    ];
    const hasType = typeKeywords.some((kw) => modelSection.includes(kw));
    if (hasType) {
      report.addPass("核心模型类型标注", "含模型类型（aggregate/实体/DTO 等）");
    } else {
      report.addFail("核心模型类型标注", "核心模型表未标注类型");
    }
  } else {
    report.addSkip("核心模型类型标注", "无核心模型章节或表");
  }

  // ② 状态机 Status/Reason 正交（若有状态流转章节）
  if (hasHeading(mdPath, "状态流转|Status")) {
    const hasStatus = findAll(mdPath, "Status").length > 0;
    const hasReason = findAll(mdPath, "Reason").length > 0;
    if (hasStatus && hasReason) {
      report.addPass("状态机 Status/Reason 正交", "Status 与 Reason 都已定义");
    } else if (hasStatus) {
      report.addFail("状态机 Status/Reason 正交", "有 Status 但缺 Reason 字段（终态原因应正交）");
    } else {
      report.addSkip("状态机 Status/Reason 正交", "状态流转章节存在但无状态机");
    }
  } else {
    report.addSkip("状态机 Status/Reason 正交", "无状态流转章节（可能无状态机）");
  }

  // ③ 模型关联图（条件强制）
  checkModelRelationDiagram(report, modelSection);

  return report.toOutput({ writeReport: true, topicDir });
}

/**
 * 模型关联图条件检查。
 *
 * - 模型数 >= 2 且模型间存在聚合/引用关系 → 必须有 mermaid classDiagram
 * - 模型数 <= 1 或无聚合关系 → skip（单模型画图是噪音）
 *
 * 理由：关系约束（聚合/基数/生命周期绑定）无法靠逐模型平铺表表达，
 * 散落在不变式文字里会被遗漏。classDiagram 是 UML 结构关系标准表达。
 */
function checkModelRelationDiagram(report: CheckReport, modelSection: string): void {
  if (!modelSection) {
    report.addSkip("模型关联图", "无核心模型章节");
    return;
  }

  // 数模型行（粗体模型名：| **FileNode** | ...）
  const modelRows = modelSection.match(/\|\s*\*\*([^*]+)\*\*\s*\|/g) ?? [];
  const modelCount = modelRows.length;

  const MIN_MODELS_FOR_GRAPH = 2; // < 2 个模型（单模型/纯 DTO）画图为噪音
  if (modelCount < MIN_MODELS_FOR_GRAPH) {
    report.addSkip("模型关联图", `模型数 ${modelCount} <= 1（单模型/纯 DTO，画图为噪音）`);
    return;
  }

  // 检测聚合/引用关系关键词
  const relationKeywords = [
    "聚合", "组合", "facet", "内聚", "contains", "持有",
    "引用", "关联", "join", "映射", "分桶", "同生命周期",
  ];
  const hasRelation = relationKeywords.some((kw) => modelSection.includes(kw));
  if (!hasRelation) {
    report.addSkip("模型关联图", `${modelCount} 个模型但无聚合/引用关系（独立模型，图无信息量）`);
    return;
  }

  // 多模型 + 有聚合关系 → 必须有 classDiagram
  if (modelSection.includes("classDiagram")) {
    report.addPass("模型关联图", `${modelCount} 个模型含聚合关系，已出 classDiagram`);
  } else {
    report.addFail(
      "模型关联图",
      `${modelCount} 个模型且存在聚合/引用关系，但 §4 缺 mermaid classDiagram` +
        `（关系约束靠表格表达不了，须用 classDiagram 标聚合/组合/引用+基数）`,
    );
  }
}

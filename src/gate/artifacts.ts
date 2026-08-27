/**
 * gate 域产物落盘（design-release-pipeline.md §3.3 D4 记账闭合，rp-0）。
 *
 * report.json 是 wrap 两条终态路径（miss 执行 / hit 复用）的同构产物——
 * schema 单一出处 = 本模块 + types.ts 的 GateReport。落盘顺序遵守 D4 固定
 * 先后序：**锁外先落产物并算 sha256，失败则 wrap 整体环境错误、事件不入账**
 * ——中途崩溃的最坏形态 = 无害孤儿产物文件（无事件引用，query 不可见）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

import type { GateReport } from "./types.js";

/** report 文件名（产物目录内唯一文件） */
export const GATE_REPORT_FILE_NAME = "report.json";

/** report.json 序列化缩进宽度（与只读命令 --json 输出一致，对照 verify/run.ts 的 REPORT_INDENT） */
const REPORT_INDENT = 2;

/** report.json 序列化形态（2 空格缩进 + 尾随换行，与只读命令 --json 输出一致的稳定字节形态） */
function serializeReport(report: GateReport): string {
  return `${JSON.stringify(report, null, REPORT_INDENT)}\n`;
}

/**
 * 落盘一份 report 并返回其 sha256（写入即内容定位，无中间窗口）。
 *
 * 目录由本函数按需创建（gate-artifacts/<check>/<runId>/ 的递归 mkdir）；
 * 写失败（目录只读 / 磁盘满等）抛原始 Node 错误——由 wrap 层包装为环境
 * 错误（不入账），本模块不吞错误。
 */
export function writeGateReport(
  artifactsDir: string,
  report: GateReport,
): { reportPath: string; reportSha256: string } {
  mkdirSync(artifactsDir, { recursive: true });
  const reportPath = joinReportPath(artifactsDir);
  const bytes = serializeReport(report);
  writeFileSync(reportPath, bytes, "utf-8");
  return { reportPath, reportSha256: sha256OfContent(bytes) };
}

/** 产物目录内 report.json 的绝对路径 */
export function joinReportPath(artifactsDir: string): string {
  return `${artifactsDir}/${GATE_REPORT_FILE_NAME}`;
}

/** report.json 相对项目 CW 目录的引用（入账 reportRef 的形态；账本不存绝对路径，CW_HOME 迁移不破坏可解析性） */
export function relativeReportRef(check: string, runId: string): string {
  return `gate-artifacts/${check}/${runId}/${GATE_REPORT_FILE_NAME}`;
}

/** 字节内容的 sha256（hex） */
export function sha256OfContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * hit 路径的 report 构造（GP5 同构契约）：来源 report 全字段原样复制 + source
 * 标注追加。实现上不重组字段（重组会引入 key 顺序漂移），直接在 parse 出的
 * 对象上追加 source 键——JSON.stringify 按插入序输出，序列化结果 = 来源
 * 序列化形态 + 末尾 source 字段，逐字节可预测。
 */
export function deriveHitReport(sourceReport: GateReport, sourceRunId: string): GateReport {
  return { ...sourceReport, source: sourceRunId };
}

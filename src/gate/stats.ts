/**
 * `cw gate stats` 的渲染核心（design-release-pipeline.md §3.3 D8 stats 命令；
 * requirements.md UC-6 / AC-6.1-6.2，rp-3/W3）。
 *
 * 纯只读聚合：消费 foldGate 的 durationStats 投影（per check 真实执行
 * totalMs/runs——GateCacheHit 无 durationMs 字段，天然只统计真实执行），
 * 直出人类可读表；不读账本文件、不解析 CLI 参数（那是 handler 层的事）。
 *
 * 空账本 = 结构化空形态（EMPTY_STATS_PLACEHOLDER）而非报错——stats 是便利
 * 聚合非目标承载（requirements UC-6：红队 SF-4 降格），空仓/新仓读 stats
 * 不该被当异常打断。
 */
import { foldGate } from "./fold.js";
import type { GateEvent } from "./types.js";

/** 空账本的结构化空形态（导出供 handler/测试对齐同一文案） */
export const EMPTY_STATS_PLACEHOLDER = "(no gate checks recorded)";

/** 一行统计（durationStats 单条投影 + 派生均值） */
interface StatsRow {
  check: string;
  runs: number;
  totalMs: number;
  avgMs: number;
}

/** 数字列（表头顺序 = 输出契约，消费方按此解析） */
const NUMERIC_COLUMNS: readonly { header: string; key: "runs" | "totalMs" | "avgMs" }[] = [
  { header: "runs", key: "runs" },
  { header: "totalMs", key: "totalMs" },
  { header: "avgMs", key: "avgMs" },
];

/** check 列表头 */
const CHECK_HEADER = "check";

/** 表格列间距（两空格，保持 CLI 紧凑） */
const COLUMN_GAP = "  ";

/**
 * 渲染 durationStats 聚合表：check | runs | totalMs | avgMs，按 totalMs
 * 降序（耗时大户在前——stats 的读者关心的是「哪个 check 吃掉了时间」）；
 * 同 totalMs 按 check 字典序（确定性输出，golden 断言友好）。
 *
 * avgMs = round(totalMs / runs)：runs 在投影层结构性 ≥1（durationStats
 * 只在计入首条 GateCheckRan 时建条目），除零不可能。
 */
export function renderStats(events: readonly GateEvent[]): string {
  const durationStats = foldGate(events).durationStats;
  if (durationStats.size === 0) return EMPTY_STATS_PLACEHOLDER;

  const rows: StatsRow[] = [...durationStats.entries()].map(([check, stat]) => ({
    check,
    runs: stat.runs,
    totalMs: stat.totalMs,
    avgMs: Math.round(stat.totalMs / stat.runs),
  }));
  rows.sort((a, b) => b.totalMs - a.totalMs || a.check.localeCompare(b.check));

  const checkWidth = Math.max(CHECK_HEADER.length, ...rows.map((row) => row.check.length));
  const numericWidths = NUMERIC_COLUMNS.map(
    ({ header, key }) =>
      Math.max(header.length, ...rows.map((row) => String(row[key]).length)),
  );

  const lines = [
    formatRow(CHECK_HEADER.padEnd(checkWidth), numericWidths, headerCellAt),
  ];
  for (const row of rows) {
    const cells = NUMERIC_COLUMNS.map(({ key }, i) =>
      String(row[key]).padStart(numericWidths[i] ?? 0),
    );
    const cellValues = [...cells];
    lines.push(formatRow(row.check.padEnd(checkWidth), numericWidths, (i) => cellValues[i] ?? ""));
  }
  return lines.join("\n");
}

/** 表头行的数字列取值函数（header 文本，与数据行同组装路径） */
function headerCellAt(columnIdx: number): string {
  return NUMERIC_COLUMNS[columnIdx]?.header ?? "";
}

/**
 * 组装一行：check 列已预格式化；数字列由 cellAt 按列号取值右对齐。
 * （表头与数据行走同一组装函数，列宽口径不会分叉。）
 */
function formatRow(
  checkCell: string,
  numericWidths: readonly number[],
  cellAt: (columnIdx: number) => string,
): string {
  const numericCells = numericWidths.map((width, columnIdx) =>
    cellAt(columnIdx).padStart(width),
  );
  return [checkCell, ...numericCells].join(COLUMN_GAP);
}

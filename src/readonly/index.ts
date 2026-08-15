/**
 * 只读命令域注册表（u1b 交付）：status / frontier / tree / report。
 * 全部只读：不 append 任何事件（装载层见 load.ts）。
 */
import type { CommandEntry } from "../dispatch.js";
import { frontierHandler } from "./frontier.js";
import { reportHandler } from "./report.js";
import { statusHandler } from "./status.js";
import { treeHandler } from "./tree.js";

export const commands: CommandEntry[] = [
  { name: "status", handler: statusHandler, summary: "查看单元状态（只读）" },
  { name: "frontier", handler: frontierHandler, summary: "查看就绪集合（只读）" },
  { name: "tree", handler: treeHandler, summary: "查看分解树（只读）" },
  { name: "report", handler: reportHandler, summary: "汇总报告（只读）" },
];

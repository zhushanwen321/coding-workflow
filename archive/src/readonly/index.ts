/**
 * readonly 查询渲染层 barrel export。
 *
 * cli.ts 的 V1_READONLY_QUERIES 分支（tree/status/list）从此处导入渲染函数。
 * 渲染函数都是纯函数（不读文件系统），仅接收 CwStore / WorkUnitRecord 数据 + 参数。
 */
export type { FrontierNode, FrontierResult } from "../core/frontier.js";
export type { LoadedCwd } from "./cross-cwd.js";
export { loadAllCwdsFromHome } from "./cross-cwd.js";
export type { AnnotatedUnit,ListOptions } from "./render.js";
export { renderFrontier, renderHandoff, renderList,renderStatus, renderTree } from "./render.js";
export type { ReportOptions,ReportStore } from "./report.js";
export { collectDescendants,renderReport } from "./report.js";

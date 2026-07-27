/**
 * readonly 查询渲染层 barrel export。
 *
 * cli.ts 的 V1_READONLY_QUERIES 分支（tree/status/list）从此处导入渲染函数。
 * 渲染函数都是纯函数（不读文件系统），仅接收 V1Store / WorkUnitRecord 数据 + 参数。
 */
export type { LoadedCwd } from "./cross-cwd.js";
export { loadAllCwdsFromHome } from "./cross-cwd.js";
export type { AnnotatedUnit,ListOptions } from "./render.js";
export { renderHandoff, renderList,renderStatus, renderTree } from "./render.js";

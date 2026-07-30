/**
 * 包入口 — 仅 re-export 公开类型（从 ./types.js）。
 *
 * dispatch 是独立入口 `<pkg>/dispatch`（见 package.json 的 "./dispatch" 导出，
 * 对应 src/dispatch.ts），不在此 re-export。
 */
export * from "./types.js";

/**
 * 包入口 `.` — 经 `export * from "./types.js"` 暴露公开 API（类型与值）。
 *
 * 注意：types.ts 不仅 re-export 类型，还在其末尾把 dispatch 的值与类型
 * （CwEngineError / dispatch / getUnitScope，来自 ./dispatch.js）透传出来，
 * 故这些符号从 `.` 入口可达，并非「不在此 re-export」。
 * package.json 另设有独立的 `./dispatch` 入口（对应 src/dispatch.ts），两者并存。
 */
export * from "./types.js";

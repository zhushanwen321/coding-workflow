/**
 * `./runner` 子路径导出（ph-i0 钉住、u-i2-a 实装；design-hi-cw-runner-extension
 * §3.2 R1/R2 + §5）。
 *
 * 面向 pi-coding-workflow-extension 的库门面：extension（跑在 pi 主会话进程内）以
 * `import { runLoop } from "@zhushanwen/coding-workflow/runner"` 把 runner 调度循环
 * 当库调用。实现 = src/runner/loop.ts 的再导出（零逻辑复制——状态机单一出处）；
 * CLI 壳（src/handlers/run.ts）继续从 loop.ts import，不经本门面。spawn 后端缝
 * （AgentSpawnAdapter / InteractiveSpawnHandle）类型一并导出，extension 侧适配器
 * 对齐同源契约。
 */
export type { LoopEvent, RunLoopOptions } from "./runner/loop.js";
export { runLoop } from "./runner/loop.js";
export type {
  AgentRole,
  AgentSpawnAdapter,
  AgentSpawnRequest,
  InteractiveSpawnHandle,
  SpawnHandle,
  SpawnResult,
} from "./runner/spawn/types.js";

/**
 * `./runner` 子路径导出占位（ph-i0 / design-hi-monorepo-split u-i0-a）。
 *
 * 面向 pi-coding-workflow-extension 的库入口：extension（跑在 pi 进程内）以
 * `import { runLoop } from "@zhushanwen/coding-workflow/runner"` 把 runner 调度
 * 循环当库调用（D3 A+B 形态）。实装在 ph-i1/ph-i2——本波次只钉住导出面，
 * 防止插件包先发版后核心包补导出造成的前后版本兼容窗口。
 */

/** 库形态 runner 循环入参（ph-i1 实装时细化，字段只增不减） */
export interface RunLoopOptions {
  /** 账本所在项目目录 */
  cwd: string;
  /** 根 unit id */
  rootId: string;
}

/** 库形态 runner 循环：ph-i1 实装（现签名为占位，调用方须自行降级） */
export async function runLoop(_options: RunLoopOptions): Promise<void> {
  // ph-i1 实装：复用 src/runner/loop.ts 的派发循环，spawn 侧接 RPC 适配器。
  throw new Error("runLoop: not implemented until ph-i1 (see design-hi-monorepo-split u-i0-a)");
}

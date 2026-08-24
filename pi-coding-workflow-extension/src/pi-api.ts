/**
 * ExtensionAPI 最小自声明（design-hi-cw-runner-extension §5 u-i2-c + 任务书第 5 条）。
 *
 * 插件包不依赖 pi 包（pi 由宿主进程提供，jiti 加载期注入）——本文件是消费面
 * 的结构化子集，字段以 pi 0.84.2 dist types.d.ts 与 subagent-workflow /
 * pi-scheduler 入口先例为准。宿主面超集兼容：多出的字段不影响本扩展。
 */

/** registerCommand handler 的上下文（消费子集） */
export interface ExtensionCommandContext {
  ui: {
    notify?(msg: string, level?: "info" | "warn" | "error"): void;
    setWidget?(content: string): void;
  };
}

export interface ExtensionAPI {
  /** pi 0.84.2 实签名：registerCommand(name, { description, handler(args, ctx) }) */
  registerCommand(
    name: string,
    opts: {
      description: string;
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
    },
  ): void;
  /** 生命周期事件订阅（session_start / session_shutdown 等；data 结构按事件取用） */
  on(event: string, cb: (data: unknown) => void): void;
}

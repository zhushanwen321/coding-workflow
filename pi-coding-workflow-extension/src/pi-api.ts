/**
 * ExtensionAPI 最小自声明（design-hi-cw-runner-extension §5 u-i2-c + 任务书第 5 条）。
 *
 * 插件包不依赖 pi 包（pi 由宿主进程提供，jiti 加载期注入）——本文件是消费面
 * 的结构化子集，字段以 pi 0.84.2 dist types.d.ts 实读为准（P0-2/P1-3 修正）。
 * 宿主面超集兼容：多出的字段不影响本扩展。
 */

/**
 * registerCommand handler 的上下文（消费子集）。
 * cwd 锚点：pi 0.84.2 dist/core/extensions/types.d.ts:217（ExtensionContext.cwd）。
 */
export interface ExtensionCommandContext {
  ui: {
    /** types.d.ts:76——notify(message, type?: "info" | "warning" | "error")，无 "warn" */
    notify?(msg: string, level?: "info" | "warning" | "error"): void;
    /** types.d.ts:97——setWidget(key, content: string[] | undefined, options?)，非单字符串 */
    setWidget?(key: string, content: string[] | undefined, options?: unknown): void;
  };
  /** 宿主会话工作目录（/cw start 的锁与账本锚）；测试 recorder 可缺省 */
  cwd?: string;
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

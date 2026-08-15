/**
 * 命令分发契约层（主 agent 维护，与 src/events/types.ts 同属共享契约）。
 *
 * 注册模式：每个命令域模块在自己的 index.ts 里 export `commands: CommandEntry[]`，
 * 本模块组装全局命令表——各域（handlers/readonly）互不触碰对方文件，
 * 支持并行开发（协调机制见 docs/rewrite/orchestration.md）。
 */

export interface CommandContext {
  /** CLI argv（minimist 解析后） */
  argv: Record<string, unknown> & { _: string[] };
  /** 工作目录（账本定位用） */
  cwd: string;
}

export type CommandHandler = (ctx: CommandContext) => Promise<number>;

export interface CommandEntry {
  /** 命令名；子命令用空格分隔（如 "evidence submit"） */
  name: string;
  handler: CommandHandler;
  /** 一句话用途（--help 汇总用） */
  summary: string;
}

// 各域命令注册表由其 index.ts 提供；占位空表在域首个 unit 交付时替换。
import { commands as handlerCommands } from "./handlers/index.js";
import { commands as readonlyCommands } from "./readonly/index.js";

export const ALL_COMMANDS: CommandEntry[] = [...handlerCommands, ...readonlyCommands];

/** 精确匹配命令名（含子命令空格形式）；argv._ 为位置参数序列 */
export function findCommand(args: readonly string[]): CommandEntry | undefined {
  const rest = args.join(" ");
  return ALL_COMMANDS.find((c) => c.name === rest);
}

export async function dispatch(args: readonly string[], cwd: string): Promise<number> {
  const cmd = findCommand(args);
  if (cmd === undefined) {
    return -1;
  }
  const { default: minimist } = await import("minimist");
  const argv = minimist(args.slice(cmd.name.split(" ").length)) as Record<string, unknown> & {
    _: string[];
  };
  return cmd.handler({ argv, cwd });
}

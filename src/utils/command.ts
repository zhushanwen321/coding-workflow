/**
 * 统一构建 cw 命令字符串。是 guidance 文案里所有 cw 命令的单一来源。
 * 未来改命令名/前缀只改这里。
 */
export function buildCommand(action: string, ...args: string[]): string {
  return `cw ${[action, ...args.filter(Boolean)].join(" ")}`;
}

// src/engine/path-encoding.ts
//
// cwd → 安全目录名的编码逻辑。零依赖叶子原语（搬迁自 pi-coding-workflow，零改动）。
//
// 复刻 Pi SDK `getDefaultSessionDir` 的编码规则：去开头单个分隔符，全量替换剩余
// 分隔符/冒号为 `-`，首尾补 `--`。
//
// 被 `protocol.ts:resolveDbPath` 用：把 workspacePath 编码为
// `~/.cw/<encoded-cwd>/_cw.json` 下的目录名，per-cwd 隔离（#3 方案A）。

/**
 * cwd → 安全目录名。
 *
 * 例：`/Users/x/proj` → `--Users-x-proj--`。
 */
export function encodeCwd(cwd: string): string {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

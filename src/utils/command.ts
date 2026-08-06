/**
 * 统一构建 cw 命令字符串。是 guidance 文案里所有 cw 命令的单一来源。
 * 未来改命令名/前缀只改这里。
 */
export function buildCommand(action: string, ...args: string[]): string {
  return `cw ${[action, ...args.filter(Boolean)].join(" ")}`;
}

/**
 * 把 slug 规范化为可安全用作目录名的形式。
 *
 * slug 在 create 时由 agent 传入，无字符校验；execute 下沉时子 slug 用 `::` 拼接
 * （如 `auth::w1`）。`::` 和 `/`、空格等会破坏文件路径。这里收敛到 `[a-z0-9-]`：
 * `::` → `-`，其余非 `[a-z0-9-]` 字符 → `-`，连续 `-` 压成一个，首尾 `-` 去掉。
 */
export function safeSlugForPath(slug: string): string {
  const normalized = slug
    .replace(/::/g, "-") // execute 下沉的子 slug 分隔符
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-") // 其余非法字符 → -
    .replace(/-+/g, "-") // 连续 - 压成一个
    .replace(/^-+|-+$/g, ""); // 首尾 - 去掉
  // 全空（如 slug 原本是纯特殊字符）兜底为 misc，避免拼出 `.cw//action.json`
  return normalized === "" ? "misc" : normalized;
}

/**
 * 算出 --input 文件的约定路径（相对项目根）。
 *
 * 路径形态：`.cw/<safeSlug>/<action>.json`（如 `.cw/auth-w1/design.json`）。
 * slug 经 safeSlugForPath 规范化，保证路径安全。slug 为空串时（create 失败重试等
 * 单元尚未建成的边缘场景）退化为 `.cw/<action>.json`（根目录下平铺）。
 *
 * agent 按 guidance 里此路径写中间产物，`.cw/` 已在 .gitignore，不进 git。
 */
export function inputFilePath(slug: string, action: string): string {
  const safe = safeSlugForPath(slug);
  return safe === "" ? `.cw/${action}.json` : `.cw/${safe}/${action}.json`;
}

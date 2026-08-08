/**
 * v1 CLI 参数白名单（#5，D-019 合并 #11，W2）。
 *
 * 职责：per-action 的合法 flag 白名单 + validateFlags 纯函数（未知 flag → CwError exit 1）。
 *
 * 背景：minimist 默认不报 unknown flag（实测 `--bogus-flag` 被静默忽略）。agent 拼错
 * `--unitId` 成 `--unid` 时 cw 报「需要 --unitId」（困惑）；可选 flag 拼错静默丢弃
 * （以为成功）。白名单在 buildParams 之前拦截，拼错立即报「unknown flag + 合法列表」。
 *
 * 单源提取：白名单从 buildParams（推进 action）+ runReadonly（只读 action）现有消费键
 * 机械提取（tests/cli-params.test.ts 的 F-2 反向断言锁住「表⊇消费键」不漂移）。
 * camel/kebab 双形态（flag() helper 同时接受 `--unitId`/`--unit-id`）：登记抽象名后
 * 由 kebabize 展开为两种键（F-1）。
 */
import type { ParsedArgs } from "./cli.js";
import { CwError } from "./core/errors.js";

// ═══════════════════════════════════════════════════════════════
// 白名单表
// ═══════════════════════════════════════════════════════════════

/**
 * 全局共享 flag 基础集（全部 action 的合法集 = 全局基础集 ∪ 自身 flag）。
 *
 * - unitId：推进 action 路由 + tree/status/handoff 只读查询
 * - input：推进 action 的 input JSON 通道
 * - workspace：main 解析 workspacePath
 * - help/h：per-command help 入口（必须入白名单，否则 #5 与 #11 互拆台）
 * - version：main 解析 `--version`（与 `cw version` 等价）
 * - verbose：进程级调试日志开关
 */
export const GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "unitId",
  "input",
  "workspace",
  "help",
  "h",
  "version",
  "verbose",
]);

/**
 * per-action 专属 flag 白名单（不含全局基础集，校验时并集）。
 *
 * 键 = action 名（create/design/.../abort + tree/status/list/handoff/frontier），
 * 值 = 该 action 专属的抽象 flag 名集合。来源：
 *   - 推进 action：buildParams 的 flag()/parsed 消费键（slug/objective/parent/basedOnParent/
 *     abandonParentItems/commitHash/abandonedIds/note/reason）
 *   - 只读 action：runReadonly 的 flag()/parsed 消费键（full/scope/root/layer/grep/cwd/all/
 *     long/limit/offset；tree 的 --unitId 在全局集，F-2 补漏登记）
 */
export const FLAG_WHITELIST: Readonly<Record<string, ReadonlySet<string>>> = {
  create: new Set(["slug", "objective", "parent", "basedOnParent"]),
  design: new Set(["abandonParentItems"]),
  "design-review": new Set(),
  execute: new Set(["commitHash"]),
  test: new Set(),
  "exec-review": new Set(),
  retrospect: new Set(),
  closeout: new Set(),
  replan: new Set(["abandonedIds", "note", "abandonParentItems"]),
  abort: new Set(["reason"]),
  tree: new Set(),
  status: new Set(["full"]),
  handoff: new Set(["scope"]),
  frontier: new Set(["root"]),
  list: new Set(["layer", "grep", "cwd", "all", "long", "limit", "offset"]),
};

// ═══════════════════════════════════════════════════════════════
// validateFlags
// ═══════════════════════════════════════════════════════════════

/** camelCase → kebab-case（与 cli.ts flag() helper 的展开同构）。 */
function kebabize(camel: string): string {
  return camel.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/**
 * 展开某 action 的合法 flag 键集（全局基础集 ∪ 专属集，camel/kebab 双形态，F-1）。
 */
function expandedFlagKeys(action: string): Set<string> {
  const names = new Set([
    ...GLOBAL_FLAGS,
    ...(FLAG_WHITELIST[action] ?? []),
  ]);
  const expanded = new Set<string>();
  for (const name of names) {
    expanded.add(name);
    expanded.add(kebabize(name));
  }
  return expanded;
}

/** flag 名的展示形态：单字符短 flag 用 -x，其余用 --xxx（camel 形态展示）。 */
function renderFlagName(name: string): string {
  return name.length === 1 ? `-${name}` : `--${name}`;
}

/**
 * 校验 parsed 的 flag 键全部在白名单内（纯函数，零 IO）。
 *
 * 未知 flag → throw CwError「unknown flag --x, valid: ...」→ mapExitCode 映射 exit 1
 * （D-009：参数错误归 exit 1）。忽略 minimist 内部键 `_`（positional）。
 *
 * 校验点：推进 action 在 buildParams 之前（含 create 缺 layer 早返回分支之前，防
 * 缺 layer + 拼错 flag 时 unknown flag 被吞，K-7）；只读 action 在 runReadonly 内。
 *
 * @param action 当前 action 名（决定合法集）
 * @param parsed minimist 解析结果
 */
export function validateFlags(action: string, parsed: ParsedArgs): void {
  const allowed = expandedFlagKeys(action);
  const unknown = Object.keys(parsed).filter((key) => key !== "_" && !allowed.has(key));
  if (unknown.length === 0) return;
  const first = [...unknown].sort()[0];
  const valid = [...allowed].sort().map(renderFlagName).join(", ");
  throw new CwError(`unknown flag --${first}, valid: ${valid}`);
}

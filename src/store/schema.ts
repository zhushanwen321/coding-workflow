/**
 * v1 持久化层 — 存储格式定义与路径编码。
 *
 * 职责：
 *   - 定义 store.json 的顶层 schema（扁平集合 + parentUnitId 外键）
 *   - cwd → 目录名的编码（per-cwd 隔离）
 *   - v1 存储根目录解析（CW_HOME 环境变量覆盖）
 *
 * 设计要点：
 *   - 单个 workUnits 集合（ExecutionUnit / PlanningUnit 直接扁平存，子 unit 通过
 *     parentUnitId 外键关联，不嵌套）。
 *   - encodeCwd 规则：把路径里的 `/` 替换为 `__`。
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { detectCommonDir } from "../core/git.js";

// ═══════════════════════════════════════════════════════════════
// 存储格式
// ═══════════════════════════════════════════════════════════════

/** v1 持久化文件的顶层 schema（扁平集合 + parentUnitId 外键）。 */
export interface CwJsonFile {
  /** schema 版本（写侧版本标记，emptyFile 写入当前版本；读侧不做版本校验） */
  schemaVersion?: number;
  /** git repo 元信息，可选（旧 store 缺失时降级，首次推进类 action 时回填） */
  repoMeta?: RepoMeta;
  workUnits: WorkUnitRecord[];
}

/**
 * git repo 元信息（跨 cwd 接手时消歧同名 topic）。
 *
 * 一个 store.json 对应一个 cwd，RepoMeta 一对一存顶层（不存每个 unit 内，避免冗余）。
 * 所有字段允许空字符串——git 命令失败时降级，不抛。
 */
export interface RepoMeta {
  /** git remote get-url origin，无 origin 时 "" */
  remoteUrl: string;
  /** git rev-parse --abbrev-ref HEAD，detached 时 "HEAD" */
  branch: string;
  /** create 时的 process.cwd() 绝对路径 */
  worktreePath: string;
  /** git rev-parse --short HEAD，7 位短 hash，失败 "" */
  headCommit: string;
  /**
   * 写入那一刻的 ISO 时间戳，判断 repoMeta 新鲜度。
   *
   * 语义：空串 `""` 表示记录失败（git 命令出错或 cwd 非 git 目录，所有字段降级为 ""）；
   * 非空 ISO 串表示成功记录的时间戳。
   */
  recordedAt: string;
}

/**
 * WorkUnit 的持久化记录。
 *
 * 扁平存储，子 WorkUnit 通过 parentUnitId 外键关联（不嵌套）。
 * 直接序列化 ExecutionUnit（或 PlanningUnit）的全部字段——由于这些类型字段都是
 * JSON 可序列化的（无函数、无 class 实例），直接存即可。
 * 除必填具名键外，其余字段以 unknown 透传（避免 store 层耦合 core 的字段细节）。
 */
export interface WorkUnitRecord {
  // 其余字段（statusHistory / plan / evidence / judgments ...）原样透传，
  // 由 core 层定义；store 层不解释、不裁剪。
  [key: string]: unknown;
  /** WorkUnit 唯一标识（如 "wave:auth-w1"）。主键。 */
  id: string;
  /** 层类型（"epic" | "feature" | "slice" | "wave"，以字符串存）。 */
  scope: string;
  /** 父层 WorkUnit 的 id（epic 无）。外键 → WorkUnitRecord.id。 */
  parentUnitId?: string;
}

// ═══════════════════════════════════════════════════════════════
// 路径编码
// ═══════════════════════════════════════════════════════════════

/**
 * 把 cwd 编码为目录名：把路径分隔符（POSIX `/` 和 Windows `\`）替换为 `__`。
 *
 * 例：`/Users/x/proj` → `__Users__x__proj`；`C:\Users\x\proj` → `C:__Users__x__proj`。
 * 全局替换保留前导分隔符的痕迹（前导 `__` 即原前导分隔符），确定性。
 * 同时处理两种分隔符，确保跨平台 per-cwd 隔离（Windows `\` 路径不会与 POSIX 路径冲突）。
 */
export function encodeCwd(cwd: string): string {
  // 同时处理 POSIX `/` 和 Windows `\`，确保跨平台 per-cwd 隔离。
  return cwd.replace(/[\\/]/g, "__");
}

/**
 * encodeCwd 的逆函数：把 `__` 还原为路径分隔符。
 *
 * 与 encodeCwd 必须成对维护。注意：encodeCwd 把 `/` 和 `\` 都映射为 `__`，
 * decode 时无法区分原串里的 `__` 来自 `/` 还是 `\`，因此统一还原为 `/`（POSIX 风格）。
 * 这对 decode 的用途（显示、日志）足够；decode 不用于反向定位文件系统路径，
 * 真正的 cwd 路径优先取 repoMeta.worktreePath（创建时记录的原值）。
 */
export function decodeCwd(encodedCwd: string): string {
  return encodedCwd.replace(/__/g, "/");
}

// ═══════════════════════════════════════════════════════════════
// 存储根目录
// ═══════════════════════════════════════════════════════════════

/**
 * 存储根目录。
 *
 * 默认 `~/.cw`，可通过 `CW_HOME` 环境变量覆盖。
 * 覆盖值必须是绝对路径（契约要求），否则抛错——per-cwd 隔离依赖稳定、唯一的根。
 */
export function getCwHome(): string {
  const override = process.env.CW_HOME;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(
        `CW_HOME must be an absolute path, got: ${override}`,
      );
    }
    return override;
  }
  return join(homedir(), ".cw");
}

/**
 * 给定 cwd，返回对应的 store.json 路径。
 *
 * store-key 用 `git rev-parse --path-format=absolute --git-common-dir` 归一化（ADR-0014
 * 决策 1/2）：同一 repo 所有 worktree（含 bare repo worktree / linked worktree）探测出
 * 相同 common-dir → 共享同一 store；普通 repo 用 `<repo>/.git`、bare repo 用 `<bare>`。
 * 归一化下沉到 cw-cli 内部，调用方（CwStore 构造）无感——bash 与 cw-tool 走同一路径。
 *
 * 非 git 目录（探测失败）→ fallback 原 cwd（per-cwd 降级，保持现状行为）。进程内 memoize
 * 避免重复 git spawn（见 core/git.ts detectCommonDir）。
 *
 * `<cwHome>/<encodedCommonDir>/store.json`。
 */
export function getCwJsonPath(cwd: string): string {
  const storeKey = detectCommonDir(cwd);
  return join(getCwHome(), encodeCwd(storeKey), "store.json");
}

/**
 * 项目存储布局（canon §3.4 数据流：~/.cw/<project>/events.log + evidence/）。
 *
 * 职责：
 *   - CW_HOME 根目录解析（env CW_HOME 覆盖，默认 ~/.cw）
 *   - cwd → 目录名编码（per-cwd 隔离，路径布局 <CW_HOME>/<encoded>/events.log）
 *   - 账本 / 证据产物路径函数
 *
 * 编码规则（参考旧实现 archive/src/store/cw-store.ts 的 encodeCwd）：可读前缀 +
 * 防碰撞后缀。前缀把 `/`（含 Windows `\`）替换为 `__`，且 `.` 也替换——否则
 * cwd 为 `.` / `..` 这类相对路径会编码为同名特殊目录（join 结果逃逸 CW_HOME），
 * 含 `.` 的 cwd 也会产生形如 `.bare` 的隐藏目录；后缀拼 sha256(cwd 原文) 前 8
 * 位 hex——纯替换是多对一映射（`/`、`\`、`.` 同映 `__`，且与字面 `__` 冲突：
 * `/a/b` 与 `/a.b` 编码相同），不同项目的账本会合并互相污染，hash 后缀保证
 * 不同 cwd 编码必不同。新账本不迁移旧 store 数据（canon D3，系统未发布无兼容
 * 负担），编码后的旧目录留待人工清理。
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** 账本文件名（append-only JSONL） */
const LEDGER_FILE_NAME = "events.log";
/** 证据产物根目录名（账本只记元数据，产物本体落这里） */
const EVIDENCE_DIR_NAME = "evidence";
/** 防碰撞后缀长度（sha256 hex 前 8 位；64^8 组合，同前缀冲突概率可忽略） */
const HASH_SUFFIX_LEN = 8;

/**
 * 存储根目录。默认 ~/.cw，CW_HOME 环境变量可覆盖。
 * 覆盖值必须是绝对路径（per-cwd 隔离依赖稳定、唯一的根），否则抛错。
 */
export function getCwHome(): string {
  const override = process.env.CW_HOME;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(
        `CW_HOME 必须是绝对路径，当前值：${override}。恢复动作：改为绝对路径（如 /tmp/cw-test-home），或取消该环境变量使用默认 ~/.cw。`,
      );
    }
    return override;
  }
  return join(homedir(), ".cw");
}

/**
 * 把 cwd 编码为目录名：可读前缀 + sha256 防碰撞后缀。
 *
 * 例：`/Users/x/proj` → `__Users__x__proj-3f2a9c1d`；`.` → `__-<hash>`。前缀
 * 保留原路径的形状（人可读），后缀保证编码单射（同 cwd 稳定，异 cwd 必异）。
 */
export function encodeCwd(cwd: string): string {
  const readable = cwd.replace(/[\\/.]/g, "__");
  const suffix = createHash("sha256").update(cwd).digest("hex").slice(0, HASH_SUFFIX_LEN);
  return `${readable}-${suffix}`;
}

/** 账本路径：<cwHome>/<encoded-cwd>/events.log */
export function ledgerPath(cwHome: string, cwd: string): string {
  return join(cwHome, encodeCwd(cwd), LEDGER_FILE_NAME);
}

/** 证据产物目录：<cwHome>/<encoded-cwd>/evidence/<unitId>/<runId> */
export function evidenceDir(
  cwHome: string,
  cwd: string,
  unitId: string,
  runId: string,
): string {
  return join(cwHome, encodeCwd(cwd), EVIDENCE_DIR_NAME, unitId, runId);
}

// ── worktree 布局（design-worktree-isolation.md §3.3 D1/D3，W1 纯增量）──────

/**
 * worktree 根目录。默认 ~/.cw-worktrees，CW_WORKTREE_HOME 环境变量可覆盖。
 * 覆盖值必须是绝对路径（worktree 布局依赖稳定、唯一的根），否则抛错；
 * 空串视为未设置（与 getCwHome 的空串语义一致）。
 */
export function getCwWorktreeHome(): string {
  const override = process.env.CW_WORKTREE_HOME;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(
        `CW_WORKTREE_HOME 必须是绝对路径，当前值：${override}。` +
          "恢复动作：改为绝对路径（如 /tmp/cw-test-worktrees），或取消该环境变量使用默认 ~/.cw-worktrees。",
      );
    }
    return override;
  }
  return join(homedir(), ".cw-worktrees");
}

/** unit worktree 路径：<cwWorktreeHome>/<encodeCwd(projectCwd)>/<unitId>——与账本目录同 encoded key（D1） */
export function worktreePath(cwWorktreeHome: string, projectCwd: string, unitId: string): string {
  return join(cwWorktreeHome, encodeCwd(projectCwd), unitId);
}

/**
 * CLI 入口的项目目录解析：CW_PROJECT_DIR 非空时优先（必须绝对路径，否则抛错）；
 * 空串视为未设置；未设置时返回 fallback（进程 cwd）。
 * 用途：agent 在 worktree 内执行 cw 命令时，经该 env 锚定项目账本（D3）。
 */
export function resolveProjectDir(fallback: string): string {
  const override = process.env.CW_PROJECT_DIR;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(
        `CW_PROJECT_DIR 必须是绝对路径，当前值：${override}。` +
          "恢复动作：改为绝对路径（指向项目根目录），或取消该环境变量使用进程当前目录。",
      );
    }
    return override;
  }
  return fallback;
}

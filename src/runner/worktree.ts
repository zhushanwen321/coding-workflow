/**
 * worktree 生命周期封装（design-worktree-isolation.md §3.3 D4/D5、探针 P-wt1~P-wt6）。
 *
 * 每 unit 一个 git worktree（~/.cw-worktrees/<encoded-cwd>/<unitId>）+ 独立分支
 * cw/<unitId>：独立工作目录物理隔离并行 agent，共享 object store 让 worktree 内
 * commit 在主仓库立即可见（P-wt2），证据链免回传。
 *
 * 风格对齐 src/verify/checkout.ts：spawnSync 跑 git（不经 shell，无注入面）、
 * 单步超时 120s、Outcome 模式不抛裸异常（调用方归入 runner 的 env error 路径）、
 * 失败 error 含 git 原始输出与恢复动作指引。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 单步 git 操作超时（本地 worktree 操作通常毫秒级；上限仅防外部仓库挂死 runner） */
const GIT_STEP_TIMEOUT_MS = 120_000;

/** unit 分支前缀：unitId 已过 slug 白名单校验，前缀拼接无转义需求（P-wt6） */
const UNIT_BRANCH_PREFIX = "cw/";

/** unitId slug 规则（与 src/handlers/create.ts 的 SLUG_RE 同规则）：防路径逃逸与分支名注入 */
const UNIT_ID_RE = /^[a-z][a-z0-9-]*$/;

/** worktree 操作结果：成功无返回值；失败 error 含原始失败原因与恢复指引 */
export type WorktreeOutcome = { ok: true } | { ok: false; error: string };

/** unit 分支名：cw/<unitId> */
export function unitBranchName(unitId: string): string {
  return `${UNIT_BRANCH_PREFIX}${unitId}`;
}

/**
 * 为 unit 创建独立 worktree（P-wt1）。步骤：
 *   1. unitId slug 前置校验（不匹配即返回 error，零文件系统副作用）；
 *   2. mkdir 多级父目录（git worktree add 不建缺失的父目录）；
 *   3. git -C <repoDir> worktree add <worktreeDir> -b cw/<unitId> <baseCommit>。
 */
export function addUnitWorktree(
  repoDir: string,
  worktreeDir: string,
  unitId: string,
  baseCommit: string,
): WorktreeOutcome {
  if (!UNIT_ID_RE.test(unitId)) {
    return {
      ok: false,
      error:
        `非法 unit id "${unitId}"：须匹配 ^[a-z][a-z0-9-]*$（小写字母开头，仅小写字母/数字/连字符），` +
        `已拒绝创建 worktree "${worktreeDir}"。恢复动作：改为合法 slug（如 my-unit-1）后重试。`,
    };
  }
  mkdirSync(dirname(worktreeDir), { recursive: true });
  const branch = unitBranchName(unitId);
  const res = spawnSync(
    "git",
    ["-C", repoDir, "worktree", "add", worktreeDir, "-b", branch, baseCommit],
    { encoding: "utf-8", timeout: GIT_STEP_TIMEOUT_MS },
  );
  if (res.error === undefined && res.status === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      `git worktree add 失败（worktree "${worktreeDir}" 分支 ${branch} base ${baseCommit}）：` +
      `${describeFailure(res.error, res.status, res.stderr)}。` +
      `恢复动作：git worktree list 查残留；确认无未保存产出后 ` +
      `git worktree remove --force ${worktreeDir} && git branch -D ${branch}，重跑。`,
  };
}

/**
 * 派发前重置 unit worktree（D4 精确语义）：清未提交半成品（含 untracked），
 * 保留已 commit 产出。reset --hard 与 clean -fd 任一失败即返回 error。
 */
export function resetWorktree(worktreeDir: string): WorktreeOutcome {
  const hard = git(["-C", worktreeDir, "reset", "--hard", "HEAD"]);
  if (hard !== null) {
    return {
      ok: false,
      error:
        `git reset --hard HEAD 失败（worktree "${worktreeDir}"）：${hard}。` +
        `恢复动作：git -C ${worktreeDir} status 查看现场；确认目录归 cw 管理后手动 ` +
        `git -C ${worktreeDir} reset --hard HEAD && git -C ${worktreeDir} clean -fd，重跑。`,
    };
  }
  const clean = git(["-C", worktreeDir, "clean", "-fd"]);
  if (clean !== null) {
    return {
      ok: false,
      error:
        `git clean -fd 失败（worktree "${worktreeDir}"，reset 已完成）：${clean}。` +
        `恢复动作：git -C ${worktreeDir} clean -ndn 预览待删项；排除占用进程后手动 ` +
        `git -C ${worktreeDir} clean -fd，重跑。`,
    };
  }
  return { ok: true };
}

/**
 * 回收 unit worktree（D5：closed 延迟回收用 --force——产出已进证据链与 root
 * 分支，脏残留可弃，P-wt4）。
 */
export function removeWorktree(repoDir: string, worktreeDir: string): WorktreeOutcome {
  const err = git(["-C", repoDir, "worktree", "remove", "--force", worktreeDir]);
  if (err !== null) {
    return {
      ok: false,
      error:
        `git worktree remove --force 失败（repo "${repoDir}" worktree "${worktreeDir}"）：${err}。` +
        `恢复动作：git -C ${repoDir} worktree list 查注册状态；` +
        `git -C ${repoDir} worktree prune 清理失效记录后重试。`,
    };
  }
  return { ok: true };
}

/**
 * 跑一条 git 命令：成功返回 null，失败返回人可读原因（error message / exit code + stderr）。
 * unitId 已过 slug 白名单、路径由调用方拼装，且 spawnSync 不经 shell，无注入面。
 */
function git(args: readonly string[]): string | null {
  const res = spawnSync("git", args, { encoding: "utf-8", timeout: GIT_STEP_TIMEOUT_MS });
  if (res.error === undefined && res.status === 0) {
    return null;
  }
  return describeFailure(res.error, res.status, res.stderr);
}

function describeFailure(
  error: Error | undefined,
  status: number | null,
  stderr: string | null,
): string {
  if (error !== undefined) {
    return error.message;
  }
  const errText = stderr === null ? "" : stderr.trim();
  return `exit ${status ?? "null"}${errText === "" ? "" : ` — ${errText}`}`;
}

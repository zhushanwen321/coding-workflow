/**
 * worktree 生命周期封装（design-worktree-isolation.md §3.3 D2/D4/D5、探针 P-wt1~P-wt6）。
 *
 * 每 unit 一个 git worktree（~/.cw-worktrees/<encoded-cwd>/<unitId>）+ 独立分支
 * （双空间命名：root unit = cw-root/<rootId>，子 unit = cw/<rootId>/<unitId>。
 * unitId 唯一性是账本级——cw create 查同账本全集唯一（不分 root 子树），同项目
 * 两个并行 run 的同名 unit 物理不可能并存；双空间命名的必要性是另两条：① ref 树
 * 冲突隔离——git 的 ref 存储是文件路径树，refs/heads/cw/<rootId> 文件与
 * refs/heads/cw/<rootId>/<unitId> 目录不能并存，root 分支若命名 cw/<rootId> 会
 * 创建失败；② 归属排查——分支名携带 rootId，git branch 输出一眼归属到具体 run。
 * 对齐 design-worktree-isolation.md v3 D2）：独立
 * 工作目录物理隔离并行 agent，共享 object store 让 worktree 内 commit 在主仓库
 * 立即可见（P-wt2），证据链免回传。
 *
 * 风格对齐 src/verify/checkout.ts：spawnSync 跑 git（不经 shell，无注入面）、
 * 单步超时 120s、Outcome 模式不抛裸异常（调用方归入 runner 的 env error 路径）、
 * 失败 error 含 git 原始输出与恢复动作指引。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { encodeCwd } from "../store/project.js";

/** 单步 git 操作超时（本地 worktree 操作通常毫秒级；上限仅防外部仓库挂死 runner） */
const GIT_STEP_TIMEOUT_MS = 120_000;

/** 子 unit 分支前缀（root unit 用独立的 cw-root/ 前缀——git ref 存储是文件路径树，refs/heads/cw/x 文件与 refs/heads/cw/x/y 目录不能并存） */
const UNIT_BRANCH_PREFIX = "cw/";

/** root unit 分支前缀 */
const ROOT_BRANCH_PREFIX = "cw-root/";

/** unitId slug 规则（与 src/handlers/create.ts 的 SLUG_RE 同规则）：防路径逃逸与分支名注入 */
const UNIT_ID_RE = /^[a-z][a-z0-9-]*$/;

/** worktree 操作结果：成功无返回值；失败 error 含原始失败原因与恢复指引 */
export type WorktreeOutcome = { ok: true } | { ok: false; error: string };

/**
 * unit 分支名（双空间命名，D2）：root unit（unitId === rootId）→ cw-root/<rootId>；
 * 子 unit → cw/<rootId>/<unitId>。rootId 与 unitId 均为 slug（cw create 同一白名单），
 * 前缀拼接无转义需求（P-wt6）。
 */
export function unitBranchName(rootId: string, unitId: string): string {
  return unitId === rootId
    ? `${ROOT_BRANCH_PREFIX}${rootId}`
    : `${UNIT_BRANCH_PREFIX}${rootId}/${unitId}`;
}

/**
 * 为 unit 创建独立 worktree（P-wt1）。步骤：
 *   1. rootId / unitId slug 前置校验（不匹配即返回 error，零文件系统副作用——两者都参与分支名拼接）；
 *   2. mkdir 多级父目录（git worktree add 不建缺失的父目录）；
 *   3. git -C <repoDir> worktree add <worktreeDir> -b <分支名> <baseCommit>。
 */
export function addUnitWorktree(
  repoDir: string,
  worktreeDir: string,
  rootId: string,
  unitId: string,
  baseCommit: string,
): WorktreeOutcome {
  for (const id of [rootId, unitId]) {
    if (!UNIT_ID_RE.test(id)) {
      return {
        ok: false,
        error:
          `非法 id "${id}"：须匹配 ^[a-z][a-z0-9-]*$（小写字母开头，仅小写字母/数字/连字符），` +
          `已拒绝创建 worktree "${worktreeDir}"。恢复动作：改为合法 slug（如 my-unit-1）后重试。`,
      };
    }
  }
  mkdirSync(dirname(worktreeDir), { recursive: true });
  const branch = unitBranchName(rootId, unitId);
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
 * 派发前重置 unit worktree（D4 裸形态，fx-4 纯化）：reset --hard + clean -fd 清
 * 未提交半成品（含 untracked）。worktree 内不存在任何 cw 想保护的东西——过程产物
 * （brief/stdout/stderr）已迁 run 级 topic 目录；agent 自建的 .cw-spawn 等目录是
 * 普通 untracked，被清是正确语义（无任何 -e 例外条款）。reset --hard 与 clean
 * 任一失败即返回 error。
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
 * 派发前确保 unit worktree 就绪（D5 存在性检测矩阵——分支与目录两维独立检测，
 * 不依赖 git stderr 文案）：分支检测 `rev-parse --verify --quiet`、目录检测
 * existsSync。四格处置：
 *   - 目录在 + 分支在 → resetWorktree 复用（跨 run 常态，清半成品保留已 commit 产出）；
 *   - 目录亡 + 分支在 → worktree add 挂既有分支（无 -b，中断重跑复用分支上已
 *     commit 的产出）；失败先 worktree prune（清 stale 注册）重试一次，仍败 → error；
 *   - 目录在 + 分支亡 → 异常态（人动过分支）→ error 指引 git worktree remove
 *     --force 后重跑（env error 语义，调用方跳过该 unit 本轮派发）；
 *   - 目录亡 + 分支亡 → add -b 新建（base = run 启动时 HEAD 快照）。
 */
export function ensureUnitWorktree(
  repoDir: string,
  worktreeDir: string,
  rootId: string,
  unitId: string,
  baseCommit: string,
): WorktreeOutcome {
  const branch = unitBranchName(rootId, unitId);
  const dirExists = existsSync(worktreeDir);
  const branchExists = branchRefExists(repoDir, branch);

  if (dirExists && branchExists) {
    return resetWorktree(worktreeDir);
  }
  if (!dirExists && branchExists) {
    return reattachWorktree(repoDir, worktreeDir, branch);
  }
  if (dirExists && !branchExists) {
    return {
      ok: false,
      error:
        `worktree 目录存在但分支已亡（worktree "${worktreeDir}" 分支 ${branch}）——目录与分支` +
        "状态不一致，通常是分支被人手动删除。恢复动作：确认目录内无未保存产出后执行 " +
        `git worktree remove --force ${worktreeDir}，重跑 cw run（将按目录/分支双亡正常重建）。`,
    };
  }
  return addUnitWorktree(repoDir, worktreeDir, rootId, unitId, baseCommit);
}

/** 分支 ref 是否存在（exit 0 = 存在；--quiet 静默不存在时的 fatal 输出） */
function branchRefExists(repoDir: string, branch: string): boolean {
  const res = spawnSync("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", branch], {
    encoding: "utf-8",
    timeout: GIT_STEP_TIMEOUT_MS,
  });
  return res.error === undefined && res.status === 0;
}

/**
 * 「目录亡 + 分支在」格：worktree add 挂既有分支（无 -b）。失败统一先 prune
 * 重试一次（stale worktree 注册是本格最常见的可自愈失败——目录被 rm 掉后注册
 * 残留；prune 幂等无害，不靠 stderr 文案甄别失败原因），仍败 → error。
 */
function reattachWorktree(repoDir: string, worktreeDir: string, branch: string): WorktreeOutcome {
  mkdirSync(dirname(worktreeDir), { recursive: true });
  const err = git(["-C", repoDir, "worktree", "add", worktreeDir, branch]);
  if (err === null) {
    return { ok: true };
  }
  const pruned = git(["-C", repoDir, "worktree", "prune"]);
  if (pruned === null) {
    const retry = git(["-C", repoDir, "worktree", "add", worktreeDir, branch]);
    if (retry === null) {
      return { ok: true };
    }
    return attachFailure(repoDir, worktreeDir, branch, retry);
  }
  return attachFailure(repoDir, worktreeDir, branch, err);
}

function attachFailure(repoDir: string, worktreeDir: string, branch: string, err: string): WorktreeOutcome {
  return {
    ok: false,
    error:
      `复用既有分支创建 worktree 失败（worktree "${worktreeDir}" 分支 ${branch}，已尝试 worktree prune 后重试）：${err}。` +
      `恢复动作：git -C ${repoDir} worktree list 查注册状态；分支被其他 worktree 占用时先回收该 worktree（git -C ${repoDir} worktree remove --force <路径>），` +
      `确认无未保存产出后 git -C ${repoDir} branch -D ${branch}，重跑。`,
  };
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
 * 扫描项目 worktree 根 <cwWorktreeHome>/<encodeCwd(projectCwd)>/ 下的全部 unit
 * 目录名（wt-4 J3：runLoop 启动孤儿清扫的输入）。非目录项忽略；不判定状态——
 * closed / 账本存在性判定由调用方查账本（worktree 目录名只承载 unitId，状态是
 * 账本的事实）。排序保证扫描顺序确定性（回收日志可复现）。
 */
export function listUnitWorktreeIds(cwWorktreeHome: string, projectCwd: string): string[] {
  const root = join(cwWorktreeHome, encodeCwd(projectCwd));
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
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

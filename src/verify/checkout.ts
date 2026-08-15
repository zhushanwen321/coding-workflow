/**
 * 干净 checkout（canon 子文档 2《design-child-testrun.md》§6.3 纪律①：
 * 干净 checkout 是稳定重跑的前提——验证命令跑在冻结 commit 的全新工作区，
 * 不继承工作目录的任何未提交状态）。
 *
 * 实现：mkdtemp 临时目录内 `git clone --quiet <repoDir> <tmp>/ws` + checkout 目标
 * commit（detached HEAD），随后 `git status --porcelain` 干净性自证（探针 P7：
 * 检出工作区必须与 commit 树逐字一致，clone/checkout 后的意外脏状态在这里暴露）。
 * 任一步失败即清理整个临时目录并返回 error（不抛裸异常——调用方把它归入
 * verify 的环境错误 exit 2 路径）。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** 单步 git 操作超时（本地 clone/checkout 通常毫秒级；上限仅防外部仓库挂死 runner） */
const GIT_STEP_TIMEOUT_MS = 120_000;

export type CheckoutOutcome = { ok: true; dir: string } | { ok: false; error: string };

/**
 * 把 repoDir 的目标 commit 检出到一次性干净工作区。
 * 成功返回 { dir }（工作区绝对路径，即验收命令的 cwd）；失败返回 { error } 并清理临时目录。
 */
export function cleanCheckout(repoDir: string, commit: string): CheckoutOutcome {
  const base = mkdtempSync(join(tmpdir(), "cw-verify-checkout-"));
  const wsDir = join(base, "ws");

  const clone = git(["clone", "--quiet", repoDir, wsDir]);
  if (clone !== null) {
    rmSync(base, { recursive: true, force: true });
    return { ok: false, error: `git clone "${repoDir}" 失败：${clone}` };
  }

  const checkout = git(["-C", wsDir, "checkout", "--quiet", commit]);
  if (checkout !== null) {
    rmSync(base, { recursive: true, force: true });
    return { ok: false, error: `git checkout ${commit} 失败（clone 自 "${repoDir}"）：${checkout}` };
  }

  // P7 干净性自证：porcelain 非空 = 工作区与 commit 树不一致，重跑真值不可信
  const status = spawnSync("git", ["-C", wsDir, "status", "--porcelain"], {
    encoding: "utf-8",
    timeout: GIT_STEP_TIMEOUT_MS,
  });
  if (status.error !== undefined || status.status !== 0) {
    const detail = describeFailure(status.error, status.status, status.stderr);
    rmSync(base, { recursive: true, force: true });
    return { ok: false, error: `git status --porcelain 探测失败：${detail}` };
  }
  if (status.stdout.trim() !== "") {
    rmSync(base, { recursive: true, force: true });
    return {
      ok: false,
      error: `检出工作区不干净（git status --porcelain 非空）：\n${status.stdout.trim()}`,
    };
  }
  return { ok: true, dir: wsDir };
}

/**
 * 用后回收 checkout 临时目录。dir 是 cleanCheckout 返回的工作区（<mkdtemp>/ws），
 * 其父目录是本模块 mkdtemp 的一次性容器，一并删除——因此本函数只应与
 * cleanCheckout 的成功返回值配对使用。
 */
export function cleanupCheckout(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dirname(dir), { recursive: true, force: true });
}

/**
 * 跑一条 git 命令：成功返回 null，失败返回人可读原因（error message / exit code + stderr）。
 * commit 已在 evidence submit 期过十六进制白名单，且 spawnSync 不经 shell，无注入面。
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

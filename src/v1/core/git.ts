/**
 * v1 git 只读操作封装（core 层基础设施，无领域语义）。
 *
 * 来源：design-v5-wave.md §4.4（changedFiles 是客观字段，cw 从 commit 提取，不靠 agent 声明）。
 *
 * 职责：封装只读 git 子进程调用（spawnSync），供 handler 层提取 commit 变更信息。
 *      与 rules/gates/test.ts 的 commitExists（git cat-file）同模式——只读 git，不引入新依赖。
 *
 * 不变量：
 * - 只读：只调用 git 的只读子命令（rev-parse / diff / cat-file），不 mutate 仓库状态
 * - 不抛异常：提取失败（commit 不存在 / 无父提交 / 非 git 仓库）返回空数组 + note，
 *   不阻断 execute。commit 存在性由 test gate commitExists 兜底，execute 阶段提取失败
 *   多为 initial commit / 非 git 仓库等边界，记入 evidence.extractionNote 供人审
 */
import { spawnSync } from "node:child_process";

/** extractChangedFiles 的返回——提取成功时 changedFiles 非空（或空但无 note），失败时带 note。 */
export interface ExtractResult {
  /** 变更文件列表（相对仓库根的路径）。提取失败时为空数组。 */
  changedFiles: string[];
  /** 提取失败时的原因（提取成功时为 undefined）。 */
  note?: string;
}

/**
 * 从 commit 提取变更文件列表（相对仓库根的路径）。
 *
 * 机制：`git diff --name-only <parent> <commit>`。先取父 commit（`git rev-parse <commit>^`），
 * 无父提交（initial commit）时 git diff 无法对比，返回空数组 + note。
 *
 * @param workspacePath  仓库工作目录（cwd 绑定到 spawnSync）
 * @param commitHash     目标 commit hash（存在性由调用方/test gate 兜底）
 * @returns 提取结果（成功带 changedFiles，失败带 note），永不抛异常
 */
export function extractChangedFiles(
  workspacePath: string,
  commitHash: string,
): ExtractResult {
  // 先取父 commit（initial commit 无父提交，git rev-parse <commit>^ 失败）
  const parent = spawnSync(
    "git",
    ["rev-parse", `${commitHash}^`],
    { cwd: workspacePath, encoding: "utf-8" },
  );
  if (parent.status !== 0) {
    return {
      changedFiles: [],
      note: `无父提交（可能是 initial commit 或 commit 不存在），跳过 changedFiles 提取`,
    };
  }
  const parentHash = parent.stdout.trim();

  const diff = spawnSync(
    "git",
    ["diff", "--name-only", parentHash, commitHash],
    { cwd: workspacePath, encoding: "utf-8" },
  );
  if (diff.status !== 0) {
    return { changedFiles: [], note: `git diff 失败: ${diff.stderr.trim()}` };
  }

  const changedFiles = diff.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { changedFiles };
}

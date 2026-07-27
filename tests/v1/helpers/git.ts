/**
 * 共享 git 测试 helper —— setupGitRepo（v1 测试专用）。
 *
 * 原位于 tests/helpers/git.ts（0.x 与 v1 共用），Wave 1 删除 0.x 时 tests/helpers/
 * 整体移除；v1 的 cli-v1.test.ts / e2e-handoff.test.ts 仍需 setupGitRepo，故在此重建
 * 精简版（仅 setupGitRepo，commitFile 等 0.x 专用函数不再保留）。
 *
 * 统一 user.email/name，统一 README 内容。
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 在 repoDir 初始化 git 仓库 + 创建一个非空初始 commit，返回 HEAD commit hash。
 *
 * 非空初始 commit 是必须的：execute 的 gitValidator.exists 校验 commit 真实存在，
 * 且 diff-tree 需要有内容才能测文件覆盖校验。
 */
export function setupGitRepo(repoDir: string): string {
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  git(["init"]);
  git(["config", "user.email", "cw-test@test.com"]);
  git(["config", "user.name", "CW Test"]);

  writeFileSync(join(repoDir, "README.md"), "# CW test repo\n");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);
  return git(["rev-parse", "HEAD"]);
}

/**
 * 共享 git 测试 helper —— setupGitRepo / commitFile。
 *
 * 从 dispatch.test.ts、gate.test.ts、e2e.test.ts 三个文件的重复定义提取。
 * 统一 user.email/name，统一 README 内容。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 在 repoDir 初始化 git 仓库 + 创建一个非空初始 commit，返回 HEAD commit hash。
 *
 * 非空初始 commit 是必须的：devCheck 的 GitValidator.validate 校验 nonEmpty，
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

/**
 * 创建一个修改指定文件的 commit，返回 commit hash。
 *
 * 用于 devCheck 文件覆盖校验测试：造 commit → devCheck 提取 diff-tree 文件列表。
 */
export function commitFile(
  repoDir: string,
  filePath: string,
  content: string,
  message: string,
): string {
  const fullPath = join(repoDir, filePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  execFileSync("git", ["-C", repoDir, "add", "."]);
  execFileSync("git", ["-C", repoDir, "commit", "-m", message]);
  return execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

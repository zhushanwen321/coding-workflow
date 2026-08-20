/**
 * wt-1 单测：worktree 基建（真实 tmp git 仓库 + 真实子进程，零 mock）。
 *
 * 用例编号「A1-C2」逐条对应 docs/rewrite/acceptance/wt1-acceptance.md §6：
 *   - A 组：路径与 env 解析（store/project.ts，进程内直调，env 逐项保存/恢复）；
 *   - B 组：worktree 生命周期（runner/worktree.ts，每用例独立 tmp git 仓库，
 *     initRepo 内联模式跟随 tests/u2-evidence.test.ts）；
 *   - C 组：CLI 层 CW_PROJECT_DIR 接线（真实子进程跑 dist/cli.js，模式跟随
 *     tests/u4a-e2e.test.ts 的 runCli）。
 *
 * 注意：直接 `npx vitest run tests/wt1-worktree.test.ts` 不触发 pretest，
 * 需先 `npm run build`（`npm test` 的 pretest 已含 build）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  addUnitWorktree,
  removeWorktree,
  resetWorktree,
  unitBranchName,
} from "../src/runner/worktree.js";
import {
  encodeCwd,
  getCwWorktreeHome,
  ledgerPath,
  resolveProjectDir,
  worktreePath,
} from "../src/store/project.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tmpRoot = mkdtempSync(join(tmpdir(), "cw-wt1-"));
const cwHome = join(tmpRoot, "cw-home");
// 开发者环境可能残留待测 env：记录原始值，afterEach 逐项恢复
const originalWtHome = process.env.CW_WORKTREE_HOME;
const originalProjectDir = process.env.CW_PROJECT_DIR;

function restoreEnv(): void {
  if (originalWtHome === undefined) {
    delete process.env.CW_WORKTREE_HOME;
  } else {
    process.env.CW_WORKTREE_HOME = originalWtHome;
  }
  if (originalProjectDir === undefined) {
    delete process.env.CW_PROJECT_DIR;
  } else {
    process.env.CW_PROJECT_DIR = originalProjectDir;
  }
}

afterEach(restoreEnv);

afterAll(() => {
  restoreEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function gitRun(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git -C ${dir} ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 真实 git 仓库（含一个真实 commit），返回 HEAD 全 hash——u2-evidence.test.ts 的 initRepo 同模式 */
function initRepo(name: string): { repoDir: string; head: string } {
  const repoDir = join(tmpRoot, name);
  mkdirSync(repoDir, { recursive: true });
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-test@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-test"]);
  writeFileSync(join(repoDir, "a.txt"), "a\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "init"]);
  return { repoDir, head: gitRun(repoDir, ["rev-parse", "HEAD"]) };
}

// ── A 组：路径与 env 解析（store/project.ts）─────────────────

describe("A 组：路径与 env 解析", () => {
  it("A1 getCwWorktreeHome() 无 env 时 = join(homedir(), .cw-worktrees)", () => {
    delete process.env.CW_WORKTREE_HOME;
    expect(getCwWorktreeHome()).toBe(join(homedir(), ".cw-worktrees"));
  });

  it("A2 CW_WORKTREE_HOME 绝对路径生效；相对路径抛错且 message 含恢复动作", () => {
    const abs = join(tmpRoot, "wt-home-a2");
    process.env.CW_WORKTREE_HOME = abs;
    expect(getCwWorktreeHome()).toBe(abs);

    process.env.CW_WORKTREE_HOME = "relative/wt-home";
    expect(() => getCwWorktreeHome()).toThrow(/CW_WORKTREE_HOME 必须是绝对路径/);
    expect(() => getCwWorktreeHome()).toThrow(/恢复动作/);
  });

  it("A3 worktreePath = join(home, encodeCwd(cwd), unitId)，与 ledgerPath 共享 encoded key", () => {
    const home = join(tmpRoot, "layout-home");
    const projectCwd = "/Users/x/demo-proj";
    const unitId = "u-layout";
    expect(worktreePath(home, projectCwd, unitId)).toBe(join(home, encodeCwd(projectCwd), unitId));
    // 同 cwd 时账本路径与 worktree 路径的第二段（encoded key）相同
    expect(dirname(worktreePath(home, projectCwd, unitId))).toBe(dirname(ledgerPath(home, projectCwd)));
  });

  it("A4 resolveProjectDir：无 env 返回 fallback；绝对路径 env 生效；相对路径抛错；空串视为未设置", () => {
    delete process.env.CW_PROJECT_DIR;
    expect(resolveProjectDir("/fallback/cwd")).toBe("/fallback/cwd");

    const abs = join(tmpRoot, "project-by-env");
    process.env.CW_PROJECT_DIR = abs;
    expect(resolveProjectDir("/fallback/cwd")).toBe(abs);

    process.env.CW_PROJECT_DIR = "relative/dir";
    expect(() => resolveProjectDir("/fallback/cwd")).toThrow(/CW_PROJECT_DIR 必须是绝对路径/);
    expect(() => resolveProjectDir("/fallback/cwd")).toThrow(/恢复动作/);

    process.env.CW_PROJECT_DIR = "";
    expect(resolveProjectDir("/fallback/cwd")).toBe("/fallback/cwd");
  });
});

// ── B 组：worktree 生命周期（runner/worktree.ts）──────────────

describe("B 组：worktree 生命周期", () => {
  it("B1 add 成功：目录存在，worktree 分支 = cw/<rootId>/<unitId>，主仓库分支指向 baseCommit；分支双空间命名（root unit = cw-root/<rootId>）", () => {
    const { repoDir, head } = initRepo("b1-repo");
    const wt = join(tmpRoot, "wts", "b1");
    // R-1 双空间：root unit（unitId === rootId）与子 unit 分属两棵 ref 树
    expect(unitBranchName("r-b1", "r-b1")).toBe("cw-root/r-b1");
    expect(unitBranchName("r-b1", "u-b1")).toBe("cw/r-b1/u-b1");
    const res = addUnitWorktree(repoDir, wt, "r-b1", "u-b1", head);
    expect(res).toEqual({ ok: true });
    expect(existsSync(wt)).toBe(true);
    expect(gitRun(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("cw/r-b1/u-b1");
    expect(gitRun(repoDir, ["rev-parse", "cw/r-b1/u-b1"])).toBe(head);
  });

  it("B2 父目录多级缺失时 add 仍成功（recursive mkdir 生效）", () => {
    const { repoDir, head } = initRepo("b2-repo");
    const wt = join(tmpRoot, "deep-a", "b", "c", "wt-b2");
    expect(existsSync(join(tmpRoot, "deep-a"))).toBe(false);
    const res = addUnitWorktree(repoDir, wt, "r-b2", "u-b2", head);
    expect(res).toEqual({ ok: true });
    expect(existsSync(wt)).toBe(true);
  });

  it("B3 分支已存在时 add 失败：{ok:false}，error 含 already exists 原文与恢复动作", () => {
    const { repoDir, head } = initRepo("b3-repo");
    expect(addUnitWorktree(repoDir, join(tmpRoot, "wts", "b3-first"), "r-b3", "u-b3", head)).toEqual({
      ok: true,
    });
    const second = addUnitWorktree(repoDir, join(tmpRoot, "wts", "b3-second"), "r-b3", "u-b3", head);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toMatch(/already exists|已经存在/);
      expect(second.error).toContain("恢复动作");
    }
  });

  it("B4 非法 unitId / rootId（../escape、UPPER、空串）：add 返回 error 且文件系统无新目录", () => {
    const { repoDir, head } = initRepo("b4-repo");
    // 全新父前缀：调用后不存在 = 连 mkdir 都未执行（零文件系统副作用）
    const absentRoot = join(tmpRoot, "wt-b4-should-not-exist");
    const badIds = ["../escape", "UPPER", ""];
    for (const bad of badIds) {
      const wt = join(absentRoot, bad === "" ? "empty" : bad.replace(/[/.]/g, "_"));
      const res = addUnitWorktree(repoDir, wt, "r-b4", bad, head);
      expect(res.ok, `unitId "${bad}" 应被拒绝`).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain("非法 id");
      }
      // rootId 参与分支名拼接，同样过 slug 白名单（R-1 后新增的注入面）
      const resByRoot = addUnitWorktree(repoDir, join(absentRoot, "by-root"), bad, "u-b4", head);
      expect(resByRoot.ok, `rootId "${bad}" 应被拒绝`).toBe(false);
      if (!resByRoot.ok) {
        expect(resByRoot.error).toContain("非法 id");
      }
    }
    expect(existsSync(absentRoot)).toBe(false);
  });

  it("B5 reset 清 tracked 脏改与 untracked 文件/目录，无任何例外条款（fx-4 语义反转：产物已迁 topic，worktree 内伪造的 .cw-spawn 一并被清、porcelain 归零）", () => {
    const { repoDir, head } = initRepo("b5-repo");
    const wt = join(tmpRoot, "wts", "b5");
    expect(addUnitWorktree(repoDir, wt, "r-b5", "u-b5", head)).toEqual({ ok: true });
    writeFileSync(join(wt, "a.txt"), "dirty\n");
    writeFileSync(join(wt, "untracked.txt"), "new\n");
    mkdirSync(join(wt, "untracked-dir"), { recursive: true });
    writeFileSync(join(wt, "untracked-dir", "inner.txt"), "inner\n");
    // 手工伪造 .cw-spawn/x（模拟旧习惯 agent 自建）：产物已迁 run 级 topic 目录，
    // worktree 内的它是普通 untracked——裸 clean -fd 清掉是正确语义（原 `-e .cw-spawn`
    // 保留断言随 fx-4 纯化整体反转：worktree 内不存在 cw 想保护的东西）
    mkdirSync(join(wt, ".cw-spawn"), { recursive: true });
    writeFileSync(join(wt, ".cw-spawn", "u-b5.developer.stdout"), "forged prev role stdout\n");
    writeFileSync(join(wt, ".cw-spawn", "u-b5.developer.brief.md"), "forged prev role brief\n");
    expect(gitRun(wt, ["status", "--porcelain"])).not.toBe("");
    expect(resetWorktree(wt)).toEqual({ ok: true });
    // porcelain 全空：无 -e 例外条款，伪造目录一并被清
    expect(gitRun(wt, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(wt, "untracked.txt"))).toBe(false);
    expect(existsSync(join(wt, "untracked-dir"))).toBe(false);
    expect(existsSync(join(wt, ".cw-spawn"))).toBe(false);
    expect(readFileSync(join(wt, "a.txt"), "utf-8")).toBe("a\n"); // tracked 脏改被 reset
  });

  it("B6 reset 保留已 commit 产出：文件仍在且 status 干净", () => {
    const { repoDir, head } = initRepo("b6-repo");
    const wt = join(tmpRoot, "wts", "b6");
    expect(addUnitWorktree(repoDir, wt, "r-b6", "u-b6", head)).toEqual({ ok: true });
    writeFileSync(join(wt, "committed.txt"), "kept\n");
    gitRun(wt, ["add", "-A"]);
    gitRun(wt, ["commit", "-m", "work"]);
    expect(resetWorktree(wt)).toEqual({ ok: true });
    expect(existsSync(join(wt, "committed.txt"))).toBe(true);
    expect(gitRun(wt, ["status", "--porcelain"])).toBe("");
  });

  it("B7 remove --force 回收含脏文件的 worktree：目录消失且 worktree list 不再列出", () => {
    const { repoDir, head } = initRepo("b7-repo");
    const wt = join(tmpRoot, "wts", "b7");
    expect(addUnitWorktree(repoDir, wt, "r-b7", "u-b7", head)).toEqual({ ok: true });
    writeFileSync(join(wt, "dirty-leftover.txt"), "dirty\n");
    const res = removeWorktree(repoDir, wt);
    expect(res).toEqual({ ok: true });
    expect(existsSync(wt)).toBe(false);
    // 分支名不出现在列表 = 该 worktree 注册已移除（路径列因 /var 符号链接不做逐字节比对）
    expect(gitRun(repoDir, ["worktree", "list"])).not.toContain("cw/r-b7/u-b7");
  });

  it("B8 object store 共享（P-wt2）：worktree 内 commit 在主仓库 cat-file 为 commit", () => {
    const { repoDir, head } = initRepo("b8-repo");
    const wt = join(tmpRoot, "wts", "b8");
    expect(addUnitWorktree(repoDir, wt, "r-b8", "u-b8", head)).toEqual({ ok: true });
    writeFileSync(join(wt, "b8.txt"), "obj\n");
    gitRun(wt, ["add", "-A"]);
    gitRun(wt, ["commit", "-m", "wt-commit"]);
    const hash = gitRun(wt, ["rev-parse", "HEAD"]);
    expect(gitRun(repoDir, ["cat-file", "-t", hash])).toBe("commit");
  });

  it("B9 clone 携带 refs（P-wt3）：clone 主仓库后 hash 仍为 commit", () => {
    const { repoDir, head } = initRepo("b9-repo");
    const wt = join(tmpRoot, "wts", "b9");
    expect(addUnitWorktree(repoDir, wt, "r-b9", "u-b9", head)).toEqual({ ok: true });
    writeFileSync(join(wt, "b9.txt"), "ref\n");
    gitRun(wt, ["add", "-A"]);
    gitRun(wt, ["commit", "-m", "wt-commit"]);
    const hash = gitRun(wt, ["rev-parse", "HEAD"]);
    const cloneDir = join(tmpRoot, "b9-clone");
    const clone = spawnSync("git", ["clone", "--quiet", repoDir, cloneDir], { encoding: "utf-8" });
    expect(clone.status, `git clone 应成功（stderr: ${clone.stderr ?? ""}）`).toBe(0);
    expect(gitRun(cloneDir, ["cat-file", "-t", hash])).toBe("commit");
  });
});

// ── C 组：CLI 层 CW_PROJECT_DIR 接线（e2e，真实子进程）────────

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 真实子进程跑 dist/cli.js：CW_HOME 隔离；projectDir 非空时注入 CW_PROJECT_DIR */
function runCli(args: readonly string[], opts: { cwd: string; projectDir?: string }): CliResult {
  const env: NodeJS.ProcessEnv = { ...process.env, CW_HOME: cwHome };
  delete env.CW_PROJECT_DIR;
  if (opts.projectDir !== undefined) {
    env.CW_PROJECT_DIR = opts.projectDir;
  }
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: opts.cwd,
    encoding: "utf-8",
    env,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("C 组：CW_PROJECT_DIR 接线（e2e）", () => {
  it("C1 设 CW_PROJECT_DIR=<项目A> 且 cwd 在另一目录：status 读项目 A 的账本", () => {
    // 预置：子进程在项目 A 内跑 create（两侧 process.cwd() 同为物理路径，encoded key 一致）
    const projectADir = join(tmpRoot, "project-a");
    mkdirSync(projectADir, { recursive: true });
    // macOS 上 /var 是 /private/var 的符号链接：env 传物理路径，与子进程 process.cwd() 一致
    const projectA = realpathSync(projectADir);
    writeFileSync(join(projectA, "brief.md"), "# 任务书\n");
    const created = runCli(["create", "--id", "u-a", "--brief", "brief.md"], { cwd: projectA });
    expect(created.code, `预置 create 应成功（stderr: ${created.stderr}）`).toBe(0);

    const elsewhere = join(tmpRoot, "elsewhere-cwd");
    mkdirSync(elsewhere, { recursive: true });
    const status = runCli(["status"], { cwd: elsewhere, projectDir: projectA });
    expect(status.code, `status 应正常退出（stderr: ${status.stderr}）`).toBe(0);
    // 读到 A 的账本（含 u-a 与其 specs 计数），而非 cwd 的空账本
    expect(status.stdout).toContain("u-a");
    expect(status.stdout).toContain("specs:0");
    expect(status.stdout).not.toContain("(空账本)");
  });

  it("C2 不设 env 时行为与现状一致：读 cwd 账本，空账本正常退出不报错", () => {
    const plain = join(tmpRoot, "plain-cwd");
    mkdirSync(plain, { recursive: true });
    const status = runCli(["status"], { cwd: plain });
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("(空账本)");
    expect(status.stderr).toBe("");
  });
});

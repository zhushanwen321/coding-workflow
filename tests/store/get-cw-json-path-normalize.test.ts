/**
 * getCwJsonPath 归一化测试（ADR-0014 wave1，TC1-TC7）。
 *
 * 背景：store 归一化下沉到 cw-cli 内部——getCwJsonPath 内部用
 * `git rev-parse --path-format=absolute --git-common-dir` 把任意 cwd 归一化到 repo 级
 * common-dir，使同一 repo 所有 worktree（含 bare repo worktree / linked worktree）共享
 * 同一 store。workspace（git/test/file 执行位置）改用 show-toplevel，与 store-key 解耦。
 *
 * 测试策略：真 git 子进程 + mkdtempSync 真实 tmp 目录（zero mock 基线，对齐 TEST-STRATEGY.md）。
 * 场景构造：git init（普通 repo）/ git init --bare + worktree add（bare repo worktree）/
 * git worktree add（linked worktree）。memoize 测试用「删 .git 后断言缓存命中」的行为观测法，
 * 不引入 mock 框架（删 .git 后 fresh probe 必然 fallback 到 cwd，缓存命中则返回旧值 .git 路径）。
 *
 * 隔离：每个 it 用独立 mkdtemp 根目录 + beforeEach 设 process.env.CW_HOME 指向 tmp，
 * afterEach 还原 + 清理。memoize cache 是 module-level（按 workspacePath 索引），mkdtemp
 * 保证各测试路径唯一，无跨测试污染。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { constructCwDeps } from "../../src/cli.js";
import { detectCommonDir, detectWorktreeRoot } from "../../src/core/git.js";
import type { ExecutionUnit } from "../../src/core/workunit.js";
import { loadAllCwdsFromHome } from "../../src/readonly/cross-cwd.js";
import { CwStore } from "../../src/store/cw-store.js";
import {
  encodeCwd,
  getCwHome,
  getCwJsonPath,
  type WorkUnitRecord,
} from "../../src/store/schema.js";

/** 统一 spawnSync 封装（zero mock：真 git 子进程）。stdio ignore 避免输出污染测试日志。 */
function git(args: string[], opts: { cwd?: string } = {}): void {
  spawnSync("git", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

/** 构造普通 git repo（.git 目录）+ 配置 user + initial commit。返回 repo 绝对路径。 */
function makeNormalRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "cw-norm-"));
  git(["init"], { cwd });
  git(["config", "user.email", "t@cw.local"], { cwd });
  git(["config", "user.name", "cw-test"], { cwd });
  writeFileSync(join(cwd, "README.md"), "# test\n");
  git(["add", "."], { cwd });
  git(["commit", "-m", "init"], { cwd });
  git(["branch", "-M", "main"], { cwd });
  return cwd;
}

/**
 * 构造 bare repo + 2 worktree（模拟本项目的 .bare + worktree 结构）。
 *
 * 流程：normal repo 造 initial commit → clone --bare 得 bare repo（HEAD 正确指向 main）
 *      → 从 bare repo worktree add 两个 worktree。两 worktree 的 common-dir 都 = bare 路径。
 *
 * 注意：worktree add 的输出不能 pipe 到 head（SIGPIPE 会中断 worktree 文件写入）。
 */
function makeBareRepoWithWorktrees(): {
  bare: string;
  wt1: string;
  wt2: string;
} {
  const root = mkdtempSync(join(tmpdir(), "cw-bare-"));
  const seed = join(root, "seed");
  const bare = join(root, "repo.git");
  const wt1 = join(root, "wt1");
  const wt2 = join(root, "wt2");
  // normal repo 造 initial commit
  mkdirSync(seed, { recursive: true });
  git(["init"], { cwd: seed });
  git(["config", "user.email", "t@cw.local"], { cwd: seed });
  git(["config", "user.name", "cw-test"], { cwd: seed });
  writeFileSync(join(seed, "README.md"), "# seed\n");
  git(["add", "."], { cwd: seed });
  git(["commit", "-m", "init"], { cwd: seed });
  git(["branch", "-M", "main"], { cwd: seed });
  // clone --bare（HEAD 正确指向 main，后续 worktree add main 可用）
  git(["clone", "--bare", seed, bare]);
  // 从 bare repo 加 2 个 worktree（不能用 pipe 到 head：SIGPIPE 中断写文件）
  git(["--git-dir", bare, "worktree", "add", wt1, "main"]);
  git(["--git-dir", bare, "worktree", "add", wt2, "-b", "feature"]);
  return { bare, wt1, wt2 };
}

/**
 * 构造 normal repo + 1 linked worktree（git worktree add 从普通 repo 创建）。
 *
 * linked worktree 的 common-dir 指向主 repo 的 .git（与主 worktree 共享 object store）。
 */
function makeRepoWithLinkedWorktree(): { main: string; linked: string } {
  const root = mkdtempSync(join(tmpdir(), "cw-linked-"));
  const main = join(root, "main");
  const linked = join(root, "linked");
  git(["init", main]);
  git(["config", "user.email", "t@cw.local"], { cwd: main });
  git(["config", "user.name", "cw-test"], { cwd: main });
  writeFileSync(join(main, "README.md"), "# main\n");
  git(["add", "."], { cwd: main });
  git(["commit", "-m", "init"], { cwd: main });
  git(["branch", "-M", "main"], { cwd: main });
  git(["worktree", "add", linked, "-b", "feature"], { cwd: main });
  return { main, linked };
}

describe("ADR-0014 getCwJsonPath 归一化（TC1-TC7）", () => {
  let prevCwHome: string | undefined;
  let tmpRoots: string[];

  beforeEach(() => {
    tmpRoots = [];
    // CW_HOME 指向独立 tmp，getCwJsonPath 读它做 store 路径前缀（隔离，不污染 ~/.cw）
    const cwHome = mkdtempSync(join(tmpdir(), "cw-norm-home-"));
    tmpRoots.push(cwHome);
    prevCwHome = process.env.CW_HOME;
    process.env.CW_HOME = cwHome;
  });

  afterEach(() => {
    if (prevCwHome === undefined) delete process.env.CW_HOME;
    else process.env.CW_HOME = prevCwHome;
    for (const root of tmpRoots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TC1: bare repo 两 worktree 调 getCwJsonPath 返回同一 store 路径（common-dir=.bare 编码）", () => {
    const { bare, wt1, wt2 } = makeBareRepoWithWorktrees();
    tmpRoots.push(bare, wt1, wt2);
    // macOS /var→/private/var 符号链接：git 解析返回 realpath，mkdtemp 返回未解析路径。
    // 用 realpathSync 规范化，使断言比对的是 git 实际输出的解析路径。
    const realBare = realpathSync(bare);

    const path1 = getCwJsonPath(wt1);
    const path2 = getCwJsonPath(wt2);

    // 两 worktree 共享同一 store（common-dir 都 = bare 路径）
    expect(path1).toBe(path2);
    // 路径以 encodeCwd(realBare) 作为完整目录段（非 per-cwd 的 worktree 路径编码）
    expect(path1).toContain(encodeCwd(realBare));
    expect(path1).not.toContain(encodeCwd(wt1));
    expect(path1).not.toContain(encodeCwd(wt2));
  });

  it("TC2: 普通 repo getCwJsonPath 归一化到 .git（根与子目录相同）", () => {
    const repo = makeNormalRepo();
    mkdirSync(join(repo, "sub"), { recursive: true });
    tmpRoots.push(repo);
    const realRepo = realpathSync(repo);

    const pathRoot = getCwJsonPath(repo);
    const pathSub = getCwJsonPath(join(repo, "sub"));

    // 普通 repo store-key = <repo>/.git（绝对），根与子目录调用返回相同路径
    expect(pathRoot).toBe(pathSub);
    expect(pathRoot).toContain(encodeCwd(join(realRepo, ".git")));
  });

  it("TC3: 子目录调用稳定（common-dir 探测向上找到 repo 根，非子目录）", () => {
    const repo = makeNormalRepo();
    mkdirSync(join(repo, "packages", "renderer"), { recursive: true });
    tmpRoots.push(repo);
    const realRepo = realpathSync(repo);

    const pathRoot = getCwJsonPath(repo);
    const pathDeep = getCwJsonPath(join(repo, "packages", "renderer"));

    // 深子目录探测 common-dir 仍返回 repo 根的 .git（agent 在子目录调 cw 不丢任务树）
    expect(pathDeep).toBe(pathRoot);
    expect(pathDeep).toContain(encodeCwd(join(realRepo, ".git")));
    expect(pathDeep).not.toContain(encodeCwd(join(repo, "packages")));
  });

  it("TC4: 非 git 目录降级 per-cwd（fallback workspacePath，不抛错）", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-nongit-"));
    tmpRoots.push(dir);

    const path = getCwJsonPath(dir);

    // 非 git 目录探测失败 → fallback 原 cwd（per-cwd 降级，保持现状行为）
    expect(path).toBe(join(getCwHome(), encodeCwd(dir), "store.json"));
  });

  it("TC5: constructCwDeps 解耦——fileExists/testRunner 基准 = worktree 根（非入参 subdir）", () => {
    // 构造 repo + 子目录 + 仅存在于 repo 根的 marker 文件。
    // constructCwDeps(subdir)：workspacePath=subdir，但 worktreeRoot=repo（show-toplevel）。
    // fileExists/testRunner 绑 worktreeRoot → 能找到 repo 根的 marker；若绑 subdir 则找不到。
    const repo = makeNormalRepo();
    const subdir = join(repo, "pkg");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(repo, "ROOT-MARKER"), "x");
    tmpRoots.push(repo);

    const deps = constructCwDeps(subdir);

    // fileExists：相对路径 resolve 基准 = worktree 根（repo）→ 找到 ROOT-MARKER
    expect(deps.fileExists!.exists("ROOT-MARKER")).toBe(true);

    // testRunner：testCwd 缺省 → resolvedCwd = worktree 根（repo），test -f ROOT-MARKER 成功
    const unit = {
      id: "wave:tc5",
      plan: { testCommand: "test -f ROOT-MARKER" },
    } as unknown as ExecutionUnit;
    const result = deps.testRunner!.run(unit);
    expect(result.passed).toBe(true);

    // gitValidator：cat-file 从 repo 内任意路径都能命中 git（功能性正确，worktreeRoot 绑定
    // 由 fileExists/testRunner 精确证明——三者共用同一 worktreeRoot 变量）。
    const hash = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    expect(deps.gitValidator!.exists(hash)).toBe(true);
  });

  it("TC6: memoize——同 workspacePath 第二次命中缓存，不重复 spawn git", () => {
    // 行为观测法（zero mock，不引入 mock 框架）：
    // 1. git repo 探测 common-dir → 缓存写入（含 .git 的检测路径）
    // 2. 删 .git 让 fresh probe 必然 fallback 到 repo（非 git 目录）
    // 3. 再次探测：若命中缓存返回与首次相同的值；若 miss 重新 probe 返回 repo（fallback）
    // 断言 second===first 即证明第二次命中缓存（miss 时 second 会变成 repo，与 first 不同）。
    // 不与手算路径比对，避免 macOS /var→/private/var 符号链接解析差异干扰。
    const repo = makeNormalRepo();
    tmpRoots.push(repo);

    const first = detectCommonDir(repo);
    // first 是 git 检测路径（含 .git 后缀，证明探测成功而非 fallback）
    expect(first).toContain(".git");

    // 删 .git 降级为非 git 目录（fresh probe 会 fallback 到 repo）
    rmSync(join(repo, ".git"), { recursive: true, force: true });

    const second = detectCommonDir(repo);
    // 缓存命中 → 与首次返回完全相同的值（若 miss 则 fallback 返回 repo，断言失败）
    expect(second).toBe(first);

    // 旁证：detectWorktreeRoot 同 path 的 toplevel 字段未被 common-dir 探测连带触发——
    // 删 .git 前未探测过 toplevel，此刻探测会 fresh spawn 并 fallback 到 repo（非缓存值）。
    const toplevel = detectWorktreeRoot(repo);
    expect(toplevel).toBe(repo);
  });

  it("TC7: linked worktree common-dir 指向主 repo（与主 worktree 共享 store）", () => {
    const { main, linked } = makeRepoWithLinkedWorktree();
    tmpRoots.push(main, linked);
    const realMain = realpathSync(main);

    const pathMain = getCwJsonPath(main);
    const pathLinked = getCwJsonPath(linked);

    // linked worktree 的 common-dir = 主 repo 的 .git，与主 worktree 共享同一 store
    expect(pathMain).toBe(pathLinked);
    expect(pathMain).toContain(encodeCwd(join(realMain, ".git")));
    expect(pathMain).not.toContain(encodeCwd(linked));
  });

  it("T4 验证: list --all 在新 common-dir 编码下不崩（cross-cwd 兼容，worktreePath 优先）", () => {
    // store 目录名从 encodeCwd(cwd) 变 encodeCwd(common-dir)，验证 cross-cwd 遍历 + 显示兼容：
    // loadAllCwdsFromHome 扫 CW_HOME 子目录能读到新编码 store；cwd 显示优先 repoMeta.worktreePath
    //（create 时记录的入口 cwd），反解的 common-dir 路径仅作 fallback（旧 store 无 repoMeta 时）。
    const repo = makeNormalRepo();
    tmpRoots.push(repo);

    // CwStore 落盘到 CW_HOME/encodeCwd(common-dir)/store.json（新编码）+ 首次 save 回填 repoMeta
    const store = new CwStore(repo);
    const unit: WorkUnitRecord = {
      id: "wave:t4",
      scope: "wave",
      slug: "t4",
      status: "created",
      statusHistory: [
        { at: new Date().toISOString(), action: "create", to: "created" },
      ],
    };
    store.save(unit);

    // loadAllCwdsFromHome 扫 CW_HOME 子目录，新编码目录名（encodeCwd(common-dir)）能被遍历
    const loaded = loadAllCwdsFromHome(getCwHome());
    expect(loaded).toHaveLength(1);
    // cwd 显示 = repoMeta.worktreePath（create 时记录的入口 cwd），非反解的 common-dir 路径
    expect(loaded[0]!.cwd).toBe(repo);
    expect(loaded[0]!.data.workUnits).toHaveLength(1);
    expect(loaded[0]!.data.workUnits[0]!.id).toBe("wave:t4");
  });
});

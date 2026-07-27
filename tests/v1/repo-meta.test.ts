/**
 * Wave A: collectRepoMeta + V1JsonFile schemaVersion/repoMeta 迁移测试。
 *
 * 测试目标：
 *   - collectRepoMeta 在真实 git repo / 非 git 目录 / bare+worktree 三种环境的行为
 *   - V1Store 新建 store 写入 schemaVersion=1 + repoMeta
 *   - 旧 store（无 schemaVersion/repoMeta）加载降级不 crash
 *   - 推进类 save 刷新 repoMeta，readonly query 不刷新
 *
 * 测试策略：真 git 子进程 + mkdtempSync 真实 tmp 目录（zero mock 基线）。
 *
 * 隔离：每个 describe 的 beforeEach 把 process.env.V1_HOME 指向独立 tmp 目录，
 * afterEach 还原 + 清理。不污染用户真实 ~/.v1/（C1 修复）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectRepoMeta } from "../../src/core/git.js";
import type { WorkUnitRecord } from "../../src/store/schema.js";
import { getV1JsonPath } from "../../src/store/schema.js";
import { V1Store } from "../../src/store/v1-store.js";

/** 临时 git 仓库：init + 配置 user + 可选 remote + 初始 commit。 */
function makeGitRepo(opts: { remoteUrl?: string } = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), "cw-repometa-"));
  const git = (args: string[]): void => {
    spawnSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  };
  git(["init"]);
  git(["config", "user.email", "test@cw.local"]);
  git(["config", "user.name", "cw-test"]);
  if (opts.remoteUrl) {
    git(["remote", "add", "origin", opts.remoteUrl]);
  }
  // 初始 commit（让 HEAD 有效，能拿 headCommit）
  writeFileSync(join(cwd, "README.md"), "# test\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  return cwd;
}

/**
 * 造一个最小 WorkUnitRecord 用于 save 测试。
 *
 * M3 修复：放弃自造完整字段，复用 core 层 createWave 工厂构造 ExecutionUnit，
 * 但 createWave 返回值带具名接口（无索引签名），无法直接赋给带 `[key: string]: unknown`
 * 索引签名的 WorkUnitRecord（TS 既拒绝直接赋值也拒绝 `as WorkUnitRecord`）。
 * 只能用 `as unknown as`。
 *
 * 为彻底去掉 `as unknown as`，改用对象字面量 + 显式 WorkUnitRecord 返回类型：TS 对
 * 对象字面量做 excess property 检查时会认索引签名，多余的具名字段（slug/statusHistory
 * 等）被索引签名吸收，无需 cast。仅手写 store 测试真正用到的少数字段（id/scope +
 * statusHistory），其余字段由真实 handler 在各自测试里填充——本文件不验证产物字段。
 *
 * @param id 形如 "wave:test-a" 的完整 id；slug 从 id 派生（去掉 "wave:" 前缀）。
 */
function makeUnit(id: string): WorkUnitRecord {
  const slug = id.startsWith("wave:") ? id.slice("wave:".length) : id;
  return {
    id,
    scope: "wave",
    slug,
    status: "created",
    statusHistory: [
      { at: new Date().toISOString(), action: "create", to: "created" },
    ],
  };
}

describe("Wave A: collectRepoMeta", () => {
  let cwd: string;
  let v1Home: string;
  let prevV1Home: string | undefined;

  beforeEach(() => {
    v1Home = mkdtempSync(join(tmpdir(), "cw-repometa-v1home-"));
    prevV1Home = process.env.V1_HOME;
    process.env.V1_HOME = v1Home;
    cwd = mkdtempSync(join(tmpdir(), "cw-repometa-"));
  });
  afterEach(() => {
    if (prevV1Home === undefined) delete process.env.V1_HOME;
    else process.env.V1_HOME = prevV1Home;
    rmSync(v1Home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("真实 git repo + remote origin → 全字段正确", () => {
    rmSync(cwd, { recursive: true, force: true });
    cwd = makeGitRepo({ remoteUrl: "git@github.com:foo/bar.git" });
    // 切到一个具名分支（默认可能是 master/main，显式切确保 branch 字段可预测）
    spawnSync("git", ["checkout", "-b", "feat-x"], { cwd, encoding: "utf-8" });

    const meta = collectRepoMeta(cwd);

    expect(meta.remoteUrl).toBe("git@github.com:foo/bar.git");
    expect(meta.branch).toBe("feat-x");
    expect(meta.headCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(meta.worktreePath).toBe(cwd);
    expect(() => new Date(meta.recordedAt).toISOString()).not.toThrow();
  });

  it("非 git 目录 → 降级空字符串不抛", () => {
    // cwd 是 mkdtempSync 建的普通目录，无 .git
    const meta = collectRepoMeta(cwd);

    expect(meta.remoteUrl).toBe("");
    expect(meta.branch).toBe("");
    expect(meta.headCommit).toBe("");
    expect(meta.worktreePath).toBe(cwd);
    expect(meta.recordedAt).toBeTruthy();
  });

  it("bare + worktree 结构 → branch/worktreePath 是 worktree 的", () => {
    // 主仓（非 bare，正常 init）+ worktree add
    // 用 try/finally 确保 assertion 失败也能清理（m4 修复）
    const mainRepo = makeGitRepo({ remoteUrl: "https://github.com/foo/bar.git" });
    // 主仓当前在默认分支（master 或 main），先确认
    const mainBranch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: mainRepo,
      encoding: "utf-8",
    }).stdout.trim();

    const wtPath = join(mainRepo + "-wt-feat-y");
    spawnSync("git", ["worktree", "add", "-b", "feat-y", wtPath], {
      cwd: mainRepo,
      encoding: "utf-8",
    });

    try {
      const meta = collectRepoMeta(wtPath);

      expect(meta.branch).toBe("feat-y");
      expect(meta.worktreePath).toBe(wtPath);
      expect(meta.remoteUrl).toBe("https://github.com/foo/bar.git");
      expect(meta.headCommit).toMatch(/^[0-9a-f]{7,40}$/);

      // 主仓的 branch 应该是主分支，不是 feat-y
      const mainMeta = collectRepoMeta(mainRepo);
      expect(mainMeta.branch).toBe(mainBranch);
      expect(mainMeta.worktreePath).toBe(mainRepo);
    } finally {
      rmSync(wtPath, { recursive: true, force: true });
      rmSync(mainRepo, { recursive: true, force: true });
    }
  });

  it("无 remote origin 的 repo → remoteUrl 为空，其他字段正常", () => {
    rmSync(cwd, { recursive: true, force: true });
    cwd = makeGitRepo(); // 无 remoteUrl

    const meta = collectRepoMeta(cwd);

    expect(meta.remoteUrl).toBe("");
    expect(meta.branch).toBeTruthy(); // master 或 main
    expect(meta.headCommit).toMatch(/^[0-9a-f]{7,40}$/);
  });
});

describe("Wave A: V1Store schemaVersion + repoMeta 迁移", () => {
  let cwd: string;
  let v1Home: string;
  let prevV1Home: string | undefined;

  beforeEach(() => {
    v1Home = mkdtempSync(join(tmpdir(), "cw-repometa-v1home-"));
    prevV1Home = process.env.V1_HOME;
    process.env.V1_HOME = v1Home;
    cwd = makeGitRepo({ remoteUrl: "git@github.com:foo/bar.git" });
  });
  afterEach(() => {
    if (prevV1Home === undefined) delete process.env.V1_HOME;
    else process.env.V1_HOME = prevV1Home;
    rmSync(v1Home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("新建 store + 首次 save → _v1.json 含 schemaVersion=1 + repoMeta 全字段", () => {
    const store = new V1Store(cwd);
    const unit = makeUnit("wave:test-a");
    store.save(unit);

    const raw = JSON.parse(readFileSync(getV1JsonPath(cwd), "utf-8"));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.repoMeta).toBeDefined();
    expect(raw.repoMeta.remoteUrl).toBe("git@github.com:foo/bar.git");
    expect(raw.repoMeta.branch).toBeTruthy();
    expect(raw.repoMeta.headCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(raw.repoMeta.worktreePath).toBe(cwd);
    expect(raw.repoMeta.recordedAt).toBeTruthy();
  });

  it("旧 store（无 schemaVersion/repoMeta）加载不 crash + schemaVersion 内存补 1 + 磁盘未写", () => {
    // 手动构造旧格式 _v1.json
    const v1Path = getV1JsonPath(cwd);
    mkdirSync(join(v1Path, ".."), { recursive: true });
    const oldUnit = makeUnit("wave:old-unit");
    writeFileSync(v1Path, JSON.stringify({ workUnits: [oldUnit] }));

    const store = new V1Store(cwd);
    const units = store.loadAll();

    expect(units).toHaveLength(1);
    expect(units[0].id).toBe("wave:old-unit");

    // loadFileData 是只读路径——磁盘上不应有 schemaVersion 键（内存补不写盘，M4 修复）
    const rawOnDisk = JSON.parse(readFileSync(v1Path, "utf-8"));
    expect(rawOnDisk.schemaVersion).toBeUndefined();
    expect(rawOnDisk.repoMeta).toBeUndefined();
  });

  it("再次 save 不刷新 repoMeta（M1：首次记录后冻结，避免批量 save N*3 git 进程 + cwd 迁移覆盖）", () => {
    const store = new V1Store(cwd);
    const unit = makeUnit("wave:test-refresh");
    store.save(unit);

    // 首次 save 后记录 branch（创建时的 git 快照）
    const raw1 = JSON.parse(readFileSync(getV1JsonPath(cwd), "utf-8"));
    const branchBefore = raw1.repoMeta.branch;

    // 切新分支
    spawnSync("git", ["checkout", "-b", "changed-branch"], { cwd, encoding: "utf-8" });

    // 再次 save（推进类写入）——repoMeta 不应刷新，保持首次记录的快照
    unit.status = "clarifying";
    store.save(unit);

    const raw2 = JSON.parse(readFileSync(getV1JsonPath(cwd), "utf-8"));
    // repoMeta 整体冻结（深比较），branch 仍是首次记录值
    expect(raw2.repoMeta).toEqual(raw1.repoMeta);
    expect(raw2.repoMeta.branch).toBe(branchBefore);
  });

  it("readonly query 不刷新 repoMeta 整体（不只 recordedAt）", () => {
    const store = new V1Store(cwd);
    store.save(makeUnit("wave:test-readonly"));

    const raw1 = JSON.parse(readFileSync(getV1JsonPath(cwd), "utf-8"));

    // 多次 readonly query（M2 修复：验证 repoMeta 整体不变，不只 recordedAt）
    store.loadAll();
    store.loadAll();
    store.load("wave:test-readonly");
    store.findChildren("wave:test-readonly");

    // repoMeta 整体未被刷新（深比较整个对象）
    const raw2 = JSON.parse(readFileSync(getV1JsonPath(cwd), "utf-8"));
    expect(raw2.repoMeta).toEqual(raw1.repoMeta);
  });
});

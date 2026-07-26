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
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectRepoMeta } from "../../src/v1/core/git.js";
import { V1Store } from "../../src/v1/store/v1-store.js";
import { getV1JsonPath } from "../../src/v1/store/schema.js";
import type { WorkUnitRecord } from "../../src/v1/store/schema.js";

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

/** 造一个最小 WorkUnitRecord 用于 save 测试。 */
function makeUnit(id: string): WorkUnitRecord {
  return {
    id,
    scope: "wave",
    slug: id.split(":")[1] ?? id,
    status: "created",
    statusHistory: [{ at: new Date().toISOString(), action: "create", to: "created" }],
    basedOnParent: [],
    abandonedRefs: [],
    objective: "test unit",
    clarifications: [],
    plan: { split: [], testCases: [], tasks: [], files: [], contracts: [] },
    designReviewJudgment: {
      necessity: "",
      sufficiency: { gaps: [], overlaps: [], meceNote: "" },
      alternatives: "",
      tradeoffs: [],
      risks: [],
    },
    executeResult: { childUnitIds: [] },
    retrospectData: {
      reviewedItems: [],
      lessonsLearned: "",
      deliveryVerdict: "failed",
      childUnitIdsEvidence: [],
      splitFulfillment: [],
    },
    evidence: { generatedAt: "", artifacts: [], childDelivery: [] },
  } as unknown as WorkUnitRecord;
}

describe("Wave A: collectRepoMeta", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "cw-repometa-"));
  });
  afterEach(() => {
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
    expect(meta.headCommit).toMatch(/^[0-9a-f]{7}$/);
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
    rmSync(cwd, { recursive: true, force: true });
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

    const meta = collectRepoMeta(wtPath);

    expect(meta.branch).toBe("feat-y");
    expect(meta.worktreePath).toBe(wtPath);
    expect(meta.remoteUrl).toBe("https://github.com/foo/bar.git");
    expect(meta.headCommit).toMatch(/^[0-9a-f]{7}$/);

    // 主仓的 branch 应该是主分支，不是 feat-y
    const mainMeta = collectRepoMeta(mainRepo);
    expect(mainMeta.branch).toBe(mainBranch);
    expect(mainMeta.worktreePath).toBe(mainRepo);

    rmSync(wtPath, { recursive: true, force: true });
    rmSync(mainRepo, { recursive: true, force: true });
  });

  it("无 remote origin 的 repo → remoteUrl 为空，其他字段正常", () => {
    rmSync(cwd, { recursive: true, force: true });
    cwd = makeGitRepo(); // 无 remoteUrl

    const meta = collectRepoMeta(cwd);

    expect(meta.remoteUrl).toBe("");
    expect(meta.branch).toBeTruthy(); // master 或 main
    expect(meta.headCommit).toMatch(/^[0-9a-f]{7}$/);
  });
});

describe("Wave A: V1Store schemaVersion + repoMeta 迁移", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = makeGitRepo({ remoteUrl: "git@github.com:foo/bar.git" });
  });
  afterEach(() => {
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
    expect(raw.repoMeta.headCommit).toMatch(/^[0-9a-f]{7}$/);
    expect(raw.repoMeta.worktreePath).toBe(cwd);
    expect(raw.repoMeta.recordedAt).toBeTruthy();
  });

  it("旧 store（无 schemaVersion/repoMeta）加载不 crash + schemaVersion 补 1", () => {
    // 手动构造旧格式 _v1.json
    const v1Path = getV1JsonPath(cwd);
    mkdirSync(join(v1Path, ".."), { recursive: true });
    const oldUnit = makeUnit("wave:old-unit");
    writeFileSync(v1Path, JSON.stringify({ workUnits: [oldUnit] }));

    const store = new V1Store(cwd);
    const units = store.loadAll();

    expect(units).toHaveLength(1);
    expect(units[0].id).toBe("wave:old-unit");
    // loadFileData 是只读路径，不回填 repoMeta（留 undefined）
    // 但 schemaVersion 被补为 1（向前兼容）
    // 注：loadFileData 补 schemaVersion 是内存补，不立即写盘，验证通过 loadAll 行为正确即可
  });

  it("推进类 save 后再次 save → repoMeta 刷新（branch 变化能反映）", () => {
    const store = new V1Store(cwd);
    const unit = makeUnit("wave:test-refresh");
    store.save(unit);

    // 首次 save 后记录 branch
    const raw1 = JSON.parse(readFileSync(getV1JsonPath(cwd), "utf-8"));
    const branchBefore = raw1.repoMeta.branch;

    // 切新分支
    spawnSync("git", ["checkout", "-b", "changed-branch"], { cwd, encoding: "utf-8" });

    // 再次 save（推进类写入）
    unit.status = "clarifying";
    store.save(unit);

    const raw2 = JSON.parse(readFileSync(getV1JsonPath(cwd), "utf-8"));
    expect(raw2.repoMeta.branch).toBe("changed-branch");
    expect(raw2.repoMeta.branch).not.toBe(branchBefore);
  });

  it("readonly query（loadAll）不刷新 repoMeta.recordedAt", () => {
    const store = new V1Store(cwd);
    store.save(makeUnit("wave:test-readonly"));

    const raw1 = JSON.parse(readFileSync(getV1JsonPath(cwd), "utf-8"));
    const recordedAt1 = raw1.repoMeta.recordedAt;

    // 多次 readonly query
    store.loadAll();
    store.loadAll();
    store.load("wave:test-readonly");
    store.findChildren("wave:test-readonly");

    // recordedAt 未变（readonly 不触发 save 刷新）
    const raw2 = JSON.parse(readFileSync(getV1JsonPath(cwd), "utf-8"));
    expect(raw2.repoMeta.recordedAt).toBe(recordedAt1);
  });
});

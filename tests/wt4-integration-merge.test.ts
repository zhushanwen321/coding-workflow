/**
 * wt-4 单测：集成汇聚与回流（W4）。
 *
 * 用例 M1-M8 逐条对应 docs/rewrite/acceptance/wt4-acceptance.md §6：
 *   - M1 汇聚：双子分支 commit → merge 进 root 分支、子分支保留（fx-5：merge 点无资源回收
 *     副作用，分支由 unit 终态成对回收）、报告 head=root 分支 HEAD
 *   - M2 merge 冲突：同文件同区域 → fail + 恢复指引（root worktree 路径 + 内联前缀）+ abort 清现场
 *   - M3 锚定解耦：项目 cwd HEAD 领先且不含子 commit → 可达性检查仍 pass
 *   - M4 root worktree 重建：目录亡分支在 → 集成内自动重建（D5「亡/在」格）
 *   - M5 启动孤儿清扫：closed / 账本不存在 → 回收；未 closed → 保留
 *   - M6 延迟回收：closed 当轮 worktree 仍在、下轮开头回收；root worktree 全程保留
 *   - M7 汇总输出：回收清单 + git merge cw-root/<rootId> 回流指引
 *   - M8 幂等重跑：子 commit 已达 → 跳过 merge、root 分支 HEAD 不动、报告落盘
 *
 * 全部真实环境零 mock：直调 dist 的 runIntegrationVerify / runLoop（真实 git 子进程
 * + 真实账本 EventLedger）+ tmp git 仓库 + 隔离 CW_HOME/CW_WORKTREE_HOME。适配器是
 * 测试专用脚本适配器（wt-2 T3 同款：onSpawn 同步写账本 + wait 立即结算）——调度与
 * 回收时序是本文件的被测对象，账本写入走真实 dist API。注意：直接
 * `npx vitest run tests/wt4-integration-merge.test.ts` 不触发 pretest，需先
 * `npm run build`（`npm test` 的 pretest 已含）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../dist/events/types.js";
import { ledgerForCwd } from "../dist/handlers/common.js";
import { type IntegrateResult, runIntegrationVerify } from "../dist/runner/integrate.js";
import { runLoop } from "../dist/runner/loop.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
  SpawnResult,
} from "../dist/runner/spawn/types.js";
import { addUnitWorktree, removeWorktree } from "../dist/runner/worktree.js";
import { worktreePath } from "../dist/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
for (const required of [join(DIST_ROOT, "cli.js"), join(DIST_ROOT, "runner", "loop.js")]) {
  if (!existsSync(required)) {
    throw new Error(
      `tests/wt4-integration-merge 需要 ${required}（先 npm run build；npm test 的 pretest 已含）`,
    );
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-wt4-"));
const cwHome = join(tmpRoot, "cw-home");
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_HOME = cwHome;
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ROOT_ID = "root";
const ROOT_BRANCH = `cw-root/${ROOT_ID}`;

// ---- 基建：真实 git 子进程 + 真实账本（wt2 / u8 同款） ----

function gitRun(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git -C ${dir} ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 命令期望失败的形态（引用不存在等）；exit 0 反而抛错（断言前提被破坏） */
function gitFails(dir: string, args: readonly string[]): boolean {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  return res.error !== undefined || res.status !== 0;
}

function echoAcceptance(id: string): AcceptanceItem[] {
  return [{ id, core: true, title: `${id} 冒烟`, type: "e2e-real", command: `echo "${id} PASS"` }];
}

/** 过 spec gate 全规则的合法验收（runLoop 驱动用例的 designer 提交物与预置 spec 共用，u7 同款） */
const LOOP_ACCEPTANCE: AcceptanceItem[] = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
];

// ---- 直调集成的 fixture：root split 双子 + 子分支真实 commit 现场 ----

interface ChildSeed {
  unitId: string;
  /** 在子 worktree（分支 cw/root/<unitId>）内做文件改动（随后统一 add+commit） */
  mutate: (wtDir: string) => void;
}

interface SplitFixture {
  repoDir: string;
  base: string;
  rootBranch: string;
  rootWorktreeDir: string;
  /** 子 unitId → 子分支上的 build commit hash */
  childCommits: Map<string, string>;
}

/**
 * 构造 W4 集成前提现场：tmp git 仓库（base commit）+ 账本（root spec-frozen 声明
 * split、每子冻结 spec + verified 证据链）+ 每子一个真实 worktree 分支
 * cw/root/<unitId>（含 mutate 后的 build commit）。root 分支与 root worktree
 * 留给被测的 runIntegrationVerify 步骤 0 建立。
 */
function seedSplitFixture(name: string, children: readonly ChildSeed[]): SplitFixture {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-wt4@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-wt4"]);
  writeFileSync(join(repoDir, "brief.md"), "# wt4 fixture 任务书\n");
  writeFileSync(join(repoDir, "f.txt"), "base\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: base"]);
  const baseCommit = gitRun(repoDir, ["rev-parse", "HEAD"]);

  const ledger = ledgerForCwd(repoDir);
  const rootSpec = {
    acceptance: echoAcceptance("AR1"),
    contracts: [],
    split: children.map((child) => ({ unitId: child.unitId, dependsOn: [] })),
  };
  ledger.append("UnitCreated", {
    unitId: ROOT_ID,
    parentId: null,
    briefRef: join(repoDir, "brief.md"),
  });
  ledger.append("SpecSubmitted", {
    unitId: ROOT_ID,
    specHash: sha(JSON.stringify(rootSpec)),
    acceptance: rootSpec.acceptance,
    contracts: [],
    split: rootSpec.split,
  });
  ledger.append("VerdictSubmitted", { unitId: ROOT_ID, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });

  const childCommits = new Map<string, string>();
  for (const child of children) {
    ledger.append("UnitCreated", {
      unitId: child.unitId,
      parentId: ROOT_ID,
      briefRef: join(repoDir, "brief.md"),
    });
    const childSpec = { acceptance: echoAcceptance(`A-${child.unitId}`), contracts: [], split: [] };
    ledger.append("SpecSubmitted", {
      unitId: child.unitId,
      specHash: sha(JSON.stringify(childSpec)),
      acceptance: childSpec.acceptance,
      contracts: [],
      split: [],
    });
    ledger.append("VerdictSubmitted", {
      unitId: child.unitId,
      verdictKind: "spec-review",
      verdict: "pass",
      role: "reviewer",
    });

    const childWt = worktreePath(WT_HOME, repoDir, child.unitId);
    const added = addUnitWorktree(repoDir, childWt, ROOT_ID, child.unitId, baseCommit);
    if (!added.ok) {
      throw new Error(`fixture：子 worktree 建立失败（${child.unitId}）：${added.error}`);
    }
    child.mutate(childWt);
    gitRun(childWt, ["add", "-A"]);
    gitRun(childWt, ["commit", "-m", `build(${child.unitId}): wt4 fixture 产出`]);
    const commit = gitRun(childWt, ["rev-parse", "HEAD"]);
    childCommits.set(child.unitId, commit);
    // 子交付后回收其 worktree（模拟 fx-5 终态回收的目录侧已执行）：分支按 fx-5
    // 由回收谓词统一处理（tip 经 root 分支可达才删），集成 merge 点不再删分支；
    // 拆掉目录也解除「分支被 worktree 占用」，让回收路径上的 branch -D 可执行
    const removed = removeWorktree(repoDir, childWt);
    if (!removed.ok) {
      throw new Error(`fixture：子 worktree 回收失败（${child.unitId}）：${removed.error}`);
    }

    ledger.append("EvidenceSubmitted", {
      unitId: child.unitId,
      runId: `run-${child.unitId}-1`,
      commit,
      paths: ["f.txt"],
      sha256: [sha("f.txt")],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId: child.unitId,
      runId: `run-${child.unitId}-1`,
      reportHash: sha(`report:${child.unitId}`),
      result: "pass",
      acceptanceIds: [`A-${child.unitId}`],
    });
  }
  return {
    repoDir,
    base: baseCommit,
    rootBranch: ROOT_BRANCH,
    rootWorktreeDir: worktreePath(WT_HOME, repoDir, ROOT_ID),
    childCommits,
  };
}

async function integrateOnce(fx: SplitFixture): Promise<IntegrateResult> {
  return runIntegrationVerify({
    cwd: fx.repoDir,
    rootId: ROOT_ID,
    children: [...fx.childCommits.entries()].map(([unitId, commit]) => ({ unitId, commit })),
    rootAcceptance: echoAcceptance("AR1"),
    contracts: [],
    timeoutMs: 15_000,
  });
}

interface ReportShape {
  head: string;
  children: Array<{ unitId: string; commit: string; reachable: boolean }>;
  /** rv-4：merge 失败独立成节（报告侧不再混在通用 failures——返回值 failures 仍是聚合视图） */
  mergeFailures: string[];
  ok: boolean;
  failures: string[];
}

function readReport(result: IntegrateResult): ReportShape {
  return JSON.parse(readFileSync(result.reportPath, "utf-8")) as ReportShape;
}

/** 捕获 runLoop 的 stdout/stderr（进程内直调，透传 write 回调——u7/wt2 同款） */
async function captureStd(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const collector = (chunks: string[]): typeof process.stdout.write =>
    ((chunk: unknown, cb?: (err?: Error | null) => void) => {
      chunks.push(String(chunk));
      if (typeof cb === "function") {
        cb();
      }
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = collector(outChunks);
  process.stderr.write = collector(errChunks);
  try {
    const code = await fn();
    return { code, out: outChunks.join(""), err: errChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ================================================================
// M1 汇聚 + M8 幂等重跑（同 fixture 两阶段断言，各条款独立 it）
// ================================================================

describe("wt4 M1 汇聚：子分支 commit 经 merge 显式汇入 root 分支", () => {
  it("集成 pass → root 分支 HEAD 对两子 commit 均 isAncestor；报告 head=root 分支 HEAD（≠项目 HEAD）；两子分支保留（fx-5：merge 点不删分支）；log 含子 commit", async () => {
    const fx = seedSplitFixture("m1", [
      { unitId: "unit-a", mutate: (wt) => writeFileSync(join(wt, "a.txt"), "a\n") },
      { unitId: "unit-b", mutate: (wt) => writeFileSync(join(wt, "b.txt"), "b\n") },
    ]);

    const result = await integrateOnce(fx);

    expect(result.ok, `failures: ${result.failures.join(" | ")}`).toBe(true);
    // root 分支 HEAD 对两子 commit 均可达（isAncestor）
    for (const commit of fx.childCommits.values()) {
      expect(gitFails(fx.repoDir, ["merge-base", "--is-ancestor", commit, ROOT_BRANCH])).toBe(false);
    }
    // 报告 head = root 分支 HEAD，且 ≠ 项目 cwd HEAD（项目 HEAD 停在 base）
    const rootBranchHead = gitRun(fx.repoDir, ["rev-parse", ROOT_BRANCH]);
    expect(readReport(result).head).toBe(rootBranchHead);
    expect(rootBranchHead).not.toBe(gitRun(fx.repoDir, ["rev-parse", "HEAD"]));
    // 两子分支保留（fx-5 行为变更回归锚点：merge 成功不再删分支，回收统一走
    // unit 终态成对回收——fx5-unit-reclaim.test.ts 验证后续回收）
    expect(gitFails(fx.repoDir, ["rev-parse", "--verify", "--quiet", `cw/${ROOT_ID}/unit-a`])).toBe(false);
    expect(gitFails(fx.repoDir, ["rev-parse", "--verify", "--quiet", `cw/${ROOT_ID}/unit-b`])).toBe(false);
    // root 分支历史含子 commit
    const log = gitRun(fx.repoDir, ["log", "--format=%s", ROOT_BRANCH]);
    expect(log).toContain("build(unit-a): wt4 fixture 产出");
    expect(log).toContain("build(unit-b): wt4 fixture 产出");
  }, 30_000);
});

describe("wt4 M8 幂等重跑：子 commit 已达 → 跳过 merge", () => {
  it("集成 pass 后再次 runIntegrationVerify → ok=true、root 分支 HEAD 不动（零 merge commit）、报告落盘", async () => {
    const fx = seedSplitFixture("m8", [
      { unitId: "unit-a", mutate: (wt) => writeFileSync(join(wt, "a.txt"), "a\n") },
      { unitId: "unit-b", mutate: (wt) => writeFileSync(join(wt, "b.txt"), "b\n") },
    ]);

    const first = await integrateOnce(fx);
    expect(first.ok).toBe(true);
    const headAfterFirst = gitRun(fx.repoDir, ["rev-parse", ROOT_BRANCH]);

    const second = await integrateOnce(fx);

    expect(second.ok, `failures: ${second.failures.join(" | ")}`).toBe(true);
    // 已达跳过 merge：root 分支 HEAD 不动（若误 merge 会产生新 merge commit 或至少动 HEAD）
    expect(gitRun(fx.repoDir, ["rev-parse", ROOT_BRANCH])).toBe(headAfterFirst);
    // 子分支仍在（fx-5：merge 点不删分支；跳过路径在可达性判定处短路，不依赖分支存亡）
    expect(gitFails(fx.repoDir, ["rev-parse", "--verify", "--quiet", `cw/${ROOT_ID}/unit-a`])).toBe(false);
    expect(existsSync(second.reportPath)).toBe(true);
    expect(readReport(second).children.every((c) => c.reachable)).toBe(true);
  }, 30_000);
});

// ================================================================
// M2 merge 冲突
// ================================================================

describe("wt4 M2 merge 冲突：fail + abort 清现场 + 恢复指引", () => {
  it("双子改 f.txt 同区域 → 集成 fail；failures 含冲突 unitId、root worktree 路径与 CW_PROJECT_DIR 内联前缀；现场已 abort（porcelain 干净）；报告落盘", async () => {
    const fx = seedSplitFixture("m2", [
      { unitId: "unit-a", mutate: (wt) => writeFileSync(join(wt, "f.txt"), "changed-by-a\n") },
      { unitId: "unit-b", mutate: (wt) => writeFileSync(join(wt, "f.txt"), "changed-by-b\n") },
    ]);

    const result = await integrateOnce(fx);

    expect(result.ok).toBe(false);
    const joined = result.failures.join("\n");
    // 冲突事实指向后 merge 的子（unit-b 与 root 分支上的 unit-a 改动冲突）
    expect(joined).toContain("unit-b");
    expect(joined).toContain("merge 冲突");
    // 恢复指引：root worktree 路径 + 内联前缀形态（人 cd 过去解决、cw 命令锚定项目账本）
    expect(joined).toContain(fx.rootWorktreeDir);
    expect(joined).toContain(`CW_PROJECT_DIR="${fx.repoDir}"`);
    // 冲突现场已 abort：root worktree porcelain 干净（fx-4 起 spawn 产物在 topic 目录，worktree 内无 cw 文件）
    const porcelain = spawnSync("git", ["-C", fx.rootWorktreeDir, "status", "--porcelain"], {
      encoding: "utf-8",
    });
    expect((porcelain.stdout ?? "").trim()).toBe("");
    // 报告落盘且含冲突事实（fail VerifyRan 的 reportHash 有文件可指）。
    // rv-4 语义迁移：merge 失败在报告侧独立成 mergeFailures 节（不再混在通用
    // failures 里丢失结构）；返回值 failures 仍是含 merge 文本的聚合视图（stderr 消费）
    expect(existsSync(result.reportPath)).toBe(true);
    expect(readReport(result).mergeFailures.some((f) => f.includes("merge 冲突"))).toBe(true);
    expect(readReport(result).failures.some((f) => f.includes("merge 冲突"))).toBe(false);
    // 先 merge 的子不受牵连：unit-a 已汇聚、unit-b 未汇聚——两分支均保留（fx-5：
    // merge 点不删分支；unit-b 分支是修复后重试的现场，unit-a 分支由终态回收统一收）
    expect(gitFails(fx.repoDir, ["rev-parse", "--verify", "--quiet", `cw/${ROOT_ID}/unit-a`])).toBe(false);
    expect(gitFails(fx.repoDir, ["rev-parse", "--verify", "--quiet", `cw/${ROOT_ID}/unit-b`])).toBe(false);
  }, 30_000);
});

// ================================================================
// M3 锚定解耦
// ================================================================

describe("wt4 M3 锚定解耦：项目 cwd HEAD 领先 root 分支 base 且不含子 commit", () => {
  it("集成可达性检查仍 pass（旧锚定下对项目 HEAD 判定会全灭）；报告 head ≠ 项目 HEAD", async () => {
    const fx = seedSplitFixture("m3", [
      { unitId: "unit-a", mutate: (wt) => writeFileSync(join(wt, "a.txt"), "a\n") },
      { unitId: "unit-b", mutate: (wt) => writeFileSync(join(wt, "b.txt"), "b\n") },
    ]);
    // 项目 cwd 独立前进：改 f.txt（与子的 a.txt/b.txt 不冲突），HEAD 领先 base 且不含子 commit
    writeFileSync(join(fx.repoDir, "f.txt"), "project-advanced\n");
    gitRun(fx.repoDir, ["add", "-A"]);
    gitRun(fx.repoDir, ["commit", "-m", "project: advance HEAD beyond base"]);
    const projectHead = gitRun(fx.repoDir, ["rev-parse", "HEAD"]);
    expect(projectHead).not.toBe(fx.base);
    // 前提复核（旧锚定全灭的对照面）：子 commit 确实不在项目 HEAD 可达
    for (const commit of fx.childCommits.values()) {
      expect(gitFails(fx.repoDir, ["merge-base", "--is-ancestor", commit, "HEAD"])).toBe(true);
    }

    const result = await integrateOnce(fx);

    expect(result.ok, `failures: ${result.failures.join(" | ")}`).toBe(true);
    const report = readReport(result);
    expect(report.children.every((c) => c.reachable)).toBe(true);
    expect(report.head).toBe(gitRun(fx.repoDir, ["rev-parse", ROOT_BRANCH]));
    expect(report.head).not.toBe(projectHead);
  }, 30_000);
});

// ================================================================
// M4 root worktree 重建
// ================================================================

describe("wt4 M4 root worktree 重建（D5「亡/在」格）", () => {
  it("集成前删 root worktree 目录（保留分支与注册残留）→ 集成内自动重建 → merge/verify 正常完成", async () => {
    const fx = seedSplitFixture("m4", [
      { unitId: "unit-a", mutate: (wt) => writeFileSync(join(wt, "a.txt"), "a\n") },
      { unitId: "unit-b", mutate: (wt) => writeFileSync(join(wt, "b.txt"), "b\n") },
    ]);
    // 首次集成建立 root 分支现场并 pass；随后模拟异常退出：目录直接删除（注册残留）
    const first = await integrateOnce(fx);
    expect(first.ok).toBe(true);
    const headAfterFirst = gitRun(fx.repoDir, ["rev-parse", ROOT_BRANCH]);
    rmSync(fx.rootWorktreeDir, { recursive: true, force: true });
    expect(existsSync(fx.rootWorktreeDir)).toBe(false);

    const second = await integrateOnce(fx);

    // 「亡/在」格：挂既有分支重建目录；子 commit 已达跳过 merge → 验证正常完成
    expect(second.ok, `failures: ${second.failures.join(" | ")}`).toBe(true);
    expect(existsSync(fx.rootWorktreeDir)).toBe(true);
    expect(gitRun(fx.repoDir, ["rev-parse", ROOT_BRANCH])).toBe(headAfterFirst);
    expect(gitRun(fx.rootWorktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(ROOT_BRANCH);
  }, 30_000);
});

// ================================================================
// M5 启动孤儿清扫
// ================================================================

describe("wt4 M5 启动孤儿清扫（J3 跨 run 兜底）", () => {
  it("预置三类 worktree（已 closed unit / 未 closed unit / 账本不存在的 unitId）→ runLoop 启动后前两类回收、未 closed 保留", async () => {
    const repoDir = (() => {
      const base = join(tmpRoot, "m5");
      mkdirSync(base, { recursive: true });
      const dir = realpathSync(base);
      gitRun(dir, ["init"]);
      gitRun(dir, ["config", "user.email", "cw-wt4@example.com"]);
      gitRun(dir, ["config", "user.name", "cw-wt4"]);
      writeFileSync(join(dir, "brief.md"), "# m5 fixture\n");
      gitRun(dir, ["add", "-A"]);
      gitRun(dir, ["commit", "-m", "fixture: base"]);
      return dir;
    })();
    const head = gitRun(repoDir, ["rev-parse", "HEAD"]);

    // 账本：root created；unit-closed 全链 closed；unit-live 仅 created（未 closed）
    const ledger = ledgerForCwd(repoDir);
    ledger.append("UnitCreated", { unitId: ROOT_ID, parentId: null, briefRef: join(repoDir, "brief.md") });
    ledger.append("UnitCreated", {
      unitId: "unit-closed",
      parentId: ROOT_ID,
      briefRef: join(repoDir, "brief.md"),
    });
    const closedSpec = { acceptance: LOOP_ACCEPTANCE, contracts: [], split: [] };
    ledger.append("SpecSubmitted", {
      unitId: "unit-closed",
      specHash: sha(JSON.stringify(closedSpec)),
      acceptance: closedSpec.acceptance,
      contracts: [],
      split: [],
    });
    ledger.append("VerdictSubmitted", { unitId: "unit-closed", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    ledger.append("EvidenceSubmitted", {
      unitId: "unit-closed",
      runId: "run-closed-1",
      commit: head,
      paths: ["brief.md"],
      sha256: [sha("brief.md")],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId: "unit-closed",
      runId: "run-closed-1",
      reportHash: sha("report:unit-closed"),
      result: "pass",
      acceptanceIds: LOOP_ACCEPTANCE.map((ac) => ac.id),
    });
    ledger.append("VerdictSubmitted", { unitId: "unit-closed", verdictKind: "exec-review", verdict: "pass" });
    ledger.append("UnitCreated", {
      unitId: "unit-live",
      parentId: ROOT_ID,
      briefRef: join(repoDir, "brief.md"),
    });

    // 三类真实 worktree：closed / 未 closed / 账本不存在
    const wtOf = (unitId: string) => worktreePath(WT_HOME, repoDir, unitId);
    for (const unitId of ["unit-closed", "unit-live", "unit-ghost"]) {
      const added = addUnitWorktree(repoDir, wtOf(unitId), ROOT_ID, unitId, head);
      expect(added).toEqual({ ok: true });
    }

    // hold adapter：挂住不结算，循环由 maxIdle 兜底退出（清扫发生在启动段，先于派发）
    const hold: AgentSpawnAdapter = {
      name: "wt4-hold",
      spawn: async () => ({
        wait: () => new Promise<SpawnResult>(() => {}),
        kill: () => {},
      }),
    };
    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter: hold, cwd: repoDir, pollMs: 30, maxIdleMs: 500 }),
    );

    expect(captured.code).toBe(1); // hold 无账本进展 → maxIdle 兜底（不炸即达意）
    // 第一、三类回收（目录消失）；第二类保留
    expect(existsSync(wtOf("unit-closed"))).toBe(false);
    expect(existsSync(wtOf("unit-ghost"))).toBe(false);
    expect(existsSync(wtOf("unit-live"))).toBe(true);
    // 可观测性：启动段打印清扫清单
    expect(captured.out).toContain("启动孤儿清扫");
    expect(captured.out).toContain("unit-closed");
    expect(captured.out).toContain("unit-ghost");
  }, 20_000);
});

// ================================================================
// M6 延迟回收 + M7 汇总输出（runLoop 驱动全链）
// ================================================================

/** M6/M7 的进度适配器观测（closed 当轮 / 下轮回收 / root worktree 全程在） */
interface ProgressObs {
  /** developer(root) spawn 时（unit-a closed 已入账的下一轮）unit-a worktree 是否仍在 */
  developerSawUnitA: boolean | null;
  /** reviewer(root) spawn 时（再下一轮，J4 已执行回收）unit-a worktree 是否已回收 */
  reviewerSawUnitA: boolean | null;
  /** 任意 spawn 时点 root worktree 是否曾缺位（期望 false：全程保留） */
  rootWorktreeEverMissing: boolean;
}

/**
 * 脚本化推进适配器：按 role 对真实账本写入（designer 写 root spec + 过审、
 * reviewer 写 exec-review、developer 写 evidence + VerifyRan——u7 worker 的职责边界
 * 同款：本文件测调度与回收时序，verify 真实性属 u4/u5 已验收领地）。
 * spawn 时点捕获 unit-a / root worktree 存在性供 M6 断言。
 */
function makeProgressAdapter(unitAId: string, rootCommit: string): {
  adapter: AgentSpawnAdapter;
  obs: ProgressObs;
} {
  const obs: ProgressObs = {
    developerSawUnitA: null,
    reviewerSawUnitA: null,
    rootWorktreeEverMissing: false,
  };
  return {
    adapter: {
      name: "wt4-progress",
      spawn: async (req: AgentSpawnRequest): Promise<SpawnHandle> => {
        if (!existsSync(worktreePath(WT_HOME, req.projectCwd, ROOT_ID))) {
          obs.rootWorktreeEverMissing = true;
        }
        const ledger = ledgerForCwd(req.projectCwd);
        if (req.role === "designer") {
          const spec = { acceptance: LOOP_ACCEPTANCE, contracts: [], split: [] };
          ledger.append("SpecSubmitted", {
            unitId: req.unitId,
            specHash: sha(JSON.stringify(spec)),
            acceptance: LOOP_ACCEPTANCE,
            contracts: [],
            split: [],
          });
          ledger.append("VerdictSubmitted", { unitId: req.unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
        } else if (req.role === "reviewer") {
          if (req.unitId === ROOT_ID) {
            obs.reviewerSawUnitA = existsSync(worktreePath(WT_HOME, req.projectCwd, unitAId));
          }
          ledger.append("VerdictSubmitted", {
            unitId: req.unitId,
            verdictKind: "exec-review",
            verdict: "pass",
          });
        } else {
          if (req.unitId === ROOT_ID) {
            obs.developerSawUnitA = existsSync(worktreePath(WT_HOME, req.projectCwd, unitAId));
          }
          const runId = `run-${req.unitId}-1`;
          ledger.append("EvidenceSubmitted", {
            unitId: req.unitId,
            runId,
            commit: rootCommit,
            paths: ["brief.md"],
            sha256: [sha("brief.md")],
            exitCode: 0,
          });
          ledger.append("VerifyRan", {
            unitId: req.unitId,
            runId,
            reportHash: sha(`report:${req.unitId}`),
            result: "pass",
            acceptanceIds: LOOP_ACCEPTANCE.map((ac) => ac.id),
          });
        }
        return {
          wait: () =>
            Promise.resolve({
              exitCode: 0,
              // fx-4：产物路径从 req.artifactDir 拼装（run 级 topic 目录）
              stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
              stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
              pid: -1,
            } satisfies SpawnResult),
          kill: () => {},
        };
      },
    },
    obs,
  };
}

/** M6/M7 共用 fixture：root created + unit-a 预置 spec-frozen + verified（未 closed） */
function seedLoopFixture(name: string): { repoDir: string; head: string } {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-wt4@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-wt4"]);
  writeFileSync(join(repoDir, "brief.md"), "# wt4 loop fixture\n");
  writeFileSync(join(repoDir, "app.js"), "console.log('app');\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: base"]);
  const head = gitRun(repoDir, ["rev-parse", "HEAD"]);

  const ledger = ledgerForCwd(repoDir);
  ledger.append("UnitCreated", { unitId: ROOT_ID, parentId: null, briefRef: join(repoDir, "brief.md") });
  // unit-a：root 的直接子（parentId 挂钩、root spec 不声明 split——树感知 closed
  // 仍要求它 closed，制造「root 等子收尾」的回收观测窗口）
  ledger.append("UnitCreated", {
    unitId: "unit-a",
    parentId: ROOT_ID,
    briefRef: join(repoDir, "brief.md"),
  });
  const spec = { acceptance: LOOP_ACCEPTANCE, contracts: [], split: [] };
  ledger.append("SpecSubmitted", {
    unitId: "unit-a",
    specHash: sha(JSON.stringify(spec)),
    acceptance: spec.acceptance,
    contracts: [],
    split: [],
  });
  ledger.append("VerdictSubmitted", { unitId: "unit-a", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
  ledger.append("EvidenceSubmitted", {
    unitId: "unit-a",
    runId: "run-unit-a-1",
    commit: head,
    paths: ["brief.md"],
    sha256: [sha("brief.md")],
    exitCode: 0,
  });
  ledger.append("VerifyRan", {
    unitId: "unit-a",
    runId: "run-unit-a-1",
    reportHash: sha("report:unit-a"),
    result: "pass",
    acceptanceIds: LOOP_ACCEPTANCE.map((ac) => ac.id),
  });
  return { repoDir, head };
}

describe("wt4 M6 延迟回收（J4：closed 当轮仍在、下轮开头回收；root 全程保留）", () => {
  it("unit-a closed 后当轮派发的 developer(root) 仍见其 worktree；下一轮回收后 reviewer(root) 不再见到；root worktree 全程保留", async () => {
    const { repoDir, head } = seedLoopFixture("m6");
    const { adapter, obs } = makeProgressAdapter("unit-a", head);

    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 20_000 }),
    );

    expect(captured.code).toBe(0); // root closed 全链收束
    // unit-a closed（轮 1 末 reviewer 写 exec-review）→ 轮 2 收集不回收 →
    // developer(root)（轮 2 派发）spawn 时仍在（debug 留一轮窗口）
    expect(obs.developerSawUnitA).toBe(true);
    // 轮 3 开头 J4 执行回收 → reviewer(root)（轮 3+ 派发）spawn 时已回收
    expect(obs.reviewerSawUnitA).toBe(false);
    // root worktree 全程保留（回流载体），run 结束后仍在
    expect(obs.rootWorktreeEverMissing).toBe(false);
    expect(existsSync(worktreePath(WT_HOME, repoDir, ROOT_ID))).toBe(true);
    expect(existsSync(worktreePath(WT_HOME, repoDir, "unit-a"))).toBe(false);
  }, 30_000);
});

describe("wt4 M7 汇总输出（G5 回流指引）", () => {
  it("root closed 的 summary 含「已回收 unit 资源（worktree 目录+子分支）× N；保留 worktree × M」清单与 git merge cw-root/<rootId> 回流指引行", async () => {
    const { repoDir, head } = seedLoopFixture("m7");
    const { adapter } = makeProgressAdapter("unit-a", head);

    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 20_000 }),
    );

    expect(captured.code).toBe(0);
    expect(captured.out).toContain('root "root" 已 closed');
    // 回收清单（fx-5 措辞：unit 资源 = worktree 目录 + 子分支成对）：unit-a 已
    // 回收；root worktree 保留（回流载体）
    expect(captured.out).toContain("已回收 unit 资源（worktree 目录+子分支）× 1（unit-a）");
    expect(captured.out).toContain("保留 worktree × 1（root）");
    // 回流指引：一条 git merge 命令直接可抄
    expect(captured.out).toContain(`git merge ${ROOT_BRANCH}`);
    expect(captured.out).toContain(`成果分支：${ROOT_BRANCH}`);
  }, 30_000);
});

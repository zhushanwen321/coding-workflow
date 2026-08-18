/**
 * fx-5 单测：unit 资源（worktree 目录 + 子分支）状态驱动成对回收。
 *
 * 修复的 bug（M3 gate 两次复现）：分支删除唯一自动点内联在集成 merge 成功路径，
 * 「merge 冲突 → 人工解 → 集成重跑」路径上子 commit 已可达、走已达跳过，永久绕过
 * 删除点 → 子分支残留。fx-5 长方案：merge 点去掉资源回收副作用，目录+分支统一
 * 由 unit 终态 × tip 可达性谓词成对回收（延迟回收 / 启动清扫双道）。
 *
 * 场景（对应 fx-5 验收）：
 *   - fx5-1 成对回收：closed unit 分支已 merge 进 root 分支 → reclaimUnit 双消
 *   - fx5-2 保守保留：tip 不可达 → 目录消、分支留、error 含手动清理指引
 *   - fx5-3 孤儿分支（bug 现场复刻）：目录已亡、分支残留且 tip 可达 → 启动清扫
 *     的 ref 扫回收分支
 *   - fx5-4 并行 root 不误删：另一 root 的 open unit 分支在清扫后保留
 *   - fx5-5 M3 gate 全链：冲突 → 人工解 → 集成重跑 pass → 清扫回收 → 两子目录+
 *     分支成对消失（残留场景在长方案下 by construction 消失的证明）
 *
 * 全部真实环境零 mock：直调 dist 的 reclaimUnit / runLoop / runIntegrationVerify
 * （真实 git 子进程 + 真实账本 EventLedger）+ tmp git 仓库 + 隔离
 * CW_HOME/CW_WORKTREE_HOME。loop 内部函数（清扫/延迟回收）不导出——按 wt4 M5
 * 先例经 runLoop + captureStd 走完整 dispatch 路径驱动。
 * 注意：直接 `npx vitest run tests/fx5-unit-reclaim.test.ts` 不触发 pretest，
 * 需先 `npm run build`（`npm test` 的 pretest 已含）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../dist/events/types.js";
import { ledgerForCwd } from "../dist/handlers/common.js";
import { type IntegrateResult, runIntegrationVerify } from "../dist/runner/integrate.js";
import { runLoop } from "../dist/runner/loop.js";
import type { AgentSpawnAdapter, SpawnResult } from "../dist/runner/spawn/types.js";
import {
  addUnitWorktree,
  listUnitBranchRefs,
  reclaimUnit,
  removeWorktree,
} from "../dist/runner/worktree.js";
import { worktreePath } from "../dist/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
for (const required of [join(DIST_ROOT, "cli.js"), join(DIST_ROOT, "runner", "loop.js")]) {
  if (!existsSync(required)) {
    throw new Error(
      `tests/fx5-unit-reclaim 需要 ${required}（先 npm run build；npm test 的 pretest 已含）`,
    );
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fx5-"));
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
const ROOT_ID = "rt";
const ROOT_BRANCH = `cw-root/${ROOT_ID}`;

// ---- 基建：真实 git 子进程 + 真实账本（wt4 同款脚手架） ----

function gitRun(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git -C ${dir} ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 引用不存在等期望失败形态；exit 0 反而抛错（断言前提被破坏） */
function refMissing(repoDir: string, ref: string): boolean {
  const res = spawnSync("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", ref], {
    encoding: "utf-8",
  });
  return res.error !== undefined || res.status !== 0;
}

/**
 * 过 spec gate 全规则且集成重跑真实可过的验收：规则②③ 的 core e2e-real（echo
 * 标记行，不依赖仓库文件）+ 规则⑤ 的 unit 级（u8-e2e 的 unitJson 同款：真实
 * node 命令产出 vitest JSON 形态产物，fullName 含验收 id）。
 */
function unitAcceptance(id: string): AcceptanceItem[] {
  return [
    { id, core: true, title: `${id} 冒烟`, type: "e2e-real", command: `echo "${id} PASS"` },
    {
      id: `${id}-u`,
      core: false,
      title: `${id} 单元级`,
      type: "unit",
      command:
        `node -e "console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'${id}-u unit smoke',status:'passed'}]}]}))" -- --reporter=json`,
    },
  ];
}

/** 真实 git 仓库（含一个真实 commit）——u2-evidence.test.ts 的 initRepo 同模式 */
function initRepo(name: string): { repoDir: string; head: string } {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-fx5@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-fx5"]);
  writeFileSync(join(repoDir, "brief.md"), "# fx5 fixture 任务书\n");
  writeFileSync(join(repoDir, "f.txt"), "base\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: base"]);
  return { repoDir, head: gitRun(repoDir, ["rev-parse", "HEAD"]) };
}

const wtOf = (repoDir: string, unitId: string) => worktreePath(WT_HOME, repoDir, unitId);

/** hold adapter：挂住不结算，循环由 maxIdle 兜底退出（清扫发生在启动段，先于派发） */
const hold: AgentSpawnAdapter = {
  name: "fx5-hold",
  spawn: async () => ({
    wait: () => new Promise<SpawnResult>(() => {}),
    kill: () => {},
  }),
};

/** 捕获 runLoop 的 stdout/stderr（进程内直调，透传 write 回调——u7/wt4 同款） */
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

/** 建 root worktree（分支 cw-root/<rootId>，检出在目录） */
function addRootWorktree(repoDir: string, rootId: string, head: string): string {
  const dir = wtOf(repoDir, rootId);
  const added = addUnitWorktree(repoDir, dir, rootId, rootId, head);
  if (!added.ok) {
    throw new Error(`fixture：root worktree 建立失败（${rootId}）：${added.error}`);
  }
  return dir;
}

/** 建子 worktree 并在其分支上做一个 commit，返回 (目录, tip) */
function addChildWithCommit(
  repoDir: string,
  rootId: string,
  unitId: string,
  head: string,
  mutate: (wtDir: string) => void,
): { dir: string; tip: string } {
  const dir = wtOf(repoDir, unitId);
  const added = addUnitWorktree(repoDir, dir, rootId, unitId, head);
  if (!added.ok) {
    throw new Error(`fixture：子 worktree 建立失败（${unitId}）：${added.error}`);
  }
  mutate(dir);
  gitRun(dir, ["add", "-A"]);
  gitRun(dir, ["commit", "-m", `build(${unitId}): fx5 fixture 产出`]);
  return { dir, tip: gitRun(dir, ["rev-parse", "HEAD"]) };
}

/** 账本写入 unit 的 verified 证据链（spec 过审 → evidence → VerifyRan pass） */
function seedVerifiedUnit(
  repoDir: string,
  unitId: string,
  parentId: string,
  commit: string,
): void {
  const ledger = ledgerForCwd(repoDir);
  ledger.append("UnitCreated", {
    unitId,
    parentId,
    briefRef: join(repoDir, "brief.md"),
  });
  const acceptance = unitAcceptance(`A-${unitId}`);
  const spec = { acceptance, contracts: [], split: [] };
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: sha(JSON.stringify(spec)),
    acceptance: spec.acceptance,
    contracts: [],
    split: [],
  });
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass" });
  ledger.append("EvidenceSubmitted", {
    unitId,
    runId: `run-${unitId}-1`,
    commit,
    paths: ["f.txt"],
    sha256: [sha("f.txt")],
    exitCode: 0,
  });
  ledger.append("VerifyRan", {
    unitId,
    runId: `run-${unitId}-1`,
    reportHash: sha(`report:${unitId}`),
    result: "pass",
    acceptanceIds: acceptance.map((ac) => ac.id),
  });
}

// ================================================================
// fx5-1 成对回收
// ================================================================

describe("fx5-1 成对回收：closed unit（分支已 merge 进 root 分支）", () => {
  it("reclaimUnit → 目录与分支齐消；root 分支/worktree 不受牵连；重复回收幂等双 ok", () => {
    const { repoDir, head } = initRepo("pair");
    const rootWt = addRootWorktree(repoDir, ROOT_ID, head);
    const child = addChildWithCommit(repoDir, ROOT_ID, "unit-x", head, (wt) =>
      writeFileSync(join(wt, "x.txt"), "x\n"),
    );
    // tip 经 root 分支可达（产出已回流）
    gitRun(rootWt, ["merge", "--no-edit", `cw/${ROOT_ID}/unit-x`]);

    const res = reclaimUnit(repoDir, ROOT_ID, "unit-x");

    expect(res.worktree).toEqual({ ok: true });
    expect(res.branch).toEqual({ ok: true });
    expect(existsSync(child.dir)).toBe(false);
    expect(refMissing(repoDir, `cw/${ROOT_ID}/unit-x`)).toBe(true);
    expect(refMissing(repoDir, ROOT_BRANCH)).toBe(false);
    expect(existsSync(rootWt)).toBe(true);
    // 幂等：目录/分支均已亡时再收仍双 ok（不报错）
    expect(reclaimUnit(repoDir, ROOT_ID, "unit-x")).toEqual({
      worktree: { ok: true },
      branch: { ok: true },
    });
  });
});

// ================================================================
// fx5-2 tip 不可达保守保留
// ================================================================

describe("fx5-2 保守保留：root 分支未包含子分支 tip", () => {
  it("reclaimUnit → 目录消、分支留；branch outcome error 含保留原因与手动清理命令", () => {
    const { repoDir, head } = initRepo("unreach");
    addRootWorktree(repoDir, ROOT_ID, head); // root 分支停在 base
    const child = addChildWithCommit(repoDir, ROOT_ID, "unit-y", head, (wt) =>
      writeFileSync(join(wt, "y.txt"), "y\n"),
    ); // 子分支领先，tip 未回流

    const res = reclaimUnit(repoDir, ROOT_ID, "unit-y");

    expect(res.worktree).toEqual({ ok: true });
    expect(res.branch.ok).toBe(false);
    if (!res.branch.ok) {
      expect(res.branch.error).toContain("不在 root 分支");
      expect(res.branch.error).toContain("恢复动作");
      expect(res.branch.error).toContain(`git -C "${repoDir}" branch -D cw/${ROOT_ID}/unit-y`);
    }
    expect(existsSync(child.dir)).toBe(false);
    expect(refMissing(repoDir, `cw/${ROOT_ID}/unit-y`)).toBe(false);
  });
});

// ================================================================
// fx5-3 孤儿分支（bug 现场复刻：目录已亡、分支残留且 tip 可达）
// ================================================================

describe("fx5-3 孤儿分支回收：启动清扫的 ref 扫（M3 gate 残留现场复刻）", () => {
  it("closed unit 目录已亡、分支残留且 tip 可达 → runLoop 启动清扫回收该分支；root 资源不动", async () => {
    const { repoDir, head } = initRepo("orphan");
    const rootWt = addRootWorktree(repoDir, ROOT_ID, head);
    const child = addChildWithCommit(repoDir, ROOT_ID, "unit-x", head, (wt) =>
      writeFileSync(join(wt, "x.txt"), "x\n"),
    );
    gitRun(rootWt, ["merge", "--no-edit", `cw/${ROOT_ID}/unit-x`]);
    // 复刻残留形态：目录侧已回收（延迟回收先行）、分支残留（merge 点删除被绕过）
    const removed = removeWorktree(repoDir, child.dir);
    if (!removed.ok) {
      throw new Error(`fixture：子 worktree 回收失败：${removed.error}`);
    }
    expect(existsSync(child.dir)).toBe(false);
    expect(refMissing(repoDir, `cw/${ROOT_ID}/unit-x`)).toBe(false); // 分支残留前提
    // ref 扫描能发现该孤儿（目录扫不可见）
    expect(listUnitBranchRefs(repoDir)).toEqual([
      { rootId: ROOT_ID, unitId: "unit-x", branch: `cw/${ROOT_ID}/unit-x` },
    ]);

    // 账本：root created；unit-x 全链 closed（evidence commit = 分支 tip）
    const ledger = ledgerForCwd(repoDir);
    ledger.append("UnitCreated", {
      unitId: ROOT_ID,
      parentId: null,
      briefRef: join(repoDir, "brief.md"),
    });
    seedVerifiedUnit(repoDir, "unit-x", ROOT_ID, child.tip);
    ledger.append("VerdictSubmitted", { unitId: "unit-x", verdictKind: "exec-review", verdict: "pass" });

    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter: hold, cwd: repoDir, pollMs: 30, maxIdleMs: 400 }),
    );

    expect(captured.code).toBe(1); // hold 无账本进展 → maxIdle 兜底（不炸即达意）
    // 孤儿分支被启动清扫回收
    expect(refMissing(repoDir, `cw/${ROOT_ID}/unit-x`)).toBe(true);
    // root 侧资源不动（worktree 回流载体；cw-root/ 成果分支不在 cw/ 命名空间）
    expect(refMissing(repoDir, ROOT_BRANCH)).toBe(false);
    expect(existsSync(rootWt)).toBe(true);
    expect(captured.out).toContain("启动孤儿清扫");
    expect(captured.out).toContain("unit-x");
  }, 20_000);
});

// ================================================================
// fx5-4 并行 root 不误删
// ================================================================

describe("fx5-4 并行 root 不误删：另一 root 的 open unit", () => {
  it("清扫后另一 root 的 open unit 分支与目录、其 root 成果分支与 worktree 均保留", async () => {
    const { repoDir, head } = initRepo("parallel");
    const otherRootId = "rootb";
    // 账本：本 run 的 root（rt）+ 另一 root（rootb）+ 其 open 子 unit
    const ledger = ledgerForCwd(repoDir);
    ledger.append("UnitCreated", {
      unitId: ROOT_ID,
      parentId: null,
      briefRef: join(repoDir, "brief.md"),
    });
    ledger.append("UnitCreated", {
      unitId: otherRootId,
      parentId: null,
      briefRef: join(repoDir, "brief.md"),
    });
    ledger.append("UnitCreated", {
      unitId: "unit-y",
      parentId: otherRootId,
      briefRef: join(repoDir, "brief.md"),
    });
    const otherRootWt = addRootWorktree(repoDir, otherRootId, head);
    const otherChild = addChildWithCommit(repoDir, otherRootId, "unit-y", head, (wt) =>
      writeFileSync(join(wt, "y.txt"), "y\n"),
    );

    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter: hold, cwd: repoDir, pollMs: 30, maxIdleMs: 400 }),
    );

    expect(captured.code).toBe(1);
    // open（created）unit 的分支与目录保留；其 root 的成果分支与 worktree 保留
    expect(refMissing(repoDir, `cw/${otherRootId}/unit-y`)).toBe(false);
    expect(existsSync(otherChild.dir)).toBe(true);
    expect(refMissing(repoDir, `cw-root/${otherRootId}`)).toBe(false);
    expect(existsSync(otherRootWt)).toBe(true);
    // 清扫清单不包含它们（无可回收项时无清扫输出）
    expect(captured.out).not.toContain("unit-y");
    expect(captured.out).not.toContain(otherRootId);
  }, 20_000);
});

// ================================================================
// fx5-5 M3 gate 全链：冲突 → 人工解 → 集成重跑 → 成对回收
// ================================================================

describe("fx5-5 M3 gate 全链：merge 冲突 → 人工解 → 集成重跑 pass → 清扫成对回收", () => {
  it("两子同改 f.txt 冲突 → 集成 fail → 人工解（git 模拟处置者）→ 重跑集成 pass → 启动清扫后两子目录+分支成对消失", async () => {
    const { repoDir, head } = initRepo("m3gate");
    const rootWt = addRootWorktree(repoDir, ROOT_ID, head);

    // 两子同改 f.txt 同区域（制造冲突）；子 worktree 保留（回收延后到终态之后）
    const childA = addChildWithCommit(repoDir, ROOT_ID, "unit-a", head, (wt) =>
      writeFileSync(join(wt, "f.txt"), "changed-by-a\n"),
    );
    const childB = addChildWithCommit(repoDir, ROOT_ID, "unit-b", head, (wt) =>
      writeFileSync(join(wt, "f.txt"), "changed-by-b\n"),
    );

    // 账本：root spec-frozen 声明 split；两子 verified 证据链
    const ledger = ledgerForCwd(repoDir);
    ledger.append("UnitCreated", {
      unitId: ROOT_ID,
      parentId: null,
      briefRef: join(repoDir, "brief.md"),
    });
    const rootSpec = {
      acceptance: unitAcceptance("AR1"),
      contracts: [],
      split: [
        { unitId: "unit-a", dependsOn: [] },
        { unitId: "unit-b", dependsOn: [] },
      ],
    };
    ledger.append("SpecSubmitted", {
      unitId: ROOT_ID,
      specHash: sha(JSON.stringify(rootSpec)),
      acceptance: rootSpec.acceptance,
      contracts: [],
      split: rootSpec.split,
    });
    ledger.append("VerdictSubmitted", { unitId: ROOT_ID, verdictKind: "spec-review", verdict: "pass" });
    seedVerifiedUnit(repoDir, "unit-a", ROOT_ID, childA.tip);
    seedVerifiedUnit(repoDir, "unit-b", ROOT_ID, childB.tip);

    const integrateOnce = async (): Promise<IntegrateResult> =>
      runIntegrationVerify({
        cwd: repoDir,
        rootId: ROOT_ID,
        children: [
          { unitId: "unit-a", commit: childA.tip },
          { unitId: "unit-b", commit: childB.tip },
        ],
        rootAcceptance: unitAcceptance("AR1"),
        contracts: [],
        timeoutMs: 15_000,
      });

    // 第一轮集成：unit-a merge 成功、unit-b 冲突 fail（abort 清现场）
    const first = await integrateOnce();
    expect(first.ok).toBe(false);
    expect(first.failures.join("\n")).toContain("merge 冲突");
    // 冲突现场两子分支均在（fx-5：merge 点不删分支——残留分支正是修复的输入形态）
    expect(refMissing(repoDir, `cw/${ROOT_ID}/unit-a`)).toBe(false);
    expect(refMissing(repoDir, `cw/${ROOT_ID}/unit-b`)).toBe(false);

    // 处置者人工解冲突：root worktree 内 merge unit-b，手解 f.txt 后 commit
    const merge = spawnSync(
      "git",
      ["-C", rootWt, "merge", "--no-edit", `cw/${ROOT_ID}/unit-b`],
      { encoding: "utf-8" },
    );
    expect(merge.status).not.toBe(0); // 冲突是前提
    writeFileSync(join(rootWt, "f.txt"), "resolved-by-human\n");
    gitRun(rootWt, ["add", "f.txt"]);
    gitRun(rootWt, ["commit", "--no-edit"]);

    // 重跑集成：两子 tip 已可达（跳过 merge）→ 干净重跑验收 pass
    const second = await integrateOnce();
    expect(second.ok, `failures: ${second.failures.join(" | ")}`).toBe(true);

    // 子收尾 closed（exec-review pass）→ 终态回收前提成立
    ledger.append("VerdictSubmitted", { unitId: "unit-a", verdictKind: "exec-review", verdict: "pass" });
    ledger.append("VerdictSubmitted", { unitId: "unit-b", verdictKind: "exec-review", verdict: "pass" });

    // 回收入口：下一次 run 的启动清扫（fx-5 双道的跨 run 兜底）
    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter: hold, cwd: repoDir, pollMs: 30, maxIdleMs: 800 }),
    );
    expect(captured.code).toBe(1); // hold 下 maxIdle 兜底退出（清扫与集成已先行）

    // 两子目录 + 分支成对消失（M3 gate 残留场景 by construction 消失的证明）
    expect(existsSync(childA.dir)).toBe(false);
    expect(existsSync(childB.dir)).toBe(false);
    expect(refMissing(repoDir, `cw/${ROOT_ID}/unit-a`)).toBe(true);
    expect(refMissing(repoDir, `cw/${ROOT_ID}/unit-b`)).toBe(true);
    // root 侧资源保留（回流载体 + 成果分支）
    expect(existsSync(rootWt)).toBe(true);
    expect(refMissing(repoDir, ROOT_BRANCH)).toBe(false);
    expect(captured.out).toContain("启动孤儿清扫");
    expect(captured.out).toContain("unit-a");
    expect(captured.out).toContain("unit-b");
  }, 60_000);
});

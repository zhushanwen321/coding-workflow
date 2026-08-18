/**
 * rv4 单测：集成失败处置改进（docs/rewrite/acceptance/rv4-acceptance.md §5 T4-T6）。
 *
 * MAX=1 语义（首次 fail 即转 drift）+ merge 冲突事实入任务书 + 人工窗口不被销毁。
 * 直调 dist 的 runLoop + 测试专用适配器（noop worker spawn 真实 node 子进程 /
 * hold adapter 挂住派发），真实 git 子进程 + 真实账本 + tmp 目录 + 隔离
 * CW_HOME/CW_WORKTREE_HOME，零 mock（u7/fx2 同款基建）：
 *   T4 首 fail 即 drift（MAX=1）：契约配对漂移 → 首次集成 fail 后下轮 loop 派
 *      designer 处置，不再出现第二次自动集成 VerifyRan；frontier --json 可见
 *      drift 状态
 *   T5 merge 冲突事实入任务书：双子改同一行 → integrate-report.json 含
 *      mergeFailures 节（含冲突子 unitId 与 root worktree 路径）；drift designer
 *      任务书（writeBriefFile 产物）含该冲突事实原文
 *   T6 人工窗口不被销毁：drift 派发后 root worktree 制造未提交的人工解冲突 WIP
 *      → loop 继续 poll ≥3 轮 → WIP 原样保留（无 reset/clean 触碰）
 *
 * 注意：直接 `npx vitest run tests/rv4-integration-disposal.test.ts` 不触发
 * pretest，需先 `npm run build`（`npm test` 的 pretest 已含）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { dispatch } from "../dist/dispatch.js";
import type { AcceptanceItem, Contract, SplitEntry } from "../dist/events/types.js";
import { ledgerForCwd } from "../dist/handlers/common.js";
import { loadLedger, unitStatus } from "../dist/readonly/load.js";
import { runLoop } from "../dist/runner/loop.js";
import { spawnProcess } from "../dist/runner/spawn/lifecycle.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
  SpawnResult,
} from "../dist/runner/spawn/types.js";
import { addUnitWorktree, removeWorktree } from "../dist/runner/worktree.js";
import { encodeCwd, evidenceDir, worktreePath } from "../dist/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
if (!existsSync(join(DIST_ROOT, "runner", "loop.js"))) {
  throw new Error("tests/rv4-integration-disposal 需要 dist/（先 npm run build；npm test 的 pretest 已含）");
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-rv4-disposal-"));
// 测试进程与 worker 子进程共享同一 CW_HOME（worker 经 env 继承定位账本）
process.env.CW_HOME = join(tmpRoot, "cw-home");
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** fx-4：本 root 的 topic run 目录（单 run 场景下唯一；不唯一即抛——fixture 前置失败） */
function findTopicDir(home: string, cwd: string, rootId: string): string {
  const topicRoot = join(home, "topic", encodeCwd(cwd));
  const entries = existsSync(topicRoot) ? readdirSync(topicRoot).sort() : [];
  const hits = entries.filter((name) => name.endsWith(`-${rootId}`) || name.includes(`-${rootId}-`));
  if (hits.length !== 1) {
    throw new Error(`topic run 目录不唯一（rootId=${rootId}）：${hits.join(", ") || "(无)"}`);
  }
  return join(topicRoot, hits[0]!);
}

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 恒真 e2e 验收（集成 verify 不跑红阶段——rv4-acceptance §4，恒真形态在集成层合法） */
function alwaysGreen(id: string): AcceptanceItem {
  return {
    id,
    core: true,
    title: `${id} 集成冒烟`,
    type: "e2e-real",
    command: `node -e "console.log('${id} PASS')"`,
  };
}

/** 过 gate 全规则的 unit 级冒烟（vitest JSON 口径，fx2 同款） */
function unitSmoke(id: string): AcceptanceItem {
  return {
    id,
    core: false,
    title: `${id} 单元级冒烟`,
    type: "unit",
    command:
      `node -e "console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'${id} smoke',status:'passed'}]}]}))" -- --reporter=json`,
  };
}

/** 捕获 runLoop 的 stdout/stderr（进程内直调；worker 输出走文件不受影响） */
async function captureStd(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const collector = (chunks: string[]): typeof process.stdout.write =>
    ((chunk: unknown, cb?: (err?: Error | null) => void) => {
      chunks.push(String(chunk));
      // 透传回调：loop.ts 的退出输出屏障依赖 write 回调等待 flush
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

function statusOf(repoDir: string, unitId: string): string {
  const unit = loadLedger(repoDir).projection.units.get(unitId);
  if (unit === undefined) {
    throw new Error(`unit ${unitId} 不在账本（fixture 断言前置失败）`);
  }
  return unitStatus(unit);
}

/** root 的集成 VerifyRan 序列 */
function integrateRunsOf(repoDir: string, rootId: string): Array<{ runId: string; result: string }> {
  const unit = loadLedger(repoDir).projection.units.get(rootId);
  return (unit?.verifyRuns ?? [])
    .filter((run) => run.runId.startsWith("integrate-"))
    .map((run) => ({ runId: run.runId, result: run.result }));
}

// ---- noop worker（真实 node 子进程：不写任何事件，模拟无人应答 brief） ----

function writeNoopWorkerScript(): string {
  const script = `// tests/rv4-integration-disposal.test.ts 生成的测试专用 agent worker（真实进程，非 mock）
const [role, unitId] = process.argv.slice(2);
console.log("rv4-worker noop " + role + " " + unitId + " pid=" + process.pid);
`;
  const path = join(tmpRoot, "rv4-noop-worker.mjs");
  writeFileSync(path, script);
  return path;
}

const NOOP_WORKER_PATH = writeNoopWorkerScript();

/** noop 适配器（spawn 记录供断言）：派发的 agent 不写任何账本事件 */
function makeNoopAdapter(): { adapter: AgentSpawnAdapter; spawned(): Array<{ role: string; unitId: string }> } {
  const records: Array<{ role: string; unitId: string }> = [];
  return {
    adapter: {
      name: "rv4-noop-script",
      spawn: (req: AgentSpawnRequest): Promise<SpawnHandle> => {
        records.push({ role: req.role, unitId: req.unitId });
        return Promise.resolve(
          spawnProcess({
            command: process.execPath,
            args: [NOOP_WORKER_PATH, req.role, req.unitId],
            cwd: req.workdir,
            timeoutMs: req.timeoutMs,
            stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
            stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
          }),
        );
      },
    },
    spawned: () => records,
  };
}

/** 账本预置辅助：unit + 冻结 spec（+ 可选契约） */
function seedUnit(
  repoDir: string,
  unitId: string,
  parentId: string | null,
  acceptance: readonly AcceptanceItem[],
  contracts: Contract[],
  split: SplitEntry[] = [],
): void {
  const ledger = ledgerForCwd(repoDir);
  const spec = { acceptance: [...acceptance], contracts, split };
  ledger.append("UnitCreated", { unitId, parentId, briefRef: join(repoDir, "brief.md") });
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: sha(JSON.stringify(spec)),
    acceptance: [...acceptance],
    contracts,
    split,
  });
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass" });
}

/** 预置 verified 子（seedUnit + build 证据 + pass VerifyRan） */
function seedVerifiedChild(
  repoDir: string,
  unitId: string,
  parentId: string,
  acceptance: readonly AcceptanceItem[],
  contracts: Contract[],
  commit: string,
): void {
  seedUnit(repoDir, unitId, parentId, acceptance, contracts);
  const runId = `run-${unitId}-1`;
  ledgerForCwd(repoDir).append("EvidenceSubmitted", {
    unitId,
    runId,
    commit,
    paths: ["src"],
    sha256: [sha(commit)],
    exitCode: 0,
  });
  ledgerForCwd(repoDir).append("VerifyRan", {
    unitId,
    runId,
    reportHash: sha(`preset:${unitId}`),
    result: "pass",
    acceptanceIds: acceptance.map((ac) => ac.id),
  });
}

// ================================================================
// T4：首 fail 即 drift（MAX=1）——契约配对漂移场景
// ================================================================

const T4_ROOT = "mroot";
const SIG_REAL = "export function renderWidget(";
const SIG_DRIFT = "export function renderWidgets("; // 一字之差（token 差异，归一化不可消除）

describe("T4 首 fail 即 drift（MAX=1）：契约配对漂移 → 首次集成 fail 后不再自动重试", () => {
  it("下轮派 designer 处置（integrationDrift 形态），无第二次自动集成 VerifyRan；frontier --json 可见 drift", async () => {
    // 仓库：c_base 框架 → c_p（leaf-p 产出 src/render.js）→ c_q（leaf-q 产出）。
    // 项目 HEAD = c_q；root 分支集成时从 base（=HEAD 快照）建 → 两子 commit 均已
    // 可达（merge 跳过），fail 只来自契约配对——fixtures 干净可断言
    const base = join(tmpRoot, "t4-drift");
    mkdirSync(base, { recursive: true });
    const repoDir = realpathSync(base);
    gitRun(repoDir, ["init"]);
    gitRun(repoDir, ["config", "user.email", "cw-rv4@example.com"]);
    gitRun(repoDir, ["config", "user.name", "cw-rv4"]);
    const commit = (files: Record<string, string>, message: string): string => {
      for (const [name, content] of Object.entries(files)) {
        const dirPart = name.slice(0, name.lastIndexOf("/"));
        if (dirPart !== "") mkdirSync(join(repoDir, dirPart), { recursive: true });
        writeFileSync(join(repoDir, name), content);
      }
      gitRun(repoDir, ["add", "-A"]);
      gitRun(repoDir, ["commit", "-m", message]);
      return gitRun(repoDir, ["rev-parse", "HEAD"]);
    };
    commit({ "brief.md": "# t4 fixture\n" }, "fixture: base");
    const commitP = commit(
      { "src/render.js": `${SIG_REAL}s) {\n  return String(s).toUpperCase();\n}\n` },
      "build(leaf-p): renderWidget",
    );
    const commitQ = commit({ "src/util.js": "export function helper() { return 1; }\n" }, "build(leaf-q): helper");

    // 账本：root spec 冻结契约 C1（provider=leaf-p，drift 版签名）；leaf-p 冻结
    // C1（self-provider，real 版签名）——配对第一道比对两侧一字差 → 漂移 fail。
    // 树内：leaf-p 版命中（src/render.js 含 real 签名）→ 树内过——fail 只来自配对
    const driftContract: Contract = {
      id: "C1",
      kind: "function",
      provider: "leaf-p",
      consumer: T4_ROOT,
      signature: SIG_DRIFT,
      file: "src/render.js",
      description: "root 侧期望签名（与 leaf-p 冻结版一字差）",
    };
    const providerContract: Contract = {
      id: "C1",
      kind: "function",
      provider: "leaf-p",
      consumer: T4_ROOT,
      signature: SIG_REAL,
      file: "src/render.js",
      description: "leaf-p 冻结的提供承诺",
    };
    const split: SplitEntry[] = [
      { unitId: "leaf-p", dependsOn: [] },
      { unitId: "leaf-q", dependsOn: [] },
    ];
    seedUnit(repoDir, T4_ROOT, null, [alwaysGreen("AR1"), unitSmoke("AR2")], [driftContract], split);
    seedVerifiedChild(repoDir, "leaf-p", T4_ROOT, [alwaysGreen("AP1"), unitSmoke("AP2")], [providerContract], commitP);
    seedVerifiedChild(repoDir, "leaf-q", T4_ROOT, [alwaysGreen("AQ1"), unitSmoke("AQ2")], [], commitQ);

    const script = makeNoopAdapter();
    const captured = await captureStd(() =>
      runLoop({ rootId: T4_ROOT, adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 4_000 }),
    );

    // noop designer 不推进 → idle exit 1（fx-2 R4b 兜底语义不变）
    expect(captured.code).toBe(1);
    // MAX=1（rv-4 语义迁移）：首次集成 fail 即转 drift——只有 1 次自动集成，
    // 不再有 fx-2 时代的第二次自动重试
    const runs = integrateRunsOf(repoDir, T4_ROOT);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toBe("fail");
    // 下轮派 designer 处置（integrationDrift 形态）
    expect(script.spawned().some((r) => r.role === "designer" && r.unitId === T4_ROOT)).toBe(true);
    expect(statusOf(repoDir, T4_ROOT)).toBe("spec-frozen");
    // stderr 的失败清单含配对漂移事实（两侧签名文本）
    expect(captured.err).toContain("契约漂移");
    expect(captured.err).toContain(SIG_DRIFT);
    expect(captured.err).toContain(SIG_REAL);

    // frontier --json 可见 drift 状态（与派发判定同一出处）
    const frontierOut: string[] = [];
    const origOut = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      frontierOut.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let frontierExit: number | undefined;
    try {
      frontierExit = await dispatch(["frontier", "--json"], repoDir);
    } finally {
      process.stdout.write = origOut;
    }
    expect(frontierExit).toBe(0);
    const groups = JSON.parse(frontierOut.join("")) as { integrationDrift: string[]; integrationReady: string[] };
    expect(groups.integrationDrift).toContain(T4_ROOT);
    expect(groups.integrationReady).not.toContain(T4_ROOT);
  }, 60_000);
});

// ================================================================
// T5：merge 冲突事实入任务书
// ================================================================

const T5_ROOT = "croot";
const T5_CHILDREN = ["unit-a", "unit-b"] as const;

/** merge 冲突现场：base + 两子分支各改 f.txt 同一行（root 分支集成时先 A 后 B 冲突） */
function seedConflictFixture(name: string): { repoDir: string; rootWorktreeDir: string } {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-rv4@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-rv4"]);
  writeFileSync(join(repoDir, "brief.md"), "# t5 fixture\n");
  writeFileSync(join(repoDir, "f.txt"), "base\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: base"]);
  const baseCommit = gitRun(repoDir, ["rev-parse", "HEAD"]);

  const split: SplitEntry[] = T5_CHILDREN.map((unitId) => ({ unitId, dependsOn: [] }));
  seedUnit(repoDir, T5_ROOT, null, [alwaysGreen("AR1"), unitSmoke("AR2")], [], split);

  // 两子各在自己的 cw/ 分支上改 f.txt 同一行（真实 worktree 提交，wt4 seedSplitFixture 同款）
  for (const unitId of T5_CHILDREN) {
    const acceptance = [alwaysGreen(`A-${unitId.toUpperCase()}`), unitSmoke(`U-${unitId.toUpperCase()}`)];
    const childWt = worktreePath(WT_HOME, repoDir, unitId);
    const added = addUnitWorktree(repoDir, childWt, T5_ROOT, unitId, baseCommit);
    if (!added.ok) {
      throw new Error(`fixture：子 worktree 建立失败（${unitId}）：${added.error}`);
    }
    writeFileSync(join(childWt, "f.txt"), `changed-by-${unitId}\n`);
    gitRun(childWt, ["add", "-A"]);
    gitRun(childWt, ["commit", "-m", `build(${unitId}): t5 fixture 产出`]);
    const commit = gitRun(childWt, ["rev-parse", "HEAD"]);
    const removed = removeWorktree(repoDir, childWt);
    if (!removed.ok) {
      throw new Error(`fixture：子 worktree 回收失败（${unitId}）：${removed.error}`);
    }
    seedVerifiedChild(repoDir, unitId, T5_ROOT, acceptance, [], commit);
  }
  return { repoDir, rootWorktreeDir: worktreePath(WT_HOME, repoDir, T5_ROOT) };
}

describe("T5 merge 冲突事实入任务书：integrate-report 含 mergeFailures 节 + drift brief 含冲突原文", () => {
  it("双子改同一行 → 报告 mergeFailures 含冲突子 unitId 与 root worktree 路径；任务书含该事实原文", async () => {
    const { repoDir, rootWorktreeDir } = seedConflictFixture("t5-merge-conflict");
    const script = makeNoopAdapter();

    const captured = await captureStd(() =>
      runLoop({ rootId: T5_ROOT, adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 4_000 }),
    );

    expect(captured.code).toBe(1); // noop designer 不推进 → idle 兜底
    // 首次集成 fail（merge 冲突 + unit-b 可达性失败），MAX=1 即转 drift——恰 1 次
    const runs = integrateRunsOf(repoDir, T5_ROOT);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toBe("fail");

    // integrate-report.json 的 mergeFailures 节：含冲突子 unitId 与 root worktree 路径
    const runId = runs[0]?.runId ?? "";
    const report = JSON.parse(
      readFileSync(
        join(evidenceDir(process.env.CW_HOME ?? "", repoDir, T5_ROOT, runId), "integrate-report.json"),
        "utf-8",
      ),
    ) as {
      mergeFailures: string[];
      children: Array<{ unitId: string; reachable: boolean }>;
      ok: boolean;
    };
    expect(report.ok).toBe(false);
    expect(report.mergeFailures.length).toBeGreaterThanOrEqual(1);
    const merged = report.mergeFailures.join("\n");
    expect(merged).toContain("unit-b"); // 后 merge 的子与 unit-a 的改动冲突
    expect(merged).toContain("merge 冲突");
    expect(merged).toContain(rootWorktreeDir);
    // 冲突子不可达（merge 失败 → 其产出未进 root 分支）
    const unitB = report.children.find((c) => c.unitId === "unit-b");
    expect(unitB?.reachable).toBe(false);

    // drift designer 任务书（writeBriefFile 产物）含冲突事实原文——不再退化为
    // 「契约比对无失败项」类笼统文案（merge 冲突清单独立成节）
    const brief = readFileSync(
      join(findTopicDir(process.env.CW_HOME ?? "", repoDir, T5_ROOT), `${T5_ROOT}.designer.brief.md`),
      "utf-8",
    );
    expect(brief).toContain("merge 冲突清单");
    expect(brief).toContain("unit-b");
    expect(brief).toContain(rootWorktreeDir);
    // 冲突明细原文（含恢复动作的关键片段）进入任务书
    expect(brief).toContain("merge 冲突");
    // designer 被派发（drift 出口）
    expect(script.spawned().some((r) => r.role === "designer" && r.unitId === T5_ROOT)).toBe(true);
  }, 60_000);
});

// ================================================================
// T6：人工窗口不被销毁
// ================================================================

describe("T6 人工窗口不被销毁：drift 派发后 root worktree 的人工解冲突 WIP 原样保留", () => {
  it("drift designer 在飞期间制造未提交 WIP → loop 继续 poll ≥3 轮 → WIP 文件与内容原样（无 reset/clean 触碰）", async () => {
    const { repoDir, rootWorktreeDir } = seedConflictFixture("t6-human-window");

    // hold 适配器：designer(root) 派发时点（ensure worktree + brief 落盘之后）注入
    // 人工解冲突 WIP，然后挂住派发不结算——人工窗口期间 loop 的后续轮次不应触碰
    // root worktree（drift 状态不触发集成；同 unit+role in-flight 不重派）
    let wipInjectedAt = 0;
    const WIP_FILE = join(rootWorktreeDir, "wip-manual-resolve.txt");
    const WIP_CONTENT = "人工解冲突 WIP（rv4 T6）：conflict markers resolved by hand\n";
    const hold: AgentSpawnAdapter = {
      name: "rv4-t6-hold",
      spawn: async (req: AgentSpawnRequest): Promise<SpawnHandle> => {
        if (req.role === "designer" && req.unitId === T5_ROOT) {
          writeFileSync(WIP_FILE, WIP_CONTENT);
          wipInjectedAt = Date.now();
        }
        return {
          wait: () => new Promise<SpawnResult>(() => {}),
          kill: () => {},
        };
      },
    };

    const pollMs = 50;
    const captured = await captureStd(() =>
      runLoop({ rootId: T5_ROOT, adapter: hold, cwd: repoDir, pollMs, maxIdleMs: 4_000 }),
    );

    expect(captured.code).toBe(1); // hold 派发无账本进展 → maxIdle 兜底
    // loop 在 WIP 注入后继续 poll ≥3 轮（时间下界 3×poll；实际由 maxIdle 兜底退出）
    expect(Date.now() - wipInjectedAt).toBeGreaterThanOrEqual(3 * pollMs);
    // WIP 原样保留：文件存在、内容逐字节一致、且处于未提交状态（未被 clean 掉）
    expect(existsSync(WIP_FILE)).toBe(true);
    expect(readFileSync(WIP_FILE, "utf-8")).toBe(WIP_CONTENT);
    const porcelain = spawnSync("git", ["-C", rootWorktreeDir, "status", "--porcelain"], { encoding: "utf-8" });
    expect((porcelain.stdout ?? "").trim()).toContain("?? wip-manual-resolve.txt");
    // 仅一次集成（MAX=1）且 root 停在 spec-frozen（drift 人工窗口）
    expect(integrateRunsOf(repoDir, T5_ROOT)).toHaveLength(1);
    expect(statusOf(repoDir, T5_ROOT)).toBe("spec-frozen");
  }, 60_000);
});

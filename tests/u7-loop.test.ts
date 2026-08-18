/**
 * u7 单测：通用调度循环（docs/rewrite/acceptance/u7-acceptance.md「单测验收」5 组）。
 *
 * 全部真实环境零 mock：直调 dist 的 runLoop + 测试专用适配器（文件内定义）spawn
 * 真实 node 子进程（worker 脚本由本文件生成），worker 经 dist 的 EventLedger API
 * 对真实账本执行真实写入（designer 写 SpecSubmitted + spec-review、builder 写
 * EvidenceSubmitted + VerifyRan、reviewer 写 exec-review）；并发计数在适配器内
 * （in-flight 计数器，断言峰值 ≤ maxConcurrency）。
 *
 * worker 直写事件的职责边界说明：本文件测的是调度循环（frontier / 派发 / 并发 /
 * 等待 / 空转 / 退出），不是 verify 的真实性——后者属 u4/u5 已验收领地（干净重跑、
 * 名字比对均不在此重复）；故 VerifyRan 由 worker 按冻结 spec 的验收 id 直接构造，
 * commit 取 fixture repo 的真实 HEAD。
 *
 * 注意：直接 `npx vitest run tests/u7-loop.test.ts` 不触发 pretest，需先 `npm run
 * build`（`npm test` 的 pretest 已含）。
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

import type { AcceptanceItem, SplitEntry } from "../dist/events/types.js";
import { ledgerForCwd } from "../dist/handlers/common.js";
import { loadLedger, unitStatus } from "../dist/readonly/load.js";
import { runLoop } from "../dist/runner/loop.js";
import { spawnProcess } from "../dist/runner/spawn/lifecycle.js";
import type {
  AgentRole,
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
  SpawnResult,
} from "../dist/runner/spawn/types.js";
import { encodeCwd } from "../dist/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const CLI_PATH = join(DIST_ROOT, "cli.js");
for (const required of [CLI_PATH, join(DIST_ROOT, "runner", "loop.js")]) {
  if (!existsSync(required)) {
    throw new Error(`tests/u7-loop 需要 ${required}（先 npm run build；npm test 的 pretest 已含）`);
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u7-loop-"));
// 直调场景：测试进程与 worker 子进程共享同一 CW_HOME（worker 经 env 继承定位账本）
process.env.CW_HOME = join(tmpRoot, "cw-home");
// wt-2 迁移：派发 workdir 迁 unit worktree，隔离 worktree 根（与 CW_HOME 同款）
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * fx-4：本 root 的 topic run 目录（<cwHome>/topic/<encoded>/<runTs>-<rootId>[-N]）。
 * 单 run 场景下唯一（runLoop 启动建一次）；不唯一即抛（fixture 前置失败，非断言目标）。
 */
function findTopicDir(home: string, cwd: string, rootId: string): string {
  const topicRoot = join(home, "topic", encodeCwd(cwd));
  const entries = existsSync(topicRoot) ? readdirSync(topicRoot).sort() : [];
  const hits = entries.filter((name) => name.endsWith(`-${rootId}`) || name.includes(`-${rootId}-`));
  if (hits.length !== 1) {
    throw new Error(`topic run 目录不唯一（rootId=${rootId}）：${hits.join(", ") || "(无)"}`);
  }
  return join(topicRoot, hits[0]!);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---- 测试专用 worker 脚本（真实 node 子进程；按 role 对账本真实写入） ----

/** 生成 worker 脚本（返回脚本绝对路径）。mode=work 按 role 推进；mode=idle 挂住不动。 */
function writeWorkerScript(): string {
  const script = `// tests/u7-loop.test.ts 生成的测试专用 agent worker（真实进程，非 mock）
// argv: <role> <unitId> <cwd> <mode> <workMs> <commit> <briefPath>
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const DIST = ${JSON.stringify(DIST_ROOT)};
const [role, unitId, cwd, mode, workMsRaw, commit, briefPath] = process.argv.slice(2);
const workMs = Number(workMsRaw);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const { ledgerForCwd } = await import(DIST + "/handlers/common.js");
const { loadLedger } = await import(DIST + "/readonly/load.js");

let briefHead = "(unreadable)";
try {
  briefHead = (readFileSync(briefPath, "utf-8").split("\\n")[0] ?? "");
} catch {}
console.log("worker " + role + " " + unitId + " pid=" + process.pid + " brief-head=" + briefHead);

const ACCEPTANCE = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
];

if (mode === "idle") {
  // 空转场景：不写账本、不退出（验证 runLoop 的 kill 回收 + maxIdle 出口）
  setInterval(() => {}, 1000);
} else if (role === "designer") {
  await sleep(workMs);
  // mx-1：designer 只提交 spec——spec-review 由独立 reviewer spawn 提交（不自审）
  const specHash = sha(JSON.stringify({ acceptance: ACCEPTANCE, contracts: [], split: [] }));
  ledgerForCwd(cwd).append("SpecSubmitted", { unitId, specHash, acceptance: ACCEPTANCE, contracts: [], split: [] });
  console.log("worker-done designer " + unitId);
} else if (role === "builder") {
  await sleep(workMs);
  const unit = loadLedger(cwd).projection.units.get(unitId);
  if (unit === undefined || unit.specs.length === 0) throw new Error("builder: unit " + unitId + " 无 spec");
  const acceptanceIds = unit.specs[unit.specs.length - 1].acceptance.map((a) => a.id);
  const runId = "run-" + unitId + "-" + Date.now();
  const ledger = ledgerForCwd(cwd);
  ledger.append("EvidenceSubmitted", { unitId, runId, commit, paths: ["app.js"], sha256: [sha("app.js")], exitCode: 0 });
  await sleep(workMs);
  ledger.append("VerifyRan", { unitId, runId, reportHash: sha("evidence-report:" + runId), result: "pass", acceptanceIds });
  console.log("worker-done builder " + unitId);
} else if (role === "reviewer") {
  await sleep(workMs);
  // mx-1：reviewer 按 unit 现状二选一——spec 待审（created）→ spec-review；
  // verified 未 closed → exec-review。两种 verdict 都带自报 role=reviewer
  const unit = loadLedger(cwd).projection.units.get(unitId);
  const { unitStatus } = await import(DIST + "/readonly/load.js");
  const status = unit === undefined ? "created" : unitStatus(unit);
  const kind = status === "verified" ? "exec-review" : "spec-review";
  ledgerForCwd(cwd).append("VerdictSubmitted", { unitId, verdictKind: kind, verdict: "pass", role: "reviewer" });
  console.log("worker-done reviewer " + kind + " " + unitId);
} else {
  throw new Error("worker: 未知 role " + role);
}
`;
  const path = join(tmpRoot, "u7-worker.mjs");
  writeFileSync(path, script);
  return path;
}

const WORKER_PATH = writeWorkerScript();

// ---- 测试专用适配器（spawnProcess 包装 + in-flight 并发计数在适配器内） ----

interface SpawnRecord {
  role: AgentRole;
  unitId: string;
  briefPath: string;
  /** wt-2 迁移：brief 在派发时刻的存在性与内容快照（后续重派的 clean -fd 会清 worktree 内上一轮 untracked 产物） */
  briefExisted: boolean;
  briefContent: string;
  at: number;
}

interface ScriptAdapter {
  adapter: AgentSpawnAdapter;
  /** 观测到的 in-flight spawn 峰值（并发上限断言的权威计数） */
  peakInFlight(): number;
  spawned(): readonly SpawnRecord[];
}

function makeScriptAdapter(opts: {
  mode: "work" | "idle";
  workMs: number;
  commit: string;
}): ScriptAdapter {
  let inFlightCount = 0;
  let peak = 0;
  const records: SpawnRecord[] = [];
  return {
    adapter: {
      name: "u7-test-script",
      spawn: async (req: AgentSpawnRequest): Promise<SpawnHandle> => {
        inFlightCount += 1;
        if (inFlightCount > peak) {
          peak = inFlightCount;
        }
        // wt-2 迁移：派发时刻即断言 brief 已落盘（worktree 语义下重派 reset 会清上一轮产物，
        // 循环结束后只有最后一轮的 brief 幸存——存在性必须在 spawn 时点捕获）
        const briefExisted = existsSync(req.briefPath);
        const briefContent = briefExisted ? readFileSync(req.briefPath, "utf-8") : "(missing)";
        records.push({ role: req.role, unitId: req.unitId, briefPath: req.briefPath, briefExisted, briefContent, at: Date.now() });
        const handle = spawnProcess({
          command: process.execPath,
          args: [
            WORKER_PATH,
            req.role,
            req.unitId,
            // wt-2 迁移：worker 代表 agent 写账本——账本锚定经 projectCwd（等价于
            // agent 的 cw 命令经 CW_PROJECT_DIR 锚定），workdir 只是工作区
            req.projectCwd,
            opts.mode,
            String(opts.workMs),
            opts.commit,
            req.briefPath,
          ],
          cwd: req.workdir,
          timeoutMs: req.timeoutMs,
          // fx-4：产物路径从 req.artifactDir 拼装（run 级 topic 目录）
          stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
          stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
        });
        let decremented = false;
        return {
          wait: async (): Promise<SpawnResult> => {
            const result = await handle.wait();
            if (!decremented) {
              decremented = true;
              inFlightCount -= 1;
            }
            return result;
          },
          kill: handle.kill,
        };
      },
    },
    peakInFlight: () => peak,
    spawned: () => records,
  };
}

// ---- fixture 基建（真实 git repo + 真实账本直写） ----

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 独立 repo：init + 一个真实 commit（builder 证据的 commit hash 来源） */
function makeRepo(name: string): { repoDir: string; head: string } {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-u7@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-u7"]);
  writeFileSync(join(repoDir, "brief.md"), "# u7 fixture 任务书\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  return { repoDir, head: gitRun(repoDir, ["rev-parse", "HEAD"]) };
}

const FIXTURE_ACCEPTANCE: AcceptanceItem[] = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
];

function appendUnitCreated(repoDir: string, unitId: string, parentId: string | null): void {
  ledgerForCwd(repoDir).append("UnitCreated", {
    unitId,
    parentId,
    briefRef: join(repoDir, "brief.md"),
  });
}

/** 预置一个 spec-frozen unit（SpecSubmitted + spec-review pass；split 可空） */
function appendSpecFrozen(repoDir: string, unitId: string, split: SplitEntry[] = []): void {
  const ledger = ledgerForCwd(repoDir);
  const spec = {
    acceptance: FIXTURE_ACCEPTANCE,
    contracts: [],
    split,
  };
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: sha(JSON.stringify(spec)),
    acceptance: FIXTURE_ACCEPTANCE,
    contracts: [],
    split,
  });
  // mx3 迁移：fold 只认 role=reviewer——fixture 的 spec-review pass 补自报 role
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
}

function statusOf(repoDir: string, unitId: string): string {
  const unit = loadLedger(repoDir).projection.units.get(unitId);
  if (unit === undefined) {
    throw new Error(`unit ${unitId} 不在账本（fixture 断言前置失败）`);
  }
  return unitStatus(unit);
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
      // 透传回调：loop.ts 的 flushOutputs 退出屏障依赖 write 回调等待 flush，
      // 不透传会使其落入兜底超时，拖慢每个 runLoop 退出
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitPidGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isPidAlive(pid);
}

// ---- 验收#1：测试适配器本身（真实进程 + 真实账本写入 + brief 传递） ----

describe("u7 验收#1 测试专用适配器：真实 node 进程 + dist EventLedger 真实写账本", () => {
  it("designer spawn → exit 0 → 账本真实出现 SpecSubmitted 且无自审 verdict（mx-1：designer 不自审，unit 停 created）", async () => {
    const { repoDir, head } = makeRepo("adapter-sanity");
    appendUnitCreated(repoDir, "sanity", null);
    const { adapter } = makeScriptAdapter({ mode: "work", workMs: 50, commit: head });

    const handle = await adapter.spawn({
      role: "designer",
      unitId: "sanity",
      workdir: repoDir,
      projectCwd: repoDir,
      artifactDir: join(tmpRoot, "adapter-sanity-topic"),
      briefPath: join(repoDir, "brief.md"),
      timeoutMs: 30_000,
    });
    const result = await handle.wait();

    expect(result.exitCode).toBe(0);
    expect(result.pid).toBeGreaterThan(0);
    // stdout 落盘：worker 自报身份 + brief 首行（file-based brief 传递链路真实走通）
    const out = readFileSync(result.stdoutPath, "utf-8");
    expect(out).toContain("worker designer sanity");
    expect(out).toContain("brief-head=# u7 fixture 任务书");
    expect(out).toContain("worker-done designer sanity");
    // 真实账本断言（mx-1 断言反转）：SpecSubmitted 入账 + 无任何 spec-review
    // verdict（独立 reviewer 的职责）+ unit 停在 created 待审
    const unit = loadLedger(repoDir).projection.units.get("sanity");
    expect(unit?.specs.length).toBe(1);
    expect(unit?.specs[0]?.acceptance.map((a) => a.id)).toEqual(["A1", "A2"]);
    expect(unit?.verdicts.some((v) => v.verdictKind === "spec-review")).toBe(false);
    expect(statusOf(repoDir, "sanity")).toBe("created");
  }, 30_000);
});

// ---- 验收#2：单 unit 全链（created → designer → builder → reviewer → closed → 0） ----

describe("u7 验收#2 单 unit 全链", () => {
  it("runLoop 逐 role 推进至 root closed，返回 0，brief 落盘三份", async () => {
    const { repoDir, head } = makeRepo("full-chain");
    appendUnitCreated(repoDir, "root", null);
    const script = makeScriptAdapter({ mode: "work", workMs: 60, commit: head });

    const captured = await captureStd(() =>
      runLoop({ rootId: "root", adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 20_000 }),
    );

    expect(captured.code).toBe(0);
    expect(statusOf(repoDir, "root")).toBe("closed");
    // 派发顺序（mx-1）：designer（提 spec）→ reviewer（spec-review）→ builder →
    // reviewer（exec-review）——spec-review 是独立 reviewer spawn，不再由 designer 自审
    expect(script.spawned().map((r) => r.role)).toEqual(["designer", "reviewer", "builder", "reviewer"]);
    // reviewer 的 spec-review verdict 带自报 role=reviewer（弱声明审计载体）
    const verdict = loadLedger(repoDir)
      .projection.units.get("root")
      ?.verdicts.find((v) => v.verdictKind === "spec-review");
    expect(verdict?.role).toBe("reviewer");
    // 循环六步之 2：每次派发的 brief 落盘 run 级 topic 目录（fx-4：<cwHome>/topic/
    // <encoded>/<runTs>-root/<unitId>.<role>.brief.md；存在性在派发时点断言——brief
    // 覆盖写，同 unit 换角色重派只留最新版）
    for (const record of script.spawned()) {
      expect(record.briefExisted, `${record.role} 的 brief 应在派发时点已落盘`).toBe(true);
      expect(record.briefPath).toBe(
        join(
          findTopicDir(process.env.CW_HOME ?? "", repoDir, "root"),
          `${record.unitId}.${record.role}.brief.md`,
        ),
      );
    }
    const designerBrief = script
      .spawned()
      .filter((r) => r.role === "designer")
      .map((r) => r.briefContent)[0] ?? "(missing)";
    expect(designerBrief).toContain('designer 任务书：unit "root"');
    expect(designerBrief).toContain("原始任务书内容");
    expect(designerBrief).toContain("# u7 fixture 任务书");
    // 汇总行（循环六步之 5：每 unit 状态行）
    expect(captured.out).toContain('root "root" 已 closed');
    expect(captured.out).toMatch(/root\s+closed\s+lastVerify:pass/);
    expect(captured.out).toContain("派发 designer → unit \"root\"");
  }, 30_000);
});

// ---- 验收#3：并发上限（5 待派发 + maxConcurrency=2 → 适配器内峰值 ≤2） ----

describe("u7 验收#3 并发上限", () => {
  it("5 个 designer 待派发 + maxConcurrency=2 → 任一时刻 in-flight ≤ 2（峰值恰为 2），全链收敛 root closed", async () => {
    const { repoDir, head } = makeRepo("concurrency");
    appendUnitCreated(repoDir, "root", null);
    appendSpecFrozen(repoDir, "root");
    for (const leaf of ["w1", "w2", "w3", "w4", "w5"]) {
      appendUnitCreated(repoDir, leaf, "root");
    }
    const script = makeScriptAdapter({ mode: "work", workMs: 200, commit: head });

    // work 模式下 worker 按 role 全程推进（mx-1：spec-review 由独立 reviewer
    // spawn 提交）：5 designer（并发受限）→ 5 reviewer（spec-review）→ 5 builder
    // → 5 reviewer（exec-review）→ root 集成（直跑）→ root reviewer → closed
    // 返回 0。并发上限的主断言是适配器内 in-flight 峰值（验收文档锁定方式）。
    const captured = await captureStd(() =>
      runLoop({
        rootId: "root",
        adapter: script.adapter,
        cwd: repoDir,
        pollMs: 50,
        maxIdleMs: 30_000,
        maxConcurrency: 2,
      }),
    );

    expect(captured.code).toBe(0);
    expect(script.peakInFlight()).toBe(2); // 峰值恰为 2（首批即满载）且 ≤ maxConcurrency
    // 首批派发即 5 个 designer 目标（并发闸门只放行 2 个）
    expect(script.spawned().slice(0, 2).every((r) => r.role === "designer")).toBe(true);
    for (const unitId of ["root", "w1", "w2", "w3", "w4", "w5"]) {
      expect(statusOf(repoDir, unitId)).toBe("closed");
    }
  }, 60_000);
});

// ---- 验收#4：空转超时（适配器不动作 → maxIdleMs → 返回 1 + kill 回收） ----

describe("u7 验收#4 空转超时", () => {
  it("idle worker 不写账本 → maxIdleMs 出口返回 1，stderr 可操作，in-flight 进程被 kill", async () => {
    const { repoDir, head } = makeRepo("idle");
    appendUnitCreated(repoDir, "root", null);
    const script = makeScriptAdapter({ mode: "idle", workMs: 0, commit: head });

    const captured = await captureStd(() =>
      runLoop({ rootId: "root", adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 700 }),
    );

    expect(captured.code).toBe(1);
    expect(captured.err).toContain("无账本进展");
    expect(captured.err).toContain("恢复动作");
    // 账本零推进（worker 确实没写）
    expect(loadLedger(repoDir).projection.totalEvents).toBe(1);
    expect(statusOf(repoDir, "root")).toBe("created");
    // runLoop 退出路径 kill 了 in-flight worker：stdout 文件取 pid，真实进程表复核
    //（fx-4 迁移：产物路径随派发迁 run 级 topic 目录）
    const workerOut = readFileSync(
      join(findTopicDir(process.env.CW_HOME ?? "", repoDir, "root"), "root.designer.stdout"),
      "utf-8",
    );
    const pid = Number(/pid=(\d+)/.exec(workerOut)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(await waitPidGone(pid, 5_000)).toBe(true);
  }, 30_000);
});

// ---- 验收#5：root 不存在（runLoop 抛可操作错误；run.ts 层已前置转 exit 1） ----

describe("u7 验收#5 root 不存在", () => {
  it("runLoop 直调抛含恢复动作的可操作错误，适配器未被调用", async () => {
    const { repoDir, head } = makeRepo("no-root");
    const script = makeScriptAdapter({ mode: "work", workMs: 0, commit: head });

    await expect(
      runLoop({ rootId: "ghost", adapter: script.adapter, cwd: repoDir }),
    ).rejects.toThrow(/ghost.*不存在[\s\S]*恢复动作/);
    expect(script.spawned().length).toBe(0);
  }, 10_000);
});

// ---- 修复回归：flight 已自然退出但 wait 未结算时 root closed（killAll best-effort） ----

/** stale worker：一步把 unit 全链直推 closed 后退出（进程死透，kill 才落在死组上） */
function writeStaleWorker(): string {
  const script = `// tests/u7-loop.test.ts 生成：一次写完全链事件（spec → review → evidence → verify → exec-review）
// argv: <unitId> <cwd> <commit>
import { createHash } from "node:crypto";
const DIST = ${JSON.stringify(DIST_ROOT)};
const [unitId, cwd, commit] = process.argv.slice(2);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const { ledgerForCwd } = await import(DIST + "/handlers/common.js");
const ACCEPTANCE = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
];
const ledger = ledgerForCwd(cwd);
const specHash = sha(JSON.stringify({ acceptance: ACCEPTANCE, contracts: [], split: [] }));
ledger.append("SpecSubmitted", { unitId, specHash, acceptance: ACCEPTANCE, contracts: [], split: [] });
ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
ledger.append("EvidenceSubmitted", { unitId, runId: "run-stale-1", commit, paths: ["app.js"], sha256: [sha("app.js")], exitCode: 0 });
ledger.append("VerifyRan", { unitId, runId: "run-stale-1", reportHash: sha("evidence-report:run-stale-1"), result: "pass", acceptanceIds: ACCEPTANCE.map((a) => a.id) });
ledger.append("VerdictSubmitted", { unitId, verdictKind: "exec-review", verdict: "pass" });
console.log("stale-worker-done " + unitId);
`;
  const path = join(tmpRoot, "u7-stale-worker.mjs");
  writeFileSync(path, script);
  return path;
}

const STALE_WORKER_PATH = writeStaleWorker();

describe("修复回归：killAll 兜底清理是 best-effort（kill 异常不炸退出流程）", () => {
  it("flight 已自然退出 + wait 未结算时 root closed → runLoop 返回 0 且不抛", async () => {
    const { repoDir, head } = makeRepo("stale-flight");
    appendUnitCreated(repoDir, "root", null);

    // 确定性构造 verifier 实锤的时序：spawn 真实 worker（写完全链即退出），
    // 但 handle.wait() 永不 resolve——runLoop 的 race 永远消费不到该 flight，
    // root closed 分支的兜底 killAll 会对「已退出进程组」调用 kill。
    // macOS 对该场景返回 EPERM（lifecycle.killTree 只豁免 ESRCH）；kill() 在
    // 真实 kill 之后再抛一次模拟 EPERM，钉死「killAll 必须吞 kill 异常」契约
    // （红性不依赖 OS 对死组返回 EPERM 还是 ESRCH）。
    //
    // 竞态消除（存量 flaky 修复）：先 await 真实 handle.wait()（worker 死透、
    // 账本写入完整）再返回外层 handle。原实现直接返回，loop 的 50ms 轮询可能
    // 捕获「spec 已写、evidence 未写」的中间态（瞬时 spec-frozen → 派 builder，
    // canon 允许同 unit 不同 role 并存），第二个 worker 的新 spec 使 lastSpecSeq
    // 后移、旧 exec-review 失效，root 永远回不到 closed → 偶发 maxIdle exit 1。
    let killCalled = false;
    const staleAdapter: AgentSpawnAdapter = {
      name: "u7-stale-flight",
      spawn: async (req: AgentSpawnRequest): Promise<SpawnHandle> => {
        const handle = spawnProcess({
          command: process.execPath,
          // wt-2 迁移：worker 写账本锚定 projectCwd（workdir 仅工作区）
          args: [STALE_WORKER_PATH, req.unitId, req.projectCwd, head],
          cwd: req.workdir,
          timeoutMs: req.timeoutMs,
          // fx-4：产物路径从 req.artifactDir 拼装（run 级 topic 目录）
          stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
          stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
        });
        // 等真实 worker 退出（结果丢弃）：对 loop 的视角由下方永不结算的 wait 扮演
        await handle.wait();
        return {
          wait: () => new Promise<SpawnResult>(() => {}), // 永不结算：模拟 race 未消费
          kill: () => {
            killCalled = true;
            handle.kill(); // 真实路径：对已死进程组（EPERM 或 ESRCH，均不应炸 loop）
            throw new Error("kill EPERM（模拟：macOS 已自然退出但未结算的进程组）");
          },
        };
      },
    };

    const captured = await captureStd(() =>
      runLoop({ rootId: "root", adapter: staleAdapter, cwd: repoDir, pollMs: 50, maxIdleMs: 10_000 }),
    );

    expect(captured.code).toBe(0); // 修复前：kill 的异常冒出 runLoop（kill EPERM）
    expect(statusOf(repoDir, "root")).toBe("closed");
    expect(killCalled).toBe(true); // 兜底路径确实执行了 kill（异常被 best-effort 吞掉）
    expect(captured.out).toContain('root "root" 已 closed');
    // 失败要出声：kill 失败留一行 stderr 可见性（不影响退出码）
    expect(captured.err).toContain("兜底 kill 失败");
  }, 30_000);
});

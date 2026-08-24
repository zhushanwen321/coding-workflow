/**
 * u-i2-a 单测：runLoop 库化（design-hi-cw-runner-extension §4 PP6 + §3.2 R2）。
 *
 * 零 mock 全真实环境（对齐 tests/u7-loop.test.ts 写法）：直调 dist 的 runLoop +
 * 测试专用适配器（文件内定义）spawn 真实 node 子进程，worker 经 dist 的
 * EventLedger API 对真实账本真实写入。
 *
 * 覆盖四组：
 * 1. PP6 同源回归：同账本双跑（失败 developer 半程 → 记录 frontier → 第二个
 *    runLoop 续接到 closed），第二 run 首轮 round 事件与检查点投影一致、已完成
 *    阶段不重做（spec/spec-review 不重复入账）。
 * 2. onEvent 事件流：round / dispatch / settled / reflection 至少各一次，
 *    subagentSlug 形态 `${unitId}-${role}`。
 * 3. stopped：maxSpecRejects=1 注入快速构造 specReviewDeadlock，stopped 事件
 *    dimension 命中。
 * 4. onEvent 抛错韧性：回调每次 throw，主循环照常收敛 closed（stderr 有记录）。
 * 5. 库形态消费：从 dist/runner.js（./runner 子路径门面）import runLoop 跑最小循环。
 *
 * 注意：直接 `npx vitest run tests/i2a-runner-library.test.ts` 不触发 pretest，
 * 需先 `npm run build`。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ledgerForCwd } from "../dist/handlers/common.js";
import { loadLedger, unitStatus } from "../dist/readonly/load.js";
import type { LoopEvent } from "../dist/runner/loop.js";
import { runLoop } from "../dist/runner/loop.js";
import { spawnProcess } from "../dist/runner/spawn/lifecycle.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
  SpawnResult,
} from "../dist/runner/spawn/types.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
for (const required of [join(DIST_ROOT, "runner", "loop.js"), join(DIST_ROOT, "runner.js")]) {
  if (!existsSync(required)) {
    throw new Error(`tests/i2a-runner-library 需要 ${required}（先 npm run build；npm test 的 pretest 已含）`);
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-i2a-"));
process.env.CW_HOME = join(tmpRoot, "cw-home");
process.env.CW_WORKTREE_HOME = join(tmpRoot, "cw-worktrees");

afterAll(() => {
  if (process.env.I2A_KEEP === "1") {
    return; // 调试逃生口：保留现场
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

// ---- 测试专用 worker（真实 node 子进程；mode 参数化行为） ----

/** worker 脚本：work=全链推进；faildev=developer 不写账本 exit 1；failspec=reviewer 恒打回 */
function writeWorkerScript(): string {
  const script = `// tests/i2a-runner-library.test.ts 生成的测试 agent worker（真实进程，非 mock）
// argv: <role> <unitId> <cwd> <mode> <commit>
const DIST = ${JSON.stringify(DIST_ROOT)};
import { createHash } from "node:crypto";
const [role, unitId, cwd, mode, commit] = process.argv.slice(2);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const { ledgerForCwd } = await import(DIST + "/handlers/common.js");
const { loadLedger, unitStatus } = await import(DIST + "/readonly/load.js");

const ACCEPTANCE = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
];

if (role === "designer") {
  const specHash = sha(JSON.stringify({ acceptance: ACCEPTANCE, contracts: [], split: [] }));
  ledgerForCwd(cwd).append("SpecSubmitted", { unitId, specHash, acceptance: ACCEPTANCE, contracts: [], split: [] });
  console.log("worker-done designer " + unitId);
} else if (role === "developer") {
  if (mode === "faildev") {
    console.log("worker developer " + unitId + " fail（不写账本）");
    process.exit(1);
  }
  const unit = loadLedger(cwd).projection.units.get(unitId);
  if (unit === undefined || unit.specs.length === 0) throw new Error("developer: unit " + unitId + " 无 spec");
  const acceptanceIds = unit.specs[unit.specs.length - 1].acceptance.map((a) => a.id);
  const runId = "run-" + unitId + "-" + Date.now();
  const ledger = ledgerForCwd(cwd);
  ledger.append("EvidenceSubmitted", { unitId, runId, commit, paths: ["app.js"], sha256: [sha("app.js")], exitCode: 0 });
  ledger.append("VerifyRan", { unitId, runId, reportHash: sha("evidence-report:" + runId), result: "pass", acceptanceIds });
  console.log("worker-done developer " + unitId);
} else if (role === "reviewer") {
  const unit = loadLedger(cwd).projection.units.get(unitId);
  const status = unit === undefined ? "created" : unitStatus(unit);
  if (status === "verified") {
    ledgerForCwd(cwd).append("VerdictSubmitted", { unitId, verdictKind: "exec-review", verdict: "pass", role: "reviewer" });
    console.log("worker-done reviewer exec-review " + unitId);
  } else if (mode === "failspec") {
    ledgerForCwd(cwd).append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "fail", role: "reviewer", comment: "验收覆盖不足（i2a 测试打回）" });
    console.log("worker-done reviewer spec-review fail " + unitId);
  } else {
    ledgerForCwd(cwd).append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    console.log("worker-done reviewer spec-review pass " + unitId);
  }
} else {
  throw new Error("worker: 未知 role " + role);
}
`;
  const path = join(tmpRoot, "i2a-worker.mjs");
  writeFileSync(path, script);
  return path;
}

const WORKER_PATH = writeWorkerScript();

function makeScriptAdapter(mode: "work" | "faildev" | "failspec", commit: string): AgentSpawnAdapter {
  return {
    name: `i2a-test-${mode}`,
    spawn: async (req: AgentSpawnRequest): Promise<SpawnHandle> => {
      const handle = spawnProcess({
        command: process.execPath,
        args: [WORKER_PATH, req.role, req.unitId, req.projectCwd, mode, commit],
        cwd: req.workdir,
        timeoutMs: req.timeoutMs,
        stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
        stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
      });
      return { wait: (): Promise<SpawnResult> => handle.wait(), kill: handle.kill };
    },
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

function makeRepo(name: string): { repoDir: string; head: string } {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-i2a@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-i2a"]);
  writeFileSync(join(repoDir, "brief.md"), "# i2a fixture 任务书\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  return { repoDir, head: gitRun(repoDir, ["rev-parse", "HEAD"]) };
}

function appendUnitCreated(repoDir: string, unitId: string): void {
  ledgerForCwd(repoDir).append("UnitCreated", {
    unitId,
    parentId: null,
    briefRef: join(repoDir, "brief.md"),
  });
}

function statusOf(repoDir: string, unitId: string): string {
  const unit = loadLedger(repoDir).projection.units.get(unitId);
  if (unit === undefined) {
    throw new Error(`unit ${unitId} 不在账本（fixture 前置失败）`);
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

// ---- 验收 1：PP6 同源回归（库形态与 CLI 形态同账本双跑续接） ----

describe("u-i2-a PP6 同源回归：同账本双跑续接，frontier 一致、closed 不重做", () => {
  it("失败 developer 半程退出 → 第二个 runLoop 续接到 closed，已完成阶段不重复入账", async () => {
    const { repoDir, head } = makeRepo("pp6");
    appendUnitCreated(repoDir, "root");

    // 第一段：developer 恒失败（不写账本）→ 循环重派至 maxIdle exit 1（半程中间态）
    const first = await captureStd(() =>
      runLoop({
        rootId: "root",
        adapter: makeScriptAdapter("faildev", head),
        cwd: repoDir,
        pollMs: 40,
        maxIdleMs: 900,
      }),
    );
    expect(first.code).toBe(1);
    expect(first.err).toContain("无账本进展");
    expect(statusOf(repoDir, "root")).toBe("spec-frozen");
    const atCheckpoint = loadLedger(repoDir).projection;
    const checkpointSpecs = atCheckpoint.units.get("root")?.specs.length;
    const checkpointSpecReviews =
      atCheckpoint.units.get("root")?.verdicts.filter((v) => v.verdictKind === "spec-review").length;
    expect(checkpointSpecs).toBe(1);
    expect(checkpointSpecReviews).toBe(1);

    // 第二段：全链适配器续接——收集 onEvent，断言首轮 round 摘要与检查点投影一致
    const events: LoopEvent[] = [];
    const second = await captureStd(() =>
      runLoop({
        rootId: "root",
        adapter: makeScriptAdapter("work", head),
        cwd: repoDir,
        pollMs: 40,
        maxIdleMs: 20_000,
        onEvent: (ev) => {
          events.push(ev);
        },
      }),
    );
    expect(second.code).toBe(0);
    expect(statusOf(repoDir, "root")).toBe("closed");

    // 首轮 round 事件 = 续接起点的 frontier 摘要：developer 派发维度（buildReady）
    // 恰含 root（spec-frozen 叶子），spec 维度全空（已完成阶段不重做）
    const firstRound = events.find((ev) => ev.kind === "round");
    expect(firstRound).toBeDefined();
    if (firstRound?.kind === "round") {
      expect(firstRound.frontierSummary.buildReady).toBe(1);
      expect(firstRound.frontierSummary.specReady).toBe(0);
      expect(firstRound.frontierSummary.specReviewPending).toBe(0);
    }
    // closed 不重做：spec 与 spec-review 数量与检查点一致（无重复入账）
    const finalUnit = loadLedger(repoDir).projection.units.get("root");
    expect(finalUnit?.specs.length).toBe(checkpointSpecs);
    expect(finalUnit?.verdicts.filter((v) => v.verdictKind === "spec-review").length).toBe(checkpointSpecReviews);
  }, 60_000);
});

// ---- 验收 2：onEvent 事件流（round/dispatch/settled/reflection 各至少一次） ----

describe("u-i2-a onEvent 事件流", () => {
  it("全链推进：round/dispatch/settled/reflection 至少各一次，subagentSlug 形态正确", async () => {
    const { repoDir, head } = makeRepo("events");
    appendUnitCreated(repoDir, "root");
    {
      const events: LoopEvent[] = [];
      const captured = await captureStd(() =>
        runLoop({
          rootId: "root",
          adapter: makeScriptAdapter("work", head),
          cwd: repoDir,
          pollMs: 40,
          maxIdleMs: 20_000,
          onEvent: (ev) => {
            events.push(ev);
          },
        }),
      );
      expect(captured.code).toBe(0);
      expect(statusOf(repoDir, "root")).toBe("closed");

      const kinds = new Set(events.map((ev) => ev.kind));
      for (const kind of ["round", "dispatch", "settled", "reflection"] as const) {
        expect(kinds.has(kind), `事件流应含 ${kind}（实测 kinds：${[...kinds].join(",")}）`).toBe(true);
      }
      // dispatch 的 subagentSlug = `${unitId}-${role}`（面板对账锚）
      const dispatches = events.filter((ev): ev is Extract<LoopEvent, { kind: "dispatch" }> => ev.kind === "dispatch");
      expect(dispatches.length).toBeGreaterThanOrEqual(4); // designer/reviewer/developer/reviewer
      expect(dispatches[0]?.subagentSlug).toBe("root-designer");
      // round 事件 seq 单调递增且 frontierSummary 含维度键
      const rounds = events.filter((ev): ev is Extract<LoopEvent, { kind: "round" }> => ev.kind === "round");
      const seqs = rounds.map((r) => r.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(rounds[0]?.frontierSummary.specReady).toBe(1);
      // settled 事件带四态结果（exit 0）
      const settled = events.filter((ev): ev is Extract<LoopEvent, { kind: "settled" }> => ev.kind === "settled");
      expect(settled.length).toBeGreaterThanOrEqual(4);
      expect(settled.every((s) => s.result.exitCode === 0)).toBe(true);
      // reflection：占位 ReflectionRan 路径（一次性后端）——round 1、unitId=root
      const reflection = events.find((ev): ev is Extract<LoopEvent, { kind: "reflection" }> => ev.kind === "reflection");
      expect(reflection?.unitId).toBe("root");
      expect(reflection?.round).toBe(1);
    }
  }, 60_000);
});

// ---- 验收 3：stopped（maxSpecRejects=1 快速构造 specReviewDeadlock） ----

describe("u-i2-a stopped 事件：停派维度命中", () => {
  it("reviewer 恒打回 + maxSpecRejects=1 → specReviewDeadlock 停派，stopped 事件命中且去重", async () => {
    const { repoDir } = makeRepo("stopped");
    appendUnitCreated(repoDir, "root");
    const events: LoopEvent[] = [];

    const captured = await captureStd(() =>
      runLoop({
        rootId: "root",
        adapter: makeScriptAdapter("failspec", ""),
        cwd: repoDir,
        pollMs: 40,
        maxIdleMs: 900,
        maxSpecRejects: 1,
        onEvent: (ev) => {
          events.push(ev);
        },
      }),
    );
    // 审计-不喂-idle：停派后无新事件，空转由 maxIdle 收束（exit 1）
    expect(captured.code).toBe(1);
    expect(captured.err).toContain("打回循环活锁");

    const stopped = events.filter((ev): ev is Extract<LoopEvent, { kind: "stopped" }> => ev.kind === "stopped");
    expect(stopped.length).toBeGreaterThanOrEqual(1);
    expect(stopped[0]?.unitId).toBe("root");
    expect(stopped[0]?.dimension).toBe("specReviewDeadlock");
    expect(stopped[0]?.reason).toContain("spec-review");
    // 每 unit×维度只发一次（多轮空转不重发）
    expect(stopped.filter((s) => s.dimension === "specReviewDeadlock").length).toBe(1);
  }, 60_000);
});

// ---- 验收 4：onEvent 抛错韧性 ----

describe("u-i2-a onEvent 抛错韧性", () => {
  it("回调每次 throw：主循环照常收敛 closed（exit 0），stderr 有吞错记录", async () => {
    const { repoDir, head } = makeRepo("throwing");
    appendUnitCreated(repoDir, "root");
    try {
      const captured = await captureStd(() =>
        runLoop({
          rootId: "root",
          adapter: makeScriptAdapter("work", head),
          cwd: repoDir,
          pollMs: 40,
          maxIdleMs: 20_000,
          onEvent: () => {
            throw new Error("i2a 测试：onEvent 消费者崩了");
          },
        }),
      );
      expect(captured.code).toBe(0);
      expect(statusOf(repoDir, "root")).toBe("closed");
      expect(captured.err).toContain("onEvent 回调抛错");
      expect(captured.err).toContain("i2a 测试：onEvent 消费者崩了");
    } finally {
      // no-op：I2A_COMMIT env 方案已废弃为 argv 传递，无清理项
    }
  }, 60_000);
});

// ---- 验收 5：库形态消费（./runner 子路径门面 dist/runner.js） ----

describe("u-i2-a 库形态消费：dist/runner.js 门面", () => {
  it("从 ./runner 门面 import runLoop 跑最小全链到 closed", async () => {
    const runnerModule = (await import("../dist/runner.js")) as {
      runLoop: typeof runLoop;
    };
    expect(typeof runnerModule.runLoop).toBe("function");

    const { repoDir, head } = makeRepo("library");
    appendUnitCreated(repoDir, "root");
    const events: LoopEvent[] = [];
    const code = await runnerModule.runLoop({
      rootId: "root",
      adapter: makeScriptAdapter("work", head),
      cwd: repoDir,
      pollMs: 40,
      maxIdleMs: 20_000,
      onEvent: (ev) => {
        events.push(ev);
      },
    });
    expect(code).toBe(0);
    expect(statusOf(repoDir, "root")).toBe("closed");
    expect(events.some((ev) => ev.kind === "dispatch")).toBe(true);
  }, 60_000);
});

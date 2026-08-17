/**
 * wt-3 单测：reset 近似实现删除后的行为锁定（W3 纯删除波）。
 *
 * 用例对应 docs/rewrite/acceptance/wt3-acceptance.md §4：
 *   - A1 项目 cwd 不再被 reset：预置 tracked 脏改动跨重派轮次原样保留
 *     （锁死 W3 行为变化，防共享 cwd 近似 reset 复活）
 *   - A2 worktree 半成品清理仍生效（防删过头）：失败 builder 留在 worktree 的
 *     tracked 脏 + untracked（含手工伪造的 .cw-spawn）重派前被派发点
 *     ensureUnitWorktree 清净（fx-4 起裸 clean -fd、porcelain 全空，与 wt2 T3 同语义）
 *   - A3 派发流程零回归：fake adapter 收敛 root closed（exit 0），输出无
 *     「派发前清理」字样（旧文案已随近似实现整体删除）
 *
 * 真实环境零 mock：runLoop 从 dist 直调，真实 git 子进程 + tmp git 仓库 +
 * 隔离 CW_HOME/CW_WORKTREE_HOME；adapter 为进程内 fake（观测/注入副作用），
 * 与 wt2/u7b 的测试专用适配器同模式。注意：直接 `npx vitest run
 * tests/wt3-reset-legacy-removal.test.ts` 不触发 pretest，需先 `npm run build`
 * （`npm test` 的 pretest 已含）。
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
import { loadLedger, unitStatus } from "../dist/readonly/load.js";
import { runLoop } from "../dist/runner/loop.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
  SpawnResult,
} from "../dist/runner/spawn/types.js";
import { worktreePath } from "../dist/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
for (const required of [join(DIST_ROOT, "runner", "loop.js")]) {
  if (!existsSync(required)) {
    throw new Error(`tests/wt3-reset-legacy-removal 需要 ${required}（先 npm run build；npm test 的 pretest 已含）`);
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-wt3-"));
const cwHome = join(tmpRoot, "cw-home");
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_HOME = cwHome;
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

// ---- fixture 基建（真实 git repo + 真实账本直写，wt2/u7b 同款） ----

function gitRun(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git -C ${dir} ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

const BRIEF_CONTENT = "# wt3 fixture 任务书\n";

/** 真实 git 仓库（brief + a.txt 一个真实 commit），返回 HEAD 全 hash */
function initRepo(name: string): { repoDir: string; head: string } {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-wt3@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-wt3"]);
  writeFileSync(join(repoDir, "brief.md"), BRIEF_CONTENT);
  writeFileSync(join(repoDir, "a.txt"), "a\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  return { repoDir, head: gitRun(repoDir, ["rev-parse", "HEAD"]) };
}

const FIXTURE_ACCEPTANCE: AcceptanceItem[] = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function appendUnitCreated(repoDir: string, unitId: string): void {
  ledgerForCwd(repoDir).append("UnitCreated", {
    unitId,
    parentId: null,
    briefRef: join(repoDir, "brief.md"),
  });
}

/** 预置 spec-frozen unit（SpecSubmitted + spec-review pass；split 空 = 叶子） */
function appendSpecFrozen(repoDir: string, unitId: string): void {
  const ledger = ledgerForCwd(repoDir);
  const spec = { acceptance: FIXTURE_ACCEPTANCE, contracts: [], split: [] };
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: sha(JSON.stringify(spec)),
    acceptance: FIXTURE_ACCEPTANCE,
    contracts: [],
    split: [],
  });
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass" });
}

function statusOf(repoDir: string, unitId: string): string {
  const unit = loadLedger(repoDir).projection.units.get(unitId);
  if (unit === undefined) {
    throw new Error(`unit ${unitId} 不在账本（fixture 断言前置失败）`);
  }
  return unitStatus(unit);
}

/** 按推进一步（designer → spec+过审；builder → evidence+verify；reviewer → exec-review） */
function advanceStep(repoDir: string, unitId: string, role: AgentSpawnRequest["role"], commit: string): void {
  const ledger = ledgerForCwd(repoDir);
  if (role === "designer") {
    appendSpecFrozen(repoDir, unitId);
    return;
  }
  if (role === "builder") {
    const unit = loadLedger(repoDir).projection.units.get(unitId);
    const acceptanceIds =
      unit?.specs[unit.specs.length - 1]?.acceptance.map((a) => a.id) ?? FIXTURE_ACCEPTANCE.map((a) => a.id);
    const runId = `run-${unitId}-${Date.now()}`;
    ledger.append("EvidenceSubmitted", {
      unitId,
      runId,
      commit,
      paths: ["app.js"],
      sha256: [sha("app.js")],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId,
      runId,
      reportHash: sha(`evidence-report:${runId}`),
      result: "pass",
      acceptanceIds,
    });
    return;
  }
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "exec-review", verdict: "pass" });
}

/** 捕获 runLoop 的 stdout/stderr（进程内直调，透传 write 回调——u7b/wt2 同款） */
async function captureStd(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const collector = (chunks: string[]): typeof process.stdout.write =>
    ((chunk: unknown, cb?: (err?: Error | null) => void) => {
      chunks.push(String(chunk));
      // 透传回调：loop.ts 的 emitExitOutput 退出屏障依赖 write 回调等待 flush，
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

// ---- fake adapter（spawn 时同步副作用 + wait() 按脚本返回四态） ----

function handleOf(req: AgentSpawnRequest, exitCode: SpawnResult["exitCode"]): SpawnHandle {
  return {
    wait: async () => ({
      exitCode,
      // fx-4：产物路径从 req.artifactDir 拼装（run 级 topic 目录）
      stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
      stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
      pid: -1,
    }),
    kill: () => {},
  };
}

interface FakeStep {
  exitCode: SpawnResult["exitCode"];
  /** spawn 时同步执行（改工作区文件 / 捕获现场），模拟 agent 的真实副作用 */
  onSpawn?: (req: AgentSpawnRequest) => void;
}

/** 脚本化 adapter：第 N 次 spawn 用第 N 个 step（越界沿用最后一个），记录全部请求 */
function makeSteppedAdapter(steps: readonly FakeStep[]): {
  adapter: AgentSpawnAdapter;
  calls: AgentSpawnRequest[];
} {
  const calls: AgentSpawnRequest[] = [];
  return {
    adapter: {
      name: "wt3-stepped",
      spawn: async (req) => {
        calls.push(req);
        const step = steps[Math.min(calls.length - 1, steps.length - 1)];
        step.onSpawn?.(req);
        return handleOf(req, step.exitCode);
      },
    },
    calls,
  };
}

// ---- A1：项目 cwd 不再被 reset（W3 行为变化锁定） ----

describe("wt3 A1 项目 cwd 不再被 reset", () => {
  it("项目 cwd 预置 tracked 脏改动（改 a.txt 不 commit）→ runLoop 失败重派多轮 → 脏改动原样保留（内容与 porcelain 双断言；旧近似会 git reset --hard 掉它）", async () => {
    const { repoDir } = initRepo("a1");
    appendUnitCreated(repoDir, "a1");
    appendSpecFrozen(repoDir, "a1"); // 直接 spec-frozen → 首派 builder
    // 项目 cwd 预置 tracked 脏改动（用户的进行中工作，不属于任何 agent）
    const dirtyContent = "a\n<!-- user's dirty change -->\n";
    writeFileSync(join(repoDir, "a.txt"), dirtyContent);

    let porcelainAtRedispatch = "(not captured)";
    let contentAtRedispatch = "(not captured)";
    const script = makeSteppedAdapter([
      { exitCode: 1 }, // 失败 builder：制造重派轮次
      {
        // 重派轮次（越界沿用，仅首次捕获现场）：此刻旧近似已对项目 cwd
        // reset --hard——若脏改动消失即近似复活
        exitCode: 1,
        onSpawn: (req) => {
          if (porcelainAtRedispatch !== "(not captured)") {
            return;
          }
          porcelainAtRedispatch =
            spawnSync("git", ["-C", req.projectCwd, "status", "--porcelain"], { encoding: "utf-8" }).stdout ?? "";
          contentAtRedispatch = readFileSync(join(req.projectCwd, "a.txt"), "utf-8");
        },
      },
    ]);

    const captured = await captureStd(() =>
      runLoop({ rootId: "a1", adapter: script.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 600 }),
    );

    expect(captured.code).toBe(1); // 无账本进展 → maxIdle 兜底收束（非崩溃）
    expect(script.calls.length).toBeGreaterThan(1); // 重派轮次真实发生
    // 重派现场：tracked 脏改动仍在（内容未回滚、porcelain 仍报脏）
    expect(contentAtRedispatch).toBe(dirtyContent);
    const dirtyLines = porcelainAtRedispatch.split("\n").filter((line) => line.includes("a.txt"));
    expect(dirtyLines.length).toBe(1);
    expect(dirtyLines[0]?.trim().startsWith("M")).toBe(true);
    // 循环结束后项目 cwd 仍原样保留（全程无 reset 触碰）
    expect(readFileSync(join(repoDir, "a.txt"), "utf-8")).toBe(dirtyContent);
  }, 15_000);
});

// ---- A2：worktree 半成品清理仍生效（防删过头；fx-4 语义反转：无 -e 例外条款） ----

describe("wt3 A2 worktree 半成品清理仍生效", () => {
  it("失败 builder 在 unit worktree 留 tracked 脏改 + untracked 产物 + 伪造 .cw-spawn → 重派 spawn 时 worktree porcelain 全空（裸 clean -fd 无例外条款；伪造目录一并被清、topic 产物不在 worktree 所以无东西可保护）", async () => {
    const { repoDir } = initRepo("a2");
    appendUnitCreated(repoDir, "a2");
    appendSpecFrozen(repoDir, "a2");
    const wtDir = worktreePath(WT_HOME, repoDir, "a2");

    let porcelainAtRedispatch = "(not captured)";
    const script = makeSteppedAdapter([
      {
        // 失败 builder：在自己的 worktree 留 tracked 脏改（brief.md）+ untracked 产物 +
        // 手工伪造 .cw-spawn/x（旧习惯 agent 自建——普通 untracked，被清是正确语义）
        exitCode: 1,
        onSpawn: (req) => {
          writeFileSync(join(req.workdir, "brief.md"), `${BRIEF_CONTENT}<!-- half-done -->`);
          writeFileSync(join(req.workdir, "half-done.tmp"), "half-done");
          mkdirSync(join(req.workdir, ".cw-spawn"), { recursive: true });
          writeFileSync(join(req.workdir, ".cw-spawn", "forged.txt"), "forged\n");
        },
      },
      {
        // 重派：此刻派发点 ensure 的 reset --hard + clean -fd（fx-4 裸形态，无 -e）
        // 已清半成品——捕获现场（仅首次）
        exitCode: 1,
        onSpawn: (req) => {
          if (porcelainAtRedispatch !== "(not captured)") {
            return;
          }
          porcelainAtRedispatch =
            spawnSync("git", ["-C", req.workdir, "status", "--porcelain"], { encoding: "utf-8" }).stdout ?? "";
        },
      },
    ]);

    const captured = await captureStd(() =>
      runLoop({ rootId: "a2", adapter: script.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 600 }),
    );

    expect(captured.code).toBe(1);
    expect(script.calls.length).toBeGreaterThan(1); // 重派真实发生
    // porcelain 全空：无 -e 例外条款，伪造的 .cw-spawn 一并被清
    expect(porcelainAtRedispatch).toBe("");
    // 半成品确实被清掉（文件本体消失 / tracked 内容回滚，非 porcelain 误报）
    expect(existsSync(join(wtDir, "half-done.tmp"))).toBe(false);
    expect(existsSync(join(wtDir, ".cw-spawn"))).toBe(false);
    expect(readFileSync(join(wtDir, "brief.md"), "utf-8")).toBe(BRIEF_CONTENT);
    // cw 产物（历次派发的 brief）不在 worktree——在 run 级 topic 目录（fx-4 迁移）
    expect(existsSync(join(wtDir, ".cw-spawn", "a2.builder.brief.md"))).toBe(false);
  }, 15_000);
});

// ---- A3：派发流程零回归 ----

describe("wt3 A3 派发流程零回归", () => {
  it("fake adapter 按角色推账本 → runLoop 完整收敛 root closed（exit 0），输出无「派发前清理」字样（旧文案已随近似实现删除）", async () => {
    const { repoDir, head } = initRepo("a3");
    appendUnitCreated(repoDir, "a3"); // created 起：designer → builder → reviewer 全链

    const calls: AgentSpawnRequest[] = [];
    const adapter: AgentSpawnAdapter = {
      name: "wt3-full-run",
      spawn: async (req) => {
        calls.push(req);
        advanceStep(repoDir, req.unitId, req.role, head);
        return handleOf(req, 0);
      },
    };

    const captured = await captureStd(() =>
      runLoop({ rootId: "a3", adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 60_000 }),
    );

    expect(captured.code).toBe(0); // 正常收敛（非 maxIdle 兜底）
    expect(statusOf(repoDir, "a3")).toBe("closed");
    expect(captured.out).toContain('root "a3" 已 closed');
    // 旧近似的可观测文案不复存在（stdout/stderr 双查）
    expect(captured.out).not.toContain("派发前清理");
    expect(captured.err).not.toContain("派发前清理");
    // 全链真实走过三角色
    expect(calls.map((c) => c.role)).toEqual(["designer", "builder", "reviewer"]);
  }, 30_000);
});

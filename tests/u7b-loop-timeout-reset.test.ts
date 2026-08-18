/**
 * u7b 单测：runner 循环的两个健壮性修复——连续 TIMEOUT 转人工 + 重派前 worktree
 * 半成品清理。直调 dist 的 runLoop + 测试专用 stepped adapter（spawn 时同步执行
 * 副作用（写账本 / 改工作区文件），wait() 按脚本返回四态退出——与 u7/fx 系列的
 * 测试专用适配器同模式）；账本与 git 仓库均真实（零 mock 框架）。
 *
 * 用例编号对应修复项：
 *   1. 连续 2 次 TIMEOUT（无账本进展）→ 转人工：不再派发、stderr 转人工指引
 *      （含恢复动作与产物路径）、无可推进后 exit 1 汇总
 *   2. TIMEOUT 间穿插账本进展 → 计数清零（「连续」语义）
 *   3. 多 unit：一个转人工后其余 unit 继续推进（循环不因单 unit 卡死）
 *   4. 失败 builder 的半成品 → 重派前由派发点 ensureUnitWorktree 清理
 *      （reset --hard + clean -fd 裸形态，wt-2 起清 unit worktree；fx-4 起无 -e 例外）；
 *      项目 cwd 属于用户，runner 不触碰（W3 已删共享 cwd 近似 reset）
 *
 * 注意：直接 `npx vitest run tests/u7b-loop-timeout-reset.test.ts` 不触发 pretest，
 * 需先 `npm run build`（`npm test` 的 pretest 已含）。
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
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
  SpawnResult,
} from "../dist/runner/spawn/types.js";
import { encodeCwd, worktreePath } from "../dist/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
for (const required of [join(DIST_ROOT, "runner", "loop.js")]) {
  if (!existsSync(required)) {
    throw new Error(`tests/u7b-loop 需要 ${required}（先 npm run build；npm test 的 pretest 已含）`);
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u7b-loop-"));
// 直调场景：测试进程与副作用同进程共享 CW_HOME（stepped adapter 在本进程写账本）
process.env.CW_HOME = join(tmpRoot, "cw-home");
// wt-2 迁移：派发 workdir 迁 unit worktree，隔离 worktree 根（与 CW_HOME 同款）
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

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
  gitRun(repoDir, ["config", "user.email", "cw-u7b@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-u7b"]);
  writeFileSync(join(repoDir, "brief.md"), "# u7b fixture 任务书\n");
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

/** 预置 spec-frozen unit（SpecSubmitted + spec-review pass；split 可空） */
function appendSpecFrozen(repoDir: string, unitId: string, split: SplitEntry[] = []): void {
  const ledger = ledgerForCwd(repoDir);
  const spec = { acceptance: FIXTURE_ACCEPTANCE, contracts: [], split };
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: sha(JSON.stringify(spec)),
    acceptance: FIXTURE_ACCEPTANCE,
    contracts: [],
    split,
  });
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
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

/** 捕获 runLoop 的 stdout/stderr（进程内直调） */
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

// ---- stepped adapter（spawn 时同步副作用 + wait() 按脚本返回四态） ----

interface AdapterStep {
  exitCode: SpawnResult["exitCode"];
  /** spawn 时同步执行（写账本 / 改工作区文件），模拟 agent 的真实副作用 */
  onSpawn?: (req: AgentSpawnRequest) => void;
}

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

/** 脚本化 adapter：第 N 次 spawn 用第 N 个 step（越界沿用最后一个），记录全部请求 */
function makeSteppedAdapter(steps: readonly AdapterStep[]): {
  adapter: AgentSpawnAdapter;
  calls: AgentSpawnRequest[];
} {
  const calls: AgentSpawnRequest[] = [];
  return {
    adapter: {
      name: "u7b-stepped",
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

// ---- 1. 连续 2 次 TIMEOUT → 转人工 ----

describe("连续 TIMEOUT 转人工", () => {
  it("连续 2 次 TIMEOUT（无账本进展）→ 第 3 轮不再派发该 unit，stderr 含转人工指引与产物路径，exit 1 汇总", async () => {
    const { repoDir } = makeRepo("timeout-escalate");
    appendUnitCreated(repoDir, "root", null);
    const script = makeSteppedAdapter([{ exitCode: "TIMEOUT" }, { exitCode: "TIMEOUT" }]);

    const captured = await captureStd(() =>
      runLoop({ rootId: "root", adapter: script.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 60_000 }),
    );

    expect(captured.code).toBe(1);
    // 第 3 轮不再派发：全部 spawn 恰为 2 次
    expect(script.calls.length).toBe(2);
    expect(script.calls.map((c) => c.unitId)).toEqual(["root", "root"]);
    // 转人工指引：事实 + 恢复动作（人工接手 / 产物路径）
    expect(captured.err).toContain('unit "root" 的 designer 连续 2 次 spawn TIMEOUT');
    expect(captured.err).toContain("转人工");
    expect(captured.err).toContain("cw run --root root --spawn human");
    // fx-4 迁移：转人工指引的产物路径随派发迁 run 级 topic 目录
    expect(captured.err).toContain(
      join(findTopicDir(process.env.CW_HOME ?? "", repoDir, "root"), "root.designer.stdout"),
    );
    // 收束汇总：列出转人工清单
    expect(captured.err).toContain("转人工 unit 共 1 个");
    expect(captured.err).toContain("- root");
    expect(statusOf(repoDir, "root")).toBe("created");
  }, 30_000);

  it("TIMEOUT 间穿插账本进展 → 计数清零：第 2 次 TIMEOUT 前 agent 已写 spec 不误转，共 4 次 spawn 才封顶", async () => {
    const { repoDir } = makeRepo("timeout-progress-reset");
    appendUnitCreated(repoDir, "root", null);
    const script = makeSteppedAdapter([
      { exitCode: "TIMEOUT" }, // 第 1 次：无进展
      {
        // 第 2 次：agent 被 kill 前已写 spec+过审（TIMEOUT 但有产出）→ 不累计
        exitCode: "TIMEOUT",
        onSpawn: (req) => advanceStep(req.projectCwd, req.unitId, "designer", ""),
      },
      { exitCode: "TIMEOUT" }, // 清零后第 1 次（builder）
      { exitCode: "TIMEOUT" }, // 清零后第 2 次（builder）→ 转人工
    ]);

    const captured = await captureStd(() =>
      runLoop({ rootId: "root", adapter: script.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 60_000 }),
    );

    expect(captured.code).toBe(1);
    expect(script.calls.length).toBe(4);
    // 前 2 次派 designer（created），有进展清零后 unit 已 spec-frozen → 后 2 次派 builder
    expect(script.calls.map((c) => c.role)).toEqual(["designer", "designer", "builder", "builder"]);
    // 转人工指引只在封顶后出现一次（第 2 次 TIMEOUT 有进展，不触发）
    expect(captured.err).toContain('unit "root" 的 builder 连续 2 次 spawn TIMEOUT');
    expect(statusOf(repoDir, "root")).toBe("spec-frozen");
  }, 30_000);

  it("多 unit 树：一个 unit 转人工后其余 unit 继续推进至 closed，全部无可推进后 exit 1（转人工 unit 阻塞 root 集成）", async () => {
    const { repoDir, head } = makeRepo("mixed-units");
    appendUnitCreated(repoDir, "root", null);
    appendSpecFrozen(repoDir, "root", [
      { unitId: "leaf-a", dependsOn: [] },
      { unitId: "leaf-b", dependsOn: [] },
    ]);
    appendUnitCreated(repoDir, "leaf-a", "root");
    appendUnitCreated(repoDir, "leaf-b", "root");

    const calls: AgentSpawnRequest[] = [];
    const adapter: AgentSpawnAdapter = {
      name: "u7b-mixed",
      spawn: async (req) => {
        calls.push(req);
        // leaf-a 的 designer 永远超时（2 次后转人工）；其余 unit/role 正常推进
        if (req.unitId === "leaf-a") {
          return handleOf(req, "TIMEOUT");
        }
        advanceStep(req.projectCwd, req.unitId, req.role, head);
        return handleOf(req, 0);
      },
    };

    const captured = await captureStd(() =>
      runLoop({ rootId: "root", adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 60_000, maxConcurrency: 1 }),
    );

    expect(captured.code).toBe(1);
    // leaf-a 恰被派 2 次（转人工封顶），leaf-b 全链推进至 closed——循环没有因 leaf-a 卡死
    expect(calls.filter((c) => c.unitId === "leaf-a").length).toBe(2);
    expect(statusOf(repoDir, "leaf-b")).toBe("closed");
    expect(statusOf(repoDir, "leaf-a")).toBe("created");
    // root 是内部节点：子未全 verified（leaf-a 转人工）→ 集成等待无解，停 spec-frozen
    expect(statusOf(repoDir, "root")).toBe("spec-frozen");
    expect(captured.err).toContain("- leaf-a");
    expect(captured.err).not.toContain("- leaf-b");
  }, 60_000);
});

// ---- 2. 重派前 worktree 清理（wt-2 迁移：清理对象随派发 workdir 迁 unit worktree） ----

describe("重派前 tracked 半成品清理", () => {
  it("失败 builder 在 unit worktree 留下 tracked 脏改 + untracked 产物 → 重派前被 ensure reset 清净（porcelain 为空）；项目 cwd 的用户 untracked 文件不受影响", async () => {
    const { repoDir, head } = makeRepo("reset-dirty");
    // 项目 cwd 预置 untracked 文件（用户/认知外文件——任何清理都不得动它）
    writeFileSync(join(repoDir, "user-notes.txt"), "user's own file");
    appendUnitCreated(repoDir, "root", null);
    appendSpecFrozen(repoDir, "root"); // 直接 spec-frozen → 派 builder

    const wtDir = worktreePath(WT_HOME, repoDir, "root");
    let porcelainAtSecondSpawn = "(not captured)";
    const script = makeSteppedAdapter([
      {
        // 失败 builder：在 unit worktree 改 tracked 文件（brief.md）不提交 + 留
        // untracked 构建产物，exit 1（wt-2 起 agent 的半成品只落在自己的 worktree）
        exitCode: 1,
        onSpawn: (req) => {
          const brief = join(req.workdir, "brief.md");
          writeFileSync(brief, `${readFileSync(brief, "utf-8")}\n<!-- half-done builder output -->`);
          writeFileSync(join(req.workdir, "build-artifact.tmp"), "half-done");
        },
      },
      {
        // 重派 builder：此刻 worktree 应已被派发点 ensure 的 reset --hard + clean -fd
        // 清净（wt-2 精确语义：tracked 脏改与 untracked 一并清，D4）——捕获证据
        exitCode: 0,
        onSpawn: (req) => {
          porcelainAtSecondSpawn = spawnSync("git", ["-C", req.workdir, "status", "--porcelain"], {
            encoding: "utf-8",
          }).stdout ?? "";
          advanceStep(req.projectCwd, req.unitId, "builder", head);
        },
      },
      {
        exitCode: 0,
        onSpawn: (req) => advanceStep(req.projectCwd, req.unitId, "reviewer", ""),
      },
    ]);

    const captured = await captureStd(() =>
      runLoop({ rootId: "root", adapter: script.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 60_000 }),
    );

    expect(captured.code).toBe(0);
    expect(statusOf(repoDir, "root")).toBe("closed");
    // 第二次 spawn（即 ensure reset 之后）时 worktree 全净：tracked 脏改与 untracked
    // 产物均清；fx-4 后 brief 落 topic 目录，worktree 内无任何 cw 残迹（porcelain 归零）
    expect(porcelainAtSecondSpawn).toBe("");
    // 半成品确实被清掉（文件本体消失，不是 porcelain 误报）
    expect(existsSync(join(wtDir, "build-artifact.tmp"))).toBe(false);
    // 项目 cwd 的用户 untracked 文件不受任何清理影响（安全断言：worktree 隔离后
    // builder 半成品不再污染项目 cwd，用户文件更不会被 clean 波及）
    expect(existsSync(join(repoDir, "user-notes.txt"))).toBe(true);
    expect(readFileSync(join(repoDir, "user-notes.txt"), "utf-8")).toBe("user's own file");
    // 重派真实发生（worktree 路径出现在派发日志行）
    expect(captured.out).toContain(`派发 builder → unit "root"（worktree: ${wtDir}`);
  }, 30_000);
});

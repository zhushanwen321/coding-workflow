/**
 * fx-4 单测：spawn 产物收口 topic 目录（docs/rewrite/acceptance/fx4-acceptance.md §5）。
 *
 * 用例 T1-T5 逐条对应验收文档四个场景 + 场景 4 反向断言：
 *   - T1 产出纯净（场景 1）：fake 全链推至 root closed——worktree 内零 .cw-spawn、
 *     root 分支 commit 树零 .cw-spawn 路径、brief/stdout/stderr 全在 topic 目录
 *   - T2 清理极简（场景 2）：tracked 脏 + untracked + 手工伪造 .cw-spawn → 重派
 *     porcelain 全空（无 -e 例外条款）；已 commit 产出保留
 *   - T3 归档与碰撞（场景 3）：同 run 重派同文件 append；跨 run（≥1s）新目录；
 *     同秒重跑 -2 递增后缀（零静默混卷）
 *   - T4 原文副本（场景 3）：spec / build --file / cw create --brief 三类原文入
 *     evidence/<unitId>/attachments/<sha256>.<原文件名>，逐字节等于原文、幂等
 *   - T5 human 接管 + 反向断言（场景 4）：人按指引 cat topic 内 brief、cd worktree
 *     改码 commit、内联前缀 cw 提交 → 事件写项目账本、循环推进；反向：不带前缀
 *     跑 cw create → ~/.cw/ 出现 <encoded-worktree> 分裂空账本目录
 *
 * 真实环境零 mock：runLoop/humanAdapter/topicDir 从 dist 直调（T4 的 dispatch 亦然），
 * 真实 git 子进程 + tmp git 仓库 + 隔离 CW_HOME/CW_WORKTREE_HOME；fake adapter 为
 * 进程内脚本化适配器（wt2/wt3/u7b 同模式），其产物写入按 fx-4 契约落 req.artifactDir。
 * 注意：直接 `npx vitest run tests/fx4-topic-artifacts.test.ts` 不触发 pretest，
 * 需先 `npm run build`（`npm test` 的 pretest 已含）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { dispatch } from "../dist/dispatch.js";
import type { AcceptanceItem } from "../dist/events/types.js";
import { ledgerForCwd } from "../dist/handlers/common.js";
import { loadLedger, unitStatus } from "../dist/readonly/load.js";
import { runLoop } from "../dist/runner/loop.js";
import { humanAdapter } from "../dist/runner/spawn/human.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
  SpawnResult,
} from "../dist/runner/spawn/types.js";
import { addUnitWorktree } from "../dist/runner/worktree.js";
import { EventLedger } from "../dist/store/events-log.js";
import {
  encodeCwd,
  ledgerPath,
  topicDir,
  worktreePath,
} from "../dist/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const CLI_PATH = join(DIST_ROOT, "cli.js");
for (const required of [CLI_PATH, join(DIST_ROOT, "runner", "loop.js")]) {
  if (!existsSync(required)) {
    throw new Error(`tests/fx4-topic-artifacts 需要 ${required}（先 npm run build；npm test 的 pretest 已含）`);
  }
}

// realpath：macOS 的 /var 是 /private/var 的符号链接——T5 反向断言要与子进程的
// process.cwd()（物理路径）精确比对，tmpRoot 必须物理化
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "cw-fx4-topic-")));
const cwHome = join(tmpRoot, "cw-home");
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_HOME = cwHome;
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sha256Hex = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

// ---- fixture 基建（真实 git repo + 真实账本直写，wt2/wt3 同款） ----

function gitRun(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git -C ${dir} ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

const BRIEF_CONTENT = "# fx4 fixture 任务书\n";

/** 真实 git 仓库（brief + a.txt 一个真实 commit），返回 HEAD 全 hash */
function initRepo(name: string): { repoDir: string; head: string } {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-fx4@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-fx4"]);
  writeFileSync(join(repoDir, "brief.md"), BRIEF_CONTENT);
  writeFileSync(join(repoDir, "a.txt"), "a\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  return { repoDir, head: gitRun(repoDir, ["rev-parse", "HEAD"]) };
}

/** 过 u3 五规则的合法验收 fixture（A1 core e2e-real 带 command + A2 unit 级） */
const FIXTURE_ACCEPTANCE: AcceptanceItem[] = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  {
    id: "A2",
    core: false,
    title: "单元级冒烟",
    type: "unit",
    // 伪造 vitest --reporter=json 输出（u5b 同款：translate 的 includes 检查命中，
    // 不再追加 reporter；`--` 使其成为 node 的 script argv 而非 node 自身选项）
    command:
      'node -e "console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:\'A2 unit smoke\',status:\'passed\'}]}]}))" -- --reporter=json',
  },
];

function appendUnitCreated(repoDir: string, unitId: string): void {
  ledgerForCwd(repoDir).append("UnitCreated", {
    unitId,
    parentId: null,
    briefRef: join(repoDir, "brief.md"),
  });
}

/** 预置 spec-frozen unit（SpecSubmitted + spec-review pass；split 空 = 叶子） */
function appendSpecFrozen(repoDir: string, unitId: string, acceptance: AcceptanceItem[] = FIXTURE_ACCEPTANCE): void {
  const ledger = ledgerForCwd(repoDir);
  const spec = { acceptance, contracts: [], split: [] };
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
    acceptance,
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
      sha256: [createHash("sha256").update("app.js").digest("hex")],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId,
      runId,
      reportHash: createHash("sha256").update(`evidence-report:${runId}`).digest("hex"),
      result: "pass",
      acceptanceIds,
    });
    return;
  }
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "exec-review", verdict: "pass" });
}

/** 捕获 runLoop 的 stdout/stderr（进程内直调，透传 write 回调——wt2/u7b 同款） */
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

async function waitUntil(cond: () => boolean, timeoutMs = 10_000, label = "条件"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`等待${label}超时（${timeoutMs}ms）`);
    }
    await sleep(50);
  }
}

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

// ---- fake adapter（产物按 fx-4 契约落 req.artifactDir，append 语义与 lifecycle/human 一致） ----

/** 本文件 fake adapter 的产物段标记（T3a 的 append 断言消费） */
const artifactMark = (seq: number, req: AgentSpawnRequest): string => `fx4-spawn-${seq}-${req.role}\n`;

/** 模拟适配器产物契约：stdout append 一段标记、stderr 空占位（flag "a" 不覆盖历次） */
function appendArtifacts(seq: number, req: AgentSpawnRequest): void {
  mkdirSync(req.artifactDir, { recursive: true });
  appendFileSync(join(req.artifactDir, `${req.unitId}.${req.role}.stdout`), artifactMark(seq, req));
  appendFileSync(join(req.artifactDir, `${req.unitId}.${req.role}.stderr`), "");
}

function resultOf(req: AgentSpawnRequest, exitCode: SpawnResult["exitCode"]): SpawnResult {
  return {
    exitCode,
    stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
    stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
    pid: -1,
  };
}

interface FakeStep {
  exitCode: SpawnResult["exitCode"];
  /** spawn 时同步执行（改工作区文件 / 写账本 / 捕获现场），模拟 agent 的真实副作用 */
  onSpawn?: (req: AgentSpawnRequest) => void;
}

/** 脚本化 adapter：第 N 次 spawn 用第 N 个 step（越界沿用最后一个），记录全部请求 */
function makeSteppedAdapter(steps: readonly FakeStep[]): {
  adapter: AgentSpawnAdapter;
  calls(): readonly AgentSpawnRequest[];
} {
  const calls: AgentSpawnRequest[] = [];
  return {
    adapter: {
      name: "fx4-stepped",
      spawn: async (req) => {
        calls.push(req);
        const step = steps[Math.min(calls.length - 1, steps.length - 1)];
        appendArtifacts(calls.length, req);
        step.onSpawn?.(req);
        return {
          wait: () => Promise.resolve(resultOf(req, step.exitCode)),
          kill: () => {},
        };
      },
    },
    calls: () => calls,
  };
}

// ---- T1：产出纯净（场景 1） ----

describe("fx4 T1 产出纯净（场景 1）", () => {
  it("fake 全链推至 root closed：worktree 内零 .cw-spawn、root 分支 commit 树零 .cw-spawn 路径（add -A 也无从卷入）、brief/stdout/stderr 全在 topic 目录且文件名形态 <unitId>.<role>.*", async () => {
    const { repoDir, head } = initRepo("t1");
    appendUnitCreated(repoDir, "t1");
    const wtDir = worktreePath(WT_HOME, repoDir, "t1");
    const calls: AgentSpawnRequest[] = [];
    const adapter: AgentSpawnAdapter = {
      name: "fx4-full-run",
      spawn: async (req): Promise<SpawnHandle> => {
        calls.push(req);
        appendArtifacts(calls.length, req);
        if (req.role === "builder") {
          // 真实 agent 行为（最坏形态）：worktree 写业务产出后 git add -A + commit——
          // fx-4 前 .cw-spawn 产物会被卷进 evidence commit；fx-4 后 worktree 内
          // 物理上没有 cw 自身文件，by construction 不可能卷入
          writeFileSync(join(req.workdir, "app-t1.txt"), "t1 builder output\n");
          gitRun(req.workdir, ["add", "-A"]);
          gitRun(req.workdir, ["commit", "-m", "t1: app-t1.txt"]);
          advanceStep(repoDir, req.unitId, req.role, gitRun(req.workdir, ["rev-parse", "HEAD"]));
        } else {
          advanceStep(repoDir, req.unitId, req.role, head);
        }
        return {
          wait: () => Promise.resolve(resultOf(req, 0)),
          kill: () => {},
        };
      },
    };

    const captured = await captureStd(() =>
      runLoop({ rootId: "t1", adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 60_000 }),
    );

    expect(captured.code).toBe(0); // 正常收敛 root closed
    expect(statusOf(repoDir, "t1")).toBe("closed");
    expect(calls.map((c) => c.role)).toEqual(["designer", "builder", "reviewer"]);
    // worktree 内不存在 .cw-spawn（fx-4 纯化；root worktree 永不回收，run 后仍在）
    expect(existsSync(join(wtDir, ".cw-spawn"))).toBe(false);
    // root 分支聚合 commit 树零 .cw-spawn 路径（agent 的 evidence commit 用了 add -A）
    const treeFiles = gitRun(repoDir, ["ls-tree", "-r", "--name-only", "cw-root/t1"]).split("\n");
    expect(treeFiles.some((f) => f.includes(".cw-spawn"))).toBe(false);
    expect(treeFiles).toContain("app-t1.txt"); // 前提：树上确有 agent 业务产出
    // 三类产物全在 run 级 topic 目录，文件名形态 <unitId>.<role>.*
    const topic = findTopicDir(cwHome, repoDir, "t1");
    for (const role of ["designer", "builder", "reviewer"] as const) {
      expect(existsSync(join(topic, `t1.${role}.brief.md`)), `${role} brief 应在 topic`).toBe(true);
      expect(existsSync(join(topic, `t1.${role}.stdout`)), `${role} stdout 应在 topic`).toBe(true);
      expect(existsSync(join(topic, `t1.${role}.stderr`)), `${role} stderr 应在 topic`).toBe(true);
    }
    // 派发契约：artifactDir 即 topic 目录（runner 显式传，适配器不感知全局布局）
    for (const req of calls) {
      expect(req.artifactDir).toBe(topic);
    }
  }, 30_000);
});

// ---- T2：清理极简（场景 2） ----

describe("fx4 T2 清理极简（场景 2）", () => {
  it("worktree 预置 tracked 脏 + untracked + 手工伪造 .cw-spawn/x → 重派 porcelain 全空（无任何例外条款，伪造目录一并被清）；已 commit 产出保留", async () => {
    const { repoDir } = initRepo("t2");
    appendUnitCreated(repoDir, "t2");
    appendSpecFrozen(repoDir, "t2"); // 直接 spec-frozen → 首派 builder
    const wtDir = worktreePath(WT_HOME, repoDir, "t2");

    let porcelainAtSecondSpawn = "(not captured)";
    const script = makeSteppedAdapter([
      {
        // 失败 builder：留 tracked 脏改（brief.md）+ untracked 垃圾 + 手工伪造
        // .cw-spawn/x + 一个已 commit 的产出文件（reset/clean 的保留面）
        exitCode: 1,
        onSpawn: (req) => {
          writeFileSync(join(req.workdir, "brief.md"), `${BRIEF_CONTENT}<!-- half-done -->`);
          writeFileSync(join(req.workdir, "garbage.tmp"), "garbage");
          writeFileSync(join(req.workdir, "kept.txt"), "committed output\n");
          gitRun(req.workdir, ["add", "kept.txt"]);
          gitRun(req.workdir, ["commit", "-m", "t2: kept.txt"]);
          mkdirSync(join(req.workdir, ".cw-spawn"), { recursive: true });
          writeFileSync(join(req.workdir, ".cw-spawn", "x"), "forged\n");
        },
      },
      {
        // 重派：此刻 ensure 的 reset --hard + clean -fd（裸形态）已清半成品——捕获现场
        exitCode: 1,
        onSpawn: (req) => {
          porcelainAtSecondSpawn =
            spawnSync("git", ["-C", req.workdir, "status", "--porcelain"], { encoding: "utf-8" }).stdout ?? "";
        },
      },
    ]);

    const captured = await captureStd(() =>
      runLoop({ rootId: "t2", adapter: script.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 600 }),
    );

    expect(captured.code).toBe(1); // 无账本进展 → maxIdle 兜底
    expect(script.calls().length).toBeGreaterThan(1); // 重派真实发生
    // porcelain 全空：无 -e 例外条款，伪造的 .cw-spawn 一并被清
    expect(porcelainAtSecondSpawn).toBe("");
    expect(existsSync(join(wtDir, "garbage.tmp"))).toBe(false);
    expect(existsSync(join(wtDir, ".cw-spawn"))).toBe(false);
    expect(readFileSync(join(wtDir, "brief.md"), "utf-8")).toBe(BRIEF_CONTENT); // tracked 脏改回滚
    // 已 commit 产出保留（tracked 对 reset --hard HEAD / clean -fd 免疫）
    expect(existsSync(join(wtDir, "kept.txt"))).toBe(true);
    expect(readFileSync(join(wtDir, "kept.txt"), "utf-8")).toBe("committed output\n");
  }, 15_000);
});

// ---- T3：归档与碰撞（场景 3） ----

describe("fx4 T3 归档与碰撞（场景 3）", () => {
  it("同 run 重派两次 → 同一 stdout 文件含两段内容（append）；全部派发共用同一 topic 目录", async () => {
    const { repoDir } = initRepo("t3a");
    appendUnitCreated(repoDir, "t3a");
    const script = makeSteppedAdapter([{ exitCode: 1 }, { exitCode: 1 }]); // 两次失败重派

    const captured = await captureStd(() =>
      runLoop({ rootId: "t3a", adapter: script.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 600 }),
    );

    expect(captured.code).toBe(1);
    expect(script.calls().length).toBeGreaterThanOrEqual(2); // 重派真实发生（maxIdle 窗口内可多于 2 次）
    // 同 run：全部派发的 artifactDir 相同（runLoop 启动建一次、全 run 复用）
    expect(script.calls()[0]?.artifactDir).toBe(script.calls()[1]?.artifactDir);
    const topic = findTopicDir(cwHome, repoDir, "t3a");
    expect(script.calls()[0]?.artifactDir).toBe(topic);
    // 同一 stdout 文件含两段内容（append 累积，不覆盖）
    const out = readFileSync(join(topic, "t3a.designer.stdout"), "utf-8");
    expect(out).toContain("fx4-spawn-1-designer");
    expect(out).toContain("fx4-spawn-2-designer");
    expect(out.indexOf("fx4-spawn-1-designer")).toBeLessThan(out.indexOf("fx4-spawn-2-designer"));
  }, 15_000);

  it("退出后间隔 ≥1s 再跑 → 新 topic 目录（runTs 不同），旧目录并存保留", async () => {
    const { repoDir } = initRepo("t3b");
    appendUnitCreated(repoDir, "t3b");
    const hold = (): { adapter: AgentSpawnAdapter; first(): string } => {
      let firstDir = "";
      return {
        adapter: {
          name: "fx4-hold",
          spawn: async (req) => {
            if (firstDir === "") {
              firstDir = req.artifactDir;
            }
            return { wait: () => new Promise<SpawnResult>(() => {}), kill: () => {} };
          },
        },
        first: () => firstDir,
      };
    };

    const run1 = hold();
    const captured1 = await captureStd(() =>
      runLoop({ rootId: "t3b", adapter: run1.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 400 }),
    );
    expect(captured1.code).toBe(1);
    const dir1 = run1.first();

    await sleep(1_100); // runTs 秒级精度：跨秒即自然新目录

    const run2 = hold();
    const captured2 = await captureStd(() =>
      runLoop({ rootId: "t3b", adapter: run2.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 400 }),
    );
    expect(captured2.code).toBe(1);
    const dir2 = run2.first();

    // 新 topic 目录：runTs 不同、目录名不同、零混卷（不 append 进旧目录）
    expect(dir2).not.toBe(dir1);
    expect(dirname(dir1)).toBe(dirname(dir2)); // 同一项目层（<cwHome>/topic/<encoded>/）
    expect(basename(dir2)).not.toBe(basename(dir1));
    // 旧目录并存保留（D5：与 evidence 同级审计资产，不自动清扫）
    expect(existsSync(dir1)).toBe(true);
    expect(existsSync(dir2)).toBe(true);
  }, 20_000);

  it("同秒重跑（topicDir 直调实测）：已存在同名目录 → -2 递增后缀，零静默混卷", () => {
    const { repoDir } = initRepo("t3c");
    let dir1 = topicDir(cwHome, repoDir, "t3c");
    mkdirSync(dir1, { recursive: true });
    let dir2 = topicDir(cwHome, repoDir, "t3c");
    // 跨秒防抖：若两次调用已跨秒（runTs 前移 → dir2 是全新目录非碰撞形态），把 dir2
    // 建出来作为新基线再试——纳秒级间隔下同一秒窗口几乎必中，最多 5 轮
    for (let attempt = 0; attempt < 5 && dir2 !== `${dir1}-2`; attempt++) {
      mkdirSync(dir2, { recursive: true });
      dir1 = dir2;
      dir2 = topicDir(cwHome, repoDir, "t3c");
    }
    expect(dir2).toBe(`${dir1}-2`); // -2 递增后缀出现（D1 碰撞策略）
    expect(dir2).not.toBe(dir1); // 零静默混卷：新调用方拿到新目录，不 append 进旧目录
    expect(existsSync(dir1)).toBe(true);
  });
});

// ---- T4：原文副本（场景 3） ----

describe("fx4 T4 原文副本（场景 3）", () => {
  /** dispatch 直调（进程内，u2 同模式）；CW_HOME 由进程 env 隔离（文件顶部已设） */
  async function run(args: readonly string[], workDir: string): Promise<{ code: number; stderr: string }> {
    const errChunks: string[] = [];
    const origErr = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      errChunks.push(String(chunk));
      return true;
    }) as typeof origErr;
    try {
      const code = await dispatch(args, workDir);
      return { code, stderr: errChunks.join("") };
    } finally {
      process.stderr.write = origErr;
    }
  }

  function attachmentsOf(repoDir: string, unitId: string): string[] {
    const dir = join(cwHome, encodeCwd(repoDir), "evidence", unitId, "attachments");
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  it("spec 提交、build --file 提交、cw create --brief 三类 → evidence/<unitId>/attachments/<sha256(内容)>.<原文件名> 存在且逐字节等于原文；同内容重复提交不新增文件（幂等）", async () => {
    const { repoDir, head } = initRepo("t4");

    // ① spec：原文副本入 attachments（此前只存账本 specHash，本体随 reset 丢失即审计断点）
    //（--file 传绝对路径：dispatch 直调下相对路径按测试进程 cwd 解析，非 workDir）
    appendUnitCreated(repoDir, "t4a");
    const specAbs = join(repoDir, "spec-t4.json");
    writeFileSync(specAbs, `${JSON.stringify({ acceptance: FIXTURE_ACCEPTANCE, contracts: [], split: [] }, null, 2)}\n`);
    const spec = await run(["evidence", "submit", "--kind", "spec", "--unit", "t4a", "--file", specAbs], repoDir);
    expect(spec.code, `spec 提交应成功（stderr: ${spec.stderr}）`).toBe(0);
    const specRaw = readFileSync(specAbs);
    const specDest = join(cwHome, encodeCwd(repoDir), "evidence", "t4a", "attachments", `${sha256Hex(specRaw)}.spec-t4.json`);
    expect(existsSync(specDest)).toBe(true);
    expect(readFileSync(specDest).equals(specRaw)).toBe(true);
    // spec 同内容重提（append 第二条 SpecSubmitted）不新增文件
    const specAgain = await run(["evidence", "submit", "--kind", "spec", "--unit", "t4a", "--file", specAbs], repoDir);
    expect(specAgain.code, `spec 重提应成功（stderr: ${specAgain.stderr}）`).toBe(0);
    expect(attachmentsOf(repoDir, "t4a")).toEqual([`${sha256Hex(specRaw)}.spec-t4.json`]);

    // ② build --file：产物原文副本（--file 不校验在 commit 树内，untracked 同构断点）
    const artifactAbs = join(repoDir, "out.txt");
    writeFileSync(artifactAbs, "fx4 build artifact\n");
    const build1 = await run(
      ["evidence", "submit", "--kind", "build", "--unit", "t4a", "--commit", head, "--run-id", "run-t4-1", "--file", artifactAbs],
      repoDir,
    );
    expect(build1.code, `build 提交应成功（stderr: ${build1.stderr}）`).toBe(0);
    const before = attachmentsOf(repoDir, "t4a");
    const artifactRaw = readFileSync(artifactAbs);
    expect(before).toContain(`${sha256Hex(artifactRaw)}.out.txt`);
    expect(readFileSync(join(cwHome, encodeCwd(repoDir), "evidence", "t4a", "attachments", `${sha256Hex(artifactRaw)}.out.txt`)).equals(artifactRaw)).toBe(true);
    // 同内容不同 runId 重复提交：幂等零增长
    const build2 = await run(
      ["evidence", "submit", "--kind", "build", "--unit", "t4a", "--commit", head, "--run-id", "run-t4-2", "--file", artifactAbs],
      repoDir,
    );
    expect(build2.code, `build 幂等重提应成功（stderr: ${build2.stderr}）`).toBe(0);
    expect(attachmentsOf(repoDir, "t4a")).toEqual(before);

    // ③ cw create --brief：unit 原始 brief 副本（账本 briefRef 是路径引用，本体随 clean 丢失留死路径）
    const briefAbs = join(repoDir, "brief-t4.md");
    writeFileSync(briefAbs, "# t4 unit brief 原文\n");
    const created = await run(["create", "--id", "t4b", "--brief", briefAbs], repoDir);
    expect(created.code, `create 应成功（stderr: ${created.stderr}）`).toBe(0);
    const briefRaw = readFileSync(briefAbs);
    const briefDest = join(cwHome, encodeCwd(repoDir), "evidence", "t4b", "attachments", `${sha256Hex(briefRaw)}.brief-t4.md`);
    expect(existsSync(briefDest)).toBe(true);
    expect(readFileSync(briefDest).equals(briefRaw)).toBe(true);
  });
});

// ---- T5：human 接管 + 反向断言（场景 4） ----

describe("fx4 T5 human 接管 + 反向断言（场景 4）", () => {
  it("正向：人按指引 cat topic 内 brief、cd worktree 改码 commit、内联前缀 cw 提交 → 事件写项目账本、循环推进至 root closed", async () => {
    const { repoDir } = initRepo("t5");
    appendUnitCreated(repoDir, "t5");
    appendSpecFrozen(repoDir, "t5"); // 直接 spec-frozen → 首派 builder（human）
    const wtDir = worktreePath(WT_HOME, repoDir, "t5");
    const runCliInWorktree = (args: readonly string[]): { code: number; stdout: string; stderr: string } => {
      const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
        cwd: wtDir, // 人在 worktree 里执行（指引的 cd 目标）
        encoding: "utf-8",
        env: { ...process.env, CW_HOME: cwHome, CW_PROJECT_DIR: repoDir }, // 内联前缀等价物
      });
      return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    };

    const runPromise = captureStd(() =>
      runLoop({ rootId: "t5", adapter: humanAdapter, cwd: repoDir, pollMs: 50, maxIdleMs: 60_000 }),
    );

    // 1. 等 builder 指令落盘（human spawn 即写 run 级 topic 目录下的产物）
    let topic = "";
    await waitUntil(() => {
      try {
        topic = findTopicDir(cwHome, repoDir, "t5");
        return true;
      } catch {
        return false; // runLoop 尚未建 topic 目录（异步启动窗口）
      }
    }, 10_000, "topic 目录");
    await waitUntil(() => existsSync(join(topic, "t5.builder.stdout")), 10_000, "builder 指令");
    const instruction = readFileSync(join(topic, "t5.builder.stdout"), "utf-8");
    // 指引双路径：cat 的 brief 在 topic 内（fx-4：worktree 内无 cw 文件）；cd 到 worktree
    expect(instruction).toContain(`cat "${join(topic, "t5.builder.brief.md")}"`);
    expect(instruction).toContain(`cd "${wtDir}"`);
    expect(existsSync(join(wtDir, ".cw-spawn"))).toBe(false);

    // 2. 人按指引在 worktree 改码并 commit（验收 command = node app.js）
    writeFileSync(join(wtDir, "app.js"), 'console.log("A1 PASS");\n');
    gitRun(wtDir, ["add", "app.js"]);
    gitRun(wtDir, ["commit", "-m", "t5: app.js"]);
    const commit = gitRun(wtDir, ["rev-parse", "HEAD"]);

    // 3. 内联前缀提交：真实 CLI 子进程（cwd = worktree，CW_PROJECT_DIR 锚定项目账本）
    const submit = runCliInWorktree([
      "evidence", "submit", "--kind", "build", "--unit", "t5",
      "--commit", commit, "--run-id", "run-t5-1", "--file", "app.js",
    ]);
    expect(submit.code, `evidence submit 应成功（stderr: ${submit.stderr}）`).toBe(0);
    const verifyRes = runCliInWorktree(["verify", "--unit", "t5"]);
    expect(verifyRes.code, `verify 应 pass（stdout: ${verifyRes.stdout}，stderr: ${verifyRes.stderr}）`).toBe(0);

    // 4. 循环消费账本事件 → 派 reviewer（指令落盘 topic）→ 人执行 exec-review → root closed
    await waitUntil(() => existsSync(join(topic, "t5.reviewer.brief.md")), 15_000, "reviewer 派发");
    // rv-2 exec-review refs 必填适配（引用上方已入账的 build runId run-t5-1）
    const review = runCliInWorktree(["review", "submit", "--unit", "t5", "--verdict-kind", "exec-review", "--verdict", "pass", "--evidence-refs", "run-t5-1"]);
    expect(review.code, `review submit 应成功（stderr: ${review.stderr}）`).toBe(0);
    const captured = await runPromise;
    expect(captured.code).toBe(0);
    expect(statusOf(repoDir, "t5")).toBe("closed");

    // 5. 事件写项目账本（encoded-cwd = 项目）；worktree 编码下无账本（无分裂）
    const projectEvents = new EventLedger(ledgerPath(cwHome, repoDir)).readAll() as Array<{ type: string; payload: { unitId?: string; runId?: string } }>;
    expect(projectEvents.some((ev) => ev.type === "EvidenceSubmitted" && ev.payload.unitId === "t5" && ev.payload.runId === "run-t5-1")).toBe(true);
    expect(existsSync(ledgerPath(cwHome, wtDir))).toBe(false);
  }, 90_000);

  it("反向：在 worktree 内不带 CW_PROJECT_DIR 跑 cw create（写命令）→ ~/.cw/ 出现 <encoded-worktree> 分裂空账本目录（内联前缀是必要锚定——design-worktree-isolation §4 场景 4 承诺、wt-2 未执行的断言在此补齐）", () => {
    const { repoDir, head } = initRepo("t5r");
    appendUnitCreated(repoDir, "t5r", );
    const wtDir = worktreePath(WT_HOME, repoDir, "t5r");
    expect(addUnitWorktree(repoDir, wtDir, "t5r", "t5r", head)).toEqual({ ok: true });

    // 反向：cwd = worktree、环境无 CW_PROJECT_DIR（create 是写命令，会创建账本目录）
    const env: NodeJS.ProcessEnv = { ...process.env, CW_HOME: cwHome };
    delete env.CW_PROJECT_DIR;
    const res = spawnSync(process.execPath, [CLI_PATH, "create", "--id", "stray", "--brief", "brief.md"], {
      cwd: wtDir,
      encoding: "utf-8",
      env,
    });
    expect(res.status, `反向 create 应成功（写命令不受阻，stderr: ${res.stderr}）`).toBe(0);

    // 分裂空账本目录出现：<cwHome>/<encodeCwd(worktree 路径)>/
    expect(existsSync(join(cwHome, encodeCwd(wtDir)))).toBe(true);
    const strayEvents = new EventLedger(ledgerPath(cwHome, wtDir)).readAll() as Array<{ type: string; payload: { unitId?: string } }>;
    expect(strayEvents.some((ev) => ev.type === "UnitCreated" && ev.payload.unitId === "stray")).toBe(true);
    // 项目账本无 stray（事件被写进分裂账本，未锚定到项目）
    const projectEvents = new EventLedger(ledgerPath(cwHome, repoDir)).readAll() as Array<{ type: string; payload: { unitId?: string } }>;
    expect(projectEvents.some((ev) => ev.type === "UnitCreated" && ev.payload.unitId === "stray")).toBe(false);
  });
});

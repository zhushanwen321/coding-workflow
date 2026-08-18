/**
 * wt-2 单测：spawn 链路 worktree 拆分（W2 行为切换点）。
 *
 * 用例 T1-T10 逐条对应 docs/rewrite/acceptance/wt2-acceptance.md §7：
 *   - T1 派发双传（workdir=worktree / projectCwd=项目 cwd）
 *   - T2 worktree 物理创建 + 分支 base = run 启动 HEAD 快照（R1）
 *   - T3 重派复用与 reset（D5：tracked 脏改 + untracked 全清）
 *   - T4 中断重跑复用分支（R2 步骤 3）
 *   - T5 ensure 失败跳过（R3：不炸循环 + 恢复指引）
 *   - T6 brief 落盘 worktree + 环境约定文案
 *   - T7 pi 适配器 env 注入 CW_PROJECT_DIR
 *   - T8 human 指令内联前缀（CW_PROJECT_DIR="…" cw …）+ cd 双引号 + 账本锚定 projectCwd（场景 4 前半）
 *   - T9 e2e human 全链路（场景 4 完整：worktree 内真实 cw 命令写项目账本）
 *   - T10 非 git cwd 启动即抛可操作错误（R1）
 *   - T11 文件解析锚分离（R-5：--file 跟随进程 cwd，账本跟随 CW_PROJECT_DIR）
 *
 * 全部真实环境零 mock：runLoop/human/pi 适配器从 dist 直调（真实子进程跑 dist/cli.js），
 * tmp git 仓库 + 隔离 CW_HOME/CW_WORKTREE_HOME。注意：直接 `npx vitest run
 * tests/wt2-dispatch-worktree.test.ts` 不触发 pretest，需先 `npm run build`。
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

import { ledgerForCwd } from "../dist/handlers/common.js";
import { runLoop } from "../dist/runner/loop.js";
import { humanAdapter } from "../dist/runner/spawn/human.js";
import { createPiAdapter } from "../dist/runner/spawn/pi.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnResult,
} from "../dist/runner/spawn/types.js";
import { addUnitWorktree, ensureUnitWorktree, removeWorktree } from "../dist/runner/worktree.js";
import { EventLedger } from "../dist/store/events-log.js";
import { encodeCwd, ledgerPath, worktreePath } from "../dist/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const CLI_PATH = join(DIST_ROOT, "cli.js");
for (const required of [CLI_PATH, join(DIST_ROOT, "runner", "loop.js")]) {
  if (!existsSync(required)) {
    throw new Error(`tests/wt2-dispatch-worktree 需要 ${required}（先 npm run build；npm test 的 pretest 已含）`);
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-wt2-"));
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

/** T9 的 spec fixture（过 gate 全规则：core e2e-real 带 command + unit 级用例） */
const SPEC_ACCEPTANCE = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
];

// ---- fixture 基建（真实 git repo + 真实账本直写，wt1/u7 同款） ----

function gitRun(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git -C ${dir} ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

const BRIEF_CONTENT = "# wt2 fixture 任务书\n";

/** 真实 git 仓库（brief + a.txt 一个真实 commit），返回 HEAD 全 hash */
function initRepo(name: string): { repoDir: string; head: string } {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-wt2@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-wt2"]);
  writeFileSync(join(repoDir, "brief.md"), BRIEF_CONTENT);
  writeFileSync(join(repoDir, "a.txt"), "a\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  return { repoDir, head: gitRun(repoDir, ["rev-parse", "HEAD"]) };
}

function appendUnitCreated(repoDir: string, unitId: string, parentId: string | null): void {
  ledgerForCwd(repoDir).append("UnitCreated", {
    unitId,
    parentId,
    briefRef: join(repoDir, "brief.md"),
  });
}

/** 捕获 runLoop 的 stdout/stderr（进程内直调，透传 write 回调——u7 同款） */
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

// ---- 测试专用适配器（hold = wait 永不结算，让 maxIdle 兜底终止循环） ----

function resultOf(req: AgentSpawnRequest, exitCode: SpawnResult["exitCode"]): SpawnResult {
  return {
    exitCode,
    // fx-4：产物路径从 req.artifactDir 拼装（run 级 topic 目录）
    stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
    stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
    pid: -1,
  };
}

/** 每次 spawn 记录 req 后挂住不结算（观测派发入参；循环由 maxIdle 收束） */
function makeHoldAdapter(onSpawn?: (req: AgentSpawnRequest) => void): {
  adapter: AgentSpawnAdapter;
  calls(): readonly AgentSpawnRequest[];
} {
  const calls: AgentSpawnRequest[] = [];
  return {
    adapter: {
      name: "wt2-hold",
      spawn: async (req) => {
        calls.push(req);
        onSpawn?.(req);
        return {
          wait: () => new Promise<SpawnResult>(() => {}),
          kill: () => {},
        };
      },
    },
    calls: () => calls,
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
  calls(): readonly AgentSpawnRequest[];
} {
  const calls: AgentSpawnRequest[] = [];
  return {
    adapter: {
      name: "wt2-stepped",
      spawn: async (req) => {
        calls.push(req);
        const step = steps[Math.min(calls.length - 1, steps.length - 1)];
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

// ---- T1/T2：派发双传 + worktree 物理创建（R1 快照 base） ----

describe("wt2 T1/T2 派发双传与 worktree 创建", () => {
  it("T1 派发双传：req.workdir === worktreePath(WT_HOME, cwd, unitId) 且 req.projectCwd === cwd（CW_WORKTREE_HOME 指 tmp）", async () => {
    const { repoDir } = initRepo("t1");
    appendUnitCreated(repoDir, "t1", null);
    const fake = makeHoldAdapter();

    const captured = await captureStd(() =>
      runLoop({ rootId: "t1", adapter: fake.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 600 }),
    );

    expect(captured.code).toBe(1); // hold 适配器无账本进展 → maxIdle 兜底（不炸即达意）
    expect(fake.calls().length).toBe(1);
    expect(fake.calls()[0]?.workdir).toBe(worktreePath(WT_HOME, repoDir, "t1"));
    expect(fake.calls()[0]?.projectCwd).toBe(repoDir);
  }, 15_000);

  it("T2 worktree 物理创建（D5「亡/亡」格）：目录存在；cw-root/<rootId> = run 启动 HEAD 快照（派发后项目 HEAD 前进也不动 base）", async () => {
    const { repoDir, head } = initRepo("t2");
    appendUnitCreated(repoDir, "t2", null);
    let advanced = false;
    const fake = makeHoldAdapter(() => {
      if (advanced) {
        return;
      }
      advanced = true;
      // 派发已发生后推进项目 HEAD：若 base 取派发时刻 HEAD，分支会被拖到新 commit
      writeFileSync(join(repoDir, "late.txt"), "late\n");
      gitRun(repoDir, ["add", "-A"]);
      gitRun(repoDir, ["commit", "-m", "advance project HEAD after dispatch"]);
    });

    const captured = await captureStd(() =>
      runLoop({ rootId: "t2", adapter: fake.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 600 }),
    );

    expect(captured.code).toBe(1);
    const wtDir = worktreePath(WT_HOME, repoDir, "t2");
    expect(existsSync(wtDir)).toBe(true);
    // t2 是 root unit（unitId === rootId）→ 分支 cw-root/t2（R-1 双空间）
    expect(gitRun(repoDir, ["rev-parse", "cw-root/t2"])).toBe(head);
    // 前提复核：项目 HEAD 确已前进（快照语义的对照面成立）
    expect(gitRun(repoDir, ["rev-parse", "HEAD"])).not.toBe(head);
  }, 15_000);
});

// ---- T3/T4：重派复用与 reset、中断重跑复用分支 ----

describe("wt2 T3/T4 worktree 复用语义", () => {
  it("T3 重派复用与 reset（D5「在/在」格）：同 unit 重派 worktree 目录不变；预置 tracked 脏改 + untracked 文件 + 伪造 .cw-spawn 均被清（fx-4：无 -e 例外条款，porcelain 归零）", async () => {
    const { repoDir } = initRepo("t3");
    appendUnitCreated(repoDir, "t3", null);
    const wtDir = worktreePath(WT_HOME, repoDir, "t3");
    let porcelainAtSecondSpawn = "(not captured)";

    const script = makeSteppedAdapter([
      {
        // 失败 designer：在 worktree 留 tracked 脏改（brief.md）+ untracked 产物 +
        // 手工伪造 .cw-spawn/x（旧习惯 agent 自建——普通 untracked，被清是正确语义）
        exitCode: 1,
        onSpawn: (req) => {
          writeFileSync(join(req.workdir, "brief.md"), `${BRIEF_CONTENT}<!-- half-done -->`);
          writeFileSync(join(req.workdir, "build-artifact.tmp"), "half-done");
          mkdirSync(join(req.workdir, ".cw-spawn"), { recursive: true });
          writeFileSync(join(req.workdir, ".cw-spawn", "forged.txt"), "forged\n");
        },
      },
      {
        // 重派：此刻 ensure 的 reset --hard + clean -fd（裸形态，无 -e 例外）已清
        // 半成品——捕获现场
        exitCode: 1,
        onSpawn: (req) => {
          porcelainAtSecondSpawn =
            spawnSync("git", ["-C", req.workdir, "status", "--porcelain"], { encoding: "utf-8" }).stdout ?? "";
        },
      },
    ]);

    const captured = await captureStd(() =>
      runLoop({ rootId: "t3", adapter: script.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 600 }),
    );

    expect(captured.code).toBe(1); // 无账本进展 → maxIdle 兜底
    // worktree 目录不变：全部派发落在同一路径
    expect(script.calls().length).toBeGreaterThan(1);
    for (const req of script.calls()) {
      expect(req.workdir).toBe(wtDir);
    }
    // 预置的 tracked 脏改、untracked 产物、伪造 .cw-spawn 均被清（porcelain 全空，
    // 无任何例外条款——fx-4 后 worktree 内不存在 cw 想保护的东西）
    expect(porcelainAtSecondSpawn).toBe("");
    expect(existsSync(join(wtDir, "build-artifact.tmp"))).toBe(false);
    expect(existsSync(join(wtDir, ".cw-spawn"))).toBe(false);
    expect(readFileSync(join(wtDir, "brief.md"), "utf-8")).toBe(BRIEF_CONTENT);
    // cw 产物（上一轮派发的 brief）不在 worktree——在 run 级 topic 目录（append 档案）
    const topic = findTopicDir(cwHome, repoDir, "t3");
    expect(existsSync(join(wtDir, ".cw-spawn", "t3.designer.brief.md"))).toBe(false);
    expect(existsSync(join(topic, "t3.designer.brief.md"))).toBe(true);
  }, 15_000);

  it("T4 中断重跑复用分支（D5「亡/在」格 + stale 注册 prune 重试）：worktree 目录被删但分支残留与注册残留 → 重跑挂既有分支，已 commit 产出仍在", async () => {
    const { repoDir, head } = initRepo("t4");
    appendUnitCreated(repoDir, "t4", null);
    const wtDir = worktreePath(WT_HOME, repoDir, "t4");

    // 首轮：派发后在 worktree 内 commit 新文件，maxIdle 终止循环（模拟中断）
    let committed = false;
    const first = makeHoldAdapter((req) => {
      if (committed) {
        return;
      }
      committed = true;
      writeFileSync(join(req.workdir, "t4-kept.txt"), "kept\n");
      gitRun(req.workdir, ["add", "t4-kept.txt"]);
      gitRun(req.workdir, ["commit", "-m", "t4 work in worktree"]);
    });
    const firstRun = await captureStd(() =>
      runLoop({ rootId: "t4", adapter: first.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 500 }),
    );
    expect(firstRun.code).toBe(1);
    const branchHead = gitRun(repoDir, ["rev-parse", "cw-root/t4"]);
    expect(branchHead).not.toBe(head); // 前提：分支上确有中断前的 commit

    // 模拟异常退出后的现场：目录直接删除（注册残留、分支残留——不走 prune，
    // 让重跑路径覆盖「add 失败 → prune 清 stale 注册 → 重试」分支）
    rmSync(wtDir, { recursive: true, force: true });
    expect(existsSync(wtDir)).toBe(false);

    // 重跑：分支在（目录亡）→ 挂既有分支重建目录 → 复用产出
    const second = makeHoldAdapter();
    const secondRun = await captureStd(() =>
      runLoop({ rootId: "t4", adapter: second.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 500 }),
    );

    expect(secondRun.code).toBe(1);
    expect(existsSync(wtDir)).toBe(true);
    expect(existsSync(join(wtDir, "t4-kept.txt"))).toBe(true); // 分支上已 commit 的产出仍存在
    expect(gitRun(wtDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("cw-root/t4");
    expect(gitRun(repoDir, ["rev-parse", "cw-root/t4"])).toBe(branchHead); // 复用的是同一分支（未重建）
  }, 20_000);
});

// ---- T5：ensure 失败跳过（R3） ----

describe("wt2 T5 ensure 失败跳过（R3）", () => {
  it("单元级（D5「亡/亡」格失败）：repoDir 非 git 仓库 → add -b 失败 → {ok:false}，error 含恢复指引", () => {
    const nonGit = join(tmpRoot, "t5-non-git");
    mkdirSync(nonGit, { recursive: true });
    const res = ensureUnitWorktree(nonGit, join(tmpRoot, "t5-wt-x"), "t5x", "t5x", "deadbeef");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("恢复动作");
    }
  });

  it("单元级（D5「在/亡」格）：目录在但分支已被删 → {ok:false}，error 含 git worktree remove --force 指引", () => {
    const { repoDir, head } = initRepo("t5c");
    const wt = join(tmpRoot, "t5c-wt");
    // 构造「目录在 / 分支亡」现场：正常 add 后回收目录与注册、删分支，再空建目录占位
    expect(addUnitWorktree(repoDir, wt, "t5c", "t5c", head)).toEqual({ ok: true });
    expect(removeWorktree(repoDir, wt)).toEqual({ ok: true });
    gitRun(repoDir, ["branch", "-D", "cw-root/t5c"]);
    mkdirSync(wt, { recursive: true }); // 分支亡后的目录残留
    const res = ensureUnitWorktree(repoDir, wt, "t5c", "t5c", head);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("分支已亡");
      expect(res.error).toContain(`git worktree remove --force ${wt}`);
      expect(res.error).toContain("重跑");
    }
  });

  it("循环级：分支被另一 worktree 占用（挂分支失败且 prune 救不回）→ 该 unit 不 spawn、循环不炸、stderr 含恢复指引，其余 unit 继续", async () => {
    const { repoDir, head } = initRepo("t5");
    appendUnitCreated(repoDir, "t5-root", null);
    appendUnitCreated(repoDir, "t5-stuck", "t5-root");
    appendUnitCreated(repoDir, "t5-ok", "t5-root");
    // 构造必败态：分支 cw/t5-root/t5-stuck 已存在且被另一个真实 worktree 占用
    // （add -b 与挂既有分支双败；occupied 目录真实存在，prune 清不掉）
    expect(
      addUnitWorktree(repoDir, join(tmpRoot, "t5-occupied"), "t5-root", "t5-stuck", head),
    ).toEqual({ ok: true });

    const fake = makeHoldAdapter();
    const captured = await captureStd(() =>
      runLoop({ rootId: "t5-root", adapter: fake.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 800 }),
    );

    expect(captured.code).toBe(1); // 循环不炸：由 maxIdle 兜底退出
    const dispatched = fake.calls().map((req) => req.unitId);
    expect(dispatched).not.toContain("t5-stuck"); // ensure 失败的 unit 零 spawn
    expect(dispatched).toContain("t5-root"); // 其余 unit 继续派发
    expect(dispatched).toContain("t5-ok");
    expect(existsSync(worktreePath(WT_HOME, repoDir, "t5-stuck"))).toBe(false);
    expect(captured.err).toContain('unit "t5-stuck" worktree 就绪失败');
    expect(captured.err).toContain("恢复动作"); // error 原文落 stderr（含恢复指引）
  }, 15_000);
});

// ---- T6：brief 落盘与内容 ----

describe("wt2 T6 brief 落盘与内容", () => {
  it("briefPath 在 run 级 topic 目录下（<cwHome>/topic/<encoded>/<runTs>-t6/）；内容含 worktree 路径行与 CW_PROJECT_DIR 说明行；worktree 内无 .cw-spawn、项目 cwd 也无", async () => {
    const { repoDir } = initRepo("t6");
    appendUnitCreated(repoDir, "t6", null);
    const fake = makeHoldAdapter();

    const captured = await captureStd(() =>
      runLoop({ rootId: "t6", adapter: fake.adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 600 }),
    );

    expect(captured.code).toBe(1);
    const wtDir = worktreePath(WT_HOME, repoDir, "t6");
    const topic = findTopicDir(cwHome, repoDir, "t6");
    const req = fake.calls()[0];
    expect(req?.briefPath).toBe(join(topic, "t6.designer.brief.md"));
    expect(existsSync(req?.briefPath ?? "")).toBe(true);
    expect(req?.artifactDir).toBe(topic);
    const brief = readFileSync(join(topic, "t6.designer.brief.md"), "utf-8");
    expect(brief).toContain(`workdir: ${wtDir}（unit 专属 git worktree，分支 cw-root/t6）`);
    expect(brief).toContain("CW_PROJECT_DIR 已注入 env");
    expect(brief).toContain(`自动锚定项目账本 ${repoDir}`);
    // fx-4：worktree 内不再是产物落盘根（.cw-spawn 不存在）
    expect(existsSync(join(wtDir, ".cw-spawn"))).toBe(false);
    // 项目 cwd 也不是产物落盘根（wt-2 起的既有断言保留）
    expect(existsSync(join(repoDir, ".cw-spawn"))).toBe(false);
  }, 15_000);
});

// ---- T7：pi 适配器 env 注入 ----

describe("wt2 T7 pi env 注入", () => {
  it("spawn env 注入 CW_PROJECT_DIR=req.projectCwd（覆盖外部残留值）——PATH 前置真实 sh 探测脚本观测（u6c 同款）", async () => {
    const savedProjectDir = process.env.CW_PROJECT_DIR;
    const workdir = join(tmpRoot, "t7-work");
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, "brief.md"), "t7 env probe brief");
    const binDir = join(tmpRoot, "t7-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "pi"),
      '#!/bin/sh\necho "PI_CW_PROJECT_DIR=$CW_PROJECT_DIR"\n',
      { mode: 0o755 },
    );
    const projectCwd = join(tmpRoot, "t7-project");
    // 外部残留一个不同的值：证明适配器注入是覆盖而非透传 process.env
    process.env.CW_PROJECT_DIR = "/should/be/overridden";
    try {
      const handle = await createPiAdapter().spawn({
        role: "builder",
        unitId: "t7",
        workdir,
        projectCwd,
        artifactDir: join(tmpRoot, "t7-topic"),
        briefPath: join(workdir, "brief.md"),
        env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
        timeoutMs: 30_000,
      });
      const result = await handle.wait();
      expect(result.exitCode).toBe(0);
      const out = readFileSync(result.stdoutPath, "utf-8");
      expect(out).toContain(`PI_CW_PROJECT_DIR=${projectCwd}`);
      expect(out).not.toContain("/should/be/overridden");
    } finally {
      if (savedProjectDir === undefined) {
        delete process.env.CW_PROJECT_DIR;
      } else {
        process.env.CW_PROJECT_DIR = savedProjectDir;
      }
    }
  }, 30_000);
});

// ---- T8/T9：human 转人工链路（场景 4） ----

/** u6b 同款：另一真实 node 子进程向账本文件 append 一行 JSONL（模拟人执行的 cw 命令入账） */
const CHILD_APPEND_EVENT_SCRIPT = [
  "const fs = require('fs');",
  "const [file, type, payloadJson] = process.argv.slice(1);",
  "const lines = fs.readFileSync(file, 'utf8').split('\\n').filter((l) => l !== '');",
  "const envelope = { seq: lines.length + 1, ts: new Date().toISOString(), type, payload: JSON.parse(payloadJson) };",
  "fs.appendFileSync(file, JSON.stringify(envelope) + '\\n');",
].join(" ");

function appendEventFromRealChild(ledgerFile: string, type: string, payload: unknown): void {
  const res = spawnSync(
    process.execPath,
    ["-e", CHILD_APPEND_EVENT_SCRIPT, ledgerFile, type, JSON.stringify(payload)],
    { encoding: "utf-8" },
  );
  if (res.status !== 0) {
    throw new Error(`子进程写事件失败（${type} → ${ledgerFile}）：${res.stderr}`);
  }
}

describe("wt2 T8 human 指令与账本锚定（场景 4 前半）", () => {
  it("指令清单：cd 行带双引号、每条 cw 命令带内联 CW_PROJECT_DIR 前缀（无 export 行）；wait() 轮询项目账本（非 workdir 编码账本），完成信号到达即 exit 0 非 TIMEOUT", async () => {
    const projectDir = join(tmpRoot, "t8-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "brief.md"), BRIEF_CONTENT);
    const workdir = join(tmpRoot, "t8-workdir"); // unit worktree 占位（human 无子进程，仅需可创建产物目录）
    const artifactDir = join(tmpRoot, "t8-topic"); // fx-4：产物根 = run 级 topic 目录占位
    const ledgerFile = ledgerPath(cwHome, projectDir);
    new EventLedger(ledgerFile).append("UnitCreated", {
      unitId: "t8",
      parentId: null,
      briefRef: join(projectDir, "brief.md"),
    });

    const handle = await humanAdapter.spawn({
      role: "builder",
      unitId: "t8",
      workdir,
      projectCwd: projectDir,
      artifactDir,
      briefPath: join(artifactDir, "t8.builder.brief.md"),
      env: { CW_HOME: cwHome },
      timeoutMs: 15_000,
    });

    // 指令清单（R-4）：cd 含双引号；每条 cw 命令内联前缀；不再有 export 行
    const instruction = readFileSync(join(artifactDir, "t8.builder.stdout"), "utf-8");
    expect(instruction).toContain(`cd "${workdir}"`);
    expect(instruction).toContain(`cat "${join(artifactDir, "t8.builder.brief.md")}"`);
    expect(instruction).toContain(`CW_PROJECT_DIR="${projectDir}" cw evidence submit --kind build --unit t8`);
    expect(instruction).toContain(`CW_PROJECT_DIR="${projectDir}" cw verify --unit t8`);
    expect(instruction).not.toContain("export CW_PROJECT_DIR");

    const waitPromise = handle.wait();
    // 模拟人按指引在 worktree 里跑 cw：完成信号（builder = VerifyRan）写进项目账本
    appendEventFromRealChild(ledgerFile, "VerifyRan", {
      unitId: "t8",
      runId: "run-t8-1",
      reportHash: "rh-t8",
      result: "pass",
      acceptanceIds: [],
    });
    const result = await waitPromise;
    expect(result.exitCode).toBe(0); // 正常返回，非 TIMEOUT
    // 账本锚定 projectCwd：workdir（worktree）编码下无账本
    expect(existsSync(ledgerPath(cwHome, workdir))).toBe(false);
  }, 20_000);
});

describe("wt2 T9 e2e human 全链路（场景 4 完整）", () => {
  it("人按指引在 worktree 里（CW_PROJECT_DIR 锚定）真实执行 cw evidence/review submit → 事件写项目账本而非 worktree 编码账本；循环推进到下一状态（builder 派发）", async () => {
    const { repoDir } = initRepo("t9");
    appendUnitCreated(repoDir, "t9", null);
    const wtDir = worktreePath(WT_HOME, repoDir, "t9");
    const runCliInWorktree = (args: readonly string[]) => {
      const env: NodeJS.ProcessEnv = { ...process.env, CW_HOME: cwHome, CW_PROJECT_DIR: repoDir };
      const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
        cwd: wtDir, // 人在 worktree 里执行（指引的 cd 目标）
        encoding: "utf-8",
        env,
      });
      return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    };

    const runPromise = captureStd(() =>
      runLoop({ rootId: "t9", adapter: humanAdapter, cwd: repoDir, pollMs: 50, maxIdleMs: 15_000 }),
    );

    // 1. 等 designer 指令落盘（fx-4：human spawn 即写 run 级 topic 目录下的产物）
    let t9Topic = "";
    await waitUntil(() => {
      try {
        t9Topic = findTopicDir(cwHome, repoDir, "t9");
        return true;
      } catch {
        return false; // runLoop 尚未建 topic 目录（异步启动窗口）
      }
    }, 10_000, "topic 目录");
    await waitUntil(() => existsSync(join(t9Topic, "t9.designer.stdout")), 10_000, "designer 指令");
    const instruction = readFileSync(join(t9Topic, "t9.designer.stdout"), "utf-8");
    expect(instruction).toContain(`cd "${wtDir}"`);
    expect(instruction).toContain("CW_PROJECT_DIR=\"" + repoDir + "\" cw evidence submit --kind spec --unit t9");
    expect(instruction).not.toContain("export CW_PROJECT_DIR");

    // 2. 人按指引在 worktree 里写 spec 并真实执行 cw evidence submit（子进程跑 dist/cli.js；
    //    --file 用相对路径 spec-t9.json——文件在 worktree（进程 cwd）、账本在项目 A（R-5 双锚分离））
    writeFileSync(
      join(wtDir, "spec-t9.json"),
      `${JSON.stringify({ acceptance: SPEC_ACCEPTANCE, contracts: [], split: [] }, null, 2)}\n`,
    );
    const submit = runCliInWorktree([
      "evidence",
      "submit",
      "--kind",
      "spec",
      "--unit",
      "t9",
      "--file",
      "spec-t9.json", // 相对路径：R-5 后相对进程 cwd（worktree）解析，而非 CW_PROJECT_DIR
    ]);
    expect(submit.code, `evidence submit 应成功（stderr: ${submit.stderr}）`).toBe(0);

    // 3. 补 spec-review（推到 spec-frozen，循环即可派 builder——「推进到下一状态」）
    // （mx3 迁移：spec-review 必须携带 --role reviewer）
    const review = runCliInWorktree([
      "review",
      "submit",
      "--unit",
      "t9",
      "--verdict-kind",
      "spec-review",
      "--verdict",
      "pass",
      "--role",
      "reviewer",
    ]);
    expect(review.code, `review submit 应成功（stderr: ${review.stderr}）`).toBe(0);

    // 4. 循环消费项目账本事件 → unit spec-frozen → 派发 builder（下一状态；brief 落 topic）
    await waitUntil(() => existsSync(join(t9Topic, "t9.builder.brief.md")), 10_000, "builder 派发");
    const captured = await runPromise;
    expect(captured.code).toBe(1); // 之后无人推进 → maxIdle 有界退出（非崩溃）
    expect(captured.err).toContain("无账本进展");

    // 5. 事件写入项目账本（encoded-cwd = 项目），而非 worktree 编码账本
    const projectEvents = new EventLedger(ledgerPath(cwHome, repoDir)).readAll();
    expect(projectEvents.some((ev) => ev.type === "SpecSubmitted" && ev.payload.unitId === "t9")).toBe(true);
    expect(
      projectEvents.some(
        (ev) =>
          ev.type === "VerdictSubmitted" &&
          ev.payload.unitId === "t9" &&
          (ev.payload as { verdictKind: string }).verdictKind === "spec-review",
      ),
    ).toBe(true);
    expect(existsSync(ledgerPath(cwHome, wtDir))).toBe(false);
  }, 60_000);
});

// ---- T10：非 git cwd（R1 fail-fast） ----

describe("wt2 T10 非 git cwd", () => {
  it("runLoop 启动即抛可操作错误（含 git init 恢复指引），适配器未被调用", async () => {
    const nonGit = join(tmpRoot, "t10-non-git");
    mkdirSync(nonGit, { recursive: true });
    appendUnitCreated(nonGit, "t10", null); // 账本可用（root 存在性检查先过）
    const fake = makeHoldAdapter();

    let caught: unknown;
    const captured = await captureStd(() =>
      runLoop({ rootId: "t10", adapter: fake.adapter, cwd: nonGit, pollMs: 30, maxIdleMs: 500 }).catch(
        (err: unknown) => {
          caught = err;
          return -1;
        },
      ),
    );
    expect(captured.code).toBe(-1);
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toContain("rev-parse HEAD");
    expect(message).toContain("恢复动作");
    expect(message).toContain("git init");
    expect(fake.calls().length).toBe(0); // 启动即失败，零派发
  }, 15_000);
});

// ---- T11：文件路径解析锚分离（R-5） ----

describe("wt2 T11 文件解析锚分离（R-5）", () => {
  it("CW_PROJECT_DIR=<项目A> + 进程 cwd 在 B + spec.json 在 B：evidence submit 读 B/spec.json（解析跟随进程 cwd），事件写 A 的账本（锚定不跟随）", () => {
    const { repoDir } = initRepo("t11"); // 项目 A：账本在此（CW_PROJECT_DIR 锚定）
    appendUnitCreated(repoDir, "t11", null);
    const dirB = join(tmpRoot, "t11-dir-b"); // 执行者所在目录（进程 cwd）
    mkdirSync(dirB, { recursive: true });
    const specAbs = join(dirB, "spec.json");
    writeFileSync(
      specAbs,
      `${JSON.stringify({ acceptance: SPEC_ACCEPTANCE, contracts: [], split: [] }, null, 2)}\n`,
    );
    // 对照面前提：A 下无同名文件（若解析错误地跟随 A，将读不到文件而失败）
    expect(existsSync(join(repoDir, "spec.json"))).toBe(false);

    const res = spawnSync(
      process.execPath,
      [CLI_PATH, "evidence", "submit", "--kind", "spec", "--unit", "t11", "--file", "spec.json"],
      {
        cwd: dirB,
        encoding: "utf-8",
        env: { ...process.env, CW_HOME: cwHome, CW_PROJECT_DIR: repoDir },
      },
    );
    expect(res.status, `evidence submit 应成功（stderr: ${res.stderr}）`).toBe(0);

    // 账本写 A（账本锚定跟随 CW_PROJECT_DIR，不跟随进程 cwd）
    const eventsA = new EventLedger(ledgerPath(cwHome, repoDir)).readAll();
    const specEv = eventsA.find(
      (ev) => ev.type === "SpecSubmitted" && (ev.payload as { unitId: string }).unitId === "t11",
    );
    expect(specEv).toBeDefined();
    // 读到的内容确为 B/spec.json（specHash = sha256(B/spec.json)，非空文件、非占位读）
    const expectedHash = createHash("sha256").update(readFileSync(specAbs)).digest("hex");
    expect((specEv?.payload as { specHash: string }).specHash).toBe(expectedHash);
    // B 的 cwd 编码下无账本目录（未分裂出新账本）
    expect(existsSync(ledgerPath(cwHome, dirB))).toBe(false);
  });
});

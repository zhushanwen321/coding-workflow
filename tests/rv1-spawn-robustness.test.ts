/**
 * rv-1 单测：spawn/loop 健壮性（docs/rewrite/acceptance/rv1-acceptance.md §5 条款 T1-T5；
 * T6「正常路径零回归」= 验收 §6 的限定范围既有测试全绿，由 vitest 命令本身承担，
 * 不在文件内自引用）。
 *
 * 条款 → 测试映射：
 *   - T1 kill 幂等扩展：短命真实子进程 wait() 结算后再次/第三次 kill() 不抛
 *     （ESRCH 与 EPERM 任一实际返回码都被豁免）；
 *   - T2 超时 kill 不炸（行为级）：存活期与 timeoutMs 竞态窗口重叠 × ≥20 次，
 *     process 级 uncaughtException/unhandledRejection 零触发 + 每次合法四态结果；
 *   - T3 SIGINT 回收（E2E）：真实 `node dist/cli.js run --spawn human` 子进程收到
 *     SIGINT → 2s 内 exit 130 + stderr 中断提示行 + 无残留子进程 + 账本完整可读；
 *   - T4 SIGTERM 同语义：exit 143；
 *   - T5 handler 清理：直调 runLoop（human 模式全链收敛 root closed 的既有形态，
 *     测试进程扮演人推进账本）后 SIGINT/SIGTERM listenerCount 恢复基线。
 *
 * 全部真实环境零 mock：真实 OS 子进程 + tmp git 仓库 + CW_HOME/CW_WORKTREE_HOME 隔离。
 * lifecycle 原语从 src import（与 u6a 同款直测源码）；runLoop/humanAdapter/EventLedger
 * 从 dist import（与 u7/u5b 同款，需先 npm run build）。
 *
 * 平台假设与被测模块一致：POSIX（ps / signal / pgid 语义）。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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

import type { AcceptanceItem } from "../dist/events/types.js";
import { ledgerForCwd } from "../dist/handlers/common.js";
import { loadLedger, unitStatus } from "../dist/readonly/load.js";
import { runLoop } from "../dist/runner/loop.js";
import { humanAdapter } from "../dist/runner/spawn/human.js";
import { EventLedger } from "../dist/store/events-log.js";
import { encodeCwd, ledgerPath } from "../dist/store/project.js";
import type { SpawnProcessRequest } from "../src/runner/spawn/lifecycle.js";
import { spawnProcess } from "../src/runner/spawn/lifecycle.js";
import type { SpawnResult } from "../src/runner/spawn/types.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const CLI_PATH = join(DIST_ROOT, "cli.js");
for (const required of [CLI_PATH, join(DIST_ROOT, "runner", "loop.js"), join(DIST_ROOT, "runner", "spawn", "human.js")]) {
  if (!existsSync(required)) {
    throw new Error(`tests/rv1-spawn-robustness 需要 ${required}（先 npm run build；npm test 的 pretest 已含）`);
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-rv1-robust-"));
// T5 直调 runLoop：测试进程即 runner，CW_HOME/CW_WORKTREE_HOME 全局隔离
// （E2E 场景各自显式传 env 覆盖，不经这两个模块级值）
process.env.CW_HOME = join(tmpRoot, "cw-home");
process.env.CW_WORKTREE_HOME = join(tmpRoot, "cw-worktrees");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---- T1/T2 共用：lifecycle 原语（src 直测） ----

/** 产物路径（与 u6a 同款形态：嵌套目录由模块自建） */
function artifactPaths(name: string): Pick<SpawnProcessRequest, "stdoutPath" | "stderrPath"> {
  return {
    stdoutPath: join(tmpRoot, name, "topic", `${name}.stdout`),
    stderrPath: join(tmpRoot, name, "topic", `${name}.stderr`),
  };
}

const VALID_EXIT_CODES = ["TIMEOUT", "CRASH", "SPAWN_ERROR"] as const;
function isValidFourStateExit(code: unknown): boolean {
  return typeof code === "number" || VALID_EXIT_CODES.includes(code as (typeof VALID_EXIT_CODES)[number]);
}

// ---- T3/T4 共用：E2E 子进程基建（真实 CLI + 隔离 CW_HOME + 文件重定向） ----

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

interface SignalScenario {
  repoDir: string;
  scenarioBase: string;
  outPath: string;
  errPath: string;
  cwHome: string;
}

/** 独立场景：tmp git repo（含一个 commit）+ 已建 root unit + 独立 CW_HOME */
function makeSignalScenario(name: string, rootId: string): SignalScenario {
  const scenarioBase = join(tmpRoot, name);
  mkdirSync(join(scenarioBase, "repo"), { recursive: true });
  // 物理路径（macOS /var → /private/var symlink 解析），与子进程 process.cwd() 一致
  const repoDir = realpathSync(join(scenarioBase, "repo"));
  const cwHome = join(scenarioBase, "cw-home");
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-rv1@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-rv1"]);
  writeFileSync(join(repoDir, "brief.md"), "# rv1 信号场景任务书\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: base"]);
  // 场景内所有子进程（runner / create / status）共用同一 CW_HOME + CW_WORKTREE_HOME
  const env = {
    ...process.env,
    CW_HOME: cwHome,
    CW_WORKTREE_HOME: join(scenarioBase, "cw-worktrees"),
  };
  const created = spawnSync(process.execPath, [CLI_PATH, "create", "--id", rootId, "--brief", "brief.md"], {
    cwd: repoDir,
    encoding: "utf-8",
    env,
  });
  if ((created.status ?? -1) !== 0) {
    throw new Error(`fixture 前置失败（cw create）：${created.stderr}`);
  }
  return { repoDir, scenarioBase, outPath: join(scenarioBase, "runner.stdout"), errPath: join(scenarioBase, "runner.stderr"), cwHome };
}

/** 真实启动 `cw run --spawn human` runner 子进程（stdout/stderr 落盘，max-idle 放长防空转退出竞态） */
function startSignalRunner(scenario: SignalScenario, rootId: string): ChildProcess {
  const outFd = openSync(scenario.outPath, "a");
  const errFd = openSync(scenario.errPath, "a");
  const child = spawn(
    process.execPath,
    [CLI_PATH, "run", "--root", rootId, "--spawn", "human", "--max-idle-ms", "60000"],
    {
      cwd: scenario.repoDir,
      env: {
        ...process.env,
        CW_HOME: scenario.cwHome,
        CW_WORKTREE_HOME: join(scenario.scenarioBase, "cw-worktrees"),
      },
      stdio: ["ignore", outFd, errFd],
    },
  );
  closeSync(outFd);
  closeSync(errFd);
  return child;
}

async function waitOutContains(path: string, pattern: RegExp, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (pattern.test(content)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${label} 未在 ${timeoutMs}ms 内出现（当前内容: ${JSON.stringify(content.slice(-400))}）`);
    }
    await sleep(50);
  }
}

/** 限时等待子进程退出（超时 = 拒绝并给 stderr 现场） */
function waitExitWithin(child: ChildProcess, timeoutMs: number, errPath: string): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: null });
      return;
    }
    const timer = setTimeout(() => {
      reject(
        new Error(
          `runner 未在 ${timeoutMs}ms 内退出（stderr 末尾: ${existsSync(errPath) ? readFileSync(errPath, "utf8").slice(-400) : "(无)"}）`,
        ),
      );
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** ps 全表命令行快照（残留断言的权威源：BSD ps，非 tty 输出不截断命令列） */
function psCommandLines(): string[] {
  const res = spawnSync("ps", ["ax", "-o", "command="], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`ps ax 快照失败: ${res.stderr}`);
  }
  return res.stdout.split("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 信号中断场景的共用断言体（T3 SIGINT / T4 SIGTERM）：
 * 派发行出现（= runLoop 已注册 handler 且 in-flight 非空）→ 发信号 → 2s 内退出且
 * 约定退出码 → stderr 含中断提示行 → ps 扫描无 cw 起的残留子进程 → 账本完整可读。
 */
async function assertSignalRecycling(signal: "SIGINT" | "SIGTERM", name: string): Promise<void> {
  const rootId = `rv1-${name}`;
  const scenario = makeSignalScenario(name, rootId);
  const child = startSignalRunner(scenario, rootId);
  // 等派发行 = handler 已注册（runLoop 入口）且 designer(human) 已入 inFlight
  await waitOutContains(scenario.outPath, new RegExp(`派发 designer → unit "${rootId}"`), 10_000, "designer 派发行");

  child.kill(signal);
  const exited = await waitExitWithin(child, 2_000, scenario.errPath);

  const expectedCode = signal === "SIGINT" ? 130 : 143;
  // 约定退出码（128+signum）且非默认信号死亡（handler 主动 process.exit 的证据）
  expect(exited.code, `${signal} 后应 exit ${expectedCode}（stderr: ${readFileSync(scenario.errPath, "utf8")}）`).toBe(expectedCode);
  expect(exited.signal).toBeNull();

  const errText = readFileSync(scenario.errPath, "utf8");
  expect(errText).toContain(`收到 ${signal}`);
  expect(errText).toContain(`重跑 cw run --root ${rootId}`);

  // 残留扫描：runner 已死，任何命令行仍含本场景路径的进程 = cw 起的孤儿
  // （human 模式无 agent 子进程，本断言的价值是把「无残留」钉成回归门）
  const pattern = new RegExp(escapeRegExp(scenario.scenarioBase));
  const residue = psCommandLines().filter((line) => pattern.test(line));
  expect(residue, `${signal} 后存在残留子进程`).toEqual([]);

  // 账本完整可读（重跑即续前提）：readAll 可解析 + 真实 cw status exit 0
  const events = new EventLedger(ledgerPath(scenario.cwHome, scenario.repoDir)).readAll();
  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(events.some((record) => record.type === "UnitCreated" && record.payload.unitId === rootId)).toBe(true);
  const status = spawnSync(process.execPath, [CLI_PATH, "status"], {
    cwd: scenario.repoDir,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: scenario.cwHome, CW_WORKTREE_HOME: join(scenario.scenarioBase, "cw-worktrees") },
  });
  expect(status.status, `中断后 cw status 应可读（stderr: ${status.stderr}）`).toBe(0);
}

// ---- T5 共用：直调 runLoop 的 human 全链驱动（测试进程扮演人写账本） ----

const FIXTURE_ACCEPTANCE: AcceptanceItem[] = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
];

/** 轮询等待 run 级 topic 目录出现并唯一（u7 findTopicDir 的轮询变体：runLoop 启动即建） */
async function waitForTopicDir(cwHome: string, cwd: string, rootId: string): Promise<string> {
  const topicRoot = join(cwHome, "topic", encodeCwd(cwd));
  const deadline = Date.now() + 10_000;
  for (;;) {
    const entries = existsSync(topicRoot) ? readdirSync(topicRoot).sort() : [];
    const hits = entries.filter((entry) => entry.endsWith(`-${rootId}`) || entry.includes(`-${rootId}-`));
    if (hits.length === 1) {
      return join(topicRoot, hits[0]!);
    }
    if (Date.now() > deadline) {
      throw new Error(`topic run 目录未在 10s 内唯一出现（rootId=${rootId}，当前: ${hits.join(", ") || "(无)"}）`);
    }
    await sleep(25);
  }
}

/** 轮询等待文件出现（humanAdapter spawn 时同步写指令产物 → 文件出现 = 该 role 已派发） */
async function waitFileExists(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`文件未在 ${timeoutMs}ms 内出现: ${path}`);
    }
    await sleep(25);
  }
}

/** 捕获 runLoop 的 stdout/stderr（u7 同款；透传 write 回调避免退出屏障落入兜底超时） */
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

// ---- T1：kill 幂等扩展 ----

describe("rv-1 T1：kill 幂等扩展（豁免 ESRCH + EPERM）", () => {
  it("短命真实子进程 wait() 结算后再次 kill() 不抛（覆盖 ESRCH 或 EPERM 实际返回码），第三次 kill 仍不抛", async () => {
    const paths = artifactPaths("t1-kill-after-death");
    const handle = spawnProcess({
      command: "node",
      args: ["-e", "process.exit(0)"],
      cwd: tmpRoot,
      timeoutMs: 30_000,
      ...paths,
    });
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    // 结算后进程组已消亡：killTree 落在死组上（macOS 返回 EPERM 或 ESRCH，均须幂等静默）
    expect(() => handle.kill()).not.toThrow();
    expect(() => handle.kill()).not.toThrow();
    expect(() => handle.kill()).not.toThrow();
  }, 30_000);
});

// ---- T2：超时 kill 不炸（行为级竞态） ----

describe("rv-1 T2：超时 kill 与自然退出竞态不炸 runner", () => {
  it("存活期横跨 timeoutMs 的真实子进程 × ≥20 次：零 uncaughtException/unhandledRejection，每次合法四态结果", async () => {
    const unhandled: string[] = [];
    const onUncaught = (err: unknown): void => {
      unhandled.push(`uncaughtException: ${err instanceof Error ? err.message : String(err)}`);
    };
    const onRejection = (reason: unknown): void => {
      unhandled.push(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onRejection);
    try {
      // 确定性阶梯：存活期 22ms→60ms 横跨 timeoutMs=50ms 两侧与边界（timer 与 exit
      // 事件同拍竞态时 killTree 落在已退出/僵尸进程组上——正是修复前的 crash 窗口；
      // 本机探针：该窗口 macOS 约 1/10 返回 ESRCH、1/50 返回 EPERM，多数子 50ms 的
      // 阶梯值最大化死组落点比例），外加验收文档示例形态（活 300ms、kill 必落存活进程）
      const lifetimesMs = [...Array.from({ length: 20 }, (_, i) => 22 + i * 2), 300, 300];
      const results: Array<SpawnResult["exitCode"]> = [];
      for (const [index, lifeMs] of lifetimesMs.entries()) {
        const handle = spawnProcess({
          command: process.execPath,
          args: ["-e", `setTimeout(() => process.exit(0), ${lifeMs});`],
          cwd: tmpRoot,
          timeoutMs: 50,
          ...artifactPaths(`t2-race-${index}`),
        });
        results.push((await handle.wait()).exitCode);
      }
      expect(results.length).toBeGreaterThanOrEqual(20);
      for (const [index, code] of results.entries()) {
        expect(isValidFourStateExit(code), `第 ${index} 次结果应为合法四态，实得: ${String(code)}`).toBe(true);
      }
    } finally {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onRejection);
    }
    expect(unhandled).toEqual([]);
  }, 30_000);
});

// ---- T3/T4：SIGINT/SIGTERM 回收（E2E） ----

describe("rv-1 T3/T4：信号中断回收（真实 cw run 子进程）", () => {
  it("T3 SIGINT：2s 内 exit 130，stderr 含中断提示行，无残留子进程，账本完整可读", async () => {
    await assertSignalRecycling("SIGINT", "sigint");
  }, 30_000);

  it("T4 SIGTERM：同语义，exit 143", async () => {
    await assertSignalRecycling("SIGTERM", "sigterm");
  }, 30_000);
});

// ---- T5：handler 生命周期（注册 → 全链收敛 → 移除） ----

describe("rv-1 T5：runLoop 信号 handler 注册与清理", () => {
  it("直调 runLoop（human 模式全链收敛 root closed）后 SIGINT/SIGTERM listenerCount 恢复基线；运行中恰为基线+1", async () => {
    const base = join(tmpRoot, "t5-handler-cleanup", "repo");
    mkdirSync(base, { recursive: true });
    const repoDir = realpathSync(base);
    gitRun(repoDir, ["init"]);
    gitRun(repoDir, ["config", "user.email", "cw-rv1@example.com"]);
    gitRun(repoDir, ["config", "user.name", "cw-rv1"]);
    writeFileSync(join(repoDir, "brief.md"), "# t5 全链任务书\n");
    gitRun(repoDir, ["add", "-A"]);
    gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
    const head = gitRun(repoDir, ["rev-parse", "HEAD"]);
    ledgerForCwd(repoDir).append("UnitCreated", { unitId: "root", parentId: null, briefRef: join(repoDir, "brief.md") });

    const baselineSigint = process.listenerCount("SIGINT");
    const baselineSigterm = process.listenerCount("SIGTERM");

    const loopPromise = captureStd(() =>
      runLoop({ rootId: "root", adapter: humanAdapter, cwd: repoDir, pollMs: 50, maxIdleMs: 60_000 }),
    );

    // 驱动（测试进程扮演 human，按指令产物出现的顺序推进账本——事件 ts 晚于对应
    // spawn 起始，humanAdapter 的 hasProgressSince 才认账）
    const topic = await waitForTopicDir(process.env.CW_HOME ?? "", repoDir, "root");
    await waitFileExists(join(topic, "root.designer.stdout"), 10_000);

    // 运行中：handler 恰好各注册一个（多注册 = 泄漏前兆，少注册 = 没注册）
    expect(process.listenerCount("SIGINT")).toBe(baselineSigint + 1);
    expect(process.listenerCount("SIGTERM")).toBe(baselineSigterm + 1);

    const spec = { acceptance: FIXTURE_ACCEPTANCE, contracts: [], split: [] };
    ledgerForCwd(repoDir).append("SpecSubmitted", {
      unitId: "root",
      specHash: sha(JSON.stringify(spec)),
      ...spec,
    });
    // mx-1：spec 入账后循环派独立 reviewer（human spawn 打印 spec-review 指令并
    // 等待 VerdictSubmitted）——等指令落盘再以人扮演 reviewer 提交结论
    await waitFileExists(join(topic, "root.reviewer.stdout"), 10_000);
    ledgerForCwd(repoDir).append("VerdictSubmitted", { unitId: "root", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });

    await waitFileExists(join(topic, "root.developer.stdout"), 10_000);
    const runId = "run-t5-root";
    ledgerForCwd(repoDir).append("EvidenceSubmitted", {
      unitId: "root",
      runId,
      commit: head,
      paths: ["app.js"],
      sha256: [sha("app.js")],
      exitCode: 0,
    });
    ledgerForCwd(repoDir).append("VerifyRan", {
      unitId: "root",
      runId,
      reportHash: sha(`evidence-report:${runId}`),
      result: "pass",
      acceptanceIds: FIXTURE_ACCEPTANCE.map((ac) => ac.id),
    });

    // mx-1：exec-review 的 reviewer 是同 unit 的第二次 reviewer 派发（spec-review
    // 的指令块已 append 过同一路径）——等第二次指令块出现再提交结论，避免
    // 「verdict 早于 spawn 起始、hasProgressSince 不认账」的竞态
    const REVIEWER_HEADER = '[human] reviewer 指令：unit "root"';
    const execReviewerDeadline = Date.now() + 10_000;
    while (
      readFileSync(join(topic, "root.reviewer.stdout"), "utf-8").split(REVIEWER_HEADER).length - 1 < 2
    ) {
      if (Date.now() > execReviewerDeadline) {
        throw new Error("exec-review reviewer 指令未在 10s 内出现（第二次 reviewer 派发）");
      }
      await sleep(50);
    }
    ledgerForCwd(repoDir).append("VerdictSubmitted", { unitId: "root", verdictKind: "exec-review", verdict: "pass" });

    const captured = await loopPromise;

    expect(captured.code).toBe(0);
    const unit = loadLedger(repoDir).projection.units.get("root");
    expect(unit && unitStatus(unit)).toBe("closed");
    // 全部正常出口移除 handler：库化复用（直调）后无泄漏
    expect(process.listenerCount("SIGINT")).toBe(baselineSigint);
    expect(process.listenerCount("SIGTERM")).toBe(baselineSigterm);
  }, 60_000);
});

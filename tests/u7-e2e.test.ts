/**
 * u7 E2E real（docs/rewrite/acceptance/u7-acceptance.md「E2E real」两条）：
 *   1. human 后端回归：`node dist/cli.js run --root <id> --spawn human --poll-ms 300`
 *      走新 loop + u6b humanAdapter。测试进程扮演人——不解析 runner stdout 指令
 *      （humanAdapter 的打印格式属 u6b 领地，不与之耦合），而是轮询账本投影经
 *      dist/human-loop 的 buildStepInstruction（已验收的状态机导航）决定下一步
 *      真实 CLI 操作，直至 root closed、runner exit 0。u6b（src/runner/spawn/
 *      human.ts）合入前 dist 模块缺席，本条以 it.todo 挂起（验收文档许可的
 *      推迟项），合入并 build 后自动激活；同条件的 M0 回归见 tests/u5b-e2e.test.ts。
 *   2. A2 最小版（双叶子并行）：测试专用适配器直调 runLoop（import dist），fixture
 *      预置 root + 两叶全部 spec-frozen → 两 builder 并行，用账本事件信封 ts 断言
 *      两 builder 的工作区间重叠 ≥ 1 对（[EvidenceSubmitted.ts, VerifyRan.ts] 区间）。
 *
 * 全部真实子进程 + tmp git 仓库 + 隔离 CW_HOME，零 mock。注意：直接
 * `npx vitest run tests/u7-e2e.test.ts` 不触发 pretest，需先 `npm run build`。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem, LedgerEvent, SplitEntry } from "../dist/events/types.js";
import { ledgerForCwd } from "../dist/handlers/common.js";
import { loadLedger, unitStatus } from "../dist/readonly/load.js";
import { buildStepInstruction, type StepKind } from "../dist/runner/human-loop.js";
import { runLoop } from "../dist/runner/loop.js";
import { spawnProcess } from "../dist/runner/spawn/lifecycle.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
} from "../dist/runner/spawn/types.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const CLI_PATH = join(DIST_ROOT, "cli.js");
if (!existsSync(CLI_PATH)) {
  throw new Error(`tests/u7-e2e 需要 ${CLI_PATH}（先 npm run build；npm test 的 pretest 已含）`);
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u7-e2e-"));
const cwHome = join(tmpRoot, "cw-home");
process.env.CW_HOME = cwHome;
// wt-2 迁移：派发 workdir 迁 unit worktree，隔离 worktree 根（与 CW_HOME 同款）
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

/** 断言中途失败时防子进程泄漏 */
const liveRunners = new Set<ChildProcess>();

afterAll(() => {
  for (const child of liveRunners) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8", timeout: 30_000 });
  if (res.error !== undefined) {
    // 超时被杀（ETIMEDOUT）或启动失败：status 为 null，必须先于 status 检查
    const timedOut = (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    throw new Error(
      `git ${args.join(" ")} ${timedOut ? "超时被杀(30s 上限)" : "执行失败"}: ${res.error.message}`,
    );
  }
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

function makeScenario(name: string): string {
  const repoDir = join(tmpRoot, name);
  mkdirSync(repoDir, { recursive: true });
  const dir = realpathSync(repoDir);
  gitRun(dir, ["init"]);
  gitRun(dir, ["config", "user.email", "cw-u7e2e@example.com"]);
  gitRun(dir, ["config", "user.name", "cw-u7-e2e"]);
  // wt-2 迁移（R1 行为前提）：runLoop 启动即取项目 HEAD 快照，至少需一个 commit
  writeFileSync(join(dir, "brief.md"), "# u7-e2e fixture 任务书\n");
  gitRun(dir, ["add", "-A"]);
  gitRun(dir, ["commit", "-m", "fixture: brief"]);
  return dir;
}

function runCli(
  repoDir: string,
  args: readonly string[],
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
    timeout: 90_000,
  });
  if (res.error !== undefined) {
    // 超时被杀：status 为 null、error 置位——code 取 -1，stdout/stderr 附可诊断行
    const timeoutNote = `[runCli] 超时被杀(${args.join(" ")}): ${res.error.message}\n`;
    return {
      code: -1,
      stdout: (res.stdout ?? "") + timeoutNote,
      stderr: (res.stderr ?? "") + timeoutNote,
    };
  }
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// ================================================================
// E2E 条件 1：human 后端回归（u6b 合入后自动激活）
// ================================================================

const HUMAN_ADAPTER_DIST = join(DIST_ROOT, "runner", "spawn", "human.js");
const maybeIt = existsSync(HUMAN_ADAPTER_DIST) ? it : it.todo;

/** u5b-e2e 同款验收 fixture（A2 带 vitest JSON 形状 command，verify 干净重跑真实可过） */
const ACCEPTANCE_FIXTURE: AcceptanceItem[] = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  {
    id: "A2",
    core: false,
    title: "单元级冒烟",
    type: "unit",
    command:
      "node -e \"console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'A2 unit smoke',status:'passed'}]}]}))\" -- --reporter=json",
  },
];

function specJson(split: SplitEntry[]): string {
  return `${JSON.stringify({ acceptance: ACCEPTANCE_FIXTURE, contracts: [], split }, null, 2)}\n`;
}

/**
 * 启动 runner 子进程并捕获其 stdout/stderr。
 * 用管道而非「open fd → spawn → 立即 close」的数字 fd 传递：后者存在 fd 复用
 * 竞态（实测偶发子进程继承到上一个 tmp 目录已删文件的 fd——本进程读到截断
 * 输出而 runner 写进了旧 inode），管道 + 持续收集的数据完整性由内核语义保证。
 * 收集副本同步落盘 runner.stdout / runner.stderr（诊断现场用）。
 */
interface RunnerCapture {
  child: ChildProcess;
  stdoutText(): string;
  stderrText(): string;
}

function startRunner(repoDir: string, rootId: string): RunnerCapture {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const outPath = join(repoDir, "runner.stdout");
  const errPath = join(repoDir, "runner.stderr");
  const child = spawn(
    process.execPath,
    [CLI_PATH, "run", "--root", rootId, "--spawn", "human", "--poll-ms", "300"],
    { cwd: repoDir, env: { ...process.env, CW_HOME: cwHome }, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    outChunks.push(text);
    appendFileSync(outPath, text);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    errChunks.push(text);
    appendFileSync(errPath, text);
  });
  liveRunners.add(child);
  child.on("exit", () => {
    liveRunners.delete(child);
  });
  return {
    child,
    stdoutText: () => outChunks.join(""),
    stderrText: () => errChunks.join(""),
  };
}

/**
 * 等 runner 退出（超时报卡点）。子进程退出后管道内的剩余数据仍可读尽（内核
 * 缓冲保留到读端 EOF），exit 与两个流 'close' 全部到达后才结算——不丢尾部。
 */
async function waitExit(
  runner: RunnerCapture,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const exited = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `runner 未在 ${timeoutMs}ms 内退出（exitCode=${String(runner.child.exitCode)}）。` +
            `stdout 末尾：${readTailOf(runner.stdoutText())}；stderr 末尾：${readTailOf(runner.stderrText())}`,
        ),
      );
    }, timeoutMs);
    if (runner.child.exitCode !== null) {
      clearTimeout(timer);
      resolve(runner.child.exitCode);
      return;
    }
    runner.child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
  // 两个流的 close 是独立资源释放，用 allSettled（项目约定：独立数据源不互相拖垮）
  const streamsClosed = Promise.allSettled([
    awaitStreamClosed(runner.child.stdout),
    awaitStreamClosed(runner.child.stderr),
  ]);
  const code = await exited;
  await streamsClosed;
  return { code, stdout: runner.stdoutText(), stderr: runner.stderrText() };
}

/**
 * 流的 close 结算：流已 destroyed（close 事件已发过、此刻无 listener 被丢弃）时
 * 后挂的 once("close") 永不触发——直接结算，防 waitExit 永久挂起（实测竞态：
 * humanDrive 收尾慢于 runner 退出 + 流读尽的场景）。
 */
function awaitStreamClosed(stream: Readable | null): Promise<void> {
  if (stream === null || stream.destroyed) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => stream.once("close", resolve));
}

/** 诊断辅助：截断长文本尾部（间歇失败时定位 runner 卡点） */
function readTailOf(text: string): string {
  return text.slice(-600);
}

/**
 * 「人」的一步：按 buildStepInstruction 的导航真实调 CLI 写账本。
 * 返回本步最后一条 CLI 结果（无操作返回 undefined）；失败由调用方抛出。
 */
function performHumanStep(
  repoDir: string,
  rootId: string,
  kind: StepKind,
  unitId: string | null,
): { code: number; stdout: string; stderr: string } | undefined {
  if (kind === "create") {
    const { projection } = loadLedger(repoDir);
    const root = projection.units.get(rootId);
    if (root === undefined || root.specs.length === 0) {
      throw new Error("create 步骤但 root 无 spec（状态机矛盾）");
    }
    const pending = root.specs[root.specs.length - 1].split.filter(
      (entry) => !projection.units.has(entry.unitId),
    );
    let last: { code: number; stdout: string; stderr: string } | undefined;
    for (const entry of pending) {
      writeFileSync(join(repoDir, entry.briefRef ?? "brief-impl.md"), "# impl 任务书\n");
      last = runCli(repoDir, [
        "create",
        "--id",
        entry.unitId,
        "--brief",
        entry.briefRef ?? "brief-impl.md",
        "--parent",
        rootId,
      ]);
    }
    return last;
  }
  if (unitId === null) {
    throw new Error(`步骤 ${kind} 无目标 unit（状态机矛盾）`);
  }
  if (kind === "spec") {
    const split: SplitEntry[] =
      unitId === rootId
        ? [{ unitId: "impl", briefRef: "brief-impl.md", dependsOn: [] }]
        : [];
    if (unitId === rootId && split.length > 0) {
      // fx-3 R5.1 断言适配：先建子后提 spec（工作流语义变更）——原时序 root spec
      // 先提交、create 步骤后建子，语义收紧后提交会被 split 子存在性校验拒绝
      for (const entry of split) {
        writeFileSync(join(repoDir, entry.briefRef ?? "brief-impl.md"), "# impl 任务书\n");
        const res = runCli(repoDir, [
          "create",
          "--id",
          entry.unitId,
          "--brief",
          entry.briefRef ?? "brief-impl.md",
          "--parent",
          rootId,
        ]);
        if (res.code !== 0) {
          return res;
        }
      }
    }
    writeFileSync(join(repoDir, `spec-${unitId}.json`), specJson(split));
    const submit = runCli(repoDir, [
      "evidence",
      "submit",
      "--kind",
      "spec",
      "--unit",
      unitId,
      "--file",
      `spec-${unitId}.json`,
    ]);
    if (submit.code !== 0) {
      return submit;
    }
    return runCli(repoDir, [
      "review",
      "submit",
      "--unit",
      unitId,
      "--verdict-kind",
      "spec-review",
      "--verdict",
      "pass",
    ]);
  }
  if (kind === "spec-review") {
    return runCli(repoDir, [
      "review",
      "submit",
      "--unit",
      unitId,
      "--verdict-kind",
      "spec-review",
      "--verdict",
      "pass",
    ]);
  }
  if (kind === "build") {
    writeFileSync(join(repoDir, "app.js"), 'console.log("A1 PASS");\n');
    gitRun(repoDir, ["add", "-A"]);
    const dirty = spawnSync("git", ["-C", repoDir, "status", "--porcelain"], { encoding: "utf-8" });
    if ((dirty.stdout ?? "").trim().length > 0) {
      gitRun(repoDir, ["commit", "-m", `build: ${unitId}`]);
    }
    const head = gitRun(repoDir, ["rev-parse", "HEAD"]);
    const submit = runCli(repoDir, [
      "evidence",
      "submit",
      "--kind",
      "build",
      "--unit",
      unitId,
      "--commit",
      head,
      "--run-id",
      `run-${unitId}-1`,
      "--file",
      "app.js",
    ]);
    if (submit.code !== 0) {
      return submit;
    }
    // 60s 上限：满负载下 verify 内嵌的验收 vitest 可远超 humanDrive 的 90s 预算，
    // 超限走 fail 可重试/可诊断，而不是无限等
    return runCli(repoDir, ["verify", "--unit", unitId, "--timeout-ms", "60000"]);
  }
  if (kind === "exec-review") {
    // rv-2 exec-review refs 必填适配（引用 build 分支已入账的 runId run-<unitId>-1）
    return runCli(repoDir, [
      "review",
      "submit",
      "--unit",
      unitId,
      "--verdict-kind",
      "exec-review",
      "--verdict",
      "pass",
      "--evidence-refs",
      `run-${unitId}-1`,
    ]);
  }
  return undefined; // "none"：调用方已排除
}

/** 「人」驱动循环：轮询账本 → 按导航做一步真实 CLI 操作 → 直至 root closed */
async function humanDrive(repoDir: string, rootId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { projection } = loadLedger(repoDir);
    const root = projection.units.get(rootId);
    if (root === undefined) {
      throw new Error(`root ${rootId} 不在账本`);
    }
    if (unitStatus(root) === "closed") {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`human 推进超时（${timeoutMs}ms）`);
    }
    const step = buildStepInstruction(projection, rootId);
    if (step.kind !== "none") {
      const res = performHumanStep(repoDir, rootId, step.kind, step.unitId);
      if (res !== undefined && res.code !== 0) {
        throw new Error(`human 步骤 ${step.kind}(${step.unitId}) 失败: ${res.stdout}${res.stderr}`);
      }
    }
    await sleep(150);
  }
}

describe("E2E real：human 后端走新 loop + humanAdapter（u6b 合入后自动激活）", () => {
  maybeIt("全链回归：run --spawn human → 人按账本推进 → runner exit 0 + root closed", async () => {
    const repoDir = makeScenario("human-regression");
    writeFileSync(join(repoDir, "brief.md"), "# root 任务书\n");
    expect(runCli(repoDir, ["create", "--id", "demo", "--brief", "brief.md"]).code).toBe(0);

    const runner = startRunner(repoDir, "demo");
    await humanDrive(repoDir, "demo", 90_000);

    const exited = await waitExit(runner, 60_000);
    expect(exited.code).toBe(0);
    expect(exited.stdout).toContain("closed");
    // 账本终态复核（真实 CLI status）
    expect(runCli(repoDir, ["status"]).stdout).toMatch(/demo\s+closed/);
  }, 240_000);
});

// ================================================================
// E2E 条件 2：A2 最小版——双叶子 builder 并行重叠（直调 runLoop）
// ================================================================

/** 双叶子场景的测试专用 worker：builder 两段 sleep（各 builderWorkMs）制造可观察区间 */
function writeParallelWorker(): string {
  const script = `// tests/u7-e2e.test.ts 生成的测试专用 agent worker（真实进程，非 mock）
// argv: <role> <unitId> <cwd> <builderWorkMs> <commit> <briefPath>
import { createHash } from "node:crypto";
const DIST = ${JSON.stringify(DIST_ROOT)};
const [role, unitId, cwd, workMsRaw, commit] = process.argv.slice(2);
const builderWorkMs = Number(workMsRaw);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const { ledgerForCwd } = await import(DIST + "/handlers/common.js");
const { loadLedger } = await import(DIST + "/readonly/load.js");
console.log("worker " + role + " " + unitId + " pid=" + process.pid);

if (role === "builder") {
  await sleep(builderWorkMs);
  const unit = loadLedger(cwd).projection.units.get(unitId);
  if (unit === undefined || unit.specs.length === 0) throw new Error("builder: unit " + unitId + " 无 spec");
  const acceptanceIds = unit.specs[unit.specs.length - 1].acceptance.map((a) => a.id);
  const runId = "run-" + unitId + "-" + Date.now();
  const ledger = ledgerForCwd(cwd);
  ledger.append("EvidenceSubmitted", { unitId, runId, commit, paths: ["app.js"], sha256: [sha("app.js")], exitCode: 0 });
  await sleep(builderWorkMs);
  ledger.append("VerifyRan", { unitId, runId, reportHash: sha("evidence-report:" + runId), result: "pass", acceptanceIds });
  console.log("worker-done builder " + unitId);
} else if (role === "reviewer") {
  await sleep(50);
  ledgerForCwd(cwd).append("VerdictSubmitted", { unitId, verdictKind: "exec-review", verdict: "pass" });
  console.log("worker-done reviewer " + unitId);
} else {
  throw new Error("worker: 本场景不应派发 role " + role);
}
`;
  const path = join(tmpRoot, "u7e2e-worker.mjs");
  writeFileSync(path, script);
  return path;
}

const PARALLEL_WORKER_PATH = writeParallelWorker();

interface ParallelSpawnRecord {
  role: string;
  unitId: string;
  at: number;
}

function makeParallelAdapter(commit: string, builderWorkMs: number): {
  adapter: AgentSpawnAdapter;
  spawned(): readonly ParallelSpawnRecord[];
} {
  const records: ParallelSpawnRecord[] = [];
  return {
    adapter: {
      name: "u7e2e-parallel-script",
      spawn: async (req: AgentSpawnRequest): Promise<SpawnHandle> => {
        records.push({ role: req.role, unitId: req.unitId, at: Date.now() });
        return spawnProcess({
          command: process.execPath,
          args: [
            PARALLEL_WORKER_PATH,
            req.role,
            req.unitId,
            // wt-2 迁移：worker 写账本锚定 projectCwd（等价 agent 的 CW_PROJECT_DIR 锚定）
            req.projectCwd,
            String(builderWorkMs),
            commit,
            req.briefPath,
          ],
          cwd: req.workdir,
          timeoutMs: req.timeoutMs,
          // fx-4：产物路径从 req.artifactDir 拼装（run 级 topic 目录）
          stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
          stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
        });
      },
    },
    spawned: () => records,
  };
}

function eventTs(events: readonly LedgerEvent[], unitId: string, type: string): number {
  const hit = events.find(
    (ev) => ev.type === type && ev.payload.unitId === unitId,
  );
  if (hit === undefined) {
    throw new Error(`账本缺 ${unitId} 的 ${type} 事件（重叠断言前置失败）`);
  }
  return Date.parse(hit.ts);
}

describe("E2E real：A2 最小版——双叶子 builder 并行（runLoop 直调 + 账本 ts 重叠断言）", () => {
  it("两 builder 工作区间重叠 ≥1 对（[EvidenceSubmitted, VerifyRan] 事件 ts），全链 root closed", async () => {
    const repoDir = makeScenario("parallel-leaves");
    writeFileSync(join(repoDir, "brief.md"), "# feat 任务书\n");
    // u8 适配：root（split 非空）在两叶 verified 后由循环直跑子树集成——集成会在
    // HEAD 上干净重跑全部受影响验收，app.js 须真实存在且输出 A1 标记行
    writeFileSync(join(repoDir, "app.js"), 'console.log("A1 PASS");\n');
    gitRun(repoDir, ["add", "-A"]);
    gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
    const head = gitRun(repoDir, ["rev-parse", "HEAD"]);

    // fixture 预置：root feat + 两叶全部 spec-frozen（runLoop 首轮 frontier 即两个 builder）
    const ledger = ledgerForCwd(repoDir);
    ledger.append("UnitCreated", {
      unitId: "feat",
      parentId: null,
      briefRef: join(repoDir, "brief.md"),
    });
    const rootSpec = {
      acceptance: ACCEPTANCE_FIXTURE,
      contracts: [],
      split: [
        { unitId: "leaf1", briefRef: "brief.md", dependsOn: [] },
        { unitId: "leaf2", briefRef: "brief.md", dependsOn: [] },
      ] satisfies SplitEntry[],
    };
    ledger.append("SpecSubmitted", {
      unitId: "feat",
      specHash: sha(JSON.stringify(rootSpec)),
      acceptance: ACCEPTANCE_FIXTURE,
      contracts: [],
      split: rootSpec.split,
    });
    ledger.append("VerdictSubmitted", { unitId: "feat", verdictKind: "spec-review", verdict: "pass" });
    for (const leaf of ["leaf1", "leaf2"]) {
      ledger.append("UnitCreated", {
        unitId: leaf,
        parentId: "feat",
        briefRef: join(repoDir, "brief.md"),
      });
      const leafSpec = { acceptance: ACCEPTANCE_FIXTURE, contracts: [], split: [] };
      ledger.append("SpecSubmitted", {
        unitId: leaf,
        specHash: sha(JSON.stringify(leafSpec)),
        acceptance: ACCEPTANCE_FIXTURE,
        contracts: [],
        split: [],
      });
      ledger.append("VerdictSubmitted", { unitId: leaf, verdictKind: "spec-review", verdict: "pass" });
    }

    const { adapter, spawned } = makeParallelAdapter(head, 500);
    const code = await runLoop({
      rootId: "feat",
      adapter,
      cwd: repoDir,
      pollMs: 50,
      maxIdleMs: 20_000,
      maxConcurrency: 3,
    });

    expect(code).toBe(0);
    for (const unitId of ["feat", "leaf1", "leaf2"]) {
      const unit = loadLedger(repoDir).projection.units.get(unitId);
      if (unit === undefined) {
        throw new Error(`unit ${unitId} 缺失（重叠断言前置失败）`);
      }
      expect(unitStatus(unit)).toBe("closed");
    }

    // 重叠断言（账本事件信封 ts 为权威时间线）：
    // 区间 [EvidenceSubmitted.ts, VerifyRan.ts] 即 builder 两次真实写账本之间的工作窗口
    const events = ledgerForCwd(repoDir).readAll();
    const leaf1Start = eventTs(events, "leaf1", "EvidenceSubmitted");
    const leaf1End = eventTs(events, "leaf1", "VerifyRan");
    const leaf2Start = eventTs(events, "leaf2", "EvidenceSubmitted");
    const leaf2End = eventTs(events, "leaf2", "VerifyRan");
    // 辅助证据：两 builder 的派发时刻来自同一轮批次（间隔远小于单个 builder 的窗口）
    const builderDispatches = spawned().filter((r) => r.role === "builder" && r.unitId !== "feat");
    expect(builderDispatches.length).toBe(2);
    const dispatchGap = Math.abs(builderDispatches[0].at - builderDispatches[1].at);
    expect(dispatchGap).toBeLessThan(1_000);

    const overlapMs = Math.min(leaf1End, leaf2End) - Math.max(leaf1Start, leaf2Start);
    // 证据行（验收汇报的时间戳来源）：两区间在账本事件 ts 轴上的重叠毫秒数
    console.log(
      `[u7-e2e] 双叶 builder 区间重叠 ${overlapMs}ms（leaf1:[${leaf1Start},${leaf1End}] leaf2:[${leaf2Start},${leaf2End}]，派发间隔 ${dispatchGap}ms）`,
    );
    expect(overlapMs, `两 builder 区间应重叠（leaf1:[${leaf1Start},${leaf1End}] leaf2:[${leaf2Start},${leaf2End}]）`).toBeGreaterThan(0);

    // 顺序证据（u8 派发时机升级适配：rootLast 从「子全 closed」升级为「子全
    // verified」——root 的 build 不再派 agent worker，改由循环直跑子树集成并写
    // VerifyRan，故改用账本 seq 断言时序）：
    // a) root 的集成 VerifyRan 晚于两叶 VerifyRan（子证据齐是集成的物理前提——
    //    本 fixture 两 builder 完成时刻有先后，这是唯一确定的顺序不变量；
    //    「集成早于子 exec-review（不等 closed）」的确定性断言在 u8-e2e 的
    //    预置 verified fixture 中覆盖）；
    // b) root 无 builder spawn（内部节点不派 agent），其 VerifyRan 为集成产物。
    const allEvents = ledgerForCwd(repoDir).readAll();
    const seqOf = (unitId: string, type: string): number => {
      const hit = allEvents.find((ev) => ev.type === type && ev.payload.unitId === unitId);
      if (hit === undefined) {
        throw new Error(`账本缺 ${unitId} 的 ${type} 事件（断言前置失败）`);
      }
      return hit.seq;
    };
    const rootIntegrateSeq = seqOf("feat", "VerifyRan");
    expect(rootIntegrateSeq).toBeGreaterThan(Math.max(seqOf("leaf1", "VerifyRan"), seqOf("leaf2", "VerifyRan")));
    const featUnit = loadLedger(repoDir).projection.units.get("feat");
    const rootVerify = featUnit?.verifyRuns.at(-1);
    expect(rootVerify?.runId).toMatch(/^integrate-/);
    expect(rootVerify?.result).toBe("pass");
    expect(spawned().some((r) => r.unitId === "feat" && r.role === "builder")).toBe(false);
  }, 60_000);
});

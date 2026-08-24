/**
 * lv2 单测：buildDrift 缓慢进展停派维度 + spawn 超时/预算可调入口
 * （docs/rewrite/acceptance/lv-2-acceptance.md §5 D1-D8 / F1-F2 / S5 兼容）。
 * 零 mock：真实事件账本（隔离 CW_HOME 的 tmp 目录）+ 真实 git 子进程 + 真实
 * CLI / runner 子进程。
 *
 * 分层：
 *   - D1-D4 / D8：dispatch 层（frontier --json）+ stoppedDispatchState 直调——
 *     直写账本构造事实（mx5-2 范式；投影只消费事件字段，command 不真实执行）；
 *   - D5 / F1 / F2 / S5：真实 CLI 子进程（node dist/cli.js）——D5 双进程投影
 *     一致性（账本态实证）；F1/F2 走 flag / env 校验与启动行；S5 与 lv-2 实现
 *     前采集的 golden 基线逐字节对照（唯一预期差异 = frontier 新组行）；
 *   - D6 / D7：真实 runner 子进程（--spawn human + 脚本化提交证据，rv5 范式）。
 *
 * 注意：D6 / D7 / F1 / F2 / S5 走 dist——beforeAll 先 npm run build（npm test 的
 * pretest 已含；直跑本文件同样自足）。
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// loop 系测试约定：runLoop 从 dist 导入（mx5-2 / u7b 同款；npm test 的 pretest
// 已 build，直跑本文件需先 npm run build）
import { runLoop } from "../dist/runner/loop.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnResult,
} from "../dist/runner/spawn/types.js";
import { dispatch } from "../src/dispatch.js";
import type { AcceptanceItem, LedgerEvent } from "../src/events/types.js";
import {
  BUILD_DRIFT_MAX_ATTEMPTS,
  buildDriftFacts,
  stoppedDispatchState,
} from "../src/readonly/frontier.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath, worktreePath } from "../src/store/project.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = join(REPO_ROOT, "dist", "cli.js");

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "cw-lv2-")));
const cwHome = join(tmpRoot, "home");
const originalCwHome = process.env.CW_HOME;
// runner 子进程的 worktree 根隔离（rv5 / mx5-2 同款）
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

beforeAll(() => {
  // e2e 直跑（不经 npm test 的 pretest）也保证 dist 新鲜（u1b 同款）
  execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
}, 120_000);

afterAll(() => {
  if (originalCwHome === undefined) {
    delete process.env.CW_HOME;
  } else {
    process.env.CW_HOME = originalCwHome;
  }
  delete process.env.CW_WORKTREE_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---- dispatch 层（进程内）基建（mx5-2 同款） ----

let caseNo = 0;
let cwd: string;
let ledger: EventLedger;

beforeEach(() => {
  process.env.CW_HOME = cwHome;
  caseNo += 1;
  cwd = join(tmpRoot, `case-${caseNo}`);
  ledger = new EventLedger(ledgerPath(cwHome, cwd));
});

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: readonly string[]): Promise<Captured> {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof origOut;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof origErr;
  try {
    const code = await dispatch(args, cwd);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** 全维度 frontier --json 分组（与派发判定同一出处） */
interface FrontierJson {
  specReady: string[];
  specReviewPending: string[];
  specFixPending: string[];
  specReviewDeadlock: string[];
  missingChildren: string[];
  integrationDrift: string[];
  integrationReady: string[];
  specContractBroken: string[];
  specContractDeadlock: string[];
  flakeReview: string[];
  buildDrift: string[];
  buildReady: string[];
  execReviewReady: string[];
}

async function frontierGroups(): Promise<FrontierJson> {
  const res = await run(["frontier", "--json"]);
  expect(res.code, `frontier 应成功（stderr: ${res.stderr}）`).toBe(0);
  return JSON.parse(res.stdout) as FrontierJson;
}

/** 过 gate 的验收集（spec-frozen 前置）：E1 e2e-real + U1 unit 级（规则⑤） */
function contractAcceptance(): AcceptanceItem[] {
  return [
    { id: "E1", core: true, title: "应用可运行", type: "e2e-real", command: "node e1.js" },
    { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" },
  ];
}

/** 入账 UnitCreated + SpecSubmitted + reviewer pass（unit 进入 spec-frozen） */
function appendFrozenSpec(unitId: string, acceptance: AcceptanceItem[], specNo = 0): void {
  ledger.append("UnitCreated", { unitId, parentId: null, briefRef: "brief.md" });
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: `${unitId}-spec-${specNo}`,
    acceptance,
    contracts: [],
    split: [],
  });
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
}

/** 重提 spec（新周期锚 = SpecSubmitted 事件）+ 重新过审 */
function appendResubmittedSpec(unitId: string, acceptance: AcceptanceItem[], specNo: number): void {
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: `${unitId}-spec-${specNo}`,
    acceptance,
    contracts: [],
    split: [],
  });
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
}

/** 入账 build 证据（EvidenceSubmitted 即 build 证据——payload 无 kind 区分） */
function appendBuildEvidence(unitId: string, runId: string): void {
  ledger.append("EvidenceSubmitted", {
    unitId,
    runId,
    commit: `c-${runId}`,
    paths: [],
    sha256: [],
    exitCode: 0,
  });
}

interface VerifyRanInput {
  runId: string;
  result: "pass" | "fail";
  acceptanceIds: string[];
}

function appendVerifyRan(unitId: string, input: VerifyRanInput): void {
  ledger.append("VerifyRan", {
    unitId,
    runId: input.runId,
    reportHash: `rh-${input.runId}`,
    result: input.result,
    acceptanceIds: input.acceptanceIds,
  });
}

/** K 条证据无 pass 的 drift 账本（D 系共用前缀） */
function appendDriftLedger(unitId: string, evidenceCount: number): void {
  appendFrozenSpec(unitId, contractAcceptance());
  for (let i = 1; i <= evidenceCount; i += 1) {
    appendBuildEvidence(unitId, `b${i}`);
  }
}

// ---- CLI 子进程基建（D5 / F1 / F2 / S5） ----

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8", timeout: 30_000 });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.error?.message ?? res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 真实 CLI 子进程（F/S/D5 用；extraEnv 覆盖注入 CW_SPAWN_TIMEOUT_MS 等） */
function runCli(
  repoDir: string,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): Captured {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome, ...extraEnv },
    timeout: 90_000,
  });
  if (res.error !== undefined) {
    throw new Error(`runCli ${args.join(" ")} 失败: ${res.error.message}`);
  }
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** 真实 tmp git 仓库（单 commit——F 系 runLoop 的 HEAD 快照与 worktree 基底） */
function makeRepo(name: string, briefTitle: string): string {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-lv2@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-lv2"]);
  writeFileSync(join(repoDir, "brief.md"), `# ${briefTitle}\n`);
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  return repoDir;
}

/**
 * 已 closed 的 root fixture（F 系合法值用例：runLoop 启动行打印后即收束 exit 0，
 * 无需空转等待）。verified（VerifyRan pass 覆盖全部验收）+ exec-review pass、无子。
 */
function makeClosedRootRepo(name: string): string {
  const repoDir = makeRepo(name, "closed root fixture");
  const lg = new EventLedger(ledgerPath(cwHome, repoDir));
  lg.append("UnitCreated", { unitId: "fr", parentId: null, briefRef: "brief.md" });
  lg.append("SpecSubmitted", {
    unitId: "fr",
    specHash: "f-spec-1",
    acceptance: contractAcceptance(),
    contracts: [],
    split: [],
  });
  lg.append("VerdictSubmitted", { unitId: "fr", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
  lg.append("EvidenceSubmitted", {
    unitId: "fr",
    runId: "b1",
    commit: gitRun(repoDir, ["rev-parse", "HEAD"]),
    paths: [],
    sha256: [],
    exitCode: 0,
  });
  lg.append("VerifyRan", {
    unitId: "fr",
    runId: "v1",
    reportHash: "rh-v1",
    result: "pass",
    acceptanceIds: ["E1", "U1"],
  });
  lg.append("VerdictSubmitted", {
    unitId: "fr",
    verdictKind: "exec-review",
    verdict: "pass",
    role: "reviewer",
    evidenceRefs: ["v1"],
  });
  return repoDir;
}

// ---- runner 子进程基建（D6 / D7，rv5 范式） ----

/** 断言中途失败时防 runner 子进程泄漏 */
const liveRunners = new Set<ChildProcess>();

afterEach(() => {
  for (const child of liveRunners) {
    child.kill("SIGKILL");
  }
  liveRunners.clear();
});

interface RunnerCapture {
  child: ChildProcess;
  stdoutText(): string;
  stderrText(): string;
}

function startRunner(
  repoDir: string,
  rootId: string,
  extraArgs: readonly string[],
): RunnerCapture {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const child = spawn(
    process.execPath,
    [CLI_PATH, "run", "--root", rootId, "--spawn", "human", "--poll-ms", "150", ...extraArgs],
    { cwd: repoDir, env: { ...process.env, CW_HOME: cwHome }, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (chunk: Buffer) => outChunks.push(chunk.toString("utf-8")));
  child.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk.toString("utf-8")));
  liveRunners.add(child);
  child.on("exit", () => {
    liveRunners.delete(child);
  });
  return { child, stdoutText: () => outChunks.join(""), stderrText: () => errChunks.join("") };
}

function waitExit(runner: RunnerCapture, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    if (runner.child.exitCode !== null) {
      resolve(runner.child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      reject(
        new Error(
          `runner 未在 ${timeoutMs}ms 内退出（stdout 末尾：${runner.stdoutText().slice(-400)}；` +
            `stderr 末尾：${runner.stderrText().slice(-400)}）`,
        ),
      );
    }, timeoutMs);
    runner.child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

/** 轮询等待文本出现（runner stdout/stderr 的同步点；超时抛可诊断错误） */
async function waitText(
  readText: () => string,
  needle: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!readText().includes(needle)) {
    if (Date.now() > deadline) {
      throw new Error(
        `等待文本 "${needle}" 超时（${timeoutMs}ms）。当前文本末尾：${readText().slice(-600)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 等待文本出现指定次数（dispatch 行计数同步点，rv5 同款） */
async function waitTextCount(
  readText: () => string,
  needle: string,
  count: number,
  timeoutMs: number,
): Promise<void> {
  const occurrences = () => readText().split(needle).length - 1;
  const deadline = Date.now() + timeoutMs;
  while (occurrences() < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `等待文本 "${needle}" 出现 ${count} 次超时（当前 ${occurrences()} 次）。文本末尾：${readText().slice(-600)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** D6 / D7 场景仓库的 spec 文件形态与真实提交（children-first 过 gate；dependsOn 必填） */
function submitSpecFile(
  repoDir: string,
  unitId: string,
  splitUnitIds: readonly string[],
): void {
  const spec = {
    acceptance: contractAcceptance(),
    contracts: [],
    split: splitUnitIds.map((childId) => ({ unitId: childId, dependsOn: [] })),
  };
  writeFileSync(join(repoDir, `spec-${unitId}.json`), `${JSON.stringify(spec, null, 2)}\n`);
  expect(
    runCli(repoDir, ["evidence", "submit", "--kind", "spec", "--unit", unitId, "--file", `spec-${unitId}.json`]).code,
    `spec-${unitId} 提交应过 schema+gate`,
  ).toBe(0);
  expect(
    runCli(repoDir, ["review", "submit", "--unit", unitId, "--verdict-kind", "spec-review", "--verdict", "pass", "--role", "reviewer"]).code,
  ).toBe(0);
}

/** 在指定 git 目录（项目 repo 或 unit worktree）提交一批文件，返回新 commit hash */
function commitFiles(dir: string, files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  gitRun(dir, ["add", "-A"]);
  gitRun(dir, ["commit", "-m", `fixture: ${Object.keys(files).join("+")}`]);
  return gitRun(dir, ["rev-parse", "HEAD"]);
}

// ================================================================
// D1-D4：投影口径（dispatch 层直写账本 + frontier --json / buildDriftFacts）
// ================================================================

describe("D1 预算边界", () => {
  it("K-1 条证据 + verify fail → 仍在 buildReady（无误杀）；第 K 条 → 进 buildDrift", async () => {
    appendDriftLedger("u-1", BUILD_DRIFT_MAX_ATTEMPTS - 1);
    appendVerifyRan("u-1", { runId: "v1", result: "fail", acceptanceIds: [] });

    let groups = await frontierGroups();
    expect(groups.buildDrift).toEqual([]);
    expect(groups.buildReady).toContain("u-1");

    appendBuildEvidence("u-1", `b${BUILD_DRIFT_MAX_ATTEMPTS}`);
    groups = await frontierGroups();
    expect(groups.buildDrift).toContain("u-1");
    // 单组归属：buildReady 让位（停派优先于推进）
    expect(groups.buildReady).not.toContain("u-1");
  });
});

describe("D2 pass 豁免", () => {
  it("K 条证据 + 一次非集成 pass verify → 不进 buildDrift；pass 后继续加证据也不触发", async () => {
    appendDriftLedger("u-1", BUILD_DRIFT_MAX_ATTEMPTS);
    appendVerifyRan("u-1", { runId: "v1", result: "pass", acceptanceIds: ["E1", "U1"] });

    // pass 过的 unit 能完成，不属「做不完」——已知边界：pass 后 exec-review 打回
    // 再卡 build 循环不触发（记档行为锁定）
    let groups = await frontierGroups();
    expect(groups.buildDrift).toEqual([]);
    expect(groups.execReviewReady).toContain("u-1");

    appendBuildEvidence("u-1", "b-late-1");
    appendBuildEvidence("u-1", "b-late-2");
    groups = await frontierGroups();
    expect(groups.buildDrift).toEqual([]); // 计数不清零也不触发——hasPass 豁免
  });
});

describe("D3 周期锚与 specEpoch", () => {
  it("K 条 → spec 重提（清零）→ 第二周期第 K 条才触发，specEpoch=2", async () => {
    appendDriftLedger("u-1", BUILD_DRIFT_MAX_ATTEMPTS);
    expect((await frontierGroups()).buildDrift).toContain("u-1"); // 周期 1 达预算

    appendResubmittedSpec("u-1", contractAcceptance(), 2); // 周期重置
    expect((await frontierGroups()).buildDrift).toEqual([]); // 计数清零
    expect((await frontierGroups()).buildReady).toContain("u-1");

    for (let i = 1; i <= BUILD_DRIFT_MAX_ATTEMPTS - 1; i += 1) {
      appendBuildEvidence("u-1", `r2-b${i}`);
    }
    expect((await frontierGroups()).buildDrift).toEqual([]); // 第二周期 K-1 不触发

    appendBuildEvidence("u-1", `r2-b${BUILD_DRIFT_MAX_ATTEMPTS}`);
    const groups = await frontierGroups();
    expect(groups.buildDrift).toContain("u-1"); // 第二周期第 K 次才触发
    const fact = buildDriftFacts(ledger.readAll()).get("u-1");
    expect(fact).toMatchObject({
      buildCount: BUILD_DRIFT_MAX_ATTEMPTS,
      specEpoch: 2,
    });
  });
});

describe("D4 集成排除", () => {
  it("integrate- 前缀 runId 的 VerifyRan：不置 pass、不清零、不计数", async () => {
    // 集成 pass 不置 hasPass（facts 级直断言——组级断言被 verified 粘性态掩盖：
    // integrate pass 覆盖全部验收使 unit 跃迁 verified，无论豁免与否都不在
    // buildDrift 组，只有 facts 级计数能直断「未豁免」；删 integrate 跳过分支
    // → hasPass 被置位 → 谓词不成立 → facts 无此 unit，断言必红）
    appendDriftLedger("u-1", BUILD_DRIFT_MAX_ATTEMPTS);
    ledger.append("VerifyRan", {
      unitId: "u-1",
      runId: "integrate-11111111-1111-4111-8111-111111111111",
      reportHash: "rh-int-1",
      result: "pass",
      acceptanceIds: ["E1", "U1"],
    });
    const driftFact = buildDriftFacts(ledger.readAll()).get("u-1");
    expect(driftFact).toMatchObject({ buildCount: BUILD_DRIFT_MAX_ATTEMPTS }); // 计数保留
    expect(driftFact).toBeDefined(); // 谓词仍成立 = hasPass 未被集成 pass 置位
    const groupsAfterIntegrate = await frontierGroups();
    expect(groupsAfterIntegrate.execReviewReady).toContain("u-1"); // 状态跃迁的实态

    // 集成 fail 不计数：K-1 条证据 + integrate fail ×2 → 不触发
    appendDriftLedger("u-2", BUILD_DRIFT_MAX_ATTEMPTS - 1);
    for (const suffix of ["a", "b"]) {
      ledger.append("VerifyRan", {
        unitId: "u-2",
        runId: `integrate-22222222-2222-4222-8222-2222222222${suffix}`,
        reportHash: `rh-int-2${suffix}`,
        result: "fail",
        acceptanceIds: [],
      });
    }
    const groups = await frontierGroups();
    expect(groups.buildDrift).not.toContain("u-2");
    expect(groups.buildReady).toContain("u-2");
    // facts 级直断言：integrate run 对 u-2 零影响（不计数 → 谓词不成立不外露）
    expect(buildDriftFacts(ledger.readAll()).has("u-2")).toBe(false);
  });
});

// ================================================================
// D5：跨 run 持久（真实 CLI 子进程两次独立调用，账本态实证）
// ================================================================

describe("D5 跨 run 持久", () => {
  it("同一账本两次独立进程 frontier --json 输出全等且 buildDrift 命中——Ctrl-C 重跑计数不丢的机制等价", () => {
    const repoDir = makeRepo("d5-persist", "d5 fixture");
    const lg = new EventLedger(ledgerPath(cwHome, repoDir));
    lg.append("UnitCreated", { unitId: "root", parentId: null, briefRef: "brief.md" });
    lg.append("SpecSubmitted", {
      unitId: "root",
      specHash: "d5-spec-1",
      acceptance: contractAcceptance(),
      contracts: [],
      split: [],
    });
    lg.append("VerdictSubmitted", { unitId: "root", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    for (let i = 1; i <= BUILD_DRIFT_MAX_ATTEMPTS; i += 1) {
      lg.append("EvidenceSubmitted", {
        unitId: "root",
        runId: `d5-b${i}`,
        commit: `c-d5-${i}`,
        paths: [],
        sha256: [],
        exitCode: 0,
      });
    }

    const first = runCli(repoDir, ["frontier", "--json"]);
    expect(first.code).toBe(0);
    const second = runCli(repoDir, ["frontier", "--json"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(first.stdout); // 两进程零内存态，全等 = 账本态实证
    const parsed = JSON.parse(second.stdout) as FrontierJson;
    expect(parsed.buildDrift).toContain("root");
  });
});

// ================================================================
// D6 / D7：真实 runner 子进程（--spawn human + 脚本化提交证据）
// ================================================================

describe("D6 预算注入与恢复派发", () => {
  it(
    "默认 K 时停派（stderr 三选一原文与实际 buildCount）+ frontier 恒默认；--max-build-attempts K+3 重跑恢复派发",
    async () => {
      const repoDir = makeRepo("d6-drift", "d6 缓慢进展场景");
      expect(runCli(repoDir, ["create", "--id", "dd", "--brief", "brief.md"]).code).toBe(0);
      submitSpecFile(repoDir, "dd", []);
      const wtDir = worktreePath(WT_HOME, repoDir, "dd");
      const dispatchLine = '派发 developer → unit "dd"';
      const implBad = (i: number) => `// attempt ${i}\nconsole.log('E1 FAIL');\nprocess.exit(1);\n`;
      const u1check = [
        "const fs = require('fs');",
        "let ok = false;",
        "try { ok = fs.readFileSync(__dirname + '/impl.js', 'utf8').includes('E1 PASS'); } catch (e) { ok = false; }",
        "console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'U1 smoke',status: ok ? 'passed' : 'failed'}]}]}));",
        "if (!ok) { console.error('impl not good'); process.exit(1); }",
        "",
      ].join("\n");
      const submitEvidence = (label: string, commit: string) => {
        expect(
          runCli(repoDir, ["evidence", "submit", "--kind", "build", "--unit", "dd", "--commit", commit, "--run-id", label]).code,
          `证据 ${label} 提交应成功`,
        ).toBe(0);
      };

      // runner A 启动（先派发创建 worktree，rv5 T3 同序）；idle 4s：停派后空转收束
      const runner = startRunner(repoDir, "dd", ["--max-idle-ms", "4000"]);
      await waitText(runner.stdoutText, dispatchLine, 60_000); // buildCount 0 时正常派发（无误杀）

      // 第 1 轮：坏实现（E1 恒 FAIL）+ 证据 + verify 恒挂（有产出但做不完的形态）
      const c1 = commitFiles(wtDir, { "impl.js": implBad(1), "e1.js": "require('./impl.js');\n", "u1check.js": u1check });
      submitEvidence("b1", c1);
      const verify1 = runCli(repoDir, ["verify", "--unit", "dd"]);
      expect(verify1.code, `第一次 verify 应 fail（E1 FAIL）：${verify1.stderr}`).toBe(1);

      // verify 的 VerifyRan 结算第 1 个 developer spawn → 重派 #2（K-1 内正常重派）
      await waitTextCount(runner.stdoutText, dispatchLine, 2, 10_000);
      // 第 2-4 条证据（微改提交，不再 verify——buildDrift 只看证据计数）
      for (let i = 2; i <= BUILD_DRIFT_MAX_ATTEMPTS - 1; i += 1) {
        submitEvidence(`b${i}`, commitFiles(wtDir, { "impl.js": implBad(i) }));
      }

      // 第 K 条证据入账 → 下轮停派 + stderr 转人工（三选一原文 + 实际 buildCount）
      submitEvidence(`b${BUILD_DRIFT_MAX_ATTEMPTS}`, commitFiles(wtDir, { "impl.js": implBad(BUILD_DRIFT_MAX_ATTEMPTS) }));
      await waitText(runner.stderrText, "停止自动重派", 60_000);
      const stderr = runner.stderrText();
      expect(stderr).toContain("build 证据已达 5 次");
      expect(stderr).toContain("--max-build-attempts 预算 5");
      expect(stderr).toContain("三选一");
      expect(stderr).toContain("cw run --root dd --max-build-attempts <更大值>");
      expect(stderr).toContain("本 spec 周期内无 pass verify");
      // 三选一恢复指引第 1/2 选 + 尾句（§3.1 成功路径全文锁定，escalations 文案锁定）
      expect(stderr).toContain("cw run --root dd --spawn human");
      expect(stderr).toContain("dd.developer.stdout");
      expect(stderr).toContain("本循环继续处理其余 unit");

      const code = await waitExit(runner, 30_000);
      expect(code).toBe(1); // 停派后无 machine 推进路径，空转由 idle 收束（审计-不喂-idle）
      // 停派实证：第 K 条证据后至 idle 退出无新派发（共 2 次：#1 结算后重派 + #2 挂起）
      const dispatchCount = runner.stdoutText().split(dispatchLine).length - 1;
      expect(dispatchCount).toBe(2);

      // 只读恒默认：frontier --json 的 buildDrift 命中不随 run flag 改变
      const frontier = JSON.parse(runCli(repoDir, ["frontier", "--json"]).stdout) as FrontierJson;
      expect(frontier.buildDrift).toContain("dd");

      // runner B：K+3 注入 → 5 < 8 不停派，恢复自动派发
      const runnerB = startRunner(repoDir, "dd", ["--max-build-attempts", "8", "--max-idle-ms", "4000"]);
      await waitText(runnerB.stdoutText, dispatchLine, 60_000);
      expect(runnerB.stderrText()).not.toContain("停止自动重派"); // 预算放宽后不出声
      runnerB.child.kill("SIGKILL");
      // 恢复期间 frontier 仍恒默认（只读投影与运行策略解耦）
      const frontierAfter = JSON.parse(runCli(repoDir, ["frontier", "--json"]).stdout) as FrontierJson;
      expect(frontierAfter.buildDrift).toContain("dd");
    },
    180_000,
  );
});

describe("D7 停派不阻断同 root 其余 unit", () => {
  it("双叶 fixture：一叶 drift 停派（零派发 + stderr 指引），另一叶正常派发 developer", async () => {
    const repoDir = makeRepo("d7-twin", "d7 双叶场景");
    expect(runCli(repoDir, ["create", "--id", "dr", "--brief", "brief.md"]).code).toBe(0);
    expect(runCli(repoDir, ["create", "--id", "la", "--brief", "brief.md", "--parent", "dr"]).code).toBe(0);
    expect(runCli(repoDir, ["create", "--id", "lb", "--brief", "brief.md", "--parent", "dr"]).code).toBe(0);
    submitSpecFile(repoDir, "dr", ["la", "lb"]);
    submitSpecFile(repoDir, "la", []);
    submitSpecFile(repoDir, "lb", []);

    // la 直接在项目 repo 提交 K 条证据（无 pass）→ 账本态 buildDrift；
    // lb 零证据 → buildReady
    for (let i = 1; i <= BUILD_DRIFT_MAX_ATTEMPTS; i += 1) {
      const commit = commitFiles(repoDir, { [`la-attempt-${i}.txt`]: `attempt ${i}\n` });
      expect(
        runCli(repoDir, ["evidence", "submit", "--kind", "build", "--unit", "la", "--commit", commit, "--run-id", `la-b${i}`]).code,
      ).toBe(0);
    }

    const runner = startRunner(repoDir, "dr", ["--max-idle-ms", "8000"]);
    // lb 正常派发（停派不阻断同 root 其余 unit）
    await waitText(runner.stdoutText, '派发 developer → unit "lb"', 60_000);
    // la 的 buildDrift 转人工指引出声
    await waitText(runner.stderrText, 'unit "la" 的 build 证据已达', 60_000);
    expect(runner.stderrText()).toContain("--max-build-attempts 预算 5");
    // la 零派发（观察窗口：1 个 poll 周期以上）
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(runner.stdoutText()).not.toContain('派发 developer → unit "la"');
    runner.child.kill("SIGKILL");
  }, 60_000);
});

// ================================================================
// D8：stoppedDispatchState 第四维（直调 + 三既有维度回归）
// ================================================================

describe("D8 停派态描述", () => {
  it("buildDrift unit 返回第四维描述；三既有维度文案回归不变", () => {
    // buildDrift：K 条证据无 pass
    appendDriftLedger("u-drift", BUILD_DRIFT_MAX_ATTEMPTS);
    expect(stoppedDispatchState(ledger.readAll(), "u-drift")).toBe(
      "buildDrift（build 证据达预算无 pass，缓慢进展转人工）",
    );
    // 无停派事实的 unit → null
    appendDriftLedger("u-ok", 1);
    expect(stoppedDispatchState(ledger.readAll(), "u-ok")).toBeNull();
  });

  it("specContractDeadlock / flakeReview / specReviewDeadlock 三既有维度回归", () => {
    // specContractDeadlock：两轮完整回炉仍连挂
    const acceptance = contractAcceptance();
    appendFrozenSpec("u-cd", acceptance, 1);
    for (let specNo = 1; specNo <= 3; specNo += 1) {
      if (specNo > 1) {
        appendResubmittedSpec("u-cd", acceptance, specNo);
      }
      for (const suffix of ["a", "b"]) {
        ledger.append("VerifyRan", {
          unitId: "u-cd",
          runId: `cd${specNo}${suffix}`,
          reportHash: `rh-cd${specNo}${suffix}`,
          result: "fail",
          acceptanceIds: [],
          parseFailedAcceptanceIds: ["E1"],
        });
      }
    }
    expect(stoppedDispatchState(ledger.readAll(), "u-cd")).toBe(
      "specContractDeadlock（验收命令解析失败已 2 代回炉，防活锁转人工）",
    );

    // flakeReview：e2e 断言失败连挂 2
    appendFrozenSpec("u-fl", contractAcceptance());
    appendVerifyRan("u-fl", { runId: "f1", result: "fail", acceptanceIds: ["U1"] });
    appendVerifyRan("u-fl", { runId: "f2", result: "fail", acceptanceIds: ["U1"] });
    expect(stoppedDispatchState(ledger.readAll(), "u-fl")).toBe(
      "flakeReview（e2e 验收连挂转人工判定）",
    );

    // specReviewDeadlock：10 代打回
    ledger.append("UnitCreated", { unitId: "u-sd", parentId: null, briefRef: "brief.md" });
    for (let gen = 1; gen <= 10; gen += 1) {
      ledger.append("SpecSubmitted", {
        unitId: "u-sd",
        specHash: `sd-spec-${gen}`,
        acceptance: contractAcceptance(),
        contracts: [],
        split: [],
      });
      ledger.append("VerdictSubmitted", {
        unitId: "u-sd",
        verdictKind: "spec-review",
        verdict: "fail",
        role: "reviewer",
        comment: `第 ${gen} 代打回`,
      });
    }
    expect(stoppedDispatchState(ledger.readAll(), "u-sd")).toBe(
      "specReviewDeadlock（spec 打回代数达预算转人工）",
    );
  });
});

// ================================================================
// D9：结算行停派判定与派发预算同源（F1 修复——stoppedDispatchState 预算参数
// 贯通，注入值下 TIMEOUT 结算行不再谎报）。loop 级走 runLoop 进程内直调
//（mx5-2 F10 同款 stepped adapter：spawn 时同步副作用 + wait() 按脚本返回四态）
// ================================================================

/** 捕获 runLoop 直调的 stdout/stderr（mx5-2 同款；透传 write 回调防 flush 屏障拖慢） */
async function captureLoopStd(
  fn: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
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

interface LoopAdapterStep {
  exitCode: SpawnResult["exitCode"];
  /** spawn 时同步执行（写账本等真实副作用） */
  onSpawn?: () => void;
}

/** 脚本化 adapter（mx5-2 F10 同款形态）：记录全部 spawn 请求 */
function makeLoopAdapter(steps: readonly LoopAdapterStep[]): {
  adapter: AgentSpawnAdapter;
  calls: AgentSpawnRequest[];
} {
  const calls: AgentSpawnRequest[] = [];
  return {
    adapter: {
      name: "lv2-d9-stepped",
      spawn: async (req) => {
        calls.push(req);
        const step = steps[Math.min(calls.length - 1, steps.length - 1)];
        step.onSpawn?.();
        return {
          wait: async () => ({
            exitCode: step.exitCode,
            stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
            stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
            pid: -1,
          }),
          kill: () => {},
        };
      },
    },
    calls,
  };
}

describe("D9 结算行预算贯通", () => {
  it("注入 K=10：buildCount=6 的 TIMEOUT 结算行不含 buildDrift 停派、照常重派；默认 K=5 同账本形态结算行含 buildDrift（不再谎报）", async () => {
    const makeDriftRepo = (name: string): { repoDir: string; lg: EventLedger } => {
      const repoDir = makeRepo(name, "d9 结算预算 fixture");
      const lg = new EventLedger(ledgerPath(cwHome, repoDir));
      lg.append("UnitCreated", { unitId: "root", parentId: null, briefRef: "brief.md" });
      lg.append("SpecSubmitted", {
        unitId: "root",
        specHash: "d9-spec-1",
        acceptance: contractAcceptance(),
        contracts: [],
        split: [],
      });
      lg.append("VerdictSubmitted", { unitId: "root", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
      return { repoDir, lg };
    };
    // spawn 在飞期间写入 6 条证据（5 ≤ 6 < 10——恰好跨默认/注入预算分界点）：
    // TIMEOUT 结算时刻的停派判定即分叉现场（修复前 stoppedDispatchState 恒用
    // 默认 K=5 → 注入侧结算行谎报停派，而下一轮派发实际照常重派）
    const spawnWritesSixEvidences = (lg: EventLedger) => () => {
      for (let i = 1; i <= 6; i += 1) {
        lg.append("EvidenceSubmitted", {
          unitId: "root",
          runId: `d9-b${i}`,
          commit: `c-d9-${i}`,
          paths: [],
          sha256: [],
          exitCode: 0,
        });
      }
    };

    // --- 注入侧（K=10）：结算行与下一轮派发一致——「可重派」且真的重派了 ---
    const injected = makeDriftRepo("d9-injected");
    const adapterA = makeLoopAdapter([
      { exitCode: "TIMEOUT", onSpawn: spawnWritesSixEvidences(injected.lg) },
      { exitCode: "TIMEOUT" }, // 后续重派持续 TIMEOUT → 连续 2 次转人工收束
    ]);
    const runA = await captureLoopStd(() =>
      runLoop({
        rootId: "root",
        adapter: adapterA.adapter,
        cwd: injected.repoDir,
        pollMs: 30,
        maxIdleMs: 1_500,
        maxBuildAttempts: 10,
      }),
    );
    expect(runA.code).toBe(1); // 连续 TIMEOUT 转人工收束（与 buildDrift 无关的既有出口）
    expect(runA.out).toContain("TIMEOUT，可重派（连续 2 次后转人工）");
    expect(runA.out).not.toContain("buildDrift");
    // 重派实际发生（≥2 次 spawn）——结算行「可重派」与派发实态一致的正向证明
    //（精确次数受 TIMEOUT 计数的进展清零语义影响，非本用例焦点）
    expect(adapterA.calls.length).toBeGreaterThanOrEqual(2);

    // --- 对照组（默认 K=5）：同账本形态 → buildDrift 停派，结算行诚实改述 ---
    const plain = makeDriftRepo("d9-default");
    const adapterB = makeLoopAdapter([
      { exitCode: "TIMEOUT", onSpawn: spawnWritesSixEvidences(plain.lg) },
    ]);
    const runB = await captureLoopStd(() =>
      runLoop({
        rootId: "root",
        adapter: adapterB.adapter,
        cwd: plain.repoDir,
        pollMs: 30,
        maxIdleMs: 1_500,
      }),
    );
    expect(runB.code).toBe(1); // 停派后无 machine 推进路径，空转由 idle 收束
    expect(runB.out).toContain("处于 buildDrift");
    expect(runB.out).toContain("停派态");
    expect(runB.out).toContain("本次超时不触发重派");
    expect(runB.out).not.toContain("可重派");
    expect(adapterB.calls.length).toBe(1); // 停派后零重派
  }, 30_000);

  it("直调投影：maxBuildAttempts / maxSpecRejects 注入均改变停派判定（specReviewDeadlock 同型分叉一并实证）", () => {
    // buildDrift 分叉：buildCount=6 —— 默认 K=5 停派、注入 10 判可续
    appendDriftLedger("u-d9", 6);
    const events = ledger.readAll();
    expect(stoppedDispatchState(events, "u-d9")).toContain("buildDrift");
    expect(stoppedDispatchState(events, "u-d9", { maxBuildAttempts: 10 })).toBeNull();

    // specReviewDeadlock 分叉：10 代打回 —— 默认预算 10 停派、注入 12 判可续
    ledger.append("UnitCreated", { unitId: "u-d9sd", parentId: null, briefRef: "brief.md" });
    for (let gen = 1; gen <= 10; gen += 1) {
      ledger.append("SpecSubmitted", {
        unitId: "u-d9sd",
        specHash: `d9sd-spec-${gen}`,
        acceptance: contractAcceptance(),
        contracts: [],
        split: [],
      });
      ledger.append("VerdictSubmitted", {
        unitId: "u-d9sd",
        verdictKind: "spec-review",
        verdict: "fail",
        role: "reviewer",
        comment: `第 ${gen} 代打回`,
      });
    }
    const eventsSd = ledger.readAll();
    expect(stoppedDispatchState(eventsSd, "u-d9sd")).toContain("specReviewDeadlock");
    expect(stoppedDispatchState(eventsSd, "u-d9sd", { maxSpecRejects: 12 })).toBeNull();
  });
});

// ================================================================
// F1 / F2：CLI flag 与 env 合流（真实 CLI 子进程）
// ================================================================

describe("F1 --spawn-timeout-ms 校验与 env 合流", () => {
  const repoDir = () => join(tmpRoot, "f1");

  it("非法值（abc / 0 / -5 / 1.5）→ exit 1 可操作文案", () => {
    mkdirSync(repoDir(), { recursive: true });
    for (const bad of ["abc", "0", "-5", "1.5"]) {
      // -5 用等号形态：minimist 把空格形态的 "-5" 解析为独立 boolean flag
      const flag = `--spawn-timeout-ms=${bad}`;
      const res = runCli(repoDir(), ["run", "--root", "r", flag]);
      expect(res.code, `--spawn-timeout-ms ${bad} 应 exit 1`).toBe(1);
      expect(res.stderr).toContain("非法 --spawn-timeout-ms");
      expect(res.stderr).toContain("须为正整数");
      expect(res.stderr).toContain(bad); // 原文回显
    }
  });

  it("合法值进 runLoop：flag > env > 缺省；env 非法 exit 1", () => {
    const closed = makeClosedRootRepo("f1-closed");
    // flag 直达：启动行含注入值
    const byFlag = runCli(closed, ["run", "--root", "fr", "--spawn-timeout-ms", "123456"]);
    expect(byFlag.code, `runner 应 exit 0（stderr: ${byFlag.stderr}）`).toBe(0);
    expect(byFlag.stdout).toContain("spawn-timeout-ms=123456ms");

    // env 覆盖缺省（无 flag）
    const byEnv = runCli(closed, ["run", "--root", "fr"], { CW_SPAWN_TIMEOUT_MS: "222222" });
    expect(byEnv.code).toBe(0);
    expect(byEnv.stdout).toContain("spawn-timeout-ms=222222ms");

    // flag 优先于 env
    const flagOverEnv = runCli(
      closed,
      ["run", "--root", "fr", "--spawn-timeout-ms", "333333"],
      { CW_SPAWN_TIMEOUT_MS: "222222" },
    );
    expect(flagOverEnv.code).toBe(0);
    expect(flagOverEnv.stdout).toContain("spawn-timeout-ms=333333ms");

    // env 非法 → exit 1 可操作文案（含原文与合法形态）
    const badEnv = runCli(closed, ["run", "--root", "fr"], { CW_SPAWN_TIMEOUT_MS: "abc" });
    expect(badEnv.code).toBe(1);
    expect(badEnv.stderr).toContain('非法 CW_SPAWN_TIMEOUT_MS "abc"');
    expect(badEnv.stderr).toContain("CW_SPAWN_TIMEOUT_MS=3600000");

    // 缺省回落 30min（无 flag 无 env——afterEach 链上其他用例可能污染 env，显式清）
    const byDefault = runCli(closed, ["run", "--root", "fr"], { CW_SPAWN_TIMEOUT_MS: "" });
    expect(byDefault.code).toBe(0);
    expect(byDefault.stdout).toContain("spawn-timeout-ms=1800000ms");
  }, 60_000);
});

describe("F2 --max-build-attempts 校验", () => {
  it("非法值（abc / 0 / -5 / 1.5）→ exit 1 可操作文案；合法值进 runLoop 启动行", () => {
    const dir = join(tmpRoot, "f2");
    mkdirSync(dir, { recursive: true });
    for (const bad of ["abc", "0", "-5", "1.5"]) {
      // -5 用等号形态（F1 同理）：minimist 把空格形态的 "-5" 解析为独立 boolean flag
      const res = runCli(dir, ["run", "--root", "r", `--max-build-attempts=${bad}`]);
      expect(res.code, `--max-build-attempts ${bad} 应 exit 1`).toBe(1);
      expect(res.stderr).toContain("非法 --max-build-attempts");
      expect(res.stderr).toContain("须为正整数");
    }

    const closed = makeClosedRootRepo("f2-closed");
    const res = runCli(closed, ["run", "--root", "fr", "--max-build-attempts", "8"]);
    expect(res.code, `runner 应 exit 0（stderr: ${res.stderr}）`).toBe(0);
    expect(res.stdout).toContain("max-build-attempts=8");
    // 缺省回落 BUILD_DRIFT_MAX_ATTEMPTS
    const def = runCli(closed, ["run", "--root", "fr"]);
    expect(def.code).toBe(0);
    expect(def.stdout).toContain(`max-build-attempts=${BUILD_DRIFT_MAX_ATTEMPTS}`);
  }, 60_000);
});

// ================================================================
// S5：旧账本兼容（golden 基线 = lv-2 实现前采集，逐字节对照）
// ================================================================

/**
 * golden 快照：lv-2 改动前（基线 commit b18a6a5 的 dist）对同一 fixture 账本
 * 采集的四命令输出（.tmp/lv2-golden-capture.mjs，fixture 与 buildCompatLedger
 * 逐字节同构）。S5 断言：status / tree / report 逐字节一致；frontier 唯一
 * 预期差异 = 新增 buildDrift 空组行（renderFrontier 恒显全部组标题）。
 */
const GOLDEN = {
  status: "root  created  specs:0 evidences:0 lastVerify:-\nleaf  spec-frozen  specs:1 evidences:1 lastVerify:fail\n",
  tree: "root (created)\n  leaf (spec-frozen)\n",
  report:
    "unit: root (created)\n" +
    "  spec: (未提交)\n" +
    "  acceptance:\n" +
    "    (无)\n" +
    "  evidences:\n" +
    "    (无)\n" +
    "  verifyRuns:\n" +
    "    (无)\n" +
    "\n" +
    "unit: leaf (spec-frozen)\n" +
    "  spec: lv2-golden-s\n" +
    "  acceptance:\n" +
    "    A1 e2e-real [core] ✗ node -v\n" +
    "    A2 unit ✗\n" +
    "  evidences:\n" +
    "    runId=b-golden-1 commit=c0ffee0000000000000000000000000000000000\n" +
    "  verifyRuns:\n" +
    "    runId=vr-golden-1 result=fail acceptance=-\n",
  frontier:
    "specReady:\n" +
    "  root\n" +
    "specReviewPending:\n" +
    "  (无)\n" +
    "specFixPending:\n" +
    "  (无)\n" +
    "specReviewDeadlock:\n" +
    "  (无)\n" +
    "missingChildren:\n" +
    "  (无)\n" +
    "integrationDrift:\n" +
    "  (无)\n" +
    "integrationReady:\n" +
    "  (无)\n" +
    "specContractBroken:\n" +
    "  (无)\n" +
    "specContractDeadlock:\n" +
    "  (无)\n" +
    "flakeReview:\n" +
    "  (无)\n" +
    "buildReady:\n" +
    "  leaf\n" +
    "execReviewReady:\n" +
    "  (无)\n",
} as const;

/** 与 golden 采集脚本（.tmp/lv2-golden-capture.mjs）逐字节同构的 fixture 账本 */
function buildCompatLedger(projDir: string): void {
  const lg = new EventLedger(ledgerPath(cwHome, projDir));
  lg.append("UnitCreated", { unitId: "root", parentId: null, briefRef: "briefs/root.md" });
  lg.append("UnitCreated", { unitId: "leaf", parentId: "root", briefRef: "briefs/leaf.md" });
  lg.append("SpecSubmitted", {
    unitId: "leaf",
    specHash: "lv2-golden-spec-00000000000000000000000000",
    acceptance: [
      { id: "A1", core: true, title: "A1 核心链路", type: "e2e-real", command: "node -v" },
      { id: "A2", core: false, title: "A2 单元级", type: "unit" },
    ],
    contracts: [],
    split: [],
  });
  lg.append("VerdictSubmitted", { unitId: "leaf", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
  lg.append("EvidenceSubmitted", {
    unitId: "leaf",
    runId: "b-golden-1",
    commit: "c0ffee0000000000000000000000000000000000",
    paths: [],
    sha256: [],
    exitCode: 0,
  });
  lg.append("VerifyRan", {
    unitId: "leaf",
    runId: "vr-golden-1",
    reportHash: "rh-golden-1",
    result: "fail",
    acceptanceIds: [],
  });
}

describe("S5 旧账本兼容（无 buildDrift 命中的账本）", () => {
  it("status / tree / report 与改造前逐字节一致；frontier 唯一差异 = 新增 buildDrift 空组行", () => {
    const projDir = join(tmpRoot, "s5-compat");
    mkdirSync(projDir, { recursive: true });
    buildCompatLedger(projDir);

    for (const cmd of ["status", "tree", "report"] as const) {
      const res = runCli(projDir, [cmd]);
      expect(res.code, `${cmd} exit code`).toBe(0);
      expect(res.stdout, `${cmd} 应与改造前逐字节一致`).toBe(GOLDEN[cmd]);
    }

    const frontier = runCli(projDir, ["frontier"]);
    expect(frontier.code).toBe(0);
    // 预期差异两组（均恒显空组两行）：lv-2 新增 buildDrift（flakeReview 与
    // buildReady 之间）；ph-i1 R4 新增 reflectionPending（specReady 与
    // specReviewPending 之间）。去掉两组行后与改造前逐字节一致（差异存在且仅此）
    expect(frontier.stdout).toContain("buildDrift:\n  (无)\n");
    expect(frontier.stdout.indexOf("buildDrift:")).toBeGreaterThan(frontier.stdout.indexOf("flakeReview:"));
    expect(frontier.stdout.indexOf("buildDrift:")).toBeLessThan(frontier.stdout.indexOf("buildReady:"));
    expect(frontier.stdout).toContain("reflectionPending:\n  (无)\n");
    expect(frontier.stdout.indexOf("reflectionPending:")).toBeGreaterThan(frontier.stdout.indexOf("specReady:"));
    expect(frontier.stdout.indexOf("reflectionPending:")).toBeLessThan(frontier.stdout.indexOf("specReviewPending:"));
    expect(frontier.stdout.replace("buildDrift:\n  (无)\n", "").replace("reflectionPending:\n  (无)\n", "")).toBe(GOLDEN.frontier);
  });
});

// ================================================================
// 投影纯度（波后验收 §7.2 的机制面前置：同输入两次调用全等 + 无锚防御）
// ================================================================

describe("纯度与防御", () => {
  it("buildDriftFacts 对同一事件数组两次调用结果全等（无隐藏态）；无 spec 锚的 EvidenceSubmitted 不 crash", () => {
    appendDriftLedger("u-1", BUILD_DRIFT_MAX_ATTEMPTS);
    const events: LedgerEvent[] = ledger.readAll();
    const first = buildDriftFacts(events);
    const second = buildDriftFacts(events);
    expect(second).toEqual(first); // 纯投影：无内存态

    // 无 spec 锚的证据（created 但无 SpecSubmitted——正常流程不可达，handler 先
    // 查 spec；账本层只拦「无 UnitCreated」形态）：防御跳过不 crash、不外露
    ledger.append("UnitCreated", { unitId: "u-orphan", parentId: null, briefRef: "brief.md" });
    ledger.append("EvidenceSubmitted", {
      unitId: "u-orphan",
      runId: "x1",
      commit: "c-x1",
      paths: [],
      sha256: [],
      exitCode: 0,
    });
    expect(buildDriftFacts(ledger.readAll()).has("u-orphan")).toBe(false);
  });
});

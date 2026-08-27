/**
 * rv5 单测：flake 转人工 + 随机性豁免（docs/rewrite/acceptance/rv5-acceptance.md
 * §5 T1-T8；dispatch 层完整路径 + 真实 runner 子进程，真实 git 子进程 + tmp 目录
 * + 隔离 CW_HOME，零 mock）。
 *
 *   T1 声明豁免两处：普通验收 pass + nondeterministic 验收固定 fail → verify
 *      exit 0（整体 pass）；report.json 该条目结果照录 + 名字比对标注跳过
 *      （红阶段默认开启——N1 的红阶段跳过判定同场验证）
 *   T2 声明不逃逸执行：声明条目真跑真产物（stdout/stderr/exitCode，非 skip 执行）
 *   T3 e2e 连挂转人工（核心）：固定 fail 的 e2e 验收两次 verify fail → frontier
 *      --json 出现 flakeReview；human 模式 runner stderr 出现人工判定指引（含
 *      用例 id 与两次 runId）且不再派该 unit 的 developer
 *   T4 中间 pass 清零：fail → pass → fail（同 spec 周期）→ 不出 flakeReview
 *   T5 unit 级不转人工：unit 型验收连挂 2 次 → 无 flakeReview（正常打回继续）
 *   T6 集成 fail 不计数：integrate- 前缀 runId 的 VerifyRan fail ×2 → 不出 flakeReview
 *   T7 spec 变更清零：连挂 1 次后重提 spec → 计数清零（再挂 1 次不出，第 2 次才出）
 *   T8 人工处置自愈：T3 场景后按指引修复（修实现稳定 pass + 重提 build + verify
 *      pass）→ flakeReview 消失、循环继续推进至 root closed
 *
 * 注意：T3/T8 走真实 runner 子进程（node dist/cli.js run --spawn human），直接
 * `npx vitest run tests/rv5-flake-escalation.test.ts` 不触发 pretest，需先
 * `npm run build`（`npm test` 的 pretest 已含）；dist 缺席时这两条以 it.todo 挂起
 * （u5b/u7-e2e 同款条件激活模式）。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import type { AcceptanceItem } from "../src/events/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { evidenceDir, ledgerPath, worktreePath } from "../src/store/project.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const HUMAN_ADAPTER_DIST = fileURLToPath(new URL("../dist/runner/spawn/human.js", import.meta.url));
/** runner 子进程用例（T3/T8）：dist 缺席时挂起（pretest build 后自动激活） */
const runnerIt = existsSync(CLI_PATH) && existsSync(HUMAN_ADAPTER_DIST) ? it : it.todo;

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-rv5-"));
const cwHome = join(tmpRoot, "home");
const originalCwHome = process.env.CW_HOME;
// runner 子进程的 worktree 根隔离（u7-e2e 同款；与 CW_HOME 一并注入子进程 env）
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  if (originalCwHome === undefined) {
    delete process.env.CW_HOME;
  } else {
    process.env.CW_HOME = originalCwHome;
  }
  delete process.env.CW_WORKTREE_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function git(dir: string, args: readonly string[]): void {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", timeout: 30_000 });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.error?.message ?? res.stderr}`);
  }
}

function gitOut(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", timeout: 30_000 });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.error?.message ?? res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 真实 tmp git 仓库：init + 每次提交写入一批根目录文件；返回各 commit hash（按提交序） */
function makeGitRepo(dir: string, commitsFiles: ReadonlyArray<Record<string, string>>): string[] {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "cw-test@example.com"]);
  git(dir, ["config", "user.name", "cw-test"]);
  const hashes: string[] = [];
  commitsFiles.forEach((files, i) => {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", `commit-${i + 1}`]);
    hashes.push(gitOut(dir, ["rev-parse", "HEAD"]));
  });
  return hashes;
}

// ---- 公共 fixture：impl / e1 / u1check 三件套（红阶段 patch 语义下可判区分力） ----

/**
 * impl.js 的「好」形态：输出 e2e-sh 标记行（e1.js 直接 require 转发）。
 * 标记行第一列 = 验收 id（e2e-sh MARKER_RE 契约），参数化以复用到不同 id。
 */
function implGood(markerId: string): string {
  return `console.log('${markerId} PASS');\n`;
}

/** impl.js 的「坏」形态：输出 FAIL 标记并以非零退出（真实挂事实，非跳过执行） */
function implBad(markerId: string): string {
  return `console.log('${markerId} FAIL');\nprocess.exit(1);\n`;
}

/** e1.js：require impl（转发其标记行输出与退出码）——e2e 验收 command 的入口 */
function e1File(): string {
  return "require('./impl.js');\n";
}

/**
 * u1check.js：unit 级验收 command 的入口。产出 vitest JSON reporter 形状产物
 *（u5b/u7-e2e 同款——tmp repo 无 node_modules，真 vitest 环境不可得）；红阶段
 * 语义：impl 缺失或不含期望标记 → 用例级 failed + exit 1 → 旧树 fail（有区分
 * 力），防止自包含恒真命令把红阶段判无区分力。mx5-2 起产物契约恒为可解析
 * JSON（impl 坏时也不产出裸文本）——unit 型「解析失败连挂」会进 spec 契约回炉
 * 通道（specContractBroken），与本套件的 flake 焦点正交：fixture 保持 U1 恒
 * 断言失败（parse 恒成功），两通道不抢同一形态。
 */
function u1CheckFile(markerId: string): string {
  return [
    "const fs = require('fs');",
    "let ok = false;",
    `try { ok = fs.readFileSync(__dirname + '/impl.js', 'utf8').includes('${markerId} PASS'); } catch {}`,
    "console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'U1 smoke',status: ok ? 'passed' : 'failed'}]}]}));",
    "if (!ok) { console.error('impl not good'); process.exit(1); }",
    "",
  ].join("\n");
}

/**
 * T3/T8/T4/T7 共用的 spec 验收集（U1 = gate 规则⑤的 unit 级条目，command 指向
 * u1check.js——红阶段 patch 语义下有区分力；E1 = 被观察的 e2e 条目，command
 * 指向 e1.js）。参数化 e2e command 以便场景内联变体复用。
 */
function e2eSpecAcceptance(e1Command: string): AcceptanceItem[] {
  return [
    { id: "E1", core: true, title: "被观察的 e2e 验收", type: "e2e-real", command: e1Command },
    { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" },
  ];
}

// ---- dispatch 层（进程内）基建 ----

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
  buildReady: string[];
  execReviewReady: string[];
}

async function frontierGroups(): Promise<FrontierJson> {
  const res = await run(["frontier", "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout) as FrontierJson;
}

interface VerifyRanFact {
  runId: string;
  result: string;
  acceptanceIds: string[];
}

function verifyRanFacts(): VerifyRanFact[] {
  return ledger
    .readAll()
    .filter((e) => e.type === "VerifyRan")
    .map((e) => {
      const p = e.payload as VerifyRanFact;
      return { runId: p.runId, result: p.result, acceptanceIds: p.acceptanceIds };
    });
}

function lastVerifyRunId(): string {
  const runs = verifyRanFacts();
  const last = runs[runs.length - 1];
  if (last === undefined) {
    throw new Error("fixture 断言前置失败：账本内无 VerifyRan");
  }
  return last.runId;
}

/** 入账 UnitCreated + SpecSubmitted（直接 append——dispatch 层用例不测 spec 提交路径） */
function appendFrozenSpec(unitId: string, acceptance: AcceptanceItem[]): void {
  ledger.append("UnitCreated", { unitId, parentId: null, briefRef: "brief.md" });
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: "0".repeat(64),
    acceptance,
    contracts: [],
    split: [],
  });
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
}

/** 入账 build 证据（commit 锚 = 当前 HEAD；runId 递增唯一） */
function appendBuildEvidence(unitId: string, runId: string, commit: string): void {
  ledger.append("EvidenceSubmitted", {
    unitId,
    runId,
    commit,
    paths: [],
    sha256: [],
    exitCode: 0,
  });
}

// ---- runner 子进程（T3/T8）基建 ----

/** 断言中途失败时防 runner 子进程泄漏 */
const liveRunners = new Set<ChildProcess>();

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
    [CLI_PATH, "run", "--root", rootId, "--spawn", "human", "--poll-ms", "200", ...extraArgs],
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

/** 「人」真实调 CLI（同步子进程，与 runner 共享 cwd + CW_HOME 账本） */
function runCli(repoDir: string, args: readonly string[]): Captured {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
    timeout: 90_000,
  });
  if (res.error !== undefined) {
    throw new Error(`runCli ${args.join(" ")} 失败: ${res.error.message}`);
  }
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** T3/T8 场景仓库：fixture commit + root unit */
function makeRunnerScenario(name: string): string {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  git(repoDir, ["init"]);
  git(repoDir, ["config", "user.email", "cw-rv5@example.com"]);
  git(repoDir, ["config", "user.name", "cw-rv5"]);
  writeFileSync(join(repoDir, "brief.md"), "# rv5 flake 场景任务书\n");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", "fixture: base"]);
  expect(runCli(repoDir, ["create", "--id", "fdemo", "--brief", "brief.md"]).code).toBe(0);
  return repoDir;
}

/** 场景 spec 落盘 + 真实提交 + 过审（unit 进入 spec-frozen） */
function submitScenarioSpec(repoDir: string, e1Command: string): void {
  const spec = {
    acceptance: e2eSpecAcceptance(e1Command),
    contracts: [],
    split: [],
  };
  writeFileSync(join(repoDir, "spec-fdemo.json"), `${JSON.stringify(spec, null, 2)}\n`);
  expect(runCli(repoDir, ["evidence", "submit", "--kind", "spec", "--unit", "fdemo", "--file", "spec-fdemo.json"]).code).toBe(0);
  expect(runCli(repoDir, ["review", "submit", "--unit", "fdemo", "--verdict-kind", "spec-review", "--verdict", "pass", "--role", "reviewer"]).code).toBe(0);
}

/** 人在 root unit 的 worktree 里提交一批文件，返回新 commit hash */
function humanCommit(repoDir: string, unitId: string, files: Record<string, string>): string {
  const wtDir = worktreePath(WT_HOME, repoDir, unitId);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(wtDir, name), content);
  }
  git(wtDir, ["add", "-A"]);
  git(wtDir, ["commit", "-m", `human: ${Object.keys(files).join("+")}`]);
  return gitOut(wtDir, ["rev-parse", "HEAD"]);
}

/** 场景内全部 VerifyRan 事实（含 runId，供 stderr 指引断言） */
function scenarioVerifyRans(repoDir: string): VerifyRanFact[] {
  return new EventLedger(ledgerPath(cwHome, repoDir))
    .readAll()
    .filter((e) => e.type === "VerifyRan")
    .map((e) => {
      const p = e.payload as VerifyRanFact;
      return { runId: p.runId, result: p.result, acceptanceIds: p.acceptanceIds };
    });
}

/** 场景 frontier --json（真实 CLI 子进程——与 runner 派发同一出处） */
function scenarioFrontier(repoDir: string): FrontierJson {
  const res = runCli(repoDir, ["frontier", "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout) as FrontierJson;
}

/** 驱动到「两次 verify fail + flake 转人工」状态（T3/T8 共用前缀） */
async function driveToFlake(
  repoDir: string,
  runner: RunnerCapture,
): Promise<{ runIds: string[] }> {
  const dispatchLine = '派发 developer → unit "fdemo"';
  submitScenarioSpec(repoDir, "node e1.js");
  // developer 第 1 次派发后人进场：worktree 提交坏实现 + build 证据 + 第一次 verify
  await waitText(runner.stdoutText, dispatchLine, 180_000);
  const badCommit = humanCommit(repoDir, "fdemo", {
    "impl.js": implBad("E1"),
    "e1.js": e1File(),
    "u1check.js": u1CheckFile("E1"),
  });
  expect(
    runCli(repoDir, ["evidence", "submit", "--kind", "build", "--unit", "fdemo", "--commit", badCommit, "--run-id", "b1"]).code,
  ).toBe(0);
  const verify1 = runCli(repoDir, ["verify", "--unit", "fdemo"]);
  expect(verify1.code, `第一次 verify 应 fail（E1 FAIL）：${verify1.stderr}`).toBe(1);
  // developer 第 2 次派发（正常打回路径）后再挂一次——同条目连续第 2 次 fail
  await waitTextCount(runner.stdoutText, dispatchLine, 2, 120_000);
  const verify2 = runCli(repoDir, ["verify", "--unit", "fdemo"]);
  expect(verify2.code, `第二次 verify 应 fail（E1 FAIL）：${verify2.stderr}`).toBe(1);
  // 转人工指引出声（stderr）且不再派 developer——由调用方各自断言
  await waitText(runner.stderrText, "停止对该 unit 派发 developer", 180_000);
  const runs = scenarioVerifyRans(repoDir);
  expect(runs).toHaveLength(2);
  return { runIds: runs.map((r) => r.runId) };
}

/** 等待文本出现指定次数（dispatch 行计数同步点） */
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

// ================================================================
// T1 / T2：nondeterministic 声明豁免（dispatch 层，红阶段默认开启）
// ================================================================

/**
 * T1/T2 共用场景：seed → build（impl 好 + e1.js + u1check.js + flaky.js）。
 * A1 = 普通验收（build 树 pass / 红树因 impl 缺失而 fail = 有区分力）；
 * N1 = nondeterministic 验收（flaky.js 固定输出 N1 FAIL + exit 1——名字比对
 * 无法命中必过集合，无声明时该条必 fail 整体）。
 */
async function setupDeclaredScenario(): Promise<{ buildCommit: string }> {
  const [, build] = makeGitRepo(cwd, [
    { "seed.txt": "seed" },
    {
      "impl.js": implGood("A1"),
      "e1.js": e1File(),
      "u1check.js": u1CheckFile("A1"),
      "flaky.js": "console.log('N1 FAIL');\nprocess.exit(1);\n",
    },
  ]);
  // spec 走真实提交路径（schema + gate 全过——nondeterministic 字段被接受）
  ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
  const specFile = join(cwd, "spec.json");
  writeFileSync(
    specFile,
    `${JSON.stringify(
      {
        acceptance: [
          { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" },
          { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node e1.js" },
          {
            id: "N1",
            core: false,
            title: "随机行为观察",
            type: "e2e-real",
            command: "node flaky.js",
            nondeterministic: true,
          },
        ],
        contracts: [],
        split: [],
      },
      null,
      2,
    )}\n`,
  );
  const submit = await run(["evidence", "submit", "--kind", "spec", "--unit", "u-1", "--file", specFile]);
  expect(submit.code, `spec 提交应过 schema+gate（stderr: ${submit.stderr}）`).toBe(0);
  appendBuildEvidence("u-1", "run-1", build);
  return { buildCommit: build };
}

describe("T1 声明豁免两处：名字比对跳过 + 单次 fail 不 fail 整体", () => {
  it("N1 固定 fail 但 verify exit 0；report.json 结果照录 + nameSkipped 标注；红阶段跳过 N1 判定", async () => {
    await setupDeclaredScenario();

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code, `verify 应整体 pass（stderr: ${res.stderr}）`).toBe(0);
    expect(res.stdout).toContain("result=pass");

    // VerifyRan：整体 pass；N1 经豁免进入 pass 集（verified 判定的覆盖输入）
    const runs = verifyRanFacts();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toBe("pass");
    expect(runs[0]?.acceptanceIds).toEqual(["U1", "A1", "N1"]);

    // report.json：N1 原始结果照录（fail）+ 跳过标注 + 真实 exitCode；普通条目无标注
    const reportPath = join(evidenceDir(cwHome, cwd, "u-1", runs[0]?.runId ?? ""), "report.json");
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as {
      cases: Array<{ id: string; status: string; nameSkipped?: string; exitCode?: number }>;
      redPhase: Array<{ id: string; discriminative: boolean; reason: string }>;
    };
    const byId = new Map(report.cases.map((c) => [c.id, c]));
    expect(byId.get("A1")).toMatchObject({ status: "pass" });
    expect(byId.get("A1")?.nameSkipped).toBeUndefined();
    expect(byId.get("N1")).toMatchObject({
      id: "N1",
      status: "fail",
      nameSkipped: "nondeterministic",
      exitCode: 1,
    });
    // 红阶段（默认开启）：A1/U1 在旧树 fail = 有区分力；N1 跳过判定（原因注明）
    const redN1 = report.redPhase.find((e) => e.id === "N1");
    expect(redN1?.discriminative).toBe(true);
    expect(redN1?.reason).toContain("nondeterministic");
    expect(redN1?.reason).toContain("跳过");
  }, 60_000);
});

describe("T2 声明不逃逸执行：真跑真产物", () => {
  it("N1 的 command 真实执行——stdout/stderr/exitCode 产物齐备（非 skip 执行）", async () => {
    await setupDeclaredScenario();

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(0);
    const runId = lastVerifyRunId();
    const base = evidenceDir(cwHome, cwd, "u-1", runId);

    // stdout/stderr 产物真实落盘（命令真的跑了）
    expect(readFileSync(join(base, "N1.stdout"), "utf-8")).toContain("N1 FAIL");
    expect(existsSync(join(base, "N1.stderr"))).toBe(true);
    // 原始 fail 原因进 stderr（审计可读，非静默吞掉）
    expect(readFileSync(join(base, "N1.stderr"), "utf-8")).toContain("nondeterministic");
    // 逐条目 <id>.report.json（适配器折叠产物，含用例级 fail 事实与 exitCode）
    const itemReport = JSON.parse(readFileSync(join(base, "N1.report.json"), "utf-8")) as {
      exitCode: number;
      cases: Array<{ id: string; status: string }>;
    };
    expect(itemReport.exitCode).toBe(1);
    expect(itemReport.cases).toContainEqual({ id: "N1", name: "N1 FAIL", status: "fail" });
  }, 60_000);
});

// ================================================================
// T4 / T5 / T7：连挂投影口径（dispatch 层真实 verify + frontier --json）
// ================================================================

describe("T4 中间 pass 清零", () => {
  it("fail → pass → fail（同 spec 周期）→ 不出 flakeReview（连续性破坏）", async () => {
    const [, build1, build2, build3] = makeGitRepo(cwd, [
      { "seed.txt": "seed" },
      { "impl.js": implBad("E1"), "e1.js": e1File(), "u1check.js": u1CheckFile("E1") },
      { "impl.js": implGood("E1") },
      { "impl.js": implBad("E1") },
    ]);
    appendFrozenSpec("u-1", e2eSpecAcceptance("node e1.js"));

    // 证据逐次追加（verify 锚定最后一条 build 证据——三批证据前置会让三次
    // verify 全部锚定 build3，中间 pass 无从构造）
    appendBuildEvidence("u-1", "b1", build1);
    const v1 = await run(["verify", "--unit", "u-1"]);
    expect(v1.code).toBe(1); // E1 fail（streak 1）
    appendBuildEvidence("u-1", "b2", build2);
    const v2 = await run(["verify", "--unit", "u-1"]);
    expect(v2.code, `中间 pass 应 exit 0（stderr: ${v2.stderr}）`).toBe(0); // streak 清零
    appendBuildEvidence("u-1", "b3", build3);
    const v3 = await run(["verify", "--unit", "u-1"]);
    expect(v3.code).toBe(1); // 再次 fail（新 streak 仅 1）

    const groups = await frontierGroups();
    expect(groups.flakeReview).toEqual([]);
    // 中间 pass 使 unit 达成 verified（最后一条 pass VerifyRan 覆盖全部验收）——
    // 后续单次 fail 不回退状态、也不构成连挂
    expect(groups.execReviewReady).toContain("u-1");
    expect(verifyRanFacts().map((r) => r.result)).toEqual(["fail", "pass", "fail"]);
  }, 120_000);
});

describe("T5 unit 级不转人工", () => {
  it("unit 型验收连挂 2 次 → 无 flakeReview（正常打回路径继续：buildReady）", async () => {
    const [, build] = makeGitRepo(cwd, [
      { "seed.txt": "seed" },
      { "u5.js": "console.log('not json');\n" },
    ]);
    appendFrozenSpec("u-1", [
      // E1 自包含恒过（本用例焦点是 unit 级连挂不计 flake，红阶段无区分力导致的
      // 整体 fail 与 flake 投影正交——E1 恒在 pass 集，不产生连挂）
      { id: "E1", core: true, title: "应用可运行", type: "e2e-real", command: "node -e \"console.log('E1 PASS')\"" },
      { id: "U5", core: false, title: "单元级失败用例", type: "unit", command: "node u5.js" },
    ]);
    appendBuildEvidence("u-1", "b1", build);

    const v1 = await run(["verify", "--unit", "u-1"]);
    expect(v1.code).toBe(1); // U5 parse fail（vitest 产物非 JSON）
    const v2 = await run(["verify", "--unit", "u-1"]);
    expect(v2.code).toBe(1); // U5 连续第 2 次 fail

    // unit 级连挂不进 flake 投影（canon §5.2 只认 e2e 级）。mx5-2 起：U5 的形态
    // 是 vitest 产物解析失败（非断言失败）——连挂 2 次走 spec 契约回炉通道
    //（specContractBroken 派 designer 修 spec 命令契约；M4 gate 现场二同类
    // 形态），不再停留在 buildReady 等 developer 重派
    const groups = await frontierGroups();
    expect(groups.flakeReview).toEqual([]);
    expect(groups.specContractBroken).toContain("u-1");
    const runs = verifyRanFacts();
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => !r.acceptanceIds.includes("U5"))).toBe(true);
    expect(runs.every((r) => r.acceptanceIds.includes("E1"))).toBe(true);
  }, 60_000);
});

describe("T6 集成 fail 不计数", () => {
  it("integrate- 前缀 runId 的 VerifyRan fail ×2 → 不出 flakeReview", async () => {
    appendFrozenSpec("u-1", e2eSpecAcceptance("node e1.js"));
    // 集成 verify 的账本形态（loop 的 runIntegrationDispatch 写入）：integrate- 前缀
    // runId + result fail + 空 pass 集——连续 fail 但不参与 flake 计数
    ledger.append("VerifyRan", {
      unitId: "u-1",
      runId: "integrate-11111111-1111-4111-8111-111111111111",
      reportHash: "rh-1",
      result: "fail",
      acceptanceIds: [],
    });
    ledger.append("VerifyRan", {
      unitId: "u-1",
      runId: "integrate-22222222-2222-4222-8222-222222222222",
      reportHash: "rh-2",
      result: "fail",
      acceptanceIds: [],
    });

    const groups = await frontierGroups();
    expect(groups.flakeReview).toEqual([]);
    // 叶子节点正常推进路径不受影响
    expect(groups.buildReady).toContain("u-1");
  });
});

describe("T7 spec 变更清零", () => {
  it("连挂 1 次后重提 spec → 计数清零（再挂 1 次不出维度，第 2 次连续才出）", async () => {
    const [, build] = makeGitRepo(cwd, [
      { "seed.txt": "seed" },
      { "impl.js": implBad("E1"), "e1.js": e1File(), "u1check.js": u1CheckFile("E1") },
    ]);
    const acceptance = e2eSpecAcceptance("node e1.js");
    appendFrozenSpec("u-1", acceptance);
    appendBuildEvidence("u-1", "b1", build);

    const v1 = await run(["verify", "--unit", "u-1"]);
    expect(v1.code).toBe(1); // 周期 1 连挂 1 次（<2，不出维度）
    expect((await frontierGroups()).flakeReview).toEqual([]);

    // 重提 spec（周期锚 lastSpecSeq 重置）+ 重新过审 → 计数清零
    ledger.append("SpecSubmitted", {
      unitId: "u-1",
      specHash: "1".repeat(64),
      acceptance,
      contracts: [],
      split: [],
    });
    ledger.append("VerdictSubmitted", { unitId: "u-1", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });

    const v2 = await run(["verify", "--unit", "u-1"]);
    expect(v2.code).toBe(1); // 周期 2 连挂 1 次——旧周期的 1 次不累计
    expect((await frontierGroups()).flakeReview).toEqual([]);

    const v3 = await run(["verify", "--unit", "u-1"]);
    expect(v3.code).toBe(1); // 周期 2 连续第 2 次 → 维度出现
    const groups = await frontierGroups();
    expect(groups.flakeReview).toContain("u-1");
    expect(groups.buildReady).not.toContain("u-1");
  }, 120_000);
});

// ================================================================
// T3 / T8：human 模式 runner 子进程（转人工出口 + 人工处置自愈）
// ================================================================

describe("T3 e2e 连挂转人工（human 模式 E2E）", () => {
  runnerIt("两次 verify fail 后：flakeReview 维度出现、stderr 转人工指引、不再派 developer", async () => {
    const repoDir = makeRunnerScenario("t3-flake");
    // 空转上限收紧：转人工后无新事件，循环按「审计-不喂-idle」模式收束退出
    const runner = startRunner(repoDir, "fdemo", ["--max-idle-ms", "4000"]);
    const { runIds } = await driveToFlake(repoDir, runner);

    const code = await waitExit(runner, 90_000);
    expect(code).toBe(1); // 空转收束（转人工后无 machine 推进路径）

    const stderr = runner.stderrText();
    // 转人工指引：连挂用例 id + 两次 fail 的 runId + 人工判定动作
    expect(stderr).toContain("转人工");
    expect(stderr).toContain("验收 E1");
    expect(stderr).toContain(runIds[0] ?? "");
    expect(stderr).toContain(runIds[1] ?? "");
    expect(stderr).toContain("cw report --unit fdemo");
    expect(stderr).toContain("nondeterministic");
    // 不再派 developer：第 2 次 fail 后无第 3 次派发（循环空转到 idle 退出）
    const dispatchCount = runner.stdoutText().split('派发 developer → unit "fdemo"').length - 1;
    expect(dispatchCount).toBe(2);
    // frontier --json 出现 flakeReview 维度（与派发判定同一出处）
    expect(scenarioFrontier(repoDir).flakeReview).toContain("fdemo");
  }, 300_000);
});

describe("T8 人工处置自愈（flakeReview 消失、循环继续推进）", () => {
  runnerIt("按指引修复（修实现稳定 pass + 重提 build + verify pass）→ root closed、循环 exit 0", async () => {
    const repoDir = makeRunnerScenario("t8-recover");
    // 空转上限放宽：转人工后留人工处置窗口，处置写入账本即有进展
    const runner = startRunner(repoDir, "fdemo", ["--max-idle-ms", "60000"]);
    await driveToFlake(repoDir, runner);

    // 人工判定动作 ①：确认现状（flakeReview 可见）；②判定真 bug → 修实现
    expect(scenarioFrontier(repoDir).flakeReview).toContain("fdemo");
    const fixedCommit = humanCommit(repoDir, "fdemo", { "impl.js": implGood("E1") });
    expect(
      runCli(repoDir, ["evidence", "submit", "--kind", "build", "--unit", "fdemo", "--commit", fixedCommit, "--run-id", "b2"]).code,
    ).toBe(0);
    const verify = runCli(repoDir, ["verify", "--unit", "fdemo"]);
    expect(verify.code, `修复后 verify 应 pass（stdout: ${verify.stdout}，stderr: ${verify.stderr}）`).toBe(0);

    // verify pass 写入账本 → 连挂清零、投影自然消失、循环自愈推进 reviewer
    await waitText(runner.stdoutText, '派发 reviewer → unit "fdemo"', 120_000);
    expect(
      runCli(repoDir, ["review", "submit", "--unit", "fdemo", "--verdict-kind", "exec-review", "--verdict", "pass", "--evidence-refs", "b2"]).code,
    ).toBe(0);

    const code = await waitExit(runner, 90_000);
    expect(code).toBe(0);
    expect(runner.stdoutText()).toContain("已 closed");
    // flakeReview 维度消失（pass 清零 + unit 已越过推进点）
    const groups = scenarioFrontier(repoDir);
    expect(groups.flakeReview).toEqual([]);
    expect(groups.buildReady).toEqual([]);
  }, 300_000);
});

/**
 * fa-4 单测：nd 触发链的端到端补齐（设计《.tmp/design-fail-attribution.md》v6
 * §4 V2/V3 的 E2E 形态——fa4 R1 交付；实现侧三处文案升格双信号口径的回归锚）。
 *
 * 真实 dispatch 链路（fb2 V11 harness 范式照搬）：真实 CLI 子进程跑
 * `cw run --spawn human`，隔离 CW_HOME tmp 目录 + scratch git 仓 + 真实 worktree /
 * 事件账本 / 干净 checkout verify，零 mock。测试进程扮演被派发的 agent（designer
 * / developer / reviewer），human 适配器只打印指令并轮询账本等待进展。
 *
 * 场景（V2 → V3 连续链，同 topic 双叶 + 健康对照）：
 *   - 目标 unit "ua"：spec 含契约合法封装的无区分力验收 AC2（e2e-real 型
 *     scripts/check-types.sh——w2 事故形态：标记行合法产出使常规 run 健康 pass、
 *     parseError 不发生，但脚本对任何树都 pass → 红阶段基线树上照样 pass）；
 *   - 三轮「连挂 2 → designer 重提（内容可不变）→ 过审 → 再连挂 2」：
 *     第 1 轮后 specContractBroken（代数 1 < 2，V3 防阈值漂移断言点）、
 *     第 2 轮后仍 Broken（代数已达 2 前的最后一次回炉）、第 3 轮后
 *     specContractDeadlock 停派出声（新双信号文案 = 本波 D-1 交付物）；
 *   - 健康对照 unit "ub"：普通实现 + verify pass + exec-review pass → closed，
 *     全程照常派发流转（V3「无对照该断言空转」）。
 *
 * 断言点对照设计 §4 原文：
 *   V2：两次 VerifyRan 的 parseFailedAcceptanceIds 均缺省（纯 nd 路径排假阳性）
 *       且第 2 次携带 nonDiscriminativeAcceptanceIds；specContractBroken 派
 *       designer（回炉任务书内嵌两轮红阶段 reason 原文）；账本全程 buildCount
 *       峰值 = 2、buildDrift 维度未出现；flakeReview 未出现；新 spec 入账后连挂
 *       清零、回炉代数 = 1。
 *   V3：gen=1 时再连挂仍 Broken（派 designer 而非停派——防阈值漂移）；gen=2 后
 *       再连挂 → specContractDeadlock 停派 + 双信号转人工指引出声；健康对照
 *       全程照常流转。
 *
 * U1 副作用记档：ua 的 unit 级验收（node u1check.js 读 impl.js）自第 2 次 verify
 * 起基线树也含 impl.js → 同判无区分力入 nd 清单——不破坏 AC2 主链（streaks 并集
 * 语义），断言按 contains 而非全等容纳。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { fold } from "../src/core/fold.js";
import type {
  DiscriminatedEvent,
  LedgerEvent,
  VerifyRanPayload,
} from "../src/events/types.js";
import { specContractFacts } from "../src/readonly/frontier.js";
import { unitStatus } from "../src/readonly/load.js";
import { EventLedger } from "../src/store/events-log.js";
import { evidenceDir, ledgerPath, worktreePath } from "../src/store/project.js";
import { REPORT_FILE_NAME } from "../src/verify/run.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = join(REPO_ROOT, "dist", "cli.js");

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "cw-fa4-")));
const cwHome = join(tmpRoot, "home");
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  delete process.env.CW_WORKTREE_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---- 基建（fb2 V11 harness 范式照搬） ----

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8", timeout: 30_000 });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.error?.message ?? res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

function runCli(repoDir: string, args: readonly string[]): Captured {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome, CW_WORKTREE_HOME: WT_HOME },
    timeout: 90_000,
  });
  if (res.error !== undefined) {
    throw new Error(`runCli ${args.join(" ")} 失败: ${res.error.message}`);
  }
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * 真实 tmp git 仓（单 commit fixture）。w2 形态的封装脚本与 U1 检查器都在
 * fixture commit 内：worktree 分支从 repo HEAD 起，各 developer 轮的 build
 * commit 以其为（或以更早轮 commit 为）第一父——红阶段基线树永远能跑
 * scripts/check-types.sh（恒 pass → 无区分力），u1check.js 则因 impl.js 缺席
 * 而失败（第 1 轮有区分力；后续轮基线含 impl.js 后同判 nd，见文件头记档）。
 */
function makeRepo(): string {
  const base = join(tmpRoot, "fa4-main");
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-fa4@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-fa4"]);
  writeFileSync(join(repoDir, "brief.md"), "# fa4 nd 契约回炉端到端\n");
  // w2 形态封装：标记行首列与验收 id 逐字一致（e2e-sh 既有契约），命令合法、
  // 对任何树恒 pass——红阶段判基线树上照样 pass 的无区分力条目
  mkdirSync(join(repoDir, "scripts"), { recursive: true });
  writeFileSync(
    join(repoDir, "scripts", "check-types.sh"),
    '#!/bin/sh\necho "AC2 PASS"\n',
  );
  chmodSync(join(repoDir, "scripts", "check-types.sh"), 0o755);
  // U1（unit 级，规则⑤）：vitest JSON 形态，读 impl.js 判实现在场
  writeFileSync(
    join(repoDir, "u1check.js"),
    [
      "const fs = require('fs');",
      "let ok = false;",
      "try { ok = fs.readFileSync(__dirname + '/impl.js', 'utf8').includes('E1 PASS'); } catch (e) { ok = false; }",
      "console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'U1 smoke',status: ok ? 'passed' : 'failed'}]}]}));",
      "if (!ok) { console.error('impl not good'); process.exit(1); }",
      "",
    ].join("\n"),
  );
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief + wrapped typecheck + unit checker"]);
  return repoDir;
}

/** ua 的病态 spec：AC2（core e2e-real，封装脚本）+ U1（unit 级，规则⑤） */
function ndAcceptance() {
  return [
    { id: "AC2", core: true, title: "类型装配成立", type: "e2e-real" as const, command: "scripts/check-types.sh" },
    { id: "U1", core: false, title: "单元冒烟", type: "unit" as const, command: "node u1check.js" },
  ];
}

/** ub（健康对照）的普通 spec：E1（core e2e-real）+ U1（unit 级） */
function healthyAcceptance() {
  return [
    { id: "E1", core: true, title: "应用可运行", type: "e2e-real" as const, command: "node e1.js" },
    { id: "U1", core: false, title: "单元冒烟", type: "unit" as const, command: "node u1check.js" },
  ];
}

function writeSpecFile(repoDir: string, fileName: string, acceptance: ReturnType<typeof ndAcceptance>, splitUnitIds: readonly string[]): void {
  writeFileSync(
    join(repoDir, fileName),
    `${JSON.stringify({ acceptance, contracts: [], split: splitUnitIds.map((unitId) => ({ unitId, dependsOn: [] })) }, null, 2)}\n`,
  );
}

function submitSpec(repoDir: string, unitId: string, fileName: string, acceptance: ReturnType<typeof ndAcceptance>, splitUnitIds: readonly string[]): void {
  writeSpecFile(repoDir, fileName, acceptance, splitUnitIds);
  expect(runCli(repoDir, ["evidence", "submit", "--kind", "spec", "--unit", unitId, "--file", fileName]).code, `${fileName} 应过 schema+gate`).toBe(0);
  expect(
    runCli(repoDir, ["review", "submit", "--unit", unitId, "--verdict-kind", "spec-review", "--verdict", "pass", "--role", "reviewer"]).code,
    `${unitId} 首版 spec 过审应入账`,
  ).toBe(0);
}

/**
 * 回炉重提（仅提交 spec，不代交 review）：runner 在场的链路里 spec-review 必须等
 * 独立 reviewer spawn 派发后由测试进程提交——提前入账会触发抢答警告，且 verdict
 * 早于 reviewer spawn 基线 seq 会让该 spawn 永不结算、卡死同 unit 后续派发
 */
function submitReworkSpec(repoDir: string, unitId: string, fileName: string, acceptance: ReturnType<typeof ndAcceptance>): void {
  writeSpecFile(repoDir, fileName, acceptance, []);
  expect(runCli(repoDir, ["evidence", "submit", "--kind", "spec", "--unit", unitId, "--file", fileName]).code, `${fileName} 重提要过 schema+gate`).toBe(0);
}

function commitFiles(dir: string, files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  gitRun(dir, ["add", "-A"]);
  gitRun(dir, ["commit", "-m", `fixture: ${Object.keys(files).join("+")}`]);
  return gitRun(dir, ["rev-parse", "HEAD"]);
}

// ---- runner 子进程基建（fb2 同款） ----

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

function startRunner(repoDir: string, rootId: string): RunnerCapture {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const child = spawn(
    process.execPath,
    [CLI_PATH, "run", "--root", rootId, "--spawn", "human", "--poll-ms", "150", "--max-idle-ms", "30000"],
    { cwd: repoDir, env: { ...process.env, CW_HOME: cwHome, CW_WORKTREE_HOME: WT_HOME }, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (chunk: Buffer) => outChunks.push(chunk.toString("utf-8")));
  child.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk.toString("utf-8")));
  liveRunners.add(child);
  child.on("exit", () => {
    liveRunners.delete(child);
  });
  return { child, stdoutText: () => outChunks.join(""), stderrText: () => errChunks.join("") };
}

async function waitText(readText: () => string, needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!readText().includes(needle)) {
    if (Date.now() > deadline) {
      throw new Error(`等待文本 "${needle}" 超时（${timeoutMs}ms）。当前文本末尾：${readText().slice(-600)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitCount(readText: () => string, needle: string, count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (countOf(readText(), needle) < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `等待文本 "${needle}" 第 ${count} 次出现超时（${timeoutMs}ms，当前 ${countOf(readText(), needle)} 次）。当前文本末尾：${readText().slice(-600)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- 账本读取助手（投影级断言的取数） ----

function eventsOf(repoDir: string): LedgerEvent[] {
  return new EventLedger(ledgerPath(cwHome, repoDir)).readAll();
}

function verifyRansOf(repoDir: string, unitId: string): VerifyRanPayload[] {
  return eventsOf(repoDir)
    .filter((record) => {
      const event = record as DiscriminatedEvent;
      return event.type === "VerifyRan" && event.payload.unitId === unitId && !event.payload.runId.startsWith("integrate-");
    })
    .map((record) => (record as DiscriminatedEvent).payload as VerifyRanPayload);
}

/** 每 spec 周期（SpecSubmitted 边界）内的 build 证据（EvidenceSubmitted）计数——V2「buildCount 峰值」断言取数 */
function buildCountsPerCycle(repoDir: string, unitId: string): number[] {
  const counts: number[] = [];
  for (const record of eventsOf(repoDir)) {
    const event = record as DiscriminatedEvent;
    if (event.type === "SpecSubmitted" && event.payload.unitId === unitId) {
      counts.push(0);
    } else if (event.type === "EvidenceSubmitted" && event.payload.unitId === unitId) {
      if (counts.length > 0) {
        counts[counts.length - 1] += 1;
      }
    }
  }
  return counts;
}

/** 该 unitId 最后一次派发行里的 brief 路径（`（worktree: …，brief: <path>）` 尾段解析） */
function lastBriefPath(stdoutText: string, unitId: string, role: string): string {
  const lines = stdoutText.split("\n").filter((line) => line.includes(`派发 ${role} → unit "${unitId}"`));
  const last = lines[lines.length - 1];
  expect(last, `应有 ${role} → unit "${unitId}" 的派发行`).toBeDefined();
  const match = /brief: (.+?)）\s*$/.exec(last ?? "");
  expect(match, `派发行应含 brief 路径：${last ?? ""}`).not.toBeNull();
  return match?.[1] ?? "";
}

/** 读某 verify runId 目录顶层 report.json 的 redPhase 节内指定 id 的 reason 原文 */
function redPhaseReasonOfRun(repoDir: string, unitId: string, runId: string, acceptanceId: string): string {
  const reportPath = join(evidenceDir(cwHome, repoDir, unitId, runId), REPORT_FILE_NAME);
  const parsed: unknown = JSON.parse(readFileSync(reportPath, "utf-8"));
  expect(typeof parsed === "object" && parsed !== null, `${reportPath} 应为 JSON 对象`).toBe(true);
  const redPhase = (parsed as Record<string, unknown>).redPhase;
  expect(Array.isArray(redPhase), `${reportPath} 应含 redPhase 数组节（fa-3 D5 落盘口径）`).toBe(true);
  for (const entry of redPhase as unknown[]) {
    if (typeof entry === "object" && entry !== null) {
      const e = entry as Record<string, unknown>;
      if (e.id === acceptanceId && typeof e.reason === "string") {
        return e.reason;
      }
    }
  }
  throw new Error(`${reportPath} redPhase 节缺 ${acceptanceId} 条目`);
}

// ================================================================
// V2 + V3 主场景：nd 连挂 → Broken 回炉 ×2 代 → Deadlock 停派（健康对照照常流转）
// ================================================================

describe("V2/V3 nd 触发链端到端", () => {
  it(
    "契约合法封装 nd 验收 → 2 连挂 Broken 派 designer（任务书内嵌 redPhase 原文）→ 2 代回炉 → deadlock 双信号停派；ub 对照全程照常流转",
    async () => {
      const repoDir = makeRepo();
      expect(runCli(repoDir, ["create", "--id", "fr", "--brief", "brief.md"]).code).toBe(0);
      expect(runCli(repoDir, ["create", "--id", "ua", "--brief", "brief.md", "--parent", "fr"]).code).toBe(0);
      expect(runCli(repoDir, ["create", "--id", "ub", "--brief", "brief.md", "--parent", "fr"]).code).toBe(0);
      submitSpec(repoDir, "fr", "spec-fr.json", healthyAcceptance(), ["ua", "ub"]);
      submitSpec(repoDir, "ua", "spec-ua.json", ndAcceptance(), []);
      submitSpec(repoDir, "ub", "spec-ub.json", healthyAcceptance(), []);

      const runner = startRunner(repoDir, "fr");
      const devUa = '派发 developer → unit "ua"';
      const desUa = '派发 designer → unit "ua"';
      const revUa = '派发 reviewer → unit "ua"';

      await waitText(runner.stdoutText, devUa, 60_000);
      await waitText(runner.stdoutText, '派发 developer → unit "ub"', 60_000);

      // ---- 健康对照 ub：全程照常流转（build → verify pass → exec-review → closed）----
      const wtUb = worktreePath(WT_HOME, repoDir, "ub");
      const commitUb = commitFiles(wtUb, {
        "impl.js": "console.log('E1 PASS');\n",
        "e1.js": "require('./impl.js');\n",
      });
      expect(
        runCli(repoDir, ["evidence", "submit", "--kind", "build", "--unit", "ub", "--commit", commitUb, "--run-id", "ub-b1"]).code,
      ).toBe(0);
      const verifyUb = runCli(repoDir, ["verify", "--unit", "ub"]);
      expect(verifyUb.code, `ub 的 verify 应 pass：${verifyUb.stderr}`).toBe(0);
      await waitText(runner.stdoutText, '派发 reviewer → unit "ub"', 60_000);
      expect(
        runCli(repoDir, [
          "review", "submit", "--unit", "ub", "--verdict-kind", "exec-review", "--verdict", "pass",
          "--role", "reviewer", "--comment", "对照通过", "--evidence-refs", "ub-b1",
        ]).code,
      ).toBe(0);
      const ubUnit = fold(eventsOf(repoDir)).units.get("ub");
      if (ubUnit === undefined) {
        throw new Error("ub 不在投影内");
      }
      expect(unitStatus(ubUnit), "健康对照应走完 exec-review 到 closed").toBe("closed");

      // ---- helper：ua 的一轮 developer 迭代（commit → build 证据 → verify nd-fail）----
      const wtUa = worktreePath(WT_HOME, repoDir, "ua");
      const uaRound = (n: number): void => {
        const commit = commitFiles(wtUa, n === 1 ? { "impl.js": "console.log('E1 PASS');\n" } : { [`ua-r${n}.txt`]: `round ${n}\n` });
        expect(
          runCli(repoDir, ["evidence", "submit", "--kind", "build", "--unit", "ua", "--commit", commit, "--run-id", `ua-b${n}`]).code,
          `ua 第 ${n} 轮 build 证据应入账`,
        ).toBe(0);
        const verify = runCli(repoDir, ["verify", "--unit", "ua"]);
        expect(verify.code, `ua 第 ${n} 轮 verify 应 fail 入账（红阶段 nd 单列即致）：${verify.stderr}`).toBe(1);
      };

      // ---- V2：周期 1 两连挂（纯 nd 路径）----
      uaRound(1);
      let rans = verifyRansOf(repoDir, "ua");
      expect(rans, "周期 1 第 1 次 verify 后恰 1 条 VerifyRan").toHaveLength(1);
      expect(rans[0]?.parseFailedAcceptanceIds ?? [], "V2 断言：parseFailedAcceptanceIds 缺省（纯 nd 路径，排假阳性）").toEqual([]);
      expect(rans[0]?.nonDiscriminativeAcceptanceIds ?? []).toContain("AC2");

      await waitCount(runner.stdoutText, devUa, 2, 60_000); // streak 1 <2 → buildReady 重派
      uaRound(2);

      rans = verifyRansOf(repoDir, "ua");
      expect(rans, "V2 断言：两次 VerifyRan").toHaveLength(2);
      for (const ran of rans) {
        expect(ran.parseFailedAcceptanceIds ?? [], "V2 断言：两次 verify 的 parseFailedAcceptanceIds 均缺省").toEqual([]);
      }
      expect(rans[1]?.nonDiscriminativeAcceptanceIds ?? [], "V2 断言：第 2 次携带 nonDiscriminativeAcceptanceIds").toContain("AC2");
      // V2 断言：账本全程 buildCount 峰值 = 2（每轮一条 build 证据；本周期恰 2 条）
      expect(buildCountsPerCycle(repoDir, "ua")).toEqual([2]);
      // V2 断言：预算不烧——buildDrift / flakeReview 通道均未出声
      expect(runner.stderrText(), "buildDrift 维度未出现").not.toContain("的 build 证据已达");
      expect(runner.stderrText(), "flakeReview 未出现").not.toContain("e2e 验收连挂 2 次以上（flake 疑似）");

      // V2 断言：specContractBroken 派 designer 回炉（代数 0 <2，非 deadlock）
      await waitText(runner.stdoutText, desUa, 60_000);
      const factsBroken1 = specContractFacts(eventsOf(repoDir)).get("ua");
      expect(factsBroken1?.generations, "Broken 触发时代数尚为 0").toBe(0);
      expect(factsBroken1?.streaks.map((s) => s.acceptanceId)).toContain("AC2");
      // V2 断言：回炉任务书内嵌两轮红阶段 reason 原文（机器可检——brief 逐字含
      // 各 runId 的 report.json redPhase 节 reason）+ nd 专属指引块在场
      const brief1 = readFileSync(lastBriefPath(runner.stdoutText(), "ua", "designer"), "utf-8");
      for (const ran of rans) {
        const reason = redPhaseReasonOfRun(repoDir, "ua", ran.runId, "AC2");
        expect(brief1, `任务书应内嵌 ${ran.runId} 的 redPhase reason 原文`).toContain(
          `验收 AC2（runId=${ran.runId}，信号=无区分力）：${reason}`,
        );
      }
      expect(brief1).toContain("先核查 build commit 结构");

      // ---- V2 收尾 + V3 第 1 档：重提（内容可不变）→ 过审 → 连挂清零、代数 1 ----
      submitReworkSpec(repoDir, "ua", "spec-ua-r1.json", ndAcceptance());
      await waitText(runner.stdoutText, revUa, 60_000);
      expect(
        runCli(repoDir, ["review", "submit", "--unit", "ua", "--verdict-kind", "spec-review", "--verdict", "pass", "--role", "reviewer"]).code,
        "重提 spec 由独立 reviewer 过审（human 链路：等派发后提交，verdict 晚于 spawn 基线才能结算）",
      ).toBe(0);
      const factsGen1 = specContractFacts(eventsOf(repoDir)).get("ua");
      expect(factsGen1?.generations, "V2 断言：新 spec 入账后回炉代数 = 1").toBe(1);
      expect(factsGen1?.streaks, "V2 断言：新 spec 入账后连挂清零").toEqual([]);

      // ---- V3：周期 2 再两连挂 → 仍 specContractBroken（gen=1 <2，防阈值漂移）----
      await waitCount(runner.stdoutText, devUa, 3, 60_000);
      uaRound(3);
      await waitCount(runner.stdoutText, devUa, 4, 60_000);
      uaRound(4);
      await waitCount(runner.stdoutText, desUa, 2, 60_000);
      const factsBroken2 = specContractFacts(eventsOf(repoDir)).get("ua");
      expect(factsBroken2?.generations, "第 2 次 Broken 触发时仍 gen=1（未达 deadlock 阈值）").toBe(1);
      expect(factsBroken2?.streaks.map((s) => s.acceptanceId)).toContain("AC2");

      // ---- V3：第 2 次重提（gen=2）→ 周期 3 再两连挂 → specContractDeadlock ----
      submitReworkSpec(repoDir, "ua", "spec-ua-r2.json", ndAcceptance());
      await waitCount(runner.stdoutText, revUa, 2, 60_000);
      expect(
        runCli(repoDir, ["review", "submit", "--unit", "ua", "--verdict-kind", "spec-review", "--verdict", "pass", "--role", "reviewer"]).code,
      ).toBe(0);
      expect(specContractFacts(eventsOf(repoDir)).get("ua")?.generations, "第 2 次重提后回炉代数 = 2").toBe(2);

      await waitCount(runner.stdoutText, devUa, 5, 60_000);
      uaRound(5);
      await waitCount(runner.stdoutText, devUa, 6, 60_000);
      uaRound(6);

      // V3 断言：deadlock 停派出声——新双信号口径（D-1 交付物）逐字在场
      await waitText(runner.stderrText, "的验收命令确定性缺陷信号（解析失败 / 无区分力）已 2 代回炉仍连挂 ≥2", 60_000);
      await waitText(runner.stderrText, "无区分力读同 runId 目录顶层 report.json 的 redPhase 节", 10_000);
      const cycle3Runs = verifyRansOf(repoDir, "ua").slice(4);
      expect(cycle3Runs).toHaveLength(2);
      expect(
        runner.stderrText(),
        "deadlock 事实行应列出周期 3 的连挂 runId（双信号口径）",
      ).toContain(
        `验收 AC2：当前 spec 周期内连续 2 次确定性缺陷信号（解析失败 / 无区分力，runId：${cycle3Runs.map((r) => r.runId).join("、")}）`,
      );
      expect(runner.stderrText(), "转人工指引应附人工闭环句").toContain("人工闭环顺序：重提 spec → 独立 spec-review");
      expect(runner.stderrText(), "全程零 flake 出声（nd 排除通道）").not.toContain("e2e 验收连挂 2 次以上（flake 疑似）");
      expect(runner.stderrText(), "全程零 buildDrift 出声（预算不烧）").not.toContain("的 build 证据已达");

      // V3 断言：停派——观察窗（≥8 个 poll 周期）内 ua 无新派发（developer 6 / designer 2 封顶）
      await sleep(1_500);
      expect(countOf(runner.stdoutText(), devUa), "deadlock 后不再派 developer").toBe(6);
      expect(countOf(runner.stdoutText(), desUa), "deadlock 后不再派 designer（回炉出口关闭）").toBe(2);
      expect(specContractFacts(eventsOf(repoDir)).get("ua")?.generations).toBe(2);
      expect(verifyRansOf(repoDir, "ua"), "全程恰 6 次 verify（V2+V3 设计口径）").toHaveLength(6);
      expect(buildCountsPerCycle(repoDir, "ua"), "三个 spec 周期各恰 2 条 build 证据（峰值 2，预算不烧）").toEqual([2, 2, 2]);

      runner.child.kill("SIGKILL");
    },
    240_000,
  );
});

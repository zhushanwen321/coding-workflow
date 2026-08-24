/**
 * mx-1 单测：独立 spec-review 派发（异源 reviewer）——mx1-acceptance §5 T1-T6。
 * 真实 runner 子进程（node dist/cli.js run --spawn human）+ 直调 runLoop 的脚本
 * 适配器（spawn 真实 node worker），真实 git 子进程 + tmp 目录 + 隔离 CW_HOME，
 * 零 mock。
 *
 *   T1 打回循环全链（human E2E）：designer 提 spec → 独立 reviewer 派发（brief
 *      含 attachments 绝对路径可解析）→ 人扮演 reviewer 提交 fail → specFixPending
 *      派 designer（任务书含 fail comment 全文、不含 review submit）→ 新 spec →
 *      reviewer pass → spec-frozen；verdict 事件 ts 晚于 reviewer brief mtime
 *   T2 deadlock（mx3 语义变化：按打回代数计数）——形态①「不重提的两连 fail」
 *      同代只计 1 次打回，不再 deadlock（specFixPending 正常派 designer，见
 *      mx3-generation-count G1）；形态②「fail → 重提（改 1 字节）→ fail」= 2 代
 *      打回，保持 specReviewDeadlock + escalation 含各代 comment 摘要 + 停止派发
 *      （mx4 迁移：默认预算 10，形态② runner 注入 --max-spec-rejects 2 快速构造）
 *   T3 抢答警告：无 in-flight reviewer 时人为提交 spec-review verdict → stderr
 *      警告行（不阻断，循环继续）
 *   T4 派发 gate：designer spawn 存活期间（慢完成信号）frontier 已出现
 *      specReviewPending 但不派 reviewer；designer 结算后下轮才派
 *   T5 exec-review 文案修复回归：loop 的 exec-review 任务书与 human-loop 指令
 *      均含 --evidence-refs；按模板执行的全链收敛 closed 不被 refs 校验卡住
 *   T6 role 字段：--role reviewer 入账 payload.role；--role boss 拒绝含恢复动作；
 *      缺省无 role 键
 *
 * 注意：runner 子进程 / 直调 runLoop 用例依赖 dist（先 npm run build；npm test 的
 * pretest 已含）；dist 缺席时对应用例以 it.todo 挂起（rv5 同款条件激活模式）。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
} from "../dist/runner/spawn/types.js";
import { fold } from "../src/core/fold.js";
import type { AcceptanceItem } from "../src/events/types.js";
import { buildStepInstruction } from "../src/runner/human-loop.js";
import { EventLedger } from "../src/store/events-log.js";
import { attachmentsDir, encodeCwd, ledgerPath } from "../src/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const CLI_PATH = join(DIST_ROOT, "cli.js");
const HUMAN_ADAPTER_DIST = join(DIST_ROOT, "runner", "spawn", "human.js");
const LOOP_DIST = join(DIST_ROOT, "runner", "loop.js");
/** runner 子进程 / runLoop 直调用例：dist 缺席时挂起（pretest build 后自动激活） */
const distIt =
  existsSync(CLI_PATH) && existsSync(HUMAN_ADAPTER_DIST) && existsSync(LOOP_DIST)
    ? it
    : it.todo;

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-mx1-"));
const cwHome = join(tmpRoot, "home");
const originalCwHome = process.env.CW_HOME;
process.env.CW_HOME = cwHome;
// runner 派发 workdir 迁 unit worktree（隔离 worktree 根，u7 同款）
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  for (const child of liveRunners) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
  if (originalCwHome === undefined) {
    delete process.env.CW_HOME;
  } else {
    process.env.CW_HOME = originalCwHome;
  }
  delete process.env.CW_WORKTREE_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---- 公共 fixture ----

/** 过 spec gate 五规则的验收（T1/T2/T3 的 spec 提交物） */
const ACCEPTANCE: readonly AcceptanceItem[] = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
];

function specJson(acceptance: readonly AcceptanceItem[]): string {
  return `${JSON.stringify({ acceptance, contracts: [], split: [] }, null, 2)}\n`;
}

function git(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", timeout: 30_000 });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.error?.message ?? res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 真实 tmp git 仓库（init + brief commit）+ 经 CLI 创建的 root unit */
function makeScenario(name: string, rootId: string): string {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  git(repoDir, ["init"]);
  git(repoDir, ["config", "user.email", "cw-mx1@example.com"]);
  git(repoDir, ["config", "user.name", "cw-mx1"]);
  writeFileSync(join(repoDir, "brief.md"), `# ${rootId} 任务书（mx1 fixture）\n`);
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", "fixture: brief"]);
  const res = runCli(repoDir, ["create", "--id", rootId, "--brief", "brief.md"]);
  expect(res.code, `cw create 应成功（stderr: ${res.stderr}）`).toBe(0);
  return repoDir;
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/** 「人」真实调 CLI（同步子进程，与 runner 共享 cwd + CW_HOME 账本） */
function runCli(repoDir: string, args: readonly string[]): Captured {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
    timeout: 90_000,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// ---- runner 子进程基建（rv5 同款） ----

const liveRunners = new Set<ChildProcess>();

interface RunnerCapture {
  child: ChildProcess;
  stdoutText(): string;
  stderrText(): string;
}

function startRunner(repoDir: string, rootId: string, extraArgs: readonly string[]): RunnerCapture {
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

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

/** 等待文本出现指定次数（同 unit 同 role 的多次派发行需按计数同步） */
async function waitCountText(
  readText: () => string,
  needle: string,
  count: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (occurrences(readText(), needle) < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `等待文本 "${needle}" 出现 ${count} 次超时（当前 ${occurrences(readText(), needle)} 次）。` +
          `文本末尾：${readText().slice(-600)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** fx-4：本 root 的 topic run 目录（单 run 场景下唯一；不唯一即抛 fixture 前置失败） */
function findTopicDir(repoDir: string, rootId: string): string {
  const topicRoot = join(cwHome, "topic", encodeCwd(repoDir));
  const entries = existsSync(topicRoot) ? readdirSync(topicRoot).sort() : [];
  const hits = entries.filter((name) => name.endsWith(`-${rootId}`) || name.includes(`-${rootId}-`));
  if (hits.length !== 1) {
    throw new Error(`topic run 目录不唯一（rootId=${rootId}）：${hits.join(", ") || "(无)"}`);
  }
  return join(topicRoot, hits[0]!);
}

function ledgerOf(repoDir: string): EventLedger {
  return new EventLedger(ledgerPath(cwHome, repoDir));
}

/** 提交 spec（真实 CLI 路径：schema 校验 + gate 五规则 + 原文副本落 attachments） */
function submitSpec(repoDir: string, unitId: string, acceptance: readonly AcceptanceItem[], file: string): void {
  writeFileSync(join(repoDir, file), specJson(acceptance));
  const res = runCli(repoDir, [
    "evidence",
    "submit",
    "--kind",
    "spec",
    "--unit",
    unitId,
    "--file",
    file,
  ]);
  expect(res.code, `spec 提交应过 schema+gate（stderr: ${res.stderr}）`).toBe(0);
}

// ================================================================
// T1：打回循环全链（human E2E）
// ================================================================

describe("mx-1 T1 打回循环全链：reviewer fail → specFixPending 派 designer → 修 spec → reviewer pass", () => {
  distIt("全链：designer 提 spec → 独立 reviewer（brief 含 attachments 绝对路径）→ fail 打回 → designer 修（无 review submit）→ pass → spec-frozen", async () => {
    const repoDir = makeScenario("t1-fullchain", "demo");
    const runner = startRunner(repoDir, "demo", ["--max-idle-ms", "60000"]);
    try {
      await waitText(runner.stdoutText, '派发 designer → unit "demo"', 60_000);
      // 人扮演 designer：提 spec（不自审）
      submitSpec(repoDir, "demo", ACCEPTANCE, "spec-demo-v1.json");

      // 独立 reviewer 派发（specReviewPending）：brief 含 attachments 绝对路径且可解析
      await waitText(runner.stdoutText, '派发 reviewer → unit "demo"', 60_000);
      const topic1 = findTopicDir(repoDir, "demo");
      const reviewerBrief1 = readFileSync(join(topic1, "demo.reviewer.brief.md"), "utf-8");
      const attachDir = attachmentsDir(cwHome, repoDir, "demo");
      expect(reviewerBrief1).toContain(attachDir);
      expect(existsSync(attachDir), "spec 原文副本目录应存在（evidence submit 落盘）").toBe(true);
      expect(reviewerBrief1).toContain("--verdict-kind spec-review");
      expect(reviewerBrief1).toContain("--role reviewer");

      // 人扮演 reviewer：fail（comment 含不合格项——specFixPending 任务书的失败事实来源）
      const fail1 = runCli(repoDir, [
        "review",
        "submit",
        "--unit",
        "demo",
        "--verdict-kind",
        "spec-review",
        "--verdict",
        "fail",
        "--comment",
        "不合格项：验收缺 A3 单元级回归用例；恢复动作：补 A3 后重提",
        "--role",
        "reviewer",
      ]);
      expect(fail1.code, `fail verdict 应入账（stderr: ${fail1.stderr}）`).toBe(0);

      // specFixPending 派 designer：任务书内嵌 fail comment 全文、不含 review submit 字样
      await waitCountText(runner.stdoutText, '派发 designer → unit "demo"', 2, 10_000);
      const designerBrief2 = readFileSync(join(findTopicDir(repoDir, "demo"), "demo.designer.brief.md"), "utf-8");
      expect(designerBrief2).toContain("按 spec-review 打回意见修 spec");
      expect(designerBrief2).toContain("不合格项：验收缺 A3 单元级回归用例");
      expect(designerBrief2).not.toContain("review submit");
      // human designer 指令输出（appended 全文）同样不含 review submit（A2 双产物断言之二）
      const designerInstructions = readFileSync(
        join(findTopicDir(repoDir, "demo"), "demo.designer.stdout"),
        "utf-8",
      );
      expect(designerInstructions).not.toContain("review submit");

      // 人扮演 designer：修 spec 重提（改 1 字节——title 追加序号）
      const revised: AcceptanceItem[] = ACCEPTANCE.map((a) =>
        a.id === "A2" ? { ...a, title: "单元级冒烟v2" } : a,
      );
      submitSpec(repoDir, "demo", revised, "spec-demo-v2.json");

      // 回流 specReviewPending：第 2 次独立 reviewer 派发
      await waitCountText(runner.stdoutText, '派发 reviewer → unit "demo"', 2, 10_000);
      // 等第 2 次 reviewer 指令块落盘（append 后文件含两个指令块头部）
      const reviewerStdout = join(findTopicDir(repoDir, "demo"), "demo.reviewer.stdout");
      await waitCountText(() => readFileSync(reviewerStdout, "utf-8"), "reviewer 指令", 2, 10_000);
      const reviewerBriefMtime = statSync(join(findTopicDir(repoDir, "demo"), "demo.reviewer.brief.md")).mtimeMs;

      // 人扮演 reviewer：pass（时序锚：verdict ts 必须晚于 reviewer brief mtime）
      const pass1 = runCli(repoDir, [
        "review",
        "submit",
        "--unit",
        "demo",
        "--verdict-kind",
        "spec-review",
        "--verdict",
        "pass",
        "--comment",
        "A3 缺口已补（v2 spec）",
        "--role",
        "reviewer",
      ]);
      expect(pass1.code, `pass verdict 应入账（stderr: ${pass1.stderr}）`).toBe(0);

      // spec-frozen（打回循环收敛）
      const status = runCli(repoDir, ["status"]);
      expect(status.stdout).toMatch(/demo\s+spec-frozen/);

      // 账本断言：两条 spec-review verdict 均带自报 role=reviewer（非 designer 自审）
      const verdicts = ledgerOf(repoDir)
        .readAll()
        .filter((ev) => ev.type === "VerdictSubmitted")
        .map((ev) => ev.payload as { verdictKind: string; verdict: string; role?: string });
      const specReviews = verdicts.filter((v) => v.verdictKind === "spec-review");
      expect(specReviews.map((v) => v.verdict)).toEqual(["fail", "pass"]);
      expect(specReviews.every((v) => v.role === "reviewer")).toBe(true);
      // 时序锚（S7）：pass verdict 的入账 ts 晚于第 2 份 reviewer brief 的落盘 mtime
      const passEvent = ledgerOf(repoDir)
        .readAll()
        .find(
          (ev) =>
            ev.type === "VerdictSubmitted" &&
            (ev.payload as { verdictKind: string; verdict: string }).verdictKind === "spec-review" &&
            (ev.payload as { verdictKind: string; verdict: string }).verdict === "pass",
      );
      expect(passEvent).toBeDefined();
      expect(Date.parse(passEvent!.ts)).toBeGreaterThan(reviewerBriefMtime);
    } finally {
      runner.child.kill("SIGTERM");
      await waitExit(runner, 10_000);
    }
    expect(runner.child.exitCode).toBe(143); // rv-1：SIGTERM 信号回收出口
  }, 90_000);
});

// ================================================================
// T2：deadlock（mx3 语义变化：按打回代数计数——同代双 fail 只计 1 代）
// ================================================================

/** T2 形态②共用断言：escalation 出声（含各代 comment 摘要）+ 只读默认视图 + 停止派发 */
async function assertDeadlock(
  repoDir: string,
  runner: RunnerCapture,
  comments: readonly string[],
): Promise<void> {
  await waitText(runner.stderrText, "打回循环活锁", 60_000);
  const escalation = runner.stderrText();
  expect(escalation).toContain("转人工");
  for (const comment of comments) {
    expect(escalation).toContain(comment);
  }
  // frontier --json 恒用默认 10（mx4 §4：只读命令无 flag 概念，投影展示语义）——
  // 2 代在默认口径下是 specFixPending；runner 侧转人工由注入的 --max-spec-rejects 2 判定
  const frontier = runCli(repoDir, ["frontier", "--json"]);
  expect(frontier.code).toBe(0);
  const groups = JSON.parse(frontier.stdout) as { specReviewDeadlock: string[]; specFixPending: string[] };
  expect(groups.specReviewDeadlock).not.toContain("demo");
  expect(groups.specFixPending).toContain("demo");
  // 停止派发：escalation 出声后 loop 继续 poll ≥3 轮（200ms poll × 1.2s ≥ 5 轮）无新派发
  const dispatchNeedles = ['派发 designer → unit "demo"', '派发 reviewer → unit "demo"', '派发 developer → unit "demo"'];
  const countDispatches = () =>
    dispatchNeedles.reduce((sum, needle) => sum + occurrences(runner.stdoutText(), needle), 0);
  const before = countDispatches();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(countDispatches(), "deadlock 后应停止该 unit 的一切新派发").toBe(before);
}

describe("mx-1 T2 deadlock 形态①（mx3 语义变化：同代双 fail 按打回代数只计 1 代，不再 deadlock）", () => {
  distIt("fail ×2（无重提）→ 不 deadlock、specFixPending 正常派 designer，无 escalation", async () => {
    const repoDir = makeScenario("t2-two-fails", "demo");
    const runner = startRunner(repoDir, "demo", ["--max-idle-ms", "60000"]);
    try {
      // 同步点：等首轮 designer 派发（spec 待写）再提交——否则 spec 可能早于
      // runner 首轮 poll 入账，designer#1 不派发，后续计数断言失锚
      await waitText(runner.stdoutText, '派发 designer → unit "demo"', 60_000);
      submitSpec(repoDir, "demo", ACCEPTANCE, "spec-demo.json");
      await waitText(runner.stdoutText, '派发 reviewer → unit "demo"', 60_000);
      expect(
        runCli(repoDir, ["review", "submit", "--unit", "demo", "--verdict-kind", "spec-review", "--verdict", "fail", "--comment", "形态一第1次fail：缺A3", "--role", "reviewer"]).code,
      ).toBe(0);
      await waitCountText(runner.stdoutText, '派发 designer → unit "demo"', 2, 10_000); // specFixPending 派 designer
      // 不重提：直接第二次 fail（人为——正常流程 designer 不出 verdict，抢答仅审计警告）
      expect(
        runCli(repoDir, ["review", "submit", "--unit", "demo", "--verdict-kind", "spec-review", "--verdict", "fail", "--comment", "形态一第2次fail：仍未补A3", "--role", "reviewer"]).code,
      ).toBe(0);
      // mx3 语义变化（原断言反转）：同一版 spec 的第二条 fail 仍是 1 代打回
      // （< 阈值——mx4 后默认 10）——designer 不被试探性提交误杀，specFixPending
      // 出口继续有效
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(runner.stderrText(), "同代双 fail 不触发 deadlock escalation").not.toContain("打回循环活锁");
      const frontier = runCli(repoDir, ["frontier", "--json"]);
      const groups = JSON.parse(frontier.stdout) as { specReviewDeadlock: string[]; specFixPending: string[] };
      expect(groups.specReviewDeadlock).not.toContain("demo");
      expect(groups.specFixPending).toContain("demo");
      // designer 未被停派：第二条 fail 后 designer 仍是该 unit 的推进出口（此处
      // designer#2 尚在飞等待重提，无新派发是 gate 语义——断言 reviewer/developer
      // 均未被派发即可证停派未发生之外的通道未打开）
      expect(runner.stdoutText()).not.toContain('派发 developer → unit "demo"');
    } finally {
      runner.child.kill("SIGTERM");
      await waitExit(runner, 10_000);
    }
  }, 60_000);
});

describe("mx-1 T2 deadlock 形态②：fail → 重提（改 1 字节）→ fail（代数累计不清零）", () => {
  distIt("fail → designer 重提 1 字节新 spec → 再 fail → specReviewDeadlock（2 代打回，重提不清零）", async () => {
    // mx4 迁移：默认打回预算 10，注入 --max-spec-rejects 2 快速构造 2 代触顶
    const repoDir = makeScenario("t2-resubmit-fail", "demo");
    const runner = startRunner(repoDir, "demo", ["--max-idle-ms", "60000", "--max-spec-rejects", "2"]);
    try {
      // 同步点：等首轮 designer 派发再提交（计数断言的锚，见形态①注释）
      await waitText(runner.stdoutText, '派发 designer → unit "demo"', 60_000);
      submitSpec(repoDir, "demo", ACCEPTANCE, "spec-demo-v1.json");
      await waitText(runner.stdoutText, '派发 reviewer → unit "demo"', 60_000);
      expect(
        runCli(repoDir, ["review", "submit", "--unit", "demo", "--verdict-kind", "spec-review", "--verdict", "fail", "--comment", "形态二第1次fail：A2标题不达意", "--role", "reviewer"]).code,
      ).toBe(0);
      await waitCountText(runner.stdoutText, '派发 designer → unit "demo"', 2, 10_000);
      // designer 修 spec 重提（改 1 字节）——计数不因新 SpecSubmitted 清零
      const revised: AcceptanceItem[] = ACCEPTANCE.map((a) =>
        a.id === "A2" ? { ...a, title: "单元级冒烟X" } : a,
      );
      submitSpec(repoDir, "demo", revised, "spec-demo-v2.json");
      // 回流 specReviewPending：第 2 次 reviewer 派发后人为再 fail
      await waitCountText(runner.stdoutText, '派发 reviewer → unit "demo"', 2, 10_000);
      const reviewerStdout = join(findTopicDir(repoDir, "demo"), "demo.reviewer.stdout");
      await waitCountText(() => readFileSync(reviewerStdout, "utf-8"), "reviewer 指令", 2, 10_000);
      expect(
        runCli(repoDir, ["review", "submit", "--unit", "demo", "--verdict-kind", "spec-review", "--verdict", "fail", "--comment", "形态二第2次fail：本质问题未解决", "--role", "reviewer"]).code,
      ).toBe(0);
      await assertDeadlock(repoDir, runner, ["形态二第1次fail：A2标题不达意", "形态二第2次fail：本质问题未解决"]);
      // MF2 教训锚：重提发生过（specs ≥2）但 deadlock 仍触发
      const specs = ledgerOf(repoDir)
        .readAll()
        .filter((ev) => ev.type === "SpecSubmitted");
      expect(specs.length).toBeGreaterThanOrEqual(2);
    } finally {
      runner.child.kill("SIGTERM");
      await waitExit(runner, 10_000);
    }
  }, 90_000);
});

// ================================================================
// T3：抢答警告（S7：审计可见性，不阻断）
// ================================================================

describe("mx-1 T3 抢答警告：无在场 reviewer 时提交 spec-review verdict（mx3 迁移：designer 自审不驱动冻结）", () => {
  distIt("designer 形态的自审 pass（spec+verdict 单写者一次入账）→ stderr 警告行；fold 不消费 → 派独立 reviewer 而非 developer", async () => {
    const repoDir = makeScenario("t3-premature", "demo");
    const runner = startRunner(repoDir, "demo", ["--max-idle-ms", "60000"]);
    try {
      await waitText(runner.stdoutText, '派发 designer → unit "demo"', 60_000);
      // 抢答现场（mx-1 修复的 critical 缺陷形态）：单一写者把 spec 与 spec-review
      // pass 一次入账（同进程两次 append 合一写入——runner 轮询读到的要么全无
      // 要么全有，消灭「spec 先到 → 派 reviewer」的竞态窗口）。此刻无在场
      // reviewer flight、verdict 非 fail → 必须出警告
      const ledgerFile = ledgerPath(cwHome, repoDir);
      const lines = readFileSync(ledgerFile, "utf8").split("\n").filter((l) => l !== "");
      const specHash = String(ACCEPTANCE.length) + "-mx1-t3";
      const envelope = (seq: number, type: string, payload: Record<string, unknown>): string =>
        JSON.stringify({ seq, ts: new Date().toISOString(), type, payload });
      const specLine = envelope(lines.length + 1, "SpecSubmitted", {
        unitId: "demo",
        specHash,
        acceptance: ACCEPTANCE,
        contracts: [],
        split: [],
      });
      const verdictLine = envelope(lines.length + 2, "VerdictSubmitted", {
        unitId: "demo",
        verdictKind: "spec-review",
        verdict: "pass",
        role: "designer",
      });
      const res = spawnSync(
        process.execPath,
        [
          "-e",
          `const fs=require('fs');fs.appendFileSync(${JSON.stringify(ledgerFile)},${JSON.stringify(`${specLine}\n${verdictLine}\n`)})`,
        ],
        { encoding: "utf-8", timeout: 30_000 },
      );
      expect(res.status, `单写者追加应成功（stderr: ${res.stderr}）`).toBe(0);

      await waitText(runner.stderrText, "疑似非独立 reviewer 提交", 60_000);
      // mx3 语义变化：fold 只认 role=reviewer——designer 的自审 pass 不驱动冻结，
      // unit 回 specReviewPending，循环改派独立 reviewer（不再派 developer）
      await waitText(runner.stdoutText, '派发 reviewer → unit "demo"', 60_000);
      expect(runner.stdoutText()).not.toContain('派发 developer → unit "demo"');
      // 状态锚：designer 自审后 unit 仍是 created（待独立审查）
      expect(runCli(repoDir, ["status"]).stdout).toMatch(/demo\s+created/);
    } finally {
      runner.child.kill("SIGTERM");
      await waitExit(runner, 10_000);
    }
  }, 60_000);
});

// ================================================================
// T5：exec-review 文案修复回归（loop 任务书 + human-loop 指令补 --evidence-refs）
// ================================================================

describe("mx-1 T5 exec-review 文案修复回归", () => {
  it("human-loop 的 exec-review 指令模板含 --evidence-refs（rv-2 必填项，照抄执行不再被 refs 校验卡住）", () => {
    // fixture：verified 未 closed 的 unit（fold 投影直供纯函数）
    const ledger = new EventLedger(ledgerPath(cwHome, join(tmpRoot, "t5-human-loop-fixture")));
    ledger.append("UnitCreated", { unitId: "u-exec", parentId: null, briefRef: "brief.md" });
    ledger.append("SpecSubmitted", {
      unitId: "u-exec",
      specHash: "h",
      acceptance: [...ACCEPTANCE],
      contracts: [],
      split: [],
    });
    // mx3 迁移：fold 只认 role=reviewer——fixture 的 spec-review pass 补自报 role
    ledger.append("VerdictSubmitted", { unitId: "u-exec", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    ledger.append("EvidenceSubmitted", {
      unitId: "u-exec",
      runId: "run-exec-1",
      commit: "c" + "0".repeat(39),
      paths: [],
      sha256: [],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId: "u-exec",
      runId: "run-exec-1",
      reportHash: "rh",
      result: "pass",
      acceptanceIds: ACCEPTANCE.map((a) => a.id),
    });
    const step = buildStepInstruction(fold(ledger.readAll()), "u-exec");
    expect(step.kind).toBe("exec-review");
    expect(step.lines.join("\n")).toContain("--evidence-refs");
  });
});

// ================================================================
// T6：role 字段（review submit 的可选自报 flag）
// ================================================================

describe("mx-1 T6 role 字段", () => {
  let caseNo = 0;
  let repoDir: string;

  beforeEach(() => {
    caseNo += 1;
    repoDir = makeScenario(`t6-role-${caseNo}`, "u-role");
    submitSpec(repoDir, "u-role", ACCEPTANCE, "spec.json");
  });

  distIt("--role reviewer → 入账 payload.role=reviewer", () => {
    const res = runCli(repoDir, [
      "review",
      "submit",
      "--unit",
      "u-role",
      "--verdict-kind",
      "spec-review",
      "--verdict",
      "pass",
      "--role",
      "reviewer",
    ]);
    expect(res.code, `应成功（stderr: ${res.stderr}）`).toBe(0);
    const verdict = ledgerOf(repoDir)
      .readAll()
      .find((ev) => ev.type === "VerdictSubmitted")
      ?.payload as { role?: string };
    expect(verdict?.role).toBe("reviewer");
  });

  distIt("--role boss → 拒绝且错误含恢复动作与合法值清单", () => {
    const res = runCli(repoDir, [
      "review",
      "submit",
      "--unit",
      "u-role",
      "--verdict-kind",
      "spec-review",
      "--verdict",
      "pass",
      "--role",
      "boss",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--role "boss"');
    expect(res.stderr).toContain("reviewer | designer | developer | human");
    expect(res.stderr).toContain("恢复动作");
    // 拒绝的提交不入账
    expect(ledgerOf(repoDir).readAll().some((ev) => ev.type === "VerdictSubmitted")).toBe(false);
  });

  distIt("缺省（mx3 迁移：spec-review 已强制 --role reviewer，可选性断言保留于 exec-review）→ payload 无 role 键", () => {
    // 构造 verified 前置（exec-review 的 --evidence-refs 须引用已入账 runId）
    const ledger = ledgerOf(repoDir);
    ledger.append("VerdictSubmitted", { unitId: "u-role", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    ledger.append("EvidenceSubmitted", {
      unitId: "u-role",
      runId: "run-t6-default",
      commit: "c" + "3".repeat(39),
      paths: ["app.js"],
      sha256: ["d" + "3".repeat(63)],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId: "u-role",
      runId: "run-t6-default",
      reportHash: "rh-t6-default",
      result: "pass",
      acceptanceIds: ACCEPTANCE.map((a) => a.id),
    });
    const res = runCli(repoDir, [
      "review",
      "submit",
      "--unit",
      "u-role",
      "--verdict-kind",
      "exec-review",
      "--verdict",
      "pass",
      "--evidence-refs",
      "run-t6-default",
    ]);
    expect(res.code, `exec-review 无 role 应入账（stderr: ${res.stderr}）`).toBe(0);
    const payload = ledgerOf(repoDir)
      .readAll()
      .find(
        (ev) =>
          ev.type === "VerdictSubmitted" &&
          (ev.payload as { verdictKind: string }).verdictKind === "exec-review",
      )
      ?.payload as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(payload, "role")).toBe(false);
  });
});

// ================================================================
// T4 + T5(b)：直调 runLoop + 真实 node worker（派发 gate / exec-review 模板全链）
// ================================================================

/** mx1 worker：designer 按 mode 控速提 spec；reviewer 按现状出 verdict（exec 走真实 dispatch 含 refs） */
function writeWorkerScript(): string {
  const script = `// tests/mx1-independent-review.test.ts 生成的测试专用 agent worker（真实进程，非 mock）
// argv: <role> <unitId> <cwd> <mode> <commit>
import { createHash } from "node:crypto";
const DIST = ${JSON.stringify(DIST_ROOT)};
const [role, unitId, cwd, mode, commit] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const { dispatch } = await import(DIST + "/dispatch.js");
const { ledgerForCwd } = await import(DIST + "/handlers/common.js");
const { loadLedger, unitStatus } = await import(DIST + "/readonly/load.js");
console.log("mx1-worker " + role + " " + unitId + " mode=" + mode + " pid=" + process.pid);
const ACCEPTANCE = ${JSON.stringify(ACCEPTANCE)};

if (role === "designer") {
  if (mode === "slow-designer") {
    // T4：先写 spec（frontier 立即出现 specReviewPending），再存活 600ms 后退出
    // ——派发 gate 必须在整个存活窗口内缓派 reviewer
    await sleep(200);
    ledgerForCwd(cwd).append("SpecSubmitted", { unitId, specHash: sha("mx1-slow"), acceptance: ACCEPTANCE, contracts: [], split: [] });
    console.log("mx1-worker spec-written " + unitId);
    await sleep(600);
  } else {
    ledgerForCwd(cwd).append("SpecSubmitted", { unitId, specHash: sha("mx1-fast"), acceptance: ACCEPTANCE, contracts: [], split: [] });
  }
  console.log("mx1-worker-done designer " + unitId);
} else if (role === "developer") {
  const unit = loadLedger(cwd).projection.units.get(unitId);
  if (unit === undefined || unit.specs.length === 0) throw new Error("mx1-worker: unit " + unitId + " 无 spec");
  const acceptanceIds = unit.specs[unit.specs.length - 1].acceptance.map((a) => a.id);
  const runId = "run-" + unitId + "-" + Date.now();
  const ledger = ledgerForCwd(cwd);
  ledger.append("EvidenceSubmitted", { unitId, runId, commit, paths: ["app.js"], sha256: [sha("app.js")], exitCode: 0 });
  ledger.append("VerifyRan", { unitId, runId, reportHash: sha("evidence-report:" + runId), result: "pass", acceptanceIds });
  console.log("mx1-worker-done developer " + unitId);
} else if (role === "reviewer") {
  const unit = loadLedger(cwd).projection.units.get(unitId);
  if (unit === undefined) throw new Error("mx1-worker: unit " + unitId + " 不在账本");
  if (unitStatus(unit) === "verified") {
    // T5(b)：exec-review 走真实 dispatch——按任务书模板原样带 --evidence-refs 与 --role
    const lastRun = unit.evidences[unit.evidences.length - 1]?.runId ?? "";
    const args = ["review", "submit", "--unit", unitId, "--verdict-kind", "exec-review", "--verdict", "pass", "--role", "reviewer", "--evidence-refs", lastRun];
    const code = await dispatch(args, cwd);
    if (code !== 0) throw new Error("mx1-worker: exec-review refs 提交被拒 exit " + code);
  } else {
    ledgerForCwd(cwd).append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
  }
  console.log("mx1-worker-done reviewer " + unitId);
} else {
  throw new Error("mx1-worker: 未知 role " + role);
}
`;
  const path = join(tmpRoot, "mx1-worker.mjs");
  writeFileSync(path, script);
  return path;
}

const WORKER_PATH = writeWorkerScript();

interface LoopSpawnRecord {
  role: string;
  unitId: string;
  spawnAt: number;
  /** 该 spawn 的 wait() 结算时刻（派发 gate 时序断言的权威时间线） */
  settledAt: number;
}

/** 记录 spawn/wait 时序的适配器（spawn 真实 node worker 子进程；dist 动态加载） */
async function makeRecordingLoop(
  repoDir: string,
  rootId: string,
  mode: string,
): Promise<{ code: number; records: readonly LoopSpawnRecord[] }> {
  const { runLoop } = await import("../dist/runner/loop.js");
  const { spawnProcess } = await import("../dist/runner/spawn/lifecycle.js");
  const records: LoopSpawnRecord[] = [];
  const adapter: AgentSpawnAdapter = {
    name: "mx1-recording",
    spawn: async (req: AgentSpawnRequest): Promise<SpawnHandle> => {
      const record: LoopSpawnRecord = {
        role: req.role,
        unitId: req.unitId,
        spawnAt: Date.now(),
        settledAt: Number.NaN,
      };
      records.push(record);
      const handle = spawnProcess({
        command: process.execPath,
        args: [WORKER_PATH, req.role, req.unitId, req.projectCwd, mode, "c" + "0".repeat(39)],
        cwd: req.workdir,
        timeoutMs: req.timeoutMs,
        stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
        stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
      });
      return {
        wait: async () => {
          const result = await handle.wait();
          record.settledAt = Date.now();
          return result;
        },
        kill: handle.kill,
      };
    },
  };
  const code = await runLoop({ rootId, adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 30_000 });
  return { code, records };
}

describe("mx-1 T4 派发 gate：同 unit 在飞期间缓派（S1）", () => {
  distIt("慢 designer 存活期间 specReviewPending 已成立但不派 reviewer；结算后下轮才派", async () => {
    const repoDir = makeScenario("t4-gate", "demo");
    const { code, records } = await makeRecordingLoop(repoDir, "demo", "slow-designer");

    expect(code).toBe(0);
    const roles = records.map((r) => r.role);
    expect(roles).toEqual(["designer", "reviewer", "developer", "reviewer"]);
    const designer = records[0]!;
    const specReviewer = records[1]!;
    // 慢 designer：200ms 写 spec（此后每轮 frontier 都是 specReviewPending）、
    // 800ms 退出——reviewer 的派发时刻必须晚于 designer 结算（gate 生效的时序证明）
    expect(specReviewer.spawnAt, "designer 在飞期间不得派 reviewer").toBeGreaterThan(designer.settledAt);
    // 对照：gate 修复的是「spec 已在账、designer 未结算」的窗口（200-800ms），
    // reviewer 派发前 spec 必然已入账（specReviewPending 成立的物理前提）
    const specWritten = ledgerOf(repoDir).readAll().some((ev) => ev.type === "SpecSubmitted");
    expect(specWritten).toBe(true);
    expect(specReviewer.spawnAt - designer.spawnAt).toBeGreaterThanOrEqual(800);
  }, 60_000);
});

describe("mx-1 T5(b)：exec-review 任务书模板（--evidence-refs + --role）全链收敛", () => {
  distIt("exec-review reviewer brief 含 --evidence-refs 与 --role reviewer；worker 按模板真实 dispatch 提交 → root closed", async () => {
    const repoDir = makeScenario("t5-refs-e2e", "demo");
    const { code } = await makeRecordingLoop(repoDir, "demo", "fast");
    expect(code).toBe(0);
    expect(runCli(repoDir, ["status"]).stdout).toMatch(/demo\s+closed/);

    // exec-review 任务书落盘产物含 rv-2 必填 refs 与 mx-1 role 自报
    const briefPath = join(findTopicDir(repoDir, "demo"), "demo.reviewer.brief.md");
    const brief = readFileSync(briefPath, "utf-8");
    expect(brief).toContain("--verdict-kind exec-review");
    expect(brief).toContain("--evidence-refs");
    expect(brief).toContain("--role reviewer");
    // 账本复核：exec-review verdict 带 refs 与 role（模板照抄执行的真实结果）
    const execVerdict = ledgerOf(repoDir)
      .readAll()
      .find(
        (ev) =>
          ev.type === "VerdictSubmitted" &&
          (ev.payload as { verdictKind: string }).verdictKind === "exec-review",
      )?.payload as { evidenceRefs?: string[]; role?: string };
    expect(execVerdict?.evidenceRefs?.length).toBeGreaterThanOrEqual(1);
    expect(execVerdict?.role).toBe("reviewer");
  }, 60_000);
});

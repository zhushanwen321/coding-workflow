/**
 * fb-2 单测：停派维度命中即回收该 unit 在飞 spawn（.tmp/design-fail-attribution.md
 * v6 §3.3-D9 / §4 V11；实现 src/runner/loop.ts 的 recallStoppedUnitSpawns）。
 *
 * 真实 dispatch 链路：真实 CLI 子进程跑 `cw run --spawn human`（lv2 D6/D7 范式），
 * 隔离 CW_HOME tmp 目录 + scratch git 仓 + 真实 worktree / 事件账本，零 mock。
 *
 * 「在飞进程」的可观测面（u6b 契约的事实约束）：human 适配器无 OS 子进程——
 * spawn 的「在飞」实体是 runner 进程内的轮询协程，kill() 的效果 = wait() 以
 * CRASH 收口（human.ts：kill 置 settled 并立即 resolve CRASH）。因此：
 *   - 「A 在飞 spawn 被回收」观测 = runner stdout 的 CRASH 结算行
 *     `developer unit "ua" 退出 CRASH，可重派`（settleFlightOutput）；
 *   - 「B 在飞 spawn 存活」观测 = ①观察窗内无 B 结算行（未被 kill）+
 *     ②观察窗后向账本写入 B 的进展事件（VerifyRan）能唤醒 B 的轮询协程使其
 *     exit 0 结算——kill 掉的协程不可能再结算，这是 human 模式下最强的机器
 *     可检存活证明（正向 + 负向双保险）。
 *
 * 五断言点（V11 验收标准）：
 *   ① runner stderr 出现 A 的回收出声（实现原文特征词），且晚于转人工指引
 *     （出声时序 = 设计检查点③：「人工先看到指引、随后看到回收记录」）；
 *   ② A 在飞 developer spawn 被回收（CRASH 结算行）；
 *   ③ 健康对照 B 的在飞 spawn 全程存活（观察窗 ≥ 一个 poll 周期 + 事后唤醒证明）；
 *   ④ 回收后等待窗口内账本无来自 A 的新迟交入账；
 *   ⑤ 跨轮去重（episode 内）：多条轮次重算后 A 的回收出声恰出现一次；后续
 *     追加 MF-1 回归段（离开停派集后二次命中 → 第二条回收行）验证 episode 粒度。
 *
 * 构造：双叶 unit（目标 A=ua + 健康对照 B=ub）挂同一 root，spec 各就位后
 * A、B 各自在飞一个 developer（human spawn 指令打印后长驻轮询等待）；
 * 对 A 灌默认预算 K=5 条 build 证据（无 pass verify）→ buildDrift 停派命中。
 * 不用 --max-build-attempts 1 的紧预算：B 的健康对照路径需要 1 条证据 + verify
 * 仍属健康形态（1 < K），紧预算会把 B 也推入 buildDrift 使对照组失效。
 *
 * TIMEOUT 封顶档不做专项用例（设计记档为防御性空转，检查点④）。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { BUILD_DRIFT_MAX_ATTEMPTS } from "../src/readonly/frontier.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath, worktreePath } from "../src/store/project.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = join(REPO_ROOT, "dist", "cli.js");

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "cw-fb2-")));
const cwHome = join(tmpRoot, "home");
// runner 子进程与测试进程共用的 worktree 根隔离（rv5 / lv2 同款）
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  delete process.env.CW_WORKTREE_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---- 基建（lv2 D6/D7 范式照搬） ----

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

/** 真实 CLI 子进程（evidence / verify / create 等全走 dist/cli.js 真实 dispatch） */
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

/** 真实 tmp git 仓（单 commit——runner 的 HEAD 快照与 worktree 基底） */
function makeRepo(name: string, briefTitle: string): string {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-fb2@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-fb2"]);
  writeFileSync(join(repoDir, "brief.md"), `# ${briefTitle}\n`);
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  return repoDir;
}

/** 过 gate 的验收集（spec-frozen 前置）：E1 e2e-real + U1 unit 级（规则⑤） */
function contractAcceptance() {
  return [
    { id: "E1", core: true, title: "应用可运行", type: "e2e-real" as const, command: "node e1.js" },
    { id: "U1", core: false, title: "单元冒烟", type: "unit" as const, command: "node u1check.js" },
  ];
}

/** spec 文件落盘 + 真实 CLI 提交 spec 并过审（children-first；lv2 submitSpecFile 同款） */
function submitSpecFile(repoDir: string, unitId: string, splitUnitIds: readonly string[]): void {
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

/** 在指定 git 目录（unit worktree）提交一批文件，返回新 commit hash */
function commitFiles(dir: string, files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  gitRun(dir, ["add", "-A"]);
  gitRun(dir, ["commit", "-m", `fixture: ${Object.keys(files).join("+")}`]);
  return gitRun(dir, ["rev-parse", "HEAD"]);
}

// ---- runner 子进程基建（mx1 / lv2 同款） ----

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

function startRunner(repoDir: string, rootId: string, extraArgs: readonly string[]): RunnerCapture {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const child = spawn(
    process.execPath,
    [CLI_PATH, "run", "--root", rootId, "--spawn", "human", "--poll-ms", "150", ...extraArgs],
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

/** 轮询等待文本出现（runner stdout/stderr 的同步点；超时抛可诊断错误） */
async function waitText(readText: () => string, needle: string, timeoutMs: number): Promise<void> {
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

/** 轮询等待文本累计出现 ≥count 次（episode 二次命中段的同步点） */
async function waitCount(
  readText: () => string,
  needle: string,
  count: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (countOccurrences(readText(), needle) < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `等待文本 "${needle}" 第 ${count} 次出现超时（${timeoutMs}ms，当前 ${countOccurrences(readText(), needle)} 次）。当前文本末尾：${readText().slice(-600)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ================================================================
// V11 主场景：buildDrift 停派命中回收在飞 spawn（健康对照存活）
// ================================================================

describe("V11 停派命中回收在飞 spawn", () => {
  it(
    "A 灌满 build 预算 → 回收出声（指引在前）+ CRASH 结算 + 对照 B 全程存活 + 无迟交 + 跨轮去重",
    async () => {
      const repoDir = makeRepo("fb2-main", "fb2 v11 场景");
      expect(runCli(repoDir, ["create", "--id", "fr", "--brief", "brief.md"]).code).toBe(0);
      expect(runCli(repoDir, ["create", "--id", "ua", "--brief", "brief.md", "--parent", "fr"]).code).toBe(0);
      expect(runCli(repoDir, ["create", "--id", "ub", "--brief", "brief.md", "--parent", "fr"]).code).toBe(0);
      submitSpecFile(repoDir, "fr", ["ua", "ub"]);
      submitSpecFile(repoDir, "ua", []);
      submitSpecFile(repoDir, "ub", []);

      // idle 预算放大：观察窗（2.5s）内零事件推进不得触发空转退出杀死对照 B
      const runner = startRunner(repoDir, "fr", ["--max-idle-ms", "30000"]);
      const dispatchA = '派发 developer → unit "ua"';
      const dispatchB = '派发 developer → unit "ub"';

      // 前置：A 与 B 各自在飞一个 developer（human spawn 指令打印后长驻轮询等待）
      await waitText(runner.stdoutText, dispatchA, 60_000);
      await waitText(runner.stdoutText, dispatchB, 60_000);

      // 在飞期间对 A 灌默认预算 K 条 build 证据（无 pass verify）→ 下轮投影命中 buildDrift
      const wtA = worktreePath(WT_HOME, repoDir, "ua");
      for (let i = 1; i <= BUILD_DRIFT_MAX_ATTEMPTS; i += 1) {
        const commit = commitFiles(wtA, { [`ua-attempt-${i}.txt`]: `attempt ${i}\n` });
        expect(
          runCli(repoDir, ["evidence", "submit", "--kind", "build", "--unit", "ua", "--commit", commit, "--run-id", `ua-b${i}`]).code,
          `A 的第 ${i} 条 build 证据应入账`,
        ).toBe(0);
      }

      // ① 回收出声（实现原文特征词）+ 出声时序：转人工指引在前、回收记录在后
      // （设计检查点③定夺——「人工先看到指引、随后看到回收记录」）
      const recallLine = '停派转人工（buildDrift）：回收 unit "ua" 的在飞 developer spawn';
      await waitText(runner.stderrText, recallLine, 60_000);
      const escalationIdx = runner.stderrText().indexOf('unit "ua" 的 build 证据已达');
      expect(escalationIdx, "转人工指引应已出声（announceManualEscalations）").toBeGreaterThanOrEqual(0);
      expect(
        runner.stderrText().indexOf(recallLine),
        "回收行应晚于转人工指引（stderr 行序即人工视读序）",
      ).toBeGreaterThan(escalationIdx);
      // C10 原因短句在场（回收行自解释性）
      expect(runner.stderrText()).toContain("在飞产出迟交会顶掉人工处置（C10）");

      // ② A 在飞 spawn 被回收：human kill = CRASH 收口 → 结算行（「进程退出」的
      // human 模式可观测等价物，见文件头注释）
      await waitText(runner.stdoutText, 'developer unit "ua" 退出 CRASH', 30_000);

      // 观察窗前快照：A 的全部事件 seq（④的迟交判定基线）
      const ledgerFile = ledgerPath(cwHome, repoDir);
      const seqsForUnit = (unitId: string): number[] =>
        new EventLedger(ledgerFile).readAll().filter((e) => e.payload.unitId === unitId).map((e) => e.seq);
      const uaSeqsBeforeWindow = seqsForUnit("ua");

      // 观察窗 ≥ 一个 poll 周期以上（poll=150ms → 2500ms 覆盖 16+ 轮投影重算
      // 与 2+ 个 human 轮询周期——跨轮去重与迟交判定都需要多轮窗口）
      await sleep(2_500);

      // ③ 健康对照 B 在飞 spawn 存活（负向）：观察窗内无 B 的结算行（未被 kill）、
      // 无 B 的回收出声（未被过杀）
      expect(runner.stdoutText(), "对照 B 不应出现任何结算行（存活证明的负向半边）").not.toContain('unit "ub" 退出');
      expect(runner.stderrText(), "对照 B 不应被回收（killAll 式过杀即翻红）").not.toContain('回收 unit "ub"');

      // ④ 回收后窗口内账本无来自 A 的新迟交入账（被回收的 spawn 不得再产出）
      expect(seqsForUnit("ua"), "A 的事件 seq 集应与观察窗前完全一致（无迟交）").toEqual(uaSeqsBeforeWindow);

      // ⑤ 跨轮去重（episode 内）：观察窗内 A 连续命中属同一停派 episode，回收
      // 出声恰一次（episode 粒度为实施层选择——设计未钉死，见函数头注释）；
      // 二次命中段（下方 MF-1 回归）验证离开停派集后重新回收。停派后无新派发
      expect(countOccurrences(runner.stderrText(), recallLine), "同一 episode 内只回收一次（episode 粒度去重，键 = unitId）").toBe(1);
      expect(countOccurrences(runner.stdoutText(), dispatchA), "停派只挡新派发——A 不应再被派发").toBe(1);

      // ③ 存活证明（正向）：向账本写 B 的进展事件（真实 build 证据 + verify fail
      // 的 VerifyRan）唤醒 B 的轮询协程——被回收的协程不可能再以 exit 0 结算。
      // 1 条证据 < K=5，B 仍是健康形态（不入 buildDrift，见文件头取舍说明）
      const wtB = worktreePath(WT_HOME, repoDir, "ub");
      const u1check = [
        "const fs = require('fs');",
        "let ok = false;",
        "try { ok = fs.readFileSync(__dirname + '/impl.js', 'utf8').includes('E1 PASS'); } catch (e) { ok = false; }",
        "console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'U1 smoke',status: ok ? 'passed' : 'failed'}]}]}));",
        "if (!ok) { console.error('impl not good'); process.exit(1); }",
        "",
      ].join("\n");
      const commitB = commitFiles(wtB, {
        "impl.js": "console.log('E1 FAIL');\nprocess.exit(1);\n",
        "e1.js": "require('./impl.js');\n",
        "u1check.js": u1check,
      });
      expect(
        runCli(repoDir, ["evidence", "submit", "--kind", "build", "--unit", "ub", "--commit", commitB, "--run-id", "ub-b1"]).code,
        "B 的 build 证据应入账",
      ).toBe(0);
      const verifyB = runCli(repoDir, ["verify", "--unit", "ub"]);
      expect(verifyB.code, `B 的 verify 应 fail 入账（fail 也产 VerifyRan，是 developer 完成信号）：${verifyB.stderr}`).toBe(1);

      // B 的在飞 developer 以 exit 0 结算（progress 事件唤醒——全程存活的机器证明）
      await waitText(runner.stdoutText, 'developer unit "ub" 退出 exit 0', 30_000);
      // B 全程零回收（含结算后复核）
      expect(runner.stderrText()).not.toContain('回收 unit "ub"');

      // ---- MF-1 回归段：per-episode 回收去重（同 run 内二次停派 = 新接管现场） ----
      // 链路：A 首次回收（上方①-⑤）后人工重提 spec（human 场景合法操作）→
      // buildDrift 自愈（specEpoch 周期锄重置，episode 结束）→ 重派 A 的
      // reviewer 过审 → developer 进入在飞 → 新周期再灌满 K 条 build 证据 →
      // buildDrift 二次命中 → 必须重新回收（第二条回收出声行）。修前代码
      // （unitId 键入 Set 后永不清理）在「第二条回收行」断言上红。
      writeFileSync(
        join(repoDir, "spec-ua-r2.json"),
        `${JSON.stringify({ acceptance: contractAcceptance(), contracts: [], split: [] }, null, 2)}\n`,
      );
      expect(
        runCli(repoDir, ["evidence", "submit", "--kind", "spec", "--unit", "ua", "--file", "spec-ua-r2.json"]).code,
        "人工重提 spec（新代）应入账",
      ).toBe(0);
      // 新 spec 待审 → runner 派 A 的 reviewer（等它进场再交 pass，避免无
      // in-flight reviewer 的抢答警告噪音）
      await waitText(runner.stdoutText, '派发 reviewer → unit "ua"', 60_000);
      expect(
        runCli(repoDir, ["review", "submit", "--unit", "ua", "--verdict-kind", "spec-review", "--verdict", "pass", "--role", "reviewer"]).code,
        "新代 spec-review pass（人工以 reviewer 身份）应入账——旧代结论不占新代",
      ).toBe(0);
      // A 回到 spec-frozen → runner 重派 A 的 developer（第 2 次 dispatchA）
      await waitCount(runner.stdoutText, dispatchA, 2, 60_000);
      // 新 spec 周期内再灌满 K 条 build 证据（无 pass verify）→ buildDrift 二次命中
      for (let i = BUILD_DRIFT_MAX_ATTEMPTS + 1; i <= BUILD_DRIFT_MAX_ATTEMPTS * 2; i += 1) {
        const commit = commitFiles(wtA, { [`ua-attempt-${i}.txt`]: `attempt ${i}\n` });
        expect(
          runCli(repoDir, ["evidence", "submit", "--kind", "build", "--unit", "ua", "--commit", commit, "--run-id", `ua-b${i}`]).code,
          `A 的第 ${i} 条 build 证据（新周期）应入账`,
        ).toBe(0);
      }
      // 核心断言：第二条回收出声行（episode 粒度去重——观察窗内连续命中属同一
      // episode 不重复出声，离开停派集后二次命中 = 新现场必须重新回收）
      await waitCount(runner.stderrText, recallLine, 2, 60_000);
      expect(
        countOccurrences(runner.stderrText(), recallLine),
        "二次停派 = 新接管现场，必须重新回收（episode 粒度去重）",
      ).toBe(2);
      // 新在飞 developer 确实被回收（第二条 CRASH 结算行——新 spawn 被杀的机器证明）
      await waitCount(runner.stdoutText, 'developer unit "ua" 退出 CRASH', 2, 30_000);
      expect(countOccurrences(runner.stdoutText(), 'developer unit "ua" 退出 CRASH')).toBe(2);

      runner.child.kill("SIGKILL");
    },
    180_000,
  );
});

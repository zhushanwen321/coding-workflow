/**
 * mx-4 单测 D1-D5（mx4-acceptance §5）：spec 打回代数转人工预算默认 2 → 10 +
 * `cw run --max-spec-rejects` 可配置。全部真实子进程（node dist/cli.js）+ 直写
 * 真实账本 + tmp + 隔离 CW_HOME，零 mock。
 *
 *   D1 默认阈值 10：直写账本构造 9 代打回（9 轮 SpecSubmitted → fail）→
 *      frontier --json 无 specReviewDeadlock、有 specFixPending；构造 10 代 →
 *      specReviewDeadlock 出现 + escalation 文案含代数与预算
 *   D2 flag 参数化全链：`cw run --max-spec-rejects 2`（human 模式）下 2 代打回
 *      即转人工 + 全程零派发（dispatch 侧同样吃注入预算——绝对计数断言，mx4
 *      打回修复 F1）；同账本默认配置下不转人工（specFixPending 派 designer）
 *      ——证明 flag 只作用 runner 侧判定
 *   D3 flag 校验三态：0 / -1 / abc → exit 1 各含可操作文案；1 合法（最严：
 *      首代打回即转人工）；非整数形态（mx4 打回修复 F2）：0.5 / 2.5 拒、1e2
 *      强转整数 100 合法、--max-idle-ms 0.5 拒（共用解析器顺带收紧）
 *   D4 只读默认语义：`cw frontier`（无 flag 概念）对 5 代打回 unit 显示
 *      specFixPending（默认 10 不误报 deadlock）
 *   D5 常量锚：SPEC_REVIEW_DEADLOCK_FAILS 导出值 = 10（配置默认值单一事实源）
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../src/events/types.js";
import { SPEC_REVIEW_DEADLOCK_FAILS } from "../src/readonly/frontier.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const CLI_PATH = join(DIST_ROOT, "cli.js");
if (!existsSync(CLI_PATH)) {
  throw new Error("tests/mx4-reject-budget 需要 dist/（先 npm run build；npm test 的 pretest 已含）");
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-mx4-budget-"));
const cwHome = join(tmpRoot, "home");
const originalCwHome = process.env.CW_HOME;
process.env.CW_HOME = cwHome;
process.env.CW_WORKTREE_HOME = join(tmpRoot, "cw-worktrees");

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

// ---- fixture 基建（mx3 同款形态） ----

/** 过 spec gate 五规则的验收（e2e-real 带可解析 command + unit 级） */
const ACCEPTANCE: readonly AcceptanceItem[] = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node -v" },
  { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
];

function gitRun(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", timeout: 30_000 });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 真实 tmp git 仓库 + 经 CLI 创建的 root unit */
function makeScenario(name: string, rootId: string): string {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-mx4@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-mx4"]);
  writeFileSync(join(repoDir, "brief.md"), `# ${rootId} 任务书（mx4 fixture）\n`);
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  const res = runCli(repoDir, ["create", "--id", rootId, "--brief", "brief.md"]);
  expect(res.code, `cw create 应成功（stderr: ${res.stderr}）`).toBe(0);
  return repoDir;
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(repoDir: string, args: readonly string[]): Captured {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
    timeout: 90_000,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function ledgerOf(repoDir: string): EventLedger {
  return new EventLedger(ledgerPath(cwHome, repoDir));
}

function appendSpec(ledger: EventLedger, unitId: string, salt: string): void {
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: `${unitId}-spec-${salt}`,
    acceptance: [...ACCEPTANCE],
    contracts: [],
    split: [],
  });
}

function appendReviewerFail(ledger: EventLedger, unitId: string, comment: string): void {
  ledger.append("VerdictSubmitted", {
    unitId,
    verdictKind: "spec-review",
    verdict: "fail",
    role: "reviewer",
    comment,
  });
}

/** 构造 n 个打回代数（n 轮 SpecSubmitted → 首条 reviewer fail；重提不清零代数累计） */
function appendGenerations(ledger: EventLedger, unitId: string, generations: number): void {
  for (let i = 1; i <= generations; i += 1) {
    appendSpec(ledger, unitId, `v${i}`);
    appendReviewerFail(ledger, unitId, `第 ${i} 代打回意见（mx4 fixture）`);
  }
}

// ---- runner 子进程基建（mx3 同款形态） ----

const liveRunners = new Set<ChildProcess>();

interface RunnerCapture {
  child: ChildProcess;
  stdoutText(): string;
  stderrText(): string;
}

function startRunner(repoDir: string, rootId: string, extraArgs: readonly string[] = []): RunnerCapture {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const child = spawn(
    process.execPath,
    [
      CLI_PATH, "run", "--root", rootId, "--spawn", "human",
      "--poll-ms", "200", "--max-idle-ms", "60000",
      ...extraArgs,
    ],
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
      reject(new Error(`runner 未在 ${timeoutMs}ms 内退出（stderr 末尾：${runner.stderrText().slice(-400)}）`));
    }, timeoutMs);
    runner.child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
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

/** frontier --json 的 deadlock/fix 分组（与派发判定同一出处） */
function frontierGroups(repoDir: string): { specReviewDeadlock: string[]; specFixPending: string[] } {
  const res = runCli(repoDir, ["frontier", "--json"]);
  expect(res.code, `frontier 应成功（stderr: ${res.stderr}）`).toBe(0);
  return JSON.parse(res.stdout) as { specReviewDeadlock: string[]; specFixPending: string[] };
}

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

/** 全部派发行为的计数（deadlock 停派绝对断言的输入；mx3 同款形态） */
function countDispatches(runner: RunnerCapture, unitId: string): number {
  const needles = [
    `派发 designer → unit "${unitId}"`,
    `派发 reviewer → unit "${unitId}"`,
    `派发 developer → unit "${unitId}"`,
  ];
  return needles.reduce((sum, needle) => sum + occurrences(runner.stdoutText(), needle), 0);
}

// ================================================================
// D5：常量锚（放最前——纯 import 断言，快）
// ================================================================

describe("mx-4 D5 常量锚：SPEC_REVIEW_DEADLOCK_FAILS = 10", () => {
  it("导出值 = 10（--max-spec-rejects 缺省回落与只读命令默认的单一事实源）", () => {
    expect(SPEC_REVIEW_DEADLOCK_FAILS).toBe(10);
  });
});

// ================================================================
// D1：默认阈值 10（9 代不转人工 / 10 代转人工）
// ================================================================

describe("mx-4 D1 默认阈值 10：第 1-9 代打回走 specFixPending，第 10 代才转人工", () => {
  it("9 代打回 → frontier 无 specReviewDeadlock、有 specFixPending（designer 仍有修复出口）", () => {
    const repoDir = makeScenario("d1-nine", "demo");
    appendGenerations(ledgerOf(repoDir), "demo", 9);
    const groups = frontierGroups(repoDir);
    expect(groups.specReviewDeadlock, "9 代 < 默认 10：不判活锁").not.toContain("demo");
    expect(groups.specFixPending, "第 9 代打回仍派 designer 修 spec").toContain("demo");
  });

  it("10 代打回 → specReviewDeadlock 出现 + escalation 文案含代数与预算（默认配置 runner）", async () => {
    const repoDir = makeScenario("d1-ten", "demo");
    appendGenerations(ledgerOf(repoDir), "demo", 10);
    expect(frontierGroups(repoDir).specReviewDeadlock, "10 代 ≥ 默认 10：判活锁转人工").toContain("demo");

    // 无 flag 的默认配置 runner（human）：escalation 出声且同时含已达代数与预算值
    const runner = startRunner(repoDir, "demo");
    try {
      await waitText(runner.stderrText, "打回循环活锁", 60_000);
      const escalation = runner.stderrText();
      expect(escalation).toContain("已打回 10 代");
      expect(escalation).toContain("预算 10 代");
      expect(escalation).toContain("转人工");
      // 第 10 代意见在场（各代摘要列出，审计事实）
      expect(escalation).toContain("第 10 代打回意见（mx4 fixture）");
    } finally {
      runner.child.kill("SIGTERM");
      await waitExit(runner, 10_000);
    }
  }, 60_000);
});

// ================================================================
// D2：flag 参数化全链（--max-spec-rejects 2 下 2 代即转人工；默认同账本不转）
// ================================================================

describe("mx-4 D2 flag 参数化全链：--max-spec-rejects 只作用 runner 侧判定", () => {
  it("2 代打回账本：flag=2 的 runner 转人工；同账本默认 runner 不转（派 designer 修 spec）", async () => {
    const repoDir = makeScenario("d2-flag", "demo");
    appendGenerations(ledgerOf(repoDir), "demo", 2);

    // 阶段一：注入预算 2 → 2 代即触顶（mx3 G2 场景形态复用）
    const flagged = startRunner(repoDir, "demo", ["--max-spec-rejects", "2"]);
    try {
      await waitText(flagged.stderrText, "打回循环活锁", 60_000);
      const escalation = flagged.stderrText();
      expect(escalation).toContain("已打回 2 代");
      expect(escalation).toContain("预算 2 代");
      // dispatch 侧停派（mx4 打回修复 F1：绝对计数）：预算触顶的 unit 全程零派发。
      // 相对形态（escalation 后计数不增长）对「断开 computeDispatchTargets 的预算
      // 传参后首轮误派 designer、随后被派发 gate 冻结」的时序掩盖不敏感（verifier
      // 红性组二实证 16 用例全绿溜过）；绝对形态下 dispatch 侧任何一次派发即红
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(
        countDispatches(flagged, "demo"),
        "deadlock 停派 = 全程零派发（dispatch 侧同样吃注入预算）",
      ).toBe(0);
    } finally {
      flagged.child.kill("SIGTERM");
      await waitExit(flagged, 10_000);
    }

    // 阶段二：同账本默认配置（预算 10）→ 不转人工，specFixPending 正常派 designer；
    // 多轮 poll 后 stderr 仍无转人工文案——flag 的作用域仅限注入它的 runner 进程
    const unflagged = startRunner(repoDir, "demo");
    try {
      await waitText(unflagged.stdoutText, "spec-review fail——派 designer 按打回意见修 spec 重提", 60_000);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(unflagged.stderrText(), "默认 10 下 2 代打回不触发转人工").not.toContain("打回循环活锁");
    } finally {
      unflagged.child.kill("SIGTERM");
      await waitExit(unflagged, 10_000);
    }
  }, 90_000);
});

// ================================================================
// D3：flag 校验三态（0 / -1 / abc → exit 1；1 合法）
// ================================================================

describe("mx-4 D3 flag 校验：--max-spec-rejects 须为正整数 ≥1", () => {
  it("0 → exit 1 + 可操作文案（含合法范围与默认值）", () => {
    const repoDir = makeScenario("d3-zero", "demo");
    const res = runCli(repoDir, ["run", "--root", "demo", "--max-spec-rejects", "0"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("--max-spec-rejects");
    expect(res.stderr).toContain("正整数");
    expect(res.stderr).toContain("恢复动作");
    expect(res.stderr).toContain("默认 10");
  });

  it("-1 → exit 1 + 可操作文案（minimist 拆解为裸 flag，校验同样拒绝）", () => {
    const repoDir = makeScenario("d3-neg", "demo");
    // `-1` 经 minimist 解析为独立 flag（"1": true），--max-spec-rejects 收到裸
    // boolean true——parsePositiveIntFlag 对非数字形态报错，负值不静默放行
    const res = runCli(repoDir, ["run", "--root", "demo", "--max-spec-rejects", "-1"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("--max-spec-rejects");
    expect(res.stderr).toContain("正整数");
    expect(res.stderr).toContain("恢复动作");
  });

  it("abc → exit 1 + 可操作文案（原文回显）", () => {
    const repoDir = makeScenario("d3-abc", "demo");
    const res = runCli(repoDir, ["run", "--root", "demo", "--max-spec-rejects", "abc"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--max-spec-rejects "abc"');
    expect(res.stderr).toContain("正整数");
    expect(res.stderr).toContain("恢复动作");
  });

  it("1 合法（最严：首代打回即转人工）——1 代打回 + 预算 1 → escalation 已打回 1 代", async () => {
    const repoDir = makeScenario("d3-one", "demo");
    appendGenerations(ledgerOf(repoDir), "demo", 1);
    const runner = startRunner(repoDir, "demo", ["--max-spec-rejects", "1"]);
    try {
      await waitText(runner.stderrText, "打回循环活锁", 60_000);
      const escalation = runner.stderrText();
      expect(escalation).toContain("已打回 1 代");
      expect(escalation).toContain("预算 1 代");
    } finally {
      runner.child.kill("SIGTERM");
      await waitExit(runner, 10_000);
    }
  }, 60_000);

  // ---- 非整数形态（mx4 打回修复 F2：Number.isInteger 收口） ----

  it("0.5 / 2.5（minimist 数值强转的非整数）→ exit 1：整数校验不被小数形态绕过", () => {
    const repoDir = makeScenario("d3-frac", "demo");
    for (const raw of ["0.5", "2.5"]) {
      const res = runCli(repoDir, ["run", "--root", "demo", "--max-spec-rejects", raw]);
      expect(res.code, `--max-spec-rejects ${raw} 应 exit 1（非整数量级）`).toBe(1);
      expect(res.stderr).toContain("--max-spec-rejects");
      expect(res.stderr).toContain("正整数");
      expect(res.stderr).toContain("恢复动作");
    }
  });

  it("1e2（minimist 强转为整数 100）合法：启动日志 max-spec-rejects=100，2 代打回不转人工", async () => {
    const repoDir = makeScenario("d3-sci", "demo");
    appendGenerations(ledgerOf(repoDir), "demo", 2);
    const runner = startRunner(repoDir, "demo", ["--max-spec-rejects", "1e2"]);
    try {
      // 书写形态是科学计数法，量级是整数（100）→ 保留合法（拒绝的是非整数量级）
      await waitText(runner.stdoutText, "max-spec-rejects=100", 60_000);
      await waitText(runner.stdoutText, "spec-review fail——派 designer 按打回意见修 spec 重提", 60_000);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(runner.stderrText(), "2 代 < 预算 100：不判活锁").not.toContain("打回循环活锁");
    } finally {
      runner.child.kill("SIGTERM");
      await waitExit(runner, 10_000);
    }
  }, 60_000);

  it("--max-idle-ms 0.5 → exit 1（共用解析器顺带收紧：正小数毫秒拒绝，与「正整数」文案一致）", () => {
    const repoDir = makeScenario("d3-idle-frac", "demo");
    const res = runCli(repoDir, ["run", "--root", "demo", "--max-idle-ms", "0.5"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("--max-idle-ms");
    expect(res.stderr).toContain("正整数");
    expect(res.stderr).toContain("恢复动作");
  });
});

// ================================================================
// D4：只读默认语义（cw frontier 无 flag 概念，恒用默认 10）
// ================================================================

describe("mx-4 D4 只读默认语义：frontier 对 5 代打回显示 specFixPending 不误报", () => {
  it("5 代打回 → 文本视图 specReviewDeadlock 为 (无)、specFixPending 含该 unit；--json 同口径", () => {
    const repoDir = makeScenario("d4-readonly", "demo");
    appendGenerations(ledgerOf(repoDir), "demo", 5);

    const text = runCli(repoDir, ["frontier"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("specReviewDeadlock:\n  (无)");
    expect(text.stdout).toContain("specFixPending:\n  demo");

    const groups = frontierGroups(repoDir);
    expect(groups.specReviewDeadlock).toEqual([]);
    expect(groups.specFixPending).toContain("demo");
  });
});

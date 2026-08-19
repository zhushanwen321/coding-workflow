/**
 * mx-3 单测 G1-G4 + S1-S3（mx3-acceptance §5 G 系 / spawn session 保留）。
 * G 系：真实 runner 子进程（node dist/cli.js run --spawn human）+ 直写真实账本
 * + tmp + 隔离 CW_HOME，零 mock；S 系：真实 pi 子进程微任务（u6c 真实 E2E 同款
 * 形态，PATH 无 pi 时 skip）。
 *
 *   G1 同代双 fail 不 deadlock（§5.3 场景重演）：同版 spec 两条 role=reviewer
 *      fail（间隔无新 SpecSubmitted）→ 无 specReviewDeadlock、specFixPending
 *      成立派 designer、无 escalation
 *   G2 跨代双 fail deadlock（ping-pong 保持，MF2 锚：重提不清零）：fail → 新
 *      SpecSubmitted → fail → deadlock 转人工 + 全程零派发（绝对计数，mx4 打回
 *      修复 F1）
 *      （mx4 迁移：默认预算 10，注入 --max-spec-rejects 2 快速构造 2 代触顶）
 *   G3 三代收敛上限：fail → 重提 → fail → 重提 → fail → 第三代计入（已打回
 *      3 代 ≥ 注入阈值 2）且 deadlock escalation 不重复（去重断言并入）
 *      （mx4 迁移：默认预算 10，注入 --max-spec-rejects 2 快速构造）
 *   G4 escalation 去重：deadlock 触发轮 stderr 只出现一次完整文案；跨 unit 的
 *      不同 escalation 各自打印（mx4 迁移：2 代打回场景，注入阈值 2）
 *   S1 session 落盘：真实 pi spawn（微任务 brief）后 artifactDir 存在 *.jsonl
 *      session 文件，内容含 toolCall 事件与 brief 触发的命令原文
 *   S2 参数与命名：spawn 命令行含 --session-dir <artifactDir> 与
 *      --name <unitId>-<role>，不再含 --no-session
 *   S3 多 spawn 不冲突：同 unit 同 role 两次真实 spawn 后两个 session 文件并存
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../src/events/types.js";
import { buildPiCommand, createPiAdapter } from "../src/runner/spawn/pi.js";
import type { AgentSpawnRequest } from "../src/runner/spawn/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const CLI_PATH = join(DIST_ROOT, "cli.js");
if (!existsSync(CLI_PATH)) {
  throw new Error("tests/mx3-generation-count 需要 dist/（先 npm run build；npm test 的 pretest 已含）");
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-mx3-gen-"));
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

// ---- fixture 基建 ----

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
  gitRun(repoDir, ["config", "user.email", "cw-mx3g@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-mx3g"]);
  writeFileSync(join(repoDir, "brief.md"), `# ${rootId} 任务书（mx3 fixture）\n`);
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

function appendReviewerPass(ledger: EventLedger, unitId: string): void {
  ledger.append("VerdictSubmitted", {
    unitId,
    verdictKind: "spec-review",
    verdict: "pass",
    role: "reviewer",
  });
}

// ---- runner 子进程基建（G 系，mx1 同款） ----

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

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

/** frontier --json 的 deadlock/fix 分组（与派发判定同一出处） */
function frontierGroups(repoDir: string): { specReviewDeadlock: string[]; specFixPending: string[] } {
  const res = runCli(repoDir, ["frontier", "--json"]);
  expect(res.code, `frontier 应成功（stderr: ${res.stderr}）`).toBe(0);
  return JSON.parse(res.stdout) as { specReviewDeadlock: string[]; specFixPending: string[] };
}

/** 全部派发行为的计数（deadlock 停派断言的输入） */
function countDispatches(runner: RunnerCapture, unitId: string): number {
  const needles = [
    `派发 designer → unit "${unitId}"`,
    `派发 reviewer → unit "${unitId}"`,
    `派发 developer → unit "${unitId}"`,
  ];
  return needles.reduce((sum, needle) => sum + occurrences(runner.stdoutText(), needle), 0);
}

// ================================================================
// G1：同代双 fail 不 deadlock（§5.3 场景重演）
// ================================================================

describe("mx-3 G1 同代双 fail 不 deadlock：试探 + 正式只计 1 代打回", () => {
  it("同版 spec 两条 role=reviewer fail（无新 SpecSubmitted）→ specFixPending 派 designer，无 escalation", async () => {
    const repoDir = makeScenario("g1-same-gen", "demo");
    const ledger = ledgerOf(repoDir);
    appendSpec(ledger, "demo", "v1");
    appendReviewerFail(ledger, "demo", "试探性提交（comment=test 形态）");
    appendReviewerFail(ledger, "demo", "正式意见：缺 A3 单元级回归用例");

    // 投影口径：无 deadlock、specFixPending 成立
    const groups = frontierGroups(repoDir);
    expect(groups.specReviewDeadlock).not.toContain("demo");
    expect(groups.specFixPending).toContain("demo");

    const runner = startRunner(repoDir, "demo");
    try {
      // specFixPending 派 designer（designer 获得修复机会——不被试探耗尽额度误杀）
      await waitText(runner.stdoutText, "spec-review fail——派 designer 按打回意见修 spec 重提", 10_000);
      // 无 escalation（多轮 poll 后 stderr 仍无转人工文案）
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(runner.stderrText()).not.toContain("打回循环活锁");
    } finally {
      runner.child.kill("SIGTERM");
      await waitExit(runner, 10_000);
    }
  }, 60_000);
});

// ================================================================
// G2：跨代双 fail deadlock（MF2 锚：重提不清零）
// ================================================================

describe("mx-3 G2 跨代双 fail deadlock：fail → 重提 → fail = 2 代打回", () => {
  it("fail → 新 SpecSubmitted → fail → specReviewDeadlock 转人工（escalation 含两代意见）+ 停止派发", async () => {
    // mx4 迁移：默认打回预算 10，注入 --max-spec-rejects 2 快速构造 2 代触顶
    //（语义回归保持：跨代 fail 累计、重提不清零、触顶转人工停派）
    const repoDir = makeScenario("g2-cross-gen", "demo");
    const ledger = ledgerOf(repoDir);
    appendSpec(ledger, "demo", "v1");
    appendReviewerFail(ledger, "demo", "第一代打回：A2 标题不达意");
    appendSpec(ledger, "demo", "v2"); // designer 修 spec 重提（代数锚点）
    appendReviewerFail(ledger, "demo", "第二代打回：本质问题未解决");

    // 只读命令恒用默认 10（mx4 §4：转人工预算是运行策略，默认值是投影展示语义）
    //——2 代在 frontier 默认口径下是 specFixPending 而非 deadlock
    const groups = frontierGroups(repoDir);
    expect(groups.specReviewDeadlock).not.toContain("demo");
    expect(groups.specFixPending).toContain("demo");

    const runner = startRunner(repoDir, "demo", ["--max-spec-rejects", "2"]);
    try {
      await waitText(runner.stderrText, "打回循环活锁", 10_000);
      const escalation = runner.stderrText();
      expect(escalation).toContain("转人工");
      expect(escalation).toContain("已打回 2 代");
      expect(escalation).toContain("第一代打回：A2 标题不达意");
      expect(escalation).toContain("第二代打回：本质问题未解决");
      // 停止派发（mx4 打回修复 F1：相对计数 → 绝对计数）：预算触顶的 unit 全程
      // 零派发。相对形态（escalation 后计数不增长）对「断开 dispatch 侧预算传参
      // 后首轮误派 designer、随后被派发 gate 冻结」的时序掩盖不敏感（verifier
      // 红性组二实证 16 用例全绿溜过）；绝对形态下 dispatch 侧任何一次派发即红
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(
        countDispatches(runner, "demo"),
        "deadlock 停派 = 全程零派发（dispatch 侧同样吃注入预算）",
      ).toBe(0);
      // MF2 教训锚：重提发生过（specs=2）但代数累计不清零
      const specs = ledgerOf(repoDir).readAll().filter((ev) => ev.type === "SpecSubmitted");
      expect(specs.length).toBeGreaterThanOrEqual(2);
    } finally {
      runner.child.kill("SIGTERM");
      await waitExit(runner, 10_000);
    }
  }, 60_000);
});

// ================================================================
// G3：三代收敛上限（去重断言并入）
// ================================================================

describe("mx-3 G3 三代打回：代数=3 ≥2 仍 deadlock 且 escalation 不重复", () => {
  it("fail → 重提 → fail → 重提 → fail → 已打回 3 代；完整文案在 stderr 只出现一次", async () => {
    // mx4 迁移：默认打回预算 10，注入 --max-spec-rejects 2 快速构造（3 代 ≥ 注入阈值 2）
    const repoDir = makeScenario("g3-three-gen", "demo");
    const ledger = ledgerOf(repoDir);
    appendSpec(ledger, "demo", "v1");
    appendReviewerFail(ledger, "demo", "第一代打回意见");
    appendSpec(ledger, "demo", "v2");
    appendReviewerFail(ledger, "demo", "第二代打回意见");
    appendSpec(ledger, "demo", "v3");
    appendReviewerFail(ledger, "demo", "第三代打回意见");

    // 只读命令恒用默认 10（mx4）：3 代在 frontier 默认口径下仍是 specFixPending
    const groups = frontierGroups(repoDir);
    expect(groups.specReviewDeadlock).not.toContain("demo");
    expect(groups.specFixPending).toContain("demo");

    const runner = startRunner(repoDir, "demo", ["--max-spec-rejects", "2"]);
    try {
      await waitText(runner.stderrText, "打回循环活锁", 10_000);
      expect(runner.stderrText()).toContain("已打回 3 代");
      // 去重：足够多轮 poll（≥7 轮）后完整 escalation 文案仍只出现一次
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const escalation = runner.stderrText();
      expect(occurrences(escalation, "打回循环活锁"), "同 unit 的 deadlock escalation 不重复打印").toBe(1);
      expect(occurrences(escalation, "已打回 3 代")).toBe(1);
    } finally {
      runner.child.kill("SIGTERM");
      await waitExit(runner, 10_000);
    }
  }, 60_000);
});

// ================================================================
// G4：escalation 去重（跨 unit 各自打印）
// ================================================================

describe("mx-3 G4 escalation 去重：同 unit 单次、跨 unit 各自打印", () => {
  it("两个 unit 各自 2 代打回 → 各自完整文案恰好一次，互不吞并", async () => {
    // mx4 迁移：默认打回预算 10，注入 --max-spec-rejects 2 快速构造（2 代触顶）
    const repoDir = makeScenario("g4-two-units", "root");
    const ledger = ledgerOf(repoDir);
    // root：spec-frozen 且 split 两叶（内部节点等待子 verified，自身不产生噪音派发）
    ledger.append("SpecSubmitted", {
      unitId: "root",
      specHash: "root-spec-g4",
      acceptance: [...ACCEPTANCE],
      contracts: [],
      split: [
        { unitId: "leaf-dd1", dependsOn: [] },
        { unitId: "leaf-dd2", dependsOn: [] },
      ],
    });
    appendReviewerPass(ledger, "root");
    for (const [leaf, mark] of [["leaf-dd1", "DD1"], ["leaf-dd2", "DD2"]] as const) {
      ledger.append("UnitCreated", { unitId: leaf, parentId: "root", briefRef: `brief-${leaf}.md` });
      appendSpec(ledger, leaf, "v1");
      appendReviewerFail(ledger, leaf, `${mark} 第一代打回意见`);
      appendSpec(ledger, leaf, "v2");
      appendReviewerFail(ledger, leaf, `${mark} 第二代打回意见`);
    }

    const runner = startRunner(repoDir, "root", ["--max-spec-rejects", "2"]);
    try {
      await waitText(runner.stderrText, "已打回 2 代", 10_000);
      await waitText(runner.stderrText, '"leaf-dd1"', 10_000);
      await waitText(runner.stderrText, '"leaf-dd2"', 10_000);
      // 去重窗口：≥7 轮 poll 后各自文案仍恰好一次
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const escalation = runner.stderrText();
      expect(occurrences(escalation, 'unit "leaf-dd1" 的 spec-review 已打回 2 代')).toBe(1);
      expect(occurrences(escalation, 'unit "leaf-dd2" 的 spec-review 已打回 2 代')).toBe(1);
      expect(occurrences(escalation, "打回循环活锁"), "两个 unit 各出声一次").toBe(2);
      expect(escalation).toContain("DD1 第一代打回意见");
      expect(escalation).toContain("DD2 第二代打回意见");
    } finally {
      runner.child.kill("SIGTERM");
      await waitExit(runner, 10_000);
    }
  }, 60_000);
});

// ================================================================
// S1-S3：spawn session 保留（真实 pi 子进程）
// ================================================================

describe("mx-3 spawn session 保留（真实 pi 后端）", () => {
  // 跳过条件（u6c 同款）：环境无 pi 时 skip 并 warn；本地 pi 可用则真实跑
  const piResolvable = spawnSync("which", ["pi"], { encoding: "utf8" }).status === 0;
  const itRealPi = piResolvable ? it : it.skip;
  if (!piResolvable) {
    console.warn("mx3 S 系: PATH 上无 pi，真实 E2E 条跳过（本地 pi 可用环境不 skip）");
  }

  /** 真实 pi 微任务请求 fixture（u6c 真实 E2E 同款：PI_OFFLINE + tmp artifactDir） */
  function piProbeReq(overrides?: Partial<AgentSpawnRequest>): AgentSpawnRequest {
    const workdir = join(tmpRoot, "pi-probe-work");
    mkdirSync(workdir, { recursive: true });
    return {
      role: "reviewer",
      unitId: "mx3-probe",
      workdir,
      projectCwd: join(tmpRoot, "pi-probe-project"),
      artifactDir: join(tmpRoot, "pi-probe-topic"),
      briefPath: join(workdir, "brief.md"),
      timeoutMs: 110_000,
      env: { PI_OFFLINE: "1" },
      ...overrides,
    };
  }

  it("S2 参数与命名：buildPiCommand 含 --session-dir <artifactDir> 与 --name <unitId>-<role>，不含 --no-session", () => {
    const req = piProbeReq();
    const { command, args } = buildPiCommand(req, "probe/model");
    expect(command).toBe("pi");
    const joined = args.join(" ");
    expect(args).toContain("--session-dir");
    expect(args[args.indexOf("--session-dir") + 1]).toBe(req.artifactDir);
    expect(args).toContain("--name");
    expect(args[args.indexOf("--name") + 1]).toBe("mx3-probe-reviewer");
    expect(joined).not.toContain("--no-session");
    // brief 位置参数形态不变（u6c 锁定）
    expect(args).toContain(`@${req.briefPath}`);
  });

  itRealPi(
    "S1 session 落盘：真实 pi 微任务后 artifactDir 存在 *.jsonl，内容含 toolCall 与命令原文",
    async () => {
      const req = piProbeReq({ unitId: "mx3-s1" });
      writeFileSync(
        req.briefPath,
        "请执行 shell 命令：echo SESSION-PROBE（必须真实执行该命令），然后只回复 DONE",
      );
      const handle = await createPiAdapter().spawn(req);
      const result = await handle.wait();
      // stderr 可能有本地扩展噪音，判定只看 exitCode + stdout（u6c 实测事实）
      expect(result.exitCode).toBe(0);
      // session JSONL 随 spawn 产物落 artifactDir（与 brief/stdout/stderr 同处）
      const sessionFiles = readdirSync(req.artifactDir).filter((name) => name.endsWith(".jsonl"));
      expect(sessionFiles.length, "artifactDir 下应存在 session JSONL 文件").toBeGreaterThanOrEqual(1);
      const sessionText = sessionFiles
        .map((name) => readFileSync(join(req.artifactDir, name), "utf-8"))
        .join("\n");
      // M4 gate 追查场景的回归锚：toolCall 事件在场 + 命令原文逐字可查
      expect(sessionText).toContain("toolCall");
      expect(sessionText).toContain("SESSION-PROBE");
    },
    180_000,
  );

  itRealPi(
    "S3 多 spawn 不冲突：同 unit 同 role 两次真实 spawn → artifactDir 两个 session 文件并存",
    async () => {
      const req = piProbeReq({ unitId: "mx3-s3" });
      writeFileSync(req.briefPath, "请执行 shell 命令：echo SESSION-PROBE-2（必须真实执行），然后只回复 DONE");
      for (let i = 0; i < 2; i += 1) {
        const handle = await createPiAdapter().spawn(req);
        const result = await handle.wait();
        expect(result.exitCode, `第 ${i + 1} 次 spawn 应 exit 0`).toBe(0);
      }
      const sessionFiles = readdirSync(req.artifactDir).filter((name) => name.endsWith(".jsonl"));
      expect(
        sessionFiles.length,
        "两次 spawn 各自新 session 文件（时间戳+uuid 命名天然不冲突，无覆盖）",
      ).toBeGreaterThanOrEqual(2);
    },
    300_000,
  );
});

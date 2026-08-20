/**
 * wt-5 收口波：worktree 隔离核心声明的永久对抗测试
 * （docs/rewrite/acceptance/wt5-acceptance.md §4；设计 v3 §4 场景 1/3）。
 *
 *   C1 并发污染对抗（场景 1，G1）：tmp git 项目，root spec 声明 unit-a/unit-b
 *      两子（验收 command 全部真实可执行轻量命令），账本预置三 unit 全部
 *      spec-frozen → 首轮 frontier 即两 developer。fake adapter（u7-e2e/fx3 模式）
 *      以 maxConcurrency=2 驱动：两 developer worker（真实 node 子进程）经
 *      ready-rendezvous 同步屏障后并行——各自在自己 worktree 改 src/app.ts 的
 *      不同区域（写入各自标记行）、git add+commit、以 bash 内联
 *      CW_PROJECT_DIR 前缀真实跑 dist/cli.js evidence submit + verify。断言：
 *      账本 evidence commit 的 diff 体各自只含自己的标记行（互不混卷）；
 *      两 worktree 派发期间并存（git worktree list 快照）；项目 cwd 全程
 *      （25ms 轮询）无 .cw-spawn/ 新增、src/app.ts 原样；全链推进到两 unit
 *      closed + root 集成 pass，root 分支含两标记行。
 *
 *   C2 verify 真值与 cwd 状态无关（场景 3，G3/P7 勾验）：tmp git 项目 + 某 unit
 *      的账本 commit 与冻结验收；把项目 cwd 改脏（tracked 修改 + untracked
 *      新增）→ 子进程跑 cw verify（exit 0 pass）→ 检出树与账本 commit 一致
 *      （三条验收在检出树内以 PASS 收场，含 checkout 内 git status 干净自证）
 *      且 cwd 脏改动原样保留。
 *
 * 全部真实环境零 mock：真实 tmp git 仓库 + 真实子进程（dist/cli.js）+ 隔离
 * CW_HOME/CW_WORKTREE_HOME。注意：直接 `npx vitest run 本文件` 不触发 pretest，
 * 需先 `npm run build`（`npm test` 的 pretest 已含）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

import { afterAll, describe, expect, it } from "vitest";

import type {
  AcceptanceItem,
  EvidenceSubmittedPayload,
  SplitEntry,
  VerifyRanPayload,
} from "../dist/events/types.js";
import { ledgerForCwd } from "../dist/handlers/common.js";
import { loadLedger, unitStatus } from "../dist/readonly/load.js";
import { runLoop } from "../dist/runner/loop.js";
import { spawnProcess } from "../dist/runner/spawn/lifecycle.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
} from "../dist/runner/spawn/types.js";
import { unitBranchName } from "../dist/runner/worktree.js";
import { evidenceDir, worktreePath } from "../dist/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const CLI_PATH = join(DIST_ROOT, "cli.js");
if (!existsSync(CLI_PATH)) {
  throw new Error(`tests/wt5 需要 ${CLI_PATH}（先 npm run build；npm test 的 pretest 已含）`);
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-wt5-"));
const cwHome = join(tmpRoot, "cw-home");
process.env.CW_HOME = cwHome;
// 派发 workdir 在 unit worktree（wt-2 起），隔离 worktree 根（与 CW_HOME 同款）
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8", timeout: 30_000 });
  if (res.error !== undefined) {
    const timedOut = (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    throw new Error(
      `git ${args.join(" ")} ${timedOut ? "超时被杀(30s 上限)" : "执行失败"}: ${res.error.message}`,
    );
  }
  if (res.status !== 0) {
    throw new Error(`git -C ${repoDir} ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 捕获 runLoop 的 stdout/stderr（进程内直调，透传 write 回调——u7/fx3/wt4 同款） */
async function captureStd(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const collector = (chunks: string[]): typeof process.stdout.write =>
    ((chunk: unknown, cb?: (err?: Error | null) => void) => {
      chunks.push(String(chunk));
      // 透传回调：loop.ts 的 flushOutputs 退出屏障依赖 write 回调等待 flush
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

function statusOf(repoDir: string, unitId: string): string {
  const unit = loadLedger(repoDir).projection.units.get(unitId);
  if (unit === undefined) {
    throw new Error(`unit ${unitId} 不在账本（断言前置失败）`);
  }
  return unitStatus(unit);
}

/** 账本内某 unit 的（首条）build 证据 commit——审计断言的唯一权威来源 */
function evidenceCommitOf(repoDir: string, unitId: string): string {
  const hit = ledgerForCwd(repoDir)
    .readAll()
    .find((ev) => ev.type === "EvidenceSubmitted" && ev.payload.unitId === unitId);
  if (hit === undefined) {
    throw new Error(`账本缺 ${unitId} 的 EvidenceSubmitted（断言前置失败）`);
  }
  return (hit.payload as EvidenceSubmittedPayload).commit;
}

// ================================================================
// 验收 fixture 常量（C1）
// ================================================================

const ROOT_ID = "feat";
const MARK_A = "MARK_UNIT_A";
const MARK_B = "MARK_UNIT_B";
const MARKER_LINE_A = `export const ${MARK_A} = "unit-a-marker";`;
const MARKER_LINE_B = `export const ${MARK_B} = "unit-b-marker";`;

/** 两子验收目标的公共战场：unit-a 改 region-a 区、unit-b 改 region-b 区（集成 merge 干净的前提） */
const BASE_APP_TS = [
  "// region-unit-a",
  'export const partA = "a";',
  "",
  "// region-unit-b",
  'export const partB = "b";',
  "",
].join("\n");

/**
 * e2e-real 标记行命令（u4b 起判定输入是 `<id> PASS|FAIL` 标记行而非 exit code；
 * exit 与标记行保持一致）：src/app.ts 含全部指定标记 → PASS，缺任一 → FAIL+exit 1。
 */
const markerAcceptanceCmd = (id: string, ...markers: readonly string[]): string => {
  const check = markers.map((m) => `s.includes('${m}')`).join("&&");
  return `node -e "const s=require('fs').readFileSync('src/app.ts','utf8');if(${check}){console.log('${id} PASS')}else{console.log('${id} FAIL');process.exit(1)}"`;
};

/** unit 级 vitest JSON 冒烟命令（u7/fx3 同款：零依赖、可在任意 checkout 真实执行） */
const vitestJsonCmd = (id: string): string =>
  `node -e "console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'${id} unit smoke',status:'passed'}]}]}))" -- --reporter=json`;

/** 子 spec 验收：自己的标记行在场（只做正向判定——集成期会在含两标记的汇聚树上重跑，不能断言对方缺席） */
const acceptanceOf = (unitId: string): AcceptanceItem[] => [
  {
    id: unitId === "unit-a" ? "A1" : "B1",
    core: true,
    title: "自己的标记行在场",
    type: "e2e-real",
    command: markerAcceptanceCmd(unitId === "unit-a" ? "A1" : "B1", unitId === "unit-a" ? MARK_A : MARK_B),
  },
  { id: unitId === "unit-a" ? "U1" : "U2", core: false, title: "unit 冒烟", type: "unit", command: vitestJsonCmd(unitId === "unit-a" ? "U1" : "U2") },
];

/** root spec 验收：两子标记行均在场——只在 merge 汇聚后的 root 分支树上可过 */
const ROOT_ACCEPTANCE: readonly AcceptanceItem[] = [
  { id: "R1", core: true, title: "两子产出均已汇聚", type: "e2e-real", command: markerAcceptanceCmd("R1", MARK_A, MARK_B) },
  { id: "U9", core: false, title: "root unit 冒烟", type: "unit", command: vitestJsonCmd("U9") },
];

/** C1 fixture：tmp git 仓库（brief + src/app.ts 两区域基线 + 一个 commit） */
function makeContamRepo(name: string): string {
  const base = join(tmpRoot, name);
  mkdirSync(join(base, "src"), { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-wt5@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-wt5"]);
  writeFileSync(join(repoDir, "brief.md"), "# wt5 C1 fixture 任务书\n");
  writeFileSync(join(repoDir, "src", "app.ts"), BASE_APP_TS);
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief + src/app.ts 基线"]);
  return repoDir;
}

/** 账本预置一个 spec-frozen unit（u7-e2e 直写模式：绕过 designer，首轮 frontier 即 developer） */
function appendSpecFrozen(
  repoDir: string,
  unitId: string,
  parentId: string | null,
  acceptance: readonly AcceptanceItem[],
  split: readonly SplitEntry[],
): void {
  const spec = { acceptance: [...acceptance], contracts: [], split: [...split] };
  const ledger = ledgerForCwd(repoDir);
  ledger.append("UnitCreated", { unitId, parentId, briefRef: join(repoDir, "brief.md") });
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: sha(JSON.stringify(spec)),
    acceptance: [...acceptance],
    contracts: [],
    split: [...split],
  });
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
}

// ---- C1 测试专用 worker（真实 node 子进程，spawnProcess 起在各自 worktree） ----

/**
 * argv: <role> <unitId> <projectCwd> <barrierDir> <peerUnitId> <markerLine>
 * developer：ready-rendezvous 屏障 → 改 src/app.ts（插入标记行）→ git add+commit
 *   → 内联 CW_PROJECT_DIR 前缀真实跑 cw evidence submit + cw verify。
 * reviewer：内联前缀真实跑 cw review submit（exec-review pass）。
 */
function writeWorkerScript(): string {
  const script = `// tests/wt5-parallel-contamination.test.ts 生成的测试专用 agent worker（真实进程，非 mock）
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CLI = ${JSON.stringify(join(DIST_ROOT, "cli.js"))};
const [, , role, unitId, projectCwd, barrierDir, peerUnitId, markerLine] = process.argv;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 内联 CW_PROJECT_DIR 前缀真实跑 cw 子进程（设计 D3 的 human 口径逐字同构：
// CW_PROJECT_DIR="<项目cwd>" cw …——账本锚定经 env 生效，无 shell 状态依赖）
const runCw = (args) => {
  const cmdline =
    'CW_PROJECT_DIR="' + projectCwd + '" exec "' + process.execPath + '" "' + CLI + '" ' + args.join(" ");
  const res = spawnSync("bash", ["-c", cmdline], { cwd: process.cwd(), encoding: "utf-8", timeout: 120_000 });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(
      "wt5-worker: cw " + args.join(" ") + " 失败(exit " + String(res.status) + ")\\nstdout: " +
        (res.stdout ?? "") + "\\nstderr: " + (res.stderr ?? ""),
    );
  }
  return res;
};

const git = (args) => {
  const res = spawnSync("git", ["-C", process.cwd(), ...args], { encoding: "utf-8", timeout: 30_000 });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error("wt5-worker: git " + args.join(" ") + " 失败: " + (res.stderr ?? res.error.message));
  }
  return (res.stdout ?? "").trim();
};

if (role === "developer") {
  // 同步屏障（ready-rendezvous）：两 developer 都落 ready 文件后才放行——保证后续
  // 文件操作时间窗必然重叠（C1 并行对抗的前提）
  mkdirSync(barrierDir, { recursive: true });
  writeFileSync(join(barrierDir, "ready-" + unitId), String(process.pid) + "\\n");
  const peerReady = join(barrierDir, "ready-" + peerUnitId);
  const deadline = Date.now() + 30_000;
  while (!existsSync(peerReady)) {
    if (Date.now() > deadline) {
      throw new Error("wt5-worker: developer " + unitId + " 屏障超时（peer " + peerUnitId + " 未就位）");
    }
    await sleep(20);
  }
  // 文件操作窗口开始：改自己 worktree 的 src/app.ts（process.cwd() = 本 unit 的 worktree）
  const start = Date.now();
  const appPath = join(process.cwd(), "src", "app.ts");
  const anchor = "// region-" + unitId;
  const content = readFileSync(appPath, "utf-8");
  const patched = content.replace(anchor, anchor + "\\n" + markerLine);
  if (patched === content) {
    throw new Error("wt5-worker: developer " + unitId + " 未命中 anchor: " + anchor);
  }
  writeFileSync(appPath, patched);
  await sleep(400); // 真实工作时长：拉宽窗口，让重叠断言对调度抖动稳健
  git(["add", "src/app.ts"]); // 手术式提交：只入自己的目标文件
  git(["commit", "-m", "build(" + unitId + "): marker line"]);
  const commit = git(["rev-parse", "HEAD"]);
  writeFileSync(
    join(barrierDir, "window-" + unitId + ".json"),
    JSON.stringify({ start, end: Date.now(), commit }),
  );
  // 真实证据链：evidence submit（内联前缀）→ verify（干净重跑，pass 使 unit verified）。
  // rv-4 语义迁移：fixture 的 marker 验收是内联恒真形态（不引用实现产物），红阶段
  // 默认执行下无区分力必挂——wt5 关注并发污染对抗，用 --no-red-phase 逃生口
  runCw([
    "evidence", "submit", "--kind", "build", "--unit", unitId,
    "--commit", commit, "--run-id", "run-" + unitId + "-1", "--file", "src/app.ts",
  ]);
  runCw(["verify", "--unit", unitId, "--no-red-phase"]);
  console.log("wt5-worker-done developer " + unitId + " commit " + commit);
} else if (role === "reviewer") {
  // rv-2 exec-review refs 必填适配（方案 C）：从账本读该 unit 真实入账的 runId 后
  // 引用——内部节点（root）无 EvidenceSubmitted，执行证据 = 集成 VerifyRan
  //（cw status --unit 的 verifyRuns 段取最后一条），禁止硬编码假 runId
  const statusRes = runCw(["status", "--unit", unitId]);
  const lines = (statusRes.stdout ?? "").split("\\n");
  const verifyIdx = lines.findIndex((l) => l.trim() === "verifyRuns:");
  if (verifyIdx === -1) {
    throw new Error("wt5-worker: status --unit " + unitId + " 无 verifyRuns 段（fixture 前置失败）");
  }
  const runIdLines = lines.slice(verifyIdx + 1).filter((l) => l.trim().startsWith("- runId="));
  const lastRunId =
    runIdLines.length > 0
      ? runIdLines[runIdLines.length - 1].trim().slice("- runId=".length).split(" ")[0]
      : undefined;
  if (lastRunId === undefined) {
    throw new Error("wt5-worker: unit " + unitId + " 无已入账 VerifyRan runId（refs 无从引用）");
  }
  runCw(["review", "submit", "--unit", unitId, "--verdict-kind", "exec-review", "--verdict", "pass", "--evidence-refs", lastRunId]);
  console.log("wt5-worker-done reviewer " + unitId + " refs " + lastRunId);
} else {
  throw new Error("wt5-worker: 意外 role " + role + "（fixture 全部 unit 预置 spec-frozen，designer 不应被派发）");
}
`;
  const path = join(tmpRoot, "wt5-worker.mjs");
  writeFileSync(path, script);
  return path;
}

const WORKER_PATH = writeWorkerScript();

// ---- C1 测试专用适配器（spawnProcess 包装 + 派发时点现场快照供断言） ----

interface DeveloperDispatchRecord {
  unitId: string;
  at: number;
}

function makeContamAdapter(barrierDir: string): {
  adapter: AgentSpawnAdapter;
  developerDispatches(): readonly DeveloperDispatchRecord[];
  /** 每次派发时点的 git worktree list --porcelain 快照（两 worktree 并存的证据） */
  worktreeListSnapshots(): readonly string[];
} {
  const developerDispatches: DeveloperDispatchRecord[] = [];
  const worktreeLists: string[] = [];
  return {
    adapter: {
      name: "wt5-contamination-script",
      spawn: (req: AgentSpawnRequest): Promise<SpawnHandle> => {
        worktreeLists.push(gitRun(req.projectCwd, ["worktree", "list", "--porcelain"]));
        if (req.role === "developer") {
          developerDispatches.push({ unitId: req.unitId, at: Date.now() });
        }
        const markerLine =
          req.unitId === "unit-a" ? MARKER_LINE_A : req.unitId === "unit-b" ? MARKER_LINE_B : "";
        const peerUnitId = req.unitId === "unit-a" ? "unit-b" : "unit-a";
        return Promise.resolve(
          spawnProcess({
            command: process.execPath,
            args: [WORKER_PATH, req.role, req.unitId, req.projectCwd, barrierDir, peerUnitId, markerLine],
            cwd: req.workdir,
            timeoutMs: req.timeoutMs,
            // fx-4：产物路径从 req.artifactDir 拼装（run 级 topic 目录）
            stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
            stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
          }),
        );
      },
    },
    developerDispatches: () => developerDispatches,
    worktreeListSnapshots: () => worktreeLists,
  };
}

/** 项目 cwd 污染监视（C1「全程」断言的载体）：25ms 轮询 .cw-spawn/（fx-4 起更不该出现——产物已迁 topic）与 src/app.ts 原样性 */
function startCwdPollutionWatch(repoDir: string): { stop(): string[] } {
  const violations: string[] = [];
  const appPath = join(repoDir, "src", "app.ts");
  const timer = setInterval(() => {
    if (existsSync(join(repoDir, ".cw-spawn"))) {
      violations.push(`t=${Date.now()} 项目 cwd 出现 .cw-spawn/`);
    }
    let content: string;
    try {
      content = readFileSync(appPath, "utf-8");
    } catch {
      violations.push(`t=${Date.now()} 项目 cwd src/app.ts 不可读`);
      return;
    }
    if (content !== BASE_APP_TS) {
      violations.push(`t=${Date.now()} 项目 cwd src/app.ts 被写入（标记行/脏改外溢）`);
    }
  }, 25);
  return {
    stop: () => {
      clearInterval(timer);
      return violations;
    },
  };
}

/** worker 落盘的文件操作窗口（ms epoch）：start=标记行写入前，end=commit 完成 */
interface MutationWindow {
  start: number;
  end: number;
  commit: string;
}

function readWindow(path: string): MutationWindow {
  return JSON.parse(readFileSync(path, "utf-8")) as MutationWindow;
}

// ================================================================
// C1 并发污染对抗
// ================================================================

describe("wt5 C1 并发污染对抗（场景 1，G1）", () => {
  it("两 developer 经同步屏障并行改 src/app.ts 不同区域：commit 互不混卷、worktree 并存、项目 cwd 零污染、全链 closed + root 集成 pass", async () => {
    const repoDir = makeContamRepo("contam");
    appendSpecFrozen(repoDir, ROOT_ID, null, ROOT_ACCEPTANCE, [
      { unitId: "unit-a", dependsOn: [] },
      { unitId: "unit-b", dependsOn: [] },
    ]);
    appendSpecFrozen(repoDir, "unit-a", ROOT_ID, acceptanceOf("unit-a"), []);
    appendSpecFrozen(repoDir, "unit-b", ROOT_ID, acceptanceOf("unit-b"), []);
    expect(statusOf(repoDir, ROOT_ID)).toBe("spec-frozen"); // 前提：首轮 frontier 即两 developer

    const barrierDir = join(tmpRoot, "contam-barrier");
    const { adapter, developerDispatches, worktreeListSnapshots } = makeContamAdapter(barrierDir);
    const watch = startCwdPollutionWatch(repoDir);

    let captured: { code: number; out: string; err: string };
    let pollution: string[] = [];
    try {
      captured = await captureStd(() =>
        runLoop({
          rootId: ROOT_ID,
          adapter,
          cwd: repoDir,
          pollMs: 50,
          maxIdleMs: 60_000,
          maxConcurrency: 2,
        }),
      );
    } finally {
      pollution = watch.stop();
    }

    // 项目 cwd 全程零污染（25ms 轮询 + 终态复核）
    expect(pollution, "项目 cwd 污染监视记录").toEqual([]);
    expect(existsSync(join(repoDir, ".cw-spawn"))).toBe(false);
    // fx-4：worktree 内也无 .cw-spawn（产物迁 run 级 topic 目录后，worktree 只承载
    // agent 业务产出与 commit；root worktree 永不回收，终态必然可查）
    expect(existsSync(join(worktreePath(WT_HOME, repoDir, ROOT_ID), ".cw-spawn"))).toBe(false);
    expect(readFileSync(join(repoDir, "src", "app.ts"), "utf-8")).toBe(BASE_APP_TS);
    expect(gitRun(repoDir, ["status", "--porcelain"])).toBe("");

    // 全链收束：exit 0 + 三 unit closed + root 集成 pass
    expect(captured.code, `out 尾部: ${captured.out.slice(-800)}\nerr: ${captured.err.slice(-400)}`).toBe(0);
    expect(captured.out).toContain(`root "${ROOT_ID}" 已 closed`);
    expect(statusOf(repoDir, ROOT_ID)).toBe("closed");
    expect(statusOf(repoDir, "unit-a")).toBe("closed");
    expect(statusOf(repoDir, "unit-b")).toBe("closed");
    const rootUnit = loadLedger(repoDir).projection.units.get(ROOT_ID);
    const rootVerify = rootUnit?.verifyRuns.at(-1);
    expect(rootVerify?.runId).toMatch(/^integrate-/);
    expect(rootVerify?.result).toBe("pass");

    // 互不混卷（核心断言）：账本 evidence commit 的 diff 体各自只含自己的标记行，
    // 改动文件集只有 src/app.ts（手术式提交）——「commit X 是谁的」审计声明成立
    const commitA = evidenceCommitOf(repoDir, "unit-a");
    const commitB = evidenceCommitOf(repoDir, "unit-b");
    const diffA = gitRun(repoDir, ["show", commitA]);
    expect(diffA).toContain(MARK_A);
    expect(diffA, "unit-a 的 evidence commit 混入了 unit-b 的标记行").not.toContain(MARK_B);
    const diffB = gitRun(repoDir, ["show", commitB]);
    expect(diffB).toContain(MARK_B);
    expect(diffB, "unit-b 的 evidence commit 混入了 unit-a 的标记行").not.toContain(MARK_A);
    expect(gitRun(repoDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", commitA])).toBe("src/app.ts");
    expect(gitRun(repoDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", commitB])).toBe("src/app.ts");

    // worktree 物理分离：派发时点快照中曾同时出现两条 unit worktree 记录
    const wtA = worktreePath(WT_HOME, repoDir, "unit-a");
    const wtB = worktreePath(WT_HOME, repoDir, "unit-b");
    expect(wtA).not.toBe(wtB);
    expect(
      worktreeListSnapshots().some((list) => list.includes(wtA) && list.includes(wtB)),
      "git worktree list 快照中未出现两 unit worktree 并存",
    ).toBe(true);

    // 并行前提复核：两 developer 同轮派发（间隔毫秒级）+ 文件操作窗口重叠 > 0
    const dispatches = developerDispatches();
    expect(dispatches.map((d) => d.unitId).sort()).toEqual(["unit-a", "unit-b"]);
    const dispatchGap = Math.abs(dispatches[0].at - dispatches[1].at);
    const winA = readWindow(join(barrierDir, "window-unit-a.json"));
    const winB = readWindow(join(barrierDir, "window-unit-b.json"));
    const overlapMs = Math.min(winA.end, winB.end) - Math.max(winA.start, winB.start);
    console.log(
      `[wt5] developer 文件操作窗口重叠 ${overlapMs}ms（a:[${winA.start},${winA.end}] b:[${winB.start},${winB.end}]，派发间隔 ${dispatchGap}ms）`,
    );
    expect(dispatchGap).toBeLessThan(5_000);
    expect(overlapMs, `两 developer 文件操作窗口应重叠（a:[${winA.start},${winA.end}] b:[${winB.start},${winB.end}]）`).toBeGreaterThan(0);

    // root 分支汇聚两标记行（merge 后的集成树 = G5 回流载体）
    const rootBranchApp = gitRun(repoDir, ["show", `${unitBranchName(ROOT_ID, ROOT_ID)}:src/app.ts`]);
    expect(rootBranchApp).toContain(MARK_A);
    expect(rootBranchApp).toContain(MARK_B);
  }, 180_000);
});

// ================================================================
// C2 verify 真值与 cwd 状态无关（P7 勾验）
// ================================================================

const C2_UNIT_ID = "u-1";

/** C2 验收：三条 e2e-real 在检出树内自证「树 = 账本 commit」——C2A 证内容非 cwd 现状、C2B 证确为该 commit 的树、C2C 证检出树干净 */
const C2_ACCEPTANCE: readonly AcceptanceItem[] = [
  {
    id: "C2A",
    core: true,
    title: "检出内容是 commit 而非 cwd 现状",
    type: "e2e-real",
    command:
      "node -e \"const s=require('fs').readFileSync('tracked.txt','utf8');if(s.trim()==='committed-v1'){console.log('C2A PASS')}else{console.log('C2A FAIL');process.exit(1)}\"",
  },
  {
    id: "C2B",
    core: true,
    title: "检出的确是账本 commit 的树",
    type: "e2e-real",
    command:
      "node -e \"const s=require('fs').readFileSync('feature.txt','utf8');if(s.trim()==='feature-v2'){console.log('C2B PASS')}else{console.log('C2B FAIL');process.exit(1)}\"",
  },
  {
    id: "C2C",
    core: true,
    title: "检出树 porcelain 干净（与 commit 逐字一致）",
    type: "e2e-real",
    command:
      "node -e \"const r=require('child_process').spawnSync('git',['status','--porcelain'],{encoding:'utf8'});if((r.stdout??'').trim()===''){console.log('C2C PASS')}else{console.log('C2C FAIL');process.exit(1)}\"",
  },
  { id: "U2", core: false, title: "unit 冒烟", type: "unit", command: vitestJsonCmd("U2") },
];

describe("wt5 C2 verify 真值与 cwd 状态无关（场景 3，G3/P7）", () => {
  it("项目 cwd 改脏（tracked 修改 + untracked 新增）→ 子进程 cw verify exit 0：检出树=账本 commit，cwd 脏改动原样保留", () => {
    // fixture：两 commit（c1 tracked.txt=committed-v1 → c2 增 feature.txt=feature-v2），证据锚 c2
    const base = join(tmpRoot, "verify-cwd-dirty");
    mkdirSync(base, { recursive: true });
    const repoDir = realpathSync(base);
    gitRun(repoDir, ["init"]);
    gitRun(repoDir, ["config", "user.email", "cw-wt5@example.com"]);
    gitRun(repoDir, ["config", "user.name", "cw-wt5"]);
    writeFileSync(join(repoDir, "brief.md"), "# wt5 C2 fixture 任务书\n");
    writeFileSync(join(repoDir, "tracked.txt"), "committed-v1\n");
    gitRun(repoDir, ["add", "-A"]);
    gitRun(repoDir, ["commit", "-m", "c1: tracked.txt"]);
    writeFileSync(join(repoDir, "feature.txt"), "feature-v2\n");
    gitRun(repoDir, ["add", "-A"]);
    gitRun(repoDir, ["commit", "-m", "c2: feature.txt"]);
    const head = gitRun(repoDir, ["rev-parse", "HEAD"]);

    appendSpecFrozen(repoDir, C2_UNIT_ID, null, C2_ACCEPTANCE, []);
    ledgerForCwd(repoDir).append("EvidenceSubmitted", {
      unitId: C2_UNIT_ID,
      runId: "run-c2-1",
      commit: head,
      paths: ["tracked.txt", "feature.txt"],
      sha256: [sha("committed-v1\n"), sha("feature-v2\n")],
      exitCode: 0,
    });

    // 项目 cwd 改脏：tracked 修改 + untracked 新增（若 verify 信工作区现状，C2A 必 FAIL）
    writeFileSync(join(repoDir, "tracked.txt"), "DIRTY-EDIT\n");
    writeFileSync(join(repoDir, "untracked-note.txt"), "untracked residue\n");
    const porcelainBefore = gitRun(repoDir, ["status", "--porcelain"]);
    expect(porcelainBefore).toContain("M tracked.txt"); // 前提：脏状态真实成立
    expect(porcelainBefore).toContain("?? untracked-note.txt");

    // 子进程跑真实 cw verify（exit 0 pass）。rv-4 语义迁移：C2 验收是「树内容
    // 自证」型命令（在检出树与父树上都 pass = 无区分力），本用例锁定的是
    // 「verify 真值与 cwd 脏状态无关」——用 --no-red-phase 逃生口保持原语义
    const res = spawnSync(process.execPath, [CLI_PATH, "verify", "--unit", C2_UNIT_ID, "--no-red-phase"], {
      cwd: repoDir,
      encoding: "utf-8",
      env: { ...process.env, CW_HOME: cwHome },
      timeout: 90_000,
    });
    expect(res.error).toBeUndefined();
    expect(res.status, `stdout: ${res.stdout ?? ""}\nstderr: ${res.stderr ?? ""}`).toBe(0);
    expect(res.stdout ?? "").toContain("result=pass");

    // 检出树与账本 commit 一致：VerifyRan(pass) 的逐条验收产物都以 PASS 标记行收场
    const verifyEv = [...ledgerForCwd(repoDir).readAll()]
      .reverse()
      .find((ev) => ev.type === "VerifyRan" && ev.payload.unitId === C2_UNIT_ID);
    if (verifyEv === undefined) {
      throw new Error("账本缺 VerifyRan（断言前置失败）");
    }
    const verifyRun = verifyEv.payload as VerifyRanPayload;
    expect(verifyRun.result).toBe("pass");
    const evBase = evidenceDir(cwHome, repoDir, C2_UNIT_ID, verifyRun.runId);
    for (const id of ["C2A", "C2B", "C2C"]) {
      expect(readFileSync(join(evBase, `${id}.stdout`), "utf-8")).toContain(`${id} PASS`);
    }

    // cwd 脏改动 verify 后原样保留（未被触碰）
    expect(readFileSync(join(repoDir, "tracked.txt"), "utf-8")).toBe("DIRTY-EDIT\n");
    expect(readFileSync(join(repoDir, "untracked-note.txt"), "utf-8")).toBe("untracked residue\n");
    expect(gitRun(repoDir, ["status", "--porcelain"])).toBe(porcelainBefore);
  }, 60_000);
});

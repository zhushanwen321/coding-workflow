/**
 * u5b E2E（M0 A1「人肉全流程」场景雏形；真实子进程 + tmp git 仓库 + 隔离 CW_HOME，零 mock）。
 *
 * 对应 docs/rewrite/acceptance/u5b-acceptance.md「E2E real」两条：
 *   1. 全链收敛：测试进程 spawn runner 子进程（node dist/cli.js run --spawn human
 *      --poll-ms 300，stdout/stderr 重定向落盘），随后扮演「人」——轮询 runner
 *      stdout 文件识别指令类型，依次真实调 CLI（root spec → create 子 unit →
 *      子 unit spec → build+verify → exec-review → root build+verify → root
 *      exec-review），断言 runner 自然退出 exit 0、输出含汇总行、账本 root closed；
 *   2. 中断路径：无人操作 + --max-idle-ms 500 → exit 1 且 stderr 含「无进展」。
 *
 * 注意：直接 `npx vitest run tests/u5b-e2e.test.ts` 不触发 pretest，需先 `npm run build`
 * （`npm test` 的 pretest 已含 build）。
 */
import { type ChildProcess,spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { worktreePath } from "../dist/store/project.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
if (!existsSync(CLI_PATH)) {
  throw new Error(`tests/u5b-e2e 需要 ${CLI_PATH}（先 npm run build；npm test 的 pretest 已含）`);
}

/**
 * u7 run.ts 改造的最小断言适配：--spawn human 不再直连 human-loop，改走
 * runLoop + u6b humanAdapter（动态 import dist/runner/spawn/human.js）。u6b 合入前
 * 该模块缺席，`cw run --spawn human` 按设计返回可操作错误（exit 1），本文件的两条
 * 全链/中断断言在此期间以 it.todo 挂起（human 回归由 tests/u7-e2e.test.ts 的同条件
 * 测试接棒）；u6b 合入并 build 后本文件自动恢复真实断言。
 */
const HUMAN_ADAPTER_DIST = fileURLToPath(new URL("../dist/runner/spawn/human.js", import.meta.url));
const maybeIt = existsSync(HUMAN_ADAPTER_DIST) ? it : it.todo;

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u5b-e2e-"));
const cwHome = join(tmpRoot, "cw-home");
// wt-2 迁移：run 走 runLoop（派发 workdir 迁 unit worktree），隔离 worktree 根
//（runner 子进程与 runCli 均经 {...process.env} 继承）
process.env.CW_WORKTREE_HOME = join(tmpRoot, "cw-worktrees");

/** runner 轮询间隔与各等待的统一超时上限 */
const RUNNER_POLL_MS = 300;
const WAIT_TIMEOUT_MS = 30_000;
/** 全链单测超时（真实 verify 含本地 git clone，留足余量） */
const E2E_TIMEOUT_MS = 120_000;

/** 断言中途失败时防 runner 子进程泄漏 */
const liveRunners = new Set<ChildProcess>();

afterAll(() => {
  for (const child of liveRunners) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 场景目录：独立 repo（物理路径，与子进程 process.cwd() 一致）+ runner 输出文件 */
function makeScenario(name: string): { repoDir: string; outPath: string; errPath: string } {
  const base = join(tmpRoot, name);
  mkdirSync(join(base, "repo"), { recursive: true });
  return {
    repoDir: realpathSync(join(base, "repo")),
    outPath: join(base, "runner.stdout"),
    errPath: join(base, "runner.stderr"),
  };
}

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

function initRepo(repoDir: string): void {
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-e2e@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-e2e"]);
  // wt-2 迁移（R1 行为前提）：runLoop 启动即取项目 HEAD 快照——需至少一个 commit
  writeFileSync(join(repoDir, "fixture.txt"), "u5b-e2e fixture\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: base"]);
}

/** 「人」真实调 CLI（同步子进程，与 runner 共享 cwd + CW_HOME 账本） */
function runCli(repoDir: string, args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** 后台启动 runner 子进程（stdout/stderr 落盘，测试进程轮询读文件识别人该做什么） */
function startRunner(
  repoDir: string,
  rootId: string,
  outPath: string,
  errPath: string,
  extraArgs: readonly string[] = [],
): ChildProcess {
  const outFd = openSync(outPath, "a");
  const errFd = openSync(errPath, "a");
  const child = spawn(
    process.execPath,
    [CLI_PATH, "run", "--root", rootId, "--spawn", "human", "--poll-ms", String(RUNNER_POLL_MS), ...extraArgs],
    { cwd: repoDir, env: { ...process.env, CW_HOME: cwHome }, stdio: ["ignore", outFd, errFd] },
  );
  closeSync(outFd);
  closeSync(errFd);
  liveRunners.add(child);
  child.on("exit", () => {
    liveRunners.delete(child);
  });
  return child;
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    // 竞态防护（u7 实测 Node 行为：子进程退出后挂 "exit" 监听器不再触发）：
    // run 切换到通用 loop（u7）后，人提交最后一步与 runner 的 300ms poll 赛跑，
    // runner 先退时此处可能晚到——exitCode 已非 null 则直接结算
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`runner 未在 ${timeoutMs}ms 内退出（stdout 末尾见断言输出）`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

/**
 * spec.json 的验收 fixture（适配 u4b 起的 verify 判定协议：type → 适配器 + nameMatch）：
 *   - A1（e2e-real）：`node app.js` 输出 "^A1 PASS$" 标记行（e2e-sh parse 契约）；
 *   - A2（unit）：command 输出 vitest JSON reporter 形状产物（vitest parse 契约），
 *     断言名含验收 id（nameMatch 词边界命中）。E2E 被测物是 human 循环与状态机
 *     收敛，不是 vitest 本身（u4b/u5 领地测试覆盖之）——真 vitest 环境对 tmp repo
 *     不可得（无 node_modules，npx 触发网络），故 unit 用例以真实 node 进程产出
 *     合规 JSON 产物。
 */
const ACCEPTANCE_FIXTURE: ReadonlyArray<Record<string, unknown>> = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  {
    id: "A2",
    core: false,
    title: "单元级冒烟",
    type: "unit",
    command:
      // 尾部显式含 --reporter=json（vitest translate 的 includes 检查命中，不再追加）；
    // `--` 分隔使其作为 node 的 script argv 而非 node 自身选项（否则 bad option）
      "node -e \"console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'A2 unit smoke',status:'passed'}]}]}))\" -- --reporter=json",
  },
];

/** spec.json 内容（split 为分解声明；root 传子 unit 条目，叶 unit 传空） */
function specJson(split: ReadonlyArray<Record<string, unknown>> = []): string {
  return `${JSON.stringify({ acceptance: ACCEPTANCE_FIXTURE, contracts: [], split }, null, 2)}\n`;
}

describe("E2E real：human 模式全链（runner 子进程 + 测试进程扮演人）", () => {
  /**
   * u7 run.ts 改造的断言适配：原版「人解析 runner stdout 的 M0 指令组（待人工步骤=spec
   * 等）再操作」改为「人按全链固定序列直线真实调 CLI」——新 loop 的输出形态是
   * [runner] 派发行 + humanAdapter（u6b）的定点指令行，指令文本断言属 u6b 领地；
   * 本回归的价值收敛为「human 后端经新 loop 全链收敛 exit 0」，runner 对账本推进
   * 的消化由轮询（--poll-ms 300）保证，无需指令等待同步。
   */
  maybeIt("全链收敛：建子 → root spec → 子 spec → build/verify → exec-review → root closed，runner exit 0", async () => {
    const { repoDir, outPath, errPath } = makeScenario("full-chain");
    initRepo(repoDir);
    writeFileSync(join(repoDir, "brief.md"), "# root 任务书\n");
    expect(runCli(repoDir, ["create", "--id", "demo", "--brief", "brief.md"]).code).toBe(0);

    const runner = startRunner(repoDir, "demo", outPath, errPath);

    // 1) 先建子 unit + root 的 spec（split 声明子 unit impl）+ spec-review
    //    （fx-3 R5.1 断言适配：先建子后提 spec——工作流语义变更，原时序
    //    root spec 先提交会被 split 子存在性校验拒绝）
    writeFileSync(join(repoDir, "brief-impl.md"), "# impl 任务书\n");
    expect(runCli(repoDir, ["create", "--id", "impl", "--brief", "brief-impl.md", "--parent", "demo"]).code).toBe(0);
    writeFileSync(join(repoDir, "spec-demo.json"), specJson([{ unitId: "impl", briefRef: "brief-impl.md", dependsOn: [] }]));
    expect(runCli(repoDir, ["evidence", "submit", "--kind", "spec", "--unit", "demo", "--file", "spec-demo.json"]).code).toBe(0);
    expect(runCli(repoDir, ["review", "submit", "--unit", "demo", "--verdict-kind", "spec-review", "--verdict", "pass", "--role", "reviewer"]).code).toBe(0);

    // 2) 子 unit 的 spec
    writeFileSync(join(repoDir, "spec-impl.json"), specJson());
    expect(runCli(repoDir, ["evidence", "submit", "--kind", "spec", "--unit", "impl", "--file", "spec-impl.json"]).code).toBe(0);
    expect(runCli(repoDir, ["review", "submit", "--unit", "impl", "--verdict-kind", "spec-review", "--verdict", "pass", "--role", "reviewer"]).code).toBe(0);

    // 3) 子 unit 的 build：实现 + commit + build 证据 + verify（干净重跑真实执行验收命令）
    //    （wt-4 迁移：人按 human 指引在 impl 的 unit worktree（分支 cw/demo/impl）
    //    里干活 commit——子分支上的产出 commit 即集成的汇聚现场；旧「项目 cwd 直
    //    commit」形态的产出不在 root 分支汇聚路径上，集成无处可 merge）
    const implWt = worktreePath(process.env.CW_WORKTREE_HOME ?? "", repoDir, "impl");
    // 同步屏障：等 runner 打出 builder(impl) 派发行再动手写现场（与真实 human
    // 的行为契约对齐——人看到 builder 指令才进 worktree 干活）。只等目录存在
    // 不安全：impl 目录由 designer(impl)（spec 待审的 reReview 派发）提前建立，
    // 而随后 builder(impl) 派发前 ensureUnitWorktree 会 reset --hard + clean
    // -fd（fx-4 起裸形态）——在该 clean 窗口内写入的 untracked app.js 会被卷走，
    // commit「成功」但树无 app.js，evidence --file 读不到 → 红（M3 gate 报告
    // §5.4 的间歇红根因；fx-4 后产物已迁 topic 目录，但 app.js 本身仍是
    // untracked，同步屏障依然必要）。派发行在 ensure 与 spawn 之后 emit：看到
    // 本行 = 本轮 clean 已完成且 builder(impl) 已入 inFlight（下次 reset 要等
    // VerifyRan(impl) 后的 reviewer 派发，那时 app.js 已 commit，tracked 对
    // reset/clean 免疫）
    const BUILDER_IMPL_DISPATCH_LINE = '派发 builder → unit "impl"';
    const wtDeadline = Date.now() + 10_000;
    while (!readFileSync(outPath, "utf-8").includes(BUILDER_IMPL_DISPATCH_LINE)) {
      if (Date.now() > wtDeadline) {
        throw new Error(
          `builder(impl) 派发行未在 10s 内出现（runner 未派发？stdout 末尾：${readFileSync(outPath, "utf-8").slice(-400)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    writeFileSync(join(implWt, "app.js"), 'console.log("A1 PASS");\n');
    gitRun(implWt, ["add", "-A"]);
    gitRun(implWt, ["commit", "-m", "impl: app.js"]);
    const head = gitRun(implWt, ["rev-parse", "HEAD"]);
    expect(runCli(repoDir, ["evidence", "submit", "--kind", "build", "--unit", "impl", "--commit", head, "--run-id", "run-impl-1", "--file", join(implWt, "app.js")]).code).toBe(0);
    // rv-4 语义迁移：fixture 验收为内联恒真形态，红阶段默认执行下无区分力必挂
    //——本用例锁定 human 模式链路推进，用 --no-red-phase 逃生口保持原语义
    const verifyImpl = runCli(repoDir, ["verify", "--unit", "impl", "--no-red-phase"]);
    expect(verifyImpl.code, `impl verify 应 pass（stdout: ${verifyImpl.stdout}，stderr: ${verifyImpl.stderr}）`).toBe(0);

    // 4) 子 unit 的 exec-review → closed（rv-2 适配：exec-review 必须携带
    //    --evidence-refs ≥1 个已入账 runId，引用本 unit 的真实 build 证据）
    expect(runCli(repoDir, ["review", "submit", "--unit", "impl", "--verdict-kind", "exec-review", "--verdict", "pass", "--evidence-refs", "run-impl-1"]).code).toBe(0);

    // 5) root 的 build：HEAD 已含全部实现，作为 root 的 build 证据 commit
    expect(runCli(repoDir, ["evidence", "submit", "--kind", "build", "--unit", "demo", "--commit", head, "--run-id", "run-demo-1"]).code).toBe(0);
    const verifyDemo = runCli(repoDir, ["verify", "--unit", "demo", "--no-red-phase"]);
    expect(verifyDemo.code, `demo verify 应 pass（stdout: ${verifyDemo.stdout}，stderr: ${verifyDemo.stderr}）`).toBe(0);

    // 6) root 的 exec-review → closed → runner 收敛自然退出（rv-2：refs 必填）
    expect(runCli(repoDir, ["review", "submit", "--unit", "demo", "--verdict-kind", "exec-review", "--verdict", "pass", "--evidence-refs", "run-demo-1"]).code).toBe(0);

    const code = await waitExit(runner, WAIT_TIMEOUT_MS);
    expect(code).toBe(0);
    const stdoutText = readFileSync(outPath, "utf-8");
    expect(stdoutText).toContain("已 closed");
    expect(stdoutText).toMatch(/demo\s+closed\s+lastVerify:pass/);
    expect(stdoutText).toMatch(/impl\s+closed\s+lastVerify:pass/);
    expect(stdoutText).toContain("cw report");

    // 账本终态：root closed（真实子进程 cw status 复核）
    const status = runCli(repoDir, ["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/demo\s+closed/);
  }, E2E_TIMEOUT_MS);

  maybeIt("中断路径：--max-idle-ms 500 无人操作 → exit 1 且 stderr 含空转提示", async () => {
    const { repoDir, outPath, errPath } = makeScenario("idle");
    initRepo(repoDir);
    writeFileSync(join(repoDir, "brief.md"), "# 任务书\n");
    expect(runCli(repoDir, ["create", "--id", "stall", "--brief", "brief.md"]).code).toBe(0);

    const runner = startRunner(repoDir, "stall", outPath, errPath, ["--max-idle-ms", "500"]);
    const code = await waitExit(runner, 10_000);
    expect(code).toBe(1);
    const errText = readFileSync(errPath, "utf-8");
    // u7 通用 loop 的空转文案（面向 agent 后端）
    expect(errText).toContain("无账本进展");
    expect(errText).toContain("恢复动作");

    // 中断前 humanAdapter 打印过 designer 定点指令但账本未动：unit 仍 created
    expect(readFileSync(outPath, "utf-8")).toContain('designer 指令：unit "stall"');
    expect(runCli(repoDir, ["status"]).stdout).toMatch(/stall\s+created/);
  }, 20_000);
});

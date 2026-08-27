/**
 * W1 gate CLI 接线 e2e（design-release-pipeline.md §3.1 / §3.3 D8；任务书 T1.1~T1.5）。
 *
 * 零 mock：真实子进程跑 `node dist/cli.js`（对照 gp1-golden-replay 的子进程模式）、
 * 真实 tmp git 仓、真实 CW_HOME、真实文件锁并发。
 *
 * 用例 → 任务书映射：
 *   T1.1  A1a 全链：miss（耗时>0 + 入账含 sha256）→ hit（<100ms + sourceRunId）
 *         → query --json → scope 外仍 hit → scope 内 miss → fail exit 1 入账
 *   T1.2  A2 闭合负面：产物目录只读 → exit 2 不入账；report 删 → 向 miss 倒 + 警告
 *   T1.3  A3/GP6：base ref 前移 → query 同 ref 名两 check 均 miss
 *   T1.4  GP3 并发：两子进程并发各 50 次 wrap → 恰 100 条 seq 连续；同 runId 幂等
 *   T1.5  A6 + 缺省：golden 账本与 gate-events.log 共存 → 四只读命令快照一致；
 *         --scope 缺省 = 仓根，改任意文件 commit → miss
 *   F-3  --base 不存在 ref → exit 2 + stderr 含恢复动作；用法错误含恢复动作
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it, vi } from "vitest";

/** 真实子进程/真实 git 的耗时余量（缺省 5s 对 CLI spawn 偏紧；T1.4 另给 180s） */
vi.setConfig({ testTimeout: 30_000 });

import { gateLedgerDomain } from "../src/gate/domain.js";
import type { GateEventMap } from "../src/gate/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { encodeCwd, gateLedgerPath } from "../src/store/project.js";

// ── 路径常量（realpathSync 解 macOS /tmp → /private/tmp，编码两侧一致的前提）──

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_DIR = join(TEST_DIR, "fixtures", "golden-ledgers", "unit-basic");
const DIST_ROOT = resolve(TEST_DIR, "../dist");
const CLI_PATH = join(DIST_ROOT, "cli.js");

/** dist 缺席时挂起（pretest build 后自动激活，对照 gp1） */
const distIt = existsSync(CLI_PATH) ? it : it.todo;

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "cw-w1-gate-e2e-")));
const cwHome = join(tmpRoot, "home");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── 子进程工具 ─────────────────────────────────────────────

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: readonly string[], cwd: string): CliResult {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
    timeout: 60_000,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// ── git 夹具（对照 rp0-gate-core 的 initRepo 模式）──────────

function gitRun(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

interface Repo {
  repoDir: string;
  baseRef: string;
  commit(path: string, content: string): string;
}

function initRepo(name: string): Repo {
  const repoDir = join(tmpRoot, name);
  mkdirSync(repoDir, { recursive: true });
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-test@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-test"]);
  gitRun(repoDir, ["commit", "--allow-empty", "-m", "root"]);
  const baseRef = "stable";
  gitRun(repoDir, ["branch", baseRef]);
  return {
    repoDir,
    baseRef,
    commit(path: string, content: string): string {
      const abs = join(repoDir, path);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
      gitRun(repoDir, ["add", "-A"]);
      gitRun(repoDir, ["commit", "-m", `touch ${path}`]);
      return gitRun(repoDir, ["rev-parse", "HEAD"]);
    },
  };
}

/** 读 gate 账本原始事件（消费处按 type 窄化 payload） */
function readGateEvents(cwd: string) {
  const ledger = new EventLedger<GateEventMap>(gateLedgerPath(cwHome, cwd), gateLedgerDomain);
  return ledger.readAll();
}

/** gate wrap 的标准调用形态（缺省 check=typecheck scope=src，命令 node -e exit 0） */
function wrapCli(
  repo: Repo,
  extra: readonly string[] = [],
  command: readonly string[] = ["node", "-e", "process.exit(0)"],
): CliResult {
  return runCli(
    ["gate", "wrap", "--check", "typecheck", "--base", repo.baseRef, "--scope", "src", ...extra, "--", ...command],
    repo.repoDir,
  );
}

// ── T1.1：A1a 全链 ─────────────────────────────────────────

distIt("T1.1 A1a 全链", () => {
  const repo = initRepo("t11");
  repo.commit("src/a.ts", "a\n");

  // ① 首跑 miss：真实执行耗时>0，GateCheckRan 入账含 reportSha256
  const first = wrapCli(repo);
  expect(first.code).toBe(0);
  expect(first.stdout).toMatch(/^\[miss\] typecheck @ [0-9a-f]{7} \(base [0-9a-f]{7}\)：执行 \d+\.\d+s → pass\n/);
  expect(first.stdout).toMatch(/入账 GateCheckRan #1，report: gate-artifacts\/typecheck\/.+\/report\.json/);
  let events = readGateEvents(repo.repoDir);
  expect(events).toHaveLength(1);
  const ran = events[0]?.payload as { result: string; durationMs: number; reportSha256: string };
  expect(events[0]?.type).toBe("GateCheckRan");
  expect(ran.result).toBe("pass");
  expect(ran.durationMs).toBeGreaterThan(0);
  expect(ran.reportSha256).toMatch(/^[0-9a-f]{64}$/);

  // ② 同 HEAD 再跑 hit：耗时<100ms（stdout 展示秒），GateCacheHit sourceRunId 指首跑
  const hit = wrapCli(repo);
  expect(hit.code).toBe(0);
  expect(hit.stdout).toMatch(/^\[hit\] typecheck @ [0-9a-f]{7} \(base [0-9a-f]{7}\)：命中 .+（\d+\.\d+s），report 已产出/);
  expect(hit.stdout).toMatch(/入账 GateCacheHit #2（source=/);
  const hitSec = Number(hit.stdout.match(/（(\d+\.\d)s）/)?.[1] ?? "99");
  // stdout 展示精度 0.1s（95ms 显示 0.1s），断言 0.5s 上界；elapsedMs 毫秒级断言在 rp0
  expect(hitSec).toBeLessThan(0.5);
  events = readGateEvents(repo.repoDir);
  const hitEvent = events[1]?.payload as { sourceRunId: string };
  expect(events[1]?.type).toBe("GateCacheHit");
  expect(hitEvent.sourceRunId).toBe((events[0]?.payload as { runId: string }).runId);

  // ③ query --json：最新 pass 条目 + report 指针
  const q = runCli(["gate", "query", "--check", "typecheck", "--base", repo.baseRef, "--json"], repo.repoDir);
  expect(q.code).toBe(0);
  const parsed = JSON.parse(q.stdout) as {
    passEntries: Array<{ check: string; reportRef: string; reportSha256: string; durationMs: number }>;
    latestByCheck: Array<{ check: string; type: string }>;
  };
  expect(parsed.passEntries).toHaveLength(1);
  expect(parsed.passEntries[0]?.check).toBe("typecheck");
  expect(parsed.passEntries[0]?.reportRef).toMatch(/^gate-artifacts\/typecheck\/.+\/report\.json$/);
  expect(parsed.passEntries[0]?.reportSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(parsed.passEntries[0]?.durationMs).toBeGreaterThan(0);
  expect(parsed.latestByCheck.map((e) => e.check)).toContain("typecheck");

  // ④ scope 外文件 commit 后 wrap 仍 hit
  repo.commit("docs/readme.md", "# docs\n");
  const outside = wrapCli(repo);
  expect(outside.code).toBe(0);
  expect(outside.stdout).toMatch(/^\[hit\] /);

  // ⑤ scope 内文件 commit 后 wrap miss 真实执行
  repo.commit("src/a.ts", "a2\n");
  const inside = wrapCli(repo);
  expect(inside.code).toBe(0);
  expect(inside.stdout).toMatch(/^\[miss\] .*\n入账 GateCheckRan #4/);

  // ⑥ fail 命令：exit 1 且 result=fail 入账（换 check 名防命中 ⑤ 的 pass 缓存）
  const failRun = runCli(
    ["gate", "wrap", "--check", "lint-fail", "--base", repo.baseRef, "--scope", "src", "--", "node", "-e", "process.exit(3)"],
    repo.repoDir,
  );
  expect(failRun.code).toBe(1);
  expect(failRun.stdout).toMatch(/→ FAIL（exit 3）/);
  expect(failRun.stdout).toMatch(/入账 GateCheckRan #5（result=fail）/);
  events = readGateEvents(repo.repoDir);
  expect(events).toHaveLength(5);
  expect((events[4]?.payload as { result: string }).result).toBe("fail");
});

// ── T1.2：A2 闭合负面 ──────────────────────────────────────

distIt("T1.2 A2 ①：产物目录只读 → exit 2 且账本事件数不变", () => {
  const repo = initRepo("t12-readonly");
  repo.commit("src/a.ts", "a\n");

  const artifactsCheckDir = join(cwHome, encodeCwd(repo.repoDir), "gate-artifacts", "typecheck");
  mkdirSync(artifactsCheckDir, { recursive: true });
  chmodSync(artifactsCheckDir, 0o555);
  try {
    const res = wrapCli(repo);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("产物写入失败");
    expect(res.stderr).toContain("恢复动作");
    expect(readGateEvents(repo.repoDir)).toHaveLength(0);
  } finally {
    chmodSync(artifactsCheckDir, 0o755);
  }
});

distIt("T1.2 A2 ②：删除已入账 report → 再 wrap 向 miss 倒 + stderr 警告", () => {
  const repo = initRepo("t12-deleted");
  repo.commit("src/a.ts", "a\n");
  const first = wrapCli(repo);
  expect(first.code).toBe(0);

  const ran = readGateEvents(repo.repoDir)[0]?.payload as { reportRef: string };
  rmSync(join(cwHome, encodeCwd(repo.repoDir), ran.reportRef));

  const second = wrapCli(repo);
  expect(second.code).toBe(0);
  expect(second.stdout).toMatch(/^\[miss\] /); // 向 miss 倒 = 真实重跑
  expect(second.stderr).toContain("[warn]");
  expect(second.stderr).toContain("宁 miss 不假 pass");
  expect(readGateEvents(repo.repoDir)).toHaveLength(2); // 无 hit 条目
});

// ── T1.3：A3/GP6 base ref 前移 ─────────────────────────────

distIt("T1.3 A3/GP6：base ref 前移 → query 同 ref 名两 check 均 miss", () => {
  const repo = initRepo("t13");
  repo.commit("src/a.ts", "a\n");
  expect(wrapCli(repo).code).toBe(0); // typecheck pass
  const lint = runCli(
    ["gate", "wrap", "--check", "lint", "--base", repo.baseRef, "--scope", "src", "--", "node", "-e", "process.exit(0)"],
    repo.repoDir,
  );
  expect(lint.code).toBe(0);
  expect(readGateEvents(repo.repoDir)).toHaveLength(2);

  // base 前移：新 commit 移动 stable（模拟 merge 上游 / fetch 后 ref 移动）
  repo.commit("src/b.ts", "b\n");
  gitRun(repo.repoDir, ["branch", "-f", repo.baseRef, "HEAD"]);

  for (const check of ["typecheck", "lint"]) {
    const q = runCli(["gate", "query", "--check", check, "--base", repo.baseRef], repo.repoDir);
    expect(q.code).toBe(0);
    expect(q.stdout).toMatch(/^miss: 无 \(/);
  }
  const qJson = runCli(["gate", "query", "--base", repo.baseRef, "--json"], repo.repoDir);
  expect((JSON.parse(qJson.stdout) as { passEntries: unknown[] }).passEntries).toEqual([]);
});

// ── T1.4：GP3 并发 + runId 幂等 ────────────────────────────

/** spawn 的退出码 Promise（并发两子进程的等待原语） */
function waitExit(child: { on: (ev: "exit", cb: (code: number | null) => void) => void }): Promise<number | null> {
  return new Promise((resolvePromise) => {
    child.on("exit", (code) => resolvePromise(code));
  });
}

distIt(
  "T1.4 GP3：两子进程并发各 50 次 wrap → 账本恰 100 条 seq 连续；同 runId 重复幂等拒绝",
  async () => {
    const repo = initRepo("t14");
    repo.commit("src/a.ts", "a\n");

    const loopScript = (prefix: string): string =>
      `for i in $(seq 1 50); do "${process.execPath}" "${CLI_PATH}" gate wrap --check conc --base stable ` +
      `--run-id "${prefix}$i" -- node -e 'process.exit(0)' >/dev/null 2>&1 || exit 9; done`;

    const p1 = spawn("bash", ["-c", loopScript("a")], { cwd: repo.repoDir, env: { ...process.env, CW_HOME: cwHome } });
    const p2 = spawn("bash", ["-c", loopScript("b")], { cwd: repo.repoDir, env: { ...process.env, CW_HOME: cwHome } });
    const [c1, c2] = await Promise.all([waitExit(p1), waitExit(p2)]);
    expect(c1).toBe(0);
    expect(c2).toBe(0);

    const events = readGateEvents(repo.repoDir);
    expect(events).toHaveLength(100); // 恰 100 条（首条 miss + 其余 99 hit 各自入账）
    const seqs = events.map((e) => e.seq).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1)); // 连续无重复
    expect(new Set(events.map((e) => e.seq)).size).toBe(100);

    // 同 runId 重复 → 幂等拒绝：不执行、不重复入账、exit 0
    const again = runCli(
      ["gate", "wrap", "--check", "conc", "--base", "stable", "--run-id", "a1", "--", "node", "-e", "process.exit(0)"],
      repo.repoDir,
    );
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/^\[idempotent\] conc（runId=a1）：已入账 #\d+（result=pass）/);
    expect(readGateEvents(repo.repoDir)).toHaveLength(100);
  },
  180_000,
);

// ── T1.5：A6 golden 共存 + --scope 缺省 ─────────────────────

distIt("T1.5 A6：golden 账本 + gate-events.log 同 CW_HOME 共存，四只读命令与快照一致", () => {
  const repo = initRepo("t15");
  repo.commit("src/a.ts", "a\n");

  // 先产生 gate 账本与产物（同项目 CW 目录内两域文件并存）
  expect(wrapCli(repo).code).toBe(0);
  expect(existsSync(gateLedgerPath(cwHome, repo.repoDir))).toBe(true);

  // 再放入 unit 域 golden 账本（同 <cwHome>/<encoded>/ 目录）
  const encoded = join(cwHome, encodeCwd(repo.repoDir));
  copyFileSync(join(FIXTURE_DIR, "events.log"), join(encoded, "events.log"));

  const snapshot = (name: string): string => readFileSync(join(FIXTURE_DIR, "snapshots", name), "utf-8");
  const status = runCli(["status"], repo.repoDir);
  expect(status.code).toBe(0);
  expect(status.stdout).toBe(snapshot("status.txt"));
  const tree = runCli(["tree"], repo.repoDir);
  expect(tree.code).toBe(0);
  expect(tree.stdout).toBe(snapshot("tree.txt"));
  const frontier = runCli(["frontier", "--json"], repo.repoDir);
  expect(frontier.code).toBe(0);
  expect(frontier.stdout).toBe(snapshot("frontier.json"));
  const report = runCli(["report"], repo.repoDir);
  expect(report.code).toBe(0);
  expect(report.stdout).toBe(snapshot("report.txt"));
});

distIt("T1.5 缺省：--scope 缺省 = 仓根，改任意文件 commit → 再 wrap miss", () => {
  const repo = initRepo("t15-default");
  repo.commit("README.md", "readme\n");

  const first = runCli(
    ["gate", "wrap", "--check", "defscope", "--base", repo.baseRef, "--", "node", "-e", "process.exit(0)"],
    repo.repoDir,
  );
  expect(first.code).toBe(0);
  expect(first.stdout).toMatch(/^\[miss\] defscope /);

  // 仓根默认无增量：任何文件变更都在 scope 内 → miss 真实执行
  repo.commit("docs/anything.md", "change\n");
  const second = runCli(
    ["gate", "wrap", "--check", "defscope", "--base", repo.baseRef, "--", "node", "-e", "process.exit(0)"],
    repo.repoDir,
  );
  expect(second.code).toBe(0);
  expect(second.stdout).toMatch(/^\[miss\] defscope /);
  expect(second.stdout).toMatch(/入账 GateCheckRan #2/);
});

// ── F-3 与用法错误 ─────────────────────────────────────────

distIt("F-3：--base 不存在 ref → exit 2 + stderr 含恢复动作", () => {
  const repo = initRepo("f3");
  repo.commit("src/a.ts", "a\n");
  const res = runCli(
    ["gate", "wrap", "--check", "typecheck", "--base", "origin/nonexist", "--scope", "src", "--", "node", "-e", "process.exit(0)"],
    repo.repoDir,
  );
  expect(res.code).toBe(2);
  expect(res.stderr).toContain("origin/nonexist");
  expect(res.stderr).toContain("恢复动作");
  expect(readGateEvents(repo.repoDir)).toHaveLength(0);
});

distIt("用法错误：gate wrap 无参 → exit 1 + stderr 含恢复动作", () => {
  const repo = initRepo("usage");
  const res = runCli(["gate", "wrap"], repo.repoDir);
  expect(res.code).toBe(1);
  expect(res.stderr).toContain("恢复动作");
  expect(res.stderr).toContain("--check");
});

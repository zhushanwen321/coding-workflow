/**
 * mx-3 单测 R1-R4：spec-review 身份强校验的双层防线（mx3-acceptance §5 R 系）。
 * 真实子进程（node dist/cli.js）+ 直写真实账本（EventLedger）+ tmp 目录 + 隔离
 * CW_HOME，零 mock。
 *
 *   R1 入账强制三态：spec-review 无 --role → exit 1（文案含 --role reviewer 与
 *      恢复动作，纯拒绝不入账）；--role designer → exit 1；--role reviewer →
 *      入账成功 payload.role=reviewer；exec-review 无 role → 仍入账（范围外不收紧）
 *   R2 fold 只认 reviewer（纵深第二层）：role=designer 的 spec-review pass 直写
 *      账本（绕过入账层）→ 不进 spec-frozen；同账本补 role=reviewer pass → 冻结
 *   R3 全链防绕过复现（§5.1 场景重演，human E2E）：developer in-flight 期间带 build
 *      证据后自审 spec-review——无 role 被拒 exit 1；--role reviewer 谎报入账但
 *      stderr 出现抢答警告（mx-3 豁免收紧：无在场 reviewer 即告警），循环继续
 *   R4 历史兼容锚：role=reviewer 的既有事件序列行为与 mx-1 基线一致（三态推进）
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
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const CLI_PATH = join(DIST_ROOT, "cli.js");
if (!existsSync(CLI_PATH)) {
  throw new Error("tests/mx3-role-gate 需要 dist/（先 npm run build；npm test 的 pretest 已含）");
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-mx3-role-"));
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
  gitRun(repoDir, ["config", "user.email", "cw-mx3@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-mx3"]);
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

/** 真实 CLI 子进程（与 runner 共享 cwd + CW_HOME 账本） */
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

/** 直写一条过 gate 的 spec（真实账本 append 路径） */
function appendSpec(ledger: EventLedger, unitId: string, salt: string): void {
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: `${unitId}-spec-${salt}`,
    acceptance: [...ACCEPTANCE],
    contracts: [],
    split: [],
  });
}

/** VerdictSubmittedPayload.role 的字面量联合（自报身份枚举域，对齐 src） */
type VerdictRole = "reviewer" | "designer" | "developer" | "human";

function appendSpecReview(
  ledger: EventLedger,
  unitId: string,
  verdict: "pass" | "fail",
  role: VerdictRole | undefined,
  comment?: string,
): void {
  ledger.append("VerdictSubmitted", {
    unitId,
    verdictKind: "spec-review",
    verdict,
    ...(role !== undefined ? { role } : {}),
    ...(comment !== undefined ? { comment } : {}),
  });
}

/** 提交 spec（真实 CLI 路径：schema 校验 + gate 五规则）——R1 的前置 */
function submitSpecViaCli(repoDir: string, unitId: string): void {
  writeFileSync(
    join(repoDir, "spec.json"),
    `${JSON.stringify({ acceptance: ACCEPTANCE, contracts: [], split: [] }, null, 2)}\n`,
  );
  const res = runCli(repoDir, [
    "evidence",
    "submit",
    "--kind",
    "spec",
    "--unit",
    unitId,
    "--file",
    "spec.json",
  ]);
  expect(res.code, `spec 提交应过 schema+gate（stderr: ${res.stderr}）`).toBe(0);
}

// ---- runner 子进程基建（R3，mx1 同款） ----

const liveRunners = new Set<ChildProcess>();

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
    [CLI_PATH, "run", "--root", rootId, "--spawn", "human", "--poll-ms", "200", "--max-idle-ms", "60000"],
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

// ================================================================
// R1：入账强制三态
// ================================================================

describe("mx-3 R1 入账强制：spec-review 必须 --role reviewer（三态 + exec-review 不收紧）", () => {
  it("spec-review 无 --role → exit 1，文案含 --role reviewer 与恢复动作，纯拒绝不入账", () => {
    const repoDir = makeScenario("r1-missing-role", "demo");
    submitSpecViaCli(repoDir, "demo");
    const before = ledgerOf(repoDir).readAll().length;

    const res = runCli(repoDir, [
      "review", "submit", "--unit", "demo",
      "--verdict-kind", "spec-review", "--verdict", "pass",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("--role reviewer");
    expect(res.stderr).toContain("恢复动作");
    // 纯拒绝：不产生任何事件（重试按文案补 role）
    expect(ledgerOf(repoDir).readAll().length).toBe(before);
  });

  it("spec-review --role designer → exit 1（身份错，拒绝入账）", () => {
    const repoDir = makeScenario("r1-designer-role", "demo");
    submitSpecViaCli(repoDir, "demo");
    const res = runCli(repoDir, [
      "review", "submit", "--unit", "demo",
      "--verdict-kind", "spec-review", "--verdict", "pass",
      "--role", "designer",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("--role reviewer");
    expect(ledgerOf(repoDir).readAll().some((ev) => ev.type === "VerdictSubmitted")).toBe(false);
  });

  it("spec-review --role reviewer → 入账成功 payload.role=reviewer", () => {
    const repoDir = makeScenario("r1-reviewer-role", "demo");
    submitSpecViaCli(repoDir, "demo");
    const res = runCli(repoDir, [
      "review", "submit", "--unit", "demo",
      "--verdict-kind", "spec-review", "--verdict", "pass",
      "--role", "reviewer",
    ]);
    expect(res.code, `应成功（stderr: ${res.stderr}）`).toBe(0);
    const payload = ledgerOf(repoDir)
      .readAll()
      .find((ev) => ev.type === "VerdictSubmitted")
      ?.payload as { role?: string; verdictKind?: string };
    expect(payload?.verdictKind).toBe("spec-review");
    expect(payload?.role).toBe("reviewer");
  });

  it("exec-review 无 role → 仍入账（范围外不收紧；role 可选语义保留于 exec-review）", () => {
    const repoDir = makeScenario("r1-exec-no-role", "demo");
    const ledger = ledgerOf(repoDir);
    appendSpec(ledger, "demo", "v1");
    appendSpecReview(ledger, "demo", "pass", "reviewer");
    ledger.append("EvidenceSubmitted", {
      unitId: "demo",
      runId: "run-r1-exec",
      commit: "c" + "0".repeat(39),
      paths: ["app.js"],
      sha256: ["d" + "0".repeat(63)],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId: "demo",
      runId: "run-r1-exec",
      reportHash: "rh-r1-exec",
      result: "pass",
      acceptanceIds: ACCEPTANCE.map((a) => a.id),
    });
    const res = runCli(repoDir, [
      "review", "submit", "--unit", "demo",
      "--verdict-kind", "exec-review", "--verdict", "pass",
      "--evidence-refs", "run-r1-exec",
    ]);
    expect(res.code, `exec-review 无 role 应入账（stderr: ${res.stderr}）`).toBe(0);
    const payload = ledgerOf(repoDir)
      .readAll()
      .find((ev) => ev.type === "VerdictSubmitted" && (ev.payload as { verdictKind?: string }).verdictKind === "exec-review")
      ?.payload as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(payload, "role")).toBe(false);
  });
});

// ================================================================
// R2：fold 只认 reviewer（纵深第二层——直写账本绕过入账层）
// ================================================================

describe("mx-3 R2 fold 消费校验：role≠reviewer 的 spec-review verdict 不驱动状态", () => {
  it("role=designer 的 pass 直写账本 → 停留 created（不 spec-frozen）；specReviewPending 仍等待真审", () => {
    const repoDir = makeScenario("r2-designer-pass", "demo");
    const ledger = ledgerOf(repoDir);
    appendSpec(ledger, "demo", "v1");
    appendSpecReview(ledger, "demo", "pass", "designer"); // 绕过入账层的越权事件

    const status = runCli(repoDir, ["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/demo\s+created/);
    expect(status.stdout).not.toMatch(/demo\s+spec-frozen/);
    // 消费侧一致：designer 的 pass 被无视 → unit 仍停 created。ph-i1 R4 起无
    // reviewer verdict 的 spec 先入反思组（reflectionPending）——同样不驱动状态
    const frontier = runCli(repoDir, ["frontier", "--json"]);
    const groups = JSON.parse(frontier.stdout) as {
      reflectionPending: string[];
      specReviewPending: string[];
      specFixPending: string[];
    };
    expect(groups.reflectionPending).toContain("demo");
    expect(groups.specReviewPending).not.toContain("demo");
    expect(groups.specFixPending).not.toContain("demo");
  });

  it("同账本补 role=reviewer pass → spec-frozen（designer 的历史 pass 不再是障碍）", () => {
    const repoDir = makeScenario("r2-reviewer-pass", "demo");
    const ledger = ledgerOf(repoDir);
    appendSpec(ledger, "demo", "v1");
    appendSpecReview(ledger, "demo", "pass", "designer");
    appendSpecReview(ledger, "demo", "pass", "reviewer");

    const status = runCli(repoDir, ["status"]);
    expect(status.stdout).toMatch(/demo\s+spec-frozen/);
  });

  it("role 缺失的 pass 直写账本（历史事件防御性兼容形态）→ 同样不驱动冻结", () => {
    const repoDir = makeScenario("r2-no-role-pass", "demo");
    const ledger = ledgerOf(repoDir);
    appendSpec(ledger, "demo", "v1");
    appendSpecReview(ledger, "demo", "pass", undefined);
    const status = runCli(repoDir, ["status"]);
    expect(status.stdout).toMatch(/demo\s+created/);
  });
});

// ================================================================
// R3：全链防绕过复现（§5.1 场景重演，human E2E）
// ================================================================

describe("mx-3 R3 全链防绕过：developer in-flight 期间自审（§5.1 场景重演）", () => {
  it(
    "带 build 证据后自审无 role → 被拒 exit 1；同代重复 spec-review verdict（含 --role reviewer 谎报）→ 幂等守卫拒收 + 循环继续",
    // fb-1（M7 设计 D8）行为变更记档：同代已有 reviewer 生效结论后，任何 CLI
    // spec-review 提交被幂等守卫入账层拒收——原「谎报 入账 + 抢答警告」路径关闭，
    // 防绕过目标不变且更强（从审计可见升级为结构性不可入）；正路 = 重提新 spec。
    // 抢答警告的审计可见性覆盖由 mx-1 T3 的直写路径保留（守卫只拦 CLI 迟到者）
    async () => {
    const repoDir = makeScenario("r3-bypass", "demo");
    // 前置直写：spec 已过独立审查（role=reviewer pass）→ unit spec-frozen
    const ledger = ledgerOf(repoDir);
    appendSpec(ledger, "demo", "v1");
    appendSpecReview(ledger, "demo", "pass", "reviewer");

    const runner = startRunner(repoDir, "demo");
    try {
      // developer 派发（buildReady）——human adapter 无 VerifyRan 前保持 in-flight
      await waitText(runner.stdoutText, '派发 developer → unit "demo"', 60_000);
      // developer 形态提交者先入账 build 证据（EvidenceSubmitted 不结算 human developer）
      ledger.append("EvidenceSubmitted", {
        unitId: "demo",
        runId: "run-r3-build",
        commit: "c" + "1".repeat(39),
        paths: ["app.js"],
        sha256: ["d" + "1".repeat(63)],
        exitCode: 0,
      });

      // 自审 attempt #1：不带 role → 入账层拦截（exit 1，零事件入账）
      const bare = runCli(repoDir, [
        "review", "submit", "--unit", "demo",
        "--verdict-kind", "spec-review", "--verdict", "pass",
      ]);
      expect(bare.code).toBe(1);
      expect(bare.stderr).toContain("--role reviewer");

      // 自审 attempt #2：同代重复 spec-review verdict——幂等守卫拒收（fb-1 D8 行为变更）
      const specReviewVerdictCount = () =>
        ledger.readAll().filter(
          (e) =>
            e.type === "VerdictSubmitted" &&
            e.payload.unitId === "demo" &&
            (e.payload as { verdictKind?: string }).verdictKind === "spec-review",
        ).length;
      const dupBefore = specReviewVerdictCount();
      const resubmitted = runCli(repoDir, [
        "review", "submit", "--unit", "demo",
        "--verdict-kind", "spec-review", "--verdict", "pass",
        "--role", "reviewer",
        "--comment", "developer 自审（R3 同代重复现场）",
      ]);
      expect(resubmitted.code, `同代重复应被守卫拒收（stderr: ${resubmitted.stderr}）`).toBe(1);
      expect(resubmitted.stderr).toContain("已有生效审查结论");
      expect(specReviewVerdictCount(), "守卫拒收零事件追加").toBe(dupBefore);

      // 守卫只是入账层拒绝，不阻断循环：developer 仍 in-flight、runner 存活 ≥5 个 poll 周期
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(runner.child.exitCode, "守卫拒收不得阻断或杀死循环").toBeNull();    } finally {
      runner.child.kill("SIGTERM");
      await waitExit(runner, 10_000);
    }
    expect(runner.child.exitCode).toBe(143);
  }, 60_000);
});

// ================================================================
// R4：历史兼容锚（role=reviewer 既有事件与 mx-1 基线等价）
// ================================================================

describe("mx-3 R4 历史兼容锚：role=reviewer 的事件序列三态推进与 mx-1 基线一致", () => {
  it("spec + reviewer pass → spec-frozen；+ build/verify pass 全覆盖 → verified；+ exec-review pass → closed", () => {
    const repoDir = makeScenario("r4-baseline", "demo");
    const ledger = ledgerOf(repoDir);
    appendSpec(ledger, "demo", "v1");
    appendSpecReview(ledger, "demo", "pass", "reviewer");
    expect(runCli(repoDir, ["status"]).stdout).toMatch(/demo\s+spec-frozen/);

    ledger.append("EvidenceSubmitted", {
      unitId: "demo",
      runId: "run-r4",
      commit: "c" + "2".repeat(39),
      paths: ["app.js"],
      sha256: ["d" + "2".repeat(63)],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId: "demo",
      runId: "run-r4",
      reportHash: "rh-r4",
      result: "pass",
      acceptanceIds: ACCEPTANCE.map((a) => a.id),
    });
    expect(runCli(repoDir, ["status"]).stdout).toMatch(/demo\s+verified/);

    ledger.append("VerdictSubmitted", {
      unitId: "demo",
      verdictKind: "exec-review",
      verdict: "pass",
    });
    expect(runCli(repoDir, ["status"]).stdout).toMatch(/demo\s+closed/);
  });
});

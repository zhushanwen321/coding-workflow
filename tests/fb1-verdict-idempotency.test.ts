/**
 * fb-1 单测：spec-review verdict 幂等守卫（设计 v6 §3.3-D8 + §3.1 场景 4，验收 V10）。
 * 真实 git tmp 仓 + 隔离 CW_HOME + 真实 CLI 子进程（走完整 dispatch 路径），零 mock。
 *
 * 构造取舍（相对 mx1 的 makeScenario/startRunner 二选一）：不启动 runner——守卫是
 * 入账层职责，谓词只读账本事件序列，与派发循环无关；启动 runner 只引入 poll 时延
 * 与 SIGTERM 清理复杂度。前置状态构造走真实 CLI（create / evidence submit --kind
 * spec / review submit——spec 的 schema + gate 校验路径真实覆盖）；仅对照组③的
 * verified 前置（EvidenceSubmitted + VerifyRan）用 ledger.append 直写（mx1 T6 同款
 * 手法：真实 CLI 构造需跑分钟级 verify 干净 checkout 重跑，而该前置只服务于
 * exec-review 的 evidenceRefs 校验，与守卫谓词无关）。
 *
 *   G1 守卫组（pass 已冻结形态）：reviewer pass 入账 → 同代再交 fail（迟到改判）
 *      → exit 1 + 恢复文案 + 账本零事件追加
 *   G2 守卫组（fail 打回形态）：reviewer fail 入账 → 同代第二条 fail 被拒收
 *      （改判路径同关——D8 行为变更记档的正路 = designer 重提新 spec）
 *   对照组②（跨代放行）：新 SpecSubmitted（designer 重提，内容不同 → 新
 *      specHash）入账后再交 verdict → 正常入账 exit 0——守卫只挡同代重复
 *   对照组③（exec-review 不误伤）：exec-review 连续两条 verdict（fail → pass，
 *      多轮 fail→修复→再审合法流程）→ 都正常入账
 *
 * 注意：CLI 子进程依赖 dist（先 npm run build；npm test 的 pretest 已含）；dist
 * 缺席时对应用例以 it.todo 挂起（mx1 同款条件激活模式）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../src/events/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const CLI_PATH = join(DIST_ROOT, "cli.js");
/** CLI 子进程用例：dist 缺席时挂起（pretest build 后自动激活） */
const distIt = existsSync(CLI_PATH) ? it : it.todo;

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fb1-"));
const cwHome = join(tmpRoot, "home");
const originalCwHome = process.env.CW_HOME;
process.env.CW_HOME = cwHome;

afterAll(() => {
  if (originalCwHome === undefined) {
    delete process.env.CW_HOME;
  } else {
    process.env.CW_HOME = originalCwHome;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---- 公共 fixture（mx1 同款） ----

/** 过 spec gate 规则的验收（两条：core e2e-real + unit 级冒烟） */
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
  git(repoDir, ["config", "user.email", "cw-fb1@example.com"]);
  git(repoDir, ["config", "user.name", "cw-fb1"]);
  writeFileSync(join(repoDir, "brief.md"), `# ${rootId} 任务书（fb1 fixture）\n`);
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

/** 真实 CLI 子进程（完整 dispatch 路径，与账本共享 cwd + CW_HOME） */
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

/** 提交 spec（真实 CLI 路径：schema 校验 + gate + 原文副本落 attachments） */
function submitSpec(repoDir: string, unitId: string, acceptance: readonly AcceptanceItem[], file: string): void {
  writeFileSync(join(repoDir, file), specJson(acceptance));
  const res = runCli(repoDir, ["evidence", "submit", "--kind", "spec", "--unit", unitId, "--file", file]);
  expect(res.code, `spec 提交应过 schema+gate（stderr: ${res.stderr}）`).toBe(0);
}

/** 提交 spec-review verdict 的参数串（三个用例共用形态） */
function specReviewArgs(unitId: string, verdict: "pass" | "fail", comment: string): readonly string[] {
  return ["review", "submit", "--unit", unitId, "--verdict-kind", "spec-review", "--verdict", verdict, "--comment", comment, "--role", "reviewer"];
}

/** 账本内该 unit 的 spec-review verdict 结果序列（按入账顺序） */
function specReviewVerdicts(repoDir: string, unitId: string): string[] {
  return ledgerOf(repoDir)
    .readAll()
    .filter(
      (ev) =>
        ev.type === "VerdictSubmitted" &&
        ev.payload.unitId === unitId &&
        (ev.payload as { verdictKind: string }).verdictKind === "spec-review",
    )
    .map((ev) => (ev.payload as { verdict: string }).verdict);
}

/** 守卫拒收文案的三段关键锚（结论句 + 走新代指引 + 可执行恢复命令） */
function expectGuardMessage(stderr: string, unitId: string): void {
  expect(stderr).toContain("该 spec 已有生效审查结论");
  expect(stderr).toContain("重提 spec 产生新 specHash");
  expect(stderr).toContain(`cw evidence submit --kind spec --unit ${unitId} --file spec.json`);
}

// ================================================================
// 守卫组：最后 SpecSubmitted 后已有 reviewer verdict → 同代再交被拒收
// ================================================================

describe("fb-1 V10 守卫组：同代重复 spec-review verdict 被入账层拒收", () => {
  distIt("G1 pass 已入账（spec-frozen）→ 迟到的改判 fail → exit 1 + 恢复文案 + 账本零事件追加", () => {
    const repoDir = makeScenario("g1-late-verdict", "fb1a");
    submitSpec(repoDir, "fb1a", ACCEPTANCE, "spec.json");
    const first = runCli(repoDir, specReviewArgs("fb1a", "pass", "首轮审查通过"));
    expect(first.code, `首条 pass 应入账（stderr: ${first.stderr}）`).toBe(0);

    const before = ledgerOf(repoDir).readAll().length;
    const dup = runCli(repoDir, specReviewArgs("fb1a", "fail", "迟到改判：发现漏项"));
    expect(dup.code).toBe(1);
    expectGuardMessage(dup.stderr, "fb1a");
    // 零事件追加：拒收是纯拒绝，账本前后事件数相等
    expect(ledgerOf(repoDir).readAll().length).toBe(before);
    // 账本里 spec-review verdict 仍恰 1 条（原 pass）
    expect(specReviewVerdicts(repoDir, "fb1a")).toEqual(["pass"]);
  });

  distIt("G2 fail 已入账（打回形态）→ 同代第二条 fail 被拒收（改判路径同关，正路 = 重提新 spec）", () => {
    const repoDir = makeScenario("g2-second-fail", "fb1b");
    submitSpec(repoDir, "fb1b", ACCEPTANCE, "spec.json");
    const first = runCli(repoDir, specReviewArgs("fb1b", "fail", "缺 A3 单元级用例"));
    expect(first.code, `首条 fail 应入账（stderr: ${first.stderr}）`).toBe(0);

    const before = ledgerOf(repoDir).readAll().length;
    const dup = runCli(repoDir, specReviewArgs("fb1b", "fail", "同代重复的第二条 fail"));
    expect(dup.code).toBe(1);
    expectGuardMessage(dup.stderr, "fb1b");
    expect(ledgerOf(repoDir).readAll().length).toBe(before);
    expect(specReviewVerdicts(repoDir, "fb1b")).toEqual(["fail"]);
  });
});

// ================================================================
// 对照组②：新 SpecSubmitted 入账后再交 verdict → 正常入账（跨代放行）
// ================================================================

describe("fb-1 V10 对照组②：designer 重提新 spec（新 specHash）后 verdict 正常入账", () => {
  distIt("fail → 新 SpecSubmitted（改 1 字节）→ pass → exit 0 且两条 verdict 都在账本", () => {
    const repoDir = makeScenario("c2-new-generation", "fb1c");
    submitSpec(repoDir, "fb1c", ACCEPTANCE, "spec-v1.json");
    expect(runCli(repoDir, specReviewArgs("fb1c", "fail", "v1 缺 A3")).code).toBe(0);

    // designer 重提（title 改 1 字节 → 内容不同 → 新 specHash，走新代）
    const revised: AcceptanceItem[] = ACCEPTANCE.map((a) =>
      a.id === "A2" ? { ...a, title: "单元级冒烟v2" } : a,
    );
    submitSpec(repoDir, "fb1c", revised, "spec-v2.json");

    const v2 = runCli(repoDir, specReviewArgs("fb1c", "pass", "v2 已补 A3"));
    expect(v2.code, `新代 verdict 应正常入账（stderr: ${v2.stderr}）`).toBe(0);
    expect(specReviewVerdicts(repoDir, "fb1c")).toEqual(["fail", "pass"]);
    // 投影收敛：新代 pass 驱动 spec-frozen
    expect(runCli(repoDir, ["status"]).stdout).toMatch(/fb1c\s+spec-frozen/);
  });
});

// ================================================================
// 对照组③：exec-review 连续两条 verdict → 都正常入账（守卫不误伤）
// ================================================================

describe("fb-1 V10 对照组③：exec-review 多轮 verdict 不受守卫影响", () => {
  distIt("exec-review fail → pass 连续两条都入账（多轮 fail→修复→再审是合法流程，verdict 锚 evidenceRefs）", () => {
    const repoDir = makeScenario("c3-exec-review", "fb1d");
    submitSpec(repoDir, "fb1d", ACCEPTANCE, "spec.json");
    expect(runCli(repoDir, specReviewArgs("fb1d", "pass", "spec 审查通过")).code).toBe(0);

    // verified 前置（mx1 T6 同款直写：EvidenceSubmitted + VerifyRan pass 覆盖全部
    // 验收 id）——为 exec-review 提供可引用的 runId；构造方式与守卫谓词无关
    const ledger = ledgerOf(repoDir);
    ledger.append("EvidenceSubmitted", {
      unitId: "fb1d",
      runId: "run-exec-1",
      commit: "c" + "0".repeat(39),
      paths: ["app.js"],
      sha256: ["d" + "0".repeat(63)],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId: "fb1d",
      runId: "run-exec-1",
      reportHash: "rh-fb1d-1",
      result: "pass",
      acceptanceIds: ACCEPTANCE.map((a) => a.id),
    });

    const e1 = runCli(repoDir, [
      "review", "submit", "--unit", "fb1d", "--verdict-kind", "exec-review",
      "--verdict", "fail", "--comment", "第一轮执行审查不通过",
      "--evidence-refs", "run-exec-1", "--role", "reviewer",
    ]);
    expect(e1.code, `exec-review 第一条应入账（stderr: ${e1.stderr}）`).toBe(0);
    // 同一 runId 上的第二条 exec-review verdict（fail → 修复 → 再审的连续形态）
    const e2 = runCli(repoDir, [
      "review", "submit", "--unit", "fb1d", "--verdict-kind", "exec-review",
      "--verdict", "pass", "--comment", "修复后复审通过",
      "--evidence-refs", "run-exec-1", "--role", "reviewer",
    ]);
    expect(e2.code, `exec-review 第二条应入账——守卫不得误伤（stderr: ${e2.stderr}）`).toBe(0);

    const execVerdicts = ledgerOf(repoDir)
      .readAll()
      .filter(
        (ev) =>
          ev.type === "VerdictSubmitted" &&
          ev.payload.unitId === "fb1d" &&
          (ev.payload as { verdictKind: string }).verdictKind === "exec-review",
      )
      .map((ev) => (ev.payload as { verdict: string }).verdict);
    expect(execVerdicts).toEqual(["fail", "pass"]);
  });
});

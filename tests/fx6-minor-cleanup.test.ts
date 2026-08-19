/**
 * fx-6 单测：minor 清账（docs/rewrite/acceptance/fx6-acceptance.md §5 G1-G5；
 * 进程内直调 dist 的 runLoop + 直写事件账本 + 真实 git 子进程 + tmp 目录 +
 * 隔离 CW_HOME，零 mock）。
 *
 *   G1 flake 签名去重：条目 E1 连挂 3 次（3 个不同 runId）→ 轮询窗口内 flake
 *      escalation 恰出声 1 次——M4 gate 四跑异常-1「连挂 runId 单调追加致 19 条
 *      重复出声」的直接断言（旧语义 = 文本比较，runIds 增长即重出）
 *   G2 本质变化重出：E1 连挂 2（出声 1 次）→ 追加 fail 使 E2 新加入连挂 →
 *      重出 1 次（累计 2 次，第二条消息含 E2 行）；期间 E1 计数增长（3→4）本身
 *      不构成重出（同组条目集合未变）
 *   G3 spec 维度不受影响：spec 打回代数 N → N+1（新代意见入账）→ 照常重出
 *      （mx-3 语义回归——spec 维度保持完整消息文本比较，各代意见不同是有意重出）
 *   G4 contract 签名去重：回炉活锁 deadlock 态 runId 追加不重出（代数达上限后
 *      追加一次解析失败 verify，签名 = 条目集合 + 代数档 均不变）
 *   G5 X1-X4 静态项：源文件 grep 断言（常量新名 / AGENTS.md 口径 / loop 注释
 *      重复段 / brief 措辞）
 *
 * G6 回归（rv5-flake-escalation 套件 + 全量绿）由波后验收命令覆盖，不在本文件
 * 重复实现。
 *
 * 注意：直接 `npx vitest run tests/fx6-minor-cleanup.test.ts` 不触发 pretest，
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

import type { AcceptanceItem } from "../dist/events/types.js";
import { runLoop } from "../dist/runner/loop.js";
import type { AgentSpawnAdapter } from "../dist/runner/spawn/types.js";
import { EventLedger } from "../dist/store/events-log.js";
import { ledgerPath } from "../dist/store/project.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
if (!existsSync(join(REPO_ROOT, "dist", "runner", "loop.js"))) {
  throw new Error("tests/fx6-minor-cleanup 需要 dist/（先 npm run build；npm test 的 pretest 已含）");
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fx6-"));
const originalCwHome = process.env.CW_HOME;
process.env.CW_HOME = join(tmpRoot, "cw-home");
process.env.CW_WORKTREE_HOME = join(tmpRoot, "cw-worktrees");

afterAll(() => {
  if (originalCwHome === undefined) {
    delete process.env.CW_HOME;
  } else {
    process.env.CW_HOME = originalCwHome;
  }
  delete process.env.CW_WORKTREE_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---- 基建：真实 git repo + 直写账本（append-only 短事务，与 loop 读并发安全） ----

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function gitRun(repoDir: string, args: readonly string[]): void {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8", timeout: 30_000 });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.error?.message ?? res.stderr}`);
  }
}

function makeRepo(name: string): string {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-fx6@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-fx6"]);
  writeFileSync(join(repoDir, "brief.md"), "# fx6 fixture 任务书\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  return repoDir;
}

function ledgerOf(repoDir: string): EventLedger {
  return new EventLedger(ledgerPath(process.env.CW_HOME ?? "", repoDir));
}

const E1: AcceptanceItem = { id: "E1", core: true, title: "被观察的 e2e 条目", type: "e2e-real", command: "node e1.js" };
const E2: AcceptanceItem = { id: "E2", core: true, title: "后加入连挂的 e2e 条目", type: "e2e-real", command: "node e2.js" };
const U1: AcceptanceItem = { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" };

function appendUnit(repoDir: string, unitId: string): void {
  ledgerOf(repoDir).append("UnitCreated", {
    unitId,
    parentId: null,
    briefRef: join(repoDir, "brief.md"),
  });
}

/** 一代 spec 周期：SpecSubmitted（tag 保证 hash 唯一）+ 过审 verdict → spec-frozen */
function appendSpecAndPass(repoDir: string, unitId: string, acceptance: readonly AcceptanceItem[], tag: string): void {
  const spec = { acceptance: [...acceptance], contracts: [], split: [] };
  ledgerOf(repoDir).append("SpecSubmitted", {
    unitId,
    specHash: sha(`${unitId}:${tag}:${JSON.stringify(spec)}`),
    acceptance: [...acceptance],
    contracts: [],
    split: [],
  });
  ledgerOf(repoDir).append("VerdictSubmitted", {
    unitId,
    verdictKind: "spec-review",
    verdict: "pass",
    role: "reviewer",
  });
}

/** 一代打回：SpecSubmitted + role=reviewer fail verdict（comment = 该代意见） */
function appendSpecAndFail(repoDir: string, unitId: string, acceptance: readonly AcceptanceItem[], tag: string, comment: string): void {
  const spec = { acceptance: [...acceptance], contracts: [], split: [] };
  ledgerOf(repoDir).append("SpecSubmitted", {
    unitId,
    specHash: sha(`${unitId}:${tag}:${JSON.stringify(spec)}`),
    acceptance: [...acceptance],
    contracts: [],
    split: [],
  });
  ledgerOf(repoDir).append("VerdictSubmitted", {
    unitId,
    verdictKind: "spec-review",
    verdict: "fail",
    role: "reviewer",
    comment,
  });
}

/**
 * 直写一条 fail VerifyRan：passIds = 本次机器判定 pass 集（不在集内的 e2e 条目
 * 记 flake 连挂 fail）；parseFailed = 解析失败条目（走 contract 通道、不进 flake）
 */
function appendVerifyFail(
  repoDir: string,
  unitId: string,
  runId: string,
  passIds: readonly string[],
  parseFailed: readonly string[] = [],
): void {
  ledgerOf(repoDir).append("VerifyRan", {
    unitId,
    runId,
    reportHash: sha(`report:${runId}`),
    result: "fail",
    acceptanceIds: [...passIds],
    ...(parseFailed.length > 0 ? { parseFailedAcceptanceIds: [...parseFailed] } : {}),
  });
}

/**
 * 本套件全部场景的派发集合恒空（转人工维度不派发）——spawn 被调用即 reject，
 * 意外派发让用例显式红而非静默挂起
 */
function noSpawnAdapter(): AgentSpawnAdapter {
  return {
    name: "fx6-no-spawn",
    spawn: () => Promise.reject(new Error("fx6: 本场景不应派发任何 spawn（转人工维度不派发）")),
  };
}

/** 捕获 runLoop 的 stdout/stderr（进程内直调；透传 write 回调供退出屏障使用） */
async function captureStd(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const collector = (chunks: string[]): typeof process.stdout.write =>
    ((chunk: unknown, cb?: (err?: Error | null) => void) => {
      chunks.push(String(chunk));
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

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

/** 每条转人工消息恰出现一次的首行特征串（计数 = 出声次数） */
const FLAKE_NEEDLE = "的 e2e 验收连挂 2 次以上（flake 疑似）";
const CONTRACT_NEEDLE = "的验收命令解析失败已 2 代回炉仍连挂";
const SPEC_NEEDLE = "的 spec-review 已打回";

/** 启动 loop（空转轮询观察）+ 窗口内推进账本 + 等 idle 收束退出的场景骨架 */
async function driveAnnounceScenario(
  repoDir: string,
  rootId: string,
  maxSpecRejects: number | undefined,
  mutate: () => void,
  mutateAtMs: number,
): Promise<{ code: number; out: string; err: string }> {
  const runPromise = captureStd(() =>
    runLoop({
      rootId,
      adapter: noSpawnAdapter(),
      cwd: repoDir,
      pollMs: 50,
      maxIdleMs: 1_200,
      ...(maxSpecRejects !== undefined ? { maxSpecRejects } : {}),
    }),
  );
  // 窗口等待：首轮出声（t≈0）必然先于追加时点（pollMs=50 下 loop 已跑 ~10 轮）
  await sleep(mutateAtMs);
  mutate();
  // 追加推进 idle 计时（totalEvents 变化刷新 lastProgressAt）；runLoop 的退出
  // 输出走 emitExitOutput 落盘屏障（captureStd 透传 write 回调），await 返回即完整
  return await runPromise;
}

// ---- G1：flake 签名去重（四跑异常-1 的直接断言） ----

describe("fx-6 G1 flake 签名去重：同组 acceptanceId 连挂 runId 追加只出声 1 次", () => {
  it("E1 连挂 2 出声后追加第 3 次 fail（新 runId）→ 不重出（恰 1 次，消息不含第 3 个 runId）", async () => {
    const repoDir = makeRepo("g1-flake-dedup");
    appendUnit(repoDir, "u-g1");
    appendSpecAndPass(repoDir, "u-g1", [E1, U1], "v1");
    appendVerifyFail(repoDir, "u-g1", "r1-g1", []);
    appendVerifyFail(repoDir, "u-g1", "r2-g1", []); // E1 连挂 2 → flakeReview 态

    const captured = await driveAnnounceScenario(
      repoDir,
      "u-g1",
      undefined,
      () => {
        // runId 单调追加（四跑形态）：消息文本必然变化，但条目集合 {E1} 不变
        appendVerifyFail(repoDir, "u-g1", "r3-g1", []);
      },
      500,
    );

    expect(captured.code).toBe(1); // 空转收束（转人工后无 machine 推进路径）
    expect(countOf(captured.err, FLAKE_NEEDLE)).toBe(1); // 核心：恰出声 1 次
    // 首声含前两个 runId；追加的 r3 不在任何出声里（未重出即未携带新事实行）
    expect(captured.err).toContain("验收 E1：当前 spec 周期内连续 2 次 fail（runId：r1-g1、r2-g1）");
    expect(captured.err).not.toContain("r3-g1");
    // 消息文本零降级：runIds 与恢复指引照旧在场
    expect(captured.err).toContain("cw report --unit u-g1");
    expect(captured.err).toContain("nondeterministic");
  }, 30_000);
});

// ---- G2：本质变化重出（新增条目进入连挂） ----

describe("fx-6 G2 flake 签名去重：新增 acceptanceId 进入连挂（本质变化）重出 1 次", () => {
  it("E1 连挂 2 出声 → E1 计数增长不重出 → E2 达连挂 2 → 累计出声 2 次（第二条含 E2）", async () => {
    const repoDir = makeRepo("g2-flake-regrow");
    appendUnit(repoDir, "u-g2");
    appendSpecAndPass(repoDir, "u-g2", [E1, E2], "v1");
    appendVerifyFail(repoDir, "u-g2", "r1-g2", ["E2"]); // E1 fail / E2 pass
    appendVerifyFail(repoDir, "u-g2", "r2-g2", ["E2"]); // E1 连挂 2 → 出声（集合 {E1}）

    // 双追加时序（driveAnnounceScenario 单追加骨架不敷用）：两笔都必须落在
    // loop 存活窗口内——r3 在首声后 500ms（计数增长，非本质变化），r4 在 r3 的
    // idle 窗口（1200ms）内再 +600ms（E2 连挂 2 → 集合变化，重出）
    const runPromise = captureStd(() =>
      runLoop({ rootId: "u-g2", adapter: noSpawnAdapter(), cwd: repoDir, pollMs: 50, maxIdleMs: 1_200 }),
    );
    await sleep(500);
    appendVerifyFail(repoDir, "u-g2", "r3-g2", []); // E1 连挂 3 / E2 连挂 1
    await sleep(600);
    appendVerifyFail(repoDir, "u-g2", "r4-g2", []); // E1 连挂 4 / E2 连挂 2 → 重出
    const captured = await runPromise;
    const err = captured.err;

    expect(captured.code).toBe(1);
    expect(countOf(err, FLAKE_NEEDLE)).toBe(2); // 首声 + 本质变化重声（r3 处不重出）
    // 第二条消息含 E2 的连挂事实行（E2 的连挂 = r3、r4）
    expect(err).toContain("验收 E2：当前 spec 周期内连续 2 次 fail（runId：r3-g2、r4-g2）");
  }, 30_000);
});

// ---- G3：spec 维度不受影响（mx-3 文本重出语义回归） ----

describe("fx-6 G3 spec 打回维度维持完整文本比较：代数 N → N+1 照常重出", () => {
  it("打回 2 代出声 → 追加第 3 代（新代意见）→ 重出（累计 2 次，第二条含第 3 代意见）", async () => {
    const repoDir = makeRepo("g3-spec-regrow");
    appendUnit(repoDir, "u-g3");
    appendSpecAndFail(repoDir, "u-g3", [E1, U1], "v1", "第1代意见：E1 命令缺标记行");
    appendSpecAndFail(repoDir, "u-g3", [E1, U1], "v2", "第2代意见：E1 命令仍缺标记行");

    const captured = await driveAnnounceScenario(
      repoDir,
      "u-g3",
      2, // maxSpecRejects：2 代即达预算（默认 10 太长，注入更紧运行策略值）
      () => {
        // 新代打回（spec 与 fail verdict 同步两笔入账，loop 轮询间无中间态窗口）
        appendSpecAndFail(repoDir, "u-g3", [E1, U1], "v3", "第3代意见：覆盖度不足");
      },
      500,
    );

    expect(captured.code).toBe(1);
    // 首声（2 代）+ 新代重声（3 代）——spec 维度各代意见不同是有意重出
    expect(countOf(captured.err, SPEC_NEEDLE)).toBe(2);
    expect(captured.err).toContain("的 spec-review 已打回 2 代（已达打回代数预算 2 代");
    expect(captured.err).toContain("的 spec-review 已打回 3 代（已达打回代数预算 2 代");
    expect(captured.err).toContain("第 3 代打回的意见：第3代意见：覆盖度不足");
  }, 30_000);
});

// ---- G4：contract（回炉活锁 deadlock）签名去重 ----

describe("fx-6 G4 contract 签名去重：deadlock 态 runId 追加不重出", () => {
  it("代数达上限出声 1 次后追加一次解析失败 verify（runId 追加）→ 不重出", async () => {
    const repoDir = makeRepo("g4-contract-dedup");
    appendUnit(repoDir, "u-g4");
    // 三代回炉：连挂 2 → 新 spec（代数+1）×2，末代再连挂 2 → specContractDeadlock
    appendSpecAndPass(repoDir, "u-g4", [E1], "v1");
    appendVerifyFail(repoDir, "u-g4", "r1-g4", [], ["E1"]);
    appendVerifyFail(repoDir, "u-g4", "r2-g4", [], ["E1"]);
    appendSpecAndPass(repoDir, "u-g4", [E1], "v2"); // generations=1
    appendVerifyFail(repoDir, "u-g4", "r3-g4", [], ["E1"]);
    appendVerifyFail(repoDir, "u-g4", "r4-g4", [], ["E1"]);
    appendSpecAndPass(repoDir, "u-g4", [E1], "v3"); // generations=2（达上限）
    appendVerifyFail(repoDir, "u-g4", "r5-g4", [], ["E1"]);
    appendVerifyFail(repoDir, "u-g4", "r6-g4", [], ["E1"]); // deadlock 态 → 出声

    const captured = await driveAnnounceScenario(
      repoDir,
      "u-g4",
      undefined,
      () => {
        // runId 追加：连挂计数 2→3、runIds 增长，但条目集合 {E1} 与代数档均不变
        appendVerifyFail(repoDir, "u-g4", "r7-g4", [], ["E1"]);
      },
      500,
    );

    expect(captured.code).toBe(1);
    expect(countOf(captured.err, CONTRACT_NEEDLE)).toBe(1); // 恰出声 1 次
    // 解析失败条目不进 flake 通道（无 flake 消息混入）
    expect(captured.err).not.toContain(FLAKE_NEEDLE);
    expect(captured.err).toContain("验收 E1：当前 spec 周期内连续 2 次解析失败（runId：r5-g4、r6-g4）");
    expect(captured.err).not.toContain("r7-g4");
    // 消息文本零降级：恢复指引照旧
    expect(captured.err).toContain("cw report --unit u-g4");
  }, 30_000);
});

// ---- G5：X1-X4 静态项（grep 断言） ----

describe("fx-6 G5 静态项：X1 常量名 / X2 AGENTS.md 口径 / X3b 注释重复段 / X4 brief 措辞", () => {
  it("X1：u5b 常量 DEVELOPER_IMPL_DISPATCH_LINE 在场，BUILDER_IMPL_DISPATCH_LINE 零残留", () => {
    const u5b = readFileSync(join(REPO_ROOT, "tests", "u5b-e2e.test.ts"), "utf-8");
    expect(u5b).toContain("DEVELOPER_IMPL_DISPATCH_LINE");
    expect(u5b).not.toContain("BUILDER_IMPL_DISPATCH_LINE");
  });

  it("X2：AGENTS.md mx-1 段为打回代数 ≥ 预算口径（默认 10），旧「≥2 转人工」零残留", () => {
    const agents = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf-8");
    const start = agents.indexOf("异源 reviewer 派发");
    const end = agents.indexOf("设计 v1.1", start);
    expect(start).toBeGreaterThanOrEqual(0);
    const mx1Section = agents.slice(start, end > 0 ? end : undefined);
    expect(mx1Section).toContain("打回代数 ≥ 预算转人工");
    expect(mx1Section).toContain("默认 10");
    expect(mx1Section).not.toContain("≥2 转人工");
  });

  it("X3b：loop.ts 抢答可见性注释不再重复（「ts 取自原始事件流」句恰出现 1 次）", () => {
    const loop = readFileSync(join(REPO_ROOT, "src", "runner", "loop.ts"), "utf-8");
    expect(countOf(loop, "verdict 的入账 ts 取自原始事件流")).toBe(1);
  });

  it("X4：brief.ts 规则⑨括注为精确措辞（等号形态唯一放行），mx5-5 F1 旧括注消失", () => {
    const brief = readFileSync(join(REPO_ROOT, "src", "runner", "brief.ts"), "utf-8");
    expect(brief).toContain("规则⑨口径更严：仅等号形态 --reporter=json（值恰为 json）放行");
    expect(brief).toContain("空格形态");
    expect(brief).toContain("无论值一律拒");
    expect(brief).not.toContain("（与 spec gate 规则⑨同口径：cw 自动追加");
  });
});

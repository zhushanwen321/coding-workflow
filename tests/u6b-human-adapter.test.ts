/**
 * u6b human 适配器单测（docs/rewrite/acceptance/u6b-acceptance.md 单测验收 6 组）。
 *
 * 真实账本 + 真实子进程写事件，零 mock：
 *   - setup（UnitCreated / 旧 SpecSubmitted 等前置事件）由测试进程用真实 EventLedger
 *     写入真实账本文件；
 *   - 「人」的进展事件由真实 node 子进程向账本文件 append JSONL 行。子进程直写
 *     而非 import EventLedger，是因为子进程无法加载 TS 源（本文件不依赖 npm run
 *     build 的 dist 产物，`npx vitest run tests/u6b-*.test.ts` 可独立跑）；被测的
 *     wait() 只读账本文件内容、对写入方无感知，事件信封形状与 EventLedger.append
 *     逐字段一致（seq 续末行 + ISO ts + type + payload）。
 *
 * 时序护栏：进展事件的 ts 由子进程时钟生成，天然晚于 spawn() 入口的起始时间戳
 * （node 子进程冷启动开销 >> 时钟毫秒精度），无需额外等待。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type {
  EvidenceSubmittedPayload,
  SpecSubmittedPayload,
  UnitCreatedPayload,
  VerdictSubmittedPayload,
  VerifyRanPayload,
} from "../src/events/types.js";
import { humanAdapter } from "../src/runner/spawn/human.js";
import type {
  AgentRole,
  AgentSpawnAdapter,
  AgentSpawnRequest,
} from "../src/runner/spawn/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u6b-human-"));
const cwHome = join(tmpRoot, "cw-home");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 子进程写事件脚本：读账本末行数推导 seq → append 一行 JSONL（真实进程写真实文件）。
 *  node -e 的 process.argv = [node, arg1, arg2, ...]（无 script 路径占位），故 slice(1) */
const CHILD_APPEND_EVENT_SCRIPT = [
  "const fs = require('fs');",
  "const [file, type, payloadJson] = process.argv.slice(1);",
  "const lines = fs.readFileSync(file, 'utf8').split('\\n').filter((l) => l !== '');",
  "const envelope = { seq: lines.length + 1, ts: new Date().toISOString(), type, payload: JSON.parse(payloadJson) };",
  "fs.appendFileSync(file, JSON.stringify(envelope) + '\\n');",
].join(" ");

/** 「人肉操作」的等价物：另一真实子进程向账本追加一条进展事件 */
function appendEventFromRealChild(
  ledgerFile: string,
  type: "SpecSubmitted" | "EvidenceSubmitted" | "VerdictSubmitted" | "UnitCreated" | "VerifyRan",
  payload: unknown,
): void {
  const res = spawnSync(
    process.execPath,
    ["-e", CHILD_APPEND_EVENT_SCRIPT, ledgerFile, type, JSON.stringify(payload)],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`子进程写事件失败（${type} → ${ledgerFile}）：${res.stderr}`);
  }
}

interface Scenario {
  workdir: string;
  /** fx-4：spawn 过程产物根（run 级 topic 目录的替身——适配器场景无 runLoop，测试自管） */
  artifactDir: string;
  ledgerFile: string;
}

/** 独立场景：tmp workdir + 隔离 CW_HOME 下的独立账本（per-cwd 编码）+ UnitCreated 前置 */
function makeScenario(name: string, unitId: string): Scenario {
  const workdir = join(tmpRoot, name);
  const artifactDir = join(tmpRoot, `${name}-topic`);
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, "brief.md"), "# u6b 任务书 fixture\n");
  const ledger = new EventLedger(ledgerPath(cwHome, workdir));
  ledger.append("UnitCreated", { unitId, parentId: null, briefRef: "brief.md" });
  return { workdir, artifactDir, ledgerFile: ledgerPath(cwHome, workdir) };
}

function spawnRequest(
  scenario: Scenario,
  unitId: string,
  role: AgentRole,
  timeoutMs: number,
): AgentSpawnRequest {
  return {
    role,
    unitId,
    workdir: scenario.workdir,
    // wt-2 迁移：u6b 场景的 workdir 即项目目录（无 worktree 拆分），账本锚定不变
    projectCwd: scenario.workdir,
    artifactDir: scenario.artifactDir,
    briefPath: join(scenario.workdir, "brief.md"),
    env: { CW_HOME: cwHome },
    timeoutMs,
  };
}

/** 产物路径（<artifactDir>/<unitId>.<role>.stdout|stderr 约定，fx-4 起产物根随 topic） */
function artifactPath(
  scenario: Scenario,
  unitId: string,
  role: AgentRole,
  kind: "stdout" | "stderr",
): string {
  return join(scenario.artifactDir, `${unitId}.${role}.${kind}`);
}

function specPayload(unitId: string): SpecSubmittedPayload {
  return { unitId, specHash: "u6b-fixture-hash", acceptance: [], contracts: [], split: [] };
}

function evidencePayload(unitId: string, runId: string): EvidenceSubmittedPayload {
  return { unitId, runId, commit: "0f1e2d3c4b5a", paths: [], sha256: [], exitCode: 0 };
}

function verifyRanPayload(unitId: string, runId: string): VerifyRanPayload {
  return { unitId, runId, reportHash: "rh-fixture", result: "pass", acceptanceIds: [] };
}

function childCreatedPayload(unitId: string, parentId: string): UnitCreatedPayload {
  return { unitId, parentId, briefRef: "brief-child.md" };
}

function verdictPayload(unitId: string): VerdictSubmittedPayload {
  return { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("u6b human 适配器", () => {
  it("验收#1 spawn 指令三要素：stdoutPath 落盘含 cd workdir / briefPath / role 步骤关键词；stderr 空", async () => {
    const scenario = makeScenario("instruction", "instr");
    const briefPath = join(scenario.workdir, "brief.md");

    for (const role of ["designer", "builder", "reviewer"] as const) {
      // spawn 立即返回即产物就绪（human 无子进程，文件写入先于 handle 返回）
      await humanAdapter.spawn(spawnRequest(scenario, "instr", role, 60_000));
      const out = readFileSync(artifactPath(scenario, "instr", role, "stdout"), "utf8");
      expect(out, `${role} 指令应含 workdir cd 命令`).toContain(`cd "${scenario.workdir}"`);
      expect(out, `${role} 指令应含 briefPath 路径`).toContain(briefPath);

      const stderr = artifactPath(scenario, "instr", role, "stderr");
      expect(existsSync(stderr), `${role} stderrPath 应落盘空文件`).toBe(true);
      expect(readFileSync(stderr, "utf8")).toBe("");
    }

    const designerOut = readFileSync(artifactPath(scenario, "instr", "designer", "stdout"), "utf8");
    expect(designerOut).toContain("cw evidence submit --kind spec");
    // mx-1：designer 指令不再含任何 review submit 步骤（spec-review 归独立 reviewer）
    expect(designerOut).not.toContain("review submit");
    const builderOut = readFileSync(artifactPath(scenario, "instr", "builder", "stdout"), "utf8");
    expect(builderOut).toContain("git commit");
    expect(builderOut).toContain("cw evidence submit --kind build");
    expect(builderOut).toContain("cw verify");
    const reviewerOut = readFileSync(artifactPath(scenario, "instr", "reviewer", "stdout"), "utf8");
    expect(reviewerOut).toContain("cw review submit");
    expect(reviewerOut).toContain("--verdict-kind spec-review");
    expect(reviewerOut).toContain("--verdict-kind exec-review");
    // mx-1：reviewer 指令内嵌 --role reviewer 自报（任务书模板与 CLI flag 对齐）
    expect(reviewerOut).toContain("--role reviewer");
    // 信任边界提示（human 无自动 reviewer，人自任）三 role 共有
    for (const role of ["designer", "builder", "reviewer"] as const) {
      expect(readFileSync(artifactPath(scenario, "instr", role, "stdout"), "utf8")).toContain(
        "无自动 reviewer",
      );
    }
  });

  it("验收#2 designer wait()：真实子进程 append SpecSubmitted → 轮询窗口内 resolve exitCode 0", async () => {
    const scenario = makeScenario("designer-wait", "dw");
    const handle = await humanAdapter.spawn(spawnRequest(scenario, "dw", "designer", 15_000));
    const waitPromise = handle.wait();
    // 人肉等价物：另一真实子进程向账本写该 unit 的 SpecSubmitted（ts 晚于 spawn 起始）
    appendEventFromRealChild(scenario.ledgerFile, "SpecSubmitted", specPayload("dw"));
    const result = await waitPromise;
    expect(result.exitCode).toBe(0);
    expect(result.stdoutPath).toBe(artifactPath(scenario, "dw", "designer", "stdout"));
    expect(result.stderrPath).toBe(artifactPath(scenario, "dw", "designer", "stderr"));
    expect(result.pid).toBe(-1); // human 无子进程，-1 = 不适用（与 lifecycle/pi 一致）
  });

  it("验收#3 builder wait() 事件按 role 过滤：SpecSubmitted / EvidenceSubmitted 均不触发（完成信号对齐任务书第 3 步 cw verify），VerifyRan 才触发", async () => {
    const scenario = makeScenario("builder-filter", "bf");
    // spawn 前账本已有 SpecSubmitted（ts 早于 spawn 起始——旧事件 + 类型不符双重不触发）
    new EventLedger(scenario.ledgerFile).append("SpecSubmitted", specPayload("bf"));
    const handle = await humanAdapter.spawn(spawnRequest(scenario, "bf", "builder", 15_000));
    const waitPromise = handle.wait();

    // spawn 之后写入的新 SpecSubmitted / EvidenceSubmitted（晚于起始、同 unit）：
    // builder 任务书第 3 步（cw verify）才是最后一步——前两步的产物若提前
    // resolve，verify 永远无人执行，loop 重算时 unit 仍 spec-frozen 只能重派
    appendEventFromRealChild(scenario.ledgerFile, "SpecSubmitted", specPayload("bf"));
    appendEventFromRealChild(scenario.ledgerFile, "EvidenceSubmitted", evidencePayload("bf", "run-bf-1"));
    const state = await Promise.race([
      waitPromise.then(() => "resolved" as const),
      sleep(1_500).then(() => "pending" as const),
    ]);
    expect(
      state,
      "builder wait() 对 SpecSubmitted / EvidenceSubmitted 不应误判（轮询 1s，观察窗 1.5s）",
    ).toBe("pending");

    appendEventFromRealChild(scenario.ledgerFile, "VerifyRan", verifyRanPayload("bf", "run-bf-1"));
    const result = await waitPromise;
    expect(result.exitCode).toBe(0);
  });

  it("验收#4 超时：timeoutMs=800 无进展事件 → TIMEOUT", async () => {
    const scenario = makeScenario("timeout", "to");
    const startedAt = Date.now();
    const handle = await humanAdapter.spawn(spawnRequest(scenario, "to", "builder", 800));
    const result = await handle.wait();
    expect(result.exitCode).toBe("TIMEOUT");
    expect(result.pid).toBe(-1); // human 无子进程，-1 = 不适用
    // 不早于 timeoutMs（spawn 前 t0 为下界）；不显著晚于（轮询间隔 min(1000, 800/10)=80ms）
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(3_000);
  });

  it("验收#5 kill()：wait() 返回 CRASH（手动中止语义，人肉无进程可杀）", async () => {
    const scenario = makeScenario("kill", "kl");
    const handle = await humanAdapter.spawn(spawnRequest(scenario, "kl", "reviewer", 60_000));
    handle.kill();
    handle.kill(); // 幂等：重复调用无害
    const first = await handle.wait();
    expect(first.exitCode).toBe("CRASH");
    expect(first.stdoutPath).toBe(artifactPath(scenario, "kl", "reviewer", "stdout"));
    expect(first.stderrPath).toBe(artifactPath(scenario, "kl", "reviewer", "stderr"));
    expect(first.pid).toBe(-1); // human 无子进程，-1 = 不适用
    const again = await handle.wait();
    expect(again).toBe(first); // wait() 可重复调用同结果（waitPromise 缓存）
  });

  it("验收#6 注册形态：humanAdapter 满足 AgentSpawnAdapter 类型（tsc 即证）", () => {
    const adapter: AgentSpawnAdapter = humanAdapter;
    expect(adapter.name).toBe("human");
    expect(typeof adapter.spawn).toBe("function");
  });
});

// ---- designer 完成信号按任务书分支扩展（fx 失配修复回归；mx-1 口径重排） ----
// 修复前 designer 完成信号唯一映射 SpecSubmitted：补建子分支（产出是子 unitId 的
// UnitCreated）不匹配，`cw run` 缺省 human 后端下必然空转满 30min TIMEOUT。
// mx-1 起 spec 补审分支删除（spec-review 归独立 reviewer，designer 遇
// VerdictSubmitted 不结算——结算了 loop 会在任务未完成时重算重派）。

describe("u6b human 适配器：designer 完成信号按任务书分支扩展", () => {
  it("designer + VerdictSubmitted → 不触发（mx-1：spec-review 归独立 reviewer，verdict 不是 designer 的完成信号）", async () => {
    const scenario = makeScenario("designer-verdict", "drr");
    const handle = await humanAdapter.spawn(spawnRequest(scenario, "drr", "designer", 15_000));
    const waitPromise = handle.wait();
    appendEventFromRealChild(scenario.ledgerFile, "VerdictSubmitted", verdictPayload("drr"));
    const state = await Promise.race([
      waitPromise.then(() => "resolved" as const),
      sleep(1_500).then(() => "pending" as const),
    ]);
    expect(state, "designer wait() 对 spec-review verdict 不应结算（观察窗 1.5s）").toBe("pending");
    // designer 的真完成信号（SpecSubmitted）到达后正常结算
    appendEventFromRealChild(scenario.ledgerFile, "SpecSubmitted", specPayload("drr"));
    const result = await waitPromise;
    expect(result.exitCode).toBe(0);
  });

  it("designer + 子 UnitCreated（payload.parentId === 本 unit，补建子分支）→ wait 正常返回 exitCode 0", async () => {
    const scenario = makeScenario("designer-missing-children", "dmc");
    const handle = await humanAdapter.spawn(spawnRequest(scenario, "dmc", "designer", 15_000));
    const waitPromise = handle.wait();
    // 补建子任务书的产出：新建子 unit 的 UnitCreated——事件 unitId 是子、
    // parentId 才指向本 unit（按 parent 维度匹配）
    appendEventFromRealChild(
      scenario.ledgerFile,
      "UnitCreated",
      childCreatedPayload("dmc-child-1", "dmc"),
    );
    const result = await waitPromise;
    expect(result.exitCode).toBe(0);
  });

  it("designer + 与本 unit 无关的 UnitCreated（parentId 指向别的 unit）→ 不触发（parent 维度匹配的判别力）", async () => {
    const scenario = makeScenario("designer-unrelated", "dur");
    const handle = await humanAdapter.spawn(spawnRequest(scenario, "dur", "designer", 15_000));
    const waitPromise = handle.wait();
    appendEventFromRealChild(
      scenario.ledgerFile,
      "UnitCreated",
      childCreatedPayload("dur-child-x", "someone-else"),
    );
    const state = await Promise.race([
      waitPromise.then(() => "resolved" as const),
      sleep(1_500).then(() => "pending" as const),
    ]);
    expect(state, "他人子 unit 的创建不应触发本 unit 的 designer 完成（观察窗 1.5s）").toBe(
      "pending",
    );
    handle.kill(); // 观察完毕收尾，不空等超时
    await waitPromise;
  });
});

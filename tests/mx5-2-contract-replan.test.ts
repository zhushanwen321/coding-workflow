/**
 * mx5-2 F 系：解析失败回炉投影 + 派发链 + D6 文案诚实化（docs/rewrite/acceptance/
 * mx5-2-acceptance.md §5 F1-F11）。零 mock：真实事件账本（隔离 CW_HOME 的 tmp
 * 目录）+ 真实 git 子进程（loop 系用例）+ 直写账本构造（mx5-1 P 系同款——毒 spec
 * 规则⑨后入不了正常路径，直写正是回炉通道要消费的漏网形态）。
 *
 * 分层：
 *   - F1-F7 / F9 / F11：dispatch 层（frontier/status 只读命令 + writeBriefFile
 *     直渲染）——直写账本构造连挂事实，零子进程；
 *   - F8 / F10：runLoop 进程内直调（u7b stepped adapter 同款——spawn 时同步
 *     副作用 + wait() 按脚本返回四态；真实 git repo + 真实账本），覆盖
 *     DISPATCH_SHAPE 映射、派发排除清单、escalation 出声与 describeExit 的
 *     停派态文案。
 *
 * 注意：F8/F10 从 dist 导入 runLoop（loop 系测试约定）——直接
 * `npx vitest run tests/mx5-2-*.test.ts` 不触发 pretest，需先 `npm run build`
 *（`npm test` 的 pretest 已含）。
 */
import { spawnSync } from "node:child_process";
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

import { afterAll, beforeEach, describe, expect, it } from "vitest";

// loop 系测试约定：runLoop 从 dist 导入（pretest build；直跑需先 npm run build）
import { runLoop } from "../dist/runner/loop.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
  SpawnResult,
} from "../dist/runner/spawn/types.js";
import { fold } from "../src/core/fold.js";
import { dispatch } from "../src/dispatch.js";
import type { AcceptanceItem } from "../src/events/types.js";
import { flakeReviewFacts, specContractFacts } from "../src/readonly/frontier.js";
import { writeBriefFile } from "../src/runner/brief.js";
import { EventLedger } from "../src/store/events-log.js";
import { evidenceDir, ledgerPath } from "../src/store/project.js";

const LOOP_DIST = fileURLToPath(new URL("../dist/runner/loop.js", import.meta.url));
const SPAWN_TYPES_DIST = fileURLToPath(new URL("../dist/runner/spawn/types.js", import.meta.url));
if (!existsSync(LOOP_DIST) || !existsSync(SPAWN_TYPES_DIST)) {
  throw new Error("tests/mx5-2 需要 dist/runner/{loop,spawn/types}.js（先 npm run build；npm test 的 pretest 已含）");
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-mx52-"));
const cwHome = join(tmpRoot, "home");
const originalCwHome = process.env.CW_HOME;
// loop 系用例的 worktree 根隔离（rv5 同款）
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  if (originalCwHome === undefined) {
    delete process.env.CW_HOME;
  } else {
    process.env.CW_HOME = originalCwHome;
  }
  delete process.env.CW_WORKTREE_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

let caseNo = 0;
let cwd: string;
let ledger: EventLedger;

beforeEach(() => {
  process.env.CW_HOME = cwHome;
  caseNo += 1;
  cwd = join(tmpRoot, `case-${caseNo}`);
  ledger = new EventLedger(ledgerPath(cwHome, cwd));
});

// ---- dispatch 层基建（mx5-1 同款） ----

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: readonly string[]): Promise<Captured> {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof origOut;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof origErr;
  try {
    const code = await dispatch(args, cwd);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** 全维度 frontier --json 分组（与派发判定同一出处） */
interface FrontierJson {
  specReady: string[];
  specReviewPending: string[];
  specFixPending: string[];
  specReviewDeadlock: string[];
  missingChildren: string[];
  integrationDrift: string[];
  integrationReady: string[];
  specContractBroken: string[];
  specContractDeadlock: string[];
  flakeReview: string[];
  buildReady: string[];
  execReviewReady: string[];
}

async function frontierGroups(): Promise<FrontierJson> {
  const res = await run(["frontier", "--json"]);
  expect(res.code, `frontier 应成功（stderr: ${res.stderr}）`).toBe(0);
  return JSON.parse(res.stdout) as FrontierJson;
}

/**
 * 过 gate 的验收集（spec-frozen 前置）：E1 e2e-real（command 首 token node 在
 * PATH）+ U1 unit 级（规则⑤）。command 文本不真实执行——投影只消费事件字段。
 */
function contractAcceptance(): AcceptanceItem[] {
  return [
    { id: "E1", core: true, title: "应用可运行", type: "e2e-real", command: "node e1.js" },
    { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" },
  ];
}

/** 入账 UnitCreated + SpecSubmitted + reviewer pass（unit 进入 spec-frozen） */
function appendFrozenSpec(unitId: string, acceptance: AcceptanceItem[], specNo = 0): void {
  ledger.append("UnitCreated", { unitId, parentId: null, briefRef: "brief.md" });
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: `${unitId}-spec-${specNo}`,
    acceptance,
    contracts: [],
    split: [],
  });
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
}

/** 回炉后再冻结（新 SpecSubmitted + pass verdict——代数在 SpecSubmitted 时点累计） */
function appendResubmittedSpec(unitId: string, acceptance: AcceptanceItem[], specNo: number): void {
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: `${unitId}-spec-${specNo}`,
    acceptance,
    contracts: [],
    split: [],
  });
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
}

interface VerifyRanInput {
  runId: string;
  result: "pass" | "fail";
  acceptanceIds: string[];
  /** 携带时写 parseFailedAcceptanceIds 键（无解析失败不写键——与生产同形） */
  parseFailed?: string[];
}

function appendVerifyRan(unitId: string, input: VerifyRanInput): void {
  ledger.append("VerifyRan", {
    unitId,
    runId: input.runId,
    reportHash: `rh-${input.runId}`,
    result: input.result,
    acceptanceIds: input.acceptanceIds,
    ...(input.parseFailed === undefined ? {} : { parseFailedAcceptanceIds: input.parseFailed }),
  });
}

/** 解析失败连挂的 VerifyRan 简写（fail + 空_pass 集 + parseFailed 清单） */
function parseFailRun(runId: string, parseFailed: string[]): VerifyRanInput {
  return { runId, result: "fail", acceptanceIds: [], parseFailed };
}

// ================================================================
// F1-F6：投影口径（dispatch 层直写账本 + frontier --json）
// ================================================================

describe("F1 连挂触发", () => {
  it("spec-frozen unit 同 id 两次 VerifyRan 带 parseFailedAcceptanceIds → specContractBroken", async () => {
    appendFrozenSpec("u-1", contractAcceptance());
    appendVerifyRan("u-1", parseFailRun("v1", ["E1"]));
    appendVerifyRan("u-1", parseFailRun("v2", ["E1"]));

    const groups = await frontierGroups();
    expect(groups.specContractBroken).toContain("u-1");
    expect(groups.specContractDeadlock).toEqual([]);
    // 单组归属：buildReady 让位（回炉优先于推进）
    expect(groups.buildReady).not.toContain("u-1");
  });
});

describe("F2 中间解析成功清零", () => {
  it("fail(parse) → pass（该 id 无解析失败）→ fail(parse) → 不触发（计数 1 未满 2）", async () => {
    appendFrozenSpec("u-1", contractAcceptance());
    appendVerifyRan("u-1", parseFailRun("v1", ["E1"]));
    // 中间一次解析成功（E1 在 pass 集、payload 无解析失败键）→ 清零
    appendVerifyRan("u-1", { runId: "v2", result: "pass", acceptanceIds: ["E1", "U1"] });
    appendVerifyRan("u-1", parseFailRun("v3", ["E1"]));

    const groups = await frontierGroups();
    expect(groups.specContractBroken).toEqual([]);
    expect(groups.specContractDeadlock).toEqual([]);
    // 中间 pass 覆盖全部验收 → verified，处于正常收尾维度
    expect(groups.execReviewReady).toContain("u-1");
  });
});

describe("F3 周期边界与代数", () => {
  it("连挂 2 → 新 SpecSubmitted（代数 1、连挂清零）→ 新周期连挂 1 → 不触发；再连挂 1 → broken（代数 1 <2）", async () => {
    const acceptance = contractAcceptance();
    appendFrozenSpec("u-1", acceptance, 1);
    appendVerifyRan("u-1", parseFailRun("v1", ["E1"]));
    appendVerifyRan("u-1", parseFailRun("v2", ["E1"]));
    expect((await frontierGroups()).specContractBroken).toContain("u-1"); // 周期 1 连挂达成

    // 回炉：designer 重提 spec（新周期锚 = SpecSubmitted 事件）+ 重新过审
    appendResubmittedSpec("u-1", acceptance, 2);
    let facts = specContractFacts(ledger.readAll()).get("u-1");
    expect(facts?.generations).toBe(1); // 代数累计
    expect(facts?.streaks).toEqual([]); // 连挂清零

    appendVerifyRan("u-1", parseFailRun("v3", ["E1"]));
    // 新周期连挂 1（旧周期 2 次不跨周期累计）→ 不触发
    let groups = await frontierGroups();
    expect(groups.specContractBroken).toEqual([]);
    expect(groups.buildReady).toContain("u-1"); // 未触发 → 正常推进维度

    appendVerifyRan("u-1", parseFailRun("v4", ["E1"]));
    // 新周期连挂满 2 → broken（代数 1 < 2，designer 第 2 次修复机会）
    groups = await frontierGroups();
    expect(groups.specContractBroken).toContain("u-1");
    expect(groups.specContractDeadlock).toEqual([]);
    facts = specContractFacts(ledger.readAll()).get("u-1");
    expect(facts?.generations).toBe(1);
    expect(facts?.streaks[0]).toMatchObject({ acceptanceId: "E1", consecutiveFails: 2 });
  });
});

describe("F4 integrate 排除", () => {
  it("integrate- 前缀 runId 的 VerifyRan 携带解析失败字段 → 不计数", async () => {
    appendFrozenSpec("u-1", contractAcceptance());
    appendVerifyRan("u-1", parseFailRun("integrate-11111111-1111-4111-8111-111111111111", ["E1"]));
    appendVerifyRan("u-1", parseFailRun("integrate-22222222-2222-4222-8222-222222222222", ["E1"]));

    const groups = await frontierGroups();
    expect(groups.specContractBroken).toEqual([]);
    expect(groups.specContractDeadlock).toEqual([]);
    expect(groups.buildReady).toContain("u-1"); // 集成产物不干扰常规推进
    expect(specContractFacts(ledger.readAll()).has("u-1")).toBe(false);
  });
});

describe("F5 代数满转人工", () => {
  it("两轮完整回炉（代数 2）→ 新 spec 周期再连挂 2 → specContractDeadlock（非 broken）", async () => {
    const acceptance = contractAcceptance();
    appendFrozenSpec("u-1", acceptance, 1);
    appendVerifyRan("u-1", parseFailRun("v1", ["E1"]));
    appendVerifyRan("u-1", parseFailRun("v2", ["E1"]));
    expect((await frontierGroups()).specContractBroken).toContain("u-1"); // broken 第 1 次

    appendResubmittedSpec("u-1", acceptance, 2); // 回炉代数 1
    appendVerifyRan("u-1", parseFailRun("v3", ["E1"]));
    appendVerifyRan("u-1", parseFailRun("v4", ["E1"]));
    expect((await frontierGroups()).specContractBroken).toContain("u-1"); // broken 第 2 次（代数 1 <2）

    appendResubmittedSpec("u-1", acceptance, 3); // 回炉代数 2（满）
    appendVerifyRan("u-1", parseFailRun("v5", ["E1"]));
    appendVerifyRan("u-1", parseFailRun("v6", ["E1"]));

    const groups = await frontierGroups();
    expect(groups.specContractDeadlock).toContain("u-1");
    expect(groups.specContractBroken).toEqual([]); // 代数满：谓词切换，不再派 designer
    const facts = specContractFacts(ledger.readAll()).get("u-1");
    expect(facts?.generations).toBe(2);
    expect(facts?.streaks[0]?.consecutiveFails).toBe(2);
    // escalation 文案断言在 F8 deadlock 场景（真实 runLoop stderr）
  });
});

describe("F6 deadlock 谓词", () => {
  it("代数 2 且当前周期连挂 0 或 1 → 既非 broken 也非 deadlock（unit 正常维度）", async () => {
    const acceptance = contractAcceptance();
    appendFrozenSpec("u-1", acceptance, 1);
    appendVerifyRan("u-1", parseFailRun("v1", ["E1"]));
    appendVerifyRan("u-1", parseFailRun("v2", ["E1"]));
    appendResubmittedSpec("u-1", acceptance, 2);
    appendVerifyRan("u-1", parseFailRun("v3", ["E1"]));
    appendVerifyRan("u-1", parseFailRun("v4", ["E1"]));
    appendResubmittedSpec("u-1", acceptance, 3); // 代数 2 满

    // 新周期连挂 0：两谓词皆不成立 → 正常维度（leaf buildReady）
    let groups = await frontierGroups();
    expect(groups.specContractBroken).toEqual([]);
    expect(groups.specContractDeadlock).toEqual([]);
    expect(groups.buildReady).toContain("u-1");
    expect(specContractFacts(ledger.readAll()).get("u-1")?.generations).toBe(2);

    // 新周期连挂 1：仍未满 2
    appendVerifyRan("u-1", parseFailRun("v5", ["E1"]));
    groups = await frontierGroups();
    expect(groups.specContractBroken).toEqual([]);
    expect(groups.specContractDeadlock).toEqual([]);
    expect(groups.buildReady).toContain("u-1");
  });
});

describe("F7 flake 排除与并存", () => {
  it("混合 unit（e2e 断言失败连挂 2 + 解析失败连挂 2）→ 归 specContractBroken、flakeReview 不列；对照 unit 照旧 flakeReview", async () => {
    // 混合 unit：E1 解析失败（回炉通道）、E2 断言失败（e2e-sh 标记 FAIL 形态——
    // parseError=false，不进 parseFailedAcceptanceIds）
    appendFrozenSpec("u-mix", [
      { id: "E1", core: true, title: "解析失败条目", type: "e2e-real", command: "node e1.js" },
      { id: "E2", core: true, title: "断言失败条目", type: "e2e-real", command: "node e2.js" },
      { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" },
    ]);
    appendVerifyRan("u-mix", { runId: "m1", result: "fail", acceptanceIds: ["U1"], parseFailed: ["E1"] });
    appendVerifyRan("u-mix", { runId: "m2", result: "fail", acceptanceIds: ["U1"], parseFailed: ["E1"] });
    // E2 两次都不在 pass 集（断言失败）→ flake 连挂 2 同真——单组归属由判定序裁决

    // 对照 unit：仅 e2e 断言失败连挂（无解析失败）→ 既有 flake 语义不回归
    appendFrozenSpec("u-ctl", [
      { id: "E1", core: true, title: "断言失败条目", type: "e2e-real", command: "node e1.js" },
      { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" },
    ]);
    appendVerifyRan("u-ctl", { runId: "c1", result: "fail", acceptanceIds: ["U1"] });
    appendVerifyRan("u-ctl", { runId: "c2", result: "fail", acceptanceIds: ["U1"] });

    const groups = await frontierGroups();
    // 混合 unit 归 broken（判定序先于 flakeReview），flakeReview 不再列它
    expect(groups.specContractBroken).toContain("u-mix");
    expect(groups.flakeReview).not.toContain("u-mix");
    // 对照 unit：解析失败条目不进 flake 输入的对称面——无解析失败时 flake 照旧
    expect(groups.flakeReview).toContain("u-ctl");
    expect(groups.specContractBroken).not.toContain("u-ctl");
  });

  it("flake 连挂输入排除解析失败条目：解析失败连挂满 2 的 e2e 条目不进 flakeReview", async () => {
    // 纯解析失败 unit（e2e 型）：连挂 2 次全部是 parseError 形态 → 只进回炉通道
    appendFrozenSpec("u-1", contractAcceptance());
    appendVerifyRan("u-1", parseFailRun("v1", ["E1"]));
    appendVerifyRan("u-1", parseFailRun("v2", ["E1"]));

    const groups = await frontierGroups();
    expect(groups.flakeReview).toEqual([]); // 三跑现场五的误判形态拆除
    expect(groups.specContractBroken).toContain("u-1");
  });
});

// ================================================================
// R1-facts / R2-facts：facts 级直断言（mx5-2 verifier 移交的覆盖缺口，mx5-4 顺带
// 补强——区别于 F2/F7 的组级断言：直接断投影函数输出，不被组归属优先级与
// verified 粘性态掩盖；对应排除/清零逻辑被删后此处必红）
// ================================================================

describe("R1-facts 输入排除双向直断言", () => {
  it("混合 unit：flakeReviewFacts 不含解析失败条目 ∧ specContractFacts 不含断言失败条目（删 flake 输入排除逻辑后必红）", () => {
    // 与 F7 同款混合 unit：E1 解析失败连挂 ×2（回炉通道输入）、E2 断言失败连挂 ×2
    //（e2e 不在 pass 集——flake 通道输入）
    appendFrozenSpec("u-mix", [
      { id: "E1", core: true, title: "解析失败条目", type: "e2e-real", command: "node e1.js" },
      { id: "E2", core: true, title: "断言失败条目", type: "e2e-real", command: "node e2.js" },
      { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" },
    ]);
    appendVerifyRan("u-mix", { runId: "m1", result: "fail", acceptanceIds: ["U1"], parseFailed: ["E1"] });
    appendVerifyRan("u-mix", { runId: "m2", result: "fail", acceptanceIds: ["U1"], parseFailed: ["E1"] });

    const events = ledger.readAll();
    // 方向一：flake 输出不含解析失败条目（E1）。E2 在场证明输出非空——空集不能
    // 证明排除逻辑存在；删 flakeReviewFacts 的 parseFailed 排除分支后 E1 计入 → 红
    const flake = flakeReviewFacts(events).get("u-mix");
    expect(flake?.map((f) => f.acceptanceId)).toContain("E2");
    expect(flake?.map((f) => f.acceptanceId)).not.toContain("E1");
    // 方向二：contract 输出不含断言失败条目（E2）。E1 在场同上
    const contract = specContractFacts(events).get("u-mix");
    expect(contract?.streaks.map((s) => s.acceptanceId)).toContain("E1");
    expect(contract?.streaks.map((s) => s.acceptanceId)).not.toContain("E2");
  });
});

describe("R2-facts 中间解析成功清零直断言", () => {
  it("fail(parse) → pass → fail(parse) 同 id：清零后计数 1（<2 不外露）；再 fail 后计数恰 2 且 runIds 不含被清零轮（删清零逻辑后必红）", () => {
    appendFrozenSpec("u-1", contractAcceptance());
    appendVerifyRan("u-1", parseFailRun("v1", ["E1"]));
    // 中间一次解析成功（v2 无解析失败键、E1 在 pass 集——unit 同时转 verified）→
    // E1 连挂清零。verified 是粘性态：组级断言（execReviewReady）无论清零与否都
    // 成立，只有 facts 级计数能直断清零发生
    appendVerifyRan("u-1", { runId: "v2", result: "pass", acceptanceIds: ["E1", "U1"] });
    appendVerifyRan("u-1", parseFailRun("v3", ["E1"]));

    // v1 已被清零 → 当前计数 1，低于外露阈值 2（streaks 空 / 无条目）
    const mid = specContractFacts(ledger.readAll()).get("u-1");
    expect(mid === undefined || mid.streaks.length === 0).toBe(true);

    // 数值直断：再挂一次后计数恰为 2（v3 起重计），runIds 不含 v1——
    // 删 specContractFacts 的清零分支 → 计数 3、runIds 含 v1，两断言必红
    appendVerifyRan("u-1", parseFailRun("v4", ["E1"]));
    const streak = specContractFacts(ledger.readAll()).get("u-1")?.streaks.find(
      (s) => s.acceptanceId === "E1",
    );
    expect(streak).toBeDefined();
    expect(streak?.consecutiveFails).toBe(2);
    expect(streak?.runIds).toEqual(["v3", "v4"]);
  });
});

// ================================================================
// F9 / F11：回炉任务书与只读输出（dispatch 层 + writeBriefFile 直渲染）
// ================================================================

/** 构造「当前周期两轮解析失败」账本 + verify 落盘产物（<id>.report.json 顶层 reason） */
function makeReplanFixture(withReports: boolean): { unitDir: string } {
  const acceptance = contractAcceptance();
  appendFrozenSpec("u-1", acceptance, 1);
  const rounds = [
    { runId: "verify-r1", reason: "验收 E1 产物解析失败：stdout 无标记行且 exitCode=0（e2e-sh 适配器无法判定）" },
    { runId: "verify-r2", reason: "验收 E1 产物解析失败：stdout 无标记行且 exitCode=0（第二轮原文）" },
  ];
  for (const round of rounds) {
    appendVerifyRan("u-1", parseFailRun(round.runId, ["E1"]));
    if (withReports) {
      const dir = evidenceDir(cwHome, cwd, "u-1", round.runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "E1.report.json"),
        `${JSON.stringify({ parseError: true, commandExit: 0, reason: round.reason }, null, 2)}\n`,
      );
    }
  }
  return { unitDir: cwd };
}

/** 渲染 specContractBroken 形态的 designer 任务书（mx5-3 B1 直渲染同款） */
function renderReplanBrief(): string {
  const projection = fold(ledger.readAll());
  const unit = projection.units.get("u-1");
  if (unit === undefined) {
    throw new Error("fixture 前置失败：fold 后应存在 unit u-1");
  }
  const artifactDir = join(tmpRoot, `art-${caseNo}`);
  const path = writeBriefFile(
    artifactDir,
    { role: "designer", unitId: "u-1", dimension: "specContractBroken" },
    unit,
    projection,
    "u-1",
    cwd,
    join(tmpRoot, "wt-u-1"),
  );
  return readFileSync(path, "utf-8");
}

describe("F9 回炉任务书内容", () => {
  it("渲染产物含全部解析失败验收 id、逐轮错误原文、恢复指引、spec diff 要求与独立 reviewer 提示", () => {
    makeReplanFixture(true);
    const content = renderReplanBrief();

    // 全部解析失败验收 id + 逐轮 runId 与原文（<id>.report.json 顶层 reason）
    expect(content).toContain("E1");
    expect(content).toContain("verify-r1");
    expect(content).toContain("verify-r2");
    expect(content).toContain("stdout 无标记行且 exitCode=0（e2e-sh 适配器无法判定）");
    expect(content).toContain("第二轮原文");
    // 规则⑨式恢复指引（按 type 对照）
    expect(content).toContain("标记行");
    expect(content).toContain("--reporter=json");
    expect(content).toContain("规则⑨");
    // spec diff 要求 + 重提命令 + 新 spec 照旧过独立 reviewer
    expect(content).toContain("spec diff");
    expect(content).toContain("cw evidence submit --kind spec --unit u-1 --file spec.json");
    expect(content).toContain("新 spec 照旧过独立 reviewer");
    expect(content).toContain("完成标志");
  }, 30_000);

  it("产物不可读时降级为 id + 产物文件路径（备案的底线形态）", () => {
    makeReplanFixture(false); // 不写 <id>.report.json
    const content = renderReplanBrief();

    expect(content).toContain("E1");
    expect(content).toContain("原文不可读");
    expect(content).toContain(join(evidenceDir(cwHome, cwd, "u-1", "verify-r1"), "E1.report.json"));
  }, 30_000);
});

describe("F11 只读输出", () => {
  it("frontier 文本与 JSON 两形态含新分组；status 对 broken/deadlock unit 正常呈现（parseFailed 字段经 --unit --json 可见）", async () => {
    // broken unit（F1 形态）
    appendFrozenSpec("u-1", contractAcceptance());
    appendVerifyRan("u-1", parseFailRun("v1", ["E1"]));
    appendVerifyRan("u-1", parseFailRun("v2", ["E1"]));

    const text = await run(["frontier"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("specContractBroken:");
    expect(text.stdout).toContain("specContractDeadlock:"); // 空组标题恒在
    // 展示序：新分组在 flakeReview 之前（与判定序同步）
    expect(text.stdout.indexOf("specContractBroken:")).toBeLessThan(text.stdout.indexOf("flakeReview:"));
    expect(text.stdout.indexOf("specContractBroken:\n  u-1")).toBeGreaterThanOrEqual(0);

    const json = await frontierGroups();
    expect(json.specContractBroken).toContain("u-1");
    expect(json.specContractDeadlock).toEqual([]);

    // status：列表视图正常呈现该 unit（状态 spec-frozen）；详情 --json 的
    // verifyRuns 携带 parseFailedAcceptanceIds（status.ts 的 {...unit} 展开天然
    // 透传，无需改动——提示经事件字段在场）
    const list = await run(["status"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("u-1  spec-frozen");
    const detail = await run(["status", "--unit", "u-1", "--json"]);
    expect(detail.code).toBe(0);
    const parsed = JSON.parse(detail.stdout) as {
      verifyRuns: Array<{ runId: string; parseFailedAcceptanceIds?: string[] }>;
    };
    expect(parsed.verifyRuns.some((r) => r.parseFailedAcceptanceIds?.includes("E1"))).toBe(true);
  });

  it("deadlock unit：frontier 文本/JSON 出现 specContractDeadlock 分组与 unit 条目", async () => {
    const acceptance = contractAcceptance();
    appendFrozenSpec("u-1", acceptance, 1);
    appendVerifyRan("u-1", parseFailRun("v1", ["E1"]));
    appendVerifyRan("u-1", parseFailRun("v2", ["E1"]));
    appendResubmittedSpec("u-1", acceptance, 2);
    appendVerifyRan("u-1", parseFailRun("v3", ["E1"]));
    appendVerifyRan("u-1", parseFailRun("v4", ["E1"]));
    appendResubmittedSpec("u-1", acceptance, 3);
    appendVerifyRan("u-1", parseFailRun("v5", ["E1"]));
    appendVerifyRan("u-1", parseFailRun("v6", ["E1"]));

    const text = await run(["frontier"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("specContractDeadlock:\n  u-1");
    expect(text.stdout).not.toContain("specContractBroken:\n  u-1");
    const json = await frontierGroups();
    expect(json.specContractDeadlock).toContain("u-1");
    const list = await run(["status"]);
    expect(list.stdout).toContain("u-1  spec-frozen");
  });
});

// ================================================================
// F8 / F10：runLoop 进程内直调（u7b stepped adapter 同款）
// ================================================================

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8", timeout: 30_000 });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 真实 tmp git 仓库（单 commit——loop 的 HEAD 快照与 worktree 基底） */
function makeRepo(name: string): string {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-mx52@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-mx52"]);
  writeFileSync(join(repoDir, "brief.md"), "# mx5-2 loop fixture 任务书\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  return repoDir;
}

/** 捕获 runLoop 的 stdout/stderr（进程内直调；透传 write 回调防 flush 屏障拖慢） */
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

interface AdapterStep {
  exitCode: SpawnResult["exitCode"];
  /** spawn 时同步执行（写账本等真实副作用） */
  onSpawn?: (req: AgentSpawnRequest) => void;
}

function handleOf(req: AgentSpawnRequest, exitCode: SpawnResult["exitCode"]): SpawnHandle {
  return {
    wait: async () => ({
      exitCode,
      stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
      stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
      pid: -1,
    }),
    kill: () => {},
  };
}

/** 脚本化 adapter（u7b 同款）：记录全部 spawn 请求 */
function makeSteppedAdapter(steps: readonly AdapterStep[]): {
  adapter: AgentSpawnAdapter;
  calls: AgentSpawnRequest[];
} {
  const calls: AgentSpawnRequest[] = [];
  return {
    adapter: {
      name: "mx52-stepped",
      spawn: async (req) => {
        calls.push(req);
        const step = steps[Math.min(calls.length - 1, steps.length - 1)];
        step.onSpawn?.(req);
        return handleOf(req, step.exitCode);
      },
    },
    calls,
  };
}

describe("F8 派发映射", () => {
  it("broken → DISPATCH_SHAPE 派 designer（任务书落盘且为回炉形态）；deadlock → 该 unit 零派发 + escalation 出声", async () => {
    // --- broken：真实 runLoop 派 designer，brief 落盘 ---
    const repoBroken = makeRepo("f8-broken");
    const ledgerBroken = new EventLedger(ledgerPath(cwHome, repoBroken));
    ledgerBroken.append("UnitCreated", { unitId: "root", parentId: null, briefRef: "brief.md" });
    ledgerBroken.append("SpecSubmitted", {
      unitId: "root",
      specHash: "f8-spec-1",
      acceptance: contractAcceptance(),
      contracts: [],
      split: [],
    });
    ledgerBroken.append("VerdictSubmitted", { unitId: "root", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    for (const runId of ["vb1", "vb2"]) {
      ledgerBroken.append("VerifyRan", {
        unitId: "root",
        runId,
        reportHash: `rh-${runId}`,
        result: "fail",
        acceptanceIds: [],
        parseFailedAcceptanceIds: ["E1"],
      });
    }

    const brokenAdapter = makeSteppedAdapter([{ exitCode: 0 }]);
    const brokenRun = await captureStd(() =>
      runLoop({
        rootId: "root",
        adapter: brokenAdapter.adapter,
        cwd: repoBroken,
        pollMs: 30,
        maxIdleMs: 1_200,
      }),
    );
    expect(brokenRun.code).toBe(1); // designer 无产出 → 空转 idle 收束
    expect(brokenAdapter.calls.length).toBeGreaterThanOrEqual(1);
    expect(brokenAdapter.calls[0]?.role).toBe("designer"); // DISPATCH_SHAPE：broken → designer
    expect(brokenAdapter.calls[0]?.unitId).toBe("root");
    // 任务书落盘 + 回炉形态（含恢复指引骨架句）
    const briefPath = brokenAdapter.calls[0]?.briefPath ?? "";
    expect(briefPath).not.toBe("");
    expect(existsSync(briefPath)).toBe(true);
    const brief = readFileSync(briefPath, "utf-8");
    // fa-3 适配：回炉模板标题由「验收命令契约回炉」升格为「确定性 spec 缺陷回炉」
    //（设计 D5/D6：specContractBroken 语义升格为解析失败 ∪ 无区分力的确定性 spec 缺陷回炉）
    expect(brief).toContain("确定性 spec 缺陷回炉");
    expect(brief).toContain("新 spec 照旧过独立 reviewer");
    // 派发可观测性：stderr/stdout 出声「转派 designer 修 spec 的验收命令契约」
    expect(brokenRun.out).toContain("转派 designer 修 spec 的验收命令契约");
    // 全部派发均为 designer（排除清单未误伤——broken 不是停派态）
    expect(brokenAdapter.calls.every((c) => c.role === "designer")).toBe(true);

    // --- deadlock：零派发 + 转人工出声 ---
    const repoDead = makeRepo("f8-deadlock");
    const ledgerDead = new EventLedger(ledgerPath(cwHome, repoDead));
    ledgerDead.append("UnitCreated", { unitId: "root", parentId: null, briefRef: "brief.md" });
    for (let specNo = 1; specNo <= 3; specNo += 1) {
      ledgerDead.append("SpecSubmitted", {
        unitId: "root",
        specHash: `f8-spec-${specNo}`,
        acceptance: contractAcceptance(),
        contracts: [],
        split: [],
      });
      ledgerDead.append("VerdictSubmitted", { unitId: "root", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
      for (const suffix of ["a", "b"]) {
        ledgerDead.append("VerifyRan", {
          unitId: "root",
          runId: `vd${specNo}${suffix}`,
          reportHash: `rh-vd${specNo}${suffix}`,
          result: "fail",
          acceptanceIds: [],
          parseFailedAcceptanceIds: ["E1"],
        });
      }
    }

    const deadAdapter = makeSteppedAdapter([{ exitCode: 0 }]); // 若误派发会被记录
    const deadRun = await captureStd(() =>
      runLoop({
        rootId: "root",
        adapter: deadAdapter.adapter,
        cwd: repoDead,
        pollMs: 30,
        maxIdleMs: 1_200,
      }),
    );
    expect(deadRun.code).toBe(1); // 停派后无 machine 推进路径，idle 收束
    expect(deadAdapter.calls.length).toBe(0); // 派发排除清单生效：零派发
    // escalation：2 代回炉事实 + 恢复指引（含逐 runId 与处置命令）
    expect(deadRun.err).toContain("停止对该 unit 派发");
    expect(deadRun.err).toContain("2 代回炉");
    expect(deadRun.err).toContain("恢复指引");
    expect(deadRun.err).toContain("vd3a");
    expect(deadRun.err).toContain("cw evidence submit --kind spec --unit root --file spec.json");
    expect(deadRun.err).toContain("--role reviewer");
  }, 30_000);
});

describe("F10 D6 文案", () => {
  it("TIMEOUT 在停派态：结算行输出「处于 X 停派态，本次超时不触发重派 + 恢复动作」；非停派态文案与现状一致", async () => {
    // --- 非停派态（回归锁）：正常 buildReady unit 的 TIMEOUT 结算行保持现状 ---
    const repoPlain = makeRepo("f10-plain");
    const ledgerPlain = new EventLedger(ledgerPath(cwHome, repoPlain));
    ledgerPlain.append("UnitCreated", { unitId: "root", parentId: null, briefRef: "brief.md" });
    ledgerPlain.append("SpecSubmitted", {
      unitId: "root",
      specHash: "f10-spec-1",
      acceptance: contractAcceptance(),
      contracts: [],
      split: [],
    });
    ledgerPlain.append("VerdictSubmitted", { unitId: "root", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    const plainAdapter = makeSteppedAdapter([{ exitCode: "TIMEOUT" }, { exitCode: "TIMEOUT" }]);
    const plainRun = await captureStd(() =>
      runLoop({
        rootId: "root",
        adapter: plainAdapter.adapter,
        cwd: repoPlain,
        pollMs: 30,
        maxIdleMs: 60_000,
      }),
    );
    expect(plainRun.code).toBe(1); // 连续 2 次 TIMEOUT → 转人工收束
    expect(plainRun.out).toContain("TIMEOUT，可重派（连续 2 次后转人工）"); // 现状文案不变
    expect(plainRun.out).not.toContain("停派态");

    // --- 停派态：developer spawn 在飞期间该 unit 因 e2e 连挂进入 flakeReview，
    //     其 TIMEOUT 结算行诚实化（不承诺不兑现的重派） ---
    const repoHalt = makeRepo("f10-halt");
    const ledgerHalt = new EventLedger(ledgerPath(cwHome, repoHalt));
    ledgerHalt.append("UnitCreated", { unitId: "root", parentId: null, briefRef: "brief.md" });
    ledgerHalt.append("SpecSubmitted", {
      unitId: "root",
      specHash: "f10-spec-1",
      acceptance: contractAcceptance(),
      contracts: [],
      split: [],
    });
    ledgerHalt.append("VerdictSubmitted", { unitId: "root", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    // 第 1 次 developer spawn 派发（buildReady）后，spawn 内写入两轮 e2e 断言失败
    //（E1 不在 pass 集、无解析失败）→ 该 unit 转入 flakeReview 停派态；随后该
    // spawn 结算 TIMEOUT → 结算行须改述真实行为
    const haltAdapter = makeSteppedAdapter([
      {
        exitCode: "TIMEOUT",
        onSpawn: () => {
          for (const runId of ["fh1", "fh2"]) {
            ledgerHalt.append("VerifyRan", {
              unitId: "root",
              runId,
              reportHash: `rh-${runId}`,
              result: "fail",
              acceptanceIds: ["U1"], // E1 断言失败（不在 pass 集、非解析失败）
            });
          }
        },
      },
    ]);
    const haltRun = await captureStd(() =>
      runLoop({
        rootId: "root",
        adapter: haltAdapter.adapter,
        cwd: repoHalt,
        pollMs: 30,
        maxIdleMs: 1_500,
      }),
    );
    expect(haltRun.code).toBe(1); // 停派 + 无 in-flight → idle 收束
    expect(haltRun.out).toContain("处于 flakeReview");
    expect(haltRun.out).toContain("停派态");
    expect(haltRun.out).toContain("本次超时不触发重派");
    expect(haltRun.out).toContain("恢复动作");
    expect(haltRun.out).not.toContain("可重派");
    // flake 转人工指引照常出声（既有出口不回归）
    expect(haltRun.err).toContain("停止对该 unit 派发 developer");
  }, 30_000);

  it("brief.ts 过时文案消失：specFixPending 与回炉模板渲染产物均不含「连续 2 次」/「累计 2 次」（对齐 mx-3 代数 / mx-4 预算语义）", () => {
    makeReplanFixture(true);
    const replan = renderReplanBrief();
    expect(replan).not.toContain("连续 2 次");
    expect(replan).not.toContain("累计 2 次");

    // specFixPending 模板（mx-1 既有形态）同步渲染对照
    const ledgerFix = new EventLedger(ledgerPath(cwHome, join(tmpRoot, "case-fix-comment")));
    ledgerFix.append("UnitCreated", { unitId: "u-fix", parentId: null, briefRef: "brief.md" });
    ledgerFix.append("SpecSubmitted", {
      unitId: "u-fix",
      specHash: "fix-spec-1",
      acceptance: contractAcceptance(),
      contracts: [],
      split: [],
    });
    ledgerFix.append("VerdictSubmitted", {
      unitId: "u-fix",
      verdictKind: "spec-review",
      verdict: "fail",
      comment: "不合格项：验收真空",
      role: "reviewer",
    });
    const projection = fold(ledgerFix.readAll());
    const unit = projection.units.get("u-fix");
    if (unit === undefined) {
      throw new Error("fixture 前置失败：fold 后应存在 unit u-fix");
    }
    const fixPath = writeBriefFile(
      join(tmpRoot, "art-fix"),
      { role: "designer", unitId: "u-fix", dimension: "specFixPending" },
      unit,
      projection,
      "u-fix",
      join(tmpRoot, "case-fix-comment"),
      join(tmpRoot, "wt-u-fix"),
    );
    const fix = readFileSync(fixPath, "utf-8");
    expect(fix).not.toContain("连续 2 次");
    expect(fix).not.toContain("累计 2 次");
    // 修复后的口径：打回按代数计数、达预算（默认 10 代）转人工
    expect(fix).toContain("打回代数");
    expect(fix).toContain("10 代");
  }, 30_000);
});

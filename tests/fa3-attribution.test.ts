/**
 * fa-3 失败归因测试套件（设计《.tmp/design-fail-attribution.md》v6 §3.3-D1/D3/D5
 * + §4 V4/V5③/V8；实现已完成、本套件补测试）。零 mock：真实事件账本（隔离
 * CW_HOME 的 tmp 目录）+ 真实 git 子进程 + 真实 dispatch 路径（u4b 同款进程内
 * 调用，走完整 verify handler 链）。
 *
 * 覆盖映射（设计断言编号 → 本文件用例）：
 *   - V8 并集去重投影语义（§4 V8 / D3①）：
 *       「同 id 双清单 ×2 轮 → 计数恰 2」「中间消失清零 → 重计再触发」；
 *   - V4 e2e 条目不误计 flake（§4 V4 / D3② 混合边角）：
 *       主 run fail + nd 清单 ×2 → 无 flakeReview、有 specContractBroken，
 *       对照 unit（纯 fail 连挂）flake 语义照旧；
 *   - D3② 清零判定在前的作用面：acceptanceIds ∩ nd 同真 → flake 侧清零
 *       （而非「不计数不清零」），contract 侧 nd 信号消失即清零；
 *   - mixed 独立计数（D3① 逐条目粒度）：X 仅 parseFailed / Y 仅 nd 双 streak
 *       各自计数互不污染，单条消失只清自身；
 *   - V2 前半（handler 级，契约合法封装形态 / D1 提取锚）：封装 typecheck 脚本
 *       常规 run 健康 pass + 红阶段基线 pass → VerifyRan 携带
 *       nonDiscriminativeAcceptanceIds、不写 parseFailedAcceptanceIds 键、
 *       result=fail（红阶段单列即致）、acceptanceIds 照旧含该条（机器 pass 事实）；
 *   - V5③（--no-red-phase 缺省）：同场景重跑 → payload 不携带
 *       nonDiscriminativeAcceptanceIds 键（hasOwnProperty 键存在性断言）；
 *   - D1 豁免边界（types.ts 封闭枚举）：nondeterministic 声明条目红阶段跳过
 *       判定（redPhase 节 discriminative=true）→ 不入 nd 清单；
 *   - D5 回炉任务书取数分流（文案级，writeBriefFile 直渲染——mx5-2 F9 同款）：
 *       混合信号（parse-failed ×2 + nd ×2）任务书含「确定性」升格语、两类来源
 *       标记行、build commit 结构核查提示、layer: "topic" 替代路径、两信号各自
 *       从正确的产物文件取到 reason 原文（E2.report.json 干扰项不被读）；
 *       产物缺失 → 降级行（id + 两类 reportPath 兜底）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { fold } from "../src/core/fold.js";
import { dispatch } from "../src/dispatch.js";
import type { AcceptanceItem, VerifyRanPayload } from "../src/events/types.js";
import { flakeReviewFacts, specContractFacts } from "../src/readonly/frontier.js";
import { writeBriefFile } from "../src/runner/brief.js";
import { EventLedger } from "../src/store/events-log.js";
import { evidenceDir, ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fa3-"));
const cwHome = join(tmpRoot, "home");
const originalCwHome = process.env.CW_HOME;

afterAll(() => {
  if (originalCwHome === undefined) {
    delete process.env.CW_HOME;
  } else {
    process.env.CW_HOME = originalCwHome;
  }
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

// ---- dispatch 层基建（u4b / mx5-2 同款） ----

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
  reflectionPending: string[];
  specReviewPending: string[];
  specFixPending: string[];
  specReviewDeadlock: string[];
  missingChildren: string[];
  integrationDrift: string[];
  integrationReady: string[];
  specContractBroken: string[];
  specContractDeadlock: string[];
  flakeReview: string[];
  buildDrift: string[];
  buildReady: string[];
  execReviewReady: string[];
}

async function frontierGroups(): Promise<FrontierJson> {
  const res = await run(["frontier", "--json"]);
  expect(res.code, `frontier 应成功（stderr: ${res.stderr}）`).toBe(0);
  return JSON.parse(res.stdout) as FrontierJson;
}

/** 过 gate 的验收集（spec-frozen 前置）：E1 e2e-real + U1 unit 级（mx5-2 同款） */
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

interface VerifyRanInput {
  runId: string;
  result: "pass" | "fail";
  acceptanceIds: string[];
  /** 携带时写 parseFailedAcceptanceIds 键（无解析失败不写键——与生产同形） */
  parseFailed?: string[];
  /** 携带时写 nonDiscriminativeAcceptanceIds 键（fa-3 D1：无无区分力不写键） */
  nonDiscriminative?: string[];
}

function appendVerifyRan(unitId: string, input: VerifyRanInput): void {
  ledger.append("VerifyRan", {
    unitId,
    runId: input.runId,
    reportHash: `rh-${input.runId}`,
    result: input.result,
    acceptanceIds: input.acceptanceIds,
    ...(input.parseFailed === undefined ? {} : { parseFailedAcceptanceIds: input.parseFailed }),
    ...(input.nonDiscriminative === undefined
      ? {}
      : { nonDiscriminativeAcceptanceIds: input.nonDiscriminative }),
  });
}

/** 账本内全部 VerifyRan payload（handler 级断言的输入） */
function verifyRanPayloads(): VerifyRanPayload[] {
  return ledger
    .readAll()
    .filter((e) => e.type === "VerifyRan")
    .map((e) => e.payload as VerifyRanPayload);
}

// ---- git 基建（u4b makeGitRepo 扩展：支持子目录文件——scripts/ 需要） ----

function git(dir: string, args: readonly string[]): void {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
}

function writeRepoFiles(dir: string, files: ReadonlyArray<Record<string, string>>): void {
  for (const batch of files) {
    for (const [name, content] of Object.entries(batch)) {
      const full = join(dir, name);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
}

/** 真实 tmp git 仓库：init + 每次提交写入一批文件（支持子目录）；返回各 commit hash */
function makeGitRepo(dir: string, commitsFiles: ReadonlyArray<Record<string, string>>): string[] {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "cw-fa3@example.com"]);
  git(dir, ["config", "user.name", "cw-fa3"]);
  const hashes: string[] = [];
  commitsFiles.forEach((files, i) => {
    writeRepoFiles(dir, [files]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", `commit-${i + 1}`]);
    hashes.push(
      (spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ?? "").trim(),
    );
  });
  return hashes;
}

/** 入账 spec + build 证据（build 锚 = 当前 HEAD；u4b submitSpecAndBuild 参数化） */
function submitSpecAndBuild(acceptance: AcceptanceItem[]): void {
  ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
  ledger.append("SpecSubmitted", {
    unitId: "u-1",
    specHash: "fa3-spec-1",
    acceptance,
    contracts: [],
    split: [],
  });
  ledger.append("EvidenceSubmitted", {
    unitId: "u-1",
    runId: "run-1",
    commit: (spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ?? "").trim(),
    paths: [],
    sha256: [],
    exitCode: 0,
  });
}

// ================================================================
// 投影级：V8 并集去重（§4 V8 / D3①）
// ================================================================

describe("V8 并集去重：同 id 同 run 双清单同真只计一次", () => {
  it("同 id 双清单 ×2 轮 → 连挂恰 = 2（非 3/4）、runIds 每 run 恰一次、specContractBroken 触发", async () => {
    appendFrozenSpec("u-1", contractAcceptance());
    // 主 run parseError 且红阶段判无区分力对同条目同 run 同真（judgeRedPhase 的
    // parseError 分支可达形态）——两清单同携同一 id
    appendVerifyRan("u-1", {
      runId: "v1",
      result: "fail",
      acceptanceIds: [],
      parseFailed: ["E1"],
      nonDiscriminative: ["E1"],
    });
    appendVerifyRan("u-1", {
      runId: "v2",
      result: "fail",
      acceptanceIds: [],
      parseFailed: ["E1"],
      nonDiscriminative: ["E1"],
    });

    const facts = specContractFacts(ledger.readAll()).get("u-1");
    const streak = facts?.streaks.find((s) => s.acceptanceId === "E1");
    expect(streak).toBeDefined();
    // 去重核心断言：2 而非 4（两清单 concat 不去重）/ 3 / 1
    expect(streak?.consecutiveFails).toBe(2);
    expect(streak?.runIds).toEqual(["v1", "v2"]);

    const groups = await frontierGroups();
    expect(groups.specContractBroken).toContain("u-1");
    expect(groups.specContractDeadlock).toEqual([]);
  });

  it("中间一轮该 id 从两清单消失 → 清零；再补两轮双清单 → 重计触发（去重不破坏清零/重计语义）", async () => {
    appendFrozenSpec("u-1", contractAcceptance());
    appendVerifyRan("u-1", {
      runId: "v1",
      result: "fail",
      acceptanceIds: [],
      parseFailed: ["E1"],
      nonDiscriminative: ["E1"],
    });
    // 中间一轮信号消失（E1 解析成功且区分力正常——payload 两键均不写；主 run
    // 仍 fail 保持 spec-frozen，不转 verified 粘性态——组归属仍走 contract 分支）
    appendVerifyRan("u-1", { runId: "v2", result: "fail", acceptanceIds: [] });
    appendVerifyRan("u-1", {
      runId: "v3",
      result: "fail",
      acceptanceIds: [],
      parseFailed: ["E1"],
      nonDiscriminative: ["E1"],
    });

    // v1 已被 v2 清零 → 当前计数 1，低于外露阈值（streaks 空）
    let facts = specContractFacts(ledger.readAll()).get("u-1");
    expect(facts === undefined || facts.streaks.length === 0).toBe(true);
    let groups = await frontierGroups();
    expect(groups.specContractBroken).toEqual([]);
    expect(groups.buildReady).toContain("u-1"); // 未触发 → 正常推进维度

    // 再补一轮双清单 → 重计后恰 2 → broken
    appendVerifyRan("u-1", {
      runId: "v4",
      result: "fail",
      acceptanceIds: [],
      parseFailed: ["E1"],
      nonDiscriminative: ["E1"],
    });
    facts = specContractFacts(ledger.readAll()).get("u-1");
    expect(facts?.streaks.find((s) => s.acceptanceId === "E1")?.consecutiveFails).toBe(2);
    groups = await frontierGroups();
    expect(groups.specContractBroken).toContain("u-1");
  });
});

// ================================================================
// 投影级：V4 flake 排除（混合边角——主 run fail + nd 清单）
// ================================================================

describe("V4 e2e 条目不误计 flake：nd 信号走 specContractBroken 而非 flakeReview", () => {
  it("主 run fail（不在 acceptanceIds、非解析失败）且在 nd 清单 ×2 → 无 flakeReview 组、有 specContractBroken 组；对照 unit 纯 fail 连挂 flake 照旧", async () => {
    // 混合边角 unit：E1 主 run fail（合法 FAIL 标记形态——parseFailed 不写键）
    // 且红阶段判无区分力 → D3② 排除的作用面（不计数也不清零）
    appendFrozenSpec("u-mix", [
      { id: "E1", core: true, title: "混合形态条目", type: "e2e-real", command: "node e1.js" },
      { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" },
    ]);
    appendVerifyRan("u-mix", {
      runId: "m1",
      result: "fail",
      acceptanceIds: ["U1"],
      nonDiscriminative: ["E1"],
    });
    appendVerifyRan("u-mix", {
      runId: "m2",
      result: "fail",
      acceptanceIds: ["U1"],
      nonDiscriminative: ["E1"],
    });

    // 对照 unit：E1 纯 e2e 断言失败连挂（无任何契约缺陷信号）→ 既有 flake 语义
    appendFrozenSpec("u-ctl", [
      { id: "E1", core: true, title: "断言失败条目", type: "e2e-real", command: "node e1.js" },
      { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" },
    ]);
    appendVerifyRan("u-ctl", { runId: "c1", result: "fail", acceptanceIds: ["U1"] });
    appendVerifyRan("u-ctl", { runId: "c2", result: "fail", acceptanceIds: ["U1"] });

    const groups = await frontierGroups();
    // 混合 unit：信号走回炉通道，不进 flake（删 nd 排除分支 → E1 计 2 → 此处必红）
    expect(groups.specContractBroken).toContain("u-mix");
    expect(groups.flakeReview).not.toContain("u-mix");
    // 对照 unit：无契约缺陷信号时 flake 照旧（排除分支不误伤既有语义）
    expect(groups.flakeReview).toContain("u-ctl");
    expect(groups.specContractBroken).not.toContain("u-ctl");

    // facts 级双向直断言：flake 输出不含 u-mix 的 E1、contract 输出含之
    const events = ledger.readAll();
    const mixFlake = flakeReviewFacts(events).get("u-mix");
    expect(mixFlake?.map((f) => f.acceptanceId) ?? []).not.toContain("E1");
    const mixContract = specContractFacts(events).get("u-mix");
    expect(mixContract?.streaks.map((s) => s.acceptanceId)).toContain("E1");
    expect(mixContract?.streaks.find((s) => s.acceptanceId === "E1")?.consecutiveFails).toBe(2);
  });
});

// ================================================================
// 投影级：mixed 独立计数（D3① 逐条目粒度）
// ================================================================

describe("mixed 独立计数：X 仅 parseFailed / Y 仅 nd 双 streak 互不污染", () => {
  it("同 unit 两类信号各自连挂 2；后续仅 X 信号在场的 run → Y 清零、X 继续累计", () => {
    appendFrozenSpec("u-1", [
      { id: "X1", core: true, title: "解析失败源条目", type: "e2e-real", command: "node x1.js" },
      { id: "Y1", core: true, title: "无区分力源条目", type: "e2e-real", command: "node y1.js" },
      { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" },
    ]);
    for (const runId of ["m1", "m2"]) {
      appendVerifyRan("u-1", {
        runId,
        result: "fail",
        acceptanceIds: ["U1"],
        parseFailed: ["X1"],
        nonDiscriminative: ["Y1"],
      });
    }

    let facts = specContractFacts(ledger.readAll()).get("u-1");
    const byId = new Map(facts?.streaks.map((s) => [s.acceptanceId, s.consecutiveFails]));
    expect(byId.get("X1")).toBe(2);
    expect(byId.get("Y1")).toBe(2);

    // 后续 run 仅携 X1 信号（Y1 从两清单消失）→ Y1 清零、X1 继续到 3
    appendVerifyRan("u-1", {
      runId: "m3",
      result: "fail",
      acceptanceIds: ["U1"],
      parseFailed: ["X1"],
    });
    facts = specContractFacts(ledger.readAll()).get("u-1");
    const ids = facts?.streaks.map((s) => s.acceptanceId) ?? [];
    expect(ids).toContain("X1");
    expect(ids).not.toContain("Y1"); // 逐条目粒度清零：Y1 消失只清自身
    expect(facts?.streaks.find((s) => s.acceptanceId === "X1")?.consecutiveFails).toBe(3);
  });
});

// ================================================================
// 投影级：D3② 清零判定在前的边角（nd 条目在 acceptanceIds 内）
// ================================================================

describe("边角：nd 条目在 acceptanceIds 内（常规 run pass 形态）→ 清零判定在前", () => {
  it("acceptanceIds ∩ nd 同真 → flake 侧清零（非「不计数不清零」）；nd 信号消失 → contract 侧连挂清零", () => {
    appendFrozenSpec("u-1", [
      { id: "E1", core: true, title: "混合条目", type: "e2e-real", command: "node e1.js" },
      { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" },
    ]);
    // v0：E1 纯 fail（flake 计 1）
    appendVerifyRan("u-1", { runId: "v0", result: "fail", acceptanceIds: ["U1"] });
    // v1：常规 run pass（E1 在 acceptanceIds）且红阶段判无区分力（nd 清单）——
    // D3② 钉死：清零判定在前 → flake streak 被 delete；排除分支不发挥作用
    appendVerifyRan("u-1", {
      runId: "v1",
      result: "fail",
      acceptanceIds: ["E1", "U1"],
      nonDiscriminative: ["E1"],
    });
    // v2：nd 信号消失（E1 解析成功且区分力正常，常规 pass）→ contract 侧清零
    appendVerifyRan("u-1", { runId: "v2", result: "pass", acceptanceIds: ["E1", "U1"] });
    // v3：E1 又纯 fail → flake 从 0 重计（=1 < 2 不外露）
    appendVerifyRan("u-1", { runId: "v3", result: "fail", acceptanceIds: ["U1"] });

    // flake 侧：若排除分支先于清零判定（v1 continue 不清零），v0+v1+v3 计 3
    // ≥2 → flakeReview 外露 → 本断言必红（D3② 分支序的回归锁）
    const events = ledger.readAll();
    const flake = flakeReviewFacts(events).get("u-1");
    expect(flake?.map((f) => f.acceptanceId) ?? []).not.toContain("E1");

    // contract 侧：v1 的 nd 信号计 1 后被 v2 清零 → streaks 空（<2 不外露）
    const contract = specContractFacts(events).get("u-1");
    expect(contract === undefined || contract.streaks.length === 0).toBe(true);
  });
});

// ================================================================
// handler 级：契约合法封装形态（真 git + 封装 typecheck 脚本，w2 形态重放）
// ================================================================

/** w2 形态 fixture：基线即带 tsconfig + types + 封装 typecheck 脚本，developer 空 commit */
function makeWrapperRepo(): void {
  makeGitRepo(cwd, [
    {
      "tsconfig.json":
        '{\n  "compilerOptions": { "strict": true, "noEmit": true },\n  "include": ["src/**/*.ts"]\n}\n',
      "src/types.ts": "export type Probe = string;\n",
      "scripts/check-types.sh": '#!/bin/sh\nnpx tsc --noEmit && echo "AC5 PASS"\n',
    },
    // developer「空改动/无效实现」：仅加无关文件——typecheck 型验收对实现免疫
    { "notes.txt": "developer 空改动\n" },
  ]);
  submitSpecAndBuild([
    { id: "AC5", core: true, title: "类型装配成立（封装形态）", type: "e2e-real", command: "bash scripts/check-types.sh" },
  ]);
}

describe("handler：契约合法封装形态的 nd 信号入账（V2 前半 / D1 提取锚）", () => {
  it("常规 run 健康 pass + 红阶段基线 pass → VerifyRan 携带 nonDiscriminativeAcceptanceIds、不写 parseFailedAcceptanceIds 键、result=fail、acceptanceIds 含该条", async () => {
    makeWrapperRepo();

    const res = await run(["verify", "--unit", "u-1"]);
    // 红阶段 fail 单列即致整体 fail（常规层全 pass——AC5 pass 在 stdout）
    expect(res.code, `stderr: ${res.stderr}`).toBe(1);
    expect(res.stdout).toContain("AC5 pass");
    expect(res.stdout).toContain("AC5 无区分力");

    const payloads = verifyRanPayloads();
    expect(payloads).toHaveLength(1);
    const payload = payloads[0];
    if (payload === undefined) {
      throw new Error("fixture 前置失败：verify 应入账一条 VerifyRan");
    }
    expect(payload.result).toBe("fail");
    // 机器 pass 事实不改：无区分力条目照旧进 acceptanceIds（D1 采用句）
    expect(payload.acceptanceIds).toContain("AC5");
    // D1 核心断言：nd 清单在场
    expect(payload.nonDiscriminativeAcceptanceIds).toEqual(["AC5"]);
    // 排假阳性：契约合法形态不产生解析失败（键不存在性——非 undefined 值比对）
    expect(Object.prototype.hasOwnProperty.call(payload, "parseFailedAcceptanceIds")).toBe(false);

    // report.json 顶层 redPhase 节记录 nd 事实（D5 取数锚）：无 patch 文件
    //（notes.txt 不被 command 引用）→ 「旧树上即 pass」形态
    const report = JSON.parse(
      readFileSync(join(evidenceDir(cwHome, cwd, "u-1", payload.runId), "report.json"), "utf-8"),
    ) as { redPhase: Array<{ id: string; discriminative: boolean; reason: string }> };
    const entry = report.redPhase.find((e) => e.id === "AC5");
    expect(entry?.discriminative).toBe(false);
    expect(entry?.reason).toContain("旧树");
  }, 30_000);

  it("--no-red-phase 同场景重跑 → payload 不携带 nonDiscriminativeAcceptanceIds 键（V5③ 缺省语义）且 result=pass", async () => {
    makeWrapperRepo();
    // 第一轮：默认红阶段（入账第 1 条 VerifyRan，携带 nd 清单）
    await run(["verify", "--unit", "u-1"]);
    // 第二轮：--no-red-phase（红阶段不执行 → redFailed 恒空 → 不写键）
    const res = await run(["verify", "--unit", "u-1", "--no-red-phase"]);
    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("result=pass");

    const payloads = verifyRanPayloads();
    expect(payloads).toHaveLength(2);
    const second = payloads[1];
    if (second === undefined) {
      throw new Error("fixture 前置失败：两轮 verify 应各入账一条 VerifyRan");
    }
    expect(second.result).toBe("pass");
    // V5③ 断言锚：键存在性（hasOwnProperty），非 undefined 比对——
    // 「红阶段未执行恒空数组不写键」的实现契约
    expect(Object.prototype.hasOwnProperty.call(second, "nonDiscriminativeAcceptanceIds")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(second, "parseFailedAcceptanceIds")).toBe(false);
    expect(second.acceptanceIds).toContain("AC5");
  }, 30_000);
});

// ================================================================
// handler 级：nondeterministic 声明豁免（D1 封闭枚举边界）
// ================================================================

describe("handler：nondeterministic 声明条目红阶段跳过判定 → 不入 nd 清单", () => {
  it("两树都 pass 的声明条目 → exit 0、payload 无 nd 键无 parseFailed 键、redPhase 节 discriminative=true（跳过语义）", async () => {
    makeGitRepo(cwd, [
      { "seed.txt": "baseline", "scripts/flaky.sh": '#!/bin/sh\necho "AC7 PASS"\n' },
      { "notes2.txt": "developer 空改动\n" },
    ]);
    submitSpecAndBuild([
      {
        id: "AC7",
        core: true,
        title: "随机用例",
        type: "e2e-real",
        command: "bash scripts/flaky.sh",
        nondeterministic: true,
      },
    ]);

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("result=pass");

    const payloads = verifyRanPayloads();
    expect(payloads).toHaveLength(1);
    const payload = payloads[0];
    if (payload === undefined) {
      throw new Error("fixture 前置失败：verify 应入账一条 VerifyRan");
    }
    // 豁免语义：声明条目经豁免后恒在 pass 集（types.ts 注释锁定）
    expect(payload.acceptanceIds).toContain("AC7");
    // 豁免不入 nd 清单：无条件 pass 脚本若非声明条目会判 discriminative=false
    expect(Object.prototype.hasOwnProperty.call(payload, "nonDiscriminativeAcceptanceIds")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, "parseFailedAcceptanceIds")).toBe(false);

    // 红阶段侧：judgeRedPhase 对声明条目恒判 true（red-phase.ts 跳过分支），
    // reason 注明 nondeterministic 声明——封闭枚举边界的产物级锚
    const report = JSON.parse(
      readFileSync(join(evidenceDir(cwHome, cwd, "u-1", payload.runId), "report.json"), "utf-8"),
    ) as { redPhase: Array<{ id: string; discriminative: boolean; reason: string }> };
    const entry = report.redPhase.find((e) => e.id === "AC7");
    expect(entry?.discriminative).toBe(true);
    expect(entry?.reason).toContain("nondeterministic");
  }, 30_000);
});

// ================================================================
// 文案级：回炉任务书取数分流（D5，writeBriefFile 直渲染——mx5-2 F9 同款）
// ================================================================

/** 构造「parse-failed ×2 + nd ×2 混合连挂」账本 + 两类产物落盘（withReports 时） */
function makeMixedBrokenFixture(withReports: boolean): void {
  appendFrozenSpec(
    "u-1",
    [
      { id: "E1", core: true, title: "解析失败源条目", type: "e2e-real", command: "node e1.js" },
      { id: "E2", core: true, title: "无区分力源条目", type: "e2e-real", command: "node e2.js" },
      { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" },
    ],
    1,
  );
  const rounds = [
    {
      runId: "verify-r1",
      parseReason: "验收 E1 产物解析失败：stdout 无标记行且 exitCode=0（第一轮原文）",
      redReason: "旧树（父 commit）上即 pass——验收对新实现无区分力（第一轮红阶段原文）",
    },
    {
      runId: "verify-r2",
      parseReason: "验收 E1 产物解析失败：stdout 无标记行且 exitCode=0（第二轮原文）",
      redReason: "旧树（父 commit）上即 pass——验收对新实现无区分力（第二轮红阶段原文）",
    },
  ];
  for (const round of rounds) {
    appendVerifyRan("u-1", {
      runId: round.runId,
      result: "fail",
      acceptanceIds: ["U1"],
      parseFailed: ["E1"],
      nonDiscriminative: ["E2"],
    });
    if (withReports) {
      const dir = evidenceDir(cwHome, cwd, "u-1", round.runId);
      mkdirSync(dir, { recursive: true });
      // parse-failed 源：<id>.report.json 顶层 {parseError, reason}（mx5-2 既有路径）
      writeFileSync(
        join(dir, "E1.report.json"),
        `${JSON.stringify({ parseError: true, commandExit: 1, reason: round.parseReason }, null, 2)}\n`,
      );
      // non-discriminative 源：同 runId 目录顶层 report.json 的 redPhase 节
      //（D5 钉死：该节在主 run 目录顶层，不在 <id>.report.json）
      writeFileSync(
        join(dir, "report.json"),
        `${JSON.stringify(
          {
            exitCode: 0,
            cases: [],
            artifacts: [],
            redPhase: [{ id: "E2", discriminative: false, reason: round.redReason }],
          },
          null,
          2,
        )}\n`,
      );
      // 干扰项：E2.report.json 的 parseError 形态——nd 取数分流不得读它
      //（被否方案「两信号混用同一份 reason 读取路径」的回归锁）
      writeFileSync(
        join(dir, "E2.report.json"),
        `${JSON.stringify(
          { parseError: true, commandExit: 1, reason: "干扰项：nd 条目不得读 E2.report.json" },
          null,
          2,
        )}\n`,
      );
    }
  }
}

/** 渲染 specContractBroken 形态的 designer 任务书（mx5-2 F9 renderReplanBrief 同款） */
function renderBrokenBrief(): string {
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

describe("brief：specContractBroken 回炉任务书（混合信号 + 升格文案 + 分流取数）", () => {
  it("渲染产物含确定性升格语、两类来源标记行、build commit 结构核查提示、topic 替代路径、两信号各自产物原文", () => {
    makeMixedBrokenFixture(true);
    // 前置自检：该账本确已触发 specContractBroken（否则渲染对象不成立）
    const facts = specContractFacts(ledger.readAll()).get("u-1");
    expect(facts?.streaks.map((s) => s.acceptanceId).sort()).toEqual(["E1", "E2"]);

    const content = renderBrokenBrief();

    // 「确定性」升格语（specContractBroken 语义升格为确定性 spec 缺陷回炉）
    expect(content).toContain("确定性 spec 缺陷");
    // 两类来源标记行各 ≥1（信号=解析失败 / 信号=无区分力）
    expect((content.match(/信号=解析失败/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((content.match(/信号=无区分力/g) ?? []).length).toBeGreaterThanOrEqual(1);
    // hasNondiscriminative 分支：build commit 结构核查提示特征句
    expect(content).toContain("核查 build commit 结构");
    expect(content).toContain("同一 git commit");
    // topic 替代路径特征词（规则⑬式替代路径）
    expect(content).toContain('layer: "topic"');
    // 分流取数：parse-failed 读 E1.report.json 顶层 reason（逐轮原文在场）
    expect(content).toContain("第一轮原文");
    expect(content).toContain("第二轮原文");
    // 分流取数：nd 读同 runId 顶层 report.json 的 redPhase reason（两轮红阶段原文在场）
    expect(content).toContain("第一轮红阶段原文");
    expect(content).toContain("第二轮红阶段原文");
    // 干扰项不被读（nd 条目不得从 E2.report.json 取 reason）
    expect(content).not.toContain("干扰项");
    // 逐轮 runId 在场（审计对账锚）
    expect(content).toContain("verify-r1");
    expect(content).toContain("verify-r2");
  }, 30_000);

  it("产物人为删掉后降级：id + 两类 reportPath 兜底（parse 的 <id>.report.json 与 nd 的顶层 report.json）", () => {
    makeMixedBrokenFixture(false); // 不落任何产物文件
    const content = renderBrokenBrief();

    expect(content).toContain("E1");
    expect(content).toContain("E2");
    expect(content).toContain("原文不可读");
    // parse-failed 源的降级路径锚
    expect(content).toContain(join(evidenceDir(cwHome, cwd, "u-1", "verify-r1"), "E1.report.json"));
    // nd 源的降级路径锚（顶层 report.json——与 parse 源文件名不同，分流在降级态仍成立）
    expect(content).toContain(join(evidenceDir(cwHome, cwd, "u-1", "verify-r1"), "report.json"));
  }, 30_000);
});

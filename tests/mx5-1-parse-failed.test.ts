/**
 * mx5-1 P 系：VerifyRanPayload.parseFailedAcceptanceIds 字段提取——dispatch
 * 层完整 verify 路径（真实 git 子进程 + tmp CW_HOME 隔离 + 直写账本，零 mock），
 * 用例编号 P1-P6 逐条对应 docs/rewrite/acceptance/mx5-1-acceptance.md §5 P 系。
 *
 * 提取锚 = AcceptanceRunResult.parseError === true（适配器 parse 抛错）；
 * 豁免条目（exemptNondeterministic，nameSkipped 标记）不入列；无解析失败不写键。
 * 判定零变化：解析失败条目照旧判 fail（P1），pass/fail 与 exit 语义不变。
 *
 * 构造模式（u4a verify 同款）：真实 tmp git 仓库单 commit（build commit 无父
 * → 红阶段合法跳过，判定只锚常规重跑）+ 直写账本注入 SpecSubmitted——规则⑨
 * 落地后毒 spec 进不了正常入账路径（gate 拒），P1 的 `--reporter=verbose`
 * 形态靠直写绕过 gate 走到 verify，这正是 mx5-2 回炉通道要消费的漏网形态。
 *
 * 命令构造全部零网络零框架依赖：
 *   - vitest 型解析失败：`echo not-json --reporter=verbose`——translate 自动
 *     追加 `--reporter=json` 后 stdout 是纯文本（echo 把 flag 原样打印），
 *     JSON.parse 恒挂，与三跑现场「verbose 与追加 json 并存」同构；
 *   - e2e-sh 无标记且 exit≠0：`echo boom >&2; exit 3`（no-markers fail case，
 *     parseError=false——诚实边界：不入列，照旧 fail）；
 *   - e2e-sh 无标记且 exit 0：`echo done`（parse 抛错，parseError=true）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import type { AcceptanceItem } from "../src/events/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-mx51-p-"));
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
let ledgerFile: string;

beforeEach(() => {
  process.env.CW_HOME = cwHome;
  caseNo += 1;
  cwd = join(tmpRoot, `case-${caseNo}`);
  ledgerFile = ledgerPath(cwHome, cwd);
  ledger = new EventLedger(ledgerFile);
});

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

function git(dir: string, args: readonly string[]): void {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
}

/** 真实 tmp git 仓库（单 commit——build commit 无父 → 红阶段合法跳过） */
function makeGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "cw-test@example.com"]);
  git(dir, ["config", "user.name", "cw-test"]);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
  return (spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ?? "").trim();
}

function e2eItem(id: string, command: string, overrides: Partial<AcceptanceItem> = {}): AcceptanceItem {
  return { id, core: true, title: `${id} 核心链路`, type: "e2e-real", command, ...overrides };
}

function unitItem(id: string, command?: string): AcceptanceItem {
  return { id, core: false, title: `${id} 单元行为`, type: "unit", ...(command === undefined ? {} : { command }) };
}

/**
 * verify fixture：真实 git 仓库 + 直写账本三事件（UnitCreated / SpecSubmitted /
 * EvidenceSubmitted）。SpecSubmitted 直写 = 绕过 spec gate（规则⑨落地后毒 spec
 * 的唯一入场形态——账本注入路径是 mx5-2 回炉与历史账本重放的消费场景）。
 */
function makeVerifyFixture(acceptance: readonly AcceptanceItem[]): void {
  const head = makeGitRepo(cwd);
  ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
  ledger.append("SpecSubmitted", {
    unitId: "u-1",
    specHash: "0".repeat(64),
    acceptance: [...acceptance],
    contracts: [],
    split: [],
  });
  ledger.append("EvidenceSubmitted", {
    unitId: "u-1",
    runId: "run-1",
    commit: head,
    paths: [],
    sha256: [],
    exitCode: 0,
  });
}

/**
 * 从账本原始 JSONL 字节读取全部 VerifyRan payload（不经类型收窄——
 * 「键是否存在」必须按落盘字节断言，而非运行时对象属性）。
 */
function rawVerifyRanPayloads(): Array<Record<string, unknown>> {
  return readFileSync(ledgerFile, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.type === "VerifyRan")
    .map((e) => e.payload as Record<string, unknown>);
}

describe("P1 提取锚 = parseError===true（vitest 型解析失败入列，判定照旧 fail）", () => {
  it("毒 spec（--reporter=verbose）直写账本走到 verify → payload 含 parseFailedAcceptanceIds:[\"A1\"]，该 case 照旧判 fail", async () => {
    makeVerifyFixture([
      // unit 型 → vitest 适配器：translate 追加 --reporter=json 后 stdout 纯文本 → parse 抛错
      unitItem("A1", "echo not-json --reporter=verbose"),
      e2eItem("A2", 'echo "A2 PASS"'),
    ]);

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("A1");
    expect(res.stdout).toContain("A1 fail");

    const payloads = rawVerifyRanPayloads();
    expect(payloads).toHaveLength(1);
    const p = payloads[0] as Record<string, unknown>;
    // result 判定零变化：解析失败条目照旧 fail → result=fail
    expect(p.result).toBe("fail");
    expect(p.acceptanceIds).toEqual(["A2"]);
    // 新字段恰为解析失败条目 id 列表
    expect(p.parseFailedAcceptanceIds).toEqual(["A1"]);
  });
});

describe("P2 e2e-sh 无标记行且 exit≠0 不入列（诚实边界：no-markers fail case 不抛错）", () => {
  it("e2e 型命令无标记且 exit 3 → 照旧 fail，事件不含该 id（字段缺失）", async () => {
    makeVerifyFixture([e2eItem("A1", "echo boom >&2; exit 3")]);

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("A1");

    const payloads = rawVerifyRanPayloads();
    expect(payloads).toHaveLength(1);
    const p = payloads[0] as Record<string, unknown>;
    expect(p.result).toBe("fail");
    // 落盘字节层面不含该键（undefined 都不写）
    expect("parseFailedAcceptanceIds" in p).toBe(false);
  });
});

describe("P3 e2e-sh 无标记行且 exit 0 入列", () => {
  it("命令 echo done（exit 0 无标记）→ parseError 入列", async () => {
    makeVerifyFixture([e2eItem("A1", "echo done")]);

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(1);

    const payloads = rawVerifyRanPayloads();
    expect(payloads).toHaveLength(1);
    expect((payloads[0] as Record<string, unknown>).parseFailedAcceptanceIds).toEqual(["A1"]);
  });
});

describe("P4 豁免条目不入列（nondeterministic 解析失败被改写 pass）", () => {
  it("声明 nondeterministic:true 的条目解析失败 → 不入列，VerifyRan.result 不因它变 fail", async () => {
    makeVerifyFixture([
      e2eItem("A1", 'echo "A1 PASS"'),
      // exit 0 无标记 → parse 抛错 → exemptNondeterministic 改写 pass（parseError 照录 true）
      e2eItem("A2", "echo done", { core: false, nondeterministic: true }),
    ]);

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("result=pass");

    const payloads = rawVerifyRanPayloads();
    expect(payloads).toHaveLength(1);
    const p = payloads[0] as Record<string, unknown>;
    expect(p.result).toBe("pass");
    // 唯一解析失败条目被豁免 → 无解析失败可记 → 不写键
    expect("parseFailedAcceptanceIds" in p).toBe(false);
  });
});

describe("P5 无解析失败不写字段", () => {
  it("全 pass（产物合法）→ 无该键", async () => {
    makeVerifyFixture([e2eItem("A1", 'echo "A1 PASS"')]);

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(0);

    const payloads = rawVerifyRanPayloads();
    expect(payloads).toHaveLength(1);
    const p = payloads[0] as Record<string, unknown>;
    expect(p.result).toBe("pass");
    expect("parseFailedAcceptanceIds" in p).toBe(false);
  });

  it("断言失败但产物合法（标记行 FAIL，parseError=false）→ fail 但无该键", async () => {
    makeVerifyFixture([e2eItem("A1", 'echo "A1 FAIL"')]);

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("A1");

    const payloads = rawVerifyRanPayloads();
    expect(payloads).toHaveLength(1);
    const p = payloads[0] as Record<string, unknown>;
    expect(p.result).toBe("fail");
    expect("parseFailedAcceptanceIds" in p).toBe(false);
  });
});

describe("P6 旧账本兼容（不含新字段的 VerifyRan 重放）", () => {
  it("直写五字段旧形态 VerifyRan → status 只读命令正常，verifyRuns 投影与现状一致（无新键、不炸）", async () => {
    // 合规 spec（过全部 gate 规则——status 的 fold 注入 checkSpecRules 判状态，
    // 毒 spec 会让重放状态漂移，与 P6 的字段兼容焦点无关）
    const head = makeGitRepo(cwd);
    const acceptance: AcceptanceItem[] = [e2eItem("A1", 'echo "A1 PASS"'), unitItem("A2")];
    ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
    ledger.append("SpecSubmitted", {
      unitId: "u-1",
      specHash: "0".repeat(64),
      acceptance,
      contracts: [],
      split: [],
    });
    ledger.append("EvidenceSubmitted", {
      unitId: "u-1",
      runId: "run-1",
      commit: head,
      paths: [],
      sha256: [],
      exitCode: 0,
    });
    // 旧形态 VerifyRan：既有五字段，无 parseFailedAcceptanceIds
    const oldRun = {
      unitId: "u-1",
      runId: "verify-legacy-0001",
      reportHash: "f".repeat(64),
      result: "pass" as const,
      acceptanceIds: ["A1", "A2"],
    };
    ledger.append("VerifyRan", oldRun);

    // 只读命令重放：文本详情视图 + JSON 视图都正常，verifyRuns 呈现为旧五字段
    const detail = await run(["status", "--unit", "u-1"]);
    expect(detail.code, `stderr: ${detail.stderr}`).toBe(0);
    expect(detail.stdout).toContain("verifyRuns:");
    expect(detail.stdout).toContain("runId=verify-legacy-0001");
    expect(detail.stdout).toContain("result=pass");
    expect(detail.stdout).toContain("acceptance=A1,A2");

    const json = await run(["status", "--unit", "u-1", "--json"]);
    expect(json.code, `stderr: ${json.stderr}`).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      verifyRuns: Array<Record<string, unknown>>;
      status: string;
    };
    // 重放兼容：投影出的 verifyRuns 与旧形态逐键一致（恰五字段，无新键注入）
    expect(parsed.verifyRuns).toHaveLength(1);
    expect(parsed.verifyRuns[0]).toEqual(oldRun);
    // 合规 spec + reviewer pass 缺失 → 状态停在 created（fold 行为与现状一致，
    // 新字段与新规则不改变旧事件的折叠结果）
    expect(parsed.status).toBe("created");
  });
});

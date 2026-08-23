/**
 * lv-3 E 系：e2e-sh「零标记行 + exit≠0」从 no-markers fail 改道解析失败抛错
 * （docs/rewrite/acceptance/lv-3-acceptance.md §5 E1-E7；设计《自治运行活性与
 * 契约防护》§3.3 D4 / §4 S3）。零 mock：
 *   - E1-E3 / E5：dispatch 层（真实 tmp git 仓单 commit + 直写账本 + 进程内
 *     dispatch 完整 verify 路径，mx5-1 P 系同款——单 commit 使红阶段合法跳过，
 *     判定只锚常规重跑）；
 *   - E4：真实 runner 子进程（node dist/cli.js run --spawn human，rv5 T3 同款；
 *     dist 缺席时挂起，pretest build 后自动激活）；
 *   - E6 / E7：适配器层直测（真实脚本 fixture，u5-e2e-sh 同款）。
 *
 * 场景与设计 §4 S3 对齐：a) 127 形态（脚本未提交）；b) 断链形态（脚本已提交但
 * 内部链路断，exit 1 + stdout 构建报错首行）；c) 对照组（正常输出 FAIL 标记 +
 * exit 1——真测试红分类不变）。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import type { AcceptanceItem } from "../src/events/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { evidenceDir, ledgerPath } from "../src/store/project.js";
import { e2eShAdapter } from "../src/testrun/e2e-sh.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const HUMAN_ADAPTER_DIST = fileURLToPath(new URL("../dist/runner/spawn/human.js", import.meta.url));
/** runner 子进程用例（E4）：dist 缺席时挂起（pretest build 后自动激活） */
const runnerIt = existsSync(CLI_PATH) && existsSync(HUMAN_ADAPTER_DIST) ? it : it.todo;

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-lv3e-"));
const cwHome = join(tmpRoot, "home");
const originalCwHome = process.env.CW_HOME;
// runner 子进程的 worktree 根隔离（rv5 同款；与 CW_HOME 一并注入子进程 env）
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
let ledgerFile: string;

beforeEach(() => {
  process.env.CW_HOME = cwHome;
  caseNo += 1;
  cwd = join(tmpRoot, `case-${caseNo}`);
  ledgerFile = ledgerPath(cwHome, cwd);
  ledger = new EventLedger(ledgerFile);
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

function git(dir: string, args: readonly string[]): void {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", timeout: 30_000 });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.error?.message ?? res.stderr}`);
  }
}

function gitOut(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", timeout: 30_000 });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.error?.message ?? res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/**
 * 真实 tmp git 仓库：单 commit（含 repoFiles——断链/对照脚本的载体；E1 传空对象
 * 即「脚本未提交」形态）。单 commit 无父 → verify 红阶段合法跳过（mx5-1 同款）。
 */
function makeGitRepo(dir: string, repoFiles: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "cw-lv3@example.com"]);
  git(dir, ["config", "user.name", "cw-lv3"]);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  for (const [name, content] of Object.entries(repoFiles)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "fixture"]);
  return gitOut(dir, ["rev-parse", "HEAD"]);
}

function e2eItem(id: string, command: string): AcceptanceItem {
  return { id, core: true, title: `${id} 核心链路`, type: "e2e-real", command };
}

/** unit 级条目（gate 规则⑤：spec 至少一条 unit 级——缺它 fold 判「gate 红」unit 停 created 无组） */
function unitItem(id: string, command: string): AcceptanceItem {
  return { id, core: false, title: `${id} 单元冒烟`, type: "unit", command };
}

/** U1 入口：产出合法 vitest JSON 且恒过（E4/E5 的组级断言需要 spec-frozen——配套规则⑤） */
const U1_CHECK = "console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'U1 smoke',status:'passed'}]}]}));\n";

/** 直写账本四事件（UnitCreated / SpecSubmitted / pass verdict / build 证据）锚定 HEAD——pass verdict 使 unit 进入 spec-frozen（specContractBroken 是 spec-frozen 态的维度） */
function makeVerifyFixture(acceptance: readonly AcceptanceItem[], repoFiles: Record<string, string>): string {
  const head = makeGitRepo(cwd, repoFiles);
  ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
  ledger.append("SpecSubmitted", {
    unitId: "u-1",
    specHash: "0".repeat(64),
    acceptance: [...acceptance],
    contracts: [],
    split: [],
  });
  ledger.append("VerdictSubmitted", { unitId: "u-1", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
  ledger.append("EvidenceSubmitted", {
    unitId: "u-1",
    runId: "run-1",
    commit: head,
    paths: [],
    sha256: [],
    exitCode: 0,
  });
  return head;
}

/** 从账本原始 JSONL 字节读取全部 VerifyRan payload（不经类型收窄） */
function rawVerifyRanPayloads(): Array<Record<string, unknown>> {
  return readFileSync(ledgerFile, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.type === "VerifyRan")
    .map((e) => e.payload as Record<string, unknown>);
}

/** <id>.report.json 顶层（parse 抛错分支落盘 {parseError, commandExit, reason}） */
function itemReport(id: string): { parseError?: boolean; commandExit?: number; reason?: string; cases?: Array<{ id: string; status: string }> } {
  const p = rawVerifyRanPayloads()[0];
  const runId = p.runId;
  if (typeof runId !== "string") {
    throw new Error("fixture 断言前置失败：账本内无 VerifyRan");
  }
  return JSON.parse(
    readFileSync(join(evidenceDir(cwHome, cwd, "u-1", runId), `${id}.report.json`), "utf-8"),
  ) as { parseError?: boolean; reason?: string; cases?: Array<{ id: string; status: string }> };
}

interface FrontierJson {
  specContractBroken: string[];
  specContractDeadlock: string[];
  flakeReview: string[];
  buildReady: string[];
}

async function frontierGroups(): Promise<FrontierJson> {
  const res = await run(["frontier", "--json"]);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout) as FrontierJson;
}

/** 断链脚本（u6 A12 实证形态：内部链路断——exit 1 + stdout 构建报错首行） */
const BROKEN_SCRIPT = '#!/bin/sh\necho "构建产物缺失，请先 pnpm run build:e2e"\nexit 1\n';

// ================================================================
// E1 / E2 / E3：dispatch 层——三条目对照（127 / 断链 / FAIL 标记）
// ================================================================

describe("E1 127 形态：脚本未提交 → 解析失败入列", () => {
  it("bash 找不到脚本（exit 127 无输出）→ parseFailedAcceptanceIds 含该条目；<id>.report.json 顶层 {parseError, reason} 且 reason 含 exitCode=127", async () => {
    makeVerifyFixture([e2eItem("A127", "bash scripts/check.sh")], {});

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(1);

    const payloads = rawVerifyRanPayloads();
    expect(payloads).toHaveLength(1);
    const p = payloads[0] as Record<string, unknown>;
    expect(p.result).toBe("fail");
    expect(p.parseFailedAcceptanceIds).toEqual(["A127"]);

    const report = itemReport("A127");
    expect(report.parseError).toBe(true);
    expect(report.reason).toContain("exitCode=127");
  }, 60_000);
});

describe("E2 断链形态：脚本已提交但内部断链 → 解析失败（reason 含断链语义与 stdout 首行原文）", () => {
  it("脚本 echo 构建报错首行 + exit 1 → 归类解析失败，reason 含「疑似脚本崩溃/环境断链」与首行摘要原文", async () => {
    makeVerifyFixture([e2eItem("A9", "bash scripts/check.sh")], { "scripts/check.sh": BROKEN_SCRIPT });

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(1);

    const payloads = rawVerifyRanPayloads();
    expect(payloads).toHaveLength(1);
    const p = payloads[0] as Record<string, unknown>;
    expect(p.parseFailedAcceptanceIds).toEqual(["A9"]);

    const report = itemReport("A9");
    expect(report.parseError).toBe(true);
    expect(report.reason).toContain("疑似脚本崩溃/环境断链");
    // stdout 首行摘要原文内嵌（回炉 designer 定位断链点的最小事实）
    expect(report.reason).toContain("构建产物缺失，请先 pnpm run build:e2e");
  }, 60_000);
});

describe("E3 对照组：FAIL 标记 + exit 1 → 真测试红（分类不变）", () => {
  it("脚本正常输出 A3 FAIL 标记 → 不进 parseFailedAcceptanceIds、case status=fail（走 developer fix 循环）；frontier 路由 buildReady", async () => {
    // U1 unit 级条目（规则⑤）：组级断言需要 fold 判过 gate（缺它 unit 停 created 无组，E5 同款）
    makeVerifyFixture(
      [e2eItem("A3", "bash scripts/check.sh"), unitItem("U1", "node u1check.js")],
      { "scripts/check.sh": '#!/bin/sh\necho "A3 FAIL"\nexit 1\n', "u1check.js": U1_CHECK },
    );

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(1);

    const payloads = rawVerifyRanPayloads();
    expect(payloads).toHaveLength(1);
    const p = payloads[0] as Record<string, unknown>;
    expect(p.result).toBe("fail");
    // 真测试红：产物合法可解析（有标记行），无解析失败键
    expect("parseFailedAcceptanceIds" in p).toBe(false);
    const report = itemReport("A3");
    expect(report.cases).toContainEqual({ id: "A3", name: "A3 FAIL", status: "fail" });
    // 组级路由（S3① 组级消费）：真红 unit 回 buildReady（developer fix 循环的
    // 派发组）——与解析失败连挂 2 次的 specContractBroken（E5）分道
    const groups = await frontierGroups();
    expect(groups.buildReady).toContain("u-1");
  }, 60_000);
});

describe("E8 三条目组合入列：a（127）+ b（断链）同入 parseFailed，真红 c 不混入", () => {
  it("单 spec 三条 e2e-sh 条目一次 verify → parseFailedAcceptanceIds 恰为 [A127, A9]（spec 序精确双元素），c 的 case status=fail 且不在 parseFailed 列表", async () => {
    makeVerifyFixture(
      [
        e2eItem("A127", "bash scripts/missing.sh"), // a：脚本未提交 → exit 127 形态
        e2eItem("A9", "bash scripts/broken.sh"), // b：已提交但内部断链 → exit 1 无标记
        e2eItem("C3", "bash scripts/check.sh"), // c：正常输出 FAIL 标记 + exit 1 真红
      ],
      {
        "scripts/broken.sh": BROKEN_SCRIPT,
        "scripts/check.sh": '#!/bin/sh\necho "C3 FAIL"\nexit 1\n',
      },
    );

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(1);

    const payloads = rawVerifyRanPayloads();
    expect(payloads).toHaveLength(1);
    const p = payloads[0] as Record<string, unknown>;
    expect(p.result).toBe("fail");
    // a+b 同时入列（精确双元素、序按 spec 序）——toEqual 精确即蕴含真红 c 不在列
    expect(p.parseFailedAcceptanceIds).toEqual(["A127", "A9"]);
    // c：产物合法可解析（有标记行）→ case 真红，走 developer fix 循环
    const report = itemReport("C3");
    expect(report.cases).toContainEqual({ id: "C3", name: "C3 FAIL", status: "fail" });
  }, 60_000);
});

// ================================================================
// E5：通道排他（解析失败不进 flake 输入——rv-5 既有口径回归）
// ================================================================

describe("E5 通道排他：E2 形态连挂 2 次不进 flakeReview", () => {
  it("断链脚本两次 verify fail → specContractBroken 含该 unit、flakeReview 为空", async () => {
    makeVerifyFixture(
      [e2eItem("A9", "bash scripts/check.sh"), unitItem("U1", "node u1check.js")],
      { "scripts/check.sh": BROKEN_SCRIPT, "u1check.js": U1_CHECK },
    );

    const v1 = await run(["verify", "--unit", "u-1"]);
    expect(v1.code).toBe(1);
    const v2 = await run(["verify", "--unit", "u-1"]);
    expect(v2.code).toBe(1);

    const groups = await frontierGroups();
    expect(groups.specContractBroken).toContain("u-1");
    expect(groups.flakeReview).toEqual([]);
  }, 120_000);
});

// ================================================================
// E4：回炉链（真实 runner 子进程 --spawn human 派发 designer 回炉任务书）
// ================================================================

/** 断言中途失败时防 runner 子进程泄漏 */
const liveRunners = new Set<ChildProcess>();

function runCli(repoDir: string, args: readonly string[]): Captured {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
    timeout: 90_000,
  });
  if (res.error !== undefined) {
    throw new Error(`runCli ${args.join(" ")} 失败: ${res.error.message}`);
  }
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("E4 回炉链：连挂 2 次 → specContractBroken + 回炉任务书内嵌 reason 原文", () => {
  runnerIt("两次 verify 解析失败后 frontier 出现 specContractBroken；human runner 派发的 designer 任务书内嵌 reason（含 stdout 首行）", async () => {
    const base = join(tmpRoot, "e4-reheat");
    mkdirSync(base, { recursive: true });
    const repoDir = realpathSync(base);
    git(repoDir, ["init"]);
    git(repoDir, ["config", "user.email", "cw-lv3-e4@example.com"]);
    git(repoDir, ["config", "user.name", "cw-lv3-e4"]);
    writeFileSync(join(repoDir, "brief.md"), "# lv-3 E4 回炉链场景任务书\n");
    mkdirSync(join(repoDir, "scripts"), { recursive: true });
    writeFileSync(join(repoDir, "scripts/check.sh"), BROKEN_SCRIPT);
    writeFileSync(join(repoDir, "u1check.js"), U1_CHECK);
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "fixture: brief + broken script"]);
    const head = gitOut(repoDir, ["rev-parse", "HEAD"]);
    expect(runCli(repoDir, ["create", "--id", "edemo", "--brief", "brief.md"]).code).toBe(0);

    // 直写 spec（E1 e2e + U1 unit 级——规则⑤，fold 后 spec-frozen）+ pass verdict
    //（回炉通道消费的正是漏网/直写形态）
    const ledgerE4 = new EventLedger(ledgerPath(cwHome, repoDir));
    ledgerE4.append("SpecSubmitted", {
      unitId: "edemo",
      specHash: "e4-spec-1",
      acceptance: [e2eItem("A9", "bash scripts/check.sh"), unitItem("U1", "node u1check.js")],
      contracts: [],
      split: [],
    });
    ledgerE4.append("VerdictSubmitted", { unitId: "edemo", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    expect(
      runCli(repoDir, ["evidence", "submit", "--kind", "build", "--unit", "edemo", "--commit", head, "--run-id", "b1"]).code,
    ).toBe(0);
    expect(runCli(repoDir, ["verify", "--unit", "edemo"]).code).toBe(1);
    expect(runCli(repoDir, ["verify", "--unit", "edemo"]).code).toBe(1);

    // 回炉投影：frontier（真实 CLI 子进程——与 runner 派发同一出处）
    const frontier = runCli(repoDir, ["frontier", "--json"]);
    expect(frontier.code).toBe(0);
    expect((JSON.parse(frontier.stdout) as FrontierJson).specContractBroken).toContain("edemo");

    // 真实 loop：human runner 派发 designer（回炉任务书在派发时渲染落盘）
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const child = spawn(
      process.execPath,
      [CLI_PATH, "run", "--root", "edemo", "--spawn", "human", "--poll-ms", "200"],
      { cwd: repoDir, env: { ...process.env, CW_HOME: cwHome, CW_WORKTREE_HOME: WT_HOME }, stdio: ["ignore", "pipe", "pipe"] },
    );
    liveRunners.add(child);
    child.on("exit", () => liveRunners.delete(child));
    child.stdout?.on("data", (chunk: Buffer) => outChunks.push(chunk.toString("utf-8")));
    child.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk.toString("utf-8")));
    try {
      const dispatchNeedle = '派发 designer → unit "edemo"';
      const deadline = Date.now() + 15_000;
      while (!outChunks.join("").includes(dispatchNeedle)) {
        if (Date.now() > deadline) {
          throw new Error(`等待 runner 派发超时。stdout 末尾：${outChunks.join("").slice(-400)}；stderr 末尾：${errChunks.join("").slice(-400)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const stdout = outChunks.join("");
      // 派发行携带 brief 路径（writeBriefFile 落盘后 spawn）
      const briefMatch = stdout.match(/brief: (\S+?\.brief\.md)/);
      expect(briefMatch).not.toBeNull();
      const brief = readFileSync(briefMatch?.[1] ?? "", "utf-8");
      expect(brief).toContain("验收命令契约回炉");
      // 内嵌 reason 原文（<id>.report.json 顶层 reason——含断链语义与 stdout 首行）
      expect(brief).toContain("疑似脚本崩溃/环境断链");
      expect(brief).toContain("构建产物缺失，请先 pnpm run build:e2e");
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.on("exit", () => resolve());
        setTimeout(() => resolve(), 5_000).unref();
      });
    }
  }, 90_000);
});

afterAll(() => {
  for (const child of liveRunners) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
});

// ================================================================
// E6 / E7：适配器层（真实脚本 fixture，u5-e2e-sh 同款）
// ================================================================

const scriptTmp = mkdtempSync(join(tmpdir(), "cw-lv3e-sh-"));
let scriptSeq = 0;

function acc(id: string): AcceptanceItem {
  return { id, core: true, title: "lv-3 e2e-sh parse 验收", type: "e2e-real", command: "bash check.sh" };
}

/** tmp 写真实脚本并执行（stdout 落盘）——返回产物文件路径与真实 exitCode */
function runScript(body: string): { out: string; status: number } {
  const script = join(scriptTmp, `case-${scriptSeq++}.sh`);
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  const res = spawnSync(script, { encoding: "utf8", cwd: scriptTmp });
  const out = `${script}.out`;
  writeFileSync(out, res.stdout ?? "");
  return { out, status: res.status ?? -1 };
}

describe("E6 exit=0 抛错语义回归（无区分力防线不变）", () => {
  it("echo ok 类零标记 + exit 0 → 抛错，message 含既有文案", () => {
    const { out, status } = runScript('echo "ok"');
    expect(status).toBe(0);
    expect(() => e2eShAdapter.parse(out, status, acc("A1"))).toThrow(/无标记行且 exitCode=0/);
    expect(() => e2eShAdapter.parse(out, status, acc("A1"))).toThrow(/无区分力/);
  });
});

describe("E7 首行摘要截断", () => {
  it("stdout 首行 >200 字符 → reason 含截断 `…`（前 200 字符 + …，不含第 201 个字符起的原文）", () => {
    const long = "x".repeat(205);
    const { out, status } = runScript(`echo "${long}"; exit 1`);
    expect(status).toBe(1);
    let message = "";
    try {
      e2eShAdapter.parse(out, status, acc("A1"));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).not.toBe("");
    expect(message).toContain("x".repeat(200) + "…");
    expect(message).not.toContain("x".repeat(201));
  });

  it("stdout 全空（exit 1 无输出）→ message 含「（stdout 为空）」占位", () => {
    const { out, status } = runScript("exit 1");
    expect(status).toBe(1);
    expect(() => e2eShAdapter.parse(out, status, acc("A1"))).toThrow(/stdout 首行：（stdout 为空）/);
  });
});

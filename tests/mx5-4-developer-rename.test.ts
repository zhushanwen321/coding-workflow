/**
 * mx5-4 N 系：实现角色改名（旧值→developer）回归（docs/rewrite/acceptance/
 * mx5-4-acceptance.md §5 N1-N4）。零 mock：真实事件账本（隔离 CW_HOME 的 tmp
 * 目录）+ 真实 git 子进程 + 真实 cw CLI 子进程（N1 走完整 dispatch 路径的
 * `cw run --spawn human`，u7-e2e 同款 human 代答模式）。
 *
 * - N1 角色枚举：human spawn 链派发产物的角色值全为 developer（任务书文件名
 *   <unitId>.developer.brief.md、内容角色词、stdout/stderr 产物名、指令行）。
 * - N2 旧值拒收：`cw review submit --role <旧值>`（exec-review 形态）→ exit 1
 *   纯拒绝 + 文案含「--role developer」迁移指引；同命令 --role developer 正常
 *   入账（新值收 / 旧值拒的成对断言）。
 * - N3 历史重放：直写账本构造携带旧角色值的 verdict → fold/只读行为与改名前
 *   一致（exec-review pass 照常驱动 closed；spec-review pass 不驱动
 *   spec-frozen——fold 对 exec-review 不比对 role、对 spec-review 只认 reviewer）。
 * - N4 零残留（= V4 机检）：src/ tests/ AGENTS.md CONTEXT.md 全文扫描旧角色词
 *   零命中。
 *
 * 措辞约定：改名前旧角色值在测试内一律经拼装产生（LEGACY_ROLE），不出现字面量
 * ——N4 的扫描范围包含本文件，字面量会自我击穿零残留口径。
 *
 * 注意：N1 走 dist/cli.js 子进程（e2e 约定），直接 `npx vitest run
 * tests/mx5-4-*.test.ts` 不触发 pretest，需先 `npm run build`（npm test 的
 * pretest 已含）。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import type { AcceptanceItem, VerdictSubmittedPayload } from "../src/events/types.js";
import { loadLedger, treeStatuses } from "../src/readonly/load.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const CLI_PATH = join(DIST_ROOT, "cli.js");
if (!existsSync(CLI_PATH)) {
  throw new Error(`tests/mx5-4 需要 ${CLI_PATH}（先 npm run build；npm test 的 pretest 已含）`);
}
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-mx54-"));
const cwHome = join(tmpRoot, "home");
const originalCwHome = process.env.CW_HOME;
// loop 系用例的 worktree 根隔离（rv5 / mx5-2 同款）
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

/**
 * 改名前的实现角色旧值（mx5-4 前的 role 枚举成员）。拼装产生而非字面量：
 * N4 零残留扫描覆盖 tests/（含本文件），字面量会使 N4 自我矛盾。
 */
const LEGACY_ROLE = ["buil", "der"].join("");
/** 同词首字母大写变体（§4 词形口径：大写变体一并清零） */
const LEGACY_ROLE_CAPITALIZED = ["Bui", "lder"].join("");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 轮询等待条件成立（测试代答与 runner 子进程之间的时序护栏） */
async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const hit = probe();
    if (hit !== undefined) {
      return hit;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`等待超时（${timeoutMs}ms）：${message}`);
    }
    await sleep(200);
  }
}

let caseNo = 0;
let cwd: string;
let ledger: EventLedger;

beforeEach(() => {
  process.env.CW_HOME = cwHome;
  caseNo += 1;
  cwd = join(tmpRoot, `case-${caseNo}`);
  ledger = new EventLedger(ledgerPath(cwHome, cwd));
});

// ---- dispatch 层基建（mx5-1 / mx5-2 同款） ----

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

/** 过 gate 全规则的合法验收（command 首 token node 在 PATH；投影只消费事件字段） */
function contractAcceptance(): AcceptanceItem[] {
  return [
    { id: "E1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
    { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" },
  ];
}

/** 入账 UnitCreated + SpecSubmitted + reviewer pass（unit 进入 spec-frozen） */
function appendFrozenSpec(unitId: string): void {
  ledger.append("UnitCreated", { unitId, parentId: null, briefRef: "brief.md" });
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: `${unitId}-spec-0`,
    acceptance: contractAcceptance(),
    contracts: [],
    split: [],
  });
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
}

/**
 * 直写账本一行历史形态事件（信封形状与 EventLedger.append 逐字段一致：seq 续
 * 末行 + ISO ts + type + payload）。旧角色值的 verdict 无法经类型化 append 或
 * CLI 入账（两者都拒收——这正是被测语义），历史账本重放的构造只剩直写一途。
 */
function appendRawVerdict(payload: Record<string, unknown>): void {
  const file = ledgerPath(cwHome, cwd);
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
  const envelope = {
    seq: lines.length + 1,
    ts: new Date().toISOString(),
    type: "VerdictSubmitted",
    payload,
  };
  appendFileSync(file, `${JSON.stringify(envelope)}\n`);
}

// ================================================================
// N2 / N3：dispatch 层 + 直写历史账本
// ================================================================

describe("N2 旧值拒收", () => {
  it("exec-review 携带旧角色值 --role → exit 1 纯拒绝，文案含 --role developer 迁移指引；--role developer 同命令正常入账", async () => {
    appendFrozenSpec("u-1");
    ledger.append("EvidenceSubmitted", {
      unitId: "u-1",
      runId: "r1",
      commit: "c0ffee",
      paths: ["app.js"],
      sha256: ["0".repeat(64)],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId: "u-1",
      runId: "r1",
      reportHash: "rh-r1",
      result: "pass",
      acceptanceIds: ["E1", "U1"],
    });
    const eventsBefore = ledger.readAll().length;

    const rejected = await run([
      "review", "submit", "--unit", "u-1",
      "--verdict-kind", "exec-review", "--verdict", "pass",
      "--role", LEGACY_ROLE, "--evidence-refs", "r1",
    ]);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain(`非法 --role "${LEGACY_ROLE}"`);
    expect(rejected.stderr).toContain("developer"); // 合法值清单含新角色名
    expect(rejected.stderr).toContain("--role developer"); // 迁移指引（设计检查点③）
    // 纯拒绝：不产生任何事件
    expect(ledger.readAll().length).toBe(eventsBefore);

    // 对照：同命令改用 --role developer → 正常入账（新值收 / 旧值拒成对成立）
    const accepted = await run([
      "review", "submit", "--unit", "u-1",
      "--verdict-kind", "exec-review", "--verdict", "pass",
      "--role", "developer", "--evidence-refs", "r1",
    ]);
    expect(accepted.code).toBe(0);
    const appended = ledger.readAll();
    expect(appended.length).toBe(eventsBefore + 1);
    expect(appended[appended.length - 1]?.type).toBe("VerdictSubmitted");
    const verdictPayload = appended[appended.length - 1]?.payload as VerdictSubmittedPayload;
    expect(verdictPayload.role).toBe("developer");
  });
});

describe("N3 历史重放", () => {
  it("旧角色值的 exec-review pass 照常驱动 closed（fold 对 exec-review 不比对 role）", () => {
    appendFrozenSpec("u-3a");
    ledger.append("EvidenceSubmitted", {
      unitId: "u-3a",
      runId: "r1",
      commit: "c0ffee",
      paths: ["app.js"],
      sha256: ["0".repeat(64)],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId: "u-3a",
      runId: "r1",
      reportHash: "rh-r1",
      result: "pass",
      acceptanceIds: ["E1", "U1"],
    });
    appendRawVerdict({
      unitId: "u-3a",
      verdictKind: "exec-review",
      verdict: "pass",
      role: LEGACY_ROLE,
      evidenceRefs: ["r1"],
    });

    const statuses = treeStatuses(loadLedger(cwd).projection);
    expect(statuses.get("u-3a")).toBe("closed"); // 改名前语义：exec-review 不看 role
  });

  it("旧角色值的 spec-review pass 不驱动 spec-frozen；同账本 reviewer pass 的 unit 正常 frozen（fold 对 spec-review 只认 reviewer）", () => {
    // u-3b：spec-review pass 由旧角色值提交 → 停在 created
    ledger.append("UnitCreated", { unitId: "u-3b", parentId: null, briefRef: "brief.md" });
    ledger.append("SpecSubmitted", {
      unitId: "u-3b",
      specHash: "u-3b-spec-0",
      acceptance: contractAcceptance(),
      contracts: [],
      split: [],
    });
    appendRawVerdict({
      unitId: "u-3b",
      verdictKind: "spec-review",
      verdict: "pass",
      role: LEGACY_ROLE,
    });
    // 对照：同账本另一 unit 的 reviewer pass → spec-frozen（排除 gate/spec 因素）
    appendFrozenSpec("u-3c");

    const statuses = treeStatuses(loadLedger(cwd).projection);
    expect(statuses.get("u-3b")).toBe("created"); // 旧角色值本就不算数——非 reviewer
    expect(statuses.get("u-3c")).toBe("spec-frozen"); // 对照组正常冻结
  });
});

// ================================================================
// N1：真实 spawn 链（cw run --spawn human 子进程，u7-e2e 代答模式）
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
  gitRun(repoDir, ["config", "user.email", "cw-mx54@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-mx54"]);
  writeFileSync(join(repoDir, "brief.md"), "# mx5-4 N1 fixture 任务书\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  return repoDir;
}

describe("N1 角色枚举（human spawn 链）", () => {
  it("buildReady 派 developer：任务书文件名 <unitId>.developer.brief.md、内容角色词、产物名与指令行全为 developer，旧角色词零出现", async () => {
    const repoDir = makeRepo("n1-human");
    const runnerLedger = new EventLedger(ledgerPath(cwHome, repoDir));
    runnerLedger.append("UnitCreated", { unitId: "root", parentId: null, briefRef: "brief.md" });
    runnerLedger.append("SpecSubmitted", {
      unitId: "root",
      specHash: "n1-spec-0",
      acceptance: contractAcceptance(),
      contracts: [],
      split: [],
    });
    runnerLedger.append("VerdictSubmitted", { unitId: "root", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });

    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const child: ChildProcess = spawn(
      process.execPath,
      [CLI_PATH, "run", "--root", "root", "--spawn", "human", "--poll-ms", "200"],
      { cwd: repoDir, env: { ...process.env, CW_HOME: cwHome, CW_WORKTREE_HOME: WT_HOME }, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", (chunk: Buffer) => outChunks.push(chunk.toString("utf-8")));
    child.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk.toString("utf-8")));
    const stdoutText = () => outChunks.join("");

    try {
      // 等首个 developer 派发行（brief 路径内联在行尾）
      const dispatchLine = await waitFor(
        () => stdoutText().split("\n").find((l) => l.includes("派发 developer → unit \"root\"")),
        30_000,
        "runner 应派发 developer（buildReady → developer）",
      );
      expect(dispatchLine).toContain("developer");
      const briefMatch = dispatchLine.match(/brief: (.+)）$/);
      expect(briefMatch, `派发行应内联 brief 路径：${dispatchLine}`).not.toBeNull();
      const briefPath = briefMatch?.[1] ?? "";
      expect(briefPath).not.toBe("");

      // 任务书文件名形态 <unitId>.<role>.brief.md（fx-4 产物命名随角色变）
      const briefBase = briefPath.split("/").pop() ?? "";
      expect(briefBase).toBe("root.developer.brief.md");
      const brief = readFileSync(briefPath, "utf-8");
      expect(brief).toContain("# developer 任务书：unit \"root\"");
      expect(brief).toContain("## 你的任务（developer）");
      expect(brief).not.toContain(LEGACY_ROLE);

      // spawn 产物文件名 <unitId>.<role>.stdout / .stderr（human 适配器落盘）
      const artifactDir = dirname(briefPath);
      expect(existsSync(join(artifactDir, "root.developer.stdout"))).toBe(true);
      expect(existsSync(join(artifactDir, "root.developer.stderr"))).toBe(true);
      const developerStdout = readFileSync(join(artifactDir, "root.developer.stdout"), "utf-8");
      expect(developerStdout).toContain("[human] developer 指令：unit \"root\"");
      expect(developerStdout).not.toContain(LEGACY_ROLE);

      // 「人」代答 developer 三步的后两步产物事件（VerifyRan 是 developer flight
      // 的完成信号——human 适配器 PROGRESS_MATCHERS 按新角色名注册）
      runnerLedger.append("EvidenceSubmitted", {
        unitId: "root",
        runId: "n1-run",
        commit: gitRun(repoDir, ["rev-parse", "HEAD"]),
        paths: ["app.js"],
        sha256: ["0".repeat(64)],
        exitCode: 0,
      });
      runnerLedger.append("VerifyRan", {
        unitId: "root",
        runId: "n1-run",
        reportHash: "rh-n1-run",
        result: "pass",
        acceptanceIds: ["E1", "U1"],
      });

      // verified → 派 reviewer（exec-review），角色面保持 reviewer 不受改名影响
      await waitFor(
        () => stdoutText().split("\n").find((l) => l.includes("派发 reviewer → unit \"root\"")),
        30_000,
        "verify pass 后应派发 reviewer（execReviewReady）",
      );

      // 「人」代答 reviewer：exec-review pass（走真实 CLI 校验路径）
      const verdict = spawnSync(
        process.execPath,
        [CLI_PATH, "review", "submit", "--unit", "root", "--verdict-kind", "exec-review",
          "--verdict", "pass", "--role", "reviewer", "--evidence-refs", "n1-run", "--comment", "N1 代答"],
        { cwd: repoDir, encoding: "utf-8", env: { ...process.env, CW_HOME: cwHome }, timeout: 30_000 },
      );
      expect(verdict.status, `review submit 应成功：${verdict.stderr}`).toBe(0);

      // root closed → runner exit 0（human reviewer flight 以 VerdictSubmitted 结算）
      const exit = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`runner 未在 30s 内退出。stdout 末尾：${stdoutText().slice(-500)}`));
        }, 30_000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code ?? -1);
        });
      });
      expect(exit).toBe(0);
      // 全链输出零旧角色词（runner 日志 / human 指令 / 汇总）
      expect(stdoutText()).not.toContain(LEGACY_ROLE);
      expect(errChunks.join("")).not.toContain(LEGACY_ROLE);
      expect(treeStatuses(loadLedger(repoDir).projection).get("root")).toBe("closed");
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
    }
  }, 120_000);
});

// ================================================================
// N4：零残留机检（= V4 场景的 grep 断言化）
// ================================================================

describe("N4 零残留", () => {
  it("src/ tests/ AGENTS.md CONTEXT.md 全文扫描：旧角色词（含大写变体）零命中", () => {
    function listFiles(root: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
          out.push(...listFiles(path));
        } else {
          out.push(path);
        }
      }
      return out;
    }

    const targets = [
      ...listFiles(join(REPO_ROOT, "src")),
      ...listFiles(join(REPO_ROOT, "tests")),
      join(REPO_ROOT, "AGENTS.md"),
      join(REPO_ROOT, "CONTEXT.md"),
    ];
    expect(targets.length).toBeGreaterThan(30); // 扫描面非空（src 9+ tests 27+ 文档 2）
    const violations: string[] = [];
    for (const path of targets) {
      const content = readFileSync(path, "utf-8");
      if (content.includes(LEGACY_ROLE) || content.includes(LEGACY_ROLE_CAPITALIZED)) {
        violations.push(path);
      }
    }
    expect(violations, `以下文件残留旧角色词：${violations.join(", ")}`).toEqual([]);
  });
});

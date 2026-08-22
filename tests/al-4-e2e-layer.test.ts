/**
 * al-4 端到端真实场景验收（M5 收官 unit，docs/rewrite/acceptance/al-4-acceptance.md）：
 *   S1（A1-1..A1-4）topic 层条目只在集成执行一次——叶子 verify 路径零回归痕迹；
 *   S6（A6-1..A6-3）触发案例形态对照——无关既有挂测试让回归只在集成红一次，
 *   处置走 integrationDrift 通道（rv-4 MAX=1 首败即转），修复后闭环恢复；
 *   通用：全链事件序断言（SpecSubmitted(root) 含 layer 字段原文 → … →
 *   VerifyRan(integrate-*) acceptanceIds 含 R1）。
 *
 * fixture 仓按验收文档 §4 锁定内联构造（不新增 tests/fixtures/ 文件）：多包仓
 * （packages/app + packages/lib 各带真实 vitest 套件 + 根 lint 脚本）+
 * scripts/topic-regression.sh wrapper（设计 D1a 形态一：lint + 全部包 vitest，
 * 尾部按成败输出 `R1 PASS`/`R1 FAIL` 且 exit code 一致）。vitest 经绝对路径
 * 驱动本仓 node_modules 的 vitest.mjs——干净 checkout / clone 内无本地安装，
 * `npx vitest` 会走网络解析，绝对路径形态零网络依赖且语义等同（vitest 适配器
 * 只消费 stdout 的 JSON reporter 产物）。
 *
 * 集成入口对齐 tests/u8-integrate.test.ts 先例（进程内直调 runIntegrationVerify，
 * import 路径与调用形态一致）；集成的 VerifyRan 入账按 loop.runIntegrationDispatch
 * 同款语义由测试进程代笔——手动链中测试进程扮演全部角色（含 loop 的编排职责，
 * A1-4「全链人工零干预」的落地形态）：pass 轮 acceptanceIds = 子 ∪ root 全部
 * 验收 id，fail 轮 = 仅 root manual 型，reportHash = 集成报告文件 sha256。
 *
 * 真实环境零 mock：真实子进程跑 dist/cli.js（完整 dispatch 路径）+ 真实 git 仓
 * 与子进程 + tmp CW_HOME / CW_WORKTREE_HOME 隔离。直接
 * `npx vitest run tests/al-4-e2e-layer.test.ts` 不触发 pretest，需先 `npm run
 * build`（`npm test` 的 pretest 已含 build）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type {
  AcceptanceItem,
  DiscriminatedEvent,
  SequencedUnitProjection,
  SplitEntry,
  VerifyRanPayload,
} from "../src/events/types.js";
import { ledgerForCwd } from "../src/handlers/common.js";
import { loadLedger } from "../src/readonly/load.js";
import { type IntegrateResult, runIntegrationVerify } from "../src/runner/integrate.js";
import { encodeCwd, evidenceDir, ledgerPath, worktreePath } from "../src/store/project.js";
import type { OwnedContract } from "../src/verify/contract-match.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI_PATH = join(REPO_ROOT, "dist", "cli.js");
const VITEST_BIN = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
for (const required of [CLI_PATH, VITEST_BIN]) {
  if (!existsSync(required)) {
    throw new Error(
      `tests/al-4-e2e-layer 需要 ${required}（先 npm run build；npm test 的 pretest 已含；vitest 依赖 node_modules 就位）`,
    );
  }
}
// 验收 command 按空白切分 token（gate ⑨/⑪ 与 bash 执行都是），路径含空白会破坏
// token 形态——提前出声而非测试中段炸出难定位的 gate/解析错误
if (/\s/.test(VITEST_BIN)) {
  throw new Error(`vitest 绝对路径含空白字符，验收命令 token 形态不可用：${VITEST_BIN}`);
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-al4-e2e-"));
const cwHome = join(tmpRoot, "cw-home");
process.env.CW_HOME = cwHome;
// 集成步骤 0 会建 root worktree（cw-root/<rootId> 分支），隔离 worktree 根
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

const ROOT_ID = "topic";
const LEAVES = ["leaf-app", "leaf-lib"] as const;
type LeafId = (typeof LEAVES)[number];

// ── 基础设施（真实子进程 / 真实 git，al-2 同款物理路径坑位处理） ──────────

function gitRun(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git -C ${dir} ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 真实子进程跑 dist/cli.js（e2e 形态：完整 dispatch 路径）；cwd = tmp git 仓 */
function runCli(
  repoDir: string,
  args: readonly string[],
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
    timeout: 300_000,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** 提交一批文件（显式 add 路径——链路期间的 spec.json 等未跟踪文件不入 build commit） */
function commitFiles(repoDir: string, files: Record<string, string>, message: string): string {
  writeFiles(repoDir, files);
  gitRun(repoDir, ["add", ...Object.keys(files)]);
  gitRun(repoDir, ["commit", "-m", message]);
  return gitRun(repoDir, ["rev-parse", "HEAD"]);
}

function eventsOf(repoDir: string): DiscriminatedEvent[] {
  return ledgerForCwd(repoDir).readAll() as DiscriminatedEvent[];
}

function verifyRunsOf(repoDir: string, unitId?: string): VerifyRanPayload[] {
  const runs: VerifyRanPayload[] = [];
  for (const ev of eventsOf(repoDir)) {
    if (ev.type === "VerifyRan" && (unitId === undefined || ev.payload.unitId === unitId)) {
      runs.push(ev.payload);
    }
  }
  return runs;
}

function unitOf(repoDir: string, unitId: string): SequencedUnitProjection {
  const unit = loadLedger(repoDir).projection.units.get(unitId);
  if (unit === undefined) {
    throw new Error(`unit ${unitId} 不在账本（断言前置失败）`);
  }
  return unit;
}

/** evidence/<unitId>/ 下的 run 目录（verify-* / red-phase-* / integrate-*），排除 attachments 副本目录 */
function evidenceRunDirs(repoDir: string, unitId: string): string[] {
  const unitDir = join(cwHome, encodeCwd(repoDir), "evidence", unitId);
  if (!existsSync(unitDir)) {
    return [];
  }
  return readdirSync(unitDir, { withFileTypes: true })
    .filter((ent) => ent.isDirectory() && ent.name !== "attachments")
    .map((ent) => join(unitDir, ent.name));
}

function listFilesDeep(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const ent of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, ent.name);
      if (ent.isDirectory()) {
        walk(path);
      } else {
        out.push(path);
      }
    }
  };
  walk(dir);
  return out;
}

interface IntegrateReportShape {
  acceptanceBatches: Array<{
    unitId: string;
    results: Array<{ id: string; status: string; reason?: string }>;
  }>;
  children: Array<{ unitId: string; commit: string; reachable: boolean }>;
  ok: boolean;
}

function readIntegrateReport(result: IntegrateResult): IntegrateReportShape {
  return JSON.parse(readFileSync(result.reportPath, "utf-8")) as IntegrateReportShape;
}

// ── fixture 多包仓（验收文档 §4 锁定：根 lint + wrapper + 两包真实 vitest 套件） ──

const LINT_SH = [
  "#!/bin/sh",
  "# 真实 lint 规则：源码禁用 console.log（grep 真实执行，非桩）",
  "if grep -rn 'console\\.log' packages/*/src; then",
  '  echo "lint: 命中禁用项 console.log（见上方）" >&2',
  "  exit 1",
  "fi",
  'echo "lint: ok"',
  "",
].join("\n");

function topicRegressionSh(): string {
  return [
    "#!/bin/sh",
    "# R1 topic 层全量回归 wrapper（设计 D1a 形态一）：lint + 全部包 vitest。",
    "# 严格「全绿才 PASS」：任何一步挂（lint 红 / 任一包任一测试挂——含既有挂测试）",
    "# 都不得输出 PASS 标记；exit code 与尾部标记行一致（e2e-sh 适配器契约）。",
    "fail=0",
    "sh scripts/lint.sh || fail=1",
    `node '${VITEST_BIN}' run packages/app || fail=1`,
    `node '${VITEST_BIN}' run packages/lib || fail=1`,
    'if [ "$fail" -eq 0 ]; then',
    '  echo "R1 PASS"',
    "  exit 0",
    "fi",
    'echo "R1 FAIL"',
    "exit 1",
    "",
  ].join("\n");
}

const ROOT_SMOKE_SH = [
  "#!/bin/sh",
  "# RU1 root 单元冒烟（runner: e2e-sh 显式声明走标记行契约；exit code 与标记一致）",
  "if node scripts/root-smoke.check.js; then",
  '  echo "RU1 PASS"',
  "else",
  '  echo "RU1 FAIL"',
  "  exit 1",
  "fi",
  "",
].join("\n");

const ROOT_SMOKE_CHECK_JS = [
  "// RU1 冒烟：两包导出协同可用（真实 import，缺任一实现即挂——有区分力）",
  'const { greet } = await import("../packages/app/src/greet.js");',
  'const { shout } = await import("../packages/lib/src/shout.js");',
  'if (greet("cw") !== "hello cw" || shout("hi") !== "HI!") {',
  "  process.exit(1);",
  "}",
  "",
].join("\n");

const GREET_JS = 'export function greet(name) {\n  return `hello ${name}`;\n}\n';
const SHOUT_JS = 'export function shout(s) {\n  return `${s.toUpperCase()}!`;\n}\n';

const APP_TEST_TS = [
  'import { describe, expect, it } from "vitest";',
  'import { greet } from "./src/greet.js";',
  "",
  'describe("app", () => {',
  '  it("FA1 greet 拼接问候", () => {',
  '    expect(greet("cw")).toBe("hello cw");',
  "  });",
  "});",
  "",
].join("\n");

const LIB_TEST_TS = [
  'import { describe, expect, it } from "vitest";',
  'import { shout } from "./src/shout.js";',
  "",
  'describe("lib", () => {',
  '  it("FB1 shout 大写加叹号", () => {',
  '    expect(shout("hi")).toBe("HI!");',
  "  });",
  "});",
  "",
].join("\n");

const BROKEN_TEST_TS = [
  'import { describe, expect, it } from "vitest";',
  "",
  "// 既有坏测试形态：与本功能无关、恒挂（S6 场景构造——触发案例的「无关红」）",
  'describe("legacy", () => {',
  '  it("legacy 旧行为（无人修）", () => {',
  "    expect(1).toBe(2);",
  "  });",
  "});",
  "",
].join("\n");

const PKG_JSON = (name: string): string =>
  `${JSON.stringify({ name, type: "module", version: "1.0.0" }, null, 2)}\n`;

/** 真实 tmp git 多包仓：git init + 初始 commit（verify 的干净 checkout 需有 commit 可检出） */
function makeMonorepoFixture(name: string, opts: { broken: boolean }): string {
  const raw = join(tmpRoot, name);
  mkdirSync(raw, { recursive: true });
  // 子进程 process.cwd() 返回物理路径（macOS /var → /private/var 符号链接），
  // 父进程账本路径计算必须用同一物理路径，否则 encodeCwd 不一致、账本「消失」
  const repoDir = realpathSync(raw);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-al4@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-al4"]);
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(
      { name: "al4-fixture", private: true, type: "module", scripts: { lint: "bash scripts/lint.sh" } },
      null,
      2,
    )}\n`,
    "brief.md": "# al4 fixture root 任务书（topic 层回归上收场景）\n",
    "brief-leaf-app.md": "# leaf-app：app 包 greet 功能\n",
    "brief-leaf-lib.md": "# leaf-lib：lib 包 shout 功能\n",
    "scripts/lint.sh": LINT_SH,
    "scripts/topic-regression.sh": topicRegressionSh(),
    "scripts/root-smoke.sh": ROOT_SMOKE_SH,
    "scripts/root-smoke.check.js": ROOT_SMOKE_CHECK_JS,
    "packages/app/package.json": PKG_JSON("app"),
    "packages/lib/package.json": PKG_JSON("lib"),
  };
  if (opts.broken) {
    files["packages/lib/broken.test.ts"] = BROKEN_TEST_TS;
  }
  writeFiles(repoDir, files);
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, [
    "commit",
    "-m",
    opts.broken ? "fixture: 多包基底 + 既有挂测试（S6 形态）" : "fixture: 多包基底（S1 形态）",
  ]);
  return repoDir;
}

// ── spec 构造（root：R1 topic 条目 + RU1 unit 级用例（规则⑤）；叶：vitest 收窄形态） ──

function rootSpec(): { acceptance: AcceptanceItem[]; contracts: []; split: SplitEntry[] } {
  return {
    acceptance: [
      {
        id: "R1",
        core: true,
        title: "全仓回归：lint + 全部包 vitest",
        type: "e2e-real",
        command: "bash scripts/topic-regression.sh",
        layer: "topic",
      },
      {
        id: "RU1",
        core: false,
        title: "root 单元冒烟（规则⑤：topic 条目不豁免 unit 级用例）",
        type: "unit",
        runner: "e2e-sh",
        command: "sh scripts/root-smoke.sh",
      },
    ],
    contracts: [],
    split: [
      { unitId: "leaf-app", briefRef: "brief-leaf-app.md", dependsOn: [] },
      { unitId: "leaf-lib", briefRef: "brief-leaf-lib.md", dependsOn: [] },
    ],
  };
}

function leafSpec(unitId: LeafId): { acceptance: AcceptanceItem[]; contracts: []; split: [] } {
  const scoped = unitId === "leaf-app" ? "packages/app/app.test.ts" : "packages/lib/lib.test.ts";
  const id = unitId === "leaf-app" ? "FA1" : "FB1";
  return {
    acceptance: [
      {
        id,
        core: false,
        title: `${unitId} 功能验收（vitest 文件参数收窄形态）`,
        type: "unit",
        // 绝对路径驱动本仓 vitest：干净 checkout 内无本地 node_modules，npx 会走
        // 网络解析；文件参数在场 = 规则⑪ 收窄形态不命中
        command: `node ${VITEST_BIN} run ${scoped}`,
      },
    ],
    contracts: [],
    split: [],
  };
}

// ── 手动链推进（验收文档 §4「真实 CLI 手动链」；fx-3 R5.1：先建子后提 root spec） ──

function runRootChain(repoDir: string): void {
  const createdRoot = runCli(repoDir, ["create", "--id", ROOT_ID, "--brief", "brief.md"]);
  expect(createdRoot.code, createdRoot.stderr).toBe(0);
  for (const leaf of LEAVES) {
    const created = runCli(repoDir, ["create", "--id", leaf, "--brief", `brief-${leaf}.md`, "--parent", ROOT_ID]);
    expect(created.code, created.stderr).toBe(0);
  }
  writeFileSync(join(repoDir, "spec-root.json"), `${JSON.stringify(rootSpec(), null, 2)}\n`);
  const submitted = runCli(repoDir, [
    "evidence",
    "submit",
    "--kind",
    "spec",
    "--unit",
    ROOT_ID,
    "--file",
    "spec-root.json",
  ]);
  expect(submitted.code, submitted.stderr).toBe(0);
  // root 的 topic 条目过规则⑩（split 非空）；RU1 词法形态不命中规则⑪
  expect(submitted.stderr).not.toContain("规则⑩");
  expect(submitted.stderr).not.toContain("规则⑪");
  const reviewed = runCli(repoDir, [
    "review",
    "submit",
    "--unit",
    ROOT_ID,
    "--verdict-kind",
    "spec-review",
    "--verdict",
    "pass",
    "--role",
    "reviewer",
  ]);
  expect(reviewed.code, reviewed.stderr).toBe(0);
}

/** 叶子全生命周期：spec 过审 → build 实现 commit → verify（含默认红阶段）→ exec-review closed */
function runLeafLifecycle(repoDir: string, unitId: LeafId, buildFiles: Record<string, string>): string {
  const acceptanceId = unitId === "leaf-app" ? "FA1" : "FB1";
  const specFile = `spec-${unitId}.json`;
  writeFileSync(join(repoDir, specFile), `${JSON.stringify(leafSpec(unitId), null, 2)}\n`);
  const submitted = runCli(repoDir, [
    "evidence",
    "submit",
    "--kind",
    "spec",
    "--unit",
    unitId,
    "--file",
    specFile,
  ]);
  expect(submitted.code, submitted.stderr).toBe(0);
  expect(submitted.stderr).not.toContain("规则⑪");
  const reviewed = runCli(repoDir, [
    "review",
    "submit",
    "--unit",
    unitId,
    "--verdict-kind",
    "spec-review",
    "--verdict",
    "pass",
    "--role",
    "reviewer",
  ]);
  expect(reviewed.code, reviewed.stderr).toBe(0);

  const commit = commitFiles(repoDir, buildFiles, `build(${unitId}): 实现 + 测试`);
  const buildRunId = `build-${unitId}-1`;
  const built = runCli(repoDir, [
    "evidence",
    "submit",
    "--kind",
    "build",
    "--unit",
    unitId,
    "--commit",
    commit,
    "--run-id",
    buildRunId,
  ]);
  expect(built.code, built.stderr).toBe(0);

  const startedAt = Date.now();
  const verified = runCli(repoDir, ["verify", "--unit", unitId]);
  const verifyMs = Date.now() - startedAt;
  expect(
    verified.code,
    `verify 应 exit 0（stderr:\n${verified.stderr}\nstdout:\n${verified.stdout}）`,
  ).toBe(0);
  expect(verified.stdout).toContain(`${acceptanceId} pass`);
  // 通用条款：叶子 verify 耗时记录供人工对照 S1②（不设硬断言）
  console.log(`[al-4] ${unitId} verify 耗时 ${verifyMs}ms（功能验收量级，不含全量回归）`);

  const execReviewed = runCli(repoDir, [
    "review",
    "submit",
    "--unit",
    unitId,
    "--verdict-kind",
    "exec-review",
    "--verdict",
    "pass",
    "--role",
    "reviewer",
    "--evidence-refs",
    buildRunId,
  ]);
  expect(execReviewed.code, execReviewed.stderr).toBe(0);
  return commit;
}

const LEAF_BUILD_FILES: Record<LeafId, Record<string, string>> = {
  "leaf-app": { "packages/app/src/greet.js": GREET_JS, "packages/app/app.test.ts": APP_TEST_TS },
  "leaf-lib": { "packages/lib/src/shout.js": SHOUT_JS, "packages/lib/lib.test.ts": LIB_TEST_TS },
};

/**
 * 集成 + VerifyRan 入账（loop.runIntegrationDispatch 同款语义的手动链形态）：
 * 子 commit 取各叶最后一条 build 证据、root 验收与契约取账本最后一条冻结 spec
 * （账本是唯一权威源）；runIntegrationVerify 本体不写账本，入账是调用方（loop）
 * 的编排职责——手动链中由测试进程代笔。
 */
async function integrateLikeLoop(repoDir: string): Promise<{ result: IntegrateResult; payload: VerifyRanPayload }> {
  const root = unitOf(repoDir, ROOT_ID);
  const spec = root.specs[root.specs.length - 1];
  if (spec === undefined) {
    throw new Error("root 无冻结 spec（断言前置失败）");
  }
  const children: Array<{ unitId: string; commit: string }> = [];
  const childUnits: SequencedUnitProjection[] = [];
  for (const entry of spec.split) {
    const child = unitOf(repoDir, entry.unitId);
    const lastEvidence = child.evidences[child.evidences.length - 1];
    if (lastEvidence === undefined) {
      throw new Error(`子 ${entry.unitId} 无 build 证据（断言前置失败）`);
    }
    children.push({ unitId: entry.unitId, commit: lastEvidence.commit });
    childUnits.push(child);
  }
  const contracts: OwnedContract[] = [root, ...childUnits].flatMap((owner) =>
    (owner.specs[owner.specs.length - 1]?.contracts ?? []).map((contract) => ({
      contract,
      ownerUnitId: owner.unitId,
    })),
  );

  const startedAt = Date.now();
  const result = await runIntegrationVerify({
    cwd: repoDir,
    rootId: ROOT_ID,
    children,
    rootAcceptance: spec.acceptance,
    contracts,
    timeoutMs: 120_000,
  });
  console.log(`[al-4] 集成 ${result.runId} result=${result.ok ? "pass" : "fail"} 耗时 ${Date.now() - startedAt}ms`);

  // acceptanceIds 口径对齐 loop：pass = 子 ∪ root 全部验收 id；fail = 仅 root manual 型
  const childIds = childUnits.flatMap(
    (child) => (child.specs[child.specs.length - 1]?.acceptance ?? []).map((ac) => ac.id),
  );
  const payload: VerifyRanPayload = {
    unitId: ROOT_ID,
    runId: result.runId,
    reportHash: createHash("sha256").update(readFileSync(result.reportPath)).digest("hex"),
    result: result.ok ? "pass" : "fail",
    acceptanceIds: result.ok
      ? [...new Set([...childIds, ...spec.acceptance.map((ac) => ac.id)])]
      : spec.acceptance.filter((ac) => ac.type === "manual").map((ac) => ac.id),
  };
  ledgerForCwd(repoDir).append("VerifyRan", payload);
  return { result, payload };
}

// ================================================================
// A1 系（S1：执行点唯一性）
// ================================================================

describe("A1 系（S1：topic 层条目只在集成执行一次）", () => {
  let repoDir = "";
  let integrated: { result: IntegrateResult; payload: VerifyRanPayload } | null = null;

  function chain(): { repoDir: string; integrated: { result: IntegrateResult; payload: VerifyRanPayload } } {
    if (repoDir === "" || integrated === null) {
      throw new Error("前置链未完成（前置 it 失败时后续断言无从执行）");
    }
    return { repoDir, integrated };
  }

  it("前置链：真实 CLI 手动链推进（root+两叶 spec 过审 → 叶子 build/verify/exec-review closed → 直调 runIntegrationVerify）", async () => {
    repoDir = makeMonorepoFixture("s1-execution-point", { broken: false });
    runRootChain(repoDir);
    for (const leaf of LEAVES) {
      runLeafLifecycle(repoDir, leaf, LEAF_BUILD_FILES[leaf]);
    }
    integrated = await integrateLikeLoop(repoDir);
    expect(integrated.result.ok, integrated.result.failures.join("\n")).toBe(true);
    expect(integrated.payload.result).toBe("pass");
  }, 300_000);

  it("A1-1 叶子 verify 产物目录零 R1 执行痕迹（叶 spec 无该条目 = 结构结果；R1 的 stdout/report 文件不在叶子产物集）", () => {
    const { repoDir: dir } = chain();
    for (const leaf of LEAVES) {
      // 结构结果：叶 spec 验收集不含 R1
      const lastSpec = unitOf(dir, leaf).specs.at(-1);
      expect(lastSpec?.acceptance.map((ac) => ac.id)).toEqual([leaf === "leaf-app" ? "FA1" : "FB1"]);

      // 产物集核对：全部 run 目录（verify-* + red-phase-*）逐文件无 R1 产物
      const runDirs = evidenceRunDirs(dir, leaf);
      expect(runDirs.length).toBeGreaterThanOrEqual(2); // verify + 红阶段（rv-4 默认执行）
      for (const runDir of runDirs) {
        for (const file of listFilesDeep(runDir)) {
          expect(basename(file).startsWith("R1."), `意外产物 ${file}`).toBe(false);
        }
        const reportPath = join(runDir, "report.json");
        if (existsSync(reportPath)) {
          const cases = (JSON.parse(readFileSync(reportPath, "utf-8")) as {
            cases: Array<{ id: string }>;
          }).cases;
          expect(cases.some((c) => c.id === "R1"), `意外覆盖 ${reportPath}`).toBe(false);
        }
      }

      // 叶子 verify 恰一次（本链无 fix 循环），机器 pass 集自然不含 R1
      const runs = verifyRunsOf(dir, leaf);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.acceptanceIds).toEqual([leaf === "leaf-app" ? "FA1" : "FB1"]);
    }
  });

  it("A1-2 集成 root 批次含 R1 真实执行（R1.report.json 在场、e2e-sh 标记行判定、pass）", () => {
    const { repoDir: dir, integrated: done } = chain();
    expect(done.result.runId).toMatch(/^integrate-/);
    const rootBatchDir = join(evidenceDir(cwHome, dir, ROOT_ID, done.result.runId), ROOT_ID);
    expect(existsSync(join(rootBatchDir, "R1.report.json"))).toBe(true);
    expect(readFileSync(join(rootBatchDir, "R1.stdout"), "utf-8")).toContain("R1 PASS");
    // e2e-sh 折叠报告：name = 标记行原文，判定 = pass
    const r1Report = JSON.parse(readFileSync(join(rootBatchDir, "R1.report.json"), "utf-8")) as {
      cases: Array<{ id: string; name: string; status: string }>;
    };
    expect(r1Report.cases.find((c) => c.id === "R1")).toMatchObject({ name: "R1 PASS", status: "pass" });
    // 集成报告结构：root 批次 R1/RU1 均 pass，子可达
    const report = readIntegrateReport(done.result);
    const rootBatch = report.acceptanceBatches.find((b) => b.unitId === ROOT_ID);
    expect(rootBatch?.results.find((r) => r.id === "R1")).toMatchObject({ status: "pass" });
    expect(rootBatch?.results.find((r) => r.id === "RU1")).toMatchObject({ status: "pass" });
    expect(report.children.every((c) => c.reachable)).toBe(true);
  });

  it("A1-3 全账本 R1 执行记录唯一：仅出现在 integrate-* run（无 verify-* run 覆盖 R1）", () => {
    const { repoDir: dir } = chain();
    const runsWithR1 = verifyRunsOf(dir).filter((run) => run.acceptanceIds.includes("R1"));
    expect(runsWithR1).toHaveLength(1);
    expect(runsWithR1[0]?.runId.startsWith("integrate-")).toBe(true);
    // root 自身无任何 verify-* run（手动链不对内部节点跑 cw verify——D2 已知边界不触发）
    const rootRuns = verifyRunsOf(dir, ROOT_ID);
    expect(rootRuns).toHaveLength(1);
    expect(rootRuns[0]?.runId.startsWith("integrate-")).toBe(true);
  });

  it("A1-4 集成 pass 后 root verified 收敛（fold 投影 + report 覆盖标记）", () => {
    const { repoDir: dir } = chain();
    const statusJson = runCli(dir, ["status", "--json"]);
    expect(statusJson.code, statusJson.stderr).toBe(0);
    const parsed = JSON.parse(statusJson.stdout) as { units: Array<{ unitId: string; status: string }> };
    expect(parsed.units.find((u) => u.unitId === ROOT_ID)?.status).toBe("verified");
    const report = runCli(dir, ["report"]);
    expect(report.code, report.stderr).toBe(0);
    expect(report.stdout).toMatch(/R1 e2e-real \[core\] ✓/);
    expect(report.stdout).toMatch(/RU1 unit ✓/);
  });

  it("通用：全链事件序断言（SpecSubmitted(root) 含 layer 字段原文 → … → VerifyRan(integrate-*) acceptanceIds 含 R1）", () => {
    const { repoDir: dir, integrated: done } = chain();
    const expected: Array<[string, string]> = [
      ["UnitCreated", ROOT_ID],
      ["UnitCreated", "leaf-app"],
      ["UnitCreated", "leaf-lib"],
      ["SpecSubmitted", ROOT_ID],
      ["VerdictSubmitted", ROOT_ID], // spec-review pass（reviewer）
      ["SpecSubmitted", "leaf-app"],
      ["VerdictSubmitted", "leaf-app"], // spec-review pass
      ["EvidenceSubmitted", "leaf-app"],
      ["VerifyRan", "leaf-app"],
      ["VerdictSubmitted", "leaf-app"], // exec-review pass（closed）
      ["SpecSubmitted", "leaf-lib"],
      ["VerdictSubmitted", "leaf-lib"],
      ["EvidenceSubmitted", "leaf-lib"],
      ["VerifyRan", "leaf-lib"],
      ["VerdictSubmitted", "leaf-lib"], // exec-review pass（closed）
      ["VerifyRan", ROOT_ID], // integrate-* pass
    ];
    expect(eventsOf(dir).map((ev) => [ev.type, ev.payload.unitId] as [string, string])).toEqual(expected);

    // root spec 入账 payload 的 layer 字段原文（声明在账在）
    const rootSpecPayload = unitOf(dir, ROOT_ID).specs[0];
    expect(rootSpecPayload?.acceptance.find((ac) => ac.id === "R1")?.layer).toBe("topic");
    // 原始 JSONL 的 SpecSubmitted 行含 layer 键（序列化形态锁定，al-2 L1 同款口径）
    const specLine = readFileSync(ledgerPath(cwHome, dir), "utf-8")
      .split("\n")
      .find((line) => line.includes("SpecSubmitted") && line.includes(`"unitId":"${ROOT_ID}"`));
    expect(specLine).toContain('"layer":"topic"');

    // 集成 VerifyRan 覆盖集含 R1（verified 判定输入）
    expect(done.payload.acceptanceIds).toContain("R1");
  });
});

// ================================================================
// A6 系（S6：触发案例形态对照）
// ================================================================

describe("A6 系（S6：无关既有挂测试让回归只在集成红一次，处置走 integrationDrift）", () => {
  let repoDir = "";
  let firstIntegrate: { result: IntegrateResult; payload: VerifyRanPayload } | null = null;
  let secondIntegrate: { result: IntegrateResult; payload: VerifyRanPayload } | null = null;

  function chain(): { repoDir: string; first: { result: IntegrateResult; payload: VerifyRanPayload } } {
    if (repoDir === "" || firstIntegrate === null) {
      throw new Error("前置链未完成（前置 it 失败时后续断言无从执行）");
    }
    return { repoDir, first: firstIntegrate };
  }

  it("前置链：broken.test.ts 在场（既有挂测试形态）手动链推进 → 首次集成 fail（wrapper 全绿才 PASS 语义 → R1 FAIL）", async () => {
    repoDir = makeMonorepoFixture("s6-trigger-case", { broken: true });
    runRootChain(repoDir);
    for (const leaf of LEAVES) {
      runLeafLifecycle(repoDir, leaf, LEAF_BUILD_FILES[leaf]);
    }
    firstIntegrate = await integrateLikeLoop(repoDir);
    expect(firstIntegrate.result.ok).toBe(false);
    expect(firstIntegrate.result.failures.join("\n")).toContain("R1");
    expect(firstIntegrate.payload.result).toBe("fail");
  }, 300_000);

  it("A6-1 回归只在集成红：R1 的红仅出现在 integrate-* run 一次，叶子各轮 verify 零次执行 R1", () => {
    const { repoDir: dir, first } = chain();
    // 集成报告：root 批次 R1 fail（红定位精确）
    const report = readIntegrateReport(first.result);
    const rootBatch = report.acceptanceBatches.find((b) => b.unitId === ROOT_ID);
    expect(rootBatch?.results.find((r) => r.id === "R1")).toMatchObject({ status: "fail" });
    // wrapper 产物：R1 FAIL 标记行（全绿才 PASS 语义的实证）
    const rootBatchDir = join(evidenceDir(cwHome, dir, ROOT_ID, first.result.runId), ROOT_ID);
    expect(readFileSync(join(rootBatchDir, "R1.stdout"), "utf-8")).toContain("R1 FAIL");

    // R1 的红全账本恰一次，且只在 integrate-* run 下（深扫含集成的 unit 批次子目录）
    const redOccurrences: string[] = [];
    for (const unitId of [ROOT_ID, ...LEAVES]) {
      for (const runDir of evidenceRunDirs(dir, unitId)) {
        for (const file of listFilesDeep(runDir)) {
          if (basename(file) === "R1.stdout" && readFileSync(file, "utf-8").includes("R1 FAIL")) {
            redOccurrences.push(file);
          }
        }
      }
    }
    expect(redOccurrences).toHaveLength(1);
    expect(redOccurrences[0]).toContain(first.result.runId);

    // 叶子零次执行 R1：产物集无 R1 文件、verify 恰一次且 pass 集不含 R1
    for (const leaf of LEAVES) {
      for (const runDir of evidenceRunDirs(dir, leaf)) {
        expect(
          listFilesDeep(runDir).some((f) => basename(f).startsWith("R1.")),
          `意外产物目录 ${runDir}`,
        ).toBe(false);
      }
      const runs = verifyRunsOf(dir, leaf);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.result).toBe("pass");
      expect(runs[0]?.acceptanceIds.includes("R1")).toBe(false);
    }
  });

  it("A6-2 处置走 integrationDrift（rv-4 MAX=1 首败即转）：frontier 投影出现该维度，且叶子零多轮全价重付", () => {
    const { repoDir: dir } = chain();
    const frontier = runCli(dir, ["frontier", "--json"]);
    expect(frontier.code, frontier.stderr).toBe(0);
    const groups = JSON.parse(frontier.stdout) as Record<string, string[]>;
    expect(groups.integrationDrift).toContain(ROOT_ID);

    // 对照组：触发案例 5 轮 build + 6 次 verify 全价重付——本场景叶子各恰 1 build + 1 verify，
    // 且叶子 verify 全部发生在首次集成 fail 之前（集成红未向叶子侧回灌任何重跑）
    const events = eventsOf(dir);
    const leafVerifySeqs = events
      .filter((ev) => ev.type === "VerifyRan" && ev.payload.unitId !== ROOT_ID)
      .map((ev) => ev.seq);
    const integrateFailSeq = events.find(
      (ev) => ev.type === "VerifyRan" && ev.payload.runId === firstIntegrate?.result.runId,
    )?.seq;
    expect(integrateFailSeq).toBeDefined();
    expect(Math.max(...leafVerifySeqs)).toBeLessThan(integrateFailSeq ?? Number.MAX_SAFE_INTEGER);
    for (const leaf of LEAVES) {
      const unit = unitOf(dir, leaf);
      expect(unit.evidences).toHaveLength(1);
      expect(unit.verifyRuns).toHaveLength(1);
    }
  });

  it("A6-3 修复通道恢复：修掉挂测试（root worktree 落修复 commit）重跑集成 → pass → root verified，drift 维度消失", async () => {
    const { repoDir: dir } = chain();
    // 处置出口：集成锚 root 分支 HEAD（wt-4 J2）——修复必须落到 cw-root/<rootId> 检出的
    // worktree（u8-e2e 受控修复同款形态）；首败即转后无自动重试，人工/designer 窗口修复
    const rootWorktree = worktreePath(WT_HOME, dir, ROOT_ID);
    expect(existsSync(rootWorktree)).toBe(true);
    rmSync(join(rootWorktree, "packages", "lib", "broken.test.ts"));
    gitRun(rootWorktree, ["add", "-A"]);
    gitRun(rootWorktree, ["commit", "-m", "fix: 移除既有挂测试（integrationDrift 处置）"]);

    secondIntegrate = await integrateLikeLoop(dir);
    expect(secondIntegrate.result.ok, secondIntegrate.result.failures.join("\n")).toBe(true);

    // 闭环而非死局：pass VerifyRan 清连续 fail 计数 → root verified，drift 维度消失
    const statusJson = runCli(dir, ["status", "--json"]);
    expect(statusJson.code, statusJson.stderr).toBe(0);
    const parsed = JSON.parse(statusJson.stdout) as { units: Array<{ unitId: string; status: string }> };
    expect(parsed.units.find((u) => u.unitId === ROOT_ID)?.status).toBe("verified");
    const frontier = runCli(dir, ["frontier", "--json"]);
    expect(frontier.code, frontier.stderr).toBe(0);
    const groups = JSON.parse(frontier.stdout) as Record<string, string[]>;
    expect(groups.integrationDrift).not.toContain(ROOT_ID);

    // 集成 run 序列 [fail, pass]；pass 轮覆盖集含 R1（回归绿同样只在集成执行点复验）
    expect(verifyRunsOf(dir, ROOT_ID).map((run) => run.result)).toEqual(["fail", "pass"]);
    expect(secondIntegrate.payload.acceptanceIds).toContain("R1");
    // 修复后的 R1 产物：PASS 标记（漂移出口恢复的产物级实证）
    const fixedBatchDir = join(evidenceDir(cwHome, dir, ROOT_ID, secondIntegrate.result.runId), ROOT_ID);
    expect(readFileSync(join(fixedBatchDir, "R1.stdout"), "utf-8")).toContain("R1 PASS");
  }, 300_000);
});

/**
 * fx-2 loop 级回归（docs/rewrite/acceptance/fx-2-acceptance.md R4a/R4b，4 条）：
 * 集成层死锁修复——连续集成 fail 重派上限 + designer 契约漂移处置出口 + idle
 * 兜底恢复有界。直调 dist 的 runLoop + 测试专用适配器 spawn 真实 node 子进程
 * （worker 由本文件生成，经 dist EventLedger 对真实账本写入，u7/u8/fx1 同款
 * 基建，零 mock）。
 *
 * fixture 语义与终验 R4 现场同构：leaf 实现 `export async function renderMarkdown(`
 * 而 root spec 契约 C1 signature=`export function renderMarkdown(`（async 修饰差异
 * 使字节级包含比对确定性不命中）；leaf/root 验收命令全绿 → 集成 fail 只来自契约
 * 比对，failures 干净可断言。
 *
 *   1. fail 1 次 → 重派集成（fx-1/u8 既有行为不回退：第 2 次集成真实发生）
 *   2. 连续 fail 2 次 → 不再有第 3 次集成；派 designer 且 brief 含契约清单与
 *      两条处置路径
 *   3. designer 重提修正契约的 spec 过审 → 集成重跑且计数清零 → root closed 全链
 *   4. 上限后无人应答 brief（noop designer）→ 账本无新事件 → maxIdleMs 内
 *      exit 1（不无限循环；R4b 修复前集成审计事件每轮喂活 idle 判定永不触发）
 *
 * 注意：直接 `npx vitest run tests/fx2-integration-recovery.test.ts` 不触发
 * pretest，需先 `npm run build`（`npm test` 的 pretest 已含）。
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem, Contract, SplitEntry } from "../dist/events/types.js";
import { ledgerForCwd } from "../dist/handlers/common.js";
import { loadLedger, unitStatus } from "../dist/readonly/load.js";
import { runLoop } from "../dist/runner/loop.js";
import { spawnProcess } from "../dist/runner/spawn/lifecycle.js";
import type {
  AgentRole,
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
} from "../dist/runner/spawn/types.js";
import { encodeCwd } from "../dist/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
if (!existsSync(join(DIST_ROOT, "runner", "loop.js"))) {
  throw new Error("tests/fx2-integration-recovery 需要 dist/（先 npm run build；npm test 的 pretest 已含）");
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fx2-int-"));
// 测试进程与 worker 子进程共享同一 CW_HOME（worker 经 env 继承定位账本）
process.env.CW_HOME = join(tmpRoot, "cw-home");
// wt-2 迁移：派发 workdir 迁 unit worktree，隔离 worktree 根（与 CW_HOME 同款）
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

/**
 * fx-4：本 root 的 topic run 目录（<cwHome>/topic/<encoded>/<runTs>-<rootId>[-N]）。
 * 单 run 场景下唯一（runLoop 启动建一次）；不唯一即抛（fixture 前置失败，非断言目标）。
 */
function findTopicDir(home: string, cwd: string, rootId: string): string {
  const topicRoot = join(home, "topic", encodeCwd(cwd));
  const entries = existsSync(topicRoot) ? readdirSync(topicRoot).sort() : [];
  const hits = entries.filter((name) => name.endsWith(`-${rootId}`) || name.includes(`-${rootId}-`));
  if (hits.length !== 1) {
    throw new Error(`topic run 目录不唯一（rootId=${rootId}）：${hits.join(", ") || "(无)"}`);
  }
  return join(topicRoot, hits[0]!);
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ROOT_ID = "feat";
const LEAF_ID = "leaf";
const CONTRACT_SIGNATURE = "export function renderMarkdown(";
const CONTRACT_SIGNATURE_FIXED = "export async function renderMarkdown(";

/** 过 gate 全规则的合法验收（e2e 命令首 token=node 必在 PATH；unit 冒烟走 vitest JSON 口径） */
function unitSmoke(id: string): AcceptanceItem {
  return {
    id,
    core: false,
    title: `${id} 单元级冒烟`,
    type: "unit",
    command:
      `node -e "console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'${id} smoke',status:'passed'}]}]}))" -- --reporter=json`,
  };
}

const LEAF_ACCEPTANCE: readonly AcceptanceItem[] = [
  { id: "AL1", core: true, title: "renderMarkdown 可用", type: "e2e-real", command: "node scripts/check-render.js" },
  unitSmoke("AL2"),
];
const ROOT_ACCEPTANCE: readonly AcceptanceItem[] = [
  { id: "AR1", core: true, title: "渲染链路可用", type: "e2e-real", command: "node scripts/check-root.js" },
  unitSmoke("AR2"),
];

// ---- 测试专用 worker（真实 node 子进程） ----

/**
 * argv: <role> <unitId> <cwd> <mode> <briefPath>
 * mode=noop：designer 不写任何事件（模拟无人应答 brief——R4b idle 兜底场景）。
 * mode=contract-fix：designer 重提修正契约签名（async 差异）的 spec
 * （R4a 处置路径①：实现与契约语义等价但文本不等 → 修 spec 走重新过审链）。
 * mx-1：designer 不自审——重提后由独立 reviewer 分支按 unit 现状过审
 * （幂等：最后一条 spec 契约已含 async 时不再重复提交）。
 * reviewer：created（spec 待审）→ spec-review pass；verified → exec-review pass。
 */
function writeWorkerScript(): string {
  const script = `// tests/fx2-integration-recovery.test.ts 生成的测试专用 agent worker（真实进程，非 mock）
import { createHash } from "node:crypto";
const DIST = ${JSON.stringify(DIST_ROOT)};
const [role, unitId, cwd, mode] = process.argv.slice(2);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const { ledgerForCwd } = await import(DIST + "/handlers/common.js");
const { loadLedger, unitStatus } = await import(DIST + "/readonly/load.js");
console.log("fx2-worker " + role + " " + unitId + " mode=" + mode + " pid=" + process.pid);

if (role === "designer" && mode === "noop") {
  console.log("fx2-worker-done noop（不写事件）");
} else if (role === "designer" && mode === "contract-fix") {
  const unit = loadLedger(cwd).projection.units.get(unitId);
  const lastSpec = unit?.specs[unit.specs.length - 1];
  if (lastSpec === undefined) throw new Error("fx2-worker: unit " + unitId + " 无 spec");
  const alreadyFixed = (lastSpec.contracts[0]?.signature ?? "").includes("async");
  if (!alreadyFixed) {
    const contracts = lastSpec.contracts.map((c) => ({
      ...c,
      signature: c.signature.replace("export function", "export async function"),
    }));
    const spec = { acceptance: lastSpec.acceptance, contracts, split: lastSpec.split };
    ledgerForCwd(cwd).append("SpecSubmitted", {
      unitId,
      specHash: sha(JSON.stringify(spec)),
      acceptance: lastSpec.acceptance,
      contracts,
      split: lastSpec.split,
    });
  }
  console.log("fx2-worker-done contract-fix " + unitId);
} else if (role === "reviewer") {
  const unit = loadLedger(cwd).projection.units.get(unitId);
  if (unit === undefined) throw new Error("fx2-worker: unit " + unitId + " 不在账本");
  const kind = unitStatus(unit) === "verified" ? "exec-review" : "spec-review";
  ledgerForCwd(cwd).append("VerdictSubmitted", { unitId, verdictKind: kind, verdict: "pass", role: "reviewer" });
  console.log("fx2-worker-done reviewer " + kind + " " + unitId);
} else {
  throw new Error("fx2-worker: 未知组合 role=" + role + " mode=" + mode);
}
`;
  const path = join(tmpRoot, "fx2-worker.mjs");
  writeFileSync(path, script);
  return path;
}

const WORKER_PATH = writeWorkerScript();

// ---- 测试专用适配器（spawnProcess 包装 + spawn 记录供断言） ----

interface SpawnRecord {
  role: AgentRole;
  unitId: string;
}

function makeScriptAdapter(opts: { mode: "noop" | "contract-fix" }): {
  adapter: AgentSpawnAdapter;
  spawned(): readonly SpawnRecord[];
} {
  const records: SpawnRecord[] = [];
  return {
    adapter: {
      name: "fx2-test-script",
      spawn: (req: AgentSpawnRequest): Promise<SpawnHandle> => {
        records.push({ role: req.role, unitId: req.unitId });
        return Promise.resolve(
          spawnProcess({
            command: process.execPath,
            // wt-2 迁移：worker 写账本锚定 projectCwd（等价 agent 的 CW_PROJECT_DIR 锚定）
            args: [WORKER_PATH, req.role, req.unitId, req.projectCwd, opts.mode],
            cwd: req.workdir,
            timeoutMs: req.timeoutMs,
            // fx-4：产物路径从 req.artifactDir 拼装（run 级 topic 目录）
            stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
            stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
          }),
        );
      },
    },
    spawned: () => records,
  };
}

// ---- fixture：async 契约漂移 repo + 预置账本（root spec-frozen + leaf closed） ----

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/**
 * 预置终验 R4 现场同构的账本：root "feat" spec-frozen（契约 C1 与 async 实现
 * 字节不匹配 → 集成确定性 fail；验收全绿）；leaf 已 closed（verified + 
 * exec-review）→ root 一进循环即触发集成。
 */
function seedDriftFixture(name: string): string {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-fx2@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-fx2"]);

  const files: Record<string, string> = {
    "package.json": '{"type":"module"}\n',
    "brief.md": "# fx2 fixture root 任务书\n",
    // async 实现与契约 signature 的差异 = 终验 R4a 根因现场（语义等价、文本不等）
    "src/renderer.js":
      "export async function renderMarkdown(s) {\n  return String(s).toUpperCase();\n}\n",
    "scripts/check-render.js": [
      "const { renderMarkdown } = await import('../src/renderer.js');",
      "const ok = (await renderMarkdown('x')) === 'X';",
      "console.log(`AL1 ${ok ? 'PASS' : 'FAIL'}`);",
      "process.exit(ok ? 0 : 1);",
      "",
    ].join("\n"),
    "scripts/check-root.js": [
      "const { renderMarkdown } = await import('../src/renderer.js');",
      "const ok = (await renderMarkdown('hello')) === 'HELLO';",
      "console.log(`AR1 ${ok ? 'PASS' : 'FAIL'}`);",
      "process.exit(ok ? 0 : 1);",
      "",
    ].join("\n"),
  };
  for (const [name_, content] of Object.entries(files)) {
    const dirPart = name_.slice(0, name_.lastIndexOf("/"));
    if (dirPart !== "") {
      mkdirSync(join(repoDir, dirPart), { recursive: true });
    }
    writeFileSync(join(repoDir, name_), content);
  }
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: async renderer + check scripts"]);
  const head = gitRun(repoDir, ["rev-parse", "HEAD"]);

  const ledger = ledgerForCwd(repoDir);
  // rv-4 契约配对化迁移：leaf 冻结同 id 契约 C1（self-provider，async 版签名 =
  // 实现真身）。root 契约仍非 async → 配对第一道（consumer ≡ provider 冻结）
  // 确定性 fail；树内 leaf 版命中（组过）——fail 只来自配对，语义内核与 fx-2
  // 时代的「async 实现与冻结签名字节不匹配」同构
  const contract: Contract = {
    id: "C1",
    kind: "function",
    provider: LEAF_ID,
    consumer: ROOT_ID,
    signature: CONTRACT_SIGNATURE,
    file: "src/renderer.js",
    description: "root 期望的 renderMarkdown 签名（与 leaf 冻结版一字差）",
  };
  const leafContract: Contract = {
    id: "C1",
    kind: "function",
    provider: LEAF_ID,
    consumer: ROOT_ID,
    signature: CONTRACT_SIGNATURE_FIXED,
    file: "src/renderer.js",
    description: "leaf 冻结的提供承诺（async 实现真身）",
  };
  const split: SplitEntry[] = [{ unitId: LEAF_ID, dependsOn: [] }];
  const appendSpec = (unitId: string, acceptance: readonly AcceptanceItem[], contracts: Contract[], specSplit: SplitEntry[]) => {
    const spec = { acceptance, contracts, split: specSplit };
    ledger.append("SpecSubmitted", {
      unitId,
      specHash: sha(JSON.stringify(spec)),
      acceptance: [...acceptance],
      contracts,
      split: specSplit,
    });
  };

  ledger.append("UnitCreated", { unitId: ROOT_ID, parentId: null, briefRef: join(repoDir, "brief.md") });
  appendSpec(ROOT_ID, ROOT_ACCEPTANCE, [contract], split);
  ledger.append("VerdictSubmitted", { unitId: ROOT_ID, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });

  ledger.append("UnitCreated", { unitId: LEAF_ID, parentId: ROOT_ID, briefRef: join(repoDir, "brief.md") });
  appendSpec(LEAF_ID, LEAF_ACCEPTANCE, [leafContract], []);
  ledger.append("VerdictSubmitted", { unitId: LEAF_ID, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
  const runId = `run-${LEAF_ID}-1`;
  ledger.append("EvidenceSubmitted", {
    unitId: LEAF_ID,
    runId,
    commit: head,
    paths: ["src/renderer.js"],
    sha256: [sha("src/renderer.js")],
    exitCode: 0,
  });
  ledger.append("VerifyRan", {
    unitId: LEAF_ID,
    runId,
    reportHash: sha(`evidence-report:${runId}`),
    result: "pass",
    acceptanceIds: LEAF_ACCEPTANCE.map((ac) => ac.id),
  });
  ledger.append("VerdictSubmitted", { unitId: LEAF_ID, verdictKind: "exec-review", verdict: "pass" });
  return repoDir;
}

// ---- 断言辅助 ----

function statusOf(repoDir: string, unitId: string): string {
  const unit = loadLedger(repoDir).projection.units.get(unitId);
  if (unit === undefined) {
    throw new Error(`unit ${unitId} 不在账本（fixture 断言前置失败）`);
  }
  return unitStatus(unit);
}

/** root 的集成 VerifyRan 序列（预置的 leaf pass 不在其列） */
function integrateRunsOf(repoDir: string): Array<{ runId: string; result: string }> {
  const unit = loadLedger(repoDir).projection.units.get(ROOT_ID);
  return (unit?.verifyRuns ?? [])
    .filter((run) => run.runId.startsWith("integrate-"))
    .map((run) => ({ runId: run.runId, result: run.result }));
}

/** 捕获 runLoop 的 stdout/stderr（进程内直调；worker 输出走文件不受影响） */
async function captureStd(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const collector = (chunks: string[]): typeof process.stdout.write =>
    ((chunk: unknown, cb?: (err?: Error | null) => void) => {
      chunks.push(String(chunk));
      // 透传回调：loop.ts 的 flushOutputs 退出屏障依赖 write 回调等待 flush，
      // 不透传会使其落入兜底超时，拖慢每个 runLoop 退出
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

// ================================================================
// 回归 1：首 fail 即停（rv-4 语义迁移：MAX=1，不再自动重派集成）
// ================================================================

describe("fx-2 R4a 回归1（rv-4 语义迁移）：fail 1 次即达上限 → 不再有第 2 次自动集成，转派 designer", () => {
  it("首次集成 fail 后下轮即派 designer（integrationDrift），账本只 1 条 fail 集成审计（fx-2 时代的第 2 次自动重试语义作废）", async () => {
    const repoDir = seedDriftFixture("reg1-resubmit");
    const script = makeScriptAdapter({ mode: "noop" });

    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 6_000 }),
    );

    // noop designer 不推进 → 最终 idle exit 1（既有兜底语义，附带有界性证明）
    expect(captured.code).toBe(1);
    const runs = integrateRunsOf(repoDir);
    // rv-4 语义迁移（MAX=1）：首次 fail 即转 drift——恰 1 次集成，无第 2 次
    expect(runs.length).toBe(1);
    expect(runs.map((r) => r.result)).toEqual(["fail"]);
    // 首 fail 后下轮派 designer 处置（不再重派集成）
    expect(script.spawned().some((r) => r.role === "designer" && r.unitId === ROOT_ID)).toBe(true);
    expect(statusOf(repoDir, ROOT_ID)).toBe("spec-frozen");
  }, 30_000);
});

// ================================================================
// 回归 2：首 fail 达上限（rv-4：MAX=1）→ 停止集成、派 designer、brief 内容
// ================================================================

describe("fx-2 R4a 回归2（rv-4 语义迁移：上限 1 次）：首 fail 达上限 → 派 designer 处置契约漂移", () => {
  it("不再有第 2 次集成；designer 收到的 brief 含契约清单与两条处置路径", async () => {
    const repoDir = seedDriftFixture("reg2-cap-brief");
    const script = makeScriptAdapter({ mode: "noop" });

    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 5_000 }),
    );

    expect(captured.code).toBe(1);
    // rv-4 语义迁移（MAX=1）：恰 1 次集成即达上限（fail 审计不再无限入账 = R4b 前提）
    const runs = integrateRunsOf(repoDir);
    expect(runs.length).toBe(1);
    // designer 被派发（上限出口），且 runner 明示停止自动重派
    expect(script.spawned().some((r) => r.role === "designer" && r.unitId === ROOT_ID)).toBe(true);
    expect(captured.out).toContain("集成连续 fail 达上限");
    expect(captured.out).toContain("停止自动重派集成");

    // brief = 契约漂移处置任务书：契约清单（id + signature + 期望 file）+ 失败验收 + 二选一
    //（fx-4 迁移：brief 落盘在 run 级 topic 目录）
    const brief = readFileSync(
      join(findTopicDir(process.env.CW_HOME ?? "", repoDir, ROOT_ID), `${ROOT_ID}.designer.brief.md`),
      "utf-8",
    );
    expect(brief).toContain("集成契约漂移处置");
    // rv-4 语义迁移：上限 2 → 1（「连续 fail 2 次」断言随常量改写）
    expect(brief).toContain("连续 fail 1 次");
    expect(brief).toContain("C1");
    expect(brief).toContain(CONTRACT_SIGNATURE);
    expect(brief).toContain("src/renderer.js");
    expect(brief).toContain("失败验收：无（验收批次全绿，fail 全部来自契约比对）");
    // 处置路径①（mx-1 语义迁移）：修 spec 重提的命令原文可照抄执行；过审半边改由
    // 独立 reviewer 承载——任务书不再教 designer 自行 review submit（A2 精神：
    // designer 任务书全文不含 review submit 字样）
    expect(brief).toContain(`cw evidence submit --kind spec --unit ${ROOT_ID} --file spec.json`);
    expect(brief).toContain("由 loop 自动派发独立 reviewer 执行 spec-review");
    expect(brief).not.toContain("review submit");
    // 处置路径②：provider 修复 + 已知边界如实告知（closed 无自动回退通道）
    expect(brief).toContain("closed 的 provider 无自动回退通道");
    expect(brief).toContain("人工介入");
    // 集成失败汇总（integrate.ts failures）带同款二选一文案（stderr 透传）
    expect(captured.err).toContain("集成失败恢复路径（二选一）");
  }, 30_000);
});

// ================================================================
// 回归 3：designer 处置（重提修正契约的 spec 过审）→ 计数清零 → 全链 closed
// ================================================================

describe("fx-2 R4a 回归3（rv-4 语义迁移：处置链路不变）：designer 修契约重过审 → 集成重跑且计数清零 → root closed", () => {
  it("首次集成 fail → drift 派 designer 修正契约 → 第 2 次集成（新 spec 下首次）pass → verified → exec-review → closed 全链", async () => {
    const repoDir = seedDriftFixture("reg3-recover");
    const script = makeScriptAdapter({ mode: "contract-fix" });

    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 20_000 }),
    );

    expect(captured.code).toBe(0);
    expect(statusOf(repoDir, ROOT_ID)).toBe("closed");
    expect(statusOf(repoDir, LEAF_ID)).toBe("closed");

    // 集成序列 = fail, pass（rv-4 语义迁移：MAX=1 时代是 fail, fail, pass）：
    // 首次 fail 撞上限 → designer 重提 spec（计数清零）→ 集成按正常路径重跑，
    // 第 2 次在新契约（root ≡ leaf 冻结的 async 版）下 pass
    const runs = integrateRunsOf(repoDir);
    expect(runs.map((r) => r.result)).toEqual(["fail", "pass"]);

    // designer 处置真实入账：重提的 spec 契约签名已修正（async 差异消除）
    const feat = loadLedger(repoDir).projection.units.get(ROOT_ID);
    expect(feat?.specs.length).toBeGreaterThanOrEqual(2);
    expect(feat?.specs[feat.specs.length - 1]?.contracts[0]?.signature).toBe(CONTRACT_SIGNATURE_FIXED);

    // 派发形态：designer 处置 + root 的 exec-review reviewer；全程无 builder
    const roles = script.spawned().map((r) => r.role);
    expect(roles[0]).toBe("designer");
    expect(roles).toContain("reviewer");
    expect(roles).not.toContain("builder");
  }, 60_000);
});

// ================================================================
// 回归 4：上限后无人推进 → maxIdleMs 内 exit 1（R4b 有界退出）
// ================================================================

describe("fx-2 R4b 回归4：上限后无人应答 brief → maxIdleMs 正常触发 exit 1", () => {
  it("noop designer 不写事件 → 集成审计不再喂活 idle 判定 → maxIdleMs=3000ms 内 exit 1（不无限循环）", async () => {
    const repoDir = seedDriftFixture("reg4-idle-bounded");
    const script = makeScriptAdapter({ mode: "noop" });
    const maxIdleMs = 3_000;

    const startedAt = Date.now();
    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs }),
    );
    const elapsed = Date.now() - startedAt;

    expect(captured.code).toBe(1);
    expect(captured.err).toContain("无账本进展");
    // 修复前（R4b）：集成每轮写 fail VerifyRan → totalEvents 持续推进 → idle
    // 永不触发 = 无限循环；上限停止集成 → idle 正常到期。
    // rv-4 语义迁移（MAX=1）：恰 1 次集成即停（fx-2 时代为 2 次）
    expect(integrateRunsOf(repoDir).length).toBe(1);
    expect(script.spawned().some((r) => r.role === "designer")).toBe(true);
    // 有界性：1 轮集成（干净 checkout + 4 条验收）+ 3s idle，留足余量上限
    expect(elapsed).toBeLessThan(20_000);
    expect(statusOf(repoDir, ROOT_ID)).toBe("spec-frozen");
  }, 60_000);
});

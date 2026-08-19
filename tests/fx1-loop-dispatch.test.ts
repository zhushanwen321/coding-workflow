/**
 * fx-1 loop 级回归（docs/rewrite/acceptance/fx-1-acceptance.md R1.3 / R2.2）：
 * 调度循环的两个死锁修复点，直调 dist 的 runLoop + 测试专用适配器 spawn 真实
 * node 子进程（worker 脚本由本文件生成，经 dist EventLedger 对真实账本写入，
 * u7 同款基建，零 mock）。
 *
 * - R1.3：账本已存在自引用 spec（旁路写入/规则⑥生效前的坏账本）→ 循环不死锁——
 *   mx-1 起派独立 reviewer（specReviewPending），reviewer 判 fail（gate 规则⑥）
 *   → specFixPending 派 designer 修正 spec 重提 → reviewer 再审 pass → 全链
 *   收敛 closed（修复前：无任何派发目标，maxIdleMs 兜底 exit 1）。
 * - R2.2：developer 重提 spec（spec×2）后无过审 → 派独立 reviewer 审 spec（brief
 *   为 spec-review 任务书，不含「撰写 spec」指令），过审后全链收敛 closed
 *   （修复前：created + specs>0 是派发真空，同样 idle exit 1）。
 *
 * 注意：直接 `npx vitest run tests/fx1-loop-dispatch.test.ts` 不触发 pretest，
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

import type { AcceptanceItem, SplitEntry } from "../dist/events/types.js";
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

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
if (!existsSync(join(DIST_ROOT, "runner", "loop.js"))) {
  throw new Error("tests/fx1-loop-dispatch 需要 dist/（先 npm run build；npm test 的 pretest 已含）");
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fx1-loop-"));
// 测试进程与 worker 子进程共享同一 CW_HOME（worker 经 env 继承定位账本）
process.env.CW_HOME = join(tmpRoot, "cw-home");
// wt-2 迁移：派发 workdir 迁 unit worktree，隔离 worktree 根（与 CW_HOME 同款）
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** 过 gate 全规则的合法验收（command 用 node，PATH 必可解析） */
const ACCEPTANCE: readonly AcceptanceItem[] = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
];

// ---- 测试专用 worker（真实 node 子进程；mx-1 起 spec-review 由 reviewer 提交） ----

/**
 * argv: <role> <unitId> <cwd> <mode> <commit> <briefPath>
 * mode=fix：designer 重提修正后的 spec（split 置空，R1 自引用坏 spec 的处置）。
 *   mx-1：不自审——重提后由独立 reviewer 再审。
 * reviewer：按 unit 现状判定——最后 spec 的 split 自引用（gate 规则⑥必挂）→
 *   spec-review fail（comment 含不合格项）；verified → exec-review pass；
 *   其余（spec 待审且干净）→ spec-review pass。
 */
function writeWorkerScript(): string {
  const script = `// tests/fx1-loop-dispatch.test.ts 生成的测试专用 agent worker（真实进程，非 mock）
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const DIST = ${JSON.stringify(DIST_ROOT)};
const [role, unitId, cwd, mode, commit, briefPath] = process.argv.slice(2);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const { ledgerForCwd } = await import(DIST + "/handlers/common.js");
const { loadLedger } = await import(DIST + "/readonly/load.js");
const { unitStatus } = await import(DIST + "/readonly/load.js");

let briefHead = "(unreadable)";
try {
  briefHead = (readFileSync(briefPath, "utf-8").split("\\n")[0] ?? "");
} catch {}
console.log("fx1-worker " + role + " " + unitId + " pid=" + process.pid + " brief-head=" + briefHead);

const ACCEPTANCE = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
];

if (role === "designer" && mode === "fix") {
  const ledger = ledgerForCwd(cwd);
  const specHash = sha(JSON.stringify({ acceptance: ACCEPTANCE, contracts: [], split: [] }));
  ledger.append("SpecSubmitted", { unitId, specHash, acceptance: ACCEPTANCE, contracts: [], split: [] });
  console.log("fx1-worker-done designer-fix " + unitId);
} else if (role === "developer") {
  const unit = loadLedger(cwd).projection.units.get(unitId);
  if (unit === undefined || unit.specs.length === 0) throw new Error("developer: unit " + unitId + " 无 spec");
  const acceptanceIds = unit.specs[unit.specs.length - 1].acceptance.map((a) => a.id);
  const runId = "run-" + unitId + "-" + Date.now();
  const ledger = ledgerForCwd(cwd);
  ledger.append("EvidenceSubmitted", { unitId, runId, commit, paths: ["app.js"], sha256: [sha("app.js")], exitCode: 0 });
  ledger.append("VerifyRan", { unitId, runId, reportHash: sha("evidence-report:" + runId), result: "pass", acceptanceIds });
  console.log("fx1-worker-done developer " + unitId);
} else if (role === "reviewer") {
  const unit = loadLedger(cwd).projection.units.get(unitId);
  if (unit === undefined) throw new Error("reviewer: unit " + unitId + " 不在账本");
  const status = unitStatus(unit);
  if (status === "verified") {
    ledgerForCwd(cwd).append("VerdictSubmitted", { unitId, verdictKind: "exec-review", verdict: "pass", role: "reviewer" });
    console.log("fx1-worker-done reviewer exec-review " + unitId);
  } else {
    const selfRef = (unit.specs[unit.specs.length - 1]?.split ?? []).some((e) => e.unitId === unitId);
    const verdict = selfRef ? "fail" : "pass";
    const comment = selfRef ? "不合格项：spec.split 自引用（gate 规则⑥）——恢复动作：去掉自引用条目后重提 spec" : undefined;
    ledgerForCwd(cwd).append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict, role: "reviewer", ...(comment ? { comment } : {}) });
    console.log("fx1-worker-done reviewer spec-review " + verdict + " " + unitId);
  }
} else {
  throw new Error("fx1-worker: 未知组合 role=" + role + " mode=" + mode);
}
`;
  const path = join(tmpRoot, "fx1-worker.mjs");
  writeFileSync(path, script);
  return path;
}

const WORKER_PATH = writeWorkerScript();

// ---- 测试专用适配器（spawnProcess 包装 + spawn 记录供断言） ----

interface SpawnRecord {
  role: AgentRole;
  unitId: string;
  briefPath: string;
  /** wt-2 迁移：派发时刻的 brief 内容快照（同 unit 换角色重派时 clean -fd 清上一轮 untracked 产物） */
  briefContent: string;
}

function makeScriptAdapter(opts: { mode: "fix"; commit: string }): {
  adapter: AgentSpawnAdapter;
  spawned(): readonly SpawnRecord[];
} {
  const records: SpawnRecord[] = [];
  return {
    adapter: {
      name: "fx1-test-script",
      spawn: (req: AgentSpawnRequest): Promise<SpawnHandle> => {
        // wt-2 迁移：内容断言在派发时点取快照（循环结束后早轮 brief 已被后续重派的 reset 清掉）
        const briefContent = existsSync(req.briefPath) ? readFileSync(req.briefPath, "utf-8") : "(missing)";
        records.push({ role: req.role, unitId: req.unitId, briefPath: req.briefPath, briefContent });
        return Promise.resolve(
          spawnProcess({
            command: process.execPath,
            // wt-2 迁移：worker 写账本锚定 projectCwd（等价 agent 的 CW_PROJECT_DIR 锚定）
            args: [WORKER_PATH, req.role, req.unitId, req.projectCwd, opts.mode, opts.commit, req.briefPath],
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

// ---- fixture 基建（真实 git repo + 真实账本直写） ----

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

function makeRepo(name: string): { repoDir: string; head: string } {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-fx1@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-fx1"]);
  writeFileSync(join(repoDir, "brief.md"), "# fx1 fixture 任务书\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  return { repoDir, head: gitRun(repoDir, ["rev-parse", "HEAD"]) };
}

function appendUnitCreated(repoDir: string, unitId: string): void {
  ledgerForCwd(repoDir).append("UnitCreated", {
    unitId,
    parentId: null,
    briefRef: join(repoDir, "brief.md"),
  });
}

function appendSpec(repoDir: string, unitId: string, split: readonly SplitEntry[]): void {
  const spec = { acceptance: ACCEPTANCE, contracts: [], split };
  ledgerForCwd(repoDir).append("SpecSubmitted", {
    unitId,
    specHash: sha(JSON.stringify(spec)),
    acceptance: [...ACCEPTANCE],
    contracts: [],
    split: [...split],
  });
}

function statusOf(repoDir: string, unitId: string): string {
  const unit = loadLedger(repoDir).projection.units.get(unitId);
  if (unit === undefined) {
    throw new Error(`unit ${unitId} 不在账本（fixture 断言前置失败）`);
  }
  return unitStatus(unit);
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

// ---- R1.3：自引用 spec 不死锁（loop 级防御 + 第四分支协同） ----

describe("fx-1 R1.3 loop 级（mx-1 形态）：账本已有自引用 spec → 不死锁，正常派发至收敛", () => {
  it("自引用 spec（无过审）→ reviewer 判 fail → designer 修正 spec 重提 → reviewer 再审 pass → 全链 closed", async () => {
    const { repoDir, head } = makeRepo("r1-selfref");
    appendUnitCreated(repoDir, "selfref");
    // 旁路写入的自引用 spec（规则⑥生效前的坏账本同款；未过审）
    appendSpec(repoDir, "selfref", [{ unitId: "selfref", dependsOn: [] }]);
    expect(statusOf(repoDir, "selfref")).toBe("created"); // gate 规则⑥：到不了 spec-frozen

    const script = makeScriptAdapter({ mode: "fix", commit: head });
    const captured = await captureStd(() =>
      runLoop({ rootId: "selfref", adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 15_000 }),
    );

    // 修复前：无派发目标（created+specs>0 真空 / 自引用内部节点死等）→ maxIdleMs exit 1
    expect(captured.code).toBe(0);
    expect(statusOf(repoDir, "selfref")).toBe("closed");
    // mx-1 派发形态：reviewer 首审（fail）→ designer 修 spec → reviewer 再审
    //（pass）→ developer → reviewer（exec-review）
    expect(script.spawned().map((r) => r.role)).toEqual([
      "reviewer",
      "designer",
      "reviewer",
      "developer",
      "reviewer",
    ]);
    // spec-review reviewer 任务书（而非「撰写 spec」任务书）落到 reviewer 手里
    const reviewerBrief =
      script
        .spawned()
        .filter((r) => r.role === "reviewer")
        .map((r) => r.briefContent)[0] ?? "(missing)";
    expect(reviewerBrief).toContain("--verdict-kind spec-review");
    expect(reviewerBrief).not.toContain("撰写该 unit 的 spec.json");
    // designer 收到的是 specFixPending 修 spec 任务书：内嵌 fail comment 全文
    const designerBrief =
      script
        .spawned()
        .filter((r) => r.role === "designer")
        .map((r) => r.briefContent)[0] ?? "(missing)";
    expect(designerBrief).toContain("按 spec-review 打回意见修 spec");
    expect(designerBrief).toContain("spec.split 自引用（gate 规则⑥）");
    expect(designerBrief).not.toContain("review submit");
  }, 30_000);
});

// ---- R2.2：重提 spec 后派独立 reviewer 审 spec（specReviewPending 形态） ----

describe("fx-1 R2.2 loop 级（mx-1 形态）：重提 spec 后无过审 → 派独立 reviewer 审 spec", () => {
  it("spec×2（developer 重提）且最后一条 spec 后无 verdict → 首个派发即 reviewer，过审后全链 closed", async () => {
    const { repoDir, head } = makeRepo("r2-resubmit");
    appendUnitCreated(repoDir, "u");
    appendSpec(repoDir, "u", []); // spec1（初版）
    ledgerForCwd(repoDir).append("VerdictSubmitted", { unitId: "u", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    appendSpec(repoDir, "u", []); // spec2（developer 重提——终验 seq13 同款状态）
    expect(statusOf(repoDir, "u")).toBe("created"); // 重提 = 打回重审，旧 pass 不计数

    const script = makeScriptAdapter({ mode: "fix", commit: head });
    const captured = await captureStd(() =>
      runLoop({ rootId: "u", adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 15_000 }),
    );

    // 修复前：created + specs>0 无分支覆盖 → 零派发，maxIdleMs 兜底 exit 1
    expect(captured.code).toBe(0);
    expect(statusOf(repoDir, "u")).toBe("closed");
    // mx-1：spec-review 由独立 reviewer spawn 提交（designer 不再补审自审）
    expect(script.spawned().map((r) => r.role)).toEqual(["reviewer", "developer", "reviewer"]);
    // spec-review 任务书（而非「撰写 spec」任务书）落到 reviewer 手里
    const brief =
      script
        .spawned()
        .filter((r) => r.role === "reviewer")
        .map((r) => r.briefContent)[0] ?? "(missing)";
    expect(brief).toContain("--verdict-kind spec-review");
    expect(brief).not.toContain("撰写该 unit 的 spec.json");
  }, 30_000);
});

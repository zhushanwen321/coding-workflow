/**
 * fx-3 单测 R5.2 / R5.3 / 全链（docs/rewrite/acceptance/fx-3-acceptance.md 回归 3/4/5）。
 * 直调 dist 的 runLoop + 测试专用适配器 spawn 真实 node 子进程（worker 脚本由本
 * 文件生成，经 dist EventLedger / dispatch 对真实账本写入，u7/fx1/fx2 同款基建，
 * 零 mock）。
 *
 *   3. R5.2：root 无子时 designer 首派 brief 含第 0 步建子指令（含 cw create
 *      模板）；root 已有子 → 不含第 0 步。
 *   4. R5.3：spec-frozen + split 子未建 → 派 designer（brief 含缺失清单与逐个
 *      create 命令）；测试进程补 create 后 → root 不再被兜底派发，转正常轨道
 *      （子 designer 首派 / root 集成等待）。
 *   5. 全链复现终验第 3 次现场（root created、零派发障碍解除）：runLoop 派
 *      designer → worker 按 brief 第 0 步真实走 dispatch create 建两子 →
 *      evidence submit 提 root spec（R5.1 真实校验通过）→ 子链推进 → root
 *      集成 → 全树 closed，exit 0。修复前该现场零派发目标，空转至 maxIdleMs
 *      exit 1（终验第 3 次 45 分钟空转根因）。
 *
 * 注意：直接 `npx vitest run tests/fx3-loop-split-dispatch.test.ts` 不触发 pretest，
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
  throw new Error("tests/fx3-loop-split-dispatch 需要 dist/（先 npm run build；npm test 的 pretest 已含）");
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fx3-loop-"));
// 测试进程与 worker 子进程共享同一 CW_HOME（worker 经 env 继承定位账本）
process.env.CW_HOME = join(tmpRoot, "cw-home");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ROOT_ID = "demo";
const LEAF_IDS = ["leaf-a", "leaf-b"] as const;

/** 过 gate 全规则的合法验收（e2e 命令在 fixture repo HEAD 上真实可过；unit 冒烟走 vitest JSON 口径） */
const ACCEPTANCE: readonly AcceptanceItem[] = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  {
    id: "A2",
    core: false,
    title: "单元级冒烟",
    type: "unit",
    command:
      "node -e \"console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'A2 unit smoke',status:'passed'}]}]}))\" -- --reporter=json",
  },
];

// ---- 测试专用 worker（真实 node 子进程） ----

/**
 * argv: <role> <unitId> <cwd> <mode> <commit> <briefPath>
 * mode=idle：挂住不写账本（R5.2/R5.3 判定窗口——brief 已落盘即可断言）。
 * mode=work：按 role 全程推进（全链）。designer 首派时 root 场景先按 brief
 * 第 0 步真实走 dispatch create 建两子（占位 brief 文件），再经 dispatch 提交
 * spec（R5.1 校验真实走通）与 spec-review——完整复现终验现场修复后的 agent 行为。
 */
function writeWorkerScript(): string {
  const script = `// tests/fx3-loop-split-dispatch.test.ts 生成的测试专用 agent worker（真实进程，非 mock）
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const DIST = ${JSON.stringify(DIST_ROOT)};
const ROOT_ID = ${JSON.stringify(ROOT_ID)};
const LEAF_IDS = ${JSON.stringify([...LEAF_IDS])};
const [role, unitId, cwd, mode, commit, briefPath] = process.argv.slice(2);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const { dispatch } = await import(DIST + "/dispatch.js");
const { ledgerForCwd } = await import(DIST + "/handlers/common.js");
const { loadLedger } = await import(DIST + "/readonly/load.js");

let briefHead = "(unreadable)";
try {
  briefHead = (readFileSync(briefPath, "utf-8").split("\\n")[0] ?? "");
} catch {}
console.log("fx3-worker " + role + " " + unitId + " mode=" + mode + " pid=" + process.pid + " brief-head=" + briefHead);

const ACCEPTANCE = ${JSON.stringify(ACCEPTANCE)};

const run = async (args) => {
  const code = await dispatch(args, cwd);
  if (code !== 0) throw new Error("fx3-worker: cw " + args.join(" ") + " exit " + code);
};

if (mode === "idle") {
  setInterval(() => {}, 1000); // 挂住：runLoop 的 kill 回收 + maxIdle 出口承担终止
} else if (role === "designer") {
  const unit = loadLedger(cwd).projection.units.get(unitId);
  if (unit === undefined) throw new Error("fx3-worker: unit " + unitId + " 不在账本");
  if (unit.specs.length === 0) {
    // 首派：root 且无子 → 执行 brief 第 0 步（fx-3 R5.2）：先建子后提 spec
    if (unitId === ROOT_ID) {
      for (const leafId of LEAF_IDS) {
        const briefName = "brief-" + leafId + ".md";
        writeFileSync(joinDir(cwd, briefName), "# " + leafId + " 子任务书（占位）\\n");
        await run(["create", "--id", leafId, "--brief", briefName, "--parent", ROOT_ID]);
      }
    }
    const split = unitId === ROOT_ID
      ? LEAF_IDS.map((leafId) => ({ unitId: leafId, briefRef: "brief-" + leafId + ".md", dependsOn: [] }))
      : [];
    const specName = "spec-" + unitId + ".json";
    writeFileSync(
      joinDir(cwd, specName),
      JSON.stringify({ acceptance: ACCEPTANCE, contracts: [], split }, null, 2),
    );
    await run(["evidence", "submit", "--kind", "spec", "--unit", unitId, "--file", specName]);
  }
  await run(["review", "submit", "--unit", unitId, "--verdict-kind", "spec-review", "--verdict", "pass"]);
  console.log("fx3-worker-done designer " + unitId);
} else if (role === "builder") {
  const unit = loadLedger(cwd).projection.units.get(unitId);
  if (unit === undefined || unit.specs.length === 0) throw new Error("fx3-worker: unit " + unitId + " 无 spec");
  const acceptanceIds = unit.specs[unit.specs.length - 1].acceptance.map((a) => a.id);
  const runId = "run-" + unitId + "-" + Date.now();
  const ledger = ledgerForCwd(cwd);
  ledger.append("EvidenceSubmitted", { unitId, runId, commit, paths: ["app.js"], sha256: [sha("app.js")], exitCode: 0 });
  ledger.append("VerifyRan", { unitId, runId, reportHash: sha("evidence-report:" + runId), result: "pass", acceptanceIds });
  console.log("fx3-worker-done builder " + unitId);
} else if (role === "reviewer") {
  ledgerForCwd(cwd).append("VerdictSubmitted", { unitId, verdictKind: "exec-review", verdict: "pass" });
  console.log("fx3-worker-done reviewer " + unitId);
} else {
  throw new Error("fx3-worker: 未知 role " + role);
}
function joinDir(dir, name) { return dir.endsWith("/") ? dir + name : dir + "/" + name; }
`;
  const path = join(tmpRoot, "fx3-worker.mjs");
  writeFileSync(path, script);
  return path;
}

const WORKER_PATH = writeWorkerScript();

// ---- 测试专用适配器（spawnProcess 包装 + spawn 记录供断言） ----

interface SpawnRecord {
  role: AgentRole;
  unitId: string;
}

function makeScriptAdapter(opts: { mode: "idle" | "work"; commit: string }): {
  adapter: AgentSpawnAdapter;
  spawned(): readonly SpawnRecord[];
} {
  const records: SpawnRecord[] = [];
  return {
    adapter: {
      name: "fx3-test-script",
      spawn: (req: AgentSpawnRequest): Promise<SpawnHandle> => {
        records.push({ role: req.role, unitId: req.unitId });
        return Promise.resolve(
          spawnProcess({
            command: process.execPath,
            args: [WORKER_PATH, req.role, req.unitId, req.workdir, opts.mode, opts.commit, req.briefPath],
            cwd: req.workdir,
            timeoutMs: req.timeoutMs,
            stdoutPath: join(req.workdir, ".cw-spawn", `${req.unitId}.${req.role}.stdout`),
            stderrPath: join(req.workdir, ".cw-spawn", `${req.unitId}.${req.role}.stderr`),
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

/**
 * 独立 repo：init + app.js（A1 验收命令的真实产物）+ brief + 一个真实 commit
 * （builder 证据的 commit hash 与集成干净重跑的基线）
 */
function makeRepo(name: string): { repoDir: string; head: string } {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-fx3@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-fx3"]);
  writeFileSync(join(repoDir, "brief.md"), "# fx3 fixture 任务书\n");
  writeFileSync(join(repoDir, "app.js"), 'console.log("A1 PASS");\n');
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief + app.js"]);
  return { repoDir, head: gitRun(repoDir, ["rev-parse", "HEAD"]) };
}

function appendUnitCreated(repoDir: string, unitId: string, parentId: string | null): void {
  ledgerForCwd(repoDir).append("UnitCreated", {
    unitId,
    parentId,
    briefRef: join(repoDir, "brief.md"),
  });
}

/** 预置一个 spec-frozen unit（SpecSubmitted + spec-review pass；split 可空） */
function appendSpecFrozen(repoDir: string, unitId: string, split: readonly SplitEntry[]): void {
  const spec = { acceptance: [...ACCEPTANCE], contracts: [], split: [...split] };
  const ledger = ledgerForCwd(repoDir);
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: sha(JSON.stringify(spec)),
    acceptance: [...ACCEPTANCE],
    contracts: [],
    split: [...split],
  });
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass" });
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
    ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = collector(outChunks);
  process.stderr.write = collector(errChunks);
  try {
    const code = await fn();
    return { code: code, out: outChunks.join(""), err: errChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ================================================================
// 回归 3（R5.2）：designer 首派任务书的第 0 步建子指令
// ================================================================

describe("fx-3 R5.2 回归3：root 无子 → designer brief 含第 0 步建子指令", () => {
  it("root 首派 brief 含「本 unit 是根节点且尚无子 unit」与 cw create --parent 模板", async () => {
    const { repoDir, head } = makeRepo("r5-2-no-child");
    appendUnitCreated(repoDir, ROOT_ID, null);
    const script = makeScriptAdapter({ mode: "idle", commit: head });

    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 800 }),
    );

    // idle worker 不写账本 → maxIdle 兜底 exit 1（判定窗口内 brief 已落盘）
    expect(captured.code).toBe(1);
    expect(script.spawned()).toEqual([{ role: "designer", unitId: ROOT_ID }]);
    const brief = readFileSync(join(repoDir, ".cw-spawn", `${ROOT_ID}.designer.brief.md`), "utf-8");
    // 第 0 步指令化建子（验收文档锁定文案要素：根节点判定 + create 模板 + 占位 brief 许可）
    expect(brief).toContain("本 unit 是根节点且尚无子 unit");
    expect(brief).toContain(`cw create --id <slug> --brief <子brief文件> --parent ${ROOT_ID}`);
    expect(brief).toContain("占位文件");
    // 既有三步不回退（fx-3 只追加第 0 步）
    expect(brief).toContain("撰写该 unit 的 spec.json");
    expect(brief).toContain(`cw evidence submit --kind spec --unit ${ROOT_ID} --file spec.json`);
    expect(brief).toContain(`cw review submit --unit ${ROOT_ID} --verdict-kind spec-review --verdict pass`);
  }, 30_000);

  it("root 已有子（账本 parentId 指向它）→ designer 首派 brief 不含第 0 步", async () => {
    const { repoDir, head } = makeRepo("r5-2-has-child");
    appendUnitCreated(repoDir, ROOT_ID, null);
    appendUnitCreated(repoDir, LEAF_IDS[0], ROOT_ID);
    const script = makeScriptAdapter({ mode: "idle", commit: head });

    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 800 }),
    );

    expect(captured.code).toBe(1);
    const rootBrief = readFileSync(join(repoDir, ".cw-spawn", `${ROOT_ID}.designer.brief.md`), "utf-8");
    expect(rootBrief).not.toContain("本 unit 是根节点且尚无子 unit");
    // 叶子首派同样不含（第 0 步条件收窄到 root 无子）
    const leafBrief = readFileSync(join(repoDir, ".cw-spawn", `${LEAF_IDS[0]}.designer.brief.md`), "utf-8");
    expect(leafBrief).not.toContain("本 unit 是根节点且尚无子 unit");
  }, 30_000);
});

// ================================================================
// 回归 4（R5.3）：spec-frozen + split 子未建 → 派 designer 兜底
// ================================================================

describe("fx-3 R5.3 回归4：split 子未建 → 派 designer 补建；补建后转正常轨道", () => {
  it("阶段1：spec-frozen + split 两子未建 → 派 designer（brief 含缺失清单与逐个 create 命令）", async () => {
    const { repoDir, head } = makeRepo("r5-3-missing");
    // 终验第 3 次现场同构：root spec-frozen，split 两子从未创建（R5.1 生效前的
    // 历史账本/旁路写入）——修复前此状态零派发目标，空转至 maxIdleMs exit 1
    appendUnitCreated(repoDir, ROOT_ID, null);
    appendSpecFrozen(repoDir, ROOT_ID, [
      { unitId: LEAF_IDS[0], dependsOn: [] },
      { unitId: LEAF_IDS[1], dependsOn: [] },
    ]);
    expect(statusOf(repoDir, ROOT_ID)).toBe("spec-frozen");
    const script = makeScriptAdapter({ mode: "idle", commit: head });

    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 800 }),
    );

    expect(captured.code).toBe(1); // idle worker 不建子 → 兜底路径下 maxIdle 仍有效
    expect(script.spawned()).toContainEqual({ role: "designer", unitId: ROOT_ID });
    // 可观测性：终验日志明确「为何派 designer」
    expect(captured.out).toContain("派 designer 补建子");
    expect(captured.out).toContain("2 个未创建");
    const brief = readFileSync(join(repoDir, ".cw-spawn", `${ROOT_ID}.designer.brief.md`), "utf-8");
    expect(brief).toContain("声明了 2 个子 unit 但 2 个未创建");
    expect(brief).toContain(`cw create --id ${LEAF_IDS[0]} --brief <文件> --parent ${ROOT_ID}`);
    expect(brief).toContain(`cw create --id ${LEAF_IDS[1]} --brief <文件> --parent ${ROOT_ID}`);
    // 不是 fx-2 R4a 的契约漂移任务书（出口区分）
    expect(brief).not.toContain("集成契约漂移处置");
  }, 30_000);

  it("阶段2：测试进程补 create 两子后再跑 → root 不再被兜底派发，转子 designer 首派", async () => {
    const { repoDir, head } = makeRepo("r5-3-recovered");
    appendUnitCreated(repoDir, ROOT_ID, null);
    appendSpecFrozen(repoDir, ROOT_ID, [
      { unitId: LEAF_IDS[0], dependsOn: [] },
      { unitId: LEAF_IDS[1], dependsOn: [] },
    ]);
    // 「被派发的 designer 建完子」的效果由测试进程直写补 create（账本即状态）
    appendUnitCreated(repoDir, LEAF_IDS[0], ROOT_ID);
    appendUnitCreated(repoDir, LEAF_IDS[1], ROOT_ID);
    const script = makeScriptAdapter({ mode: "idle", commit: head });

    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 800 }),
    );

    expect(captured.code).toBe(1);
    const spawned = script.spawned();
    // 兜底出口关闭：root 无任何派发（spec-frozen 等子 verified = 正常集成等待）
    expect(spawned.filter((r) => r.unitId === ROOT_ID)).toEqual([]);
    // 正常轨道：两子 created 无 spec → designer 首派
    expect(spawned).toContainEqual({ role: "designer", unitId: LEAF_IDS[0] });
    expect(spawned).toContainEqual({ role: "designer", unitId: LEAF_IDS[1] });
  }, 30_000);
});

// ================================================================
// 回归 5（全链）：复现终验第 3 次现场，修复后闭环到全树 closed
// ================================================================

describe("fx-3 全链回归5：root 首派 → 建子 → R5.1 过审 → 子链推进 → 集成 → closed", () => {
  it("root created 起步（终验现场）→ runLoop exit 0，全树 closed，spec 提交先于子创建的时序被 gate 前置", async () => {
    const { repoDir, head } = makeRepo("full-chain");
    appendUnitCreated(repoDir, ROOT_ID, null);
    const script = makeScriptAdapter({ mode: "work", commit: head });

    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter: script.adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 30_000 }),
    );

    // 修复前：designer 不建子时零派发目标 → maxIdleMs exit 1（终验第 3 次空转形态）
    expect(captured.code).toBe(0);
    expect(statusOf(repoDir, ROOT_ID)).toBe("closed");
    expect(statusOf(repoDir, LEAF_IDS[0])).toBe("closed");
    expect(statusOf(repoDir, LEAF_IDS[1])).toBe("closed");

    // R5.1 在真实链路成立：root 的 SpecSubmitted 之前，两子的 UnitCreated 已入账
    //（designer 按 brief 第 0 步先建子后提 spec——worker 全程走真实 dispatch）
    const events = ledgerForCwd(repoDir).readAll() as ReadonlyArray<{
      seq: number;
      type: string;
      payload: { unitId: string };
    }>;
    const seqOf = (type: string, unitId: string): number => {
      const hit = events.find((ev) => ev.type === type && ev.payload.unitId === unitId);
      if (hit === undefined) {
        throw new Error(`账本缺 ${unitId} 的 ${type} 事件（断言前置失败）`);
      }
      return hit.seq;
    };
    const rootSpecSeq = seqOf("SpecSubmitted", ROOT_ID);
    expect(seqOf("UnitCreated", LEAF_IDS[0])).toBeLessThan(rootSpecSeq);
    expect(seqOf("UnitCreated", LEAF_IDS[1])).toBeLessThan(rootSpecSeq);

    // R5.2 现场证据：root 首派 designer 的 brief 落盘第 0 步
    const rootBrief = readFileSync(join(repoDir, ".cw-spawn", `${ROOT_ID}.designer.brief.md`), "utf-8");
    expect(rootBrief).toContain("本 unit 是根节点且尚无子 unit");

    // root 的 build = 子树集成（u8）：VerifyRan 为集成产物且 pass
    const root = loadLedger(repoDir).projection.units.get(ROOT_ID);
    const rootVerify = root?.verifyRuns.at(-1);
    expect(rootVerify?.runId).toMatch(/^integrate-/);
    expect(rootVerify?.result).toBe("pass");

    // 派发形态：root designer 一次完成建子 + spec + review；两子全 role 推进；
    // root 无 builder spawn（内部节点不派 agent）
    const spawned = script.spawned();
    expect(spawned.filter((r) => r.unitId === ROOT_ID && r.role === "designer").length).toBe(1);
    expect(spawned.some((r) => r.unitId === ROOT_ID && r.role === "builder")).toBe(false);
    for (const leaf of LEAF_IDS) {
      for (const role of ["designer", "builder", "reviewer"] as const) {
        expect(spawned).toContainEqual({ role, unitId: leaf });
      }
    }
  }, 60_000);
});

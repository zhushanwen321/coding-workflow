/**
 * u8 E2E real（docs/rewrite/acceptance/u8-acceptance.md「E2E real」两条 + 「单测验收」
 * 第 3 组 loop 派发时机）：
 *   1. 成功路径：root + 两叶，两叶各自完成 build+verify（预置事件，spec 含契约 C1：
 *      leaf-a 提供 `export function capitalize(` 签名、file 指向 src/capitalize.js；
 *      leaf-b 的 spec 无契约）→ runLoop 触发集成 → 集成 VerifyRan 入账（root
 *      verified）、契约命中、产物目录存在、root exec-review 后 closed。
 *      同时覆盖单测验收#3 前半：子全 verified（未全 closed）→ 集成已触发（不等子
 *      closed）——以账本 seq 断言「root 集成事件晚于两叶 VerifyRan、早于两叶
 *      exec-review」，且 root 的 builder 全程无 agent spawn（内部节点不派 agent）。
 *   2. 契约违背路径：同 fixture 但 leaf-a 实现改名（capitalize → capitalise）→
 *      集成 fail、VerifyRan(result=fail) 留痕、stderr 指明 C1 与期望文件；随后
 *      fixture 受控修复（验收脚本把正确实现补进 origin 仓库并提交）→ 下轮重派
 *      集成 → 修复后 verified → exec-review → closed 全链（覆盖单测验收#3 后半：
 *      集成 fail → 重派一轮后修复）。
 *
 * 全部真实子进程（worker 经 spawnProcess 起真实 node；集成验收命令在干净 checkout
 * 里真实执行）+ tmp git 仓库 + 隔离 CW_HOME，零 mock。注意：直接
 * `npx vitest run tests/u8-e2e.test.ts` 不触发 pretest，需先 `npm run build`。
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

import type {
  AcceptanceItem,
  Contract,
  SplitEntry,
  VerdictSubmittedPayload,
} from "../dist/events/types.js";
import { ledgerForCwd } from "../dist/handlers/common.js";
import { loadLedger, unitStatus } from "../dist/readonly/load.js";
import { runLoop } from "../dist/runner/loop.js";
import { spawnProcess } from "../dist/runner/spawn/lifecycle.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
} from "../dist/runner/spawn/types.js";
import { evidenceDir } from "../dist/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const CLI_PATH = join(DIST_ROOT, "cli.js");
for (const required of [CLI_PATH, join(DIST_ROOT, "runner", "loop.js")]) {
  if (!existsSync(required)) {
    throw new Error(`tests/u8-e2e 需要 ${required}（先 npm run build；npm test 的 pretest 已含）`);
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u8-e2e-"));
const cwHome = join(tmpRoot, "cw-home");
process.env.CW_HOME = cwHome;
// wt-2 迁移：派发 workdir 迁 unit worktree，隔离 worktree 根（与 CW_HOME 同款）
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

// ---- fixture repo：三段 commit + 预置账本（root spec-frozen + 两叶 verified 未 closed） ----

/** ESM check 脚本与源码（package.json type=module 使 export function 语法可执行） */
const FIXTURE_FILES: Record<string, string> = {
  "package.json": '{"type":"module"}\n',
  "brief.md": "# u8 fixture root 任务书\n",
  "brief-leaf-a.md": "# leaf-a：capitalize 工具\n",
  "brief-leaf-b.md": "# leaf-b：sluggify 工具\n",
  "scripts/check-capitalize.js": [
    "// u8 e2e fixture：leaf-a 验收 AA1（真实执行，输出 e2e-sh 标记行）",
    'const { capitalize } = await import("../src/capitalize.js");',
    'const ok = capitalize("hello") === "Hello";',
    "console.log(`AA1 ${ok ? \"PASS\" : \"FAIL\"}`);",
    "process.exit(ok ? 0 : 1);",
    "",
  ].join("\n"),
  "scripts/check-sluggify.js": [
    "// u8 e2e fixture：leaf-b 验收 AB1",
    'const { sluggify } = await import("../src/sluggify.js");',
    'const ok = sluggify("Hello There") === "hello-there";',
    "console.log(`AB1 ${ok ? \"PASS\" : \"FAIL\"}`);",
    "process.exit(ok ? 0 : 1);",
    "",
  ].join("\n"),
  "scripts/check-root.js": [
    "// u8 e2e fixture：root 集成验收 AR1。import 失败 = 契约违背（capitalize 缺位）——",
    "// fixture 受控修复（验收文档「集成 fail → 重派一轮后修复（fixture 可控）」）：把",
    "// 正确实现补进 origin 仓库并提交；本轮仍 FAIL，集成下轮重试时 checkout 的就是",
    "// 修复后的 HEAD。",
    'const CORRECT = "export function capitalize(s) {\\n  return s.charAt(0).toUpperCase() + s.slice(1);\\n}\\n";',
    "async function healOrigin() {",
    '  const { execSync } = await import("node:child_process");',
    '  const { writeFileSync } = await import("node:fs");',
    '  const { join } = await import("node:path");',
    '  const origin = execSync("git remote get-url origin", { encoding: "utf8" }).trim();',
    '  writeFileSync(join(origin, "src", "capitalize.js"), CORRECT);',
    "  try {",
    '    execSync("git add -A", { cwd: origin });',
    '    execSync(\'git commit -m "fix: restore capitalize contract C1"\', { cwd: origin });',
    "  } catch {",
    "    // 无变更可提交（已修复）——幂等",
    "  }",
    "}",
    "try {",
    '  const { capitalize } = await import("../src/capitalize.js");',
    '  const { sluggify } = await import("../src/sluggify.js");',
    '  const ok = capitalize("hello") === "Hello" && sluggify("Hello There") === "hello-there";',
    "  console.log(`AR1 ${ok ? \"PASS\" : \"FAIL\"}`);",
    "  process.exit(ok ? 0 : 1);",
    "} catch {",
    "  await healOrigin();",
    '  console.log("AR1 FAIL");',
    "  process.exit(1);",
    "}",
    "",
  ].join("\n"),
};

const CAPITALIZE_OK = 'export function capitalize(s) {\n  return s.charAt(0).toUpperCase() + s.slice(1);\n}\n';
const CAPITALISE_DRIFT = 'export function capitalise(s) {\n  return s.charAt(0).toUpperCase() + s.slice(1);\n}\n';
const SLUGGIFY = 'export function sluggify(s) {\n  return s.toLowerCase().replaceAll(" ", "-");\n}\n';

/** 验收（e2e-sh 标记行第一列 = 验收 id 全文，不要求任何前缀；本文件 id 以 A 起头是 fixture 命名习惯而非约定要求） */
function unitJson(id: string): AcceptanceItem {
  return {
    id,
    core: false,
    title: `${id} 单元级冒烟`,
    type: "unit",
    command:
      `node -e "console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'${id} unit smoke',status:'passed'}]}]}))" -- --reporter=json`,
  };
}

const LEAF_A_ACCEPTANCE: AcceptanceItem[] = [
  { id: "AA1", core: true, title: "capitalize 可用", type: "e2e-real", command: "node scripts/check-capitalize.js" },
  unitJson("AA2"),
];
const LEAF_B_ACCEPTANCE: AcceptanceItem[] = [
  { id: "AB1", core: true, title: "sluggify 可用", type: "e2e-real", command: "node scripts/check-sluggify.js" },
  unitJson("AB2"),
];
const ROOT_ACCEPTANCE: AcceptanceItem[] = [
  { id: "AR1", core: true, title: "两个工具协同可用", type: "e2e-real", command: "node scripts/check-root.js" },
  unitJson("AR2"),
];

const CONTRACT_C1 = {
  id: "C1",
  kind: "function" as const,
  provider: "leaf-a",
  consumer: "feat",
  signature: "export function capitalize(",
  file: "src/capitalize.js",
  description: "leaf-a 向集成树提供 capitalize 签名",
};

/**
 * 预置账本：root "feat" spec-frozen（split 两叶，自身验收 AR1/AR2，无契约——
 * C1 由 leaf-a 的 spec 冻结，验证集成契约集合 = root ∪ 子）；两叶 verified 未
 * closed（无 exec-review——留给 runLoop 派 reviewer，制造「子全 verified 但未
 * 全 closed」的派发时机断言窗口）。broken=true 时 leaf-a 的实现改名为 capitalise。
 */
function seedFixture(name: string, broken: boolean): string {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-u8@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-u8"]);

  const commit = (files: Record<string, string>, message: string): string => {
    for (const [name_, content] of Object.entries(files)) {
      mkdirSync(join(repoDir, dirnameOf(name_)), { recursive: true });
      writeFileSync(join(repoDir, name_), content);
    }
    gitRun(repoDir, ["add", "-A"]);
    gitRun(repoDir, ["commit", "-m", message]);
    return gitRun(repoDir, ["rev-parse", "HEAD"]);
  };

  commit(FIXTURE_FILES, "fixture: briefs + ESM check scripts");
  const leafACommit = commit(
    { "src/capitalize.js": broken ? CAPITALISE_DRIFT : CAPITALIZE_OK },
    "build(leaf-a): capitalize 工具",
  );
  const leafBCommit = commit({ "src/sluggify.js": SLUGGIFY }, "build(leaf-b): sluggify 工具");

  const ledger = ledgerForCwd(repoDir);
  interface FixtureSpec {
    acceptance: AcceptanceItem[];
    contracts: Contract[];
    split: SplitEntry[];
  }
  const appendSpec = (unitId: string, spec: FixtureSpec) => {
    ledger.append("SpecSubmitted", {
      unitId,
      specHash: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
      acceptance: spec.acceptance,
      contracts: spec.contracts,
      split: spec.split,
    });
  };

  ledger.append("UnitCreated", { unitId: "feat", parentId: null, briefRef: join(repoDir, "brief.md") });
  appendSpec("feat", {
    acceptance: ROOT_ACCEPTANCE,
    contracts: [],
    split: [
      { unitId: "leaf-a", briefRef: "brief-leaf-a.md", dependsOn: [] },
      { unitId: "leaf-b", briefRef: "brief-leaf-b.md", dependsOn: [] },
    ],
  });
  ledger.append("VerdictSubmitted", { unitId: "feat", verdictKind: "spec-review", verdict: "pass" });

  const leafSeeds: Array<{ unitId: string; acceptance: AcceptanceItem[]; commit: string; contracts: Contract[] }> = [
    { unitId: "leaf-a", acceptance: LEAF_A_ACCEPTANCE, commit: leafACommit, contracts: [CONTRACT_C1] },
    { unitId: "leaf-b", acceptance: LEAF_B_ACCEPTANCE, commit: leafBCommit, contracts: [] },
  ];
  for (const { unitId, acceptance, commit: leafCommit, contracts } of leafSeeds) {
    ledger.append("UnitCreated", { unitId, parentId: "feat", briefRef: join(repoDir, `brief-${unitId}.md`) });
    appendSpec(unitId, { acceptance, contracts, split: [] });
    ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass" });
    const runId = `run-${unitId}-1`;
    ledger.append("EvidenceSubmitted", {
      unitId,
      runId,
      commit: leafCommit,
      paths: ["src"],
      sha256: [createHash("sha256").update(leafCommit).digest("hex")],
      exitCode: 0,
    });
    // 预置 VerifyRan（验收文档「预置事件」口径）：真实机器验证发生在集成重跑
    ledger.append("VerifyRan", {
      unitId,
      runId,
      reportHash: createHash("sha256").update(`preset:${unitId}`).digest("hex"),
      result: "pass",
      acceptanceIds: acceptance.map((ac) => ac.id),
    });
  }
  return repoDir;
}

function dirnameOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "." : p.slice(0, idx);
}

// ---- 测试专用 worker / 适配器（reviewer-only；spawn 记录用于「内部节点不派 agent」断言） ----

function writeWorkerScript(): string {
  const script = `// tests/u8-e2e.test.ts 生成的测试专用 agent worker（真实进程，非 mock）
// argv: <role> <unitId> <cwd>
const DIST = ${JSON.stringify(DIST_ROOT)};
const [role, unitId, cwd] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { ledgerForCwd } = await import(DIST + "/handlers/common.js");
console.log("worker " + role + " " + unitId + " pid=" + process.pid);
if (role !== "reviewer") {
  console.error("u8 fixture: 内部节点集成不派 agent，收到非 reviewer 派发 " + role);
  process.exit(3);
}
await sleep(50);
ledgerForCwd(cwd).append("VerdictSubmitted", { unitId, verdictKind: "exec-review", verdict: "pass" });
console.log("worker-done reviewer " + unitId);
`;
  const path = join(tmpRoot, "u8-worker.mjs");
  writeFileSync(path, script);
  return path;
}

const WORKER_PATH = writeWorkerScript();

interface SpawnRecord {
  role: string;
  unitId: string;
}

function makeReviewerAdapter(): { adapter: AgentSpawnAdapter; spawned(): readonly SpawnRecord[] } {
  const records: SpawnRecord[] = [];
  return {
    adapter: {
      name: "u8-e2e-reviewer-script",
      spawn: async (req: AgentSpawnRequest): Promise<SpawnHandle> => {
        records.push({ role: req.role, unitId: req.unitId });
        return spawnProcess({
          command: process.execPath,
          // wt-2 迁移：worker 写账本锚定 projectCwd（等价 agent 的 CW_PROJECT_DIR 锚定）
          args: [WORKER_PATH, req.role, req.unitId, req.projectCwd],
          cwd: req.workdir,
          timeoutMs: req.timeoutMs,
          stdoutPath: join(req.workdir, ".cw-spawn", `${req.unitId}.${req.role}.stdout`),
          stderrPath: join(req.workdir, ".cw-spawn", `${req.unitId}.${req.role}.stderr`),
        });
      },
    },
    spawned: () => records,
  };
}

// ---- 断言辅助 ----

function statusOf(repoDir: string, unitId: string): string {
  const unit = loadLedger(repoDir).projection.units.get(unitId);
  if (unit === undefined) {
    throw new Error(`unit ${unitId} 不在账本（断言前置失败）`);
  }
  return unitStatus(unit);
}

/** 事件 seq 查找：unitId + 事件类型（+ verdictKind 过滤），不存在则抛（前置失败） */
function seqOf(repoDir: string, unitId: string, type: string, verdictKind?: string): number {
  const hit = ledgerForCwd(repoDir)
    .readAll()
    .find(
      (ev) =>
        ev.type === type &&
        ev.payload.unitId === unitId &&
        (verdictKind === undefined ||
          (ev.payload as VerdictSubmittedPayload).verdictKind === verdictKind),
    );
  if (hit === undefined) {
    throw new Error(`账本缺 ${unitId} 的 ${type}${verdictKind ? `(${verdictKind})` : ""} 事件`);
  }
  return hit.seq;
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
// E2E 条件 1：成功路径（+ 单测验收#3 前半：子全 verified 即集成，不等子 closed）
// ================================================================

describe("E2E real：内部节点集成成功路径（runLoop 直调，root verified → exec-review → closed）", () => {
  it("两叶预置 verified → 循环直跑集成 → VerifyRan(pass) 入账 + 契约命中 + 产物落盘 → 全链 closed", async () => {
    const repoDir = seedFixture("integrate-ok", false);
    const { adapter, spawned } = makeReviewerAdapter();

    const captured = await captureStd(() =>
      runLoop({ rootId: "feat", adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 30_000 }),
    );

    expect(captured.code).toBe(0);
    for (const unitId of ["feat", "leaf-a", "leaf-b"]) {
      expect(statusOf(repoDir, unitId)).toBe("closed");
    }

    // 内部节点不派 agent：全程 spawn 只有 reviewer（叶与 root 的 exec-review）
    expect(spawned().length).toBeGreaterThanOrEqual(3);
    expect(spawned().every((r) => r.role === "reviewer")).toBe(true);
    expect(captured.out).toContain('集成验证 unit "feat"');
    expect(captured.out).toContain('集成验证 unit "feat" result=pass');

    // 集成 VerifyRan 入账（root verified 的机器依据）
    const feat = loadLedger(repoDir).projection.units.get("feat");
    const integrateRun = feat?.verifyRuns.at(-1);
    expect(integrateRun?.runId).toMatch(/^integrate-/);
    expect(integrateRun?.result).toBe("pass");
    expect(new Set(integrateRun?.acceptanceIds ?? [])).toEqual(
      new Set(["AA1", "AA2", "AB1", "AB2", "AR1", "AR2"]),
    );

    // 派发时机（单测验收#3 前半）：集成晚于两叶 VerifyRan（子证据齐）、早于两叶
    // exec-review（不等子 closed——若仍等 closed，集成事件不可能先于 review 入账）
    const integrateSeq = seqOf(repoDir, "feat", "VerifyRan");
    expect(integrateSeq).toBeGreaterThan(seqOf(repoDir, "leaf-a", "VerifyRan"));
    expect(integrateSeq).toBeGreaterThan(seqOf(repoDir, "leaf-b", "VerifyRan"));
    for (const leaf of ["leaf-a", "leaf-b"]) {
      expect(integrateSeq).toBeLessThan(seqOf(repoDir, leaf, "VerdictSubmitted", "exec-review"));
    }

    // 产物目录存在 + 报告断言（契约命中、子可达、验收批次全绿）
    const runId = integrateRun?.runId ?? "";
    const evidenceBase = evidenceDir(cwHome, repoDir, "feat", runId);
    expect(existsSync(join(evidenceBase, "integrate-report.json"))).toBe(true);
    for (const unit of ["leaf-a", "leaf-b", "feat"]) {
      expect(existsSync(join(evidenceBase, unit, "report.json"))).toBe(true);
    }
    const report = JSON.parse(readFileSync(join(evidenceBase, "integrate-report.json"), "utf-8")) as {
      children: Array<{ unitId: string; reachable: boolean }>;
      acceptanceBatches: Array<{ unitId: string; results: Array<{ status: string }> }>;
      contracts: { ok: boolean; failures: string[] };
      ok: boolean;
    };
    expect(report.ok).toBe(true);
    expect(report.contracts).toEqual({ ok: true, failures: [] });
    expect(report.children).toEqual([
      { unitId: "leaf-a", commit: expect.any(String), reachable: true },
      { unitId: "leaf-b", commit: expect.any(String), reachable: true },
    ]);
    expect(report.acceptanceBatches.map((b) => b.unitId)).toEqual(["leaf-a", "leaf-b", "feat"]);
    expect(report.acceptanceBatches.every((b) => b.results.every((r) => r.status === "pass"))).toBe(true);
  }, 120_000);
});

// ================================================================
// E2E 条件 2：契约违背路径（+ 单测验收#3 后半：fail 留痕 → 重派 → 修复 → 全链）
// ================================================================

describe("E2E real：契约违背路径（capitalize → capitalise → 集成 fail 留痕 → 受控修复 → 重派成功）", () => {
  it("集成 fail 写 VerifyRan(result=fail) + stderr 指明 C1 与期望文件；修复后重派 → verified → exec-review → closed", async () => {
    const repoDir = seedFixture("contract-drift", true);
    const { adapter, spawned } = makeReviewerAdapter();

    const captured = await captureStd(() =>
      runLoop({ rootId: "feat", adapter, cwd: repoDir, pollMs: 50, maxIdleMs: 30_000 }),
    );

    expect(captured.code).toBe(0);
    for (const unitId of ["feat", "leaf-a", "leaf-b"]) {
      expect(statusOf(repoDir, unitId)).toBe("closed");
    }

    // fail 留痕 + 重派成功：feat 的集成 VerifyRan 序列 = 先 fail（审计）后 pass
    const feat = loadLedger(repoDir).projection.units.get("feat");
    const integrateRuns = (feat?.verifyRuns ?? []).filter((run) => run.runId.startsWith("integrate-"));
    expect(integrateRuns.length).toBeGreaterThanOrEqual(2);
    expect(integrateRuns[0]?.result).toBe("fail");
    expect(integrateRuns.at(-1)?.result).toBe("pass");
    expect(integrateRuns[0]?.acceptanceIds).toEqual([]); // fail 轮无机器判定 pass 的验收

    // stderr 指明 C1 与期望文件（契约违背的失败清单 + 恢复动作）
    expect(captured.err).toContain("集成验证 unit \"feat\" 失败");
    expect(captured.err).toContain("C1");
    expect(captured.err).toContain("src/capitalize.js");

    // 受控修复真实发生：origin 仓库 HEAD 前进了（heal commit），且最终集成在修复树上通过
    expect(existsSync(join(repoDir, "src", "capitalize.js"))).toBe(true);
    const commitCount = Number(gitRun(repoDir, ["rev-list", "--count", "HEAD"]));
    expect(commitCount).toBeGreaterThanOrEqual(4); // 3 个 fixture commit + 1 个 heal commit

    // 两次集成的产物目录都在（fail 轮留审计，pass 轮是 closed 依据）
    for (const run of integrateRuns) {
      expect(existsSync(join(evidenceDir(cwHome, repoDir, "feat", run.runId), "integrate-report.json"))).toBe(true);
    }

    // 全链收尾仍有 reviewer 派发（两叶 + root），且全程无 builder/designer spawn
    expect(spawned().every((r) => r.role === "reviewer")).toBe(true);
  }, 120_000);
});

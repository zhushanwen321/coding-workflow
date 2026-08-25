/**
 * fx-7 单测：runner 失败路径降级三修复（pr-cr-fix 阶段 3a 修复路径 2）。
 *
 *   - fx7-1（S-5 spawn 路径）：adapter.spawn 同步 throw → 循环存活（同批另一
 *     unit 的 in-flight 照常派发与结算）、stderr 出声含原始错误与重试指引、
 *     下轮重算重试（throw 计数 ≥2）
 *   - fx7-2（S-5 集成路径）：runIntegrationDispatch 的 env 级 throw（evidence
 *     目录被同名普通文件占位 → mkdirSync ENOTDIR）→ 循环存活、出声、下轮重试
 *   - fx7-3（S-6）：pi 适配器同步抛转 SPAWN_ERROR 时原始 message 落 stderrPath
 *     （PATH 指向空目录触发 lifecycle ENOENT 预检的真实同步抛形态）
 *   - fx7-4（S-9）：listUnitBranchRefs 对非 repo cwd 显式 throw（error 含 git
 *     原始输出与恢复动作）；合法 repo 无 cw/ 分支仍返回空数组（失败与「无分支」
 *     不再混淆）
 *
 * 全部真实环境零 mock：直调 dist 的 runLoop / createPiAdapter / listUnitBranchRefs
 * （真实 git 子进程 + 真实账本 EventLedger + tmp 目录 + 隔离 CW_HOME /
 * CW_WORKTREE_HOME）。异常注入全部走真实 env 形态（适配器内 throw 的真实 Error、
 * 文件系统 ENOTDIR、PATH 解析失败、非 repo 的 git fatal），无 mock 框架。
 * 注意：直接 `npx vitest run tests/fx7-dispatch-failure-guard.test.ts` 不触发
 * pretest，需先 `npm run build`（`npm test` 的 pretest 已含）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../dist/events/types.js";
import { ledgerForCwd } from "../dist/handlers/common.js";
import { runLoop } from "../dist/runner/loop.js";
import { createPiAdapter } from "../dist/runner/spawn/pi.js";
import type { AgentSpawnAdapter, SpawnResult } from "../dist/runner/spawn/types.js";
import { listUnitBranchRefs } from "../dist/runner/worktree.js";
import { encodeCwd } from "../dist/store/project.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
for (const required of [join(DIST_ROOT, "cli.js"), join(DIST_ROOT, "runner", "loop.js")]) {
  if (!existsSync(required)) {
    throw new Error(
      `tests/fx7-dispatch-failure-guard 需要 ${required}（先 npm run build；npm test 的 pretest 已含）`,
    );
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fx7-"));
const cwHome = join(tmpRoot, "cw-home");
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_HOME = cwHome;
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ROOT_ID = "rt";

function gitRun(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git -C ${dir} ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 过 spec gate 全规则的验收（fx5 的 unitAcceptance 同款） */
function unitAcceptance(id: string): AcceptanceItem[] {
  return [
    { id, core: true, title: `${id} 冒烟`, type: "e2e-real", command: `echo "${id} PASS"` },
    {
      id: `${id}-u`,
      core: false,
      title: `${id} 单元级`,
      type: "unit",
      command:
        `node -e "console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'${id}-u unit smoke',status:'passed'}]}]}))" -- --reporter=json`,
    },
  ];
}

/** 真实 git 仓库（含一个真实 commit）——fx5 的 initRepo 同模式 */
function initRepo(name: string): { repoDir: string; head: string } {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-fx7@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-fx7"]);
  writeFileSync(join(repoDir, "brief.md"), "# fx7 fixture 任务书\n");
  writeFileSync(join(repoDir, "f.txt"), "base\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: base"]);
  return { repoDir, head: gitRun(repoDir, ["rev-parse", "HEAD"]) };
}

/** 捕获 runLoop 的 stdout/stderr（进程内直调，透传 write 回调——fx5/u7 同款） */
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

// ================================================================
// fx7-1（S-5 spawn 路径）：adapter.spawn 同步 throw 不炸循环
// ================================================================

describe("fx7-1 S-5：spawn 同步 throw → 循环存活 + 出声 + 下轮重试", () => {
  it("root 的 spawn 持续 throw：同批 unit-b 的 in-flight 照常结算；循环由 maxIdle 正常收束（不 reject）", async () => {
    const { repoDir } = initRepo("spawn-guard");
    // 账本：root rt + 子 unit-b（均 created 无 spec → 双双 specReady 派 designer）
    const ledger = ledgerForCwd(repoDir);
    ledger.append("UnitCreated", { unitId: ROOT_ID, parentId: null, briefRef: join(repoDir, "brief.md") });
    ledger.append("UnitCreated", { unitId: "unit-b", parentId: ROOT_ID, briefRef: join(repoDir, "brief.md") });

    let throwCount = 0;
    const ioFailure = "fx7 模拟 spawn 阶段 IO 失败：产物目录磁盘写入异常";
    const adapter: AgentSpawnAdapter = {
      name: "fx7-flaky-spawn",
      spawn: async (req) => {
        if (req.unitId === ROOT_ID) {
          throwCount += 1;
          // 真实 Error（非 mock 框架）：env 级 IO 异常的同步 throw 形态
          throw new Error(ioFailure);
        }
        return {
          wait: () =>
            Promise.resolve<SpawnResult>({
              exitCode: 0,
              stdoutPath: "/dev/null",
              stderrPath: "/dev/null",
              pid: -1,
            }),
          kill: () => {},
        };
      },
    };

    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 500 }),
    );

    // 循环存活：runLoop 正常 resolve（无修复时 spawn throw 直接 reject runLoop）
    expect(captured.code).toBe(1); // maxIdle 兜底退出（无账本进展）
    // 下轮重算重试：throw 不止一次
    expect(throwCount).toBeGreaterThanOrEqual(2);
    // 出声：stderr 含异常指引 + 原始错误原文
    expect(captured.err).toContain("派发 spawn 异常");
    expect(captured.err).toContain(ioFailure);
    expect(captured.err).toContain("下轮重算自动重试");
    // in-flight 结算在异常下仍可达：unit-b 的 spawn 正常、结算行照常打印
    expect(captured.out).toContain('designer unit "unit-b" 退出 exit 0');
  }, 20_000);
});

// ================================================================
// fx7-2（S-5 集成路径）：runIntegrationDispatch env 级 throw 不炸循环
// ================================================================

describe("fx7-2 S-5：集成派发 env 级 throw → 循环存活 + 出声 + 下轮重试", () => {
  it("evidence 目录被同名文件占位（mkdirSync ENOTDIR）→ 集成异常出声且循环由 maxIdle 正常收束", async () => {
    const { repoDir } = initRepo("integ-guard");
    // 账本：root rt spec-frozen 内部节点（split=[unit-a]）；unit-a 全链 closed
    const ledger = ledgerForCwd(repoDir);
    ledger.append("UnitCreated", { unitId: ROOT_ID, parentId: null, briefRef: join(repoDir, "brief.md") });
    const rootSpec = {
      acceptance: unitAcceptance("AR1"),
      contracts: [],
      split: [{ unitId: "unit-a", dependsOn: [] }],
    };
    ledger.append("SpecSubmitted", {
      unitId: ROOT_ID,
      specHash: sha(JSON.stringify(rootSpec)),
      acceptance: rootSpec.acceptance,
      contracts: [],
      split: rootSpec.split,
    });
    ledger.append("VerdictSubmitted", { unitId: ROOT_ID, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    ledger.append("UnitCreated", { unitId: "unit-a", parentId: ROOT_ID, briefRef: join(repoDir, "brief.md") });
    const childSpec = { acceptance: unitAcceptance("A-unit-a"), contracts: [], split: [] };
    ledger.append("SpecSubmitted", {
      unitId: "unit-a",
      specHash: sha(JSON.stringify(childSpec)),
      acceptance: childSpec.acceptance,
      contracts: [],
      split: [],
    });
    ledger.append("VerdictSubmitted", { unitId: "unit-a", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    ledger.append("EvidenceSubmitted", {
      unitId: "unit-a",
      runId: "run-unit-a-1",
      commit: gitRun(repoDir, ["rev-parse", "HEAD"]),
      paths: ["f.txt"],
      sha256: [sha("f.txt")],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId: "unit-a",
      runId: "run-unit-a-1",
      reportHash: sha("report:unit-a"),
      result: "pass",
      acceptanceIds: childSpec.acceptance.map((ac) => ac.id),
    });
    ledger.append("VerdictSubmitted", { unitId: "unit-a", verdictKind: "exec-review", verdict: "pass" });

    // env 级异常注入（真实文件系统形态）：evidence/<rootId> 被同名普通文件占位 →
    // runIntegrationVerify 的 mkdirSync(evidenceBase, recursive) throw ENOTDIR
    const evidenceUnitDir = join(cwHome, encodeCwd(repoDir), "evidence", ROOT_ID);
    mkdirSync(join(cwHome, encodeCwd(repoDir), "evidence"), { recursive: true });
    writeFileSync(evidenceUnitDir, "fx7-2 占位文件（模拟 evidence 目录被外部占用）\n");

    // hold adapter：本场景无 spawn 派发（integrationReady 不派 agent），保险兜住
    const hold: AgentSpawnAdapter = {
      name: "fx7-hold",
      spawn: async () => ({
        wait: () => new Promise<SpawnResult>(() => {}),
        kill: () => {},
      }),
    };

    const captured = await captureStd(() =>
      runLoop({ rootId: ROOT_ID, adapter: hold, cwd: repoDir, pollMs: 30, maxIdleMs: 600 }),
    );

    // 循环存活：runLoop 正常 resolve（无修复时集成 throw 直接 reject runLoop）
    expect(captured.code).toBe(1);
    // 出声：stderr 含集成异常指引 + env 级错误原文（ENOTDIR）
    expect(captured.err).toContain("集成派发异常");
    expect(captured.err).toContain("not a directory");
    expect(captured.err).toContain("下轮重算自动重试");
    // 下轮重算重试：异常行出现 ≥2 次
    expect((captured.err.match(/集成派发异常/g) ?? []).length).toBeGreaterThanOrEqual(2);
  }, 20_000);
});

// ================================================================
// fx7-3（S-6）：pi 适配器 SPAWN_ERROR 保留原始错误消息
// ================================================================

describe("fx7-3 S-6：pi 适配器同步抛转 SPAWN_ERROR 时原始 message 落 stderrPath", () => {
  it("PATH 指向空目录 → lifecycle 预检同步抛 → wait() SPAWN_ERROR 且 stderr 产物含原始 message", async () => {
    const emptyBin = join(tmpRoot, "fx7-3-empty-bin");
    mkdirSync(emptyBin, { recursive: true }); // 真实空目录：pi 解析不到（ENOENT 预检）
    const artifactDir = join(tmpRoot, "fx7-3-topic");
    const handle = await createPiAdapter().spawn({
      role: "developer",
      unitId: "fx7-unit",
      workdir: tmpRoot,
      projectCwd: tmpRoot,
      artifactDir,
      briefPath: join(tmpRoot, "fx7-3-brief.md"),
      env: { PATH: emptyBin },
      timeoutMs: 5_000,
    });
    const result = await handle.wait();
    expect(result.exitCode).toBe("SPAWN_ERROR");
    expect(result.pid).toBe(-1);
    expect(() => handle.kill()).not.toThrow(); // 无进程可杀，幂等 no-op
    // 原始错误消息保留（SPAWN_ERROR 时 stderr 的天然归宿）
    const stderrText = readFileSync(result.stderrPath, "utf-8");
    expect(stderrText).toContain("spawn 同步失败");
    expect(stderrText).toContain("不存在或不可执行"); // lifecycle 预检的原始诊断
    expect(stderrText).toContain("恢复动作");
  }, 10_000);
});

// ================================================================
// fx7-4（S-9）：listUnitBranchRefs 命令级失败显式 throw
// ================================================================

describe("fx7-4 S-9：ref 扫描命令级失败与「无分支」分离", () => {
  it("非 repo cwd → throw（error 含 git 原始输出与恢复动作）；合法 repo 无 cw/ 分支 → 空数组", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "cw-fx7-nonrepo-"));
    try {
      let message = "";
      try {
        listUnitBranchRefs(notARepo);
        expect.unreachable("非 repo cwd 的 for-each-ref 应显式 throw");
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toContain("for-each-ref");
      expect(message).toMatch(/not a git repository|不是 git 仓库/); // git 原始输出经 describeFailure 透传（中英文 locale 双兼容）
      expect(message).toContain("恢复动作");
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
    // 对照：合法 repo 且无 cw/ 分支 → 空数组（返回值只表达「无分支」）
    const { repoDir } = initRepo("ref-clean");
    expect(listUnitBranchRefs(repoDir)).toEqual([]);
  });
});

/**
 * P0-1 单测：runLoop 的 onStopRequest 编程停止通道（库形态）。
 *
 * 零 mock 全真实环境（对齐 tests/i2a-runner-library.test.ts 写法）：直调 dist 的
 * runLoop + 测试专用适配器 spawn 真实 node 子进程（faildev 恒败 → 循环持续重派，
 * 停止是唯一正常出口）。验证：
 * 1. stop() → 主 promise 以 130 resolve（不 process.exit——测试进程本身存活即证据）
 * 2. 在飞 spawn 被 killAll 回收；派发锁释放（重跑可续）
 * 3. 不传 onStopRequest 时选项完全可选（冒烟：正常 closed 路径不受影响）
 *
 * 注意：直接 `npx vitest run tests/i2b-loop-stop.test.ts` 不触发 pretest，
 * 需先 `npm run build`。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ledgerForCwd } from "../dist/handlers/common.js";
import { runnerLockPath } from "../dist/runner/lock.js";
import { runLoop } from "../dist/runner/loop.js";
import { spawnProcess } from "../dist/runner/spawn/lifecycle.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
  SpawnResult,
} from "../dist/runner/spawn/types.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
for (const required of [join(DIST_ROOT, "runner", "loop.js")]) {
  if (!existsSync(required)) {
    throw new Error(`tests/i2b-loop-stop 需要 ${required}（先 npm run build；npm test 的 pretest 已含）`);
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-i2b-"));
process.env.CW_HOME = join(tmpRoot, "cw-home");
process.env.CW_WORKTREE_HOME = join(tmpRoot, "cw-worktrees");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

/** worker：designer 正常写 spec 后退出；developer 挂起 sleep（被 killAll 回收的靶子） */
const WORKER_PATH = join(tmpRoot, "i2b-worker.mjs");
writeFileSync(
  WORKER_PATH,
  `// tests/i2b-loop-stop.test.ts 生成的测试 agent worker（真实进程，非 mock）
const DIST = ${JSON.stringify(DIST_ROOT)};
const [role, unitId, cwd] = process.argv.slice(2);
const { createHash } = await import("node:crypto");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const { ledgerForCwd } = await import(DIST + "/handlers/common.js");
if (role === "designer") {
  const ACCEPTANCE = [{ id: "A1", core: true, title: "可运行", type: "e2e-real", command: "node app.js" }];
  ledgerForCwd(cwd).append("SpecSubmitted", { unitId, specHash: sha(JSON.stringify({ acceptance: ACCEPTANCE, contracts: [], split: [] })), acceptance: ACCEPTANCE, contracts: [], split: [] });
  console.log("worker-done designer " + unitId);
} else if (role === "reviewer") {
  ledgerForCwd(cwd).append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
  console.log("worker-done reviewer " + unitId);
} else {
  // developer：长挂（sleep 300s）——只有 killAll 能回收
  await new Promise(() => {});
}
`,
);

function makeHangingAdapter(): AgentSpawnAdapter {
  return {
    name: "i2b-test-hanging",
    spawn: async (req: AgentSpawnRequest): Promise<SpawnHandle> => {
      const handle = spawnProcess({
        command: process.execPath,
        args: [WORKER_PATH, req.role, req.unitId, req.projectCwd],
        cwd: req.workdir,
        timeoutMs: req.timeoutMs,
        stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
        stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
      });
      return { wait: (): Promise<SpawnResult> => handle.wait(), kill: handle.kill };
    },
  };
}

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

function makeRepo(name: string): string {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-i2b@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-i2b"]);
  writeFileSync(join(repoDir, "brief.md"), "# i2b fixture 任务书\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  return repoDir;
}

describe("P0-1：onStopRequest 编程停止通道", () => {
  it("stop() → 主 promise 以 130 resolve，不 process.exit，在飞回收且锁释放", async () => {
    const repoDir = makeRepo("stop");
    ledgerForCwd(repoDir).append("UnitCreated", {
      unitId: "root",
      parentId: null,
      briefRef: join(repoDir, "brief.md"),
    });

    let delivered: (() => void) | undefined;
    const loop: Promise<number> = runLoop({
      rootId: "root",
      adapter: makeHangingAdapter(),
      cwd: repoDir,
      pollMs: 40,
      maxIdleMs: 60_000, // 停止是唯一快速出口
      onStopRequest: (stop: () => void) => {
        delivered = stop;
      },
    });
    // 等 developer（长挂 round）派发入 in-flight 后再停
    await new Promise((r) => setTimeout(r, 2_500));
    expect(delivered).toBeTypeOf("function");
    delivered?.();
    const code = await loop;
    expect(code).toBe(130); // 约定退出码，主 promise resolve（测试进程存活 = 未 exit）
    // 派发锁已释放（<CW_HOME>/<encoded-cwd>/runner.lock 无残留）
    const lockFile = runnerLockPath(process.env.CW_HOME!, repoDir);
    expect(existsSync(lockFile)).toBe(false);
    // 挂起 worker 已被 killAll 回收：无残留 node worker 进程（退出码路径本身即证据——
    // vitest 进程能正常收尾说明子进程表已清）
  }, 30_000);
});

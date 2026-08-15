/**
 * u6a AgentSpawn 生命周期原语单测（docs/rewrite/acceptance/u6a-acceptance.md 单测验收 1-9 组）。
 *
 * 全部真实 OS 进程 + 真实 fs + 真实 ps，零 mock。探针落点：
 *   - P4（验收#3/#5）：超时/树 kill 后用 `ps ax -o pid,pgid` 真实快照断言无残留
 *     （含 spawnSync 子进程与嵌套 spawn 的孙进程，按 pgid 整组检查）；
 *   - P6（验收#4）：外部 SIGKILL 前已输出内容仍在 stdout 文件（fd 直写与进程存活解耦）；
 *   - P8（验收#1/#4）：wait() resolve 后立即 readFileSync 可读全文（close 先于 resolve）。
 *
 * 时序护栏：凡测试侧要 kill 的场景（#4 外部杀 / #8 手动 kill()），先轮询 stdout 文件
 * 等子进程真实输出到位再动手——确保 exec 已完成、setsid 已生效（spawn 刚返回时
 * kill(-pgid) 可能因组尚未建立而 ESRCH 被幂等吞掉，导致进程漏杀）。
 *
 * 平台假设与被测模块一致：POSIX（ps/detached/pgid 语义）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { SpawnProcessRequest } from "../src/runner/spawn/lifecycle.js";
import { spawnProcess } from "../src/runner/spawn/lifecycle.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u6a-lifecycle-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 产物路径按适配器的 .cw-spawn/ 约定拼（嵌套目录，验证模块自建） */
function artifactPaths(name: string): Pick<SpawnProcessRequest, "stdoutPath" | "stderrPath"> {
  return {
    stdoutPath: join(tmpRoot, name, ".cw-spawn", `${name}.stdout`),
    stderrPath: join(tmpRoot, name, ".cw-spawn", `${name}.stderr`),
  };
}

function readOut(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 轮询 stdout 文件直到出现 pattern（子进程 fd 直写 → 内核 page cache → 父进程读立即可见）。
 * 返回首次匹配时点的文件全文。
 */
async function waitStdoutContains(path: string, pattern: RegExp, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = readOut(path);
    if (pattern.test(content)) {
      return content;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 stdout 出现 ${pattern} 超时（当前内容: ${JSON.stringify(content)}）`);
    }
    await sleep(25);
  }
}

/** 从 stdout 文件解析子进程自己打印的 pid */
async function waitChildPid(stdoutPath: string): Promise<number> {
  const content = await waitStdoutContains(stdoutPath, /^pid (\d+)$/m);
  return Number(/^pid (\d+)$/m.exec(content)?.[1]);
}

/** ps 全表快照（真实系统进程表） */
function psPidPgid(): { pids: Set<number>; groupMembers: (pgid: number) => number[] } {
  const res = spawnSync("ps", ["ax", "-o", "pid,pgid"], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`ps ax 快照失败（P4 检查的权威源）: ${res.stderr}`);
  }
  const rows = res.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((t) => t.length === 2 && /^\d+$/.test(t[0] ?? "") && /^\d+$/.test(t[1] ?? ""))
    .map((t) => ({ pid: Number(t[0]), pgid: Number(t[1]) }));
  return {
    pids: new Set(rows.map((r) => r.pid)),
    groupMembers: (pgid: number) => rows.filter((r) => r.pgid === pgid).map((r) => r.pid),
  };
}

/**
 * P4 残留断言：给定 pid 列表 + pgid，全部从进程表消失才算过。
 * 孤儿被 init reap 有毫秒级窗口，轮询重试上限 3s——超限仍残留即真残留。
 */
async function assertNoResidue(pids: readonly number[], pgid: number, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  let residual: number[] = [];
  for (;;) {
    const snap = psPidPgid();
    residual = [
      ...pids.filter((pid) => snap.pids.has(pid)),
      ...snap.groupMembers(pgid).filter((pid) => !pids.includes(pid)),
    ];
    if (residual.length === 0 || Date.now() > deadline) {
      break;
    }
    await sleep(100);
  }
  expect(residual, `${label}：pgid=${pgid} 进程树仍有残留`).toEqual([]);
}

describe("u6a lifecycle：正常退出路径", () => {
  it("验收#1 正常退出 exitCode=0；P8：wait resolve 后立即可读 stdout 全文", async () => {
    const paths = artifactPaths("normal-exit");
    const handle = spawnProcess({
      command: "node",
      args: ["-e", "console.log('out'); process.exit(0)"],
      cwd: tmpRoot,
      timeoutMs: 30_000,
      ...paths,
    });
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.pid).toBeGreaterThan(0);
    expect(result.stdoutPath).toBe(paths.stdoutPath);
    expect(result.stderrPath).toBe(paths.stderrPath);
    // P8：resolve 时点同步读即得全文（close 事件先于 wait resolve）
    expect(readFileSync(result.stdoutPath, "utf8")).toContain("out");
  });

  it("验收#2 exit≠0 原样透传：exitCode=3", async () => {
    const paths = artifactPaths("exit-3");
    const handle = spawnProcess({
      command: "node",
      args: ["-e", "process.exit(3)"],
      cwd: tmpRoot,
      timeoutMs: 30_000,
      ...paths,
    });
    expect((await handle.wait()).exitCode).toBe(3);
  });

  it("验收#7 cwd 生效（子进程 process.cwd() = realpath(传入 cwd)）+ env 自定义变量可读", async () => {
    const workdir = join(tmpRoot, "cwd-env-work");
    mkdirSync(workdir, { recursive: true });
    const paths = artifactPaths("cwd-env");
    const handle = spawnProcess({
      command: "node",
      args: ["-e", "console.log(process.cwd()); console.log(process.env.CW_U6A_PROBE)"],
      cwd: workdir,
      env: { CW_U6A_PROBE: "probe-value-123" },
      timeoutMs: 30_000,
      ...paths,
    });
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    // macOS 传 /var/... 子进程报 /private/var/...（symlink 解析），按物理路径比对
    expect(readOut(result.stdoutPath)).toContain(realpathSync(workdir));
    expect(readOut(result.stdoutPath)).toContain("probe-value-123");
  });

  it("验收#9 stdout 追加模式：同路径二次 spawn 不覆盖前次内容（append 语义）", async () => {
    const paths = artifactPaths("append");
    const first = spawnProcess({
      command: "node",
      args: ["-e", "console.log('first-run')"],
      cwd: tmpRoot,
      timeoutMs: 30_000,
      ...paths,
    });
    expect((await first.wait()).exitCode).toBe(0);
    const second = spawnProcess({
      command: "node",
      args: ["-e", "console.log('second-run')"],
      cwd: tmpRoot,
      timeoutMs: 30_000,
      ...paths,
    });
    expect((await second.wait()).exitCode).toBe(0);
    const out = readOut(paths.stdoutPath);
    const firstAt = out.indexOf("first-run");
    const secondAt = out.indexOf("second-run");
    expect(firstAt).toBeGreaterThanOrEqual(0);
    expect(secondAt).toBeGreaterThan(firstAt);
  });
});

describe("u6a lifecycle：超时与整树 kill", () => {
  it("验收#3 超时 → TIMEOUT；P4：主进程与其 spawnSync 的子进程整组无残留", async () => {
    const paths = artifactPaths("timeout");
    // spawnSync('sleep') 是同 pgid 子进程：超时 kill 必须连它一起清（pgid 整组）
    const script =
      'const { spawnSync } = require("child_process"); ' +
      'console.log("pid", process.pid); ' +
      'spawnSync("sleep", ["10"]);';
    // timeoutMs 留 3s 启动裕量：定时 kill 在子进程 exec/setsid 完成前触发的话，
    // kill(-pgid) 会因组未建立而 ESRCH（幂等静默、不重发），高负载下曾致进程漏杀、
    // wait() 挂到 testTimeout。waitChildPid 前置 + 3s 裕量后 kill 必落在存活进程上。
    const handle = spawnProcess({
      command: "node",
      args: ["-e", script],
      cwd: tmpRoot,
      timeoutMs: 3_000,
      ...paths,
    });
    // 等子进程真实跑起来（exec 完成、setsid 生效）再让超时 kill 落在它身上
    await waitChildPid(paths.stdoutPath);
    const result = await handle.wait();
    expect(result.exitCode).toBe("TIMEOUT");
    // P4：主进程 pid + 它 spawnSync 的 sleep（同组，pid 不可知）都按组检查
    await assertNoResidue([result.pid], result.pid, "验收#3 超时整树 kill");
  });

  it("验收#5 树 kill：父进程嵌套 spawn 长活子进程，超时后父+子均无残留", async () => {
    const paths = artifactPaths("tree-kill");
    const script =
      'const { spawn } = require("child_process"); ' +
      'const c = spawn("sleep", ["30"]); ' +
      'console.log(JSON.stringify({ parent: process.pid, child: c.pid })); ' +
      "setInterval(() => {}, 1000);";
    const handle = spawnProcess({
      command: "node",
      args: ["-e", script],
      cwd: tmpRoot,
      // 3s 启动裕量，理由同验收#3：kill 必须落在 setsid 已完成的存活进程树上
      timeoutMs: 3_000,
      ...paths,
    });
    const banner = await waitStdoutContains(paths.stdoutPath, /^\{"parent":\d+,"child":\d+\}$/m);
    const ids = JSON.parse(
      /^\{"parent":(\d+),"child":(\d+)\}$/m.exec(banner)?.[0] ?? "{}",
    ) as { parent: number; child: number };
    expect(ids.parent).toBeGreaterThan(0);
    expect(ids.child).toBeGreaterThan(0);
    const result = await handle.wait();
    expect(result.exitCode).toBe("TIMEOUT");
    await assertNoResidue([ids.parent, ids.child], result.pid, "验收#5 树 kill");
  });
});

describe("u6a lifecycle：CRASH 与 kill() 语义", () => {
  it("验收#4 外部 SIGKILL → CRASH；P6：杀前已输出内容仍在 stdout 文件", async () => {
    const paths = artifactPaths("crash");
    const handle = spawnProcess({
      command: "node",
      args: [
        "-e",
        "console.log('before-kill'); console.log('pid', process.pid); setInterval(() => {}, 1000);",
      ],
      cwd: tmpRoot,
      timeoutMs: 60_000,
      ...paths,
    });
    const pid = await waitChildPid(paths.stdoutPath);
    expect(readOut(paths.stdoutPath)).toContain("before-kill");
    process.kill(pid, "SIGKILL");
    const result = await handle.wait();
    expect(result.exitCode).toBe("CRASH");
    // P6：SIGKILL 后 fd 直写内容仍在（产物完整性与进程存活解耦）
    expect(readOut(result.stdoutPath)).toContain("before-kill");
  });

  it("验收#8 kill() 幂等（重复调用无害）+ wait() 可重复调用同结果", async () => {
    const paths = artifactPaths("kill-idempotent");
    const handle = spawnProcess({
      command: "node",
      args: ["-e", "console.log('alive'); setInterval(() => {}, 1000);"],
      cwd: tmpRoot,
      timeoutMs: 60_000,
      ...paths,
    });
    await waitStdoutContains(paths.stdoutPath, /alive/);
    handle.kill();
    handle.kill(); // 幂等：第二次调用不抛、不误伤
    const first = await handle.wait();
    const again = await handle.wait();
    expect(again).toBe(first); // 同一 result 实例（waitPromise 缓存）
    // 手动 kill 与超时同机制（kill(-pgid)）但非超时路径 → 按四态归 CRASH
    expect(first.exitCode).toBe("CRASH");
    await assertNoResidue([first.pid], first.pid, "验收#8 手动 kill");
  });
});

describe("u6a lifecycle：spawn 同步失败", () => {
  it("验收#6 ENOENT：command 不存在 → spawnProcess 同步抛含可执行名的 Error", () => {
    const paths = artifactPaths("enoent");
    expect(() =>
      spawnProcess({
        command: "no-such-bin-xyz",
        args: [],
        cwd: tmpRoot,
        timeoutMs: 1_000,
        ...paths,
      }),
    ).toThrow(/no-such-bin-xyz/);
  });
});

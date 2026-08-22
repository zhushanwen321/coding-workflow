/**
 * al-1 单测：nice 减震双落点（docs/rewrite/acceptance/al-1-acceptance.md §5，
 * 真实子进程 + tmp 目录 + 零 mock）。
 *
 *   N 系（nice 包裹生效）：被 nice 的 bash 主进程以 `ps -o ni= -p $$` 自报
 *      nice 值（bash `$$` = 主 shell pid，正是被 nice 的进程）。
 *      - N1 验收命令落点：execBashTree 直测（fx-7 先例）；
 *      - N2 agent spawn 落点：spawnProcess 直测（u6a 先例）；
 *      - N3 两落点值一致：N1/N2 断言共用同一常量 EXPECTED_NI——两文件各自实现
 *        被同一值锁定，任一处漂移即红，测试不代偿。
 *   D 系（预检降级，零语义变化）：tmp bin 目录仅 symlink 系统 bash（无 nice、
 *      无 ps），env.PATH 只指该目录 → niceResolvable 为 false 走降级裸 spawn。
 *   R 系（语义回归锁定，nice 在场路径）：
 *      - R1 超时整树 kill：nice(1) exec 自替换下 pgid === pid 与 kill(-pgid)
 *        整树回收不变式实测；
 *      - R2 退出码透传：nice 不吞退出码。
 *   R3（哨兵与产物完整）/ R4（agent 链路既有行为）归全量回归——命令内含全量
 *   npm test（验收文档 §5），不在本文件重复。
 *
 * 诚实边界（验收文档 §5）：测试进程自身 ni=0 是常态运行假设（vitest 不降优先级
 * 起 worker）——若该假设破坏，N 系会假红。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { spawnProcess } from "../src/runner/spawn/lifecycle.js";
import { execBashTree } from "../src/verify/run.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-al1-nice-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** N3：两落点共用的期望 nice 值（与两处 NICE_ADJUSTMENT 锁定同一字面量） */
const EXPECTED_NI = "10";

const env: NodeJS.ProcessEnv = { ...process.env };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function caseDir(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 路径嵌入 bash 命令串的单引号包裹（与 src/verify/run.ts 的 shellQuote 同手法） */
function quote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * 「仅 bash」的极简 bin 目录（D 系共享夹具）：symlink 系统 bash，无 nice / ps
 * 等任何其他可执行——env.PATH 只指该目录时既有 bash 预检放行（bash 在场）、
 * nice 预检必为 false（降级分支）。
 */
const bashOnlyBin: string = (() => {
  const which = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf-8" });
  const bashPath = which.stdout.trim();
  if (which.status !== 0 || bashPath === "") {
    throw new Error(`D 系夹具前提不成立：无法定位系统 bash: ${which.stderr}`);
  }
  const bin = caseDir("bash-only-bin");
  symlinkSync(bashPath, join(bin, "bash"));
  return bin;
})();

// ---- N 系：nice 包裹生效 ----

describe("al-1 N1/N3 验收命令落点：execBashTree 主命令 spawn 包 nice", () => {
  it("ps -o ni= -p $$ 自报 → done exitCode 0，stdout 产物 trim 后恰为 10", () => {
    const dir = caseDir("n1");
    const stdoutPath = join(dir, "n1.stdout");
    const out = execBashTree(
      "ps -o ni= -p $$",
      dir,
      env,
      stdoutPath,
      join(dir, "n1.stderr"),
      join(dir, "n1.exit"),
      30_000,
    );
    expect(out).toEqual({ kind: "done", exitCode: 0 });
    // $$ = 被 nice 的 bash 主进程 pid（nice exec 自替换 pid 不变），其 ni 即 NICE_ADJUSTMENT
    expect(readFileSync(stdoutPath, "utf-8").trim()).toBe(EXPECTED_NI);
  });
});

describe("al-1 N2/N3 agent spawn 落点：spawnProcess 主 spawn 包 nice", () => {
  it("bash -c 'ps -o ni= -p $$' → wait() exitCode 0，stdout 落盘 trim 后恰为 10", async () => {
    const dir = caseDir("n2");
    const stdoutPath = join(dir, "n2.stdout");
    const handle = spawnProcess({
      command: "bash",
      args: ["-c", "ps -o ni= -p $$"],
      cwd: dir,
      timeoutMs: 30_000,
      stdoutPath,
      stderrPath: join(dir, "n2.stderr"),
    });
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(readFileSync(stdoutPath, "utf-8").trim()).toBe(EXPECTED_NI);
  });
});

// ---- D 系：预检降级（零语义变化） ----

describe("al-1 D1 execBashTree：PATH 无 nice 时降级裸 spawn（静默）", () => {
  it("仅 bash 的 PATH 下 echo hello → done exitCode 0、stdout hello\\n、stderr 产物为空", () => {
    const dir = caseDir("d1");
    const out = execBashTree(
      "echo hello",
      dir,
      { PATH: bashOnlyBin },
      join(dir, "d1.stdout"),
      join(dir, "d1.stderr"),
      join(dir, "d1.exit"),
      15_000,
    );
    // kind=done 本身即证明既有 bashResolvable 在该 PATH 下仍放行（bash symlink
    // 在场；不放行走 spawn-error「bash 不存在」分支）
    expect(out).toEqual({ kind: "done", exitCode: 0 });
    expect(readFileSync(join(dir, "d1.stdout"), "utf-8")).toBe("hello\n");
    // 降级静默：不写 stderr 产物、不告警（echo 为 bash 内建，无外部依赖）
    expect(readFileSync(join(dir, "d1.stderr"), "utf-8")).toBe("");
  });
});

describe("al-1 D2 spawnProcess：childEnv PATH 无 nice 时降级裸 spawn（静默）", () => {
  it("req.env 覆盖 PATH 后 bash -c 'echo hi' → wait() exitCode 0、stdout hi\\n、stderr 落盘无 nice 相关报错", async () => {
    const dir = caseDir("d2");
    const stdoutPath = join(dir, "d2.stdout");
    const handle = spawnProcess({
      command: "bash",
      args: ["-c", "echo hi"],
      cwd: dir,
      env: { PATH: bashOnlyBin },
      timeoutMs: 30_000,
      stdoutPath,
      stderrPath: join(dir, "d2.stderr"),
    });
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(readFileSync(stdoutPath, "utf-8")).toBe("hi\n");
    expect(readFileSync(join(dir, "d2.stderr"), "utf-8")).toBe("");
  });
});

describe("al-1 D3 spawnProcess：降级不影响 assertExecutableResolvable 同步抛错契约", () => {
  it("同 env 下 command=definitely-not-on-path → 仍同步抛带可执行名的 Error", () => {
    const dir = caseDir("d3");
    expect(() =>
      spawnProcess({
        command: "definitely-not-on-path",
        args: [],
        cwd: dir,
        env: { PATH: bashOnlyBin },
        timeoutMs: 30_000,
        stdoutPath: join(dir, "d3.stdout"),
        stderrPath: join(dir, "d3.stderr"),
      }),
    ).toThrow(/definitely-not-on-path/);
  });
});

// ---- R 系：语义回归锁定（nice 在场路径） ----

describe("al-1 R1 execBashTree：nice 包裹下超时整树 kill 语义不变", () => {
  it("echo $$ > victim-pid; sleep 30 + timeoutMs 500 → timeout，victim pid 已死（ESRCH）", async () => {
    const dir = caseDir("r1");
    const victimPath = join(dir, "victim-pid");
    const out = execBashTree(
      `echo $$ > ${quote(victimPath)}; sleep 30`,
      dir,
      env,
      join(dir, "r1.stdout"),
      join(dir, "r1.stderr"),
      join(dir, "r1.exit"),
      500,
    );
    expect(out).toEqual({ kind: "timeout" });
    const pid = Number(readFileSync(victimPath, "utf-8").trim());
    expect(Number.isFinite(pid)).toBe(true);
    // $$ = bash 主进程 = detached 组长 pid（= pgid）——nice 组长下 kill(-pgid)
    // 整树回收不变式：超时 kill 后该 pid 必须已死，轮询窗口 ≤2s
    const deadline = Date.now() + 2_000;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") {
          return; // 进程已回收
        }
        // 其他 errno（如 EPERM）表示进程仍可感知——继续轮询至窗口耗尽
      }
      if (Date.now() > deadline) {
        throw new Error(`R1：pid ${pid} 在 2s 轮询窗口后仍存活（整树回收失效）`);
      }
      await sleep(50);
    }
  });
});

describe("al-1 R2 execBashTree：nice(1) exec 自替换不吞退出码", () => {
  it("exit 42 → done exitCode 恰 42", () => {
    const dir = caseDir("r2");
    const out = execBashTree(
      "exit 42",
      dir,
      env,
      join(dir, "r2.stdout"),
      join(dir, "r2.stderr"),
      join(dir, "r2.exit"),
      15_000,
    );
    expect(out).toEqual({ kind: "done", exitCode: 42 });
  });
});

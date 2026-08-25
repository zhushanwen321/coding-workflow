/**
 * 独立验收问题修复回归（P0-1/P0-2/P1-3/P1-4/P2-7）：
 * 真实 recorder 宿主 + 注入式 launchRunLoop（真实函数注入，非 mock 框架）。
 *
 * 覆盖：
 * - P0-2/P1-3：setWidget 走 pi 实签名（key + string[]）；notify level 用 "warning"
 * - P0-1：onStopRequest 编程停止通道接线——/cw stop 调交付的 stop 函数而非 SIGINT
 * - P1-4：stop → start → stop 序列每次真收尾（memoization 在 start 复位）
 * - P2-7：兜底 unlink 前比对锁 pid——他进程活锁保留，死进程陈锁清理
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkSubagentApi } from "../probe.js";
import { registerCwRunner, type CwRunnerController, type LaunchOptions } from "../index.js";
import type { ExtensionAPI, ExtensionCommandContext } from "../pi-api.js";
import { mirrorRunnerLockPath } from "../runner-lock.js";

// 环境守卫（同 entry.test.ts）：四用例均走 /cw start 链路，依赖 subagent-workflow 编程 API
// （createSpawnManager，未发布 npm）——纯 registry 环境跳过，本地开发态自动恢复。
const subagentApiReady = (await checkSubagentApi()).ok;

interface UiCall {
  kind: "notify" | "setWidget";
  args: unknown[];
}

function makePi() {
  const commands = new Map<string, { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }>();
  const events = new Map<string, Array<(data: unknown) => void>>();
  const pi: ExtensionAPI = {
    registerCommand(name, opts) {
      commands.set(name, opts);
    },
    on(event, cb) {
      const list = events.get(event) ?? [];
      list.push(cb);
      events.set(event, list);
    },
  };
  return {
    pi,
    commands,
    events,
    /** 全量录制 UI 调用（含参数形态——P0-2/P1-3 的签名断言数据源） */
    ctx(): ExtensionCommandContext & { calls: UiCall[]; notifyMsgs: string[] } {
      const calls: UiCall[] = [];
      const notifyMsgs: string[] = [];
      return {
        calls,
        notifyMsgs,
        ui: {
          notify(msg: string, level?: "info" | "warning" | "error") {
            calls.push({ kind: "notify", args: [msg, level] });
            notifyMsgs.push(msg);
          },
          setWidget(key: string, content: string[] | undefined) {
            calls.push({ kind: "setWidget", args: [key, content] });
          },
        },
      };
    },
  };
}

let home: string;
let cwdTmp: string;
const prevCwd = process.cwd();
let prevHome: string | undefined;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "cw-fix-home-"));
  cwdTmp = await (await import("node:fs/promises")).realpath(await mkdtemp(join(tmpdir(), "cw-fix-cwd-")));
  prevHome = process.env.CW_HOME;
  process.env.CW_HOME = home;
  process.chdir(cwdTmp);
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.CW_HOME;
  else process.env.CW_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
  await rm(cwdTmp, { recursive: true, force: true });
});

/** 挂起式 launch（永不自行结束——stop 是唯一出口）；releaseLast 兑现最近一次 start */
function makeHangingLaunch(onLaunch?: (opts: LaunchOptions, release: (code: number) => void) => void) {
  const releases: Array<(code: number) => void> = [];
  const launches: LaunchOptions[] = [];
  const launch = (opts: LaunchOptions): Promise<number> => {
    launches.push(opts);
    return new Promise<number>((res) => {
      releases.push(res);
      onLaunch?.(opts, res);
    });
  };
  return {
    launch,
    launches,
    releases,
    releaseLast: (code: number): void => {
      releases.at(-1)?.(code);
    },
  };
}

describe("P0-2/P1-3：setWidget 实签名 + notify level 枚举", () => {
  it.skipIf(!subagentApiReady)("onEvent 接线：setWidget 收 (\"cw-runner\", string[])；stopped notify 用 \"warning\"", async () => {
    const host = makePi();
    const { launch, launches, releaseLast } = makeHangingLaunch();
    const ctl = registerCwRunner(host.pi, {
      launchRunLoop: launch,
      signalStop: () => {
        releaseLast(1);
      },
    });
    const ctx = host.ctx();
    await ctl.handleCommand("start feat-fix", ctx);
    const onEvent = launches[0].onEvent as (ev: unknown) => void;

    onEvent({ kind: "round", seq: 7, frontierSummary: { specReady: 2 } });
    const widgetCalls = ctx.calls.filter((c) => c.kind === "setWidget");
    expect(widgetCalls).toHaveLength(1);
    expect(widgetCalls[0].args[0]).toBe("cw-runner");
    expect(widgetCalls[0].args[1]).toEqual(["cw[#7] specReady:2"]);

    onEvent({ kind: "stopped", unitId: "u9", dimension: "flakeReview", reason: "连挂" });
    const notifyCalls = ctx.calls.filter((c) => c.kind === "notify");
    const stoppedNotify = notifyCalls.find((c) => String(c.args[0]).includes("转人工"));
    expect(stoppedNotify?.args[1]).toBe("warning");

    // 全量 notify 无非法 "warn" level
    expect(notifyCalls.every((c) => c.args[1] === undefined || ["info", "warning", "error"].includes(c.args[1] as string))).toBe(true);
    await ctl.shutdown();
  });
});

describe("P0-1：onStopRequest 编程停止通道", () => {
  it.skipIf(!subagentApiReady)("/cw stop 调交付的 stop 函数而非 SIGINT，且打印已停止提示", async () => {
    const host = makePi();
    const stopCalls: number[] = [];
    let signalStops = 0;
    const { launch, releaseLast } = makeHangingLaunch((opts, release) => {
      opts.onStopRequest?.(() => {
        stopCalls.push(Date.now());
        release(130); // 模拟 runLoop 库形态收尾：以约定码 resolve 而非 process.exit
      });
    });
    const ctl = registerCwRunner(host.pi, {
      launchRunLoop: launch,
      signalStop: () => {
        signalStops += 1;
        releaseLast(1);
      },
    });
    const ctx = host.ctx();
    await ctl.handleCommand("start root-a", ctx);
    expect(ctl.describe().running).toBe(true);
    const stopCtx = host.ctx();
    await ctl.handleCommand("stop", stopCtx);
    expect(stopCalls).toHaveLength(1);
    expect(signalStops).toBe(0); // 绝不发 SIGINT（会杀死 pi 宿主）
    expect(stopCtx.notifyMsgs.join("\n")).toContain("已停止");
    expect(ctl.describe().running).toBe(false);
  });
});

describe("P1-4：stop → start → stop 序列", () => {
  it.skipIf(!subagentApiReady)("memoization 在 start 复位——第二次 stop 真收尾（signalStop 计 2 次）", async () => {
    const host = makePi();
    let signalStops = 0;
    const { launch, releaseLast } = makeHangingLaunch();
    const ctl = registerCwRunner(host.pi, {
      launchRunLoop: launch,
      signalStop: () => {
        signalStops += 1;
        releaseLast(1);
      },
    });
    // 第一轮：start → stop
    await ctl.handleCommand("start run-1", host.ctx());
    await ctl.handleCommand("stop", host.ctx());
    expect(signalStops).toBe(1);
    expect(ctl.describe().running).toBe(false);
    // 第二轮：start → stop（修复前拿旧 Promise，doShutdown 不重跑 → 计数停在 1）
    await ctl.handleCommand("start run-2", host.ctx());
    expect(ctl.describe().running).toBe(true);
    await ctl.handleCommand("stop", host.ctx());
    expect(signalStops).toBe(2);
    expect(ctl.describe().running).toBe(false);
  });
});

describe("P2-7：兜底 unlink 的 pid 比对", () => {
  it.skipIf(!subagentApiReady)("锁内 pid 为活他进程 → 保留；死他进程 pid / 本进程 pid → 清除", async () => {
    const lockPath = mirrorRunnerLockPath(home, cwdTmp);
    await mkdir(join(lockPath, ".."), { recursive: true });
    const writeLock = async (pid: number): Promise<void> => {
      await writeFile(lockPath, `${JSON.stringify({ pid, form: "extension", rootId: "r", startedTs: "", heartbeatTs: "" })}\n`);
    };

    // 活他进程：真实 spawn 的 sleep 子进程
    const alive = spawn("sleep", ["30"]);
    try {
      const host = makePi();
      const { launch, releaseLast } = makeHangingLaunch();
      const ctl = registerCwRunner(host.pi, {
        launchRunLoop: launch,
        signalStop: () => {
          releaseLast(1);
        },
      });
      await ctl.handleCommand("start live-lock", host.ctx());
      await writeLock(alive.pid!);
      await ctl.handleCommand("stop", host.ctx());
      expect(await readFile(lockPath, "utf-8")).toContain(String(alive.pid)); // 未删
      expect(ctl.describe().running).toBe(false);
      await rm(lockPath, { force: true }); // 活锁保留是正确行为——下一阶段重新铺锁

      // 死他进程 pid（真实起停的子进程）→ 陈锁清理
      const dead = spawn("sleep", ["30"]);
      const deadPid = dead.pid!;
      dead.kill("SIGKILL");
      await new Promise((r) => dead.once("exit", r));
      // macOS 回收延迟兜底：等到 pid 真正消亡（kill(0) 抛 ESRCH）
      for (let i = 0; i < 40; i++) {
        try {
          process.kill(deadPid, 0);
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      await ctl.handleCommand("start dead-lock", host.ctx());
      await writeLock(deadPid);
      await ctl.handleCommand("stop", host.ctx());
      await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      alive.kill("SIGKILL");
      await rm(lockPath, { force: true });
    }
  });
});

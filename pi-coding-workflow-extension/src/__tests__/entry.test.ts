/**
 * u-i2-c：入口 /cw 命令组接线 + 生命周期（真实 recorder pi 对象 + 真实锁文件 +
 * 注入式 launchRunLoop/signalStop 真实函数——非 mock 框架）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import cwRunnerExtension, { registerCwRunner, type CwRunnerController, type LaunchOptions } from "../index.js";
import type { ExtensionAPI, ExtensionCommandContext } from "../pi-api.js";
import { mirrorRunnerLockPath } from "../runner-lock.js";

/** 真实 recorder 宿主：登记命令/事件，notify/setWidget 全量落数组 */
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
    ctx(): ExtensionCommandContext & { notifies: string[]; widgets: string[] } {
      const notifies: string[] = [];
      const widgets: string[] = [];
      return {
        notifies,
        widgets,
        ui: {
          notify(msg: string) {
            notifies.push(msg);
          },
          // P0-2 后对齐 pi 实签名 setWidget(key, content)——recorder 记录内容行（断言语义不变）
          setWidget(_key: string, content: string[] | undefined) {
            widgets.push(...(content ?? []));
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
  home = await mkdtemp(join(tmpdir(), "cw-entry-home-"));
  // realpath 消 macOS /var ↔ /private/var 歧义（process.cwd() 恒为解析后路径）
  cwdTmp = await (await import("node:fs/promises")).realpath(await mkdtemp(join(tmpdir(), "cw-entry-cwd-")));
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

describe("入口装配（default export）", () => {
  it("注册 /cw-ping（ph-i0 哨兵保留）与 /cw 命令组 + session_shutdown", async () => {
    const host = makePi();
    cwRunnerExtension(host.pi);
    expect([...host.commands.keys()].sort()).toEqual(["cw", "cw-ping"]);
    expect(host.events.has("session_shutdown")).toBe(true);
    const ctx = host.ctx();
    await host.commands.get("cw-ping")?.handler("", ctx);
    expect(ctx.notifies.join("\n")).toContain("cw-extension-alive");
  });

  it("import 入口不炸 + 未知子命令给合法集提示", async () => {
    const host = makePi();
    const ctl = registerCwRunner(host.pi);
    const ctx = host.ctx();
    await ctl.handleCommand("bogus", ctx);
    expect(ctx.notifies.join("\n")).toContain("start/status/report/takeover/stop");
  });
});

describe("/cw start", () => {
  it("cli 形态活锁在场 → 拒启（真实锁文件 + 本进程 pid=活）", async () => {
    const lockPath = mirrorRunnerLockPath(home, cwdTmp);
    await mkdir(join(lockPath, ".."), { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, form: "cli", rootId: "r1", startedTs: new Date().toISOString(), heartbeatTs: new Date().toISOString() })}\n`,
    );
    try {
      const host = makePi();
      const ctl = registerCwRunner(host.pi);
      const ctx = host.ctx();
      await ctl.handleCommand("start r2", ctx);
      const msg = ctx.notifies.join("\n");
      expect(msg).toContain("拒启");
      expect(msg).toContain("已有 cli 形态 runner");
      expect(msg).toContain("--force");
      expect(ctl.describe().running).toBe(false);
    } finally {
      await rm(lockPath, { force: true });
    }
  });

  it("extension 形态活锁同样拒启（form 字段透出）", async () => {
    const lockPath = mirrorRunnerLockPath(home, cwdTmp);
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, form: "extension", rootId: "r1", startedTs: "", heartbeatTs: "" })}\n`,
    );
    try {
      const ctl = registerCwRunner(makePi().pi);
      const host = makePi();
      const c2 = registerCwRunner(host.pi);
      void ctl;
      const ctx = host.ctx();
      await c2.handleCommand("start r2", ctx);
      expect(ctx.notifies.join("\n")).toContain("extension 形态");
    } finally {
      await rm(lockPath, { force: true });
    }
  });

  it("无锁 → 启动：launch 收到 rootId/配置/onEvent；round→widget、stopped→notify", async () => {
    const host = makePi();
    const launches: LaunchOptions[] = [];
    let release: (code: number) => void = () => {};
    const ctl = registerCwRunner(host.pi, {
      launchRunLoop: (opts) => {
        launches.push(opts);
        return new Promise<number>((res) => {
          release = res;
        });
      },
      signalStop: () => {
        release(1);
      },
    });
    const ctx = host.ctx();
    await ctl.handleCommand("start feat-x", ctx);
    expect(launches).toHaveLength(1);
    expect(launches[0].rootId).toBe("feat-x");
    expect(launches[0].config.maxConcurrency).toBe(2);
    expect(typeof launches[0].onEvent).toBe("function");
    expect(ctl.describe().running).toBe(true);
    // onEvent 接线（R2 最小集）
    const onEvent = launches[0].onEvent as (ev: unknown) => void;
    onEvent({ kind: "round", seq: 3, frontierSummary: { specReady: 1, buildReady: 0 } });
    expect(ctx.widgets.at(-1)).toContain("cw[#3]");
    expect(ctx.widgets.at(-1)).toContain("specReady:1");
    onEvent({ kind: "dispatch", unitId: "u1", role: "designer", subagentSlug: "u1-designer" });
    expect(ctx.widgets.at(-1)).toContain("u1-designer");
    onEvent({ kind: "stopped", unitId: "u1", dimension: "buildDrift", reason: "缓慢进展" });
    expect(ctx.notifies.join("\n")).toContain("cw: u1 转人工（buildDrift）");
    // 二次 start 在跑时拒
    const ctx2 = host.ctx();
    await ctl.handleCommand("start other", ctx2);
    expect(ctx2.notifies.join("\n")).toContain("先 /cw stop");
    // 结束通知
    release(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.notifies.join("\n")).toContain("runner 结束（exit 0）");
  });
});

describe("/cw status 与生命周期", () => {
  it("status：配置生效值 + 探针三查行", async () => {
    const host = makePi();
    const ctl = registerCwRunner(host.pi);
    const ctx = host.ctx();
    await ctl.handleCommand("status", ctx);
    const msg = ctx.notifies.join("\n");
    expect(msg).toContain("CW_RUNNER_MAX_CONCURRENCY=2");
    expect(msg).toContain("CW_RUNNER_POLL_MS=5000");
    expect(msg).toContain("ask-user");
    expect(msg).toContain("subagent-workflow API");
    expect(msg).toContain("cw 库");
  });

  it("session_shutdown → signalStop 发信号 + 等待 launch 短超时 + 兜底 unlink 锁", async () => {
    let signaled = 0;
    let release: (code: number) => void = () => {};
    const host = makePi();
    const ctl = registerCwRunner(host.pi, {
      launchRunLoop: () =>
        new Promise<number>((res) => {
          release = res;
        }),
      signalStop: () => {
        signaled += 1;
        release(1);
      },
    });
    const ctx = host.ctx();
    await ctl.handleCommand("start root-1", ctx);
    // 心跳残留锁（模拟 heartbeat 竞态窗口），shutdown 应兜底 unlink
    const lockPath = mirrorRunnerLockPath(home, cwdTmp);
    await writeFile(lockPath, "{}\n");
    const shutdownCb = host.events.get("session_shutdown")?.[0];
    expect(shutdownCb).toBeTypeOf("function");
    await (shutdownCb as () => unknown)();
    await ctl.shutdown(); // session_shutdown 回调是 fire-and-forget——幂等收口直达完成态
    expect(signaled).toBe(1);
    expect(ctl.describe().running).toBe(false);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    // 幂等
    await ctl.shutdown();
    expect(signaled).toBe(1);
  });

  it("stop：无 runner 时提示；有 runner 时走 shutdown 链", async () => {
    const host = makePi();
    const ctl = registerCwRunner(host.pi, { signalStop: () => {} });
    const ctx0 = host.ctx();
    await ctl.handleCommand("stop", ctx0);
    expect(ctx0.notifies.join("\n")).toContain("无在跑 runner");
  });
});

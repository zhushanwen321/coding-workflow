/**
 * pi-cw-runner extension 入口（ph-i2 u-i2-c，design-hi-cw-runner-extension R1/R2/R4/R5）。
 *
 * 薄组装层（不复制 cw 状态机，E5）：/cw 命令组（start/status/report/takeover/stop）
 * + onEvent 接线（round→widget、stopped→notify）+ 生命周期收尾（session_shutdown →
 * cancel 在飞 → SIGINT 触发 runLoop 自身的收尾/释放锁 → 账本天然续接）+ 配置面。
 *
 * cw 引擎与 SpawnManager 均探测式动态 import（发版链现实：npm 线 subagent-workflow
 * 0.3.x 无编程 API，2.0.0 未发——失败时 /cw start 拒启 + 指引，见 probe.ts）。
 * ph-i0 哨兵 /cw-ping 保留。
 */
import { execFile } from "node:child_process";
import { unlinkSync } from "node:fs";
import { promisify } from "node:util";

import { loadRunnerConfig, type RunnerConfig } from "./config.js";
import type { ExtensionAPI, ExtensionCommandContext } from "./pi-api.js";
import { runProbe, type ProbeResult } from "./probe.js";
import { mirrorGetCwHome, mirrorRunnerLockPath, precheckRunnerLock } from "./runner-lock.js";
import { createSubagentBackend, type SmSpawnManager, type SubagentBackend } from "./subagent-backend.js";

/** 与 package.json version 同步维护（jiti 环境下 import json 断言不可靠，硬编码） */
const EXT_VERSION = "0.5.0";

const execFileP = promisify(execFile);

// ---- 可注入依赖面（测试以真实对象注入，非 mock 框架） ----

export interface LaunchOptions {
  rootId: string;
  cwd: string;
  config: RunnerConfig;
  force: boolean;
  onEvent?: (ev: unknown) => void;
}

export interface CwRunnerDeps {
  /** 缺省：动态 import runLoop + createSpawnManager → createSubagentBackend → runLoop */
  launchRunLoop?: (opts: LaunchOptions) => Promise<number>;
  /** 缺省：向自身发 SIGINT，触发 runLoop 已注册的信号 handler（killAll + 释放锁） */
  signalStop?: () => void;
  /** 时钟/等待注入位（缺省真实 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
}

export interface CwRunnerController {
  /** /cw 命令回调（subcommand 派发） */
  handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void>;
  /** session_shutdown 收尾（幂等） */
  shutdown(): Promise<void>;
  /** 当前运行态摘要（/cw status 与测试消费） */
  describe(): {
    running: boolean;
    rootId?: string;
    config: RunnerConfig;
    warnings: string[];
  };
}

function splitArgs(raw: string): string[] {
  return raw.trim().split(/\s+/).filter((t) => t !== "");
}

/** 默认依赖装配：探测式动态 import 两库（失败抛可读错误，含安装指引） */
async function makeDefaultBackend(): Promise<{ backend: SubagentBackend; runLoop: (opts: unknown) => Promise<number> }> {
  // 动态 import 用宽型 string 变量（防 TS 静态解析 subagent-workflow 的 .ts 入口）
  const cwSpec = "@zhushanwen/coding-workflow/runner";
  const swSpec = "@zhushanwen/pi-subagent-workflow";
  const cwMod = (await import(cwSpec)) as Record<string, unknown>;
  const runLoop = cwMod.runLoop;
  if (typeof runLoop !== "function") {
    throw new Error("cw 引擎库缺 runLoop 导出（probe 应已拦截——启动竞态窗口）");
  }
  const swRoot = (await import(swSpec)) as Record<string, unknown>;
  let swMod = swRoot;
  if (typeof swRoot.createSpawnManager !== "function") {
    // pi-1 打包实态：包根只 re-export extension default——回落 ./src/index.ts
    swMod = (await import(`${swSpec}/src/index.ts`)) as Record<string, unknown>;
  }
  const createSpawnManager = swMod.createSpawnManager;
  if (typeof createSpawnManager !== "function") {
    throw new Error("subagent-workflow 编程 API 不在场（probe 应已拦截——启动竞态窗口）");
  }
  const mgr = (createSpawnManager as (pi?: unknown) => SmSpawnManager)();
  const backend: SubagentBackend = createSubagentBackend(mgr);
  return { backend, runLoop: runLoop as (opts: unknown) => Promise<number> };
}
export function registerCwRunner(pi: ExtensionAPI, deps: CwRunnerDeps = {}): CwRunnerController {
  const launch =
    deps.launchRunLoop ??
    (async (opts: LaunchOptions): Promise<number> => {
      const { backend, runLoop } = await makeDefaultBackend();
      backendRef = backend;
      return runLoop({
        rootId: opts.rootId,
        adapter: backend.adapter,
        cwd: opts.cwd,
        maxConcurrency: opts.config.maxConcurrency,
        pollMs: opts.config.pollMs,
        forceDispatch: opts.force,
        ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
      });
    });
  const signalStop = deps.signalStop ?? ((): void => {
    process.kill(process.pid, "SIGINT");
  });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let running = false;
  let rootId: string | undefined;
  let launchPromise: Promise<number> | undefined;
  let backendRef: SubagentBackend | undefined;
  let stoppedNotified = false;

  const configFull = loadRunnerConfig();

  /** onEvent 接线（R2 最小集）：round→widget；stopped→notify 一次；其余状态行刷新 */
  function wireOnEvent(ctx: ExtensionCommandContext): (ev: unknown) => void {
    return (ev: unknown): void => {
      const e = ev as { kind?: string; seq?: number; frontierSummary?: Record<string, number>; unitId?: string; dimension?: string; reason?: string; subagentSlug?: string; role?: string; result?: { exitCode?: unknown } };
      try {
        if (e.kind === "round" && e.frontierSummary !== undefined) {
          const line = Object.entries(e.frontierSummary)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${k}:${n}`)
            .join(" ");
          ctx.ui.setWidget?.(`cw[#${e.seq ?? 0}] ${line || "（frontier 全空）"}`);
        } else if (e.kind === "stopped" && !stoppedNotified) {
          stoppedNotified = true;
          ctx.ui.notify?.(`cw: ${e.unitId} 转人工（${e.dimension}）`, "warn");
          ctx.ui.setWidget?.(`cw ⚠ ${e.unitId} 转人工（${e.dimension}）：${e.reason ?? ""} —— /cw report 查证据链`);
        } else if (e.kind === "dispatch" && e.subagentSlug !== undefined) {
          ctx.ui.setWidget?.(`cw → ${e.subagentSlug}`);
        } else if (e.kind === "settled") {
          ctx.ui.setWidget?.(`cw ✓ ${e.unitId}/${String(e.role ?? "")} exit=${String(e.result?.exitCode ?? "?")}`);
        }
        // reflection/error：最小集为忽略（reflection 轮次在 subagent 面板天然可见）
      } catch {
        /* 观测面不是信任边界 */
      }
    };
  }

  async function cmdStart(tokens: string[], ctx: ExtensionCommandContext): Promise<void> {
    if (running) {
      ctx.ui.notify?.(`cw: 已有 runner 在跑（root=${rootId}）；先 /cw stop`, "warn");
      return;
    }
    const force = tokens.includes("--force");
    const id = tokens.find((t) => !t.startsWith("--"));
    if (id === undefined) {
      ctx.ui.notify?.("用法：/cw start <rootId> [--force]", "error");
      return;
    }
    // 启动探针（三查；②③ 失败拒启，① 失败降级自声明）
    const probe = await runProbe({ noClarify: configFull.noClarify });
    if (!probe.subagentApi.ok || !probe.cwLib.ok) {
      ctx.ui.notify?.(`cw: /cw start 拒启——前置检查失败：\n${[probe.subagentApi, probe.cwLib].filter((c) => !c.ok).map((c) => `✗ ${c.detail}`).join("\n")}`, "error");
      return;
    }
    if (!probe.clarify) {
      ctx.ui.notify?.("cw: 本次无提问通道（designer 自声明形态）：" + probe.reasons.join("；"), "info");
    }
    // 锁预检（runLoop 内部 acquireRunnerLock 仍是权威；此处给 /cw 语境拒启文案）
    const cwd = process.cwd();
    const lock = precheckRunnerLock({ cwHome: mirrorGetCwHome(), cwd, force });
    if (!lock.ok) {
      ctx.ui.notify?.(`cw: 拒启——${lock.message ?? ""}（${lock.detail}）`, "error");
      return;
    }
    running = true;
    rootId = id;
    stoppedNotified = false;
    const onEvent = wireOnEvent(ctx);
    ctx.ui.notify?.(`cw: runner 启动 root=${id}（并发 ${configFull.maxConcurrency}，poll ${configFull.pollMs}ms${probe.clarify ? "" : "，无提问通道"}）`, "info");
    launchPromise = launch({ rootId: id, cwd, config: configFull, force, onEvent })
      .catch(async (e: unknown): Promise<number> => {
        // runLoop 抛错（root 缺失等）——对齐 CLI 壳语义转 exit 1 出声
        ctx.ui.notify?.(`cw: runner 异常退出：${e instanceof Error ? e.message : String(e)}`, "error");
        return 1;
      })
      .finally(() => {
        running = false;
      });
    void launchPromise.then((code: number) => {
      ctx.ui.notify?.(`cw: runner 结束（exit ${code}）${code === 0 ? "——root 已 closed" : "；续接：/cw start 或 cw run"}`, code === 0 ? "info" : "warn");
    });
  }

  async function cmdStatus(ctx: ExtensionCommandContext): Promise<void> {
    const probe: ProbeResult = await runProbe({ noClarify: configFull.noClarify });
    const lines = [
      `cw-extension ${EXT_VERSION} — runner ${running ? `running（root=${rootId}）` : "idle"}`,
      `配置生效值：CW_RUNNER_MAX_CONCURRENCY=${configFull.maxConcurrency} CW_RUNNER_POLL_MS=${configFull.pollMs} CW_RUNNER_NO_CLARIFY=${configFull.noClarify ? "1" : "0"}`,
      ...configFull.warnings.map((w) => `⚠ ${w}`),
      `探针：ask-user ${probe.askUser.ok ? "✓" : "✗"}｜subagent-workflow API ${probe.subagentApi.ok ? "✓" : "✗"}｜cw 库 ${probe.cwLib.ok ? "✓" : "✗"}｜clarify ${probe.clarify ? "✓" : "✗（自声明）"}`,
    ];
    ctx.ui.notify?.(lines.join("\n"), "info");
  }

  async function cmdReport(tokens: string[], ctx: ExtensionCommandContext): Promise<void> {
    const root = tokens.find((t) => !t.startsWith("--"));
    try {
      const { stdout } = await execFileP("cw", ["report", ...(root !== undefined ? [root] : [])], { timeout: 60_000 });
      ctx.ui.notify?.(stdout || "（cw report 无输出）", "info");
    } catch (e) {
      const err = e as { message?: string; stdout?: string; stderr?: string };
      ctx.ui.notify?.(
        `cw report 失败：${err.stderr?.trim() ?? err.message ?? "未知错误"}\n（恢复动作：确认 cw CLI 在 PATH；npm i -g @zhushanwen/coding-workflow）`,
        "error",
      );
    }
  }

  function cmdTakeover(ctx: ExtensionCommandContext): void {
    // 最小实现（真 fork GUI 在 ph-i3）：打印现场 sessionFile 锚 + fork 指引
    if (backendRef === undefined || !running) {
      ctx.ui.notify?.("cw takeover: 当前无在跑 runner（无现场会话可接管）", "info");
      return;
    }
    const handles = backendRef.liveHandles();
    if (handles.length === 0) {
      ctx.ui.notify?.("cw takeover: 无在飞 subagent 会话", "info");
      return;
    }
    const lines = handles.map((h) => `- ${h.slug}：${h.sessionFile ?? "（sessionFile 未就绪——握手前）"}`);
    ctx.ui.notify?.(`cw takeover（ph-i2 最小形态）：现场会话锚\n${lines.join("\n")}\nfork 指引：pi --fork <sessionFile>（GUI 收件箱接管按钮在 ph-i3）`, "info");
  }

  async function cmdStop(ctx: ExtensionCommandContext): Promise<void> {
    if (!running) {
      ctx.ui.notify?.("cw stop: 当前无在跑 runner", "info");
      return;
    }
    await shutdown();
    ctx.ui.notify?.("cw: runner 已停止（在飞会话已 cancel，锁已释放；续接：/cw start 或 cw run）", "info");
  }

  let shutdownPromise: Promise<void> | undefined;
  /** 幂等（session_shutdown 与 /cw stop 可并发触发）：共享同一次收尾 Promise */
  function shutdown(): Promise<void> {
    if (shutdownPromise === undefined) shutdownPromise = doShutdown();
    return shutdownPromise;
  }
  async function doShutdown(): Promise<void> {
    if (backendRef !== undefined) backendRef.cancelAll();
    // 触发 runLoop 自身 SIGINT handler（killAll + release lock + 返回 1）
    signalStop();
    if (launchPromise !== undefined) {
      await Promise.race([launchPromise.catch(() => undefined), sleep(5_000)]);
    }
    // 兜底 unlink（heartbeat 重写竞态窗口的陈锁清理；幂等）
    if (rootId !== undefined) {
      try {
        unlinkSync(mirrorRunnerLockPath(mirrorGetCwHome(), process.cwd()));
      } catch {
        /* ENOENT 静默 */
      }
    }
    running = false;
  }

  const controller: CwRunnerController = {
    async handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const tokens = splitArgs(args);
      const sub = tokens[0] ?? "status";
      const rest = tokens.slice(1);
      if (sub === "start") return cmdStart(rest, ctx);
      if (sub === "status") return cmdStatus(ctx);
      if (sub === "report") return cmdReport(rest, ctx);
      if (sub === "takeover") return cmdTakeover(ctx);
      if (sub === "stop") return cmdStop(ctx);
      ctx.ui.notify?.(`cw: 未知子命令 "${sub}"（合法：start/status/report/takeover/stop）`, "error");
    },
    shutdown,
    describe(): { running: boolean; rootId?: string; config: RunnerConfig; warnings: string[] } {
      return { running, rootId, config: configFull, warnings: [...configFull.warnings] };
    },
  };

  pi.registerCommand("cw", {
    description: "coding-workflow runner：start <rootId> | status | report | takeover | stop",
    handler: (args: string, ctx: ExtensionCommandContext) => controller.handleCommand(args, ctx),
  });
  pi.on("session_shutdown", () => {
    void controller.shutdown();
  });
  return controller;
}

export default function cwRunnerExtension(pi: ExtensionAPI): void {
  // ph-i0 哨兵保留
  pi.registerCommand("cw-ping", {
    description: "Sentinel: verify the coding-workflow extension is loaded (ph-i0).",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify?.(`cw-extension-alive: pi-coding-workflow-extension loaded (${EXT_VERSION})`, "info");
    },
  });
  registerCwRunner(pi);
}

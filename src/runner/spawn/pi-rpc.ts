/**
 * pi 长驻 RPC 适配器（ph-i1 u-i1-b，design-hi-spawn-pi-rpc.md §3.1/§3.2 R3）。
 *
 * 与 pi.ts（一次性 `-p` print 模式）的差异：`--mode rpc` 长驻子进程经
 * rpc-client.ts（u-i1-a）驱动——握手 get_state 回填确定性 sessionAnchor、brief
 * 经 stdin prompt 命令全文注入、反思 followUp 对同一进程追加输入（K1）、
 * extension_ui_request 无头形态自动回 cancelled（K2）。返回 InteractiveSpawnHandle
 * （R1 可选扩展），human/pi 两既有适配器零改动。
 *
 * 已知绕开（rpc-client.ts 缺陷，u-i1-a 已交付不改，报告层记录）：
 *   - 未暴露 child.pid → SpawnResult.pid 以 -1 占位（协议层无 pid 通道）；
 *   - 未暴露 child.stderr 流 → stderrPath 建空文件作审计锚，子进程 stderr 不落盘。
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type PiAdapterOptions,resolvePiModel } from "./pi.js";
import { createRpcClient, RPC_EVENT, type RpcClient, type RpcUiRequest } from "./rpc-client.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  InteractiveSpawnHandle,
  SpawnResult,
} from "./types.js";

/** 受控 agentDir 缺省（与 ph-i0 installer 的 controlled profile 默认同源：~/.cw/agent-dir） */
export const DEFAULT_CW_AGENT_DIR = (): string => join(homedir(), ".cw", "agent-dir");

/** agentDir 解析：CW_AGENT_DIR env 覆盖，缺省受控目录（cw setup-agent-dir 建立） */
export function resolveCwAgentDir(): string {
  const override = process.env.CW_AGENT_DIR;
  return override !== undefined && override !== "" ? override : DEFAULT_CW_AGENT_DIR();
}

/** ask-user 扩展入口（designer 角色必需；npm 包 @zhushanwen/pi-ask-user 的 main = index.ts） */
export function askUserEntryPath(agentDir: string): string {
  return join(agentDir, "extensions", "ask-user", "index.ts");
}

/** 握手超时（get_state 无应答 → SPAWN_ERROR，设计 §3.1 失败路径 5s 指引同源） */
const HANDSHAKE_TIMEOUT_MS = 5_000;
/** 超时梯度的收尾提前量：T-2min steer WRAP_UP → T-1min abort → T SIGTERM（TIMEOUT） */
const STEER_LEAD_MS = 120_000;
const ABORT_LEAD_MS = 60_000;
/**
 * 梯度武装的最小剩余预算：timeout 仅比 steer 提前量多不到该值时，武装
 * steer/abort 两级定时器已无意义（首级 timer 距截止不足 10s，收尾指令来不及
 * 生效）——只挂最终 SIGTERM 单级梯度
 */
const GRADIENT_MIN_HEADROOM_MS = 10_000;

function artifactPaths(req: AgentSpawnRequest): {
  stdoutPath: string;
  stderrPath: string;
  sessionPath: string;
} {
  const base = `${req.unitId}.${req.role}`;
  return {
    // RPC 模式下子进程 stdout = JSONL 事件流，逐行 append 落盘于 .stdout（契约路径）
    stdoutPath: join(req.artifactDir, `${base}.stdout`),
    stderrPath: join(req.artifactDir, `${base}.stderr`),
    sessionPath: join(req.artifactDir, `${base}.session.json`),
  };
}

/** SPAWN_ERROR 结果句柄（探针拒派 / 握手失败共用：wait 立即结算，kill 幂等 no-op） */
function spawnErrorHandle(stdoutPath: string, stderrPath: string, detail: string): InteractiveSpawnHandle {
  appendFileSync(stderrPath, `[pi-rpc] ${detail}\n`, "utf-8");
  process.stderr.write(`[pi-rpc] ${detail}\n`);
  const result: SpawnResult = { exitCode: "SPAWN_ERROR", stdoutPath, stderrPath, pid: -1 };
  return {
    wait: () => Promise.resolve(result),
    kill: () => {},
    followUp: () => Promise.reject(new Error("pi-rpc: SPAWN_ERROR 句柄无交互能力")),
    waitForIdle: () => Promise.resolve(false),
    onUiRequest: () => {},
    done: () => Promise.resolve(result),
  };
}

export interface PiRpcCommand {
  command: string;
  args: string[];
}

/** 命令拼装（纯函数，验收可测）：R3 形态 */
export function buildPiRpcCommand(
  req: AgentSpawnRequest,
  agentDir: string,
  model: string,
): PiRpcCommand {
  const args = ["--mode", "rpc", "--no-extensions", "--approve"];
  if (req.role === "designer") {
    args.push("--extension", askUserEntryPath(agentDir));
  }
  if (req.role === "reviewer") {
    // D7 近期形态：reviewer 只读审查，排除 write/edit
    args.push("--exclude-tools", "write,edit");
  }
  args.push("--model", model, "--session-dir", req.artifactDir, "--name", `${req.unitId}-${req.role}`);
  return { command: "pi", args };
}

export function createPiRpcAdapter(opts?: PiAdapterOptions): AgentSpawnAdapter {
  return {
    name: "pi-rpc",
    spawn: async (req: AgentSpawnRequest): Promise<InteractiveSpawnHandle> => {
      const { stdoutPath, stderrPath, sessionPath } = artifactPaths(req);
      mkdirSync(req.artifactDir, { recursive: true });

      // 启动探针（B5）：designer 必需扩展在场校验，缺失拒派（不产生 spawn 产物）
      const agentDir = resolveCwAgentDir();
      if (req.role === "designer" && !existsSync(askUserEntryPath(agentDir))) {
        return spawnErrorHandle(
          stdoutPath,
          stderrPath,
          `启动探针拒派：受控 agentDir 缺 ask-user 扩展（${askUserEntryPath(agentDir)} 不存在）。` +
            `恢复动作：cw setup-agent-dir（默认安装到 ${agentDir}），或 CW_AGENT_DIR=<有效目录> 后重试。`,
        );
      }

      const { command, args } = buildPiRpcCommand(req, agentDir, resolvePiModel(opts, req));
      // stdout 事件流逐行落盘（append 语义，进证据链）
      closeSync(openSync(stdoutPath, "a"));
      closeSync(openSync(stderrPath, "a"));

      let client: RpcClient;
      try {
        client = createRpcClient({
          command,
          args,
          cwd: req.workdir,
          env: {
            ...process.env,
            ...req.env,
            CW_PROJECT_DIR: req.projectCwd,
            PI_CODING_AGENT_DIR: agentDir,
          },
          onEvent: (event) => {
            appendFileSync(stdoutPath, `${JSON.stringify(event)}\n`, "utf-8");
          },
        });
      } catch (e) {
        return spawnErrorHandle(
          stdoutPath,
          stderrPath,
          `rpc 子进程起不来：${e instanceof Error ? e.message : String(e)}。` +
            "恢复动作：确认 pi 在 PATH（pi --version ≥0.84）。",
        );
      }

      // 握手：get_state 回填 sessionAnchor + 锚文件；失败 → SPAWN_ERROR + 恢复指引
      let sessionAnchor: InteractiveSpawnHandle["sessionAnchor"];
      try {
        const state = await Promise.race([
          client.getState(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`pi rpc 握手失败（get_state ${HANDSHAKE_TIMEOUT_MS}ms 无应答）`)),
              HANDSHAKE_TIMEOUT_MS,
            ),
          ),
        ]);
        sessionAnchor =
          state.sessionFile !== undefined
            ? { sessionId: state.sessionId, sessionFile: state.sessionFile }
            : { sessionId: state.sessionId, sessionFile: "" };
        writeFileSync(sessionPath, `${JSON.stringify({ ...sessionAnchor, unitId: req.unitId, role: req.role, ts: new Date().toISOString() })}\n`, "utf-8");
      } catch (e) {
        client.kill();
        return spawnErrorHandle(
          stdoutPath,
          stderrPath,
          `pi rpc 握手失败：${e instanceof Error ? e.message : String(e)}。` +
            "恢复动作：检查 pi --version ≥0.84 / CW_AGENT_DIR 指向有效目录 / --extension 路径存在。",
        );
      }

      // 无头穿透降级（K2 / B2）：ui_request 自动回 cancelled + stderr 告警
      client.onUiRequest((req_: RpcUiRequest) => {
        process.stderr.write(
          `[pi-rpc] 无 UI 通道，已取消（unit "${req.unitId}" 的 extension_ui_request ${req_.method} id=${req_.id}）\n`,
        );
        client.respondUi(req_.id, { type: RPC_EVENT.extensionUiResponse, id: req_.id, cancelled: true });
      });

      // brief 经 stdin prompt 命令全文注入（RPC 模式下 prompt 即消息体）
      const brief = readFileSync(req.briefPath, "utf-8");
      const promptPromise = client.prompt(brief).catch((e: unknown) => {
        process.stderr.write(
          `[pi-rpc] brief prompt 注入失败（unit "${req.unitId}"）：${e instanceof Error ? e.message : String(e)}\n`,
        );
      });

      // 结算通道：进程自然退出（code/signal）或超时梯度 kill
      let settled: ((r: SpawnResult) => void) | null = null;
      const settledPromise = new Promise<SpawnResult>((resolve) => {
        settled = resolve;
      });
      let killedByTimeout = false;
      const timers: NodeJS.Timeout[] = [];
      client.exited().then((info) => {
        for (const t of timers) clearTimeout(t);
        const result: SpawnResult = killedByTimeout
          ? { exitCode: "TIMEOUT", stdoutPath, stderrPath, pid: -1 }
          : info.code !== null
            ? { exitCode: info.code, stdoutPath, stderrPath, pid: -1 }
            : { exitCode: "CRASH", stdoutPath, stderrPath, pid: -1 };
        settled?.(result);
      });
      // 超时梯度：steer WRAP_UP → abort → SIGTERM（killedByTimeout 置位 → TIMEOUT）
      if (req.timeoutMs > STEER_LEAD_MS + GRADIENT_MIN_HEADROOM_MS) {
        timers.push(
          setTimeout(() => {
            void client.steer("WRAP_UP：请立即收尾并提交现有结论。").catch(() => undefined);
          }, req.timeoutMs - STEER_LEAD_MS),
        );
        timers.push(
          setTimeout(() => {
            void client.abort().catch(() => undefined);
          }, req.timeoutMs - ABORT_LEAD_MS),
        );
      }
      timers.push(
        setTimeout(() => {
          killedByTimeout = true;
          client.kill();
        }, req.timeoutMs),
      );

      return {
        wait: () => settledPromise,
        kill: () => {
          killedByTimeout = true; // 外部显式 kill 视为超时收束（loop 的兜底回收）
          client.kill();
        },
        followUp: async (text: string) => {
          await promptPromise; // 首轮 prompt 未确认前不追加（协议序稳定性）
          await client.followUp(text);
        },
        waitForIdle: (ms: number) => client.waitForIdle(ms),
        onUiRequest: (cb: (req: { id: string; method: string }) => void) => {
          client.onUiRequest(cb);
        },
        done: async () => {
          for (const t of timers) clearTimeout(t);
          try {
            await client.stop();
          } catch {
            client.kill();
          }
          return settledPromise;
        },
        sessionAnchor,
      };
    },
  };
}


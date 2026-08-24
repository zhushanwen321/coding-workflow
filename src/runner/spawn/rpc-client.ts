/**
 * 薄 RPC client（design-hi-spawn-pi-rpc.md §3.2 R6）。
 *
 * 自研原因：pi 包的 RpcClient 未通过 exports 公开（实测 ERR_PACKAGE_PATH_NOT_EXPORTED），
 * 本模块是协议子集的对侧镜像——不 import pi 包，只依赖 stdin JSON 行命令 / stdout JSONL
 * 事件流这一进程契约。
 *
 * 实现子集（pi 0.84.2 rpc-types.d.ts 实读比对）：
 *   命令：prompt / follow_up / steer / abort / get_state
 *   事件：response（按 id 关联的命令应答）/ agent_settled / extension_ui_request
 *   应答：extension_ui_response（value / confirmed / cancelled 三形态）
 *
 * 时序竞争（设计待验证检查点②）的实测结论——见 tests/i1a-rpc-client.test.ts：
 * pi 的 prompt 应答在 preflight 成功时即发出（早于流式完成），agent_settled 在流式
 * 结束后才发；但 settled 完全可能先于调用方挂起 waitForIdle 到达。因此本 client 维护
 * settledSinceLastCommand 标志：收到 agent_settled 置位，发送 prompt/follow_up/steer
 * 清位——waitForIdle 在标志已置位时立即 resolve，两种到达顺序下语义都正确。
 */
import { type ChildProcessWithoutNullStreams,spawn } from "node:child_process";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// 协议常量（HP6 版本握门的比对源；与 pi 0.84.2 dist/modes/rpc/rpc-types.d.ts 实读一致）
// ---------------------------------------------------------------------------

/** 本 client 实现的命令 type 字符串（32 条全集的子集） */
export const RPC_COMMAND = {
  prompt: "prompt",
  followUp: "follow_up",
  steer: "steer",
  abort: "abort",
  getState: "get_state",
} as const;

/** 本 client 消费的 stdout 事件 / stdin 应答 type 字符串 */
export const RPC_EVENT = {
  /** 命令应答（按 id 关联） */
  response: "response",
  /** agent 流式结束（waitForIdle 的 resolve 锚） */
  agentSettled: "agent_settled",
  /** extension 需要用户输入 */
  extensionUiRequest: "extension_ui_request",
  /** 对 extension_ui_request 的应答（写入 stdin） */
  extensionUiResponse: "extension_ui_response",
} as const;

export type RpcCommandType = (typeof RPC_COMMAND)[keyof typeof RPC_COMMAND];

/** send() 缺省超时（ms） */
const DEFAULT_SEND_TIMEOUT_MS = 60_000;
/** stop() stdin EOF 后等待进程退出的宽限（ms），超时回落 kill */
const STOP_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// 类型（协议子集的本仓自声明，不 import pi 包）
// ---------------------------------------------------------------------------

/** pi RpcSessionState 的消费子集镜像 */
export interface RpcSessionState {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

/** 命令成功应答（error 应答走 reject，不进入数据面） */
export interface RpcReply {
  id?: string;
  command: string;
  data?: unknown;
}

/** extension_ui_request 的最小消费形态（九种 method 的公共字段） */
export interface RpcUiRequest {
  type: typeof RPC_EVENT.extensionUiRequest;
  id: string;
  method: string;
  [key: string]: unknown;
}

/** extension_ui_response 三形态 */
export type RpcUiResponse =
  | { type: typeof RPC_EVENT.extensionUiResponse; id: string; value: string }
  | { type: typeof RPC_EVENT.extensionUiResponse; id: string; confirmed: boolean }
  | { type: typeof RPC_EVENT.extensionUiResponse; id: string; cancelled: true };

export interface RpcClientOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** stdout 事件流订阅（response / agent_settled / extension_ui_request 全量转发） */
  onEvent?: (event: Record<string, unknown>) => void;
  /** send() 缺省超时（ms）；waitForIdle 有独立参数 */
  sendTimeoutMs?: number;
}

export interface RpcClient {
  send(cmd: Record<string, unknown>): Promise<RpcReply>;
  prompt(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<RpcSessionState>;
  waitForIdle(ms: number): Promise<boolean>;
  onUiRequest(cb: (req: RpcUiRequest) => void): void;
  respondUi(id: string, resp: RpcUiResponse): void;
  /** stdin EOF 优雅退出（等进程退出，超时回落 kill） */
  stop(): Promise<void>;
  kill(): void;
  /** 子进程退出 promise（code / signal 审计用） */
  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (reply: RpcReply) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export function createRpcClient(opts: RpcClientOptions): RpcClient {
  const child: ChildProcessWithoutNullStreams = spawn(opts.command, opts.args, {
    env: opts.env,
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 0;
  const pending = new Map<string, Pending>();
  const uiListeners = new Set<(req: RpcUiRequest) => void>();
  /** 自最近一次 prompt/follow_up/steer 以来是否已观测到 agent_settled */
  let settledSinceLastCommand = false;
  let settledWaiter: (() => void) | null = null;
  let _badLines = 0;
  let lastError: Error | null = null;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("exit", (code, signal) => {
        exitInfo = { code, signal };
        failAll(new Error(`rpc 子进程已退出（code=${code} signal=${signal}）`));
        resolve(exitInfo);
      });
    },
  );

  child.on("error", (err) => {
    lastError = err;
    failAll(err);
  });
  child.stdin.on("error", (err) => {
    lastError = err instanceof Error ? err : new Error(String(err));
    failAll(lastError);
  });

  function failAll(err: Error): void {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(err);
    }
  }

  function isResponse(line: unknown): line is RpcReply & { success: boolean; error?: string } {
    return (
      typeof line === "object" &&
      line !== null &&
      (line as Record<string, unknown>).type === RPC_EVENT.response
    );
  }

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 坏行容忍：stdout 杂音不致命，计数后跳过（stderr 直通不解析）
      _badLines += 1;
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      _badLines += 1;
      return;
    }
    const event = parsed as Record<string, unknown>;
    opts.onEvent?.(event);

    if (isResponse(event)) {
      const id = typeof event.id === "string" ? event.id : undefined;
      if (id !== undefined) {
        const p = pending.get(id);
        if (p) {
          pending.delete(id);
          clearTimeout(p.timer);
          if (event.success) p.resolve({ id: event.id, command: event.command, data: event.data });
          else p.reject(new Error(`rpc ${String(event.command)} 失败: ${String(event.error ?? "未知错误")}`));
        }
      }
      return;
    }
    if (event.type === RPC_EVENT.agentSettled) {
      settledSinceLastCommand = true;
      settledWaiter?.();
      return;
    }
    if (event.type === RPC_EVENT.extensionUiRequest) {
      for (const cb of uiListeners) cb(event as RpcUiRequest);
    }
  });

  function guardAlive(action: string): void {
    if (exitInfo !== null || lastError !== null) {
      const detail = exitInfo
        ? `子进程已退出（code=${exitInfo.code} signal=${exitInfo.signal}）`
        : String(lastError?.message ?? "spawn 失败");
      throw new Error(`rpc ${action} 失败: ${detail}`);
    }
  }

  function send(cmd: Record<string, unknown>): Promise<RpcReply> {
    guardAlive("send");
    const id = `cw-${nextId++}`;
    return new Promise<RpcReply>((resolve, reject) => {
      const timeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc 命令 ${String(cmd.type)} 超时（${timeoutMs}ms 无应答）`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`, (err) => {
        if (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /** 会引发流式的命令：清 settled 标志，使随后的 waitForIdle 语义正确 */
  async function sendStreaming(cmd: Record<string, unknown>): Promise<void> {
    settledSinceLastCommand = false;
    await send(cmd);
  }

  async function getState(): Promise<RpcSessionState> {
    const reply = await send({ type: RPC_COMMAND.getState });
    if (typeof reply.data !== "object" || reply.data === null) {
      throw new Error("rpc get_state 应答缺 data");
    }
    const d = reply.data as Record<string, unknown>;
    if (typeof d.sessionId !== "string") throw new Error("rpc get_state 应答缺 sessionId");
    return {
      sessionId: d.sessionId,
      sessionFile: typeof d.sessionFile === "string" ? d.sessionFile : undefined,
      sessionName: typeof d.sessionName === "string" ? d.sessionName : undefined,
      isStreaming: d.isStreaming === true,
      isCompacting: d.isCompacting === true,
      messageCount: typeof d.messageCount === "number" ? d.messageCount : 0,
      pendingMessageCount:
        typeof d.pendingMessageCount === "number" ? d.pendingMessageCount : 0,
    };
  }

  function waitForIdle(ms: number): Promise<boolean> {
    // settled 先到（先于本调用挂起）也必须正确 resolve——标志已置位即视为 idle
    if (settledSinceLastCommand) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      settledWaiter = () => {
        settledWaiter = null;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settledWaiter) {
          settledWaiter = null;
          resolve(false);
        }
      }, ms);
    });
  }

  function respondUi(id: string, resp: RpcUiResponse): void {
    if (resp.id !== id) throw new Error("respondUi: resp.id 与请求 id 不一致");
    child.stdin.write(`${JSON.stringify(resp)}\n`);
  }

  async function stop(): Promise<void> {
    child.stdin.end();
    const timer = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`rpc stop 超时（stdin EOF 后 ${STOP_GRACE_MS}ms 未退出）`)),
        STOP_GRACE_MS,
      ),
    );
    try {
      await Promise.race([exitPromise, timer]);
    } catch {
      kill();
      await exitPromise;
    }
  }

  function kill(): void {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }

  return {
    send,
    prompt: (text) => sendStreaming({ type: RPC_COMMAND.prompt, message: text }),
    followUp: (text) => sendStreaming({ type: RPC_COMMAND.followUp, message: text }),
    steer: (text) => sendStreaming({ type: RPC_COMMAND.steer, message: text }),
    abort: async () => {
      await send({ type: RPC_COMMAND.abort });
    },
    getState,
    waitForIdle,
    onUiRequest: (cb) => {
      uiListeners.add(cb);
    },
    respondUi,
    stop,
    kill,
    exited: () => exitPromise,
  };
}

/**
 * subagent-workflow 后端适配器（ph-i2 u-i2-b，design-hi-cw-runner-extension §3.2 R3）。
 *
 * 把 pi-1 交付的编程 SpawnManager API（createSpawnManager）适配为 cw 的
 * AgentSpawnAdapter，返回 InteractiveSpawnHandle（缝契约 import 自
 * `@zhushanwen/coding-workflow/runner`，ph-i1 交付的同源投影）。
 *
 * 七条已知偏离的对齐（勿按设计文档理想形态写）：
 *  ① wait() 是 round 粒度非一次性 → 本层 while 循环聚合到会话终态才结算
 *  ② cancel(force) 同 graceful → kill 与 done 都走 cancel()，区分靠自记账 flag
 *  ③ start 多 agent?/thinkingLevel?（透传位，本适配器不填）
 *  ④ onUiRequest/onSettled 是订阅式事件对象（返回取消订阅函数）
 *  ⑤ sessionFile 是 getter（握手前 undefined → sessionAnchor 延迟取）
 *  ⑥ message() round 进行中抛错 → followUp 先 wait() 结算当前 round 再 message
 *  ⑦ conversation 存活占并发槽（SpawnManager 自管，本层不感知）
 *
 * SpawnResult 产物策略（checkpoint ② 裁决）：**真实内容 append**——每轮
 * wait() 的 text 追加写 `<artifactDir>/<unitId>.<role>.stdout`，error/reason
 * 诊断写 `.stderr`。理由：SubagentHandle 未暴露 SpawnManager 的 topic 产物路径
 * （无法复制/链接），而 SpawnResult 契约要求 stdoutPath 真实存在且进证据链——
 * 轮文本 append 让证据自包含，优于指针文件（指针需读者二次跳转且目标路径不可得）。
 * pid：SubagentHandle 无 pid 通道，以 -1 占位（pi-rpc 适配器同款先例）。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  InteractiveSpawnHandle,
  SpawnResult,
} from "@zhushanwen/coding-workflow/runner";

// ---- SpawnManager 结构化镜像（duck-typed；运行时经 probe 探测式动态 import，不走静态 TS 解析） ----

export interface SmWaitResult {
  status: "done" | "failed" | "cancelled";
  text: string;
  turns: number;
  error?: string;
  round: number;
  settled: boolean;
  reason?: string;
}

export interface SmSubagentHandle {
  id: string;
  slug: string;
  readonly sessionFile?: string;
  readonly settled: boolean;
  wait(): Promise<SmWaitResult>;
  message(text: string): Promise<void>;
  cancel(force?: boolean): void;
}

export interface SmUiRequestEvent {
  handleId: string;
  id: string;
  request: { method?: string } & Record<string, unknown>;
}

export interface SmSpawnManager {
  start(opts: {
    task: string;
    slug: string;
    cwd?: string;
    tools?: string[];
    excludeTools?: string[];
    appendSystemPrompt?: string[];
    env?: Record<string, string>;
    maxTurns?: number;
    idleTimeoutMs?: number;
    [k: string]: unknown;
  }): Promise<SmSubagentHandle>;
  list(): SmSubagentHandle[];
  onUiRequest(cb: (ev: SmUiRequestEvent) => void): () => void;
  onSettled(cb: (ev: SmWaitResult & { handleId: string }) => void): () => void;
}

/** 角色工具面（D7）：reviewer 结构隔离 = 排写工具；designer/developer 全量 */
const ROLE_TOOL_POLICY: Record<AgentSpawnRequest["role"], { excludeTools?: string[]; persona: string }> = {
  designer: { persona: "[cw] 你是 designer：产出 spec，歧义处用 ask_user 提问（若有此通道）。" },
  developer: { persona: "[cw] 你是 developer：按 spec 交 build/spec 证据，走 cw 命令面。" },
  reviewer: {
    excludeTools: ["write", "edit"],
    persona: "[cw] 你是独立 reviewer：只读审查，结论经 cw review submit 提交。（ph-i2 后续补完整人设文案）",
  },
};

/** 诊断行落 .stderr（append，进证据链） */
function logDiag(stderrPath: string, line: string): void {
  appendFileSync(stderrPath, `[subagent-backend] ${line}\n`, "utf-8");
}

function artifactPaths(req: AgentSpawnRequest): { stdoutPath: string; stderrPath: string } {
  const base = `${req.unitId}.${req.role}`;
  return {
    stdoutPath: join(req.artifactDir, `${base}.stdout`),
    stderrPath: join(req.artifactDir, `${base}.stderr`),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * P1-5：followUp 预结算窗口。pi-1 实测 wait() 在 idle 态阻塞（等下一个 round
 * 结算），无条件 await 会永久挂起——窗口仅用于兼容「round 真在飞」时先消费再
 * message 的旧语义；典型反思序列（waitForIdle 已消费 idle 锚）窗口耗尽直接发。
 */
const FOLLOW_UP_ROUND_WINDOW_MS = 250;

/**
 * 造后端适配器。mgr 来自探测式 import 的 createSpawnManager(pi)（index.ts 启动时
 * 注入）；测试注入「真实协议桩」形态的最小 SpawnManager 实现（非 mock 框架）。
 * 返回 adapter + cancelAll（session_shutdown / /cw stop 的在飞会话收口）。
 */
export interface SubagentBackend {
  adapter: AgentSpawnAdapter;
  /** cancel 全部在飞会话（幂等；已结算的跳过） */
  cancelAll(): void;
  /** 在飞会话清单（takeover 命令打印 sessionFile 锚用） */
  liveHandles(): Array<{ id: string; slug: string; sessionFile?: string }>;
}

export function createSubagentBackend(mgr: SmSpawnManager): SubagentBackend {
  const live = new Set<SmSubagentHandle>();
  return {
    adapter: {
    name: "subagent",
    async spawn(req: AgentSpawnRequest): Promise<InteractiveSpawnHandle> {
      const { stdoutPath, stderrPath } = artifactPaths(req);
      mkdirSync(req.artifactDir, { recursive: true });
      writeFileSync(stdoutPath, "", { flag: "a" });
      writeFileSync(stderrPath, "", { flag: "a" });

      const policy = ROLE_TOOL_POLICY[req.role];
      let brief: string;
      try {
        brief = readFileSync(req.briefPath, "utf-8");
      } catch (e) {
        logDiag(stderrPath, `brief 不可读（SPAWN_ERROR）：${req.briefPath}: ${e instanceof Error ? e.message : String(e)}`);
        const result: SpawnResult = { exitCode: "SPAWN_ERROR", stdoutPath, stderrPath, pid: -1 };
        return {
          wait: () => Promise.resolve(result),
          kill: () => {},
          followUp: () => Promise.reject(new Error("subagent-backend: SPAWN_ERROR 句柄无交互能力")),
          waitForIdle: () => Promise.resolve(false),
          onUiRequest: () => {},
          done: () => Promise.resolve(result),
        };
      }

      let handle: SmSubagentHandle;
      try {
        handle = await mgr.start({
          task: brief,
          slug: `${req.unitId}-${req.role}`,
          cwd: req.workdir,
          env: req.env,
          ...(policy.excludeTools !== undefined ? { excludeTools: policy.excludeTools } : {}),
          appendSystemPrompt: [policy.persona],
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logDiag(stderrPath, `SpawnManager.start 抛错（SPAWN_ERROR）：${msg}`);
        const result: SpawnResult = { exitCode: "SPAWN_ERROR", stdoutPath, stderrPath, pid: -1 };
        return {
          wait: () => Promise.resolve(result),
          kill: () => {},
          followUp: () => Promise.reject(new Error("subagent-backend: SPAWN_ERROR 句柄无交互能力")),
          waitForIdle: () => Promise.resolve(false),
          onUiRequest: () => {},
          done: () => Promise.resolve(result),
        };
      }
      logDiag(stderrPath, `spawn ok：handle=${handle.id} slug=${handle.slug}`);
      live.add(handle);

      // 自记账（偏离②：cancel(force) 同 graceful，语义区分只能本层记）：
      // done() 发起 → 终态 cancelled 映射 exit 0；kill()/外部 cancel → 映射 CRASH（可重派）
      let gracefulDone = false;
      let finished: SpawnResult | undefined;
      let waitChain: Promise<SpawnResult> | undefined;

      /**
       * 单一轮次等待者（P1-6 收口）：pi-1 实测 wait() 是广播队列——每个 pending
       * waiter 都拿到同一轮结果。本层所有消费点（settleLoop / waitForIdle /
       * followUp 预结算窗口）都必须经 nextRound() 取轮，同一轮同一时刻只存在一个
       * 在飞 wait() 调用；轮 text 的 append 落盘也只在结算副作用处发生一次——
       * 多个消费者观察同一轮，证据链只写一份（adversarial R6）。
       */
      let pendingRound: Promise<SmWaitResult> | null = null;
      function nextRound(): Promise<SmWaitResult> {
        if (pendingRound === null) {
          const p = handle
            .wait()
            .then((r) => {
              if (r.text !== "") appendFileSync(stdoutPath, r.text, "utf-8");
              if (r.error !== undefined) logDiag(stderrPath, `round ${r.round} error: ${r.error}`);
              return r;
            })
            .finally(() => {
              if (pendingRound === p) pendingRound = null;
            });
          pendingRound = p;
        }
        return pendingRound;
      }

      /** 聚合循环（偏离①）：round 粒度 wait() 连续聚合到会话终态，每轮 text append 落 .stdout */
      async function settleLoop(timeoutMs: number): Promise<SpawnResult> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const remain = deadline - Date.now();
          if (remain <= 0) {
            handle.cancel();
            return finish({ exitCode: "TIMEOUT", stdoutPath, stderrPath, pid: -1 });
          }
          let round: SmWaitResult;
          try {
            round = await Promise.race([
              nextRound(),
              sleep(remain).then(() => {
                throw new Error("__timeout__");
              }),
            ]);
          } catch (e) {
            if (e instanceof Error && e.message === "__timeout__") {
              handle.cancel();
              logDiag(stderrPath, `超时（${timeoutMs}ms）已 cancel，结算 TIMEOUT`);
              return finish({ exitCode: "TIMEOUT", stdoutPath, stderrPath, pid: -1 });
            }
            throw e;
          }
          // text append 与 error 诊断在 nextRound() 结算副作用单点完成（R6）
          if (!round.settled) continue;
          // 终态映射：done→0；failed→1（可重派）；cancelled→done() 发起=0 / kill 或外部=CRASH
          let exitCode: SpawnResult["exitCode"];
          if (round.status === "done") exitCode = 0;
          else if (round.status === "failed") exitCode = 1;
          else exitCode = gracefulDone ? 0 : "CRASH";
          if (round.reason !== undefined) {
            logDiag(stderrPath, `终态：status=${round.status} reason=${round.reason}`);
          }
          return finish({ exitCode, stdoutPath, stderrPath, pid: -1 });
        }
      }

      function finish(result: SpawnResult): SpawnResult {
        finished = result;
        live.delete(handle);
        return result;
      }

      /** waitChain 单飞：并发 wait()/done() 共享同一次聚合循环 */
      function ensureWaitChain(timeoutMs: number): Promise<SpawnResult> {
        if (waitChain === undefined) {
          const chain: Promise<SpawnResult> = settleLoop(timeoutMs).catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            logDiag(stderrPath, `聚合循环抛错（按 CRASH 结算）：${msg}`);
            return finish({ exitCode: "CRASH", stdoutPath, stderrPath, pid: -1 });
          });
          waitChain = chain;
          return chain;
        }
        return waitChain;
      }

      return {
        async wait(): Promise<SpawnResult> {
          return ensureWaitChain(req.timeoutMs);
        },
        kill(): void {
          handle.cancel();
        },
        async followUp(text: string): Promise<void> {
          if (handle.settled) {
            throw new Error("subagent-backend: 会话已终态，followUp 不可用（偏离⑥/⑦）");
          }
          // 偏离⑥改（P1-5）：pi-1 实测 wait() 是「等下一个 round 结算」语义——idle
          // 态（无在飞 round、未终态）调用会阻塞到 idle-timeout/永久挂起，不能
          // 无条件 await。带短窗 race：窗口内结算的 round 消费落盘（round 真在飞
          // 的旧语义兼容）；窗口耗尽（典型 = waitForIdle 已消费 idle 锚后的反思
          // 序列）直接 message（pi-1 idle 态 sendFollowUp 即开始新 round）
          const round = await Promise.race([
            nextRound(),
            sleep(FOLLOW_UP_ROUND_WINDOW_MS).then(() => null),
          ]);
          if (round !== null && round.settled) {
            throw new Error("subagent-backend: followUp 前会话已终态，无法追问");
          }
          await handle.message(text);
        },
        async waitForIdle(ms: number): Promise<boolean> {
          const deadline = Date.now() + ms;
          for (;;) {
            if (handle.settled) return true;
            const remain = deadline - Date.now();
            if (remain <= 0) return false;
            // 复用单一轮次等待者（R6）：round 结算（含 text append 副作用）只发生一次
            const winner = await Promise.race([
              nextRound().then(() => "round" as const),
              sleep(Math.min(remain, 200)).then(() => "tick" as const),
            ]);
            if (winner === "round") return true;
          }
        },
        onUiRequest(cb: (req: { id: string; method: string }) => void): void {
          mgr.onUiRequest((ev) => {
            if (ev.handleId !== handle.id) return;
            cb({ id: ev.id, method: ev.request?.method ?? "unknown" });
          });
        },
        async done(): Promise<SpawnResult> {
          gracefulDone = true;
          handle.cancel(); // 偏离②：graceful 即缺省
          // 终态映射通常立即可得；短兜底轮询防 cancel 后 settle 延迟
          const result = await ensureWaitChain(10_000);
          return result;
        },
        get sessionAnchor(): { sessionId: string; sessionFile: string } | undefined {
          const sf = handle.sessionFile; // 偏离⑤：getter，握手前 undefined
          return sf !== undefined ? { sessionId: handle.id, sessionFile: sf } : undefined;
        },
      };
    },
    },
    cancelAll(): void {
      for (const h of live) h.cancel();
    },
    liveHandles(): Array<{ id: string; slug: string; sessionFile?: string }> {
      return [...live].map((h) => ({ id: h.id, slug: h.slug, sessionFile: h.sessionFile }));
    },
  };
}

export const ROLE_POLICY_TABLE = ROLE_TOOL_POLICY;

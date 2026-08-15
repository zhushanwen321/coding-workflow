/**
 * pi 无头 CLI 适配器（u6c，验收文档 docs/rewrite/acceptance/u6c-acceptance.md 锁定）。
 *
 * AgentSpawn 缝的第一个真实 harness 接入：canon《design-child-spawn.md》§7——适配器
 * 差异只在 spawn 内部的命令拼装与 env 翻译层；进程级语义（stdio 落盘 / 超时整树
 * kill / 四态归因）全部经 u6a lifecycle.spawnProcess，本模块不复刻。
 *
 * 实测事实（2026-08-15 已核实，命令形态以此为准）：
 *   - pi 无 PI_MODEL 环境变量（源码 grep 确认）、-m 简写不存在 → 模型只能走
 *     --model 参数，三级取值优先级见 resolvePiModel；
 *   - 无头形态 `pi --model <provider/id> -p --no-session @<briefPath>`；
 *   - brief 用 @file 位置参数传递（file-based，防 prompt 注入），不走 stdin / $(cat)；
 *   - 本地扩展可能向 stderr 写报错噪音，但 exitCode 与 stdout 不受影响 →
 *     本层不解读 stderr，判定只看 exitCode + stdout。
 */
import { join } from "node:path";

import { spawnProcess } from "./lifecycle.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
  SpawnResult,
} from "./types.js";

export interface PiAdapterOptions {
  /** 固定模型（优先级最高，覆盖两级 CW_AGENT_MODEL env） */
  model?: string;
  /** 追加到命令尾部的 pi 参数（如插件开关） */
  extraArgs?: readonly string[];
}

/** 三级取值全空时的缺省模型（实测可见可用的轻量模型） */
const DEFAULT_PI_MODEL = "xiaomi-token-plan-cn/mimo-v2.5-pro";

/**
 * 模型取值翻译层（纯函数）：opts.model > req.env.CW_AGENT_MODEL >
 * process.env.CW_AGENT_MODEL > DEFAULT_PI_MODEL。
 * pi 无 PI_MODEL env（实测），模型选择只能在适配器内解析后走 --model 参数；
 * runner 可按派发对象在 req.env 粒度换模型，部署方可全局 env 设兜底。
 */
export function resolvePiModel(
  opts: PiAdapterOptions | undefined,
  req: AgentSpawnRequest,
): string {
  if (opts?.model !== undefined) {
    return opts.model;
  }
  const fromReq = req.env?.CW_AGENT_MODEL;
  if (fromReq !== undefined) {
    return fromReq;
  }
  const fromProcess = process.env.CW_AGENT_MODEL;
  if (fromProcess !== undefined) {
    return fromProcess;
  }
  return DEFAULT_PI_MODEL;
}

/** 命令拼装结果（喂给 lifecycle.spawnProcess） */
export interface PiCommand {
  command: string;
  args: string[];
}

/**
 * 命令拼装（纯函数，验收文档锁定签名 buildPiCommand(req, model)；extraArgs 可选追加）：
 * `pi --model <model> -p --no-session @<briefPath>`。
 */
export function buildPiCommand(
  req: AgentSpawnRequest,
  model: string,
  extraArgs: readonly string[] = [],
): PiCommand {
  return {
    command: "pi",
    args: ["--model", model, "-p", "--no-session", `@${req.briefPath}`, ...extraArgs],
  };
}

/** 产物落盘约定（types.ts SpawnResult 注释同款）：<workdir>/.cw-spawn/<unitId>.<role>.stdout/.stderr */
function artifactPaths(req: AgentSpawnRequest): { stdoutPath: string; stderrPath: string } {
  return {
    stdoutPath: join(req.workdir, ".cw-spawn", `${req.unitId}.${req.role}.stdout`),
    stderrPath: join(req.workdir, ".cw-spawn", `${req.unitId}.${req.role}.stderr`),
  };
}

export function createPiAdapter(opts?: PiAdapterOptions): AgentSpawnAdapter {
  return {
    name: "pi",
    spawn: async (req: AgentSpawnRequest): Promise<SpawnHandle> => {
      const { stdoutPath, stderrPath } = artifactPaths(req);
      try {
        const { command, args } = buildPiCommand(
          req,
          resolvePiModel(opts, req),
          opts?.extraArgs,
        );
        return spawnProcess({
          command,
          args,
          cwd: req.workdir,
          // req.env 覆盖 process.env 子集的合并由 lifecycle 完成（适配器只透传）
          env: req.env,
          // 默认 30min 由调用方给（types.ts 必填），本层不另设缺省
          timeoutMs: req.timeoutMs,
          stdoutPath,
          stderrPath,
        });
      } catch {
        // lifecycle 同步抛（可执行解析预检 ENOENT 等）= 起不来 → 转译 SPAWN_ERROR
        // 语义：配置错误不重试。异步 error 兜底（PATH 缺失等预检未覆盖形态）已由
        // lifecycle 归因为 SPAWN_ERROR，两条路径在此对齐为同一四态出口。
        const spawnError: SpawnResult = {
          exitCode: "SPAWN_ERROR",
          stdoutPath,
          stderrPath,
          // 此态下无进程可指（契约：pid 占位 -1，与 lifecycle 异步失败分支同款）
          pid: -1,
        };
        return {
          wait: () => Promise.resolve(spawnError),
          kill: () => {
            // 无进程组可杀，幂等 no-op
          },
        };
      }
    },
  };
}

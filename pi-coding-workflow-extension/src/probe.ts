/**
 * /cw start 启动探针（ph-i2 u-i2-b，design-hi-cw-runner-extension §3.2 R4 + §3.3）。
 *
 * 三查（任一失败不做半通态）：
 *  ① 受控 agentDir ask-user 在场（clarify 通道前置；磁盘在场性 + 可选真实 pi RPC 握手深查）
 *  ② subagent-workflow 编程 API 可导入（探测式动态 import + createSpawnManager 存在性）
 *  ③ cw 引擎库可导入（@zhushanwen/coding-workflow/runner 的 runLoop）
 *
 * ② 失败 → /cw start 拒启（§3.1 失败路径文案）；①失败或 CW_RUNNER_NO_CLARIFY
 * → 全链降级自声明（clarify:false，designer 任务书注明「本次无提问通道」——
 * 真文案 ph-i2 后续，本层给 reasons 载体）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { probeLoadRpc } from "./installer/core.mjs";

export interface ProbeCheck {
  ok: boolean;
  detail: string;
}

export interface ProbeResult {
  /** 三查明细（/cw status 展示 ✓/✗） */
  askUser: ProbeCheck;
  subagentApi: ProbeCheck;
  cwLib: ProbeCheck;
  /** true = designer 可用 ask_user 提问通道（任一查失败或 NO_CLARIFY → false） */
  clarify: boolean;
  /** 降级原因（clarify=false 时非空；进任务书占位文案） */
  reasons: string[];
}

export interface ProbeOptions {
  /** 受控 agentDir（缺省 resolveCwAgentDir 同款：CW_AGENT_DIR 或 ~/.cw/agent-dir） */
  agentDir?: string;
  /** 深查（真实 pi --mode rpc 握手验证扩展加载链）开关；缺省 false = 磁盘在场性 */
  deep?: boolean;
  piBin?: string;
  timeoutMs?: number;
  /** subagent-workflow 模块标识（测试注入用） */
  subagentSpec?: string;
  /** cw 库模块标识（测试注入用） */
  cwLibSpec?: string;
  noClarify?: boolean;
}

/** 受控 agentDir 解析（与 cw 侧 src/runner/spawn/pi-rpc.ts resolveCwAgentDir 同源语义） */
export function resolveAgentDir(): string {
  const override = process.env.CW_AGENT_DIR;
  return override !== undefined && override !== "" ? override : join(process.env.HOME ?? "", ".cw", "agent-dir");
}

/** ②失败时的安装指引。本地开发态路径经 CW_LOCAL_SUBAGENT_DIR 注入——个人绝对路径不得随 npm 发布进他人错误信息 */
export function subagentInstallGuide(): string {
  const base =
    "subagent-workflow 编程 API（createSpawnManager）不在场：npx @zhushanwen/pi-coding-workflow-extension install（会连依赖装入）；";
  const localDir = process.env.CW_LOCAL_SUBAGENT_DIR;
  if (localDir !== undefined && localDir !== "") {
    return `${base}本地开发态：npm install ${localDir} --no-save 装入插件包`;
  }
  return `${base}本地开发态：设 CW_LOCAL_SUBAGENT_DIR=<本地 subagent-workflow 仓路径> 后重试，或 npm install <该仓路径> --no-save`;
}

/** ①ask-user 磁盘在场性：manifest.json 登记 + extensions/ask-user 入口存在 */
export function checkAskUserOnDisk(agentDir: string): ProbeCheck {
  const entry = join(agentDir, "extensions", "ask-user", "index.ts");
  if (!existsSync(entry)) {
    return { ok: false, detail: `ask-user 不在场：${entry} 不存在（恢复：pi-cw-install install --profile controlled）` };
  }
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(agentDir, "manifest.json"), "utf-8"));
    const pkgs = (manifest as { packages?: Record<string, unknown> }).packages;
    if (pkgs === undefined || !("ask-user" in pkgs)) {
      return { ok: false, detail: "ask-user 文件在场但 manifest.json 未登记（重装受控通道以修复登记）" };
    }
  } catch {
    return { ok: false, detail: `manifest.json 缺失或不可解析：${join(agentDir, "manifest.json")}` };
  }
  return { ok: true, detail: `ask-user 在场：${entry}` };
}

/** ①深查：真实 pi --mode rpc 握手 + ask-user 显式注入（复用 installer probeLoadRpc） */
export async function checkAskUserDeep(opts: { agentDir: string; piBin?: string; timeoutMs?: number }): Promise<ProbeCheck> {
  const r = await probeLoadRpc({
    piBin: opts.piBin ?? "pi",
    agentDir: opts.agentDir,
    extensions: [join(opts.agentDir, "extensions", "ask-user", "index.ts")],
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  return { ok: r.ok, detail: r.ok ? "pi RPC 握手通过（ask-user 加载链真实验证）" : `pi RPC 握手失败：${r.output.slice(0, 300)}` };
}

/** ②subagent-workflow 编程 API 探测式导入（spec 故意宽型 string：防 TS 静态解析 .ts 入口包）。
 * 已知实态偏离（pi-1 打包）：包根 index.ts 只 re-export extension default，
 * createSpawnManager 在 ./src/index.ts——根命名导出缺失时回落子路径。 */
export async function checkSubagentApi(spec: string = "@zhushanwen/pi-subagent-workflow"): Promise<ProbeCheck> {
  const tryImport = async (s: string): Promise<Record<string, unknown> | undefined> => {
    try {
      return (await import(s)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  const root = await tryImport(spec);
  if (root !== undefined && typeof root.createSpawnManager === "function") {
    return { ok: true, detail: "subagent-workflow 编程 API 在场（createSpawnManager 可导入）" };
  }
  // 已知实态偏离（pi-1 打包）：包根 index.ts 只 re-export extension default——回落子路径
  const sub = await tryImport(`${spec}/src/index.ts`);
  if (sub !== undefined && typeof sub.createSpawnManager === "function") {
    return { ok: true, detail: "subagent-workflow 编程 API 在场（经 ./src/index.ts 子路径——包根缺命名导出，已回报 pi-1）" };
  }
  if (root === undefined && sub === undefined) {
    return { ok: false, detail: `${subagentInstallGuide()}（导入失败：${spec} 不可解析）` };
  }
  return { ok: false, detail: `${subagentInstallGuide()}（已装版本无 createSpawnManager 导出——npm 上的 8.x 为无编程 API 的旧谱系，需含 API 的 2.0.0+ 构建且其未发 npm，按指引走本地开发态装入）` };
}

/** ③cw 引擎库探测式导入 */
export async function checkCwLib(spec: string = "@zhushanwen/coding-workflow/runner"): Promise<ProbeCheck> {
  let mod: unknown;
  try {
    mod = await import(spec);
  } catch (e) {
    return {
      ok: false,
      detail: `cw 引擎库不可导入（${spec}）：${e instanceof Error ? e.message : String(e)}——重装 @zhushanwen/coding-workflow 依赖`,
    };
  }
  if (typeof (mod as Record<string, unknown>).runLoop !== "function") {
    return { ok: false, detail: `cw 引擎库缺 runLoop 导出（${spec}）` };
  }
  return { ok: true, detail: `cw 引擎库在场（${spec} 的 runLoop 可导入）` };
}

/** 三查合流：clarify = ①ok && !noClarify；reasons 聚合失败明细 */
export async function runProbe(opts: ProbeOptions = {}): Promise<ProbeResult> {
  const agentDir = opts.agentDir ?? resolveAgentDir();
  let askUser = checkAskUserOnDisk(agentDir);
  if (askUser.ok && opts.deep === true) {
    askUser = await checkAskUserDeep({ agentDir, piBin: opts.piBin, timeoutMs: opts.timeoutMs });
  }
  const subagentApi = await checkSubagentApi(opts.subagentSpec);
  const cwLib = await checkCwLib(opts.cwLibSpec);
  const noClarify = opts.noClarify ?? process.env.CW_RUNNER_NO_CLARIFY === "1";
  const reasons: string[] = [];
  if (noClarify) reasons.push("CW_RUNNER_NO_CLARIFY=1 手动逃生口：全链自声明");
  if (!askUser.ok) reasons.push(askUser.detail);
  if (!subagentApi.ok) reasons.push(subagentApi.detail);
  if (!cwLib.ok) reasons.push(cwLib.detail);
  return {
    askUser,
    subagentApi,
    cwLib,
    clarify: !noClarify && askUser.ok,
    reasons,
  };
}

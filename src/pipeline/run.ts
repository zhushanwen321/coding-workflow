/**
 * pipeline 执行与断点续跑（design-release-pipeline.md §3.3 D6/D8，W2）。
 *
 * run 即 resume（无独立 resume 命令）：每次 run 对每步查 foldGate 投影的
 * latestStepRun（按 (pipeline, manifestSha256, step) 分组取最新）——最新
 * result=pass → 跳过不重做不入账；否则执行：
 *   - 带 cache 声明的步骤内部走 wrapCheck（check 名 = `pipeline:<pipeline>:<step>`
 *     防与用户手跑的 check 撞名；命中 → 步骤 pass 且 PipelineStepRan 记
 *     viaCache:true、durationMs:0——验证事实由对应 GateCheckRan/GateCacheHit
 *     承载）；miss → 真实执行结果即步骤结果
 *   - 无 cache 声明直接 spawnSync 执行 + 计时
 * 每步执行后追加 PipelineStepRan（幂等键 pipeline+step+runId；每次 run 共用
 * 一个 runId——续跑是新 runId，已 pass 步骤靠投影跳过，不触发幂等）。
 * fail 即停（后续步骤 pending）。
 *
 * 并发边界（issues.md #2 / N8，显式接受不建锁）：双 run 并发可能双执行同一步骤
 * （重复执行浪费非正确性破坏——账本仍安全，store 文件锁兜底）；触发真实并发
 * 需求时按 runner.lock 先例加易失小锁。
 */
import { spawnSync } from "node:child_process";

import { foldGate, pipelineStepKey } from "../gate/fold.js";
import { newGateRunId, wrapCheck } from "../gate/wrap.js";
import type { GateResult } from "../gate/types.js";
import { EventLedger } from "../store/events-log.js";
import { gateLedgerPath } from "../store/project.js";
import { gateLedgerDomain } from "../gate/domain.js";
import { loadManifest, pipelineIdOf, type PipelineStep } from "./manifest.js";

/** 无 cache 步骤的执行超时缺省（对齐 wrapCheck 缺省 30min） */
const DEFAULT_STEP_TIMEOUT_MS = 30 * 60 * 1000;

export interface RunPipelineOptions {
  /** CW_HOME 根（绝对路径；CLI 层解析，核心库不读环境） */
  cwHome: string;
  /** 项目目录（步骤命令的执行 cwd） */
  cwd: string;
  /** manifest 文件路径 */
  manifestPath: string;
  /** base 比对基线 ref/sha（manifest 含 cache 声明步骤时必填） */
  baseRef?: string;
}

export interface PipelineRunResult {
  /** 0 = 全 pass（含跳过）；1 = 有步骤 fail */
  exitCode: 0 | 1;
  /** 本次真实执行的步骤数（含 viaCache 命中——它们是本次 run 的新入账步骤） */
  ran: number;
  /** 投影跳过的步骤数（已 pass 不重做） */
  skipped: number;
  /** 首个 fail 步骤名（exitCode=1 时存在） */
  failedStep?: string;
}

/** pipeline 执行环境错误（manifest 非法/cache 步骤缺 base/步骤环境错误）：不入账 */
export class PipelineEnvironmentError extends Error {
  constructor(message: string) {
    super(`${message} 恢复动作：修正后重跑 cw pipeline run（已完成步骤会从投影跳过，不重做）。`);
    this.name = "PipelineEnvironmentError";
  }
}

/** 无 cache 步骤的执行与计时（对齐 wrapCheck 的执行语义：spawnSync 不经 shell） */
function runPlainStep(step: PipelineStep, cwd: string): { result: GateResult; durationMs: number } {
  const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const started = Date.now();
  const res = spawnSync(step.command[0] as string, step.command.slice(1), { cwd, timeout: timeoutMs });
  const durationMs = Date.now() - started;
  if (res.error !== undefined) {
    // 环境错误（命令不存在等）：无完整执行事实可记，对齐 wrapCheck 语义不入账
    throw new PipelineEnvironmentError(
      `步骤 "${step.name}" 命令无法执行（${step.command.join(" ")}）：${res.error.message}。`,
    );
  }
  return {
    result: res.status === 0 ? "pass" : "fail",
    durationMs,
  };
}

export function runPipeline(opts: RunPipelineOptions): PipelineRunResult {
  const { manifest, manifestSha256 } = loadManifest(opts.manifestPath);
  const pipeline = pipelineIdOf(opts.manifestPath);
  const hasCacheSteps = manifest.steps.some((s) => s.cache !== undefined);
  if (hasCacheSteps && (opts.baseRef === undefined || opts.baseRef.length === 0)) {
    throw new PipelineEnvironmentError(
      "manifest 含 cache 声明步骤但未提供 --base（gate 缓存判定需要比对基线）。",
    );
  }

  const ledgerPath = gateLedgerPath(opts.cwHome, opts.cwd);
  const ledger = new EventLedger(ledgerPath, gateLedgerDomain);
  const projection = foldGate(ledger.readAll());

  // 每次 run 一个 runId：幂等键防同 run 重复入账；续跑是新 runId，已 pass 步骤
  // 靠投影跳过（不 append），无幂等冲突
  const runId = newGateRunId();
  let ran = 0;
  let skipped = 0;

  for (const step of manifest.steps) {
    const key = pipelineStepKey(pipeline, manifestSha256, step.name);
    const existing = projection.latestStepRun.get(key);
    if (existing !== undefined && existing.payload.result === "pass") {
      skipped += 1;
      continue;
    }

    let result: GateResult;
    let durationMs = 0;
    let viaCache: boolean | undefined;

    if (step.cache !== undefined) {
      const outcome = wrapCheck({
        cwHome: opts.cwHome,
        cwd: opts.cwd,
        check: `pipeline:${pipeline}:${step.name}`,
        base: opts.baseRef as string,
        scope: step.cache.scope,
        command: step.command,
        // runId 复用本 run 的：同 run 内 check 名含步骤名保证唯一，GateCheckRan
        // 可追溯到 run；跨 run 新 runId 无幂等碰撞
        runId,
        ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
      });
      if (outcome.kind === "env-error") {
        // wrapCheck 环境错误（base 解析失败/超时/产物写失败）消息自带恢复动作
        throw new PipelineEnvironmentError(`步骤 "${step.name}" gate 环境错误：${outcome.error}`);
      }
      if (outcome.kind === "idempotent") {
        // 结构性不可能（每次 run 新 runId，同 run 内 check 名含步骤名），穷尽分支
        throw new PipelineEnvironmentError(
          `步骤 "${step.name}" gate 幂等命中（同 check+runId 已入账）——pipeline runId 应每次新生成。`,
        );
      }
      result = outcome.kind === "fail" ? "fail" : "pass";
      durationMs = outcome.kind === "hit" ? 0 : outcome.durationMs;
      viaCache = outcome.kind === "hit";
    } else {
      const plain = runPlainStep(step, opts.cwd);
      result = plain.result;
      durationMs = plain.durationMs;
    }

    ran += 1;
    ledger.append("PipelineStepRan", {
      pipeline,
      manifestSha256,
      step: step.name,
      headSha: resolveHeadSha(opts.cwd),
      runId,
      result,
      ...(viaCache === true ? { viaCache: true } : {}),
      durationMs,
    });

    if (result === "fail") {
      return { exitCode: 1, ran, skipped, failedStep: step.name };
    }
  }
  return { exitCode: 0, ran, skipped };
}

/** 执行瞬间 HEAD sha（步骤入账锚；git 失败 = 环境错误） */
function resolveHeadSha(cwd: string): string {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf-8" });
  if (res.error !== undefined || (res.status ?? 1) !== 0) {
    throw new PipelineEnvironmentError(
      `git rev-parse HEAD 失败（仓库 "${cwd}"）：${res.error?.message ?? res.stderr}。`,
    );
  }
  return res.stdout.trim();
}

/**
 * wrapCheck —— gate 域 check 结果的唯一产生入口（design-release-pipeline.md
 * §3.3 D3 命中规则 / D4 记账闭合 / D8 runId 契约与三态 exit，rp-0）。
 *
 * 「没有裸跑的 check，只有 wrap 的 check」：两条终态路径同构产出（追加一条
 * 账本事件 + 落盘一份完整 report），「跑了但没记账」结构性不存在（对堵 F3
 * 假 pass 事故形态）。
 *
 * miss 路径：真实执行（spawnSync，不经 shell）→ 计时 → **锁外先落产物并算
 * sha256**（D4 固定先后序：产物写失败 = 整体环境错误、事件不入账；最坏形态
 * = 无害孤儿产物文件）→ 锁内追加 GateCheckRan（fail 也入账仅审计）。
 *
 * hit 路径（D3）：取 fold 投影同 (check, baseSha, scope) 最新 pass 条目（head
 * 记 H'）→ 复算来源 report sha256（不符 → 按 miss 处理 + 警告进结果，宁 miss
 * 不假 pass）→ `git diff --name-only H'..HEAD -- <scope...>` 为空 → 复制来源
 * report 加 source 标注落新 runId 产物目录 → 追加 GateCacheHit。
 *
 * 环境错误（base/HEAD 解析失败、命令超时、产物写失败）一律 kind: "env-error"
 * **不入账**——供 CLI 层映射 exit 2（对齐 cw verify 三态：0 = pass 含命中、
 * 1 = check fail、2 = 环境错误）。
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EventLedger } from "../store/events-log.js";
import { encodeCwd, gateArtifactsDir, gateLedgerPath } from "../store/project.js";
import {
  deriveHitReport,
  relativeReportRef,
  sha256OfContent,
  writeGateReport,
} from "./artifacts.js";
import { gateLedgerDomain } from "./domain.js";
import { foldGate, gateCacheKey } from "./fold.js";
import type {
  GateCheckRanPayload,
  GateDiscriminatedEvent,
  GateEvent,
  GateEventMap,
  GateReport,
} from "./types.js";

/** 单步 git 操作超时（本地解析/diff 通常毫秒级；上限仅防外部仓库挂死） */
const GIT_STEP_TIMEOUT_MS = 120_000;
/** check 执行超时缺省（D8：30min；--timeout-ms 可调，超时 = 环境错误不入账） */
export const DEFAULT_GATE_TIMEOUT_MS = 30_000_000;
/** ulid 风格 runId 的时间戳部分长度（48-bit ms → 10 字符 Crockford Base32） */
const RUNID_TIME_LEN = 10;
/** ulid 风格 runId 的随机部分长度（80-bit → 16 字符） */
const RUNID_RANDOM_LEN = 16;
/** 随机部分字节数（80-bit = RUNID_RANDOM_LEN × BITS_PER_CHAR） */
const RUNID_RANDOM_BYTES = 10;
/** 每字符携带的比特数（Base32） */
const BITS_PER_CHAR = 5;
/** 每字节携带的比特数 */
const BITS_PER_BYTE = 8;
/** Base32 掩码（5 bit） */
const BASE32_MASK = 0b11111;
/** Crockford Base32 字母表（ulid 标准：去 I/L/O/U 防混淆） */
const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** spawnSync stdout/stderr 缓冲上限（typecheck/lint 级输出余量，32MB = 33_554_432 字节） */
const SPAWN_MAX_BUFFER = 33_554_432;
/** 报错/警告文案里 sha 的预览长度（对照 events-log.ts 的 PREVIEW_MAX_CHARS 先例） */
const SHA_PREVIEW_LEN = 8;
/** check fail 的 exit code（D8 三态：0 = pass 含命中 / 1 = fail / 2 = 环境错误） */
const EXIT_OK = 0;
/** check fail 的 exit code */
const EXIT_FAIL = 1;
/** 环境错误的 exit code（同 verify.ts 的 ENV_ERROR_EXIT 口径） */
const EXIT_ENV_ERROR = 2;
/** 三态 exit 类型（常量派生，单一出处） */
export type WrapExitCode = typeof EXIT_OK | typeof EXIT_FAIL | typeof EXIT_ENV_ERROR;

export interface WrapCheckOptions {
  /** CW_HOME 根（绝对路径；由 CLI 层解析 env/缺省，核心库不读环境） */
  cwHome: string;
  /** 项目目录（git 仓库根或子目录；check 命令的执行 cwd） */
  cwd: string;
  /** check 命名身份 */
  check: string;
  /** base 比对基线（ref 如 origin/main，或直接给 sha；入账前解析为 baseSha） */
  base: string;
  /** check 输入文件集声明（路径前缀列表；空数组 = 仓根，默认无增量） */
  scope: string[];
  /** 被执行的命令（argv 形态，首个 token 须在 PATH 可解析；不经 shell） */
  command: string[];
  /** 显式 runId：check+runId 幂等（重复 = 幂等命中返回，不执行不重复入账） */
  runId?: string;
  /** 执行超时上限（ms；缺省 30min，超时 = 环境错误不入账） */
  timeoutMs?: number;
}

/** wrap 的终态结果（kind 供 CLI 层映射三态 exit；warnings 供 stderr 打印） */
export type WrapCheckOutcome =
  | {
      /** 命中：跳过执行，report 复制自来源（source 标注） */
      kind: "hit";
      check: string;
      baseSha: string;
      headSha: string;
      /** 本次产物 runId（GateCacheHit 事件无 runId 字段，产物目录寻址用） */
      runId: string;
      /** 命中来源（被复用的 GateCheckRan 的 runId） */
      sourceRunId: string;
      reportRef: string;
      reportSha256: string;
      seq: number;
      /** wrap 自身耗时（stdout 展示「0.0s」用；不是事件字段——hit 无真实执行耗时） */
      elapsedMs: number;
      warnings: readonly string[];
    }
  | {
      /** miss 且真实执行通过 */
      kind: "pass";
      check: string;
      baseSha: string;
      headSha: string;
      runId: string;
      exitCode: number;
      durationMs: number;
      reportRef: string;
      reportSha256: string;
      seq: number;
      warnings: readonly string[];
    }
  | {
      /** miss 且真实执行失败（fail 也入账仅审计，永不作命中候选） */
      kind: "fail";
      check: string;
      baseSha: string;
      headSha: string;
      runId: string;
      exitCode: number;
      durationMs: number;
      reportRef: string;
      reportSha256: string;
      seq: number;
      warnings: readonly string[];
    }
  | {
      /** 幂等命中（显式 runId 已入账）：不执行不重复入账，返回已入账条目 */
      kind: "idempotent";
      check: string;
      runId: string;
      existing: { seq: number; result: "pass" | "fail"; reportRef: string; reportSha256: string };
    }
  | {
      /** 环境错误（base/HEAD 解析失败、超时、产物写失败）：不入账，CLI 映射 exit 2 */
      kind: "env-error";
      error: string;
    };

/** 三态 exit 映射（D8，对齐 cw verify：0 = pass 含命中 / 1 = check fail / 2 = 环境错误） */
export function wrapExitCode(outcome: WrapCheckOutcome): WrapExitCode {
  switch (outcome.kind) {
    case "hit":
    case "pass":
    case "idempotent":
      return EXIT_OK;
    case "fail":
      return EXIT_FAIL;
    case "env-error":
      return EXIT_ENV_ERROR;
    default: {
      const _exhaustive: never = outcome;
      throw new Error(`wrapExitCode: 未知 kind：${String(_exhaustive)}`);
    }
  }
}

// ── runId 生成（ulid 风格：26 字符 = 10 时间戳 + 16 随机，字典序 ≈ 时间序）──

/**
 * 本地 ulid 风格生成器（不加依赖；仓内既有 id 生成是 `${前缀}-${randomUUID()}`
 * 形态，无字典序可排序性——gate 产物目录按 runId 名列目录时时间有序是实益）。
 * 单调性不保证（同 ms 内多次调用随机序），仅保证全局唯一概率与 ULID 同级。
 */
export function newGateRunId(now = Date.now()): string {
  let time = now;
  let timePart = "";
  for (let i = 0; i < RUNID_TIME_LEN; i++) {
    timePart = CROCKFORD32[time % CROCKFORD32.length] + timePart;
    time = Math.floor(time / CROCKFORD32.length);
  }
  const bytes = randomBytes(RUNID_RANDOM_BYTES);
  let bitPool = 0;
  let poolSize = 0;
  let byteIdx = 0;
  let randomPart = "";
  for (let i = 0; i < RUNID_RANDOM_LEN; i++) {
    while (poolSize < BITS_PER_CHAR) {
      bitPool = (bitPool << BITS_PER_BYTE) | bytes[byteIdx];
      byteIdx += 1;
      poolSize += BITS_PER_BYTE;
    }
    randomPart += CROCKFORD32[(bitPool >>> (poolSize - BITS_PER_CHAR)) & BASE32_MASK];
    poolSize -= BITS_PER_CHAR;
  }
  return timePart + randomPart;
}

// ── git 工具（spawnSync 跑 git，不经 shell，无注入面；风格对齐 worktree.ts）──

interface GitStepResult {
  status: number;
  stdout: string;
  stderr: string;
}

function gitStep(args: readonly string[], cwd: string): GitStepResult {
  const res = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    timeout: GIT_STEP_TIMEOUT_MS,
  });
  if (res.error !== undefined) {
    return { status: 1, stdout: "", stderr: res.error.message };
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** git 单步失败的失败原因描述（error message / exit code + stderr） */
function describeGitFailure(step: GitStepResult): string {
  const errText = step.stderr.trim();
  return `exit ${step.status}${errText === "" ? "" : ` — ${errText}`}`;
}

/** rev-parse 一个 ref/sha → 40 位 sha；失败返回 null（调用方包装环境错误） */
function resolveRef(cwd: string, ref: string): string | null {
  const res = gitStep(["rev-parse", "--verify", ref], cwd);
  if (res.status !== 0) {
    return null;
  }
  const sha = res.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) || /^[0-9a-f]{64}$/.test(sha) ? sha : null;
}

// ── 主流程 ──────────────────────────────────────────────────

/** wrapCheck 实现（语义见模块头；所有失败路径带恢复动作文案） */
export function wrapCheck(opts: WrapCheckOptions): WrapCheckOutcome {
  const ledger = new EventLedger<GateEventMap>(gateLedgerPath(opts.cwHome, opts.cwd), gateLedgerDomain);

  // 幂等前置检查（D8：显式 runId 的「重试同一提交防重复记账」）：在执行命令
  // 之前完成——幂等命中的调用方预期是零副作用确认，不是再跑一遍。readAll
  // 一次读两用（幂等检查 + hit 判定投影），锁外快照一致性由 append 锁事务兑
  const existingEvents = ledger.readAll();
  if (opts.runId !== undefined) {
    const existing = findGateCheckRan(existingEvents, opts.check, opts.runId);
    if (existing !== undefined) {
      return {
        kind: "idempotent",
        check: opts.check,
        runId: opts.runId,
        existing: {
          seq: existing.seq,
          result: existing.payload.result,
          reportRef: existing.payload.reportRef,
          reportSha256: existing.payload.reportSha256,
        },
      };
    }
  }

  // base 解析（F-3 路径：ref 不存在 = 环境错误，带恢复动作）
  const baseSha = resolveRef(opts.cwd, opts.base);
  if (baseSha === null) {
    return {
      kind: "env-error",
      error:
        `base ref "${opts.base}" 无法解析（git rev-parse 失败，仓库 "${opts.cwd}"）。` +
        "恢复动作：先 git fetch 更新远端引用，或用 --base <已知 sha> 显式指定。",
    };
  }
  const headSha = resolveRef(opts.cwd, "HEAD");
  if (headSha === null) {
    return {
      kind: "env-error",
      error:
        `HEAD 无法解析（git rev-parse HEAD 失败，仓库 "${opts.cwd}"）。` +
        "恢复动作：确认在含至少一个 commit 的 git 仓库内运行（git log 自检）后重试。",
    };
  }

  const runId = opts.runId ?? newGateRunId();
  const projection = foldGate(existingEvents);

  // ── hit 判定（D3）─────────────────────────────────────────
  const cacheKey = gateCacheKey(opts.check, baseSha, opts.scope);
  const candidate = projection.latestPassByKey.get(cacheKey);
  if (candidate !== undefined) {
    const warnings: string[] = [];
    const source = candidate.payload;
    const hitAttempt = tryCacheHit(ledger, opts, {
      runId,
      baseSha,
      headSha,
      source,
    });
    if (hitAttempt.hit) {
      return {
        kind: "hit",
        check: opts.check,
        baseSha,
        headSha,
        runId,
        sourceRunId: source.runId,
        reportRef: hitAttempt.reportRef,
        reportSha256: hitAttempt.reportSha256,
        seq: hitAttempt.seq,
        elapsedMs: hitAttempt.elapsedMs,
        warnings,
      };
    }
    if ("envError" in hitAttempt) {
      return { kind: "env-error", error: hitAttempt.envError };
    }
    if (hitAttempt.warning !== undefined) {
      warnings.push(hitAttempt.warning);
    }
    // sha256 复算不符 → 按 miss 处理（警告已收，宁 miss 不假 pass）
    return runCheck(ledger, opts, { runId, baseSha, headSha, warnings });
  }

  // ── miss 路径 ─────────────────────────────────────────────
  return runCheck(ledger, opts, { runId, baseSha, headSha, warnings: [] });
}

/** 账本中查同 check+runId 的 GateCheckRan（幂等前置检查的输入） */
function findGateCheckRan(
  events: readonly GateEvent[],
  check: string,
  runId: string,
): { seq: number; payload: GateCheckRanPayload } | undefined {
  // 宽泛的泛型信封 type 与 payload 不联动，判别联合视图才能按 type 窄化
  const discriminated = events as GateDiscriminatedEvent[];
  for (const record of [...discriminated].reverse()) {
    if (record.type === "GateCheckRan" && record.payload.check === check && record.payload.runId === runId) {
      return { seq: record.seq, payload: record.payload };
    }
  }
  return undefined;
}

/** hit 判定的中间产物：命中成功、需向 miss 倒（warning 供结果携带）、或环境错误（不入账） */
type HitAttempt =
  | { hit: true; reportRef: string; reportSha256: string; seq: number; elapsedMs: number }
  | { hit: false; warning?: string }
  | { hit: false; envError: string };

/**
 * 尝试命中：sha256 复算来源 report → scope 内容比对（git diff H'..HEAD）→
 * 复制来源 report（source 标注）落新 runId 产物目录 → 追加 GateCacheHit。
 * 任一步失败返回 { hit: false, warning }，调用方向 miss 倒（F-2 路径）。
 */
function tryCacheHit(
  ledger: EventLedger<GateEventMap>,
  opts: WrapCheckOptions,
  ctx: { runId: string; baseSha: string; headSha: string; source: GateCheckRanPayload },
): HitAttempt {
  const startedAt = Date.now();

  // ① 来源 report 存在性与 sha256 复算（F-2：产物被删/篡改 → 向 miss 倒）
  let sourceReportRaw: string;
  try {
    const sourcePath = joinProjectPath(opts.cwHome, opts.cwd, ctx.source.reportRef);
    sourceReportRaw = readFileSync(sourcePath, "utf-8");
  } catch {
    return {
      hit: false,
      warning:
        `来源 #${ctx.source.runId} 的 report 缺失（${ctx.source.reportRef}）→ 按 miss 重跑（宁 miss 不假 pass）`,
    };
  }
  if (sha256OfContent(sourceReportRaw) !== ctx.source.reportSha256) {
    return {
      hit: false,
      warning:
        `来源 #${ctx.source.runId} 的 report sha256 不符（产物损坏或篡改，期望 ${ctx.source.reportSha256.slice(0, SHA_PREVIEW_LEN)}…）→ 按 miss 重跑（宁 miss 不假 pass）`,
    };
  }

  // ② scope 内容比对：H'..HEAD 两树在 scope pathspec 下的差异为空 = 未变
  const diffArgs = ["diff", "--name-only", `${ctx.source.headSha}..${ctx.headSha}`];
  if (opts.scope.length > 0) {
    diffArgs.push("--", ...opts.scope);
  }
  const diff = gitStep(diffArgs, opts.cwd);
  if (diff.status !== 0) {
    return {
      hit: false,
      warning:
        `scope 内容比对失败（git diff ${ctx.source.headSha.slice(0, SHA_PREVIEW_LEN)}..${ctx.headSha.slice(0, SHA_PREVIEW_LEN)}：${describeGitFailure(diff)}）→ 按 miss 重跑`,
    };
  }
  if (diff.stdout.trim() !== "") {
    return { hit: false }; // scope 内有变更：正常 miss（非异常，无警告）
  }

  // ③ 复制来源 report + source 标注，落新 runId 产物目录（锁外先落产物，D4）
  let sourceReport: GateReport;
  try {
    sourceReport = JSON.parse(sourceReportRaw) as GateReport;
  } catch (err) {
    return {
      hit: false,
      warning: `来源 #${ctx.source.runId} 的 report 不是合法 JSON（${(err as Error).message}）→ 按 miss 重跑`,
    };
  }
  const hitReport = deriveHitReport(sourceReport, ctx.source.runId);
  const artifactsDir = gateArtifactsDir(opts.cwHome, opts.cwd, opts.check, ctx.runId);
  const reportRef = relativeReportRef(opts.check, ctx.runId);
  let written: { reportSha256: string };
  try {
    written = writeGateReport(artifactsDir, hitReport);
  } catch (err) {
    // 产物写失败 = 整体环境错误（不入账）：hit 路径同样遵守 D4 固定先后序
    return {
      hit: false,
      envError:
        `hit 产物写入失败（${artifactsDir}）：${(err as Error).message}。` +
        "恢复动作：检查该目录权限与磁盘空间后重试；本次 wrap 未入账，无半账状态。",
    };
  }

  // ④ 锁内追加 GateCacheHit（记账闭合）
  const envelope = ledger.append("GateCacheHit", {
    check: opts.check,
    baseSha: ctx.baseSha,
    baseRef: opts.base,
    scope: opts.scope,
    headSha: ctx.headSha,
    sourceRunId: ctx.source.runId,
    reportRef,
    reportSha256: written.reportSha256,
  });

  return {
    hit: true,
    reportRef,
    reportSha256: written.reportSha256,
    seq: envelope.seq,
    elapsedMs: Date.now() - startedAt,
  };
}

/** miss 路径：真实执行 → 计时 → 锁外先落产物 → 追加 GateCheckRan（fail 也入账） */
function runCheck(
  ledger: EventLedger<GateEventMap>,
  opts: WrapCheckOptions,
  ctx: {
    runId: string;
    baseSha: string;
    headSha: string;
    warnings: readonly string[];
  },
): WrapCheckOutcome {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const startedAt = Date.now();
  const res = spawnSync(opts.command[0], opts.command.slice(1), {
    cwd: opts.cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  const durationMs = Date.now() - startedAt;

  if (res.error !== undefined) {
    if ((res.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      // F-5：超时无完整产物可记 → 环境错误不入账
      return {
        kind: "env-error",
        error:
          `check "${opts.check}" 执行超过 ${timeoutMs}ms 上限（--timeout-ms 缺省 30min）。` +
          "恢复动作：确认命令本身可跑通后调大重试：--timeout-ms 3600000；" +
          "若常态超时，应拆小 check 粒度而非无限放大超时。本次未入账。",
      };
    }
    return {
      kind: "env-error",
      error:
        `check "${opts.check}" 命令无法执行（${opts.command.join(" ")}）：${res.error.message}。` +
        "恢复动作：确认命令首 token 在 PATH 可解析（command -v 自检）后重试。本次未入账。",
    };
  }

  const exitCode = res.status ?? 1;
  const result = exitCode === 0 ? "pass" : "fail";

  // D4 固定先后序：锁外先落产物并算 sha256；写失败 = 整体环境错误、事件不入账
  const artifactsDir = gateArtifactsDir(opts.cwHome, opts.cwd, opts.check, ctx.runId);
  const reportRef = relativeReportRef(opts.check, ctx.runId);
  let reportSha256: string;
  try {
    reportSha256 = writeGateReport(artifactsDir, {
      check: opts.check,
      runId: ctx.runId,
      baseSha: ctx.baseSha,
      baseRef: opts.base,
      scope: opts.scope,
      headSha: ctx.headSha,
      command: opts.command,
      result,
      exitCode,
      durationMs,
    }).reportSha256;
  } catch (err) {
    return {
      kind: "env-error",
      error:
        `check "${opts.check}" 产物写入失败（${artifactsDir}）：${(err as Error).message}。` +
        "恢复动作：检查该目录权限与磁盘空间后重试。命令已执行但事件未入账（D4：宁可无账不可假账），本次 wrap 无半账状态。",
    };
  }

  // 锁内追加（fail 也入账，仅审计不进 pass 投影——fold 层结构性排除）
  const envelope = ledger.append("GateCheckRan", {
    check: opts.check,
    baseSha: ctx.baseSha,
    baseRef: opts.base,
    scope: opts.scope,
    headSha: ctx.headSha,
    command: opts.command,
    runId: ctx.runId,
    result,
    exitCode,
    durationMs,
    reportRef,
    reportSha256,
  });

  return {
    kind: result,
    check: opts.check,
    baseSha: ctx.baseSha,
    headSha: ctx.headSha,
    runId: ctx.runId,
    exitCode,
    durationMs,
    reportRef,
    reportSha256,
    seq: envelope.seq,
    warnings: ctx.warnings,
  };
}

/** reportRef（相对项目 CW 目录）→ 绝对路径（读取复算用；布局拼接与 project.ts 同源） */
function joinProjectPath(cwHome: string, cwd: string, reportRef: string): string {
  // reportRef 的生产单一出处 = relativeReportRef（不含 .. 段），join 即可
  return join(cwHome, encodeCwd(cwd), reportRef);
}

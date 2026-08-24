/**
 * `cw gate wrap` / `cw gate query`（design-release-pipeline.md §3.1 终态样例 /
 * §3.3 D8 命令面与三态 exit，W1：rp-0 核心库的 CLI 接线层）。
 *
 * 职责边界（对照 query.ts 模块头契约）：CLI 层只做参数解析、CW_HOME/项目目录
 * 定位、人类可读输出与三态 exit 映射；命中规则 / 记账闭合 / 事件代数全部在
 * src/gate/ 核心库——本文件不含任何缓存语义。
 *
 *   - wrap：`cw gate wrap --check <名> --base <ref> [--scope <路径>...]
 *     [--run-id <id>] [--timeout-ms <n>] -- <命令...>`。`--base` 原文透传给
 *     wrapCheck（ref→sha 解析在核心库，失败 = 环境错误且文案自带恢复动作，
 *     对齐 §3.1 F-3 样例）。exit = wrapExitCode 三态（0 pass 含命中 / 1 check
 *     fail / 2 环境错误）。
 *   - query：`cw gate query [--check <名>] [--base <ref>] [--json]`。`--base`
 *     在本层解析为 sha（queryGate 只收 sha——比对键是 sha，ref 只作审计展示）；
 *     缺省人类可读（对齐 §3.1 样例），--json 供 merge skill 等机器消费方。
 *
 * 命令 argv 提取：minimist 缺省把 `--` 之后的 token 收进 `_`（实测 1.2.x 不做
 * 数字变形；dispatch 已剥掉 "gate wrap" 两级命令 token，`_` 即 `--` 后命令）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import type { CommandContext } from "../dispatch.js";
import { gateLedgerDomain } from "../gate/domain.js";
import { EMPTY_STATS_PLACEHOLDER, renderStats } from "../gate/stats.js";
import { EventLedger } from "../store/events-log.js";
import { gateLedgerPath } from "../store/project.js";
import { queryGate, type GatePassEntry } from "../gate/query.js";
import { wrapCheck, wrapExitCode } from "../gate/wrap.js";
import { getCwHome } from "../store/project.js";
import { fail, stringArg, stringArrayArg } from "./common.js";

/** 环境错误 exit code（对齐 verify.ts 的 ENV_ERROR_EXIT：未发生可入账的验证） */
const ENV_ERROR_EXIT = 2;
/** stdout 展示用短 sha 长度（git 短 sha 惯例 7 位） */
const SHORT_SHA_LEN = 7;
/** sha256 预览长度（对齐 §3.1 样例「report sha256: a1b2…」的展示形态） */
const SHA_PREVIEW_LEN = 8;
/** 单步 git 操作超时（本地 rev-parse 毫秒级；上限仅防外部仓库挂死，对照 wrap.ts 同款） */
const GIT_STEP_TIMEOUT_MS = 120_000;

/** ms → 秒的展示格式（41.2s / 0.0s，对齐 §3.1 样例） */
function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 展示用短 sha（head/base 同款 7 位） */
function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LEN);
}

// ── gate wrap ──────────────────────────────────────────────

/**
 * `--timeout-ms` 解析（对照 verify.ts 的 parseTimeoutMs 同款边界：minimist 把
 * 数字形态解析为 number，裸 flag 是 boolean true，非正整数一律显式报错——
 * 显式输入静默变形比报错更糟）。
 */
function parseTimeoutMs(
  raw: unknown,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  if (Number.isFinite(value) && value > 0) {
    return { ok: true, value };
  }
  return {
    ok: false,
    error:
      `cw gate wrap: 非法 --timeout-ms "${String(raw)}"：须为正整数（毫秒）。` +
      "恢复动作：如 --timeout-ms 3600000；省略则缺省 30min（超时 = 环境错误不入账）。",
  };
}

/** 从 minimist 结果提取 `--` 后的命令 argv（见模块头：dispatch 已剥命令 token） */
function commandArgv(argv: CommandContext["argv"]): string[] {
  return argv._.map((t) => String(t));
}

/** 用法错误信息（缺参 / 裸 flag），含完整用法样例作恢复动作 */
function wrapUsage(missing: string): string {
  return (
    `cw gate wrap: ${missing}。` +
    "恢复动作：cw gate wrap --check <名> --base <ref> [--scope <路径>...] [--run-id <id>] " +
    "[--timeout-ms <毫秒数>] -- <命令...>（如 --check typecheck --base origin/main --scope src/ -- npm run check）。"
  );
}

export async function handleGateWrap(ctx: CommandContext): Promise<number> {
  const check = stringArg(ctx.argv, "check");
  if (check === undefined) {
    return fail(wrapUsage("缺少 --check <名>"));
  }
  const base = stringArg(ctx.argv, "base");
  if (base === undefined) {
    return fail(wrapUsage("缺少 --base <ref>"));
  }
  const scope = stringArrayArg(ctx.argv, "scope");
  const runId = stringArg(ctx.argv, "run-id");
  const timeout = parseTimeoutMs(ctx.argv["timeout-ms"]);
  if (!timeout.ok) {
    return fail(timeout.error);
  }
  const command = commandArgv(ctx.argv);
  if (command.length === 0) {
    return fail(
      wrapUsage("缺少要执行的命令（-- 之后）"),
    );
  }

  const outcome = wrapCheck({
    cwHome: getCwHome(),
    cwd: ctx.cwd,
    check,
    base,
    scope,
    command,
    ...(runId !== undefined ? { runId } : {}),
    ...(timeout.value !== undefined ? { timeoutMs: timeout.value } : {}),
  });

  // warnings 仅 hit/pass/fail 变体携带（idempotent/env-error 无）
  if ("warnings" in outcome) {
    for (const w of outcome.warnings) {
      process.stderr.write(`[warn] ${w}\n`);
    }
  }

  switch (outcome.kind) {
    case "hit":
      process.stdout.write(
        `[hit] ${outcome.check} @ ${shortSha(outcome.headSha)} (base ${shortSha(outcome.baseSha)})：` +
          `命中 ${outcome.sourceRunId}（${fmtSec(outcome.elapsedMs)}），report 已产出\n` +
          `入账 GateCacheHit #${outcome.seq}（source=${outcome.sourceRunId}）\n`,
      );
      break;
    case "pass":
    case "fail":
      // miss 两态同构：首行 + 入账行（fail 的入账行附 query 不复用说明，F-4 样例）
      process.stdout.write(
        `[miss] ${outcome.check} @ ${shortSha(outcome.headSha)} (base ${shortSha(outcome.baseSha)})：` +
          `执行 ${fmtSec(outcome.durationMs)} → ${outcome.kind === "pass" ? "pass" : `FAIL（exit ${outcome.exitCode}）`}\n` +
          (outcome.kind === "pass"
            ? `入账 GateCheckRan #${outcome.seq}，report: ${outcome.reportRef}\n`
            : `入账 GateCheckRan #${outcome.seq}（result=fail）。修复后重跑同一命令即可；` +
              "query 只认 pass 条目，fail 不会被缓存复用。\n"),
      );
      break;
    case "idempotent":
      process.stdout.write(
        `[idempotent] ${outcome.check}（runId=${outcome.runId}）：` +
          `已入账 #${outcome.existing.seq}（result=${outcome.existing.result}），不重复执行不入账\n`,
      );
      break;
    case "env-error":
      // 核心库错误文案自带恢复动作（F-3/F-5/产物写失败），本层不改写
      process.stderr.write(`cw gate wrap: ${outcome.error}\n`);
      break;
    default: {
      const _exhaustive: never = outcome;
      throw new Error(`cw gate wrap: 未知 kind：${String(_exhaustive)}`);
    }
  }
  // 三态 exit 单一出处 = 核心库 wrapExitCode（D8：0 pass 含命中 / 1 fail / 2 环境错误）
  return wrapExitCode(outcome);
}

// ── gate stats ───────────────────────────────────────────

/**
 * `cw gate stats`（design-release-pipeline.md D8，W3：计时聚合只读命令）。
 * durationStats 投影（foldGate）直出；空账本 → 结构化空形态非报错（AC-6.2）。
 */
export async function handleGateStats(ctx: CommandContext): Promise<number> {
  const path = gateLedgerPath(getCwHome(), ctx.cwd);
  if (!existsSync(path)) {
    process.stdout.write(`${EMPTY_STATS_PLACEHOLDER}\n`);
    return 0;
  }
  const events = new EventLedger(path, gateLedgerDomain).readAll();
  process.stdout.write(renderStats(events));
  return 0;
}

// ── gate query ─────────────────────────────────────────────────

/**
 * base ref → 40 位 sha（query 专用：queryGate 只收 sha）。对照 wrap.ts 内部
 * resolveRef 的同款实现——核心库六文件已定稿不加导出，本层保留 8 行私有副本。
 */
function resolveBaseRef(cwd: string, ref: string): { ok: true; sha: string } | { ok: false } {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", ref], {
    encoding: "utf-8",
    timeout: GIT_STEP_TIMEOUT_MS,
  });
  if (res.error !== undefined || (res.status ?? 1) !== 0) {
    return { ok: false };
  }
  const sha = res.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) || /^[0-9a-f]{64}$/.test(sha) ? { ok: true, sha } : { ok: false };
}

/** 一条 pass 条目的人类可读行（对齐 §3.1：`hit: #18 @ 9f3c2a1（pass，41.2s）report sha256: a1b2…`） */
function passEntryLine(entry: GatePassEntry): string {
  const scope = entry.scope.length > 0 ? entry.scope.join(" ") : "仓根";
  return (
    `hit: #${entry.seq} @ ${shortSha(entry.headSha)}（pass，${fmtSec(entry.durationMs)}）` +
    ` report sha256: ${entry.reportSha256.slice(0, SHA_PREVIEW_LEN)}… [${entry.check} scope: ${scope}] runId: ${entry.runId}`
  );
}

export async function handleGateQuery(ctx: CommandContext): Promise<number> {
  const check = stringArg(ctx.argv, "check");
  const baseRef = stringArg(ctx.argv, "base");

  let baseSha: string | undefined;
  if (baseRef !== undefined) {
    const resolved = resolveBaseRef(ctx.cwd, baseRef);
    if (!resolved.ok) {
      process.stderr.write(
        `cw gate query: base ref "${baseRef}" 无法解析（git rev-parse 失败，仓库 "${ctx.cwd}"）。` +
          "恢复动作：先 git fetch 更新远端引用，或用 --base <已知 sha> 显式指定。\n",
      );
      return ENV_ERROR_EXIT;
    }
    baseSha = resolved.sha;
  }

  const result = queryGate({ cwHome: getCwHome(), cwd: ctx.cwd, check, baseSha });

  if (ctx.argv["json"] === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (result.passEntries.length === 0) {
    const checkLabel = check ?? "*";
    const baseLabel = baseSha ?? "*";
    const scopeLabel = "*";
    process.stdout.write(`miss: 无 (${checkLabel}, ${baseLabel}, ${scopeLabel}) 的 pass 条目\n`);
    return 0;
  }
  const lines = result.passEntries.map(passEntryLine);
  if (result.latestByCheck.length > 0) {
    lines.push(
      ...result.latestByCheck.map(
        (e) => `latest: ${e.check} #${e.seq} ${e.type}（${e.ts}）`,
      ),
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

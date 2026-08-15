/**
 * `cw verify --unit <id> [--timeout-ms <n>]`（u4a 验收文档锁定的 M0 规格）。
 *
 * 干净重跑验证：取最后一条 spec（冻结验收）与最后一条 build evidence 的 commit，
 * cleanCheckout 到一次性工作区，逐条重跑非 manual 验收（manual 并入 acceptanceIds，
 * 免机器验证语义），产物落盘 evidence/<unitId>/<runId>/，VerifyRan 入账。
 *
 * exit 语义（验收文档锁定）：
 *   - 全 pass → result=pass，exit 0
 *   - 任一 fail → result=fail，exit 1（stderr 列失败验收 id 与原因）；fail 也入账
 *     （打回依据，审计必需）
 *   - 环境错误（unit/spec/build 证据缺失、clone/checkout 失败、入账失败）→ exit 2，
 *     不入账
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { CommandContext } from "../dispatch.js";
import type {
  DiscriminatedEvent,
  EvidenceSubmittedPayload,
  SpecSubmittedPayload,
  VerifyRanPayload,
} from "../events/types.js";
import { evidenceDir, getCwHome } from "../store/project.js";
import { cleanCheckout, cleanupCheckout } from "../verify/checkout.js";
import { runAcceptances, type RunOutcome } from "../verify/run.js";
import {
  fail,
  ledgerForCwd,
  sha256Hex,
  stringArg,
  tryAppend,
  unitCreatedFacts,
} from "./common.js";

/** 单条验收命令默认超时：10min（canon §6.3 纪律④单测口径） */
const DEFAULT_TIMEOUT_MS = 600_000;
/** 环境错误 exit code（验收文档锁定：验证未发生、不入账） */
const ENV_ERROR_EXIT = 2;
/** 总报告文件名（stdout 摘要里给出完整路径，便于人工复核产物） */
const REPORT_FILE_NAME = "report.json";

export async function handleVerify(ctx: CommandContext): Promise<number> {
  const unitId = stringArg(ctx.argv, "unit");
  if (unitId === undefined) {
    return fail(
      "cw verify: 缺少 --unit <id>。恢复动作：cw verify --unit <unitId> [--timeout-ms <毫秒数>]。",
    );
  }
  const timeout = parseTimeoutMs(ctx.argv["timeout-ms"]);
  if (!timeout.ok) {
    return fail(timeout.error);
  }

  const ledger = ledgerForCwd(ctx.cwd);
  if (!unitCreatedFacts(ledger).has(unitId)) {
    return envError(
      `cw verify: unit "${unitId}" 不存在（账本内无其 UnitCreated 事件）。` +
        `恢复动作：运行 cw status 查看全部 unit，确认 id 后重试。`,
    );
  }

  // 最后一条 spec + 最后一条 build evidence（重跑锚点：冻结验收 + 可 checkout 的 commit）
  let lastSpec: SpecSubmittedPayload | undefined;
  let lastEvidence: EvidenceSubmittedPayload | undefined;
  for (const ev of ledger.readUnit(unitId) as DiscriminatedEvent[]) {
    if (ev.type === "SpecSubmitted") {
      lastSpec = ev.payload;
    } else if (ev.type === "EvidenceSubmitted") {
      lastEvidence = ev.payload;
    }
  }
  if (lastSpec === undefined) {
    return envError(
      `cw verify: unit "${unitId}" 无已入账 spec（SpecSubmitted 缺失，无冻结验收可重跑）。` +
        "恢复动作：先提交 spec（cw evidence submit --kind spec --unit <id> --file spec.json）再 verify。",
    );
  }
  if (lastEvidence === undefined) {
    return envError(
      `cw verify: unit "${unitId}" 无已入账 build 证据（EvidenceSubmitted 缺失，无可 checkout 的 commit）。` +
        "恢复动作：先提交 build 证据（cw evidence submit --kind build --unit <id> --commit <hash> --run-id <id>）再 verify。",
    );
  }

  const checkout = cleanCheckout(ctx.cwd, lastEvidence.commit);
  if (!checkout.ok) {
    return envError(
      `cw verify: 干净 checkout 失败（commit ${lastEvidence.commit}，仓库 "${ctx.cwd}"）：${checkout.error}。` +
        "恢复动作：确认 cwd 是目标 git 仓库、commit 真实存在（git cat-file -e '<commit>^{commit}'）后重试。",
    );
  }

  const runId = `verify-${randomUUID()}`;
  const evidenceBase = evidenceDir(getCwHome(), ctx.cwd, unitId, runId);
  let outcome: RunOutcome;
  try {
    outcome = runAcceptances(checkout.dir, lastSpec.acceptance, evidenceBase, timeout.value);
  } catch (e) {
    return envError(
      `cw verify: 验收执行框架失败（产物目录 ${evidenceBase}）：${e instanceof Error ? e.message : String(e)}。` +
        "恢复动作：检查磁盘权限与 evidence 目录可写性后重试。",
    );
  } finally {
    cleanupCheckout(checkout.dir);
  }

  const result = outcome.report.exitCode === 0 ? "pass" : "fail";
  // acceptanceIds = 机器判定 pass 的 ∪ manual 的（spec 顺序）；fail 的不进
  const statusById = new Map(outcome.results.map((r) => [r.id, r.status]));
  const acceptanceIds = lastSpec.acceptance
    .filter((ac) => ac.type === "manual" || statusById.get(ac.id) === "pass")
    .map((ac) => ac.id);

  // pass/fail 都入账（fail 的 verify 是打回依据）；入账失败 = 审计链断裂，归环境错误
  const payload: VerifyRanPayload = {
    unitId,
    runId,
    reportHash: sha256Hex(outcome.reportRaw),
    result,
    acceptanceIds,
  };
  const appended = tryAppend(ledger, "VerifyRan", payload);
  if (!appended.ok) {
    return envError(
      `cw verify: VerifyRan 入账失败（verify 结果已产出但未入账，产物保存在 ${evidenceBase}）：${appended.message}。` +
        "恢复动作：按上方账本错误处理（通常是锁竞争，稍等后重跑 verify）。",
    );
  }

  writeSummary(lastSpec, statusById, { unitId, runId, result, evidenceBase });

  if (result === "fail") {
    const failed = outcome.results.filter((r) => r.status === "fail");
    process.stderr.write(
      [
        `cw verify: unit "${unitId}" 有 ${failed.length} 条验收失败：`,
        ...failed.map((r) => `  ${r.id}: ${r.reason ?? "未知原因"}`),
        `产物报告：${join(evidenceBase, REPORT_FILE_NAME)}`,
        "恢复动作：修复后重新提交 spec + build 证据并重审，再 cw verify。",
        "",
      ].join("\n"),
    );
    return 1;
  }
  return 0;
}

/**
 * --timeout-ms 解析。minimist 会把数字形态的值解析为 number（`--timeout-ms 500` → 500），
 * common.ts 的 stringArg 只认 string 会静默丢值回退默认——因此本命令在本地按原始
 * unknown 解析（common.ts 属 u2 已验收领地，不为其扩接口）：
 *   - number（有限且 > 0）直接用；string 匹配 /^\d+$/ 且 > 0 → Number()
 *   - undefined（未提供）→ 默认 10min
 *   - 其余（含裸 --timeout-ms 的 boolean true、非数字 string、≤ 0）一律报错：
 *     静默回退 600000ms 会把显式输入变成 10min 挂死，比报错更糟
 */
function parseTimeoutMs(raw: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: DEFAULT_TIMEOUT_MS };
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
      `cw verify: 非法 --timeout-ms "${String(raw)}"：须为正整数（毫秒）。` +
      `恢复动作：如 --timeout-ms 300000；省略则用默认 ${DEFAULT_TIMEOUT_MS}ms（10min）。`,
  };
}

/** 环境错误出口：stderr 一条可操作信息，exit 2（语义：验证未发生，不入账）。 */
function envError(message: string): number {
  process.stderr.write(`${message}\n`);
  return ENV_ERROR_EXIT;
}

/** stdout 人可读摘要：逐条 `<id> <pass|fail|manual>` + 总结行（验收文档第 8 步）。 */
function writeSummary(
  spec: SpecSubmittedPayload,
  statusById: Map<string, "pass" | "fail">,
  run: { unitId: string; runId: string; result: "pass" | "fail"; evidenceBase: string },
): void {
  const lines = spec.acceptance.map((ac) => {
    if (ac.type === "manual") {
      return `${ac.id} manual`;
    }
    return `${ac.id} ${statusById.get(ac.id) === "pass" ? "pass" : "fail"}`;
  });
  const passCount = spec.acceptance.filter((ac) => statusById.get(ac.id) === "pass").length;
  const failCount = spec.acceptance.filter((ac) => statusById.get(ac.id) === "fail").length;
  const manualCount = spec.acceptance.filter((ac) => ac.type === "manual").length;
  process.stdout.write(
    [
      ...lines,
      `verify unit "${run.unitId}" result=${run.result} (pass=${passCount} fail=${failCount} manual=${manualCount})`,
      `runId=${run.runId}`,
      `report: ${join(run.evidenceBase, REPORT_FILE_NAME)}`,
      "",
    ].join("\n"),
  );
}

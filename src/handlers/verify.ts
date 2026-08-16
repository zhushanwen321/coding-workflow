/**
 * `cw verify --unit <id> [--timeout-ms <n>] [--red-phase]`（u4a/u4b 验收文档锁定规格）。
 *
 * 干净重跑验证（默认路径）：取最后一条 spec（冻结验收）与最后一条 build evidence
 * 的 commit，cleanCheckout 到一次性工作区，逐条重跑非 manual 验收——u4b 起判定
 * 不再是 exit code，而是适配器路由（type → u5 适配器）+ nameMatch 名字级比对；
 * manual 并入 acceptanceIds（免机器验证语义），产物落盘 evidence/<unitId>/<runId>/，
 * VerifyRan 入账。
 *
 * 红阶段 gate（--red-phase）：checkout build commit 的第一父（实现前基线树），
 * 同一套验收逐条期望 fail（同一适配器路由）。全部有区分力 → exit 0；任一在旧树
 * 也 pass / 命令成功但无有效用例产物 → exit 1（stderr 列 id，恢复动作指向「修
 * 测试而非修 gate」）。红阶段不是验证结论，不写 VerifyRan，产物落 red-phase 专属
 * runId 目录留审计。
 *
 * exit 语义（验收文档锁定）：
 *   - 常规全 pass → result=pass，exit 0
 *   - 常规任一 fail → result=fail，exit 1（stderr 列失败验收 id 与原因）；fail 也
 *     入账（打回依据，审计必需）
 *   - 环境错误（unit/spec/build 证据缺失、clone/checkout 失败、build commit 无父
 *     可回退、入账失败）→ exit 2，不入账
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
import {
  firstParentOf,
  judgeRedPhase,
  patchAcceptanceFilesForRedPhase,
} from "../verify/red-phase.js";
import {
  E2E_ACCEPTANCE_TIMEOUT_MS,
  runAcceptances,
  type RunOutcome,
  UNIT_ACCEPTANCE_TIMEOUT_MS,
} from "../verify/run.js";
import {
  fail,
  ledgerForCwd,
  sha256Hex,
  stringArg,
  tryAppend,
  unitCreatedFacts,
} from "./common.js";

/** 环境错误 exit code（验收文档锁定：验证未发生，不入账） */
const ENV_ERROR_EXIT = 2;
/** 总报告文件名（stdout 摘要里给出完整路径，便于人工复核产物） */
const REPORT_FILE_NAME = "report.json";

export async function handleVerify(ctx: CommandContext): Promise<number> {
  const unitId = stringArg(ctx.argv, "unit");
  if (unitId === undefined) {
    return fail(
      "cw verify: 缺少 --unit <id>。恢复动作：cw verify --unit <unitId> [--timeout-ms <毫秒数>] [--red-phase]。",
    );
  }
  const timeout = parseTimeoutMs(ctx.argv["timeout-ms"]);
  if (!timeout.ok) {
    return fail(timeout.error);
  }
  const redPhase = ctx.argv["red-phase"] === true;

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

  return redPhase
    ? runRedPhase(ctx.cwd, unitId, timeout.value, lastSpec, lastEvidence)
    : runRegularVerify(ctx.cwd, unitId, timeout.value, lastSpec, lastEvidence);
}

/** 常规干净重跑：nameMatch 判定 → VerifyRan 入账 → stdout 摘要 / stderr 失败明细 */
function runRegularVerify(
  cwd: string,
  unitId: string,
  timeoutMs: number | undefined,
  lastSpec: SpecSubmittedPayload,
  lastEvidence: EvidenceSubmittedPayload,
): number {
  const checkout = cleanCheckout(cwd, lastEvidence.commit);
  if (!checkout.ok) {
    return envError(
      `cw verify: 干净 checkout 失败（commit ${lastEvidence.commit}，仓库 "${cwd}"）：${checkout.error}。` +
        "恢复动作：确认 cwd 是目标 git 仓库、commit 真实存在（git cat-file -e '<commit>^{commit}'）后重试。",
    );
  }

  const runId = `verify-${randomUUID()}`;
  const evidenceBase = evidenceDir(getCwHome(), cwd, unitId, runId);
  let outcome: RunOutcome;
  try {
    outcome = runAcceptances(checkout.dir, lastSpec.acceptance, evidenceBase, timeoutMs);
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
  const ledger = ledgerForCwd(cwd);
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
        // fx-1 R2：旧文案「重新提交 spec + build 证据并重审」会诱导 builder 重提
        // spec → deriveStatus 判回 created → 派发真空死区。验收冻结不动是默认路径
        `恢复动作：修复代码并 git commit 后，仅重新 cw evidence submit --kind build --unit ${unitId} --commit <hash> --run-id <新id> 再 cw verify；spec 冻结不动（改验收走重新 spec 是另一路径，需重新过审）。`,
        "",
      ].join("\n"),
    );
    return 1;
  }
  return 0;
}

/**
 * 红阶段 gate：父 commit（第一父）树上重跑验收，逐条期望 fail。跑之前先把
 * 「验收 command 引用的变更文件」（新测试入口）patch 进父树——恒真测试在
 * 基线代码树上也绿，应判无区分力（详见 src/verify/red-phase.ts 头注释）。
 * 产物落 red-phase 前缀的 runId 目录（不与常规 verify 产物混淆），不写 VerifyRan。
 */
function runRedPhase(
  cwd: string,
  unitId: string,
  timeoutMs: number | undefined,
  lastSpec: SpecSubmittedPayload,
  lastEvidence: EvidenceSubmittedPayload,
): number {
  const parent = firstParentOf(cwd, lastEvidence.commit);
  if (!parent.ok) {
    return envError(
      `cw verify --red-phase: 无法定位 unit "${unitId}" build commit ${lastEvidence.commit} 的父 commit：${parent.error}。` +
        (parent.noParent
          ? "红阶段需要「实现前」的基线树，初始 commit 之前没有历史。恢复动作：在含实现的 commit 之上再提交一次（或换以非初始 commit 为 build 锚点）后重跑。"
          : "恢复动作：确认 cwd 是目标 git 仓库且 commit 真实存在后重试。"),
    );
  }

  const checkout = cleanCheckout(cwd, parent.commit);
  if (!checkout.ok) {
    return envError(
      `cw verify --red-phase: 干净 checkout 失败（父 commit ${parent.commit}，仓库 "${cwd}"）：${checkout.error}。` +
        "恢复动作：确认 cwd 是目标 git 仓库、commit 真实存在（git cat-file -e '<commit>^{commit}'）后重试。",
    );
  }

  const runId = `red-phase-${randomUUID()}`;
  const evidenceBase = evidenceDir(getCwHome(), cwd, unitId, runId);
  let outcome: RunOutcome;
  let patchedFiles: string[] = [];
  try {
    // patch 语义（红阶段区分力前提）：验收 command 引用的变更文件（新测试入口）
    // 从 build commit 带进父树再跑——否则恒真测试放进新文件即可让父树命令因
    // 文件缺失 fail 被误判有区分力；无可 patch 文件时父树原样跑（现状口径）
    const patch = patchAcceptanceFilesForRedPhase(
      checkout.dir,
      parent.commit,
      lastEvidence.commit,
      lastSpec.acceptance,
    );
    if (!patch.ok) {
      return envError(
        `cw verify --red-phase: 新测试 patch 到父树失败（父 ${parent.commit} / build ${lastEvidence.commit}，工作区 ${checkout.dir}）：${patch.error}。` +
          "恢复动作：确认两 commit 在仓库中真实可达（git cat-file -e '<commit>^{commit}'）后重跑。",
      );
    }
    patchedFiles = patch.files;
    outcome = runAcceptances(checkout.dir, lastSpec.acceptance, evidenceBase, timeoutMs);
  } catch (e) {
    return envError(
      `cw verify --red-phase: 验收执行框架失败（产物目录 ${evidenceBase}）：${e instanceof Error ? e.message : String(e)}。` +
        "恢复动作：检查磁盘权限与 evidence 目录可写性后重试。",
    );
  } finally {
    cleanupCheckout(checkout.dir);
  }

  if (outcome.results.length === 0) {
    return envError(
      `cw verify --red-phase: unit "${unitId}" 的 spec 无机器验收（全部 manual）——红阶段无从判定区分力。` +
        "恢复动作：为 spec 补充可机器执行的验收（e2e-real/e2e-mock/unit/integration）后重跑。",
    );
  }

  const verdicts = judgeRedPhase(outcome.results, { patchedFiles });
  const nonDiscriminative = verdicts.filter((v) => !v.discriminative);
  const patchNote =
    patchedFiles.length > 0 ? ` + patch 测试文件 [${patchedFiles.join(", ")}]` : "";
  if (nonDiscriminative.length === 0) {
    process.stdout.write(
      [
        ...verdicts.map((v) => `${v.id} 有区分力`),
        `red-phase unit "${unitId}"：${verdicts.length}/${verdicts.length} 条机器验收在父 commit ${parent.commit}${patchNote} 上失败（有区分力）`,
        `runId=${runId}`,
        `report: ${join(evidenceBase, REPORT_FILE_NAME)}`,
        "",
      ].join("\n"),
    );
    return 0;
  }
  process.stderr.write(
    [
      `cw verify --red-phase: unit "${unitId}" 有 ${nonDiscriminative.length} 条验收无区分力（在父 commit ${parent.commit}${patchNote} 上也通过 / 命令成功但产物无有效用例）：`,
      ...nonDiscriminative.map((v) => `  ${v.id}: ${v.reason}`),
      `产物报告：${join(evidenceBase, REPORT_FILE_NAME)}`,
      "恢复动作：修测试而非修 gate——让验收引用实现产物（命令在父 commit 上因文件缺失/接口不存在而失败，输出 <验收id> (PASS|FAIL) 标记行或 vitest JSON），勿弱化判定绕过。",
      "",
    ].join("\n"),
  );
  return 1;
}

/**
 * --timeout-ms 解析。minimist 会把数字形态的值解析为 number（`--timeout-ms 500` → 500），
 * common.ts 的 stringArg 只认 string 会静默丢值回退默认——因此本命令在本地按原始
 * unknown 解析（common.ts 属 u2 已验收领地，不为其扩接口）：
 *   - number（有限且 > 0）直接用；string 匹配 /^\d+$/ 且 > 0 → Number()
 *   - undefined（未提供）→ undefined 透传，runAcceptances 按验收 type 分档
 *     （timeoutForAcceptance：单测 10min / e2e 30min）
 *   - 其余（含裸 --timeout-ms 的 boolean true、非数字 string、≤ 0）一律报错：
 *     显式输入静默变形比报错更糟
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
      `cw verify: 非法 --timeout-ms "${String(raw)}"：须为正整数（毫秒）。` +
      `恢复动作：如 --timeout-ms 300000；省略则按验收 type 分档默认` +
      `（unit/integration ${UNIT_ACCEPTANCE_TIMEOUT_MS}ms、e2e-real/e2e-mock ${E2E_ACCEPTANCE_TIMEOUT_MS}ms）。`,
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

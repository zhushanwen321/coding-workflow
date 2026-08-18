/**
 * `cw verify --unit <id> [--timeout-ms <n>] [--no-red-phase]`（u4a/u4b 验收文档
 * 锁定规格；rv-4 起红阶段默认执行——三道 gate 并列，恒真测试在自动链路上必死）。
 *
 * 干净重跑验证（第一/二道 gate）：取最后一条 spec（冻结验收）与最后一条 build
 * evidence 的 commit，cleanCheckout 到一次性工作区，逐条重跑非 manual 验收——
 * u4b 起判定不再是 exit code，而是适配器路由（type → u5 适配器）+ nameMatch
 * 名字级比对；manual 并入 acceptanceIds（免机器验证语义），产物落盘
 * evidence/<unitId>/<runId>/。
 *
 * 红阶段 gate（第三道，rv-4 起默认执行、`--no-red-phase` 关闭、`--red-phase`
 * 保留为显式同义）：checkout build commit 的第一父（实现前基线树），同一套验收
 * 逐条期望 fail（同一适配器路由；「验收 command 引用的变更文件」先 patch 进父
 * 树，防新建文件绕过）。任一无区分力（恒真测试/假命令）→ verify 整体 fail——
 * 红阶段 fail 与常规 fail 是并列的三道 gate 语义，都入账 VerifyRan（rv-4 废除
 * 旧 standalone 模式「红阶段不写 VerifyRan」——verify 总是入账）。无父 commit
 * （build commit 为仓库首提交）→ 该批验收红阶段合法跳过（redPhase 节
 * skipped: true），不影响判定；manual 型验收不跑红阶段。逐条结果并入 report.json
 * 的 redPhase 节（结构 [{id, discriminative, skipped?, reason}]，VerifyRan payload
 * schema 不变——reportHash 已覆盖报告内容），红阶段执行产物另落 red-phase-
 * 前缀 runId 目录留审计。
 *
 * exit 语义（验收文档锁定）：
 *   - 常规全 pass 且红阶段全有区分力（或合法跳过）→ result=pass，exit 0
 *   - 任一 gate fail → result=fail，exit 1（stderr 列失败验收/无区分力条目与
 *     原因）；fail 也入账（打回依据，审计必需）
 *   - 环境错误（unit/spec/build 证据缺失、clone/checkout 失败、红阶段 git/patch
 *     失败、入账失败）→ exit 2，不入账
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
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
/** report.json 缩进宽度（与 verify/run.ts 的落盘格式逐字节同口径——redPhase 节并入后格式不变） */
const REPORT_INDENT = 2;

/**
 * 红阶段单条判定入 report.json redPhase 节的形态（rv4-acceptance §2 锁定结构）：
 * [{id, discriminative, skipped?, reason}]。skipped 条目（无父 commit）的
 * discriminative 恒 true——合法跳过不参与 fail 判定。
 */
interface RedPhaseReportEntry {
  id: string;
  discriminative: boolean;
  reason: string;
  /** true = 该验收不适用红阶段（无父 commit 等），不影响判定 */
  skipped?: boolean;
}

/** 红阶段执行结果：ok=false 是环境错误（exit 2 路径），与判定 fail（entries 内）区分 */
type RedPhaseExecution =
  | { ok: true; entries: RedPhaseReportEntry[]; evidenceBase: string }
  | { ok: false; error: string };

export async function handleVerify(ctx: CommandContext): Promise<number> {
  const unitId = stringArg(ctx.argv, "unit");
  if (unitId === undefined) {
    return fail(
      "cw verify: 缺少 --unit <id>。恢复动作：cw verify --unit <unitId> [--timeout-ms <毫秒数>] [--no-red-phase（关闭红阶段检查）]。",
    );
  }
  const timeout = parseTimeoutMs(ctx.argv["timeout-ms"]);
  if (!timeout.ok) {
    return fail(timeout.error);
  }
  // rv-4：红阶段默认执行。minimist 把 --no-red-phase 折叠为 red-phase: false、
  // --red-phase 解析为 true（两者同义幂等；正序混写（--red-phase --no-red-phase）
  // 以 --no-red-phase 为准，反序 last-wins 是 minimist 折叠后的已知边界——flag
  // 信息在 dispatch 层已丢失，无法区分「只 --red-phase」与反序混写）
  const redPhaseEnabled = ctx.argv["red-phase"] !== false;

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

  return runRegularVerify(ctx.cwd, unitId, timeout.value, lastSpec, lastEvidence, redPhaseEnabled);
}

/**
 * 常规干净重跑（第一/二道 gate）+ 红阶段区分力检查（第三道，rv-4 默认执行）：
 * 常规执行在先、红阶段在后；红阶段逐条结果并入 report.json 的 redPhase 节后
 * 计算 reportHash；pass/fail 都入账 VerifyRan → stdout 摘要 / stderr 失败明细。
 */
function runRegularVerify(
  cwd: string,
  unitId: string,
  timeoutMs: number | undefined,
  lastSpec: SpecSubmittedPayload,
  lastEvidence: EvidenceSubmittedPayload,
  redPhaseEnabled: boolean,
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

  // 红阶段（第三道 gate）：干净重跑 + 名字比对之后执行；环境错误 → exit 2 不入账
  let redPhase: RedPhaseReportEntry[] = [];
  let redPhaseEvidenceBase = "";
  if (redPhaseEnabled) {
    const red = executeRedPhase(cwd, unitId, timeoutMs, lastSpec, lastEvidence);
    if (!red.ok) {
      return envError(red.error);
    }
    redPhase = red.entries;
    redPhaseEvidenceBase = red.evidenceBase;
  }

  // 三道 gate 并列：常规红或红阶段无区分力任一存在 → fail
  const regularFailed = outcome.results.filter((r) => r.status === "fail");
  const redFailed = redPhase.filter((e) => !e.discriminative && e.skipped !== true);
  const result = regularFailed.length === 0 && redFailed.length === 0 ? "pass" : "fail";
  // acceptanceIds = 机器判定 pass 的 ∪ manual 的（spec 顺序）；fail 的不进——
  // 语义锚定常规判定（红阶段 fail 是验收质量问题，不改机器 pass 事实）
  const statusById = new Map(outcome.results.map((r) => [r.id, r.status]));
  const acceptanceIds = lastSpec.acceptance
    .filter((ac) => ac.type === "manual" || statusById.get(ac.id) === "pass")
    .map((ac) => ac.id);

  // 红阶段逐条结果并入 report.json 的 redPhase 节（VerifyRan payload schema 不变
  // ——reportHash 覆盖报告内容）；重写与 run.ts 落盘格式逐字节同口径
  const reportWithRedPhase = { ...outcome.report, redPhase };
  const reportRawFinal = Buffer.from(
    `${JSON.stringify(reportWithRedPhase, null, REPORT_INDENT)}\n`,
    "utf-8",
  );
  try {
    writeFileSync(join(evidenceBase, REPORT_FILE_NAME), reportRawFinal);
  } catch (e) {
    return envError(
      `cw verify: report.json 并入 redPhase 节失败（产物目录 ${evidenceBase}）：` +
        `${e instanceof Error ? e.message : String(e)}。恢复动作：检查磁盘权限与 evidence 目录可写性后重试。`,
    );
  }

  // pass/fail 都入账（fail 的 verify 是打回依据）；入账失败 = 审计链断裂，归环境错误
  const payload: VerifyRanPayload = {
    unitId,
    runId,
    reportHash: sha256Hex(reportRawFinal),
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

  writeSummary(lastSpec, statusById, redPhase, { unitId, runId, result, evidenceBase });

  if (result === "fail") {
    const errLines = [
      `cw verify: unit "${unitId}" 有 ${regularFailed.length} 条验收失败：`,
      ...regularFailed.map((r) => `  ${r.id}: ${r.reason ?? "未知原因"}`),
    ];
    if (redFailed.length > 0) {
      errLines.push(
        `红阶段：${redFailed.length} 条验收无区分力（恒真测试防线——新测试在旧代码树必须 fail，恒真测试会被拒）：`,
        ...redFailed.map((e) => `  ${e.id}: ${e.reason}`),
        "恢复动作：修测试而非修 gate——让验收引用实现产物（命令在父 commit 上因文件缺失/接口不存在而失败），勿弱化判定绕过。",
      );
      if (redPhaseEvidenceBase !== "") {
        errLines.push(`红阶段产物：${join(redPhaseEvidenceBase, REPORT_FILE_NAME)}`);
      }
    }
    errLines.push(
      `产物报告：${join(evidenceBase, REPORT_FILE_NAME)}`,
      // fx-1 R2：旧文案「重新提交 spec + build 证据并重审」会诱导 builder 重提
      // spec → deriveStatus 判回 created → 派发真空死区。验收冻结不动是默认路径
      `恢复动作：修复代码并 git commit 后，仅重新 cw evidence submit --kind build --unit ${unitId} --commit <hash> --run-id <新id> 再 cw verify；spec 冻结不动（改验收走重新 spec 是另一路径，需重新过审）。`,
      "",
    );
    process.stderr.write(errLines.join("\n"));
    return 1;
  }
  return 0;
}

/**
 * 红阶段执行（第三道 gate 的执行体，rv-4 起内嵌于 verify 主流程）：
 *   - manual 型验收不跑红阶段（免机器验证语义）→ entries 为空；
 *   - build commit 无父（仓库首提交）→ 逐条合法跳过（skipped: true），不影响判定
 *     （rv4-acceptance §4：单 commit 仓库 verify 必须可用）；
 *   - 有父 → checkout 第一父 + patch 验收引用文件 + 重跑 + judgeRedPhase 四态判定
 *     （判定语义在 red-phase.ts，零变更）。
 * 红阶段执行产物（父树上的逐验收 stdout/stderr/report）落 red-phase- 前缀 runId
 * 目录留审计；ok=false 为环境错误（git/checkout/patch/框架失败），调用方走 exit 2。
 */
function executeRedPhase(
  cwd: string,
  unitId: string,
  timeoutMs: number | undefined,
  lastSpec: SpecSubmittedPayload,
  lastEvidence: EvidenceSubmittedPayload,
): RedPhaseExecution {
  const machineAcceptance = lastSpec.acceptance.filter((ac) => ac.type !== "manual");
  if (machineAcceptance.length === 0) {
    return { ok: true, entries: [], evidenceBase: "" };
  }

  const parent = firstParentOf(cwd, lastEvidence.commit);
  if (!parent.ok) {
    if (parent.noParent) {
      return {
        ok: true,
        entries: machineAcceptance.map((ac) => ({
          id: ac.id,
          discriminative: true,
          skipped: true,
          reason:
            "无父 commit，红阶段不适用（build commit 为仓库首提交，无「实现前」基线树可回退）",
        })),
        evidenceBase: "",
      };
    }
    return {
      ok: false,
      error:
        `cw verify: 无法定位 unit "${unitId}" build commit ${lastEvidence.commit} 的父 commit：${parent.error}。` +
        "恢复动作：确认 cwd 是目标 git 仓库且 commit 真实存在后重试。",
    };
  }

  const checkout = cleanCheckout(cwd, parent.commit);
  if (!checkout.ok) {
    return {
      ok: false,
      error:
        `cw verify: 红阶段干净 checkout 失败（父 commit ${parent.commit}，仓库 "${cwd}"）：${checkout.error}。` +
        "恢复动作：确认 cwd 是目标 git 仓库、commit 真实存在（git cat-file -e '<commit>^{commit}'）后重试。",
    };
  }

  const runId = `red-phase-${randomUUID()}`;
  const evidenceBase = evidenceDir(getCwHome(), cwd, unitId, runId);
  let outcome: RunOutcome;
  let patchedFiles: string[] = [];
  try {
    // patch 语义（红阶段区分力前提，rv-4 零变更）：验收 command 引用的变更文件
    // （新测试入口）从 build commit 带进父树再跑；无可 patch 文件时父树原样跑
    const patch = patchAcceptanceFilesForRedPhase(
      checkout.dir,
      parent.commit,
      lastEvidence.commit,
      lastSpec.acceptance,
    );
    if (!patch.ok) {
      return {
        ok: false,
        error:
          `cw verify: 红阶段新测试 patch 到父树失败（父 ${parent.commit} / build ${lastEvidence.commit}，工作区 ${checkout.dir}）：${patch.error}。` +
          "恢复动作：确认两 commit 在仓库中真实可达（git cat-file -e '<commit>^{commit}'）后重跑。",
      };
    }
    patchedFiles = patch.files;
    outcome = runAcceptances(checkout.dir, lastSpec.acceptance, evidenceBase, timeoutMs);
  } catch (e) {
    return {
      ok: false,
      error:
        `cw verify: 红阶段验收执行框架失败（产物目录 ${evidenceBase}）：${e instanceof Error ? e.message : String(e)}。` +
        "恢复动作：检查磁盘权限与 evidence 目录可写性后重试。",
    };
  } finally {
    cleanupCheckout(checkout.dir);
  }

  const verdicts = judgeRedPhase(outcome.results, { patchedFiles });
  return {
    ok: true,
    entries: verdicts.map((v) => ({
      id: v.id,
      discriminative: v.discriminative,
      reason: v.reason,
    })),
    evidenceBase,
  };
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

/**
 * stdout 人可读摘要：逐条 `<id> <pass|fail|manual>` + 红阶段逐条区分力 + 总结行
 * （rv-4 起红阶段是摘要的一部分——三道 gate 的结果一次可见）。
 */
function writeSummary(
  spec: SpecSubmittedPayload,
  statusById: Map<string, "pass" | "fail">,
  redPhase: readonly RedPhaseReportEntry[],
  run: { unitId: string; runId: string; result: "pass" | "fail"; evidenceBase: string },
): void {
  const lines = spec.acceptance.map((ac) => {
    if (ac.type === "manual") {
      return `${ac.id} manual`;
    }
    return `${ac.id} ${statusById.get(ac.id) === "pass" ? "pass" : "fail"}`;
  });
  const redLines = redPhase.map((e) =>
    e.skipped === true
      ? `  ${e.id} 跳过（${e.reason}）`
      : `  ${e.id} ${e.discriminative ? "有区分力" : "无区分力"}`,
  );
  const passCount = spec.acceptance.filter((ac) => statusById.get(ac.id) === "pass").length;
  const failCount = spec.acceptance.filter((ac) => statusById.get(ac.id) === "fail").length;
  const manualCount = spec.acceptance.filter((ac) => ac.type === "manual").length;
  process.stdout.write(
    [
      ...lines,
      ...(redLines.length > 0 ? ["红阶段（区分力）：", ...redLines] : []),
      `verify unit "${run.unitId}" result=${run.result} (pass=${passCount} fail=${failCount} manual=${manualCount})`,
      `runId=${run.runId}`,
      `report: ${join(run.evidenceBase, REPORT_FILE_NAME)}`,
      "",
    ].join("\n"),
  );
}

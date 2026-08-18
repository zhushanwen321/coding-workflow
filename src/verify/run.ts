/**
 * 验收执行器（canon 子文档 2《design-child-testrun.md》§6.3 纪律①③④⑤）。
 *
 * u4b 升级：执行不再用 exit code 直接判定，而是按验收 type 路由 u5 适配器
 * （e2e-real/e2e-mock → e2e-sh；unit/integration → vitest），经 translate 改写
 * 命令、parse 产物为 EvidenceReport，再由 nameMatch 做名字级判定：
 *   - translate（e2e 缺 command）/ parse（产物无标记 / 非 vitest JSON）抛错 →
 *     该条 fail，reason 透传适配器错误（vitest 型另附「须为 vitest 兼容命令」）；
 *   - 判定事实 = nameMatch：验收 id 出现在 cases 的用例名中且全部 pass。
 *
 * rv-5 豁免点②（聚合判定）：`nondeterministic: true` 的条目照常执行、产物照常
 * 落盘，但其 fail **不计入整体 result**——status 恒为 pass（report.exitCode 与
 * 调用方 handler 的 regularFailed/acceptanceIds 聚合都消费 status，豁免在此单点
 * 生效）；原始 fail 事实由 rawStatus + reason + report.json cases 照录（审计完整）。
 * 声明条目全 pass 也不额外加分（pass 判定只看未声明条目——聚合天然如此）。
 *
 * 纪律落地（u4a 起保持）：
 *   - ③ 产物落盘：每条验收 `<id>.stdout`/`.stderr`（超时另加 `.timeout` 标记）+
 *     适配器折叠出的 `<id>.report.json`（nameMatch 的输入，审计可重放）+ 总报告
 *     report.json（EvidenceReport 结构 + 逐产物 sha256 的 artifacts 数组，
 *     rawPath 指向自身——VerifyRan.reportHash 由此间接锁定全部产物内容：两次
 *     重跑 reportHash 一致 ⟹ 产物内容一致）；
 *   - ④ 超时与回收：每条验收独立进程组执行（detached spawn，pgid = pid）+
 *     按 type 分档的超时（timeoutForAcceptance：单测 10min / e2e 30min；显式
 *     timeoutMs 覆盖分档）。到点 kill(-pgid) 整树终止（含孙进程）——旧
 *     spawnSync 只 SIGTERM 直接子进程，dev server / test worker 等孙进程会成
 *     孤儿存活，残留 dev server 让后续 e2e 验收假绿；正常完成也回收同组余党
 *     （命令退出但后台进程仍挂的场景同理）；
 *   - ① 环境隔离：验收子进程的 CW_HOME 指向一次性 mkdtemp 目录（PATH 继承），
 *     防止验收命令读写真实 ~/.cw 账本，跑完即清理。
 *
 * manual 用例在此跳过（免机器验证语义）——并入 acceptanceIds 由 handler 负责。
 * AcceptanceRunResult 的 commandExit/parseError 是红阶段 gate 的判定输入（旧树
 * 「命令效果上成功但产物无效」= 无区分力），常规 verify 路径不消费。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import type { AcceptanceItem, AcceptanceType } from "../events/types.js";
import { defaultRegistry } from "../testrun/registry.js";
import type { AdapterRegistry, EvidenceReport } from "../testrun/types.js";
import { nameMatch } from "./name-match.js";

/** 总报告文件名（evidence 目录内） */
const REPORT_FILE_NAME = "report.json";
/** report.json 缩进宽度（2 空格，与只读命令 --json 输出一致） */
const REPORT_INDENT = 2;

/** 单条验收命令默认超时——单测口径 10min（canon §6.3 纪律④） */
export const UNIT_ACCEPTANCE_TIMEOUT_MS = 600_000;
/** 单条验收命令默认超时——e2e 口径 30min（canon §6.3 纪律④双档） */
export const E2E_ACCEPTANCE_TIMEOUT_MS = 1_800_000;

/**
 * 验收 type → 默认超时分档：unit/integration 10min、e2e-real/e2e-mock 30min。
 * manual 不经机器执行（runAcceptances 跳过），取单测口径仅保持穷尽（值无意义）。
 */
export function timeoutForAcceptance(type: AcceptanceType): number {
  switch (type) {
    case "unit":
    case "integration":
    case "manual":
      return UNIT_ACCEPTANCE_TIMEOUT_MS;
    case "e2e-real":
    case "e2e-mock":
      return E2E_ACCEPTANCE_TIMEOUT_MS;
  }
}

export interface AcceptanceRunResult {
  id: string;
  status: "pass" | "fail";
  stdoutPath: string;
  stderrPath: string;
  /** 该条是否因超时被 kill */
  timeout: boolean;
  /**
   * fail 的人可读原因（nameMatch / parse / 超时 / 适配器拒绝）。rv-5 起
   * nondeterministic 条目经豁免 status=pass 时也照录原始 fail 原因（审计：
   * 豁免改写的是聚合判定，不是抹掉失败事实）
   */
  reason?: string;
  /** 命令进程 exit code（判定之前的事实；未执行 / 超时 / spawn 失败为 null） */
  commandExit: number | null;
  /** 适配器 translate/parse 是否抛错（无法产出可判定的 EvidenceReport） */
  parseError: boolean;
  /** 名字比对跳过标记（rv-5 豁免点①）：nondeterministic 声明条目恒带 */
  nameSkipped?: "nondeterministic";
  /**
   * 声明条目的原始执行结果（rv-5 照录）：status 经豁免点②改写为 pass 时，
   * 原始 fail 事实由此字段保留（report.json cases 按它照录）。未声明条目
   * 无此字段（status 即原始结果）。
   */
  rawStatus?: "pass" | "fail";
}

/**
 * report.json 的落盘形态：EvidenceReport 契约（u5 testrun 缝，不得改其 schema）+
 * 逐产物 sha256 扩展。VerifyRan.reportHash 的计算输入是整个 report.json 字节，
 * artifacts 入 report ⟹ reportHash 间接锁定全部产物内容 hash（两次重跑
 * reportHash 一致 ⟹ 产物内容一致）——不改 VerifyRan 事件 payload schema。
 */
interface VerifyReport extends EvidenceReport {
  /**
   * rv-5：声明条目（nondeterministic）的 case 携带 nameSkipped（名字比对跳过
   * 标记）与 exitCode（真实执行的命令退出码——「非 skip 执行」的机器事实），
   * status 按原始结果照录（豁免只作用于整体聚合，不改写条目审计事实）。
   * 未声明条目的 case 形状不变（id/name/status 三字段，历史报告可比）。
   */
  cases: Array<{
    id: string;
    name: string;
    status: "pass" | "fail";
    nameSkipped?: "nondeterministic";
    exitCode?: number;
  }>;
  /** 逐条验收产物内容 hash（超时条目的 stderr 含超时标记，同样入 hash） */
  artifacts: Array<{ id: string; stdoutSha256: string; stderrSha256: string }>;
}

export interface RunOutcome {
  results: AcceptanceRunResult[];
  report: VerifyReport;
  /** report.json 落盘原始字节（VerifyRan.reportHash 的计算输入，避免二次读取） */
  reportRaw: Buffer;
}

/**
 * 在干净 checkout 工作区逐条执行验收（跳过 manual），产物落盘 evidenceBaseDir，
 * 返回逐条结果与总报告。文件系统故障（不可写等）直接上抛，由调用方归入环境错误。
 *
 * timeoutMs 省略时按验收 type 分档（timeoutForAcceptance：单测 10min / e2e 30min）；
 * 显式传入（--timeout-ms 逃生口）则覆盖分档，整轮统一用该值。
 */
export function runAcceptances(
  checkoutDir: string,
  acceptance: readonly AcceptanceItem[],
  evidenceBaseDir: string,
  timeoutMs?: number,
): RunOutcome {
  mkdirSync(evidenceBaseDir, { recursive: true });
  const isolatedCwHome = mkdtempSync(join(tmpdir(), "cw-verify-env-"));
  const env: NodeJS.ProcessEnv = { ...process.env, CW_HOME: isolatedCwHome };
  const registry = defaultRegistry();
  const titles = new Map(acceptance.map((ac) => [ac.id, ac.title]));

  const results: AcceptanceRunResult[] = [];
  try {
    for (const ac of acceptance) {
      if (ac.type === "manual") {
        continue;
      }
      results.push(
        runOne(ac, checkoutDir, evidenceBaseDir, env, isolatedCwHome, timeoutMs ?? timeoutForAcceptance(ac.type), registry),
      );
    }
  } finally {
    rmSync(isolatedCwHome, { recursive: true, force: true });
  }

  // 逐产物 sha256（在 runOne 全部落盘后计算——含 parse 失败追加到 stderr 的判定原因）
  const artifacts = results.map((r) => ({
    id: r.id,
    stdoutSha256: sha256OfFile(r.stdoutPath),
    stderrSha256: sha256OfFile(r.stderrPath),
  }));
  const report: VerifyReport = {
    exitCode: results.some((r) => r.status === "fail") ? 1 : 0,
    // 总报告的 name 用验收 title（P2 稳定重跑比对口径）：用例级细节在 <id>.report.json。
    // rv-5：声明条目的 case 按原始结果照录（rawStatus），豁免不改写审计事实
    cases: results.map((r) =>
      r.nameSkipped === "nondeterministic"
        ? {
            id: r.id,
            name: titles.get(r.id) ?? "",
            status: r.rawStatus ?? r.status,
            nameSkipped: "nondeterministic" as const,
            exitCode: r.commandExit ?? -1,
          }
        : { id: r.id, name: titles.get(r.id) ?? "", status: r.status },
    ),
    artifacts,
    rawPath: join(evidenceBaseDir, REPORT_FILE_NAME),
  };
  const reportRaw = Buffer.from(`${JSON.stringify(report, null, REPORT_INDENT)}\n`, "utf-8");
  writeFileSync(report.rawPath, reportRaw);
  return { results, report, reportRaw };
}

/**
 * 验收 type/runner → 适配器 type 路由（u4b 验收文档规格锁定 1 + mx-2 runner
 * 显式声明）。runner 非空优先返回（显式声明优先，canon §6.1「适配器选择是
 * 确定性查找」裁决 A——type 不再独占路由决策）；空则按 type 现状推导（存量
 * 验收行为逐字节不变，回归锁）。runner 的合法性由 spec gate 规则⑧在提交时
 * 拦（gate 是唯一入口，verify 侧不二次校验）——绕过 gate 的非法 runner 在此
 * 原样返回、registry 查不到，由 runOne 的「路由不到适配器」fail 分支显性暴露。
 */
export function adapterTypeFor(type: AcceptanceType, runner?: string): string {
  if (runner !== undefined && runner !== "") {
    return runner;
  }
  switch (type) {
    case "unit":
    case "integration":
      return "vitest";
    case "e2e-real":
    case "e2e-mock":
      return "e2e-sh";
    case "manual":
      // manual 在 runAcceptances 已跳过，不应路由；返回无对应适配器的 key，
      // 漏跳时由 runOne 的「路由不到适配器」fail 分支显性暴露而非静默漏跑
      return "manual";
  }
}

/**
 * rv-5 豁免形态：声明条目（nondeterministic）的任一 fail 路径都不计入整体
 * 判定（status=pass），原始失败事实全量照录（reason 进 stderr 与结果对象、
 * commandExit/parseError/timeout 保持真实值、rawStatus="fail" 供 report 照录）。
 * 各 fail 分支共用；豁免点①（名字比对跳过）由 nameMatch 承担。
 */
function exemptNondeterministic(
  ac: AcceptanceItem,
  fail: { reason: string; timeout: boolean; commandExit: number | null; parseError: boolean },
  stdoutPath: string,
  stderrPath: string,
): AcceptanceRunResult {
  return {
    id: ac.id,
    status: "pass",
    stdoutPath,
    stderrPath,
    timeout: fail.timeout,
    reason: fail.reason,
    commandExit: fail.commandExit,
    parseError: fail.parseError,
    nameSkipped: "nondeterministic",
    rawStatus: "fail",
  };
}

/**
 * 声明条目 parse 成功后的原始结果（照录口径）：名字比对已跳过（豁免点①），
 * 剩余原始信号 = 进程退出码 + 适配器折叠出的用例级状态（任一 fail 即原始
 * fail）。
 */
function rawOutcomeOf(report: EvidenceReport, exitCode: number): "pass" | "fail" {
  if (exitCode !== 0) {
    return "fail";
  }
  return report.cases.some((c) => c.status === "fail") ? "fail" : "pass";
}

/**
 * 执行单条非 manual 验收：适配器 translate → bash 执行 → 适配器 parse →
 * nameMatch 判定。任何一环失败都是该条 fail（verify 整体 exit 1 路径），
 * 不中断其余验收。nondeterministic 声明条目的 fail 走豁免形态（见
 * exemptNondeterministic）——声明 ≠ 逃逸：执行与产物照常，聚合不翻红。
 */
function runOne(
  ac: AcceptanceItem,
  checkoutDir: string,
  evidenceBaseDir: string,
  env: NodeJS.ProcessEnv,
  /** 哨兵文件目录（一次性 CW_HOME 隔离目录）：命令退出码经哨兵文件传出 */
  sentinelDir: string,
  timeoutMs: number,
  registry: AdapterRegistry,
): AcceptanceRunResult {
  const stem = fileStem(ac.id);
  const stdoutPath = join(evidenceBaseDir, `${stem}.stdout`);
  const stderrPath = join(evidenceBaseDir, `${stem}.stderr`);

  // registry 来自 defaultRegistry（M0 装配），adapterTypeFor 的返回值恒有对应项；
  // 缺项 = 装配缺陷（或绕过 gate 规则⑧的非法 runner），按该条 fail 显性暴露
  // 而非抛异常中断整轮 verify
  const adapter = registry.get(adapterTypeFor(ac.type, ac.runner));
  if (adapter === undefined) {
    const reason = `验收 ${ac.id}（type=${ac.type}）路由不到适配器`;
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, `${reason}\n`);
    if (ac.nondeterministic === true) {
      return exemptNondeterministic(ac, { reason, timeout: false, commandExit: null, parseError: true }, stdoutPath, stderrPath);
    }
    return { id: ac.id, status: "fail", stdoutPath, stderrPath, timeout: false, reason, commandExit: null, parseError: true };
  }

  let command: string;
  try {
    command = adapter.translate(ac);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, `${reason}\n`);
    if (ac.nondeterministic === true) {
      return exemptNondeterministic(ac, { reason, timeout: false, commandExit: null, parseError: true }, stdoutPath, stderrPath);
    }
    return { id: ac.id, status: "fail", stdoutPath, stderrPath, timeout: false, reason, commandExit: null, parseError: true };
  }

  const exec = execBashTree(
    command,
    checkoutDir,
    env,
    stdoutPath,
    stderrPath,
    join(sentinelDir, `${stem}.exit`),
    timeoutMs,
  );

  if (exec.kind === "spawn-error") {
    const reason = `无法执行 bash -c：${exec.message}`;
    appendFile(stderrPath, `${reason}\n`);
    if (ac.nondeterministic === true) {
      return exemptNondeterministic(ac, { reason, timeout: false, commandExit: null, parseError: false }, stdoutPath, stderrPath);
    }
    return { id: ac.id, status: "fail", stdoutPath, stderrPath, timeout: false, reason, commandExit: null, parseError: false };
  }

  // 超时路径：进程组已被整树 SIGKILL，stdout/stderr 文件里是子进程死前的部分输出
  if (exec.kind === "timeout") {
    const timeoutNote = `command timed out after ${timeoutMs} ms, killed`;
    appendFile(stderrPath, `${timeoutNote}\n`);
    writeFileSync(join(evidenceBaseDir, `${stem}.timeout`), `${timeoutNote}\n`);
    const reason =
      `超时（>${timeoutMs}ms）被 kill。` +
      `恢复动作：用 cw verify --unit <id> --timeout-ms <毫秒> 增大超时（默认 unit ${UNIT_ACCEPTANCE_TIMEOUT_MS}ms / e2e ${E2E_ACCEPTANCE_TIMEOUT_MS}ms），` +
      "或拆分验收降低单条耗时。";
    if (ac.nondeterministic === true) {
      return exemptNondeterministic(ac, { reason, timeout: true, commandExit: null, parseError: false }, stdoutPath, stderrPath);
    }
    return {
      id: ac.id,
      status: "fail",
      stdoutPath,
      stderrPath,
      timeout: true,
      reason,
      commandExit: null,
      parseError: false,
    };
  }

  const exitCode = exec.exitCode;

  let report: EvidenceReport;
  try {
    report = adapter.parse(stdoutPath, exitCode, ac);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // vitest 型的 parse 失败多为「command 非 vitest 兼容」——按验收文档规格锁定 1
    // 附恢复方向；e2e 型的适配器错误自带恢复动作文案，原样透传。runner 显式声明
    // 时不加 vitest 提示（路由已由 runner 决定，pytest/playwright 适配器的错误
    // 消息自带恢复动作，vitest 提示会误导）
    const hint =
      (ac.type === "unit" || ac.type === "integration") && ac.runner === undefined
        ? "。unit/integration 验收的 command 须为 vitest 兼容命令（如 npx vitest run --reporter=json，产出 vitest JSON reporter 产物）"
        : "";
    const reason = `验收 ${ac.id} 产物解析失败：${detail}${hint}`;
    appendFile(stderrPath, `${reason}\n`);
    // rv-2 审计增量：parse 失败条目的 command exit code 此前只存内存（调用方拿
    // 到 AcceptanceRunResult），审计 <id>.report.json 时须从 stderr 文本反推——
    // 落盘最小 JSON 补齐产物事实。不改判定语义（fail + reason 进 stderr 照旧），
    // 文件与正常条目同目录同命名规则（<id-stem>.report.json）
    writeFileSync(
      join(evidenceBaseDir, `${stem}.report.json`),
      `${JSON.stringify({ parseError: true, commandExit: exitCode, reason }, null, REPORT_INDENT)}\n`,
    );
    if (ac.nondeterministic === true) {
      return exemptNondeterministic(ac, { reason, timeout: false, commandExit: exitCode, parseError: true }, stdoutPath, stderrPath);
    }
    return { id: ac.id, status: "fail", stdoutPath, stderrPath, timeout: false, reason, commandExit: exitCode, parseError: true };
  }

  // 适配器折叠出的 EvidenceReport 落盘留审计（nameMatch 的输入可重放）
  writeFileSync(
    join(evidenceBaseDir, `${stem}.report.json`),
    `${JSON.stringify(report, null, REPORT_INDENT)}\n`,
  );

  const verdict = nameMatch(ac, report);
  if (verdict.nameSkipped === "nondeterministic") {
    // rv-5：声明条目——豁免点①已由 nameMatch 生效（比对跳过，verdict.pass 恒
    // true），此处执行豁免点②（原始 fail 不计入整体）并照录原始结果
    const rawStatus = rawOutcomeOf(report, exitCode);
    const reason =
      rawStatus === "fail"
        ? `验收 ${ac.id} 原始执行失败（nondeterministic 声明豁免：单次 fail 不计入整体判定，原始结果照录 report）：` +
          (exitCode !== 0
            ? `exit ${exitCode}`
            : `用例级 fail：${report.cases.filter((c) => c.status === "fail").map((c) => c.name).join("; ")}`)
        : undefined;
    if (reason !== undefined) {
      appendFile(stderrPath, `${reason}\n`);
    }
    return {
      id: ac.id,
      status: "pass",
      stdoutPath,
      stderrPath,
      timeout: false,
      reason,
      commandExit: exitCode,
      parseError: false,
      nameSkipped: "nondeterministic",
      rawStatus,
    };
  }
  if (!verdict.pass) {
    appendFile(stderrPath, `${verdict.reason}\n`);
  }
  return {
    id: ac.id,
    status: verdict.pass ? "pass" : "fail",
    stdoutPath,
    stderrPath,
    timeout: false,
    reason: verdict.pass ? undefined : verdict.reason,
    commandExit: exitCode,
    parseError: false,
  };
}

/** 追加写（不覆盖适配器/子进程已落盘的 stderr 事实，判定原因接在其后） */
function appendFile(path: string, text: string): void {
  const prev = existingContent(path);
  writeFileSync(path, `${prev}${text}`);
}

function existingContent(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    // parse 失败路径下 stderr 产物可能尚未写过（translate 抛错分支已写过）——空底
    return "";
  }
}

/**
 * 验收 id → 产物文件名安全形式：白名单外字符替换为 `_`（id 是 spec 作者输入，
 * 含 `/` 等路径字符时会逃逸 evidence 目录）。M0 下不同 id 碰撞为同一文件名的
 * 情形由 spec 唯一性约束（unit 内 id 唯一）+ review 把关，不额外编码。
 */
function fileStem(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

// ── bash 执行引擎（进程组隔离 + 自管超时 + 整树回收） ─────────
// 参考本仓库已实测的同模式实现 src/runner/spawn/lifecycle.ts（detached + pgid
// 树 kill）。与旧 spawnSync 的关键差异：spawnSync 的 timeout 只对直接子进程
// （bash）发 SIGTERM，孙进程（dev server、vitest worker、`sleep &` 后台进程）
// 不在打击面内——超时后成孤儿存活（ppid=1），残留 dev server 让后续 e2e 验收
// 假绿。本引擎：detached spawn（子进程自成进程组组长，pgid === pid）+ 哨兵
// 文件传出退出码 + 整树 kill(-pgid, SIGKILL)。
//
// 保持同步语义（调用方命令行内联等待）：runAcceptances 是同步函数且被
// src/runner/integrate.ts 同步调用。同步等待下 Node 事件循环被阻塞，子进程的
// exit/stdout 事件永不投递——退出事实只能经文件系统观测（哨兵文件），产物
// 只能让子进程直写文件 fd（OS 层写入，与进程存活解耦，同 lifecycle.ts）。
// 等待本身用 spawnSync 起一个「轮询哨兵存在性」的辅助 bash（其 timeout 语义
// 与本文件旧用法一致：到点 ETIMEDOUT）。已知边界：命令内部自行 setsid 脱离
// 进程组的进程（守护进程化）无法被组 kill 追杀——与 lifecycle.ts 同限。

/** bash 执行结果：超时（整树已 kill）/ 正常完成（退出码来自哨兵，同组余党已回收）/ 无法启动 */
type BashExecOutcome =
  | { kind: "timeout" }
  | { kind: "done"; exitCode: number }
  | { kind: "spawn-error"; message: string };

function execBashTree(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdoutPath: string,
  stderrPath: string,
  sentinelPath: string,
  timeoutMs: number,
): BashExecOutcome {
  rmSync(sentinelPath, { force: true });
  if (!bashResolvable(env)) {
    return { kind: "spawn-error", message: "bash 不存在或不可执行（按子进程 PATH 逐段解析失败）" };
  }

  // 产物 fd 直开直写：子进程 stdout/stderr 接到文件 fd，无用户态缓冲、无
  // maxBuffer 上限（旧 spawnSync 1MB maxBuffer 会让大 vitest JSON 产物假失败）
  const stdoutFd = openSync(stdoutPath, "w");
  let stderrFd: number;
  try {
    stderrFd = openSync(stderrPath, "w");
  } catch (err) {
    closeSync(stdoutFd);
    throw err;
  }
  try {
    const sentinel = shellQuote(sentinelPath);
    // 命令本体包进子 shell：command 用 exec 自替换时哨兵仍会落盘（exec 只替换子 shell）
    const wrapped =
      `( ${command} )\n` +
      `__cw_verify_ec=$?; printf '%s\\n' "$__cw_verify_ec" > ${sentinel}; exit "$__cw_verify_ec"`;

    let child: ChildProcess;
    try {
      child = spawn("bash", ["-c", wrapped], {
        cwd,
        env,
        stdio: ["ignore", stdoutFd, stderrFd],
        // 进程组隔离：组长 pid === pgid，kill(-pgid) 整树终止（含孙进程）
        detached: true,
      });
    } catch (e) {
      return { kind: "spawn-error", message: e instanceof Error ? e.message : String(e) };
    }
    const pgid = child.pid;
    if (pgid === undefined) {
      return { kind: "spawn-error", message: "子进程未启动（pid 缺失）" };
    }

    const wait = spawnSync("bash", ["-c", `while [ ! -f ${sentinel} ]; do sleep 0.05; done`], {
      timeout: timeoutMs,
    });

    // 哨兵优先于 ETIMEDOUT 判定：与 deadline 撞车时命令可能已完成，退出码是事实
    if (existsSync(sentinelPath)) {
      reclaimGroup(pgid);
      return { kind: "done", exitCode: readSentinel(sentinelPath) };
    }
    const timedOut = wait.error !== undefined && (wait.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    if (timedOut) {
      reclaimGroup(pgid);
      return { kind: "timeout" };
    }
    // 轮询辅助进程自身故障（哨兵也没落盘）：罕见，按同路径回收后显性报错
    reclaimGroup(pgid);
    return {
      kind: "spawn-error",
      message: `等待子进程完成失败：${wait.error?.message ?? `辅助进程 exit ${wait.status ?? -1}`}`,
    };
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

/**
 * 整组回收：kill(-pgid, SIGKILL) 覆盖超时与正常完成两条路径——正常完成时直接
 * 子进程（bash）已死，但同组孙进程（`dev-server &` 余党）可能仍活，残留进程会
 * 污染后续验收。ESRCH（组已消亡）/ EPERM（macOS 对组 kill 的权限边界）静默；
 * 信号已发出时小睡等待调度落地，保证返回后同组无存活进程（SIGKILL 不可捕获
 * 阻塞，唯一延迟来自调度）。
 */
function reclaimGroup(pgid: number): void {
  let signaled = false;
  try {
    process.kill(-pgid, "SIGKILL");
    signaled = true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") {
      throw e;
    }
  }
  if (signaled) {
    spawnSync("bash", ["-c", "sleep 0.05"], { timeout: 2_000 });
  }
}

/** 哨兵内容（命令退出码）→ 数值；损坏内容按 -1（与旧 res.status ?? -1 同兜底） */
function readSentinel(path: string): number {
  const code = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
  return Number.isFinite(code) ? code : -1;
}

/** 路径嵌入 bash 命令串的单引号包裹（内含单引号时以 '\'' 转义） */
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** bash 是否可按子进程 env 的 PATH 解析为可执行普通文件（ENOENT 预检；无 PATH 放行走系统默认） */
function bashResolvable(env: NodeJS.ProcessEnv): boolean {
  const path = env.PATH;
  if (path === undefined) {
    return true;
  }
  return path.split(delimiter).some((dir) => isExecutableFile(join(dir, "bash")));
}

/** 是否为「存在的可执行普通文件」（statSync 跟随 symlink，与 execvp 解析一致） */
function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile() && accessSync(path, constants.X_OK) === undefined;
  } catch {
    return false;
  }
}

/** 文件内容 sha256（hex）——report.json 的逐产物 hash 来源 */
function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

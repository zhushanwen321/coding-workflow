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
 * 纪律落地（u4a 起保持）：
 *   - ③ 产物落盘：每条验收 `<id>.stdout`/`.stderr`（超时另加 `.timeout` 标记）+
 *     适配器折叠出的 `<id>.report.json`（nameMatch 的输入，审计可重放）+ 总报告
 *     report.json（EvidenceReport 结构，rawPath 指向自身）；
 *   - ④ 超时与回收：每条命令独立 spawnSync timeout，超时 kill 该条进程并标 fail；
 *   - ① 环境隔离：验收子进程的 CW_HOME 指向一次性 mkdtemp 目录（PATH 继承），
 *     防止验收命令读写真实 ~/.cw 账本，跑完即清理。
 *
 * manual 用例在此跳过（免机器验证语义）——并入 acceptanceIds 由 handler 负责。
 * AcceptanceRunResult 的 commandExit/parseError 是红阶段 gate 的判定输入（旧树
 * 「命令效果上成功但产物无效」= 无区分力），常规 verify 路径不消费。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcceptanceItem, AcceptanceType } from "../events/types.js";
import { defaultRegistry } from "../testrun/registry.js";
import type { AdapterRegistry, EvidenceReport } from "../testrun/types.js";
import { nameMatch } from "./name-match.js";

/** 总报告文件名（evidence 目录内） */
const REPORT_FILE_NAME = "report.json";
/** report.json 缩进宽度（2 空格，与只读命令 --json 输出一致） */
const REPORT_INDENT = 2;

export interface AcceptanceRunResult {
  id: string;
  status: "pass" | "fail";
  stdoutPath: string;
  stderrPath: string;
  /** 该条是否因超时被 kill */
  timeout: boolean;
  /** fail 的人可读原因（nameMatch / parse / 超时 / 适配器拒绝），pass 时无此字段 */
  reason?: string;
  /** 命令进程 exit code（判定之前的事实；未执行 / 超时 / spawn 失败为 null） */
  commandExit: number | null;
  /** 适配器 translate/parse 是否抛错（无法产出可判定的 EvidenceReport） */
  parseError: boolean;
}

export interface RunOutcome {
  results: AcceptanceRunResult[];
  report: EvidenceReport;
  /** report.json 落盘原始字节（VerifyRan.reportHash 的计算输入，避免二次读取） */
  reportRaw: Buffer;
}

/**
 * 在干净 checkout 工作区逐条执行验收（跳过 manual），产物落盘 evidenceBaseDir，
 * 返回逐条结果与总报告。文件系统故障（不可写等）直接上抛，由调用方归入环境错误。
 */
export function runAcceptances(
  checkoutDir: string,
  acceptance: readonly AcceptanceItem[],
  evidenceBaseDir: string,
  timeoutMs: number,
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
      results.push(runOne(ac, checkoutDir, evidenceBaseDir, env, timeoutMs, registry));
    }
  } finally {
    rmSync(isolatedCwHome, { recursive: true, force: true });
  }

  const report: EvidenceReport = {
    exitCode: results.some((r) => r.status === "fail") ? 1 : 0,
    // 总报告的 name 用验收 title（P2 稳定重跑比对口径）：用例级细节在 <id>.report.json
    cases: results.map((r) => ({ id: r.id, name: titles.get(r.id) ?? "", status: r.status })),
    rawPath: join(evidenceBaseDir, REPORT_FILE_NAME),
  };
  const reportRaw = Buffer.from(`${JSON.stringify(report, null, REPORT_INDENT)}\n`, "utf-8");
  writeFileSync(report.rawPath, reportRaw);
  return { results, report, reportRaw };
}

/** 验收 type → 适配器 type 路由（u4b 验收文档规格锁定 1） */
function adapterTypeFor(type: AcceptanceType): string {
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
 * 执行单条非 manual 验收：适配器 translate → bash 执行 → 适配器 parse →
 * nameMatch 判定。任何一环失败都是该条 fail（verify 整体 exit 1 路径），
 * 不中断其余验收。
 */
function runOne(
  ac: AcceptanceItem,
  checkoutDir: string,
  evidenceBaseDir: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  registry: AdapterRegistry,
): AcceptanceRunResult {
  const stem = fileStem(ac.id);
  const stdoutPath = join(evidenceBaseDir, `${stem}.stdout`);
  const stderrPath = join(evidenceBaseDir, `${stem}.stderr`);

  // registry 来自 defaultRegistry（M0 装配），adapterTypeFor 的返回值恒有对应项；
  // 缺项 = 装配缺陷，按该条 fail 显性暴露而非抛异常中断整轮 verify
  const adapter = registry.get(adapterTypeFor(ac.type));
  if (adapter === undefined) {
    const reason = `验收 ${ac.id}（type=${ac.type}）路由不到适配器`;
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, `${reason}\n`);
    return { id: ac.id, status: "fail", stdoutPath, stderrPath, timeout: false, reason, commandExit: null, parseError: true };
  }

  let command: string;
  try {
    command = adapter.translate(ac);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, `${reason}\n`);
    return { id: ac.id, status: "fail", stdoutPath, stderrPath, timeout: false, reason, commandExit: null, parseError: true };
  }

  const res = spawnSync("bash", ["-c", command], {
    cwd: checkoutDir,
    env,
    timeout: timeoutMs,
    encoding: "utf-8",
  });
  writeFileSync(stdoutPath, res.stdout ?? "");

  // spawnSync timeout 触发时子进程已被 kill：error.code = ETIMEDOUT，status = null
  const timedOut = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  if (timedOut) {
    const timeoutNote = `command timed out after ${timeoutMs} ms, killed`;
    writeFileSync(stderrPath, `${timeoutNote}\n`);
    writeFileSync(join(evidenceBaseDir, `${stem}.timeout`), `${timeoutNote}\n`);
    return {
      id: ac.id,
      status: "fail",
      stdoutPath,
      stderrPath,
      timeout: true,
      reason: `超时（>${timeoutMs}ms）被 kill`,
      commandExit: null,
      parseError: false,
    };
  }
  if (res.error !== undefined) {
    const reason = `无法执行 bash -c：${res.error.message}`;
    writeFileSync(stderrPath, `${reason}\n`);
    return { id: ac.id, status: "fail", stdoutPath, stderrPath, timeout: false, reason, commandExit: null, parseError: false };
  }

  writeFileSync(stderrPath, res.stderr ?? "");
  const exitCode = res.status ?? -1;

  let report: EvidenceReport;
  try {
    report = adapter.parse(stdoutPath, exitCode, ac);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // vitest 型的 parse 失败多为「command 非 vitest 兼容」——按验收文档规格锁定 1
    // 附恢复方向；e2e 型的适配器错误自带恢复动作文案，原样透传
    const hint =
      ac.type === "unit" || ac.type === "integration"
        ? "。unit/integration 验收的 command 须为 vitest 兼容命令（如 npx vitest run --reporter=json，产出 vitest JSON reporter 产物）"
        : "";
    const reason = `验收 ${ac.id} 产物解析失败：${detail}${hint}`;
    appendFile(stderrPath, `${reason}\n`);
    return { id: ac.id, status: "fail", stdoutPath, stderrPath, timeout: false, reason, commandExit: exitCode, parseError: true };
  }

  // 适配器折叠出的 EvidenceReport 落盘留审计（nameMatch 的输入可重放）
  writeFileSync(
    join(evidenceBaseDir, `${stem}.report.json`),
    `${JSON.stringify(report, null, REPORT_INDENT)}\n`,
  );

  const verdict = nameMatch(ac, report);
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

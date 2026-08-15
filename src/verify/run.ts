/**
 * 验收执行器（canon 子文档 2《design-child-testrun.md》§6.3 纪律③④⑤）。
 *
 * M0 简化口径（u4a 验收文档锁定）：不用 TestRunAdapter，直接 `spawnSync("bash",
 * ["-c", command])` 逐条执行 + exit code 判定；适配器接线属 u5 后续 unit。
 *
 * 纪律落地：
 *   - ③ 产物落盘：每条验收 `<id>.stdout`/`.stderr`（超时另加 `.timeout` 标记）+
 *     总报告 report.json（EvidenceReport 结构，rawPath 指向自身）；
 *   - ④ 超时与回收：每条命令独立 spawnSync timeout，超时 kill 该条进程并标 fail；
 *   - ① 环境隔离：验收子进程的 CW_HOME 指向一次性 mkdtemp 目录（PATH 继承），
 *     防止验收命令读写真实 ~/.cw 账本，跑完即清理。
 *
 * manual 用例在此跳过（免机器验证语义）——并入 acceptanceIds 由 handler 负责。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcceptanceItem } from "../events/types.js";
import type { EvidenceReport } from "../testrun/types.js";

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
  /** fail 的人可读原因（exit code / 超时 / 缺 command），pass 时无此字段 */
  reason?: string;
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
  const titles = new Map(acceptance.map((ac) => [ac.id, ac.title]));

  const results: AcceptanceRunResult[] = [];
  try {
    for (const ac of acceptance) {
      if (ac.type === "manual") {
        continue;
      }
      results.push(runOne(ac, checkoutDir, evidenceBaseDir, env, timeoutMs));
    }
  } finally {
    rmSync(isolatedCwHome, { recursive: true, force: true });
  }

  const report: EvidenceReport = {
    exitCode: results.some((r) => r.status === "fail") ? 1 : 0,
    cases: results.map((r) => ({ id: r.id, name: titles.get(r.id) ?? "", status: r.status })),
    rawPath: join(evidenceBaseDir, REPORT_FILE_NAME),
  };
  const reportRaw = Buffer.from(`${JSON.stringify(report, null, REPORT_INDENT)}\n`, "utf-8");
  writeFileSync(report.rawPath, reportRaw);
  return { results, report, reportRaw };
}

/** 执行单条非 manual 验收：exit 0 = pass；非零 / 超时 / 不可执行 / 缺 command = fail。 */
function runOne(
  ac: AcceptanceItem,
  checkoutDir: string,
  evidenceBaseDir: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): AcceptanceRunResult {
  const stem = fileStem(ac.id);
  const stdoutPath = join(evidenceBaseDir, `${stem}.stdout`);
  const stderrPath = join(evidenceBaseDir, `${stem}.stderr`);

  const command = ac.command?.trim() ?? "";
  if (command === "") {
    const reason = `验收 ${ac.id} 缺 command`;
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, `${reason}\n`);
    return { id: ac.id, status: "fail", stdoutPath, stderrPath, timeout: false, reason };
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
    };
  }
  if (res.error !== undefined) {
    const reason = `无法执行 bash -c：${res.error.message}`;
    writeFileSync(stderrPath, `${reason}\n`);
    return { id: ac.id, status: "fail", stdoutPath, stderrPath, timeout: false, reason };
  }

  writeFileSync(stderrPath, res.stderr ?? "");
  if (res.status === 0) {
    return { id: ac.id, status: "pass", stdoutPath, stderrPath, timeout: false };
  }
  const signal = res.signal === null ? "" : ` signal ${res.signal}`;
  return {
    id: ac.id,
    status: "fail",
    stdoutPath,
    stderrPath,
    timeout: false,
    reason: `exit ${res.status ?? "null"}${signal === "" ? "" : `（${signal.trim()}）`}`,
  };
}

/**
 * 验收 id → 产物文件名安全形式：白名单外字符替换为 `_`（id 是 spec 作者输入，
 * 含 `/` 等路径字符时会逃逸 evidence 目录）。M0 下不同 id 碰撞为同一文件名的
 * 情形由 spec 唯一性约束（unit 内 id 唯一）+ review 把关，不额外编码。
 */
function fileStem(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

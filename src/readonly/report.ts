/**
 * `cw report [--unit <id>]`：每 unit 证据链汇总（人可读，无 --json——规格锁定仅
 * status / frontier 提供 --json）。
 *
 * 覆盖标记语义（验收文档 u1b「单测验收 4」）：验收 id 出现在任一 result=pass 的
 * VerifyRan.acceptanceIds 中 → ✓，否则 ✗。与 deriveStatus 的 verified 判定同向
 * （verified 要求最后一条 pass run 覆盖全部；此处逐条展示历史覆盖事实）。
 */
import type { CommandContext } from "../dispatch.js";
import type { SequencedProjection, SequencedUnitProjection } from "../events/types.js";
import {
  EMPTY_LEDGER_HINT,
  loadLedger,
  parseUnitArg,
  unitArgUsageError,
  unitNotFoundError,
  unitStatus,
} from "./load.js";

/** hash 展示前缀长度（规格锁定：spec/文件 sha256 均展示前 12 位） */
const HASH_PREFIX_LEN = 12;

function hashPrefix(hash: string): string {
  return hash.slice(0, HASH_PREFIX_LEN);
}

/** 该验收 id 是否被任一 pass 的 verify run 覆盖 */
function isCovered(unit: SequencedUnitProjection, acceptanceId: string): boolean {
  return unit.verifyRuns.some(
    (run) => run.result === "pass" && run.acceptanceIds.includes(acceptanceId),
  );
}

/** 单 unit 证据链视图（纯函数） */
export function renderReportUnit(unit: SequencedUnitProjection): string {
  const lines: string[] = [`unit: ${unit.unitId} (${unitStatus(unit)})`];

  const spec = unit.specs.length > 0 ? unit.specs[unit.specs.length - 1] : undefined;
  lines.push(spec === undefined ? "  spec: (未提交)" : `  spec: ${hashPrefix(spec.specHash)}`);
  lines.push("  acceptance:");
  if (spec === undefined || spec.acceptance.length === 0) {
    lines.push("    (无)");
  } else {
    for (const ac of spec.acceptance) {
      const core = ac.core ? " [core]" : "";
      lines.push(`    ${ac.id} ${ac.type}${core} ${isCovered(unit, ac.id) ? "✓" : "✗"}`);
    }
  }

  lines.push("  evidences:");
  if (unit.evidences.length === 0) {
    lines.push("    (无)");
  } else {
    for (const ev of unit.evidences) {
      lines.push(`    runId=${ev.runId} commit=${ev.commit}`);
      // paths 与 sha256 一一对应（types.ts 契约）；sha 缺失时以 ? 标记保持行对齐可诊断
      for (const [i, path] of ev.paths.entries()) {
        const sha = ev.sha256[i] ?? "?";
        lines.push(`      ${path} sha256=${hashPrefix(sha)}`);
      }
    }
  }

  lines.push("  verifyRuns:");
  if (unit.verifyRuns.length === 0) {
    lines.push("    (无)");
  } else {
    for (const run of unit.verifyRuns) {
      const ids = run.acceptanceIds.length > 0 ? run.acceptanceIds.join(",") : "-";
      lines.push(`    runId=${run.runId} result=${run.result} acceptance=${ids}`);
    }
  }

  return lines.join("\n");
}

/** 全账本报告（纯函数）：unit 之间空行分隔 */
export function renderReport(projection: SequencedProjection): string {
  const blocks = [...projection.units.values()].map((unit) => renderReportUnit(unit));
  return `${blocks.join("\n\n")}\n`;
}

export async function reportHandler(ctx: CommandContext): Promise<number> {
  const unitArg = parseUnitArg(ctx.argv.unit);
  if (unitArg.kind === "invalid") {
    process.stderr.write(unitArgUsageError("report"));
    return 1;
  }

  const { projection, empty } = loadLedger(ctx.cwd);

  if (unitArg.kind === "ok") {
    const unit = projection.units.get(unitArg.unitId);
    if (unit === undefined) {
      process.stderr.write(unitNotFoundError("report", unitArg.unitId));
      return 1;
    }
    process.stdout.write(`${renderReportUnit(unit)}\n`);
    return 0;
  }

  if (empty) {
    process.stdout.write(EMPTY_LEDGER_HINT);
    return 0;
  }
  process.stdout.write(renderReport(projection));
  return 0;
}

/**
 * `cw status [--unit <id>] [--json]`：fold 投影的状态视图。
 *
 * 无 --unit：每 unit 一行 `<unitId>  <status>  specs:<n> evidences:<n> lastVerify:<pass|fail|->`。
 * --unit：单 unit 详情（briefRef / 各 spec hash 前 12 位 / verdicts / evidences / verifyRuns）。
 * --json：投影结构化输出（字段名与 types.ts 一致；Map → 数组，见 note 字段）。
 *
 * 渲染函数为纯函数（输入投影返回字符串），命令 handler 只做「装载 → 渲染 → 写流」
 * 胶水——内容断言测纯函数，exit code 断言走 dispatch，stdout 断言走 e2e 子进程。
 */
import type { CommandContext } from "../dispatch.js";
import type { SequencedProjection, SequencedUnitProjection, UnitStatus } from "../events/types.js";
import {
  EMPTY_LEDGER_HINT,
  loadLedger,
  parseUnitArg,
  treeStatuses,
  unitArgUsageError,
  unitNotFoundError,
} from "./load.js";

/** hash 展示前缀长度（规格锁定：spec/文件 sha256 均展示前 12 位） */
const HASH_PREFIX_LEN = 12;

/** --json 缩进宽度（2 空格） */
const JSON_INDENT = 2;

/** Map → 数组投影的形状说明（--json 输出自包含注明） */
const MAP_SHAPE_NOTE =
  "units 为 Map<string, SequencedUnitProjection> 的数组投影（键即 unitId，已内嵌为字段）；" +
  "status 为树感知派生字段（deriveStatuses + checkSpecRules，closed 含「全部直接子节点 " +
  "closed」条件），非事件流原始数据";

function hashPrefix(hash: string): string {
  return hash.slice(0, HASH_PREFIX_LEN);
}

function lastVerifyOf(unit: SequencedUnitProjection): string {
  return unit.verifyRuns.length > 0 ? unit.verifyRuns[unit.verifyRuns.length - 1].result : "-";
}

/** 列表视图（纯函数）：每 unit 一行；status 为树感知口径（closed 含子条件） */
export function renderStatusList(projection: SequencedProjection): string {
  const statuses = treeStatuses(projection);
  const lines = [...projection.units.values()].map(
    (unit) =>
      `${unit.unitId}  ${statuses.get(unit.unitId)}  ` +
      `specs:${unit.specs.length} evidences:${unit.evidences.length} lastVerify:${lastVerifyOf(unit)}`,
  );
  return `${lines.join("\n")}\n`;
}

/** 详情视图（纯函数）：briefRef、全部 spec hash、verdicts、evidences、verifyRuns */
export function renderStatusDetail(
  unit: SequencedUnitProjection,
  status: UnitStatus,
): string {
  const lines: string[] = [
    `unit: ${unit.unitId}`,
    `status: ${status}`,
    `briefRef: ${unit.briefRef}`,
  ];

  lines.push("specs:");
  if (unit.specs.length === 0) {
    lines.push("  (无)");
  } else {
    for (const spec of unit.specs) {
      lines.push(
        `  - ${hashPrefix(spec.specHash)} acceptance=${spec.acceptance.length}` +
          ` contracts=${spec.contracts.length} split=${spec.split.length}`,
      );
    }
  }

  lines.push("verdicts:");
  if (unit.verdicts.length === 0) {
    lines.push("  (无)");
  } else {
    for (const v of unit.verdicts) {
      lines.push(`  - ${v.verdictKind} ${v.verdict}${v.comment === undefined ? "" : ` — ${v.comment}`}`);
    }
  }

  lines.push("evidences:");
  if (unit.evidences.length === 0) {
    lines.push("  (无)");
  } else {
    for (const ev of unit.evidences) {
      lines.push(`  - runId=${ev.runId} commit=${ev.commit}`);
    }
  }

  lines.push("verifyRuns:");
  if (unit.verifyRuns.length === 0) {
    lines.push("  (无)");
  } else {
    for (const run of unit.verifyRuns) {
      const ids = run.acceptanceIds.length > 0 ? run.acceptanceIds.join(",") : "-";
      lines.push(`  - runId=${run.runId} result=${run.result} acceptance=${ids}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** 单 unit 的结构化输出（--unit --json）；status 为树感知口径 */
export function unitJson(unit: SequencedUnitProjection, status: UnitStatus): string {
  return `${JSON.stringify({ ...unit, status }, null, JSON_INDENT)}\n`;
}

/** 全账本投影的结构化输出（--json）：Map → 数组，note 字段注明形状 */
export function statusJson(projection: SequencedProjection): string {
  const statuses = treeStatuses(projection);
  const units = [...projection.units.values()].map((unit) => ({
    ...unit,
    status: statuses.get(unit.unitId),
  }));
  return `${JSON.stringify({ units, totalEvents: projection.totalEvents, note: MAP_SHAPE_NOTE }, null, JSON_INDENT)}\n`;
}

export async function statusHandler(ctx: CommandContext): Promise<number> {
  const wantJson = ctx.argv.json === true;
  const unitArg = parseUnitArg(ctx.argv.unit);
  if (unitArg.kind === "invalid") {
    process.stderr.write(unitArgUsageError("status"));
    return 1;
  }

  const { projection, empty } = loadLedger(ctx.cwd);

  if (unitArg.kind === "ok") {
    const unit = projection.units.get(unitArg.unitId);
    if (unit === undefined) {
      process.stderr.write(unitNotFoundError("status", unitArg.unitId));
      return 1;
    }
    const status = treeStatuses(projection).get(unitArg.unitId);
    if (status === undefined) {
      throw new Error(`status: unit "${unitArg.unitId}" 不在树感知状态集合中（不可达）`);
    }
    process.stdout.write(wantJson ? unitJson(unit, status) : renderStatusDetail(unit, status));
    return 0;
  }

  if (empty) {
    // --json 空账本输出结构化空形态（units: []），与非空 --json 同 schema——机器
    // 消费方无需为空账本单独处理纯文本分支（对齐 frontier --json 的空形态行为）
    if (wantJson) {
      process.stdout.write(statusJson(projection));
    } else {
      process.stdout.write(EMPTY_LEDGER_HINT);
    }
    return 0;
  }
  process.stdout.write(wantJson ? statusJson(projection) : renderStatusList(projection));
  return 0;
}

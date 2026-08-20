/**
 * `cw report [--unit <id>] [--root <id>]`：每 unit 证据链汇总（人可读，无 --json
 * ——规格锁定仅 status / frontier 提供 --json）。
 *
 * 选择器：--unit 单 unit 详情；--root 以该 unit 为根的子树汇总（先根后子、同层按
 * 账本序，canon《report 命令》的子树视图）；两者互斥；均未提供 = 全账本。
 * 验收行含可复跑命令（acceptance.command 存在时展示——人可读模式下证据链的可
 * 复跑入口；--json 消费方走 status --json，其 specs.acceptance 已含 command 字段）。
 *
 * 覆盖标记语义（验收文档 u1b「单测验收 4」）：验收 id 出现在任一 result=pass 的
 * VerifyRan.acceptanceIds 中 → ✓，否则 ✗。与 deriveStatus 的 verified 判定同向
 * （verified 要求最后一条 pass run 覆盖全部；此处逐条展示历史覆盖事实）。
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

function hashPrefix(hash: string): string {
  return hash.slice(0, HASH_PREFIX_LEN);
}

/** 该验收 id 是否被任一 pass 的 verify run 覆盖 */
function isCovered(unit: SequencedUnitProjection, acceptanceId: string): boolean {
  return unit.verifyRuns.some(
    (run) => run.result === "pass" && run.acceptanceIds.includes(acceptanceId),
  );
}

/** 单 unit 证据链视图（纯函数）；status 为树感知口径（closed 含子条件） */
export function renderReportUnit(unit: SequencedUnitProjection, status: UnitStatus): string {
  const lines: string[] = [`unit: ${unit.unitId} (${status})`];

  const spec = unit.specs.length > 0 ? unit.specs[unit.specs.length - 1] : undefined;
  lines.push(spec === undefined ? "  spec: (未提交)" : `  spec: ${hashPrefix(spec.specHash)}`);
  lines.push("  acceptance:");
  if (spec === undefined || spec.acceptance.length === 0) {
    lines.push("    (无)");
  } else {
    for (const ac of spec.acceptance) {
      const core = ac.core ? " [core]" : "";
      // 可复跑命令：command 为可选字段（e2e-real / e2e-mock 必填，unit / manual 无）
      const command = ac.command === undefined ? "" : ` ${ac.command}`;
      lines.push(`    ${ac.id} ${ac.type}${core} ${isCovered(unit, ac.id) ? "✓" : "✗"}${command}`);
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

/** 全账本报告（纯函数）：unit 之间空行分隔；状态为树感知口径 */
export function renderReport(projection: SequencedProjection): string {
  const statuses = treeStatuses(projection);
  const blocks = [...projection.units.values()].map((unit) =>
    renderReportUnit(unit, statusOf(statuses, unit.unitId)),
  );
  return `${blocks.join("\n\n")}\n`;
}

/** 从树感知状态集合取单 unit 状态；缺失 = 投影与状态集不一致（不可达，抛错不静默） */
function statusOf(statuses: ReadonlyMap<string, UnitStatus>, unitId: string): UnitStatus {
  const status = statuses.get(unitId);
  if (status === undefined) {
    throw new Error(`report: unit "${unitId}" 不在树感知状态集合中（不可达）`);
  }
  return status;
}

/** parentId → 直接子 unit（保持账本顺序；--root 子树遍历的索引） */
function childrenOf(projection: SequencedProjection): Map<string, SequencedUnitProjection[]> {
  const children = new Map<string, SequencedUnitProjection[]>();
  for (const unit of projection.units.values()) {
    if (unit.parentId === null) {
      continue;
    }
    const siblings = children.get(unit.parentId) ?? [];
    siblings.push(unit);
    children.set(unit.parentId, siblings);
  }
  return children;
}

/**
 * 子树报告（纯函数）：以 rootId 为根，先根后子、同层按账本序遍历，逐节点输出
 * 证据链块（块间空行分隔，与全账本报告同格式）；状态为树感知口径。rootId 不在
 * 投影中 → undefined（由 handler 转 exit 1 + 可操作错误）。
 */
export function renderReportSubtree(
  projection: SequencedProjection,
  rootId: string,
): string | undefined {
  const root = projection.units.get(rootId);
  if (root === undefined) {
    return undefined;
  }
  const statuses = treeStatuses(projection);
  const children = childrenOf(projection);
  const blocks: string[] = [];
  const walk = (unit: SequencedUnitProjection): void => {
    blocks.push(renderReportUnit(unit, statusOf(statuses, unit.unitId)));
    for (const child of children.get(unit.unitId) ?? []) {
      walk(child);
    }
  };
  walk(root);
  return `${blocks.join("\n\n")}\n`;
}

/** --root 参数非法时的可操作错误（对齐 load.ts 的 --unit 错误风格） */
function rootArgUsageError(): string {
  return (
    "report: --root 需要一个 unitId 参数（如 cw report --root u1）。" +
    "恢复动作：补上 unitId，或去掉 --root 查看全部 unit。\n"
  );
}

/** --unit 与 --root 同时提供时的可操作错误（单一选择器原则） */
function mixedSelectorError(): string {
  return (
    "report: --unit 与 --root 互斥，只能提供一个。" +
    "恢复动作：单 unit 详情用 --unit <id>，子树汇总用 --root <id>。\n"
  );
}

export async function reportHandler(ctx: CommandContext): Promise<number> {
  // 选择器解析：--unit 与 --root 同规则（未提供 / 合法非空串 / 非法），互斥
  const unitArg = parseUnitArg(ctx.argv.unit);
  const rootArg = parseUnitArg(ctx.argv.root);
  if (unitArg.kind === "invalid" || rootArg.kind === "invalid") {
    process.stderr.write(
      unitArg.kind === "invalid" ? unitArgUsageError("report") : rootArgUsageError(),
    );
    return 1;
  }
  if (unitArg.kind === "ok" && rootArg.kind === "ok") {
    process.stderr.write(mixedSelectorError());
    return 1;
  }

  const { projection, empty } = loadLedger(ctx.cwd);

  if (unitArg.kind === "ok") {
    const unit = projection.units.get(unitArg.unitId);
    if (unit === undefined) {
      process.stderr.write(unitNotFoundError("report", unitArg.unitId));
      return 1;
    }
    process.stdout.write(
      `${renderReportUnit(unit, statusOf(treeStatuses(projection), unit.unitId))}\n`,
    );
    return 0;
  }

  if (rootArg.kind === "ok") {
    const subtree = renderReportSubtree(projection, rootArg.unitId);
    if (subtree === undefined) {
      process.stderr.write(unitNotFoundError("report", rootArg.unitId));
      return 1;
    }
    process.stdout.write(subtree);
    return 0;
  }

  if (empty) {
    process.stdout.write(EMPTY_LEDGER_HINT);
    return 0;
  }
  process.stdout.write(renderReport(projection));
  return 0;
}

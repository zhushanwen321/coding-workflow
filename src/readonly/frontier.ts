/**
 * `cw frontier [--json]`：就绪集合视图。
 *
 * frontier 语义 = 对投影算两组（验收文档 u1b 锁定）：
 *   - specReady：状态 created 的 unit（待 spec 提交/审查）
 *   - buildReady：状态 spec-frozen 的 unit（待构建证据）
 * verified / closed 的 unit 不在任何组（已越过本 frontier 推进点）。
 * 状态派生经 load.ts 的注入点使用真实 checkSpecRules（弱 spec 停在 created）。
 */
import type { CommandContext } from "../dispatch.js";
import type { SequencedProjection } from "../events/types.js";
import { EMPTY_LEDGER_HINT, loadLedger, treeStatuses } from "./load.js";

export interface FrontierGroups {
  specReady: string[];
  buildReady: string[];
}

/** 就绪集合计算（纯函数）：created → specReady，spec-frozen → buildReady（树感知口径） */
export function computeFrontier(projection: SequencedProjection): FrontierGroups {
  const groups: FrontierGroups = { specReady: [], buildReady: [] };
  const statuses = treeStatuses(projection);
  for (const unit of projection.units.values()) {
    const status = statuses.get(unit.unitId);
    if (status === "created") {
      groups.specReady.push(unit.unitId);
    } else if (status === "spec-frozen") {
      groups.buildReady.push(unit.unitId);
    }
  }
  return groups;
}

/** 分组文本视图（纯函数）：空组显示 (无) 保持分组标题恒在 */
export function renderFrontier(groups: FrontierGroups): string {
  const groupLines = (ids: readonly string[]): string =>
    ids.length === 0 ? "  (无)" : ids.map((id) => `  ${id}`).join("\n");
  return `specReady:\n${groupLines(groups.specReady)}\nbuildReady:\n${groupLines(groups.buildReady)}\n`;
}

/** --json 缩进宽度（2 空格，与文本视图缩进一致） */
const JSON_INDENT = 2;

export async function frontierHandler(ctx: CommandContext): Promise<number> {
  const { projection, empty } = loadLedger(ctx.cwd);
  const groups = computeFrontier(projection);

  if (ctx.argv.json === true) {
    process.stdout.write(`${JSON.stringify(groups, null, JSON_INDENT)}\n`);
    return 0;
  }
  if (empty) {
    process.stdout.write(EMPTY_LEDGER_HINT);
    return 0;
  }
  process.stdout.write(renderFrontier(groups));
  return 0;
}

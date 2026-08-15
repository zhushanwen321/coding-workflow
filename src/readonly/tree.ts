/**
 * `cw tree`：按 parentId 缩进渲染分解树，每节点 `<unitId> (<status>)`。
 *
 * 孤儿 unit（parentId 指向不存在的 unit）以根层级展示并标 `!?`——账本 append 侧
 * 不校验 parentId 存在性（分解树可先建叶后建根），孤儿是合法账本状态而非损坏。
 * 同层顺序 = 账本内 UnitCreated 顺序（Map 迭代序），渲染确定性可 replay。
 */
import type { CommandContext } from "../dispatch.js";
import type { SequencedProjection, SequencedUnitProjection } from "../events/types.js";
import { EMPTY_LEDGER_HINT, loadLedger, unitStatus } from "./load.js";

/** 每层级进深度（2 空格） */
const INDENT_UNIT = "  ";

/** 孤儿标记：parentId 指向不存在的 unit */
const ORPHAN_MARK = "!?";

/** 树视图（纯函数）：根层 = parentId 为 null 或指向不存在 unit 的节点 */
export function renderTree(projection: SequencedProjection): string {
  // parentId → 直接子 unit（保持账本顺序）
  const children = new Map<string, SequencedUnitProjection[]>();
  const roots: { unit: SequencedUnitProjection; orphan: boolean }[] = [];
  for (const unit of projection.units.values()) {
    const parent =
      unit.parentId === null ? undefined : projection.units.get(unit.parentId);
    if (unit.parentId === null || parent === undefined) {
      roots.push({ unit, orphan: unit.parentId !== null });
      continue;
    }
    const siblings = children.get(parent.unitId) ?? [];
    siblings.push(unit);
    children.set(parent.unitId, siblings);
  }

  const lines: string[] = [];
  const walk = (unit: SequencedUnitProjection, depth: number, orphan: boolean): void => {
    const marker = orphan ? ` ${ORPHAN_MARK}` : "";
    lines.push(`${INDENT_UNIT.repeat(depth)}${unit.unitId} (${unitStatus(unit)})${marker}`);
    for (const child of children.get(unit.unitId) ?? []) {
      walk(child, depth + 1, false);
    }
  };
  for (const root of roots) {
    walk(root.unit, 0, root.orphan);
  }
  return `${lines.join("\n")}\n`;
}

export async function treeHandler(ctx: CommandContext): Promise<number> {
  const { projection, empty } = loadLedger(ctx.cwd);
  if (empty) {
    process.stdout.write(EMPTY_LEDGER_HINT);
    return 0;
  }
  process.stdout.write(renderTree(projection));
  return 0;
}

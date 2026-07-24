/**
 * 只读查询的渲染函数（纯函数，不读文件系统）。
 *
 * 三个渲染函数供 cli.ts 的 readonly 分支调用：
 *   - renderTree  — 以某 unit 为根的子树（递归 findChildren，文本缩进）
 *   - renderStatus — 单 unit 的完整 JSON 快照
 *   - renderList  — 全部 unit 的表格输出（可按 layer 过滤）
 *
 * 设计要点：
 *   - 只接收 V1Store / WorkUnitRecord 数据 + 参数，不触碰文件系统、不写 store。
 *   - WorkUnitRecord 是 store 层的宽松类型（[key: string]: unknown），
 *     objective / status 字段需类型收窄为 string（store 不裁剪 core 字段，
 *     但渲染层只关心可读字符串，未知字段降级为空串）。
 */
import type { WorkUnitRecord } from "../store/schema.js";
import type { V1Store } from "../store/v1-store.js";

// ── 辅助：从宽松的 WorkUnitRecord 安全取字符串字段 ───────────

/** 从 WorkUnitRecord 取 string 字段，非 string 时降级为 fallback（默认空串）。 */
function getStringField(
  unit: WorkUnitRecord,
  field: string,
  fallback = "",
): string {
  const v = unit[field];
  return typeof v === "string" ? v : fallback;
}

/** 截断到 maxLength，超出加省略号（总长保持 ≤ maxLength）。 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}

// ── 渲染函数 ─────────────────────────────────────────────────

/** 树节点单行的最大 objective 截断长度。 */
const TREE_OBJECTIVE_MAX = 60;

/** JSON 序列化缩进空格数（renderStatus 用）。 */
const JSON_INDENT = 2;

/**
 * renderTree — 以 rootUnitId 为根的子树文本视图。
 *
 * 递归 store.findChildren 构建缩进树，每层缩进 2 空格。
 * 行格式：`<unitId> [<status>] <objective 截断到 60 字>`。
 *
 * 根不存在（load 返回 null）时返回 `(unit not found: <id>)`。
 *
 * @param rootUnitId  根 unit 的 id
 * @param store       V1Store（只调 load / findChildren 读方法）
 */
export function renderTree(rootUnitId: string, store: V1Store): string {
  const root = store.load(rootUnitId);
  if (root === null) {
    return `(unit not found: ${rootUnitId})\n`;
  }

  const lines: string[] = [];
  renderTreeNode(root, 0, store, lines);
  return lines.join("\n") + "\n";
}

/** 递归渲染单个节点 + 其子树（缩进 depth*2 空格）。 */
function renderTreeNode(
  unit: WorkUnitRecord,
  depth: number,
  store: V1Store,
  lines: string[],
): void {
  const indent = "  ".repeat(depth);
  const status = getStringField(unit, "status");
  const objective = truncate(
    getStringField(unit, "objective"),
    TREE_OBJECTIVE_MAX,
  );
  lines.push(`${indent}${unit.id} [${status}] ${objective}`);

  const children = store.findChildren(unit.id);
  for (const child of children) {
    renderTreeNode(child, depth + 1, store, lines);
  }
}

/**
 * renderStatus — 单 unit 的完整 JSON 快照。
 *
 * 直接 JSON.stringify(unit, null, 2)，保留全部字段（core 层字段原样透传）。
 *
 * @param unit  已读出的 WorkUnitRecord（调用方负责 load + not found 判定）
 */
export function renderStatus(unit: WorkUnitRecord): string {
  return JSON.stringify(unit, null, JSON_INDENT) + "\n";
}

/**
 * renderList — 全部 unit 的表格输出。
 *
 * 列：unitId | layer | status | objective。
 * layer 给定时过滤 unit.scope === layer（大小写敏感，scope 本身是小写枚举）。
 *
 * @param units  全部 unit（通常来自 store.loadAll()）
 * @param layer  可选 layer 过滤（epic/feature/slice/wave）
 */
export function renderList(
  units: ReadonlyArray<WorkUnitRecord>,
  layer?: string,
): string {
  const filtered = layer
    ? units.filter((u) => u.scope === layer)
    : units;

  if (filtered.length === 0) {
    return layer
      ? `(no units in layer: ${layer})\n`
      : "(no units)\n";
  }

  // 列宽对齐：取每列最大宽度（与表头比较）。
  const rows = filtered.map((u) => ({
    unitId: u.id,
    layer: u.scope,
    status: getStringField(u, "status"),
    objective: getStringField(u, "objective"),
  }));

  const colWidths = {
    unitId: Math.max("unitId".length, ...rows.map((r) => r.unitId.length)),
    layer: Math.max("layer".length, ...rows.map((r) => r.layer.length)),
    status: Math.max("status".length, ...rows.map((r) => r.status.length)),
  };

  const header =
    pad("unitId", colWidths.unitId) + "  " +
    pad("layer", colWidths.layer) + "  " +
    pad("status", colWidths.status) + "  " +
    "objective";

  const separator =
    "-".repeat(colWidths.unitId) + "  " +
    "-".repeat(colWidths.layer) + "  " +
    "-".repeat(colWidths.status) + "  " +
    "----------";

  const body = rows
    .map((r) =>
      pad(r.unitId, colWidths.unitId) + "  " +
      pad(r.layer, colWidths.layer) + "  " +
      pad(r.status, colWidths.status) + "  " +
      r.objective,
    )
    .join("\n");

  return `${header}\n${separator}\n${body}\n`;
}

/** 右侧补齐到 width（超过不截断，表格列对齐用）。 */
function pad(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

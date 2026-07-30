/**
 * v1 handlers — rollupChildDelivery（child wave 状态变更后回写 parent slice 的 childDelivery）。
 *
 * 设计来源：model §5.11.1（ChildDeliveryRecord + rollup）、core evidence.PlanningEvidence。
 *
 * 职责：child wave（或任意子层 unit）进入终态（closed/aborted）后，找到其 parent，
 * 若 parent 是 PlanningUnit（epic/feature/slice，有 childDelivery），更新对应 record：
 *   - child → closed：record.childStatus='closed' + record.childEvidenceSummary = child.evidence.summary
 *   - child → aborted：record.childStatus='aborted'
 *   - child 中间态：不更新 record.childStatus（保持 pending）
 * 若 parent 已冻结（evidence.frozenAt 非空），跳过（D2 一致性：冻结后不可改）。
 *
 * 接入点（W5）：wave closeout / abort handler 尾部调本函数，把变更 rollup 到 parent slice。
 *
 * 避免 any 的方式：WorkUnitRecord 是 `[key: string]: unknown`，evidence / childDelivery / frozenAt /
 * summary 都以 unknown 透传。本模块定义 readPlanningEvidence 类型守卫辅助，从 unknown 安全收窄到
 * 结构化读取视图，所有字段访问都经类型守卫，不用 `as any`。
 */
import type { ChildDeliveryRecord } from "../core/evidence.js";
import type { WorkUnitRecord } from "../store/schema.js";
import type { CwDeps } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// 安全读取辅助（从 WorkUnitRecord 的 unknown 字段收窄，避免 any）
// ═══════════════════════════════════════════════════════════════

/** PlanningUnit 的 evidence 读取视图（只取 rollup 需要的字段）。 */
interface PlanningEvidenceReadView {
  childDelivery: ChildDeliveryRecord[];
  frozenAt?: string;
}

/**
 * 从 WorkUnitRecord 安全读 PlanningEvidence（{childDelivery, frozenAt}）。
 *
 * 规则：
 * - record.scope 必须是 PlanningUnit（epic/feature/slice）才返回视图；否则返回 null（wave 无 childDelivery）
 * - evidence 字段必须是对象，childDelivery 必须是数组，才返回视图
 * - frozenAt 可选（未冻结为 undefined）
 *
 * 任何字段形状不符 → 返回 null（rollup 静默跳过，不抛错——rollup 是辅助同步，不应阻断主流程）。
 */
function readPlanningEvidence(record: WorkUnitRecord): PlanningEvidenceReadView | null {
  if (!isPlanningScope(record.scope)) return null;

  const evidence = record.evidence;
  if (evidence === null || typeof evidence !== "object") return null;

  const childDelivery = getArrayField(evidence, "childDelivery");
  if (childDelivery === undefined) return null;

  const frozenAt = getStringField(evidence, "frozenAt");

  return { childDelivery: childDelivery as ChildDeliveryRecord[], frozenAt };
}

/** 判定 scope 是否为 PlanningUnit（epic/feature/slice，有 childDelivery）。 */
function isPlanningScope(scope: unknown): boolean {
  return scope === "epic" || scope === "feature" || scope === "slice";
}

/**
 * 从 child WorkUnitRecord 安全读 evidence.summary（closed 时 rollup 用）。
 *
 * child 是 ExecutionUnit（wave）或 PlanningUnit，evidence 形态不同，但都有 summary?: string。
 */
function readChildEvidenceSummary(record: WorkUnitRecord): string | undefined {
  const evidence = record.evidence;
  if (evidence === null || typeof evidence !== "object") return undefined;
  return getStringField(evidence, "summary");
}

/**
 * 从对象安全读字符串字段（返回 string 或 undefined）。规避 `as { x?: unknown }` 全可选断言。
 */
function getStringField(obj: object, key: string): string | undefined {
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * 从对象安全读数组字段（返回 unknown[] 或 undefined）。规避 `as { x?: unknown }` 全可选断言。
 */
function getArrayField(obj: object, key: string): unknown[] | undefined {
  const v = (obj as Record<string, unknown>)[key];
  return Array.isArray(v) ? v : undefined;
}

// ═══════════════════════════════════════════════════════════════
// rollupChildDelivery（主入口）
// ═══════════════════════════════════════════════════════════════

/**
 * child unit 状态变更后，回写 parent PlanningUnit 的 childDelivery 对应 record。
 *
 * 逻辑：
 * 1. load(childUnitId)，无 parentUnitId 或 load 不到 → return（无操作）
 * 2. load(parentUnitId)，parent 非 PlanningUnit 或 evidence 形状不符 → return
 * 3. parent.evidence.frozenAt 非空（已冻结）→ return（D2 一致性，不动）
 * 4. 找 childDelivery 里 childUnitId 匹配的 record，无 → return
 * 5. 按 child.status 更新 record：
 *    - 'closed'：record.childStatus='closed' + record.childEvidenceSummary = child.evidence.summary
 *    - 'aborted'：record.childStatus='aborted'
 *    - 其他（中间态）：不改 record.childStatus（保持 pending）
 * 6. save(parent)
 *
 * @param deps 依赖注入（store）
 * @param childUnitId 状态刚变更的 child unit id
 */
export function rollupChildDelivery(
  deps: CwDeps,
  childUnitId: string,
): void {
  const child = deps.store.load(childUnitId);
  if (child === null) return;

  const parentUnitId = child.parentUnitId;
  if (parentUnitId === undefined || parentUnitId === "") return;

  const parent = deps.store.load(parentUnitId);
  if (parent === null) return;

  const parentView = readPlanningEvidence(parent);
  if (parentView === null) return; // parent 非 PlanningUnit 或 evidence 形状不符

  // parent 已冻结 → 不动（D2 一致性）
  if (parentView.frozenAt !== undefined) return;

  const record = parentView.childDelivery.find((r) => r.childUnitId === childUnitId);
  if (record === undefined) return;

  const childStatus = typeof child.status === "string" ? child.status : "";
  if (childStatus === "closed") {
    record.childStatus = "closed";
    const summary = readChildEvidenceSummary(child);
    if (summary !== undefined) {
      record.childEvidenceSummary = summary;
    }
  } else if (childStatus === "aborted") {
    record.childStatus = "aborted";
  }
  // 非 closed/aborted（中间态）→ 不更新 record.childStatus（保持 pending）

  deps.store.save(parent);
}

/**
 * frontier 计算：以某 unit 为根，递归扫描子树，返回所有「可推进 / 被阻塞」的非终态节点。
 *
 * 与 renderStatus（原始 JSON dump）/ renderTree（文本缩进）的区别：
 * frontier 是聚合视图——只输出未完成的节点，并标注每个节点是否被阻塞及原因，
 * 供 agent 快速定位「下一步该碰哪个 unit」。
 *
 * status→action 映射表（WAVE_STATUS_TO_ACTION / PLANNING_STATUS_TO_ACTION /
 * TERMINAL_STATUSES）从 core/status.ts import——与 render.ts 共享单一定义源，
 * 消除此前两处重定义的手维护负担。
 */
import type { WorkUnitRecord } from "../store/schema.js";
import type { ChildDeliveryRecord } from "./evidence.js";
import { resolveChildDependsOn } from "./hierarchy.js";
import type { Split } from "./plan.js";
import {
  PLANNING_STATUS_TO_ACTION,
  TERMINAL_STATUSES,
  WAVE_STATUS_TO_ACTION,
} from "./status.js";

/** planning 层 scope 集合（epic/feature/slice 共用一套状态机）。 */
const PLANNING_SCOPES = new Set(["epic", "feature", "slice"]);

// ═══════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════

/** frontier 输出的单个节点（一个未完成的 unit + 其阻塞状态）。 */
export interface FrontierNode {
  unitId: string;
  scope: "epic" | "feature" | "slice" | "wave";
  status: string;
  /** 该 status 对应的下一步 action（终态本就不出现在 frontier，故通常非空）。 */
  nextAction: string | undefined;
  /** 是否被阻塞（子层未完成 / wave 依赖未完成）。 */
  blocked: boolean;
  /** 阻塞原因（blocked=true 时填）。 */
  blockedReason?: string;
  /** wave 层经父 slice 反查到的依赖 wave id 列表（planning 层为空）。 */
  dependsOn: string[];
  parentUnitId?: string;
  /** planning 层 execute 后创建的子 unit id（wave 层无此字段）。 */
  childUnitIds?: string[];
  /** statusHistory 最后一条的 action（如 "replan"/"design"/"execute"）。
   * 供递归调度器做 replan 后备检测——replan 是旁路（status 不变），frontier 的
   *  status→action 映射不反映"需回 plan"，调度器靠此字段识别 replan 发生。 */
  lastStatusHistoryAction?: string;
  /** wave 层 execute 后的 commit hash（planning 层无此字段）。 */
  commitHash?: string;
}

/** computeFrontier 的返回。 */
export interface FrontierResult {
  rootUnitId: string;
  nodes: FrontierNode[];
  /** nodes 中可推进（blocked === false）的节点数（#10，一次 reduce 累计）。 */
  advanceableCount: number;
  /** nodes 中被阻塞（blocked === true）的节点数（#10，一次 reduce 累计）。 */
  blockedCount: number;
}

/** frontier 需要的 store 接口（结构同 HandoffStore，避免 import readonly 层）。 */
export interface FrontierStore {
  load(id: string): WorkUnitRecord | null;
  findChildren(parentUnitId: string): WorkUnitRecord[];
}

// ═══════════════════════════════════════════════════════════════
// 辅助：从宽松的 WorkUnitRecord 安全取字段
// ═══════════════════════════════════════════════════════════════

/** 取 string 字段，非 string 时降级为 fallback。 */
function getStringField(
  unit: WorkUnitRecord,
  field: string,
  fallback = "",
): string {
  const v = unit[field];
  return typeof v === "string" ? v : fallback;
}

/** scope 字段收窄为联合类型（非预期值降级为 "wave"——仅用于类型，实际不会触发）。 */
function getScope(unit: WorkUnitRecord): "epic" | "feature" | "slice" | "wave" {
  const s = getStringField(unit, "scope");
  if (s === "epic" || s === "feature" || s === "slice" || s === "wave") {
    return s;
  }
  return "wave";
}

/** 从 unit 取一个字段并断言为 T（null/非 object 时返回 undefined）。
 *
 * 仅做 null/object 降级校验，不保证 T 结构完整——磁盘数据缺字段时下游需自行防御。
 * 设计目标是"安全降级不崩溃"，而非结构断言。与 render.ts readField 同模式。 */
function readField<T>(unit: WorkUnitRecord, field: string): T | undefined {
  const v = unit[field];
  return v !== null && typeof v === "object" ? (v as T) : undefined;
}

/** 断言值为数组，非数组返回空数组。与 render.ts asArray 同模式。 */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** 从宽松 record 安全读 split[]（plan.split）。 */
function getSplits(unit: WorkUnitRecord): Split[] {
  const plan = readField<{ split?: unknown }>(unit, "plan");
  return plan ? asArray<Split>(plan.split) : [];
}

/** 从宽松 record 安全读 childDelivery[]（evidence.childDelivery）。 */
function getChildDelivery(unit: WorkUnitRecord): ChildDeliveryRecord[] {
  const evidence = readField<{ childDelivery?: unknown }>(unit, "evidence");
  return evidence ? asArray<ChildDeliveryRecord>(evidence.childDelivery) : [];
}

/** 从宽松 record 安全读 evidence.commitHash（wave 层 execute 后写入，planning 层无）。 */
function getCommitHash(unit: WorkUnitRecord): string | undefined {
  const evidence = readField<{ commitHash?: unknown }>(unit, "evidence");
  if (!evidence) return undefined;
  return typeof evidence.commitHash === "string" ? evidence.commitHash : undefined;
}

/** 从宽松 record 安全读 executeResult.childUnitIds（planning 层有，wave 无）。 */
function getChildUnitIds(unit: WorkUnitRecord): string[] | undefined {
  const er = readField<{ childUnitIds?: unknown }>(unit, "executeResult");
  if (!er) return undefined;
  const ids = er.childUnitIds;
  return Array.isArray(ids) ? (ids as string[]) : undefined;
}

/** 从宽松 record 安全读 statusHistory 最后一条的 action。
 *
 * replan handler append action="replan"（status 不变的旁路），调度器靠此识别 replan 发生。
 * 空数组 / 非数组 / 缺 action 字段时返回 undefined。 */
function getLastStatusHistoryAction(unit: WorkUnitRecord): string | undefined {
  const history = readField<unknown>(unit, "statusHistory");
  if (!Array.isArray(history) || history.length === 0) return undefined;
  const last = history[history.length - 1] as Record<string, unknown> | null;
  if (last === null || typeof last !== "object") return undefined;
  const action = last.action;
  return typeof action === "string" ? action : undefined;
}

// ═══════════════════════════════════════════════════════════════
// computeFrontier — 两遍扫描
// ═══════════════════════════════════════════════════════════════

/**
 * 以 rootUnitId 为根递归扫描子树，返回所有非终态节点的 frontier 视图。
 *
 * 两遍扫描：
 *   - Pass 1：递归收集整棵树（collectSubtree），过滤终态，建 FrontierNode（blocked/dependsOn 待填）。
 *   - Pass 2：填 blocked + blockedReason + dependsOn：
 *       - 类型 A（planning 层 executing）：若子层有未终态节点 → blocked。
 *       - 类型 B（wave 层）：经父 slice 的 split.dependsOn + childDelivery 反查依赖 wave，
 *         若依赖 wave 有未终态 → blocked。
 *
 * @param rootUnitId  根 unit id（cli 层已校验存在）
 * @param store       load + findChildren（CwStore 满足此接口）
 * @returns frontier 结果；root 不存在时返回空 nodes（防御，cli 层已校验）
 */
export function computeFrontier(
  rootUnitId: string,
  store: FrontierStore,
): FrontierResult {
  const root = store.load(rootUnitId);
  if (root === null) {
    // 防御：cli 层已校验 not found，到不了这里。
    return { rootUnitId, nodes: [], advanceableCount: 0, blockedCount: 0 };
  }

  // Pass 1: 递归收集整棵树。
  const allRecords: WorkUnitRecord[] = [];
  collectSubtree(root, store, allRecords, new Set());

  // 过滤终态，算 nextAction，建 node（blocked/dependsOn 待 Pass 2 填）。
  const nonTerminal = allRecords.filter(
    (r) => !TERMINAL_STATUSES.has(getStringField(r, "status")),
  );
  const nodes: FrontierNode[] = nonTerminal.map((r) => {
    const scope = getScope(r);
    const status = getStringField(r, "status");
    const actionTable = PLANNING_SCOPES.has(scope)
      ? PLANNING_STATUS_TO_ACTION
      : WAVE_STATUS_TO_ACTION;
    return {
      unitId: getStringField(r, "id"),
      scope,
      status,
      nextAction: actionTable[status],
      blocked: false,
      dependsOn: [],
      parentUnitId: getStringField(r, "parentUnitId") || undefined,
      childUnitIds: getChildUnitIds(r),
      lastStatusHistoryAction: getLastStatusHistoryAction(r),
      commitHash: scope === "wave" ? getCommitHash(r) : undefined,
    };
  });

  // Pass 2: 算 blocked + dependsOn。
  for (const node of nodes) {
    // 类型 A: planning 层 executing 且子层有未终态 → blocked。
    if (PLANNING_SCOPES.has(node.scope) && node.status === "executing") {
      const children = store.findChildren(node.unitId);
      const nonTerminalChildren = children.filter(
        (c) => !TERMINAL_STATUSES.has(getStringField(c, "status")),
      );
      if (nonTerminalChildren.length > 0) {
        node.blocked = true;
        node.blockedReason = `子层有未终态节点: ${nonTerminalChildren
          .map((c) => getStringField(c, "id"))
          .join(", ")}`;
      }
    }

    // 类型 B: wave 层，经父 slice 反查 dependsOn。
    if (node.scope === "wave" && node.parentUnitId) {
      const parent = store.load(node.parentUnitId);
      if (parent !== null && getScope(parent) === "slice") {
        const splits = getSplits(parent);
        const childDelivery = getChildDelivery(parent);
        const childDeps = resolveChildDependsOn(splits, childDelivery);
        const myDep = childDeps.find((d) => d.childUnitId === node.unitId);
        if (myDep !== undefined && myDep.dependsOn.length > 0) {
          node.dependsOn = myDep.dependsOn;
          // 一次遍历同时得 blocked 判定（任一依赖 null 或非终态 → 未满足）和 report 数据
          // （未终态依赖 id 列表），避免 isDependencySatisfied（内部逐个 store.load）再
          // .map(store.load) 的双倍 IO（S2）。「依赖 load 不到（null）」按 isDependencySatisfied
          // 语义视为未满足（保守判定），但不列入 report（与原逻辑一致）。
          const loadedDeps = myDep.dependsOn.map((id) => store.load(id));
          const isSatisfied = loadedDeps.every(
            (r) =>
              r !== null && TERMINAL_STATUSES.has(getStringField(r, "status")),
          );
          if (!isSatisfied) {
            node.blocked = true;
            const nonTerminalDeps = loadedDeps.filter(
              (r): r is WorkUnitRecord =>
                r !== null && !TERMINAL_STATUSES.has(getStringField(r, "status")),
            );
            node.blockedReason = `依赖未完成: ${nonTerminalDeps
              .map((r) => getStringField(r, "id"))
              .join(", ")}`;
          }
        }
      }
    }
  }

  // 聚合计数（#10，AC-4.1）：在既有遍历后一次 reduce，无二次遍历。
  // 语义：blocked=false 的节点可推进（agent 可跑它的 nextAction），blocked=true 被阻塞。
  let advanceableCount = 0;
  let blockedCount = 0;
  for (const node of nodes) {
    if (node.blocked) {
      blockedCount++;
    } else {
      advanceableCount++;
    }
  }

  return { rootUnitId, nodes, advanceableCount, blockedCount };
}

/**
 * 递归收集 unit 及其整棵子树到 out（深度优先，前序）。
 *
 * 与 renderTree 同模式：靠 store.findChildren 遍历，不假设记录内部已含 children 指针。
 *
 * visited 防环：frontier 是排查异常 store 的只读命令，脏数据可能导致父子外键成环，
 * 无 visited 集合时递归不终止会栈溢出。visited 按 id 去重，遇已访问节点直接跳过。
 */
function collectSubtree(
  unit: WorkUnitRecord,
  store: FrontierStore,
  out: WorkUnitRecord[],
  visited: Set<string>,
): void {
  const id = getStringField(unit, "id");
  if (visited.has(id)) return; // 防环：脏数据可能导致父子外键成环
  visited.add(id);
  out.push(unit);
  for (const child of store.findChildren(id)) {
    collectSubtree(child, store, out, visited);
  }
}

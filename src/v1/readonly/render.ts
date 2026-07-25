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
import type { Clarification } from "../core/clarifications.js";
import type { Epic,ExecutionUnit, Feature, Slice } from "../core/workunit.js";
import { buildEpicNextAction } from "../handlers/epic/epic-internal.js";
import { buildFeatureNextAction } from "../handlers/feature/feature-internal.js";
import { buildNextAction } from "../handlers/internal.js";
import { buildSliceNextAction } from "../handlers/slice/slice-internal.js";
import type { PlanningAction,WaveAction } from "../rules/state-machine.js";
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

/** 截断到 maxLength，超出加省略号（总长保持 ≤ maxLength）。undefined/null 降级为空串。 */
function truncate(text: string | undefined | null, maxLength: number): string {
  const s = text ?? "";
  if (s.length <= maxLength) return s;
  return s.slice(0, maxLength - 1) + "…";
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

// ═══════════════════════════════════════════════════════════════
// renderHandoff — 单 unit 的交接摘要（供 agent 接手）
// ═══════════════════════════════════════════════════════════════

// 截断长度常量（handoff 各段用，避免魔数）
const HANDOFF_TRUNC = {
  RESOLUTION: 200,
  ALTERNATIVES: 200,
  DECISION: 120,
  COST: 80,
  ITEM: 120,
  MITIGATION: 80,
  NOTE: 100,
  FILE_DESC: 80,
  CONTRACT_DEF: 100,
  REASON: 80,
} as const;
// statusHistory 时间戳截取长度（ISO 8601 → "YYYY-MM-DD HH:MM:SS"）
const TIMESTAMP_SLICE_LEN = 19;

// ═══════════════════════════════════════════════════════════════
// renderHandoff — 单 unit 的交接摘要（供 agent 接手）
// ═══════════════════════════════════════════════════════════════

/** status → 接手 agent 下一步该执行的 action（同时是调 build{Scope}NextAction 的阶段 action）。
 *
 * 语义：status=created 意味着「create 完成，现在该跑 clarify」。终态(closed/aborted)为 undefined。
 *
 * 按 scope 拆两表：wave 和 planning 的状态机不同（planning 无 test/exec-review），
 * 且 executing 状态在两层的下一步不同（wave→test，planning→retrospect）。
 * 混用一表是原 bug 源头（曾把 wave 的 executing 错写成 execute、把两层的语义混在一起）。
 */

/** wave（ExecutionStatus）→ WaveAction。execute 完成后 status=executing，下一步是 test（不是 execute）。 */
const WAVE_STATUS_TO_ACTION: Readonly<Record<string, WaveAction | undefined>> = {
  created: "clarify",
  clarifying: "clarify",
  planning: "plan",
  "design-reviewed": "execute",
  executing: "test",
  tested: "exec-review",
  "exec-reviewed": "retrospect",
  retrospected: "closeout",
  closed: undefined,
  aborted: undefined,
};

/** planning（PlanningStatus，epic/feature/slice 共用）→ PlanningAction。
 * planning 无 test/exec-review：execute 下沉子层后 status=executing，下一步直接是 retrospect。 */
const PLANNING_STATUS_TO_ACTION: Readonly<Record<string, PlanningAction | undefined>> = {
  created: "clarify",
  clarifying: "clarify",
  planning: "plan",
  "design-reviewed": "execute",
  executing: "retrospect",
  retrospected: "closeout",
  closed: undefined,
  aborted: undefined,
};

/** 终态 status 集合（不输出「下一步」段）。 */
const TERMINAL_STATUSES = new Set(["closed", "aborted"]);

/**
 * renderHandoff — 以某 unit 为焦点的叙述性交接摘要。
 *
 * 与 renderStatus 的区别：renderStatus 是原始 JSON dump（程序化消费），
 * renderHandoff 是五段式 markdown 文本（agent/人读），聚合目标/已定决策/
 * 当前位置与下一步 guidance/涉及文件与契约/历史与变更。
 *
 * 下一步 guidance 复用各层的 build{Scope}NextAction（纯函数，验证过不碰 store/fs/stdin），
 * 保证 handoff 输出的 guidance 与实际跑 action 返回的 guidance 逐字一致。
 * wave 调 buildNextAction，planning 层调 buildSlice/Feature/EpicNextAction。
 *
 * 按 unit.scope 收窄到强类型（ExecutionUnit/Slice/Feature/Epic）后访问字段。
 * status→action 映射按 scope 拆两表（WAVE/PLANNING），反映两层状态机差异
 *（planning 无 test/exec-review，executing 下一步是 retrospect 而非 test）。
 *
 * @param unit  已读出的 WorkUnitRecord（调用方负责 load + not found 判定）
 */
export function renderHandoff(unit: WorkUnitRecord): string {
  const scope = unit.scope;
  const status = getStringField(unit, "status");
  const objective = getStringField(unit, "objective");
  const unitId = unit.id;

  const lines: string[] = [];
  lines.push(`# Handoff: ${unitId} [${status}]`);
  lines.push("");

  // ── §1 目标 ──
  lines.push("## 目标");
  lines.push(objective || "(无 objective)");
  lines.push("");

  // ── §2 已定决策（按 scope 收窄抽 clarifications + design-review 判定）──
  const decisions = renderDecisionsSection(unit);
  if (decisions.length > 0) {
    lines.push("## 已定决策");
    lines.push(...decisions);
    lines.push("");
  }

  // ── §3 当前位置与下一步 ──
  const nextStep = renderNextStepSection(unit, scope, status);
  lines.push(...nextStep);
  lines.push("");

  // ── §4 涉及文件与契约（按 scope 收窄）──
  const artifacts = renderArtifactsSection(unit, scope);
  if (artifacts.length > 0) {
    lines.push("## 涉及文件与契约");
    lines.push(...artifacts);
    lines.push("");
  }

  // ── §5 历史与变更 ──
  const history = renderHistorySection(unit);
  if (history.length > 0) {
    lines.push("## 历史与变更");
    lines.push(...history);
    lines.push("");
  }

  return lines.join("\n");
}

// ── §2 已定决策段 ──

/** 从 clarifications + designReviewJudgment 抽已定决策行（按 scope 收窄）。 */
function renderDecisionsSection(unit: WorkUnitRecord): string[] {
  const lines: string[] = [];
  const clarifications = readClarifications(unit);
  for (const c of clarifications) {
    if (c.resolution && c.resolution.trim() !== "") {
      lines.push(`- [clarify ${c.id}] ${c.question}`);
      lines.push(`  → ${truncate(c.resolution, HANDOFF_TRUNC.RESOLUTION)}`);
    }
  }

  // design-review 的 alternatives/tradeoffs/risks（各层共用 DesignReviewJudgment 结构）
  const judgment = readField<Record<string, unknown>>(unit, "designReviewJudgment");
  if (judgment) {
    const alt = asString(judgment.alternatives);
    if (alt) {
      lines.push(`- [review] 方案取舍：${truncate(alt, HANDOFF_TRUNC.ALTERNATIVES)}`);
    }
    const tradeoffs = asArray<Record<string, unknown>>(judgment.tradeoffs);
    for (const t of tradeoffs) {
      const decision = asString(t.decision);
      const cost = asString(t.cost);
      if (decision) {
        lines.push(`- [tradeoff ${asString(t.id) ?? "?"}] ${truncate(decision, HANDOFF_TRUNC.DECISION)}${cost ? `（代价：${truncate(cost, HANDOFF_TRUNC.COST)}）` : ""}`);
      }
    }
    const risks = asArray<Record<string, unknown>>(judgment.risks);
    for (const r of risks) {
      const item = asString(r.item);
      const mitigation = asString(r.mitigation);
      const severity = asString(r.severity);
      if (item) {
        lines.push(`- [risk ${asString(r.id) ?? "?"}${severity ? `/${severity}` : ""}] ${truncate(item, HANDOFF_TRUNC.ITEM)}${mitigation ? ` → 缓解：${truncate(mitigation, HANDOFF_TRUNC.MITIGATION)}` : ""}`);
      }
    }
  }

  return lines;
}
/** 运行时判定一个值是否像 Clarification（有 question 字段）。 */
function isClarificationLike(v: unknown): v is Clarification {
  if (typeof v !== "object" || v === null) return false;
  return typeof (v as Record<string, unknown>).question === "string";
}

/** 从 unit 读 clarifications（wave/slice/epic 是数组，feature 是容器对象）。 */
function readClarifications(unit: WorkUnitRecord): Clarification[] {
  const raw = unit.clarifications;
  // wave/slice/epic: Clarification[]
  if (Array.isArray(raw)) {
    return raw.filter(isClarificationLike);
  }
  // feature: FeatureClarification 容器对象 { clarifications: [], spec: {...} }
  if (raw && typeof raw === "object") {
    const inner = (raw as Record<string, unknown>).clarifications;
    if (Array.isArray(inner)) {
      return inner.filter(isClarificationLike);
    }
  }
  return [];
}

/** 把宽松的 WorkUnitRecord 视为具名 unit 类型（handoff 只读访问）。
 *
 * WorkUnitRecord 有 `[key:string]:unknown` 索引签名，具名 unit（ExecutionUnit/Slice/Feature/Epic）
 * 字段都是具体的；结构上后者是前者的超集，但 TS 认为索引签名与具名字段不兼容，需双重断言。
 * 集中到此处，避免调用点重复 `as unknown as T`（品味 + 消除多处 lint warning）。 */
function asUnit<T>(unit: WorkUnitRecord): T {
  return unit as unknown as T;
}

/** 按 scope 调对应的 build{Scope}NextAction 取阶段 guidance。
 *
 * 四个函数签名同构（均返回 V1NextAction），但 action 类型不同（WaveAction vs PlanningAction）、
 * unit 类型不同（ExecutionUnit vs Slice/Feature/Epic）。WorkUnitRecord 与具名 unit 类型结构上
 * 后者是前者的超集；handoff 只读访问，断言安全（字段缺失时 build 内部 helper 降级，不 crash）。
 * 返回 undefined 表示该 scope 未配置 build 函数或调用抛出。 */
function buildGuidanceForScope(
  unit: WorkUnitRecord,
  scope: string,
  status: string,
): { action: string; guidance: string } | undefined {
  const action = (scope === "wave" ? WAVE_STATUS_TO_ACTION : PLANNING_STATUS_TO_ACTION)[status];
  if (!action) return undefined;
  try {
    let next: { guidance: string };
    if (scope === "wave") {
      next = buildNextAction(asUnit<ExecutionUnit>(unit), action as WaveAction);
    } else if (scope === "slice") {
      next = buildSliceNextAction(asUnit<Slice>(unit), action as PlanningAction);
    } else if (scope === "feature") {
      next = buildFeatureNextAction(asUnit<Feature>(unit), action as PlanningAction);
    } else if (scope === "epic") {
      next = buildEpicNextAction(asUnit<Epic>(unit), action as PlanningAction);
    } else {
      return undefined;
    }
    return { action, guidance: next.guidance };
  } catch {
    return { action, guidance: "" };
  }
}

// ── §3 当前位置与下一步段 ──

/** 渲染当前位置 + 下一步 action + 阶段 guidance（wave/planning 均调对应 build 函数取真实 guidance）。 */
function renderNextStepSection(
  unit: WorkUnitRecord,
  scope: string,
  status: string,
): string[] {
  const lines: string[] = [];
  lines.push("## 当前位置与下一步");
  lines.push(`状态：${status}`);

  if (TERMINAL_STATUSES.has(status)) {
    lines.push("（终态，流程已结束）");
    return lines;
  }

  const resolved = buildGuidanceForScope(unit, scope, status);
  if (!resolved) {
    lines.push(`（状态 ${status} 无已知下一步 action，请用 cw v1 status --unitId ${unit.id} 确认）`);
    return lines;
  }

  // 明确告诉接手 agent「现在该跑什么命令」
  lines.push(`下一步执行：cw v1 ${resolved.action} --unitId ${unit.id}`);

  // 阶段 guidance（含 schema + 关键约束）——与实际跑 action 返回的 guidance 逐字一致
  if (resolved.guidance) {
    lines.push("");
    lines.push("阶段提示（含 input schema + 关键约束）：");
    lines.push(resolved.guidance);
  } else {
    lines.push("（阶段 guidance 生成失败，请直接执行上述命令获取）");
  }
  return lines;
}

// ── §4 涉及文件与契约段 ──

/** 渲染涉及文件与契约（按 scope 收窄：wave=files/contracts/tasks，planning=split+技术方案）。 */
function renderArtifactsSection(unit: WorkUnitRecord, scope: string): string[] {
  const lines: string[] = [];

  if (scope === "wave") {
    const plan = readField<Record<string, unknown>>(unit, "plan");
    if (!plan) return lines;

    const files = asArray<Record<string, unknown>>(plan.files);
    if (files.length > 0) {
      lines.push("files:");
      for (const f of files) {
        const path = asString(f.path);
        const action = asString(f.action);
        const desc = asString(f.description);
        if (path) lines.push(`  - ${path} [${action}] ${truncate(desc, HANDOFF_TRUNC.FILE_DESC)}`);
      }
    }

    const contracts = asArray<Record<string, unknown>>(plan.contracts);
    if (contracts.length > 0) {
      lines.push("contracts:");
      for (const c of contracts) {
        const name = asString(c.name);
        const def = asString(c.definition);
        if (name) lines.push(`  - ${name}: ${truncate(def, HANDOFF_TRUNC.CONTRACT_DEF)}`);
      }
    }

    const tasks = asArray<Record<string, unknown>>(plan.tasks);
    if (tasks.length > 0) {
      lines.push("tasks:");
      for (const t of tasks) {
        const id = asString(t.id);
        const type = asString(t.type);
        const steps = asArray<string>(t.steps);
        if (id) lines.push(`  - ${id} [${type}] ${steps.length} 步`);
      }
    }

    // execute 后的提交信息
    const evidence = readField<Record<string, unknown>>(unit, "evidence");
    const commitHash = asString(evidence?.commitHash);
    const changedFiles = asArray<unknown>(evidence?.changedFiles);
    if (commitHash) {
      lines.push(`已提交: ${commitHash}${changedFiles.length > 0 ? `（${changedFiles.length} 个文件变更）` : ""}`);
    } else if (files.length === 0 && contracts.length === 0 && tasks.length === 0) {
      lines.push("（尚未进入实现阶段，无文件/契约）");
    }
    return lines;
  }

  // planning 层：split + slice 技术方案
  const plan = readField<Record<string, unknown>>(unit, "plan");
  if (plan) {
    const split = asArray<Record<string, unknown>>(plan.split);
    if (split.length > 0) {
      lines.push("split（拆出的子单元）:");
      for (const s of split) {
        const slug = asString(s.slug);
        const desc = asString(s.description);
        if (slug) lines.push(`  - ${slug}: ${truncate(desc, HANDOFF_TRUNC.FILE_DESC)}`);
      }
    }

    // slice 技术方案
    const techChoices = asArray<Record<string, unknown>>(plan.techChoices);
    if (techChoices.length > 0) {
      lines.push("技术选型:");
      for (const tc of techChoices) {
        const area = asString(tc.area);
        const chosen = asString(tc.chosen);
        if (area) lines.push(`  - ${area}: ${truncate(chosen ?? "", HANDOFF_TRUNC.CONTRACT_DEF)}`);
      }
    }

    const interfaces = asArray<Record<string, unknown>>(plan.interfaces);
    if (interfaces.length > 0) {
      lines.push("接口契约:");
      for (const i of interfaces) {
        const name = asString(i.name);
        if (name) lines.push(`  - ${name}`);
      }
    }
  }

  return lines;
}

// ── §5 历史与变更段 ──

/** 从 statusHistory + abandonedRefs 渲染时间线。 */
function renderHistorySection(unit: WorkUnitRecord): string[] {
  const lines: string[] = [];
  const history = asArray<Record<string, unknown>>(unit.statusHistory);
  if (history.length > 0) {
    for (const h of history) {
      const at = asString(h.at);
      const action = asString(h.action);
      const to = asString(h.to);
      const note = asString(h.note);
      const ts = at ? at.slice(0, TIMESTAMP_SLICE_LEN).replace("T", " ") : "?";
      const transition = to ? `${action} → ${to}` : action;
      lines.push(`- [${ts}] ${transition}${note ? `（${truncate(note, HANDOFF_TRUNC.NOTE)}）` : ""}`);
    }
  }

  const abandoned = asArray<Record<string, unknown>>(unit.abandonedRefs);
  if (abandoned.length > 0) {
    lines.push(`被 replan 废弃：${abandoned.length} 条`);
    for (const a of abandoned) {
      const id = asString(a.id);
      const reason = asString(a.reason);
      if (id) lines.push(`  - ${id}${reason ? `：${truncate(reason, HANDOFF_TRUNC.REASON)}` : ""}`);
    }
  }

  return lines;
}

// ── 通用类型收窄 helper（从 WorkUnitRecord 宽松字段安全取值）──

/** 从 unit 取一个字段并断言为 T（unknown 时返回 undefined）。 */
function readField<T>(unit: WorkUnitRecord, field: string): T | undefined {
  const v = unit[field];
  return (v !== null && typeof v === "object") ? (v as T) : undefined;
}

/** 断言值为数组，非数组返回空数组。 */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** 断言值为 string，非 string 返回 undefined。 */
function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

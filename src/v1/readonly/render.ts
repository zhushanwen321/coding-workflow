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
import { CwError } from "../core/errors.js";
import type { Clarification } from "../core/clarifications.js";
import type { Epic,ExecutionUnit, Feature, Slice } from "../core/workunit.js";
import { buildEpicNextAction } from "../handlers/epic/epic-internal.js";
import { buildFeatureNextAction } from "../handlers/feature/feature-internal.js";
import { buildNextAction } from "../handlers/internal.js";
import { buildSliceNextAction } from "../handlers/slice/slice-internal.js";
import type { PlanningAction,WaveAction } from "../rules/state-machine.js";
import type { RepoMeta, WorkUnitRecord } from "../store/schema.js";
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

// ═══════════════════════════════════════════════════════════════
// renderList — 单 cwd / 跨 cwd 通用列表渲染
// ═══════════════════════════════════════════════════════════════

/** list 命令的渲染选项。 */
export interface ListOptions {
  /** 单页上限，默认 10 */
  limit?: number;
  /** 翻页偏移，默认 0 */
  offset?: number;
  /** 跨 cwd 模式（带 group header），默认 false */
  all?: boolean;
  /** scope 过滤（向后兼容旧 layer 参数） */
  layer?: string;
  /** slug + objective 大小写不敏感 substring 过滤 */
  grep?: string;
  /** 追加 children/created 列 */
  verbose?: boolean;
}

/** 带 cwd 标注的 unit（--all 模式 group header 用）。单 cwd 模式 cwd/repoMeta 为 undefined。 */
export interface AnnotatedUnit {
  unit: WorkUnitRecord;
  /** 该 unit 所属的 cwd 绝对路径（--all 模式注入） */
  cwd?: string;
  /** 该 unit 所属 cwd 的 repoMeta（--all 模式注入） */
  repoMeta?: RepoMeta;
}

/** group header 与分页分隔行的宽度（视觉一致，不依赖终端宽度）。 */
const LIST_SEPARATOR_WIDTH = 71;

/** objective 列截断长度（超出加 …，总长 ≤ 51）。 */
const LIST_OBJECTIVE_MAX = 50;

/** 默认每页条数（ListOptions.limit 缺省值）。cli 层默认值与此一致。 */
const DEFAULT_LIMIT = 10;

/** 日期分量的两位补齐宽度（月/日/时/分）。 */
const DATE_PAD_WIDTH = 2;

/**
 * renderList — unit 列表渲染，支持过滤 / 分页 / 分组。
 *
 * 数据流（design-review 修正）：接收 AnnotatedUnit[]，每个 unit 可选携带 cwd/repoMeta
 * 标注。单 cwd 模式 cwd/repoMeta 为 undefined；--all 模式由 cli 层从
 * loadAllCwdsFromHome 注入，打通 group header 的 repo/branch/commit 数据流。
 *
 * 处理顺序：layer（scope）+ grep 过滤 → updatedAt DESC 排序 → offset/limit 分页 → 渲染。
 * all=true 按 cwd 分组（每组前加 repo/branch/cwd header），否则单表格。
 *
 * 第二个参数兼容旧签名（layer 字符串），现有调用方迁移到 ListOptions 后可删。
 *
 * @param annotated       全部 unit（带可选 cwd/repoMeta 标注）
 * @param optionsOrLayer  渲染选项，或旧式 layer 字符串
 */
export function renderList(
  annotated: ReadonlyArray<AnnotatedUnit>,
  optionsOrLayer?: ListOptions | string,
): string {
  // 向后兼容：第二个参数是 string 时视为 { layer: string }
  const opts: ListOptions = typeof optionsOrLayer === "string"
    ? { layer: optionsOrLayer }
    : (optionsOrLayer ?? {});

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const offset = opts.offset ?? 0;
  const all = opts.all ?? false;
  const verbose = opts.verbose ?? false;

  // 1. 过滤：layer（scope）+ grep（slug+objective 大小写不敏感 substring）
  let filtered = annotated.filter(({ unit }) => {
    if (opts.layer && unit.scope !== opts.layer) return false;
    if (opts.grep) {
      const needle = opts.grep.toLowerCase();
      const slug = (unit.slug ?? "").toString().toLowerCase();
      const objective = (getStringField(unit, "objective")).toLowerCase();
      if (!slug.includes(needle) && !objective.includes(needle)) return false;
    }
    return true;
  });

  const total = filtered.length;

  // 2. 排序：updatedAt DESC（null 排最后）
  filtered = [...filtered].sort((a, b) => {
    const ta = getUpdatedAt(a.unit) ?? "";
    const tb = getUpdatedAt(b.unit) ?? "";
    return tb.localeCompare(ta);
  });

  // 2.5 children 索引：基于 filtered 全集反查 parentUnitId 外键，
  //     key=parent 的 unitId，value=该 parent 的 children 数量。
  //     WorkUnitRecord schema 只有 parentUnitId 外键（无 children 字段），
  //     故 children 关系需在此反查构建（修复 renderTable 永远显示 0 的 bug）。
  const childCountIndex = buildChildCountIndex(filtered);

  // 3. 分页
  const page = filtered.slice(offset, offset + limit);
  const pageLen = page.length;

  if (pageLen === 0) {
    return total === 0
      ? (opts.layer ? `(no units in layer: ${opts.layer})\n` : "(no units)\n")
      : `(no units on this page; total ${total}, offset ${offset})\n`;
  }

  // 4. 渲染
  if (all) {
    return renderGrouped(page, filtered, childCountIndex, opts, total, offset, pageLen, verbose);
  }
  return renderSingleCwd(page, childCountIndex, opts, total, offset, pageLen, verbose);
}

/**
 * 构建 childCountIndex：遍历全集，对每个 unit 的 parentUnitId 累加计数。
 *
 * key=parent 的 unitId，value=该 parent 拥有的 children 数量。
 * WorkUnitRecord 只有 parentUnitId 外键（无 children 字段），
 * children 关系必须反查此索引。
 */
function buildChildCountIndex(
  units: ReadonlyArray<AnnotatedUnit>,
): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  for (const { unit } of units) {
    const pid = unit.parentUnitId;
    if (typeof pid !== "string" || pid === "") continue;
    index.set(pid, (index.get(pid) ?? 0) + 1);
  }
  return index;
}

/**
 * renderSingleCwd — 普通 5 列表格（unitId/layer/status/objective/updated，
 * verbose 时加 children/created）。尾部附分页元信息（total > pageLen 时）。
 */
function renderSingleCwd(
  page: ReadonlyArray<AnnotatedUnit>,
  childCountIndex: ReadonlyMap<string, number>,
  opts: ListOptions,
  total: number,
  offset: number,
  pageLen: number,
  verbose: boolean,
): string {
  return renderTable(page, childCountIndex, verbose) + renderPagination(opts, total, offset, pageLen);
}

/**
 * renderGrouped — 按 cwd 分组。每组前加 group header（repo/branch/@commit/cwd），
 * 组内是同一份表格（单组内分页元信息），尾部再附跨组总分页元信息。
 *
 * 同 repo 多 worktree 的 remoteUrl 去重（BC4）：首次出现的 remoteUrl 原样显示，
 * 后续相同 remoteUrl 显示 "(same repo)"，便于在多 worktree 场景识别同一仓库。
 */
function renderGrouped(
  page: ReadonlyArray<AnnotatedUnit>,
  filtered: ReadonlyArray<AnnotatedUnit>,
  childCountIndex: ReadonlyMap<string, number>,
  opts: ListOptions,
  total: number,
  offset: number,
  pageLen: number,
  verbose: boolean,
): string {
  const out: string[] = [];
  // 按 cwd 顺序保序分组（filtered 已按 updatedAt DESC 排序，page 是其切片）
  const groupOrder: string[] = [];
  const groupMap = new Map<string, AnnotatedUnit[]>();
  for (const au of page) {
    const key = au.cwd ?? "(unknown cwd)";
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
      groupOrder.push(key);
    }
    groupMap.get(key)!.push(au);
  }

  // BC4：跨组去重 remoteUrl（同 repo 多 worktree）
  const seenRemoteUrls = new Set<string>();

  for (const cwd of groupOrder) {
    const groupUnits = groupMap.get(cwd)!;
    const head = groupUnits[0];
    const meta = head.repoMeta;

    out.push(renderGroupHeader(meta, cwd, seenRemoteUrls));
    out.push(renderTable(groupUnits, childCountIndex, verbose));
  }

  // 跨组分页元信息（基于 filtered 全量，区别于组内 page 切片）
  out.push(renderPagination(opts, total, offset, pageLen));

  // C2：--all 模式分页可能截断其他 cwd 组（slice 在分组前发生），
  // 让 agent 知道有遗漏的 cwd 组，避免把当前页当作跨 cwd 的完整集合。
  const totalCwdGroups = new Set(filtered.map((au) => au.cwd ?? "(unknown cwd)")).size;
  const shownCwdGroups = new Set(page.map((au) => au.cwd ?? "(unknown cwd)")).size;
  if (shownCwdGroups < totalCwdGroups) {
    out.push(
      `${totalCwdGroups} cwd groups total, ${shownCwdGroups} shown (use --grep to narrow or --limit to show more)\n`,
    );
  }
  return out.join("");
}

/** 渲染单组 group header（双横线 + repo/branch/cwd + 双横线）。 */
function renderGroupHeader(
  meta: RepoMeta | undefined,
  cwd: string,
  seenRemoteUrls: Set<string>,
): string {
  // BC4：remoteUrl 去重。空串视为 "(no repo meta)"，不参与去重。
  const rawRemote = meta?.remoteUrl ?? "";
  let remoteLine: string;
  if (rawRemote === "") {
    remoteLine = "(no repo meta)";
  } else if (seenRemoteUrls.has(rawRemote)) {
    remoteLine = "(same repo)";
  } else {
    remoteLine = rawRemote;
    seenRemoteUrls.add(rawRemote);
  }

  const branch = meta?.branch || "-";
  const headCommit = meta?.headCommit || "-";
  const recorded = meta ? formatUpdatedAt(meta.recordedAt || null) : "-";

  const bar = "═".repeat(LIST_SEPARATOR_WIDTH);
  return (
    `${bar}\n` +
    ` repo   ${remoteLine}\n` +
    ` branch ${branch}   @ ${headCommit}   (recorded ${recorded})\n` +
    ` cwd    ${cwd}\n` +
    `${bar}\n`
  );
}

/**
 * 渲染表格主体（表头 + 分隔行 + 数据行）。
 *
 * 列宽按数据动态对齐（与表头比较取最大）。verbose=true 时追加 children/created 两列。
 * objective 列超 LIST_OBJECTIVE_MAX 字符截断加 …（不参与列宽对齐，最后列直接输出）。
 */
function renderTable(
  annotated: ReadonlyArray<AnnotatedUnit>,
  childCountIndex: ReadonlyMap<string, number>,
  verbose: boolean,
): string {
  const rows = annotated.map((au) => {
    const u = au.unit;
    return {
      unitId: u.id,
      layer: u.scope,
      status: getStringField(u, "status"),
      objective: truncateObjective(getStringField(u, "objective")),
      updated: formatUpdatedAt(getUpdatedAt(u)),
      children: String(childCountIndex.get(u.id) ?? 0),
      created: formatUpdatedAt(getCreatedAt(u)),
    };
  });

  const colWidths = {
    unitId: Math.max("unitId".length, ...rows.map((r) => r.unitId.length)),
    layer: Math.max("layer".length, ...rows.map((r) => r.layer.length)),
    status: Math.max("status".length, ...rows.map((r) => r.status.length)),
    updated: Math.max("updated".length, ...rows.map((r) => r.updated.length)),
  };

  const header =
    pad("unitId", colWidths.unitId) + "  " +
    pad("layer", colWidths.layer) + "  " +
    pad("status", colWidths.status) + "  " +
    pad("updated", colWidths.updated) + "  " +
    "objective" +
    (verbose ? "  children  created" : "");

  const separator =
    "-".repeat(colWidths.unitId) + "  " +
    "-".repeat(colWidths.layer) + "  " +
    "-".repeat(colWidths.status) + "  " +
    "-".repeat(colWidths.updated) + "  " +
    "----------" +
    (verbose ? "  --------  -------" : "");

  const body = rows
    .map((r) =>
      pad(r.unitId, colWidths.unitId) + "  " +
      pad(r.layer, colWidths.layer) + "  " +
      pad(r.status, colWidths.status) + "  " +
      pad(r.updated, colWidths.updated) + "  " +
      r.objective +
      (verbose ? `  ${pad(r.children, "children".length)}  ${r.created}` : ""),
    )
    .join("\n");

  return rows.length === 0 ? "" : `${header}\n${separator}\n${body}\n`;
}

/**
 * 渲染分页元信息。
 *
 * total > pageLen 时输出分隔行 + "Showing <start>–<end> of <total>" + 翻页提示。
 * total ≤ pageLen 时不输出（单页内无需分页提示）。
 */
function renderPagination(
  opts: ListOptions,
  total: number,
  offset: number,
  pageLen: number,
): string {
  if (total <= pageLen) return "";
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const start = offset + 1;
  const end = offset + pageLen;
  const bar = "─".repeat(LIST_SEPARATOR_WIDTH);
  return (
    `${bar}\n` +
    ` Showing ${start}–${end} of ${total}  (use --offset ${offset + limit} for next page, --grep to filter)\n`
  );
}

/** 从 statusHistory 末条 at 推导 updatedAt（RK-B3：不改 schema）。无 history 返回 null。 */
function getUpdatedAt(unit: WorkUnitRecord): string | null {
  const history = asArray(unit.statusHistory);
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  const at = (last as Record<string, unknown>)["at"];
  return typeof at === "string" && at.length > 0 ? at : null;
}

/**
 * 从 statusHistory 首条 at 推导 createdAt（verbose 列）。
 *
 * 复用 statusHistory 而非新增 createdAt 字段（RK-B3：不改 schema）。
 * 无 history 返回 null（renderTable 进一步转 "-"）。
 */
function getCreatedAt(unit: WorkUnitRecord): string | null {
  const history = asArray(unit.statusHistory);
  if (history.length === 0) return null;
  const first = history[0];
  const at = (first as Record<string, unknown>)["at"];
  return typeof at === "string" && at.length > 0 ? at : null;
}

/** 格式化绝对时间（本地时区 YYYY-MM-DD HH:mm）。null/无效返回 "-"。 */
function formatUpdatedAt(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const pad2 = (n: number): string => String(n).padStart(DATE_PAD_WIDTH, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 截断 objective 到 LIST_OBJECTIVE_MAX 字符 + …（超长时）。 */
function truncateObjective(s: string): string {
  return s.length > LIST_OBJECTIVE_MAX ? s.slice(0, LIST_OBJECTIVE_MAX) + "…" : s;
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

/** handoff 视图范围：self=仅焦点 unit；upstream=父链+焦点；full=父链+焦点+子树。 */
export type HandoffScope = "self" | "upstream" | "full";

/** renderHandoff 需要的 store 读方法结构类型（与 renderTree 同风格，不直接 import V1Store，保持纯函数可测性）。 */
export interface HandoffStore {
  load(id: string): WorkUnitRecord | null;
  findChildren(parentUnitId: string): WorkUnitRecord[];
}

/**
 * renderHandoff — 以某 unit 为焦点的叙述性交接摘要（可按 scope 扩展上下文）。
 *
 * 与 renderStatus 的区别：renderStatus 是原始 JSON dump（程序化消费），
 * renderHandoff 是五段式 markdown 文本（agent/人读），聚合目标/已定决策/
 * 当前位置与下一步 guidance/涉及文件与契约/历史与变更。
 *
 * scope 取值：
 *   - "self"（默认）：仅焦点 unit 五段式，与历史行为完全一致。
 *   - "upstream"：父链（根→焦点）每层 brief（目标+决策+下一步）+ 焦点完整五段式。
 *   - "full"：父链 brief + 焦点完整 + 子树递归 brief。
 *
 * brief 段复用 renderDecisionsSection / renderNextStepSection（剔除 history/artifacts 避免爆行）。
 * 父链/子树以 markdown 标题层级（##/####…）表达深度，焦点以 `=== FOCUS ===` 标记。
 * 拼接结果超 HANDOFF_SIZE_WARNING_THRESHOLD 行时尾部追加 warning（不截断）。
 *
 * 下一步 guidance 复用各层的 build{Scope}NextAction（纯函数，验证过不碰 store/fs/stdin），
 * 保证 handoff 输出的 guidance 与实际跑 action 返回的 guidance 逐字一致。
 *
 * @param unit   已读出的焦点 WorkUnitRecord（调用方负责 load + not found 判定）
 * @param store  读方法结构类型（load / findChildren）；scope=self 时不使用，
 *               默认空 store（仅给老的单参数调用方兜底，scope=self 时不会触达）
 * @param scope  视图范围，默认 "self"
 */
export function renderHandoff(
  unit: WorkUnitRecord,
  store: HandoffStore = noopStore,
  scope: HandoffScope = "self",
): string {
  if (!isValidHandoffScope(scope)) {
    throw new CwError(`scope 必须是 self/upstream/full，当前值: ${scope}`);
  }
  if (scope === "self") return renderHandoffSelf(unit);
  if (scope === "upstream") return renderHandoffUpstream(unit, store);
  return renderHandoffFull(unit, store);
}

/**
 * 默认空 store：load 永远返回 null，findChildren 永远返回空数组。
 *
 * 仅用于 renderHandoff 的老调用方（只传 unit、scope 隐式 self）兜底默认参数；
 * scope=self 时根本不会触达 store 方法，故空实现安全。
 */
const noopStore: HandoffStore = {
  load(): null {
    return null;
  },
  findChildren(): WorkUnitRecord[] {
    return [];
  },
};

/** 运行时判定字符串是否为合法 HandoffScope（narrow 谓词）。 */
function isValidHandoffScope(s: string): s is HandoffScope {
  return s === "self" || s === "upstream" || s === "full";
}

/**
 * renderHandoffSelf — 焦点 unit 的完整五段式（历史行为，单 unit）。
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
function renderHandoffSelf(unit: WorkUnitRecord): string {
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

// ── scope 扩展段（brief / upstream / full / size warning）──

/** markdown 标题层级上限（# ~ ######）。 */
const HANDOFF_MAX_HEADING_DEPTH = 6;

/** handoff 拼接结果超过此行数时尾部追加 warning（不截断）。 */
const HANDOFF_SIZE_WARNING_THRESHOLD = 500;

/** 祖先 brief 的起始标题深度（##，留 # 给焦点完整段）。 */
const ANCESTOR_HEADING_BASE_DEPTH = 2;

/** 子树 brief 的起始标题深度（####，比焦点的 # 更深，表达「焦点之下」）。 */
const SUBTREE_HEADING_BASE_DEPTH = 4;

/**
 * renderHandoffBrief — 父链/子树每层的精简视图。
 *
 * 只含：目标 + 已定决策 + 下一步（剔除 history/artifacts 避免爆行）。
 * unit 头用 `#`×depth 表达层级（depth 上限 6）；段内复用 renderDecisionsSection
 *（无标题，直接拼接）和 renderNextStepSection（含 `##` 标题，用 rewriteHeadingDepth
 * 改写到目标深度，并改名为「位置/下一步」以区别焦点完整段的标题）。
 *
 * @param unit  该层 unit
 * @param depth markdown 标题层级（2→##，3→###，…；上限 6）
 */
function renderHandoffBrief(unit: WorkUnitRecord, depth: number): string {
  const headerDepth = Math.min(Math.max(depth, 1), HANDOFF_MAX_HEADING_DEPTH);
  const hashes = "#".repeat(headerDepth);
  const scope = unit.scope;
  const status = getStringField(unit, "status");

  const lines: string[] = [];
  lines.push(`${hashes} ${unit.id} [${status}]`);
  lines.push(`目标: ${getStringField(unit, "objective") || "(无)"}`);

  // 已定决策（renderDecisionsSection 返回纯列表行，无标题，直接拼）
  const decisions = renderDecisionsSection(unit);
  if (decisions.length > 0) {
    lines.push(`${hashes}# 已定决策`);
    lines.push(...decisions);
  }

  // 下一步（renderNextStepSection 首行是 `## 当前位置与下一步`，改写到 headerDepth+1）
  const nextStep = renderNextStepSection(unit, scope, status);
  lines.push(...rewriteHeadingDepth(nextStep, headerDepth + 1, "位置/下一步"));

  return lines.join("\n") + "\n";
}

/**
 * 改写 markdown 行数组里的 `#` 标题到目标深度（上限 6）。
 *
 * renderNextStepSection 硬编码 `## 当前位置与下一步`，brief 里需随父链深度对齐，
 * 否则标题层级混乱。可选 `rename` 把首个标题改名为更贴合 brief 语义的名字。
 *
 * 仅改写以 1-6 个 `#` + 空格开头的行；非标题行原样保留。
 */
function rewriteHeadingDepth(
  lines: ReadonlyArray<string>,
  depth: number,
  rename?: string,
): string[] {
  const targetDepth = Math.min(Math.max(depth, 1), HANDOFF_MAX_HEADING_DEPTH);
  const targetHashes = "#".repeat(targetDepth);
  let renamed = false;
  return lines.map((line) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) return line;
    if (rename && !renamed) {
      renamed = true;
      return `${targetHashes} ${rename}`;
    }
    return `${targetHashes} ${m[2]}`;
  });
}

/**
 * renderHandoffUpstream — 父链（根→焦点）brief + 焦点完整五段式。
 *
 * 父链沿 parentUnitId 上溯到根（visited 防循环 RK-C3），每层用 brief，
 * 深度从 2（##）开始递增；焦点用 renderHandoffSelf 完整五段式，并以
 * `=== FOCUS ===` 标记起始，便于接手 agent 定位主体。
 */
function renderHandoffUpstream(
  focus: WorkUnitRecord,
  store: HandoffStore,
): string {
  const { ancestors } = collectAncestors(focus, store);

  const parts: string[] = [];
  ancestors.forEach((u, i) => {
    parts.push(renderHandoffBrief(u, ANCESTOR_HEADING_BASE_DEPTH + i));
  });
  parts.push("=== FOCUS ===\n" + renderHandoffSelf(focus));

  return appendSizeWarningIfNeeded(parts.join("\n"));
}

/**
 * renderHandoffFull — 父链 brief + 焦点完整 + 子树递归 brief。
 *
 * 父链同 upstream；子树从焦点出发递归 findChildren，每层 brief，
 * 深度从 4（####）开始（比焦点的 # 更深，表达「焦点之下」）。
 * visited 集贯穿父链+子树，防止环导致无限递归。
 */
function renderHandoffFull(
  focus: WorkUnitRecord,
  store: HandoffStore,
): string {
  const { ancestors, visited } = collectAncestors(focus, store);

  const parts: string[] = [];
  ancestors.forEach((u, i) => {
    parts.push(renderHandoffBrief(u, ANCESTOR_HEADING_BASE_DEPTH + i));
  });
  parts.push("=== FOCUS ===\n" + renderHandoffSelf(focus));

  // 子树递归 brief（#### 深度起，比 focus 深）
  const subtreeLines: string[] = [];
  const renderSubtree = (parentId: string, depth: number): void => {
    const children = store.findChildren(parentId);
    for (const child of children) {
      if (visited.has(child.id)) continue; // RK-C3 防循环
      visited.add(child.id);
      subtreeLines.push(renderHandoffBrief(child, depth));
      renderSubtree(child.id, depth + 1);
    }
  };
  renderSubtree(focus.id, SUBTREE_HEADING_BASE_DEPTH);
  if (subtreeLines.length > 0) {
    parts.push("--- 子树 ---\n" + subtreeLines.join("\n"));
  }

  return appendSizeWarningIfNeeded(parts.join("\n"));
}

/**
 * 沿 parentUnitId 上溯收集祖先（根在前，焦点不在其中）。
 *
 * 返回 ancestors（根→最近祖先）和 visited（含焦点及所有已遍历 id），
 * 供子树阶段复用以防循环。
 */
function collectAncestors(
  focus: WorkUnitRecord,
  store: HandoffStore,
): { ancestors: WorkUnitRecord[]; visited: Set<string> } {
  const ancestors: WorkUnitRecord[] = [];
  const visited = new Set<string>();
  visited.add(focus.id);
  let current: WorkUnitRecord | null = focus;
  while (current && typeof current.parentUnitId === "string" && current.parentUnitId !== "" && !visited.has(current.parentUnitId)) {
    const parent = store.load(current.parentUnitId);
    if (!parent) break;
    visited.add(parent.id);
    ancestors.unshift(parent); // 根在前
    current = parent;
  }
  return { ancestors, visited };
}

/** 拼接结果超阈值时尾部追加 warning（不截断），让接手 agent 知道上下文偏大。 */
function appendSizeWarningIfNeeded(content: string): string {
  const lineCount = content.split("\n").length;
  if (lineCount <= HANDOFF_SIZE_WARNING_THRESHOLD) return content;
  return (
    content +
    `\n\n⚠ Handoff exceeds ${HANDOFF_SIZE_WARNING_THRESHOLD} lines (actual: ${lineCount}). ` +
    `Consider narrowing scope (--scope self) or descending into a specific child.\n`
  );
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

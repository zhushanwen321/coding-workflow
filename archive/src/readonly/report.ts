/**
 * report.ts — cw 多层 WorkUnit 树可视化报告生成器（纯函数）。
 *
 * 输入：根 WorkUnitRecord + ReportStore（load/findChildren 读方法）。
 * 输出：自包含的暗色 HTML 字符串（内联 CSS，无外部依赖，可离线打开）。
 *
 * 设计：
 *   - OKLCH 暗色主题，语义状态色（绿=pass / 红=fail / 琥珀=warn / 蓝=info）。
 *   - 4 层 WorkUnit（epic/feature/slice/wave）用 <details>/<summary> 折叠，
 *     epic 顶层默认展开。
 *   - collectDescendants 递归 DFS + visited 防环，root 在首（前序）。
 *
 * 纯函数契约：不读文件系统、不写盘、不 spawn 子进程（同 render.ts）。
 * 调用方（cli.ts，W2 范围）负责写入临时文件并打开浏览器。
 *
 * CSS 主题复刻自历史 0.x 单 topic 版本（git show 4bab4a4:src/report.ts），
 * 把单 topic 扁平视图改成 4 层树递归。
 */
import type { WorkUnitRecord } from "../store/schema.js";

// ═══════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════

/**
 * renderReport 需要的 store 读方法结构类型（与 render.ts 的 HandoffStore 同风格，
 * 不直接 import CwStore，保持纯函数可测性）。
 */
export interface ReportStore {
  load(id: string): WorkUnitRecord | null;
  findChildren(parentUnitId: string): WorkUnitRecord[];
}

/** renderReport 的渲染选项。output/open 供调用方（cli.ts）消费，纯函数本身不写盘/不打开。 */
export interface ReportOptions {
  /** 目标文件路径（cli 层写盘用，此处仅在 footer 展示）。 */
  output?: string;
  /** 是否打开浏览器（cli 层消费）。 */
  open?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// HTML 转义 & 格式化
// ═══════════════════════════════════════════════════════════════

/** HTML 转义：& < > " → 实体。所有用户内容字段渲染前必过此函数（防 XSS）。 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** padStart 宽度（与 render.ts 的 DATE_PAD_WIDTH 同约定）。 */
const PAD_WIDTH = 2;
/** JSON 序列化缩进（与 render.ts 的 JSON_INDENT 同约定）。 */
const JSON_INDENT = 2;
/** 毫秒/分钟。 */
const MS_PER_MINUTE = 60000;
/** 分钟/小时。 */
const MINS_PER_HOUR = 60;
/** 百分比基数。 */
const PERCENT_BASE = 100;
/** 终态比例 ≥ 此值显示 pass 色（否则 warn/fail）。 */
const TERMINAL_RATIO_GOOD = 80;

/** ISO 时间 → "MM-DD HH:mm"，空值返回 "—"。 */
function formatTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(PAD_WIDTH, "0");
  const dd = String(d.getDate()).padStart(PAD_WIDTH, "0");
  const hh = String(d.getHours()).padStart(PAD_WIDTH, "0");
  const mi = String(d.getMinutes()).padStart(PAD_WIDTH, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** 计算 created→closed 时长，如 "7h 34m" / "12m"，无效返回 "—"。 */
function duration(created: string, closed: string): string {
  if (!created || !closed) return "—";
  const diff = new Date(closed).getTime() - new Date(created).getTime();
  if (Number.isNaN(diff) || diff < 0) return "—";
  const mins = Math.round(diff / MS_PER_MINUTE);
  if (mins < MINS_PER_HOUR) return `${mins}m`;
  return `${Math.floor(mins / MINS_PER_HOUR)}h ${mins % MINS_PER_HOUR}m`;
}

// ═══════════════════════════════════════════════════════════════
// 安全字段提取（WorkUnitRecord 是 [key:string]:unknown 宽松 record）
// ═══════════════════════════════════════════════════════════════

/** 从 WorkUnitRecord 取 string 字段，非 string 降级为空串。 */
function getStr(record: WorkUnitRecord, key: string): string {
  const v = record[key];
  return typeof v === "string" ? v : "";
}

/** 从 WorkUnitRecord 取纯对象字段（plan/executeResult/evidence 等），非纯对象降级为 null。 */
function getObj(
  record: WorkUnitRecord,
  key: string,
): Record<string, unknown> | null {
  const v = record[key];
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

/** 从对象取数组字段，非数组降级为空数组。obj 为 null 时返回空数组。 */
function getArr(obj: Record<string, unknown> | null, key: string): unknown[] {
  if (!obj) return [];
  const v = obj[key];
  return Array.isArray(v) ? v : [];
}

/** 从对象取 string 字段，非 string 降级为空串。obj 为 null 时返回空串。 */
function getObjStr(
  obj: Record<string, unknown> | null,
  key: string,
): string {
  if (!obj) return "";
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

/** 把 unknown 收窄为纯对象（非 null/数组），失败返回 null。用于数组元素。 */
function asObj(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

/** 把 unknown 渲染成安全 HTML：string → 转义文本；array → ul；object → pre(JSON)；空 → "—"。 */
function renderScalarOrList(v: unknown): string {
  if (typeof v === "string") return v ? esc(v) : "—";
  if (Array.isArray(v)) {
    if (v.length === 0) return "—";
    return `<ul class="plain-list">${v
      .map((x) => `<li>${esc(typeof x === "string" ? x : JSON.stringify(x))}</li>`)
      .join("")}</ul>`;
  }
  if (v !== null && typeof v === "object") {
    return `<pre>${esc(JSON.stringify(v, null, JSON_INDENT))}</pre>`;
  }
  return "—";
}

/** label: value 行（value 走 renderScalarOrList）。 */
function kvRow(label: string, value: unknown): string {
  return `<div class="kv-row"><span class="kv-label">${esc(label)}</span><span class="kv-value">${renderScalarOrList(
    value,
  )}</span></div>`;
}

/** 把 unknown[] 渲染成 ul（string 直取，对象取 key: value 拼接）。 */
function listFromUnknownArr(arr: unknown[]): string {
  if (arr.length === 0) return "";
  const items = arr
    .map((x) => {
      if (typeof x === "string") return esc(x);
      const o = asObj(x);
      if (o) {
        return Object.keys(o)
          .map((k) => {
            const val = o[k];
            return `${esc(k)}: ${esc(
              typeof val === "string" ? val : JSON.stringify(val),
            )}`;
          })
          .join("; ");
      }
      return esc(JSON.stringify(x));
    })
    .map((s) => `<li>${s}</li>`)
    .join("");
  return `<ul class="plain-list">${items}</ul>`;
}

/** 标准小节：<h3 class="sub-h">title</h3> + inner。 */
function section(title: string, inner: string): string {
  return `<div class="card-section"><h3 class="sub-h">${esc(
    title,
  )}</h3>${inner}</div>`;
}

/** 把任意对象渲染为 kv 小节（遍历顶层 key）。用于 testJudgment/execReviewJudgment 等。 */
function renderObjAsKv(
  obj: Record<string, unknown> | null,
  title: string,
): string {
  if (!obj) return "";
  const rows = Object.keys(obj)
    .map((k) => kvRow(k, obj[k]))
    .join("");
  return section(title, `<div class="kv">${rows}</div>`);
}

// ═══════════════════════════════════════════════════════════════
// collectDescendants —— 递归 DFS 收集全树（root 在首，前序）
// ═══════════════════════════════════════════════════════════════

/**
 * 以 rootUnitId 为根，递归 DFS 收集自身 + 全部后代（含终态节点，不过滤 status）。
 *
 * root 在首、前序遍历。visited: Set 防环——循环 parentUnitId 不抛、不无限递归，
 * 已访问节点直接 return。root 不存在（load 返回 null）抛 Error（防御；cli 层已判空）。
 */
export function collectDescendants(
  rootUnitId: string,
  store: ReportStore,
): WorkUnitRecord[] {
  const root = store.load(rootUnitId);
  if (root === null) {
    throw new Error(`collectDescendants: unit not found: ${rootUnitId}`);
  }
  const result: WorkUnitRecord[] = [];
  const visited = new Set<string>();

  const dfs = (unit: WorkUnitRecord): void => {
    if (visited.has(unit.id)) return;
    visited.add(unit.id);
    result.push(unit);
    for (const child of store.findChildren(unit.id)) {
      dfs(child);
    }
  };
  dfs(root);
  return result;
}

// ═══════════════════════════════════════════════════════════════
// 渲染：状态 / 时间线 / summary / 树
// ═══════════════════════════════════════════════════════════════

/** 状态 → badge class（绿/红/灰/蓝）。 */
function statusBadgeClass(status: string): string {
  if (status === "closed") return "b-pass";
  if (status === "aborted") return "b-fail";
  if (status === "developed" || status === "tested" || status === "reviewed") {
    return "b-info";
  }
  return "b-muted";
}

/** 状态行：status: <badge>。 */
function renderStatusLine(record: WorkUnitRecord): string {
  const status = getStr(record, "status");
  return `<p class="status-line">status: <span class="badge ${statusBadgeClass(
    status,
  )}">${esc(status || "—")}</span></p>`;
}

/** create→closed 时间线 + duration（从 statusHistory 提取 create at / closed at）。 */
function renderStatusTimeline(record: WorkUnitRecord): string {
  const history = getArr(record, "statusHistory");
  let createdAt = "";
  let closedAt = "";
  for (const item of history) {
    const e = asObj(item);
    if (!e) continue;
    if (getObjStr(e, "action") === "create") createdAt = getObjStr(e, "at");
    const to = getObjStr(e, "to");
    if (to === "closed" || to === "aborted") closedAt = getObjStr(e, "at");
  }
  return `<div class="timeline"><span>created <b>${formatTime(
    createdAt,
  )}</b></span>${
    closedAt ? `<span>closed <b>${formatTime(closedAt)}</b></span>` : ""
  }<span>duration <b>${esc(duration(createdAt, closedAt))}</b></span></div>`;
}

/** summary 行：scope badge + id + slug + objective + status badge。 */
function renderSummary(record: WorkUnitRecord): string {
  const scope = record.scope;
  const slug = getStr(record, "slug");
  const objective = getStr(record, "objective");
  const status = getStr(record, "status");
  return `<span class="badge b-muted scope-badge">${esc(
    scope,
  )}</span> <code>${esc(record.id)}</code>${
    slug ? ` <span class="sum-slug">${esc(slug)}</span>` : ""
  } <span class="sum-obj">${esc(objective)}</span> <span class="badge ${statusBadgeClass(
    status,
  )}">${esc(status || "—")}</span>`;
}

// ── planning 层（epic/feature/slice）专属小节 ───────────────

/** plan.split 表格行（slug/description/dependsOn）。 */
function renderPlanSplit(plan: Record<string, unknown> | null): string {
  const split = getArr(plan, "split");
  if (split.length === 0) return "";
  const rows = split
    .map((item) => {
      const o = asObj(item);
      if (!o) return "";
      const slug = getObjStr(o, "slug");
      const desc = getObjStr(o, "description");
      const deps = getArr(o, "dependsOn")
        .filter((d): d is string => typeof d === "string")
        .map((d) => `<code>${esc(d)}</code>`)
        .join(" ");
      return `<tr><td><code>${esc(slug)}</code></td><td>${esc(
        desc,
      )}</td><td>${deps || "—"}</td></tr>`;
    })
    .join("\n");
  return section(
    "Plan Split",
    `<table><thead><tr><th>Slug</th><th>Description</th><th>Depends On</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

/** slice 专属 plan 字段（techChoices/interfaces/dataModels/errorSpecs）任一非空才渲染。 */
function renderSlicePlanLists(plan: Record<string, unknown> | null): string {
  const fields: Array<[string, string]> = [
    ["techChoices", "Tech Choices"],
    ["interfaces", "Interfaces"],
    ["dataModels", "Data Models"],
    ["errorSpecs", "Error Specs"],
  ];
  const parts: string[] = [];
  for (const [key, title] of fields) {
    const arr = getArr(plan, key);
    if (arr.length > 0) parts.push(section(title, listFromUnknownArr(arr)));
  }
  return parts.join("\n");
}

/** designReviewJudgment（necessity/alternatives/tradeoffs/risks）。 */
function renderDesignReview(record: WorkUnitRecord): string {
  const dr = getObj(record, "designReviewJudgment");
  if (!dr) return "";
  const kvInner =
    kvRow("Necessity", dr["necessity"]) +
    kvRow("Alternatives", dr["alternatives"]) +
    kvRow("Tradeoffs", dr["tradeoffs"]);
  const risks = getArr(dr, "risks");
  const risksHtml =
    risks.length > 0
      ? `<div class="risk-list">${risks
          .map((item) => {
            const o = asObj(item);
            if (!o) return "";
            const sev = getObjStr(o, "severity");
            const sevClass =
              sev === "high" ? "b-fail" : sev === "medium" ? "b-warn" : "b-info";
            return `<div class="risk"><div class="risk-head"><span class="badge ${sevClass}">${esc(
              sev || "?",
            )}</span></div><p class="risk-desc">${esc(
              getObjStr(o, "item"),
            )}</p>${
              getObjStr(o, "mitigation")
                ? `<p class="risk-mit">mitigation: ${esc(getObjStr(o, "mitigation"))}</p>`
                : ""
            }</div>`;
          })
          .join("")}</div>`
      : "";
  return section(
    "Design Review",
    `<div class="kv">${kvInner}</div>${risksHtml}`,
  );
}

/** clarifications（question/resolution 列表）。 */
function renderClarifications(record: WorkUnitRecord): string {
  const clar = getArr(record, "clarifications");
  if (clar.length === 0) return "";
  const items = clar
    .map((item) => {
      const o = asObj(item);
      if (!o) return "";
      const q = getObjStr(o, "question");
      const r = getObjStr(o, "resolution");
      return `<li><span class="q">${esc(q)}</span>${
        r ? `<span class="a">${esc(r)}</span>` : ""
      }</li>`;
    })
    .join("\n");
  return section("Clarifications", `<ul class="clar-list">${items}</ul>`);
}

/** epic/feature/slice 卡片内容（共用 + slice 额外）。 */
function renderPlanningSections(record: WorkUnitRecord): string {
  const plan = getObj(record, "plan");
  const parts: string[] = [];
  const splitHtml = renderPlanSplit(plan);
  if (splitHtml) parts.push(splitHtml);
  if (record.scope === "slice") {
    const sliceLists = renderSlicePlanLists(plan);
    if (sliceLists) parts.push(sliceLists);
  }
  const drHtml = renderDesignReview(record);
  if (drHtml) parts.push(drHtml);
  const clarHtml = renderClarifications(record);
  if (clarHtml) parts.push(clarHtml);
  return parts.join("\n");
}

// ── wave 层专属小节 ─────────────────────────────────────────

/** wave 卡片内容（plan/tasks/files/contracts/testCases + executeResult + judgments + retrospect）。 */
function renderWaveSections(record: WorkUnitRecord): string {
  const plan = getObj(record, "plan");
  const parts: string[] = [];

  for (const [key, title] of [
    ["tasks", "Tasks"],
    ["files", "Files"],
    ["contracts", "Contracts"],
    ["testCases", "Test Cases"],
  ] as const) {
    const arr = getArr(plan, key);
    if (arr.length > 0) parts.push(section(title, listFromUnknownArr(arr)));
  }

  const exec = getObj(record, "executeResult");
  const commit = getObjStr(exec, "commitHash");
  if (commit) {
    parts.push(`<p class="commit-line">commit: <code>${esc(commit)}</code></p>`);
  }

  const evidence = getObj(record, "evidence");
  const changed = getArr(evidence, "changedFiles");
  if (changed.length > 0) {
    parts.push(section("Changed Files", listFromUnknownArr(changed)));
  }

  const tjHtml = renderObjAsKv(getObj(record, "testJudgment"), "Test Judgment");
  if (tjHtml) parts.push(tjHtml);

  const erHtml = renderObjAsKv(
    getObj(record, "execReviewJudgment"),
    "Exec Review",
  );
  if (erHtml) parts.push(erHtml);

  const retroHtml = renderRetrospect(record);
  if (retroHtml) parts.push(retroHtml);

  return parts.join("\n");
}

/** retrospectData（lessonsLearned/knownRisks/processIssues）。 */
function renderRetrospect(record: WorkUnitRecord): string {
  const rd = getObj(record, "retrospectData");
  if (!rd) return "";
  const lessons = getObjStr(rd, "lessonsLearned");
  const risks = getArr(rd, "knownRisks");
  const issues = getArr(rd, "processIssues");
  const parts: string[] = [];
  if (lessons) parts.push(`<p class="lessons">${esc(lessons)}</p>`);
  if (risks.length > 0) parts.push(listFromUnknownArr(risks));
  if (issues.length > 0) parts.push(listFromUnknownArr(issues));
  if (parts.length === 0) return "";
  return section("Retrospect", parts.join("\n"));
}

/** 按 scope 分支渲染 unit 卡片内容（不含 details/summary 外壳）。 */
function renderUnitCard(record: WorkUnitRecord): string {
  const common = `${renderStatusLine(record)}\n${renderStatusTimeline(record)}`;
  switch (record.scope) {
    case "epic":
    case "feature":
    case "slice":
      return `${common}\n${renderPlanningSections(record)}`;
    case "wave":
      return `${common}\n${renderWaveSections(record)}`;
    default:
      return common;
  }
}

/** 由扁平 descendants 构建 parentId → children[] 映射（root 的 parentUnitId 为 undefined，跳过）。 */
function buildChildrenMap(
  descendants: WorkUnitRecord[],
): Map<string, WorkUnitRecord[]> {
  const map = new Map<string, WorkUnitRecord[]>();
  for (const d of descendants) {
    const parent = d.parentUnitId;
    if (parent === undefined) continue;
    const list = map.get(parent) ?? [];
    list.push(d);
    map.set(parent, list);
  }
  return map;
}

/** 递归渲染 <details> 树（depth===0 即 epic 顶层用 <details open>）。 */
function renderDetailsTree(
  unit: WorkUnitRecord,
  childrenMap: Map<string, WorkUnitRecord[]>,
  depth: number,
): string {
  const openAttr = depth === 0 ? " open" : "";
  const summary = renderSummary(unit);
  const card = renderUnitCard(unit);
  const children = childrenMap.get(unit.id) ?? [];
  const childHtml = children
    .map((c) => renderDetailsTree(c, childrenMap, depth + 1))
    .join("\n");
  return `<details class="unit unit-${esc(unit.scope)}"${openAttr}>
<summary>${summary}</summary>
<div class="unit-card">
${card}
</div>${
    childHtml ? `\n<div class="tree-children">\n${childHtml}\n</div>` : ""
  }
</details>`;
}

// ═══════════════════════════════════════════════════════════════
// 主渲染区段
// ═══════════════════════════════════════════════════════════════

/** 报告页头：slug 标题 + objective + scope/id/total 元信息。 */
function renderHeader(rootUnit: WorkUnitRecord, total: number): string {
  const slug = getStr(rootUnit, "slug");
  const objective = getStr(rootUnit, "objective");
  return `
  <header class="header">
    <h1>${esc(slug || rootUnit.id)}</h1>
    <p class="objective">${esc(objective)}</p>
    <div class="meta">
      <span>root scope: <b>${esc(rootUnit.scope)}</b></span>
      <span>id: <b>${esc(rootUnit.id)}</b></span>
      <span>total units: <b>${total}</b></span>
    </div>
  </header>`;
}

/** 概览 pills：总 unit 数 / 各 scope 计数 / 终态比例。 */
function renderOverview(
  rootUnit: WorkUnitRecord,
  descendants: WorkUnitRecord[],
): string {
  const total = descendants.length;
  const scopes = ["epic", "feature", "slice", "wave"];
  const pill = (dotClass: string, label: string): string =>
    `<span class="pill"><span class="dot ${dotClass}"></span>${label}</span>`;
  const scopeCounts = scopes
    .map((s) => ({ s, n: descendants.filter((d) => d.scope === s).length }))
    .filter((c) => c.n > 0);
  const terminal = descendants.filter((d) => {
    const st = getStr(d, "status");
    return st === "closed" || st === "aborted";
  }).length;
  const ratio = total > 0 ? Math.round((terminal / total) * PERCENT_BASE) : 0;
  const ratioDot =
    ratio >= TERMINAL_RATIO_GOOD ? "dot-pass" : ratio > 0 ? "dot-warn" : "dot-fail";

  const pills = [
    pill("dot-info", `root ${esc(rootUnit.scope)}`),
    pill("dot-info", `${total} units`),
    ...scopeCounts.map((c) => pill("dot-info", `${c.n} ${c.s}`)),
    pill(ratioDot, `${ratio}% terminal`),
  ];
  return `
  <section>
    <h2>Overview</h2>
    <div class="overview">${pills.join("")}</div>
  </section>`;
}

/**
 * renderReport —— 从根 WorkUnitRecord + store 生成自包含暗色 HTML 报告。
 *
 * 纯函数：不读文件、不写文件、不 spawn 子进程。内部调 collectDescendants 取全树，
 * 4 层 WorkUnit 用 <details>/<summary> 折叠渲染（epic 顶层 open）。所有用户内容字段
 * 渲染前必过 esc()。
 *
 * @param rootUnit  已读出的根 WorkUnitRecord（调用方负责 load + not found 判定）
 * @param store     读方法结构类型（load / findChildren）
 * @param options   渲染选项（output/open 供 cli 层消费；此处 output 仅在 footer 展示）
 */
export function renderReport(
  rootUnit: WorkUnitRecord,
  store: ReportStore,
  options?: ReportOptions,
): string {
  const descendants = collectDescendants(rootUnit.id, store);
  const total = descendants.length;
  const childrenMap = buildChildrenMap(descendants);
  const target = options?.output
    ? `<span>target: ${esc(options.output)}</span>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CW Report — ${esc(getStr(rootUnit, "slug") || rootUnit.id)}</title>
<style>
  :root {
    --bg:          oklch(0.17 0.004 255);
    --surface:     oklch(0.21 0.005 255);
    --surface-2:   oklch(0.24 0.006 255);
    --ink:         oklch(0.87 0.005 255);
    --ink-strong:  oklch(0.94 0.003 255);
    --muted:       oklch(0.62 0.008 255);
    --faint:       oklch(0.48 0.006 255);
    --border:      oklch(0.30 0.006 255);
    --border-soft: oklch(0.26 0.005 255);

    --pass:    oklch(0.72 0.16 150);
    --pass-bg: oklch(0.28 0.05 150);
    --fail:    oklch(0.70 0.19 25);
    --fail-bg: oklch(0.28 0.05 25);
    --warn:    oklch(0.78 0.14 75);
    --warn-bg: oklch(0.30 0.05 75);
    --info:    oklch(0.72 0.12 245);
    --info-bg: oklch(0.28 0.04 245);

    --mono: "SF Mono", "Cascadia Code", "JetBrains Mono", "Roboto Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-font-smoothing: antialiased; }
  body {
    font-family: var(--sans);
    font-size: 15px; line-height: 1.6;
    color: var(--ink); background: var(--bg);
    padding: 2.5rem 1.25rem 5rem;
  }
  .wrap { max-width: 920px; margin: 0 auto; }
  h1, h2, h3 { color: var(--ink-strong); text-wrap: balance; }
  h1 { font-size: 1.6rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.3; }
  h2 {
    font-size: 0.8rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--faint);
    margin: 0 0 0.75rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  h3 { font-size: 0.95rem; font-weight: 600; }
  .sub-h {
    margin-bottom: 0.5rem;
    font-size: 0.85rem; color: var(--muted); font-weight: 500;
    text-transform: none; letter-spacing: 0;
    border: none; padding: 0;
  }
  code { font-family: var(--mono); font-size: 0.85em; color: var(--info); }
  pre {
    font-family: var(--mono); font-size: 0.8em; color: var(--ink);
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 6px; padding: 0.6rem 0.75rem; overflow-x: auto;
    white-space: pre-wrap;
  }
  section { margin-bottom: 2.5rem; }
  .header { margin-bottom: 2rem; }
  .header h1 { margin-bottom: 0.35rem; }
  .header .objective {
    font-size: 0.95rem; color: var(--muted);
    margin-bottom: 0.75rem; text-wrap: pretty;
  }
  .meta {
    display: flex; flex-wrap: wrap; gap: 0.4rem 1.25rem;
    font-size: 0.8rem; color: var(--faint); font-family: var(--mono);
  }
  .meta span { display: inline-flex; align-items: center; gap: 0.35rem; }
  .meta b { color: var(--ink); font-weight: 500; }
  .overview { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 2rem; }
  .pill {
    display: inline-flex; align-items: center; gap: 0.4rem;
    padding: 0.35rem 0.7rem; border-radius: 6px;
    font-size: 0.82rem; font-weight: 500;
    background: var(--surface); border: 1px solid var(--border); color: var(--ink);
  }
  .pill .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .dot-pass { background: var(--pass); }
  .dot-fail { background: var(--fail); }
  .dot-warn { background: var(--warn); }
  .dot-info { background: var(--info); }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th {
    text-align: left; font-weight: 600;
    font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--faint);
    padding: 0.5rem 0.6rem;
    border-bottom: 1.5px solid var(--border);
  }
  td {
    padding: 0.55rem 0.6rem;
    border-bottom: 1px solid var(--border-soft);
    vertical-align: top;
  }
  tr:last-child td { border-bottom: none; }
  .badge {
    display: inline-block;
    padding: 0.12rem 0.45rem; border-radius: 4px;
    font-size: 0.72rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.03em;
    line-height: 1.5;
  }
  .b-pass { background: var(--pass-bg); color: var(--pass); }
  .b-fail { background: var(--fail-bg); color: var(--fail); }
  .b-warn { background: var(--warn-bg); color: var(--warn); }
  .b-info { background: var(--info-bg); color: var(--info); }
  .b-muted { background: var(--surface-2); color: var(--muted); }
  .status-line { margin-bottom: 0.4rem; font-size: 0.85rem; color: var(--muted); }
  .timeline {
    display: flex; flex-wrap: wrap; gap: 0.3rem 1rem;
    font-size: 0.78rem; color: var(--faint); font-family: var(--mono);
    margin-bottom: 0.75rem;
  }
  .timeline b { color: var(--ink); font-weight: 500; }
  .commit-line { font-size: 0.82rem; color: var(--muted); margin-bottom: 0.6rem; }
  .lessons {
    font-size: 0.88rem; color: var(--ink); line-height: 1.55;
    padding: 0.6rem 0.75rem; border-radius: 6px;
    background: var(--surface); border: 1px solid var(--border);
  }
  .plain-list { list-style: disc; padding-left: 1.4rem; margin: 0.25rem 0; }
  .plain-list li { font-size: 0.85rem; color: var(--muted); margin-bottom: 0.2rem; }
  .clar-list { list-style: none; }
  .clar-list li {
    padding: 0.5rem 0; border-bottom: 1px solid var(--border-soft);
    display: flex; flex-direction: column; gap: 0.2rem;
  }
  .clar-list li:last-child { border-bottom: none; }
  .clar-list .q { font-size: 0.85rem; color: var(--ink); }
  .clar-list .a { font-size: 0.82rem; color: var(--muted); }
  .kv { display: flex; flex-direction: column; gap: 0.4rem; }
  .kv-row { display: flex; gap: 0.6rem; font-size: 0.85rem; align-items: baseline; }
  .kv-label {
    min-width: 110px; flex-shrink: 0; color: var(--faint);
    font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em;
  }
  .kv-value { color: var(--ink); flex: 1; }
  .card-section { margin-bottom: 0.9rem; }
  .risk-list { display: flex; flex-direction: column; gap: 0.6rem; }
  .risk { padding: 0.65rem 0.8rem; border-radius: 6px; background: var(--surface); border: 1px solid var(--border); }
  .risk-head { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; flex-wrap: wrap; }
  .risk-desc { font-size: 0.85rem; color: var(--muted); }
  .risk-mit { font-size: 0.8rem; color: var(--faint); margin-top: 0.2rem; }
  .tree { display: flex; flex-direction: column; gap: 0.5rem; }
  details.unit {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 0;
  }
  details.unit > summary {
    cursor: pointer; padding: 0.6rem 0.85rem;
    font-size: 0.88rem; color: var(--ink);
    display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem;
    list-style: none;
  }
  details.unit > summary::-webkit-details-marker { display: none; }
  details.unit > summary::before {
    content: "▶"; font-size: 0.7rem; color: var(--faint);
    transition: transform 0.15s ease;
  }
  details.unit[open] > summary::before { transform: rotate(90deg); }
  details.unit > summary .scope-badge { font-size: 0.68rem; }
  details.unit > summary .sum-slug { color: var(--ink-strong); font-weight: 500; }
  details.unit > summary .sum-obj { color: var(--muted); font-size: 0.82rem; flex: 1; min-width: 120px; }
  details.unit > .unit-card { padding: 0.5rem 0.85rem 0.85rem; border-top: 1px solid var(--border-soft); }
  details.unit > .tree-children {
    padding: 0.5rem 0.85rem 0.6rem;
    display: flex; flex-direction: column; gap: 0.4rem;
  }
  .tree-children details.unit { background: var(--surface-2); }
  .tree-children .tree-children details.unit { background: var(--surface); }
  .footer {
    margin-top: 3rem; padding-top: 1.25rem;
    border-top: 1px solid var(--border);
    font-size: 0.78rem; color: var(--faint); font-family: var(--mono);
    display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;
  }
  @media (max-width: 600px) {
    body { padding: 1.5rem 1rem 3rem; font-size: 14px; }
    .kv-label { min-width: 90px; }
  }
</style>
</head>
<body>
<div class="wrap">
${renderHeader(rootUnit, total)}
${renderOverview(rootUnit, descendants)}
  <section>
    <h2>Work Unit Tree</h2>
    <div class="tree">
${renderDetailsTree(rootUnit, childrenMap, 0)}
    </div>
  </section>
  <div class="footer">
    <span>${esc(rootUnit.id)}</span>
    ${target}
    <span>generated by cw report · ${formatTime(new Date().toISOString())}</span>
  </div>
</div>
</body>
</html>`;
}

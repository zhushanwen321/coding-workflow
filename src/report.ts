/**
 * report.ts — CW topic 可视化报告生成器（纯函数）。
 *
 * 输入：Topic + StatsOutput（computeStats 结果）+ ReportDocs（文档内容，由 cli 读文件传入）。
 * 输出：自包含的暗色 HTML 字符串（内联 CSS，无外部依赖，可离线打开）。
 *
 * 设计：OKLCH 暗色主题，语义状态色（绿=pass / 红=fail / 琥珀=warning）。
 * section 按 CW 流程顺序排列：clarify → plan → tdd → gate → review → retrospect。
 * 文档（review.md / retrospect.md）用 <details> 默认折叠，可展开。
 */

import type { AdrRecord, ClarifyRecord, SpecSection, SpecVersion, Topic } from "./types.js";
import type { StatsOutput } from "./stats.js";

// ── gen-spec（FR-1: 生成确认 md） ────────────────────────────

/**
 * genSpecMd — FR-1: 从 topic 的 clarifyRecords + specSections 生成确认 md。
 *
 * gen-spec 命令调用。md 文件放到 tmpdir，agent open 给用户看。
 * 用户确认后调 cw confirm_clarify。
 */
export function genSpecMd(topic: Topic): string {
  const lines: string[] = [];
  lines.push(`# Spec 确认：${topic.slug}`);
  lines.push("");
  lines.push(`**Objective**: ${topic.objective}`);
  lines.push("");

  // clarifyRecords
  if (topic.clarifyRecords.length > 0) {
    lines.push("## 澄清记录");
    lines.push("");
    for (const c of topic.clarifyRecords) {
      lines.push(`### ${c.id}: ${c.topic} [${c.status}]`);
      lines.push(`- **问题**: ${c.question}`);
      if (c.assessment) lines.push(`- **背景**: ${c.assessment}`);
      if (c.answer) lines.push(`- **结论**: ${c.answer}`);
      lines.push("");
    }
  }

  // specSections
  if (topic.specSections.length > 0) {
    lines.push("## Spec");
    lines.push("");
    for (const section of topic.specSections) {
      lines.push(renderSpecSectionMd(section));
      lines.push("");
    }
  }

  if (topic.clarifyRecords.length === 0 && topic.specSections.length === 0) {
    lines.push("（尚未提交任何澄清记录或 spec 章节）");
  }

  lines.push("---");
  lines.push("确认无误后，请告知 agent 继续。如需修改，告诉 agent 要改什么。");
  return lines.join("\n");
}

/** 渲染单个 SpecSection 为 md 片段。 */
function renderSpecSectionMd(section: SpecSection): string {
  switch (section.type) {
    case "functionalRequirements":
      return "### 功能需求\n\n" +
        section.items.map((fr) => `- **${fr.id}**: ${fr.title} — ${fr.detail}`).join("\n");
    case "acceptanceCriteria":
      return "### 验收标准\n\n" +
        section.items.map((ac) => `- **${ac.id}**: ${ac.condition}${ac.verification ? ` (${ac.verification})` : ""}`).join("\n");
    case "businessCases":
      return "### 业务用例\n\n" +
        section.items.map((uc) => `- **${uc.id}**: ${uc.actor} — ${uc.scenario} → ${uc.expectedResult}`).join("\n");
    case "decisions":
      return "### 决策\n\n" +
        section.items.map((d) => `- **${d.id}**: ${d.decision}（${d.rationale}）`).join("\n");
    case "complexity":
      return `### 复杂度: ${section.rating}\n\n${section.rationale}`;
    case "outOfScope":
      return "### 不做\n\n" + section.items.map((s) => `- ${s}`).join("\n");
    case "goals":
      return "### 目标\n\n" +
        section.items.map((g) => `- **${g.id}**: ${g.goal}（成功标准：${g.successCriteria}）`).join("\n");
    case "background":
      return `### 背景\n\n${section.content}`;
    case "constraints":
      return `### 约束\n\n${section.content}`;
    case "section":
      return `### ${section.sectionName}\n\n${section.content}`;
    default: {
      const _exhaustive: never = section;
      void _exhaustive;
      return "";
    }
  }
}

// ── 类型 ────────────────────────────────────────────────────

/**
 * 报告需要的文档内容。由 cli.ts 从文件系统读取后传入，
 * 保持 generateReport 为纯函数（不读文件）。
 */
export interface ReportDocs {
  /** review.md 的文本内容（如果文件存在）。 */
  reviewDoc?: string;
  /** retrospect.md 的文本内容（如果文件存在）。 */
  retrospectDoc?: string;
  /** clarify 复杂方案文档——key 是 ClarifyRecord.id，value 是文件内容。 */
  clarifyDocs?: Record<string, string>;
  /** ADR 文档——key 是 AdrRecord.id，value 是 docs/adr/xxx.md 的文件内容。 */
  adrDocs?: Record<string, string>;
}

// ── HTML 转义 ────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 将 markdown 粗转为 HTML（不引外部依赖）。
 * 只处理标题、粗体、代码块、列表、段落——足够展示 review.md / retrospect.md。
 */
function mdToHtml(md: string): string {
  const lines = esc(md).split("\n");
  const out: string[] = [];
  let inCode = false;
  let inList = false;

  for (const line of lines) {
    // 代码块围栏
    if (line.trim().startsWith("```")) {
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        if (inList) {
          out.push("</ul>");
          inList = false;
        }
        out.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      const lvl = h[1].length;
      out.push(`<h${lvl + 2}>${h[2]}</h${lvl + 2}>`); // h3-h6，不抢报告主标题
      continue;
    }

    // 列表项
    const li = line.match(/^[\s]*[-*]\s+(.*)/);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${li[1]}</li>`);
      continue;
    }

    // 空行
    if (line.trim() === "") {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      continue;
    }

    // 段落
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    // 行内粗体 **text**
    out.push(`<p>${line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`);
  }
  if (inList) out.push("</ul>");
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

// ── 格式化辅助 ──────────────────────────────────────────────

function formatTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function duration(created: string, closed: string): string {
  if (!created || !closed) return "—";
  const diff = new Date(closed).getTime() - new Date(created).getTime();
  if (diff < 0) return "—";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// ── 各模块渲染 ──────────────────────────────────────────────

function renderHeader(topic: Topic, stats: StatsOutput): string {
  const re = topic.runtimeEnv;
  const env = re ? `${re.agent ?? "?"} · ${re.llm ?? "?"} · cw ${re.cwVersion ?? "?"}` : "";
  const closedAt = topic.evidence?.closedAt ?? "";
  return `
  <header class="header">
    <h1>${esc(topic.slug)}</h1>
    <p class="objective">${esc(topic.objective)}</p>
    <div class="meta">
      ${env ? `<span><b>${esc(env)}</b></span>` : ""}
      <span>complexity: <b>${stats.complexity.level}</b></span>
      <span>created <b>${formatTime(topic.createdAt)}</b></span>
      ${closedAt ? `<span>closed <b>${formatTime(closedAt)}</b></span>` : ""}
      ${closedAt ? `<span>duration <b>${duration(topic.createdAt, closedAt)}</b></span>` : ""}
    </div>
  </header>`;
}

function renderOverview(topic: Topic, stats: StatsOutput): string {
  const eff = stats.efficiency;
  const pills: string[] = [];
  const pill = (dotClass: string, label: string) =>
    `<span class="pill"><span class="dot ${dotClass}"></span>${label}</span>`;

  const ftpValues = Object.values(eff.firstTryPass);
  const ftpRate = ftpValues.length > 0 ? ftpValues.filter(Boolean).length / ftpValues.length : 1;

  pills.push(pill("dot-info", `${topic.waves.length} waves`));
  pills.push(pill("dot-info", `${topic.testCases.length} test cases`));
  pills.push(
    pill(
      ftpRate >= 0.8 ? "dot-pass" : "dot-warn",
      `${Math.round(ftpRate * 100)}% first-try pass`,
    ),
  );
  if (eff.totalGateFails > 0) {
    pills.push(pill("dot-warn", `${eff.totalGateFails} gate fail${eff.totalGateFails > 1 ? "s" : ""}`));
  } else {
    pills.push(pill("dot-pass", "0 gate fails"));
  }
  const redLight = stats.leverHealth.find((l) => l.lever.includes("red-light") || l.gate === "tdd-red-light");
  pills.push(
    pill(
      redLight?.status === "pass" ? "dot-pass" : "dot-fail",
      `TDD red-light ${redLight?.status === "pass" ? "confirmed" : "not confirmed"}`,
    ),
  );
  pills.push(pill(eff.devRetryCount > 0 ? "dot-warn" : "dot-pass", `${eff.devRetryCount} dev retries`));
  pills.push(pill(eff.testRetryCount > 0 ? "dot-warn" : "dot-pass", `${eff.testRetryCount} test retries`));

  return `
  <section>
    <h2>Overview</h2>
    <div class="overview">${pills.join("")}</div>
  </section>`;
}

// ── Clarify + ADR ───────────────────────────────────────────

function renderClarify(topic: Topic, docs: ReportDocs): string {
  const records = topic.clarifyRecords ?? [];
  const adrs = topic.adrs ?? [];
  if (records.length === 0 && adrs.length === 0) {
    return "";
  }

  // 结构化澄清记录
  const recordItems = records
    .map((r: ClarifyRecord) => {
      const kindBadge =
        r.kind === "technical" ? '<span class="badge b-info">technical</span>' : '<span class="badge b-warn">requirement</span>';
      const statusBadge =
        r.status === "resolved"
          ? '<span class="badge b-pass">resolved</span>'
          : r.status === "skipped"
            ? '<span class="badge b-muted">skipped</span>'
            : '<span class="badge b-warn">pending</span>';
      const opts = (r.options ?? [])
        .map(
          (o) =>
            `<span class="opt ${r.recommendation === o.id ? "opt-rec" : ""}">${esc(o.label)}${o.tradeoff ? ` <em>${esc(o.tradeoff)}</em>` : ""}</span>`,
        )
        .join("");
      // 复杂方案文档（presentationPath）——如果有内容，渲染为折叠组件
      const presentDoc = docs.clarifyDocs?.[r.id];
      const presentBlock = presentDoc
        ? renderDocArtifact("Clarify Document", presentDoc, r.presentationPath, undefined)
        : r.presentationPath
          ? `\n        <p class="muted-note">presentationPath: <code>${esc(r.presentationPath)}</code>（文件未找到）</p>`
          : "";

      return `      <div class="clarify-item">
        <div class="clarify-head">
          ${kindBadge} ${statusBadge}
          <span class="clarify-topic">${esc(r.topic)}</span>
        </div>
        <div class="clarify-q"><strong>Q:</strong> ${esc(r.question)}</div>
        <div class="clarify-a"><strong>Assessment:</strong> ${esc(r.assessment)}</div>
        ${opts ? `<div class="clarify-opts">${opts}</div>` : ""}
        ${r.answer ? `<div class="clarify-answer"><strong>A:</strong> ${esc(r.answer)}</div>` : ""}
        ${presentBlock}
      </div>`;
    })
    .join("\n");

  // ADR 记录
  const adrItems = adrs
    .map((a: AdrRecord) => {
      const statusBadge =
        a.status === "accepted"
          ? '<span class="badge b-pass">accepted</span>'
          : '<span class="badge b-warn">proposed</span>';
      const alts = (a.alternatives ?? []).map((alt) => `<li>${esc(alt)}</li>`).join("");
      // ADR 文档（projectPath）——如果有内容，渲染为折叠组件
      const adrDoc = docs.adrDocs?.[a.id];
      const adrDocBlock = adrDoc
        ? renderDocArtifact("ADR Document", adrDoc, a.projectPath, undefined)
        : "";
      return `      <details class="adr-item">
        <summary><code>${esc(a.id)}</code> ${esc(a.title)} ${statusBadge}</summary>
        <div class="adr-body">
          <p><strong>Context:</strong> ${esc(a.context)}</p>
          <p><strong>Decision:</strong> ${esc(a.decision)}</p>
          ${alts ? `<div><strong>Alternatives:</strong><ul>${alts}</ul></div>` : ""}
          <p><strong>Consequences:</strong> ${esc(a.consequences)}</p>
          ${a.projectPath ? `<p class="adr-path"><code>${esc(a.projectPath)}</code></p>` : ""}
        </div>
        ${adrDocBlock}
      </details>`;
    })
    .join("\n");

  return `
  <section>
    <h2>Clarify & ADR</h2>
    ${recordItems ? `<div class="clarify-list">
${recordItems}
    </div>` : '<p class="muted-note">No clarify records.</p>'}
    ${adrItems ? `<h3 class="sub-h" style="margin-top:1.25rem">Architecture Decisions</h3>
${adrItems}` : ""}
  </section>`;
}

// ── Spec（结构化 spec 章节） ────────────────────────────────

function renderSpec(topic: Topic): string {
  const sections = topic.specSections ?? [];
  const history = topic.specHistory ?? [];
  if (sections.length === 0 && history.length === 0) return "";

  // 按固定顺序分组（不管提交顺序）
  const getByType = <T extends SpecSection["type"]>(type: T) =>
    sections.filter((s): s is Extract<SpecSection, { type: T }> => s.type === type);

  const parts: string[] = [];

  // 1. background（md → mdToHtml）
  for (const bg of getByType("background")) {
    parts.push(`<div class="spec-md">${mdToHtml(bg.content)}</div>`);
  }

  // 2. goals（结构化表格）
  const goals = sections.find((s): s is Extract<SpecSection, { type: "goals" }> => s.type === "goals");
  if (goals) {
    parts.push(`<h3 class="sub-h">Goals</h3><table><thead><tr><th>ID</th><th>Goal</th><th>Success Criteria</th></tr></thead><tbody>`);
    for (const g of goals.items) {
      parts.push(`<tr><td><code>${esc(g.id)}</code></td><td>${esc(g.goal)}</td><td>${esc(g.successCriteria)}</td></tr>`);
    }
    parts.push(`</tbody></table>`);
  }

  // 3. functionalRequirements（表格列：ID / Title / Detail，detail 用 mdToHtml）
  const frs = sections.find(
    (s): s is Extract<SpecSection, { type: "functionalRequirements" }> => s.type === "functionalRequirements",
  );
  if (frs) {
    parts.push(`<h3 class="sub-h">Functional Requirements</h3><table><thead><tr><th>ID</th><th>Title</th><th>Detail</th></tr></thead><tbody>`);
    for (const fr of frs.items) {
      parts.push(`<tr><td><code>${esc(fr.id)}</code></td><td>${esc(fr.title)}</td><td><div class="spec-md">${mdToHtml(fr.detail)}</div></td></tr>`);
    }
    parts.push(`</tbody></table>`);
  }

  // 4. acceptanceCriteria（表格列：ID / Condition / Verification badge）
  const acs = sections.find(
    (s): s is Extract<SpecSection, { type: "acceptanceCriteria" }> => s.type === "acceptanceCriteria",
  );
  if (acs) {
    parts.push(`<h3 class="sub-h">Acceptance Criteria</h3><table><thead><tr><th>ID</th><th>Condition</th><th>Verification</th></tr></thead><tbody>`);
    for (const ac of acs.items) {
      const vBadge = ac.verification
        ? `<span class="badge b-info">${esc(ac.verification)}</span>`
        : `<span class="muted-note">—</span>`;
      parts.push(`<tr><td><code>${esc(ac.id)}</code></td><td>${esc(ac.condition)}</td><td>${vBadge}</td></tr>`);
    }
    parts.push(`</tbody></table>`);
  }

  // 5. businessCases（卡片列表：UC id + actor + scenario + expectedResult）
  const ucs = sections.find(
    (s): s is Extract<SpecSection, { type: "businessCases" }> => s.type === "businessCases",
  );
  if (ucs) {
    const cards = ucs.items
      .map(
        (uc) => `      <div class="spec-card">
        <div class="spec-card-head">
          <code>${esc(uc.id)}</code>
          <span class="badge b-info">${esc(uc.actor)}</span>
        </div>
        <p><strong>Scenario:</strong> ${esc(uc.scenario)}</p>
        <p class="muted-note"><strong>Expected:</strong> ${esc(uc.expectedResult)}</p>
      </div>`,
      )
      .join("\n");
    parts.push(`<h3 class="sub-h">Business Cases</h3><div class="spec-card-list">
${cards}
    </div>`);
  }

  // 6. decisions（表格列：ID / Decision / Rationale）
  const decs = sections.find(
    (s): s is Extract<SpecSection, { type: "decisions" }> => s.type === "decisions",
  );
  if (decs) {
    parts.push(`<h3 class="sub-h">Decisions</h3><table><thead><tr><th>ID</th><th>Decision</th><th>Rationale</th></tr></thead><tbody>`);
    for (const d of decs.items) {
      parts.push(`<tr><td><code>${esc(d.id)}</code></td><td>${esc(d.decision)}</td><td>${esc(d.rationale)}</td></tr>`);
    }
    parts.push(`</tbody></table>`);
  }

  // 7. constraints（md → mdToHtml）
  for (const c of getByType("constraints")) {
    parts.push(`<h3 class="sub-h">Constraints</h3><div class="spec-md">${mdToHtml(c.content)}</div>`);
  }

  // 8. complexity（rating badge + rationale md）
  const complexity = sections.find(
    (s): s is Extract<SpecSection, { type: "complexity" }> => s.type === "complexity",
  );
  if (complexity) {
    const ratingClass =
      complexity.rating === "high" ? "b-fail" : complexity.rating === "medium" ? "b-warn" : "b-pass";
    parts.push(`<h3 class="sub-h">Complexity</h3><div class="spec-md"><p><span class="badge ${ratingClass}">${esc(complexity.rating)}</span></p>${mdToHtml(complexity.rationale)}</div>`);
  }

  // 9. outOfScope（列表）
  const oos = sections.find(
    (s): s is Extract<SpecSection, { type: "outOfScope" }> => s.type === "outOfScope",
  );
  if (oos) {
    const items = oos.items.map((i) => `<li>${esc(i)}</li>`).join("\n");
    parts.push(`<h3 class="sub-h">Out of Scope</h3><ul class="spec-list">
${items}
    </ul>`);
  }

  // 10. section 兜底（md → mdToHtml，每个用 <details> 折叠，sectionName 做 summary）
  for (const sec of getByType("section")) {
    parts.push(`<details class="spec-section-item">
      <summary>${esc(sec.sectionName)}</summary>
      <div class="spec-md">${mdToHtml(sec.content)}</div>
    </details>`);
  }

  // 11. specHistory 变更日志（spec 替换归档记录）
  if (history.length > 0) {
    parts.push(renderSpecHistory(history));
  }

  return `
  <section>
    <h2>Spec</h2>
    ${parts.join("\n")}
  </section>`;
}

/**
 * renderSpecHistory — 渲染 spec 变更历史日志。
 *
 * 每次 replaceSpecSections 时，旧 specSections 整体快照推入 specHistory，
 * version 自增。这里渲染为时间线：版本号 + 归档时间 + 替换原因 + 章节数。
 */
function renderSpecHistory(history: SpecVersion[]): string {
  const items = history
    .map((v) => {
      const sectionCount = v.sections.length;
      return `      <div class="spec-history-item">
        <div class="spec-history-head">
          <span class="badge b-muted">v${esc(String(v.version))}</span>
          <span class="spec-history-time">${esc(formatTime(v.archivedAt))}</span>
          <span class="spec-history-count">${sectionCount} section${sectionCount !== 1 ? "s" : ""}</span>
        </div>
        ${v.reason ? `<p class="spec-history-reason">${esc(v.reason)}</p>` : ""}
      </div>`;
    })
    .join("\n");

  return `<h3 class="sub-h">Spec 变更历史</h3><div class="spec-history-list">
${items}
    </div>`;
}

// ── Gate trail ──────────────────────────────────────────────

function renderGateTrail(topic: Topic): string {
  const steps = topic.gateHistory
    .map((g) => {
      const isFail = g.result === "fail";
      return `      <div class="gate-step ${isFail ? "fail" : "pass"}">
        <span class="act">${esc(g.action)}</span>
        <span class="gname">${esc(g.gate)}</span>
        <span class="gstat">${g.result}</span>
      </div>`;
    })
    .join("\n");

  return `
  <section>
    <h2>Gate Execution Trail</h2>
    <div class="trail">
${steps}
    </div>
  </section>`;
}

function renderWaves(topic: Topic): string {
  const rows: string[] = [];
  let currentWave = "";
  for (const w of topic.waves) {
    const waveLabel = w.id !== currentWave ? w.id : "";
    currentWave = w.id;
    const status = w.committed
      ? `<span class="badge b-pass">committed</span>`
      : `<span class="badge b-muted">pending</span>`;
    const changes = w.changes ?? [];
    if (changes.length === 0) {
      rows.push(
        `        <tr><td>${esc(waveLabel)}</td><td>${status}</td><td colspan="2"><span class="muted-note">no changes recorded</span></td></tr>`,
      );
    }
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i];
      rows.push(
        `        <tr><td>${i === 0 ? esc(waveLabel) : ""}</td><td>${i === 0 ? status : ""}</td><td><code>${esc(c.file)}</code></td><td>${esc(c.description)}</td></tr>`,
      );
    }
  }

  return `
  <section>
    <h2>Plan — Wave Changes</h2>
    <table>
      <thead><tr><th style="width:50px">Wave</th><th style="width:70px">Status</th><th>File</th><th>Description</th></tr></thead>
      <tbody>
${rows.join("\n")}
      </tbody>
    </table>
  </section>`;
}

function renderTestCases(topic: Topic): string {
  const rows = topic.testCases
    .map((tc) => {
      const badge =
        tc.status === "passed"
          ? '<span class="badge b-pass">passed</span>'
          : tc.status === "failed"
            ? '<span class="badge b-fail">failed</span>'
            : '<span class="badge b-muted">pending</span>';
      const expected = tc.expected.text ?? tc.expected.url ?? "—";
      const actual =
        tc.actual && typeof tc.actual === "object" && "text" in tc.actual
          ? String((tc.actual as Record<string, unknown>).text ?? "—")
          : tc.actual && typeof tc.actual === "object" && "url" in tc.actual
            ? String((tc.actual as Record<string, unknown>).url ?? "—")
            : "—";
      return `        <tr><td><code>${esc(tc.id)}</code></td><td>${esc(tc.layer)}</td><td>${esc(tc.scenario)}</td><td>${badge}</td><td><code>${esc(String(expected))}</code></td><td><code>${esc(actual)}</code></td></tr>`;
    })
    .join("\n");

  return `
  <section>
    <h2>TDD — Test Cases</h2>
    <table>
      <thead><tr><th style="width:50px">ID</th><th style="width:50px">Layer</th><th>Scenario</th><th style="width:60px">Status</th><th>Expected</th><th>Actual</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>`;
}

function renderReviewIssues(topic: Topic): string {
  if (!topic.reviewIssues || topic.reviewIssues.length === 0) {
    return "";
  }
  const rows = topic.reviewIssues
    .map((issue) => {
      const sevClass =
        issue.severity === "must-fix" ? "b-fail" : issue.severity === "should-fix" ? "b-warn" : "b-muted";
      const status =
        issue.status === "fixed"
          ? '<span class="badge b-pass">fixed</span>'
          : '<span class="badge b-warn">open</span>';
      return `        <tr><td><code>${esc(issue.id)}</code></td><td><span class="badge ${sevClass}">${esc(issue.severity)}</span></td><td>${esc(issue.description)}</td><td>${issue.file ? `<code>${esc(issue.file)}</code>` : "—"}</td><td>${status}</td></tr>`;
    })
    .join("\n");

  return `
  <section>
    <h2>Review Issues</h2>
    <table>
      <thead><tr><th style="width:50px">ID</th><th style="width:75px">Severity</th><th>Description</th><th>File</th><th style="width:55px">Status</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>`;
}

function renderDocArtifact(label: string, docContent: string | undefined, docPath: string | undefined, docAt: string | undefined): string {
  if (!docContent) {
    return "";
  }
  const meta = docPath ? `<span class="doc-path"><code>${esc(docPath)}</code></span>` : "";
  const time = docAt ? `<span>${formatTime(docAt)}</span>` : "";
  return `
    <details class="doc-artifact">
      <summary>${esc(label)} ${meta} ${time}</summary>
      <div class="doc-body">${mdToHtml(docContent)}</div>
    </details>`;
}

function renderRetrospect(topic: Topic): string {
  const rd = topic.retrospectData;

  // 结构化部分（always render if retrospectData exists）
  let structuredPart = "";
  if (rd) {
    const risks = (rd.knownRisks ?? [])
      .map((r) => {
        const sevClass = r.severity === "high" ? "b-fail" : r.severity === "medium" ? "b-warn" : "b-info";
        return `      <div class="risk">
        <div class="risk-head">
          <span class="badge ${sevClass}">${esc(r.severity)}</span>
          <span class="risk-area">${esc(r.area)}</span>
          ${r.unverified ? '<span class="badge b-warn">unverified</span>' : ""}
        </div>
        <p class="risk-desc">${esc(r.description)}</p>
      </div>`;
      })
      .join("\n");

    const issues = (rd.processIssues ?? [])
      .map((issue) => `      <li><span class="badge b-warn">process</span><span>${esc(issue)}</span></li>`)
      .join("\n");

    structuredPart = `
    <h3 class="sub-h">Known Risks</h3>
    <div class="risk-list">
${risks || '      <p class="muted-note">No risks recorded.</p>'}
    </div>
    <h3 class="sub-h">Process Issues</h3>
    <ul class="issue-list">
${issues || '      <li class="muted-note">No process issues recorded.</li>'}
    </ul>`;
  } else {
    structuredPart = '<p class="muted-note">No retrospect data recorded.</p>';
  }

  return `
  <section>
    <h2>Retrospect</h2>
${structuredPart}
  </section>`;
}

// ── 主函数 ──────────────────────────────────────────────────

/**
 * generateReport — 从 topic + stats + docs 生成自包含暗色 HTML 报告。
 *
 * 纯函数：不读文件、不写文件、不执行子进程。
 * 文档内容（review.md / retrospect.md）由调用方读取后通过 docs 参数传入。
 */
export function generateReport(topic: Topic, stats: StatsOutput, docs?: ReportDocs): string {
  const safeDocs = docs ?? {};
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CW Report — ${esc(topic.slug)}</title>
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
  .wrap { max-width: 880px; margin: 0 auto; }
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
  h4 { font-size: 0.9rem; font-weight: 600; color: var(--ink); margin: 0.75rem 0 0.35rem; }
  h5 { font-size: 0.85rem; font-weight: 600; color: var(--muted); margin: 0.5rem 0 0.25rem; }
  h6 { font-size: 0.8rem; font-weight: 500; color: var(--muted); margin: 0.5rem 0 0.25rem; }
  .sub-h {
    margin-bottom: 0.5rem;
    font-size: 0.85rem; color: var(--muted); font-weight: 500;
    text-transform: none; letter-spacing: 0;
    border: none; padding: 0;
  }
  code { font-family: var(--mono); font-size: 0.85em; color: var(--info); }
  p { margin-bottom: 0.4rem; }
  strong { color: var(--ink-strong); font-weight: 600; }
  em { color: var(--muted); font-size: 0.85em; }
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
  .trail { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .gate-step {
    display: flex; flex-direction: column; gap: 0.15rem;
    padding: 0.4rem 0.6rem; border-radius: 5px;
    border: 1px solid var(--border); background: var(--surface);
    min-width: fit-content; font-size: 0.78rem;
  }
  .gate-step.fail { border-color: var(--fail); background: var(--fail-bg); }
  .gate-step .act { font-weight: 600; color: var(--ink); }
  .gate-step .gname { font-family: var(--mono); font-size: 0.72rem; color: var(--muted); }
  .gate-step .gstat { font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .gate-step.pass .gstat { color: var(--pass); }
  .gate-step.fail .gstat { color: var(--fail); }
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

  /* ── Clarify ─────────────────────────────────────────── */
  .clarify-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .clarify-item {
    padding: 0.65rem 0.8rem; border-radius: 6px;
    background: var(--surface); border: 1px solid var(--border);
  }
  .clarify-head {
    display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.4rem; flex-wrap: wrap;
  }
  .clarify-topic { font-weight: 600; color: var(--ink); font-size: 0.88rem; }
  .clarify-q, .clarify-a { font-size: 0.82rem; margin-bottom: 0.2rem; }
  .clarify-a { color: var(--muted); }
  .clarify-answer { font-size: 0.85rem; color: var(--ink); margin-top: 0.3rem; }
  .clarify-opts { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.35rem; }
  .opt {
    padding: 0.2rem 0.5rem; border-radius: 4px;
    font-size: 0.78rem; background: var(--surface-2); border: 1px solid var(--border-soft);
  }
  .opt-rec { border-color: var(--info); background: var(--info-bg); }
  .opt em { color: var(--faint); }

  /* ── ADR ─────────────────────────────────────────────── */
  .adr-item {
    margin-bottom: 0.5rem;
    border: 1px solid var(--border); border-radius: 6px;
    background: var(--surface); overflow: hidden;
  }
  .adr-item > summary {
    padding: 0.5rem 0.75rem; cursor: pointer;
    font-size: 0.85rem; font-weight: 500; color: var(--ink);
    display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
    list-style: none;
  }
  .adr-item > summary::-webkit-details-marker { display: none; }
  .adr-item > summary::before { content: "\\25B8"; color: var(--faint); font-size: 0.7rem; }
  .adr-item[open] > summary::before { content: "\\25BE"; }
  .adr-body { padding: 0.5rem 0.75rem 0.65rem; font-size: 0.83rem; }
  .adr-body ul { margin: 0.2rem 0 0.4rem 1.2rem; }
  .adr-path { margin-top: 0.3rem; }

  /* ── Spec ───────────────────────────────────────────── */
  .spec-md { padding: 0.3rem 0; font-size: 0.85rem; }
  .spec-md p { margin-bottom: 0.4rem; }
  .spec-md table { margin: 0.4rem 0; }
  .spec-card-list { display: flex; flex-direction: column; gap: 0.6rem; }
  .spec-card {
    padding: 0.6rem 0.8rem; border-radius: 6px;
    background: var(--surface); border: 1px solid var(--border);
  }
  .spec-card-head {
    display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.35rem; flex-wrap: wrap;
  }
  .spec-card p { font-size: 0.84rem; margin-bottom: 0.25rem; }
  .spec-list { margin: 0.2rem 0 0.4rem 1.2rem; }
  .spec-list li { font-size: 0.85rem; margin-bottom: 0.2rem; }
  .spec-section-item {
    margin-bottom: 0.5rem;
    border: 1px solid var(--border); border-radius: 6px;
    background: var(--surface); overflow: hidden;
  }
  .spec-section-item > summary {
    padding: 0.5rem 0.75rem; cursor: pointer;
    font-size: 0.85rem; font-weight: 500; color: var(--ink);
    list-style: none;
  }
  .spec-section-item > summary::-webkit-details-marker { display: none; }
  .spec-section-item > summary::before { content: "\\25B8"; color: var(--faint); font-size: 0.7rem; margin-right: 0.4rem; }
  .spec-section-item[open] > summary::before { content: "\\25BE"; }
  .spec-section-item .spec-md { padding: 0.5rem 0.8rem 0.65rem; border-top: 1px solid var(--border-soft); }

  /* ── Spec history（变更日志） ──────────────────────── */
  .spec-history-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .spec-history-item {
    padding: 0.55rem 0.75rem; border-radius: 6px;
    background: var(--surface); border: 1px solid var(--border-soft);
    border-left: 3px solid var(--border);
  }
  .spec-history-head {
    display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
    font-size: 0.82rem;
  }
  .spec-history-time {
    font-family: var(--mono); font-size: 0.76rem; color: var(--muted);
  }
  .spec-history-count { font-size: 0.76rem; color: var(--faint); }
  .spec-history-reason {
    font-size: 0.82rem; color: var(--muted); margin-top: 0.3rem; margin-bottom: 0;
  }

  /* ── Doc artifact（折叠文档） ───────────────────────── */
  .doc-artifact {
    margin-bottom: 0.6rem;
    border: 1px solid var(--border); border-radius: 6px;
    background: var(--surface); overflow: hidden;
  }
  .doc-artifact > summary {
    padding: 0.5rem 0.75rem; cursor: pointer;
    font-size: 0.85rem; font-weight: 500; color: var(--ink);
    display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
    list-style: none;
  }
  .doc-artifact > summary::-webkit-details-marker { display: none; }
  .doc-artifact > summary::before { content: "\\25B8"; color: var(--faint); font-size: 0.7rem; }
  .doc-artifact[open] > summary::before { content: "\\25BE"; }
  .doc-path { font-size: 0.75rem; color: var(--faint); }
  .doc-body {
    padding: 0.65rem 0.8rem; border-top: 1px solid var(--border-soft);
    font-size: 0.84rem; line-height: 1.65; color: var(--muted);
    max-height: 400px; overflow-y: auto;
  }
  .doc-body p { margin-bottom: 0.45rem; }
  .doc-body ul { margin: 0.3rem 0 0.5rem 1.2rem; }
  .doc-body li { margin-bottom: 0.15rem; }
  .doc-body pre {
    background: var(--bg); border: 1px solid var(--border-soft);
    border-radius: 4px; padding: 0.5rem 0.65rem; overflow-x: auto;
    margin: 0.4rem 0;
  }
  .doc-body pre code { color: var(--ink); font-size: 0.8rem; }

  /* ── Retrospect ──────────────────────────────────────── */
  .risk-list { display: flex; flex-direction: column; gap: 0.6rem; }
  .risk { padding: 0.65rem 0.8rem; border-radius: 6px; background: var(--surface); border: 1px solid var(--border); }
  .risk-head { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; flex-wrap: wrap; }
  .risk-area { font-family: var(--mono); font-size: 0.8rem; color: var(--ink); font-weight: 500; }
  .risk-desc { font-size: 0.85rem; color: var(--muted); }
  .issue-list { list-style: none; }
  .issue-list li {
    padding: 0.5rem 0; border-bottom: 1px solid var(--border-soft);
    font-size: 0.85rem; display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap;
  }
  .issue-list li:last-child { border-bottom: none; }
  .muted-note { color: var(--faint); font-size: 0.85rem; font-style: italic; }
  .footer {
    margin-top: 3rem; padding-top: 1.25rem;
    border-top: 1px solid var(--border);
    font-size: 0.78rem; color: var(--faint); font-family: var(--mono);
    display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;
  }
  @media (max-width: 600px) {
    body { padding: 1.5rem 1rem 3rem; font-size: 14px; }
    .gate-step { font-size: 0.72rem; }
  }
</style>
</head>
<body>
<div class="wrap">
${renderHeader(topic, stats)}
${renderOverview(topic, stats)}
${renderClarify(topic, safeDocs)}
${renderSpec(topic)}
${renderWaves(topic)}
${renderTestCases(topic)}
${renderGateTrail(topic)}
${renderReviewIssues(topic)}
${renderDocArtifact("Review Report", safeDocs.reviewDoc, topic.artifacts?.reviewPath, topic.artifacts?.reviewAt)}
${renderRetrospect(topic)}
${renderDocArtifact("Retrospect Report", safeDocs.retrospectDoc, topic.artifacts?.retrospectPath, topic.artifacts?.retrospectAt)}
  <div class="footer">
    <span>${esc(topic.topicId)}</span>
    <span>generated by cw report · ${formatTime(new Date().toISOString())}</span>
  </div>
</div>
</body>
</html>`;
}

/**
 * report.ts — CW topic 可视化报告生成器（纯函数）。
 *
 * 输入：Topic + StatsOutput（computeStats 结果）。
 * 输出：自包含的暗色 HTML 字符串（内联 CSS，无外部依赖，可离线打开）。
 *
 * 设计：OKLCH 暗色主题，语义状态色（绿=pass / 红=fail / 琥珀=warning）。
 * 复用 stats.ts 的三层指标，不重新计算。
 */

import type { Topic } from "./types.js";
import type { StatsOutput } from "./stats.js";

// ── HTML 转义 ────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

  // firstTryPassRate 从 firstTryPass Record 手动算
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
  // TDD red-light
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
    <h2>Wave Changes</h2>
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
          ? `<span class="badge b-pass">passed</span>`
          : tc.status === "failed"
            ? `<span class="badge b-fail">failed</span>`
            : `<span class="badge b-muted">pending</span>`;
      const expected = tc.expected.text ?? tc.expected.url ?? "—";
      const actual =
        tc.actual && typeof tc.actual === "object" && "text" in tc.actual
          ? String((tc.actual as Record<string, unknown>).text ?? "—")
          : tc.actual && typeof tc.actual === "object" && "url" in tc.actual
            ? String((tc.actual as Record<string, unknown>).url ?? "—")
            : "—";
      return `        <tr><td><code>${esc(tc.id)}</code></td><td>${esc(tc.layer)}</td><td>${badge}</td><td>${esc(tc.scenario || "—")}</td><td><code>${esc(String(expected))}</code></td><td><code>${esc(actual)}</code></td></tr>`;
    })
    .join("\n");

  return `
  <section>
    <h2>Test Cases</h2>
    <table>
      <thead><tr><th style="width:50px">ID</th><th style="width:50px">Layer</th><th style="width:60px">Status</th><th>Scenario</th><th>Expected</th><th>Actual</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>`;
}

function renderRetrospect(topic: Topic): string {
  const rd = topic.retrospectData;
  if (!rd) {
    return `
  <section>
    <h2>Retrospect</h2>
    <p class="muted-note">No retrospect data recorded.</p>
  </section>`;
  }

  const risks = (rd.knownRisks ?? [])
    .map((r) => {
      const sevClass = r.severity === "high" ? "b-fail" : r.severity === "medium" ? "b-warn" : "b-info";
      return `      <div class="risk">
        <div class="risk-head">
          <span class="badge ${sevClass}">${esc(r.severity)}</span>
          <span class="risk-area">${esc(r.area)}</span>
          ${r.unverified ? `<span class="badge b-warn">unverified</span>` : ""}
        </div>
        <p class="risk-desc">${esc(r.description)}</p>
      </div>`;
    })
    .join("\n");

  const issues = (rd.processIssues ?? [])
    .map((issue) => `      <li><span class="badge b-warn">process</span><span>${esc(issue)}</span></li>`)
    .join("\n");

  return `
  <section>
    <h2>Retrospect</h2>
    <h3 class="sub-h">Known Risks</h3>
    <div class="risk-list">
${risks || `      <p class="muted-note">No risks recorded.</p>`}
    </div>
    <h3 class="sub-h">Process Issues</h3>
    <ul class="issue-list">
${issues || `      <li class="muted-note">No process issues recorded.</li>`}
    </ul>
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
          ? `<span class="badge b-pass">fixed</span>`
          : `<span class="badge b-warn">open</span>`;
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

// ── 主函数 ──────────────────────────────────────────────────

/**
 * generateReport — 从 topic + stats 生成自包含暗色 HTML 报告。
 *
 * 纯函数：不读文件、不写文件、不执行子进程。
 * 调用方（cli.ts）负责写入临时文件并打开浏览器。
 */
export function generateReport(topic: Topic, stats: StatsOutput): string {
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
  .sub-h {
    margin-bottom: 0.5rem;
    font-size: 0.85rem; color: var(--muted); font-weight: 500;
    text-transform: none; letter-spacing: 0;
    border: none; padding: 0;
  }
  code { font-family: var(--mono); font-size: 0.85em; color: var(--info); }
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
${renderGateTrail(topic)}
${renderWaves(topic)}
${renderTestCases(topic)}
${renderReviewIssues(topic)}
${renderRetrospect(topic)}
  <div class="footer">
    <span>${esc(topic.topicId)}</span>
    <span>generated by cw report · ${formatTime(new Date().toISOString())}</span>
  </div>
</div>
</body>
</html>`;
}

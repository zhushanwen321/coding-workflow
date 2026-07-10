/**
 * lite-plan 机器结构验证（移植自 skills/lite-plan/scripts/check_plan.py）。
 *
 * 入参：topicDir（含 plan.md 在根目录，不是子目录）。
 *
 * 检查项（对应 5b 方案审查路 + 测试审查路的机器可判子集）：
 *   ① 结构性（交付物完整度）
 *      - plan.md 存在
 *      - 6 必须章节齐全（业务目标/技术改动点/Wave 拆分/单测/E2E/覆盖率gate）
 *      - 「## 实现步骤」标题存在（plan extension extractPlanSteps 桥接依赖）
 *      - 无未替换占位符（{xxx}/TODO/TBD）
 *   ② 方案结构（Wave 表完整性）
 *      - Wave 表存在且至少 1 行
 *      - 同并行组 Wave 改动文件无交集（并行安全）
 *   ③ 测试清单结构（机器可判的完整性）
 *      - 单测每行有具体输入 + 预期（列非空，非「正常工作」类模糊词）
 *      - 每个技术改动点至少 1 条单测（改动点 vs 单测覆盖对照的机器侧）
 *      - E2E 每条标 mock/real，两层各 ≥1
 *      - 覆盖率 gate 命令存在 + 阈值 ≥60%
 */

import { basename, join } from "node:path";

import {
  checkFileExists,
  checkNoPlaceholders,
  type CheckOutput,
  CheckReport,
  extractSection,
  hasHeading,
} from "./shared.js";

const DELIVERABLE = "plan.md";

/** markdown 表格最小可解析列数（Wave 表: Wave|文件 = 2 列）。 */
const MIN_TABLE_COLS = 2;
/** 单测表最小可解析列数（ID|覆盖点|输入|预期 = 4 列）。 */
const MIN_UNITTEST_COLS = 4;
/** 覆盖率阈值下限（业务要求 ≥60%）。 */
const COVERAGE_THRESHOLD_MIN = 60;
/** 报错清单显示截断（避免单条报错过长）。 */
const ERR_LIST_MAX = 5;
/** 报错清单短截断（错误摘要更紧凑）。 */
const ERR_LIST_SHORT = 3;
/** 预期列截断长度（模糊词报错只展示前缀）。 */
const VAGUE_PREVIEW_LEN = 30;

// plan.md 6 必须章节（heading 正则片段，extract_section/has_heading 用）
const REQUIRED_SECTIONS = [
  "业务目标",
  "技术改动点",
  "Wave\\s*拆分与依赖|Wave\\s*拆分",
  "单测用例清单|单测清单",
  "E2E\\s*用例清单|E2E\\s*清单",
  "覆盖率\\s*gate|覆盖率",
] as const;

// plan extension extractPlanSteps 唯一识别的标题
const IMPL_STEPS_HEADING = "实现步骤";

// 模糊测试断言词（不可机器判定）——来自 test-case-schema.md「不可判定症状检测」
const VAGUE_WORDS = /正常工作|行为正确|大概|应该返回|让我看代码|这取决于/;

interface WaveRow {
  wave: string;
  files: Set<string>;
  group: string;
  deps: string;
}

export function runCheckPlan(topicDir: string): CheckOutput {
  const report = new CheckReport("plan");
  const mdPath = join(topicDir, DELIVERABLE);

  // ① 结构性：交付物存在（不存在则提前返回）
  if (!checkFileExists(report, `${DELIVERABLE} 存在`, mdPath)) {
    return report.toOutput({ writeReport: true, topicDir });
  }

  // ① 结构性
  checkRequiredSections(report, mdPath);
  checkImplStepsHeading(report, mdPath);
  checkNoPlaceholders(report, "无占位符", mdPath);

  // ② 方案结构
  checkWaveTable(report, mdPath);
  checkParallelSafety(report, mdPath);

  // ③ 测试清单结构
  checkTestMachineJudgable(report, mdPath);
  checkTestCoverageOfChanges(report, mdPath);
  checkE2eTestLayer(report, mdPath);
  checkCoverageGate(report, mdPath);

  return report.toOutput({ writeReport: true, topicDir });
}

// ── ① 结构性 ────────────────────────────────────────────────────

/**
 * ① 6 必须章节齐全。
 *
 * 与 shared.checkRequiredSections 不同：这里收集具体缺失清单（含正则表达），
 * 与 python check_plan.py 对齐（不调 shared 同名函数）。
 */
function checkRequiredSections(report: CheckReport, mdPath: string): void {
  const missing = REQUIRED_SECTIONS.filter((h) => !hasHeading(mdPath, h));
  if (missing.length > 0) {
    report.addFail(
      "6 必须章节",
      `缺失: ${JSON.stringify([...missing])}；6 个必须章节需用确切标题：业务目标 / 技术改动点 / Wave 拆分 / 单测用例清单 / E2E 用例清单 / 覆盖率 gate，缺一不可`,
    );
  } else {
    report.addPass("6 必须章节", "业务目标/技术改动点/Wave/单测/E2E/覆盖率 全在");
  }
}

/** ① 「## 实现步骤」标题存在（plan extension 桥接硬依赖）。 */
function checkImplStepsHeading(report: CheckReport, mdPath: string): void {
  if (hasHeading(mdPath, IMPL_STEPS_HEADING)) {
    report.addPass("实现步骤标题", "plan→goal 桥接可识别");
  } else {
    report.addFail(
      "实现步骤标题",
      "缺「## 实现步骤」——plan extension extractPlanSteps 无法提取步骤；必须用确切标题 `## 实现步骤`，其他变体（如 `## 实现计划` / `## 实施步骤`）不被识别",
    );
  }
}

// ── ② 方案结构 ──────────────────────────────────────────────────

/**
 * 解析 Wave 表，返回 [{wave, files, group, deps}, ...]。
 *
 * Wave 表格式（plan-template.md）：
 *   | Wave | 改动文件 | 依赖 | 并行组 | 说明 |
 *   | W1   | a.ts,b.ts| W0   | G1    | ...  |
 */
function parseWaveTable(mdPath: string): WaveRow[] {
  const section = extractSection(mdPath, "Wave\\s*拆分|Wave\\s*表") ?? "";
  const rows: WaveRow[] = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
    if (cells.length < MIN_TABLE_COLS) continue;
    const first = cells[0]!;
    // 跳过表头/分隔行
    if (/^-+:?$/.test(first) || first.toLowerCase() === "wave" || first === "---") {
      continue;
    }
    const m = first.match(/^W(\d+)/);
    if (!m) continue;
    const waveNum = m[1]!;
    const filesStr = cells[1] ?? "";
    const files = new Set(filesStr.match(/[\w/.\-]+\.\w+/g) ?? []);
    const depsStr = cells[2] ?? "";
    const group = cells[3] ?? "";
    rows.push({ wave: waveNum, files, group, deps: depsStr });
  }
  return rows;
}

/** ② Wave 表存在且至少 1 功能行。 */
function checkWaveTable(report: CheckReport, mdPath: string): void {
  const rows = parseWaveTable(mdPath);
  if (rows.length === 0) {
    report.addFail(
      "Wave 表",
      "Wave 拆分章节无可解析的 Wave 行（W1/W2...）；表头需为 `| Wave | 改动文件 | 依赖 | 并行组 |`，每行 Wave 编号必须 W1/W2 格式，改动文件列填逗号分隔的文件路径",
    );
  } else {
    report.addPass("Wave 表", `解析到 ${rows.length} 个 Wave`);
  }
}

/**
 * ② 同并行组 Wave 改动文件无交集。
 *
 * 并行安全的核心机器判：同一 group 的多个 Wave 改同一文件 = git index 冲突风险。
 */
function checkParallelSafety(report: CheckReport, mdPath: string): void {
  const rows = parseWaveTable(mdPath);
  if (rows.length === 0) {
    report.addSkip("并行组文件无交集", "无 Wave 表");
    return;
  }
  // 按 group 聚合（跳过空 group 和单成员 group）
  const groups = new Map<string, WaveRow[]>();
  for (const r of rows) {
    const g = r.group.trim();
    if (!g || g === "-") continue;
    const arr = groups.get(g) ?? [];
    arr.push(r);
    groups.set(g, arr);
  }
  const conflicts: string[] = [];
  for (const [g, members] of groups) {
    if (members.length < MIN_TABLE_COLS) continue;
    // 两两检查文件交集
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const overlap = [...members[i]!.files].filter((f) => members[j]!.files.has(f));
        if (overlap.length > 0) {
          conflicts.push(
            `组 ${g}: W${members[i]!.wave} ∩ W${members[j]!.wave} = ${JSON.stringify(overlap.sort())}`,
          );
        }
      }
    }
  }
  if (conflicts.length > 0) {
    report.addFail(
      "并行组文件无交集",
      `${conflicts.join("; ")}；同并行组的 Wave 改同一文件会在 git merge 时冲突，需拆分到不同并行组或合并为单 Wave 顺序执行`,
    );
  } else {
    const multi = [...groups.values()].filter((m) => m.length >= MIN_TABLE_COLS).length;
    report.addPass(
      "并行组文件无交集",
      multi > 0 ? `${multi} 个多成员组均无文件冲突` : "无多成员并行组",
    );
  }
}

// ── ③ 测试清单结构 ──────────────────────────────────────────────

/**
 * 解析技术改动点章节，返回文件路径列表。
 *
 * 格式（plan-template.md）：「- 创建/修改 {path} — {职责}」
 */
function parseChangePoints(mdPath: string): string[] {
  const section = extractSection(mdPath, "技术改动点") ?? "";
  const paths: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*(?:创建|修改|新建)?\s*`?([\w/.\-]+\.\w+)`?/);
    if (m) paths.push(m[1]!);
  }
  return paths;
}

/** ③ 单测每行有具体输入+预期，且无模糊断言词。 */
function checkTestMachineJudgable(report: CheckReport, mdPath: string): void {
  const section = extractSection(mdPath, "单测用例清单|单测清单") ?? "";
  if (!section) {
    report.addFail("单测可机器判定", "无单测章节");
    return;
  }
  // 解析表格行（跳过表头/分隔）
  const dataRows: string[][] = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
    if (cells.length < MIN_UNITTEST_COLS) continue;
    if (/^W?\d+/.test(cells[0]!) || cells[0]!.toLowerCase().startsWith("u")) {
      // 跳过表头行
      const firstLower = cells[0]!.toLowerCase();
      if (firstLower === "用例id" || firstLower === "用例 id" || firstLower === "id" || firstLower === "u") {
        continue;
      }
      dataRows.push(cells);
    }
  }
  if (dataRows.length === 0) {
    report.addFail("单测可机器判定", "单测章节无可解析用例行");
    return;
  }
  // 单测表列索引：ID=0, 覆盖改动点=1, 输入=2, 预期=3（类型列在最后，长度可变）
  const COL_INPUT = 2;
  const COL_EXPECTED = 3;
  // 检查输入列和预期列非空
  const vagueHits: string[] = [];
  const emptyHits: string[] = [];
  for (const cells of dataRows) {
    // 预期列最可能是倒数第 2 或第 3 列（类型列在最后）
    const expectedCol = cells.length > COL_EXPECTED ? cells[COL_EXPECTED]! : cells[cells.length - 1]!;
    const inputCol = cells.length > COL_INPUT ? cells[COL_INPUT]! : "";
    if (!inputCol || inputCol === "-") {
      emptyHits.push(cells[0]!);
    }
    if (VAGUE_WORDS.test(expectedCol)) {
      vagueHits.push(`${cells[0]}: ${expectedCol.slice(0, VAGUE_PREVIEW_LEN)}`);
    }
  }
  if (emptyHits.length > 0) {
    report.addFail(
      "单测输入非空",
      `${emptyHits.length} 条缺输入: ${JSON.stringify(emptyHits.slice(0, ERR_LIST_SHORT))}；每条单测的输入列和预期列都必须填具体值（如输入「userId=1, body={name:"x"}」、预期「{code:0}」），不可留空或填 -`,
    );
  } else if (vagueHits.length > 0) {
    report.addFail(
      "单测可机器判定",
      `${vagueHits.length} 条含模糊词（正常工作/应该返回...）: ${JSON.stringify(vagueHits.slice(0, ERR_LIST_SHORT))}；预期列禁止「正常工作」「应该返回」「行为正确」等模糊词，须写可断言的具体值（如「{code:0, data.id>0}」）`,
    );
  } else {
    report.addPass("单测可机器判定", `${dataRows.length} 条用例输入/预期均具体`);
  }
}

/** ③ 每个技术改动点至少 1 条单测（改动点文件 vs 单测「覆盖改动点」列对照）。 */
function checkTestCoverageOfChanges(report: CheckReport, mdPath: string): void {
  const changePoints = parseChangePoints(mdPath);
  if (changePoints.length === 0) {
    report.addSkip("改动点单测覆盖", "技术改动点章节无可解析文件路径");
    return;
  }
  const section = extractSection(mdPath, "单测用例清单|单测清单") ?? "";
  // 单测表的「覆盖改动点」列通常含 文件:函数 或文件名片段
  const covered = new Set<string>();
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
    if (cells.length < MIN_UNITTEST_COLS) continue;
    const firstLower = cells[0]!.toLowerCase();
    if (firstLower === "用例id" || firstLower === "用例 id" || firstLower === "id" || firstLower === "u") {
      continue;
    }
    // 覆盖改动点列通常是第 2 列（index 1）
    const COL_COVERED = 1;
    const coveredStr = cells.length > COL_COVERED ? cells[COL_COVERED]! : "";
    for (const cp of changePoints) {
      // basename 匹配（改动点 a/b/c.ts vs 覆盖列 c.ts:fn）
      const cpBase = basename(cp);
      if (coveredStr.includes(cp) || coveredStr.includes(cpBase)) {
        covered.add(cp);
      }
    }
  }
  const uncovered = changePoints.filter((cp) => !covered.has(cp));
  if (uncovered.length > 0) {
    report.addFail(
      "改动点单测覆盖",
      `${uncovered.length}/${changePoints.length} 个改动点无对应单测: ${JSON.stringify(uncovered.slice(0, ERR_LIST_SHORT))}；每个技术改动点文件至少 1 条单测覆盖，且单测的「覆盖改动点」列需标「文件:函数」格式（如 user.ts:createUser）以便机器匹配`,
    );
  } else {
    report.addPass("改动点单测覆盖", `${changePoints.length} 个改动点均有 ≥1 条单测`);
  }
}

/** ③ 覆盖率 gate 命令存在 + 阈值 ≥60%。 */
function checkCoverageGate(report: CheckReport, mdPath: string): void {
  const section = extractSection(mdPath, "覆盖率\\s*gate|覆盖率") ?? "";
  if (!section) {
    report.addFail("覆盖率 gate", "无覆盖率章节");
    return;
  }
  // 命令存在：含常见的 coverage 命令模式或「gate 命令」声明
  const hasCmd =
    /(vitest|jest|pytest|coverage|cov|jacoco|npx|pnpm|mvn|gradle).*(--coverage|--cov|coverage)/.test(section) ||
    section.includes("gate 命令") ||
    section.includes("gate命令");
  // 阈值：提取 ≥60 或更高
  const thresholdMatch = section.match(/(\d+)\s*%/);
  const threshold = thresholdMatch ? Number(thresholdMatch[1]) : 0;
  const issues: string[] = [];
  if (!hasCmd) issues.push("缺具体覆盖率命令");
  if (threshold < COVERAGE_THRESHOLD_MIN) issues.push(`阈值 ${threshold}% < ${COVERAGE_THRESHOLD_MIN}%（下限）`);
  if (issues.length > 0) {
    report.addFail(
      "覆盖率 gate",
      `${issues.join("; ")}；需含具体覆盖率命令（如「npx vitest run --coverage」或「pytest --cov=src --cov-fail-under=60」）且阈值 ≥60%`,
    );
  } else {
    report.addPass("覆盖率 gate", `命令存在，阈值 ${threshold}% ≥60%`);
  }
}

/**
 * ③ E2E 每条标测试层（mock/real），且 mock 层 + real 层各至少 1 条。
 *
 * 测试层是 E2E 验收 todo 分组（mock 组 / real 组）的依据，见
 * test-case-schema.md「核心原则四」。机器判：表头有「测试层」列 +
 * 每行值为 mock/real + 两层各 ≥1。
 */
function checkE2eTestLayer(report: CheckReport, mdPath: string): void {
  const section = extractSection(mdPath, "E2E\\s*用例清单|E2E\\s*清单") ?? "";
  if (!section) {
    report.addSkip("E2E 测试层", "无 E2E 章节");
    return;
  }
  // 定位含「测试层」字样的行（表头），确定其列号。
  // 不用「用例 ID」字样探测表头——数据行说明列可能含此字样导致误跳过（Bug 2 修复）。
  let layerCol: number | null = null;
  for (const line of section.split(/\r?\n/)) {
    if (line.includes("测试层")) {
      const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
      for (let idx = 0; idx < cells.length; idx++) {
        if (cells[idx]!.includes("测试层")) {
          layerCol = idx;
          break;
        }
      }
      break;
    }
  }
  // 收集数据行的测试层值（同时存 caseId，报错时能定位具体用例）
  const dataEntries: Array<{ id: string; layer: string }> = [];
  const missing: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("|")) continue;
    const cells = s.split("|").map((c) => c.trim()).filter((c) => c !== "");
    if (cells.length < MIN_TABLE_COLS) continue;
    const first = cells[0]!;
    if (!/^E\d/i.test(first)) continue; // 表头/分隔行 / 非 E 开头数据行
    if (layerCol === null || layerCol >= cells.length) {
      missing.push(first);
    } else {
      const val = cells[layerCol]!.toLowerCase().trim();
      if (val === "mock" || val === "real") {
        dataEntries.push({ id: first, layer: val });
      } else {
        missing.push(first);
      }
    }
  }
  if (dataEntries.length === 0 && missing.length === 0) {
    report.addSkip("E2E 测试层", "E2E 章节无可解析用例行");
    return;
  }
  if (layerCol === null && missing.length > 0) {
    report.addFail(
      "E2E 测试层",
      `E2E 表无「测试层」列，${missing.length} 条未标 mock/real: ${JSON.stringify(missing.slice(0, ERR_LIST_MAX))}——见 test-case-schema.md 核心原则四；E2E 表必须新增「测试层」列，每行值填 mock 或 real，且 mock 层与 real 层各至少 1 条`,
    );
    return;
  }
  if (missing.length > 0) {
    report.addFail(
      "E2E 测试层",
      `${missing.length} 条未标 mock/real: ${JSON.stringify(missing.slice(0, ERR_LIST_MAX))}；每条 E2E 用例的「测试层」列必须填 mock 或 real，real 无环境时不可省略，应标 [需集成环境]`,
    );
    return;
  }
  const layers = dataEntries.map((e) => e.layer);
  const hasMock = layers.includes("mock");
  const hasReal = layers.includes("real");
  if (!(hasMock && hasReal)) {
    const lack: string[] = [];
    if (!hasMock) lack.push("mock");
    if (!hasReal) lack.push("real");
    const mockIds = dataEntries.filter((e) => e.layer === "mock").map((e) => e.id);
    const realIds = dataEntries.filter((e) => e.layer === "real").map((e) => e.id);
    const detail: string[] = [];
    if (mockIds.length) detail.push(`mock=[${mockIds.join(",")}]`);
    if (realIds.length) detail.push(`real=[${realIds.join(",")}]`);
    report.addFail(
      "E2E 测试层",
      `缺 ${lack.join("/")} 层用例（现有 ${detail.join("; ") || "无"}）；real 无环境应标 [需集成环境] 不可省略`,
    );
  } else {
    const mockCount = layers.filter((l) => l === "mock").length;
    const realCount = layers.filter((l) => l === "real").length;
    report.addPass(
      "E2E 测试层",
      `${layers.length} 条均标层，mock=${mockCount} real=${realCount}`,
    );
  }
}

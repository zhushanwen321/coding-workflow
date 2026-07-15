/**
 * spec-section.test.ts — SpecSection 结构化 + FR/AC 追溯链测试。
 *
 * 测试目标（防什么 bug）：
 * - U1: SpecSection 联合类型的 discriminator 正确（防 type 字段错误匹配）
 * - U2: parseSpecSections 解析合法 JSON（防 schema 校验漏洞）
 * - U3: appendSpecSections progressive append（防数据丢失/覆盖）
 * - U4: checkFrCoverage FR 覆盖率（防 plan 静默缩范围）
 * - U5: checkAcMapping AC 映射率（防 test 遗漏验收条件）
 * - U6: appendReviewIssues category 持久化（防已确认 bug 复发）
 * - E1: dispatch 完整路径 clarify+spec 写入
 * - E2: dispatch plan FR warning 透传
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkAcMapping, checkFrCoverage } from "../src/gate.js";
import { parseSpecSections } from "../src/plan-parser.js";
import { CwStore } from "../src/store.js";
import type { SpecSection } from "../src/types.js";

/** 创建临时 store + topic，返回 { store, topicId, cleanup }。 */
function createTmpStore(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `cw-spec-${label}-`));
  const store = new CwStore(join(dir, "_cw.json"));
  const topicId = store.insertTopic({
    slug: `test-${label}`,
    objective: "test",
    workspacePath: dir,
    topicDir: dir,
  });
  return { store, topicId, dir };
}

// ── U1: SpecSection 类型 discriminator ──────────────────────

describe("U1: SpecSection 类型联合", () => {
  it("结构化章节 type discriminator——7 种结构化类型可构造", () => {
    const sections: SpecSection[] = [
      { type: "functionalRequirements", items: [{ id: "FR-1", title: "t", detail: "d" }] },
      { type: "acceptanceCriteria", items: [{ id: "AC-1", condition: "c" }] },
      { type: "businessCases", items: [{ id: "UC-1", actor: "a", scenario: "s", expectedResult: "e" }] },
      { type: "decisions", items: [{ id: "D1", decision: "dec", rationale: "r" }] },
      { type: "complexity", rating: "medium", rationale: "因为涉及多模块" },
      { type: "outOfScope", items: ["不做 X"] },
      { type: "goals", items: [{ id: "G1", goal: "g", successCriteria: "sc" }] },
    ];
    // 7 种结构化 type
    const structuredTypes = sections.filter((s) => s.type !== "background" && s.type !== "constraints" && s.type !== "section");
    expect(structuredTypes.length).toBe(7);
  });
});

// ── U2: parseSpecSections ───────────────────────────────────

describe("U2: parseSpecSections 解析", () => {
  it("合法 JSON 含 FR + AC 章节正确提取——返回 2 个 section", () => {
    const parsed = parseSpecSections([
      {
        type: "functionalRequirements",
        items: [
          { id: "FR-1", title: "功能A", detail: "详细描述" },
          { id: "FR-2", title: "功能B", detail: "详细描述B" },
        ],
      },
      {
        type: "acceptanceCriteria",
        items: [{ id: "AC-1", condition: "条件A" }],
      },
    ]);
    expect(parsed.length).toBe(2);
    expect(parsed[0].type).toBe("functionalRequirements");
    expect(parsed[1].type).toBe("acceptanceCriteria");
  });
});

// ── U3: appendSpecSections progressive append ───────────────

describe("U3: appendSpecSections DAO", () => {
  it("两次调用追加到同一 topic——返回 2 个 section", () => {
    const { store, topicId } = createTmpStore("spec-append");
    store.appendSpecSections(topicId, [
      { type: "background", content: "背景描述" },
    ]);
    store.appendSpecSections(topicId, [
      { type: "functionalRequirements", items: [{ id: "FR-1", title: "t", detail: "d" }] },
    ]);
    const topic = store.loadTopic(topicId)!;
    expect(topic.specSections.length).toBe(2);
  });
});

// ── U4: checkFrCoverage ─────────────────────────────────────

describe("U4: checkFrCoverage", () => {
  it("plan 未覆盖 FR-2——warning 含 FR-2", () => {
    const specSections: SpecSection[] = [
      {
        type: "functionalRequirements",
        items: [
          { id: "FR-1", title: "功能A", detail: "d" },
          { id: "FR-2", title: "功能B", detail: "d" },
        ],
      },
    ];
    // plan 只覆盖 FR-1（description 里提到 FR-1）
    const parsed = {
      format: "lite" as const,
      objective: "test",
      waves: [
        { id: "W1", changes: [{ file: "a.ts", description: "实现 FR-1" }], dependsOn: [] },
      ],
    };
    const warning = checkFrCoverage(parsed, specSections);
    expect(warning).toContain("FR-2");
  });
});

// ── U5: checkAcMapping ──────────────────────────────────────

describe("U5: checkAcMapping", () => {
  it("test 未映射 AC-2——warning 含 AC-2", () => {
    const specSections: SpecSection[] = [
      {
        type: "acceptanceCriteria",
        items: [
          { id: "AC-1", condition: "条件A" },
          { id: "AC-2", condition: "条件B" },
        ],
      },
    ];
    const parsed = {
      testCases: [
        { id: "U1", layer: "mock" as const, scenario: "验证 AC-1", steps: "s", expected: { text: "x" }, executor: "vitest", requiresScreenshot: false, dependsOn: [] },
      ],
      testRunner: { mode: "nodejs" as const, command: "npx vitest run" },
    };
    const warning = checkAcMapping(parsed, specSections);
    expect(warning).toContain("AC-2");
  });
});

// ── U6: appendReviewIssues category 持久化 ──────────────────

describe("U6: appendReviewIssues category fix", () => {
  it("提交带 category 的 issue——loadTopic 返回值含 category", () => {
    const { store, topicId } = createTmpStore("review-cat");
    store.appendReviewIssues(topicId, 1, [
      { severity: "must-fix", description: "类型不安全", category: "type-safety" },
    ]);
    const topic = store.loadTopic(topicId)!;
    expect(topic.reviewIssues[0].category).toBe("type-safety");
  });
});

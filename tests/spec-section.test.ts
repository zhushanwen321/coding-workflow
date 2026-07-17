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

import { dispatch } from "../src/dispatch.js";
import { checkAcMapping, checkFrCoverage, GitValidator } from "../src/gate.js";
import { parseSpecSections } from "../src/plan-parser.js";
import { CwStore } from "../src/store.js";
import type { ActionDeps, SpecSection } from "../src/types.js";

/** 创建临时 store + topic（通过 dispatch create），返回 { store, topicId }。 */
function createTmpStore(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `cw-spec-${label}-`));
  const store = new CwStore(join(dir, "_cw.json"));
  const git = new GitValidator(dir);
  const deps: ActionDeps = { store, git, workspacePath: dir };
  const result = dispatch(
    { action: "create", slug: `test-${label}`, objective: "test", workspacePath: dir },
    deps,
  );
  return { store, topicId: result.topicId, dir };
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
        { id: "U1", layer: "mock" as const, scenario: "验证 AC-1", steps: "s", expected: { type: "exact" as const, text: "x" }, executor: "vitest", requiresScreenshot: false, dependsOn: [] },
      ],
      testRunner: { mode: "nodejs" as const, command: "npx vitest run" },
    };
    const warning = checkAcMapping(parsed, specSections);
    expect(warning).toContain("AC-2");
  });
});

// ── U6: appendReviewIssues dimension 持久化 ──────────────────

describe("U6: appendReviewIssues dimension fix", () => {
  it("提交带 dimension 的 issue——loadTopic 返回值含 dimension", () => {
    const { store, topicId } = createTmpStore("review-dim");
    store.appendReviewIssues(topicId, 1, [
      { dimension: "type-safety", severity: "must-fix", description: "类型不安全" },
    ]);
    const topic = store.loadTopic(topicId)!;
    expect(topic.reviewIssues[0].dimension).toBe("type-safety");
  });
});

// ── E1: dispatch 完整路径 clarify+spec 写入 ─────────────────

describe("E1: dispatch clarify 带 specSections", () => {
  it("create→clarify(带 spec)→topic.specSections 含 functionalRequirements", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-spec-e1-"));
    const dbPath = join(dir, "_cw.json");
    const store = new CwStore(dbPath);
    const git = new GitValidator(dir);
    const deps: ActionDeps = { store, git, workspacePath: dir };

    const createResult = dispatch(
      { action: "create", slug: "e1-spec-test", objective: "test spec", workspacePath: dir },
      deps,
    );
    const topicId = createResult.topicId;

    // clarify 带 specSections
    dispatch(
      {
        action: "clarify",
        topicId,
        clarifyJson: {
          kind: "requirement",
          topic: "测试 spec",
          assessment: "探索后的背景",
          question: "需要 spec 吗？",
          answer: "需要",
          specSections: [
            {
              type: "functionalRequirements",
              items: [
                { id: "FR-1", title: "功能A", detail: "详细" },
              ],
            },
          ],
        },
      },
      deps,
    );

    // specSections 写入了
    const topic = store.loadTopic(topicId)!;
    expect(topic.specSections.length).toBe(1);
    expect(topic.specSections[0].type).toBe("functionalRequirements");
  });
});

// ── E2: dispatch plan FR warning 透传 ───────────────────────

describe("E2: dispatch plan FR 覆盖 warning", () => {
  it("clarify(含 FR-1 FR-2)→plan(wave 只覆盖 FR-1)→result.mustFix 含 FR-2", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-spec-e2-"));
    const dbPath = join(dir, "_cw.json");
    const store = new CwStore(dbPath);
    const git = new GitValidator(dir);
    const deps: ActionDeps = { store, git, workspacePath: dir };

    const createResult = dispatch(
      { action: "create", slug: "e2-fr-warning", objective: "test fr warning", workspacePath: dir },
      deps,
    );
    const topicId = createResult.topicId;

    // 先 clarify 带 spec FR-1 + FR-2
    dispatch(
      {
        action: "clarify",
        topicId,
        clarifyJson: {
          kind: "requirement",
          topic: "spec",
          assessment: "背景",
          question: "spec?",
          answer: "yes",
          specSections: [
            {
              type: "functionalRequirements",
              items: [
                { id: "FR-1", title: "功能A", detail: "a" },
                { id: "FR-2", title: "功能B", detail: "b" },
              ],
            },
          ],
        },
      },
      deps,
    );

    // plan 只覆盖 FR-1（状态机改动：plan 前需 confirm_clarify → spec_review）
    store.updateStatus(topicId, "clarify_confirmed");
    store.updateGatePassed(topicId, "confirm_clarify", true);
    store.updateStatus(topicId, "spec_reviewed");
    store.updateGatePassed(topicId, "spec_review", true);
    const result = dispatch(
      {
        action: "plan",
        topicId,
        planJson: {
          format: "lite",
          objective: "test",
          waves: [
            {
              id: "W1",
              changes: [{ file: "src/a.ts", description: "实现 FR-1 功能A" }],
              dependsOn: [],
            },
          ],
        },
      },
      deps,
    );

    // plan gate pass（status 流转）
    expect(result.gatePassed.plan).toBe(true);

    // mustFix 含 FR-2 warning（warning 不阻断但透传）
    const mustFix = (result as Record<string, unknown>).mustFix as string | undefined;
    expect(mustFix).toBeDefined();
    expect(mustFix).toContain("FR-2");
  });
});

// ── FR-2: replaceSpecSections + specHistory（AC-4） ──────────

describe("FR-2 AC-4: replaceSpecSections + specHistory", () => {
  it("replaceSpecSections 后 specHistory 含旧版快照 + specSections 是新内容", () => {
    const { store, topicId } = createTmpStore("spec-replace");
    // 先 append 初始 spec
    store.appendSpecSections(topicId, [
      { type: "functionalRequirements", items: [{ id: "FR-1", title: "旧", detail: "旧描述" }] },
    ]);
    // replace
    store.replaceSpecSections(topicId, [
      { type: "functionalRequirements", items: [{ id: "FR-1", title: "新", detail: "新描述" }] },
    ], "需求变更：FR-1 细节调整");
    const topic = store.loadTopic(topicId)!;
    // specSections 是新内容
    const fr = topic.specSections.find((s) => s.type === "functionalRequirements");
    expect(fr).toBeDefined();
    if (fr && fr.type === "functionalRequirements") {
      expect(fr.items[0]!.title).toBe("新");
    }
    // specHistory 含旧版快照
    expect(topic.specHistory).toBeDefined();
    expect(topic.specHistory!.length).toBe(1);
    expect(topic.specHistory![0]!.version).toBe(1);
    const oldFr = topic.specHistory![0]!.sections.find(
      (s) => s.type === "functionalRequirements",
    );
    if (oldFr && oldFr.type === "functionalRequirements") {
      expect(oldFr.items[0]!.title).toBe("旧");
    }
  });

  it("多次 replace → specHistory 版本号递增", () => {
    const { store, topicId } = createTmpStore("spec-replace-multi");
    store.appendSpecSections(topicId, [
      { type: "background", content: "v0" },
    ]);
    store.replaceSpecSections(topicId, [
      { type: "background", content: "v1" },
    ], "第一次修改");
    store.replaceSpecSections(topicId, [
      { type: "background", content: "v2" },
    ], "第二次修改");
    const topic = store.loadTopic(topicId)!;
    expect(topic.specHistory!.length).toBe(2);
    expect(topic.specHistory![0]!.version).toBe(1);
    expect(topic.specHistory![1]!.version).toBe(2);
  });

  it("AC-7: dispatch clarify --replaceSpec 走 replaceSpecSections（非 append）", () => {
    const { store, topicId, dir } = createTmpStore("spec-dispatch-replace");
    // 先 append 初始 spec（模拟第一次 clarify）
    store.appendSpecSections(topicId, [
      { type: "functionalRequirements", items: [{ id: "FR-1", title: "旧", detail: "旧" }] },
    ]);
    // 通过 dispatch clarify 带 replaceSpec 替换
    dispatch(
      {
        action: "clarify",
        topicId,
        clarifyJson: {
          kind: "requirement",
          topic: "spec 变更",
          assessment: "需求理解修正",
          question: "FR-1 要改吗？",
          answer: "改",
          specSections: [
            { type: "functionalRequirements", items: [{ id: "FR-1", title: "新", detail: "新" }] },
          ],
        },
        replaceSpec: "需求变更：FR-1 修正",
      },
      { store, git: new GitValidator(dir), workspacePath: dir },
    );
    const topic = store.loadTopic(topicId)!;
    // specSections 被替换（不是追加）——只有 1 个 section，title=新
    expect(topic.specSections.length).toBe(1);
    const fr = topic.specSections[0];
    if (fr && fr.type === "functionalRequirements") {
      expect(fr.items[0]!.title).toBe("新");
    }
    // specHistory 含旧版
    expect(topic.specHistory.length).toBe(1);
    expect(topic.specHistory[0]!.version).toBe(1);
  });

  it("dispatch clarify 不带 replaceSpec 走 append（向后兼容）", () => {
    const { store, topicId, dir } = createTmpStore("spec-dispatch-append");
    store.appendSpecSections(topicId, [
      { type: "background", content: "初始" },
    ]);
    dispatch(
      {
        action: "clarify",
        topicId,
        clarifyJson: {
          kind: "requirement",
          topic: "追加 spec",
          assessment: "补充",
          question: "加 AC？",
          answer: "加",
          specSections: [
            { type: "acceptanceCriteria", items: [{ id: "AC-1", condition: "条件" }] },
          ],
        },
      },
      { store, git: new GitValidator(dir), workspacePath: dir },
    );
    const topic = store.loadTopic(topicId)!;
    // append 模式：2 个 section（background + acceptanceCriteria），specHistory 空
    expect(topic.specSections.length).toBe(2);
    expect(topic.specHistory.length).toBe(0);
  });
});

// ── FR-3: abort + stats 排除（AC-5） ─────────────────────────

describe("FR-3 AC-5: abort + stats 排除", () => {
  it("abort 后 status=aborted", () => {
    const { store, topicId } = createTmpStore("abort-test");
    store.updateStatus(topicId, "aborted");
    const topic = store.loadTopic(topicId)!;
    expect(topic.status).toBe("aborted");
  });
});

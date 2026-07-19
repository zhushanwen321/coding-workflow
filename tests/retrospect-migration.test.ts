/**
 * processIssues 旧格式迁移单测 — W2（FR-4 / AC-3 / AC-7）。
 *
 * 覆盖 AC：
 *   - AC-3: 旧格式 string[] 读取时自动迁移为对象数组 type=uncategorized
 *   - AC-7: 现有 closed topic 的 processIssues 读取不报错（迁移后聚合不崩）
 *
 * 测什么（通过 loadTopic / listTopics 间接验证迁移发生，不依赖 private 方法签名）：
 *   - loadTopic 读取旧格式（processIssues: string[]）→ 返回对象数组 type=uncategorized
 *   - listTopics 读取旧格式 → 同样迁移（PR1 核心修复，防 listTopics 漏接导致 stats 崩）
 *   - 新格式（对象数组）原样返回不重复包装
 *   - undefined / 空数组返回空数组
 *   - description 字段保留原字符串内容
 *
 * 防的 bug：
 *   - PR1 那个 listTopics 不迁移的真 bug（cw stats --all 走 listTopics → computeStatsAll，
 *     若漏接迁移则旧 string[] 会污染 W5 聚合导致 computeStatsAll 崩）。
 *   - 迁移丢数据、重复包装。
 *
 * 测试模式：真实 CwStore + tmp 目录（照 store.test.ts 的 FR-1 Artifacts 迁移测试模式）。
 * 手动写旧格式 JSON 到磁盘，再用新 CwStore 实例 loadTopic / listTopics 验证迁移。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CwStore } from "../src/store.js";
import type { ProcessIssue, Topic } from "../src/types.js";

// ── 测试夹具（照 store.test.ts 模式）──────────────────────────

let tmpDir: string;
let dbPath: string;

function makeStore(): CwStore {
  return new CwStore(dbPath);
}

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    topicId: "cw-test-topic",
    slug: "test",
    objective: "test objective",
    workspacePath: "/tmp",
    topicDir: "/tmp/.xyz-harness/test",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "created",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
    clarifyRecords: [],
    specSections: [],
    adrs: [],
    reviewIssues: [],
    reviewTurn: 0,
    specHistory: [],
    specReviewIssues: [],
    specReviewTurn: 0,
    planReviewIssues: [],
    planReviewTurn: 0,
    testFixLog: [],
    testTurn: 0,
    assessments: [],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cw-migrate-test-"));
  dbPath = join(tmpDir, "cw.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 把 topic 的 processIssues 手动改成旧格式 string[] 写回磁盘（绕过 store API，模拟旧数据）。
 * 参照 store.test.ts 的 FR-1 Artifacts 迁移测试写法。
 */
function writeLegacyProcessIssues(
  store: CwStore,
  topicId: string,
  legacyStrings: string[],
): void {
  store.transaction(() => store.insertTopic(makeTopic({ topicId })));
  const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
    topics: Array<Record<string, unknown>>;
  };
  const t = raw.topics.find((x) => x.topicId === topicId);
  expect(t).toBeDefined();
  // 手动写入旧格式：retrospectData.processIssues 是 string[]
  t!.retrospectData = {
    derived: {
      totalWaves: 1,
      totalCases: 1,
      gateFailCount: 0,
      devRetryCount: 0,
      testRetryCount: 0,
      redLightConfirmed: false,
      firstTryPassRate: 1,
    },
    knownRisks: [],
    processIssues: legacyStrings,
  };
  writeFileSync(dbPath, JSON.stringify(raw));
}

// ── loadTopic 旧格式迁移（AC-3）──────────────────────────────

describe("loadTopic 旧格式迁移（W2 / AC-3）", () => {
  it("processIssues 为 string[] 旧格式 → loadTopic 返回对象数组 type=uncategorized", () => {
    const store = makeStore();
    writeLegacyProcessIssues(store, "cw-migrate-1", [
      "plan 阶段没考虑到 git diff-tree 性能",
      "test expected 太严格",
    ]);

    // CwStore fileData 内存缓存，改 _cw.json 后需新实例重新加载。
    const reloaded = new CwStore(dbPath);
    const loaded = reloaded.loadTopic("cw-migrate-1");
    expect(loaded).not.toBeNull();
    const issues = loaded!.retrospectData!.processIssues as unknown as ProcessIssue[];
    expect(Array.isArray(issues)).toBe(true);
    expect(issues).toHaveLength(2);
    // 每条都被包装成 { type: 'uncategorized', description: 原字符串 }
    for (const issue of issues) {
      expect(typeof issue).toBe("object");
      expect(issue.type).toBe("uncategorized");
      expect(typeof issue.description).toBe("string");
    }
  });

  it("迁移保留原字符串内容到 description 字段", () => {
    const store = makeStore();
    const original1 = "replaceSpec flag 用错";
    const original2 = "subagent 切分支导致丢失改动";
    writeLegacyProcessIssues(store, "cw-migrate-2", [original1, original2]);

    const reloaded = new CwStore(dbPath);
    const loaded = reloaded.loadTopic("cw-migrate-2");
    const issues = loaded!.retrospectData!.processIssues as unknown as ProcessIssue[];
    expect(issues[0]!.description).toBe(original1);
    expect(issues[1]!.description).toBe(original2);
  });

  it("新格式（对象数组）原样返回，不重复包装", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic({ topicId: "cw-newfmt" })));
    // 手动写入新格式（对象数组，首元素有 type 字段）
    const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
      topics: Array<Record<string, unknown>>;
    };
    const t = raw.topics.find((x) => x.topicId === "cw-newfmt");
    t!.retrospectData = {
      derived: {
        totalWaves: 1, totalCases: 1, gateFailCount: 0,
        devRetryCount: 0, testRetryCount: 0,
        redLightConfirmed: true, firstTryPassRate: 1,
      },
      knownRisks: [],
      processIssues: [
        { type: "pattern", description: "可泛化模式" },
        { type: "oneOff", description: "一次性失误" },
      ],
    };
    writeFileSync(dbPath, JSON.stringify(raw));

    const reloaded = new CwStore(dbPath);
    const loaded = reloaded.loadTopic("cw-newfmt");
    const issues = loaded!.retrospectData!.processIssues as unknown as ProcessIssue[];
    // 新格式原样返回，type 不被改写为 uncategorized
    expect(issues).toHaveLength(2);
    expect(issues[0]!.type).toBe("pattern");
    expect(issues[1]!.type).toBe("oneOff");
    // 不重复包装：description 不是 "[object Object]"
    expect(issues[0]!.description).toBe("可泛化模式");
  });

  it("processIssues 为 undefined（无 retrospectData）→ 不崩，返回 undefined", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic({ topicId: "cw-noretro" })));

    const loaded = store.loadTopic("cw-noretro");
    expect(loaded).not.toBeNull();
    expect(loaded!.retrospectData).toBeUndefined();
  });

  it("processIssues 为空数组 → 返回空数组", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic({ topicId: "cw-empty" })));
    const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
      topics: Array<Record<string, unknown>>;
    };
    const t = raw.topics.find((x) => x.topicId === "cw-empty");
    t!.retrospectData = {
      derived: {
        totalWaves: 0, totalCases: 0, gateFailCount: 0,
        devRetryCount: 0, testRetryCount: 0,
        redLightConfirmed: false, firstTryPassRate: 1,
      },
      knownRisks: [],
      processIssues: [],
    };
    writeFileSync(dbPath, JSON.stringify(raw));

    const reloaded = new CwStore(dbPath);
    const loaded = reloaded.loadTopic("cw-empty");
    const issues = loaded!.retrospectData!.processIssues as unknown as ProcessIssue[];
    expect(issues).toEqual([]);
  });
});

// ── listTopics 旧格式迁移（AC-7 / PR1 核心）──────────────────

describe("listTopics 旧格式迁移（W2 / AC-7 / PR1 核心修复）", () => {
  it("listTopics 读取旧格式 string[] → 同样迁移为对象数组 type=uncategorized", () => {
    // 这个测试防的是 PR1 的真 bug：listTopics 不经 loadTopic，直接调
    // assembleTopicFromData 返回，若漏接 migrateProcessIssues 钩子，
    // 则旧 string[] 会原样流出，污染 cw stats --all 的 computeStatsAll 聚合。
    const store = makeStore();
    writeLegacyProcessIssues(store, "cw-list-1", [
      "CW CLI 用法不熟",
      "跨文件逻辑依赖漏改",
    ]);

    const reloaded = new CwStore(dbPath);
    const topics = reloaded.listTopics();
    const topic = topics.find((t) => t.topicId === "cw-list-1");
    expect(topic).toBeDefined();
    const issues = topic!.retrospectData!.processIssues as unknown as ProcessIssue[];
    expect(issues).toHaveLength(2);
    // 关键断言：listTopics 也做了迁移，不是裸 string[]
    for (const issue of issues) {
      expect(typeof issue).toBe("object");
      expect(issue.type).toBe("uncategorized");
      expect(typeof issue.description).toBe("string");
    }
    // 反证：元素不是裸 string（若 listTopics 没迁移，这里是 string）
    expect(typeof issues[0]).not.toBe("string");
  });

  it("listTopics 多 topic 混合格式（旧 + 新）→ 各自正确迁移/保留", () => {
    const store = makeStore();
    // topic A：旧格式
    writeLegacyProcessIssues(store, "cw-mix-old", ["旧数据 1"]);
    // topic B：新格式
    store.transaction(() => store.insertTopic(makeTopic({ topicId: "cw-mix-new" })));
    const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
      topics: Array<Record<string, unknown>>;
    };
    const tB = raw.topics.find((x) => x.topicId === "cw-mix-new");
    tB!.retrospectData = {
      derived: {
        totalWaves: 1, totalCases: 1, gateFailCount: 0,
        devRetryCount: 0, testRetryCount: 0,
        redLightConfirmed: false, firstTryPassRate: 1,
      },
      knownRisks: [],
      processIssues: [{ type: "pattern", description: "新数据" }],
    };
    writeFileSync(dbPath, JSON.stringify(raw));

    const reloaded = new CwStore(dbPath);
    const topics = reloaded.listTopics();
    const topicA = topics.find((t) => t.topicId === "cw-mix-old");
    const topicB = topics.find((t) => t.topicId === "cw-mix-new");

    const issuesA = topicA!.retrospectData!.processIssues as unknown as ProcessIssue[];
    const issuesB = topicB!.retrospectData!.processIssues as unknown as ProcessIssue[];
    // 旧格式迁移为 uncategorized
    expect(issuesA[0]!.type).toBe("uncategorized");
    expect(issuesA[0]!.description).toBe("旧数据 1");
    // 新格式保留 pattern
    expect(issuesB[0]!.type).toBe("pattern");
    expect(issuesB[0]!.description).toBe("新数据");
  });
});

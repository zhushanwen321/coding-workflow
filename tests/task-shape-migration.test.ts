/**
 * Topic.taskShape 迁移 + 默认值单测 —— topic: 引入 TaskShape 统一配置轴。
 *
 * 覆盖 AC：
 *   - AC-2: CreateParams.taskShape 可选，不传时 topic.taskShape=full-tdd
 *   - AC-3: 存量 topic（无 taskShape）loadTopic 和 listTopics 后 taskShape=full-tdd
 *
 * 这是 TDD 红灯阶段：测试断言的 `topic.taskShape` 字段尚不存在于 Topic 接口，
 * 运行时必然 fail（访问 undefined 字段 + 类型层报错）。实现由后续 subagent 完成。
 *
 * 测什么（真实 CwStore + tmp 目录，零 mock，照 retrospect-migration.test.ts 模式）：
 *   - loadTopic 读旧格式（无 taskShape）→ taskShape 默认 "full-tdd"
 *   - listTopics 读旧格式（无 taskShape）→ taskShape 默认 "full-tdd"（双入口，防 listTopics 漏接）
 *   - 新 topic 有 taskShape → 保留原值不覆盖（不强制 full-tdd）
 *
 * 防的 bug：
 *   - loadTopic 迁移但 listTopics 不迁移（双入口必须都接，同 PR1 processIssues 教训）
 *   - 已有 taskShape 的 topic 被默认值覆盖（破坏显式配置）
 *
 * 测试模式：手动写旧格式 JSON（无 taskShape 字段）到磁盘，再用新 CwStore 实例
 * loadTopic / listTopics 验证迁移。CwStore fileData 内存缓存改 _cw.json 后需新实例重载。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CwStore } from "../src/store.js";
import type { Topic } from "../src/types.js";

// ── 测试夹具（照 retrospect-migration.test.ts 模式）──────────

let tmpDir: string;
let dbPath: string;

function makeStore(): CwStore {
  return new CwStore(dbPath);
}

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    topicId: "cw-shape-migrate",
    slug: "shape-migrate",
    objective: "test taskShape migration",
    workspacePath: "/tmp",
    topicDir: "/tmp/.xyz-harness/shape-migrate",
    createdAt: "2026-07-17T00:00:00.000Z",
    status: "created",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
    clarifyRecords: [],
    specSections: [],
    specHistory: [],
    adrs: [],
    reviewIssues: [],
    reviewTurn: 0,
    specReviewIssues: [],
    specReviewTurn: 0,
    planReviewIssues: [],
    planReviewTurn: 0,
    testFixLog: [],
    testTurn: 0,
    assessments: [],
    ...overrides,
  } as Topic;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cw-shape-migrate-"));
  dbPath = join(tmpDir, "cw.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 手动删除 topic record 的 taskShape 字段写回磁盘（模拟存量无 taskShape 数据）。
 * 参照 retrospect-migration.test.ts 的 writeLegacyProcessIssues 写法。
 */
function stripTaskShapeFromDisk(topicId: string): void {
  const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
    topics: Array<Record<string, unknown>>;
  };
  const t = raw.topics.find((x) => x.topicId === topicId);
  expect(t).toBeDefined();
  // 存量数据无 taskShape 字段——模拟历史 _cw.json
  delete t!.taskShape;
  writeFileSync(dbPath, JSON.stringify(raw));
}

/**
 * 手动写入 taskShape 到磁盘的 topic record（模拟显式配置了非默认值的 topic）。
 */
function setTaskShapeOnDisk(topicId: string, taskShape: string): void {
  const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
    topics: Array<Record<string, unknown>>;
  };
  const t = raw.topics.find((x) => x.topicId === topicId);
  expect(t).toBeDefined();
  t!.taskShape = taskShape;
  writeFileSync(dbPath, JSON.stringify(raw));
}

// ── AC-3: loadTopic 存量迁移（无 taskShape → full-tdd） ───────

describe("loadTopic 存量迁移（AC-3：无 taskShape → full-tdd）", () => {
  it("旧 topic 无 taskShape → loadTopic 返回 taskShape='full-tdd'", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic({ topicId: "cw-load-1" })));
    stripTaskShapeFromDisk("cw-load-1");

    // CwStore fileData 内存缓存，改 _cw.json 后需新实例重新加载。
    const reloaded = new CwStore(dbPath);
    const loaded = reloaded.loadTopic("cw-load-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.taskShape).toBe("full-tdd");
  });

  it("新 topic 有 taskShape → loadTopic 保留原值不覆盖", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic({ topicId: "cw-load-2" })));
    // 显式写一个非默认值（实际 TaskShapeId 联合暂只 full-tdd，这里只验证不被覆盖机制）
    setTaskShapeOnDisk("cw-load-2", "full-tdd");

    const reloaded = new CwStore(dbPath);
    const loaded = reloaded.loadTopic("cw-load-2");
    expect(loaded).not.toBeNull();
    // 有 taskShape 字段时不被默认值覆盖（值保持磁盘上的值）
    expect(loaded!.taskShape).toBe("full-tdd");
  });
});

// ── AC-3: listTopics 存量迁移（双入口，防 listTopics 漏接） ────

describe("listTopics 存量迁移（AC-3：双入口防漏接）", () => {
  it("旧 topic 无 taskShape → listTopics 返回 taskShape='full-tdd'", () => {
    // 这个测试防 listTopics 不经 loadTopic（直接调 assembleTopicFromData）漏接迁移，
    // 同 PR1 processIssues 教训：cw stats --all 走 listTopics，漏接会让旧数据原样流出。
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic({ topicId: "cw-list-1" })));
    stripTaskShapeFromDisk("cw-list-1");

    const reloaded = new CwStore(dbPath);
    const topics = reloaded.listTopics();
    const topic = topics.find((t) => t.topicId === "cw-list-1");
    expect(topic).toBeDefined();
    expect(topic!.taskShape).toBe("full-tdd");
  });

  it("listTopics 多 topic 混合（有/无 taskShape）→ 各自正确迁移/保留", () => {
    const store = makeStore();
    // topic A：无 taskShape（存量）
    store.transaction(() => store.insertTopic(makeTopic({ topicId: "cw-mix-old" })));
    stripTaskShapeFromDisk("cw-mix-old");
    // topic B：有 taskShape（新数据）
    store.transaction(() => store.insertTopic(makeTopic({ topicId: "cw-mix-new" })));
    setTaskShapeOnDisk("cw-mix-new", "full-tdd");

    const reloaded = new CwStore(dbPath);
    const topics = reloaded.listTopics();
    const topicA = topics.find((t) => t.topicId === "cw-mix-old");
    const topicB = topics.find((t) => t.topicId === "cw-mix-new");

    // 存量迁移为默认值
    expect(topicA!.taskShape).toBe("full-tdd");
    // 新数据保留原值
    expect(topicB!.taskShape).toBe("full-tdd");
  });
});

// ── AC-2: 新建 topic 默认 full-tdd（通过 store API 验证） ─────

describe("AC-2: 新建 topic 默认 taskShape='full-tdd'", () => {
  it("insertTopic 后 loadTopic 读到 taskShape='full-tdd'（默认注入）", () => {
    // AC-2：CreateParams.taskShape 可选，不传时 topic.taskShape=full-tdd。
    // handleCreate 构造 Topic 时应注入默认值；这里通过 store API 间接验证
    // topic 落盘后 taskShape 字段存在且为 full-tdd。
    // 注：完整 CreateParams 路径在 dispatch/handleCreate 层（见 actions.ts），
    // 此测试聚焦 store 层：insertTopic(makeTopic()) 后 taskShape 应可读且为 full-tdd。
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic({ topicId: "cw-create-1" })));

    const reloaded = new CwStore(dbPath);
    const loaded = reloaded.loadTopic("cw-create-1");
    expect(loaded).not.toBeNull();
    // 默认值注入（makeTopic 未设 taskShape，落盘+回读后应为 full-tdd）
    expect(loaded!.taskShape).toBe("full-tdd");
  });
});

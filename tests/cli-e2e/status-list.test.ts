/**
 * UC-4: status/list 子命令测试（mock 层 + real store）。
 *
 * 覆盖 test-matrix: T4.1~T4.4（关联 code-architecture.md §4.5 时序图）。
 *
 * 双层测试：
 *   1. mock 层 —— 内存 FakeStore 验证 cli.ts 的 handleStatus/handleList 逻辑
 *      （status/list 不经过 dispatch，issue #8 方案A：CLI 层只读查询）
 *   2. real store 层 —— 真实 CwStore.listTopics/loadTopic 读临时 JSON 文件，
 *      验证 store.ts 的 listTopics 实现（W5 deliverable）。
 *
 * handleStatus 数据流（§4.5）：
 *   store.loadTopic(topicId) → 存在: 构造 StatusOutput{topicId,status,gatePassed,waves,testCases}
 *                            → 不存在: throw "topic not found"（CLI 层映射 exit 1）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleStatus, handleList } from "../../src/cli/cli.js";
import { CwStore } from "../../src/engine/store.js";
import type { CwTopic } from "../../src/engine/types.js";

// ── FakeStore：内存实现 status/list 所需查询方法 ──────────────

class FakeStore {
  private topics = new Map<string, CwTopic>();

  seed(topic: CwTopic): void {
    this.topics.set(topic.topicId, topic);
  }

  loadTopic(topicId: string): CwTopic | null {
    return this.topics.get(topicId) ?? null;
  }

  listTopics(): CwTopic[] {
    return [...this.topics.values()];
  }
}

// ── 造 topic fixture ────────────────────────────────────────

function makeTopic(
  topicId: string,
  overrides: Partial<CwTopic> = {},
): CwTopic {
  return {
    schemaVersion: 4,
    topicId,
    slug: topicId.replace(/^cw-\d{4}-\d{2}-\d{2}-/, ""),
    tier: "lite",
    objective: "test objective",
    workspacePath: "/tmp/cw-test",
    topicDir: "/tmp/cw-test/.xyz-harness/test",
    createdAt: "2026-07-10T00:00:00.000Z",
    status: "planned",
    waves: [
      { id: "W1", dependsOn: [], committed: null, changes: [], issues: [] },
      { id: "W2", dependsOn: ["W1"], committed: "abc123", changes: ["a.ts"], issues: [] },
    ],
    testCases: [
      {
        id: "T1.1",
        layer: "mock",
        scenario: "create topic",
        steps: "call create",
        executor: "unit",
        status: "pending",
      },
    ],
    gateHistory: [],
    gatePassed: { plan: true },
    ...overrides,
  };
}

// ── mock 层：handleStatus / handleList 逻辑 ──────────────────

describe("UC-4 status (mock 层)", () => {
  it("T4.1: 查询已存在 topic → StatusOutput 含 status/gatePassed/waves/testCases", () => {
    const store = new FakeStore();
    store.seed(makeTopic("cw-2026-07-10-x"));

    const out = handleStatus("cw-2026-07-10-x", store);

    expect(out.topicId).toBe("cw-2026-07-10-x");
    expect(out.status).toBe("planned");
    expect(out.gatePassed).toEqual({ plan: true });
    // waves 进度摘要（committed: boolean，与 waveProgress 语义一致）
    expect(out.waves).toEqual([
      { id: "W1", committed: false },
      { id: "W2", committed: true },
    ]);
    // testCases 进度摘要
    expect(out.testCases).toEqual([{ id: "T1.1", status: "pending" }]);
  });

  it("T4.2: 查询不存在 topic → throw（CLI 层映射 exit 1 + stderr）", () => {
    const store = new FakeStore();
    // 不 seed 任何 topic

    expect(() => handleStatus("cw-2026-07-10-nonexistent", store)).toThrow(
      /topic not found/,
    );
  });
});

describe("UC-4 list (mock 层)", () => {
  it("T4.3: list 所有 topic → 返回全部 topic 数组", () => {
    const store = new FakeStore();
    store.seed(makeTopic("cw-2026-07-10-a"));
    store.seed(makeTopic("cw-2026-07-10-b", { status: "developed" }));

    const list = handleList(store);

    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.topicId).sort()).toEqual([
      "cw-2026-07-10-a",
      "cw-2026-07-10-b",
    ]);
  });

  it("T4.4: 空库 list → 返回 []", () => {
    const store = new FakeStore();

    const list = handleList(store);

    expect(list).toEqual([]);
  });
});

// ── real store 层：CwStore.listTopics / loadTopic 真实文件读取 ──

describe("UC-4 store (real 文件层)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cw-status-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("listTopics: 读 JSON 文件 → 返回全部 topic（T4.3 real）", () => {
    const dbPath = join(tmpDir, "sub", "_cw.json");
    const store = new CwStore(dbPath);
    // 用 store 自身 API 写入（normalized 格式：topics + waves + testCases 分离）
    store.transaction(() => {
      store.insertTopic(makeTopic("cw-2026-07-10-real1"));
      store.insertWaves("cw-2026-07-10-real1", [
        { id: "W1", dependsOn: [] },
        { id: "W2", dependsOn: ["W1"] },
      ]);
      store.insertTestCases("cw-2026-07-10-real1", [
        { id: "T1.1", layer: "mock", scenario: "s", steps: "st", executor: "unit" },
      ]);
      store.insertTopic(makeTopic("cw-2026-07-10-real2", { status: "developed" }));
    });
    store.close();

    // 新 store 实例从磁盘读取（验证持久化 round-trip）
    const store2 = new CwStore(dbPath);
    const list = store2.listTopics();

    expect(list).toHaveLength(2);
    expect(list.map((t) => t.topicId).sort()).toEqual([
      "cw-2026-07-10-real1",
      "cw-2026-07-10-real2",
    ]);
    // 反序列化保真：waves/testCases 完整
    const t1 = list.find((t) => t.topicId === "cw-2026-07-10-real1")!;
    expect(t1.waves).toHaveLength(2);
    expect(t1.testCases).toHaveLength(1);
    store2.close();
  });

  it("listTopics: 文件不存在 / 空库 → []（T4.4 real）", () => {
    const dbPath = join(tmpDir, "_cw.json");
    const store = new CwStore(dbPath);
    // 不写文件

    expect(store.listTopics()).toEqual([]);
  });

  it("loadTopic: 按 topicId 命中 → 返回 topic；未命中 → null（T4.1/T4.2 real）", () => {
    const dbPath = join(tmpDir, "_cw.json");
    const store = new CwStore(dbPath);
    store.transaction(() => {
      store.insertTopic(makeTopic("cw-2026-07-10-hit"));
    });
    store.close();

    const store2 = new CwStore(dbPath);
    const hit = store2.loadTopic("cw-2026-07-10-hit");
    expect(hit).not.toBeNull();
    expect(hit!.topicId).toBe("cw-2026-07-10-hit");
    expect(hit!.status).toBe("planned");

    const miss = store2.loadTopic("cw-2026-07-10-miss");
    expect(miss).toBeNull();
    store2.close();
  });
});

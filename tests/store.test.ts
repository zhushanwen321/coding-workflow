/**
 * store 单测 — U12-U15（事务 + DAO）。
 *
 * 覆盖：transaction 异常 ROLLBACK、transaction 正常写入、loadTopic 不存在返回 null、
 * setWaveCommitted 幂等更新。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CwStore } from "../src/store.js";
import type { Topic } from "../src/types.js";

// ── 测试夹具 ────────────────────────────────────────────────

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
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cw-store-test-"));
  dbPath = join(tmpDir, "cw.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── U12: transaction 异常 ROLLBACK ──────────────────────────

describe("transaction 异常 ROLLBACK（U12）", () => {
  it("写入后异常 throw → 磁盘不变", () => {
    const store = makeStore();
    // 先写入一个 topic 建立基线
    store.insertTopic(makeTopic({ topicId: "cw-baseline" }));

    const beforeDisk = store.loadTopic("cw-baseline");
    expect(beforeDisk).not.toBeNull();

    // 事务内写入新 topic 后 throw → 应 ROLLBACK
    expect(() => {
      store.transaction(() => {
        store.insertTopic(makeTopic({ topicId: "cw-rollback" }));
        throw new Error("故意 throw 触发 ROLLBACK");
      });
    }).toThrow("故意 throw");

    // 磁盘上 cw-rollback 不应存在（被 ROLLBACK）
    const afterDisk = store.loadTopic("cw-rollback");
    expect(afterDisk).toBeNull();

    // 基线 topic 仍在
    const baseline = store.loadTopic("cw-baseline");
    expect(baseline).not.toBeNull();
  });
});

// ── U13: transaction 正常写入 ───────────────────────────────

describe("transaction 正常写入（U13）", () => {
  it("正常写入 → 磁盘更新, reload 读到新值", () => {
    const store = makeStore();

    store.transaction(() => {
      store.insertTopic(makeTopic({ topicId: "cw-normal" }));
    });

    // 新建一个 store 实例（模拟 reload），验证落盘
    const reloaded = new CwStore(dbPath);
    const topic = reloaded.loadTopic("cw-normal");
    expect(topic).not.toBeNull();
    expect(topic!.topicId).toBe("cw-normal");
    expect(topic!.status).toBe("created");
  });
});

// ── U14: loadTopic 不存在返回 null ──────────────────────────

describe("loadTopic 不存在（U14）", () => {
  it("topicId 不存在 → 返回 null", () => {
    const store = makeStore();
    const result = store.loadTopic("cw-nonexistent");
    expect(result).toBeNull();
  });

  it("空库 loadTopic → null", () => {
    const store = makeStore();
    expect(store.loadTopic("any")).toBeNull();
  });

  it("空库 listTopics → []", () => {
    const store = makeStore();
    expect(store.listTopics()).toEqual([]);
  });
});

// ── U15: setWaveCommitted 幂等更新 ──────────────────────────

describe("setWaveCommitted 幂等更新（U15）", () => {
  it("已 committed 的 wave 再次提交 → committed 更新为新 hash", () => {
    const store = makeStore();
    store.insertTopic(makeTopic({ topicId: "cw-wave-test" }));
    store.insertWaves("cw-wave-test", [
      { id: "W1", dependsOn: [], changes: ["change1"] },
    ]);

    // 第一次提交
    store.setWaveCommitted("cw-wave-test", "W1", "hash-aaa");
    let topic = store.loadTopic("cw-wave-test");
    expect(topic!.waves[0]!.committed).toBe("hash-aaa");

    // 再次提交新 hash（amend 场景）
    store.setWaveCommitted("cw-wave-test", "W1", "hash-bbb");
    topic = store.loadTopic("cw-wave-test");
    expect(topic!.waves[0]!.committed).toBe("hash-bbb");
  });
});

// ── 补充：事务嵌套 + replaceUncommittedWaves ─────────────────

describe("store 补充覆盖", () => {
  it("嵌套事务：外层 ROLLBACK 包含内层写入", () => {
    const store = makeStore();
    store.insertTopic(makeTopic({ topicId: "cw-nested" }));

    expect(() => {
      store.transaction(() => {
        store.transaction(() => {
          store.updateStatus("cw-nested", "planned");
        });
        throw new Error("外层 throw");
      });
    }).toThrow("外层 throw");

    // 内层的 updateStatus 应随外层 ROLLBACK
    const topic = store.loadTopic("cw-nested");
    expect(topic!.status).toBe("created");
  });

  it("replaceUncommittedWaves 保留已 committed wave", () => {
    const store = makeStore();
    store.insertTopic(makeTopic({ topicId: "cw-replace" }));
    store.insertWaves("cw-replace", [
      { id: "W1", dependsOn: [], changes: [] },
      { id: "W2", dependsOn: ["W1"], changes: [] },
    ]);
    // W1 committed，W2 未 committed
    store.setWaveCommitted("cw-replace", "W1", "hash1");

    // replan：只传未 committed 的新 wave（W3）。
    // replaceUncommittedWaves 语义：filter 掉未 committed 的，然后 push 传入的全部。
    // 所以调用方（handleReplan）只传未 committed 的新增，已 committed 的由 filter 保留。
    store.replaceUncommittedWaves("cw-replace", [
      { id: "W3", dependsOn: ["W1"], changes: [] },
    ]);

    const topic = store.loadTopic("cw-replace");
    const waveIds = topic!.waves.map((w) => w.id).sort();
    // W1 保留（已 committed），W2 删除（未 committed），W3 新增
    expect(waveIds).toEqual(["W1", "W3"]);
    // W1 的 committed 保留
    const w1 = topic!.waves.find((w) => w.id === "W1");
    expect(w1!.committed).toBe("hash1");
  });

  it("insertTopic 重复 topicId → throw UNIQUE 约束", () => {
    const store = makeStore();
    store.insertTopic(makeTopic({ topicId: "cw-dup" }));
    expect(() => {
      store.insertTopic(makeTopic({ topicId: "cw-dup" }));
    }).toThrow(/UNIQUE/);
  });

  it("appendGateHistory 自增 id", () => {
    const store = makeStore();
    store.insertTopic(makeTopic({ topicId: "cw-gate" }));

    store.appendGateHistory("cw-gate", {
      phase: "plan",
      action: "plan",
      gate: "test-gate",
      result: "pass",
      progressive: false,
    });
    store.appendGateHistory("cw-gate", {
      phase: "plan",
      action: "plan",
      gate: "test-gate",
      result: "fail",
      progressive: false,
    });

    const history = store.loadGateHistory("cw-gate");
    expect(history).toHaveLength(2);
    expect(history[0]!.id).toBe(1);
    expect(history[1]!.id).toBe(2);
  });
});

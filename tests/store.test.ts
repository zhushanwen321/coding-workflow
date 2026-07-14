/**
 * store 单测 — U12-U15（事务 + DAO）。
 *
 * 覆盖：transaction 异常 ROLLBACK、transaction 正常写入、loadTopic 不存在返回 null、
 * setWaveCommitted 幂等更新。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach,beforeEach, describe, expect, it } from "vitest";

import { CwStore } from "../src/store.js";
import type { Priority, Topic } from "../src/types.js";

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

// ── 回归：Wave priority 持久化 ──────────────────────────────

describe("Wave priority 持久化", () => {
  it("wave priority 写入后 loadTopic 读回一致", () => {
    const store = makeStore();
    store.insertTopic(makeTopic({ topicId: "cw-wave-prio" }));
    store.insertWaves("cw-wave-prio", [
      { id: "W1", dependsOn: [], changes: ["c1"], priority: "P0" },
      { id: "W2", dependsOn: ["W1"], changes: ["c2"], priority: "P2" },
      { id: "W3", dependsOn: [], changes: ["c3"] }, // 不设 priority
    ]);
    const topic = store.loadTopic("cw-wave-prio");
    expect(topic!.waves[0]!.priority).toBe("P0");
    expect(topic!.waves[1]!.priority).toBe("P2");
    expect(topic!.waves[2]!.priority).toBeUndefined();
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

// ── DAO: setArtifacts merge 语义 ────────────────────────────

describe("setArtifacts merge 语义", () => {
  it("先 set reviewPath 再 set retrospectPath → 两者共存（merge 而非覆盖）", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    store.transaction(() => {
      store.setArtifacts("cw-test-topic", {
        reviewPath: "/tmp/review.md",
        reviewAt: "2026-01-01T00:00:00.000Z",
      });
    });
    store.transaction(() => {
      store.setArtifacts("cw-test-topic", {
        retrospectPath: "/tmp/retrospect.md",
        retrospectAt: "2026-01-02T00:00:00.000Z",
      });
    });

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.artifacts?.reviewPath).toBe("/tmp/review.md");
    expect(topic!.artifacts?.retrospectPath).toBe("/tmp/retrospect.md");
  });
});

// ── DAO: setTestRunner ──────────────────────────────────────

describe("setTestRunner", () => {
  it("写入 testRunner → loadTopic 读回 mode/command 正确", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    store.transaction(() => {
      store.setTestRunner("cw-test-topic", {
        mode: "nodejs",
        command: "npx vitest run",
      });
    });

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.testRunner).toBeDefined();
    expect(topic!.testRunner!.mode).toBe("nodejs");
    expect(topic!.testRunner!.command).toBe("npx vitest run");
  });

  it("custom 模式 → 读回 mode/path 正确", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    store.transaction(() => {
      store.setTestRunner("cw-test-topic", {
        mode: "custom",
        path: ".cw/run-tests.sh",
      });
    });

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.testRunner!.mode).toBe("custom");
    expect(topic!.testRunner!.path).toBe(".cw/run-tests.sh");
  });

  it("未 set testRunner → loadTopic 读回 undefined（agent 模式）", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.testRunner).toBeUndefined();
  });

  it("跨实例 reload（新 CwStore）→ testRunner 持久化到磁盘", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));
    store.transaction(() => {
      store.setTestRunner("cw-test-topic", {
        mode: "python",
        command: "python -m pytest",
        cwd: "tests",
      });
    });

    // 新 store 实例（模拟进程重启后 reload）
    const reloaded = new CwStore(dbPath);
    const topic = reloaded.loadTopic("cw-test-topic");
    expect(topic!.testRunner!.mode).toBe("python");
    expect(topic!.testRunner!.command).toBe("python -m pytest");
    expect(topic!.testRunner!.cwd).toBe("tests");
  });
});

// ── DAO: setEvidence gateHistory 快照 ───────────────────────

describe("setEvidence gateHistory 快照", () => {
  it("evidence.gateHistory 含写入前的全量历史", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    // 先写 2 条 gateHistory
    store.transaction(() => {
      store.appendGateHistory("cw-test-topic", {
        phase: "plan",
        action: "plan",
        gate: "lite-plan-schema",
        result: "pass",
        progressive: false,
      });
      store.appendGateHistory("cw-test-topic", {
        phase: "dev",
        action: "dev",
        gate: "medium-git",
        result: "pass",
        progressive: false,
      });
    });

    // 再 setEvidence
    store.transaction(() => {
      store.setEvidence("cw-test-topic", {
        closedAt: "2026-01-03T00:00:00.000Z",
        gateHistory: store.loadGateHistory("cw-test-topic"),
      });
    });

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.evidence).toBeDefined();
    expect(topic!.evidence!.closedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(topic!.evidence!.gateHistory).toHaveLength(2);
    expect(topic!.evidence!.gateHistory[0]!.phase).toBe("plan");
    expect(topic!.evidence!.gateHistory[1]!.phase).toBe("dev");
  });
});

// ── DAO: insertTestCases ────────────────────────────────────

describe("insertTestCases", () => {
  it("批量插入 testCase，初始 status=pending", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    store.transaction(() => {
      store.insertTestCases("cw-test-topic", [
        {
          id: "U1",
          layer: "mock",
          scenario: "test scenario",
          steps: "run test",
          expected: { text: "expected result" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "E1",
          layer: "real",
          scenario: "e2e scenario",
          steps: "spawn cli",
          expected: { text: "status=closed" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ]);
    });

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.testCases).toHaveLength(2);
    expect(topic!.testCases[0]!.id).toBe("U1");
    expect(topic!.testCases[0]!.status).toBe("pending");
    expect(topic!.testCases[1]!.id).toBe("E1");
    expect(topic!.testCases[1]!.layer).toBe("real");
  });
});

// ── DAO: insertTestCases 持久化 priority/redCheck ───────────

describe("insertTestCases 持久化 priority/redCheck", () => {
  it("priority (P0/P1/P2) 和 redCheck (true/false) 写入后 loadTopic 读回一致", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    store.transaction(() => {
      store.insertTestCases("cw-test-topic", [
        {
          id: "P0-red",
          layer: "mock",
          scenario: "core path red check",
          steps: "run test",
          expected: { text: "expected" },
          executor: "vitest",
          requiresScreenshot: false,
          priority: "P0",
          redCheck: true,
        },
        {
          id: "P1-no-red",
          layer: "real",
          scenario: "important feature no red check",
          steps: "spawn cli",
          expected: { text: "ok" },
          executor: "vitest",
          requiresScreenshot: false,
          priority: "P1",
          redCheck: false,
        },
        {
          id: "P2-red",
          layer: "mock",
          scenario: "enhancement with red check",
          steps: "run test",
          expected: { text: "enhanced" },
          executor: "vitest",
          requiresScreenshot: false,
          priority: "P2",
          redCheck: true,
        },
      ]);
    });

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.testCases).toHaveLength(3);

    const p0 = topic!.testCases.find((tc) => tc.id === "P0-red")!;
    expect(p0.priority).toBe("P0");
    expect(p0.redCheck).toBe(true);

    const p1 = topic!.testCases.find((tc) => tc.id === "P1-no-red")!;
    expect(p1.priority).toBe("P1");
    expect(p1.redCheck).toBe(false);

    const p2 = topic!.testCases.find((tc) => tc.id === "P2-red")!;
    expect(p2.priority).toBe("P2");
    expect(p2.redCheck).toBe(true);
  });

  it("priority/redCheck 未设置 → 读回 undefined（可选字段正确兜底）", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    store.transaction(() => {
      store.insertTestCases("cw-test-topic", [
        {
          id: "no-fields",
          layer: "mock",
          scenario: "no priority/redCheck",
          steps: "run test",
          expected: { text: "expected" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ]);
    });

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.testCases).toHaveLength(1);
    expect(topic!.testCases[0]!.priority).toBeUndefined();
    expect(topic!.testCases[0]!.redCheck).toBeUndefined();
  });

  it("priority 全部 P0/P1/P2 取值经过往返（round-trip）保持原值", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    const priorities: Priority[] = ["P0", "P1", "P2"];
    store.transaction(() => {
      store.insertTestCases(
        "cw-test-topic",
        priorities.map((p, i) => ({
          id: `tc-${p}-${i}`,
          layer: "mock" as const,
          scenario: `scenario-${p}`,
          steps: "steps",
          expected: { text: p },
          executor: "vitest",
          requiresScreenshot: false,
          priority: p,
          redCheck: i % 2 === 0,
        })),
      );
    });

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.testCases).toHaveLength(3);
    // 按 priority 字段聚合校验
    const byPriority = new Map(topic!.testCases.map((tc) => [tc.priority, tc.redCheck]));
    expect(byPriority.get("P0")).toBe(true);
    expect(byPriority.get("P1")).toBe(false);
    expect(byPriority.get("P2")).toBe(true);
  });
});

// ── DAO: replaceUnpassedTestCases 保留 passed ──────────────

describe("replaceUnpassedTestCases", () => {
  it("已 passed 的 testCase 保留，未 passed 的被新 testCase 替换", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    // 先插入 2 个 testCase
    store.transaction(() => {
      store.insertTestCases("cw-test-topic", [
        {
          id: "U1",
          layer: "mock",
          scenario: "old scenario",
          steps: "old steps",
          expected: { text: "old expected" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "U2",
          layer: "mock",
          scenario: "will pass",
          steps: "steps",
          expected: { text: "ok" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ]);
    });

    // 将 U2 标记为 passed
    store.transaction(() => {
      store.updateTestCase("cw-test-topic", "U2", {
        status: "passed",
        actual: { text: "ok" },
      });
    });

    // replan：替换未 passed 的（U1 被 U3 替换，U2 保留）
    store.transaction(() => {
      store.replaceUnpassedTestCases("cw-test-topic", [
        {
          id: "U3",
          layer: "mock",
          scenario: "new scenario",
          steps: "new steps",
          expected: { text: "new expected" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ]);
    });

    const topic = store.loadTopic("cw-test-topic");
    const ids = topic!.testCases.map((tc) => tc.id);
    expect(ids).toContain("U2"); // passed 的保留
    expect(ids).toContain("U3"); // 新插入
    expect(ids).not.toContain("U1"); // 未 passed 的被替换

    const u2 = topic!.testCases.find((tc) => tc.id === "U2")!;
    expect(u2.status).toBe("passed");
  });
});

// ── 文件损坏兜底 ────────────────────────────────────────────

describe("文件损坏兜底", () => {
  it("JSON.parse 失败 → 返回空库（不 crash）", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic())); // 正常初始化

    // 手动写坏 JSON
    writeFileSync(dbPath, "{ corrupted json !!! ");

    // 重新加载不应 crash，返回空库
    const store2 = makeStore();
    const topic = store2.loadTopic("cw-test-topic");
    expect(topic).toBeNull();
    expect(store2.listTopics()).toHaveLength(0);
  });
});

// ── stale-lock 清理（死进程 PID） ───────────────────────────

describe("stale-lock 清理", () => {
  it("lockfile 含死进程 PID → 自动清理后获取锁成功", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    // 手动写一个 stale lockfile：PID=本进程+1（几乎肯定不存在）+ 当前 ts
    const lockPath = dbPath + ".lock";
    const deadPid = process.pid + 1;
    writeFileSync(lockPath, `${deadPid}\n${Date.now()}\n`);

    // 新 CwStore 实例开 transaction → 应检测到死进程 PID → 清理 stale lock → 获取锁
    const store2 = makeStore();
    expect(() => {
      store2.transaction(() => {
        store2.updateStatus("cw-test-topic", "planned");
      });
    }).not.toThrow();

    // 验证写入成功（锁被正确获取+释放）
    const topic = store2.loadTopic("cw-test-topic");
    expect(topic!.status).toBe("planned");
  });
});

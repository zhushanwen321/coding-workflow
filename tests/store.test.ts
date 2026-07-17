/**
 * store 单测 — U12-U15（事务 + DAO）。
 *
 * 覆盖：transaction 异常 ROLLBACK、transaction 正常写入、loadTopic 不存在返回 null、
 * setWaveCommitted 幂等更新。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach,beforeEach, describe, expect, it } from "vitest";

import { CwStore } from "../src/store.js";
import type {
  AdrSeed,
  ClarifySeed,
  Priority,
  ReviewIssueSubmission,
  TestFixEntry,
  Topic,
} from "../src/types.js";

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
    clarifyRecords: [],
    specSections: [],
    adrs: [],
    reviewIssues: [],
    reviewTurn: 0,
    testFixLog: [],
    testTurn: 0,
    assessments: [],
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
      { id: "W1", dependsOn: [], changes: [{ file: "src/app.ts", description: "change1" }] },
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
      { id: "W1", dependsOn: [], changes: [{ file: "src/app.ts", description: "c1" }], priority: "P0" },
      { id: "W2", dependsOn: ["W1"], changes: [{ file: "src/app.ts", description: "c2" }], priority: "P2" },
      { id: "W3", dependsOn: [], changes: [{ file: "src/app.ts", description: "c3" }] }, // 不设 priority
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
  it("先 set review 再 set retrospect → 两者共存（merge 而非覆盖，FR-1 嵌套 Artifacts）", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    store.transaction(() => {
      store.setArtifacts("cw-test-topic", {
        review: {
          path: "/tmp/review.md",
          at: "2026-01-01T00:00:00.000Z",
        },
      });
    });
    store.transaction(() => {
      store.setArtifacts("cw-test-topic", {
        retrospect: {
          path: "/tmp/retrospect.md",
          at: "2026-01-02T00:00:00.000Z",
        },
      });
    });

    const topic = store.loadTopic("cw-test-topic");
    // FR-1: Artifacts 改为嵌套结构 { review: {path, at}, retrospect: {path, at} }
    expect(topic!.artifacts?.review?.path).toBe("/tmp/review.md");
    expect(topic!.artifacts?.retrospect?.path).toBe("/tmp/retrospect.md");
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
          expected: { type: "exact", text: "expected result" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "E1",
          layer: "real",
          scenario: "e2e scenario",
          steps: "spawn cli",
          expected: { type: "exact", text: "status=closed" },
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

  it("重复插入同 id 的 testCase → 去重，不累积", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    store.transaction(() => {
      store.insertTestCases("cw-test-topic", [
        { id: "U1", layer: "mock", scenario: "s", steps: "st",
          expected: { type: "exact", text: "r" }, executor: "vitest", requiresScreenshot: false },
      ]);
    });
    // 再次插入同 id
    store.transaction(() => {
      store.insertTestCases("cw-test-topic", [
        { id: "U1", layer: "mock", scenario: "s2", steps: "st2",
          expected: { type: "exact", text: "r2" }, executor: "vitest", requiresScreenshot: false },
        { id: "U2", layer: "real", scenario: "s", steps: "st",
          expected: { type: "exact", text: "r" }, executor: "vitest", requiresScreenshot: false },
      ]);
    });

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.testCases).toHaveLength(2); // U1 不重复，U2 新增
    expect(topic!.testCases.map((tc) => tc.id)).toEqual(["U1", "U2"]);
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
          expected: { type: "exact", text: "expected" },
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
          expected: { type: "exact", text: "ok" },
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
          expected: { type: "exact", text: "enhanced" },
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
          expected: { type: "exact", text: "expected" },
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
          expected: { type: "exact", text: p },
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
          expected: { type: "exact", text: "old expected" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "U2",
          layer: "mock",
          scenario: "will pass",
          steps: "steps",
          expected: { type: "exact", text: "ok" },
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
          expected: { type: "exact", text: "new expected" },
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

    // 手动写一个 stale lockfile：PID 远超任何系统的 pid_max（linux 4194304 / mac 99999）
    // → process.kill(pid, 0) 必抛 ESRCH → isProcessAlive 返回 false → 视为 stale。
    // 旧实现用 process.pid + 1，在 PID 密集环境（CI runner / 本地多进程）可能是活进程，
    // 导致 isStaleLock 误判为 false → retry 耗尽 → flaky fail。
    const lockPath = dbPath + ".lock";
    const deadPid = 99999999;
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

// ── clarify + adr DAO（progressive，create→plan 之间） ──────

describe("clarify + adr DAO", () => {
  /** 构造一个合法的 ClarifySeed（默认不含 answer，pending 状态）。 */
  function makeClarifySeed(overrides: Partial<ClarifySeed> = {}): ClarifySeed {
    return {
      kind: "technical",
      topic: "状态存储方案",
      assessment: "当前 store.ts 用 JSON + flock，并发写 >10 qps 时锁竞争明显。",
      question: "状态存储维持 JSON 还是迁移 SQLite？",
      ...overrides,
    };
  }

  /** 构造一个合法的 AdrSeed。 */
  function makeAdrSeed(overrides: Partial<AdrSeed> = {}): AdrSeed {
    return {
      title: "状态存储迁移 SQLite",
      context: "JSON + flock 并发弱",
      decision: "迁移 better-sqlite3",
      alternatives: ["维持 JSON + flock"],
      consequences: "并发好，引入原生依赖",
      ...overrides,
    };
  }

  it("appendClarifyRecord → 返回 CL1, loadTopic 拿到 clarifyRecords[0].id=CL1", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    const id = store.appendClarifyRecord("cw-test-topic", makeClarifySeed());
    expect(id).toBe("CL1");

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.clarifyRecords).toHaveLength(1);
    expect(topic!.clarifyRecords[0]!.id).toBe("CL1");
    expect(topic!.clarifyRecords[0]!.kind).toBe("technical");
    expect(topic!.clarifyRecords[0]!.createdAt).toBeDefined();
  });

  it("appendClarifyRecord 含 answer → status=resolved, resolvedAt 非空", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    store.appendClarifyRecord(
      "cw-test-topic",
      makeClarifySeed({ answer: "迁移 SQLite" }),
    );

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.clarifyRecords[0]!.status).toBe("resolved");
    expect(topic!.clarifyRecords[0]!.answer).toBe("迁移 SQLite");
    expect(topic!.clarifyRecords[0]!.resolvedAt).toBeDefined();
  });

  it("appendClarifyRecord 不含 answer → status=pending", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    store.appendClarifyRecord("cw-test-topic", makeClarifySeed());

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.clarifyRecords[0]!.status).toBe("pending");
    expect(topic!.clarifyRecords[0]!.resolvedAt).toBeUndefined();
  });

  it("appendAdr → 返回 0001, loadTopic 拿到 adrs[0].id=0001", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    const id = store.appendAdr("cw-test-topic", makeAdrSeed());
    expect(id).toBe("0001");

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.adrs).toHaveLength(1);
    expect(topic!.adrs[0]!.id).toBe("0001");
    expect(topic!.adrs[0]!.title).toBe("状态存储迁移 SQLite");
    // 缺省 status=accepted
    expect(topic!.adrs[0]!.status).toBe("accepted");
    expect(topic!.adrs[0]!.createdAt).toBeDefined();
  });

  it("updateClarifyRecord → patch adrId 后 loadTopic 读回 adrId", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    const clarifyId = store.appendClarifyRecord("cw-test-topic", makeClarifySeed());
    // 回填 adrId（模拟 handler 双写流程）
    store.updateClarifyRecord("cw-test-topic", clarifyId, { adrId: "0001" });

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.clarifyRecords[0]!.adrId).toBe("0001");
  });

  it("多条 appendClarifyRecord id 自增（CL1, CL2）", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    const id1 = store.appendClarifyRecord(
      "cw-test-topic",
      makeClarifySeed({ topic: "主题1" }),
    );
    const id2 = store.appendClarifyRecord(
      "cw-test-topic",
      makeClarifySeed({ topic: "主题2" }),
    );

    expect(id1).toBe("CL1");
    expect(id2).toBe("CL2");

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.clarifyRecords).toHaveLength(2);
    expect(topic!.clarifyRecords.map((c) => c.id)).toEqual(["CL1", "CL2"]);
  });

  it("多条 appendAdr id 自增 padStart（0001, 0002）", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    const id1 = store.appendAdr("cw-test-topic", makeAdrSeed({ title: "ADR1" }));
    const id2 = store.appendAdr("cw-test-topic", makeAdrSeed({ title: "ADR2" }));

    expect(id1).toBe("0001");
    expect(id2).toBe("0002");

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.adrs).toHaveLength(2);
    expect(topic!.adrs.map((a) => a.id)).toEqual(["0001", "0002"]);
  });
});

// ── runtimeEnv 持久化 ───────────────────────────────────────

describe("runtimeEnv 持久化", () => {
  it("insertTopic 带 runtimeEnv → loadTopic 读回", () => {
    const store = makeStore();
    const env = { agent: "Pi", llm: "GLM-5.2", cwVersion: "0.0.1" };
    store.transaction(() =>
      store.insertTopic(makeTopic({ topicId: "cw-env-1", runtimeEnv: env })),
    );

    const topic = store.loadTopic("cw-env-1");
    expect(topic!.runtimeEnv).toEqual(env);
  });

  it("insertTopic 无 runtimeEnv（旧 topic）→ loadTopic 读回 undefined", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic({ topicId: "cw-env-2" })));

    const topic = store.loadTopic("cw-env-2");
    expect(topic!.runtimeEnv).toBeUndefined();
  });

  it("runtimeEnv 通过 listTopics 也能读回", () => {
    const store = makeStore();
    const env = { agent: "Claude Code", llm: "Sonnet-4.5", cwVersion: "1.2.3" };
    store.transaction(() =>
      store.insertTopic(makeTopic({ topicId: "cw-env-3", runtimeEnv: env })),
    );

    const topics = store.listTopics();
    const topic = topics.find((t) => t.topicId === "cw-env-3");
    expect(topic!.runtimeEnv).toEqual(env);
  });
});

// ── W2: review / test issue tracking DAO ────────────────────

describe("appendReviewIssues", () => {
  it("写入 2 个 issue → loadTopic 读回 status=open, foundAtTurn=1, id 自增 R1/R2", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    const issues: ReviewIssueSubmission[] = [
      { severity: "must-fix", description: "缺少错误处理", dimension: "error-handling", ref: "src/app.ts:10" },
      { severity: "nit", description: "命名拼写", dimension: "design-consistency" },
    ];
    store.transaction(() => store.appendReviewIssues("cw-test-topic", 1, issues));

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.reviewIssues).toHaveLength(2);
    expect(topic!.reviewIssues[0]!.id).toBe("R1");
    expect(topic!.reviewIssues[0]!.status).toBe("open");
    expect(topic!.reviewIssues[0]!.foundAtTurn).toBe(1);
    expect(topic!.reviewIssues[0]!.severity).toBe("must-fix");
    // FR-3: ReviewIssue 升级 — dimension 必填，file→ref
    expect(topic!.reviewIssues[0]!.dimension).toBe("error-handling");
    expect(topic!.reviewIssues[0]!.ref).toBe("src/app.ts:10");
    expect(topic!.reviewIssues[1]!.id).toBe("R2");
    expect(topic!.reviewIssues[1]!.foundAtTurn).toBe(1);
    expect(topic!.reviewIssues[1]!.severity).toBe("nit");
    expect(topic!.reviewIssues[1]!.dimension).toBe("design-consistency");
    expect(topic!.reviewIssues[1]!.ref).toBeUndefined();
  });

  it("多轮追加：第 2 轮追加 1 个 → id 自增到 R3, foundAtTurn=2", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));
    store.transaction(() =>
      store.appendReviewIssues("cw-test-topic", 1, [
        { severity: "must-fix", description: "i1" },
      ]),
    );
    store.transaction(() =>
      store.appendReviewIssues("cw-test-topic", 2, [
        { severity: "should-fix", description: "i2" },
      ]),
    );

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.reviewIssues).toHaveLength(2);
    expect(topic!.reviewIssues[1]!.id).toBe("R2");
    expect(topic!.reviewIssues[1]!.foundAtTurn).toBe(2);
  });

  it("跨实例 reload → reviewIssues 持久化到磁盘", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));
    store.transaction(() =>
      store.appendReviewIssues("cw-test-topic", 1, [
        { severity: "must-fix", description: "persist check" },
      ]),
    );

    const reloaded = new CwStore(dbPath);
    const topic = reloaded.loadTopic("cw-test-topic");
    expect(topic!.reviewIssues).toHaveLength(1);
    expect(topic!.reviewIssues[0]!.description).toBe("persist check");
  });
});

describe("fixReviewIssue", () => {
  it("标记 issue fixed → status=fixed, fix.commitHash/resolution/fixedAtTurn 正确", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));
    store.transaction(() =>
      store.appendReviewIssues("cw-test-topic", 1, [
        { severity: "must-fix", description: "bug" },
      ]),
    );

    store.transaction(() =>
      store.fixReviewIssue("cw-test-topic", "R1", {
        commitHash: "abc123",
        resolution: "加了 try/catch",
        fixedAtTurn: 2,
      }),
    );

    const topic = store.loadTopic("cw-test-topic");
    const issue = topic!.reviewIssues[0]!;
    expect(issue.status).toBe("fixed");
    expect(issue.fix).toBeDefined();
    expect(issue.fix!.commitHash).toBe("abc123");
    expect(issue.fix!.resolution).toBe("加了 try/catch");
    expect(issue.fix!.fixedAtTurn).toBe(2);
  });

  it("issueId 不存在 → 静默忽略（不 throw）", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));
    store.transaction(() =>
      store.appendReviewIssues("cw-test-topic", 1, [
        { severity: "must-fix", description: "bug" },
      ]),
    );

    expect(() =>
      store.transaction(() =>
        store.fixReviewIssue("cw-test-topic", "R999", {
          commitHash: "x",
          resolution: "x",
          fixedAtTurn: 2,
        }),
      ),
    ).not.toThrow();

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.reviewIssues[0]!.status).toBe("open");
  });

  it("topicId 不存在 → 静默忽略（不 throw）", () => {
    const store = makeStore();
    expect(() =>
      store.transaction(() =>
        store.fixReviewIssue("cw-nonexistent", "R1", {
          commitHash: "x",
          resolution: "x",
          fixedAtTurn: 1,
        }),
      ),
    ).not.toThrow();
  });
});

describe("appendTestFix", () => {
  it("写入 1 条 → loadTopic 读回 turn/caseId/commitHash 正确", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    const entry: TestFixEntry = {
      caseId: "E1",
      commitHash: "def456",
      resolution: "修正了 expected 匹配",
      turn: 2,
    };
    store.transaction(() => store.appendTestFix("cw-test-topic", entry));

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.testFixLog).toHaveLength(1);
    expect(topic!.testFixLog[0]!.caseId).toBe("E1");
    expect(topic!.testFixLog[0]!.commitHash).toBe("def456");
    expect(topic!.testFixLog[0]!.resolution).toBe("修正了 expected 匹配");
    expect(topic!.testFixLog[0]!.turn).toBe(2);
  });

  it("多次追加 → 顺序保留（append-only）", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));
    store.transaction(() =>
      store.appendTestFix("cw-test-topic", {
        caseId: "E1",
        commitHash: "h1",
        resolution: "fix1",
        turn: 1,
      }),
    );
    store.transaction(() =>
      store.appendTestFix("cw-test-topic", {
        caseId: "E2",
        commitHash: "h2",
        resolution: "fix2",
        turn: 2,
      }),
    );

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.testFixLog).toHaveLength(2);
    expect(topic!.testFixLog[0]!.caseId).toBe("E1");
    expect(topic!.testFixLog[1]!.caseId).toBe("E2");
  });
});

describe("incReviewTurn / incTestTurn", () => {
  it("incReviewTurn 调用后 turn +1（从 0 → 1 → 2）", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    let topic = store.loadTopic("cw-test-topic");
    expect(topic!.reviewTurn).toBe(0);

    store.transaction(() => store.incReviewTurn("cw-test-topic"));
    topic = store.loadTopic("cw-test-topic");
    expect(topic!.reviewTurn).toBe(1);

    store.transaction(() => store.incReviewTurn("cw-test-topic"));
    topic = store.loadTopic("cw-test-topic");
    expect(topic!.reviewTurn).toBe(2);
  });

  it("incTestTurn 调用后 turn +1（从 0 → 1）", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    expect(store.loadTopic("cw-test-topic")!.testTurn).toBe(0);
    store.transaction(() => store.incTestTurn("cw-test-topic"));
    expect(store.loadTopic("cw-test-topic")!.testTurn).toBe(1);
  });

  it("topicId 不存在 → 静默忽略（不 throw）", () => {
    const store = makeStore();
    expect(() =>
      store.transaction(() => store.incReviewTurn("cw-nope")),
    ).not.toThrow();
    expect(() =>
      store.transaction(() => store.incTestTurn("cw-nope")),
    ).not.toThrow();
  });
});

describe("resetReviewLoop / resetTestLoop", () => {
  it("resetReviewLoop → reviewIssues=[], reviewTurn=0", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));
    store.transaction(() =>
      store.appendReviewIssues("cw-test-topic", 1, [
        { severity: "must-fix", description: "x" },
        { severity: "nit", description: "y" },
      ]),
    );
    store.transaction(() => store.incReviewTurn("cw-test-topic"));

    let topic = store.loadTopic("cw-test-topic");
    expect(topic!.reviewIssues).toHaveLength(2);
    expect(topic!.reviewTurn).toBe(1);

    store.transaction(() => store.resetReviewLoop("cw-test-topic"));
    topic = store.loadTopic("cw-test-topic");
    expect(topic!.reviewIssues).toEqual([]);
    expect(topic!.reviewTurn).toBe(0);
  });

  it("resetTestLoop → testFixLog=[], testTurn=0", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));
    store.transaction(() =>
      store.appendTestFix("cw-test-topic", {
        caseId: "E1",
        commitHash: "h",
        resolution: "r",
        turn: 1,
      }),
    );
    store.transaction(() => store.incTestTurn("cw-test-topic"));

    let topic = store.loadTopic("cw-test-topic");
    expect(topic!.testFixLog).toHaveLength(1);
    expect(topic!.testTurn).toBe(1);

    store.transaction(() => store.resetTestLoop("cw-test-topic"));
    topic = store.loadTopic("cw-test-topic");
    expect(topic!.testFixLog).toEqual([]);
    expect(topic!.testTurn).toBe(0);
  });

  it("reset 后再追加 → id 从 R1 重新自增（数组已清空）", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));
    store.transaction(() =>
      store.appendReviewIssues("cw-test-topic", 1, [
        { severity: "must-fix", description: "first" },
      ]),
    );
    store.transaction(() => store.resetReviewLoop("cw-test-topic"));
    store.transaction(() =>
      store.appendReviewIssues("cw-test-topic", 1, [
        { severity: "nit", description: "after reset" },
      ]),
    );

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.reviewIssues).toHaveLength(1);
    expect(topic!.reviewIssues[0]!.id).toBe("R1");
  });
});

// ── 旧数据向后兼容：reviewIssues 等字段缺失时兜底默认值 ──────

describe("旧数据向后兼容（issue tracking 字段缺失）", () => {
  it("insertTopic 不传 reviewIssues → loadTopic 读回 [] / 0（types 必填，store 兜底）", () => {
    // types.ts 的 Topic 把 reviewIssues 等设为必填，但 TopicRecord 是可选（向后兼容旧 _cw.json）。
    // 这里通过 makeTopic 默认值写入（[] / 0），验证 round-trip 一致。
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.reviewIssues).toEqual([]);
    expect(topic!.reviewTurn).toBe(0);
    expect(topic!.testFixLog).toEqual([]);
    expect(topic!.testTurn).toBe(0);
  });

  it("手工写缺字段的旧 JSON → loadTopic 用 ?? 兜底（不 crash）", () => {
    // 模拟旧 _cw.json：topics 数组里的 record 不含 reviewIssues/reviewTurn/testFixLog/testTurn。
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));
    // 读出磁盘 JSON，删掉新字段后再写回，模拟旧数据。
    const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
      topics: Array<Record<string, unknown>>;
    };
    for (const t of raw.topics) {
      delete t.reviewIssues;
      delete t.reviewTurn;
      delete t.testFixLog;
      delete t.testTurn;
    }
    writeFileSync(dbPath, JSON.stringify(raw));

    const reloaded = new CwStore(dbPath);
    const topic = reloaded.loadTopic("cw-test-topic");
    expect(topic).not.toBeNull();
    expect(topic!.reviewIssues).toEqual([]);
    expect(topic!.reviewTurn).toBe(0);
    expect(topic!.testFixLog).toEqual([]);
    expect(topic!.testTurn).toBe(0);
  });
});

// ── FR-1 / AC-4: Artifacts 旧格式迁移 ──────────────────────────

describe("FR-1: Artifacts 旧格式迁移（AC-4）", () => {
  it("平铺格式（reviewPath/reviewAt/retrospectPath/retrospectAt）加载后迁移为嵌套", () => {
    // 直接操作 _cw.json 写入旧格式 artifacts，再 loadTopic 验证迁移。
    // 参照 store.test.ts 现有 store 构造模式（makeStore + makeTopic）。
    const store = makeStore();
    store.transaction(() =>
      store.insertTopic(makeTopic({ topicId: "cw-test-migrate" })),
    );

    // 手动写入旧格式 artifacts 到 _cw.json（绕过 store API，模拟旧数据）。
    const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
      topics: Array<Record<string, unknown>>;
    };
    const t = raw.topics.find((x) => x.topicId === "cw-test-migrate");
    t!.artifacts = {
      reviewPath: "/tmp/old-review.md",
      reviewAt: "2026-01-01T00:00:00.000Z",
      retrospectPath: "/tmp/old-retrospect.md",
      retrospectAt: "2026-01-02T00:00:00.000Z",
    };
    writeFileSync(dbPath, JSON.stringify(raw));

    // CwStore 的 fileData 是内存缓存的，手动改 _cw.json 后需新实例重新加载。
    const reloaded = new CwStore(dbPath);
    const loaded = reloaded.loadTopic("cw-test-migrate");
    expect(loaded).not.toBeNull();
    expect(loaded!.artifacts?.review?.path).toBe("/tmp/old-review.md");
    expect(loaded!.artifacts?.review?.at).toBe("2026-01-01T00:00:00.000Z");
    expect(loaded!.artifacts?.retrospect?.path).toBe("/tmp/old-retrospect.md");
    expect(loaded!.artifacts?.retrospect?.at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("旧 reviewIssues category/file 迁移为 dimension/ref（FR-3）", () => {
    // 同理，手动写入旧格式 reviewIssues，loadTopic 验证迁移。
    const store = makeStore();
    store.transaction(() =>
      store.insertTopic(makeTopic({ topicId: "cw-test-migrate-issue" })),
    );

    const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
      topics: Array<Record<string, unknown>>;
    };
    const t = raw.topics.find((x) => x.topicId === "cw-test-migrate-issue");
    t!.reviewIssues = [
      {
        id: "R1",
        category: "type-safety",
        severity: "must-fix",
        description: "test",
        file: "src/x.ts:42",
        status: "open",
        foundAtTurn: 1,
      },
    ];
    writeFileSync(dbPath, JSON.stringify(raw));

    const reloaded = new CwStore(dbPath);
    const loaded = reloaded.loadTopic("cw-test-migrate-issue");
    expect(loaded).not.toBeNull();
    expect(loaded!.reviewIssues[0]!.dimension).toBe("type-safety");
    expect(loaded!.reviewIssues[0]!.ref).toBe("src/x.ts:42");
  });
});

// ── FR-4/5: spec_review / plan_review issue DAO ────────────────

describe("FR-4/5: spec_review/plan_review issue DAO", () => {
  it("appendSpecReviewIssues 分配 SR 前缀 id + foundAtTurn", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    const issues: ReviewIssueSubmission[] = [
      { severity: "must-fix", description: "spec 缺 FR", dimension: "completeness", ref: "FR-3" },
      { severity: "should-fix", description: "口径不一致", dimension: "consistency" },
    ];
    store.transaction(() => store.appendSpecReviewIssues("cw-test-topic", 1, issues));

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.specReviewIssues).toHaveLength(2);
    expect(topic!.specReviewIssues[0]!.id).toBe("SR1");
    expect(topic!.specReviewIssues[0]!.status).toBe("open");
    expect(topic!.specReviewIssues[0]!.foundAtTurn).toBe(1);
    expect(topic!.specReviewIssues[0]!.dimension).toBe("completeness");
    expect(topic!.specReviewIssues[0]!.ref).toBe("FR-3");
    expect(topic!.specReviewIssues[1]!.id).toBe("SR2");
    expect(topic!.specReviewIssues[1]!.foundAtTurn).toBe(1);
  });

  it("fixSpecReviewIssue 标记 fixed + 记 resolution", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));
    store.transaction(() =>
      store.appendSpecReviewIssues("cw-test-topic", 1, [
        { severity: "must-fix", description: "spec 缺 FR", dimension: "completeness" },
      ]),
    );

    store.transaction(() =>
      store.fixSpecReviewIssue("cw-test-topic", "SR1", {
        resolution: "补了 FR-3 章节",
        fixedAtTurn: 2,
      }),
    );

    const topic = store.loadTopic("cw-test-topic");
    const issue = topic!.specReviewIssues[0]!;
    expect(issue.status).toBe("fixed");
    expect(issue.fix).toBeDefined();
    expect(issue.fix!.resolution).toBe("补了 FR-3 章节");
    expect(issue.fix!.fixedAtTurn).toBe(2);
    // commitHash 可选，spec 修复未传 → undefined
    expect(issue.fix!.commitHash).toBeUndefined();
  });

  it("incSpecReviewTurn 递增", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    expect(store.loadTopic("cw-test-topic")!.specReviewTurn).toBe(0);
    store.transaction(() => store.incSpecReviewTurn("cw-test-topic"));
    expect(store.loadTopic("cw-test-topic")!.specReviewTurn).toBe(1);
    store.transaction(() => store.incSpecReviewTurn("cw-test-topic"));
    expect(store.loadTopic("cw-test-topic")!.specReviewTurn).toBe(2);
  });

  it("appendPlanReviewIssues 分配 PR 前缀 id + foundAtTurn", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    const issues: ReviewIssueSubmission[] = [
      { severity: "must-fix", description: "wave 未覆盖 FR", dimension: "coverage", ref: "W2" },
      { severity: "nit", description: "架构分层不清", dimension: "architecture" },
    ];
    store.transaction(() => store.appendPlanReviewIssues("cw-test-topic", 1, issues));

    const topic = store.loadTopic("cw-test-topic");
    expect(topic!.planReviewIssues).toHaveLength(2);
    expect(topic!.planReviewIssues[0]!.id).toBe("PR1");
    expect(topic!.planReviewIssues[0]!.status).toBe("open");
    expect(topic!.planReviewIssues[0]!.foundAtTurn).toBe(1);
    expect(topic!.planReviewIssues[0]!.dimension).toBe("coverage");
    expect(topic!.planReviewIssues[0]!.ref).toBe("W2");
    expect(topic!.planReviewIssues[1]!.id).toBe("PR2");
    expect(topic!.planReviewIssues[1]!.foundAtTurn).toBe(1);
  });

  it("fixPlanReviewIssue 标记 fixed", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));
    store.transaction(() =>
      store.appendPlanReviewIssues("cw-test-topic", 1, [
        { severity: "should-fix", description: "wave 缺依赖", dimension: "feasibility" },
      ]),
    );

    store.transaction(() =>
      store.fixPlanReviewIssue("cw-test-topic", "PR1", {
        commitHash: "abc123",
        resolution: "补了 dependsOn",
        fixedAtTurn: 1,
      }),
    );

    const topic = store.loadTopic("cw-test-topic");
    const issue = topic!.planReviewIssues[0]!;
    expect(issue.status).toBe("fixed");
    expect(issue.fix!.commitHash).toBe("abc123");
    expect(issue.fix!.resolution).toBe("补了 dependsOn");
    expect(issue.fix!.fixedAtTurn).toBe(1);
  });

  it("incPlanReviewTurn 递增", () => {
    const store = makeStore();
    store.transaction(() => store.insertTopic(makeTopic()));

    expect(store.loadTopic("cw-test-topic")!.planReviewTurn).toBe(0);
    store.transaction(() => store.incPlanReviewTurn("cw-test-topic"));
    expect(store.loadTopic("cw-test-topic")!.planReviewTurn).toBe(1);
    store.transaction(() => store.incPlanReviewTurn("cw-test-topic"));
    expect(store.loadTopic("cw-test-topic")!.planReviewTurn).toBe(2);
  });
});

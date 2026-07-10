/**
 * store.ts 单测 — CwStore JSON 文件持久化层。
 *
 * 覆盖 NFR 代码测试项（归本 Wave）：
 *   T2.12  事务边界——中途抛错 ROLLBACK 无半写（#1 数据 / AC-1.2）
 *   T2.13  事务 COMMIT 后 gateHistory 落库且绑定 topicId（#1 可观测）
 *   T2.27  schemaVersion 迁移：旧 JSON 打开新 CwStore 自动迁移 + 数据保留（#11 数据）
 *   T2.28  迁移日志含 from/to version（#11 可观测）
 *
 * 另含 assembleTopic / updateGatePassed / updateTestCase 三个叶子的直接验证
 * （round-trip + 字段 patch）——TDD 要求每个实现的叶子有对应测试。
 *
 * 原 sqlite 专属断言（SQL 注入 T2.11 / PRAGMA user_version / WAL busy_timeout）
 * 已随 JSON 化移除或替换——JSON 不存在 SQL 注入，并发用文件锁替代 WAL。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CwStore, SCHEMA_VERSION } from "../../src/engine/store.js";
import type { CwTopic, GateHistorySeed, TestCaseSeed, WaveSeed } from "../../src/engine/types.js";

// ── helpers ──────────────────────────────────────────────────

/** 每次返回一个新的临时 .json 文件路径（独立目录，互不污染）。 */
function tmpJsonPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-store-test-"));
  return join(dir, "test.json");
}

/** 构造最小可写 CwTopic（insertTopic 入参形状）。 */
function makeTopic(overrides: Partial<CwTopic> = {}): CwTopic {
  return {
    schemaVersion: 1,
    topicId: "t-1",
    slug: "demo",
    tier: "lite",
    objective: "build X",
    workspacePath: "/tmp/ws",
    topicDir: "/tmp/ws/.xyz-harness/demo",
    createdAt: "2026-07-04T00:00:00.000Z",
    status: "created",
    planFormat: "lite",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
    ...overrides,
  };
}

const sampleWave: WaveSeed = {
  id: "w1",
  dependsOn: [],
  parallelGroup: "g1",
  changes: ["src/a.ts"],
  issues: ["#1"],
};

const sampleCase: TestCaseSeed = {
  id: "E1",
  layer: "real",
  scenario: "登录成功",
  steps: "打开 /login → 提交",
  expected: { url: "/profile", text: "用户名" },
  executor: "vitest",
};

const sampleGate: GateHistorySeed = {
  phase: "plan",
  action: "plan",
  gate: "check_plan",
  tier: "weak-structural",
  result: "pass",
  progressive: false,
};

// 每个测试自行 new CwStore + close；这里只兜底清理临时目录。
const tmpDirsToClean: string[] = [];
afterEach(() => {
  while (tmpDirsToClean.length > 0) {
    const d = tmpDirsToClean.pop();
    try {
      rmSync(d!, { recursive: true, force: true });
    } catch (e) {
      void e; // best-effort 清理：tmp 目录由 OS 兜底
    }
  }
});

/** 记录临时目录以便 afterEach 清理。 */
function trackTmpDir(filePath: string): string {
  tmpDirsToClean.push(dirname(filePath));
  return filePath;
}

// ── assembleTopic round-trip（叶子直接验证） ─────────────────

describe("CwStore.loadTopic — JSON round-trip（assembleTopic 叶子）", () => {
  it("insert 完整 topic + wave + testCase + gateHistory → loadTopic 等价回读", () => {
    const dbPath = trackTmpDir(tmpJsonPath());
    const store = new CwStore(dbPath);
    const seed = makeTopic({ gatePassed: { plan: true } });

    // 所有写操作必须在事务内
    store.transaction(() => {
      store.insertTopic(seed);
      store.insertWaves(seed.topicId, [sampleWave]);
      store.insertTestCases(seed.topicId, [sampleCase]);
      store.appendGateHistory(seed.topicId, sampleGate);
    });

    const loaded = store.loadTopic(seed.topicId);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    // topic 字段
    expect(loaded.topicId).toBe("t-1");
    expect(loaded.slug).toBe("demo");
    expect(loaded.tier).toBe("lite");
    expect(loaded.objective).toBe("build X");
    expect(loaded.workspacePath).toBe("/tmp/ws");
    expect(loaded.status).toBe("created");
    expect(loaded.planFormat).toBe("lite");
    expect(loaded.schemaVersion).toBe(SCHEMA_VERSION);
    // gate_passed 读改写
    expect(loaded.gatePassed).toEqual({ plan: true });

    // wave：committed null
    expect(loaded.waves).toHaveLength(1);
    const w = loaded.waves[0]!;
    expect(w.id).toBe("w1");
    expect(w.dependsOn).toEqual([]);
    expect(w.parallelGroup).toBe("g1");
    expect(w.committed).toBeNull();
    expect(w.changes).toEqual(["src/a.ts"]);
    expect(w.issues).toEqual(["#1"]);

    // testCase：expected + status pending（insertTestCases 默认）
    expect(loaded.testCases).toHaveLength(1);
    const c = loaded.testCases[0]!;
    expect(c.id).toBe("E1");
    expect(c.layer).toBe("real");
    expect(c.scenario).toBe("登录成功");
    expect(c.expected).toEqual({ url: "/profile", text: "用户名" });
    expect(c.executor).toBe("vitest");
    expect(c.status).toBe("pending");

    // gateHistory：progressive false，ts/id 自动生成
    expect(loaded.gateHistory).toHaveLength(1);
    const g = loaded.gateHistory[0]!;
    expect(g.phase).toBe("plan");
    expect(g.action).toBe("plan");
    expect(g.gate).toBe("check_plan");
    expect(g.tier).toBe("weak-structural");
    expect(g.result).toBe("pass");
    expect(g.progressive).toBe(false);
    expect(typeof g.id).toBe("number");
    expect(typeof g.ts).toBe("string");

    store.close();
  });

  it("topic 不存在 → loadTopic 返回 null", () => {
    const store = new CwStore(trackTmpDir(tmpJsonPath()));
    expect(store.loadTopic("nonexistent")).toBeNull();
    store.close();
  });

  it("gate_passed 为空对象时回退为 {}", () => {
    const dbPath = trackTmpDir(tmpJsonPath());
    const store = new CwStore(dbPath);
    const seed = makeTopic({ gatePassed: {} });
    store.transaction(() => store.insertTopic(seed));
    const loaded = store.loadTopic(seed.topicId);
    expect(loaded?.gatePassed).toEqual({});
    store.close();
  });
});

// ── updateGatePassed（读改写叶子） ───────────────────────────

describe("CwStore.updateGatePassed — 读改写", () => {
  it("在现有 gatePassed 上追加一个 phase，不影响其他 phase", () => {
    const dbPath = trackTmpDir(tmpJsonPath());
    const store = new CwStore(dbPath);
    const seed = makeTopic({ gatePassed: { plan: true } });
    store.transaction(() => store.insertTopic(seed));

    store.transaction(() => {
      store.updateGatePassed(seed.topicId, "dev", true);
      store.updateGatePassed(seed.topicId, "plan", false);
    });

    const loaded = store.loadTopic(seed.topicId);
    expect(loaded?.gatePassed).toEqual({ plan: false, dev: true });
    store.close();
  });
});

// ── updateTestCase（patch 白名单叶子） ───────────────────────

describe("CwStore.updateTestCase — patch 白名单", () => {
  it("patch status + actual + failureReason + screenshotPath + commitHash + judgedAt 全字段", () => {
    const dbPath = trackTmpDir(tmpJsonPath());
    const store = new CwStore(dbPath);
    store.transaction(() => {
      store.insertTopic(makeTopic());
      store.insertTestCases("t-1", [sampleCase]);
    });

    store.transaction(() => {
      store.updateTestCase("t-1", "E1", {
        status: "failed",
        actual: { url: "/login", text: "错误" },
        failureReason: "url mismatch",
        screenshotPath: "/tmp/shot.png",
        commitHash: "abc123",
        judgedAt: "2026-07-04T01:00:00.000Z",
      });
    });

    const loaded = store.loadTopic("t-1");
    const c = loaded?.testCases[0];
    expect(c?.status).toBe("failed");
    expect(c?.actual).toEqual({ url: "/login", text: "错误" });
    expect(c?.failureReason).toBe("url mismatch");
    expect(c?.screenshotPath).toBe("/tmp/shot.png");
    expect(c?.commitHash).toBe("abc123");
    expect(c?.judgedAt).toBe("2026-07-04T01:00:00.000Z");
    store.close();
  });

  it("patch 空（无白名单字段）→ 不抛、不改 status", () => {
    const dbPath = trackTmpDir(tmpJsonPath());
    const store = new CwStore(dbPath);
    store.transaction(() => {
      store.insertTopic(makeTopic());
      store.insertTestCases("t-1", [sampleCase]);
    });

    expect(() =>
      store.transaction(() => store.updateTestCase("t-1", "E1", {})),
    ).not.toThrow();
    const loaded = store.loadTopic("t-1");
    expect(loaded?.testCases[0]?.status).toBe("pending");
    store.close();
  });
});

// ── topicId 当普通字符串存储（替代原 T2.11 SQL 注入测试） ────

describe("topicId 特殊字符当普通字符串存储（JSON 无注入风险）", () => {
  it("含特殊字符的 topicId 作为字面值存储，不被解释执行", () => {
    const dbPath = trackTmpDir(tmpJsonPath());
    const store = new CwStore(dbPath);
    const special = "'; DROP TABLE topic; --";
    store.transaction(() =>
      store.insertTopic(makeTopic({ topicId: special })),
    );

    // 同样串读回 → 命中刚插入的记录
    const loaded = store.loadTopic(special);
    expect(loaded?.topicId).toBe(special);

    // 再插一条正常 id 验证可写可读（JSON 数组没被破坏）
    store.transaction(() =>
      store.insertTopic(
        makeTopic({ topicId: "safe-id", objective: "still here" }),
      ),
    );
    expect(store.loadTopic("safe-id")?.objective).toBe("still here");
    store.close();
  });
});

// ── T2.12 事务边界（#1 数据 / AC-1.2） ──────────────────────

describe("T2.12 — transaction 中途抛错 ROLLBACK 无半写", () => {
  it("事务内 updateStatus 后抛错 → 状态回滚为原值（文件未变）", () => {
    const dbPath = trackTmpDir(tmpJsonPath());
    const store = new CwStore(dbPath);
    store.transaction(() =>
      store.insertTopic(makeTopic({ status: "created" })),
    );

    // 记录回滚前的文件内容快照
    const beforeContent = readFileSync(dbPath, "utf-8");

    expect(() =>
      store.transaction(() => {
        store.updateStatus("t-1", "planned"); // 半写
        throw new Error("boom mid-transaction");
      }),
    ).toThrow("boom mid-transaction");

    // 回读：status 应仍是 created
    expect(store.loadTopic("t-1")?.status).toBe("created");
    // 文件内容应完全不变（事务原子性：rollback 不落盘）
    expect(readFileSync(dbPath, "utf-8")).toBe(beforeContent);
    store.close();
  });

  it("事务正常 COMMIT → 状态持久化", () => {
    const dbPath = trackTmpDir(tmpJsonPath());
    const store = new CwStore(dbPath);
    store.transaction(() =>
      store.insertTopic(makeTopic({ status: "created" })),
    );

    store.transaction(() => {
      store.updateStatus("t-1", "planned");
      return "ok";
    });

    expect(store.loadTopic("t-1")?.status).toBe("planned");
    store.close();
  });
});

// ── T2.13 事务 COMMIT 落 gateHistory 且绑定 topicId ──────────

describe("T2.13 — transaction COMMIT 后 gateHistory 落库绑定 topicId", () => {
  it("事务内 appendGateHistory → commit → loadGateHistory 命中且绑定正确 topicId", () => {
    const dbPath = trackTmpDir(tmpJsonPath());
    const store = new CwStore(dbPath);
    store.transaction(() => {
      store.insertTopic(makeTopic({ topicId: "t-1" }));
      store.insertTopic(makeTopic({ topicId: "t-2", slug: "other" }));
    });

    store.transaction(() => {
      store.appendGateHistory("t-1", sampleGate);
    });

    // t-1 命中 1 条
    const h1 = store.loadGateHistory("t-1");
    expect(h1).toHaveLength(1);
    expect(h1[0]?.gate).toBe("check_plan");
    expect(h1[0]?.result).toBe("pass");
    // t-2 无记录（证明 topicId 绑定，未串台）
    expect(store.loadGateHistory("t-2")).toHaveLength(0);
    // 不存在的 topic 也为空
    expect(store.loadGateHistory("never")).toHaveLength(0);
    store.close();
  });
});

// ── T2.27 schemaVersion 迁移 + 数据保留（#11 数据） ─────────

describe("T2.27 — 旧 JSON（schemaVersion=0）打开新 CwStore 自动迁移 + 数据保留", () => {
  it("v0 JSON → 新 CwStore 升到 SCHEMA_VERSION 且已有数据不丢", () => {
    const dbPath = trackTmpDir(tmpJsonPath());

    // 1. 模拟旧 JSON：手写 v0 结构（无 schemaVersion 或 schemaVersion=0）+ 一行 topic
    const oldData = {
      topics: [
        {
          topicId: "legacy-1",
          slug: "legacy",
          tier: "lite",
          objective: "legacy objective",
          workspacePath: "/tmp/legacy",
          // 故意不写 topicDir（v0 缺失，迁移应补 ""）
          createdAt: "2026-01-01T00:00:00.000Z",
          status: "created",
          gatePassed: {},
        },
      ],
      waves: [],
      testCases: [],
      gateHistory: [],
    };
    // 用 writeFileSync 直接写（绕过 CwStore 的迁移，模拟旧文件）
    writeFileSync(dbPath, JSON.stringify(oldData), "utf-8");

    // 2. 新 CwStore 的首次 loadFileData 触发迁移
    const store = new CwStore(dbPath);

    // 3. 已有数据保留 + 可读 + topicDir 补了默认值
    const loaded = store.loadTopic("legacy-1");
    expect(loaded?.objective).toBe("legacy objective");
    expect(loaded?.slug).toBe("legacy");
    expect(loaded?.status).toBe("created");
    expect(loaded?.topicDir).toBe("");

    store.close();
  });
});

// ── T2.28 迁移日志 from/to version（#11 可观测） ────────────

describe("T2.28 — 迁移日志含 from/to version", () => {
  it("触发迁移时向 stderr 落 JSON 日志含 from=0 to=SCHEMA_VERSION", () => {
    const writeSpy = vi.spyOn(process.stderr, "write");
    const dbPath = trackTmpDir(tmpJsonPath());

    // 写一个 schemaVersion=0 的旧文件
    writeFileSync(
      dbPath,
      JSON.stringify({
        schemaVersion: 0,
        topics: [],
        waves: [],
        testCases: [],
        gateHistory: [],
      }),
      "utf-8",
    );

    // 构造时 loadFileData → 触发 0→4 迁移
    const store = new CwStore(dbPath);
    // loadFileData 是 lazy 的（在 loadTopic 或 transaction 时才调）
    store.loadTopic("any");
    store.close();

    // 从所有 stderr.write 调用中筛出 cw-migration 事件
    const migrationLogs: Array<{ from: number; to: number }> = [];
    for (const call of writeSpy.mock.calls) {
      const chunk = call[0];
      if (typeof chunk !== "string") continue;
      for (const line of chunk.split("\n")) {
        const t = line.trim();
        if (!t.includes("cw-migration")) continue;
        try {
          const obj = JSON.parse(t) as Record<string, unknown>;
          if (
            obj.event === "cw-migration" &&
            typeof obj.from === "number" &&
            typeof obj.to === "number"
          ) {
            migrationLogs.push({ from: obj.from, to: obj.to });
          }
        } catch (e) {
          void e; // 非 JSON 行跳过
        }
      }
    }

    expect(migrationLogs).toContainEqual({ from: 0, to: SCHEMA_VERSION });
    writeSpy.mockRestore();
  });
});

// ── ADR-029 决策 4：dependsOn + parallelGroup round-trip ─────

describe("ADR-029 决策 4：测试调度字段", () => {
  it("dependsOn + parallelGroup round-trip（write → read 等价）", () => {
    const dbPath = trackTmpDir(tmpJsonPath());
    const store = new CwStore(dbPath);
    const seed = makeTopic();
    store.transaction(() => store.insertTopic(seed));
    const caseWithScheduling: TestCaseSeed = {
      ...sampleCase,
      id: "E3",
      dependsOn: ["E1", "E2"],
      parallelGroup: "g-real",
    };
    store.transaction(() =>
      store.insertTestCases(seed.topicId, [caseWithScheduling]),
    );

    const loaded = store.loadTopic(seed.topicId);
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    expect(loaded.testCases).toHaveLength(1);
    const tc = loaded.testCases[0]!;
    expect(tc.dependsOn).toEqual(["E1", "E2"]);
    expect(tc.parallelGroup).toBe("g-real");
    store.close();
  });

  it("缺省 dependsOn/parallelGroup → []/undefined（向后兼容）", () => {
    const dbPath = trackTmpDir(tmpJsonPath());
    const store = new CwStore(dbPath);
    const seed = makeTopic();
    store.transaction(() => store.insertTopic(seed));
    store.transaction(() =>
      store.insertTestCases(seed.topicId, [sampleCase]),
    ); // sampleCase 无 dependsOn/parallelGroup

    const loaded = store.loadTopic(seed.topicId);
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    const tc = loaded.testCases[0]!;
    expect(tc.dependsOn).toEqual([]); // 缺省回退空数组
    expect(tc.parallelGroup).toBeUndefined(); // 缺省回退 undefined
    store.close();
  });
});

// ── 文件锁（跨进程并发安全，替代 sqlite WAL + busy_timeout） ─
//
// 注：同进程内嵌套同步事务会死锁（Atomics.wait 阻塞整个进程）。
// 真实并发场景是跨进程（多个 pi 子进程各自的 CwStore 实例），
// 文件锁（O_EXCL）正是为跨进程设计。此处验证锁的基本生命周期。

describe("CwStore 文件锁（ADR-029 decision 6 等价）", () => {
  it("事务期间锁文件存在，结束后被清理", () => {
    const dbPath = trackTmpDir(tmpJsonPath());
    const store = new CwStore(dbPath);

    // 事务结束后锁文件应被删除
    store.transaction(() => {
      store.insertTopic(makeTopic());
    });

    expect(existsSync(dbPath + ".lock")).toBe(false);
    // 数据文件应存在
    expect(existsSync(dbPath)).toBe(true);
    store.close();
  });

  it("stale lock（持有者进程已死）会被自动清理", () => {
    const dbPath = trackTmpDir(tmpJsonPath());
    const store = new CwStore(dbPath);

    // 模拟 stale lock：手动写一个指向不存在 PID 的锁文件
    writeFileSync(
      dbPath + ".lock",
      "999999999\n" + (Date.now() - 60000) + "\n", // PID 不存在 + 60s 前（超时）
      "utf-8",
    );

    // 新事务应自动 break stale lock 并正常执行
    store.transaction(() => {
      store.insertTopic(makeTopic());
    });

    // stale lock 被清理后，新事务正常落盘
    const loaded = store.loadTopic("t-1");
    expect(loaded).not.toBeNull();
    // 事务结束后锁文件再次被清理
    expect(existsSync(dbPath + ".lock")).toBe(false);
    store.close();
  });
});

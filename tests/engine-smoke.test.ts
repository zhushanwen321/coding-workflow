/**
 * 通用引擎 smoke test —— 验证 cw 1.0 原型的 4 个核心目标。
 *
 * 验证标准（对应 plan.md「验证标准」）：
 *   1. 递归嵌套干净：topic.dev 时 child wave 各自走 wave 状态机，topic 不直接调 wave 内部
 *   2. 通用引擎吃下 L3：8 status + 10 action 全用 ScopeConfig 配置表达，零硬编码
 *   3. freeze 抽象成立：replan 改已 committed wave → checkFreeze 返回 violation
 *   4. progressive 语义：dev 重入不回退 status
 *
 * 测试用 UnitStateMachine + InMemoryStore + DefaultGateRunner + stub gate（不接 cw 0.x）。
 */
import { beforeEach,describe, expect, it } from "vitest";

import {
  L3_TOPIC_CONFIG,
  type L3TopicAction,
  type L3TopicPayload,
  type L3TopicStatus,
  type L3TopicTestCaseItem,
  type L3TopicWaveItem,
} from "../src/engine/configs/l3-topic.js";
import {
  L3_WAVE_CONFIG,
  type L3WaveAction,
  type L3WavePayload,
  type L3WaveStatus,
} from "../src/engine/configs/l3-wave.js";
import { type EngineDeps,InMemoryStore, SystemClock } from "../src/engine/deps.js";
import {
  alwaysFailGate,
  alwaysPassGate,
  DefaultGateRunner,
} from "../src/engine/gate.js";
import { UnitStateMachine } from "../src/engine/state-machine.js";
import {
  createUnit,
  type Unit,
} from "../src/engine/unit.js";

/** 构造测试用的引擎依赖。 */
function makeDeps(): EngineDeps {
  return {
    store: new InMemoryStore(),
    gateRunner: new DefaultGateRunner(),
    clock: new SystemClock(),
  };
}

/** 构造一个空 topic unit。 */
function makeTopicUnit(slug: string): Unit<L3TopicStatus, L3TopicPayload> {
  return createUnit({
    scope: "L3-topic",
    slug,
    status: "created",
    payload: {
      objective: `test topic ${slug}`,
      workspacePath: "/tmp/test-ws",
      topicDir: `/tmp/test-ws/.xyz-harness/${slug}`,
      reviewTurn: 0,
      testTurn: 0,
    },
  });
}

/** 构造一个 wave unit，挂在 topic 下。 */
function makeWaveUnit(
  topicSlug: string,
  waveIndex: number,
  description: string,
): Unit<L3WaveStatus, L3WavePayload> {
  const waveSlug = `${topicSlug}-w${waveIndex}`;
  return createUnit({
    scope: "L3-wave",
    slug: waveSlug,
    status: "planned",
    payload: {
      description,
      dependsOn: [],
      commitHash: null,
      changedFiles: [],
      changes: [],
    },
    parentUnitId: `L3-topic:${topicSlug}`,
  });
}

describe("通用引擎 smoke test", () => {
  let deps: EngineDeps;
  let topicMachine: UnitStateMachine<L3TopicStatus, L3TopicAction, L3TopicPayload>;
  let waveMachine: UnitStateMachine<L3WaveStatus, L3WaveAction, L3WavePayload>;

  beforeEach(() => {
    deps = makeDeps();
    topicMachine = new UnitStateMachine(L3_TOPIC_CONFIG, deps);
    waveMachine = new UnitStateMachine(L3_WAVE_CONFIG, deps);
  });

  // ── 验证标准 2：通用引擎吃下 L3（主链走通）──
  describe("L3 topic 主链走通（通用引擎吃下 L3）", () => {
    it("create→plan→tdd_plan→dev→review→test→retrospect→closeout 主链流转", () => {
      let topic = makeTopicUnit("smoke-1");
      deps.store.save(topic);

      // create 已经在 makeTopicUnit 完成（status=created），这里从 plan 开始
      // plan：写 waves
      topic = topicMachine.dispatch(topic, "plan", { waves: [] }, {
        productApplicator: (u) => {
          u.collections.waves = [
            { id: "w1", dependsOn: [], committed: null, changes: [] } as L3TopicWaveItem,
          ];
        },
        gateSpecs: [alwaysPassGate("plan-schema")],
      }).unit!;

      expect(topic.status).toBe("planned");
      expect(topic.collections.waves).toHaveLength(1);

      // tdd_plan：写 testCases
      topic = topicMachine.dispatch(topic, "tdd_plan", {}, {
        productApplicator: (u) => {
          u.collections.testCases = [
            { id: "tc1", scenario: "s1", expected: {}, status: "pending" } as L3TopicTestCaseItem,
          ];
        },
        gateSpecs: [alwaysPassGate("tdd-schema")],
      }).unit!;

      expect(topic.status).toBe("pre_dev_verified");
      expect(topic.collections.testCases).toHaveLength(1);

      // dev：标 wave committed
      topic = topicMachine.dispatch(topic, "dev", {}, {
        productApplicator: (u) => {
          const waves = u.collections.waves as L3TopicWaveItem[];
          waves[0]!.committed = "abc123";
        },
        gateSpecs: [alwaysPassGate("commit-anchor")],
      }).unit!;

      expect(topic.status).toBe("developed");

      // review
      topic = topicMachine.dispatch(topic, "review", {}, {
        gateSpecs: [alwaysPassGate("review-found")],
      }).unit!;
      expect(topic.status).toBe("reviewed");

      // test
      topic = topicMachine.dispatch(topic, "test", {}, {
        productApplicator: (u) => {
          const cases = u.collections.testCases as L3TopicTestCaseItem[];
          cases[0]!.status = "passed";
        },
        gateSpecs: [alwaysPassGate("judge-expected")],
      }).unit!;
      expect(topic.status).toBe("post_dev_verified");

      // retrospect
      topic = topicMachine.dispatch(topic, "retrospect", {}, {
        gateSpecs: [alwaysPassGate("retrospect-check")],
      }).unit!;
      expect(topic.status).toBe("retrospected");

      // closeout（freeze evidence）
      topic = topicMachine.dispatch(topic, "closeout", {}, {
        productApplicator: (u) => {
          u.collections.evidence = [{ closedAt: new Date().toISOString() }];
        },
        gateSpecs: [alwaysPassGate("closeout-check")],
      }).unit!;
      expect(topic.status).toBe("closed");
      expect(L3_TOPIC_CONFIG.terminalStatuses.has(topic.status)).toBe(true);

      // gateHistory 完整留痕（每次 dispatch 都 append）
      const history = topic.collections.gateHistory as Array<{ gate: string; result: string }>;
      expect(history.length).toBeGreaterThanOrEqual(7);
      expect(history.every((e) => e.result === "pass")).toBe(true);
    });

    it("guard 阻止跳步（created 直接 dev → illegal_transition）", () => {
      const topic = makeTopicUnit("smoke-skip");
      const verdict = topicMachine.guard("dev", topic.status);
      expect(verdict.ok).toBe(false);
      expect(verdict.code).toBe("illegal_transition");
    });

    it("终态后任何 action 都 illegal_transition", () => {
      let topic = makeTopicUnit("smoke-terminal");
      // 强制设到 closed
      topic = { ...topic, status: "closed" };
      const verdict = topicMachine.guard("dev", topic.status);
      expect(verdict.ok).toBe(false);
    });
  });

  // ── 验证标准 4：progressive 语义 ──
  describe("progressive 语义（dev 重入不回退 status）", () => {
    it("developed 状态下再次 dev，status 仍为 developed（不回退到 pre_dev_verified）", () => {
      let topic = makeTopicUnit("smoke-prog");
      // 推到 developed
      topic = topicMachine.dispatch(topic, "plan", {}, {
        productApplicator: (u) => {
          u.collections.waves = [
            { id: "w1", dependsOn: [], committed: null, changes: [] } as L3TopicWaveItem,
          ];
        },
        gateSpecs: [alwaysPassGate("plan-schema")],
      }).unit!;
      topic = topicMachine.dispatch(topic, "tdd_plan", {}, {
        gateSpecs: [alwaysPassGate("tdd-schema")],
      }).unit!;
      topic = topicMachine.dispatch(topic, "dev", {}, {
        productApplicator: (u) => {
          (u.collections.waves as L3TopicWaveItem[])[0]!.committed = "h1";
        },
        gateSpecs: [alwaysPassGate("commit-anchor")],
      }).unit!;
      expect(topic.status).toBe("developed");

      // 再 dev：progressive，status 不变
      topic = topicMachine.dispatch(topic, "dev", {}, {
        productApplicator: (u) => {
          (u.collections.waves as L3TopicWaveItem[]).push({
            id: "w2", dependsOn: ["w1"], committed: "h2", changes: [],
          });
        },
        gateSpecs: [alwaysPassGate("commit-anchor")],
      }).unit!;
      expect(topic.status).toBe("developed");
      expect(topic.collections.waves).toHaveLength(2);
    });
  });

  // ── 验证标准 1：递归嵌套（topic↔wave 通过指针解耦）──
  describe("递归嵌套干净（topic↔wave 通过指针解耦）", () => {
    it("topic 创建 wave 作为 child unit，wave 各自走自己的状态机", () => {
      const topic = makeTopicUnit("nest-1");
      deps.store.save(topic);

      // 创建 2 个 wave，作为 topic 的 child
      const wave1 = makeWaveUnit("nest-1", 1, "wave 1");
      const wave2 = makeWaveUnit("nest-1", 2, "wave 2");
      deps.store.save(wave1);
      deps.store.save(wave2);

      // topic 的 childUnitIds 更新（通过指针，不嵌套对象）
      const topicWithChildren: Unit<L3TopicStatus, L3TopicPayload> = {
        ...topic,
        childUnitIds: [wave1.id, wave2.id],
      };
      deps.store.save(topicWithChildren);

      // 验证：通过 store.findChildren 能查到 wave
      const children = deps.store.findChildren(topicWithChildren.id);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.id)).toEqual(
        expect.arrayContaining([wave1.id, wave2.id]),
      );

      // wave1 走自己的状态机（commit）
      const w1Loaded = deps.store.load(wave1.id) as Unit<L3WaveStatus, L3WavePayload>;
      const w1Committed = waveMachine.dispatch(w1Loaded, "commit", {}, {
        productApplicator: (u) => {
          u.payload.commitHash = "abc123";
          u.payload.changedFiles = ["src/foo.ts"];
        },
        gateSpecs: [alwaysPassGate("wave-commit")],
      }).unit!;
      deps.store.save(w1Committed);

      expect(w1Committed.status).toBe("committed");
      expect(w1Committed.payload.commitHash).toBe("abc123");

      // 验证：topic 不知道 wave 内部状态，只通过 childUnitIds 知道有 child
      const topicReloaded = deps.store.load(topicWithChildren.id) as Unit<L3TopicStatus, L3TopicPayload>;
      expect(topicReloaded.childUnitIds).toEqual([wave1.id, wave2.id]);
      // topic 的 status 不受 wave commit 影响（解耦）
      expect(topicReloaded.status).toBe("created");

      // 验证所有 child wave 都是 terminal（topic closeout gate 校验逻辑）
      const allWavesTerminal = deps.store
        .findChildren(topicReloaded.id)
        .every((w) => L3_WAVE_CONFIG.terminalStatuses.has(w.status as L3WaveStatus));
      expect(allWavesTerminal).toBe(false); // wave2 还是 planned
    });

    it("topic 不直接调 wave 内部状态，只通过指针 + store 查询", () => {
      const topic = makeTopicUnit("nest-decouple");
      const wave = makeWaveUnit("nest-decouple", 1, "w");
      deps.store.save(topic);
      deps.store.save(wave);

      // topic 持有的是 wave 的 id（字符串指针），不是 wave 对象
      const topicWithRef: Unit<L3TopicStatus, L3TopicPayload> = {
        ...topic,
        childUnitIds: [wave.id],
      };
      expect(topicWithRef.childUnitIds[0]).toBe("L3-wave:nest-decouple-w1");
      expect(typeof topicWithRef.childUnitIds[0]).toBe("string");

      // 要拿 wave 的状态，必须通过 store.load（解耦验证）
      const loaded = deps.store.load(wave.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.status).toBe("planned");
    });
  });

  // ── 验证标准 3：freeze 抽象成立 ──
  describe("freeze 抽象（replan 改已 committed wave → 拒绝）", () => {
    it("replan 改已 committed wave 的 changes 字段 → freeze_violation", () => {
      let topic = makeTopicUnit("freeze-1");
      topic = topicMachine.dispatch(topic, "plan", {}, {
        productApplicator: (u) => {
          u.collections.waves = [
            {
              id: "w1",
              dependsOn: [],
              committed: null,
              changes: [{ file: "a.ts", action: "create" as const, description: "init" }],
            } as L3TopicWaveItem,
          ];
        },
        gateSpecs: [alwaysPassGate("plan-schema")],
      }).unit!;
      topic = topicMachine.dispatch(topic, "tdd_plan", {}, {
        gateSpecs: [alwaysPassGate("tdd-schema")],
      }).unit!;
      topic = topicMachine.dispatch(topic, "dev", {}, {
        productApplicator: (u) => {
          (u.collections.waves as L3TopicWaveItem[])[0]!.committed = "h1";
        },
        gateSpecs: [alwaysPassGate("commit-anchor")],
      }).unit!;

      // 现在 w1 已 committed。尝试 replan 改它的 changes
      const oldSnapshot = structuredClone(topic);
      const result = topicMachine.dispatch(topic, "replan", {}, {
        checkFreeze: true,
        oldUnitForFreeze: oldSnapshot,
        productApplicator: (u) => {
          // 改已 committed wave 的 changes（违规）
          (u.collections.waves as L3TopicWaveItem[])[0]!.changes = [
            { file: "b.ts", action: "modify" as const, description: "tampered" },
          ];
        },
        gateSpecs: [alwaysPassGate("replan-schema")],
      });

      expect(result.error).toBeDefined();
      expect(result.error!.ok).toBe(false);
      expect(result.error!.code).toBe("freeze_violation");
      expect(result.error!.violations!.length).toBeGreaterThan(0);
      expect(result.error!.violations![0]!.type).toBe("wave_modified_committed");
    });

    it("replan 删已 committed wave → freeze_violation（deleted）", () => {
      let topic = makeTopicUnit("freeze-del");
      topic = topicMachine.dispatch(topic, "plan", {}, {
        productApplicator: (u) => {
          u.collections.waves = [
            { id: "w1", dependsOn: [], committed: null, changes: [] } as L3TopicWaveItem,
          ];
        },
        gateSpecs: [alwaysPassGate("plan-schema")],
      }).unit!;
      topic = topicMachine.dispatch(topic, "tdd_plan", {}, {
        gateSpecs: [alwaysPassGate("tdd-schema")],
      }).unit!;
      topic = topicMachine.dispatch(topic, "dev", {}, {
        productApplicator: (u) => {
          (u.collections.waves as L3TopicWaveItem[])[0]!.committed = "h1";
        },
        gateSpecs: [alwaysPassGate("commit-anchor")],
      }).unit!;

      const oldSnapshot = structuredClone(topic);
      const result = topicMachine.dispatch(topic, "replan", {}, {
        checkFreeze: true,
        oldUnitForFreeze: oldSnapshot,
        productApplicator: (u) => {
          // 删已 committed wave（违规）
          u.collections.waves = [];
        },
        gateSpecs: [alwaysPassGate("replan-schema")],
      });

      expect(result.error!.code).toBe("freeze_violation");
      expect(result.error!.violations![0]!.type).toContain("deleted");
    });

    it("replan 改已 passed testCase 的 expected → freeze_violation", () => {
      let topic = makeTopicUnit("freeze-case");
      topic = topicMachine.dispatch(topic, "plan", {}, {
        productApplicator: (u) => {
          u.collections.waves = [
            { id: "w1", dependsOn: [], committed: null, changes: [] } as L3TopicWaveItem,
          ];
        },
        gateSpecs: [alwaysPassGate("plan-schema")],
      }).unit!;
      topic = topicMachine.dispatch(topic, "tdd_plan", {}, {
        productApplicator: (u) => {
          u.collections.testCases = [
            { id: "tc1", scenario: "s", expected: { v: 1 }, status: "pending" } as L3TopicTestCaseItem,
          ];
        },
        gateSpecs: [alwaysPassGate("tdd-schema")],
      }).unit!;
      topic = topicMachine.dispatch(topic, "dev", {}, {
        productApplicator: (u) => {
          (u.collections.waves as L3TopicWaveItem[])[0]!.committed = "h1";
        },
        gateSpecs: [alwaysPassGate("commit-anchor")],
      }).unit!;
      topic = topicMachine.dispatch(topic, "review", {}, {
        gateSpecs: [alwaysPassGate("review-found")],
      }).unit!;
      topic = topicMachine.dispatch(topic, "test", {}, {
        productApplicator: (u) => {
          (u.collections.testCases as L3TopicTestCaseItem[])[0]!.status = "passed";
        },
        gateSpecs: [alwaysPassGate("judge-expected")],
      }).unit!;

      // 现在 tc1 已 passed。replan 改它的 expected
      const oldSnapshot = structuredClone(topic);
      const result = topicMachine.dispatch(topic, "replan", {}, {
        checkFreeze: true,
        oldUnitForFreeze: oldSnapshot,
        productApplicator: (u) => {
          (u.collections.testCases as L3TopicTestCaseItem[])[0]!.expected = { v: 999 };
        },
        gateSpecs: [alwaysPassGate("replan-schema")],
      });

      expect(result.error!.code).toBe("freeze_violation");
      expect(result.error!.violations![0]!.type).toBe("case_modified_passed");
    });
  });

  // ── 验证标准 4b：gate 失败短路 + 状态不流转 ──
  describe("gate 失败短路 + 状态不流转", () => {
    it("plan gate fail → status 不变（仍 created），gateHistory 记 fail", () => {
      const topic = makeTopicUnit("gate-fail");
      const result = topicMachine.dispatch(topic, "plan", {}, {
        gateSpecs: [alwaysFailGate("plan-schema", "plan json invalid")],
      });

      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe("gate_failed");
      // status 不变（dispatch 失败不返回 unit，但 unit 本身没被 save）
      expect(result.unit).toBeUndefined();
      // gateHistory 有 fail 记录
      expect(result.gateEntries).toBeDefined();
      expect(result.gateEntries!.length).toBe(1);
      expect(result.gateEntries![0]!.result).toBe("fail");
      expect(result.gateEntries![0]!.gate).toBe("plan-schema");
    });

    it("多 gate 短路：第一个 fail，第二个不执行", () => {
      const topic = makeTopicUnit("gate-short");
      const secondGateCalled = { value: false };
      const result = topicMachine.dispatch(topic, "plan", {}, {
        gateSpecs: [
          alwaysFailGate("gate-1", "fail"),
          {
            id: "gate-2",
            kind: "schema" as const,
            check: () => {
              secondGateCalled.value = true;
              return { passed: true, report: "" };
            },
          },
        ],
      });

      expect(result.error!.code).toBe("gate_failed");
      expect(secondGateCalled.value).toBe(false); // 第二个 gate 没被调用
      expect(result.gateEntries!.length).toBe(1); // 只有 1 条（短路的那个）
    });
  });
});

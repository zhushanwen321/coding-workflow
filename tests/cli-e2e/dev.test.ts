/**
 * UC-3: dev 子命令测试（mock 层）。
 *
 * 覆盖 test-matrix: T3.1~T3.5（关联 code-architecture.md §4.3 时序图）。
 * 测试层：mock —— 内存 FakeStore + fake GitValidator，不真实调 git / 文件系统。
 *
 * handleDev 数据流（§4.3）：
 *   per task GitValidator.validate → setWaveCommitted(valid) →
 *   updateTopic(computeNextStatus) → appendGateHistory → reload → buildNextAction
 */

import { describe, it, expect } from "vitest";

import { dispatch, GuardError } from "../../src/engine/dispatch.js";
import type {
  ActionDeps,
  CwTopic,
  GateHistoryEntry,
} from "../../src/engine/types.js";
import type { CwStore } from "../../src/engine/store.js";
import type { GateRunner, GitValidator } from "../../src/engine/gates.js";

// ── FakeStore：内存实现 dev 链路所需方法 ─────────────────────

interface GateHistorySeedLike {
  phase: CwTopic["gateHistory"][number]["phase"];
  action: CwTopic["gateHistory"][number]["action"];
  gate: string;
  tier: CwTopic["gateHistory"][number]["tier"];
  result: "pass" | "fail";
  report?: string;
  progressive: boolean;
}

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

  insertTopic(topic: CwTopic): void {
    if (this.topics.has(topic.topicId)) {
      throw new Error(`PRIMARY KEY violation: ${topic.topicId}`);
    }
    this.topics.set(topic.topicId, topic);
  }

  setWaveCommitted(topicId: string, waveId: string, commitHash: string): void {
    const topic = this.topics.get(topicId);
    if (!topic) return;
    const wave = topic.waves.find((w) => w.id === waveId);
    if (wave) wave.committed = commitHash;
  }

  updateStatus(topicId: string, status: CwTopic["status"]): void {
    const topic = this.topics.get(topicId);
    if (topic) topic.status = status;
  }

  updateGatePassed(topicId: string, _phase: string, _passed: boolean): void {
    // FakeStore: gatePassed 由 dev.ts 手动设进 ActionResult，此处 no-op
  }

  appendGateHistory(topicId: string, seed: GateHistorySeedLike): void {
    const topic = this.topics.get(topicId);
    if (!topic) return;
    const entry: GateHistoryEntry = {
      id: topic.gateHistory.length + 1,
      phase: seed.phase,
      action: seed.action,
      gate: seed.gate,
      tier: seed.tier,
      result: seed.result,
      ts: new Date().toISOString(),
      report: seed.report,
      progressive: seed.progressive,
    };
    topic.gateHistory.push(entry);
  }

  transaction(fn: () => void): void {
    fn();
  }
}

// ── fake GitValidator：白名单 hash → valid ──────────────────

interface CommitValidationLike {
  commitHash: string;
  exists: boolean;
  inRepo: boolean;
  nonEmpty: boolean;
  valid: boolean;
  reason?: string;
}

function makeFakeGit(validHashes: Set<string>): GitValidator {
  const validate = (commitHash: string): CommitValidationLike => {
    if (validHashes.has(commitHash)) {
      return { commitHash, exists: true, inRepo: true, nonEmpty: true, valid: true };
    }
    return {
      commitHash,
      exists: false,
      inRepo: false,
      nonEmpty: false,
      valid: false,
      reason: "cat-file,empty",
    };
  };
  const isAncestorOfAny = (_hash: string, _ancestors: readonly string[]): boolean => false;
  return { validate, isAncestorOfAny } as unknown as GitValidator;
}

function makeRunner(): GateRunner {
  return { runCheck: () => ({ passed: true }) } as unknown as GateRunner;
}

function makeDeps(validHashes: Set<string>): { deps: ActionDeps; store: FakeStore } {
  const store = new FakeStore();
  const deps: ActionDeps = {
    store: store as unknown as CwStore,
    git: makeFakeGit(validHashes),
    runner: makeRunner(),
    workspacePath: "/tmp/cw-test",
  };
  return { deps, store };
}

// ── 造一个 planned 状态的 lite topic（含 waves） ───────────

function makePlannedTopic(
  topicId: string,
  waveIds: string[],
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
    waves: waveIds.map((id) => ({
      id,
      dependsOn: [],
      committed: null,
      changes: [],
      issues: [],
    })),
    testCases: [],
    // plan gate 已通过：gateHistory 含 plan pass 记录，与 gatePassed.plan=true 保持
    // 缓存一致（guard 第三重 checkCacheConsistency 校验）
    gateHistory: [
      {
        id: 1,
        phase: "plan",
        action: "plan",
        gate: "weak-structural",
        tier: "weak-structural",
        result: "pass",
        ts: "2026-07-10T00:00:00.000Z",
        progressive: false,
      },
    ],
    gatePassed: { plan: true },
    ...overrides,
  };
}

// ── T3.1 ~ T3.5 ─────────────────────────────────────────────

describe("UC-3: dev", () => {
  it("T3.1: 单 wave commit → wave.committed 更新", () => {
    const { deps, store } = makeDeps(new Set(["abc123"]));
    store.seed(makePlannedTopic("cw-2026-07-10-x", ["W1"]));

    const result = dispatch(
      { action: "dev", topicId: "cw-2026-07-10-x", tasks: [{ waveId: "W1", commitHash: "abc123" }] },
      deps,
    );

    expect(result.status).toBe("developed");
    const w1 = result.nextAction.waves?.find((w) => w.id === "W1");
    expect(w1).toBeDefined();
    expect(w1?.committed).toBe(true);
  });

  it("T3.2: 批量 wave commit → 全 committed → nextAction 指向 test", () => {
    const { deps, store } = makeDeps(new Set(["hash1", "hash2"]));
    store.seed(makePlannedTopic("cw-2026-07-10-batch", ["W1", "W2"]));

    const result = dispatch(
      {
        action: "dev",
        topicId: "cw-2026-07-10-batch",
        tasks: [
          { waveId: "W1", commitHash: "hash1" },
          { waveId: "W2", commitHash: "hash2" },
        ],
      },
      deps,
    );

    const waves = result.nextAction.waves ?? [];
    expect(waves.every((w) => w.committed)).toBe(true);
    expect(result.gatePassed.dev).toBe(true);
    // 全 committed → dev phase complete → nextAction 指向 test
    expect(result.nextAction.action).toBe("test");
  });

  it("T3.3: 无效 commitHash → CommitValidation.valid=false 且 wave 不 committed", () => {
    const { deps, store } = makeDeps(new Set(["hash1"]));
    store.seed(makePlannedTopic("cw-2026-07-10-bad", ["W1"]));

    // 直接验证 fake git 语义
    const gitResult = deps.git.validate("doesnotexist");
    expect(gitResult.valid).toBe(false);

    // 经 dispatch：无效 commit 不应更新 wave.committed
    const result = dispatch(
      { action: "dev", topicId: "cw-2026-07-10-bad", tasks: [{ waveId: "W1", commitHash: "doesnotexist" }] },
      deps,
    );

    const w1 = result.nextAction.waves?.find((w) => w.id === "W1");
    expect(w1?.committed).toBe(false);
    expect(result.gatePassed.dev).toBe(false);
    // 仍有未 committed wave → nextAction 停在 dev
    expect(result.nextAction.action).toBe("dev");
  });

  it("T3.4: 态内推进 —— developed 状态提交部分 wave，nextAction 仍指 dev", () => {
    const { deps, store } = makeDeps(new Set(["hash1"]));
    // 已处于 developed（progressive），2 个 wave 都未 commit
    store.seed(
      makePlannedTopic("cw-2026-07-10-prog", ["W1", "W2"], { status: "developed" }),
    );

    const result = dispatch(
      { action: "dev", topicId: "cw-2026-07-10-prog", tasks: [{ waveId: "W1", commitHash: "hash1" }] },
      deps,
    );

    // progressive：status 已是 developed → 原地停留
    expect(result.status).toBe("developed");
    // W1 committed, W2 仍未 → dev phase 未完成 → nextAction 仍指 dev
    const waves = result.nextAction.waves ?? [];
    expect(waves.find((w) => w.id === "W1")?.committed).toBe(true);
    expect(waves.find((w) => w.id === "W2")?.committed).toBe(false);
    expect(result.nextAction.action).toBe("dev");
  });

  it("T3.5: 完整 dev 流程 —— 3 wave 逐次 commit，全完成后 nextAction→test", () => {
    const { deps, store } = makeDeps(new Set(["h1", "h2", "h3"]));
    store.seed(makePlannedTopic("cw-2026-07-10-flow", ["W1", "W2", "W3"]));

    const topicId = "cw-2026-07-10-flow";

    const r1 = dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: "h1" }] },
      deps,
    );
    expect(r1.nextAction.action).toBe("dev");
    expect(r1.nextAction.waves?.find((w) => w.id === "W1")?.committed).toBe(true);

    const r2 = dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W2", commitHash: "h2" }] },
      deps,
    );
    expect(r2.nextAction.action).toBe("dev");
    expect(r2.nextAction.waves?.filter((w) => w.committed).length).toBe(2);

    // 最后一个 wave → 全 committed → 转 test
    const r3 = dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W3", commitHash: "h3" }] },
      deps,
    );
    expect(r3.status).toBe("developed");
    expect(r3.gatePassed.dev).toBe(true);
    expect(r3.nextAction.action).toBe("test");
  });

  it("T3.x guard: 非 dev 允许状态调用 dev → GuardError illegal_transition", () => {
    const { deps, store } = makeDeps(new Set(["h1"]));
    // created 状态不在 dev.expectedStatuses [planned,detailed,developed]
    store.seed(makePlannedTopic("cw-2026-07-10-guard", ["W1"], { status: "created" }));

    expect(() =>
      dispatch(
        { action: "dev", topicId: "cw-2026-07-10-guard", tasks: [{ waveId: "W1", commitHash: "h1" }] },
        deps,
      ),
    ).toThrow(GuardError);
  });
});

/**
 * replan.test.ts — replan action 单测（UC-6 append-only，AC-6.1~6.3）。
 *
 * 覆盖 test-matrix：
 *   T6.1 replan 追加新 wave：旧 committed wave 不变，新 wave 追加
 *   T6.2 修改已 committed wave：append-only 拒绝（throw）
 *   T6.3 developed 状态 replan：回退到 planned，追加成功
 *   T6.4 连续两次 replan：第二次在第一次基础上追加
 *
 * 测试层：mock（真实 CwStore + vi.spyOn GateRunner.runCheck 让 plan gate 通过；
 *   committed wave 通过 store.setWaveCommitted 直接构造前置状态——dev action 属 W3，
 *   本 wave 不依赖）。
 */

import { describe, expect, it, vi } from "vitest";

import { GateRunner } from "../../src/engine/gates.js";
import { dispatch } from "../../src/engine/dispatch.js";
import {
  closeStore,
  makeDeps,
  makeLitePlan,
  makeTmpWorkspace,
  PASS_CHECK,
} from "./_helpers.js";
import type { ActionDeps } from "../../src/engine/types.js";

// ── 共享 setup：create + plan（gate pass）→ planned，可选 commit 部分 wave ──

function setupPlannedTopic(
  deps: ActionDeps,
  opts: { commitWaves?: Array<[string, string]> } = {},
): string {
  vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(PASS_CHECK);
  const created = dispatch(
    { action: "create", slug: "demo", tier: "lite", objective: "x" },
    deps,
  );
  dispatch(
    { action: "plan", topicId: created.topicId, planJson: makeLitePlan() },
    deps,
  );
  const commitWaves = opts.commitWaves ?? [];
  if (commitWaves.length > 0) {
    deps.store.transaction(() => {
      for (const [waveId, hash] of commitWaves) {
        deps.store.setWaveCommitted(created.topicId, waveId, hash);
      }
    });
  }
  return created.topicId;
}

// 原 plan.json 的 wave 清单（W1/W2）+ E1 testCase
function baseWaves() {
  return [
    { id: "W1", changes: ["src/a.ts"], dependsOn: [] as string[] },
    { id: "W2", changes: ["src/b.ts"], dependsOn: ["W1"], parallelGroup: "g1" },
  ];
}

describe("UC-6 replan: append-only 追加 / 校验", () => {
  it("T6.1 — replan 追加新 wave：旧 committed wave commit hash 不变，新 wave 追加", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = setupPlannedTopic(deps, { commitWaves: [["W1", "deadbeef"]] });

    // replan：在 W1/W2 基础上追加 W3（W1 保持原 changes，不触发 append-only 违规）
    const replanJson = makeLitePlan({
      waves: [...baseWaves(), { id: "W3", changes: ["src/c.ts"], dependsOn: ["W2"] }],
    });

    const result = dispatch(
      { action: "replan", topicId, planJson: replanJson },
      deps,
    );

    // 旧 committed wave W1 的 commit hash 不变
    const loaded = store.loadTopic(topicId);
    expect(loaded?.waves.find((w) => w.id === "W1")?.committed).toBe("deadbeef");
    // 新 wave W3 已追加
    expect(loaded?.waves.some((w) => w.id === "W3")).toBe(true);
    // replanSummary 记录追加
    expect(result.replanSummary?.addedWaves).toContain("W3");
    expect(result.replanSummary?.removedWaves).not.toContain("W1");

    closeStore(store);
  });

  it("T6.2 — 修改已 committed wave 的 changes → append-only 拒绝（throw）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = setupPlannedTopic(deps, { commitWaves: [["W1", "deadbeef"]] });

    // replan：修改 W1 的 changes（W1 已 committed → 违规）
    const replanJson = makeLitePlan({
      waves: [
        { id: "W1", changes: ["src/CHANGED.ts"], dependsOn: [] },
        { id: "W2", changes: ["src/b.ts"], dependsOn: ["W1"], parallelGroup: "g1" },
      ],
    });

    expect(() =>
      dispatch({ action: "replan", topicId, planJson: replanJson }, deps),
    ).toThrow(/append-only|committed|不可删改|不可修改/i);

    // 拒绝后 store 未被破坏性变更（W1 commit hash 仍在）
    const loaded = store.loadTopic(topicId);
    expect(loaded?.waves.find((w) => w.id === "W1")?.committed).toBe("deadbeef");

    closeStore(store);
  });
});

describe("UC-6 replan: 状态回退 / 连续追加", () => {
  it("T6.3 — developed 状态 replan → 回退到 planned，追加成功，旧 committed 不变", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    // 先到 planned 并 commit 全部 wave，再推到 developed（保持 cache 一致）
    const topicId = setupPlannedTopic(deps, {
      commitWaves: [
        ["W1", "h1"],
        ["W2", "h2"],
      ],
    });
    store.transaction(() => {
      store.updateStatus(topicId, "developed");
      store.updateGatePassed(topicId, "dev", true);
    });

    const replanJson = makeLitePlan({
      waves: [...baseWaves(), { id: "W3", changes: ["src/c.ts"], dependsOn: ["W2"] }],
    });

    const result = dispatch(
      { action: "replan", topicId, planJson: replanJson },
      deps,
    );

    // developed → planned（回退）
    expect(result.status).toBe("planned");
    // 新 wave W3 追加
    const loaded = store.loadTopic(topicId);
    expect(loaded?.waves.some((w) => w.id === "W3")).toBe(true);
    // 旧 committed wave commit hash 不变
    expect(loaded?.waves.find((w) => w.id === "W1")?.committed).toBe("h1");
    expect(loaded?.waves.find((w) => w.id === "W2")?.committed).toBe("h2");

    closeStore(store);
  });

  it("T6.4 — 连续两次 replan：第二次在第一次基础上追加（W4 存在）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = setupPlannedTopic(deps);

    // 第一次 replan：追加 W3
    dispatch(
      {
        action: "replan",
        topicId,
        planJson: makeLitePlan({
          waves: [...baseWaves(), { id: "W3", changes: ["src/c.ts"], dependsOn: ["W2"] }],
        }),
      },
      deps,
    );

    // 第二次 replan：再追加 W4
    dispatch(
      {
        action: "replan",
        topicId,
        planJson: makeLitePlan({
          waves: [
            ...baseWaves(),
            { id: "W3", changes: ["src/c.ts"], dependsOn: ["W2"] },
            { id: "W4", changes: ["src/d.ts"], dependsOn: ["W3"] },
          ],
        }),
      },
      deps,
    );

    const loaded = store.loadTopic(topicId);
    const waveIds = loaded?.waves.map((w) => w.id);
    expect(waveIds).toEqual(expect.arrayContaining(["W1", "W2", "W3", "W4"]));

    closeStore(store);
  });
});

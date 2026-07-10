/**
 * plan.test.ts — plan action 单测（UC-2 lite，AC-2.1~2.4）。
 *
 * 覆盖 test-matrix：
 *   T2.1 plan gate pass：created→planned，waves/testCases 写入，gatePassed.plan=true
 *   T2.2 plan gate fail：status 不变（created），gatePassed.plan falsy，mustFix 含 report
 *   T2.3 format≠tier：parseLitePlan 拒（D-003 tier 锁定）
 *   T2.4 非法状态转换（planned→plan）：dispatch throw GuardError illegal_transition
 *   T2.5 closed topic 调 plan：dispatch throw GuardError illegal_transition
 *
 * 测试层：mock（真实 CwStore + vi.spyOn GateRunner.runCheck 控制 gate 结果）。
 */

import { describe, expect, it, vi } from "vitest";

import { GateRunner } from "../../src/engine/gates.js";
import { dispatch, GuardError } from "../../src/engine/dispatch.js";
import {
  closeStore,
  FAIL_CHECK,
  makeDeps,
  makeLitePlan,
  makeTmpWorkspace,
  PASS_CHECK,
  seedTopic,
} from "./_helpers.js";

describe("UC-2 plan: 正常 + gate fail", () => {
  it("T2.1 — plan gate pass：created→planned，waves/testCases 写入，gatePassed.plan=true，nextAction=dev", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const runnerSpy = vi
      .spyOn(GateRunner.prototype, "runCheck")
      .mockReturnValue(PASS_CHECK);

    // 先 create 一个 lite topic
    const created = dispatch(
      { action: "create", slug: "demo", tier: "lite", objective: "x" },
      deps,
    );

    const result = dispatch(
      { action: "plan", topicId: created.topicId, planJson: makeLitePlan() },
      deps,
    );

    expect(result.status).toBe("planned"); // created → planned
    expect(result.gatePassed.plan).toBe(true);
    expect(result.gateTier).toBe("weak-structural");
    expect(result.nextAction.action).toBe("dev");
    expect(result.nextAction.skill).toBe("coding-execute");
    expect(result.mustFix).toBeUndefined();

    // store 中 waves/testCases 已写入
    const loaded = store.loadTopic(created.topicId);
    expect(loaded?.waves.length).toBeGreaterThan(0);
    expect(loaded?.testCases.length).toBeGreaterThan(0);
    expect(loaded?.gatePassed.plan).toBe(true);

    // runCheck 被调（lite plan gate 至少 1 个 checker）
    expect(runnerSpy).toHaveBeenCalled();

    closeStore(store);
  });

  it("T2.2 — plan gate fail：status 不变（created），gatePassed.plan falsy，mustFix 含 report，gateHistory 追加 fail", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(FAIL_CHECK);

    const created = dispatch(
      { action: "create", slug: "demo", tier: "lite", objective: "x" },
      deps,
    );

    const result = dispatch(
      { action: "plan", topicId: created.topicId, planJson: makeLitePlan() },
      deps,
    );

    // status 不变
    expect(result.status).toBe("created");
    // gatePassed.plan 未设（falsy）
    expect(result.gatePassed.plan).toBeFalsy();
    // nextAction 指向 retry plan（不是 dev），防 agent 调 dev 撞 illegal_transition
    expect(result.nextAction.action).toBe("plan");
    expect(result.nextAction.skill).toBe("lite-plan");
    // mustFix 含 report 文本
    expect(result.mustFix).toContain("FAIL");
    // gateHistory 追加了 plan/fail 条目
    const loaded = store.loadTopic(created.topicId);
    const planFails = loaded?.gateHistory.filter(
      (e) => e.phase === "plan" && e.result === "fail",
    );
    expect(planFails?.length).toBe(1);

    closeStore(store);
  });
});

describe("UC-2 plan: 边界 + 异常", () => {
  it("T2.3 — format≠tier：plan.json format=mid-clarify 但 tier=lite → throw（D-003 tier 锁定）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(PASS_CHECK);

    const created = dispatch(
      { action: "create", slug: "demo", tier: "lite", objective: "x" },
      deps,
    );

    // format=mid-clarify 但 topic tier=lite → D-003 拒
    expect(() =>
      dispatch(
        {
          action: "plan",
          topicId: created.topicId,
          planJson: { format: "mid-clarify", objective: "x", deliverables: { requirements: "r", systemArchitecture: "s" } },
        },
        deps,
      ),
    ).toThrow(/tier|format|D-003/i);

    closeStore(store);
  });

  it("T2.4 — 非法状态转换（status=planned 调 plan）：dispatch throw GuardError illegal_transition", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(PASS_CHECK);

    // 手动 seed 一个 status=planned 的 topic
    const topicId = seedTopic(store, {
      topicId: "cw-2026-07-10-demo",
      slug: "demo",
      tier: "lite",
      status: "planned",
      workspacePath: ws,
    });

    expect(() =>
      dispatch(
        { action: "plan", topicId, planJson: makeLitePlan() },
        deps,
      ),
    ).toThrow(/illegal_transition/);

    closeStore(store);
  });

  it("T2.5 — closed topic 调 plan：dispatch throw GuardError illegal_transition", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(PASS_CHECK);

    const topicId = seedTopic(store, {
      topicId: "cw-2026-07-10-closed",
      slug: "closed",
      tier: "lite",
      status: "closed",
      workspacePath: ws,
    });

    expect(() =>
      dispatch(
        { action: "plan", topicId, planJson: makeLitePlan() },
        deps,
      ),
    ).toThrow(/illegal_transition/);

    closeStore(store);
  });
});

// GuardError 类型导入守卫（防误删 import）
void GuardError;

/**
 * create.test.ts — create action 单测（UC-1，AC-1.1~1.4）。
 *
 * 覆盖 test-matrix：
 *   T1.1 create lite topic → topicId + status=created + nextAction.plan
 *   T1.2 create mid topic → nextAction.clarify
 *   T1.3 slug 含特殊字符 → 成功
 *   T1.4 空 objective → 成功
 *   T1.5 slug 重复 → PRIMARY KEY 冲突
 *   T1.6 无效 tier → typebox 校验失败
 *   T1.7 topicId 重复（同日同 slug）→ throw
 *
 * 测试层：mock（真实 CwStore + 临时 db，无 git/checker 调用——create 不触发 gate）。
 */

import { describe, expect, it } from "vitest";

import { dispatch } from "../../src/engine/dispatch.js";
import type { CwParams } from "../../src/engine/dispatch.js";
import { validateParams } from "../../src/cli/protocol.js";
import { closeStore, makeDeps, makeTmpWorkspace } from "./_helpers.js";

// ── T1.1: create lite ───────────────────────────────────────

describe("UC-1 create: 正常路径", () => {
  it("T1.1 — tier=lite：topicId + status=created + nextAction=plan", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    const result = dispatch(
      { action: "create", slug: "demo", tier: "lite", objective: "build demo" },
      deps,
    );

    expect(result.status).toBe("created");
    expect(result.nextAction.action).toBe("plan");
    expect(result.nextAction.skill).toBe("lite-plan");
    expect(result.topicId).toMatch(/^cw-\d{4}-\d{2}-\d{2}-demo$/);

    const loaded = store.loadTopic(result.topicId);
    expect(loaded?.tier).toBe("lite");
    expect(loaded?.objective).toBe("build demo");
    expect(loaded?.status).toBe("created");

    closeStore(store);
  });

  it("T1.2 — tier=mid：nextAction=clarify/mid-plan", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    const result = dispatch(
      { action: "create", slug: "midfeat", tier: "mid", objective: "mid obj" },
      deps,
    );

    expect(result.nextAction.action).toBe("clarify");
    expect(result.nextAction.skill).toBe("mid-plan");
    expect(store.loadTopic(result.topicId)?.tier).toBe("mid");

    closeStore(store);
  });

  it("T1.3 — slug 含特殊字符（a-b_1）：成功创建", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    const result = dispatch(
      { action: "create", slug: "a-b_1", tier: "lite", objective: "x" },
      deps,
    );

    expect(result.topicId).toMatch(/^cw-\d{4}-\d{2}-\d{2}-a-b_1$/);
    expect(result.status).toBe("created");

    closeStore(store);
  });

  it("T1.4 — 空 objective：成功创建（objective 允许空）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    const result = dispatch(
      { action: "create", slug: "empty-obj", tier: "lite", objective: "" },
      deps,
    );

    expect(result.status).toBe("created");
    expect(store.loadTopic(result.topicId)?.objective).toBe("");

    closeStore(store);
  });
});

// ── T1.5/T1.7: slug 重复 ────────────────────────────────────

describe("UC-1 create: 异常路径", () => {
  it("T1.5/T1.7 — slug 重复（同日同 slug → 同 topicId）：第二次 throw，原 topic 不被覆盖", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    const first = dispatch(
      { action: "create", slug: "dup", tier: "lite", objective: "original" },
      deps,
    );
    const originalId = first.topicId;

    // 同日同 slug → 同 topicId → PRIMARY KEY 冲突
    expect(() =>
      dispatch(
        { action: "create", slug: "dup", tier: "mid", objective: "overwrite attempt" },
        deps,
      ),
    ).toThrow();

    // 原 topic 未被覆盖
    const loaded = store.loadTopic(originalId);
    expect(loaded?.objective).toBe("original");
    expect(loaded?.tier).toBe("lite");

    closeStore(store);
  });

  it("T1.6 — 无效 tier：typebox CwParamsSchema 校验失败", () => {
    // typebox 校验在 protocol.validateParams 层，dispatch 前拦截。
    // 构造非法 raw params（tier="bad"），validateParams 应 throw。
    expect(() =>
      validateParams({ action: "create", slug: "x", tier: "bad", objective: "x" }),
    ).toThrow();
  });
});

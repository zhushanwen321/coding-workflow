/**
 * skeleton.test.ts — CLI e2e 骨架测试。
 *
 * 覆盖：UC-1 create → UC-2 plan → UC-3 dev → UC-6 replan → UC-4 status/list。
 * 测试层：mock（mock store/git/runner，不真实调 git）。
 *
 * 骨架阶段：测试用例签名完整，方法体 throw NotImplementedError（叶子断言留 Wave 实现）。
 */

import { describe, it, expect } from "vitest";

import { dispatch, GuardError } from "../../src/engine/dispatch.js";
import { CwStore } from "../../src/engine/store.js";
import { GateRunner, GitValidator } from "../../src/engine/gates.js";
import type { ActionDeps, ActionResult } from "../../src/engine/types.js";

// ── mock 依赖 ───────────────────────────────────────────────

function createMockDeps(): ActionDeps {
  // 骨架阶段：mock store/git/runner 构造。
  // 接线：new CwStore("/tmp/test/_cw.json") + new GitValidator("/tmp/test") + new GateRunner("/tmp/test")。
  // Wave 实现：注入内存 fake store 替代真实文件 IO。
  throw new Error("NotImplementedError: createMockDeps — 需要内存 fake store");
}

// ── UC-1: create ────────────────────────────────────────────

describe("UC-1: create", () => {
  it("T1.1: create lite topic 返回 topicId + status=created + nextAction.plan", () => {
    // 骨架：dispatch({action:"create", slug:"x", tier:"lite", objective:"test"}, mockDeps)
    // 断言：result.topicId 形如 cw-YYYY-MM-DD-x
    // 断言：result.status === "created"
    // 断言：result.nextAction.action === "plan"
    throw new Error("NotImplementedError: T1.1 断言体");
  });

  it("T1.2: create mid topic nextAction 指向 clarify", () => {
    // 骨架：dispatch({action:"create", slug:"y", tier:"mid", objective:"test"}, mockDeps)
    // 断言：result.nextAction.action === "clarify"
    throw new Error("NotImplementedError: T1.2 断言体");
  });

  it("T1.5: slug 重复抛 PRIMARY KEY 冲突", () => {
    // 骨架：两次 create 同 slug → 第二次 throw
    throw new Error("NotImplementedError: T1.5 断言体");
  });
});

// ── UC-2: plan ──────────────────────────────────────────────

describe("UC-2: plan", () => {
  it("T2.1: plan gate 通过 → status=planned", () => {
    // 骨架：先 create → dispatch plan 有效 plan.json
    // 断言：result.status === "planned"
    // 断言：result.gatePassed.plan === true
    throw new Error("NotImplementedError: T2.1 断言体");
  });

  it("T2.2: plan gate fail → status 不变 + gatePassed=false", () => {
    // 骨架：create → dispatch plan 无效 plan.json
    // 断言：result.status === "created"
    // 断言：result.gatePassed.plan === false
    throw new Error("NotImplementedError: T2.2 断言体");
  });

  it("T2.4: 非法状态转换 → GuardError", () => {
    // 骨架：create → plan → 再次 plan
    // 断言：throw GuardError, code="illegal_transition"
    throw new Error("NotImplementedError: T2.4 断言体");
  });
});

// ── UC-3: dev ───────────────────────────────────────────────

describe("UC-3: dev", () => {
  it("T3.1: 单 wave commit → wave.committed 更新", () => {
    // 骨架：create → plan → dispatch dev {waveId:"W1", commitHash:"abc"}
    // 断言：result.nextAction.waves 含 W1 committed=true
    throw new Error("NotImplementedError: T3.1 断言体");
  });
});

// ── UC-6: replan ────────────────────────────────────────────

describe("UC-6: replan", () => {
  it("T6.1: replan 追加新 wave → 旧 committed wave 不变", () => {
    // 骨架：create → plan → dev(W1) → replan(追加 W2)
    // 断言：waves 含 W1(committed) + W2(not committed)
    throw new Error("NotImplementedError: T6.1 断言体");
  });

  it("T6.2: 修改已 committed wave → append-only 拒绝", () => {
    // 骨架：create → plan → dev(W1) → replan(修改 W1 changes)
    // 断言：throw，含 "append-only"
    throw new Error("NotImplementedError: T6.2 断言体");
  });
});

// ── UC-4: status/list ───────────────────────────────────────

describe("UC-4: status/list", () => {
  it("T4.1: 查询已存在 topic → 返回 status/gatePassed/waves", () => {
    // 骨架：create → handleStatus(topicId)
    // 断言：result 含 topicId, status, gatePassed, waves
    throw new Error("NotImplementedError: T4.1 断言体");
  });

  it("T4.2: 查询不存在 topic → throw", () => {
    // 骨架：handleStatus("nonexistent")
    // 断言：throw "topic not found"
    throw new Error("NotImplementedError: T4.2 断言体");
  });
});

// ── NFR 测试 ────────────────────────────────────────────────

describe("NFR: 安全 + 稳定性", () => {
  it("T7.9: gate fail → exit 0", () => {
    // 骨架：plan gate fail → mapExitCode(result) === 0
    // 断言：exit code 0（gate fail 是正常返回）
    throw new Error("NotImplementedError: T7.9 断言体");
  });

  it("T7.10: illegal_transition → exit ≥1", () => {
    // 骨架：非法状态转换 → mapExitCode(error) ≥ 1
    throw new Error("NotImplementedError: T7.10 断言体");
  });
});

/**
 * v1 slice（PlanningUnit）状态机测试。
 *
 * 对应 PLANNING_TRANSITIONS（src/rules/state-machine.ts）：主链 7 步流转、guard 拒绝跳步、
 * progressive 语义、replan bypass、D1 关键差异（replan.from 不含 retrospected）、终态判定。
 *
 * 与 wave state-machine.test.ts 同构（照其结构写 slice 版），区别只在于：
 * - slice 主链 7 步（无 test/exec-review）
 * - replan.from 只有 {design-reviewed, executing}（D1：PlanningUnit replan 不在执行后触发）
 */
import { describe, expect, it } from "vitest";

import type { PlanningStatus } from "../../src/core/status.js";
import type { GuardVerdict } from "../../src/rules/state-machine.js";
import {
  guardPlanning,
  isPlanningTerminal,
  nextPlanningStatus,
} from "../../src/rules/state-machine.js";

/**
 * 从 GuardVerdict 取出 error branch 的 code（type narrowing helper）。
 * expect(verdict.ok).toBe(false) 是运行时断言，TS 不据此收窄联合类型，故显式收窄。
 */
function errorCode(verdict: GuardVerdict): string {
  if (verdict.ok) throw new Error("verdict unexpectedly ok");
  return verdict.code;
}

describe("slice 状态机: PLANNING_TRANSITIONS", () => {
  // ── 主链 7 步流转 ──────────────────────────────────────────
  describe("主链 7 步状态流转（无 test/exec-review）", () => {
    it("created→clarifying→planning→design-reviewed→executing→retrospected→closed", () => {
      let status: PlanningStatus = "created";
      status = nextPlanningStatus("clarify", status);
      expect(status).toBe("clarifying");
      status = nextPlanningStatus("plan", status);
      expect(status).toBe("planning");
      status = nextPlanningStatus("design-review", status);
      expect(status).toBe("design-reviewed");
      status = nextPlanningStatus("execute", status);
      expect(status).toBe("executing");
      status = nextPlanningStatus("retrospect", status);
      expect(status).toBe("retrospected");
      status = nextPlanningStatus("closeout", status);
      expect(status).toBe("closed");
    });
  });

  // ── guard 拒绝跳步 ─────────────────────────────────────────
  describe("guard 拒绝跳步", () => {
    it("created 状态直接 execute → illegal_transition", () => {
      const verdict = guardPlanning("execute", "created");
      expect(verdict.ok).toBe(false);
      expect(errorCode(verdict)).toBe("illegal_transition");
    });

    it("created 状态直接 retrospect → illegal_transition", () => {
      const verdict = guardPlanning("retrospect", "created");
      expect(verdict.ok).toBe(false);
    });

    it("planning 状态直接 closeout → illegal_transition（跳过 execute/retrospect）", () => {
      const verdict = guardPlanning("closeout", "planning");
      expect(verdict.ok).toBe(false);
    });

    it("design-reviewed 状态直接 retrospect → illegal_transition（slice 必须先 execute）", () => {
      const verdict = guardPlanning("retrospect", "design-reviewed");
      expect(verdict.ok).toBe(false);
    });
  });

  // ── progressive 语义 ───────────────────────────────────────
  describe("progressive 语义", () => {
    it("clarifying 再次 clarify → 仍为 clarifying", () => {
      expect(nextPlanningStatus("clarify", "clarifying")).toBe("clarifying");
    });

    it("planning 再次 plan → 仍为 planning", () => {
      expect(nextPlanningStatus("plan", "planning")).toBe("planning");
    });

    it("design-reviewed 再次 design-review → 仍为 design-reviewed", () => {
      expect(nextPlanningStatus("design-review", "design-reviewed")).toBe("design-reviewed");
    });

    it("plan 从 design-reviewed 进入 → 仍 planning（replan 后重规划路径，progressive）", () => {
      expect(nextPlanningStatus("plan", "design-reviewed")).toBe("planning");
    });
  });

  // ── replan bypass（不改 status）────────────────────────────
  describe("replan bypass（status 不变）", () => {
    it("design-reviewed 调 replan → status 不变（仍 design-reviewed）", () => {
      expect(nextPlanningStatus("replan", "design-reviewed")).toBe("design-reviewed");
    });

    it("executing 调 replan → status 不变（仍 executing）", () => {
      expect(nextPlanningStatus("replan", "executing")).toBe("executing");
    });
  });

  // ── D1 关键差异：PlanningUnit replan 不在执行后触发 ─────────
  describe("D1: PlanningUnit replan.from 不含 retrospected", () => {
    it("guardPlanning('replan','retrospected') → ok=false（replan 不在执行后触发）", () => {
      const verdict = guardPlanning("replan", "retrospected");
      expect(verdict.ok).toBe(false);
      expect(errorCode(verdict)).toBe("illegal_transition");
    });

    it("guardPlanning('replan','design-reviewed') → ok=true（replan 允许触发）", () => {
      const verdict = guardPlanning("replan", "design-reviewed");
      expect(verdict.ok).toBe(true);
    });

    it("guardPlanning('replan','executing') → ok=true（replan 允许触发）", () => {
      const verdict = guardPlanning("replan", "executing");
      expect(verdict.ok).toBe(true);
    });

    it("guardPlanning('replan','created') → ok=false（replan 不在执行前触发）", () => {
      const verdict = guardPlanning("replan", "created");
      expect(verdict.ok).toBe(false);
    });
  });

  // ── 终态判定 ───────────────────────────────────────────────
  describe("终态判定", () => {
    it("closed 是终态", () => {
      expect(isPlanningTerminal("closed")).toBe(true);
    });

    it("aborted 是终态", () => {
      expect(isPlanningTerminal("aborted")).toBe(true);
    });

    it("retrospected 不是终态（closeout 未完成）", () => {
      expect(isPlanningTerminal("retrospected")).toBe(false);
    });

    it("executing 不是终态", () => {
      expect(isPlanningTerminal("executing")).toBe(false);
    });

    it("closed 后任何 action → illegal_transition", () => {
      const verdict = guardPlanning("execute", "closed");
      expect(verdict.ok).toBe(false);
      expect(errorCode(verdict)).toBe("illegal_transition");
    });
  });

  // ── abort 允许范围 ─────────────────────────────────────────
  describe("abort 允许范围", () => {
    it("executing 调 abort → ok=true", () => {
      expect(guardPlanning("abort", "executing").ok).toBe(true);
    });

    it("retrospected 调 abort → ok=true（retrospect 后到 closeout 前仍可 abort）", () => {
      expect(guardPlanning("abort", "retrospected").ok).toBe(true);
    });

    it("closed 调 abort → ok=false（终态不可逆）", () => {
      expect(guardPlanning("abort", "closed").ok).toBe(false);
    });
  });
});

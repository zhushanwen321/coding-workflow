/**
 * v1 wave 状态机测试（TDD 红灯骨架）。
 *
 * 对应 test.json U1-U7。src/v1/ 实现前这些测试因 import 失败而红灯。
 * dev 阶段 W1（core 类型）+ W2（state-machine）实现后转绿。
 */
import { describe, expect,it } from "vitest";

import type { ExecutionStatus } from "../../src/v1/core/status.js";
import { createWave } from "../../src/v1/core/workunit.js";
import type { GuardVerdict } from "../../src/v1/rules/state-machine.js";
import {
  guardWave,
  isWaveTerminal,
  nextWaveStatus,
} from "../../src/v1/rules/state-machine.js";

/**
 * 从 GuardVerdict 取出 error branch 的 code（type narrowing helper）。
 * expect(verdict.ok).toBe(false) 是运行时断言，TS 不据此收窄联合类型，故显式收窄。
 */
function errorCode(verdict: GuardVerdict): string {
  if (verdict.ok) throw new Error("verdict unexpectedly ok");
  return verdict.code;
}

describe("W1+W2: wave 状态机", () => {
  // U1: 主链 9 步流转
  describe("U1: 主链 9 步状态流转", () => {
    it("created→clarifying→planning→design-reviewed→executing→tested→exec-reviewed→retrospected→closed", () => {
      let status: ExecutionStatus = "created";
      status = nextWaveStatus("clarify", status);
      expect(status).toBe("clarifying");
      status = nextWaveStatus("plan", status);
      expect(status).toBe("planning");
      status = nextWaveStatus("design-review", status);
      expect(status).toBe("design-reviewed");
      status = nextWaveStatus("execute", status);
      expect(status).toBe("executing");
      status = nextWaveStatus("test", status);
      expect(status).toBe("tested");
      status = nextWaveStatus("exec-review", status);
      expect(status).toBe("exec-reviewed");
      status = nextWaveStatus("retrospect", status);
      expect(status).toBe("retrospected");
      status = nextWaveStatus("closeout", status);
      expect(status).toBe("closed");
    });
  });

  // U2: guard 拒绝跳步
  describe("U2: guard 拒绝跳步", () => {
    it("created 状态直接 execute → illegal_transition", () => {
      const verdict = guardWave("execute", "created");
      expect(verdict.ok).toBe(false);
      expect(errorCode(verdict)).toBe("illegal_transition");
    });

    it("created 状态直接 test → illegal_transition", () => {
      const verdict = guardWave("test", "created");
      expect(verdict.ok).toBe(false);
    });
  });

  // U3: progressive 语义
  describe("U3: progressive 语义", () => {
    it("clarifying 再次 clarify → 仍为 clarifying", () => {
      expect(nextWaveStatus("clarify", "clarifying")).toBe("clarifying");
    });

    it("planning 再次 plan → 仍为 planning", () => {
      expect(nextWaveStatus("plan", "planning")).toBe("planning");
    });

    it("design-reviewed 再次 design-review → 仍为 design-reviewed", () => {
      expect(nextWaveStatus("design-review", "design-reviewed")).toBe("design-reviewed");
    });
  });

  // U4: replan bypass（不改 status）
  describe("U4: replan bypass", () => {
    it("design-reviewed 调 replan → status 不变", () => {
      expect(nextWaveStatus("replan", "design-reviewed")).toBe("design-reviewed");
    });

    it("executing 调 replan → status 不变", () => {
      expect(nextWaveStatus("replan", "executing")).toBe("executing");
    });

    it("tested 调 replan → status 不变", () => {
      expect(nextWaveStatus("replan", "tested")).toBe("tested");
    });
  });

  // U5: createWave 工厂
  describe("U5: createWave 工厂初始化", () => {
    it("初始化通用字段正确", () => {
      const wave = createWave({
        slug: "test-w1",
        objective: "test objective",
        parentUnitId: "slice:test-slice",
        basedOnParent: ["TC1", "TK1"],
      });
      expect(wave.id).toBe("wave:test-w1");
      expect(wave.scope).toBe("wave");
      expect(wave.slug).toBe("test-w1");
      expect(wave.parentUnitId).toBe("slice:test-slice");
      expect(wave.status).toBe("created");
      expect(wave.basedOnParent).toEqual(["TC1", "TK1"]);
      expect(wave.abandonedRefs).toEqual([]);
      expect(wave.objective).toBe("test objective");
      // statusHistory 首条
      expect(wave.statusHistory).toHaveLength(1);
      expect(wave.statusHistory[0]!.action).toBe("create");
      expect(wave.statusHistory[0]!.to).toBe("created");
      expect(wave.statusHistory[0]!.from).toBeUndefined();
    });
  });

  // U6: wave plan 特化（from 含 design-reviewed）
  describe("U6: wave plan 特化", () => {
    it("plan 从 design-reviewed 进入 → ok（replan 后重规划路径）", () => {
      const verdict = guardWave("plan", "design-reviewed");
      expect(verdict.ok).toBe(true);
    });

    it("plan 从 clarifying 进入 → ok（首次规划）", () => {
      const verdict = guardWave("plan", "clarifying");
      expect(verdict.ok).toBe(true);
    });
  });

  // U7: 终态判定
  describe("U7: 终态判定", () => {
    it("closed 是终态", () => {
      expect(isWaveTerminal("closed")).toBe(true);
    });

    it("aborted 是终态", () => {
      expect(isWaveTerminal("aborted")).toBe(true);
    });

    it("retrospected 不是终态", () => {
      expect(isWaveTerminal("retrospected")).toBe(false);
    });

    it("closed 后任何 action → illegal_transition", () => {
      const verdict = guardWave("execute", "closed");
      expect(verdict.ok).toBe(false);
      expect(errorCode(verdict)).toBe("illegal_transition");
    });
  });
});

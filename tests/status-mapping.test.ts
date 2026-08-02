/**
 * status→action 映射表的交叉校验。
 *
 * INFO-1 防护：三表（WAVE_STATUS_TO_ACTION / PLANNING_STATUS_TO_ACTION / TERMINAL_STATUSES）
 * 此前在 frontier.ts + render.ts 各维护一份，靠手保持一致——status 枚举新增时易漏改一处。
 * 现已提取到 core/status.ts 共享单一定义源。本测试补上交叉校验：
 *   1. 映射表覆盖对应 status 枚举的全部值（新增 status 时若忘加映射，测试报错）
 *   2. 终态在映射表中为 undefined（frontier/render 不应给终态输出「下一步」）
 *   3. 非终态在映射表中非空（每个可推进的 status 都要有明确的下一步 action）
 */
import { describe, expect, it } from "vitest";

import {
  type ExecutionStatus,
  PLANNING_STATUS_TO_ACTION,
  type PlanningStatus,
  TERMINAL_STATUSES,
  WAVE_STATUS_TO_ACTION,
} from "../src/core/status.js";

describe("status→action 映射表（core/status.ts 共享源）", () => {
  it("WAVE_STATUS_TO_ACTION 覆盖所有 ExecutionStatus 枚举值", () => {
    const waveStatuses: ExecutionStatus[] = [
      "created",
      "clarifying",
      "planning",
      "design-reviewed",
      "executing",
      "tested",
      "exec-reviewed",
      "retrospected",
      "closed",
      "aborted",
    ];
    // 每个 status 在映射表中都有 key（终态 value=undefined 也算覆盖）
    for (const s of waveStatuses) {
      expect(s in WAVE_STATUS_TO_ACTION, `status=${s} 未在 WAVE_STATUS_TO_ACTION 中定义`).toBe(true);
    }
    // 映射表无多余 key
    expect(Object.keys(WAVE_STATUS_TO_ACTION).sort()).toEqual([...waveStatuses].sort());
  });

  it("PLANNING_STATUS_TO_ACTION 覆盖所有 PlanningStatus 枚举值", () => {
    const planningStatuses: PlanningStatus[] = [
      "created",
      "clarifying",
      "planning",
      "design-reviewed",
      "executing",
      "retrospected",
      "closed",
      "aborted",
    ];
    for (const s of planningStatuses) {
      expect(s in PLANNING_STATUS_TO_ACTION, `status=${s} 未在 PLANNING_STATUS_TO_ACTION 中定义`).toBe(true);
    }
    expect(Object.keys(PLANNING_STATUS_TO_ACTION).sort()).toEqual([...planningStatuses].sort());
  });

  it("终态在两表中均为 undefined（无「下一步」）", () => {
    for (const terminal of TERMINAL_STATUSES) {
      expect(WAVE_STATUS_TO_ACTION[terminal]).toBeUndefined();
      expect(PLANNING_STATUS_TO_ACTION[terminal]).toBeUndefined();
    }
  });

  it("非终态在两表中均非空（每个可推进 status 都有明确下一步 action）", () => {
    const waveNonTerminal = Object.entries(WAVE_STATUS_TO_ACTION).filter(
      ([s]) => !TERMINAL_STATUSES.has(s),
    );
    for (const [s, action] of waveNonTerminal) {
      expect(action, `status=${s} 应有非空 nextAction`).toBeTruthy();
    }

    const planningNonTerminal = Object.entries(PLANNING_STATUS_TO_ACTION).filter(
      ([s]) => !TERMINAL_STATUSES.has(s),
    );
    for (const [s, action] of planningNonTerminal) {
      expect(action, `status=${s} 应有非空 nextAction`).toBeTruthy();
    }
  });
});

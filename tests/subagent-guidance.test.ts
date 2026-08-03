/**
 * subagent-guidance 测试：分级表 + buildSubagentGuidance + buildNormalGuidance 第 4 段集成。
 *
 * 覆盖：
 * - buildSubagentGuidance 对两层各 action 的分级正确性（强制/建议/禁止）
 * - 禁止档不追加嵌套决策树；强制/建议档追加
 * - 查表未命中（create/abort 等无规则 action）返回空串
 * - buildNormalGuidance 传 commonGuidance 时渲染第 4 段；空/undefined 时省略
 */
import { describe, expect, it } from "vitest";

import { buildNormalGuidance } from "../src/guidance/build-guidance.js";
import { buildSubagentGuidance } from "../src/guidance/subagent-guidance.js";

// ═══════════════════════════════════════════════════════════════
// TC1: wave 层分级表
// ═══════════════════════════════════════════════════════════════

describe("buildSubagentGuidance: wave 层", () => {
  // 强制委派：execute（密度极高·实现）+ design-review/exec-review（质量·审查）
  describe("强制委派档（mandatory）", () => {
    it("execute → 建议委派 + 实现方向 + 不含按需", () => {
      const g = buildSubagentGuidance("wave", "execute");
      expect(g).toContain("【建议委派】");
      expect(g).toContain("代码实现");
      expect(g).not.toContain("按需");
    });

    it("design-review → 建议委派 + 审查方向", () => {
      const g = buildSubagentGuidance("wave", "design-review");
      expect(g).toContain("【建议委派】");
      expect(g).toContain("代码审查");
      expect(g).toContain("避免确认偏差");
    });

    it("exec-review → 建议委派 + 审查方向", () => {
      const g = buildSubagentGuidance("wave", "exec-review");
      expect(g).toContain("【建议委派】");
      expect(g).toContain("代码审查");
    });
  });

  // 建议委派（按需）：clarify/plan/test/replan（探索/测试执行方向）+ closeout（综合）
  describe("按需委派档（optional）", () => {
    it("clarify → 按需委派 + 探索方向", () => {
      const g = buildSubagentGuidance("wave", "clarify");
      expect(g).toContain("【按需委派】");
      expect(g).toContain("代码探索");
    });

    it("plan → 按需委派 + 探索方向", () => {
      const g = buildSubagentGuidance("wave", "plan");
      expect(g).toContain("【按需委派】");
      expect(g).toContain("代码探索");
    });

    it("test → 按需委派 + 测试执行方向", () => {
      const g = buildSubagentGuidance("wave", "test");
      expect(g).toContain("【按需委派】");
      expect(g).toContain("测试执行");
    });

    it("replan → 按需委派 + 探索方向", () => {
      const g = buildSubagentGuidance("wave", "replan");
      expect(g).toContain("【按需委派】");
      expect(g).toContain("代码探索");
    });

    it("closeout → 按需委派 + 综合方向 + 带条件说明", () => {
      const g = buildSubagentGuidance("wave", "closeout");
      expect(g).toContain("【按需委派】");
      expect(g).toContain("综合");
      // closeout 特有：主 agent 有全程跟踪时自己做更优
      expect(g).toContain("全程跟踪");
    });
  });

  // 按需委派：retrospect（输入含执行轨迹，规模大时可委派）
  describe("按需委派档（optional）", () => {
    it("retrospect → 按需委派 + 综合方向", () => {
      const g = buildSubagentGuidance("wave", "retrospect");
      expect(g).toContain("【按需委派】");
      expect(g).toContain("综合");
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// TC2: planning 层（slice/feature/epic 共用）分级表
// ═══════════════════════════════════════════════════════════════

describe("buildSubagentGuidance: planning 层", () => {
  describe("强制委派档（mandatory）", () => {
    it("design-review → 建议委派 + 审查 Split 设计", () => {
      const g = buildSubagentGuidance("planning", "design-review");
      expect(g).toContain("【建议委派】");
      expect(g).toContain("代码审查");
      expect(g).toContain("Split");
    });
  });

  describe("按需委派档（optional）", () => {
    it("clarify → 按需委派", () => {
      const g = buildSubagentGuidance("planning", "clarify");
      expect(g).toContain("【按需委派】");
    });

    it("plan → 按需委派", () => {
      const g = buildSubagentGuidance("planning", "plan");
      expect(g).toContain("【按需委派】");
    });

    it("closeout → 按需委派 + 综合", () => {
      const g = buildSubagentGuidance("planning", "closeout");
      expect(g).toContain("【按需委派】");
      expect(g).toContain("综合");
    });
  });

  describe("禁止委派档（forbidden）", () => {
    it("execute → 不建议委派 + 编排性质理由（拆分+下沉）", () => {
      const g = buildSubagentGuidance("planning", "execute");
      expect(g).toContain("【不建议委派】");
      expect(g).toContain("编排决策");
      expect(g).not.toContain("支持嵌套");
    });
  });

  // 按需委派：retrospect（输入含执行轨迹，规模大时可委派）
  describe("按需委派档（optional）", () => {
    it("retrospect → 按需委派 + 综合方向", () => {
      const g = buildSubagentGuidance("planning", "retrospect");
      expect(g).toContain("【按需委派】");
      expect(g).toContain("综合");
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// TC3: 查表未命中 → 返回空串
// ═══════════════════════════════════════════════════════════════

describe("buildSubagentGuidance: 查表未命中返回空串", () => {
  it("wave 层 create → 空（入口 action 无规则）", () => {
    expect(buildSubagentGuidance("wave", "create")).toBe("");
  });

  it("wave 层 abort → 空（终态 action 无规则）", () => {
    expect(buildSubagentGuidance("wave", "abort")).toBe("");
  });

  it("planning 层 create → 空", () => {
    expect(buildSubagentGuidance("planning", "create")).toBe("");
  });

  it("planning 层 replan → 空（planning 无 replan 模板）", () => {
    expect(buildSubagentGuidance("planning", "replan")).toBe("");
  });

  it("planning 层 test → 空（test 由 child wave 承担，planning 无此 action）", () => {
    expect(buildSubagentGuidance("planning", "test")).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════
// TC4: buildNormalGuidance 第 4 段集成
// ═══════════════════════════════════════════════════════════════

describe("buildNormalGuidance: commonGuidance 第 4 段渲染", () => {
  const baseArgs = {
    prefix: "[wave:1] status=plan",
    nextAction: "plan",
    goal: "编写执行计划",
    command: "cw plan --unitId wave:1 --input .cw/1/plan.json",
    schemaText: "{ schema }",
    templateText: "关键约束：testCases 不能为空",
  };

  it("commonGuidance 非空 → 渲染第 4 段「## subagent 调度」", () => {
    const guidance = buildNormalGuidance({
      ...baseArgs,
      commonGuidance: "【按需委派】规模大时考虑派 subagent。",
    });
    expect(guidance).toContain("## subagent 调度");
    expect(guidance).toContain("【按需委派】");
    // 第 4 段在 input schema 段之后
    const schemaIdx = guidance.indexOf("## input schema + 关键约束");
    const subagentIdx = guidance.indexOf("## subagent 调度");
    expect(subagentIdx).toBeGreaterThan(schemaIdx);
  });

  it("commonGuidance 为空串 → 不渲染第 4 段（保持三段式）", () => {
    const guidance = buildNormalGuidance({
      ...baseArgs,
      commonGuidance: "",
    });
    expect(guidance).not.toContain("## subagent 调度");
  });

  it("commonGuidance 为 undefined → 不渲染第 4 段", () => {
    const guidance = buildNormalGuidance({
      ...baseArgs,
    });
    expect(guidance).not.toContain("## subagent 调度");
  });

  it("commonGuidance 全空白 → 不渲染第 4 段", () => {
    const guidance = buildNormalGuidance({
      ...baseArgs,
      commonGuidance: "   \n  \t ",
    });
    expect(guidance).not.toContain("## subagent 调度");
  });

  it("集成：wave execute 的 commonGuidance 经 buildSubagentGuidance 生成 → 含强制委派", () => {
    const guidance = buildNormalGuidance({
      ...baseArgs,
      nextAction: "execute",
      commonGuidance: buildSubagentGuidance("wave", "execute"),
    });
    expect(guidance).toContain("## subagent 调度");
    expect(guidance).toContain("【建议委派】");
    expect(guidance).toContain("代码实现");
  });
});

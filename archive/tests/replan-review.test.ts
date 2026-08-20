/**
 * replan 审视引导模板测试。
 *
 * 覆盖 src/guidance/templates/replan-review.ts 的 buildReplanReviewText。
 * 纯函数零 IO，零 mock：直接 import 调用，断言返回字符串。
 *
 * 分支覆盖：
 * - replanCount < 2：基础文案（单点 vs 方向性诊断引导），无系统性警告
 * - replanCount === 2：追加系统性问题警告段落
 * - replanCount >= 3：追加强烈 abort 建议段落
 * - abandonedIds 空数组 vs 多个 id 渲染
 * - 阈值边界（1 vs 2）
 */
import { describe, expect, it } from "vitest";

import { buildReplanReviewText } from "../src/guidance/templates/replan-review.js";

describe("buildReplanReviewText", () => {
  describe("基础文案（与 replanCount 无关）", () => {
    it("包含废弃条目告知与「重新审视」段头", () => {
      const text = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 1,
      });
      expect(text).toContain("你刚发起了 replan");
      expect(text).toContain("## 重新审视");
    });

    it("包含单点诊断 vs 方向性诊断的引导", () => {
      const text = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 1,
      });
      expect(text).toContain("【单点问题】");
      expect(text).toContain("【方向性问题】");
      // 单点问题 → 补新条目；方向性问题 → 检查其他条目依赖
      expect(text).toMatch(/补新条目/);
      expect(text).toMatch(/检查其他条目/);
    });

    it("包含审视维度（架构合理性 / 鲁棒性 / 兼容性）", () => {
      const text = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 1,
      });
      expect(text).toContain("架构合理性");
      expect(text).toContain("鲁棒性");
      expect(text).toContain("兼容性");
    });

    it("提示重走 design → design-review → execute", () => {
      const text = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 1,
      });
      expect(text).toMatch(/重新 design/);
      expect(text).toMatch(/design-review/);
    });

    it("含 abandonParentItems 提示（声明脱离 parent 条目的可选项）", () => {
      const text = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 1,
      });
      // replan 时如需一并声明脱离 parent 条目，可带 abandonParentItems 字段
      expect(text).toContain("abandonParentItems");
      expect(text).toContain("--abandonParentItems");
      // 应在基础文案段（replanCount=1 即可出现），而非渐进警告段
      expect(text).toContain("声明脱离 parent");
    });
  });

  describe("replanCount < 2：仅基础文案，无系统性警告", () => {
    it("replanCount === 1 不含系统性问题警告", () => {
      const text = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 1,
      });
      expect(text).not.toContain("系统性问题");
      expect(text).not.toContain("abort");
    });
  });

  describe("replanCount === 2：追加系统性问题警告段落", () => {
    it("包含基础文案 + 系统性问题警告", () => {
      const text = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 2,
      });
      // 基础文案仍在
      expect(text).toContain("## 重新审视");
      expect(text).toContain("【单点问题】");
      // 追加警告
      expect(text).toContain("系统性问题");
      expect(text).toMatch(/重新 design 补充澄清/);
    });

    it("不含强烈 abort 建议（仅 >= 3 才有）", () => {
      const text = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 2,
      });
      // 警告里会提到 abort 整个 unit 作为可选建议，但不含「强烈建议 abort」明确段落
      expect(text).not.toContain("强烈建议 abort");
    });
  });

  describe("replanCount >= 3：追加强烈 abort 建议段落", () => {
    it("replanCount === 3 含基础 + 警告 + 强烈 abort 建议", () => {
      const text = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 3,
      });
      expect(text).toContain("## 重新审视");
      expect(text).toContain("系统性问题");
      expect(text).toContain("强烈建议 abort");
      expect(text).toMatch(/已 replan 3 次/);
    });

    it("replanCount > 3（如 5）依然含强烈 abort 建议", () => {
      const text = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 5,
      });
      expect(text).toContain("强烈建议 abort");
      expect(text).toContain("系统性问题");
    });
  });

  describe("阈值边界（1 vs 2）", () => {
    it("replanCount === 1 与 === 2 的差异：警告段落在 2 时出现", () => {
      const text1 = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 1,
      });
      const text2 = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 2,
      });
      expect(text1).not.toContain("系统性问题");
      expect(text2).toContain("系统性问题");
      // 2 比 1 多出系统性警告内容
      expect(text2.length).toBeGreaterThan(text1.length);
    });
  });

  describe("abandonedIds 渲染", () => {
    it("空数组不崩溃，仍输出完整结构", () => {
      const text = buildReplanReviewText({
        abandonedIds: [],
        replanCount: 1,
      });
      // 不 throw 且保留关键段
      expect(text).toContain("你刚发起了 replan");
      expect(text).toContain("## 重新审视");
      expect(text).toContain("【单点问题】");
    });

    it("单个 id 被引号包裹渲染", () => {
      const text = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 1,
      });
      expect(text).toContain('"slice-1"');
    });

    it("多个 id 用「、」连接渲染", () => {
      const text = buildReplanReviewText({
        abandonedIds: ["slice-1", "slice-2", "slice-3"],
        replanCount: 1,
      });
      expect(text).toContain('"slice-1"、"slice-2"、"slice-3"');
    });
  });

  describe("planReachable=false（无回流通道，如 executing 内容 replan）", () => {
    it("省略「重新 design 并重新 design-review」引导句", () => {
      const text = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 1,
        planReachable: false,
      });
      // 该句与 blockedHint 同屏矛盾（该状态推 plan 即 illegal_transition）
      expect(text).not.toContain("重新 design 并重新 design-review");
      // 其余审视引导保留（单点/方向性诊断、审视维度）
      expect(text).toContain("## 重新审视");
      expect(text).toContain("【单点问题】");
      expect(text).toContain("架构合理性");
    });

    it("planReachable=true（默认）保留该句，行为不变", () => {
      const text = buildReplanReviewText({
        abandonedIds: ["slice-1"],
        replanCount: 1,
      });
      expect(text).toContain("重新 design 并重新 design-review");
    });
  });
});

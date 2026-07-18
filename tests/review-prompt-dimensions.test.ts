/**
 * review-prompt-dimensions 单测 — 步骤 4：REVIEW_PROMPT 改函数 + dimensions 子集化。
 *
 * 覆盖：
 *   - AC-7: buildReviewPrompt(dimensions) 按子集过滤维度表
 *   - AC-8: full-tdd 全 6 维输出 == 原 REVIEW_PROMPT（等价性锁定）
 *   - AC-9: delete-only/doc-only review guidance 只含声明的 dimensions 子集
 *
 * 设计：REVIEW_PROMPT 常量保留（= buildReviewPrompt(全 6 维) 的返回值，向后兼容），
 * buildReviewPrompt 是参数化版本，按 dimensions 子集过滤维度表行。
 */

import { describe, expect, it } from "vitest";

import { buildReviewPrompt, REVIEW_PROMPT } from "../src/prompts/review.js";
import { getShape } from "../src/shapes/registry.js";
import type { ReviewDimension } from "../src/types.js";

// ── AC-8: 等价性锁定 ──────────────────────────────────────

describe("AC-8: buildReviewPrompt 全 6 维 == 原 REVIEW_PROMPT（等价性）", () => {
  const ALL_6_DIMENSIONS: ReviewDimension[] = [
    "type-safety",
    "error-handling",
    "edge-case",
    "test-coverage",
    "plan-completeness",
    "design-consistency",
  ];

  it("全 6 维输出与 REVIEW_PROMPT 常量逐字节相等", () => {
    expect(buildReviewPrompt(ALL_6_DIMENSIONS)).toBe(REVIEW_PROMPT);
  });

  it("full-tdd shape 的 dimensions 是全 6 维", () => {
    const dims = getShape("full-tdd").review.dimensions;
    expect(dims).toEqual(ALL_6_DIMENSIONS);
  });

  it("full-tdd shape 调 buildReviewPrompt == REVIEW_PROMPT", () => {
    const dims = getShape("full-tdd").review.dimensions;
    expect(buildReviewPrompt(dims)).toBe(REVIEW_PROMPT);
  });
});

// ── AC-7: 子集过滤 ────────────────────────────────────────

describe("AC-7: buildReviewPrompt 按子集过滤", () => {
  it("只传 type-safety → 输出含 type-safety 行，不含其他 5 维", () => {
    const prompt = buildReviewPrompt(["type-safety"]);
    expect(prompt).toContain("type-safety");
    expect(prompt).not.toContain("error-handling");
    expect(prompt).not.toContain("edge-case");
    expect(prompt).not.toContain("design-consistency");
  });

  it("传 2 个维度 → 输出含这 2 行，不含其余 4 维", () => {
    const prompt = buildReviewPrompt(["edge-case", "design-consistency"]);
    expect(prompt).toContain("edge-case");
    expect(prompt).toContain("design-consistency");
    expect(prompt).not.toContain("type-safety");
    expect(prompt).not.toContain("error-handling");
  });

  it("prompt 主体内容不因子集变化（审查流程/severity/ref 等）", () => {
    const fullPrompt = buildReviewPrompt(["type-safety"]);
    const expectedStableContent = [
      "审查流程",
      "severity",
      "must-fix",
      "review fix loop",
      "review.md",
    ];
    for (const content of expectedStableContent) {
      expect(fullPrompt).toContain(content);
    }
  });
});

// ── AC-9: delete-only/doc-only 子集 ───────────────────────

describe("AC-9: delete-only/doc-only dimensions 子集", () => {
  it("delete-only（LeanReviewPolicy）dimensions 只含 design-consistency + edge-case", () => {
    const dims = getShape("delete-only").review.dimensions;
    expect(dims).toEqual(["design-consistency", "edge-case"]);
  });

  it("delete-only buildReviewPrompt 只含声明维度行", () => {
    const dims = getShape("delete-only").review.dimensions;
    const prompt = buildReviewPrompt(dims);
    expect(prompt).toContain("design-consistency");
    expect(prompt).toContain("edge-case");
    // 不含未声明的维度
    expect(prompt).not.toContain("type-safety");
    expect(prompt).not.toContain("error-handling");
    expect(prompt).not.toContain("test-coverage");
    expect(prompt).not.toContain("plan-completeness");
  });

  it("doc-only（DocReviewPolicy）dimensions 只含 design-consistency", () => {
    const dims = getShape("doc-only").review.dimensions;
    expect(dims).toEqual(["design-consistency"]);
  });

  it("doc-only buildReviewPrompt 只含 design-consistency 行", () => {
    const dims = getShape("doc-only").review.dimensions;
    const prompt = buildReviewPrompt(dims);
    expect(prompt).toContain("design-consistency");
    expect(prompt).not.toContain("edge-case");
    expect(prompt).not.toContain("type-safety");
  });
});

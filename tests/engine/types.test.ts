/**
 * types.ts 单测 — judgeByExpected 机器重算（来源 0，#8 方案 A 等价迁移）。
 *
 * 8 条用例从 src/__tests__/test-orchestrator.test.ts 的 describe("judgeByExpected") 迁移，
 * 输入格式无关（expected 是结构化对象），直接迁移保障判定逻辑等价（AC-8.1）。
 *
 * D-008 lite strong-recompute：claimedStatus 在调用方丢弃，本函数只看 expected/actual。
 */

import { describe, expect, it } from "vitest";

import { type Actual, type Expected, judgeByExpected } from "../../src/engine/types.js";

describe("judgeByExpected — 机器重算（AI 摸不到判定逻辑）", () => {
  it("expected.url 匹配 → passed", () => {
    const expected: Expected = { url: "/profile" };
    const actual: Actual = { url: "/profile" };
    expect(judgeByExpected(expected, actual)).toEqual({ status: "passed", reason: "" });
  });

  it("expected.url 不匹配 → failed + 逐字段原因", () => {
    const expected: Expected = { url: "/profile" };
    const actual: Actual = { url: "/login" };
    const r = judgeByExpected(expected, actual);
    expect(r.status).toBe("failed");
    expect(r.reason).toContain('url: "/login" !== "/profile"');
  });

  it("expected.url 存在但 actual.url 缺失 → failed", () => {
    const expected: Expected = { url: "/profile" };
    const actual: Actual = {};
    const r = judgeByExpected(expected, actual);
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("url missing");
  });

  it("expected.text 匹配 → passed", () => {
    const expected: Expected = { text: "用户名" };
    const actual: Actual = { text: "用户名" };
    expect(judgeByExpected(expected, actual)).toEqual({ status: "passed", reason: "" });
  });

  it("url + text 都存在，全匹配 → passed", () => {
    const expected: Expected = { url: "/profile", text: "用户名" };
    const actual: Actual = { url: "/profile", text: "用户名" };
    expect(judgeByExpected(expected, actual).status).toBe("passed");
  });

  it("url 匹配但 text 不匹配 → failed（逐字段独立判定）", () => {
    const expected: Expected = { url: "/profile", text: "用户名" };
    const actual: Actual = { url: "/profile", text: "错误" };
    const r = judgeByExpected(expected, actual);
    expect(r.status).toBe("failed");
    expect(r.reason).toContain('text: "错误" !== "用户名"');
    expect(r.reason).not.toContain("url"); // url 那条不该出现在 mismatch
  });

  it("expected 无任何字段 → failed（兜底，plan-parser 应已拦）", () => {
    const r = judgeByExpected({}, { url: "/x" });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/no judgeable field/);
  });

  it("exact match——URL 末尾斜杠差异也算不匹配", () => {
    const expected: Expected = { url: "/profile" };
    const actual: Actual = { url: "/profile/" };
    expect(judgeByExpected(expected, actual).status).toBe("failed");
  });
});

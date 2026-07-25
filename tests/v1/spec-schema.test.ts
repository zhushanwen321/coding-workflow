/**
 * v1 rules — spec-schema（FeatureSpec 校验纯函数）测试。
 *
 * 测 validateFeatureSpec：合法 spec 通过 / 漏 ac 失败 / 字段类型错失败 / 额外字段允许 / 空对象失败。
 * 纯函数，零 IO，零 mock。
 */
import { describe, expect, it } from "vitest";

import { validateFeatureSpec } from "../../src/v1/rules/spec-schema.js";
import { makeFeatureSpec } from "./helpers/feature-env.js";

describe("validateFeatureSpec", () => {
  it("合法 spec（FR.ac 强引用 AC）通过", () => {
    const spec = makeFeatureSpec();
    const result = validateFeatureSpec(spec);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("FR 缺 ac 字段失败（崩溃根因场景：字段名拼错或缺 ac 数组）", () => {
    const spec = {
      ...makeFeatureSpec(),
      // 模拟真实事故：FR 自创 {id,status,priority,statement}，缺 ac 数组
      functionalRequirements: [
        { id: "FR1", status: "active", priority: "high", statement: "应支持图片附件" },
      ],
    };
    const result = validateFeatureSpec(spec);
    expect(result.valid).toBe(false);
    // 错误路径必须指向 functionalRequirements 下的 ac
    expect(result.errors.some((e) => e.includes("functionalRequirements") && e.includes("ac"))).toBe(true);
  });

  it("FR.ac 类型错（非数组）失败", () => {
    const spec = {
      ...makeFeatureSpec(),
      functionalRequirements: [
        { id: "FR1", status: "active", title: "t", detail: "d", ac: "AC1" },
      ],
    };
    const result = validateFeatureSpec(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ac"))).toBe(true);
  });

  it("status 非 active/abandoned 失败", () => {
    const spec = {
      ...makeFeatureSpec(),
      functionalRequirements: [
        { id: "FR1", status: "done", title: "t", detail: "d", ac: ["AC1"] },
      ],
    };
    const result = validateFeatureSpec(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("status"))).toBe(true);
  });

  it("AC 缺 condition 失败", () => {
    const spec = {
      ...makeFeatureSpec(),
      acceptanceCriteria: [{ id: "AC1", status: "active" }],
    };
    const result = validateFeatureSpec(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("condition"))).toBe(true);
  });

  it("额外字段（priority/statement）允许通过——不破坏 agent 已附加的信息", () => {
    const spec = {
      ...makeFeatureSpec(),
      functionalRequirements: [
        {
          id: "FR1",
          status: "active",
          title: "t",
          detail: "d",
          ac: ["AC1"],
          priority: "high",
          statement: "附加说明",
          customField: 123,
        },
      ],
    };
    const result = validateFeatureSpec(spec);
    expect(result.valid).toBe(true);
  });

  it("非对象 / null 失败", () => {
    expect(validateFeatureSpec(null).valid).toBe(false);
    expect(validateFeatureSpec("not an object").valid).toBe(false);
    expect(validateFeatureSpec(undefined).valid).toBe(false);
  });

  it("缺必填顶层数组（functionalRequirements 缺失）失败", () => {
    const spec = {
      acceptanceCriteria: [],
      businessCases: [],
      decisions: [],
      outOfScope: [],
    };
    const result = validateFeatureSpec(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("functionalRequirements"))).toBe(true);
  });
});

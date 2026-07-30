/**
 * v1 feature clarify 结构校验 e2e 测试。
 *
 * 测畸形 spec（FR 缺 ac 数组）在 clarify 阶段被 validateFeatureSpec 拦截：
 * - 返回 ok=false（而非崩溃或静默通过）
 * - error 含具体字段路径（functionalRequirements / ac）
 * - status 不流转（仍 created）
 *
 * 真实 dispatch 路径（create → clarify），零 mock。
 *
 * 测试构造的畸形 spec 故意违反 FeatureSpec 类型——用 `as FeatureSpec` 显式标注类型逃逸
 * （测试目的是验证运行时校验能拦住 TS 类型系统挡不住的畸形数据）。
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { FeatureSpec } from "../src/core/clarifications.js";
import { dispatch } from "../src/dispatch.js";
import type { CwEnv } from "./helpers/env.js";
import {
  createCwEnv,
  makeFeatureClarifyInput,
  makeFeatureSpec,
} from "./helpers/feature-env.js";

let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
});

describe("feature clarify 结构校验（畸形 spec 被拦）", () => {
  it("FR 缺 ac 字段（真实事故场景）→ clarify ok=false，error 含 functionalRequirements/ac", () => {
    const unitId = "feature:clarify-bad-fr";
    dispatch(
      { action: "create", input: { slug: "clarify-bad-fr", objective: "o", layer: "feature" } },
      env.deps,
    );
    // 模拟真实事故：FR 自创 {id,status,priority,statement}，缺 ac 数组
    const badSpec = {
      ...makeFeatureSpec(),
      functionalRequirements: [
        { id: "FR1", status: "active", priority: "high", statement: "应支持图片附件" },
      ],
    } as unknown as FeatureSpec;

    const result = dispatch(
      { action: "clarify", unitId, input: makeFeatureClarifyInput({ spec: badSpec }) },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error).toMatch(/functionalRequirements/);
    expect(result.error).toMatch(/ac/);
  });

  it("畸形 spec 被 clarify 拦截后 status 不流转（仍 created）", () => {
    const unitId = "feature:clarify-bad-status";
    dispatch(
      { action: "create", input: { slug: "clarify-bad-status", objective: "o", layer: "feature" } },
      env.deps,
    );
    const badSpec = {
      ...makeFeatureSpec(),
      functionalRequirements: [
        { id: "FR1", status: "active", title: "t", detail: "d" /* 缺 ac */ },
      ],
    } as unknown as FeatureSpec;

    dispatch(
      { action: "clarify", unitId, input: makeFeatureClarifyInput({ spec: badSpec }) },
      env.deps,
    );

    const record = env.deps.store.load(unitId) as unknown as { status: string };
    // clarify fail 时不流转——status 仍是 create 时的 created
    expect(record.status).toBe("created");
  });

  it("AC 缺 condition → clarify ok=false，error 含 condition", () => {
    const unitId = "feature:clarify-bad-ac";
    dispatch(
      { action: "create", input: { slug: "clarify-bad-ac", objective: "o", layer: "feature" } },
      env.deps,
    );
    const badSpec = {
      ...makeFeatureSpec(),
      acceptanceCriteria: [{ id: "AC1", status: "active" /* 缺 condition */ }],
    } as unknown as FeatureSpec;

    const result = dispatch(
      { action: "clarify", unitId, input: makeFeatureClarifyInput({ spec: badSpec }) },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/condition/);
  });

  it("合法 spec 含额外字段（priority/statement）→ clarify ok=true 通过", () => {
    const unitId = "feature:clarify-extra";
    dispatch(
      { action: "create", input: { slug: "clarify-extra", objective: "o", layer: "feature" } },
      env.deps,
    );
    // 合法 FR（ac 填了）+ agent 附加的 priority/statement，应通过校验
    const specWithExtra: FeatureSpec = {
      ...makeFeatureSpec(),
      functionalRequirements: [
        {
          id: "FR1",
          status: "active",
          title: "功能需求",
          detail: "详情",
          ac: ["AC1"],
        },
      ],
    };
    // 附加字段通过对象扩展注入（运行时存在，TS 类型不包含）
    (specWithExtra.functionalRequirements[0] as unknown as Record<string, unknown>).priority = "high";
    (specWithExtra.functionalRequirements[0] as unknown as Record<string, unknown>).statement = "附加说明";

    const result = dispatch(
      { action: "clarify", unitId, input: makeFeatureClarifyInput({ spec: specWithExtra }) },
      env.deps,
    );

    expect(result.ok).toBe(true);
  });

  it("畸形 spec 被拦后再提交合法 spec → ok=true 流转正常（progressive 修正）", () => {
    const unitId = "feature:clarify-retry";
    dispatch(
      { action: "create", input: { slug: "clarify-retry", objective: "o", layer: "feature" } },
      env.deps,
    );
    const badSpec = {
      ...makeFeatureSpec(),
      functionalRequirements: [
        { id: "FR1", status: "active", title: "t", detail: "d" /* 缺 ac */ },
      ],
    } as unknown as FeatureSpec;
    // 第一次：畸形 → fail
    const failResult = dispatch(
      { action: "clarify", unitId, input: makeFeatureClarifyInput({ spec: badSpec }) },
      env.deps,
    );
    expect(failResult.ok).toBe(false);

    // 第二次：合法 → ok
    const okResult = dispatch(
      { action: "clarify", unitId, input: makeFeatureClarifyInput() },
      env.deps,
    );
    expect(okResult.ok).toBe(true);
  });
});

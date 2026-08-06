/**
 * v1 feature design 结构校验 e2e 测试。
 *
 * 测畸形 spec（FR 缺 ac 数组）在 design 阶段被 validateFeatureSpec 软校验拦截
 * （E1 合并 clarify→design 后，spec 校验随 design action 走）：
 * - 返回 ok=false（而非崩溃或静默通过）
 * - error 含具体字段路径（functionalRequirements / ac）
 * - status 不流转（仍 created），failureCount 派生（可重试）
 * - 合法 spec → 覆盖写 + status 流转到 designing
 *
 * 真实 dispatch 路径（create → design），零 mock。
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
  makeFeatureDesignInput,
  makeFeatureSpec,
} from "./helpers/feature-env.js";

let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
});

describe("feature design 结构校验（畸形 spec 被拦）", () => {
  it("FR 缺 ac 字段（真实事故场景）→ design ok=false，error 含 functionalRequirements/ac + failureCount", () => {
    const unitId = "feature:design-bad-fr";
    dispatch(
      { action: "create", input: { slug: "design-bad-fr", objective: "o", layer: "feature" } },
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
      { action: "design", unitId, input: makeFeatureDesignInput({ spec: badSpec }) },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error).toMatch(/functionalRequirements/);
    expect(result.error).toMatch(/ac/);
    // 软校验失败走 failureCount 派生（与 design-review gate fail 同机制，agent 可重试）
    expect(result.failureCount).toBe(1);
  });

  it("畸形 spec 被 design 拦截后 status 不流转（仍 created）", () => {
    const unitId = "feature:design-bad-status";
    dispatch(
      { action: "create", input: { slug: "design-bad-status", objective: "o", layer: "feature" } },
      env.deps,
    );
    const badSpec = {
      ...makeFeatureSpec(),
      functionalRequirements: [
        { id: "FR1", status: "active", title: "t", detail: "d" /* 缺 ac */ },
      ],
    } as unknown as FeatureSpec;

    dispatch(
      { action: "design", unitId, input: makeFeatureDesignInput({ spec: badSpec }) },
      env.deps,
    );

    const record = env.deps.store.load(unitId) as unknown as { status: string };
    // design fail 时不流转——status 仍是 create 时的 created
    expect(record.status).toBe("created");
  });

  it("AC 缺 condition → design ok=false，error 含 condition", () => {
    const unitId = "feature:design-bad-ac";
    dispatch(
      { action: "create", input: { slug: "design-bad-ac", objective: "o", layer: "feature" } },
      env.deps,
    );
    const badSpec = {
      ...makeFeatureSpec(),
      acceptanceCriteria: [{ id: "AC1", status: "active" /* 缺 condition */ }],
    } as unknown as FeatureSpec;

    const result = dispatch(
      { action: "design", unitId, input: makeFeatureDesignInput({ spec: badSpec }) },
      env.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/condition/);
  });

  it("合法 spec 含额外字段（priority/statement）→ design ok=true，spec 覆盖写 + status 流转到 designing", () => {
    const unitId = "feature:design-extra";
    dispatch(
      { action: "create", input: { slug: "design-extra", objective: "o", layer: "feature" } },
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
      { action: "design", unitId, input: makeFeatureDesignInput({ spec: specWithExtra }) },
      env.deps,
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("designing");
    // spec 覆盖写入 unit.clarifications.spec
    const record = env.deps.store.load(unitId) as unknown as {
      clarifications: { spec: { functionalRequirements: Array<{ id: string }> } };
    };
    expect(record.clarifications.spec.functionalRequirements).toHaveLength(1);
    expect(record.clarifications.spec.functionalRequirements[0].id).toBe("FR1");
  });

  it("合法 spec 再次提交 → 整体覆盖写（非 append），clarifications append-only", () => {
    const unitId = "feature:design-overwrite";
    dispatch(
      { action: "create", input: { slug: "design-overwrite", objective: "o", layer: "feature" } },
      env.deps,
    );
    const specV1 = makeFeatureSpec();
    const specV2 = makeFeatureSpec({
      functionalRequirements: [{ id: "FR2", status: "active", title: "t2", detail: "d2", ac: ["AC1"] }],
    });

    const first = dispatch(
      { action: "design", unitId, input: makeFeatureDesignInput({ spec: specV1 }) },
      env.deps,
    );
    expect(first.ok).toBe(true);

    // 第二次 design：spec 整体覆盖（V2 只有 FR2，V1 的 FR1 不应残留），clarifications 追加
    const second = dispatch(
      { action: "design", unitId, input: makeFeatureDesignInput({ spec: specV2 }) },
      env.deps,
    );
    expect(second.ok).toBe(true);

    const record = env.deps.store.load(unitId) as unknown as {
      clarifications: {
        spec: { functionalRequirements: Array<{ id: string }> };
        clarifications: unknown[];
      };
    };
    expect(record.clarifications.spec.functionalRequirements).toHaveLength(1);
    expect(record.clarifications.spec.functionalRequirements[0].id).toBe("FR2");
    // clarifications 是 append-only 累积（两次 design 各带 1 条）
    expect(record.clarifications.clarifications).toHaveLength(2);
  });

  it("畸形 spec 被拦后再提交合法 spec → ok=true 流转正常（progressive 修正）", () => {
    const unitId = "feature:design-retry";
    dispatch(
      { action: "create", input: { slug: "design-retry", objective: "o", layer: "feature" } },
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
      { action: "design", unitId, input: makeFeatureDesignInput({ spec: badSpec }) },
      env.deps,
    );
    expect(failResult.ok).toBe(false);

    // 第二次：合法 → ok
    const okResult = dispatch(
      { action: "design", unitId, input: makeFeatureDesignInput() },
      env.deps,
    );
    expect(okResult.ok).toBe(true);
    expect(okResult.status).toBe("designing");
  });
});

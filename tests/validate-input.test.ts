/**
 * v1 handler input shape 校验测试（#6，W2）。
 *
 * 覆盖：
 *   - T2.4：clarify `{}` → CwError「input.clarifications …」exit 1 语义（非 crash exit 2）
 *   - T2.4b：plan 带 abandonParentItems（buildParams 注入字段）→ 校验放行（F-4）
 *   - T2.5：clarify `{"clarifications":"hello"}` → 拒绝（不静默拆字）
 *   - T2.6：INPUT_SCHEMAS 映射表全覆盖断言（全部带 input 的 handler 入口）
 *           + 编译期双向 assignability 断言（SF-8）
 *
 * 零 mock：validateInput 纯函数直接单测；dispatch 集成走真实 CwStore + tmp 目录。
 */
import type { Static, TSchema } from "@sinclair/typebox";
import { afterEach,beforeEach, describe, expect, it } from "vitest";

import { CwError } from "../src/core/errors.js";
import type { PlanFeatureInput } from "../src/core/plan.js";
import { dispatch } from "../src/dispatch.js";
import type {
  AbortInput,
  ClarifyInput,
  CloseoutInput,
  DesignReviewInput,
  ExecReviewInput,
  ExecuteInput,
  PlanInput,
  PlanSliceInput,
  ReplanInput,
  RetrospectInput,
  RetrospectSliceInput,
  TestInput,
} from "../src/handlers/types.js";
import {
  AbortInputSchema,
  ClarifyInputSchema,
  CloseoutInputSchema,
  DesignReviewInputSchema,
  ExecReviewInputSchema,
  ExecuteInputSchema,
  INPUT_SCHEMAS,
  PlanFeatureInputSchema,
  PlanInputSchema,
  PlanSliceInputSchema,
  ReplanInputSchema,
  RetrospectInputSchema,
  RetrospectSliceInputSchema,
  TestInputSchema,
  validateInput,
} from "../src/handlers/validate-input.js";
import { createCwEnv, type CwEnv,makeValidTestCase } from "./helpers/env.js";

// ── T2.6 编译期双向 assignability 断言（SF-8）──
// schema 的 Static 类型 ↔ 对应 Input 类型必须双向可赋值（结构同构，防 schema 与类型漂移）。
// 导出 const 避免 noUnusedLocals 误报；断言失败时 `true` 不可赋给 `false` 报编译错误。
type IsAssignable<A, B> = [A] extends [B] ? true : false;
type AssertBidirectional<S extends TSchema, T> = IsAssignable<Static<S>, T> extends true
  ? IsAssignable<T, Static<S>> extends true
    ? true
    : false
  : false;

// wave 10 个 Input schema 全双向断言
 
export const sf8Clarify: AssertBidirectional<typeof ClarifyInputSchema, ClarifyInput> = true;
 
// testCommand 有意漂移：PlanInputSchema.Type.String() 必填（运行时强制新 plan 提交带 testCommand），
// PlanInput 类型 testCommand?: string 可选（兼容存量 WavePlan/PlanInput 字面量，加载为 undefined）。
// 双向断言不适用于「schema 严格 / type 宽松」的有意漂移——改单向：schema 实例 ⊆ type（仍防字段名拼错）。
export const sf8Plan: IsAssignable<Static<typeof PlanInputSchema>, PlanInput> = true;
 
export const sf8DesignReview: AssertBidirectional<typeof DesignReviewInputSchema, DesignReviewInput> = true;
 
export const sf8Execute: AssertBidirectional<typeof ExecuteInputSchema, ExecuteInput> = true;
 
export const sf8Test: AssertBidirectional<typeof TestInputSchema, TestInput> = true;
 
export const sf8ExecReview: AssertBidirectional<typeof ExecReviewInputSchema, ExecReviewInput> = true;
 
export const sf8Retrospect: AssertBidirectional<typeof RetrospectInputSchema, RetrospectInput> = true;
 
export const sf8Closeout: AssertBidirectional<typeof CloseoutInputSchema, CloseoutInput> = true;
 
export const sf8Replan: AssertBidirectional<typeof ReplanInputSchema, ReplanInput> = true;
 
export const sf8Abort: AssertBidirectional<typeof AbortInputSchema, AbortInput> = true;
// slice / feature plan（feature 与 epic 共用 PlanFeatureInput schema）
 
export const sf8PlanSlice: AssertBidirectional<typeof PlanSliceInputSchema, PlanSliceInput> = true;
 
export const sf8PlanFeature: AssertBidirectional<typeof PlanFeatureInputSchema, PlanFeatureInput> = true;
// RetrospectSliceInput / RetrospectFeatureInput / RetrospectEpicInput 共用 RetrospectSliceInputSchema
 
export const sf8RetrospectSlice: AssertBidirectional<typeof RetrospectSliceInputSchema, RetrospectSliceInput> = true;
// FeatureClarifyInput 例外：spec 字段只验容器形态（spec 内容由 validateFeatureSpec 软校验，
// 保证畸形 spec 走 ok=false 可重试路径而非硬 throw），故不做双向断言。

// ── validateInput 纯函数 ──

describe("validateInput（#6 input shape 校验）", () => {
  it("T2.4: wave clarify {} → CwError，消息以 input.clarifications 前缀开头", () => {
    let caught: unknown;
    try {
      validateInput("clarify", "wave", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CwError);
    const message = (caught as CwError).message;
    expect(message.startsWith("input.clarifications")).toBe(true);
  });

  it("T2.5: clarifications 为字符串 → 拒绝（不静默拆字）", () => {
    expect(() =>
      validateInput("clarify", "wave", { clarifications: "hello" }),
    ).toThrowError(CwError);
  });

  it("合法 clarify input（空数组）→ 放行", () => {
    expect(() => validateInput("clarify", "wave", { clarifications: [] })).not.toThrow();
  });

  it("T2.4b: plan 带 abandonParentItems（buildParams 注入字段）→ 放行（F-4）", () => {
    expect(() =>
      validateInput("plan", "wave", {
        testCases: [makeValidTestCase()],
        tasks: [],
        files: [],
        contracts: [],
        testCommand: "npx vitest run",
        abandonParentItems: ["TC1"],
      }),
    ).not.toThrow();
  });

  it("plan 缺 testCases → 拒绝（消息前缀 input.testCases）", () => {
    let caught: unknown;
    try {
      validateInput("plan", "wave", { tasks: [] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CwError);
    expect((caught as CwError).message.startsWith("input.testCases")).toBe(true);
  });

  it("plan 缺 testCommand → 拒绝（消息前缀 input.testCommand）", () => {
    let caught: unknown;
    try {
      validateInput("plan", "wave", {
        testCases: [makeValidTestCase()],
        tasks: [],
        files: [],
        contracts: [],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CwError);
    expect((caught as CwError).message.startsWith("input.testCommand")).toBe(true);
  });

  it("plan 带 testCommand → 放行", () => {
    expect(() =>
      validateInput("plan", "wave", {
        testCases: [makeValidTestCase()],
        tasks: [],
        files: [],
        contracts: [],
        testCommand: "npx vitest run src/a.test.ts",
      }),
    ).not.toThrow();
  });

  it("execute 缺 commitHash → 拒绝", () => {
    expect(() => validateInput("execute", "wave", {})).toThrowError(CwError);
    expect(() => validateInput("execute", "wave", { commitHash: "abc" })).not.toThrow();
  });

  it("abort 空对象 {} → 放行（reason 可选）", () => {
    expect(() => validateInput("abort", "wave", {})).not.toThrow();
  });

  it("feature clarify 容器形态：spec 必须是对象，但内容不深校验（validateFeatureSpec 软校验）", () => {
    expect(() =>
      validateInput("clarify", "feature", { clarifications: [], spec: {} }),
    ).not.toThrow();
    // 畸形 spec 内容（FR 缺 ac）不在此层拒绝——由 handler 的 validateFeatureSpec 软校验返回 ok=false
    expect(() =>
      validateInput("clarify", "feature", {
        clarifications: [],
        spec: { functionalRequirements: [{ id: "FR1" }] },
      }),
    ).not.toThrow();
    // 非对象 spec → 拒绝
    expect(() =>
      validateInput("clarify", "feature", { clarifications: [], spec: "nope" }),
    ).toThrowError(CwError);
  });

  it("未登记 (layer, action) → CwError（开发期映射表缺口大声暴露）", () => {
    // slice execute 无 input（handler 不调 validateInput），表里不应有 entry——直接调是调用方 bug
    expect(() => validateInput("execute", "slice", {})).toThrowError(CwError);
  });
});

// ── dispatch 集成（真实 CwStore + tmp 目录）──

describe("dispatch 层 input 校验集成（T2.4/T2.4b/T2.5）", () => {
  let env: CwEnv;

  beforeEach(() => {
    env = createCwEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  function createWaveUnit(): string {
    const created = dispatch(
      {
        action: "create",
        input: { slug: "shape-test", objective: "shape test", layer: "wave" },
      },
      env.deps,
    );
    return created.unitId;
  }

  it("T2.4: clarify {} → CwError input.clarifications（非 crash）", () => {
    const unitId = createWaveUnit();
    let caught: unknown;
    try {
       
      dispatch({ action: "clarify", unitId, input: {} as unknown as ClarifyInput }, env.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CwError);
    expect((caught as CwError).message.startsWith("input.clarifications")).toBe(true);
  });

  it("T2.5: clarify {\"clarifications\":\"hello\"} → 拒绝（不静默拆字）", () => {
    const unitId = createWaveUnit();
    expect(() =>
       
      dispatch(
        { action: "clarify", unitId, input: { clarifications: "hello" } as unknown as ClarifyInput },
        env.deps,
      ),
    ).toThrowError(CwError);
  });

  it("T2.4b: plan 带 abandonParentItems → 校验放行，ok=true", () => {
    const unitId = createWaveUnit();
    dispatch({ action: "clarify", unitId, input: { clarifications: [] } }, env.deps);
    const result = dispatch(
      {
        action: "plan",
        unitId,
        input: {
          testCases: [makeValidTestCase()],
          tasks: [],
          files: [],
          contracts: [],
          testCommand: "npx vitest run",
          abandonParentItems: ["TC1"],
        },
      },
      env.deps,
    );
    expect(result.ok).toBe(true);
  });
});

// ── T2.6 INPUT_SCHEMAS 映射表全覆盖断言 ──

describe("INPUT_SCHEMAS 映射表全覆盖（T2.6）", () => {
  it("全部带 input 的 handler 入口都有 schema，且无多余 entry", () => {
    // 31 个带 input 的 handler 入口（wave 10 + slice/feature/epic 各 7；
    // planning 层 execute 无 input 参数不校验；create 无 input 不校验）
    const expected: Record<string, string[]> = {
      wave: [
        "clarify", "plan", "design-review", "execute", "test",
        "exec-review", "retrospect", "closeout", "replan", "abort",
      ],
      slice: ["clarify", "plan", "design-review", "retrospect", "closeout", "replan", "abort"],
      feature: ["clarify", "plan", "design-review", "retrospect", "closeout", "replan", "abort"],
      epic: ["clarify", "plan", "design-review", "retrospect", "closeout", "replan", "abort"],
    };
    for (const [layer, actions] of Object.entries(expected)) {
      const table = INPUT_SCHEMAS[layer as keyof typeof INPUT_SCHEMAS];
      expect([...Object.keys(table)].sort(), `${layer} 入口集合`).toEqual([...actions].sort());
      for (const action of actions) {
        expect(table[action], `${layer}/${action} schema 已登记`).toBeDefined();
      }
    }
  });

  it("schema 复用：feature/epic 共用 PlanFeatureInput schema、三层 planning 共用 RetrospectSliceInput schema", () => {
    expect(INPUT_SCHEMAS.feature.plan).toBe(INPUT_SCHEMAS.epic.plan);
    expect(INPUT_SCHEMAS.feature.retrospect).toBe(INPUT_SCHEMAS.slice.retrospect);
    expect(INPUT_SCHEMAS.epic.retrospect).toBe(INPUT_SCHEMAS.slice.retrospect);
    // 各层 plan schema 互不相同（wave/slice/feature 产物形态不同）
    expect(INPUT_SCHEMAS.wave.plan).not.toBe(INPUT_SCHEMAS.slice.plan);
    expect(INPUT_SCHEMAS.slice.plan).not.toBe(INPUT_SCHEMAS.feature.plan);
  });
});

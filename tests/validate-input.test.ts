/**
 * v1 handler input shape 校验测试（#6，W2）。
 *
 * 覆盖：
 *   - T2.4：design `{}` → CwError「input.testCases …」exit 1 语义（非 crash exit 2）
 *   - T2.4b：design 带 abandonParentItems（buildParams 注入字段）→ 校验放行（F-4）
 *   - T2.5：design `{"clarifications":"hello"}` → 拒绝（不静默拆字）
 *   - T2.6：INPUT_SCHEMAS 映射表全覆盖断言（全部带 input 的 handler 入口）
 *           + 编译期双向 assignability 断言（SF-8）
 *
 * 零 mock：validateInput 纯函数直接单测；dispatch 集成走真实 CwStore + tmp 目录。
 */
import type { Static, TSchema } from "@sinclair/typebox";
import { afterEach,beforeEach, describe, expect, it } from "vitest";

import { CwError } from "../src/core/errors.js";
import type { DesignFeatureInput } from "../src/core/plan.js";
import { dispatch } from "../src/dispatch.js";
import type {
  AbortInput,
  CloseoutInput,
  DesignInput,
  DesignReviewInput,
  DesignSliceInput,
  ExecReviewInput,
  ExecuteInput,
  ReplanInput,
  RetrospectInput,
  RetrospectSliceInput,
  TestInput,
} from "../src/handlers/types.js";
import {
  AbortInputSchema,
  CloseoutInputSchema,
  DesignFeatureInputSchema,
  DesignInputSchema,
  DesignReviewInputSchema,
  DesignSliceInputSchema,
  ExecReviewInputSchema,
  ExecuteInputSchema,
  INPUT_SCHEMAS,
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

// wave 9 个 Input schema 全双向断言

// testCommand 有意漂移：DesignInputSchema.Type.String() 必填（运行时强制新 design 提交带 testCommand），
// DesignInput 类型 testCommand?: string 可选（兼容存量 WavePlan/DesignInput 字面量，加载为 undefined）。
// 双向断言不适用于「schema 严格 / type 宽松」的有意漂移——改单向：schema 实例 ⊆ type。
// 注意：单向断言不防字段名拼错（泛型可赋值性允许多余属性），拼错拦截靠下方 sf8DesignKeys key 方向断言——
// 须 tuple 包裹 [keyof X] extends [keyof Y] 强制即时求值（普通 IsAssignable 条件类型延迟求值会静默放行）。
export const sf8Design: IsAssignable<Static<typeof DesignInputSchema>, DesignInput> = true;
// key 方向断言：schema 字段名 ⊆ DesignInput 字段名（如把 testCommand 拼成 testCommandd 时编译报错）。
export const sf8DesignKeys: [keyof Static<typeof DesignInputSchema>] extends [keyof DesignInput] ? true : false = true;

export const sf8DesignReview: AssertBidirectional<typeof DesignReviewInputSchema, DesignReviewInput> = true;

export const sf8Execute: AssertBidirectional<typeof ExecuteInputSchema, ExecuteInput> = true;

export const sf8Test: AssertBidirectional<typeof TestInputSchema, TestInput> = true;

export const sf8ExecReview: AssertBidirectional<typeof ExecReviewInputSchema, ExecReviewInput> = true;

export const sf8Retrospect: AssertBidirectional<typeof RetrospectInputSchema, RetrospectInput> = true;

export const sf8Closeout: AssertBidirectional<typeof CloseoutInputSchema, CloseoutInput> = true;

export const sf8Replan: AssertBidirectional<typeof ReplanInputSchema, ReplanInput> = true;

export const sf8Abort: AssertBidirectional<typeof AbortInputSchema, AbortInput> = true;
// slice / feature design（feature 与 epic 共用 DesignFeatureInput schema）

export const sf8DesignSlice: AssertBidirectional<typeof DesignSliceInputSchema, DesignSliceInput> = true;

// DesignFeatureInput 例外（同旧 FeatureClarifyInput）：spec 字段有意漂移——schema 只验容器形态
// （Record<string, unknown>，内容由 validateFeatureSpec 软校验），DesignFeatureInput.spec 是
// FeatureSpec 具名 interface（无索引签名，双向都不与 Record<string, unknown> 可赋值）。
// 故整体双向断言不适用，改用 Omit<spec> 双向断言：除 spec 外其余字段（split/clarifications/abandonParentItems）
// 仍锁结构同构，防 schema 与类型漂移。直接展开 IsAssignable（Omit 产物不是 TSchema，不能用 AssertBidirectional）。
export const sf8DesignFeature: IsAssignable<
  Omit<Static<typeof DesignFeatureInputSchema>, "spec">,
  Omit<DesignFeatureInput, "spec">
> extends true
  ? IsAssignable<Omit<DesignFeatureInput, "spec">, Omit<Static<typeof DesignFeatureInputSchema>, "spec">> extends true
    ? true
    : false
  : false = true;
// RetrospectSliceInput / RetrospectFeatureInput / RetrospectEpicInput 共用 RetrospectSliceInputSchema

export const sf8RetrospectSlice: AssertBidirectional<typeof RetrospectSliceInputSchema, RetrospectSliceInput> = true;

// ── validateInput 纯函数 ──

describe("validateInput（#6 input shape 校验）", () => {
  it("T2.4: wave design {} → CwError，消息以 input.testCases 前缀开头", () => {
    let caught: unknown;
    try {
      validateInput("design", "wave", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CwError);
    const message = (caught as CwError).message;
    expect(message.startsWith("input.testCases")).toBe(true);
  });

  it("T2.5: clarifications 为字符串 → 拒绝（不静默拆字）", () => {
    expect(() =>
      validateInput("design", "wave", { clarifications: "hello" }),
    ).toThrowError(CwError);
  });

  it("合法 design input（全必填 + 空数组）→ 放行", () => {
    expect(() =>
      validateInput("design", "wave", {
        testCases: [],
        tasks: [],
        files: [],
        contracts: [],
        testCommand: "npx vitest run",
        clarifications: [],
      }),
    ).not.toThrow();
  });

  it("T2.4b: design 带 abandonParentItems（buildParams 注入字段）→ 放行（F-4）", () => {
    expect(() =>
      validateInput("design", "wave", {
        testCases: [makeValidTestCase()],
        tasks: [],
        files: [],
        contracts: [],
        testCommand: "npx vitest run",
        abandonParentItems: ["TC1"],
      }),
    ).not.toThrow();
  });

  it("design 缺 testCases → 拒绝（消息前缀 input.testCases）", () => {
    let caught: unknown;
    try {
      validateInput("design", "wave", { tasks: [] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CwError);
    expect((caught as CwError).message.startsWith("input.testCases")).toBe(true);
  });

  it("design 缺 testCommand → 拒绝（消息前缀 input.testCommand）", () => {
    let caught: unknown;
    try {
      validateInput("design", "wave", {
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

  it("design 带 testCommand → 放行", () => {
    expect(() =>
      validateInput("design", "wave", {
        testCases: [makeValidTestCase()],
        tasks: [],
        files: [],
        contracts: [],
        testCommand: "npx vitest run src/a.test.ts",
      }),
    ).not.toThrow();
  });

  it("replan 纯空白 testCommand → 拒绝（trim 判空对齐 gate，防覆盖清空在途 wave 合法值）", () => {
    // replan 旁路不改 status 不走 design-review，testCommandNonEmpty gate 不会复验——
    // schema 是唯一防线：minLength 只拦空串，纯空白串（长度 ≥ 1）必须靠 pattern 拒绝。
    const base = { abandonedIds: [], note: "x" };
    expect(() => validateInput("replan", "wave", { ...base, testCommand: "   " })).toThrowError(CwError);
    expect(() => validateInput("replan", "wave", { ...base, testCommand: "" })).toThrowError(CwError);
    expect(() => validateInput("replan", "wave", { ...base, testCommand: "\t\n" })).toThrowError(CwError);
    // 合法值放行；缺字段仍放行（testCommand 可选，纯 testCommandOnly replan 语义）
    expect(() => validateInput("replan", "wave", { ...base, testCommand: "npx vitest run" })).not.toThrow();
    expect(() => validateInput("replan", "wave", base)).not.toThrow();
  });

  it("execute 缺 commitHash → 拒绝", () => {
    expect(() => validateInput("execute", "wave", {})).toThrowError(CwError);
    expect(() => validateInput("execute", "wave", { commitHash: "abc" })).not.toThrow();
  });

  it("abort 空对象 {} → 放行（reason 可选）", () => {
    expect(() => validateInput("abort", "wave", {})).not.toThrow();
  });

  it("feature design 容器形态：spec 必须是对象，但内容不深校验（validateFeatureSpec 软校验）", () => {
    expect(() =>
      validateInput("design", "feature", { clarifications: [], spec: {}, split: [] }),
    ).not.toThrow();
    // 畸形 spec 内容（FR 缺 ac）不在此层拒绝——由 handler 的 validateFeatureSpec 软校验返回 ok=false
    expect(() =>
      validateInput("design", "feature", {
        clarifications: [],
        split: [],
        spec: { functionalRequirements: [{ id: "FR1" }] },
      }),
    ).not.toThrow();
    // 非对象 spec → 拒绝
    expect(() =>
      validateInput("design", "feature", { clarifications: [], spec: "nope", split: [] }),
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

  it("T2.4: design {} → CwError input.testCases（非 crash）", () => {
    const unitId = createWaveUnit();
    let caught: unknown;
    try {
      dispatch({ action: "design", unitId, input: {} as unknown as DesignInput }, env.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CwError);
    expect((caught as CwError).message.startsWith("input.testCases")).toBe(true);
  });

  it("T2.5: design {\"clarifications\":\"hello\"} → 拒绝（不静默拆字）", () => {
    const unitId = createWaveUnit();
    expect(() =>
      dispatch(
        { action: "design", unitId, input: { clarifications: "hello" } as unknown as DesignInput },
        env.deps,
      ),
    ).toThrowError(CwError);
  });

  it("T2.4b: design 带 abandonParentItems → 校验放行，ok=true", () => {
    const unitId = createWaveUnit();
    const result = dispatch(
      {
        action: "design",
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
    // 27 个带 input 的 handler 入口（wave 9 + slice/feature/epic 各 6；
    // planning 层 execute 无 input 参数不校验；create 无 input 不校验）
    const expected: Record<string, string[]> = {
      wave: [
        "design", "design-review", "execute", "test",
        "exec-review", "retrospect", "closeout", "replan", "abort",
      ],
      slice: ["design", "design-review", "retrospect", "closeout", "replan", "abort"],
      feature: ["design", "design-review", "retrospect", "closeout", "replan", "abort"],
      epic: ["design", "design-review", "retrospect", "closeout", "replan", "abort"],
    };
    for (const [layer, actions] of Object.entries(expected)) {
      const table = INPUT_SCHEMAS[layer as keyof typeof INPUT_SCHEMAS];
      expect([...Object.keys(table)].sort(), `${layer} 入口集合`).toEqual([...actions].sort());
      for (const action of actions) {
        expect(table[action], `${layer}/${action} schema 已登记`).toBeDefined();
      }
    }
  });

  it("schema 复用：feature/epic 共用 DesignFeatureInput schema、三层 planning 共用 RetrospectSliceInput schema", () => {
    expect(INPUT_SCHEMAS.feature.design).toBe(INPUT_SCHEMAS.epic.design);
    expect(INPUT_SCHEMAS.feature.retrospect).toBe(INPUT_SCHEMAS.slice.retrospect);
    expect(INPUT_SCHEMAS.epic.retrospect).toBe(INPUT_SCHEMAS.slice.retrospect);
    // 各层 design schema 互不相同（wave/slice/feature 产物形态不同）
    expect(INPUT_SCHEMAS.wave.design).not.toBe(INPUT_SCHEMAS.slice.design);
    expect(INPUT_SCHEMAS.slice.design).not.toBe(INPUT_SCHEMAS.feature.design);
  });
});

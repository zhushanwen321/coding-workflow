/**
 * TaskShape 类型层 + registry 单测 —— topic: 引入 TaskShape 统一配置轴。
 *
 * 覆盖 AC：
 *   - AC-1: Topic.taskShape 字段存在，类型 TaskShapeId | undefined
 *
 * 这是 TDD 红灯阶段：测试 import 的 `../src/shapes/*` 模块尚不存在，
 * 运行时必然 fail（模块解析失败）。实现由后续 subagent 完成。
 *
 * 测什么（纯类型层 + registry，无 IO、无 store）：
 *   - getShape(undefined) 返回默认 full-tdd shape
 *   - getShape("full-tdd") 返回 full-tdd shape，id 正确
 *   - full-tdd shape 含 verification 策略对象（TddVerificationStrategy）：
 *     id="tdd"，preDevCheck/postDevVerify/replanGuard/isDevVerified 均为函数
 *   - full-tdd shape 含 review 策略对象（FullReviewPolicy）：
 *     id="full-review"，stages 含三阶段，dimensions 含代码审查 6 维
 *
 * TaskShapeId 字面量联合包含 "full-tdd"（类型层断言，编译期约束）。
 */

import { describe, expect, it } from "vitest";

import { getShape } from "../src/legacy/shapes/registry.js";
import type {
  ReviewStagePolicy,
  TaskShape,
  TaskShapeId,
  VerificationStrategy,
} from "../src/legacy/shapes/types.js";

// ── AC-1: TaskShapeId 字面量联合含 "full-tdd"（编译期类型约束锚点） ──

// 这个赋值若 TaskShapeId 不含 "full-tdd" 会编译失败——锁住 id 值。
const _idCheck: TaskShapeId = "full-tdd";
void _idCheck;

describe("TaskShape 类型层 + registry（AC-1）", () => {
  it("getShape(undefined) 返回默认 full-tdd", () => {
    const shape = getShape(undefined);
    expect(shape.id).toBe("full-tdd");
  });

  it("getShape('full-tdd') 返回 full-tdd shape", () => {
    const shape = getShape("full-tdd");
    expect(shape.id).toBe("full-tdd");
  });

  it("getShape 返回值满足 TaskShape 接口（含 id/verification/review）", () => {
    const shape: TaskShape = getShape("full-tdd");
    expect(shape.id).toBe("full-tdd");
    expect(shape.verification).toBeDefined();
    expect(shape.review).toBeDefined();
  });

  it("full-tdd shape 含 verification 策略对象（TddVerificationStrategy）", () => {
    const shape = getShape("full-tdd");
    const verification = shape.verification as VerificationStrategy;
    expect(verification).toBeDefined();
    expect(verification.id).toBe("tdd");
    // 四个核心方法都是函数（策略路由 handler 会调用）
    expect(typeof verification.preDevCheck).toBe("function");
    expect(typeof verification.postDevVerify).toBe("function");
    expect(typeof verification.replanGuard).toBe("function");
    expect(typeof verification.isDevVerified).toBe("function");
  });

  it("full-tdd shape 含 review 策略对象（FullReviewPolicy）", () => {
    const shape = getShape("full-tdd");
    const review = shape.review as ReviewStagePolicy;
    expect(review).toBeDefined();
    expect(review.id).toBe("full-review");
    // 三阶段 review 全启用：spec_review + plan_review + review
    expect(review.stages).toEqual(["spec_review", "plan_review", "review"]);
    // dimensions 含代码审查的 6 个维度（type-safety / error-handling / edge-case /
    // test-coverage / plan-completeness / design-consistency）
    expect(review.dimensions).toContain("type-safety");
    expect(review.dimensions).toContain("test-coverage");
    expect(review.dimensions.length).toBeGreaterThanOrEqual(6);
  });
});

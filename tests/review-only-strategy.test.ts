/**
 * ReviewOnlyVerificationStrategy 单测 —— topic 2: postDevVerify 抽取 + existence/review-only 策略。
 *
 * 覆盖 AC：
 *   - AC-7: review-only 策略（doc-only shape）恒 pass / 恒 verified / postDevVerify 返回空
 *
 * 这是 TDD 红灯阶段：测试引用的 `getShape('doc-only')` / ReviewOnlyStrategy /
 * `applyPreDevResult` 都尚不存在，运行时必然 fail（红灯）。实现由后续 subagent 完成
 * （src/shapes/review-only-strategy.ts + registry 注册 + types 扩展）。
 *
 * 设计意图：doc-only 这类纯文档任务没有可机器验证的产物（无测试、无文件存在性约束），
 * 验证完全靠人工 review。所以 strategy 的所有验证方法都是 no-op / 恒 pass——
 * 流程上 dev → review → test → closeout 仍走，但 test gate 不做机器校验。
 *
 * 测试规范（AGENTS.md）：零 mock 框架，纯策略对象判定。
 */

import { describe, expect, it } from "vitest";

import { getShape } from "../src/shapes/registry.js";
import type { Topic } from "../src/types.js";

// 占位 topic——review-only 不读任何字段，空对象强转即可。
const emptyTopic = {} as Topic;

// ── AC-7: getShape('doc-only') 返回 review-only 策略 ─────────

describe("ReviewOnlyVerificationStrategy 注册（AC-7）", () => {
  it("getShape('doc-only') 返回 shape，id='doc-only'", () => {
    const shape = getShape("doc-only" as Topic["taskShape"]);
    expect(shape.id).toBe("doc-only");
  });

  it("doc-only shape 含 verification 策略（id='review-only'）", () => {
    const shape = getShape("doc-only" as Topic["taskShape"]);
    expect(shape.verification).toBeDefined();
    expect(shape.verification.id).toBe("review-only");
    // 五个核心方法都是函数（含新增的 applyPreDevResult）
    expect(typeof shape.verification.preDevCheck).toBe("function");
    expect(typeof shape.verification.postDevVerify).toBe("function");
    expect(typeof shape.verification.replanGuard).toBe("function");
    expect(typeof shape.verification.isDevVerified).toBe("function");
    expect(typeof shape.verification.applyPreDevResult).toBe("function");
  });

  it("doc-only shape 含 review 策略（id='doc-review'）", () => {
    const shape = getShape("doc-only" as Topic["taskShape"]);
    expect(shape.review).toBeDefined();
    expect(shape.review.id).toBe("doc-review");
  });

  it("doc-review stages 只含 review（不走 spec_review/plan_review）", () => {
    const shape = getShape("doc-only" as Topic["taskShape"]);
    // doc-only 是纯文档任务，spec/plan review 阶段不适用
    expect(shape.review.stages).toEqual(["review"]);
  });
});

// ── preDevCheck：恒 pass（无 payload 要求）─────────────────────

describe("ReviewOnlyStrategy.preDevCheck（恒 pass）", () => {
  it("空 payload → pass（doc-only 不要求 existence.json / test.json）", () => {
    const shape = getShape("doc-only" as Topic["taskShape"]);
    const result = shape.verification.preDevCheck(emptyTopic, {});
    expect(result.result).toBe("pass");
  });

  it("undefined payload → pass", () => {
    const shape = getShape("doc-only" as Topic["taskShape"]);
    const result = shape.verification.preDevCheck(emptyTopic, undefined);
    expect(result.result).toBe("pass");
  });

  it("任意 payload → pass（不校验内容）", () => {
    const shape = getShape("doc-only" as Topic["taskShape"]);
    const result = shape.verification.preDevCheck(emptyTopic, {
      whatever: "doc-only 不关心 payload 形状",
    });
    expect(result.result).toBe("pass");
  });
});

// ── postDevVerify：返回空数组（无可机器验证的产物）────────────

describe("ReviewOnlyStrategy.postDevVerify（返回空数组）", () => {
  it("postDevVerify 返回 []（无 VerifyResult）", () => {
    const shape = getShape("doc-only" as Topic["taskShape"]);
    const results = shape.verification.postDevVerify(emptyTopic);
    expect(results).toEqual([]);
  });

  it("postDevVerify 对任意 topic 都返回 []", () => {
    const shape = getShape("doc-only" as Topic["taskShape"]);
    // 即使 topic 带了 testCases（误用），review-only 也不做测试验证
    const topicWithCases = {
      testCases: [{ id: "T1", status: "pending" }],
    } as Topic;
    const results = shape.verification.postDevVerify(topicWithCases);
    expect(results).toEqual([]);
  });
});

// ── isDevVerified：恒 true（验证完全靠人工 review）────────────

describe("ReviewOnlyStrategy.isDevVerified（恒 true）", () => {
  it("空 topic → true", () => {
    const shape = getShape("doc-only" as Topic["taskShape"]);
    expect(shape.verification.isDevVerified(emptyTopic)).toBe(true);
  });

  it("有 testCases 的 topic → true（review-only 不看 testCases）", () => {
    const shape = getShape("doc-only" as Topic["taskShape"]);
    const topic = {
      testCases: [{ id: "T1", status: "failed" }],
    } as Topic;
    // 即使 testCase 全 failed，review-only 仍视为 verified——机器验证非其职责
    expect(shape.verification.isDevVerified(topic)).toBe(true);
  });
});

// ── applyPreDevResult：no-op（不抛错，不写 store）─────────────

describe("ReviewOnlyStrategy.applyPreDevResult（no-op）", () => {
  it("applyPreDevResult 不抛错（review-only 不需要预置任何状态）", () => {
    const shape = getShape("doc-only" as Topic["taskShape"]);
    const fakeStore = {
      // review-only 不应调任何 store 写方法；给一个会 fail 的 sentinel 确保不被调
      setExistenceArtifacts: () => {
        throw new Error("review-only 不应写 existenceArtifacts");
      },
      insertTestCases: () => {
        throw new Error("review-only 不应写 testCases");
      },
    };

    expect(() =>
      shape.verification.applyPreDevResult("cw-1", fakeStore as never, {}),
    ).not.toThrow();
  });

  it("applyPreDevResult 接受任意 parsed → no-op", () => {
    const shape = getShape("doc-only" as Topic["taskShape"]);
    const fakeStore = {}; // 无任何方法——review-only 不应触碰 store
    expect(() =>
      shape.verification.applyPreDevResult(
        "cw-1",
        fakeStore as never,
        { anything: "goes" },
      ),
    ).not.toThrow();
  });
});

// ── replanGuard：返回空（无可保护的已验证产物）────────────────

describe("ReviewOnlyStrategy.replanGuard（返回空）", () => {
  it("replanGuard 对任意 payload 返回 []", () => {
    const shape = getShape("doc-only" as Topic["taskShape"]);
    const violations = shape.verification.replanGuard(emptyTopic, {
      waves: [],
    });
    expect(violations).toEqual([]);
  });
});

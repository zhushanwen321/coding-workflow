/**
 * TddVerificationStrategy 与现有 tddPlanCheck 等价性单测 —— topic: 引入 TaskShape。
 *
 * 覆盖 AC：
 *   - AC-5: TddStrategy.preDevCheck 返回值与原 tddPlanCheck 一致（等价性）
 *
 * 这是 TDD 红灯阶段：测试 import 的 `../src/shapes/*` 模块尚不存在，
 * 运行时必然 fail（模块解析失败）。实现由后续 subagent 完成。
 *
 * 等价性验证策略：
 *   preDevCheck(topic, payload) 内部应调
 *     tddPlanCheck(payload, topic.specSections, topic.workspacePath)
 *   所以对同一 (payload, specSections, workspacePath)，两者的 result 字段一致。
 *
 *   断言维度：
 *     1. result.result（"pass" | "fail"）一致
 *     2. result.parsed 在 pass 时都 defined、fail 时都 undefined
 *     3. report 都非空且都含同一关键子串（如 "testCases"/"real"/"mock"）
 *
 *   不做字符串全等——report 文案允许微调，只锁语义（result + parsed 有无 + 关键词）。
 *
 * isDevVerified 等价性：基于 topic.testCases 的 status 聚合判定 dev 阶段是否验证通过。
 *   - 空 testCases → false（没测过 = 未验证）
 *   - 全 passed → true
 *   - 含 failed → false
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tddPlanCheck } from "../src/legacy/gate.js";
import type { Topic } from "../src/legacy/types.js";
import { getShape } from "../src/legacy/shapes/registry.js";
import { makeValidTestJson } from "./helpers/plan.js";

// ── 测试夹具 ────────────────────────────────────────────────

let tmpWorkspace: string;

beforeEach(() => {
  // 真实 tmp 目录作为 workspacePath（tddPlanCheck 的 script.path 沙箱校验需要真实路径）。
  tmpWorkspace = mkdtempSync(join(tmpdir(), "cw-shape-tdd-"));
});

afterEach(() => {
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

/**
 * 构造最小 topic（含 preDevCheck 需要的 specSections + workspacePath）。
 * 用 Partial<Topic> + 强转避免补全所有必填字段——这里只测 preDevCheck 用到的字段。
 */
function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    topicId: "cw-shape-test",
    slug: "shape-test",
    objective: "test TaskShape",
    workspacePath: tmpWorkspace,
    topicDir: join(tmpWorkspace, ".xyz-harness", "shape-test"),
    createdAt: "2026-07-17T00:00:00.000Z",
    status: "created",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
    clarifyRecords: [],
    specSections: [],
    specHistory: [],
    adrs: [],
    reviewIssues: [],
    reviewTurn: 0,
    specReviewIssues: [],
    specReviewTurn: 0,
    planReviewIssues: [],
    planReviewTurn: 0,
    testFixLog: [],
    testTurn: 0,
    assessments: [],
    ...overrides,
  } as Topic;
}

// ── AC-5: preDevCheck 与 tddPlanCheck 等价性 ────────────────

describe("TddVerificationStrategy.preDevCheck 与 tddPlanCheck 等价性（AC-5）", () => {
  it("合法 test.json：两者 result 一致（pass），parsed 均 defined", () => {
    const payload = makeValidTestJson();
    const topic = makeTopic();

    const shape = getShape("full-tdd");
    const fromStrategy = shape.verification.preDevCheck(topic, payload);
    const fromPure = tddPlanCheck(payload, topic.specSections, topic.workspacePath);

    expect(fromStrategy.result).toBe(fromPure.result);
    expect(fromStrategy.result).toBe("pass");
    expect(fromStrategy.parsed).toBeDefined();
    expect(fromPure.parsed).toBeDefined();
    // parsed.testCases 长度一致
    // fromStrategy.parsed 类型是 unknown（GateResult.parsed），断言成 ParsedTestJson 形态访问 testCases。
    const strategyParsed = fromStrategy.parsed as { testCases: unknown[] } | undefined;
    expect(strategyParsed!.testCases).toHaveLength(
      fromPure.parsed!.testCases.length,
    );
  });

  it("空 testCases：两者 result 一致（fail），parsed 均 undefined，report 含 'testCases'", () => {
    const payload = {
      testCases: [],
      testRunner: { mode: "nodejs" as const, command: "npx vitest run" },
    };
    const topic = makeTopic();

    const shape = getShape("full-tdd");
    const fromStrategy = shape.verification.preDevCheck(topic, payload);
    const fromPure = tddPlanCheck(payload, topic.specSections, topic.workspacePath);

    expect(fromStrategy.result).toBe(fromPure.result);
    expect(fromStrategy.result).toBe("fail");
    expect(fromStrategy.parsed).toBeUndefined();
    expect(fromPure.parsed).toBeUndefined();
    expect(fromStrategy.report).toContain("testCases");
  });

  it("缺 real 层：两者 result 一致（fail），report 均含 'real'", () => {
    const payload = {
      testCases: [
        {
          id: "E1",
          layer: "mock" as const,
          scenario: "s",
          steps: "st",
          expected: { type: "exact" as const, text: "具体输出值" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
      testRunner: { mode: "nodejs" as const, command: "npx vitest run" },
    };
    const topic = makeTopic();

    const shape = getShape("full-tdd");
    const fromStrategy = shape.verification.preDevCheck(topic, payload);
    const fromPure = tddPlanCheck(payload, topic.specSections, topic.workspacePath);

    expect(fromStrategy.result).toBe(fromPure.result);
    expect(fromStrategy.result).toBe("fail");
    expect(fromStrategy.report).toContain("real");
    expect(fromPure.report).toContain("real");
  });

  it("模糊 expected.text：两者 result 一致（fail），report 均含 testCase id", () => {
    const payload = {
      testCases: [
        {
          id: "E1",
          layer: "mock" as const,
          scenario: "s",
          steps: "st",
          expected: { type: "exact" as const, text: "passed" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real" as const,
          scenario: "s",
          steps: "st",
          expected: { type: "exact" as const, text: "具体值" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
      testRunner: { mode: "nodejs" as const, command: "npx vitest run" },
    };
    const topic = makeTopic();

    const shape = getShape("full-tdd");
    const fromStrategy = shape.verification.preDevCheck(topic, payload);
    const fromPure = tddPlanCheck(payload, topic.specSections, topic.workspacePath);

    expect(fromStrategy.result).toBe(fromPure.result);
    expect(fromStrategy.result).toBe("fail");
    expect(fromStrategy.report).toContain("E1");
    expect(fromPure.report).toContain("E1");
  });
});

// ── isDevVerified：基于 testCases.status 的聚合判定 ──────────

describe("TddVerificationStrategy.isDevVerified 基于 testCases.status 判定", () => {
  it("空 testCases → false（未验证）", () => {
    const shape = getShape("full-tdd");
    const topic = makeTopic({ testCases: [] });
    expect(shape.verification.isDevVerified(topic)).toBe(false);
  });

  it("全 passed testCases → true", () => {
    const shape = getShape("full-tdd");
    const topic = makeTopic({
      testCases: [
        { status: "passed" } as Topic["testCases"][number],
        { status: "passed" } as Topic["testCases"][number],
      ],
    });
    expect(shape.verification.isDevVerified(topic)).toBe(true);
  });

  it("含 failed 的 testCases → false", () => {
    const shape = getShape("full-tdd");
    const topic = makeTopic({
      testCases: [
        { status: "passed" } as Topic["testCases"][number],
        { status: "failed" } as Topic["testCases"][number],
      ],
    });
    expect(shape.verification.isDevVerified(topic)).toBe(false);
  });
});

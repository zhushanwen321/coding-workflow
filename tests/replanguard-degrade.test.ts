/**
 * replanguard-degrade 测试 — P0 红灯：replanGuard 对空 payload 降级 no-op。
 *
 * 当前实现（未修复）：existence.replanGuard 收到不含 artifacts 的 payload 时，
 * extractArtifacts 返回空 → verified artifact 全误判为 removed → 阻断。
 * P0 修复后：extractArtifacts 返回空时 replanGuard 返回空数组（no-op）。
 *
 * 此测试验证修复后的降级行为。
 */

import { describe, expect, it } from "vitest";

import { ExistenceVerificationStrategy } from "../src/legacy/shapes/existence-strategy.js";
import type { Topic } from "../src/legacy/types.js";

function makeTopicWithVerifiedArtifacts(): Topic {
  return {
    topicId: "cw-test",
    slug: "test",
    objective: "test",
    workspacePath: "/tmp",
    topicDir: "/tmp/.xyz-harness/test",
    createdAt: "2026-07-18T00:00:00.000Z",
    status: "post_dev_verified",
    taskShape: "delete-only",
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
    existenceArtifacts: [
      { path: "src/legacy.ts", expectedState: "absent", verified: true },
    ],
  };
}

describe("P0: replanGuard 对空 payload 降级 no-op", () => {
  const strategy = new ExistenceVerificationStrategy();

  it("payload 不含 artifacts（dev-plan.json 格式）→ 无违规（降级 no-op）", () => {
    const topic = makeTopicWithVerifiedArtifacts();
    // dev-plan.json 格式：{ format, objective, waves } —— 不含 artifacts
    const devPlanPayload = {
      format: "lite",
      objective: "replan",
      waves: [{ id: "W1", changes: [], dependsOn: [], priority: "P0" }],
    };
    const violations = strategy.replanGuard(topic, devPlanPayload);
    expect(violations).toEqual([]);
  });

  it("payload 为空对象 → 无违规（降级 no-op）", () => {
    const topic = makeTopicWithVerifiedArtifacts();
    const violations = strategy.replanGuard(topic, {});
    expect(violations).toEqual([]);
  });

  it("payload 为 null → 无违规（降级 no-op）", () => {
    const topic = makeTopicWithVerifiedArtifacts();
    const violations = strategy.replanGuard(topic, null);
    expect(violations).toEqual([]);
  });
});

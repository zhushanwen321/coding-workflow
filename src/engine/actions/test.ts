/**
 * test action — 渐进式提交测试结果双分支（UC-3/UC-4）。
 *
 * gate：lite=strong-recompute（judgeByExpected 丢 claimedStatus）；mid=medium-coverage（信声明 + GitValidator）。
 * 双分支按 topic.tier 分化（D-008）。
 *
 * 适配 dispatch 模式：topic 由 dispatch 预加载 + guard 已通过，handler 只做业务逻辑。
 */

import { existsSync } from "node:fs";

import { lookupGateTier } from "../gates.js";
import {
  buildNextAction,
  computeGatePassed,
  computeNextStatus,
} from "../state-machine.js";
import type { ActionDeps, ActionResult, Actual, CwTopic, TestCase } from "../types.js";
import { judgeByExpected } from "../types.js";

export interface TestCaseSubmission {
  caseId: string;
  /** lite：机器重算的真实观测值。 */
  actual?: Actual;
  /** lite：截图绝对路径（existsSync 校验）。 */
  screenshotPath?: string;
  /** mid：测试覆盖的 dev commit（GitValidator 校验真实性）。 */
  commitHash?: string;
  /** agent 声明（lite 丢弃，mid 采信）。 */
  claimedStatus?: "passed" | "failed";
}

export interface TestParams {
  action: "test";
  topicId: string;
  cases: TestCaseSubmission[];
}

export interface TestCaseResult {
  caseId: string;
  status: TestCase["status"];
  failureReason?: string;
}

export function handleTest(params: TestParams, topic: CwTopic, deps: ActionDeps): ActionResult {
  const gateTier = lookupGateTier(topic.tier, "test");
  const caseResults: TestCaseResult[] = [];

  deps.store.transaction(() => {
    for (const submission of params.cases) {
      const tc = topic.testCases.find((c) => c.id === submission.caseId);
      if (!tc) {
        throw new Error(`case not found: ${submission.caseId}`);
      }

      if (topic.tier === "lite") {
        // lite expected 为空时直接 failed（plan 阶段不应产出畸形数据）
        if (!tc.expected?.url && !tc.expected?.text) {
          const patch: Partial<TestCase> = {
            status: "failed",
            failureReason: "expected 为空（无 url/text），plan 阶段不应产空 expected",
          };
          deps.store.updateTestCase(params.topicId, submission.caseId, patch);
          caseResults.push({
            caseId: submission.caseId,
            status: "failed",
            failureReason: patch.failureReason,
          });
          continue;
        }
        const judged = judgeLite(tc, submission);
        deps.store.updateTestCase(params.topicId, submission.caseId, judged.patch);
        caseResults.push({
          caseId: submission.caseId,
          status: judged.patch.status ?? "failed",
          failureReason: judged.reason,
        });
      } else {
        const judged = judgeMid(submission, deps, topic);
        deps.store.updateTestCase(params.topicId, submission.caseId, judged.patch);
        caseResults.push({
          caseId: submission.caseId,
          status: judged.patch.status ?? "failed",
          failureReason: judged.reason,
        });
      }
    }

    // 事务内 reload 拿最新数据算 gatePassed + status
    const reloaded = deps.store.loadTopic(params.topicId)!;
    const gatePassed = computeGatePassed("test", reloaded);
    const nextStatus = computeNextStatus("test", reloaded.status);
    if (nextStatus !== reloaded.status) {
      deps.store.updateStatus(params.topicId, nextStatus);
    }
    deps.store.updateGatePassed(params.topicId, "test", gatePassed);

    const failedCount = caseResults.filter((c) => c.status !== "passed").length;
    deps.store.appendGateHistory(params.topicId, {
      phase: "test",
      action: "test",
      gate: topic.tier === "lite" ? "judgeByExpected" : "medium-coverage",
      tier: gateTier,
      result: failedCount === 0 ? "pass" : "fail",
      report: JSON.stringify(caseResults),
      progressive: true,
    });
  });

  const updated = deps.store.loadTopic(params.topicId)!;
  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    gateTier,
    nextAction: buildNextAction("test", updated),
    testProgress: updated.testCases.map((c) => ({ id: c.id, status: c.status })),
    caseResults,
  };
}

// ── lite 分支：strong-recompute（丢 claimedStatus，D-008） ────

function judgeLite(
  testCase: TestCase,
  submission: TestCaseSubmission,
): { patch: Partial<TestCase>; reason?: string } {
  if (testCase.requiresScreenshot) {
    if (!submission.screenshotPath || !existsSync(submission.screenshotPath)) {
      return {
        patch: { status: "failed", screenshotPath: submission.screenshotPath },
        reason: "screenshot required by plan but missing",
      };
    }
  }
  const verdict = judgeByExpected(testCase.expected ?? {}, submission.actual ?? {});
  return {
    patch: {
      status: verdict.status,
      actual: submission.actual,
      screenshotPath: submission.screenshotPath,
      judgedAt: new Date().toISOString(),
      ...(verdict.status === "failed" ? { failureReason: verdict.reason } : {}),
    },
    reason: verdict.status === "failed" ? verdict.reason : undefined,
  };
}

// ── mid 分支：medium-coverage（信声明 + GitValidator） ───────

function collectDevCommits(topic: CwTopic): string[] {
  return topic.waves.map((w) => w.committed).filter((c): c is string => c !== null);
}

function judgeMid(
  submission: TestCaseSubmission,
  deps: ActionDeps,
  topic: CwTopic,
): { patch: Partial<TestCase>; reason?: string } {
  if (!submission.commitHash) {
    return { patch: { status: "failed" }, reason: "mid test requires commitHash" };
  }
  const v = deps.git.validate(submission.commitHash);
  if (!v.valid) {
    return {
      patch: { status: "failed", commitHash: submission.commitHash },
      reason: `invalid commit: ${v.reason ?? "unknown"}`,
    };
  }
  const devCommits = collectDevCommits(topic);
  if (devCommits.length === 0) {
    return {
      patch: { status: "failed", commitHash: submission.commitHash },
      reason: "no dev commit in topic (dev wave 未 committed)",
    };
  }
  if (!deps.git.isAncestorOfAny(submission.commitHash, devCommits)) {
    return {
      patch: { status: "failed", commitHash: submission.commitHash },
      reason: `commitHash 不在已 committed 的 dev wave 后裔中`,
    };
  }
  return {
    patch: {
      status: submission.claimedStatus === "passed" ? "passed" : "failed",
      commitHash: submission.commitHash,
      judgedAt: new Date().toISOString(),
    },
  };
}

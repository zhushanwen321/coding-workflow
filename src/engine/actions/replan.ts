/**
 * replan action — append-only plan.json 同步（UC-6，时序图 §4.4）。
 *
 * 场景：plan gate pass 后 plan.json 与 _cw.json 成为两个独立真相源。dev 中发现需
 * 追加 wave/testCase，或 review 后合并 wave，plan.json 变了但 DB 没同步——
 * 导致 wave 残留 / testCase 缺失阻塞 gate。
 *
 * replan 对比新旧 plan，拒绝破坏性变更，只允许追加：
 *   - 已 committed 的 wave 不可删/改（保护 dev gate GitValidator 语义）
 *   - 已 passed 的 testCase 的语义字段不可改（保护 test gate judgeByExpected 基准）
 *   - 未 committed/passed 的可删可改（修复残留的机制）
 *
 * v1 仅 lite tier。mid 的 replan 走 abort 重建（模式 C，当前不支持）。
 *
 * 数据流（dispatch 已 loadTopic + guard，handleReplan 收到 pre-guarded topic）：
 *   tier 锁定 → parseLitePlan → validateAppendOnly（核心安全门）
 *   → 事务{ replaceUncommittedWaves/replaceUnpassedTestCases → status 回退 → gatePassed 重算 → gateHistory }
 *   → 构造含 replanSummary 的 nextAction。
 *
 * 关联：UC-6（AC-6.1~6.3）；issue #1（engine 搬迁）。
 */

import { lookupGateTier } from "../gates.js";
import type { ParsedLitePlan } from "../plan-parser.js";
import { parseLitePlan } from "../plan-parser.js";
import { computeGatePassed, computeNextStatus } from "../state-machine.js";
import type {
  ActionDeps,
  ActionResult,
  CwAction,
  CwTopic,
  TestCase,
  Wave,
} from "../types.js";

// ── 类型定义（replan 专属）──────────────────────────────────

export interface ReplanParams {
  action: "replan";
  topicId: string;
  /** 新版 plan.json（format 必须 === "lite"），整对象传入 */
  planJson: unknown;
}

type AppendOnlyViolation =
  | { type: "wave_deleted_committed"; waveId: string; reason: string }
  | { type: "wave_modified_committed"; waveId: string; reason: string }
  | { type: "case_deleted_passed"; caseId: string; reason: string }
  | { type: "case_modified_passed"; caseId: string; reason: string };

export interface ReplanSummary {
  addedWaves: string[];
  removedWaves: string[];
  addedCases: string[];
  removedCases: string[];
  statusChanged: string | null;
}

// ── append-only 校验（核心安全门）──────────────────────────

function validateAppendOnly(
  newWaves: ParsedLitePlan["waves"],
  newCases: ParsedLitePlan["testCases"],
  oldWaves: Wave[],
  oldTestCases: TestCase[],
): AppendOnlyViolation[] {
  const violations: AppendOnlyViolation[] = [];

  // Wave 校验：已 committed 的不可删/改，未 committed 的可删可改
  for (const old of oldWaves) {
    const match = newWaves.find((w) => w.id === old.id);
    if (!match) {
      if (old.committed !== null) {
        violations.push({
          type: "wave_deleted_committed",
          waveId: old.id,
          reason: `已 committed 的 wave ${old.id} 不能删除（commit ${old.committed}）`,
        });
      }
      // 未 committed 的 wave 被删 = 合法（修复残留）
    } else if (old.committed !== null) {
      // 已 committed 的 wave 全字段不可改
      const differ: string[] = [];
      if (JSON.stringify(match.changes) !== JSON.stringify(old.changes)) differ.push("changes");
      if (JSON.stringify(match.dependsOn) !== JSON.stringify(old.dependsOn)) differ.push("dependsOn");
      const oldPg = old.parallelGroup ?? null;
      const newPg = match.parallelGroup ?? null;
      if (newPg !== oldPg) differ.push("parallelGroup");
      if (JSON.stringify(match.issues ?? []) !== JSON.stringify(old.issues)) differ.push("issues");
      if (differ.length > 0) {
        violations.push({
          type: "wave_modified_committed",
          waveId: old.id,
          reason: `已 committed 的 wave ${old.id} 的 ${differ.join("/")} 不能修改`,
        });
      }
    }
  }

  // TestCase 校验：已 passed 的不可删/改，未 passed 的可删可改
  for (const old of oldTestCases) {
    const match = newCases.find((c) => c.id === old.id);
    if (!match) {
      if (old.status === "passed") {
        violations.push({
          type: "case_deleted_passed",
          caseId: old.id,
          reason: `已 passed 的 testCase ${old.id} 不能删除`,
        });
      }
    } else if (old.status === "passed") {
      const differ: string[] = [];
      if (JSON.stringify(match.expected ?? {}) !== JSON.stringify(old.expected ?? {})) differ.push("expected");
      if ((match.layer as string) !== (old.layer as string)) differ.push("layer");
      if (match.scenario !== old.scenario) differ.push("scenario");
      if (match.steps !== old.steps) differ.push("steps");
      if (match.executor !== old.executor) differ.push("executor");
      const oldRs = old.requiresScreenshot ?? false;
      const newRs = match.requiresScreenshot ?? false;
      if (newRs !== oldRs) differ.push("requiresScreenshot");
      if ((match.assertion ?? null) !== (old.assertion ?? null)) differ.push("assertion");
      if (JSON.stringify(match.dependsOn ?? []) !== JSON.stringify(old.dependsOn ?? [])) differ.push("dependsOn");
      const oldPg = old.parallelGroup ?? null;
      const newPg = match.parallelGroup ?? null;
      if (newPg !== oldPg) differ.push("parallelGroup");
      if (differ.length > 0) {
        violations.push({
          type: "case_modified_passed",
          caseId: old.id,
          reason: `已 passed 的 testCase ${old.id} 的 ${differ.join("/")} 不能修改`,
        });
      }
    }
  }

  return violations;
}

function buildReplanSummary(
  newWaves: ParsedLitePlan["waves"],
  newCases: ParsedLitePlan["testCases"],
  oldWaves: Wave[],
  oldTestCases: TestCase[],
  statusChanged: string | null,
): ReplanSummary {
  const oldWaveIds = new Set(oldWaves.map((w) => w.id));
  const newWaveIds = new Set(newWaves.map((w) => w.id));
  const oldCaseIds = new Set(oldTestCases.map((c) => c.id));
  const newCaseIds = new Set(newCases.map((c) => c.id));
  return {
    addedWaves: newWaves.filter((w) => !oldWaveIds.has(w.id)).map((w) => w.id),
    removedWaves: oldWaves.filter((w) => !newWaveIds.has(w.id)).map((w) => w.id),
    addedCases: newCases.filter((c) => !oldCaseIds.has(c.id)).map((c) => c.id),
    removedCases: oldTestCases.filter((c) => !newCaseIds.has(c.id)).map((c) => c.id),
    statusChanged,
  };
}

// ── handler ─────────────────────────────────────────────────

/**
 * handleReplan — append-only plan.json 同步。
 *
 * @param params  含 topicId + planJson（新版 plan.json）
 * @param topic   dispatch 已 loadTopic + guard 过的 topic（status ∈ {planned, developed}, tier=lite）
 * @param deps    ActionDeps（store/git/runner/workspacePath）
 *
 * 失败路径：
 *   - tier≠lite → throw（v1 仅 lite）
 *   - parseLitePlan throw（D-003 tier 锁定 / schema 不匹配）→ propagate（exit ≥1）
 *   - append-only 违规 → throw（exit ≥1，AC-6.2）
 */
export function handleReplan(
  params: ReplanParams,
  topic: CwTopic,
  deps: ActionDeps,
): ActionResult {
  // v1 仅 lite（mid replan 走 abort 重建，当前不支持）
  if (topic.tier !== "lite") {
    throw new Error("replan v1 only supports lite tier; mid replan not implemented");
  }

  // 解析新 plan.json（复用 plan-parser，D-003 tier 锁定 + schema 校验）
  const parsed = parseLitePlan(params.planJson, topic.tier);

  // append-only 校验（核心安全门，AC-6.2）
  const violations = validateAppendOnly(
    parsed.waves,
    parsed.testCases,
    topic.waves,
    topic.testCases,
  );
  if (violations.length > 0) {
    const mustFix = violations.map((v) => `[${v.type}] ${v.reason}`).join("\n");
    throw new Error(
      `replan append-only 校验失败：已 committed/passed 的不可删改。\nmustFix:\n${mustFix}\n— 若需破坏性变更，用 abort 重建（模式 C，当前版本不支持）`,
    );
  }

  const gateTier = lookupGateTier(topic.tier, "plan");
  const statusBefore = topic.status;

  // 事务内 append-only 写入
  deps.store.transaction(() => {
    // 只 replace 未 committed/passed 的（append-only：已 committed/passed 保留）
    const committedWaveIds = new Set(
      topic.waves.filter((w) => w.committed !== null).map((w) => w.id),
    );
    const uncommittedNew = parsed.waves.filter((w) => !committedWaveIds.has(w.id));
    deps.store.replaceUncommittedWaves(params.topicId, uncommittedNew);

    const passedCaseIds = new Set(
      topic.testCases.filter((c) => c.status === "passed").map((c) => c.id),
    );
    const unpassedNew = parsed.testCases.filter((c) => !passedCaseIds.has(c.id));
    deps.store.replaceUnpassedTestCases(params.topicId, unpassedNew);

    // 重新 load 拿最新数据（replace 已改表）
    const reloaded = deps.store.loadTopic(params.topicId)!;

    // status：developed → planned（回退，让 dev gate progressive 重新评估）
    const nextStatus = computeNextStatus("replan", reloaded.status);
    if (nextStatus !== reloaded.status) {
      deps.store.updateStatus(params.topicId, nextStatus);
    }

    // gatePassed 重算：replan 可能影响 dev gate（新增未 committed wave）和 test gate
    // （新增 pending case）。必须在事务内同步，否则下次 dev/test 触发 cache_inconsistent。
    const devGatePassed = computeGatePassed("dev", reloaded);
    deps.store.updateGatePassed(params.topicId, "dev", devGatePassed);
    const testGatePassed = computeGatePassed("test", reloaded);
    deps.store.updateGatePassed(params.topicId, "test", testGatePassed);

    deps.store.appendGateHistory(params.topicId, {
      phase: "plan",
      action: "replan",
      gate: "append-only-validator",
      tier: gateTier,
      result: "pass",
      report: JSON.stringify({
        addedWaves: parsed.waves
          .filter((w) => !topic.waves.some((o) => o.id === w.id))
          .map((w) => w.id),
        removedWaves: topic.waves
          .filter((w) => !parsed.waves.some((o) => o.id === w.id))
          .map((w) => w.id),
        addedCases: parsed.testCases
          .filter((c) => !topic.testCases.some((o) => o.id === c.id))
          .map((c) => c.id),
        statusChanged: nextStatus !== statusBefore ? `${statusBefore}→${nextStatus}` : null,
      }),
      progressive: true,
    });
  });

  // 构造返回（自构造 nextAction 含 replanSummary，不调 buildNextAction 兜底）
  const finalTopic = deps.store.loadTopic(params.topicId)!;
  const statusChanged =
    finalTopic.status !== statusBefore ? `${statusBefore}→${finalTopic.status}` : null;
  const summary = buildReplanSummary(
    parsed.waves,
    parsed.testCases,
    topic.waves,
    topic.testCases,
    statusChanged,
  );

  const parts: string[] = [];
  if (summary.addedWaves.length) parts.push(`追加 Wave [${summary.addedWaves.join(",")}]`);
  if (summary.removedWaves.length) parts.push(`清理残留 Wave [${summary.removedWaves.join(",")}]`);
  if (summary.addedCases.length) parts.push(`追加 testCase [${summary.addedCases.join(",")}]`);
  if (summary.removedCases.length) parts.push(`删除 testCase [${summary.removedCases.join(",")}]`);
  if (summary.statusChanged) parts.push(`status ${summary.statusChanged}`);
  const changeDesc = parts.length > 0 ? parts.join("；") : "无实质变更（append-only 幂等）";

  // nextAction 分流：按 dev/test gatePassed 决定下一步
  const devGate = computeGatePassed("dev", finalTopic);
  let nextActionName: CwAction;
  let nextGuidance: string;
  if (!devGate) {
    nextActionName = "dev";
    nextGuidance = `replan 成功（${changeDesc}）。dev gate 未通过（有未 committed wave），下一步调 cw(dev) 提交新 wave commit。`;
  } else {
    const testGate = computeGatePassed("test", finalTopic);
    if (!testGate) {
      nextActionName = "test";
      nextGuidance = `replan 成功（${changeDesc}）。dev gate 通过，下一步调 cw(test) 跑测试。`;
    } else {
      nextActionName = "retrospect";
      nextGuidance = `replan 成功（${changeDesc}）。dev/test gate 均通过，下一步调 cw(retrospect)。`;
    }
  }

  return {
    topicId: params.topicId,
    status: finalTopic.status,
    gatePassed: finalTopic.gatePassed,
    gateTier,
    nextAction: {
      action: nextActionName,
      guidance: nextGuidance,
      waves: finalTopic.waves.map((w) => ({ id: w.id, committed: w.committed !== null })),
      testCases: finalTopic.testCases.map((c) => ({ id: c.id, status: c.status })),
    },
    replanSummary: summary,
  };
}

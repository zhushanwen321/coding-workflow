/**
 * plan action — lite single-shot gate（UC-2 lite）。时序图 §4.2 功能 A 代表。
 *
 * 关联：UC-2（AC-2.1~2.4）；issues #2（stdin/文件读取）/#4（大 JSON 传递）/#7（exit code 分层）。
 *
 * 数据流（dispatch 已 loadTopic + guard，handlePlan 收到 pre-guarded topic）：
 *   parseLitePlan（含 D-003 tier 锁定）→ store.transaction{ runGate → 写入/流转 } → buildNextAction。
 *
 * gate fail 语义（#7 方案A）：status 不变，gateHistory 追加 fail，gatePassed.plan 不设，
 * nextAction 指回 plan retry（防 agent 调 dev 撞 illegal_transition）。
 */

import { type GateContext, runGate } from "../gates.js";
import { parseLitePlan } from "../plan-parser.js";
import { buildNextAction, computeNextStatus } from "../state-machine.js";
import type { ActionDeps, ActionResult, CwTopic } from "../types.js";

export interface PlanParams {
  action: "plan";
  topicId: string;
  /** plan.json 内容（protocol.ts 从 stdin/--plan-json-file 读为对象）。 */
  planJson: unknown;
}

/**
 * handlePlan — lite plan gate + 任务清单写入 + 状态流转。
 *
 * @param params  含 topicId + planJson
 * @param topic   dispatch 已 loadTopic + guard 过的 topic（status=created, tier=lite）
 * @param deps    ActionDeps（store/runner/git/workspacePath）
 *
 * 失败路径：
 *   - parseLitePlan throw（D-003 tier 锁定 / schema 不匹配）→ propagate（exit ≥1）
 *   - gate fail → status 不变 + gateHistory fail + gatePassed.plan 不设（exit 0）
 */
export function handlePlan(
  params: PlanParams,
  topic: CwTopic,
  deps: ActionDeps,
): ActionResult {
  // 解析（含 D-003 tier 锁定校验 + schema 校验，throw 由上层映射 exit code）。
  const parsed = parseLitePlan(params.planJson, topic.tier);

  const gateCtx: GateContext = {
    topic,
    topicDir: topic.topicDir || deps.workspacePath,
    workspacePath: deps.workspacePath,
    runner: deps.runner,
    git: deps.git,
  };

  // 事务包裹 gate + mutate（#1 事务边界 = 每个 action 一个）。
  const result = deps.store.transaction(() => {
    const gate = runGate(gateCtx, "lite", "plan");
    if (!gate.passed) {
      // gate fail：status 不变，gateHistory 追加 fail（AC-2.2）。
      deps.store.appendGateHistory(params.topicId, {
        phase: "plan",
        action: "plan",
        gate: "check_plan.py",
        tier: gate.gateTier,
        result: "fail",
        report: gate.reports.map((r) => r.report).join("\n"),
        progressive: false,
      });
      return { passed: false, gate };
    }
    // gate pass：解析的任务清单写入 + 状态流转（AC-2.1）。
    deps.store.insertWaves(params.topicId, parsed.waves);
    deps.store.insertTestCases(params.topicId, parsed.testCases);
    deps.store.updateStatus(params.topicId, computeNextStatus("plan", topic.status));
    deps.store.updateGatePassed(params.topicId, "plan", true);
    deps.store.appendGateHistory(params.topicId, {
      phase: "plan",
      action: "plan",
      gate: "check_plan.py",
      tier: gate.gateTier,
      result: "pass",
      progressive: false,
    });
    return { passed: true, gate };
  });

  // 重新 load 拿最新 topic（状态/任务清单已变）。
  const updated = deps.store.loadTopic(params.topicId)!;
  const next = buildNextAction("plan", updated);
  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    gateTier: result.gate.gateTier,
    nextAction: next,
    ...(result.passed ? {} : { mustFix: result.gate.reports.map((r) => r.report).join("\n") }),
  };
}

/**
 * closeout action — 终态，check_closeout.py + evidence 填充。
 * gate pass → status=closed（终态不可逆）；evidence 含完整 gateHistory。
 *
 * 适配 dispatch 模式：topic 由 dispatch 预加载 + guard 已通过。
 */

import { type GateContext, runGate } from "../gates.js";
import { buildNextAction, computeNextStatus } from "../state-machine.js";
import type { ActionDeps, ActionResult, CwTopic, Evidence } from "../types.js";
import { resolveTopicDir } from "../types.js";

export interface CloseoutParams {
  action: "closeout";
  topicId: string;
}

export function handleCloseout(params: CloseoutParams, topic: CwTopic, deps: ActionDeps): ActionResult {
  const gateCtx: GateContext = {
    topic,
    topicDir: resolveTopicDir(topic),
    workspacePath: deps.workspacePath,
    runner: deps.runner,
    git: deps.git,
  };

  let gateTier: string = "";
  let mustFix: string | undefined;

  deps.store.transaction(() => {
    const gate = runGate(gateCtx, topic.tier, "closeout");
    gateTier = gate.gateTier;

    if (!gate.passed) {
      deps.store.appendGateHistory(params.topicId, {
        phase: "closeout",
        action: "closeout",
        gate: "check_closeout.py",
        tier: gate.gateTier,
        result: "fail",
        report: gate.reports.map((r) => r.report).join("\n"),
        progressive: false,
      });
      mustFix = gate.reports.map((r) => r.report).join("\n");
      return;
    }

    deps.store.updateStatus(params.topicId, computeNextStatus("closeout", topic.status));
    deps.store.updateGatePassed(params.topicId, "closeout", true);
    deps.store.appendGateHistory(params.topicId, {
      phase: "closeout",
      action: "closeout",
      gate: "check_closeout.py",
      tier: gate.gateTier,
      result: "pass",
      progressive: false,
    });

    // 事务内 reload：evidence.gateHistory 含全量历史（含本次 closeout pass）
    const fresh = deps.store.loadTopic(params.topicId)!;
    const evidence: Evidence = {
      closedAt: new Date().toISOString(),
      coverage: fresh.coverage,
      gateHistory: fresh.gateHistory,
    };
    deps.store.setEvidence(params.topicId, evidence);
  });

  const updated = deps.store.loadTopic(params.topicId)!;
  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    gateTier: gateTier as ActionResult["gateTier"],
    evidence: updated.evidence,
    nextAction: buildNextAction("closeout", updated),
    ...(mustFix ? { mustFix } : {}),
  };
}

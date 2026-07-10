/**
 * retrospect action — weak gate（文件存在+非空），UC 前段。
 * gate：weak-structural，progressive（可多次提交直到 gatePassed）。
 *
 * 适配 dispatch 模式：topic 由 dispatch 预加载 + guard 已通过。
 */

import { existsSync, readFileSync } from "node:fs";

import { lookupGateTier } from "../gates.js";
import { buildNextAction, computeNextStatus } from "../state-machine.js";
import type { ActionDeps, ActionResult, CwTopic } from "../types.js";

export interface RetrospectParams {
  action: "retrospect";
  topicId: string;
  /** changes/retrospect.md 绝对路径。 */
  retrospectPath?: string;
}

export function handleRetrospect(params: RetrospectParams, topic: CwTopic, deps: ActionDeps): ActionResult {
  const gateTier = lookupGateTier(topic.tier, "retrospect");
  // weak gate：文件存在 + 非空。
  const path = params.retrospectPath ?? "";
  const passed =
    path.length > 0 &&
    existsSync(path) &&
    readFileSync(path, "utf8").trim().length > 0;

  deps.store.transaction(() => {
    deps.store.appendGateHistory(params.topicId, {
      phase: "retrospect",
      action: "retrospect",
      gate: "file-exists+non-empty",
      tier: gateTier,
      result: passed ? "pass" : "fail",
      report: passed ? undefined : "retrospect.md missing or empty",
      progressive: true,
    });
    if (passed) {
      deps.store.updateStatus(params.topicId, computeNextStatus("retrospect", topic.status));
      deps.store.updateGatePassed(params.topicId, "retrospect", true);
    }
  });

  const updated = deps.store.loadTopic(params.topicId)!;
  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    gateTier,
    nextAction: buildNextAction("retrospect", updated),
    ...(passed ? {} : { mustFix: "retrospect.md missing or empty" }),
  };
}

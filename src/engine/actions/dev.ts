/**
 * dev action — 渐进式提交（UC-3，关联 code-architecture.md §4.3 时序图）。
 *
 * 数据流（per task）：
 *   GitValidator.validate(commitHash)
 *     → valid: store.setWaveCommitted(waveId, commitHash)
 *     → invalid: 跳过（wave 保持未 committed，gate 不通过）
 *   → store.updateTopic(computeNextStatus)
 *   → store.appendGateHistory(medium-git 记录)
 *   → reload topic → buildNextAction
 *
 * 不变式：
 *   - progressive（computeNextStatus 已达 developed 时原地停留，AC-3.1 态内推进）
 *   - dev phase complete = 全 Wave committed（computeGatePassed，与 gateHistory 解耦）
 *
 * 失败路径：
 *   - 单个 commit 无效 → 该 wave 不写 committed，gatePassed.dev=false
 *   - reload 后 topic 丢失 → throw（事务异常的兜底）
 *
 * 关联：requirements UC-3 (AC-3.1~3.4)；issue #7（exit code 分层由 CLI 层负责）。
 */

import { buildNextAction, computeGatePassed, computeNextStatus } from "../state-machine.js";
import { lookupGateTier } from "../gates.js";
import type { ActionDeps, ActionResult, CwTopic, GateHistorySeed } from "../types.js";

export interface DevParams {
  action: "dev";
  topicId: string;
  tasks: Array<{ waveId: string; commitHash: string }>;
}

/**
 * handleDev — 渐进式 dev 提交。
 *
 * @param params  含 topicId + tasks[{waveId, commitHash}]
 * @param topic   dispatch 预加载的 topic（guard 已通过）
 * @param deps    store / git / runner / workspacePath
 */
export function handleDev(params: DevParams, topic: CwTopic, deps: ActionDeps): ActionResult {
  // Step 1: 逐 task 校验 commit（medium-git gate 的核心校验）。
  // 全量校验，不 short-circuit，便于汇总无效项。
  const taskResults = params.tasks.map((task) => ({
    waveId: task.waveId,
    commitHash: task.commitHash,
    validation: deps.git.validate(task.commitHash),
  }));
  const invalidTasks = taskResults.filter((t) => !t.validation.valid);

  // Step 2: 计算流转后状态（progressive：已 developed 则原地停留）。
  const nextStatus = computeNextStatus("dev", topic.status);

  // Step 3: 事务内写入——只 commit 校验通过的 wave。
  deps.store.transaction(() => {
    for (const t of taskResults) {
      if (t.validation.valid) {
        deps.store.setWaveCommitted(topic.topicId, t.waveId, t.commitHash);
      }
    }
    deps.store.updateStatus(topic.topicId, nextStatus);

    // medium-git gate 记录：所有提交 commit 校验通过 = pass
    const gateSeed: GateHistorySeed = {
      phase: "dev",
      action: "dev",
      gate: "medium-git",
      tier: "medium-git",
      result: invalidTasks.length === 0 ? "pass" : "fail",
      progressive: true,
      report:
        invalidTasks.length > 0
          ? `invalid commits: ${invalidTasks.map((t) => `${t.waveId}@${t.commitHash}`).join(", ")}`
          : undefined,
    };
    deps.store.appendGateHistory(topic.topicId, gateSeed);
  });

  // Step 4: reload 拿到事务后最新 waves，供 gatePassed/nextAction 计算。
  const updated = deps.store.loadTopic(topic.topicId);
  if (!updated) {
    throw new Error(`topic not found after dev: ${topic.topicId}`);
  }

  // Step 5: 组装 ActionResult。
  const devGatePassed = computeGatePassed("dev", updated);
  return {
    topicId: updated.topicId,
    status: updated.status,
    gatePassed: { ...updated.gatePassed, dev: devGatePassed },
    gateTier: lookupGateTier(updated.tier, "dev"),
    nextAction: buildNextAction("dev", updated),
  };
}

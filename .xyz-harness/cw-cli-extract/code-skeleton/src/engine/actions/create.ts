/**
 * create action — 入口 action（UC-1）。锁 tier，建 topic 目录与 _cw.json。
 *
 * Level 1 接线：
 *   - handleCreate → 构造 CwTopic → store.insertTopic → buildNextAction
 *   - buildTopicId → 纯函数拼接
 */

import { join } from "node:path";

import { buildNextAction } from "../state-machine.js";
import type { ActionDeps, ActionResult, CwTopic } from "../types.js";

export interface CreateParams {
  action: "create";
  slug: string;
  tier: "lite" | "mid";
  objective: string;
  workspacePath?: string;
}

/**
 * handleCreate — 构造新 CwTopic 并持久化。
 *
 * 数据流：slug+tier+objective → 新 CwTopic → store.insertTopic → buildNextAction。
 * 不变式：tier 写入后只读（后续 action 的 format 校验兜底，D-003）。
 * 失败路径：slug 重复 → insertTopic 抛 PRIMARY KEY 冲突。
 *
 * Level 1 接线：构造 topic 对象 + store.transaction + store.insertTopic + buildNextAction。
 */
export function handleCreate(params: CreateParams, deps: ActionDeps): ActionResult {
  // 接线：构造 topicId + workspacePath + topicDir。
  const topicId = buildTopicId(params.slug);
  const workspacePath = params.workspacePath ?? deps.workspacePath;
  const topicDir = join(workspacePath, ".xyz-harness", params.slug);

  // 接线：构造 CwTopic 领域对象。
  const topic: CwTopic = {
    schemaVersion: 1,
    topicId,
    slug: params.slug,
    tier: params.tier,
    objective: params.objective,
    workspacePath,
    topicDir,
    createdAt: new Date().toISOString(),
    status: "created",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
  };

  // 接线：事务内持久化（store.transaction → store.insertTopic）。
  deps.store.transaction(() => {
    deps.store.insertTopic(topic);
  });

  // 接线：复用 buildNextAction（单一来源）。
  return {
    topicId,
    status: topic.status,
    gatePassed: topic.gatePassed,
    nextAction: buildNextAction("create", topic),
  };
}

/**
 * buildTopicId — 拼接 topicId = cw-YYYY-MM-DD-<slug>。
 * 纯函数，叶子逻辑。
 */
function buildTopicId(slug: string): string {
  const ISO_DATE_PREFIX_LEN = 10;
  const date = new Date().toISOString().slice(0, ISO_DATE_PREFIX_LEN);
  return `cw-${date}-${slug}`;
}

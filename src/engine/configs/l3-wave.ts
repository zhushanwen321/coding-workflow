/**
 * L3 wave ScopeConfig —— 验证递归嵌套的关键配置。
 *
 * wave 在 cw 0.x 是 topic.waves[] 内嵌字段（types.ts:203-215），1.0 提升为独立 Unit。
 * 关键验证点：topic↔wave 通过 parentUnitId / childUnitIds 指针解耦，
 * topic 的 dev action 间接触发 wave 的 commit action，但不直接调 wave 状态机内部。
 *
 * wave 状态机自身流程简化为：planned → committed → reviewed → tested。
 * 每个 wave 独立走自己的状态机，topic closeout gate 校验所有 child wave 都是 terminal。
 */
import type { ScopeConfig } from "../scope-config.js";
import type { L3TopicWaveItem } from "./l3-topic.js";

/**
 * L3 wave status。
 *
 * 与 cw 0.x wave 不同：cw 0.x wave 只有 committed 标志位（boolean），
 * 1.0 wave 是独立 Unit，有完整 status 流转。
 */
export type L3WaveStatus =
  | "planned" // 创建时
  | "committed" // dev 完成，commit hash 锚定
  | "reviewed" // review 通过
  | "tested" // test 通过，终态
  | "aborted"; // 终态

/**
 * L3 wave action。
 */
export type L3WaveAction =
  | "create"
  | "commit" // wave 的 "dev"：提交代码，锚 commit hash
  | "review"
  | "test"
  | "abort";

/**
 * L3 wave payload —— wave 特有字段。
 */
export interface L3WavePayload {
  /** wave 的设计描述（plan 时定的）。 */
  description: string;
  /** 依赖的其他 wave id（dependsOn）。 */
  dependsOn: string[];
  /** commit hash（commit action 后填）。 */
  commitHash: string | null;
  /** 改动文件清单（commit 后从 diff-tree 取）。 */
  changedFiles: string[];
  /** wave 内容描述（与 L3TopicWaveItem.changes 对齐）。 */
  changes: L3TopicWaveItem["changes"];
}

/**
 * L3 wave transitions。
 */
export const L3_WAVE_TRANSITIONS: Record<L3WaveAction, {
  expectedStatuses: readonly L3WaveStatus[];
  nextStatus: L3WaveStatus;
  progressive?: boolean;
}> = {
  create: { expectedStatuses: [], nextStatus: "planned" },
  commit: { expectedStatuses: ["planned"], nextStatus: "committed" },
  review: {
    // progressive：fix 后可再 review
    expectedStatuses: ["committed", "reviewed"],
    nextStatus: "reviewed",
    progressive: true,
  },
  test: {
    expectedStatuses: ["reviewed", "tested"],
    nextStatus: "tested",
    progressive: true,
  },
  abort: {
    expectedStatuses: ["planned", "committed", "reviewed"],
    nextStatus: "aborted",
  },
};

/**
 * L3 wave 完整 ScopeConfig 实例。
 *
 * 关键：scope = "L3-wave"，与 L3-topic 是不同的 ScopeConfig 实例。
 * UnitStateMachine 实例化两次（一次配 L3_TOPIC_CONFIG，一次配 L3_WAVE_CONFIG），
 * 即可分别驱动 topic 和 wave。
 *
 * 嵌套关系通过 Unit.parentUnitId / Unit.childUnitIds 字符串指针表达：
 *   wave.parentUnitId = "L3-topic:{topicSlug}"
 *   topic.childUnitIds = ["L3-wave:{topicSlug}-w1", "L3-wave:{topicSlug}-w2", ...]
 * 引擎不直接调用对方状态机，只通过指针 + store.findChildren 查询。
 */
export const L3_WAVE_CONFIG: ScopeConfig<
  L3WaveStatus,
  L3WaveAction,
  L3WavePayload
> = {
  scope: "L3-wave",
  transitions: L3_WAVE_TRANSITIONS,
  initStatus: "planned",
  terminalStatuses: new Set(["tested", "aborted"]),

  phases: {
    // wave 没 clarify（继承 topic plan 阶段的设计）
    clarify: undefined,
    review: { action: "review", granularity: "unit", repetition: "loop" },
    lock: { action: "commit", granularity: "unit", repetition: "once" },
    split: undefined, // wave 是叶子，不再 split
  },

  freezeRules: [
    {
      // commit 后的 wave 不可改 commitHash / changes / dependsOn
      id: "wave-committed",
      collection: "commits",
      predicate: (item) => {
        const c = item as { committed: boolean };
        return c.committed === true;
      },
      immutableFields: ["commitHash", "changes", "dependsOn"],
      violationType: "wave_modified_committed",
    },
  ],

  loops: {
    review: { turnField: "reviewTurn", limit: 2, escapeAction: "test" },
  },

  gateRetryLimit: 5,

  collections: {
    gateHistory: { writeMode: "append" },
    commits: { writeMode: "append", protectedFields: ["commitHash", "changes", "dependsOn"] },
    reviewIssues: { writeMode: "append" },
  },
};

/**
 * L3 topic ScopeConfig —— cw 0.x topic 流程的 1.0 配置化实例。
 *
 * 验证目标：cw 0.x 的 8 status + 9 action + freezeRules + collections 能否完全用
 * ScopeConfig 配置表达，零硬编码 if-else 分支。
 *
 * 这是把 cw 0.x state-machine.ts 的 TRANSITIONS（L217-330）+ TaskShape + collection
 * 写入语义（散落在 store.ts 30+ 方法）翻译成声明式配置。
 *
 * 与 cw 0.x 的对应关系：
 *   - L3_TOPIC_TRANSITIONS ← state-machine.ts TRANSITIONS（subset，原型只配核心 9 action）
 *   - L3_TOPIC_CONFIG.freezeRules ← actions.ts validateAppendOnly 的 5 种违规
 *   - L3_TOPIC_CONFIG.collections ← store.ts 散落的 append/replace/freeze 方法
 *   - L3_TOPIC_CONFIG.loops ← state-machine.ts *_TURN_LIMIT
 */
import type { ScopeConfig } from "../scope-config.js";

/**
 * L3 topic status（原型只配核心 8 个 + 2 个终态 = 10 个）。
 *
 * 完整平移 cw 0.x types.ts:60-72，但原型省略 clarify_confirmed / spec_reviewed / plan_reviewed
 * （对应 fix-loop 阶段，原型用 progressive action 间接表达）。
 *
 * 完整迁移时把 cw 0.x 的 12 个 status 全部搬过来。
 */
export type L3TopicStatus =
  | "created"
  | "planned"
  | "pre_dev_verified"
  | "developed"
  | "reviewed"
  | "post_dev_verified"
  | "retrospected"
  | "closed" // 终态
  | "aborted"; // 终态

/**
 * L3 topic action（原型只配核心 9 个）。
 *
 * 完整迁移时把 cw 0.x 的 19 个 action 全部搬过来（含 fix loop / clarify / replan / abort / assess）。
 * 原型验证主链即可。
 */
export type L3TopicAction =
  | "create"
  | "plan"
  | "tdd_plan"
  | "dev"
  | "review"
  | "test"
  | "retrospect"
  | "closeout"
  | "replan"
  | "abort";

/**
 * L3 topic payload —— topic 特有的 frontmatter 字段。
 *
 * 对应 cw 0.x Topic 接口（types.ts:716-769）里非通用的部分。
 * waves/testCases/gateHistory 等移到 collections，不在这里。
 */
export interface L3TopicPayload {
  /** topic 目标（用户原始需求）。 */
  objective: string;
  /** 工作区路径。 */
  workspacePath: string;
  /** topic 目录路径。 */
  topicDir: string;
  /** taskShape（类型分发用，原型只用 "full-tdd"）。 */
  taskShape?: "full-tdd" | "delete-only" | "doc-only";
  /** runtimeEnv（agent + llm + cwVersion）。 */
  runtimeEnv?: { agent?: string; llm?: string; cwVersion?: string };
  /** reviewTurn / testTurn 计数器（loop 控制用）。 */
  reviewTurn: number;
  testTurn: number;
  /** from-spec 模式的上游 spec 引用（跨层指针，drift 检测用）。 */
  fromSpec?: string;
}

/**
 * Wave 集合元素的运行时结构（在 collections.waves 里）。
 *
 * 与 cw 0.x Wave 接口（types.ts:203-215）对齐，但作为通用 collection 的元素。
 */
export interface L3TopicWaveItem {
  id: string;
  dependsOn: string[];
  /** commit hash（committed 后非 null）。 */
  committed: string | null;
  changes: Array<{ file: string; action: "create" | "modify" | "delete"; description: string }>;
  priority?: string;
  changedFiles?: string[];
}

/**
 * TestCase 集合元素（在 collections.testCases 里）。
 */
export interface L3TopicTestCaseItem {
  id: string;
  scenario: string;
  expected: unknown;
  status: "pending" | "passed" | "failed";
  actual?: unknown;
}

/**
 * L3 topic transitions —— 直接平移 cw 0.x TRANSITIONS（state-machine.ts:217-330）。
 *
 * 原型只配核心 10 action，省略 clarify / confirm_clarify / spec_reviewN / plan_reviewN / review_fix / test_fix / assess。
 * 完整迁移时把 cw 0.x 19 个 action 全部搬过来。
 */
export const L3_TOPIC_TRANSITIONS: Record<L3TopicAction, {
  expectedStatuses: readonly L3TopicStatus[];
  nextStatus: L3TopicStatus;
  progressive?: boolean;
}> = {
  create: { expectedStatuses: [], nextStatus: "created" },
  plan: {
    expectedStatuses: ["created", "planned"],
    nextStatus: "planned",
  },
  tdd_plan: {
    expectedStatuses: ["planned", "pre_dev_verified"],
    nextStatus: "pre_dev_verified",
  },
  dev: {
    // progressive：渐进式提交多个 wave，status 不回退
    expectedStatuses: ["pre_dev_verified", "developed"],
    nextStatus: "developed",
    progressive: true,
  },
  review: {
    // progressive：fix 后可再 review
    expectedStatuses: ["developed", "reviewed"],
    nextStatus: "reviewed",
    progressive: true,
  },
  test: {
    expectedStatuses: ["reviewed", "post_dev_verified"],
    nextStatus: "post_dev_verified",
    progressive: true,
  },
  retrospect: { expectedStatuses: ["post_dev_verified"], nextStatus: "retrospected" },
  closeout: { expectedStatuses: ["retrospected"], nextStatus: "closed" },
  replan: {
    // replan 回退到 planned（cw 0.x 行为）
    expectedStatuses: [
      "planned",
      "pre_dev_verified",
      "developed",
      "reviewed",
      "post_dev_verified",
    ],
    nextStatus: "planned",
  },
  abort: {
    // abort 从所有非终态合法
    expectedStatuses: [
      "created",
      "planned",
      "pre_dev_verified",
      "developed",
      "reviewed",
      "post_dev_verified",
      "retrospected",
    ],
    nextStatus: "aborted",
  },
};

/**
 * L3 topic 完整 ScopeConfig 实例。
 *
 * 把 cw 0.x 散落在 state-machine.ts + actions.ts + store.ts + shapes/ 的配置统一打包。
 * UnitStateMachine 接收此配置即可驱动 L3 topic 流程，零 topic 专用代码。
 */
export const L3_TOPIC_CONFIG: ScopeConfig<
  L3TopicStatus,
  L3TopicAction,
  L3TopicPayload
> = {
  scope: "L3-topic",
  transitions: L3_TOPIC_TRANSITIONS,
  initStatus: "created",
  terminalStatuses: new Set(["closed", "aborted"]),

  phases: {
    // 原型简化：plan 阶段同时承担 clarify 和 split 的产物（waves）
    clarify: { action: "plan", granularity: "unit", repetition: "once" },
    review: { action: "review", granularity: "unit", repetition: "loop" },
    lock: { action: "dev", granularity: "per-child", repetition: "loop" },
    // split 阶段在 L3 表现为「plan 产 waves」—— waves 是独立 Unit，由 dev 间接触发
    split: undefined,
  },

  // freeze 规则：替代 cw 0.x validateAppendOnly 的 5 种违规
  freezeRules: [
    {
      id: "wave-committed",
      collection: "waves",
      predicate: (item) => {
        const w = item as L3TopicWaveItem;
        return w.committed !== null;
      },
      immutableFields: ["committed", "changes", "dependsOn"],
      violationType: "wave_modified_committed",
    },
    {
      id: "test-case-passed",
      collection: "testCases",
      predicate: (item) => {
        const c = item as L3TopicTestCaseItem;
        return c.status === "passed";
      },
      immutableFields: ["expected", "scenario"],
      violationType: "case_modified_passed",
    },
  ],

  // loop 控制：替代 cw 0.x *_TURN_LIMIT
  loops: {
    review: { turnField: "reviewTurn", limit: 3, escapeAction: "test" },
    test: { turnField: "testTurn", limit: 5, escapeAction: "retrospect" },
  },

  gateRetryLimit: 5,

  // collection 写入语义：替代 cw 0.x store.ts 散落的方法约定
  collections: {
    gateHistory: { writeMode: "append" },
    waves: {
      writeMode: "append",
      protectedFields: ["committed", "changes", "dependsOn"],
    },
    testCases: { writeMode: "replace", versioned: true },
    clarifyRecords: { writeMode: "append" },
    specSections: { writeMode: "append" },
    reviewIssues: { writeMode: "append" },
    testFixLog: { writeMode: "append" },
    adrs: { writeMode: "append" },
    evidence: { writeMode: "freeze", freezeEvent: "closeout" },
    assessments: { writeMode: "append" },
  },

  // drift 检测配置（跨层逆向用，原型预留）
  driftConfig: {
    upstreamScope: "L4-spec",
    triggerEvents: ["unlock", "supersede"],
    blockingActions: ["closeout"],
  },
};

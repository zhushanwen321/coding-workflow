/**
 * CW 状态机（lite 单轨极简版）：声明式转换表 + 单重 guard + nextAction 组装 + gate 熔断。
 *
 * 与旧版的差异（重构 = 推倒重建）：
 * - guard 从三重（checkLinear → checkPhaseCascade → checkCacheConsistency）砍为单重（checkLinear）。
 *   纵深防御 guard 本次不做——半成品状态靠 handler 内 computeGatePassed + nextAction 指回自己兜底。
 * - GuardErrorCode 只剩 illegal_transition（砍 phase_incomplete / cache_inconsistent）。
 * - TRANSITIONS 砍 clarify / detail（mid 专属），replan 砍 detailed 入口只留 planned/developed。
 * - buildNextAction 砍 tier 分支（lite-only）+ 砍 clarify/detail/replan-mid 分支。
 * - gate 熔断保留：GATE_RETRY_LIMIT=5 + countConsecutiveGateFails + buildCircuitBreakerGuidance。
 *
 * 关键语义：
 * - progressive 原地停留：dev 在 developed 状态下再次调用，status 仍为 developed（不回退）。
 *   test 同理。靠 computeNextStatus 判定。
 * - 熔断两种语义：GATE_RETRY_LIMIT（连续 gate fail 5 次）只告警不阻断，guidance 换文案；
 *   REVIEW/TEST_TURN_LIMIT（loop 轮数上限）达上限后强制前推到下一阶段（review→test, test→retrospect）。
 */

import { CLARIFY_PROMPT, CONFIRM_CLARIFY_PROMPT, DEV_PLAN_PROMPT, EXECUTE_PROMPT, PLAN_REVIEW_PROMPT, RETROSPECT_PROMPT, REVIEW_PROMPT, SPEC_REVIEW_PROMPT, TDD_PLAN_PROMPT } from "./prompts/index.js";
import type {
  Action,
  GateHistoryEntry,
  GuardVerdict,
  NextAction,
  NextActionAlternative,
  Status,
  Topic,
} from "./types.js";

// ── gate 熔断 ──────────────────────────────────────────────

/** 连续 gate fail 达此阈值后，nextAction guidance 换熔断文案（不阻断，只告警）。 */
const GATE_RETRY_LIMIT = 5;

/**
 * review / test 循环轮数上限（防无限重试）。
 * review_fix/test_fix 的 loop 超过此阈值后 nextAction 应告警（W3+ 在 buildNextAction 接入）。
 * 此处先定义常量供后续 Wave 使用。
 */
export const REVIEW_TURN_LIMIT = 3;
export const TEST_TURN_LIMIT = 5;
const SPEC_REVIEW_TURN_LIMIT = 2;
const PLAN_REVIEW_TURN_LIMIT = 2;

/**
 * 从 gateHistory 尾部向前数给定 phase 的连续 fail 次数。
 * 遇到非本 phase 或本 phase 的 pass 记录即停止。
 */
function countConsecutiveGateFails(
  history: GateHistoryEntry[],
  phase: Action,
): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (entry.phase !== phase) break;
    if (entry.result === "fail") {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/** 熔断文案：提示 agent 可能机器误判，建议人工审查。 */
function buildCircuitBreakerGuidance(phase: Action, fails: number): string {
  return (
    `${phase} gate 已连续失败 ${fails} 次（达熔断阈值 ${GATE_RETRY_LIMIT}）。` +
    `可能存在机器检查误判。建议：(1) 逐条检查 mustFix 报错是否合理 (2) ask_user 人工审查交付物。`
  );
}

// ── replan alternative ─────────────────────────────────────

/**
 * replan 的 alternative guidance（plan/dev 阶段注入，让 agent 发现可改 plan）。
 *
 * replan 在 status∈{planned, developed} 合法（见 TRANSITIONS.replan）。
 * 注入到这两个阶段的 nextAction.alternatives，使 agent 知道「plan 不是一次性的，
 * dev 中途发现要追加 Wave 可以 replan」。append-only 约束在文案里点明，避免 agent 误改已 committed 项。
 */
const REPLAN_GUIDANCE =
  `如需修改计划，调 cw replan（支持 --plan 和 --test 两种模式）：\n` +
  `    echo '<newDevPlanJson>' | cw replan --topicId <topicId> --plan   # 修订 dev-plan（追加 wave）\n` +
  `    cw replan --topicId <topicId> --test --testJsonFile <path>       # 修订 test.json（调整 expected / 追加 case）\n` +
  `约束（append-only）：已 committed 的 wave 和已 passed 的 testCase 不可删改。` +
  `replan 后 status 回退到 planned，需重走 tdd_plan → dev → review → test。`;

/** 构造 replan alternative 项（status∈{planned, tdd_inited, developed, reviewed, tested} 的 nextAction 用）。 */
function replanAlternative(): NextActionAlternative {
  return { action: "replan", guidance: REPLAN_GUIDANCE };
}

// ── 声明式转换表 ────────────────────────────────────────────

export interface TransitionRule {
  /** 允许的当前 status 集合。create 为空数组（无 topic 即可）。 */
  expectedStatuses: Status[];
  /** 流转后的目标 status。 */
  nextStatus: Status;
  /** progressive：若当前已在 nextStatus，则原地停留（不回退）。 */
  progressive?: boolean;
}

/**
 * 8 个 action 的转换规则（lite 单轨，含 tdd_plan）。
 *
 * 线性序列：create → plan(planned) → tdd_plan(tdd_inited) → dev(developed)
 *   → review(reviewed) → test(tested) → retrospect(retrospected) → closeout(closed)。
 *
 * replan 允许在 planned/tdd_inited/developed/reviewed/tested 调用（覆盖 dev 中途追加场景），
 * nextStatus 回退到 planned。progressive=true 使其在非 planned 状态调用时
 * 仍回退 planned（replan 后必须重新走 dev）——这是「回退」而非「原地停留」，
 * 所以 progressive 标记在这里不触发原地停留（current 不会 === nextStatus）。
 */
export const TRANSITIONS: Record<Action, TransitionRule> = {
  create: { expectedStatuses: [], nextStatus: "created" },
  clarify: {
    // clarify 是 progressive append-only action：created/clarify_confirmed/spec_reviewed 状态下可多次调。
    // FR-1: 含 clarify_confirmed 让用户看确认文档后能回头追加/修改再重新 confirm。
    // MF-1 (review fix): 含 spec_reviewed 让 spec_review 发现问题后能回头改 spec（cw clarify 带
    //   replaceSpec 更新 specSections），再重调 spec_review 复审。clarify 不流转 status（progressive），
    //   改完 spec 直接重调 spec_review 即可，不需重新 confirm_clarify。
    //
    // 注意：handleClarify 不调 updateStatus（只追加 clarifyRecord/specSections），
    // 所以 nextStatus 的值不影响实际行为——status 保持不变。
    expectedStatuses: ["created", "clarify_confirmed", "spec_reviewed"],
    nextStatus: "created",
    progressive: true,
  },
  confirm_clarify: {
    // FR-1: confirm_clarify 流转 created → clarify_confirmed。
    // progressive：clarify_confirmed 状态下再 confirm 合法（重新生成确认 md 覆盖旧文件）。
    expectedStatuses: ["created", "clarify_confirmed"],
    nextStatus: "clarify_confirmed",
    progressive: true,
  },
  // FR-4: spec_review 在 confirm_clarify 之后、plan 之前，审查 spec 完整性/合理性。
  // progressive：spec_reviewed 状态下可多轮 spec_review（loop fix 后重审）。
  spec_review: {
    expectedStatuses: ["clarify_confirmed", "spec_reviewed"],
    nextStatus: "spec_reviewed",
    progressive: true,
  },
  spec_review_fix: {
    expectedStatuses: ["spec_reviewed"],
    nextStatus: "spec_reviewed",
    progressive: true,
  },
  // FR-1: plan 前必须经过 confirm_clarify。
  // FR-4/6 向后兼容：含 planned（旧 topic 已 plan 过的重调不拒绝）。
  plan: { expectedStatuses: ["spec_reviewed", "planned"], nextStatus: "planned" },
  // FR-5: plan_review 在 plan 之后、tdd_plan 之前，审查 plan 是否覆盖 spec、架构是否合理。
  // progressive：plan_reviewed 状态下可多轮 plan_review（loop fix 后重审）。
  plan_review: {
    expectedStatuses: ["planned", "plan_reviewed"],
    nextStatus: "plan_reviewed",
    progressive: true,
  },
  plan_review_fix: {
    expectedStatuses: ["plan_reviewed"],
    nextStatus: "plan_reviewed",
    progressive: true,
  },
  tdd_plan: { expectedStatuses: ["plan_reviewed", "tdd_inited"], nextStatus: "tdd_inited" },
  dev: {
    // dev 只从 tdd_inited/developed 进入。
    // test/review 失败走 test_fix/review_fix loop（不回 dev——所有 Wave 已 committed，dev 没有新任务）。
    expectedStatuses: ["tdd_inited", "developed"],
    nextStatus: "developed",
    progressive: true,
  },
  review: {
    // progressive：fix 后可再 review（多轮 review loop）。reviewed 状态下再次 review 合法。
    expectedStatuses: ["developed", "reviewed"],
    nextStatus: "reviewed",
    progressive: true,
  },
  review_fix: {
    // review_fix：reviewed 状态下修 issue 后的修复动作（progressive，留在 reviewed）。
    expectedStatuses: ["reviewed"],
    nextStatus: "reviewed",
    progressive: true,
  },
  test: {
    expectedStatuses: ["reviewed", "tested"],
    nextStatus: "tested",
    progressive: true,
  },
  test_fix: {
    // test_fix：tested 状态下修代码后的修复动作（progressive，留在 tested）。审计日志由 store 追加。
    expectedStatuses: ["tested"],
    nextStatus: "tested",
    progressive: true,
  },
  retrospect: { expectedStatuses: ["tested"], nextStatus: "retrospected" },
  closeout: { expectedStatuses: ["retrospected"], nextStatus: "closed" },
  replan: {
    expectedStatuses: ["planned", "plan_reviewed", "tdd_inited", "developed", "reviewed", "tested"],
    nextStatus: "planned",
  },
  // FR-3: abort 从所有非终态 status 合法，流转到 aborted 终态。
  abort: {
    expectedStatuses: [
      "created",
      "clarify_confirmed",
      "spec_reviewed",
      "planned",
      "plan_reviewed",
      "tdd_inited",
      "developed",
      "reviewed",
      "tested",
      "retrospected",
    ],
    nextStatus: "aborted",
  },
  assess: {
    // post-closeout 评估，progressive，不改 status（始终 closed）。
    // 不进 guidance 主链路（人工触发，不在 buildNextAction 导航里）。
    expectedStatuses: ["closed"],
    nextStatus: "closed",
    progressive: true,
  },
};

// ── 单重 guard ──────────────────────────────────────────────

/**
 * checkLinear — 唯一的 guard：线性 expectedStatus 校验。
 *
 * 接线：查 TRANSITIONS 表，比对 current status。
 * 砍掉 checkPhaseCascade（跨阶段 gatePassed 级联）和 checkCacheConsistency（缓存 self-check）——
 * lite 单轨线性检查已足够防跳步，半成品状态靠 handler 内 computeGatePassed 兜底。
 *
 * create 特殊处理：current=undefined 合法（无 topic 即可建）。
 */
export function checkLinear(
  action: Action,
  current: Status | undefined,
): GuardVerdict {
  const rule = TRANSITIONS[action];
  if (action === "create") {
    // create 允许 current=undefined（新建 topic）或任意 status（理论上不应有同名，
    // 但 guard 不查重名——重名由 store 的 UNIQUE 约束兜底）。
    return { ok: true };
  }
  if (current === undefined) {
    return {
      ok: false,
      code: "illegal_transition",
      reason: `${action} requires existing topic (current=undefined)`,
    };
  }
  if (!rule.expectedStatuses.includes(current)) {
    return {
      ok: false,
      code: "illegal_transition",
      reason: `${action} expects status ∈ {${rule.expectedStatuses.join(", ")}}, got ${current}`,
    };
  }
  return { ok: true };
}

/**
 * guard — 单重 guard 入口（checkLinear）。
 *
 * 砍掉旧版的三重串行（cascade + cache）。topic 参数为 null 时仅做线性检查
 * （create 合法，其余非法由 checkLinear 内部判定）。
 */
export function guard(action: Action, topic: Topic | null): GuardVerdict {
  return checkLinear(action, topic?.status);
}

// ── 状态流转 ─────────────────────────────────────────────────

/**
 * 计算流转后状态。
 *
 * progressive 语义：若该 action 是 progressive 且当前已在 nextStatus，
 * 则原地停留（返回 current，不回退也不前进）。
 *
 * 例：dev 是 progressive，nextStatus=developed。当 current 已是 developed 时
 * 再次调 dev（渐进式提交第二个 wave），status 仍为 developed。
 *
 * 注意：replan 标 progressive，nextStatus=planned，expectedStatuses 含 planned 自身。
 * 当 current=planned（如 plan 刚过、tdd_plan 之前调 replan）时 current===nextStatus，
 * progressive 命中原地停留（仍 planned）；其余 4 个 status（tdd_inited/developed/reviewed/tested）
 * 调用时回退到 planned。两种情况结果一致——progressive 标记对 replan 无实际效果，
 * 保留标记仅为表的一致性（replan 可多次调用）。
 */
export function computeNextStatus(action: Action, current: Status): Status {
  const rule = TRANSITIONS[action];
  if (rule.progressive && current === rule.nextStatus) {
    return current;
  }
  return rule.nextStatus;
}

// ── gatePassed 计算 ──────────────────────────────────────────

/**
 * 从 topic 逻辑模型算 phase 是否完成（不读 gatePassed 缓存，每次重算）。
 *
 * 完成语义：
 *   - dev：全 Wave committed（≥1 个且全部 committed !== null）
 *   - test：全 testCase passed（≥1 个且全部 status === "passed"）
 *   - single-shot（plan/tdd_plan/review/retrospect/closeout）：gateHistory 有该 phase 的 pass 记录
 *   - create：永远 false（create 无 gate）
 *   - replan：永远 false（replan 无独立 gate，完成度看 dev）
 */
export function computeGatePassed(phase: Action, topic: Topic): boolean {
  if (phase === "dev") {
    return topic.waves.length > 0 && topic.waves.every((w) => w.committed !== null);
  }
  if (phase === "test") {
    return (
      topic.testCases.length > 0 &&
      topic.testCases.every((c) => c.status === "passed")
    );
  }
  if (phase === "clarify") {
    // clarify gatePassed：全 clarifyRecords 的 status ∈ {resolved, skipped}（无 pending）。
    // 空数组（没走过 clarify）也算 pass。
    // 注意：FR-1 后 plan 的 expectedStatuses 是 [clarify_confirmed, planned]，
    // clarify gatePassed 不阻断 plan——它只用于 buildNextAction 推荐导航
    //（全 resolved → 推荐 confirm_clarify）。
    return topic.clarifyRecords.every((c) => c.status !== "pending");
  }
  if (phase === "spec_review") {
    // spec_review gatePassed：specReviewIssues 无 open（空数组也算 pass）。
    return topic.specReviewIssues.every((i) => i.status !== "open");
  }
  if (phase === "plan_review") {
    // plan_review gatePassed：planReviewIssues 无 open。
    return topic.planReviewIssues.every((i) => i.status !== "open");
  }
  if (phase === "create" || phase === "replan") {
    return false;
  }
  // plan / retrospect / closeout：single-shot，gateHistory 有 pass 即完成。
  return topic.gateHistory.some((e) => e.phase === phase && e.result === "pass");
}

// ── nextAction 组装 ──────────────────────────────────────────

/** waves 进度摘要（nextAction.waves 字段用）。 */
function waveProgress(topic: Topic): NextAction["waves"] {
  return topic.waves.map((w) => ({ id: w.id, committed: w.committed !== null }));
}

/** testCases 进度摘要（nextAction.testCases 字段用）。 */
function testCaseProgress(topic: Topic): NextAction["testCases"] {
  return topic.testCases.map((c) => ({ id: c.id, status: c.status }));
}

/** clarifyRecords 进度摘要（nextAction.clarifyProgress 字段用）。 */
function clarifyProgress(topic: Topic): NextAction["clarifyProgress"] {
  return topic.clarifyRecords.map((c) => ({
    id: c.id,
    kind: c.kind,
    status: c.status,
    adrId: c.adrId,
  }));
}

/** specSections 进度摘要（nextAction.specProgress 字段用）。 */
function specProgress(topic: Topic): NextAction["specProgress"] {
  return topic.specSections.map((s) => {
    if ("items" in s) return { type: s.type, itemCount: s.items.length };
    return { type: s.type };
  });
}

/**
 * buildNextAction — 按 action + gatePassed 推 nextAction（无 tier 分支）。
 *
 * 每个分支返回 nextAction，guidance = 导航短句 + 阶段提示词（spec/plan/execute）。
 * 提示词从 src/prompts/ import（与状态机强耦合，engine 不引用外部 skill 文档）。
 * gate fail 时 nextAction.action 指回自己（retry），达熔断阈值换文案。
 */
export function buildNextAction(action: Action, topic: Topic): NextAction {
  switch (action) {
    case "create": {
      // create 后推荐 clarify（澄清需求 + 记录 ADR）。
      // FR-1: plan 不再作为 alternative——created 状态下 plan 会 illegal_transition。
      // 必须先 clarify → confirm_clarify → plan。
      const createContract =
        `你已进入 CW 流程。从现在起到 closeout，所有编码工作必须通过 cw 命令推进：\n` +
        `- 不要使用 agent harness 的 plan mode / EnterPlanMode（CW 有自己的 plan 阶段：cw plan）\n` +
        `- 不要绕过状态机直接写代码（每个 wave 的 commit 必须通过 cw dev 提交）\n` +
        `- 如果发现任务不适合走 CW（如纯分析/设计），和用户确认后放弃 topic，不要静默跳过\n\n`;
      return {
        action: "clarify",
        guidance: `${createContract}topic 已建立。下一步：澄清需求与目标（探索技术系统 → 形成预判 → 向用户提问 → 记录 ADR），完成后调 cw confirm_clarify。\n\n${CLARIFY_PROMPT}`,
      };
    }
    case "clarify": {
      // clarify gate fail → 指回 retry
      if (!computeGatePassed("clarify", topic)) {
        // 注意：computeGatePassed("clarify") 对空数组返回 true，所以只有 pending 记录时才 fail。
        // 但 clarify 的 gate fail 是 clarifyCheck（结构校验）失败，不是 computeGatePassed。
        // 这里检查的是"有 pending 记录"——有 pending 说明还有未解决的澄清，继续 clarify。
        const hasPending = topic.clarifyRecords.some((c) => c.status === "pending");
        if (hasPending) {
          return {
            action: "clarify",
            guidance: `仍有 pending 澄清记录未解决。继续提问或带 answer 提交 cw(clarify)。\n\n${CLARIFY_PROMPT}`,
            clarifyProgress: clarifyProgress(topic),
            specProgress: specProgress(topic),
          };
        }
      }
      // FR-1: 有 resolved/skipped 记录 → 推荐 confirm_clarify。
      // 空数组 → 继续 clarify（还没探索，confirm gate 会拒绝）。
      const hasResolvedOrSkipped = topic.clarifyRecords.some(
        (c) => c.status === "resolved" || c.status === "skipped",
      );
      if (!hasResolvedOrSkipped) {
        return {
          action: "clarify",
          guidance: `尚未提交任何澄清记录。先探索技术系统，提交 cw(clarify) 记录澄清或显式 skip。\n\n${CLARIFY_PROMPT}`,
          clarifyProgress: clarifyProgress(topic),
          specProgress: specProgress(topic),
        };
      }
      // 有 resolved/skipped → 推荐 confirm_clarify（FR-1: plan 前必须 confirm）。
      return {
        action: "confirm_clarify",
        guidance: `clarify 阶段完成（所有记录已 resolved/skipped）。下一步：调 cw(gen-spec) 生成确认文档并 open 给用户看，用户确认后调 cw(confirm_clarify)。\n\n${CONFIRM_CLARIFY_PROMPT}`,
        clarifyProgress: clarifyProgress(topic),
        specProgress: specProgress(topic),
        alternatives: [
          {
            action: "clarify",
            guidance: `如需继续澄清，提交 cw(clarify) 记录新问题。\n\n${CLARIFY_PROMPT}`,
          },
        ],
      };
    }
    case "confirm_clarify": {
      // FR-4: confirm_clarify 通过 → 进 spec_review（审查 spec 完整性/合理性）。
      return {
        action: "spec_review",
        guidance: `需求已确认（clarify_confirmed）。下一步：审查 spec 的完整性和合理性（spec_review），完成后调 cw(spec_review)。\n\n${SPEC_REVIEW_PROMPT}`,
        clarifyProgress: clarifyProgress(topic),
        specProgress: specProgress(topic),
        alternatives: [
          {
            action: "clarify",
            guidance: `如需修改需求，提交 cw(clarify) 追加/修改记录，再重新 cw(confirm_clarify)。\n\n${CLARIFY_PROMPT}`,
          },
        ],
      };
    }
    case "spec_review": {
      // 与 review case 同构：无 open issue→plan；有 issue 未达上限→spec_review_fix；达上限→强制前推 plan。
      const openIssues = topic.specReviewIssues.filter((i) => i.status === "open");
      const mustFixCount = topic.specReviewIssues.filter(
        (i) => i.severity === "must-fix" && i.status === "open",
      ).length;
      const hasOpenIssues = openIssues.length > 0;
      const overLimit = topic.specReviewTurn >= SPEC_REVIEW_TURN_LIMIT;

      if (!hasOpenIssues) {
        return {
          action: "plan",
          guidance: `spec_review 通过（无 open issue）。下一步：写 dev-plan.json 并提交 cw(plan)。\n\n${DEV_PLAN_PROMPT}`,
          clarifyProgress: clarifyProgress(topic),
          specProgress: specProgress(topic),
        };
      }
      if (overLimit) {
        return {
          action: "plan",
          guidance: `spec_review 已达 ${SPEC_REVIEW_TURN_LIMIT} 轮上限（当前 turn=${topic.specReviewTurn}），强制进 plan。${mustFixCount} 个 must-fix 未修复。建议 ask_user 人工审查或调 cw(clarify) 重新澄清。\n\n${DEV_PLAN_PROMPT}`,
          clarifyProgress: clarifyProgress(topic),
          specProgress: specProgress(topic),
        };
      }
      return {
        action: "spec_review_fix",
        guidance: `spec_review 发现 ${openIssues.length} 个 open issue（${mustFixCount} 个 must-fix）。下一步：逐条修 issue（改 spec → cw clarify 更新 specSections），调 cw(spec_review_fix) 提交修复。\n\n${SPEC_REVIEW_PROMPT}`,
        clarifyProgress: clarifyProgress(topic),
        specProgress: specProgress(topic),
      };
    }
    case "spec_review_fix": {
      const turn = topic.specReviewTurn;
      const overLimit = turn >= SPEC_REVIEW_TURN_LIMIT;
      return {
        action: "spec_review",
        guidance: overLimit
          ? `spec_review 已达 ${SPEC_REVIEW_TURN_LIMIT} 轮上限（当前 turn=${turn}）。建议 ask_user 人工介入或调 cw(clarify) 重新澄清。`
          : `spec_review_fix 完成（第 ${turn} 轮）。下一步：重新调 cw(spec_review) 开启下一轮审查，确认所有 issue 已闭环。\n\n${SPEC_REVIEW_PROMPT}`,
      };
    }
    case "plan": {
      if (!computeGatePassed("plan", topic)) {
        const fails = countConsecutiveGateFails(topic.gateHistory, "plan");
        return {
          action: "plan",
          guidance:
            fails >= GATE_RETRY_LIMIT
              ? buildCircuitBreakerGuidance("plan", fails)
              : `plan gate FAIL。status 仍为 created——修 mustFix 后重调 cw(plan)。\n\n${DEV_PLAN_PROMPT}`,
        };
      }
      // plan gate 通过 → 进入 plan_review 阶段（FR-5: 审查 plan 是否覆盖 spec、架构是否合理）。
      const frSection = topic.specSections.find(
        (s) => s.type === "functionalRequirements",
      );
      const specNote =
        frSection && "items" in frSection
          ? `\n\n注意：spec 定义了 ${frSection.items.length} 个功能需求（FR）。plan 的 waves 必须覆盖这些 FR。`
          : "";
      return {
        action: "plan_review",
        guidance: `plan gate 通过（status=planned）。下一步：审查 plan 是否完整覆盖 spec、架构是否合理（plan_review），完成后调 cw(plan_review)。\n\n${PLAN_REVIEW_PROMPT}` + specNote,
        waves: waveProgress(topic),
        alternatives: [replanAlternative()],
      };
    }
    case "plan_review": {
      // 同 spec_review 结构，但用 planReviewIssues/PLAN_REVIEW_TURN_LIMIT，pass→tdd_plan。
      const openIssues = topic.planReviewIssues.filter((i) => i.status === "open");
      const mustFixCount = topic.planReviewIssues.filter(
        (i) => i.severity === "must-fix" && i.status === "open",
      ).length;
      const hasOpenIssues = openIssues.length > 0;
      const overLimit = topic.planReviewTurn >= PLAN_REVIEW_TURN_LIMIT;

      if (!hasOpenIssues) {
        return {
          action: "tdd_plan",
          guidance: `plan_review 通过（无 open issue）。下一步：写测试代码（红灯）+ test.json，调 cw(tdd_plan)。\n\n${TDD_PLAN_PROMPT}`,
          waves: waveProgress(topic),
          alternatives: [replanAlternative()],
        };
      }
      if (overLimit) {
        return {
          action: "tdd_plan",
          guidance: `plan_review 已达 ${PLAN_REVIEW_TURN_LIMIT} 轮上限（turn=${topic.planReviewTurn}），强制进 tdd_plan。${mustFixCount} 个 must-fix 未修复。\n\n${TDD_PLAN_PROMPT}`,
          waves: waveProgress(topic),
          alternatives: [replanAlternative()],
        };
      }
      return {
        action: "plan_review_fix",
        guidance: `plan_review 发现 ${openIssues.length} 个 open issue（${mustFixCount} 个 must-fix）。下一步：修 plan → cw replan，再调 cw(plan_review_fix) 提交修复。\n\n${PLAN_REVIEW_PROMPT}`,
        waves: waveProgress(topic),
      };
    }
    case "plan_review_fix": {
      const turn = topic.planReviewTurn;
      const overLimit = turn >= PLAN_REVIEW_TURN_LIMIT;
      return {
        action: "plan_review",
        guidance: overLimit
          ? `plan_review 已达 ${PLAN_REVIEW_TURN_LIMIT} 轮上限（turn=${turn}）。建议 ask_user 人工介入或调 cw(replan)。`
          : `plan_review_fix 完成（第 ${turn} 轮）。下一步：重新调 cw(plan_review) 复查。\n\n${PLAN_REVIEW_PROMPT}`,
        alternatives: overLimit ? [replanAlternative()] : undefined,
      };
    }
    case "tdd_plan": {
      // 红灯校验失败阻断流转：handleTddPlan 在红灯 fail 时回退 status 到 planned 并
      // append tdd-red-light(fail)。computeGatePassed 只看 test-json-schema pass 记录
      // （会漏判红灯 fail），这里补判：最近一条 tdd-red-light 为 fail → 视为 gate fail retry。
      const lastRedLight = [...topic.gateHistory]
        .reverse()
        .find((g) => g.gate === "tdd-red-light");
      const redLightBlocked =
        lastRedLight !== undefined && lastRedLight.result === "fail";
      if (!computeGatePassed("tdd_plan", topic) || redLightBlocked) {
        const fails = countConsecutiveGateFails(topic.gateHistory, "tdd_plan");
        return {
          action: "tdd_plan",
          guidance:
            fails >= GATE_RETRY_LIMIT
              ? buildCircuitBreakerGuidance("tdd_plan", fails)
              : `tdd_plan gate FAIL。status 仍为 planned——修 mustFix 后重调 cw(tdd_plan)。\n\n${TDD_PLAN_PROMPT}`,
        };
      }
      // tdd_plan gate 通过 → 进入 dev 阶段（写实现，让测试转绿）。
      return {
        action: "dev",
        guidance: `tdd_plan gate 通过（status=tdd_inited），testCases 已写入。下一步：按 Wave 写实现让测试转绿，commit 后调 cw(dev)。\n\n${EXECUTE_PROMPT}`,
        testCases: testCaseProgress(topic),
        alternatives: [replanAlternative()],
      };
    }
    case "dev": {
      if (computeGatePassed("dev", topic)) {
        return {
          action: "review",
          guidance: `所有 Wave 已 committed。下一步：做 code review（审查代码质量 + 逐条核对 plan changes），产出 review.md 后调 cw(review)。\n\n${REVIEW_PROMPT}`,
          waves: waveProgress(topic),
          alternatives: [replanAlternative()],
        };
      }
      return {
        action: "dev",
        guidance: `dev 阶段进行中，仍有 Wave 未 committed。继续实现 + commit + 调 cw(dev)。\n\n${EXECUTE_PROMPT}`,
        waves: waveProgress(topic),
        alternatives: [replanAlternative()],
      };
    }
    case "review": {
      // review gate 语义变了：看 reviewIssues（而非纯 gateHistory）。
      //   - fileExistsCheck fail（reviewPath 提供但文件不存在）→ gate fail retry（见下）
      //   - issues 为空（无问题）→ gate pass → test
      //   - issues 非空（有发现）：
      //     reviewTurn < LIMIT → review_fix
      //     reviewTurn >= LIMIT → test（强制进 test，guidance 标注未闭环的 must-fix）
      //
      // 检测 reviewPath 前置条件失败：最近的 review phase gate 记录为 fail（file-exists+non-empty）。
      const reviewFails = countConsecutiveGateFails(topic.gateHistory, "review");
      const lastReviewGate =
        topic.gateHistory[topic.gateHistory.length - 1];
      const isReviewFileFail =
        reviewFails > 0 &&
        lastReviewGate?.phase === "review" &&
        lastReviewGate?.gate === "file-exists+non-empty" &&
        lastReviewGate?.result === "fail";
      if (isReviewFileFail) {
        return {
          action: "review",
          guidance:
            reviewFails >= GATE_RETRY_LIMIT
              ? buildCircuitBreakerGuidance("review", reviewFails)
              : `review gate FAIL（reviewPath 文件不存在或为空）。修 mustFix 后重调 cw(review)。\n\n${REVIEW_PROMPT}`,
        };
      }

      const openIssues = topic.reviewIssues.filter((i) => i.status === "open");
      const mustFixCount = topic.reviewIssues.filter(
        (i) => i.severity === "must-fix" && i.status === "open",
      ).length;
      const hasOpenIssues = openIssues.length > 0;
      const overLimit = topic.reviewTurn >= REVIEW_TURN_LIMIT;

      if (!hasOpenIssues) {
        // 无 open issue（issues 为空或全已 fixed）→ gate pass → test。
        return {
          action: "test",
          guidance: `review gate 通过（无 open issue）。下一步：跑全部 testCase，调 cw(test) 提交 actual/screenshotPath。\n\n${EXECUTE_PROMPT}`,
          testCases: testCaseProgress(topic),
          alternatives: [replanAlternative()],
        };
      }

      if (overLimit) {
        // 达上限：强制进 test，guidance 标注未闭环的 must-fix。
        return {
          action: "test",
          guidance:
            `review 已达 ${REVIEW_TURN_LIMIT} 轮上限（当前 turn=${topic.reviewTurn}），强制进 test。` +
            `${mustFixCount} 个 must-fix 未修复。建议 ask_user 人工审查或调 cw(replan)。\n\n${EXECUTE_PROMPT}`,
          testCases: testCaseProgress(topic),
          alternatives: [replanAlternative()],
        };
      }

      // 有 open issue 且未达上限 → review_fix。
      const reviewSpecNote =
        topic.specSections.length > 0
          ? `\n\n注意：核对 spec 的 FR/AC 是否被正确实现（dimension=design-consistency）。`
          : "";
      return {
        action: "review_fix",
        guidance: `review 发现 ${openIssues.length} 个 open issue（${mustFixCount} 个 must-fix）。` +
          `下一步：逐条修 issue 并 commit，调 cw(review_fix) 提交 fixes（issueId + commitHash + resolution）。\n\n${REVIEW_PROMPT}` +
          reviewSpecNote,
      };
    }
    case "review_fix": {
      // review_fix：review loop 内的修复动作（status 留在 reviewed）。
      // 修完 issue 后应重新 review（下一轮），若已达 review 轮数上限则告警。
      const turn = topic.reviewTurn;
      const overLimit = turn >= REVIEW_TURN_LIMIT;
      return {
        action: "review",
        guidance: overLimit
          ? `review 已达 ${REVIEW_TURN_LIMIT} 轮上限（当前 turn=${turn}）。建议 ask_user 人工介入审查，或调 cw(replan) 调整计划。`
          : `review_fix 完成（第 ${turn} 轮）。下一步：重新调 cw(review) 开启下一轮审查，确认所有 issue 已闭环。\n\n${REVIEW_PROMPT}`,
        alternatives: overLimit ? [replanAlternative()] : undefined,
      };
    }
    case "test": {
      if (computeGatePassed("test", topic)) {
        return {
          action: "retrospect",
          guidance:
            `所有 testCase 已 passed。下一步：写复盘报告（retrospect.md）+ 结构化 retrospectData，完成后调 cw(retrospect) 提交。\n\n${RETROSPECT_PROMPT}`,
          alternatives: [replanAlternative()],
        };
      }
      // test 有 case 未通过。
      const failedCount = topic.testCases.filter(
        (c) => c.status !== "passed",
      ).length;
      const overLimit = topic.testTurn >= TEST_TURN_LIMIT;
      if (overLimit) {
        // 达上限：强制进 retrospect（与 review overLimit 强制进 test 对称）。
        // 打破 test↔test_fix 死循环：blind .action follower 不会永久振荡。
        // retrospect gate 只验文件存在性，不查 testCases 全 pass，所以带失败 case 进复盘合法。
        // retrospect 正是"复盘为什么没过 + 记录 knownRisks"的场所。
        const passedCount = topic.testCases.filter((c) => c.status === "passed").length;
        const coveragePct = topic.testCases.length > 0
          ? Math.round((passedCount / topic.testCases.length) * 100)
          : 0;
        // 逃生阀可被 test_fix 刷满 testTurn 但无 case 真正 passed（coverage=0%），此时补告警。
        const lowCoverageWarning = coveragePct < 50
          ? `\n⚠️ 当前 coverage=${coveragePct}%（${passedCount}/${topic.testCases.length}），建议 ask_user 人工审查或调 cw(replan) 重新评估，而非带极低覆盖率进 closeout。`
          : "";
        return {
          action: "retrospect",
          guidance:
            `test 已达 ${TEST_TURN_LIMIT} 轮上限（当前 turn=${topic.testTurn}），` +
            `${failedCount} 个 case 仍未通过。强制进复盘阶段——在 retrospect 中记录未通过原因和 knownRisks，` +
            `由用户决定是否接受或调 cw(replan) 调整计划。\n` +
            `注意：可带未全过的 test case 进入 closeout，closeout 的 coverage（通过率 = passed/total）会如实记录到 evidence，不强制 100% passed。` +
            lowCoverageWarning +
            `\n\n${RETROSPECT_PROMPT}`,
          testCases: testCaseProgress(topic),
          alternatives: [replanAlternative()],
        };
      }
      // 未达上限 → 进 test_fix loop。
      return {
        action: "test_fix",
        guidance: `test 有 ${failedCount} 个 case 未通过。下一步：修代码 + commit，调 cw(test_fix) 提交 fixes（caseId + commitHash + resolution），再重跑 test。\n\n${EXECUTE_PROMPT}`,
        testCases: testCaseProgress(topic),
        alternatives: [replanAlternative()],
      };
    }
    case "test_fix": {
      // test_fix：test loop 内的修复动作（status 留在 tested），审计日志由 store.appendTestFix 追加。
      // 修完代码后应重新跑 test。
      // testTurn 在 handleTestFix 里已 inc，达上限时 test 分支会强制进 retrospect。
      const turn = topic.testTurn;
      return {
        action: "test",
        guidance: `test_fix 完成（第 ${turn} 轮）。下一步：重新跑全部 testCase，调 cw(test) 提交 actual/screenshotPath。\n\n${EXECUTE_PROMPT}`,
        alternatives: [replanAlternative()],
      };
    }
    case "retrospect": {
      if (!computeGatePassed("retrospect", topic)) {
        const fails = countConsecutiveGateFails(topic.gateHistory, "retrospect");
        return {
          action: "retrospect",
          guidance:
            fails >= GATE_RETRY_LIMIT
              ? buildCircuitBreakerGuidance("retrospect", fails)
              : `retrospect gate FAIL。修 mustFix 后重调 cw(retrospect)。\n\n${RETROSPECT_PROMPT}`,
        };
      }
      // 检查未闭环的 should-fix/nit（status=open 的非 must-fix issue），提醒 retrospect 记录。
      const openNonMustFix = topic.reviewIssues.filter(
        (i) => i.status === "open" && i.severity !== "must-fix",
      );
      const unclosedNote =
        openNonMustFix.length > 0
          ? `\n\n注意：有 ${openNonMustFix.length} 个未闭环的 should-fix/nit issue（status=open）。` +
            `在 retrospect 的 processIssues 里记录「哪些被有意跳过及原因」，避免静默遗忘。`
          : "";
      return {
        action: "closeout",
        guidance:
          "retrospect gate 通过。下一步：调 cw(closeout) 归档 topic。\n\ncloseout gate 检查项：topic 目录（.xyz-harness/<slug>/）存在。retrospect.md 已在里面所以会自动通过。" +
          unclosedNote,
      };
    }
    case "closeout": {
      if (!computeGatePassed("closeout", topic)) {
        const fails = countConsecutiveGateFails(topic.gateHistory, "closeout");
        return {
          action: "closeout",
          guidance:
            fails >= GATE_RETRY_LIMIT
              ? buildCircuitBreakerGuidance("closeout", fails)
              : "closeout gate FAIL。修 mustFix 后重调 cw(closeout)。",
        };
      }
      return {
        guidance:
          "topic 已关闭。本次编码流程结束。\n\n" +
          "可调 cw report --topicId <topicId> 生成可视化执行报告（HTML），展示 wave 变更、" +
          "测试矩阵、gate 轨迹、复盘结论等。建议向用户提问是否需要查看报告——如需，" +
          "调 cw report 拿到 reportPath 后用 open 命令在浏览器打开。\n\n" +
          "交付后如发现质量问题，可调 cw assess 记录评估数据（quality/test/stability/defect），" +
          "用于校准 review 召回率和交付质量趋势。详见 SKILL.md「post-closeout 评估（assess）」。",
      };
    }
    case "replan": {
      // D7: replan 的下一步取决于 handler 设的 status。
      // status=planned（hasPlan，plan 改了）→ plan_review（重审新 plan）
      // status=plan_reviewed（hasTest only，plan 没变）→ tdd_plan（重走测试）
      if (topic.status === "plan_reviewed") {
        return {
          action: "tdd_plan",
          guidance: `replan 完成（仅修改 testCases）。plan 未变，直接重走 tdd_plan。\n\n${TDD_PLAN_PROMPT}`,
          waves: waveProgress(topic),
          testCases: testCaseProgress(topic),
        };
      }
      return {
        action: "plan_review",
        guidance: `replan 完成（plan 已修改）。需重走 plan_review 审查新 plan。\n\n${PLAN_REVIEW_PROMPT}`,
        waves: waveProgress(topic),
        testCases: testCaseProgress(topic),
      };
    }
    case "assess": {
      // assess 不进 guidance 主链路——它是 post-closeout 人工触发的评估，不导航到下一阶段。
      // status 始终为 closed（progressive），guidance 仅提示评估已记录。
      return {
        guidance:
          "评估已记录。topic 保持 closed，可继续调 cw(assess) 追加更多评估（progressive）。",
      };
    }
    case "abort": {
      // FR-3: abort 后 aborted 终态，action 为空（流程结束）。
      return {
        guidance:
          "topic 已终止（aborted）。该 topic 不会计入 stats 聚合。\n" +
          "如需重新开发，请 cw create 新建 topic。",
      };
    }
    default: {
      // 穷尽性检查 + 终态兜底
      const _exhaustive: never = action;
      void _exhaustive;
      return { guidance: "" };
    }
  }
}

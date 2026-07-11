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
 * - gate 熔断不阻断只告警：连续 fail 达阈值后 nextAction guidance 换熔断文案。
 */

import type {
  Action,
  GateHistoryEntry,
  GuardVerdict,
  NextAction,
  Status,
  Topic,
} from "./types.js";
import { SPEC_PROMPT, PLAN_PROMPT, EXECUTE_PROMPT } from "./prompts/index.js";

// ── gate 熔断 ──────────────────────────────────────────────

/** 连续 gate fail 达此阈值后，nextAction guidance 换熔断文案（不阻断，只告警）。 */
const GATE_RETRY_LIMIT = 5;

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
 * 7 个 action 的转换规则（lite 单轨）。
 *
 * replan 只允许在 planned/developed 调用（dev 阶段追加 wave），
 * nextStatus 回退到 planned。progressive=true 使其在 developed 调用时
 * 仍回退 planned（replan 后必须重新走 dev）——这是「回退」而非「原地停留」，
 * 所以 progressive 标记在这里不触发原地停留（current 不会 === nextStatus）。
 */
export const TRANSITIONS: Record<Action, TransitionRule> = {
  create: { expectedStatuses: [], nextStatus: "created" },
  plan: { expectedStatuses: ["created"], nextStatus: "planned" },
  dev: {
    expectedStatuses: ["planned", "developed"],
    nextStatus: "developed",
    progressive: true,
  },
  test: {
    expectedStatuses: ["developed", "tested"],
    nextStatus: "tested",
    progressive: true,
  },
  retrospect: { expectedStatuses: ["tested"], nextStatus: "retrospected" },
  closeout: { expectedStatuses: ["retrospected"], nextStatus: "closed" },
  replan: { expectedStatuses: ["planned", "developed"], nextStatus: "planned" },
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
 * 注意：replan 虽标 progressive，但 nextStatus=planned，
 * 调用 replan 时 current∈{planned, developed}，不会 === nextStatus(=planned)
 * 当 current=developed 时（developed !== planned），所以 replan 总会回退到 planned——
 * 这正是 replan 的语义（追加 wave 后重新走 dev）。progressive 标记对 replan 无实际效果，
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
 *   - single-shot（plan/retrospect/closeout）：gateHistory 有该 phase 的 pass 记录
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
      // create 后进入 spec 阶段：先明确范围与目标，再写 plan。
      return {
        action: "plan",
        guidance: `topic 已建立。下一步：明确任务范围与目标，完成后调 cw(plan) 提交 plan.json。\n\n${SPEC_PROMPT}`,
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
              : `plan gate FAIL。status 仍为 created——修 mustFix 后重调 cw(plan)。\n\n${PLAN_PROMPT}`,
        };
      }
      return {
        action: "dev",
        guidance: `plan gate 通过。下一步：按 Wave 实现 + TDD，commit 后调 cw(dev)。\n\n${EXECUTE_PROMPT}`,
        waves: waveProgress(topic),
      };
    }
    case "dev": {
      if (computeGatePassed("dev", topic)) {
        return {
          action: "test",
          guidance: `所有 Wave 已 committed。下一步：跑全部 testCase，调 cw(test) 提交 actual/screenshotPath。\n\n${EXECUTE_PROMPT}`,
          waves: waveProgress(topic),
          testCases: testCaseProgress(topic),
        };
      }
      return {
        action: "dev",
        guidance: `dev 阶段进行中，仍有 Wave 未 committed。继续实现 + commit + 调 cw(dev)。\n\n${EXECUTE_PROMPT}`,
        waves: waveProgress(topic),
      };
    }
    case "test": {
      if (computeGatePassed("test", topic)) {
        return {
          action: "retrospect",
          guidance:
            "所有 testCase 已 passed。下一步：写复盘报告（retrospect.md），完成后调 cw(retrospect) 提交路径。",
        };
      }
      return {
        action: "test",
        guidance: `test 阶段进行中，仍有 testCase 未 passed。继续跑剩余 testCase + 调 cw(test)。\n\n${EXECUTE_PROMPT}`,
        testCases: testCaseProgress(topic),
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
              : "retrospect gate FAIL。修 mustFix 后重调 cw(retrospect)。",
        };
      }
      return {
        action: "closeout",
        guidance:
          "retrospect gate 通过。下一步：沉淀长期文档（如需），完成后调 cw(closeout) 归档 topic。",
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
        guidance: "topic 已关闭（closed）。本次编码流程结束。",
      };
    }
    case "replan": {
      // replan 完成后，按 dev gate 是否通过分流。
      // 通常 replan 追加新 wave 后 dev gate 会变 false（新 wave 未 committed）→ 指向 dev。
      if (!computeGatePassed("dev", topic)) {
        return {
          action: "dev",
          guidance: `replan 完成。下一步：实现新 wave + commit + 调 cw(dev)。\n\n${EXECUTE_PROMPT}`,
          waves: waveProgress(topic),
        };
      }
      return {
        action: "test",
        guidance: `replan 完成。dev gate 通过，下一步：跑测试 + 调 cw(test)。\n\n${EXECUTE_PROMPT}`,
        testCases: testCaseProgress(topic),
      };
    }
  }
}

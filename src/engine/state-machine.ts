/**
 * CW 状态机（骨架 stub）：声明式转换表 + 三重 guard + nextAction 组装。
 *
 * Level 1 接线：
 *   - guard → 三重串行调用（checkLinear → checkPhaseCascade → checkCacheConsistency）
 *   - buildNextAction → switch 分支调 computeGatePassed/waveProgress/testCaseProgress
 *   - computeNextStatus → progressive 判断
 *
 * 叶子逻辑：各 guard 函数内部的判定逻辑（TRANSITIONS 查询、gatePassed 计算）。
 */

import type { CwStore } from "./store.js";
import type {
  CwAction,
  CwStatus,
  CwTopic,
  GateHistoryEntry,
  GuardVerdict,
  NextAction,
} from "./types.js";

// ── gate 熔断 ──────────────────────────────────────────────

const GATE_RETRY_LIMIT = 5;

function countConsecutiveGateFails(history: GateHistoryEntry[], phase: CwAction): number {
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

function buildCircuitBreakerGuidance(phase: CwAction, fails: number): string {
  return (
    `${phase} gate 已连续失败 ${fails} 次（达熔断阈值 ${GATE_RETRY_LIMIT}）。` +
    `可能存在机器检查误判。建议：(1) 逐条检查 mustFix 报错是否合理 (2) ask_user 人工审查交付物。`
  );
}

// ── 声明式转换表 ────────────────────────────────────────────

export interface TransitionRule {
  expectedStatuses: CwStatus[];
  nextStatus: CwStatus;
  progressive?: boolean;
  requirePhaseComplete?: CwAction;
}

export const TRANSITIONS: Partial<Record<CwAction, TransitionRule>> = {
  create: { expectedStatuses: [], nextStatus: "created" },
  plan: { expectedStatuses: ["created"], nextStatus: "planned" },
  clarify: { expectedStatuses: ["created"], nextStatus: "clarified" },
  detail: { expectedStatuses: ["clarified"], nextStatus: "detailed" },
  dev: {
    expectedStatuses: ["planned", "detailed", "developed"],
    nextStatus: "developed",
    progressive: true,
  },
  test: {
    expectedStatuses: ["developed", "tested"],
    nextStatus: "tested",
    progressive: true,
    requirePhaseComplete: "dev",
  },
  retrospect: {
    expectedStatuses: ["tested", "retrospected"],
    nextStatus: "retrospected",
    progressive: true,
    requirePhaseComplete: "test",
  },
  closeout: { expectedStatuses: ["retrospected"], nextStatus: "closed" },
  replan: {
    expectedStatuses: ["planned", "developed"],
    nextStatus: "planned",
    progressive: true,
  },
};

// ── 三重 guard ───────────────────────────────────────────────

/**
 * 第一重：线性 expectedStatus 校验。
 * 接线：查 TRANSITIONS 表，比对 current status。
 */
export function checkLinear(
  action: CwAction,
  current: CwStatus | undefined,
): GuardVerdict {
  const rule = TRANSITIONS[action];
  if (!rule) {
    return { ok: false, code: "illegal_transition", reason: `unknown action: ${action}` };
  }
  if (action === "create") {
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
 * 第二重：跨阶段 gatePassed 级联。
 * 接线：查 requirePhaseComplete，调 computeGatePassed。
 */
export function checkPhaseCascade(action: CwAction, topic: CwTopic): GuardVerdict {
  const rule = TRANSITIONS[action];
  if (!rule?.requirePhaseComplete) {
    return { ok: true };
  }
  const required = rule.requirePhaseComplete;
  const passed = computeGatePassed(required, topic);
  if (!passed) {
    return {
      ok: false,
      code: "phase_incomplete",
      reason: `${action} requires phase "${required}" complete (gatePassed), still pending`,
    };
  }
  return { ok: true };
}

/**
 * 第三重：缓存一致性 self-check。
 * 接线：遍历 gatePassed 缓存，调 computeGatePassed 重算比对。
 */
export function checkCacheConsistency(topic: CwTopic, store: CwStore): GuardVerdict {
  // 接线：遍历 topic.gatePassed，重算比对。
  // store 参数当前 void（不重新 loadTopic），留未来扩展。
  void store;
  for (const phase of Object.keys(topic.gatePassed) as CwAction[]) {
    const cached = topic.gatePassed[phase];
    const recomputed = computeGatePassed(phase, topic);
    if (cached !== recomputed) {
      return {
        ok: false,
        code: "cache_inconsistent",
        reason: `phase ${phase}: cached=${String(cached)} !== recomputed=${String(recomputed)}`,
      };
    }
  }
  return { ok: true };
}

/**
 * guard — 三重串行调用，fail 短路返回。
 * Level 1 接线：串行调用 checkLinear → checkPhaseCascade → checkCacheConsistency。
 */
export function guard(
  action: CwAction,
  topic: CwTopic | null,
  store: CwStore,
): GuardVerdict {
  const linear = checkLinear(action, topic?.status);
  if (!linear.ok) {
    return linear;
  }
  if (action === "create") {
    return { ok: true };
  }
  if (!topic) {
    return { ok: false, code: "illegal_transition", reason: "topic required" };
  }
  const cascade = checkPhaseCascade(action, topic);
  if (!cascade.ok) {
    return cascade;
  }
  const cache = checkCacheConsistency(topic, store);
  if (!cache.ok) {
    return cache;
  }
  return { ok: true };
}

// ── 状态流转 ─────────────────────────────────────────────────

/**
 * 计算流转后状态（progressive 已处 nextStatus 时原地停留）。
 * 接线：查 TRANSITIONS + progressive 判断。
 */
export function computeNextStatus(action: CwAction, current: CwStatus): CwStatus {
  const rule = TRANSITIONS[action];
  if (!rule) {
    throw new Error(`unknown action: ${action}`);
  }
  if (rule.progressive && current === rule.nextStatus) {
    return current;
  }
  return rule.nextStatus;
}

// ── gatePassed 计算 ──────────────────────────────────────────

/**
 * 从 topic 逻辑模型算 phase 是否完成。
 *
 * 完成语义：
 *   - dev：全 Wave committed（≥1 个且全部 committed）
 *   - test：全 testCase passed（≥1 个且全部 passed）
 *   - single-shot：gateHistory 有该 phase 的 pass 记录
 *   - create：永远 false
 */
export function computeGatePassed(phase: CwAction, topic: CwTopic): boolean {
  if (phase === "dev") {
    return topic.waves.length > 0 && topic.waves.every((w) => w.committed !== null);
  }
  if (phase === "test") {
    return (
      topic.testCases.length > 0 && topic.testCases.every((c) => c.status === "passed")
    );
  }
  return topic.gateHistory.some((e) => e.phase === phase && e.result === "pass");
}

// ── nextAction 组装 ──────────────────────────────────────────

function waveProgress(topic: CwTopic): NextAction["waves"] {
  return topic.waves.map((w) => ({ id: w.id, committed: w.committed !== null }));
}

function testCaseProgress(topic: CwTopic): NextAction["testCases"] {
  return topic.testCases.map((c) => ({ id: c.id, status: c.status }));
}

/**
 * buildNextAction — 按 tier + action + gatePassed 推 nextAction。
 * Level 1 接线：switch 分支，每分支调 computeGatePassed + waveProgress/testCaseProgress。
 */
export function buildNextAction(action: CwAction, topic: CwTopic): NextAction {
  switch (action) {
    case "create": {
      if (topic.tier === "lite") {
        return {
          action: "plan",
          skill: "lite-plan",
          guidance: "topic 已建立（tier=lite）。下一步：调 lite-plan skill 产出 plan.json，完成后调 cw plan 提交。",
        };
      }
      return {
        action: "clarify",
        skill: "mid-plan",
        guidance: "topic 已建立（tier=mid）。下一步：调 mid-plan skill 产出 clarify.json，完成后调 cw clarify 提交。",
      };
    }
    case "plan": {
      if (!computeGatePassed("plan", topic)) {
        const fails = countConsecutiveGateFails(topic.gateHistory, "plan");
        return {
          action: "plan",
          skill: "lite-plan",
          guidance: fails >= GATE_RETRY_LIMIT
            ? buildCircuitBreakerGuidance("plan", fails)
            : "plan gate FAIL。status 仍为 created——修 mustFix 后重调 cw(plan)。",
        };
      }
      return {
        action: "dev",
        skill: "coding-execute",
        guidance: "plan gate 通过。下一步：调 coding-execute skill 按 Wave 执行，commit 后调 cw dev。",
        waves: waveProgress(topic),
      };
    }
    case "clarify": {
      if (!computeGatePassed("clarify", topic)) {
        const fails = countConsecutiveGateFails(topic.gateHistory, "clarify");
        return {
          action: "clarify",
          skill: "mid-plan",
          guidance: fails >= GATE_RETRY_LIMIT
            ? buildCircuitBreakerGuidance("clarify", fails)
            : "clarify gate FAIL。修 mustFix 后重调 cw(clarify)。",
        };
      }
      return {
        action: "detail",
        skill: "mid-detail-plan",
        guidance: "clarify gate 通过。下一步：调 mid-detail-plan skill 产出 detail.json。",
      };
    }
    case "detail": {
      if (!computeGatePassed("detail", topic)) {
        const fails = countConsecutiveGateFails(topic.gateHistory, "detail");
        return {
          action: "detail",
          skill: "mid-detail-plan",
          guidance: fails >= GATE_RETRY_LIMIT
            ? buildCircuitBreakerGuidance("detail", fails)
            : "detail gate FAIL。修 mustFix 后重调 cw(detail)。",
        };
      }
      return {
        action: "dev",
        skill: "coding-execute",
        guidance: "detail gate 通过。下一步：调 coding-execute skill 按 Wave 执行。",
        waves: waveProgress(topic),
      };
    }
    case "dev": {
      if (computeGatePassed("dev", topic)) {
        return {
          action: "test",
          skill: "coding-execute",
          guidance: topic.tier === "lite"
            ? "所有 Wave 已 committed。下一步：调 coding-execute 派发 test-runner，跑完调 cw test 提交 actual/screenshotPath。"
            : "所有 Wave 已 committed。下一步：调 coding-execute 派发 test-runner，跑完调 cw test 提交 commitHash/claimedStatus。",
          waves: waveProgress(topic),
          testCases: testCaseProgress(topic),
        };
      }
      return {
        action: "dev",
        skill: "coding-execute",
        guidance: "dev 阶段进行中，仍有 Wave 未 committed。继续调 cw dev。",
        waves: waveProgress(topic),
      };
    }
    case "test": {
      if (computeGatePassed("test", topic)) {
        return {
          action: "retrospect",
          skill: "coding-retrospect",
          guidance: "所有 testCase 已 passed。下一步：调 coding-retrospect skill 产出复盘报告。",
        };
      }
      return {
        action: "test",
        skill: "coding-execute",
        guidance: "test 阶段进行中，仍有 testCase 未 passed。继续执行剩余 testCase。",
        testCases: testCaseProgress(topic),
      };
    }
    case "retrospect": {
      if (!computeGatePassed("retrospect", topic)) {
        const fails = countConsecutiveGateFails(topic.gateHistory, "retrospect");
        return {
          action: "retrospect",
          skill: "coding-retrospect",
          guidance: fails >= GATE_RETRY_LIMIT
            ? buildCircuitBreakerGuidance("retrospect", fails)
            : "retrospect gate FAIL。修 mustFix 后重调 cw(retrospect)。",
        };
      }
      return {
        action: "closeout",
        skill: "coding-closeout",
        guidance: "retrospect gate 通过。下一步：调 coding-closeout skill 归档。",
      };
    }
    case "closeout": {
      if (!computeGatePassed("closeout", topic)) {
        const fails = countConsecutiveGateFails(topic.gateHistory, "closeout");
        return {
          action: "closeout",
          skill: "coding-closeout",
          guidance: fails >= GATE_RETRY_LIMIT
            ? buildCircuitBreakerGuidance("closeout", fails)
            : "closeout gate FAIL。修 mustFix 后重调 cw(closeout)。",
        };
      }
      return {
        guidance: "topic 已关闭（closed）。本次编码流程结束。",
      };
    }
    case "replan": {
      if (!computeGatePassed("dev", topic)) {
        return {
          action: "dev",
          skill: "coding-execute",
          guidance: "replan 完成。下一步：调 cw(dev) 提交新 wave commit。",
          waves: waveProgress(topic),
        };
      }
      return {
        action: "test",
        skill: "coding-execute",
        guidance: "replan 完成。dev gate 通过，下一步：调 cw(test) 跑测试。",
        testCases: testCaseProgress(topic),
      };
    }
  }
}

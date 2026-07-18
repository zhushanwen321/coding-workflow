/**
 * TddVerificationStrategy —— full-tdd shape 的验证策略实现。
 *
 * 把现有散落在 gate.ts / actions.ts / state-machine.ts 里的 TDD 判定逻辑，
 * 用 VerificationStrategy 接口包装成可路由的策略对象。state-machine / actions
 * 通过 topic.taskShape 拿到策略实例后调对应方法，不再硬编码 TDD 分支。
 *
 * 方法映射（W2 阶段仅 preDevCheck + isDevVerified 完整实现并被测）：
 *   - preDevCheck → tddPlanCheck（透传，等价性由 shapes-tdd-strategy.test.ts 锁定）
 *   - postDevVerify → W4 抽取 handleTest 内联逻辑后补全（当前占位返回空）
 *   - replanGuard → validateAppendOnly（适配 2-arg 策略签名到 4-arg 原始签名）
 *   - isDevVerified → computeGatePassed("test") 的等价逻辑（testCases 全 passed）
 */

import type {
  VerificationStrategy,
  GateResult,
  VerifyResult,
  Violation,
} from "./types.js";
import type { Topic } from "../types.js";
import type { TestCaseSeed, WaveSeed } from "../types.js";
import { tddPlanCheck } from "../gate.js";
import { validateAppendOnly, type AppendOnlyViolation } from "../actions.js";

export class TddVerificationStrategy implements VerificationStrategy {
  readonly id = "tdd";
  readonly preDevGateName = "test-json-schema";
  readonly postDevGateName = "test-runner";

  preDevCheck(topic: Topic, payload: unknown): GateResult {
    // 原样透传 tddPlanCheck——签名 (testJson, specSections, workspacePath)。
    // 等价性（result/parsed/report 关键词与 tddPlanCheck 直调一致）由
    // shapes-tdd-strategy.test.ts AC-5 锁定。
    return tddPlanCheck(payload, topic.specSections, topic.workspacePath);
  }

  postDevVerify(_topic: Topic): VerifyResult[] {
    // W2 占位：postDevVerify 封装的是 handleTest 内联的「执行测试 + judgeByExpected
    // 判定」逻辑，真正抽取是 W4 的事（需把 actions.ts handleTest 的 ~200 行
    // exit_zero/script 执行 + actual 重算拆出来）。W2 测试（shapes-tdd-strategy.test.ts）
    // 不覆盖 postDevVerify，先返回空数组。
    //
    // W4 补全后，这里应返回每个 case 的 { caseId, passed, actual, failureReason }。
    return [];
  }

  replanGuard(oldTopic: Topic, newPayload: unknown): Violation[] {
    // 适配：策略接口是 (oldTopic, newPayload)，原始 validateAppendOnly 是
    // (newWaves, newCases, oldWaves, oldTestCases)。从 newPayload 防御性提取
    // waves/testCases（replan 的 plan.json / test.json 形态），oldWaves/oldTestCases
    // 从 oldTopic 取。提取失败（payload 结构不符）时传空数组——validateAppendOnly
    // 空入参不产生违规，安全降级。
    const { newWaves, newCases } = extractReplanInputs(newPayload);
    const rawViolations = validateAppendOnly(
      newWaves,
      newCases,
      oldTopic.waves,
      oldTopic.testCases,
    );
    return rawViolations.map(toViolation);
  }

  isDevVerified(topic: Topic): boolean {
    // 等价于 state-machine.ts computeGatePassed("test", topic)：
    // testCases 非空且全 passed。空 testCases → false（没测 = 未验证）。
    return (
      topic.testCases.length > 0 &&
      topic.testCases.every((c) => c.status === "passed")
    );
  }
}

/**
 * 从 replan 的 newPayload 防御性提取 newWaves / newCases。
 *
 * payload 在 replan 场景是 plan.json 或 test.json 原始内容（parse 前的 unknown）：
 *   - plan.json：{ waves: WaveSeed[], legacyTestCases?: TestCaseSeed[] }
 *   - test.json：{ testCases: TestCaseSeed[] }
 *   - 混合：--test 模式只校验 testCases，waves 传空跳过 wave 校验
 *
 * 结构不符时返回空——validateAppendOnly 空入参不产生违规，安全降级（W3/W4 接入
 * 实际 replan 路径时若需要更严格的结构校验再补）。
 */
function extractReplanInputs(payload: unknown): {
  newWaves: WaveSeed[];
  newCases: TestCaseSeed[];
} {
  if (typeof payload !== "object" || payload === null) {
    return { newWaves: [], newCases: [] };
  }
  const obj = payload as Record<string, unknown>;
  const waves = Array.isArray(obj.waves) ? (obj.waves as WaveSeed[]) : [];
  const testCases = Array.isArray(obj.testCases)
    ? (obj.testCases as TestCaseSeed[])
    : Array.isArray(obj.legacyTestCases)
      ? (obj.legacyTestCases as TestCaseSeed[])
      : [];
  return { newWaves: waves, newCases: testCases };
}

/** AppendOnlyViolation → Violation 适配（字段对齐：type/reason 直传，caseId/waveId 按 type 填）。 */
function toViolation(v: AppendOnlyViolation): Violation {
  return {
    type: v.type,
    caseId: "caseId" in v ? v.caseId : undefined,
    waveId: "waveId" in v ? v.waveId : undefined,
    reason: v.reason,
  };
}

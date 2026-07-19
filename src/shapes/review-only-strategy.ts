/**
 * ReviewOnlyVerificationStrategy —— doc-only shape 的验证策略实现。
 *
 * 纯文档任务（写 ADR / 写 README / 迁移文档）没有可机器验证的产物——无测试、无文件
 * 存在性约束。验证完全靠人工 review，所以 verification 的所有方法都是 no-op / 恒 pass：
 *   - preDevCheck：恒 pass（不要求 test.json / existence.json）
 *   - postDevVerify：返回空数组（无可机器验证的产物）
 *   - isDevVerified：恒 true（机器验证非其职责，test gate 视为天然通过）
 *   - applyPreDevResult / replanGuard：no-op / 返回空
 *
 * 流程上 dev → review → test → closeout 仍走，但 test gate 不做机器校验——
 * 避免文档任务卡在「无 testCase = isDevVerified=false」的死锁（full-tdd 的 isDevVerified
 * 要求 testCases 非空且全 passed，doc-only 没有 testCase 会永远 false）。
 */

import type { Topic } from "../types.js";
import type {
  ApplyPreDevResultStore,
  GateResult,
  VerificationStrategy,
  VerifyResult,
  Violation,
} from "./types.js";

export class ReviewOnlyVerificationStrategy implements VerificationStrategy {
  readonly id = "review-only";
  readonly preDevGateName = "review-only-noop";
  readonly postDevGateName = "review-only-noop";

  preDevCheck(_topic: Topic, _payload: unknown): GateResult {
    // 恒 pass：doc-only 不要求任何 dev 前 payload（无 test.json / existence.json）。
    // parsed 给空对象——applyPreDevResult 是 no-op，不消费 parsed。
    return {
      result: "pass",
      report: "review-only 策略无需 dev 前验证（纯文档任务，验证靠人工 review）。",
      parsed: {},
    };
  }

  applyPreDevResult(
    _topicId: string,
    _store: ApplyPreDevResultStore,
    _parsed: unknown,
  ): void {
    // no-op：review-only 不预置任何状态（无 testCases / existenceArtifacts）。
    // 显式不触碰 store——避免误调 insertTestCases/setExistenceArtifacts 污染 topic。
  }

  postDevVerify(_topic: Topic): VerifyResult[] {
    // 返回空数组：无可机器验证的产物。handleTest 对空 results 视为「无 case 需判定」，
    // 直接走 isDevVerified（恒 true）→ test gate pass。
    return [];
  }

  isDevVerified(_topic: Topic): boolean {
    // 恒 true：机器验证非 review-only 职责。即使 topic 带 testCases（误用）也视为 verified——
    // test gate 的判定权完全交给后续的人工 review（review 阶段会审）。
    return true;
  }

  replanGuard(_oldTopic: Topic, _newPayload: unknown): Violation[] {
    // 返回空：review-only 无可保护的已验证产物（不验存在性、不验测试）。
    return [];
  }
}

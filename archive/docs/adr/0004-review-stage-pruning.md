# ADR-0004：Review 阶段裁剪机制——扩展 expectedStatuses + guidance 分流

**Date**: 2026-07-18
**Status**: Accepted
**Topic**: cw-2026-07-18-step4-review-stage-pruning

## Context

方案 B 步骤 4。需要让 delete-only/doc-only 两种 TaskShape 跳过 spec_review/plan_review 阶段（它们的 ReviewStagePolicy.stages 声明为 `["review"]`）。

核心约束：TRANSITIONS 是全局静态表（`Record<Action, TransitionRule>`），`checkLinear(action, status)` 只接 action + status，**不接 topic 参数**。guard 是单重防线（CW 核心约定），gate 层 computeGatePassed 兜底。

## Decision

采用**扩展 expectedStatuses + guidance 分流**：

1. `TRANSITIONS.plan.expectedStatuses` 加 `"clarify_confirmed"`
2. `TRANSITIONS.tdd_plan.expectedStatuses` 加 `"planned"`
3. `checkLinear` 签名不改
4. `buildNextAction` 按 `getShape(topic.taskShape).review.stages` 分流 guidance——裁剪 shape 的 confirm_clarify pass 直接推 plan（不推 spec_review），plan pass 直接推 tdd_plan（不推 plan_review）

**agent 不感知裁剪**：guidance 是唯一导航，agent 跟 `nextAction.action` 走即可。

## Alternatives Considered

### 方案 B：checkLinear 接 topic 参数

改 `checkLinear(action, status)` → `checkLinear(action, status, topic)`，按 taskShape 动态判定 expectedStatuses。

**否决原因**：guard 是状态机核心，改签名影响所有调用点（guard()、所有测试）。语义最显式但侵入大，且违反"guard 只做线性 status 校验"的分层职责。gate 层兜底已足够防跳步。

### 方案 C：新增 skip action

加 `cw(skip_spec_review)` / `cw(skip_plan_review)`，agent 显式跳过。

**否决原因**：增加流程复杂度，agent 要多学两个 action。违反"agent 不感知 shape 差异"的设计目标——裁剪应该是 guidance 自动引导，不是 agent 显式决策。

## Consequences

**正面**：
- checkLinear 不改，guard 层零侵入
- 扩展 expectedStatuses 只放宽不收紧，full-tdd 路径完全不受影响
- guidance 分流与现有 getPreDevGuidance 模式一致（同一抽象层次）
- agent 跟着 guidance 走，不感知 shape 差异

**负面**：
- full-tdd shape 理论上也能在 clarify_confirmed 状态手动调 cw(plan) 跳过 spec_review（status 合法了）。但 guidance 不引导，agent 若手动跳是自主行为——CW 不强制 full-tdd 走全链，这是 agent 纪律问题不是 guard 职责。
- TRANSITIONS 表的 expectedStatuses 语义从"前置阶段已完成"扩展为"前置阶段已完成或被裁剪"，注释需说明。

## Related

- [ADR-0002](./0002-taskshape-unified-axis.md) — TaskShape 统一配置轴
- [ADR-0003](./0003-existence-and-review-only-strategies.md) — existence + review-only 策略

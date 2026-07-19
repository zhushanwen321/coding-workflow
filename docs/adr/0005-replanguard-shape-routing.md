# ADR-0005：replanGuard 按 shape 路由

**Date**: 2026-07-18
**Status**: Accepted
**Topic**: cw-2026-07-18-step6-review-fixes-and-design-doc

## Context

方案 B 引入了 VerificationStrategy.replanGuard 接口（3 个策略类都实现了），但 handleReplan 从未调用它——W4 注释明说"接口不匹配，留后续 topic"。

核心难点：tdd-strategy.replanGuard 的签名 `(oldTopic, newPayload)` 与 handleReplan 的 plan/test 双路径参数组装不匹配。handleReplan 分两次调 validateAppendOnly（plan 路径校验 waves+legacyCases，test 路径校验 newCases），而 replanGuard 接受单个 payload。

同时 existence/review-only 的 replanGuard 是独立逻辑（existence 检查 artifact 篰改，review-only 恒空），与 tdd 的 validateAppendOnly 完全不同。

## Decision

**按 taskShape 路由**：

- `verification.id === "tdd"`：继续走 `validateAppendOnly`（现状不变，双路径参数组装匹配，零回归）
- `verification.id === "existence"`：走 `ExistenceVerificationStrategy.replanGuard`（检查已 verified artifact 不被篡改）
- `verification.id === "review-only"`：走 `ReviewOnlyVerificationStrategy.replanGuard`（恒返回空数组）

```typescript
const verification = getShape(topic.taskShape).verification;
if (verification.id === "tdd") {
  // tdd 路径：保持现有双路径 validateAppendOnly 调用不变
} else {
  // 非 tdd 路径：走策略 replanGuard
  violations.push(...verification.replanGuard(topic, replanPayload));
}
```

## Alternatives Considered

### 方案 B：统一走 replanGuard

把 handleReplan 的双路径改为组装单一 payload 调 tdd.replanGuard。

**否决原因**：需要重构 extractReplanInputs 让它理解双路径语义（plan 路径只校验 legacyCases 时才碰 topic.testCases）。改动大，tdd 路径有回归风险（808 测试里大量 replan 测试依赖现有双路径行为）。

### 方案 C：删掉 replanGuard 接口

删掉 3 个策略类的 replanGuard 实现 + 接口声明，handleReplan 保持现状。

**否决原因**：existence 的契约保护（已 verified artifact 不被篡改）就没有机制了。delete-only topic 在 dev 后 replan 可以把已验证删除的文件改成 expectedState=present 重新"验证"，这是安全漏洞。

## Consequences

**正面**：
- tdd 路径完全不变（零回归）
- existence 获得契约保护（replan 不能篡改已 verified artifact）
- review-only 恒通过（不误拦）
- 每个策略的 replan 安全门语义独立，符合策略模式的设计意图

**负面**：
- handleReplan 里 tdd 和非 tdd 走不同代码路径（分叉），读者需要理解为什么不全走 replanGuard
- tdd-strategy.replanGuard 仍是死代码（tdd 路径走 validateAppendOnly 而非它）——保留它作为"如果未来想统一"的备选路径，但当前不调用

## Related

- [ADR-0002](./0002-taskshape-unified-axis.md) — TaskShape 统一配置轴
- [ADR-0003](./0003-existence-and-review-only-strategies.md) — existence + review-only 策略（含 replanGuard 设计意图）

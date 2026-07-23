# Retrospect: v1-wave-types-state-machine

## 交付总结

实现了 cw 1.0 v5 wave 层（ExecutionUnit）完整功能，src/v1/ 五层架构：
- **core**（7文件）：WorkUnit/Plan/Evidence/Judgments/Clarifications 领域模型
- **rules**（9文件）：WAVE_TRANSITIONS 状态机 + 16 个 gate + freeze append-only + replan 影响面计算
- **store**（3文件）：V1Store POSIX 原子写 + lockfile + 事务回滚
- **handlers**（14文件）：11 个 action 编排 + V1Deps 注入
- **dispatch**（3文件）：统一入口 + 类型导出 + 包入口
- **测试**（8文件）：94 tests 全绿

## 逐项回顾

### 方案兑现度

| designReviewJudgment 项 | 兑现 |
|---|---|
| necessity（v5 wave 完整功能）| fulfilled — 9步主流程+replan+abort+全部gate+evidence跨阶段+freeze |
| sufficiency（MECE 覆盖）| partial — M2/M3 标注 wave-only stub（abandonedRefs/级联传播 defer 到 slice 层）|
| alternatives（自建通用层 vs 直写）| fulfilled — 数据驱动五层架构，core/rules 复用基础确立 |
| tradeoffs（POSIX 原子写 vs 其他）| fulfilled — store 复用验证过的 POSIX 模式，零 0.x 依赖 |
| risks（从零写工作量大）| materialized — 40 文件 / 6 wave / 多个 subagent，但 subagent 并行有效控住了时间 |

### 判错的判断

无重大判错。架构设计（五层 + 数据驱动）在实现中验证正确，无需返工。

### 流程问题

- **tdd_plan expected.text 模糊词**：U8/U11/U12 填 "fail" 被 gate 拒（需具体值），重提交一次。教训：expected.text 永远填具体判定值（passed=true/passed=false）不填结论词
- **review issue 格式**：dimension/severity 字段名与 0.x ReviewIssue 枚举不匹配，试了 3 次才对。教训：提交前先查 types.ts 的入参类型
- **test actual 提交**：第一轮全填 "passed" 导致 expected 不匹配。CW test 是 expected.text === actual.text 精确比较，需提交每个 case 对应的 expected 值

## 经验提炼

1. **subagent 并行有效**：W2（rules）+ W3（store）并行，W4（handlers）串行（最大 wave），整体实现效率高。但每个 subagent 的 task 必须含精确的 API 签名和文件路径
2. **架构设计先行**：v1-architecture.md 在写代码前定稿，让 4 个 worker 各自独立实现不冲突。五层依赖关系（core←rules←handlers←dispatch）清晰
3. **wave-only stub 标注**比强行实现更好：M2/M3（abandonedRefs/级联）在 wave 层无害，标注 stub + defer 到 slice 层，避免过度实现

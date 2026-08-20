# ADR 0007: v5 新建 src/v1/ 隔离层，不参考 engine/

## 状态

Accepted — 2026-07-22

**取代 ADR 0006**（ADR 0006 "建在 engine/ 上" 作废——用户明确否决）。

## 背景

ADR 0006 基于兼容性分析报告推荐"复用 engine/ 通用抽象层"。用户否决此方向，明确要求：

1. 新建 src/v1/ 隔离层，全新开发
2. 不参考 src/engine/ 的代码和架构（engine/ 的 UnitStateMachine/ScopeConfig/Unit/freeze/gate
   抽象完全不沿用）
3. 从 v5 设计文档出发，重新设计一套实现架构
4. 数据驱动：src/v1/ 内自建通用层（但重新设计，不参考 engine/ 代码）

## 决策

**新建 src/v1/，五层架构，从 v5 领域模型直写。**

```
src/v1/
├── core/       # 领域模型（WorkUnit/Plan/Evidence/Judgment 类型 + 工厂，零依赖）
├── rules/      # 领域规则（状态转换/gate/freeze/replan 纯函数，零 IO）
├── store/      # 持久化（JSON 文件 + 原子写，唯一 IO 层）
├── handlers/   # action 编排（串起 rules + store）
└── dispatch.ts # 统一入口
```

核心设计原则（详见 `.xyz-harness/cw-1-0-lifecycle-redesign/v1-architecture.md`）：

1. **领域模型直写，不抽泛型引擎**——PlanningUnit 和 ExecutionUnit 各有自己的 transitions 表
   和 status 类型，guard/computeNextStatus 是接收具体类型的纯函数，不是泛型类方法。
2. **数据与规则分离**——core（类型+不变量）与 rules（纯函数规则）分层，core 零依赖。
3. **副作用集中在 store + handlers**——rules 全是纯函数，可密集单元测试。
4. **evidence 跨阶段由 handlers 编排**——core 只定义类型+不变量（frozenAt 非空后不可改），
   实际填充由各 handler 在对应 action 后触发。
5. **replan 级联是纯函数 + handler 编排**——computeImpact 是纯函数（输入树+废弃条目→输出
   abort 清单），handler 调用它再执行 store 批量改 status。
6. **store 复用 POSIX 原子写模式**（独立实现，不 import 0.x）——tmp+fsync+rename+lockfile。

## 取舍

### 为什么不建在 engine/ 上（否决 ADR 0006）

用户判断：engine/ 是 v3/v4 时期的产物，其抽象层设计（ScopeConfig 驱动 + 泛型 UnitStateMachine）
不适合作为 v5 的地基。v5 的领域模型（两类 WorkUnit + replan abort+appendOnly + evidence 跨阶段）
应该有自己干净的实现，不受 engine/ 历史设计约束。

### 为什么不直写每层（选择自建通用层而非 wave 直写）

自底向上实现 wave→slice→feature→epic 时，四层共享 core 领域模型（WorkUnit/Plan/Evidence）和
部分 rules（guard 算法/gate 模式/freeze 机制）。把这些共享部分放在 core/+rules/，各层只写自己
的 transitions 表 + 专属类型 + 专属 gates。避免四层重复实现相同的底层机制。

### 承认的代价

- 从零写，不复用 engine/ 已验证的 dispatch 流水线和 freeze/gate 抽象，工作量更大
- 通用层（core/rules）需要自己设计 + 验证，有设计风险
- 但换来的是干净的、专为 v5 设计的实现，不受历史约束

## 后果

正面：
- v5 有独立、干净的实现，架构直接映射领域模型
- 与 0.x 完全隔离（存储/代码/测试/CLI 四重隔离），0.x 的 464 测试不受影响
- core/rules 分层让领域逻辑可密集单元测试（纯函数），不受 IO 干扰

负面：
- 工作量大于复用 engine/（但这是用户明确接受的成本）
- 通用层设计需要逐步验证（第一个 topic 先验证骨架跑通）

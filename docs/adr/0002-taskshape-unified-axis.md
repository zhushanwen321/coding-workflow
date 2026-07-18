# ADR 0002：TaskShape 统一配置轴

## 状态

Accepted（2026-07-18，topic cw-2026-07-18-taskshape-dimension-and-strategy-routing）

## 背景

CW 当前把三个本该正交的维度耦合在状态机里：

1. **流程编排**（create→plan→dev→review→closeout）——通用，对所有任务适用
2. **验证策略**（TDD 红灯 + 退出码 + append-only 锁 expected）——TDD 专属，硬编码在 handler/gate
3. **审查策略**（三段 review 锁死必经 + 6 维度硬编码）——对所有任务一刀切

后果：纯删除/重构/文档等非 TDD 任务在 tddPlanCheck（mock+real 分层强制）、TRANSITIONS 线性锁（dev 只能从 tdd_inited 进入）、validateAppendOnly（锁 expected）等 5 个硬卡点处卡死，只能 abort。

## 决策

引入 `TaskShape` 统一配置轴：一个任务形态 = 验证策略 ⊕ 审查策略的组合。

```typescript
interface TaskShape {
  readonly id: TaskShapeId;
  readonly verification: VerificationStrategy;  // 验证策略
  readonly review: ReviewStagePolicy;           // 审查策略
}
```

### 为什么是统一轴，不是两个独立配置

验证策略与审查策略是**相关的**，不是完全独立。"是否需要 test-coverage 审查维度"本质上由验证策略决定——非 TDD 任务（existence/regression 策略）不需要 test-coverage review。

如果做成两个独立配置轴（verificationStrategy + reviewStagePolicy 各自独立选择），会出现"选了 review-only 验证却保留 test-coverage 审查"这类不自洽组合。统一成 TaskShape 让组合合法性在 shape 定义时保证，agent 只需识别任务性质选 shape。

### 五个子决策

**1. 状态名不改（路径 1 先行）**

`tdd_inited`/`tested` 保留，语义从"TDD 专属"泛化为"验证阶段完成"。TRANSITIONS 表不变、checkLinear 不变、17 处断言不变。状态重命名（路径 2）留到策略模式稳定后再做。

**2. 纯函数签名不变**

`tddPlanCheck`/`judgeByExpected`/`redLightCheck`/`validateAppendOnly` 等纯函数签名保持不变。TddStrategy 内部原样调用，保 100+ 次纯函数单测零改动。

**3. 红灯校验保留原位**

红灯校验（runRedLightVerification）涉及 store 事务边界，不搬进策略，仍在 handleTddPlan 调用。

**4. taskShape 在 create 时注入**

遵循 runtimeEnv 的"create 时注入、旧 topic 可选、migration 补默认值"模式。本 topic 不加 clarify 阶段修正（留后续）。

**5. 本 topic 只做步骤 1+2（打地基）**

引入 TaskShape 维度 + handler 策略路由。存量默认 full-tdd，行为零回归。非 TDD 策略实现、review 阶段裁剪、状态重命名都是后续 topic。

## 后果

正面：
- 验证策略解耦，后续新增 existence/regression/review-only 策略不动状态机
- 审查策略解耦，后续支持阶段裁剪 + 维度子集化
- 状态机变成稳定基础设施

负面：
- 状态名 tdd_inited/tested 在非 TDD 场景下名不副实（路径 1 的过渡期代价）
- postDevVerify 从 handleTest 抽取有事务边界风险（缓解：抽成纯函数，事务留在 handler）

## 替代方案

- **方案 A（taskType 分支）**：用 N 条平行 if-else 代替抽象，组合爆炸，技术债。否决。
- **方案 C（可选验证阶段）**：朴素的"插拔阶段"，不如策略模式干净。留作 B 的降级备选。
- **方案 D（收紧边界）**：CW 就是 TDD 专用，不扩展。诚实但放弃扩展性，与产品演进方向冲突。

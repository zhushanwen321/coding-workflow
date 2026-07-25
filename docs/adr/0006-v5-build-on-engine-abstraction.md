# ADR 0006: v5 建在 engine/ 通用抽象层之上，不新建 src/v1/

## 状态

**Superseded by ADR 0007** — 2026-07-22

用户否决此方向。v5 不建在 engine/ 上，改为新建 src/v1/ 隔离层（见 ADR 0007）。
本 ADR 保留作历史记录。

## 背景

cw 1.0 v5 重构（4 层 WorkUnit：epic/feature/slice/wave）启动实现时，发现仓库中已存在
`src/engine/`（2490 行 + 482 行 smoke test）——这是 v3/v4 时期写的 1.0 通用引擎原型，实现了
层无关的状态机抽象（UnitStateMachine / ScopeConfig / Unit / freeze / gate）。

探索发现三个事实：

1. **engine/ 的通用抽象层是实质实现，不是空骨架**。dispatch 10 步流水线（guard → gate →
   append history → computeNextStatus → productApplicator → freeze check → save）完整，smoke
   test 验证了 4 个核心目标（主链走通 + progressive + 递归嵌套解耦 + freeze 抽象）。

2. **engine/ 的层配置（l3-wave.ts / l3-topic.ts）是 v3/v4 的 5 层设计产物，已被 v5 推翻**。
   v5 把层模型改为 4 层 WorkUnit（两类：PlanningUnit 7 步 / ExecutionUnit 9 步）。

3. **engine/ 完全没接入 CLI**。`src/dispatch.ts`（0.x 生产入口）不引用 engine/，仍走 0.x 的
   guard + handler switch。engine/ 是未投产的设计验证原型。

v5 实现路径因此有三个选项：
- **路径 A**：复用 engine/ 通用抽象 + 重写层配置 + 新增编排层
- **路径 B**：新建 src/v1/ 从零写，engine/ 不动
- **路径 C**：直接改 engine/

## 决策

**采用路径 A**：v5 建在 engine/ 通用抽象层之上。

具体落地：
- **复用** engine/ 内核（state-machine / gate / freeze / deps / unit）——基本不动
- **小改** engine/ 内核（4 项）：
  - TransitionRule 支持 bypass（replan 旁路不改 status）
  - freezeEvent 从死声明改为强制执行（evidence 冻结后不可写）
  - Unit 加 basedOnParent / abandonedRefs 字段（replan 影响面计算基础）
  - phases 从固定四槽扩展为可变结构（容纳 7/9 步）
- **删除** v3/v4 层配置（l3-wave.ts / l3-topic.ts）
- **新建** v5 四层 ScopeConfig（epic / feature / slice / wave）
- **新建** 编排层（Orchestrator）：replan 级联 abort、execute/test 后 evidence 自动填充、
  closeout 3 件事编排、nextAction 推导、跨层 execute 递归

## 取舍

### 为什么选 A 而非 B（新建 src/v1/）

兼容性核验结论：engine/ 的 10 项核心抽象（`<S,A,P>` 泛型、guard checkLinear、progressive
语义、TransitionRule、GateSpec、FreezeRule、Unit 跨层指针、UnitStore.findChildren、
structuredClone 隔离、productApplicator 钩子）与 v5 完全兼容。重写会丢弃已验证的 dispatch
流水线和 freeze/gate 抽象，引入双份维护。

### 为什么选 A 而非 C（直接改 engine/）

v5 需要的跨 Unit 编排（replan 级联、跨层 execute 递归、evidence 生命周期、nextAction 推导）
不该塞进单 Unit 内核（state-machine.ts）。engine/ 作为层无关内核是正确的分层——把编排逻辑
塞进去会破坏内核纯粹性，且牵连 v3/v4 配置。新建 Orchestrator 层调内核，是清晰分层。

### 承认的代价

engine/ 的内核小改会让现有 smoke test（482 行）暂时挂掉——因为它依赖 v3/v4 的 l3-topic /
l3-wave 配置和旧 TransitionRule。过渡策略：内核小改同步更新 smoke test，或先迁移 smoke test
到新配置。

## 后果

正面：
- 复用已验证的通用抽象层，实现工作聚焦在 v5 特有部分（层配置 + 编排层）
- engine/ 天然是 0.x 的隔离层（dispatch.ts 不引用它），无需额外隔离机制
- 0.x 的 464 个测试不受影响，保持绿灯

负面：
- engine/ 内核小改有回归风险（smoke test 可能挂），需同步更新
- 编排层（Orchestrator）是全新代码，无既有验证，是主要风险集中点

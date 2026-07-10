# Red Team Review — cw-cli-extract

> 审查人：红队·反过度编排路
> 审查时间：2026-07-10
> 审查对象：issues.md / non-functional-design.md / code-architecture.md / execution-plan.md / code-skeleton/

## Verdict: CHANGES_REQUESTED

## deletion test 结果摘要

| 元素 | 删除后任务能否完成 | 判定 |
|------|-------------------|------|
| #5 StringEnum 解耦 | 能（合并到 #2） | 过度拆分 |
| #6 CwParamsSchema 信封下沉 | 能（合并到 #2） | 过度拆分 |
| #9 测试等价策略 | 能（合并到 #1） | 过度拆分 |
| #10 反模式验收清单 | 能（合并到 #9） | 过度拆分 |
| §4.5 status/list 时序图 | 能（API 契约表足够） | 过度 |
| Deep Module 章节 | 能（时序图+API 契约已覆盖） | 可精简 |
| W6+W7 合并 | 能（一个验收 Wave 足够） | 过度拆分 |
| W4+W5 合并 | 能（都只改 2-3 文件） | 可合并 |
| state-machine.ts 骨架实现 | 能（Wave 可从零写） | 过度骨架 |
| gates.ts GitValidator 骨架实现 | 能（Wave 可从零写） | 过度骨架 |
| #1-#4 (P0) | 不能 | 核心，保留 |
| #7 渐进式退出语义 | 不能（独立决策点） | 核心，保留 |
| #8 查询边界 | 不能（engine 边界决策） | 核心，保留 |
| §4.1-§4.4 时序图 | 不能 | 核心，保留 |

## must_fix（过度设计/范围溢出）

无阻塞性 must_fix。设计整体方向正确，没有发现范围溢出（G1-G3 边界守住了）。

## should_fix（可收舍，建议至少处理 2-3 项）

### S-1: Issue #5/#6 可合并到 #2

**位置**: issues.md §P1
**问题**: #5（StringEnum 替换）和 #6（信封下沉）本质上是 #2（CLI 协议层）的实现细节。拆分为独立 issue 增加了文档导航成本，但没有增加决策独立性——#5 和 #6 都只有一个方案（A），没有真正的取舍。
**建议**: 合并为 #2 的子节「实现细节」，保留方案描述但不作为独立 issue 编号。上游覆盖核验表中 #5/#6 行改为指向 #2。

### S-2: Issue #9/#10 可合并

**位置**: issues.md §P2
**问题**: #9（测试等价策略）和 #10（反模式验收清单）都是测试/验收策略，拆分后各自只有 1 个方案且无真正取舍。
**建议**: 合并为「测试与验收策略」单一 issue。

### S-3: §4.5 status/list 时序图可删

**位置**: code-architecture.md §4.5
**问题**: status/list 是只读查询，不经过 dispatch，不涉及 gate/guard。时序图展示的只是 `Agent → CLI → Store.loadTopic → stdout`，复杂度低于其他 UC 一个数量级。§3 API 契约表已覆盖 `handleStatus`/`handleList` 签名。
**建议**: 删除 §4.5 时序图，保留 §3 签名表和 §6 测试矩阵对应行。§8 下游衔接表中 W5 行改为「API 契约表 §3」。

### S-4: Deep Module 章节可精简

**位置**: code-architecture.md §5
**问题**: 4 个 Deep Module 各写 8-12 行（Interface/Depth/Seam/Port 决策），信息密度低于时序图和 API 契约表。Deletion test 表明删掉此章不影响实现者理解接线。
**建议**: 精简为 2 行/模块表格（模块名 + 一句话 depth 理由 + seam 类型），删除 Port 决策段落（已在 issues.md 中决策）。

### S-5: W6+W7 可合并为一个验收 Wave

**位置**: execution-plan.md
**问题**: W6（反模式验收+NFR 测试）和 W7（engine 单测迁移+CLI e2e）都 blocked by W1-W5，都是验收性质。分开后 DAG 图多一条边，调度表多一行，但实现者可以自由安排验收顺序。
**建议**: 合并为「Wave 6: 验收」，包含反模式脚本 + NFR 测试 + engine 单测迁移 + CLI e2e。减少 Wave 数从 7 到 6。

### S-6: skeleton 中 state-machine.ts 和 gates.ts GitValidator 是完整实现而非骨架

**位置**: code-skeleton/src/engine/state-machine.ts, code-skeleton/src/engine/gates.ts
**问题**: state-machine.ts 包含 guard 三重校验、computeGatePassed、buildNextAction 的完整实现（~200 行）。gates.ts 的 GitValidator.validate 包含三项 git 校验的完整实现（~80 行）。这些不是骨架 stub，是可运行的代码。与 store.ts/dispatch.ts 的 `throw NotImplementedError` 模式不一致。
**建议**: 二选一——(A) 明确标注为「搬迁即实现」（#1 物理拷贝的产物），从 execution-plan.md W1 的文件影响列表中去掉这些文件（因为骨架已完成）。(B) 回退为 stub 模式，与 store.ts 一致。推荐 (A)，因为这些逻辑来自 pi 扩展的物理拷贝，重写没有价值。

## nit

### N-1: P3 迷雾与后续迭代表重复

**位置**: issues.md §迷雾 + §后续迭代
**问题**: #11/#12 在两处都列出，内容几乎相同。
**建议**: 合并为一处（后续迭代表），迷雾章节只保留一句话引用。

### N-2: NFR 缓解项的 Wave 归属可标注

**位置**: non-functional-design.md 缓解项回灌登记表
**问题**: 「落地为」列写的是泛化描述（如「每个 CLI 命令的无效输入返回 exit ≠0」），未标注具体 Wave。
**建议**: 在「落地为」列追加 Wave 编号（如「W2: plan 命令无效输入测试」）。

### N-3: execution-plan.md W4 blocked by W2 可质疑

**位置**: execution-plan.md W4 调度表
**问题**: W4（replan）标注 blocked by W2（plan），理由是「需要 plan 子命令先工作」。但 replan 的核心逻辑（append-only 校验 + store.appendWaves）不依赖 plan 子命令先跑通，只依赖 store 的方法存在。W4 可以与 W2/W3 并行。
**建议**: 如果 replan 测试需要 topic 已 planned 状态，可以用 mock topic 直接构造，不需要 plan 子命令先实现。将 W4 的 blocked by 改为 W1，与 W2/W3/W5 并行（G1 组）。

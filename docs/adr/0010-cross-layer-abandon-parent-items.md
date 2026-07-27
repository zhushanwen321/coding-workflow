# ADR 0010: 跨层跨时机的 abandon parent items 声明能力

## 状态

Accepted — 2026-07-27

## 背景

V5 设计的 replan 机制是 **abort + appendOnly**（model §5.6）：上层 replan 废弃条目 → cw 自动
计算下游影响面 → 级联 abort 受影响子孙 → 返回给 agent → agent 通过 `cw create` 重建。命中判定
的依据是 `basedOnParent`（下层创建时的历史快照，记录「我基于 parent 的哪些条目」）。

这套机制有一个盲区：**下层实际换了技术路径后，basedOnParent 的历史快照无法反映**。

典型场景：slice 在 plan 里选了某个 TechChoice（如「用 electron.net 做网络请求」），wave 的
`basedOnParent` 引用了它。但 wave 实际实现时发现 electron.net 不可行，改用了全局 fetch——wave
已经换了技术路径，实际不再依赖那个 TechChoice。此时若不声明脱离，后续 slice replan 废弃该
TechChoice 时，cw 会基于 `basedOnParent` 历史快照误判「这个 wave 依赖废弃条目」→ 误 abort。
被误 abort 的 wave 已写的代码 commit 作废要重做——浪费已完成的实现。

更一般地，「发现 parent 条目不适用」的时机不只在 wave execute 时：

- slice 在 plan 阶段设计 techChoices 时，可能发现 feature 的某个 AC 不可行
- feature 在 plan 阶段设计 spec 时，可能发现 epic 的某个 BC 不合理
- wave 在 plan 阶段写 testCases 时，可能发现 slice 的 interface 定义错了

**之前的实现局限**：`abandonedParentItems` 字段已存在于 `WorkUnitBase`（4 层都有，工厂初始化
为 `[]`），但唯一的写入路径是 wave execute handler 从 commit message `Cw-Abandon:` trailer
解析——这只覆盖了「4 层 × 多时机」矩阵的 1 格（wave × execute）。PlanningUnit（epic/feature/
slice）的 plan/design-review/replan 阶段、wave 的 plan/design-review 阶段都没有信号通道。

## 决策

**把 abandon parent items 声明能力扩展为跨层跨时机的通用机制**，主通道是 plan/replan 的显式
input，commit message trailer 作为 wave execute 的辅助通道保留。

1. **`AbandonParentItemsInput` 共享基础接口**：`PlanInput` / `PlanSliceInput` /
   `PlanFeatureInput` / `ReplanInput` 都 `extends AbandonParentItemsInput`，所有层所有时机
   都能通过 input 传 `abandonParentItems: string[]`。

2. **`mergeAbandonParentItems` 统一合并工具**（`src/handlers/internal.ts`）：8 个 plan/replan
   handler + wave execute handler 共用，append-only Set 去重合并到 `unit.abandonedParentItems`。
   消除重复代码，保证「一旦声明不可撤回」的一致语义。

3. **CLI `--abandonParentItems` flag**：`cw plan` / `cw replan` 都支持，JSON 数组形式
   （`--abandonParentItems '["TC1"]'`）。

4. **commit message trailer 通道保留**（向后兼容）：wave execute 仍解析 `Cw-Abandon:` trailer，
   作为「agent 写 commit 时顺手带」的辅助通道。主通道是显式 input（覆盖所有层所有时机），
   trailer 只覆盖 wave execute。

5. **cascade 命中判定加例外**（`src/rules/replan.ts`）：`computeImpact` 和
   `computeImpactCascade` 的命中规则改为 `basedOnParent 命中废弃条目 && 该条目不在
   abandonedParentItems 里` 才触发 abort。

## 替代方案

考虑过但不选：

1. **纯文档补全，不扩通道**——被否决。当前实现只覆盖 wave × execute 一格， PlanningUnit
   设计阶段发现 parent 条目不适用时无路可走，只能等被误 abort 后重建。这是真实的场景缺口，
   不是推测性功能。

2. **废弃 commit trailer，全走显式 input**——被否决。trailer 的优势是「agent 写 commit 时
   顺手带，零额外 CLI 参数」，符合 agent 的自然工作流。废弃它会让 wave execute 时声明脱离
   变得繁琐。保留 trailer 作为辅助通道，与显式 input 并存（都写同一字段，append-only 合并），
   语义统一。

3. **改 basedOnParent 本身（删除已脱离的条目）**——被否决。basedOnParent 是 append-only 历史
   快照（model §5.6.1），删改它违反 append-only 原则，且丢失「曾经基于这些条目」的历史信息。
   单独记一份「已脱离」清单（abandonedParentItems）是正确做法——basedOnParent 记历史，
   abandonedParentItems 记现状。

4. **只扩 replan 通道，plan 阶段不走**——被否决。plan 阶段（条目未冻结时）发现 parent 条目
   不适用，虽然可以直接改 plan，但「声明脱离」的意义不只是改本地 plan，而是告诉 cw「后续
   parent replan 时别因为我历史上 basedOnParent 引用过这个条目就 abort 我」——这是跨层影响面
   计算的输入，对 plan 阶段也有意义。限制只能 replan 时声明，会逼 agent 把「设计到一半发现」
   的场景硬拖到 replan，违反「早声明早豁免」。

## 后果

**正面**：
- abandon parent items 成为本层设计意图的一等声明，不再是 wave execute 的隐藏副作用
- PlanningUnit（feature/slice）设计阶段发现 parent 条目不适用时，有正式通道声明，不必等误 abort
- 主通道（显式 input）+ 辅助通道（commit trailer）并存，覆盖全矩阵，向后兼容
- 8 个 handler 共用 `mergeAbandonParentItems`，append-only 语义集中维护，不易出错

**负面 / 注意**：
- agent 需要理解两条通道的取舍（guidance 已体现：推荐 plan 阶段显式 input，execute 时 trailer
  是顺便）。错误标记（声明脱离了实际仍依赖的条目）会导致该被 abort 的 wave 逃过级联——
  guidance 已强调「不确定要不要标记时就不标记，宁可被 abort 后重建，也不要错误标记」
- `abandonedParentItems` 字段挂在 WorkUnitBase（4 层都有），但 epic 无 parent，该字段永远为 `[]`
  ——这是类型统一（共享 input 接口）的代价，运行时 epic 永不写入

## 关联

- **model §5.6.6**（`.xyz-harness/cw-1-0-lifecycle-redesign/design-v5-model.md`）：声明时机与
  通道的完整描述，4 层 × 多时机矩阵
- **wave §8.7**（`design-v5-wave.md`）：wave 的第三种 replan 相关行为（主动声明脱离）
- **slice §6.2.1 / feature §7.3.1 / epic §6.6**：各层对本能力的引用或「不适用」说明
- **ADR 0009**：`abandonedParentItems` 字段最初随 cw-abandon 扩展引入（wave execute trailer
  通道），本 ADR 是该扩展的正规化——从 wave 专属提升为跨层通用，并补全设计文档

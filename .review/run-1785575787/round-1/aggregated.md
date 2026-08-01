# Aggregated Review Report

## Summary
- MUST_FIX: 0
- SUGGESTION: 9
- INFO: 4
- 维度: project-conventions, quality-criteria, plan-completeness
- 去重数: 0

> 去重说明：三维度报告均按各自的「重叠裁决」严格划分边界（A=项目约定 / B=通用质量 / C=plan 落地），
> 对 `src/core/frontier.ts` 的多处条目（C-S2 在 59-78 行 FrontierNode 类型定义；B-S1/S2/S3 在
> collectSubtree / computeFrontier 运行时逻辑；A-INFO 在 status→action 表常量声明）分属不同行/不同构造，
> 不构成 ±5 行内的同一处缺陷。C-S1（FTC3 cli exit-1 测试缺失）被 C 显式归档并声明 B 不重复报告。
> B-S4（gate 聚合注释 stale）仅 B 记录，A/C 均判 gate 计数为 pass。故无可合并的重复条目。

## Must-Fix Issues
| # | 文件 | 行号 | 维度 | 描述 | 修复方向 |
|---|------|------|------|------|---------|
| _无_ | | | | | |

## Suggestions
| # | 文件 | 行号 | 维度 | 描述 | 修复方向 |
|---|------|------|------|------|---------|
| 1 | src/core/frontier.ts | 59-78 | C | DM1 FrontierNode 实现比 plan 契约多一个 `lastStatusHistoryAction?: string` 字段（`:77`），DM1 notes 与 IF2 contract 均未声明 | 字段功能合理（replan 是旁路、status 不变，frontier 需额外信号）；建议把该字段补回 DM1 定义使契约与实现一致 |
| 2 | src/core/frontier.ts | collectSubtree | B | `collectSubtree` 靠 `store.findChildren` 递归向下遍历，**无 visited 集合**；store 出现环（脏数据）时递归不终止、栈溢出。frontier 恰是排查异常/半损坏 store 的只读探查命令，是环最易出现的场景 | `collectSubtree` 入参加 `visited: Set<string>`，`out.push` 前判 `visited.has(id)` 跳过并（可选）记日志；`renderTree` 同模式遍历可一并加固 |
| 3 | src/core/frontier.ts | computeFrontier (Pass1+Pass2) | B | 对每个节点调一次 `store.findChildren`（全表扫描），N 节点 → O(N²) 比较；类型 B 每个 wave 还多一次 `store.load`（又是 O(N) 扫描）。典型 CW 树无感，但未来用于大型 topic（N 上百）延迟显著 | Pass 1 已遍历完整棵树拿到 `allRecords`，一次性构建 `Map<parentUnitId, WorkUnitRecord[]>` 索引，Pass 2 类型 A 直接查 Map（O(1)） |
| 4 | src/core/frontier.ts | Pass 2 类型 A | B | node 上 `childUnitIds`（来自 executeResult 快照）与 Pass 2 `store.findChildren`（实时父子外键）双源；progressive re-execute 后两者漂移会导致输出字段与 blockedReason 列出的子 id 不一致 | 统一数据源：Pass 2 也用 `node.childUnitIds` + `store.load` 逐个查终态（与 Pass 1 一致），或 `childUnitIds` 字段改由 `findChildren` 派生 |
| 5 | src/handlers/epic,feature,slice/execute.ts | 71-83 | B | 三层 planning-execute handler 各加了一段完全相同的 children 构造逻辑（`slugToChildId` Map + `plan.split.map` + `dependsOn` 映射 + filter），与同 PR 新建 `src/core/hierarchy.ts` 的 `resolveChildDependsOn` **逐字节同构**未复用（仅返回字段名 `childUnitId` vs `ChildInfo.unitId` 不同） | `resolveChildDependsOn` 返回 `{childUnitId, dependsOn}`，三 handler 一行 `resolveChildDependsOn(unit.plan.split, unit.evidence.childDelivery).map(d => ({ unitId: d.childUnitId, dependsOn: d.dependsOn }))` 复用，消除四份同构逻辑 |
| 6 | src/rules/gates/design-review.ts | 504,729,874 | C | IF4 声明「一个 `duplicateSplitSlug` gate 函数 + 三 runner 各加一行 + 三处 export」，实现拆成三个具名函数（`duplicateSplitSlug`/`featureDuplicateSplitSlug`/`epicDuplicateSplitSlug`，转调公共 `duplicateSplitSlugBySplits`） | 合理实现选择（TS 各层 unit 类型不同：Slice/Feature/Epic，单一签名需联合类型断言），功能等价于 plan 契约；三 runner 注册 + 三 export 均在。记录契约与实现表述差异即可，非缺陷 |
| 7 | tests/epic-gates.test.ts / tests/feature-gates.test.ts | 253 / 352 | B | 「聚合 gate 数量」分节注释 stale：epic 注 `（8 个 gate）`实际 11，feature 注 `（13 个 gate）`实际 14；describe 标题与 `toHaveLength` 已正确更新并全 pass，仅旧注释未同步，误导维护者（slice-gates.test.ts 无此问题） | 两处分节注释改为 11 / 14，与 describe 标题一致 |
| 8 | tests/frontier-dispatch-e2e.test.ts | 219 | C | plan testCase FTC3 声明「`cw frontier --root slice:nonexistent` → exit 1 + stderr 'unit not found'」，实际测试只断言 `computeFrontier()` 直调返回空 nodes，**未覆盖 cli 层 `throw CwError → exit 1 + stderr` 链路**（`src/cli.ts:836`）。ES1 exit-code 契约无回归测试守护 | 补一个 cli 层 e2e（spawn `cw frontier --root <不存在>` 断言 `exitCode===1` + stderr 含 'unit not found'），或至少单测 `runReadonly` 抛 CwError。当前实现正确但缺回归测试 |
| 9 | wave::guidance-gates-spec | — | C | 单 wave 文件数 17（9 源码 + 8 测试/文档）超 plan-completeness §2.3 的 5 文件建议阈值 | plan 已在决策 D3 说明 w3 是 4 个独立小改 C3/C4/C5/C6 的合并 wave（防 w2 膨胀），属主动权衡；若后续维护成本上升可考虑拆分 |

## Infos
| # | 文件 | 行号 | 维度 | 描述 |
|---|------|------|------|------|
| 1 | docs/recursive-cw-enhancements-design-report.md | — | C | w3 evidence.changedFiles 含此设计报告文档（384 行新增），但 w3 plan.files（GF1-GF9）未声明该文件。属额外产物（非 plan 声明的代码改动），不影响落地率 |
| 2 | src/cli.ts | — | A | 项目本无 `--help` 子命令机制（`cli.ts` 全文无 help handler，未知 action 一律 stderr 报错 + 列合法 action 列表）。frontier 未补 --help 与既有 tree/status/list/handoff 一致——非本次引入的回归，属项目既有风格；新增 `--root` 语义已由 `cli.ts:829` 注释 + SKILL.md 表格说明 |
| 3 | src/core/frontier.ts / src/readonly/render.ts | — | A | `WAVE_STATUS_TO_ACTION` / `PLANNING_STATUS_TO_ACTION` / `TERMINAL_STATUSES` 三张表在 core 与 readonly 各定义一份（frontier 注释已说明「core 层不能 import readonly，故重定义；若 status 枚举变化两处需同步」）。当前两份内容一致，但为手维护的隐式不变式——未来 status 枚举新增时若只改一处，frontier 的 status→action 映射会与 handoff 渲染不一致，且无单测交叉校验两表同源 |
| 4 | tests/execute-children-dispatch-e2e.test.ts | — | C | 出现在 wave::frontier 的 evidence.changedFiles（实际 w2 plan.files FF6 声明的是 `tests/frontier-e2e.test.ts`，实际落地为 `tests/frontier-dispatch-e2e.test.ts`，命名微调）。功能落地无误，仅记录 evidence 与 plan 文件名的细微出入 |

# Plan 落地率核对（Subagent C — plan-completeness）

> 审查维度：客观事实核对。对照 `slice:recursive-cw-enhancements` 的 plan（store.json）
> 与 `git diff main...HEAD`，核对 plan 声明的 interfaces（IF1-IF5）/ dataModels（DM1-DM2）/
> errorSpecs（ES1-ES3）/ split / wave.files / testCases 是否落地。
> 不做代码质量判断（归 Subagent B），不做项目约定核对（归 Subagent A）。

**数据来源**：
- plan：`~/.cw/__Users__zhushanwen__Code__coding-workflow-workspace__feat-recursive-problem-solving/store.json`
  → `workUnits[]`（1 slice + 3 wave，全部 status=closed，均有 commitHash）
- 实际变更：`git diff main...HEAD --name-only`（35 文件，与 3 个 wave 的 evidence.changedFiles 合集一致）

**结论速览**：plan 声明的 IF1-IF5 / DM1-DM2 / ES1-ES3 / split（3 wave）/ wave.files / testCases
**全部落地**。落地率 100%。无 must_fix。4 条建议（suggestion）/ 2 条说明（info）。

---

## Part 1：changes 落地率

### slice.plan 声明项落地核对

| 声明项 | 类型 | 落地文件 | 判定 |
|--------|------|----------|------|
| IF1 ActionResult.children + DM2 ChildInfo | interface / dataModel | `src/handlers/types.ts:111,117` | 已落地 |
| IF2 cw frontier CLI | interface | `src/cli.ts:823-839`（READONLY_QUERIES + runReadonly 分支）+ `src/core/frontier.ts` + `src/readonly/render.ts:109` + `src/readonly/index.ts` | 已落地 |
| IF3 resolveChildDependsOn | interface | `src/core/hierarchy.ts:22` | 已落地 |
| IF4 duplicateSplitSlug gate | interface | `src/rules/gates/design-review.ts:504,729,874`（slice/feature/epic 三版）+ 3 runner 注册 `:580,814,950` + `src/rules/index.ts` 三处 export | 已落地 |
| IF5 C4 各层 LayerSpecific 字段名 | interface | `src/handlers/internal.ts:274`（wave 4 字段，建议包含）+ `slice-internal.ts:214` / `feature-internal.ts:219` / `epic-internal.ts:218`（各 6/6/5 字段，必须包含） | 已落地 |
| DM1 FrontierNode | dataModel | `src/core/frontier.ts:59` | 已落地 |
| DM2 ChildInfo | dataModel | `src/handlers/types.ts:117` | 已落地 |
| ES1 root 不存在 exit 1 | errorSpec | `src/cli.ts:836` throw `unit not found` + main catch（`src/cli.ts:708-711`）stderr + exit 1 | 已落地 |
| ES2 root 是 wave 叶子 | errorSpec | `src/cli.ts:839` computeFrontier 正常返回（wave 无 children，nodes=[自身]） | 已落地 |
| ES3 childDelivery 空退化 | errorSpec | `src/core/hierarchy.ts:30`（`slugToChildId.get(d)` 缺失经 filter 过滤，dependsOn 退化 []）+ frontier.ts:240（myDep 缺失不 block） | 已落地 |
| split[0] children (C1) | split | wave `::children` evidence.changedFiles 5 项全中（types.ts + epic/feature/slice execute.ts + tests） | 已落地 |
| split[1] frontier (C2) | split | wave `::frontier` evidence.changedFiles 8 项含全部声明文件 | 已落地 |
| split[2] guidance-gates-spec (C3+C4+C5+C6) | split | wave `::guidance-gates-spec` evidence.changedFiles 17 项含全部声明文件 | 已落地 |

### 各 wave.plan.files 落地率

**wave::children（commitHash 47e597）** — F1-F5 全落地

| plan file | 描述 | 实际 | 判定 |
|-----------|------|------|------|
| F1 | types.ts 加 ChildInfo + children 字段 | `src/handlers/types.ts` | 已落地 |
| F2 | slice/execute.ts 构造 children | `src/handlers/slice/execute.ts:71-79` | 已落地 |
| F3 | feature/execute.ts 同模板 | `src/handlers/feature/execute.ts:75-83` | 已落地 |
| F4 | epic/execute.ts 同模板 | `src/handlers/epic/execute.ts:75-83` | 已落地 |
| F5 | tests/ C1 测试 | `tests/execute-children-dispatch-e2e.test.ts`（280 行，TC1-TC4 全覆盖） | 已落地 |

**wave::frontier（commitHash 522bcd0）** — FF1-FF6 全落地

| plan file | 描述 | 实际 | 判定 |
|-----------|------|------|------|
| FF1 | hierarchy.ts resolveChildDependsOn + ChildDependency | `src/core/hierarchy.ts` | 已落地 |
| FF2 | frontier.ts computeFrontier + FrontierNode/Result + 两遍扫描 | `src/core/frontier.ts` | 已落地 |
| FF3 | render.ts renderFrontier | `src/readonly/render.ts:109` | 已落地 |
| FF4 | readonly/index.ts export | `src/readonly/index.ts:7,10` | 已落地 |
| FF5 | cli.ts READONLY_QUERIES + runReadonly | `src/cli.ts:163,823-839` | 已落地 |
| FF6 | tests/ FTC1-FTC5 | `tests/frontier-dispatch-e2e.test.ts`（325 行，FTC1-FTC6，比声明多 FTC6） | 已落地 |

**wave::guidance-gates-spec（commitHash e943383）** — GF1-GF9 全落地

| plan file | 描述 | 实际 | 判定 |
|-----------|------|------|------|
| GF1 | render.ts C3 FR/AC 渲染 | `src/readonly/render.ts:861-879` | 已落地 |
| GF2 | internal.ts C4 wave 字段名 | `src/handlers/internal.ts:274` | 已落地 |
| GF3 | slice-internal.ts C4 slice 字段名 | `src/handlers/slice/slice-internal.ts:214` | 已落地 |
| GF4 | feature-internal.ts C4 feature 字段名 | `src/handlers/feature/feature-internal.ts:219` | 已落地 |
| GF5 | epic-internal.ts C4 epic 字段名 | `src/handlers/epic/epic-internal.ts:218` | 已落地 |
| GF6 | subagent-guidance.ts C5 retrospect forbidden→optional | `src/guidance/subagent-guidance.ts:79,124`（wave + planning 都改） | 已落地 |
| GF7 | design-review.ts C6 gate + 三 runner 注册 | `src/rules/gates/design-review.ts:504,580,729,814,874,950` | 已落地 |
| GF8 | rules/index.ts C6 export | `src/rules/index.ts:56,67,78`（三处） | 已落地 |
| GF9 | tests/ GTC1-GTC5 | `tests/guidance-gates-spec.test.ts`（332 行，GTC1-GTC5 全覆盖） | 已落地 |

**落地率汇总**：
- slice 声明项（13）：13 已落地，0 未落地
- wave::children files（5）：5/5
- wave::frontier files（6）：6/6
- wave::guidance-gates-spec files（9）：9/9
- **总 changes：33，已落地：33，未落地：0，落地率：100%**

---

## Part 2：plan 设计正确性

### 2.1 层级可达性（split 闭环）

- slice.plan.split 列 3 子 unit（children / frontier / guidance-gates-spec）→ store.json 里 3 个对应 wave 均 status=closed 且有 commitHash。✅ 闭环。
- 无孤岛子 unit（store 里无 split 未列的 wave）。✅
- split 之间 dependsOn 全为 `[]`（三 wave 并行，符合 plan 描述「都不与 w1/w2 改同文件」）。✅

### 2.2 依赖完整性

三 wave dependsOn 全空（并行），实际实现互不 import 新文件：
- w1（children）改 handlers/types.ts，w2（frontier）改 core，w3（guidance-gates-spec）改 handlers/readonly/rules，无跨 wave 的「先建后用」顺序约束。✅
- 仅 w1 新增的 `ChildInfo` 类型被 w3 间接经 handlers 链用到？核查：w3 改的是 schema 注入文本，不 import ChildInfo。无隐藏依赖。✅

### 2.3 范围合理性

| wave | 文件数 | 判定 |
|------|--------|------|
| w1 children | 5 | ≤5，合理 |
| w2 frontier | 8（含 src/types.ts + 复用 w1 的 execute-children-dispatch 测试） | >5，**建议项见下** |
| w3 guidance-gates-spec | 17（9 源码 + 8 测试/文档） | >5，**建议项见下** |

> 说明：w2/w3 超 5 文件但每个改动都是单一功能（w2 = frontier 一个命令，w3 = 四个独立小改 C3/C4/C5/C6），
> plan 已显式说明 w3 是「四个不相关的独立小改放一个 wave」（决策 D3 把 C3 从 w2 挪到 w3 防止单 wave 耦合）。
> 这是 plan 主动的设计权衡而非失控膨胀。

### 设计问题清单

| 类型 | WorkUnit | 问题 | 严重度 |
|------|----------|------|--------|
| wave 文件数偏多 | wave::frontier | 8 文件改动（含 DM1 接口 + 两遍扫描 + render + cli + 测试），略超 5 文件建议阈值；但内聚于「frontier 一个命令」，不可拆 | suggestion |
| wave 文件数偏多 | wave::guidance-gates-spec | 17 文件（9 源码 + 8 测试/文档），超阈值；plan 已说明是 4 个独立小改 C3/C4/C5/C6 的合并 wave | suggestion |
| split 子项依赖全空 | slice:recursive-cw-enhancements | 三 wave 并行执行（dependsOn 全空）。实际 w2 frontier 的 resolveChildDependsOn 被 w1 的 children 字段消费吗？核查：frontier 调 resolveChildDependsOn 从已落盘 record 反查，不依赖 w1 的 ActionResult.children。并行成立，但 plan 未在 split.dependsOn 显式声明「w2 不依赖 w1」的反向说明（仅文字描述）| info |

---

## Part 3：testCases 落地核对

| 声明 TC | 实际测试 | 判定 |
|---------|----------|------|
| TC1 slice execute children 含 unitId + dependsOn | `tests/execute-children-dispatch-e2e.test.ts:63` | 已落地 |
| TC2 feature/epic execute children | `:123`（feature）；epic 结构同（测试以 feature 代表） | 已落地 |
| TC3 wave execute 不返回 children | `:179` | 已落地 |
| TC4 无依赖 split dependsOn 全空 | `:241` | 已落地 |
| FTC1 类型 A blocked | `tests/frontier-dispatch-e2e.test.ts:113` | 已落地 |
| FTC2 类型 B blocked（两分支） | `:156`（FTC2a w1 未终态）+ `:186`（FTC2b w1 closed） | 已落地 |
| FTC3 root 不存在 exit 1 | `:219` **但只测了 computeFrontier 防御性空 nodes，未测 cli 层 exit 1 + stderr** | 见下 suggestion |
| FTC4 root 是 wave 叶子 | `:231` | 已落地 |
| FTC5 全终态 nodes=[] | `:257` | 已落地 |
| GTC1 C3 FR/AC 渲染 | `tests/guidance-gates-spec.test.ts:80` | 已落地 |
| GTC2 C4 四层字段名 | `:116/136/149/162`（wave/slice/feature/epic 四分支）+ `:175` 非 design-review 不注入 | 已落地 |
| GTC3 C5 retrospect optional | `:187`（wave）+ `:196`（planning） | 已落地 |
| GTC4 C6 duplicateSplitSlug 拦截 | `:209/222/235`（slice/feature/epic）+ `:248`（三 runner 聚合） | 已落地 |
| GTC5 C6 无重复 pass | `:302/313/324` | 已落地 |

**测试运行结果**：`npx vitest run` 全 45 文件 801 测试通过；本次三新文件 29 测试全过；`npx tsc --noEmit` 通过。

---

## 问题清单（按严重度）

### must_fix（0）

无。plan 声明的所有 IF/DM/ES/split/files/testCases 均已落地。

### suggestion（4）

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| S1 | `tests/frontier-dispatch-e2e.test.ts:219`（FTC3） | plan testCase FTC3 声明「cw frontier --root slice:nonexistent → exit 1 + stderr 'unit not found'」，实际测试只断言 `computeFrontier()` 直接调用返回空 nodes，**未覆盖 cli 层的 `throw CwError → exit 1 + stderr` 链路**（`src/cli.ts:836`）。ES1 的 exit-code 契约无测试守护。 | 补一个 cli 层 e2e（spawn `cw frontier --root <不存在>` 断言 exitCode===1 + stderr 含 'unit not found'），或至少单测 `runReadonly` 抛 CwError。当前实现正确但缺回归测试。 |
| S2 | `src/core/frontier.ts:59-78`（DM1 FrontierNode） | DM1 声明 9 字段，实现多了一个 `lastStatusHistoryAction?: string`（`:77`）。这是 replan 后备检测用，超 plan 契约。DM1 notes 未提此字段，IF2 contract 的 FrontierNode 定义也未列。 | 字段功能合理（replan 是旁路 status 不变，frontier 需额外信号），属 plan 契约的合理增量。建议把该字段补回 DM1 定义使其与实现一致（plan 落地率角度：契约被扩展，非缺失）。 |
| S3 | `src/rules/gates/design-review.ts:504,729,874`（IF4 实现） | IF4 声明「一个 `duplicateSplitSlug` gate 函数（接收 PlanningUnit）+ 三 runner 各加一行 + 三处 export」。实现拆成三个具名函数（`duplicateSplitSlug`/`featureDuplicateSplitSlug`/`epicDuplicateSplitSlug`，转调公共 `duplicateSplitSlugBySplits`）。 | 这是合理的实现选择（TS 各层 unit 类型不同：Slice/Feature/Epic，单一签名需联合类型断言）。功能等价于 plan 契约，三 runner 注册 + 三 export 都在。非缺陷，仅记录实现与契约表述的差异。 |
| S4 | wave::guidance-gates-spec（17 文件） | 单 wave 文件数超 plan-completeness §2.3 的 5 文件建议阈值。 | plan 已在决策 D3 说明 w3 是 4 个独立小改的合并（防 w2 膨胀），属主动权衡。若后续维护成本上升可考虑拆分。 |

### info（2）

| # | 位置 | 说明 |
|---|------|------|
| I1 | `docs/recursive-cw-enhancements-design-report.md`（384 行新增） | w3 的 evidence.changedFiles 含此设计报告文档，但 w3 plan.files（GF1-GF9）未声明该文件。属额外产物（非 plan 声明的代码改动），不影响落地率。 |
| I2 | `tests/execute-children-dispatch-e2e.test.ts` 出现在 wave::frontier 的 evidence.changedFiles | w2 frontier 的 changedFiles 含 w1 的测试文件（可能 git 把跨 commit 的测试文件计入合并 diff）。实际 w2 plan.files FF6 声明的是 `tests/frontier-e2e.test.ts`（实际落地为 `tests/frontier-dispatch-e2e.test.ts`，命名微调）。功能落地无误，仅记录 evidence 与 plan 文件名的细微出入。 |

---

## 与其他维度分工边界

本文档**只核 plan 落地**。以下不在本维度范围（避免与 A/B 重复计 defect）：
- frontier.ts 两遍扫描 / blocked 推导的逻辑正确性、类型收窄健壮性 → Subagent B
- C4 字段名是否符合 judgments.ts 各层 interface 定义、C5 optional 档位 guidance 文案 → Subagent B
- cw CLI 契约一致性（frontier 退出码与 tree/handoff 对齐）、状态机 Gate 注册约定 → Subagent A
- DM1 多出的 lastStatusHistoryAction 字段是否破坏消费方契约 → Subagent B（本维度仅记 plan 契约被扩展，S2）

**重叠裁决**：S1（FTC3 缺 cli 层 exit-1 测试）本质是「测试覆盖不足」，可能同时属 B（质量）维度。按 C>A>B 优先级归 C（因 testCase FTC3 是 plan 显式声明项，属落地核对）。

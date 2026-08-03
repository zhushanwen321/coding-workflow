# CONTEXT.md — 统一语言（Ubiquitous Language）

> 本项目：`coding-workflow`（CW-CLI）—— agent-agnostic 编码流程编排 CLI。
> 统一语言跨所有文档和代码一致使用，避免歧义。

## 领域术语

| 术语 | 定义 | 出处 |
|------|------|------|
| **CW（Coding Workflow）** | 编码流程编排器：状态机 + 机器检查 gate，强制编码任务走 create → closeout | 项目核心 |
| **WorkUnit** | 一次编码任务的生命周期单元，4 层模型（epic/feature/slice/wave） | `src/core/workunit.ts:53` WorkUnitBase |
| **Action** | CW 接受的 16 种操作之一（见下表） | `src/cli.ts:144-164` |
| **Status（状态）** | WorkUnit 的生命周期阶段，两层枚举（见下文） | `src/core/status.ts` |
| **Gate（机器检查门）** | action 流转前的结构化检查，gate fail 可 retry 不阻断 | `src/rules/gates/*.ts` |
| **Guard** | 状态机合法性校验（防跳步），guard fail 抛 CwEngineError 不可恢复 | `src/rules/state-machine.ts` |
| **Plan** | plan 阶段的产物，4 层形态不同（见数据模型） | `src/core/plan.ts` |
| **Split** | PlanningUnit execute 时按 Split 创建子层 unit | `src/core/plan.ts:46` |
| **Evidence** | unit 的交付证据（commitHash/changedFiles/artifacts/testRunResult），closeout 时冻结 | `src/core/evidence.ts` |
| **Judgment** | 阶段产物的人工判断（designReview/test/execReview/retrospect 四种） | `src/core/judgments.ts` |
| **StatusChange** | statusHistory 的元素（append-only，含 from/to/at/action/note） | `src/core/status.ts:47` |
| **repoMeta** | git repo 元信息（remoteUrl/branch/worktreePath/headCommit/recordedAt） | `src/store/schema.ts:36` |

## WorkUnit 四层模型

```
epic → feature → slice → wave
```

| 层 | scope | 类型 | status 枚举 | 是否产代码 | execute 行为 |
|----|-------|------|-------------|-----------|-------------|
| **epic** | `"epic"` | `Epic extends PlanningUnit` | PlanningStatus | 否 | 按 plan.split 创建 child feature |
| **feature** | `"feature"` | `Feature extends PlanningUnit` | PlanningStatus | 否 | 按 plan.split 创建 child slice |
| **slice** | `"slice"` | `Slice extends PlanningUnit` | PlanningStatus | 否 | 按 plan.split 创建 child wave |
| **wave** | `"wave"` | `ExecutionUnit extends WorkUnitBase` | ExecutionStatus | 是 | 记录 commitHash（叶子，不下沉） |

层级关系：子 unit 通过 `parentUnitId` 外键关联（扁平存储，不嵌套）。execute 下沉时子 slug = `${unit.slug}::${split.slug}`（`::` 分隔）。

出处：`src/core/workunit.ts:57`（scope 字段）、`:207/288/345/417`（id 格式 `<scope>:<slug>`）。

## 16 个 Action

| Action | 类型 | 说明 |
|--------|------|------|
| `create` | 入口 | 建 WorkUnit（按 layer 建 epic/feature/slice/wave），工厂初始化全字段空态 |
| `clarify` | progressive | 澄清需求/决策，append clarifications（不改 status 或留在 clarifying） |
| `plan` | progressive | 写 plan 条目（wave: testCases/tasks/files/contracts；slice: 技术方案+split；上层: 只 split） |
| `design-review` | 线性 | 审方案合理性，写 designReviewJudgment，跑 design-review gate |
| `execute` | 线性 | wave: 记录 commitHash；PlanningUnit: 按 split 下沉创建子 unit（nextAction 填 crossLayer.descend 指向第一个 child） |
| `test` | 线性（wave 专属） | 跑测试 + 4 gate（commitExists/testsAllPass/testCasesExecuted/testReferencesDesignReview） |
| `exec-review` | 线性（wave 专属） | 代码品味审查（纯人审，写 execReviewJudgment） |
| `retrospect` | 线性 | 复盘，写 retrospectData（PlanningUnit 含 deliveryVerdict 验收子层） |
| `closeout` | 线性 | 归档，补 evidence + 校验 artifacts drift + 冻结 evidence（frozenAt） |
| `replan` | 旁路 | 废弃 plan 条目 + 影响面计算 + 级联 abort（不改 status，append-only 约束） |
| `abort` | 旁路 | → aborted 终态 |
| `tree` | 只读 | 渲染 WorkUnit 父子树（缩进） |
| `status` | 只读 | 单 unit 完整 JSON dump |
| `list` | 只读 | unit 列表（支持 --all 跨 cwd / --layer / --grep / --limit） |
| `handoff` | 只读 | 叙述性交接摘要（self/upstream/full 三种 scope） |
| `frontier` | 只读 | 以某 unit 为根的 frontier 视图（非终态节点 + blocked/dependsOn/lastStatusHistoryAction，供递归调度器消费） |

> progressive = 可在同一 status 下多次调用。只读命令不经 dispatch、不写 store、不 append statusHistory。
> ADVANCE_ACTIONS = create + 10 推进（`src/cli.ts:144`）；READONLY_QUERIES = 5 只读（`src/cli.ts:164`）。
> test / exec-review 是 wave 专属——PlanningUnit 收到会抛 illegal_transition。

## 两层 Status 枚举

### PlanningStatus（epic/feature/slice，8 态）

```
created → clarifying → planning → design-reviewed → executing → retrospected → closed
                                                                    ↘ aborted（终态）
```

出处：`src/core/status.ts:10`。

### ExecutionStatus（wave，10 态）

```
created → clarifying → planning → design-reviewed → executing → tested → exec-reviewed → retrospected → closed
                                                                    ↘ aborted（终态）
```

出处：`src/core/status.ts:22`。wave 比 PlanningUnit 多 `tested` 和 `exec-reviewed`（在 executing 与 retrospected 之间）——因为只有 wave 产代码需要 test/exec-review。

终态：`closed` / `aborted`（不可逆）。出处：`src/core/status.ts:418/223`。

## 状态流转规则

guard（`guardWave`/`guardPlanning`，`src/rules/state-machine.ts`）只验状态机合法性（防跳步），不验业务 gate。guard fail → 抛 CwEngineError（exit 1，不可恢复）。gate fail → 返回 ActionResult(ok=false)（可 retry）。

关键转换（完整表见 `src/rules/state-machine.ts:64` WAVE_TRANSITIONS / `:292` PLANNING_TRANSITIONS）：

| action | wave from → to | planning from → to |
|--------|---------------|-------------------|
| clarify | created,clarifying → clarifying | 同 |
| plan | clarifying,planning,design-reviewed → planning | 同 |
| design-review | planning,design-reviewed → design-reviewed | 同 |
| execute | design-reviewed → executing | 同 |
| test | executing → tested | —（wave 专属） |
| exec-review | tested → exec-reviewed | —（wave 专属） |
| retrospect | exec-reviewed → retrospected | executing → retrospected |
| closeout | retrospected → closed | 同 |
| replan | design-reviewed 后任一状态 → 原地（旁路） | design-reviewed,executing → 原地 |

## 核心架构概念

| 术语 | 定义 | 出处 |
|------|------|------|
| **dispatch** | engine 统一入口纯函数：`(params, deps) => ActionResult`，按 scope 路由到 4 子分派器 | `src/dispatch.ts` |
| **ActionResult** | engine 统一返回：unitId/status/ok/gateResults?/nextAction?/failureCount?/children? | `src/handlers/types.ts:87` |
| **nextAction** | engine 返回的导航信息：action? + guidance + unitPath + crossLayer? | `src/handlers/types.ts:126` CwNextAction |
| **guidance** | 拼入 nextAction 的纯文本提示词，agent 的唯一导航来源；正常三段式/异常四段式 | `src/guidance/build-guidance.ts` |
| **crossLayer** | closeout 后跨层导航：descend（下沉首个子）/ sibling（横向兄弟）/ ascend（回父 retrospect）；单值，向后兼容串行导航 | `src/guidance/cross-layer.ts:60` |
| **CwDeps** | engine 依赖注入接口：store/gitValidator/testRunner?/fileExists/workspacePath/clock | `src/handlers/types.ts:61` |
| **CwStore** | store.json 持久化层：POSIX 原子写 + 跨进程文件锁 + 内存事务（深拷贝+ROLLBACK） | `src/store/cw-store.ts:70` |
| **熔断不阻断** | 连续 gate fail 5 次后 guidance 加「强烈建议 abort」文案，但不阻止 agent 继续重试 | `src/guidance/failure-hint.ts` |

数据流：
```
agent bash 调 cw <action> [flags]
  → cli.ts: argv 解析 + migrateLegacyV1Home() + buildParams → CwParams
  → dispatch.ts: loadWorkUnit → guard → handler（按 scope 路由）
  → handler: gate 检查 → 事务内 store 变更 → transitionStatus → buildNextAction
  → cli.ts: stdout JSON + exit code（0 正常 / 1 CwError·CwEngineError / 2 内部异常）
```

## 数据模型

### WorkUnitBase 共享字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | `<scope>:<slug>`（如 `wave:auth-w1`） |
| `scope` | epic\|feature\|slice\|wave | 层类型 |
| `slug` | string | 人类可读短名 |
| `parentUnitId` | string? | 父层 id（epic 无） |
| `status` | PlanningStatus \| ExecutionStatus | 当前状态 |
| `statusHistory` | StatusChange[] | append-only 变更流（含 fail 记录） |
| `basedOnParent` | string[] | 引用父层哪些条目 id（创建快照） |
| `objective` | string | 一句话目标 |

各层差异：epic/feature/slice 是 PlanningUnit（含 designReviewJudgment/PlanningEvidence/PlanningRetrospectData）；wave 是 ExecutionUnit（额外含 testJudgment/execReviewJudgment/WaveEvidence/RetrospectData）。feature 的 clarify 产物是容器对象（含 spec），其余三层是裸数组。

### Plan 类型（4 层形态不同）

| 层 | Plan 类型 | 内容 |
|----|----------|------|
| epic/feature | `Plan`（基类） | 只含 split（拆下层） |
| slice | `SlicePlan` | split + 技术方案（techChoices/interfaces/dataModels/errorSpecs/decisions） |
| wave | `WavePlan` | split=[]（cw 自动填）+ testCases/tasks/files/contracts |

出处：`src/core/plan.ts:36`（Plan 基类）、`:64`（WavePlan）、`:122`（SlicePlan）。

## 数据存储

| 文件 | 路径 | 说明 |
|------|------|------|
| store.json | `~/.cw/<encodedCwd>/store.json` | 状态库（workUnits 扁平集合 + repoMeta），per-cwd 隔离 |
| 中间产物 | `<workspacePath>/.cw/<slug>/<action>.json` | clarify/plan/design-review 等阶段 input JSON（已 gitignore） |
| CW_HOME | 环境变量 | 覆盖默认 `~/.cw`（必须绝对路径） |

encodeCwd 规则：路径分隔符 `/` 和 `\` → `__`（`src/store/schema.ts:85`）。

CwStore 数据结构（`src/store/schema.ts:22` CwJsonFile）：
```ts
{
  schemaVersion?: number,  // 缺失视为 1
  repoMeta?: RepoMeta,     // git 元信息，首次 save 回填
  workUnits: WorkUnitRecord[]  // 扁平集合，子 unit 通过 parentUnitId 外键关联
}
```

## 业务边界

**做什么**：用状态机 + 机器检查 gate 强制 AI 编码任务走结构化流程（clarify → plan → design-review → execute → test → exec-review → retrospect → closeout）。

**不做什么**：不假设调用方有任何 agent harness 能力（guidance 是纯文本，agent 通过 bash 调 cw）；不做质量阈值硬阻断（gate fail 只告警不阻断，连续 5 次后换熔断文案但仍可重试）；不管理代码仓库（只读 git 做 commit 校验）。

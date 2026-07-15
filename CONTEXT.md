# CONTEXT.md — 统一语言（Ubiquitous Language）

> 本项目：`coding-workflow`（CW-CLI）—— agent-agnostic 编码流程编排 CLI。
> 统一语言跨所有文档和代码一致使用，避免歧义。

## 领域术语

| 术语 | 定义 | 备注 |
|------|------|------|
| **CW（Coding Workflow）** | 编码流程编排器：状态机 + 机器检查 gate，强制编码任务走 create → closeout | 本项目的核心 |
| **Topic** | 一次编码任务的生命周期单元，含 topicId/slug/objective/status/waves/testCases/gateHistory | 状态机的实例 |
| **Action** | CW 接受的 13 种操作之一（见下表） | 每个对应状态机一条转换规则 |
| **Status（状态）** | Topic 的生命周期阶段，8 态：created → planned → tdd_inited → developed → reviewed → tested → retrospected → closed | lite 单轨，无 tier 字段 |
| **Gate（机器检查门）** | 每个 action 流转前跑的结构化检查，通过才允许状态流转 | CW 的核心价值 |
| **gateHistory** | 每次 gate 判定的审计记录（phase + gate 名 + result + report），是评估指标的核心数据源 | append-only |
| **RuntimeEnv** | 运行环境元数据（agent + llm + cwVersion），create 时注入，评估指标的分组维度 | 不可变 |
| **Wave** | plan 拆分的交付单元，含 id/dependsOn/changes/priority/committed/changedFiles | dev 阶段逐 Wave 实现 |
| **TestCase** | tdd_plan 阶段定义的测试用例，含 layer(mock/real)/expected/actual/status | test 阶段机器重算 |
| **RetrospectData** | retrospect 阶段的结构化回顾数据（derived + knownRisks + processIssues） | derived 由 cw 自动算 |
| **Assessment** | post-closeout 人工评估记录（quality/test/stability/defect 四类） | progressive，不改 status |

## 13 个 Action

| Action | 类型 | 目标 Status | 说明 |
|--------|------|------------|------|
| `create` | 入口 | created | 建 topic，注入 RuntimeEnv |
| `clarify` | advisory progressive | created | 澄清需求/技术 spec，记录 ADR（不阻断 plan） |
| `plan` | 线性 | planned | 提交 dev-plan.json（waves） |
| `tdd_plan` | 线性 | tdd_inited | 写测试代码（红灯）+ test.json |
| `dev` | progressive | developed | 按 Wave 写实现 + commit |
| `review` | progressive | reviewed | code review，提交 issues（stdin） |
| `review_fix` | progressive | reviewed | 修复 review 发现的 issue |
| `test` | progressive | tested | 跑测试，提交 actual，CW 机器重算 |
| `test_fix` | progressive | tested | 修复 test 失败的 case |
| `retrospect` | 线性 | retrospected | 复盘 + 结构化 retrospectData |
| `closeout` | 线性 | closed | 归档 topic，写 evidence |
| `replan` | 旁路 | planned | 修改计划（append-only 约束） |
| `assess` | progressive | closed | post-closeout 人工评估（不进 guidance 导航） |

> progressive = 可在同一 status 下多次调用；advisory = 不阻断后续阶段。

## 8 个 Status

```
created → planned → tdd_inited → developed → reviewed → tested → retrospected → closed
```

## 核心架构概念

| 术语 | 定义 |
|------|------|
| **dispatch** | engine 统一入口纯函数：`(params, deps) => ActionResult` |
| **ActionResult** | engine 统一返回：topicId/status/gatePassed/nextAction(+mustFix) |
| **nextAction** | engine 返回的导航信息：action + guidance（含完整方法论）+ alternatives |
| **guidance** | 拼入 nextAction 的纯文本提示词，agent 的唯一导航来源 |
| **alternatives** | 当前状态下同样合法的其他 action（如 dev 阶段的 replan） |
| **ActionDeps** | engine 的依赖注入接口：store（持久化）/ git（GitValidator）/ workspacePath |
| **checkLinear** | 唯一的 guard：线性 expectedStatus 校验（防跳步） |
| **computeGatePassed** | 从 topic 逻辑模型算 phase 是否完成（不读 gatePassed 缓存，每次重算） |

## 数据存储

| 文件 | 路径 | 说明 |
|------|------|------|
| _cw.json | `~/.cw/<encoded-cwd>/_cw.json` | topic 状态库（JSON + flock + 原子写），per-cwd 隔离 |
| env.json | `~/.cw/<encoded-cwd>/env.json` | RuntimeEnv 默认值（agent + llm），可选 |
| 交付物目录 | `<workspacePath>/.xyz-harness/<slug>/` | plan.json / retrospect.md / review.md 等 |

## 业务边界

**做什么**：用状态机 + 机器检查 gate 强制 AI 编码任务走结构化流程（plan → TDD → dev → review → test → retrospect）。

**不做什么**：不假设调用方有任何 agent harness 能力；不做质量阈值硬性阻断（gate 熔断只告警不阻断）；不管理代码仓库（只读 git 做 commit 校验）。

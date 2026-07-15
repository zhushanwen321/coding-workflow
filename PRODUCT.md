# 产品文档

> **always-current**，更新频率低（愿景稳定）。
> 给新需求的 ①full-clarity 提供「产品已经是什么」的上下文，避免每次需求从零理解产品。
> 本次需求细节在 `.xyz-harness/{主题}/requirements.md`（不搬进本文件——那是需求级，非产品级）。
>
> 配套文档：[CONTEXT.md](./CONTEXT.md)（统一语言）、[ARCHITECTURE.md](./ARCHITECTURE.md)（系统架构）、[docs/metrics-design.md](./docs/metrics-design.md)（指标设计）。

## 愿景

**Agent-agnostic 编码流程编排 CLI**：用状态机 + 机器检查 gate，强制 AI 编码任务走结构化流程（create → closeout），让 coding agent 不跳步、不谎报测试结果、不偷工减料。

解决谁的问题：使用 AI coding agent（Pi / Claude Code 等）的开发者——agent 能力越强，越容易"自信地走捷径"。CW 不信任 agent 的声明，只信机器验证的证据（commit 存在性 / TDD 红灯 / expected 精确重算），把流程约束从"prompt 里说说"变成"状态机里拦住"。

[from: package.json `description`；CONTEXT.md「业务边界」；ARCHITECTURE.md「gate 机制」]

## 核心用户

| Actor | 诉求 | 边界 |
|-------|------|------|
| **Coding Agent**（Pi / Claude Code / Cursor 等） | 通过 bash 调 `cw` 命令驱动机器检查流程，拿 `nextAction.guidance` 当唯一导航 | 只能调命令 + 读 stdout；CW 不假设它有 skill 加载 / workflow 引擎 / 工具调用等 harness 能力 [from: README.md；AGENTS.md「Agent-agnostic」] |
| **开发者（设计者）** | 通过 `cw stats` / `cw assess` 看评估指标，决策 cw-cli 改进方向（哪个 phase 退步、哪个 gate 失效） | assess 是人工 post-closeout 评估，由设计者而非执行 agent 调用；指标看趋势不看单点 [from: docs/metrics-usage.md「指标驱动的改进循环」] |

## 功能边界

当前已覆盖的功能域，成熟度标注：

| 功能域 | 成熟度 | 说明 |
|--------|--------|------|
| **状态机编排** | 核心 | 13 action / 8 status / 单重 guard（`checkLinear` 防跳步）[from: CONTEXT.md] |
| **机器检查 gate** | 核心 | plan 结构校验 / TDD 红灯 / commit 锚定（diff-tree）/ judgeByExpected 机器重算 / append-only 守门——不信任 agent 声明，只信机器证据 [from: ARCHITECTURE.md「gate 机制」] |
| **review / test fix loop** | 核心 | 各自独立循环（review 最多 3 轮，test 最多 5 轮），不回退到 dev；达上限强制进下一阶段或熔断告警 [from: ARCHITECTURE.md「fix loop」] |
| **三层评估指标** | 稳定 | 交付质量 / 过程效率 / 杠杆健康度，纯函数计算，只读 topic 数据 [from: docs/metrics-design.md「三层架构」] |
| **RuntimeEnv 分组维度** | 稳定 | agent + llm + cwVersion，create 时注入不可变；跨 topic 聚合按此分组 + 复杂度分桶 [from: docs/metrics-design.md「分组维度」] |
| **post-closeout assess** | 稳定 | 人工评估（quality/test/stability）+ defect 校准（foundInReview 锚定 review 召回率）；不走 gate，不改 status [from: docs/metrics-design.md「为什么 assess 不走 gate 机制」] |
| **clarify + ADR 机制** | 稳定 | create→plan 之间的需求/技术澄清，advisory（不阻断 plan），记录 ADR [from: CONTEXT.md 13 action 表] |

测试基线：393 个测试，零 mock 框架，真实 CwStore + tmp 目录 + git 子进程（含 e2e 子进程跑真实 `cw` CLI）。[from: AGENTS.md「测试规范」；README.md「开发」]

当前版本 0.0.1。[from: package.json]

## 非目标（Non-goals）

> **本文件最有价值的章节**——产品边界的有效载体，累积下来即「这个产品明确不做什么」，防止功能蔓延。
> 每条标溯源，便于追溯为何划这条边界。新需求若想推翻某条，须先改本文件 + 加 ADR。

- **不做 agent harness 集成** — CW 是 agent-agnostic CLI，不假设调用方有任何 harness 能力（无 skill 加载、无 workflow 引擎）。agent 只需 bash 调 `cw` + 读 stdout JSON。[from: README.md；AGENTS.md「Agent-agnostic」]
- **不做 IDE 插件** — 命令行工具已足够驱动流程，不做编辑器集成。 [from: 产品定位，CLI-only]
- **不做质量阈值硬性阻断** — gate 熔断只告警不阻断（连续 fail 5 次换熔断文案，但不阻止 agent 继续）。让 agent 自己决定是否继续，CW 只负责提供证据。 [from: README.md「状态机」；ARCHITECTURE.md]
- **不做 tier 分档** — 已砍掉 lite/mid 区分，重构为 lite 单轨（无 tier 字段）。GuardErrorCode 仅 `illegal_transition`。 [from: git log `e59e15a refactor: flatten src/ to lite-only`；CONTEXT.md「8 个 Status」]
- **不做远程服务依赖** — 纯本地，零 True-external 依赖（minimist + git 子进程 + 文件系统）。 [from: ARCHITECTURE.md「外部依赖」]
- **不做代码仓库管理** — 只读 git 做 commit 存在性 + diff-tree 文件校验，不 clone / push / 管分支。 [from: CONTEXT.md「业务边界」]
- **不做 CI/CD 集成** — CW 是 session 级工具（单 topic 生命周期），不是 pipeline 级工具。 [from: 产品定位，session-scoped]

## 路线图

> 已交付的主题里程碑，指向 `.xyz-harness/{主题}/`。进行中的标状态。

| Topic | 里程碑 | 状态 |
|-------|--------|------|
| [cw-cli-extract](./.xyz-harness/cw-cli-extract/) | CW engine 从 pi 扩展抽离为独立 npm 包（`@zhushanwen/coding-workflow`） | delivered [from: git log `d1a7a39 merge: cw-cli-extract`] |
| [cw-refactor-lite](./.xyz-harness/cw-refactor-lite/) | lite 单轨重构：砍 tier/clarify/detail，重构为 lite-only 单轨状态机 | delivered [from: git log `e59e15a refactor: flatten src/`] |
| clarify-stage（ADR） | 新增 clarify 阶段（advisory）+ ADR 机制 | delivered [from: git log `925c642 feat: add clarify stage + ADR mechanism`] |
| CW mechanism levers | 修复 4 个机制杠杆（fuzzy expected / file coverage / TDD self-check / cwd docs）+ 评估指标 Wave 1-5 | delivered [from: git log `01fa904 fix: repair 4 CW mechanism levers`、`66cfe90 feat: add cw stats --all`] |
| [issue-tracking-fix-loop](./.xyz-harness/issue-tracking-fix-loop/) | review/test fix loop 闭环：issue tracking 类型 + store DAO + fix loop handlers + 状态机转换 | delivered [from: git log `915c068`、`f97daec`、`9949535`] |
| post-closeout assess | `cw assess` post-closeout 质量评估（quality/test/stability/defect） | delivered [from: git log `0afa5c8 feat: add cw assess action`] |
| Wave 6（跨 topic 指标） | review 召回率 / 散弹枪修改指数 / 自省准确度等需数据积累的指标 | in-progress（数据已采集，计算逻辑待积累 N 个 topic 后实现） [from: docs/metrics-design.md「待实现」] |

# CONTEXT.md — 统一语言（Ubiquitous Language）

> 本项目：`coding-workflow`（CW）核心 engine 抽离为 agent-agnostic CLI。
> 统一语言跨 requirements / system-architecture 一致使用，避免歧义。

## 领域术语

| 术语 | 定义 | 备注 |
|------|------|------|
| **CW（Coding Workflow）** | 编码流程编排器：状态机 + 机器检查 gate，强制编码任务走 create→plan/clarify→detail→dev→test→retrospect→closeout | 本项目要外置化的核心 |
| **Topic** | 一次编码任务的生命周期单元，含 slug/tier/objective/status/waves/testCases/gateHistory | 状态机的实例 |
| **Action** | CW 接受的 9 种操作之一：create/plan/clarify/detail/dev/test/retrospect/closeout/replan | 每个对应状态机一条转换 |
| **Status（状态）** | Topic 的生命周期阶段：created/planned/clarified/detailed/developed/tested/retrospected/closed | 8 态 |
| **Tier（档位）** | 编码任务的复杂度档：lite（轻量）/ mid（标准） | create 时锁定，不可改 |
| **Gate（机器检查门）** | 每个 action 流转前跑的结构化检查（文件存在/verdict/review 桩/格式锁定/git 追溯等），通过才允许状态流转 | CW 的核心价值 |
| **GateTier（门强度）** | gate 的校验强度：weak-structural / medium-git / medium-coverage / strong-recompute | 由 action + tier 决定 |
| **Engine（核心引擎）** | CW 的纯逻辑层：state-machine + actions + checks + store + gates + plan-parser | 零 pi 耦合，CLI 复用主体 |
| **适配层（Adapter Layer）** | 把 engine 接入某 runtime 的薄壳（当前 pi：src/index.ts 的 registerTool；目标：CLI 入口） | 本轮要新建 |
| **ActionDeps** | engine 的依赖注入接口：store（持久化）/ git（GitValidator）/ runner（GateRunner）/ workspacePath | composition root 构造 |
| **dispatch** | engine 的统一入口纯函数：`(params, deps) => ActionResult` | platform-agnostic，CLI 直调 |
| **ActionResult** | engine 统一返回：topicId/status/gatePassed/nextAction(+mustFix) | CLI 序列化为 JSON 输出 |
| **nextAction** | engine 返回的导航信息：下一步 action + skill 名 + guidance 文本 | CLI 透传给调用方 agent |
| **_cw.json** | topic 状态持久化文件（JSON + 文件锁 + 原子写） | 当前路径 ~/.pi/agent/cw/，CLI 需参数化 |
| **topicDir** | 交付物目录：`{workspacePath}/.xyz-harness/{slug}/` | 存 plan.md/changes/ 等，engine 读盘 gate 据此 |
| **plan.json / clarify.json / detail.json** | skill 阶段产出的结构化 JSON，作为 plan/clarify/detail action 的入参 | typebox schema 校验 |
| **Coding Agent（编码代理）** | CW 的调用方：驱动机器检查流程的 AI agent（如 pi / Claude Code / 其他） | 本轮的 Actor |

<!-- [from: cw-cli-extract] CW engine 抽离为独立 npm 包 @zhushanwen/coding-workflow + CLI 入口（bin=cw） -->

# coding-workflow

Agent-agnostic CLI that keeps AI coding agents on track through a state-machine pipeline: `create → clarify → plan → tdd_plan → dev → review → test → retrospect → closeout`.

CW 不假设调用方有任何特定 agent harness 的能力（无 skill 加载、无 workflow 引擎）。agent 只需通过 bash 调用 `cw`，按返回的 `nextAction.guidance` 推进。guidance 内嵌完整阶段提示词（spec / plan / execute / review / retrospect 方法论），agent 不需要记忆命令列表。

## Quick Start

```bash
npm install -g @zhushanwen/coding-workflow
```

安装后两样东西自动就绪：

1. **`cw` 命令**——全局可用
2. **`cw-cli` skill**——自动安装到 `~/.agents/skills/` 和 `~/.claude/skills/`（通过 postinstall 钩子）

然后让 agent 直接用 `cw-cli` skill 开发即可。agent 会自动调 `cw create` 开始流程，之后按返回的 `nextAction.guidance` 一步步推进到 `closeout`，用户无需干预。

> 要求 Node ≥ 20。

## 它怎么工作

```
created → planned → tdd_inited → developed → reviewed → tested → retrospected → closed
              ↑                    |       |
              └────── replan ──────┘       │
```

agent 调 `cw create` 建一个 topic，之后每次 `cw` 调用返回 `nextAction`——包含下一步该调什么 action（`action` 字段）和怎么做（`guidance` 字段，含完整方法论）。agent 只需按 `nextAction.action` 调下一次 `cw`，直到 `action` 为空（流程结束）。

gate 机制在每个阶段做机器检查（plan 结构、commit 真实性、TDD 红灯、测试结果重算）。gate fail 时 `nextAction.action` 指回当前阶段 retry，并附 `mustFix` 说明原因。

## Skill

agent 的完整操作手册在 [skill/cw-cli/SKILL.md](./skill/cw-cli/SKILL.md)——含入口判断、命令语法、gate fail 恢复、assess 评估、cwd 隔离、失败模式诊断等。

## 本地开发

```bash
git clone https://github.com/zhushanwen321/coding-workflow.git
cd coding-workflow
npm install          # 安装依赖 + 自动 link skill
npm run build
npm link             # 全局 link cw 命令到本地 dist
```

```bash
npm run check:all    # tsc 类型检查（src + tests）
npm test             # vitest run（464 个测试，含真实子进程 e2e）
npm run lint         # eslint src/ tests/
npm run build        # tsc 编译到 dist/
```

测试是真实环境的：零 mock 框架，真实 CwStore + tmp 目录 + git 子进程。

## 文档

| 文档 | 内容 |
|------|------|
| [SKILL.md](./skill/cw-cli/SKILL.md) | agent 操作手册（入口、命令、gate fail、assess、失败模式） |
| [CONTEXT.md](./CONTEXT.md) | 统一语言（13 action / 8 status / 核心架构概念） |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统架构（分层 / 模块划分 / 状态机 / gate 机制） |
| [PRODUCT.md](./PRODUCT.md) | 产品文档（愿景 / 核心用户 / 功能边界 / 非目标 / 路线图） |
| [NFR.md](./NFR.md) | 工程约束（安全 / 数据 / 性能 / 并发 / 稳定性 / 兼容性 / 可观测性） |
| [TEST-STRATEGY.md](./TEST-STRATEGY.md) | 测试策略（金字塔边界 / mock 约定 / 不可回退基线） |
| [DESIGN-LOG.md](./DESIGN-LOG.md) | 设计历史索引（主题台账 / ADR 索引） |
| [docs/metrics-design.md](./docs/metrics-design.md) | 评估指标设计（三层架构 / RuntimeEnv 分组 / 复杂度归一） |
| [docs/metrics-usage.md](./docs/metrics-usage.md) | 评估指标用法（命令 / 输出解读 / 跨 topic 对比 / assess 时机） |

## License

MIT

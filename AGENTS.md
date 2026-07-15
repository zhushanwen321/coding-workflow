# coding-workflow (CW-CLI)

> Agent-agnostic 编码流程编排 CLI。状态机 + 机器检查 gate，强制 AI 编码任务走
> create → clarify → plan → tdd_plan → dev → review → test → retrospect → closeout。
> agent 只需通过 bash 调 `cw` 命令，按返回的 `nextAction.guidance` 推进全流程。

## 常用命令

```bash
npm run check:all   # tsc 类型检查（src + tests）
npm test            # vitest run（444 个测试，含真实子进程 e2e）
npm run lint        # eslint src/ tests/
npm run build       # tsc 编译到 dist/
```

测试是真实环境的：零 mock 框架，真实 CwStore + tmp 目录 + git 子进程。不要在测试里引入 mock 框架。

## 核心约定

- **Agent-agnostic**：engine 不依赖任何 agent harness 能力（无 skill 加载、无 workflow 引擎）。guidance 是纯文本，agent 通过 bash 调 `cw`。
- **guidance 是唯一导航**：所有阶段提示词（spec/plan/execute/review/retrospect）内嵌在 `src/prompts/*.ts`，由 `buildNextAction` 拼入返回的 `nextAction.guidance`。
- **单重 guard**：只有 `checkLinear`（防跳步），无纵深防御。`GuardErrorCode` 仅 `illegal_transition`。
- **gate 熔断不阻断**：连续 fail 5 次后 guidance 换熔断文案，但不阻止 agent 继续重试。
- **纯函数指标**：`stats.ts` 的所有计算都是只读纯函数，无副作用，不依赖外部文件。
- **init 不进状态机**：`cw init` 是 topic 之前的只读基建诊断（与 status/list/stats 同级），扫描文档缺失/骨架态/漂移，返回骨架供 agent 补齐。`create` 时检测缺失在 guidance 引导但不阻断。

## TypeScript 规范

- 禁止 `any`，用 `unknown` 或具体类型
- 独立数据源并行请求用 `Promise.allSettled`
- 穷尽性检查用 `const _exhaustive: never = action`

## 测试规范

- 零 mock：真实 CwStore + tmp 目录 + 真实 git 子进程
- e2e 测试用子进程跑真实 `cw` CLI 命令；拆分到 `tests/e2e-*.test.ts` 系列，共享基建在 `tests/helpers/e2e.ts`（`runCli`/`setupToDeveloped` 等阶段 helper）。编写指南见 [TEST-STRATEGY.md](./TEST-STRATEGY.md)「E2E 测试编写指南」
- 每个 handler 都有 dispatch 层测试（不直接调 handler，走完整 dispatch 路径）

## 文档索引

| 文档 | 内容 |
|------|------|
| [CONTEXT.md](./CONTEXT.md) | 统一语言（13 action / 8 status / 核心架构概念） |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统架构（分层 / 模块划分 / 状态机 / gate 机制） |
| [PRODUCT.md](./PRODUCT.md) | 产品文档（愿景 / 核心用户 / 功能边界 / 非目标 / 路线图） |
| [NFR.md](./NFR.md) | 工程约束（安全 / 数据 / 性能 / 并发 / 稳定性 / 兼容性 / 可观测性） |
| [TEST-STRATEGY.md](./TEST-STRATEGY.md) | 测试策略（金字塔边界 / mock 约定 / 不可回退基线） |
| [DESIGN-LOG.md](./DESIGN-LOG.md) | 设计历史索引（主题台账 / ADR 索引） |
| [docs/metrics-design.md](./docs/metrics-design.md) | 评估指标设计（三层架构 / RuntimeEnv 分组 / 复杂度归一） |
| [docs/metrics-usage.md](./docs/metrics-usage.md) | 评估指标用法（命令 / 输出解读 / 跨 topic 对比 / assess 时机） |
| [docs/architecture-review.md](./docs/architecture-review.md) | 早期架构评审笔记（三层防线设计历史） |
| [docs/architecture-three-layers.md](./docs/architecture-three-layers.md) | 三层防线详细设计（证据层 / 数据源） |

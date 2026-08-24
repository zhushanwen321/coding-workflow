# coding-workflow (cw)

**agent 工作的 CI**：把超出单个 LLM agent 上下文半径的编码任务，分解为可验证单元，用机器证据判定「完成」——系统说 done，就是真的 done，可复算、可重放。发布期验证（typecheck / lint / coverage / CI flaky 判定）由同仓的 gate 域承接：内容寻址缓存消重复、断点续跑、flaky 与真回归机器可判（`cw gate wrap/query/stats`、`cw pipeline run/status`、`cw ci-judge`）。

cw 2.0 是对 1.x 的完全重写。旧版（四层 WorkUnit + 状态机 + 声明推进）的实证问题——串行排队占全链近半、验证可伪造（sed 伪装测试输出）、验收强度无人兜底、先干活后补录——在新结构下被消灭而非收窄。

## 它怎么工作

四个机制，各管一段：

1. **事件账本 + 投影**：状态不存储，只计算（`status = fold(events)`）。append-only 的 `events.log` 是唯一真相源；没有「声明状态」的命令，只有「交证据」的命令——补录结构性不可能。
2. **证据 gate**：spec 提交过五+二确定性规则（验收非空、核心 case 强制 e2e 级、命令可解析……）；完成判定走三道 gate——红阶段（测试必须有区分力）、名字级比对（逐条验收按名字 PASS，不数数）、干净重跑（checkout 账本记录的 commit，隔离环境，系统自己复跑）。伪造成本 ≥ 干活成本。
3. **runner 调度**：确定性循环（frontier → 批次派发 → 等退出 → 证据回收 → 重算），协调权在代码不在 prompt。并行是默认——wall-clock 只受真实依赖与集成验证限制。
4. **两个能力缝 + 集成 verify**：AgentSpawn 缝（起无头 agent 进程：human / pi 后端）与 TestRun 缝（vitest / e2e-sh 适配器，统一 EvidenceReport）可插拔；流程语义焊死。子树全 verified 后，根节点走确定性集成：merge 子树 → 重跑受影响验收 → 跨节点契约机器比对。

概念词典（unit / 验收 / 证据 / 契约 / frontier / 四态退出 / children-first……）见 [CONTEXT.md](./CONTEXT.md)。

## 快速上手

```bash
npm install -g @zhushanwen/coding-workflow
```

要求 Node ≥ 20。安装后 `cw` 命令全局可用。

### pi 扩展（可选）

在 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 主会话内跑 cw 派发循环：

```bash
npx @zhushanwen/pi-coding-workflow-extension install   # 装 pi 会话扩展（loader 自动发现，重启 pi 生效）
cw setup-agent-dir                                    # 建受控 agentDir（~/.cw/agent-dir，供 cw spawn 显式注入）
```

发版 tag 协议：`v*` → 核心包；`ext-v*` → 插件包（`@zhushanwen/pi-coding-workflow-extension`）。

最小流程——人给意图（唯一一次人工输入），之后全自动：

```bash
cd your-project
cw create --id my-feature --brief brief.md   # 创建根 unit，任务书 = 你的意图
cw run --root my-feature --spawn pi          # 触发 runner，派 agent 推进至根 closed
```

runner 会派 designer（建子 + 提 spec + spec-review）→ 并行派 builder 写各叶子 → 机器 verify → 集成 → exec-review，全部证据入账。无头 agent 不可用或想人肉走一遍时用 `--spawn human`：打印每步人该执行的指令，轮询账本推进，验证价值 100% 保留。

### 命令一览（9 个）

| 命令 | 类别 | 用途 |
|---|---|---|
| `cw create --id <slug> --brief <路径> [--parent <id>]` | 写 | 创建 unit |
| `cw evidence submit --unit <id> --kind spec --file spec.json` | 写 | 提交 spec（入账冻结） |
| `cw evidence submit --unit <id> --kind build --commit <hash> --run-id <id> --file <产物>...` | 写 | 提交构建证据 |
| `cw review submit --unit <id> --verdict-kind spec-review\|exec-review --verdict pass\|fail` | 写 | 提交审查结论 |
| `cw verify --unit <id> [--timeout-ms <n>]` | 写 | 干净重跑验证 |
| `cw run --root <id> [--spawn human\|pi] [--poll-ms] [--max-idle-ms] [--max-concurrency]` | 跑 | runner 调度循环 |
| `cw status [--unit <id>] [--json]` | 只读 | 状态视图 |
| `cw frontier [--json]` | 只读 | 就绪集合 |
| `cw tree` | 只读 | 分解树 |
| `cw report [--unit <id>]` | 只读 | 证据链汇总 |

人与 agent 同权：都只能交证据，状态推进的唯一出口是机器验证。

### 环境变量

| 变量 | 作用 | 缺省 |
|---|---|---|
| `CW_HOME` | 存储根目录（每个 cwd 一个独立账本） | `~/.cw` |
| `CW_AGENT_MODEL` | pi 后端派发 agent 用的模型 | `xiaomi-token-plan-cn/mimo-v2.5-pro` |

数据布局：`$CW_HOME/<cwd 编码>/events.log`（账本）+ `evidence/<unitId>/<runId>/`（verify 产物）。详见 [CONTEXT.md](./CONTEXT.md)。

### 后端

`cw run --spawn` 路由到 AgentSpawn 适配器：

- **human**（缺省）：无头环境或人肉模式。打印指令清单，人执行后交证据，runner 轮询账本推进。
- **pi**：起无头 pi 进程（`pi --model <model> -p --no-session @<brief>`），brief 文件传递防注入；超时整树 kill，四态退出归因（exit≠0 / TIMEOUT / CRASH / SPAWN_ERROR），前三种自动重派。

## 架构

engine（无智能、无 spawn）与 runner（同包、确定性调度）两层，依赖单向：

```
cw engine（账本 + 投影 + gate，纯 bash + JSON）
  ├─ 事件账本（append-only 日志 + fold 投影）          src/events/ src/core/ src/store/
  ├─ spec gate（五+二确定性规则）                      src/gates/
  ├─ verify（红阶段 / 名字比对 / 干净重跑 / 契约比对）  src/verify/
  └─ 命令（5 写 4 只读）                               src/handlers/ src/readonly/

cw runner（确定性循环，无智能）
  ├─ 调度循环（frontier → 批次 spawn → 回收 → 重算）   src/runner/loop.ts
  ├─ AgentSpawn 缝（human / pi 适配器）                src/runner/spawn/
  ├─ TestRun 缝（vitest / e2e-sh → EvidenceReport）    src/testrun/
  └─ 集成（merge 子树 → 触发根 verify）                src/runner/integrate.ts

engine 禁止 import runner（依赖单向）
```

设计决策的完整论证（为什么一种 unit、为什么事件投影、为什么验收一等公民、Goodhart 防线、能力缝可插而流程语义焊死）见 canon：[`.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md`](./.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md)。重写过程的全 unit 台账见 [docs/rewrite/ledger.md](./docs/rewrite/ledger.md)。

## 测试

零 mock 哲学：真实账本 + tmp 目录 + 真实 git 子进程；CLI 命令走子进程跑真实二进制（dispatch 层测试不直接调 handler）。当前 230 个测试（以实跑为准），含真实并发 e2e 与真实 pi 后端 E2E。

```bash
npm run check:all    # tsc 类型检查（src + tests）
npm test             # vitest run（真实子进程 e2e）
npm run lint         # eslint src/ tests/
```

## 本地开发

```bash
git clone https://github.com/zhushanwen321/coding-workflow.git
cd coding-workflow
npm install          # 安装依赖（postinstall 同时安装 skills/）
npm run build
npm link             # 全局 link cw 命令到本地 dist
```

统一语言与命令语义以 [CONTEXT.md](./CONTEXT.md) 为准。

## License

MIT

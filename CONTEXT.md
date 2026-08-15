# CONTEXT — 统一语言

> cw 2.0（重写版）的核心概念、命令面与数据布局。本文自包含：不依赖任何对话或外部文档即可读懂。
> 架构决策的完整论证见 canon：[`.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md`](./.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md)。

## 一句话定位

cw 是 **agent 工作的 CI**：把超出单个 LLM agent 上下文半径的编码任务分解为可验证单元，用机器证据（而非 agent 的声明）判定「完成」。job 是 agent 进程，pipeline 定义（分解树 + 验收）本身由 agent 在系统内产出、被机器 gate 看守。

## 核心概念

### unit（单元）

工作的唯一形态：**一种类型、自相似树**（深度上限 2：根 + 叶）。叶子与内部节点的差异只在 build/verify 的含义，不在状态机：

| | build | verify |
|---|---|---|
| 叶子节点 | agent 写代码 | 干净 checkout 重跑该节点验收 |
| 内部节点（根） | runner merge 子树 | 受影响验收重跑 + 跨节点契约比对 |

unit 的定义 = 它的**验收集合 + 契约**（验收是一等工作单元，不是 plan 的附属字段）。

### 验收（Acceptance）

一个单元「完成」的可运行定义：用例 + 执行命令 + 断言。每条用例：

- `id`：unit 内唯一（如 `A1`）
- `core`：是否核心 case（核心 case 强制 e2e 级机器验证，禁 manual）
- `type` 枚举：`unit | integration | e2e-real | e2e-mock | manual`
- `command`：可执行命令（e2e 级用例必填）

弱验收过不了 spec gate（见「spec gate 五+二规则」）。

### 证据（Evidence）

机器可复算的产物：commit hash、测试运行产物文件、重跑日志。`passedCount: 4` 这类声明不是证据。证据以事件入账（`EvidenceSubmitted`，含 runId 幂等键 + 产物 sha256），判定一律以系统自己干净重跑的结果为准。

### 契约（Contract）

跨单元的接口承诺（函数签名 / API / schema），随 spec 一起 hash 冻结，供依赖方对着写；集成 verify 时机器比对（签名 ≡ 冻结 hash）。闭环：designer 产出 → 随 spec 冻结入账 → 内部节点 verify 比对。

### 事件账本（event ledger）

唯一的真相源：append-only JSONL（`events.log`），五类事件：

| 事件 | 载荷要点 |
|---|---|
| `UnitCreated` | unitId、parentId（null = 根）、briefRef |
| `SpecSubmitted` | specHash（冻结锚点）、acceptance[]、contracts[]、split[] |
| `VerdictSubmitted` | verdictKind（spec-review / exec-review）、verdict（pass / fail）、evidenceRefs |
| `EvidenceSubmitted` | runId（幂等键）、commit、paths[]、sha256[]、exitCode |
| `VerifyRan` | runId、reportHash、result（pass / fail）、acceptanceIds[] |

事件一次写入不可改；写账本一律走 cw 命令、由短事务（文件锁）串行化。

### 投影（projection）

**状态不存储，只计算**：`status = fold(events)`（纯函数）。四态：

```
created       = UnitCreated 存在
spec-frozen   = spec 通过机器 gate ∧ spec-review verdict = pass
verified      = 全部冻结验收 verify 通过（内部节点追加：子树集成通过）
closed        = verified ∧ exec-review verdict = pass
```

补录（先干活后走账）在此模型下结构性不可能——没有「声明状态」的命令，只有「交证据」的命令。账本同时是跨上下文记忆：任何 agent 或人只读账本即可零上下文接手。

### spec gate 五+二规则

spec 提交时的确定性检查（多缺口全列、不短路）：

① 验收非空；② core 用例自身 type 必须为 e2e-real / e2e-mock；③ e2e 用例 command 非空且首 token 在 PATH 可解析；④ e2e-mock 附非空 mock 保真度说明；⑤ 至少一条 unit 级用例；⑥ split 不得自引用；⑦ split 声明的子 unit 必须已创建且 parent 匹配（children-first，见下）。

「验收强不强」这类语义判断由独立 reviewer 审，不在机器规则职责内。

### 三道验证 gate

verify（干净重跑）的判定链，共同原则是**伪造成本 ≥ 干活成本**：

1. **红阶段**：新测试打到旧代码树必须挂（不挂 = 测试无区分力，拒绝）
2. **名字级比对**：验收逐条按名字在重跑产物里 PASS，不是「N passed ≥ 用例数」的计数启发式
3. **干净重跑**：干净 checkout 到隔离临时工作区（commit hash 取自账本）+ 独立 CW_HOME，系统自己 spawnSync 复跑

### 集成 verify（内部节点的 verify）

并行的物理前提：每单元可独立验证 + 集成点机器验证。子树全 verified 后，runner 对根执行确定性集成：merge 子树 → 干净重跑受影响验收 → 契约机器比对。集成连续 fail 达 2 次停止自动重派，转派 designer 仲裁契约漂移（fail 审计事件留账）。

### frontier（就绪集合）

对投影算「哪些单元的哪个阶段现在可以派发」：

- `specReady`：状态 created 的 unit（待 spec 提交/审查）
- `buildReady`：状态 spec-frozen 的 unit（待构建证据）

### 四态 spawn 退出

AgentSpawn 契约中子进程退出的四种归因：`exit≠0` / `TIMEOUT` / `CRASH` / `SPAWN_ERROR`。前三者可重派（下轮 frontier 重算自然再次进入派发集合）；SPAWN_ERROR（配置错误，如可执行不存在）不重试。stdout/stderr 由 spawn 实现管道直写产物文件，与 agent 进程存活解耦（SIGKILL 后已输出内容仍在）。

### children-first 工作流

designer 的固定动作序：**先建子、后提 spec**。根 unit 的 designer 首派任务书第 0 步就是创建 split 声明的子 unit；spec gate 规则⑦机器强制（子未建/parent 错配的 spec 被拒）。此工作流消灭「root spec-frozen 等不存在的子」类死锁。

## 命令面速查（9 个）

| 命令 | 类别 | 用途 |
|---|---|---|
| `cw create --id <slug> --brief <路径> [--parent <id>]` | 写 | 创建 unit（深度上限 2） |
| `cw evidence submit --unit <id> --kind spec --file spec.json` | 写 | 提交 spec（过五+二规则后入账冻结） |
| `cw evidence submit --unit <id> --kind build --commit <hash> --run-id <id> --file <产物>...` | 写 | 提交构建证据（commit 经 git cat-file 实存校验，产物 sha256 入账） |
| `cw review submit --unit <id> --verdict-kind spec-review\|exec-review --verdict pass\|fail [--comment <text>]` | 写 | 提交审查结论（append-only，一次写入不可改） |
| `cw verify --unit <id> [--timeout-ms <n>]` | 写 | 干净重跑验证（三道 gate；exit 0 全过 / 1 有 fail / 2 环境错误） |
| `cw run --root <id> [--spawn human\|pi] [--poll-ms <n>] [--max-idle-ms <n>] [--max-concurrency <n>]` | 跑 | runner 调度循环入口 |
| `cw status [--unit <id>] [--json]` | 只读 | 状态视图（fold 投影） |
| `cw frontier [--json]` | 只读 | 就绪集合（specReady / buildReady） |
| `cw tree` | 只读 | 分解树 |
| `cw report [--unit <id>]` | 只读 | 证据链汇总（逐验收覆盖标记 ✓/✗ + hash 前 12 位） |

runner 的角色派发规则（对投影每轮重算）：created 待 spec → designer；spec-frozen 叶子 → builder；verified 未 closed → reviewer（exec-review）；子全 verified 的根 → 不派 agent，直接集成。等待 spawn 期间零锁（否则子进程的 evidence submit 饿死）。中断（Ctrl-C）后重跑 `cw run` 从事件投影续接，已 closed 的单元不重做。

## 环境变量

| 变量 | 作用 | 缺省 |
|---|---|---|
| `CW_HOME` | 存储根目录（per-cwd 隔离的父目录） | `~/.cw`（须绝对路径，相对值报错） |
| `CW_AGENT_MODEL` | pi 后端派发 agent 用的模型（`--model` 参数） | `xiaomi-token-plan-cn/mimo-v2.5-pro` |

## 数据布局

```
~/.cw/                                # CW_HOME（环境变量可覆盖）
└── __Users__you__proj/               # cwd 编码为目录名（/ \ . → __）
    ├── events.log                    # 事件账本（append-only JSONL）
    └── evidence/
        └── <unitId>/<runId>/         # verify 运行产物（账本只记元数据 + sha256）
```

spawn 的 agent 进程产物落被派发工作目录：`<workdir>/.cw-spawn/<unitId>.<role>.stdout|.stderr`。

一个 cwd 对应一个独立账本；换目录即换账本，互不干扰。

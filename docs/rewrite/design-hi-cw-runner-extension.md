# 实施层设计 ph-i2：pi-cw-runner extension（design-hi-cw-runner-extension）

> **当前层 → 下一层**：总纲 D3（A+B 形态）/D4/D5/D6/D11 决策层 → ph-i2 波次的接口/配置/接线规格（extension 入口、引擎库导入面、spawn 后端缝、穿透/反思接线、widget 与命令、降级链）。extension 业务文案（反思七问/任务书模板）不在此层。
> **上游决策链**：D3 A+B（extension import cw 引擎库 + 复用 pi-subagent-workflow 派发——用户裁决 2026-08-24，核心判据 = designer/developer/reviewer 出现在现有 subagent 面板）、D4 穿透三条件、D5 反思 followUp（pi-1 前置）、D11 双层限额、D8 锁（ph-i1 交付）、D12 包结构（ph-i0 交付）。
> **证据基础**：pi 0.84.2 dist 实读（ExtensionAPI/ExtensionContext/ToolDefinition types.d.ts）+ pi-scheduler 入口先例 + npm subagent-workflow 0.3.1 源码实读 + cw 仓 loop/handlers 实读。

**一句话结论**：`pi-coding-workflow-extension` 包内新增 extension 入口（default export `(pi: ExtensionAPI) => void`，pi-scheduler 同款约定）——它把 cw 的 `runLoop` 以库形态 import 进主会话进程（cw 包 `./runner` 子路径导出 + `onEvent` 进度发射器），spawn 后端 = 一个实现 `InteractiveSpawnHandle` 缝的 **subagent-workflow 后端适配器**（经 pi-1 交付的编程 SpawnManager API 派 subagent，天然获得现有面板可见性/取消/watchdog），穿透 = subagent-workflow 8.1.0 同款 ui 转发链直达 ctx.ui，反思 = 同一 handle 的 followUp（ReflectionRan 入账由 loop 完成，ph-i1 事件层复用）；extension 不复制任何 cw 状态机——账本投影仍是唯一权威，`cw run` 无头形态经 runner.lock 与本形态互斥。

## 1. 背景目标

**SCQA**

- **S（情境）**：ph-i0 交付包与安装通道、ph-i1 交付 InteractiveSpawnHandle 缝 + ReflectionRan + 锁；pi-1（xyz-agent 仓）交付 npm 线 subagent-workflow 的 conversation 语义与编程 API。
- **C（冲突）**：现状 cw 派发只在无头 `cw run` 进程里跑——用户主会话在场时：提问到不了用户（F1/F3）、过程只在 subagent 面板之外的黑盒里（F4）、权限裸奔（F5）。
- **Q（问题）**：怎么把已交付的这些件组装成「主会话在场」形态，且不为组装复制 cw 的任何状态机逻辑？
- **A（答案）**：extension = 薄组装层（引擎 import + 后端适配 + UI 接线三件事），其余全部复用。

**系统是什么**（自包含）：pi extension 是 TS 模块（jiti 加载），入口 `export default (pi: ExtensionAPI) => void`，经 `pi.on(...)` 订阅事件、`pi.registerTool/registerCommand` 注册工具与命令、`pi.exec` 跑子进程、ctx.ui（select/confirm/notify/setWidget）触达用户界面（TUI 内联或 xyz-agent GUI——mode 自适应）。cw 的 `runLoop({ rootId, adapter, cwd, maxConcurrency, ... })` 是派发循环库函数（src/runner/loop.ts 导出，handlers/run.ts 是它的 CLI 壳）。

**设计目标**（回溯总纲 G1-G5）：

| # | 目标 | 使用者体验 |
|---|------|-----------|
| E1（G1） | clarify 穿透 | designer 有歧义 → 主会话弹 ask_user（TUI 内联组件 / xyz-agent AskUserOverlay）→ 答案回写 → 落 spec.assumptions |
| E2（G1） | 反思对话原生 | spec 提交后同 subagent 收到七问 followUp（面板里可见追问轮次），自行修订不计打回 |
| E3（G3/用户裁决） | 现有面板可见 | designer/developer/reviewer 各为一条 subagent 记录：进度、完成通知、可取消——**用户裁决的核心理由** |
| E4（G2） | 升级出声 | 停派维度触发 → ctx.ui.notify（桌面 toast 链）+ widget 角标；收件箱条目（ph-i3 补 GUI，先 stderr/notify 兜底） |
| E5（G4） | 不复制状态机 | extension 全部决策读 cw 投影（frontier/events），无第二份状态 |

**in-scope**：extension 入口与生命周期、`./runner` 导出面（onEvent 发射器事件表）、subagent-workflow 后端适配器、穿透/反思接线、`/cw` 命令 + widget、降级链、配置面。
**out-of-scope**：pi-1 本体（xyz-agent 仓，本设计只定它必须暴露的 API 面）、xyz-agent renderer 面板与收件箱 view（ph-i3）、zcode（ph-i4）、brief 模板（四流程）。

## 2. 现状与问题分析

### 2.1 loop 的库化程度现状（实读）

`runLoop(opts)` 已是导出函数，opts 含 `rootId / adapter / cwd / maxConcurrency / pollMs / ...`（handlers/run.ts:180-191 → loop.ts:1072 解构）——**适配器注入缝已存在**。缺口有二：
- **进度无事件**：loop 把轮次/派发/停派信息写 stderr（无人消费的结构化缺口）——extension 拿不到 widget/notify 数据源。
- **生命周期归属**：runLoop 是长驻 Promise，extension 里承载它需要显式的启停管理（会话关闭时的收尾）。

### 2.2 subagent-workflow 能力现状（实读 + pi-1 面）

npm 0.3.1：`action: "start" | "list" | "cancel"`（subagent-tool.ts:61），**无 conversation 字段、无 message 轮次、无编程 API**（工具面向 LLM）。TaiJi 内嵌 8.1.0 已有：进程长驻 + followUp 热路径 + EPIPE 冷恢复 + resumable 持久化（index.js:23258/23290）。**pi-1 必须暴露的编程面（本设计的消费契约）**：

```
import type { SpawnManager } from "@zhushanwen/pi-subagent-workflow"
createSpawnManager(pi: ExtensionAPI): {
  start(opts: { task: string; slug: string; cwd?: string; model?: string;
                tools?: string[]; excludeTools?: string[]; fork?: boolean;
                worktree?: boolean; appendSystemPrompt?: string[]; env?: Record<string,string>;
                maxTurns?: number; idleTimeoutMs?: number }): Promise<SubagentHandle>
  list(): SubagentHandle[]     // 供 extension 状态对账
}
SubagentHandle: {
  id: string; slug: string;
  wait(): Promise<{ status: "done"|"failed"|"cancelled"; ... }>
  message(text: string): Promise<void>      // followUp 热路径（8.1.0 语义）
  cancel(force?: boolean): void
  sessionFile?: string                       // fork/续聊锚
}
```

（契约细节以 pi-1 实施对齐为准，此为消费侧最小面——start 的参数集对齐 8.1.0 工具参数减去 LLM 专用项。）

**已裁定偏差（实施期裁定，adversarial R4 回写）**：因 `@zhushanwen/pi-subagent-workflow@2.0.0` 未发 npm（依赖声明无法静态解析安装），消费侧不采用上图静态 import 形态，改为**探测式动态 import**（宽型 string specifier，防 TS 静态解析 .ts 入口）：`@zhushanwen/coding-workflow/runner`（runLoop 存在性校验）与 `@zhushanwen/pi-subagent-workflow`（包根缺 `createSpawnManager` 命名导出时**回落子路径 `./src/index.ts`**——pi-1 打包实态：包根只 re-export extension default，已回报 pi-1）；两者任一失败 → `/cw start` 拒启 + 安装指引（probe.ts ② ③ 同款探测）。落点：`pi-coding-workflow-extension/src/index.ts` makeDefaultBackend 与 `src/probe.ts`。消费契约本身不变——探测成功后仍以 `createSpawnManager(pi)` 造 SpawnManager。

### 2.3 穿透链现状（总纲已证 + 本层落点）

穿透链七环（ask-user → extension protocol marker → rpc extension_ui_request → 父进程队列 → channel 分流 → stdin 回写）总纲已代码级亲验。**本层落点**：subagent-workflow 的 session-runner spawn 子进程时，ui_request 从子进程 stdout 上浮到 subagent-workflow（8.1.0 已做）→ **但编程 API 消费者（extension）需要拿到这个事件并转发到 ctx.ui**——pi-1 的 SpawnManager 需暴露 `onUiRequest(handleId, req)` 订阅（消费契约补一条，写入 pi-1 任务书）。

### 2.4 问题清单

| # | 缺口 | 本设计对应 |
|---|------|-----------|
| P1 | loop 无进度事件 | §3 R2 onEvent 发射器 |
| P2 | spawn 后端缺 subagent-workflow 适配 | §3 R3 后端适配器 |
| P3 | extension 配置无载体（maxConcurrency 默认 2、探针开关） | §3 R5 配置面 |
| P4 | 会话关闭 = 派发中断的处理未定义 | §3 R1 生命周期 |

## 3. 解决方案

### 3.1 终态（使用者视角）

```
用户（xyz-agent 或 pi TUI 主会话）：/cw start feat-x
  → extension：锁检查（runner.lock，D8/ph-i1）→ 无冲突 →
     runLoop({ rootId, adapter: subagentBackend, onEvent: 接线, maxConcurrency: 2, cwd }) 启动
  → subagent 面板陆续出现：feat-x-designer、feat-x-reviewer、叶级 developer...（E3）
designer 遇歧义：
  → ask_user 穿透 → ctx.ui.select 弹出（TUI 内联 / AskUserOverlay）
  → DialogGlobalQueue 串行（多 unit 并发时排队，D11/HP5）→ 答案回写 → spec.assumptions 落笔
spec 入账：
  → loop 检测 reflectionPending（ph-i1 事件锚）→ 同一 subagent handle.message(七问)
  → 面板内追问轮次可见（E2）→ ReflectionRan 入账 → 派异源 reviewer（excludeTools write/edit，D7）
停派（如 buildDrift）：
  → onEvent({kind:"stopped"}) → ctx.ui.notify「feat-x 转人工」+ widget 角标（E4）
  → /cw report feat-x 查证据链；/cw takeover feat-x → fork 现场 session（D6，ph-i3 收件箱前的命令形态）
用户关闭会话：session_shutdown → extension 收尾（§3 R1）→ 无头 cw run 可续接（锁释放）
```

**失败路径（带恢复指引）**：pi-1 未装/过旧（无编程 API）→ `/cw start` 拒启 + stderr「subagent-workflow ≥<版本> 未安装：npx @zhushanwen/pi-coding-workflow-extension install（会连依赖装入）」；ask-user 探针失败 → designer 任务书自动切自声明形态（任务书注明「本次无提问通道」，D4 降级链）；锁冲突 → stderr 指引（ph-i1 B4 文案）。

### 3.2 方案对比

**R1：extension 生命周期——长驻 runLoop vs 逐轮触发**

| 方案 | 长期 | 短期 | 风险 |
|------|------|------|------|
| **`/cw start` 启动长驻 runLoop Promise，session_shutdown 收尾（kill in-flight 子 handle + 释放锁）** | 高：loop 语义原样（poll 轮询/预算/停派全内置）；与无头形态行为逐字节同源 | 低 | 主会话关闭 = 派发中断——**接受**：D8 锁保证切无头续接（账本续接语义既有）；用户在场本来就是形态选择 |
| 逐轮触发（每轮手动或定时器调 loop 单步） | 低：loop 改单步化（大改），且轮间状态（in-flight）无处放 | 高 | 复制状态机之始 |

裁决 **长驻 runLoop**。session_shutdown 处理顺序：cancel 全部 in-flight subagent handle → 等待 wait() 短超时 → unlink runner.lock → 退出（账本天然续接，无需 checkpoint）。

**R2：onEvent 发射器——事件表最小集**

```typescript
// loop.ts 新增 opts.onEvent?: (ev: LoopEvent) => void（加法，CLI 壳不传 = 行为不变）
type LoopEvent =
  | { kind: "round"; seq: number; frontierSummary: Record<维度, number> }     // widget 数据源
  | { kind: "dispatch"; unitId: string; role: AgentRole; subagentSlug: string } // 面板对账
  | { kind: "settled"; unitId: string; role: AgentRole; result: SpawnResult }
  | { kind: "stopped"; unitId: string; dimension: string; reason: string }     // notify/收件箱源
  | { kind: "reflection"; unitId: string; round: number }                      // 七问已发
  | { kind: "error"; stage: string; message: string }
```

最小集原则：每条都对应一个 UI 消费点（widget/notify/对账），无消费点的不发。**被否**：loop 内直接调 ctx.ui——反向依赖（cw 核心不知道 pi 存在，G4）。

**R3：subagent-workflow 后端适配器**

```
src 归属：pi-coding-workflow-extension/src/subagent-backend.ts（extension 侧件，不进 cw 核心——
  cw 核心 agent-agnostic，D12；pi 依赖只准在插件包）
实现：AgentSpawnAdapter & 返回 InteractiveSpawnHandle（ph-i1 缝契约）
  spawn(req)：SpawnManager.start({ task: <读 briefPath 全文>, slug: `${unitId}-${role}`,
    cwd: req.workdir, env: req.env, tools/excludeTools: 按角色（D7），appendSystemPrompt: 角色人设 })
    → handle 包装：wait()=sm.wait + stdout/stderr 落盘（经 pi.exec? 否——SpawnManager 已落 topic 产物；
      适配器补写 <artifactDir>/<unitId>.<role>.stdout 软链或复制，保 SpawnResult 契约）
  followUp(text)=sm.message(text)（pi-1 followUp 热路径）
  waitForIdle=轮询 sm 状态（8.1.0 idle 语义）或 pi-1 暴露的 onSettled
  onUiRequest=透传 sm.onUiRequest（§2.3 契约）
  done()=stdin EOF 语义映射为 sm cancel(graceful)（subagent 生命周期由 SpawnManager 管，
    适配器 done = 「runner 不再需要此会话」——graceful 收尾而非 kill）
```

**被否**：extension 自研 RPC spawn（ph-i1 的 rpc-client 复用）——放弃现有 subagent 面板可见性（用户裁决的核心理由即此项）；C 薄壳桥接（spawn cw run 子进程）——同因。

**R4：穿透/反思接线**

- designer spawn 参数三条件（D4）：①子进程 --mode rpc（SpawnManager 内部机制，8.1.0 已然）；②受控 agentDir 含 ask-user + tools 白名单含 ask_user；③父进程 = 主会话（extension 形态天然满足）。三者由 `/cw start` 的**启动探针**前置校验（复用 ph-i0 doctor），任一不满足 → 全链降级自声明（不做半通态——「假装有通道比没有更糟」，总纲 D4 被否栏语义）。
- 反思：loop 的反思派发接缝（ph-i1 u-i1-d）调 `handle.followUp(七问)`——后端无关；**subagent 面板里追问以新轮次呈现**（8.1.0 message 语义天然如此）。

**R5：配置面（最小）**

```
优先级：env CW_RUNNER_* > 默认值（无配置文件——首版减法；配置文件留增强位）
CW_RUNNER_MAX_CONCURRENCY：number，默认 2（D11 主会话形态默认，比无头 3 保守）
CW_RUNNER_NO_CLARIFY：置 1 强制全链自声明（探针失败外的手动逃生口）
CW_RUNNER_POLL_MS：number，默认沿用 loop 5000
/cw status 输出当前生效值（含探针结果：ask-user ✓/✗、subagent-workflow API ✓/✗）
```

**被否**：pi extension 专属 config 文件（如 pi-scheduler 的 JSONL 方案）——runner 配置是 cw 域不是 pi 域；cw 侧全局 config 文件——YAGNI，env 够首版。

### 3.3 探针（总纲 HP5 + S1/S6 投影）

| ID | 断言 | 探针 | 失败降级 |
|----|------|------|---------|
| HP5 | 双 designer 并发 clarify 排队 | 2 叶同 design 且任务书诱导同时提问 | DialogGlobalQueue FIFO 呈现；答案各回各进程（S6）——降级 = 派发侧限流 clarify ≤1 |
| PP6 | runLoop 库形态 import 后与 CLI 形态行为同源 | 同账本双跑（CLI 先半程 → extension 续接），frontier 一致 | 修 onEvent/库化改造的回归 |
| PP7 | subagent 面板记录完整（E3 验收） | S1 全程观察面板：三角色 + 追问轮次 + 完成通知 | 面板缺项 = SpawnManager 事件面缺口 → 反哺 pi-1 |

### 3.4 物理数据流（主会话形态全链）

```
用户主 pi 会话（pi TUI / xyz-agent，装 pi-coding-workflow-extension）
  └─ extension（jiti 加载 index.ts）
      ├─ import { runLoop } from "@zhushanwen/coding-workflow/runner"   ← npm 依赖（包内 node_modules，ph-i0 安装；实施态为探测式动态 import，见 §2.2 偏差备注）
      ├─ import { createSpawnManager } from "@zhushanwen/pi-subagent-workflow" ← pi-1（实施态为探测式动态 import + ./src/index.ts 子路径回落，见 §2.2 偏差备注）
      ├─ /cw start → runner.lock（O_EXCL）→ runLoop({...})
      │    ├─ onEvent(round) → ctx.ui setWidget（frontier 摘要）
      │    ├─ 派发 → SpawnManager.start(...) → 子进程（--mode rpc，受控 agentDir env + ask-user）
      │    │     ├─ 面板记录（SpawnManager → pi 主进程 → GUI/TUI subagent 面板）
      │    │     ├─ ask_user → ui_request 上浮 → onUiRequest → ctx.ui 弹窗 → 答案回写
      │    │     └─ 子进程内 cw 命令 → events.log（不变）
      │    ├─ reflectionPending → handle.message(七问) → ReflectionRan 入账（loop，文件锁短事务）
      │    └─ stopped → ctx.ui.notify + widget 角标
      └─ session_shutdown → cancel in-flight → unlock → 退场（无头 cw run 可续接）
```

## 4. 验收（真实场景，非单测）

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|----------------|------|---------|
| C1（E1/E2/E3，总纲 S1 主会话段） | xyz-agent 主会话全链 | 真实 root+2 叶从 `/cw start` 到 root closed | ① ≥1 次 clarify 真实弹出 AskUserOverlay 且答案在 spec.assumptions；② 反思经 message 发生（subagent pid 不变 + 面板追问轮次可见）；③ 三角色全部出现在 subagent 面板且完成通知正常；④ ReflectionRan 每叶入账；⑤ root closed |
| C2（E5，总纲 S3 段） | 双形态续接 | 无头 `cw run` 跑半程 Ctrl-C → 主会话 `/cw start` 续接 | frontier 投影一致、closed 不重做；反序（extension 先 → 无头续）同样成立；双 runner 并发后者被锁拒启 |
| C3（总纲 S6） | 并发 clarify 排队 | 双叶 design 同时提问 | 第二问排队不丢不混，答案各回各进程 |
| C4（降级负面，总纲 S2 段） | 探针失败降级 | 卸载 ask-user 后 `/cw start` | 启动探针拒派或全链切自声明（任务书注明无通道），spec.assumptions 照常入账；无「问题发出后无人应答」的假通道态 |
| C5（E4） | 停派出声 | 构造 buildDrift（连挂 ×5） | 桌面 toast + widget 角标 + `/cw report` 可查；处置入账后自动续派 |

## 5. 下一层拆分（ph-i2 内 unit 清单）

| unit | 内容 | justification | 验收锚 |
|------|------|---------------|--------|
| u-i2-a | cw 侧：runLoop 库化（onEvent + `./runner` 导出实装 + stdout/stderr 产物路径注入 seam） | 纯 cw 核心改动，独立可测（CLI 形态回归 PP6）；extension 未动前零风险 | PP6 |
| u-i2-b | subagent-backend.ts（SpawnManager → InteractiveSpawnHandle 适配）+ 启动探针 | 依赖 pi-1 与 u-i2-a；缝适配独立验收（mock-free：真实 SpawnManager 跑真实子进程） | C1 ①③ 段 |
| u-i2-c | extension 入口（/cw 命令组：start/status/report/takeover/stop + widget + notify 接线 + 生命周期收尾 + 配置面） | 组装层最后成型；依赖 a+b | C1 全、C4、C5 |

**文件改动地图**：cw 核心仓 `src/runner/loop.ts`（onEvent + 库化收口）、`package.json`（`./runner` 实装指向）；插件包 `pi-coding-workflow-extension/`：`src/index.ts`（入口）、`src/subagent-backend.ts`、`src/probe.ts`（启动探针）、`src/commands.ts`（/cw 命令组）、`src/widget.ts`。

**待验证检查点（诚实标注）**：① pi-1 的 SpawnManager API 面是本设计的消费契约（§2.2/2.3），其实施对齐可能微调字段——两仓 ledger 互指；② SpawnManager 的 stdout 产物落盘与 cw SpawnResult 契约（stdoutPath 必须真实存在）的对接方式（复制 vs 符号链）在 u-i2-b 实施期定；③ `/cw takeover` 的 fork 现场 session 依赖 pi fork 语义（session-manager.ts:1580-1631 已证），命令形态为首版最小实现，GUI 收件箱接管按钮在 ph-i3；④ DialogGlobalQueue 在 xyz-agent GUI 的排队呈现细节（HP5 观察项）可能反哺派发侧限流决策（D11 预留）。

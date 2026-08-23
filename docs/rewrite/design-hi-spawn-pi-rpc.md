# 实施层设计 ph-i1：pi-rpc 适配器 + ReflectionRan 事件 + runner.lock（design-hi-spawn-pi-rpc）

> **当前层 → 下一层**：总纲 D2/D5/D8/D1 决策层 → ph-i1 波次的接口/协议/数据模型规格（薄 RPC client、SpawnHandle 接口演进、事件 schema、锁文件格式、错误规格）。函数体级实现不写。
> **上游决策链**：D2 自研薄 RPC client（exports 阻断实测）、D5 反思 followUp + ReflectionRan 事件锚、D8 跨进程派发锁、D1 受控 agentDir 注入形态（安装基建见 design-hi-monorepo-split.md）。
> **证据基础**：cw 仓实读（spawn/types.ts、pi.ts、handlers/run.ts、loop.ts、fold.ts、events/types.ts、frontier.ts）+ pi 0.84.2 dist 实读（rpc-types.d.ts、rpc-client.d.ts、loader.js）+ 消费者侧 import 阻断实测（ERR_PACKAGE_PATH_NOT_EXPORTED）。推断与证实分离标注。

**一句话结论**：新增 `src/runner/spawn/pi-rpc.ts`——薄 RPC client 自研（五命令子集 + 事件流 + id 关联，约 200 行，xyz-agent rpc-client.ts 同款先例）；`AgentSpawnAdapter` 缝契约演进为 `InteractiveSpawnHandle`（+followUp/waitForIdle/uiRequest 转发钩子，一次性适配器不受影响——接口扩展不破坏既有实现）；`ReflectionRan` 定为**第六类事件类型**（append-only 哲学下唯一可行形态——历史事件不可回填，可选字段方案物理不成立）；runner.lock 为 `<CW_HOME>/runner.lock` 心跳文件 + 陈锁抢占协议；适配器路由表因 `pi-rpc` 的工厂名拼接约定失效改显式注册表。

## 1. 背景目标

**SCQA**

- **S（情境）**：总纲已定：cw 需要长驻 pi 子进程（反思 followUp、穿透提问、确定性 session 锚），无头形态 `cw run --spawn pi-rpc` 是主会话 extension 形态（ph-i2）之外的第二形态；D12 已定适配器留 cw 核心。
- **C（冲突）**：现有 pi 适配器是 `pi -p` 一次性 print 模式（src/runner/spawn/pi.ts:80-92）：无回传通道（F1 designer 不能提问）、无长驻会话（F2 反思靠 session mtime 考古）、无确定性锚（get_state 拿不到）。且 pi 官方 RpcClient 未通过 exports 公开（实测阻断），npm 生态里 xyz-agent 已自研同款薄 client 证明可行。
- **Q（问题）**：怎么以最小接口侵入把「长驻 + followUp + ui 转发 + session 锚」四能力加进 cw 的 spawn 缝，同时让一次性适配器（human/pi）与未来后端（ph-i2 的 subagent-workflow 后端）共享同一缝契约？
- **A（答案）**：SpawnHandle 扩展为可选交互能力的分层接口 + 薄 RPC client 五命令子集 + 第六类事件 + 心跳锁。

**系统是什么**（自包含）：cw runner 每轮从账本投影算 frontier，对就绪 unit 派角色子进程（designer/developer/reviewer）。派发经 `AgentSpawnAdapter` 缝（src/runner/spawn/types.ts:48-57）——现有 human/pi 两实现，`pi.ts` 拼 `pi --model <m> -p --session-dir <dir> --name <id>-<role> @<brief>`（pi.ts:80-92）一次性跑完即死。适配器返回 `SpawnHandle { wait(): Promise<SpawnResult>; kill(): void }`，四态退出（exit≠0 / TIMEOUT / CRASH / SPAWN_ERROR）。

**设计目标**：

| # | 目标 | 使用者/开发者体验 |
|---|------|-----------------|
| K1 | 长驻会话 | designer 提交 spec 后进程存活，runner 能对同一进程发反思追问（D5），不再 mtime 考古 |
| K2 | 穿透转发就位 | 子进程 ask_user 的 `extension_ui_request` 事件到达适配器时可被转发（无头形态自动应答 cancelled + 告警；主会话形态由 ph-i2 后端接管转发） |
| K3 | 确定性 session 锚 | spawn 握手后 sessionId/sessionFile 精确已知，写入 spawn 产物与事件 |
| K4 | 缝契约稳定 | human/pi 两既有适配器零改动编译通过；新能力全部是**可选接口扩展** |
| K5 | 跨形态互斥 | `cw run`（无头）与 pi-cw-runner（主会话，ph-i2）对同一账本不并发派发（D8） |

**in-scope**：`src/runner/spawn/pi-rpc.ts` + `src/runner/spawn/rpc-client.ts`（薄 client）、types.ts 接口演进、BACKEND_SPECIFIERS 路由改造、ReflectionRan 事件与 fold/frontier 联动、runner.lock、`--spawn pi-rpc` / `--force-dispatch` CLI flag。
**out-of-scope**：subagent-workflow 后端适配器（ph-i2——但本设计的 InteractiveSpawnHandle 是它要实现的缝）、pi-1 conversation 回合（xyz-agent 仓，验收锚 HP2 依赖它）、brief 模板内容（四流程 ph-2）。

## 2. 现状与问题分析

### 2.1 适配器缝现状（实读）

```typescript
// src/runner/spawn/types.ts:48-57（现状，一字未改引用）
export interface AgentSpawnAdapter {
  name: string;
  spawn(req: AgentSpawnRequest): Promise<SpawnHandle>;
}
export interface SpawnHandle {
  wait(): Promise<SpawnResult>;
  kill(): void;
}
```

`AgentSpawnRequest` 关键字段：role / unitId / workdir / projectCwd / artifactDir / briefPath / env / timeoutMs（必填，runner 固定 30min）。**该接口表达不了多轮**——`wait()` 语义是「等这个子进程干完活退出」，而反思形态需要「首轮完成 → 进程存活 idle → 追加输入 → 再等」。

### 2.2 路由机制现状（实读 + 一个实测缺陷）

```typescript
// src/handlers/run.ts:60-66（现状）
const BACKEND_SPECIFIERS: Record<string, string> = {
  human: "../runner/spawn/human.js",
  pi: "../runner/spawn/pi.js",
};
// resolveSpawnAdapter（run.ts:82-108）：动态 import 后按
// `record[`${name}Adapter`]`（常量形态）或 `record[`create${capitalize(name)}Adapter`]`（工厂形态）探测
```

**缺陷**：`capitalize("pi-rpc")` 产出 `"Pi-rpc"` → 拼出 `createPi-rpcAdapter`——非法标识符，工厂探测**必然失败**。新增 `pi-rpc` 后端必须改路由机制（§3 R2）。

### 2.3 RPC 协议面现状（pi 0.84.2 dist 实读）

- **命令层**（rpc-types.d.ts，32 条 stdin JSON 命令，全部带可选 `id` 关联）：本设计使用子集五条——`prompt`（message + 可选 streamingBehavior:"steer"|"followUp"）、`follow_up`（message）、`steer`（message）、`abort`、`get_state`（返回 RpcSessionState：sessionId / sessionFile / isStreaming / messageCount 等）。
- **事件层**（stdout JSONL 流）：`agent_settled`（waitForIdle 的 resolve 锚）、`extension_ui_request`（九种 method：select/confirm/input/editor/notify/setStatus/setWidget/setTitle/set_editor_text；应答经 stdin `extension_ui_response`：value / confirmed / cancelled 三形态）、命令 reply（按 id 关联）。
- **进程语义**：stdin EOF 优雅退出；`--mode rpc` 模式。
- **阻断实测**：消费者 bare import `@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js` → `ERR_PACKAGE_PATH_NOT_EXPORTED`（exports 仅 `./`、`./rpc-entry`、`./client`；`./client` 是 CBOR 传输的 PiClient，非本场景）——**自研是唯一路径**，xyz-agent packages/runtime/src/infra/pi/rpc-client.ts 为同款先例（约 200-300 行实现同等能力）。

### 2.4 事件账本现状（实读，ReflectionRan 的兼容性约束）

- 五类事件信封 `{ seq, ts, type, payload }`（events/types.ts:183-194），`EventType` 联合类型驱动。
- **fold 穷尽性检查**（core/fold.ts:111-113）：`default: { const _exhaustive: never = event; throw new Error("fold: 未知事件类型") }`——**旧版 cw 读含新事件类型的账本会显式抛错**（不是静默跳过——这是有意设计：事件流被外部改动或版本超前的信号）。
- 先例：`VerifyRan.parseFailedAcceptanceIds`（可选字段，旧账本缺字段 = 无）——**字段级**向后兼容的既有模式；但 ReflectionRan 若走「SpecSubmitted 加可选字段」路线物理不成立：append-only 账本不能回填历史事件，反思发生在 spec 入账**之后**，只能以新事件表达。

### 2.5 锁现状

loop 的同 unit in-flight gate（loop.ts:184-194，key=unitId）是**进程内**状态；ph-i2 引入第二形态后，两进程对同一账本（`~/.cw/<encoded-cwd>/events.log`）无互斥——双派发 = 同 unit 双 spawn = worktree reset 互清现场（总纲 D8 证据）。

## 3. 解决方案

### 3.1 终态（时序视角）

**正常时序（designer spawn + 反思 followUp）**：

```
runner(loop)                        pi-rpc 适配器                     pi 子进程(--mode rpc)
   │ spawn(req) ─────────────────────→ │                                  │
   │                                   │ 起进程（args 见 R3）────────────→ │ 启动，stdout 事件流
   │                                   │ get_state(id=g1) ───────────────→ │
   │                                   │ ←──── reply(g1): sessionId/file  │ ←── 写 spawn 产物锚文件
   │                                   │ prompt(brief 全文) ────────────→ │ designer 读任务书干活
   │                                   │ ←──── agent_settled              │（spec 提交经子进程内 cw 命令入账）
   │                                   │ waitForIdle() resolve            │
   │  loop 检测 SpecSubmitted + 无 ReflectionRan → 调 handle.followUp(七问)
   │                                   │ follow_up(反思文案) ───────────→ │ 同一进程答问，上下文全保留
   │                                   │ ←──── agent_settled              │
   │  loop 写 ReflectionRan 事件（payload 见 R4）→ 派 reviewer
   │  handle.done() → 适配器 stdin EOF / stop ───────────────────────────→│ 优雅退出
```

**穿透时序（子进程 ask_user）**：

```
子进程 ask_user ──extension_ui_request(select)──→ 适配器 onUiRequest 钩子
  ├─ 无头形态（默认）：适配器自动回 { cancelled: true } + stderr 告警「无 UI 通道，已取消」
  └─ 主会话形态（ph-i2 注入钩子）：转发给 pi-cw-runner → ctx.ui 弹窗 → 答案经 extension_ui_response 回写
```

**失败路径（带恢复指引）**：握手超时（get_state 5s 无 reply）→ 返回 SPAWN_ERROR + stderr「pi rpc 握手失败：检查 `pi --version` ≥0.84 / PI_CODING_AGENT_DIR 指向有效目录 / --extension 路径存在」；中途 EPIPE（子进程崩溃）→ 冷恢复由上层（loop 反思崩溃路径，D5 降级）决定 `--fork sessionFile` 重 spawn 或按 CRASH 重派。

### 3.2 方案对比

**R1：SpawnHandle 接口演进——可选扩展 vs 新接口**

| 方案 | 长期 | 短期 | 风险 |
|------|------|------|------|
| **可选扩展**：`interface InteractiveSpawnHandle extends SpawnHandle { followUp(text): Promise<void>; waitForIdle(ms): Promise<boolean>; onUiRequest(cb): void; done(): Promise<SpawnResult>; sessionAnchor?: {...} }`，`AgentSpawnAdapter.spawn` 返回类型仍 SpawnHandle，loop 用类型守卫探测 | 高：human/pi 零改动（K4）；能力探测显式（不支持的适配器被追问时给明确错误而非静默） | 低 | 无——TS 结构类型下守卫可靠 |
| 新顶层接口 `AgentSessionAdapter` 替代 | 低：两套并行缝，路由层要双态 | 中 | 缝契约分裂（违背 types.ts 头注「已有定义不得改名改义」——扩展是加法，替换是破坏） |

裁决 **可选扩展**。pi-rpc 适配器返回 InteractiveSpawnHandle；ph-i2 的 subagent-workflow 后端实现同一扩展接口（两类后端同缝，总纲 D12 已声明）。

**R2：适配器路由——显式注册表 vs 继续命名探测**

| 方案 | 长期 | 短期 | 风险 |
|------|------|------|------|
| **显式注册表**：`BACKEND_SPECIFIERS` 改 `Record<string, { specifier: string; factory: string }>`，工厂名写死不拼 | 高：`pi-rpc`/`zcode` 等带连字符名自然支持；探测失败原因明确 | 低（run.ts:60-66/82-108 局部改） | 无 |
| 命名探测打补丁（capitalize 处理连字符） | 低：约定脆弱，每个新后端都要懂这个隐式规则 | 低 | 后续 zcode 后端继续踩 |

裁决 **显式注册表**（run.ts 小改，ph-i1 范围内）。

**R3：spawn 参数与受控环境**

args 拼接（对齐 xyz-agent rpc-client.ts:123-142 先例 + D1）：

```
pi --mode rpc --no-extensions --approve
   --extension <CW_AGENT_DIR>/extensions/ask-user/index.ts   （designer 角色；developer/reviewer 不装）
   --tools <角色白名单>                                        （reviewer: 排除 write/edit——D7 近期形态）
   --session-dir <artifactDir> --name <unitId>-<role>
env: PI_CODING_AGENT_DIR=<CW_AGENT_DIR>（缺省 ~/.cw/agent-dir，由 ph-i0 setup 建立）
```

brief 经 stdin `prompt` 命令全文注入（替代 `@file` 拼接——RPC 模式下 prompt 就是消息体，无文件引用歧义）。

**R4：ReflectionRan = 第六类事件类型（唯一可行形态）**

```typescript
// src/events/types.ts 新增（字段级规格）
export interface ReflectionRanPayload {
  unitId: string;
  /** 被反思那版 spec 的入账锚 hash（重提新 spec = 新 hash = 需重新反思，spec 级语义） */
  specHash: string;
  /** unit 级轮次，1 起（预算 ≤2 轮，四流程 D3③ 语义） */
  round: number;
  /** 反思发生时的 session 锚（审计用，非定位用——定位已由事件本身承担） */
  sessionFile?: string;
  /** followUp 全文是否引发 spec 修订（修订会有新 SpecSubmitted，此字段仅审计摘要） */
  revisedSpec?: boolean;
}
// EventType 联合 + EventPayloadMap + fold switch 加 case（纯记录事件，不驱动状态转换）
// frontier reflectionPending 判定：最新 SpecSubmitted 的 specHash 无对应 ReflectionRan → pending
```

**兼容语义（必须写明）**：新版 cw 读旧账本 OK（无 ReflectionRan 即无反思，reflectionPending 对旧 unit 恒走四流程原判定）；**旧版 cw 读新账本 → fold 显式抛错**——这是有意的升级边界而非事故：错误消息指引「账本包含新版事件（ReflectionRan），请升级：npm i -g @zhushanwen/coding-workflow@latest」。与四流程 D11 代际信号的关系：ReflectionRan 事件本身即该 unit 的新 schema 痕迹之一，四流程 ph-1 落地时把本事件纳入 `hasNewSchemaSignal` 痕迹集（**交汇点：ph-i1 与 ph-2 的事件层协调项，写进两波 ledger**）。

**R5：runner.lock 规格**

```
路径：<CW_HOME>/<encoded-cwd>/runner.lock    （与 events.log 同目录，CW_HOME 语义见 CONTEXT.md）
格式（JSON，单行原子写）：
{ "pid": 12345, "form": "cli" | "extension", "rootId": "<root-unit-id>",
  "startedTs": "ISO-8601", "heartbeatTs": "ISO-8601" }
心跳：派发循环每轮（poll 间隔，缺省 5s）重写 heartbeatTs
获取：启动时 exclusive create（O_EXCL）；已存在 → 读锁：
  - pid 活着（process.kill(pid,0) 探测）→ 拒启，stderr 指引：
    「已有 <form> 形态 runner（pid X）在派发本账本；确认接管 = cw run --force-dispatch」
  - pid 已死（陈锁）→ 视为可抢占：覆盖写 + stderr 告警「检测到陈锁（form X，最后心跳 T）已接管」
--force-dispatch：跳过存活检查强制覆盖（用户显式接管通道）
释放：正常退出 / SIGINT / SIGTERM 时 unlink（process 退出钩子）；崩溃残留走陈锁抢占路径
不入账本：锁是易失进程态非事实（总纲 D8 已裁决）
```

**R6：薄 RPC client 模块边界**

```
src/runner/spawn/rpc-client.ts（新，无 pi 依赖，纯协议实现）
  createRpcClient({ command, args, env, cwd, onEvent }): {
    send(cmd): Promise<reply>          // id 自动分配与关联，reject on error reply / 超时
    prompt(text): Promise<void>        // 便捷封装
    followUp(text): Promise<void>
    steer(text): Promise<void>
    abort(): Promise<void>
    getState(): Promise<RpcSessionState>  // 类型从本仓自声明（不 import pi 包——协议子集的对侧镜像）
    waitForIdle(ms): Promise<boolean>  // 订阅 agent_settled
    onUiRequest(cb): void              // extension_ui_request 订阅
    respondUi(id, resp): void          // 三形态应答写入
    stop(): Promise<void>              // stdin EOF 优雅退出
    kill(): void                       // SIGTERM（lifecycle 梯度兜底）
  }
协议常量：命令 type 字符串、事件 type 字符串集中在模块顶部 export const（HP6 版本握门的比对源）
```

### 3.3 探针（总纲 HP1-3 的本波次落点）

| ID | 断言 | 探针 | 失败降级 |
|----|------|------|---------|
| HP1 | 受控 agentDir + rpc spawn + ask_user 全链（pi TUI 侧） | 最小脚本：pi-rpc spawn 子进程任务书「问用户一个问题并复述答案」，TUI 手动应答 | 总纲已定：clarify 降级自声明形态常驻 |
| HP2 | conversation 长驻 + followUp + EPIPE 冷恢复（npm 线，**pi-1 后**） | 起 RPC 会话 → followUp → kill -9 → --fork 恢复 | 反思改独立 spawn 带 --fork |
| HP3 | 无头父进程时 ask_user 行为 = cancelled + 告警 | pi-rpc 无头 spawn 含 ask_user 子进程 | 无降级（锁回归） |
| HP-lock | 双 runner 互斥 | 两进程并发 `cw run`，第二进程拒启 + 陈锁（kill -9 第一进程后）可抢占 | 无降级 |

### 3.4 物理数据流（无头形态全链）

```
cw run（无头 node 进程，持 runner.lock）
  → pi-rpc 适配器 spawn pi 子进程（受控 agentDir env + --extension 注入）
      子进程 stdin ←── prompt/follow_up/steer/abort/extension_ui_response（JSON 行）
      子进程 stdout ──→ JSONL 事件流（reply by id / agent_settled / extension_ui_request）
        → reply/settled → 适配器 Promise resolve → loop 决策
        → ui_request → 无头默认 cancelled 应答；ph-i2 后端注入转发钩子
      子进程 stderr → <artifactDir>/<unitId>.<role>.stderr（append，照旧）
  → loop 每轮重读 events.log → fold → frontier（含 reflectionPending 事件锚）
  → 反思完成 → loop 经文件锁短事务写 ReflectionRan（append-only，seq 续接）
```

## 4. 验收（真实场景，非单测）

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|----------------|------|---------|
| B1（K1/K3） | 长驻 + 反思 followUp 真实链 | 真实账本建 root+叶，`cw run --spawn pi-rpc`（human 模式或 pi），designer 提交 spec 后观察反思 | ① 反思追问发出后**子进程 pid 不变**（ps 验证）；② ReflectionRan 入账且 specHash/round 与账本对账一致；③ spawn 产物锚文件含 get_state 取回的 sessionId/sessionFile 且与账本 audit 一致 |
| B2（K2 负面） | 无头穿透降级 | designer 任务书含「有歧义必须 ask_user 提问」 | ui_request 到达即自动 cancelled；stderr 有告警行；designer 收到取消后转 assumptions 自声明（spec.assumptions 非空） |
| B3（K4） | 缝契约不破 | `npm run check:all` + 全量测试 | human/pi 适配器零改动通过；既有 674 用例全绿（回归） |
| B4（K5） | 双 runner 互斥（总纲 S3 子场景） | 进程 A `cw run` 起跑 → 进程 B 同账本再启；kill -9 A 后 B 重启；`--force-dispatch` 路径 | B 拒启 + 指引文案；陈锁可抢占 + 告警；force 覆盖成功；三路径 stderr 文案均含恢复动作 |
| B5（总纲 S2 子场景） | 环境缺失拒派 | 删掉受控 agentDir 的 ask-user 后 `cw run --spawn pi-rpc` | 启动探针拒派，stderr 给安装命令；不产生任何 spawn 产物 |

## 5. 下一层拆分（ph-i1 内 unit 清单）

| unit | 内容 | justification | 验收锚 |
|------|------|---------------|--------|
| u-i1-a | rpc-client.ts（薄 client 全量）+ 协议常量 + 单测（真实子进程 echo 协议桩——用 pi 本体做桩，零 mock） | client 是适配器与 ph-i2 后端的共同地基，独立可测 | B1 握手段 |
| u-i1-b | pi-rpc.ts 适配器 + InteractiveSpawnHandle 接口 + 路由显式注册表改造 | 依赖 u-i1-a；接口演进与路由改造同 unit（同文件群，拆开留编译断档中间态） | B1、B2、B3 |
| u-i1-c | ReflectionRan 事件 + fold case + frontier reflectionPending 事件锚 | 事件层独立于适配器（写入方是 loop）；与四流程 ph-1 的协调项在此 unit 落 ledger | B1 ②③ |
| u-i1-d | runner.lock + `--force-dispatch` + 陈锁抢占 | 独立机制，最后接（ph-i2 前必须就位） | B4 |

**文件改动地图**：`src/runner/spawn/rpc-client.ts`（新）、`src/runner/spawn/pi-rpc.ts`（新）、`src/runner/spawn/types.ts`（+InteractiveSpawnHandle）、`src/handlers/run.ts`（路由注册表 + flag）、`src/dispatch.ts`（--spawn 枚举 + --force-dispatch）、`src/events/types.ts`（+ReflectionRanPayload）、`src/core/fold.ts`（+case，纯记录）、`src/readonly/frontier.ts`（reflectionPending 事件锚）、`src/runner/loop.ts`（锁获取/心跳/释放 + 反思派发接缝）。

**待验证检查点（诚实标注）**：① HP1 依赖 pi TUI 侧手动应答（xyz-agent RPC 侧链路总纲已证，TUI 侧探针为准）；② `agent_settled` 与命令 reply 的**时序竞争**（settled 先于 reply 到达时 waitForIdle 的语义）需在 u-i1-a 用真实 pi 实测锁定——协议文档无此细节描述；③ pi-1（npm 线 conversation）在 xyz-agent 仓排期，若晚于本波次，B1 的 followUp 段以「pi-rpc 适配器直连」验证（不经 subagent-workflow），HP2 顺延。

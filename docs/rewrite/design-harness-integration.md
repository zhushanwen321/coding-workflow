# cw × pi/xyz-agent 深度整合设计（harness 集成架构）

> **当前层 → 下一层**：整合架构层 → 可实施的接口/适配器技术方案层（§5 拆分清单）。不设计到函数签名。
> **口径前提（已定）**：① cw 内核（事件账本 + fold 投影 + spec gate + verify 三道 gate + 9 命令面）保持 agent-agnostic 纯 CLI，一字不动——本设计只动 spawn 适配器层与出声通道。② pi + xyz-agent 为整合主线（可定制度最高），zcode 为第二战场（降级体验，仿建跟随）。③ 四流程设计（design-4phase-process.md）的内核决策（built 态 / verify stage / mock 收紧 / closeout / 代际信号）与本设计正交，原样推进；本设计替换的是其编排传输层（D3 反思的 session 考古、D12 混合模式的双世界拼接）。
> **证据基础**：本设计的运行时断言全部来自 2026-08-23 两组源码调研（pi 0.84.2 dist + xyz-agent/main + ZCode.app 3.8.1），关键链路代码级亲验，文中锚点均带 file:line；推断与证实严格分离标注。

**一句话结论**：cw 编排层从「无头后台 CLI + `pi -p` 一次性 spawn」迁移为「跑在用户主 pi 会话内的 pi-cw-runner extension + RPC 长驻子进程」——一举解锁 clarify 穿透提问（ask_user 链）、对话原生反思（followUp 热路径）、确定性 session 锚（get_state）、可靠升级出声（toast + 收件箱）；cw 内核与账本不动，`cw run` CLI 保留为无头兜底形态。

## 1. 背景目标

**SCQA**

- **S（情境）**：cw 2.0 已完成 M0-M6（账本 + fold + runner + 13 frontier 维度），四流程重构设计已定稿（design-4phase-process.md）；pi 生态侧已有 xyz-agent 桌面工作台（Electron + Vue3 + Node runtime，内嵌 pi RPC）、20 个 pi extension（ask-user / subagent-workflow / permission / scheduler / cw-tool 等）。
- **C（冲突）**：cw runner 以 `pi -p` print 模式 spawn **全局 pi** 一次性子进程——无用户回传通道（designer 物理上无法提问，用户实证从未被问过）、反思要靠 session 文件 mtime 考古、转人工出声打在无人看的 stderr。调研证实全局 pi 恰是三套 pi 运行时中能力最弱的一套（§2.1）：没有 subagent、没有 ask-user、没有 permission（悬空 symlink 静默跳过）。
- **Q（问题）**：怎么让 cw 的编排层用上 pi/xyz-agent 已被代码证实的能力面（RPC 32 命令 / ask_user 穿透链 / conversation 长驻 / Preset 权限 / toast 链），同时不把 cw 内核绑死在自己不可控的上游（badlogic/pi-mono，MANDATORY 不 fork 不提 PR）？
- **A（答案）**：分层整合——内核层不动；编排层迁入用户主 pi 会话（pi-cw-runner extension）+ spawn 适配器升级 RPC 长驻；体验层在 xyz-agent 做 unit 树面板与升级收件箱；zcode 侧以 spawn 适配器获得降级形态。

**系统是什么**：cw（`@zhushanwen/coding-workflow`）是「agent 工作的 CI」——把超出单个 LLM agent 上下文半径的编码任务分解为可验证 unit，用机器证据（append-only 事件账本）判定完成；runner 循环派发 designer/developer/reviewer 三种角色的 agent 子进程。pi 是上游 coding agent harness（npm `@earendil-works/pi-coding-agent`，本机全局 0.84.2）；xyz-agent 是内嵌 pi 的 Electron 桌面工作台（太极/TaiJi.app）。

**设计目标**（从使用者体验倒推）：

| # | 目标 | 使用者体验 |
|---|------|-----------|
| G1 | design 对话原生 | designer 有歧义时直接弹提问到用户界面（xyz-agent AskUserOverlay / pi TUI 内联组件），用户作答回流；spec 提交后反思追问在同一会话内发生，零文件考古 |
| G2 | 升级一等公民 | 任何环预算耗尽 → 桌面 toast + 升级收件箱持久条目 + 证据链链接 + 一键接管（fork 现场会话）；不再依赖盯 stderr |
| G3 | 过程可观测 | xyz-agent 侧边栏常驻 unit 树面板（四流程分桶 + 实时刷新）；pi TUI 有 setWidget 状态行 + `/cw` overlay |
| G4 | 内核零改动 | cw 账本/fold/gate/verify/9 命令面不变；旧账本重放语义不变；整合全部发生在 spawn 适配器与出声通道 |
| G5 | 双 harness 形态 | pi 主线全能力；zcode 第二战场降级形态（编排可用、穿透提问绕行、通知被动回流） |

**in-scope**：cw spawn 适配器层（新增 pi-rpc / zcode）、pi-cw-runner extension、npm subagent-workflow conversation 回合、反思/升级通道改造、xyz-agent 面板与收件箱、运行时环境收敛、命名治理。
**out-of-scope**：cw 内核（账本 schema/fold/gate/verify 逻辑——四流程设计的 ph-1~ph-6 自行推进）、pi 上游源码修改（规则：不 fork 不提 PR）、zcode 本体扩展（穿透提问/通知推送/面板等其官方开放）、npm 发版流程、四流程本身的环节语义（reflection 七问文案、code-review 四维等照旧）。

## 2. 现状与问题分析

### 2.1 三套 pi 运行时分叉（一切结论的前置事实，代码证实）

| 环境 | subagent-workflow | conversation 多轮 | ask_user 穿透 | cw 现状是否使用 |
|------|------|------|------|------|
| TaiJi.app 内嵌 pi（0.84.1） | 8.1.0：进程长驻 + followUp 热路径 + EPIPE 冷恢复（index.js:23258/23290） | **有** | 有 | 否 |
| xyz-agent npm 副本（`~/.xyz-agent/pi/agent/npm/`，xyz-agent 内嵌 pi 用 `PI_CODING_AGENT_DIR` 指向此，rpc-client.ts:168） | 0.3.1：仅 start/list/cancel（subagent-tool.ts:61） | **无** | 有 | 否 |
| 全局 pi（`~/.pi/agent/extensions/`） | **悬空 symlink**（指向已删除的 worktree，`fs.existsSync` false → loader 静默跳过，loader.ts:661-690） | 无 | **无** | **是** |

**cw 现状挂在最弱副本上**：`cw run --spawn pi` 走 `src/runner/spawn/pi.ts:120-133` 的 `pi -p` print 模式 spawn 全局 pi——没有 subagent、没有 ask-user、没有 permission。四流程设计里 D3（反思 session 考古）与 D12（混合模式双世界拼接）两个 workaround 的根源在此：**不是 pi 没有能力，是 cw 没用上有能力的那套**。

### 2.2 使用者视角的现状（真实例子）

一个叶子 unit 的 design 阶段，现状实际发生：

```
用户：cw run --root feat-x --spawn pi &        # 无头后台进程
runner → spawn `pi -p "@/path/to/brief.md"`    # print 模式一次性子进程
designer 子进程：读 brief → 遇到歧义 → 物理上无法提问（无回传通道）
  → 只能猜，把假设写进 spec → SpecSubmitted 入账 → 进程死亡
reviewer 子进程：六维审 → fail → designer 重派（新进程，从零重建上下文）
预算耗尽转人工：stderr 打印一行「转人工：执行 cw report...」→ 无人看
```

失败模式（用户实证 + 代码证实）：

| # | 失败模式 | 根因 |
|---|---------|------|
| F1 | designer 从不提问，design 猜错方向全链返工（返工经济学最差） | `pi -p` print 模式无回传通道；ask_user 在 print 模式自禁用（ask-user index.ts:296-311，`setActiveTools` 物理移除 + isError "Do not retry"） |
| F2 | 反思环节要靠 session 文件 mtime 消歧 + `.tmp` rename + specHash 文件锚（设计 D3，ph-2 首门联测风险点密集） | spawn 一次性进程，无长驻会话与确定性 session 定位 |
| F3 | 转人工出声打在后台 runner 的 stderr，无人看 | 出声通道与「用户在场界面」之间没有桥 |
| F4 | 观测只有 `cw status` CLI 快照 | 账本只有拉取式查询（cw-tool 的 cw_query），无推送、无面板 |
| F5 | spawn 出的 agent 权限裸奔（继承全部工具） | 未启用 Preset/permission 任何分档 |

### 2.3 根因分析

1. **spawn 通道形态错**：print 模式是「一次性批处理」语义，cw 需要的是「长驻会话」语义。pi 0.84.2 的 RPC 模式（`--mode rpc`）提供 32 条 stdin 命令（`prompt`/`steer`/`follow_up`/`abort`/`get_state`/`fork` 等，rpc-types.ts:20-74）+ stdout 事件流 + `extension_ui_request` 双向通道 + 进程长驻（stdin EOF 优雅退出，rpc-mode.ts:801-803）——能力现成，cw 没用。
2. **编排层放错了进程**：穿透链的失效条件之一是「父进程 headless → respond cancelled」（ui-request-queue.ts:107-125，代码证实）。**runner 只要还是无头后台 CLI 进程，clarify 穿透就永远不可达用户**——编排层必须迁进用户的主 pi 会话（有 TUI/GUI 的那个进程）。
3. **运行时环境不受控**：cw spawn 依赖全局 pi 的自动发现 extensions，而全局环境是悬空 symlink 重灾区。环境不收敛，一切穿透断言都不成立。

### 2.4 物理数据流（现状 → 终态）

**现状**（单向、无回路）：

```
cw runner（无头 CLI 进程）
  → spawn `pi -p @brief`（全局 pi，~/.pi/agent，无穿透扩展）
    → 子进程 stdout/stderr → 管道直写 ~/.cw/topic/<run>/ 产物文件
    → 子进程内 cw 命令 → 写 events.log（CW_PROJECT_DIR 锚定）
  → runner 每轮重读 events.log → fold → frontier → 下一派
用户 ←（唯一接口）cw status/frontier CLI 拉取；转人工 ← stderr 打印
```

**终态**（编排层在用户主会话内，穿透回路闭合）：

```
用户主 pi 会话（pi TUI 或 xyz-agent 内嵌 pi，--mode rpc，装 ask-user/subagent-workflow/pi-cw-runner）
  └─ pi-cw-runner extension：每轮读 `cw frontier --json`（账本仍是唯一 SSOT）
       → subagent 派发：`pi --mode rpc` 长驻子进程（受控 agentDir + --extension 显式注入）
            ├─ designer（conversation 模式）：clarify → ask_user → extension_ui_request
            │    → 父进程 ui-request-queue → channel registry → 用户界面（TUI 内联 / AskUserOverlay）
            │    → 答案经 stdin extension_ui_response 回写子进程
            ├─ 反思：同进程 followUp 发附录 A 七问（首轮后不收割）
            ├─ developer/reviewer：reviewer 挂只读 Preset
            └─ 全部子进程内 cw 命令 → events.log（不变）
       → 升级出声：toast（ctx.ui.notify → event-adapter → 桌面）+ 收件箱条目 + setWidget 角标
xyz-agent renderer：cw-units 侧边栏面板 ← WS ← runtime ← cw_query/账本 watcher
```

## 3. 解决方案

### 3.1 终态（使用者视角）

**成功路径（真实 pi 主线，对应 G1/G2/G3）**：

```
用户在 xyz-agent 主会话：「给 cw 的 verify 加个 --stage 参数，走四流程」
  → pi-cw-runner：cw create --root ... → 账本 UnitCreated
  → 派 designer 子会话（conversation 模式，长驻）
designer：读 brief，发现歧义「stage 缺省值该兼容旧行为还是强制显式？」
  → ask_user 穿透 → 用户屏幕上弹出 AskUserOverlay（选项 + 说明）
  → 用户点选「缺省 test 兼容旧命令面」→ 答案回写子进程
  → designer 把该决策写入 spec.assumptions[]（依据 + 若错的影响面）
  → 提交 SpecSubmitted
runner：检测到新 spec → 同进程 followUp 发反思七问（子进程不重启、上下文全保留）
  → designer 逐问自答，发现一处过度设计 → 自行修订重提（不计打回代数）
  → 派异源 reviewer（只读 Preset：excludeTools write/edit）七维审 → pass → spec-frozen
dev/test/closeout 段：全自动（developer TDD → dev-verify → code-review → test 干净重跑
  → exec-review → retrospect 入账）——侧边栏 unit 树面板实时移动该 unit 的四流程位置
root closed → toast「feat-x 已收敛」+ 收件箱留存整树总账链接
```

**失败路径（带恢复指引，对应 G2）**：

```
code-review 连续打回 → 本周期 build 证据 ≥5 → buildDrift 停派
  → 桌面 toast「cw: feat-x-dev 转人工」+ 升级收件箱新增条目（附 cw report --unit 链接）
用户点收件箱条目 → 看到证据链（逐验收 ✓/✗ + 最近 fail comment 全文）
  → 点「接管」→ fork 该 unit 的 developer session 为用户会话（pi fork = 物理复制 + parentSession 血缘）
  → 用户直接进场修复 / 或调整 spec 后重提
  → 处置入账 → 下轮投影 buildDrift 消失 → runner 自愈续派
恢复指引（若用户暂不想接管）：收件箱条目常驻未读；cw report --unit <id> 随时可查；
  调大预算续跑 = cw run --max-build-attempts 10
```

**降级路径（无头形态，G5 对照）**：用户不在桌面/主会话时 `cw run --spawn pi-rpc-headless`（或旧 `-p`）仍可用——dev/test 机械段无用户通道需求，正常收敛；clarify 退化为 assumptions 自声明 + reviewer 第七维兜底（四流程设计 D2 自动模式原样兜底）；升级出声降级为账本记录 + 下次主会话启动时收件箱补现。

### 3.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **A. 编排层迁主会话 + RPC 长驻适配器**（本设计）：pi-cw-runner extension 跑派发循环，spawn 用 `pi --mode rpc` 长驻；内核不动 | 高：穿透/反思/升级/观测四环全部获得代码证实的原生通道；账本仍是唯一 SSOT（投影重放哲学不破）；`cw run` 无头兜底保留双形态 | 中：cw 侧一个适配器 + extension 侧一个 runner + xyz-agent 两个面板；约 5 个波次 | 绑 pi RPC 协议面（上游可漂移）→ 启动探针 + 版本握手对冲；三套运行时不收敛则断言全失效 → D1 前置 | ✅ **推荐** |
| B. 维持无头 CLI runner，只做 spawn 升级 RPC：runner 仍是独立后台进程，但子进程改长驻 rpc | 中：反思/消歧获益，但**穿透提问结构性不可达**（父 headless → respond cancelled，ui-request-queue.ts:107-125 代码证实）——G1 的 clarify 半废，仍需四流程 D12 混合模式补丁 | 低：只动 cw 适配器 | 半整合态长期滞留：用户以为能提问实际不能，困惑成本高于明确无通道 | ❌ 若用 B，§3.1 的 clarify 弹出场景变成「问题自动 cancelled、designer 收到取消继续猜」——比不提问更糟（假装有通道） |
| C. cw 内核深度绑 pi：账本迁 session JSONL / verify 走 harness 通道 / 状态机进 extension | 低：拿 cw 最硬的资产（可重放、零 mock、agent-agnostic）赌上游漂移；xyz-agent 规则「不 fork 不提 PR」意味着协议变了只能跟 | 高：内核重写 + 674 用例测试故事重建 | 单点绑死；zcode 第二战场直接丧失 | ❌ 若用 C，§2.2 的账本从「任何 agent/人只读即可零上下文接手」退化为「只有装了同款 extension 的 pi 能读」 |

**推荐 A 的核心理由**：整合的全部价值在编排层与体验层，整合的全部风险在内核层。A 把价值拿满、风险锁在适配器一个文件里（可回滚 = 切回 `-p` 适配器）。

### 3.3 关键决策与权衡

**D1：运行时收敛——唯一主线 = 受控 agentDir 的内嵌 pi 语义（选定，前置）**
- **采用**：cw spawn 不再依赖全局 pi 自动发现；显式 `PI_CODING_AGENT_DIR` 指向受控目录（预装 ask-user/subagent-workflow/pi-cw-runner/cw-tool）+ spawn 参数 `--no-extensions --extension <path>...` 显式注入（对齐 xyz-agent runtime 的 rpc-client.ts:186-239 形态）。全局 pi 的悬空 symlink 修复与否不影响本设计（不再依赖）。启动探针校验必需扩展在场，缺失拒绝派发并给恢复指引（「执行 <命令> 安装扩展环境」）。
- **被否**：修好全局 pi 继续用——全局环境是用户多工具共享面（zcode/其他 agent 也在写），不可控；三套并存按需选——断言要按环境分裂，测试矩阵爆炸。
- **证据**：三套分叉实测表（§2.1）；xyz-agent 强制 PI_CODING_AGENT_DIR 隔离先例（rpc-client.ts:168）【代码证实】。
- **效果**：G1-G3 的一切行为断言有确定环境地基；G4 不受影响（内核不感知环境）。

**D2：spawn 适配器升级 RPC 长驻（cw-1，基石）**
- **采用**：新增 `src/runner/spawn/pi-rpc.ts`：`pi --mode rpc` 长驻子进程，用官方 SDK `./client` 的 RpcClient（类型化 32 命令 + waitForIdle + kill 梯度）；brief 走 stdin `prompt` 命令（替代 `@file` 拼接）；握手 `get_state` 回填 sessionId/sessionFile 入账（**mtime 消歧删除**）；超时管理改 `steer` WRAP_UP → `abort` → SIGTERM 梯度；`--spawn pi-rpc` 为新枚举值，旧 `-p` 适配器保留为无头兜底。账本侧零改动（spawn 是 runner 进程内行为，不入账）。
- **被否**：继续 `-p` + 反思文件锚（四流程 D3 原案）——session 考古三件套（mtime/`.tmp`/specHash 文件）全是脆弱点，且拿不到穿透；workflow 引擎承载派发——workflow 与主 pi 进程同生共死（session_shutdown → pauseRun，代码证实），cw 的派发态应在账本不在 workflow callCache。
- **证据**：RPC 32 命令集（rpc-types.ts:20-74）/ 长驻 + stdin EOF 优雅退出（rpc-mode.ts:801-803）/ get_state 返回 sessionId+sessionFile（rpc-types.ts:95-113）/ SDK 三出口（package.json exports）——全部【代码证实】0.84.2 dist。
- **效果**：G1 的反思零考古；为 D4 穿透提供子进程前提；F2 根除。

**D3：编排层 = pi-cw-runner extension，跑在用户主 pi 会话内（选定）**
- **采用**：新 extension `@zhushanwen/pi-cw-runner`（xyz-agent extensions/universal/ 系）：加载后在主会话内跑派发循环——读 `cw frontier --json` → 经 subagent-workflow 派角色子进程 → 预算/停派判定**仍以 cw 投影为唯一权威**（extension 只做执行与浮现，不复制状态机）→ 升级经 ctx.ui.notify + 收件箱浮现。TUI 侧：setWidget 常显 frontier 摘要（pi-scheduler 同款机制）+ `/cw` 命令开全屏 overlay 看树。`cw run` CLI 保留为无头兜底（双形态共存：主会话在场用 extension，不在场用 CLI；两者不能同时跑同一账本——见 D8 派发锁）。
- **被否**：runner 留在 cw CLI 后台进程（方案 B，穿透不可达）；复用 pi-subagent-workflow 的 workflow 脚本引擎做循环（断点重放语义 ≠ 账本续接语义，且 agent() 白名单无 conversation 字段，execute-options-mapper.ts:46-64【代码证实】）。
- **证据**：穿透链父进程需有 UI（channel-handler.ts:170-190 分流 TUI/RPC【代码证实】）；cw-tool 已是 cw_query 只读封装先例（cw 整合不是从零开始）；pi extension API 面（registerTool/40+ 钩子/setWidget/sendMessage steer，types.ts:1281-1469【代码证实】）。
- **效果**：G1 clarify 穿透成立（父进程有 UI 满足穿透链三条件之三）；G2 出声有桥。

**D4：clarify = ask_user 穿透（三条件 + 显式降级）**
- **采用**：designer 子进程 spawn 参数满足穿透链三条件：① `--mode rpc`（D2）；② 受控 agentDir 装 ask-user 且 `--tools` 白名单含 ask_user；③ 父进程 = 主会话（D3，TUI 或 xyz-agent RPC 均在分流覆盖内）。答案回写后 designer 落 spec.assumptions（四流程 D2 字段语义不变）。**降级链显式化**：任一条件不满足（无头 CLI runner / 扩展缺失）→ designer 任务书自动切「assumptions 自声明」形态（四流程 D2 自动模式原样兜底），任务书内注明「本次无提问通道」防 agent 空等。并发排队：多 unit designer 同时 clarify 由 DialogGlobalQueue FIFO 串行（dialog-queue.ts:161-310【代码证实】）——提问本来需要人答，人是串行的，接受排队不限流。
- **被否**：runner 内 blocking 提问（停派转人工粒度粗，四流程 D2 已否，维持）；问题清单带回主会话说转述（zcode 侧降级形态，pi 侧有原生通道不用绕行）。
- **证据**：穿透链七环全程代码亲验（ask-user index.ts:296 → extension-protocol `\0XYZ_ASK_USER` marker → rpc-mode.ts:129 extension_ui_request → session-runner.ts:776-778 入队 → ui-channels.ts:148-217 parseChannel → channel-handler.ts 分流 → stdin-writer.ts:32-56 回写）；失效条件三档（print 自禁用 / 父 headless cancelled / 缺扩展降级 defaultDialogForward）全部【代码证实】。
- **效果**：G1 clarify 成立；F1 根除。四流程 D12 从「用户换世界手动跑前半」升级为「通道来找用户」——混合模式文档段保留为无头降级说明。

**D5：反思 = 同进程 followUp 追问（替代 session 考古）**
- **采用**：designer 子进程首轮（提交 spec）后不收割，进程长驻 idle；runner 经 RPC `follow_up`（或 `prompt` + `streamingBehavior: followUp`）发附录 A 七问；崩溃/EPIPE 冷路径 = `--fork sessionFile` 重 spawn 续聊（8.1.0 语义，index.js:23290 同款）。审计锚：新增 `ReflectionRan` 事件（可选字段 append-only 加法，D11 代际信号同族兼容）——比文件锚干净且跨 run 稳健；specHash 语义保留（哪版 spec 的反思）。预算 ≤2 轮与「修订不计打回代数」语义照旧（四流程 D3③）。**前置依赖 pi-1**：npm subagent-workflow 0.3.1 无 conversation（白名单无字段【代码证实】），需把 TaiJi 8.1.0 的 conversation 语义（长驻 + followUp 热路径 + EPIPE 冷恢复 + resumable 持久化）回合到 npm 线——源码在 xyz-agent 主仓 extensions/，单仓维护。
- **被否**：四流程 D3 原案（`pi -p --session <file>` 二轮 + 文件锚）——机制已被 D2/D4 取代，考古三件套删除；独立反思 spawn（丢上下文，四流程已否，维持）。
- **证据**：conversation 长驻 + followUp 热路径 + 冷恢复【代码证实，TaiJi 8.1.0 index.js:23258/23290】；pi fork = 物理复制 + parentSession 血缘（session-manager.ts:1580-1631【代码证实】）。
- **效果**：G1 反思零考古；四流程 ph-2 的 P1 探针（session 消歧联测）整体跳过，省一个波次的弯路。

**D6：升级出声双通道 + 收件箱（cw-3 + xyz-2）**
- **采用**：转人工事件双写——账本照写（SSOT 不动）+ 浮现通道：在主会话内时 `ctx.ui.notify` → 桌面 toast（event-adapter.ts:478-490 → NotificationHostController【代码证实】链路现成）+ 持久收件箱条目。收件箱 = xyz-agent MainPanel 新 view：汇总全部停派维度（数据源自 `cw frontier --json` 的 stoppedDispatchState 拉取 + 账本 watcher 推送），每条带证据链（cw report）+「接管」按钮（fork 该 unit 现场 session 为用户会话）。已读状态落 runtime JSON（不入账本——已读是 UI 态非事实源）。无头 CLI 形态降级：账本记录 + 下次主会话启动时收件箱补现（从投影重建，天然幂等）。
- **被否**：Electron 系统 Notification——全仓零命中（无先例基础设施），且收件箱已覆盖持久诉求，toast 覆盖即时诉求（减法）；已读状态入账本——UI 态污染事实源，破 append-only 语义纯粹性。
- **证据**：toast 链路与 AskUserOverlay 组件实存【代码证实】；pi 进程内 EventBus 不出进程（pending:register 不到桌面【代码证实】）——跨端必须 WS 协议帧。
- **效果**：G2 成立；F3 根除。

**D7：角色权限 = Preset 粗粒度先行，permission 角色分支后续**
- **采用**：近期（零代码）：xyz-agent Preset 建三角色——reviewer = `excludeTools: [write, edit]` + 无 bash 白名单；designer/developer 各配工具面。远期（约 20 行）：pi-permission 的 config.ts 路径解析加角色分支（`XYZ_CW_ROLE` env → `permission-ext-config.<role>.json`）。**反模式禁令**：不得 per-role 改 `PI_CODING_AGENT_DIR`（分裂整个 agentDir：skills/sessions/extensions 全断）。
- **被否**：一步到位细粒度命令级权限——Preset 已覆盖「reviewer 只读」主诉求，细粒度等真实需求出现（减法）。
- **证据**：Preset 链（pi-presets.json → PresetService.resolve → RpcClientOptions tools/excludeTools【代码证实】）；spawn 级 `--tools/--exclude-tools/--append-system-prompt` 三旋钮现成（buildSpawnArgs【代码证实】）；permission 配置 agentDir 全局单文件现状（config.ts:43【代码证实】）。
- **效果**：F5 收敛；G1 的 reviewer 异源可信度加一层机器保证（不止 role 自报）。

**D8：双形态派发互斥——账本级 runner 锁（新增防线）**
- **采用**：pi-cw-runner（主会话内）与 `cw run` CLI（无头）不得同时派发同一账本：runner 启动时在 `~/.cw/<encoded-cwd>/` 写 runner.lock（pid + 形态 + 心跳），已在跑则新 runner 拒启并指引（「已有 pi-cw-runner 在主会话派发中；强制接管 = cw run --force-dispatch」）。锁是 cw 侧小增量（runner 层，非内核）。现状的同 unit in-flight gate 是进程内状态，跨进程不互斥——本决策补跨进程层。
- **被否**：依赖用户自觉——双 runner 抢派发的失败模式太隐蔽（同一 unit 两个 spawn 并发，worktree reset 互清现场）；把锁做进账本事件——锁是易失进程态不是事实，入账污染重放。
- **证据**：cw 现状 in-flight gate 语义（AGENTS.md「同 unit 存在任意 role 的 in-flight spawn 时本轮缓派」——进程内）；pi-cw-runner 与 CLI 双形态并存是本设计引入的新现实。
- **效果**：双形态安全共存；G4 不破（锁在 runner 层）。

**D9：命名治理——两个 coding-workflow 拆弹（前置）**
- **采用**：整合前明确 `@zhushanwen/pi-coding-workflow` 0.4.1（xyz-agent 内 L1/L2/L3 编排 + test gate）与 `@zhushanwen/coding-workflow` 2.0 的分工或更名。建议：pi-coding-workflow 若已被 cw 2.0 取代则归档退役；若并存则更名（如 pi-legacy-orchestrator）。skill/workflow 命名空间同步清理。
- **被否**：并存不管——用户认知冲突 + skill 触发词冲突（cw-cli skill 与 full-*/lite-* workflow 名空间）。
- **证据**：pi-coding-workflow 0.4.1 实装于 xyz-agent 内（含 skills/workflows，调研发现）；两者同名不同物。
- **效果**：整合叙事单一；避免用户/agent 路由错乱。

**D10：zcode 第二战场 = spawn 适配器 + 降级体验（仿建，跟随主线）**
- **采用**：cw 新增 `--spawn zcode` 适配器：复用 zsub 的 driver 契约（`zcode.cjs --json --cwd --mode yolo --prompt` + stdout JSON + `--resume` 续聊；或 appserver runner 长驻协议）。体验降级显式化：clarify = 结构化问题清单回主会话转述（zcode headless 穿透提问结构性无解——askUserQuestionAutoResolutionEnabled 自动应答 + waiting 当轮终态【代码证实证据链】）；通知 = mailbox 被动回流（idle 滞留）；无面板。等 zcode 本体开放（交互队列协议化/通知推送/webview）再升级对等形态。
- **被否**：zcode 侧强行穿透（tasks-index.sqlite 直写——无契约高风险，仅实验位）；zcode 升为主线（无进程内 extension API + 无穿透通道，天花板低于 pi）。
- **证据**：zcode app-server NDJSON 协议（session/create/send/list/subscribe + 状态机）zsub e2e 实测（runner-appserver.js:18-45 头注全录）；穿透缺失证据链（runner-appserver.js:72-81, 115-118 + zcode.cjs askUserQuestion 定义）；权限 10 档原生；本体内置 workflow 引擎（sqlite 四表，形态待深挖）。
- **效果**：G5 成立；zcode 投入最小化（一个适配器文件），不被主线节奏阻塞。

### 3.4 探针清单

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|----|-----------|------|------|-----------------|
| HP1 | cw 环境 RPC 穿透全链：cw spawn `pi --mode rpc`（受控 agentDir）→ 子进程 ask_user → 主会话（pi TUI）弹出 → 答案回写 | 最小脚本：spawn 子进程跑「问用户一个问题并复述答案」 | ⛔ 实施期首门（ph-i1） | 降级 = clarify 自声明形态常驻（四流程 D2 自动模式）；D4 穿透标注「TUI 未通」仅保 xyz-agent 线 |
| HP2 | conversation 长驻 + followUp 热路径 + EPIPE 冷恢复在 npm 线复现（pi-1 回合后） | 回合后的 npm subagent-workflow：起会话 → followUp 追问 → kill -9 → --fork 冷恢复 | ⛔ ph-i1 | 降级 = 反思改独立 spawn 带 `--fork sessionFile`（上下文重建但机制简单） |
| HP3 | 父 headless 时子进程 ask_user 的确切行为（respond cancelled 时序/文案） | cw 无头形态 spawn 含 ask_user 的子进程 | ⛔ ph-i1（代码已证实行为，探针锁回归） | 无降级——探针目的是锁死「无头必须切自声明」的判定时机 |
| HP4 | 账本 watcher → WS → 渲染器面板的端到端延迟与稳定性（events.log 高频追加时） | ph-i3：脚本高频写账本，面板观测刷新率/丢帧 | ⛔ ph-i3 | 降级 = 面板改轮询（cw_query 5s 间隔） |
| HP5 | DialogGlobalQueue 并发 clarify 排队体验（2 个 designer 同时提问） | ph-i2：双 unit 并发 design，观察第二个提问的排队呈现 | ⛔ ph-i2 观察项 | 降级 = 派发侧限流（同时刻 clarify 中 designer ≤1） |
| HP6 | pi 升级漂移：RPC 协议面在 0.84.x→新版本的关键命令兼容性 | 每次 pi 升级后跑握手探针（get_state/prompt/follow_up/extension_ui_request 四命令冒烟） | ⛔ 持续门 | 适配器内置版本检查 + 明确报错指引（「cw 已验证 pi ≤0.84.x，当前 X.Y.Z 未验证」） |
| HP7 | zcode app-server 协议在 cw 适配器复测（zsub 已实测，协议无官方文档） | ph-i4：cw --spawn zcode 起会话全链 | ⛔ ph-i4 | 降级 = spawn runner（`--json --prompt` 一次性，zsub driver.js 契约） |

## 4. 验收（真实场景，非单测）

改动规模：大（跨三仓：cw / xyz-agent extensions / xyz-agent renderer）。以下场景全部用真实 pi/xyz-agent/zcode + 真实账本；human 模式仅作确定性补充。

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|----------------|------|---------|
| S1（G1/G4 全链） | xyz-agent 内真实全链：新 topic（root + 2 叶）从 create 到 root closed，主会话形态 | 用户在主会话发起 → pi-cw-runner 接管 → 走完四流程 | ① designer 的 ≥1 次 clarify 真实弹出 AskUserOverlay 且答案出现在 spec.assumptions；② 每叶反思经 followUp 发生（session 无新 spawn 进程，进程 id 不变）；③ ReflectionRan 事件每叶入账且 specHash 与对应 spec 对账一致；④ root closed；⑤ 全程账本命令面与旧版 cw 逐字节兼容（cw status 输出语义不变） |
| S2（G1 降级，负面） | 穿透条件缺失时的显式降级 | 拆掉受控 agentDir 的 ask-user 扩展后重跑 design | 派发前启动探针拒派 + stderr 指引安装命令；强行 `--spawn pi-rpc-headless` 无头跑时 designer 任务书自动切自声明形态且注明「无提问通道」，spec.assumptions 照常入账 |
| S3（G4 兼容，负面） | 无头兜底形态不退化 | 旧账本（M4 gate 96 事件）+ 新适配器共存：先 `cw run`（无头）跑一半，Ctrl-C，主会话 pi-cw-runner 续接 | 续接后 frontier 投影一致、已 closed 不重做；双 runner 同启时后者被 runner.lock 拒启且指引文案正确 |
| S4（G2 升级链） | 预算耗尽 → 收件箱 → 接管闭环 | human 模式构造 code-review 连挂 ×5 触发 buildDrift | ① 桌面 toast 出现；② 收件箱新增持久条目含证据链链接；③ 点「接管」fork 出用户会话（parentSession 血缘可查）；④ 人工处置入账后收件箱条目自动消解、runner 自愈续派 |
| S5（G3 观测） | 面板实时性 | S1 进行中观察侧边栏 unit 树 | unit 四流程位置移动与账本事件延迟 <2s（HP4 达标）；关闭重开 xyz-agent 后面板从投影完整重建 |
| S6（G1 并发，负面） | 双 designer 并发 clarify 排队 | 2 叶同处 design 阶段且同时提问 | 第二个提问排队呈现不丢不混（DialogGlobalQueue FIFO）；答案各自正确回写对应子进程 |
| S7（G5 zcode） | zcode 降级形态全链 | `cw run --spawn zcode` 跑单叶 topic | 编排段（建子/写 spec/verify）收敛；clarify 以问题清单回主会话说转述；通知经 mailbox 在下轮 prompt 回流；无穿透提问发生（HP7 确认机制边界） |
| S8（G1 权限，负面） | reviewer 只读 Preset 生效 | reviewer 子进程被诱导尝试 write 工具（任务书埋测试指令） | write/edit 不在其工具面（excludeTools），尝试以「工具不可用」终，账本无伪造 verdict |

单元测试仅作回归辅助（适配器序列化、锁文件、降级分支），不计入验收。

## 5. 下一层拆分

实施路径（五波，依赖序；与四流程 ph-1~ph-6 并行，交汇点见下）：**ph-i0 拆弹 → ph-i1 适配器基石 → ph-i2 编排迁移 → ph-i3 体验面板 → ph-i4 zcode**。

| unit | 内容 | justification（为什么这么拆） | 验收锚 |
|------|------|------------------------------|--------|
| ph-i0 | 命名治理（D9：pi-coding-workflow 归档/更名）+ 受控 agentDir 环境建立（D1：预装扩展清单 + 安装脚本 + 启动探针逻辑） | 无代码逻辑改动但阻断一切行为断言——环境不收敛，后续每波的探针都不可信 | HP1 前置 |
| ph-i1 | cw 侧 RPC 适配器（D2：pi-rpc.ts + get_state 锚 + 超时梯度 + runner.lock D8）+ pi-1 conversation 回合 npm 线 + HP1/HP2/HP3 探针 | 适配器是全部上层的地基；conversation 回合与适配器互为验证（反思形态依赖其语义）；探针同波收口 | S2、S3、HP1-3 |
| ph-i2 | pi-cw-runner extension（D3：frontier 拉取 + subagent 派发 + 降级分支）+ D4 穿透接线 + D5 反思 followUp + HP5 | 编排迁移是单一连续动作（拆开会留「半个 runner 在两个进程」中间态）；穿透与反思是派发参数的延伸 | S1、S6、HP5 |
| ph-i3 | xyz-agent 面板与收件箱（D6：cw-units 侧边栏 9 步 + 收件箱 view + toast 接线 + CW_* env 白名单 + reviewer Preset D7 近期形态）+ HP4 | 纯体验层，依赖 ph-i2 的浮现通道稳定后一次做齐；renderer 改动集中一仓 | S4、S5、S8、HP4 |
| ph-i4 | zcode 适配器（D10：--spawn zcode + mailbox 通知 + 问题清单转述）+ HP7 | 第二战场独立推进，不阻塞主线；协议无官方文档需独立探针门 | S7、HP7 |

**与四流程设计（design-4phase-process.md §5）的交汇**：四流程 ph-1（事件/状态机）ph-3（dev 流程）ph-4（test 流程）ph-5（closeout）原样推进（内核，正交）；**ph-2（design 流程的反思环节）开工前必须先过 HP1/HP2**——探针通过则跳过 D3 session 考古直接采用本设计 D5 的 followUp 形态（省一个波次弯路），探针失败则按四流程原案落地并保留本设计为后续波次。

**文件改动地图**：

- cw 仓：`src/runner/spawn/pi-rpc.ts`（新）、`src/runner/spawn/pi.ts`（保留兜底）、`src/runner/loop.ts`（runner.lock + spawn 路由）、`src/dispatch.ts`（--spawn 枚举 + --force-dispatch）、`src/events/types.ts`（ReflectionRan 可选加法）、`src/readonly/frontier.ts`（reflectionPending 判定改事件锚）。
- xyz-agent 仓：`extensions/universal/cw-runner/`（新，pi-cw-runner）、`extensions/universal/subagent-workflow/`（conversation 回合）、`extensions/universal/permission/`（config.ts 角色分支，远期）、`packages/runtime/src/`（cw WS domain + watcher service + ENV 白名单一行）、`packages/renderer/src/`（CwUnitList.vue + 收件箱 view + store/api 七跳）。
- zcode 插件仓：`z-subagent-workflow` 启用 + cw 侧 zcode 适配器复用其契约（本仓零改动或仅文档）。

**待验证检查点（诚实标注）**：① HP1/HP2 是全部上层设计的实证门，不过则 D4/D5 回降级路径——本设计的核心价值（穿透 + 对话原生）以探针为准，不以调研为准；② pi RPC 协议面无 semver 承诺，HP6 持续门是长期成本；③ zcode 本体内置 workflow 引擎（sqlite 四表）形态未深挖——若其官方化可能改变 ph-i4 选型；④ DialogGlobalQueue 排队的用户体感（HP5）可能要求在派发侧加 clarify 限流，属体验调优非架构变更。

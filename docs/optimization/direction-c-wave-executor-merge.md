# 方向 C：wave 执行侧合并（消费侧）

> **层次声明**：本文档是方向 C 的立项设计——当前层为「wave 执行角色合并」，下一层是具体实施（工具白名单调整 / agent 模板改写）。父文档与整体裁决见 [README](./README.md)。本方向只改消费侧（xyz-agent `extensions/cw-tool/`），cw 引擎不动。

**一句话结论**：把「每 wave 4 次 subagent spawn、4 种角色」收敛为「3 次 spawn、2 种角色」——wave-agent 吸收 dev-agent（工具白名单加 execute/test，编码不再移交），review-agent 保持独立做两轮审查（两轮是两次独立 spawn）；消灭 plan 作者→执行者的上下文搬运。原设想「1 个 subagent 完成 1 个 wave」被修正为「2 种角色」——执行者 + 独立审查者，因为审查合并就是自审，与重验证方向直接矛盾。

## 1. 背景目标

### 系统是什么（受众补足）

xyz-agent 消费 cw 的方式是 5 个 agent 模板（`extensions/cw-tool/agents/`），每个绑定一个工具白名单（白名单常量在 `extensions/cw-tool/src/index.ts`）：

| agent | 工具白名单 | cw 工具可调 action | 职责 |
|---|---|---|---|
| planning-agent | `cw_planning, subagent` | design / execute / replan / retrospect / closeout / status / handoff / list / tree / **frontier**（`index.ts:28-39`） | epic/feature/slice 层主编排 |
| wave-agent | `cw_wave, subagent` | design / replan / retrospect / status / handoff / list / tree / frontier（**无 execute / test / design-review / exec-review**，`index.ts:42-52`） | wave 层主：自己 design，派 review、派 dev，收尾 retrospect/closeout，**不亲自编码** |
| dev-agent | `bash, read, write, edit, cw_dev, subagent` | execute / test / status / handoff（`index.ts:55`） | 编码执行者：写码 + commit + 跑 test，再派 exec-review |
| review-agent | `cw_review, read` | design-review / exec-review / status（`index.ts:58`） | 独立审查（无 bash/write，不改被审物；无 subagent，不再下派） |
| merge-agent | `bash, read` | —（纯 git worker） | 分支合并 |

现状单 wave 全链的 subagent 上下文数：**wave-agent（driver）+ review-agent（design-review）+ dev-agent（execute+test，内部再派一次 exec-review 的 review-agent）= 4 次 spawn**，外加约 10 条 cw 命令记录（closed wave 平均 statusHistory 9.8 条；驱动者归属 store 不记录）。引擎的 subagent 委派规则里 design-review / execute / exec-review 三档是 mandatory（`src/guidance/subagent-guidance.ts:47-88`）——每 wave 最少 3 次 spawn 是流程刻意的。

**基线口径声明（诚实边界）**：上述「4 次 spawn」是 5-agent 模板设计的编排形态。2026-08-13 死锁后 verify/wrap-up 类 wave 退回了线性单 agent 模式；且 113 个 closed wave 的**实际驱动模式分布**（单 agent 直驱 vs 模板编排）未经核实——statusHistory 无 agent 归属字段。本方向的收益基线按模板编排模式计算；若实测大部分 wave 由单 agent 直驱（本就 1 个上下文），则本方向的定位改为「让模板编排模式可用且成本不劣于直驱」——核实方法见 §5 待验证。

### 问题

**成本结构错了地方（数据画像）**：仪式步骤单看很轻——自算中位数：design-review 0.67 分钟、test 0.46 分钟、exec-review 2.79 分钟、retrospect 0.61 分钟、closeout 0.20 分钟；重的是**上下文重载**：每个步骤都是一次完整的「读 guidance → 构建 input → 调 cw → 等返回」循环，每次 spawn 都要 dev-agent 重新理解 plan（wave-agent 明明刚写完它）。

**粒度失配信号（2026-08-14 复核）**：wave 的 executing 状态是「编码完成后的事务性登记」——execute 入口校验 commitHash 已存在（`src/handlers/execute.ts:45-48`），「先写码后登记」是设计流程（dev-agent 模板 turn 1 明确顺序：write/edit 写码 → commit → `cw_dev execute` → `cw_dev test`）。失配点不在顺序，在于**真实编码时间不被任何状态追踪**：17/113 个 closed wave 的 executing→tested 间隔 < 5 秒，却携带真实多文件 commit（如 `history-converter::m4` 1.0 秒 / 16 文件）——对一个已经想清楚的任务，4 次 spawn 的编排是纯开销，agent 倾向于把状态机一把走完。

**用户设想「1 个 subagent 完成 1 个 wave」的修正**：方向正确（砍上下文切换与轮次），但数字要修正为 2。理由：

- design-review / exec-review 的强制独立委派是 anti-self-review 的刻意设计——审查合并进执行者 = 自审，恰好与方向 A（重验证）矛盾：一个能自审过关的执行者，也能让空 note 过关；
- wave-agent 与 dev-agent 分离的现实理由只剩下工具白名单隔离（`cw_wave` 无 execute/test）——这是配置问题，不是架构问题，改白名单即可；
- 因此正确形状是：**1 种执行者（wave-agent 吸收 dev 职责：design → 编码 → test）+ 1 种独立审查者（review-agent 做 design-review 与 exec-review 两轮，两次独立 spawn）**。

### 目标（G3，回溯父文档）

subagent spawn 数/wave 从 4 降到 3（角色 4→2：执行者 + 独立审查者）；plan 作者→执行者的上下文搬运消失；cw 命令数不因合并上升（基线 9.8 条/wave）。

**in scope**：`extensions/cw-tool/src/index.ts`（WAVE_ALLOWED）、`agents/wave-agent.md`（吸收 dev 职责）、`agents/dev-agent.md`（退役路径）；可选辅助：slice→wave 的 contracts/interfaces 继承文案。

**out of scope**：cw 引擎状态机与 mandatory 委派规则（引擎的 subagent-guidance 是「建议表」，消费侧模板本来就可以更具体——合并后 wave-agent 仍会派 review，mandatory 语义不破）；review-agent 的白名单与独立性；merge-agent。

## 2. 现状与问题分析

### 2.1 一次典型 wave 的交互成本还原

以 `optimize-ask-scheduler-structured` 的 m1 wave 为例（时间线自 store 还原的模式，全库 113 个 closed wave 同构）：

1. planning-agent 派 wave-agent（worktree 隔离）——上下文 ① 建立，读 SKILL + handoff；
2. wave-agent `cw_wave design` 写 plan（7.5KB 级设计文本：objective/clarifications/testCases/tasks/files/contracts）；
3. 派 review-agent 做 design-review——上下文 ② 建立，重新理解 plan 全文，产出 judgment；
4. 派 dev-agent 执行——上下文 ③ 建立，**重新理解自己刚被写出来的 plan**，写码 + commit + `cw_dev execute` + `cw_dev test`；
5. dev-agent 再派 review-agent 做 exec-review——上下文 ④ 建立；
6. wave-agent 收尾 `cw_wave retrospect` + `closeout`。

其中 3、5 两轮审查的独立性是设计意图，必须保留；2→4 的「plan 作者与执行者之间的上下文搬运」是纯损耗——wave-agent 写完 plan 后唯一的动作是把 plan 原文塞给 dev-agent 再等它复述理解。

### 2.2 合并的安全性论证

- **审查独立性不受影响**：review-agent 的 `cw_review` 白名单（design-review/exec-review/status）与无 bash/write 的隔离不动；合并改的是执行侧，不碰审查侧。
- **引擎委派建议是措辞强度，不是技术强制**：`subagent-guidance.ts:13` 头注释自述「"强制"= 措辞强度的硬建议，cw 无法技术阻止 agent 自行决策」。消费侧模板本就叠加了自己的编排（现状 wave-agent 已经不亲自 execute 而是派 dev），模板层重组角色是被允许的形态。**但存在一处必须显式处理的冲突**：WAVE_RULES 中 execute 是 mandatory（「应当委派」），合并后 wave-agent 在 execute 前收到的引擎 guidance 会带着「execute：强制委派」建议，与模板「你本人执行」直接矛盾——见 D5 的冲突优先级声明。
- **权限面变化**：wave-agent 白名单加入 execute/test 后，它同时拥有 design 权（cw_wave）与编码执行权（execute/test）+ subagent。风险与 dev-agent 现状等同（dev-agent 本就有 bash/write/edit + execute/test）——不是新增系统权限，是把既有权限从一个角色挪到另一个角色。实施期做一次权限面复查（见 §5 待验证）。

## 3. 解决方案

### 3.1 终态（使用者视角）

合并后同一个 m1 wave：

1. planning-agent 派 wave-agent（不变）；
2. wave-agent `cw_wave design` 写 plan → 派 review-agent 做 design-review（独立，不变）；
3. review 通过后，wave-agent **自己进入编码**：`bash/write/edit` 写码 + commit + `cw_wave execute` + `cw_wave test`——plan 在自己上下文里，零搬运；
4. 派 review-agent 做 exec-review（独立，不变）；
5. wave-agent `cw_wave retrospect` + `closeout`（不变）。

subagent spawn：wave-agent ×1 + review-agent ×2（两轮是**两次独立 spawn**，各自独立 session，非同一上下文复用）= **3 次 spawn、2 种角色**（诚实计数，非 2 次）。plan 作者→执行者的上下文搬运消失。

失败路径：design-review 驳回 → wave-agent replan 重写（现状路径，不变）；test 失败 → wave-agent 修复重跑（dev-agent 时代的路径等价平移）；exec-review 驳回 → 回到 execute 修复（不变）。**所有失败路径都是现有状态机路径，合并不新增任何失败分支。**

### 3.2 方案对比

| | 方案一：wave-agent 吸收 dev（推荐） | 方案二：单 subagent 全包（design 到 closeout 含审查） | 方案三：维持现状（4 上下文） |
|---|---|---|---|
| 内容 | WAVE_ALLOWED 加 execute/test；wave-agent.md 改写吸收编码职责；dev-agent.md 退役 | 一个 agent 从 design 包到 closeout，审查自己做 | 不动 |
| 长期合理性 | 高：执行者/审查者两角色是稳定的最小拓扑；与方向 A 的重验证互补（审查独立性是 A 的人审前提） | 低：自审退化——anti-self-review 的刻意设计被推翻；「轻开发」失去「重验证」的对冲 | 低：粒度失配信号持续（编排层数不降） |
| 短期成本 | 小时级（白名单常量 + 一个模板改写 + 一个模板退役） | 小时级 | 0 |
| 风险 | 权限面扩大（等价平移，见 §2.2）；wave-agent 上下文变长（design+编码+测试同上下文）——对大 wave 可能触碰上下文上限 | 低实现成本高隐性风险：空 note/占位声明更易过关（方向 A 的 gate 面对自审者强度打折） | 持续支付 4 次 spawn 的编排成本，且 agent 继续把状态机一把走完（秒级 tested） |
| 若用它，§2 的例子会怎样 | 步骤 2→4 之间的上下文搬运消失；spawn 从 4 降到 3；一把走账的动机减弱（编排层数减少） | 步骤 3、5 的独立视角消失，design-review judgment 可信度下降 | plan 作者与执行者永久割裂 |

**推荐方案一**。

**可选辅助项（不单独立项，随方案一搭车）**：wave design 模板增加「slice 层 contracts/interfaces/techChoices 已有内容优先继承复述，不重写」的指引——slice 设计与 wave contracts 存在重叠，继承可省一部分设计文本（收益有限，属于锦上添花，不构成决策依据）。

### 3.3 关键决策与权衡

**D1：合并的是「执行链」，不是「审查链」。**
被否：把 review 也合进去（方案二）。证据：`subagent-guidance.ts` mandatory 三档中两个是审查；独立审查是方向 A「机器验形式、人审可行性」分工里人审一侧的信任根。执行与审查的分离是对「重验证」的架构支撑，合并它等于左手建 gate 右手拆墙。

**D2：dev-agent.md 走退役而非共存。**
保留两个模板会出现「有时派 dev 有时自己干」的分叉，LLM 选择不稳定且行为不可比。退役 = wave-agent.md 吸收其内容（编码规范、commit 纪律、TDD 顺序），dev-agent.md 删除。若后续实测发现大 wave 上下文吃紧，恢复下派的触发条件**必须是确定性的**（如 plan.files 数量阈值），不允许留给 LLM 自选——否则就是复活被本决策否定的分叉。

**D3：状态机与引擎 gate 全部不动。**
合并只改「谁在哪个角色上执行 action」，不改「action 序列与 gate」。引擎对 wave 的 8 步、mandatory 建议表、test 实跑语义原样生效——方向 A 的 gate 加深与本方向正交叠加。

**D4：实施时机排在 A1 之后。**
A1 会改 wave design 模板文案（验收声明说明），C 也改同一模板——先 A1 后 C 避免模板改写冲突。两者无逻辑依赖，纯改动顺序协调。

**D5：引擎 guidance 冲突的优先级必须显式声明。**
引擎 WAVE_RULES 中 execute 是 mandatory（「应当委派」的强建议，无技术强制）。合并后 wave-agent 在 execute 前收到的引擎 guidance 会带「execute：强制委派」建议，与模板「你本人执行」矛盾——若不处理，LLM 在同一条指令流里收到相反指令，行为不可预测。处理方式：wave-agent.md 显式声明优先级——「引擎对 execute 的委派建议对本 agent 不适用（你已合并执行者角色）；design-review / exec-review 的委派建议仍然严格遵守」。引擎 guidance 本身不改（维持本方向 out of scope 红线）。

## 4. 验收

| 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|
| V-C1 角色拓扑 | 实施后跑一个真实 wave（xyz-agent 任一进行中 slice） | store statusHistory 全程由 wave-agent 驱动 execute/test；review 记录来自独立 review-agent（subagent 派发日志可查）；dev-agent 模板不再被派发 | G3 |
| V-C2 编排成本 | 统计实施后连续 10 个 closed wave（数据源：pi subagent session 文件 + statusHistory——store 不记录驱动者归属） | 每 wave subagent spawn ≤ 3；cw 命令数中位不高于基线 9.8（与父文档 V4 同口径同阈值） | G3 |
| V-C3 审查独立性保持 | 抽查 design-review / exec-review 的 judgment 产出 | judgment 由 review-agent 产出（cw_review 白名单调用记录）；存在驳回案例时驳回路径走通（replan/修复未旁路） | G3 + 方向 A 信任链 |
| V-C4 粒度失配信号 | 对比实施前后各 10 个 wave 的 executing→tested 间隔分布 | 秒级（<5s）tested 的 wave 占比不上升（现 17/113）；理想情况下下降（编排层数减少后 agent 更愿意逐状态真实走）——软指标 | G3（粒度失配回应） |
| V-C5 回归 | cw-tool extension 测试 + 白名单单测 | `pnpm extensions:test` 全绿；WAVE_ALLOWED 变更有单测锁定 | G3 |

## 5. 下一层拆分

| 单元 | 改动文件 | justification |
|---|---|---|
| 白名单调整 | `extensions/cw-tool/src/index.ts`（`WAVE_ALLOWED` 加入 `execute` / `test`，更新注释）+ 单测 | 一行常量 + 测试，解锁合并的前提 |
| wave-agent.md 改写 | `extensions/cw-tool/agents/wave-agent.md`（吸收 dev-agent 的编码/TDD/commit 段落；turn 流程改为 design → 派 review → 自己 execute/test → 派 review → retrospect/closeout；删除「调不了编码命令必须派 dev」的旧说明 :22；**新增 D5 的 guidance 冲突优先级声明**） | 核心交付物；模板是消费侧行为的 SSOT |
| dev-agent.md 退役 | 删除 `extensions/cw-tool/agents/dev-agent.md`；检查全仓引用（planning-agent 派发模板、SKILL、文档） | 防分叉（D2）；引用清理是退役完整性的一部分 |
| 引用同步 | `extensions/cw-tool/` 内 SKILL/README/其他模板中对 4 角色拓扑的描述更新为 3+1（planning/wave/review + merge） | 文档与行为一致 |

**待验证检查点**：113 个 closed wave 的实际驱动模式分布（单 agent 直驱 vs 模板编排）——从 pi subagent session 日志侧核实，决定本方向收益基线的真实口径（见 §1 基线口径声明）；wave-agent 上下文长度（design+编码+测试同上下文，叠加方向 A3 的分钟级真实 E2E）在最大真实 wave 下的表现——若逼近上限，按 D2 的确定性触发条件处理；权限面复查（§2.2）随实施做一次。

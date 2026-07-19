# cw 1.0 全生命周期重设计（L1-L5）

> **状态**：方案设计阶段（未实施）
> **源会话**：2026-07-19，从 wayfinder 定位讨论演化为全产品重设计
> **性质**：本文件是产品设计记录，不是已实施 topic 的产物。无 retrospect、无 changes——等实施时产生。
> **取代关系**：取代 `mattpocock-skills-integration/plan.md` 的 6.2（wayfinder 降级检查清单版）——cw 直接做完整 L1-L5，不再做 W1 降级清单。
> **决策来源**：源会话中用户已确认 6 个核心决策（见 §1）。

---

## 0. 文档目的

把 cw 从「session 级执行约束工具」重设计为「全生命周期编码流程编排工具」。本文件是**设计真值来源**，后续阶段 1/2/3 的实施都以本文档为准。涉及：
- 产品定位转向声明（推翻 PRODUCT.md:53）
- L1-L5 完整 scope 分层与跨层架构
- 3 个独立状态机（L5 effort / L4 spec / L3 topic）+ 2 个无状态服务（L1 决策 / L2 问题）
- 完整流程执行步骤与 guidance 衔接机制
- 各层产物的数据格式规范
- 渐进交付的 3 阶段划分

**不含实现代码**（AGENTS.md 规则：设计类文档回答「为什么」和「方案对比」）。

---

## 1. 决策上下文（源会话已确认）

| # | 决策点 | 结论 | 成本评估 |
|---|--------|------|----------|
| 1 | 产品定位 | **转向**：从 session 级工具转为全生命周期工具 | 中（PRODUCT.md 重写 + ADR） |
| 2 | 状态机架构 | **每层独立状态机**（3 个）+ 2 个无状态服务 | 中（架构复杂但 scope 清晰） |
| 3 | glossary 强度 | **强制**（lock gate 校验术语定义） | 小（多一步 gate） |
| 4 | L5 claim 并发 | **完整 mattpocock claim**（lock + assignee + TTL + stale 清理） | **大（之前低估）** |
| 5 | 现有 topic 迁移 | **不迁移**（老 topic 留在 `~/.cw/` 孤立但安全） | 省（无迁移脚本，破坏性自由） |
| 6 | 交付节奏 | **渐进 3 阶段**（L1+L4 → L2 → L5） | 中性 |

### 决策 4 的隐藏成本重评

mattpocock 把并发 claim 外包给 GitHub Issues（assignee 字段是 GH 提供的原子操作）。cw 1.0 自己实现要解决：
- **claim 非原子**：读 lock 文件 → 检查 → 写 lock，中间有 race condition
- **stale lock 清理**：claimer 失联后需 TTL + heartbeat 机制回收
- **agent 身份注入**：多 agent 协调需要每个 agent 启动时注入 id

**结论**：L5 的并发 claim 子系统单独作为阶段 3 的子任务，不阻塞阶段 1/2。阶段 1/2 的 L5（如提前做）先用状态机强制 single-claim（无并发），保留 `claim` action 名备未来扩展。

### 决策 5 的简化收益

1.0 全新 `.cw/` 项目级 store，老 topic 留在 `~/.cw/` 孤立但安全。可以零代价做破坏性 store 重设计。代价：老 topic 不能继续推进（只能查），新工作必须从 L3 重开。对单人项目可接受；如果未来有多用户/团队场景，再补迁移工具。

---

## 2. 产品定位转向

### 2.1 当前 cw vs 新 cw

| 维度 | 当前 cw (0.x) | 新 cw (1.0) |
|------|---------------|-------------|
| 定位 | session 级执行约束工具 | 全生命周期编码流程编排工具（plan + do 都管） |
| 边界 | 单 topic 生命周期 | 从 loose idea 到 closeout 全链路 |
| 核心价值 | 机器证据约束 agent 执行 | 跨 scope 流程编排 + 各层独立的机器约束 |
| scope 覆盖 | L3（topic） | L1-L5 全覆盖 |

### 2.2 PRODUCT.md:53 推翻声明

PRODUCT.md:53 当前明确：
> **不做 CI/CD 集成** — CW 是 session 级工具（单 topic 生命周期），不是 pipeline 级工具。

**本重设计推翻此条**。按 PRODUCT.md:45 自己的规矩「新需求若想推翻某条，须先改本文件 + 加 ADR」，阶段 1 必须先做：
1. 改写 PRODUCT.md:53（从「session 级」转为「全生命周期」）
2. 新增 ADR `docs/adr/NNNN-lifecycle-redesign.md`，记录转向理由（wayfinder 讨论中诊断出 scope 层缺失是 topic 粒度模糊的根因）

### 2.3 守住的边界

转向后仍然守的非目标（不动）：
- **PRODUCT.md:47 不做 agent harness 集成** — 仍是 bash 调命令 + 读 guidance
- **PRODUCT.md:49 不做硬性阻断** — gate 熔断只告警不阻断的原则保留（各层 gate 失败都不阻止 agent 继续重试）
- **PRODUCT.md:51 不做远程服务依赖** — 仍是纯本地，零 True-external 依赖

---

## 3. 架构哲学

**核心决定**：不是单巨型状态机。一个状态机管 L1-L5 会爆炸（action 数从 19 涨到 50+），且违反不同层的生命周期差异（L5 effort 跨月、L3 topic 跨天、L2 问题跨小时）。

### 3.1 三个设计决定

1. **每层一个独立状态机**：各有自己的 action / status / gate，生命周期互不干扰
2. **共享 store**（项目级 `.cw/`）：L1 词汇层横向被所有层访问，跨层数据用 `{layer}/{slug}` 字符串指针关联
3. **单一 CLI**（保持 `cw`）：action 按层 namespace，`cw effort:* / cw spec:* / cw topic:* / cw research / cw adr:*`

### 3.2 同步满足的约束

- **agent-agnostic 不变**：还是 bash 调命令 + 读 stdout JSON
- **每层 scope 清晰**：每层只管自己 scope 的产物
- **跨层衔接通过数据指针**：不是状态机互相调用

---

## 4. scope 分层论证（L1-L5）

### 4.1 核心洞察

调研 matt skills 与 cw 后发现根本区别：

- **matt 的产物分 5 个 scope 层**，skill 之间是**跨层转换器**（to-spec 把对话提升到 feature 层，to-tickets 把 feature 下沉到 slice 层）
- **cw 的产物几乎全挤在 topic 这一层**，action 之间是**同 scope 内的阶段推进**（plan → tdd_plan → dev → test 不是 scope 变化，是同 topic 在不同执行阶段）

**cw 当前 topic 粒度模糊的精确诊断**：不是粒度大小问题，是 **scope 层缺失问题**。一个 topic 同时承担了 matt 的 ticket 和 spec 两层——既要做 spec 收敛（clarify 阶段产 SpecSections），又要做 ticket 执行（dev/test/review）。matt 把这两层分离，cw 合在一起。

### 4.2 统一 scope 分层（matt + cw + 缺口）

按 scope 从小到大分 5 层：

| Layer | Scope | matt (plan) | matt (do) | cw 0.x | cw 1.0 补 |
|-------|-------|-------------|-----------|--------|-----------|
| **L1** | 单个决策 | ADR / glossary 术语 | — | ADR / ClarifyRecord | + 强制 glossary |
| **L2** | 单个待解问题 | Research finding / Prototype verdict | — | **缺口** | + research / prototype |
| **L3** | 单 session 可完成 slice | Ticket（to-tickets 产） | Ticket（implement 执行） | Topic（错位承担 spec+ticket） | Topic（仅 ticket 职责） |
| **L4** | 单 feature / 子系统 | Spec (PRD)（to-spec 产） | — | **缺口**（SpecSections 错位在 L3） | + spec 状态机 |
| **L5** | 多 feature 大 effort | Map（wayfinder 产） | — | **缺口** | + effort 状态机 |

### 4.3 最易混淆点澄清：matt Ticket ≠ cw Wave

两个都叫「切片」但 scope 差一级：

```
matt:  Spec (L4) ──to-tickets──> N × Ticket (L3) ──each──> 1 个 cw topic
cw:    SpecSections (L3) ──plan──> N × Wave (L3 内子切片) ──each──> 1 个 git commit
```

- **matt 的 ticket 是跨 topic 的**：一个 spec 拆成 N 个 ticket，每个 ticket 对应 cw 的一个 topic
- **cw 的 wave 是 topic 内的**：一个 topic 拆成 N 个 wave，每个 wave 是一次 dev commit

cw topic 和 matt ticket **同级**（都是 L3），不是中间层。源会话 handoff 文档第 44-57 行的「粒度对比图」把 cw topic 画在 matt ticket 和 matt map 之间——**位置错了**。

### 4.4 完整关系图

```
scope ▲
 L5   │  [ Map + decision tickets ] ◄── wayfinder 思想 (cw 1.0 L5 effort 状态机)
effort│  (.cw/efforts/{slug}/map.md)        │ collapse
      │                                    ▼
 L4   │  [ Spec / PRD ] ◄── to-spec 思想 (cw 1.0 L4 spec 状态机)
feature│ (.cw/specs/{slug}.md)              │ split
      │                                    ▼
 L3   │  ┌─────────────────────────────────────────────────────────┐
slice │  │  matt Ticket  ═════  cw Topic  （两者同级，scope 相同）    │
      │  │                                                          │
      │  │   cw topic 内部阶段链（不跨 scope，只在 L3 内推进）：        │
      │  │   create → clarify → plan → tdd_plan → dev → review →    │
      │  │   test → retrospect → closeout                            │
      │  │                                                          │
      │  │   cw topic 内部还往下拆一级（L3 子切片）：                  │
      │  │   plan 产 waves[] ── each wave ──> 1 个 git commit        │
      │  │   tdd_plan 产 testCases[] ── each case ──> 1 个测试       │
      │  └─────────────────────────────────────────────────────────┘
      │                                    ▲
 L2   │  [ Research / Prototype ] ─────────┘  fold 进 spec/ticket
问题  │  (.cw/research/ + .cw/prototypes/)
      │
 L1   │  [ ADR / glossary ] ─── 跨所有层被读（横向词汇基底）
决策  │  (.cw/decisions/adr/ + .cw/decisions/glossary.md)
      └──────────────────────────────────────────────────▶ 阶段
         plan                              do
```

---

## 5. 各层设计

### 5.1 L1 决策层（横向词汇基底）

**职责**：跨所有层持久的决策记录 + 领域词汇。被 L2-L5 所有层读取。

| 项 | 设计 |
|---|---|
| 性质 | **无状态服务**（不进状态机） |
| action | `cw adr add/list/show`、`cw glossary add/list/check` |
| 产物 | ADR（`decisions/adr/NNNN-*.md`）+ glossary（`decisions/glossary.md` + `decisions/glossary.json` 索引） |
| gate | 无（append-only，纯记录）；但 glossary 是 L4 spec lock gate 的输入 |
| 生命周期 | 永久持久，跨 effort/topic |
| 触发 | L2-L5 任何层做完决策后 agent 主动沉淀；或用户直接调 |

**关键设计**：glossary 不是 matt 那种「inline 更新无结构」，要结构化（term / definition / related-decisions / first-seen-in），这样能被机器校验「spec 里用了未定义的术语」（决策 3 强制）。

### 5.2 L2 问题层（research / prototype）

**职责**：单个待解问题的收敛。用完即弃或 fold 进上层。

| 项 | 设计 |
|---|---|
| 性质 | **无状态服务**（不进状态机） |
| action | `cw research start/resolve`、`cw prototype start/verdict` |
| 产物 | Research finding（`research/{slug}.md`，每条 claim 必须引 primary source）+ Prototype（throwaway branch + verdict markdown） |
| gate | 硬 gate：research resolve 必须有 cited source；prototype verdict 必须有明确结论（adopt/reject/needs-more） |
| 生命周期 | finding 半永久（落 repo 供引用）；prototype 即用即弃（branch 保留，main 只留 verdict） |
| 触发 | L3 topic 执行中遇到未解问题；或 L4/L5 规划中需要 fact 支撑决策 |

**关键设计**：L2 不进任何状态机，是**无状态的原子动作**（start 立即 resolve，或跨 session 续）。理由：问题收敛本质是单 session 工作，不需要状态机编排。matt 的 research/prototype 也是无状态 skill。

### 5.3 L3 slice 层（= 当前 cw topic，基本保留）

**职责**：单个可执行 slice 的全流程约束。**这一层基本不动**——当前 cw 的核心价值就在这。

| 项 | 设计 |
|---|---|
| 性质 | **状态机**（保留现有 8 态 + 19 action） |
| action | 现有 19 action 全保留（create / clarify / confirm_clarify / spec_review / spec_review_fix / plan / plan_review / plan_review_fix / tdd_plan / dev / review / review_fix / test / test_fix / retrospect / closeout / replan / abort / assess） |
| 产物 | 现有全保留（SpecSections / dev-plan / test.json / waves / testCases / evidence / ...） |
| gate | 现有全保留（planCheck / tdd-red-light / commit-anchor / judgeByExpected / append-only） |
| 变化 | **`create` 增加 `--from-spec <slug>` 参数**（见 §6 跨层边） |

**唯一改动**：`cw topic create --from-spec <slug>` 时 topic 从 L4 spec 继承 acceptance criteria，skip 大部分 clarify（spec 已 lock）。clarify 阶段降级为「topic 级的小歧义澄清」，不再承担 feature 级 spec 收敛。无 `--from-spec` 时走旧的裸 objective 模式（兼容单 slice 小工作）。

### 5.4 L4 feature 层（spec / PRD）—— 当前最大缺口

**职责**：把收敛后的需求折叠成可构建的 feature 蓝图，可拆成 N 个 topic。

| 项 | 设计 |
|---|---|
| 性质 | **状态机**（4 态：drafting → reviewing → locked → split → archived） |
| action | `cw spec draft/review/lock/split/archive` |
| 产物 | Spec（`specs/{slug}.md`：Problem / Solution / FR / AC / UC / decisions / out-of-scope）+ 结构化镜像（`specs/{slug}.state.json`） |
| gate | 硬 gate：lock 前必须 FR 全覆盖 AC；lock 前必须 glossary 术语全定义；split 前必须 locked；split 产出的每个 topic 必须有明确 acceptance criteria |
| 生命周期 | locked 后持久，作为该 feature 所有 topic 的真值来源；code-review 阶段对照 spec 比对（matt 早就这么做，cw 当前缺这层） |
| 触发 | L5 map collapse 产出；或用户直接 `cw spec draft`（小 feature 不必走 L5） |

**关键设计**：
- `cw spec split` 是 L4→L3 的转换器（= matt 的 to-tickets）。产出 N 个 topic 骨架，每个带 acceptance criteria + blocking 顺序。
- spec 是 code-review 的 Spec 轴真值来源（matt code-review 早就这么做，cw 当前 review 只看代码标准不能看 spec 对齐，1.0 修复）。

### 5.5 L5 effort 层（map）—— 当前完全缺失

**职责**：跨多 feature 的大工作决策收敛。**只规划不执行**（Plan, don't do，matt 原则）。

| 项 | 设计 |
|---|---|
| 性质 | **状态机**（5 态：charting → resolving → ready-to-collapse → collapsed → abandoned） |
| action | `cw effort create/ticket/block/claim/resolve/graduate/collapse/abort` |
| 产物 | Map（`efforts/{slug}/map.md`：Destination / Notes / Decisions-so-far / Not-yet-specified / Out-of-scope）+ Tickets（`efforts/{slug}/tickets/{id}.md`） |
| ticket type | 4 种：research / prototype / grilling / task（对应 L2 的调用或对话收敛） |
| gate | 硬 gate：claim-before-resolve / single-claim（阶段 3 升级为完整 claim）/ resolution-required / map-index-consistency / collapse-ready（全 closed + fog 清空） |
| 生命周期 | 跨 session 长期；collapse 后归档但可查 |
| 触发 | 用户的 loose idea，且 `cw effort create` 检测到「单 spec 装不下」时引导走 L5 |

**关键设计**：
- `cw effort collapse` 是 L5→L4 的转换器。折叠 map 成 1-N 个 spec（按 feature 边界），每个 spec 带从 map 继承的 destination + decisions 上下文。
- fog of war 机制保留：Not-yet-specified 故意不完整，ticket resolve 后 graduate 新 ticket，直到 fog 清空才能 collapse。

---

## 6. 跨层转换边

### 6.1 5 条转换边

```
                    ┌─────────────────────────────────────────────┐
                    │           L1  decisions/adr + glossary       │  横向词汇基底
                    │           （所有层读，决策沉淀处）              │  （被 L2-L5 引用）
                    └─────────────────────────────────────────────┘
                                      ▲ ▲ ▲ ▲
                                      │ │ │ │ 沉淀决策
                    ┌─────────────────┘ │ │ │
                    │     ┌─────────────┘ │ │
                    │     │     ┌─────────┘ │
                    │     │     │           │
┌────────┐  collapse  ┌────────┐  split  ┌────────┐  from-spec  ┌────────┐
│  L5    │ ─────────▶ │  L4    │ ──────▶ │  L3    │ ──────────▶ │  L3    │
│ effort │            │ spec   │         │ topic  │             │ dev... │
│ (map)  │            │ (PRD)  │         │ create │             │        │
└────────┘            └────────┘         └────────┘             └────────┘
                          ▲                                        │
                          │ draft 时引用                            │ 执行中遇未解问题
                          │                                        ▼
                          │     ┌────────┐  fold 进 spec/ticket  ┌────────┐
                          └─────│  L2    │ ◀─────────────────── │  L3    │
                                │research│                      │ (topic)│
                                │prototype                      └────────┘
                                └────────┘
```

| 边 | 转换器 | 方向 | 产出 |
|----|--------|------|------|
| L5→L4 | `cw effort collapse` | effort 折叠成 feature 蓝图 | 1-N 个 spec draft |
| L4→L3 | `cw spec split` | feature 切成可执行 slice | N 个 topic 骨架（带 AC + blocking） |
| L3→L2 | topic 执行中 `cw research/prototype` | 遇未解问题下沉 | finding / verdict，fold 回 topic |
| L2→L1 | research/prototype resolve 时 | 问题答案沉淀为决策 | ADR / glossary term |
| 任意→L1 | 任何层决策后 | 横向沉淀 | ADR / glossary term |

### 6.2 多入口设计

- **L4 的双入口**：可以从 L5 collapse 来（大 effort），也可以用户直接 `cw spec draft`（小 feature 不必走 L5）。两条路都合法。
- **L3 的简化入口**：保留 `cw topic create` 直接给 objective（跳过 L4/L5），用于「单 slice 小工作」。但不鼓励——guidance 会提示「这个 objective 看起来需要 spec，建议先 `cw spec draft`」。

---

## 7. 完整流程执行步骤

### 7.1 总览：3 状态机 + 2 无状态服务

```
L1 (无状态服务)     L2 (无状态服务)        L3/L4/L5 (状态机)
─────────────      ──────────────         ──────────────────
adr add            research start         ┌─ L5 effort ─┐
glossary add       research resolve       │ charting    │
glossary check     prototype start        │ resolving   │
                   prototype verdict      │ collapsed   │
                                          │ abandoned   │
                                          └─────────────┘
                                          ┌─ L4 spec ───┐
                                          │ drafting    │
                                          │ reviewing   │
                                          │ locked      │
                                          │ split       │
                                          └─────────────┘
                                          ┌─ L3 topic ──┐
                                          │ (现有 8 态)  │
                                          └─────────────┘
```

### 7.2 L5 effort 状态机（8 action）

| # | Action | 触发条件 | 转换 |
|---|--------|----------|------|
| 1 | `cw effort create <slug>` | 用户 loose idea | →charting |
| 2 | `cw effort ticket <effort> --type <t> --title "..."` | charting 中 | 内部（ticket 索引 +1） |
| 3 | `cw effort block <ticket> by <deps>` | ticket 存在 | 内部（wire 依赖） |
| 4 | `cw effort claim <ticket>` | frontier 非空 + 无其他 claim（阶段 3 升级为完整并发 claim） | 内部（ticket: claimed） |
| 5 | `cw effort resolve <ticket> --resolution "..."` | 已 claim + claim 未过期 | 内部（ticket: resolved + map 更新） |
| 6 | `cw effort graduate <ticket> <new-slug> ...` | resolve 后 fog 可毕业 | 内部（新 ticket + fog 清条目） |
| 7 | `cw effort collapse <effort>` | 全 resolved + fog 空 | charting/resolving → collapsed |
| 8 | `cw effort abort <effort>` | 任意 | →abandoned |

查询（不进状态机）：`cw effort status / list / show <ticket>`

### 7.3 L4 spec 状态机（5 action）

| # | Action | 触发条件 | 转换 |
|---|--------|----------|------|
| 1 | `cw spec draft <slug> [--from-effort <e>]` | L5 collapse 产出 / 用户直接建 | →drafting |
| 2 | `cw spec review <spec>` | drafting 中 | →reviewing（多轮 fix loop） |
| 3 | `cw spec lock <spec>` | 无 open review issue + FR 覆盖 AC + 术语全定义 | reviewing → locked |
| 4 | `cw spec split <spec>` | locked | locked → split（产 N topic 骨架） |
| 5 | `cw spec archive <spec>` | split 后 | split → archived |

查询：`cw spec status / list / show`

### 7.4 L3 topic 状态机（19 action，现有 + 调整）

**唯一调整**：`cw topic create` 增加 `--from-spec <slug>` 参数。其他 18 action 全保留不变（包括所有 fix loop、replan、abort、assess）。

### 7.5 L1/L2 无状态服务

- **L1**：`cw adr add/list/show`、`cw glossary add/list/check`
- **L2**：`cw research start/resolve`、`cw prototype start/verdict`

### 7.6 典型全流程路径（L5 → L4 → L3）

```
用户：「我想重构认证系统，但还没想清楚」

L5 effort:
  cw effort create auth-refactor           # 建 map
  cw effort ticket ... × 5                 # chart 初始 5 张决策 ticket
  cw effort block T3 by T1,T2              # wire 依赖
  cw effort claim T1                       # claim 第一张
    └─ (T1 是 research type) ─> cw research start oauth-providers
        cw research resolve oauth-providers # finding fold 回 T1
  cw effort resolve T1                     # 记录决策 + 更新 map
  cw effort graduate T1 new-session-design # fog 毕业成新 ticket
  ... 重复直到 fog 空 ...
  cw effort collapse auth-refactor         # → 产 2 个 spec draft

L4 spec (× 2，并行或串行):
  cw spec review spec-session-design
  cw spec lock spec-session-design         # 术语校验 + FR/AC 校验
  cw spec split spec-session-design        # → 产 3 个 topic 骨架

L3 topic (× 3，按拓扑顺序):
  cw topic create --from-spec spec-session-design --pick 1
  cw topic clarify                         # 仅 topic 级小歧义
  cw topic plan / tdd_plan / dev / review / test / retrospect / closeout
  ... 重复 topic 2、3 ...

L1 沉淀（任意时机，跨所有层）:
  cw adr add --title "OAuth provider abstraction" ...
  cw glossary add --term "session" --definition "..."
```

---

## 8. guidance 衔接机制

cw 的核心模式：每个 action 返回 `nextAction.guidance`（纯文本，agent 按 guidance 推进）。跨层后 guidance 有 4 种模式。

### 8.1 4 种 guidance 模式

| 模式 | 触发 | 例子 |
|------|------|------|
| **层内推进** | 同层 action 完成 | topic create 完成 → guidance: "下一步 `cw topic clarify`" |
| **跨层下沉** | 高层产出喂低层 | effort collapse 完成 → guidance: "已产 N 个 spec draft。对每个走 `cw spec review` → `cw spec lock` → `cw spec split`" |
| **层间跳转下沉** | 高层 ticket 是低层 type | claim research type ticket → guidance: "建议先 `cw research start <slug>` 收敛，再 `cw effort resolve`" |
| **层间上浮** | 低层发现高层问题 | topic clarify 发现 spec 有大漏洞 → guidance: "spec 似乎不完整，建议 `cw spec review` 重新审查（当前 topic 可 abort）" |

### 8.2 关键跨层 guidance 触发点

| 触发 action | guidance 类型 | guidance 内容要点 |
|-------------|---------------|-------------------|
| `cw effort collapse` 完成 | 跨层下沉 | 列出产出的 spec slug + 下一步 `cw spec review <slug>` |
| `cw effort claim <research-ticket>` | 层间跳转 | 提示先 `cw research start`，research resolve 后回 `cw effort resolve` |
| `cw effort claim <prototype-ticket>` | 层间跳转 | 提示先 `cw prototype start`，verdict 后回 `cw effort resolve` |
| `cw spec split` 完成 | 跨层下沉 | 列出 topic 骨架 + 拓扑顺序 + 下一步 `cw topic create --from-spec <slug> --pick <first>` |
| `cw spec lock` 失败（术语缺失） | 层间上浮 | 列出未定义术语 + 提示 `cw glossary add` 或修改 spec |
| `cw topic create --from-spec` 完成 | 层内推进 | spec 已 lock，clarify 阶段可简化，直接进 `cw topic plan` |
| `cw topic clarify` 发现大歧义 | 层间上浮 | "此歧义超出 topic 级，建议 abort 当前 topic，回 `cw spec review <slug>`" |
| `cw topic closeout` 完成 | 跨层上浮（spec 维度） | 提示该 spec 还有 N 个 topic 待做，或全部完成可 `cw spec archive` |

### 8.3 guidance 文本设计原则

1. **总是带下一步命令**：guidance 不是「想想看」，是「跑 `cw xxx`」
2. **跨层 guidance 带完整 slug**：不留「上一个命令的 topic id」这种隐式状态，每次重述
3. **多选项时给优先级**：「建议先 A，因为 X；若不适用走 B」
4. **gate 失败 guidance 给修复路径**：不只说「失败」，说「跑 `cw glossary add` 补术语后重试」

---

## 9. 数据载体与格式规范

### 9.1 项目级 `.cw/` store

从当前 `~/.cw/<enc>/_cw.json`（用户级加密）**改为项目级** `.cw/`：

```
.cw/
  _meta.json                    # 项目元数据（cw version、创建时间）

  efforts/                      # L5
    {effort-slug}/
      map.md                    # 人可读 map
      state.json                # 状态机 + claim 记录
      tickets/
        {ticket-id}.md

  specs/                        # L4
    {spec-slug}.md              # 人可读 PRD
    {spec-slug}.state.json      # 结构化 FR/AC/UC + status + 派生的 topics[]
    {spec-slug}/
      changes/
        spec-review-{turn}.md   # 多轮 review 记录

  topics/                       # L3（升级当前 .xyz-harness/）
    {topic-slug}/
      _cw.json                  # 现有 store 结构保留
      changes/                  # 现有 review/retrospect md 保留
      plan.md / test.json       # 现有产物保留

  research/                     # L2
    {research-slug}.md          # cited findings

  prototypes/                   # L2
    {proto-slug}/
      verdict.md                # 结论
      branch-ref                # throwaway branch 指针

  decisions/                    # L1
    adr/
      0001-{title}.md
    glossary.md                 # 结构化术语表（人读）
    glossary.json               # 纯结构化索引（机器校验用）
```

**为什么改项目级**：跨层引用需要文件系统指针（spec 引用 ticket、topic 引用 spec）。用户级加密 store 做不到干净的跨层指针。项目级 `.cw/` 和 git 一起走，团队共享（如果需要），跨层关系自然落地。

**决策 5（不迁移）的后果**：1.0 全新 `.cw/` store，老 topic 留在 `~/.cw/` 孤立但安全。老 topic 不能继续推进（只能查），新工作必须从 L3 重开。

### 9.2 统一原则

1. **所有产物用 markdown + YAML frontmatter**：人读 body，机器读 frontmatter。和 matt 的 issue 模式一致。
2. **结构化字段最小化**：只把状态机/gate 真正消费的字段放 frontmatter，自由描述放 body。避免过度结构化。
3. **跨层引用用 `{layer}/{slug}` 字符串**：不嵌套对象，用引用。例 `derived-from: effort/auth-refactor`。
4. **append-only 在层内有差异**：L3 wave/testCase append-only；L5 decisions-so-far append-only；L4 spec lock 后 freeze（不是 append 是 freeze）。
5. **混合产物 = frontmatter + body 双轨**：结构化字段进 frontmatter，同内容的人可读版本进 body（或由 `cw show` 渲染）。

### 9.3 各产物 schema

#### 9.3.1 L5 effort 产物

**`efforts/{slug}/map.md`**（混合）

```yaml
---
slug: auth-refactor
status: charting | resolving | collapsed | abandoned
created-at: 2026-07-19T...
collapsed-at: null
derived-specs: []              # collapse 后填充
ticket-count: 0
---
```

```markdown
## Destination
<自由描述：到达终点的样子>

## Notes
<domain / 常用 skill / standing preferences>

## Decisions so far
<!-- append-only 索引，一行一个 closed ticket -->
- [T1: OAuth provider 抽象层](tickets/T1-oauth-abstraction.md) — 采用 adapter 模式

## Not yet specified
<!-- fog，resolve 后清空 -->
- session 存储方案待定（取决于 T1 的 adapter 选择）

## Out of scope
- 不做 SSO（destination 不含）
```

**`efforts/{slug}/state.json`**（纯结构化）

```json
{
  "slug": "auth-refactor",
  "status": "resolving",
  "tickets": [
    {"id": "T1", "slug": "oauth-abstraction", "type": "research",
     "status": "resolved", "blocked-by": [], "claimed-by": null,
     "resolved-at": "...", "resolution-gist": "采用 adapter 模式"}
  ],
  "locks": []
}
```

**`efforts/{slug}/tickets/{id}-{slug}.md`**（混合）

```yaml
---
id: T1
slug: oauth-abstraction
type: research | prototype | grilling | task
status: open | claimed | resolved
created-at: ...
claimed-by: agent-xxx
claimed-at: ...
claim-ttl: 3600
blocked-by: []
blocks: []
resolution-gist: null
---
```

```markdown
## Question
<自由描述：这张 ticket 要解决的决策>

## Resolution
<!-- resolve 时追加 -->
采用 adapter 模式，因为...

## Graduated
<!-- graduate 时追加 -->
- T4: session-store-adapter
```

**`efforts/{slug}/tickets/{id}.lock`**（阶段 3，决策 4 新增，纯结构化）

```json
{
  "ticket-id": "T1",
  "claimer-id": "agent-xxx",
  "claimed-at": "...",
  "expires-at": "...",
  "heartbeat-at": "..."
}
```

#### 9.3.2 L4 spec 产物

**`specs/{slug}.md`**（混合）

```yaml
---
slug: session-design
status: drafting | reviewing | locked | split | archived
created-at: ...
locked-at: null
derived-from: effort/auth-refactor
derived-topics: []
review-turn: 0
---
```

```markdown
## Problem
<自由描述>

## Solution
<自由描述>

## Functional Requirements
<!-- 半结构化：每条 FR 带 id + 关联 AC -->
- FR1: 支持 OAuth 登录
  - AC: [AC1, AC2]

## Acceptance Criteria
- AC1: 用户能用 Google 登录

## Out of Scope
- SSO

## Decisions
<!-- 引用 L1 ADR，不重复内容 -->
- [ADR-0003: OAuth adapter](../decisions/adr/0003-oauth-adapter.md)
```

**`specs/{slug}.state.json`**（纯结构化）

```json
{
  "slug": "session-design",
  "status": "locked",
  "fr": [{"id": "FR1", "ac": ["AC1", "AC2"], "covered": true}],
  "terms-used": ["OAuth", "session", "adapter"],
  "terms-undefined": [],
  "review-issues": []
}
```

#### 9.3.3 L3 topic 产物

**完全保留现有结构**，唯一变化：`topics/{slug}/_cw.json` 的 topic 记录增加字段：

```json
{
  "topicId": "...",
  "slug": "session-design-1-impl",
  "objective": "...",
  "from-spec": "session-design",
  "acceptance-criteria": [],
  ...
}
```

其他产物（plan.md / test.json / waves / testCases / evidence / gateHistory / retrospect）全保留现有格式。

#### 9.3.4 L2 产物

**`research/{slug}.md`**（混合）

```yaml
---
slug: oauth-providers
question: "主流 OAuth provider 的 API 差异"
status: resolved
started-at: ...
resolved-at: ...
related-ticket: T1
sources-count: 0
---
```

```markdown
## Findings
<!-- 自由描述，每条 claim 引 source -->

## Sources
- [Google OAuth docs](https://...)
- [GitHub OAuth guide](https://...)
```

**`prototypes/{slug}/verdict.md`**（混合）

```yaml
---
slug: session-store-redis
question: "Redis 是否适合做 session store"
verdict: adopt | reject | needs-more
summary: "适合，因为..."
related-ticket: T4
branch-ref: proto/session-store-redis
created-at: ...
---
```

```markdown
## Detail
<!-- 自由描述：原型怎么做的、观察到什么 -->
```

#### 9.3.5 L1 产物

**`decisions/adr/NNNN-{slug}.md`**（标准 ADR 格式 + frontmatter）

```yaml
---
id: 0003
title: OAuth adapter pattern
status: proposed | accepted | deprecated
created-at: ...
related-spec: session-design
related-effort: auth-refactor
---
```

```markdown
# ADR 0003: OAuth adapter pattern

## Context
<为什么需要这个决策>

## Decision
<决策内容>

## Consequences
<后果，正负都写>
```

**`decisions/glossary.md`**（混合，单文件）

```yaml
---
updated-at: ...
term-count: 0
---
```

```markdown
## OAuth
- **definition**: 开放授权协议，允许第三方应用访问用户资源
- **first-seen-in**: effort/auth-refactor
- **related**: [session, token]

## session
- **definition**: 用户登录后的会话状态
- **first-seen-in**: spec/session-design
- **related**: [OAuth, token]
```

**`decisions/glossary.json`**（纯结构化索引，给 lock gate 机器校验用）

```json
{
  "terms": {
    "OAuth": {"definition": "...", "first-seen-in": "effort/auth-refactor"},
    "session": {"definition": "...", "first-seen-in": "spec/session-design"}
  }
}
```

### 9.4 数据格式原则总结表

| 产物类别 | 格式 | 结构化部分 | 非结构化部分 |
|----------|------|------------|--------------|
| 状态机消费 | `_state.json` / `state.json` | 全部 | 无 |
| gate 校验 | frontmatter | 状态/id/引用 | 无 |
| 人读内容 | `.md` body | 无 | 全部 |
| 决策记录 | ADR md | frontmatter（id/status/引用） | Context/Decision/Consequences |
| 索引（map Decisions / glossary） | md section | 标题 + 一行 gist | 详细内容引用别处 |
| 锁文件 | `.lock` json | 全部 | 无 |

**核心原则**：**决策只活在一处**（matt 原则的机器化）。同一决策不在 map、ticket、spec、ADR 四处重复——决策的「真值」在 ADR（L1），其他地方只 gist + 引用。map 的 Decisions-so-far 是索引不是内容；spec 的 Decisions section 引用 ADR；ticket 的 Resolution 是 ticket-specific 决策（不上升到 ADR 级）。

---

## 10. 渐进交付阶段

### 阶段 1：L1 + L4 + 基建（最高价值）

**范围**：
- L1 决策层（ADR + 强制 glossary）
- L4 spec 状态机（draft/review/lock/split/archive）
- 项目级 `.cw/` store 基建（含 `_meta.json`）
- `cw topic create --from-spec` 参数（L3 微调）
- PRODUCT.md 重写 + ADR（产品定位转向）

**工程量**：大（~2-3 倍当前 cw 体量）

**价值**：最高——补 L4 直接解决 topic 粒度模糊的根因；强制 glossary 消除术语歧义。

### 阶段 2：L2（中价值）

**范围**：
- L2 research（start/resolve，cited source gate）
- L2 prototype（start/verdict，adopt/reject gate）

**工程量**：中

**价值**：中——补充问题收敛机制。可在 topic 执行期（L3）和 spec 起草期（L4）触发。

### 阶段 3：L5 + claim 子系统（低频高价值）

**范围**：
- L5 effort 状态机（create/ticket/block/claim/resolve/graduate/collapse/abort）
- 完整 claim 并发子系统（决策 4：lock 文件 + assignee + TTL + heartbeat + stale 清理）
- fog of war 机制（Not-yet-specified + graduate）

**工程量**：大（claim 子系统单独成本可能抵得上 L4 整层）

**价值**：低频但高价值——只有大 effort 才用，但用了能解决跨多 feature 的决策编排。

### 工程量预估表

| 阶段 | 范围 | 工程量 | 价值 |
|------|------|--------|------|
| 1 | L1 + L4 + store 基建 + PRODUCT.md/ADR | 大 | 最高 |
| 2 | L2（research/prototype） | 中 | 中 |
| 3 | L5 + claim 子系统 | 大 | 低频但高价值 |

---

## 11. 与现有 topic 的关系

### 11.1 取代 `mattpocock-skills-integration/plan.md` 6.2

`mattpocock-skills-integration/plan.md` 的 6.2 是 wayfinder **降级检查清单版**（W1），明确标注「完整方案在 wayfinder handoff 讨论」。本重设计**取代** 6.2——cw 1.0 直接做完整 L5 effort 状态机（含 collapse 转 spec），不再做 W1 降级清单。

**实施影响**：
- 阶段 1 时不影响 6.2（6.2 是 `cw skill wayfinder` 返回检查清单，阶段 1 不涉及 L5）
- 阶段 3 实施后，6.2 的检查清单可以下线（被完整 L5 状态机取代），或保留作为「不想走状态机、只想快速自检」的轻量入口

### 11.2 与 mattpocock-skills-integration 其他批次的并存

mattpocock-skills-integration 的其他批次（固定节点 skill 内化、`cw skill` 命令机制、词表三层）**与本重设计并存**，不冲突：
- 批次 1（`cw skill` 机制）→ 本重设计的 L1/L2 guidance 可调用同一机制
- 批次 2/3（固定节点 prompt 内化）→ 都在 L3 topic 内，本重设计不动 L3 prompt
- 批次 4 的 6.3（仓库规范采集）→ 独立，不冲突
- 批次 4 的 6.4（阶段 guidance 加 skill 索引）→ 本重设计的跨层 guidance 是新增维度，不替换 6.4

### 11.3 与 P3 ticket 重构的关系

`mattpocock-skills-integration` 提到的 P3 ticket 重构（handoff 到 `cw-handoff-ticket-LiHOg5`）属于 L3 内部的 wave/testCase 结构改造，**与本重设计正交**。本重设计不动 L3 内部结构（只加 `--from-spec` 入口参数），P3 可以独立推进。

---

## 12. 开放问题（实施前需确认）

以下 4 个问题在源会话结尾提出但未确认。阶段 1 进 plan mode 前必须明确：

1. **L4 spec 的 FR/AC 结构化程度**：当前设计是 FR/AC 放 md body（半结构化，人可读）+ `state.json` 镜像（纯结构化，给 lock gate 校验）。这意味着 agent 写 spec 时要双写。可接受？还是只放 `state.json`，md body 由 `cw spec show` 渲染？
2. **glossary 单文件 vs 拆分**：当前设计是单 `glossary.md` + `glossary.json` 索引。如果 term 会很多（>100），单 md 会爆炸。项目预期 term 量级？
3. **L2 research 的 sources 强制**：当前设了 gate「sources-count > 0」。但有些 research 是读本地代码（无外部 source）。要不要区分「external research」（必须 cited）vs「internal exploration」（无需 cited）？
4. **claim TTL 默认值**（阶段 3 才需要）：决策 4 要求 TTL。默认 1 小时？还是按 ticket type 区分（research 长、grilling 短）？

---

## 13. 关键文件索引

### 13.1 设计源文件

| 内容 | 路径 |
|------|------|
| 本设计文档 | `.xyz-harness/cw-1-0-lifecycle-redesign/plan.md` |
| wayfinder 定位讨论起点（已被本设计取代） | `/var/folders/3p/d4mx1j_j5s7bn3_03x48kpkw0000gn/T/cw-handoff-2x9dJA/wayfinder-positioning.md` |
| mattpocock skills 整合方案 | `.xyz-harness/mattpocock-skills-integration/plan.md` |
| P3 ticket 重构设计 | `/var/folders/3p/d4mx1j_j5s7bn3_03x48kpkw0000gn/T/cw-handoff-ticket-LiHOg5/ticket-refactor-design.md` |

### 13.2 cw 当前实现锚点（阶段 1 实施时参考）

| 内容 | 路径:行号 |
|------|-----------|
| PRODUCT.md 非目标章节（要推翻 :53） | `PRODUCT.md:42-67` |
| CONTEXT.md 统一语言（要扩展 L1-L5 概念） | `CONTEXT.md` |
| ARCHITECTURE.md 系统架构（要加层叠架构） | `ARCHITECTURE.md` |
| 当前 store 实现 | `src/store.ts` |
| 当前状态机 | `src/state-machine.ts` |
| 当前 action handlers | `src/actions.ts` |
| `cw topic create` 入口 | `src/actions.ts` 的 handleCreate |
| TaskShape 注册表（注册表模式先例） | `src/shapes/registry.ts` |

### 13.3 mattpocock 原始方法论参考

| skill | 路径 |
|-------|------|
| wayfinder（L5 思想来源） | `/Users/zhushanwen/GitApp/ai-skills/mattpocock-skills/skills/engineering/wayfinder/SKILL.md` |
| to-spec（L4 思想来源） | `/Users/zhushanwen/GitApp/ai-skills/mattpocock-skills/skills/engineering/to-spec/SKILL.md` |
| to-tickets（L4→L3 split 思想来源） | `/Users/zhushanwen/GitApp/ai-skills/mattpocock-skills/skills/engineering/to-tickets/SKILL.md` |
| domain-modeling（L1 glossary 思想来源） | `/Users/zhushanwen/GitApp/ai-skills/mattpocock-skills/skills/engineering/domain-modeling/SKILL.md` |
| research（L2 思想来源） | `/Users/zhushanwen/GitApp/ai-skills/mattpocock-skills/skills/engineering/research/SKILL.md` |
| prototype（L2 思想来源） | `/Users/zhushanwen/GitApp/ai-skills/mattpocock-skills/skills/engineering/prototype/SKILL.md` |

---

## 附录 A：决策溯源（源会话关键转折）

本重设计源自 wayfinder 定位讨论的三个关键转折：

1. **第一转折**：wayfinder 不是「进 cw 怎么定位」的问题，而是 cw 缺 L4/L5 层的问题。wayfinder 和 cw 是流水线上下游（规划期 vs 执行期），不是同层竞争品。
2. **第二转折**：调研两边产出物后发现根本区别——matt 是 scope 层叠（skill 是跨层转换器），cw 是单层阶段推进。cw topic 粒度模糊的根因是 scope 层缺失，不是粒度大小。
3. **第三转折**：用户决定「不是重新设计 wayfinder 的问题，而是重新设计整个 cw 流程的问题」——要做就做完整 L1-L5，不分拆成多个独立工具。

详细讨论过程见源会话（2026-07-19）。

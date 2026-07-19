# cw 1.0 全生命周期重设计：详细设计文档

> **状态**：原型验证完成，待迁移阶段
> **源会话**：2026-07-19，从 wayfinder 定位讨论演化为全产品重设计
> **文档定位**：产品级设计真值来源。整合整条论证链路：
>   wayfinder 定位 → L1-L5 分层 → 12 机制通用化 → 通用引擎 + 插件包 → 原型验证
> **配套文档**：
>   - 产品级 plan.md（同目录，5 层架构 + 数据载体 + 渐进交付）
>   - 引擎级 engine-design.md（`docs/engine-design.md`，原型接口与风险验证）
>   - 流程图 lifecycle-flow.html（同目录，6 page，层内流转细节）
>   - 架构图 architecture.html（同目录，2 page，引擎 + 插件包关系）
> **源代码**：`src/engine/`（7 文件 1252 行 + 2 个 config + 11 smoke test 全绿）

---

## 目录

1. [背景和目标](#1-背景和目标)
2. [整体业务流程](#2-整体业务流程)
3. [挑战、难点与解决思路](#3-挑战难点与解决思路)
4. [整体设计和抽象](#4-整体设计和抽象)
5. [骨架引擎细节](#5-骨架引擎细节)
6. [每层插件细节设计](#6-每层插件细节设计)

---

## 1. 背景和目标

### 1.1 起点：cw 0.x 的产品定位

cw 0.x（当前实现，版本 0.0.1）是 **Agent-agnostic 编码流程编排 CLI**。用状态机 + 机器检查 gate，强制 AI 编码任务走结构化流程：

```
create → clarify → plan → tdd_plan → dev → review → test → retrospect → closeout
```

核心价值：**不信任 agent 声明，只信机器验证的证据**（commit 存在性 / TDD 红灯 / expected 精确重算）。把流程约束从「prompt 里说说」变成「状态机里拦住」。

**产品边界**（PRODUCT.md:42-53 的非目标章节）：
- 不做 agent harness 集成（agent 只需 bash 调 `cw` + 读 stdout）
- 不做质量阈值硬性阻断（gate 熔断只告警不阻断）
- **不做 CI/CD 集成——CW 是 session 级工具（单 topic 生命周期），不是 pipeline 级工具**

### 1.2 起点：wayfinder 定位讨论

源会话起点：把 mattpocock-skills 的方法论整合进 cw。10 个候选 skill 里，**wayfinder 是定位最模糊的一个**——它解决的是"单 session 装不下、路线未清"的大工作，但 cw 当前没有对应的层。

mattpocock 的 wayfinder 核心机制：
- **决策地图（the map）**：单一 issue，label `wayfinder:map`，5 段结构（Destination / Notes / Decisions-so-far / Not-yet-specified / Out-of-scope）
- **ticket types**：research / prototype / grilling / task
- **fog of war**：map 故意不完整，解决一张 ticket 清掉前方的雾
- **claim 机制**：session 通过 assign ticket 给自己来 claim，让并发 session 跳过
- **硬规则**：①Plan, don't do（默认只规划不执行）②Refer by name ③每 session 只解一张非 research ticket ④map 是 index 不是 store

关键事实：wayfinder 几乎每一条都缠在 issue tracker 机制上（map/ticket 都是 issue、label、assignee、native blocking、frontier query）。

### 1.3 关键洞察：cw 缺的不是 wayfinder，是 scope 层

第一层诊断：**wayfinder 和 cw 不是同层竞争品，是流水线上下游**。

| | 产出物 | 核心动作 | 时间跨度 |
|---|---|---|---|
| **wayfinder** | 收敛后的清晰 spec | **Plan, don't do**（只决策不执行）| 跨 session，fog 未清前不结束 |
| **cw 0.x** | 机器验证过的代码 | **Do, with gates**（执行 + 约束）| 单 topic，append-only 防偷工减料 |

wayfinder 原文第一段就定义清楚：「finding that way, not charging at the destination」。它**故意不做执行**。cw 的全部价值在执行期的机器约束。

第二层诊断（通过 explorer 调研两边产出物体系后确认）：**matt 是 scope 层叠（skill 是跨层转换器），cw 是单层阶段推进**。

cw 当前 topic 粒度模糊的精确诊断：**不是粒度大小问题，是 scope 层缺失问题**。一个 topic 同时承担了 matt 的 ticket 和 spec 两层——既要做 spec 收敛（clarify 阶段产 SpecSections），又要做 ticket 执行（dev/test/review）。matt 把这两层分离，cw 合在一起。

### 1.4 目标：补齐 L1-L5 全 scope 层

按 scope 从小到大分 5 层。每层标 matt 产物 / cw 0.x 现状 / cw 1.0 补齐：

| Layer | Scope | matt (plan) | matt (do) | cw 0.x | cw 1.0 补 |
|-------|-------|-------------|-----------|--------|-----------|
| **L1** | 单个决策 | ADR / glossary 术语 | — | ADR / ClarifyRecord | + 强制 glossary |
| **L2** | 单个待解问题 | Research finding / Prototype verdict | — | **缺口** | + research / prototype |
| **L3** | 单 session 可完成 slice | Ticket（to-tickets 产）| Ticket（implement 执行）| Topic（错位承担 spec+ticket）| Topic（仅 ticket 职责）|
| **L4** | 单 feature / 子系统 | Spec (PRD)（to-spec 产）| — | **缺口**（SpecSections 错位在 L3）| + spec 状态机 |
| **L5** | 多 feature 大 effort | Map（wayfinder 产）| — | **缺口** | + effort 状态机 |

**产品定位转向**：cw 从「session 级执行约束工具」转为「全生命周期编码流程编排工具」。推翻 PRODUCT.md:53「session 级工具」非目标，按 PRODUCT.md:45「新需求若想推翻某条，须先改本文件 + 加 ADR」执行。

**守住的边界**（不动）：
- 不做 agent harness 集成（仍 bash 调命令 + 读 stdout）
- 不做硬性阻断（gate 熔断只告警不阻断）
- 不做远程服务依赖（纯本地）

### 1.5 已确认的 6 个核心决策（源会话）

| # | 决策 | 影响 |
|---|---|---|
| 1 | 产品定位转向：session 级 → 全生命周期 | PRODUCT.md:53 推翻 + ADR |
| 2 | 每层独立状态机 → 通用引擎 + ScopeConfig | 本文档 §3-§6 论证 |
| 3 | glossary 强制（lock gate 校验术语定义）| L4 spec lock gate |
| 4 | L5 claim 完整实现（lock + TTL + heartbeat）| L5 effort 插件 |
| 5 | 现有 topic 数据不迁移 | 阶段 M2 全新 `.cw/` store |
| 6 | 渐进交付（M1-M5）| 本文档 §6 + engine-design.md §6 |

---

## 2. 整体业务流程

### 2.1 全流水线全景

```
[大工作 / fog 未清]
       │
       ▼
  cw effort create ──────────────────────────────────┐
       │ (chart destination + initial fog)            │
       ▼                                              │
  cw effort ticket × N ─────────────────────────────│  L5 planning phase
       │ (create tickets, wire blocking)              │  (effort 状态机)
       ▼                                              │
  cw effort claim → resolve → graduate ─────────────│
       │                                              │
       │ ┌─(research/prototype type ticket)─┐        │
       │ │ cw research start/resolve         │        │
       │ │ cw prototype start/verdict        │────────│ L2 (无状态)
       │ └───────────────────────────────────┘        │
       ▼                                              │
  cw effort collapse ─────────────────────────────────┘
       │ (fold map into N specs + dep order)
       ▼
  specs/spec-1.md  specs/spec-2.md  ... specs/spec-N.md
       │
       │ (manual handoff — 松耦合)
       ▼
  cw spec draft → review → lock → split ─────────────┐
       │                                              │  L4 planning phase
       │ (lock gate: FR-AC + glossary + no-open)     │  (spec 状态机)
       ▼                                              │  (unlock / re-split /
  topics: topic-1, topic-2, ... topic-N              │   supersede 逆向)
       │                                              │
       │ (cw spec split 产 N 个 topic 骨架)          │
       ▼                                              │
  cw topic create --from-spec ─────────────────────────┘
       │
       ▼
  cw topic plan → tdd_plan → dev → review → test ────┐
       │                                              │  L3 execution phase
       ▼                                              │  (topic 状态机)
  cw topic retrospect → closeout                     │  (wave 状态机嵌套)
       │                                              │
       │ ┌─(遇未解问题)─────────────────┐            │
       │ │ cw research / prototype      │────────────│── L2 (无状态)
       │ └──────────────────────────────┘             │
       │                                              │
       │ (topic.childUnitIds = [wave1, wave2, ...]) │
       ▼                                              │
  每个 wave 独立状态机：                              │
    planned → committed → reviewed → tested ─────────│
       │                                              │
       ▼                                              │
  cw topic closeout (gate: 所有 wave terminal) ──────┘
       │
       │ (任意时机，跨所有层)
       ▼
  cw adr add / cw glossary add ────────────────────── L1 (横向基底)
```

### 2.2 L1-L5 层职责

| 层 | 职责 | 性质 | 跨 session |
|---|---|---|---|
| **L5 effort** | 跨多 feature 大工作的决策收敛。**只规划不执行**（Plan, don't do）| 状态机 | 是（工作量大）|
| **L4 spec** | 单 feature 收敛后的可构建蓝图。可拆成 N 个 topic | 状态机 | 是（spec 写完常跨 session）|
| **L3 topic** | 单 session 可完成 slice 的执行约束。cw 核心价值所在 | 状态机 | 是（多 wave topic 常跨 session）|
| **L3 wave** | topic 的 child unit。独立状态机，递归嵌套 | 状态机 | 通常单 session |
| **L2 problem** | 单待解问题的收敛。用完即弃或 fold 进上层 | **无状态服务** | 单 session |
| **L1 decision** | 横向词汇基底。跨所有层持久。决策真值只在此一处 | **无状态服务** | 跨所有层 |

### 2.3 典型全流程路径（L5 → L4 → L3）

用户场景：「我想重构认证系统，但还没想清楚」

```
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
  cw spec draft spec-session-design --from-effort auth-refactor
  cw spec review spec-session-design
  cw spec lock spec-session-design         # 术语校验 + FR/AC 校验
  cw spec split spec-session-design        # → 产 3 个 topic 骨架

L3 topic (× 3，按拓扑顺序):
  cw topic create --from-spec spec-session-design --pick 1
  cw topic plan                             # 技术设计 + wave 拆分（吸收实现级决策）
  cw topic tdd_plan / dev / review / test / retrospect / closeout
  ... 重复 topic 2、3 ...

L1 沉淀（任意时机，跨所有层）:
  cw adr add --title "OAuth provider abstraction" ...
  cw glossary add --term "session" --definition "..."
```

### 2.4 四步通用流程骨架

每层（L5/L4/L3 topic/L3 wave）共享同一个流程骨架：

```
clarify（澄清）→ review（审查）→ lock（确认）→ split（拆到下一层）
```

逐层映射：

| 阶段 | L5 effort | L4 spec | L3 topic | L3 wave |
|---|---|---|---|---|
| **clarify** | chart ticket（fog of war）| draft（FR/AC）| plan（技术设计）| （无，继承 topic plan）|
| **review** | ticket grilling | spec_review | plan_review + code review | code review |
| **lock** | collapse（真终态）| spec lock（immutable）| dev commit（append-only）| dev commit |
| **split** | → spec（collapse 产出）| → topic（split 产出）| → wave（topic 内拆分）| （叶子，不再 split）|

**共同骨架清晰，差异在每步的具体内容（每层的 ScopeConfig 配置），不在流程结构**。

---

## 3. 挑战、难点与解决思路

源会话中遇到 5 个关键挑战，逐个解决。每个挑战的解决思路直接影响最终架构。

### 3.1 挑战 1：L5/L4/L3 是三个独立状态机，还是统一引擎？

#### 难点

补齐 L1-L5 时，最直觉的设计是「每层一个独立状态机」：
- L5 有自己的 action / status / gate
- L4 有自己的 action / status / gate
- L3 保留 cw 0.x 的 19 action / 12 status

但用户提出挑战：**L3/L4/L5 是不是其实流程相同，只是 scope 不同？**

> 「除了 L1 和 L2，其他 3 层是不是可以统一一套流程，只是 scope 不同？我感觉都是澄清问题、审查、确认问题、拆分问题这样的步骤？」

#### 解决思路：挖掘通用骨架

第一步：摊开三层所有机制按「解决的问题」重新分类，发现 70% 的机制跨层通用。

第二步：逐个挖掘所有「层独有」机制，发现**全部误判**：

| 机制 | 之前误判 | 真实归类 |
|---|---|---|
| fog of war | L5 独有 | 通用（增量识别），L5 是密度高的实例 |
| claim 子系统 | L5 独有 | parallel 模式全局 mutex（跨 session 复杂实例）|
| 并发控制 | 每层不同 | mutex/isolation/sequence 三正交维度 |
| coverage gate | L4/L3 各自 | parents→children 覆盖检查 |
| evidence gate | L3 独有 | 证据锚定（git-commit / content-hash / non-empty）|
| drift 检测 | L3 独有 | 版本快照对比 |
| type dispatch | L5/L3 各自 | 类型分发（TaskShape / ticket type）|
| append-only | L3 wave 特殊 | 4 子类（event-log / versioned / frozen-at / growing-set）|
| TDD | L3 独有 | 预期-实现-验证三段式（强中弱三档）|
| commit-anchor | L3 独有 | 内容寻址证据锚（git-commit 实例）|
| immutability | 散落各层 | 通用策略（frozen-at 带 allowThaw 配置）|
| phase 顺序 | 三层独立 | 四步骨架（clarify/review/lock/split）+ 参数化 |

**12 个机制，0 个层独有**。

#### 解决方案：通用引擎 + ScopeConfig 插件

```
通用引擎（一套代码）:
  UnitStateMachine<S, A, P>

层配置（插件，多个实例）:
  L5_EFFORT_CONFIG: ScopeConfig<L5Status, L5Action, L5Payload>
  L4_SPEC_CONFIG:   ScopeConfig<L4Status, L4Action, L4Payload>
  L3_TOPIC_CONFIG:  ScopeConfig<L3TopicStatus, L3TopicAction, L3TopicPayload>
  L3_WAVE_CONFIG:   ScopeConfig<L3WaveStatus, L3WaveAction, L3WavePayload>
```

**工程量收益**：代码量从「3 套独立状态机」降到「1 套引擎 + 4 个配置」。

详见 §4-§6。

### 3.2 挑战 2：为什么 L5 跨 session 而其他层不要？（错误前提）

#### 难点

plan.md §5.5 写的是「L5 跨 session 长期」，但 §5.3（L3 topic）和 §5.4（L4 spec）都隐含单 session 内推进。这是未经论证的默认假设。

#### 解决思路：跨 session 不是层的属性

**反证**：其他层也会跨 session。
- L4 spec：复杂 feature 的 spec 跨 2-3 个 session 完全正常
- L3 topic：跨多 wave 的 topic 跨多个 session 是常态
- L3 wave：大型 refactor wave 也可能跨 session

**真实情况**：跨 session 是「**工作量大所以跨 session**」的统计现象，不是「L5 定义要求跨 session」的设计约束。

matt 把 claim 绑在 wayfinder（L5）上，是因为 matt 的多 session 并发假设只在 L5 触发（matt 假设 spec/ticket 是单 session 内完成）。cw 没有这个假设——cw 的 L4/L3 同样跨 session。

#### 解决方案：跨 session 是全局开关，不是层属性

```typescript
interface ProjectConfig {
  concurrencyMode: 'serial' | 'parallel'  // 决定 mutex 强度
  // serial: 所有 unit 串行，状态机强制 single-claim
  // parallel: 启用 claim 子系统，支持跨 agent 跨 session 互斥
}
```

- serial 模式（cw 默认）：所有层用状态机 single-claim，零并发开销
- parallel 模式（用户主动启用）：所有层的 mutex 升级为 file-lock + TTL + heartbeat

**claim 子系统是 parallel 模式的全局机制，不是任何层的专属**。ScopeConfig 里**完全没有并发相关字段**，并发是全局开关。

### 3.3 挑战 3：递归嵌套是否干净？

#### 难点

cw 0.x 的 wave 是 `topic.waves[]` 内嵌字段（types.ts:203-215）。1.0 把 wave 提升为独立 Unit 后，topic↔wave 的嵌套关系如果强耦合（wave 状态机直接读 topic 状态），通用性就破了。

#### 解决思路：通过数据指针解耦

wave 提升为独立 Unit，但和 topic 的关系**只通过字符串指针**，不通过对象引用：

```typescript
// wave 的 parentUnitId 指向 topic
wave.parentUnitId = "L3-topic:cw-auth-refactor"

// topic 的 childUnitIds 是 wave 的 id 列表
topic.childUnitIds = ["L3-wave:cw-auth-refactor-w1", "L3-wave:cw-auth-refactor-w2"]
```

topic 要拿 wave 状态，必须通过 `store.findChildren(topicId)` 查询，不直接访问 wave 对象。wave 状态机的 `commit` action 和 topic 的 `dev` action **完全独立**——topic 只通过 lockVersion 读 wave 是否已 commit，不调 wave 状态机内部。

#### 解决方案：原型验证

smoke test 验证通过（见 engine-design.md §4 风险 1）：
- topic 持有的是 wave 的 id（字符串指针），不是 wave 对象
- topic 的 status 不受 wave commit 影响（解耦验证）
- topic closeout gate 校验「所有 child wave 都是 terminal」时，通过 `store.findChildren` 查询

**结论**：递归嵌套干净成立。同一套 UnitStateMachine + 不同 ScopeConfig 即可分别驱动 topic 和 wave。

### 3.4 挑战 4：L4 spec 和 L3 topic 的 clarify 重复

#### 难点

cw 0.x 的 L3 topic 的 clarify 阶段产 SpecSections（FR/AC/UC）。1.0 加了 L4 spec 后，L4 spec 也产 SpecSections（feature 级需求）。两者都产 SpecSections，区别是什么？没说清。

这是「cw 0.x 把两层混在一起」的症状没切干净。

#### 解决思路：按 scope 切分，不是按字段切分

两层 clarify 产的东西 **scope 不同**，不是同一个产物的两份：

| | L4 spec | L3 topic |
|---|---|---|
| **回答什么** | What & Why（产品需求）| How 的歧义（技术实现决策）|
| **内容** | FR / AC / UC / out-of-scope / feature 级 decisions | 技术选型 / 接口契约 / 错误策略 / topic 级 ADR |
| **谁定** | 产品层面（需求方）| 实现层面（工程师）|
| **稳定性** | lock 后 immutable | topic closeout 后归档 |

#### 解决方案：L3 取消独立 clarify 阶段

- L3 取消 clarify 作为独立阶段
- plan 阶段吸收「实现级技术决策 + AC 映射」
- 如果 plan 时发现 spec 有大漏洞（不是实现级，是需求级），走 drift-back（层间上浮 abort + 回 L4）

L3 流程简化为：`create(--from-spec) → plan → plan_review → tdd_plan → dev → review → test → retrospect → closeout`。少了 clarify 和 confirm_clarify 两个 action。

`--from-spec` 模式下 topic 的 SpecSections 是**引用**（指针指向 L4 spec slug），不是本地副本：

```typescript
// 模式 A：引用（--from-spec 路径）
"specSections": {"type": "ref", "spec-slug": "session-design", "snapshot-at": "..."}

// 模式 B：本地（裸 cw topic create 路径，兼容小 slice）
"specSections": {"type": "inline", "sections": [...]}
```

### 3.5 挑战 5：prototype 放 L2 别扭

#### 难点

prototype 产出的是 throwaway branch 上的代码 + verdict。verdict 是问题答案（L2 性质），code 是执行产物（L3 性质）。混在 L2「无状态问题层」自相矛盾——L2 的定义是「不进状态机、用完即弃」，但 prototype 的代码要 commit 到 branch、要保留可追溯，这已经是执行期行为了。

#### 解决方案：prototype 移出 L2

prototype 整体移出 L2，作为 **L3 的特殊 topic 类型**（TaskShape: `prototype-only`，走简化流程：create → dev → closeout，跳过 TDD/review）。

L2 只保留 research（纯文档产出，无代码，真无状态）。L2 定义干净了：**只产出 cited findings，零代码**。

---

## 4. 整体设计和抽象

### 4.1 设计三层抽象

```
┌─────────────────────────────────────────────────────────────────┐
│  通用引擎（UnitStateMachine<S, A, P>）                            │
│  零 topic 假设，零层假设。一套代码驱动任意层。                    │
├─────────────────────────────────────────────────────────────────┤
│  ScopeConfig<S, A, P>（插件配置）                                 │
│  每层一个实例：transitions / phases / gates / freezeRules / ...   │
│  L5_EFFORT_CONFIG / L4_SPEC_CONFIG / L3_TOPIC_CONFIG / ...       │
├─────────────────────────────────────────────────────────────────┤
│  EngineDeps（依赖注入）                                           │
│  store: UnitStore（持久化抽象）                                   │
│  gateRunner: GateRunner（gate 执行抽象）                          │
│  clock: Clock（时间抽象）                                         │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 核心抽象：Unit<S, P>

把 topic / wave / spec / ticket 统一为 Unit 概念。每层 frontmatter 扩展通过 `payload: P` 泛型：

```typescript
interface Unit<S extends string, P> {
  id: string;                    // "{scope}:{slug}"
  scope: ScopeId;                // "L3-topic" | "L3-wave" | "L4-spec" | ...
  slug: string;
  status: S;
  statusHistory: StatusEvent[];  // 通用事件日志（append-only）

  // ── 跨层指针（解耦递归嵌套）──
  parentUnitId?: string;         // wave→topic, topic→spec, spec→effort
  childUnitIds: string[];        // topic→waves, spec→topics, effort→tickets
  derivedFromId?: string;        // 上游 unit（split/collapse 时的源）

  // ── drift 基础设施（跨层逆向影响传播）──
  parentLockVersion?: number;    // 创建时 parent 的 lock 版本（drift 快照）
  driftStatus: "clean" | "drifted" | "acknowledged";
  driftLog: DriftEvent[];

  // ── lock 版本（L4 spec unlock/re-lock 用）──
  lockVersion?: number;

  // ── 类型分发（ticket type / TaskShape / spec type）──
  type?: string;

  // ── 层特定产物 + 通用集合容器 ──
  payload: P;                    // 层特定 frontmatter
  collections: Record<string, unknown[]>;  // 通用 append/replace/freeze 容器
}
```

**关键设计：`collections` 通用容器**。把 cw 0.x 散落在 Topic 上的 `gateHistory` / `waves` / `testCases` / `clarifyRecords` / `reviewIssues` / `testFixLog` 等内嵌数组统一为通用容器。ScopeConfig 声明每层有哪些 collection，写入语义由 CollectionSpec 控制。

### 4.3 核心抽象：ScopeConfig<S, A, P>

一层状态机的完整声明：

```typescript
interface ScopeConfig<S, A, P> {
  scope: string;
  // 状态机配置
  transitions: Record<A, TransitionRule<S>>;
  initStatus: S;
  terminalStatuses: ReadonlySet<S>;
  // 四步阶段配置
  phases: { clarify?: PhaseConfig<A>; review?; lock?; split? };
  // 通用机制配置（按需启用）
  coverageGates?: CoverageGateSpec<P>[];    // 类别 A: FR→AC 覆盖
  evidenceGates?: EvidenceGateSpec<P>[];    // 类别 B: commit-anchor / TDD red
  freezeRules?: FreezeRule<P>[];            // 类别 C: append-only / 版本快照 / 冻结
  fogConfig?: FogConfig<P>;                 // 类别 D: 增量识别
  typeDispatch?: Map<string, SubFlowConfig>; // 类别 E: 类型分发
  driftConfig?: DriftSpec;                  // 跨层 drift 检测
  // loop 控制
  loops?: Record<string, LoopConfig>;
  gateRetryLimit?: number;
  // 产物 collection 声明
  collections: Record<string, CollectionSpec>;
  // action → gate 映射
  actionGates?: Record<A, readonly string[]>;
}
```

**ScopeConfig 是 cw 0.x TaskShape 的扩展**。cw 0.x 的 TaskShape（`shapes/types.ts`）已经把 verification + review 抽出来变成可插拔策略，是 ScopeConfig 的雏形。1.0 把 TaskShape 扩展为完整层配置（含状态机配置 + 通用机制配置）。

### 4.4 核心抽象：EngineDeps（依赖注入）

引擎依赖的外部能力抽成接口，引擎通过 deps 调用，不直接 import 具体实现：

```typescript
interface EngineDeps {
  store: UnitStore;        // 持久化（原型 InMemoryStore / 迁移后 CwStoreAdapter）
  gateRunner: GateRunner;  // gate 执行（DefaultGateRunner）
  clock: Clock;            // 时间（SystemClock，测试可注入）
}

interface UnitStore {
  load(id): Unit | null;
  save(unit): void;
  findChildren(parentUnitId): Unit[];       // 递归嵌套查询
  findByDerivedFrom(upstreamUnitId): Unit[]; // 跨层 drift 查询
}
```

原型用内存 mock 实现，迁移阶段写 CwStoreAdapter 桥接到 cw 0.x 的 CwStore。

### 4.5 设计原则

| 原则 | 含义 |
|---|---|
| **机制通用，配置层特定** | 12 个机制全部在通用引擎实现，层差异只在 ScopeConfig 配置参数 |
| **跨层用指针，不用引用** | parentUnitId / childUnitIds / derivedFromId 都是字符串，避免对象引用耦合 |
| **决策只活在一处** | ADR / glossary 的真值只在 L1，其他层只 gist + 引用（matt 原则机器化）|
| **append 模式优先** | 逆向操作不删旧记录，标 deprecated/superseded，append 进 history[] |
| **gate 失败不阻断** | 延续 PRODUCT.md:49，gate fail 只记 gateHistory + 换熔断文案，不阻止重试 |
| **drift 是持久状态** | 写入时触发标记（不是查询时算），drifted 阻塞 closeout gate |

---

## 5. 骨架引擎细节

### 5.1 文件结构

```
src/engine/
  unit.ts                # Unit<S, P> 通用数据载体（180 行）
  scope-config.ts        # ScopeConfig<S, A, P> 接口契约（291 行）
  gate.ts                # GateSpec + GateRunner（202 行）
  freeze.ts              # FreezeRule + checkFreeze（123 行）
  deps.ts                # EngineDeps + InMemoryStore mock（93 行）
  state-machine.ts       # UnitStateMachine<S, A, P> 通用引擎（363 行）
  configs/
    l3-topic.ts          # L3 topic ScopeConfig（插件实例）
    l3-wave.ts           # L3 wave ScopeConfig（递归嵌套验证）
```

### 5.2 UnitStateMachine：通用引擎

核心算法**直接平移 cw 0.x 的 checkLinear / computeNextStatus / progressive 语义**，但参数化 S/A（不写死 topic 的 status/action）。

#### 5.2.1 dispatch 主流程（5 步）

```typescript
dispatch(unit, action, params, options?): DispatchResult<S, P> {
  // 1. guard（通用 checkLinear，平移 cw 0.x state-machine.ts:343-368）
  const guardResult = this.guard(action, unit.status);
  if (!guardResult.ok) return { error: guardResult };

  // 2. gate runner（按 options.gateSpecs 执行，统一 append gateHistory）
  const gates = options?.gateSpecs ?? [];
  const progressive = options?.progressiveOverride
    ?? this.config.transitions[action]?.progressive ?? false;
  const gateResult = this.deps.gateRunner.run(
    unit, action, progressive, gates, params, this.deps
  );
  // gateHistory append（无论 pass/fail 都留痕）
  const updatedGateHistory = [
    ...(unit.collections.gateHistory ?? []),
    ...gateResult.entries,
  ];

  // gate fail → 不流转 status，不写产物
  if (!gateResult.passed) {
    return {
      error: { ok: false, code: "gate_failed", gateReports: gateResult.results.map(r => r.report) },
      gateEntries: gateResult.entries,
    };
  }

  // 3. freeze check（如果 options.checkFreeze 启用）
  if (options?.checkFreeze) {
    const oldUnit = options.oldUnitForFreeze ?? structuredClone(unit);
    // 先构造 nextUnit 用于 freeze 比对
    const nextUnitForFreeze = this.buildNextUnit(unit, action, params, options, updatedGateHistory);
    const violations = checkFreeze(oldUnit, nextUnitForFreeze, this.config.freezeRules ?? []);
    if (violations.length > 0) {
      return {
        error: { ok: false, code: "freeze_violation", violations },
        gateEntries: gateResult.entries,
      };
    }
  }

  // 4. computeNextStatus（平移 cw 0.x state-machine.ts:397-403）
  const nextStatus = this.computeNextStatus(action, unit.status);

  // 5. applyProducts + 构造 nextUnit
  const nextUnit = this.buildNextUnit(unit, action, params, options, updatedGateHistory);
  nextUnit.status = nextStatus;
  nextUnit.statusHistory = [
    ...unit.statusHistory,
    { at: this.deps.clock.now(), action: action as string, from: unit.status, to: nextStatus },
  ];
  if (options?.productApplicator) options.productApplicator(nextUnit, action, params);

  this.deps.store.save(nextUnit);
  return { unit: nextUnit, status: nextStatus, gateEntries: gateResult.entries };
}
```

#### 5.2.2 guard（平移 cw 0.x checkLinear）

```typescript
guard(action: A, current: S | undefined): GuardVerdict {
  const rule = this.config.transitions[action];
  if (!rule) return { ok: false, code: "illegal_transition", reason: `unknown action` };
  // create-like action（expectedStatuses 为空）允许 current=undefined
  if (rule.expectedStatuses.length === 0) return { ok: true };
  if (current === undefined) {
    return { ok: false, code: "illegal_transition", reason: `${action} requires existing unit` };
  }
  if (!rule.expectedStatuses.includes(current)) {
    return { ok: false, code: "illegal_transition",
      reason: `${action} expects status ∈ {${rule.expectedStatuses.join(", ")}}, got ${current}` };
  }
  return { ok: true };
}
```

#### 5.2.3 computeNextStatus（平移 cw 0.x progressive 语义）

```typescript
computeNextStatus(action: A, current: S): S {
  const rule = this.config.transitions[action];
  // progressive：若 action 是 progressive 且 current 已是 nextStatus，则原地停留
  if (rule.progressive && current === rule.nextStatus) return current;
  return rule.nextStatus;
}
```

### 5.3 GateSpec + GateRunner：cw 0.x 砍掉抽象的重建

cw 0.x 主动砍掉了 GateRegistry/GateRunner（gate.ts:5-8 注释），改为 handler 直接 import 具名函数。这导致 gate↔action 映射散落在各 handler，gate 名是字符串字面量，gateHistory append 分散。

1.0 以新形式重建抽象：

```typescript
interface GateSpec<P> {
  id: string;                              // "plan-schema" / "tdd-red-light" / "fr-ac-coverage"
  kind: "coverage" | "evidence" | "existence" | "schema";
  check: (unit, input, deps) => GateResult; // 纯函数，无副作用
}

interface GateRunner {
  run<S, P>(unit, action, progressive, gates, input, deps): {
    passed: boolean;
    results: GateResult[];
    entries: GateHistoryEntry[];   // 统一构造的 gateHistory 条目
  };
}
```

**DefaultGateRunner 的短路语义**：任一 gate fail 立即返回，不执行后续 gate（与 cw 0.x 行为一致）。无论 pass/fail 都构造 gateHistory 条目（已发生的执行是事实，必须留痕）。

### 5.4 FreezeRule + checkFreeze：替代 validateAppendOnly

cw 0.x 的 `validateAppendOnly`（actions.ts:2533-2656）硬编码 5 种违规类型：
- wave_deleted_committed / wave_modified_committed
- case_deleted_passed / case_modified_passed / case_expected_tampered_failed

1.0 抽象为 FreezeRule 声明表：

```typescript
interface FreezeRule<P> {
  id: string;                              // "wave-committed" / "test-case-passed"
  collection: string;                      // 受保护的 collection 名
  predicate: (item, unit) => boolean;      // 元素是否受保护
  immutableFields: readonly string[];      // 受保护后不可改的字段
  violationType: string;                   // 违规类型标识
}

function checkFreeze<P>(oldUnit, newUnit, rules): FreezeViolation[];
// 遍历每条规则：
//   1. 在 oldUnit 找受保护元素（predicate 返回 true）
//   2. 在 newUnit 按 id 匹配
//   3. 找不到 → "deleted" 违规
//   4. 找到但 immutableFields 变化 → "modified" 违规
```

**配置即声明，零 if-else**。smoke test 验证 3 种违规类型都正确触发。

### 5.5 通用机制配置项对照

通用引擎的 6 类通用机制，对应 ScopeConfig 的 6 个配置字段：

| 机制类 | ScopeConfig 字段 | cw 0.x 对应 |
|---|---|---|
| 覆盖性 gate | `coverageGates` | `checkFrCoverage` / `checkAcMapping`（warning 版）|
| 证据锚定 gate | `evidenceGates` | `GitValidator.validate` / `redLightCheck` / `testCheck` |
| 不可篡改 | `freezeRules` | `validateAppendOnly` + `VerificationStrategy.replanGuard` |
| 渐进清晰 | `fogConfig` | matt 的 fog of war（cw 0.x 无）|
| 类型分发 | `typeDispatch` | `TaskShape` + matt ticket type |
| drift 检测 | `driftConfig` | cw 0.x 无（1.0 新增）|

**并发控制（claim）不在 ScopeConfig**，在全局 `ProjectConfig.concurrencyMode`（见 §3.2）。

### 5.6 原型验证证据

11 个 smoke test 全部通过（460ms），回答 4 个核心风险：

| 风险 | 验证测试 | 结论 |
|---|---|---|
| 递归嵌套干净？ | "递归嵌套干净" 2 个测试 | ✓ topic↔wave 通过字符串指针解耦 |
| 通用引擎吃下 L3？ | "L3 topic 主链走通" 3 个测试 | ✓ 8 status + 10 action 全配置化 |
| freeze 抽象成立？ | "freeze 抽象" 3 个测试 | ✓ FreezeRule 替代 validateAppendOnly |
| progressive 保留？ | "progressive 语义" 1 个测试 | ✓ dev 重入不回退 status |

加分：gate 失败短路 + 状态不流转（2 个测试）。

---

## 6. 每层插件细节设计

每层是一个 ScopeConfig 实例。本节列每层的关键配置差异（完整配置见 `src/engine/configs/` 和 plan.md §5）。

### 6.1 L5 effort 插件（design only，未实现）

**职责**：跨多 feature 大工作的决策收敛。只规划不执行。

**关键配置**：

| 配置项 | 值 | 说明 |
|---|---|---|
| transitions | 4 status × 8 action | charting → resolving → ready-to-collapse → collapsed/abandoned |
| phases.clarify | per-child + loop | chart ticket（fog of war）|
| phases.lock | per-child + loop | 一张张 resolve ticket |
| phases.split | once | collapse → 1-N 个 spec draft |
| fogConfig | 强 | Not-yet-specified + graduate trigger（增量识别机制，L5 密度高）|
| typeDispatch | 4 ticket type | research / prototype / grilling / task |
| 并发 | claim 子系统 | parallel 模式启用：lock + TTL + heartbeat + stale 清理 |

**L5 特殊点**：collapsed 是真终态，不可 reopen（照搬 matt：collapsed 后发现新 fog = destination redraw = 新 effort）。

### 6.2 L4 spec 插件（design only，未实现）

**职责**：单 feature 收敛后的可构建蓝图。可拆成 N 个 topic。

**关键配置**：

| 配置项 | 值 | 说明 |
|---|---|---|
| transitions | 5 status × 8 action | drafting → reviewing → locked → split → archived（+ 3 个逆向 action：unlock / re-split / supersede）|
| phases.clarify | unit + once | draft（FR/AC）|
| phases.lock | unit + once | spec lock immutable |
| phases.split | once | split → N 个 topic 骨架 |
| coverageGates（lock gate 三件套）| 硬阻断 | ① FR 全覆盖 AC ② glossary 术语全定义（强制）③ 无 open review issue |
| freezeRules | spec-locked | lock 后所有字段冻结，**allowThaw: true**（unlock）|
| collections | append + versioned | specSections / lockHistory / splitHistory / statusHistory |

**L4 特殊点**：unlock 后 re-lock 必须重过所有 gate（机器证据完整性底线，不能 unlock 改一行就 lock 回去绕过 gate）。

### 6.3 L3 topic 插件（**已落地**，原型验证通过）

**职责**：单 session 可完成 slice 的执行约束。cw 核心价值所在。

**关键配置**（见 `src/engine/configs/l3-topic.ts`）：

| 配置项 | 值 | 说明 |
|---|---|---|
| transitions | 8 status × 10 action（原型，完整迁移是 12×19）| created → planned → pre_dev_verified → developed → reviewed → post_dev_verified → retrospected → closed/aborted（+ replan / abort）|
| phases.clarify | unit + once | plan（吸收实现级决策，取消独立 clarify 阶段，见 §3.4）|
| phases.lock | per-child + loop | dev（per wave commit）|
| phases.split | undefined | topic 不 split（wave 是独立 Unit）|
| freezeRules | 2 条 | wave-committed（committed 不可删/改 committed/changes/dependsOn）+ test-case-passed（passed.expected 不可改）|
| evidenceGates | 3 类 | commit-anchor（git commit hash）+ tdd-red-light + judge-expected（机器重算）|
| loops | review: 3 / test: 5 | fix loop 边界 |
| gateRetryLimit | 5 | 连续 fail 5 次换熔断文案不阻断 |
| typeDispatch | 3 taskShape | full-tdd / delete-only / doc-only |
| driftConfig | 监听 L4 spec | unlock / supersede 触发 topic drifted |

**collections 声明**（替代 cw 0.x 散落在 Topic 上的 10+ 个内嵌数组）：

| collection | writeMode | 说明 |
|---|---|---|
| gateHistory | append | gate 执行日志（cw 0.x 直接平移）|
| waves | append + protected | wave 集合，committed 后不可删改 |
| testCases | replace + versioned | replan 时 replace 旧 version 归档 |
| clarifyRecords | append | 澄清记录 |
| specSections | append | spec 章节记录 |
| reviewIssues | append | review issue 累积 |
| testFixLog | append | test_fix 审计日志 |
| adrs | append | ADR 引用 |
| evidence | freeze @ closeout | closeout 后不可改 |
| assessments | append | post-closeout 评估 |

### 6.4 L3 wave 插件（**已落地**，验证递归嵌套）

**职责**：topic 的 child unit。独立状态机，递归嵌套验证通过。

**关键配置**（见 `src/engine/configs/l3-wave.ts`）：

| 配置项 | 值 | 说明 |
|---|---|---|
| transitions | 5 status × 5 action | planned → committed → reviewed → tested/aborted |
| phases.clarify | undefined | 继承 topic plan 的设计 |
| phases.lock | unit + once | commit（锚 commitHash）|
| phases.split | undefined | wave 是叶子，不再 split |
| freezeRules | wave-committed | commitHash / changes / dependsOn 不可改 |
| evidenceGates | commit-anchor | wave 级 commit hash |

**关键设计**（smoke test 验证通过）：
- `parentUnitId` 指向 topic
- topic 的 `childUnitIds` 含 wave id
- topic 不直接调 wave 状态机，只通过 `store.findChildren` 查询
- topic closeout gate 校验所有 child wave 都是 terminal

**同一个 UnitStateMachine 类，不同 ScopeConfig 实例驱动**——这是递归嵌套的本质。

### 6.5 L2 problem（无状态服务，不走状态机）

**职责**：单待解问题的收敛。用完即弃或 fold 进上层。

**关键设计**（plan.md §5.2）：

| 子服务 | gates | 逆向 |
|---|---|---|
| research | sources-count > 0（每条 claim 必引 primary source）| invalidate（标 superseded，文件不删，触发下游 research-stale）|
| prototype | verdict 明确（adopt/reject/needs-more）| re-verdict（新 verdict append verdict.history，可翻案）|

**注意**：prototype 整体移出 L2 作为 L3 的特殊 topic 类型（TaskShape: prototype-only）。L2 只保留 research（纯文档产出，无代码，真无状态）。见 §3.5。

### 6.6 L1 decision（横向词汇基底，无状态服务）

**职责**：跨所有层持久的决策记录 + 领域词汇。被 L2-L5 所有层读取。**决策真值只在此一处**。

**关键设计**（plan.md §5.1）：

| 子服务 | 内容 | 逆向 |
|---|---|---|
| ADR | 架构决策记录（decisions/adr/NNNN-*.md）| supersede（old → deprecated + supersededBy 指向新 ADR，内容永不删）|
| glossary | 强制术语表（lock gate 校验）| revise（旧定义 → history[]，新定义覆盖 current）|

**关键**：glossary 强制（决策 3）——L4 spec lock gate 校验「spec 里用的所有 term 都在 glossary 有定义」。消除「同一个词不同人不同理解」的根本歧义。

### 6.7 插件包对比表

完整对比每层 ScopeConfig 的配置差异（见 architecture.html Tab 2 底部「12 机制通用论证表」）：

| 机制 | L5 effort | L4 spec | L3 topic | L3 wave |
|---|---|---|---|---|
| fog of war | 强（Not-yet-specified）| 中（openFRs）| 弱（replan 加 wave）| 无 |
| claim/mutex | 跨 session（file-lock）| session 内 | session 内 | session 内 |
| coverage gate | collapse-ready | FR→AC（硬阻断）| AC→testCase | 无 |
| evidence gate | resolution 非空 | content-hash | commit-hash + TDD red | commit-hash |
| freeze | collapsed 真终态 | spec-locked（allowThaw）| wave-committed | wave-committed |
| drift | 监听 effort reopen | 监听 ADR supersede | 监听 spec unlock | 监听 topic replan |
| typeDispatch | 4 ticket type | spec type | 3 taskShape | 无 |
| append-only | ticketHistory / fog | lockHistory / splitHist | waves / testCases | commits |
| TDD（3 段式）| 弱（non-empty）| 中（coverage 跨层）| 强（machine-recompute）| 中（diff-tree）|
| commit-anchor | 无 | content-hash | git-commit | git-commit |
| phase 顺序 | per-child + loop | unit + once | unit + loop | unit + once |
| loops | grilling loop | review loop | review×3 / test×5 | review×2 |

**所有差异都是配置参数，不是机制差异**。一套通用引擎驱动所有层。

---

## 附录 A：与 cw 0.x 的代码对照

| cw 0.x | cw 1.0 | 平移方式 |
|---|---|---|
| `TRANSITIONS`（state-machine.ts:217-330）| `ScopeConfig.transitions` | 配置平移 |
| `checkLinear`（state-machine.ts:343-368）| `UnitStateMachine.guard()` | 算法平移，参数化 S/A |
| `computeNextStatus`（state-machine.ts:397-403）| `UnitStateMachine.computeNextStatus()` | 算法平移 |
| `TaskShape` 注册表（shapes/registry.ts）| `ScopeConfig` 实例 | 模式扩展 |
| `VerificationStrategy` / `ReviewStagePolicy` | `ScopeConfig` 子集 | 接口整合 |
| `validateAppendOnly`（actions.ts:2533）| `FreezeRule` + `checkFreeze` | 硬编码 → 声明表 |
| `gateAdvance`（actions.ts:636）| `GateRunner.run` | 雏形扩展 |
| gateHistory append（散落 handler）| `GateRunner.run` 统一 append | 集中化 |
| `store.transaction`（store.ts:453）| 迁移阶段接入 `CwStoreAdapter` | 直接复用 |
| `*_TURN_LIMIT`（state-machine.ts:40-50）| `ScopeConfig.loops` | 配置平移 |
| `Topic.waves[]` 内嵌字段 | `Unit.collections.waves` + 独立 wave Unit | 结构升级（递归嵌套）|

## 附录 B：迁移路径（5 阶段，另开 topic）

原型验证通过，后续迁移工作分 5 个阶段：

| 阶段 | 范围 | 工程量 |
|---|---|---|
| **M1** | 接入真实 store + gate（CwStoreAdapter + 迁移 gate.ts 具名函数为 GateSpec）| 中 |
| **M2** | 完整迁移 L3 topic（12 status + 19 action 完整配置化 + 迁移 393 测试基线）| 大 |
| **M3** | 实现 L4 spec ScopeConfig（draft/review/lock/split/archive + unlock/re-split/supersede）| 大 |
| **M4** | 实现 L5 effort ScopeConfig（ticket 流转 + fog + claim 子系统）| 大（claim 复杂度高）|
| **M5** | 跨层 drift + 影响传播（5 条跨层逆向路径 + drift 状态机）| 中 |

每个阶段是独立 topic，按 plan.md §10 渐进交付。

## 附录 C：关键文件索引

| 内容 | 路径 |
|---|---|
| 本设计文档 | `.xyz-harness/cw-1-0-lifecycle-redesign/design.md` |
| 产品级 plan | `.xyz-harness/cw-1-0-lifecycle-redesign/plan.md` |
| 引擎级 engine-design | `docs/engine-design.md` |
| 流程图（6 page）| `.xyz-harness/cw-1-0-lifecycle-redesign/lifecycle-flow.html` |
| 架构图（2 page）| `.xyz-harness/cw-1-0-lifecycle-redesign/architecture.html` |
| 通用引擎源码 | `src/engine/` |
| L3 topic 配置 | `src/engine/configs/l3-topic.ts` |
| L3 wave 配置 | `src/engine/configs/l3-wave.ts` |
| smoke test（11 测试）| `tests/engine-smoke.test.ts` |
| cw 0.x 现有实现（迁移参考）| `src/state-machine.ts` / `src/actions.ts` / `src/shapes/` / `src/store.ts` |

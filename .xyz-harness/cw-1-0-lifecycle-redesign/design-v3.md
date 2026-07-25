# cw 1.0 全生命周期重设计：领域建模设计文档（v3 · 真统一版）

> **状态**：领域建模定稿 · 真统一状态机
> **源会话**：2026-07-19 ~ 2026-07-20
> **文档定位**：1.0 重设计的领域真值来源。基于 mattpocock wayfinder 原典深读 + cw 0.x 真实代码分析 + 真统一状态机重设计。**所有 WorkUnit scope 共享同一套 status / action 命名**，差异只在 ScopeConfig 配置。
> **取代文档**：
> - design-v2.md（前一版，每个 scope 用不同流程名 + slice 继承 cw 0.x 的 19 action/12 status——已被本文档的"真统一"取代）
> - design.md（v1，matt 命名直译，最早被 v2 取代）
> **源代码**：`src/engine/`（通用引擎原型）；cw 0.x 的 `src/`（迁移参考，但不原样继承）

---

## 0. 文档定位与阅读顺序

本文档是 cw 1.0 的领域真值来源。与 v2 的核心差异：

| 维度 | design-v2 | design-v3（本文档）|
|---|---|---|
| 状态机 | 每 scope 不同流程名（charting/draft/plan/refine）+ slice 继承 cw 0.x 19 action/12 status | **真统一**：所有 scope 共享 6 status / 6 action，差异只在配置 |
| 与 cw 0.x 关系 | slice 原样继承（降迁移风险）| **不继承，重设计**（新命令集，与 cw 0.x 不冲突）|
| 架构图 | 四步骨架矩阵每行不同 | 每行真正同构，只是单元格配置不同 |

**建议阅读顺序**：§4（真统一核心）→ §3（整体架构）→ §5（领域建模）→ §6-7（流程）→ §8（命令）。

**代码落地状态（重要）**：本文档描述的是 v3 **目标设计**。`src/engine/` 当前是 v2 风格原型（scope 用 L1-L5 命名（v2 原型的旧 scope 名，对应 epic/feature/slice/wave 的前身）、phases 用 clarify/review/lock、drift 用三态字段），v3 命名（epic/feature/slice/wave、plan/execute/verify、drift 事件流）**尚未落地到代码**。对照代码时请注意这个错位——文档是目标，代码是 v2 历史。

---

## 术语速查

> 本文档的核心术语集中定义。首次出现时可回查此处。

### 状态机术语

| 术语 | 定义 |
|---|---|
| **WorkUnit** | 工作单元，cw 1.0 的中心抽象。有完整生命周期，由 UnitStateMachine 驱动。4 个 scope：epic/feature/slice/wave |
| **scope** | WorkUnit 的粒度类型。epic（最大）> feature > slice > wave（最小）|
| **status** | WorkUnit 当前状态。统一 6 个：created/planning/executing/verified/closed/aborted |
| **action** | 触发 status 流转的操作。统一 6 核心：create/plan/execute/verify/split/close（+abort）|
| **progressive** | action 属性。progressive action 可在**相同 status 下多次调用，每次原地停留**（status 不前进），用于渐进式提交。与一次性 action 对立 |
| **plan / execute / verify** | 统一 3 阶段：plan=规划（澄清+设计；wave plan 含写测试代码）/ execute=执行（写实现代码，仅 wave）/ verify=验证（review+test；slice 只 plan_review）|

### scope 的 plan 内容名（plan action 的 scope 特化）

| 术语 | scope | 含义 |
|---|---|---|
| **charting** | epic | epic 的 plan：画决策项 + 识别 fog（不清晰的问题）|
| **draft** | feature | feature 的 plan：写 SpecSection（FR/AC/UC）|
| **refine** | wave | wave 的 plan：细化方案到可开发 + 写 TDD 测试代码 |

注：slice 的 plan 没有专有名，就是「技术设计 + 拆 wave 方案」。

### SpecSection（feature plan 的产物）

feature plan（draft）产出的需求规格，包含三种 section：
- **FR**（Functional Requirement，功能需求）：「系统应该能 X」
- **AC**（Acceptance Criteria，验收标准）：「X 做到了的标准」
- **UC**（Use Case，用例）：具体使用场景

### matt 原典术语（已映射到 1.0 概念）

| matt 原词 | 1.0 命名 | 含义 |
|---|---|---|
| **destination**（目标）| payload.destination | WorkUnit 完成时世界长什么样 |
| **fog**（迷雾）| epic 的「待澄清项」| 感知到但还说不清的将来问题。epic charting 时识别，随决策推进「显化」成决策项 |
| **frontier**（前沿）| 查询结果 | 当前可拿的决策项集合 = open ∧ unblocked ∧ unclaimed |
| **显化 / graduate** | epic 内部动作 | fog → 决策项的转化（前一张决策项的答案让某个 fog 变锋利，切成新决策项）|
| **collapse** | **已废弃，统一用 split** | matt 原典 epic 专属动作。1.0 统一为 epic.split（机制相同：产子+归档）|

### 机器验证术语

| 术语 | 定义 |
|---|---|
| **judgeByExpected** | cw 0.x 的纯函数测试判定。verify 阶段，引擎**忽略 agent 声称的 pass/fail**，用 test case 的 expected 字段（纯函数/正则/JSON schema）重新判定 actual，得到机器可信结果。是 cw 「不信任 agent 声明」的核心实现 |
| **TDD 红灯校验** | wave plan gate：测试代码写好后必须跑起来是 fail（红灯），证明测试有效。写实现后才转绿 |
| **gate** | 机器检查门。action 流转前跑，fail 时不流转 status |
| **FreezeRule** | append-only 校验规则。immutableFields 白名单：只锁列出的字段，其他字段可改 |

### 并发术语

| 术语 | 定义 |
|---|---|
| **claim / claimedBy** | 认领机制（并发互斥）。多个 agent 并行工作时，claimedBy 字段记录「谁占有了这个 WorkUnit 的处理权」，防止两个 agent 撞车。**仅 parallel 模式启用**（serial 模式不用）|
| **parallel / serial 模式** | ScopeConfig.concurrentMode 配置。serial=单 agent 串行（默认）；parallel=多 agent 并行，启用 claim 子系统 |
| **认领方 / claimer** | 持有 claim 的 agent 身份。锚定 worktree（.cw/session.json），跨进程复用 |

### 决策项术语

| 术语 | 定义 |
|---|---|
| **决策项 / DecisionItem** | WorkUnit plan 阶段产生的「问题+答案」记录。**不是 WorkUnit**，挂在 WorkUnit 的 collection 里 |
| **HITL** | Human-In-The-Loop，需要真人在场。grilling 类型决策项必须 HITL（agent 不能替人表态）|
| **AFK** | Away-From-Keyboard，agent 可独自完成（不需人）。research 类型决策项 AFK |
| **临时 wave / throwaway** | prototype/task 决策项触发的 wave，用于验证决策（prototype）或执行前置体力活（task）。走 wave 完整流程，但完成后标 validity=deprecated，**不进交付链**。与 slice split 产的「正常 wave」区别只在来源与归宿 |

### drift 术语

| 术语 | 定义 |
|---|---|
| **drift**（漂移）| 上游 WorkUnit 变化时，下游基于旧版本，需要标记和处理这种「漂移」。如 feature unlock 后，基于旧 spec 的 slice 被 drift |
| **driftLog** | WorkUnit 的顶级字段（append-only），记录每次上游变化事件。driftStatus 是 derived（有 open 事件=drifted）|
| **acknowledge-drift** | drift 处理 action：agent 决定不跟随上游（事件标 acknowledged），必须填 reason |
| **rebase-on-upstream** | drift 处理 action：agent 跟随上游变化（事件标 rebased），受 freeze 保护 |

---

## 1. 背景

### 1.1 cw 0.x：执行期机器约束的局限

cw 0.x（版本 0.0.1）是 **Agent-agnostic 编码流程编排 CLI**。核心赌注：**不信任 agent 声明，只信机器验证的证据**（commit 存在性 / TDD 红灯 / judgeByExpected 纯函数重算）。

cw 0.x 的实际规模：19 action / 12 status。但这些是 FR-1 ~ FR-5 演进堆出来的（clarify_confirmed / spec_reviewed / plan_reviewed / pre_dev_verified / post_dev_verified …），**很多是 review 后的中间态，不是独立的业务阶段**。状态机不够抽象，是历史包袱。

**局限**：只管单 topic 生命周期。管不了「工作量超过单 session + 路径未清」的大工作。

### 1.2 mattpocock wayfinder：规划期不确定性收敛

matt 的 wayfinder 方法论解决另一类问题：**AI agent 工作记忆有上限，但真实项目远超上限，且路径开始时不可见——直接冲向终点必然崩盘**。

核心动作不是「执行得更准」，而是**先把「要决策什么」铺成可逐个解决、状态可共享的结构**。提出 11 条领域不变量（详见 §11）：目标锚定 / 索引 vs 存储分离 / 决策单元 / 依赖 DAG + 动态浮现 / 可执行边沿 / 显式不确定性 / 显式 scope 边界 / HITL 边界 / 并发互斥 / 上下文边界 / 移交而非执行。

**局限**：纯方法论，靠 prompt 约束，没有机器验证。

matt 自己的证据：CHANGELOG PR #464 记录 `decision-mapping → wayfinder` 重命名，承认原命名「jargon、不准确」。所有词（map/ticket/fog/frontier）都是 RTS 寻路隐喻的可替换标签，**领域不变量不变，命名可换**。

### 1.3 1.0 命题：统一两个问题域 + 真统一状态机

cw 0.x（执行约束）和 wayfinder（决策收敛）是流水线上下游。1.0 命题：**一个工作从「模糊想法」到「机器验证过的代码」，既要收敛不确定性，又要约束执行**。

**v3 的额外命题（真统一）**：v2 把 cw 0.x 的 19 action / 12 status 原样继承到 slice，导致 4 个 scope 的状态机规模悬殊（epic 3 status / slice 12 status），"统一引擎"名不副实。v3 **不继承 cw 0.x，重新设计统一状态机**：所有 scope 共享 6 status / 6 action，差异只在配置。cw 0.x 的命令（`cw create/clarify/plan/dev/...`）保留运行，1.0 用新命令集（`cw <scope> <action>`），两者不冲突。

**守住边界**：不做 agent harness / 不做硬阻断 / 不做远程服务 / 不信任 agent 声明。

---

## 2. 目标

### 2.1 核心目标

1. **全生命周期覆盖**：大工作（epic）到代码交付（wave commit）
2. **真统一抽象**：一个引擎 + 一套 status/action 命名，4 个 scope 共享，差异只在 ScopeConfig
3. **领域不变量机器化**：matt 11 条 + cw 核心，从 prompt 约束升级为状态机/gate 约束
4. **append-only 历史**：逆向不删旧，标 deprecated/superseded
5. **机器证据优先**：所有声明都要机器验证

### 2.2 非目标

- 不做 agent harness 集成（agent 只需 bash 调 cw + 读 stdout JSON）
- 不做 IDE 插件
- 不做质量阈值硬阻断（gate 熔断只告警）
- 不做远程服务依赖（纯本地）
- 不做代码仓库管理（只读 git 做 commit 校验）
- **不兼容 cw 0.x 命令**（新命令集，cw 0.x 作为独立工具继续可用）

---

## 3. 整体架构

### 3.1 三类核心抽象

| 类别 | 成员 | 物理实现 | 引擎处理 |
|---|---|---|---|
| **WorkUnit**（工作单元）| epic / feature / slice / wave | 独立 Unit（id/状态机/payload）| `UnitStateMachine<S,A,P>` × 4 个 ScopeConfig |
| **决策项**（决策记录）| 任何 WorkUnit plan 阶段的产物 | WorkUnit 的 collection 元素 | 引擎不直接管，由 plan handler 维护 |
| **横向服务**（无状态）| research / glossary / ADR | 独立 service | EngineDeps 注入，被 gate/handler 调用 |

**关键区分**：
- WorkUnit 有完整生命周期 + 独立身份 + 向下精化
- 决策项是「问题+答案」记录，**不是 WorkUnit**
- 服务无生命周期，被调用

### 3.2 统一引擎：UnitStateMachine<S, A, P>

```typescript
interface WorkUnit<S extends string, P> {
  id: string;                    // "{scope}:{slug}"
  scope: "epic" | "feature" | "slice" | "wave";
  slug: string;
  status: S;                     // 统一 6 status 之一
  statusHistory: StatusEvent[];  // append-only
  parentUnitId?: string;
  childUnitIds: string[];
  driftLog: DriftEvent[];        // append-only，drift 事件流
  parentLockVersion?: number;
  lockVersion?: number;
  claimedBy?: string;            // claim 通用机制
  validity?: "active" | "deprecated";  // 仅 wave 用（其他 scope 恒 active）；临时 wave 完成后标 deprecated
  supersededBy?: string;              // 弃用/取代时的替代 WorkUnit id（wave deprecate / feature supersede 时填）
  deprecatedReason?: string;          // 弃用原因
  payload: P;
  collections: Record<string, unknown[]>;
}

interface ScopeConfig<S, A, P> {
  scope: string;
  transitions: Record<A, TransitionRule<S>>;   // 统一 6 action，scope 声明启用哪些
  phases: { plan?; execute?; verify?; split? }; // scope 声明启用哪些阶段
  planGate?; verifyGate?; closeGate?;
  freezeRules?; driftConfig?; loops?;
  concurrentMode: "serial" | "parallel";
  collections: Record<string, CollectionSpec>;
}

interface EngineDeps {
  store: UnitStore;
  gateRunner: GateRunner;
  clock: Clock;
  sessionStore: SessionStore;    // claimer 身份（parallel 模式）
  glossaryStore: GlossaryStore;  // 术语查询（feature lock gate）
}
```

---

## 4. 核心设计：真统一状态机

> 这是 v3 的核心。所有 WorkUnit scope 共享同一套 status / action，差异只在 ScopeConfig。

### 4.1 统一 status（6 个）

```
created     刚创建，未开始
planning    规划中（澄清 + 设计 + 写测试代码）
executing   执行中（写实现代码）—— **仅 wave 走**（wave 是唯一执行型；epic/feature/slice 不直接写代码，slice 把执行委托给派生 wave）
verified    已验证（review + test 通过）
closed      已关闭（归档）
aborted     已终止
```

**所有 scope 共享这 6 个 status**。流转结构：

```
created ──plan──> planning ──execute──> executing ──verify──> verified ──close──> closed
                     │                                                    ↑
                     └─────────verify────────────────────────────────────┘
                              （epic/feature/slice 跳过 executing，直接 planning→verified）
                              （verified 内可 split 产子，不改 status；close 才进 closed）

任何非终态 ──abort──> aborted
```

### 4.2 统一 action（6 核心 + abort + 通用）

| action | 类型 | 语义 | 适用 scope |
|---|---|---|---|
| `create` | 入口 | 创建 WorkUnit，注入初始状态 | 全部 |
| `plan` | progressive | 规划：澄清 + 设计 + 写测试代码 | 全部 |
| `execute` | progressive | 执行：写实现代码 | **仅 wave**（wave 是唯一执行型）|
| `verify` | progressive | 验证：review + test（slice 退化为 plan_review，不跑 test）| 全部 |
| `split` | 一次性 | 拆分：产子 WorkUnit | epic / feature / slice |
| `close` | 一次性 | 关闭：归档 | 全部 |
| `abort` | 旁路 | 终止 | 全部 |

**通用 action（不在主状态机，走子机制）**：
- `acknowledge-drift` / `rebase-on-upstream`：drift 子状态机（见 §7）
- `claim` / `release`：claim 通用机制（parallel 模式）

### 4.3 scope 配置矩阵（差异全在这里）

| 配置维度 | epic | feature | slice | wave |
|---|---|---|---|---|
| **启用 execute** | ✗ | ✗ | ✗（协调型）| ✓（唯一执行型）|
| **启用 split** | ✓（→ feature）| ✓（→ slice）| ✓（→ wave）| ✗（叶子）|
| **plan 内容** | charting：画决策项 + fog | draft：写 FR/AC/UC | 技术设计 + 拆 wave 方案 | refine：细化方案 + 写 TDD 测试代码 |
| **plan gate** | 决策项结构校验 | SpecSection schema | plan schema + wave 拆分完整性 | refine + **TDD 红灯校验** |
| **verify gate** | 决策项 resolution 完整（grilling）| **三件套**：FR-AC 覆盖 + glossary + no-open（详见 §D.8）| plan_review 通过（技术方案审查）| test 全 pass（judgeByExpected 重算）|
| **close gate** | 全决策项 resolved + fog 空（不等 feature）| 派生 slice 全 closed | 派生 wave 全 verified + **无 drift** | commit 存在 |
| **freezeRules** | closed 真终态（不可 reopen）| spec-locked（allowThaw）| plan-locked（plan_review 后技术方案不可改）+ wave-list-frozen（split 后 wave 引用列表不可改）| wave-committed（commitHash/changes/dependsOn 不可改）+ test-case-passed（已 pass 的 testCase.expected 不可改）|
| **loops**（verify）| grilling ×3 | spec_review ×3 | plan_review ×3 | review ×3 / test×5 |

### 4.4 cw 0.x 细分 → 统一 action 的映射

cw 0.x 的 19 action 如何收敛到统一 6 action：

| cw 0.x action | 统一 action | 说明 |
|---|---|---|
| `create` | `create` | 直接映射 |
| `clarify` / `confirm_clarify` / `plan` / `tdd_plan` | **`plan`** | 规划期全包：澄清需求 + 技术设计 + 写测试代码（TDD 红灯校验在 plan gate）|
| `dev` | **`execute`** | 写实现代码 |
| `spec_review` / `spec_review_fix` / `plan_review` / `plan_review_fix` / `review` / `review_fix` / `test` / `test_fix` | **`verify`** | 验证期全包：code review + 跑测试。fix loop 用 verify 的 progressive 重入表达 |
| `retrospect` / `closeout` | **`close`** | 复盘 + 归档 |
| `replan` | `plan`（从 verified 回退到 planning）+ freeze 保护 | plan 的 nextStatus 是 planning；从 verified 调 plan 会回退（progressive 只在 current===nextStatus 时原地停留，verified≠planning 所以回退）|
| `abort` | `abort` | 直接映射 |
| `assess` | `close` 后的 progressive（不进主状态机）| post-close 评估 |

**关键简化**：
- cw 0.x 的 12 status（clarify_confirmed / spec_reviewed / plan_reviewed / pre_dev_verified / post_dev_verified …）→ **统一 6 status**。中间态用 gate 表达（plan gate / verify gate），不用独立 status。
- cw 0.x 的 review_fix loop / test_fix loop → **verify 的 progressive 重入**（多次 verify 调用，每次修一些 issue）。

### 4.5 状态流转图（真统一）

```
                    plan (progressive)
        created ─────────────────────> planning
                                          │
                  ┌───────────────────────┴───────────────────────┐
                  │ execute（仅 wave）                             │ verify（epic/feature/slice 跳过 execute）
                  ▼                                                │
              executing                                            │
                  │ verify                                         │
                  ▼                                                │
              verified <───────────────────────────────────────────┘
                  │
                  │ close（close gate 通过后）──> closed
                  │ verified 内：split（epic/feature/slice 产子）不改 status

    abort: 任何非终态 ───────────────────────────────────────────> aborted
```

**verified 状态内的两个 action**：
- `split`（epic/feature/slice）：产子 WorkUnit。**不改 status**（仍在 verified），一次性 action（一个 verified 周期内调用一次，产所有子 WorkUnit）
- `close`（全部）：close gate 通过后 verified → closed

**4 个 scope 的实际流转**：

```
epic:    created → planning → verified → closed
         （verified 内：split 产 feature + close 归档；close gate 不等 feature）
feature: created → planning → verified → closed
         （verified 内：split 产 slice，等 slice 全 closed 后 close）
slice:   created → planning → verified → closed
         （verified 内：split 产 wave，等 wave 全 verified 后 close）
wave:    created → planning → executing → verified → closed
         （不 split；execute 写代码 + commit；close 前 commit 存在）
```

epic/feature/slice 都**不走 executing**（协调型/规划型），**仅 wave 走 executing**（执行型）。所有 scope 终态都是 closed。

### 4.6 统一 transitions 规则表

实施工程师写 `ScopeConfig.transitions` 的依据（接口结构见 §D.3）。通用 action 所有 scope 共享规则，scope 特有 action 各自定义。

#### 通用 action 规则（所有 scope 共享）

| action | expectedStatuses | nextStatus | progressive | 说明 |
|---|---|---|---|---|
| create | []（无，新建）| created | - | 入口 |
| plan | [created, planning, verified] | planning | true | 规划期，progressive 重入；verified→planning 是 replan 回退 |
| execute | [planning, executing] | executing | true | **仅 wave** |
| verify | [planning, executing, verified] | verified | true | 验证期，progressive 重入（fix loop）|
| split | [verified] | verified（不改）| - | verified 内产子，不改 status |
| close | [verified] | closed | - | 归档，close gate 通过后 |
| abort | [created, planning, executing, verified] | aborted | - | 旁路，任何非终态 |

#### scope 启用矩阵（哪些 scope 启用哪些通用 action）

| action | epic | feature | slice | wave |
|---|---|---|---|---|
| create / plan / verify / close / abort | ✓ | ✓ | ✓ | ✓ |
| execute | ✗ | ✗ | ✗（协调型）| ✓（唯一执行型）|
| split | ✓（产 feature）| ✓（产 slice）| ✓（产 wave）| ✗（叶子）|

#### scope 特有 action（非通用，各 scope 独立配置）

| action | scope | expectedStatuses | nextStatus | 语义 |
|---|---|---|---|---|
| deprecate | wave | [verified] | verified（不改，改 validity）| wave 弃用（详见 §6.6）|
| unlock | feature | [verified] | verified（不改，lockVersion++）| spec 解锁，触发下游 drift（路径①）|
| supersede | feature | [verified, closed] | closed | 整体替换，触发下游 drift（路径②）|
| re_split | feature | [closed] | verified | 重新拆分（旧 slice 标 superseded）|
| mark-drifted | 启用 driftConfig 的 scope | [open, acknowledged, rebased] | open | engine 内部触发（走 dispatchDrift）|
| acknowledge-drift | 同上 | [open] | acknowledged | drift 处理（走 dispatchDrift）|
| rebase-on-upstream | 同上 | [open] | rebased | drift 处理（走 dispatchDrift）|
| claim / release | concurrentMode=parallel 的 scope | — | — | 并发互斥（parallel 模式）|

drift action（mark-drifted / acknowledge-drift / rebase-on-upstream）走 `dispatchDrift` 分流（见 §D.6），不进主状态机 transitions。

---

## 5. 领域建模

### 5.1 WorkUnit（4 scope，统一状态机）

WorkUnit 是中心抽象。4 个 scope 共享统一状态机（§4），差异只在 ScopeConfig。

#### epic（最大粒度）
- **职责**：跨多 feature 大工作的决策收敛。**只规划不执行**（Plan, don't do）
- **流转**：created → planning → verified → closed（verified 内：split 产 feature，close gate 不等 feature）
- **plan 内容**：charting（画决策项 + fog）
- **特殊**：closed 是真终态。closed 后发现新 fog = destination redraw = 新 epic

#### feature（单特性）
- **职责**：单 feature 的需求收敛，产出可构建 spec
- **流转**：created → planning → verified → closed（verified 内：split 产 slice；等派生 slice 全 closed 后 close）
- **plan 内容**：draft（写 FR/AC/UC）
- **特殊**：verified 后 spec immutable（除非 unlock 重过 gate）

#### slice（单 session 协调切片）
- **职责**：单 session 可完成 slice 的**协调约束**（规划 + 拆 wave + 等待 wave 执行）。cw 核心价值
- **流转**：created → planning → verified → closed（协调型，不走 executing）
- **plan 内容**：技术设计 + 拆 wave 方案（TDD 测试代码在 wave 的 plan 里写）
- **verified 语义**：split 产 wave 后，等派生 wave 全 verified
- **特殊**：保留 cw 0.x 的机器验证机制（**在 wave 层实施**：wave 级 TDD 红灯 + judgeByExpected 重算 + append-only）

#### wave（最小执行单元）
- **职责**：实际开发单元，有自己的完整流程
- **流转**：created → planning → executing → verified → closed（唯一执行型）
- **plan 内容**：refine（细化方案 + 写 TDD 测试代码）
- **execute 内容**：写实现代码（progressive）
- **特殊**：wave 是交付链叶子（不 split）。execute 后 commit 锚定 commitHash

### 5.2 决策项（plan 产物，不是 WorkUnit）

决策项是任何 WorkUnit plan 阶段产生的「问题 + 答案」记录，挂在 WorkUnit 的 collection 里。

```typescript
interface DecisionItem {
  id: string;
  question: string;
  resolution?: string;
  type: "research" | "prototype" | "grilling" | "task";
  status: "open" | "claimed" | "resolved";
  claimedBy?: string;
  triggeredResearchId?: string;  // research type 触发
  triggeredWaveId?: string;      // prototype/task type 触发临时 wave
}
```

**4 种 type = 4 种求解模式**：

| type | 怎么得答案 | 触发 | 模式 |
|---|---|---|---|
| research | 查外部权威 | research 服务 | AFK |
| prototype | 做粗糙实物 | 临时 wave（throwaway）| HITL |
| grilling | 一问一答逼问人 | 无（人直接答）| HITL |
| task | 纯体力活 | 临时 wave | HITL 或 AFK |

任何 WorkUnit 的 plan 阶段都可能产生决策项（epic charting 决策维度 / feature draft 需求维度 / slice plan 技术维度 / wave refine 实现维度）。

### 5.3 横向服务（无生命周期）

| 服务 | 职责 | 被调用 |
|---|---|---|
| **research** | 外部真相查询（cited sources，可 invalidate）| 决策项（research type）|
| **glossary** | 术语查询/写入（revise 旧定义进 history）| feature verify gate |
| **ADR** | 沉淀架构决策（supersede 不删）| 决策项升级 / 跨层引用 |

**决策项 vs ADR**：决策项是过程问题-答案（绑定 WorkUnit，短期）；ADR 是沉淀原则（全局，长期）。单向升级：重要决策项 → ADR → 原 WorkUnit 改引用 ADR id。

### 5.4 概念关系图

```
┌─ WorkUnit 链（4 scope，统一状态机）───────────────────────────┐
│  epic ──split──> feature ──split──> slice ──split──> wave    │
│                                                              │
│  每个 WorkUnit：plan → [execute] → verify → [split|close]    │
└──────────────────────────────────────────────────────────────┘
         │ plan 阶段产生决策项
         ▼
┌─ 决策项（WorkUnit collection 元素，不是 Unit）──────────────┐
│  type: research → research 服务                               │
│  type: prototype/task → 临时 wave                             │
│  type: grilling → HITL                                        │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
┌─ 横向服务（无状态）──────────────────────────────────────────┐
│  research / glossary / ADR                                    │
└──────────────────────────────────────────────────────────────┘
```

---

## 6. 层内流程（统一）

### 6.1 plan 阶段（规划，progressive）

plan 是规划期，把「不确定」收敛为「可执行/可验证」。核心产物是**决策项** + scope 特定的规划产物（spec / 技术方案 / wave 的测试代码）。

**统一流程**：
1. WorkUnit 进入 planning
2. agent/人识别待决策问题，创建决策项
3. 按决策项 type 触发求解（research/临时 wave/HITL）
4. 决策项 resolve（得到 resolution）
5. 关键决策项升级为 ADR
6. 规划产物完备（plan gate 通过）→ 可进 execute 或 verify

**plan gate（scope 差异）**：
- epic：决策项结构校验
- feature：SpecSection schema（FR/AC/UC 完整）
- slice：plan schema + wave 拆分完整性（slice 是协调型，不写测试代码）
- wave：refine + **TDD 红灯校验**（测试代码写好且跑起来是红灯）

### 6.2 execute 阶段（执行，progressive，仅 wave）

execute 是写实现代码。**仅 wave 走**（wave 是唯一执行型）。epic/feature/slice 是协调型/规划型，不直接 execute——slice 的执行委托给派生 wave。

wave 的 execute = 写代码 + commit：
- progressive：可多次调用，每次提交一部分
- append-only：committed 后不可删改（FreezeRule 保护）
- gate：GitValidator（commit 存在 + diff-tree 文件校验）

### 6.3 verify 阶段（验证，progressive）

verify 检查产物质量。cw 0.x 的 review/test 都统一到这里。

**verify 内部两个子动作**（progressive 内多轮）：
- **review**：人工/机器审查（grilling / spec_review / code review）
- **test**：机器跑测试（judgeByExpected 重算）

**verify gate（scope 差异）**：
- epic：决策项 resolution 完整（grilling）
- feature：no-open review issue（spec_review）
- slice：plan_review 通过（技术方案审查；slice 是协调型，不跑 test）
- wave：test 全 pass（judgeByExpected 重算）

**fix loop**：verify 失败 → 修复 → 再次 verify（progressive 重入）。loop 上限防死循环（slice plan_review ×3 / wave review×3 / test×5）。

### 6.4 split / close 阶段

**split**（epic/feature/slice）：产子 WorkUnit
- epic split → 产 feature（feature 继承 epic 的 Decisions）
- feature split → 产 slice（slice 引用 feature spec）
- slice split → 产 wave

**close**（全部 scope）：归档
- close gate（scope 差异）：
  - epic：全决策项 resolved + fog 空（不等 feature 完成）
  - feature：派生 slice 全 closed + 无 drift
  - slice：派生 wave 全 verified + 无 drift
  - wave：commit 存在
- close 后 append-only（evidence 冻结）

### 6.5 gate 机制（机器验证）

延续 cw 0.x 核心：**不信任声明，只信机器证据**。

- **evidence gate**：commit-anchor（git hash，wave execute）/ TDD red light（wave plan）/ judgeByExpected 重算（wave verify）
- **coverage gate**：FR→AC 覆盖 / AC→testCase 覆盖
- **freeze rule**：append-only 校验（immutableFields 白名单）
- **gate 失败不阻断**：只 append gateHistory + 连续 fail 5 次换熔断文案
- **gate 失败不流转**：status 不变，agent retry

### 6.6 wave 弃用机制（append-only 下的逻辑废弃）

**问题**：wave committed 后 FreezeRule 锁死 commitHash/changes/dependsOn（§D.4 wave-committed）。wave 技术方案错了要重来，append-only 不让删，只能追加 wave3，topic 膨胀。

**解决**：wave 加正交的 validity 维度（§3.2 WorkUnit.validity 字段）+ deprecate action。

**deprecate action**（wave 特有，progressive 原地停留）：
- expectedStatuses: [verified]（wave 已验证后才能弃用）
- nextStatus: verified（不改 lifecycle status，改 validity 字段）
- gate: `supersede-target-exists`（强制 supersededBy 非空，防止 agent 把所有 committed wave 标 deprecated 绕过 dev 验证）

**close gate 二维判断**（wave）：终端态 = closed OR deprecated：
```
terminalOrDeprecated(wave) =
  wave.status === closed
  OR (wave.validity === "deprecated" && wave.supersededBy 非空)
```

slice close gate 用此判断：派生 wave 全 verified OR deprecated。

**replan 场景重写**（wave1 方案错了）：
1. agent 调 `cw slice plan`（replan，slice 从 verified 回退到 planning）
2. new plan 把 wave1.validity=deprecated + supersededBy=wave3，追加 wave3
3. `checkFreeze` 比对：wave1 的 commitHash/changes/dependsOn 未变（在 wave-committed 的 immutableFields 白名单内，受保护）；validity/supersededBy 变了（不在白名单，放行）
4. wave1 保留原数据 + append statusHistory（deprecate 事件）；wave3 新增
5. slice close 时：wave1 terminalOrDeprecated ✓ + wave3 verified ✓

**FreezeRule 零改动红利**：wave-committed 的 immutableFields = [commitHash, changes, dependsOn]。validity/supersededBy/deprecatedReason 不在白名单 → 标 deprecated 天然不触发违规（§D.4 白名单语义）。

---

## 7. 层间流程

### 7.1 正向（向下精化）

```
epic ──split──> feature ──split──> slice ──split──> wave
(产 feature)   (产 slice)          (产 wave)
```

所有 parent 的 split 都在 **verified 状态内**调用（不改 status，仍在 verified），产子后 parent 等子完成再 close。

**epic split**：
- 触发：epic verified 后（verified 内调用）
- 产出：N 个 feature（每个继承 epic 的 Decisions 作为初始 spec）
- feature.derivedFromId = epic.id；epic close → closed（真终态，close gate = fog 空，**不等 feature 完成**）

**feature split**：
- 触发：feature verified 后（verified 内调用）
- 产出：N 个 slice 骨架（specSections snapshot feature spec 的 lockVersion 版本）
- slice.derivedFromId = feature.id；slice.parentLockVersion = feature.lockVersion
- feature close gate = 派生 slice 全 closed（split 后 feature 等所有 slice 完成）

**slice split**：
- 触发：slice verified 后（verified 内调用；slice 是协调型，不走 execute）
- 产出：N 个 wave 骨架（粗粒度划分，wave 内部继续 plan/refine）
- wave.parentUnitId = slice.id
- slice close gate = 派生 wave 全 verified + 无 drift（split 后 slice 等所有 wave 完成）

**决策项触发下游**：
- research type → research 服务（AFK，subagent 并行）
- prototype/task type → 临时 wave（throwaway，完成后标 deprecated，不进交付链）

### 7.1.1 逆向 action（feature 专属，drift 触发源）

feature 有 3 个逆向 action，是 drift 路径①② 的触发源（§7.2）：

**unlock**（spec 解锁）：
- 触发：feature verified 后，agent 发现 spec 要改
- 流转：verified → verified（不改 status），但 `lockVersion++`（append lockHistory）
- 副作用：扫描所有 slice.derivedFromId === feature.id，append slice.driftLog（cause: feature-unlock）—— drift 路径①
- 语义：feature 回到「可改 spec」状态，下游 slice 标 drifted

**supersede**（整体替换）：
- 触发：feature 整体废弃，用新 feature 替代
- 流转：verified/closed → closed（feature 标 deprecated + supersededBy 指向新 feature）
- 副作用：扫描派生 slice，append driftLog（cause: feature-superseded）—— drift 路径②
- 语义：feature 被取代（不删，append supersededBy 指针）

**re_split**（重新拆分）：
- 触发：feature 已 split 产 slice，但拆分方案要改
- 流转：closed → verified（回到可 split 状态）
- 副作用：旧 slice 骨架标 superseded；feature 可再 split
- 语义：重新拆分（旧 slice 不删，标 superseded）

**lockVersion 递增机制**：feature unlock 时 `lockVersion++`。slice 创建时 snapshot `parentLockVersion = feature.lockVersion`。drift 检测对比 `slice.parentLockVersion !== feature.lockVersion`（不等 = 上游变了 = drifted）。

### 7.2 逆向（drift 机制）

**drift 用事件流抽象**（不用三态字段）：

```typescript
interface DriftEvent {
  id: string;
  causeUnitId: string;
  cause: "feature-unlock" | "feature-supersede" | "adr-supersede" | ...;
  detectedAt: string;
  status: "open" | "acknowledged" | "rebased";
  reason?: string;
}
// WorkUnit.driftLog: DriftEvent[]（append-only，顶级字段）
```

driftStatus 是 derived（driftLog 有 open 事件 = drifted）。

**drift 阻塞 close gate**：有 open drift 事件 → 不能 close。

**5 条 drift 路径**：

| 路径 | 触发 | 下游影响 |
|---|---|---|
| ① feature unlock → slice drift | `cw feature unlock` | slice append driftLog（feature-unlock）|
| ② feature supersede → slice | `cw feature supersede` | slice drift（feature-superseded），阻塞 close |
| ③ ADR supersede → 全局 | `cw adr supersede` | 引用该 ADR 的 WorkUnit drift，**不阻塞**（参考性）|
| ④ research invalidate → 决策项 | `cw research invalidate` | related 决策项 reopen |
| ⑤ epic closed 后发现新 fog | 不 reopen | 新建 epic（继承 old Decisions），old 保持 closed |

**drift 处理 action**（走 drift 子状态机，不进主 6 action）：
- `acknowledge-drift <id> --reason "..."`：open → acknowledged（agent 决定不跟随上游）
- `rebase-on-upstream <id>`：open → rebased（agent 跟随，受 freeze 保护）
- `abort <id>`：放弃整个 WorkUnit

**acknowledged 不是终态**：已 acknowledged 的 WorkUnit 若上游再变，append 新 open 事件，driftStatus 自动恢复 drifted。

---

## 8. 命令集（统一）

### 8.1 命令格式

所有命令统一为 `cw <scope> <action>`：
- scope = `epic` / `feature` / `slice` / `wave`
- action = 统一 6 词 + drift/claim 通用

**与 cw 0.x 不冲突**：cw 0.x 命令无 scope 前缀（`cw create/plan/dev/...`），1.0 命令有 scope 前缀。两者可并存。

### 8.2 主命令（6 核心 + abort）

```bash
cw <scope> create <slug> [--from-<parent> <id>]
cw <scope> plan <id>                    # progressive
cw <scope> execute <id>                 # wave only, progressive
cw <scope> verify <id>                  # progressive
cw <scope> split <id>                   # epic/feature/slice only
cw <scope> close <id>
cw <scope> abort <id>
```

### 8.3 通用命令（drift + claim）

```bash
cw <scope> acknowledge-drift <id> --reason "..."
cw <scope> rebase-on-upstream <id>
cw <scope> claim <id>                   # parallel mode only
cw <scope> release <id>
```

### 8.4 查询命令

```bash
cw <scope> status <id>
cw <scope> list
cw <scope> show <id>
```

### 8.5 横向服务命令

```bash
cw research start <slug> --question "..."
cw research resolve <slug> --findings <md> --sources <list>
cw research invalidate <slug> --reason "..."

cw adr add --title "..." --decision "..."
cw adr supersede <old> <new>

cw glossary add --term "..." --definition "..."
cw glossary revise <term> --definition "..."
```

### 8.6 跨层衔接的 guidance 链

```
cw epic split 完成 → guidance：
  "已产 N 个 feature：<list>。对每个走 cw feature plan → verify → split"

cw feature split 完成 → guidance：
  "已产 N 个 slice，拓扑顺序：S1 → S2 (blocked by S1)。
   下一步：cw slice create --from-feature <slug> --pick 1"

cw wave plan 失败（TDD 红灯未过）→ guidance：
  "plan gate 失败：测试未达红灯。先写测试代码并确认 fail，再 cw wave plan"

cw slice close 完成 → guidance：
  "该 feature 还有 N 个 slice 待做。全部完成可 cw feature close"
```

---

## 9. 关键决策

### 9.1 决策 1：真统一状态机【长期】

**决策**：所有 WorkUnit scope 共享 6 status / 6 action。差异只在 ScopeConfig。

**理由**：
- v2 让 slice 继承 cw 0.x 的 19 action/12 status，导致 scope 间状态机规模悬殊，「统一引擎」名不副实
- 真统一让架构图、命令集、引擎实现全部对齐
- 学一套流程名会所有 scope

**代价**：不继承 cw 0.x，slice 状态机重设计（cw 0.x 的细分语义用 plan/execute/verify 的 progressive + gate 表达）。cw 0.x 作为独立工具继续可用，不强行迁移。

### 9.2 决策 2：决策项是 plan 产物，不是 WorkUnit【长期】

决策项是任何 WorkUnit plan 阶段的「问题+答案」记录，挂 collection，不是独立 Unit。理由：决策项本质是服务于 clarify 的记录，当 WorkUnit 会导致「不在交付链」「和 wave 关系混乱」等解释不清的问题。

### 9.3 决策 3：wave 是完整 WorkUnit【长期】

wave 是真正的子 WorkUnit（有自己的 plan/execute/verify/close），不是 cw 0.x 的「提交批次」。slice 的 plan 初步划分 wave，wave 内部继续 plan（refine）达到可开发。

### 9.4 决策 4：claim 作为通用引擎机制【长期】

claim 不专属 epic。Unit 有顶级 claimedBy 字段，claim/release 是通用 action，ScopeConfig 用 concurrentMode 控制是否启用。claimer 身份锚定 worktree（.cw/session.json）。

### 9.5 决策 5：drift 用事件流抽象【长期】

driftLog 事件流（append-only），driftStatus 是 derived。支持多 cause 累积 + 选择性 acknowledge + acknowledged 非终态。

### 9.6 决策 6：术语提取用 SpecSection.terms 显式声明【长期】

SpecSection 加 terms?: string[]，作者显式声明。extractTermsFromSpec 是纯函数。与 FR-AC 强引用统一。

### 9.7 决策 7：新命令集与 cw 0.x 不冲突【长期】

1.0 用 `cw <scope> <action>`，cw 0.x 用 `cw <action>`。两者可并存于同一安装。cw 0.x 的 464 个测试和已发布的 topic 数据不受 1.0 影响。1.0 是独立的新系统。

## 10. 与 cw 0.x 的对照

### 10.1 概念映射

| cw 0.x | cw 1.0（v3）| 变化 |
|---|---|---|
| topic | slice | 重命名 |
| 19 action / 12 status | **6 action / 6 status**（全部 scope 统一）| 收敛历史包袋 |
| wave（topic 内嵌字段）| wave（完整 WorkUnit）| 升级 |
| clarifyRecord | 决策项 | 概念统一（任何 WorkUnit plan 都产生）|
| TaskShape | ScopeConfig | 模式扩展（从 slice 专属到所有 scope）|
| TRANSITIONS | ScopeConfig.transitions | 配置平移 |
| checkLinear | UnitStateMachine.guard() | 算法平移，参数化 |
| validateAppendOnly | FreezeRule + checkFreeze | 硬编码 → 声明表 |
| gateHistory（散落）| GateRunner 统一 append | 集中化 |
| —（无）| epic / feature | 新增（补齐规划层）|
| —（无）| drift 机制 | 新增（跨层一致性）|
| —（无）| claim 通用机制 | 新增 |

### 10.2 cw 0.x 命令 vs 1.0 命令

| cw 0.x | cw 1.0 |
|---|---|
| `cw create` | `cw slice create` |
| `cw clarify` / `cw plan` / `cw tdd_plan` | `cw slice plan`（规划期全包）|
| `cw dev` | `cw wave execute`（1.0 里代码在 wave 写，slice 不 execute）|
| `cw review` / `cw test` | `cw slice verify`（验证期全包）|
| `cw closeout` | `cw slice close` |
| `cw replan` | `cw slice plan`（progressive 重入）|
| `cw abort` | `cw slice abort` |

**两者不冲突**：cw 0.x 命令无 scope 前缀，1.0 有。可并存。

### 10.3 cw 0.x 机器验证机制的保留

1.0 完全保留 cw 0.x 的机器验证核心：
- **GitValidator**（commit 存在 + diff-tree 文件校验）→ wave execute gate
- **TDD 红灯校验** → wave plan gate
- **judgeByExpected 纯函数重算** → wave verify gate
- **append-only 校验** → FreezeRule（immutableFields 白名单）
- **flock + 原子写事务** → store 实现
- **gateHistory append-only** → GateRunner 统一 append
- **TaskShape 策略组合** → ScopeConfig 扩展（full-tdd / existence-only / review-only 三个内置 shape 平移）

### 10.4 迁移路径（5 阶段）

| 阶段 | 范围 | 工程量 |
|---|---|---|
| **M1** | 接入真实 store + gate（CwStoreAdapter + 迁移 gate 为 GateSpec）| 中 |
| **M2** | 实现 slice ScopeConfig（统一 6 action/6 status + wave 升级 + TDD 红灯 + judgeByExpected）| 大 |
| **M3** | 实现 feature ScopeConfig（plan=draft + verify gate 三件套 + split 产 slice）| 大 |
| **M4** | 实现 epic ScopeConfig（plan=charting + 决策项 4 type + claim 子系统）| 大（claim 复杂）|
| **M5** | 跨层 drift + 影响传播（5 路径 + drift 子状态机）| 中 |

每个阶段独立 topic，渐进交付。cw 0.x 在迁移期间作为独立工具继续可用。

---

## 11. 领域不变量（12 条）

整合 matt 11 条 + cw 核心。这是 cw 1.0 的领域宪法：

| # | 不变量 | 来源 |
|---|---|---|
| 1 | **目标锚定**：每个 WorkUnit 有「完成时世界长什么样」，先于一切被命名 | matt |
| 2 | **粒度匹配上下文**：WorkUnit 切到「当前上下文能装下并解决完」的粒度 | matt |
| 3 | **产出形态分层**：规划层（epic/feature）产决策，协调层（slice）拆 wave 不产交付物，执行层（wave）产机器验证过的代码 | matt+cw |
| 4 | **依赖 DAG + 动态浮现**：WorkUnit 间偏序依赖，随前驱答案显化 | matt |
| 5 | **可执行边沿**：当前可拿 = open ∧ unblocked ∧ unclaimed | matt |
| 6 | **显式不确定性**：区分「问题已锋利（决策项）」和「说不清的将来（fog）」| matt |
| 7 | **显式 scope 边界**：范围内/外/已决策三独立桶 | matt |
| 8 | **HITL 边界**：真人决策 vs agent 可独办，前者不替人表态 | matt |
| 9 | **并发互斥 + 上下文边界**：同 WorkUnit 同时只能一个 worker 占有；一个 worker 一次只解一个 | matt |
| 10 | **移交而非执行**：规划层产决策不产交付物 | matt |
| 11 | **机器证据优先**：不信任声明，只信机器验证（git hash / exit / 重算）| cw |
| 12 | **append-only 历史**：逆向不删旧，标 deprecated/superseded | cw |

**机器化映射**（每个不变量如何由状态机/gate 实现）：

| 不变量 | 机制 |
|---|---|
| 1 | WorkUnit create 必填 destination/objective |
| 2 | scope 配置（epic/feature/slice/wave 粒度递减）|
| 3 | scope 配置（仅 wave 启用 execute；epic/feature/slice 协调型不 execute）|
| 4 | 决策项 blocking + graduate（fog 显化）|
| 5 | frontier query（open ∧ unblocked ∧ unclaimed）|
| 6 | epic 的待澄清项 collection + 显化 action |
| 7 | 范围外 collection（独立于决策项）|
| 8 | 决策项 type（grilling 必须真人）|
| 9 | claim 机制 + one-per-session |
| 10 | epic/feature/slice 无 execute action（仅 wave 执行型）|
| 11 | gate（git hash / exit / judgeByExpected）|
| 12 | FreezeRule + driftLog append + supersede 不删 |

---

## 12. 开放问题（实施前需确认）

### 12.1 claim 双写在 NFS 上的原子性

claim 用 O_EXCL，但 NFSv3 不保证跨 client 原子。可能方案：`link()` / `.lock` 目录。M4 前 补。

### 12.2 FR-AC 覆盖率的具体匹配算法

feature plan gate 的 FR-AC 覆盖：「每个 FR 都要有对应 AC」。可能方案：强引用（FR.ac: string[]）/ 弱引用 / NLP。倾向强引用。M3 前补。

### 12.3 slice replan 的差异算法

slice plan 重入（原 replan）时，「保留旧 wave + 追加新 wave」还是「算 diff」。可能方案：agent 负责 diff / engine 自动 diff / 半自动。M2 前补。

### 12.4 多 worktree 并行的冲突协调

两个 slice 改同一文件。可能方案：不管（保持边界）/ feature split 检测文件冲突 / worktree 分配约束。M3 前补。

### 12.5 决策项 type 的子流程差异

prototype/task 触发临时 wave 的生命周期（throwaway、不进交付链、完成后标 deprecated）。M4 前补。

### 12.6 术语提取的漏列 fallback 策略

SpecSection.terms 显式声明，但作者漏列时（漏列 = 绕过 gate）。可能方案：硬阻断 / warning / 混合。M3 前补。

### 12.7 cw 0.x 与 1.0 并存的边界

两者命令不冲突，但 `.cw/` store 目录是否共用？topic 数据是否可被 1.0 读取？M1 前确认。

---

## 附录 A：边界场景

**① wave committed 后 slice plan 重入**：走 wave 弃用机制（validity=deprecated + supersededBy）。FreezeRule 白名单放行 validity。

**② feature unlock 后下游 slice 分级处理**：
- created：标 drifted，建议 abort + 重建
- executing/verified：标 drifted，close gate 阻塞
- closed：仍 append driftLog（不阻塞）

**③ claim TTL 过期但 agent 还在跑**：stale 清理 + 拒绝原 claimer 的后续操作。

**④ parent abort 后 child 级联**：parent abort → 所有未 terminal child 级联 abort。

**⑤ 跨层 drift 多跳**：不做实时链式传播，每层只管直接下游。

**⑥ glossary 循环依赖**：DFS 检测，发现循环 → 拒绝。

---

## 附录 B：matt 原典机制的完整映射

### B.1 Refer by name（按名引用）
guidance 文本引用决策项/WorkUnit 时用 title + link，不裸用 id。写进 prompts/。

### B.2 No-fog early exit（无 fog 早退）
epic plan 时若初始 fog 为空 + 无决策项 → guidance 提示「工作够小，直接 cw feature create」。

### B.3 Handoff（跨 session 上下文）
handoff 是 agent harness 职责，不进 cw（PRODUCT.md 边界）。cw 只管结构化状态（WorkUnit + 决策项）。

---

## 附录 C：关键文件索引

| 内容 | 路径 |
|---|---|
| 本设计文档（v3 真统一版）| `.xyz-harness/cw-1-0-lifecycle-redesign/design-v3.md` |
| 上一版（v2，被取代）| `.xyz-harness/cw-1-0-lifecycle-redesign/design-v2.md` |
| 架构图（v3）| `~/.agent/diagrams/cw-1-0-architecture-v3.html` |
| 产品级 plan | `.xyz-harness/cw-1-0-lifecycle-redesign/plan.md` |
| 引擎级 engine-design | `docs/engine-design.md` |
| 通用引擎源码（原型）| `src/engine/` |
| cw 0.x 现有实现（迁移参考，不继承）| `src/state-machine.ts` / `src/actions.ts` / `src/shapes/` / `src/store.ts` |
| mattpocock 原典（领域来源）| `~/GitApp/ai-skills/mattpocock-skills/` |

---

## 附录 D：核心接口定义（实施规格）

> 本附录是 M1-M5 实施的接口依据。概念见正文，接口结构见此处。

### D.1 持久化与依赖（EngineDeps 展开）

```typescript
interface UnitStore {
  load(id: string): WorkUnit | null;
  save(unit: WorkUnit): void;
  findChildren(parentUnitId: string): WorkUnit[];
  findByDerivedFrom(upstreamUnitId: string): WorkUnit[];   // drift 查询
}

interface SessionStore {
  /** 读当前 worktree 的 claimer-id；无则生成 UUID 持久化到 .cw/session.json */
  getClaimerId(): string;
}

interface GlossaryStore {
  loadAll(): Map<string, GlossaryEntry>;
  has(term: string): boolean;
}

interface Clock {
  now(): string;   // ISO timestamp
}
```

### D.2 GateSpec + GateRunner

```typescript
interface GateSpec<P> {
  id: string;                              // "plan-schema" / "tdd-red-light" / "fr-ac-coverage"
  kind: "coverage" | "evidence" | "existence" | "schema";
  check: (unit: WorkUnit, input: unknown, deps: EngineDeps) => GateResult;
}

interface GateResult {
  passed: boolean;
  report: string;
  parsed?: unknown;   // check pass 后写入 store 的结构化数据（如 testCases）
}

interface GateRunner {
  run<S, P>(unit, action, progressive, gates: GateSpec[], input, deps): {
    passed: boolean;
    results: GateResult[];
    entries: GateHistoryEntry[];   // 统一构造的 gateHistory 条目
  };
}
```

**DefaultGateRunner 短路语义**：任一 gate fail 立即返回，不执行后续 gate。无论 pass/fail 都构造 gateHistory 条目。

### D.3 TransitionRule（状态转换规则）

```typescript
interface TransitionRule<S> {
  expectedStatuses: readonly S[];   // 当前 status 必须在此集合
  nextStatus: S;                    // 流转后 status
  progressive?: boolean;            // true=若 current===nextStatus 则原地停留
  gateIds?: readonly string[];      // 流转前要过的 gate id 列表
}
```

**progressive 语义**（`computeNextStatus` 实现）：若 `rule.progressive && current === rule.nextStatus`，原地停留（不改 status）；否则 → nextStatus。replan 时从 verified 调 plan：plan 的 nextStatus=planning，verified≠planning，所以回退。

### D.4 FreezeRule + checkFreeze

```typescript
interface FreezeRule<P> {
  id: string;                              // "wave-committed" / "test-case-passed"
  collection: string;                      // 受保护的 collection 名
  predicate: (item, unit) => boolean;      // 元素是否受保护
  immutableFields: readonly string[];      // 受保护后不可改的字段（白名单语义）
  violationType: string;                   // 违规类型标识
}

// checkFreeze：遍历每条规则，在 oldUnit 找受保护元素，在 newUnit 按 id 匹配
// 找不到 → "deleted" 违规；找到但 immutableFields 变化 → "modified" 违规
```

**白名单语义红利**：`immutableFields` 只锁列出的字段。wave 的 `validity/supersededBy/deprecatedReason` 不在 `wave-committed` 的 immutableFields 里 → 标 deprecated 天然不触发违规（详见 §6.6）。

### D.5 CollectionSpec

```typescript
type WriteMode = "append" | "replace" | "freeze";

interface CollectionSpec {
  writeMode: WriteMode;
  versioned?: boolean;   // replace 模式下，旧 version 是否归档
  freezeAt?: "closeout"; // 该 collection 在何时冻结
}
```

- **append**：只增不改（gateHistory / driftLog / decisionItems / statusHistory）
- **replace**：整体替换，可选归档旧 version（testCases replan 时 replace 旧 version 归档）
- **freeze**：closeout 后不可改（evidence）

### D.6 DriftSpec + drift 子状态机

```typescript
interface DriftSpec {
  upstreamScope: string;                    // "feature"（slice 的上游）
  triggerEvents: readonly string[];         // ["unlock", "supersede"]
  blockingActions: readonly string[];       // ["close"]：close gate 查 drift
  transitions: Record<string, DriftTransitionRule>;   // drift 子状态机
}

interface DriftTransitionRule {
  expectedStatuses: readonly DriftEventStatus[];   // ["open" | "acknowledged" | "rebased"]
  nextStatus: DriftEventStatus;
  requiresReason?: boolean;   // acknowledge 类必填
  gateIds?: readonly string[];  // rebase 类要过的 freeze gate
}
```

**drift transitions 表**（所有启用 driftConfig 的 scope 共享）：

| drift action | expectedStatuses | nextStatus | gate | 说明 |
|---|---|---|---|---|
| mark-drifted | [open, acknowledged, rebased] | open | — | engine 内部触发（drift propagation），新 cause 覆盖旧 acknowledged |
| acknowledge-drift | [open] | acknowledged | requiresReason | agent 决定不跟随上游 |
| rebase-on-upstream | [open] | rebased | no-committed-wave-deleted | agent 跟随上游，受 freeze 保护 |

**dispatchDrift 分流**：engine 主 dispatch 前置检查——若 action ∈ driftConfig.transitions，走 `dispatchDrift`（更新 driftLog[i].status，不改 WorkUnit.status）；否则走主 dispatch。

### D.7 SpecSection（feature plan 产物）

```typescript
type SpecSection =
  | { kind: "FR"; id: string; statement: string; ac: string[]; terms?: string[] }
  | { kind: "AC"; id: string; statement: string; fr: string; terms?: string[] }
  | { kind: "UC"; id: string; actor: string; steps: string[]; terms?: string[] }
  | { kind: "decision"; statement: string; adrRef: string }
  | { kind: "complexity"; level: "low" | "medium" | "high" }
  | { kind: "outOfScope"; statement: string }
  | { kind: "goals"; statement: string }
  | { kind: "background"; statement: string }
  | { kind: "constraints"; statement: string };
```

**强引用模式**：`FR.ac: string[]` 强引用 AC id（FR-AC 覆盖 gate 检查每个 AC id 存在）；`section.terms: string[]` 强引用 glossary term（glossary-terms gate 检查每个 term 在 glossary 有定义）。机器可验证，零歧义。

### D.8 feature verify gate 三件套

feature 的 verify gate 不是一个，而是三个 gate（三件套）。§4.3 矩阵的 feature verify gate 应理解为这三者的总称：

```typescript
actionGates: {
  verify: [
    "fr-ac-coverage",      // 每个 FR 都有对应 AC（强引用 AC id 存在）
    "glossary-terms",      // 所有 section.terms 在 glossary 有定义
    "no-open-issue"        // 无 open review issue
  ]
}
```

- **fr-ac-coverage**（coverage gate）：遍历 SpecSection，每个 FR 的 ac 引用的 AC id 都存在
- **glossary-terms**（evidence gate）：遍历 SpecSection，收集所有 terms，查 glossaryStore.has()
- **no-open-issue**（schema gate）：reviewIssues collection 无 status=open 的条目

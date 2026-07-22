# cw 1.0 全生命周期重设计：领域建模设计文档（v2）

> **状态**：领域建模定稿，待命名最终确认与实施
> **源会话**：2026-07-19 ~ 2026-07-20，从 wayfinder 定位讨论演化为全产品重设计
> **文档定位**：1.0 重设计的领域真值来源。基于 mattpocock wayfinder 原典深读 + cw 0.x 真实代码分析，重新做完整领域建模。不直译 matt 命名，抽取领域不变量，用中英混合命名重建。
> **配套文档**：
> - design.md（v1，同目录，已被本文档取代）
> - plan.md（同目录，产品级 plan）
> - docs/engine-design.md（引擎级设计）
> **源代码**：`src/engine/`（通用引擎原型）

---

## 0. 文档定位与阅读顺序

本文档是 cw 1.0 重设计的**领域建模真值来源**。与 v1 的核心差异：

| 维度 | design.md（v1） | design-v2.md（本文档）|
|---|---|---|
| 方法 | 从 v1 推测 + matt 命名直译 | matt 原典深读 + cw 0.x 代码分析 + 重新建模 |
| 核心抽象 | 5 层（L1-L5）+ child unit | **3 类概念**（WorkUnit / 决策项 / 服务）|
| 命名 | map/ticket/effort/claimer（RTS 隐喻直译）| epic/feature/slice/wave + 决策项（中英混合）|
| 决策项定位 | L5 的 child WorkUnit | **clarify 产物**（不是 WorkUnit）|
| wave 定位 | slice 的 child unit（提交批次）| **完整 WorkUnit**（有自己的 clarify/plan/dev）|

**建议阅读顺序**：§1-2（为什么）→ §3（整体架构）→ §6（核心建模）→ §7-10（状态机与流程）→ §5（关键决策记录）。

---

## 1. 背景

### 1.1 cw 0.x：执行期的机器约束

cw 0.x（当前实现，版本 0.0.1）是 **Agent-agnostic 编码流程编排 CLI**。核心赌注：**不信任 agent 的任何声明，只信机器验证的证据**。

- commit 是否真实存在 → `git cat-file -e`
- 测试是否真红灯 → `execFileSync` 跑一次看 exit code
- expected 是否匹配 → `judgeByExpected` 纯函数重算，丢 agent 的 claimedStatus

用状态机 + 机器检查 gate，把流程约束从「prompt 里说说」变成「状态机里拦住」。

**cw 0.x 的实际规模**（代码真值；CONTEXT.md 滞后）：
- **19 个 action**：create / clarify / confirm_clarify / spec_review / spec_review_fix / plan / plan_review / plan_review_fix / tdd_plan / dev / review / review_fix / test / test_fix / retrospect / closeout / replan / abort / assess
- **12 个 status**：created / clarify_confirmed / spec_reviewed / planned / plan_reviewed / pre_dev_verified / developed / reviewed / post_dev_verified / retrospected / closed / aborted
- **TaskShape = VerificationStrategy ⊕ ReviewStagePolicy**（策略组合，插件化的雏形）
- wave 是 topic 的内嵌字段（提交批次），没有独立状态机

**cw 0.x 的局限**：只管单 topic 生命周期（session 级）。管不了「工作量超过单 session 容量 + 路径未清」的大工作。PRODUCT.md:53「不做 CI/CD 集成 — session 级工具」既是产品边界，也暴露了 scope 局限。

### 1.2 mattpocock wayfinder：规划期的不确定性收敛

mattpocock 的 wayfinder 方法论解决根本不同的另一类问题：**AI agent 的工作记忆有上限（~120K token smart zone），但真实项目远远超过这个上限，且路径在开始时不可见——直接冲向终点必然崩盘**。

matt 的核心动作不是「执行得更准」，而是**先把「要决策什么」铺成一个可逐个解决、状态可共享的结构**，把不可避免的「想清楚」过程从单次 session 解放到多次 session + 多人共享的状态里。

wayfinder 提出 11 条领域不变量（详见 §6.6）：目标锚定 / 索引 vs 存储分离 / 决策单元 / 依赖 DAG + 动态浮现 / 可执行边沿 / 显式不确定性 / 显式 scope 边界 / HITL 边界 / 并发互斥 / 上下文边界 / 移交而非执行。

**wayfinder 的局限**：纯方法论，靠 prompt 约束 agent，没有机器验证。agent 会「自信地跑偏」——matt 自己写过 grilling agent 替人回答问题的 bug。

**matt 自己的重命名证据**：CHANGELOG PR #464 记录了从 `decision-mapping` → `wayfinder` 的重命名，matt 承认第一版命名「jargon、不准确」，换成 RTS 游戏隐喻（fog/frontier/map）是为了「一个连贯的前导词框架」。**所有这些词都是可替换的标签**——领域不变量不变，隐喻可换。这正是本文档重新命名的依据。

### 1.3 1.0 的命题：统一两个问题域

cw 0.x 和 wayfinder **不是竞争品，是流水线上下游**：

| | 产出物 | 核心动作 | 时间跨度 |
|---|---|---|---|
| wayfinder | 收敛后的清晰 spec | Plan, don't do（只决策不执行）| 跨 session |
| cw 0.x | 机器验证过的代码 | Do, with gates（执行 + 约束）| 单 topic |

**1.0 命题**：一个工作从「模糊想法」到「机器验证过的代码」，路径上既要**收敛不确定性**（wayfinder），又要**约束执行**（cw）。两者是同一条流水线的不同段。

**产品定位转向**：cw 从「session 级执行约束工具」转为「全生命周期编码流程编排工具」。推翻 PRODUCT.md:53「session 级工具」非目标。

**守住的边界**（不动）：
- 不做 agent harness 集成（仍 bash 调命令 + 读 stdout）
- 不做硬阻断（gate 熔断只告警不阻断）
- 不做远程服务依赖（纯本地）
- 不信任 agent 声明（只信机器证据）

---

## 2. 目标

### 2.1 核心目标

1. **全生命周期覆盖**：从大工作（跨多 feature）到代码交付（单 wave commit）的全链路编排
2. **统一抽象**：一个引擎，N 个配置实例。所有工作单元共享同一套机制（状态机 / gate / freeze / claim / drift），差异只在 ScopeConfig
3. **领域不变量机器化**：把 matt 的 11 条不变量从 prompt 约束升级为状态机 / gate 约束
4. **append-only 历史**：逆向操作不删旧，标 deprecated / superseded
5. **机器证据优先**：延续 cw 0.x 核心，所有声明都要机器验证

### 2.2 非目标（守住边界）

- 不做 agent harness 集成（agent 只需 bash 调 cw + 读 stdout JSON）
- 不做 IDE 插件（CLI 已足够）
- 不做质量阈值硬阻断（gate 熔断只告警不阻断，让 agent 自己决定是否继续）
- 不做远程服务依赖（纯本地，零 True-external 依赖）
- 不做代码仓库管理（只读 git 做 commit 校验，不 clone / push / 管分支）

---

## 3. 整体架构

### 3.1 三类核心抽象

cw 1.0 的世界由三类概念组成：

| 类别 | 成员 | 物理实现 | 引擎处理 |
|---|---|---|---|
| **WorkUnit**（工作单元）| epic / feature / slice / wave | 独立 Unit（id / 状态机 / payload）| `UnitStateMachine<S,A,P>` × 4 个 ScopeConfig |
| **决策项**（决策记录）| 任何 WorkUnit clarify 阶段的产物 | WorkUnit 的 collection 元素 | 引擎不直接管，由 clarify handler 维护 |
| **横向服务**（无状态）| research / glossary / ADR | 独立 service | EngineDeps 注入，被 gate / handler 调用 |

**关键区分**：
- WorkUnit 有完整生命周期（create→clarify→review→lock→split/dev→close），向下精化或交付代码
- 决策项是 WorkUnit clarify 阶段的「问题 + 答案」记录，**不是独立 Unit**
- 服务无生命周期，被任意 WorkUnit 调用

### 3.2 统一引擎：UnitStateMachine<S, A, P>

所有 WorkUnit 共享同一个引擎，差异只在 ScopeConfig 配置：

```typescript
interface WorkUnit<S extends string, P> {
  id: string;                    // "{scope}:{slug}"，如 "epic:auth-refactor"
  scope: "epic" | "feature" | "slice" | "wave";
  slug: string;
  status: S;
  statusHistory: StatusEvent[];  // append-only 状态流转日志

  // 跨层指针（字符串，不用对象引用，解耦递归嵌套）
  parentUnitId?: string;         // wave→slice, slice→feature, feature→epic
  childUnitIds: string[];

  // drift 基础设施（事件流抽象，见 §10）
  driftLog: DriftEvent[];        // append-only，上游变化的记录
  parentLockVersion?: number;    // 创建时 parent 的 lock 版本（drift 快照）

  // lock 版本（feature spec unlock / re-lock 用）
  lockVersion?: number;

  // 并发（claim 通用机制，决策 4）
  claimedBy?: string;            // claimer id（serial 模式不用）

  // 层特定产物 + 通用集合容器
  payload: P;
  collections: Record<string, unknown[]>;
}

interface ScopeConfig<S, A, P> {
  scope: string;
  transitions: Record<A, TransitionRule<S>>;
  phases: { clarify?; review?; lock?; split? };
  coverageGates?; evidenceGates?; freezeRules?; driftConfig?;
  loops?; gateRetryLimit?;
  concurrentMode: "serial" | "parallel";   // 控制是否启用 claim
  collections: Record<string, CollectionSpec>;
  actionGates?: Record<A, readonly string[]>;
}
```

**第三个核心抽象：EngineDeps（依赖注入）**

引擎依赖的外部能力抽成接口，引擎通过 deps 调用，不直接 import 具体实现：

```typescript
interface EngineDeps {
  store: UnitStore;              // 持久化（CwStoreAdapter 桥接 cw 0.x CwStore）
  gateRunner: GateRunner;        // gate 执行（DefaultGateRunner）
  clock: Clock;                  // 时间（SystemClock，测试可注入）
  sessionStore: SessionStore;    // claimer 身份提供（parallel 模式用）
  glossaryStore: GlossaryStore;  // 术语查询（feature lock gate 用）
}

interface UnitStore {
  load(id): WorkUnit | null;
  save(unit): void;
  findChildren(parentUnitId): WorkUnit[];
  findByDerivedFrom(upstreamUnitId): WorkUnit[];   // drift 查询
}

interface SessionStore {
  /** 读当前 worktree 的 claimer-id；无则生成 UUID 持久化到 .cw/session.json */
  getClaimerId(): string;
}

interface GlossaryStore {
  loadAll(): Map<string, GlossaryEntry>;
  has(term: string): boolean;
}
```

**关键设计：collections 通用容器**。把 cw 0.x 散落在 Topic 上的 gateHistory / waves / testCases / clarifyRecords / reviewIssues 等内嵌数组统一为通用容器。ScopeConfig 声明每层有哪些 collection，写入语义由 CollectionSpec 控制（append / replace / freeze）。

### 3.3 架构总图

```
┌─ WorkUnit 链（4 scope，向下精化）─────────────────────────────┐
│                                                              │
│  epic ──collapse──> feature ──split──> slice ──plan──> wave  │
│                                                              │
│  每个 WorkUnit 内部走统一四步骨架：                          │
│    clarify → review → lock → (split 或 dev) → close         │
│  差异只在每步的具体内容（ScopeConfig 配置）                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
         │ 每个 clarify 阶段可能产生
         ▼
┌─ 决策项（clarify 产物，不是 WorkUnit）───────────────────────┐
│  字段：question / resolution / type / status(open|resolved)  │
│  type：research / prototype / grilling / task                │
│  挂在所属 WorkUnit 的 collection 里                          │
└──────────────────────────────────────────────────────────────┘
         │ 某些 type 触发
         ▼
┌─ 横向服务（无状态，被调用）──────────────────────────────────┐
│  research（外部真相查询）  glossary（术语定义）  ADR（决策记录）│
└──────────────────────────────────────────────────────────────┘
```

**引擎统一、概念三类**：
- 工程层面：4 个 WorkUnit scope 全部用 `UnitStateMachine<S,A,P>`，零特例代码
- 概念层面：WorkUnit / 决策项 / 服务 性质不同，不能混为一谈
- 能力差异投射概念差异：WorkUnit 的 ScopeConfig 有 collapse / split transitions，决策项没有（它是 collection 元素）

---

## 4. 困难与挑战

源会话中遇到 6 个关键挑战，每个直接影响最终架构。

### 4.1 挑战 1：两个问题域如何统一？

**难点**：matt wayfinder（规划期决策收敛）和 cw 0.x（执行期机器约束）解决根本不同的问题。直觉设计是「每层一个独立状态机」，但会重复实现 claim / gate / freeze / drift 等机制。

**解决**：挖掘通用骨架。发现 70% 的机制跨层通用（claim / gate / freeze / drift / type-dispatch…），差异只在配置。用通用引擎 + ScopeConfig 插件，一套代码驱动所有 WorkUnit scope。

### 4.2 挑战 2：决策项到底是什么？

**难点**：matt 的 ticket / decision-ticket 有 type（research / prototype / grilling / task）、有 claim、有 resolve 流转，看起来像独立 WorkUnit。但把它当 WorkUnit 后，解释不清「它为什么不在交付链上」「它和 wave 是否对称」。

**三轮错误定位**：
1. 第一轮：当 L5 epic 的 child WorkUnit → 解释不清「不在交付链」
2. 第二轮：当统一 WorkUnit（和 epic / feature / slice 同类）→ 解释不清「和 feature 的关系」
3. 第三轮：当「阶段产物 Unit」（和 wave 对称）→ 但 wave 是真正的 WorkUnit，决策项不是

**最终定位**：决策项是 **clarify 阶段的「问题 + 答案」记录**，不是 WorkUnit。它的 type / claim / resolve 只是问题-答案记录的元数据，不是独立生命周期的标志。任何 WorkUnit（epic / feature / slice / wave）的 clarify 阶段都可能产生决策项。

### 4.3 挑战 3：wave 是提交批次还是完整 WorkUnit？

**难点**：cw 0.x 的 wave 是 topic 的内嵌字段（提交批次，只有 commit hash），没有独立流程。但实际开发中，wave 应该有自己的 clarify / plan 才能达到可开发程度。

**解决**：wave 是**完整的子 WorkUnit**，有自己的 clarify / plan / dev / review / test 流程。slice 的 plan 阶段初步划分 wave（粗粒度），wave 内部继续 clarify / plan 达到可开发程度。cw 0.x 的「提交批次」是工程简化，丢失了 wave 作为实际开发单元的本质。

### 4.4 挑战 4：跨层一致性与 drift

**难点**：上游 WorkUnit 变化时（如 feature unlock 改 spec），下游 WorkUnit（基于旧 spec 的 slice）需要被标记「漂移」，不能假装没事继续 closeout。

**解决**：drift 用**事件流抽象**。driftLog 是 WorkUnit 的顶级字段（append-only），记录每次上游变化。driftStatus 是 derived（driftLog 里有未处理事件 = drifted），不是存储字段。closeout gate 校验「没有未处理 drift 事件」。acknowledge / rebase 是「把某条事件标记为已处理」。

### 4.5 挑战 5：并发与 claim 身份

**难点**：cw 是 agent-agnostic CLI，每次 bash 调用是独立进程，没有长驻 agent 身份。但 claim 子系统需要跨进程知道「这是不是同一个 claimer」。

**解决**：
1. claim 作为**通用引擎机制**（Unit 顶级字段 `claimedBy`），不专属任何层。任何 WorkUnit scope 都可以启用 claim（ScopeConfig 配置 `concurrentMode`）
2. claimer 身份锚定 **worktree**（`<worktree>/.cw/session.json`），复用 cw 0.x 的 RuntimeEnv 持久化先例
3. 隐含假设：一个 worktree 一个 agent。多 agent 并行必须用不同 worktree

### 4.6 挑战 6：术语提取如何机器可验证

**难点**：feature lock gate 要校验「spec 里用的术语都在 glossary 有定义」。但「怎么从 spec 文本识别术语」没有默认答案。分词不准、LLM 违反确定性原则、行内标记干扰可读性。

**解决**：SpecSection 加 `terms?: string[]` 字段，作者显式声明该章节用到的术语。extractTermsFromSpec 是 3 行纯函数（遍历所有 section 收集 terms）。与 FR-AC 强引用模式统一（`FR.ac: string[]` 强引用 AC id，`section.terms: string[]` 强引用 glossary term）。

---

## 5. 关键决策

6 个核心决策，每个标注长期 / 短期性质。

### 5.1 决策 1：统一 WorkUnit 模型【长期】

**决策**：epic / feature / slice / wave 全部是 WorkUnit，共享 `UnitStateMachine<S,A,P>` 引擎，差异只在 ScopeConfig。

**理由**：
- cw 0.x 的 TaskShape 策略组合模式已经验证「插件化」可行，1.0 把它延伸到所有 scope。三个内置 TaskShape 实证：

| shape | VerificationStrategy | ReviewStagePolicy | 适用场景 |
|---|---|---|---|
| `full-tdd` | 测试红灯+绿灯 | 3 阶段 review（6 维度）| 默认，常规编码 |
| `delete-only` | 文件存在性 | 单阶段 review（2 维度）| 删除任务、配置生成 |
| `doc-only` | 恒 pass（无机器验证）| 单阶段 review（1 维度）| 纯文档任务 |

TaskShape = VerificationStrategy ⊕ ReviewStagePolicy（组合而非继承），1.0 把它扩展为完整 ScopeConfig（含状态机 + 通用机制配置）
- 统一抽象让加新 scope 零代码改动（只加配置）
- 心智模型统一（学一层会所有层）

**代价**：wave 从「内嵌字段」升级为「独立 Unit」，工程复杂度上升（wave 有自己的状态机、自己的 gate history）。

### 5.2 决策 2：决策项是 clarify 产物，不是 WorkUnit【长期】

**决策**：决策项是任何 WorkUnit clarify 阶段产生的「问题 + 答案」记录，挂在 WorkUnit 的 collection 里，不是独立 Unit。

**理由**：
- 决策项的本质是「记录一个问题及其答案」，服务于 clarify，不是独立工作单元
- 把它当 WorkUnit 会导致「不在交付链上」「和 wave 关系混乱」等解释不清的问题
- 作为 collection 元素，引擎不需要为它实现独立状态机（它的 open / resolved 只是字段）

**代价**：决策项的 type（research / prototype / grilling / task）触发下游时（如 research 服务、临时 wave），需要 clarify handler 的特殊处理，不能完全靠通用引擎。

### 5.3 决策 3：wave 是完整 WorkUnit【长期】

**决策**：wave 是真正的子 WorkUnit，有自己的 clarify / plan / dev / review / test 流程。

**理由**：
- wave 是实际开发单元，「slice 的 plan 初步划分 wave，wave 内部继续 clarify / plan 达到可开发程度」
- cw 0.x 把 wave 降级为「提交批次」是工程简化，丢失了 wave 作为实际开发单元的本质
- wave 作为完整 WorkUnit，让模型彻底统一（slice 和 wave 同构，只是粒度不同）

**代价**：wave 状态机比 cw 0.x 的「commit hash 字段」复杂得多。

### 5.4 决策 4：claim 作为通用引擎机制【长期】

**决策**：claim 不专属 epic，是通用引擎机制。Unit 有顶级字段 `claimedBy`，claim / heartbeat / release 是通用 action，ScopeConfig 用 `concurrentMode: 'serial' | 'parallel'` 控制是否启用。

**理由**：
- claim 解决的并发问题在每个 scope 都存在（epic 决策项抢认领、slice 抢 dev、wave 抢 commit）
- 用户倾向「多层尽可能复用抽象骨架」
- 把 claim 做成通用机制，避免 epic 专属硬编码

**代价**：serial 模式（cw 默认）的所有 WorkUnit 要携带 claimedBy 字段（不用但占位）。

### 5.5 决策 5：drift 用事件流抽象【长期】

**决策**：不要 driftStatus 三态字段，用 driftLog 事件流。driftStatus 变成 derived（driftLog 里有未处理事件 = drifted）。

**理由**：
- drift 的本质是事件（上游每次变产生一个事件），不是状态
- 事件流天然支持多 cause 累积 + 选择性处理
- 与 cw 的 append-only 哲学完全一致
- 避免 driftStatus 字段的 consistency 维护成本

**代价**：所有引用 driftStatus 的地方（gate、guidance）要改成查 driftLog，工程量比三态字段大。

### 5.6 决策 6：术语提取用 SpecSection.terms 显式声明【长期】

**决策**：SpecSection 加 `terms?: string[]`，作者显式声明用到的术语。extractTermsFromSpec 是纯函数。

**理由**：
- 分词反查自相矛盾（要查未定义术语需先知道哪些是术语）
- LLM 判定违反机器验证原则
- 行内标记 `[[term]]` 干扰可读性
- 显式声明与 FR-AC 强引用模式统一

**代价**：spec 作者承担「显式声明术语」的写作负担。漏列 = 绕过 gate。

## 6. 领域建模

### 6.1 核心抽象：WorkUnit

WorkUnit 是 cw 1.0 的中心抽象。一切「有生命周期的、向下精化或交付代码的」实体都是 WorkUnit。完整字段定义见 §3.2，这里聚焦概念。

**WorkUnit 的四个标志**：
1. 有完整生命周期（create → clarify → review → lock → split/dev → close）
2. 有独立身份（可脱离父单元被引用、被查询）
3. 通过跨层动作衔接上下游（collapse / split / plan）
4. 通过通用引擎 `UnitStateMachine<S,A,P>` 驱动

### 6.2 四个 WorkUnit scope

#### epic（最大粒度）

- **职责**：跨多 feature 大工作的决策收敛。**只规划不执行**（Plan, don't do）
- **输入**：模糊的大工作想法（destination + 初始 fog）
- **产出**：N 个 feature（通过 collapse）
- **核心 clarify 产物**：决策项（charting 阶段，matt 的 decision ticket）
- **特殊点**：collapsed 是真终态，不可 reopen（照搬 matt：collapsed 后发现新 fog = destination redraw = 新 epic）

#### feature（单特性）

- **职责**：单 feature 的需求收敛，产出可构建的 spec
- **输入**：epic collapse 产的 spec draft，或独立新建
- **产出**：N 个 slice（通过 split）
- **核心 clarify 产物**：决策项（draft 阶段，需求维度）
- **特殊点**：lock 后 immutable（除非 unlock 重过 gate）。lock gate 三件套：FR-AC 覆盖 + glossary 术语全定义 + 无 open review issue

#### slice（单 session 可完成的执行切片）

- **职责**：单 session 可完成 slice 的执行约束。cw 核心价值所在，直接继承 cw 0.x 的 topic 语义
- **输入**：feature split 产的 slice 骨架，或独立新建
- **产出**：N 个 wave（通过 plan）+ 机器验证过的代码
- **核心 clarify 产物**：决策项（plan 阶段，技术维度）
- **特殊点**：继承 cw 0.x 的全部机器验证机制（TDD 红绿、judgeByExpected 重算、append-only）

#### wave（最小执行单元）

- **职责**：实际开发单元，有自己的完整流程
- **输入**：slice plan 初步划分（粗粒度）
- **产出**：commit hash（锚定 slice 的 dev）+ 机器验证过的代码片段
- **核心 clarify 产物**：决策项（refine 阶段，实现细节维度）
- **特殊点**：wave 是交付链的叶子（不向下 split）。wave 内部继续 clarify / plan 达到可开发程度，然后 dev / review / test

### 6.3 决策项（clarify 产物）

决策项**不是 WorkUnit**，是任何 WorkUnit clarify 阶段产生的「问题 + 答案」记录。

```typescript
interface DecisionItem {
  id: string;
  question: string;              // 问题（body）
  resolution?: string;           // 答案（resolve 后填）
  type: "research" | "prototype" | "grilling" | "task";
  status: "open" | "claimed" | "resolved";
  claimedBy?: string;            // 认领方（HITL 类型用）
  resolutionAt?: string;
  // 触发记录（如果 type 触发了下游）
  triggeredResearchId?: string;  // research type 触发
  triggeredWaveId?: string;      // prototype/task type 触发临时 wave
}
```

**4 种 type = 4 种求解模式**（怎么得到答案）：

| type | 怎么得答案 | 触发 | 模式 |
|---|---|---|---|
| research | 查外部权威（文档 / API / 源码）| research 服务 | AFK（agent 独自）|
| prototype | 做粗糙实物给人反应 | 临时 wave（throwaway）| HITL（和人一起）|
| grilling | 一问一答逼问人 | 无（人在 clarify 直接答）| HITL |
| task | 纯体力活（注册服务 / 迁数据）| 临时 wave | HITL 或 AFK |

**关键**：
- 决策项挂在 WorkUnit 的 `collections.decisionItems[]` 里
- 任何 WorkUnit clarify 阶段都可能产生（epic charting / feature draft / slice plan / wave refine）
- 不是独立 Unit，引擎不为它实现状态机（status 只是字段）
- cw 0.x 的 clarifyRecords、matt 的 decision ticket，都是决策项的实例

### 6.4 横向服务（无生命周期）

三个横向服务，被任意 WorkUnit 或决策项调用：

| 服务 | 职责 | 被谁调用 |
|---|---|---|
| **research** | 外部真相查询（每条 finding 必引 primary source）| 决策项（research type）|
| **glossary** | 术语定义查询 / 写入 | feature lock gate（术语校验）|
| **ADR** | 沉淀架构决策记录 | 决策项升级 / 独立新增 / 被引用 |

**关键区分**：
- 服务**无生命周期**（不像 WorkUnit 有 create → close）
- 服务是**持久存在**的查询 / 写入接口
- ADR supersede 不删（append-only），glossary revise 旧定义进 history

**决策项 vs ADR 的关系**（单向升级）：
- 决策项 = 过程中的具体问题-答案（绑定 WorkUnit，短期）
- ADR = 沉淀的项目级架构原则（全局共享，长期）
- 重要决策项 → 升级为 ADR → 原 WorkUnit 改引用 ADR id（matt 原则：决策真值只活一处）

### 6.5 概念关系图

```
┌─ WorkUnit 链（4 scope，向下精化）─────────────────────────────┐
│                                                              │
│  epic ──collapse──> feature ──split──> slice ──plan──> wave  │
│                                                              │
│  每个 WorkUnit 内部：clarify → review → lock → split/dev → close │
│                                                              │
└──────────────────────────────────────────────────────────────┘
         │ 每个 clarify 阶段产生决策项
         ▼
┌─ 决策项（WorkUnit 的 collection 元素）───────────────────────┐
│  epic charting → 决策项（决策维度）                          │
│  feature draft → 决策项（需求维度）                          │
│  slice plan    → 决策项（技术维度）                          │
│  wave refine   → 决策项（实现维度）                          │
│                                                              │
│  type: research    → 触发 research 服务                      │
│  type: prototype/task → 触发临时 wave                        │
│  type: grilling    → HITL（人直接答）                        │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
┌─ 横向服务（无状态，被调用）──────────────────────────────────┐
│  research（外部真相）  glossary（术语）  ADR（沉淀决策）      │
│                                                              │
│  决策项 ──(重要)──> 升级为 ADR                               │
│  feature lock gate ──校验──> glossary                        │
└──────────────────────────────────────────────────────────────┘
```

### 6.6 领域不变量（12 条）

整合 matt 11 条 + cw 核心，去重为 12 条。这是 cw 1.0 的领域宪法：

| # | 不变量 | 来源 |
|---|---|---|
| 1 | **目标锚定**：每个 WorkUnit 有「完成时世界长什么样」，先于一切被命名 | matt |
| 2 | **粒度匹配上下文**：WorkUnit 切到「当前上下文能装下并解决完」的粒度 | matt |
| 3 | **产出形态分层**：规划层（epic）产出决策，执行层（slice / wave）产出机器验证过的代码 | matt + cw |
| 4 | **依赖 DAG + 动态浮现**：WorkUnit 间偏序依赖，依赖随前驱答案显化 | matt |
| 5 | **可执行边沿**：当前可拿的 WorkUnit = open ∧ unblocked ∧ unclaimed | matt |
| 6 | **显式不确定性**：区分「问题已锋利（决策项）」和「说不清的将来（fog）」，后者显化成前者 | matt |
| 7 | **显式 scope 边界**：范围内 / 范围外 / 已决策是三个独立桶 | matt |
| 8 | **HITL 边界**：区分真人决策 vs agent 可独办，前者 agent 不替人表态 | matt |
| 9 | **并发互斥 + 上下文边界**：同 WorkUnit 同时只能一个 worker 占有；一个 worker 一次只解一个 | matt |
| 10 | **移交而非执行**：规划层（epic）产出决策不产出交付物；执行层才交付代码 | matt |
| 11 | **机器证据优先**：不信任任何声明，只信机器验证（git hash / exit code / 纯函数重算）| cw |
| 12 | **append-only 历史**：逆向操作不删旧，标 deprecated / superseded，append 进 history | cw |

**关于 matt「索引 vs 存储分离」不变量**：在 1.0 统一模型下，每个 WorkUnit 管自己的数据，跨 WorkUnit 用指针引用——索引 vs 存储分离自动满足（物理上每个 Unit 是独立的存储，parentUnitId 是索引指针），不再是独立不变量。

---

## 7. 状态机

### 7.1 统一四步骨架

所有 WorkUnit 共享同一个流程骨架：

```
create → clarify → review → lock → (split 或 dev) → close
```

每个 scope 的差异只在每步的具体内容：

| 阶段 | epic | feature | slice | wave |
|---|---|---|---|---|
| **clarify** | charting（画决策项 + fog）| draft（写 FR/AC/UC）| plan（技术设计 + 拆 wave）| refine（细化到可开发）|
| **review** | grilling（逼问）| spec_review（审查 spec）| plan_review + code review | code review |
| **lock** | collapse-ready（全决策项 resolved + fog 空）| spec lock（immutable，三件套 gate）| dev commit（append-only）| commit（锚 commitHash）|
| **split / dev** | collapse → 产 feature | split → 产 slice | dev → 提交 wave | dev → 写代码 |
| **close** | collapsed（真终态）| archived | closed（机器验证过）| tested |

### 7.2 epic 状态机

```
charting ──collapse──> collapsed（真终态）
    │                     ▲
    │                     └── 全决策项 resolved + fog 空 + collapse gate pass
    │
    └── abort ──> abandoned
```

- **status**（3 个）：charting / collapsed / abandoned
- **action**：
  - `create`：建 epic，注入 destination + 初始 fog
  - `chart`：charting 阶段 progressive（画决策项、wire blocking、claim/resolve 决策项、graduate fog）
  - `collapse`：collapse-ready 后产 N 个 feature
  - `abort`：→ abandoned
- **特殊**：collapsed 是真终态。collapsed 后发现新 fog = destination redraw = 新 epic（不 reopen）

### 7.3 feature 状态机

```
drafting ──review──> reviewing ──lock──> locked ──split──> split ──archive──> archived
                        ▲                   │                     
                        │                   │ unlock（逆向）      
                        └───────────────────┘                     
                                            locked/split           
                                                │                  
                                                │ supersede（逆向）
                                                ▼                  
                                            deprecated             
```

- **status**（6 个）：drafting / reviewing / locked / split / archived / deprecated
- **action**（9 个）：
  - `draft`：建 feature，写 spec
  - `review` / `review_fix`：progressive，多轮 spec review
  - `lock`：lock gate 三件套（FR-AC 覆盖 + glossary + no-open）
  - `split`：产 N 个 slice 骨架
  - `archive`：所有派生 slice closed 后归档
  - `unlock`：逆向，locked→reviewing，触发下游 drift
  - `re_split`：逆向，split→locked，旧 slice 骨架标 superseded + 重新 split
  - `supersede`：逆向，→deprecated，整体替换为新 feature

### 7.4 slice 状态机

直接继承 cw 0.x 的 19 action / 12 status 完整流程：

```
created → clarify_confirmed → spec_reviewed → planned → plan_reviewed
→ pre_dev_verified → developed → reviewed → post_dev_verified
→ retrospected → closed（+ aborted 旁路）
```

**关键 action**（继承 cw 0.x）：
- clarify 链：`clarify` / `confirm_clarify`
- spec 审查 loop：`spec_review` / `spec_review_fix`
- plan + 审查：`plan` / `plan_review` / `plan_review_fix`
- TDD：`tdd_plan`（红灯校验）
- dev（progressive）：`dev`
- review loop：`review` / `review_fix`
- test（progressive，机器重算）：`test` / `test_fix`
- 复盘 + 归档：`retrospect` / `closeout`
- 旁路：`replan` / `abort` / `assess`（post-closeout）

**取消独立 clarify 阶段**（继承 v1 §3.4 决策）：slice 没有独立 clarify action，plan 阶段吸收实现级技术决策（技术选型 / 接口契约 / 错误策略）。如果 plan 时发现 feature spec 有需求级漏洞（不是实现级），走 drift-back（slice abort + 回 feature unlock）。

**新增 action**（1.0）：
- `acknowledge-drift` / `rebase-on-feature`：drift 处理（见 §10），走 drift 子状态机

### 7.5 wave 状态机

wave 是完整 WorkUnit，有自己的 clarify / plan / dev / review / test：

```
created → refining → refined → committed → reviewed → tested
                                                    └→ aborted
```

- **status**（6 个）：created / refining / refined / committed / reviewed / tested / aborted
- **action**（7 个）：
  - `create`：slice plan 时内部触发（不暴露 CLI）
  - `refine`：progressive，wave 内部 clarify / plan 达到可开发
  - `commit`：dev 完成，锚 commitHash
  - `review` / `review_fix`：progressive
  - `test`：wave 级测试
  - `abort`：→ aborted
- **关键设计**：
  - wave 的 `commit` 锚定 commitHash，作为 slice dev gate 的验证锚点
  - wave committed 后 freeze（commitHash / changes / dependsOn 不可改）
  - wave 可被标 deprecated，详见下方「wave 弃用机制」

#### wave 弃用机制（append-only 下的逻辑废弃）

**问题**：wave committed 后 FreezeRule 锁死 `commitHash / changes / dependsOn`。如果 wave 技术方案彻底错了要重来，append-only 不让删，只能无限追加 wave3/wave4，topic 膨胀。

**解决**：wave 加正交的 validity 维度，与 lifecycle status 独立：

```typescript
// L3WavePayload 扩展字段
validity: "active" | "deprecated";   // 默认 active
supersededBy?: string;                // 弃用时指向替代 wave id（强制非空才能 deprecated）
deprecatedReason?: string;
```

**FreezeRule 白名单语义红利**：`immutableFields` 只锁列出的字段（`commitHash / changes / dependsOn`），`validity / supersededBy / deprecatedReason` 不在白名单 → 标 deprecated 天然不触发违规，**freeze.ts 零改动**。

**deprecate action**（progressive 原地停留，改 validity 不改 lifecycle status）：
- gate：`supersede-target-exists`（强制 supersededBy 非空，防止 agent 把所有 committed wave 标 deprecated 绕过 dev 验证）

**closeout gate 二维判断**：
```
terminalOrDeprecated(wave) =
  wave.status ∈ {tested, aborted}
  OR (wave.validity === "deprecated" && wave.supersededBy 非空)
```

**replan 场景重写**（wave1 方案错了）：agent 调 replan → new plan 把 wave1.validity=deprecated + supersededBy=wave3，追加 wave3 → checkFreeze 放行 validity 变化（白名单外）、保护 commitHash/changes/dependsOn（白名单内）→ wave1 保留原数据 + append statusHistory(deprecate 事件)；wave3 新增 → closeout 时 wave1 terminalOrDeprecated ✓、wave3 tested ✓

### 7.6 决策项状态（非独立状态机）

决策项不是 WorkUnit，没有独立状态机。它的「状态」是字段：

```
open ──claim──> claimed ──resolve──> resolved
                    │
                    └──reopen（上游 invalidate 时）──> open
```

- `open → claimed`：HITL 类型被认领
- `claimed → resolved`：得到答案（resolution 填写）
- `resolved → open`：reopen（上游 research invalidate 时，append 事件留痕）

由所属 WorkUnit 的 clarify handler 维护，不走通用引擎 dispatch。

---

## 8. 层内流程

### 8.1 WorkUnit 内部统一流程

每个 WorkUnit 内部走同一个 5 步流程：

```
1. create       创建 WorkUnit，注入初始状态
2. clarify      澄清（产生决策项，消除不确定性）
3. review       审查（机器或人工检查 clarify 产物）
4. lock         确认（不可变锚点，append-only 起点）
5. split / dev  向下精化（产 child WorkUnit）或交付代码
6. close        归档
```

### 8.2 clarify 阶段（产生决策项）

clarify 是每个 WorkUnit 的「消除不确定性」阶段。核心产物是**决策项**。

**通用 clarify 流程**：
1. WorkUnit 进入 clarify 状态
2. agent / 人识别「需要决策的问题」，创建决策项（question + type）
3. 按决策项 type 触发求解：
   - research type → 触发 research 服务（AFK，subagent 并行）
   - prototype type → 触发临时 wave（throwaway 验证）
   - grilling type → HITL（人直接答）
   - task type → 触发临时 wave（执行体力活）
4. 决策项 resolve（得到 resolution）
5. 关键决策项升级为 ADR（跨 WorkUnit 复用时）
6. 所有决策项 resolved → 可进 review

**各 scope 的 clarify 差异**：

| scope | clarify 阶段名 | 决策项维度 | 典型问题 |
|---|---|---|---|
| epic | charting | 决策维度 | 「目标边界在哪」「要不要做 X」|
| feature | draft | 需求维度 | 「用户角色有几种」「FR-3 的 AC」|
| slice | plan | 技术维度 | 「用 OAuth 还是 session」「错误策略」|
| wave | refine | 实现维度 | 「接口契约」「用哪个库」|

### 8.3 review 阶段（审查）

review 检查 clarify 产物的质量。两种模式：

**机器 review**（gate）：
- feature lock gate 三件套（FR-AC 覆盖 / glossary / no-open）
- slice TDD 红灯校验
- wave commit 存在性校验

**人工 review**（HITL）：
- epic grilling（逼问决策项的 resolution）
- feature spec_review（审查 spec 完整性）
- slice plan_review + code review
- wave code review

review 发现问题 → review_fix loop（progressive，有 TURN_LIMIT 防死循环：slice review×3 / test×5）。

### 8.4 lock 阶段（不可变锚点）

lock 是「确认」动作，lock 后 WorkUnit 进入不可变状态（append-only 起点）。

**各 scope 的 lock 语义**：
- epic lock = collapse-ready（全决策项 resolved + fog 空）
- feature lock = spec immutable（lock gate 三件套通过）
- slice lock = dev commit（append-only，wave committed 后不可删改）
- wave lock = commit（锚 commitHash，freeze）

**unlock 逆向**（仅 feature）：
- feature 可 unlock（locked → reviewing）
- unlock 后 re-lock 必须重过所有 gate（机器证据完整性底线）
- unlock 触发下游 slice 的 drift（见 §10）

### 8.5 gate 机制（机器验证）

延续 cw 0.x 的核心：**不信任 agent 声明，只信机器证据**。

**gate 类型**：
- **evidence gate**：commit-anchor（git hash）/ TDD red light / judgeByExpected 重算
- **coverage gate**：FR→AC 覆盖 / AC→testCase 覆盖
- **schema gate**：文件存在性 / 字段完整性 / drift 阻塞
- **freeze Rule**：append-only 校验（wave committed 不可删改、test case passed 不可篡改 expected）

**gate 失败不阻断**（PRODUCT.md 边界）：
- gate fail 只 append gateHistory + 换熔断文案
- 连续 fail 5 次 → buildCircuitBreakerGuidance（建议人工审查）
- 不阻止 agent 继续重试

**gate 失败不流转**：
- gate fail → status 不变、产物不写、只 append gateHistory(fail)
- agent 按 nextAction retry

## 9. 层间流程（正向）

正向流程 = WorkUnit 如何向下精化产出下游 WorkUnit。

### 9.1 epic → feature（collapse）

```
epic (charting)
  │
  │ 1. charting 阶段：画决策项、wire blocking、claim/resolve、graduate fog
  │ 2. 所有决策项 resolved + fog 空 → collapse-ready
  │ 3. collapse 动作
  ▼
feature × N（每个 feature 继承 epic 的 Decisions 作为初始 spec）
```

**collapse 产出**：
- N 个 feature draft（spec 初始内容来自 epic 的决策项 resolution）
- feature.derivedFromId = epic.id
- epic.status: charting → collapsed（真终态）

**典型决策项（epic charting）**：
- 「这个 epic 的登录用 OAuth 还是 session」→ resolution: OAuth
- 「用户角色有几种」→ resolution: admin / user / guest
- 这些 resolution 被 collapse 时编入 feature 的 initial spec

### 9.2 feature → slice（split）

```
feature (locked)
  │
  │ 1. lock gate 三件套通过（FR-AC + glossary + no-open）
  │ 2. split 动作
  ▼
slice × N（按拓扑顺序，每个 slice 继承 feature 的 AC）
```

**split 产出**：
- N 个 slice 骨架（每个 slice 的 specSections 引用 feature spec）
- slice.derivedFromId = feature.id
- slice.parentLockVersion = feature.lockVersion（drift 快照）
- feature.status: locked → split

**specSections 引用机制**（slice 如何持有 feature spec）：
- 模式 A（`--from-feature` 路径，推荐）：slice 创建时 **snapshot** feature spec 的 lockVersion 版本，存 `specSections: { type: "snapshot", featureSlug, lockVersion, sections: [...] }`。drift 检测靠对比 `slice.parentLockVersion ≠ feature.lockVersion`
- 模式 B（裸 `cw slice create`，兼容小 slice）：specSections 本地内联，不依赖 feature
- 不用 live ref（永远读 feature 最新版）——drift 检测会失锚，且 feature unlock 后 slice 读到的是中间态

**split 的拓扑顺序**：slice 间有依赖（slice B 依赖 slice A 的实现），split 时算出拓扑序，guidance 提示按序开发。

### 9.3 slice → wave（plan）

```
slice (planned)
  │
  │ 1. plan 阶段：技术设计 + 初步划分 wave（粗粒度）
  │ 2. 每个 wave 内部继续 refine（细化到可开发）
  │ 3. wave dev/commit/test
  ▼
wave × N（每个 wave 是独立 WorkUnit，有自己的完整流程）
```

**plan 产出**：
- N 个 wave（粗粒度划分，wave 内部继续 refine）
- wave.parentUnitId = slice.id
- slice.childUnitIds = [wave1, wave2, ...]

**wave 的独立流程**：
- wave refine（wave 内部 clarify / plan）
- wave commit（写代码 + 锚 commitHash）
- wave review / test（验证）
- wave 完成后，slice 的 dev gate 校验 wave commit 真实性

### 9.4 决策项触发下游

决策项的 4 种 type 中，research / prototype / task 会触发下游：

```
决策项 (type=research)
  │ 触发 research 服务（AFK，subagent 并行）
  ▼
research finding（cited sources）
  │ 回写决策项 resolution
  ▼
决策项 resolved

决策项 (type=prototype)
  │ 触发临时 wave（throwaway branch）
  ▼
wave dev（验证代码）+ verdict（adopt/reject/needs-more）
  │ 回写决策项 resolution
  ▼
决策项 resolved（临时 wave 标 deprecated）
```

**关键**：
- prototype / task 触发的是「临时 wave」（服务于决策项），不是 slice plan 产的「正常 wave」（交付链一环）
- 临时 wave 完成后标 deprecated（throwaway），不进交付链
- research 服务是 AFK，不阻塞主线（可并行多个）

---

## 10. 层间流程（逆向）

逆向流程 = 上游 WorkUnit 变化时，如何标记和处理下游的「漂移」。

### 10.1 drift 机制：事件流抽象

**核心设计**（决策 5）：drift 用事件流，不用三态字段。

```typescript
interface DriftEvent {
  id: string;
  causeUnitId: string;          // 谁引发的变化（如 feature.id）
  cause: string;                // "feature-unlock" | "feature-supersede" | "adr-supersede" | ...
  detectedAt: string;
  status: "open" | "acknowledged" | "rebased";  // 处理状态
  resolvedAt?: string;
  reason?: string;              // acknowledge 时填
}

// WorkUnit.driftLog: DriftEvent[]（append-only，顶级字段）
```

**driftStatus 是 derived**（不存储）：
```typescript
function driftStatus(unit: WorkUnit): "clean" | "drifted" {
  return unit.driftLog.some(e => e.status === "open") ? "drifted" : "clean";
}
```

**关键**：
- driftLog 是 WorkUnit 顶级字段（不在 collections），不受 closeout freeze 约束
- closed WorkUnit 仍可 append driftLog（标记 post-close 漂移，不阻塞，仅记录）
- 多 cause 累积天然支持（每条 DriftEvent 独立 status）
- 选择性 acknowledge 支持（ack cause-A，rebase cause-B）
- **acknowledged 不是终态**：已 acknowledged 的 WorkUnit 如果上游再变（新 cause），会 append 新的 open 事件，driftStatus 自动从 clean 恢复为 drifted，agent 必须为新 cause 重新决策。这修复了三态字段方案下「acknowledged 锁死过期决策」的数据完整性漏洞

### 10.2 drift 阻塞 gate

closeout gate 校验「没有未处理 drift 事件」：

```typescript
{
  id: "no-open-drift-on-closeout",
  kind: "schema",
  check: (unit) => {
    const openDrifts = unit.driftLog.filter(e => e.status === "open");
    return {
      passed: openDrifts.length === 0,
      report: openDrifts.length === 0
        ? "无未处理 drift"
        : `有 ${openDrifts.length} 个未处理 drift：${openDrifts.map(d => d.cause).join(", ")}`
    };
  }
}
```

### 10.3 5 条 drift 路径

| 路径 | 触发 | 上游变化 | 下游影响 |
|---|---|---|---|
| **① feature unlock → slice drift** | `cw feature unlock` | feature.lockVersion++，status: locked→reviewing | 所有 slice.derivedFromId=feature → append driftLog（cause: feature-unlock）|
| **② feature supersede → slice + ADR** | `cw feature supersede` | old.status→deprecated，supersededBy=new | 所有 slice → drift（cause: feature-superseded）|
| **③ ADR supersede → 全局扫描** | `cw adr supersede` | old ADR→deprecated | 所有引用该 ADR 的 WorkUnit → drift（cause: adr-superseded），**不阻塞 closeout**（ADR 是参考性）|
| **④ research invalidate → 决策项 stale** | `cw research invalidate` | finding→superseded | 所有 related 决策项 → reopen（status: resolved→open，append 事件）|
| **⑤ epic collapse 后发现新 fog** | 不 reopen | （不触发 drift）| 新建 epic（--inherits-decisions-from old），old 保持 collapsed |

**路径 ⑤ 的特殊处理**：epic collapsed 是真终态，不进 drift 路径。发现新 fog = destination redraw = 新 epic。新 epic 可继承 old epic 的 Decisions 作为初始 charting。

### 10.4 drift 处理 action

下游 WorkUnit 遇到 drift（driftLog 有 open 事件）时，agent 选三个 action：

```
acknowledge-drift <unit> --reason "..."
  → 把某条 open 事件标 acknowledged（agent 决定不跟随上游）
  → retrospect 必须记录该决策

rebase-on-upstream <unit>
  → 把某条 open 事件标 rebased（agent 跟随上游变化）
  → 受 freeze gate 保护（不删 committed wave）
  → 新 AC append 为新 wave，旧 committed wave 不删

abort <unit>
  → 放弃整个 WorkUnit（→ abandoned）
```

**drift action 走子状态机**（driftConfig.transitions），不进 WorkUnit 主 transitions：
- drift action 改的是 driftLog[i].status，不改 WorkUnit.status
- 主状态机描述业务进度（created→...→closed），drift 子状态机描述对齐状态（open→acknowledged/rebased）
- engine 主 dispatch 前分流：drift action 走 dispatchDrift，主 action 走 dispatch

**DriftSpec 接口扩展**（scope-config.ts）：

```typescript
export interface DriftSpec {
  upstreamScope: string;
  triggerEvents: readonly string[];
  blockingActions: readonly string[];
  transitions: Record<string, DriftTransitionRule>;   // drift 子状态机
}

export interface DriftTransitionRule {
  expectedStatuses: readonly DriftEventStatus[];   // ["open" | "acknowledged" | "rebased"]
  nextStatus: DriftEventStatus;
  requiresReason?: boolean;   // acknowledge 类必填
  gateIds?: readonly string[];  // rebase 类要过的 freeze gate
}
```

**drift transitions 表**（所有启用了 driftConfig 的 scope 共享）：

| drift action | expectedStatuses | nextStatus | gate | 说明 |
|---|---|---|---|---|
| `mark-drifted` | [open, acknowledged, rebased] | open | — | engine 内部触发（drift propagation），新 cause 覆盖旧 acknowledged |
| `acknowledge-drift` | [open] | acknowledged | requiresReason | agent 决定不跟随上游，进 retrospect |
| `rebase-on-upstream` | [open] | rebased | no-committed-wave-deleted | agent 跟随上游，受 freeze 保护 |

**dispatchDrift 分流实现**（state-machine.ts dispatch 主流程前置）：

```typescript
dispatch(unit, action, params, options?) {
  // 0. drift action 分流
  if (this.config.driftConfig?.transitions[action]) {
    return this.dispatchDrift(unit, action, params);
  }
  // 1-5. 原 5 步主流程（guard / gate / freeze / computeNextStatus / applyProducts）
  ...
}

// dispatchDrift：guard（用 driftLog 最新事件的 status 校验）→ gate（rebase 过 freeze）
//   → reason 校验（acknowledge 必填）→ 更新 driftLog[i].status（顶级字段，不触发 closeout freeze）
```

### 10.5 supersede（ADR / feature）

supersede 是「整体替换」语义，与 drift 不同：

| | drift | supersede |
|---|---|---|
| 触发 | 上游变化 | 主动替换 |
| 下游状态 | 标 drifted（可恢复）| 标 deprecated（真终态）|
| 数据 | 不删，append driftLog | 不删，append supersededBy 指针 |

**ADR supersede**：
- old ADR → deprecated + supersededBy 指向 new ADR
- 所有引用 old 的 WorkUnit → drift（cause: adr-superseded），**不阻塞**（ADR 是参考性）

**feature supersede**：
- old feature → deprecated + supersededBy 指向 new feature
- 所有派生 slice → drift（cause: feature-superseded），**阻塞 closeout**

### 10.6 边界场景

实施时必踩的坑，提前列明处理方式。

**场景 ①：wave committed 后 slice replan**

触发：slice=developed，wave1 committed。agent 发现 wave1 技术方案错了。约束：wave1 committed 后 FreezeRule 锁死 commitHash/changes/dependsOn。

处理：走 §7.5 的 wave 弃用机制——new plan 把 wave1 标 deprecated + supersededBy=wave3，追加 wave3。checkFreeze 放行 validity 变化（白名单外），保护 commitHash/changes/dependsOn（白名单内）。

**场景 ②：feature unlock 后下游 slice 处于不同状态**

触发：`cw feature unlock`。下游 slice 状态分布：

| slice 状态 | 处理 |
|---|---|
| created（未开始）| 标 drifted，建议直接 abort + 重建（最干净）|
| developed（进行中）| 标 drifted，closeout gate 阻塞。agent 选 acknowledge / rebase / abort |
| closed（已完成）| 仍 append driftLog（cause: feature-unlock-after-close），**不阻塞**（closeout gate 已过）。retrospectData 不动（已 freeze），drift 标记只记在 driftLog |

**场景 ③：claim TTL 过期但 agent 还在跑**

触发：agent-A claim 了 WorkUnit，但 heartbeat 卡死超过 stale-threshold。agent-B 尝试 claim 同一 WorkUnit。

处理：agent-B 读 lock 文件发现过期 → 执行 stale 清理（写 tombstone + WorkUnit.claimedBy=null）→ 走正常 claim 协议获得 WorkUnit。agent-A 完成后调 resolve → engine 检查 claimedBy ≠ agent-A → 拒绝，返回"claim 已 stale，被 agent-B 接管"。

**场景 ④：parent WorkUnit abort 后的 child 处理**

触发：slice abort，但有未完成的 child wave。处理：slice.status→aborted → engine 扫描 childUnitIds，对所有未 terminal 的 wave：wave.status→aborted（级联）→ wave.statusHistory append 级联事件。不删数据（保留可查）。

**场景 ⑤：跨层 drift 的多跳传播**

触发：epic "reopen"（实际建新 epic，见 §10.3 路径⑤）。影响链：epic → feature → slice（3 跳）。

设计选择：**不做实时链式传播**，每层只管直接下游。epic 建新 epic 只标 feature（warning，不阻塞）；如果 feature 因此 unlock，才触发 slice drift（走路径①）。drift 传播靠「上游 action 触发 + 下游下次访问时检查」，不主动 push 到所有间接下游。

**场景 ⑥：glossary 循环依赖**

触发：term-A 定义引用 term-B，term-B 定义引用 term-A。处理：`cw glossary add` 时做 DFS 循环检测，发现循环 → 拒绝，报告 "circular definition: A → B → A"。

---

## 11. 命名方案（方向 A：中英混合）

### 11.1 命名原则

1. **层名用业界通用英文**（epic / feature / slice / wave），开发者零学习成本
2. **层内角色用精确中文复合词**（决策项 / 认领 / 显化），消除歧义
3. **规划层的「决策项」和执行层的「slice / wave」从命名上显式区分**（matt 最大坑：ticket 指两样东西）
4. **不直译 RTS 游戏隐喻**（map / fog / frontier 在中文软件语境不连贯）

### 11.2 完整词表

#### WorkUnit scope（4 个，英文业界通用）

| 1.0 命名 | matt 原词 | 本质职责 |
|---|---|---|
| **epic** | effort | 跨多 feature 大工作的决策收敛 |
| **feature** | spec (PRD) | 单 feature 的需求收敛 |
| **slice** | ticket (implementation) | 单 session 可完成的执行切片 |
| **wave** | —（cw 0.x 发明）| 最小执行单元，实际开发单元 |

#### 决策项与决策相关

| 1.0 命名 | matt 原词 | 本质职责 |
|---|---|---|
| **决策项** | decision ticket | WorkUnit clarify 阶段的问题-答案记录 |
| **决策总览** | map | epic 的低分辨率索引（charting 产物）|
| **目标** | destination | WorkUnit 完成时世界长什么样 |
| **待澄清项** | fog of war | 感知到但说不清的将来问题 |
| **可认领项** | frontier | 当前 open ∧ unblocked ∧ unclaimed 的决策项集合 |
| **显化** | graduate | 待澄清项 → 决策项 |
| **范围外** | out of scope | 主动判定不属于本次的工作 |

#### 动作

| 1.0 命名 | matt 原词 | 本质职责 |
|---|---|---|
| **collapse** | collapse | epic 决策完成 → 产 N 个 feature |
| **split** | split | feature → 产 N 个 slice |
| **plan** | —（cw 0.x）| slice → 产 N 个 wave |
| **认领 / 认领方** | claim / claimer | 占有声明 / 占有者身份 |
| **chart** | chart the map | epic 首次创建决策总览 + 初始决策项 |

#### 决策项 type（4 种求解模式）

| 1.0 命名 | matt 原词 | 怎么得答案 |
|---|---|---|
| **research** | research | 查外部权威 |
| **prototype** | prototype | 做粗糙实物 |
| **grilling** | grilling | 一问一答逼问 |
| **task** | task | 纯体力活 |

#### 横向服务（3 个）

| 1.0 命名 | 本质职责 |
|---|---|
| **research** | 外部真相查询（cited sources）|
| **glossary** | 术语定义查询 / 写入 |
| **ADR** | 沉淀架构决策记录 |

### 11.3 命名统计

- 4 个 WorkUnit scope（英文业界通用）
- 7 个决策相关角色词（中文精确复合词）
- 5 个动作词（英文为主）
- 4 个决策项 type（保留 matt 英文）
- 3 个服务（英文业界通用）

**总计约 23 个核心词**，远少于 matt 原典的词汇量。

---

## 12. 与 cw 0.x 的对照

### 12.1 概念映射

| cw 0.x | cw 1.0 | 变化 |
|---|---|---|
| topic | slice | 重命名（语义不变）|
| wave（topic 内嵌字段）| wave（独立 WorkUnit）| 升级为完整 WorkUnit，有自己的 clarify / plan / dev |
| clarifyRecord | 决策项 | 概念统一（任何 WorkUnit clarify 都产生）|
| TaskShape | ScopeConfig | 模式扩展（从 slice 专属到所有 scope）|
| TRANSITIONS | ScopeConfig.transitions | 配置平移 |
| checkLinear | UnitStateMachine.guard() | 算法平移，参数化 S/A |
| validateAppendOnly | FreezeRule + checkFreeze | 硬编码 → 声明表 |
| gateHistory（散落）| GateRunner 统一 append | 集中化 |
| —（无）| epic / feature | 新增（补齐规划层）|
| —（无）| drift 机制 | 新增（跨层一致性）|
| —（无）| claim 通用机制 | 新增（从 epic 专属升级为通用）|

### 12.2 迁移路径（5 阶段）

| 阶段 | 范围 | 工程量 |
|---|---|---|
| **M1** | 接入真实 store + gate（CwStoreAdapter + 迁移 gate.ts 为 GateSpec）| 中 |
| **M2** | 完整迁移 slice（19 action / 12 status 完整配置化 + wave 升级为 WorkUnit + 迁移测试基线）| 大 |
| **M3** | 实现 feature ScopeConfig（draft / review / lock / split / archive + unlock / re-split / supersede + lock gate 三件套）| 大 |
| **M4** | 实现 epic ScopeConfig（charting / collapse + 决策项 4 种 type + claim 子系统）。**需先补 claim 协议细节**：TTL（默认 1h）/ heartbeat 间隔（默认 5min）/ stale-threshold / O_EXCL 原子创建 / NFS 双写处理（开放问题 §13.1）| 大（claim 复杂度高）|
| **M5** | 跨层 drift + 影响传播（5 条 drift 路径 + drift 子状态机）| 中 |

每个阶段是独立 topic，按 plan.md 渐进交付。

---

## 13. 开放问题（实施前需确认）

> 设计本身未触及或未深入评估的问题，留待 M2-M5 实施前补设计。**本文档不编造方案**，只列问题 + 制约因素。

### 13.1 claim 双写在 NFS 上的原子性

**问题**：claim 用 `fs.openSync(path, 'wx')`（O_EXCL）保证原子性，但 NFS（尤其 NFSv3）的 O_EXCL 不保证跨 client 原子。`.cw/` 若在 NFS 上，两个 client 可能同时 claim 成功。

**制约**：cw 定位纯本地（PRODUCT.md:51），但团队协作可能共享 NFS。

**可能方案**：NFSv3+ 用 `link()` 替代；用 `.lock` 目录替代文件（`mkdir` 在 NFS 上原子）；引入中心协调服务（违反纯本地）。

**何时补**：M4 实施 claim 前。若确认无 NFS 场景，标 wontfix。

### 13.2 FR-AC 覆盖率的具体匹配算法

**问题**：feature lock gate 的 `fr-ac-coverage` 写了「每个 FR 都要有对应 AC」，但 FR 和 AC 如何关联未明。

**制约**：cw 0.x 的 checkFrCoverage 用宽松子串匹配（仅 warning），1.0 要硬阻断必须更可靠。

**可能方案**：强引用（FR 字段含 `ac: ["AC1","AC2"]`，§7.3 SpecSection schema 倾向此）；弱引用（AC 字段含 `fr: "FR1"`）；自然语言匹配（违反机器验证原则，排除）。

**何时补**：M3 实施 feature lock gate 前。

### 13.3 slice replan 的差异算法

**问题**：§10.6 场景① 说了「保留 wave1 + 标 deprecated + 追加 wave3」，但「agent 怎么知道要追加 wave3 而不是改 wave2」未设计。replan 的差异计算（old plan vs new plan）算法没有。

**制约**：cw 0.x 的 replan 是 agent 提供 new plan，engine 只做 append-only 校验，不算 diff。

**可能方案**：沿用 cw 0.x（agent 负责 diff，engine 只校验 freeze）；加 planDiff（engine 自动对比，生成 reconciliation 报告）；半自动（engine 算 diff 但只 warn）。

**何时补**：M2 完整迁移 slice replan 时。

### 13.4 多 worktree 并行的冲突协调

**问题**：决策 4 提到 worktree 工作模式，但「两个 slice 改了同一文件怎么办」未设计。

**制约**：cw 边界是「不做代码仓库管理」（PRODUCT.md:52），merge 冲突是 git 层问题。

**可能方案**：完全不管（保持边界，guidance 提示风险）；feature split 时检测 slice 间文件冲突（静态分析）；worktree 分配时强制不同 slice 用不同文件集。

**何时补**：M3 实施 feature split 时。

### 13.5 决策项 type 的具体子流程差异

**问题**：§6.3 列了 4 种 type，但每个 type 的「具体子流程差异」只有 matt 原文描述。prototype/task 触发的临时 wave 生命周期如何管理（throwaway、不进交付链、完成后标 deprecated）未细化。

**何时补**：M4 实施 epic charting + 决策项时。

### 13.6 术语提取的漏列 fallback 策略

**问题**：决策 6 确定 SpecSection.terms 显式声明。但作者漏列术语时（漏列 = 绕过 gate = 未定义术语漏检），fallback 策略未定。

**可能方案**：硬阻断（强制完整声明）；warning（漏列不阻断，但 retrospect 标注）；混合（core terms 硬阻断，optional terms warning）。

**何时补**：M3 实施 feature lock gate 前，和真实 spec 写作流程验证。

---

## 附录 A：12 条领域不变量的机器化映射

| 不变量 | 机器化机制 |
|---|---|
| 1. 目标锚定 | WorkUnit create 时必填 destination / objective |
| 2. 粒度匹配上下文 | scope 配置（epic / feature / slice / wave 粒度递减）|
| 3. 产出形态分层 | scope 配置（epic 产决策，slice / wave 产代码）|
| 4. 依赖 DAG + 动态浮现 | 决策项 blocking + 显化 action |
| 5. 可执行边沿 | frontier query（open ∧ unblocked ∧ unclaimed）|
| 6. 显式不确定性 | epic 的待澄清项 collection + 显化 action |
| 7. 显式 scope 边界 | 范围外 collection（独立于决策项）|
| 8. HITL 边界 | 决策项 type（grilling 必须真人）|
| 9. 并发互斥 + 上下文边界 | claim 机制 + one-per-session 配置 |
| 10. 移交而非执行 | epic 的 collapse（产 feature，不产代码）|
| 11. 机器证据优先 | gate（git hash / exit code / judgeByExpected）|
| 12. append-only 历史 | FreezeRule + driftLog append + supersede 不删 |

---

## 附录 B：关键文件索引

| 内容 | 路径 |
|---|---|
| 本设计文档（v2）| `.xyz-harness/cw-1-0-lifecycle-redesign/design-v2.md` |
| 上一版设计（v1，已被取代）| `.xyz-harness/cw-1-0-lifecycle-redesign/design.md` |
| 产品级 plan | `.xyz-harness/cw-1-0-lifecycle-redesign/plan.md` |
| 引擎级 engine-design | `docs/engine-design.md` |
| 通用引擎源码（原型）| `src/engine/` |
| cw 0.x 现有实现（迁移参考）| `src/state-machine.ts` / `src/actions.ts` / `src/shapes/` / `src/store.ts` |
| mattpocock 原典（领域来源）| `~/GitApp/ai-skills/mattpocock-skills/` |

---

## 附录 C：matt 原典机制的完整机器化映射

§6.6 列了 12 条领域不变量。这里补充 matt 原典里**未进入不变量列表但值得机器化**的三个辅助机制：

### C.1 Refer by name（按名引用）

**matt 原文**：所有给人读的文字（narration、Decisions so far），用决策项的 title 引用，id/URL 包在 link 里，绝不裸用 id。

**解决的人类痛点**：`#42, #43, #44` 一长串 ID 让人无法判断相关性。协作场景下每次提到一张决策项都要点开看才知道是啥，沟通效率崩溃。

**1.0 机器化**：所有 guidance 文本里引用决策项 / WorkUnit 时，用 title + link（id 包在 link），不裸用 id。这是 guidance 文本生成的约定，写进 `src/prompts/`。

### C.2 No-fog early exit（无 fog 早退）

**matt 原文**：charting 时如果 breadth-first grilling 没浮现 fog → 整个工作小到不需要 epic，强行建 epic 是浪费。停下，告诉用户「journey 够小，直接走主流程」。

**解决的人类痛点**：过度工程。小工作套大流程是负担。

**1.0 机器化**：epic create 后 charting 阶段如果初始 fog 为空 + 无决策项 → guidance 提示「工作够小，建议直接 `cw feature draft`」，不强制走 epic 全流程。可由 agent 自行判断是否 collapse。

### C.3 Handoff（跨 session 上下文延续）

**matt 原文**：session A 满了或要切到 prototype，把当前对话 compact 成 handoff.md，新 session 读它继续（fork，不是 continue）。

**与 epic 的关系**：
- epic 是「跨 session 共享的**结构化决策状态**」
- handoff 是「跨 session 共享的**非结构化对话状态**」
- 两者解决同一个根问题（session 边界）的不同侧面

**1.0 定位**：handoff 是**agent harness 的职责**（不是 cw 的）。cw 只管结构化状态（WorkUnit + 决策项），不管对话状态。PRODUCT.md 非目标「不做 agent harness 集成」决定了 handoff 不进 cw。但 guidance 可以提示 agent「session 快满时，调 harness 的 compact/handoff 能力」。

**注**：这三个机制里，C.1 和 C.2 是 cw 可以机器化的（guidance 约定 + 早退判断），C.3 明确不进 cw（边界外）。

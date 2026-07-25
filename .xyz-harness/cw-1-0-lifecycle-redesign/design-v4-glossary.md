# cw 1.0 设计文档 v4 · 概念表

> 本文是 cw 1.0 v4 设计的**概念索引**。设计散落在 5 份文档（guide / epic / feature / slice / wave）里，这份文档把**核心概念**集中定义在一处，方便查词。
>
> **范围说明**：本文只讲**概念**（名词性的定义单位：WorkUnit、scope、action、status、字段名），不讲**原则**（「学一层会四层」「execute 是分水岭」这些为什么这么设计的话，属于设计哲学，在 guide §3）。本文也不展开各层 plan 的**内部条目**（feature 的 FR/AC/UC、slice 的 TC/IF/DM/ERR、wave 的 TestCase），那是 plan 的内部结构，见各层文档。
>
> **来源文档缩写**：
> - `guide` = design-v4-guide.md（设计哲学 + 黑名单 + 词汇规范）
> - `epic` = design-v4-epic.md（机制权威源）
> - `feature` = design-v4-feature.md
> - `slice` = design-v4-slice.md
> - `wave` = design-v4-wave.md

---

## 开头总览

**cw 是什么**：cw 是一个 agent-agnostic 的编码流程编排 CLI。它把一件开发工作拆成 4 层（epic/feature/slice/wave），每层走完全相同的 8 步流程（create → clarify → plan → verify → execute → test → retrospect → closeout），靠状态机 + 机器 gate 约束 agent 一步步走完，保证开发过程不会跳步、不留半成品。

**cw 的核心机制有三块**：一是**分层**——4 层逐层精化，每层把自己的方案想清楚再交给下一层；二是**8 步流程**——每层都走相同的 8 步，差异只在每步内容；三是 **replan**——当上游的方案变了，cw 能把影响传给下游，强制下游处理完才能继续。

**这份文档怎么读**：第一部分讲 cw 的基本结构（WorkUnit + 4 层 + 8 步），第二部分讲状态机（9 状态 + 11 action），第三部分讲 replan 机制（最复杂的部分，单独成章），第四部分是用词规则（只允许用词表内已有的概念），第五部分诚实列未定义的 TODO 项，末尾是字母索引方便查词。每部分先叙述讲清概念和关系，再列表格供查询。

---

## 第一部分：cw 的基本结构

### 1.1 WorkUnit：cw 管理的核心实体

cw 管理的每一件开发工作都叫一个 **WorkUnit**（工作单元）。WorkUnit 是 cw 的核心实体，cw 的所有操作——建实例、推进状态、记录方案、跑测试——都围绕 WorkUnit 展开。在实现上，一个 WorkUnit 是 cw store 里的一条记录，有自己的 id、status、目标、方案、生命周期字段。

cw 有 4 种具体的 WorkUnit 类型：**epic、feature、slice、wave**。它们共享同一套流程结构（8 步、9 状态、同样的字段体系），只是粒度和每步内容不同。下文提到 WorkUnit 时，泛指这 4 种类型中的任意一个。

WorkUnit 是**有状态、有生命周期**的实体：从 `created` 开始，一步步推进到 `closed`（或 `aborted`），中间走过的每一步都被记录下来。它不是一份静态文档，而是一个有节奏的开发过程实例。

### 1.2 scope：4 个层

cw 把工作分成 **4 个层**（scope）。层的概念回答「我现在在哪一层」——使用者在操作 cw 时，脑子里始终要先定位自己在 4 层的哪一层。4 层逐层精化：上层做方向性决策，下层做更细的方案，直到 wave 层写代码。

为什么是 4 层不是 3 层或 5 层：经验上的自然粒度。epic 跨多个 session、feature 单特性、slice 单 session 可完成、wave 单次提交可完成。少一层粒度太粗回到「砸给 agent」，多一层过度工程。

**4 层对照（名词表）**：

| 层（scope）| 什么意思 | execute 这步做什么 | 写不写代码 | 粒度（软锚点）| 来源 |
|---|---|---|---|---|---|
| **epic** | 大目标，跨多 session 才能做完 | 启动 feature 层（递归）| 否 | 跨多 session | guide §5.1；epic §1 |
| **feature** | 单个用户可感知的独立特性 | 启动 slice 层（递归）| 否 | 单特性 | feature §1 |
| **slice** | 单 session 可完成的技术实施单元 | 启动 wave 层（递归）| 否 | 单 session 可完成（典型 2-4h）| slice §1 |
| **wave** | 单次提交可完成的执行单元 | **dev 写代码**（递归出口）| **是（唯一）** | 单次提交可完成（典型 30min-2h）| wave §1 |

4 层按 **execute 做什么**分成两类（设计意图见 guide §3.2「execute 是分水岭」）：

| 层类型（scope type）| 哪些层 | execute 干什么 |
|---|---|---|
| **协调型层**（coordinating scope）| epic / feature / slice | 启动下一层（递归），自己不写代码 |
| **执行型层**（executing scope）| wave | dev 写代码，是整个 cw 唯一写代码的层 |

### 1.3 step：8 步流程

每层 WorkUnit 都走**完全相同的 8 步**（step）。8 步对应开发者做一件事的自然节奏：想清楚要做什么 → 澄清模糊点 → 定方案 → 审方案 → 执行 → 验结果 → 复盘 → 收尾。差异只在每步的具体内容（epic 的 plan 是拆 feature，wave 的 plan 是写测试），流程结构完全一致——这是「学一层会四层」的前提（原则见 guide §3.1）。

**8 步产物名（名词表）**：

| 步骤（step）| 产物字段名 | 是什么 | 干什么用 | 类型 | 来源 |
|---|---|---|---|---|---|
| **create** | `objective` | 这个 WorkUnit 完成后世界长什么样的描述（1-2 句话）| 锚定目标，后续所有步骤都对齐它 | string | 所有层状态机（epic §5.1）|
| **clarify** | `clarifications` | 澄清项列表 | 把推进 WorkUnit 必须先回答的问题逐个澄清，决策落档防遗忘、防歧义 | Clarification[]（各层共享）| 所有层状态机（epic §5.2）|
| **plan** | `plan` | 规划产物 | 定方案（含拆到下一层的清单，作为内部字段）| 结构因层而异（见各层文档）| 所有层状态机（epic §5.3）|
| **verify** | `verifyJudgment` | 执行前的业务判断 | 在执行前强迫 agent 想清楚方案值不值得做、做得对不对（necessity / sufficiency / alternatives / tradeoffs / risks 五维度）| VerifyJudgment（各层共享核心字段）| 所有层状态机（epic §5.4）|
| **execute** | （无独立产物）| 执行这一步本身 | 协调型层启动下一层，wave 落地为 dev 写代码 | — | 所有层状态机（epic §5.5）|
| **test** | `testJudgment` | 执行后的对照验收 | 逐条对照 verifyJudgment 验收实际结果（wave 层是跑测试，机器验证）| TestJudgment（各层共享核心字段）| 所有层状态机（epic §5.6）|
| **retrospect** | `retrospectData` | 复盘数据 | 对照 verifyJudgment 看哪些判断事后错了，提炼经验 | RetrospectData（各层共享核心字段）| 所有层状态机（epic §5.7）|
| **closeout** | `evidence` | 交付证据 | 收尾归档（最终交付清单 + 经验沉淀）| Evidence | 所有层状态机（epic §5.8）|

**`plan` 这个词在文档里有 3 个容易混淆的含义**，看上下文区分：
1. **plan 步骤** = 8 步里的第 3 步（一个 action）
2. **plan 产物** = plan 步骤填的字段（`plan`），结构因层而异
3. **plan 项** = plan 产物里的具体条目（如 feature 的 FR/AC/UC、slice 的 TC/IF/DM/ERR、wave 的 TestCase）

plan 产物的内部结构因层而异，由各层文档定义，不在本文展开。本文只讲 `plan` 这个字段名和它作为 step 的含义。

**plan 内部条目的命名规则**（跨层统一，避免类型重名）：

| 规则 | 说明 |
|---|---|
| **类型名带层前缀全称** | slice / wave 的 plan 内部条目类型名带层前缀（`SliceTechChoice` / `WaveTestCase`），避免跨层类型重名（slice 的 `TechChoice` 和 wave 的 `TestCase` 都简称 TC，但全称各自独立）|
| **字段名不带层前缀** | plan 内部字段名不带层前缀（`techChoices` / `testCases`），靠所在的 Plan 类型判别语义——`slicePlan.techChoices` 和 `wavePlan.testCases` 各自归属清楚，字段名本身不必再标层 |
| **Plan 是基类** | 所有层 plan 都继承同一个 `Plan` 基类（核心字段 `split: Split[]`——拆到下一层的清单，作为 plan 的内部字段）。`SlicePlan` / `WavePlan` 扩展各自字段（slice 加 techChoices/interfaces/dataModels/errorSpecs/decisions；wave 加 testCases/tasks/files/contracts，继承的 split 字段冗余但保留换取 WorkUnit.plan 结构全兼容），epic / feature 直接用基类即可。|

### 1.4 WorkUnit 的通用字段

所有层的 WorkUnit 都有下面这些字段（除叶子 wave 没有 `childUnitIds`、顶层 epic 没有 `parentUnitId`）。

**通用字段（名词表）**：

| 字段名 | 是什么 | 干什么用 | 来源 |
|---|---|---|---|
| **id** | WorkUnit 的唯一标识（如 `epic:auth-refactor`）| 命令调用的定位符 | 所有层附录（epic §5.1）|
| **scope** | 这是什么类型的 WorkUnit（`"epic"` / `"feature"` / `"slice"` / `"wave"`）| 区分 4 层，决定 8 步每步内容 | 所有层状态机（guide §5.1）|
| **slug** | 人类可读的短名（如 `auth-refactor`）| id 的可读部分 | 所有层附录（epic §5.1）|
| **status** | 当前所处的状态（9 状态之一，见第二部分）| 控制流程推进的节奏 | 所有层状态机 |
| **statusHistory** | 状态变更历史（每次 status 变更记录，append-only，只追加不删）| 追溯 WorkUnit 怎么走到现在 | 所有层附录 |
| **objective** | create 步骤填的目标描述 | 见 §1.3 | 所有层状态机（epic §5.1）|
| **clarifications** | clarify 步骤填的澄清项列表 | 见 §1.3（**形态不对称**：epic/slice/wave 是 `clarifications: Clarification[]` 数组；feature 是容器对象 `clarification: { clarifications, spec }`，因为 feature 带 spec 子结构。读取时 feature 走 `workUnit.clarification.clarifications`，其他层走 `workUnit.clarifications`）| 所有层状态机（epic §5.2）|
| **plan** | plan 步骤填的方案产物（结构因层而异）| 见 §1.3 | 所有层状态机（epic §5.3）|
| **verifyJudgment** | verify 步骤填的业务判断 | 见 §1.3 | 所有层状态机（epic §5.4）|
| **testJudgment** | test 步骤填的对照验收 | 见 §1.3 | 所有层状态机（epic §5.6）|
| **retrospectData** | retrospect 步骤填的复盘数据 | 见 §1.3 | 所有层状态机（epic §5.7）|
| **evidence** | closeout 步骤填的交付证据 | 见 §1.3 | 所有层状态机（epic §5.8）|
| **parentUnitId** | 父层 WorkUnit 的 id | 表达父子关系。epic 无此字段（顶层）| feature / slice / wave 附录 |
| **childUnitIds** | 子层 WorkUnit 的 id 列表 | execute 步骤填。epic 存 feature ids、feature 存 slice ids、slice 存 wave ids；wave 无此字段（叶子）| 所有层状态机（epic §5.5）|
| **basedOnParent** | replan 机制的核心字段（下游引用父层 plan 的哪些项）| replan 查影响面的基础，详见 §3.3 | guide §8.1；epic §7.3 |
| **abandonedRefs** | replan 机制的核心字段（被上游废弃的引用及处理状态）| replan 的核心跟踪字段，详见 §3.3 | guide §8.1；epic §7.3 |

---

## 第二部分：状态机

### 2.1 一个 WorkUnit 的一生

一个 WorkUnit 从 `cw <scope> create` 开始，进入 `created` 状态，然后一步步推进：`clarifying` → `planning` → `verified` → `executing` → `tested` → `retrospected` → `closed`。任何时刻都可以 `abort` 整个不要了（进 `aborted`）。这两个终态（`closed` / `aborted`）一旦到达就不可逆。

主流程之外还有 3 个旁路 action：`replan`（上游改方案后局部打补丁 + 标下游影响面）、`accept-replan`（下游接受上游变更解锁）、`abort`（整个 WorkUnit 不要了）。`replan` 和 `accept-replan` 不改 status（原地不动，只加记录），这是 replan 机制的关键设计，详见第三部分。

**几个关键节奏**：`clarify` / `plan` / `verify` 是 progressive（可多次调用，每次追加新内容不覆盖）；`execute` 是长状态（协调型层等子层完成、wave 等 dev 写代码，可能跨多 session）；`test` / `retrospect` / `closeout` 是一次性。

### 2.2 9 个状态

**9 状态（名词表）**：

| 状态（status）| 是什么 | 来源 |
|---|---|---|
| `created` | create 后、进入活跃工作前的初始状态 | 所有层状态机 |
| `clarifying` | clarify 步骤中（progressive，可多次调）| 所有层状态机 |
| `planning` | plan 步骤中（progressive）| 所有层状态机 |
| `verified` | plan 已审查通过，execute 前的等待状态 | 所有层状态机 |
| `executing` | execute 中——协调型层等子层完成，wave 等 dev 写代码 + commit | 所有层状态机 |
| `tested` | test 已完成 | 所有层状态机 |
| `retrospected` | retrospect 已完成 | 所有层状态机 |
| `closed` | closeout 完成，**真终态不可逆** | 所有层状态机 |
| `aborted` | abort 后，**真终态不可逆** | 所有层状态机 |

### 2.3 11 个 action

cw 的命令分两类：**主流程 action**（8 个，正向推进状态）和**旁路 action**（3 个，逆向调整）。action 名是 cw 命令名，保持小写英文不翻译（命令直接在 shell 里敲）。

**11 action（命令表）**：

| 类别 | action 命令 | 做什么 | status 变化 | 来源 |
|---|---|---|---|---|
| **主流程** | `create` | 建实例，填 objective | → `created` | guide §5.2 |
| | `clarify` | 澄清（progressive）| → `clarifying` | guide §5.2 |
| | `plan` | 规划 + 拆下一层（progressive）| → `planning` | guide §5.2 |
| | `verify` | 执行前审查（progressive）| → `verified` | guide §5.2 |
| | `execute` | 执行（协调型=启动下层，wave=dev 写代码）| → `executing` | guide §5.2 |
| | `test` | 执行后对照验收（wave 层跑测试）| → `tested` | guide §5.2 |
| | `retrospect` | 复盘（一次性）| → `retrospected` | guide §5.2 |
| | `closeout` | 收尾归档（一次性，不可逆）| → `closed` | guide §5.2 |
| **旁路** | `replan` | 上游改 plan 项 → 作废旧项 + 标下游影响面（详见第三部分）| **不改 status**（原地不动，只加记录）| guide §6；epic §8.2 |
| | `accept-replan` | 下游接受上游变更（解锁）| **不改 status**（在 abandonedRefs 追加 resolvedAt）| guide §6；epic §8.2 |
| | `abort` | 整个 WorkUnit 不要了（连带销毁所有非终态子孙）| → `aborted` | guide §6；epic §8.2 |

另有一类**只读查询命令**：`status` / `list` / `show`。它们不走状态机（不触发状态变更、不写 statusHistory），只返回 WorkUnit 快照供 agent 快速了解「当前在哪」。

---

## 第三部分：replan 机制

replan 是 cw 最复杂的机制，单独成章。这一部分先讲 replan 是干嘛的、怎么走的（叙述），再详细列关键字段（表格），最后讲配套的两个 action。

### 3.1 为什么需要 replan

开发过程中常常出现这种事：上游已经定稿的方案，下游正在基于它干活，结果发现方案要改。典型场景——feature-B 开发到一半，发现 epic 之前定的 D2「用 OAuth」不对，要换自研。这时 epic 不能简单地把 D2 删掉改掉（下游 feature-B 还基于旧 D2 干活呢），也不能假装没事（feature-B 会基于错误前提继续跑）。

replan 解决的就是这个问题：**让上游能改方案，同时把这个改动的影响传给下游，强制下游处理完才能继续**。机制的核心是 append-only 历史（不删旧数据，只加标记）+ 强制处理（下游被阻塞，必须 accept 或 abort）。

### 3.2 replan 的 4 步流程

上游调 `cw <scope> replan` 时，cw 做 4 件事（**全程不改 status，只加记录**）：

1. **作废指定的 plan 项**：旧项的 `status` 改成 `abandoned`，`replacedBy` 指向新版本（如 D2 → D2-v2）。旧项不删，只加标记（append-only）。
2. **新增新版本**（如有）：如果 replan 的输入里指定了新内容，cw 自动生成新 id 追加为新版本。如果没指定新内容 = **纯撤销**（只作废不替换）。
3. **反查影响面 + 在下游追加记录**：cw 遍历子树里所有 WorkUnit 的 `basedOnParent`，对每个 id 沿 `replacedBy` 链查询，找出「引用了被废弃项」的下游（只查未 closeout 的），在它们的 `abandonedRefs` 追加一条**未处理记录**。cw 只追加记录，不重写 `basedOnParent`（保历史）。
4. **强制处理**：`abandonedRefs` 有未处理记录的下游被**阻塞所有改状态 action**（clarify/plan/verify/execute/test/retrospect/closeout 都调不了），只能调查询命令或处理阻塞本身。强制二选一：accept-replan（接受新版本 / 确认不再依赖）或 abort（整个不要了）。

### 3.3 replan 的两个关键字段

replan 机制完全靠这两个字段运转，详细列在下面。

**replan 核心字段（名词表）**：

| 字段名 | 是什么 | 干什么用 | 实现上对应 | 来源 |
|---|---|---|---|---|
| **下游引用父层项**（`basedOnParent`）| 这个 WorkUnit 引用了父层 plan 的哪些项（`string[]`，id 列表）| replan 反查影响面的基础——cw 遍历下游 basedOnParent 找出谁引用了被废弃项。append-only 历史记录，下游当初基于哪个版本就记哪个版本，**永不重写**。具体每层继承什么见各层文档（feature 继承 epic 的 Clarification id；slice 多继承 FR/AC/UC id；wave 多继承 TC/IF/DM/ERR id）| `string[]` | guide §8.1；epic §7.3 |
| **废弃引用及处理状态**（`abandonedRefs`）| 这个 WorkUnit 被上游废弃了哪些引用、各自处理了没（结构化数组，**不是 boolean**）。每条记录含 4 个子字段：`refId`（被废弃的父层 plan 项 id，如 `"D2"`）、`refKind`（废弃类型，影响 guidance 提示，见 §3.4，取值 `"clarification"` / `"specItem"` / `"techItem"`）、`resolvedAt`（何时处理，**空 = 未处理、阻塞中**；非空 = 已解锁）、`resolvedAction`（怎么处理的，`"accept"` 或 `"abort"`）。**空数组 = 不阻塞**。只对未 closeout 的下游有意义（阻塞用）| `AbandonedRef[]` | guide §8.1；epic §7.3 |

派生值 `basedOnAbandoned`（「是否阻塞中」）不是独立字段，而是 `abandonedRefs.some(r => !r.resolvedAt)`——只要有一条未处理记录就是阻塞中。之所以用结构化数组而非 boolean：boolean 表达不了「多个上游同时废弃、哪个处理了哪个没处理」，结构化数组能精确知道每条记录的状态。

plan 项还有两个标记字段：`status`（`"active"` / `"abandoned"`，废弃标记）和 `replacedBy`（指向替代它的新版本 id）。这两个是 plan 项的字段，不是 WorkUnit 的字段。多次 replan 时（如 D2 → D2-v2 → D2-v3），cw 沿 `replacedBy` 链查询找最新版本。

### 3.4 refKind 三值

`refKind` 是对 replan 输入里 `replacementContent.kind` 的粗分类（把具体的 kind 归成 3 大类）：`Clarification` → `clarification`、`FR/AC/UC` → `specItem`、`TC/IF/DM/ERR` → `techItem`。

**阻塞/解锁机制**：阻塞 = cw 不让这个 WorkUnit 调任何「改状态 action」，只能调查询或处理阻塞本身（accept-replan / abort）；解锁 = 阻塞解除，能正常推进。这个机制对 3 种 refKind 完全一样（都是 abandonedRefs 追加 → 阻塞 → accept/abort 解锁）。**refKind 不影响阻塞机制，只影响 guidance 对 agent 的提示文案**——不同 refKind 提示 agent 做不同性质的决策。

**refKind 三值（名词表）**：

| refKind 值 | 含义 | accept 时 guidance 提示 |
|---|---|---|
| `clarification` | 上游的某个澄清结论变了（如 epic 的 D2「用 OAuth」换成「自研」）| "这是上游的产品/架构决策变更，评估新结论对你下游的影响，接受或 abort" |
| `specItem` | 你负责的某个 spec 项（FR/AC/UC）被改/撤了（如 feature 的 FR1 换成 FR1-v2）| "这是你的工作范围变更——评估新 FR/AC 是否仍属你的职责，接受或 abort" |
| `techItem` | 你依赖的某个技术方案项（TC/IF/DM/ERR）被改/撤了（如 slice 的 IF1 签名变了）| "这是你的技术依赖变更——评估新接口/数据模型是否影响你的实现，接受或 abort" |

### 3.5 配套的两个 action

**配套 action（命令表）**：

| action 命令 | 谁调 | 做什么 | status 变化 | 来源 |
|---|---|---|---|---|
| `replan` | **上游**调 | 作废自己的 plan 项 + 标下游影响面（§3.2 的 4 步）| **不改 status** | epic §8.2 |
| `accept-replan` | **下游**调（被标了 abandonedRefs 的那个）| 接受上游变更 / 确认不再依赖。cw 在 abandonedRefs 对应记录追加 `resolvedAt` + `resolvedAction: "accept"`，`basedOnParent` 原样保留（历史 id 不换）。所有记录都 resolved 后阻塞解除 | **不改 status**（在 abandonedRefs 追加 resolvedAt）| epic §8.2 |
| `abort` | 任何非终态的 WorkUnit 调 | 整个不要了。连带销毁所有非终态子孙（父挂子没法活），代码不删（cw 不管 git，commit 留 git）| → `aborted` | epic §6 / §8.2 |

`abort` 既是 replan 配套的下游选项之一（「不想接受新版本就整个 abort 重做」），也是通用的「这个 WorkUnit 不要了」旁路。`alsoAbortsChildren` 是 abort 的属性，标记「连带销毁子孙」。

### 3.6 replan 的顶层规则

这些是跨层共享的规则，是机制级的陈述（不是名词概念）。

**replan 规则（规则表）**：

| 规则 | 含义 | 来源 |
|---|---|---|
| **replan 不改 status** | replan 在 verified / executing 调用，status 原地不动。不是「回退」，是「加补丁 + 通知」| guide §6.3；epic §6 |
| **accept-replan 不动 basedOnParent** | 只在 abandonedRefs 追加 resolvedAt，历史引用 id 原样保留（append-only）| guide §3.6 / §6.3 |
| **影响面沿 replacedBy 链查询** | 多次 replan（D2→D2-v2→D2-v3）时，cw 遍历下游 basedOnParent，对每个 id 沿 replacedBy 链查最新版本是否废弃。不为 O(1) 而重写 basedOnParent 会删掉「下游当初基于哪个版本」的历史，违反 append-only | guide §6.4；epic §8.2 |
| **纯撤销场景** | replan 时没有 replacementContent，accept-replan 语义变成「确认不再依赖」（没新版本可换，只能选「确认不依赖」或「abort」）| guide §6.2；epic §8.2 |
| **影响面只往下传** | epic→feature→slice→wave 单向，不反向（DAG 性质）。跨 epic 影响用 ADR，不在 epic replan 内 | guide §6.5 |
| **已 closeout 的下游 cw 静默忽略** | replan 时如果被影响的下游已 closed（真终态），cw 不追加 abandonedRefs、不记日志、不通知（closeout 是真终态不可逆，历史就是历史）。真要跟进新决策由后续新 WorkUnit 重做 | guide §3.6；epic §8.2 |
| **阻塞只阻塞改状态 action** | abandonedRefs 有未处理记录的下游，阻塞所有改状态 action（clarify/plan/verify/execute/test/retrospect/closeout），**只读查询（status/list/show）不阻塞** | epic §8.2 |
| **abort 不删代码** | cw 不管 git，commit 留 git，新 feature / wave 可参考 | guide §3.6；epic §8.2 |
| **closeout 一次性不可逆** | closeout 后真终态，不可 reopen | epic §6 |

### 3.7 4 层的 replan 角色

不同层在 replan 机制里扮演不同角色，取决于它是顶层、中间层还是叶子：

**4 层 replan 角色（规则表）**：

| 层 | 在 replan 里的角色 | 原因 |
|---|---|---|
| **epic** | 纯发起者 | 顶层，basedOnParent 永远为空，不会承受上游 replan，只能改自己的 plan 项标下游 |
| **feature / slice** | 既是上游也是下游 | 既改自己的 plan 项标下游（feature 改 FR/AC 标 slice；slice 改 TC/IF/DM/ERR 标 wave），又被上游标被阻塞（feature 被 epic 改 Clarification 标；slice 被 feature 改 FR/AC 标）|
| **wave** | 纯承受者 | 叶子，无 childUnitIds，不发起 replan，只承受上游 slice replan 的 abandonedRefs |

### 3.8 replan 的输入字段

replan action 通过 stdin 传入输入数据，含要废弃哪些项 + 要新增哪些项。

**replan 输入（名词表）**：

| 字段名 | 是什么 | 来源 |
|---|---|---|
| **replan 输入**（`ReplanInput`）| replan action 调用时通过 stdin 传入的数据，含 `abandonItems` + 可选的 `newItems` | 各层附录 |
| **要废弃的 plan 项数组**（`abandonItems`）| ReplanInput 的子字段。每项含 `id`（要废弃的 plan 项 id）、`refKind`（废弃类型，见 §3.4）、`replacementContent?`（替换项的新内容，**空 = 纯撤销**，见 §3.6 的纯撤销场景）| 各层附录 |
| **要新增的 plan 项数组**（`newItems`）| ReplanInput 的子字段。新增的独立 plan 项（不替代任何旧项，纯新增）| 各层附录 |

`replacementContent` 是判别联合类型（区分 kind：epic 是 Clarification、feature 加 FR/AC/UC、slice 再加 TC/IF/DM/ERR）。**每层定义自己的版本**——同构的是 replan 的 4 步机制，不是类型集合。每层能 replan 哪些 plan 项由各层文档定义，本文不展开。

### 3.9 append-only 历史原则

cw 所有逆向操作都不删旧数据，只加新标记。这是 replan 机制的设计底座，保历史、防丢信息。具体操作层面（replan 怎么标记、accept-replan 怎么解锁、abort 怎么处理）已在 §3.6 规则表讲过，不重复。

append-only 体现在三个逆向 action 上：replan 把旧 plan 项标 `status=abandoned` 加 `replacedBy` 指针（旧项不删，加标记）；accept-replan 在下游的 `abandonedRefs` 追加 `resolvedAt`（不动 `basedOnParent`，历史 id 不换）；abort 改 `status` 为 `aborted`（不删 WorkUnit，代码留 git）。三者都不删旧数据。

这个原则与 **progressive（追加式调用）** 的关系：progressive 是「多次调同一个 action 时每次追加新内容、不覆盖之前」（如 `cw wave plan` 第一次写 testCases = [TC1,TC2]，第二次调追加 TC3 变 [TC1,TC2,TC3]）。两者都是「不删只加」，但 progressive 针对的是**正向追加**（plan 内容越填越全），append-only 针对**逆向变更**（上游改了方案、旧版不删只标废弃）。clarify / plan / verify / replan 都是 progressive。

---

## 第四部分：用词规则

**所有用词都必须是本词表中已有的概念，不允许使用词表以外的概念**。如果要引入新概念，必须经过用户决策。

哪些词是已废弃的、不能用，详见 guide §4 黑名单。

---

## 第五部分：未定义 / TODO 的机制

诚实承认这些机制设计层还没定死或待迁移，避免假装已经想清楚。

**TODO 项（规则表）**：

| 项目 | 状态 | 来源 |
|---|---|---|
| `basedOnParent` 继承机制（全量拷贝再减少）| **临时语义，TODO 待重设计**——下游 create 时 cw 把上游当前所有 plan 项 id 全量拷贝到 basedOnParent（下游 plan 时可减少到只留真正用到的）。reviewer epic C3 指出要重新设计 | epic §7.3；feature §4.1 / §4.3；slice §4.1 / §4.5；wave §4.1 |
| `sourceClarification` 字段（Decision 的）| **已落地**——Decision 的 `sourceClarification?: string` 字段记录它投影自哪个 Clarification（id 直接对齐 Clarification 的 id）。feature §5.4 / slice §5.2 已定义 |
| cw 0.x 的 `SpecVersion` / `specHistory` / `replaceSpecSections` 迁移 | **TODO（迁移）**——标 deprecated，按逐项 replan 重写 | feature §5.4 |
| AC `verification` 字段的机器辅助校验 | **TODO（后续迭代，追踪号 feature-M4）**——如 `verification=unit` 时要求 condition 含可测动词、模糊词 warning | feature §4.4 |
| cw 如何发现并执行 wave 测试套件 | **实现侧文档**——设计层已定（cw 实跑测试验全 pass），「cw 如何发现测试套件 / 多 commit 场景选哪个 commit / manual TestCase 验收记录格式」是实现细节 | wave §8 |
| wave `commitHash` 如何关联 wave | **实现侧文档**——设计层已定（agent stdin 传 commitHash，cw 验 `git cat-file -e` 存在性后记录到 wave.commitHash）| wave §4.5 / §8 |
| `research` 服务 | **后续文档**（research 服务文档未写）| epic §10 |
| `claim`（多 agent 并行互斥）| **后续文档**（claim 文档未写）| epic §10 |
| `ADR`（重要决策跨 epic 复用）| **后续文档**（ADR 文档未写）。当前设计：重要 Clarification 在 closeout 阶段升级为 ADR | epic §7.5 / §10 |

---

## 附录：概念字母索引

按字母 / 拼音排序，方便查词。

**A-G**
- `abandoned`（plan 项的废弃标记）→ §3.3
- `abandonedRefs`（下游的废弃引用及处理状态）→ §3.3
- `abandonItems`（replan 输入的子字段）→ §3.8
- `abort`（旁路 action）→ §2.3、§3.5
- `accept-replan`（配套 action）→ §2.3、§3.5
- `ADR` → §5（未定义）
- `alsoAbortsChildren`（abort 属性）→ §3.5

**H-N**
- `basedOnAbandoned`（派生值）→ §3.3
- `basedOnParent`（下游引用父层项）→ §1.4、§3.3
- `childUnitIds`（子层 id 列表）→ §1.4
- `claim` → §5（未定义）
- `clarifications`（clarify 步骤产物）→ §1.3
- `closeout`（8 步之一，一次性不可逆）→ §1.3
- `created`（状态）→ §2.2
- `Decision`（plan 内部条目，投影自 Clarification，跨层共享类型；feature 和 slice 都用）→ 见 guide §6.2 / §8.4、feature §5.4、slice §5.2
- `evidence`（closeout 产物）→ §1.3

**O-Z**
- `objective`（create 产物）→ §1.3
- `parentUnitId`（父层 id）→ §1.4
- `plan`（plan 步骤 + plan 产物，3 个含义）→ §1.3
- `planning`（状态）→ §2.2
- `progressive`（追加式调用）→ §3.9
- `replan`（旁路 action，机制见第三部分）→ §2.3、§3
- `replacedBy`（plan 项的被替代指针）→ §3.3
- `ReplacementContent`（判别联合，每层定义）→ §3.8
- `resolvedAction`（abandonedRefs 子字段）→ §3.3
- `resolvedAt`（abandonedRefs 子字段）→ §3.3
- `retrospectData`（retrospect 产物）→ §1.3
- `scope`（4 个层）→ §1.2
- `status`（WorkUnit 状态，9 状态）→ §1.4、§2.2
- `statusHistory`（状态变更历史）→ §1.4
- `step`（8 步流程）→ §1.3
- `testJudgment`（test 产物）→ §1.3
- `verifyJudgment`（verify 产物）→ §1.3
- `WorkUnit`（cw 管理的核心实体）→ §1.1

---

## 维护说明

- 这份文档是**派生文档**，不是设计本身。源文档任何概念变更（新增字段 / 废弃词 / TODO 落地）应同步更新这份索引；冲突时以源文档为准（guide §12）。第三部分（replan）和第五部分（TODO）最近重构最频繁。
- **不要在这份文档里发明新概念**——只整理已存在的概念，新概念必须经过用户决策（见第四部分用词规则）。
- **不要把各层 plan 内部条目提升到顶层**——plan 内部（FR/AC/UC、TC/IF/DM/ERR、TestCase）由各层文档定义，本文只在 §1.3 提一句「plan 产物的内部结构因层而异，见各层文档」。
- **严格区分概念 vs 原则**——概念（WorkUnit / scope / 字段名）收录在本表主体；原则（「学一层会四层」「execute 是分水岭」）属于设计哲学（guide §3），本文只在叙述中作为背景一句带过，不单独列为概念条目。

**代码层基础类型（不收录在词表主体）**：设计文档附录里有 `WorkUnitItem`（id + status + replacedBy）和 `Plan`（split: Split[]）两个代码层基础类型——所有可 replan 条目（Clarification / FR / AC / UC / SliceTechChoice / WaveTestCase 等）继承 `WorkUnitItem`（拿 status / replacedBy 字段），所有层 plan 继承 `Plan`（拿 split 字段）。这两个是代码层 DRY 复用，**不是领域概念**，所以不进词表主体。`Split`（拆下一层的清单，含 slug + description + dependsOn）也同理——它是 plan 内部结构的代码层实现。完整继承树见各层文档附录。本文 §1.3 末尾的「plan 内部结构因层而异」原则对它们同样适用：glossary 只在此说一句它们存在，不展开定义。

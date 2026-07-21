# cw 1.0 设计文档 v4 · epic 层

> 本文档只讲 epic 一层。目的是把「层」这个概念讲透。后面 feature/slice/wave 用**完全相同的 8 步结构**讲，只是每步内容不同。学一层，会四层。
>
> **顶层概念体系**：使用者的认知模型只有两个维度——**4 个层**（epic/feature/slice/wave）× **8 个步骤**（create/clarify/plan/verify/execute/test/retrospect/closeout）。每一步在每一层都有一个**同名产物**，需要区分时加层前缀（如 `epicPlan` / `featurePlan`）。`DecisionRecord` / `SpecSection` / `FR-AC` 这些专有名词降级为各层 plan 的**内部字段**，不作为顶层概念暴露。

---

## 1. 一分钟理解整个项目

cw 1.0 把开发工作拆成 4 层，每一层走**完全一样的 8 步流程**，只是粒度不同：

```
epic    （大目标）       「重构认证系统」
  ↓ execute（启动 feature 层）
feature （单特性）       「OAuth 登录」「会话管理」
  ↓ execute（启动 slice 层）
slice   （一次能做完的） 「OAuth 登录 - 后端接口」
  ↓ execute（启动 wave 层）
wave    （一次提交）     「OAuth 接口 - 骨架 + 测试」
  ↓ execute（dev 写代码）
代码产出
```

**统一的 8 步流程**（所有层都走）：

```
create → clarify → plan → verify → execute → test → retrospect → closeout
 创建     澄清     规划    审查      执行      测试     复盘       收尾
```

**核心洞察**：execute 是分水岭——

| | 规划型 scope（epic/feature/slice）| 执行型 scope（wave）|
|---|---|---|
| **execute 做什么** | 启动下一层（递归） | dev 写代码 |
| **test 做什么** | 子层全部完成后，整体验证符合自己的规划 | 跑测试（机器验证）|

每一步在不同层做的事情不同，但**流程结构完全一样**：

| 步骤 | epic | feature | slice | wave |
|---|---|---|---|---|
| clarify | 识别决策（用 OAuth 还是 session？）| 澄清需求细节 | 澄清技术细节 | 澄清实现细节 |
| plan | 拆 feature（plan.featureSplit）| 写 spec（FR/AC/UC）+ 拆 slice | 拆 wave + 技术方案 | 写测试代码 |
| verify | 审查规划（人审）| spec_review | plan_review | code review + TDD 红灯 |
| execute | **启动 feature 层** | **启动 slice 层** | **启动 wave 层** | **dev 写代码** |
| test | feature 全完成后整体验证 | slice 全完成后整体验证 | wave 全完成后整体验证 | **跑测试** |
| retrospect | 复盘 epic 层 | 复盘 feature 层 | 复盘 slice 层 | 复盘 wave 层 |

---

## 2. 为什么分 4 层

不分层会怎样：一个大工作（比如「重构认证系统」）直接砸给 agent，agent 在低分辨率下瞎猜、上下文爆、做到一半发现方向错。

分层的本质是**逐步精化**：每一层把工作想得更清楚一点，拆得更细一点，下一层基于上一层已定稿的成果继续。

为什么是 4 层不是 3 层或 5 层：经验上的自然粒度——epic 跨多 session、feature 跨多 slice、slice 单 session 可完成、wave 单次提交可完成。少一层粒度太粗会回到「砸给 agent」，多一层粒度太细是过度工程。

---

## 3. 为什么是 8 步

这 8 步对应开发者做任何一件事的自然节奏：

```
create      我要开始做这件事
clarify     这件事到底是什么、有哪些选择
plan        具体怎么做、拆成几步
verify      方案合理吗（执行前审查）
execute     开始做
test        做的对不对
retrospect  回头看做得怎么样
closeout    收尾
```

**关键区分**：
- **verify 是审查方案**（针对 clarify + plan 阶段的产物，还没执行）
- **test 是验证结果**（针对 execute 之后的产物）

这两个动作不能合并——执行前的方案审查和执行后的结果验证，关注点完全不同。cw 0.x 把它们混在 review/test 里，实际上对应的就是 verify/test 这两个独立步骤。

**split 在 plan 里做**：拆分到下一层不是独立步骤，是 plan 阶段的自然产物（epic plan 拆 feature、feature plan 拆 slice、slice plan 拆 wave）。

---

## 4. epic 是什么

epic 是**一个大的工作目标**，大到一次开不完、需要先想清楚拆成几个独立的 feature。

典型 epic 例子：
- 「重构认证系统」
- 「把单体应用拆成微服务」
- 「从 JavaScript 迁移到 TypeScript」

epic 的核心特征：
- **跨多个 session**：不可能一次开完
- **路径开始时不清**：要先做决策（用 OAuth 还是 session？支持哪些角色？）才能确定要拆成哪些 feature
- **只规划不写代码**：epic 的 execute 不是 dev，是启动 feature 层。epic 自己永远不产出代码，代码都在 wave 层

---

## 5. epic 的完整流程（8 步详解）

### 5.1 第 1 步：create（创建）

**做什么**：建一个 epic 实例，写下 **objective**（这个 epic 完成后世界应该长什么样，1-2 句话）。

**objective 例子**：
> 把现有的 session-based 认证重构成 OAuth 2.0，支持第三方登录，为后续 SSO 打基础。

**状态**：`created` → 进入 `clarifying`

**命令**：
```bash
cw epic create auth-refactor --objective "把现有的 session-based 认证重构成 OAuth 2.0..."
```

### 5.2 第 2 步：clarify（澄清）

**做什么**：识别这个 epic 要推进必须先回答的问题（**Clarification**——clarify 阶段的产物），逐个给答案。

epic 的 clarify 典型问题：
- 「认证用 OAuth 还是 session？」→「新功能用 OAuth，session 保留兼容旧 API」
- 「支持哪些用户角色？」→「admin / user / guest」
- 「token 存哪？」→「httpOnly cookie（防 XSS）」

**Clarification 的字段**：
```typescript
interface Clarification {
  id: string;
  question: string;              // 问题
  resolution?: string;           // 答案（空 = 还没想清楚）
  type: "research" | "grilling"; // research=查资料能答 / grilling=必须问人
  status: "open" | "resolved" | "abandoned";  // abandoned = 已废弃（replan 时填）
  replacedBy?: string;           // 替代它的新 id（replan 时填）
}
```

**「还没想清楚」= resolution 为空**。clarify 阶段就是逐步把空的 resolution 填满。

**research vs grilling**：
- `research`：查外部资料（文档、API、源码）能答的，agent 可以自己解决（调 research 服务）
- `grilling`：必须人回答的（产品决策、业务规则），agent 不能替人表态

**状态**：`clarifying`

**命令**：
```bash
cw epic clarify auth-refactor      # progressive，可多次调用
```

### 5.3 第 3 步：plan（规划）

**做什么**：基于 clarify 的决策，**拆 feature**（split 在这步做，作为 plan 的内部字段）：
- 这个 epic 应该拆成几个 feature？
- 每个 feature 大概做什么？（一句话描述）
- feature 之间的依赖关系？（DAG，无循环）

**例子**（epic = 「重构认证系统」的 feature 拆分）：

| feature slug | 描述 | 依赖 |
|---|---|---|
| `session-management` | 会话管理基础 | — |
| `oauth-login` | OAuth 登录 | `session-management` |
| `permission-control` | 权限控制 | `session-management` |

**产出**：`epicPlan.featureSplit`（feature 拆分清单 + 依赖关系图）

**状态**：`planning`

**命令**：
```bash
cw epic plan auth-refactor         # progressive，可多次调用
```

### 5.4 第 4 步：verify（审查规划）

**做什么**：在启动 feature 层**之前**，对 plan 阶段的方案做**结构化的业务判断**。

这一步的核心不是「跑机器检查」（那只是最低门槛），而是**强迫 agent（或人）认真想清楚这个方案值不值得做、做得对不对**。cw 的职责是：① 定义业务判断的存储结构（`verifyJudgment` 字段）；② 在 `nextAction.guidance` 里提示 agent 该想哪些问题；③ 结构校验（必填字段非空、引用一致）。**业务判断的内容由 agent 产出，cw 不判断内容对错**。

**guidance 提示 agent 回答的问题**（这些是 verify 的真正价值，不是机器 gate）：

| 维度 | 要回答的问题 |
|---|---|
| **必要性（necessity）** | 这个 epic 不做会怎样？解决的是什么痛点？为什么是现在做？ |
| **充分性（sufficiency，MECE）** | 这些 feature 加起来能覆盖 objective 吗？有没有遗漏的维度（Gap）？有没有重叠/冗余？MECE 检查的整体结论是什么？ |
| **替代方案（alternatives）** | 有没有其他拆 feature 的方式？考虑过但没选的方案是什么？为什么没选？ |
| **权衡与妥协（tradeoffs）** | 哪里是硬妥协（为了快速上线砍了什么）？每个妥协的代价是什么？ |
| **风险（risks）** | 最可能失败的点在哪？每个风险的严重度（high/medium/low）和缓解措施？ |

agent 把这些判断填入 `workUnit.verifyJudgment` 对应字段（含 epic 专属的 `layerSpecific` KV，如 `featureSplitRationale`）。

**机器 gate**（只验结构，不验内容——内容质量由 agent 负责）：
- **结构完整性**：`all-decisions-resolved` / `feature-split-non-empty` / `feature-split-dag-valid`
- **业务判断非空**：`verifyJudgment.necessity` 非空、`verifyJudgment.sufficiency` 非空（gaps/overlaps/meceNote 三项都要填，没有要显式写「已检查无」）、`verifyJudgment.tradeoffs` 至少 1 条（或显式声明「无妥协」+ 理由）、`verifyJudgment.risks` 至少 1 条（或显式声明「无重大风险」+ 理由）

**诚实说明**：机器只验「agent 有没有填这些字段」，**验不了「填得对不对、想得深不深」**。这是 cw 作为 agent-agnostic 工具的边界——cw 能保证 agent 不能跳过业务思考，但保证不了 agent 思考的质量。内容质量由 agent（或人审）负责。判断内容的可追溯性（存在 `verifyJudgment` 里）是后续 test/retrospect 对照的基础。

**通过的含义**：方案定稿，可以启动 feature 层了。

**状态**：`verified`

**命令**：
```bash
cw epic verify auth-refactor       # progressive，可多次调用（没过就回 clarify/plan 修）
# 输入数据从 stdin 读：{ verifyJudgment: {...} }
```

### 5.5 第 5 步：execute（执行 = 启动 feature 层）

**做什么**：这是 epic 层的**核心分水岭**。epic 自己不写代码，它的 execute = **启动 feature 层**：

1. 根据 plan 阶段的 `featureSplit` 拆分清单，为每个 feature 创建实例
   - 每个 feature 引用 epic 的 Clarification（记录在 `basedOnParent`，详见 §7.3）
   - 每个 feature 的 `parentUnitId` 指向这个 epic
2. 每个 feature 开始走自己的 8 步流程（create → clarify → ... → closeout）

**epic 在 execute 阶段做什么**：等。等所有 feature 走完它们的 8 步流程，全部 closeout 后，epic 进入 test 阶段。

**execute 是「规划型」和「执行型」scope 的分水岭**：
- epic/feature/slice 的 execute = 启动下一层（递归）
- wave 的 execute = dev 写代码（递归出口）

详见 §9 execute 递归。

**状态**：`executing`（这是个长状态，可能持续数天/数周，跨多个 session）

**命令**：
```bash
cw epic execute auth-refactor      # 启动 feature 层
```

### 5.6 第 6 步：test（整体验证）

**做什么**：所有 feature 都 closeout 后，**逐条对照 verify 阶段的业务判断**，验收实际结果。不是泛泛的「整体方向对吗」，而是**把 verifyJudgment 里的每一条判断拿出来，看兑现了没**。

**guidance 提示 agent 对照回答**：

| verify 阶段的判断 | test 阶段要回答 |
|---|---|
| 当初说的「必要性」（解决痛点 X）| 痛点 X 真的被解决了吗？ |
| 当初识别的 Gap（遗漏维度）/ 重叠/冗余 | 这些 Gap 真的漏掉了吗？有没有 verify 没发现的新 Gap？重叠实际有发生吗？ |
| 当初考虑但没选的替代方案（alternatives）| 事后看当初没选的那个方案，其实应该选吗？ |
| 当初的每个权衡 + 代价 | 代价真的付出了吗？影响符合预期吗？ |
| 当初的每个风险（high/medium/low）| 实际表现如何？（爆没爆、缓解措施有用吗）|

agent 把对照结论填入 `workUnit.testJudgment`，每个字段**必须对应 `verifyJudgment` 的一项**（necessity 对 necessity、sufficiency 对 sufficiency、alternatives 对 alternatives、每个 tradeoff 有对应的 costRealized、每个 risk 有对应的 outcome）。

**机器 gate**：
- **结构完整性**：`all-features-closed`
- **引用一致性**（诚实区分两类）：
  - **真引用一致（机器验 id 匹配）**：`testJudgment.tradeoffCostRealized` 里的 `tradeoffRef` 必须覆盖 `verifyJudgment` 每个 Tradeoff.id；`testJudgment.riskOutcome` 里的 `riskRef` 必须覆盖 `verifyJudgment` 每个 Risk.id——不漏验任何一条 tradeoff/risk
  - **只验非空（对应关系靠 agent 自检 + 人审）**：`necessityMet` / `sufficiencyMet` / `alternativesReconsidered` 是 string/结构体，机器只验「填了」，内容是否真对应 verifyJudgment 靠 agent 自检

这是机器能做的最有价值的校验（防 test 阶段跳过某些 tradeoff/risk），但诚实区分：不是所有「对应」都能机器验，只有 id 引用一致能验。

**诚实说明**：对照结论本身（「这个风险实际爆了没」）由 agent 判断，cw 只验「该对照的都对照了」。

**如果没通过**：可能要回到某个 feature 修，或者发现 epic 方案本身有问题（少见，因为 verify 已经审过；真发生就走 replan）。

**状态**：`tested`

**命令**：
```bash
cw epic test auth-refactor
# 输入数据从 stdin 读：{ testJudgment: {...} }
```

### 5.7 第 7 步：retrospect（复盘）

**做什么**：复盘 epic 层自己的事。**核心动作是对照 verifyJudgment，看哪些判断事后证明错了**——这是经验沉淀的真正来源，不是泛泛的「整体方向对不对」。

**guidance 提示 agent 回答**：

| 复盘维度 | 要回答的问题 |
|---|---|
| **判断错误（wrongJudgments）** | verify 阶段哪些判断事后看错了？（标的高风险实际很低、或反之；判断的 Gap 实际不存在；认为必要的实际不必要）|
| **不良权衡（badTradeoffs）** | 哪些妥协事后看不值得？（代价远超预期，或换来的收益没兑现）|
| **遗漏的 Gap（missedGaps）** | verify 没发现、test 阶段才暴露的 Gap 是什么？为什么 verify 没发现？ |
| **流程问题（processIssues）** | feature 拆分合理吗？Clarification 有遗漏吗？多 feature 协作顺畅吗？ |
| **提炼经验（lessonsLearned）** | 下次做类似 epic，最该记住的 1-3 条经验是什么？ |

agent 把复盘结论填入 `workUnit.retrospectData`。其中 `reviewedItems` 是**结构化逐项回顾记录**——对 verifyJudgment 的每一项（necessity/sufficiency/alternatives + 每个 tradeoff id + 每个 risk id），必须有一条 reviewedItems 记录，机器验「覆盖」（不验 verdict 对错）。`wrongJudgments` / `badTradeoffs` / `missedGaps` 允许为空（说明判断都对了），但 `lessonsLearned` 必须非空——**没有提炼出经验的 retrospect 是失败的 retrospect**。

**机器 gate**：
- `retrospectData.lessonsLearned` 非空（`lessons-learned-non-empty`）
- `retrospectData.reviewedItems` 覆盖 `verifyJudgment` 的每一项（`retrospect-covers-verify`，机器验）：每个 necessity/sufficiency/alternatives + 每个 Tradeoff.id + 每个 Risk.id 都有一条对应的 reviewedItems 记录。

**人审 gate**（机器验不了，诚实承认）：
- `reviewedItems` 的 `verdict`（判断对/错）和 `note`（说明）的内容质量——机器只验「每项都有记录」，验不了「回顾得对不对、深不深」。

**诚实说明**：经验提炼的质量由 agent 负责，cw 只保证「不能跳过复盘、必须提炼经验」。是否逐项对照 verifyJudgment，是人审的职责，不是机器 gate。

**产出**：retrospect 记录（结构化的经验沉淀，是跨 epic 复用的知识资产）

**状态**：`retrospected`

**命令**：
```bash
cw epic retrospect auth-refactor
# 输入数据从 stdin 读：{ retrospectData: {...} }
```

### 5.8 第 8 步：closeout（收尾）

**做什么**：
- 写 evidence（epic 的最终交付证据：feature 列表、Clarification 清单、retrospect）
- epic 进入 `closed`（归档，不再变动）
- 更新相关的 ADR（重要的决策升级为 ADR，供其他 epic 复用）

**epic 的使命到此结束**。

**状态**：`closed`（真终态，不可 reopen）

**命令**：
```bash
cw epic closeout auth-refactor
```

---

## 6. epic 状态机

```
              create      clarify     plan      verify     execute     test     retrospect   closeout
  (开始) ─────────> created ──────> clarifying ──────> planning ──────> verified ──────> executing ──────> tested ──────> retrospected ──────> closed
                       ↑                │             │              │           │            │             │
                       │                │             │              │           │            │             │
                       └── clarify ─────┘             │              │           │            │             │
                                       └── plan ──────┘              │           │            │             │
                                                      └── verify ────┘           │            │             │
                                                                                 └── ... ────┘ ... ────────┘
                                                                                                                   │
                                                                                                                   ▼
                                                                                              任何非终态 ──abort──> aborted
                                                              verified/executing ──replan──> 原地（不改 status，触发影响面传播）
                                                              有未处理 abandonedRefs ──accept-replan──> 原地（解锁）
```

**9 个状态**：created / clarifying / planning / verified / executing / tested / retrospected / closed / aborted

**9 个核心 action + 2 个旁路**：create / clarify / plan / verify / execute / test / retrospect / closeout / abort + replan / accept-replan

**关键规则**：
- `clarify` / `plan` / `verify` / `replan` 是 progressive（可在同状态多次调用）
- `execute` 是长状态（等待子层完成，可能跨多 session）
- `test` / `retrospect` / `closeout` 是一次性
- `closeout` 后真终态，不可 reopen
- `abort` / `replan` 是旁路：
  - `abort`：任何非终态 → aborted（终止）；**连带销毁所有非终态子孙**（父挂了子没法活）
  - `replan`：**不改 status**（无论在 verified 还是 executing，都原地不动）；只做四件事：(a) 作废指定 plan 项（旧项 status=abandoned + replacedBy 指向新版本）；(b) 新增新版本（如有）；(c) 反查子树里哪些 WorkUnit 的 `basedOnParent` 含被废弃项的 id，在它们的 `abandonedRefs` 追加一条未处理记录；(d) 阻塞这些下游（有未处理记录），强制处理（详见 §8.2）

---

## 7. Clarification（clarify 阶段的产物）

### 7.1 什么是 Clarification

推进 epic 时遇到的选择题。如果不记下来：
- 下次开 session 就忘了当时怎么决定的
- 不同人做不同 feature 时，对同一个问题的理解不一致

**例子**（epic = 「重构认证系统」的 Clarification）：

| 问题 | 答案 | type |
|---|---|---|
| 认证用 OAuth 还是 session？ | 新功能用 OAuth，session 保留兼容旧 API | grilling（产品决策）|
| 支持哪些用户角色？ | admin / user / guest | grilling |
| OAuth 提供商的 token endpoint 规范是什么？ | OAuth 2.0 RFC 6749 section 3.2 | research（查资料）|

### 7.2 字段

```typescript
interface Clarification {
  id: string;
  question: string;
  resolution?: string;                      // 空 = 还没想清楚
  type: "research" | "grilling";
  status: "open" | "resolved" | "abandoned"; // abandoned = 已废弃（replan 时填）
  replacedBy?: string;                       // 替代它的新 id（replan 时填）
}
```

`abandoned`（已废弃）状态和 `replacedBy`（被谁替代）指针是 replan 打补丁的基础：旧项不删，只标「已废弃」+ 指向新版本，详见 §8.2。

### 7.3 basedOnParent：子孙引用记录

**replan 查影响面的基础**。每个子孙 WorkUnit 记录自己引用了父层 plan 的哪些项：

```typescript
interface WorkUnit {
  // ...
  basedOnParent: string[];   // 比如 ["D1", "D2", "D5"]——我引用了父层（epic）的 Clarification 的哪些 id。append-only 历史记录，下游当初基于哪个版本就记哪个版本，**永不重写**（保历史，符合 guide §3.6）
  abandonedRefs: AbandonedRef[]; // 被废弃的引用及处理状态（结构化，非 boolean）。空数组 = 无废弃引用 = 不阻塞
}

interface AbandonedRef {
  refId: string;              // 被废弃的父层 plan 项 id（如 "D2" 或 "FR1"）
  refKind: "clarification" | "specItem" | "techItem";  // 引用类型——影响下游响应语义，见下方说明
  // refKind 是对 replacementContent.kind 的粗分类（类型塌缩）：
  //   kind="Clarification" → refKind="clarification"
  //   kind ∈ {FR, AC, UC} → refKind="specItem"
  //   kind ∈ {TC, IF, DM, ERR}（slice 层扩展）→ refKind="techItem"
  // 粗分类理由：阻塞机制不区分具体 spec 项类型，只区分「上游决策变更 vs 下游范围变更」两种 guidance 语义
  resolvedAt?: string;        // 何时被处理（空 = 未处理，下游阻塞中；非空 = 已处理，解锁）
  resolvedAction?: "accept" | "abort";  // 怎么处理的（accept = 接受新版本/确认不再依赖；abort = 整个下游不要了）
  // 注意：basedOnParent 不动。accept 时只追加 resolvedAt 记录，历史引用 id 原样保留（append-only）
}
```

**refKind 的语义差异**（阻塞机制统一，但 guidance 提示不同）：

三种引用废弃后的阻塞/解锁机制完全一样（abandonedRefs 追加 → 阻塞 → accept/abort 解锁），但 **guidance 对 agent 的提示不同**，因为对下游含义不同：

| refKind | 含义 | accept 时 guidance 提示 |
|---|---|---|
| `clarification` | 上游的某个澄清结论变了（如 epic 的 D2「用 OAuth」换成「自研」）| "这是上游的产品/架构决策变更，评估新结论对你下游的影响，接受或 abort" |
| `specItem` | 你负责的某个 spec 项（FR/AC/UC）被改/撤了（如 feature 的 FR1 换成 FR1-v2）| "这是你的工作范围变更——评估新 FR/AC 是否仍属你的职责，接受新版本或 abort" |
| `techItem` | 你依赖的某个技术方案项（TC/IF/DM/ERR）被改/撤了（如 slice 的 IF1 签名变了）| "这是你的技术依赖变更——评估新接口/数据模型是否影响你的实现，接受新版本或 abort" |

阻塞/解锁的机器机制不区分（都是 abandonedRefs 记录），但 agent 看到不同 refKind 会做不同性质的决策（产品决策 / 范围决策 / 技术依赖决策）。
```

**派生值**：`basedOnAbandoned` 不再是独立字段，而是 `abandonedRefs.some(r => !r.resolvedAt)` 的派生值（有任一未处理记录 = 阻塞中）。

**填充时机**：feature/slice/wave 在 create/execute 时从父层继承 `basedOnParent`（初始引用）。比如 feature create 时 cw 把 epic 当前的 `clarifications` 的 id 全量拷贝到 `feature.basedOnParent`（feature plan 时可以减少——只留自己真正用到的）。**TODO（后续批次）**：`basedOnParent` 的全量拷贝继承机制要重新设计（见 reviewer epic C3），本次保持现有语义。

**作用**：epic replan 废弃 D2 时，cw 反查「子树里 `basedOnParent` 含 D2 的 WorkUnit」，在它们的 `abandonedRefs` **追加**一条 `{refId: "D2"}`（resolvedAt 为空）。有未处理记录的下游，阻塞所有改状态 action（只读查询不阻塞），强制处理（详见 §8.2）。

**统一语义**：`basedOnParent` 统一承载「下游引用了父层哪些 plan 项」，不再区分 usedDecisions / specCoverage 两套字段。各层的引用关系由各层文档定义（feature→slice 引用 feature 的 spec 项，由 feature 文档展开），机制相同。

### 7.4 Clarification 不是独立工作单元

Clarification **只是 epic 的 clarify 阶段产生的一个列表项**，挂在 epic 上：

```
epic
  ├─ objective: "..."
  ├─ status: clarifying
  ├─ plan: { featureSplit: [...] }   // plan 阶段填
  └─ clarifications: [               // clarify 阶段填
       { question: "...", resolution: "..." },
       ...
     ]
```

它没有自己的状态机、不是独立 Unit。epic closeout 后它跟着 epic 一起归档（如果重要，会被 feature 继承或升级为 ADR）。

### 7.5 重要决策升级为 ADR

如果某个 Clarification 重要到**跨 epic 复用**（比如「所有新功能统一用 OAuth」这种架构级原则），在 closeout 阶段升级为 ADR（Architecture Decision Record）：
- 原 epic 的 Clarification 改成引用 ADR id（不再独立持有）
- ADR 全局共享，其他 epic 可以引用

ADR 是横向服务，不在本层文档范围，另文展开。

---

## 8. epic 的命令一览

### 8.0 命令约定（所有 scope 通用）

本节是 epic/feature/slice/wave 共享的命令约定，后续层文档不再重复。

#### 参数传递规则

| 参数类型 | 传递方式 | 例子 |
|---|---|---|
| **简单参数** | argv | `--objective "..."` / `--slug xxx` / `--from-feature yyy` |
| **结构化输入数据** | stdin JSON | featureSplit、clarifications、testCases |
| **查询参数** | argv | `--status closed` / `--limit 10` |

**为什么 stdin 读输入数据**：agent 可能生成较大的结构化数据（如 feature 拆分清单、测试用例），argv 转义复杂且受 shell 长度限制。stdin JSON 是最可靠的方式。

#### 输出格式（统一 JSON）

所有处理命令（非查询）返回：

```json
{
  "ok": true,
  "scope": "epic",
  "workUnit": {
    "id": "epic:auth-refactor",
    "status": "planning",
    "objective": "...",
    "clarifications": [...],
    "plan": { "featureSplit": [...] },
    "childUnitIds": [...]
  },
  "gatePassed": {
    "clarify": true,
    "plan": false,
    "verify": false
  },
  "nextAction": {
    "action": "plan",
    "guidance": "现在拆 feature。读取 clarifications...",
    "alternatives": ["clarify", "abort"]
  },
  "mustFix": [
    {
      "gate": "feature-split-dag-valid",
      "report": "依赖关系有环：oauth-login → session-mgmt → oauth-login"
    }
  ]
}
```

**关键字段说明**：

| 字段 | 用途 |
|---|---|
| `ok` | 程序是否正常（不含 gate pass/fail） |
| `workUnit` | 当前 WorkUnit 完整快照（agent 据此判断「我在哪」） |
| `gatePassed` | 各 phase gate 状态（agent 据此判断「还要做什么」） |
| `nextAction.action` | 引擎推荐的下一步 action |
| `nextAction.guidance` | 纯文本提示词，agent 的唯一导航来源 |
| `nextAction.alternatives` | 当前状态其他合法 action（如 planning 状态可 clarify/plan/abort） |
| `mustFix` | gate fail 时的具体问题（**agent 修复的依据**）|

#### exit code 语义

agent 按 exit code 判断是否需要 retry：

| exit code | 含义 | agent 该怎么办 |
|---|---|---|
| `0` | 程序正常（含 gate fail，结果在 stdout JSON） | 读 stdout JSON 按 nextAction/guidance/mustFix 推进 |
| `1` | CwError（预期错误：guard 拒绝、参数错误） | 读 stderr 错误信息，修正参数后重试 |
| `2` | 内部异常（未预期的崩溃） | 报告给用户，不重试（可能是 bug） |

**关键区分**：gate fail 是 exit 0（程序正常，只是状态不流转），agent 按 mustFix 修复。exit 1 是参数/调用方式错误，agent 需要改变调用方式。

#### 查询命令（不走状态机）

`status` / `list` / `show` 是只读快照查询：
- **不走状态机**（不触发状态机、不写 gateHistory）
- 返回完整 WorkUnit 快照（或列表）
- 用于 agent 快速了解「当前在哪」而不用调 action

---

### 8.1 epic 的命令列表

```bash
# 主流程（8 步）
cw epic create <slug> --objective "..."           # argv
#   --slug / --objective 必填；--taskShape 可选（默认 full-tdd）
#   --agent / --llm / --cwVersion 自动注入（RuntimeEnv）

cw epic clarify <id>                              # progressive
#   输入数据从 stdin 读：{ clarifications: [...] }
#   多次调用：每次增/改 Clarification

cw epic plan <id>                                 # progressive
#   输入数据从 stdin 读：{ featureSplit: [...] }
#   含 split（拆 feature 清单，存入 plan.featureSplit）
#   多次调用：每次修正拆分方案

cw epic verify <id>                               # progressive
#   多次调用：直到 all-decisions-resolved / dag-valid 等通过

cw epic execute <id>                              # 启动 feature 层
#   根据 plan.featureSplit 创建 feature 实例，每个 feature 进入 created
cw epic test <id>                                 # feature 全 closeout 后整体验证
cw epic retrospect <id>                           # 复盘
cw epic closeout <id>                             # 一次性，不可逆

# 旁路
cw epic abort <id>                                # 任何非终态 → aborted
#   连带销毁所有非终态子孙（父挂了子没法活）
#   代码不删（cw 不管 git，commit 留 git，新 feature 可参考）

cw epic replan <id>                               # progressive，不改 status
#   输入数据从 stdin 读：{ abandonItems: [...], newItems?: [...] }（详见附录 ReplanInput）
#   做四件事：(a) 旧项 status=abandoned + replacedBy 指向新版本
#             (b) 如有 replacementContent，新增新版本（cw 自动生成新 id 如 D2-v2）
#             (c) 反查子树里 basedOnParent 含被废弃项 id 的 WorkUnit，在 abandonedRefs 追加未处理记录
#             (d) 这些下游阻塞所有改状态 action（只读查询不阻塞），强制 accept-replan 或 abort
#   详见 §8.2

cw epic accept-replan <id> --reason "为什么接受新决策"
#   仅当 epic 自己的 abandonedRefs 有未处理记录时有效
#   epic 是顶层，basedOnParent 永远为空，accept-replan 对 epic 是 no-op
#   此 action 仅为状态机对称性保留（每层都有 accept-replan，epic 永远用不到）

# 查询（不走状态机）
cw epic status <id>                               # 单个 WorkUnit 快照
cw epic list [--status planning]                  # epic 列表
cw epic show <id>                                 # 详情（含 clarifications + plan.featureSplit）
```

### 8.2 replan（局部打补丁，影响面传播）

replan 不是「重拟方案」，是「**在跑的过程中局部打补丁 + 连带调整子孙**」。

#### 触发场景

epic 已 verified（甚至已 execute，feature 在跑），agent 发现某个 plan 项不对要换。常见是**子层开发中暴露出问题**：feature-B 开发中发现 epic 之前定的 D2 不对（例：D2 说「用 OAuth」，实际 OAuth 不支持某场景，要换自研）。

#### replan 做什么（4 步）

**1. 作废指定 plan 项**（append-only，不删）：

```typescript
// Clarification 项废弃时
interface Clarification {
  id: string;
  question: string;
  resolution?: string;
  type: "research" | "grilling";
  status: "open" | "resolved" | "abandoned";   // abandoned = 已废弃
  replacedBy?: string;                         // 指向新版本 id
}
```

replan 时：旧项 D2 status 改 `abandoned` + replacedBy = "D2-v2"。

**2. 新增新版本（如有 replacementContent）**：

如果 `abandonItems` 指定了 `replacementContent`，cw 自动生成新 id（如 D2-v2）追加为新的 Clarification 项。如果 `replacementContent` 为空 = 纯撤销（只作废不替换）。

**3. 反查影响面（哪些下游引用了 D2）**：

每个 WorkUnit 在 `basedOnParent` 里记录自己引用了父层哪些 plan 项（见 §7.3）。cw 反查「子树里 `basedOnParent` 含 D2 的 WorkUnit」，在它们的 `abandonedRefs` **追加**一条 `{refId: "D2"}`（resolvedAt 为空）。**append-only：cw 只追加记录，不修改 basedOnParent**。

**影响面查询算法**（沿 replacedBy 链查询，append-only）：

`basedOnParent` 是 append-only 的历史记录——下游当初基于哪个版本就记哪个版本，**不被重写**。查询影响面时，cw 遍历下游的 `basedOnParent`，对每个 id 沿 replacedBy 链查：

```
查询算法（伪代码）：
for each id in downstream.basedOnParent:
  chain = walk_replacedBy_chain(id)   // 如 D2→D2-v2→D2-v3
  latest = chain.last()
  if latest.status == "abandoned":
    // 整条链都废弃了（纯撤销场景），下游该 id 被标
    mark downstream.abandonedRefs with {refId: id}
  elif any version in chain after id is abandoned:
    // id 不在链尾，但链尾前某个版本被废弃了——
    // 说明这个下游引用的是旧版本，该被标
    mark downstream.abandonedRefs with {refId: id}
```

**例子**（D2 → D2-v2 → D2-v3 多次 replan，三个下游各自状态）：

| 下游 | basedOnParent 含 | 第二次 replan（D2-v2→D2-v3）后被标？ | 原因 |
|---|---|---|---|
| A | `D2`（从未 accept）| ✓ 标 | D2 沿链 D2→D2-v2→D2-v3，D2-v2 已废弃 |
| B | `D2-v2`（D2→D2-v2 后创建/accept 到 v2）| ✓ 标 | D2-v2 沿链 D2-v2→D2-v3，D2-v2 已废弃 |
| C | `D2-v3`（已 accept 到最新）| ✗ 不标 | D2-v3 是链尾且非废弃 |

**为什么不为了 O(1) 而重写 basedOnParent**：重写（把 D2 改成 D2-v3）虽然能让查询变成 O(1) 精确匹配，但会**删掉「这个下游当初基于 D2」的历史事实**，违反 append-only 原则（guide §3.6）。retrospect 时想看「这个 feature 历史上引用过哪些版本」需要这个历史。下游数量有限（一个 epic 下的子孙 WorkUnit 不会多到遍历不起），沿链查询的性能完全够用。

**4. 强制处理（阻塞改状态 action，不阻塞只读查询）**：

`abandonedRefs` 中有未处理记录（`resolvedAt` 为空）的下游，cw **阻塞所有改变状态的 action**（clarify / plan / verify / execute / test / retrospect / closeout 都调不了），但**只读查询（status / list / show）不阻塞**。guidance 强制提示：「你有 N 个废弃的引用要处理，每个二选一」：

| 选项 | 效果（append-only，不动 basedOnParent）|
|---|---|
| **accept-replan（接受新版本）** | agent 调 `cw feature accept-replan <feature-id> --reason "为什么接受"`，cw 在 `abandonedRefs` 对应记录追加 `resolvedAt` + `resolvedAction: "accept"`。**basedOnParent 原样保留**（历史 id 不换）。查询当前生效引用时，cw 跳过 `abandonedRefs` 里已 accept 的旧 id，沿链走到最新版本。所有记录都 resolved 后，阻塞解除 |
| **abort（整个不要了）** | agent 调 `cw feature abort <feature-id>`，连带销毁所有子孙（`alsoAbortsChildren`），在 epic 新版本下重建 feature-B' |

**纯撤销场景的处理**（replan 时 `replacementContent` 为空，被废弃项没有新版本）：accept-replan 的语义变成「下游确认：我不再依赖被废弃项」。cw 在 `abandonedRefs` 对应记录追加 `resolvedAt` + `resolvedAction: "accept"`。查询当前生效引用时，被纯撤销的 id 直接跳过（没有新版本可沿链走）。下游不能选「换新版本」（没有新版本），只能选「确认不再依赖」或「abort」。

**一个下游同时被多个上游 replan 时**：`abandonedRefs` 追加多条记录（每个废弃引用一条）。逐个 accept，每条记录都 resolved（resolvedAt 非空）后阻塞才解除。cw 能从 `abandonedRefs` 精确知道「哪几个已处理、哪几个没处理」（boolean 做不到这点，所以用结构化字段）。

**没有第三个选项**。不能「假装没看到」继续跑。

#### replan 的 status 不变（重要）

replan **不改 epic 的 status**：
- 在 verified 调 replan → 还是 verified
- 在 executing 调 replan → 还是 executing（epic 继续跑，只是触发了下游的影响面调整）

这是 replan 的关键设计：**不是「回退」，是「加补丁 + 通知」**。epic 自己的状态节奏不被 replan 打乱。

#### abort 连带销毁子孙

`cw feature abort feature-B` 会**连带销毁所有非终态子孙**（`alsoAbortsChildren`）：
- slice-B1、slice-B2（feature-B 的子）→ aborted
- wave-B1a、wave-B1b（slice-B1 的子）→ aborted
- 代码不删（cw 不管 git，commit 留在 git 里，新 feature 可参考）

#### 已 closeout 的下游

如果被影响的下游已经 closed（真终态，不能改 status），cw **不追加 `abandonedRefs` 记录**（那是阻塞用的，对已 closeout 下游无意义），而是走**单独的 `staleLog` 字段**（append-only 日志，记录「上游 plan 项 D2 已废弃，新版本是 D2-v2」），**不阻塞，不强制处理**——它已经交付，历史就是历史。

> **本文档暂不定义 `staleLog` 的完整字段**，由 stale 文档（见 §10）详细展开。这里只明确边界：`abandonedRefs` 只对非终态下游有意义（阻塞机制），已 closeout 下游的废弃通知走 `staleLog`（只记不阻塞）。

#### 多次 replan

replan 是 progressive，可以多次调（这次改 D2，下次改 D5）。每次作废 + 触发一次影响面传播。

#### plan vs replan 对照

| | `plan` | `replan` |
|---|---|---|
| **类型** | 主流程 progressive | 旁路 progressive |
| **合法 status** | created / clarifying / planning | verified / executing |
| **status 变化** | → planning | **不变**（原地）|
| **用途** | 首次规划或 planning 内修正 | verified/executing 后发现问题局部打补丁 |
| **输入数据** | featureSplit | 要废弃的项 + 新内容（abandonItems / newItems）|
| **影响下游** | 否（子还没创建）| 是（查 basedOnParent，在 abandonedRefs 追加记录，强制处理）|

---

## 9. execute 递归（本设计的精髓）

**execute 对不同 scope 含义不同**，这是整个设计的核心：

```
epic.execute     = 启动 feature 层（每个 feature 开始走自己的 8 步）
feature.execute  = 启动 slice 层
slice.execute    = 启动 wave 层
wave.execute     = dev（真正写代码）—— 递归出口
```

整个系统是**自递归**的：
- epic execute 启动 N 个 feature
- 每个 feature execute 启动 N 个 slice
- 每个 slice execute 启动 N 个 wave
- 每个 wave execute 写代码（出口）

**每个节点都走相同的 8 步流程，只是 execute 步骤进入子层或落地为 dev**。

配套的，test 也是递归的：
- wave.test = 跑测试（机器）
- slice.test = wave 全完成后，验证符合 slice 技术方案
- feature.test = slice 全完成后，验证符合 feature spec
- epic.test = feature 全完成后，验证符合 epic objective

**可视化图**：`~/.agent/diagrams/cw-execute-recursive.svg`（4 层递归树 + 8 步流程 + execute 含义对照表）

这种递归结构带来的好处：
1. **学一层会四层**：流程结构完全一样
2. **自然处理跨 session**：epic 的 execute 可能持续数周，期间每个 feature/slice/wave 独立推进
3. **统一抽象**：所有 scope 共享同一个引擎，差异只在每步的具体内容

---

## 10. 后续文档会展开的内容

本文档只讲了 epic 层。以下内容在后续文档展开，**不在本文档范围**：

| 内容 | 何时讲 |
|---|---|
| **feature 层**（流程同 epic，plan = 写需求 spec + 拆 slice）| design-v4-feature.md |
| **slice 层**（流程同 epic，plan = 技术方案 + 拆 wave）| design-v4-slice.md |
| **wave 层**（流程同 epic，plan = 写测试，execute = dev，test = 跑测试，是唯一执行型）| design-v4-wave.md |
| **机器验证机制**（wave 的测试如何不信任 agent 声明、重算 expected）| wave 文档 |
| **stale（废弃同步）**（上游 plan 改了，下游 slice/wave 怎么同步 abandonedRefs / staleLog）| stale 文档 |
| **claim**（多 agent 并行时，避免两个人同时做同一个 feature）| claim 文档 |
| **ADR**（重要决策跨 epic 复用）| ADR 文档 |
| **research 服务**（Clarification type=research 时，agent 调外部查询）| research 文档 |

---

## 11. 设计原则小结

写 epic 层时遵循的原则，后续层会继续遵循：

1. **流程统一**：8 步流程（create/clarify/plan/verify/execute/test/retrospect/closeout），所有层一致
2. **execute 是分水岭**：规划型 execute = 启动下一层（递归），执行型（wave）execute = dev
3. **verify vs test 分离**：verify 审查方案（执行前），test 验证结果（执行后）
4. **split 并入 plan**：拆到下一层不是独立步骤，是 plan 的自然产物（featureSplit 是 plan 的内部字段）
5. **顶层概念只两个维度**：4 层 × 8 步产物名。DecisionRecord / SpecSection / FR-AC 降级为各层 plan 的内部字段，不作为顶层概念暴露
6. **progressive 优先**：clarify/plan/verify/replan 可在同状态多次调用
7. **replan 不改 status**（关键）：replan 是「作废指定 plan 项 + 新增新版本 + 在下游 abandonedRefs 追加记录」，不是「回退」。epic 的节奏不被 replan 打乱
8. **replan 强制处理**：`abandonedRefs` 有未处理记录（resolvedAt 为空）的下游阻塞所有改状态 action（只读查询不阻塞），必须选 accept-replan 或 abort。accept-replan 只在 abandonedRefs 追加 resolvedAt，**不动 basedOnParent**（append-only）
9. **abort 连带子孙**：父挂了子没法活，abort 自动级联销毁所有非终态子孙
10. **定稿即不可逆**：closeout 是一次性动作，closeout 前想清楚
11. **诚实区分机器 vs 人**：能机器验证的（wave 测试）就机器验证；只能人审的（epic 方向、retrospect 是否覆盖 verify 每项）就诚实承认是人审
12. **verify/test/retrospect 是结构化业务判断，不是空壳人审**：cw 不判断业务对错（那是 agent 的事），但 cw 要 ① 定义业务判断的存储结构（`verifyJudgment`/`testJudgment`/`retrospectData`）；② 在 `nextAction.guidance` 里提示 agent 该想哪些业务问题（必要性/MECE/权衡/风险）；③ 结构校验（字段非空、test 对 verify 的引用一致、必填项齐全）。机器验「agent 有没有认真填」，人审「填得对不对」
13. **简单词汇**：字段名用英文（abandoned / replacedBy / abandonedRefs / basedOnParent / staleLog），叙述用中文大白话（已废弃 / 被替代 / 废弃引用及处理状态 / 引用了父层哪些项 / 废弃同步日志）
14. **不引入用不到的概念**：临时 wave、4 种 Clarification type、复杂的废弃机制区分——等真正需要时再加
15. **核心字段统一，专属字段 KV**（学一层会四层）：所有层共享 `verifyJudgment`/`testJudgment`/`retrospectData` 的核心字段（necessity/sufficiency/tradeoffs/risks），各层专属内容用 `layerSpecific: Record<string, unknown>` 存

---

## 附录：epic 层接口（实施参考）

```typescript
interface Epic {
  id: string;                    // "epic:auth-refactor"
  scope: "epic";
  slug: string;
  status: "created" | "clarifying" | "planning" | "verified"
        | "executing" | "tested" | "retrospected" | "closed" | "aborted";
  statusHistory: StatusEvent[];
  objective: string;             // create 时必填
  clarifications: Clarification[];           // clarify 阶段填
  plan?: EpicPlan;                          // plan 阶段填（含 split）
  verifyJudgment?: VerifyJudgment;          // verify 阶段填（业务判断）
  childUnitIds: string[];                   // execute 时填（feature ids）
  testJudgment?: TestJudgment;              // test 阶段填（对照 verifyJudgment 验收）
  retrospectData?: RetrospectData;          // retrospect 阶段填（对照 verifyJudgment 复盘）
  evidence?: Evidence;                       // closeout 时填
  basedOnParent: string[];                  // epic 是顶层，永远为空 []
  abandonedRefs: AbandonedRef[];            // epic 是顶层，永远为空 []
  payload: EpicPayload;
}

// ── plan 产物（plan 阶段）──
// featureSplit 降级为 plan 的内部字段（顶层概念不暴露 featureSplit）
interface EpicPlan {
  featureSplit: FeatureSplit[];   // feature 拆分清单
}

// ── 业务判断产物（verify / test / retrospect 阶段的核心）──
// 所有层共享核心字段（学一层会四层），专属字段用 layerSpecific KV

// verify 阶段填：执行前的业务判断（agent 产出，cw 结构校验）
interface VerifyJudgment {
  necessity: string;                  // 必要性：为什么必须做，不做的代价
  sufficiency: {                      // 充分性（MECE 检查）
    gaps: string[];                   // 识别出的遗漏维度
    overlaps: string[];               // 识别出的重叠/冗余
    meceNote: string;                 // MECE 整体判断
  };
  alternatives: string;               // 考虑过的替代方案 + 为什么没选
  tradeoffs: Tradeoff[];              // 权衡与妥协（至少 1 条，或显式声明无）
  risks: Risk[];                      // 风险点（至少 1 条，或显式声明无）
  layerSpecific: Record<string, unknown>;  // 各层专属字段（epic: featureSplitRationale 等）
}

interface Tradeoff {
  id: string;                         // "T1"，用于 testJudgment/retrospectData 引用
  decision: string;                   // 妥协了什么
  reason: string;                     // 为什么妥协
  cost: string;                       // 代价是什么
}

interface Risk {
  id: string;                         // "R1"，用于 testJudgment/retrospectData 引用
  item: string;                       // 风险描述
  severity: "high" | "medium" | "low";
  mitigation: string;                 // 缓解措施
}

// test 阶段填：执行后逐条对照 verifyJudgment 验收
interface TestJudgment {
  necessityMet: string;               // 必要性兑现了吗（对照 verifyJudgment.necessity）
  sufficiencyMet: {                   // MECE 判断兑现了吗（对照 verifyJudgment.sufficiency）
    gapsRealized: string[];           // Gap 真漏了吗
    newGaps: string[];                // verify 没发现、test 阶段才暴露的新 Gap
    meceActual: string;
  };
  alternativesReconsidered: string;   // 事后看替代方案，该不该换（对照 verifyJudgment.alternatives）
  tradeoffCostRealized: Array<{       // 逐个对照 verifyJudgment.tradeoffs
    tradeoffRef: string;              // 引用 Tradeoff.id（如 "T1"）
    costRealized: string;             // 代价实际表现
  }>;
  riskOutcome: Array<{                // 逐个对照 verifyJudgment.risks（引用一致性机器验）
    riskRef: string;                  // 引用 Risk.id
    outcome: string;                  // 实际表现：发生了/没发生/缓解措施有效
  }>;
}

// retrospect 阶段填：对照 verifyJudgment 复盘判断错了哪些
interface RetrospectData {
  reviewedItems: Array<{         // 逐项回顾记录（机器验覆盖，人审质量）
    ref: VerifyItemRef;           // 引用 verifyJudgment 的某一项（判别联合，机器可验覆盖）
    verdict: "right" | "wrong";   // 事后看这项判断对了还是错了
    note: string;                // 说明（为什么对/错）
  }>;
  // VerifyItemRef 见下方判别联合定义——区分「类名 ref」（necessity/sufficiency/alternatives）
  // 和「实例 ref」（tradeoff id / risk id），机器能精确验覆盖不漏项;
  wrongJudgments: string[];           // verify 阶段判断错的（允许为空 = 都对了）
  badTradeoffs: string[];             // 事后看不值的妥协（允许为空）
  missedGaps: string[];               // verify 没发现、test 才暴露的 Gap
  processIssues: string[];            // 流程问题（拆分不合理/Clarification 遗漏/协作问题）
  lessonsLearned: string;             // 提炼的经验（必填，不能为空）
}

// VerifyItemRef：reviewedItems.ref 的判别联合（跨层共享）
// 区分「类名 ref」（固定三项）和「实例 ref」（tradeoff/risk id），机器能精确验覆盖不漏项
// retrospect-covers-verify gate 算法：
//   verifyJudgment 的每一项都必须有一条 reviewedItems 对应——
//   {kind:"necessity"}/{kind:"sufficiency"}/{kind:"alternatives"} 各至少一条 +
//   每个 Tradeoff.id 都有一条 {kind:"tradeoff", id:...} +
//   每个 Risk.id 都有一条 {kind:"risk", id:...}
type VerifyItemRef =
  | { kind: "necessity" }
  | { kind: "sufficiency" }
  | { kind: "alternatives" }
  | { kind: "tradeoff"; id: string }   // id 对应 verifyJudgment.tradeoffs[].id（如 "T1"）
  | { kind: "risk"; id: string };       // id 对应 verifyJudgment.risks[].id（如 "R1"）

interface FeatureSplit {
  slug: string;                  // "oauth-login"
  description: string;           // 一句话描述
  dependsOn: string[];           // 依赖的其他 feature slug
}

interface Clarification {
  id: string;
  question: string;
  resolution?: string;                      // 空 = 还没想清楚
  type: "research" | "grilling";
  status: "open" | "resolved" | "abandoned"; // abandoned = 已废弃
  replacedBy?: string;                       // 替代它的新 id
}

// epic 的 transitions 规则
const EPIC_TRANSITIONS = {
  create:       { from: [],                                                  to: "created" },
  clarify:      { from: ["created", "clarifying"],                           to: "clarifying", progressive: true },
  plan:         { from: ["clarifying", "planning"],                          to: "planning",   progressive: true },
  verify:       { from: ["planning", "verified"],                            to: "verified",   progressive: true },
  execute:      { from: ["verified"],                                        to: "executing" },
  test:         { from: ["executing"],                                       to: "tested" },
  retrospect:   { from: ["tested"],                                          to: "retrospected" },
  closeout:     { from: ["retrospected"],                                    to: "closed" },
  abort:        { from: ["created", "clarifying", "planning", "verified", "executing", "tested", "retrospected"], to: "aborted", alsoAbortsChildren: true },
  // replan 不改 status（关键）：在 verified/executing 都能调，原地不动
  replan:       { from: ["verified", "executing"],                           to: undefined /* 原地 */, progressive: true, triggersImpactPropagation: true },
  // accept-replan：仅当 abandonedRefs 有未处理记录（resolvedAt 为空）才合法
  // epic 是顶层，abandonedRefs 永远为空，accept-replan 对 epic 是 no-op
  // 此 transition 仅为状态机对称性保留（每层都有 accept-replan，epic 永远用不到）
  acceptReplan: {
    from: ["created", "clarifying", "planning", "verified", "executing", "tested", "retrospected"],
    guard: "abandonedRefs.some(r => !r.resolvedAt)",   // 有未处理的废弃引用
    // 注：from 含所有非终态仅为状态机对称性；实际由 guard 兜底——
    // 非 verified/executing 的下游理论上不会有未处理 abandonedRefs（replan 只在 verified/executing 触发）
    to: undefined,  // 原地，cw 在 abandonedRefs 对应记录追加 resolvedAt + resolvedAction，basedOnParent 不动（append-only）
  },
};

// stdin 输入数据类型
interface ClarifyInput {
  clarifications: Array<{ id: string; question: string; resolution?: string; type: "research" | "grilling" }>;
}

interface PlanInput {
  featureSplit: FeatureSplit[];   // 存入 plan.featureSplit
}

// replan 的输入数据（每层定义自己的判别联合，不是跨层通用）
// 同构的是 replan 的 4 步机制（作废 + 新增 + 沿链查询 + 强制处理），不是 ReplanInput 的类型集合
// 各层能 replan 的 plan 项类型不同：
//   epic 只能 replan Clarification（它的 plan 项只有 Clarification）
//   feature 能 replan Clarification + FR/AC/UC（spec 项也是 plan 项）
//   slice 能 replan Clarification + FR/AC/UC + TC/IF/DM/ERR（继承的 + techPlan 项）
// 所以 ReplanInput 的 ReplacementContent 判别联合各层不同，各层文档定义自己的版本
interface ReplanInput {
  abandonItems: Array<{           // 要废弃的 plan 项
    id: string;                    // 要废弃的 plan 项 id（如 "D2" / "FR1"）
    refKind: "clarification" | "specItem" | "techItem";  // 引用类型，记录到下游 abandonedRefs.refKind
    replacementContent?: ReplacementContent;  // 新内容（cw 自动生成新 id，如 "D2-v2"）。空 = 纯撤销
  }>;
  newItems?: Array<NewItem>;       // 新增的独立 plan 项（不替代任何旧项，纯新增）
}

// epic 层的 ReplacementContent 判别联合——epic 只能 replan Clarification
type ReplacementContent =
  | { kind: "Clarification"; question: string; resolution?: string; type: "research" | "grilling" };

// feature 层的 ReplacementContent = epic 的 + FR/AC/UC 三种 kind（见 feature 文档附录）
// slice 层的 ReplacementContent = feature 的 + TC/IF/DM/ERR 四种 kind（见 slice 文档附录）
// 各层在 epic 这个 base 上扩展自己的 kind 分支，不跨层共享同一个类型定义

type NewItem = ReplacementContent;  // 同样判别联合，新增项的形态和替换项一致

// basedOnParent：下游 WorkUnit 引用记录（replan 查影响面的基础）
// 每个 WorkUnit 都有这个字段（epic/feature/slice/wave）
// feature create 时从 epic 继承所有 Clarification id；plan 时可减少到只留真正用到的
// epic 顶层 basedOnParent 永远为空 []

// epic 的 verify gate
const EPIC_VERIFY_GATES = [
  // 结构完整性
  "all-decisions-resolved",           // 所有 Clarification.resolution 非空
  "feature-split-non-empty",          // plan.featureSplit 至少一个
  "feature-split-dag-valid",          // 依赖关系无循环
  // 业务判断非空（验「agent 有没有填」，不验内容对错）
  "verify-necessity-non-empty",       // verifyJudgment.necessity 非空
  "verify-sufficiency-complete",      // sufficiency 三项（gaps/overlaps/meceNote）都填
  "verify-alternatives-non-empty",     // alternatives 非空（和 necessity/sufficiency 对齐，五个核心维度都机器验非空）
  "verify-tradeoffs-present",         // tradeoffs 至少 1 条，或显式声明「无」+ 理由
  "verify-risks-present",             // risks 至少 1 条，或显式声明「无」+ 理由
];

// epic 的 test gate（feature 全 closeout 后）
const EPIC_TEST_GATES = [
  "all-features-closed",              // 所有 child feature status === closed
  // test-references-verify：testJudgment 必须逐条对应 verifyJudgment 的每一类（引用一致性）
  // 校验项：necessityMet / sufficiencyMet / alternativesReconsidered 非空，
  //         每个 Tradeoff.id 都有对应的 tradeoffCostRealized.tradeoffRef，
  //         每个 Risk.id 都有对应的 riskOutcome.riskRef（不能漏验任何一类/任何一条）
  "test-references-verify",
];

// epic 的 retrospect gate
const EPIC_RETROSPECT_GATES = [
  "lessons-learned-non-empty",        // retrospectData.lessonsLearned 非空（机器 gate）
  "retrospect-covers-verify",        // reviewedItems 覆盖 verifyJudgment 每项（机器 gate，验覆盖不验 verdict）
  // 人审（机器验不了）：reviewedItems 的 verdict 是否判断得对、note 质量深不深
];
```

# cw 1.0 设计指南（给接手 agent / 人的交接文档）

> 本文档不是设计本身，是**关于设计的元文档**。讲清楚：这个项目怎么走到现在的、哪些原则不可妥协、哪些方向已经被否决、新 agent 接手怎么不踩坑。
>
> **必读顺序**：先读本指南 → 再读 design-v4-epic.md → 然后接手做事。

---

## 1. 30 秒理解这个项目

cw 1.0 是一个 agent-agnostic 编码流程编排 CLI。把开发工作拆成 4 层（epic/feature/slice/wave），每层走**完全相同的 8 步流程**（create/clarify/plan/verify/execute/test/retrospect/closeout），只是每步内容不同。

**核心精髓一句话**：学一层，会四层。execute 是分水岭——规划型 scope 的 execute = 启动下一层（递归），wave 的 execute = dev 写代码（递归出口）。

---

## 2. 项目演化史（必读，防止走回头路）

这个项目经历了 **4 个大版本 + 十几轮讨论**。每个版本的转向都有原因，新 agent 必须理解这些原因，否则会重新提出已否决的方案。

### 2.1 v1：matt 直译版

最初想整合 mattpocock 的 wayfinder 方法论。直接套用 matt 的词汇：map / ticket / effort / claimer / fog of war。

**问题**：词汇太生硬、不直观。中文软件语境下不连贯。

### 2.2 v2：修正建模版

深入读了 matt 原典 + cw 0.x 真实代码，重新建模。引入 L1-L5 五层、12 条领域不变量、统一引擎 + ScopeConfig 插件。

**问题**：每层用不同流程名（charting/draft/plan/refine），slice 继承 cw 0.x 的 19 action/12 status。「统一引擎」名不副实。

### 2.3 v3：真统一状态机版

推翻「每层不同流程」，所有 scope 共享 6 status/6 action。砍掉 collapse、砍掉 lock、砍掉 fog。

**问题**：补充设计时不自觉地用了生造词（supersede/drift/cascade/acknowledge/payload/dispatch），违背了「简单词汇」原则。slice 被定位为「协调型不走 executing」但 TDD 留在了 slice，导致全文矛盾。

### 2.4 v4：8 步递归版（当前）

用户提出关键洞察：**cw 0.x 的 8 步流程（create→...→closeout）才是精髓，应该所有 scope 都走这 8 步**。execute 对不同 scope 含义不同（规划型=进下层，wave=dev）。这是自递归结构。

v4 的改进：
- 8 步流程（不是 4 步也不是 6 步）
- split 并入 plan（不是独立 action）
- verify vs test 分离（verify 审方案 / test 验结果）
- 每层都有 retrospect（复盘自己的事）
- replan 改为「不改 status + 加决策变更记录 + 标子孙过期 + 强制处理」
- **v4 后期纠正**：verify/test/retrospect 加结构化业务判断（`verifyJudgment`/`testJudgment`/`retrospectData`）。早期版本误读了「诚实区分机器 vs 人」原则，把业务判断整个踢出流程，导致这三步退化成结构检查空壳。纠正后：cw 定义存储结构 + guidance 提示 + 结构校验，agent 产出判断内容（见 §3.7）
- **v4 二期纠正**（2026-07-20）：顶层概念统一为「4 层×8 步产物名」（Clarification/SpecSection/FR-AC 降级为 plan 内部字段）；下游引用上游统一为 `basedOnParent` 单字段（原 usedDecisions + specCoverage 合并）；废弃词用 abandoned（原 obsolete），跟踪标记用 `abandonedRefs` 结构化字段（原 boolean，含 refKind/resolvedAt/resolvedAction）；ReplanInput 用判别联合保证类型安全（FR/AC/UC/Clarification 四种 kind）；replan 步骤从 3 步改为 4 步（明确「纯撤销场景」+「沿 replacedBy 链查询不重写 basedOnParent」）

---

## 3. 核心设计哲学（7 条不可妥协）

这 7 条是经过十几轮讨论沉淀的「宪法」。任何设计决策都不能违反。

### 3.1 学一层会四层

所有 scope 共享同一个 8 步流程。差异只在每步的具体内容（由 ScopeConfig 配置）。

**反面**：让每层有不同的 action 名（charting/draft/refine），或不同数量的 status。这是 v2/v3 的错。

### 3.2 execute 是分水岭

| scope 类型 | execute 含义 | test 含义 |
|---|---|---|
| 规划型（epic/feature/slice）| 启动下一层（递归）| 子层全完成后整体验证 |
| 执行型（wave）| dev 写代码 | 跑测试 |

**只有 wave 写代码**。其他层都不直接产代码。这是「分层精化」的本质。

### 3.3 诚实区分机器 vs 人

- **机器能验证的**：wave 的测试（judgeByExpected 重算）、commit 存在性、TDD 红灯、**业务判断字段是否填齐**、**引用关系完整性**（feature 的 `fr-ac-coverage` 正向 + `ac-reachable-from-fr` 反向，防孤儿 AC）——坚决机器验证，不信任 agent 声明
- **只能人审的**：业务判断的**内容质量**（方向对不对、spec 写得好不好、技术方案合不合理）——**诚实承认是人审**，不假装机器能判

**关键区分**：机器验不了业务判断的对错，但机器**能验 agent 有没有填这些判断字段**。这两个不要混。

**反面 1**：把 plan_review 包装成机器 gate。机器判不了「技术方案好不好」，这是人审。
**反面 2**（v4 早期错误）：因为机器验不了业务判断，就把业务判断整个踢出流程，导致 verify/test/retrospect 退化成纯结构检查的空壳。正确做法是 cw ① 定义业务判断的存储结构（`verifyJudgment`/`testJudgment`/`retrospectData`）；② 在 guidance 里提示 agent 该想哪些问题；③ 结构校验（字段非空、引用一致）。**机器不能判断对错，但能强迫 agent 不能跳过业务思考**。详见 §3.7。

### 3.4 简单词汇

**字段名用英文**（代码层）：abandoned / replacedBy / abandonedRefs / basedOnParent / staleLog / progressive
**叙述用中文大白话**（文档层）：已废弃 / 被替代 / 废弃引用及处理状态 / 引用了父层哪些 plan 项 / 废弃同步日志 / 可多次调用

**禁用词清单**：fog / charting / collapse / lock / supersede / drift / cascade / acknowledge / dispatch / payload（除 EpicPayload 类名）

**反面**：v3 试图用 matt 的 RTS 游戏隐喻（fog/frontier/map），中文语境不连贯。v3 后期补充时无意识地引入 supersede/drift，被用户批评。

### 3.5 不引入用不到的概念

每个概念都要问「现在真的需要吗？」不需要就不加。

**已砍掉的概念**（等真正需要时再加）：
- 临时 wave（throwaway）：prototype/task 触发的临时执行单元——简化为「决策记录只两种 type」
- 4 种决策 type：砍到 2 种（research/grilling）
- 复杂的废弃机制区分：supersede vs deprecate 不要——统一用 abandoned（status 值）+ abandonedRefs（跟踪字段）
- fog 单独数据结构：resolution 为空就是「还没想清楚」
- lock 状态：verify 通过就是定稿，不要单独的 lock

### 3.6 append-only 历史

逆向操作不删旧，只加新记录标「已废弃」。
- **plan 项变更（Clarification / FR / AC / UC）**：旧项 `status=abandoned` + `replacedBy` 指向新版本（沿链查询，见 §6）
- **下游引用记录**：下游 WorkUnit 的 `basedOnParent` 是 append-only 历史记录，**永不重写**——cw 不动 basedOnParent，只在下游的 `abandonedRefs` **追加**一条未处理记录（含 `refKind` / `resolvedAt` / `resolvedAction`）
- **accept-replan**：只在 `abandonedRefs` 对应记录追加 `resolvedAt` + `resolvedAction: "accept"`，`basedOnParent` 原样保留（历史 id 不换）
- **abort 不删数据**：状态改 aborted，代码留 git（cw 不管仓库）；连带销毁所有非终态子孙（`alsoAbortsChildren`）
- **已 closeout 的子孙**：不追加 `abandonedRefs`（那是阻塞用的，对已终态无意义），只走 `staleLog` 日志，不阻塞不强制处理（历史就是历史）

### 3.7 verify/test/retrospect 是结构化业务判断，不是空壳人审

这是 §3.3 的延伸，因为是 v4 后期才纠正的结构性缺陷，独立成一条。

**问题**：verify/test/retrospect 这三步的核心价值是**业务判断**（方案对不对、结果好不好、下次怎么改进），不是结构检查（DAG 无环、FR 有 AC）。但 v4 早期因为「机器验不了业务判断」，把业务判断整个踢出流程，这三步退化成空壳——agent 拿到的 guidance 全是「请人审」，人审什么、怎么审、审的标准全没说。

**纠正**：职责边界划清楚——

| 角色 | 职责 |
|---|---|
| **agent** | 拿到 `nextAction.guidance` → 真正做业务判断 → 产出判断内容 |
| **cw** | ① 结构化存储（定义 `verifyJudgment`/`testJudgment`/`retrospectData` 字段 schema）；② 在 guidance 里提示 agent 该想哪些业务问题；③ 结构化校验（字段非空、引用一致、必填项齐全）|

**cw 永远不做业务判断本身**——它是 agent-agnostic 的流程编排，不替 agent 想问题，只负责把 agent 该想的**结构化地逼出来 + 存下来 + 校验齐不齐**。

**核心字段（所有层共享）+ 专属字段（layerSpecific KV）**：
- 核心字段：`necessity`（必要性）/ `sufficiency`（充分性 MECE）/ `alternatives`（替代方案）/ `tradeoffs`（权衡与妥协）/ `risks`（风险）——每层都填
- 专属字段：用 `layerSpecific: Record<string, unknown>` 存各层特有判断（epic 填 `featureSplitRationale`，feature 填 `specMeceNote`/`acVerifiabilityNote`，slice 填 `techChoiceRationale` 等）。核心结构稳定保证「学一层会四层」，专属 KV 保证各层针对性

**机器 gate 验什么**（验「填没填」，不验「对不对」）：
- 必填字段非空（如 `verifyJudgment.necessity` 不能留空）
- `tradeoffs`/`risks` 至少 1 条，或显式声明「无」+ 理由（逼思考但不逼水内容）
- `testJudgment` 必须逐条对应 `verifyJudgment`（引用一致性，防止 test 阶段跳过某些判断）
- `retrospectData.reviewedItems` 覆盖 `verifyJudgment` 每一项（机器验覆盖，不验 verdict 对错）；`reviewedItems.ref` 用 **`VerifyItemRef` 判别联合**（`{kind:"necessity"}` / `{kind:"sufficiency"}` / `{kind:"alternatives"}` / `{kind:"tradeoff", id}` / `{kind:"risk", id}`），机器能精确验覆盖不漏项，不依赖 unknown 占位
- `retrospectData.lessonsLearned` 必填（没有提炼出经验的 retrospect 是失败的 retrospect）

**test gate 的诚实区分两类引用一致**（v4 二期明确）：
- **真引用一致（机器验 id 匹配）**：`testJudgment.tradeoffCostRealized[].tradeoffRef` 必须覆盖每个 `Tradeoff.id`；`testJudgment.riskOutcome[].riskRef` 必须覆盖每个 `Risk.id`——不漏验任何一条 tradeoff/risk
- **只验非空（对应关系靠 agent 自检 + 人审）**：`necessityMet` / `sufficiencyMet` / `alternativesReconsidered` 是 string/结构体，机器只验「填了」，内容是否真对应 verifyJudgment 靠 agent 自检。诚实区分：不是所有「对应」都能机器验，只有 id 引用一致能验。

**诚实边界**：cw 验不了 agent 想得深不深——agent 填水货内容能过 gate 吗？能。这是 agent-agnostic 工具的固有边界。但 cw 保证了**agent 不能跳过业务思考**，这是 cw 能做的最大值。内容质量由 agent（或人审）负责，但人审有了结构化的东西可审，不再是面对空壳。

**反面**：
- 把 verify gate 写成「请人审方向」一句话，不给具体业务问题清单 → 退化成空壳
- 让 cw 判断「这个风险严不严重」→ 越界，cw 不做业务判断
- 每层定义完全不同的业务判断字段 → 破坏「学一层会四层」，应用核心字段 + layerSpecific KV

---

## 4. 已被否决的设计方向（黑名单）

新 agent 不要再提以下方案，每个都讨论过被否决：

| 否决方案 | 否决理由 |
|---|---|
| 每层不同流程名（charting/draft/refine）| 违反「学一层会四层」，v2/v3 的错 |
| slice 走 executing（执行型）| slice 是协调型，TDD 在 wave。执行委托给子 wave |
| split 作为独立 action | split 并入 plan，是 plan 的自然产物 |
| 4 种决策 type（research/prototype/grilling/task）| 过度设计，砍到 2 种 |
| 临时 wave（throwaway）机制 | 复杂、不常用，等真需要再加 |
| lock / unlock 状态 | verify 通过 = 定稿，不需要单独 lock |
| supersede vs deprecate 区分 | 统一用 abandoned（status 值）+ abandonedRefs（跟踪字段）|
| basedOnParent 重写为 O(1) 查询 | 违反 append-only 原则，删掉「下游当初基于哪个版本」的历史事实；沿 replacedBy 链查询性能足够，下游数量有限 |
| 用 `basedOnAbandoned: boolean` 跟踪废弃引用 | boolean 无法表达「多个上游同时废弃、哪个处理了哪个没处理」，用 `abandonedRefs: AbandonedRef[]` 结构化字段（含 refKind/resolvedAt/resolvedAction）|
| fog 单独数据结构 | resolution 为空 = 没想清楚 |
| collapse 作为 action | 就是 epic.split，机制相同 |
| 让 plan 兼容 replan（方案 B）| progressive 语义和「回退」矛盾，用独立 replan（方案 A）|
| replan 改 status（回退到 planning）| 不改 status，原地不动 + 加变更记录 |
| wave 不走完整 8 步（当提交批次）| wave 是完整 WorkUnit，有自己的 clarify/plan/verify/... |
| 19 action / 12 status（cw 0.x 原样继承）| 历史包袱，收敛到 8 action / 9 status |
| 引入多个层之外的"横向服务"作为"层"| research/glossary/ADR 是服务，不是层 |
| 把决策项当 WorkUnit | 决策项是 clarify 产物，挂在 WorkUnit collection 里 |
| **verify/test/retrospect 退化成空壳人审**（「请人审方向」一句话）| 必须列具体业务问题 + 字段定义 + 机器 gate（见 §3.7）|
| **让 cw 判断业务判断的对错**（越界）| cw 只做结构化存储 + guidance 提示 + 结构校验，业务判断由 agent 产出 |
| **每层定义完全不同的业务判断字段** | 核心字段统一（necessity/sufficiency/tradeoffs/risks），各层差异用 layerSpecific KV |

---

## 5. 4 层 × 8 步框架

### 5.1 4 个 scope

```
epic    （大目标，跨多 feature）→ 只规划
feature （单特性）→ 只规划
slice   （单 session 可完成）→ 协调型，执行委托给 wave
wave    （单次提交）→ 唯一执行型，写代码
```

### 5.2 统一 8 步流程

```
create → clarify → plan → verify → execute → test → retrospect → closeout
 创建     澄清     规划    审查      执行      测试     复盘       收尾
```

| 步骤 | 做什么 |
|---|---|
| create | 建实例，填 objective |
| clarify | 澄清要做什么 + 决策记录（问题+答案）|
| plan | 定方案 + split（拆到下一层）|
| verify | 审查方案（执行前）|
| execute | 执行（规划型=启动下层，wave=dev）|
| test | 验证结果（执行后；wave=跑测试）|
| retrospect | 复盘本层的事 |
| closeout | 收尾归档 |

### 5.3 9 个状态

created / clarifying / planning / verified / executing / tested / retrospected / closed / aborted

### 5.4 每层的 plan/execute/test 差异

| scope | plan 内容 | execute 含义 | verify 业务判断 | test 含义 |
|---|---|---|---|---|
| epic | 拆 feature（`epicPlan.featureSplit`）| 启动 feature 层 | feature 拆分 MECE / 方向必要性 / 风险 | feature 全完成后，对照 verifyJudgment 逐条验收 |
| feature | 写需求 spec（`featurePlan.spec`：SpecSection 集合）+ 拆 slice（`featurePlan.sliceSplit`）| 启动 slice 层 | spec MECE / AC 可验收性 / slice 拆分合理性 | slice 全完成后，对照 verifyJudgment 逐条验收 |
| slice | 技术方案 + 拆 wave | 启动 wave 层 | 技术选型权衡 / 接口契约风险 | wave 全完成后，对照 verifyJudgment 逐条验收 |
| wave | 写测试代码 | **dev 写代码** | （测试覆盖判断，详见 wave 文档）| **跑测试**（机器验证）|

> **顶层概念只两个维度**：4 层 × 8 步产物名（`epicPlan` / `featurePlan` / `slicePlan` / `wavePlan`）。Clarification / SpecSection / FR-AC 这些降级为各层 plan 的**内部字段**，不作为顶层概念暴露。
>
> **下游引用上游统一为 `basedOnParent` 单字段**：feature 的 `basedOnParent` 引用 epic 的 Clarification id；slice 的 `basedOnParent` 引用 feature 的 Clarification + FR/AC/UC id。机制统一，不区分 usedDecisions / specCoverage 两套字段。
>
> verify/test/retrospect 的业务判断机制见 §3.7，所有层共享核心字段（necessity/sufficiency/tradeoffs/risks）+ layerSpecific KV。

---

## 6. replan 机制（关键且易错）

replan 是这个项目最复杂的机制，必须讲清楚。

### 6.1 触发场景

子层开发中（executing 状态）发现某个决策错了。比如 feature-B 开发中发现 epic 之前定的 D2「用 OAuth」不对，要换自研。

### 6.2 replan 做什么（4 步）

1. **作废指定 plan 项**（append-only）：旧项 `status=abandoned` + `replacedBy` 指向新版本（如 D2→D2-v2）。plan 项可以是 Clarification（epic 层）或 FR/AC/UC（feature 层），机制统一
2. **新增新版本（如有 replacementContent）**：如果 `abandonItems` 指定了 `replacementContent`，cw 自动生成新 id（如 D2-v2）追加为新版本。**空 = 纯撤销**（只作废不替换）
3. **查影响面 + 追加记录**（不重写 basedOnParent）：cw 沿 `replacedBy` 链查询「子树里 `basedOnParent` 含被废弃项 id 的 WorkUnit」，在它们的 `abandonedRefs` **追加**一条未处理记录（`{refId, refKind, resolvedAt: undefined}`）。**append-only：cw 只追加记录，不动 basedOnParent**
4. **标 stale + 强制处理**：`abandonedRefs` 中有未处理记录的下游，**阻塞所有改状态 action**（只读查询不阻塞），必须二选一：
   - **accept-replan（接受新版本 / 确认不再依赖）**：cw 在 `abandonedRefs` 对应记录追加 `resolvedAt` + `resolvedAction: "accept"`，`basedOnParent` 原样保留（历史 id 不换）；查询当前生效引用时 cw 沿 replacedBy 链走到最新版本
   - **abort（整个不要了）**：连带销毁子孙（`alsoAbortsChildren`），在新版本下重建

纯撤销场景（`replacementContent` 为空）：accept-replan 的语义变成「下游确认不再依赖被废弃项」，下游只能选「确认不再依赖」或「abort」，没有「换新版本」选项。

### 6.3 关键规则

- **replan 不改 status**（原地不动，只加记录 + 在下游 abandonedRefs 追加记录）
- **replan 是 progressive**（可多次调，每次改一个或多个 plan 项；影响面沿链传播）
- **accept-replan 不动 basedOnParent**（append-only）：只在 `abandonedRefs` 对应记录追加 `resolvedAt` + `resolvedAction: "accept"`，历史引用 id 原样保留
- **abandonedRefs 是结构化字段，不是 boolean**：一条记录含 `refId` / `refKind` / `resolvedAt` / `resolvedAction`，cw 能精确知道「哪几个已处理、哪几个没处理」（boolean 做不到这点，所以用结构化字段）
- **abort 连带销毁所有非终态子孙**（父挂子没法活）
- **已 closeout 的子孙**：不追加 `abandonedRefs`（那是阻塞用的），只走 `staleLog`（只记不阻塞）
- **代码不删**（cw 不管 git，commit 留 git，新 feature 可参考）

### 6.4 多次 replan（D2→D2-v2→D2-v3）影响面查询

`basedOnParent` 是 append-only 历史记录，下游当初基于哪个版本就记哪个版本。查询影响面时，cw 遍历下游的 `basedOnParent`，对每个 id 沿 `replacedBy` 链查：

| 下游 | basedOnParent 含 | 第二次 replan（D2-v2→D2-v3）后被标？ | 原因 |
|---|---|---|---|
| A | `D2`（从未 accept）| ✓ 标 | D2 沿链 D2→D2-v2→D2-v3，D2-v2 已废弃 |
| B | `D2-v2`（已 accept 到 v2）| ✓ 标 | D2-v2 沿链 D2-v2→D2-v3，D2-v2 已废弃 |
| C | `D2-v3`（已 accept 到最新）| ✗ 不标 | D2-v3 是链尾且非废弃 |

**为什么不为了 O(1) 而重写 basedOnParent**：重写（把 D2 改成 D2-v3）虽能让查询变成 O(1) 精确匹配，但会删掉「下游当初基于 D2」的历史事实，违反 append-only 原则（§3.6）。retrospect 想追溯「这个 feature 历史上引用过哪些版本」需要这个历史。下游数量有限，沿链查询性能足够。

### 6.5 影响面只往下传（DAG 性质）

epic→feature→slice→wave，不反向。跨 epic 影响（全局架构决策）用 ADR，不在 epic replan 内。

---

## 7. 文档结构规范

新 agent 写 feature/slice/wave 文档时，**严格遵循 epic 文档的结构**：

```
1. 一分钟理解整个项目（4 层 + 8 步总览）
2. 为什么分 4 层（直接引用 epic，可省略）
3. 为什么是 8 步（直接引用 epic，可省略）
4. X 是什么（这一层的特征）
5. X 的完整流程（8 步详解，每步：做什么/产出/状态/命令/例子）
   - verify/test/retrospect 详解**必须含业务判断内容**（见 §3.7）：
     · verify：列出该层该回答的业务问题（necessity/sufficiency/tradeoffs/risks 的该层特化版）+
       layerSpecific 典型 KV + 机器 gate（结构校验 + 业务判断非空）
     · test：列出如何对照 verifyJudgment 逐条验收 + 引用一致性 gate
     · retrospect：列出如何对照 verifyJudgment 复盘判断错误 + lessonsLearned 必填 gate
     · **禁止**写成「请人审 X」一句话了事——必须列具体业务问题清单
6. X 状态机（9 状态流转图）
7. 这一层的关键概念（epic=Clarification，feature=SpecSection（作为 `featurePlan.spec` 内部字段），slice=技术方案，wave=testCases）
8. 命令一览（§8.0 命令约定直接引用，只写本层命令列表）
9. execute 递归（直接引用 epic，可省略）
10. 后续文档（更新）
11. 设计原则（继承 epic 的 15 条，补充本层特有）
附录：接口（含 verifyJudgment/testJudgment 字段，类型引用 epic 不重复定义）
```

**重点**：每步详解要给具体例子（feature 的 `featurePlan.spec` SpecSection 长咋样、wave 的 testCase 长咋样），不要空讲。**verify/test/retrospect 不能写成空壳**——必须有具体的业务问题清单 + 字段定义 + gate，不能只写「请人审」。

**v4 二期概念体系提醒**：新文档（slice/wave）写时遵循「4 层×8 步产物名」顶层体系（`slicePlan` / `wavePlan`），Clarification/SpecSection/FR-AC 作为 plan 内部字段，不再作为顶层概念。下游引用上游统一用 `basedOnParent` 单字段，废弃跟踪用 `abandonedRefs` 结构化字段（含 `refKind` / `resolvedAt` / `resolvedAction`）。

---

## 8. 词汇规范（严格遵守）

### 8.1 字段名（代码层，用英文）

| 字段 | 含义 |
|---|---|
| `abandoned` | plan 项已废弃（Clarification / FR / AC / UC 的 status 值）|
| `replacedBy` | 被谁替代（指向新版本 id，沿链查询）|
| `abandonedRefs` | 下游的废弃引用及处理状态（结构化字段 `AbandonedRef[]`，非 boolean；空数组 = 不阻塞）|
| `refKind` | 废弃引用的类型（`"clarification"` / `"specItem"`，影响下游 accept 时的决策性质）|
| `resolvedAt` | 废弃引用何时被处理（空 = 未处理、阻塞中；非空 = 已解锁）|
| `resolvedAction` | 废弃引用怎么处理（`"accept"` / `"abort"`）|
| `basedOnParent` | 下游引用了父层哪些 plan 项（`string[]`，append-only 历史记录，原 usedDecisions + specCoverage 合并）|
| `staleLog` | 废弃同步日志（只对已 closeout 下游，不阻塞不强制处理）|
| `alsoAbortsChildren` | abort 连带销毁子 |
| `progressive` | 可多次调用 |
| `resolution` | 决策的答案 |
| `clarifications` | Clarification 列表（clarify 阶段产物，原 decisionRecords）|
| `featurePlan` | feature 层 plan 产物（含 `spec` + `sliceSplit`）|
| `spec` | feature 需求 spec（SpecSection 集合，`featurePlan.spec` 内部字段）|
| `abandonItems` | replan 输入：要废弃的 plan 项（含 `id` / `refKind` / `replacementContent?`）|
| `replacementContent` | replan 输入：替换项的新内容（判别联合，`kind` 区分 Clarification/FR/AC/UC；空 = 纯撤销）|
| `NewItem` | replan 输入：新增的独立 plan 项（与 `ReplacementContent` 同判别联合形态）|
| `verifyJudgment` | verify 阶段的业务判断（necessity/sufficiency/tradeoffs/risks）|
| `testJudgment` | test 阶段对 verifyJudgment 的逐条验收（含真引用一致 + 只验非空两类）|
| `reviewedItems` | retrospect 阶段对 verifyJudgment 的逐项回顾记录（机器验覆盖，不验 verdict）|
| `VerifyItemRef` | `reviewedItems.ref` 的判别联合（类名 ref / 实例 ref，机器精确验覆盖不漏项）|
| `retrospectData` | retrospect 阶段对 verifyJudgment 的复盘（含 reviewedItems + lessonsLearned）|
| `layerSpecific` | 各层专属判断字段（KV，核心字段统一的前提下的扩展点）|
| `necessity` / `sufficiency` / `alternatives` / `tradeoffs` / `risks` | 业务判断的五个核心维度（所有层共享）|

### 8.2 叙述（文档层，用中文大白话）

| 不要写 | 要写 |
|---|---|
| 决策被 superseded / 决策被取代 | 决策已废弃 |
| 子孙 drifted | 子孙引用了被废弃的项 |
| cascade 到子孙 | 连带销毁子孙 |
| acknowledge 变更 | 接受新版本 |
| dispatch 命令 | 处理命令 |
| 输入 payload | 输入数据 |
| 标 stale | 在 abandonedRefs 追加记录 |
| 换 id（把 basedOnParent 的旧 id 改成新 id）| 沿 replacedBy 链查询，basedOnParent 不动（append-only）|
| verify 阶段「请人审方向」 | 列出该层该回答的业务问题（必要性/MECE/权衡/风险），让 agent 填 verifyJudgment |
| test 阶段「集成验证」 | 逐条对照 verifyJudgment 验收（必要性兑现了吗、每个风险实际表现、每个妥协代价）|
| retrospect 阶段「复盘做得怎么样」 | 对照 verifyJudgment 看哪些判断错了，填 reviewedItems + 提炼 lessonsLearned |

**叙述词等价说明**：在本文档中，「决策」/「Clarification」/「plan 项」三个词指代同一实体（都是 clarify 阶段产生的 Clarification），叙述层用「决策」（中文大白话）、代码层用 `Clarification`、泛指 plan 阶段产出的项时用「plan 项」（含 Clarification + FR/AC/UC）。三者等价，不是不同概念。

### 8.3 保留的开发者通用词（首次出现括注）

- **progressive**（可多次调用）
- **resolution**（答案）
- **DAG**（有向无环图）
- **HITL**（需要真人）
- **AFK**（agent 独自完成）

---

## 9. 如何做设计决策（思考方法）

新 agent 遇到设计选择时，按这些原则思考：

### 9.1 先抽象再具体

先想清楚「这个概念的本质职责」，再起名。不要先抄一个词再赋予含义。

### 9.2 用大白话检验

向一个不熟悉项目的人讲你的设计，他能不能 30 秒理解？如果不能，要么是抽象错了，要么是词太生硬。

### 9.3 区分「现在需要」vs「将来可能需要」

只做现在需要的。将来可能需要的等将来再说。YAGNI。

### 9.4 问「为什么」三次

每个设计决策问三次「为什么」，如果答不到「解决具体人类痛点」，就是过度设计。

### 9.5 从读者视角审查

写完文档后，假装自己是第一次读者，从头读一遍。哪里卡壳就改哪里。

### 9.6 诚实承认局限

机器验证不了的就承认人审，不要假装。简单不了的就承认复杂，不要伪装。

---

## 10. 反模式清单（不要这样写）

| 反模式 | 正确做法 |
|---|---|
| 引入新英文术语 | 先看 §8 词汇表能不能用已有词 |
| 让某层走特殊流程 | 所有层走相同 8 步，差异只在配置 |
| 把执行型概念塞给规划型（如让 epic 跑 test）| 规划型 test = 整体验证，不是跑测试 |
| **verify/test/retrospect 写成空壳人审**（「请人审方向」一句话了事）| 列出具体业务问题清单 + 字段定义 + 机器 gate（见 §3.7）|
| **让 cw 判断业务对错**（越界）| cw 只做结构化存储 + guidance 提示 + 结构校验，业务判断由 agent 产出 |
| **每层定义完全不同的业务判断字段** | 核心字段统一（necessity/sufficiency/tradeoffs/risks），各层差异用 layerSpecific KV |
| 用「等等」省略重要内容 | 列全，或明确说「此处略，详见 X 文档」|
| 写「灵活/强大/可扩展」等空话 | 给具体机制 |
| 不给例子只讲抽象 | 每个概念配具体例子 |
| 改一个地方不改全文 | 改完跑一致性扫描（grep 关键词）|
| 引入「中间状态」避免决策 | 做选择，明确选 A 还是 B |
| 字段名用 `unknown` 占位逃避类型检查（如 ReplanInput 不区分 FR/AC/UC/Clarification）| 用判别联合（`ReplacementContent` / `NewItem` / `VerifyItemRef`）保证类型安全，TS 能穷尽检查 |

---

## 11. 当前进度（2026-07-20）

### 已完成

- design-v4-epic.md（v4 二期重构完：顶层概念统一为 4 层×8 步产物名；basedOnParent 单字段替代 usedDecisions + specCoverage；abandonedRefs 结构化字段替代 boolean；ReplanInput 判别联合；含结构化业务判断 verifyJudgment/testJudgment/retrospectData）
- design-v4-feature.md（v4 二期重构完，和 epic 同构：featurePlan（spec + sliceSplit）；SpecSection 降级为 featurePlan.spec 内部字段；FR/AC/UC 的 status=abandoned + replacedBy 链）
- execute 递归可视化图（~/.agent/diagrams/cw-execute-recursive.svg）
- **design-v4-guide.md（本指南，已同步 v4 二期概念）**

### 待完成（按优先级）

1. **design-v4-slice.md**：流程同 epic，重点写 plan = 技术方案 + 拆 wave；verify/test/retrospect 业务判断按 §3.7 + slice 特化（技术选型权衡 / 接口契约风险等）
2. **design-v4-wave.md**：流程同 epic，重点写 plan = 写测试代码、execute = dev、test = 跑测试、机器验证机制（judgeByExpected）；wave 的业务判断偏测试覆盖（testCases 覆盖所有代码路径吗、边界条件想到没）
3. **stale 文档**：跨层影响面传播（replan 触发的子孙过期同步）
4. **claim 文档**：多 agent 并行时的并发互斥
5. **ADR 文档**：重要决策跨 epic 复用
6. **research 服务文档**：decision type=research 时调外部查询

### 历史文档（不要回退到这些）

- design.md（v1）、design-v2.md、design-v3.md：都已被取代，保留只为追溯讨论历史
- architecture.html（v1/v2/v3）：基于旧版结构，等 4 层文档定稿后重画

---

## 12. 给新 agent 的话

1. **先读本指南全文**，再读 design-v4-epic.md
2. **不要重新讨论已否决的方向**（§4 黑名单）
3. **写新文档严格遵循 §7 文档结构规范**，特别注意 verify/test/retrospect 不能写成空壳（§3.7）
4. **用词严格遵循 §8 词汇规范**，写完 grep 一遍生造词
5. **每改一个设计点，全文 grep 一致性**（之前每次改一个地方漏改其他，反复出问题）
6. **拿不准的设计，先问用户**，不要自己猜。用户喜欢被问具体问题，不喜欢看 agent 自己绕圈子
7. **用户偏好**：大白话、具体例子、简洁、不要为了完整而堆砌概念、诚实承认局限
8. **概念冲突时以 epic/feature 为准**：本指南是元文档，会随重构演进。如果指南遇到旧概念（如 `DecisionRecord` / `usedDecisions` / `obsolete` / `basedOnAbandoned: boolean`）而 epic/feature 用新概念（`Clarification` / `basedOnParent` / `abandoned` / `abandonedRefs` 结构化字段），**以 epic/feature 文档为准**。

---

## 附录：关键文件索引

| 文件 | 用途 |
|---|---|
| **本文档** | 设计指南 / 交接文档 |
| `design-v4-epic.md` | epic 层设计（模板，其他层参考）|
| `design-v3.md` | 上一版（接口定义较全，可参考但词汇已过时）|
| `cw-execute-recursive.svg` | execute 递归可视化图 |
| `src/engine/` | 通用引擎原型（v2 风格，待按 v4 重写）|
| `src/state-machine.ts` 等 | cw 0.x 实现（参考机器验证机制，不继承状态机）|
| `~/GitApp/ai-skills/mattpocock-skills/` | matt 原典（领域来源，不要直译词汇）|

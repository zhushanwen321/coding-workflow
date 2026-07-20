# cw 1.0 设计文档 v4 · feature 层

> 本文档只讲 feature 一层。流程结构与 epic 层**完全相同**（同样的 8 步、同样的状态机、同样的命令约定），差异只在每步的具体内容——feature 的 plan 写**需求 spec**（FR/AC/UC），verify 做结构化业务判断，execute **启动 slice 层**。
>
> **顶层概念体系**（和 epic 一致）：使用者的认知模型只有两个维度——**4 个层**（epic/feature/slice/wave）× **8 个步骤**（create/clarify/plan/verify/execute/test/retrospect/closeout）。每一步在每一层都有一个**同名产物**，需要区分时加层前缀（如 `featurePlan`）。`Clarification` / `SpecSection` / `FR-AC` 这些专有名词降级为各层 plan 的**内部字段**，不作为顶层概念暴露。
>
> **前置阅读**：先读 [design-v4-guide.md](./design-v4-guide.md) → 再读 [design-v4-epic.md](./design-v4-epic.md)。本文档不重复 epic 已讲透的内容（4 层总览 / 8 步来源 / execute 递归 / replan 机制 / §8.0 命令约定），只在必要处引用。
>
> **和 epic 严格同构**：机制层面（replan、abandonedRefs、reviewedItems、basedOnParent、verifyJudgment/testJudgment/retrospectData）完全一致，差异只在 plan 的内容（feature 是 spec + sliceSplit）和 verify/test/retrospect 的 layerSpecific 字段。学一层，会四层。

---

## 1. 一分钟理解 feature 层

feature 是**一个独立的用户可感知特性**，是 epic 拆出来的、slice 汇聚成的中间层。

```
epic 「重构认证系统」
  └─ feature 「OAuth 登录」       ← 本文讲这一层
       ├─ clarify: 这个特性要满足哪些需求？（澄清需求细节）
       ├─ plan:    写 spec（FR/AC/UC）+ 拆 slice
       ├─ verify:  spec 结构化业务判断（执行前审查）
       ├─ execute: 启动 slice 层（每个 slice 走自己的 8 步）
       ├─ test:    slice 全完成后，验证组合起来符合 feature spec
       └─ ...
```

**feature 和 epic 的相同点**（都是规划型 scope）：
- 不直接写代码，代码都在 wave 层
- execute = 启动下一层（feature 启动 slice，epic 启动 feature）
- test = 子层全完成后整体验证，不是跑测试

**feature 和 epic 的不同点**：

| | epic | feature |
|---|---|---|
| **clarify 产物** | `Clarification`（架构方向：用 OAuth 还是 session？）| `Clarification`（需求细节：支持哪些登录方式？错误态怎么展示？）|
| **plan 产物** | `featureSplit`（feature 拆分清单 + 依赖 DAG）| **`featurePlan`：`spec`（SpecSection 集合）+ `sliceSplit`（slice 拆分清单）** |
| **verify 机器 gate** | 决策全填 + feature DAG 无环 | **FR-AC 覆盖 + slice DAG 无环** |
| **execute 启动** | feature 层 | slice 层 |
| **上游** | 无（顶层）| epic（基于 epic 的 Clarification）|

**一句话**：feature 把 epic 的「大目标」翻译成下游 slice 能照着做的「需求图纸」（spec），自己不写代码。

---

## 2. 为什么需要 feature 层

epic 层只决定「做哪些大块」和「关键架构决策」，粒度太粗，slice 没法直接接手。中间缺一层把决策翻译成具体需求的环节：

- epic 说「用 OAuth」——但 slice 要知道**支持哪些 OAuth 提供商、错误态怎么展示、token 存哪**
- epic 说「支持 admin/user/guest 三种角色」——但 slice 要知道**每种角色具体能做什么、权限边界在哪**

这些「需求细节」就是 feature 的 spec 要回答的问题。feature 层的存在意义：**把 epic 的方向性决策，精化成 slice 可以直接施工的需求规格**。

为什么是 feature 这一层而不是 slice 自己写 spec：一个 feature 的需求通常跨多个 slice（前端 + 后端 + 集成），如果每个 slice 各写各的 spec，会出现需求矛盾、AC 重复或遗漏。feature 层统一写 spec，slice 只通过 `basedOnParent` 引用自己负责的部分，保证需求一致性。

---

## 3. feature 是什么

feature 是**一个用户可感知的独立特性**，由 epic 拆分产生，自己再拆成若干 slice。

典型 feature 例子（epic = 「重构认证系统」）：
- `oauth-login`：OAuth 登录（支持 GitHub / Google）
- `session-management`：会话管理（token 存取、过期、续期）
- `permission-control`：权限控制（基于角色的访问控制）

feature 的核心特征：
- **单特性边界**：一个 feature 只做一个用户可感知的特性，边界清楚（能一句话说清「这个 feature 做完了，用户能 X」）
- **跨多个 slice**：一个 feature 通常拆成多个 slice（前端 + 后端 + 集成联调等）
- **需求驱动**：feature 的核心产物是 spec（需求规格），下游 slice 照 spec 施工
- **只规划不写代码**：feature 的 execute 不是 dev，是启动 slice 层。feature 自己永远不产出代码

---

## 4. feature 的完整流程（8 步详解）

> 流程结构和 epic 完全一样（create → clarify → plan → verify → execute → test → retrospect → closeout）。下面每步只讲 **feature 特有的内容**，通用规则见 epic 文档 §5。

### 4.1 第 1 步：create（创建）

**做什么**：建一个 feature 实例，写下 **objective**（这个 feature 完成后用户能做什么，1-2 句话），并从父 epic 继承 Clarification 引用。

**objective 例子**（feature = `oauth-login`）：
> 用户能用 GitHub 或 Google 账号登录系统，登录成功后获得会话 token，失败时看到清晰的错误提示。

**继承机制**（和 epic §7.3 完全同构）：
- feature 的 `parentUnitId` 指向父 epic
- cw 把父 epic 当前的 `clarifications` 的 id 全量拷贝到 feature.`basedOnParent`（feature plan 时可以减少——只留自己真正用到的）
- 这些继承来的 Clarification 是 feature spec 的初始约束（feature 写 spec 时不能违反它们）

**状态**：`created` → 进入 `clarifying`

**命令**：
```bash
cw feature create oauth-login \
  --from-epic epic:auth-refactor \
  --objective "用户能用 GitHub 或 Google 账号登录..."
```

### 4.2 第 2 步：clarify（澄清需求细节）

**做什么**：识别这个 feature 的需求要定清楚，必须先回答的问题（**Clarification**——clarify 阶段的产物），逐个给答案。机制和字段同 epic §5.2 / §7.2，不再重复。

feature 的 clarify 典型问题（**需求维度**，不是技术维度——技术选型是 slice 的事）：
- 「支持哪些 OAuth 提供商？」→「GitHub + Google（一期），预留扩展位」
- 「登录失败时怎么给用户反馈？」→「区分三类错误：网络错误 / 账号未授权 / 提供商服务不可用，文案不同」
- 「token 过期后自动续期还是要求重新登录？」→「access token 自动续期，refresh token 过期要求重新登录」

**research vs grilling**（同 epic）：
- `research`：查外部资料能答的（如「OAuth 2.0 的 PKCE 流程是什么」查 RFC）
- `grilling`：必须人回答的产品决策（如「是否支持微信登录」）

**和 epic clarify 的区别**：epic 澄清的是**架构方向**（用 OAuth 还是 session），feature 澄清的是**需求细节**（支持哪些提供商、错误态怎么分）。feature clarify 的产物会被 plan 阶段写进 spec 的 SpecSection（spec 的 `decisions` 章节直接引用 Clarification，避免双份记录）。

**状态**：`clarifying`

**命令**：
```bash
cw feature clarify feature:oauth-login      # progressive，可多次调用
# 输入数据从 stdin 读：{ clarifications: [...] }
```

### 4.3 第 3 步：plan（写 spec + 拆 slice）

**做什么**：基于 clarify 的 Clarification，**写需求 spec**（SpecSection 集合）+ **拆 slice**。这是 feature 层最核心的一步。

**plan 的两个产物**（都存在 `featurePlan` 里，作为内部字段）：

#### 产物 1：需求 spec（`featurePlan.spec`：SpecSection 集合）

spec 是 feature 留给下游 slice 的「需求图纸」。cw 0.x 已经定义了 SpecSection 体系，feature 直接用（详见 §5）。一个典型的 feature spec 包含：

| SpecSection 类型 | 作用 | 例子（oauth-login）|
|---|---|---|
| `functionalRequirements`（FR）| 系统要能做什么 | `FR1: 用户能用 GitHub 登录` |
| `acceptanceCriteria`（AC）| 怎么算做完 | `AC1.1: 点 GitHub 登录 → 3 秒内跳转回首页已登录` |
| `businessCases`（UC）| 完整使用场景 | `UC1: 未登录用户 → GitHub 授权 → 回首页已登录` |
| `decisions` | 技术/产品决策（引用 clarify 的 Clarification）| `D1: token 存 httpOnly cookie` |
| `outOfScope` | 明确不做的事 | `微信登录、手机号登录` |
| `complexity` | 复杂度评级（可选，主观标注）| `medium：涉及 OAuth 流程 + token 管理，无外部系统对接` |
| `goals` | 可衡量目标 | `登录成功率 ≥ 99%` |
| `background` / `constraints` | 背景和约束（md 章节）| `现有 session 机制要保留兼容旧 API` |

> **关于 complexity**：这是 feature 写 spec 时主观标的可选项，用于辅助 slice 拆分和风险判断。没有强制标准，agent 可选填。

**FR-AC 强引用**（详见 §5.2）：每个 FR 显式声明它对应的 AC id（`FR.ac: string[]`），让 FR-AC 覆盖 gate 能机器验证（每个 FR 至少 1 条 AC）。

#### 产物 2：slice 拆分清单（`featurePlan.sliceSplit`）

基于 spec，把这个 feature 拆成若干 slice（split 在 plan 里做，作为 `featurePlan.sliceSplit` 内部字段）：

| slice slug | 描述 | 依赖 |
|---|---|---|
| `oauth-backend` | OAuth 后端接口（token 交换、用户信息拉取）| — |
| `oauth-frontend` | OAuth 前端（登录按钮、回调处理、错误展示）| `oauth-backend` |
| `oauth-integration` | 端到端联调 + UC1 验收 | `oauth-backend`, `oauth-frontend` |

> slice 负责哪些 FR/AC/UC 的引用关系不在 SliceSplit 里存——slice create 时 cw 把 feature 当前的 FR/AC/UC id 全量拷贝到 slice.`basedOnParent`（slice plan 时可减少到只留自己真正负责的），机制见 §4.5。
>
> **TODO（继承机制，同 epic §7.3）**：basedOnParent 的「全量拷贝再减少」继承机制是临时语义，待重新设计（见 reviewer epic C3），本文档及 §4.5 描述的是当前临时机制。

**slice 拆分的判据**（不给死规则，只给判据 + 典型维度）：

判据（必须同时满足）：
- **单 session 可完成**：一个 slice 的所有 wave 加起来，一个开发 session 能做完。**单 session 是软锚点**（指一次集中工作时段，典型 2-4 小时），不是硬性卡死的规则。未来可考虑跨 feature retrospect 累积实际单 session 完成数据作为校准参考，但当前 v4 未实现。
- **边界清楚**：slice 之间不重叠，每个 slice 能独立验收
- **可独立验收**：slice 有自己的 AC，能单独判断做完没

典型拆分维度（按 feature 特点选，不强制）：
- **按技术层**：后端接口 / 前端组件 / 集成联调（适合全栈 feature）
- **按用例**：UC1 完整实现 / UC2 完整实现（适合用例边界清楚的 feature）
- **按交付优先级**：MVP 先行 / 增强后行（适合可增量交付的 feature）

**产出**：`featurePlan`（`spec` + `sliceSplit`）

**状态**：`planning`

**命令**：
```bash
cw feature plan feature:oauth-login          # progressive，可多次调用
# 输入数据从 stdin 读：
# {
#   spec: SpecSection[],            # spec 内容（存入 featurePlan.spec）
#   sliceSplit: SliceSplit[]         # slice 拆分清单（存入 featurePlan.sliceSplit）
# }
```

### 4.4 第 4 步：verify（spec 审查）

**做什么**：在启动 slice 层**之前**，对 plan 阶段的 spec 和 slice 拆分做**结构化的业务判断**。机制同 epic verify（见 [epic 文档 §5.4](./design-v4-epic.md#54-第-4-步verify审查规划)）——cw 定义存储结构 + guidance 提示 + 结构校验，**业务判断内容由 agent 产出**。

**guidance 提示 agent 回答的问题**（feature 特化版）：

| 维度 | feature 要回答的问题 |
|---|---|
| **必要性（necessity）** | 这个 feature 对父 epic objective 的贡献是什么？没它行不行？ |
| **充分性（sufficiency，MECE）** | spec 里的 FR 加起来覆盖了 feature 的完整需求吗？有遗漏的功能点吗？有重叠的 FR 吗？slice 拆分覆盖了所有 FR/AC 吗？ |
| **替代方案（alternatives）** | spec 有没有过度设计？有没有更简单的实现路径？slice 拆分考虑过其他维度吗？ |
| **权衡与妥协（tradeoffs）** | 哪些 FR 是妥协（如性能换简单、完整性换交付速度）？哪些 AC 是放宽的（如响应时间从 1s 放到 3s）？每个妥协的代价？ |
| **风险（risks）** | spec 层面的风险 + 跨 slice 协调风险（接口契约对得上吗、跨 slice 共享数据/状态有无竞争、依赖链上哪环最易延误）。**注意：单个 slice 的内部技术不确定性不在 feature verify 评估**——那是 slice 自己 verify 的事（见 slice 文档）。**判据**：如果某个风险的触发或缓解需要多个 slice 协同动作，归 feature；如果单个 slice 自己就能应对，归 slice。边界模糊时优先归 feature（feature 是上层，兜底）|

feature 专属判断填入 `verifyJudgment.layerSpecific`（KV），典型字段：

| layerSpecific 字段 | 含义 | 校验方式 |
|---|---|---|
| `specMeceNote` | spec 的 MECE 整体结论 | 人审判断，机器只验非空 |
| `sliceSplitRationale` | 为什么这么拆 slice（选了哪个维度、为何不用其他维度）| 人审判断，机器只验非空 |
| `acVerifiabilityNote` | AC 是否真的可验收（有没有「快速」「友好」这种无法验证的 AC）| 人审判断，机器只验非空 |
| `consistencyNote` | spec 各章节之间的一致性自检（FR/AC/UC 是否对得上、有无矛盾）| 人审判断，机器只验非空 |

> **所有 layerSpecific 字段都是 agent 的人审判断，gate 只验非空，不验内容**。spec 的一致性自检（原 `spec-no-contradiction` gate）不再作为机器 gate——机器判不了「两个 FR 是否真的矛盾」，那是 agent 自检的职责，放进 `consistencyNote` 让 agent 显式回答。
>
> **机器能辅助的部分（TODO，后续迭代，追踪号 feature-M4）**：AC 的 `verification` 字段是结构化的（`"unit" | "manual" | "review"`），v4 可后续加机器辅助——如 `verification=unit` 时要求 condition 含可测动词、模糊词（"快速"/"友好"）warning。当前 v4 先诚实承认全人审，机器辅助留后续。

**机器 gate**（同 epic，验结构不验内容）：
- **结构完整性**：`fr-ac-coverage`（每个 FR 的 `ac` 数组非空且 id 都存在，正向）+ `ac-reachable-from-fr`（每个 active AC 至少被一个 active FR 引用，反向，防孤儿 AC）/ `ac-non-empty` / `slice-split-non-empty` / `slice-split-dag-valid`
- **业务判断非空**：`verifyJudgment.necessity` 非空、`sufficiency` 三项填齐（gaps/overlaps/meceNote）、`tradeoffs` 至少 1 条（或显式声明「无」+ 理由）、`risks` 至少 1 条（或显式声明「无」+ 理由）

**诚实说明**：同 epic——cw 验「agent 有没有填这些字段」，验不了「spec 写得好不好、AC 写得对不对」。内容质量由 agent（或人审）负责。判断存在 `verifyJudgment` 里，是 test/retrospect 对照的基础。

**通过的含义**：spec 定稿，可以启动 slice 层了。

**状态**：`verified`

**命令**：
```bash
cw feature verify feature:oauth-login        # progressive，可多次调用
# 输入数据从 stdin 读：{ verifyJudgment: {...} }
```

### 4.5 第 5 步：execute（执行 = 启动 slice 层）

**做什么**：feature 自己不写代码，它的 execute = **启动 slice 层**（机制和 epic execute 启动 feature 层完全对称）：

1. 根据 plan 阶段的 `sliceSplit` 拆分清单，为每个 slice 创建实例
   - 每个 slice 的 `parentUnitId` 指向这个 feature
   - 每个 slice 的 `basedOnParent` 从 feature 继承：cw 把 feature 当前的 `clarifications` id（feature 自己 clarify 产生的）+ feature spec 里的 FR/AC/UC id（`featurePlan.spec` 里的）**全量拷贝**到 slice.`basedOnParent`（slice plan 时可以减少到只留自己真正负责的）。**统一存在 `slice.basedOnParent`**，不区分 Clarification 引用和 spec 项引用两套字段（这是 v4 的统一语义，见 epic §7.3）
2. 每个 slice 开始走自己的 8 步流程

**feature 在 execute 阶段做什么**：等。等所有 slice 走完它们的 8 步流程，全部 closeout 后，feature 进入 test 阶段。

**slice 怎么持有 feature spec**（统一引用机制，取代旧设计的 specCoverage）：

slice 不快照整个 spec，只记 `basedOnParent`（引用了 feature plan 的哪些项——Clarification id + FR/AC/UC id 统一存在这一个字段里）。如果 feature 改了 spec（变更/撤销某个 FR/AC），走 **统一 replan**（见 §6）——feature 作废旧 FR/AC（`status=abandoned` + `replacedBy`），cw 反查子树里 `basedOnParent` 含被废弃 FR/AC id 的 slice，在它们的 `abandonedRefs` 追加记录，强制处理（accept-replan 或 abort）。机制层面和 epic 改 Clarification 完全一致。

**状态**：`executing`（长状态，可能跨多个 session）

**命令**：
```bash
cw feature execute feature:oauth-login       # 启动 slice 层
```

### 4.6 第 6 步：test（整体验证）

**做什么**：所有 slice 都 closeout 后，**逐条对照 verify 阶段的业务判断**验收。机制同 epic test（见 [epic 文档 §5.6](./design-v4-epic.md#56-第-6-步test整体验证)）。

**guidance 提示 agent 对照回答**（feature 特化）：

| verify 阶段的判断 | feature test 要回答 |
|---|---|
| 当初说的「必要性」（这个 feature 对 epic 的贡献）| 贡献真的兑现了吗？ |
| 当初判断的 spec Gap / 重叠 | 这些 Gap 真的漏了吗？slice 实现时暴露了新 Gap 吗？重叠实际发生了吗？ |
| 当初考虑但没选的替代方案（alternatives）| 事后看当初没选的那个方案，其实应该选吗？ |
| 当初每个妥协 + 代价 | 代价真的付出了吗？（如「放宽响应时间」实际影响符合预期吗）|
| 当初标记的跨 slice 协调风险 / spec 层面风险 | 实际表现如何？（接口契约对得上吗、依赖链延误了吗）|

agent 把对照结论填入 `workUnit.testJudgment`，每个字段**必须对应 `verifyJudgment` 的一项**（necessity 对 necessity、sufficiency 对 sufficiency、alternatives 对 alternatives、每个 tradeoff 有对应的 costRealized、每个 risk 有对应的 outcome）。

**机器 gate**：
- **结构完整性**：`all-slices-closed`
- **引用一致性**（诚实区分两类，照抄 epic §5.6）：
  - **真引用一致（机器验 id 匹配）**：`testJudgment.tradeoffCostRealized` 里的 `tradeoffRef` 必须覆盖 `verifyJudgment` 每个 Tradeoff.id；`testJudgment.riskOutcome` 里的 `riskRef` 必须覆盖 `verifyJudgment` 每个 Risk.id——不漏验任何一条 tradeoff/risk
  - **只验非空（对应关系靠 agent 自检 + 人审）**：`necessityMet` / `sufficiencyMet` / `alternativesReconsidered` 是 string/结构体，机器只验「填了」，内容是否真对应 verifyJudgment 靠 agent 自检

**诚实说明**：跨 slice 的端到端验证（如 UC1 全流程）在这里做——单个 slice 只能验自己负责的部分。对照结论由 agent 判断，cw 只验「该对照的都对照了」。

**如果没通过**：可能要回到某个 slice 修，或发现 spec 有问题（少见，verify 已审过；真发生就走 replan）。

**状态**：`tested`

**命令**：
```bash
cw feature test feature:oauth-login
# 输入数据从 stdin 读：{ testJudgment: {...} }
```

### 4.7 第 7 步：retrospect（复盘）

**做什么**：复盘 feature 层自己的事。**核心动作是对照 verifyJudgment，看哪些判断事后证明错了**（机制同 epic retrospect，见 [epic 文档 §5.7](./design-v4-epic.md#57-第-7-步retrospect复盘)）。

**guidance 提示 agent 回答**（feature 特化）：

| 复盘维度 | feature 要回答的问题 |
|---|---|
| **判断错误（wrongJudgments）** | verify 阶段哪些 spec/slice 判断错了？（标的高风险 FR 实际很容易、判断的 Gap 不存在、认为必要的 FR 实现完发现没用）|
| **不良妥协（badTradeoffs）** | 哪些 AC 放宽事后看不值得？哪些 FR 妥协代价超预期？ |
| **遗漏的 Gap（missedGaps）** | verify 没发现、slice 开发才暴露的 Gap？为什么 verify 没发现？ |
| **流程问题（processIssues）** | spec 写得好吗？（漏 AC / FR 太大 / UC 不贴近真实场景）；slice 拆分合理吗？（太碎 / 太大 / 依赖搞错返工）；需求澄清够吗？（开发一半才发现没定清楚）|
| **提炼经验（lessonsLearned）** | 下次写类似 feature 的 spec，最该记住的 1-3 条经验？ |

agent 把复盘结论填入 `workUnit.retrospectData`。其中 `reviewedItems` 是**结构化逐项回顾记录**——对 verifyJudgment 的每一项（necessity/sufficiency/alternatives + 每个 tradeoff id + 每个 risk id），必须有一条 reviewedItems 记录，机器验「覆盖」（不验 verdict 对错）。`reviewedItems.ref` 是 **`VerifyItemRef` 判别联合**（`{kind:"necessity"}` / `{kind:"sufficiency"}` / `{kind:"alternatives"}` / `{kind:"tradeoff", id}` / `{kind:"risk", id}`，定义见 epic 附录），`retrospect-covers-verify` gate 按 kind 分桶验覆盖。`wrongJudgments` / `badTradeoffs` / `missedGaps` 允许为空（说明判断都对了），但 `lessonsLearned` 必须非空——**没有提炼出经验的 retrospect 是失败的 retrospect**。

**机器 gate**：
- `retrospectData.lessonsLearned` 非空（`lessons-learned-non-empty`）
- `retrospectData.reviewedItems` 覆盖 `verifyJudgment` 的每一项（`retrospect-covers-verify`，机器验）：每个 necessity/sufficiency/alternatives + 每个 Tradeoff.id + 每个 Risk.id 都有一条对应的 reviewedItems 记录

**人审 gate**（机器验不了，诚实承认）：
- `reviewedItems` 的 `verdict`（判断对/错）和 `note`（说明）的内容质量——机器只验「每项都有记录」，验不了「回顾得对不对、深不深」

**产出**：retrospect 记录（结构化经验沉淀，跨 feature 复用）

**状态**：`retrospected`

**命令**：
```bash
cw feature retrospect feature:oauth-login
# 输入数据从 stdin 读：{ retrospectData: {...} }
```

### 4.8 第 8 步：closeout（收尾）

**做什么**：
- 写 evidence（feature 的最终交付证据：spec 最终版、slice 列表、retrospect）
- feature 进入 `closed`（归档，不再变动）
- 重要的 feature 级决策升级为 ADR（跨 feature 复用，如「所有登录类功能统一用 OAuth」）

**feature 的使命到此结束**。

**状态**：`closed`（真终态，不可 reopen）

**命令**：
```bash
cw feature closeout feature:oauth-login
```

---

## 5. SpecSection（featurePlan.spec 的组成单元）

### 5.1 SpecSection 是什么

SpecSection 是 `featurePlan.spec` 的组成单元（不再是顶层概念）。cw 0.x 已经定义了完整的 SpecSection 体系（`src/types.ts`），feature 直接继承，不重新发明。

SpecSection 分三类：

**结构化章节**（cw 校验内容 + report 模板渲染）：

| 类型 | 作用 | 出现率（cw 0.x 统计）|
|---|---|---|
| `functionalRequirements`（FR）| 系统要能做什么 | 几乎所有 spec |
| `acceptanceCriteria`（AC）| 可判定的完成条件 | 84% |
| `businessCases`（UC）| Actor 视角的使用场景 | 42% |
| `decisions` | 技术/产品决策（引用 Clarification）| 25% |
| `complexity` | 复杂度评级（可选，主观标注，辅助 slice 拆分和风险判断）| — |
| `outOfScope` | 明确不做的事（防范围蔓延）| — |
| `goals` | 可衡量的业务目标 | 19% |

**md 章节**（cw 只存不校验 + report mdToHtml）：
- `background`：背景说明
- `constraints`：约束条件

**兜底章节**（agent 自定义章节名）：
- `section`：sectionName + content，用于上述类型覆盖不到的特殊需求

**设计依据**：cw 0.x 对 6 个项目 118 个 spec.md 的内容模式统计。feature 文档直接用这套体系，不简化（每种都有实用场景）也不扩展（YAGNI）。

### 5.2 FR-AC 强引用

**问题**：cw 0.x 现状里 FR 和 AC 是两个并列的 section，没有显式关联。feature verify 的 `fr-ac-coverage` gate 想验「每个 FR 都有至少 1 条 AC」，但 FR 和 AC 怎么对应不上来——只能靠自然语言子串匹配（cw 0.x 现状，只 warning 不阻断），违反「机器验证」原则。

**v4 解决**：给 FunctionalRequirement 加 `ac: string[]` 字段，显式声明这个 FR 对应哪些 AC id：

```typescript
export interface FunctionalRequirement {
  id: string;          // "FR1"
  title: string;       // "用户能用 GitHub 登录"
  detail: string;      // 详细描述
  ac: string[];        // ["AC1.1", "AC1.2"] —— 强引用 AC id
  status: "active" | "abandoned";  // 和 Clarification 对称，支持 replan
  replacedBy?: string;              // 替代它的新 id（replan 时填）
}
```

这样 `fr-ac-coverage` gate 能纯结构验证：遍历所有 FR，检查每个 FR 的 `ac` 数组非空且每个 id 都在 AC section 里存在。不靠自然语言匹配。

**AC 不反向引用 FR**（避免双向同步负担）：从 FR 查 AC 用 `FR.ac`，从 AC 查 FR 用 `filter(FR.ac.includes(acId))`。

**诚实边界**（重要）：FR-AC 强引用 + `ac-reachable-from-fr` 一起解决**「引用关系的正向与反向完整性可机器验」**（每个 FR 至少有 1 条 AC 指着它、每个 AC 至少被一个 FR 引用）——但它们解决不了**「AC 写得好不好」**（AC 本身是否可验收、是否覆盖边界情况、措辞是否清晰）。后者是 agent 自审 + `acVerifiabilityNote` 人审判断，不是 gate 的事。详见原则 17。

### 5.3 SpecSection 不是独立工作单元

和 epic 的 Clarification 一样，SpecSection **只是 feature plan 阶段产生的列表项**，挂在 feature 上：

```
feature
  ├─ objective: "..."
  ├─ status: planning
  ├─ clarifications: [...]          // clarify 阶段填（feature 自己的 Clarification）
  ├─ plan: {                        // plan 阶段填（含 spec + sliceSplit 作为内部字段）
  │    spec: [                      // featurePlan.spec
  │      { type: "functionalRequirements", items: [...] },
  │      { type: "acceptanceCriteria", items: [...] },
  │      { type: "businessCases", items: [...] },
  │      ...
  │    ],
  │    sliceSplit: [...]            // featurePlan.sliceSplit
  │  }
  └─ childUnitIds: [...]            // execute 时填（slice ids）
```

它没有自己的状态机、不是独立 Unit。feature closeout 后它跟着 feature 一起归档（重要的会被 slice 的 `basedOnParent` 引用，或决策类 section 升级为 ADR）。

### 5.4 spec 变更走统一 replan

feature 的 spec 不是 immutable——feature 在 `verified` / `executing` 状态都可能改 spec（开发中发现需求要调整）。

**统一机制**（和 epic 改 Clarification 完全一致）：spec 变更（修改/撤销某个 FR/AC/UC）走 `cw feature replan`：

- `abandonItems` 里填要作废的 FR/AC/UC id（epic 层填的是 Clarification id，feature 层填的是 FR/AC/UC id，**机制统一、只是 id 的语义不同**）
- cw 作废旧 FR/AC（`status=abandoned` + `replacedBy` 指向新版本）+ 新增新版本（如有 `replacementContent`）
- 反查下游 slice 的 `basedOnParent` 含被废弃 FR/AC id 的，在它们的 `abandonedRefs` 追加记录
- 被标的 slice **阻塞所有改状态 action**（只读查询不阻塞），强制二选一：accept-replan（接受新 spec）或 abort（重做）

不引入 spec 快照/snapshot 双轨机制——统一 replan 已覆盖「上游变 → 下游跟着变」的完整场景。详见 §6 和 [epic 文档 §8.2](./design-v4-epic.md#82-replan局部打补丁影响面传播)。

#### 与 cw 0.x SpecVersion / SpecDecision 机制的关系（迁移说明）

cw 0.x 已有两个相关机制，v4 需要理清关系：

| cw 0.x 机制 | v4 处理 |
|---|---|
| `SpecVersion` + `specHistory`（整 spec 快照替换，replaceSpecSections 时整体快照推入历史）| **v4 用逐项 replan 替代**。逐项 replan 更符合 append-only 原则（不覆盖旧版本，只标 abandoned + 新增新版本）。**TODO（迁移）**：cw 0.x 的 SpecVersion/specHistory/replaceSpecSections 标 deprecated，按逐项 replan 重写。retrospect 追溯 spec 变更轨迹改为走基于OnRefs + Clarification 的 status/replacedBy 链。|
| `SpecDecision`（decisions 章节的元素，`{id, decision, rationale}`）| **SpecDecision 定位为 Clarification 的 spec 层投影**：decisions 章节不独立持有 status/replacedBy，它的内容引用 Clarification（**TODO**：给 SpecDecision 加 `sourceClarification?: string` 字段，记录它投影自哪个 Clarification）。Clarification 被 replan 时，decisions 章节自动跟随（不独立参与 replan）。这样避免「Clarification 能 replan 但 SpecDecision 不能」的不一致。|

> **本节标 TODO 的是实现侧迁移工作**，不影响 v4 设计文档的逻辑自洽。设计层面，v4 的 spec 变更机制是「逐项 replan + SpecDecision 作为 Clarification 投影」，清晰且统一。

---

## 6. feature 状态机

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

**和 epic 状态机完全相同**（这是「学一层会四层」的体现）。关键规则同 epic：
- `clarify` / `plan` / `verify` / `replan` 是 progressive
- `execute` 是长状态（等所有 slice 完成，可能跨多 session）
- `test` / `retrospect` / `closeout` 是一次性
- `closeout` 后真终态，不可 reopen
- `abort` 连带销毁所有非终态子孙（slice / wave）
- `replan` 不改 status（关键）：只做四件事——(a) 作废指定 plan 项（旧 FR/AC `status=abandoned` + `replacedBy` 指向新版本）；(b) 新增新版本（如有 `replacementContent`）；(c) 反查子树里 `basedOnParent` 含被废弃项 id 的 slice（**沿 replacedBy 链查询**，不重写 basedOnParent，机制同 epic §8.2），在它们的 `abandonedRefs` 追加未处理记录；(d) 阻塞这些下游（有未处理记录），强制 accept-replan 或 abort

**已 closeout 的 slice**（边界场景）：feature replan 时如果某个 slice 已经 closed（真终态），cw 不追加 `abandonedRefs`（那是阻塞用的），只走 `staleLog`（只记不阻塞，不强制处理）——机制同 epic §8.2「已 closeout 的下游」段。这是 feature 层最常见的边界场景（一个 feature 拆了 N 个 slice，前 N-1 个 closeout 了，最后一个在跑，这时 feature 发现 spec 要改）。

---

## 7. feature 的命令一览

> 命令约定（参数传递 / 输出格式 / exit code 语义）见 [epic 文档 §8.0](./design-v4-epic.md#80-命令约定所有-scope-通用)，本文档不重复。

```bash
# 主流程（8 步）
cw feature create <slug> --from-epic <epic-id> --objective "..."
#   --slug / --from-epic / --objective 必填
#   继承父 epic 的 Clarification（全量拷贝 id 到 basedOnParent）

cw feature clarify <id>                              # progressive
#   输入数据从 stdin 读：{ clarifications: [...] }
#   需求维度的澄清（支持哪些登录方式、错误态怎么分）

cw feature plan <id>                                 # progressive
#   输入数据从 stdin 读：{ spec: [...], sliceSplit: [...] }
#   spec 存入 featurePlan.spec，sliceSplit 存入 featurePlan.sliceSplit

cw feature verify <id>                               # progressive
#   机器 gate：fr-ac-coverage / ac-non-empty / slice-split-non-empty / slice-split-dag-valid
#   业务判断非空（同 epic）

cw feature execute <id>                              # 启动 slice 层
#   根据 sliceSplit 创建 slice 实例，每个 slice 进入 created
#   每个 slice 的 basedOnParent 继承 feature 的 Clarification id + FR/AC/UC id

cw feature test <id>                                 # slice 全 closeout 后整体验证
cw feature retrospect <id>                           # 复盘
cw feature closeout <id>                             # 一次性，不可逆

# 旁路（同 epic §8.2）
cw feature abort <id>                                # 任何非终态 → aborted，连带销毁所有非终态子孙
cw feature replan <id>                               # progressive，不改 status
#   输入数据从 stdin 读：{ abandonItems: [...], newItems?: [...] }（详见附录 ReplanInput）
#   abandonItems 可含 Clarification id 或 FR/AC/UC id（统一机制）
#   做四件事：(a) 旧项 status=abandoned + replacedBy 指向新版本
#             (b) 如有 replacementContent，新增新版本（cw 自动生成新 id 如 FR1-v2）
#             (c) 反查子树里 basedOnParent 含被废弃项 id 的 slice（**沿 replacedBy 链查询**，不重写 basedOnParent，机制同 epic §8.2），在 abandonedRefs 追加未处理记录
#             (d) 这些下游阻塞所有改状态 action（只读查询不阻塞），强制 accept-replan 或 abort
#   详见 epic 文档 §8.2

cw feature accept-replan <id> --reason "为什么接受新决策"
#   仅当 feature 自己的 abandonedRefs 有未处理记录时有效（被上游 epic replan 标了）
#   cw 在 abandonedRefs 对应记录追加 resolvedAt + resolvedAction，basedOnParent 不动（append-only）

# 查询（不走状态机）
cw feature status <id>                               # 单个 WorkUnit 快照
cw feature list [--status planning] [--epic <epic-id>]   # feature 列表
cw feature show <id>                                 # 详情（含 featurePlan.spec + sliceSplit）
```

---

## 8. 后续文档会展开的内容

本文档只讲了 feature 层。以下内容在后续文档展开，**不在本文档范围**：

| 内容 | 何时讲 |
|---|---|
| **slice 层**（流程同 epic，plan = 技术方案 + 拆 wave；slice 的 basedOnParent 引用 feature 的 Clarification id + FR/AC/UC id）| design-v4-slice.md |
| **wave 层**（流程同 epic，plan = 写测试，execute = dev，test = 跑测试，唯一执行型）| design-v4-wave.md |
| **机器验证机制**（wave 的测试如何不信任 agent 声明、重算 expected）| wave 文档 |
| **stale 文档**（replan 触发的子孙过期同步、abandonedRefs / staleLog 的完整字段）| stale 文档 |
| **claim 文档**（多 agent 并行时，避免两个人同时做同一个 slice）| claim 文档 |
| **ADR 文档**（重要 feature 级决策跨 epic 复用）| ADR 文档 |
| **research 服务**（Clarification type=research 时，agent 调外部查询）| research 文档 |

---

## 9. 设计原则小结

feature 层继承 epic 的 15 条原则（见 [epic 文档 §11](./design-v4-epic.md#11-设计原则小结)），补充 feature 特有的 2 条：

16. **spec 是 feature 的核心产物**：feature 的价值在于把 epic 的方向性决策翻译成 slice 能照着施工的需求规格。spec 写不好，下游 slice 全跟着跑偏。feature plan 阶段在 spec 上花的时间是值得的。
17. **FR-AC 强引用**：FR 显式声明对应的 AC id，让 FR-AC 覆盖 gate（正向 `fr-ac-coverage` + 反向 `ac-reachable-from-fr`）能机器验证引用关系完整性。不靠自然语言匹配（cw 0.x 的旧设计，只 warning 不阻断，违反机器验证原则）。**诚实边界**：强引用只解决「引用关系可机器验」，解决不了「AC 写得好不好」——后者是 agent 自审 + `acVerifiabilityNote` 人审判断，不是 gate 的事。
18. **slice 拆分只给判据不给死规则**：单 session 可完成（软锚点）+ 边界清楚 + 可独立验收是硬判据，具体拆分维度（技术层 / 用例 / 优先级）让 feature plan 时按具体情况选。强制维度（如「必须按技术层切」）会套在不适合的场景上。

---

## 附录：feature 层接口（实施参考）

```typescript
interface Feature {
  id: string;                    // "feature:oauth-login"
  scope: "feature";
  slug: string;
  status: "created" | "clarifying" | "planning" | "verified"
        | "executing" | "tested" | "retrospected" | "closed" | "aborted";
  statusHistory: StatusEvent[];
  parentUnitId: string;          // 父 epic id
  objective: string;             // create 时必填
  basedOnParent: string[];       // 从 epic 继承的 Clarification id（plan 时可减少）
                                  // append-only 历史记录，永不重写（见 epic §7.3）
  abandonedRefs: AbandonedRef[]; // 被废弃的引用及处理状态（和 epic 同构）。空数组 = 不阻塞
  clarifications: Clarification[];          // clarify 阶段填（feature 自己的 Clarification，原 decisionRecords）
  plan?: FeaturePlan;                       // plan 阶段填（含 spec + sliceSplit 作为内部字段）
  verifyJudgment?: VerifyJudgment;          // verify 阶段填（业务判断）
  childUnitIds: string[];                   // execute 时填（slice ids）
  testJudgment?: TestJudgment;              // test 阶段填（对照 verifyJudgment 验收）
  retrospectData?: RetrospectData;          // retrospect 阶段填（对照 verifyJudgment 复盘，含 reviewedItems）
  evidence?: Evidence;                       // closeout 时填
  payload: FeaturePayload;
}

// ── plan 产物（plan 阶段）──
// spec + sliceSplit 都降级为 plan 的内部字段（顶层概念不暴露 SpecSection）
interface FeaturePlan {
  spec: SpecSection[];           // 需求 spec（原 specSections 降级为 plan.spec）
  sliceSplit: SliceSplit[];      // slice 拆分清单（含依赖 DAG）
}

type SpecSection = FeaturePlan['spec'][number];  // SpecSection 仍是类型，但不再是顶层概念

interface SliceSplit {
  slug: string;                  // "oauth-backend"
  description: string;           // 一句话描述
  dependsOn: string[];           // 依赖的其他 slice slug
  // 注意：specCoverage 字段已删除——slice 负责哪些 FR/AC/UC 的引用关系，
  //       由 slice.basedOnParent 统一承载（slice create 时从 feature 继承，见 §4.5）
}

// ── Clarification（和 epic 同构）──
interface Clarification {
  id: string;
  question: string;
  resolution?: string;
  type: "research" | "grilling";
  status: "open" | "resolved" | "abandoned"; // abandoned = 已废弃（replan 时填）
  replacedBy?: string;                       // 替代它的新 id（replan 时填）
}

// ── AbandonedRef（和 epic 同构，含 refKind 区分两种引用语义）──
interface AbandonedRef {
  refId: string;              // 被废弃的父层 plan 项 id（如 "D2" 或 "FR1"）
  refKind: "clarification" | "specItem";  // 引用类型：影响下游 accept 时的决策性质
  resolvedAt?: string;        // 何时被处理（空 = 未处理，下游阻塞中；非空 = 已处理，解锁）
  resolvedAction?: "accept" | "abort";  // 怎么处理的
  // 阻塞机制不区分 refKind（都是追加记录→阻塞→accept/abort）
  // 但 guidance 提示不同（Clarification 变更=产品决策；specItem 变更=下游范围决策）
  // 详见 epic §7.3
}

// VerifyJudgment / TestJudgment / RetrospectData / Tradeoff / Risk
// 这些类型所有层共享，定义在 epic 文档附录。feature 层不重复定义。
// feature 的 verifyJudgment.layerSpecific 典型 KV（都是人审判断，gate 只验非空）：
//   specMeceNote: string            spec 的 MECE 整体结论
//   sliceSplitRationale: string     为什么这么拆 slice
//   acVerifiabilityNote: string     AC 是否真的可验收
//   consistencyNote: string         spec 各章节的一致性自检（FR/AC/UC 是否对得上）

// ── spec 内部结构（FR/AC/UC 等，加 abandoned/replacedBy 支持 replan）──

// FR（FunctionalRequirement）—— v4 新增 ac + status + replacedBy
export interface FunctionalRequirement {
  id: string;                            // "FR1"
  title: string;                         // "用户能用 GitHub 登录"
  detail: string;                        // 详细描述
  ac: string[];                          // 强引用 AC id（如 ["AC1.1", "AC1.2"]），让 fr-ac-coverage gate 机器可验
  status: "active" | "abandoned";        // 和 Clarification 对称，支持 replan
  replacedBy?: string;                   // 替代它的新 id（replan 时填）
}

// AC（AcceptanceCriterion）—— v4 加 status + replacedBy（其他字段保持 cw 0.x 原样）
export interface AcceptanceCriterion {
  id: string;                            // "AC1.1"
  condition: string;                     // 可判定的完成条件（cw 0.x 字段名，非 detail）
  verification?: "unit" | "manual" | "review";  // 如何验证（cw 0.x 可选字段）
  status: "active" | "abandoned";         // v4 新增，支持 replan
  replacedBy?: string;                   // v4 新增
}

// UC（BusinessCase）—— v4 加 status + replacedBy（其他字段保持 cw 0.x 原样）
export interface BusinessCase {
  id: string;                            // "UC1"
  actor: string;                         // Actor（cw 0.x 字段名，非 title）
  scenario: string;                      // 场景（cw 0.x 字段名）
  expectedResult: string;                // 预期结果（cw 0.x 字段名）
  status: "active" | "abandoned";         // v4 新增，支持 replan
  replacedBy?: string;                   // v4 新增
}

// 其他 SpecSection 类型（decisions / outOfScope / complexity / goals / background / constraints / section）
// 继承 cw 0.x 定义（见 src/types.ts），本文档不展开。
// 这些非 id 化的章节（如 background）通常不参与 replan，不需要 status/replacedBy。

// feature 的 transitions 规则（与 epic 完全相同）
const FEATURE_TRANSITIONS = {
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
  spec: SpecSection[];           // spec 内容（存入 featurePlan.spec）
  sliceSplit: SliceSplit[];      // slice 拆分清单（存入 featurePlan.sliceSplit）
}

// replan 的输入数据（跨层通用判别联合，定义在 epic 文档附录。feature 用 FR/AC/UC/Clarification 四种 kind，epic 只用 Clarification）
// ReplanInput / ReplacementContent / NewItem 的类型定义见 epic 附录
// feature 层不重复定义，直接引用 epic 的判别联合——这才是「严格同构」（类型一致）

// feature 的 verify gate
const FEATURE_VERIFY_GATES = [
  // 结构完整性
  "fr-ac-coverage",                // 正向：每个 FR 的 ac 数组非空且 id 都存在
  "ac-reachable-from-fr",         // 反向：每个 active AC 至少被一个 active FR 引用（防孤儿 AC）
  "ac-non-empty",                  // AC section 至少 1 条
  "slice-split-non-empty",         // sliceSplit 至少 1 个
  "slice-split-dag-valid",         // slice 依赖关系无循环
  // 业务判断非空（同 epic，验「agent 有没有填」，不验内容对错）
  "verify-necessity-non-empty",    // verifyJudgment.necessity 非空
  "verify-sufficiency-complete",   // sufficiency 三项（gaps/overlaps/meceNote）都填
  "verify-alternatives-non-empty",  // alternatives 非空（五个核心维度都机器验非空，同 epic）
  "verify-tradeoffs-present",      // tradeoffs 至少 1 条，或显式声明「无」+ 理由
  "verify-risks-present",          // risks 至少 1 条，或显式声明「无」+ 理由
  // 注意：spec-no-contradiction gate 已删除——spec 一致性是 agent 人审（consistencyNote），机器判不了「两个 FR 是否矛盾」
];

// feature 的 test gate（slice 全 closeout 后）
const FEATURE_TEST_GATES = [
  "all-slices-closed",             // 所有 child slice status === closed
  // test-references-verify：testJudgment 必须逐条对应 verifyJudgment 的每一类（引用一致性）
  // 校验项：necessityMet / sufficiencyMet / alternativesReconsidered 非空，
  //         每个 Tradeoff.id 都有对应的 tradeoffCostRealized.tradeoffRef，
  //         每个 Risk.id 都有对应的 riskOutcome.riskRef（不能漏验任何一类/任何一条）
  "test-references-verify",
];

// feature 的 retrospect gate
const FEATURE_RETROSPECT_GATES = [
  "lessons-learned-non-empty",     // retrospectData.lessonsLearned 非空（机器 gate）
  "retrospect-covers-verify",      // reviewedItems 覆盖 verifyJudgment 每项（机器 gate，验覆盖不验 verdict）
  // 人审（机器验不了）：reviewedItems 的 verdict 是否判断得对、note 质量深不深
];
```

# cw 1.0 设计文档 v4 · slice 层

> 本文档只讲 slice 一层。流程结构与 epic / feature 层**完全相同**（同样的 8 步、同样的状态机、同样的命令约定），差异只在每步的具体内容——slice 的 plan 写**技术方案**（TechSection：选型 / 接口 / 数据模型 / 错误处理 / 决策），verify 做结构化技术判断，execute **启动 wave 层**。
>
> **顶层概念体系**（和 epic / feature 一致）：使用者的认知模型只有两个维度——**4 个层**（epic / feature / slice / wave）× **8 个步骤**（create / clarify / plan / verify / execute / test / retrospect / closeout）。每一步在每一层都有一个**同名产物**，需要区分时加层前缀（如 `slicePlan`）。`Clarification` / `FR-AC`（feature 的）和 `TechSection`（slice 的）都是各层 plan 的**内部字段**，不作为顶层概念暴露。
>
> **前置阅读**：先读 [design-v4-guide.md](./design-v4-guide.md) → [design-v4-epic.md](./design-v4-epic.md) → [design-v4-feature.md](./design-v4-feature.md) → 本文档。本文档不重复 epic / feature 已讲透的内容（4 层总览 / 8 步来源 / execute 递归 / replan 机制 / abandonedRefs / basedOnParent / §8.0 命令约定 / SpecSection 体系），只在必要处引用。
>
> **和 epic / feature 严格同构**：机制层面（replan、abandonedRefs、reviewedItems、basedOnParent、verifyJudgment / testJudgment / retrospectData）完全一致，差异只在 plan 的内容（slice 是 techPlan + waveSplit）和 verify / test / retrospect 的 layerSpecific 字段。学一层，会四层。

---

## 1. 一分钟理解 slice 层

slice 是**一个单 session 可完成的技术实施单元**，是 feature 拆出来的、wave 汇聚成的中间层。它把 feature 的「需求 spec」（FR / AC / UC）翻译成 wave 能照着施工的「技术方案」（TechSection）。

```
feature 「OAuth 登录」                  ← feature 层产物：需求 spec（FR/AC/UC）
  └─ slice 「oauth-backend」            ← 本文讲这一层
       ├─ clarify: 这个 slice 的技术细节要定清楚，必须先回答什么？（选哪个库、错误态怎么抛）
       ├─ plan:    写 techPlan（TechSection：选型/接口/数据模型/错误）+ 拆 wave
       ├─ verify:  techPlan 结构化技术判断（执行前审查）
       ├─ execute: 启动 wave 层（每个 wave 走自己的 8 步，wave 才真正写代码）
       ├─ test:    wave 全完成后，验证组合起来兑现了 techPlan
       └─ ...
```

**slice 和 feature 的相同点**（都是协调型 scope）：
- 不直接写代码，代码都在 wave 层
- execute = 启动下一层（slice 启动 wave，feature 启动 slice）
- test = 子层全完成后整体验证，不是跑测试

**slice 和 feature 的不同点**：

| | feature | slice |
|---|---|---|
| **clarify 维度** | 需求细节（支持哪些登录方式？错误态怎么展示？）| **技术细节**（token 交换用哪个库？错误态怎么向上抛？）|
| **plan 产物** | `featurePlan`：`spec`（SpecSection 集合）+ `sliceSplit` | **`slicePlan`：`techPlan`（TechSection 集合）+ `waveSplit`** |
| **plan 内容性质** | 需求规格（做什么）| **技术方案（怎么做）** |
| **verify 机器 gate** | FR-AC 覆盖 + slice DAG 无环 | **TechChoice 非空 + waveSplit 非空 + wave DAG 无环 等**（详见附录 SLICE_VERIFY_GATES）|
| **execute 启动** | slice 层 | wave 层 |
| **上游引用** | 继承 epic 的 Clarification id | 继承 feature 的 **Clarification id + FR/AC/UC id**（slice 比 feature 多继承 spec 项）|

**slice 和 wave 的不同点**（slice 是协调型，wave 是执行型）：

| | slice | wave |
|---|---|---|
| **类型** | 协调型（规划 + 启动下一层）| **执行型**（execute = dev 写代码）|
| **plan 产物** | `techPlan` + `waveSplit`（技术方案 + wave 拆分）| `wavePlan`：写测试（TDD 红→绿→重构起点）|
| **是否写代码** | 否（永远不产出代码）| **是**（唯一写代码的层）|
| **粒度** | 单 session 可完成（软锚点 2-4h）| 单次提交可完成（典型 30 分钟 - 2 小时）|

**一句话**：slice 把 feature 的「需求 spec」翻译成 wave 能照着施工的「技术方案」（techPlan），自己不写代码。

---

## 2. 为什么需要 slice 层

feature 层只产出「做什么」（需求 spec：FR / AC / UC），粒度是需求规格，wave 没法直接接手。中间缺一层把需求翻译成「怎么做」的技术方案：

- feature 的 `FR1: 用户能用 GitHub 登录`——但 wave 要知道**token 交换用哪个库、返回什么数据结构、错误态怎么向上抛**
- feature 的 `AC1.1: 点 GitHub 登录 → 3 秒内跳转回首页已登录`——但 wave 要知道**这个 AC 在后端 slice 体现成哪个接口、响应时间预算多少、失败时返回什么**

这些「技术细节」就是 slice 的 techPlan 要回答的问题。slice 层的存在意义：**把 feature 的需求规格，翻译成 wave 可以直接施工的技术方案**。

为什么是 slice 这一层而不是 wave 自己定技术方案：一个 feature 通常拆成多个 slice（前端 / 后端 / 集成联调），一个 slice 又拆成多个 wave。如果每个 wave 各做各的技术决策，会出现接口对不上、数据模型冲突、错误码不一致。slice 层统一定技术方案（选型 / 接口契约 / 数据模型 / 错误处理策略），wave 只照着施工，保证一个 slice 内的技术一致性。

**slice 和 feature 的分工**：feature 管「需求对不对」（spec 写得是否覆盖、AC 是否可验收），slice 管「技术方案合理不合理」（选型是否靠谱、接口契约是否能落地、跨 wave 是否对得上）。两者不混淆——slice 是纯技术层，不重写业务目标（那是 feature 的事），只回答技术问题。

---

## 3. slice 是什么

slice 是**一个单 session 可完成的技术实施单元**，由 feature 拆分产生，自己再拆成若干 wave。

典型 slice 例子（feature = `oauth-login` 的拆分，承接 feature 文档 §4.3 的 sliceSplit）：
- `oauth-backend`：OAuth 后端接口（token 交换、用户信息拉取、错误处理）
- `oauth-frontend`：OAuth 前端（登录按钮、回调处理、错误展示）
- `oauth-integration`：端到端联调 + UC1 验收

slice 的核心特征：
- **单 session 可完成**：一个 slice 的所有 wave 加起来，一个开发 session 能做完。**单 session 是软锚点**（指一次集中工作时段，典型 2-4 小时），承接 feature 的软锚点，不是硬性卡死的规则
- **跨多个 wave**：一个 slice 通常拆成多个 wave（按 TDD 节奏或功能子模块）
- **技术驱动**：slice 的核心产物是 techPlan（技术方案），下游 wave 照 techPlan 施工
- **协调型不写代码**：slice 的 execute 不是 dev，是启动 wave 层。slice 自己永远不产出代码（代码是 wave 的事）

---

## 4. slice 的完整流程（8 步详解）

> 流程结构和 epic / feature 完全一样（create → clarify → plan → verify → execute → test → retrospect → closeout）。下面每步只讲 **slice 特有的内容**，通用规则见 epic 文档 §5 和 feature 文档 §4。

### 4.1 第 1 步：create（创建）

**做什么**：建一个 slice 实例，写下 **objective**（这个 slice 完成后技术上能交付什么，1-2 句话），并从父 feature 继承 Clarification 引用 + FR/AC/UC 引用。

**objective 例子**（slice = `oauth-backend`）：
> 实现 OAuth token 交换接口（`POST /api/oauth/token`），支持 GitHub / Google，返回标准 TokenPair 结构，错误态按统一错误码规范向上抛。

**继承机制**（和 feature §4.1 同构，但 slice **多继承 FR/AC/UC**）：
- slice 的 `parentUnitId` 指向父 feature
- cw 把父 feature 当前的 `clarifications` 的 id（feature 自己 clarify 产生的）+ feature spec 里的 FR/AC/UC id（`featurePlan.spec` 里的）**全量拷贝**到 slice.`basedOnParent`（slice plan 时可以减少——只留自己真正负责的）
- **统一存在 `slice.basedOnParent`**，不区分 Clarification 引用和 spec 项引用两套字段（v4 统一语义，见 epic §7.3）
- 这些继承来的引用是 slice techPlan 的初始约束（slice 写 techPlan 时不能违反它们，不能凭空新增 feature 没声明的功能）

> **TODO（继承机制，同 epic §7.3 / feature §4.1）**：basedOnParent 的「全量拷贝再减少」继承机制是临时语义，待重新设计（见 reviewer epic C3），本文档及 §4.5 描述的是当前临时机制。

**状态**：`created` → 进入 `clarifying`

**命令**：
```bash
cw slice create oauth-backend \
  --from-feature feature:oauth-login \
  --objective "实现 OAuth token 交换接口..."
```

### 4.2 第 2 步：clarify（澄清技术细节）

**做什么**：识别这个 slice 的技术方案要定清楚，必须先回答的问题（**Clarification**——clarify 阶段的产物，跨层同构），逐个给答案。机制和字段同 epic §5.2 / §7.2，不再重复。

slice 的 clarify 典型问题（**技术维度**，不是业务维度——业务需求是 feature 的事）：
- 「token 交换用哪个库？」→「oauth2-client v3.2（成熟、文档全、社区活跃）」
- 「错误态怎么向上抛？」→「统一 error code + middleware 捕获，不每个调用点 try/catch」
- 「接口返回格式？」→「JSON，`{ code, data, message }` 三段式，code 用业务码不用 HTTP 状态码」
- 「token 存哪？」→「access token 存内存 LRU（短期），refresh token 存 Redis（带过期）」

**research vs grilling**（同 epic / feature）：
- `research`：查外部资料能答的（如「oauth2-client v3.2 是否支持 PKCE」查官方文档、「GitHub OAuth 的 token endpoint 限流是多少」查 API 文档）——slice 层大部分是 research
- `grilling`：必须人回答的技术决策（如「用 oauth2-client 还是自研」「要不要兼容旧版 token 格式」）

**和 feature clarify 的区别**：feature 澄清的是**需求细节**（支持哪些提供商、错误态怎么分），slice 澄清的是**技术细节**（用哪个库、错误态怎么抛）。slice clarify 的产物会被 plan 阶段写进 techPlan：**TechDecision** 是 Clarification 的投影（`sourceClarification` 直接引用，机制同 feature 的 SpecDecision），**TechChoice** 是独立的选型记录（有 area/choice/alternatives/rationale，不投影 Clarification）。

**状态**：`clarifying`

**命令**：
```bash
cw slice clarify slice:oauth-backend          # progressive，可多次调用
# 输入数据从 stdin 读：{ clarifications: [...] }
```

### 4.3 第 3 步：plan（写技术方案 + 拆 wave）

**做什么**：基于 clarify 的 Clarification + 继承的 feature spec，**写技术方案**（TechSection 集合）+ **拆 wave**。这是 slice 层最核心的一步。

**plan 的两个产物**（都存在 `slicePlan` 里，作为内部字段）：

#### 产物 1：技术方案（`slicePlan.techPlan`：TechSection 集合）

techPlan 是 slice 留给下游 wave 的「技术施工图」。TechSection 是判别联合（5 种结构化类型 + 2 种兜底），详见 §5。一个典型的 slice techPlan 包含：

| TechSection 类型 | 作用 | 例子（oauth-backend）|
|---|---|---|
| `TechChoice`（TC）| 技术选型——最核心的技术决策记录 | `TC1: 认证库 = oauth2-client v3.2（备选 passport-oauth / 自研）` |
| `Interface`（IF）| 接口契约——slice 对外 / 对其他 slice 的承诺 | `IF1: exchangeToken(code) => Promise<TokenPair>` |
| `DataModel`（DM）| 数据模型——核心类型定义 | `DM1: TokenPair = { accessToken, refreshToken, expiresAt }` |
| `ErrorSpec`（ERR）| 错误处理策略 | `ERR1: OAuth 返回 invalid_grant → 返回 401 + 提示重新登录，不重试` |
| `TechDecision`（TD）| 技术决策（引用 Clarification）| `TD1: token 存 Redis（投影自 D3）` |
| `outOfScope` | 明确不做的事（照搬 feature）| `兼容旧版 token 格式` |
| `section` | 兜底章节（照搬 feature）| 自定义章节名 |

**slice 不做 TechSection 间的强引用 gate**（详见 §5.2）——技术方案间的引用关系（如 Interface 引用 DataModel、ErrorSpec 关联 Interface）比 feature 的 FR-AC 复杂，机器 gate 验不过来，靠 agent 自审（`interfaceContractNote` 人审判断）。

**关于 complexity**：feature 的 spec 有主观 `complexity` 标注，slice **不用这个字段**——slice 是技术层，不需要主观复杂度评级（feature 需要是因为复杂度辅助 slice 拆分决策，slice 的拆分对象是 wave，靠单次提交判据足够）。

**关于 goals / background / constraints**：feature 有业务目标（goals）和背景约束（background / constraints），slice **不用这些字段**——slice 的背景在 feature / epic 已讲，业务目标是 feature 层的事，slice 是技术层不设业务目标。slice 保持 TechSection 纯技术，不和 feature 的业务 spec 混淆。

#### 产物 2：wave 拆分清单（`slicePlan.waveSplit`）

基于 techPlan，把这个 slice 拆成若干 wave（split 在 plan 里做，作为 `slicePlan.waveSplit` 内部字段）：

| wave slug | 描述 | 依赖 |
|---|---|---|
| `exchange-token-skeleton` | exchangeToken 接口骨架 + 类型定义 + 单测 | — |
| `error-handling` | invalid_grant 等错误态处理 + 单测 | `exchange-token-skeleton` |
| `provider-integration` | 接入 GitHub / Google 真实 OAuth 提供商 + 集成测 | `exchange-token-skeleton` |

> wave 负责哪些 TechSection 项的引用关系不在 waveSplit 里存——wave create 时 cw 把 slice 当前的 TC/IF/DM/ERR id（**不含 TD**——TechDecision 是技术决策记录，跟随 Clarification replan，wave 不需引用，对齐 feature 不让 slice 继承 SpecDecision 的做法）全量拷贝到 wave.`basedOnParent`（wave plan 时可减少到只留自己真正负责的），机制见 §4.5。

**wave 拆分的判据**（不给死规则，只给判据 + 典型维度）：

判据（必须同时满足）：
- **单次提交可完成**：一个 wave 的所有改动一次 commit 能做完（典型 30 分钟 - 2 小时）。**单次提交是软锚点**，承接 slice 的单 session 软锚点，不是硬性卡死的规则
- **有明确的测试边界**：wave 有自己的 testCases（wave plan 写测试，这是 wave 层的核心约束），能独立判定 wave 做完没

典型拆分维度（按 slice 特点选，不强制）：
- **按 TDD 节奏**：红（写失败测试）→ 绿（最小实现）→ 重构（拆成 3 个 wave）
- **按功能子模块**：接口骨架 / 错误处理 / 提供商集成（每个子模块一个 wave）
- **按交付优先级**：核心路径先行 / 边界情况后行

**产出**：`slicePlan`（`techPlan` + `waveSplit`）

**状态**：`planning`

**命令**：
```bash
cw slice plan slice:oauth-backend             # progressive，可多次调用
# 输入数据从 stdin 读：
# {
#   techPlan: TechSection[],      # 技术方案（存入 slicePlan.techPlan）
#   waveSplit: WaveSplit[]         # wave 拆分清单（存入 slicePlan.waveSplit）
# }
```

### 4.4 第 4 步：verify（技术方案审查）

**做什么**：在启动 wave 层**之前**，对 plan 阶段的 techPlan 和 wave 拆分做**结构化的技术判断**。机制同 epic / feature verify（见 [epic 文档 §5.4](./design-v4-epic.md#54-第-4-步verify审查规划)）——cw 定义存储结构 + guidance 提示 + 结构校验，**业务判断内容由 agent 产出**。

**guidance 提示 agent 回答的问题**（slice 特化版）：

| 维度 | slice 要回答的问题 |
|---|---|
| **必要性（necessity）** | 这个 slice 对父 feature spec 的贡献是什么？没它 feature 能交付吗？ |
| **充分性（sufficiency，MECE）** | techPlan 加起来覆盖了 slice 负责的所有 FR/AC 吗？有遗漏的技术点吗？有重叠的 TechChoice 吗？wave 拆分覆盖了所有 TechSection 吗？ |
| **替代方案（alternatives）** | techPlan 有没有过度设计？选型考虑过其他库 / 方案吗？wave 拆分考虑过其他维度吗？ |
| **权衡与妥协（tradeoffs）** | 哪些 TechChoice 是妥协（如成熟度换性能、便利性换可控）？每个妥协的代价？ |
| **风险（risks）** | 跨 wave 协调风险（接口契约对得上吗、共享数据模型有无冲突、依赖链上哪环最易延误）+ **技术方案层面的风险**（选型不确定性、外部依赖风险、接口契约会变）。**注意：单 wave 内部的技术细节风险不在 slice verify 评估**——那是 wave 自己 verify 的事（见 wave 文档）。**判据二分**：(a) 协同判据——如果某个风险的触发或缓解需要多个 wave 协同动作，归 slice；如果单个 wave 自己就能应对，归 wave；(b) 接口契约二分——**接口契约的设计风险（签名是否合理、错误态是否完整）归 slice，实现风险（wave 能否正确实现这个签名、mock 是否够）归 wave**。边界模糊时优先归 slice（slice 是上层，兜底）——和 feature 的判据对称 |

slice 专属判断填入 `verifyJudgment.layerSpecific`（KV），典型字段：

| layerSpecific 字段 | 含义 | 校验方式 |
|---|---|---|
| `techChoiceRationale` | 每个 TechChoice 的选型理由是否充分（有没有「随便选了一个」的）| 人审判断，机器只验非空 |
| `interfaceContractNote` | 接口契约设计是否合理（输入 / 输出 / 错误码 / 副作用是否定义清楚）| 人审判断，机器只验非空 |
| `testabilityNote` | 技术方案是否可测——依赖注入是否够、mock 点是否留了、外部依赖是否可隔离 | 人审判断，机器只验非空 |
| `crossWaveContractNote` | 跨 wave 的接口契约是否对得上（wave-1 产出的数据 wave-2 能消费吗）| 人审判断，机器只验非空 |

> **所有 layerSpecific 字段都是 agent 的人审判断，gate 只验非空，不验内容**。techPlan 的一致性自检（如 Interface 引用的 DataModel 是否存在、ErrorSpec 是否覆盖 Interface 的错误态）不作为机器 gate——技术方案间的引用关系机器判不准（见 §5.2），那是 agent 自检的职责，放进 `interfaceContractNote` / `crossWaveContractNote` 让 agent 显式回答。

**机器 gate**（同 epic / feature，验结构不验内容）：
- **结构完整性**：`tech-choice-non-empty`（techPlan 至少 1 条 TechChoice）/ `wave-split-non-empty` / `wave-split-dag-valid`
- **业务判断非空**：`verifyJudgment.necessity` 非空、`sufficiency` 三项填齐（gaps / overlaps / meceNote）、`tradeoffs` 至少 1 条（或显式声明「无」+ 理由）、`risks` 至少 1 条（或显式声明「无」+ 理由）

**诚实说明**：同 epic / feature——cw 验「agent 有没有填这些字段」，验不了「techPlan 写得好不好、选型靠不靠谱」。内容质量由 agent（或人审）负责。判断存在 `verifyJudgment` 里，是 test / retrospect 对照的基础。

**通过的含义**：techPlan 定稿，可以启动 wave 层了。

**状态**：`verified`

**命令**：
```bash
cw slice verify slice:oauth-backend          # progressive，可多次调用
# 输入数据从 stdin 读：{ verifyJudgment: {...} }
```

### 4.5 第 5 步：execute（执行 = 启动 wave 层）

**做什么**：slice 自己不写代码，它的 execute = **启动 wave 层**（机制和 epic execute 启动 feature 层、feature execute 启动 slice 层完全对称）：

1. 根据 plan 阶段的 `waveSplit` 拆分清单，为每个 wave 创建实例
   - 每个 wave 的 `parentUnitId` 指向这个 slice
   - 每个 wave 的 `basedOnParent` 从 slice 继承：cw 把 slice 当前的 `clarifications` id（slice 自己 clarify 产生的）+ slice techPlan 里的 TC/IF/DM/ERR id（**不含 TD**，理由见§5.2）**全量拷贝**到 wave.`basedOnParent`（wave plan 时可以减少到只留自己真正负责的）。**统一存在 `wave.basedOnParent`**，不区分 Clarification 引用和 techPlan 项引用两套字段（v4 统一语义，见 epic §7.3）
2. 每个 wave 开始走自己的 8 步流程（wave 是执行型，wave 的 execute = dev 写代码——递归出口）

> **TODO（继承机制，同 epic §7.3 C3）**：wave 的 basedOnParent 继承机制和 feature / slice 一样是临时语义，待统一重新设计。

**slice 在 execute 阶段做什么**：等。等所有 wave 走完它们的 8 步流程，全部 closeout 后，slice 进入 test 阶段。

**wave 怎么持有 slice techPlan**（统一引用机制）：

wave 不快照整个 techPlan，只记 `basedOnParent`（引用了 slice plan 的哪些项——Clarification id + TC/IF/DM/ERR id 统一存在这一个字段里，不含 TD）。如果 slice 改了 techPlan（变更 / 撤销某个 TechChoice / Interface / DataModel / ErrorSpec），走 **统一 replan**（见 §6）——slice 作废旧项（`status=abandoned` + `replacedBy`），cw 反查子树里 `basedOnParent` 含被废弃 TechSection id 的 wave，在它们的 `abandonedRefs` 追加记录（refKind=`techItem`），强制处理（accept-replan 或 abort）。机制层面和 epic 改 Clarification、feature 改 FR/AC 完全一致。

**状态**：`executing`（长状态，可能跨多个 session）

**命令**：
```bash
cw slice execute slice:oauth-backend         # 启动 wave 层
```

### 4.6 第 6 步：test（整体验证）

**做什么**：所有 wave 都 closeout 后，**逐条对照 verify 阶段的技术判断**验收。机制同 epic / feature test（见 [epic 文档 §5.6](./design-v4-epic.md#56-第-6-步test整体验证)）。

**guidance 提示 agent 对照回答**（slice 特化）：

| verify 阶段的判断 | slice test 要回答 |
|---|---|
| 当初说的「必要性」（这个 slice 对 feature 的贡献）| 贡献真的兑现了吗？feature 的相关 FR/AC 是否真的因为这个 slice 满足了？|
| 当初判断的 techPlan Gap / 重叠 | 这些 Gap 真的漏了吗？wave 开发时暴露了新 Gap 吗？重叠实际发生了吗？|
| 当初考虑但没选的替代方案（alternatives）| 事后看当初没选的那个库 / 方案，其实应该选吗？|
| 当初每个妥协 + 代价（如「选成熟库放弃性能」）| 代价真的付出了吗？（如性能影响符合预期吗）|
| 当初标记的跨 wave 协调风险 / 技术方案层面风险 | 实际表现如何？（接口契约对得上吗、依赖链延误了吗、选型踩坑了吗、外部依赖稳定吗）|

agent 把对照结论填入 `workUnit.testJudgment`，每个字段**必须对应 `verifyJudgment` 的一项**（necessity 对 necessity、sufficiency 对 sufficiency、alternatives 对 alternatives、每个 tradeoff 有对应的 costRealized、每个 risk 有对应的 outcome）。

**机器 gate**：
- **结构完整性**：`all-waves-closed`
- **引用一致性**（诚实区分两类，照抄 epic §5.6 / feature §4.6）：
  - **真引用一致（机器验 id 匹配）**：`testJudgment.tradeoffCostRealized` 里的 `tradeoffRef` 必须覆盖 `verifyJudgment` 每个 Tradeoff.id；`testJudgment.riskOutcome` 里的 `riskRef` 必须覆盖 `verifyJudgment` 每个 Risk.id——不漏验任何一条 tradeoff / risk
  - **只验非空（对应关系靠 agent 自检 + 人审）**：`necessityMet` / `sufficiencyMet` / `alternativesReconsidered` 是 string / 结构体，机器只验「填了」，内容是否真对应 verifyJudgment 靠 agent 自检

**诚实说明**：跨 wave 的技术方案兑现验证（如「techPlan 里的 IF1 接口真跑通了没、DM1 数据模型真落地了没」）在这里做——单个 wave 只能验自己负责的部分。对照结论由 agent 判断，cw 只验「该对照的都对照了」。

**如果没通过**：可能要回到某个 wave 修，或发现 techPlan 有问题（少见，verify 已审过；真发生就走 replan）。

**状态**：`tested`

**命令**：
```bash
cw slice test slice:oauth-backend
# 输入数据从 stdin 读：{ testJudgment: {...} }
```

### 4.7 第 7 步：retrospect（复盘）

**做什么**：复盘 slice 层自己的事。**核心动作是对照 verifyJudgment，看哪些判断事后证明错了**（机制同 epic / feature retrospect，见 [epic 文档 §5.7](./design-v4-epic.md#57-第-7-步retrospect复盘)）。

**guidance 提示 agent 回答**（slice 特化）：

| 复盘维度 | slice 要回答的问题 |
|---|---|
| **判断错误（wrongJudgments）** | verify 阶段哪些 techPlan / wave 判断错了？（标的高风险选型实际很稳、判断的 Gap 不存在、认为必要的 TechChoice 实现完发现没用）|
| **不良妥协（badTradeoffs）** | 哪些 TechChoice 妥协事后看不值得？（如「选成熟库放弃性能」实际性能瓶颈严重）|
| **遗漏的 Gap（missedGaps）** | verify 没发现、wave 开发才暴露的 Gap？为什么 verify 没发现？|
| **流程问题（processIssues）** | techPlan 写得好吗？（接口契约漏字段 / 选型没考虑兼容性 / 数据模型没想清楚）；wave 拆分合理吗？（太碎 / 太大 / 依赖搞错返工）；技术澄清够吗？（开发一半才发现没定清楚用哪个版本）|
| **提炼经验（lessonsLearned）** | 下次写类似 slice 的 techPlan，最该记住的 1-3 条经验？ |

agent 把复盘结论填入 `workUnit.retrospectData`。其中 `reviewedItems` 是**结构化逐项回顾记录**——对 verifyJudgment 的每一项（necessity / sufficiency / alternatives + 每个 tradeoff id + 每个 risk id），必须有一条 reviewedItems 记录，机器验「覆盖」（不验 verdict 对错）。`reviewedItems.ref` 是 **`VerifyItemRef` 判别联合**（`{kind:"necessity"}` / `{kind:"sufficiency"}` / `{kind:"alternatives"}` / `{kind:"tradeoff", id}` / `{kind:"risk", id}`，定义见 epic 附录），`retrospect-covers-verify` gate 按 kind 分桶验覆盖。`wrongJudgments` / `badTradeoffs` / `missedGaps` 允许为空（说明判断都对了），但 `lessonsLearned` 必须非空——**没有提炼出经验的 retrospect 是失败的 retrospect**。

**机器 gate**：
- `retrospectData.lessonsLearned` 非空（`lessons-learned-non-empty`）
- `retrospectData.reviewedItems` 覆盖 `verifyJudgment` 的每一项（`retrospect-covers-verify`，机器验）：每个 necessity / sufficiency / alternatives + 每个 Tradeoff.id + 每个 Risk.id 都有一条对应的 reviewedItems 记录

**人审 gate**（机器验不了，诚实承认）：
- `reviewedItems` 的 `verdict`（判断对 / 错）和 `note`（说明）的内容质量——机器只验「每项都有记录」，验不了「回顾得对不对、深不深」

**产出**：retrospect 记录（结构化经验沉淀，跨 slice 复用）

**状态**：`retrospected`

**命令**：
```bash
cw slice retrospect slice:oauth-backend
# 输入数据从 stdin 读：{ retrospectData: {...} }
```

### 4.8 第 8 步：closeout（收尾）

**做什么**：
- 写 evidence（slice 的最终交付证据：techPlan 最终版、wave 列表、retrospect）
- slice 进入 `closed`（归档，不再变动）
- 重要的 slice 级技术决策升级为 ADR（跨 slice 复用，如「所有 token 交换统一用 oauth2-client」）

**slice 的使命到此结束**。

**状态**：`closed`（真终态，不可 reopen）

**命令**：
```bash
cw slice closeout slice:oauth-backend
```

---

## 5. TechSection（slicePlan.techPlan 的组成单元）

### 5.1 TechSection 是什么

TechSection 是 `slicePlan.techPlan` 的组成单元（和 feature 的 SpecSection 对称，**不再是顶层概念**）。它是 slice 把 feature 的需求 spec 翻译成技术方案的具体载体。设计上**照搬 SpecSection 的判别联合模式**（同一种结构化章节 + 兜底章节的组织方式），但内容是纯技术维度。

TechSection 分三类：

**结构化章节**（cw 校验内容 + report 模板渲染）：

| 类型 | 作用 | 对应 feature 的哪个 SpecSection |
|---|---|---|
| `TechChoice`（TC）| 技术选型——最核心的技术决策记录 | 对应 feature 的 `functionalRequirements`（FR）：FR 是「要做什么」，TC 是「用什么做」|
| `Interface`（IF）| 接口契约——slice 对外 / 对其他 slice 的承诺 | feature 无对应物（feature 是需求层，不定义接口签名）|
| `DataModel`（DM）| 数据模型——核心类型定义 | feature 无对应物 |
| `ErrorSpec`（ERR）| 错误处理策略 | feature 无对应物 |
| `TechDecision`（TD）| 技术决策（引用 Clarification）| 对应 feature 的 `decisions`（SpecDecision）——都是 clarify 的 plan 层投影 |

**兜底章节**（照搬 feature）：
- `outOfScope`：明确不做的事（防范围蔓延）
- `section`：sectionName + content，用于上述类型覆盖不到的特殊技术说明

**slice 删掉的 feature 章节**（明确不用，见 §4.3 说明）：
- `background` / `constraints`（md 章节）—— slice 的背景在 feature / epic 已讲，不重复
- `complexity`（主观标注）—— slice 不需要主观复杂度评级（理由见 §4.3）
- `goals`（业务目标）—— 那是 feature 层的事，slice 是技术层不设业务目标

**设计依据**：TechSection 的 5 种结构化类型覆盖了技术方案的核心维度（选什么 / 暴露什么接口 / 用什么数据 / 错了怎么办 / 为什么这么决定）。slice 是技术层，保持 TechSection 纯技术，不和 feature 的业务 spec 混淆。

### 5.2 各类型详解（+ 为什么不做强引用 gate）

各 TechSection 类型都带 `status: "active" | "abandoned"` + `replacedBy?`（和 feature 的 FR/AC/UC 对称，支持 replan，详见 §5.4）。

#### TC（TechChoice）—— 技术选型

最核心的技术决策记录。每个 TechChoice 记一项选型决策：选了什么、考虑过什么、为什么。

```typescript
interface TechChoice {
  id: string;              // "TC1"
  area: string;            // "认证库" / "HTTP 客户端" / "状态管理"
  choice: string;          // "oauth2-client v3.2"
  alternatives: string;    // 考虑过但没选的（"passport-oauth / 自研"）
  rationale: string;       // 为什么选这个（成熟、文档全、社区活跃）
  status: "active" | "abandoned";
  replacedBy?: string;
}
```

`alternatives` 和 `rationale` 是 TC 的灵魂——没有这两个字段的 TC 等于「随便选了一个」，verify 的 `techChoiceRationale` 人审会盯。

#### IF（Interface）—— 接口契约

slice 对外 / 对其他 slice 的承诺。这是跨 wave 协调的关键（wave-1 实现 IF1，wave-2 消费 IF1，IF1 契约不稳就反复返工）。

```typescript
interface Interface {
  id: string;              // "IF1"
  name: string;            // "exchangeToken"
  signature: string;       // "(code: string) => Promise<Token>" 或 "POST /api/oauth/token"
  contract: string;        // 输入/输出/错误码/副作用（自由描述，人审）
  status: "active" | "abandoned";
  replacedBy?: string;
}
```

**不设 `consumers` 字段**：v4 slice 不做 IF→DM 的强引用 gate（见下方「为什么不做强引用 gate」）。影响面查询走 `basedOnParent` 反查——cw 反查子树里 `basedOnParent` 含被废弃 IF id 的 wave（机制同 slice replan 影响面传播，见 §5.4），不需要 IF 自己维护一个 `consumers` 数组。人肉维护的弱引用数组（`consumers`）会腐烂且和机器维护的 `basedOnParent` 冗余，删掉。

#### DM（DataModel）—— 数据模型

核心类型定义。可以是 TypeScript 类型、SQL DDL、JSON schema 等。

```typescript
interface DataModel {
  id: string;              // "DM1"
  name: string;            // "TokenPair" / "users 表"
  definition: string;      // TypeScript 类型定义 / SQL DDL / JSON schema
  notes?: string;          // 约束、索引、不变量说明
  status: "active" | "abandoned";
  replacedBy?: string;
}
```

#### ERR（ErrorSpec）—— 错误处理策略

```typescript
interface ErrorSpec {
  id: string;              // "ERR1"
  interfaceId?: string;    // 关联的 Interface id（可选——全局错误策略可不填，接口级错误必填，让人审能找到错误属于哪个 IF）
  scenario: string;        // "OAuth 提供商返回 invalid_grant"
  strategy: string;        // "返回 401 + 提示重新登录，不重试"
  status: "active" | "abandoned";
  replacedBy?: string;
}
```

#### TD（TechDecision）—— 技术决策（引用 Clarification）

对应 feature 的 `decisions`（SpecDecision）。定位为 Clarification 的 techPlan 层投影：

```typescript
interface TechDecision {
  id: string;              // "TD1"
  decision: string;
  rationale: string;
  sourceClarification?: string;  // 投影自哪个 Clarification（同 feature SpecDecision 的 TODO）
}
```

TechDecision 不独立持有 `status` / `replacedBy`——它的内容引用 Clarification，Clarification 被 replan 时 TechDecision 自动跟随（不独立参与 replan）。机制和 feature 的 SpecDecision 完全对称（详见 feature §5.4）。**TODO（迁移）**：给 TechDecision 加 `sourceClarification` 字段，记录它投影自哪个 Clarification。

#### 为什么不做 TechSection 间的强引用 gate（Q2）

feature 层做了 FR-AC 强引用 gate（FR 显式声明对应的 AC id），因为 FR-AC 的对应关系简单清晰（一个 FR 对应几条 AC），机器能验「每个 FR 至少有 1 条 AC」。

slice 层**不做**这个 gate，原因：

- **引用关系太复杂**：一个 Interface 可能引用多个 DataModel（IF1 的返回值用 DM1 + DM2）、多个 ErrorSpec（IF1 在不同错误场景抛不同 ERR）、被多个 wave 消费。反向关系同样复杂（DM1 可能被多个 IF 引用）。
- **机器验不出有意义的约束**：就算加了 IF.dmIds 强引用，gate 能验的只是「IF 引用的 DM id 存在」这种弱约束——验不了「IF 的返回值真的匹配 DM 的结构」「ERR 真的覆盖了 IF 的所有错误态」。后者需要语义理解，机器判不了。
- **YAGNI**：feature 的 FR-AC gate 解决的是「FR 没对应 AC」这种结构性遗漏，slice 技术方案间的遗漏模式不同（更多是「接口契约写漏了字段」「错误态没覆盖」），靠 agent 自审 + verify 的 `interfaceContractNote` / `crossWaveContractNote` 人审判断更合适。

**结论**：v4 slice 不做技术项间的强引用 gate，靠人审（接口契约设计 note）。诚实承认这是 agent 自检 + 人审的职责，不假装机器能验。

**诚实补充**：有一种低级的机器可验校验被 v4 故意放弃——**id 存在性校验**（如 IF 的 contract 文本里提到 DM5，但 techPlan 里没有 DM5）。这种拼写错误级别的检查机器能做、成本极低。v4 选择不做的原因：技术方案中跨项引用主要在自由文本（contract / notes）里，机器要解析自由文本抽 id 既不准又费事，收益有限。这是明确的 v4 取舍，不是「机器完全验不了」。

### 5.3 TechSection 不是独立工作单元

和 epic 的 Clarification、feature 的 SpecSection 一样，TechSection **只是 slice plan 阶段产生的列表项**，挂在 slice 上：

```
slice
  ├─ objective: "..."
  ├─ status: planning
  ├─ clarifications: [...]          // clarify 阶段填（slice 自己的 Clarification）
  ├─ plan: {                        // plan 阶段填（含 techPlan + waveSplit 作为内部字段）
  │    techPlan: [                  // slicePlan.techPlan
  │      { type: "TechChoice", ... },
  │      { type: "Interface", ... },
  │      { type: "DataModel", ... },
  │      { type: "ErrorSpec", ... },
  │      { type: "TechDecision", ... },
  │      { type: "outOfScope", ... },
  │      ...
  │    ],
  │    waveSplit: [...]             // slicePlan.waveSplit
  │  }
  └─ childUnitIds: [...]            // execute 时填（wave ids）
```

它没有自己的状态机、不是独立 Unit。slice closeout 后它跟着 slice 一起归档（重要的会被 wave 的 `basedOnParent` 引用，或技术决策类 section 升级为 ADR）。

### 5.4 技术方案变更走统一 replan

slice 的 techPlan 不是 immutable——slice 在 `verified` / `executing` 状态都可能改 techPlan（wave 开发中发现选型不靠谱、接口契约定错了）。

**统一机制**（和 epic 改 Clarification、feature 改 FR/AC 完全一致）：techPlan 变更（修改 / 撤销某个 TC/IF/DM/ERR）走 `cw slice replan`：

- `abandonItems` 里填要作废的 TechSection id（TC/IF/DM/ERR，**不含 TD**——TD 跟随 Clarification replan，不能独立作废）——epic 层填 Clarification id，feature 层填 FR/AC/UC id，slice 层填 TechSection id，**机制统一、只是 id 的语义不同**
- cw 作废旧 TechSection（`status=abandoned` + `replacedBy` 指向新版本）+ 新增新版本（如有 `replacementContent`）
- 反查下游 wave 的 `basedOnParent` 含被废弃 TechSection id 的，在它们的 `abandonedRefs` 追加记录
- 被标的 wave **阻塞所有改状态 action**（只读查询不阻塞），强制二选一：accept-replan（接受新版本）或 abort（重做）

不引入 techPlan 快照 / snapshot 双轨机制——统一 replan 已覆盖「上游变 → 下游跟着变」的完整场景。详见 §6 和 [epic 文档 §8.2](./design-v4-epic.md#82-replan局部打补丁影响面传播)。

**注意**：TechSection 的 replan 通过 `SliceReplanInput.abandonItems` 驱动，`replacementContent` 用 slice 层自己的判别联合（含 TC/IF/DM/ERR 四个 kind，见附录 SliceReplacementContent）。同构的是 replan 的 4 步机制，不是 ReplanInput 的类型集合（详见附录说明）。

---

## 6. slice 状态机

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

**和 epic / feature 状态机完全相同**（这是「学一层会四层」的体现）。关键规则同 epic / feature：
- `clarify` / `plan` / `verify` / `replan` 是 progressive
- `execute` 是长状态（等所有 wave 完成，可能跨多 session）
- `test` / `retrospect` / `closeout` 是一次性
- `closeout` 后真终态，不可 reopen
- `abort` 连带销毁所有非终态子孙（**wave**）
- `replan` 不改 status（关键）：只做四件事——(a) 作废指定 plan 项（旧 TC/IF/DM/ERR `status=abandoned` + `replacedBy` 指向新版本）；(b) 新增新版本（如有 `replacementContent`）；(c) 反查子树里 `basedOnParent` 含被废弃项 id 的 wave（**沿 replacedBy 链查询**，不重写 basedOnParent，机制同 epic §8.2），在它们的 `abandonedRefs` 追加未处理记录；(d) 阻塞这些下游（有未处理记录），强制 accept-replan 或 abort

**已 closeout 的 wave**（边界场景）：slice replan 时如果某个 wave 已经 closed（真终态），cw 不追加 `abandonedRefs`（那是阻塞用的），只走 `staleLog`（只记不阻塞，不强制处理）——机制同 epic §8.2「已 closeout 的下游」段。这是 slice 层最常见的边界场景（一个 slice 拆了 N 个 wave，前 N-1 个 closeout 了，最后一个在跑，这时 slice 发现 techPlan 要改）。

**slice 的双向 replan 角色**（和 epic 不同，和 feature 对称）：slice 在 replan 机制中同时扮演两个角色——
- **作为发起者**：slice 改自己的 TC/IF/DM/ERR（上面描述的 4 步机制），标下游 wave
- **作为承受者**：被上游 feature replan 标记（feature 改 FR/AC 触发下游 slice 的 abandonedRefs，refKind=`specItem`）。此时 slice 自己被阻塞，必须调 `cw slice accept-replan` 或 `cw slice abort` 解锁

这是 slice（和 feature）区别于 epic（只发起，不承受）的重要特性。epic 是顶层，basedOnParent 永远为空，永远是发起者。

---

## 7. slice 的命令一览

> 命令约定（参数传递 / 输出格式 / exit code 语义）见 [epic 文档 §8.0](./design-v4-epic.md#80-命令约定所有-scope-通用)，本文档不重复。

```bash
# 主流程（8 步）
cw slice create <slug> --from-feature <feature-id> --objective "..."
#   --slug / --from-feature / --objective 必填
#   继承父 feature 的 Clarification id + FR/AC/UC id（全量拷贝 id 到 basedOnParent）
#   注意：slice 比 feature 多继承 spec 项（FR/AC/UC），因为 slice 是 feature 的直接下游

cw slice clarify <id>                              # progressive
#   输入数据从 stdin 读：{ clarifications: [...] }
#   技术维度的澄清（选哪个库、错误态怎么抛）

cw slice plan <id>                                 # progressive
#   输入数据从 stdin 读：{ techPlan: [...], waveSplit: [...] }
#   techPlan 存入 slicePlan.techPlan，waveSplit 存入 slicePlan.waveSplit

cw slice verify <id>                               # progressive
#   机器 gate：tech-choice-non-empty / wave-split-non-empty / wave-split-dag-valid
#   业务判断非空（同 epic / feature）

cw slice execute <id>                              # 启动 wave 层
#   根据 waveSplit 创建 wave 实例，每个 wave 进入 created
#   每个 wave 的 basedOnParent 继承 slice 的 Clarification id + TC/IF/DM/ERR id（不含 TD）

cw slice test <id>                                 # wave 全 closeout 后整体验证
cw slice retrospect <id>                           # 复盘
cw slice closeout <id>                             # 一次性，不可逆

# 旁路（同 epic §8.2）
cw slice abort <id>                                # 任何非终态 → aborted，连带销毁所有非终态子孙（wave）
cw slice replan <id>                               # progressive，不改 status
#   输入数据从 stdin 读：{ abandonItems: [...], newItems?: [...] }（详见附录 ReplanInput）
#   abandonItems 可含 Clarification id 或 FR/AC/UC id（继承自 feature，未减少的部分）
#   或 TechSection id（TC/IF/DM/ERR，slice 自己 techPlan 项）
#   注意：slice 不引入新的 plan 项类型——还是引用 feature 的 Clarification/FR/AC/UC
#         + 自己 techPlan 项的 TC/IF/DM/ERR id，统一机制
#   做四件事：(a) 旧项 status=abandoned + replacedBy 指向新版本
#             (b) 如有 replacementContent，新增新版本（cw 自动生成新 id 如 TC1-v2）
#             (c) 反查子树里 basedOnParent 含被废弃项 id 的 wave（**沿 replacedBy 链查询**，不重写 basedOnParent，机制同 epic §8.2），在 abandonedRefs 追加未处理记录
#             (d) 这些下游阻塞所有改状态 action（只读查询不阻塞），强制 accept-replan 或 abort
#   详见 epic 文档 §8.2

cw slice accept-replan <id> --reason "为什么接受新决策"
#   仅当 slice 自己的 abandonedRefs 有未处理记录时有效（被上游 feature replan 标了）
#   cw 在 abandonedRefs 对应记录追加 resolvedAt + resolvedAction，basedOnParent 不动（append-only）

# 查询（不走状态机）
cw slice status <id>                               # 单个 WorkUnit 快照
cw slice list [--status planning] [--feature <feature-id>]   # slice 列表
cw slice show <id>                                 # 详情（含 slicePlan.techPlan + waveSplit）
```

---

## 8. 后续文档会展开的内容

本文档只讲了 slice 层。以下内容在后续文档展开，**不在本文档范围**：

| 内容 | 何时讲 |
|---|---|
| **wave 层**（流程同 epic，plan = 写测试，execute = dev，test = 跑测试，唯一执行型）| design-v4-wave.md |
| **机器验证机制**（wave 的测试如何不信任 agent 声明、重算 expected）| wave 文档 |
| **stale 文档**（replan 触发的子孙过期同步、abandonedRefs / staleLog 的完整字段）| stale 文档 |
| **claim 文档**（多 agent 并行时，避免两个人同时做同一个 slice）| claim 文档 |
| **ADR 文档**（重要 slice 级技术决策跨 feature 复用）| ADR 文档 |
| **research 服务**（Clarification type=research 时，agent 调外部查询）| research 文档 |

---

## 9. 设计原则小结

slice 层继承 epic 的 15 条 + feature 的 3 条（见 [epic 文档 §11](./design-v4-epic.md#11-设计原则小结) 和 feature 文档 §9），补充 slice 特有的 2 条：

19. **技术方案是 slice 的核心产物，且 IF/DM 稳定性比 TC 还重要**：slice 的价值在于把 feature 的需求 spec 翻译成 wave 能照着施工的技术方案（techPlan）。techPlan 的 IF/DM（接口契约/数据模型）一旦不稳，所有 wave 跟着返工——所以 slice plan 在 IF/DM 上花的时间比 TC 还值（TC 选错了只影响一个 wave，IF 不稳会影响所有消费它的 wave）。

---

## 附录：slice 层接口（实施参考）

```typescript
interface Slice {
  id: string;                    // "slice:oauth-backend"
  scope: "slice";
  slug: string;
  status: "created" | "clarifying" | "planning" | "verified"
        | "executing" | "tested" | "retrospected" | "closed" | "aborted";
  statusHistory: StatusEvent[];
  parentUnitId: string;          // 父 feature id
  objective: string;             // create 时必填
  basedOnParent: string[];       // 从 feature 继承的 Clarification id + FR/AC/UC id（plan 时可减少）
                                  // 注意：slice 比 feature 多继承 spec 项（FR/AC/UC）
                                  // append-only 历史记录，永不重写（见 epic §7.3）
  abandonedRefs: AbandonedRef[]; // 被废弃的引用及处理状态（和 epic / feature 同构）。空数组 = 不阻塞
  clarifications: Clarification[];          // clarify 阶段填（slice 自己的 Clarification）
  plan?: SlicePlan;                         // plan 阶段填（含 techPlan + waveSplit 作为内部字段）
  verifyJudgment?: VerifyJudgment;          // verify 阶段填（业务判断）
  childUnitIds: string[];                   // execute 时填（wave ids）
  testJudgment?: TestJudgment;              // test 阶段填（对照 verifyJudgment 验收）
  retrospectData?: RetrospectData;          // retrospect 阶段填（对照 verifyJudgment 复盘，含 reviewedItems）
  evidence?: Evidence;                       // closeout 时填
  payload: SlicePayload;
}

// ── plan 产物（plan 阶段）──
// techPlan + waveSplit 都降级为 plan 的内部字段（顶层概念不暴露 TechSection）
interface SlicePlan {
  techPlan: TechSection[];       // 技术方案（featurePlan.spec 的技术层对应物）
  waveSplit: WaveSplit[];        // wave 拆分清单（含依赖 DAG）
}

type TechSection = SlicePlan['techPlan'][number];  // TechSection 仍是类型，但不再是顶层概念

interface WaveSplit {
  slug: string;                  // "exchange-token-skeleton"
  description: string;           // 一句话描述
  dependsOn: string[];           // 依赖的其他 wave slug
  // 注意：wave 负责哪些 TechSection 项的引用关系，
  //       由 wave.basedOnParent 统一承载（wave create 时从 slice 继承，见 §4.5）
}

// ── TechSection 判别联合（5 种结构化类型 + 2 种兜底，见 §5）──
// 设计上照搬 SpecSection 的判别联合模式，内容是纯技术维度

// 技术选型——最核心的技术决策记录
interface TechChoice {
  id: string;              // "TC1"
  area: string;            // "认证库" / "HTTP 客户端" / "状态管理"
  choice: string;          // "oauth2-client v3.2"
  alternatives: string;    // 考虑过但没选的（"passport-oauth / 自研"）
  rationale: string;       // 为什么选这个（成熟、文档全、社区活跃）
  status: "active" | "abandoned";  // 支持 replan（同 Clarification / FR）
  replacedBy?: string;
}

// 接口契约——slice 对外 / 对其他 slice 的承诺
interface Interface {
  id: string;              // "IF1"
  name: string;            // "exchangeToken"
  signature: string;       // "(code: string) => Promise<Token>" 或 "POST /api/oauth/token"
  contract: string;        // 输入/输出/错误码/副作用（自由描述，人审）
  status: "active" | "abandoned";
  replacedBy?: string;
}

// 数据模型——核心类型定义
interface DataModel {
  id: string;              // "DM1"
  name: string;            // "TokenPair" / "users 表"
  definition: string;      // TypeScript 类型定义 / SQL DDL / JSON schema
  notes?: string;          // 约束、索引、不变量说明
  status: "active" | "abandoned";
  replacedBy?: string;
}

// 错误处理策略
interface ErrorSpec {
  id: string;              // "ERR1"
  interfaceId?: string;    // 关联的 Interface id（可选——全局错误策略可不填，接口级错误必填）
  scenario: string;        // "OAuth 提供商返回 invalid_grant"
  strategy: string;        // "返回 401 + 提示重新登录，不重试"
  status: "active" | "abandoned";
  replacedBy?: string;
}

// 技术决策（引用 Clarification）——对应 feature 的 decisions 章节
interface TechDecision {
  id: string;              // "TD1"
  decision: string;
  rationale: string;
  sourceClarification?: string;  // 投影自哪个 Clarification（同 feature SpecDecision 的 TODO）
  // 注意：TechDecision 不独立持有 status/replacedBy——引用 Clarification，跟随 Clarification replan
  // 重要：wave 不继承 TD id（只继承 TC/IF/DM/ERR），因为 TD 是决策记录不是施工依赖。
  // 对齐 feature 不让 slice 继承 SpecDecision 的做法（避免「TD 无法被 slice replan 作废但又被下游引用」的矛盾）
}

// 兜底章节（照搬 feature 的 outOfScope / section）
// outOfScope / section 继承 cw 0.x 定义（见 src/types.ts），不展开。
// 这些非 id 化的章节通常不参与 replan，不需要 status/replacedBy。

// ── Clarification / AbandonedRef（和 epic / feature 同构）──
// 定义见 epic 文档附录，slice 层不重复定义。
// Clarification 的 status/replacedBy、AbandonedRef 的 refKind/resolvedAt/resolvedAction
// 语义和 epic / feature 完全一致。

// VerifyJudgment / TestJudgment / RetrospectData / Tradeoff / Risk / VerifyItemRef
// 这些类型所有层共享，定义在 epic 文档附录。slice 层不重复定义。
// slice 的 verifyJudgment.layerSpecific 典型 KV（都是人审判断，gate 只验非空）：
//   techChoiceRationale: string       每个 TechChoice 的选型理由是否充分
//   interfaceContractNote: string    接口契约设计是否合理
//   testabilityNote: string          技术方案是否可测（依赖注入够不够、mock 点留没留）
//   crossWaveContractNote: string    跨 wave 的接口契约是否对得上

// slice 的 transitions 规则（与 epic / feature 完全相同）
const SLICE_TRANSITIONS = {
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
  // slice 不是顶层，可能被上游 feature replan 标记（feature 改 FR/AC 触发下游 slice 的 abandonedRefs）
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
  techPlan: TechSection[];       // 技术方案（存入 slicePlan.techPlan，feature 的 spec 对应物）
  waveSplit: WaveSplit[];        // wave 拆分清单（存入 slicePlan.waveSplit，feature 的 sliceSplit 对应物）
}

// replan 的输入数据（slice 层定义自己的判别联合，见下方 SliceReplanInput）。
// slice 用 Clarification / FR / AC / UC（继承自 feature 的引用，未减少的部分）+ TechSection 四种 kind：
//   - Clarification：slice 自己 clarify 产生的
//   - FR/AC/UC：从 feature 继承的 spec 项（slice replan 一般不改这些，但机制上允许）
//   - TC/IF/DM/ERR：slice 自己 techPlan 项（slice replan 最常见的场景）
// 同构的是 replan 的 4 步机制，不是 ReplanInput 类型集合。slice 定义自己的判别联合（详见 epic 附录说明）：
interface SliceReplanInput {
  abandonItems: Array<{
    id: string;
    refKind: "clarification" | "specItem" | "techItem";
    replacementContent?: SliceReplacementContent;
  }>;
  newItems?: Array<SliceNewItem>;
}

type SliceReplacementContent =
  | { kind: "Clarification"; question: string; resolution?: string; type: "research" | "grilling" }  // 同 epic
  | { kind: "FR"; title: string; detail: string; ac: string[] }                                         // 同 feature
  | { kind: "AC"; condition: string; verification?: "unit" | "manual" | "review" }                     // 同 feature
  | { kind: "UC"; actor: string; scenario: string; expectedResult: string }                             // 同 feature
  // slice 扩展（TechSection 项）：
  | { kind: "TC"; area: string; choice: string; alternatives: string; rationale: string }
  | { kind: "IF"; name: string; signature: string; contract: string }
  | { kind: "DM"; name: string; definition: string; notes?: string }
  | { kind: "ERR"; interfaceId?: string; scenario: string; strategy: string };

type SliceNewItem = SliceReplacementContent;

// slice 的 verify gate
const SLICE_VERIFY_GATES = [
  // 结构完整性
  "tech-choice-non-empty",         // techPlan 至少 1 条 TechChoice（技术方案的核心）
  "wave-split-non-empty",          // waveSplit 至少 1 个
  "wave-split-dag-valid",          // wave 依赖关系无循环
  // 注意：slice 不做 TechSection 间的强引用 gate（如 IF→DM）——
  //       技术方案的引用关系比 FR-AC 复杂，机器验不出有意义的约束，靠人审（见 §5.2）
  // 业务判断非空（同 epic / feature，验「agent 有没有填」，不验内容对错）
  "verify-necessity-non-empty",    // verifyJudgment.necessity 非空
  "verify-sufficiency-complete",   // sufficiency 三项（gaps/overlaps/meceNote）都填
  "verify-alternatives-non-empty",  // alternatives 非空（五个核心维度都机器验非空，同 epic / feature）
  "verify-tradeoffs-present",      // tradeoffs 至少 1 条，或显式声明「无」+ 理由
  "verify-risks-present",          // risks 至少 1 条，或显式声明「无」+ 理由
];

// slice 的 test gate（wave 全 closeout 后）
const SLICE_TEST_GATES = [
  "all-waves-closed",              // 所有 child wave status === closed
  // test-references-verify：testJudgment 必须逐条对应 verifyJudgment 的每一类（引用一致性）
  // 校验项：necessityMet / sufficiencyMet / alternativesReconsidered 非空，
  //         每个 Tradeoff.id 都有对应的 tradeoffCostRealized.tradeoffRef，
  //         每个 Risk.id 都有对应的 riskOutcome.riskRef（不能漏验任何一类/任何一条）
  "test-references-verify",
];

// slice 的 retrospect gate
const SLICE_RETROSPECT_GATES = [
  "lessons-learned-non-empty",     // retrospectData.lessonsLearned 非空（机器 gate）
  "retrospect-covers-verify",      // reviewedItems 覆盖 verifyJudgment 每项（机器 gate，验覆盖不验 verdict）
  // 人审（机器验不了）：reviewedItems 的 verdict 是否判断得对、note 质量深不深
];
```

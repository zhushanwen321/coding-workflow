# cw 1.0 设计文档 v5 · feature 层

> 本文是 v5 feature 层的设计。流程/状态机/通用字段见 [design-v5-model.md](./design-v5-model.md)，本文只描述 feature 的差异。本文使用的所有概念以 model 文档词表为准。
>
> **feature 是 PlanningUnit**（model §1.1）：7 步流程，**无 test、无 exec-review**。retrospect 兼做验收。
>
> feature 的核心差异（相对其他层）：
> 1. **clarify 产出 FeatureSpec**（扁平化的 FR/AC/UC 需求规格）—— 这是 feature 的核心产物，也是本文的重点
> 2. feature 的 `clarifications` 是 **`FeatureClarification` 容器对象**（含 `clarifications` + `spec`），不是其他层的 `Clarification[]` 数组（model §5.9）
> 3. plan 用 **`Plan` 基类**（只 split），每个 split 项通过 `inheritedItemIds` 显式声明子层继承关系
> 4. execute 产物是 **`PlanningExecuteResult { childUnitIds }`**（启动 slice 层）
> 5. retrospect 用 **`PlanningRetrospectData`**（兼验收：slice 组合兑现 feature spec 吗）
>
> 本文不重复 model 文档的公共定义（流程步骤、状态机、通用字段、replan 机制）。

---

## 0. feature 是什么（类型、职责、粒度）

引用 model §1.2 对照表本行：

| 维度 | feature |
|---|---|
| 类型 | **PlanningUnit**（model §1.1），7 步流程 |
| 什么意思 | 单个用户可感知的独立特性 |
| execute 做什么 | 启动 slice 层（递归），不写代码 |
| 写不写代码 | 否（代码在 wave 层）|
| 粒度 | 单特性 |

**feature 在 4 层里的位置**：

```
epic 「重构认证系统」
  └─ feature 「OAuth 登录」       ← 本文讲这一层
       ├─ clarify:        澄清需求细节 + 写 FeatureSpec（FR/AC/UC）
       ├─ plan:           拆 slice（plan.split，每项声明 inheritedItemIds）
       ├─ design-review:  审 spec 合理性 + slice 拆分（执行前）
       ├─ execute:        启动 slice 层（每个 slice 走自己的 7 步）
       └─ retrospect:     slice 全 closeout 后，验收（slice 组合兑现 spec 吗）+ 复盘（兼两职）
```

**典型 feature 例子**（epic = 「重构认证系统」）：
- `oauth-login`：OAuth 登录（支持 GitHub / Google）
- `session-management`：会话管理（token 存取、过期、续期）
- `permission-control`：权限控制（基于角色的访问控制）

**feature 的核心特征**：
- **单特性边界**：一个 feature 只做一个用户可感知的特性，边界清楚（能一句话说清「这个 feature 做完了，用户能 X」）
- **跨多个 slice**：一个 feature 通常拆成多个 slice（前端 + 后端 + 集成联调等）
- **需求驱动**：feature 的核心产物是 FeatureSpec（需求规格），下游 slice 照 spec 施工
- **只规划不写代码**：feature 的 execute = 启动 slice 层，自己永远不产出代码

**为什么需要 feature 层**：epic 层只决定「做哪些大块」和「关键架构决策」，粒度太粗，slice 没法直接接手。中间缺一层把决策翻译成具体需求的环节：
- epic 说「用 OAuth」——但 slice 要知道**支持哪些 OAuth 提供商、错误态怎么展示、token 存哪**
- epic 说「支持 admin/user/guest 三种角色」——但 slice 要知道**每种角色具体能做什么、权限边界在哪**

一个 feature 的需求通常跨多个 slice（前端 + 后端 + 集成），如果每个 slice 各写各的 spec，会出现需求矛盾、AC 重复或遗漏。feature 层统一写 spec，slice 只通过 `basedOnParent` 引用自己负责的部分（由 feature 的 `plan.split[i].inheritedItemIds` 显式声明），保证需求一致性。

**feature 的核心职责**：把 epic 给出的**需求方向**（继承自父 epic 的 Clarification）翻译成 slice 能接手的**需求 spec**（FR/AC/UC）。

**feature 的核心产物**：**FeatureSpec**（`FunctionalRequirement` / `AcceptanceCriterion` / `BusinessCase` + `Decision` / `outOfScope` 等，model §6）。这是 feature 层的标志性产物——**FR/AC/UC 只在 feature 层产生**，其他层不定义需求条目（epic 只产 Clarification，slice 只产技术条目，wave 只产执行条目）。详见 §2。

**和 epic 的边界**（上游）：epic 决定方向，feature 翻译成需求。具体例子见上文「为什么需要 feature 层」（epic 说「用 OAuth」/「支持三种角色」→ feature 翻译成 FR/AC/UC）。feature 不重写方向，只把方向细化成可验收的需求；epic 的 Clarification 通过 `basedOnParent` 被继承，是 feature 的上游约束，不是 feature 自己 clarify 的产物。

**和 slice 的边界**（下游）：feature 管「需求对不对」，slice 管「技术方案合理不合理」。
- feature 产生 **FR / AC / UC**（需求层条目）——关心「系统要做什么、怎么算做完、端到端场景通不通」（`FunctionalRequirement` / `AcceptanceCriterion` / `BusinessCase`）
- slice 产生 **SliceTechChoice / SliceInterface / SliceDataModel / SliceErrorSpec**（技术层条目，model §5.7）——关心「token 交换用哪个库、接口签名长什么样、错误态怎么向上抛、数据结构是什么」
- slice **消费** FR/AC/UC（通过 `basedOnParent` 引用，由 `plan.split[i].inheritedItemIds` 显式声明）翻译成技术条目，但 **不重新定义需求**——slice 不能加 FR、不能改 AC 的验收条件、不能造 UC，只能在 feature 定的需求上回答技术问题
- feature **不做技术选型**（那是 slice 的事）——feature 的 `Decision`（如「token 存 httpOnly cookie」）是需求维度的决策投影自 feature 的 Clarification，不是技术选型；具体用什么库实现、接口怎么设计是 slice 的 `SlicePlan` 条目
- 如果 feature design-review 时发现某个 FR 的技术实现路径存疑，应该在 feature 的 clarify 阶段补 Clarification（需求维度），**不下沉到 slice 层做技术判断**（判据见 §4.1：单个 slice 内部的技术不确定性归 slice，跨 slice 协调风险归 feature）

**feature 的特殊点**（中间层）：feature 是 4 层里的中间层——既有 `parentUnitId`（指向父 epic），又有 `executeResult.childUnitIds`（启动的 slice 列表）。这意味着 feature 在 replan 机制里**同时是发起者和承受者**（§7）：改自己的 FeatureSpec 会级联 abort 下游 slice，自己的 `basedOnParent` 命中废弃 epic Clarification 又会被上游级联 abort。

---

## 1. feature 的流程

feature 走 **PlanningUnit 的 7 步**（model §2.1）：

```
create → clarify → plan → design-review → execute → retrospect → closeout
 创建     澄清     规划    设计审查         执行      复盘+验收     收尾
```

**没有 test 和 exec-review**——feature 不产出代码，无需跑测试或审代码品味。feature 的 execute 产物是「slice id 列表」，当下层全部 closeout 后，feature 进入 retrospect，retrospect 兼做两件事：① 对照 designReviewJudgment 验收「slice 组合起来兑现了 feature spec 吗」② 提炼经验（model §2.1）。

各步骤的业务内容（通用规则见 model §2，本文只写 feature 特化部分）：

| 步骤 | feature 特化内容 | 产物字段 |
|---|---|---|
| **create** | 建实例，写下 objective（feature 完成后用户能做什么，1-2 句话）。`parentUnitId` 指向父 epic | `objective` |
| **clarify** | 识别需求要定清楚必须先回答的问题（**Clarification**），逐个给答案；并把答案**规格化成 FeatureSpec**（FR/AC/UC）。这是 feature 的核心步骤，详见 §2 | `clarifications: FeatureClarification` |
| **plan** | 基于 FeatureSpec **拆 slice**（`plan.split`），每个 split 项通过 `inheritedItemIds` 显式声明「这个 slice 负责哪些 FR/AC/UC」。详见 §3 | `plan: Plan`（基类）|
| **design-review** | 启动 slice 层**之前**，对 spec 和 slice 拆分做结构化业务判断。详见 §4 | `designReviewJudgment` |
| **execute** | 根据 `plan.split` 创建 slice 实例，把 `inheritedItemIds` 写入对应 slice 的 `basedOnParent`。详见 §5 | `executeResult: PlanningExecuteResult` |
| **retrospect** | 所有 slice closeout 后，**兼做验收 + 复盘**：① 对照 designReviewJudgment 验收「slice 组合兑现 spec 吗」② 复盘哪些判断错了。详见 §6 | `retrospectData: PlanningRetrospectData` |
| **closeout** | 补 evidence 主观部分 + cw 校验 artifacts drift + 冻结 evidence（`frozenAt`）→ status `closed`。evidence 的客观部分在 execute 阶段已生成（§5.4），closeout 只补主观 + 验 drift + 冻结，归档不可逆 | `evidence`（冻结）|

**objective 例子**（feature = `oauth-login`）：
> 用户能用 GitHub 或 Google 账号登录系统，登录成功后获得会话 token，失败时看到清晰的错误提示。

---

## 2. feature 的 clarification.spec 结构（FeatureClarification / FeatureSpec）

**这是 feature 文档的核心章节**。feature 的 clarify 产出两样东西，统一存在 `FeatureClarification` 容器里（model §6）：

```typescript
interface FeatureClarification {
  clarifications: Clarification[];    // 需求维度的澄清项（机制同其他层，model §5.9）
  spec: FeatureSpec;                  // 规格化条目（扁平字段，v5 删掉了 SpecSection 判别联合）
}
```

**为什么 feature 的 clarifications 是容器对象（其他层是数组）**：feature 带 spec 子结构（FR/AC/UC），需要容器把 clarifications 和 spec 包在一起；epic/slice/wave 没有 spec 子结构，直接用 `Clarification[]`（model §5.9）。读取时注意：feature 走 `feature.clarifications.clarifications`（外层是容器，内层是数组），其他层走 `workUnit.clarifications`（直接是数组）。

### 2.1 FeatureSpec 完整结构

v5 删掉了 v4 的 SpecSection 判别联合（model §0.3、§8），feature 的 spec 扁平化为字段（和 slice 的 plan 结构对称，model §6）：

```typescript
interface FeatureSpec {
  // 结构化条目（继承 WorkUnitItem，支持 replan 追踪）
  functionalRequirements: FunctionalRequirement[];      // FR：系统要能做什么
  acceptanceCriteria: AcceptanceCriterion[];            // AC：怎么算做完
  businessCases: BusinessCase[];                        // UC：Actor 视角的完整使用场景

  // 投影条目（不继承 WorkUnitItem，跟随 Clarification）
  decisions: Decision[];                                // 决策（投影自 Clarification）

  // 规格辅助字段（非 id 化，不参与 replan）
  outOfScope: string[];                                 // 明确不做的事（防范围蔓延）
  goals?: string[];                                     // 可衡量的业务目标
  complexity?: "low" | "medium" | "high" | "unknown";   // 复杂度枚举（model §6，便于跨 feature 统计/优先级排序；未知填 "unknown"）

  // md 章节（cw 只存不校验 + report 渲染）
  background?: string;                                  // 背景说明
  constraints?: string;                                 // 约束条件
}
```

**设计依据**：沿用 cw 0.x 对实际 spec.md 内容模式的统计（FR 几乎都有，AC 84%，UC 42%，decisions 25%，goals 19%）。feature 直接用这套体系，不简化（每种都有实用场景）也不扩展（YAGNI）。

**v5 相对 v4 的关键变化**：
- 删掉 `SpecSection` 判别联合（`{ type: "functionalRequirements", items: [...] }` 这种包装）—— 直接用扁平字段 `functionalRequirements: FunctionalRequirement[]`
- 删掉 `section`（兜底自定义章节名）—— 实际 spec 统计里几乎不用，YAGNI；特殊需求放 `constraints` md 章节或 `background` 里
- 删掉 SpecVersion / specHistory / replaceSpecSections 等 cw 0.x 历史包袱（model §8）—— spec 变更走统一 replan（§7）

**一个典型的 feature spec**（oauth-login）：

```yaml
functionalRequirements:
  - FR1: 用户能用 GitHub 账号登录（ac: [AC1.1]）
  - FR2: 用户能用 Google 账号登录（ac: [AC2.1]）
  - FR3: 登录失败时展示分类错误提示（ac: [AC3.1, AC3.2]）
acceptanceCriteria:
  - AC1.1: 未登录用户点 GitHub 登录 → 3 秒内跳转回首页已登录（verification: unit）
  - AC2.1: 未登录用户点 Google 登录 → 3 秒内跳转回首页已登录（verification: unit）
  - AC3.1: 网络错误展示「网络异常请重试」（verification: manual）
  - AC3.2: 账号未授权展示「授权被拒绝」（verification: manual）
businessCases:
  - UC1: 未登录用户 → 点 GitHub 登录 → 授权 → 回首页已登录
decisions:
  - D1: token 存 httpOnly cookie（投影自 Clarification D1）
outOfScope:
  - 微信登录
  - 手机号登录
goals:
  - 登录成功率 ≥ 99%
complexity: medium  # 涉及 OAuth 流程 + token 管理，无外部系统对接
background: |
  现有 session 机制要保留兼容旧 API
constraints: |
  必须支持 PKCE 流程
```

下面逐个类型展开。

### 2.2 FunctionalRequirement（FR）

FR 描述「系统要能做什么」，是 feature spec 的骨架。FR **继承 WorkUnitItem**（model §4.1），独立持有 `id` / `status`，支持 replan 追踪（`status` 从 `active` 变 `abandoned`，详见 §7）。

```typescript
interface FunctionalRequirement extends WorkUnitItem {
  // id / status 继承自 WorkUnitItem（WorkUnitItem 只有 id + status，无 replacedBy，model §4.1）
  title: string;       // 一句话：「用户能用 GitHub 登录」
  detail: string;      // 详细描述（边界、例外、关联）
  ac: string[];        // 强引用 AC id（如 ["AC1.1", "AC1.2"]），让 FR-AC 覆盖关系可机器验
}
```

**填写规范**：
- **title 是动宾结构**：「用户能用 X 做 Y」，主语是用户/系统，不要写「X 功能」（那是模块名不是需求）
- **detail 写边界和例外**：正常流程 + 边界情况（如「GitHub 登录失败时不算登录次数」）+ 关联约束（如「和 FR3 的错误提示配合」）
- **ac 必须非空**：每个 FR 至少 1 条 AC，否则 design-review 的结构校验过不了（§4）
- **粒度**：一个 FR 对应一个用户可感知的功能点，不要把多个功能塞一个 FR（拆开，每个有自己的 AC）

**FR-AC 强引用（`ac` 字段）的设计理由**：cw 0.x 现状里 FR 和 AC 是两个并列 section，没显式关联，只能靠自然语言子串匹配（只 warning 不阻断），违反「机器验证」原则。v5 给 FR 加 `ac: string[]` 字段，让 design-review 能纯结构验证「每个 FR 至少有 1 条 AC 指着它、每个 AC 至少被一个 FR 引用」。**AC 不反向引用 FR**（避免双向同步负担）：从 FR 查 AC 用 `FR.ac`，从 AC 查 FR 用 `filter(FR.ac.includes(acId))`。

**诚实边界**：FR-AC 强引用只解决「引用关系完整性可机器验」，解决不了「AC 写得好不好」（AC 本身是否可验收、是否覆盖边界、措辞是否清晰）。后者是 agent 自审 + design-review 的 `acVerifiabilityNote` 人审判断（§4），不是机器 gate 的事。

### 2.3 AcceptanceCriterion（AC）

AC 描述「怎么算做完」，是可判定的完成条件。AC **继承 WorkUnitItem**，支持 replan 追踪（`status` 从 `active` 变 `abandoned`）。

```typescript
interface AcceptanceCriterion extends WorkUnitItem {
  // id / status 继承自 WorkUnitItem（无 replacedBy，model §4.1）
  condition: string;                              // 可判定的完成条件
  verification?: "unit" | "manual" | "review";    // 如何验证（cw 0.x 字段，v5 保持不变，model §7.3）
}
```

**填写规范**：
- **condition 必须可判定**：写「点 GitHub 登录 → 3 秒内跳转回首页已登录」，不写「登录要快速」「提示要友好」（无法验证）。design-review 的 `acVerifiabilityNote` 会审这条
- **verification 三选一**（可选字段，默认按层消费）：
  - `"unit"`：wave 的 test 阶段 cw 实跑测试验证（优先选这个，最严格）
  - `"manual"`：退化为人审（如「错误文案是否清晰」机器测不了）
  - `"review"`：需要 review 流程（如设计稿评审）
- **粒度**：一条 AC 对应一个可独立判定的事实，复合条件拆开

**verification 字段的消费场景**（model §7.3 沿用现有能力）：AC.verification 字段保持不变（不改名，因为 verify 步骤已改名为 design-review，不再混淆）。下游 wave 的 test 阶段消费它：`verification=unit` 则 cw 实跑测试，`verification=manual` 退化为人审。本文不展开 wave 的消费细节，见 wave 文档。

### 2.4 BusinessCase（UC）

UC 是 Actor 视角的完整使用场景，串联多个 FR 形成端到端故事。UC **继承 WorkUnitItem**，支持 replan 追踪（`status` 从 `active` 变 `abandoned`）。

```typescript
interface BusinessCase extends WorkUnitItem {
  // id / status 继承自 WorkUnitItem（无 replacedBy，model §4.1）
  actor: string;           // 谁（如「未登录用户」「管理员」）
  scenario: string;        // 在什么场景下做什么（步骤序列）
  expectedResult: string;  // 期望结果
}
```

**填写规范**：
- **actor 必须具体**：不写「用户」，写「未登录用户」「首次注册用户」「管理员」
- **scenario 是步骤序列**：写「打开登录页 → 点 GitHub 登录 → 跳转 GitHub 授权 → 同意 → 回跳」，不写「用户登录」（太抽象）
- **expectedResult 可独立验收**：能单独判断「达成 / 未达成」
- **UC 是可选的**：不是所有 feature 都需要 UC（cw 0.x 统计出现率 42%）。适合「端到端流程有多个分支或参与者」的 feature；简单的 CRUD feature 可以不写 UC，靠 FR + AC 覆盖

**UC 在 retrospect 的特殊价值**：UC 是 feature 验收时最容易暴露 Gap 的地方——单个 slice 能验自己负责的 FR/AC，但「UC1 全流程是否顺畅」要等所有 slice 组合起来才能验（§6 的跨 slice 验收重点查 UC）。

### 2.5 Decision

Decision 是 Clarification 的 spec 层投影，记录 feature clarify 阶段做出的重要决策。**Decision 不继承 WorkUnitItem**（model §4.1、§5.10），跟随 Clarification replan，不独立持有 `status`。

```typescript
interface Decision {
  id: string;                      // 直接用 Clarification 的 id（如 "D3"），和投影源一致
  decision: string;                // 决策结论：「token 存 httpOnly cookie」
  rationale: string;               // 为什么这么决定
  sourceClarification?: string;    // 投影自哪个 Clarification（id 和它一样）
}
```

**Decision 的关键规则**（model §5.10）：
- **id 和 Clarification 一致**：feature 的 Clarification D3 对应 feature 的 Decision D3，同一层内 id 不重号
- **投影自 feature 自己的 Clarification**（不是继承的 epic Clarification）：feature clarify 阶段回答的需求问题（如「token 存哪」），答案进 feature 自己的 `clarifications.clarifications`，同时投影成 feature spec 的 `decisions` 项。feature 从 epic 继承的 Clarification（在 `basedOnParent` 里）是 feature 的上游约束，不是 feature 自己 clarify 的产物，feature 的 Decision 不投影它们
- **跟随 Clarification replan**：feature 的 Clarification 被 replan 作废时，对应的 Decision 自动跟随（不独立参与 replan）
- **Decision id 不被下游 slice 继承**：feature 的 `plan.split[i].inheritedItemIds` 只声明 feature 的 Clarification id + FR/AC/UC id，**不含 Decision id**。理由：Decision 不独立持有 status，如果被下游引用会制造「无法被 feature replan 作废但又被 slice 引用」的矛盾（对齐 slice 不让 wave 继承 Decision 的做法）

**为什么 Decision 不继承 WorkUnitItem 而其他 spec 项继承**：FR/AC/UC 是独立的需求条目，可以单独被 replan 修改/作废；Decision 是 Clarification 的影子（投影），它没有独立生命周期，Clarification 动它就动，所以不需要独立的 status。

### 2.6 规格辅助字段（outOfScope / goals / complexity）

这些字段**不 id 化、不继承 WorkUnitItem、不参与 replan**——它们是 spec 的辅助说明，整体随 spec 修订。

| 字段 | 作用 | 填写规范 |
|---|---|---|
| `outOfScope: string[]` | 明确不做的事（防范围蔓延）| 列「**容易被误以为是这个 feature 范围内、但实际不做**」的事。如 oauth-login 的「微信登录、手机号登录」 |
| `goals?: string[]` | 可衡量的业务目标（可选）| 写可量化的指标，如「登录成功率 ≥ 99%」「P95 响应 < 500ms」。不写「用户体验好」（不可衡量）|
| `complexity?: "low" \| "medium" \| "high" \| "unknown"` | 复杂度评级（枚举，model §6）| 用于跨 feature 的复杂度统计和优先级排序。agent 在 clarify 阶段评估，可选填；拿不准时填 `"unknown"`。如 `medium：涉及 OAuth 流程 + token 管理，无外部系统对接` |

### 2.7 md 章节（background / constraints）

cw 对这两个字段**只存不校验内容 + report 时 md 渲染**。它们是 markdown 文本，不 id 化、不参与 replan。

| 字段 | 作用 |
|---|---|
| `background?: string` | 背景说明（为什么做这个 feature、上下游上下文）|
| `constraints?: string` | 约束条件（必须遵守的技术/业务限制，如「必须支持 PKCE 流程」「兼容旧 API」）|

**background 和 constraints 的区别**：background 是「为什么要做」（动机），constraints 是「做的时候必须遵守什么」（硬约束）。两者都是给下游 slice 看的上下文，slice plan 时会参考 constraints 决定技术方案。

---

## 3. feature 的 plan 结构（Plan 基类 + split 拆 slice 依据）

feature 的 plan **直接用 `Plan` 基类**（model §4.3），只有一个字段 `split`（拆 slice 清单）。feature 不需要单独的 `FeaturePlan` 子类型——feature 的所有规格化条目都在 FeatureSpec 里（clarify 阶段产出），plan 只负责拆下一层。

```typescript
// feature plan 就是 Plan 基类（model §4.2）
interface Plan {
  split: Split[];
}

interface Split {
  slug: string;                            // slice 的短名（如 "oauth-backend"）
  description: string;                     // 这个 slice 做什么
  dependsOn: string[];                     // 依赖哪些其他 slice（slug 列表）
  inheritedItemIds?: string[];             // 这个 slice 继承 feature 的哪些条目 id（v5 新增，model §4.2）
}
```

### 3.1 plan 的唯一产物：slice 拆分清单（`plan.split`）

基于 FeatureSpec，把 feature 拆成若干 slice。一个典型的拆分（oauth-login）：

| slice slug | description | dependsOn | inheritedItemIds |
|---|---|---|---|
| `oauth-backend` | OAuth 后端接口（token 交换、用户信息拉取）| — | [D1, FR1, FR2, AC1.1, AC2.1] |
| `oauth-frontend` | OAuth 前端（登录按钮、回调处理、错误展示）| `oauth-backend` | [D1, FR3, AC3.1, AC3.2, UC1] |
| `oauth-integration` | 端到端联调 + UC1 验收 | `oauth-backend`, `oauth-frontend` | [UC1, AC1.1, AC2.1] |

> 注：D1 是 Clarification id（也是 Decision id，两者一致，见 §2.5）。这里 inheritedItemIds 声明继承的是 feature 自己的 Clarification/FR/AC/UC id，**不是 epic 的 Clarification id**（那些是 feature 的上游，slice 要追溯 epic 可通过 feature.parentUnitId）。

### 3.2 `inheritedItemIds` 的语义（v5 新增，model §4.2）

每个 Split 项显式声明「这个 slice 负责 feature 的哪些条目」。execute 时 cw 根据 Split 创建 slice，把 `inheritedItemIds` 写入对应 slice 的 `basedOnParent`（model §4.2）。

**这是对 v4 的 basedOnParent 继承机制的重新设计**（model §4.2）：v4 是「cw 自动全量拷贝上游所有条目 id 到下游 basedOnParent，下游 plan 时再减少」——这会污染下游（下游不用的 id 也被记下来，basedOnParent 膨胀）。v5 改为「plan 阶段显式声明继承关系」，execute 时按声明写入，basedOnParent 只含真正相关的 id。

**inheritedItemIds 可以填什么**：
- ✓ feature 自己的 Clarification id（来自 `clarifications.clarifications`）
- ✓ feature spec 的 FR/AC/UC id（来自 `clarifications.spec`）
- ✗ **Decision id**（Decision 不独立持有 status，被下游引用会制造无法作废的矛盾，见 §2.5）
- ✗ epic 的 Clarification id（那些是 feature 的上游，不是 feature 能分配给 slice 的；slice 需要追溯 epic 可通过 feature.parentUnitId 链式查）

**inheritedItemIds 允许跨 slice 重叠**：同一个 FR/AC 可以被多个 slice 继承（如 `oauth-frontend` 和 `oauth-integration` 都引用 AC1.1——前端实现登录跳转，集成层做端到端验收）。这是正常的，代表「多个 slice 共同兑现同一个 AC」。

**inheritedItemIds 允许不全覆盖**：不是所有 FR/AC 都必须被某个 slice 继承。如果某个 FR 没有任何 slice 引用，design-review 的 MECE 检查（§4）会发现这个 gap，agent 要么补 slice 要么标 outOfScope。

> **这是 feature 层对 model §4.2 的工作流细化**：model §4.2 只规定 inheritedItemIds 显式声明继承关系（execute 时写入子层 basedOnParent），未明确要求/禁止「全覆盖」。feature 层允许不全覆盖——未覆盖的 FR/AC 由 design-review 的 sufficiency（MECE）检查兜底发现（gap 写进 `designReviewJudgment.sufficiency.gaps`，§4），不靠机器强约束。

### 3.3 slice 拆分的判据

**不给死规则，只给判据 + 典型维度**（强制维度会套在不适合的场景上）。判据必须同时满足：

- **单 session 可完成**：一个 slice 的所有 wave 加起来，一个开发 session 能做完。**单 session 是软锚点**（指一次集中工作时段，典型 2-4 小时），不是硬性卡死的规则。校准参考靠跨 feature retrospect 累积的实际数据，当前 v5 未实现自动校准
- **边界清楚**：slice 之间不重叠（允许共享 AC，但核心职责不重叠），每个 slice 能独立验收
- **可独立验收**：slice 有自己的 AC（通过 inheritedItemIds 引用），能单独判断做完没

典型拆分维度（按 feature 特点选，不强制）：

| 维度 | 适合的 feature | 例子 |
|---|---|---|
| **按技术层** | 全栈 feature | `oauth-backend` / `oauth-frontend` / `oauth-integration` |
| **按用例（UC）** | 用例边界清楚的 feature | `uc1-github-login` / `uc2-google-login` |
| **按交付优先级** | 可增量交付的 feature | `mvp-core` / `enhancement-error-handling` |

**判据比维度重要**：选哪个维度是 feature plan 时的判断（写进 design-review 的 `sliceSplitRationale`，§4），但选完必须满足三个判据。

---

## 4. feature 的 designReviewJudgment.layerSpecific

design-review 是 feature 的第 4 步（model §2.1），在启动 slice 层**之前**对 clarify 的 FeatureSpec 和 plan 的 slice 拆分做结构化业务判断。

**通用字段**（necessity / sufficiency / alternatives / tradeoffs / risks，model §5.8）所有层共享，feature 不重复定义。本文只写 feature 的 `layerSpecific`（KV 扩展点，model §5.8）。

### 4.1 feature design-review 要回答的通用问题

| 维度 | feature 特化的问题 |
|---|---|
| **necessity** | 这个 feature 对父 epic objective 的贡献是什么？没它行不行？ |
| **sufficiency（MECE）** | FeatureSpec 的 FR 加起来覆盖了 feature 的完整需求吗？有遗漏的功能点吗？有重叠的 FR 吗？slice 拆分（inheritedItemIds）覆盖了所有 FR/AC 吗？ |
| **alternatives** | spec 有没有过度设计？有没有更简单的实现路径？slice 拆分考虑过其他维度吗？ |
| **tradeoffs** | 哪些 FR 是妥协（如性能换简单、完整性换交付速度）？哪些 AC 是放宽的（如响应时间从 1s 放到 3s）？每个妥协的代价？ |
| **risks** | spec 层面的风险 + **跨 slice 协调风险**（接口契约对得上吗、跨 slice 共享数据/状态有无竞争、依赖链上哪环最易延误）。**注意**：单个 slice 的内部技术不确定性不在 feature design-review 评估——那是 slice 自己 design-review 的事。**判据**：如果某个风险的触发或缓解需要多个 slice 协同动作，归 feature；如果单个 slice 自己就能应对，归 slice。边界模糊时优先归 feature（feature 是上层，兜底）|

### 4.2 feature 的 layerSpecific 字段

feature 专属判断填入 `designReviewJudgment.layerSpecific`。按 model §5.8「layerSpecific 具名化约定」（各层应定义具名 interface 收紧，最低限度 `Record<string, string>`），feature 定义 **`FeatureDesignReviewLayerSpecific`**（对齐 slice 的 `SliceDesignReviewLayerSpecific`），把下列 6 个 key 收进具名 interface：

```typescript
// feature 层 design-review 的专属判断（model §5.8 layerSpecific 具名化约定）
interface FeatureDesignReviewLayerSpecific {
  specMeceNote: string;            // spec 的 MECE 整体结论
  sliceSplitRationale: string;     // 为什么这么拆 slice
  acVerifiabilityNote: string;     // AC 是否真的可验收
  consistencyNote: string;         // spec 各字段的一致性自检
  frAcCoverageNote: string;        // FR-AC 强引用的合理性自检
  sliceSpecCoverageNote: string;   // inheritedItemIds 是否覆盖应兑现的 FR/AC
}
```

**`FeatureDesignReviewLayerSpecific` 的所有字段都是必填**——这 6 个是 feature design-review 的硬性问题，缺一不可。各字段语义：

| layerSpecific 字段 | 含义 | 机器校验 |
|---|---|---|
| `specMeceNote` | spec 的 MECE 整体结论（FR 加起来是否覆盖完整需求、有无重叠）| 只验非空 |
| `sliceSplitRationale` | 为什么这么拆 slice（选了哪个维度、为何不用其他维度）| 只验非空 |
| `acVerifiabilityNote` | AC 是否真的可验收（有没有「快速」「友好」这种无法验证的 AC）| 只验非空 |
| `consistencyNote` | spec 各字段之间的一致性自检（FR/AC/UC 是否对得上、有无矛盾）| 只验非空 |
| `frAcCoverageNote` | FR-AC 强引用的合理性自检（每个 FR 的 AC 是否真的覆盖了它的完成条件）| 只验非空 |
| `sliceSpecCoverageNote` | inheritedItemIds 是否覆盖了所有应该被兑现的 FR/AC（对照 sufficiency 的 gap）| 只验非空 |

**所有 layerSpecific 字段都是 agent 的人审判断，gate 只验非空，不验内容**（model §5.8 的诚实原则）。spec 的一致性自检（v4 的 `spec-no-contradiction` gate）不再作为机器 gate——机器判不了「两个 FR 是否真的矛盾」，那是 agent 自检的职责，放进 `consistencyNote` 让 agent 显式回答。

### 4.3 机器 gate（验结构不验内容）

feature 的 design-review 机器 gate 验「结构完整性 + 业务判断非空」，不验内容对错（同 v4 的诚实原则，沿用 v4 的 gate 名作为实现参考）：

**结构完整性**：
- `fr-ac-coverage`：每个 FR 的 `ac` 数组非空且 id 都存在（正向）
- `ac-reachable-from-fr`：每个 active AC 至少被一个 active FR 引用（反向，防孤儿 AC）
- `ac-non-empty`：AC 至少 1 条
- `slice-split-non-empty`：`plan.split` 至少 1 个
- `slice-split-dag-valid`：slice 依赖关系无循环

**业务判断非空**：
- `designReviewJudgment.necessity` 非空
- `designReviewJudgment.sufficiency` 三项填齐（gaps / overlaps / meceNote）
- `designReviewJudgment.alternatives` 非空
- `designReviewJudgment.tradeoffs` 至少 1 条（或显式声明「无」+ 理由）
- `designReviewJudgment.risks` 至少 1 条（或显式声明「无」+ 理由）

**诚实说明**：cw 验「agent 有没有填这些字段」，验不了「spec 写得好不好、AC 写得对不对」。内容质量由 agent（或人审）负责。判断存在 `designReviewJudgment` 里，是 retrospect 对照的基础（§6）。

**通过的含义**：spec 定稿，可以启动 slice 层了。

> **注**：具体 gate 名（如 `fr-ac-coverage`）是 v4 沿用的实现参考，v5 model 文档未规定具体 gate 名，实现时可调整。本节描述的是「该验什么」，不是「gate 必须叫什么」。

---

## 5. feature 的 execute（启动 slice / childUnitIds）

feature 自己不写代码，它的 execute = **启动 slice 层**（递归，机制和其他 PlanningUnit 对称）：

```typescript
// feature 的 execute 产物（model §2.5）
interface PlanningExecuteResult extends ExecuteResult {
  childUnitIds: string[];          // 下层 slice 的 id 列表
}
```

### 5.1 execute 做什么

1. **根据 `plan.split` 创建 slice 实例**，每个 slice：
   - `parentUnitId` 指向这个 feature
   - `basedOnParent` 由 cw 从对应 `split[i].inheritedItemIds` 写入（**显式声明继承关系**，model §4.2，不是 v4 的全量拷贝）
2. 每个 slice 进入 `created` 状态，开始走自己的 7 步流程
3. feature 进入 `executing` 状态，**等**所有 slice 走完它们的 7 步流程

### 5.2 inheritedItemIds → basedOnParent 的写入

execute 时 cw 遍历 `plan.split`，对每个 split 项：
- 创建一个 slice 实例
- 把 `split.inheritedItemIds` 的值写入 `slice.basedOnParent`

**这是 v5 的关键变化**（model §4.2）：v4 是 cw 把 feature 当前的所有 Clarification + FR/AC/UC id 全量拷贝到每个 slice.basedOnParent（slice plan 时再减少）；v5 改为按 split 显式声明写入，basedOnParent 只含真正相关的 id。

**basedOnParent 是创建时的历史快照，append-only，永不重写**（model §4.2、§5.3、§5.6）。后续 feature replan 改了 FR/AC，cw **不重新计算 basedOnParent 差异、不追加任何东西到 basedOnParent**——而是把引用了废弃条目的 slice（及其所有子孙）**级联 abort**，由 agent 通过 `cw create slice` 重建承接新条目的 slice（详见 §7）。换言之：basedOnParent 在 execute 时写一次就定格，replan 走「abort 旧 slice + 重建新 slice」，不走「改 basedOnParent」。

### 5.3 feature 在 execute 阶段做什么

**等**。feature 进入 `executing`（长状态，可能跨多个 session），等所有 slice 走完它们的 7 步流程全部 closeout 后，feature 进入 retrospect（§6）。

**中途 feature 被 epic replan 影响**（feature 同时是发起者和承受者，§7）：若 epic replan 废弃的条目被 feature 的 basedOnParent 引用，cw 把 feature（及其所有子孙 slice/wave）级联 abort，并在 feature 的 abandonedRefs 追加 `{ workUnitItemId, abandonedAt }`。agent 看 cw 返回的 pendingRebuild 决定是否重建 feature（§7.3）。

### 5.4 execute 完成时初始化 PlanningEvidence（客观部分）

feature 的 `evidence` 是 **`PlanningEvidence`**（model §5.11，跨阶段产物，不是 closeout 独占）。execute 启动 slice 后，cw 立即初始化 evidence 的**客观字段**：

- `generatedAt`：evidence 首次生成时间（ISO 8601）
- `childDelivery: ChildDeliveryRecord[]` 的**初始快照**——每个 `plan.split` 项对应一条记录：
  - `splitSlug`：split 的 slug
  - `childUnitId`：cw 刚创建的 slice id
  - `childStatus`：slice 此刻刚 created，还未到 `"closed" | "aborted"` 任一终态——该字段在初始快照里暂记为 slice 当前 status 的映射（实现侧可用 nullable / 中间值表达「未到终态」），**等 slice 进入终态（closed 或 aborted）时才更新为对应的终态值**（model §5.11.1 的 `childStatus: "closed" | "aborted"` 指的是 child 最终状态，rollup 在 child 到终态后才完整）
  - `childEvidenceSummary?`：留空（slice 还没有自己的 evidence.summary，等 slice closeout 后 rollup 上来）

**childDelivery 是「初始快照」，会随 child slice 状态变化更新**（直到 closeout 冻结才定格）：

- slice 状态推进（如 `created → ... → closed`）时，cw 更新对应 `childDelivery[].childStatus`
- slice closeout 冻结自己的 evidence 后，cw 把 slice 的 `evidence.summary` rollup 到对应 `childDelivery[].childEvidenceSummary`
- slice 被 abort（feature replan 触发级联 abort，§7）时，对应 `childDelivery[].childStatus` 更新为 `"aborted"`

**evidence 此时只填客观部分**——主观部分（`summary` + `artifacts`）和冻结（`frozenAt`）留到 closeout（§6.7）。详见 model §5.11 / §5.11.3。

---

## 6. feature 的验收（retrospect 兼验收）

feature 没有 test 步骤（model §2.1）。所有 slice closeout 后，feature 直接进入 retrospect，**retrospect 兼做两件事**（model §5.8 的 `PlanningRetrospectData`）：
1. **验收**：slice 组合起来兑现了 feature spec 吗？（对照 designReviewJudgment 的 sufficiency）
2. **复盘**：designReviewJudgment 哪些判断事后证明错了？（提炼经验）

### 6.1 验收的输入：三者对照（evidence 消费）

PlanningUnit 的 retrospect 兼验收——agent 在验收时**同时看三样东西**，缺一不可：

| 输入 | 来自 | 回答的问题 |
|---|---|---|
| ① **clarification + plan**（FeatureSpec + `plan.split`）| clarify / plan 阶段 | **要做什么**：feature 定了哪些需求、拆了哪些 slice |
| ② **designReviewJudgment**（含 `FeatureDesignReviewLayerSpecific`，§4.2）| design-review 阶段 | **期望什么 / 方案对不对**：当初认为 spec 是否 MECE、slice 拆分是否合理、AC 是否可验收 |
| ③ **PlanningEvidence**（`childDelivery`，§5.4）| execute 阶段 cw 自动填 | **实际做了什么**：每个 split 对应的 child slice 交付了吗、最终 status 是 closed 还是 aborted |

**三者对照才能验收「下层组合兑现了我的规划吗」**——只看 ① + ② 是「纸上验收」（方案对，但不知道实际交付没），只看 ③ 是「盲目验收」（交付了，但不知道该不该交付这些）。必须三者放在一起：①② 是期望，③ 是实际，对照才知道兑现度。

**evidence 绑定 plan**：`PlanningEvidence.childDelivery` 的每条记录按 `splitSlug` 对照 `plan.split`——每个 split 项有没有对应的 child、child 最终交付了没。这给 `splitFulfillment`（§6.3）提供客观依据。

**evidence 绑定 judgment**：`PlanningRetrospectData.deliveryVerdict`（§6.3）引用 evidence 的客观交付情况作判断依据——`childDelivery` 里多少 slice closed / aborted、aborted 的 slice 影响了哪些 split，直接影响 `deliveryVerdict` 取 `delivered` / `partial` / `failed`。

**evidence 和 PlanningRetrospectData 的分工**（不互相替代，model §5.8）：

| 产物 | 定位 | 谁填 | 性质 |
|---|---|---|---|
| `PlanningEvidence.childDelivery` | **客观交付记录**（rollup）| cw 自动填 | 事实（slice 最终 status + child evidence summary 引用）|
| `PlanningRetrospectData.deliveryVerdict` / `childUnitIdsEvidence` / `splitFulfillment` | **主观验收结论** | agent 在 retrospect 时填 | 判断（基于客观记录 + agent 对 spec 兑现度的主观评估）|

agent 填 `childUnitIdsEvidence` / `splitFulfillment` 时**引用** `PlanningEvidence.childDelivery` 提供的客观数据（如「slice-A 最终 aborted，evidence 显示...」），但结论（delivered/partial/failed）是 agent 的主观判断——evidence 只说「交付了什么」，不说「算不算兑现」。两者是不同产物，不互相替代。

### 6.2 PlanningRetrospectData 结构

```typescript
interface PlanningRetrospectData extends RetrospectData {
  // 兼做验收：回答「下层组合起来兑现了我的规划吗」
  deliveryVerdict: "delivered" | "partial" | "failed";
  childUnitIdsEvidence: { childId: string; status: "closed" | "aborted"; closeoutEvidenceSummary?: string }[];
  // 每个 split 项的兑现情况（split 来自 plan，对照 designReviewJudgment 的 sufficiency）
  splitFulfillment: { splitSlug: string; verdict: "delivered" | "partial" | "failed"; note?: string }[];
}
// 注：childUnitIdsEvidence 与 PlanningEvidence.childDelivery 的分工见 §6.1（前者主观验收，后者客观 rollup）。

// 基类 RetrospectData（model §5.8 权威定义，所有层共享；四个数组是结构化对象，不是 string[]）
interface RetrospectData {
  reviewedItems: ReviewedItem[];
  lessonsLearned: string;            // 必填，保留 string
  wrongJudgments?: WrongJudgment[];          // 结构化（指向 designReviewJudgment 哪里判错了）
  badTradeoffs?: BadTradeoff[];              // 结构化（哪些 tradeoff 实际代价过大）
  missedGaps?: MissedGap[];                  // 结构化（design-review 时漏掉的 MECE gaps）
  processIssues?: ProcessIssue[];            // 结构化（流程问题）
}
// 四个数组元素类型（WrongJudgment / BadTradeoff / MissedGap / ProcessIssue）的完整定义见 model §5.8 及本文附录。
```

### 6.3 feature 验收要回答的问题

**验收部分**（PlanningRetrospectData 的三个扩展字段）：

| 字段 | feature 特化的问题 |
|---|---|
| `deliveryVerdict` | 整体：feature spec 兑现了吗？（delivered = 所有 FR 都兑现；partial = 部分 FR 兑现；failed = 主要 FR 未兑现）|
| `childUnitIdsEvidence` | 每个 slice 的最终状态 + closeout 证据（哪些 closed、哪些 aborted、aborted 的有没有影响 spec 兑现）|
| `splitFulfillment` | 每个 split 项（slice）的兑现情况——对照 designReviewJudgment 的 sufficiency，看当初拆的 slice 是不是都交付了 |

**验收重点查 UC**：UC 是 feature 验收时最容易暴露 Gap 的地方——单个 slice 只能验自己负责的 FR/AC，但「UC1 全流程是否顺畅」要等所有 slice 组合起来才能验。retrospect 时 agent 要显式对照每个 UC 走一遍（结论写进 `splitFulfillment.note` 或 `reviewedItems.note`）。

### 6.4 feature 复盘要回答的问题

**复盘部分**（基类 RetrospectData 的字段，对照 designReviewJudgment，model §5.8）：

| 复盘维度 | feature 要回答的问题 |
|---|---|
| **wrongJudgments** | design-review 阶段哪些 spec/slice 判断错了？（标的高风险 FR 实际很容易、判断的 Gap 不存在、认为必要的 FR 实现完发现没用）|
| **badTradeoffs** | 哪些 AC 放宽事后看不值得？哪些 FR 妥协代价超预期？ |
| **missedGaps** | design-review 没发现、slice 开发才暴露的 Gap？为什么 design-review 没发现？ |
| **processIssues** | spec 写得好吗？（漏 AC / FR 太大 / UC 不贴近真实场景）；slice 拆分合理吗？（太碎 / 太大 / 依赖搞错返工）；需求澄清够吗？（开发一半才发现没定清楚）|
| **lessonsLearned**（必填）| 下次写类似 feature 的 spec，最该记住的 1-3 条经验？ |

### 6.5 reviewedItems（逐项回顾记录）

`reviewedItems` 是结构化逐项回顾记录——对 designReviewJudgment 的每一项（necessity / sufficiency / alternatives + 每个 tradeoff id + 每个 risk id），必须有一条 reviewedItems 记录，机器验「覆盖」（不验 verdict 对错）。

```typescript
interface ReviewedItem {
  itemId: string;                    // designReviewJudgment 里某条判断的 id（如 "necessity" / "TR1"）
  outcome: "fulfilled" | "partial" | "unfulfilled";
  note?: string;                     // 失败/部分达成的说明
}
```

### 6.6 机器 gate

- `retrospectData.lessonsLearned` 非空——**没有提炼出经验的 retrospect 是失败的 retrospect**
- `retrospectData.reviewedItems` 覆盖 designReviewJudgment 的每一项（机器验覆盖，不验 verdict 对错）
- `retrospectData.splitFulfillment` 覆盖 `plan.split` 的每一项（每个 split slug 都有一条）

**人审 gate**（机器验不了，诚实承认）：
- `reviewedItems` 的 outcome 和 note 的内容质量
- `deliveryVerdict` / `splitFulfillment.verdict` 是否判断得对

### 6.7 closeout 冻结 evidence（3 件事）

retrospect 通过后进入 closeout，对 `PlanningEvidence` 做以下 3 件事（model §5.11.3）：

1. **agent 补充 evidence 的主观字段**——填 `summary`（交付小结，1-2 句话）+ 确认/补充 `artifacts: ArtifactRef[]`（交付物引用清单，如 spec 最终版路径、关键 retrospect 报告路径）。
2. **cw 校验 artifacts 文件存在性**（drift 检查）——逐条验 `artifacts[].ref` 当前是否还存在（防 plan 里说交付了 `docs/spec.md`，到 closeout 时该文件却被删/改名/没建）。校验失败 → closeout 被拒，agent 必须修正 artifacts 或补回文件。
3. **cw 冻结 evidence + status → closed**——写 `frozenAt`（evidence 从此不再变，`childDelivery` 等客观部分也一并定格），status 从 `retrospected` 推进到 `closed`（不可逆）。

**注意**：evidence 的客观部分（`generatedAt` / `childDelivery`）在 execute 阶段已由 cw 填好（§5.4），并在 retrospect 阶段随 child slice 状态变化更新过——closeout **不重新生成客观部分**，只做「补主观 + 验 drift + 冻结」三件事。evidence 是跨阶段产物（model §5.2 / §5.11），closeout 只是它的终点站，不是它的诞生地。

---

## 7. feature 的 replan（abort + appendOnly，model §5.6）

feature 在 replan 机制中**同时扮演两个角色**（和 slice 对称，和 epic 不同——epic 只发起不承受）：
- **作为发起者**：feature 改自己的 Clarification 或 FeatureSpec（FR/AC/UC），cw 自动级联 abort 受影响的下游 slice
- **作为承受者**：被上游 epic replan 影响（epic 改 Clarification 废弃条目，cw 级联 abort 引用该条目的 feature 及其子孙）

**v5 的 replan 机制严格按 model §5.6**：**abort + appendOnly**（方案 e）。上层 replan 废弃条目后，cw 自动计算下游影响面，把引用了废弃条目的下层（及其所有子孙）**级联 abort**，然后在受影响子孙的 `abandonedRefs` 追加废弃记录，最后返回影响面给 agent，由 agent 决定是否、以及如何通过 `cw create` 重建新的下层。**不存在「下层 replan」「accept-replan」「inheritedItemIds 自动迁移」等机制**。

### 7.1 通用 replan 机制（引用 model，不重复）

replan 的通用流程（4 步：上层本地变更 → cw 计算下游影响面 → cw 级联 abort → 返回给 agent）见 model §5.6，本文不重复。feature 层的 `replan` action 在 `design-reviewed` / `executing` 状态都能调，**不改 status**（旁路 action，原地加变更记录 + cw 自动级联 abort，model §3.3）。

### 7.2 feature 作为发起者（改 spec 触发下游级联 abort）

feature 改 FeatureSpec（废弃/新增某个 FR/AC/UC）走 `cw feature replan`：

```
cw feature replan <featureId> -- "废弃 FR1，新增 FR1a + FR1b 承接拆分"
```

- **本地变更**：废弃的条目 `status=abandoned`，新增的条目 `status=active` 且分配新 id；feature 自己的 status 不变；所有变更 append 到 statusHistory / 条目记录，永不重写（model §5.6 Step 1）
- **可废弃的条目**：feature 自己的 Clarification id / FeatureSpec 里的 FR/AC/UC id
- **不含 Decision id**（Decision 是 Clarification 的投影，跟随 Clarification replan，不独立持有 status，见 §2.5）

cw 自动执行（model §5.6 Step 2-3）：

- **计算下游影响面**：cw 递归遍历 feature 的所有子孙（slice + slice 下的 wave），对比每个子孙的 `basedOnParent` × 上层当前 spec 条目状态。命中规则：子孙.basedOnParent 含已废弃条目 → 该子孙标记受影响。级联规则：父标记受影响 → 所有子孙级联受影响（父废弃，子无意义）
- **级联 abort**：所有受影响的子孙 → `status=aborted`；同时在受影响子孙的 `abandonedRefs` 追加 `{ workUnitItemId, abandonedAt }`；**cw 只改 status，不动 git**（已 closeout 的 wave 的 commit 保留为 git 历史）
- **basedOnParent 永不更新**：cw 不重新计算 basedOnParent 差异、不 append 任何东西到 basedOnParent（basedOnParent 是创建时快照，append-only，详见 §5.2）

cw 返回给 agent（model §5.6 Step 4）：

```
replan result:
  aborted: [受影响的 slice/wave id 列表]      // cw 已自动 abort
  preserved: [未受影响的子孙 id 列表]          // 保留原样继续跑
  pendingRebuild:                             // 提示 agent 哪些上游条目失去了承接下层
    - 如「FR1a / FR1b 没有对应的 slice」
```

### 7.3 feature 作为承受者（被 epic replan 级联 abort）

epic replan 废弃 epic 的 Clarification 时，cw 沿同样的机制处理 feature：

- 对比 feature 的 `basedOnParent` × epic 当前 Clarification 状态
- 若 feature.basedOnParent 含已废弃的 epic Clarification id → feature（及其所有子孙 slice/wave）级联 abort
- 在 feature 的 `abandonedRefs` 追加 `{ workUnitItemId, abandonedAt }`
- **cw 不动 git**（已 closeout 的 wave 的 commit 保留）

feature 被 abort 后，agent 看 cw 返回的 `pendingRebuild` 决定是否重建 feature（场景类似 §7.4 的重建）。

### 7.4 feature → slice 的 replan 场景（最典型，abort + 重建）

> **说明**：model §7.1 已定采用 abort + appendOnly 方案（方案 e）。本节是 feature 层对该机制在最典型场景下的展开描述，不再讨论候选方案，也不待 slice 文档评审——slice/wave 文档直接复用本节的流程。

**场景**：slice 的 `basedOnParent` 声明继承 FR1 + FR2（由 feature.plan.split[i].inheritedItemIds 写入，§5.2）。之后 feature replan 把 FR1 拆成 FR1a + FR1b（FR1 标记 abandoned，FR1a/FR1b 是新增的 active 条目）。

**为什么 feature→slice 是最典型的 replan 触发场景**：feature 的 spec（FR/AC/UC）是下游 slice 主要继承的对象，feature→slice 是 4 层里最频繁的拆分层，spec 变更在这个边界最频繁发生。

#### 7.4.1 cw 自动做的事（确定性计算）

```
触发: cw feature replan <featureId> -- "把 FR1 拆成 FR1a + FR1b"

Step 1 [feature 本地变更]: FR1.status="abandoned"；FR1a/FR1b.status="active"（新 id）
Step 2 [影响面计算]: cw 遍历 feature 所有子孙
  - slice-A.basedOnParent=[FR1, FR2] 命中 FR1 → 受影响
    - slice-A 下所有 wave 级联受影响
  - slice-B.basedOnParent=[FR3] 不命中 → 不受影响
Step 3 [级联 abort]:
  - slice-A.status="aborted"，slice-A 下所有 wave.status="aborted"
  - slice-A 及其 wave 的 abandonedRefs 追加 { workUnitItemId: "FR1", abandonedAt: <ts> }
  - cw 不动 git（slice-A 下已 closeout 的 wave 的 commit 保留）
  - basedOnParent 不更新（append-only，§5.2）
Step 4 [返回给 agent]:
  aborted: [slice-A, slice-A/wave-1, slice-A/wave-2]
  preserved: [slice-B, slice-B/wave-3]
  pendingRebuild:
    - "FR1a 没有对应的 slice"
    - "FR1b 没有对应的 slice"
```

#### 7.4.2 agent 主导的重建（走 `cw create slice`）

agent 看 `pendingRebuild`，决定怎么承接新条目（model §5.6 Step 4 的 `pendingRebuild`）。**重建走 `cw create slice`**（新建 WorkUnit 走正常流程），**不是「slice replan」**——slice 已经被 cw abort 了，重建是在 feature 下新建 slice：

```
agent: "新建 slice-A-v2 承接 FR1a + FR2；新建 slice-C 承接 FR1b"
cw create slice --parent=feature --inheritedItemIds=[FR1a, FR2]
cw create slice --parent=feature --inheritedItemIds=[FR1b]
```

新建的 slice 走自己的 7 步流程（create → clarify → plan → ...），cw 把 `inheritedItemIds` 写入新 slice 的 `basedOnParent`（机制同 §5.2）。

#### 7.4.3 边界场景与说明

- **只删不增**：feature replan 纯删除 FR2（无替代）→ cw abort 引用 FR2 的 slice，agent 核实 cw 的处理，无需重建（FR2 的需求没了就是没了）
- **PlanningUnit（slice）受影响 → 整个废弃重做**：slice 是 PlanningUnit，产物是文档（spec/plan/技术方案），abort 后重建成本低（不需要回滚代码）。这是 abort + appendOnly 方案在 feature→slice 边界特别合适的原因
- **已 closeout 的 wave 被 abort 时**：cw 只标 `status=aborted`，**不动 git**——已交付的代码保留为 git 历史，不删 commit、不 revert。需要跟进新决策时由新 slice 下的新 wave 重做
- **未受影响的 slice 继续跑**：`preserved` 列表里的 slice 不受影响（basedOnParent 不含废弃条目），继续走自己的流程

---

## 8. 未定项（本层相关）

引用 model §7 中本层相关的未定项：

| 项 | 状态 | feature 层的体现 |
|---|---|---|
| **`inheritedItemIds` 的 replan 更新机制** | **已定（model §7.1 采用 abort + appendOnly）** | feature→slice 是最典型触发场景（spec 变更频繁）。本文 §7.4 给出该机制在 feature→slice 场景的完整流程描述（cw 级联 abort + agent 通过 `cw create slice` 重建），与 model §5.6 一致。slice/wave 文档直接复用本流程 |
| **PlanningUnit 的 retrospect 兼验收字段** | **已提案，待确认**（model §7.1）| `PlanningRetrospectData`（deliveryVerdict + childUnitIdsEvidence + splitFulfillment）已在 model §5.8 提案，本文 §6 给出 feature 特化语义。`splitFulfillment` 是否对照所有 split 项（本文提案是「是」），最终需 slice 文档评审定稿 |
| **AC.verification 字段的机器辅助** | **后续迭代**（model §7.3）| verification 字段保持不变（不改名）。消费场景：下游 wave 的 test 阶段如果 `verification=unit` 则 cw 实跑测试，`=manual` 退化为人审。后续可加机器辅助（如 verification=unit 时要求 condition 含可测动词、模糊词 warning），当前 v5 诚实承认全人审 |
| **research 服务** | **后续文档**（model §7.2）| Clarification type=research 时调外部查询，feature clarify 阶段可能触发（如「OAuth 2.0 的 PKCE 流程是什么」查 RFC）|
| **ADR** | **后续文档**（model §7.2）| 重要 feature 级决策（如「所有登录类功能统一用 OAuth」）跨 epic 复用 |
| **claim** | **后续文档**（model §7.2）| 多 agent 并行时，避免两个人同时做同一个 slice |

---

## 附录 A. 完整 TS 接口（feature 层涉及的全部）

集中 model §1.4 / §4 / §5 / §6 里 feature 层涉及的接口，方便实现参考。**feature 层不定义新概念**，所有类型来自 model 文档。

```typescript
// ──────────────────────────────────────────────────────────
// 1. feature 顶层接口（model §1.4）
// ──────────────────────────────────────────────────────────

interface Feature extends PlanningUnit {
  scope: "feature";
  status: PlanningStatus;                              // 8 状态（model §5.4）
  // 身份
  id: string;                                          // 如 "feature:oauth-login"
  slug: string;
  parentUnitId: string;                                // 父 epic id（feature 必有父）

  // replan 追踪
  basedOnParent: string[];                             // 引用 epic 哪些 Clarification id（append-only）
  abandonedRefs: AbandonedRef[];                       // 被上游废弃的引用

  // 主流程产物（按推进顺序）
  objective: string;                                              // create
  clarifications: FeatureClarification;                           // clarify（容器对象，非数组！）
  plan: Plan;                                                     // plan（基类，只 split）
  designReviewJudgment: DesignReviewJudgment;                     // design-review
  executeResult: PlanningExecuteResult;                           // execute（{ childUnitIds }）
  retrospectData: PlanningRetrospectData;                         // retrospect（兼验收）
  evidence: PlanningEvidence;                                     // 跨阶段（execute 生成客观 / retrospect 消费 / closeout 补主观 + 冻结，model §5.11）
}

// ──────────────────────────────────────────────────────────
// 2. PlanningUnit 共享接口（model §1.4）
// ──────────────────────────────────────────────────────────

interface PlanningUnit extends WorkUnit {
  scope: "epic" | "feature" | "slice";
  status: PlanningStatus;                              // 8 状态
  executeResult: PlanningExecuteResult;                // { childUnitIds }
  evidence: PlanningEvidence;                          // 收窄自 Evidence 基类，客观部分含 childDelivery（model §1.4、§5.11）
  // 无 testJudgment / execReviewJudgment（PlanningUnit 的判别特征）
}

type PlanningStatus =
  | "created" | "clarifying" | "planning" | "design-reviewed"
  | "executing" | "retrospected" | "closed" | "aborted";

// ──────────────────────────────────────────────────────────
// 3. feature 的 clarification（容器对象，model §6）—— 核心
// ──────────────────────────────────────────────────────────

interface FeatureClarification {
  clarifications: Clarification[];    // 需求维度的澄清项（机制同其他层）
  spec: FeatureSpec;                  // 规格化条目（扁平字段）
}

interface FeatureSpec {
  // 结构化条目（继承 WorkUnitItem）
  functionalRequirements: FunctionalRequirement[];
  acceptanceCriteria: AcceptanceCriterion[];
  businessCases: BusinessCase[];

  // 投影条目（不继承 WorkUnitItem）
  decisions: Decision[];

  // 规格辅助字段（非 id 化）
  outOfScope: string[];
  goals?: string[];
  complexity?: "low" | "medium" | "high" | "unknown";   // 枚举（model §6，便于跨 feature 统计/排序）

  // md 章节
  background?: string;
  constraints?: string;
}

// ──────────────────────────────────────────────────────────
// 4. FeatureSpec 的条目类型（model §5.7）
// ──────────────────────────────────────────────────────────

// FR —— 继承 WorkUnitItem（独立 replan）
interface FunctionalRequirement extends WorkUnitItem {
  // id / status 继承自 WorkUnitItem（无 replacedBy，model §4.1）
  title: string;       // 「用户能用 GitHub 登录」
  detail: string;      // 详细描述
  ac: string[];        // 强引用 AC id（让 FR-AC 覆盖可机器验）
}

// AC —— 继承 WorkUnitItem（独立 replan）
interface AcceptanceCriterion extends WorkUnitItem {
  // id / status 继承自 WorkUnitItem（无 replacedBy，model §4.1）
  condition: string;                              // 可判定的完成条件
  verification?: "unit" | "manual" | "review";    // 如何验证（model §7.3 保持不变）
}

// UC —— 继承 WorkUnitItem（独立 replan）
interface BusinessCase extends WorkUnitItem {
  // id / status 继承自 WorkUnitItem（无 replacedBy，model §4.1）
  actor: string;
  scenario: string;
  expectedResult: string;
}

// Decision —— 不继承 WorkUnitItem（跟随 Clarification）
interface Decision {
  id: string;                      // 直接用 Clarification 的 id（如 "D3"）
  decision: string;
  rationale: string;
  sourceClarification?: string;    // 投影自哪个 Clarification（id 和它一样）
}

// ──────────────────────────────────────────────────────────
// 5. Clarification（model §5.9，跨层共享）
// ──────────────────────────────────────────────────────────

interface Clarification extends WorkUnitItem {
  // id / status 继承自 WorkUnitItem（无 replacedBy，model §4.1）
  question: string;
  resolution?: string;             // 空 = 还没答（progressive）
  type: "research" | "grilling";
}

// ──────────────────────────────────────────────────────────
// 6. WorkUnitItem 基类（model §4.1）
// ──────────────────────────────────────────────────────────

interface WorkUnitItem {
  id: string;
  status: "active" | "abandoned";
  // 无 replacedBy（v5 删除，cw 不在条目层面维护替代关系，model §4.1、§5.6）
}

// ──────────────────────────────────────────────────────────
// 7. plan 结构（model §4.2、§4.3）—— feature 用 Plan 基类
// ──────────────────────────────────────────────────────────

// feature plan 直接用 Plan 基类（只有 split，model §4.3）
interface Plan {
  split: Split[];
}

interface Split {
  slug: string;
  description: string;
  dependsOn: string[];
  inheritedItemIds?: string[];    // v5 新增：这个子层继承上游的哪些条目 id（写入子层 basedOnParent）
}

// ──────────────────────────────────────────────────────────
// 8. execute 产物（model §2.5）
// ──────────────────────────────────────────────────────────

interface PlanningExecuteResult extends ExecuteResult {
  childUnitIds: string[];          // 下层 slice 的 id 列表
}

interface ExecuteResult {
  // 共享部分（暂无，预留扩展）
}

// ──────────────────────────────────────────────────────────
// 9. designReviewJudgment（model §5.8，跨层共享核心）
// ──────────────────────────────────────────────────────────

interface DesignReviewJudgment {
  necessity: string;
  sufficiency: {
    gaps: string[];                // 漏的
    overlaps: string[];            // 重叠的
    meceNote: string;              // MECE 整体结论
  };
  alternatives: string;
  tradeoffs: Tradeoff[];
  risks: Risk[];
  layerSpecific?: FeatureDesignReviewLayerSpecific;   // feature 层具名 interface（model §5.8 具名化约定，§4.2）
}

interface Tradeoff {
  id: string;                      // 如 "TR1"
  decision: string;
  reason: string;
  cost: string;
}

interface Risk {
  id: string;                      // 如 "R1"
  item: string;
  severity: "low" | "medium" | "high";
  mitigation: string;
}

// feature 的 designReviewJudgment.layerSpecific 具名 interface（§4.2）：
//   6 个字段都是 agent 的人审判断，gate 只验非空，不验内容（model §5.8 诚实原则）。
interface FeatureDesignReviewLayerSpecific {
  specMeceNote: string;            // spec 的 MECE 整体结论
  sliceSplitRationale: string;     // 为什么这么拆 slice
  acVerifiabilityNote: string;     // AC 是否真的可验收
  consistencyNote: string;         // spec 各字段的一致性自检
  frAcCoverageNote: string;        // FR-AC 强引用的合理性自检
  sliceSpecCoverageNote: string;   // inheritedItemIds 是否覆盖了应兑现的 FR/AC
}

// ──────────────────────────────────────────────────────────
// 10. retrospectData（model §5.8，PlanningRetrospectData 兼验收）
// ──────────────────────────────────────────────────────────

interface PlanningRetrospectData extends RetrospectData {
  // 兼做验收：回答「下层组合起来兑现了我的规划吗」
  deliveryVerdict: "delivered" | "partial" | "failed";
  childUnitIdsEvidence: {
    childId: string;
    status: "closed" | "aborted";
    closeoutEvidenceSummary?: string;     // child evidence.summary 的引用（和 model §5.8 字段名一致）
  }[];
  splitFulfillment: {
    splitSlug: string;
    verdict: "delivered" | "partial" | "failed";
    note?: string;
  }[];
}

interface RetrospectData {
  reviewedItems: ReviewedItem[];
  lessonsLearned: string;            // 必填，保留 string（经验提炼天生叙述性，不拆枚举）
  wrongJudgments?: WrongJudgment[];          // 结构化（指向 designReviewJudgment 哪里判错了），model §5.8
  badTradeoffs?: BadTradeoff[];              // 结构化（哪些 tradeoff 实际代价过大），model §5.8
  missedGaps?: MissedGap[];                  // 结构化（design-review 时漏掉的 MECE gaps），model §5.8
  processIssues?: ProcessIssue[];            // 结构化（流程问题），model §5.8
}

interface ReviewedItem {
  itemId: string;                    // designReviewJudgment 里某条判断的 id（裸字段→字段名如 "necessity"；数组元素→元素 id 如 "TR1"，model §5.8 约定）
  outcome: "fulfilled" | "partial" | "unfulfilled";
  note?: string;
}

// 四个结构化数组元素类型（model §5.8 权威定义，此处同步便于实现参考）：

interface WrongJudgment {
  judgmentRef: string;               // 指向 designReviewJudgment 的某条判断 id（裸字段→字段名；数组元素→元素 id）
  whyWrong: string;
  whatActuallyHappened: string;
}

interface BadTradeoff {
  tradeoffRef: string;               // 指向 designReviewJudgment.tradeoffs 的某条 id（如 "TR1"）
  costOverrun: string;               // 实际代价超过预期多少
  note?: string;
}

interface MissedGap {
  where: "clarify" | "plan" | "design-review" | "execute" | "test";  // 在哪一步漏的
  gap: string;
}

interface ProcessIssue {
  type: "clarify" | "plan" | "split" | "replan" | "execute" | "test" | "review" | "other";
  issue: string;
}

// ──────────────────────────────────────────────────────────
// 10b. evidence（跨阶段产物，model §5.11 权威定义）+ statusHistory
// ──────────────────────────────────────────────────────────

// PlanningEvidence（PlanningUnit 共享，feature 用此类型，model §5.11.1）
interface PlanningEvidence extends Evidence {
  // 客观部分（cw 自动填，child closeout 后才完整）
  childDelivery: ChildDeliveryRecord[];   // 每个 split 项对应 child 的交付情况（§5.4）
}

// Evidence 基类（所有层共享，model §5.11.1）
interface Evidence {
  // 客观部分（cw 自动填）
  generatedAt: string;                    // evidence 首次生成时间（execute 时，ISO 8601）
  // 主观部分（agent 在 closeout 时补充）
  summary?: string;                       // 交付小结（1-2 句话，agent 填）
  artifacts: ArtifactRef[];               // 交付物引用清单（agent 确认/补充）
  // 冻结标记（closeout 时填）
  frozenAt?: string;                      // closeout 冻结时间（空=未 closeout，非空=已冻结不再变）
}

// 每个 split 项的 child 交付记录（rollup，model §5.11.1）
interface ChildDeliveryRecord {
  splitSlug: string;                      // 对应 plan.split 的 slug
  childUnitId: string;                    // child WorkUnit id（feature 的 child 是 slice）
  childStatus: "closed" | "aborted";      // child 最终状态（随 child 状态变化更新，closeout 冻结）
  childEvidenceSummary?: string;          // child evidence.summary 的引用（rollup）
}

// 交付物引用（一条 = 一个交付物，model §5.11.1）
interface ArtifactRef {
  kind: "spec" | "plan" | "review-report" | "retrospect-report" | "code" | "test" | "doc" | "other";
  ref: string;                            // 文件路径 / URL / commit hash
  note?: string;
}

// StatusChange（statusHistory 的元素，model §4.4 权威定义）
interface StatusChange {
  from?: PlanningStatus;                  // 原 status（create 时无 from）
  to: PlanningStatus;                     // 新 status
  at: string;                             // ISO 8601 时间戳
  action: string;                         // 触发变更的 action（create/clarify/.../replan/abort）
  note?: string;                          // 可选说明（如 replan 原因）
}
// 注：replan 是旁路 action，不改 status 但 append 一条 StatusChange（from=to=当前 status，action="replan"，model §4.4.1）。
// statusHistory 是 append-only 的「所有变更」流（含旁路），不只是「状态转换」流。

// ──────────────────────────────────────────────────────────
// 11. replan 机制字段（model §5.6）
// ──────────────────────────────────────────────────────────

interface AbandonedRef {
  workUnitItemId: string;            // 被废弃的上游条目 id（如 "FR1" / "D2"，来自 WorkUnitItem.id）
  abandonedAt: string;               // 何时被废弃影响（时间戳）
  // 无 resolvedAt / resolvedAction（v5 删除，cw 在 replan 时已直接 abort，无「待处理→已处理」中间态，model §5.6）
}

// feature 的双向 replan 角色（§7，机制统一为 abort + appendOnly，model §5.6）：
//   - 作为发起者：cw feature replan，改 spec → cw 级联 abort 受影响 slice 及其子孙 → agent 通过 cw create slice 重建
//   - 作为承受者：被 epic replan 级联 abort（basedOnParent 含废弃 epic 条目）→ agent 通过 cw create feature 重建
//
// 旁路 action（两类共享，model §3.3）：replan / abort（无 accept-replan）
```

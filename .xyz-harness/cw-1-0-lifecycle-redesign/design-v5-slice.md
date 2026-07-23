# cw 1.0 设计文档 v5 · slice 层

> 本文是 v5 slice 层的设计。流程/状态机/通用字段见 [design-v5-model.md](./design-v5-model.md)，
> 本文只描述 slice 的差异。本文使用的所有概念以 model 文档词表为准。
>
> **前置阅读**：先读 [design-v5-model.md](./design-v5-model.md)。本文不重复 model 文档已定义的内容（PlanningUnit 7 步流程、8 状态机、WorkUnit/Plan/Split/WorkUnitItem 基类、designReviewJudgment/retrospectData 共享字段结构、replan 通用机制），只在必要处引用。

---

## 0. slice 是什么（类型、职责、粒度）

引用 model §1.2 的对照表本行：

| 维度 | slice |
|---|---|
| **类型** | PlanningUnit（规划型）|
| **含义** | 单 session 可完成的技术实施单元 |
| **execute 做什么** | 启动 wave 层（递归）|
| **写不写代码** | 否 |
| **粒度** | 单 session 可完成（典型 2-4h）|

**slice 在 4 层里的位置**：slice 是 PlanningUnit 的最底层。上游是 feature（需求 spec 层），下游是 wave（ExecutionUnit，唯一写代码的层）。slice 是 PlanningUnit 中**最接近执行**的一层——它的 plan 产物（SlicePlan）是 wave 直接照着施工的「技术施工图」，它的 retrospect 验收最接近真实代码结果。

**slice 的核心职责**：把 feature 的「需求 spec」（FunctionalRequirement / AcceptanceCriterion / BusinessCase）翻译成 wave 能照着施工的「技术方案」（SliceTechChoice / SliceInterface / SliceDataModel / SliceErrorSpec）。feature 管「需求对不对」，slice 管「技术方案合理不合理、能不能落地」——slice 是**纯技术层**，不重写业务目标（那是 feature 的事），只回答技术问题。

**为什么需要这一层**：feature 的 `FR1: 用户能用 GitHub 登录` 只是需求声明，wave 没法直接接手——wave 需要知道 token 交换用哪个库、接口签名长什么样、错误态怎么向上抛、TokenPair 数据结构是什么。如果一个 feature 拆出来的多个 wave 各做各的技术决策，会出现接口对不上、数据模型冲突、错误码不一致。slice 层在 wave 之前统一定技术方案，保证一个 slice 内的技术一致性。

典型 slice 例子（feature = `oauth-login` 的拆分）：
- `oauth-backend`：OAuth 后端接口（token 交换、用户信息拉取、错误处理）
- `oauth-frontend`：OAuth 前端（登录按钮、回调处理、错误展示）
- `oauth-integration`：端到端联调 + UC 验收

---

## 1. slice 的流程

slice 是 PlanningUnit，走 model §2.1 的 **7 步流程**：

```
create → clarify → plan → design-review → execute → retrospect → closeout
 创建     澄清    规划     设计审查         执行      复盘+验收    收尾
```

**slice 没有 test 和 exec-review**——这是 PlanningUnit 的判别特征（model §1.1）。slice 的 execute 产物是 wave 的 id 列表（不是代码），当下层 wave 全部 closeout 后，slice 进入 retrospect——retrospect **兼做两件事**：① 对照 designReviewJudgment 验收「wave 组合起来兑现了我的技术方案吗」② 提炼经验。v5 把 v4 的 test 和 retrospect 合并（职责重叠，model §0.1）。

各步骤在 slice 层的业务内容（不重复 model 步骤定义，只讲 slice 特化）：

| 步骤 | slice 特化内容 |
|---|---|
| **create** | 写 objective（这个 slice 完成后技术上能交付什么）。从父 feature 继承上游条目引用（继承机制见 §4）|
| **clarify** | 澄清**技术细节**（不是业务需求——业务需求是 feature 的事）。典型问题：「token 交换用哪个库」「错误态怎么向上抛」「token 存哪」|
| **plan** | 写技术方案（SliceTechChoice/SliceInterface/SliceDataModel/SliceErrorSpec + Decision）+ 拆 wave（split）。**这是 slice 层最核心的一步**，详见 §2 |
| **design-review** | 执行前审技术方案合理性（维度见 §3）|
| **execute** | 启动 wave 层（executeResult.childUnitIds，详见 §4）；cw 同步初始化 evidence 的客观字段（PlanningEvidence，详见 §4.1）|
| **retrospect** | 兼验收：对照 designReviewJudgment 验收「wave 组合兑现了技术方案吗」+ 提炼经验（PlanningRetrospectData，splitFulfillment 在这里定稿，详见 §5）。**evidence 在此被消费**作为验收输入（详见 §5.1）|
| **closeout** | 补 evidence 主观部分 + cw 校验 artifacts drift + 冻结 evidence（`frozenAt`）→ status `closed`。evidence 的客观部分在 execute 阶段已生成（§4.1）并在 retrospect 阶段随 child wave 状态变化更新，closeout 只补主观 + 验 drift + 冻结，归档不可逆 |

**slice 和 feature 的关键差异**（都是 PlanningUnit，但 plan 内容不同）：

| | feature | slice |
|---|---|---|
| **clarify 维度** | 需求细节（支持哪些登录方式）| **技术细节**（token 交换用哪个库）|
| **plan 内容性质** | 需求规格（做什么）| **技术方案（怎么做）**|
| **plan 产物** | `Plan`（基类，只有 split）| **`SlicePlan extends Plan`**（含 5 个技术方案字段 + split）|
| **拆下层依据** | 拆 slice：按业务/技术边界 | 拆 wave：按 commit/test 边界（见 §2.6）|

---

## 2. slice 的 plan 结构（SlicePlan 核心差异）

这是 slice 文档的重点。slice 的 plan 是 `SlicePlan extends Plan`（model §4.3）：

```typescript
interface SlicePlan extends Plan {
  // 继承自 Plan：split: Split[]（wave 拆分清单，见 §2.6）
  techChoices: SliceTechChoice[];   // 技术选型
  interfaces: SliceInterface[];     // 接口契约
  dataModels: SliceDataModel[];     // 数据模型
  errorSpecs: SliceErrorSpec[];     // 错误规格
  decisions: Decision[];            // 技术决策（投影自本层 Clarification）
}
```

下面逐字段讲结构和填写要求。**命名规则**（model §0.4）：4 个 plan 条目类型带 `Slice` 前缀（`SliceTechChoice` / `SliceInterface` / `SliceDataModel` / `SliceErrorSpec`），避免和 wave 的 `WaveContract`、JS 保留字 `Interface` 冲突；`Decision` 跨层共享不加前缀。

### 2.1 SliceTechChoice（技术选型）

最核心的技术决策记录。每个 SliceTechChoice 记一项选型：选了什么、考虑过什么、为什么选它。

```typescript
interface SliceTechChoice extends WorkUnitItem {
  // 继承自 WorkUnitItem：id（如 "TC1"）/ status
  area: string;            // 技术领域分类，如 "认证库" / "HTTP 客户端" / "状态管理" / "日志"
  choice: string;          // 选定方案，含版本/配置（如 "oauth2-client v3.2" / "pino + stdout transport"）
  alternatives: string[];  // 考虑过但没选的候选（如 ["passport-oauth", "自研"]）
  rationale: string;       // 为什么选这个——必须对比 alternatives 说明，不能只写「好用」
}
```

**填写要求**：
- `alternatives` 至少 1 个候选（空数组 = 「没考虑过别的」= 随便选了一个，design-review 的 `techChoiceRationale` 人审会盯）。如果真的只有一个可行方案（如某个专有 SDK），必须显式说明「无候选，因为 X」（写在 rationale 里）
- `rationale` 必须对比 alternatives——「oauth2-client 文档全、社区活跃，passport-oauth 近一年无维护」是合格的；「oauth2-client 好用」是不合格的
- 一个 slice 通常有 3-8 个 SliceTechChoice（核心库 + 工具库 + 状态管理 + 错误处理框架等）

**注意 `alternatives` 同名异义**：`SliceTechChoice.alternatives`（本字段，`string[]`）是**技术选型的备选候选**（plan 阶段产物，记「这个技术领域考虑过哪些库/方案」）；`designReviewJudgment.alternatives`（model §5.8，`string`）是 **design-review 阶段的方案级备选**（记「整个技术方案有没有别的整体思路」）。两者是不同对象的同名字段，语义不同，不要混淆。

**id 例子**：`TC1` / `TC2` / `TC3`（slice 自己的 plan 项，独立继承 WorkUnitItem，支持 replan）。

### 2.2 SliceInterface（接口契约）

slice 对外或对其他 slice 的承诺，是跨 wave 协调的关键（wave-1 实现 IF1，wave-2 消费 IF1，IF1 契约不稳就反复返工）。SliceInterface 的稳定性比 SliceTechChoice 还重要——TC 选错只影响一个 wave，IF 不稳会影响所有消费它的 wave。

```typescript
interface SliceInterface extends WorkUnitItem {
  // 继承自 WorkUnitItem：id（如 "IF1"）/ status
  name: string;            // 接口标识，如 "exchangeToken" / "POST /api/oauth/token"
  signature: string;       // 函数签名（TS）或 HTTP 路由签名（method + path + 参数）
                           // 如 "(code: string) => Promise<TokenPair>" 或 "POST /api/oauth/token?code=:code"
  contract: string;        // md 自由描述：输入约束 / 返回结构 / 错误码 / 副作用
                           // 是跨 wave 协调的核心，wave-1 和 wave-2 都照着这个施工
}
```

**填写要求**：
- `signature` 必须是可被 wave 直接照抄实现的形式——TS 函数签名或 HTTP 路由签名，不要写自然语言描述（自然语言放 contract）
- `contract` 至少覆盖 4 项：① 输入约束（参数校验规则、取值范围）② 返回结构（引用哪个 SliceDataModel）③ 错误码（引用哪些 SliceErrorSpec）④ 副作用（写日志、发事件、改 DB）
- HTTP 接口必须在 contract 里写清状态码语义（如「200 返回 TokenPair，401 见 ERR1，500 见 ERR2」）

**不设 `consumers` 字段**：跨 wave 的引用关系走 `basedOnParent` 反查（cw 反查子树里 `basedOnParent` 含被废弃 IF id 的 wave，见 §6），不需要 IF 自己维护人肉弱引用数组。人肉维护的 `consumers` 会腐烂且和机器维护的 `basedOnParent` 冗余。

**id 例子**：`IF1` / `IF2`。

### 2.3 SliceDataModel（数据模型）

slice 内的核心类型定义。可以是 TypeScript 类型、SQL DDL、JSON schema、protobuf 等——一个 slice 内通常有多个 DM（请求/响应类型、DB 表结构、领域对象）。

```typescript
interface SliceDataModel extends WorkUnitItem {
  // 继承自 WorkUnitItem：id（如 "DM1"）/ status
  name: string;            // 类型名/表名，如 "TokenPair" / "users 表" / "OAuthProvider"
  format: "typescript" | "sql" | "json-schema" | "protobuf" | "freeform";  // 定义格式
  definition: string;      // 具体定义（按 format 解读），wave 照着实现
  notes?: string;          // 约束/索引/不变量说明（如 "accessToken 全局唯一，建唯一索引"）
}
```

**填写要求**：
- `format` 必须显式声明——cw 渲染 report 时按 format 选语法高亮，wave 也按 format 解析。`freeform` 仅用于无法归类的图/示意图（不推荐）
- `definition` 必须是 wave 能直接照抄实现的形式：
  - `typescript`：完整 TS 类型定义（`interface TokenPair { accessToken: string; ... }`）
  - `sql`：完整 DDL（`CREATE TABLE users (...)`）
  - `json-schema`：标准 JSON Schema 对象的序列化文本
- `notes` 写该 DM 的不变量（uniqueness、nullability、范围约束）——这些往往散落在多个 wave，slice 层统一定避免冲突

**id 例子**：`DM1` / `DM2`。

### 2.4 SliceErrorSpec（错误规格）

slice 的错误处理策略。slice 是统一定错误处理策略的层——如果每个 wave 自己定错误码，一个 slice 内会出现错误码冲突、同类错误不同处理。SliceErrorSpec 把「什么场景 → 怎么处理」提前定死。

```typescript
interface SliceErrorSpec extends WorkUnitItem {
  // 继承自 WorkUnitItem：id（如 "ERR1"）/ status
  interfaceId?: string;    // 关联的 SliceInterface id（接口级错误必填；全局策略如「统一日志格式」可不填）
  scenario: string;        // 错误触发场景，如 "OAuth 提供商返回 invalid_grant" / "DB 连接超时"
  strategy: string;        // 处理策略，如 "返回 401 + 提示重新登录，不重试"
  httpStatus?: number;     // 对外 HTTP 状态码（HTTP 接口必填，程序内调用可空）
  errorCode?: string;      // 业务错误码（如 "AUTH_INVALID_GRANT"，HTTP 接口建议填）
}
```

**填写要求**：
- `interfaceId` 对接口级错误**必填**——让人审能快速找到错误属于哪个接口（design-review 的 `errorCoverage` 维度按 interfaceId 分组校验覆盖）
- `strategy` 必须包含 3 项：① 是否重试（重试几次、退避策略）② 对外返回什么（HTTP 状态码 + errorCode + 给用户的消息）③ 是否记日志/告警（记什么级别）
- HTTP 接口的 SliceErrorSpec 应该 `httpStatus` + `errorCode` 都填，方便 wave 直接实现统一的错误响应结构

**id 例子**：`ERR1` / `ERR2`。

### 2.5 Decision（从 Clarification 投影）

```typescript
interface Decision {
  id: string;                      // 直接用本层 Clarification 的 id（如 "D3"）
  decision: string;
  rationale: string;
  sourceClarification?: string;    // 投影自本层哪个 Clarification（id 和它一样）
}
```

`Decision` **不继承 WorkUnitItem**（model §5.10）——它跟随 Clarification replan，不独立持有 `status`。

**slice 的 Decision 投影自 slice 自己 clarify 产生的 Clarification**（不是从父 feature 继承的 Clarification 或 FR/AC/UC），理由（model §5.10）：
- Decision 是 plan 阶段的产物，只在产生它的那一层有效
- slice clarify 回答的技术问题（如「token 存哪」），答案进 slice 自己的 `clarifications`，同时投影成 slice 的 `decisions` 项
- slice 从 feature 继承的条目 id（存在 `basedOnParent`，是 feature 层的 plan 项 id）是 slice 的**上游约束**，不是 slice 自己 clarify 的产物——slice 的 Decision 不投影它们
- 同一层 Clarification id 和 Decision id 一致（如 slice 的 Clarification D5 对应 Decision D5），不同层之间 id 独立（slice 的 D5 和 feature/wave 的 D5 是不同 WorkUnit 的不同条目，不冲突）

**和 SliceTechChoice 的区别**（容易混淆，必须分清）：
- **Clarification/Decision** 记的是「问了一个问题 → 答案是什么」——是 clarify 阶段的产物投影，关注「为什么决定」
- **SliceTechChoice** 记的是「这个技术领域选了什么」——是 plan 阶段的技术选型记录，关注「选了什么 + 备选 + 对比」
- 一个技术决策可能同时产生 Clarification（如「用 oauth2-client 还是自研」的提问）和 SliceTechChoice（选型记录）——Decision 记「问过、答案是 X」，SliceTechChoice 记「这个领域选了 X，备选是 Y/Z」
- 简单选型（「HTTP 客户端用哪个」）只产生 SliceTechChoice，不一定有对应的 Clarification

**id 例子**：`D3`（直接对齐本层 Clarification 的 id）。

### 2.6 slice 的 plan.split 拆 wave 的依据

`SlicePlan.split` 继承自 Plan 基类（model §4.2）：

```typescript
interface Split {
  slug: string;
  description: string;
  dependsOn: string[];
  inheritedItemIds?: string[];    // 这个 wave 继承 slice 的哪些条目 id（execute 时写入 wave.basedOnParent）
}
```

**拆 wave 的判据**（不给死规则，给判据 + 典型维度）：

判据（必须同时满足）：
1. **单次提交可完成**：一个 wave 的所有改动一次 commit 能做完（典型 30min-2h，承接 slice 的单 session 软锚点，model §1.2）
2. **有明确测试边界**：wave 有自己的 testCases（wave plan 写测试，是 wave 的核心约束），能独立判定 wave 做完没

**不按文件拆**——按文件拆会把一个接口的实现（.ts）和它的测试（.test.ts）拆到两个 wave，反而增加协调成本。**按 commit 拆**也不准确——commit 只是结果，不是拆分依据。正确的表述是：**按「单次提交可完成且有独立测试边界的行为单元」拆**，这通常对应一次 commit，但拆分依据是行为单元本身。

典型拆分维度（按 slice 特点选，不强制）：
- **按 TDD 节奏**：红（写失败测试）→ 绿（最小实现）→ 重构（3 个 wave）
- **按功能子模块**：接口骨架 / 错误处理 / 提供商集成（每个子模块一个 wave）
- **按交付优先级**：核心路径先行 / 边界情况后行（便于早期 demo）

**inheritedItemIds 的填写**（v5 新机制，model §4.2）：每个 Split 项显式声明「这个 wave 负责 slice 的哪些条目 id」——Clarification id（slice 自己 clarify 产生的）+ TC/IF/DM/ERR id（slice plan 项）。**不含 Decision id**——Decision 是决策记录不是施工依赖，跟随 Clarification replan，wave 不需引用（对齐 feature 不让 slice 继承 Decision 的做法）。

**inheritedItemIds 的典型填法**：
- 接口骨架 wave：`["IF1", "DM1", "DM2", "Q1"]`（实现 IF1 接口、定义 DM1/DM2 类型、用了 Clarification Q1 的答案）
- 错误处理 wave：`["IF1", "ERR1", "ERR2"]`（消费 IF1、实现 ERR1/ERR2）
- 注意：同一个条目 id 可以被多个 wave 继承（IF1 被 wave-1 实现并被 wave-2 消费）——`inheritedItemIds` 表达的是「这个 wave 和这些条目相关」，不是独占关系

**典型 wave 拆分例子**（slice = `oauth-backend`）：

| wave slug | 描述 | 依赖 | inheritedItemIds |
|---|---|---|---|
| `exchange-token-skeleton` | exchangeToken 接口骨架 + 类型定义 + 单测 | — | `["IF1", "DM1", "Q1"]` |
| `error-handling` | invalid_grant 等错误态处理 + 单测 | `exchange-token-skeleton` | `["IF1", "ERR1", "ERR2"]` |
| `provider-integration` | 接入 GitHub/Google 真实 OAuth 提供商 + 集成测 | `exchange-token-skeleton` | `["IF1", "TC1", "DM1"]` |

### 2.7 slice 不做 plan 条目间的强引用 gate

feature 层做 FR-AC 强引用 gate（FR 显式声明对应的 AC id），因为 FR-AC 对应关系简单。slice 层**不做**这个 gate，原因：
- **引用关系太复杂**：一个 SliceInterface 可能引用多个 SliceDataModel（IF1 返回值用 DM1+DM2）、被多个 SliceErrorSpec 关联、被多个 wave 消费。反向关系同样复杂
- **机器验不出有意义的约束**：就算加了 IF.dataModelIds 强引用，gate 能验的只是「IF 引用的 DM id 存在」这种弱约束——验不了「IF 的返回值真的匹配 DM 的结构」「ERR 真的覆盖了 IF 的所有错误态」。后者需要语义理解，机器判不了
- **YAGNI**：slice 技术方案的遗漏模式不同（更多是「接口契约写漏了字段」「错误态没覆盖」），靠 agent 自审 + design-review 的 `interfaceContractNote` / `errorCoverage` 人审判断更合适

**诚实补充**：有一种低级的机器可验校验被 v5 故意放弃——**id 存在性校验**（如 SliceErrorSpec.interfaceId 引用了 IF5，但 `SlicePlan.interfaces` 里没有 IF5）。这种拼写错误级别的检查机器能做、成本极低。v5 选择不做的原因：跨项引用主要散落在自由文本（contract / notes）里，机器解析自由文本抽 id 既不准又费事，收益有限。这是明确的取舍，不是「机器完全验不了」。

---

## 3. slice 的 designReviewJudgment.layerSpecific

slice 的 design-review 阶段，在 model §5.8 共享字段（necessity / sufficiency / alternatives / tradeoffs / risks）之外，layerSpecific 关心 6 个 slice 专属维度。**所有 layerSpecific 字段都是 agent 的人审判断，gate 只验非空，不验内容**（技术方案质量机器判不准）。

```typescript
// slice 的 designReviewJudgment.layerSpecific（KV，都是人审判断，gate 只验非空）
interface SliceDesignReviewLayerSpecific {
  techChoiceRationale: string;     // 每个 SliceTechChoice 的选型理由是否充分（有没有「随便选了一个」的）
  interfaceContractNote: string;   // 接口契约设计是否合理（输入/输出/错误码/副作用是否定义清楚）
  dataModelSoundness: string;      // 数据模型合理性（有无冲突、归一化级别、不变量是否完整）
  errorCoverage: string;           // 错误覆盖完整性（每个 IF 的错误路径都有 ERR 吗）
  testabilityNote: string;         // 技术方案是否可测（依赖注入是否够、mock 点是否留了、外部依赖是否可隔离）
  crossWaveContractNote: string;   // 跨 wave 的接口契约是否对得上（wave-1 产出的数据 wave-2 能消费吗）
}
```

| layerSpecific 字段 | slice design-review 要回答的问题 |
|---|---|
| `techChoiceRationale` | 每个 SliceTechChoice 的 alternatives 和 rationale 是否充分？有没有「随便选了一个」的（alternatives 空数组、rationale 只写「好用」）？关键选型（核心库）是否经过对比？ |
| `interfaceContractNote` | SliceInterface 的契约是否定义清楚？signature 是否可被 wave 直接实现？contract 是否覆盖了输入约束/返回结构/错误码/副作用四项？HTTP 接口是否写清状态码语义？ |
| `dataModelSoundness` | SliceDataModel 之间有无冲突（同名字段不同类型）？归一化级别合理吗？不变量（唯一性、范围、nullability）是否完整？format 选择是否恰当？ |
| `errorCoverage` | 每个 SliceInterface 的错误路径都有对应的 SliceErrorSpec 吗（按 interfaceId 分组检查）？同类错误处理策略一致吗（HTTP 接口都有 httpStatus + errorCode 吗）？ |
| `testabilityNote` | 技术方案是否可测——依赖注入是否够、外部依赖（OAuth provider、DB）是否留了 mock 点、时间/随机性是否可注入？ |
| `crossWaveContractNote` | 跨 wave 的接口契约是否对得上？wave-1 实现的 IF1 契约和 wave-2 消费的 IF1 契约一致吗？依赖链 `wave-2 dependsOn wave-1` 是否合理（wave-1 真的产出了 wave-2 需要的东西）？ |

**和 feature design-review 的对比**：feature 的 layerSpecific 关心「功能完整性 / AC 可测性」（业务层），slice 的 layerSpecific 关心「技术可行性 / 接口契约 / 数据模型合理性」（技术层）。slice 的设计审查是**最后一道方案防线**——过了这关就进 execute（wave 真的写代码），方案问题到 wave 才发现成本极高（已经写了代码要返工）。

**机器 gate**（验结构不验内容）：
- **结构完整性**：`techChoices` 至少 1 条 SliceTechChoice（`tech-choice-non-empty`，技术方案的核心）/ `split` 非空（`split-non-empty`）/ split 依赖无环（`split-dag-valid`）
- **业务判断非空**：designReviewJudgment.necessity 非空 / sufficiency 三项（gaps/overlaps/meceNote）填齐 / alternatives 非空 / tradeoffs 至少 1 条（或显式声明「无」+ 理由）/ risks 至少 1 条（或显式声明「无」+ 理由）
- **layerSpecific 非空**：6 个 slice 专属字段都填（机器只验非空，内容质量人审）

**slice risks 的判据二分**（design-review 的 risks 字段如何区分 slice vs wave 的责任）：
- **协同判据**：风险触发或缓解需要多个 wave 协同动作 → 归 slice；单个 wave 自己能应对 → 归 wave
- **接口契约二分**：契约的**设计风险**（签名是否合理、错误态是否完整）→ 归 slice；契约的**实现风险**（wave 能否正确实现签名、mock 是否够）→ 归 wave
- **边界模糊时优先归 slice**（slice 是上层，兜底）

**注意**：单 wave 内部的技术细节风险（如「这个算法的时间复杂度」）不在 slice design-review 评估——那是 wave 自己 design-review 的事。

---

## 4. slice 的 execute（启动 wave / childUnitIds）

slice 的 execute = 启动 wave 层（PlanningUnit 的递归，model §1.1）：

```typescript
// slice 的 executeResult 类型（PlanningExecuteResult，model §2.5）
interface PlanningExecuteResult extends ExecuteResult {
  childUnitIds: string[];          // 下层 wave 的 id 列表
}
```

**execute 时 cw 做什么**：
1. 根据 `SlicePlan.split` 拆分清单，为每个 Split 项创建一个 wave 实例
   - 每个 wave 的 `parentUnitId` 指向这个 slice
   - 每个 wave 的 `basedOnParent` 由 cw 按 `Split.inheritedItemIds` 写入（v5 新机制，model §4.2）——cw 把该 Split 项声明的条目 id（Clarification id + TC/IF/DM/ERR id，不含 Decision id）写入对应 wave 的 `basedOnParent`
2. 每个 wave 开始走自己的 9 步流程（ExecutionUnit，wave 的 execute = dev 写代码——递归出口）
3. slice 进入 `executing` 状态，**等所有 wave 走完全部步骤并 closeout**

**这是对 v4 的 basedOnParent 继承机制的重新设计**（model §4.2）：v4 是「cw 自动全量拷贝上游所有条目 id 到下游 basedOnParent，下游 plan 时再减少」——会污染下游（下游不用的 id 也被记下来）。v5 改为「plan 阶段显式声明继承关系（inheritedItemIds），execute 时按声明写入」。slice 是这个机制的最大受益者——slice 的 plan 条目多（TC/IF/DM/ERR/Clarification），全量拷贝会让 wave 的 basedOnParent 塞满无关 id，影响 replan 影响面反查的准确性。

**wave 怎么持有 slice 技术方案**：wave 不快照整个技术方案，只记 `basedOnParent`（引用了 slice plan 的哪些条目）。如果 slice 改了技术方案（变更/撤销某个 TC/IF/DM/ERR），走统一 replan（§6）——cw 反查子树里 `basedOnParent` 含被废弃条目 id 的 wave，在它们的 `abandonedRefs` 追加记录，强制处理。

**状态**：`executing`（长状态，可能跨多个 session——slice 的 2-4h 单 session 软锚点指的是「人做完技术方案 + 拆 wave」的时间，不含 wave 实际施工时间，wave 施工跨 session 是常态）。

### 4.1 execute 完成时初始化 PlanningEvidence（客观部分）

slice 的 `evidence` 是 **`PlanningEvidence`**（model §5.11，跨阶段产物，**不是 closeout 独占**）。execute 启动 wave 后，cw 立即初始化 evidence 的**客观字段**：

- `generatedAt`：evidence 首次生成时间（ISO 8601）
- `childDelivery: ChildDeliveryRecord[]` 的**初始快照**——每个 `plan.split` 项对应一条记录：
  - `splitSlug`：split 的 slug
  - `childUnitId`：cw 刚创建的 wave id
  - `childStatus`：wave 此刻刚 created，还未到 `"closed" | "aborted"` 任一终态——该字段在初始快照里暂记为 wave 当前 status 的映射（实现侧可用 nullable / 中间值表达「未到终态」），**等 wave 进入终态（closed 或 aborted）时才更新为对应的终态值**（model §5.11.1 的 `childStatus: "closed" | "aborted"` 指的是 child 最终状态，rollup 在 child 到终态后才完整）
  - `childEvidenceSummary?`：留空（wave 还没有自己的 evidence.summary，等 wave closeout 后 rollup 上来）

**childDelivery 是「初始快照」，会随 child wave 状态变化更新**（直到 closeout 冻结才定格）：

- wave 状态推进（如 `created → ... → tested → ... → closed`）时，cw 更新对应 `childDelivery[].childStatus`
- wave closeout 冻结自己的 evidence 后，cw 把 wave 的 `evidence.summary` rollup 到对应 `childDelivery[].childEvidenceSummary`
- wave 被 abort（slice replan 触发级联 abort，§6）时，对应 `childDelivery[].childStatus` 更新为 `"aborted"`

**slice 特殊点**：slice 是 PlanningUnit 的最底层，验收对象最接近执行。slice 的 `evidence.childDelivery` 对照的是 wave（ExecutionUnit），而 wave 的 evidence 是 **`WaveEvidence`**（含 `commitHash` + `testRunResult`，model §5.11.1）。slice 可以在 retrospect 时 **rollup** 下层 wave 的交付情况（如「3 个 wave 都 closed，1 个 aborted」）——child wave 的客观交付（commit + 测试结果）是 slice 验收「技术方案真的落地了吗」最直接的依据。

**evidence 此时只填客观部分**——主观部分（`summary` + `artifacts`）和冻结（`frozenAt`）留到 closeout（§5.6）。详见 model §5.11 / §5.11.3。

---

## 5. slice 的验收（retrospect 兼验收，splitFulfillment 定稿）

slice 的 retrospect 阶段产物类型是 `PlanningRetrospectData`（model §5.8），retrospect **兼做两件事**：① 对照 designReviewJudgment 验收「wave 组合起来兑现了我的技术方案吗」② 提炼经验。

```typescript
interface PlanningRetrospectData extends RetrospectData {
  // 兼做验收：回答「下层 wave 组合起来兑现了我的技术方案吗」
  deliveryVerdict: "delivered" | "partial" | "failed";
  childUnitIdsEvidence: { childId: string; status: "closed" | "aborted"; closeoutEvidenceSummary?: string }[];
  // 每个 split 项（wave）的兑现情况——在 slice 文档定稿（model §7.1）
  splitFulfillment: { splitSlug: string; verdict: "delivered" | "partial" | "failed"; note?: string }[];
}
// 注：childUnitIdsEvidence 与 PlanningEvidence.childDelivery 的分工见 §5.1（前者主观验收，后者客观 rollup）。

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

### 5.1 验收的输入：三者对照（evidence 消费）

PlanningUnit 的 retrospect 兼验收——slice 是 PlanningUnit 的最底层，验收对象最接近执行。agent 在验收时**同时看三样东西**，缺一不可：

| 输入 | 来自 | 回答的问题 |
|---|---|---|
| ① **clarification + plan**（`SlicePlan`：TC/IF/DM/ERR + `plan.split`）| clarify / plan 阶段 | **要做什么**：slice 定了哪些技术方案、拆了哪些 wave |
| ② **designReviewJudgment**（含 `SliceDesignReviewLayerSpecific`，§3）| design-review 阶段 | **期望什么 / 方案对不对**：当初认为技术方案是否可落地、跨 wave 接口契约是否对得上、错误覆盖是否完整 |
| ③ **PlanningEvidence**（`childDelivery`，§4.1）| execute 阶段 cw 自动填 + retrospect 前 rollup | **实际做了什么**：每个 split 对应的 child wave 交付了吗、最终 status 是 closed 还是 aborted、child wave 的 commit + 测试结果（rollup 自 WaveEvidence）|

**三者对照才能验收「下层组合兑现了我的规划吗」**——只看 ① + ② 是「纸上验收」（方案对，但不知道实际交付没），只看 ③ 是「盲目验收」（交付了，但不知道该不该交付这些）。必须三者放在一起：①② 是期望，③ 是实际，对照才知道兑现度。slice 的特殊性在于 ③ 最接近真实代码结果——child wave 的 commitHash + testRunResult 是「技术方案真的落地了吗」最硬的证据。

**evidence 绑定 plan**：`PlanningEvidence.childDelivery` 的每条记录按 `splitSlug` 对照 `plan.split`——每个 split 项有没有对应的 child、child 最终交付了没。这给 `splitFulfillment`（§5.2）提供客观依据。

**evidence 绑定 judgment**：`PlanningRetrospectData.deliveryVerdict`（§5.3）引用 evidence 的客观交付情况作判断依据——`childDelivery` 里多少 wave closed / aborted、aborted 的 wave 影响了哪些 split，直接影响 `deliveryVerdict` 取 `delivered` / `partial` / `failed`。

**evidence 和 PlanningRetrospectData 的分工**（不互相替代，model §5.8）：

| 产物 | 定位 | 谁填 | 性质 |
|---|---|---|---|
| `PlanningEvidence.childDelivery` | **客观交付记录**（rollup）| cw 自动填 | 事实（wave 最终 status + child evidence summary 引用 + wave 的 commit/test 结果）|
| `PlanningRetrospectData.deliveryVerdict` / `childUnitIdsEvidence` / `splitFulfillment` | **主观验收结论** | agent 在 retrospect 时填 | 判断（基于客观记录 + agent 对技术方案兑现度的主观评估）|

agent 填 `childUnitIdsEvidence` / `splitFulfillment` 时**引用** `PlanningEvidence.childDelivery` 提供的客观数据（如「wave-2 最终 aborted，evidence 显示 commitHash 在但 ERR1 没实现」），但结论（delivered/partial/failed）是 agent 的主观判断——evidence 只说「交付了什么」，不说「算不算兑现」。两者是不同产物，不互相替代。

### 5.2 splitFulfillment 在 slice 定稿（model §7.1 未定项）

model §7.1 留了一个未定项：「splitFulfillment 是否对照所有 split 项，还是只对照部分，在 slice 文档评审时定稿」。slice 是 PlanningUnit 的最底层，最接近执行，在这里定稿最合适。

**本文档的定稿方案**：

> **slice 的 splitFulfillment 必须覆盖 `SlicePlan.split` 的所有项**——每个 split（对应一个 wave）必须有一条 splitFulfillment 记录，机器 gate `split-fulfillment-covers-plan` 验覆盖（不验 verdict 对错）。

**理由**：
- slice 的 split 项和 wave 一一对应（每个 Split 创建一个 wave），是最具体的验收单元
- slice 已经是最底层 PlanningUnit，没有「再往下细化」的空间——必须逐 wave 给 verdict
- 上游 feature/epic 的 splitFulfillment 可以更粗（一个 slice 由多个 wave 组成，feature 的 split 项兑现可聚合 slice 的 verdict），slice 不行
- 这是诚实承认 slice 最接近执行：每个 wave 都跑了、每个 wave 都有结果，必须逐个判

**splitFulfillment.verdict 的填法**：
- `delivered`：wave closeout 且兑现了 split.description 声明的内容
- `partial`：wave closeout 但部分未兑现（如错误处理只做了一半）——必须在 note 写清缺什么
- `failed`：wave aborted，或 closeout 但核心目标未达成——必须在 note 写清原因

**deliveryVerdict 的聚合规则**（建议，非强制）：
- 所有 splitFulfillment 都是 `delivered` → `deliveryVerdict = "delivered"`
- 有 `failed` → `deliveryVerdict = "failed"`
- 有 `partial` 但无 `failed` → `deliveryVerdict = "partial"`

### 5.3 reviewedItems 对照 designReviewJudgment

`RetrospectData.reviewedItems` 逐项回顾 designReviewJudgment 的每条判断（model §5.8）。slice 的 reviewedItems 重点对照：

| designReviewJudgment 项 | slice retrospect 要回答 |
|---|---|
| necessity（这个 slice 对 feature 的贡献）| 贡献真的兑现了吗？feature 的相关 FR/AC 是否真的因为这个 slice 满足了？ |
| sufficiency（技术方案覆盖完整 + wave 拆分覆盖）| 当初判断的 Gap 真的漏了吗？wave 开发时暴露了新 Gap 吗？技术方案覆盖完整吗？ |
| alternatives（没选的库/方案）| 事后看当初没选的那个，其实应该选吗？ |
| 每个 tradeoff（如「选成熟库放弃性能」）| 代价真的付出了吗？符合预期吗？ |
| 每个 risk（跨 wave 协调风险 / 技术方案风险）| 实际表现如何？接口契约对得上吗？依赖链延误了吗？选型踩坑了吗？ |

每个 reviewedItem 的 outcome ∈ `fulfilled` / `partial` / `unfulfilled`，失败的项必须在 note 写说明。

### 5.4 技术方案兑现的额外对照

除 model §5.8 共享字段外，slice 作为最接近执行的 PlanningUnit，建议在 `processIssues` 或 `missedGaps` 里额外对照技术方案的实际兑现（机器不强制，agent 自觉）：
- **SliceInterface 兑现**：每个 IF 真的跑通了吗？跨 wave 的 IF 消费对得上吗？
- **SliceDataModel 落地**：每个 DM 真的被代码采用了吗？有没有 DM 定义了但没用上的？
- **SliceErrorSpec 覆盖**：每个 ERR 真的实现了吗？有没有同类错误 wave 自己又造了一套？
- **SliceTechChoice 落地**：每个 TC 真的被用了吗？有没有选了但实际换了的？

这些是 slice 特有的复盘内容（feature/epic 不关心接口/数据模型，wave 只关心自己的部分），帮助下次写技术方案时避免重蹈覆辙。

### 5.5 机器 gate

- `all-waves-closed`：所有 child wave status === closed 或 aborted
- `lessons-learned-non-empty`：retrospectData.lessonsLearned 非空（**没有提炼出经验的 retrospect 是失败的 retrospect**）
- `reviewedItems-covers-designReview`：reviewedItems 覆盖 designReviewJudgment 的每一项（necessity/sufficiency/alternatives + 每个 tradeoff id + 每个 risk id）
- `split-fulfillment-covers-plan`：splitFulfillment 覆盖 SlicePlan.split 的所有项（**本文档定稿的 slice 专属 gate**，见 §5.2）

**人审 gate**（机器验不了，诚实承认）：reviewedItems 的 outcome 是否判断得对、note 质量深不深、deliveryVerdict 是否合理——机器只验「填了」「覆盖了」，验不了「判断得对不对」。

### 5.6 closeout 冻结 evidence（3 件事）

retrospect 通过后进入 closeout，对 `PlanningEvidence` 做以下 3 件事（model §5.11.3）：

1. **agent 补充 evidence 的主观字段**——填 `summary`（交付小结，1-2 句话）+ 确认/补充 `artifacts: ArtifactRef[]`（交付物引用清单，如技术方案最终版路径、关键 wave 的 commit hash、retrospect 报告路径）。
2. **cw 校验 artifacts 文件存在性**（drift 检查）——逐条验 `artifacts[].ref` 当前是否还存在（防 plan 里说交付了 `src/oauth/token.ts`，到 closeout 时该文件却被删/改名/没建）。校验失败 → closeout 被拒，agent 必须修正 artifacts 或补回文件。
3. **cw 冻结 evidence + status → closed**——写 `frozenAt`（evidence 从此不再变，`childDelivery` 等客观部分也一并定格），status 从 `retrospected` 推进到 `closed`（不可逆）。

**注意**：evidence 的客观部分（`generatedAt` / `childDelivery`）在 execute 阶段已由 cw 填好（§4.1），并在 retrospect 阶段随 child wave 状态变化更新过——closeout **不重新生成客观部分**，只做「补主观 + 验 drift + 冻结」三件事。evidence 是跨阶段产物（model §5.2 / §5.11），closeout 只是它的终点站，不是它的诞生地。

---

## 6. slice 的 replan

slice 的 replan 机制**完全遵循 model §5.6 的 abort + appendOnly 策略**（上层 replan 废弃条目 → cw 自动计算影响面 → 级联 abort 受影响子孙 → 返回 agent → agent 通过 `cw create` 重建），本文档只讲 slice 在这个机制里扮演的两个角色。

### 6.1 slice 作为发起者（replan 自己的技术方案）

slice 在 `design-reviewed` / `executing` 状态都可能要改技术方案（wave 开发中发现选型不靠谱、接口契约定错了）。走统一旁路 action `cw slice replan`（model §3.3）：

```
cw slice replan <sliceId> -- "废弃/新增的条目描述"
  --abandon-items TC1 IF2          // 废弃的条目 id（TC/IF/DM/ERR/Clarification）
  --add-items <新条目 json>         // 可选：新增的条目
```

cw 按 model §5.6.2 的 4 步执行：

1. **本地变更**（slice 层内）：
   - `abandon-items` 指向的条目 → `status="abandoned"`
   - `add-items` 的新条目 → `status="active"`，id 新分配
   - slice 自身 status 不变（replan 是旁路 action）
   - 所有变更 append 到条目记录，永不重写

2. **影响面计算**（cw 自动）：递归遍历 slice 的所有 wave，对比每个 wave 的 `basedOnParent` × slice 当前条目状态。命中规则：`wave.basedOnParent` 含已废弃条目 → wave 标记受影响。级联规则：wave 标记受影响 → wave 的所有子孙 wave 同样受影响（model §5.6.2）。

3. **级联 abort**（cw 自动）：所有受影响的 wave → `status="aborted"`，同时在它们的 `abandonedRefs` 追加 `{workUnitItemId, abandonedAt}`。cw 只标 status，**不动 git**——已 closeout 的 wave 的 `commitHash` 保留为历史记录（代码还在仓库里，只是这个 wave 被标记废弃了，参考 model §3.3）。

4. **返回给 agent**：cw 返回 `{ aborted, preserved, pendingRebuild }`（model §5.6.2 Step 4）——`aborted` 是已被 cw abort 的 wave，`preserved` 是未受影响的 wave，`pendingRebuild` 提示「哪些被废弃条目失去了承接 wave」。

**agent 的重建动作**（model §5.6.3，agent 主导，**不是 slice replan**）：agent 看 `pendingRebuild` 决定怎么重建，走 **`cw create wave`** 新建 wave 承接新版本的技术方案：

```
agent: "新建 wave exchange-token-v2 承接新的 IF1v2"
cw create wave --parent=<sliceId> --inheritedItemIds=[IF1v2, DM1, TC2]
```

新建的 wave 走正常 9 步流程（create → clarify → ...），不是 replan。

**Decision 不进 abandon-items**：Decision 不继承 WorkUnitItem（model §5.10），跟随 Clarification replan——废弃对应的 Clarification（如 `Q3`）即可，Decision（`D3`）自动跟随。

**已 closeout 的 wave 也被 abort**（这是 v5 相对 v4 的关键差异）：slice replan 废弃某条目时，引用该条目的 wave 一律被 abort，**不区分 wave 是否已 closeout**——已 closeout 的 wave 同样 `status="aborted"`，但 cw 不动 git（commit 保留为历史）。这是诚实承认「基于废弃前提的交付失去意义」，即使代码已经写完了。agent 看 `pendingRebuild` 决定是否重建（已交付的功能真要保留就新建 wave 重做参考实现）。

### 6.2 slice 作为承受者（被上游 feature replan）

slice 不是顶层（epic 才是），可能被上游 feature replan 影响——feature 废弃 FR/AC/UC 后，cw 检测到 slice 的 `basedOnParent` 命中废弃条目，**slice 被直接级联 abort**（连同它的所有 wave）。

流程（model §5.6.2）：

1. feature replan 废弃 FR1（`status="abandoned"`）+ 新增 FR1a/FR1b
2. cw 递归遍历 feature 所有子孙，命中规则：`slice.basedOnParent` 含 FR1 → slice 标记受影响
3. 级联 abort：slice → `status="aborted"` + `abandonedRefs` 追加 `{workUnitItemId: "FR1", abandonedAt}`；slice 的所有 wave 同样被 abort（基于废弃 slice 的 wave 失去意义）
4. cw 返回 feature 的 `pendingRebuild`（含「FR1a/FR1b 没有对应的 slice」）

**slice 不需要做任何动作解锁**——cw 直接 abort，没有「待 agent 确认」的中间态（model §5.6.4 已否决「等下层自行决定」类机制）。slice 被废弃就是被废弃，由 agent 决定是否通过 **`cw create slice`** 新建承接新 FR/AC 的 slice（见 §6.3）。

### 6.3 slice 的重建（agent 通过 `cw create slice`）

slice 被 abort 后（无论是 §6.1 的发起者场景还是 §6.2 的承受者场景），承接新上游条目的重建都走 **`cw create slice`**，不是 slice replan。

**典型重建场景**（feature replan 把 FR1 拆成 FR1a + FR1b，旧 slice-s1 因 `basedOnParent` 含 FR1 被 abort）：

```
agent 看待 feature replan 返回的 pendingRebuild:
  "FR1a 没有对应的 slice"
  "FR1b 没有对应的 slice"

agent 决定重建:
  cw create slice --parent=feature:oauth-login \
                  --inheritedItemIds=[FR1a, AC1, UC1]    // 新 slice 承接 FR1a
  cw create slice --parent=feature:oauth-login \
                  --inheritedItemIds=[FR1b]              // 另一个 slice 承接 FR1b
```

新建的 slice 走正常 7 步流程（create → clarify → plan → ...），从零做技术方案、拆 wave。旧 slice-s1 保留在 `statusHistory` 里作为 append-only 的历史记录（`basedOnParent` / `abandonedRefs` 不动），cw 的 status / report 能追溯「s1 何时、因为 FR1 被废弃而 aborted」。

**为什么不是 slice 自己 replan 改 inheritedItemIds**（model §5.6.4 否决其他方案的理由汇总）：
- **语义判断 cw 做不了**：FR1 被拆成 FR1a+FR1b 时，FR1a/FR1b 该归哪个 slice、要不要合并到现有 slice、旧 slice 的技术方案还适不适用——这些都是 agent 的语义决策，cw 不能自动迁移 inheritedItemIds
- **appendOnly 纪律**：slice 的 `basedOnParent` 是创建时历史快照，永不重写（model §4.2）。原地改 inheritedItemIds 会破坏 appendOnly
- **不引入新状态**：v5 不为「待重新规划」引入新状态/中间态（违反词表纪律，详见 model §5.6.4）。旧 slice 直接 abort，新 slice 走正常 create，状态机干净

**旧 slice 的技术方案能复用吗**：appendOnly 保留全部历史，agent 新建 slice 时可以参考旧 slice 的 SlicePlan（`cw show slice-s1` 可读），但新 slice 是独立 WorkUnit，不复用旧 id、不继承旧 status。这是诚实承认「重建」≠「原地续命」。

---

## 7. 未定项（本层相关）

引用 model §7 中和 slice 相关的未定项：

| 项 | model 位置 | slice 文档的处理 |
|---|---|---|
| **splitFulfillment 的对照范围** | §7.1 | **本文档已定稿**：slice 的 splitFulfillment 必须覆盖 SlicePlan.split 的所有项（§5.2）。理由：slice 是最底层 PlanningUnit，split 项和 wave 一一对应，必须逐个判 |
| **inheritedItemIds 的 replan 更新机制** | §7.1 | **已定**（model §7.1 已定 v5 采用 abort + appendOnly 方案）：slice 场景下不更新 inheritedItemIds，旧 slice 直接 abort，agent 通过 `cw create slice` 重建承接新上游条目的 slice（§6.3）|
| **execReviewJudgment 的字段结构** | §7.1 | 和 slice 无关——execReviewJudgment 是 ExecutionUnit（wave）专属，slice 没有 |
| **research 服务**（Clarification type=research） | §7.2 | 后续文档。slice 是 research 的重度用户（技术选型查官方文档、查 API 限流等大量靠 research）|
| **claim**（多 agent 并行互斥） | §7.2 | 后续文档。slice 拆多个 wave 后可能并行施工，claim 机制防冲突 |
| **ADR**（重要决策跨 epic 复用） | §7.2 | 后续文档。slice 的重要技术决策（如「所有 token 交换统一用 oauth2-client」）可升级为 ADR 跨 slice 复用 |
| **wave 测试套件发现机制** | §7.3 | 沿用现有 cw 能力，不在 slice 文档设计。slice 只在 retrospect 间接消费 wave 的测试结果 |

---

## 附录 A. 完整 TS 接口（slice 层涉及的全部）

```typescript
// ============================================================================
// 基础类型（继承自 model 文档，slice 层不重复定义，这里集中展示以便实现参考）
// ============================================================================

// WorkUnitItem（model §4.1）：所有支持 replan 追踪的条目共享此结构
interface WorkUnitItem {
  id: string;
  status: "active" | "abandoned";
}

// Plan 基类（model §4.2）
interface Plan {
  split: Split[];
}

// Split（model §4.2，跨层共享，不加层前缀）
interface Split {
  slug: string;
  description: string;
  dependsOn: string[];
  inheritedItemIds?: string[];    // 这个子层继承上游的哪些条目 id（写入子层的 basedOnParent）
}

// Clarification（model §5.9，跨层共享）
interface Clarification extends WorkUnitItem {
  question: string;
  resolution?: string;            // 空 = 还没答
  type: "research" | "grilling";
}

// Decision（model §5.10，跨层共享，不继承 WorkUnitItem）
interface Decision {
  id: string;                      // 直接用本层 Clarification 的 id（如 "D3"）
  decision: string;
  rationale: string;
  sourceClarification?: string;    // 投影自本层哪个 Clarification（id 和它一样）
}

// AbandonedRef（model §5.6）：纯历史记录，cw 在级联 abort 时自动追加，不阻塞流程
interface AbandonedRef {
  workUnitItemId: string;          // 被废弃的上游条目 id（如 "TC1" / "FR1"）
  abandonedAt: string;             // 何时被废弃影响（时间戳）
  // 无 resolvedAt / resolvedAction（v5 删除，cw 在 replan 时已直接 abort，无「待处理→已处理」中间态，model §5.6）
}

// ============================================================================
// slice 顶层接口（model §1.4）
// ============================================================================

interface Slice extends PlanningUnit {
  scope: "slice";
  status: PlanningStatus;                              // 8 状态（model §5.4）
  // 身份
  id: string;                                          // 如 "slice:oauth-backend"
  slug: string;
  parentUnitId: string;                                // 父 feature id（slice 必有父）

  // replan 追踪
  basedOnParent: string[];                             // 引用 feature 哪些 Clarification / FR/AC/UC id（append-only）
  abandonedRefs: AbandonedRef[];                       // 被上游废弃的引用

  // 主流程产物（按推进顺序）
  objective: string;                                              // create
  clarifications: Clarification[];                                // clarify（数组，非容器对象）
  plan: SlicePlan;                                                // plan（SlicePlan extends Plan，含 5 个技术方案字段）
  designReviewJudgment: DesignReviewJudgment;                     // design-review
  executeResult: PlanningExecuteResult;                           // execute（{ childUnitIds }）
  retrospectData: PlanningRetrospectData;                         // retrospect（兼验收）
  evidence: PlanningEvidence;                                     // 跨阶段（execute 生成客观 / retrospect 消费 / closeout 补主观 + 冻结，model §5.11）
}

// PlanningUnit 共享接口（model §1.4）
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

// ============================================================================
// slice 层专属类型
// ============================================================================

// SlicePlan（model §4.3）：继承 Plan，扩展 5 个技术方案字段
interface SlicePlan extends Plan {
  // 继承自 Plan：split: Split[]（wave 拆分清单）
  techChoices: SliceTechChoice[];
  interfaces: SliceInterface[];
  dataModels: SliceDataModel[];
  errorSpecs: SliceErrorSpec[];
  decisions: Decision[];            // 投影自本层 Clarification
}

// 技术选型——最核心的技术决策记录
interface SliceTechChoice extends WorkUnitItem {
  // 继承自 WorkUnitItem：id（如 "TC1"）/ status
  area: string;            // 技术领域分类，如 "认证库" / "HTTP 客户端"
  choice: string;          // 选定方案，含版本/配置（如 "oauth2-client v3.2"）
  alternatives: string[];  // 考虑过但没选的候选（至少 1 个）
  rationale: string;       // 为什么选这个——必须对比 alternatives 说明
}

// 接口契约——slice 对外 / 对其他 slice 的承诺
interface SliceInterface extends WorkUnitItem {
  // 继承自 WorkUnitItem：id（如 "IF1"）/ status
  name: string;            // 接口标识，如 "exchangeToken" / "POST /api/oauth/token"
  signature: string;       // 函数签名（TS）或 HTTP 路由签名
  contract: string;        // md：输入约束 / 返回结构 / 错误码 / 副作用
}

// 数据模型——核心类型定义
interface SliceDataModel extends WorkUnitItem {
  // 继承自 WorkUnitItem：id（如 "DM1"）/ status
  name: string;            // 类型名/表名，如 "TokenPair" / "users 表"
  format: "typescript" | "sql" | "json-schema" | "protobuf" | "freeform";
  definition: string;      // 具体定义（按 format 解读）
  notes?: string;          // 约束/索引/不变量说明
}

// 错误规格——错误处理策略
interface SliceErrorSpec extends WorkUnitItem {
  // 继承自 WorkUnitItem：id（如 "ERR1"）/ status
  interfaceId?: string;    // 关联的 SliceInterface id（接口级错误必填）
  scenario: string;        // 错误触发场景
  strategy: string;        // 处理策略（重试/返回/日志）
  httpStatus?: number;     // 对外 HTTP 状态码（HTTP 接口必填）
  errorCode?: string;      // 业务错误码（如 "AUTH_INVALID_GRANT"）
}

// ============================================================================
// designReviewJudgment（model §5.8，跨层共享核心）
// ============================================================================

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
  layerSpecific?: SliceDesignReviewLayerSpecific;   // slice 层具名 interface（model §5.8 具名化约定，§3）
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

// slice 的 designReviewJudgment.layerSpecific 具名 interface（§3）：
//   6 个字段都是 agent 的人审判断，gate 只验非空，不验内容（model §5.8 诚实原则）。
//   值类型全为 string，符合 model §5.8 layerSpecific 约定的下界（`Record<string, string>`）。
interface SliceDesignReviewLayerSpecific {
  techChoiceRationale: string;
  interfaceContractNote: string;
  dataModelSoundness: string;
  errorCoverage: string;
  testabilityNote: string;
  crossWaveContractNote: string;
}

// ============================================================================
// slice 的 executeResult（model §2.5，PlanningExecuteResult）
// ============================================================================
interface PlanningExecuteResult extends ExecuteResult {
  childUnitIds: string[];          // 下层 wave 的 id 列表
}

interface ExecuteResult {
  // 共享部分（暂无，预留扩展）
}

// ============================================================================
// slice 的 retrospectData（model §5.8，PlanningRetrospectData 兼验收）
// ============================================================================

interface PlanningRetrospectData extends RetrospectData {
  // 兼做验收：回答「下层 wave 组合起来兑现了我的技术方案吗」
  deliveryVerdict: "delivered" | "partial" | "failed";
  childUnitIdsEvidence: {
    childId: string;
    status: "closed" | "aborted";
    closeoutEvidenceSummary?: string;     // child evidence.summary 的引用（和 model §5.8 字段名一致）
  }[];
  // slice 定稿（§5.2）：必须覆盖 SlicePlan.split 的所有项
  splitFulfillment: {
    splitSlug: string;
    verdict: "delivered" | "partial" | "failed";
    note?: string;
  }[];
}
// 注：childUnitIdsEvidence 与 PlanningEvidence.childDelivery 的分工见 §5.1（前者主观验收，后者客观 rollup）。

// 基类 RetrospectData（model §5.8 权威定义，所有层共享；四个数组是结构化对象，不是 string[]）
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

// ============================================================================
// evidence（跨阶段产物，model §5.11 权威定义）+ statusHistory
// ============================================================================

// PlanningEvidence（PlanningUnit 共享，slice 用此类型，model §5.11.1）
interface PlanningEvidence extends Evidence {
  // 客观部分（cw 自动填，child closeout 后才完整）
  childDelivery: ChildDeliveryRecord[];   // 每个 split 项对应 child 的交付情况（§4.1）
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
  childUnitId: string;                    // child WorkUnit id（slice 的 child 是 wave）
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

// ============================================================================
// slice 的机器 gate 清单（汇总，验结构不验内容）
// ============================================================================
const SLICE_DESIGN_REVIEW_GATES = [
  // 结构完整性
  "tech-choice-non-empty",           // SlicePlan.techChoices 至少 1 条
  "split-non-empty",                 // SlicePlan.split 至少 1 项
  "split-dag-valid",                 // wave 依赖关系无循环
  // 业务判断非空（验「agent 有没有填」，不验内容对错）
  "design-review-necessity-non-empty",
  "design-review-sufficiency-complete",   // gaps/overlaps/meceNote 三项都填
  "design-review-alternatives-non-empty",
  "design-review-tradeoffs-present",      // 至少 1 条或显式声明「无」+ 理由
  "design-review-risks-present",          // 至少 1 条或显式声明「无」+ 理由
  // layerSpecific 非空（slice 专属 6 字段）
  "layer-specific-non-empty",             // 6 个字段都填
];

const SLICE_RETROSPECT_GATES = [
  "all-waves-closed",                // 所有 child wave status === closed 或 aborted
  "lessons-learned-non-empty",
  "reviewed-items-cover-design-review",   // reviewedItems 覆盖 designReviewJudgment 每一项
  // 本文 §5.2 定稿：slice 专属 gate
  "split-fulfillment-covers-plan",        // splitFulfillment 覆盖 SlicePlan.split 所有项
];
```

# cw 1.0 设计文档 v4 · wave 层

> 本文档只讲 wave 一层。流程结构与 epic / feature / slice **完全相同**（同样的 8 步、同样的状态机、同样的命令约定），差异只在每步的具体内容——wave 的 plan **写测试代码**（TestCase 集合，TDD 起点），verify 审查测试覆盖，execute = **dev 写实现代码**（递归出口），test **跑测试**（机器验证，整个 cw 唯一真正的机器 gate）。
>
> **顶层概念体系**（和 epic / feature / slice 一致）：使用者的认知模型只有两个维度——**4 个层**（epic / feature / slice / wave）× **8 个步骤**（create / clarify / plan / verify / execute / test / retrospect / closeout）。每一步在每一层都有一个**同名产物**，需要区分时加层前缀（如 `wavePlan`）。`Clarification`（wave 的）/ `TestCase` 都是 wave plan 的**内部字段**，不作为顶层概念暴露。
>
> **前置阅读**：先读 [design-v4-guide.md](./design-v4-guide.md) → [design-v4-epic.md](./design-v4-epic.md) → [design-v4-feature.md](./design-v4-feature.md) → [design-v4-slice.md](./design-v4-slice.md) → 本文档。本文档不重复前 3 层已讲透的内容（4 层总览 / 8 步来源 / execute 递归 / replan 机制 / abandonedRefs / basedOnParent / §8.0 命令约定 / TechSection 体系），只在必要处引用。
>
> **和 epic / feature / slice 机制严格同构**：机制层面（replan、abandonedRefs、reviewedItems、basedOnParent、verifyJudgment / testJudgment / retrospectData）完全一致，差异只在 plan 的内容（wave 是 testCases，不拆下一层）、execute 的含义（wave = dev 写代码，递归出口）、test 的含义（wave = 跑测试，机器验证）、verify / test / retrospect 的 layerSpecific 字段（偏测试覆盖维度）。学一层，会四层。
>
> **wave 是协调型和执行型的分水岭落地**：guide §3.2「execute 是分水岭」、epic §9「execute 递归」讲的机制在 wave 层兑现——前 3 层的 execute 都是「启动下一层」（递归），只有 wave 的 execute 是「dev 写代码」（递归出口）。

---

## 1. 一分钟理解 wave 层

wave 是**一个单次提交可完成的执行单元**，是 slice 拆出来的叶子节点，是整个 cw **唯一真正写代码的层**。

```
slice 「oauth-backend」                 ← slice 层产物：技术方案（TC/IF/DM/ERR）
  └─ wave 「exchange-token-skeleton」   ← 本文讲这一层
       ├─ clarify: 这个 wave 的实现细节要定清楚，必须先回答什么？（边界条件、mock 策略）
       ├─ plan:    写测试代码（testCases，TDD 起点）
       ├─ verify:  审查测试覆盖（覆盖全吗、边界条件想到了没）
       ├─ execute: dev 写实现代码（递归出口，不启动下一层）
       ├─ test:    跑测试（机器验证，cw 实跑验全 pass，不信任 agent 声明）
       └─ ...
```

**wave 和 slice 的相同点**（都是 scope，走 8 步流程）：
- 流程结构完全一样（create → clarify → plan → verify → execute → test → retrospect → closeout）
- 9 状态 / 9+2 action 完全一样
- 机制层面（replan / abandonedRefs / basedOnParent / reviewedItems）完全同构

**wave 和前 3 层的本质不同**（前 3 层都是协调型，wave 是执行型）：

| | epic / feature / slice（协调型）| **wave（执行型）** |
|---|---|---|
| **execute 做什么** | 启动下一层（递归）| **dev 写代码**（递归出口）|
| **plan 产物** | 各层方案 + split（拆下一层）| **`wavePlan.testCases`**（测试代码，TDD 起点）|
| **是否拆下一层** | 是（有 childUnitIds）| **否（叶子，无 childUnitIds）** |
| **test 做什么** | 子层全完成后整体验证（人审对照 verifyJudgment）| **跑测试（机器验证）** |
| **test 是不是机器 gate** | 否（只验引用一致，不验业务正确性）| **是（cw 实跑测试验全 pass）** |
| **是否写代码** | 否（代码在 wave）| **是（唯一写代码的层）** |
| **replan 角色** | 发起者（slice）/ 双向（feature / slice）| **纯承受者**（叶子，无下游可标）|
| **粒度** | epic 跨多 session / feature 单特性 / slice 单 session | **单次提交可完成（典型 30 分钟 - 2 小时）** |

**一句话**：wave 是整个 cw **唯一真正写代码的层**，plan 先写测试（TDD 红），execute 写实现让测试过（TDD 绿），test 跑测试做机器验证（cw 实跑验全 pass，不信任 agent 声明）。

---

## 2. 为什么需要 wave 层

slice 层只产出「技术方案」（techPlan：TC/IF/DM/ERR），粒度是技术选型和接口契约，还停在「怎么设计」层面，没到「怎么实现」。中间缺一层把技术方案落地成可验证的代码：

- slice 的 `IF1: exchangeToken(code) => Promise<TokenPair>`——但 wave 要知道**这个接口的实现按什么测试用例驱动、边界条件（空 code / 过期 code / 网络超时）怎么覆盖、mock OAuth 提供商用什么策略**
- slice 的 `ERR1: invalid_grant → 返回 401`——但 wave 要知道**这个错误态的具体测试怎么写、用什么输入触发、预期输出（status code / body）怎么精确化**

这些「实现细节 + 测试驱动」就是 wave 的 testCases 要回答的问题。wave 层的存在意义：**把 slice 的技术方案，翻译成测试驱动的可执行实现**。

为什么是 wave 这一层而不是 slice 自己写代码：一个 slice 通常拆成多个 wave（按 TDD 节奏或功能子模块），如果 slice 直接写代码，粒度太粗、一个 slice 的代码量可能跨多次提交、测试边界模糊。wave 层把 slice 拆成「单次提交可完成」的执行单元，每个 wave 有独立的 testCases（测试边界清楚），能单独判定做完没（跑测试通过）。

**wave 和 slice 的分工**：slice 管「技术方案合理不合理」（选型靠不谱、接口契约能不能落地、跨 wave 对得上），wave 管「实现 + 测试对不对」（测试覆盖全不全、边界条件想到了没、实现真的让测试过没）。两者不混淆——wave 是纯执行层，不重写技术方案（那是 slice 的事），只照 slice 的 techPlan 施工 + 写测试驱动实现。

---

## 3. wave 是什么

wave 是**一个单次提交可完成的执行单元**，由 slice 拆分产生，是 cw 的叶子节点（不再拆下一层）。

典型 wave 例子（slice = `oauth-backend` 的拆分，承接 slice 文档 §4.3 的 waveSplit）：
- `exchange-token-skeleton`：exchangeToken 接口骨架 + 类型定义 + 单测（TDD 红→绿）
- `error-handling`：invalid_grant 等错误态处理 + 单测
- `provider-integration`：接入 GitHub / Google 真实 OAuth 提供商 + 集成测

wave 的核心特征：
- **单次提交可完成**：一个 wave 的所有代码改动（测试 + 实现）一次 commit 能做完（典型 30 分钟 - 2 小时）。**单次提交是软锚点**，承接 slice 的单 session 软锚点，不是硬性卡死的规则
- **TDD 节奏**：wave 的 plan 先写测试（红），execute 写实现让测试过（绿）。这是 wave 层的核心约束——**先有测试再有实现**
- **有独立测试边界**：每个 wave 有自己的 testCases（plan 阶段写），能独立判定 wave 做完没（test 阶段跑测试通过）
- **执行型写代码**：wave 的 execute = dev 写代码（递归出口，不启动下一层）。wave 是整个 cw **唯一真正产出代码的层**
- **纯承受者**：wave 是叶子（无 childUnitIds），不发起 replan（没下游可标），只能被上游 slice replan 标记

---

## 4. wave 的完整流程（8 步详解）

> 流程结构和 epic / feature / slice 完全一样（create → clarify → plan → verify → execute → test → retrospect → closeout）。下面每步只讲 **wave 特有的内容**，通用规则见 epic 文档 §5、feature 文档 §4、slice 文档 §4。

### 4.1 第 1 步：create（创建）

**做什么**：建一个 wave 实例，写下 **objective**（这个 wave 完成后能交付什么可验证的代码，1-2 句话），并从父 slice 继承 Clarification + TC/IF/DM/ERR 引用。

**objective 例子**（wave = `exchange-token-skeleton`）：
> 实现 exchangeToken 接口骨架（`POST /api/oauth/token`），接收 authorization code 返回 TokenPair，含类型定义 + 单元测试覆盖正常路径。

**继承机制**（和 feature / slice 同构，wave **不含 TD**）：
- wave 的 `parentUnitId` 指向父 slice
- cw 把父 slice 当前的 `clarifications` 的 id（slice 自己 clarify 产生的）+ slice techPlan 里的 TC/IF/DM/ERR id（**不含 TD**——TechDecision 是 Clarification 的 techPlan 层投影，跟随 Clarification replan，不独立持有 status/replacedBy，继承会制造无法作废的引用；详见 [guide §6.2 跨层规则](./design-v4-guide.md#62-replan-做什么4-步) + slice §4.5）**全量拷贝**到 wave.`basedOnParent`（wave plan 时可以减少——只留自己真正负责的）
- **统一存在 `wave.basedOnParent`**，不区分 Clarification 引用和 techPlan 项引用两套字段（v4 统一语义，见 epic §7.3）
- 这些继承来的引用是 wave testCases 的初始约束（wave 写 testCases 时不能违反 slice 的接口契约 / 数据模型定义）

> **TODO（继承机制，同 epic §7.3 / feature §4.1 / slice §4.1）**：basedOnParent 的「全量拷贝再减少」继承机制是临时语义，待重新设计（见 reviewer epic C3），本文档描述的是当前临时机制。

**状态**：`created` → 进入 `clarifying`

**命令**：
```bash
cw wave create exchange-token-skeleton \
  --from-slice slice:oauth-backend \
  --objective "实现 exchangeToken 接口骨架..."
```

### 4.2 第 2 步：clarify（澄清实现细节）

**做什么**：识别这个 wave 的实现要定清楚，必须先回答的问题（**Clarification**——clarify 阶段的产物，跨层同构），逐个给答案。机制和字段同 epic §5.2 / §7.2，不再重复。

wave 的 clarify 典型问题（**实现维度**，不是技术维度——技术选型是 slice 的事，wave 只澄清实现细节）：
- 「边界条件有哪些？」→「空 code / 过期 code / 网络超时 / OAuth 提供商返回非预期结构」
- 「mock 策略？」→「OAuth 提供商用 nock 录制响应，不真打网络；Redis 用 ioredis-mock」
- 「这个函数的异常分支怎么测？」→「每个异常分支独立 TestCase，expected 精确到 error code + message」
- 「测试用真实 git 子进程还是 mock？」→「单元测试 mock，集成测试用真实 git」

**research vs grilling**（同 epic / feature / slice）：
- `research`：查外部资料能答的（如「nock 的 latest 版本 API 怎么用」「GitHub OAuth 错误码完整列表」）
- `grilling`：必须人回答的实现决策（如「这个边界条件要不要现在覆盖，还是留到下个 wave」）

**和 slice clarify 的区别**：slice 澄清的是**技术细节**（用哪个库、错误态怎么抛），wave 澄清的是**实现细节**（边界条件有哪些、mock 怎么打、测试怎么驱动）。wave clarify 的产物会被 plan 阶段写进 testCases：**TestCase 的 `scenario` 字段是 clarify 的直接投影**（边界条件 / 异常分支来自 clarify 的澄清），不需要额外造一个类型（clarify 产物就是 Clarification，plan 时投影成 testCases 的 scenario / 边界条件说明，机制同 slice 的 TechDecision 投影 Clarification）。

**状态**：`clarifying`

**命令**：
```bash
cw wave clarify wave:exchange-token-skeleton      # progressive，可多次调用
# 输入数据从 stdin 读：{ clarifications: [...] }
```

### 4.3 第 3 步：plan（写测试代码，TDD 起点）

**做什么**：基于 clarify 的 Clarification + 继承的 slice techPlan，**写测试代码**（TestCase 集合）。这是 wave 层最核心的一步，也是 **TDD 的起点**——先写测试（红），execute 阶段写实现让测试过（绿）。

**wave 的唯一 plan 产物**：

#### wavePlan.testCases（TestCase 集合，TDD 起点）

testCases 是 wave 留给 execute 的「测试驱动契约」。和 slice 的 techPlan（技术方案）/ feature 的 spec（需求规格）/ epic 的 featureSplit（拆分清单）对应，wave 的 plan 产物是 testCases（测试代码）。一个典型的 wave testCases 包含：

| TestCase（例子 wave = `exchange-token-skeleton`）| type | 验证什么 |
|---|---|---|
| `TC1: 正常 code → 返回 TokenPair` | unit | 核心路径：合法 code 调用 OAuth 提供商成功，返回 TokenPair 结构 |
| `TC2: 空 code → 抛 INVALID_CODE` | unit | 边界条件：空输入校验 |
| `TC3: 过期 code → 抛 INVALID_GRANT` | unit | 边界条件：OAuth 提供商返回 invalid_grant 的处理（承接 slice ERR1）|
| `TC4: 网络超时 → 抛 PROVIDER_TIMEOUT` | unit | 边界条件：网络异常处理 |
| `TC5: TokenPair 结构符合 DM1` | unit | 数据模型契约：返回值结构匹配 slice DM1 定义 |

**TestCase 不做 TestCase 间的强引用 gate**（详见 §5.2）——wave 的 TestCase 都是「一个被测场景」的同构结构（不像 slice 的 TechSection 有 TC/IF/DM/ERR 四种异构类型），更不需要判别联合，机器 gate 验不出有意义的跨 TestCase 约束，靠 agent 自审（`testCaseCoverageNote` 人审判断）。

**关于 split**：wave **不拆下一层**（wave 是叶子，没 childUnitIds）。所以 wave plan 没有 split 产物（slice 的 waveSplit / feature 的 sliceSplit / epic 的 featureSplit 在 wave 不存在）。这是 wave plan 和前 3 层 plan 的本质差异——前 3 层 plan 都含 split（拆到下一层），wave plan 只有 testCases。

**关于 complexity / goals / background**：feature / slice 有的主观标注、业务目标、背景说明，wave **都不用**——wave 是执行层，背景在 slice / feature / epic 已讲，业务目标是 feature 层的事，主观复杂度评级辅助拆分决策（slice 拆 wave），wave 不再拆。wave 保持 testCases 纯测试驱动，不和前层的方案 / 需求混淆。

**产出**：`wavePlan`（`testCases`）

**状态**：`planning`（progressive，可多次调用，testCases 可多次写）

**命令**：
```bash
cw wave plan wave:exchange-token-skeleton           # progressive，可多次调用
# 输入数据从 stdin 读：
# {
#   testCases: TestCase[]    # 测试代码（存入 wavePlan.testCases）
# }
```

> **wave plan 的状态特化（重要）**：wave 的 plan 允许在 `verified` 状态也能调（详见 §6 状态机说明）。这是 wave 对 slice plan 状态约束（from = clarifying / planning）的**唯一特化点**——因为 wave 是叶子，改 testCases 不影响下游（没 childUnitIds），没有影响面传播，不是 replan 语义。前 3 层 verified 后要改 plan 项走 replan（标下游），wave 没下游可标，所以走 plan progressive 直接改 testCases（详见 §4.9 wave 特有的改 testCases 机制）。不含 executing 是为避免状态机死锁（详见 §4.9）。

### 4.4 第 4 步：verify（测试覆盖审查）

**做什么**：在 dev 写实现代码**之前**，对 plan 阶段的 testCases 做**结构化的测试覆盖判断**。机制同 epic / feature / slice verify（见 [epic 文档 §5.4](./design-v4-epic.md#54-第-4-步verify审查规划)）——cw 定义存储结构 + guidance 提示 + 结构校验，**业务判断内容由 agent 产出**。

这一步是 TDD 的关键节点：测试本身写得好不好，决定了后续实现的质量。verify 强迫 agent（或人）认真想清楚测试覆盖全不全、边界条件想到了没。

**guidance 提示 agent 回答的问题**（wave 特化版）：

| 维度 | wave 要回答的问题 |
|---|---|
| **必要性（necessity）** | 这个 wave 对父 slice techPlan 的贡献是什么？没它 slice 能交付吗？testCases 驱动的实现是 slice 的哪部分？ |
| **充分性（sufficiency，MECE）** | testCases 加起来覆盖了 slice 负责的所有 IF / DM / ERR 吗？正常路径覆盖了吗？边界条件（空输入 / 超长 / 非法格式）覆盖了吗？异常分支覆盖了吗？有遗漏的测试场景吗？有重复的 TestCase 吗？|
| **替代方案（alternatives）** | testCases 有没有过度测试（同一个分支测了三遍）？有没有更高效的覆盖策略（参数化测试 / property-based）？type 选择合理吗（该 integration 的用 unit）？|
| **权衡与妥协（tradeoffs）** | 哪些 TestCase 是妥协（如「网络超时不测了留下个 wave」「这个边界条件 mock 太复杂先跳过」）？每个妥协的代价？（留下未测分支的风险）|
| **风险（risks）** | 实现层面的风险（这个 wave 的实现难点、最容易写错的地方、mock 够不够）+ 测试本身的风险（mock 和真实行为不一致 / expected 写错导致假绿 / 外部依赖在 CI 不稳定）。**注意：slice 层面的风险（跨 wave 协调、接口契约设计）不在 wave verify 评估**——那是 slice verify 的事（见 slice 文档）。wave verify 只管「这个 wave 的实现 + 测试本身的风险」，不评估上下游协调（那是上层的事） |

wave 专属判断填入 `verifyJudgment.layerSpecific`（KV），典型字段（偏测试覆盖维度）：

| layerSpecific 字段 | 含义 | 校验方式 |
|---|---|---|
| `testCaseCoverageNote` | testCases 对 slice techPlan 的覆盖度自检（IF / DM / ERR 各覆盖了哪些 TestCase）| 人审判断，机器只验非空 |
| `boundaryConditionNote` | 边界条件覆盖自检（空输入 / 超长 / 非法格式 / 边界值 / 并发场景）想到的列出来 | 人审判断，机器只验非空 |
| `mockStrategyNote` | mock 策略合理性自检（mock 了什么、为什么不 mock 真实、mock 会不会失真）| 人审判断，机器只验非空 |
| `tddRedReadinessNote` | testCases 是否真的能在 execute 之前 fail（TDD 红灯）——expected 是否足够精确到能判 fail/pass | 人审判断，机器只验非空 |

> **所有 layerSpecific 字段都是 agent 的人审判断，gate 只验非空，不验内容**。testCases 的覆盖一致性自检（如 testCases 是否覆盖了 IF1 的所有错误态）不作为机器 gate——测试覆盖关系机器判不准（见 §5.2），那是 agent 自检的职责，放进 `testCaseCoverageNote` 让 agent 显式回答。

**机器 gate**（同 epic / feature / slice，验结构不验内容）：
- **结构完整性**：`test-cases-non-empty`（testCases 至少 1 条）/ `test-cases-have-expected`（每个 TestCase 的 `expected` 非空——这是 TDD 红灯的前提，expected 由 agent 自填断言，cw 不重算）
- **业务判断非空**：`verifyJudgment.necessity` 非空、`sufficiency` 三项填齐（gaps / overlaps / meceNote）、`tradeoffs` 至少 1 条（或显式声明「无」+ 理由）、`risks` 至少 1 条（或显式声明「无」+ 理由）

**诚实说明**：同 epic / feature / slice——cw 验「agent 有没有填这些字段」，验不了「testCases 写得好不好、覆盖全不全、expected 精确不精确」。内容质量由 agent（或人审）负责。判断存在 `verifyJudgment` 里，是 test / retrospect 对照的基础。

**通过的含义**：testCases 定稿，TDD 红灯就绪，可以进 execute 让 dev 写实现了。

**状态**：`verified`

**命令**：
```bash
cw wave verify wave:exchange-token-skeleton         # progressive，可多次调用
# 输入数据从 stdin 读：{ verifyJudgment: {...} }
```

### 4.5 第 5 步：execute（dev 写实现代码，递归出口）

**做什么**：这是 wave 层的**核心分水岭兑现点**。前 3 层的 execute 都是「启动下一层」（递归），wave 的 execute = **dev 写实现代码**（递归出口）：

- agent（dev 角色）按 plan 阶段的 testCases（测试代码）写实现代码
- 实现要让所有 testCases 从 fail（TDD 红灯）变成 pass（TDD 绿灯）
- 这是 TDD 的「绿」阶段——testCases 在 plan 已写好（红），execute 写最小实现让测试过

**execute 完成的标志**（wave 特有，前 3 层的 execute 完成标志是「子层全 closeout」，wave 没子层）：

**wave execute 完成的标志是「代码 commit 存在」**——agent 调 `cw wave execute` 时，通过 stdin 传入实现的 commit hash，cw 机器验证该 commit 真实存在并记录到 `wave.commitHash`：

**具体机制（设计层定死，不疑给实现侧）**：

1. agent 在 execute 阶段写完实现代码后，自行 `git add` + `git commit`（cw 不管 git 细节：commit message 怎么写 / 是否 squash / 多少个 commit 都不管）
2. agent 调 `cw wave execute` 时，**通过 stdin 传入 `{ commitHash: "<git-commit-hash>" }`**（多 commit 时由 agent 自己选一个作为 wave 的代表 commit——通常是最后一个 / squashed 后的那个，agent 自负责选对）
3. cw 机器验证：`git cat-file -e <commitHash>` 验该 commit hash 在当前仓库真实存在（不存在则 execute fail，附 mustFix 提示 agent 重传存在的 hash）
4. cw 把 commitHash 记录到 `wave.commitHash` 字段，execute 完成，进 test 阶段

**为什么用 commit 存在性 + agent 传 hash 作为机制**：
- **机器可验**（诚实区分机器 vs 人，guide §3.3）：`git cat-file -e` 是 git 客观事实，cw 能机器验证（不像「代码写完了」这种主观声明）
- **不信任 agent 声明**：agent 不能只说「实现写完了」，必须传一个真实存在的 commit hash，cw 验存在性（防 agent 瞎址一个不存在的 hash）
- **对应 wave 粒度**：wave 的判据是「单次提交可完成」，commit 就是单次提交的物理体现
- **机制简单不依赖 message 约定**：不要求 commit message 含 wave id（那易伪造——agent 改一个标点 commit 一下就能过 gate），直接用 agent 显式传 hash + cw 验存在性

**诚实说明（cw 验不了的）**：cw 验「commit hash 真实存在」，但验不了「这个 commit 的内容真的实现了 testCases」——commit 内容与 testCases 的一致性靠 test 阶段的机器验证（跑测试看 pass/fail，详见 §4.6）。cw 也验不了「agent 传的 hash 是不是真的 wave 的那个 commit」（agent 理论上传一个无关 commit 的 hash 也能过 commit-exists gate），但 test 阶段的 tests-all-pass gate 会扯出来——如果 commit 内容不对，测试会 fail。

**wave 在 execute 阶段做什么**：写实现代码 + commit + 传 commitHash 给 cw。execute 完成后进 test 阶段（跑测试，机器验证）。

**状态**：`executing`

**命令**：
```bash
cw wave execute wave:exchange-token-skeleton        # dev 写实现代码
#   agent 自行 git commit，通过 stdin 传 commitHash 给 cw
#   输入数据从 stdin 读：{ commitHash: "<git-commit-hash>" }
#   cw 验 commit hash 在仓库真实存在（git cat-file -e）后记录到 wave.commitHash
#   execute 完成后进 test（跑测试）
```

### 4.6 第 6 步：test（跑测试，机器验证——整个 cw 唯一真正的机器 gate）

**做什么**：这是 wave 层和前 3 层 test 的**本质区别**，也是整个 cw 设计的核心机制之一。前 3 层的 test 是「子层全完成后整体验证」（人审对照 verifyJudgment），wave 的 test 是**跑测试（机器验证）**——整个 cw 唯一真正机器验证业务正确性的步骤。

#### 机器验证机制（wave test 的灵魂，最核心的设计）

**核心问题**：怎么保证 wave 真的做完了？agent 可能声明「测试都过了」，cw 不能信任这个声明——agent 可能：
- 声明「测试过了」但实际没跑
- 跑了但只跑了部分 testCases
- 跑了但伪造测试结果

**机器验证的机制**（实跑测试，不信任 agent 声明）：

1. **cw 实跑测试**：cw 实际执行 wave 的测试代码（执行 testCases 对应的测试套件），拿到测试运行结果（pass / fail 数量 + 哪些 fail）。**cw 不读 agent 的声明，cw 自己跑**
2. **判 pass/fail**：cw 验所有 testCases 的测试都 pass（fail 数 = 0）。任何 fail 则 test fail
3. **不信任 agent 声明**：agent 不能在 testJudgment 里只说「测试都过了」，cw 自己实跑验证

**为什么 cw 不「重算 expected 对比 actual」**（设计决策，诚实说明）：

早期设计曾考虑「judgeByExpected」机制——cw 从 slice techPlan 契约（IF/DM/ERR）+ TestCase input **重算** expected，对比 actual。**这个机制不成立**，原因：
- slice 的 ERR 的 `scenario` / `strategy` 是自由文本 string（slice §5.2 定义），cw 无法从「OAuth 返回 invalid_grant → 返回 401」这种自由文本语义地推导出结构化 expected（如 `{ status: 401, error: "INVALID_GRANT" }`）
- cw 是 agent-agnostic 工具，不做业务判断（guide §3.3 / §3.7 / 黑名单「让 cw 判断业务对错」）。「从自由文本契约翻译成可执行断言」是语义理解，越界
- expected 由 agent 在 TestCase.expected 字段里自己写（agent 负责断言正确性），cw 只负责「跑测试看 pass/fail」——这才是机器能客观验证的部分

所以 wave test 的机器验证 = **cw 实跑测试 + 验全 pass**，不是「重算 expected 对比」。

**机器验证的能力边界（诚实说明）**：

cw 能机器验证的部分：
- **测试真跑了 + 真全过了**：cw 实际执行测试代码，验 commit 后的代码状态真的让所有 testCases pass（不是 agent 声明的，是 cw 自己跑出的结果）
- **commit 存在**：execute 阶段的实现代码确实 commit 了（机器验 commit hash 在仓库里存在，详见 §4.5）
- **testCases 都被执行**：cw 跑的测试套件覆盖了所有 testCases（机器验测试运行记录）

cw 机器验不了的部分（诚实承认）：
- **expected 写得对不对**：TestCase 的 expected 是 agent 自己写的断言，cw 不重算、不验对错——如果 agent 写了错的 expected 让测试「假绿」，cw 验不出（这是 agent 自审 + verify 阶段 `tddRedReadinessNote` 人审的职责）
- **测试覆盖度**（这个 TestCase 集合够不够）：机器验不了，靠 verify 阶段的 `testCaseCoverageNote` / `boundaryConditionNote` 人审
- **测试代码本身的实现质量**（mock 是否失真、断言是否精确）：机器验不了，靠 verify 阶段的 `tddRedReadinessNote` 人审

**manual 类 TestCase 的退化场景**：当 TestCase.type = `manual`（人工验证类，承接 feature AC 的 `verification=manual`），cw 无法自动跑测试——退化为「cw 验 agent 填了 manual 验收记录 + commit 存在」，诚实承认这是机器验证的边界。这种 TestCase 应在 verify 阶段标记 `tddRedReadinessNote` 说明是 manual，test 阶段不强求机器跑。

**guidance 提示 agent 对照回答**（wave 特化，对照 verifyJudgment）：

| verify 阶段的判断 | wave test 要回答 |
|---|---|
| 当初说的「必要性」（这个 wave 对 slice 的贡献）| testCases 真的验证了这个贡献吗？（如 wave 声称实现 IF1，testCases 真测了 IF1 的契约吗）|
| 当初判断的覆盖 Gap / 重叠 | 这些 Gap 真的漏了吗？实现时暴露了新 Gap 吗？重叠实际发生了吗？|
| 当初考虑但没选的替代覆盖策略（alternatives）| 事后看当初没选的那个策略，其实应该选吗？|
| 当初每个妥协 + 代价（如「网络超时不测了」）| 代价真的付出了吗？（未测分支实际有 bug 吗）|
| 当初标记的测试风险（mock 失真 / 假绿 / CI 不稳定）+ 实现风险 | 实际表现如何？（mock 和真实一致吗、expected 真的没写错吗、实现难点真的踩坑了吗）|

agent 把对照结论填入 `workUnit.testJudgment`，每个字段**必须对应 `verifyJudgment` 的一项**（necessity 对 necessity、sufficiency 对 sufficiency、alternatives 对 alternatives、每个 tradeoff 有对应的 costRealized、每个 risk 有对应的 outcome）。

**机器 gate**（wave test 的机器验证，整个 cw 唯一真正机器验业务正确性的 gate）：
- **结构完整性**：`commit-exists`（execute 阶段的 commit 仍在仓库里，机器验 `git cat-file -e <commitHash>`，详见 §4.5）/ `test-cases-executed`（所有 testCases 都真跑了，机器验测试运行记录）
- **tests-all-pass（核心机器 gate）**：cw 实跑 wave 的测试套件，验所有 testCases 的测试都 pass（fail 数 = 0）。**这是整个 cw 唯一真正机器验证业务正确性的 gate**（前 3 层的 test gate 都是引用一致 / 结构校验，不是业务正确性验证）
- **引用一致性**（诚实区分两类，照抄 epic / feature / slice）：
  - **真引用一致（机器验 id 匹配）**：`testJudgment.tradeoffCostRealized` 里的 `tradeoffRef` 必须覆盖 `verifyJudgment` 每个 Tradeoff.id；`testJudgment.riskOutcome` 里的 `riskRef` 必须覆盖 `verifyJudgment` 每个 Risk.id——不漏验任何一条 tradeoff / risk
  - **只验非空（对应关系靠 agent 自检 + 人审）**：`necessityMet` / `sufficiencyMet` / `alternativesReconsidered` 是 string / 结构体，机器只验「填了」，内容是否真对应 verifyJudgment 靠 agent 自检

**诚实说明**：机器验证是机器验证业务正确性的「最大值」——cw 能验「测试真跑了 + 全 pass + commit 存在」，但验不了「测试覆盖度够不够 / expected 写得对不对」（后者靠 verify 人审）。这是 cw 作为 agent-agnostic 工具的边界：cw 保证 wave 不能「假声明」（cw 自己实跑验 pass，不是 agent 说过了），但不保证 wave「测得全 / 测得对」（覆盖度 + expected 正确性靠 agent 自审）。

**如果没通过**：
- tests-all-pass fail（有测试 fail）→ 回 execute 修实现代码（实现没满足 TestCase 的断言）
- test-cases-executed fail（测试没真跑）→ 回 execute 重跑 + commit
- 业务判断对照 fail（少见，verify 已审过；真发生就走 §4.9 改 testCases 机制）

**状态**：`tested`

**命令**：
```bash
cw wave test wave:exchange-token-skeleton
#   cw 自动跑测试（不需要 agent 手动跑）验全 pass
#   输入数据从 stdin 读：{ testJudgment: {...} }
```

### 4.7 第 7 步：retrospect（复盘）

**做什么**：复盘 wave 层自己的事。**核心动作是对照 verifyJudgment，看哪些测试覆盖判断事后证明错了**（机制同 epic / feature / slice retrospect，见 [epic 文档 §5.7](./design-v4-epic.md#57-第-7-步retrospect复盘)）。

**guidance 提示 agent 回答**（wave 特化）：

| 复盘维度 | wave 要回答的问题 |
|---|---|
| **判断错误（wrongJudgments）** | verify 阶段哪些测试覆盖判断错了？（标的高风险 mock 实际很稳、判断的 Gap 不存在、认为必要的 TestCase 实际冗余）|
| **不良妥协（badTradeoffs）** | 哪些测试妥协事后看不值得？（如「网络超时不测」实际线上爆了、「这个边界 mock 太复杂跳过」实际是高频场景）|
| **遗漏的 Gap（missedGaps）** | verify 没发现、test（机器验证）/ execute 才暴露的测试 Gap？为什么 verify 没发现？|
| **流程问题（processIssues）** | testCases 写得好吗？（expected 不够精确 / 边界条件漏了 / mock 失真）；实现踩坑了吗？（哪个 TestCase 的实现最难写，为什么）；slice techPlan 够清晰吗？（IF / DM / ERR 模糊导致 expected 重算不出）|
| **提炼经验（lessonsLearned）** | 下次写类似 wave 的 testCases，最该记住的 1-3 条经验？ |

agent 把复盘结论填入 `workUnit.retrospectData`。其中 `reviewedItems` 是**结构化逐项回顾记录**——对 verifyJudgment 的每一项（necessity / sufficiency / alternatives + 每个 tradeoff id + 每个 risk id），必须有一条 reviewedItems 记录，机器验「覆盖」（不验 verdict 对错）。`reviewedItems.ref` 是 **`VerifyItemRef` 判别联合**（`{kind:"necessity"}` / `{kind:"sufficiency"}` / `{kind:"alternatives"}` / `{kind:"tradeoff", id}` / `{kind:"risk", id}`，定义见 epic 附录），`retrospect-covers-verify` gate 按 kind 分桶验覆盖。`wrongJudgments` / `badTradeoffs` / `missedGaps` 允许为空（说明判断都对了），但 `lessonsLearned` 必须非空——**没有提炼出经验的 retrospect 是失败的 retrospect**。

**机器 gate**：
- `retrospectData.lessonsLearned` 非空（`lessons-learned-non-empty`）
- `retrospectData.reviewedItems` 覆盖 `verifyJudgment` 的每一项（`retrospect-covers-verify`，机器验）：每个 necessity / sufficiency / alternatives + 每个 Tradeoff.id + 每个 Risk.id 都有一条对应的 reviewedItems 记录

**人审 gate**（机器验不了，诚实承认）：
- `reviewedItems` 的 `verdict`（判断对 / 错）和 `note`（说明）的内容质量——机器只验「每项都有记录」，验不了「回顾得对不对、深不深」

**产出**：retrospect 记录（结构化经验沉淀，跨 wave 复用）

**状态**：`retrospected`

**命令**：
```bash
cw wave retrospect wave:exchange-token-skeleton
# 输入数据从 stdin 读：{ retrospectData: {...} }
```

### 4.8 第 8 步：closeout（收尾）

**做什么**：
- 写 evidence（wave 的最终交付证据：testCases 最终版、commit hash、测试运行结果、retrospect）
- wave 进入 `closed`（归档，不再变动）
- wave 是叶子节点，不升级 ADR（ADR 是跨 feature / slice 复用的决策，wave 级经验进 retrospect 跨 wave 复用即可）

**wave 的使命到此结束**——代码已 commit + 测试已过，向上汇总到 slice 的 test 阶段（slice 验 wave 组合起来兑现了 techPlan）。

**状态**：`closed`（真终态，不可 reopen）

**命令**：
```bash
cw wave closeout wave:exchange-token-skeleton
```

### 4.9 wave 特有的改 testCases 机制（plan 状态特化）

> 本节回答一个 wave 特有的设计问题：wave verified 后发现 testCases 要改（如 verify后发现 expected 写错、execute 发现遗漏边界条件需重写 testCases），走什么路径？

**前 3 层的解法不适用 wave**：
- 前 3 层 verified 后改 plan 项走 `replan`（标下游，影响面传播）
- wave 是叶子（无 childUnitIds），改 testCases 没下游可标，**不是 replan 语义**

**wave 的解法（plan 状态特化）**：wave 的 `plan` action 允许在 `verified` 状态也调用（前 3 层 plan 的 from 是 `["clarifying", "planning"]`，wave 特化为 `["clarifying", "planning", "verified"]`）。**不含 executing**——executing 是 dev 写代码阶段，testCases 已定稿；真发现 testCases 要改说明 verify 没审好，需先回退到 verified（test 还没跑，wave 可在 verified 调 plan 重写 testCases）再走。这避免了「executing 状态改 testCases 后 verifyJudgment 失效但 verify.from 不含 executing 无法刷新」的状态机死锁。

**机制**：
- wave 在 verified 调 `cw wave plan`（progressive），重写 testCases
- wave 的 testCases 修改不影响下游（无 childUnitIds），所以**不需要走 replan 的影响面传播**（不标下游、不追加 abandonedRefs）
- wave status 不变（plan progressive 改 plan 项，不回退 status），但 wave 需要重新 verify（因为 testCases 变了，verifyJudgment 失效）
- 重新 verify 的机制：wave plan 后状态停在 `verified` / `executing`，agent 重新调 `cw wave verify`（progressive）刷新 verifyJudgment

**为什么这样设计（诚实说明取舍）**：
- **不引入新 action**（如 `amend-plan`）：保持「学一层会四层」，wave 的 action 集合和前 3 层一致（9+2），只是 plan 的状态约束特化
- **不走 replan**：wave 没下游，replan 的「标下游 + 影响面传播」机制对 wave 无意义（replan transition 在 wave 状态机保留仅为对称性，实际 wave 用不到，详见 §6）
- **特化 plan 的状态约束**：诚实承认这是 wave 对前 3 层的唯一状态机特化点，文档明说，不假装 wave 和前 3 层状态机完全一致

**wave 自己能改 testCases，不是 replan**：明确区分两种修改——
- **wave planning 状态时 plan progressive**：testCases 可多次写（同 slice planning 时 plan progressive）——这是 plan 的正常 progressive 语义
- **wave verified 后改 testCases**：走本节的 plan 状态特化（调 plan progressive 重写 testCases，不需走 replan）。executing 状态下发现 testCases 错说明 test 还没跑但 verify 没审好，需先回 verified 再走本机制
- **wave 被 slice replan 标记**（slice 改 TC/IF/DM/ERR 触发下游 wave 的 abandonedRefs）：这才是 wave 的「replan 承受」场景，wave 调 accept-replan / abort 解锁（机制见 §6）

---

## 5. TestCase（wavePlan.testCases 的组成单元）

### 5.1 TestCase 是什么

TestCase 是 `wavePlan.testCases` 的组成单元（和 feature 的 SpecSection、slice 的 TechSection 对称，**不再是顶层概念**）。它是 wave 把 slice 的技术方案翻译成测试驱动实现的具体载体。

**TestCase 的设计选择**（设计决策记录）：

| 设计选择 | wave 采用 | 理由 |
|---|---|---|
| **判别联合 vs 统一结构** | **统一结构**（不判别联合）| slice 的 TechSection 用判别联合是因为有 5 种异构类型（TC / IF / DM / ERR / TD）语义不同；wave 的 TestCase 都是「一个被测场景」的同构结构（scenario + input + expected），异构度低，判别联合是过度设计 |
| **TestCase 间强引用 gate** | **不做**（同 slice 不做 TechSection 间强引用 gate）| TestCase 间没有机器可验的有意义引用关系（一个 TestCase 不引用另一个 TestCase），机器 gate 验不出有价值的约束，靠 agent 自审 |
| **type 字段** | **有**（unit / integration / e2e）| 区分测试类型，影响 execute / test 阶段的执行策略（unit 跑快、integration 需要依赖），机器可验非空 + 集合约束 |

```typescript
interface TestCase {
  id: string;              // "TC1"（注意：wave 内部的 TestCase id，和 slice 的 TechChoice TC1 是不同命名空间，不冲突）
  name: string;            // "正常 code → 返回 TokenPair"
  scenario: string;        // 被测场景描述（含边界条件说明，投影自 clarify 的 Clarification）
  input: string;           // 测试输入（可形式化：JSON / 参数 / fixture 引用）
  expected: string;        // 预期输出（必须可形式化重算：JSON / 精确字符串 / 正则 / error 结构）
                           // expected 由 agent 自填（断言/预期值），cw 不重算——cw 只实跑测试验 pass/fail
                           // 详见 §4.6 「为什么 cw 不重算 expected」
  type: "unit" | "integration" | "e2e" | "manual";  // manual = 人工验证（承接 feature AC 的 verification=manual），cw 不能自动跑测试，退化为验 agent 填的 manual 验收记录 + commit 存在（详见 §4.6）
  status: "active" | "abandoned";  // 支持 replan（同 slice TechSection，详见 §5.4）
  replacedBy?: string;
}
```

**字段设计依据**：

- **`scenario`**：被测场景描述，含边界条件 / 异常分支说明。**投影自 clarify 的 Clarification**（clarify 澄清的边界条件、mock 策略写进 scenario），不单独造一个类型（设计决策 Q2：wave clarify 产物直接投影进 testCases 的 scenario / 边界条件说明）
- **`input`**：测试输入，由 agent 自填（JSON / 参数列表 / fixture 文件引用）
- **`expected`**：预期输出，**wave 的灵魂字段**。由 agent 自填（断言 / 预期值 / JSON 结构 / 精确字符串 / 正则 / error 对象）。**cw 不重算 expected**——cw 只实跑测试验 pass/fail，expected 的正确性由 agent 自负责（详见 §4.6「为什么 cw 不重算 expected」）
- **`type`**：测试类型，影响执行策略。unit（纯函数 / 单模块）/ integration（跨模块 / 需 mock 外部依赖）/ e2e（端到端，需真实依赖）/ **manual**（人工验证，承接 feature AC 的 verification=manual，cw 不自动跑）
- **`status` / `replacedBy`**：和 slice 的 TechSection 对称，支持 wave 的 testCases 变更（详见 §5.4）

### 5.2 为什么不做 TestCase 间的强引用 gate

slice 层不做 TechSection 间强引用 gate（slice §5.2），wave 层同样**不做** TestCase 间强引用 gate，理由更强：

- **TestCase 间无引用关系**：slice 的 TechSection 至少有 Interface 引用 DataModel 的语义关系（虽然复杂），wave 的 TestCase 之间**完全平级**——每个 TestCase 是独立的「一个被测场景」，不引用其他 TestCase
- **机器验不出有意义的约束**：TestCase 间能验的只有「id 唯一」「type 合法」这种弱约束，靠 agent 自审 + verify 的 `testCaseCoverageNote` / `boundaryConditionNote` 人审判断更合适
- **YAGNI**：强引用 gate 在 wave 层没有解决的问题（覆盖度靠人审，不靠引用关系）

**结论**：v4 wave 不做 TestCase 间的强引用 gate，靠人审（测试覆盖 note）。诚实承认这是 agent 自检 + 人审的职责，不假装机器能验。

### 5.3 TestCase 不是独立工作单元

和 epic 的 Clarification、feature 的 SpecSection、slice 的 TechSection 一样，TestCase **只是 wave plan 阶段产生的列表项**，挂在 wave 上：

```
wave
  ├─ objective: "..."
  ├─ status: planning
  ├─ clarifications: [...]          // clarify 阶段填（wave 自己的 Clarification）
  ├─ plan: {                        // plan 阶段填（含 testCases 作为内部字段）
  │    testCases: [                 // wavePlan.testCases
  │      { id: "TC1", name: "...", scenario: "...", input: "...", expected: "...", type: "unit" },
  │      { id: "TC2", name: "...", scenario: "...", input: "...", expected: "...", type: "unit" },
  │      ...
  │    ]
  │  }
  └─ (无 childUnitIds)              // wave 是叶子，不拆下一层
```

它没有自己的状态机、不是独立 Unit。wave closeout 后它跟着 wave 一起归档（测试代码进 commit，TestCase 记录进 evidence）。

### 5.4 testCases 变更不走 replan，走 plan progressive（wave 特有）

slice / feature 的 plan 项（TechSection / FR-AC）变更走 replan（标下游，影响面传播）。**wave 的 testCases 变更不走 replan**——因为 wave 是叶子（无 childUnitIds），改 testCases 没下游可标，不是 replan 语义（详见 §4.9 wave 特有的改 testCases 机制）。

**wave 改 testCases 的两种路径**：

| 场景 | 路径 | 机制 |
|---|---|---|
| **wave planning 状态时改 testCases** | plan progressive（多次写） | plan 的正常 progressive 语义，testCases 可多次重写 |
| **wave verified 后改 testCases** | plan progressive（plan 状态特化）| wave 特化：plan 的 from 加 verified（详见 §4.9）。改完重新 verify 刷新 verifyJudgment。executing 状态需先回 verified（test 还没跑，允许重写 testCases） |

**TestCase 的 `status` / `replacedBy` 字段用在哪**：
- TestCase 的 `status=abandoned` + `replacedBy` 用于**记录 testCases 的修改历史**（append-only，保历史，符合 guide §3.6）——agent 改 testCases 时，旧 TestCase 标 abandoned + replacedBy 指向新版本，而不是直接删除
- 这个历史记录服务于 retrospect（回顾 testCases 怎么演进的）和 evidence（最终交付包含完整的测试演进轨迹）
- 但**不触发影响面传播**（不标下游、不追加 abandonedRefs）——这是 wave 和 slice / feature 的关键差异：slice / feature 的 plan 项 abandoned 会标下游，wave 的 TestCase abandoned 只记历史不标下游

**wave 被上游 slice replan 标记时**（这是 wave 的「replan 承受」场景）：slice 改 TC/IF/DM/ERR 触发下游 wave 的 `abandonedRefs`（refKind=`techItem`），wave 被阻塞，调 accept-replan / abort 解锁（机制见 §6）。这是 wave 的 abandonedRefs 唯一来源——**wave 自己不改 testCases 不产生 abandonedRefs，只有上游 slice replan 才会给 wave 追加 abandonedRefs**。

---

## 6. wave 状态机

```
              create      clarify     plan      verify     execute     test     retrospect   closeout
  (开始) ─────────> created ──────> clarifying ──────> planning ──────> verified ──────> executing ──────> tested ──────> retrospected ──────> closed
                       ↑                │             │              ↑│           │            │             │
                       │                │             │              ↑│           │            │             │
                       └── clarify ─────┘             │              ↑│           │            │             │
                                      └── plan ──────┘──────────────┘│           │            │             │
                                                      └── verify ────┘           │            │             │
                                                                                 └── ... ────┘ ... ────────┘
                                                                                                                   │
                                                                                                                   ▼
                                                                                              任何非终态 ──abort──> aborted
                                                              有未处理 abandonedRefs ──accept-replan──> 原地（解锁）
```

> **图注**：plan → verified 的回流箭头（↑，位于 plan 和 verified 列之间）表示 wave 的 plan 状态特化——wave 在 verified 也能调 plan 改 testCases（详见 §4.9）。这是 wave 对前 3 层状态机的唯一特化点。不含 executing（避免 verifyJudgment 刷新不了的状态机死锁）。

**9 个状态**：created / clarifying / planning / verified / executing / tested / retrospected / closed / aborted

**9 个核心 action + 2 个旁路**：create / clarify / plan / verify / execute / test / retrospect / closeout / abort + replan / accept-replan

**和 epic / feature / slice 状态机的相同点**（这是「学一层会四层」的体现）：
- 9 状态流转主轴完全一致（created → ... → closed / aborted）
- 8 步主流程 action 完全一致
- `clarify` / `plan` / `verify` 是 progressive
- `execute` 是状态转换点（wave 是 verified → executing）
- `test` / `retrospect` / `closeout` 是一次性
- `closeout` 后真终态，不可 reopen
- `abort` 连带销毁所有非终态子孙（**wave 是叶子，无子孙可销毁**，abort 只销毁 wave 自己）

**wave 对前 3 层状态机的差异（3 点，诚实说明）**：

1. **plan 状态特化**（详见 §4.9）：wave 的 plan from 加 `verified`（不含 executing）——因为 wave 是叶子改 testCases 没下游影响面，允许 plan 在 verified 回流。前 3 层 plan from 是 `["clarifying", "planning"]`，wave 是 `["clarifying", "planning", "verified"]`。不含 executing 是为避免「executing 改 testCases 后 verifyJudgment 刷新不了」的死锁（verify.from 不含 executing，executing 发现 testCases 错要先回 verified）。

2. **replan transition 保留但 wave 用不到**（状态机对称性）：wave 状态机里保留 replan transition（from = verified / executing），但**实际 wave 永远不会调 replan**——wave 是叶子，没下游可标，replan 的「标下游 + 影响面传播」机制对 wave 无意义。保留 replan transition 仅为状态机对称性（每层都有 replan，wave 永远用不到，同 epic 的 accept-replan 仅为对称性保留但 epic 永远用不到）。文档明说这点，不假装 wave 会用 replan。

3. **execute 完成标志特化**：前 3 层 execute 完成的标志是「子层全 closeout」，wave 没子层，execute 完成的标志是「commit 存在」（机器验 `commit-exists` gate，详见 §4.5）。

**accept-replan（wave 的实际使用场景）**：
- wave 是叶子，会**被上游 slice replan 标记**（slice 改 TC/IF/DM/ERR 触发下游 wave 的 abandonedRefs，refKind=`techItem`）
- 此时 wave 自己被阻塞，必须调 `cw wave accept-replan` 或 `cw wave abort` 解锁
- 这是 wave 的 abandonedRefs 唯一来源——**wave 不发起 replan，只承受上游 slice replan**

**已 closeout 的 wave**（边界场景）：slice replan 时如果某个 wave 已经 closed（真终态），cw 不追加 `abandonedRefs`（那是阻塞用的），只走 `staleLog`（只记不阻塞，不强制处理）——机制同 epic §8.2 / slice §6「已 closeout 的下游」段。

**wave 的单向 replan 角色**（和 epic / feature / slice 都不同）：
- **epic**：纯发起者（顶层，basedOnParent 永远为空）
- **feature / slice**：双向（既发起标下游，又承受上游标记）
- **wave**：**纯承受者**（叶子，无 childUnitIds，不发起 replan；只承受上游 slice replan 的 abandonedRefs）

这是 wave（叶子）区别于前 3 层的重要特性。wave 是 DAG 的叶子节点，replan 影响面传播到 wave 为止（不再往下传，没下游了）。

---

## 7. wave 的命令一览

> 命令约定（参数传递 / 输出格式 / exit code 语义）见 [epic 文档 §8.0](./design-v4-epic.md#80-命令约定所有-scope-通用)，本文档不重复。

```bash
# 主流程（8 步）
cw wave create <slug> --from-slice <slice-id> --objective "..."
#   --slug / --from-slice / --objective 必填
#   继承父 slice 的 Clarification id + TC/IF/DM/ERR id（全量拷贝 id 到 basedOnParent，不含 TD）
#   注意：wave 是 slice 的直接下游，继承 techPlan 项（TC/IF/DM/ERR），不含 TD
#         （理由见 guide §6.2 跨层规则 + slice §4.5，不是 §5.2）

cw wave clarify <id>                                # progressive
#   输入数据从 stdin 读：{ clarifications: [...] }
#   实现维度的澄清（边界条件、mock 策略、测试驱动方式）

cw wave plan <id>                                   # progressive，可多次调用
#   输入数据从 stdin 读：{ testCases: TestCase[] }
#   testCases 存入 wavePlan.testCases
#   注意：wave plan 状态特化——from 含 verified / executing（详见 §4.9）
#         wave verified 后改 testCases 走 plan progressive，不走 replan
#         executing 状态需先回 verified（test 还没跑）

cw wave verify <id>                                 # progressive
#   机器 gate：test-cases-non-empty / test-cases-have-expected
#   业务判断非空（同 epic / feature / slice）

cw wave execute <id>                                # dev 写实现代码（递归出口）
#   agent 自行 git commit，cw 验 commit 存在（commit-exists gate）
#   execute 完成后进 test（跑测试）
#   注意：wave execute 不启动下一层（wave 是叶子），是整个 cw 的递归出口

cw wave test <id>                                   # 跑测试 + 机器验证
#   cw 自动跑测试（不需 agent 手动跑）验全 pass
#   机器 gate：commit-exists / test-cases-executed / tests-all-pass（核心机器 gate）
#   输入数据从 stdin 读：{ testJudgment: {...} }
cw wave retrospect <id>                             # 复盘
cw wave closeout <id>                               # 一次性，不可逆

# 旁路（同 epic §8.2）
cw wave abort <id>                                  # 任何非终态 → aborted
#   wave 是叶子，无子孙可销毁，abort 只销毁 wave 自己
#   代码不删（cw 不管 git，commit 留 git，新 wave 可参考）

cw wave replan <id>                                 # ⚠️ wave 实际用不到，仅为状态机对称性保留
#   wave 是叶子（无 childUnitIds），没下游可标，replan 机制对 wave 无意义
#   保留此 transition 仅为状态机对称性（同 epic 的 accept-replan 仅为对称性但 epic 用不到）
#   如需改 testCases，走 cw wave plan（plan 状态特化，详见 §4.9）

cw wave accept-replan <id> --reason "为什么接受新决策"
#   仅当 wave 自己的 abandonedRefs 有未处理记录时有效（被上游 slice replan 标了）
#   cw 在 abandonedRefs 对应记录追加 resolvedAt + resolvedAction，basedOnParent 不动（append-only）

# 查询（不走状态机）
cw wave status <id>                                 # 单个 WorkUnit 快照
cw wave list [--status planning] [--slice <slice-id>]   # wave 列表
cw wave show <id>                                   # 详情（含 wavePlan.testCases + commit hash）
```

---

## 8. 后续文档会展开的内容

本文档完成了 4 层 v4 设计（epic / feature / slice / wave 全部写完）。以下内容在后续文档展开，**不在本文档范围**：

| 内容 | 何时讲 |
|---|---|
| **stale 文档**（replan 触发的子孙过期同步、abandonedRefs / staleLog 的完整字段）| stale 文档 |
| **claim 文档**（多 agent 并行时，避免两个人同时做同一个 wave / slice）| claim 文档 |
| **ADR 文档**（重要 slice 级技术决策跨 feature 复用）| ADR 文档 |
| **research 服务**（Clarification type=research 时，agent 调外部查询）| research 文档 |
| **机器验证的实现细节**（cw 如何发现并执行 wave 测试套件、多 commit 场景下选哪个 commit、manual TestCase 的验收记录格式）| 实现侧文档（设计层面本文档 §4.5/§4.6 已讲透机制和能力边界）|
| **commit 关联机制**（wave 的 commit 如何关联 wave id、commit-exists gate 的具体验证方式）| 实现侧文档 |

---

## 9. 设计原则小结

wave 层继承 epic 的 15 条 + feature 的 3 条 + slice 的 1 条（见 [epic 文档 §11](./design-v4-epic.md#11-设计原则小结) / feature 文档 §9 / slice 文档 §9），补充 wave 特有的 3 条：

20. **wave 是整个 cw 唯一真正机器验证业务正确性的层**：前 3 层的 test gate 都是引用一致 / 结构校验（人审对照 verifyJudgment），只有 wave 的 test 是机器验证（cw 实跑测试验全 pass）。这是 wave 作为执行型 scope 的核心价值——cw 自己实跑测试验结果，保证 wave 不能「假声明」（不是 agent 说「测试过了」，是 cw 自己跑出来的 pass）。**诚实边界**：cw 验不了「测试覆盖度够不够 / expected 写得对不对」（后者靠 verify 人审），cw 保证的是「不能假声明」这个最大值，不是「测得全 / 测得对」。早期设计曾考虑「judgeByExpected 重算 expected」机制，因 cw 无法从 slice ERR 自由文本语义地推导 expected，且违反 cw agent-agnostic 不做业务判断的定位，已废弃——改为 cw 只实跑测试验 pass/fail，expected 由 agent 自填自负责。

21. **wave 是叶子，replan 角色是纯承受者**：wave 无 childUnitIds，不发起 replan（没下游可标），只承受上游 slice replan 的 abandonedRefs。这是 wave 区别于前 3 层（发起者 / 双向）的本质。由此带来两处状态机特化（详见 §6）：plan from 加 verified、replan transition 保留但不可达。

22. **wave plan 先写测试（TDD 红），execute 写实现（TDD 绿），test 跑测试机器验证**：wave 的 8 步流程严格遵循 TDD 节奏——plan 阶段的 testCases 是 TDD 的红灯起点（testCases 必须能在 execute 之前 fail，verify 的 `tddRedReadinessNote` 人审这点），execute 阶段写最小实现让测试过（绿灯），test 阶段跑测试做机器验证。这个节奏是 wave 区别于前 3 层（规划型）的本质——前 3 层的 plan 写方案 / 需求 / 拆分，wave 的 plan 写测试代码驱动实现。

---

## 附录：wave 层接口（实施参考）

```typescript
interface Wave {
  id: string;                    // "wave:exchange-token-skeleton"
  scope: "wave";
  slug: string;
  status: "created" | "clarifying" | "planning" | "verified"
        | "executing" | "tested" | "retrospected" | "closed" | "aborted";
  statusHistory: StatusEvent[];
  parentUnitId: string;          // 父 slice id
  objective: string;             // create 时必填
  basedOnParent: string[];       // 从 slice 继承的 Clarification id + TC/IF/DM/ERR id（plan 时可减少）
                                  // 注意：不含 TD（TechDecision 跟随 Clarification replan，不独立持有 status/replacedBy）
                                  // append-only 历史记录，永不重写（见 epic §7.3）
  abandonedRefs: AbandonedRef[]; // 被废弃的引用及处理状态（和 epic / feature / slice 同构）。
                                  // wave 的 abandonedRefs 唯一来源：被上游 slice replan 标记（refKind=techItem）
                                  // wave 自己改 testCases 不产生 abandonedRefs（走 plan progressive）
                                  // 空数组 = 不阻塞
  clarifications: Clarification[];          // clarify 阶段填（wave 自己的 Clarification，实现细节维度）
  plan?: WavePlan;                         // plan 阶段填（含 testCases 作为内部字段）
  verifyJudgment?: VerifyJudgment;          // verify 阶段填（业务判断，偏测试覆盖维度）
  commitHash?: string;                     // execute 阶段填（dev 写完实现 commit 后，cw 验存在）
  testJudgment?: TestJudgment;              // test 阶段填（对照 verifyJudgment 验收 + 机器验证 pass/fail 结果）
  retrospectData?: RetrospectData;          // retrospect 阶段填（对照 verifyJudgment 复盘，含 reviewedItems）
  evidence?: Evidence;                       // closeout 时填
  payload: WavePayload;
  // 注意：wave 无 childUnitIds——wave 是叶子，不拆下一层
}

// ── plan 产物（plan 阶段）──
// testCases 降级为 plan 的内部字段（顶层概念不暴露 TestCase）
// 注意：wave plan 没有 split 产物（wave 是叶子，不拆下一层）——这是 wave plan 和前 3 层的本质差异
interface WavePlan {
  testCases: TestCase[];         // 测试代码（TDD 起点，feature 的 spec / slice 的 techPlan 的对应物）
}

type TestCase = WavePlan['testCases'][number];  // TestCase 仍是类型，但不再是顶层概念

// ── TestCase（统一结构，不判别联合，见 §5.1）──
interface TestCase {
  id: string;              // "TC1"（wave 内部命名空间，和 slice 的 TechChoice TC1 不冲突）
  name: string;            // "正常 code → 返回 TokenPair"
  scenario: string;        // 被测场景描述（含边界条件说明，投影自 clarify 的 Clarification）
  input: string;           // 测试输入（可形式化：JSON / 参数 / fixture 引用）
  expected: string;        // 预期输出（必须可形式化重算：JSON / 精确字符串 / 正则 / error 结构）
                           // expected 由 agent 自填（断言/预期值），cw 不重算——cw 只实跑测试验 pass/fail
                           // 详见 §4.6 「为什么 cw 不重算 expected」
  type: "unit" | "integration" | "e2e" | "manual";  // manual = 人工验证类，cw 不自动跑测试
  status: "active" | "abandoned";  // 支持 testCases 变更历史记录（append-only，详见 §5.4）
  replacedBy?: string;
}

// ── Clarification / AbandonedRef（和 epic / feature / slice 同构）──
// 定义见 epic 文档附录，wave 层不重复定义。
// Clarification 的 status/replacedBy、AbandonedRef 的 refKind/resolvedAt/resolvedAction
// 语义和 epic / feature / slice 完全一致。
// wave 的 AbandonedRef.refKind 唯一实际取值：techItem（被上游 slice replan 标记时）
//   clarification / specItem 理论上不会出现在 wave（wave 不继承 FR/AC/UC，只继承 TC/IF/DM/ERR）

// VerifyJudgment / TestJudgment / RetrospectData / Tradeoff / Risk / VerifyItemRef
// 这些类型所有层共享，定义在 epic 文档附录。wave 层不重复定义。
// wave 的 verifyJudgment.layerSpecific 典型 KV（都是人审判断，gate 只验非空）：
//   testCaseCoverageNote: string      testCases 对 slice techPlan 的覆盖度自检
//   boundaryConditionNote: string     边界条件覆盖自检
//   mockStrategyNote: string          mock 策略合理性自检
//   tddRedReadinessNote: string       testCases 是否真能在 execute 之前 fail（TDD 红灯就绪）

// wave 的 transitions 规则（与 epic / feature / slice 基本相同，3 点特化见 §6）
const WAVE_TRANSITIONS = {
  create:       { from: [],                                                  to: "created" },
  clarify:      { from: ["created", "clarifying"],                           to: "clarifying", progressive: true },
  // ⚠️ wave 特化点 1：plan 的 from 加 verified（不含 executing）
  // 原因：wave 是叶子改 testCases 没下游影响面，允许 plan 在 verified 回流改 testCases（详见 §4.9）
  // 不含 executing 的原因：executing 是 dev 写代码阶段，testCases 已定稿；真发现 testCases 要改说明
  // verify 没审好，需回退到 verified 重审（避免 executing 状态改 testCases 后 verifyJudgment 失效的死锁）
  // 前 3 层 plan from 是 ["clarifying", "planning"]，wave 特化为下面这行
  plan:         { from: ["clarifying", "planning", "verified"], to: "planning",   progressive: true },
  verify:       { from: ["planning", "verified"],                            to: "verified",   progressive: true },
  execute:      { from: ["verified"],                                        to: "executing" },
  test:         { from: ["executing"],                                       to: "tested" },
  retrospect:   { from: ["tested"],                                          to: "retrospected" },
  closeout:     { from: ["retrospected"],                                    to: "closed" },
  abort:        { from: ["created", "clarifying", "planning", "verified", "executing", "tested", "retrospected"], to: "aborted" },
  // 注：wave 是叶子，无子孙可销毁（alsoAbortsChildren 实际无效果，但保留字段和前 3 层对称）

  // ⚠️ wave 特化点 2：replan transition 保留但 wave 实际用不到（状态机对称性）
  // wave 是叶子（无 childUnitIds），没下游可标，replan 机制对 wave 无意义
  // 保留此 transition 仅为状态机对称性（同 epic 的 accept-replan 仅为对称性但 epic 用不到）
  // 如需改 testCases，走 plan（状态特化，from 含 verified / executing）
  replan:       { from: ["verified", "executing"],                           to: undefined /* 原地 */, progressive: true, triggersImpactPropagation: true },
  // accept-replan：仅当 abandonedRefs 有未处理记录（resolvedAt 为空）才合法
  // wave 是叶子，可能被上游 slice replan 标记（slice 改 TC/IF/DM/ERR 触发下游 wave 的 abandonedRefs）
  acceptReplan: {
    from: ["created", "clarifying", "planning", "verified", "executing", "tested", "retrospected"],
    guard: "abandonedRefs.some(r => !r.resolvedAt)",   // 有未处理的废弃引用
    // 注：from 含所有非终态不仅是状态机对称性，对 wave 是实际需要——
    // slice replan 在 verified/executing 触发，但 slice executing 时 wave 可能在任意非终态
    // （planning/verified/executing），wave 都可能被 slice 标 abandonedRefs。所以 from 含这些状态
    // 是实际场景不是仅为对称性
    to: undefined,  // 原地，cw 在 abandonedRefs 对应记录追加 resolvedAt + resolvedAction，basedOnParent 不动（append-only）
  },
};

// stdin 输入数据类型
interface ClarifyInput {
  clarifications: Array<{ id: string; question: string; resolution?: string; type: "research" | "grilling" }>;
}

interface PlanInput {
  testCases: TestCase[];         // 测试代码（存入 wavePlan.testCases）
  // 注意：wave plan 无 split 输入（wave 是叶子，不拆下一层）
}

// wave 不定义自己的 ReplanInput——wave 实际用不到 replan（详见 §6 特化点 2）
// wave 改 testCases 走 plan progressive（PlanInput），不走 replan
// wave 被 slice replan 标记时，wave 只调 accept-replan（不需 ReplanInput）

// wave 的 verify gate
const WAVE_VERIFY_GATES = [
  // 结构完整性
  "test-cases-non-empty",          // testCases 至少 1 条
  "test-cases-have-expected",      // 每个 TestCase 的 expected 非空（TDD 红灯前提，expected 由 agent 自填）
  // 注意：wave 不做 TestCase 间的强引用 gate——TestCase 间无引用关系，机器验不出有意义约束（见 §5.2）
  // 业务判断非空（同 epic / feature / slice，验「agent 有没有填」，不验内容对错）
  "verify-necessity-non-empty",    // verifyJudgment.necessity 非空
  "verify-sufficiency-complete",   // sufficiency 三项（gaps/overlaps/meceNote）都填
  "verify-alternatives-non-empty", // alternatives 非空（五个核心维度都机器验非空，同 epic / feature / slice）
  "verify-tradeoffs-present",      // tradeoffs 至少 1 条，或显式声明「无」+ 理由
  "verify-risks-present",          // risks 至少 1 条，或显式声明「无」+ 理由
];

// wave 的 test gate（整个 cw 唯一真正机器验证业务正确性的 gate）
const WAVE_TEST_GATES = [
  // 结构完整性
  "commit-exists",                 // execute 阶段传入的 commitHash 在仓库真实存在（机器验 git cat-file -e），记录在 wave.commitHash
  "test-cases-executed",           // 所有非 manual testCases 都真跑了（机器验测试运行记录，不信任 agent 声明）
  // tests-all-pass（核心机器 gate，整个 cw 唯一真正机器验证业务正确性的 gate）
  // cw 实跑 wave 的测试套件，验所有非 manual testCases 的测试都 pass（fail 数 = 0）
  // manual TestCase 不机器跑，走退化验证（§4.6）
  "tests-all-pass",
  // test-references-verify：testJudgment 必须逐条对应 verifyJudgment 的每一类（引用一致性）
  // 校验项：necessityMet / sufficiencyMet / alternativesReconsidered 非空，
  //         每个 Tradeoff.id 都有对应的 tradeoffCostRealized.tradeoffRef，
  //         每个 Risk.id 都有对应的 riskOutcome.riskRef（不能漏验任何一类/任何一条）
  "test-references-verify",
];

// wave 的 retrospect gate
const WAVE_RETROSPECT_GATES = [
  "lessons-learned-non-empty",     // retrospectData.lessonsLearned 非空（机器 gate）
  "retrospect-covers-verify",      // reviewedItems 覆盖 verifyJudgment 每项（机器 gate，验覆盖不验 verdict）
  // 人审（机器验不了）：reviewedItems 的 verdict 是否判断得对、note 质量深不深
];
```
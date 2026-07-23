# cw 1.0 设计文档 v5 · wave 层

> 本文是 v5 wave 层的设计。流程/状态机/通用字段见 [design-v5-model.md](./design-v5-model.md)，本文只描述 wave 的差异。本文使用的所有概念以 model 文档词表为准。
>
> wave 是 v5 里**唯一的 ExecutionUnit**。4 层中只有 wave 真正写代码、真正跑测试、真正有 `testJudgment` / `execReviewJudgment`。这是 wave 区别于 epic/feature/slice（PlanningUnit）的根本特征。
>
> 本文不重复 model 文档的公共定义（WorkUnit 顶层接口、9 步流程定义、状态机、replan 通用机制、WorkUnitItem/Plan/Split 基础类型），只在必要处引用 model 章节号。读者应先读 model 文档 §1~§5 再读本文。
>
> 本文重点：① WavePlan 的 4 个条目类型（WaveTestCase/WaveTask/WaveFile/WaveContract）完整结构；② wave 独有的 test 和 exec-review 两个步骤的业务内容；③ `execReviewJudgment` 在 model §5.8 提案基础上的**定稿**。

---

## 0. wave 是什么

引用 model §1.2 的对照表：wave 是 ExecutionUnit，**单次提交可完成的执行单元**，由 slice 拆分产生，是 cw 的叶子节点（不再拆下一层）。

| 维度 | wave |
|---|---|
| **类型** | ExecutionUnit（v5 两类 WorkUnit 之一，详见 model §1.1）|
| **流程** | 9 步（多 test + exec-review，详见 model §2.2）|
| **状态** | 10 状态（详见 model §3.2）|
| **职责** | 施工 + 验证：把 slice 的技术方案翻译成测试驱动的可执行实现 |
| **execute 做什么** | dev 写代码（递归出口，不启动下层）|
| **产出** | 代码 + 测试结果（**cw 唯一产出代码的层**）|
| **粒度** | 单次提交可完成（典型 30min-2h）|
| **replan 角色** | 承受者 + 叶子发起者（详见 §8：承受上游 slice replan 被 abort；自己 replan 改 WavePlan 无下游级联，但必须重新 design-review）|

**判别特征**（和 PlanningUnit 的区别，model §1.3 三个判别字段）：
1. `executeResult` 是 `ExecutionExecuteResult { commitHash }`（不是 `PlanningExecuteResult { childUnitIds }`）
2. 有 `testJudgment`（PlanningUnit 没有）
3. 有 `execReviewJudgment`（PlanningUnit 没有）

典型 wave 例子（slice = `oauth-backend` 拆出的）：
- `exchange-token-skeleton`：exchangeToken 接口骨架 + 类型定义 + 单测（TDD 红→绿）
- `error-handling`：invalid_grant 等错误态处理 + 单测
- `provider-integration`：接入 GitHub / Google 真实 OAuth 提供商 + 集成测

**wave 的存在意义**：slice 只产出技术方案（model §5.7 的 SliceTechChoice/SliceInterface/SliceDataModel/SliceErrorSpec），粒度是技术选型和接口契约，还停在「怎么设计」层面，没到「怎么实现」。wave 把技术方案翻译成测试驱动的可执行实现——testCases 驱动实现，tasks/files 给 execute 照着做，contracts 跨 wave 对齐。一个 slice 通常拆成多个 wave（按 TDD 节奏或功能子模块），每个 wave 有独立测试边界，能单独判定做完没（test 跑测试通过）。

---

## 1. wave 的流程（9 步，重点写 test 和 exec-review）

wave 走 ExecutionUnit 9 步流程（model §2.2）：

```
create → clarify → plan → design-review → execute → test → exec-review → retrospect → closeout
 创建     澄清    规划     设计审查         执行    跑测试   执行审查      复盘       收尾
```

**为什么 wave 多 test 和 exec-review**（model §2.2 已给理由，本文不重复）：
- wave 的 execute 产出代码，必须验证代码**对不对**（test）和**好不好**（exec-review）
- test = 跑测试 + 对照 `designReviewJudgment`（业务正确性，**机器 gate**：tests-all-pass）
- exec-review = 审代码品味/架构/可读性（**纯人审，无机器 gate，不阻塞 closeout**）

**为什么是 test → exec-review 顺序**：先确认功能对（test pass），再审代码品味。功能不对时审品味没意义（model §2.2）。

本文下面只写 wave 各步骤的**业务内容**和**和 PlanningUnit 的差异**，不重写步骤定义。

| 步骤 | wave 的业务内容 | 和 PlanningUnit 的差异 |
|---|---|---|
| create | 建实例，填 objective（这个 wave 完成后能交付什么可验证的代码）| 无本质差异 |
| clarify | 澄清实现细节（边界条件 / mock 策略 / 测试驱动方式）| 维度不同（PlanningUnit 澄清方案/需求，wave 澄清实现细节）|
| **plan** | **写测试代码（testCases）+ 执行细节（tasks/files/contracts），TDD 起点** | 产物完全不同（PlanningUnit 是 Split 拆下层；wave 是测试 + 执行细节，**不拆下层**）|
| design-review | 审测试覆盖（执行前）| 维度不同（PlanningUnit 审方案合理性；wave 审测试覆盖）|
| **execute** | **dev 写代码（递归出口），产出 commitHash** | 本质不同（PlanningUnit 启动下层；wave 写代码）|
| **test** | **跑测试 + 对照 designReviewJudgment 验收**（机器 gate）| **PlanningUnit 没这步** |
| **exec-review** | **审代码品味**（纯人审，不阻塞）| **PlanningUnit 没这步** |
| retrospect | 提炼经验（对照 designReviewJudgment + testJudgment + execReviewJudgment 三处）| 不兼验收（PlanningUnit 的 retrospect 兼验收；wave 的验收已在 test/exec-review 做完）|
| closeout | 收尾归档 | 无本质差异 |

下面 §2~§8 按差异重点展开。

---

## 2. wave 的 plan 结构（WavePlan 核心差异）

### 2.1 WavePlan 总览

wave 的 plan 产物是 `WavePlan extends Plan`（model §4.3）：

```typescript
interface WavePlan extends Plan {
  // 继承自 Plan：split: Split[]（wave 是叶子，实例化时 cw 自动填 []，结构兼容 WorkUnit.plan）
  testCases: WaveTestCase[];      // 测试代码（TDD 起点）
  tasks: WaveTask[];              // 执行步骤清单（execute 照着做）
  files: WaveFile[];              // 文件改动清单（execute 照着改）
  contracts: WaveContract[];      // 跨 wave / 跨 slice 接口契约（对齐用）
}
```

**关于继承来的 `split` 字段**：wave 是 ExecutionUnit 叶子，**不拆下一层**（model §1.2）。`WavePlan` 继承 `Plan` 基类所以带 `split` 字段，但实例化时 cw 自动填 `[]`，不接收 agent 输入。保留这个冗余字段换取 `WorkUnit.plan` 结构全兼容（所有层的 plan 都有 split 字段，统一引擎不用特判 wave）。这是 wave plan 和 PlanningUnit plan 的本质差异——PlanningUnit 的 split 拆到下一层，wave 的 split 永远空。

**plan 的 4 个字段都是 plan 阶段产出、execute 阶段消费的「执行细节」**（不是顶层概念，挂在 WavePlan 上作为内部字段）。设计依据来自真实项目调研（12 个 topic 的 plan.md）：Task List 100% 出现、File Structure 83%、Interface Contracts 50%。v5 把这些和 testCases 并列放进 WavePlan。

| 字段 | 定位 | 阶段角色 |
|---|---|---|
| `testCases` | 测试驱动契约（TDD 起点）| plan 产出，execute 让它从红变绿，test 机器验全 pass |
| `tasks` | 执行步骤清单 | plan 产出，execute 照着做 |
| `files` | 文件改动清单 | plan 产出，execute 照着改 |
| `contracts` | 跨 wave / 跨 slice 接口契约 | plan 产出，其他 wave / slice 对齐用 |

**为什么 wave plan 要 4 个字段而不是只 testCases**：testCases 是 TDD 的硬前提（plan 必须先写测试），但 tasks/files/contracts 是 execute 阶段的施工蓝图——execute 是递归出口（dev 写代码），需要明确的步骤清单和文件改动清单才能高效施工。contracts 用于跨 wave / 跨 slice 对齐接口（如 wave A 暴露 `exchangeToken`，wave B 的 `login-callback` 消费它），避免接口漂移。

### 2.2 WaveTestCase（测试用例，TDD 起点）

`testCases` 是 wave 留给 execute 的「测试驱动契约」，是 TDD 的红灯起点。

```typescript
interface WaveTestCase extends WorkUnitItem {
  // 继承自 WorkUnitItem（model §4.1）：id（如 "TC1"）/ status: "active"|"abandoned"
  name: string;            // "正常 code → 返回 TokenPair"
  scenario: string;        // 被测场景描述（含边界条件 / 异常分支说明，投影自 clarify 的 Clarification）
  input: string;           // 测试输入（可形式化：JSON / 参数 / fixture 引用）
  expected: string;        // 预期输出（必须可形式化：JSON / 精确字符串 / 正则 / error 结构）
                           // expected 由 agent 自填（断言 / 预期值），cw 不重算——cw 只实跑测试验 pass/fail
                           // 详见 §5「为什么 cw 不重算 expected」
  type: "unit" | "integration" | "e2e" | "manual";
                           // manual = 人工验证（承接 feature AC 的 verification=manual），cw 不自动跑测试
                           // 详见 §5「AC.verification 字段消费」
}
```

**字段设计要点**：

- **`scenario`**：被测场景描述，含边界条件 / 异常分支说明。**投影自 clarify 的 Clarification**——clarify 澄清的边界条件、mock 策略写进 scenario。不需要额外造类型（clarify 产物就是 `Clarification`，plan 时投影进 testCases 的 scenario，机制同 slice 的 `Decision` 投影 Clarification，model §5.10）。

- **`expected`（wave 的灵魂字段）**：由 agent 自填（断言 / 预期值 / JSON 结构 / 精确字符串 / 正则 / error 对象）。**cw 不重算 expected**——cw 只实跑测试验 pass/fail，expected 的正确性由 agent 自负责。这是 §5 「为什么 cw 不重算 expected」的核心约束。

- **`type`**：测试类型，影响执行策略。
  - `unit`：纯函数 / 单模块，cw 实跑最快
  - `integration`：跨模块 / 需 mock 外部依赖
  - `e2e`：端到端，需真实依赖
  - **`manual`**：人工验证（承接 feature AC 的 `verification=manual`，model §7.3），cw 不自动跑测试，退化为验 agent 填的 manual 验收记录 + commit 存在（详见 §5）

**例子**（wave = `exchange-token-skeleton`）：

| id | name | type | 验证什么 |
|---|---|---|---|
| TC1 | 正常 code → 返回 TokenPair | unit | 核心路径：合法 code 调用 OAuth 提供商成功，返回 TokenPair 结构 |
| TC2 | 空 code → 抛 INVALID_CODE | unit | 边界条件：空输入校验 |
| TC3 | 过期 code → 抛 INVALID_GRANT | unit | 边界条件：OAuth 提供商返回 invalid_grant 的处理（承接 slice `SliceErrorSpec` ERR1）|
| TC4 | 网络超时 → 抛 PROVIDER_TIMEOUT | unit | 边界条件：网络异常处理 |
| TC5 | TokenPair 结构符合 DM1 | unit | 数据模型契约：返回值结构匹配 slice `SliceDataModel` DM1 定义 |

### 2.3 WaveTask（执行任务清单）

`tasks` 是 wave 留给 execute 的「执行步骤清单」——execute 阶段照着做。

```typescript
interface WaveTask extends WorkUnitItem {
  // 继承自 WorkUnitItem：id（如 "TASK1"）/ status: "active"|"abandoned"
  type: "impl" | "refactor" | "test" | "fix" | "doc" | "other";
                           // 任务类型，影响 execute 策略。枚举化便于统计 / 分类 / 报告
  files: string[];         // 涉及文件路径列表（对应 WaveFile.path 的子集，agent 自审对齐）
  steps: string[];         // 执行步骤（按顺序做的动作清单）
  dependsOn?: string[];    // 依赖的其他 WaveTask id（task 间 DAG，无循环，agent 自审不机器验）
}
```

**字段设计要点**：
- `type` 影响执行策略，枚举化（`impl` 写新代码、`refactor` 重构、`test` 补测试、`fix` 修 bug、`doc` 文档、`other` 兜底）。机器可验合法值
- `files` 是 `WaveFile.path` 的子集引用（agent 自审对齐，不做机器 gate——见 §2.6「不做 plan 条目间强引用 gate」）
- `dependsOn` 让 task 间形成 DAG，execute 按 DAG 顺序做，但不做机器 gate 验 DAG（task 间依赖靠 agent 自审）

**例子**：

| id | type | files | dependsOn |
|---|---|---|---|
| TASK1 | impl | `src/oauth/token.ts` | — |
| TASK2 | impl | `src/oauth/token.ts` | TASK1 |
| TASK3 | impl | `src/oauth/provider.ts` | TASK1 |

### 2.4 WaveFile（文件改动清单）

`files` 是 wave 留给 execute 的「文件改动清单」——execute 阶段照着改。

```typescript
interface WaveFile extends WorkUnitItem {
  // 继承自 WorkUnitItem：id（如 "FILE1"）/ status: "active"|"abandoned"
  path: string;            // 文件路径（独立字段，不混进 id——id 是 replan 追踪用的稳定标识，path 是物理路径）
  action: "create" | "modify" | "delete";  // 文件动作
  description: string;     // 一句话描述改什么
}
```

**字段设计要点**：
- **`path` 独立成字段**（不混进 `id`）：`id` 是 replan 追踪用的稳定标识（如 "FILE1"），`path` 是物理路径（可能变，如重构后挪位置），两者职责不同
- `action` 三选一，机器可验合法值
- `description` 自由文本，一句话说明改什么（execute 时 agent 照着改）

**例子**：

| id | path | action | description |
|---|---|---|---|
| FILE1 | `src/oauth/token.ts` | create | exchangeToken 接口骨架 + TokenPair 返回 |
| FILE2 | `src/oauth/provider.ts` | create | oauth2-client 封装 |
| FILE3 | `src/types/oauth.ts` | modify | 新增 TokenPair 类型定义（承接 slice `SliceDataModel` DM1）|

### 2.5 WaveContract（接口契约）

`contracts` 是 wave 暴露给**其他 wave 或 slice** 的接口契约——跨 wave / 跨 slice 对齐用。

```typescript
interface WaveContract extends WorkUnitItem {
  // 继承自 WorkUnitItem：id（如 "CONTRACT1"）/ status: "active"|"abandoned"
  name: string;            // 契约名（如 "exchangeToken"）
  type: "function" | "api" | "class" | "event" | "schema" | "other";
                           // 契约类型，枚举化便于分类 / 统计
  definition: string;      // 契约定义（签名 / schema，自由文本，人审）
  // 不设 consumers 字段——和 SliceInterface 一致，跨单元引用走 basedOnParent 反查（model §5.6），不维护会腐烂的弱引用列表
}
```

**字段设计要点**：
- **不设 `consumers` 字段**——和 slice 的 `SliceInterface` 统一：跨单元引用走 `basedOnParent` 反查（model §5.6），不维护会腐烂的弱引用列表。理由：slice 已经证明 `basedOnParent` 反查可行；`consumers` 是弱引用会腐烂（agent 自填，不机器验）；wave 是叶子层，`basedOnParent` 反查虽然没下游，但「其他 wave / slice 谁引用了我」同样可以从 slice 的 split 反查得到
- `type` 枚举化（function / api / class / event / schema / other），机器可验合法值
- `definition` 自由文本，人审（不机器解析）

**例子**：

| id | name | type | definition |
|---|---|---|---|
| CONTRACT1 | exchangeToken | function | `(code: string) => Promise<TokenPair>` |

消费关系不靠 `consumers` 字段，靠跨层 `basedOnParent` 反查：`oauth-frontend` slice 的 wave `login-callback` 若在它的 `basedOnParent` 里引用了 CONTRACT1，则可反查到它是消费方。

### 2.6 为什么不做 plan 条目间强引用 gate

v5 wave **不做** plan 条目间强引用 gate（继承 v4 的决策，理由更强）：

- **条目间无引用关系**：wave 的 4 种条目（TestCase/Task/File/Contract）**完全平级**——每个条目是独立的「一个执行单元」，不引用其他条目（WaveTask.dependsOn 是 task 间顺序依赖，不是引用关系）
- **机器验不出有意义的约束**：条目间能验的只有「id 唯一」「type 合法」这种弱约束，靠 agent 自审 + design-review 的 `testCaseCoverageNote` 人审判断更合适
- **YAGNI**：强引用 gate 在 wave 层没有解决的问题（覆盖度靠人审，不靠引用关系）

**结论**：v5 wave 不做条目间强引用 gate，靠人审（design-review 阶段的覆盖度 note）。诚实承认这是 agent 自检 + 人审的职责，不假装机器能验。

### 2.7 机器 gate（design-review 阶段验）

design-review 阶段对 plan 产物的机器 gate（验结构不验内容）：

- **`test-cases-non-empty`**：`testCases` 至少 1 条（testCases 是 TDD 硬前提，必填）
- **`test-cases-have-expected`**：每个 WaveTestCase 的 `expected` 非空（TDD 红灯前提，expected 由 agent 自填）
- **业务判断非空**：`designReviewJudgment.necessity` / `sufficiency`（gaps+overlaps+meceNote）/ `alternatives` / `tradeoffs` / `risks` 都按 model §5.8 要求填齐

**不对 tasks / files / contracts 做机器非空 gate**（取舍决策）：
- testCases 是 TDD 红灯硬前提（没测试 execute 不了），必须机器验
- tasks / files / contracts 是「执行细节」，原则上一个极简 wave（如纯类型定义修正）可以没有显式 task 拆分、只改一个 file、不暴露新 contract——机器强验非空会过度约束 wave 形态
- 真实项目调研显示 tasks / files 高频（100% / 83%），但「高频」不等于「必填」，contracts 只 50% 更不该强制
- tasks / files / contracts 通过 **guidance 提示**（design-review 的 sufficiency 维度里问「tasks / files 和 testCases 对得上吗」）让人审盯，不进机器 gate
- 如果未来发现 agent 经常漏写 tasks / files 导致 execute 卡壳，再升级为机器 gate（YAGNI）

---

## 3. wave 的 designReviewJudgment.layerSpecific（执行前审测试覆盖）

wave 的 design-review 阶段（model §2.2 第 4 步）在 dev 写实现代码**之前**，对 plan 阶段的 testCases / tasks / files / contracts 做**结构化的测试覆盖判断**。

`designReviewJudgment` 的共享字段（necessity / sufficiency / alternatives / tradeoffs / risks，model §5.8）所有层一致，本文不重复。wave 的差异在 `layerSpecific`——wave 关心的是**测试覆盖维度**（PlanningUnit 关心的是方案合理性 / 拆分边界）。

wave 专属判断填入 `designReviewJudgment.layerSpecific`（model §5.8 具名化约定：各层文档应定义具名 interface 收紧 `layerSpecific`，wave 的具名 interface 是 `WaveDesignReviewLayerSpecific`，所有字段都是 string——满足 model §5.8 的下界 `Record<string, string>`），典型字段（**都是 agent 人审判断，gate 只验非空，不验内容**）：

```typescript
// wave 层 designReviewJudgment.layerSpecific 的具名 interface（model §5.8 具名化约定）
interface WaveDesignReviewLayerSpecific {
  testCaseCoverageNote?: string;     // testCases 对 slice 技术方案的覆盖度自检
  boundaryConditionNote?: string;    // 边界条件覆盖自检
  mockStrategyNote?: string;         // mock 策略合理性自检
  tddRedReadinessNote?: string;      // TDD 红灯就绪自检
}
```

| layerSpecific 字段 | 含义 | wave 要回答的问题 |
|---|---|---|
| `testCaseCoverageNote` | testCases 对 slice 技术方案的覆盖度自检 | testCases 加起来覆盖了 slice 负责的所有 SliceInterface / SliceDataModel / SliceErrorSpec 吗？正常路径覆盖了吗？|
| `boundaryConditionNote` | 边界条件覆盖自检 | 边界条件（空输入 / 超长 / 非法格式 / 边界值 / 并发场景）想到了没？想到了的列出来 |
| `mockStrategyNote` | mock 策略合理性自检 | mock 了什么、为什么不 mock 真实、mock 会不会失真 |
| `tddRedReadinessNote` | TDD 红灯就绪自检 | testCases 是否真的能在 execute 之前 fail（TDD 红灯）——expected 是否足够精确到能判 fail/pass |

**machine gate 对 layerSpecific 只验非空**——测试覆盖关系机器判不准（testCases 是否覆盖了 SliceInterface 的所有错误态，机器无法判断），那是 agent 自检职责，放进 `testCaseCoverageNote` 让 agent 显式回答。

**design-review 通过的含义**：testCases 定稿（+ tasks / files / contracts 想清楚了），TDD 红灯就绪，可以进 execute 让 dev 写实现了。

---

## 4. wave 的 execute（写代码 + commitHash 关联 + evidence 客观字段生成）

wave 的 execute（model §2.2 第 5 步）是**递归出口**——前 3 层（epic/feature/slice）的 execute 都是「启动下层」（递归），wave 的 execute = **dev 写实现代码**：

- agent（dev 角色）按 plan 阶段的 testCases（测试代码）写实现代码
- 实现要让所有 testCases 从 fail（TDD 红灯）变成 pass（TDD 绿灯）
- 这是 TDD 的「绿」阶段——testCases 在 plan 已写好（红），execute 写最小实现让测试过

### 4.1 execute 产物：ExecutionExecuteResult { commitHash }

按 model §2.5，wave 的 execute 产物是：

```typescript
interface ExecutionExecuteResult extends ExecuteResult {
  commitHash: string;              // dev 写完代码后的 commit hash（cw 验存在性）
}
```

存在 `wave.executeResult.commitHash`（**不是独立的 `wave.commitHash` 字段**——model §1.3 的 WorkUnit 顶层接口里，execute 阶段产物统一挂在 `executeResult: ExecuteResult`，子类型区分 PlanningUnit / ExecutionUnit）。

**注意**：wave 的 `testRunResult`（测试运行结果）归 test 阶段，**不归 execute**——execute 只管「代码写完且 commit 了」，test 阶段才跑测试拿结果（model §2.5）。

### 4.2 commitHash 关联机制（沿用现有能力，model §7.3）

**wave execute 完成的标志是「代码 commit 存在」**——agent 调 `cw wave execute` 时，通过 stdin 传入实现的 commit hash，cw 机器验证该 commit 真实存在并记录到 `wave.executeResult.commitHash`：

**具体机制（设计层定死，不疑给实现侧）**：

1. agent 在 execute 阶段写完实现代码后，自行 `git add` + `git commit`（cw 不管 git 细节：commit message 怎么写 / 是否 squash / 多少个 commit 都不管）
2. agent 调 `cw wave execute` 时，**通过 stdin 传入 `{ executeResult: { commitHash: "<git-commit-hash>" } }`**（多 commit 时由 agent 自己选一个作为 wave 的代表 commit——通常是最后一个 / squashed 后的那个，agent 自负责选对）
3. cw 机器验证：`git cat-file -e <commitHash>` 验该 commit hash 在当前仓库真实存在（不存在则 execute fail，附 mustFix 提示 agent 重传存在的 hash）
4. cw 把 commitHash 记录到 `wave.executeResult.commitHash` 字段，execute 完成，进 test 阶段

**multi-commit 场景的 commitHash 归属**（wave 粒度 = 单 commit）：

wave 的粒度定义为「单次提交可完成」，所以 `commitHash` 是**单字段**（代表 commit）。如果 dev 在 wave 内做了多个 commit（如 TDD 的红 → 绿 → 重构三段式），agent 选最后一个（或 squash 后的那个）作为代表传给 cw，cw 验存在性并记录到 `wave.executeResult.commitHash`。中间 commit 保留在 git 历史里，**不进 wave 字段**——`commitHash` 单字段只装代表 commit。

如果需要严格追踪 wave 内每个 commit 的演进，应该**拆成多个 wave**（每个 wave 对应一个 commit），而不是在单 wave 里塞多 commit。这个取舍的理由：
- **简单**：单字段符合 wave「单次提交可完成」的粒度定义，不引入 `commitHashes: string[]` + representative 标记的复杂度
- **可追溯性不丢**：中间 commit 进 git 历史（`git log` 可查），不进 wave 字段不代表信息丢失，只是不进 cw 的结构化存储
- **和 WavePlan 一致**：WavePlan 的 tasks / files 都是「最终态」描述（task 清单 / 文件改动清单），execute 的 commitHash 也是「最终态」描述（代表 commit），不需要记录中间态

**为什么用 commit 存在性 + agent 传 hash 作为机制**：
- **机器可验**（诚实区分机器 vs 人，model 未直接给但与 guide 一致）：`git cat-file -e` 是 git 客观事实，cw 能机器验证（不像「代码写完了」这种主观声明）
- **不信任 agent 声明**：agent 不能只说「实现写完了」，必须传一个真实存在的 commit hash，cw 验存在性（防 agent 瞎址一个不存在的 hash）
- **对应 wave 粒度**：wave 的判据是「单次提交可完成」，commit 就是单次提交的物理体现
- **机制简单不依赖 message 约定**：不要求 commit message 含 wave id（那易伪造——agent 改一个标点 commit 一下就能过 gate），直接用 agent 显式传 hash + cw 验存在性

### 4.3 诚实说明（cw 验不了的）

cw 验「commit hash 真实存在」，但验不了：
- **这个 commit 的内容真的实现了 testCases**：commit 内容与 testCases 的一致性靠 test 阶段的机器验证（跑测试看 pass/fail，详见 §5）
- **agent 传的 hash 是不是真的 wave 的那个 commit**：agent 理论上传一个无关 commit 的 hash 也能过 commit-exists gate，但 test 阶段的 tests-all-pass gate 会扯出来——如果 commit 内容不对，测试会 fail

**wave 在 execute 阶段做什么**：写实现代码 + commit + 传 commitHash 给 cw。execute 完成后进 test 阶段（跑测试，机器验证）。

### 4.4 execute 阶段生成 WaveEvidence 的客观字段（evidence 跨阶段定位）

按 model §5.2 / §5.11，evidence 是**跨阶段产物**（不是 closeout 独占）——execute 完成时，cw 自动生成 WaveEvidence 的**客观字段**。这一步是 evidence 生命周期起点。

**execute 完成时 cw 自动填的 WaveEvidence 客观字段**（model §5.11）：

```typescript
// execute 完成时 cw 自动填的部分（主观字段此时还空，待 closeout 补）
interface WaveEvidence extends Evidence {
  commitHash: string;          // == executeResult.commitHash（cw 校验两者一致，防漂移）
  changedFiles: string[];      // 从 commit 提取的改动文件清单（git diff --name-only）
  generatedAt: string;         // execute 完成时间（ISO 8601，evidence 首次生成时间）

  testRunResult?: TestRunResult;   // 先空——test 阶段才填（见 §5.8）
  // 主观字段（summary / artifacts）此时还空，待 closeout 阶段 agent 补（见 §7.4）
  // frozenAt 此时还空，待 closeout 冻结（见 §7.4）
}
```

**字段填充规则**：
- **`commitHash`** = `executeResult.commitHash`——cw 校验两者一致（wave evidence 的 commitHash 必须等于 executeResult 的 commitHash，防止字段间漂移）
- **`changedFiles`**——cw 从 commit 提取（`git diff --name-only <parent> <commitHash>`），不靠 agent 声明
- **`generatedAt`**——cw 在 execute 完成时写入（ISO 8601）
- **`testRunResult` 此时为空**——test 还没跑，等 test 完成时再填（§5.8）
- **`summary` / `artifacts`（主观字段）此时为空**——待 closeout 阶段 agent 补充（§7.4）

**为什么 execute 阶段就开始生成 evidence**：evidence 不是「closeout 时一次性生成」，而是从 execute 起就逐步积累——这样 exec-review（§6）和 retrospect（§7）可以消费 evidence 的客观部分作为审查输入。evidence 此时是**活文档**（`frozenAt` 还空，允许后续阶段更新客观字段，如 test 阶段补 `testRunResult`）。

---

## 5. wave 的 test 阶段（跑测试 + testJudgment 验收，AC.verification 消费）

wave 的 test 阶段（model §2.2 第 6 步）是**整个 cw 唯一真正机器验证业务正确性的步骤**。前 3 层（PlanningUnit）没有 test 步骤——PlanningUnit 的验收在 retrospect 兼做（model §2.1）。wave 因为产出代码，必须独立验证代码**对不对**（业务正确性）。

### 5.1 机器验证机制（wave test 的灵魂，最核心的设计）

**核心问题**：怎么保证 wave 真的做完了？agent 可能声明「测试都过了」，cw 不能信任这个声明——agent 可能：
- 声明「测试过了」但实际没跑
- 跑了但只跑了部分 testCases
- 跑了但伪造测试结果

**机器验证的机制**（实跑测试，不信任 agent 声明）：

1. **cw 实跑测试**：cw 实际执行 wave 的测试代码（执行 testCases 对应的测试套件），拿到测试运行结果（pass / fail 数量 + 哪些 fail）。**cw 不读 agent 的声明，cw 自己跑**（沿用现有 cw 的测试运行能力，model §7.3）
2. **判 pass/fail**：cw 验所有非 manual testCases 的测试都 pass（fail 数 = 0）。任何 fail 则 test fail
3. **不信任 agent 声明**：agent 不能在 testJudgment 里只说「测试都过了」，cw 自己实跑验证

### 5.2 为什么 cw 不重算 expected（设计决策，诚实说明）

早期设计曾考虑「cw 从 slice 技术方案契约（SliceInterface/SliceDataModel/SliceErrorSpec）+ WaveTestCase input **重算** expected，对比 actual」。**这个机制不成立**，原因：

- slice 的 SliceErrorSpec 的 `scenario` / `strategy` 是自由文本（slice 层文档定义），cw 无法从「OAuth 返回 invalid_grant → 返回 401」这种自由文本语义地推导出结构化 expected（如 `{ status: 401, error: "INVALID_GRANT" }`）
- cw 是 agent-agnostic 工具，不做业务判断。「从自由文本契约翻译成可执行断言」是语义理解，越界
- expected 由 agent 在 WaveTestCase.expected 字段里自己写（agent 负责断言正确性），cw 只负责「跑测试看 pass/fail」——这才是机器能客观验证的部分

所以 wave test 的机器验证 = **cw 实跑测试 + 验全 pass**，不是「重算 expected 对比」。

### 5.3 AC.verification 字段消费（沿用现有能力，model §7.3）

feature 层的 AcceptanceCriterion（AC，model §5.7）带 `verification?: "unit" | "manual" | "review"` 字段（model §7.3 明确不改名）。wave 的 test 阶段消费这个字段：

| AC.verification | wave test 的处理 |
|---|---|
| `unit` | cw 实跑测试（机器验证）——这是默认场景，对应 WaveTestCase.type=unit/integration/e2e |
| `manual` | 退化为「cw 验 agent 填了 manual 验收记录 + commit 存在」——对应 WaveTestCase.type=manual，cw 不自动跑测试，诚实承认这是机器验证的边界 |
| `review` | 同 manual（review 也是人审，cw 不自动跑）——退化处理 |

**AC 和 WaveTestCase 的对应关系**：一个 wave 的 testCases 应该覆盖父 slice 继承下来的 AC（具体哪些 AC 由这个 wave 负责，靠 `basedOnParent` 声明继承的 AC id）。但**wave 文档不强制 WaveTestCase 加 linkedAcId 字段**做结构化 trace——AC 和 WaveTestCase 的对应关系通过 WaveTestCase.scenario 描述承载（自由文本，人审），避免引入 model §5 词表外的新字段。如果未来发现 traceability 问题严重，再考虑加结构化字段（YAGNI）。

### 5.4 testJudgment 完整结构（对照 designReviewJudgment 验收）

agent 把对照结论填入 `wave.testJudgment`。model §5.8 给了字段名（`necessityMet` / `sufficiencyMet` / `alternativesReconsidered` / `tradeoffCostRealized` / `riskOutcome`），wave 文档定稿完整结构：

```typescript
interface TestJudgment {
  // === 5 个对照 designReviewJudgment 的验收字段（model §5.8）===

  necessityMet: string;
  // 对照 designReviewJudgment.necessity，回判「这个 wave 对 slice 的贡献，testCases 真的验证了吗」
  // 如：wave 声称实现 SliceInterface IF1，testCases 真测了 IF1 的契约吗

  sufficiencyMet: SufficiencyMetResult;
  // 对照 designReviewJudgment.sufficiency，回判当初判断的覆盖 Gap / 重叠
  // manual 类 WaveTestCase 的验收记录归宿见下方说明（进 sufficiencyMet.note）

  alternativesReconsidered: string;
  // 对照 designReviewJudgment.alternatives，回判当初没选的替代覆盖策略，事后看应该选吗

  tradeoffCostRealized: TradeoffCostRealized[];
  // 对照 designReviewJudgment.tradeoffs 的每一条，机器 gate 验：每个 tradeoff id 都有一条对应记录
  // 如：当初妥协「网络超时不测了」，代价真的付出了吗（未测分支实际有 bug 吗）

  riskOutcome: RiskOutcome[];
  // 对照 designReviewJudgment.risks 的每一条，机器 gate 验：每个 risk id 都有一条对应记录
  // 如：当初标的 mock 失真风险，实际表现如何

  // 注意：testRunResult 不在 testJudgment 里——它属于 WaveEvidence（客观字段，model §5.11），
  // 在 test 完成时由 cw 自动填入 wave.evidence.testRunResult（见 §5.8）。testJudgment 不重复持有，
  // 避免同一份客观测试结果在两个地方维护导致漂移
}

interface SufficiencyMetResult {
  gapsConfirmed: string[];       // design-review 时判断的 Gap 真的漏了吗（每个 Gap 一条）
  gapsNewlyFound: string[];      // 实现时暴露的新 Gap（design-review 没发现的）
  overlapsConfirmed: string[];   // 当初判断的重叠实际发生了吗
  note?: string;                 // 自由文本。manual 类 WaveTestCase 的验收记录归宿在此（见 §5.8）
}

interface TradeoffCostRealized {
  tradeoffRef: string;           // 引用 designReviewJudgment.tradeoffs[i].id（机器验覆盖）
  costRealized: boolean;         // 代价真的付出了吗
  note?: string;
}

interface RiskOutcome {
  riskRef: string;               // 引用 designReviewJudgment.risks[i].id（机器验覆盖）
  outcome: "materialized" | "not-materialized" | "mitigated";
  note?: string;
}

// TestRunResult 类型定义见 model §5.11（共享类型，不在 wave 重定义）。wave 的 testRunResult 字段
// 挂在 WaveEvidence 上（不是 testJudgment），见 §5.8
```

**关键约束**：每个字段**必须对应 `designReviewJudgment` 的一项**——necessityMet 对 necessity、sufficiencyMet 对 sufficiency、alternativesReconsidered 对 alternatives、每个 tradeoff 有对应的 costRealized、每个 risk 有对应的 outcome。

**testRunResult 不在 testJudgment 里的理由**（model §1.4 / §5.11 已明确）：testRunResult 是 cw 实跑测试的**客观结果**（机器产出），属于 `WaveEvidence`（evidence 的客观部分）；而 testJudgment 是 agent 填的**对照判断**（主观验收）。两者性质不同——前者是客观事实（pass/fail 计数），后者是对 designReviewJudgment 的回判（业务对照）。把它们分开存储，让 evidence（客观）和 testJudgment（主观）各自单一来源，避免同一份测试结果在两处维护导致漂移。testJudgment 在做对照判断时可引用 evidence.testRunResult 提供的客观数据，但不在自己字段里重复持有。

### 5.5 机器 gate（wave test，整个 cw 唯一真正机器验业务正确性的 gate）

- **结构完整性**：
  - `commit-exists`：execute 阶段的 commit 仍在仓库里（机器验 `git cat-file -e <wave.executeResult.commitHash>`，详见 §4）
  - `test-cases-executed`：所有非 manual WaveTestCase 都真跑了（机器验测试运行记录）
- **`tests-all-pass`（核心机器 gate）**：cw 实跑 wave 的测试套件，验所有非 manual WaveTestCase 的测试都 pass（fail 数 = 0）。**这是整个 cw 唯一真正机器验证业务正确性的 gate**（PlanningUnit 没有这一步）
- **引用一致性**（诚实区分两类）：
  - **真引用一致（机器验 id 匹配）**：`testJudgment.tradeoffCostRealized` 里的 `tradeoffRef` 必须覆盖 `designReviewJudgment` 每个 tradeoff.id；`testJudgment.riskOutcome` 里的 `riskRef` 必须覆盖 `designReviewJudgment` 每个 risk.id——不漏验任何一条 tradeoff / risk
  - **只验非空（对应关系靠 agent 自检 + 人审）**：`necessityMet` / `sufficiencyMet` / `alternativesReconsidered` 是 string / 结构体，机器只验「填了」，内容是否真对应 designReviewJudgment 靠 agent 自检

### 5.6 机器验证的能力边界（诚实说明）

cw 能机器验证的部分：
- **测试真跑了 + 真全过了**：cw 实际执行测试代码，验 commit 后的代码状态真的让所有非 manual testCases pass（不是 agent 声明的，是 cw 自己跑出的结果）
- **commit 存在**：execute 阶段的实现代码确实 commit 了（机器验 commit hash 在仓库里存在）
- **testCases 都被执行**：cw 跑的测试套件覆盖了所有非 manual testCases（机器验测试运行记录）

cw 机器验不了的部分（诚实承认）：
- **expected 写得对不对**：WaveTestCase 的 expected 是 agent 自己写的断言，cw 不重算、不验对错——如果 agent 写了错的 expected 让测试「假绿」，cw 验不出（这是 agent 自审 + design-review 阶段 `tddRedReadinessNote` 人审的职责）
- **测试覆盖度**（这个 WaveTestCase 集合够不够）：机器验不了，靠 design-review 阶段的 `testCaseCoverageNote` / `boundaryConditionNote` 人审
- **测试代码本身的实现质量**（mock 是否失真、断言是否精确）：机器验不了，靠 design-review 阶段的 `tddRedReadinessNote` 人审

**诚实总结**：机器验证是机器验证业务正确性的「最大值」——cw 能验「测试真跑了 + 全 pass + commit 存在」，但验不了「测试覆盖度够不够 / expected 写得对不对」（后者靠 design-review 人审）。cw 保证 wave 不能「假声明」（cw 自己实跑验 pass，不是 agent 说过了），但不保证 wave「测得全 / 测得对」（覆盖度 + expected 正确性靠 agent 自审）。

### 5.7 如果没通过

- `tests-all-pass` fail（有测试 fail）→ 回 execute 修实现代码（实现没满足 WaveTestCase 的断言）
- `test-cases-executed` fail（测试没真跑）→ 回 execute 重跑 + commit
- 业务判断对照 fail（少见，design-review 已审过；真发生就走 §8 改 testCases 机制）

### 5.8 test 完成时补充 WaveEvidence.testRunResult（evidence 跨阶段续写）+ manual 验收记录归宿

**A2：test 完成时 cw 自动补充 evidence 客观字段**。按 model §5.2 / §5.11，execute 完成时 cw 已生成 WaveEvidence 的 commitHash / changedFiles / generatedAt（§4.4）。test 完成时 cw 继续补充**客观字段 `testRunResult`**：

```typescript
// test 完成时 cw 把机器实跑结果填入 wave.evidence.testRunResult
wave.evidence.testRunResult = {
  passed: boolean,              // 是否全部通过（对应 tests-all-pass gate 的结论）
  passedCount: number,          // 通过的用例数
  failedCount: number,          // 失败的用例数
  skippedCount?: number,        // 跳过的用例数（可选）
  durationMs?: number,          // 总耗时（毫秒，可选）
  runnerMode?: string,          // 触发模式（沿用 cw 0.x TestRunnerMode 命名）
  rawReportRef?: string;        // 原始报告文件路径 / URL（可选）
};                              // 完整 TestRunResult 类型定义见 model §5.11
```

**evidence 此时仍是「活文档」**（`frozenAt` 还空，允许后续阶段更新）：execute 生成客观部分（commitHash / changedFiles），test 续写客观部分（testRunResult），到 closeout 才冻结（§7.4）。evidence 不会被 test 的重跑覆盖（每次 test 重跑后 cw 更新 testRunResult 字段，旧值在 statusHistory / 原始报告里可追溯——append-only 原则体现在 statusHistory 的层面，evidence 字段值是「当前态」）。

---

**C1：manual 类 WaveTestCase 的验收记录归宿**（原 wave §5「待定」，现明确）。

manual 类 WaveTestCase（承接 feature AC 的 `verification=manual`，§5.3）cw 不自动跑测试，验收记录由 agent 人工填写。**归宿明确**：

| 验收产物 | 归宿 | 不进哪里 |
|---|---|---|
| manual 类 WaveTestCase 的验收记录 | `testJudgment.sufficiencyMet.note`（自由文本，agent 描述每个 manual 测试的人工验收结论）| **不进 `WaveEvidence.testRunResult`**——testRunResult 只装 cw 机器跑的结果，manual 不机器跑 |

**为什么进 `sufficiencyMet.note`**：manual 测试本质上是对「testCases 覆盖度是否充分」的人工补充判断——cw 跑不了 manual 测试，覆盖度的判断（manual 测试通过没、是否补齐了机器测不了的维度）由 agent 在 sufficiencyMet 里回答。`sufficiencyMet` 本身就是对照 designReviewJudgment.sufficiency 的覆盖度回判，manual 验收记录放它的 `note` 字段语义一致（note 本来就是补充说明）。

**为什么绝不进 `testRunResult`**：`testRunResult` 是 cw **机器实跑**的客观结果（pass/fail 计数 + runnerMode + rawReportRef），语义是「机器验证的事实」。manual 测试是 agent 人工判断，不是机器事实，混进 testRunResult 会破坏字段的客观性边界——agent 填的 manual 结论不该和 cw 实跑的 pass/fail 混在同一个结构里。

**机器 gate 对 manual 的处理**（§5.5 已述）：manual 测试不参与 `tests-all-pass` gate（cw 不跑它），但 `test-cases-executed` gate 要求 manual 测试在 `testJudgment.sufficiencyMet.note` 里有验收记录（机器验 note 非空，不验内容）——这是机器能验的边界（验「填了」，验不了「验收对不对」）。

---

## 6. wave 的 exec-review 阶段（execReviewJudgment 定稿）

wave 的 exec-review 阶段（model §2.2 第 7 步）是 v5 **新增的步骤**（v4 没有，只有 test）。这是 wave 区别于 PlanningUnit 的判别特征之一（model §0.1）。

**exec-review 审什么**：审**代码品味**——可读性 / 架构合理性 / 坏味道。代码已经 test 验证功能对了（test pass），但功能对不等于代码好——烂代码后期维护代价大、容易出 bug。exec-review 强迫 agent（或人）在写完代码后回头看「这代码写得好不好」。

**exec-review 和 design-review 的区别**（model §5.8 已强调）：
- design-review 审「执行前的方案」（necessity / sufficiency / alternatives / tradeoffs / risks），**执行前**
- exec-review 审「执行后的代码」（readability / architecture / codeSmells），**执行后**
- 两者维度完全不同，**不共享字段结构**，exec-review **不对照** design-review

**exec-review 和 test 的区别**：
- test 是**机器 gate**（tests-all-pass），审「功能对不对」
- exec-review 是**纯人审，无机器 gate，不阻塞 closeout**——overallVerdict="needs-followup" 也能进 retrospect 和 closeout（只是 followupActions 必须填）

### 6.0 exec-review 的三输入对照（evidence 是核心审查输入）

**exec-review 不是凭空审代码**——agent 在 exec-review 阶段**同时消费三类输入**做对照审查，缺一不可：

| 输入 | 来源 | 回答的问题 |
|---|---|---|
| ① `clarification + plan`（WavePlan）| clarify + plan 阶段产出 | **要做什么**——这个 wave 的测试契约（testCases）、执行步骤（tasks）、文件改动（files）、跨单元契约（contracts）是什么 |
| ② `designReviewJudgment` | design-review 阶段产出 | **期望什么**——执行前对测试覆盖度（sufficiency）、权衡（tradeoffs）、风险（risks）的判断；以及 testJudgment 对期望的回判结论 |
| ③ `WaveEvidence` | execute + test 阶段 cw 自动生成 | **实际做了什么**——commitHash（改了哪个 commit）、changedFiles（改了哪些文件）、testRunResult（测试跑得怎样）|

**三者对照才能审**（model §5.2 evidence 跨阶段定位的具体落地）：

- **evidence 绑定 plan**：
  - `evidence.changedFiles` 对照 `WavePlan.files`——实际改的文件和 plan 声明的文件改动清单对得上吗？有没有 plan 没提但实际改了的文件（scope 漂移）？有没有 plan 提了但实际没改的文件（漏改）？
  - `evidence.testRunResult` 对照 `WavePlan.testCases`——plan 的 testCases 都跑了吗（testRunResult 的覆盖数对照 testCases 数）？pass/fail 分布如何？
- **evidence 绑定 judgement**：
  - `evidence.testRunResult.passed` 对照 `testJudgment` 的结论——testJudgment 说「测试通过」，evidence.testRunResult 的 passed/failedCount 是否一致？testJudgment 在 sufficiencyMet 里的判断有 evidence 客观依据吗？

**为什么 exec-review 必须看 evidence 而不能只看代码**：只看代码（HEAD 的 diff）审品味是 v4 的做法——但那样审不到「实现和 plan 的偏离」（plan 说改 3 个文件，实际改了 5 个，单看代码看不出来）。evidence 的 changedFiles 让 exec-review 能审「实现是否忠实于 plan」，testRunResult 让 exec-review 能审「测试结果是否支撑了 testJudgment 的判断」。这是 v5 把 evidence 提前到 execute 生成、让 exec-review 能消费的设计目的（model §5.2）。

**exec-review 消费 evidence 的方式**：evidence 是**客观输入**（不进 execReviewJudgment 的字段结构——execReviewJudgment 字段都是 agent 主观判断）。agent 在审 readability/architecture/codeSmells 时，把 evidence 作为参考依据（如「changedFiles 超出 plan.files → 可能 scope 失控 → architecture 扣分」），但 evidence 本身不在 execReviewJudgment 里重复存储——evidence 单一来源在 `wave.evidence`，避免漂移。

### 6.1 execReviewJudgment 定稿结构

model §5.8 给的是提案，wave 文档评审定稿如下（**主要调整：readability/architecture 从可选改为必填**——每个 wave 的 exec-review 都要给分，否则 overallVerdict 无依据；codeSmells 可选保留；layerSpecific 给 wave 专属字段）：

```typescript
interface ExecReviewJudgment {
  // === 三大主维度（readability / architecture 必填，codeSmells 可选）===

  readability: { score: 1|2|3|4|5; issues?: string[] };
  // 可读性：命名 / 结构 / 注释合理性。必填——每个 wave 的 exec-review 都要给分
  // 分数锚点：1=极差（命名混乱/无结构）3=可接受但有明显问题 5=优秀（命名清晰/结构合理）

  architecture: { score: 1|2|3|4|5; issues?: string[] };
  // 架构合理性：职责归位 / 分层 / 依赖方向。必填——每个 wave 的 exec-review 都要给分
  // 分数锚点：1=极差（职责混乱/分层错误）3=可接受但有明显问题 5=优秀（职责清晰/分层合理）

  codeSmells?: { items: string[]; severity?: "low" | "medium" | "high" };
  // 坏味道清单：重复 / 过长函数 / 过深嵌套 / 魔法数字 等。可选——一个干净的 wave 可以没 smell
  // items 必填（和 model §5.8 提案一致）：填了 codeSmells 就必须列出具体的 smell 项，不能只打 severity 不给明细
  // severity 是所有 items 的整体严重度（最严重的那个决定）

  // === wave 层专属判断（layerSpecific 扩展点，model §5.8）===

  layerSpecific?: ExecReviewLayerSpecific;
  // wave 特有维度（详见 §6.2）

  // === 总判断 + 跟进（纯人审，不阻塞 closeout）===

  overallVerdict: "pass" | "needs-followup";
  // 总判断。pass = 代码品味可接受，不需跟进；needs-followup = 有问题需要后续 wave 跟进
  // **不阻塞 closeout**——needs-followup 也能进 retrospect / closeout，但 followupActions 必填

  followupActions?: FollowupAction[];
  // needs-followup 时必填（机器 gate 验非空）；pass 时建议留空
  // 跟进项的结构化记录（详见 §6.3）
}

interface ExecReviewLayerSpecific {
  testCodeQuality?: { score: 1|2|3|4|5; issues?: string[] };
  // wave 特有：测试代码质量。wave 是 TDD 层，测试代码占比大，测试本身的可读性 / 可维护性也该审
  // 测试代码和实现代码的可读性标准不完全一样（测试更看重 expressive / 不重复）

  mockFidelityNote?: string;
  // wave 特有：mock 失真风险回顾。test 阶段已跑通，但 mock 是否和真实行为一致需要事后看
  // 特别适用于 integration / e2e 类 testCases——test pass 不代表真实环境也对
}

interface FollowupAction {
  description: string;             // 跟进项描述（具体到「该改什么」）
  priority: "high" | "medium" | "low";
  targetScope: "current-wave-replan" | "next-wave" | "slice-level-refactor" | "adr-candidate";
  // 跟进项的去向：
  //   current-wave-replan: 本 wave 重做（少见，因为本 wave 已通过 test，重做代价大）
  //   next-wave: 进父 slice 的下一个 wave（最常见的跟进去向）
  //   slice-level-refactor: 触发 slice 级别的重构（影响多个 wave）
  //   adr-candidate: 重要架构决策，建议提炼成 ADR 跨 feature 复用
}
```

### 6.2 layerSpecific 的 wave 专属维度（设计理由）

为什么 wave 的 exec-review 需要在 layerSpecific 加 `testCodeQuality` 和 `mockFidelityNote`：

- **`testCodeQuality`**：wave 是 cw 唯一写代码的层，且 TDD 节奏下测试代码常常是主体（先写测试再写实现）。测试代码的质量（expressive / 不重复 / 一个测试只测一件事）直接影响后续维护。把测试代码质量单独审，避免它淹没在 readability 里（实现代码和测试代码的可读性标准不完全一样）。
- **`mockFidelityNote`**：wave 大量用 mock（unit/integration 测试），mock 是否失真只能在事后评估——test pass 不代表真实环境也对（mock 的 OAuth 提供商响应可能和真实 GitHub / Google 不一致）。这个维度让 agent 显式回看 mock 风险，承接 design-review 阶段 `mockStrategyNote` 的事后验证。

**为什么放在 layerSpecific 而不是主结构**：保持 execReviewJudgment 主结构跨层通用（未来如果有其他 ExecutionUnit 子类，主结构 3 维度够用）。wave 的专属维度进 layerSpecific，符合 model §5.8 的扩展点设计。

### 6.3 FollowupAction 的 targetScope 设计

`overallVerdict="needs-followup"` 时 followupActions 必填。targetScope 决定跟进项去向：

| targetScope | 去向 | 机制 |
|---|---|---|
| `current-wave-replan` | 本 wave 重做（少见）| 进本 wave 的 retrospect，标 `wrongJudgments`。因为本 wave 已通过 test，重做代价大，只用于严重质量问题 |
| `next-wave`（最常见）| 父 slice 的下一个 wave | cw 在父 slice 创建下一个 wave 时，提示 agent 参考（弱引导，不强制继承——execReviewJudgment 不阻塞 closeout，followupActions 是建议性的）|
| `slice-level-refactor` | 触发 slice 级重构 | 进父 slice 的 retrospect，slice 决定是否拆新 wave 做重构 |
| `adr-candidate` | 提炼成 ADR | 进本 wave retrospect 的 `lessonsLearned`，由后续 ADR 流程提炼（model §7.2「ADR 后续文档」）|

**关键约束**：followupActions 是**建议性的**，cw 不强制它们被执行。exec-review 不阻塞 closeout 的设计意图是——代码品味问题是「软」问题，不应该卡住已通过功能验证的 wave；但通过结构化记录 followupActions，让技术债可见、可追踪、可进后续 wave，而不是被遗忘。

### 6.4 overallVerdict 判定逻辑（agent 自判，不机器 gate）

agent 基于 3 主维度 + layerSpecific 自判 overallVerdict。**建议逻辑**（agent 可基于整体判断覆盖）：

- 任一主维度 score <= 2 → 建议 `needs-followup`
- `codeSmells.severity = "high"` → 建议 `needs-followup`
- 但 agent 可基于整体判断覆盖（如 score=2 但说明很轻微，或 high severity 是误判 → `pass`，agent 自负责）

**机器 gate 只验**：
- `readability` / `architecture` / `overallVerdict` 非空（必填字段）
- `overallVerdict = "needs-followup"` 时 `followupActions` 至少 1 条

**机器不验**：score 是否真的合理、issues 内容质量、followupActions 是否真的会被执行——都是人审职责。

### 6.5 诚实说明

exec-review 是纯人审——cw 定义存储结构（execReviewJudgment）+ guidance 提示 + 结构校验（必填字段非空），**业务判断内容由 agent 产出**。cw 验不了「代码真的可读 / 架构真的合理」，那是 agent（或人审）的职责。但通过强迫 agent 在 exec-review 显式打分 + 写 issues / followupActions，让代码品味问题**可见**——不能假装「写完代码就完事了」，必须回头看一眼。

**为什么 exec-review 不阻塞 closeout**（设计取舍）：
- wave 已通过 test（功能验证），代码是对的
- 代码品味问题是「软」问题，卡住 closeout 会让 wave 卡死（品味没有客观 pass 标准，人审容易争议）
- 不阻塞 + 结构化 followupActions，让技术债可见可追踪，比卡死更务实
- 如果 future 发现 followupActions 经常被忽视，可考虑升级为「needs-followup 时必须由人显式 accept 才能进 closeout」（YAGNI，当前不引入）

---

## 7. wave 的 retrospect

wave 的 retrospect（model §2.2 第 8 步）复盘 wave 层自己的事。和 PlanningUnit 的 retrospect 区别：**wave 的 retrospect 不兼验收**——验收已在 test（机器 gate）+ exec-review（人审）做完。retrospect 纯做经验提炼。

### 7.1 retrospectData 结构（用基类，不扩展；四个数组已结构化）

按 model §5.8，wave 的 retrospectData 用基类 `RetrospectData`（**不扩展** `PlanningRetrospectData`——那是 PlanningUnit 兼验收用的，wave 不需要）。**四个数组（wrongJudgments / badTradeoffs / missedGaps / processIssues）是结构化对象数组**（model §5.8 已定稿，让机器能验「指向」），不是 `string[]`。完整结构引用 model §5.8，这里复述便于阅读：

```typescript
interface RetrospectData {
  reviewedItems: ReviewedItem[];              // 逐项回顾（对照 designReviewJudgment + testJudgment + execReviewJudgment）
  lessonsLearned: string;                     // 必填，保留 string（经验提炼天生叙述性，不拆枚举）
  wrongJudgments?: WrongJudgment[];           // 结构化（model §5.8）：判错的判断，指向具体 judgmentRef
  badTradeoffs?: BadTradeoff[];               // 结构化（model §5.8）：代价超预期的 tradeoff，指向 tradeoffRef
  missedGaps?: MissedGap[];                   // 结构化（model §5.8）：漏掉的 MECE gap，指明在哪一步漏的
  processIssues?: ProcessIssue[];             // 结构化（model §5.8）：流程问题，指明类型
}

interface ReviewedItem {
  itemId: string;                    // judgment 里某条判断的 id（itemId 约定见下方）
  outcome: "fulfilled" | "partial" | "unfulfilled";
  note?: string;                     // 失败/部分达成的说明
}

interface WrongJudgment {
  judgmentRef: string;               // 指向 designReviewJudgment/testJudgment/execReviewJudgment 的某条 id（ref 约定见下方）
  whyWrong: string;                  // 为什么判错了
  whatActuallyHappened: string;      // 实际发生了什么
}

interface BadTradeoff {
  tradeoffRef: string;               // 指向 designReviewJudgment.tradeoffs 的某条 id
  costOverrun: string;               // 实际代价超过预期多少
  note?: string;
}

interface MissedGap {
  where: "clarify" | "plan" | "design-review" | "execute" | "test";  // 在哪一步漏的
  gap: string;                       // 漏了什么
}

interface ProcessIssue {
  type: "clarify" | "plan" | "split" | "replan" | "execute" | "test" | "review" | "other";
  issue: string;
}
```

**`itemId` / `judgmentRef` / `tradeoffRef` 的 ref 约定**（model §5.8 已明确，此处复述）：
- **裸字段**（necessity / sufficiency / alternatives / readability / architecture / overallVerdict 等）：ref = 字段名本身（如 `"necessity"`、`"readability"`）——这些是顶层单值判断，没有独立 id
- **数组元素**（tradeoffs / risks / testCases / tasks / files / contracts 等）：ref = 各自元素的 id（如 tradeoffs 的 `"TR1"`、testCases 的 `"TC1"`）

**为什么四个数组从 `string[]` 改为结构化对象数组**（model §5.8 已定稿）：让机器能验「指向」——`wrongJudgments[].judgmentRef` 指向具体哪条判断错了、`badTradeoffs[].tradeoffRef` 指向具体哪个 tradeoff 代价超预期、`missedGaps[].where` 指明在哪一步漏的、`processIssues[].type` 指明流程问题类型。机器 gate 能验 ref 合法性（指向的 id 真存在），而不是验不了指向的 `string[]`。`lessonsLearned` 保留 string——经验提炼天生叙述性，不拆成枚举字段。

wave 的 retrospect `wrongJudgments` 主要对照**三处**判断（model §5.8）：
1. `designReviewJudgment`（design-review 阶段的测试覆盖判断）
2. `testJudgment`（test 阶段的对照验收判断）
3. `execReviewJudgment`（exec-review 阶段的代码品味判断）

### 7.2 wave retrospect 要回答的问题

| 复盘维度 | wave 要回答的问题 |
|---|---|
| **判断错误（wrongJudgments）** | design-review 哪些测试覆盖判断错了？（标的高风险 mock 实际很稳、判断的 Gap 不存在、认为必要的 WaveTestCase 实际冗余）test 阶段的对照判断错了？exec-review 的品味判断错了？|
| **不良妥协（badTradeoffs）** | 哪些测试妥协事后看不值得？（如「网络超时不测」实际线上爆了、「这个边界 mock 太复杂跳过」实际是高频场景）|
| **遗漏的 Gap（missedGaps）** | design-review 没发现、test（机器验证）/ execute 才暴露的测试 Gap？为什么 design-review 没发现？|
| **流程问题（processIssues）** | testCases 写得好吗？（expected 不够精确 / 边界条件漏了 / mock 失真）；实现踩坑了吗？（哪个 WaveTestCase 的实现最难写，为什么）；slice 技术方案够清晰吗？（SliceInterface / SliceDataModel / SliceErrorSpec 模糊导致 expected 重算不出）；exec-review 的 followupActions 处理了吗？|
| **提炼经验（lessonsLearned）** | 下次写类似 wave 的 testCases / 实现代码，最该记住的 1-3 条经验？|

### 7.3 机器 gate

- `retrospectData.lessonsLearned` 非空（`lessons-learned-non-empty`）——**没有提炼出经验的 retrospect 是失败的 retrospect**
- `retrospectData.reviewedItems` 覆盖 designReviewJudgment + testJudgment + execReviewJudgment 的每一项（机器验覆盖，不验 verdict 对错）

**人审 gate**（机器验不了，诚实承认）：`reviewedItems` 的 `outcome` 和 `note` 的内容质量——机器只验「每项都有记录」，验不了「回顾得对不对、深不深」。

### 7.4 closeout：evidence 的主观补充 + drift 检查 + 冻结（evidence 生命周期终点）

wave 的 closeout（model §2.2 第 9 步）是 evidence 生命周期的终点。按 model §5.2 / §5.11.3，closeout 对 evidence 做 **3 件事**——前两件是 agent / cw 各做一件，第三件是冻结：

**closeout 时对 WaveEvidence 做的 3 件事**（model §5.11.3）：

1. **agent 补充 WaveEvidence 的主观字段**——填 `summary`（交付小结，1-2 句话）+ 确认 / 补充 `artifacts`（交付物引用清单，`ArtifactRef[]`）：
   ```typescript
   // agent 在 closeout 补充（见 model §5.11）
   wave.evidence.summary = "实现了 exchangeToken 接口 + TokenPair 类型 + 5 个单测全绿";
   wave.evidence.artifacts = [
     { kind: "code", ref: "src/oauth/token.ts", note: "exchangeToken 主实现" },
     { kind: "test", ref: "src/oauth/token.test.ts", note: "5 个 WaveTestCase 的实现" },
     { kind: "code", ref: "src/oauth/provider.ts", note: "OAuth 提供商封装" },
     // ArtifactRef.kind 枚举：spec | plan | review-report | retrospect-report | code | test | doc | other
   ];
   ```
   主观字段在 closeout 前都是空的（execute/test 阶段 cw 只填客观部分），closeout 时 agent 才补。

2. **cw 校验 artifacts 文件存在性**（drift 检查）——逐条验 `artifacts[].ref` 指向的文件当前还存在（沿用 cw 0.x 的 artifacts-exist gate）。校验失败 → closeout 被拒，agent 必须修正 artifacts（删掉不存在的引用 / 补回文件）。防 plan 里说要交付 `src/auth.ts`，到 closeout 时该文件却被删 / 改名 / 没建。

3. **cw 冻结 evidence + status → closed**——cw 写 `frozenAt`（ISO 8601 时间戳，evidence 从此不再变），status 从 `retrospected` 推进到 `closed`（不可逆）。

**evidence 跨阶段生命周期总结**（model §5.2 的 wave 具体化）：

| 阶段 | evidence 操作 | 操作者 |
|---|---|---|
| execute 完成 | 生成客观字段：commitHash + changedFiles + generatedAt | cw 自动 |
| test 完成 | 补充客观字段：testRunResult | cw 自动 |
| exec-review | **消费** evidence（和 clarification+plan、designReviewJudgment/testJudgment 一起）作为审查输入 | agent 读 |
| retrospect | **消费** evidence 作为复盘输入（可选，retrospectData 引用 evidence 客观数据）| agent 读 |
| closeout | ① agent 补主观（summary + artifacts）② cw 验 artifacts drift ③ cw 冻结（frozenAt）+ status → closed | agent + cw |

**`frozenAt` 替代 cw 0.x 的 `closedAt`**（model §5.11 已明确）：`frozenAt` 语义明确（evidence 冻结时点）——空 = 未 closeout（evidence 还是活文档，允许客观字段更新）；非空 = 已冻结不再变。status 是否为 `closed` 由 `frozenAt` + `status` 两个字段一起表达，避免单一 `closedAt` 既要表达「冻结」又要表达「状态」的语义混淆。

**注意**：客观部分（commitHash / changedFiles / testRunResult）在 closeout 之前就已经由 cw 填好（execute/test 完成时），**closeout 不重新生成客观部分**——只补主观 + 验 drift + 冻结。这是 evidence 跨阶段定位的核心（model §5.2）：不是「closeout 一次性生成」，而是「execute+test 逐步积累客观 → closeout 补主观 + 冻结」。

---

## 8. wave 的 replan（承受者 + 叶子发起者）

v5 的 replan 机制是 **abort + appendOnly**（model §5.6）：上层 replan 废弃条目 → cw 自动计算影响面 → 级联 abort 受影响子孙 → 返回给 agent → agent 通过 `cw create` 重建。wave 在这个机制下有**两个角色**：

- **承受者**：上游 slice replan 废弃 SliceTechChoice / SliceInterface / SliceDataModel / SliceErrorSpec → cw 检测 wave.basedOnParent 命中废弃条目 → wave 被 abort（cw 只标 status=aborted，不动 git，commitHash 保留为历史）
- **叶子发起者**：wave 自己 replan 废弃自己的 WaveTestCase / WaveTask / WaveFile / WaveContract——wave 是叶子，**没有下层**，影响面计算结果恒为空（无下游级联），replan 只影响 wave 自己

**关键约束（用户决策）**：wave replan 改完 WavePlan 条目后，**必须重新 design-review**——回到 planning 状态重走 design-review → execute → test → exec-review → retrospect → closeout。designReviewJudgment 必须刷新匹配新 plan，不能让旧判断覆盖新条目。

### 8.1 wave 自己 replan（叶子发起者）

wave 是叶子（无 childUnitIds，model §1.2），plan 条目是 WaveTestCase / WaveTask / WaveFile / WaveContract。wave replan 时废弃 / 新增这些条目：

```
触发: cw replan <waveId> -- "废弃/新增条目的描述"

Step 1 [本地变更]: wave 本地处理 replan
  - 废弃的条目 → status="abandoned"（append-only，保历史）
  - 新增的条目 → status="active"，id 新分配
  - wave status 不变（replan 是旁路 action，不改 status）
  - 所有变更 append 到条目记录 / statusHistory，永不重写

Step 2 [影响面计算]: cw 遍历 wave 的子孙
  - wave 是叶子，无 childUnitIds → 影响面恒为空
  - 无级联 abort 发生

Step 3 [返回给 agent]:
  replan result:
    aborted: []               // wave 是叶子，无受影响子孙
    preserved: []             // 同上
    pendingRebuild:           // 提示 agent 本 wave 的 plan 已变
      - "本 wave 已改 testCases/tasks/files/contracts，需重新 design-review"
```

**wave replan 和 plan progressive 的区别**：

| 场景 | 路径 | 用法 |
|---|---|---|
| wave 还在 planning（未 design-reviewed）调整条目 | `plan` progressive（多次写）| 正常 progressive 语义，条目可多次重写，不需要 replan |
| wave 已 design-reviewed / 已执行后**正式废弃条目**（标 abandoned、保历史）| `replan` | wave 自己 replan，废弃的条目 status=abandoned，append-only 留演进历史 |

**plan progressive 用于「未定稿前的反复打磨」（条目直接改写），replan 用于「定稿后的正式废弃」（条目标 abandoned 保历史）**。设计-review 前的调整走 progressive，design-review 后的变更走 replan。这两条路径都**不触发影响面传播**（wave 是叶子）。

### 8.2 wave 承受上游 slice replan（被 abort）

这是 wave 的「承受」场景：slice replan 废弃 SliceTechChoice / SliceInterface / SliceDataModel / SliceErrorSpec → cw 检测到某 wave 的 basedOnParent 含已废弃条目 → cw 自动把该 wave status 标为 aborted，并在 wave.abandonedRefs 追加 `{ workUnitItemId, abandonedAt }`（model §5.6）。

**机制**（model §5.6.2 Step 3 的 wave 体现）：

- cw 只改 wave status=aborted，**不动 git**——已 execute 过的 wave 的 commitHash 保留为 git 历史（append-only，符合「commitHash 保留为历史」）
- abandonedRefs 是**纯历史记录**（workUnitItemId + abandonedAt 两字段），不阻塞任何流程——cw 已直接 abort，没有「待处理 → 已处理」中间态（model §5.6.5 删掉了 resolvedAt / resolvedAction）
- basedOnParent **不动**（创建时的历史快照，append-only 永不重写，model §4.2）

**已 closeout 的 wave**（边界场景）：slice replan 时如果某个 wave 已 closed（真终态），cw 仍按机制标 aborted（model §5.6 的级联 abort 包括已 closed 的子孙）——但 git commit 不删，commitHash 保留为历史。真要跟进新决策由 agent 通过 `cw create` 建新 wave 重做（不是「原 wave 复活」）。

### 8.3 wave replan 后必须重新 design-review（用户决策）

**硬约束**：wave 用 replan 改了 WavePlan 条目（无论废弃 / 新增）后，**必须回到 planning 状态重新走 design-review**，刷新 designReviewJudgment 匹配新 plan。理由：

- designReviewJudgment 的 sufficiency（gaps / overlaps / meceNote）、risks、tradeoffs 是**针对当前 testCases / tasks / files / contracts 集合**做的判断——条目一变，判断就失效，必须重审
- WaveTestCase 变了，下游 test 阶段的 testJudgment 对照基准也变（testJudgment 逐条对照 designReviewJudgment，见 §5.4）——不重审 design-review 会导致 testJudgment 对照一个过时的基准
- tddRedReadinessNote（design-review layerSpecific，§3）必须在新的 testCases 集合上重判「TDD 红灯就绪」

**replan 后的完整路径**：

```
wave（已 design-reviewed / executing / tested / ...）
  ↓ cw replan（改 testCases / tasks / files / contracts）
wave（status 不变，但 plan 已变）
  ↓ 回退到 planning（designReviewJudgment 标记为待刷新）
  ↓ plan progressive（确认新 plan 定稿）
  ↓ design-review（重审，刷新 designReviewJudgment）
  ↓ execute（重新写代码，产生新 commitHash）
  ↓ test（重新跑测试，刷新 testJudgment + testRunResult）
  ↓ exec-review（重审新代码，刷新 execReviewJudgment）
  ↓ retrospect → closeout
```

### 8.4 wave 的 executeResult.commitHash 在 replan 后（append-only）

wave replan 后重新 execute 会产生**新的 commitHash**：

- 旧的 commitHash **不删、不改**——保留在 statusHistory / git 历史里（append-only 原则，model §5.6）
- `wave.executeResult.commitHash` 字段记录**最新一次** execute 的代表 commit（agent 在重新 execute 后传新 hash，cw 验存在并覆盖字段值——字段值更新，但旧值在 statusHistory 里可追溯）
- cw 不管 git 细节（多 commit 时 agent 选哪个作为代表，详见 §4.2），只验「传进来的 hash 在仓库真实存在」

**为什么旧 commitHash 不删**：replan 是「废弃 + 重建」不是「擦除」——旧实现即使不再用，也是 wave 的演进历史，服务 retrospect（回顾条目怎么演进的）和 evidence（最终交付包含完整轨迹）。这和 PlanningUnit 废弃条目时标 abandoned 而不是删除，是同一个 append-only 原则。

### 8.5 wave 对状态机的特化（呼应 model §3.4）

wave 对状态机有两个特化点（model §3.4 已收录，本文是 wave 侧的展开说明）。**两条特化只适用于 ExecutionUnit（wave）**，PlanningUnit（epic/feature/slice）的 `plan` / `replan` 仍按通用规则（PlanningUnit 的 replan 不在执行后触发——PlanningUnit 没有 execute 产代码这一步，retrospect 发现的问题走重建下层而非 replan 本层）。

**特化 1：`plan` action 的 from 状态集**：

wave 对状态机的特化点：**`plan` 的 from 加 `design-reviewed`**（不含 executing / tested / exec-reviewed 等更后状态）。

- **前 3 层（PlanningUnit）的 plan from**：`["clarifying", "planning"]`（model 暗含，PlanningUnit 的 plan progressive 只在规划期允许）
- **wave 的 plan from**：`["clarifying", "planning", "design-reviewed"]`

**为什么 wave 要特化**：design-review 后、execute 前如果发现 expected 写错或遗漏边界条件，可以在 design-reviewed 状态调 plan progressive 重写 testCases，再重走 design-review 刷新判断（§8.3）。

**为什么不含 executing**：executing 是 dev 写代码阶段，testCases 已定稿。真发现 testCases 要改说明 design-review 没审好，应该走 §8.1 的 replan（废弃旧条目 + 重新 design-review，§8.3），不是在 executing 原地改 plan。这避免了「executing 状态改 testCases 后 designReviewJudgment 失效但没刷新」的状态机死锁。

**特化 2：`replan` action 的 from 状态集**（model §3.4 已明确）：

- **通用规则**（model §3.3 旁路）：`replan` 在「任何状态」都可触发（不改 status）
- **wave 特化**：wave 的 `replan` 允许 from 状态集显式包含 `design-reviewed` / `executing` / `tested` / `exec-reviewed` / `retrospected`——即 wave 在执行后（甚至已经测试 / 审查 / 复盘后）发现需要 replan 时，允许触发 replan（status 不变，但 append 一条 StatusChange 到 statusHistory，model §4.4.1）。触发后 cw 按 model §5.6 的 abort + appendOnly 机制处理下游影响面（wave 没有下游，所以主要是更新 wave 自己的 plan + 中和相关 judgment 的有效性）

两条特化的 from 状态集在附录 §9 WAVE_TRANSITIONS 里完整声明（`plan.from` 和 `replan.from`），和 model §3.4 完全一致。

### 8.6 wave 的 replan 角色（和 PlanningUnit 的对比）

| 层 | replan 角色 | 影响面 |
|---|---|---|
| epic | 纯发起者（顶层，basedOnParent 永远为空）| 大（级联 feature / slice / wave）|
| feature / slice | 双向（既发起标下游，又承受上游标记）| 中（级联到下层子孙）|
| **wave** | **承受者 + 叶子发起者** | **空**（叶子，无下游级联；自己 replan 只影响自己，承受上游 replan 时被 abort）|

**wave 是 DAG 的叶子节点**——replan 影响面传播到 wave 为止（不再往下传，没下游了）。这是 wave 区别于 PlanningUnit 的重要特性：PlanningUnit 的 replan 有级联下游的语义，wave 的 replan 是「自闭环」（改自己的 WavePlan + 重新 design-review）。

---

## 9. 未定项（本层相关）

引用 model §7 的未定项中，和 wave 层相关的部分：

### 9.1 execReviewJudgment + testJudgment 字段结构（本文已定稿）

**testJudgment 完整结构（本文 §5.4 已定稿）**：model §5.8 给了 5 个对照字段名（`necessityMet` / `sufficiencyMet` / `alternativesReconsidered` / `tradeoffCostRealized` / `riskOutcome`），wave 文档在 §5.4 定稿完整结构——5 个对照 `designReviewJudgment` 的验收字段。**注意 `testRunResult` 不在 testJudgment 里**——它属于 `WaveEvidence`（客观字段，test 完成时 cw 自动填入 `wave.evidence.testRunResult`，见 §5.8 + model §5.11），避免客观结果和主观判断同处维护导致漂移。配套结构体 `SufficiencyMetResult` / `TradeoffCostRealized` / `RiskOutcome` 同步定稿；`TestRunResult` 类型引用 model §5.11（不在 wave 重定义）。机器 gate 验 `tradeoffCostRealized.tradeoffRef` 覆盖每个 `tradeoff.id`、`riskOutcome.riskRef` 覆盖每个 `risk.id`（逐条对照，详见 §5.5）。manual 类 WaveTestCase 的验收记录归宿在 `testJudgment.sufficiencyMet.note`（不进 testRunResult，见 §5.8）。

**execReviewJudgment（本文 §6 已定稿）**：model §7.1 标「已提案，待确认」——**本文 §6 已定稿**。主要调整：
- readability / architecture 从可选改为**必填**（每个 wave 的 exec-review 都要给分）
- codeSmells 保持可选（一个干净的 wave 可以没 smell）
- 新增 `FollowupAction` 结构化（含 `priority` + `targetScope`），取代 model §5.8 提案的 `followupActions?: string[]`
- wave 层专属判断（testCodeQuality / mockFidelityNote）进 `layerSpecific`

**建议 model §7.1 同步更新状态为「已在 wave 文档定稿」**。

### 9.2 沿用现有能力（model §7.3，不在本文设计）

| 项 | 说明 |
|---|---|
| wave 测试套件发现机制 | 沿用当前 cw 的测试运行能力（TestRunnerMode 支持多语言 + 断言 + 脚本），不自己设计 |
| wave commitHash 关联机制 | 单 commit 已定（agent stdin 传 hash + cw 验 `git cat-file -e` 存在性，详见 §4）；multi-commit 归属已定（wave 粒度 = 单 commit，agent 选代表 commit 传入，详见 §4.2）|
| AC.verification 字段 | 保持不变（不改名，verify 步骤已改名为 design-review，不再混淆）。消费场景见 §5.3 |

### 9.3 后续文档会展开的内容

| 内容 | 何时讲 |
|---|---|
| claim 文档（多 agent 并行时，避免两个人同时做同一个 wave）| claim 文档 |
| research 服务（Clarification type=research 时调外部查询）| research 文档（model §7.2）|
| ADR 文档（execReviewJudgment 的 followupActions targetScope=adr-candidate 进 ADR 流程）| ADR 文档（model §7.2）|
| 机器验证的实现细节（cw 如何发现并执行 wave 测试套件、cw 从 commit 提取 changedFiles 的具体机制）| 实现侧文档（设计层面本文 §4/§5 已讲透机制和能力边界；commitHash 多 commit 归属见 §4.2，manual 验收记录归宿见 §5.8）|

### 9.4 待后续验证的设计点（诚实标注）

- **FollowupAction 的实际去向机制**：`targetScope=next-wave` 时 cw 如何提示父 slice 的下一个 wave 参考？目前设计是「弱引导」（cw 在 next wave 创建时把 followupActions 放进提示，agent 自决定是否处理）。如果未来发现 followupActions 经常被忽视，可考虑升级为强引导（如必须显式 accept/reject）。需要实际使用后验证。
- **execReviewJudgment 不阻塞 closeout 的实际效果**：当前设计是 needs-followup 也能 closeout。如果未来发现技术债积累严重，可考虑引入「needs-followup 时必须由人显式 accept 才能进 closeout」。需要实际使用后验证。
- **AC 和 WaveTestCase 的 traceability**：本文 §5.3 决定不加结构化字段（linkedAcId），靠 scenario 自由文本承载。如果未来发现 traceability 问题严重，再考虑加结构化字段。

---

## 附录 A. 完整 TS 接口（wave 层涉及的全部）

集中 model §1.3 / §4 / §5 / §6 里 wave 层涉及的接口，方便实现参考。基础类型（WorkUnitItem / Plan / Split / Clarification / Decision / AbandonedRef / ExecuteResult / DesignReviewJudgment 核心字段）定义在 model 文档，本文不重复声明。

```typescript
// ═══════════════════════════════════════════════════════════════
// 1. WorkUnit 子类（model §1.3）
// ═══════════════════════════════════════════════════════════════

interface ExecutionUnit extends WorkUnit {
  scope: "wave";
  status: ExecutionStatus;                     // 10 状态，见 model §3.2
  executeResult: ExecutionExecuteResult;       // { commitHash }（详见 §4）
  testJudgment: TestJudgment;                  // test 阶段（详见 §5）
  execReviewJudgment: ExecReviewJudgment;      // exec-review 阶段（详见 §6）
  evidence: WaveEvidence;                      // 跨阶段产物：客观部分（commitHash/changedFiles/testRunResult）cw 自动填，
                                               // 主观部分（summary/artifacts）agent 在 closeout 补，frozenAt 在 closeout 冻结
                                               // 完整类型见 model §5.11 + 本文 §4.4/§5.8/§7.4
}

// ExecutionStatus（10 状态）：
// "created" | "clarifying" | "planning" | "design-reviewed"
// | "executing" | "tested" | "exec-reviewed" | "retrospected" | "closed" | "aborted"

// StatusChange 类型（statusHistory 元素）见 model §4.4——append-only 的「所有变更」流，
// 含 from/to/at/action/note。replan 不改 status 但 append 一条（from=to，action="replan"，见 model §4.4.1）

// ═══════════════════════════════════════════════════════════════
// 2. execute 产物（model §2.5）
// ═══════════════════════════════════════════════════════════════

interface ExecutionExecuteResult extends ExecuteResult {
  commitHash: string;              // dev 写完代码后的 commit hash（cw 验存在性）
}

// ═══════════════════════════════════════════════════════════════
// 2b. WaveEvidence（model §5.11，跨阶段产物）
// ═══════════════════════════════════════════════════════════════

// 完整定义见 model §5.11（不在 wave 重定义，避免漂移）。这里给出字段概览供实现参考：
//
// interface WaveEvidence extends Evidence {                 // Evidence 基类见 model §5.11
//   // === 客观部分（cw 自动填）===
//   generatedAt: string;           // execute 完成时间（evidence 首次生成）—— 继承自 Evidence
//   commitHash: string;            // == executeResult.commitHash（cw 校验一致），execute 时填
//   changedFiles: string[];        // 从 commit 提取，execute 时填
//   testRunResult?: TestRunResult; // test 完成时填（无 test 则空），类型见 model §5.11
//
//   // === 主观部分（agent 在 closeout 补）===
//   summary?: string;              // 交付小结 —— 继承自 Evidence
//   artifacts: ArtifactRef[];      // 交付物引用清单 —— 继承自 Evidence（ArtifactRef.kind 枚举，见 model §5.11）
//
//   // === 冻结标记（closeout 时填）===
//   frozenAt?: string;             // closeout 冻结时间（空=未 closeout）—— 继承自 Evidence
// }
//
// 生命周期见本文 §4.4（execute 生成客观）/ §5.8（test 补 testRunResult）/ §7.4（closeout 补主观 + drift + 冻结）

// ═══════════════════════════════════════════════════════════════
// 3. WavePlan（model §4.3）
// ═══════════════════════════════════════════════════════════════

interface WavePlan extends Plan {
  // 继承自 Plan：split: Split[]（wave 是叶子，cw 自动填 []，结构兼容 WorkUnit.plan）
  testCases: WaveTestCase[];
  tasks: WaveTask[];
  files: WaveFile[];
  contracts: WaveContract[];
}

// ═══════════════════════════════════════════════════════════════
// 4. WavePlan 的 4 个条目类型（都 extends WorkUnitItem，model §4.1 / §5.7）
// ═══════════════════════════════════════════════════════════════

interface WaveTestCase extends WorkUnitItem {
  // 继承自 WorkUnitItem：id / status: "active"|"abandoned"
  name: string;
  scenario: string;
  input: string;
  expected: string;
  type: "unit" | "integration" | "e2e" | "manual";
}

interface WaveTask extends WorkUnitItem {
  // 继承自 WorkUnitItem：id / status: "active"|"abandoned"
  type: "impl" | "refactor" | "test" | "fix" | "doc" | "other";   // 枚举化（详见 §2.3）
  files: string[];
  steps: string[];
  dependsOn?: string[];
}

interface WaveFile extends WorkUnitItem {
  // 继承自 WorkUnitItem：id / status: "active"|"abandoned"
  path: string;
  action: "create" | "modify" | "delete";
  description: string;
}

interface WaveContract extends WorkUnitItem {
  // 继承自 WorkUnitItem：id / status: "active"|"abandoned"
  name: string;
  type: "function" | "api" | "class" | "event" | "schema" | "other";   // 枚举化（详见 §2.5）
  definition: string;
  // 不设 consumers 字段——跨单元引用走 basedOnParent 反查（详见 §2.5 / model §5.6）
}

// ═══════════════════════════════════════════════════════════════
// 5. testJudgment（model §5.8 字段名，本文 §5.4 定稿完整结构）
// ═══════════════════════════════════════════════════════════════

interface TestJudgment {
  necessityMet: string;
  sufficiencyMet: SufficiencyMetResult;        // manual 类 WaveTestCase 的验收记录进 sufficiencyMet.note（见 §5.8）
  alternativesReconsidered: string;
  tradeoffCostRealized: TradeoffCostRealized[];
  riskOutcome: RiskOutcome[];
  // 注意：testRunResult 不在 testJudgment 里——它属于 WaveEvidence（见 §5.4/§5.8 + model §5.11）
}

interface SufficiencyMetResult {
  gapsConfirmed: string[];
  gapsNewlyFound: string[];
  overlapsConfirmed: string[];
  note?: string;                // manual 类 WaveTestCase 的验收记录归宿在此（见 §5.8）
}

interface TradeoffCostRealized {
  tradeoffRef: string;           // 引用 designReviewJudgment.tradeoffs[i].id
  costRealized: boolean;
  note?: string;
}

interface RiskOutcome {
  riskRef: string;               // 引用 designReviewJudgment.risks[i].id
  outcome: "materialized" | "not-materialized" | "mitigated";
  note?: string;
}

// TestRunResult 类型定义见 model §5.11（共享类型，不在 wave 重定义）。
// wave 的 testRunResult 字段挂在 WaveEvidence 上（不是 testJudgment），见下方 WaveEvidence 定义。

// ═══════════════════════════════════════════════════════════════
// 6. execReviewJudgment（model §5.8 提案，本文 §6 定稿）
// ═══════════════════════════════════════════════════════════════

interface ExecReviewJudgment {
  readability: { score: 1|2|3|4|5; issues?: string[] };
  architecture: { score: 1|2|3|4|5; issues?: string[] };
  codeSmells?: { items: string[]; severity?: "low"|"medium"|"high" };
  layerSpecific?: ExecReviewLayerSpecific;
  overallVerdict: "pass" | "needs-followup";
  followupActions?: FollowupAction[];
}

interface ExecReviewLayerSpecific {
  testCodeQuality?: { score: 1|2|3|4|5; issues?: string[] };
  mockFidelityNote?: string;
}

interface FollowupAction {
  description: string;
  priority: "high" | "medium" | "low";
  targetScope: "current-wave-replan" | "next-wave" | "slice-level-refactor" | "adr-candidate";
}

// ═══════════════════════════════════════════════════════════════
// 7. retrospectData（model §5.8 基类，wave 不扩展；四数组已结构化）
// ═══════════════════════════════════════════════════════════════

// wave 用基类 RetrospectData（不扩展 PlanningRetrospectData）。
// reviewedItems.itemId 对照 designReviewJudgment + testJudgment + execReviewJudgment 三处（ref 约定见 model §5.8）。
// 四数组（wrongJudgments/badTradeoffs/missedGaps/processIssues）是结构化对象数组（不是 string[]），
// 完整结构（WrongJudgment/BadTradeoff/MissedGap/ProcessIssue）详见 model §5.8 + 本文 §7.1。
// lessonsLearned 保留 string（经验提炼天生叙述性）。
//
// 概览（完整字段定义引用 model §5.8）：
//
// interface RetrospectData {
//   reviewedItems: ReviewedItem[];
//   lessonsLearned: string;                     // 必填，保留 string
//   wrongJudgments?: WrongJudgment[];           // { judgmentRef, whyWrong, whatActuallyHappened }
//   badTradeoffs?: BadTradeoff[];               // { tradeoffRef, costOverrun, note? }
//   missedGaps?: MissedGap[];                   // { where: "clarify"|..., gap }
//   processIssues?: ProcessIssue[];             // { type: "clarify"|..., issue }
// }
//
// interface ReviewedItem {
//   itemId: string;                             // 裸字段→字段名；数组元素→元素 id（model §5.8 约定）
//   outcome: "fulfilled" | "partial" | "unfulfilled";
//   note?: string;
// }

// ═══════════════════════════════════════════════════════════════
// 8. designReviewJudgment.layerSpecific 的 wave 具名 interface（model §5.8 具名化约定）
// ═══════════════════════════════════════════════════════════════

// designReviewJudgment 主结构（necessity/sufficiency/alternatives/tradeoffs/risks）见 model §5.8，本文不重复。
// wave 的 designReviewJudgment.layerSpecific 收紧为具名 interface WaveDesignReviewLayerSpecific（见 §3）：
//
// interface WaveDesignReviewLayerSpecific {
//   testCaseCoverageNote?: string;     // testCases 对 slice 技术方案的覆盖度自检
//   boundaryConditionNote?: string;    // 边界条件覆盖自检
//   mockStrategyNote?: string;         // mock 策略合理性自检
//   tddRedReadinessNote?: string;      // TDD 红灯就绪自检
// }
//
// 所有字段都是 string，满足 model §5.8 的下界 `Record<string, string>`。
// machine gate 对 layerSpecific 只验非空（不验内容）。

// ═══════════════════════════════════════════════════════════════
// 9. wave 状态机 transitions（model §3 基础上的特化，详见 §8.5）
// ═══════════════════════════════════════════════════════════════

const WAVE_TRANSITIONS = {
  create:         { from: [],                                                              to: "created" },
  clarify:        { from: ["created", "clarifying"],                                       to: "clarifying",    progressive: true },
  // ⚠️ wave 特化点：plan 的 from 加 design-reviewed（不含 executing）
  // 原因：wave 是叶子改 testCases 没下游影响面，允许 plan 在 design-reviewed 回流改 testCases（详见 §8.5）
  // 不含 executing：避免 executing 状态改 testCases 后 designReviewJudgment 失效的死锁
  plan:           { from: ["clarifying", "planning", "design-reviewed"],                   to: "planning",      progressive: true },
  "design-review":{ from: ["planning", "design-reviewed"],                                 to: "design-reviewed", progressive: true },
  execute:        { from: ["design-reviewed"],                                             to: "executing" },
  test:           { from: ["executing"],                                                   to: "tested" },
  "exec-review":  { from: ["tested"],                                                      to: "exec-reviewed" },
  retrospect:     { from: ["exec-reviewed"],                                               to: "retrospected" },
  closeout:       { from: ["retrospected"],                                                to: "closed" },
  abort:          { from: ["created", "clarifying", "planning", "design-reviewed", "executing", "tested", "exec-reviewed", "retrospected"], to: "aborted" },
  // 注：wave 是叶子，无子孙可销毁（abort 只销毁 wave 自己，代码不删——cw 不管 git，commit 留 git，新 wave 可参考）

  // replan：wave 可调（改自己的 WavePlan 条目：废弃/新增 WaveTestCase/WaveTask/WaveFile/WaveContract）
  // wave 是叶子（无 childUnitIds），影响面计算结果恒为空——replan 只影响 wave 自己，无下游级联
  // 从 design-reviewed 及之后都可调（design-review 前的调整走 plan progressive，见 §8.1 对比表）
  // replan 后 agent 必须回到 planning 重新 design-review（刷新 designReviewJudgment 匹配新 plan，§8.3）
  // status 不变（replan 是旁路 action）
  replan:         { from: ["design-reviewed", "executing", "tested", "exec-reviewed", "retrospected"], to: undefined /* 原地 */, progressive: true, triggersImpactPropagation: true /* wave 叶子，影响面恒为空 */ },

  // 注：v5 已废弃 accept-replan action（model §5.6.5）——cw 在上游 replan 时直接 abort 受影响子孙，
  // 无「待处理 → 已处理」中间态，accept-replan 无职责。wave 承受上游 slice replan 时被 cw 直接标 aborted
  // （abandonedRefs 追加 {workUnitItemId, abandonedAt}，纯历史记录），不需要 wave 侧确认。
};

// ═══════════════════════════════════════════════════════════════
// 10. stdin 输入数据类型
// ═══════════════════════════════════════════════════════════════

interface ClarifyInput {
  clarifications: Clarification[];
}

interface PlanInput {
  testCases: WaveTestCase[];
  tasks: WaveTask[];
  files: WaveFile[];
  contracts: WaveContract[];
  // 注意：wave plan 无 split 输入（wave 是叶子，cw 自动填 [] 到 WavePlan.split）
}

interface ExecuteInput {
  executeResult: {
    commitHash: string;   // agent 自行 git commit 后传 hash，cw 验存在（git cat-file -e）
  };
}

// design-review / test / exec-review / retrospect 的输入对应各 judgment 结构，不单独声明

// ═══════════════════════════════════════════════════════════════
// 11. wave 的 gate 清单
// ═══════════════════════════════════════════════════════════════

const WAVE_DESIGN_REVIEW_GATES = [
  // 结构完整性
  "test-cases-non-empty",            // testCases 至少 1 条（TDD 硬前提）
  "test-cases-have-expected",        // 每个 WaveTestCase 的 expected 非空
  // 注意：不对 tasks / files / contracts 做机器非空 gate（详见 §2.7）
  //      也不做条目间强引用 gate（条目间无引用关系，详见 §2.6）
  // 业务判断非空（model §5.8 通用要求）
  "design-review-necessity-non-empty",
  "design-review-sufficiency-complete",   // gaps + overlaps + meceNote
  "design-review-alternatives-non-empty",
  "design-review-tradeoffs-present",      // 至少 1 条或显式声明「无」+ 理由
  "design-review-risks-present",          // 至少 1 条或显式声明「无」+ 理由
];

const WAVE_TEST_GATES = [
  // 结构完整性
  "commit-exists",                   // wave.executeResult.commitHash 在仓库真实存在（git cat-file -e）
  "test-cases-executed",             // 所有非 manual WaveTestCase 都真跑了（机器验测试运行记录）
  // tests-all-pass（核心机器 gate，整个 cw 唯一真正机器验证业务正确性的 gate）
  // cw 实跑 wave 测试套件，验所有非 manual WaveTestCase 的测试都 pass（fail 数 = 0）
  // manual 类 WaveTestCase 不机器跑，走退化验证（§5.3）
  "tests-all-pass",
  // 引用一致性：testJudgment 必须逐条对应 designReviewJudgment 的每一类
  "test-references-design-review",   // 每个 tradeoff.id 有 tradeoffCostRealized.tradeoffRef，
                                     // 每个 risk.id 有 riskOutcome.riskRef
                                     // necessityMet / sufficiencyMet / alternativesReconsidered 非空
];

const WAVE_EXEC_REVIEW_GATES = [
  // 必填字段非空
  "exec-review-readability-non-empty",   // readability.score 非空
  "exec-review-architecture-non-empty",  // architecture.score 非空
  "exec-review-overall-verdict-non-empty",
  // needs-followup 时 followupActions 必填
  "exec-review-followup-actions-when-needed",  // overallVerdict="needs-followup" 时 followupActions 至少 1 条
  // 注意：exec-review 无机器 gate 验 score 合理性 / issues 内容 / followupActions 是否真被执行
  //       都是纯人审（详见 §6.5）
];

const WAVE_RETROSPECT_GATES = [
  "lessons-learned-non-empty",       // retrospectData.lessonsLearned 非空（机器 gate）
  "retrospect-covers-judgments",     // reviewedItems 覆盖 designReviewJudgment + testJudgment + execReviewJudgment 每项
                                     // （机器验覆盖，不验 verdict 对错）
  // 人审（机器验不了）：reviewedItems 的 outcome 是否判断得对、note 质量深不深
];
```

---

## 维护说明

- 本文档是 v5 wave 层的设计。流程/状态机/通用字段以 [design-v5-model.md](./design-v5-model.md) 为权威源，本文只描述 wave 的差异。
- **所有用词必须在 model §5 词表内**。本文新增的字段（FollowupAction / TestRunResult / SufficiencyMetResult 等结构体的内部字段）是 wave 文档对 model §5.8 字段名的结构化展开，不引入新领域概念。
- **execReviewJudgment 已在本文 §6 定稿**（model §7.1 待确认项的落地）。建议 model §7.1 同步更新状态。
- v4 wave 文档（design-v4-wave.md）保留为历史参考，但不作为当前设计依据。如 v4 与 v5 冲突，以 v5 为准。主要差异：v5 把 verify 改名为 design-review、新增 exec-review 步骤、executeResult 改为结构化（{ commitHash }）、废弃 refKind/Payload 等冗余概念。

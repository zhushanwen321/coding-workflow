# cw 1.0 设计文档 v5 · 模型与词表

> 本文是 v5 的**模型定义 + 词表**。v5 相对 v4 做了根本性重构：承认 4 层不是完全同构，重新建模为 PlanningUnit / ExecutionUnit 两类；纠正流程中缺失的 exec-review 环节；清理 v4 遗留的冗余概念（refKind / SpecSection / Payload / plan 项等）。
>
> 本文取代 v4 的 glossary + 各层附录接口定义。v5 各层文档（design-v5-epic.md 等）尚未写，以本文为准。

---

## 0. v5 相对 v4 的关键变更

### 0.1 根本性重构

| 变更 | v4 | v5 | 理由 |
|---|---|---|---|
| **4 层抽象** | 4 层都是 WorkUnit，走「完全相同」的 8 步（wave 是特例）| WorkUnit 分两类：PlanningUnit（epic/feature/slice 同构，7 步）/ ExecutionUnit（wave 独立，9 步）| 4 层在 execute/test/plan 内容上有本质差异，v4 的「完全同构」不成立 |
| **协调型层砍掉 test** | 所有层都有 test | PlanningUnit 无 test，retrospect 兼做验收 | 协调型层的 test（集成验收）和 retrospect（对照判断）职责重叠 |
| **wave 新增 exec-review** | execute 后直接 test | execute → test → exec-review | 执行后必须审代码品味，v4 缺失这个环节 |
| **审查顺序** | （v4 没有这个区分）| wave 是 test → exec-review（先确认功能对，再审品味）| 功能不对时审品味没意义 |

### 0.2 审查步骤改名

| v4 | v5 | 含义 |
|---|---|---|
| verify | **design-review** | 执行前审方案（规划/设计合理性）|
| （无）| **exec-review**（仅 ExecutionUnit）| 执行后审代码（品味/架构/可读性）|
| test | test（仅 ExecutionUnit）| 跑测试 + 对照判断（业务正确性）|

字段名同步：`verifyJudgment` → `designReviewJudgment`；新增 `execReviewJudgment`。

**design = clarification + plan**——**design-review 审的是「clarification 的产出（澄清结果）+ plan 的产出（规划方案）」这两步合起来的方案**，不是单独的 design 文档。这是 design-review **不能**改名为 plan-review 的根本理由：plan-review 只覆盖 plan（漏了 clarification，无法审「澄清是否充分、决策是否正确」），而 design-review 同时审这两步。同理也不能改名为 clarify-review（漏了 plan）。design 是这两步的合称，design-review 是对这两步合起来产出的一次审查。

### 0.3 清理的冗余概念

| 清理项 | 理由 |
|---|---|
| `refKind` + `specItem` + `techItem` | id 唯一就能区分条目类型，不需要额外的 kind 分类。`ref` 意义泛，`spec`/`tech` 是已废弃词 |
| `refId`（AbandonedRef 字段）| 改名 `workUnitItemId`，明确是 WorkUnitItem 的 id |
| `plan 项` 这个统称 | 没有对应类型，直接用具体条目类型名（Clarification/SliceTechChoice 等）|
| `SpecSection` | feature 的 spec 扁平化，和 slice 对称 |
| `Payload`（EpicPayload/FeaturePayload 等）| v4 worker 凭空造的字段，无定义，删除 |
| `replacedBy`（WorkUnitItem 字段）| v5 replan 机制改为「下层全部 abort + 上层重建」（§5.6），cw 不做语义判断（不判断废弃条目被谁替代），replacedBy 无消费方，删除 |
| `accept-replan` action | v5 replan 机制里 cw 直接 abort 受影响下层（§5.6），没有「待 agent 确认」的中间态，accept-replan 无职责，删除 |
| cw 0.x 迁移 TODO（SpecVersion/specHistory/replaceSpecSections）| v5 完全重构，不管 cw 0.x |

### 0.4 命名规则

| 规则 | 说明 |
|---|---|
| **slice/wave 的 plan 内部条目类型名带层前缀全称** | `SliceTechChoice` / `WaveTestCase`，避免跨层类型重名 |
| **字段名不带层前缀** | `techChoices` / `testCases`，靠所属 Plan 类型判别语义 |
| **跨层共享类型不加层前缀** | `Clarification` / `Decision` / `Split`——所有层通用 |

---

## 1. WorkUnit：cw 管理的核心实体

cw 管理的每一件开发工作都叫一个 **WorkUnit**。WorkUnit 是 cw 的核心实体——cw 的所有操作（建实例、推进状态、记录方案、跑测试）都围绕 WorkUnit 展开。

### 1.1 两类 WorkUnit

4 个层按业务本质分成两类：

| 类型 | 包含的层 | 本质职责 | 产出 | 流程 |
|---|---|---|---|---|
| **PlanningUnit**（规划型）| epic / feature / slice | 把上层的东西翻译/拆解成下层能接手的东西 | 文档（方案/spec/plan）| 7 步 |
| **ExecutionUnit**（执行型）| wave | 施工 + 验证 | 代码 + 测试结果 | 9 步 |

**区分依据**：PlanningUnit 的 execute = 启动下层（递归），不产出代码；ExecutionUnit 的 execute = dev 写代码（递归出口），是 cw 唯一产出代码的层。这就是 guide §3.2「execute 是分水岭」的精确含义。

### 1.2 4 层对照

| 层 | 类型 | 粒度 | execute 产出 | plan 结构 | clarify 产出 |
|---|---|---|---|---|---|
| **epic** | PlanningUnit | 跨多 session | 启动 **feature** 层（递归）| `Plan` 基类（只 split）| `Clarification[]` |
| **feature** | PlanningUnit | 单特性 | 启动 **slice** 层（递归）| `Plan` 基类（只 split）| **`FeatureClarification`**（容器含 `FeatureSpec`：FR/AC/UC）|
| **slice** | PlanningUnit | 单 session 可完成（典型 2-4h）| 启动 **wave** 层（递归）| **`SlicePlan extends Plan`**（+5 技术字段）| `Clarification[]` |
| **wave** | ExecutionUnit | 单次提交可完成（典型 30min-2h）| **dev 写代码**（递归出口，唯一产出代码）| `WavePlan extends Plan`（+4 实施字段）| `Clarification[]` |

**execute 产出的关键差异**：三层 PlanningUnit 的 execute 都是「启动下层」（递归），但**启动的下层不同**（epic→feature / feature→slice / slice→wave）——不能用统一的「启动下层」把三层抹平成同构。wave 的 execute 是递归出口（唯一产出代码），与三层 PlanningUnit 本质不同。三层 PlanningUnit 之间的进一步差异见 §1.3。

### 1.3 三层 PlanningUnit 横向对比

§1.2 表里三层 PlanningUnit 在「execute 产出」维度都标「启动下层（递归）」，但这只是粗粒度聚合——三层启动的下层不同、产出内容的性质差异巨大。本节把三层在**核心产物 / plan 类型 / clarify 形态 / layerSpecific / retrospect 验收对象**等维度上的差异并列呈现，作为读者建立「三层是三种角色」心智模型的聚合视图。**所有内容来自 §5 词表和各层文档，不引入新概念**，只是把散落的差异集中到一张表。

| 维度 | epic | feature | slice |
|---|---|---|---|
| **核心职责** | 把战略目标翻译成 feature 能接手的需求方向 | 把 feature 的需求方向翻译成 slice 能接手的需求 spec | 把 feature 的需求 spec 翻译成 wave 能施工的技术方案 |
| **核心产物（plan 层）** | 只有 Clarification（决策沉淀在 `Clarification.resolution`，无 spec）| **`FeatureSpec`**（FR/AC/UC/decisions/outOfScope）| **`SlicePlan` 技术条目**（`SliceTechChoice` / `SliceInterface` / `SliceDataModel` / `SliceErrorSpec`）|
| **plan 类型** | `Plan` 基类（只 split）| `Plan` 基类（只 split）| **`SlicePlan extends Plan`**（+5 技术字段）|
| **clarify 形态** | `Clarification[]` | **`FeatureClarification`**（容器含 spec）| `Clarification[]` |
| **拆下层依据** | 业务边界（每个 feature = 一个独立的用户可感知能力）| 单 session 可完成 + 边界清楚 + 可独立验收 | 单次提交可完成 + 有明确测试边界 |
| **layerSpecific 关心什么** | 战略层：`strategicAlignment` / `featureSplitRationale` / `scopeBoundary` / `priorityRationale` / `resourceEstimate` | 需求完整性层：`specMeceNote` / `sliceSplitRationale` / `acVerifiabilityNote` / `consistencyNote` / `frAcCoverageNote` / `sliceSpecCoverageNote` | 技术可行性层：`techChoiceRationale` / `interfaceContractNote` / `dataModelSoundness` / `errorCoverage` / `testabilityNote` / `crossWaveContractNote` |
| **retrospect 验收对象** | feature 组合兑现 epic 目标 | slice 组合兑现 feature spec（**重点查 UC 跨 slice 集成**）| wave 组合兑现 slice 技术方案（**重点查 IF/DM/ERR/TC 落地**）|
| **特殊点** | 顶层（无 `parentUnitId` / `basedOnParent` 永远 `[]` / `abandonedRefs` 永远 `[]`）| 中间层（同时是发起者和承受者）| PlanningUnit 最底层（`splitFulfillment` 在这里定稿——必须覆盖所有 split 项）|

**三层不是粒度递减的同构层，而是职责不同的三种角色**。其中 **feature 和 slice 的差异比 epic 和 feature 的差异大得多**：

- feature 的 plan 是空壳（只有 split），slice 的 plan 是充实的技术方案（5 个技术字段）；
- feature 的 clarify 产物是规格化 spec（FR/AC/UC），slice 的 clarify 只是技术澄清（`Clarification[]`）；
- feature 的 layerSpecific 关心功能完整性 / AC 可测性（业务层），slice 的 layerSpecific 关心接口契约 / 数据模型合理性 / 错误覆盖（技术层）。

把三层当成「只是粒度不同的同构层」是 v4 的误解——v5 必须纠正。读者看完这张表应该建立的印象是：epic 是**战略翻译**、feature 是**需求规格化**、slice 是**技术方案化**，三种不同性质的工作。

#### 1.3.1 三层核心边界规则（直述句）

把散落在 §5 词表（§5.7 / §5.9 / §5.10）和各层文档的核心边界规则在此直述化，让读者一处看全。**这些规则在词表内已有定义，这里不引入新规则，只是显式声明**：

1. **FR/AC/UC 只在 feature 层产生**：`FunctionalRequirement` / `AcceptanceCriterion` / `BusinessCase` 只在 feature 层的 `FeatureSpec` 里产生（§5.7 / §6），epic 和 slice 都不产生。**epic 不持有 spec**——决策沉淀在 `Clarification.resolution`（epic 的 plan 是 `Plan` 基类，无 spec 容器）；**slice 把 FR/AC/UC 翻译成技术条目**（`SliceTechChoice` 等），但不重新定义它们——slice 的 `basedOnParent` 引用 feature 的 FR/AC/UC id 作为上游约束，slice 自己 clarify 产出的是技术问题（不是业务需求）。

2. **技术条目只在 slice 层产生**：`SliceTechChoice` / `SliceInterface` / `SliceDataModel` / `SliceErrorSpec` 只在 slice 层的 `SlicePlan` 里产生（§4.3 / §5.7）。feature 不做技术方案（feature 的 plan 是 `Plan` 基类），epic 也不做。wave 的 `WavePlan` 只消费 slice 的技术条目（通过 `basedOnParent` 引用 + 照着施工），不重新定义技术契约。

3. **Decision 跨层但投影自本层 Clarification**：所有层都可以有 `Decision`（§5.10），但**每层的 Decision 投影自该层自己的 Clarification**，不是继承的上游 Clarification。如 slice 的 Decision 投影自 slice clarify 产生的 Clarification（技术问题），不是从 feature 继承的 Clarification（业务问题）；feature 的 Decision 投影自 feature 自己的 Clarification，不是继承的 epic Clarification。同一业务问题在三层可能产生三个不同 id 的 Decision，各管各层。

4. **同一个业务问题在三层会被不同层面地问**（逐层细化，不是重复问）：以「token 存哪」为例——
   - epic 问**方向**：「认证体系用 OAuth 还是自建」（决定要不要 token 这回事）
   - feature 问**方案**：「token 存哪、支持哪些 OAuth 提供商、过期/续期策略」（决定 token 的业务行为）
   - slice 问**技术实现**：「用哪个库做 token 交换、TokenPair 数据结构是什么、错误态怎么定义」（决定 token 的技术落地）

   三层不是在重复问同一个问题，是**逐层细化**——同一业务问题在不同层有不同粒度的答案，分别沉淀在该层的 Clarification（及 feature 的 FeatureSpec / slice 的 SlicePlan）里。

### 1.4 WorkUnit 顶层接口

把前面散落的字段汇总成一个 TS 接口，方便各层文档引用。**这是字段索引，不是新概念**——所有字段的语义见 §5 词表。

```typescript
// 所有 WorkUnit 共享的字段
interface WorkUnit {
  // 身份
  id: string;                                          // 如 "epic:auth-refactor"
  scope: "epic" | "feature" | "slice" | "wave";
  slug: string;                                        // 人类可读短名
  parentUnitId?: string;                               // 父层 id（epic 无）

  // lifecycle
  status: PlanningStatus | ExecutionStatus;            // 见 §5.4
  statusHistory: StatusChange[];                       // append-only

  // replan 追踪
  basedOnParent: string[];                             // 引用父层哪些条目 id（创建时快照，append-only，影响面计算基础，见 §5.6）
  abandonedRefs: AbandonedRef[];                       // 被上游 replan 影响的废弃记录（纯历史记录，见 §5.6）

  // === 主流程产物（按推进顺序，逐步填充）===
  objective: string;                                              // create
  clarifications: Clarification[] | FeatureClarification;          // clarify（feature 形态不同，见 §5.9/§6）
  plan: Plan;                                                     // plan（SlicePlan/WavePlan 是 Plan 子类，见 §4.3）
  designReviewJudgment: DesignReviewJudgment;                     // design-review（见 §5.8）
  executeResult: ExecuteResult;                                   // execute（见 §2.5）
  retrospectData: RetrospectData;                                 // retrospect（见 §5.8）
  evidence: Evidence;                                             // 跨阶段（execute+test 生成客观部分 / exec-review+retrospect 消费 / closeout 补主观 + 冻结），见 §5.11
}

// PlanningUnit（epic/feature/slice）
interface PlanningUnit extends WorkUnit {
  scope: "epic" | "feature" | "slice";
  status: PlanningStatus;                              // 8 状态
  executeResult: PlanningExecuteResult;                // { childUnitIds }
  evidence: PlanningEvidence;                          // 客观部分含 childDelivery（见 §5.11）
  // 无 testJudgment / execReviewJudgment——这是 PlanningUnit 的判别特征
}

// ExecutionUnit（wave）
interface ExecutionUnit extends WorkUnit {
  scope: "wave";
  status: ExecutionStatus;                             // 10 状态
  executeResult: ExecutionExecuteResult;               // { commitHash }
  testJudgment: TestJudgment;                          // test 阶段（见 §5.8）
  execReviewJudgment: ExecReviewJudgment;              // exec-review 阶段（见 §5.8）
  evidence: WaveEvidence;                              // 客观部分含 commitHash/changedFiles/testRunResult（见 §5.11）
}
```

**三个判别字段**（区分 PlanningUnit 和 ExecutionUnit）：`executeResult` 的子类型（childUnitIds vs commitHash）、有无 `testJudgment`、有无 `execReviewJudgment`。

**类型标注说明**：
- `plan: Plan` 是基类标注，运行时持有子类实例（SlicePlan/WavePlan）。epic/feature 直接用 Plan。
- `clarifications` 是联合类型：epic/slice/wave 持有 `Clarification[]`，feature 持有 `FeatureClarification`（容器对象，含 spec）。
- `evidence: Evidence` 是基类标注：PlanningUnit 子接口收窄为 `PlanningEvidence`，ExecutionUnit 子接口收窄为 `WaveEvidence`（运行时持有对应子类实例，见 §5.11）。

---

## 2. 流程：两类不同的步骤序列

### 2.1 PlanningUnit 的 7 步

```
create → clarify → plan → design-review → execute → retrospect → closeout
 创建     澄清    规划     设计审查         执行      复盘+验收    收尾
```

**design-review 审 clarification + plan 的产出**：design-review 不是单独的步骤产物，它审的是前面两步（clarify + plan）合起来的方案——既审澄清是否充分（Clarification），又审规划是否合理（Plan / SlicePlan），见 §0.2。

**为什么砍掉 test**：PlanningUnit 的 execute 产出是「下层 WorkUnit id 列表」，不是代码。当下层全部 closeout 后，PlanningUnit 进入 retrospect——此时兼做两件事：① 对照 designReviewJudgment 验收「下层组合起来兑现了我的规划吗」② 提炼经验。v4 把这两个职责拆成 test 和 retrospect，但实际重叠（都在对照判断回溯），合并更诚实。

### 2.2 ExecutionUnit（wave）的 9 步

```
create → clarify → plan → design-review → execute → test → exec-review → retrospect → closeout
 创建     澄清    规划    设计审查          执行    跑测试   执行审查      复盘       收尾
```

**design-review 审 clarification + plan 的产出**：和 PlanningUnit 一样，wave 的 design-review 也审 clarify（Clarification）+ plan（WavePlan，含 testCases/tasks/files/contracts）两步合起来的方案合理性，见 §0.2。

**为什么 wave 多 test 和 exec-review**：
- wave 的 execute 产出代码，必须验证代码对不对（test）和好不好（exec-review）
- test = 跑测试 + 对照 designReviewJudgment（业务正确性，机器 gate：tests-all-pass）
- exec-review = 审代码品味/架构/可读性（纯人审，无机器 gate）

**为什么是 test → exec-review 顺序**：先确认功能对（test pass），再审代码品味。功能不对时审品味没意义。

### 2.3 步骤对照表

| 步骤 | PlanningUnit（epic/feature/slice）| ExecutionUnit（wave）|
|---|---|---|
| create | 建实例，填 objective | 同 |
| clarify | 澄清 | 同 |
| plan | 定方案 + 拆下层 | 写测试代码（TDD 起点）|
| design-review | 审 clarification + plan 合起来的方案合理性（执行前，见 §0.2）| 审 clarification + plan 合起来的方案合理性（执行前，见 §0.2）|
| execute | 启动下层（递归）| dev 写代码（递归出口）|
| test | — | 跑测试 + 对照判断（机器验证）|
| exec-review | — | 审代码品味（人审）|
| retrospect | 集成验收 + 提炼经验 | 提炼经验 |
| closeout | 收尾归档 | 同 |

### 2.4 8 步产物名

| 步骤 | 产物字段名 | 是什么 | PlanningUnit 有 | ExecutionUnit 有 |
|---|---|---|---|---|
| create | `objective` | 目标描述（1-2 句话）| ✓ | ✓ |
| clarify | `clarifications` | 澄清项列表 | ✓ | ✓ |
| plan | `plan` | 规划产物（含拆下层清单）| ✓ | ✓ |
| design-review | `designReviewJudgment` | 执行前的设计判断 | ✓ | ✓ |
| execute | `executeResult` | 执行产出（详见 §2.5）| ✓（下层 id + 继承关系）| ✓（commitHash）|
| test | `testJudgment` | 跑测试 + 对照验收 | — | ✓ |
| exec-review | `execReviewJudgment` | 代码品味审查 | — | ✓ |
| retrospect | `retrospectData` | 复盘 + 验收结论 + 经验 | ✓（含验收）| ✓ |
| closeout | （冻结 `evidence`）| closeout 补 evidence 主观部分 + drift 检查 + 冻结（evidence 本身是跨阶段产物，见 §5.2/§5.11）| ✓ | ✓ |

### 2.5 execute 产物的结构（v5 新增）

v4 把 execute 标为「无独立产物」是错的。v5 明确定义 execute 产物：

```typescript
// execute 产物的基类
interface ExecuteResult {
  // 共享部分（暂无，预留扩展）
}

// PlanningUnit 的 execute 产物（epic/feature/slice 共享）
interface PlanningExecuteResult extends ExecuteResult {
  childUnitIds: string[];          // 下层 WorkUnit 的 id 列表
  // inheritedItemIds 见 §5.3 Split（每个子层的继承关系放在 Split 里，不放这里）
}

// ExecutionUnit 的 execute 产物（wave）
interface ExecutionExecuteResult extends ExecuteResult {
  commitHash: string;              // dev 写完代码后的 commit hash（cw 验存在性）
}
```

**wave 的 `testRunResult` 归 test 阶段，不归 execute**——execute 只管「代码写完且 commit 了」，test 阶段才跑测试拿结果。

---

## 3. 状态机

### 3.1 PlanningUnit 的 8 状态

```
              create    clarify    plan    design-review    execute    retrospect    closeout
  (开始) ─────────> created ──────> clarifying ──────> planning ──────> design-reviewed ──────> executing ──────> retrospected ──────> closed
```

**8 状态**：created / clarifying / planning / design-reviewed / executing / retrospected / closed / aborted

### 3.2 ExecutionUnit 的 10 状态

```
              create    clarify    plan    design-review    execute    test    exec-review    retrospect    closeout
  (开始) ─────────> created ──────> clarifying ──────> planning ──────> design-reviewed ──────> executing ──────> tested ──────> exec-reviewed ──────> retrospected ──────> closed
```

**10 状态**：created / clarifying / planning / design-reviewed / executing / tested / exec-reviewed / retrospected / closed / aborted

### 3.3 action 列表

**PlanningUnit 主流程 action（7 个）**：
- `create` → created
- `clarify` → clarifying（progressive）
- `plan` → planning（progressive）
- `design-review` → design-reviewed（progressive）
- `execute` → executing
- `retrospect` → retrospected
- `closeout` → closed（不可逆）

**ExecutionUnit 主流程 action（9 个）**：
- `create` → created
- `clarify` → clarifying（progressive）
- `plan` → planning（progressive）
- `design-review` → design-reviewed（progressive）
- `execute` → executing
- `test` → tested
- `exec-review` → exec-reviewed
- `retrospect` → retrospected
- `closeout` → closed（不可逆）

**旁路 action（两类共享，2 个）**：
- `replan`：不改 status，原地加变更记录 + cw 计算下游影响面并级联 abort 受影响子孙 + 返回影响面给 agent（详见 §5.6）
- `abort`：任何状态 → aborted（级联 abort 所有子孙，包括已 closed 的——cw 只标 status=aborted，不动 git）

**只读查询命令**：`status` / `list` / `show`（不走状态机）

### 3.4 wave 状态机特化（跨层审查补强）

§3.1 / §3.2 / §3.3 给的是 PlanningUnit / ExecutionUnit 的**通用主流程**（happy path）。但 ExecutionUnit（wave）在 `plan` 和 `replan` 两个 action 上有**特化**（来自 wave 文档定稿，详见 wave §8.3 / §8.5）：

**wave 的 `plan` action 特化**（from 状态集）：
- 通用规则（§3.3）：`plan` from = `clarifying`。
- **wave 特化**：`plan` from 额外允许 `design-reviewed`——wave **replan 后必须回到 `planning` 重新 `design-review`**（不能原地改 plan 跳过 design-review）。这意味着 wave 的 `plan` 可以从 `clarifying` 或 `design-reviewed` 进入，对应「首次规划」和「replan 后重规划」两种场景。详见 wave §8.3。

**wave 的 `replan` action 特化**（from 状态集）：
- 通用规则（§3.3 旁路）：`replan` 在「任何状态」都可触发（不改 status）。
- **wave 特化**：wave 的 `replan` 允许 from 状态集显式包含 `executing` / `tested` / `exec-reviewed` / `retrospected`——即 wave 在执行后（甚至已经测试/审查/复盘后）发现需要 replan 时，允许触发 replan（status 不变，但 append 一条 StatusChange 到 statusHistory，见 §4.4.1）。触发后 cw 按 §5.6 的 abort + appendOnly 机制处理下游影响面（wave 没有下游，所以主要是更新 wave 自己的 plan + 中和相关 judgment 的有效性）。详见 wave §8.5。

**这两条特化只适用于 ExecutionUnit（wave）**，PlanningUnit（epic/feature/slice）的 `plan` / `replan` 仍按 §3.3 通用规则（PlanningUnit 的 replan 不在执行后触发——PlanningUnit 没有 execute 产代码这一步，retrospect 发现的问题走重建下层而非 replan 本层）。

---

## 4. 代码层基础类型（不进词表主体）

这些是代码层的 DRY 复用类型，不是领域概念。各层文档附录有完整继承树。

### 4.1 WorkUnitItem

所有支持 replan 追踪的条目共享此结构（id 唯一 + 可废弃）：

```typescript
interface WorkUnitItem {
  id: string;
  status: "active" | "abandoned";
}
```

**继承 WorkUnitItem 的条目**：Clarification / FunctionalRequirement / AcceptanceCriterion / BusinessCase / SliceTechChoice / SliceInterface / SliceDataModel / SliceErrorSpec / WaveTestCase / WaveTask / WaveFile / WaveContract。

**不继承的**：
- `Decision`（投影自 Clarification，跟随 Clarification replan，不独立持有 status）
- `Split`（拆分项，无 lifecycle，不逐项废弃）

**关于条目废弃后的替代关系**：v5 删掉了 `replacedBy` 字段——cw 不在条目层面维护「被谁替代」的语义（cw 做不了这个语义判断）。废弃就是废弃，替代关系由 agent 在重建下层时自行决定。详见 §5.6 replan 机制。

### 4.2 Plan 和 Split

```typescript
// 所有层 plan 的基类
interface Plan {
  split: Split[];
}

// 拆分项（无 lifecycle）
interface Split {
  slug: string;
  description: string;
  dependsOn: string[];
  inheritedItemIds?: string[];    // 这个子层继承上游的哪些条目 id（写入子层的 basedOnParent）
}
```

**inheritedItemIds 的语义**（v5 新增）：PlanningUnit 的 plan 阶段，每个 Split 项显式声明「这个子层负责上游的哪些条目」。execute 时 cw 根据 Split 创建子层，把 inheritedItemIds 写入子层的 basedOnParent。

**这是对 v4 的 basedOnParent 继承机制的重新设计**：v4 是「cw 自动全量拷贝上游所有条目 id 到下游 basedOnParent，下游 plan 时再减少」——这会污染下游（下游不用的 id 也被记下来）。v5 改为「plan 阶段显式声明继承关系」，execute 时按声明写入。

**basedOnParent 是创建时的历史快照**（append-only，永不重写）。replan 触发后，cw 对比上游当前 spec 和下层的 basedOnParent 来计算影响面（见 §5.6）。下游基于废弃条目 → 失去存在前提 → 直接 abort，不更新 basedOnParent。

### 4.3 各层 Plan 结构

```typescript
// epic / feature 直接用 Plan 基类（只有 split）
// epic plan: Plan（split 拆 feature）
// feature plan: Plan（split 拆 slice）

// slice plan 继承 Plan，扩展技术方案字段
interface SlicePlan extends Plan {
  techChoices: SliceTechChoice[];
  interfaces: SliceInterface[];
  dataModels: SliceDataModel[];
  errorSpecs: SliceErrorSpec[];
  decisions: Decision[];
}

// wave plan 继承 Plan（split 字段冗余但保留，换取 WorkUnit.plan 结构兼容）
interface WavePlan extends Plan {
  testCases: WaveTestCase[];
  tasks: WaveTask[];
  files: WaveFile[];
  contracts: WaveContract[];
}
```

### 4.4 StatusChange（statusHistory 的元素）

`statusHistory` 是 append-only 的「所有变更」流（不只是状态转换），元素类型为 `StatusChange`：

```typescript
interface StatusChange {
  from?: PlanningStatus | ExecutionStatus;   // 原 status（create 时无 from）
  to: PlanningStatus | ExecutionStatus;       // 新 status
  at: string;                                 // ISO 8601 时间戳
  action: string;                             // 触发变更的 action（create/clarify/.../replan/abort）
  note?: string;                              // 可选说明（如 replan 原因）
}
```

**字段语义**：
- `from` 在 `create` 时无（从无到有），其余主流程 action 都有 `from`。
- `action` 是触发本次变更的 action 名（见 §5.5 action 列表），包括主流程 action 和旁路 action（replan / abort）。
- `note` 可选，用于补充说明（典型：replan 时填「为什么 replan」、abort 时填「因为哪个上游条目废弃」）。

#### 4.4.1 replan 的 statusHistory 语义（重要）

replan 是**旁路 action，不改 status**——上层 replan 后，该 WorkUnit 的 `status` 字段不变。但 replan **仍然 append 一条 StatusChange 到 statusHistory**：

- `from = to = 当前 status`（两者相同，表达「没变」）
- `action = "replan"`
- `note` 填 replan 描述（废弃/新增了哪些条目，原因是什么）

**为什么 replan 也要写 statusHistory**：这样 `statusHistory` 是完整的「所有变更」流（包括「本应改 status 但实际没改」的旁路变更），不只是「状态转换」流。这让 status / report 能回答「这个 WorkUnit 经历过哪些 action」时不需要另开一个字段（如 audit log），单一来源（statusHistory）即覆盖全部。

abort 同理 append 一条（`from = 当前 status`，`to = "aborted"`，`action = "abort"`）。

---

## 5. 词表（领域概念索引）

### 5.1 核心实体

| 概念 | 含义 |
|---|---|
| **WorkUnit** | cw 管理的核心实体，有 id/status/lifecycle |
| **PlanningUnit** | 规划型 WorkUnit（epic/feature/slice），7 步流程，不产出代码 |
| **ExecutionUnit** | 执行型 WorkUnit（wave），9 步流程，产出代码 |
| **epic / feature / slice / wave** | 4 个具体的层（scope）|

### 5.2 8 步产物（字段名）

| 字段名 | 哪步填 | 是什么 | PlanningUnit | ExecutionUnit |
|---|---|---|---|---|
| `objective` | create | 目标描述 | ✓ | ✓ |
| `clarifications` | clarify | 澄清项列表 | ✓ | ✓ |
| `plan` | plan | 规划产物（含 split）| ✓ | ✓ |
| `designReviewJudgment` | design-review | 设计判断（执行前）| ✓ | ✓ |
| `executeResult` | execute | 执行产出 | ✓（下层 id）| ✓（commitHash）|
| `testJudgment` | test | 跑测试 + 对照验收 | — | ✓ |
| `execReviewJudgment` | exec-review | 代码品味审查 | — | ✓ |
| `retrospectData` | retrospect | 复盘 + 验收结论 + 经验 | ✓ | ✓ |

**`evidence` 是跨阶段产物（不在上表的某一步独占）**：

evidence 在 v5 中重新定位为**跨阶段产物**，不是 closeout 独占：

- **execute（+ ExecutionUnit 的 test）完成时**：cw 自动填 evidence 的**客观部分**（`commitHash` / `changedFiles` / `testRunResult` for wave；`childDelivery` for PlanningUnit）。
- **exec-review（ExecutionUnit）/ retrospect（PlanningUnit）阶段**：agent **消费** evidence——作为审查输入（和 `clarification` + `plan` + 各 judgment 一起），判断「实际交付是否兑现方案」。
- **closeout 阶段**：① agent 补充 evidence 的**主观部分**（`summary` + `artifacts`）② cw 校验 `artifacts[].ref` 指向的文件存在（drift 检查）③ cw 冻结 evidence（写 `frozenAt`，不再变）④ status → closed。

详见 §5.11「Evidence 类型」。

### 5.3 WorkUnit 通用字段

| 字段名 | 是什么 | 所有层都有 |
|---|---|---|
| `id` | WorkUnit 唯一标识（如 `epic:auth-refactor`）| ✓ |
| `scope` | 层类型（`"epic"` / `"feature"` / `"slice"` / `"wave"`）| ✓ |
| `slug` | 人类可读短名 | ✓ |
| `status` | 当前状态（PlanningUnit 8 状态 / ExecutionUnit 10 状态）| ✓ |
| `statusHistory` | 状态变更历史（append-only）| ✓ |
| `parentUnitId` | 父层 WorkUnit 的 id | epic 无（顶层）|
| `basedOnParent` | 这个 WorkUnit 引用了父层哪些条目 id（replan 反查影响面的基础）| ✓（epic 为空）|
| `abandonedRefs` | 被上游废弃的引用及处理状态（结构化数组）| ✓（epic 为空）|

**注意**：`childUnitIds` 不在通用字段里——它属于 executeResult（PlanningUnit 的 execute 产物）。

### 5.4 状态

**PlanningUnit 8 状态**：created / clarifying / planning / design-reviewed / executing / retrospected / closed / aborted

**ExecutionUnit 10 状态**：created / clarifying / planning / design-reviewed / executing / tested / exec-reviewed / retrospected / closed / aborted

### 5.5 action

**PlanningUnit 主流程（7）**：create / clarify / plan / design-review / execute / retrospect / closeout

**ExecutionUnit 主流程（9）**：create / clarify / plan / design-review / execute / test / exec-review / retrospect / closeout

**旁路（2，两类共享）**：replan / abort

**只读查询**：status / list / show

### 5.6 replan 机制（abort + appendOnly）

v5 的 replan 机制用 **abort + appendOnly** 策略：上层 replan 废弃条目后，cw 自动计算下游影响面，把引用了废弃条目的下层（及其所有子孙）**级联 abort**，然后返回影响面给 agent，由 agent 决定是否重建新的下层。

**核心洞察**：下层基于废弃条目 → 失去存在前提 → 直接废弃。不需要「下层 replan」「inheritedItemIds 自动更新」等复杂机制。

#### 5.6.1 涉及的字段

| 字段名 | 是什么 | 谁维护 |
|---|---|---|
| `basedOnParent` | 下层引用父层哪些条目 id（`string[]`，创建时的历史快照，append-only 永不重写）| execute 时按 `Split.inheritedItemIds` 写入，之后不动 |
| `abandonedRefs` | 这个 WorkUnit 被上游 replan 影响到的废弃记录（`AbandonedRef[]`，append-only，用于 report 追溯「什么时候、因为哪个上游条目废弃而被影响」）| cw 在级联 abort 时自动追加 |

```typescript
interface AbandonedRef {
  workUnitItemId: string;      // 被废弃的上游条目 id（如 "FR1"，来自 WorkUnitItem.id）
  abandonedAt: string;         // 何时被废弃影响（时间戳）
}
```

**AbandonedRef 的角色**：纯历史记录，用于 status / report 时回答「这个 WorkUnit 为什么 aborted 了？什么时候？因为哪个上游条目？」。**不阻塞任何流程**（因为 cw 在 replan 时已经直接 abort 了，没有「待处理」中间态）。

#### 5.6.2 replan 流程

```
触发: cw replan <unitId> -- "废弃/新增条目的描述"

Step 1 [本地变更]: 上层 WorkUnit 本地处理 replan
  - 废弃的条目 → status="abandoned"
  - 新增的条目 → status="active"，id 新分配
  - 上层 status 不变（replan 是旁路 action，不改 status）
  - 所有变更 append 到 statusHistory / 条目记录，永不重写

Step 2 [影响面计算]: cw 递归遍历上层所有子孙
  - 对比每个子孙的 basedOnParent × 上游当前 spec 条目状态
  - 命中规则: 子孙.basedOnParent 含已废弃条目 → 子孙标记受影响
  - 级联规则: 父标记受影响 → 所有子孙级联受影响（父废弃，子无意义）

Step 3 [级联 abort]: cw 自动执行
  - 所有受影响的子孙 → status="aborted"
  - 同时在受影响子孙的 abandonedRefs 追加 {workUnitItemId, abandonedAt}
  - cw 只改 status，不动 git（已 closeout 的 wave 的 commit 保留为 git 历史）

Step 4 [返回给 agent]:
  replan result:
    aborted: [<受影响子孙 id 列表>, ...]        // cw 已自动 abort
    preserved: [<未受影响子孙 id 列表>, ...]     // 保留原样
    pendingRebuild:                              // 提示 agent 需要重建
      - 描述「哪些上游条目失去了承接下层」
        (如「FR1a / FR1b 没有对应的 slice」)
      - agent 决定是否重建、怎么重建
```

#### 5.6.3 重建（agent 主导）

agent 看 replan 返回的 `pendingRebuild`，决定怎么重建：

- **场景 A（仅删除）**：上层纯删除 FR2，没有新增 → cw 自动 abort 引用 FR2 的下层。agent 核实 cw 的处理，无需重建（FR2 的需求没了就是没了）。
- **场景 B（涉及新增）**：上层把 FR1 拆成 FR1a + FR1b → cw abort 引用 FR1 的下层，agent 决定怎么承接 FR1a/FR1b（新建 slice 承接？合到现有 slice？都不接？）。**重建走 `cw create`**（新建 WorkUnit 走正常流程），不是「下层 replan」。

**重建的典型动作**：
```
agent: "新建 slice-auth-v2 承接 FR1a + AC1, 新建 slice-oauth 承接 FR1b"
cw create slice --parent=feature --inheritedItemIds=[FR1a, AC1]
cw create slice --parent=feature --inheritedItemIds=[FR1b]
```

新建的 WorkUnit 走正常流程（create → clarify → plan → ...），不是 replan。

#### 5.6.4 为什么是 abort + appendOnly（而不是其他方案）

| 对比方案 | 否决理由 |
|---|---|
| (a) cw 自动按 id 前缀迁移 inheritedItemIds（FR1 → FR1a + FR1b）| cw 做不了语义判断（不知道 FR1a/FR1b 该归哪个下层）。太魔法 |
| (b) 标记下层 replan-required，强制重新 plan | 需要引入新状态「replan-required」（违反词表纪律）；且「重新 plan」是原地改，破坏 appendOnly |
| (c) 把影响面放到 abandonedRefs 里等下层自行决定 | 需要「accept-replan」确认机制，多一个中间态；且下层「自行决定」本质还是 agent 决定，不如直接 abort + agent 重建清晰 |
| **(e) abort + appendOnly（v5 采用）** | 无新状态、无中间态、cw 只做确定性计算、语义判断全给 agent、appendOnly 天然支持 |

#### 5.6.5 与 v4 废弃词的关系

| 废弃词 | v5 处理 |
|---|---|
| `refKind` / `specItem` / `techItem` / `refId` | v5 删除（id 唯一就能区分条目类型）|
| `replacedBy` | v5 删除（cw 不在条目层面维护替代关系，详见 §4.1）|
| `accept-replan` action | v5 删除（cw 直接 abort，无中间态）|
| `AbandonedRef.resolvedAt` / `resolvedAction` | v5 删除（cw 直接 abort，无「待处理→已处理」转换）；AbandonedRef 简化为 2 个子字段（workUnitItemId / abandonedAt）|

### 5.7 plan 内部条目类型（各层）

**跨层共享**：
- `Clarification`（extends WorkUnitItem）——clarify 阶段产物
- `Decision`（不继承 WorkUnitItem）——投影自 Clarification

**feature 的 clarification.spec 条目**（extends WorkUnitItem）：
- `FunctionalRequirement`（FR）
- `AcceptanceCriterion`（AC）
- `BusinessCase`（UC）

**slice 的 plan 条目**（extends WorkUnitItem，带 Slice 前缀）：
- `SliceTechChoice`
- `SliceInterface`
- `SliceDataModel`
- `SliceErrorSpec`

**wave 的 plan 条目**（extends WorkUnitItem，带 Wave 前缀）：
- `WaveTestCase`
- `WaveTask`
- `WaveFile`
- `WaveContract`

### 5.8 业务判断字段（designReviewJudgment / testJudgment / execReviewJudgment 共享核心）

| 字段 | 含义 | 适用步骤 |
|---|---|---|
| `necessity` | 必要性判断 | designReviewJudgment |
| `sufficiency` | 充分性（MECE，含 gaps/overlaps/meceNote）| designReviewJudgment |
| `alternatives` | 替代方案 | designReviewJudgment |
| `tradeoffs` | 权衡与妥协（含 id/decision/reason/cost）| designReviewJudgment |
| `risks` | 风险（含 id/item/severity/mitigation）| designReviewJudgment |
| `layerSpecific` | 各层专属判断（KV 扩展点，类型标注为 `Record<string, string>`，各层文档应定义具名 interface 收紧——见下方约定）| designReviewJudgment / execReviewJudgment |

**`layerSpecific` 具名化约定**（v5 新增，让实现侧写得出类型守卫）：

- model §5.8 给的通用基类约束是 `layerSpecific?: Record<string, string>`（最低限度，KV 都是 string）——这是「所有层都至少满足」的下界。
- **各层文档应定义具名 interface 收紧**，主结构用 `layerSpecific?: <层名>DesignReviewLayerSpecific`（如 slice 的 `SliceDesignReviewLayerSpecific`、wave 的 `WaveDesignReviewLayerSpecific`）。各层可在自己的具名 interface 里把 string 收紧为更具体的类型（联合 / 枚举 / 嵌套结构）。
- **slice 已经做了**——slice 文档已定义 `SliceDesignReviewLayerSpecific`（含 `techChoiceRationale` / `interfaceContractNote` / `dataModelSoundness` / `errorCoverage` / `testabilityNote` / `crossWaveContractNote` 等）。**其他层（epic / feature / wave）应跟进**，在自己的层文档里给出具名 interface（参考 §1.3 表里各层 layerSpecific 关心的维度）。
- ExecReviewJudgment 的 `layerSpecific` 同理——wave 文档应给出 `WaveDesignReviewLayerSpecific`（wave 层 exec-review 专属判断）。本节 ExecReviewJudgment 概要里标为 `layerSpecific?: WaveDesignReviewLayerSpecific` 即按此约定。

**testJudgment**（仅 ExecutionUnit）：对照 designReviewJudgment 验收，含 `necessityMet` / `sufficiencyMet` / `alternativesReconsidered` / `tradeoffCostRealized` / `riskOutcome`。

**execReviewJudgment**（仅 ExecutionUnit）：代码品味审查（可读性/架构合理性/坏味道等维度），**权威定义在 wave §6.1**（本节 §5.8 给的是概要，字段结构同步见下方代码块）。

**retrospectData**（共享字段结构）：

> 四个数组（`wrongJudgments` / `badTradeoffs` / `missedGaps` / `processIssues`）从 `string[]` 改为结构化（参考 wave 的 testJudgment 对 tradeoff/risk 做的 `tradeoffRef` / `riskRef`），让机器能验「指向」。`lessonsLearned` **保留 string**——经验提炼天生叙述性，不拆成枚举字段。

```typescript
interface RetrospectData {
  reviewedItems: ReviewedItem[];     // 逐项回顾（对照 designReviewJudgment）
  lessonsLearned: string;            // 必填，保留 string（经验提炼天生叙述性，不拆枚举）
  wrongJudgments?: WrongJudgment[];          // 从 string[] 改为结构化（designReviewJudgment 哪里判错了）
  badTradeoffs?: BadTradeoff[];              // 从 string[] 改为结构化（哪些 tradeoff 实际代价过大）
  missedGaps?: MissedGap[];                  // 从 string[] 改为结构化（design-review 时漏掉的 MECE gaps）
  processIssues?: ProcessIssue[];            // 从 string[] 改为结构化（流程问题）
}

// 逐项回顾项
interface ReviewedItem {
  itemId: string;                    // designReviewJudgment 里某条判断的 id（约定见下方）
  outcome: "fulfilled" | "partial" | "unfulfilled";
  note?: string;                     // 失败/部分达成的说明
}

// 判错的判断（指向 designReviewJudgment 的某条）
interface WrongJudgment {
  judgmentRef: string;               // 指向 designReviewJudgment 的某条判断 id（如 "necessity" / "TR1"）
  whyWrong: string;                  // 为什么判错了
  whatActuallyHappened: string;      // 实际发生了什么
}

// 代价超预期的 tradeoff（指向 designReviewJudgment.tradeoffs 的某条）
interface BadTradeoff {
  tradeoffRef: string;               // 指向 designReviewJudgment.tradeoffs 的某条 id
  costOverrun: string;               // 实际代价超过预期多少
  note?: string;
}

// 漏掉的 MECE gap（指明在哪一步漏的）
interface MissedGap {
  where: "clarify" | "plan" | "design-review" | "execute" | "test";  // 在哪一步漏的
  gap: string;                       // 漏了什么
}

// 流程问题（指明类型）
interface ProcessIssue {
  type: "clarify" | "plan" | "split" | "replan" | "execute" | "test" | "review" | "other";
  issue: string;
}
```

**`ReviewedItem.itemId` 约定**（v5 新增，明确指向）：

- **necessity / sufficiency / alternatives 等裸字段**：`itemId` = 字段名本身（`"necessity"` / `"sufficiency"` / `"alternatives"`）。这些字段是 designReviewJudgment 顶层的单值判断，没有独立 id，用字段名做 itemId。
- **tradeoffs / risks 等数组**：`itemId` = 各自元素的 id（如 tradeoffs 的 `"TR1"`、risks 的 `"RK1"`）。这些数组元素都有 id，直接用元素 id。
- 同样的 ref 约定适用于 `WrongJudgment.judgmentRef` 和 `BadTradeoff.tradeoffRef`（裸字段 → 字段名；数组元素 → 元素 id）。

**PlanningUnit 的 retrospectData 兼验收**（retrospectData 共享结构 + PlanningUnit 扩展）：
```typescript
interface PlanningRetrospectData extends RetrospectData {
  // 兼做验收：回答「下层组合起来兑现了我的规划吗」
  deliveryVerdict: "delivered" | "partial" | "failed";
  childUnitIdsEvidence: { childId: string; status: "closed" | "aborted"; closeoutEvidenceSummary?: string }[];
  // 每个 split 项的兑现情况（split 来自 plan，对照 designReviewJudgment 的 sufficiency）
  splitFulfillment: { splitSlug: string; verdict: "delivered" | "partial" | "failed"; note?: string }[];
}
```

> **`childUnitIdsEvidence` 与 `PlanningEvidence.childDelivery` 的分工**：两者都涉及「child 交付情况」但定位不同——`childUnitIdsEvidence` 属于 **retrospectData**（agent 的主观验收判断，agent 在 retrospect 时填），`childDelivery` 属于 **evidence**（cw 自动填的客观 rollup，见 §5.11）。agent 在填 `childUnitIdsEvidence` 时可引用 `PlanningEvidence.childDelivery` 提供的客观数据作为判断依据，但两者是不同产物，不互相替代。

**ExecutionUnit 的 retrospectData** 用基类 `RetrospectData` 即可（wave 的 retrospect 不做验收——验收在 test/exec-review 做完了），`wrongJudgments` 主要对照 `designReviewJudgment` + `testJudgment` + `execReviewJudgment` 三处。

**execReviewJudgment**（仅 ExecutionUnit，代码品味审查，**纯人审，无机器 gate**）：

> **权威定义在 wave §6.1**（`readability` / `architecture` 必填、`FollowupAction` 结构化、各维度分数阈值等都在 wave 文档定稿）。本节给出的是**概要**——字段结构按 wave §6.1 同步，便于在 model 文档里建立整体心智。

```typescript
interface ExecReviewJudgment {
  // 不对照 designReviewJudgment——design-review 审的是"方案对不对"，exec-review 审的是"代码好不好"
  readability: { score: 1 | 2 | 3 | 4 | 5; issues?: string[] };       // 可读性（命名/结构/注释合理性）——必填
  architecture: { score: 1 | 2 | 3 | 4 | 5; issues?: string[] };      // 架构合理性（职责归位/分层）——必填
  codeSmells?: { items: string[]; severity?: "low" | "medium" | "high" };  // 坏味道清单（可选）
  layerSpecific?: WaveDesignReviewLayerSpecific;                      // wave 层专属判断的扩展点（见 §5.8 layerSpecific 约定）
  overallVerdict: "pass" | "needs-followup";                          // 总判断（纯人审，不阻塞 closeout）
  followupActions?: FollowupAction[];                                  // needs-followup 时的结构化跟进项
}

// 跟进项（结构化，便于分发到不同后续 scope）
interface FollowupAction {
  description: string;            // 跟进动作描述
  priority: "low" | "medium" | "high";
  targetScope: "current-wave-replan" | "next-wave" | "slice-level-refactor" | "adr-candidate";
}
```

**字段同步说明**：本节 `readability` / `architecture` 从可选（`?`）改为必填，`followupActions` 从 `string[]` 改为 `FollowupAction[]`，与 wave §6.1 定稿一致。`FollowupAction` 的 `targetScope` 枚举让跟进项可以结构化分发到「当前 wave replan / 下一个 wave / slice 层重构 / ADR 候选」等不同 scope，而不是塞在一串裸字符串里。

**execReviewJudgment 与 designReviewJudgment 的区别**：designReviewJudgment 审「执行前的方案」（necessity/sufficiency/alternatives/tradeoffs/risks），execReviewJudgment 审「执行后的代码」（readability/architecture/codeSmells）。两者维度完全不同，不共享字段结构。

### 5.9 Clarification

```typescript
interface Clarification extends WorkUnitItem {
  question: string;
  resolution?: string;   // 空 = 还没答（progressive 填充，靠字段空/非空判完成度）
  type: "research" | "grilling";
}
```

**`type` 的语义不在本文档展开**——`research` 和 `grilling` 作为 **skill** 提供（而不是硬编码在 cw 的状态机里）：`create` 阶段 cw 把可用的 skill 名称和 description 返回给 agent，agent 通过 `cw skill <name>` 命令渐进式加载具体 skill 的执行逻辑。**model 文档只标注 `type` 的取值（`"research" | "grilling"`），具体语义（research 怎么调外部查询、grilling 怎么追问）见对应 skill**，不在 model 里固化。这样 skill 可以独立演进/新增，model 不需要跟着改。

**Clarification 的形态不对称**（v5 保留 v4 的这个设计）：
- epic / slice / wave：`clarifications: Clarification[]`（数组）
- feature：`clarification: { clarifications, spec }`（容器对象，因为 feature 带 spec 子结构）

### 5.10 Decision

```typescript
interface Decision {
  id: string;                      // 直接用 Clarification 的 id（如 "D3"）
  decision: string;
  rationale: string;
  sourceClarification?: string;    // 投影自哪个 Clarification（id 和它一样）
}
```

**Decision 不继承 WorkUnitItem**——它跟随 Clarification replan，不独立持有 status/replacedBy。

**Decision 的 sourceClarification 指向本层 Clarification**：slice 的 Decision 投影自 slice 自己 clarify 产生的 Clarification（不是继承的 feature Clarification）；feature 的 Decision 投影自 feature 自己的 Clarification（不是继承的 epic Clarification）。

### 5.11 Evidence（跨阶段产物）

evidence 在 v5 重新定位为**跨阶段产物**（不是 closeout 独占），记录「这次交付到底产生了什么、是否兑现、最终冻结状态」。它继承 cw 0.x「客观部分全自动」的设计，同时补上「agent 在 closeout 补充主观交付清单」这一半——两者拼起来才是完整的交付证据。

#### 5.11.1 类型定义

```typescript
// ============ Evidence 基类（所有层共享）============
interface Evidence {
  // === 客观部分（cw 自动填，execute/test 完成时生成）===
  generatedAt: string;                    // ISO 8601，evidence 首次生成时间

  // === 主观部分（agent 在 closeout 时补充）===
  summary?: string;                       // 交付小结（1-2 句话，agent 填）
  artifacts: ArtifactRef[];               // 交付物引用清单（agent 确认/补充）

  // === 冻结标记（closeout 时填）===
  frozenAt?: string;                      // closeout 冻结时间（空=未 closeout，非空=已冻结不再变）
}

// 交付物引用（一条 = 一个交付物）
interface ArtifactRef {
  kind: "spec" | "plan" | "review-report" | "retrospect-report" | "code" | "test" | "doc" | "other";
  ref: string;                            // 文件路径 / URL / commit hash
  note?: string;                          // 简短说明（可选）
}

// ============ WaveEvidence（ExecutionUnit）============
interface WaveEvidence extends Evidence {
  // 客观部分（cw 自动填）
  commitHash: string;                     // execute 后的 commit（cw 验存在性）
  changedFiles: string[];                 // 本次 wave 改动的文件清单（从 commit 提取）
  testRunResult?: TestRunResult;          // test 阶段的测试结果（test 完成后填，无 test 则空）
}

// ============ PlanningEvidence（PlanningUnit，三层共享）============
interface PlanningEvidence extends Evidence {
  // 客观部分（cw 自动填，child closeout 后才完整）
  childDelivery: ChildDeliveryRecord[];   // 每个 split 项对应 child 的交付情况
}

// 每个 split 项的 child 交付记录（rollup）
interface ChildDeliveryRecord {
  splitSlug: string;                      // 对应 plan.split 的 slug
  childUnitId: string;                    // child WorkUnit id
  childStatus: "closed" | "aborted";      // child 最终状态
  childEvidenceSummary?: string;          // child evidence.summary 的引用（rollup）
}

// 测试运行结果（test 阶段产物；ExecutionUnit 才有）
interface TestRunResult {
  passed: boolean;                        // 是否全部通过
  passedCount: number;                    // 通过的用例数
  failedCount: number;                    // 失败的用例数
  skippedCount?: number;                  // 跳过的用例数（可选）
  durationMs?: number;                    // 总耗时（毫秒，可选）
  runnerMode?: string;                    // 触发模式（沿用 cw 0.x TestRunnerMode 命名）
  rawReportRef?: string;                  // 原始报告文件路径 / URL（可选）
}
```

#### 5.11.2 设计要点

- **客观部分 cw 自动填，主观部分 agent 在 closeout 填**——保留 cw 0.x「全自动客观部分」（commitHash / changedFiles / testRunResult）的设计，同时补上「agent 补充主观交付清单」（summary + artifacts）。cw 0.x 只做了 closeout 时一次性生成 evidence，v5 拆成「客观部分在 execute+test 时就生成 → 主观部分在 closeout 时补」两段，让 exec-review/retrospect 也能消费客观部分。
- **`frozenAt` 替代 cw 0.x 的 `closedAt`**——语义更明确（冻结时点）：`frozenAt` 为空意味着 evidence 还能变（closeout 前的客观/主观都允许更新），`frozenAt` 非空意味着 evidence 已冻结不再变（closeout 完成）。`status` 是否为 `closed` 由 frozenAt + status 一起表达，避免单一 `closedAt` 既要表示「冻结」又要表示「状态」的语义混淆。
- **PlanningEvidence 三层共享**（epic/feature/slice 不细分）——三层的客观部分都是「child 的交付情况」（`childDelivery`），差异只在 child 的层数（epic 的 child 是 feature，slice 的 child 是 wave），结构完全一致，故共享一个 `PlanningEvidence`。slice 的「技术方案落地对照」（IF/DM/ERR/TC 是否在 wave 里真落地）的细化留作 P2 后续迭代（当前用 `childDelivery` + agent 主观 `summary` 覆盖）。
- **`ArtifactRef.kind` 是枚举**——机器可统计交付物类型分布（例如「这次 epic 产出 3 份 spec + 12 份 code + 5 份 test」），比 cw 0.x 的裸 `ref` 字符串更有结构。
- **drift 校验沿用 cw 0.x 的 artifacts-exist gate**：closeout 时 cw 逐条校验 `artifacts[].ref` 指向的文件当前还存在（防 plan 里说要交付 `src/auth.ts`，到 closeout 时该文件却被删/改名/没建）。校验失败 → closeout 被拒，agent 必须修正 artifacts 或补回文件。

#### 5.11.3 closeout 的 3 件事（基于 Evidence）

closeout 阶段对 evidence 做以下 3 件事（沿袭 cw 0.x 的 3 件事，但适配 v5 的跨阶段定位）：

1. **agent 补充 evidence 的主观字段**——填 `summary`（交付小结）+ 确认/补充 `artifacts`（交付物引用清单）。
2. **cw 校验 artifacts 文件存在性**（drift 检查）——逐条验 `artifacts[].ref` 当前是否还存在，沿用 cw 0.x 的 artifacts-exist gate。
3. **cw 冻结 evidence + status → closed**——写 `frozenAt`（evidence 从此不再变），status 从 `retrospected` 推进到 `closed`（不可逆）。

注意：客观部分（`commitHash` / `changedFiles` / `testRunResult` / `childDelivery`）在 closeout 之前就已经由 cw 填好（execute/test 完成时），closeout 不重新生成——只补主观 + 验 drift + 冻结。

---

## 6. feature 的 clarification.spec 内部结构（v5 扁平化）

v5 删掉了 SpecSection 判别联合，feature 的 spec 扁平化为字段（和 slice 的 plan 结构对称）：

```typescript
interface FeatureClarification {
  clarifications: Clarification[];    // 澄清项
  spec: FeatureSpec;                  // 规格化条目（扁平字段）
}

interface FeatureSpec {
  functionalRequirements: FunctionalRequirement[];
  acceptanceCriteria: AcceptanceCriterion[];
  businessCases: BusinessCase[];
  decisions: Decision[];
  outOfScope: string[];
  goals?: string[];
  complexity?: "low" | "medium" | "high" | "unknown";   // 复杂度（标准化枚举，便于统计/排序；未知时填 "unknown"）
  background?: string;                // md 章节
  constraints?: string;               // md 章节
}
```

**FeatureSpec 不进词表主体**——它是 feature 文档对 clarification.spec 内部组织的命名，类比 SlicePlan。具体见 feature 文档。

---

## 7. 未定项（诚实标注）

### 7.1 核心设计状态

| 项 | 状态 | 说明 |
|---|---|---|
| ~~`execReviewJudgment` 的字段结构~~ | **已在 wave 文档定稿** | §5.8 给的是概要（readability/architecture 必填、codeSmells 可选、FollowupAction 结构化、overallVerdict、layerSpecific 具名化），权威定义见 wave §6.1。纯人审，无机器 gate，不阻塞 closeout。model §5.8 已同步：readability/architecture 从可选改为必填、followupActions 从 `string[]` 改为 `FollowupAction[]` |
| ~~`PlanningRetrospectData.splitFulfillment`~~ | **已在 slice 文档定稿：必须覆盖 SlicePlan.split 所有项** | slice §5.1 已定稿：splitFulfillment 必须对照 `SlicePlan.split` 的**所有**项（不能只对照部分），每项给 `delivered` / `partial` / `failed` verdict。slice 是 PlanningUnit 的最底层，最接近执行，其约定适用于三层 PlanningUnit |
| ~~`inheritedItemIds` 的 replan 更新机制~~ | **已定（v5 采用 abort + appendOnly 方案）** | 详见 §5.6。核心机制：上层 replan 废弃条目后，cw 自动计算影响面 + 级联 abort 引用废弃条目的子孙 + 返回给 agent + agent 通过 `cw create` 重建。不在字段层面做「自动迁移」或「下层 replan」。删掉了 `replacedBy` 字段和 `accept-replan` action |

### 7.2 后续文档

| 项 | 说明 |
|---|---|
| `research` / `grilling` skill（create 时返回 skill 列表，agent 按需加载）| Clarification 的 `type` 取值（`"research" \| "grilling"`）对应具体 skill。语义不在 model 固化（见 §5.9）：`create` 时 cw 返回可用 skill 名称 + description，agent 通过 `cw skill <name>` 渐进式加载 skill 的具体执行逻辑（research 怎么调外部查询、grilling 怎么追问等）。skill 可独立演进/新增，model 不需要跟着改 |
| `claim` | 多 agent 并行互斥，后续文档 |
| `ADR` | 重要决策跨 epic 复用，后续文档 |

### 7.3 沿用现有能力（不自己设计）

| 项 | 说明 |
|---|---|
| wave 测试套件发现机制 | 沿用当前 cw 的测试运行能力（TestRunnerMode 支持多语言 + 断言 + 脚本），不自己设计 |
| wave commitHash 关联机制 | 单 commit 已定（agent stdin 传 hash + cw 验 git cat-file -e 存在性）；multi-commit 选哪个沿用当前 cw 的开发能力 |
| AC.verification 字段 | AcceptanceCriterion 的 `verification?: "unit" \| "manual" \| "review"` 字段保持不变（不改名，因为 verify 步骤已改名为 design-review，不再混淆）。消费场景：wave test 阶段如果 verification=unit 则 cw 实跑测试，=manual 退化为人审 |

---

## 8. v4 遗留废弃词（不能当当前概念用）

以下词在 v5 中废弃，仅在历史/迁移说明里可引用：

| 废弃词 | v5 替代 | 废弃理由 |
|---|---|---|
| `verify` / `verifyJudgment` | `design-review` / `designReviewJudgment` | 改名以区分执行前/执行后审查 |
| `refKind` / `specItem` / `techItem` | （删除，不再分类）| id 唯一就能区分，分类冗余 |
| `refId` | `workUnitItemId` | 明确是 WorkUnitItem 的 id |
| `replacedBy`（WorkUnitItem 字段）| （删除）| v5 replan 改为 abort + 重建，cw 不在条目层面维护替代关系（见 §5.6）|
| `accept-replan` action | （删除）| cw 直接 abort，无中间态（见 §5.6）|
| `AbandonedRef.resolvedAt` / `resolvedAction` | （删除）| AbandonedRef 简化为 `{workUnitItemId, abandonedAt}`，纯历史记录，无「待处理→已处理」转换 |
| `plan 项` | （删除统称，用具体类型名）| 没有对应类型 |
| `SpecSection` / `SpecVersion` / `specHistory` / `replaceSpecSections` | FeatureSpec 扁平化 | cw 0.x 历史包袱 |
| `SpecDecision` / `TechDecision` / `SliceDecision` | `Decision` | 跨层统一 |
| `FeatureSplit` / `SliceSplit` / `WaveSplit` | `Split` | 结构完全相同，统一 |
| `EpicPlan` / `FeaturePlan` | `Plan` 基类 | epic/feature 直接用基类 |
| `techPlan` / `TechSection` | SlicePlan 扁平化字段 | 多余的子容器 |
| `EpicPayload` / `FeaturePayload` / `SlicePayload` / `WavePayload` | （删除）| v4 worker 凭空造，无定义 |
| `basedOnAbandoned: boolean` | `abandonedRefs.length > 0`（派生值）| boolean 无法表达多条记录状态 |
| `usedDecisions` / `specCoverage` / `DecisionRecord` / `obsolete` | `basedOnParent` / `abandonedRefs` / `Clarification` / `abandoned` | v4 二期已合并 |
| `Evidence.closedAt`（cw 0.x）| `Evidence.frozenAt` | 语义混淆（closedAt 既要表达「冻结」又要表达「状态」），v5 拆为 `frozenAt`（evidence 冻结时点）+ `status: closed`（状态机）两个字段，见 §5.11 |
| `Evidence.coverage` / `coverageApplicable` / `gateHistory`（cw 0.x 扁平 evidence）| v5 `Evidence` 重新建模为客观/主观/冻结三段（`generatedAt` / 客观字段 / `summary` / `artifacts` / `frozenAt`），见 §5.11 | cw 0.x 的 evidence 是 closeout 一次性的扁平产物；v5 重新定位为跨阶段产物（execute+test 生成客观 → exec-review/retrospect 消费 → closeout 补主观 + 冻结），结构按新职责重设 |

---

## 维护说明

- 本文档是 v5 的**模型定义 + 词表权威源**。v5 各层文档（design-v5-epic.md 等）尚未写，以本文为准。
- **所有用词必须在本文词表内**。新概念必须经过用户决策。
- **代码层基础类型**（WorkUnitItem / Plan / Split / FeatureSpec）是 DRY 复用，不进词表主体，进各层文档附录。
- v4 文档保留为历史参考，但不作为当前设计依据。如 v4 与 v5 冲突，以 v5 为准。

---

## 9. 各层文档写作指引（给 writer subagent 的约束）

本章节是 model 文档对 v5 各层文档（design-v5-epic.md / feature.md / slice.md / wave.md）的硬约束。各层文档必须遵守。

### 9.1 必须遵守的硬约束

| 约束 | 说明 |
|---|---|
| **词表纪律** | 层文档使用的所有领域概念必须出现在本文 §5 词表内。新概念（如 wave 层的 `WaveContract`）必须在 model 文档先经过用户决策，再进层文档 |
| **流程类型正确** | epic/feature/slice 文档描述的是 **PlanningUnit 7 步流程**（无 test/exec-review）；wave 文档描述的是 **ExecutionUnit 9 步流程**（有 test + exec-review）。不能混用 |
| **字段名严格按 §5.2** | 主流程产物字段名（objective/clarifications/plan/designReviewJudgment/executeResult/testJudgment/execReviewJudgment/retrospectData）严格按本文拼写，不能层文档自创别名。**`evidence` 是跨阶段产物**（不是 §5.2 表里某一步独占，见 §5.2/§5.11）：客观部分由 cw 在 execute/test 时填、主观部分由 agent 在 closeout 补、frozenAt 在 closeout 冻结，层文档不能把 evidence 写成「closeout 一次性生成」 |
| **类型继承按 §4.3** | epic/feature plan 用 `Plan` 基类（只 split）；slice plan 用 `SlicePlan extends Plan`；wave plan 用 `WavePlan extends Plan` |
| **Plan 内部条目类型用层前缀** | slice 的条目是 `SliceTechChoice` / `SliceInterface` / `SliceDataModel` / `SliceErrorSpec`；wave 的条目是 `WaveTestCase` / `WaveTask` / `WaveFile` / `WaveContract`（见 §0.4）|
| **不引入 v4 废弃词** | §8 列出的所有废弃词（verify/verifyJudgment/refKind/SpecSection/Payload/EpicPayload 等）不能在层文档里当当前概念用 |
| **execute 有产物** | execute 不能写成「无独立产物」。PlanningUnit 写 `executeResult: PlanningExecuteResult { childUnitIds }`；ExecutionUnit 写 `executeResult: ExecutionExecuteResult { commitHash }`（见 §2.5）|
| **replan 机制严格按 §5.6** | 各层文档描述 replan 时必须采用 **abort + appendOnly** 机制（上层 replan → cw 自动级联 abort 受影响子孙 → 返回给 agent → agent 通过 `cw create` 重建）。**不能写「下层 replan」「accept-replan」「inheritedItemIds 自动迁移」「replacedBy 维护替代关系」等 v5 已废弃的机制** |

### 9.2 各层文档的差异化内容

各层文档**不应该重复 model 文档的公共定义**（流程步骤、状态机、通用字段），而应该聚焦本层差异：

| 层 | 类型 | 文档应聚焦的差异内容 |
|---|---|---|
| **epic** | PlanningUnit | ① epic 作为顶层的特殊点（无 parentUnitId / 无 basedOnParent）② epic 的 plan.split 拆 feature 的依据（按业务边界？按 team？）③ epic 如何启动 feature（递归入口）④ epic 的 designReviewJudgment.layerSpecific 里 epic 关心什么（大方向/优先级/资源？）⑤ epic 的 retrospect 如何验收「feature 组合兑现 epic 目标」 |
| **feature** | PlanningUnit | ① FeatureClarification/FeatureSpec 的完整结构（§6 已给）② FR/AC/UC 的填写规范 ③ feature 的 plan.split 拆 slice 的依据（按技术边界？按文件？）④ feature 的 designReviewJudgment.layerSpecific 里 feature 关心什么（功能完整性/AC 可测性？）⑤ feature 的 retrospect 如何验收「slice 组合兑现 feature spec」⑥ §7.1 的 inheritedItemIds replan 机制（feature→slice 场景） |
| **slice** | PlanningUnit | ① SlicePlan 的完整字段（techChoices/interfaces/dataModels/errorSpecs/decisions，§4.3 已给）② SliceTechChoice/SliceInterface/SliceDataModel/SliceErrorSpec 的字段结构 ③ slice 的 plan.split 拆 wave 的依据（按 commit？按文件？）④ slice 的 designReviewJudgment.layerSpecific 里 slice 关心什么（技术可行性/接口契约？）⑤ slice 的 retrospect 如何验收「wave 组合兑现 slice 技术方案」⑥ slice 的 Decision 如何从 Clarification 投影 |
| **wave** | ExecutionUnit | ① WavePlan 的完整字段（testCases/tasks/files/contracts，§4.3 已给）② WaveTestCase/WaveTask/WaveFile/WaveContract 的字段结构 ③ wave 的 test 阶段（跑测试 + 对照 designReviewJudgment，§5.8 testJudgment）④ wave 的 exec-review 阶段（§5.8 execReviewJudgment 已给结构提案）⑤ wave 的 executeResult.commitHash 如何关联（§7.3 沿用现有能力）⑥ wave 的 AC.verification 字段消费（§7.3）|

### 9.3 各层文档的章节骨架（推荐）

```markdown
# cw 1.0 设计文档 v5 · <层名>层

> 本文是 v5 <层名>层的设计。流程/状态机/通用字段见 [design-v5-model.md](./design-v5-model.md)，
> 本文只描述 <层名> 的差异。本文使用的所有概念以 model 文档词表为准。

## 0. <层名> 是什么（类型、职责、粒度）
   - 引用 model §1.2 的对照表本行
   - 说明本层在 4 层里的位置

## 1. <层名> 的流程
   - 引用 model §2 的对应流程（PlanningUnit 7 步 / ExecutionUnit 9 步）
   - 重点写本层各步骤的**业务内容**，不重写步骤定义

## 2. <层名> 的 plan 结构（差异重点）
   - epic/feature：Plan 基类的 split 内容（拆下层依据）
   - slice：SlicePlan 完整字段 + 各条目类型结构
   - wave：WavePlan 完整字段 + 各条目类型结构

## 3. <层名> 的 designReviewJudgment.layerSpecific
   - 本层 design-review 阶段关心的维度（在 model §5.8 共享字段之外）

## 4. <层名> 的 execute
   - PlanningUnit：executeResult.childUnitIds + 启动下层机制
   - ExecutionUnit：executeResult.commitHash + AC.verification 消费

## 5. <层名> 的验收（retrospect / test+exec-review）
   - PlanningUnit：retrospect 兼验收（PlanningRetrospectData）
   - ExecutionUnit：test + exec-review 两步

## 6. <层名> 的 replan（差异）
   - 本层被 replan 时的行为 / 本层 replan 下层时的传播
   - inheritedItemIds 在本层场景下的处理（§7.1 待定项在本层的体现）

## 7. 未定项（本层相关）
   - 引用 model §7.1 中本层相关的未定项

## 附录 A. 完整 TS 接口（本层涉及的全部）
   - 把 model §1.4/§4/§5/§6 里本层涉及的接口集中放这里，方便实现参考
```

### 9.4 审查要点（给 reviewer subagent 的检查清单）

每个层文档写完后，reviewer 必须按以下清单检查：

1. **词表纪律**：文档里出现的所有领域概念是否都在 model §5 词表内？有没有私自造的新概念？
2. **流程类型正确**：epic/feature/slice 是 7 步（无 test/exec-review）？wave 是 9 步（有 test+exec-review）？
3. **字段名拼写**：主流程产物字段名是否严格按 model §5.2？
4. **类型继承**：plan 类型继承是否按 model §4.3？条目类型是否带层前缀（§0.4）？
5. **无 v4 废弃词**：model §8 列的废弃词有没有出现？
6. **execute 有产物**：execute 是否写成有产物（childUnitIds/commitHash）？
7. **不重复 model 内容**：是否把 model 文档的公共定义（流程/状态机/通用字段）抄过来了？应该引用而不是重复
8. **本层差异聚焦**：文档是否聚焦 §9.2 要求的本层差异内容？
9. **未定项标注**：本层相关的未定项是否明确引用 model §7.1？
10. **TS 接口完整**：附录是否集中了本层涉及的全部接口？

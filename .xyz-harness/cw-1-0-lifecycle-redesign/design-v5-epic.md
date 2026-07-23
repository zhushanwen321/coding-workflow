# cw 1.0 设计文档 v5 · epic 层

> 本文是 v5 epic 层的设计。流程/状态机/通用字段见 [design-v5-model.md](./design-v5-model.md)，本文只描述 epic 的差异。本文使用的所有概念以 model 文档词表为准。
>
> epic 是 **PlanningUnit**，走 7 步流程（无 test、无 exec-review）。读者请先读 model 文档，再读本文。

---

## 0. epic 是什么（类型、职责、粒度）

引用 model §1.2 的对照表：epic 是 **PlanningUnit**，4 层的**顶层**。

| 维度 | epic |
|---|---|
| 类型 | PlanningUnit（规划型）|
| 职责 | 把一个大目标翻译/拆解成若干 feature，让 feature 层能接手 |
| execute 做什么 | 启动 feature 层（递归入口），自己不写代码 |
| 粒度 | 跨多 session，可能持续数周 |
| 写不写代码 | 否（代码只在 wave 层产出）|

**epic 在 4 层里的位置**：epic 是 PlanningUnit 的**顶层**。没有上游（epic 是 4 层中唯一没有父层的层，详见 §0.1），唯一下游是 feature（需求 spec 层）。epic 之下隔着 feature 和 slice 两层才到 wave（写代码的层）——epic 完全不直接接触代码或技术方案。

**epic 的核心职责**：把战略目标（`objective`）翻译成 feature 能接手的**需求方向**。epic 的决策沉淀在 `Clarification.resolution` 里——典型是「认证用 OAuth 还是 session」「支持哪些角色」「token 存哪类位置」这种**方向级**的战略问题，不细化到具体需求条目。

**epic 的核心产物**：**只有 Clarification**（澄清项 + 其中的 resolution）。epic **不持有 spec**——`FunctionalRequirement` / `AcceptanceCriterion` / `BusinessCase` 是 feature 层 `FeatureSpec` 的事（model §5.7/§6），epic 不写「系统要能做什么」这种具体需求。epic **不做技术方案**——`SliceTechChoice` / `SliceInterface` / `SliceDataModel` / `SliceErrorSpec` 是 slice 层 `SlicePlan` 的事（model §5.7），epic 不选库、不画接口签名、不定数据模型。epic 的 plan 直接用 `Plan` 基类，只有 `split`（拆 feature 清单），无任何规格化条目（§2.1）。

**和 feature 的边界**：epic 决定「做哪些大块 / 关键架构方向」，feature 把这些方向翻译成具体需求（FR/AC/UC）。
- epic 说「用 OAuth」（方向）→ feature 写 `FR1: 用户能用 GitHub 账号登录` / `FR2: 用户能用 Google 账号登录` / `FR3: 登录失败时展示分类错误提示`（具体需求 + 对应 AC/UC）
- epic 说「支持 admin/user/guest 三种角色」（方向）→ feature 写每种角色具体能做什么、权限边界在哪（FR/AC）
- 判据：能一句话说清「往哪个方向走」→ 归 epic；需要拆成多条可验收的具体需求 → 归 feature

**和 slice 的边界**：epic 完全不碰技术实施细节——slice 是纯技术层，和 epic 之间隔着 feature。epic 的 Clarification 即使提到「token 存 httpOnly cookie」这种带技术味的方向，也不是技术方案（token 交换用哪个库、接口签名长什么样、错误态怎么向上抛——这些是 slice 的 `SlicePlan` 条目）。如果 epic design-review 时发现某个方向的技术可行性存疑，应该把「调研这个方向的可行性」作为一个 Clarification 加进 epic 的 clarify 阶段，而不是在 epic 层直接做技术判断（§3.3）。

典型 epic 例子：「重构认证系统」「把单体应用拆成微服务」「从 JavaScript 迁移到 TypeScript」。共同点：大到一次开不完，需要先想清楚拆成几个独立的 feature。

### 0.1 epic 作为顶层的特殊点

epic 是 4 层中唯一没有父层的层，因此有三个**专属的「空」**：

| 字段 | epic 的值 | 理由 |
|---|---|---|
| `parentUnitId` | 不存在（undefined）| 没有父层 |
| `basedOnParent` | 永远是 `[]` | 没有上游条目可引用 |
| `abandonedRefs` | 永远是 `[]` | 没有上游会废弃引用给 epic |

**直接后果**：
- epic 永远不会被上游 replan 影响（没有上游）——epic 永远不进入「被级联 abort」的链路，只有自己主动 `cw abort` 才会变 aborted（§6.6）
- epic 的所有「上游决策」都在 epic 内部产生（Clarification），不来自外部继承
- epic 的 replan 只向**下游**（feature）传播，不会向上反弹

---

## 1. epic 的流程

epic 走 **PlanningUnit 7 步**（model §2.1）：

```
create → clarify → plan → design-review → execute → retrospect → closeout
 创建     澄清    规划     设计审查          执行     复盘兼验收    收尾
```

**epic 没有 test 和 exec-review**——这是 PlanningUnit 的判别特征（model §1.4）。epic 的验收在 retrospect 阶段做（兼验收，见 §5）。

各步骤在 epic 层的具体业务内容：

| 步骤 | epic 层做什么 | 产物字段 |
|---|---|---|
| create | 写 objective（这个 epic 完成后世界长什么样，1-2 句话）| `objective` |
| clarify | 识别推进 epic 必须先回答的**战略决策**（用 OAuth 还是 session？支持哪些角色？token 存哪？）| `clarifications: Clarification[]` |
| plan | 拆 feature（split 依据见 §2）| `plan: Plan` |
| design-review | 审方案是否值得做（共享维度 + epic 专属维度，见 §3）| `designReviewJudgment` |
| execute | 启动 feature 层，等所有 feature 走完各自流程。**cw 同步初始化 evidence 的客观字段**（PlanningEvidence，详见 §4.5）| `executeResult: PlanningExecuteResult` |
| retrospect | **兼做验收**（feature 组合兑现 epic 目标吗）+ 提炼经验（见 §5）。**evidence 在此被消费**作为验收输入（详见 §5.1）| `retrospectData: PlanningRetrospectData` |
| closeout | 补 evidence 主观部分 + cw 校验 artifacts drift + 冻结 evidence（`frozenAt`）→ status `closed`。evidence 的客观部分在 execute 阶段已生成（§4.5）并在 retrospect 阶段随 child feature 状态变化更新，closeout 只补主观 + 验 drift + 冻结，归档不可逆 | `evidence`（冻结）|

**status 流转**：见 model §3.1 的 PlanningUnit 8 状态。注意状态名是 `design-reviewed`（不是 v4 的 `verified`），且**没有 `tested` 状态**（那是 ExecutionUnit 才有的）。

---

## 2. epic 的 plan 结构（Plan 基类 + split 拆 feature 依据）

### 2.1 类型

epic 的 plan 直接用 **Plan 基类**（model §4.2/§4.3），不定义 EpicPlan：

```typescript
interface Plan {
  split: Split[];   // 每个 Split = 一个 feature
}

interface Split {
  slug: string;                              // feature 的 slug（如 "oauth-login"）
  description: string;                       // 这个 feature 大概做什么（一句话）
  dependsOn: string[];                       // 依赖哪些其他 split.slug（DAG，无环）
  inheritedItemIds?: string[];               // 这个 feature 继承 epic 的哪些 Clarification id
}
```

**epic 的 plan 只有 split**——epic 不写 spec（feature 层的事），不做技术方案（slice 层的事），这是 §0 已声明的层间边界在本层的直接体现。epic 的所有「上游决策」沉淀在 `clarifications[].resolution`（§0），plan 只负责把方向拆成 feature 清单。`split` 字段不进词表主体，它是代码层 DRY 复用（model §4）。

### 2.2 Split 拆 feature 的依据：业务边界

> 这是 epic 层的核心设计决策。

**推荐方案：按业务边界拆，每个 feature = 一个独立的用户可感知能力。**

理由：

| 理由 | 说明 |
|---|---|
| **对齐 feature 的定义** | model §1.2 把 feature 定义为「单个用户可感知的独立特性」——拆分依据必须和定义一致 |
| **业务语义保留** | epic 是业务目标层，拆分应保留业务语义，让每个 feature 独立有价值、可独立交付 |
| **并行开发** | 按业务边界拆，feature 之间耦合最低，可并行推进（cw 的多 agent 并行场景）|
| **可独立验收** | 业务边界清晰，retrospect 阶段才能逐 feature 验收（splitFulfillment 有明确对照，见 §5）|

**例子**（epic = 「重构认证系统」按业务边界拆）：

| feature slug | 用户可感知能力 | dependsOn |
|---|---|---|
| `session-management` | 用户能登录/登出/保持会话 | — |
| `oauth-login` | 用户能用第三方账号登录 | `session-management` |
| `permission-control` | 不同角色看到不同内容 | `session-management` |

**反模式**（不要这样拆）：

| 反模式 | 为什么不行 |
|---|---|
| **按 team 拆** | team 会重组，代码和组织不应耦合。team 因素可以放到 `designReviewJudgment.layerSpecific.resourceEstimate`（§3.2）里作为次要参考，但不能作为拆分主依据 |
| **按文件/模块拆** | 粒度太低，丢失业务语义——这是 slice 层的拆分维度（slice 按「单 session 可完成的技术实施单元」拆）|
| **按阶段拆（MVP→V2）** | 阶段是时间维度，会让 feature 之间产生人为依赖，丧失并行性。阶段应在 `designReviewJudgment.layerSpecific.priorityRationale` 里讨论 |

**`dependsOn` 反映业务依赖**：feature A 依赖 feature B，意思是「A 需要先把 B 建的能力接上来才能完成自己的目标」。DAG 必须无环（机器 gate 校验，见 §2.4）。

### 2.3 inheritedItemIds：声明 feature 继承哪些 epic 决策

每个 Split 的 `inheritedItemIds` 显式声明「这个 feature 基于 epic 的哪些 Clarification」（model §4.2）。

**例子**：
```typescript
// epic auth-refactor 的 Clarification：
//   D1: "认证用 OAuth 还是 session？" → "新功能用 OAuth"
//   D2: "支持哪些角色？" → "admin/user/guest"
//   D3: "token 存哪？" → "httpOnly cookie"

// epic plan.split：
[
  {
    slug: "oauth-login",
    description: "OAuth 登录",
    dependsOn: ["session-management"],
    inheritedItemIds: ["D1", "D3"]   // 基于 D1 和 D3，不基于 D2
  },
  {
    slug: "permission-control",
    description: "权限控制",
    dependsOn: ["session-management"],
    inheritedItemIds: ["D1", "D2"]   // 基于 D1 和 D2，不基于 D3
  }
]
```

**execute 时**，cw 把 `inheritedItemIds` 写入对应 feature 的 `basedOnParent`（见 §4.2）。

**为什么不是「全量继承」**：见 model §4.2——v4 的「cw 自动全量拷贝上游所有 id 到下游 basedOnParent」会污染下游（下游不用的 id 也被记下来）。v5 改为 plan 阶段显式声明，execute 时按声明写入。

### 2.4 plan 阶段的机器 gate（建议）

epic 的 plan gate（实现层参考）：

- `all-decisions-resolved`：所有 `clarifications[].resolution` 非空（progressive 推进的完成度判据）
- `feature-split-non-empty`：`plan.split` 至少一项
- `feature-split-dag-valid`：`dependsOn` 依赖关系无环
- `inherited-item-ids-valid`：每个 `split.inheritedItemIds` 的 id 都能在 epic 的 `clarifications` 里找到（防止声明继承不存在的 id）

---

## 3. epic 的 designReviewJudgment.layerSpecific

### 3.1 共享字段（不重复）

designReviewJudgment 的共享字段见 model §5.8：`necessity` / `sufficiency` / `alternatives` / `tradeoffs` / `risks`。这些维度所有层都填，epic 也不例外。各字段的语义见 model 词表，本文不重述。

### 3.2 epic 专属维度（layerSpecific）

epic 作为顶层规划层，关心的维度和 feature/slice 不同。epic 专属判断填入 `designReviewJudgment.layerSpecific`。按 model §5.8「layerSpecific 具名化约定」（各层应定义具名 interface 收紧，最低限度 `Record<string, string>`），epic 定义 **`EpicDesignReviewLayerSpecific`**（对齐 slice 的 `SliceDesignReviewLayerSpecific` 和 feature 的 `FeatureDesignReviewLayerSpecific`），把下列 5 个 key 收进具名 interface：

```typescript
// epic 层 design-review 的专属判断（model §5.8 layerSpecific 具名化约定）
interface EpicDesignReviewLayerSpecific {
  strategicAlignment: string;      // 战略对齐
  featureSplitRationale: string;   // 拆分依据
  scopeBoundary: string;           // 范围边界
  priorityRationale: string;       // 优先级依据
  resourceEstimate: string;        // 资源估算
}
```

**`EpicDesignReviewLayerSpecific` 的所有字段都是必填**——这 5 个是 epic design-review 的硬性问题，缺一不可。各字段语义：

| layerSpecific 字段 | 含义 | epic 层特有性 |
|---|---|---|
| `strategicAlignment` | **战略对齐**：这个 epic 是否服务更大的产品/业务方向？为什么是**现在**做（不是半年前/半年后）？| epic 是顶层，必须回答「这个目标本身值不值得做」——feature/slice 不需要回答这个（它们的合理性继承自上层已定稿）|
| `featureSplitRationale` | **拆分依据**：为什么拆成这几个 feature？考虑过但没选的其他拆分方式是什么（如按 team、按阶段）？为什么没选？| 直接对应 §2.2 的拆分决策，留下理由供 retrospect 对照 |
| `scopeBoundary` | **范围边界**：这个 epic **明确不做**什么？| 顶层最容易 scope creep——明确写下「不做什么」是对抗它的唯一办法 |
| `priorityRationale` | **优先级依据**：`dependsOn` 的顺序依据是什么？哪些 feature 必须先做（解除依赖/最早交付价值）？| DAG 决定了执行顺序，顺序背后必须有理由 |
| `resourceEstimate` | **资源估算**：每个 feature 的粗略工作量（高/中/低 或 session 数估计）。整个 epic 在预期时间内可行吗？| epic 跨多 session，必须做粗略可行性判断 |

**说明**：
- 这些是 `nextAction.guidance` 提示 agent 思考的维度，**内容质量由 agent 负责**，cw 只验字段非空（机器 gate 不验内容对错，见 model §9.4 审查要点）
- 所有 layerSpecific 字段都是 agent 的人审判断，gate 只验非空，不验内容（model §5.8 的诚实原则）
- 这些字段是 epic 层对 KV 扩展点的具名化填充，不是新的领域概念（不进词表）

### 3.3 epic 不关心的维度（区别于其他层）

这是 §0 已声明的层间边界在 design-review 阶段的兜底细化——一句话再钉死一遍，防止 design-review 时手伸太长：

- **功能完整性 / AC 可测性**：feature 层的事（feature 写 `FunctionalRequirement` / `AcceptanceCriterion` + UC，关心 spec 完整、AC 可测）
- **技术可行性 / 接口契约**：slice 层的事（slice 写 `SliceTechChoice` / `SliceInterface` / `SliceDataModel` / `SliceErrorSpec`，关心方案能不能落地）
- **代码品味**：wave 层的事（wave 的 `execReviewJudgment`）

epic 不下沉到这些细节——如果 design-review 时发现某个 feature 的可行性存疑，应该把「调研这个 feature 的可行性」作为一个 Clarification 加进 epic 的 clarify 阶段，而不是在 epic 层直接做技术判断。

---

## 4. epic 的 execute（启动 feature / childUnitIds）

### 4.1 execute 产物

```typescript
interface PlanningExecuteResult extends ExecuteResult {
  childUnitIds: string[];   // feature 的 id 列表（如 ["feature:auth-refactor/oauth-login", ...]）
}
```

epic 的 executeResult 持有它启动的所有 feature 的 id。**这是 PlanningUnit 的判别特征之一**（vs ExecutionUnit 的 `{ commitHash }`，见 model §1.4）。

### 4.2 execute 做什么

epic 的 execute = **启动 feature 层（递归入口）**：

1. 遍历 `plan.split`，为每个 Split 创建一个 feature 实例（feature id 形如 `feature:<epic-slug>/<feature-slug>`）
2. 每个 feature 的 `parentUnitId` 指向本 epic
3. 每个 feature 的 `basedOnParent` 初始化为对应 Split 的 `inheritedItemIds`（来自 §2.3）
4. 每个 feature 进入自己的 PlanningUnit 7 步流程（create → ... → closeout）
5. 把所有 feature 的 id 写入 `executeResult.childUnitIds`

### 4.3 epic 在 execute 阶段做什么

**等。** epic 进入 `executing` 状态（长状态，可能跨多 session、数周），等所有 feature 走完各自流程。

- 期间 feature 各自推进，epic 自身不改状态
- 如果某个 feature 在开发中发现 epic 的 Clarification 需要改，走 epic 的 `replan`（见 §6）
- 所有 feature 都到达终态（`closed` 或 `aborted`）后，epic 才能进入 `retrospect`

### 4.4 feature 失败（aborted）怎么办

epic **不要求**所有 feature 必须 `closed`——允许部分 feature `aborted`。retrospect 阶段的 `splitFulfillment`（§5）会标出哪些 split 未兑现，由 agent 判断是否影响 epic 整体交付（`deliveryVerdict`）。

典型场景：3 个 feature 里 `permission-control` 因技术不可行 aborted，但 `session-management` 和 `oauth-login` 都 closed 且兑现了主线目标——`deliveryVerdict` 可以是 `partial`，epic 仍可进入 closeout（不是所有失败都要回炉）。

### 4.5 execute 完成时初始化 PlanningEvidence（客观部分）

epic 的 `evidence` 是 **`PlanningEvidence`**（model §5.11，跨阶段产物，**不是 closeout 独占**）。execute 启动 feature 后，cw 立即初始化 evidence 的**客观字段**：

- `generatedAt`：evidence 首次生成时间（ISO 8601）
- `childDelivery: ChildDeliveryRecord[]` 的**初始快照**——每个 `plan.split` 项对应一条记录：
  - `splitSlug`：split 的 slug
  - `childUnitId`：cw 刚创建的 feature id
  - `childStatus`：feature 此刻刚 created，还未到 `"closed" | "aborted"` 任一终态——该字段在初始快照里暂记为 feature 当前 status 的映射（实现侧可用 nullable / 中间值表达「未到终态」），**等 feature 进入终态（closed 或 aborted）时才更新为对应的终态值**（model §5.11.1 的 `childStatus: "closed" | "aborted"` 指的是 child 最终状态，rollup 在 child 到终态后才完整）
  - `childEvidenceSummary?`：留空（feature 还没有自己的 evidence.summary，等 feature closeout 后 rollup 上来）

**childDelivery 是「初始快照」，会随 child feature 状态变化更新**（直到 closeout 冻结才定格）：

- feature 状态推进（如 `created → ... → closed`）时，cw 更新对应 `childDelivery[].childStatus`
- feature closeout 冻结自己的 evidence 后，cw 把 feature 的 `evidence.summary` rollup 到对应 `childDelivery[].childEvidenceSummary`
- feature 被 abort（epic replan 触发级联 abort，§6）时，对应 `childDelivery[].childStatus` 更新为 `"aborted"`

**evidence 此时只填客观部分**——主观部分（`summary` + `artifacts`）和冻结（`frozenAt`）留到 closeout（§5.6）。详见 model §5.11 / §5.11.3。

---

## 5. epic 的验收（retrospect 兼验收）

epic 没有 test 阶段——**验收在 retrospect 阶段做**（PlanningUnit 的判别特征，model §2.1）。这是 v5 对 v4 的关键变更：v4 的 test（集成验收）和 retrospect（对照判断）职责重叠，v5 合并。

epic 的 retrospect **兼做两件事**（model §5.8 的 `PlanningRetrospectData`）：
1. **验收**：feature 组合起来兑现了 epic 的 objective 吗？（对照 designReviewJudgment 的 sufficiency）
2. **复盘**：designReviewJudgment 哪些判断事后证明错了？（提炼经验）

### 5.1 验收的输入：三者对照（evidence 消费）

PlanningUnit 的 retrospect 兼验收——agent 在验收时**同时看三样东西**，缺一不可：

| 输入 | 来自 | 回答的问题 |
|---|---|---|
| ① **clarification + plan**（epic 的战略决策 + `plan.split`）| clarify / plan 阶段 | **要做什么**：epic 定了哪些方向（Clarification）、拆了哪些 feature |
| ② **designReviewJudgment**（含 `EpicDesignReviewLayerSpecific`，§3.2）| design-review 阶段 | **期望什么 / 方案对不对**：当初认为 feature 拆分是否合理、scope 边界是否清晰、优先级是否正确 |
| ③ **PlanningEvidence**（`childDelivery`，§4.5）| execute 阶段 cw 自动填 | **实际做了什么**：每个 split 对应的 child feature 交付了吗、最终 status 是 closed 还是 aborted |

**三者对照才能验收「下层组合兑现了我的规划吗」**——只看 ① + ② 是「纸上验收」（方案对，但不知道实际交付没），只看 ③ 是「盲目验收」（交付了，但不知道该不该交付这些）。必须三者放在一起：①② 是期望，③ 是实际，对照才知道兑现度。

**evidence 绑定 plan**：`PlanningEvidence.childDelivery` 的每条记录按 `splitSlug` 对照 `plan.split`——每个 split 项有没有对应的 child、child 最终交付了没。这给 `splitFulfillment`（§5.3）提供客观依据。

**evidence 绑定 judgment**：`PlanningRetrospectData.deliveryVerdict`（§5.3）引用 evidence 的客观交付情况作判断依据——`childDelivery` 里多少 feature closed / aborted、aborted 的 feature 影响了哪些 split，直接影响 `deliveryVerdict` 取 `delivered` / `partial` / `failed`。

**evidence 和 PlanningRetrospectData 的分工**（不互相替代，model §5.8）：

| 产物 | 定位 | 谁填 | 性质 |
|---|---|---|---|
| `PlanningEvidence.childDelivery` | **客观交付记录**（rollup）| cw 自动填 | 事实（feature 最终 status + child evidence summary 引用）|
| `PlanningRetrospectData.deliveryVerdict` / `childUnitIdsEvidence` / `splitFulfillment` | **主观验收结论** | agent 在 retrospect 时填 | 判断（基于客观记录 + agent 对 objective 兑现度的主观评估）|

agent 填 `childUnitIdsEvidence` / `splitFulfillment` 时**引用** `PlanningEvidence.childDelivery` 提供的客观数据（如「feature-A 最终 aborted，evidence 显示...」），但结论（delivered/partial/failed）是 agent 的主观判断——evidence 只说「交付了什么」，不说「算不算兑现」。两者是不同产物，不互相替代。

### 5.2 PlanningRetrospectData 结构

```typescript
interface PlanningRetrospectData extends RetrospectData {
  // 兼做验收：回答「下层组合起来兑现了我的规划吗」
  deliveryVerdict: "delivered" | "partial" | "failed";
  childUnitIdsEvidence: { childId: string; status: "closed" | "aborted"; closeoutEvidenceSummary?: string }[];
  // 每个 split 项的兑现情况（split 来自 plan，对照 designReviewJudgment 的 sufficiency）
  splitFulfillment: { splitSlug: string; verdict: "delivered" | "partial" | "failed"; note?: string }[];
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
// 四个数组元素类型（WrongJudgment / BadTradeoff / MissedGap / ProcessIssue）的完整定义见 model §5.8 及本文附录。
```

### 5.3 epic 验收要回答的问题

**验收部分**（PlanningRetrospectData 的三个扩展字段）：

| 字段 | epic 层怎么填 |
|---|---|
| `deliveryVerdict` | 整体判断：objective 兑现了吗？`delivered` = objective 兑现；`partial` = 主线兑现但有缺失；`failed` = 主线没兑现 |
| `childUnitIdsEvidence` | 逐 feature 列出状态 + closeout 证据（哪些 closed、哪些 aborted、aborted 的有没有影响 objective 兑现）。机器可验「所有 `executeResult.childUnitIds` 都被覆盖」（防漏验）|
| `splitFulfillment` | 逐 split（对应 `plan.split` 的每一项）判断兑现情况。和 `designReviewJudgment.sufficiency` 对照——当初认为这些 feature 加起来 MECE 覆盖 objective，实际兑现了吗？|

**`deliveryVerdict` vs `splitFulfillment` 的关系**：
- `splitFulfillment` 是逐项的细粒度判断
- `deliveryVerdict` 是整体的粗粒度判断
- 两者**不必机械一致**——可能某些 split `partial` 但整体 `delivered`（关键路径都成了），也可能大部分 `delivered` 但整体 `failed`（关键路径断了）。`deliveryVerdict` 由 agent 综合 `splitFulfillment` + `childUnitIdsEvidence` + objective 做判断，机器只验非空。

### 5.4 复盘要回答的问题

**复盘部分**（基类 RetrospectData 的字段，对照 designReviewJudgment，model §5.8）：

| 复盘维度 | epic 要回答的问题 |
|---|---|
| **reviewedItems** | 逐项回顾 designReviewJudgment 的每条判断（necessity/sufficiency/alternatives + 每个 tradeoff id + 每个 risk id），标 `fulfilled` / `partial` / `unfulfilled` |
| **wrongJudgments**（结构化）| design-review 阶段哪些判断事后看错了（如标的高风险实际很低、判断的 gap 实际不存在）|
| **badTradeoffs**（结构化）| 哪些妥协事后看不值得（代价远超预期，或换来的收益没兑现）|
| **missedGaps**（结构化）| design-review 没发现、retrospect 阶段才暴露的 MECE gap |
| **processIssues**（结构化）| feature 拆分合理吗？多 feature 协作顺畅吗？Clarification 有遗漏吗？|
| **lessonsLearned**（必填）| 下次做类似 epic 最该记住的 1-3 条经验 |

> 四个结构化数组（`wrongJudgments` / `badTradeoffs` / `missedGaps` / `processIssues`）的元素类型见 model §5.8 及本文附录。从 `string[]` 改为结构化对象数组是为了让机器能验「指向」（如 `WrongJudgment.judgmentRef` 指向 designReviewJudgment 的某条判断 id、`BadTradeoff.tradeoffRef` 指向某条 tradeoff id），和 model §5.8 保持一致。

### 5.5 机器 gate（建议）

epic 的 retrospect gate（实现层参考）：

- `lessons-learned-non-empty`：`retrospectData.lessonsLearned` 非空（没有提炼出经验的 retrospect 是失败的 retrospect）
- `reviewed-items-cover-design-review`：`reviewedItems` 覆盖 designReviewJudgment 每一项（机器验覆盖，不验 outcome 对错）
- `child-unit-evidence-complete`：`childUnitIdsEvidence` 覆盖 `executeResult.childUnitIds` 每一项
- `split-fulfillment-complete`：`splitFulfillment` 覆盖 `plan.split` 每一项（slice 文档已定稿：必须覆盖所有 split 项，见 §7）
- `delivery-verdict-non-empty`：`deliveryVerdict` 必填

**诚实说明**（model §9.4 审查要点）：机器只验「该填的都填了、该对照的都对照了」，验不了「verdict 判断得对不对、lessons 深不深」——后者是人审职责。

### 5.6 closeout 冻结 evidence（3 件事）

retrospect 通过后进入 closeout，对 `PlanningEvidence` 做以下 3 件事（model §5.11.3）：

1. **agent 补充 evidence 的主观字段**——填 `summary`（交付小结，1-2 句话）+ 确认/补充 `artifacts: ArtifactRef[]`（交付物引用清单，如 epic objective 的最终交付状态文档、关键 retrospect 报告路径）。
2. **cw 校验 artifacts 文件存在性**（drift 检查）——逐条验 `artifacts[].ref` 当前是否还存在（防 plan 里说交付了某文档，到 closeout 时该文件却被删/改名/没建）。校验失败 → closeout 被拒，agent 必须修正 artifacts 或补回文件。
3. **cw 冻结 evidence + status → closed**——写 `frozenAt`（evidence 从此不再变，`childDelivery` 等客观部分也一并定格），status 从 `retrospected` 推进到 `closed`（不可逆）。

**注意**：evidence 的客观部分（`generatedAt` / `childDelivery`）在 execute 阶段已由 cw 填好（§4.5），并在 retrospect 阶段随 child feature 状态变化更新过——closeout **不重新生成客观部分**，只做「补主观 + 验 drift + 冻结」三件事。evidence 是跨阶段产物（model §5.2 / §5.11），closeout 只是它的终点站，不是它的诞生地。

---

## 6. epic 的 replan

### 6.1 epic 能 replan 什么

epic 支持 replan 追踪的条目（继承 WorkUnitItem 的）只有 **Clarification**——epic 的 plan 是 Plan 基类，只有 split，而 `Split` 无 lifecycle 不支持 replan（model §4.1）。因此 **epic 的 replan 只能废弃/替换 Clarification**。

> **关于 Decision**：epic 不持有 Decision——Decision 需 `decisions` 容器（见 SlicePlan / FeatureSpec），epic 的 plan 只有 split，无此字段；epic 的决策沉淀在 `Clarification.resolution` 里（model §5.9）。Decision 不继承 WorkUnitItem，跟随 Clarification replan（model §5.10），epic replan Clarification 即等同于 replan 了对应决策。

### 6.2 replan 机制（共享，不重复）

v5 的 replan 机制采用 **abort + appendOnly**（model §5.6）：上层 replan 废弃条目后，cw 自动计算下游影响面，把引用了废弃条目的下层（及其所有子孙）**级联 abort**，然后返回影响面给 agent，由 agent 决定是否通过 `cw create` 重建。

完整 4 步流程（本地变更 → 影响面计算 → 级联 abort → 返回给 agent）见 model §5.6.2。本文不重述机制，只讲 epic 层的差异。

### 6.3 epic 作为顶层的 replan 特殊性

epic 是 4 层顶层，replan 有三个特殊点：

| 特殊点 | epic 的表现 | 理由 |
|---|---|---|
| **无上游** | epic 永远不会被上游 replan 影响：`basedOnParent` 永远是 `[]`，`abandonedRefs` 永远是 `[]`（model §5.3）| epic 没有父层 |
| **只能 replan 自己的 Clarification** | epic replan 的对象只有 `clarifications` 里的 Clarification | epic 的 plan 只有 split，`Split` 无 lifecycle 不支持废弃（model §4.1）|
| **下游影响面 = feature 层及其子孙** | epic replan 废弃某 Clarification 后，cw 计算影响面的对象是 feature 层，并级联到该 feature 下的所有 slice / wave | feature 是 epic 的唯一下层 |

### 6.4 epic replan 的下游影响（feature 层级联 abort）

epic replan 一个 Clarification（如 D1「用 OAuth」→「自研」）时，cw 按 model §5.6.2 的流程处理：

1. **本地变更（Step 1）**：被废弃的 Clarification `status="abandoned"`；如果是「替换/拆分」场景，新增的 Clarification `status="active"`，id 新分配。epic 的 status 不变（replan 是旁路 action）。所有变更 append 到 statusHistory / 条目记录，永不重写。
2. **影响面计算（Step 2）**：cw 递归遍历所有 feature 子孙，对比每个子孙的 `basedOnParent` × epic 当前 Clarification 状态。命中规则：`feature.basedOnParent` 含已废弃的 Clarification id → 该 feature 受影响。级联规则：feature 受影响 → 它下面的所有 slice / wave 一并受影响（父废弃，子无意义）。
3. **级联 abort（Step 3）**：cw 自动把所有受影响的子孙（feature / slice / wave）`status="aborted"`，同时在受影响子孙的 `abandonedRefs` 追加 `{ workUnitItemId, abandonedAt }`。cw 只改 status，不动 git（已 closeout 的 wave 的 commit 保留为 git 历史）。
4. **返回给 agent（Step 4）**：
   ```
   replan result:
     aborted: [受影响的 feature / slice / wave id 列表]   // cw 已自动 abort
     preserved: [未受影响的子孙 id 列表]                  // 保留原样
     pendingRebuild:                                      // 提示 agent 需要重建
       - 描述「哪些 epic Clarification 失去了承接的 feature」
         (如「D1 没有对应的 feature 承接」)
       - agent 决定是否重建、怎么重建
   ```

**关键点**：feature 的 `basedOnParent` 来自 execute 时 epic `plan.split` 的 `inheritedItemIds`（§2.3/§4.2）。所以「哪些 feature 受影响」**精确取决于 plan 阶段声明的继承关系**——这是 v5 把继承关系从「全量拷贝」改为「显式声明」的直接收益：replan 影响面查询精确，不污染未引用的 feature。

### 6.5 重建（agent 主导，通过 cw create）

agent 看 replan 返回的 `pendingRebuild`，决定怎么重建（model §5.6.3）：

- **场景 A（纯删除）**：epic 纯废弃 D2（如「不再支持 guest 角色」）→ cw 自动 abort 引用 D2 的 feature 及其子孙。agent 核实 cw 的处理，无需重建（D2 的决策没了就是没了）。
- **场景 B（替换/拆分）**：epic 把 D1「用 OAuth」拆成 D1a「OAuth 用于 toC」+ D1b「自研用于 toB」→ cw abort 引用 D1 的 feature 及其子孙，agent 决定怎么承接 D1a/D1b（新建 feature 承接？合到现有 feature？都不接？）。**重建走 `cw create`**（新建 feature 走正常流程），不是「feature replan」。

**重建的典型动作**：
```
agent: "新建 feature-oauth 承接 D1a，新建 feature-self-auth 承接 D1b"
cw create feature --parent=epic --inheritedItemIds=[D1a]
cw create feature --parent=epic --inheritedItemIds=[D1b]
```

新建的 feature 走正常流程（create → clarify → plan → ...），不是 replan。feature 的 `basedOnParent` 在 execute 时按新声明的 `inheritedItemIds` 写入（§4.2）。

### 6.6 epic 自己永远不会被 replan 影响

epic 是顶层：

- `basedOnParent` 永远是 `[]`（没有上游）
- `abandonedRefs` 永远是 `[]`（没有上游会给 epic 废弃引用）

所以 epic 永远不在「被上游 replan 影响 → 进入 aborted」的链路里——epic 的 abort 只来自自己主动 `cw abort epic:<id>`，或 epic 自己被更高层级的流程终结（没有更高层级，所以实际只有前者）。

### 6.7 epic replan 的 status 不变

和所有层一致：replan **不改 epic 的 status**（在 `design-reviewed` 调 replan 还是 `design-reviewed`；在 `executing` 调还是 `executing`）。replan 是「加变更记录 + 级联 abort 下游 + 返回影响面给 agent」，不是「回退」。epic 的节奏不被 replan 打乱。

---

## 7. 未定项（本层相关）

| 项 | model 引用 | epic 层的状态 |
|---|---|---|
| ~~`inheritedItemIds` 的 replan 更新机制~~ | model §7.1 | **已定（v5 采用 abort + appendOnly 方案）**。详见 §6.2–§6.5 及 model §5.6：上层 replan 废弃条目后，cw 自动计算影响面 + 级联 abort 引用废弃条目的子孙 + 返回给 agent + agent 通过 `cw create` 重建。epic 层场景见 §6.4–§6.5 |
| ~~`PlanningRetrospectData.splitFulfillment` 是否对照所有 split 项~~ | model §7.1 | **已定（slice 文档定稿：必须覆盖所有 split 项）**。slice §5.1 已定稿：splitFulfillment 必须对照 `SlicePlan.split` 的**所有**项（不能只对照部分），每项给 `delivered` / `partial` / `failed` verdict。slice 是 PlanningUnit 的最底层，最接近执行，其约定适用于三层 PlanningUnit。epic 同样适用（机器 gate 验覆盖，§5.5）|
| `execReviewJudgment` 字段结构 | model §7.1 | **与 epic 无关**（epic 是 PlanningUnit，没有 execReviewJudgment）。仅 wave 层相关 |

其他未定项（research 服务、claim、ADR）见 model §7.2，与 epic 层无直接关系，不在本文展开。

---

## 附录 A. 完整 TS 接口（epic 层涉及的全部）

> 集中 model §1.4 / §4 / §5 里 epic 层涉及的全部接口，供实现参考。代码层基础类型（WorkUnitItem / Plan / Split）是 DRY 复用，不是领域概念（model §4）。

```typescript
// ============ 代码层基础结构（model §4，不进词表主体）===========
interface WorkUnitItem {
  id: string;
  status: "active" | "abandoned";
}

interface Plan {
  split: Split[];
}

interface Split {
  slug: string;
  description: string;
  dependsOn: string[];
  inheritedItemIds?: string[];
}
// ============ 代码层基础结构 END ============

// ============ WorkUnit / PlanningUnit（model §1.4，epic 的父类型）===========
interface WorkUnit {
  id: string;
  scope: "epic" | "feature" | "slice" | "wave";
  slug: string;
  parentUnitId?: string;                    // epic 无（顶层）
  status: PlanningStatus | ExecutionStatus;
  statusHistory: StatusChange[];
  basedOnParent: string[];                  // epic 永远 []
  abandonedRefs: AbandonedRef[];            // epic 永远 []
  objective: string;
  clarifications: Clarification[] | FeatureClarification;
  plan: Plan;
  designReviewJudgment: DesignReviewJudgment;
  executeResult: ExecuteResult;
  retrospectData: RetrospectData;
  evidence: Evidence;                       // 基类标注，运行时持有子类实例（PlanningUnit 是 PlanningEvidence）
}

interface PlanningUnit extends WorkUnit {
  scope: "epic" | "feature" | "slice";
  status: PlanningStatus;
  executeResult: PlanningExecuteResult;
  evidence: PlanningEvidence;               // 收窄自 Evidence 基类，客观部分含 childDelivery（model §1.4、§5.11）
  // 无 testJudgment / execReviewJudgment（PlanningUnit 判别特征）
}

// ============ epic 实体 ============
interface Epic extends PlanningUnit {
  scope: "epic";
  // parentUnitId: undefined（顶层无父）
  // basedOnParent: []（永远空）
  // abandonedRefs: []（永远空）

  objective: string;                                  // create
  clarifications: Clarification[];                    // clarify（数组形态，非 FeatureClarification）
  plan: Plan;                                         // plan（基类，只 split）
  designReviewJudgment: DesignReviewJudgment;         // design-review
  executeResult: PlanningExecuteResult;               // execute
  retrospectData: PlanningRetrospectData;             // retrospect（兼验收）
  evidence: PlanningEvidence;                         // 跨阶段（execute 生成客观 / retrospect 消费 / closeout 补主观 + 冻结，model §5.11）
}

// ============ PlanningStatus（model §5.4）============
type PlanningStatus =
  | "created" | "clarifying" | "planning" | "design-reviewed"
  | "executing" | "retrospected" | "closed" | "aborted";

// ============ clarify 产物 ============
interface Clarification extends WorkUnitItem {
  question: string;
  resolution?: string;     // 空 = 还没答（progressive 填充）
  type: "research" | "grilling";
}

// ============ design-review 产物 ============
interface DesignReviewJudgment {
  necessity: string;
  sufficiency: {
    gaps: string[];
    overlaps: string[];
    meceNote: string;
  };
  alternatives: string;
  tradeoffs: Tradeoff[];
  risks: Risk[];
  layerSpecific?: EpicDesignReviewLayerSpecific;   // epic 层具名 interface（model §5.8 具名化约定，§3.2）
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

// epic 的 designReviewJudgment.layerSpecific 具名 interface（§3.2）：
//   5 个字段都是 agent 的人审判断，gate 只验非空，不验内容（model §5.8 诚实原则）。
//   值类型全为 string，符合 model §5.8 layerSpecific 约定的下界（`Record<string, string>`）。
interface EpicDesignReviewLayerSpecific {
  strategicAlignment: string;      // 战略对齐
  featureSplitRationale: string;   // 拆分依据
  scopeBoundary: string;           // 范围边界
  priorityRationale: string;       // 优先级依据
  resourceEstimate: string;        // 资源估算
}

// ============ execute 产物 ============
interface ExecuteResult {
  // 基类，预留扩展
}

interface PlanningExecuteResult extends ExecuteResult {
  childUnitIds: string[];   // feature id 列表
}

// ============ retrospect 产物（兼验收）============
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

// ============ evidence（跨阶段产物，model §5.11 权威定义）+ StatusChange ============

// PlanningEvidence（PlanningUnit 共享，epic 用此类型，model §5.11.1）
interface PlanningEvidence extends Evidence {
  // 客观部分（cw 自动填，child closeout 后才完整）
  childDelivery: ChildDeliveryRecord[];   // 每个 split 项对应 child 的交付情况（§4.5）
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
  childUnitId: string;                    // child WorkUnit id（epic 的 child 是 feature）
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

// ============ replan 相关（model §5.6）============
interface AbandonedRef {
  workUnitItemId: string;            // 被废弃的上游条目 id（如 "D2"，来自 WorkUnitItem.id）
  abandonedAt: string;               // 何时被废弃影响（时间戳）
}
// 注：AbandonedRef 是纯历史记录（用于追溯「何时、因哪个上游条目废弃而被 abort」），
// 不阻塞任何流程（cw 在 replan 时已直接 abort，无中间态，model §5.6.1）。
// epic 自己的 abandonedRefs 永远为 []（顶层无上游）。

// ============ epic transitions（实现参考）============
// 旁路 action 只有 2 个：replan / abort（model §3.3、§5.5）。
// accept-replan 已废弃——v5 cw 直接 abort 受影响子孙，无中间态（model §0.3、§5.6）。
const EPIC_TRANSITIONS = {
  create:         { from: [],                                                                        to: "created" },
  clarify:        { from: ["created", "clarifying"],                                                 to: "clarifying",    progressive: true },
  plan:           { from: ["clarifying", "planning"],                                                to: "planning",      progressive: true },
  "design-review":{ from: ["planning", "design-reviewed"],                                           to: "design-reviewed", progressive: true },
  execute:        { from: ["design-reviewed"],                                                       to: "executing" },
  retrospect:     { from: ["executing"],                                                            to: "retrospected" },
  closeout:       { from: ["retrospected"],                                                         to: "closed" },   // 不可逆
  // === 旁路 action（model §3.3）===
  abort:          { from: ["created", "clarifying", "planning", "design-reviewed",
                           "executing", "retrospected"],                                            to: "aborted", alsoAbortsChildren: true },
  replan:         { from: ["design-reviewed", "executing"],                                         to: undefined /* 原地 */,
                    progressive: true,
                    // 触发 model §5.6 的 4 步流程：
                    // 本地变更 → 影响面计算（feature 层 basedOnParent）→
                    // 级联 abort 受影响子孙 → 返回 aborted/preserved/pendingRebuild 给 agent
                    triggersCascadeAbort: true },
};
```

---

## 维护说明

- 本文档是 v5 **epic 层**的设计。流程/状态机/通用字段以 [design-v5-model.md](./design-v5-model.md) 为权威源。
- **所有用词必须在 model §5 词表内**。`EpicDesignReviewLayerSpecific`（§3.2）是 epic 层对 model §5.8 `layerSpecific` 具名化约定的具体填充，不是新的领域概念。
- 与 v4 的差异以 model §0 为准（v4 废弃词见 model §8，不在本文出现）。
- 未定项见 §7，最终方案随 model §7.1 在各层文档评审时定稿。

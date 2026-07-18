# TaskShape 架构

> CW 的可插拔验证策略架构。支持多种开发模式（TDD / 纯删除 / 文档），通过 TaskShape 统一配置轴驱动。

## 概述

TaskShape 是 CW（coding-workflow）对"如何验证一个 topic 完成"和"如何审查一个 topic"这两个原本被硬编码为 TDD 专属的正交维度的抽象化。

历史上 CW 把三件本应正交的事耦合进状态机：流程编排（create→plan→dev→review→closeout，通用）、验证策略（TDD 红灯 + 退出码 + append-only 锁 expected，TDD 专属）、审查策略（三段 review 锁死必经 + 6 维度硬编码，一刀切）。结果是纯删除 / 重构 / 文档等非 TDD 任务会在 `tddPlanCheck`（mock+real 分层强制）、TRANSITIONS 线性锁（dev 只能从 `tdd_inited` 进入）、`validateAppendOnly`（锁 expected）等 5 个硬卡点处卡死，只能 abort。

方案 B 用 5 个步骤把这套流程重构为可插拔架构：引入 `TaskShape` 作为统一配置轴，一个任务形态 = 验证策略 ⊕ 审查策略的组合。新增开发模式时只加策略实现 + 注册，不动状态机。本文档综合方案 B 全部 5 步设计，是 TaskShape 架构的权威参考。

---

## 核心抽象：TaskShape = VerificationStrategy ⊕ ReviewStagePolicy

TaskShape 是**组合而非继承**：验证策略与审查策略可独立演进（未来可能出现共用 tdd verification 但不同 review policy 的 shape）。

```
                    ┌─────────────────────────────────────────┐
                    │              TaskShape                  │
                    │  id: "full-tdd" | "delete-only" | ...   │
                    ├──────────────────┬──────────────────────┤
                    │  verification    │      review          │
                    │  (怎么验证)      │     (怎么审查)       │
                    ├──────────────────┼──────────────────────┤
                    │ VerificationStr. │ ReviewStagePolicy    │
                    │                  │                      │
                    │ · preDevCheck    │ · stages             │
                    │ · applyPreDevRes │   (启用哪些审查阶段) │
                    │ · postDevVerify  │ · dimensions         │
                    │ · isDevVerified  │   (关心哪些审查维度) │
                    │ · replanGuard    │                      │
                    └──────────────────┴──────────────────────┘
                            │                  │
                ┌───────────┴────┐ ┌───────────┴────────────┐
                │ 3 个策略实现    │ │ 3 个 review policy     │
                │ tdd            │ │ FullReviewPolicy       │
                │ existence      │ │ LeanReviewPolicy       │
                │ review-only    │ │ DocReviewPolicy        │
                └────────────────┘ └────────────────────────┘
```

### VerificationStrategy：怎么验证

抽象掉原散落在 `actions.ts` / `gate.ts` / `state-machine.ts` 里的硬编码 TDD 逻辑。五个方法对应原 TDD 流程的四个判定点 + 一个 store 写入点：

| 方法 | 语义 | 对应原 TDD 逻辑 |
|------|------|----------------|
| `preDevCheck(topic, payload)` | dev 前的 gate（解析 + 业务约束校验）| 原 `tddPlanCheck`（test.json schema + mock+real 分层强制）|
| `applyPreDevResult(topicId, store, parsed)` | preDevCheck pass 后把 parsed 写入 store | 原 `handleTddPlan` 硬编码的 `insertTestCases` / `setTestRunner` |
| `postDevVerify(topic)` | dev 后跑验证，返回每个 case 的结果 | 原 `handleTest` 内联的命令执行 + `judgeByExpected` |
| `isDevVerified(topic)` | test gate 是否通过（纯函数，不跑 IO）| 原 `computeGatePassed("test")` 内联判定 |
| `replanGuard(oldTopic, newPayload)` | replan 安全守卫 | 原 `validateAppendOnly`（锁 committed wave + passed case）|

`applyPreDevResult` 用结构化类型 `ApplyPreDevResultStore`（duck typing）作为 store 参数，避免 `shapes/types → store` 循环依赖。各 shape 按自己关心的 parsed 结构调对应 setter：

- tdd：`insertTestCases` + `setTestRunner`
- existence：`setExistenceArtifacts`
- review-only：no-op（不调任何 setter）

### ReviewStagePolicy：怎么审查

抽象掉三阶段 review 的启用配置：

- `stages`：启用的审查阶段子集（`spec_review` / `plan_review` / `review`）。full-tdd 三段全开；轻量 shape 只开 `review`。
- `dimensions`：该 shape 关心的审查维度（用于事后盲区统计）。注意这里只列**代码审查维度**（review 阶段），spec/plan 审查的维度由 `stages` 启用隐含。

`dimensions` 不做子集校验——维度由阶段固定（详见"已知限制"）。

### 为什么是统一轴，不是两个独立配置

验证策略与审查策略是**相关的**，不是完全独立。"是否需要 test-coverage 审查维度"本质上由验证策略决定——非 TDD 任务（existence / review-only）不需要 test-coverage review。

如果做成两个独立配置轴（`verificationStrategy` + `reviewStagePolicy` 各自独立选择），会出现"选了 review-only 验证却保留 test-coverage 审查"这类不自洽组合。统一成 TaskShape 让组合合法性在 shape 定义时保证，agent 只需识别任务性质选 shape（见 [ADR-0002](./adr/0002-taskshape-unified-axis.md) 的方案对比）。

### 接口骨架

接口定义在 `src/shapes/types.ts`。关键字段（不是全文复制，详见源文件）：

```typescript
interface TaskShape {
  readonly id: TaskShapeId;              // "full-tdd" | "delete-only" | "doc-only"
  readonly verification: VerificationStrategy;
  readonly review: ReviewStagePolicy;
}

interface VerificationStrategy {
  readonly id: string;                   // "tdd" | "existence" | "review-only"
  preDevCheck(topic, payload): GateResult;
  readonly preDevGateName: string;
  postDevVerify(topic): VerifyResult[];
  readonly postDevGateName: string;
  replanGuard(oldTopic, newPayload): Violation[];
  isDevVerified(topic): boolean;
  applyPreDevResult(topicId, store, parsed): void;
}

interface ReviewStagePolicy {
  readonly id: string;                   // "full-review" | "lean-review" | "doc-review"
  readonly stages: readonly ReviewStage[];
  readonly dimensions: readonly ReviewDimension[];
}
```

---

## 3 种内置 TaskShape

注册在 `src/shapes/registry.ts` 的 `REGISTRY` 表。`getShape(taskShapeId)` 按 id 解析策略组合；`undefined` 或未知 id 回退默认 `full-tdd`（防御磁盘手写非法值 / 存量 topic 兼容，避免 `Cannot read properties of undefined` 崩溃）。

| shape | verification | review policy | review stages | review dimensions | 适用场景 |
|-------|-------------|---------------|---------------|-------------------|---------|
| **full-tdd**（默认）| `TddVerificationStrategy` | `FullReviewPolicy` | 全 3 段（spec_review + plan_review + review）| 全 6 维 | 新功能开发 |
| **delete-only** | `ExistenceVerificationStrategy` | `LeanReviewPolicy` | 仅 `review` | design-consistency + edge-case | 纯删除 / 迁移 |
| **doc-only** | `ReviewOnlyVerificationStrategy` | `DocReviewPolicy` | 仅 `review` | design-consistency | 文档任务 |

完整审查维度联合（共 12 个，见 `src/types.ts` 的 `ReviewDimension`）：

- 代码审查 6 维（review 阶段）：`type-safety` / `error-handling` / `edge-case` / `test-coverage` / `plan-completeness` / `design-consistency`
- spec 审查 3 维（spec_review 阶段）：`completeness` / `consistency` / `reasonableness`
- plan 审查 3 维（plan_review 阶段）：`coverage` / `architecture` / `feasibility`

### full-tdd：原有 TDD 流程

存量默认 shape，行为零回归。完整链路：

```
create → clarify → confirm_clarify → spec_review → plan → plan_review
       → tdd_plan → dev → review → test → retrospect → closeout
```

`tdd_plan` 阶段 agent 提交 `test.json`（testCases + 可选 testRunner），`preDevCheck` 走 mock+real 分层强制（mock 用例先过、real 用例后过），红灯校验在 `handleTddPlan` 原位调用（涉及 store 事务边界，不搬进策略）。`applyPreDevResult` 写 `insertTestCases` + `setTestRunner`。`postDevVerify` 执行 `exit_zero`（去重跑一次 testRunner）/ `script`（各自执行 expected.path）/ `exact`（agent 提交 actual）三类 case，`isDevVerified` 判定"testCases 非空且全 passed"。

### delete-only：existence.json 产物清单模型

适用场景：删除任务（删完即交付，无可执行测试）、存在性契约（配置文件必须生成、旧文件必须删除）。无测试逻辑可验，只验"产物在/不在"。

`tdd_plan` 阶段 agent 提交 `existence.json` 而非 `test.json`，声明产物清单：

```jsonc
{ "artifacts": [{ "path": "src/old.ts", "expectedState": "absent" }] }
```

- `preDevCheck`：`parseExistenceJson` schema 校验 + 业务约束（至少 1 个 artifact、path 非空、path 不越出 workspace 沙箱防 `../` 逃逸）
- `applyPreDevResult`：`setExistenceArtifacts`（初始 `verified=undefined`）
- dev 阶段：执行删除/创建
- `postDevVerify`：对每个 artifact 跑 `existsSync`，`passed = (exists === (expectedState === "present"))`。`caseId = artifact.path`（一个 artifact = 一条验证）
- `isDevVerified`：读 `existenceArtifacts[].verified` 缓存（纯函数，不跑 IO）

跳过 spec_review / plan_review（stages 只含 `review`），流程裁剪为：

```
create → clarify → confirm_clarify → plan → tdd_plan → dev → review → test → ...
```

### doc-only：无机器验证，靠 review 兜底

适用场景：纯文档任务（写 ADR / README / 迁移文档），无可机器验证的产物。所有验证方法都是 no-op / 恒 pass：

- `preDevCheck`：恒 pass（不要求任何 dev 前 payload）
- `postDevVerify`：返回空数组
- `isDevVerified`：恒 true（避免文档任务卡在"无 testCase = isDevVerified=false"的死锁）
- `applyPreDevResult` / `replanGuard`：no-op / 返回空

流程上 dev → review → test → closeout 仍走，但 test gate 不做机器校验——验证完全靠 review 阶段人审兜底（review 只看 design-consistency 一个维度）。

---

## 状态机集成

### TRANSITIONS 扩展（阶段裁剪）

阶段裁剪的核心约束：`TRANSITIONS` 是全局静态表（`Record<Action, TransitionRule>`），`checkLinear(action, status)` 只接 action + status，**不接 topic 参数**。guard 是单重防线（CW 核心约定），gate 层 `computeGatePassed` 兜底。

裁剪机制采用**扩展 expectedStatuses + guidance 分流**（见 [ADR-0004](./adr/0004-review-stage-pruning.md)）：

- `TRANSITIONS.plan.expectedStatuses` 含 `"clarify_confirmed"`——裁剪 shape 跳过 spec_review 时，confirm_clarify 后直接 plan 合法
- `TRANSITIONS.tdd_plan.expectedStatuses` 含 `"planned"`——裁剪 shape 跳过 plan_review 时，plan 后直接 tdd_plan 合法
- `checkLinear` 签名不改——扩展只放宽不收紧，full-tdd 路径完全不受影响

**agent 不感知裁剪**——guidance 是唯一导航，agent 跟 `nextAction.action` 走即可。被裁剪的阶段不出现在 guidance 里，agent 无需知道哪些阶段被跳过。

考虑过的替代方案（均否决）：

- **方案 B（checkLinear 接 topic 参数）**：改 `checkLinear(action, status)` → `(action, status, topic)`，按 taskShape 动态判定。否决：guard 是状态机核心，改签名影响所有调用点，违反"guard 只做线性 status 校验"的分层职责。
- **方案 C（新增 skip action）**：加 `cw(skip_spec_review)` / `cw(skip_plan_review)`。否决：增加流程复杂度，违反"agent 不感知 shape 差异"的设计目标。

### 状态重命名

方案 B 步骤 1（打地基）保留了 TDD 专属状态名，步骤 5（策略模式稳定后）做路径 2 重命名。`TRANSITIONS` 表、`checkLinear`、断言全部不变，仅替换字面量：

| 旧名 | 新名 | 语义 |
|------|------|------|
| `tdd_inited` | `pre_dev_verified` | dev 前验证通过 |
| `tested` | `post_dev_verified` | dev 后验证通过 |

重命名后状态名在非 TDD 场景下名实相符（过渡期"名不副实"的代价消除）。

### guidance 分流

`buildNextAction` 按 `getShape(topic.taskShape).review.stages` 分流 guidance（`isStageEnabled(topic, stage)` 判定 stages 是否含该阶段）：

- **confirm_clarify pass**：
  - `isStageEnabled(spec_review)` → `spec_review`（full-tdd）
  - 否则 → `plan`（delete-only / doc-only）
- **plan pass**：
  - `isStageEnabled(plan_review)` → `plan_review`（full-tdd）
  - 否则 → `tdd_plan`（delete-only / doc-only）
- **replan**（status=planned 时）：与 plan case 对称，按 `isStageEnabled(plan_review)` 分流到 `plan_review` 或 `tdd_plan`。这是 ADR-0004 的延伸约束——不能引导到裁剪声称跳过的阶段
- **review guidance**：`buildReviewPrompt(dimensions)` 按 shape 声明的 dimensions 子集过滤维度表（delete-only 只渲染 design-consistency + edge-case 两行，doc-only 只渲染 design-consistency 一行）
- **test guidance**：`getTestWording(topic)` 按 `verification.id` 切换措辞（tdd 说 testCase / coverage；existence 说 artifact / 符合率；review-only 说"无机器验证"）。核心逻辑（status 流转、gate 判定、计数）不变，只换文案避免误导非 TDD shape 的 agent

---

## 存储模型

### existenceArtifacts + verified 缓存

existence 策略的缓存模式（见 [ADR-0003](./adr/0003-existence-and-review-only-strategies.md)）：`isDevVerified` 要检查文件存在性，但 `computeGatePassed` 被 `buildNextAction` 多处调用会反复 stat。解决：

- `postDevVerify`（test 阶段调一次）：跑 `existsSync` 后把结果写入 `topic.existenceArtifacts[i].verified`
- `isDevVerified`（多处调用）：只读缓存，保持纯函数，副作用隔离在 `postDevVerify`
- 首次 test 前 `verified` 是 `undefined`（`applyPreDevResult` 写入时不带 verified，由 `handleTest` 事务内 `updateExistenceArtifactVerified` 回填）

**权衡：信缓存不信文件系统**。`isDevVerified` 返回 true 即使文件已被外部改动仍 true（closeout 后可能 drift）。这是纯函数约束的代价——`computeGatePassed` 必须可重复调用无副作用。

### taskShape 迁移

旧 topic 无 `taskShape` 字段 → 默认 `full-tdd`。迁移在 store 的 `loadTopic` / `findTopics` 读取路径做：in-memory 补默认值，**不写回磁盘**（保持磁盘原样流出，避免被动改写存量数据）。

```typescript
// store.ts loadTopic / findTopics 内
if (!topic.taskShape) {
  topic.taskShape = "full-tdd";
}
```

`getShape(undefined)` 也回退 `full-tdd`，双重防御。

---

## replan 安全门

`replanGuard` 按 shape 路由（见 [ADR-0005](./adr/0005-replanguard-shape-routing.md)）。核心难点：`tdd-strategy.replanGuard` 的签名 `(oldTopic, newPayload)` 与 `handleReplan` 的 plan/test 双路径参数组装不匹配——`handleReplan` 分两次调 `validateAppendOnly`（plan 路径校验 waves + legacyCases，test 路径校验 newCases），而 `replanGuard` 接受单个 payload。同时 existence / review-only 的 replan 守卫是独立逻辑，与 tdd 的 `validateAppendOnly` 完全不同。

路由设计：

| verification.id | replan 路径 | 语义 |
|-----------------|------------|------|
| `tdd` | 继续走 `validateAppendOnly`（现状不变）| 双路径参数组装匹配，零回归。committed wave + passed case 不可删改 |
| `existence` | 走 `ExistenceVerificationStrategy.replanGuard` | 已 verified=true 的 artifact 不可改 expectedState、不可从清单移除（防"事后篡改契约"）|
| `review-only` | 走 `ReviewOnlyVerificationStrategy.replanGuard` | 恒返回空数组（无可保护的已验证产物）|

existence 的 `replanGuard` 检查两类违规：

- `existence_artifact_removed`：已 verified 的 artifact 从清单移除（该产物不再受验证，可能被误删而不被发现）
- `existence_artifact_state_changed`：已 verified 的 artifact 改了 expectedState（如 `src/old.ts` 声明 absent 且已验证删除，replan 改成 present 让 postDevVerify 在无文件时判 fail——这是安全漏洞）

考虑过的替代方案（均否决）：

- **方案 B（统一走 replanGuard）**：把 `handleReplan` 双路径改为组装单一 payload 调 `tdd.replanGuard`。否决：需要重构 `extractReplanInputs` 理解双路径语义，tdd 路径有回归风险（大量 replan 测试依赖现有双路径行为）。
- **方案 C（删掉 replanGuard 接口）**：否决：existence 的契约保护就没有机制了，delete-only topic 在 dev 后 replan 可以把已验证删除的文件改成 `expectedState=present` 重新"验证"。

**实现状态**：handleReplan 已按 `verification.id` 路由——tdd 分支保留双路径 `validateAppendOnly` 调用（零回归），非 tdd 分支调策略 `replanGuard`。tdd-strategy 的 `replanGuard` 实现作为"未来想统一"的备选路径保留，当前不被 tdd 路径调用（tdd 走 inline validateAppendOnly 以保持双路径参数组装匹配）。等价性由 `tests/dispatch-replan-shape.test.ts` AC-4/5/6 锁定。

---

## 关键设计决策索引

| ADR | 标题 | 核心决策 |
|-----|------|---------|
| [ADR-0002](./adr/0002-taskshape-unified-axis.md) | TaskShape 统一配置轴 | 引入 `TaskShape = verification ⊕ review`，统一配置轴而非两个独立配置（避免不自洽组合）。5 个子决策：状态名不改（后步骤 5 重命名）、纯函数签名不变、红灯校验保留原位、taskShape create 时注入、本 topic 只打地基 |
| [ADR-0003](./adr/0003-existence-and-review-only-strategies.md) | existence + review-only 策略 | existence.json 产物清单模型（artifacts=[{path, expectedState}]）、isDevVerified 读缓存不跑 IO、applyPreDevResult 接口方法、review-only 恒 pass 模型 |
| [ADR-0004](./adr/0004-review-stage-pruning.md) | review 阶段裁剪机制 | 扩展 expectedStatuses + guidance 分流（不接 topic 参数）。agent 不感知裁剪，guidance 是唯一导航 |
| [ADR-0005](./adr/0005-replanguard-shape-routing.md) | replanGuard 按 shape 路由 | 按 taskShape 分叉：tdd 走 validateAppendOnly，existence / review-only 走策略 replanGuard |

方案 B 整体的替代方案对比（ADR-0002 记录）：

- **方案 A（taskType 分支）**：用 N 条平行 if-else 代替抽象。否决：组合爆炸，技术债。
- **方案 C（可选验证阶段）**：朴素的"插拔阶段"。不如策略模式干净，留作 B 的降级备选。
- **方案 D（收紧边界）**：CW 就是 TDD 专用，不扩展。否决：诚实但放弃扩展性，与产品演进方向冲突。

---

## 已知限制

- **existence verified 缓存可能过时**：closeout 后文件状态 drift，`isDevVerified` 仍信缓存返回 true。纯函数约束的代价——`computeGatePassed` 必须可重复调用无副作用（见 [ADR-0003](./adr/0003-existence-and-review-only-strategies.md)）。
- **盲区统计未实现**：`ReviewStagePolicy.dimensions` 声明的维度子集当前只用于 `buildReviewPrompt` 过滤维度表和 test 阶段措辞。retrospect 聚合 dimensions 覆盖度（哪些维度的 issue 被遗漏）尚未实现。
- **spec/plan review 的 dimension 不做子集校验**：`dimensions` 字段只列 review 阶段（代码审查）的维度，spec/plan 审查的维度由 `stages` 启用隐含。维度由阶段固定，不在配置层做子集合法性校验。
- **full-tdd 手动跳过被允许**：ADR-0004 扩展 expectedStatuses 后，full-tdd shape 理论上也能在 `clarify_confirmed` 状态手动调 `cw(plan)` 跳过 spec_review（status 合法了）。guidance 不引导，agent 若手动跳是自主行为——CW 不强制 full-tdd 走全链，这是 agent 纪律问题不是 guard 职责。
- **tdd-strategy.replanGuard 是占位死代码**：tdd 路径走 `validateAppendOnly` 而非策略 replanGuard，保留实现作为"未来想统一"的备选路径，当前不调用。

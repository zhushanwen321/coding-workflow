# v5 CLI 入口与 Guidance 设计

> **状态**：草案 v2（渐进式 guidance 修订）
> **日期**：2026-07-22
> **前置文档**：design-v5-model.md（模型）、design-v5-wave/slice/feature/epic.md（各层）、v1-architecture.md（src/v1/ 架构）
> **本文档解决的问题**：v5 设计了 4 层 WorkUnit 模型，但 CLI 命令形态和 guidance 结构在 v5 设计里是空白；src/v1/ 当前 `ActionResult` 砍掉了 0.x 的 `nextAction`/`guidance`。本文档补这两个缺口，核心设计是**渐进式 guidance**。

---

## 0. 设计目标

agent 通过 cw-cli skill + 每段 guidance，自包含地完成从选层到 closeout 的完整多层级流程。

两个验收标准：
1. 光靠 skill，agent 能判断从哪层 create
2. 光靠 skill + 每段 guidance，agent 能走完整个流程（无断点）

---

## 1. CLI 入口设计

### 1.1 命令形态：create 显式带 layer，其余靠 unitId 前缀路由

```
# 起步：显式带 layer。parent 全可选——任何一层都能独立起步（见 §1.3）
cw create epic    --slug <slug> --objective "..."
cw create feature --slug <slug> --objective "..." [--parent <epicId>]
cw create slice   --slug <slug> --objective "..." [--parent <featureId>]
cw create wave    --slug <slug> --objective "..." [--parent <sliceId>] [--basedOnParent '[...]']

# 推进：靠 unitId 前缀路由（WorkUnit.id 格式 = "{scope}:{slug}"）
cw clarify       --unitId wave:auth-w1 --input @clarify.json
cw plan          --unitId wave:auth-w1 --input @plan.json
cw execute       --unitId wave:auth-w1 --commitHash <sha>

# 旁路：unitId 即路由
cw replan --unitId wave:auth-w1 --abandonedIds '["T2"]' --note "..."
cw abort  --unitId wave:auth-w1 --reason "..."

# 只读
cw status --unitId wave:auth-w1
cw tree                          # WorkUnit 树（epic→feature→slice→wave）
cw list   --layer wave
```

### 1.2 dispatch 路由逻辑

当前 `src/v1/dispatch.ts` 硬编码 `guardWave`。多层级需要改为按 unitId 前缀路由：

```
解析 unitId 前缀 → scope ∈ {epic, feature, slice, wave}
  → scope=wave:  guardWave + ExecutionUnit handlers（当前已实现）
  → scope=slice/feature/epic: guardPlanning + PlanningUnit handlers（后续 topic）
```

### 1.3 任何一层都能独立起步（parent 全可选）

v5 的 4 层是**可选组合**，不是强制树。任何一层 create 时都可以没有 parent：

- 有 parent：挂到已有树上，clarify/design-review 对照上游条目（basedOnParent）
- 无 parent：独立起步，clarify/design-review 基于 objective 自洽（无上游参照）

为什么这样设计：不是所有任务都需要 4 层完整链路。一个根因已定位的 bug，agent 选 wave 直接起步——前提是技术方案已清晰（能直接写 testCases），不需要 slice 层显式做技术方案设计。slice 层的价值在「需要显式技术方案」时才体现，不是 wave 的必经前置。

**无 parent 时的流程差异**（只影响判断基准，不影响产物结构）：

| 阶段 | 有 parent | 无 parent |
|------|-----------|-----------|
| clarify | 澄清 + 对照上游条目补缺 | 纯基于 objective 澄清 |
| design-review sufficiency | 审「是否覆盖上游条目」 | 审「基于 objective 是否自洽」 |
| closeout 后 | crossLayer 回溯到父单元 | 流程结束（孤立终点） |

产物结构不变：wave 还是产 WavePlan，slice 还是产 Split[]。design-review judgment 的字段结构也不变——变化的是 agent 填写时的判断基准。

**`CreateInput` 改为全可选**：`parentUnitId?` / `basedOnParent?` 均可选（任何层都能无 parent）。详见 §8。

### 1.4 为什么不是 layer 子命令（cw wave create / cw slice plan）

4 层 × 约 10 个 action = 40 个子命令组合，agent 要记矩阵，和 skill 核心理念「agent 不需要记忆 action 列表」冲突。layer 信息在 unitId 前缀里已有，子命令是冗余。

---

## 2. cw-cli skill 结构

### 2.1 核心理念（继承 0.x）

- **唯一入口**：`cw create <layer>`（skill 只暴露 4 个 create 命令，后续 action 全靠 guidance 驱动）
- **guidance 是唯一导航**：create 之后全靠返回的 `nextAction.guidance` 推进
- **通过 bash 调 cw**，读 stdout JSON

### 2.2 第 0 步：该不该用 CW

skill 第一段是前置筛选，防止小任务滥用 CW（v5 流程重，最多 30 步，误用代价大）：

| 场景 | 判断 | 原因 |
|------|------|------|
| 新功能 / 复杂 bug / 重构模块 | 用 CW | 需要完整 plan→execute→test 链路 |
| 改 typo / 改配置值 / 加注释 | 不用 CW | 流程开销远大于收益 |
| 纯调研 / 可行性分析 / 架构评估 | 不用 CW | 无代码产出，wave 的 testCases/files 无内容可填 |
| 加简单工具函数（无外部依赖）| 不用 CW | 单文件单函数，无 plan 必要 |

判断标准：如果不会走完至少 plan → execute → test → closeout，就不要 create。

### 2.3 选层决策：按工作性质（不按规模）

v5 model §1.3 明确主张：三层 PlanningUnit 不是粒度递减的同构层，而是职责不同的三种角色。**选层必须按「这份工作的性质」，不能按「规模大小」。**

```
你的任务下一步要产出什么？

① 施工执行——能直接写出 testCases + files + contracts
   → cw create wave [--parent <sliceId>]
   有 parent：挂到 slice 下，对照 slice 的技术条目。
   无 parent：独立起步（适用于技术方案已清晰的 bug 修复 / 小改动）。

② 技术方案化——需要先定义接口契约/数据模型/错误处理/技术选型，才能动手写代码
   → cw create slice [--parent <featureId>]
   有 parent：承接 feature 的 FR/AC/UC 作为上游约束。
   无 parent：基于 objective 独立做技术方案（适用于方案设计本身就是任务目标的场景）。

③ 需求规格化——需要把模糊需求变成可验收的规格（FR/AC/UC）
   → cw create feature [--parent <epicId>]
   有 parent：承接 epic 的战略方向。
   无 parent：独立做需求规格化。

④ 战略翻译——需要拆成多个独立功能方向，决定各自边界和优先级
   → cw create epic
   epic 通常无 parent（顶层目标），也可有 parent（子战略）。
```

判别核心：问自己「我下一步要写的第一份产物是什么」——需要写 feature 拆分依据→epic，需要写 FR/AC/UC→feature，需要写技术契约→slice，能直接写 testCases→wave。**选定层后直接 create，不需要先建上层链**（§1.3）。

典型场景速查：

| 用户说了什么 | 推荐层 | 为什么 |
|-------------|--------|--------|
| 新做一个系统（全新大功能）| epic | 多 feature 协作 |
| 加一个完整功能模块（登录/支付）| feature | 需要 FR/AC/UC |
| 实现功能，方案已定 / 重构模块（行为不变换实现）| slice | 技术方案设计 |
| 按接口文档实现 / 修 bug（根因已定位）| wave | 直接施工 |
| 调研可行性 | 不用 CW | 纯调研 |

### 2.4 跨层导航规则

skill 必须让 agent 理解 4 层树结构 + 何时下沉/回溯/横向：

```
4 层树：epic（根）→ feature → slice → wave（叶，唯一产生代码）

两种 WorkUnit 类型：
  PlanningUnit（epic/feature/slice）：7 步，execute 产出是启动子层（递归）
  ExecutionUnit（wave）：9 步，execute 产出是代码

跨层规则（guidance 在对应阶段自动提示）：
  下沉：PlanningUnit execute 时 cw 按 plan.split 创建子单元，guidance 指向第一个子单元
  回溯：子单元全部终态后，guidance 指向父单元 retrospect
  横向：有兄弟子单元未完成时，guidance 指向下一个兄弟
```

### 2.5 选错了层怎么办

选层过大（选了 feature 但一个 wave 就能搞定）：在 clarify 阶段就会发现范围小，和用户确认后 `cw abort` 降层重新 create。

选层过小（选了 wave 但发现牵涉更大范围）：`cw abort` 当前 wave，create 合适的上层（如 slice 或 feature），再在新层的 execute 下沉时重新建子单元承接原来的工作。因为每层都能独立起步（§1.3），「升级」不意味着要补齐整条链——只建需要的那一层。

### 2.6 先查现有树

`cw create` 前，agent 应先 `cw tree` 看是否有进行中的 WorkUnit。如果已有合适的 parent，挂上去（`--parent`）；如果是全新任务或没有匹配的 parent，按 §2.3 选层后独立 create（无 parent，§1.3）。

---

## 3. 渐进式 Guidance 原则（核心设计）

### 3.1 核心原则

**每个 action 返回的 guidance 只包含「agent 当前做决策需要的最小信息」。**

agent 每次拿到的 guidance 应短而聚焦，不被「未来可能用到的信息」分散注意力。

### 3.2 信息分两类，给法不同

这是渐进式的精确含义——区分 agent 何时需要这条信息：

| 信息类型 | 例子 | 给法 |
|---------|------|------|
| **cw 主动返回的**（agent 被动接收）| gate 结果、schema 校验错、drift 检查 fail | **推迟到发生时给**——正常走的时候不说「万一 fail 怎么办」，fail 了那次返回的 guidance 才聚焦「哪里错怎么修」|
| **agent 主动决策需要的**（agent 要自己发起）| 有哪些 action 可选、replan 选项存在、冻结契约 | **必须在决策点之前给**——不给 agent 就不知道这个选项存在，永远不会主动触发 |

判断标准：**如果 agent 不看这条信息，会不会错过一个它本该主动做的事？** 会→提前给；不会（cw 会告诉它）→推迟。

### 3.3 不做的事

- **不预先列异常处理表**。gate fail 的处理在 fail 时给，不在正常 guidance 里预告所有可能的 fail。
- **不一次性给完整机制解释**。replan 的完整机制在 agent 真要 replan 时才给，plan 阶段只告知选项存在 + 关键约束。
- **不用「熔断」概念**（0.x 的连续 fail 5 次换文案机制）。agent 反复失败时，在 fail 的 guidance 里按失败次数递进地加提示（第 1 次说哪里错，第 N 次加「考虑回顾 plan 是否有根本问题」），不需要特殊状态。

### 3.4 正常 guidance 的固定结构

每个 action 成功（ok=true）时返回的 guidance，固定三段：

| 段 | 内容 |
|----|------|
| **位置** | `[layer:unitId] 状态｜父/子单元位置`（一句话，让 agent 知道自己在树里哪层）|
| **下一步** | 一句话目标 + 精确命令（`cw <action> --unitId <id> --input @<file>.json`）|
| **input schema + 关键约束** | 当前 input 的完整 TS schema（字段 + 枚举）+ 这一步必须知道的硬约束（如「条目 execute 后冻结」是 plan 阶段的关键约束）|

三段都是「agent 当前做决策需要的」：位置（知道自己在哪）、下一步（知道调什么命令）、schema（知道 input 怎么填）。

### 3.5 异常 guidance 的结构

gate fail（ok=false）时返回的 guidance，聚焦当前问题：

| 段 | 内容 |
|----|------|
| **位置** | 同上 |
| **问题** | gate 为什么 fail（具体哪个字段/哪个条件没满足）|
| **怎么修** | 针对这个 fail 的修复指引 + 修正后重新提交同一 action 的命令 |
| **递进提示**（仅多次失败时）| 第 N 次失败时追加「考虑：① 是否 plan 有根本问题（→replan）② 是否选错了层（→abort 重选）」|

### 3.6 schema 自动生成

input schema 从 core TS 类型自动生成（`schema-injector.ts`），不手写——避免类型改了 guidance 漂移。core 类型都是声明式 interface，字段名 + 类型 + 注释可从源码文本提取。

映射规则：`interface X` → markdown schema block；联合类型 `"a" | "b"` → 列出枚举值；可选字段标「（可选）」；引用类型内联展开（避免 agent 跳转查阅）；`extends WorkUnitItem` 自动补 `id` + `status` 字段。

---

## 4. 正常 Guidance 示例

### 4.1 wave plan 阶段（ok=true）

```
## 位置
[wave:auth-w1] 状态：clarified｜父单元：slice:auth-login

## 下一步
编写执行计划，定义 testCases / tasks / files / contracts。
命令：cw plan --unitId wave:auth-w1 --input @plan.json

## input schema
{ "testCases": [{ "id":"T1","status":"active","scenario":"...","input":"...","expected":"...","type":"unit"|"integration"|"e2e"|"manual" }],
  "tasks": [{ "id":"TK1","status":"active","type":"impl"|"refactor"|"test"|"fix"|"doc"|"other","files":["..."],"steps":["..."],"dependsOn":["TK0"] }],
  "files": [{ "id":"F1","status":"active","path":"...","action":"create"|"modify"|"delete","description":"..." }],
  "contracts": [{ "id":"CON1","status":"active","name":"...","type":"function"|"api"|"class"|"event"|"schema"|"other","definition":"..." }] }
关键约束：testCases 不能为空；条目一旦 execute 就被冻结，修改只能走 replan。
```

为什么 plan 阶段的「关键约束」段提到了 replan？因为它属于 §3.2 的「agent 主动决策需要的」——agent 必须在写 plan 时就知道 plan 写完不能随便改（否则会草率写），且必须知道 replan 选项存在（否则遇到 plan 问题时不知道能改）。但 replan 的完整操作细节不在这里给，推迟到 agent 真调 replan 时。

### 4.2 wave closeout 阶段（ok=true，含跨层导航）

```
## 位置
[wave:auth-w1] 状态：retrospected｜父单元：slice:auth-login

## 下一步
冻结交付，补充 evidence 主观部分。
命令：cw closeout --unitId wave:auth-w1 --input @closeout.json

## input schema
{ "summary":"1-2 句话交付小结",
  "artifacts":[{ "kind":"spec"|"plan"|"review-report"|"code"|"test"|"doc"|"other","ref":"文件路径/URL/commit hash","note":"（可选）" }] }
关键约束：closeout 后 evidence.frozenAt 填入，整个 evidence 不可再改；cw 会校验每个 artifacts[].ref 是否存在。
```

注意：**跨层导航不在正常 guidance 里给**。closeout 成功后 `nextAction.action = undefined`，agent 读 `crossLayer` 字段决定下一步（下沉/回溯/横向，路由规则见 §7.2）。

### 4.3 wave test 阶段（ok=true）

test 阶段 cw 自动跑测试套件写 evidence.testRunResult，agent 填 testJudgment（对照 design-review judgment 验收业务正确性）：

```
## 位置
[wave:auth-w1] 状态：tested｜测试已跑（passed=12, failed=0）

## 下一步
代码品味审查。先确认功能对（test pass），再审代码好不好。
命令：cw exec-review --unitId wave:auth-w1 --input @exec-review.json

## input schema
{ "testJudgment":{
    "necessityMet":"实现是否满足必要需求",
    "sufficiencyMet":{ "gapsConfirmed":["..."], "gapsNewlyFound":["..."], "overlapsConfirmed":["..."], "note":"（可选）manual 类 testCase 验收记录" },
    "alternativesReconsidered":"...",
    "tradeoffCostRealized":[{ "tradeoffRef":"TR1", "costRealized":true, "note":"（可选）" }],
    "riskOutcome":[{ "riskRef":"R1", "outcome":"materialized"|"not-materialized"|"mitigated", "note":"（可选）" }] } }
关键约束：tradeoffCostRealized 的 tradeoffRef 和 riskOutcome 的 riskRef 必须引用 design-review 里定义过的 id。
```

### 4.4 wave exec-review 阶段（ok=true）

exec-review 是纯人审（代码品味/架构/可读性），无机器 gate：

```
## 位置
[wave:auth-w1] 状态：exec-reviewed

## 下一步
复盘。对照 design-review judgment 逐项回顾，提炼经验。
命令：cw retrospect --unitId wave:auth-w1 --input @retrospect.json

## input schema
{ "execReviewJudgment":{
    "readability":{ "score":1|2|3|4|5, "issues":["（可选）"] },
    "architecture":{ "score":1|2|3|4|5, "issues":["（可选）"] },
    "codeSmells":{ "items":["..."], "severity":"low"|"medium"|"high" },
    "overallVerdict":"pass"|"needs-followup",
    "followupActions":[{ "description":"...","priority":"high"|"medium"|"low",
                          "targetScope":"current-wave-replan"|"next-wave"|"slice-level-refactor"|"adr-candidate" }] } }
关键约束：score 是 1-5 整数；overallVerdict=needs-followup 时 followupActions 不能为空。
```

### 4.5 slice plan 阶段（PlanningUnit 示例）

PlanningUnit 的 plan schema 和 wave 完全不同（是 Split[]，不是 4 类条目）。slice 的 plan 示例：

```
## 位置
[slice:auth-login] 状态：clarified｜父单元：feature:auth

## 下一步
编写执行计划，定义拆分。slice 的 plan 把技术方案拆成多个 wave。
命令：cw plan --unitId slice:auth-login --input @plan.json

## input schema
{ "split":[{ "slug":"token-validation","description":"这个 wave 负责什么","dependsOn":["..."],
             "inheritedItemIds":["TC1","IF1"] }] }
关键约束：inheritedItemIds 是这个子 wave 继承上游哪些条目（execute 时写入子 wave 的 basedOnParent）；
条目 execute 后冻结，修改走 replan。
```

feature/epic 的 plan 也是 Split[]，schema 相同（差异在 clarify 产物的 spec 内容）。各层 input schema 的完整定义见各层文档 + 各层 topic 实现时补充到 schema-injector。

---

## 5. 异常时的 Guidance

### 5.1 gate fail（ok=false）的递进 guidance

正常走的时候不预告 fail。gate fail 那次返回的 guidance 聚焦问题：

**第 1 次 fail**：
```
## 位置
[wave:auth-w1] 状态：planning（未变）

## 问题
testCases 为空。design-review gate 要求 testCases 至少 1 条。

## 怎么修
补充 testCases 后重新提交：
cw plan --unitId wave:auth-w1 --input @plan.json
```

**第 3 次 fail**（递进提示）：
```
## 问题
testCases 仍为空（第 3 次）。

## 怎么修
同上。

## 递进提示
连续失败 3 次。考虑：
- 需求本身不明确 → 回到 clarify（cw clarify --unitId wave:auth-w1）
- plan 有根本问题 → replan（cw replan --unitId wave:auth-w1 --abandonedIds '[...]' --note "..."）
- 选错了层 → cw abort 重选
```

递进提示的内容按失败次数逐步加：第 1 次只说问题，第 3 次加「回顾上游（clarify）/ replan / abort」三个出口，第 5 次再加一句「强烈建议先 cw abort，跳出当前层重新审视」。**这是 agent 行为引导，不是 cw 状态**——cw 只在返回里带 `failureCount` 字段，递进文案由 guidance builder 根据 failureCount 渲染。failureCount 从 statusHistory 派生（统计同一 action 最近连续 fail 次数），跨 session 不重置。

### 5.2 PlanningUnit retrospect 的前置条件 fail

PlanningUnit retrospect 要求所有子单元终态。前置条件不满足时：

```
## 位置
[slice:auth-login] 状态：executing

## 问题
retrospect 要求所有子单元终态（closed/aborted）。当前子 wave 状态：
- [wave:auth-w1] closed ✓
- [wave:auth-w2] tested（未完成）

## 怎么修
先完成 wave:auth-w2 的剩余流程，再回来 retrospect。
下一步：cw exec-review --unitId wave:auth-w2
```

这个 guidance 由 retrospect handler 查 store（子单元状态）后计算，填入 crossLayer。

### 5.3 没有「熔断」

旧版 0.x 有「连续 fail 5 次进入熔断状态」的机制。新版不用——按 §5.1 的递进提示，失败次数越多提示越指向「换思路」，不需要特殊状态。agent 永远可以继续重试，cw 不阻断。

---

## 6. Replan 的三层渐进

replan 是「agent 主动决策」的典型——如果 agent 不知道 replan 选项存在，遇到 plan 问题时不会主动触发，会卡死。所以 replan 信息按三层渐进，解决「不知道就调不了」的悖论：

| 层 | 时机 | 给什么 | 为什么是这个时机 |
|----|------|--------|----------------|
| **第 1 层：告知选项** | plan 阶段的正常 guidance | 关键约束段一句「条目 execute 后冻结，修改走 replan」| agent 写 plan 时必须知道 plan 不能随便改 + replan 是改 plan 的唯一途径。这一句解决悖论——agent 知道 replan 存在 |
| **第 2 层：决策提示** | gate fail 且根因像 plan 问题时 | 递进提示里加「考虑 replan（cw replan --unitId ...）」| agent 卡在反复 fail 时需要的决策出口 |
| **第 3 层：操作细节** | replan action 触发时（agent 调了 cw replan）| 完整机制：命令格式 + input schema + 影响面输出怎么读 + append-only 语义 | agent 决定 replan 了才需要知道怎么操作 |

### 6.1 第 3 层：replan action 触发后的 guidance

```
## 位置
[wave:auth-w1] 状态：executing（replan 不改 status）｜影响面已计算

## 影响面（cw 计算）
- 废弃条目：[T2, TK3]（你指定 abandon 的）
- 待重建：[T2]（废弃且无新条目承接，你需要在 plan 里 append）

## 下一步
重新编写 plan，把废弃条目的意图承接进新条目。
命令：cw plan --unitId wave:auth-w1 --input @plan.json
提交完整 plan（含原 active 条目 + 新 append 条目），废弃条目标 status="abandoned" 保留。
plan 之后必须重新 design-review（replan 改了 plan，原 designReviewJudgment 失效，需刷新匹配新 plan）：
cw plan → cw design-review → cw execute（完整重走 plan 后的链路）。

## replan 机制
- replan 不是自动迁移，cw 不会把废弃条目内容搬到新条目——你负责承接意图
- 废弃条目 status="abandoned"，保留在历史里（append-only，不可删不可复活）
- wave 是叶子，replan 只影响 wave 自己（无子孙级联）
```

### 6.2 PlanningUnit 的 replan

model §3.4 规定：PlanningUnit 在 design-review 前（planning 状态）直接重新 plan 即可，不需要 replan；design-review 后发现的问题走「重建下层」而非本层 replan。PlanningUnit 的 replan 规则待各层 topic 明确，但 guidance 原则是：PlanningUnit 不像 wave 那样在执行后 replan，它走 plan 覆盖（design-review 前）或 abort+重建（design-review 后）。

---

## 7. CrossLayer 导航（多层级联）

### 7.1 级联方向：parent → child（单向）

replan 的影响传播方向是 **parent → child**（model §5.6.2 line 533：「父标记受影响 → 所有子孙级联受影响」）：

- 上层（如 slice）replan 废弃条目 → cw 计算下游影响面 → 引用废弃条目的下层（wave）级联 abort
- wave（叶子）replan 只影响自己，**永远不会向上级联到 slice**——wave 的条目不被任何上层引用（`basedOnParent` 是子引用父的快照，方向是 parent→child）

这个方向约束意味着：跨层 replan 场景只有「上层 replan → 下层级联 abort」一种，不存在「下层 replan 影响上层」。

### 7.2 PlanningUnit execute 的下沉

PlanningUnit（epic/feature/slice）的 execute = 根据 plan.split 创建子单元：

```
cw execute --unitId slice:auth-login
  → cw 根据 plan.split 创建子 wave（如 wave:auth-w1, wave:auth-w2）
  → executeResult.childUnitIds = ["wave:auth-w1", "wave:auth-w2"]
  → status → executing
```

**execute 一次性创建所有子单元**（plan.split 已定义完整拆分，渐进创建会引入额外状态跟踪）。此设计已定，见 §7.2（原 §10 Q1 待定项已闭环）。

execute 成功**本次返回**就给出下沉 guidance——因为 execute 这一步已经把 status 推到 executing 且 childUnitIds 已创建，crossLayer 在 execute handler 里算好填入 nextAction。execute 返回的 `nextAction.action = undefined`（不在本层继续推进，要跨层到子单元），agent 读 `crossLayer.targetUnitId` 作为下一个 unitId：

```
## 位置
[slice:auth-login] 状态：executing｜已创建 2 个子 wave

## 下一步
开始第一个子 wave 的流程。
命令：cw clarify --unitId wave:auth-w1
（后续靠 wave:auth-w1 各阶段返回的 guidance 推进，直到它 closeout）

## 子 wave 进度
- [wave:auth-w1] created（当前）
- [wave:auth-w2] created（待 auth-w1 closeout 后开始）
```

**action=undefined 时的路由规则**（agent 侧读取约定，跨层下沉/回溯/横向通用）：

当 `nextAction.action = undefined` 时，agent 按以下顺序决定下一步：
1. `crossLayer` 非空 → 下一个 unitId = `crossLayer.targetUnitId`，下一个 action 按 `crossLayer.kind` 决定（descend/sibling → 目标 unit 的下一个推进 action，通常是 clarify；ascend → 父 unit 的 retrospect）
2. `crossLayer` 为空且 status 是终态（closed/aborted）→ 流程结束。无 parent 的孤立单元 closeout 后必落到此分支（§1.3）
3. `crossLayer` 计算失败（父单元查不到等）→ 兜底：`cw tree --unitId <当前unitId>` 让 agent 自查树状态

**PlanningUnit execute 的 input**：wave execute 需要 commitHash（代码产出）。PlanningUnit execute 不需要提交任何内容——cw 自动从 plan.split 派生子单元。所以 PlanningExecuteInput = `{}`（空，或可选 confirm）。这是 wave 和 PlanningUnit 在 execute 阶段的关键差异。

### 7.3 子单元 closeout 后的回溯/横向

子单元 closeout 后，cw 检查父单元（如果有）的子单元状态，决定下一步（由 closeout handler 查 store 计算）：

```
子 wave closeout 成功
  → 有 parent → 查父单元的所有子单元状态
    → 有未终态的兄弟 → crossLayer 指向下一个兄弟（横向）
    → 所有子单元终态（closed/aborted）→ crossLayer 指向父单元 retrospect（回溯）
  → 无 parent → 流程结束（孤立终点，§1.3）
```

aborted 的兄弟跳过（终态，不再推进），不算待办。

### 7.4 crossLayer 计算的职责边界

crossLayer 计算需要查 store（父/子单元状态），是 IO 依赖。放在 handler 里计算，填入 `nextAction.crossLayer` 结构化字段。guidance builder 只负责把结构化字段渲染成文本——不查 store，不算导航。

action=undefined 时的路由规则见 §7.2（下沉）/ §7.3（回溯横向）+ §8 字段定义。crossLayer 计算失败（父单元查不到等）的兜底：`cw tree --unitId <当前unitId>` 让 agent 自查树状态。

---

## 8. V1NextAction 结构

当前 `src/v1/handlers/types.ts:70` 的 `ActionResult` 砍掉了 nextAction/guidance。补回并扩展多层字段：

```typescript
interface V1ActionResult {
  unitId: string;
  status: ExecutionStatus | PlanningStatus;
  gateResults?: GateResult[];
  ok: boolean;
  error?: string;
  replanImpact?: ReplanImpact;
  freezeViolations?: FreezeViolation[];
  failureCount?: number;          // 同一 action 连续 fail 次数（递进提示用，§5.1）
  nextAction?: V1NextAction;       // ok=true 时填正常 guidance；ok=false 时填异常 guidance
}

interface V1NextAction {
  action?: V1Action;               // 下一步 action（同层）。
                                   // undefined 时的路由（按序）：
                                   //   1. crossLayer 非空 → 下一个 unitId = crossLayer.targetUnitId，action 按 kind 推断
                                   //   2. crossLayer 空 + status 终态 → 流程结束（无 parent 孤立单元 closeout 后落此分支，§1.3）
                                   //   3. crossLayer 计算失败 → 兜底 cw tree --unitId <当前> 自查
  guidance: string;                // 正常三段式 / 异常聚焦式
  unitPath: {
    layer: "epic" | "feature" | "slice" | "wave";
    unitId: string;
    parentUnitId?: string;         // 无 parent 的孤立单元为空（§1.3，任何层都可无 parent）
    rootUnitId: string;            // 无 parent 时 = 自身
  };
  crossLayer?: {                   // 跨层建议（execute 下沉 / closeout 回溯时填）
    kind: "descend" | "sibling" | "ascend";
    targetLayer?: "epic" | "feature" | "slice" | "wave";
    targetUnitId?: string;
    reason: string;
  };
  itemProgress?: Array<{ id: string; status: string }>;
  evidenceProgress?: {             // wave 专属
    commitHash: boolean;
    changedFiles: boolean;
    testRunResult: boolean;
    frozen: boolean;
  };
  alternatives?: V1NextActionAlternative[];
}
```

`CreateInput` 改为 `parentUnitId?` / `basedOnParent?` 可选（epic 是根，§1.3）。

**设计原则**：结构化字段（unitPath / crossLayer / itemProgress / evidenceProgress / failureCount）走独立字段，guidance 是纯文本。agent 优先读 guidance 文本（人在回路），程序化处理时读结构化字段。

---

## 9. 代码组织

```
src/v1/guidance/
├── templates/              # 静态方法论（按类型，不按层级）
│   ├── wave/               # ExecutionUnit 9 阶段
│   │   ├── clarify.ts
│   │   ├── plan.ts         # 含冻结契约关键约束段
│   │   ├── design-review.ts
│   │   ├── execute.ts
│   │   ├── test.ts
│   │   ├── exec-review.ts
│   │   ├── retrospect.ts
│   │   ├── closeout.ts
│   │   └── replan.ts       # 第 3 层：replan 操作细节
│   └── planning/           # PlanningUnit 7 阶段（epic/feature/slice 共用）
│       ├── clarify.ts      # feature 的 FeatureClarification 形态由 injector 注入
│       ├── plan.ts         # Split[] schema
│       ├── design-review.ts
│       ├── execute.ts      # 含下沉导航
│       ├── retrospect.ts   # 含验收 + 回溯导航
│       └── closeout.ts
├── schema-injector.ts      # 从 core 类型生成 input schema 文本
├── prefix-builder.ts       # 动态位置前缀
├── failure-hint.ts         # 按 failureCount 渲染递进提示（§5.1）
├── cross-layer.ts          # crossLayer 计算（由 handler 调用，查 store）
└── build-guidance.ts       # 组装：prefix + template + schema → guidance
```

模板按 WorkUnit 类型（Planning/Execution）组织，不按层级重复。4 层共用 2 套模板，layer-specific 差异（如 layerSpecific 字段、FeatureClarification 容器）通过 schema-injector 按 layer 注入。

---

## 10. 待定项

| 编号 | 待定项 | 状态/倾向 |
|------|--------|-----------|
| Q1 | PlanningUnit execute 是否一次性创建所有子单元 | **已定（§7.2）**：一次性创建 |
| Q2 | PlanningUnit 三层模板是否真能共用一套 | 倾向共用，layerSpecific 差异靠 injector；待 slice/feature/epic 各层 topic 验证 |
| Q3 | crossLayer 计算放 handler 还是独立 builder | **已定（§7.4）**：放 handler（需查 store，是 IO），builder 只渲染 |
| Q4 | PlanningUnit 各阶段 input schema 的完整定义 | 在各层 topic（slice→feature→epic）实现时补充到 schema-injector；本文档给 slice plan（§4.5）+ wave test/exec-review（§4.3/§4.4）作为框架验证 |
| Q5 | failureCount 持久化存储位置 | **已定（§5.1）**：从 statusHistory 派生（最近连续 fail 计数），跨 session 不重置 |
| Q6 | 孤立任务（无现成树）的最小入口 | **已定（用户决策）**：任何一层都能独立起步，parent 全可选（§1.3）。不是 wave 专属，4 层都不强制有 parent |

### ~~待用户决策：孤立任务最小入口（Q6）~~（已定）

~~复查发现：一个根因已定位的小 bug...~~ → **用户决策：方案 A 扩展版——每一层都可以没有上一层**。不是只给 wave 开口子，而是 4 层从「强制树」变成「可选组合」。任何一层 create 时都可以没有 parent。设计影响已落地到 §1.3（任何一层独立起步）、§2.3（选层不再有 parent 链条）、§2.5/§2.6（升级/查树逻辑更新）、§7.3（无 parent 孤立终点）、§8（parentUnitId 全可选）。

---

## 11. 与审查反馈的对应

本文档针对两轮 subagent 审查 + 用户反馈的修订记录：

**v2 修订（第一轮审查 + 用户反馈）**：
- 熔断概念移除（审查 C4 + 用户反馈）：改为 failureCount 驱动的递进提示（§5.1）
- 选层改用工作性质（审查 P0-3）：从「规模」改为「产出物性质」（§2.3）
- 补「该不该用 CW」前置判断（审查 P0-2）：§2.2
- 补「选错了层怎么办」（审查 P2-2）：§2.5
- replan 悖论解决（用户反馈）：三层渐进，第 1 层在 plan 阶段告知选项存在（§6）
- 级联方向修正（审查 m3）：§7.1 明确 parent→child 单向，wave replan 不向上级联
- PlanningUnit execute input 明确（审查 C2）：§7.2 明确 PlanningExecuteInput = {}
- PlanningUnit schema 范围（审查 C1）：本文档定通用框架 + slice 示例，feature/epic 待各层 topic（§10 Q4）
- 渐进式 guidance 原则（用户反馈）：§3，区分 cw 主动返回 vs agent 主动决策两类信息的给法

**v2.1 修订（第二轮复查）**：
- §7.2 跨层下沉断点修复：「下一次返回」自相矛盾 → 改为 execute 本次返回即给下沉 guidance + 补 action=undefined 路由规则（复查 M 级断点）
- §8 action=undefined 路由规则补全：V1NextAction.action 注释加三步路由约定（复查 M3）
- §5.1 第 3 次 fail 递进提示补 replan 出口：与 §6 第 2 层承诺对齐（复查 replan 第 2 层缺口）
- §6.1 replan 后补 design-review 链路：plan → design-review → execute 完整重走（与 model §3.4 对齐）
- §4.3/§4.4 补 wave test + exec-review 正常 guidance 示例（复查示例覆盖缺口）
- §10 Q1/Q3/Q5 标注已定，新增 Q6 孤立任务最小入口待决策

**v2.2 修订（用户决策：每层独立起步）**：
- §1.3 重写：任何一层都能独立起步，parent 全可选。4 层从「强制树」变「可选组合」。无 parent 时流程差异（design-review 判断基准变化，产物结构不变）
- §2.3 选层：去掉「没有 parent 往上层走」链条，改为「选定即起步」
- §2.5/§2.6：升级/查树逻辑更新（不补齐整条链，只建需要的层）
- §7.3：closeout 回溯补「无 parent 孤立终点」分支
- §8：parentUnitId 全可选，rootUnitId 无 parent 时=自身
- Q6 已定：方案 A 扩展版（每层都可无 parent，非 wave 专属）

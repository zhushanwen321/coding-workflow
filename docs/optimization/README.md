# cw-cli 优化方向（2026-08 裁决版）

> **层次声明**：本文档是**方向裁决层**——整合多路独立分析与数据复核，裁定优化方向、优先级与被否路线。下一层是各方向的立项设计，见三个子文档（[方向 A](./direction-a-e2e-real-verification-anchor.md) / [方向 B](./direction-b-parallel-scheduling-consumer.md) / [方向 C](./direction-c-wave-executor-merge.md)）。本文档不设计具体实现。
>
> **证据与方法**：三个独立 AI 分析（覆盖源码引用、store 数据统计、消费侧 git 历史、ADR 决策史四路证据）经逐条独立复核后整合；本文所有数字为 2026-08-14 对主 store（`~/.cw/__Users__zhushanwen__Code__xyz-agent-workspace__.bare/store.json`）重新自算的复核值，store 持续增长中，趋势比绝对值重要。

**一句话结论**：四层模型、状态机、gate 机制、依赖数据链路都不需要重构；真正的问题是 [ADR-0011](../adr/0011-recursive-parallel-scheduling.md) 回退后留下的**两个责任真空**——验证真空（引擎侧，E2E real 无机器锚点）与编排真空（消费侧，并行调度无人消费），外加一个流程粒度失配（wave 状态机不追踪真实编码）。对应三个定向改造，按依赖顺序 **A 验证锚点 → C 执行合并 → B 并行补位** 实施。

## 1. 背景目标

**SCQA**：

- **S（情境）**：cw-cli 是四层（epic → feature → slice → wave）agent 编码流程引擎，xyz-agent 通过 `extensions/cw-tool` 消费（5 个 agent 模板 + 4 个工具白名单）。截至 2026-08-14：主 store 214 units / 128 waves（113 closed），聚合全部 9 个 xyz-agent store 共 181 waves（158 closed）。
- **C（冲突）**：使用中有三个体感——① wave 执行实际不并行，一个接一个排队；② 单 wave 流程重，要 4 个 subagent 上下文、约 10 轮 cw 命令；③ 验证弱，期望「重设计、轻开发、重验证」（核心 case 的 E2E real 必须真实执行），但现状是「写一句 note 就算验收」。
- **Q（问题）**：优化应该动引擎还是动消费侧？要不要推翻流程模型？
- **A（答案）**：不推翻。两个真空各打一个断点（A 打验证断点、B 打编排断点），外加一次流程瘦身（C），见 §3。

**设计目标**（从使用者体验倒推）：

| # | 目标 | 判据 |
|---|---|---|
| G1 | 核心验收 case 的 E2E real 有机器锚点 | 「manual 用例 + 空 note」不可能 closeout；真实验证有结构化产物可查 |
| G2 | 并行能力被真实消费 | 有依赖声明的兄弟 wave 按就绪批次推进，不再 94.5% 串行 |
| G3 | 单 wave 编排成本下降 | subagent spawn 数/ave 从 4 降到 3（角色 4→2：执行者 + 独立审查者）；plan 作者→执行者的上下文搬运消失 |

**in scope**：cw 引擎的 gate / plan schema / guidance 模板；xyz-agent `extensions/cw-tool` 的 agent 模板与工具白名单；pi subagent 派发死锁修复（B 的前置）。

**out of scope**：四层模型与状态机重构；引擎侧并行调度（ADR-0011 已裁决归消费者，本次不推翻）；pi subagent 基础设施的整体重设计（只修死锁）。

## 2. 现状与问题分析

### 2.1 三次设计、三次回退：并行能力的完整历史

结论先行：**并行基础设施已 100% 齐备，但每一层都退出后无人消费，「调度责任」落在两层之间的缝里。**

| 时间 | 事件 | 结果 |
|---|---|---|
| 2026-08-03/04 | ADR-0011：引擎侧并行调度（parallelTargets + 伪 Kahn + 并行 guidance）设计、审查、实现 | **次日整体回退**，理由「pi 的 recursive-split workflow 已接管调度，cw 回归 agent-agnostic：只提供数据视图与单值导航，调度决策归消费者」；仅保留 `noSiblingWaveFileConflict` gate |
| 2026-08-06 | 接管者 `.pi/workflows/recursive-split.js`（frontier 驱动 BFS + topoSort + parallel 并发派 agent）被删除（commit `a03664e81`，改为 skill + agent 模板） | **ADR-0011 回退的前提失效，但回退没有跟着撤销** |
| 2026-08-13 | 消费侧 agent 自递归编排撞上 keep-alive/session-pending 死锁（xyz-agent commit `f156838a6`）：父 subagent 第一轮派发就被杀，子完成信号回不来，wave 卡在 created/design-reviewed 没人推进 | **workaround：verify/wrap-up 类 wave 退回线性单 agent 串行模式**（commit 原文 "linear subagent mode for verify/wrap-up waves"） |

三次回退的共同点：**不是因为设计错了，而是消费侧执行基础设施不稳定**。这决定了修复方向——不是重新设计调度算法（算法和数据都对），而是补上消费侧的确定性消费 + 修掉执行层死锁。

### 2.2 数据画像（2026-08-14 自算复核）

| 指标 | 值 | 含义 |
|---|---|---|
| closed wave 的 testCommand 含 vitest | 107/113 = 94.7% | 机器验证几乎只剩局部单测 |
| testCommand 只引用 1-3 个测试文件 | 64/113 = 56.6%（另有 31 个不引用具体文件） | 「最小测试集」导向，离 E2E 最远 |
| `type=e2e` 用例的 `verification=manual` | **19/19 = 100%**（全库 761 个用例） | E2E real 完全在机器验证体系之外 |
| 兄弟 wave 执行区间（execute→closeout）重叠 | **7 对重叠 / 121 对串行 = 94.5% 串行** | 并行从未真实发生 |
| create → execute 中位耗时 | 30.3 分钟（create→closed 中位 44.3 分钟，占比约 2/3） | 编码开始前的时间占大头 |
| 单 closed wave 平均 statusHistory 条目 | 9.8 条 | 每 wave 约 10 条 cw 命令记录（驱动者归属 store 不记录） |
| executing → tested 间隔 < 5 秒 | **17/113 个 wave**（如 `history-converter::m4` 1.0 秒 / 16 文件） | 粒度失配信号：wave 的 executing 状态是「编码完成后的事务性登记」（execute 入口校验 commitHash 已存在），真实编码时间不被任何状态追踪 |
| cw 自身 dogfooding | 自有 store 仅 3 units（1 slice + 2 wave），从未走完四层 | 作者自己只跑最轻路径，是对流程重量的强信号 |
| replan 触及的 wave | 12/113 | 拆分质量本身健康，问题不在规划层 |

### 2.3 gate 信任模型：形式完备、实质空转

结论先行：**gate 把力气花在验「agent 填了文本」，而不是验「行为真的发生了」；唯一硬验证（test 阶段实跑 testCommand）的信任根，是 agent 自己写的命令。**

逐条看（均为源码核实）：

1. **wave design-review 的 10 个 gate 中 9 个是纯非空/结构检查**（`src/rules/gates/design-review.ts:221-239` 聚合，文件头自注「只验结构不验内容」）。唯一例外 `noSiblingWaveFileConflict`（:142-193）是集合交集逻辑。`testCommandNonEmpty` 的 JSDoc（:56）自承：「仅校验字段非空——不 spawn、不校验文件存在、不解析命令有效性」。
2. **test 阶段 4 gate 的信任根错位**（`src/rules/gates/test.ts`）：`testsAllPass` 实跑 testCommand 取退出码——但命令内容 agent 自己写，`echo ok` 也能过；`testCasesExecuted`（:212-259）是计数启发式——vitest 输出正则取「N passed」加总 ≥ 非 manual 用例数即过，**不比对测试名**；manual 类用例只要 `sufficiencyMet.note` 非空即过（:244-253），note 内容与用例的对应关系机器完全不验。
3. **格式只认 vitest，行为不可见**：stock-dag store 有 wave 用 `sed` 把 node:test 的「ℹ pass N」输出转成 vitest 的「N passed」格式喂给解析器（statusHistory replan note 原文）——不转换则真实跑过的测试被计数为 0 反而过不了 gate。计数启发式只认格式不认行为，「格式伪装」在体系里有利可图。
4. **E2E real 三层无锚点**：
   - plan 层：`WavePlan`（`src/core/plan.ts:66-75`）没有验收方式字段；`WaveTestCase.type` 有 `"e2e"` 枚举值（:87），但这是全 src 里 e2e 的几乎全部存在感，机器处理上与 unit 无差别；
   - gate 层：没有任何 gate 强制「核心 case 必须有 e2e 用例」，没有 gate 要求 e2e 用例进机器验证；
   - 证据层：`testRunResult` 只解析 vitest 格式（`src/utils/parse-vitest-output.ts`），真实 E2E 的结果只能写进 evidence.summary 自然语言。
5. **最锋利的一条断链**：许多 wave 把 E2E 推给「slice 层收编验证」，但 planning 层状态机（`src/rules/state-machine.ts:242-250`）**根本没有 test / exec-review action**（头注释明示「PlanningUnit 不跑代码测试」）。E2E real 被推给了一个永远不会机器验证它们的地方，最终无人兜底。
6. **反面锚点**：`scheduler-session-scope::e2e-verify` wave 真的做了 E2E real——真实 pi 0.84.0 进程 + 真实模型实测 10 个场景全 PASS、每场景附 session JSONL 文件级证据。但它的 testCommand 是 `node --check`（语法检查），`testRunResult` 计数 0/0。**体系能支持 E2E real，但做了也白做——机器 gate 与真实验证完全脱节，无强制、无结构化沉淀。**
7. **guidance 甚至反向激励**：wave design 模板明文「严禁跑全量测试——只限定本 wave 改动相关的最小测试文件集合」（`src/guidance/templates/wave.ts:56`）。单测最小集是对的，但没有任何对称的文案告诉 agent E2E real 该在哪声明、在哪执行。

### 2.4 根因裁决

三个体感（不并行 / 流程重 / 验证弱）不是独立问题，共享根因：**ADR-0011 回退后「调度与验证的责任归属」成为真空**——引擎说「我 agent-agnostic，只给数据」，消费侧模板只说「请 LLM 自觉」。具体拆成三个断点：

| 断点 | 层 | 表现 | 对应方向 |
|---|---|---|---|
| 验证断点 | 引擎（cw） | E2E real 无 schema 字段、无 gate、无结构化证据通道 | **方向 A** |
| 编排断点 | 消费侧（cw-tool） | frontier/dependsOn 数据齐备但 0 消费；派发死锁回退串行 | **方向 B** |
| 粒度失配 | 消费侧（cw-tool） | wave 状态机不追踪真实编码（executing 是编码后登记），流程粒度与实际工作单元失配 | **方向 C** |

### 2.5 「设计前移」假设的反驳

有一个直觉方案是「把设计压到 epic/feature/slice 层做重，wave 就可以精简成纯执行」。数据不支持：

- 设计**已经**主要在 wave 层发生且是最大时间块（create→execute 中位 30.3 分钟，占 wave 总时长约 2/3；每个 wave 产出约 7.5KB 设计文本，内含 testCases/tasks/files/contracts）；
- 上层设计再充分，wave 层的 testCases 与 TDD 任务拆解也省不掉——那是执行层必需的粒度；
- planning 层的 design-review 同样以非空检查为主，「上层设计质量」本身没有机器验证兜底——设计前移只是把声明文本挪了个层。

所以「重设计」的正确落点是**重验证**（方向 A），不是把设计文本搬到 planning 层。planning 层与 wave 层确有重叠可省（slice 的 techChoices/interfaces 与 wave 的 contracts），那属于方向 C 的辅助项，不是主杠杆。

## 3. 解决方案

### 3.1 终态（使用者视角）

三个方向全部落地后，一个典型 feature 的开发过程变成：

1. **slice execute 后**，planning-agent 调 `cw frontier` 拿到就绪批次（如 wave A/B 就绪、wave C 依赖 B 阻塞中），**同 turn 后台派出 A、B 两个 wave-agent**（worktree 隔离），不再逐个排队；C 等 B closeout 后下一批派出。（方向 B）
2. **每个 wave-agent 自己完成 design → 编码 → test**：design 阶段必须在 plan 里声明核心验收 case 的验证方式，其中核心 case 必须有可行的 E2E real 路径（引擎第 11 个 gate 拦截空声明）；编码与测试不再移交 dev-agent，wave-agent 亲自跑（工具白名单扩展）。（方向 A + C）
3. **独立 review-agent 做两轮审查**（design-review 人审 E2E 路径可行性 + exec-review），审查者永远不是执行者。（方向 C 保留项）
4. **E2E real 有机器通道**：testCommand 之外可声明真实环境验证命令，执行结果与证据产物路径结构化落盘（testRunResult 不再只认 vitest 计数）；manual note 必须引用具体证据产物，「留真实环境」这类空话不再能过 gate。（方向 A）
5. 单 wave 的 subagent 拓扑收敛为**执行者 + 两轮独立审查**（3 次 spawn，角色 2 种），plan 作者与执行者之间的上下文搬运消失；cw 命令数本身不减少（状态机 8 步不动）。（方向 C）

失败路径示例：wave-agent 声明的 E2E real 路径不可行（如依赖不存在的 fixture）→ design-review subagent 人审驳回 → wave 停在 designed，replan 重写 plan 的验收声明——**错误在进入编码前被拦下，而不是 closeout 后发现没验证**。

### 3.2 三方向裁决表

| 方向 | 改什么 | 在哪改 | 性质 | 子文档 |
|---|---|---|---|---|
| **A：E2E real 验证锚点** | plan schema + design-review 第 11 个 gate + test 证据通道 + manual note 收紧 | cw 引擎（`plan.ts` / `gates/` / 模板） | 长期方案，正确性问题，**最先做** | [direction-a](./direction-a-e2e-real-verification-anchor.md) |
| **C：wave 执行侧合并** | wave-agent 吸收 dev-agent（白名单加 execute/test），review 保持独立 | 消费侧（`extensions/cw-tool`） | 长期方案，小改动，第二做 | [direction-c](./direction-c-wave-executor-merge.md) |
| **B：并行调度补位** | 修死锁前置 + 确定性 frontier 批次派发（模板协议起步，确定性代码收尾） | 消费侧（`extensions/cw-tool`）+ pi 死锁修复 | 长期方案，最后做（依赖 A 的验证底座） | [direction-b](./direction-b-parallel-scheduling-consumer.md) |

### 3.3 关键决策与权衡

每条决策独立成段：选择 + 被否 + 证据。

**D1：不恢复引擎侧并行调度（不推翻 ADR-0011）。**
被否方案：恢复 `parallelTargets` / 改 `descend`/sibling 导航为多目标（`src/handlers/slice/execute.ts:95-104` descend 只指第一个 child、`src/guidance/cross-layer.ts:75-80` 兄弟路由 `.find()` 不查依赖——这两处是 ADR-0011 裁决的**刻意行为，不是 bug**）；复活 `recursive-split.js` workflow 宿主。
理由：ADR-0011 的架构理由「cw 保持 agent-agnostic，调度归消费者」依然成立——变的只是消费端（接管者已删）。`crossLayer` 单值语义被现有测试与 guidance 渲染广泛依赖，改多目标破坏面大；workflow 宿主的维护负担正是当初删除它的原因。引擎侧该补的只有**数据可发现性**（`Split.dependsOn` 是无 JSDoc 裸字段、planning design 模板只字未提其语义——补文档与模板说明，不改调度行为）。

**D2：验证升级是第一优先级，且先做最小实验。**
被否方案：直接上完整 schema + 通道 + 比对一步到位。
理由：19/19 manual、e2e-verify 的 0/0 证明「验证弱」是真断点；但 gate 加深会直接增加每个 wave 的摩擦（粒度失配信号——17/113 个 wave executing→tested < 5s——说明流程与实际工作单元有张力），所以先用半天工作量的第 11 个 gate 最小实验验证「声明拦截」是否有效、是否拖慢流程，带证伪条件，再决定加深到哪一步（见方向 A 子文档 §3.3）。并行（B）排在验证（A）之后的因果论证：**没有验证底座的并行，只是更快地批量产出未验证代码**。

**D3：「1 个 subagent 完成 1 个 wave」修正为「2 种角色」。**
被否方案：单个 subagent 从 design 包到 closeout（含审查）。
理由：design-review / exec-review 的强制独立委派是 anti-self-review 的刻意设计（`subagent-guidance.ts` mandatory 三档）；审查合并进执行者 = 自审，恰好与「重验证」方向矛盾。正确形状：**1 种执行者（wave-agent 吸收 dev-agent）+ 1 种独立审查者（review-agent，两轮为两次独立 spawn）**——按 spawn 数诚实计数是 4→3，不是 4→2。

**D4：流程削减的目标是上下文重建，不是步数。**
证据：仪式步骤单看中位只要 0.2-2.8 分钟（自算：design-review 0.67 / test 0.46 / exec-review 2.79 / retrospect 0.61 / closeout 0.20），重在每个步骤都是一次完整的「读 guidance → 构建 input → 调 cw → 等返回」循环，加 subagent 上下文重建（mandatory 委派 3 档）。所以方向 C 的收益来自砍 subagent 切换与上下文搬运，不来自砍状态机步骤——状态机与 cw 命令数不动（基线 9.8 条/wave）。

**D5：「状态机不追踪真实编码」按「信号」处理，不按「bug」处理。**
wave 的 executing 状态是编码完成后的事务性登记（execute 入口校验 commitHash 已存在，先写码后登记是设计流程），真实编码时间不被任何状态追踪——17/113 个 wave 的 executing→tested 间隔 < 5 秒却携带真实多文件 commit，是流程粒度与实际工作单元失配的信号。不追责、不修状态机。方向 C 的合并减少走账层数作为回应；若 C 落地后秒级 tested 仍大面积存在，再评估 wave 拆分粒度 guidance（超出本次 scope）。

**D6：数字口径声明。**
本文所有数字为 2026-08-14 主 store 自算值。历史上不同分析给出的 closed wave 数从 110 到 131 不等（口径错误或过期快照），引用本文档数字时以「自算 + 注明日期」为准，不要转述历史分析里的数字。

## 4. 验收（方向级）

各方向的详细验收场景在子文档 §4，此处列跨方向的总验收。三要素：场景、步骤、通过标准。

| 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|
| V1 未验证拦截：拿一个已 closed 的历史 wave（含 manual e2e 用例 + 「留真实环境」note）的 plan 重放新 gate | 用方向 A 的 A1 gate 对该 plan 跑一次 | gate fail 且文案指向恢复动作（如何声明 E2E real 路径） | G1 |
| V2 真实 E2E 沉淀：新建一个含 E2E real 的 wave（模仿 e2e-verify 的真实 pi 进程实测）走完流程 | closeout 后重开 store 查 evidence | E2E 执行结果与证据产物路径结构化可查，testRunResult 不再是 0/0 与真实结果的脱节 | G1 |
| V3 并行推进：在 xyz-agent 选一个真实 slice（3+ wave、声明 dependsOn）实施 | 观察兄弟 wave 的 execute 区间时间戳 | 就绪批次内 wave 并行推进（execute 区间重叠），被依赖 wave 阻塞不提前 execute；无文件冲突事故 | G2 |
| V4 编排成本：统计实施后 10 个连续 closed wave | 数 subagent spawn 数与 cw 命令数（数据源：pi subagent session 文件 + statusHistory——store 不记录驱动者归属，spawn 数必须从 pi session 侧取） | 每 wave subagent spawn ≤ 3；cw 命令数中位不高于基线 9.8 | G3 |
| V5 回归护栏：全量跑 cw 引擎测试套件 | `npx vitest run` | 全绿（A 的 gate/schema 改动向后兼容，存量 store 不迁移也能跑） | G1-G3 |

## 5. 下一层拆分

### 实施顺序与依赖

```
A1 第 11 个 gate（半天最小实验，带证伪条件）
 ├─ 通过 → A2 manual note 收紧 → A3 acceptance schema + 证据通道 →（可选）A4 测试名比对
 └─ 证伪 → 回到方向 A 子文档 §3.2 重选方案，B/C 不受影响
C 执行侧合并（与 A 并行可做，独立可交付；建议在 A1 结论后动手，吸收 A 对模板的改动）
B0 修派发死锁（前置，无它并行必退串行）
B1 模板协议批次派发（消费 cw frontier，已有数据）
B2 确定性批次派发（frontier + 拓扑逻辑进 cw-tool 代码，摆脱 LLM 自觉）
```

### 立项方式

- **方向 A**：改 cw 引擎自身，走 cw 自己的正常编码流程（`cw create`），dogfooding——顺带修复「cw 自身从未走完四层」的信号。
- **方向 B / C**：改 xyz-agent 仓库 `extensions/cw-tool/`，走 xyz-agent 的 worktree 流程。

### 拆分 justification

- A 拆四步（A1→A4）而非一步：每步独立可验收、可回滚；A1 是实验性质（证伪条件见子文档），失败不沉没成本。
- C 拆两步（白名单 + 模板改写→观察秒级 tested 占比变化）：改动面小（两个文件 + 一个白名单常量），不拆更细。
- B 拆三步且排最后：B0 是硬前置（死锁不修，并行必然回退串行，历史已证明）；B1→B2 是从「协议约束」到「确定性代码」的渐进，B2 依赖 B1 的实际运行数据决定批次算法形态。

### 待验证检查点（设计阶段无法确定，诚实标注）

- A1 实验的三个观察指标结果（拦截有效性 / 摩擦影响 / e2e 与 integration 型用例标注占比变化——防「重标注绕过」）——决定 A2-A4 的深度。
- 死锁根因：f156838a6 的 handoff 已给出具体根因假设（SessionManager 延迟落盘与 session-pending 磁盘读取的矛盾）与最小复现设计——B0 从证实/证伪该假设起步，不是从零排查。
- 113 个 closed wave 的实际驱动模式分布（单 agent 直驱 vs 模板编排）——statusHistory 无 agent 归属字段，需从 pi subagent session 日志侧核实；G3 的收益基线按模板设计的 4 spawn 模式计算（见方向 C §1）。
- A×C 叠加的上下文压力：A3 把分钟级的真实 E2E 加进 wave 工作量，C 又把 design+编码+测试并进同一上下文——两者各自的风险分析不能线性相加，C 实施后需实测叠加场景。
- C 合并后 wave-agent 的 bash/write 权限扩大是否引入越权风险——实施期做一次权限面审查。

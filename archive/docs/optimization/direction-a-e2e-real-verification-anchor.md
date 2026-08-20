# 方向 A：E2E real 验证锚点（cw 引擎侧）

> **层次声明**：本文档是方向 A 的立项设计——当前层为「验证语义升级」，下一层是具体实施（gate 函数 / schema 变更 / 模板文案的编码任务）。父文档与整体裁决见 [README](./README.md)。

**一句话结论**：分四步把「核心 case 的 E2E real」从 agent 自述变成机器锚点——第一步是 wave design-review 的第 11 个 gate（半天工作量的最小实验，带证伪条件），先验证「声明拦截」有效且不拖垮流程，再逐步加深到 note 收紧、schema 声明与结构化证据通道。

## 1. 背景目标

### 系统是什么（受众补足）

cw 的 wave 层是叶子执行单元，走 8 步状态机（create → design → design-review → execute → test → exec-review → retrospect → closeout）。其中 **test 是全流程唯一由机器实跑验证的步骤**：`cw test` spawn 执行 `plan.testCommand`（`src/cli.ts:695-706`，spawnSync + 退出码判定），解析 vitest 输出计数填入 `evidence.testRunResult`。design-review 是进入编码前的守门步骤，由 10 个纯函数 gate 组成。

「E2E real」指：**在真实运行环境里验证真实行为**——对 xyz-agent 这类项目是「真实 pi 进程 + 真实模型的场景实测」，而不是进程内单测、mock 集成或语法检查。

### 问题

现状是 E2E real 在机器验证体系里三层皆空：

| 层 | 现状 | 证据 |
|---|---|---|
| plan 层 | `WavePlan` 无验收方式字段；`WaveTestCase.type` 有 `"e2e"` 枚举但与 `"unit"` 机器处理无差别 | `src/core/plan.ts:66-75`（字段清单）、`:87`（type 枚举） |
| gate 层 | 无 gate 强制核心 case 含 e2e 用例；无 gate 要求 e2e 进机器验证 | design-review 10 gate 清单（`src/rules/gates/design-review.ts:221-239`）无一项涉及 |
| 证据层 | `testRunResult` 只解析 vitest 格式；真实 E2E 结果只能写进 summary 自然语言 | `src/utils/parse-vitest-output.ts:34-39`（正则） |

数据的三个刺点（2026-08-14 复核）：

1. 全库 761 个用例中 `type=e2e` 共 19 个，**19/19 全部 `verification=manual`**——零个进机器验证。
2. 唯一一次真实 E2E（`scheduler-session-scope::e2e-verify`：真实 pi 0.84.0 进程 + 真实模型，10 场景全 PASS，每场景附 session JSONL 文件级证据）——testCommand 是 `node --check`（语法检查），`testRunResult` 为 `{passed:true, passedCount:0, failedCount:0}`。**做了也白做：机器 gate 与真实验证完全脱节。**
3. 更隐蔽的断链：许多 wave 在 note 里写「E2E 留 slice 层收编验证」，但 planning 层状态机**没有 test/exec-review action**（`src/rules/state-machine.ts:242-250`，头注释明示「PlanningUnit 不跑代码测试」）——E2E 被推给一个永远不会机器验证它们的地方。

### 目标（G1，回溯父文档）

核心验收 case 的 E2E real 有机器锚点：「manual 用例 + 空 note」不可能 closeout；真实验证有结构化产物可查。

**in scope**：`src/core/plan.ts`（schema）、`src/rules/gates/design-review.ts` 与 `src/rules/gates/test.ts`（gate）、`src/cli.ts`（testRunner）、guidance 模板文案、store 兼容。

**out of scope**：状态机步骤（不加新 action）、cross-layer 导航、消费侧 agent 模板（cw-tool 侧配合项归方向 C/B）。

## 2. 现状与问题分析

### 2.1 gate 清单与信任模型逐条核实

wave design-review 的 10 个 gate（`design-review.ts:221-239` 聚合）：

| gate | 语义 | 检查性质 |
|---|---|---|
| `test-cases-non-empty`（:38） | testCases ≥ 1 | 纯非空 |
| `test-command-non-empty`（:59） | testCommand 非空 | 纯非空（JSDoc :56 自承「不解析命令有效性」） |
| `test-cases-have-expected`（:71） | 每条用例 expected 非空 | 纯非空（只验填了不验对错） |
| `wave-layer-specific-non-empty`（:91） | wave 专属 4 字段（覆盖/边界/mock 策略/TDD 红灯）非空 | 纯非空 |
| `no-sibling-wave-file-conflict`（:142） | 与兄弟 wave 的 files 交集 | 集合逻辑（唯一非非空检查） |
| `design-review-necessity-non-empty` 等 5 个 judgment 项（:250-395） | necessity/sufficiency/alternatives/tradeoffs/risks 非空或结构存在 | 纯非空/结构 |

test 阶段 4 个 gate（`test.ts`）：

| gate | 语义 | 信任根 |
|---|---|---|
| `commitExists`（:44） | evidence.commitHash 非空且存在 | 声明 |
| `testsAllPass`（:79） | 实跑 testCommand 退出码 = 0 | **命令是 agent 自己写的**（`echo ok` 也能过） |
| `testReferencesDesignReview`（:117） | judgment 引用一致性 | 结构 |
| `testCasesExecuted`（:212-259） | executedCount（passed+failed）≥ 非 manual 用例数 | **计数启发式，不比对测试名** |

manual 类用例的退化路径（`test.ts:244-253`）：`sufficiencyMet.note` 非空即过。closed wave 的验收 note 原话模式（store 逐字摘录）：「manual S6/S6b(pi CLI 两层递归 list 拉取…)留真实 pi」「留真实 pi 环境」「TC5（端到端手工验收）不在自动测试范围，留待 dev 环境 + staged builtin todo/goal extension 手工验收」「归 slice 层收编验证」——**wave 全部 closed，而这些「留真实环境」的用例从未执行，真实环境验证记录为零**。

格式只认 vitest 的实证（stock-dag store，statusHistory replan note 原文）：node:test 的「ℹ pass N」输出被解析器计为 0，agent 用 `sed` 把它转成 vitest 的「N passed」格式才能过 gate——**不伪装则真实测试计数为 0**。这说明计数启发式只认格式不认行为，「格式伪装」在体系里是必要操作，测试名比对（A4）缺位时 gate 无法区分「真跑了」与「格式对了」。

### 2.2 四个缺口（整合归纳）

1. **缺口①（存在性）**：没有 gate 强制「核心 case 必须有 e2e 用例且 verification ≠ manual」。
2. **缺口②（执行范围）**：e2e 用例不强制进任何机器验证通道（testCommand 或专用通道）。
3. **缺口③（比对强度）**：`testCasesExecuted` 是计数启发式，不比对测试名——可被 sed 类取巧绕过。
4. **缺口④（命令约束）**：testCommand 内容无约束，纯语法检查（`node --check`）可以作为唯一「验证」通过全部 gate。

### 2.3 约束与反作用力

- **反摩擦约束**：流程粒度与实际工作单元存在失配（17/113 个 wave 的 executing→tested < 5 秒却携带真实多文件 commit——executing 状态是编码后登记，不追踪真实编码）；gate 加深会增加每个 wave 的摩擦，必须渐进并观察影响——这是 A1 做成最小实验的原因。
- **单测最小集是对的**：design 模板「严禁跑全量测试」（`wave.ts:56`）针对的是单测选择，本方向不推翻它——E2E real 是**新增的独立声明与通道**，不是把全量测试塞回 testCommand。
- **向后兼容**：存量 store（9 个 store、181 waves）不迁移也要能继续读——schema 新增字段一律 optional。

## 3. 解决方案

### 3.1 终态（使用者视角）

一个 wave-agent 在 design 阶段填 plan 时，多填一块验收声明（示意，字段名实施期定）：

```
acceptance:
  coreCases: [TC-3]                    # 核心 case 引用 testCases.id
  e2eReal:
    - caseId: TC-3
      command: "node tools/verify-scheduler-e2e.cjs --scenario S1-S6"
      evidencePath: "tools/__e2e_out__/"   # 执行产物落盘目录
```

- design-review 时，第 11 个 gate 检查：**凡被标记为「核心」的用例，必须有 acceptance 声明，且声明的 command 非空、非纯语法检查形态**；「可行性」（场景是否真实、fixture 是否存在）由 design-review subagent 人审——机器验「声明了且形式可执行」，人审「这条路真的走得通」。分工与 tech-design 准则 11（验收用真实场景）对齐。
- test 阶段，e2e real 声明的 command 被实跑（或按声明推迟到指定阶段执行），结果与 evidencePath 下的产物路径**结构化**写入 evidence（新 evidence 类型，与 vitest 计数并列），不再挤进 summary 文本。
- 没有条件跑真实 E2E 的 wave（如纯文档改动）显式声明 `acceptance.coreCases: []` + justification，由人审裁决是否豁免——**豁免是显式声明出来的，不是靠漏填混过去的**。
- manual note 收紧后：「留真实 pi 环境」这类空话不再能过 `testCasesExecuted`——note 必须引用具体证据产物。机器检查形态：note 中至少含一个产物标识模式（文件路径 / 命令输出引用 / session id）；**产物的存在性与真实性由 exec-review subagent 人审**（机器验「引用了」，人审「引用是真的」）——与 D2 的信任边界一致，不引入新的形式检查面。

失败路径：声明了 e2e real 但执行失败 → `testsAllPass` fail → wave 停在 tested 之前，replan 或修复后重跑；恢复指引由 gate 文案给出（指向「如何重跑单条 e2e 命令」「如何查看 evidencePath 产物」）。

### 3.2 方案对比

| | 方案一：四步渐进（推荐） | 方案二：一步到位（直接终态 schema + 通道 + 比对） | 方案三：只收紧 manual note |
|---|---|---|---|
| 内容 | A1 第 11 个声明 gate（纯函数，半天）→ A2 manual note 引用证据产物 → A3 acceptance schema + 结构化证据通道 →（可选）A4 测试名比对 + 命令约束 | A1+A2+A3+A4 一次性实现 | 仅改 `test.ts` manual 分支 |
| 长期合理性 | 高：每步独立可验收可回滚，终态与方案二相同 | 高 | 低：只堵缺口②的一半，存在性/比对/命令约束三缺口不动 |
| 短期成本 | A1 半天；A2 小时级；A3 1-2 天 | 3-5 天且一次触达 schema/gate/runner/模板四个面 | 小时级 |
| 风险 | 低：A1 带证伪条件，失败即止 | 高：在未验证「声明拦截是否有效、是否拖慢流程」前全面加摩擦，粒度失配可能恶化（agent 更强地绕过流程）；schema 定形后发现语义错则返工面大 | 低但不解决根因 |
| 若用它，§2 的例子会怎样 | e2e-verify wave 在 A3 下结构化沉淀 10/10；「留 slice 层」空 note 在 A2 下被拦 | 同左，但如果 A1 假设被证伪，沉没成本已是全部 | 「留 slice 层」note 仍可通过（它引用了 slice 层这个「产物」的模糊说法，拦截取决于实现严格度）；19/19 manual 结构不变 |

**推荐方案一**。A1 的证伪条件见 §3.3。

### 3.3 关键决策与权衡

**D1：A1 是最小实验，判定式只用既有字段，带证伪条件。**
第 11 个 gate——「E2E real 声明 gate」，**不触 plan schema**（acceptance 字段是 A3 的交付物），判定式全部基于既有字段：
- 凡 `testCases[].type ∈ {e2e, integration}` 的用例，`verification` 不得为 `manual` 也不得缺省（必须走机器验证）；
- `testCommand` 不得为纯语法检查形态（`node --check` / `echo` 类——e2e-verify wave 的教训：真实 E2E 做了，机器记录却是 0/0）。

纯函数 + 测试，半天工作量。拿最近一个真实 closed wave（含 manual e2e 用例的）回放验证。三个观察指标：
- ①拦截有效性：能否拦住「e2e/integration 用例标 manual」的 plan，且 fail 文案可操作（指向恢复动作：改为机器验证或显式豁免路径）；
- ②摩擦影响：一个 wave 从 create 到 closeout 的 wall time 是否因该 gate 显著增加（对比同期中位数 44.3 分钟）；
- ③重标注占比：实施前后 `type ∈ {e2e, integration}` 用例的占比变化——**A1 的已知盲区是重标注绕过**（把本该标 e2e 的用例改标 unit，gate 永不触发；现状 19/19 已标 manual 说明回避机器验证的倾向存在）。指标③激增 = 重标注绕过正在发生，A1 失效。

证伪条件：若拦截形同虚设（占位声明或重标注普遍过 gate）、或 wall time 显著增加而验证收益不可见，**停止加深，回到方案对比重选**——A2-A4 不启动。重标注绕过的彻底收口在 A3（acceptance.coreCases 声明独立于 type 标注，核心 case 由 agent 显式声明而非依赖 type 自报）。

**D2：机器与人审的信任边界。**
机器只验「声明存在 + 形式可执行」（字段非空、command 不是 `node --check`/`echo` 类纯语法形态、evidencePath 可写）；「这条 E2E 路径是否真实可行」由 design-review subagent 人审（这正是 mandatory 独立委派存在的意义）。不试图让机器判断可行性——那会退化为新的形式检查（如强制 fixture 文件存在），继续被 Goodhart 化。

**D3：A3 的证据通道向后兼容。**
`testRunResult` 保持 vitest 语义不动；新增并列的 e2e 证据结构（类型/命令/退出码/产物路径/时间戳）。存量 store 无该字段照常可读（optional 字段）。不做存量迁移。

**D4：A4（测试名比对 + 命令约束）标为可选后置。**
测试名比对需要 testCases 与 vitest 用例名的映射约定（命名规范或显式映射字段），改动面大且依赖 A3 的 schema 先稳定；命令约束（禁纯语法检查作为唯一验证）在 A1 的「形式可执行」检查里已部分覆盖。是否做、做多严，由 A1/A3 的实际运行数据决定。

**D5：豁免必须显式。**
无 E2E 需求的 wave（纯文档/配置改动）走 `coreCases: []` + justification + 人审豁免，而不是让 gate 静默放行——「常态没有 E2E」是合法状态，但必须是声明出来的合法状态。

## 4. 验收

| 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|
| V-A1 历史回放拦截 | 取一个已 closed、含「留真实 pi 环境」note（e2e 用例标 manual）的历史 wave plan，跑 A1 gate | fail；文案含恢复指引（改为机器验证 / 显式豁免路径） | G1 |
| V-A2 空 note 拦截（A2 后） | 构造 `sufficiencyMet.note = "留真实 pi 环境"`（无产物引用），跑 `testCasesExecuted` | fail；文案要求引用具体证据产物。另构造「引用了不存在路径」的 note：机器放行（形态合法）但 exec-review 人审驳回——机器/人审边界按 D2 生效 | G1 |
| V-A3 结构化沉淀（A3 后） | 按 e2e-verify wave 的形态新建一个真实 wave：声明 e2e 命令 + 真实执行 | closeout 后重开 store，evidence 里 e2e 结果与产物路径结构化可查；`cw status` 能显示 | G1 |
| V-A4 摩擦护栏 | 实施后连续 10 个 closed wave 统计 wall time 与用例标注分布 | wall time 中位数不高于基线 +20%（44.3 分钟为基线）；e2e/integration 型用例标注占比不下降（重标注监控） | G1（反作用力） |
| V-A5 回归 | 引擎全量测试 `npx vitest run` | 全绿。gate 只在 design-review action 时执行，存量 closed unit 不受追溯影响；既有测试夹具若构造了 manual e2e 用例需同步更新；新增回归用例锁定：「无 e2e/integration 用例的 plan 通过」（合法豁免态）、「e2e 用例标 manual 的 plan fail」 | 全部 |

## 5. 下一层拆分

| 单元 | 改动文件（cw 引擎仓库） | justification |
|---|---|---|
| A1 gate 纯函数 + 聚合注册 + 单测 | `src/rules/gates/design-review.ts`（新 gate + `runWaveDesignReviewGates` 聚合）+ `tests/`。**不触 plan.ts**（判定式只用既有字段：testCases[].type/verification + testCommand 形态） | 独立可验收（V-A1），半天，证伪条件前置 |
| A1 模板文案 | `src/guidance/templates/wave.ts`（design 模板 constraint 增验收声明说明） | gate 拦截必须伴随 guidance 教会 agent 怎么填，否则只是摩擦 |
| A2 manual note 收紧 | `src/rules/gates/test.ts:244-253`（manual 分支）+ 单测 | 小时级，独立收益（空话 note 即时消失） |
| A3 schema + 通道 | `src/core/plan.ts`（acceptance 字段）+ `src/cli.ts`（testRunner e2e 分支）+ `src/utils/`（e2e 证据结构）+ store 兼容测试 | 依赖 A1 结论；触达面最大故最后做 |
| A3 模板与 gate 联动 | design-review gate 消费 acceptance 字段（替换 A1 的简化判定） | A1 的简化版核心 case 判定升级为 schema 驱动 |

**待验证检查点**：A1 三个观察指标的实际值（决定 A2-A4 深度）；e2e 命令的执行超时策略（testRunner 现有 120s 超时对真实 E2E 可能不够，实施期定分层超时）；重标注绕过的实际发生率（A3 是否需要提前）。

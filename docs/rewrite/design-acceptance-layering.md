# cw 验收分层与成本治理机制设计

> **一句话结论**：CPU 爆满的根因不是「并行跑测试」，而是「同一条全量回归验收在叶子 fix 循环、红阶段、集成三个执行点被串行地重复全价执行，且成本维度不在任何一道防线里」。治理方案 = 给验收模型加 `layer` 层级轴（topic 层条目只能长在有集成执行点的节点上，由集成唯一执行）+ spec gate 加结构规则⑩与成本启发式⑪ + reviewer 清单加第六维 + verify 子进程 nice 减震。执行器（runAcceptances / integrate / fold）零改动。

## §0 层声明

- **当前层 → 下一层**：技术方案层（cw 验收执行模型的机制改造）→ 实现层（具体代码任务 + 测试用例）。不跨层设计实现细节。
- **下一层产物性质**：具体测试用例 + 代码任务 → 层敏感准则 5/6/7（运行时断言探针 / 物理数据流 / 错误恢复指引）全适用。
- **受众假设**：会用 cw（`cw create` / `evidence submit` / `verify` / `run`）但不懂内部实现背景的开发者。关键概念首次出现处补定义 + 例子。

## §1 背景与目标

**SCQA**：

- **S（情境）**：cw 是「agent 工作的 CI」——把编码任务分解为 unit 树（深度上限 2：root + 叶子），用机器证据而非 agent 声明判定完成。核心信任机制：叶子 unit 的验收在干净 checkout 里重跑（`cw verify`），内部节点的验收 = 集成（merge 子树后重跑「全部子节点验收 ∪ root 自身验收」）。
- **C（冲突）**：实测案例（xyz-agent 仓 scoped-model topic，2026-08-22）中，叶子 unit 的 spec 里被放进了一条全量回归验收（全仓 lint + 5 个包的 vitest 全量）。该条目因 3 个与本功能无关的既有测试挂掉而反复 fail，unit 经历 5 轮 build 证据 + 6 次 verify，**每轮都在干净 checkout 里全价重跑全量回归**，红阶段再翻倍，CPU 长时间打满。账本与产物在 `~/.cw/__Users__zhushanwen__Code__xyz-agent-workspace__feat-provider-coding-plan-auth-8e2d2d6c/`。
- **Q（问题）**：如何让「全量回归只在集成层执行」成为**机制**（结构保证 + 机器防线），而不是依赖 agent 写 spec 时的自觉？同时给验收执行补上成本维度防线与资源减震？
- **A（答案）**：验收条目引入 `layer: "unit" | "topic"` 层级轴；topic 层条目的唯一执行点是所属节点的集成（结构性保证，靠 gate 规则⑩强制声明位置，而非执行器分支）；成本启发式进 gate（warning 级）；「验收成本与层级归属」进 reviewer 对抗清单与 designer 任务书；verify 子进程 nice 降优先级。

**系统是什么**（补基本认知）：cw 的状态不存储、只计算——唯一真相源是 append-only 事件账本，`status = fold(events)` 纯函数投影。验收的完整生命周期：designer 写 spec（含验收列表）→ spec gate 机器前置规则 → 独立 reviewer 审 spec → developer 实现 → `cw verify` 干净重跑验收 → exec-review → closed。root 等内部节点不走 `cw verify`，走集成（merge 子分支进 root 分支后重跑验收 + 契约比对）。

**设计目标**（从使用者体验倒推）：

- **G1**：叶子 unit 的 fix 循环成本与其改动面成正比——全量回归不再出现在叶子 verify 的执行路径上（既不被直接声明执行，也不被红阶段重跑）。
- **G2**：同一条回归型验收**不被重复全价执行**——无真空（声明了却永远不被执行）、无结构性双跑（叶子 verify 与集成各跑一遍）。注：叶子的功能验收本就有 verify + 红阶段 + 集成三个执行点，那是既有设计且各有语义职责（区分力检查 / 干净重跑 / 集成回归），不在本条治理范围；本条针对的是「同一条全量回归」的重复全价。
- **G3**：成本维度进入机制防线——gate 有成本启发式检查，reviewer 清单有「验收成本与层级归属」维度，designer 任务书有防下放指引；不再只靠 agent 自觉。
- **G4**：验收执行对本机负载有减震——单条验收从「瞬间打满全部核」降为「后台高占用」，不抢占交互负载。
- **G5**：旧账本重放兼容（spec 无 `layer` 字段 = 行为逐字节不变），既有测试套件（61 文件 450 用例）全绿。

**Out of scope**：① xyz-agent 触发案例侧的止损（修挂测试、移除叶子 E7、`--no-red-phase`）——那是该 topic 的事，与本机制改造是两件事；② 多 topic 并行时的全局资源调度信号量（未来工作，见 §5 待验证）；③ 条目级 pass 缓存（fix 循环里 commit 每轮变化，缓存键不命中，收益不足，且「缓存命中 = 没真跑」会削弱干净重跑的信任根基）；④ vitest 内部并行模型改造（第三方包，不归我们管）。

## §2 现状与问题分析

### 2.1 纠偏：不是「并行跑」，是「同一回归在多个执行点串行全价重跑」

用户感知是「cw 执行 test 时并行跑全量 test 导致 CPU 爆满」。源码核实的执行模型（以下每条附锚点）：

- **cw 层面验收是串行的**。`runAcceptances`（`src/verify/run.ts:150`）是 for 循环逐条同步执行；集成侧（`src/runner/integrate.ts` 步骤 3）逐 unit 批次串行复用同一函数。cw 没有任何并行执行验收的代码路径。
- **CPU 爆满来自三个乘数**：
  - **(a) 单条命令内部并行**：vitest 默认 worker 池 = CPU 核数（vitest 官方默认行为，外部事实）。一条 `vitest run` 全量命令瞬间占满所有核。
  - **(b) 重复频次**：同一条全量回归在 ① 叶子 verify 每轮 fix 全价重跑（`runRegularVerify` 把 spec 验收全集传给 `runAcceptances`，manual 由其内部跳过，`src/handlers/verify.ts:164`）② 红阶段在父树上再跑同一列表（`executeRedPhase`，rv-4 起默认开，`src/handlers/verify.ts:348`）③ 集成 M2 保守口径「全部子节点验收 ∪ root 自身验收」再跑一遍（`src/runner/integrate.ts` 头注释步骤 3）。触发案例中 = 每轮 fix 付 2 次全价（verify + 红阶段），集成再付第 3 次。
  - **(c) 单条超时预算**：`timeoutForAcceptance`（`src/verify/run.ts:74`）e2e 型单条 30 分钟——全量回归声明为 e2e 型时，单条预算即半小时打满。

**结论：治理对象是「执行点冗余 + 成本无防线 + 资源无配额」，不是并发调度**。给 cw 加锁限流是治错方向（cw 本来就串行）。

### 2.2 命令写入链：回归如何被「下放」进叶子 spec

当前的写入链是 agent 链逐层自由裁量固化，无机器防线（物理数据流：从任务下达到命令执行）：

```
root designer 写 root spec（含全量回归条目 R1：lint + 全量 vitest）
  → root designer 生成子 brief（把「跑全量回归」复制进叶子目标——直接诱因）
    → 叶子 designer 写 spec（声明验收 E7，command 指向 wrapper 脚本）
      → developer 写 wrapper 内容（实际跑哪些 vitest 由其自由裁量）
        → 叶子 verify：runAcceptances 执行 spec 全部非 manual 条目 × 红阶段 ×2 × 每轮 fix
          → 集成：全部子验收 ∪ root 验收 → E7 与 R1 同类回归再跑一遍
```

关键事实：`AcceptanceItem`（`src/events/types.ts:24`）只有 `id / core / title / type / command / scenario / mockFidelityNote / runner / nondeterministic`——**没有「这条验收归哪个执行层」的维度**，所以执行范围只能是 spec 全集。

### 2.3 防线现状：全部正确性导向，零成本维度

- **spec gate 九规则**（`src/gates/spec-rules.ts`）：非空 / core 型 / command PATH 可解析 / mock 保真 / unit 级存在 / split 不自引用 / id 字符集 / runner 合法 / flag 契约——全部围绕「能不能正确执行与判定」，无一条问「这条验收该不该在这个层级跑」。
- **reviewer 五维度对抗清单**（`src/runner/brief.ts` 的 `specReviewReviewerTasks`）：命令契约 / 覆盖度 / 区分力 / 契约一致性 / 干净 checkout 可执行性——同样无成本维度。实证：触发案例中 reviewer 审查时反而**强化**了回归命令（要求补 `pnpm install --silent` 以通过「干净 checkout 可执行性」维度）。
- **designer 任务书**（`brief.ts` 的 `designerFirstTasks`）只转述五规则，无「回归归属 root / 集成层」指引。

### 2.4 根因清单（架构性问题）

| # | 根因 | 证据锚点 |
|---|------|---------|
| R1 | **验收模型缺层级轴**：无字段表达「本条归 topic/集成层执行」，执行范围 = spec 全集 | `src/events/types.ts:24` AcceptanceItem |
| R2 | **执行点冗余无去重**：叶子 verify（含红阶段 ×2）与集成 M2 保守口径对同类回归重复全价执行；root 验收天然会在集成跑，叶子再声明 = 结构性双跑 | `src/handlers/verify.ts:164,348`；`src/runner/integrate.ts` 步骤 3 |
| R3 | **成本维度不在任何防线**：gate / reviewer / 任务书全是正确性导向 | `src/gates/spec-rules.ts`；`src/runner/brief.ts:89` |
| R4 | **防下放靠 agent 文案自觉**：写入链逐层自由裁量，root designer 把回归复制进子 brief 无任何机制拦截 | §2.2 链路 |
| R5 | **资源无配额**：验收子进程继承全部环境，无 nice / worker 上限；e2e 单条超时 30min | `src/verify/run.ts` execBashTree、`:63` |

## §3 解决方案

### 3.1 终态（使用者视角）

**成功路径**——root designer 写 root spec 时，把全量回归条目标记为 topic 层：

```json
{
  "id": "R1",
  "core": true,
  "title": "全仓回归：lint + 全部包 vitest",
  "type": "e2e-real",
  "command": "bash scripts/topic-regression.sh",
  "layer": "topic"
}
```

其中 `scripts/topic-regression.sh` 是 wrapper 脚本（内部跑 `pnpm run lint && pnpm vitest run`），脚本尾部按成败输出标记行 `R1 PASS` / `R1 FAIL` 且 exit code 与标记一致。这个形态不是可选风格而是**适配器契约的硬要求**——`e2e-real` 无 `runner` 声明时缺省路由 e2e-sh 适配器，其 parse 要求 stdout 出现标记行 `^<id> (PASS|FAIL)$`（`src/testrun/e2e-sh.ts` 的 MARKER_RE）：无标记 + exit≠0 → no-markers fail；无标记 + exit 0 → 抛错「无区分力」。裸 `pnpm vitest run` 命令永不产标记行，恒 fail。完整形态约束见 §3.3 D1a。

- 提交过 gate（root 的 spec.split 非空 → 规则⑩ 满足）；reviewer 按六维清单审过；该条目**不在任何叶子 verify 里出现**，只在集成时执行一次。
- 叶子 developer 的 fix 循环里，`cw verify` 只跑叶子的功能验收——耗时与改动面成正比（G1）。
- 全部叶子 verified 后集成：root 分支 merge 汇聚 → 干净 checkout → 子验收 ∪ root 验收（含 R1）跑一遍（G2：唯一执行点）。

**失败路径 1（gate 拒，带恢复指引）**——叶子 designer 误把回归标成 topic：

```
$ cw evidence submit --kind spec --unit sm-e2e --file spec.json
cw evidence submit --kind spec: spec gate 未通过（unit "sm-e2e"），不入账：
  规则⑩: 验收 E7 声明了 layer: "topic"，但本 spec 的 split 为空（叶子/无子节点 unit 没有
  集成执行点，topic 层条目将永不被执行）。恢复动作：topic 层验收归有子节点的 root spec
  声明（其执行点是内部节点集成）；叶子 spec 只声明本 unit 的功能验收——若本条是全量回归，
  请上收到 root spec 并标 layer: "topic"；若确属本 unit 功能验收，去掉 layer 字段按 unit 层声明。
```

**失败路径 2（gate warning，入账继续）**——叶子 spec 声明了无文件参数的全量 vitest：

```
cw evidence submit --kind spec: spec 已入账（unit "sm-e2e"），但规则⑪ 触发成本警告：
  规则⑪: 验收 E7 的 command 是全量回归形态（vitest run 无文件参数），且本 unit 是叶子——
  叶子 verify 每轮 fix（含红阶段）都会全价重跑它。建议：若为全量回归，上收 root spec 并标
  layer: "topic"（集成层唯一执行）；若确为本 unit 范围，为 command 加文件参数收窄。
```

**失败路径 3（reviewer 打回）**——reviewer 第六维「验收成本与层级归属」发现叶子 spec 有全量回归形态的 unit 层条目 → fail + 恢复动作（上收 root spec）。该 comment 全文内嵌进 designer 的修 spec 任务书（既有机制）。

### 3.2 方案对比

| 维度 | 方案 A：声明归位（**推荐**） | 方案 B：执行器跳过（handoff P1 原文） | 方案 C：纯 guidance | 方案 D：pass 缓存 |
|------|--------------------------|--------------------------------------|--------------------|------------------|
| 机制 | `layer` 字段 + gate⑩「topic 要求 split 非空」+ gate⑪ 成本启发式 warning + reviewer 第六维 + nice；**执行器/fold/集成零改动** | `layer` 字段 + runAcceptances 跳过 topic 条目 + 集成批次过滤（子的 topic 跳过、root 的照跑）+ verify 侧 acceptanceIds 补偿 | 只改 brief/reviewer 文案，不动模型 | 键 specHash+commit+command 缓存条目结果 |
| 长期架构合理性 | **高**：层级语义进模型；「topic 条目只能长在有集成执行点的节点上」= 执行点唯一性是**结构结果**而非运行时分支；与既有「叶子不得声明 split」的 handler 级防线同型 | 中：叶子可持有「永不执行的声明」（文档性条目），语义别扭；子的 topic 条目若无 root 对应 = **静默真空**（只能靠 reviewer 兜） | 低：无机器防线——触发案例就是文案自觉失效的实证（root designer 下放、reviewer 反而强化） | 低：缓存命中 = 没真跑，动摇「干净重跑」信任根基 |
| 短期实现成本 | 中：types/schema/gate/brief/run.ts(nice) + 测试 + 文档同步；**不动** verify/integrate/fold | 高：除 A 的全部外，还要动 runAcceptances（加跳过分支与参数）、verify.ts（acceptanceIds 补偿，否则 fold verified 公式死锁，`src/core/fold.ts:163` 要求 spec 全部 id 被 pass run 覆盖）、integrate.ts（批次过滤）、status/report 显示口径 | 低 | 中高（缓存键、失效、审计） |
| B 的独有优点（诚实列出） | A 的对应补偿：追溯归属（「该回归因叶子 X 而存在」）在 title/scenario 文本里表达，写进 D6 的 designer 指引约定 | 叶子持有 topic 声明可保留「该回归因叶子 X 而存在」的追溯归属 | — | — |
| 风险 | 规则⑪ 是启发式 warning（非硬拦），残留依赖 reviewer 语义审——与仓既有哲学一致（规则⑨ 同款「诚实边界」）；缓解 = 第六维明确 must-fix | fold 死锁风险（跳过条目不进 acceptanceIds → unit 永卡 spec-frozen）必须补偿；补偿又引入「没跑却显示 ✓」的显示误导 | 下次照样发生 | fix 循环 commit 每轮变、不命中，收益不足 |
| 若用它，§2 案例会怎样 | 叶子 spec 写不进 topic 条目（gate⑩ 拒）；unit 层全量形态被 ⑪ warning + reviewer 第六维打回；回归归 root spec topic 层，只在集成跑一次 | 叶子 spec 标了 topic 后不执行、照常 verified；但若 root spec 没有对应条目，该回归**永远不执行且无报警** | 案例原样复现（它就是在纯文案自觉下发生的） | 挂掉的既有测试让结果 fail，缓存帮不上 fail 场景 |

**推荐方案 A**。核心理由：B 的「叶子持有 topic 声明」模式制造了声明与执行的脱节（真空风险 + fold 补偿 + 显示误导三处连带手术），而 A 用一条提交期结构规则（⑩）把「topic 条目必在有集成执行点的节点上」变成不变量，执行路径上一行分支都不用加——**减法优先**（能靠声明位置解决的，不加运行时机制）。

### 3.3 关键决策与权衡

**D1：`AcceptanceItem` 新增可选字段 `layer?: "unit" | "topic"`，缺省 `"unit"`。**

- 选择：可选字段、缺省 unit。旧 spec / 旧账本无此字段 = 行为逐字节不变（重放兼容先例：`VerifyRanPayload.parseFailedAcceptanceIds` 的「旧账本缺字段 = 无」注释）。
- 被否：必填字段——破坏全部存量 spec 与账本重放。
- 证据：G5；`src/events/types.ts:24`。
- 语义定义（写进字段注释，是后续所有决策的锚）：`layer` 声明**执行层归属**。`"unit"`（缺省）= 本 unit 的 verify 路径执行；`"topic"` = 归集成层，唯一执行点 = 所属节点的集成验证。**该字段不改变任何执行器行为**（见 D2）——它的效力来自 gate 规则⑩ 的声明位置约束 + 集成装配的既有行为。

- 已知边界：带 `layer` 的 spec 若被**旧版 CLI** 提交入账，typebox schema 只校验不剥离额外字段（`src/handlers/spec-schema.ts`），`layer` 会原样入账而旧 gate 无规则⑩——防线静默失效。现实风险低（本地全局单版本 CLI），记档不处理。

**D1a：topic 层条目的合法适配器形态（实施地基知识）。**

「回归上收为 root topic 条目」必须同时回答「这种条目在适配器契约下长什么样」，否则照文档构造的 fixture 恒红。合法形态有两种，判定语义不同：

- **形态一（推荐，与触发案例 E7 同构）**：`type: "e2e-real"` 或 `"e2e-mock"`、不声明 `runner` → 路由 e2e-sh 适配器 → command 指向 wrapper 脚本，脚本尾按成败输出标记行 `R1 PASS` / `R1 FAIL` 且 exit code 一致。判定语义 = **严格「全绿才 PASS」**：脚本内任何一步挂（lint 红 / 任一 vitest 包挂 / 无关既有测试挂）都应让脚本不输出 PASS 标记——这正是「回归」想要的语义。
- **形态二（不推荐用于回归）**：显式 `runner: "vitest"` + 仓内存在用例名以词边界含验收 id 的套件（如 `describe('R1 ...')`）。判定语义宽松：nameMatch 只判定 id 命中的用例且全部 pass（`src/verify/name-match.ts:48`），**未命中的无关挂测试不进判定**——回归语义被架空，只在「刻意追踪特定套件」时合理。

该形态知识的使用点：designer 任务书（D6 指引引用）、reviewer 第六维核对项（契约维度本就查标记行产出路径）、§4 S1/S6 的 fixture 构造依据、规则⑩ 错误文案的恢复指引可指向本决策。

**D2：执行器零分支——runAcceptances / integrate / fold 一律不改。**

- 选择：不实现 handoff P1 原文的「runAcceptances 跳过 topic 条目」。理由：
  1. 规则⑩（D4）保证 topic 条目只能出现在 split 非空的 spec（当前深度上限 2 下即 root）；而内部节点在 runner 流程里**不走** `runRegularVerify`（frontier 对 spec-frozen 内部节点只派 missingChildren / integrationReady / integrationDrift，`src/readonly/frontier.ts:704-713`），只走集成——集成批次本就包含 root 全部验收（`integrate.ts` 的 PendingBatch 装配）。**执行点唯一性已成立，执行器加分支是死代码**。
  2. 唯一会让 runAcceptances 见到 topic 条目的路径是**手动** `cw verify --unit <内部节点>`（调试工具）。此时全价执行（含 topic 条目）= 现状行为，零语义变化、零弱化——若加跳过分支，反而要让手动 verify 能在「不跑回归」的情况下把 unit 推过 verified（acceptanceIds 补偿），制造「没跑却算过」的语义弱化。诚实边界：该手动旁路下 root 可不经集成直接 verified（fold 不区分 verify-/integrate- 前缀的 pass run），且手动 verify 与后续集成会各跑一遍 topic 条目——这是**既有语义**，非本方案引入，本方案不扩大也不收窄它。
  3. fold 的 verified 公式（`src/core/fold.ts:163`：spec 全部验收 id 须被某个 pass run 的 acceptanceIds 覆盖）因此完全不受影响——没有任何条目在任何路径被跳过。
- 被否：执行器跳过分支（方案 B）——三重连带手术（fold 补偿 / 集成过滤 / 显示误导）换一个执行器路径上永不触发的分支。
- 证据：frontier 分组逻辑（`src/readonly/frontier.ts:695-714`）；集成 PendingBatch 装配（`src/runner/integrate.ts`）；fold 覆盖公式（`src/core/fold.ts:163`）。
- 运行时探针：✅ 已核实（本轮读源码确认：内部节点无 buildReady 路径、集成批次含 root 验收、fold 公式形态）。

**D3：红阶段无需处理——结构性不涉及。**

- 红阶段（`executeRedPhase`）重跑的是**本 unit spec** 的验收列表。规则⑩ 下叶子 spec 不含 topic 条目，红阶段自然不会重跑回归。无需改动、无需特殊口径。
- 探针：✅ 已核实红阶段调用点传的是同一 `lastSpec.acceptance`（`src/handlers/verify.ts:348`）。

**D4：gate 规则⑩（fail 级，结构规则，纯函数）：`layer === "topic"` 的条目要求 `spec.split` 非空。**

- 选择：fail 级拒入账。判据只用 spec payload 自身的 `split` 字段——`checkSpecRules` 保持纯函数（无需像 handoff 设想的「handler 层传 parentId」）。
- 语义闭环：split 非空 ⟺ 有子节点 ⟺ 有集成执行点 ⟺ topic 条目会被执行。split 为空（叶子 / 无子 root）声明 topic = 该条目永无执行点（真空）→ 提交期拒绝，附恢复动作（§3.1 失败路径 1）。
- 与既有防线的咬合：handler 级已有两道防线——fx-1 R1「叶子不得声明 split」（`src/handlers/evidence-submit.ts:154`，用 parentId 判定）与 **fx-3 R5.1「split 声明的子必须已入账且 parent 指向本 unit」**（`src/handlers/evidence-submit.ts:164-197`）。后者关闭了「先有 split 声明后有子」的时序窗口：**spec 入账时点上 split 非空即蕴含子已创建**，即规则⑩的判据在入账时点就保证集成执行点的对象存在。⑩ 在 gate 层从另一侧收口：叶子 split 必为空（fx-1 R1 拦）→ 叶子声明 topic 必被 ⑩ 拦。防线正交，无绕过面。
- 被否：warning 级——真空是语义错误不是成本建议，容忍入账 = 允许「声明了却永不执行」进账本。
- 已知边界一：单 unit topic（root 无子、split 空）不能声明 topic 层——它本就没有集成执行点可 deferred，全部验收按 unit 层跑（接受：单 unit topic 本身意味着小范围）。写进规则⑩ 的错误文案，不静默。
- 已知边界二：topic 条目**不豁免规则⑤**——root spec 上收回归后仍须至少一条 `type: "unit"` 的用例（`src/gates/spec-rules.ts:116`），全部验收都是 e2e 级 topic 条目的 root spec 会被规则⑤拒。写进 D6 的 designer 指引，避免 designer 踩连环拒。

**D5：gate 规则⑪（warning 级，成本启发式）：unit 层条目 command 命中全量回归形态 → warning。**

- 形态枚举（单一事实源，可扩展）：① `vitest run`（含 `npx/pnpm vitest run`）后无位置参数（文件/目录）；② 全仓 lint / test script 调用（`pnpm run lint` / `npm run lint` / `pnpm test` 等且无路径参数）。判定为纯字符串/词法分析，不执行命令。**诚实漏报面**：command 指向 wrapper 脚本（触发案例 E7 的实际形态——`bash xxx.sh` 内部跑什么词法不可见）与脚本别名封装一律不命中——⑪ 的现实价值限于裸命令提示，wrapper/别名形态由 reviewer 第六维语义审兜住（D6 文案点名）。
- warning 级而非 fail 级的理由：静态形态判定有误杀面（小仓的全量单测可能就是叶子的合理范围），硬拒会逼出规避动作（把命令包进 wrapper 脚本绕开启发式）——仓既有哲学同款：规则⑨ 对 e2e/manual 型「无静态规则，漏网走回炉通道」的诚实边界。硬防线放在 reviewer 第六维（语义审 + must-fix 打回）。
- 需要 `SpecRulesResult`（`src/events/types.ts:202`）扩 `warnings?: string[]`（缺省空 = 旧行为）；`evidence-submit` 在 gate 通过后把 warnings 打印到 stderr，入账继续。
- 消息分两种形态：split 空 → 「上收 root spec 并标 topic」；split 非空（内部节点的 unit 层回归，执行点与 topic 相同但成本归属不可审计）→ 「建议显式标 layer: "topic"」。
- 被否：fail 级 + `allowFullScope` 辩解字段（仿 mockFidelityNote）——多一个字段多一份 spec 作者负担，收益不抵（准则：减法优先）；reviewer 第六维已是语义出口。

**D6：reviewer 清单五维 → 六维 + designer 任务书防下放指引。**

- `specReviewReviewerTasks` 新增第六维：「验收成本与层级归属：全量回归形态是否出现在叶子 spec 的 unit 层——含裸命令（无文件参数的全量 vitest / 全仓 lint）与**封装形态**（command 指向 wrapper 脚本或 script 别名的，须追进脚本/别名内容看实际跑什么）——集成 M2 口径必然重跑 root 验收，叶子重复声明 = 每轮 fix 全价双付。此类条目 must-fix：上收 root spec 并标 `layer: "topic"`」。pass 时须逐项显式「核过无问题」（既有约定，对新维度同样生效）。
- `designerFirstTasks` 加指引：「root 级回归型验收（全仓 lint / 全量 vitest）归 root spec 声明并标 `layer: "topic"`，由集成阶段统一执行；子 unit spec 只声明本 unit 的功能验收，不得复制回归条目」。
- 注意 print / spawn 双形态任务书共用渲染层，两种模式都要读通（既有约束）。
- 被否：只改 reviewer 不改 designer——写入链的起点是 designer（§2.2），下游防线拦不住上游源头。

**D7：verify 子进程 nice 减震（P4，独立先行）。**

- 落点：`src/verify/run.ts` 的 `execBashTree`——spawn 包 `nice -n 10 bash -c ...`（POSIX；与 `bashResolvable` 同型做 `nice` 预检，不可解析时降级为裸 spawn，Windows 自然落此分支）。
- 零语义变化：nice 只影响调度优先级，不影响执行结果、产物、超时语义。
- 运行时探针：✅ 已测（macOS：`which nice` → `/usr/bin/nice`，`nice -n 10 true` 正常执行）。
- vitest worker 上限 env 注入：⛔ **实施期门**——vitest 是否有官方 env 变量控制 worker 上限未核实（本仓 node_modules 当前不可查）。实施时查证：若存在官方 env（且语义为上限而非精确值），注入缺省上限（如核数一半）且不覆盖用户已设值；若不存在，不做（命令是 spec 作者的，cw 不能改命令——规则⑨ 契约下注入 CLI flag 不可行），仅在 reviewer 第六维文案中建议 wrapper 自限。
- 被否：cgroup / cpuset——macOS 无此物，跨平台成本过高；条目级缓存——§3.2 方案 D 已否。

**D8：验收文档口径同步（仓纪律）。**

- `src/gates/spec-rules.ts` 头注释声明「验收文档锁定」——加规则⑩⑪ 须同步 `docs/rewrite/acceptance/u3-acceptance.md` 的规则口径（对照 fx-1 / rv-2 / mx-2 / mx5-1 各自追加规则⑥-⑨的先例）。
- `CONTEXT.md` 概念词典加 `layer` 词条；`AGENTS.md` 核心约定的「spec gate 九规则」表述更新。
- 新增 unit 的验收基线先行入 git（仓 orchestration 纪律）。
- 仓外同步记档（不在本方案实施范围）：用户侧 skill（cw-cli / pi-cw）的 spec 指引未覆盖 `layer` 字段，上线后需另行同步。

### 3.4 错误规格（每个错误配恢复指引）

| 错误 | 触发 | 恢复指引 |
|------|------|---------|
| 规则⑩ 拒入账 | topic 条目 + split 空 | 错误文案内含：上收 root spec 或去 layer 按 unit 层声明（§3.1 失败路径 1 全文） |
| 规则⑪ warning | unit 层回归形态命令 | warning 文案内含：上收 root 标 topic / 加文件参数收窄（§3.1 失败路径 2 全文） |
| 集成期 topic 条目 fail | 回归在集成红 | 走既有 integrationDrift 通道（`integrate.ts` 的 recovery guidance 二选一），语义归属 root designer——零新增 |
| nice 不可解析 | 非 POSIX 环境 | 降级裸 spawn，不报错（零语义变化，不写 warning 避免噪音） |
| 旧账本重放 | spec 无 layer 字段 | 缺省 = unit，行为逐字节不变（D1） |

## §4 验收（真实场景验证）

验收不用单测/mock——单测只验代码符合设计假设。以下场景在**真实 cw CLI + 真实 git 仓（fixture）+ 真实子进程**下验证（仓测试规范的 e2e 形态：子进程跑真实 `cw` 命令走完整 dispatch）。fixture 仓形态：多包结构（模拟 xyz-agent：2+ 个包各有 vitest 套件 + 一个 lint script），可构造「与本功能无关的既有挂测试」。

**S1：topic 层条目只在集成执行一次（回溯 G1、G2）**
- 场景：fixture 仓上建真实 topic：root spec 含一条 `layer: "topic"` 的全量回归条目 R1（按 D1a 形态一构造：command 指向 wrapper 脚本 `scripts/topic-regression.sh`，内部跑 lint + 全量 vitest，尾部输出 `R1 PASS`/`R1 FAIL` 标记行）+ 两个叶子各有功能验收。`cw run --spawn human`（或手动链）推进到集成。
- 步骤：叶子 fix 循环中执行 `cw verify --unit <叶1>`；集成完成后查产物。
- 通过标准：① 叶子的 verify 产物目录（`evidence/<叶1>/verify-*/`）中无任何回归执行痕迹（叶子的 spec 里根本没有该条目——这是结构结果）；② 叶子 verify 耗时 ≈ 功能验收耗时（与改造前同形态对比，回归不再计入）；③ 集成产物（`evidence/<root>/integrate-*/`）的 root 批次含 R1 的真实执行结果（pass/fail 有产物）；④ 全账本中 R1 的执行记录仅出现在 integrate-* run 中。

**S2：旧账本重放兼容（回溯 G5）**
- 场景：取无 `layer` 字段的既有 spec（本仓重写期真实账本副本或 fixture 旧 spec）。
- 步骤：改造后代码对旧账本跑 `cw status` / `cw tree` / `cw report`；跑既有测试套件。
- 通过标准：① 三条只读命令输出与改造前逐字节一致；② `npm test` 全绿（61 文件 450 用例为基线，新增用例另计）。

**S3：gate 双规则行为（回溯 G3）**
- 场景：fixture 仓真实提交三种 spec。
- 步骤与通过标准：① 叶子 spec（split 空）含 topic 条目 → `cw evidence submit --kind spec` exit 1、不入账、stderr 文案含恢复动作（逐字核对 §3.1 失败路径 1 的关键要素：指明哪个条目、为什么、两个恢复方向）；② 叶子 spec 含无文件参数 `vitest run` 的 unit 层条目 → 入账成功（exit 0）+ stderr 打印规则⑪ warning；③ root spec（split 非空）含 topic 条目 → 无 ⑩ 报错正常入账。

**S4：reviewer 第六维真实生效（回溯 G3）**
- 场景：构造 S3② 的 spec（叶子 unit 层全量回归形态），进入 spec-review。
- 步骤与通过标准：① 机器可断言部分（进自动化测试）：生成的 reviewer 任务书文本含第六维「验收成本与层级归属」全文（结构化断言，走既有 brief 渲染测试形态）；② 语义部分定为 **manual 型验收**：spawn 真实 reviewer subagent（pi 环境）审该 spec，人工核验其 verdict comment 命中第六维（指出成本/层级问题并给上收指引）。不用 LLM 输出做自动化断言（概率性输出进 e2e 会 flaky，与仓「机器证据判定完成」哲学相抵）。

**S5：nice 减震生效（回溯 G4）**
- 场景：fixture 仓跑一条真实 unit 级验收。
- 步骤：verify 执行期间 `ps -o ni -p <子进程pid>` 观察验收子进程。
- 通过标准：子进程 nice 值 = 10；verify 结果与产物与无 nice 时一致（零语义变化的实证）。

**S6：触发案例形态对照（回溯 G1，端到端）**
- 场景：复刻 xyz-agent 案例形态——fixture 仓内置 1 个与本功能无关的既有挂测试，root spec 按 D1a 形态一声明 topic 层全量回归，叶子正常开发。
- 通过标准：叶子 fix 循环的每轮 verify 不含全量回归（耗时与 S1② 同量级）；既有挂测试导致的回归红**只在集成阶段出现一次**，且失败处置走 integrationDrift 通道转 root designer（而非叶子 5 轮 build 全价重付——对照组数据：触发案例账本 `~/.cw/__Users__zhushanwen__Code__xyz-agent-workspace__feat-provider-coding-plan-auth-8e2d2d6c/` 的 verify 时间线可作基线引用）。

## §5 下一层拆分

实施走仓内 orchestration 纪律（验收基线先行入 git → developer 实现 → verifier 独立验收）。拆分如下（每项附 justification）：

| 波次 | 内容 | 文件改动地图 | justification |
|------|------|-------------|---------------|
| w1（独立，可先行合入） | D7 nice 减震 | `src/verify/run.ts`（execBashTree spawn 包 nice + 预检降级）；新增 tests | 零语义变化、单点、不依赖 layer 模型——先行合入立刻缓解「爆满」体感 |
| w2（模型层） | D1 `layer` 字段 | `src/events/types.ts`（AcceptanceItem + 注释）、`src/handlers/spec-schema.ts`（AcceptanceItemSchema 加 optional layer）、`CONTEXT.md` 词条；重放兼容测试 | 纯声明、零行为变化——schema 先行，后续波次依赖类型；单独成波让「模型变更」与「行为变更」评审解耦 |
| w3（防线层，依赖 w2） | D4 规则⑩ + D5 规则⑪ + D6 reviewer 第六维与 designer 指引 + D8 文档同步 | `src/gates/spec-rules.ts`（⑩ fail 级 + ⑪ warning + 形态枚举单一事实源）、`src/events/types.ts`（SpecRulesResult.warnings）、`src/handlers/evidence-submit.ts`（warnings 打印）、`src/runner/brief.ts`（第六维 + designerFirstTasks 指引，print/spawn 双形态读通；顺手对齐既有 drift：任务书文案仍写「验收五规则」而 gate 已是九规则）、`docs/rewrite/acceptance/u3-acceptance.md`（规则口径）、`AGENTS.md`（九规则表述）；S3 用例 | 三道防线同属「写入链治理」一个语义单元，一起过 reviewer 才能闭环；brief.ts 两处改动同文件同波次避免重复冲突 |
| w4（端到端验收，依赖 w2+w3） | S1 / S4 / S6 真实场景验收 | tests e2e（真实 CLI 子进程 + fixture 仓）；verifier 独立验收报告 | e2e 验收需要模型与防线都在位；与 w1/w2/w3 的验证型测试分层（测试设计按 test-quality 方法论另出） |

**待验证检查点**（设计期无法确定，诚实标注）：

1. ⛔ vitest 官方 worker 上限 env 是否存在（D7）——w1 实施时查证，存在才注入，不存在则只做 nice。
2. ⛔ nice 在 Linux（CI 环境）的同等可用性——POSIX 同源低风险，w1 落地时在 CI 实测确认。
3. 规则⑪ 的形态枚举校准——w3 上线后按真实 topic 观察双向命中率：误伤面（小仓合理全量单测被 warning）与**漏报面**（wrapper 脚本 / script 别名封装形态不命中，观察 reviewer 第六维的实际拦截率是否能兜住），双向校准枚举与文案。
4. 多 topic 并行时的全局资源占用（out of scope 项②）——nice 是逐进程减震，多个 `cw run` 并发时是否仍需全局信号量，待真实并行案例出现后评估。

**本设计明确不改的清单**（防范围蔓延）：`src/verify/run.ts` 的 runAcceptances 执行范围逻辑、`src/runner/integrate.ts` 的批次装配、`src/core/fold.ts` 的 verified 公式、`src/readonly/frontier.ts` 的分组逻辑——执行点唯一性由声明位置约束结构性保证（D2），这些文件零改动是方案 A 的核心论据，实施期若发现不得不改其中任何一个 = 设计假设崩塌，回到本文档重新评审。

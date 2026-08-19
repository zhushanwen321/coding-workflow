# CONTEXT — 统一语言

> cw 2.0（重写版）的核心概念、命令面与数据布局。本文自包含：不依赖任何对话或外部文档即可读懂。
> 架构决策的完整论证见 canon：[`.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md`](./.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md)。

## 一句话定位

cw 是 **agent 工作的 CI**：把超出单个 LLM agent 上下文半径的编码任务分解为可验证单元，用机器证据（而非 agent 的声明）判定「完成」。job 是 agent 进程，pipeline 定义（分解树 + 验收）本身由 agent 在系统内产出、被机器 gate 看守。

## 核心概念

### unit（单元）

工作的唯一形态：**一种类型、自相似树**（深度上限 2：根 + 叶）。叶子与内部节点的差异只在 build/verify 的含义，不在状态机：

| | build | verify |
|---|---|---|
| 叶子节点 | agent 写代码 | 干净 checkout 重跑该节点验收 |
| 内部节点（根） | runner merge 子树 | 受影响验收重跑 + 跨节点契约比对 |

unit 的定义 = 它的**验收集合 + 契约**（验收是一等工作单元，不是 plan 的附属字段）。

### 验收（Acceptance）

一个单元「完成」的可运行定义：用例 + 执行命令 + 断言。每条用例：

- `id`：unit 内唯一（如 `A1`；字符集 = 字母数字开头，后续可含 `.` `_` `-`，与 e2e-sh marker 同源约束）
- `core`：是否核心 case（核心 case 强制 e2e 级机器验证，禁 manual）
- `type` 枚举：`unit | integration | e2e-real | e2e-mock | manual`
- `command`：可执行命令（e2e 级用例必填）
- `runner`（可选）：测试框架显式声明，合法值 = `knownAdapterTypes()`（vitest / e2e-sh / pytest / playwright，大小写敏感）；缺省按 type 推导（unit/integration→vitest、e2e 级→e2e-sh），显式声明优先
- `nondeterministic`（可选，`true`）：随机性声明——豁免名字比对必过集合与单次 fail 的整体判定，但执行照跑、产物照录（声明 ≠ 逃逸；滥用由 spec-review 语义审查把关，flake 转人工永不以声明为豁免条件）

弱验收过不了 spec gate（见「spec gate 九规则」）。

### 验收命令契约（acceptance command contract）

验收 `command` 与 testrun 适配器输出协议的相容性——命令产物必须能被路由到的适配器机器解析（vitest / playwright：stdout 整体 JSON；pytest：`-v` 条目行；e2e-sh：独立标记行 `<验收id> PASS|FAIL`）。契约违反是确定性挂：实现写得再对也恒判 fail。

spec gate 规则⑨入账前静态检查（`src/gates/spec-rules.ts` 的 `ADAPTER_FLAG_CONTRACTS`，按 `adapterTypeFor` 最终路由——runner 显式声明优先、缺省按 type 推导——分派）：

- vitest / playwright 型：`--reporter` 只放行等号形态且值恰为 `json`（`--reporter=json` 是 translate 幂等检查认定的唯一安全形态——cw 自动追加 `--reporter=json`，其他值与之并存让 stdout 混入人类可读文本、JSON 解析恒挂）；空格形态 `--reporter <值>` 一律拒（mx5-5：translate 幂等检查只认等号子串，空格形态会被 cw 再追加 reporter 致双 reporter 恒挂），另禁 `--outputFile`（任何形式——把 JSON 重定向到文件、stdout 无 JSON）
- pytest 型：禁 `-q` / `--quiet` 及其长选项前缀缩写（`--q` / `--qu` / `--qui` / `--quie`——argparse 允许缩写，严格逐字符前缀链，`--query` 类更长选项不在链内），含短选项合写簇（`-qq` / `-vq` 等，对簇 token 逐字符展开）——与适配器追加的 `-v` verbosity 相抵、条目行消失
- e2e-sh / manual 型：无静态规则（诚实边界：标记行产出无法静态证明——可能在脚本内、可能条件执行），漏网形态由 reviewer 任务书契约清单 + 回炉通道兜底

例：`npx vitest run --reporter=verbose tests/x.spec.ts` 被⑨当场拒（reporter 值非 json）；裸 `pnpm build` 过得了⑨（e2e 型无静态规则）但 verify 时永不产出 `A3 PASS` 标记行 → 解析失败 → 回炉。

### 证据（Evidence）

机器可复算的产物：commit hash、测试运行产物文件、重跑日志。`passedCount: 4` 这类声明不是证据。证据以事件入账（`EvidenceSubmitted`，含 runId 幂等键 + 产物 sha256），判定一律以系统自己干净重跑的结果为准。

### 契约（Contract）

跨单元的接口承诺（函数签名 / API / schema），随 spec 一起 hash 冻结，供依赖方对着写；集成 verify 时机器比对（签名 ≡ 冻结 hash）。闭环：designer 产出 → 随 spec 冻结入账 → 内部节点 verify 比对。

### 事件账本（event ledger）

唯一的真相源：append-only JSONL（`events.log`），五类事件：

| 事件 | 载荷要点 |
|---|---|
| `UnitCreated` | unitId、parentId（null = 根）、briefRef |
| `SpecSubmitted` | specHash（冻结锚点）、acceptance[]（含可选 runner / nondeterministic）、contracts[]、split[] |
| `VerdictSubmitted` | verdictKind（spec-review / exec-review）、verdict（pass / fail）、evidenceRefs、role（可选自报：审计载体非信任边界） |
| `EvidenceSubmitted` | runId（幂等键）、commit、paths[]、sha256[]、exitCode |
| `VerifyRan` | runId、reportHash、result（pass / fail）、acceptanceIds[]、parseFailedAcceptanceIds[]（可选，mx5-1：本次 verify 产物解析失败的验收 id；旧账本缺字段 = 无解析失败，重放兼容） |

事件一次写入不可改；写账本一律走 cw 命令、由短事务（文件锁）串行化。

### 投影（projection）

**状态不存储，只计算**：`status = fold(events)`（纯函数）。四态：

```
created       = UnitCreated 存在
spec-frozen   = spec 通过机器 gate ∧ spec-review verdict = pass
verified      = 全部冻结验收 verify 通过（内部节点追加：子树集成通过）
closed        = verified ∧ exec-review verdict = pass
```

补录（先干活后走账）在此模型下结构性不可能——没有「声明状态」的命令，只有「交证据」的命令。账本同时是跨上下文记忆：任何 agent 或人只读账本即可零上下文接手。

### spec gate 九规则

spec 提交时的确定性检查（多缺口全列、不短路，`src/gates/spec-rules.ts`）：

① 验收非空；② core 用例自身 type 必须为 e2e-real / e2e-mock；③ e2e 用例 command 非空且首 token 在 PATH 可解析；④ e2e-mock 附非空 mock 保真度说明；⑤ 至少一条 unit 级用例；⑥ split 不得自引用；⑦ 验收 id 字符集（`ACCEPTANCE_ID_RE`，与 e2e-sh marker 同源）；⑧ runner 显式声明必须在 `knownAdapterTypes()` 集合内（合法值与注册表逐字符一致，大小写敏感）；⑨ 验收命令契约——按最终适配器路由检查冲突 flag：vitest / playwright 的 `--reporter` 值若出现必须恰为 `json` 且禁 `--outputFile`；pytest 禁 `-q` / `--quiet`（含短选项合写）；e2e / manual 无静态规则（见「验收命令契约」词条）。

另有 handler 级防线串联在 spec 提交路径（不在九规则内）：children-first——split 声明的子 unit 必须已创建且 parent 匹配，缺子/错配分类清单拒收（`src/handlers/evidence-submit.ts`）。

「验收强不强」这类语义判断由独立 reviewer 审，不在机器规则职责内。

### 三道验证 gate

verify（干净重跑）的判定链，共同原则是**伪造成本 ≥ 干活成本**：

1. **红阶段**（默认执行，`--no-red-phase` 逃生口）：新测试打到旧代码树必须挂（不挂 = 测试无区分力，拒绝）。build commit 回退第一父（实现前基线树），验收 command 引用的变更文件先 patch 进父树再跑；无父 commit 合法跳过；`nondeterministic` 声明条目跳过判定
2. **名字级比对**：验收逐条按名字在重跑产物里 PASS，不是「N passed ≥ 用例数」的计数启发式（`nondeterministic` 声明条目跳过，结果标注 nameSkipped）
3. **干净重跑**：干净 checkout 到隔离临时工作区（commit hash 取自账本）+ 独立 CW_HOME，系统自己 spawnSync 复跑

### 解析失败 vs 断言失败（parse failure vs assertion failure）

verify 重跑产物的失败二分类（mx5-1/mx5-2）：

- **解析失败** = `AcceptanceRunResult.parseError === true`（无法产出可判定产物）。来源**非穷举**——完整集合以四适配器 parse/translate 实现（`src/testrun/`）与 `src/verify/run.ts` 的路由为准，代表形态：适配器 parse 抛错（vitest / playwright stdout 非法 JSON 或 JSON 合法但形状不符；e2e-sh 无标记行且 exit 0、或标记 id 与验收 id 不符）、零条目且 exit 0 防线（playwright / pytest 判无区分力抛错）、translate 抛错（如 runner 显式声明 e2e-sh 的条目 command 缺省）、路由不到适配器的旁路（非法 runner 绕过 gate）。入账字段 = VerifyRan 的 `parseFailedAcceptanceIds`。不含 e2e-sh「无标记行且 exit≠0」——该形态无法确定性归因 spec（命令挂可能是实现缺陷），照旧断言失败路径
- **断言失败** = 产物合法可解析但 case 判 fail

解析失败是确定性 spec 缺陷（错的不是语义而是命令契约）：不计入 flake 连挂（拆「确定性挂被误判随机挂」死局），连挂 ≥2 走回炉通道；豁免条目（`nondeterministic`）不入解析失败清单（豁免 = 不计入任何聚合）。pass/fail 判定本身不变——解析失败的 case 照旧判 fail（伪造成本 ≥ 干活成本）。

### flake（随机性疑似判定）

e2e 级验收**断言失败**在当前 spec 周期内连挂 ≥2 次（`FLAKE_MIN_CONSECUTIVE_FAILS = 2`）触发的随机性疑似判定（rv-5）：frontier `flakeReview` 维度转人工判定（停派 developer、stderr 列连挂 runId），不自动豁免（防 Goodhart）；处置 = 修稳定性 / 声明 nondeterministic 重提 spec / 修真 bug。口径（`src/readonly/frontier.ts` 的 `flakeReviewFacts`）：只认 e2e 级条目；中间任何一次 pass 或新 spec 提交即清零；integrate- 前缀 runId 不参与计数也不清零；**解析失败条目不计入**（跳过 = 本次 run 对该条目既不计数也不清零，mx5-2——解析失败是确定性挂，走回炉通道）。

### 回炉（reheat）与回炉代数

漏网验收命令契约问题的自动退修通道（mx5-2）：解析失败连挂 ≥2（`SPEC_CONTRACT_MIN_CONSECUTIVE_FAILS = 2`——第 1 次给 developer 正常迭代机会，第 2 次定性为 spec 命令契约缺陷）且回炉代数 <2 → frontier `specContractBroken` → runner 派 designer 修 spec（任务书内嵌当前周期逐轮解析失败原文——`<id>.report.json` 顶层 reason，`src/runner/brief.ts`）；新 spec 照旧过独立 reviewer 再审。与 flakeReview 并存时判定序在前（单组归属、序即裁决：解析失败有自动修复通道且 flake 启发式有误判前科，契约回炉优先拆死局）。

**回炉代数** = 「解析失败连挂 ≥2 → 新 SpecSubmitted」的累计次数（上限 `SPEC_CONTRACT_MAX_GENERATIONS = 2`）：新 spec 入账只清连挂计数，**代数绝不清理**（防活锁依赖累计，同打回代数语义）。代数 ≥2（两轮「连挂 → 修 spec → verify 检验」完整走完仍解析失败）→ `specContractDeadlock` 转人工。已知逃逸面（设计记档）：新 SpecSubmitted 整体重置该 unit 全部连挂状态——断言失败条目的 flake 连挂同样被清，每 unit 至多被清 2 次（代数上界）且计数可重建。两常量锚点：`src/readonly/frontier.ts`。

### 打回代数（spec reject generations）

spec-review 环的防活锁计数（mx-3 语义、mx-4 预算 2→10）：同一 SpecSubmitted 之后的首条 role=reviewer fail verdict 计 1 代，同代后续 fail 不重复计（消解单 spawn 内试探性 verdict 误杀）；重提不清零——fail → 重提 → fail = 2 代。默认预算 10 代（`SPEC_REVIEW_DEADLOCK_FAILS = 10`）→ frontier `specReviewDeadlock` 转人工；`cw run --max-spec-rejects` 可注入更紧运行值，只读命令恒用默认。锚点：`src/readonly/frontier.ts` 的 `specReviewFailCounts`。

### 停派（stopped dispatch）

runner 对某 unit 停止自动派发的状态类 = 三个转人工维度（`src/readonly/frontier.ts` 的 `stoppedDispatchState`）：`specReviewDeadlock`（打回代数达预算）/ `flakeReview`（e2e 断言失败连挂）/ `specContractDeadlock`（回炉代数达上限）。机器派发无出口，loop 停派 + stderr 转人工指引；人工处置写入账本后投影自然消失（自愈）。TIMEOUT 结算行在停派态下如实陈述「本次超时不触发重派」（mx5-2 诚实化）。

### 集成 verify（内部节点的 verify）

并行的物理前提：每单元可独立验证 + 集成点机器验证。子树全 verified 后，runner 对根执行确定性集成：merge 子树 → 干净重跑受影响验收 → 契约机器比对（配对 + 树内两道）。集成连续 fail 上限 MAX=1——首败即停止自动重派，转派 designer 处置契约漂移（mergeFailures 结构化入报告与处置任务书；fail 审计事件留账）。

### frontier（就绪集合）

对投影算「哪些单元的哪个阶段现在可以派发」（`src/readonly/frontier.ts`，十二维）：

- `specReady`：created 且无 spec——待 designer 撰写 spec（首派）
- `specReviewPending`：created 且有 spec、最后 spec 后无任何 spec-review verdict——待独立 reviewer 审查（designer 不自审）
- `specFixPending`：created 且最后 spec 后最近的 spec-review verdict 是 fail——待 designer 修 spec 重提
- `specReviewDeadlock`：spec-review 打回代数 ≥ 预算（默认 10，`--max-spec-rejects` 可注入更紧值；重提不清零）——转人工，机器派发无出口
- `missingChildren`：spec-frozen 内部节点且 split 声明的子有未创建——待 designer 补建子
- `integrationDrift`：子全 verified 但集成连续 fail 达上限——待 designer 处置契约漂移
- `integrationReady`：子全 verified、未达 fail 上限——可执行集成（不派 agent，loop 直跑）
- `specContractBroken`：当前 spec 周期内某验收解析失败连挂 ≥2 且回炉代数 <2——待 designer 回炉修验收命令契约（任务书内嵌逐轮解析失败原文，新 spec 照旧过独立 reviewer）
- `specContractDeadlock`：解析失败连挂 ≥2 且回炉代数 ≥2（两轮回炉仍解析失败）——转人工，防回炉活锁
- `flakeReview`：当前 spec 周期内某 e2e 级验收断言失败连挂 ≥2（解析失败条目不计入，走回炉通道）——转人工判定（停派 developer）
- `buildReady`：spec-frozen 叶子且子全部 closed（rootLast）——待 developer
- `execReviewReady`：verified 且未 closed——待 reviewer（exec-review）

### 四态 spawn 退出

AgentSpawn 契约中子进程退出的四种归因：`exit≠0` / `TIMEOUT` / `CRASH` / `SPAWN_ERROR`。前三者可重派（下轮 frontier 重算自然再次进入派发集合）；SPAWN_ERROR（配置错误，如可执行不存在）不重试。stdout/stderr 由 spawn 实现管道直写产物文件，与 agent 进程存活解耦（SIGKILL 后已输出内容仍在）。

### children-first 工作流

designer 的固定动作序：**先建子、后提 spec**。根 unit 的 designer 首派任务书第 0 步就是创建 split 声明的子 unit；spec gate 规则⑦机器强制（子未建/parent 错配的 spec 被拒）。此工作流消灭「root spec-frozen 等不存在的子」类死锁。

### developer

实现角色：写代码 + 提交 build 证据（frontier `buildReady` 维度的派发对象）。旧角色名已于 2026-08-19 用户拍板废弃（mx5-4 改名，直接改不做兼容别名；重放兼容论证见 `src/events/types.ts` 的 role 注释，改名始末与旧值见 `docs/rewrite/design-spec-contract-replan.md` D4）。三角色分工：designer（分解 + 写 spec + 回炉修命令契约）/ developer（实现）/ reviewer（独立审查——spec-review verdict 只认 reviewer）。历史账本携带改名前旧角色值的事件重放语义不变：fold 对 exec-review verdict 不比对 role、对 spec-review 只认 reviewer，改名前后折叠行为一致（role 联合类型：`src/events/types.ts`）。

## 命令面速查（9 个）

| 命令 | 类别 | 用途 |
|------|------|------|
| `cw create --id <slug> --brief <路径> [--parent <id>]` | 写 | 创建 unit（深度上限 2） |
| `cw evidence submit --unit <id> --kind spec --file spec.json` | 写 | 提交 spec（过九规则 + children-first 后入账冻结） |
| `cw evidence submit --unit <id> --kind build --commit <hash> --run-id <id> --file <产物>...` | 写 | 提交构建证据（commit 经 git cat-file 实存校验，产物 sha256 入账） |
| `cw review submit --unit <id> --verdict-kind spec-review\|exec-review --verdict pass\|fail [--comment <text>] [--evidence-refs <runId,...>] [--role reviewer\|designer\|developer\|human]` | 写 | 提交审查结论（append-only，一次写入不可改；exec-review 必填 `--evidence-refs`，合法集 = 该 unit 已入账 EvidenceSubmitted ∪ VerifyRan 的 runId；`--role` 为可选自报字段——审计载体非信任边界） |
| `cw verify --unit <id> [--timeout-ms <n>] [--no-red-phase]` | 写 | 干净重跑验证（三道 gate，红阶段默认执行；exit 0 全过 / 1 有 fail / 2 环境错误） |
| `cw run --root <id> [--spawn human\|pi] [--poll-ms <n>] [--max-idle-ms <n>] [--max-concurrency <n>] [--reviewer-model <m>]` | 跑 | runner 调度循环入口（`--reviewer-model` 配置 reviewer 异源模型，优先于 `CW_REVIEWER_MODEL`） |
| `cw status [--unit <id>] [--json]` | 只读 | 状态视图（fold 投影） |
| `cw frontier [--json]` | 只读 | 就绪集合（十二维，见上 frontier 小节） |
| `cw tree` | 只读 | 分解树 |
| `cw report [--unit <id>]` | 只读 | 证据链汇总（逐验收覆盖标记 ✓/✗ + hash 前 12 位） |

runner 的角色派发规则（对投影每轮重算，维度 → 派发形态单一映射）：created 且无 spec → designer（首派，任务书第 0 步建 split 子 unit）；created 且有 spec 待审 → 独立 reviewer（specReviewPending，designer 不自审）；spec-review fail 后 → designer 修 spec 重提（specFixPending，任务书内嵌 fail comment 全文）；spec-frozen 单元解析失败连挂 ≥2 → designer 回炉修验收命令契约（specContractBroken，任务书内嵌逐轮解析失败原文，新 spec 照旧过独立 reviewer）；spec-frozen 叶子 → developer（verified 未 closed → reviewer exec-review）；子全 verified 的根 → 不派 agent，直接集成；集成连续 fail 达上限 → designer 处置契约漂移。同 unit 存在任意 role 的 in-flight spawn 时本轮缓派（防 worktree reset 清在飞现场）。等待 spawn 期间零锁（否则子进程的 evidence submit 饿死）。中断（Ctrl-C）后重跑 `cw run` 从事件投影续接，已 closed 的单元不重做。可见性防线：无 in-flight reviewer 时新入账的 spec-review verdict 触发 stderr 抢答警告（不阻断——role 自报可伪造，仅审计信号）。

## 环境变量

| 变量 | 作用 | 缺省 |
|------|------|------|
| `CW_HOME` | 存储根目录（per-cwd 隔离的父目录） | `~/.cw`（须绝对路径，相对值报错） |
| `CW_AGENT_MODEL` | pi 后端派发 agent 用的模型（`--model` 参数） | `xiaomi-token-plan-cn/mimo-v2.5-pro` |
| `CW_REVIEWER_MODEL` | reviewer spawn 的异源模型（优先级：`--reviewer-model` flag > 本变量 > 回落 developer 同款模型链；注入点 = reviewer spawn 的 `CW_AGENT_MODEL`） | 未设置（回落 developer 同款） |
| `CW_WORKTREE_HOME` | unit worktree 根目录（须绝对路径） | `~/.cw-worktrees` |
| `CW_PROJECT_DIR` | 项目目录锚点：agent 在 worktree 内执行 cw 命令时经它锚定项目账本与 git 操作（须绝对路径） | 进程 cwd |

## 数据布局

```
~/.cw/                                    # CW_HOME（环境变量可覆盖）
└── __Users__you__proj-<hash8>/           # cwd 编码（/ \ . → __ + sha256 前 8 位防碰撞）
    ├── events.log                        # 事件账本（append-only JSONL）
    ├── evidence/
    │   ├── <unitId>/<runId>/             # verify 运行产物（账本只记元数据 + sha256）
    │   └── <unitId>/attachments/         # 提交原文副本（<sha256>.<name>，内容寻址幂等：spec / build --file / unit brief 三类）
    └── topic/
        └── __Users__you__proj-<hash8>/   # 同 cwd 编码
            └── <runTs>-<rootId>[-N]/     # run 级 spawn 产物目录（brief 覆盖写、stdout/stderr append 累积；永久保留）

~/.cw-worktrees/                          # CW_WORKTREE_HOME（可覆盖）
└── __Users__you__proj-<hash8>/
    └── <unitId>/                         # 每 unit 独立 git worktree（分支双空间命名：root = cw-root/<rootId>，子 = cw/<rootId>/<unitId>）
```

spawn 的过程产物（brief / `<unitId>.<role>.stdout` / `.stderr`）落当次 run 的 topic 目录，与 agent 进程存活解耦；worktree 内只承载 agent 业务产出与 commit（派发前 reset --hard + clean -fd 裸清理）。

一个 cwd 对应一个独立账本；换目录即换账本，互不干扰。

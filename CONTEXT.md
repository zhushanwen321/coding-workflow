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
- `layer`（可选）：验收层级——执行层归属，`"unit"`（缺省）= 本 unit 的 verify 路径执行，`"topic"` = 归集成层（见「验收层级（layer）」词条）

弱验收过不了 spec gate（见「spec gate 十四规则」）。

### 验收命令契约（acceptance command contract）

验收 `command` 与 testrun 适配器输出协议的相容性——命令产物必须能被路由到的适配器机器解析（vitest / playwright：stdout 整体 JSON；pytest：`-v` 条目行；e2e-sh：独立标记行 `<验收id> PASS|FAIL`）。契约违反是确定性挂：实现写得再对也恒判 fail。

spec gate 规则⑨入账前静态检查（`src/gates/spec-rules.ts` 的 `ADAPTER_FLAG_CONTRACTS`，按 `adapterTypeFor` 最终路由——runner 显式声明优先、缺省按 type 推导——分派）：

- vitest / playwright 型：`--reporter` 只放行等号形态且值恰为 `json`（`--reporter=json` 是 translate 幂等检查认定的唯一安全形态——cw 自动追加 `--reporter=json`，其他值与之并存让 stdout 混入人类可读文本、JSON 解析恒挂）；空格形态 `--reporter <值>` 一律拒（mx5-5：translate 幂等检查只认等号子串，空格形态会被 cw 再追加 reporter 致双 reporter 恒挂），另禁 `--outputFile`（任何形式——把 JSON 重定向到文件、stdout 无 JSON）
- pytest 型：禁 `-q` / `--quiet` 及其长选项前缀缩写（`--q` / `--qu` / `--qui` / `--quie`——argparse 允许缩写，严格逐字符前缀链，`--query` 类更长选项不在链内），含短选项合写簇（`-qq` / `-vq` 等，对簇 token 逐字符展开）——与适配器追加的 `-v` verbosity 相抵、条目行消失
- e2e-sh / manual 型：无静态规则（诚实边界：标记行产出无法静态证明——可能在脚本内、可能条件执行），漏网形态由 reviewer 任务书契约清单 + 回炉通道兜底

例：`npx vitest run --reporter=verbose tests/x.spec.ts` 被⑨当场拒（reporter 值非 json）；裸 `pnpm build` 过得了⑨（e2e 型无静态规则）但 verify 时永不产出 `A3 PASS` 标记行 → 解析失败 → 回炉。

### 验收层级（layer）

验收条目的执行层归属（al-2，《验收分层与成本治理》设计 §3.3 D1）——与 `type`（用例形态）正交的另一根轴：`layer: "unit"`（缺省）= 本 unit 的 verify 路径执行；`layer: "topic"` = 归集成层，唯一执行点 = 所属节点的集成验证（子树全 verified 后受影响验收重跑）。声明位置约束：topic 条目只能声明在 split 非空的 spec——spec gate 规则⑩机器强制（无子节点 = 无集成执行点，声明 topic = 条目永无执行点，提交期拒绝）。`layer` 字段本身不改变任何执行器行为（verify / 集成 / fold 均不读它），效力来自声明位置约束 + 集成装配的既有行为。缺省 `"unit"` 且缺省不写键：旧 spec / 旧账本无 `layer` 字段 = 行为逐字节不变（重放兼容）。

### 证据（Evidence）

机器可复算的产物：commit hash、测试运行产物文件、重跑日志。`passedCount: 4` 这类声明不是证据。证据以事件入账（`EvidenceSubmitted`，含 runId 幂等键 + 产物 sha256），判定一律以系统自己干净重跑的结果为准。

### 契约（Contract）

跨单元的接口承诺（函数签名 / API / schema），随 spec 一起 hash 冻结，供依赖方对着写；集成 verify 时机器比对（签名 ≡ 冻结 hash）。闭环：designer 产出 → 随 spec 冻结入账 → 内部节点 verify 比对。

### 事件账本（event ledger）

唯一的真相源：append-only JSONL（`events.log`），六类事件：

| 事件 | 载荷要点 |
|---|---|
| `UnitCreated` | unitId、parentId（null = 根）、briefRef |
| `SpecSubmitted` | specHash（冻结锚点）、acceptance[]（含可选 runner / nondeterministic）、contracts[]、split[] |
| `VerdictSubmitted` | verdictKind（spec-review / exec-review）、verdict（pass / fail）、evidenceRefs、role（自报：审计载体非信任边界；spec-review verdict 经命令面必填且必须 reviewer——mx-3，exec-review 可选缺省不入账） |
| `EvidenceSubmitted` | runId（幂等键）、commit、paths[]、sha256[]、exitCode |
| `VerifyRan` | runId、reportHash、result（pass / fail）、acceptanceIds[]、parseFailedAcceptanceIds[]（可选，mx5-1：本次 verify 产物解析失败的验收 id；旧账本缺字段 = 无解析失败，重放兼容） |
| `ReflectionRan` | unitId、specHash（反思锚：重提新 spec = 新 hash = 需重新反思）、round（unit 级轮次，1 起）、sessionFile?（审计锚）、revisedSpec?（是否引发 spec 修订）——反思先于审查的锚记录，纯 append、不参与四态派生 |

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

### spec gate 十四规则

spec 提交时的确定性检查（多缺口全列、不短路，`src/gates/spec-rules.ts`）：

① 验收非空；② core 用例自身 type 必须为 e2e-real / e2e-mock；③ e2e 用例 command 非空且首 token 在 PATH 可解析；④ e2e-mock 附非空 mock 保真度说明；⑤ 至少一条 unit 级用例；⑥ split 不得自引用；⑦ 验收 id 字符集（`ACCEPTANCE_ID_RE`，与 e2e-sh marker 同源）；⑧ runner 显式声明必须在 `knownAdapterTypes()` 集合内（合法值与注册表逐字符一致，大小写敏感）；⑨ 验收命令契约——按最终适配器路由检查冲突 flag：vitest / playwright 的 `--reporter` 值若出现必须恰为 `json` 且禁 `--outputFile`；pytest 禁 `-q` / `--quiet`（含短选项合写）；e2e / manual 无静态规则（见「验收命令契约」词条）；⑩ `layer: "topic"` 条目要求 spec.split 非空（al-3，fail 级）——叶子/无子节点 unit 声明 topic = 条目永无执行点的真空（split 非空 ⟺ 有子节点 ⟺ 有集成执行点），提交期拒绝并给两个恢复方向（上收 root spec 标 topic / 去 layer 按 unit 层声明）；已知边界：单 unit topic（root 无子、split 空）同样不能声明 topic 层；⑪ unit 层条目 command 纯词法命中全量回归形态（al-3，warning 级成本启发式，不执行命令）——形态 A：`[npx/pnpm/yarn/bun/bunx 可选前缀] vitest run` 且 run 后无位置参数；形态 B：首 token `npm/pnpm/yarn/bun`（允许 `run` 中缀）script 名恰为 `test`/`lint` 且其后无位置参数——命中 → 入账继续（`ok` 判定只看 failures 不变）+ `SpecRulesResult.warnings` 交 `evidence submit` stderr 逐条打印；wrapper 脚本 / script 别名封装 / `make test` 显式不枚举（诚实漏报面，reviewer 任务书第六维语义审兜底）；warning 级理由：静态形态判定有误杀面，硬拒会逼出 wrapper 规避动作；⑫ 全部非 manual 型条目 command 纯词法路径逃逸拦截（lv-1，fail 级）——command 原文含 `.cw-worktrees` 子串，或目录选择词法族（`cd` / `-C` / `--dir` / `--prefix` / `--root`，`git -C` 由 `-C` 成员覆盖，单一事实源 = `DIRECTORY_FLAG_TOKENS`）后随剥引号以 `/` 或 `~` 开头的 token（`-C` 紧贴前缀形态 `-C/abs` / `-C~x` 亦拦——git 短选项合法写法，剥 `-C` 前缀后即绝对路径）→ 拒入账：逃逸使 verify 绑定执行瞬间的工作区状态而非账本 commit（语义失效，同⑩真空声明哲学）；诚实漏报面：`cd ../..` 相对上跳、`bash -c 'cd /abs'` 引号包裹关键词、`cd "/abs path"` 引号包裹含空白绝对路径（tokenize 按空白切分，引号不成对剥不掉）、`$(echo cd) /abs` 动态构造、`CW_WORKTREE_HOME` 自定义工作区名，由 reviewer 第五维语义审兜底；⑬ unit 层条目 command 纯 typecheck 形态拦截（M7 fa D2，分段双档）——命令按 `&&`/`;`/`||` 分段后逐段归类：全部段为 typecheck 可执行族（`tsc`/`vue-tsc`/`tsgo`，允许 `npx/pnpm/yarn/bun/bunx` 前缀）→ fail 级拒入账（typecheck 不引用测试文件，红阶段在实现前基线树上恒 pass = 无区分力，verify 恒 fail——裸形态烧 2 轮 verify 全价才被回炉通道接走）；未达 fail 档但全部段为 script 名族（`npm/pnpm/yarn/bun [run]` 后随 `typecheck`/`type-check`/`types`/`tsc`）→ warning 级入账继续（script 体词法不可见，「gate 词法层不猜」诚实边界同⑪，文案点名歧义建议内联展开）；`layer: "topic"` 豁免（root typecheck 链是集成层合法形态）；⑭ e2e 型条目 command 首部（manager 前缀后一位）为 vitest/pytest 调用且无显式 runner 声明 → warning 级入账继续（M7 fa D7）：缺省推导按 type 把条目路由到 e2e-sh 找标记行，vitest/pytest 输出解析必挂——verify 恒 fail；文案给两条恢复（显式声明 runner / 或把 type 改 `unit|integration` 让缺省推导命中）；显式声明 runner 的条目归规则⑧管辖，不在本规则复查。

另有 handler 级防线串联在 spec 提交路径（不在上述规则清单内）：children-first——split 声明的子 unit 必须已创建且 parent 匹配，缺子/错配分类清单拒收（`src/handlers/evidence-submit.ts`）。

「验收强不强」这类语义判断由独立 reviewer 审，不在机器规则职责内。

### 三道验证 gate

verify（干净重跑）的判定链，共同原则是**伪造成本 ≥ 干活成本**：

1. **红阶段**（默认执行，`--no-red-phase` 逃生口）：新测试打到旧代码树必须挂（不挂 = 测试无区分力，拒绝）。build commit 回退第一父（实现前基线树），验收 command 引用的变更文件先 patch 进父树再跑；无父 commit 合法跳过；`nondeterministic` 声明条目跳过判定
2. **名字级比对**：验收逐条按名字在重跑产物里 PASS，不是「N passed ≥ 用例数」的计数启发式（`nondeterministic` 声明条目跳过，结果标注 nameSkipped）
3. **干净重跑**：干净 checkout 到隔离临时工作区（commit hash 取自账本）+ 独立 CW_HOME，系统自己 spawnSync 复跑

### 解析失败 vs 断言失败（parse failure vs assertion failure）

verify 重跑产物的失败二分类（mx5-1/mx5-2）：

- **解析失败** = `AcceptanceRunResult.parseError === true`（无法产出可判定产物）。来源**非穷举**——完整集合以四适配器 parse/translate 实现（`src/testrun/`）与 `src/verify/run.ts` 的路由为准，代表形态：适配器 parse 抛错（vitest / playwright stdout 非法 JSON 或 JSON 合法但形状不符；e2e-sh 无标记行——无论 exit code：0 = 无区分力、≠0 = 脚本未按契约跑到输出点疑似崩溃/环境断链，或标记 id 与验收 id 不符）、零条目且 exit 0 防线（playwright / pytest 判无区分力抛错）、translate 抛错（如 runner 显式声明 e2e-sh 的条目 command 缺省）、路由不到适配器的旁路（非法 runner 绕过 gate）。入账字段 = VerifyRan 的 `parseFailedAcceptanceIds`。e2e-sh「无标记行且 exit≠0」自 lv-3 起归解析失败（原「no-markers 整体 fail」形态废止——脚本崩溃/环境断链连挂 2 走回炉修 spec，不再混入 flake「随机性 or 真 bug」的错误二选一；真测试红的正道形态 = 有 FAIL 标记 + exit≠0，不受影响）
- **断言失败** = 产物合法可解析但 case 判 fail

解析失败是确定性 spec 缺陷（错的不是语义而是命令契约）：不计入 flake 连挂（拆「确定性挂被误判随机挂」死局），连挂 ≥2 走回炉通道；豁免条目（`nondeterministic`）不入解析失败清单（豁免 = 不计入任何聚合）。pass/fail 判定本身不变——解析失败的 case 照旧判 fail（伪造成本 ≥ 干活成本）。

### 无区分力（non-discriminative）

红阶段判定的区分力缺失语义：新验收打到实现前基线树（build commit 第一父，验收引用的变更文件先 patch 进父树）上**照样 pass** = 对任何实现都无区分力——恒真测试防线拒入的判定依据（`src/verify/red-phase.ts` 的 `judgeRedPhase`）。判定结果落两处：verify 产物 report.json 的 redPhase 节（原文载体，`[{id, discriminative, skipped?, reason}]`——该节在主 runId 目录顶层 report.json，不在 `<id>.report.json`）+ VerifyRan payload 的 `nonDiscriminativeAcceptanceIds`（投影输入，M7 fa D1 起入账本；旧账本缺字段 = 无无区分力条目，重放兼容）。豁免边界：`nondeterministic` 声明条目红阶段跳过判定，天然不入列；`--no-red-phase` 下红阶段不执行、字段缺省。pass/fail 判定不受影响——红阶段 fail 不改机器 pass 事实，无区分力条目常规 run pass 照旧进 acceptanceIds，字段只做投影分类。与解析失败的并集关系：两者同座为确定性 spec 缺陷信号，`specContractFacts` 并集消费（见「挂法归因」）。

### 挂法归因（fail attribution）

cw 失败治理的信号分类学：**确定性 spec 缺陷信号枚举 = 解析失败 ∪ 无区分力**（开放集合——未来第四种机器可判定信号走同一范式扩容：VerifyRan 可选字段同构先例 + 投影并集消费），连挂 ≥2 走 `specContractBroken` 回炉通道；**非确定性挂** = e2e 断言失败连挂走 `flakeReview` 通道（随机性疑似转人工）；**其余一切 fail 落 developer 桶兜底**（正常迭代语义，含 buildDrift 缓慢进展预算）。无通用 `failAttribution[]` 字段是有意设计（M7 fa D1 被否方案）：断言挂 vs 环境挂机器判不准，LLM 自报不作投影输入——红线：归因路由只由机器可判定信号驱动，LLM 意见可入 verdict comment 留档供人读。

### flake（随机性疑似判定）

e2e 级验收**断言失败**在当前 spec 周期内连挂 ≥2 次（`FLAKE_MIN_CONSECUTIVE_FAILS = 2`）触发的随机性疑似判定（rv-5）：frontier `flakeReview` 维度转人工判定（停派 developer、stderr 列连挂 runId），不自动豁免（防 Goodhart）；处置 = 修稳定性 / 声明 nondeterministic 重提 spec / 修真 bug。口径（`src/readonly/frontier.ts` 的 `flakeReviewFacts`）：只认 e2e 级条目；中间任何一次 pass 或新 spec 提交即清零；integrate- 前缀 runId 不参与计数也不清零；**解析失败与无区分力条目均不计入**（跳过 = 本次 run 对该条目既不计数也不清零，mx5-2 / M7 fa D3②——确定性挂走回炉通道；清零判定在前：常态下无区分力条目常规 run pass 在 pass 集内自然清零，排除的作用面 = 主 run fail 的混合边角）。

### buildDrift（缓慢进展停派）

「做不完的单元」的有限成本出口（lv-2）：本 spec 周期内 build 证据（`EvidenceSubmitted` 计数）≥K 且无 pass verify → frontier `buildDrift` 维度停派转人工（每轮有产出但期望完成时间发散，机器派发无出口；stderr 指引三选一：人工接手 / 拆小任务另建 unit / 调大 K 续跑）。K 默认 5（`BUILD_DRIFT_MAX_ATTEMPTS`）经 `cw run --max-build-attempts` 注入（只读命令恒用默认——转人工预算是运行策略）。口径（`src/readonly/frontier.ts` 的 `buildDriftFacts`）：周期锚 = SpecSubmitted 入账清零（specEpoch 累计，出声去重签名维度）；集成 run（integrate- 前缀 runId）跳过——不计数不清零不置 pass；pass 豁免（非集成 VerifyRan pass 后永不触发，计数不清零）；跨 run 持久——账本态非进程态（Ctrl-C 重跑计数不丢）。

### 回炉（reheat）与回炉代数

漏网验收命令契约问题的自动退修通道（mx5-2，M7 fa D3/D5 语义升格为「确定性 spec 缺陷回炉」）：确定性 spec 缺陷信号（解析失败 ∪ 无区分力，见「挂法归因」）连挂 ≥2（`SPEC_CONTRACT_MIN_CONSECUTIVE_FAILS = 2`——第 1 次给 developer 正常迭代机会，第 2 次定性为 spec 的确定性缺陷；并集逐条目逐 run 去重——同一 id 同一 run 双清单同真只计一次）且回炉代数 <2 → frontier `specContractBroken` → runner 派 designer 修 spec（任务书内嵌当前周期逐轮机器原文，取数分流——解析失败读 `<id>.report.json` 顶层 reason，无区分力读主 runId 目录顶层 report.json 的 redPhase 节按 id 取，不可读均降级 id+路径，`src/runner/brief.ts`）；新 spec 照旧过独立 reviewer 再审。与 flakeReview 并存时判定序在前（单组归属、序即裁决：确定性缺陷有自动修复通道且 flake 启发式有误判前科，契约回炉优先拆死局）。

**回炉代数** = 「连挂 ≥2 → 新 SpecSubmitted」的累计次数（上限 `SPEC_CONTRACT_MAX_GENERATIONS = 2`）：新 spec 入账只清连挂计数，**代数绝不清理**（防活锁依赖累计，同打回代数语义）。代数 ≥2（两轮「连挂 → 修 spec → verify 检验」完整走完仍带确定性缺陷信号）→ `specContractDeadlock` 转人工。已知逃逸面（设计记档）：新 SpecSubmitted 整体重置该 unit 全部连挂状态——断言失败条目的 flake 连挂同样被清，每 unit 至多被清 2 次（代数上界）且计数可重建。两常量锚点：`src/readonly/frontier.ts`。

### 打回代数（spec reject generations）

spec-review 环的防活锁计数（mx-3 语义、mx-4 预算 2→10）：同一 SpecSubmitted 之后的首条 role=reviewer fail verdict 计 1 代，同代后续 fail 不重复计（消解单 spawn 内试探性 verdict 误杀）；重提不清零——fail → 重提 → fail = 2 代。默认预算 10 代（`SPEC_REVIEW_DEADLOCK_FAILS = 10`）→ frontier `specReviewDeadlock` 转人工；`cw run --max-spec-rejects` 可注入更紧运行值，只读命令恒用默认。锚点：`src/readonly/frontier.ts` 的 `specReviewFailCounts`。

### 停派（stopped dispatch）

runner 对某 unit 停止自动派发的状态类 = 四个投影转人工维度（`src/readonly/frontier.ts` 的 `stoppedDispatchState`）：`specReviewDeadlock`（打回代数达预算）/ `flakeReview`（e2e 断言失败连挂）/ `specContractDeadlock`（回炉代数达上限）/ `buildDrift`（build 证据达预算无 pass，缓慢进展——lv-2）；另有连续 TIMEOUT 封顶的进程态停派（单进程内存态、跨 run 归零，不属投影维度）。机器派发无出口，loop 停派 + stderr 转人工指引；人工处置写入账本后投影自然消失（自愈）。停派维度命中时 loop 除停派外还回收该 unit 的在飞 spawn（尽力 kill + stderr 出声，同停派 episode 内去重，自愈后二次停派重新回收；TIMEOUT 封顶档为防御性兜底；reflectionPending 不属停派不回收——M7 fb D9，观察 C10）。TIMEOUT 结算行在停派态下如实陈述「本次超时不触发重派」（mx5-2 诚实化）。

### 集成 verify（内部节点的 verify）

并行的物理前提：每单元可独立验证 + 集成点机器验证。子树全 verified 后，runner 对根执行确定性集成：merge 子树 → 干净重跑受影响验收 → 契约机器比对（配对 + 树内两道）。集成连续 fail 上限 MAX=1——首败即停止自动重派，转派 designer 处置契约漂移（mergeFailures 结构化入报告与处置任务书；fail 审计事件留账）。

### frontier（就绪集合）

对投影算「哪些单元的哪个阶段现在可以派发」（`src/readonly/frontier.ts`，十四组——十三个推进/转人工维度 + lv-2 的 buildDrift 缓慢进展停派组）：

- `specReady`：created 且无 spec——待 designer 撰写 spec（首派）
- `reflectionPending`：created 且有 spec，最新 SpecSubmitted 的 specHash 无对应 ReflectionRan——待反思（反思先于审查：loop 对长驻 spawn 发 followUp，完成后写 ReflectionRan 再派 reviewer；重提新 spec 即重新 pending）
- `specReviewPending`：created 且有 spec、最后 spec 后无任何 spec-review verdict——待独立 reviewer 审查（designer 不自审）
- `specFixPending`：created 且最后 spec 后最近的 spec-review verdict 是 fail——待 designer 修 spec 重提
- `specReviewDeadlock`：spec-review 打回代数 ≥ 预算（默认 10，`--max-spec-rejects` 可注入更紧值；重提不清零）——转人工，机器派发无出口
- `missingChildren`：spec-frozen 内部节点且 split 声明的子有未创建——待 designer 补建子
- `integrationDrift`：子全 verified 但集成连续 fail 达上限——待 designer 处置契约漂移
- `integrationReady`：子全 verified、未达 fail 上限——可执行集成（不派 agent，loop 直跑）
- `specContractBroken`：当前 spec 周期内某验收带确定性 spec 缺陷信号（解析失败 ∪ 无区分力）连挂 ≥2（逐 run 去重）且回炉代数 <2——待 designer 回炉修验收命令契约（任务书内嵌逐轮机器原文，新 spec 照旧过独立 reviewer）
- `specContractDeadlock`：确定性 spec 缺陷信号连挂 ≥2 且回炉代数 ≥2（两轮回炉仍带缺陷信号）——转人工，防回炉活锁
- `flakeReview`：当前 spec 周期内某 e2e 级验收断言失败连挂 ≥2（解析失败与无区分力条目不计入，走回炉通道）——转人工判定（停派 developer）
- `buildDrift`：本 spec 周期内 build 证据 ≥K（默认 5，`--max-build-attempts` 可注入）且无 pass verify——缓慢进展转人工（lv-2，停派 developer）
- `buildReady`：spec-frozen 叶子且子全部 closed（rootLast）——待 developer
- `execReviewReady`：verified 且未 closed——待 reviewer（exec-review）

### 四态 spawn 退出

AgentSpawn 契约中子进程退出的四种归因：`exit≠0` / `TIMEOUT` / `CRASH` / `SPAWN_ERROR`。前三者可重派（下轮 frontier 重算自然再次进入派发集合）；SPAWN_ERROR（配置错误，如可执行不存在）不重试。stdout/stderr 由 spawn 实现管道直写产物文件，与 agent 进程存活解耦（SIGKILL 后已输出内容仍在）。

### children-first 工作流

designer 的固定动作序：**先建子、后提 spec**。根 unit 的 designer 首派任务书第 0 步就是创建 split 声明的子 unit；handler 级 children-first 防线（fx-3 R5.1）机器强制（子未建/parent 错配的 spec 被拒）。此工作流消灭「root spec-frozen 等不存在的子」类死锁。

### developer

实现角色：写代码 + 提交 build 证据（frontier `buildReady` 维度的派发对象）。旧角色名已于 2026-08-19 用户拍板废弃（mx5-4 改名，直接改不做兼容别名；重放兼容论证见 `src/events/types.ts` 的 role 注释，改名始末与旧值见 `docs/rewrite/design-spec-contract-replan.md` D4）。三角色分工：designer（分解 + 写 spec + 回炉修命令契约）/ developer（实现）/ reviewer（独立审查——spec-review verdict 只认 reviewer）。历史账本携带改名前旧角色值的事件重放语义不变：fold 对 exec-review verdict 不比对 role、对 spec-review 只认 reviewer，改名前后折叠行为一致（role 联合类型：`src/events/types.ts`）。

## 命令面速查（10 个）

| 命令 | 类别 | 用途 |
|------|------|------|
| `cw create --id <slug> --brief <路径> [--parent <id>]` | 写 | 创建 unit（深度上限 2） |
| `cw evidence submit --unit <id> --kind spec --file spec.json` | 写 | 提交 spec（过十四规则 + children-first 后入账冻结；规则⑪⑬⑭ warning 命中时入账继续 + stderr 警告） |
| `cw evidence submit --unit <id> --kind build --commit <hash> --run-id <id> --file <产物>...` | 写 | 提交构建证据（commit 经 git cat-file 实存校验，产物 sha256 入账） |
| `cw review submit --unit <id> --verdict-kind spec-review\|exec-review --verdict pass\|fail [--comment <text>] [--evidence-refs <runId,...>] [--role reviewer\|designer\|developer\|human]` | 写 | 提交审查结论（append-only，一次写入不可改；exec-review 必填 `--evidence-refs`，合法集 = 该 unit 已入账 EvidenceSubmitted ∪ VerifyRan 的 runId；spec-review verdict 必填 `--role reviewer`——缺/错 exit 1 拒收，mx-3 入账层强校验；exec-review 的 `--role` 为可选自报字段——审计载体非信任边界；同代重复 spec-review verdict exit 1 拒收——最后一条 SpecSubmitted 后已有 reviewer 结论即守卫生效，重审 = designer 重提 spec 走新代，exec-review 不设此守卫，M7 fb D8） |
| `cw verify --unit <id> [--timeout-ms <n>] [--no-red-phase]` | 写 | 干净重跑验证（三道 gate，红阶段默认执行；exit 0 全过 / 1 有 fail / 2 环境错误） |
| `cw run --root <id> [--spawn human\|pi] [--poll-ms <n>] [--max-idle-ms <n>] [--max-concurrency <n>] [--reviewer-model <m>] [--max-build-attempts <n>] [--spawn-timeout-ms <毫秒>]` | 跑 | runner 调度循环入口（`--reviewer-model` 配置 reviewer 异源模型，优先于 `CW_REVIEWER_MODEL`） |
| `cw setup-agent-dir [--agent-dir <路径>] [--ask-user-source <src>] [--ask-user-path <路径>] [--pi-bin <路径>] [--timeout-ms <n>] [--skip-probe]` | 写 | 受控 agentDir 安装准备（spawnSync 透传插件包 `@zhushanwen/pi-coding-workflow` 的 installer：装 ask-user 扩展清单 + manifest.json + 启动探针；installer 未找到 = exit 2 环境错误） |
| `cw status [--unit <id>] [--json]` | 只读 | 状态视图（fold 投影；specs 列表对当前生效版 specHash 标 ← active——最后一条 SpecSubmitted 即生效版） |
| `cw frontier [--json]` | 只读 | 就绪集合（十四组，见上 frontier 小节） |
| `cw tree` | 只读 | 分解树 |
| `cw report [--unit <id>]` | 只读 | 证据链汇总（逐验收覆盖标记 ✓/✗ + hash 前 12 位） |

runner 的角色派发规则（对投影每轮重算，维度 → 派发形态单一映射）：created 且无 spec → designer（首派，任务书第 0 步建 split 子 unit）；created 且有 spec 且最新 spec 未反思 → 反思先于审查（reflectionPending：loop 对在飞长驻句柄发 followUp 反思文案，完成后写 ReflectionRan 再派 reviewer，无在飞句柄则代写占位事件）；created 且有 spec 待审 → 独立 reviewer（specReviewPending，designer 不自审）；spec-review fail 后 → designer 修 spec 重提（specFixPending，任务书内嵌 fail comment 全文）；spec-frozen 单元确定性 spec 缺陷信号（解析失败 ∪ 无区分力）连挂 ≥2 → designer 回炉修验收命令契约（specContractBroken，任务书内嵌逐轮机器错误原文——两类信号分别取自 `<id>.report.json` 与主 runId report.json 的 redPhase 节，新 spec 照旧过独立 reviewer）；spec-frozen 叶子 → developer（verified 未 closed → reviewer exec-review）；子全 verified 的根 → 不派 agent，直接集成；集成连续 fail 达上限 → designer 处置契约漂移。同 unit 存在任意 role 的 in-flight spawn 时本轮缓派（防 worktree reset 清在飞现场）。等待 spawn 期间零锁（否则子进程的 evidence submit 饿死）。中断（Ctrl-C）后重跑 `cw run` 从事件投影续接，已 closed 的单元不重做。可见性防线：无 in-flight reviewer 时新入账的 spec-review verdict 触发 stderr 抢答警告（不阻断——role 自报可伪造，仅审计信号）。

## 环境变量

| 变量 | 作用 | 缺省 |
|------|------|------|
| `CW_HOME` | 存储根目录（per-cwd 隔离的父目录） | `~/.cw`（须绝对路径，相对值报错） |
| `CW_AGENT_MODEL` | pi 后端派发 agent 用的模型（`--model` 参数） | `xiaomi-token-plan-cn/mimo-v2.5-pro` |
| `CW_REVIEWER_MODEL` | reviewer spawn 的异源模型（优先级：`--reviewer-model` flag > 本变量 > 回落 developer 同款模型链；注入点 = reviewer spawn 的 `CW_AGENT_MODEL`） | 未设置（回落 developer 同款） |
| `CW_SPAWN_TIMEOUT_MS` | 单次 agent spawn 超时（优先级：`--spawn-timeout-ms` flag > 本变量 > 缺省 30min 常量 `AGENT_SPAWN_TIMEOUT_MS`；须正整数毫秒，非法 exit 1） | 未设置（30min） |
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

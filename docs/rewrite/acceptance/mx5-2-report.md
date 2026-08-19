# mx5-2 verifier 报告：解析失败回炉投影 + 派发链 + D6 文案诚实化

> 独立 verifier 验收（与 developer 无关的第三方）。基线：`docs/rewrite/acceptance/mx5-2-acceptance.md`（3b3ec42 版）；交付 commit：`9703d9f`（9 文件 +1538/-183）。
> 机器证据：V2/V2b 全部落盘 `/tmp/cw-mx52-v2/`；红性抽查与测试复跑在本仓库现场执行，改动全部恢复（`git diff` 干净）。

## 总结论：PASS（带 2 项 minor 测试覆盖 findings，不阻塞）

| # | 验收项 | 判定 | 关键证据 |
|---|--------|------|----------|
| 1 | 防篡改链 | PASS | §1-§7（L1-67）shasum `0a9d889d…` 与 3b3ec42 版逐字节一致；仅 §8 status 流转（基线明示不属于防篡改范围）；`git status` 干净（仅 untracked `.tmp/`） |
| 2 | 禁改清单独立复核 | PASS | `git diff 3b3ec42..9703d9f -- src/testrun/ src/verify/ src/gates/ src/events/types.ts src/handlers/ src/core/ src/store/ src/runner/{integrate,worktree,human-loop}.ts src/runner/spawn/ src/cli.ts src/dispatch.ts` = 0 行 |
| 3 | 函数搬移等价性 | PASS | specReviewFailComments / specVerdictTsBySeq / subtreeUnits / unitEventHighWaterSeqs 四函数 body 逐字节一致（仅加 `export` 关键字）；loop.ts 经 `../readonly/frontier.js` 导入接线，无重复定义，`DiscriminatedEvent` 导入随迁 |
| 4 | 4 项越界深查 | 4/4 最小必要 | 逐项结论见下节 |
| 5 | 验收命令复跑 | PASS | check:all（两段 tsc）干净；定向 mx5-2(15)+mx5-1(18)=33 绿；eslint 三源文件+新测试 0 问题；全量 **68 文件 527 用例全绿**（149.38s） |
| 6 | 条款级代码审查（§4 口径） | PASS | 逐条见 §条款对照 |
| 7 | 红性抽查 | ②PASS / ①③无法翻红 | ②代数清零突变 → F5 红（共 5 红）；①③全量仍绿 → findings R1/R2；改动全部恢复 |
| 8 | V2 回炉全链 | PASS | 6 断言全过（见 §V2） |
| 9 | V2b 防活锁出口 | PASS | deadlock 出现（broken 此前恰 2 次）+ escalation 出声 + 10s 零派发（见 §V2b） |

## 4 项越界深查（独立结论）

### ① mx5-3 测试 B3 快照 +6/-1 —— 最小必要
diff 仅两处：B3_SNAPSHOTS 注释备案 + `designer-spec-fix` 快照内一句话（「累计 2 次 fail 转人工」→「累计打回代数（重提不清零，达预算——默认 10 代——转人工）），与 brief.ts 同一 commit 的基线 §2③ 明文授权的过时文案修复逐字同步。**reviewer 模板本体（specReviewReviewerTasks）与 B1/B2/B4 断言零改动**（diff 无任何触及该函数的 hunk）。不掩盖回归。

### ② u1b-e2e +7/-1 —— 最小必要（结构性必然）
frontier `--json` 输出新增 specContractBroken/specContractDeadlock 两组空键，`toEqual` 严格相等必须补键。两处（flag 端到端 / 空账本）均只补空键 + 注释一行，无断言语义变化。

### ③ rv5 fixture 改恒可解析 JSON —— 最小必要且语义等价（重点核查项）
- **改动本体**：u1check.js 把 JSON 输出移到 exit 判定之前且 `status: ok ? 'passed' : 'failed'`——坏实现时从「裸文本 + exit 1（vitest parse 抛错）」变为「合法 JSON + case failed + exit 1」。红阶段区分力保持（坏树 status=failed 仍 fail）。
- **T3/T7/T8 等价性**：三用例的 flake 触发源是 E1（e2e）断言失败（implBad 输出 `E1 FAIL` 标记行），改造前后形态不变，flake 断言意图等价。若不改：U1 的解析失败连挂会进 specContractFacts（该投影不分 acceptance type），单组归属下 broken 先于 flakeReview，三用例会整体翻红——改造是把「flake 焦点」与「回炉通道」解耦的最小手段，非削弱。
- **T5 断言 buildReady→specContractBroken 是语义必然**：T5 用独立 fixture `u5.js`（`console.log('not json')`），旧代码注释原文即「U5 parse fail（vitest 产物非 JSON）」——该场景本来就是解析失败形态。mx5-2 后 unit 级解析失败连挂确定性归 specContractBroken（投影不分 type），旧断言在新语义下为假。unit 级解析失败的投影覆盖由 T5 新断言保留，无回归掩盖。
- 备选方案对比：保持旧 fixture 并把 T3/T7/T8 改判 broken 会掏空 rv5 套件的 flake 焦点，改动面更大。

### ④ D6 停派态范围（TIMEOUT 封顶不进 describeExit）—— 事实成立，非掩盖
代码核实（src/runner/loop.ts）：TIMEOUT 封顶转人工是单进程内存态（`timeoutStreaks`/`escalated`）；`escalated` 只增不删（L1166-1168 注释明示「进展清零只作用于计数，不撤销转人工」+ L1282-1285），并经 `new Set(escalated.keys())` 传入 computeDispatchTargets 的排除集合（L377-379 跳过）——**封顶后本进程内该 unit 不可能有新 spawn**，describeExit 无从也无需投影判定。封顶当次的第 2 次 TIMEOUT 结算行打印「可重派（连续 2 次后转人工）」，而下一轮即转人工——文案与将发生的真实行为一致，无欺骗面。frontier.ts `stoppedDispatchState` 注释（L733-738）已记档此边界。

## 条款对照（基线 §4 口径 → 实现锚点）

| 口径 | 实现锚点 | 判定 |
|------|----------|------|
| 同构语义：per-acceptance 逐条计数 | `specContractFacts`（frontier.ts L548-613）streaks 按 id 计数 | ✓ |
| 中间解析成功清零 | L583-587：该 run 未解析失败的连挂条目 delete | ✓（实现正确；测试区分力缺口见 R2） |
| 周期边界 = SpecSubmitted 事件（不比 specHash） | L558-572：事件类型即锚，无 hash 比较 | ✓ |
| integrate- 前缀排除 | L574-576 | ✓ |
| 无 spec 周期锚的 VerifyRan 忽略 | L577-580 | ✓ |
| 回炉代数：「连挂 ≥2 → 新 SpecSubmitted」计数，累计绝不清理 | L559-572：SpecSubmitted 时前周期有 streak≥2 即 +1，generations 跨周期保留 | ✓ |
| 两维度判定：streak≥2∧gen<2 → broken；streak≥2∧gen≥2 → deadlock；gen 满但当前周期未再连挂 → 皆不成立 | computeFrontier L688-696（F6 用例覆盖「代数 2 + 新周期连挂 1」） | ✓ |
| 判定序先于 flakeReview（单组归属，序即裁决）+ GROUP_ORDER 展示序同步 | L684-701 / L102-115 | ✓ |
| flake 连挂输入排除解析失败条目（只增一点，既有语义零变更） | flakeReviewFacts L467-472 跳过（不计数不清零）；对照 git diff 其余逻辑零改动 | ✓ 实现 / ✗ 无翻红测试（R1） |
| 回炉任务书：全部 id + 逐轮原文 + 恢复指引 + spec diff 要求 + 独立 reviewer 提示；取数 = report.json 顶层 parseError/reason，降级 id+路径 | brief.ts `specContractBrokenTasks`/`parseFailFactsOf`（L216-302）；取数路径与 verify/run.ts L374-384 落盘结构核实一致；降级有测试（F9 第二用例） | ✓ |
| escalation 去重（消息文本签名，mx-3 模式） | loop.ts `announceManualEscalations` L992-1005 + `announcedContractDeadlock` | ✓ |
| DISPATCH_SHAPE broken→designer；deadlock 进 loop 排除清单 + brief Exclude 三处联动 | loop.ts L323 / L381-390；brief.ts L46-49 | ✓ |
| D6：只改文案与 describeExit 签名，优先级行为零变更 | describeExit L791-811：非停派态四分支输出与旧版逐字节一致（u7b 回归锁在 F10）；stopState 仅 TIMEOUT 时现算 | ✓ |
| 既有语义锁定（specReviewFailCounts / SPEC_REVIEW_DEADLOCK_FAILS=10 / INTEGRATION_MAX_CONSECUTIVE_FAILS=1 / mx5-3 reviewer 模板逐字节） | diff 逐一核实零变更 | ✓ |

## 红性抽查（3 条，全部恢复，`git diff` 干净）

1. **去掉 flake 输入排除**（删 frontier.ts L467-472 跳过块）→ 定向 mx5-2+rv5 23 绿，**全量 527 仍绿——无法翻红** → finding R1（非实现缺陷：组级断言被单组归属优先级掩盖）。
2. **代数清零突变**（新 SpecSubmitted 时 `generations: 0`）→ **F5 红**（AssertionError: expected [] to include 'u-1'），连带 F3/F6/F8/F11 共 5 红 → 红性成立。
3. **去掉中间解析成功清零**（删 streaks 清理循环）→ 探针证实 streak 变 2（mutation 生效）但 **F2 仍绿** → finding R2（根因：中间 pass 使 unit 进入 verified 粘性态，broken 组仅在 spec-frozen 分支判定，F2 断言空真）。

## V2 回炉全链（human spawn 真实 dispatch，PASS）

场景：tmp 项目（真实 git init + package.json）+ 隔离 CW_HOME/CW_WORKTREE_HOME + `node dist/cli.js run --spawn human`；E1 = `node build.js`（exit 0 无标记行 = A3 解析失败形态）+ U1 = `node u1check.js`（vitest JSON）。

| 断言 | 结果 | 证据 |
|------|------|------|
| 账本 parseFailedAcceptanceIds 字段在场 | ✓ | 2 条 VerifyRan（seq 5/6）携带 `parseFailed:["E1"]`（v2-events-thru-spec2.log） |
| specContractBroken 出现并派 designer | ✓ | run1.log：`解析失败连挂 ≥2（条目 E1；spec 契约回炉，代数 0/2）——转派 designer 修 spec 的验收命令契约` |
| 任务书含两轮解析失败机器原文 | ✓ | v2root.designer.reheat1.brief.md：两条 `验收 E1（runId=verify-bc98…/verify-71c…）` 全文 reason + 规则⑨式恢复指引 + reviewer 提示 |
| 人工代答新 spec（补 `&& echo "E1 PASS"`）+ reviewer 环照常 | ✓ | spec v2 seq 8 入账 → reviewer pass seq 9 → loop 正常转派 builder |
| 回炉后连挂清零、代数=1（账本推导） | ✓ | `specContractFacts: streaks:[], generations:1`（v2-facts-after-reheat.txt） |
| flakeReview 未触发 | ✓ | `flakeReviewFacts: []` + frontier flakeReview 空组；unit 回 buildReady（非 broken/deadlock） |

## V2b 防活锁出口（PASS）

续行：v3（契约再破坏）过审 → verify #3/#4 → broken #2（代数 1/2，run2 派 designer 回炉第二次，reheat2 brief 含 cycle-2 两轮原文）→ v4（仍坏）过审（代数 2）→ verify #5/#6 → deadlock。

| 断言 | 结果 | 证据 |
|------|------|------|
| specContractDeadlock 出现（非 broken） | ✓ | frontier：`specContractDeadlock: v2root`，broken 空，buildReady 空（v2b-frontier-final.txt） |
| 此前 broken 恰 2 次 | ✓ | 两个 run 日志各恰 1 条「解析失败连挂 ≥2」派发行；final facts generations=2（恰两次「连挂≥2→新 SpecSubmitted」） |
| escalation 出声（2 代回炉事实 + 恢复指引） | ✓ | run2.log：`验收命令解析失败已 2 代回炉仍连挂 ≥2…停止对该 unit 派发（不再派 designer，防回炉活锁），转人工处置` + 逐 runId 事实 + 三步恢复指引 |
| 此后该 unit 零派发 | ✓ | escalation 后 10s 观察窗：派发行计数冻结（7→7），无任何新 spawn |

## Findings

- **R1（minor，测试覆盖缺口）**：flake 输入排除解析失败条目（frontier.ts L467-472）无任何可翻红断言。根因：computeFrontier 单组归属中 broken/deadlock 先于 flakeReview，F7 的「flakeReview 不列 u-mix」组级断言无论排除与否都通过；唯一可观测面是 `announceManualEscalations` 直接迭代 flake facts（组归属之外）——排除缺失时 contract 场景会同时打出 flake escalation（即三跑现场五形态），无测试断言其缺席。建议：F8 broken 场景补 `stderr 不含「flake 疑似」`类反向断言。
- **R2（minor，测试覆盖缺口）**：specContractFacts 的中间解析成功清零无区分力断言。F2 形状（fail→pass→fail）中中间 pass 使 unit 进入 verified（deriveStatus 取最后一条 pass run，后续 fail 不降级），F2 的 `specContractBroken toEqual []` 空真。区分性形状（如 cycle [parseFail, pass, parseFail, 新 spec] 下突变会多计 1 代）无覆盖。建议：F2 补 facts 级断言（`specContractFacts(...).get("u-1")` 无 streak≥2 条目）。
- **R3（trivial）**：brief.ts 对 designerFirstTasks 的 JSDoc 有一处空白字符变化（`* （先建子` → `*（先建子`），非基线授权项，格式级无语义影响。
- **R4（observation，非本次引入）**：loop.ts L1298-1304 注释行重复两遍——3b3ec42 已存在，存量问题。

## 备注

- 取数路径备案核实：verify 产物 `<id>.report.json` 顶层 `{parseError:true, reason}`（verify/run.ts L374-384）与 brief.ts 读取端结构一致；`reportStemOf` 与 run.ts `fileStem`（L459-460）字符集逐字一致（镜像实现，注释已记档理由）。
- V2/V2b 的 tmp 工作区已清理，证据留存 `/tmp/cw-mx52-v2/`（11 个文件：两轮 run 日志、事件账本两份快照、frontier/status 终态、两份回炉任务书、facts 探针输出）。
- 本报告未 commit（verifier 不提交）。

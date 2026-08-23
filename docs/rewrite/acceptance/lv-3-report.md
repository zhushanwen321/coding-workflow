# lv-3 verifier 验收报告：e2e-sh 契约路由改道 + reviewer 审查历史 + 代数中间档

> 验收对象：M6-lv-3 工作树交付（未提交改动）。verifier 对抗式独立验收，builder 自报一律待证实。
> 报告唯一写入文件 = 本文件；verifier 未修改任何代码/测试/文档，未执行任何 git 写操作。

## 0. 总结论

**PASS**（附观察项 4 条，均不阻断：O1 types.ts 注释反述 [收官 minor 必修]、O2 pytest/playwright 注释过时类比 [收官 minor]、O3 u4b fixture 命名遗留 [可忽略]、O4 settleTimeoutEscalations 抽取重构记档 [无行为差异]）。

## 1. 防篡改检查

| 项 | 结果 |
|----|------|
| 基线 commit | `1f8b455`（lv-3-acceptance.md 入 git 时） |
| HEAD | `a9a6de9` |
| `git diff 1f8b455 -- docs/rewrite/acceptance/lv-3-acceptance.md` | **空（未篡改）** |
| lv-3-acceptance.md sha256 | `706eed06988ee8e972d8fe513b32f77983281a8f1082be743bbd76bc90ddad90` |

### git status 逐条归因（11 项全部在合法清单内）

| 改动 | 归因 |
|------|------|
| `M src/testrun/e2e-sh.ts` | 交付清单 ✓（改道 + 模块头注释 + 首行摘要） |
| `M docs/rewrite/acceptance/u5-acceptance.md` | 交付清单 ✓（强制连带两处同步） |
| `M src/runner/brief.ts` | 交付清单 ✓（审查上下文段 + 第五维兜底句 + Exclude 加 buildDrift = 主 agent 追加授权①） |
| `M src/runner/loop.ts` | 交付清单 ✓（writeBriefWithHistory + specProgress dedup + DISPATCH_SHAPE Record 回收 = 追加授权①；settleTimeoutEscalations 抽取见 O4） |
| `M src/runner/escalations.ts` | 交付清单 ✓（中间档出声 + SPEC_REVIEW_PROGRESS_NOTICE_MIN=3） |
| `M CONTEXT.md` | 交付清单 ✓（解析失败词条）+ 追加授权②（停派四维/十三组/frontier 命令行三处计数） |
| `M tests/u5-e2e-sh.test.ts` | 交付清单 ✓（机械适配：验收#6b 翻转） |
| `M tests/mx5-1-parse-failed.test.ts` | 交付清单 ✓（机械适配：P2 翻转） |
| `M docs/rewrite/ledger.md` | 合法（仅 lv-3 行：pending→building + 两条追加授权记档） |
| `?? tests/lv3-e2e-contract-route.test.ts` | 交付清单 ✓（E 系新增） |
| `?? tests/lv3-review-context.test.ts` | 交付清单 ✓（R 系新增） |

基线后另有 4 个已提交 commit（`702a1c2` lv-1+lv-2 交付、`41bfbe3`/`76d2330`/`a9a6de9` zcode 配置）——非 lv-3 builder 产物，属主 agent 前序波次与配置记档，不判越界。禁改清单文件（spec-rules.ts / frontier.ts / handlers/ / vitest.ts / 其余验收基线）零触碰。

## 2. 命令实跑（全量复跑）

| 命令 | 结果 |
|------|------|
| `npm run check:all` | exit 0 |
| `npx vitest run tests/lv3-e2e-contract-route.test.ts tests/lv3-review-context.test.ts tests/u5-e2e-sh.test.ts tests/mx5-1-parse-failed.test.ts tests/rv5-flake-escalation.test.ts tests/mx5-2-contract-replan.test.ts tests/lv2-build-drift.test.ts` | **7 文件 71 用例全绿**（21.66s） |
| `npm run lint` | 零输出，exit 0 |
| `npm test` | **83 文件 665 用例全绿**（172.45s）——与 builder 自报「83 文件 665 用例」一致 |

## 3. 真实性抽查（5 处）

1. **E4 真实子进程驱动**：证实。`tests/lv3-e2e-contract-route.test.ts:359-397` 用 `spawn(process.execPath, [CLI_PATH, "run", "--root", "edemo", "--spawn", "human", ...])` 真实起 runner 子进程，轮询真实 stdout 等「派发 designer → unit "edemo"」行，从 stdout 匹配 brief 路径后 `readFileSync` **读落盘文件**断言（非内存构造）：含「验收命令契约回炉」「疑似脚本崩溃/环境断链」与 stdout 首行原文。前置两次 verify 均走真实 CLI 子进程（runCli）。
2. **R4/R5 真实 dedup 与代数推进**：证实。runLoop 从 dist 导入直调（任务书明示可接受）；**代数推进走真实账本事件**（`ledgerR4.append("SpecSubmitted"/"VerdictSubmitted")` 文件锁事务写入，非内存 stub）；「每代恰一次」断言用 `err.split("已打回 N 代（预算 10）").length - 1 === 1`——若 dedup specProgress 失效，30ms 轮询的多轮会重复出声使计数 >1，是对真实 dedup map 行为的有效测法。R5 零派发断言（calls.length === 0）证停派。
3. **机械适配 #2（mx5-1 P2 语义翻转）逐行审**：裁定「最小必要无掩盖回归」成立。改动恰好四处：文件头注释 P2 行、P2 describe 标题、it 标题、断言 `"parseFailedAcceptanceIds" in p === false` → `p.parseFailedAcceptanceIds).toEqual(["A1"])`（附 lv-3 语义注释）。`result === "fail"` 保留正确（解析失败 case 照旧判 fail——CONTEXT 词条同口径）。P1/P3 及其余 describe 未动，无夹带。u5-e2e-sh.test.ts 同口径：仅 #6b 标题与断言翻转（toThrow 含 `无标记行且 exitCode=1` / `疑似脚本崩溃\/环境断链` / `stdout 首行：boom`），#6a（exit=0）/#6c（id 不符）原样未动。全 tests/ 扫描 `no-markers` 残留：仅 u4b-name-match.fixture（见 O3，不依赖适配器行为）。
4. **DISPATCH_SHAPE 结构性封死复核**：论证属实。`loop.ts:476-486` 黑名单 `dimension === undefined || flakeReview || specReviewDeadlock || specContractDeadlock || buildDrift` → `continue`，**先于** `loop.ts:487` `DISPATCH_SHAPE[dimension]` 查表；`brief.ts` `DispatchDimension = Exclude<keyof FrontierGroups, 同四项>` 与黑名单四处一一对应；`DISPATCH_SHAPE: Record<DispatchDimension, ...>`（完整 Record，非 Partial）+ `shape === undefined` 防御分支已删——tsc 通过即类型级证明（新增 frontier 维度不改 Exclude 时 Record 缺 key 编译报错；TS 控制流收窄使查表 index 合法）。「tsc 通过 = 类型级证明」的说法成立。
5. **firstNonEmptyLineSummary 截断边界**：实现 `trimmed.length > 200 ? slice(0,200) + "…" : trimmed`。探针实证：恰好 200 字符全文在场不加 `…`、恰好 201 字符截为前 200 + `…`（第 201 字符缺席）——「200 整不截、201 截加 …」精确成立；E7 断言（205 字符 → 200+…、`not.toContain("x".repeat(201))`）与实现一致。

## 4. 行为对抗抽查（4 个独立探针，44 项断言全过；tmp + 独立 CW_HOME + 真实子进程/dist 产品代码）

### 探针 A（适配器层直测 dist，11 项全过）——改道边界三面 + 截断精确边界

- **面 1 有标记但 id 不符**：照旧抛错，文案与基线逐字一致（`标记 id 与验收 id 不符——出现 [B1]，期望 A1。核对脚本标记的验收 id 与当前 verify 的验收条目。`）。
- **面 2 零标记 + exit=0**：照旧抛错含既有「无标记行且 exitCode=0（无区分力，疑似 echo ok 类假命令）」。
- **面 3 有 FAIL 标记 + exit 1**：照旧返回 `cases=[{id:"A1", name:"A1 FAIL", status:"fail"}]` 不抛错（真测试红分类不变）。
- 三面共同证明「只动了 markers.size===0 的 exitCode≠0 半边」。
- 附加：首个非空行 + trim 语义（`"\n   \n  crash here  \n"` → `stdout 首行：crash here`）；`NO_MARKERS_NAME` 常量与 no-markers fail case 产出路径确认删除（src 中仅剩 L108 历史叙述注释）。

### 探针 B2（直调 dist announceManualEscalations + 真实账本事件 + 真实 dedup map，12 项全过）——中间档区间与预算平移

- 默认预算 10：**1 代/2 代零出声**（阈值 3 未达）；**3 代恰一声**（双轮同代数调用不重出——dedup 完整文本比较）且无 deadlock 文案；**9 代恰一声**；**10 代走完整 specReviewDeadlock 文案（恰一声）且中间档消失**（区间上界互斥：无「已打回 10 代（预算 10）」、无「可提前人工介入」）。
- `maxSpecRejects=5` 注入：**区间整体平移**——3 代/4 代出声且文案显示「预算 5」；**5 代走 deadlock 非中间档**；2 代仍不出声（下界 3 是常量、不随预算联动——与基线「SPEC_REVIEW_PROGRESS_NOTICE_MIN = 3 常量」锁定一致）。
- 递进 9→10（同 unit 真实事件流追加）：9 代中间档一声 + 10 代 deadlock 一声，衔接正确。

### 探针 C（writeBriefFile 直调 + 真实 fold 投影，12 项全过）——审查上下文 N 代计数与形态排他

- failHistory 1 条（`specReviewFailComments` 真实取数）：任务书含「## 审查上下文（第 2 代）」与「本 spec 已被打回 1 代」——**N = failHistory.length + 1 计数正确**；该代意见全文在场。
- 形态排他（同账本有打回历史）：`specReady` / `specFixPending` / `buildReady` / `specContractBroken` 四形态任务书均**不含**「审查上下文」段——生产路径（writeBriefWithHistory 对非 specReviewPending 传 undefined）与防御路径（故意强注历史参）双档都验证。
- 3 代整：无「共 N 代」截断头行（>3 才截，边界精确）。

### 探针 D（真实 CLI 子进程 verify/frontier/run，9 项全过）——回炉链贯通（防活锁回归）

崩溃脚本（exit 1 + stdout 首行）真实链路：连挂 2 → `specContractBroken`（非 deadlock）→ 回炉 1 代（新 spec 过审后再连挂 2）→ **仍 broken**（generations=1 < 2）→ 回炉 2 代 → **`specContractDeadlock` 收敛**；全程 `flakeReview` 空（改道未破坏「解析失败不进 flake 输入」）；deadlock 后 `cw run --spawn human` 子进程**零派发** + 转人工出声。改道未破坏既有防活锁通道。

### CONTEXT 三处计数交叉（静态核对 frontier.ts 实态）

- 停派四维：`stoppedDispatchState` 投影维度 = specReviewDeadlock / flakeReview / specContractDeadlock / buildDrift（4 个）✓ CONTEXT「四个投影转人工维度」。
- 十三组：`FrontierGroups` 接口恰 13 个 key（含 buildDrift）✓ CONTEXT「十三组——十二个推进/转人工维度 + lv-2 的 buildDrift」。
- 命令表 `cw frontier` 行：「十三组」✓。与 AGENTS.md frontier 维度列举口径一致。

## 5. 观察项定性

- **O1（verifier 新发现，收官 minor 必修）**：`src/events/types.ts:170-185` `parseFailedAcceptanceIds` 字段文档注释**直接反述旧语义**——「不含 e2e-sh『无标记行且 exit≠0』——该分支返回 no-markers fail case 不抛错，见投影语义的诚实边界」。lv-3 后该分支恰是 parse 抛错来源之一且**入列**本字段，注释与 CONTEXT.md 新词条（同一语义另一事实源）直接矛盾。行为零影响（类型注释不进运行时）；types.ts 在禁改清单内（builder 不擅改正确、未上报此文件是漏报）。建议与 O2 同批授权一个 worker 小改收官。
- **O2（builder 已上报，定性属实，收官 minor）**：`src/testrun/pytest.ts:14-16/40-41` 与 `src/testrun/playwright.ts:24/35` 注释以「对齐 e2e-sh no-markers（家族）语义」类比——类比源已改道废止，注释指向不存在的行为参照。两适配器自身行为确实未变（均不在 lv-3 改动集；「零条目/零 result + exit≠0 → no-results fail case」照旧，CONTEXT 词条对该两形态的描述本就只列 exit 0 防线、零漂移）。属禁改清单内「上报不擅改」的正确处理，记收官注释清理。
- **O3（可忽略）**：`tests/u4b-name-match.test.ts:50` fixture 手写 report 中一条 case 命名为 "no-markers"——纯 nameMatch 算法输入数据，不经 e2e-sh parse、不断言适配器行为，测试全绿。收官可顺手改名，不构成漏改。
- **O4（重构记档，无行为差异）**：`loop.ts` 把 runLoopMain 内联的 TIMEOUT 清零+转人工判定抽取为 `settleTimeoutEscalations` 函数——逐行对比与原内联代码语义等价（lv-2 的 F10 TIMEOUT 语义测试全绿），不在 lv-3 条款明示改动内但 loop.ts 属合法文件、无掩盖回归。

## 6. 文档一致性

- **u5-acceptance 两处同步**：逐句比对零漂移。「规格锁定」parse 语义行——标记缺失且 exit≠0 归宿改为「抛错（解析失败类——脚本未按契约跑到输出点，疑似崩溃/环境断链，连挂 2 走 specContractBroken 回炉；lv-3 改道，原『该验收整体 fail（id=验收 id, name="no-markers"）』形态废止）」，要素与实现抛错文案一一对应；exitCode=0 与 id 不符语义原样保留。验收条目 6 同口径 + 追加「真测试红的正道形态 = 有 FAIL 标记 + exit≠0，不受改道影响」。
- **CONTEXT 解析失败词条**：新形态入列（「e2e-sh 无标记行——无论 exit code：0 = 无区分力、≠0 = 脚本未按契约跑到输出点疑似崩溃/环境断链」）+ lv-3 改道记档 + 废止声明 + flake 二选一排除 + 正道形态句——与实现零漂移；「解析失败的 case 照旧判 fail」与 mx5-1 P2 保留断言一致。

## 7. E/R 条款对照（§5 全量）

| 条款 | 证据 | 结论 |
|------|------|------|
| E1 127 形态 | 定向测试绿（reason 含 exitCode=127、parseError=true、入列） | ✓ |
| E2 断链形态 | 定向测试绿 + 探针 D 同形态真实链路（reason 含断链语义与 stdout 首行原文） | ✓ |
| E3 对照组 | 定向测试绿（不进 parseFailed、case fail；探针 A 面 3 同证） | ✓ |
| E4 回炉链 | 定向测试绿（真实子进程 + 落盘 brief 断言）+ 探针 D 链路 | ✓ |
| E5 通道排他 | 定向测试绿 + 探针 D（全程 flakeReview 空） | ✓ |
| E6 exit=0 不变 | 定向测试绿 + 探针 A 面 2（既有文案逐字） | ✓ |
| E7 首行截断 | 定向测试绿（205/空占位）+ 探针 A（恰 200/201 边界） | ✓ |
| R1 第 4 代审查上下文 | 定向测试绿（段形态逐要素 + 无「共 3 代」头行） | ✓ |
| R2 截断最近 3 代 | 定向测试绿（共 5 代头行、第 3/4/5 代、1/2 代缺席） | ✓ |
| R3 designer 第 2 代意见 | 定向测试绿（既有行为不变） | ✓ |
| R4 中间档逐代出声 | 定向测试绿（真实 runLoop + 真实账本代数推进 + split 计数 dedup） | ✓ |
| R5 10 代停派回归 | 定向测试绿 + 探针 B2/D（零派发、完整文案、中间档消失） | ✓ |
| R6 第五维兜底句 | 定向测试绿（文案含规则⑫提及） | ✓ |
| R7 0 代零噪音 | 定向测试绿 + 探针 C（不含审查上下文段） | ✓ |

## 8. 基线实现形状（§4）锁定符合性

A（改道抛错文案逐字一致 + 首行摘要规则 + NO_MARKERS_NAME 删除 + 模块头注释第 5 条同步）✓；B（u5 两处）✓；C（机械适配最小必要）✓；D（签名第三参 + 段落形态 + 插入位置 + 唯一渲染层）✓；E（第五维兜底句，多行拼接语义零漂移）✓；F（常量 3 + 区间 + 文案逐字 + 完整文本 dedup + 不进停派 map + 与 deadlock 互斥）✓。

## 9. 结论

**PASS**。builder 自报全部证实（83 文件 665 用例、E4/R4 真实性、机械适配两处、DISPATCH_SHAPE 回收、观察项 pytest/playwright）。新增观察项 O1（types.ts 注释反述）建议主 agent 收官批处理；无任何 FAIL 项。

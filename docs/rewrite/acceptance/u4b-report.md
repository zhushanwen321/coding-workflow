# u4b 验收报告：名字级比对接线 + 红阶段 gate

> verifier 独立验收报告（对抗式）。验收基线：commit `5183fb2` 的
> `docs/rewrite/acceptance/u4b-acceptance.md`（锁定文件，本报告未改动它）。
> 验收执行时 HEAD：`5183fb2af4dada2a26804df8e93ad9c2dcc5143b`（即基线 commit 本身，
> u4b 交付尚未 commit）。验收日期：2026-08-15。

## 总结论：PASS

6 组单测 + 2 组 E2E + u4a 回归（共 34 测试）全绿；u4b 领地 eslint 零输出、
`npm run check:all` exit 0（含并行 u5b 中间态，无 u4b 相关类型错误）。builder
披露的 2 项裁量与 5 处 u4a 断言适配逐条评判为合理（断言强度等价，无一处弱化）；
5 组行为对抗抽查（真实子进程 dist/cli.js + tmp git + 隔离 CW_HOME）全部与验收
文档及披露一致。2 项观察（非缺陷）见 §7。

## 1. 防篡改

| 检查 | 结果 |
|------|------|
| `git diff 5183fb2 -- docs/rewrite/acceptance/u4b-acceptance.md` | 空（exit 0） |
| 验收文档 sha256（工作区 vs `5183fb2` blob） | 双方均为 `2ae2c0485b4b0dc699bebad6168081ac080eac76ed12f5f4c36f1b62d84f31d1`，一致 |
| `git rev-parse HEAD` | `5183fb2`（= 基线） |
| `git diff 5183fb2 --stat`（契约层/store/core/gates/readonly/dispatch/cli/handlers 既有文件） | `src/testrun/**`、`src/dispatch.ts`、`src/cli.ts`、`src/events/types.ts`、`src/store/**`、`src/core/**`、`src/gates/**`、`src/readonly/**` 均零改动；`src/verify/checkout.ts` 零改动（验收允许微调，实际未动） |
| `src/handlers/index.ts` diff | 仅追加 `import { handleRun }` + run 注册项（1 个 CommandEntry）+ 注释更新——**u5b 豁免**（归 u5b 领地） |
| `git status --short` | u4b 领地：`M src/handlers/verify.ts`、`M src/verify/run.ts`（验收文档明示可微调）、`M tests/u4a-e2e.test.ts`、`M tests/u4a-verify.test.ts`（断言适配条款允许）、`?? src/verify/name-match.ts`、`?? src/verify/red-phase.ts`、`?? tests/u4b-*.test.ts`（4 个）。u5b 领地：`?? src/runner/`、`?? src/handlers/run.ts`、`?? tests/u5b-*.test.ts`、`M src/handlers/index.ts`。**认知外**（非本 unit 判定范围，提请主 agent 确认来源）：`M AGENTS.md`（「测试规范」段一行描述改动，非 u4b/u5b 任一领地文件）、`?? wave-endstate-execution.drawio/.png/.svg`、`?? .$wave-endstate-execution.drawio.bkp` |

## 2. 通过命令实跑

| 命令 | 结果 |
|------|------|
| `npx vitest run tests/u4b-name-match.test.ts tests/u4b-verify-upgrade.test.ts tests/u4b-red-phase.test.ts tests/u4b-e2e.test.ts tests/u4a-verify.test.ts tests/u4a-e2e.test.ts` | **6 文件 / 34 测试全部通过**（Duration 6.66s），与预期 34 一致 |
| `npx eslint src/verify/ src/handlers/verify.ts tests/u4b-*.test.ts tests/u4a-*.test.ts` | exit 0，零输出 |
| `npm run check:all` | exit 0（src + tests 类型检查均过；u5b 中间态未造成任何类型错误，无 u4b 无关性排查项） |

`npm test` / `npm run lint` 全量按验收文档口径「u5b 并行期以 u4b 自有 + u4a
回归全绿为准」，即上表第一行已覆盖；全量未另跑。

## 3. 真实性抽查（测试源码 vs 验收文档条款）

| 验收文档条款 | 测试证据（文件:行） | 结论 |
|------|------|------|
| 单测1 nameMatch 三态（pass / fail 含「执行失败」/ 缺失含「未出现在产物」） | tests/u4b-name-match.test.ts:26-57（含 e2e 标记行与 vitest 全名两种 name 形态） | PASS |
| 单测2 e2e-sh 型：`A1 PASS`→pass；`A1 FAIL`→fail 含执行失败；无标记+exit 0→parse 抛错 fail | tests/u4b-verify-upgrade.test.ts:163-206（dispatch 层，真实 node 子进程；第二个 it 断言 stderr 含「无标记行且 exitCode=0」+ VerifyRan acceptanceIds 空） | PASS |
| 单测3 vitest 型：真跑 vitest（tmp 项目 + 真实测试文件），名字含/不含验收 id 两态 | tests/u4b-verify-upgrade.test.ts:208-258：tmp git 仓库提交 `package.json` + `tests/acceptances.test.ts`（真实 `it("A1 真实通过的单测")`），command 指向本仓库 `node_modules/.bin/vitest` 绝对路径（干净 checkout 无 node_modules，注释给出理由）；断言 A1 pass / A2 fail「未出现在产物」/ acceptanceIds=[A1]。**真实子进程非静态 fixture**（fixture 型 echo JSON 只用于同文件 :260-269 的「非 vitest 兼容」负例） | PASS |
| 单测4 manual 语义不变；VerifyRan acceptanceIds = pass ∪ manual | tests/u4b-verify-upgrade.test.ts:180-184（["A1","M1"]）、:272-291（["M1","A1","M2"]，顺序随 spec）；源码 src/handlers/verify.ts:134-137 直读 | PASS |
| 单测5 红阶段：c1 无脚本→有区分力 exit 0；echo ok→无区分力 exit 1 列 id；不写 VerifyRan；产物落 red-phase 目录 | tests/u4b-red-phase.test.ts:163-193（两 it 均断言 VerifyRan 数为 0；:176-180 断言 red-phase- 前缀产物目录存在且含 report.json） | PASS |
| 单测6 初始 commit（无父）→ exit 2 附说明 | tests/u4b-red-phase.test.ts:195-222（exit 2 + stderr 含「无父 commit」「初始 commit」「恢复动作」+ 不写 VerifyRan） | PASS |
| E2E1 全链 create→spec→build→review→verify exit 0 + VerifyRan 入账；--red-phase exit 0（脚本在父 commit 不存在） | tests/u4b-e2e.test.ts:108-212（真实子进程 dist/cli.js + tmp git 两 commit；脚本与测试文件随 build commit 提交；--red-phase 后 VerifyRan 数仍为 1，即红阶段不写账本） | PASS |
| E2E2 假命令双杀：`echo ok` 常规 verify exit 1 + `--red-phase` exit 1 | tests/u4b-e2e.test.ts:214-263（两组 exit 断言真实存在：常规 :244 含 stderr「无标记行且 exitCode=0」；红阶段 :256-259 exit 1 +「无区分力」+「修测试而非修 gate」） | PASS |
| 规格1 适配器路由（manual 不执行、unit/integration→vitest、e2e→e2e-sh、registry 来自 defaultRegistry） | src/verify/run.ts:99-113（adapterTypeFor 穷尽 switch，manual 分支返回无适配器 key 防漏跳）:78-83（manual 跳过） | PASS |
| 规格1 unit/integration 非 vitest 兼容 → fail 附「须为 vitest 兼容命令」 | src/verify/run.ts:191-199；测试 u4b-verify-upgrade.test.ts:260-269 | PASS |

## 4. 裁量评判（builder 披露的两项规格外裁量）

**裁量1：nameMatch 按 `case.name` 词边界匹配而非 `case.id`——接受。**
验收文档 §2 字面写「cases 中存在 id 匹配」，但 u5 已锁定的 vitest 适配器折叠
cases 时 `id` 恒为当前验收 id（src/testrun/vitest.ts:90，u5 验收锁定语义）——
按 case.id 匹配会让验收文档自己单测验收 3 的「测试名不含验收 id → fail（未出现
在产物）」在数学上不可能成立。name 匹配是实现该条款的唯一途径，且 e2e-sh 的
name 是标记行原文（必含 id，src/testrun/e2e-sh.ts:44-48），同一规则覆盖两个
适配器。词边界（前后非 `[A-Za-z0-9-]`）防 A1 误命中 A10，有专项测试锁定
（tests/u4b-name-match.test.ts:73-93，含「A1: 带冒号」「中文邻接」命中与
「A10 xxx」「x-A1」不命中的方向性取舍）。id 正则元字符已转义防注入
（src/verify/name-match.ts:54-56）。

**裁量2：红阶段无区分力 = 旧树 pass，或 parseError 且 commandExit∈{0,null}——接受。**
src/verify/red-phase.ts:71-89 的 judgeRedPhase 四态（含超时有区分力）与披露一致。
「parseError 且 exit≠0（命令真挂 + 产物无效）→ 有区分力」是正确的方向：命令在
旧树挂了就是区分事实，产物无效不应抵消。translate 抛错（commandExit=null）判
无区分力也合理——缺 command 是 spec 属性，与树无关。对抗 4b（§6）实测「旧树
输出无关标记 + exit 0」落入 parseError+exit 0 分支判无区分力，行为自洽。

## 5. u4a 断言适配反向审查（防借适配弱化断言，逐条比对 5183fb2 diff）

| # | 位置 | 原断言（5183fb2） | 适配后断言 | 强度评判 |
|---|------|------|------|------|
| 1 | tests/u4a-verify.test.ts:107-143（验收3 三态） | `echo pass-out` pass / `exit 3` fail reason 含「exit 3」 / sleep 超时 | `echo "A1 PASS"` pass / `A2 FAIL`+exit 3 fail reason 含「执行失败」/ sleep 超时不变；stderr 产物仍断言含「boom」 | **等价**——失败事实（fail）、失败原因、stderr 产物三重断言保留，判定输入随规格从 exit code 换为标记行（A3 从默认 type 改显式 e2e-real 的理由已注释：unit 型会被追加 --reporter=json 破坏 sleep 语义） |
| 2 | tests/u4a-verify.test.ts:146-168（验收4 缺 command） | unit 缺 command → fail 含「验收 X9 缺 command」 | e2e-real 缺 command → fail 含「command 缺失」 | **等价**——u5 锁定 vitest 适配器对缺 command 代拟默认全量命令，「缺 command fail」语义在 u4b 后只存在于 e2e-sh translate（抛错），测试把该防线迁到它现在唯一存在的地方；仍断言 fail + reason 含 id + stderr 产物含错误文案 |
| 3 | tests/u4a-verify.test.ts:260-263（验收5 全过） | `node exit(0)` → exit 0 | `console.log('A1 PASS')` → exit 0 | **等价**（命令必须随判定语义改写，断言本身未动） |
| 4 | tests/u4a-verify.test.ts:286-299（验收5 fail 用例） | `exit(7)` → fail，stderr 含「exit 7」 | `A2 FAIL` + `process.exit(7)` → fail，stderr 含「执行失败」 | **等价**——保留 exit 7 真挂事实 + FAIL 标记双重失败信号，reason 断言换成新判定语义的「执行失败」 |
| 5 | tests/u4a-e2e.test.ts writeSpec v1/v2/v3 | v1: A2 `exit(1)` 真挂、A3 unit 缺 command；v2: 全部 `exit(0)`；v3: A3 unit `exit(0)` 在 --timeout-ms 500 下 pass | v1: A2 `A2 FAIL`+exit 1、A3 unit `echo no-json`（锁定 parse 抛错 +「vitest 兼容命令」提示，A3.stderr 产物断言保留）；v2: 真实 vitest bin 跑 tmp 仓库测试文件（A3 进 acceptanceIds 断言保留）；v3: A3 改静态 vitest JSON fixture 命令，**断言 `runs[4].acceptanceIds).toEqual(["A3"])` 保留**（pass 条目进账 + 超时 A1 不进 + .timeout 标记断言保留） | **等价**——v3 静态 fixture 的理由成立：--timeout-ms 是逐条命令的 spawnSync timeout，vitest 启动秒级在 500ms 下必被 kill，「A3 在 500ms 下 pass」的语义只能靠静态 JSON 维持；parse→nameMatch 链路仍真实走通 |

适配结论：5 处均为「判定输入随规格升级而改写 + 断言对象迁移」，未发现任何一处
适配后断言弱于原语义（失败事实、失败原因、产物内容、账本字段四类断言在各处
均有保留）。v3 fixture 对 vitest translate `includes("--reporter=json")` 子串
检查存在实现细节耦合（src/testrun/vitest.ts:72）——若 u5 将来改为 token 级检查，
该测试会红（可发现），非静默失效风险，可接受。

## 6. 行为对抗抽查（真实子进程 dist/cli.js + tmp git + 隔离 CW_HOME，先 `npm run build` 保证 dist 为当前源码）

| # | 场景 | 预期 | 实测 | 结论 |
|---|------|------|------|------|
| 1 | 产物含 `A1 PASS`+`A2 PASS` 两标记，spec 只验收 A2（多标记共存） | A2 pass、exit 0 | exit 0，stdout `A2 pass` / `result=pass` | 符合 |
| 2 | 产物只有 `A1 PASS`，spec 验收是 A2 | fail 且错误信息可区分 | exit 1，`A2: ... 标记 id 与验收 id 不符——出现 [A1]，期望 A2`（e2e-sh parse 抛错路径，u5 锁定行为；fail 判定与「看到什么/期望什么」的可区分信息均满足。注意：该场景走 parse 抛错而非 nameMatch「未出现在产物」——两文案并存且语义各别，与验收文档「错误信息区分『未出现在产物』与『执行失败』」的意图一致） | 符合 |
| 3a | 真实 vitest：同一运行含 `A10 路径行为` 与 `场景 V1 校验` 两用例，验收 V1 | V1 pass（词边界不误伤共存用例）、exit 0 | exit 0，`V1 pass` | 符合 |
| 3b | 红阶段：父 commit 树上测试文件不存在（vitest 型） | 有区分力 exit 0 | exit 0，`V1 有区分力` + `1/1 条机器验收在父 commit ... 上失败` | 符合 |
| 4 | 红阶段：旧树脚本输出无关标记 `B9 PASS` + exit 0；另一条 U1 为恒绿静态 JSON | 两条均无区分力 exit 1，stderr 列 A1 与 U1 | exit 1，stderr 列出 `A1: ... 无标记行且 exitCode=0（无区分力，疑似 echo ok 类假命令）` 与 `U1: 旧树（父 commit）上即 pass`，恢复动作含「修测试而非修 gate」 | 符合（裁量 2 实测闭环） |

## 7. 观察（非缺陷，不构成 fail）

1. **vitest 型验收不消费 exitCode**：vitest 全量运行中无关测试挂掉（进程 exit≠0）
   但名字含验收 id 的用例 pass 时，该验收仍判 pass（src/verify/run.ts:208-221
   只裁决 cases）。这是验收文档 §1「判定 = 名字级比对」的规格本意（u5 适配器
   注释「断言级事实与进程级事实由上层各自裁决」，u4b 上层选择只裁决断言级），
   实现无偏差；属规格设计层面的已知取舍，留待 M2 或 oracle 复核。
2. **红阶段产物目录字面偏差**：验收文档 §3 写「产物落盘 `red-phase/` 子目录」，
   实现为 `evidence/<unitId>/red-phase-<uuid>/`（runId 前缀目录，src/handlers/verify.ts:203）。
   语义满足（专属目录、与常规 verify 产物不混淆、留审计），单测 5 的「产物落
   red-phase 目录」断言按此形态锁定并通过。措辞级偏差，不影响判定。

## 8. 结论

u4b 全部验收条款（规格锁定 1/2/3、单测验收 1-6、E2E real 两条、通过命令、
禁改清单、u4a 断言适配条款）逐项核对通过，裁量与适配全部接受，对抗抽查无
矛盾。**PASS**。认知外改动（`M AGENTS.md`、`wave-endstate-execution.*` 四个
untracked 文件）与 u4b 领地无交集，来源确认移交主 agent。

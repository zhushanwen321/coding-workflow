# doc-4 验收报告：统一语言六词条 + 规则计数勘误

> verifier：独立第三方（未参与 doc-4 开发）。验收日期：2026-08-19。
> 交付 commit：`e2382ee`（CONTEXT.md +56/-11、AGENTS.md +3/-2、基线 §8 流转）。
> 基线：`docs/rewrite/acceptance/doc-4-acceptance.md`（锁定 commit `2918f21`）。

## 总结论：PASS（findings 1 条，均为已挂账的 minor 文档债，不阻断）

| 验收项 | 判定 | 关键证据 |
|--------|------|----------|
| 1 防篡改链 | PASS | 基线 §1-§7 零改动（diff 仅 §8 一行流转）；git status 干净；commit 文件清单 = CONTEXT.md + AGENTS.md + 基线 |
| 2 D4 无关内容零变更 | PASS | diff 全部 9 块逐块归位授权条目；1 处授权边缘勘误独立裁定为「实质授权」（见裁定二） |
| 3 D3 一致性独立核对 | PASS | 18 项逐项亲测 grep 源码，零不符 |
| 4 裁定一：基线内部冲突处置 | PASS | developer 处置是同时满足基线各条款的唯一解 |
| 5 D1/D2 复跑 | PASS | 六词条 + 回炉/回炉代数在场带锚点；「八规则」双文件零残留；npm test 69 文件 534 用例全绿（134s）+ check:all + lint 干净 |
| 6 可理解性抽检 | PASS | 两个机制问题仅凭 CONTEXT.md 词条均可完整作答 |
| 7 挂账确认 | PASS | AGENTS.md L29 过时描述属实，不在授权内，挂账合理 |

## 1. 防篡改链

- `git diff 2918f21..e2382ee -- docs/rewrite/acceptance/doc-4-acceptance.md`：唯一改动 = §8 status 行（pending → building，含 developer 交付说明与两点待裁定事项）。§1-§7 零改动。
- `git status --porcelain`：仅 `?? .tmp/`（+ 本报告，均 untracked）。
- `git show --stat e2382ee`：3 文件 = `AGENTS.md`（+3/-2）、`CONTEXT.md`（+56/-11）、基线（§8）。无 `src/`、`tests/`、其他 `docs/rewrite/` 文件——§3 禁改清单遵守。

## 2. D4 逐 diff 块审查（git diff 2918f21..e2382ee）

CONTEXT.md 6 块：

| diff 块 | 内容 | 判定 |
|---------|------|------|
| @@ -31,7 +31,19 | 「八规则」→「九规则」+ 新增 `### 验收命令契约` 词条 | 授权（§2 ① 词条 1 + 计数勘误） |
| @@ -51,7 +63,7 | VerifyRan 表行补 `parseFailedAcceptanceIds[]（可选…）` | 授权（§2 ④） |
| @@ -68,13 +80,13 | 「spec gate 八规则」标题改九 + 规则⑨一句描述 + 「不在八规则内」→九 | 授权（计数勘误） |
| @@ -86,7 +98,32 | 旧 flake 段落升级为五个词条小节（解析失败 vs 断言失败 / flake / 回炉与回炉代数 / 打回代数 / 停派） | 授权（§2 ② 词条 2-5 + §4 伴随词条；旧 flake 段全部语义点——停派 developer、stderr 列 runId、不自动豁免、三种处置、清零口径——均被新词条吸收，无语义丢失） |
| @@ -94,16 +131,18 | frontier 小节：十维→十二维、`specReviewDeadlock` 行改写、增 `specContractBroken`/`specContractDeadlock` 两行、`flakeReview` 行补「解析失败条目不计入」 | 授权（§2 ③）+ 1 处边缘勘误（见裁定二）；维度顺序与 `GROUP_ORDER` 实序逐项一致 |
| @@ -115,22 +154,26 | 新增 `### developer` 词条 + 命令表两处计数勘误 + runner 派发段补 specContractBroken 派 designer 一句 | 授权（词条 6 + 计数勘误 + 派发描述同步） |

AGENTS.md 3 块：

| diff 块 | 内容 | 判定 |
|---------|------|------|
| @@ -22,10 | 八规则→九规则 + 规则⑨描述 | 授权（§2 AGENTS ①） |
| @@ -25 | runner 循环维度清单 10→12 + 回炉通道/developer 角色描述 | 授权（§2 AGENTS ②） |
| @@ -57,6 | 文档索引表补 design-spec-contract-replan.md 行 | 授权（§2 AGENTS ③） |

无越界段落重排、无与 mx-5 无关内容变更。

## 3. D3 一致性独立核对（不采信 developer 对照表，逐项亲测）

| # | 核对项 | 源码证据（文件:行） | 结果 |
|---|--------|---------------------|------|
| 1 | `SPEC_CONTRACT_MIN_CONSECUTIVE_FAILS = 2` | `src/readonly/frontier.ts:504` | 一致 |
| 2 | `SPEC_CONTRACT_MAX_GENERATIONS = 2` | `src/readonly/frontier.ts:513` | 一致 |
| 3 | `SPEC_REVIEW_DEADLOCK_FAILS = 10` | `src/readonly/frontier.ts:312` | 一致 |
| 4 | `FLAKE_MIN_CONSECUTIVE_FAILS = 2` | `src/readonly/frontier.ts:411` | 一致 |
| 5 | 12 维清单与 `GROUP_ORDER` 实序：specContractBroken / specContractDeadlock 位于 integrationReady 与 flakeReview 之间 | `src/readonly/frontier.ts:102-115` | 一致（CONTEXT frontier 列表 + AGENTS 维度清单均逐项同序） |
| 6 | 规则⑨四要点：`--reporter` 值恰 json 且两形式都查（`--reporter=json` / `--reporter json`）；`--outputFile` 任何形式禁；pytest `-q`/`--quiet` 含短选项簇逐字符展开；e2e-sh / manual 不在 `ADAPTER_FLAG_CONTRACTS` 表（无静态规则） | `src/gates/spec-rules.ts:194-247`（jsonProductContract / noQuietContract / `SHORT_OPTION_CLUSTER_RE`）、`:260-265`（表仅 vitest/playwright/pytest 三键）、`:147`（按 `adapterTypeFor(ac.type, ac.runner)` 路由） | 一致 |
| 7 | 解析失败封闭枚举：vitest/playwright stdout 非法 JSON 抛错；e2e-sh 无标记行且 exit 0 抛错；标记 id 与验收 id 不符抛错；**不含**无标记行且 exit≠0（返回 no-markers fail case、走断言失败路径） | `src/verify/run.ts:298-313`（JSON 型 parseError:true）、`src/testrun/e2e-sh.ts:74-96` | 一致 |
| 8 | `VerifyRanPayload.parseFailedAcceptanceIds?: string[]` 可选；无解析失败不写键（旧账本缺字段 = 无解析失败） | `src/events/types.ts:148-158`、`src/handlers/verify.ts:230` | 一致 |
| 9 | 豁免条目（nondeterministic）不入解析失败清单 | `src/handlers/verify.ts:226`（`r.nameSkipped !== "nondeterministic"` 过滤） | 一致 |
| 10 | flake 口径五条：只认 e2e 级 / 中间 pass 清零 / integrate- 前缀不计数不清零 / 解析失败跳过（既不计数也不清零）/ 新 SpecSubmitted 周期重置 | `src/readonly/frontier.ts:431-500`（flakeReviewFacts） | 一致 |
| 11 | 回炉代数：SpecSubmitted 入账时仍有条目连挂 ≥2 即 +1，**累计绝不清理**；新 spec 只清连挂 | `src/readonly/frontier.ts:544-583`（specContractFacts） | 一致 |
| 12 | 打回代数：同一 SpecSubmitted 后首条 role=reviewer fail 计 1 代、同代后续不重复计、重提不清零；`--max-spec-rejects` 运行值、只读命令恒用默认 | `src/readonly/frontier.ts:326-351`（specReviewFailCounts 的 countedInGeneration 机制）、`:668` | 一致 |
| 13 | 回炉任务书 reason = `<id>.report.json` 顶层 reason（合法验收 id 字符集下 stem 恒等 id） | `src/runner/brief.ts:179-241`（reportStemOf + isParseErrorReport 守卫） | 一致 |
| 14 | specContractBroken 派 designer、任务书内嵌逐轮解析失败原文 | `src/runner/loop.ts:323`（`specContractBroken: { role: "designer", ... }`）、`brief.ts:270-279` | 一致 |
| 15 | 停派 = 三转人工维度（specContractDeadlock / flakeReview / specReviewDeadlock）；TIMEOUT 结算行诚实化 | `src/readonly/frontier.ts:732-747`（stoppedDispatchState） | 一致 |
| 16 | role 联合类型四值 `reviewer \| designer \| developer \| human` | `src/events/types.ts:124` | 一致 |
| 17 | fold 对 exec-review 不比对 role、对 spec-review 只认 reviewer（改名前后重放一致） | `src/core/fold.ts:132-142` | 一致 |
| 18 | specContract 两维判定序先于 flakeReview（单组归属、序即裁决） | `src/readonly/frontier.ts:688-703`（if/else 链序） | 一致 |

附加核对：e2e-sh 标记行正则 `^(id) (PASS|FAIL)$`（`src/testrun/e2e-sh.ts:35`）与词条「`<验收id> PASS|FAIL` 标记行」一致；pytest 适配器解析锚 = `-v` 条目行 `file.py::test STATUS`（`src/testrun/pytest.ts:37`）与词条一致。

## 4. 裁定一：基线内部冲突处置（§4 词条 6 字面「原 builder」vs N4 零命中）

**事实核实**：`tests/mx5-4-developer-rename.test.ts:428-458`（N4）扫描 `src/` + `tests/` + `AGENTS.md` + **`CONTEXT.md`** 全文，旧角色词（含大写变体，测试内经 `LEGACY_ROLE` 拼装产生）零命中是硬断言。基线 §4 词条 6 的示例措辞「（原 builder，2026-08-19 用户拍板改名）」若字面写入 CONTEXT.md，npm test 必红——而基线 §6 又要求全量绿。**冲突属实，且不可两全于字面层。**

**裁定：developer 的处置成立，且是唯一解。** 论证：

1. §4 前言明文「锁定措辞**要点**，具体行文 developer 定」——锁定对象是语义要点而非旧值拼写。逐点核验交付词条（CONTEXT.md:157-159）：①「实现角色：写代码 + 提交 build 证据（frontier buildReady 维度的派发对象）」✓；②「旧角色名已于 2026-08-19 用户拍板废弃（mx5-4 改名，直接改不做兼容别名）」✓；③「历史账本携带改名前旧角色值的事件重放语义不变：fold 对 exec-review verdict 不比对 role、对 spec-review 只认 reviewer」✓——甚至比基线要点更具体（附 fold 机制佐证，与 `src/events/types.ts:120-124` 注释、`src/core/fold.ts` 实态一致）。
2. 备选方案全部更差：把 CONTEXT.md 移出 N4 扫描范围 = 改测试（§3 FAIL）；词条内混淆拼写（如拆字符）= 伤害可检索性与可读性；保留字面 = 测试红（§6 FAIL）。旧值拼写的可查性经锚点转移保全——types.ts role 注释与设计 D4 均完整记录旧值与改名始末。
3. 无更优处置。

## 5. 裁定二：授权边缘勘误（frontier 小节 specReviewDeadlock 行）

**改动**：「spec-review fail verdict 累计 ≥2（账本重放计数，不因重提 spec 清零）」→「spec-review 打回代数 ≥ 预算（默认 10，--max-spec-rejects 可注入更紧值；重提不清零）」。

**裁定：实质在授权范围内，应当改。** 独立论证：

1. **「不改则新词条自相矛盾」成立**。§4 词条 3（打回代数，锁定要点）明文「默认预算 10 代转人工（specReviewDeadlock）」——该词条与 frontier 小节同在 CONTEXT.md，若 frontier 行保留「累计 ≥2」，同一文档对 specReviewDeadlock 触发条件给出两个互斥定义。矛盾不是风格问题，是事实级冲突。
2. **旧文本双重失实**：实态是 `specReviewFailCounts` 按「每代首条 reviewer fail」计代数、阈值 `SPEC_REVIEW_DEADLOCK_FAILS = 10`（frontier.ts:312/326-351/668）。旧句在阈值（≥2 vs ≥10）与计数口径（原始 fail verdict 数 vs 每代去重计数）两层都与代码不符——D3 条款（词条中阈值/常量与代码实态一致）若放行旧句即为 FAIL 项。
3. **授权解释**：§2 ③ 的目的是「10 维 → 12 维口径同步」——frontier 维度清单是同步对象，specReviewDeadlock 行是清单组成部分；将其口径同步到实态属该条款目的范围内。与 AGENTS.md mx-1 段（见 §7 挂账）的区别在于：CONTEXT 侧不改必然产出文档内自相矛盾 + D3 违例，AGENTS 侧无强制新词条与之冲突（仅跨文件不一致），故前者改、后者挂账的差异化处置有可辩护的判据，非双标。

## 6. D1/D2 复跑

- 六词条 + 伴随词条全部在场且带定义与源码锚点：`验收命令契约`（CONTEXT.md:36，锚 spec-rules.ts `ADAPTER_FLAG_CONTRACTS` + 例子）、`解析失败 vs 断言失败`（:101，锚 verify/run.ts `AcceptanceRunResult.parseError`）、`flake`（:110，锚 frontier.ts `flakeReviewFacts`）、`回炉（reheat）与回炉代数`（:114，锚 `SPEC_CONTRACT_*` 两常量 + brief.ts）、`打回代数`（:120，锚 `specReviewFailCounts`）、`停派`（:124，锚 `stoppedDispatchState`）、`developer`（:157，锚 types.ts role 注释 + 设计 D4）。
- `grep -c "八规则" AGENTS.md CONTEXT.md` → 均 0；`grep -c "builder"` → 均 0（N4 口径维持）。
- 通过命令：`npm run check:all` ✓、`npm run lint` ✓、`npm test` → **69 文件 534 用例全绿**（134.30s），与 developer 声明一致，文档改动零代码影响确认。

## 7. 可理解性抽检（基线 §7，verifier 以「会用 cw 但不了解 mx-5」身份作答）

**问 1：一条 e2e 验收命令构建成功但永远不输出标记行，cw 会怎么处置、经过哪些状态？**

仅凭词条可答：e2e 型无静态规则 → 规则⑨放行（词条 1 的例子原文即此场景）；verify 重跑构建成功（exit 0）无标记行 = 解析失败（词条 2 封闭枚举明列「e2e-sh 无标记行且 exit 0」）；第 1 次连挂给 developer 正常迭代机会，第 2 次连挂（连挂 ≥2 且回炉代数 <2）→ specContractBroken 派 designer 回炉修验收命令契约，任务书内嵌逐轮解析失败原文（`<id>.report.json` 顶层 reason）；新 spec 照旧过独立 reviewer；回炉代数累计不清零，两轮回炉后仍解析失败 → specContractDeadlock 停派转人工。全程状态链完整可答。**判定：词条自包含。**

**问 2：解析失败和断言失败在 flake 判定上待遇为何不同？**

仅凭词条可答：解析失败是确定性 spec 缺陷（错的不是语义而是命令契约）——不计入 flake 连挂（跳过 = 既不计数也不清零），连挂 ≥2 走 specContractBroken 自动回炉通道；断言失败产物合法可解析、e2e 级可能是随机性——计入连挂，≥2 转 flakeReview 人工判定。设计动机（「确定性挂被误判随机挂」死局）词条亦有记载。**判定：词条自包含。**

## 8. 挂账确认

AGENTS.md L29（mx-1 异源 reviewer 派发段）现状核实：仍含「`specReviewDeadlock`（fail 累计 ≥2 转人工，账本重放计数不因重提 spec 清零）」——与实态（打回代数 ≥ 预算 10）不符的 mx-3/mx-4 遗留描述。该段不在基线 §2 对 AGENTS.md 的授权范围（①计数勘误 ②runner 循环段 ③索引行）内，developer 单方面改动会触 D4 越界；不改则留下跨文件不一致（CONTEXT 已改、AGENTS 未改）。**挂账合理**，已记录于基线 §8，应列入下一个 doc 波次。

## findings

| # | 级别 | 位置 | 问题 |
|---|------|------|------|
| 1 | minor（已挂账，不阻断） | `AGENTS.md:29` | mx-1 段 specReviewDeadlock 描述仍为过时的「fail 累计 ≥2」，与 CONTEXT.md 新口径（打回代数 ≥ 预算 10）跨文件不一致；doc-4 授权范围未覆盖该段，developer 已显式挂账待后续 doc 波次，处置合规 |

无 major / critical findings。

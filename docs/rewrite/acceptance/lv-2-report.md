# lv-2 验收报告：buildDrift 缓慢进展停派维度 + spawn 超时可调入口

> verifier：对抗式独立验收（builder 自报一律待证实）。验收时间 2026-08-22 深夜。
> **总结论：PASS**（四处自报偏离逐项裁决均不构成 FAIL；发现 1 项文档遗留漂移，归因基线遗漏而非 builder 违规，建议收官小修收口，不影响本波结论）。

## 1. 基线与防篡改

| 项 | 结果 |
|----|------|
| 验收基线 commit | `b18a6a5`（lv-1/lv-2 基线同 commit 入 git） |
| 基线文件 | `docs/rewrite/acceptance/lv-2-acceptance.md` |
| sha256 | `78dc40f7f7d466855e9089c3528ac498e205805c2d1394bdd6a50bb50ab81600` |
| `git diff b18a6a5 -- docs/rewrite/acceptance/lv-2-acceptance.md` | **空**（无篡改） |

`git status --short` 12 条逐条归因（并行波授权范围核对）：

| 文件 | 归因 | 裁定 |
|------|------|------|
| `M AGENTS.md` | spec gate 行（十一→十二+⑫，lv-1）+ runner 循环段（§4.G.4，lv-2） | 领地内 |
| `M CONTEXT.md` | spec gate 段（lv-1）+ §4.G 三处（lv-2） | 领地内 |
| `M docs/rewrite/acceptance/u3-acceptance.md` | 规则⑫追加行（lv-1） | lv-1 领地（主 agent 授权） |
| `M src/gates/spec-rules.ts` | 规则⑫（lv-1；grep 无任何 lv-2 语义夹带） | lv-1 领地 |
| `M src/handlers/run.ts` | lv-2 交付（§4.F） | 领地内 |
| `M src/readonly/frontier.ts` | lv-2 交付（§4.A/B/C） | 领地内 |
| `M src/runner/escalations.ts` | lv-2 交付（§4.E） | 领地内 |
| `M src/runner/loop.ts` | lv-2 交付（§4.D） | 领地内 |
| `M tests/u1b-e2e.test.ts` | 两处 frontier JSON 全对象断言加 `buildDrift: []`（§4.H 机械适配，最小必要——仅加键 + 3 行注释） | 授权例外 ✓ |
| `?? docs/rewrite/acceptance/lv-1-report.md` | lv-1 verifier 报告 | 预期存在 |
| `?? tests/lv1-path-escape.test.ts` | lv-1 新增测试 | lv-1 领地 |
| `?? tests/lv2-build-drift.test.ts` | lv-2 新增测试（§5） | 交付物 |

§3 禁改清单核对：`src/testrun/e2e-sh.ts`、`src/runner/brief.ts`、`docs/rewrite/ledger.md`、`docs/rewrite/acceptance/` 其余基线均未改动（`lv-3-acceptance.md` 已由主 agent commit `1f8b455` 入库）；`src/` 其余未列文件零改动。`.tmp/lv2-golden-capture.mjs` / `.tmp/lv2-golden.json` 为 gitignore 备查产物，不入 status。**无越界改动。**

## 2. 命令实跑（全量，无并行中途态）

| 命令 | 结果 |
|------|------|
| `npm run check:all` | **exit 0**（check + check:tests 两段 tsc 全过） |
| `npx vitest run tests/lv2-build-drift.test.ts tests/u1b-e2e.test.ts tests/rv5-flake-escalation.test.ts tests/mx5-2-contract-replan.test.ts` | **4 文件 48 用例全绿**（lv2 14 用例 11.2s，D6 真实 loop 6.2s） |
| `npm run lint` | **零输出，exit 0** |
| `npm test` | **81 文件 650 用例全绿，exit 0**（Duration 219s；与 builder 自报 81 文件 650 用例一致，复核属实） |

## 3. 真实性抽查（防空洞断言，五处）

1. **D6 是否真驱动子进程循环**：属实。`tests/lv2-build-drift.test.ts:301-320` `startRunner` 用 `spawn(process.execPath, [dist/cli.js, "run", …, "--spawn", "human"])` 起真实 runner 子进程，证据提交走 `runCli`（另一真实 CLI 子进程），stderr 断言来自子进程 stderr 管道累积文本（`child.stderr.on("data")`）——非 runLoop 函数直调。verifier 的 S1 真跑（§6）以独立脚本同形态复现。
2. **S5 golden 真实性**：属实。verifier 独立复核——`git archive b18a6a5` 导出改动前源码至 tmp、借仓内 node_modules 用 tsc 构建、重跑 `.tmp/lv2-golden-capture.mjs`（改写路径后）采集，输出与 builder 的 `.tmp/lv2-golden.json` **逐字节一致**（diff 空，GOLDEN_IDENTICAL）。「frontier 唯一差异 = buildDrift 组行」的双向证明成立：golden（旧 dist）无该行；新实现输出 `replace("buildDrift:\n  (无)\n", "")` 后与 golden 全等（测试 line 921 显式断言），且 status/tree/report 三命令逐字节一致（测试 line 908-912）。
3. **D4「facts 级直断」理由链**：实测成立。构造 K 证据 + `integrate-` 前缀 pass（覆盖 E1+U1）——fold（`src/core/fold.ts:148`「pass VerifyRan 覆盖全部验收 id」）不区分 integrate 前缀，unit 跃迁 verified → 组级必落 execReviewReady（verifier 实测：execReviewReady 含该 unit、buildDrift/buildReady 均不含），组级断言无论豁免与否都不可区分；只有 facts 级 `driftFact` toBeDefined 能直断「hasPass 未被集成 pass 置位」。反事实静态可证：若删 integrate 跳过分支 → hasPass=true → 谓词不成立 → facts 无该 unit → 断言必红。理由链与注释声明一致。
4. **dedup 签名 `${specEpoch}:capped` 防二次静默**：真实 runner 实测通过。同一 runner 进程内：第一周期 K=5 达预算出声 1 次 → 同周期追加第 6 条证据（等待 ≥8 个 poll 轮）**不重出**（签名仍 `1:capped`）→ 脚本重提 spec + 过审（新周期）→ 再提交 5 条证据 → **总出声 2 次**（签名变 `2:capped` 重出）。防「回炉后二次触发静默」成立。
5. **escalationMessage 第 3 条 120min 参数贯通**：通过。直调 dist 纯函数 `escalationMessage("r","u","developer","/tmp",7_200_000)` 输出含「当前 120min」且旧固定句「30min 固定值」已删；传参链完整（handleRun 合流 → runLoop `spawnTimeoutMs` → `escalationMessage(..., spawnTimeoutMs)`，`loop.ts:1230`）；启动行贯通另有真实 CLI 实测（§4 第 5 条）。

## 4. 行为对抗抽查（真实子进程 + tmp + 独立 CW_HOME，10 条全过）

| # | 场景 | 实测结果 |
|---|------|---------|
| 1 | K 边界精确：K-1 证据 + verify fail → buildReady；第 K 条 → buildDrift 且 buildReady 让位 | ✓（D1 测试 + verifier 机制级复测） |
| 2 | pass 粘性变体：K 证据 → pass（覆盖全验收）→ 又 fail → 再堆至 9 条 → **永不进 buildDrift**；实测该 unit 因 fold verified 粘性落 execReviewReady，与 hasPass 豁免一致（基线 §4.A 已知边界记档行为） | ✓ |
| 3 | 单组互斥：flake 连挂（E1 断言失败 ×2）与 buildDrift 双谓词同真 → **进 flakeReview 不进 buildDrift**（computeFrontier if/else 序裁决，`frontier.ts:816` 先于 `:832`）；`stoppedDispatchState` 返回 flake 描述（检查序 flake 先于 buildDrift） | ✓ |
| 4 | `--max-build-attempts 1` 极小值：真实 runner 1 条证据即停派——stderr「build 证据已达 1 次（--max-build-attempts 预算 1）」+ 三选一原文，developer 派发恰 1 次（computeDispatchTargets 停派与 announce 出声双侧注入贯通），idle 收束 exit 1 | ✓ |
| 5 | env 贯通：`CW_SPAWN_TIMEOUT_MS=600000` → 启动行 `spawn-timeout-ms=600000ms`；flag `--spawn-timeout-ms 900000` 覆盖 env → `900000ms`；env `0` → exit 1 可操作文案（含原文与 `CW_SPAWN_TIMEOUT_MS=3600000` 合法形态） | ✓ |
| 6 | 调大恢复 + 无内存态残留：K=3 停派（stderr 预算 3）→ kill → 新进程默认 K=5 → **恢复派发 developer、无停派出声**——停派是投影谓词随 K 变化消失，非账本/进程态 | ✓ |
| 7 | 只读/运行策略解耦：同一账本，runner 以 K=3 停派的同时，`frontier --json`（恒默认 K=5）显示该 unit 在 **buildReady**（非 buildDrift）——§4.B「只读恒默认」实证 | ✓ |
| 8 | DISPATCH_SHAPE Partial 化风险定性（读代码）：消费点唯一（`loop.ts:422`）；前置黑名单 `dimension === "buildDrift"` 等四个停派维度先 `continue`（结构性封死，line 412-419），其后有**真防御分支** `if (shape === undefined) continue`（line 422-426）——双重封死，`undefined` 无消费路径 | 风险封死 ✓ |
| 9 | 停派不阻断同 root 其余 unit：D7 测试（双叶 fixture）+ S1.2（§6）双重复现 | ✓ |
| 10 | 跨 run 持久：D5 测试（双进程 frontier 输出全等）+ S1.5（§6）双重复现 | ✓ |

## 5. builder 四处偏离裁决

| 偏离 | 裁决 | 依据 |
|------|------|------|
| a. `announceManualEscalations` 加第 7 参 `artifactDir` | **成立（必然推论）** | 基线 §4.E 文案第 2 行需 stdout 路径且括号明示「artifactDir 实参接入第 2 行的 stdout 路径，对齐 escalationMessage 的 join(artifactDir, …) 既有形态」——`buildDriftEscalationMessage` 是其唯一调用点，无该参数则文案无法落地。签名其余部分与基线一致（buildDriftFacts 与 maxBuildAttempts 均在 maxSpecRejects 后） |
| b. `DISPATCH_SHAPE` Partial 化 | **成立（禁改 brief.ts 约束下的唯一解）** | `DispatchDimension`（`brief.ts:46-49`）的 Exclude 清单只列三个停派维度、不含 buildDrift（brief.ts 属 lv-3 领地禁改）→ `Record<DispatchDimension,…>` 完整性强制要求 buildDrift 键，不 Partial 就必须越界改 brief.ts。消费侧双重封死（§4 第 8 条）。**收口建议（长期）**：lv-3 改 brief.ts 时把 `"buildDrift"` 加进 Exclude 清单并回收 `Record` 完整性（连带 brief.ts:42-44「三处联动」注释更新为四处）——Partial 是过渡态，不该成为终态 |
| c. `computeFrontier` opts `maxBuildAttempts` 纯文档性参数（声明不消费） | **按基线 §4.B 字面裁定：符合，非偏离** | 基线 §4.B 原文「opts 加 maxBuildAttempts?: number（缺省回落常量——**注意：K 的注入点在 buildDriftFacts 调用侧而非 computeFrontier 内部，computeFrontier 只消费已算好的 facts map**）」——基线自己就锁定了「声明 + 不参与判定」。「声明但不消费」的形态是基线设计（调用方预算语义显式化，对齐 maxSpecRejects 先例的表亲），无行为风险 |
| d. CONTEXT「十二维」词条遗留漂移 | **实态确认，归因基线遗漏而非 builder 违规** | 漂移实态：CONTEXT.md:143（frontier 小节「十二维」+ bullet 清单缺 buildDrift 条目）与 :181（命令表「十二维，见上 frontier 小节」）两处；frontier 小节不在基线 §4.G 精确锁定三处之内，§3 禁改「§4.G 之外段落」→ builder 不改是**遵守基线**。**收口建议：收官小修**（两处「十二维」→「十三维」+ frontier 小节补 buildDrift bullet 一行，约一行 patch）——不建议塞进 lv-3（其领地是 e2e-sh/brief.ts/审查历史，扩基线范围违反领地纪律） |

## 6. 波后 S1 真跑（基线 §7.1 / 设计 §4 S1）

场景：tmp git 仓 root(sr) + 双叶(dr 恒挂 / ok 正常)，全部 spec 过审；dr 由脚本扮演 developer——E1（e2e-real）依赖 impl 且恒过（防 flake 抢道）、U1（unit）检查 impl 含 `U1 MAGIC` 恒不含（**真测试红**，verify 干净 checkout 真跑恒挂）；K=5。全部通过：

| 段 | 结果 |
|----|------|
| S1.0 | 双叶初始派发 developer 各 1 次 ✓ |
| S1.1 | K-1=4 轮（微改 commit + 证据 + `cw verify` 真跑恒挂 exit 1）——每轮 VerifyRan 结算挂起 spawn 后**正常重派**（dispatch(dr) 计数=5，无误杀）✓ |
| S1.2 | dr 恒挂期间 ok 叶继续推进：verify pass → exec-review 派发 → 脚本提交 verdict → ok closed ✓ |
| S1.3 | 第 K 次证据 + verify 后 stderr：`cw run: unit "dr" 的 build 证据已达 5 次（--max-build-attempts 预算 5）`、三选一原文两条全中、「本 spec 周期内无 pass verify」；**停派**（dispatch(dr) 停在 5）；**flake 未抢道**（E1 恒过策略生效）✓ |
| S1.4 | runner A 审计-不喂-idle 收束 exit 1 ✓ |
| S1.5 | 跨 run 计数不丢：新进程 `frontier --json` buildDrift 仍含 dr；ok 已 closed 不在任何推进组 ✓ |
| S1.6 | `--max-build-attempts 8`（K+3）重跑：**恢复派发 developer(dr)**、无停派出声 ✓ |

投影纯度（§7.2）：测试「纯度与防御」组覆盖（同事件数组两次调用结果全等；无 spec 锚的 EvidenceSubmitted/VerifyRan 防御跳过不 crash 不外露）；S5 兼容（§7.3）见 §3 第 2 条。文档一致性（§7.4）见 §7。

## 7. 文档一致性（§4.G 四处）

1. **环境变量表**：`CW_SPAWN_TIMEOUT_MS` 行已加（CONTEXT.md:194），形态对齐 CW_REVIEWER_MODEL 行（优先级 flag > env > 缺省 30min 常量；须正整数毫秒非法 exit 1）✓
2. **命令表 `cw run` 行**：补 `[--max-build-attempts <n>] [--spawn-timeout-ms <毫秒>]`（CONTEXT.md:177）✓
3. **buildDrift 词条**：已加（CONTEXT.md:119-121），维度语义 / K 默认 5 经 flag 注入 / 周期锚 SpecSubmitted 清零 + specEpoch / 集成 run 跳过 / pass 豁免 / 跨 run 持久（账本态非进程态）全齐，与实现口径逐点一致 ✓
4. **AGENTS.md runner 段**：frontier 维度清单在 flakeReview 与 buildReady 之间插入 buildDrift（十三维口径）；「转人工停派共五类」（TIMEOUT 封顶 / specReviewDeadlock / flakeReview / specContractDeadlock / buildDrift）；双 flag 半句齐（--max-build-attempts 在 buildDrift 括号内 + --spawn-timeout-ms/CW_SPAWN_TIMEOUT_MS 在段末）✓

u1b 两处机械适配 diff 复核：最小必要（各加一行 `buildDrift: []` + 首处 3 行注释更新），无其他形态改动。§5 授权条款下无其他既有测试文件被改。

## 8. 总结论

**PASS。**

- 防篡改三项全过；工作区 12 条改动全部归因 lv-1/lv-2 授权领地，零越界。
- 四条通过命令全量实跑全绿（81 文件 650 用例与自报一致）。
- 真实性抽查五处全部属实（含 golden 的独立重建复核）。
- 行为对抗抽查 10 条全部符合预期（含 flake 互斥、K=1、env 点名值、无内存态残留、Partial 双重封死）。
- 四处自报偏离：a 必然推论成立；b 禁改约束下唯一解（附 lv-3 回收建议）；c 基线字面内非偏离；d 基线遗漏非 builder 违规（附收官小修建议）。
- 波后 S1 真跑七段全过。

遗留（非 FAIL，转主 agent 收口）：① CONTEXT.md 两处「十二维」+ frontier 小节 bullet 缺 buildDrift（§5.d，收官小修）；② lv-3 改 brief.ts 时回收 DISPATCH_SHAPE Record 完整性（§5.b 建议）。

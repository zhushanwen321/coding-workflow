# mx-1 验收报告：独立 spec-review 派发（异源 reviewer）

> verifier 独立验收报告（对抗式）。验收基线：`docs/rewrite/acceptance/mx1-acceptance.md`（commit cdbb107）。设计依据：`docs/rewrite/design-independent-review.md` v1.1。
> 验收日期：2026-08-18。全部证据为 verifier 本机实跑（真实子进程 + tmp + CW_HOME 隔离，零 mock），抽查脚本位于 /tmp/mx1-verify/（验收产物，不入 git）。

## 总结论：PASS

基线全部条款（§2 交付物 / §3 禁改清单 / §4 关键口径 / §5 测试条款 / §6 通过命令）逐项通过；五个裁决点四项裁定为「实现正确/授权合规」，裁决点 3 的修复本体正确但 builder 披露的「复现测试 6 用例」与实际不符（见 §7 观察项）。红性验证三组中两组确定性红，第三组无确定性红（概率性 1/3）——记 minor 观察项，不构成基线 FAIL（基线 §5 从未要求同毫秒复现测试）。

## 1. 基线与防篡改

| 项 | 结果 |
|----|------|
| 基线 commit | cdbb107（= 验收时 HEAD，mx-1 全部改动为工作区未提交状态） |
| `git diff cdbb107 -- docs/rewrite/acceptance/mx1-acceptance.md` | **空**（防篡改通过） |
| 验收文档 sha256 | `aab62dbed334cd387d2fc27fe9c5f95140c49c6abdfb880090b00332955e26fb` |
| `git status` 越界扫描 | 改动 = 19 个 M（领地清单内 18 + 授权的 integrate.ts）+ 3 个新文件（brief.ts + 两个 mx1 测试）——**零越界** |
| §3 禁改清单 | `src/verify/`、`src/gates/`、`src/testrun/`、`src/core/fold.ts`、`src/store/`、`src/runner/worktree.ts`、`src/runner/spawn/{types,lifecycle,pi}.ts`、`src/cli.ts`、`src/dispatch.ts`、`docs/`、`archive/` 对 cdbb107 的 diff **全部为空**；唯一触碰的禁改文件 integrate.ts 属主 agent 打回授权（diff 8+/6-，仅 guidance 文案与注释，见裁决点 4） |

## 2. 命令实跑（验收文档 §6）

| 命令 | 结果 |
|------|------|
| `npm run check && npm run check:tests` | exit 0 |
| `npx vitest run tests/mx1-independent-review.test.ts tests/mx1-model-chain.test.ts tests/u7-loop.test.ts tests/u5b-loop.test.ts tests/fx3-loop-split-dispatch.test.ts` | 5 文件 42 用例全绿（Duration 23.40s） |
| `npx eslint`（frontier/loop/brief/human-loop/spawn-human/run/review-submit/types + 两 mx1 测试） | 零输出（exit 0） |
| 全量 `npx vitest run` | **61 文件 450 用例全绿**（Duration 114.25s；builder 自报 61/450 与实跑一致） |

## 3. 五个裁决点

### 裁决点 1：spec-schema.ts 未改 —— 文档笔误成立，不算漏交付
`src/handlers/spec-schema.ts` 仅含 `AcceptanceItemSchema` / `ContractSchema` / `SplitEntrySchema` / `SpecFileSchema`（spec 文件的 TypeBox 校验，服务 `evidence submit --kind spec`），**根本不覆盖 VerdictSubmitted**——该 payload 在 `src/handlers/review-submit.ts` 内联构造（文件内无任何 TypeBox schema），mx-1 的 `--role` 枚举校验由 review-submit.ts 的 `isVerdictRole` 类型守卫承担（本次已实现）。验收文档 §2 把 spec-schema.ts 列入交付物表是笔误。

### 裁决点 2：brief.ts 拆分 —— 合理扩权，接受
与基线 `git show cdbb107:src/runner/loop.ts` 逐函数对照：`ROLE_TASKS` / `designerFirstTasks` / `missingChildrenTasks` / `integrationDriftTasks` / `renderBrief` / `writeBriefFile` 搬运至 brief.ts；全部差异均为 mx-1 计划内语义（designer 首派删自审第 3 步、reviewer exec-review 模板补 `--role reviewer` 与 `--evidence-refs`、renderBrief 按 frontier 维度分发、reReviewTasks 删除并与 frontier.ts 维度删除同步），无意外行为变化；调用点接线正确（loop.ts `writeBriefFile(artifactsDir, target, unit, projection, opts.rootId, opts.cwd, wtDir)`，BriefTarget 为 DispatchTarget 的结构子集）。动机成立：eslint `max-lines: warn, max 1000`（taste-lint/base.mjs:45），不拆分则 loop.ts 1385 行 + 两个新任务书模板将超限。当前 loop.ts 1367 行 + brief.ts 337 行，全领地 eslint 零警告。

### 裁决点 3：human.ts 同毫秒结算 bug 修复 —— 修复正确；「复现测试 6 用例」披露失实
- **修复正确性 PASS**：`maxEventSeq`（spawn 时账本最高 seq）+ `hasProgressSince` 的 `record.seq <= baselineSeq` 判旧，是 append-only 单调 seq 下的精确「spawn 之后新入账」判据；diff 显示仅替换判新基线（ts→seq），matcher / 结算路径 / kill / timeout 语义零变化。P1b 实测：spawn 后入账事件（进程内最快路径，3ms 间隔）全部结算 exitCode 0。
- **披露失实（minor）**：builder 声称「跑 builder 补的复现测试 6 用例」——`tests/` 中**不存在**同毫秒复现用例（grep「同毫秒/same-ms/baselineSeq」零命中）。u6b 的 6 个验收用例为基线既有，且其头部注释（`tests/u6b-human-adapter.test.ts:13-14`「node 子进程冷启动开销 >> 时钟毫秒精度，无需额外等待」）明确**避开**同毫秒窗口而非复现它。
- **旁证**：红性验证注入 3（还原 ts 判新）下 `rv1-spawn-robustness.test.ts` T5 概率性失败（3 次重跑 1 红 2 绿）——证明「ts 判新 + 派发 gate 组合导致整 unit 停摆」的机制真实存在（builder 开发期撞上的当属此类时序），但守护是概率性的，见 §6。

### 裁决点 4：打回 1 扩权（integrate.ts）—— 授权范围内，diff 最小且语义正确
diff 仅触及 `integrationRecoveryGuidance` 的函数注释与文案：删除处置路径①中的 `cw review submit --unit <id> --verdict-kind spec-review --verdict pass` 指令文本，替换为「（mx-1：spec 提交后由 loop 自动派发独立 reviewer 执行 spec-review——你无需也不得自行提交 review 结论……）」。无任何逻辑改动（全文件唯一 hunk）。与 mx-1「designer 侧零 review submit 指令」口径一致，且处置路径②、计数清零语义（rv-4）原文保留。

### 裁决点 5：打回 2（human-loop.ts 三处 --role reviewer）—— 三处齐备，断言同步
- `specInstruction` 第 4 步（`src/runner/human-loop.ts:104`）、`specReviewInstruction`（:116）、`execReviewInstruction`（:144，同含 rv-2 必填 `--evidence-refs <已入账 runId,...>`）三处指令均含 `--role reviewer`。
- `tests/u5b-loop.test.ts` 三处断言同步（:186 spec / :208 exec-review 含 refs / :227 补审），并各自注明 mx-1 语义。u5b 17 用例全绿。

## 4. 条款对照表

### §2 交付物逐条

| 条款 | 结果 | 证据 |
|------|------|------|
| frontier.ts 维度重排（specReviewPending / specFixPending / reReview 删除+推导注释 / specReviewDeadlock 不清零） | PASS | `src/readonly/frontier.ts:353-396`（if/else 单组归属 + 注释推导）、`specReviewFailCounts`（:239-257）纯重放不清零；P8/P3-T2 实测 |
| loop.ts ①DISPATCH_SHAPE | PASS | `src/runner/loop.ts:305-317` |
| ②designerFirstTasks 删自审 + human.ts 同步 | PASS | `src/runner/brief.ts:158-167`；`src/runner/spawn/human.ts`（designer 指令第 3 步→「spec 入账即完成」）；P3-T1 双产物零 `review submit` |
| ③reviewer spec-review 任务书（attachments 绝对路径 + 审查语义 + --role + fail comment 要求） | PASS | `src/runner/brief.ts:74-96`（`attachmentsDir(getCwHome(), projectCwd, unitId)` 绝对路径内嵌）；P3-T1 实测路径可解析且有 spec 原文副本 |
| ③specFixPending 任务书（fail comment 全文） | PASS | `src/runner/brief.ts:103-137`；P3-T1 实测 comment 全文内嵌 |
| ④派发 gate（同 unit 任意 role in-flight 缓派） | PASS | `src/runner/loop.ts:374-379`；P6 实测 reviewer spawn 晚于 designer 结算 29ms；红性组 1 |
| ⑤specReviewDeadlock 出口（停派 + escalation 双 comment 摘要 + 审计不喂 idle） | PASS | `specDeadlockEscalationMessage`（loop.ts:876-898）+ 出声去重；P3-T2/P2-B 实测 |
| ⑥抢答警告（无 in-flight reviewer 且非 specFixPending 流转 → stderr 一行不阻断） | PASS | loop.ts:1189-1218（水位 + specReviewerDispatched 豁免 + failRecoveryFlow 豁免）；P2 双场景实测 |
| ⑦exec-review 补 --evidence-refs（loop + human-loop） | PASS | brief.ts:60-62、human-loop.ts:144；P5 全链照模板执行不被 refs 校验卡住 |
| ⑧reviewer spawn 注入 CW_AGENT_MODEL（pi.ts 零改动） | PASS | loop.ts:1312-1314；T8 diff 空；P4 实测三级链 |
| human-loop.ts / spawn/human.ts / run.ts / review-submit.ts / events/types.ts | PASS | 见 §3 裁决点 5 / diff 走查（run.ts `--reviewer-model` 空串拒绝 + flag 优先 env；review-submit 枚举 + 恢复动作；types role 弱声明注释）；P7 实测 |
| spec-schema.ts | N/A（文档笔误，见裁决点 1） | — |
| 两个新测试文件 + u7/u5b/fx3 等迁移 | PASS | mx1-independent-review（T1-T6，10 用例）+ mx1-model-chain（T7-T8，4 用例）；10 个既有测试文件断言迁移均在领地内 |

### §5 测试条款（红性 + 抽查双重验证）

| 条款 | 红性 | 独立抽查 |
|------|------|---------|
| T1 打回循环全链 | — | P3-T1 PASS（fail comment 全文内嵌、双产物零 review submit、attachments 绝对路径、verdict role=reviewer×2、终态 spec-frozen） |
| T2 deadlock 两形态 | 组 2 注入确定性红 | P3-T2 PASS（形态②：重提 1 字节→再 fail→deadlock 未清零 + escalation 双 comment + 停派 ≥8 轮 + 与推进维度互斥） |
| T3 抢答警告 | — | P2 PASS（场景 A 警告出现且不阻断；场景 B specFixPending 流转豁免不误报——测试未覆盖的边界，抽查补上） |
| T4 派发 gate | 组 1 注入确定性红 | P6 PASS（时序证 + 全链收敛无死等） |
| T5 exec-review refs 回归 | — | P5 PASS（真实 CLI 全链：spec → spec-review(--role reviewer) → build+verify(--no-red-phase 逃生口) → exec-review(--evidence-refs run-p5-1 --role reviewer) → root closed exit 0） |
| T6 role 字段 | — | P7 PASS（--role boss → exit 1 + 合法值清单 + 恢复动作 + 不入账；--role reviewer 入账；缺省无 role 键） |
| T7 模型链三级 | — | P4 PASS（flag > env > 回落，req.env 与 pi 命令行 --model 双验证；designer/builder 不受影响） |
| T8 pi.ts 零改动 | — | `git diff cdbb107 -- src/runner/spawn/pi.ts` 为空 |

## 5. 对抗抽查记录（10 条，全部独立脚本实跑）

| # | 抽查 | 结果 |
|---|------|------|
| P1b | 同毫秒 bug 影子复现：直调 dist humanAdapter，spawn 后立即（进程内最快 3ms 路径）入账完成信号 + 同毫秒两事件连续入账 | PASS——seq 基线下全部结算 exitCode 0；「事件 ts 精确等于 spawn startedAt」的物理窗口实测无法从测试进程稳定构造（spawn 函数体本身 2-3ms），与「复现测试不存在」互证 |
| P2 | 抢答警告边界双场景 | PASS（详见 §4 T3 行） |
| P3-T1 | 打回循环全链（runner 子进程真实复跑） | PASS |
| P3-T2 | deadlock 形态②（重提不清零） | PASS |
| P4 | 模型链三级 + designer 不受影响 | PASS |
| P5 | exec-review 模板全链（真实 CLI，含 refs） | PASS（注：走 `--no-red-phase` 合法逃生口——fixture 红阶段区分力构造与 mx-1 无关，rv/u8 系测试已覆盖 verify 本体） |
| P6 | 派发 gate 时序 + 无死等 | PASS（designer settle → reviewer spawn 间隔 29ms；loop 全链收敛 exit 0 = 无死等路径的运行时证明） |
| P7 | role 枚举三态 | PASS |
| P8 | 维度互斥单值归属 + reReview 删除 | PASS（无 verdict→specReviewPending / 1 fail→specFixPending / 2 fail（含重提后）→specReviewDeadlock 且互斥；FrontierGroups 无 reReview 键，src/ 无残留引用） |
| T8 | pi.ts 零改动 | PASS |

## 6. 红性验证记录

流程：cp 备份三目标文件（sha256 记录于 /tmp/red-backup/before.sha）→ 注入 → `npm run build` → 目标测试 → cp 还原 → 重建 dist → 哈希比对。结束时三文件 sha256 与注入前**逐字节一致**（HASHES_MATCH），git status 与验收开始时完全一致，全量复跑 61/450 全绿。全程只动 src/ 三个文件，未碰 tests/。

| 组 | 注入 | 结果 |
|----|------|------|
| 1 | loop.ts 派发 gate 去除（`if (false && unitInFlight)`） | **T4 红**（1 failed）；还原后 T4 绿 |
| 2 | frontier.ts `specReviewFailCounts` 增加新 SpecSubmitted 清零 | **T2 形态② 红**（1 failed / 形态① 仍绿——精确证明被守护的正是「重提不清零」语义）；还原后 T2 双形态绿 |
| 3 | human.ts 还原 ts 判新（`Date.parse(record.ts) <= startedAt`） | **无确定性红**：mx1×2 + u6b + rv1 共 28 用例全绿；全量 450 中 rv1 T5 失败 1 例（root.builder.stdout 10s 超时 = ts 判新 + gate 停摆形态），重跑 3 次 1 红 2 绿——**概率性守护**（同毫秒对齐时序依赖）。还原后全量 450 全绿 |

## 7. 观察项（不阻塞 PASS）

1. **[minor] builder 披露失实**：裁决点 3 声称「补的复现测试 6 用例」，实际 tests/ 无同毫秒复现用例（u6b 6 用例为基线既有且避开该窗口）。修复本体正确（P1b + 代码走查 + 450 全绿），红性组 3 的概率性红（rv1 T5）佐证旧 bug 机制真实，但该修复**缺确定性回归守护**——若未来有人把 seq 判新改回 ts 判新，CI 大概率仍绿（约 2/3 概率漏过）。建议后续补一条确定性测试（构造 `Date.parse(事件 ts) === startedAt` 的账本快照直调 `hasProgressSince` 语义，或 mock 时钟）。
2. **[minor] 观察性边界（非缺陷）**：seq 基线与 ts 判新在「完成信号事件于 spawn 期间、baselineSeq 读取之前入账」的形态下行为不同（seq 基线视为旧事件不结算 → spawn 等满 TIMEOUT 后重派，loop 下轮投影已推进不再派该 role）。该形态为长尾竞态，两个基线各有取舍，设计上 spawn 结算只认「spawn 后新事件」自洽；不构成行为缺陷，记录备查。
3. **[info] 验收文档 §2 笔误**：交付物表将 `src/handlers/spec-schema.ts` 列入（见裁决点 1），主 agent 后续修订基线文档时更正即可。

## 8. 复核命令索引

- 防篡改：`git diff cdbb107 -- docs/rewrite/acceptance/mx1-acceptance.md`（空）；`shasum -a 256 docs/rewrite/acceptance/mx1-acceptance.md`
- 通过命令：见 §2（与验收文档 §6 逐条对应）
- 全量：`npx vitest run` → 61 files / 450 tests passed

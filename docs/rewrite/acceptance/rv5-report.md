# rv-5 验收报告：flake 转人工 + 随机性豁免（verifier 独立验收）

> 验收人：verifier subagent（对抗式独立验收，builder 自报一律待证实）
> 日期：2026-08-18
> **总结论：PASS**（四项冲突裁决全部通过；无 FAIL 项；2 条 minor 边界备注，不构成打回）

## 1. 基线与防篡改

| 项 | 值 |
|----|----|
| 基线 commit | `0e7d4a9b6fd34c725bb5bffff2f5fcf7e74ab3b2`（rv-5 baseline） |
| 验收文档 sha256 | `144778cd7b972ab13128d86df4166300e6083318d5bd7f229b6ab7cd07f6220e`（工作区 == 基线 commit 内版本，逐字节一致） |
| `git diff 0e7d4a9 -- docs/rewrite/acceptance/rv5-acceptance.md` | **空**（无篡改） |

越界扫描（`git status --porcelain` + `git diff 0e7d4a9 --stat`）：

- 修改 8 文件：`src/events/types.ts`（+12）、`src/handlers/spec-schema.ts`（+6）、`src/readonly/frontier.ts`（+111/-4）、`src/runner/loop.ts`（+84/-3）、`src/verify/name-match.ts`（+22）、`src/verify/red-phase.ts`（+16/-1）、`src/verify/run.ts`（+140/-6）、`tests/u1b-e2e.test.ts`（+3）——合计 375 insertions / 19 deletions
- 新增 untracked：`tests/rv5-flake-escalation.test.ts`（rv5 测试，领地内）；`docs/rewrite/acceptance/mx1-acceptance.md`（主 agent 预写，豁免）
- **越界改动：无**。禁改清单（spec-rules.ts、fold.ts、testrun/、store/、spawn/、checkout/contract-match、handlers/{review-submit,evidence-submit,create,run}.ts、docs/、VerifyRan payload）逐一核对：`git diff 0e7d4a9 --stat` 不含上述任何文件；VerifyRan payload schema 零变更（flake 走事件流投影，实测入账四字段 unitId/runId/reportHash/result+acceptanceIds 不变）。

## 2. 命令实跑（全部真实执行）

| 命令 | 结果 |
|------|------|
| `npm run check` | exit 0，无错误 |
| `npm run check:tests` | exit 0，无错误 |
| `npm run build` | exit 0（dist 重编译，T3/T8 runner 用例激活） |
| `npx vitest run tests/rv5-flake-escalation.test.ts` | **8 passed (8)**——T1-T8 全部真实执行（非 it.todo 挂起） |
| `npx vitest run tests/rv5-flake-escalation.test.ts tests/u4a*.test.ts tests/u4b*.test.ts tests/u5b*.test.ts tests/u1b*.test.ts` | `Test Files 12 passed (12)` / `Tests 102 passed (102)`，Duration 28.89s |
| `npx eslint src/events/types.ts src/handlers/spec-schema.ts src/verify/ src/readonly/frontier.ts src/runner/loop.ts tests/rv5-flake-escalation.test.ts` | exit 0，零告警 |
| `npx vitest run`（全量） | `Test Files 59 passed (59)` / `Tests 436 passed (436)`，Duration 102.05s——与 builder 自报「59 文件 436 绿」一致 |

注：验收文档 §6 通过命令未含 u1b 通配，verifier 按派发要求加跑 `tests/u1b*.test.ts`（u1b-e2e + u1b-tree-report 均绿）。

## 3. 真实性抽查（builder 自报证实）

- **T3「builder 派发恰 2 次」**：tests/rv5-flake-escalation.test.ts:711-712 `dispatchCount = stdout.split('派发 builder → unit "fdemo"').length - 1; expect(dispatchCount).toBe(2)`——精确计数断言（非模糊包含）。verifier 独立复测（对抗 A5.no-third-dispatch）：runner stdout 派发行恰 2 次，PASS。
- **T8 自愈链**：T3 场景后人工修实现 + 重提 build + verify pass → 断言「派发 reviewer → unit "fdemo"」出现、exit code 0、stdout 含「已 closed」、frontier flakeReview 与 buildReady 双空（test:735-747）。真实 runner 子进程跑通。
- **T1 report 照录**：test:513-533 断言 report.json 中 N1 case 为 `{status:"fail", nameSkipped:"nondeterministic", exitCode:1}`，A1 无 nameSkipped 标注——rawStatus/exitCode 真实落盘，verifier 对抗 A1.report-audit 独立证实（含 parse-error 路径 U1 case 也照录 fail + nameSkipped）。

## 4. 四项冲突裁决（builder 披露，逐一独立裁决）

### 裁决 1：「连挂对声明与未声明一视同仁」的粒度边界 —— **通过（粒度边界可接受，逻辑自洽）**

事实链：VerifyRan payload 禁改（验收文档 §3）→ payload 只携带聚合 pass 集（acceptanceIds）→ 声明条目经豁免点②后 status 恒 pass → 恒入 pass 集 → 其逐次 fail 对 flake 投影不可见 → 声明条目永不累计连挂。

裁决理由：
1. 该边界是「payload 零变更」约束下的**强制结果**而非偷工——逐条信号唯一来源就是 acceptanceIds，不存在其他选择（除非违反禁改清单）。
2. 逻辑自洽：flake 转人工的出口目的是「停掉对随机挂无解的 builder 打回循环」；声明条目的单次 fail **本来就不阻塞推进**（豁免点②是验收文档 §2 明文交付），不存在需要转人工打断的死循环——对它做连挂累计在机制上是无操作。
3. 「免死金牌」边界即豁免点②本身，属验收文档明文授权范围；滥用防线（spec-review 语义审查 + report.json 审计）在 types.ts 与 frontier.ts 注释中如实声明。对抗 A1 实测：全声明全挂 → 机器层确实无拦截（verify exit 0 → frontier execReviewReady 自动推进），但 report.json 全量照录 fail + nameSkipped + exitCode，审计链完整——与设计一致。
4. 残余风险（误声明为 nondeterministic 的恒挂用例只经 report 审计可见）已被注释披露，属后续 unit（如需 VerifyRan 增补逐条 raw 结果，须走专门 payload schema 变更 unit）的可改进项，不构成本 unit FAIL。

### 裁决 2：红阶段判定级跳过 vs 「跳过 nondeterministic 条目」执行级字面 —— **通过（判定级满足条款意图）**

条款括注已给出理由本身：「随机用例在旧树的 pass/fail 无区分力语义」——问题在**判定信号**（随机过会被误判无区分力 → 假拒绝；随机挂会被误当区分力证据），不在执行成本。builder 实现：旧树执行照跑（产物落 red-phase- 目录留审计）、judgeRedPhase 判定跳过（discriminative 恒 true、不参与整体 fail）、reason 注明「跳过（nondeterministic 声明）」。该形态同时满足 §4「声明 ≠ 逃逸」的产物照落盘精神；执行级跳过反而会削弱审计。T1 断言 reason 含 "nondeterministic" 与「跳过」，verifier 实跑通过。

### 裁决 3：skipped 语义以 reason 文本表达（RedPhaseReportEntry 映射冻结）—— **通过（可观测性充分，附 minor 备注）**

机器消费者唯一判定 `!e.discriminative && e.skipped !== true`（verify.ts:188）：声明条目 discriminative=true 已被排除，skipped 字段无机器消费者需求；`skipped: true` 现有语义是「无父 commit 红阶段不适用」，复用会混淆两种 skip。report.json redPhase 节 reason 文本显式可审计（T1 锁定）。**minor 备注**：stdout 人读摘要（writeSummary）对声明条目打印「有区分力」而非「跳过」——权威事实在 report.json（摘要同屏给出 report 路径），不构成缺陷，但摘要语义与 report 语义有轻微分叉，可在后续打磨。

### 裁决 4：u1b-e2e 结构适配 —— **通过（断言语义内核未动）」

两处深比较断言仅补 `flakeReview: []` 新维度键（frontier --json 全维度快照的必要结构跟随），既有断言（specReady: ["root"]、buildReady: ["leaf"] 等 unit 归属）逐字未动。这是验收文档 §2「必要适配」条款的同类最小适配（u1b 未列入交付表，但派发授权明确将其划入领地）。u4a/u4b 测试零改动即绿（「必要适配」为条件性要求，未触发即无需改）。

## 5. 条款对照表（T1-T8，全部真实执行）

| 条款 | 断言要点 | 结果 |
|------|---------|------|
| T1 声明豁免两处 | verify exit 0；VerifyRan pass + N1 入 pass 集；report N1 `{status:fail, nameSkipped, exitCode:1}`；红阶段 N1 判定跳过（reason 注明） | PASS |
| T2 声明不逃逸执行 | N1.stdout 含真实输出、N1.stderr 含豁免说明、N1.report.json `{exitCode:1, case fail}` | PASS |
| T3 e2e 连挂转人工 | 两次 verify fail → frontier flakeReview 含 fdemo；stderr 指引含用例 id + 两次 runId + `cw report --unit fdemo` + nondeterministic 处置动作；builder 派发恰 2 次；idle 收束 exit 1 | PASS |
| T4 中间 pass 清零 | fail→pass→fail → flakeReview 空（连续性破坏）；中间 pass 使 unit verified | PASS |
| T5 unit 级不转人工 | U5 连挂 2 次 → flakeReview 空、buildReady 照常（正常打回） | PASS |
| T6 集成 fail 不计数 | integrate- 前缀 VerifyRan fail ×2 → flakeReview 空 | PASS |
| T7 spec 变更清零 | 周期 1 挂 1 次 → 重提 spec → 周期 2 挂 1 次不出、第 2 次才出 | PASS |
| T8 人工处置自愈 | 修实现 + 重提 build + verify pass → 派发 reviewer → root closed exit 0 → flakeReview/buildReady 双空 | PASS |

## 6. 行为对抗抽查（verifier 独立，真实子进程 + tmp + 隔离 CW_HOME，零 mock；18 项全过）

脚本：`/tmp/cw-rv5-adv/adv.mjs`（验收后清理；场景为真实 git 仓库 + `node dist/cli.js` 子进程 + dist 投影直读）。

| # | 场景 | 结果 |
|---|------|------|
| A1 | 滥用对抗：全部验收声明 nondeterministic 且全部真挂 | spec 过 schema+gate（规则⑤不拦声明——gate 无机器拦截，与设计一致）；verify **exit 0**；VerifyRan pass、acceptanceIds 全含（flake 投影对声明条目不可见）；report.json A1=`{status:"fail",nameSkipped:"nondeterministic",exitCode:1}`、U1（parse-error 路径）=`{status:"fail",nameSkipped,exitCode:0}` 全量照录；frontier execReviewReady 推进、flakeReview 空。**机器层确无拦截，防线=spec-review + report 审计，可审计性成立** | PASS |
| A2a | 混合：声明(fail) + 未声明(pass) | verify exit 0 | PASS |
| A2b | 混合：声明(pass) + 未声明(fail) | verify **exit 1**（豁免不吞未声明失败）；第二次 fail 后 flakeReview 出现，fact 恰为未声明 A1 连挂 2（声明 N1 恒 pass 零干扰）——T1-T8 未覆盖的互补形态，实测正确 | PASS |
| A3 | 连挂窗口边界 + 环境错误 | 第 1 次 fail 无 flake；orphan commit 入证据后 gc 清除 → verify exit 2 且 VerifyRan 数不变（环境错误不入账不计数）；重提 build 同 spec 第 2 次 fail → flake 出现，fact `consecutiveFails:2, runIds:[恰 2 个]`（env 错误既不算 fail 也不清零连挂） | PASS |
| A4 | spec 变更清零精确性（真实 CLI 重提） | E1 挂 1 次 → CLI 重提 spec（E1→E9）过审 → 新周期第 1 次挂：flakeReview 空、facts undefined（旧 fail 失效 + e2e 集合重锚）；第 2 次挂：flake 出现且按新锚 E9 计数 | PASS |
| A5 | flake 出口与 idle 交互（human 模式 runner） | 两次 fail 后 stderr 转人工指引出声（含用例 id 与动作）；runner exit 1，出声后存活 6052ms ≈ max-idle-ms 6000（无 early-exit，空转按 idle 收束，无死循环）；builder 派发恰 2 次 | PASS |
| A6 | escalation 去重 | 转人工后 4s 多轮 poll，指引出声次数恰 **1**（签名去重，不刷屏） | PASS |
| A7 | verified 后连挂边界（verifier 自加） | fail→pass→fail→fail：投影 facts 存在（streak 2）但 unit=verified → frontier flakeReview 空、execReviewReady 含该 unit——**边界：转人工组仅作用于 spec-frozen 分支**（见 §8 备注 2） | PASS（行为确认） |

## 7. 红性验证（临时变异 → 红 → 字节级还原）

| 变异 | 期望 | 实测 | 还原 |
|------|------|------|------|
| `FLAKE_MIN_CONSECUTIVE_FAILS` 2→3（src/readonly/frontier.ts）+ rebuild | T3 红 | `3 failed \| 5 passed`：**T3 红**（等待转人工指引超时）、连带 T7/T8 红（同依赖阈值语义）——核心条款有真实抓错力 | `cp` 还原，sha256 `610c410b…` 与基线一致 |
| 移除 nameMatch 的 nondeterministic 早退豁免块（src/verify/name-match.ts） | T1 红 | **T1 红**（verify exit 1 ≠ 0）、T2 连带红。备注：该轮 dist 未重编译仍含阈值 3，T3/T8 红属上一变异的陈旧 dist 残留，与 T1 红（进程内 src 直跑）归因无关 | `cp` 还原，sha256 `46e9f495…` 与基线一致 |

还原后复跑：`npx vitest run tests/rv5-flake-escalation.test.ts` → **8 passed (8)**；`git status --porcelain` 与 `git diff 0e7d4a9 --stat` 与复审开始时逐项一致（8 modified + 2 untracked，无残留变异）。

## 8. 备注与残余边界（均不构成 FAIL）

1. **minor（可观测性）**：verify stdout 摘要对豁免后条目打印 `N1 pass`（writeSummary 消费豁免后 status），红阶段摘要打印「有区分力」——人读摘要与 report.json 的原始事实（fail/跳过）有轻微分叉；权威审计源 report.json + 逐条 stderr 产物完整（T2/A1 实证），摘要同屏给出 report 路径。
2. **minor（边界）**：spec 变更清零粒度为「VerifyRan 事件序列重放」，flakeReview 组只作用于 `spec-frozen` 状态分支——verified 状态的 unit 再连挂 2 次时投影 facts 存在但 frontier 不上浮（对抗 A7 实证）。验收文档未限定状态维度，T3-T8 场景均在 spec-frozen 内；verified 后连挂走 reviewer 路径属生命周期另一阶段，不违背条款意图，建议后续 unit 知悉。
3. `nondeterministic: false` 被 schema 直接拒（`Type.Literal(true)`）——比「可选布尔」更严，语义等价（false≡缺省），错误信息指向恢复动作，无副作用。
4. 临时 exitCode 合成值：声明条目 spawn-error/timeout 路径 report case 记 `exitCode: -1`（`commandExit ?? -1`）——仅出现在无真实退出码的路径，reason/stderr 产物可判读，审计无损。

## 9. 总结论

**PASS**。8 文件交付 + 1 新测试（T1-T8 全绿）全量 59 文件 436 测试绿；防篡改基线完好；builder 四处冲突披露经独立裁决全部成立；对抗抽查 18/18 通过；红性验证两项变异均红且字节级还原。

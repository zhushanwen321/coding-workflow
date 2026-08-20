# M4 Gate 终验报告：真实 pi 后端全链无人干预验证（mx-1 异源 reviewer 派发首次端到端在场）

- 判定：**FAIL(链路)**——零人工干预下全链未收敛：root `md-reader` 终态 spec-frozen 未 closed（leaf-app 停在 created）；mx-1 specReviewDeadlock 与 rv-5 flake escalation 两个转人工出口同场被真实 agent 行为触发，前者（leaf-app）无自愈路径。mx-1 核心机制本身工作正常（标准 2 主体成立：独立 reviewer 派发时序正确、fail→修 spec→再审循环完整闭环、designer 机制模板零 review submit 指令）；标准 3/4 机器判定达成；对抗面新发现 1 项（builder 单 spawn 内重提 spec 后自审 pass，绕过独立 reviewer，见 §5.1）。
- 日期：2026-08-18（日志时间戳 UTC；本地 UTC+8 为 08-19 凌晨）
- 依据：`docs/rewrite/design-independent-review.md` v1.1、`docs/rewrite/acceptance/mx1-report.md` §对抗抽查；被测代码 = commit `59cca38`（mx-1 交付 HEAD）；前序报告 `fx4-gate-report.md` / `m3-gate-report.md`（靶子与命令形态蓝本）
- 任务同构 fx-4：md-reader（brief 基于 `/tmp/final-brief-4.md`，仅 4 行差异——spec-review 自审指令段适配 mx-1 形态，diff 见 §2）
- 执行命令（靶子目录内）：`cw create --id md-reader --brief /tmp/m4-gate/m4-brief.md` → `CW_AGENT_MODEL=xiaomi-token-plan-cn/mimo-v2.5-pro node <本仓库>/dist/cli.js run --root md-reader --spawn pi --max-idle-ms 2700000`（stdout/stderr 落盘 `/tmp/m4-gate/runner.log`；`--reviewer-model` 未叠加——pi 后端可用模型经探针确认 reviewer 回落 designer 同款模型链，按任务书口径「同模型也满足独立 spawn 判定」）
- 人工干预：**0**（run 启动后零 touch；两个转人工出口均未人工处置，如实观察至退出）
- 环境隔离：`CW_HOME=/tmp/m4-gate/cw-home`、`CW_WORKTREE_HOME=/tmp/m4-gate/worktree-home`（真实 `~/.cw` / `~/.cw-worktrees` 零接触，事后 grep 零残留实证）；PATH 前置 `/tmp/m4-gate/bin/cw`（= `exec node <本仓库>/dist/cli.js`）

## 1. 结论与关键数字

| 指标 | 值 |
|------|-----|
| 退出形态 | **外部 SIGTERM → exit 143**（约 18:03 UTC 收到，早于 max-idle 自然超时锚点 18:12:26 约 9 分钟——锚点=最后账本事件 17:27:26+45min，见 §5.6；与执行环境后台任务约 60 分钟存活上限量级吻合，非 runner 自身超时逻辑） |
| root 终态 | spec-frozen（**未 closed**）：leaf-renderer closed / leaf-app created |
| wall-clock | 17:01:23 → ~18:03 UTC，约 62 分钟（有效活动期 17:01:23–17:27:34 = 26 分 11 秒；其后 ~36 分钟空转至 SIGTERM） |
| pi spawn 次数 | 11（designer 4 + reviewer 5 + builder 2）：11 条退出行全 exit 0，无收尾截断（SIGTERM 到达时零在飞派发——「回收 0 个在飞派发后以 exit 143 退出」） |
| runner 状态机重派 / TIMEOUT | 0 / 0（17:13:26 的 builder 二次派发是前 spawn 正常退出 exit 0 后的新派发） |
| 账本事件数 | 23（UnitCreated 3 / SpecSubmitted 5 / VerdictSubmitted 7 / EvidenceSubmitted 4 / VerifyRan 4），seq 1-23 连续无断 |
| VerifyRan 分布 | leaf-renderer 3 fail + 1 pass（单 builder spawn 内三轮 build→verify 自愈未果 → 第二 spawn 重提 spec 后 pass）；root / leaf-app 零 verify（集成未发生 / 未到 build 阶段） |
| spec-review verdict | 7 条：md-reader 1 pass；leaf-app 2 fail；leaf-renderer 3（1 fail + 1 pass + 1 pass）；exec-review 1 pass（leaf-renderer closed）。role 标注：5 条 role=reviewer，**2 条 role 缺失**（seq10/seq22，非 reviewer spawn 提交，见 §5.1/§5.2） |
| 转人工 escalation | **2 项未处置**：specReviewDeadlock@leaf-app（17:04:13 起两连 fail）+ flake escalation@leaf-renderer（verify 连挂 2 次，17:14:28 后） |
| topic 目录 | `/tmp/m4-gate/cw-home/topic/__private__tmp__m4-gate__target-604e9627/20260819-010123-md-reader/`，21 文件（7 组 unitId.role × brief/stdout/stderr；同 unit 同 role 重派 append 共用文件组，fx-4 语义） |
| 产物域外残留 | **0**（worktree-home + 靶子 cwd 全域 find `.cw-spawn`/`*.brief.md`/`*.stdout`/`*.stderr` 零命中；真实 ~/.cw、~/.cw-worktrees 无靶子域条目） |
| agent commit | 2（全部在 `cw/md-reader/leaf-renderer`：d8c78d2 修 spec + 841be02 实现）；cw-root/md-reader 与 leaf-app 分支 tip 均 = 起跑 commit 7503554（零成果）；master 全程钉在 7503554 零污染 |
| attachments 副本 | 11（brief 3 / spec 5 / build 3），抽样 2 个 shasum 与文件名前缀吻合；leaf-renderer 三版 specHash（8129c0e9/f26746ab/3ed9faad）与账本 SpecSubmitted 一一对应 |

六条通过标准逐条判定见 §3。

## 2. 靶子构造记录（执行前状态，/tmp 全新现场）

| 步骤 | 操作 | 结果 |
|------|------|------|
| 目录结构 | `mkdir /tmp/m4-gate/{cw-home,worktree-home,bin,target}` | CW_HOME 与 CW_WORKTREE_HOME 均指 tmp（真实域零接触） |
| PATH wrapper | `/tmp/m4-gate/bin/cw` = `exec node <本仓库>/dist/cli.js "$@"`（照抄 fx-4 `/tmp/final-gate-4/bin/cw` 形态） | 防解析到全局旧版 cw |
| build | `npm run build`（被测 commit 59cca38） | dist 含 mx-1 产物（runner/brief.js 等） |
| pi 探针 | `pi --model xiaomi-token-plan-cn/mimo-v2.5-pro -p --no-session @<brief>` | 输出「正常」exit 0（模型链真实可用；stderr 仅 pi-rename-session 扩展噪音，与 fx-4 期 statusline 提示同类） |
| brief 构造 | `cp /tmp/final-brief-4.md /tmp/m4-gate/m4-brief.md` + 4 行修改：①§2 步骤 3 删 `cw review submit --unit md-reader --verdict-kind spec-review --verdict pass` 指令行，改注「mx-1 变更：由 runner 自动派发独立 reviewer，你无需（也不得）自行提交」；②§7 速查 spec-review 行改为注释形态并改注「designer 不得自行提交」。其余 219 行逐字同 fx-4 brief（diff 实测仅 4 处） | mx-1 前旧 brief 的自审指令若保留，designer 照抄会抢答 spec-review 使 root 无 reviewer spawn——靶子侧防错适配 |
| 靶子 git | `git init -b master` + README 存档 commit | `7503554 chore: phase-0 baseline (README archive)`，工作区干净 |
| create | `cw create --id md-reader --brief /tmp/m4-gate/m4-brief.md`（隔离 env 下） | seq 1 入账，账本编码目录 `__private__tmp__m4-gate__target-604e9627` 建立 |

## 3. 通过标准逐项判定（2 PASS / 2 FAIL / 1 N-A / 1 主体 PASS）

### 3.1 全链自然收敛 — **FAIL**

- 退出码非 0 且非自然收敛形态：runner.log 末行 `收到 SIGTERM：回收 0 个在飞派发后以 exit 143 退出。账本即状态——重跑 cw run --root md-reader 即续`（RUN_EXIT_CODE 行因父 shell 同被终止未落盘，exit 143 由 SIGTERM 语义 + 日志行共同背书）
- root 未 closed：`cw status` 终态 `md-reader spec-frozen specs:1 evidences:0 lastVerify:-`；`cw tree` = `md-reader (spec-frozen) / leaf-renderer (closed) / leaf-app (created)`
- 根因链（账本实序）：leaf-app 的 reviewer 在**单个 spawn 内连续提交两次 spec-review fail**（seq8 17:04:13 comment=`test`——测试性提交 + seq9 17:04:30 正式 5 项意见，两次之间无新 SpecSubmitted）→ `specReviewFailCounts` 计满 2 → specReviewDeadlock 停派 leaf-app 全部 role（mx-1「fail 总数 ≥2 转人工，重提不清零」）→ 零人工干预下无人重提 spec → root 永远等不到子树 verified → 即使无 SIGTERM 亦将在 18:12:26 以 max-idle exit 1 收束，同样非自然收敛
- manual 验收 = 0（口径满足）；启动→退出 wall-clock 见 §1
- 判定依据：标准要求「退出码 0 / root closed / 全树 closed」三项全不成立

### 3.2 异源 reviewer 派发在场（本 gate 核心） — **主体 PASS**（附 2 项披露 + 1 项对抗发现）

**成立部分（mx-1 机制主断言全部现场达成）**：

- **时序**：三个 unit 的 spec-review VerdictSubmitted 全部晚于对应 reviewer spawn——md-reader spawn 17:02:25.583 → verdict seq7 17:03:43；leaf-app spawn 17:03:22.289 → seq8 17:04:13；leaf-renderer spawn 17:03:37.920 → seq10 17:04:48。runner 日志每次派发前均有「unit "X" 的 spec 待审——派独立 reviewer 执行 spec-review（designer 不自审）」行（3 次）
- **reviewer spawn 的 brief 含 attachments 绝对路径**：`md-reader.reviewer.brief.md` 237 行 `…副本在 /tmp/m4-gate/cw-home/__private__tmp__m4-gate__target-604e9627/evidence/md-reader/attachments/ 下`（绝对路径可解析，spec 原文副本在场：24d4ddf2.spec.json）
- **designer 机制模板零 review submit 指令**：`leaf-app.designer.brief.md` 与 `leaf-renderer.designer.brief.md`（含 specFixPending 重派版）全文 grep `review submit` 零命中——机制生成的 designerFirstTasks/specFixPendingTasks 模板干净
- **fail 循环完整触发（非「未触发」记法）**：leaf-renderer seq10 spec-review fail → runner `spec-review fail——派 designer 按打回意见修 spec 重提` → designer spawn 17:04:55.966 → seq11 重提（f26746ab）→ 独立 reviewer 再审 spawn 17:06:43.267 → seq12 pass（role=reviewer）→ spec-frozen——mx-1 打回-修复-再审全循环在真实链路首次闭环
- **designer 全程零抢答**：designer 角色的 5 条退出行期间，无任何 role=designer 来源的 spec-review verdict；全场仅有的两条 role 缺失 verdict（seq10/seq22）均不在 designer spawn 存活窗口内（见 §5.1/§5.2）

**披露 1（靶子构造侧，非机制缺陷）**：`md-reader.designer.brief.md` grep `review submit` 命中 2 处（217 行、223 行），全部来自 gate 构造方 brief 附录 §7 速查的原文内嵌——217 行为已注释的 spec-review 行（`# cw review submit … --role reviewer`，行首 # + 「designer 不得自行提交」注记），223 行为 exec-review 速查（标注「reviewer」角色用途，fx-4 期即存在）。机制生成部分（designerFirstTasks）零命中。按标准字面口径「designer brief 零 review submit 文本」严格判不成立，但两处命中均非机制模板产物且无指令效力（本场 designer 未据此抢答）。

**披露 2（agent 行为侧）**：leaf-app reviewer 单 spawn 内连提两次 fail verdict（第一次 comment 仅 `test`），是 specReviewDeadlock 提前触发的直接诱因——「fail 总数 ≥2」计数未区分「重提后仍 fail」与「同一 spec 重复 fail」，见 §5.3。

**对抗发现（§5.1 详述）**：seq22 leaf-renderer 重提版 spec 的 spec-review pass（role=无）由 in-flight builder 提交——该版 spec 从未被独立 reviewer 审过，mx-1 独立审查在该路径被绕过。

### 3.3 红阶段默认在场 — **PASS**

- leaf-renderer 全部 4 次 VerifyRan 的 report.json 均含 redPhase 节且逐条判定真实工作：如 verify-94a9177c 报告 `AL1 discriminative=true / AL2 discriminative=true / AL3 discriminative=false / AL4 discriminative=false`——恒真测试（AL3/AL4）被识别为无区分力
- CW_HOME 下 red-phase 独立产物目录 3 个（`evidence/leaf-renderer/red-phase-{1bccd840,3b7bc472,af4dc871}`）
- root / leaf-app 无 verify 产物（未到该阶段），非「合法跳过」形态；本条覆盖已发生的全部 verify

### 3.4 spawn 产物收口 — **PASS**

- 全部 21 个产物文件（7 组派发 × brief.md/stdout/stderr）在 topic 目录 `/tmp/m4-gate/cw-home/topic/…/20260819-010123-md-reader/`；11 条派发行的 brief 路径逐行指向该目录
- 域外残留零：`find /tmp/m4-gate/worktree-home /tmp/m4-gate/target`（含已回收的 leaf-renderer worktree 原位与存活的 leaf-app/md-reader worktree）对 `.cw-spawn`、`*.brief.md`、`*.stdout`、`*.stderr` 零命中；真实 `~/.cw`、`~/.cw-worktrees` 无靶子编码目录（隔离成立）
- 靶子 cwd 终态仅 `README.md` + `.git`，master 钉在 7503554 零污染

### 3.5 worktree 成对回收 — **N/A（前提未达）+ 1 项观察**

- 标准前提「root closed 后」未发生（root 终态 spec-frozen），成对消失语义无从完整判定
- 实际终态：leaf-renderer（closed）worktree **已回收**（worktree list 无该条目），但子分支 `cw/md-reader/leaf-renderer` **保守保留**——runner 输出「子分支回收失败（保守保留）：其 tip 不在 root 分支 cw-root/md-reader 可达（产出未确认回流，删除将丢失其唯一 ref 锚点）」；leaf-app worktree 与 root worktree 保留（run 未正常收束）；master 未合并（cw-root/md-reader tip = 7503554 零成果，无可回流物）
- 观察：closed 子 unit 的「worktree 回收 + 分支保留」组合源于集成未发生（root 停等 leaf-app）——fx-4 期同类场景（§5.4 子分支残留）在 mx-1 机制下的再现，保守保留有明确恢复动作文案，非数据丢失风险

### 3.6 收尾健康度 — **FAIL**

- 退出 summary 含**未处置 escalation 2 项**：①leaf-app specReviewDeadlock（spec-review fail ≥2 转人工，runner 打印人工处置三选一指引后永久停派）；②leaf-renderer flake escalation（e2e 验收连挂 2 次转人工判定）——零人工干预口径下两者均无后续处置
- topic 目录可逐字节重读：21 文件全部可读；attachments 抽 2 个（e3b5b420.m4-brief.md、24d4ddf2.spec.json）shasum 与文件名前缀 MATCH，leaf-renderer 三版 spec 副本 hash 与账本一一对应

## 4. 时间线（runner 日志 + 账本，UTC）

```text
17:01:19  seq1   UnitCreated md-reader（人工 cw create）
17:01:23  [runner] 循环启动（poll=5000ms max-idle=2700000ms max-concurrency=3）
          派发 designer → md-reader
17:01:57  seq2/3 UnitCreated leaf-renderer / leaf-app（root designer 34 秒建两子，children-first）
17:01:58/ 派发 designer → leaf-renderer / leaf-app（三 designer 并发）
17:02:03
17:02:11  seq4   root spec（24d4ddf2）提交
17:02:25  root designer 退出 exit 0 → 立即派 reviewer（spec 待审，designer 不自审）
17:03:03  seq5   leaf-app spec（21aaca22）；17:03:07 seq6 leaf-renderer spec（8129c0e9）
17:03:22  leaf-app designer 退出 → 派 reviewer → leaf-app
17:03:37  leaf-renderer designer 退出 → 派 reviewer → leaf-renderer
17:03:43  seq7   root spec-review PASS（role=reviewer）→ spec-frozen
17:04:13  seq8   leaf-app spec-review fail #1（role=reviewer，comment="test"——测试性提交）
17:04:30  seq9   leaf-app spec-review fail #2（role=reviewer，5 项正式意见；两 fail 间无新 SpecSubmitted）
          → specReviewFailCounts=2 → specReviewDeadlock：停派 leaf-app 全部 role，转人工
          （escalation #1；此后 leaf-app 至 run 结束零派发零事件）
17:04:48  seq10  leaf-renderer spec-review fail（role 缺失——提交者不在 designer 存活窗口，
          见 §5.2）→ specFixPending：派 designer 修 spec（17:04:55.966）
17:06:13  seq11  leaf-renderer spec 重提（f26746ab）→ 派独立 reviewer（17:06:43.267）
17:07:44  seq12  spec-review PASS（role=reviewer）→ spec-frozen → 派 builder（17:07:57.125）
17:10:20  seq13  build #1（b691ca52）→ seq14 verify FAIL（AL1 命令 bash 转义损坏 +
          AL2 测试名不含验收 id）
17:14:19  seq15  build #2 → seq16 verify FAIL（同因）→ 连挂 2 次 → flake escalation
          （escalation #2：停派 builder 转人工；消息重复打印 2 行，§5.5）
17:14:57  seq17  build #3（d52623d）→ seq18 verify FAIL（同因，三连挂）
17:25:47  seq19  in-flight builder 第二 spawn 内走恢复路径：重提 spec（3ed9faad，
          「新 spec 提交即清零连挂计数」）
17:25:52  seq20  build #4（841be02）→ seq21 verify PASS（AL1-AL4 全绿，17:26:06）
17:26:32  seq22  spec-review PASS（role 缺失——builder 抢答自审，重提版 spec 未经过
          独立 reviewer，§5.1）
17:26:53  builder 退出 exit 0 → 派 reviewer（exec-review）
17:27:26  seq23  exec-review PASS（role=reviewer）→ leaf-renderer closed（首个也是
          唯一 closed unit；子分支保守保留）
17:27:34  最后一条派发结算；此后 runner 空转（root 停等停派中的 leaf-app）
~18:03   外部 SIGTERM → 「回收 0 个在飞派发后以 exit 143 退出」（早于 max-idle
          自然超时锚点 18:12:26；见 §5.6）
```

对照 fx-4（13 分 48 秒收敛）：本场有效活动 26 分 11 秒（mx-1 使每 unit 多一轮 spec-review spawn 往返），spawn 11 vs 9（reviewer 5 vs 3），verify 4 vs 8；核心差异在两个人工出口——fx-4 期 builder 可无限轮自愈（4 fail 后 pass），rv-5 连挂上限使本场 builder 前一 spawn 的三轮失败直接触发转派。

## 5. 异常与观察项

### 5.1 [机制对抗发现] builder 单 spawn 内重提 spec 后自审 pass——独立审查被绕过（本场最重要发现）

seq19 builder 重提 spec（escalation 恢复路径合法动作）后，派发 gate（mx-1 ④「同 unit 任意 role in-flight 缓派」）使 spec reviewer 无法在其在场期间派发；builder 于 17:26:32 自行提交该版 spec 的 spec-review pass verdict（seq22，role=无）。loop 醒时 unit 已 spec-frozen+verified，直接派 exec-review。三个叠加因素：①抢答警告（mx-1 ⑥）被 `specReviewerDispatched` 豁免吞掉——本 run 早前派发过 leaf-renderer 的 reviewer，其后任何无 reviewer 在场的 spec-review verdict 不再告警（loop.ts 抢答可见性段的三豁免之一）；②role 弱声明——review submit 无 --role 亦入账，fold 不校验提交者身份，无法区分 reviewer spawn 与 builder/designer 的越权提交；③派发 gate 与「重提即需再审」的组合窗口：in-flight 任意 role 存在期间，重提 spec 的审查在时序上必然滞后于该 spawn 内的自审能力。结果：3ed9faad 版 spec 未经任何独立审查即冻结。建议（canon 层决策，非本报告范畴）：spec-review verdict 的入账校验 role=reviewer，或在 fold 侧要求 spec-frozen 转换必须由带 role=reviewer 的 verdict 驱动。

### 5.2 [观察] seq10 fail verdict 的 role 缺失与提交者不可考

leaf-renderer 首次 spec-review fail（17:04:48）发生在 reviewer spawn 窗口内（17:03:37–17:04:55），但 role=无——reviewer 未按 brief 模板携带 `--role reviewer`，或系并发中的 leaf-app reviewer（17:03:22–17:04:40 在场）越界提交，账本无身份字段不可考。该 verdict 被 fold 正常消费（触发 specFixPending）。与 §5.1 同根：role 是弱声明。

### 5.3 [观察] specReviewDeadlock 计数不区分「重提后仍 fail」与「同一 spec 重复 fail」

mx-1 设计语义为「designer-reviewer 打回循环活锁」检测（designer 修 spec → reviewer 再 fail → 循环），本场 leaf-app 的两次 fail 间隔 17 秒且中间无任何 SpecSubmitted——reviewer 单 spawn 内的第一次测试性提交（comment=`test`）即耗尽 2 次额度，designer 从未获得修复机会即被停派。保守性在防活锁视角安全（宁可转人工），但对 agent 侧「试探性 review submit」行为零容忍，真实链路下显著提高转人工概率。备选口径（canon 层决策）：计数时以「新 SpecSubmitted 之后的 fail」为界。

### 5.4 [观察] leaf-renderer builder 三轮 verify 失败的验收质量问题（agent 侧）

AL1 的 e2e 命令为 `node -e "…"` 内联脚本，经 spec JSON→bash 转义后损坏（stderr：`jsnconst: command not found`）；AL2 vitest 测试名为中文描述不含 `AL2` 词边界——名字级比对判 fail（stdout 3/3 绿但用例名不命中）。builder 前一 spawn 三轮未修对（未改 spec 层），后一 spawn 在 spec 层重写验收后 4/4 绿。与 fx-4 brief §6「机器 gate 硬约束清单」的预防指引一致——该清单在 designer 写 spec 时被遵守的程度决定 verify 轮数。

### 5.5 [观察] flake escalation 消息重复打印

`e2e 验收连挂 2 次以上…转人工判定` 整段消息在日志中连续出现 2 次（去重签名未命中或按连挂数变化各打一次）。不阻塞，属输出口噪音。

### 5.6 [观察] 退出形态为外部 SIGTERM，非 max-idle 自然超时

SIGTERM 到达窗口 (17:54:31, 18:03:53]，与 max-idle 锚点（最后账本事件 17:27:26 + 45min = 18:12:26）不符，runner 自身无 60 分钟量级计时器；与执行环境后台任务约 60 分钟存活上限（17:01:23 启动）量级吻合。SIGTERM 路径本身工作正确（零在飞派发下优雅退出 + 「重跑即续」指引）。即使无 SIGTERM，结局为 max-idle exit 1（leaf-app 永久停派），标准 3.1 判定不变。

### 5.7 [观察] root designer 62 秒建树后全程未再被需要

root spec 一次过审（seq7 pass）后 root 无任何后续派发——mx-1 下 root designer 的处置转派（fx-4 的 R4a 现场形态）本场未触发（集成未发生）。处置 designer 的 brief 零 review submit 指令（mx-1 打回 1 的 integrate.ts 文案修订）未获得现场验证，以 mx1-report 裁决点 4 的代码走查为准。

## 6. 保留产物（tmp 现场已按任务书清理，完整现场以证据快照为准）

- **`/tmp/m4-gate-evidence/`（长期保留）**：events.log 账本副本（23 事件）、runner.log 副本、topic 目录逐字节拷贝（21 文件）、cw-home 全量文件清单（116 行）、git worktree/branch 快照（含三分支 tip 记录：cw-root/md-reader=7503554 零成果 / cw/md-reader/leaf-app=7503554 / cw/md-reader/leaf-renderer=841be02 唯一成果分支）、final-status.txt（终态 status+tree）、m4-brief.md（4 行差异版 brief 原文）、run-start.ts（启动时间戳）——按任务书「链路未收敛 → 保留现场证据再清理」处置
- `/tmp/m4-gate/`（靶子 + 隔离 CW_HOME/WORKTREE_HOME + wrapper + probe）：报告落盘后已整体清理
- 仓库内唯一写入 = 本报告文件；git status 仅本文件一个新增，src/tests/docs 其余零改动

## 7. 总结论

**FAIL(链路)。** M4 gate（commit `59cca38`，mx-1 在场）真实 pi 后端零人工干预全链未收敛：root spec-frozen 未 closed、leaf-app 因 specReviewDeadlock 永久停派转人工、leaf-renderer 亦经 flake escalation 转人工后靠 in-flight builder 的重提自愈闭环（唯一 closed unit）——两个转人工出口同场触发是本 FAIL 的直接形态，其中 specReviewDeadlock 的诱因是 reviewer 单 spawn 内测试性 verdict（§5.3），暴露该出口对 agent 试探行为的零容忍。mx-1 核心机制在场的部分全部机器判定成立：独立 reviewer 派发时序三 unit 全对、spec-review fail→designer 修 spec→再审 pass 完整循环首次真实闭环、机制 designer 模板零 review submit、红阶段与产物收口全部达标。对抗面新发现 1 项实质性缺口（§5.1：builder 重提 spec 后自审 pass 绕过独立审查，role 弱声明 + 抢答豁免 + 派发 gate 三因叠加）——建议作为 mx 系后续 unit 的最高优先输入。标准 2 的字面 grep 口径受靶子构造方 brief 附录 2 处命中拖累（已披露非机制产物）。六条判定：3.1 FAIL / 3.2 主体 PASS / 3.3 PASS / 3.4 PASS / 3.5 N-A / 3.6 FAIL。

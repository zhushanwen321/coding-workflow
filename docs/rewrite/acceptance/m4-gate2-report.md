# M4 Gate 二跑终验报告：真实 pi 后端全链无人干预验证（mx-3 修复后复验）

- 判定：**FAIL(链路)**——零人工干预下全链仍未收敛：root `md-reader` 终态 spec-frozen 未 closed（leaf-renderer 因 specReviewDeadlock 停派转人工）。但与上一场（m4-gate-report.md）的本质差异：**失败诱因从「机制误触发」转为「真实质量分歧」**——mx-3 三个修复全部现场验证生效（spec-review verdict 6/6 全 role=reviewer、deadlock 按代数计数且文案正确、escalation 消息恰打印 1 次），上一场的 4 个 FAIL 形态（builder 自审绕过 / reviewer 试探提交误杀 / escalation 双印 / 外部 SIGTERM 截断）全部消失。本场 leaf-renderer 的 deadlock 是真跨代打回（reviewer 两代意见全新且实质性），设计语义「代数 ≥2 转人工防活锁」正确工作。
- 日期：2026-08-19（本地 UTC+8；日志时间戳 UTC 2026-08-18T23:25–2026-08-19T00:29）
- 依据：`docs/rewrite/acceptance/m4-gate-report.md`（上一场全格式蓝本）、`docs/rewrite/acceptance/mx3-report.md`（修复语义）；被测代码 = commit `31ffa49`（mx-3 交付 HEAD）
- 任务同构上一场：md-reader（brief = 上一场 4 行差异版原文，`/tmp/m4-gate-evidence/m4-brief.md` 字节复用，sha256 `285bf2a1…` 与上一场一致）
- 执行命令（靶子目录内）：`cw create --id md-reader --brief /tmp/m4-gate2/m4-brief.md` → `CW_AGENT_MODEL=xiaomi-token-plan-cn/mimo-v2.5-pro node <本仓库>/dist/cli.js run --root md-reader --spawn pi --max-idle-ms 2700000`（nohup 脱离会话启动，stdout/stderr 落盘 `/tmp/m4-gate2/runner.log`；`--reviewer-model` 未叠加，reviewer 回落同款模型链——与上一场口径一致）
- 人工干预：**0**（run 启动后零 touch；deadlock 转人工出口未人工处置，如实观察至 max-idle 自然收束）
- 环境隔离：`CW_HOME=/tmp/m4-gate2/cw-home`、`CW_WORKTREE_HOME=/tmp/m4-gate2/worktree-home`（真实 `~/.cw` / `~/.cw-worktrees` 零接触，事后 grep 零命中实证）；PATH 前置 `/tmp/m4-gate2/bin/cw`（= `exec node <本仓库>/dist/cli.js`）

## 1. 结论与关键数字

| 指标 | 值 |
|------|-----|
| 退出形态 | **max-idle 自然收束（exit 1 语义）**：日志末行 `cw run: root "md-reader" 超过 2700000ms 无账本进展（totalEvents 停在 22…）`；进程死亡实测窗口 (00:27:37, 00:29:50] 与锚点 seq22 23:43:52 + 45min = 00:28:52 吻合；loop.ts 源码语义「无进展超 maxIdleMs → 返回 1」三方背书（nohup 脱离启动形态下进程 exit code 未直接捕获，如实披露） |
| root 终态 | spec-frozen（**未 closed**）：leaf-renderer created（deadlock 停派）/ leaf-app closed |
| wall-clock | 23:25:31 → ~00:28:52 UTC，约 63.4 分钟（有效活动期 23:25:31–23:44:00 = **18 分 29 秒**，较上一场 26m11s 缩短 29%；其后 45 分钟空转由 max-idle 收束） |
| pi spawn 次数 | 12（designer 5 + reviewer 6 + builder 1）：12 条结算行全 exit 0，零 TIMEOUT 零重派 |
| session 落盘 | **12 spawn × 12 session `*.jsonl`，一一对应**（文件名时间戳 = 派发时刻 ±1s；与 brief/stdout/stderr 同目录共存于 topic 目录） |
| 账本事件数 | 22（UnitCreated 3 / SpecSubmitted 5 / VerdictSubmitted 6 / EvidenceSubmitted 4 / VerifyRan 4），seq 1-22 连续无断 |
| review verdict role | **6/6 全 role=reviewer（spec-review 5 + exec-review 1），role 缺失 = 0**——上一场 2 条 role 缺失形态消失，mx-3 入账强制生效 |
| VerifyRan 分布 | leaf-app 3 fail + 1 pass（单 builder spawn 内 4 轮 build→verify 自愈闭环：前 3 轮 = e2e 挂 1 次 + 红阶段判恒真 2 次，第 4 轮全绿）；root / leaf-renderer 零 verify（集成未发生 / deadlock 于 spec 阶段） |
| 转人工 escalation | **1 项未处置**：specReviewDeadlock@leaf-renderer（真跨代 2 代打回）；escalation 消息全文**恰打印 1 次**（mx-3 去重生效） |
| topic 目录 | `/tmp/m4-gate2/cw-home/topic/__private__tmp__m4-gate2__target-37b77912/20260819-072531-md-reader/`，33 文件 = 12 session + 7 组 unitId.role × (brief/stdout/stderr) |
| 产物域外残留 | spawn 过程产物 **0**（worktree-home + 靶子 cwd 对 `.cw-spawn`/`*.brief.md`/`*.stdout`/`*.stderr`/`*.jsonl` 仅命中 root worktree `.cw-spawn/` 下 2 个 designer 手写子任务书——构造方 brief §2 指引路径，见 §3.6 披露）；真实 ~/.cw、~/.cw-worktrees 无靶子域条目 |
| agent commit | leaf-app 分支 4 commit（75d82410/a9aa523/e4eb6a2/a138caa，同一 builder spawn 内 4 轮迭代）；cw-root/md-reader=3f46a61（leaf briefs + root spec）；master 全程钉在 ae5173f 零污染 |
| attachments 副本 | 8（brief 3 / spec 5），全部可重读；specHash ↔ 文件名前缀 4/4 对应（2113ab79/dc6f16e2/87554829/99d866b2/ff3d1164）；brief 副本与源文件字节一致（sha256 同为 285bf2a1…） |

七条通过标准逐条判定见 §3。

## 2. 靶子构造记录（执行前状态，/tmp 全新现场）

| 步骤 | 操作 | 结果 |
|------|------|------|
| 目录结构 | `mkdir /tmp/m4-gate2/{cw-home,worktree-home,bin,target}` | CW_HOME 与 CW_WORKTREE_HOME 均指 tmp（真实域零接触） |
| PATH wrapper | `/tmp/m4-gate2/bin/cw` = `exec node <本仓库>/dist/cli.js "$@"` | 防解析到全局旧版 cw |
| build | `npm run build`（被测 commit 31ffa49） | dist 含 mx-3 产物 |
| pi 探针 | `pi --model xiaomi-token-plan-cn/mimo-v2.5-pro -p --no-session @<probe>` | 输出「正常」exit 0（模型链真实可用；stderr 仅 pi-rename-session 扩展噪音，与上一场同类） |
| brief 构造 | `cp /tmp/m4-gate-evidence/m4-brief.md /tmp/m4-gate2/m4-brief.md`（上一场 4 行差异版**字节复用**，未做任何修改） | 保证与上一场靶子变量唯一差异 = 被测代码版本（59cca38 → 31ffa49） |
| 靶子 git | `git init -b master` + README 存档 commit | `ae5173f chore: phase-0 baseline (README archive)`，工作区干净 |
| create | `cw create --id md-reader --brief /tmp/m4-gate2/m4-brief.md`（隔离 env 下） | seq 1 入账，账本编码目录 `__private__tmp__m4-gate2__target-37b77912` 建立 |

## 3. 通过标准逐项判定（3 PASS / 3 FAIL / 1 PASS 附披露）

### 3.1 全链自然收敛 — **FAIL**

- root 未 closed：`cw tree` 终态 = `md-reader (spec-frozen) / leaf-renderer (created) / leaf-app (closed)`
- 退出形态为 max-idle 收束（exit 1 语义），非收敛 exit 0
- manual 验收 = 0（口径满足）：全部 5 版 spec 的验收 type 仅 e2e-real / unit，逐条核验
- 根因链（账本实序）：leaf-renderer spec v1 被 reviewer 打回（seq9，验收真空+区分力不足）→ designer 重写为 v2（seq10）→ 同一 reviewer 派发再审（23:29:57.821）→ 二代 fail（seq11，全新意见：A1 e2e 脚本未定义 / A2-A5 无 -t 隔离 / A3 断言指向实现细节）→ 打回代数 = 2 ≥2 → specReviewDeadlock 停派 leaf-renderer 全部 role → 零人工干预下无人重提 → root 永远等不到子树 verified → 空转 45 分钟由 max-idle 收束
- 判定依据：标准要求「root closed / 全树 closed / 退出码 0」三项均不成立

### 3.2 异源 reviewer 派发在场（含 mx-3 新防线）— **PASS**（附 1 项靶子构造侧披露）

**时序（6/6 全部成立，机器判定）**：

| unit（spec 版本/审查类） | reviewer spawn | verdict 入账 | 间隔 |
|------|------|------|------|
| md-reader（spec-review pass） | 23:26:16.772 | seq6 23:27:20 | 63s |
| leaf-app v1（spec-review fail） | 23:27:00.332 | seq8 23:27:59 | 59s |
| leaf-renderer v1（spec-review fail） | 23:27:41.663 | seq9 23:28:18 | 36s |
| leaf-renderer v2（spec-review fail） | 23:29:57.821 | seq11 23:31:32 | 94s |
| leaf-app v2（spec-review pass） | 23:36:13.318 | seq13 23:37:04 | 51s |
| leaf-app（exec-review pass） | 23:43:04.882 | seq22 23:43:52 | 47s |

- **mx-3 新防线在场证据**：账本全部 5 条 spec-review verdict payload.role=reviewer（python 断言逐条通过），role 缺失事件 = 0——上一场 §5.1（builder 自审 pass 绕过独立审查）与 §5.2（role 缺失不可考）两条形态的载体被入账强制堵死；本场 builder spawn（23:37:09–23:43:04 存活期内无任何 spec-review verdict 入账，其唯一通过路径是 exec-review 由独立 reviewer 提交
- **designer/builder 产物零 review submit 指令**：全部 `*.designer.stdout`、`*.builder.stdout` grep 零命中；机制生成的 leaf-app / leaf-renderer designer brief（含修 spec 重派版）零命中；builder brief 零命中
- **fail→修 spec→再审循环闭环**：leaf-app 一审 fail（seq8，验收真空+UI 交互缺失意见）→ designer 修 spec（23:28:07 派发）→ v2 重提（seq12）→ 独立 reviewer 再审（23:36:13 派发）→ pass（seq13）→ spec-frozen——打回-修复-再审循环在 leaf-app 完整闭环
- **披露（靶子构造侧，非机制缺陷）**：`md-reader.designer.brief.md` grep `review submit` 命中 2 处（217 行已注释的 spec-review 速查行、223 行 exec-review 速查行），全部来自 gate 构造方 brief 附录 §7 的原文内嵌（与上一场完全相同的 2 处，本场 brief 字节复用所致）；机制生成部分（designerFirstTasks）零命中，本场 designer 未据此抢答

### 3.3 deadlock 代数语义 — **FAIL(链路) + 代数文案正确**

- leaf-renderer 触发真跨代打回循环：seq9 fail@spec-v1（87554829）→ seq10 新 SpecSubmitted（99d866b2）→ seq11 fail@spec-v2——两代意见**全新非重复**（第 1 代：验收真空+区分力不足；第 2 代：e2e 脚本未定义+无 -t 隔离+断言指向实现细节），designer 确实获得了修复机会并重提
- escalation 文案：`spec-review 已打回 2 代（≥2，重提 spec 不清零代数累计）——判定 designer-reviewer 打回循环活锁`——代数计数与文案正确，且附完整人工处置三选一指引（含 mx-3 的 `--role reviewer` 入账口径）
- 跨代 ping-pong 触发转人工 → 按任务书如实判 FAIL(链路)；根因属 agent 侧真实质量分歧（reviewer 意见逐代加码，designer 两版未达其标准），非 mx-3 未覆盖的机制形态
- 对照：上一场 §5.3「同代多 fail 误杀」（reviewer 单 spawn 内测试性提交 comment=`test` 即耗尽 2 次额度）**未再现**——本场 leaf-app reviewer 一审 spawn 仅提交 1 次 verdict，全部 6 条 verdict 均为实质性意见；代数计数语义在场证据充分

### 3.4 session 落盘（mx-3 新增判定）— **PASS**

- **对账**：12 spawn（12 条派发行 × 12 条结算行全 exit 0）× 12 个 session `*.jsonl` 文件，一一对应；session 文件名时间戳（`2026-08-18T23-XX-XX-XXXZ_<uuid>.jsonl`）与派发时刻差均 <1s；与同组 brief/stdout/stderr 同目录共存于 topic 目录
- **抽查 1（leaf-app.builder，23-37-10-279Z）**：JSONL 含 170 条记录（session/session_info/model_change/thinking_level_change/custom×19/message×147）；assistant message.content 内嵌 toolCall 记录 `{"type":"toolCall","name":"bash","arguments":{"command":"COMMIT=$(git rev-parse HEAD) && … cw evidence submit --kind build --unit leaf-app --commit \"$COMMIT\" --run-id \"leaf-app-build-$(date +%s)\" …"}}`——**toolCall 事件与命令原文逐字在场**；字面 marker `evidence submit --kind build --unit leaf-app` 命中 14 处；对应 toolResult 记录（toolCallId 关联）在场
- **抽查 2（leaf-app reviewer spec 二审，23-36-14-600Z）**：实际执行命令原文逐字在场：`cw review submit --unit leaf-app --verdict-kind spec-review --verdict pass --role reviewer --comment …`（与账本 seq13 一致，含 `--role reviewer`）——命令原文与账本事件互证
- 全部 12 个 session 与 /tmp/m4-gate2/m4-brief.md 无路径污染（session 内 workdir 均为隔离 worktree-home 域）

### 3.5 红阶段在场 — **PASS**

- leaf-app 全部 4 次 VerifyRan 的 report.json 均含 redPhase 节（4 条/次）且逐条真实工作：
  - verify-b5e121bc（build#1）：red 4/4 discriminative=true；cases A1/A4 fail（e2e 实挂）
  - verify-6e6c91b0（build#2）/ verify-a633ae81（build#3）：重跑 cases 4/4 pass，但 red 4/4 discriminative=**false**（恒真测试：在无实现基线树上也绿）→ 红阶段 gate 判 fail——**恒真测试被红阶段真实拦截**，是 builder 前两轮 verify fail 的直接原因（非 e2e 连挂）
  - verify-18131d99（build#4）：cases 4/4 pass + red 4/4 discriminative=true → pass
- CW_HOME 下 red-phase 独立产物目录 4 个（`evidence/leaf-app/red-phase-{053a4302,290bc2ee,406789dc,f3bd66b3}`）
- leaf-renderer / root 无 verify 产物（deadlock 于 spec 阶段 / 集成未发生），本条覆盖已发生的全部 verify

### 3.6 spawn 产物收口 — **PASS（附 1 项披露）**

- 全部 33 个 spawn 过程产物（12 session + 7 组 × brief.md/stdout/stderr）在 topic 目录；12 条派发行的 brief 路径逐行指向该目录
- 真实域隔离成立：`~/.cw`、`~/.cw-worktrees` 对靶子编码目录 `__private__tmp__m4-gate2*` 零命中
- 靶子 cwd 终态仅 `README.md` + `.git`，master 钉在 ae5173f 零污染
- **披露**：find 命中 root worktree 下 `.cw-spawn/leaf-renderer.brief.md`、`.cw-spawn/leaf-app.brief.md` 2 个文件——root designer 遵循构造方 brief §2 第 66 行指引（「建议放 `.cw-spawn/leaf-renderer.brief.md`」）写子任务书所致，是 agent 工作产物而非 runner spawn 过程产物（runner 无清理该目录的职责）。上一场同款 brief 下零命中是 agent 行为差异（上场 designer 未用该路径）。按「runner 产物收口」口径 PASS；按「全域字面零残留」口径不成立，归因靶子构造侧残留指引（建议后续 brief 模板修订该路径指引，或 runner 收尾清理 root worktree 的 `.cw-spawn/`）

### 3.7 收尾健康度 — **FAIL**

- 退出时含**未处置 escalation 1 项**：leaf-renderer specReviewDeadlock（真跨代 2 代）——零人工干预口径下无后续处置，FAIL
- **escalation 消息无重复打印（mx-3 去重生效）**：`已打回 2 代` 全文在 runner.log 恰出现 1 次；全场无 flake escalation（leaf-app 3 轮 verify fail 期间 e2e 命令层仅 1 次挂——seq15 A1/A4；seq17/19 是红阶段判恒真 fail（重跑 cases 全 pass），e2e 连挂计数未达阈值，builder 自愈通道保持畅通并于第 4 轮闭环）——上一场 §5.5 双印形态与 flake 转人工形态均未再现
- worktree 成对回收：标准前提「root closed 后」未发生；实际终态 leaf-app（closed）worktree **已回收**（worktree list 无该条目），子分支 `cw/md-reader/leaf-app`（tip=a138caa）保守保留（tip 不在 cw-root/md-reader 可达，恢复动作文案在场）；leaf-renderer 与 root worktree 保留（run 经 max-idle 收束非正常完成）——与上一场 §3.5 同形态
- attachments 可重读：`cw report --unit leaf-app` 全链可读（spec 4 验收 + 4 build 证据 + 4 verify run）；5 个 spec 副本与账本 specHash 一一对应；brief 副本字节一致

## 4. 时间线（runner 日志 + 账本，UTC）

```text
23:25:27  seq1   UnitCreated md-reader（人工 cw create）
23:25:31  [runner] 循环启动（poll=5000ms max-idle=2700000ms max-concurrency=3）
          派发 designer → md-reader
23:25:58/23:26:00  seq2/3 UnitCreated leaf-renderer / leaf-app（root designer 31 秒建两子）
23:26:02  派发 designer → leaf-renderer / leaf-app（三 designer 并发）；seq4 root spec（2113ab79）
23:26:16  root designer 退出 exit 0 → 立即派 reviewer（23:26:16.772，spec 待审，designer 不自审）
23:26:53  seq5   leaf-app spec v1（dc6f16e2）
23:27:00  leaf-app designer 退出 → 派 reviewer（23:27:00.332）
23:27:20  seq6   root spec-review PASS（role=reviewer）→ spec-frozen
23:27:36  seq7   leaf-renderer spec v1（87554829）
23:27:41  leaf-renderer designer 退出 → 派 reviewer（23:27:41.663）
23:27:59  seq8   leaf-app spec-review fail #1（role=reviewer：验收真空 + UI 交互覆盖缺失）
23:28:07  派 designer → leaf-app 修 spec（第 1 代）
23:28:18  seq9   leaf-renderer spec-review fail #1（role=reviewer：验收真空 + 区分力不足）
23:28:23  派 designer → leaf-renderer 修 spec（第 1 代）
23:29:47  seq10  leaf-renderer spec v2 重提（99d866b2）→ 23:29:57.821 派 reviewer 二审
23:31:32  seq11  leaf-renderer 二审 fail（role=reviewer，全新意见：e2e 脚本未定义 /
          无 -t 隔离 / 断言指向实现细节）→ 打回 2 代 ≥2 → specReviewDeadlock：
          停派 leaf-renderer 全部 role，转人工（escalation 全场唯一；此后该 unit 零派发零事件）
23:36:03  seq12  leaf-app spec v2 重提（ff3d1164，A1-A4）
23:36:13  leaf-app designer 退出 → 派 reviewer 二审（23:36:13.318）
23:37:04  seq13  leaf-app 二审 PASS（role=reviewer）→ spec-frozen → 23:37:09.551 派 builder
23:40:22  seq14  build #1（75d82410）→ seq15 verify FAIL（A1/A4 e2e 实挂；A2/A3 名字匹配）
23:40:52  seq16  build #2（a9aa5238）→ seq17 verify FAIL（重跑 4/4 绿但红阶段判恒真 4/4）
23:41:52  seq18  build #3（e4eb6a2d）→ seq19 verify FAIL（同上恒真）
23:42:47  seq20  build #4（a138caa）→ seq21 verify PASS（cases 4/4 绿 + red 4/4 有区分力）
23:43:04  leaf-app builder 退出 exit 0 → 派 reviewer exec-review（23:43:04.882）
23:43:52  seq22  exec-review PASS（role=reviewer）→ leaf-app closed（唯一 closed unit）
23:44:00  leaf-app reviewer 退出 + worktree 回收 + 子分支保守保留；最后一条结算
          此后 runner 空转（root 停等 deadlocked 的 leaf-renderer）
~00:28:52 max-idle 到点（seq22 23:43:52 + 45min）→ 「totalEvents 停在 22」收束退出
          （exit 1 语义；进程死亡实测窗口 (00:27:37, 00:29:50]）
```

对照上一场：有效活动 18m29s vs 26m11s（-29%）；spawn 12 vs 11；verify 4 vs 4；escalation 1 vs 2。上一场 leaf-renderer 靠 in-flight builder 重提自愈 + builder 抢答自审（§5.1）才 closed 的路径，本场根本未走到 build 阶段（spec 阶段即被两代实质打回拦停）。

## 5. 与上一场的对照（FAIL 形态消失清单）

| 上一场 FAIL 形态 | 本场结果 | 消失原因（mx-3 修复点） |
|------|------|------|
| §5.1 builder 单 spawn 内重提 spec 后自审 pass（role 缺失 verdict 驱动冻结，独立审查被绕过） | **消失**：全场 role 缺失 spec-review = 0；builder 存活期内零 spec-review 入账 | 入账强制 `--role reviewer` + fold 只认 reviewer |
| §5.3 reviewer 试探性提交（comment=`test`）同代双 fail 误杀 → deadlock | **消失**：6 条 verdict 全为实质意见；无同代双 fail；代数计数按「新 SpecSubmitted 后的 fail」划代 | deadlock 改按打回代数计数 |
| §5.5 flake escalation 消息连续打印 2 次 | **消失**：本场唯一 escalation 全文恰打印 1 次 | escalation 按签名去重（文本 + unitId） |
| 外部 SIGTERM exit 143 截断（约 60min 后台存活上限） | **消失**：nohup 脱离 + 分步轮询，max-idle 自然收束完整拿到 | 执行方式修正（本场靶子侧改进，非代码修复） |
| flake escalation（builder verify 连挂 2 停派转人工） | **未再现**：leaf-app 3 轮 verify fail 中 e2e 命令层仅 1 次挂（另 2 次为红阶段判恒真），e2e 连挂计数未达阈值，builder 第 4 轮自愈闭环 | agent 侧行为差异 + 红阶段恒真拦截与 e2e 连挂分属不同计数通道 |
| root 未 closed | **仍在**（FAIL 主因） | 诱因从「机制误杀」变为「真实跨代质量分歧」——reviewer 两代意见全新且 designer 两版未达其标准，mx-3 语义下属正确转人工 |

## 6. 观察项

1. **[链路层] specReviewDeadlock 的真实链路触发概率仍高**：本场 reviewer 意见逐代加码（第 1 代要求拆分验收+命令限定路径，designer 照做后第 2 代又指出 e2e 脚本未定义等新问题），designer 单轮修复未覆盖 reviewer 全部标准时即达代数上限。escalation 已含每代首条意见 + `--role reviewer` 人工处置指引，处置路径完整；但零人工口径下该出口必然中断收敛。canon 层候选：代数上限放宽 / escalation 附两代意见全文 / 转人工前给 designer 一次「合并全部意见」的修复机会。
2. **[消费方注意] verify report 的 `exitCode` 与账本 `result` 不同源**：seq17/19 的 report exitCode=0（干净重跑阶段退出码）但账本 result=fail（红阶段恒真 gate 独立判定）——消费方须以 result 为准。
3. **[消费方注意] `cw report` 的 `acceptance=` 列 = 名字级匹配到的验收集**（verify-b5e121bc 显示 A2,A3 = 匹配集；实际 fail 的是 A1/A4——e2e 挂致标记行未出现、未匹配）。读法与 case 级结果互补。
4. **[靶子构造侧] `.cw-spawn/` 域外残留**源于构造方 brief §2 指引路径（fx-4 期合法工作区，fx-4 后 spawn 产物已收口 topic 目录）：本场 root designer 遵循指引在 root worktree `.cw-spawn/` 留 2 个子任务书。建议后续 brief 模板删除该路径指引，或评估 runner 收尾清理 root worktree 的 `.cw-spawn/`。
5. **[无害] leaf-renderer worktree + 零成果子分支保留**（cw/md-reader/leaf-renderer tip=ae5173f 与 master 同点）：run 经 max-idle 收束非正常完成所致，恢复动作文案在场，非数据丢失风险。

## 7. 保留产物

- **`/tmp/m4-gate2-evidence/`（长期保留）**：events.log 副本（22 事件）、runner.log 副本、run-start.ts、topic 目录逐字节拷贝（33 文件，含 12 session JSONL）、final-status.txt（终态 status+tree）、git-worktree.txt（worktree/分支快照）、m4-brief.md（字节复用版原文）
- `/tmp/m4-gate2/`（靶子 + 隔离 CW_HOME/WORKTREE_HOME + wrapper + probe）：报告落盘后已清理
- 仓库内唯一写入 = 本报告文件；git status 仅本文件一个新增

## 8. 总结论

**FAIL(链路)。** M4 gate 二跑（commit `31ffa49`，mx-3 在场）真实 pi 后端零人工干预全链仍未收敛：leaf-renderer 因 specReviewDeadlock（真跨代 2 代打回）停派转人工，root 停等子树空转至 max-idle exit 1 收束。**mx-3 的三个修复全部获得现场机器验证**：spec-review verdict 6/6 全 role=reviewer（上一场 builder 自审绕过与 role 缺失不可考两条形态消失）、deadlock 代数计数正确且「已打回 2 代」文案正确（上一场试探提交误杀形态消失）、escalation 消息恰打印 1 次（上一场双印形态消失）；附加收益：本场执行方式（nohup 脱离 + 分步轮询）完整拿到 max-idle 自然收束形态，上一场外部 SIGTERM 截断不再。本场 FAIL 的根因是 reviewer 与 designer 的真实质量分歧在零人工口径下无消解通道——属设计内正确转人工，非机制缺陷。七条判定：3.1 FAIL / 3.2 PASS / 3.3 FAIL(链路)+代数文案正确 / 3.4 PASS / 3.5 PASS / 3.6 PASS（附披露）/ 3.7 FAIL。

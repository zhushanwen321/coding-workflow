# M4 Gate 三跑终验报告：真实 pi 后端全链无人干预验证（接管续作场）

- 判定：**FAIL(链路)**——零人工干预下全链仍未收敛：root `md-reader` 终态 spec-frozen 未 closed（leaf-app 因 flakeReview 停派 + builder spawn 30min TIMEOUT 中断在 build 阶段）。与二跑的本质差异：**中断通道从「spec 阶段 specReviewDeadlock」移到「build 阶段 flakeReview + spawn 超时」**——spec 打回-修复-再审循环本场在全部 3 个 unit 完整闭环（最多 2 代全过审，远未触达 mx-4 的 10 代上限），leaf-renderer 走完全生命周期 closed（本场唯一），中断诱因是 leaf-app 的 e2e 验收连挂触发 flake 停派 + 在场 builder 模型调用 hang 满 30 分钟被 runner 判 TIMEOUT，此后无可派发工作空转至 max-idle 收束。
- 日期：2026-08-19（本地 UTC+8；日志时间戳 UTC 2026-08-19T10:17–11:27）
- 依据：`docs/rewrite/acceptance/m4-gate2-report.md`（格式蓝本）、`docs/rewrite/acceptance/m4-gate-report.md`（一跑）；被测代码 = 本仓库 dist（mx-4 SPEC_REVIEW_DEADLOCK_FAILS=10 在场，runner 启动行 `max-spec-rejects=10` 实证）
- 任务同构前两场：md-reader（root）+ leaf-app + leaf-renderer。**本场 brief 为重建版，非前两场字节复用**（见 §2 披露）
- 执行命令（前任 executor 构造并启动）：隔离 env 下 `cw create --id md-reader --brief /tmp/m4-gate3/m4-brief.md` → `node <本仓库>/dist/cli.js run --root md-reader --spawn pi --max-idle-ms 2700000`（nohup 脱离，PID 27691，日志 `/tmp/m4-gate3/runner.log`）
- 人工干预：**0**（本 executor 全程只观察；runner/pi 进程零 kill 零 touch；账本/靶子/worktree 零写入——镜像只读拷贝到仓库 `.xyz-harness/`）
- 环境隔离：`CW_HOME=/tmp/m4-gate3/cw-home`、`CW_WORKTREE_HOME=/tmp/m4-gate3/worktree-home`（真实 `~/.cw` / `~/.cw-worktrees` 事后 grep `m4-gate3` 零命中实证）；PATH 前置 `/tmp/m4-gate3/bin/cw`

## 1. 结论与关键数字

| 指标 | 值 |
|------|-----|
| 退出形态 | **max-idle 自然收束（exit 1 语义）**：日志末行 `cw run: root "md-reader" 超过 2700000ms 无账本进展（totalEvents 停在 33…）`；锚点核算：最后事件 seq33 10:42:26.968 + 45min = 11:27:26.968，runner.log 落笔 mtime 11:27（本地 19:27）吻合；进程死亡实测窗口 (11:27, 11:28:50]，`kill -0 27691` 两次失败确认（nohup 脱离形态下进程 exit code 未直接捕获，与二跑同口径如实披露） |
| root 终态 | spec-frozen（**未 closed**）：leaf-app spec-frozen（lastVerify fail，flake 停派）/ leaf-renderer **closed** |
| wall-clock | 10:17:24 → ~11:27:27 UTC，约 70 分钟（有效活动期 10:17:24–10:43:39 = **26 分 15 秒**——最后一条 session 写入止，与一跑 26m11s 几乎相同；其后 ~44 分钟空转由 max-idle 收束） |
| pi spawn 次数 | 19（designer 8 + reviewer 9 + builder 2）：18 条结算行 exit 0 + **1 条 TIMEOUT**（leaf-app builder，10:33:43 派发 → 11:03:42 整 30 分钟超时——三跑首个 spawn 超时形态） |
| session 落盘 | **19 spawn × 19 session `*.jsonl`，一一对应**（文件名时间戳 = 派发时刻 ±1s；与 brief/stdout/stderr 同目录共存于 topic 目录，共 43 文件 = 19 session + 8 组 unitId.role × 3） |
| 账本事件数 | 33（UnitCreated 3 / SpecSubmitted 8 / VerdictSubmitted 9 / EvidenceSubmitted 6 / VerifyRan 7），seq 1-33 连续无断 |
| review verdict role | **9/9 全 role=reviewer（spec-review 8 + exec-review 1），role 缺失 = 0**（python 逐条断言通过）——mx-3 入账强制连续两场生效 |
| VerifyRan 分布 | leaf-renderer 3 fail + 2 pass（单 builder spawn 内 4 轮 build→verify 自愈闭环 + exec-reviewer 复跑 1 次；前 3 轮 fail = 名字匹配/恒真/e2e 实挂混合，第 4 轮 A1-A4 全绿）；leaf-app 2 fail（第 1 轮 A1-A5 全挂，第 2 轮 A1 过但 A2/A3/A4/A5 挂）；root 零 verify（集成未发生） |
| spec 打回代数 | md-reader 1 代 / leaf-app 2 代 / leaf-renderer 2 代（全部在第 2/3 版过审；**deadlock 上限 10 代未触达**） |
| 转人工 escalation | **flakeReview ×2**（leaf-renderer A4 连挂 2 次 @~10:36，后被在场 builder 第 4 轮 pass 自愈消除；leaf-app A3 连挂 2 次 @~10:42，**退出时仍未处置**）；escalation 消息按 unit 各恰打印 1 次（去重生效）；specReviewDeadlock 零触发 |
| topic 目录 | `/tmp/m4-gate3/cw-home/topic/__private__tmp__m4-gate3__target-e571f76e/20260819-181724-md-reader/`，43 文件（清单入镜像） |
| 产物域外残留 | spawn 过程产物 0（worktree-home + 靶子域对 `*.jsonl`/`*.brief.md`/`*.stdout`/`*.stderr` 仅命中 root worktree `.cw-spawn/` 下 2 个 designer 手写子任务书——与二跑同款构造侧残留，见 §3.6）；真实 `~/.cw`、`~/.cw-worktrees` 无靶子域条目 |
| agent commit | leaf-renderer 分支 1 commit（0394ffe，同一 builder spawn 4 轮迭代收在 1 个 commit 序列 c107efb→3355525→f34080d→0394ffe）；leaf-app 分支 2 commit（4e384e8、044a385）；cw-root/md-reader=b0c845c（root spec 修订）；master 全程钉在 976eb08 零污染 |
| attachments 副本 | 11（brief 3 / spec 8），specHash ↔ 文件名前缀逐对应；重建版 brief 副本 sha256 = cb649b1e…（与源披露一致） |

七条通过标准逐条判定见 §3。

## 2. 靶子构造记录（前任 executor 执行，本 executor 磁盘核实）

| 步骤 | 操作 | 结果 |
|------|------|------|
| 目录结构 | `mkdir /tmp/m4-gate3/{cw-home,worktree-home,bin,target}` | CW_HOME 与 CW_WORKTREE_HOME 均指 tmp（真实域零接触） |
| PATH wrapper | `/tmp/m4-gate3/bin/cw` | 防解析到全局旧版 cw |
| pi 探针 | probe-session + `probe-stdout.txt` | 输出「正常」（7 字节非空，模型链真实可用；probe-stderr 仅扩展噪音） |
| 靶子 git | `git init -b master` + README 存档 commit | `976eb08 chore: phase-0 baseline (README archive)`，工作区干净 |
| create | `cw create --id md-reader --brief /tmp/m4-gate3/m4-brief.md` | seq1 入账 10:17:15.154（runner 启动前 9 秒） |

**brief 重建披露（本场与前两场的唯一靶子差异）**：前两场 brief 为 `/tmp` 原件字节复用；本场 `/tmp` 原件随机器重启被灭，前任 executor 从一跑账本 attachments 重建——

- 源：`/Users/zhushanwen/.cw/__Users__zhushanwen__Code__test-repo__recursive-split-e2e-6eb176df/evidence/md-reader/attachments/b63142ef8ffa9621ec8e5493a44d14c270e031ffaac3026793376c2b3555a4ab.final-brief-4.md`（sha256 `b63142ef8ffa…`，本场收尾时实测复核一致）
- 重建版：`/tmp/m4-gate3/m4-brief.md`（sha256 `cb649b1ea82bb7d48b7a8f6f61973fc6fe51f4f12053f77bb642459bfb3ad79f`，实测复核一致）
- diff 恰为 m4-gate-report.md L39 文档化的 2 处构造（78 行自审指令行换 mx-1 注记、206-207 行速查行注释化），无其他字节差——即语义等价于前两场的 mx-1 适配版

**前任 executor 交接记录**：前任于 18:17-18:19（本地）完成全部现场构造并启动 runner（PID 27691），轮询 2 轮（journal R01/R02）后死于瞬时 Model request 故障（非配额）。runner 为 nohup 脱离进程不受影响持续运行；本 executor（第二任）10:21:34Z（本地 18:21:34）接管，零干预续作轮询 R03-R49 至终态，全程未 kill 任何进程、未 touch 靶子/账本/worktree。接管无损实证：poll-journal.md R01/R02 原样保留、R03 起连续无跳轮、账本 seq 无断层、19 spawn 对账完整。

**本 executor 数据质量披露**：poll-journal R03-R48 的行首时间戳为逐轮推算（75s 间隔 + 命令耗时），存在累计漂移，末段约快 9-10 分钟（journal 已附 CORRECTION 行）。所有关键时点以账本 ts / runner.log ts / 文件 mtime 为准，本报告时间线全部采用权威源，不受漂移影响。

## 3. 通过标准逐项判定（2 PASS / 2 FAIL / 3 PASS 附说明）

### 3.1 全链自然收敛 — **FAIL**

- root 未 closed：`cw tree` 终态 = `md-reader (spec-frozen) / leaf-app (spec-frozen) / leaf-renderer (closed)`
- 退出形态为 max-idle 收束（exit 1 语义），非收敛 exit 0
- manual 验收 = 0（口径满足）：全部 8 版 spec 的验收 type 仅 e2e-real / unit，逐条核验
- 根因链（账本实序）：leaf-app spec 三版过审（seq19 10:33:38）→ builder 派发（10:33:43）→ build#1 verify 全挂（seq25，A1-A5 fail）→ 迭代中 build#2 verify 仍挂（seq33 10:42:26，A1 过但 A2/A3/A4/A5 fail；其中 A3 `pnpm build exit 0` 两连挂）→ **flakeReview 停派 leaf-app builder**（escalation 打印）→ 在场 builder 会话 10:43:39 起静默（模型调用 hang，进程活 CPU 近零）→ **11:03:42 runner 判 30min spawn TIMEOUT**（可重派文案，但 flake 停派态下未重派）→ leaf-app 无出路 → root 停等子树 → 空转 45 分钟 max-idle 收束
- 对照二跑：本场失败点后移了一个阶段（spec 全过 → 死在 build/verify），leaf-renderer 完整走通 created→spec-frozen→verified→closed 全生命周期（含 exec-review），证明单 unit 全链收敛机制在场可用；中断是 leaf-app 的 agent 侧实现质量 + 模型调用 hang 复合诱因，非机制误触发

### 3.2 异源 reviewer 派发在场 — **PASS**（附 1 项靶子构造侧披露）

**时序（9/9 全部成立，机器判定）**：

| unit（审查类） | reviewer spawn | verdict 入账 | 间隔 |
|------|------|------|------|
| md-reader v1（fail） | 10:18:36.246 | seq6 10:19:49 | 73s |
| leaf-app v1（fail） | 10:19:39.918 | seq7 10:20:29 | 50s |
| md-reader v2（pass） | 10:21:06.729 | seq10 10:22:02 | 56s |
| leaf-renderer v1（fail） | 10:21:57.800 | seq12 10:23:02 | 64s |
| leaf-app v2（fail） | 10:22:18.523 | seq13 10:25:10 | 172s |
| leaf-renderer v2（fail） | 10:25:43.415 | seq15 10:27:35 | 112s |
| leaf-renderer v3（pass） | 10:29:49.185 | seq17 10:31:47 | 119s |
| leaf-app v3（pass） | 10:32:24.780 | seq19 10:33:38 | 73s |
| leaf-renderer（exec-review pass） | 10:40:25.841 | seq31 10:41:23 | 57s |

- 全部 9 条 verdict payload.role=reviewer（含 8 spec-review + 1 exec-review），role 缺失 = 0
- **designer/builder 产物零 review submit 指令**：全部 `*.designer.stdout`（3）、`*.builder.stdout`（2）grep 零命中；机制生成的 leaf designer/builder brief（6）零命中；本场 builder 存活期内零 spec-review verdict 入账，其通过路径 exec-review 由独立 reviewer 提交且携带 `--evidence-refs`（session 命令原文在场，refs 合法性经 handler 校验入账）
- **fail→修 spec→再审循环闭环 ×3**：三个 unit 各自走完「reviewer 打回 → designer 重派修 spec → 新版入账 → 独立 reviewer 再审」完整闭环（md-reader 1 代、leaf-app 2 代、leaf-renderer 2 代后全过审）——打回循环不再活锁（二跑的 deadlock 形态本场未再现）
- **stderr 抢答警告**：无 in-flight reviewer 期间无新 spec-review verdict 入账，警告通道零触发（正确）
- **披露（靶子构造侧）**：`md-reader.designer.brief.md` grep `review submit` 命中 2 处——重建版 brief 附录 §7 速查行的注释形态原文（一跑 L39 文档化的构造内容，非机制生成）；本场 designer 未据此抢答

### 3.3 deadlock 代数语义 — **PASS（在场语义）+ 上限通道未触达（如实标注）**

- **打回代数实际记录**（重点核查项）：
  - md-reader：1 代——v1 fail（seq6：验收真空，关闭文件功能未覆盖）→ v2 pass（seq10）
  - leaf-app：2 代——v1 fail（seq7：A1 e2e 恒真测试 severity critical）→ v2 fail（seq13：关闭按钮绑定缺失 Coverage Gap）→ v3 pass（seq19）
  - leaf-renderer：2 代——v1 fail（seq12：5 项不合格，验收覆盖不足缺段落/列表/链接）→ v2 fail（seq15：2 项不合格，其中 1 项为第一轮未修复遗留[A2 core 标记错误]）→ v3 pass（seq17）
- 每代意见均为实质性新意见（非重复、非试探），designer 每次获得修复机会并重提新版——代数划界（新 SpecSubmitted 后的 fail 计新一代）行为正确
- **specReviewDeadlock 通道未触发**：最高代数 2，远低于 mx-4 上限 10（runner 启动行 `max-spec-rejects=10` 实证在场）；「≥10 代转人工」的上限语义本场观察不到，无编造判定
- 本场实际触发的转人工通道是 **flakeReview**（e2e 验收连挂 2 次，canon §5.2）：leaf-renderer A4（后自愈）、leaf-app A3（未处置）——与 specReviewDeadlock 分属不同计数通道，文案均含三选一人工处置指引且各恰打印 1 次

### 3.4 session 落盘 — **PASS**

- **对账**：19 spawn（19 条派发行 × 18 条 exit 0 结算 + 1 条 TIMEOUT 结算）× 19 个 session `*.jsonl`，一一对应；session 文件名时间戳与派发时刻差 <1s；与同组 brief/stdout/stderr 同目录共存于 topic 目录
- **抽查 1（leaf-renderer.builder，10-31-55-600Z，229KB）**：toolCall 命令原文逐字在场——`cw evidence submit --kind spec`、`npm install`、`npx vitest run`、`git add -A && git commit`、`npx tsc && node scripts/check-xss.mjs`、4 轮 build→verify 迭代全链可回放；vitest 输出 toolResult（10 tests passed）与账本 verify 结果互证
- **抽查 2（leaf-app.builder，10-33-43-701Z，365KB）**：卡死现场完整保留——最后一条 toolResult 10:43:39（A2 vitest json reporter 全绿）之后零写入，与 runner 11:03:42 TIMEOUT 判定（派发+30min 整）互证；此前 write tests/open.spec.ts、check-render.mjs 修复过程逐条在场
- **抽查 3（exec-reviewer，10-40-26-251Z）**：`cw verify --runId verify-5285…` 复跑 + `cw report` 查证 + `cw review submit … --role reviewer --evidence-refs …` 命令原文在场，与 seq30/31 互证
- 全部 19 个 session workdir 均为隔离 worktree-home 域，无路径污染

### 3.5 红阶段在场 — **PASS**

- **7 次 VerifyRan × 7 个 red-phase 独立产物目录，1:1 无缺**（leaf-app 2：`red-phase-7c1caafd`、`red-phase-bef6543b`；leaf-renderer 5：`0870d2c0`/`4ae0b640`/`6a73f379`/`cb53bf1e`/`ee946fa5`）；全部 verify report.json 含 redPhase 节
- 逐条真实工作：
  - leaf-app red-phase 基线全挂（A1-A5 fail，exitCode 1）——新测试打到实现前基线树必须挂的区分力检查在场
  - leaf-app verify-b62e0340 redPhase：A1 discriminative=**false**（理由：恒真测试嫌疑，基线树上也通过）+ A2 产物解析失败——**红阶段恒真拦截在场工作**，是 builder 迭代对抗的主要 gate 之一
  - leaf-renderer 抽查 red-phase-0870d2c0：基线 A1-A4 全 fail（exitCode 1）
- 消费方注意（承二跑 §6.2）：report `exitCode` 与账本 `result` 不同源，判定以账本 result 为准

### 3.6 spawn 产物收口 — **PASS（附 1 项披露，与二跑同款）**

- 全部 43 个 spawn 过程产物（19 session + 8 组 × brief.md/stdout/stderr）在 topic 目录；19 条派发行的 brief 路径逐行指向该目录
- 真实域隔离成立：`~/.cw`、`~/.cw-worktrees` 对 `m4-gate3` 零命中（grep 实测）
- 靶子 cwd 终态仅 `README.md` + `.git`，master 钉在 976eb08 零污染
- **披露**：root worktree `.cw-spawn/` 下 2 个 designer 手写子任务书（leaf-app/leaf-renderer.brief.md）——UnitCreated seq2/3 的 briefRef 即指向该路径，是构造方 brief §2 指引的 agent 工作产物（与二跑 §3.6 完全同款），非 runner spawn 过程产物；按「runner 产物收口」口径 PASS

### 3.7 收尾健康度 — **FAIL**

- 退出时含**未处置 escalation 1 项**：leaf-app flakeReview（A3 e2e 两连挂）——零人工干预口径下无后续处置；另 leaf-renderer 的 flake escalation 打印后被在场 builder 第 4 轮 verify pass 自愈消除（unit 已 closed，非残留项）
- runner 自然退出路径健康：max-idle 到点退出文案完整可操作（指明 topic 目录排障路径 + 重跑续作命令）；无锁残留；账本 33 事件完整一致
- **escalation 消息无重复打印**：两场 flake escalation 各恰出现 1 次（签名去重连续生效）
- worktree 终态：leaf-renderer（closed）worktree 已回收、子分支 `cw/md-reader/leaf-renderer`（tip=0394ffe）**保守保留**（tip 不在 cw-root/md-reader 可达——集成未发生，root 分支仅含 root spec commit b0c845c，恢复动作文案在场）；leaf-app 与 root worktree 保留（run 经 max-idle 收束非正常完成）——与二跑 §3.7 同形态
- **观察（机制交互）**：leaf-app builder TIMEOUT 结算行文案「可重派（连续 2 次后转人工）」未兑现——该 unit 同时处于 flake 停派态，flake 优先级更高，此后零重派。两条防线叠加时恢复指引互相矛盾（见 §6 观察项 1）

## 4. 时间线（runner 日志 + 账本，UTC）

```text
10:17:15  seq1   UnitCreated md-reader（前任 executor 人工 cw create）
10:17:24  [runner] 循环启动（poll=5000ms max-idle=2700000ms max-concurrency=3
          max-spec-rejects=10）→ 派发 designer → md-reader
10:18:05  seq2/3 UnitCreated leaf-app / leaf-renderer（root designer 50s 建两子）
          → 派发 designer → leaf-app + leaf-renderer（三 designer 并发）
10:18:18  seq4   root spec v1（2113ab79）
10:18:36  root designer 退出 exit 0 → 派 reviewer（spec 待审，designer 不自审）
10:19:23  seq5   leaf-app spec v1（386ac025）→ 10:19:39 派 reviewer
10:19:49  seq6   root spec-review fail #1（reviewer：验收真空-关闭文件未覆盖）
          → 10:19:59 派 designer 修 spec（第 1 代）
10:20:29  seq7   leaf-app spec-review fail #1（reviewer：A1 e2e 恒真，critical）
          → 10:20:36 派 designer 修 spec（第 1 代）
10:20:53  seq8   root spec v2（a9109361）→ 10:21:06 派 reviewer 二审
10:21:41  seq9   leaf-renderer spec v1（b743356b）→ 10:21:57 派 reviewer
10:22:02  seq10  root spec-review PASS → root spec-frozen
10:22:03  seq11  leaf-app spec v2（78142d70）→ 10:22:18 派 reviewer 二审
10:23:02  seq12  leaf-renderer spec-review fail #1（reviewer：5 项不合格）
          → 10:23:07 派 designer 修 spec（第 1 代）
10:25:10  seq13  leaf-app spec-review fail #2（reviewer：关闭按钮绑定缺失）
          → 10:25:24 派 designer 修 spec（第 2 代）
10:25:27  seq14  leaf-renderer spec v2（e7d085d7）→ 10:25:43 派 reviewer 二审
10:27:35  seq15  leaf-renderer spec-review fail #2（reviewer：2 项不合格含 1 遗留）
          → 10:27:41 派 designer 修 spec（第 2 代）
10:29:38  seq16  leaf-renderer spec v3（ba93ec6e）→ 10:29:49 派 reviewer 三审
10:31:47  seq17  leaf-renderer 三审 PASS → spec-frozen → 10:31:54 派 builder
10:32:06  seq18  leaf-app spec v3（50eb84d0）→ 10:32:24 派 reviewer 三审
10:33:38  seq19  leaf-app 三审 PASS → spec-frozen → 10:33:43 派 builder
          —— 全树 spec-frozen，进入 build 阶段 ——
10:34:33  seq20  leaf-renderer build#1（c107efb）→ seq21 verify FAIL（A2,A3）
10:36:05  seq22  leaf-renderer build#2（3355525）→ seq23 verify FAIL（A1,A2,A3）
          → A4 e2e 连挂 2 次 → flakeReview escalation #1（停派 leaf-renderer
          builder；在场 builder 继续迭代）
10:37:02  seq24  leaf-app build#1（4e384e8，run-leaf-app-1）
          → seq25 verify FAIL（A1-A5 全挂；A3 计连挂 1）
10:37:50  seq26  leaf-renderer build#3（f34080d）→ seq27 verify FAIL（A1-A4）
10:39:53  seq28  leaf-renderer build#4（0394ffe）→ seq29 verify PASS（A1-A4 全绿）
          → leaf-renderer flake 停派态随在场 builder 自愈解除
10:40:25  leaf-renderer builder 退出 exit 0 → 派 reviewer exec-review
10:41:00  seq30  exec-reviewer 复跑 verify PASS → 10:41:23 seq31 exec-review PASS
          → leaf-renderer closed（本场唯一）；子分支回收保守保留（集成未发生）
10:42:06  seq32  leaf-app build#2（044a385，run-leaf-app-2）
          → seq33 verify FAIL（A1 过；A2/A3/A4/A5 挂）→ A3 e2e 连挂 2 次
          → flakeReview escalation #2（停派 leaf-app builder）
10:43:39  leaf-app builder 会话最后写入（A2 vitest 自检绿）→ 此后模型调用
          hang（进程活、CPU 近零、零写入）
11:03:42  [runner] builder unit "leaf-app" 退出 TIMEOUT（10:33:43+30min 整；
          「可重派」文案因 flake 停派态未兑现，此后零派发零事件）
~11:27:27 max-idle 到点（seq33 10:42:26.968 + 45min）→ 「totalEvents 停在 33」
          收束退出（exit 1 语义；死亡实测窗口 (11:27, 11:28:50]）
```

## 5. 与二跑的对照

| 维度 | 二跑（m4-gate2） | 三跑（本场） |
|------|------|------|
| 判定 | FAIL(链路) | FAIL(链路) |
| 中断通道 | specReviewDeadlock@leaf-renderer（spec 阶段，2 代打回活锁） | flakeReview@leaf-app（build 阶段，e2e 连挂）+ spawn TIMEOUT |
| spec 打回循环 | leaf-renderer 2 代卡死 | 3 unit 全部闭环（1/2/2 代），**deadlock 零触发** |
| closed unit | leaf-app | leaf-renderer（全生命周期含 exec-review） |
| spawn | 12（全 exit 0） | 19（18 exit 0 + **1 TIMEOUT**） |
| 有效活动期 | 18m29s | 26m15s |
| 事件数 | 22 | 33 |
| verdict role | 6/6 reviewer | 9/9 reviewer |
| escalation | specReviewDeadlock ×1 | flakeReview ×2（1 自愈消除 / 1 未处置） |
| max-idle 收束 | 00:28:52（seq22+45min） | 11:27:27（seq33+45min） |
| 前场 FAIL 形态消失清单 | builder 自审 / 试探误杀 / 双印 / SIGTERM 截断 4 项消失 | 全部继续未再现；二跑的 deadlock 形态本场亦未再现 |

两跑共同点：root 均停等未闭合子树空转 45 分钟收束；失败诱因均为 agent 侧真实问题（质量分歧 → 实现未完成 + 模型 hang），机制侧转人工出口按设计工作。

## 6. 观察项

1. **[机制交互] flake 停派与 buildTimeout 重派的优先级冲突**：leaf-app builder TIMEOUT 结算行称「可重派（连续 2 次后转人工）」，但该 unit 同时处于 flakeReview 停派态，实际零重派直至 max-idle 退出。两条防线叠加时恢复指引互相矛盾。canon 候选：TIMEOUT 文案叠加 flake 态条件分支，或 flake 停派在 spawn TIMEOUT 后重估（区分「agent 挂了」与「验收随机挂」）。
2. **[可观测性] spawn 30min 超时前无中间信号**：leaf-app builder 会话 10:43:39 后静默 ~20 分钟才被 TIMEOUT，期间 session JSONL 零写入、进程 CPU 近零（网络等待/模型调用 hang），排障只能靠文件 mtime + ps。候选：runner 对 in-flight spawn 定期心跳探测，或 pi 侧请求超时。
3. **[链路层] flake 启发式把「持续真 fail」也拦停**：leaf-app A3（pnpm build）两连挂触发停派，但 case 级看第 2 次 verify A2/A4/A5 同挂（vitest 名字匹配失败 + 红阶段恒真拦截）——实现远未完成，非随机 flake。canon §5.2 防的是打回循环对随机挂无解，但「持续真 fail」原本可由 builder 继续迭代（leaf-renderer 正是 4 轮自愈的实证——其 flake escalation 被 in-flight builder 的后续 pass 自愈消除）。零人工口径下该出口必然中断收敛，与二跑观察项 1 的 deadlock 出口同构。
4. **[正确性正面证据] 停派只拦新派发不杀在场 spawn**：leaf-renderer 的 flake escalation 打印后，在场 builder 第 4 轮 build→verify pass → closed——escalation 与自愈通道不互斥，现场验证了设计意图。
5. **[收尾] leaf-renderer worktree 已回收但子分支保守保留**（tip=0394ffe 不在 cw-root/md-reader 可达，集成未发生）：与二跑同形态；root 集成（integrate）因 leaf-app 未闭合从未启动，内部节点集成通道本场零观察（如实标注：未触达）。
6. **[无害] `.cw-spawn/` 域外残留** 2 文件：与二跑完全同款（构造方 brief §2 指引路径），维持二跑建议（brief 模板修订或 runner 收尾清理）。
7. **[执行侧] journal 时间戳漂移**：本 executor 轮询行首时间为推算值有累计漂移（已 CORRECTION 披露）；权威时间线以账本/runner.log 为准。后续接管型轮询应每轮 `date -u` 实取。

## 7. 保留产物

- **`.xyz-harness/m4-gate3-evidence/`（仓库内长期保留）**：cw-home 全量逐字节拷贝（events.log 33 事件 + topic 目录 43 文件含全部 19 session JSONL + evidence/red-phase 与 verify 产物全量）、events-final-full.log、runner.log（11.8KB 全量）、poll-journal.md（R01-R49 + CORRECTION）、m4-brief.md（重建版）、final-status.txt（终态 status+tree）、git-worktree.txt（worktree/分支快照）、run-start.ts、probe 三件套
- `/tmp/m4-gate3/`（靶子 + 隔离 CW_HOME/WORKTREE_HOME + wrapper）：保留未清理（含 leaf-app/root worktree 现场与未回收分支，供后续人工处置 escalation 排障）
- 仓库内写入 = 镜像目录 + 本报告；**未 commit**（按任务书由主 agent 核验统一提交）

## 8. 总结论

**FAIL(链路)。** M4 gate 三跑（mx-4 在场）真实 pi 后端零人工干预全链仍未收敛：root 停等 leaf-app 空转至 max-idle exit 1 收束。与二跑的关键差异：spec 打回-修复-再审循环在全部 3 个 unit 完整闭环（最高 2 代，deadlock 10 代上限通道未触达），leaf-renderer 走完含 exec-review 的全生命周期 closed——单 unit 全链收敛机制现场验证可用。中断诱因后移到 build 阶段：leaf-app e2e A3 两连挂触发 flakeReview 停派（其中相当成分是「持续真 fail」而非随机 flake），叠加在场 builder 模型调用 hang 满 30 分钟被 spawn TIMEOUT（三跑首现），两防线叠加导致零重派直至收束。机制侧无新增缺陷形态：9/9 verdict role=reviewer、escalation 各恰打印 1 次、红阶段 7/7 在场且恒真拦截工作、19 spawn × 19 session 一一对应、真实域零污染。两跑对照显示「转人工出口在零人工口径下必然中断收敛」是当前 FAIL 的共同结构性原因（deadlock 出口→flake 出口），收敛依赖 agent 侧单轮质量或人工处置。七条判定：3.1 FAIL / 3.2 PASS / 3.3 PASS（上限通道未触达）/ 3.4 PASS / 3.5 PASS / 3.6 PASS（附披露）/ 3.7 FAIL。

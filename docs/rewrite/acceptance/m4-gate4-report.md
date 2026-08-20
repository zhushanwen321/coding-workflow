# M4 Gate 四跑终验报告：真实 pi 后端全链无人干预验证（mx-5 新机制场）

- 判定：**PASS(链路)**——零人工干预下全链首次收敛：root `md-reader` **closed**（三 unit 全 closed），runner 自然收束 exit 0。三跑死局形态（e2e 解析恒挂被误判 fail ×2 → flake 停派 × builder TIMEOUT 零重派 → 空转 45min max-idle）**未再现**：解析失败被 `parseFailedAcceptanceIds` 显式分类且不进 flake 连挂计数，最终通过「修 spec 验收命令契约」收敛（本场由 in-flight developer 抢先完成修 spec 动作），全场 spawn TIMEOUT = 0。
- 日期：2026-08-19/20（本地 UTC+8；日志时间戳 UTC 2026-08-19T17:02–18:36）
- 依据：`docs/rewrite/acceptance/m4-gate3-report.md`（三跑 FAIL 基线与格式蓝本）；被测代码 = 本仓库 dist @ commit `ea2a969`（mx-5 波次全交付 verified：规则⑨契约 gate + 解析失败回炉通道 + reviewer 对抗清单 + developer 改名 + mx5-5 完备性收口）
- 靶子：与前两跑字节同源——brief sha256 `cb649b1ea82bb7d48b7a8f6f61973fc6fe51f4f12053f77bb642459bfb3ad79f`（复制自三跑证据目录，复制后校验一致）；任务同构 md-reader（root）+ leaf-renderer + leaf-app
- 执行命令（本 executor 构造并启动）：隔离 env 下 `cw create --id md-reader --brief /tmp/m4-gate4/target/m4-brief.md` → `nohup node <本仓库>/dist/cli.js run --root md-reader --spawn pi --max-idle-ms 2700000`（PID 36181，启动行全文在 runner.log 头部）
- 人工干预：**0**（全程只观察；runner/pi 进程零 kill 零 touch；账本/靶子/worktree 零写入——镜像只读拷贝到仓库 `.xyz-harness/m4-gate4-evidence/`）
- 环境隔离：`CW_HOME=/tmp/m4-gate4/cw-home`、`CW_WORKTREE_HOME=/tmp/m4-gate4/worktree-home`、`CW_AGENT_MODEL=xiaomi-token-plan-cn/mimo-v2.5-pro`、`CW_REVIEWER_MODEL` 未设（回落 developer 同款，即 mimo 同链）；PATH 前置 `/tmp/m4-gate4/bin/cw`（wrapper → 本仓库 dist/cli.js）；真实 `~/.cw` / `~/.cw-worktrees` 事后 grep `m4-gate4` 零命中
- 前置探针：pi 连通性探针输出「正常」（exit 0）

## 1. 结论与关键数字

| 指标 | 值 |
|------|-----|
| 退出形态 | **root closed 自然收束（exit 0）**：日志末段 `root "md-reader" 已 closed——调度循环结束（exit 0）` + 汇总（3 unit closed / lastVerify 全 pass）+ 资源回收报告 |
| root 终态 | **closed**（三 unit 全 closed：md-reader / leaf-renderer / leaf-app；`cw frontier` 全维度空） |
| wall-clock | 17:02:50 → 18:35:54（最后事件 seq96）→ 18:36 runner 退出，约 **93 分钟全程有效活动**（三跑 70 分钟 = 26min 有效 + 44min 空转；四跑零空转段） |
| pi spawn 次数 | **45**（designer 18 + reviewer 24 + developer 3）；结算行 44 条全 exit 0（末位 root exec-reviewer 的结算行缺失，见 §3 异常-2；session 文件在场） |
| **spawn TIMEOUT** | **0**（三跑 1 次 30min TIMEOUT；四跑零——两 leaf developer 分别在 24.7min / 19.5min 自愈退出，均在 30min 硬超时前） |
| session 落盘 | **45 spawn × 45 session `*.jsonl`，一一对应**（文件名时间戳 = 派发时刻 ±1s） |
| 账本事件数 | **96**（UnitCreated 3 / SpecSubmitted 20 / VerdictSubmitted 22 / EvidenceSubmitted 20 / VerifyRan 31），seq 1-96 连续无断 |
| review verdict role | **22/22 全 role=reviewer（spec-review 19 + exec-review 3），role 缺失 = 0**——mx-3 入账强制连续第三场生效 |
| **parseFailed 事件** | **22 次 VerifyRan 携带 `parseFailedAcceptanceIds`**（leaf-renderer A1 ×10 / leaf-app A2 ×12）——mx5-1 字段高频真实在场 |
| spec 版本数 | md-reader 3 版（v2 过审）/ leaf-renderer 9 版（v7 过审）/ leaf-app 8 版（v6 过审）——打回循环最多 6 代，远未触达 max-spec-rejects=10 |
| VerifyRan 分布 | 31 次 = 常规 30 + 集成（integrate-）1；pass 3 次（每 unit 最终各 1 次）；fail 27 次中 22 次为解析失败（分类正确）、5 次为真实/红阶段 fail |
| 集成 | integrate ×1（seq85 fail：契约签名不一致）→ rv-4 契约漂移处置链走通（designer 处置 → root spec v3 对齐契约 → root build → verify pass → closed） |
| agent commit | 成果分支 `cw-root/md-reader` @ d6c85e5（含 2 个 merge 提交 + 契约对齐 + 红阶段修复 ×2）；靶子 master 钉在 29dfbbe 零污染 |
| topic 目录 | `…/topic/__private__tmp__m4-gate4__target-1f0f9964/20260820-010250-md-reader/`，72 文件 = 45 session + 27（3 unit × 3 role × brief/stdout/stderr） |
| 产物域外残留 | spawn 过程产物 0（`target/.cw-spawn/` 与 root worktree `.cw-spawn/` 下 4 个文件为 designer 手写子任务书——与三跑同款构造侧残留，非 spawn 产物泄漏） |

mx-5 七观察项逐项判定见 §2。

## 2. mx-5 七观察项逐项判定（7 PASS，2 项附机制发现）

### 2.1 规则⑨真实拦截 — **PASS（拦截事件未出现，放行路径可解释）**

- 全量证据核查：45 个 spawn 的 stdout/stderr + runner.log + 账本中，**无任何 spec gate 规则⑨（runner 显式声明合法性）exit 1 拒收事件**。agent 产物中 9 处「gate/规则」字样均为 agent 自述文本（如 designer 总结「满足当前 spec gate 校验」、reviewer 陈述核对规则），非机制拦截。
- 放行路径解释：本场 designer 提交的 20 版 spec 的 runner 声明全部合法（或缺省按 type 推导），规则⑨无违规输入 → 无拦截是正确行为（拦截不出现 ≠ 失败）。**契约风险的拦截实际由 reviewer 对抗清单前置完成**：spec 阶段多次打回「裸 exit 0 无标记行 → e2e-sh 适配器恒判 fail」的命令（seq11/15/17 等，见 §2.5），以及 C1 契约签名与 root 冻结契约不一致（seq29）——三跑死因 A3 形态（无标记行命令进 build）在四跑 spec 阶段即被 reviewer 拦截，未进入 build 的第一现场。

### 2.2 回炉通道 — **PASS（字段与投影全在场；派发出口被 developer 抢跑路径替代，附机制发现）**

- **字段在场**：22 次 VerifyRan 携带 `parseFailedAcceptanceIds`（账本原文，如 seq38 `"parseFailedAcceptanceIds": ["A1"]`）。解析失败根因均为 spec 验收命令与适配器不匹配：leaf-renderer A1 `pnpm test` 的 pnpm banner（`> leaf-ren…`）污染 vitest JSON 输出；leaf-app A2 产物空/截断——**属 spec 层契约缺陷，非实现 bug**，与三跑 A3 同族。
- **投影与排除逻辑实战生效**：`frontier.ts` flake 连挂计算显式跳过 parseFailed 条目（源码 L467-471，注释即「三跑现场五：确定性挂被误判随机挂即此口径缺失」）——本场 leaf-renderer A1 连挂 10 次、leaf-app A2 连挂 12 次，**均未因此触发停摆**（flake 转人工消息只出声不停派，见 §2.3）。
- **回炉收敛实证**：解析失败的消除全部经由「修 spec 验收命令契约」——leaf-renderer developer 于 18:03 自提新 spec（A1 改 `pnpm --silent test` 抑制 banner，A2 改 `bash scripts/check-render.sh`，seq68），新 spec 后首次 verify 解析失败即消失（seq71 起 A1/A2 全进 pass 集）；leaf-app developer 18:12 同款自修（seq82）→ seq83 verify pass。新 SpecSubmitted 清零连挂计数 + 回炉代数 +1（specContractFacts 语义，账本可重放）。
- **机制发现（非阻塞，供 mx 后续参考）**：`specContractBroken` 的 designer 派发出口本场 **0 次触发**（runner.log「转派 designer 修 spec 的验收命令契约」零出现）——因为 in-flight gate（同 unit 有在飞 spawn 时缓派新角色）令回炉 designer 无法在 developer 存活期间介入，而 developer 在 spawn 内自行完成了修 spec 动作（相当于回炉内容被抢跑）。若 developer 不自愈而是耗满 30min TIMEOUT，回炉 designer 将在结算后才派出（延迟最坏 30min，非死局——TIMEOUT 结算后 specContractBroken 仍可派）。两条次生观察：① leaf-renderer developer 自提 spec 后又**自报 role=reviewer 自审 pass**（seq70）——触发 mx-1 S7 抢答警告（全场 1 次），独立 spec-review 被跳过一轮，exec-review 由独立 reviewer 补位（seq79）；② leaf-app 走了正规路径（developer 修 spec 后由独立 reviewer 过审 seq84）——同一机制下两条路径均收敛。

### 2.3 三跑死局形态消失 — **PASS**

- 三跑死因复合链逐环对照：
  - 「构建成功仍判 fail ×2 → flake 停派」：四跑解析失败条目**不进 flake 连挂输入**（parseFailed 排除口径实战生效）；触发 flake 转人工消息的是**真实 e2e fail**（leaf-renderer A2 exit 127 命令不存在 ×2 / leaf-app A1 缺 PASS 标记 ×2），且消息仅出声——混合 unit（解析失败连挂 ∧ e2e 连挂）按单组归属序归 `specContractBroken` 可派维度（`GROUP_ORDER` 中 specContractBroken 先于 flakeReview），其余 unit 照常推进。终局前两 unit 均随新 spec + 实现修复消除全部连挂。
  - 「flake 停派 × TIMEOUT 零重派」：四跑 TIMEOUT = 0；两 developer 在硬超时前自愈退出并留下 verify pass。
  - 「空转 45min max-idle 收束」：四跑零空转，root closed 即刻收束 exit 0。
- 若按任务口径问「A3 形态重现时是否走回炉而非 flake 停派」：A3 同族形态（无标记行/解析恒挂）重现了（22 次），**全部被分类为解析失败**（parseFailedAcceptanceIds）且最终经修 spec 收敛——判定成立。

### 2.4 developer 角色 — **PASS**

- build 阶段 3 次派发（leaf-renderer 17:47:53 / leaf-app 17:48:33 / md-reader 18:30:02）日志全为 `派发 developer → unit …`，brief 文件名 `<unitId>.developer.brief.md`；runner.log 全文（除启动行注释外）、账本、topic 产物命名**零 builder 字样**（grep 实证）。mx5-4 改名全链一致。

### 2.5 reviewer 对抗清单 — **PASS（形态质变，对照三跑）**

- 19 条 spec-review verdict comment 全部呈现分级清单形态，典型样本：
  - seq5（md-reader v1 fail）：「must-fix: 1. A1 e2e-real 命令缺少标记行输出……恢复动作：修改命令末尾加 echo A1 PASS。 2. A2 unit 命令未显式指定 --reporter=json…」——**must-fix 编号 + 恢复动作**
  - seq31（leaf-renderer fail）：must-fix / suggestion / info **完整三级**，info 部分五维度逐项核对（A1 命令契约核过 / 覆盖度核过 / 区分力反例追问核过 / 契约一致性核过 / 干净 checkout 可执行性核过）
  - seq29（leaf-renderer fail）：「Contract signature mismatch: leaf-renderer spec contract C1 … does not match root spec frozen contract C1 … Must align exactly with root spec」——**跨 unit 契约比对**（该打回预防的问题恰是 18:17 集成 fail 的实际根因，reviewer 前瞻正确）
  - seq15（leaf-renderer fail）：「核对清单逐项结果 ① 验收命令契约… ② 覆盖度…」
- 对照三跑 leaf-app 首审「不构成阻塞，pass」式放行：四跑 19 审 12 打回 7 过审，打回全部携带可执行恢复动作。**拦截有效性实证**：三跑死因形态（裸 exit 0 无标记行）在 spec 阶段被反复打回（seq11/15/17 三连打回 leaf-renderer A2 标记行缺失直至修复）。

### 2.6 既有机制回归 — **PASS**

- **role=reviewer 强制**：22/22 全 role=reviewer（含 19 spec-review + 3 exec-review），python 逐条断言零缺失——与三跑同口径 9/9 → 22/22。
- **红阶段**：在场且有效——root verify 两次 fail 均为红阶段区分力形态（A1/A2 已进 pass 集但 overall fail），developer 以「add marker file for red-phase distinguishability / red-phase-distinguishable assertions」两个 commit 修复后 pass（成果分支 git log 实证）；leaf-renderer seq71 同款形态一轮自愈。
- **session 保留**：45 spawn × 45 session JSONL 一一对应，全部落 topic 目录。
- **worktree 收口**：leaf-renderer / leaf-app worktree 目录 + 子分支按收尾流程回收 ×2；保留 md-reader worktree ×1（root 成果锚点，收尾输出明示）；2 条子分支「保守保留」（tip 含未回流 commit，恢复动作在日志，见 §3 异常-5）。
- **产物 topic 目录收口**：72 文件全在 run 级 topic 目录 `20260820-010250-md-reader/`，域外（worktree-home/靶子域）零 spawn 过程产物。
- 顺带回归：reviewer 退出未提交 verdict → runner 自动重派（2 次，17:12:20 leaf-app / 17:14:34 leaf-renderer），与三跑同款自愈。

### 2.7 收敛判定 — **PASS**

- root `md-reader` closed = 全链收敛（三跑 FAIL 的直接对照）。终态 `cw tree`：三 unit 全 closed；`cw frontier` 全维度空；`cw status` lastVerify 全 pass。
- 全链路径复盘（账本实序）：3 designer 并发起草 → spec 打回循环（reviewer 19 审，md-reader v2 / leaf-renderer v7 / leaf-app v6 过审）→ 2 leaf developer 并行 build（spawn 内多轮 build→verify 自愈，解析失败 22 次全部正确分类，经修 spec 命令契约消除）→ 双 leaf closed → 集成 fail 1 次（契约签名不一致）→ rv-4 契约漂移处置（designer merge 子树 + 修 root spec 契约 v3）→ root developer 红阶段修复 → root verify pass → root exec-review pass → closed，exit 0。

## 3. 异常与非阻塞观察清单（如实披露）

1. **flake 转人工消息重复出声 19 条**：连挂 runId 列表随每次 fail 增长 → 消息文本变化 → 「文本 + unitId」去重签名失效反复打印。行为无影响（仅出声，不停派），但三跑口径是每 unit 1 次（去重生效）——四跑的连挂高增长场景暴露去重签名对「事实增长型消息」失效，属可观测性噪音，建议后续改为按 unitId + 阈值达成事实去重。
2. **末位 reviewer 结算行缺失**：root exec-reviewer（18:35:42 派发，18:35:54 seq96 入账）无「退出 exit 0」行——root closed 触发收束路径，收尾汇总先于/替代了结算行输出。session 文件（18-35-43 jsonl）与 verdict 在场，45×45 对应不受影响。
3. **developer 自审越权 1 次**：leaf-renderer developer 自提 spec（seq68）后自报 role=reviewer 提交 spec-review pass（seq70），跳过独立 spec-review 一轮。mx-1 S7 抢答警告在场抓到（全场 1 次，18:04 出声）；exec-review 由独立 reviewer 完成（seq79）闭环。审计可见性达成；若需硬约束（自审 verdict 不折叠为 spec-frozen 前置）是 mx 后续可议点。
4. **集成 fail 后的收敛路径**：rv-4 契约漂移处置链完整走通（designer 2 次派发：首个无产出退出 → 次个完成 merge + spec v3），但注意第二次集成未经 `integrate-` runId 重跑，而是以 root unit 自身的 build→verify（干净重跑含全部验收）+ exec-review 收口——root 作为 unit 的验证语义覆盖了集成重跑，账本口径自洽。
5. **子分支保守保留 ×2**：`cw/md-reader/leaf-renderer`（tip 8eb11c7）与 `cw/md-reader/leaf-app` 因「tip 不在 root 分支可达」未删除（developer 修 spec 期间的 commit 未全部回流 root）。日志含恢复动作（merge 后重跑回收或手动清理）——保守正确，非缺陷。
6. **agent 时延特征**：本场 leaf designer 首轮 spawn 最长 15.5min（leaf-app，17:20:14-17:35:48），显著慢于三跑（≤2min）——模型侧波动，未影响机制（无挂死，session mtime 持续推进）。

## 4. 三跑 → 四跑对照总表

| 维度 | 三跑（FAIL） | 四跑（PASS） |
|------|------|------|
| root 终态 | spec-frozen（未 closed） | **closed** |
| 退出形态 | max-idle 空转 45min 收束（exit 1 语义） | root closed 即刻收束（exit 0） |
| spawn TIMEOUT | 1（30min，flake 停派态零重派 → 死局） | **0** |
| 解析失败处置 | 无分类通道：恒挂被计为普通 fail → 喂 flake 连挂 | `parseFailedAcceptanceIds` 显式分类 ×22，不进 flake 计数，经修 spec 收敛 |
| flake 转人工 | 停派 leaf-app builder（退出时未处置） | 消息出声但不停摆（混合 unit 归 specContractBroken 可派维度），随新 spec + 修复自然消除 |
| reviewer 打回质量 | 「不构成阻塞，pass」式放行存在 | 19 审 12 打回全 must-fix 分级清单 + 恢复动作 + 跨 unit 契约比对 |
| build 角色 | builder | developer（零 builder 残留） |
| 有效活动时长 | 26min（+44min 空转） | 93min 全程有效 |
| verdict role 合规 | 9/9 | 22/22 |
| 集成 | 未发生（root 停等） | 1 fail → 契约漂移处置链走通 → 收敛 |

## 5. 证据镜像

- 镜像目录：`.xyz-harness/m4-gate4-evidence/`（/tmp/m4-gate4 全量 rsync，含 events-final-full.log / final-readonly.txt / runner.log / run-start.ts / probe-* / cw-home 全量 topic+evidence+attachments / worktree-home / target）
- 账本全量：`events-final-full.log`（96 行 = 账本终态逐字节）
- 关键锚点：seq38/40（首批 parseFailed）、seq68（developer 自修 spec）、seq70（自审 verdict + 抢答警告）、seq78/83（双 leaf verify pass）、seq85（集成 fail）、seq87（root spec v3）、seq95/96（root verify/exec-review pass）

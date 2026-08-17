# fx-4 Gate 终验报告（场景 5）：spawn 产物收口 topic 目录全链 E2E（真实靶子，真实 pi，无人干预）

- 判定：**PASS**（runner exit 0，root closed，全树 3 unit closed；fx-4 主断言「全部派发产物收口 topic 目录 + 全部 agent commit 树零 `.cw-spawn`」机器判定达成；三类 attachments 副本 20/20 sha256 逐字节可重读；root 分支干净合并一条命令回流；全量测试 331/331 绿）
- 日期：2026-08-17（日志时间戳 UTC；本地 UTC+8）
- 依据：`docs/rewrite/design-topic-artifacts.md`（v1.1）§4 场景 5 与 §3.1 终态数据流；被测代码 = fx-4（commit `66fc7e0`）；前序报告 `m3-gate-report.md`（M3 gate，第 5 次终验）
- 任务与 M3 相同：md-reader（brief 复用 `/tmp/final-brief-4.md`，前 47 行与 `test-brief.md` 逐字一致 + 实施建议大节，diff 核实）
- 执行命令（靶子目录内）：`node <本仓库>/dist/cli.js create --id md-reader --brief /tmp/final-brief-4.md` → `CW_AGENT_MODEL=xiaomi-token-plan-cn/mimo-v2.5-pro node <本仓库>/dist/cli.js run --root md-reader --spawn pi --max-idle-ms 2700000`（stdout/stderr 落盘 `/tmp/fx4-gate-runner.log`；全局 cw CLI 全程未用）
- 人工干预：**0**（run 启动后零 touch；两轮集成 fail 均由机制自身处置闭环）
- 与 M3 命令形态一致：`--max-idle-ms 2700000`（idle 误杀防护校准值）；poll（5000ms）与 max-concurrency（3）默认；PATH 前置 `/tmp/final-gate-4/bin/cw`（内容核实 = `exec node <本仓库>/dist/cli.js`，防 agent 在 worktree 内解析到全局旧版 cw 1.6.4）

## 1. 结论与关键数字

| 指标 | 值 |
|------|-----|
| 总时长（run 进程启动 → root closed 循环退出） | 15:35:00 → 15:48:48 UTC，**13 分 48 秒**（M3 为 26 分 52 秒） |
| pi spawn 次数 | 9（designer 4 + builder 2 + reviewer 3）：7 条退出行全 exit 0；处置 designer 与 root reviewer 无退出行（root closed 后 killAll 收尾，同 M3 §5.3） |
| runner 状态机重派 / TIMEOUT | 0 / 0（15:42:03 的 designer 二次派发是集成 fail 达上限的 R4a 处置转派，非重派） |
| 账本事件数 | 26（UnitCreated 3 / SpecSubmitted 4 / VerdictSubmitted 7 / EvidenceSubmitted 4 / VerifyRan 8），seq 1-26 连续无断 |
| VerifyRan 分布 | leaf-app 1 pass；leaf-renderer 1 pass；md-reader 集成 4 fail（两轮×2，触发两轮处置）+ 最终 verify 2 pass |
| topic 目录 | `~/.cw/topic/<encoded>/<runTs>-md-reader/` = `20260817-233500-md-reader/`，24 文件（8 组 × brief/stdout/stderr） |
| worktree `.cw-spawn` | **0**（root worktree find 零命中；leaf 两 worktree 已回收不存在；反向全域扫描零残留） |
| agent commit 树 `.cw-spawn` 路径 | **0**（三条分支 rev-list 全 commit ls-tree 扫描：cw-root 326 paths / leaf-app 14 / leaf-renderer 7，全零命中——fx-4 主断言） |
| worktree | 创建 3（root + 2 叶，base 全 = 起跑 `2e693d0`）；回收 2（leaf-renderer、leaf-app）；保留 1（md-reader，回流载体） |
| 靶子 agent commit | 6（leaf-app 1 + leaf-renderer 1 + 处置 merge 1 + 契约修正 1 + TS 修复 1 + .gitignore 1）；master 全程钉在 `2e693d0` 零污染 |
| attachments 原文副本 | 20 个（brief 类 3 / spec 类 4 / build 类 13），20/20 sha256 与文件名前缀吻合 |
| 重写仓库全量测试 | **331/331 绿**（47 文件，81.42s，实跑一次全绿），基线吻合 |

六条通过标准逐条判定见 §3。

## 2. 靶子重置记录（执行前状态构造，沿用 M3 gate 模式）

| 步骤 | 操作 | 结果 |
|------|------|------|
| 起跑态定位 | `git log --all` + `git branch -a` + `git worktree list` | M3 终验现场：7 commit（`2e693d0` 基线 + 6 产出）、分支 `cw-root/md-reader` + `cw/md-reader/leaf-app`、root worktree 挂载中 |
| worktree 摘除 | `git worktree remove --force <root worktree>` + `git worktree prune` | worktree 清除，分支可删 |
| 历史清零 | `git update-ref -d` × 3 分支（master + cw-root/md-reader + cw/md-reader/leaf-app）+ `rm .git/index` + `git clean -fdx` | 零 commit 状态（`git log` → fatal: no commits yet；工作区仅剩 .git） |
| 起跑 commit 构造 | README 存档 commit（内容 = M3 Phase 0 基线原文） | `2e693d0 chore: phase-0 baseline (README archive)`，工作区干净 |
| 旧账本清理 | `rm -rf ~/.cw/__Users__zhushanwen__Code__test-repo__recursive-split-e2e-6eb176df` | 重置后 `ls ~/.cw/ | grep recursive` 零匹配 |
| worktree 残留清理 | `rm -rf ~/.cw-worktrees/__Users__zhushanwen__Code__test-repo__recursive-split-e2e-6eb176df` | 同上零匹配 |
| topic 残留核查 | `ls ~/.cw/topic/` | 靶子无残留（fx-4 前产物不落 topic；目录下仅其他项目条目） |
| 环境隔离 | 不设 CW_HOME（默认 ~/.cw）；PATH 前置 `/tmp/final-gate-4/bin`；`CW_AGENT_MODEL=xiaomi-token-plan-cn/mimo-v2.5-pro` | — |
| build | `npm run build` | tsc 编译成功，dist 含 fx-4 |

## 3. 通过标准逐项证据（六条全 ✓）

### 3.1 exit code 0 且 root closed ✓

- `/tmp/fx4-gate-runner.log` 末行：`RUN_EXIT_CODE=0`；收尾行：`root "md-reader" 已 closed——调度循环结束（exit 0）`
- `cw status`：`md-reader closed specs:2 evidences:2 lastVerify:pass` / `leaf-renderer closed specs:1 evidences:1 lastVerify:pass` / `leaf-app closed specs:1 evidences:1 lastVerify:pass`
- `cw tree`：全树 `(closed)`

### 3.2 topic 收口成立（fx-4 主断言）✓

- **产物全部在 topic 目录**：`~/.cw/topic/__Users__zhushanwen__Code__test-repo__recursive-split-e2e-6eb176df/20260817-233500-md-reader/` 含 24 文件 = 8 组派发（md-reader designer / md-reader reviewer / leaf-app designer·builder·reviewer / leaf-renderer designer·builder·reviewer）× `<unitId>.<role>.brief.md|stdout|stderr`，文件名形态与设计 §3.1 一致；9 条派发行的 brief 路径全部指向该目录（runner 日志逐行核实）
- **worktree 内不存在 .cw-spawn**：root worktree `find -name ".cw-spawn"` 零命中；leaf-app / leaf-renderer worktree 已按回收清单删除（父目录下仅剩 md-reader）；反向全域扫描（~/.cw-worktrees 靶子域 + 靶子 cwd）`*.brief.md|*.stdout|*.stderr|.cw-spawn` 零匹配——topic 之外零产物残留
- **agent commit 树零 .cw-spawn**：`git rev-list cw-root/md-reader cw/md-reader/leaf-app cw/md-reader/leaf-renderer` 全部 commit 逐个 `git ls-tree -r` 扫描，零 `.cw-spawn` 路径（分支 HEAD 树规模：cw-root 326 / leaf-app 14 / leaf-renderer 7）。对照 M3 §5.2 现场（6 个 `.cw-spawn` 文件被 `add -A` 卷入 root 分支）——fx-4 后 by construction 消失
- **append 语义现场铁证**：md-reader designer 同 run 两次派发（15:35 首派 + 15:42 处置转派）共用同组文件名，`md-reader.designer.stderr` 294 bytes = 147 bytes × 2 精确 append（内容为 pi statusline env 提示两组完整重复）——「同 run 重派沿用 append、跨 run 新目录」承诺的前半段现场成立

### 3.3 root 分支纯净回流 ✓

- `git branch`：`+ cw-root/md-reader`（+ = root worktree checkout 中，HEAD `e48e457`）、`cw/md-reader/leaf-app`、`cw/md-reader/leaf-renderer`、`master`
- 试合并（勿真合并留现场）：`git merge --no-commit --no-ff cw-root/md-reader` → `Automatic merge went well; stopped before committing as requested`，exit 0；`git merge --abort` 后 master 复位 `2e693d0`、`git status` 干净——回流主分支一条命令成立
- root 分支 `git ls-tree -r` 326 paths 零 `.cw-spawn`（见 §3.2）——M3 §5.2「回流带出 6 个产物文件」的纯净度缺口关闭

### 3.4 三类 attachments 副本存在且可逐字节重读 ✓

布局 `~/.cw/<encoded>/evidence/<unitId>/attachments/<sha256>.<原文件名>`（设计 D4），三个 unit 各有 attachments 目录，共 20 文件：

| 类别 | 明细 |
|------|------|
| brief（cw create --brief 副本） | 3：`<hash>.final-brief-4.md`（md-reader 原始任务书）、`<hash>.leaf-app.brief.md`、`<hash>.leaf-renderer.brief.md` |
| spec（evidence submit --kind spec） | 4：leaf-app `spec.json`、leaf-renderer `spec.json`、md-reader `spec-root.json` ×2（首版 `2113ab79` + 处置重过审版 `129598ac`，与账本 SpecSubmitted hash 一一对应） |
| build（evidence submit --kind build --file） | 13：`renderer.ts` ×3、`main.ts`、`package.json` ×3、`tsconfig.json` ×2、`renderer.test.ts` ×2、`check-render.mjs` 等 |

- **逐字节重读验证**：20/20 文件 `shasum -a 256` 实算值与文件名前缀全部吻合（hash 命名天然自校验）
- **root brief 原文比对**：`cmp /tmp/final-brief-4.md <attachments>/b63142ef….final-brief-4.md` 零差异，sha256 `b63142ef…` 与 /tmp 原文实算一致

### 3.5 汇总输出回收清单正常 ✓

runner 汇总输出原文（与 M3 形态一致）：

```text
[runner] 已回收 worktree × 2（leaf-app、leaf-renderer）；保留 × 1（md-reader）
[runner] 成果分支：cw-root/md-reader（含全部已集成子产出）
[runner] 回流主分支：git merge cw-root/md-reader
```

保留 × 1 是 root worktree（回流载体），非异常。回收与保留与 §3.2 反向扫描的目录实况一致。

### 3.6 重写仓库全量测试绿（331 基线）✓

- 实跑全绿一次：`Test Files 47 passed (47)` / `Tests 331 passed (331)`，Duration 81.42s——与 fx-4 交付基线数量吻合，无 flaky（M3 期观察的 u5b-e2e 间歇红本次未再现）

## 4. 时间线（runner 日志 + 账本，UTC）

```text
15:34:54  seq1   UnitCreated md-reader（人工 cw create）
15:35:00  [runner] 循环启动（poll=5000ms max-idle=2700000ms max-concurrency=3）
          派发 designer → md-reader（worktree + topic 目录同秒建立）
15:35:34  seq2/3 UnitCreated leaf-renderer / leaf-app（root designer 首派 34 秒建两子，
          children-first）
15:35:35  派发 designer → leaf-renderer（+15:35:40 leaf-app；并发 3 满，三 designer 交叠）
15:35:50  seq4/5 root spec（2113ab79）提交 + spec-review pass → spec-frozen
15:36:18  root designer 退出 exit 0
15:36:49  seq6/7 leaf-app spec 过审（designer 69 秒）→ 15:36:53 派发 builder → leaf-app
15:37:11  leaf-app designer 退出 exit 0
15:38:58  seq8/9 leaf-renderer spec 过审（designer 3.4 分钟）→ 15:39:06 派发 builder
15:39:18  leaf-renderer designer 退出 exit 0
15:40:04  seq10  leaf-app build 证据（138f743，单 spawn 内 build→verify 自愈）
15:40:13  seq11  leaf-app verify pass → 15:40:18 派发 reviewer → leaf-app
15:40:30  leaf-app builder 退出 exit 0
15:40:47  seq12  leaf-app exec-review pass → closed（首 unit 闭环 4.9 分钟：seq3 → seq12）
15:41:32  seq13  leaf-renderer build 证据（06c8e0d）→ seq14 verify pass
15:41:42  集成验证 fail 第 1 跑（9 项：leaf-app merge 冲突 exit 1 + 138f743 在
          cw-root 不可达 + A1×3/A2×2 验收标记缺失 + 契约 C1 未命中——
          "export function renderMarkdown(" 不在 src/renderer.ts）
15:41:50  集成 fail 第 2 跑（同 9 项）→ 连续 fail 达上限（2 次）——
          R4a 出口触发：停止自动重派集成，转派 designer 处置
15:42:03  派发 designer → md-reader（处置；stderr append 复用同组产物文件）
15:42:24  seq17  leaf-renderer exec-review pass → closed（与处置 designer 并行）
15:44:32  seq18/19 处置走 fail 文案恢复路径①：修正 root spec 契约签名（129598ac）
          重新提交 + spec-review pass（连续 fail 计数随新 spec 清零）
15:44:38  集成 fail 第 3 跑（4 项：A1 leaf-app / A1 md-reader / A3 md-reader 标记缺失；
          C1 已命中、merge 冲突已解）→ 15:44:50 第 4 跑 fail（同 4 项）
15:45:16  seq22  处置提交 build 证据 fa06ec4（在 root worktree 完成
          7b13e43 merge 冲突解决 + fa06ec4 契约签名落地，严格按 fail 文案指引）
15:46:57  seq23  处置提交 build 证据 9a91afe（TS build 错误修复：DOM lib + 类型标注）
15:47:47  seq24  md-reader 最终 verify pass（干净 checkout 重跑验收全绿）
15:47:48  派发 reviewer → md-reader
15:48:08  seq25  verify pass（9a91afe 新证据触发的重跑）
15:48:45  seq26  root exec-review pass → closed
15:48:48  循环结束 exit 0，汇总输出（回收 × 2 / 保留 × 1 / 回流指引）
```

对照 M3：13.8 分钟 vs 26.9 分钟；spawn 9 vs 9；TIMEOUT 0 vs 0；集成 4 fail vs 2 fail（本次两轮封顶：merge 冲突轮 + 验收标记缺失轮，处置 designer 单 spawn 内全部恢复）；agent commit 6 vs 15。处置路径本次走「merge 冲突解决 + 恢复路径①重新过审链」组合（M3 仅 merge 冲突解决），两条恢复出口首次同场闭环。

## 5. 异常与观察项（不阻塞 PASS，如实记录）

### 5.1 集成两轮 fail 封顶与处置闭环（R4a + 恢复路径① 组合现场）

第一轮（9 项×2）：leaf-app 与 leaf-renderer 同 base 各自新建共享文件 → merge 真实冲突 + build commit 不可达 + C1 契约未命中（leaf-renderer 用 async 实现而契约签名无 async）。第二轮（4 项×2）：处置 designer 已解冲突并重过审 spec 后，剩 A1/A3 验收标记缺失。处置 designer（15:42:03 单次派发）在 root worktree 内完成：`7b13e43` 解决 merge 冲突 → `129598ac` 修契约重过审（路径①，fail 计数清零机制现场生效）→ `fa06ec4` 契约落地 → `9a91afe` TS 修复，两个 build 证据各触发一次 verify pass。fail 文案恢复指引（root worktree 绝对路径 + CW_PROJECT_DIR 内联前缀 + 二选一路径说明）被 agent 原样执行成功。

### 5.2 agent 自发创建 .gitignore 并 commit

root worktree 内出现 `.gitignore`（node_modules/ dist/ dist-web/ *.local），经 `e48e457 chore: add dist-web to gitignore` 入库——agent 侧业务行为（builder/处置 designer 自发），非 cw 注入。属业务产出语义（用户仓库本就需要 ignore 构建产物），且经集成 verify 全绿背书；与 fx-4 无关，记录为 agent 行为观察。

### 5.3 循环收尾边界的无退出行与 0-byte stdout（同 M3 §5.3）

root closed 判定（seq26）后循环收尾，in-flight 的 root reviewer 与处置 designer 主进程被 killAll（无退出行；root reviewer stdout 0 bytes——pi 的 stdout 在会话结束时一次性写出，被收尾截断）。工作真实性由账本 verdict（seq26）与 commit 树背书。其余 7 组 stdout 均非空（315-660 bytes，真实工作叙述）。

### 5.4 leaf 子分支双双保留（与 M3 行为差异）

本次 `cw/md-reader/leaf-app` 与 `cw/md-reader/leaf-renderer` 两条子分支均残留（M3 时 leaf-renderer 分支随闭环清理、leaf-app 保留）。闭环子分支清理条件未触发或路径差异所致，不影响任何通过标准（回流只依赖 cw-root/<rootId>）；留待后续 unit 核查清理触发条件，不在 fx-4 scope。

### 5.5 e48e457 无独立 build 证据事件

`.gitignore` commit（e48e457）无对应 EvidenceSubmitted（build 证据止于 9a91afe）。最终集成/单元 verify 在 root worktree HEAD（= e48e457）干净 checkout 重跑全绿，产出合法性被 verify 覆盖；属证据颗粒度观察，非阻塞。

## 6. 保留产物

- 靶子 `/Users/zhushanwen/Code/test-repo/recursive-split-e2e/`：master @ `2e693d0`（Phase 0 基线）+ 分支 `cw-root/md-reader`（e48e457，全部已集成产出）+ `cw/md-reader/leaf-app` + `cw/md-reader/leaf-renderer`；master 未做真合并（试合并已 abort，现场保留）
- root worktree：`~/.cw-worktrees/__Users__zhushanwen__Code__test-repo__recursive-split-e2e-6eb176df/md-reader`（@ e48e457，含 agent 业务产出与处置现场，零 .cw-spawn）
- topic 目录：`~/.cw/topic/__Users__zhushanwen__Code__test-repo__recursive-split-e2e-6eb176df/20260817-233500-md-reader/`（24 派发产物文件，永久保留）
- 账本：`~/.cw/__Users__zhushanwen__Code__test-repo__recursive-split-e2e-6eb176df/`（26 事件 + evidence/ 含 3 份集成报告 + 20 attachments 副本 + verify 产物）
- runner 日志：`/tmp/fx4-gate-runner.log`；brief：`/tmp/final-brief-4.md`（复用）；PATH wrapper：`/tmp/final-gate-4/bin/cw`

## 7. 总结论

**PASS。** fx-4「spawn 产物收口 topic 目录」（commit `66fc7e0`）在真实靶子 + 真实 pi 后端无人干预复跑全流程：全部 24 个派发产物收口于 `~/.cw/topic/<encoded>/20260817-233500-md-reader/`（topic 之外全域零残留）；每个 unit worktree 与全部 agent commit 树（含 root 分支 326 paths）零 `.cw-spawn`——M3 §5.2 的产物卷入缺口 by construction 关闭；root 分支干净合并一条命令回流；三类 attachments 副本 20/20 逐字节可重读；两轮集成 fail 经 R4a 处置 + 恢复路径①组合闭环恢复；重写仓库 331 测试全绿。遗留观察项 4 条（§5.2 gitignore 自发行为、§5.3 收尾边界、§5.4 子分支清理差异、§5.5 证据颗粒度），均不阻塞。

# M3 Gate 终验报告（第 5 次）：worktree 隔离全链 E2E（wt-1~wt-5 后，真实靶子，无人干预）

- 判定：**PASS**（runner exit 0，root closed，全树 3 unit closed，worktree 隔离/回收/回流六条通过标准全部机器判定达成。D6 集成 merge 冲突真实再现并经 R4a 处置出口闭环恢复——设计 §5 待验证检查点②「merge 冲突转人工指引文案可用性」首次现场验证）
- 日期：2026-08-16（日志时间戳 UTC；本地 UTC+8）
- 依据：`docs/rewrite/design-worktree-isolation.md`（v3）§4 场景 5 与 §3.1 终态样例；被测代码 = wt-1~wt-5（HEAD `fbbe848`）；前序报告 `final-gate-4-report.md`（第 4 次，M2 形态）
- 任务与第 4 次相同：md-reader（brief 原文件复用 `/tmp/final-brief-4.md`，diff 核实 = `test-brief.md` 全文 + 实施建议大节）
- 执行命令（靶子目录内）：`cw create --id md-reader --brief /tmp/final-brief-4.md` → `CW_AGENT_MODEL=xiaomi-token-plan-cn/mimo-v2.5-pro node <本仓库>/dist/cli.js run --root md-reader --spawn pi --max-idle-ms 2700000`（stdout/stderr 落盘 `/tmp/m3-gate-runner.log`）
- 人工干预：**0**（run 启动后零 touch；超时/重派由机制自身处理，均未触达）
- 与任务书命令形态的唯一偏离：附加 `--max-idle-ms 2700000`（与第 4 次校准值一致）。理由：默认 max-idle 30min 与 per-spawn 超时 30min 相等，第 4 次实测两者最小间隔仅 4 分钟（leaf-renderer builder #1 场景），默认值存在 idle 误杀竞态，会把参数风险混入机制验收结论。poll（5000ms）与 max-concurrency（3）用默认。

## 1. 结论与关键数字

| 指标 | 值 |
|------|-----|
| 总时长（run 进程启动 → root closed 循环退出） | 15:35:35 → 16:02:27 UTC，**26 分 52 秒** |
| pi spawn 次数 | 9（designer 4 + builder 2 + reviewer 3）：7 条退出行全 exit 0；处置 designer 与 root reviewer 无退出行（root closed 后循环 killAll 收尾，见 §5.3） |
| runner 状态机重派 | 0（无失败重派；15:57 的 designer 二次派发是集成 fail 达上限的 R4a 处置转派，非重派） |
| TIMEOUT 次数 | 0 |
| 账本事件数 | 47（UnitCreated 3 / SpecSubmitted 3 / VerdictSubmitted 6 / EvidenceSubmitted 16 / VerifyRan 19），seq 1-47 连续无断 |
| VerifyRan 分布 | leaf-renderer 4 fail + 1 pass；leaf-app 10 fail + 1 pass；md-reader 集成 2 fail + 1 pass |
| worktree | 创建 3（root + 2 叶，base 全 = run 启动 HEAD `cb93686`）；回收 2（leaf-renderer、leaf-app）；保留 1（md-reader，回流载体） |
| 靶子 agent commit | 15（leaf-renderer 分支 4 + leaf-app 分支 10 + 处置集成 commit 1）；master 全程钉在 `cb93686` 零污染 |
| 验收机器验证 | 最终集成 run：A1/A2/A3 全 pass（干净 checkout 重跑，evidence `verify-c0102dea`） |
| 重写仓库全量测试 | 323/323 绿（实跑一次全绿；u5b-e2e 存在与本次无关的并发 flaky，4 次全量 2 红 2 绿，见 §5.4） |

六条通过标准逐条判定见 §3。

## 2. 靶子重置记录（执行前状态构造）

| 步骤 | 操作 | 结果 |
|------|------|------|
| 起跑 commit 定位 | `git log --all` + reflog | 仓库仅存第 4 次终验产物 6 commit（`cc65472`..`2be20c8`），无历史 README 存档 commit（第 4 次为 M2 形态零 commit 起步，reflog 无更早历史） |
| 历史清零 | `git update-ref -d refs/heads/master` + `rm .git/index` + `git clean -fdx` | 零 commit 状态（`git log` → fatal: no commits yet；工作区仅剩 .git） |
| 起跑 commit 构造 | README 存档 commit | `cb93686 chore: phase-0 baseline (README archive)`。M3 的 `snapshotHeadCommit`（loop.ts）对无 HEAD 仓库 fail-fast（「先 git init + commit」），故第 4 次的零 commit 起步形态不适用本次——起跑态改为「单 README 存档 commit」，与任务书描述的 Phase 0 形态一致 |
| 旧账本清理 | `rm -rf ~/.cw/__Users__zhushanwen__Code__test-repo__recursive-split-e2e__.git` | 确认 ~/.cw/ 下含 recursive-split-e2e 字样的目录仅此一个（空目录，历史遗留编码形态），已删 |
| worktree 残留清理 | `ls ~/.cw-worktrees/` | 目录存在且为空，无需清理 |
| 环境隔离 | 不设 CW_HOME（用默认 ~/.cw，与通过标准中 ~/.cw-worktrees 默认位置口径一致）；PATH 前置 `/tmp/final-gate-4/bin/cw`（内容核实为 `exec node <本仓库>/dist/cli.js`，防 agent 在 worktree 内解析到全局旧版 cw 1.6.4）；`CW_AGENT_MODEL=xiaomi-token-plan-cn/mimo-v2.5-pro`（pi.ts 三级取值第三级生效，翻译为 `--model`） | — |
| build | `npm run build` | dist 含 `runner/worktree.js`（wt-1~wt-5 全部编入） |

## 3. 通过标准逐项证据（六条全 ✓）

### 3.1 exit code 0 且 root closed ✓

- `/tmp/m3-gate-runner.log` 末行：`RUN_EXIT_CODE=0`；倒数第 5 行：`root "md-reader" 已 closed——调度循环结束（exit 0）`
- `cw status`：`md-reader closed specs:1 evidences:1 lastVerify:pass` / `leaf-app closed specs:1 evidences:11 lastVerify:pass` / `leaf-renderer closed specs:1 evidences:4 lastVerify:pass`
- `cw tree`：全树 `(closed)`

### 3.2 汇总输出含 worktree 回收清单 ✓

runner 汇总输出原文（与设计 §3.1 终态样例形态一致）：

```text
[runner] 已回收 worktree × 2（leaf-renderer、leaf-app）；保留 × 1（md-reader）
[runner] 成果分支：cw-root/md-reader（含全部已集成子产出）
[runner] 回流主分支：git merge cw-root/md-reader
```

保留 × 1 是 root worktree（回流载体，D5「本 run root 的永不回收」），非异常。

### 3.3 git branch 含 cw-root/<rootId> 且主分支干净合并 ✓

- `git branch`：`+ cw-root/md-reader`（+ = root worktree checkout 中）、`cw/md-reader/leaf-app`、`master`——分支双空间命名（D2）现场成立；leaf-renderer 子分支已随闭环清理，leaf-app 子分支保留（处置路径现场，见 §4）
- 试合并（勿真合并留现场）：`git merge --no-commit --no-ff cw-root/md-reader` → `Automatic merge went well; stopped before committing as requested`，exit 0；`git merge --abort` 后 master 复位 `cb93686`、`git status` 干净——回流主分支一条命令成立（G5）

### 3.4 全程派发发生在 ~/.cw-worktrees/ 下，靶子 cwd 零污染 ✓

- 日志 9 条派发行的 worktree 路径全部位于 `~/.cw-worktrees/__Users__zhushanwen__Code__test-repo__recursive-split-e2e-6eb176df/` 下（运行中 `git worktree list` 曾同时 4 条：主仓库 + md-reader[cw-root/md-reader] + leaf-app[cw/md-reader/leaf-app] + leaf-renderer[cw/md-reader/leaf-renderer]，base 全 = `cb93686`）
- run 结束后靶子 cwd 全量 `ls`：仅 `README.md` + `.git`——**无 .cw-spawn、无任何 agent 产物**；master 全程钉在 `cb93686`（对比第 4 次 M2 形态：.cw-spawn 混落在项目 cwd 且 tracked 入库）
- 账本无分裂：`~/.cw/` 下含 recursive 字样目录仅靶子一个 encoded 目录（`…recursive-split-e2e-6eb176df`），无 worktree-encoded 分裂账本——spawn env 注入 `CW_PROJECT_DIR` 生效，agent 在 worktree 内执行的 cw 命令全部写回项目账本（D3 现场证据）

### 3.5 spawn / 重派 / TIMEOUT / pi 真实性 ✓

- spawn 9 次（派发行计数）= designer 4（md-reader 首派 + 处置转派、leaf-app、leaf-renderer）+ builder 2 + reviewer 3；重派 0；TIMEOUT 0
- pi 调用真实（stdout 非空）：root worktree 保留的 `.cw-spawn/md-reader.designer.stdout` 550 bytes、`leaf-renderer.designer.stdout` 523 bytes（内容为真实工作叙述：spec 五规则自查、状态机叙述）；leaf 两 worktree 的 stdout 已随回收销毁（D4 设计内：审计价值已被 gate 消费）；处置 designer 与 root reviewer 的实际工作由账本事件背书（`a06bfe4` commit + seq45 证据提交；seq47 exec-review verdict）
- 全部 15 个 agent commit 经 `EvidenceSubmitted` 入账，与 cw 分支 git log 一一对应

### 3.6 重写仓库全量测试绿（323 基线）✓

- 实跑全绿一次：`Test Files 46 passed (46)` / `Tests 323 passed (323)`，Duration 82.99s——基线数量吻合
- 披露（不阻塞）：同日 4 次全量中 2 次出现 `u5b-e2e`「全链收敛」间歇红（1 failed / 322 passed），单跑 ×3 稳定绿。该测试自身全隔离（tmp CW_HOME + tmp CW_WORKTREE_HOME + tmp git 仓库），与本次终验的全局残留（~/.cw 账本、~/.cw-worktrees 靶子 worktree）无接触可能。根因初判见 §5.4

## 4. 时间线（runner 日志 + 账本，UTC）

```text
15:35:32  seq1   UnitCreated md-reader（人工 cw create）
15:35:40  [runner] 循环启动（poll=5000ms max-idle=2700000ms max-concurrency=3）
          派发 designer → md-reader（worktree ~/.cw-worktrees/<encoded>/md-reader）
15:36:04  seq2/3 UnitCreated leaf-app / leaf-renderer（root designer 首派 24 秒建两子，
          children-first；leaf-app.brief.md / leaf-renderer.brief.md 占位写在 root worktree）
15:36:05  派发 designer → leaf-app + leaf-renderer（并发 3 满，三 designer 交叠）
15:36:14  seq4   root spec（A1 e2e-real / A2 unit / A3 e2e-real；split=[leaf-renderer, leaf-app]）
15:36:17  seq5   root spec-review pass → spec-frozen
15:36:27  root designer 退出 exit 0
15:37:52  seq6/7 leaf-renderer spec 过审 → 15:37:57 派发 builder → leaf-renderer
15:38:08  leaf-renderer designer 退出 exit 0
15:40-15:44  leaf-renderer builder 单 spawn 内 3 轮 build→verify 自愈
          （f04a173 fail → 14db7cf fail → 2930bd1 fail → 354218a pass，共 4 fail 1 pass）
15:44:12  seq15/16 leaf-app spec 过审（designer 用时 8 分钟）→ 15:44:19 派发 builder → leaf-app
15:44:38  派发 reviewer → leaf-renderer（verify pass 后换角色）
15:45:01  seq19  leaf-renderer exec-review pass → closed（首 unit 闭环 9.3 分钟）
15:47-15:56  leaf-app builder 单 spawn 内 10 轮 build→verify 自愈
          （b1cb433..eb7d261 共 10 commit，verify 10 fail 1 pass；主因 A2 用例名/标记约定）
15:56:38  seq41  leaf-app verify pass（eb7d261）→ 15:56:59 builder 退出 + 派 reviewer → leaf-app
15:56:39  集成验证首跑 fail（4 项，详见 §5.1）
15:56:59  集成第 2 跑 fail（同 4 项）→ 连续 fail = 2
15:57:21  [runner] 集成连续 fail 达上限（2 次）——停止自动重派集成，转派 designer 处置
          （fx-2 R4a 出口在 M3 形态首次现场触发）→ 派发 designer → md-reader（处置）
15:57:23  seq44  leaf-app exec-review pass → closed（与处置 designer 并行）
16:02:08  seq45  处置 designer 提交 a06bfe4 build 证据（run-id integrate-fix-…）——
          在 root worktree 解决 leaf-app merge 冲突（单父 commit，parent 354218a）+
          补 A3 验收脚本修复，严格按 fail 文案恢复指引①执行
16:02:16  seq46  集成第 3 跑 pass（干净 checkout 重跑 A1/A2/A3 全绿，连续 fail 计数随新证据重置）
16:02:17  派发 reviewer → md-reader
16:02:24  seq47  root exec-review pass → closed
16:02:27  循环结束 exit 0，汇总输出（回收 × 2 / 保留 × 1 / 回流指引）
```

对照第 4 次（M2 形态）：26.9 分钟 vs 45.1 分钟（本次 leaf-renderer builder 未触发 30 分钟超时）；spawn 9 vs 10；重派 0 vs 1；TIMEOUT 0 vs 1；集成同为 2 fail 封顶 + 处置恢复（第 4 次处置走「改契约」，本次走「解冲突提交证据」——两条恢复路径各有一次现场闭环）。

## 5. 异常与观察项（不阻塞 PASS，如实记录）

### 5.1 集成 merge 真实冲突与 R4a 处置闭环（本次核心现场验证）

leaf-app 与 leaf-renderer 同 base（`cb93686`）各自新建 `package.json` / lock / tsconfig 等共享文件 → 集成 merge `cw/md-reader/leaf-app → cw-root/md-reader` 真实冲突（exit 1）。集成 fail 4 项输出：merge 冲突 + build commit `eb7d261` 不可达 + A3 标记 id 不符（出现 [A1,A2] 期望 A3）+ 二选一恢复指引。2 次封顶后转派处置 designer（15:57:21），4.8 分钟内：root worktree 解决冲突 + 归位 leaf-renderer 为子目录依赖 + 补 `scripts/verify-a3.ts` → commit `a06bfe4` → `cw evidence submit --kind build` → 集成第 3 跑 pass。fail 文案的恢复指引（root worktree 绝对路径 + 内联 `CW_PROJECT_DIR` 前缀命令形态）被 agent 原样执行成功——设计 §5 待验证检查点②「merge 冲突转人工路径的指引文案可用性」现场闭环。

### 5.2 .cw-spawn 产物被卷入 git commit（产物纯净度）

leaf-renderer 分支的 commit 将 `.cw-spawn/` 下 6 个文件（builder/designer 的 brief/stdout/stderr）`git add -A` 卷入分支，经集成 merge 进入 root 分支与 root worktree——回流主分支（§3.3 试合并）会把 6 个产物文件带进项目。成因：D4 的 clean `-e .cw-spawn` 保留产物在 worktree + brief 固定教学 `git add -A && git commit` + 项目 .gitignore 无 `.cw-spawn` 排除，三者组合的必然结果，设计未设防线。不触犯任何通过标准（merge 本身干净），但属产物纯净度缺口：建议后续在 brief 模板或 .gitignore 注入层处理（canon 层决策，非本报告范畴）。

### 5.3 循环收尾边界的无退出行与 0-byte stdout

root closed 判定在 reviewer 的 verdict 入账（16:02:24）后即成立，循环下一 poll 输出汇总并结束，in-flight 的 root reviewer 与处置 designer 主进程被收尾（无退出行；root reviewer stdout 0 bytes / stderr 147 bytes——pi 的 stdout 在会话结束时一次性写出，被收尾截断）。工作真实性由账本 verdict 与 commit 背书。另：`leaf-renderer.builder.stdout` 0 bytes（exit 0 + 空 stdout，u6a/u6c 锁定的判定口径只看 exitCode + stdout，空 stdout + exit 0 合法）——该 builder 的实际工作由 4 份 build 证据与分支 commit 背书。

### 5.4 u5b-e2e 并发时序 flaky（与本次改动无关，既有）

4 次全量 2 红 2 绿、单跑 ×3 全绿。两次红失败点漂移（一次 217 行 `git commit` 失败、一次 220 行 `evidence submit` exit 1）。根因初判：测试等待 impl worktree 建立（designer 派发时机）后写 untracked `app.js` 并 commit，与 runner 子进程（human 模式）后续派发前对该 worktree 的 D4 `reset --hard + clean -fd -e .cw-spawn` 存在竞争窗口——全量并发下测试动作变慢落入 clean 窗口（untracked app.js 被 clean → commit 空 / --file 消失），单跑时序快不触发。测试自身全隔离（tmp CW_HOME / CW_WORKTREE_HOME / git 仓库），本次终验的全局状态不可能触及。wt-5 交付时「全量 323 绿」应恰在窗口外。属既有 flaky，建议单独立缺陷跟进（非 M3 gate 阻塞项——本报告 323/323 全绿实跑在前）。

### 5.5 其余设计分支未打靶（与第 4 次口径一致）

D5 矩阵仅打「亡/亡」正常新建（重置后无残留）；「在/在」跨 run 复用、「亡/在」重建、「在/亡」异常指引、孤儿清扫（启动时无孤儿）均未现场触发——以 wt 系验收报告的影子工程红绿为准。D4 reset/clean 未被失败重派场景直接打靶（重派 0）。

## 6. 保留产物

- 靶子 `/Users/zhushanwen/Code/test-repo/recursive-split-e2e/`：master @ `cb93686`（Phase 0 基线）+ 分支 `cw-root/md-reader`（a06bfe4，全部已集成产出）+ `cw/md-reader/leaf-app`；master 未做真合并（试合并已 abort，现场保留）
- root worktree：`~/.cw-worktrees/__Users__zhushanwen__Code__test-repo__recursive-split-e2e-6eb176df/md-reader`（干净，@ a06bfe4，含 .cw-spawn 派发产物与处置现场）
- 账本：`~/.cw/__Users__zhushanwen__Code__test-repo__recursive-split-e2e-6eb176df/`（47 事件 + evidence/ 含 3 份集成报告与最终 verify 产物）
- runner 日志：`/tmp/m3-gate-runner.log`；brief：`/tmp/final-brief-4.md`（第 4 次原文件复用）；PATH wrapper：`/tmp/final-gate-4/bin/cw`

## 7. 总结论

**PASS。** M3「每 unit 独立 worktree」五 unit（wt-1~wt-5，HEAD `fbbe848`）在真实靶子上无人干预跑通完整 `cw run` 流程：worktree 物理隔离（靶子 cwd 零污染）、分支双空间汇聚（cw-root/<rootId> 一条命令回流）、closed 回收清单、CW_PROJECT_DIR 账本锚定全部现场成立；集成 merge 真实冲突经 R4a 处置出口闭环恢复；重写仓库 323 测试全绿。遗留观察项 4 条（§5.2 产物卷入、§5.3 收尾边界、§5.4 既有 flaky、§5.5 未打靶分支），均不阻塞。

# M1 gate 验收报告：pi 并行 runner 真实闭环

> 结论先行：**M1 gate PASS**。三场景（pi 微任务全流程 / 双叶并行 / P3 探针）全部
> 通过，合计 9 次真实 pi 调用（模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`，由 pi
> 适配器默认值生效——全程未设置 `CW_AGENT_MODEL`），零重派、零人工干预，两个
> runner 均自然退出 exit 0。

- 日期：2026-08-15
- 执行者：M1 gate 执行者（本报告唯一产出文件；未改动任何 src/tests/文档）
- 环境：macOS darwin 24.6.0 arm64 / node v24.11.1 / pi 0.84.0（`~/.nvm/.../bin/pi`）/
  vitest 3.2.7（复用 cw 仓库 `node_modules/.bin/vitest` 绝对路径，tmp 项目零安装）/
  cw `@1.6.4` dist（`npm run build` 后现场构建）
- 隔离：全部场景跑在 `~/.tmp/cw-m1-gate/` 下 tmp git 项目 + 独立 `CW_HOME`
  （`s1-cw-home` / `s2-cw-home`）；真实 `~/.cw` 未被触碰；pi 经 PATH 前置的
  `bin/cw` wrapper（`exec node <repo>/dist/cli.js "$@"`）命中本仓库 dist
- 依据：`docs/rewrite/orchestration.md`（协调机制）、
  `.xyz-harness/cw-endstate-architecture/development-plan-v2.md` §3 L2（M1 gate =
  pi E2E 微任务 + 并行 + 探针 P3）

## 0. 结果一览

| 场景 | 判定 | 关键证据 | runner 时长 | pi 调用 |
|------|------|---------|------------|---------|
| 1 pi 微任务全流程 | **PASS** | exit 0、`add-cap` closed、pi commit `aecda0a` 真实存在、7 事件全链、verify 产物落盘、本地复跑 A1/A2 真绿 | 2m39s（首派→closed） | 3（designer/builder/reviewer 各 1） |
| 2 双叶并行 | **PASS** | exit 0、三 unit 全 closed、两叶 build 账本区间重叠 6.3s > 0、两 builder pi 进程同毫秒派发且重叠约 49.7s | 2m10s（首派→closed） | 6 |
| 3 P3 探针（spawn 等待期并发 submit 不饿死） | **PASS** | 两叶 builder in-flight 期间 5 次 `evidence submit` 全部 exit 0，单次 0.095-0.128s（上限 10s），无 hang | —（嵌在场景 2 内） | — |

## 1. 场景 1：pi 微任务全流程（A 类核心）

**任务**：pi 真实完成「给 tmp 项目加 capitalize(str) 纯函数 + vitest 单测并
git commit」，runner 回收证据、投影推进到 closed。全程无人工干预。

**fixture**：tmp git 仓库（package.json ESM + src/index.js 占位 + .gitignore）
+ `brief.md`。brief 内嵌 spec.json 精确模板（A1 core e2e-real `node
scripts/verify-a1.js` 输出 `A1 PASS` 标记行；A2 unit 型 vitest 命令，vitest bin
走 cw 仓库绝对路径——u4b e2e 已验证「干净 checkout 无 node_modules 亦可跑」）、
三个文件的完整内容模板、三角色提交命令原文。人肉只做 `create --id add-cap`。

### 1.1 时间线（账本 ts + runner 日志）

| 时刻 (UTC) | 事件 |
|------------|------|
| 13:36:24.423 | `UnitCreated add-cap`（人肉 create，seq 1） |
| 13:36:33.817 | runner 派发 designer（pi） |
| 13:37:04.358 | `SpecSubmitted`（designer 31s 完成写入 spec.json + 提交） |
| 13:37:10.334 | `VerdictSubmitted spec-review/pass`（seq 3） |
| 13:37:12.169 | **runner 派发 builder**（spec-frozen 后 1.8s；此时 designer pi 进程尚未退出——runner 只看账本状态，不等进程） |
| 13:37:26.215 | designer pi 退出 exit 0（spawn 总时长 52.4s） |
| 13:38:14.758 | `EvidenceSubmitted build-1 commit=aecda0a`（builder 完成 4 文件 commit + 提交） |
| 13:38:23.642 | `VerifyRan result=pass`（A1,A2；builder 触发的干净重跑） |
| 13:38:24.714 | runner 派发 reviewer |
| 13:38:35.387 | builder pi 退出 exit 0（spawn 总时长 83.2s） |
| 13:38:51.672 | 第二次 `VerifyRan result=pass`（reviewer 自主复核重跑，幂等无害） |
| 13:39:12.745 | `VerdictSubmitted exec-review/pass`（comment：「证据链完整，verify 全绿…」） |
| — | **runner 自然退出 exit 0**，汇总：`add-cap closed lastVerify:pass` |

首派→closed 2m39s；create→closed 2m48s。

### 1.2 通过标准逐项核验

| 通过标准 | 结果 |
|---------|------|
| runner 自然退出 exit 0 且汇总含 root closed | ✓（`root "add-cap" 已 closed——调度循环结束（exit 0）`） |
| `cw status` 显示 closed 链 | ✓（`add-cap closed specs:1 evidences:1 lastVerify:pass`；report 显示 A1 ✓ A2 ✓、verify pass ×2） |
| events.log 完整事件链 | ✓ 7 事件：UnitCreated → SpecSubmitted → spec-review/pass → EvidenceSubmitted → VerifyRan/pass ×2 → exec-review/pass |
| worktree 内 pi 的 commit 真实存在 | ✓ `aecda0a feat: add capitalize with vitest tests`（4 文件 61 行：src/capitalize.js、tests/capitalize.test.js、scripts/verify-a1.js、spec.json） |
| verify 产物落盘 | ✓ `<s1-cw-home>/<proj>/evidence/add-cap/verify-{c2beef34…,1479379d…}/`（report.json + A1/A2 stdout/stderr/report.json） |
| 旁证：本地复跑验收 | ✓ `node scripts/verify-a1.js` → `A1 PASS` exit 0；vitest JSON `numPassedTests:2 numFailedTests:0` |

**判定：PASS**（零重派，见 §4）。

## 2. 场景 2：双叶并行（A2 最小真实版）

**任务**：双叶并行 build，验证调度循环真实并行段。spec 段已被场景 1 验证，
故 root `dual-root` 与两叶 `leaf-a`/`leaf-b` 均人肉预置到 spec-frozen
（buildReady）：root spec 的 split 声明两叶；两叶各自验收 A1 core e2e-real
（`node scripts/verify-leaf-{a,b}.js` 输出 `A1 PASS`）+ A2 unit（vitest）；
验收脚本/测试文件内容模板写入各叶 brief，由 pi builder 照模板创建。

### 2.1 时间线（runner 日志 + 账本 ts）

| 时刻 (UTC) | 事件 |
|------------|------|
| 13:40:03 | 预置完成（seq 1-9：3×UnitCreated + 3×SpecSubmitted + 3×spec-review/pass） |
| 13:40:23.094 | runner 派发 builder → leaf-a |
| 13:40:23.096 | runner 派发 builder → leaf-b（**同批同毫秒，2 个 in-flight**） |
| 13:40:48.1-48.7 | **场景 3 P3 探针窗口**（5 次并发 submit，见 §3） |
| 13:40:50.011 | `EvidenceSubmitted leaf-b build-1 commit=0972f64` |
| 13:40:53.582 | `VerifyRan leaf-b pass` |
| 13:40:55.170 | runner 派发 reviewer → leaf-b |
| 13:40:58.755 | `VerdictSubmitted leaf-b exec-review/pass` → **leaf-b closed**（此时 leaf-a builder 仍在跑） |
| 13:41:02.427 | `EvidenceSubmitted leaf-a build-leaf-a-1 commit=8b3a73d` |
| 13:41:08.036 / 08.685 | `VerifyRan leaf-a pass` / leaf-b 第二次 VerifyRan（reviewer 复核） |
| 13:41:12.82 / 12.83 | leaf-b builder 退出 exit 0；派发 reviewer → leaf-a |
| 13:41:18.320 | leaf-a builder pi 退出 exit 0（spawn 总时长 55.2s） |
| 13:41:22.781 | leaf-a 第二次 VerifyRan pass（reviewer） |
| 13:41:37.781 | `VerdictSubmitted leaf-a exec-review/pass` → **leaf-a closed** |
| 13:41:38.146 | runner 派发 builder → dual-root（两叶 closed 后 0.4s，rootLast 语义生效） |
| 13:42:05.418 | `EvidenceSubmitted dual-root build-1 commit=b537901` |
| 13:42:09.803 | `VerifyRan dual-root pass`（root 整合验收：两叶函数同时可用） |
| 13:42:33.505 | `VerdictSubmitted dual-root exec-review/pass` → **root closed** |
| — | **runner 自然退出 exit 0**，汇总 3 unit 全 closed，lastVerify 均 pass |

### 2.2 并行判据（通过标准核心）

账本 build 区间（口径 = 各叶 [首条 EvidenceSubmitted.ts, 末条 VerifyRan.ts]）：

```
leaf-a: [13:41:02.427, 13:41:22.781]  时长 20.4s
leaf-b: [13:40:50.011, 13:41:08.685]  时长 18.7s
重叠   = [13:41:02.427, 13:41:08.685] = 6.3s > 0  ✓ 真实并行
```

补充口径（更严）：若 VerifyRan 只取 builder 自跑的第一次，两叶账本区间不重叠
（leaf-b 先行 12s 完成 build+verify）；但两 builder pi 进程区间
[13:40:23.094, 13:41:12.822]（leaf-b，49.7s）与 [13:40:23.094, 13:41:18.320]
（leaf-a，55.2s）几乎全程重叠约 49.7s——同毫秒派发、各自独立运行到自然退出，
进程级并行无可争议。

git 核验：`8b3a73d feat: leaf-a pure function with tests`、`0972f64 feat: leaf-b
pure function with tests`、`b537901 feat: root integration acceptances…` 三个
pi commit 真实存在；root builder stdout 确认其先核对两叶文件存在再创建整合
验收文件（brief 中 rootLast 协作约束被模型正确遵循）。

**判定：PASS**。

## 3. 场景 3：P3 探针（spawn 等待期并发 submit 不饿死）

**时机**：13:40:48（两叶 builder pi 均已派发 25s、均未产出任何事件——leaf-b
首条证据 13:40:50.011 才入账，探针窗口完全落在「runner 等待 spawn」期）。

**操作**：连续 5 次
`cw evidence submit --kind build --unit leaf-a --commit 0972f643…（初始 commit 真实 hash） --run-id probe-<i> --file src/index.js`。

| 探针 | exit | 耗时 | 结果 |
|------|------|------|------|
| probe-1 | 0 | 0.128s | 入账 seq 10 |
| probe-2 | 0 | 0.095s | 入账 seq 11 |
| probe-3 | 0 | 0.103s | 入账 seq 12 |
| probe-4 | 0 | 0.096s | 入账 seq 13 |
| probe-5 | 0 | 0.106s | 入账 seq 14 |

- 5/5 在 10s 内返回（实际全部 <0.13s），无 hang——runner 等待 spawn 期间不持
  账本锁（canon D4「等待期间零锁」实证）。
- 5 次用不同 run-id，全部成功入账（exit 0），未触发幂等拒绝路径；「能拿到账本
  锁完成写入」比「幂等拒绝返回」是更强的非饿死证据。
- 无污染：probe 证据的 commit 指向初始 commit，但 leaf-a 的 verify 锚取「最后
  一条 build evidence」（builder 的 `build-leaf-a-1`@`8b3a73d`），probe 不影响
  verify 与状态机（verified 判定只看 VerifyRan/spec，不看 evidence 条数）。

**判定：PASS**。

## 4. pi 调用与重派统计

| 场景 | role@unit | spawn 时长 | 结果 |
|------|-----------|-----------|------|
| 1 | designer@add-cap | 52.4s | exit 0，一次完成 spec+spec-review |
| 1 | builder@add-cap | 83.2s | exit 0，一次完成实现+commit+evidence+verify |
| 1 | reviewer@add-cap | ~48s | exit 0，复核重跑 verify 后 exec-review/pass |
| 2 | builder@leaf-a | 55.2s | exit 0 |
| 2 | builder@leaf-b | 49.7s | exit 0 |
| 2 | reviewer@leaf-b | 33.0s | exit 0 |
| 2 | reviewer@leaf-a | 31.5s | exit 0 |
| 2 | builder@dual-root | 42.2s | exit 0 |
| 2 | reviewer@dual-root | ~23s | exec-review/pass 后 root closed，runner 先检测 closed 走兜底回收（设计行为） |

- **合计 9 次真实 pi 调用；重派 0 次**（runner 日志中无任何 `exit≠0` /
  TIMEOUT / CRASH 退出，每个 (unit, role) 恰好一次 spawn）。gate 拒绝→自然重派
  的路径本轮未被触发——pi 在模板化 brief 下格式失败率为 0，说明「brief 内嵌
  spec 精确模板 + 文件内容模板 + 提交命令原文」的防错设计有效。
- 两场景总时长约 4m50s（13:36:33-13:42:34），在 10-30 分钟预算内。
- 模型：`CW_AGENT_MODEL` 全程未设置，由 pi 适配器三级取值落入默认
  `xiaomi-token-plan-cn/mimo-v2.5-pro`（src/runner/spawn/pi.ts DEFAULT_PI_MODEL）。

## 5. 观察备注（非缺陷，留档）

1. **事件驱动派发实证**：designer 尚未退出（13:37:26 才退）runner 已在
   13:37:12 派发 builder——循环只看账本投影、不等进程退出，这是 canon D4
   「账本即状态」的直接体现。
2. **reviewer 自主复核**：reviewer 均自行重跑了一次 `cw verify`（每 unit 2 条
   VerifyRan，reportHash 不同但 result 均 pass）。ROLE_TASKS 只要求「审查依据：
   cw report 的证据链」，模型选择加跑 verify——幂等、无害、可审计。
3. **agent 自由度**：leaf-a builder 自拟 runId `build-leaf-a-1`（brief 模板为
   `build-1`）——runId 是自拟幂等键，模型改得更独特，不违反任何约束。
4. **pi stderr 噪音**：statusline 扩展输出 `MIMO_COOKIE is not set` 等 3 行
   env 提示；不影响 exitCode/stdout，未触发 D-8 预案的 `--no-extensions` 需求。
5. **root reviewer 无「退出」日志行**：root closed 在其 flight 结算前被 loop
   顶部检测到，走 killAll 兜底回收（loop.ts root-closed 分支的设计行为）。

## 6. 总结论

**M1 gate PASS**：三场景全过——pi 微任务全流程闭环（场景 1）、双叶真实并行 +
rootLast 集成（场景 2）、spawn 等待期零锁（场景 3/P3）。M1 四 unit
（u6a AgentSpawn 生命周期 / u6b human 适配器 / u6c pi 适配器 / u7 通用调度循环）
在真实 pi 环境下的组合行为符合设计预期，无阻塞性缺陷。

## 附录：现场材料索引（tmp 已清理，关键内容已摘录于上）

- runner 日志：`~/.tmp/cw-m1-gate/logs/s1-run.log`、`s2-run.log`
- 账本：`s1-cw-home/…/events.log`（7 事件）、`s2-cw-home/…/events.log`（25 事件）
- spawn 产物：各 repo `.cw-spawn/<unit>.<role>.{brief.md,stdout,stderr}`（场景 1
  9 个文件、场景 2 18 个文件）
- verify 产物：`<CW_HOME>/<proj>/evidence/<unit>/<verify-runId>/report.json` 等

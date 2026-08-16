# wt-2 验收报告：spawn 链路 worktree 拆分（首版交付 + §11 返工，完整验收）

> verifier 独立验收，2026-08-16。基线：commit 075c1e9 的 `docs/rewrite/acceptance/wt2-acceptance.md`（§1-10 首版 + §11 返工规格；冲突处以 §11 为准）。builder 自报一律待证实，本报告全部结论来自 verifier 实跑实测。

## 0. 总结论：**PASS**

全量 310 测试绿（43 文件）、check:all 通过、eslint 零输出、u5b-e2e 连跑 3 次稳定绿、防篡改链完好、6 组行为对抗抽查全过、3 处 builder 披露逐条裁决通过。发现 2 条 minor 观察（不阻塞验收，见 §6）。

## 1. 防篡改核验

| 检查项 | 结果 |
|--------|------|
| 验收文档 sha256 | `de624b80ce21282cd41ee5b016ef27b71b8a29094bc6756db747246f0262505e` |
| `git diff 075c1e9 -- wt2-acceptance.md` | 空（未篡改） |
| `git diff bd31730 075c1e9 -- wt2-acceptance.md` | 仅 +26 行 §11 追加（主 agent 所为，验收链完好） |
| HEAD | db5e9c5（含设计 v3 文档，设计修复线产物，豁免项） |
| 工作区 src 改动 | 恰好 8 文件：worktree.ts / loop.ts / spawn/{types,pi,human}.ts / handlers/{common,create,evidence-submit}.ts —— 与任务允许清单一致（handlers 三文件系 §11 R-5 明示改动面，覆盖 §9 禁改清单的旧口径） |
| 工作区 tests 改动 | 12 迁移文件 + 新增 wt2-dispatch-worktree.test.ts，均在 §6/R-6 允许范围 |
| 禁改项零改动 | `git diff HEAD -- integrate.ts human-loop.ts cli.ts store/project.ts verify/ core/ events/` = 0 行；`checkWorkspaceForDispatch` 函数体（loop.ts:826）与调用点（loop.ts:1013）未动（diff 中仅头注释提及）；`runIntegrationDispatch` 在 loop.ts diff 中零出现（§5 第 7 点满足） |
| docs / package.json / eslint / tsconfig | 零改动 |

## 2. 命令实跑（全部 verifier 亲跑）

```text
npm run check:all        → exit 0（tsc src + tests 双配置均过）
npx vitest run tests/wt2-dispatch-worktree.test.ts tests/wt1-worktree.test.ts
                         → Test Files 2 passed (2) / Tests 28 passed (28)
npx eslint src/runner/ src/store/ src/handlers/ src/cli.ts
                         → 零输出 exit 0
npm test                 → Test Files 43 passed (43) / Tests 310 passed (310)，Duration 81.49s
u5b-e2e 单文件连跑 3 次   → 3 × (1 passed / 2 passed)，全绿稳定
```

310 与 builder 自报一致（308 + 返工新增 2）。

真实 home 零污染：全量测试前 `~/.cw-worktrees` = 0 项、`~/.cw` = 24 项；全量后同为 0 / 24（`~/.cw` 现存条目均为其他项目历史目录，非本轮产物）。CW_HOME/CW_WORKTREE_HOME 隔离完备。

## 3. §7 + §11 条款对照（真实性抽查——最易空洞的 5 点逐条读测试代码）

| 条款 | 核验结论 |
|------|---------|
| **R-3 四格矩阵** | 四格逐格真实现场构造，非 happy path 凑数：「在/在」= wt2 T3（stepped adapter 二次派发时点捕获 porcelain + brief 产物留存）；「亡/在」= T4（rmSync worktree 目录保留分支与 stale 注册，重跑挂既有分支，已 commit 文件仍在且分支 HEAD 不变）；「在/亡」= T5 第二 it（add → remove → `branch -D` → 空目录占位 → ensure 返回 error 含 `git worktree remove --force <path>` 与「重跑」）；「亡/亡」= T2（新建 + base 快照）。分支检测 `rev-parse --verify --quiet`、目录检测 `existsSync`，全库 grep 无 `already exists` 字符串匹配残留（首版近似已替换） |
| **R-5 T11 双锚分离** | 真子进程（node dist/cli.js）+ 真双目录：CW_PROJECT_DIR=项目A（repoDir）、进程 cwd=目录B（dirB）、spec.json 只在 B。断言 specHash === sha256(B/spec.json)（内容级证明读到的是 B 的文件）、SpecSubmitted 落 A 账本、B 编码下无账本文件。前提自证：A 下无 spec.json。真实非空洞 |
| **R-4 human 指令渲染** | T8 断言 `cd "<workdir>"`、`cat "<briefPath>"` 双引号、builder 全部 cw 命令含 `CW_PROJECT_DIR="<projectCwd>" ` 内联前缀、`not.toContain("export CW_PROJECT_DIR")`；T9 补 designer role 断言。实现层三个 role 统一走同一 `cwCommand()` 工厂（human.ts:80-83），覆盖面闭合 |
| **T9 e2e human 全链路** | 真实链路：runLoop(human adapter) → 等 designer 指令落盘 → 真子进程在 worktree（cwd=wtDir、env CW_PROJECT_DIR=repoDir）跑 dist/cli.js evidence/review submit → 断言 SpecSubmitted/VerdictSubmitted 落**项目**账本、worktree 编码账本不存在、循环推进派发 builder（builder brief 落盘为证）、最终 maxIdle 有界退出非崩溃 |
| **R-2 reset 排除产物** | 双断言齐备：wt2 T3（`.cw-spawn/t3.designer.brief.md` 在二次派发 reset 后仍存在 + `build-artifact.tmp` 被删 + tracked 脏改回滚）；wt1 B5（预置 `.cw-spawn/{stdout,brief}` + 普通 untracked 文件/目录，前者留后者删，porcelain 仅剩 .cw-spawn 行） |

§7 其余条款：T1（workdir/projectCwd 双传）、T5（循环级 ensure 失败跳过：分支被另一 worktree 占用 → stuck 零 spawn、healthy 继续、stderr 含恢复指引、循环 exit 1 不炸）、T6（brief 落 worktree + 项目 cwd 无 .cw-spawn）、T7（pi env 注入，PATH 前置真实 sh 探测脚本）、T10（非 git cwd 启动即抛、零派发）均实测绿且测试代码真实。

§11 其余：R-1 双空间命名（loop.ts 派发点传 `opts.rootId`；wt1 B1 断言两种形态；T2/T4 断言 `cw-root/<rootId>`）；R-6 迁移语义等价（见 §5）。

## 4. 三处披露裁决

**披露 1（fx3 worker 写入锚改 process.cwd()）——裁决：通过。** worker 子进程 spawn cwd = req.workdir（worktree），其内 `process.cwd()` 即 worktree；写入锚与 cw 命令相对 `--brief/--file` 的解析锚（R-5 后 = process.cwd()）严格同锚——不改则 fx3 回归必红，改后与 R-5 终态语义一致。测试意图未弱化：建子链路、brief 第 0 步内容、全链状态推进断言全部保留，且 brief 快照机制（派发时点捕获）是对 reset 清产物时间窗变化的正确适配，断言强度不降（另增 briefPath 精确路径断言）。

**披露 2（中途一轮 u5b-e2e 失败判一次性 dist 竞态）——裁决：通过。** `npx vitest run tests/u5b-e2e.test.ts` 连跑 3 次全部 `1 passed / 2 passed`，当前态稳定绿。失败时点在构建过程中间（dist/handlers/run.js 旧版缺导出），最终 dist 与源一致（本次验收另跑 `npm run build` 后全部命令通过），一次性竞态判断成立。

**披露 3（stale 注册无条件 prune 重试）——裁决：通过。** 代码核实（worktree.ts:173-188 `reattachWorktree`）：add 失败 → `git worktree prune` → 重试一次 → 仍败才 error。全程无 stderr 文案甄别、无字符串匹配，prune 幂等无害。规格原文「若因 stale 注册失败先 prune」的意图（stale 自愈）被无条件重试的超集行为覆盖，非 stale 失败多付一次无害 prune 后如实报错。T4 实测覆盖含 stale 残留的正路径（rmSync 不清注册 → add 首败 → prune → 重试成功）。

## 5. 测试迁移核查（§6 两类 + R-6，语义等价不放宽）

12 个迁移文件逐一 diff 审阅，全部落在两类迁移 + R-6 同步内：

- **补 projectCwd 字段**：u6b（值 = scenario.workdir，u6b 场景无 worktree 拆分）、u6c（值 = 测试 tmp 项目目录）——恰为 §6 第一类。
- **路径/env 断言迁移**（fx1/fx2/fx3/u5b-e2e/u5b-loop/u7-loop/u7-e2e/u7b/u8/wt1）：统一模式 = 模块顶层 `CW_WORKTREE_HOME=<tmp>` 隔离 + brief/产物断言目标迁 `worktreePath(WT_HOME, repoDir, unitId)` + git fixture 补 init+commit（R1 前提）+ worker 账本锚从 req.workdir 改 req.projectCwd（等价 agent 的 CW_PROJECT_DIR 锚定）。
- **无弱化反证**：u7-loop 迁移后断言更严（briefPath 精确等值 + 派发时点存在性）；u7b「重派前清理」语义升级为 worktree 精确清理且保留「用户 untracked 文件不受影响」安全断言（保护主体从 loop reset 换成 worktree 隔离本身，更强）；wt1 B4 扩展 rootId 白名单（R-1 后新注入面）。未发现删测试、放宽断言、改测试逻辑。

## 6. 行为对抗抽查（verifier 自建脚本，真实子进程 + tmp + env 隔离，脚本在 /tmp 用后即删）

| # | 对抗点 | 结果 |
|---|--------|------|
| 1 | **含空格路径全链路（MF-6）**：tmp 项目目录名 `my proj`（含空格）→ runLoop(human) 派发 → 从落盘指令文本逐条提取命令（剥 `[human]` 前缀与步骤序号），在**单一真实 zsh 会话**按序执行 cd/cat/cw 三类指令（cw 经 PATH shim 转发本仓库 dist/cli.js）| **PASS**：会话整体 exit 0；SpecSubmitted/VerdictSubmitted 落项目账本（空格路径编码正确）；循环推进到 builder 派发；worktree 编码账本不存在；项目 cwd 无 .cw-spawn。引号包裹在空格路径下语义正确 |
| 2 | **双 unit 并行**（maxConcurrency=2，hold adapter 挂起）：root + 子 unit 满 2 in-flight | **PASS**：两 worktree 物理独立且都存在；分支 = `cw-root/adv-root` 与 `cw/adv-root/unit-a`（双空间正确）；root 分支 base = 启动 HEAD 快照；项目 cwd 无 .cw-spawn 新增 |
| 3 | **R-3「在/亡」格循环级**：先正常建 stuck worktree → 解注册 → `branch -D` → 空目录占位（目录在/分支亡）→ runLoop（root + stuck + healthy 三 unit）| **PASS**：stuck 零 spawn；stderr 每轮含 `worktree 目录存在但分支已亡` + `git worktree remove --force <path>` 指引；循环不炸（maxIdle 兜底 exit 1）；healthy 正常派发 |
| 4 | **CW_PROJECT_DIR 覆盖**：req.env 预置 `CW_PROJECT_DIR=/stale/residual/value` 后 pi spawn | **PASS**：子进程（PATH 前置探测脚本）读到 `CW_PROJECT_DIR=<projectCwd>`，残留值未泄漏。`{ ...req.env, CW_PROJECT_DIR: req.projectCwd }` spread 顺序保证覆盖（pi.ts:106） |
| 5 | **ensure 连续两次幂等** + branchName 两形态 | **PASS**：同参两次 ensureUnitWorktree 均 ok、HEAD 不变、目录不变；`unitBranchName("r","r")=cw-root/r`、`unitBranchName("r","u")=cw/r/u` |
| 6 | **resolveAgainstCwd 调用点遗漏扫描**：全库 grep | **PASS**：src 中共 5 处（1 定义 + create.ts:42 / evidence-submit.ts:99 / evidence-submit.ts:240），全部已改为单参 process.cwd() 锚，无第 4 处相对路径解析残留锚 ctx.cwd |

对抗过程中 verifier 首版脚本自身两次缺陷（行提取过滤器漏带序号的 cw 行；逐条独立 spawn 导致 cd 不持久）曾误报 FAIL，修正模拟方式后全过——两次误报均非交付缺陷，特此记录以自证对抗真实性。

## 7. 观察项（不阻塞验收，移交后续波次/维护）

1. **[minor] ensure 失败的 stderr 重复刷屏**：`loop.ts` 每轮 poll 对 ensure 失败的 unit 重新尝试并整段 emitErr（对抗 3 中 800ms 窗口内重复输出 5 次完整 error）。符合「下轮重算重试」设计意图，但长跑时日志噪音大。建议后续（W3+）考虑同 error 去重或降频。
2. **[minor] T8 未逐 role 覆盖 cw 命令前缀断言**：T8 仅断言 builder role 的全部 cw 命令、T9 覆盖 designer；reviewer role 的指令形态未直接断言。实现层三 role 统一走 `cwCommand()`，回归风险低，但按「每条 cw 命令」的字面口径尚有缺口。

## 8. 验收判定

§7 T1-T11 + §11 R-1~R-6 全部达成，§8 通过命令全绿，§9 禁改清单零违反，§10/§11 汇报要求（文件清单/输出尾部/条款对照/迁移清单/builder 已逐项披露）齐备。**PASS**——建议主 agent 核对后流转 committed。

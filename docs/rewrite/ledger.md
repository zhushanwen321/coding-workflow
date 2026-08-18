# 重写状态账本（简化版事件账本）

> 状态流转规则见 orchestration.md。每行变更由主 agent 记录（时间倒序追加在「事件」节）。
> 状态机：pending → building → built → verifying → verified → committed；失败 → rejected。

## M0 = L0 + L1（证据地基）

| unit | 模块 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| u1 | 事件模型 + 账本 + 投影 | committed | 01fd577 | verifier PASS（sha256 117681da…，报告 u1-report.md，17 条对抗抽查）。观察项：① lockfile 创建-写入空窗口竞态（沿用旧实现既有机能，后续 unit 修：null 时等待而非 unlink）② E2E 交错断言低概率 flake ③ verified 判定未校验 VerifyRan 在最后 spec 之后（与验收文档字面一致，接线期收紧） |
| u1b | 只读命令（status/frontier/tree/report） | committed | 552ae90 | verifier PASS（sha256 23ce2763…，报告 u1b-report.md，17/17 对抗抽查）。O-1 裁决：--json 恒输出结构化空形态（收尾 polish 统一，status 空账本当前输出纯文本与 frontier 不一致） |
| u2 | 写命令（create/evidence submit/review submit） | committed | 552ae90 | verifier PASS（sha256 4ee6677e…，报告 u2-report.md，7 场景对抗零矛盾）。备案：spec 多余字段 typebox 放行、--evidence-refs "" 产生空数组键（payload 形状细微差异，报告 §5） |
| u3 | spec gate 五规则 | committed | 01fd577 | verifier PASS（sha256 91f460d…，报告 u3-report.md）；minor 观察：isResolvableOnPath 对目录 command 放行（which 不放行），退化边界，u4a verify 真跑时天然兜住 |
| u4a | 干净重跑 + cw verify | committed | 115e52c | 首验 FAIL 1 major（--timeout-ms 无有效传值形式）→ 打回修复（parseTimeoutMs 四分支、非法 exit 1 报错）→ 针对性复审 PASS（红性验证：缺陷注入恰 3 新测试红、字节级还原；行为对抗 abc/裸 flag/-5 全拒）。minor：错误消息称「正整数」但接受正小数（口径轻微出入） |
| u4b | 三道 gate（红阶段/名字比对/重跑判定） | committed | 5183fb2 | verifier PASS（sha256 2ae2c048…，报告 u4b-report.md，5 组对抗抽查）。裁量 1/2 接受（case.name 词边界、judgeRedPhase 四态）；5 处 u4a 适配确认断言强度等价。观察：vitest 型不消费进程 exitCode（规格本意）、红阶段产物前缀目录非字面子目录 |
| u5 | TestRun 缝 + vitest/e2e-sh 适配器 | committed | 115e52c | verifier PASS（sha256 fe93e5b2…，报告 u5-report.md，17/17 对抗抽查）。两处规格裁决经 verifier 确认与条款自洽（e2e-sh 多 id 命中读法、A 前缀拼回）。观察：vitest includes 子串匹配理论前缀边界、非 A 前缀标记行静默忽略（有防线兜底） |
| u5b | human 模式 | committed | 5183fb2 | verifier PASS（sha256 bb8583f1…，报告 u5b-report.md，4 条对抗抽查）。3 偏差全确认合理（spec review 无 runId 系验收文档笔误、kind 枚举补 create/spec-review、E2E unit fixture 折衷由 u5 真 fixture 兜底）。观察：同账本持续无关事件可推迟 max-idle（M0 全局粒度）；index.ts 注释行微调（必要无害） |

## M1 = L2（并行 runner）

| unit | 模块 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| u6a | AgentSpawn 接口与生命周期 | committed | 78fa351 | 两任 builder（前任中断留实现，续任审查零修改保留 + 补 9 组测试）；verifier PASS（sha256 c1baff50…，报告 u6a-report.md，7/7 对抗抽查）。两处文档字面偏离实测证实唯一可行（fd 包装 stdio、ENOENT 预检）。观察：kill 发起方归因的固有窄窗口（TIMEOUT 误归因，10 次实测未触发） |
| u6b | human 适配器 | committed | 9c6af01 | verifier PASS（sha256 62fa5542…，报告 u6b-report.md，7/7 独立探针对抗）。两裁量成立（指令变体三点差异属实+零 import 结构性必然；子进程 JSONL 与 EventLedger 逐字段一致）。minor：req.env.CW_HOME 跳过 isAbsolute 校验（留接线波次统一） |
| u6c | pi 适配器（CW_AGENT_MODEL → --model） | committed | 9c6af01 | verifier PASS（sha256 594bf27a…，报告 u6c-report.md，4 条对抗抽查 + 真实 E2E 复跑 6.5s）。首次真实 harness 接入：mimo-v2.5-pro stdout 跟随 brief 变化（非缓存）。裁量两项合理（resolvePiModel 纯函数单点调用、extraArgs 默认参消解文档自矛盾）。minor：SPAWN_ERROR 态产物文件不存在（契约未规定） |
| u7 | 调度循环 | committed | 9c6af01 | 首验 FAIL（killAll EPERM 冒出，10 连跑 2 败）→ 打回修 best-effort killAll + 确定性回归 → 复审 PASS（红性命中 killAll 栈、10/10 连跑、4 出口全覆盖）。其余首验即过：u5b 适配无弱化、双叶重叠 402ms、10 对抗全过 |

## M2 = L3（集成）+ 补齐

> 归段说明（2026-08-18 补注）：fx-1/fx-2/fx-3 为终验 FAIL 触发的返工波（事件链见事件节 2026-08-16 各条），与 M2 的 L3 集成无隶属关系；历史记录于本表属当时口径，行不移动、以本注为准。fx-3 原误记于「里程碑 gate」表（unit 行混入 gate 表的结构错位），2026-08-18 移入本表。

| unit | 模块 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| u8 | 内部节点 verify（merge + 契约比对） | committed | 21da1e1 | 两任 builder（前任中断留五文件，续任保留+修 3 小处）；verifier PASS（sha256 d9254eda…，报告 u8-report.md，4 组 18 断言对抗）。契约集合 root∪子口径判定成立（验收文档注释已按实证修订）；u7-e2e 适配强度等价。观察：二进制嗅探 8KB 窗口、缺子 idle 出声（M2 口径内） |
| fx-1 | 终验死锁三根因修复 | committed | 99f5fca | R1 三防线（规则⑥/叶子 split 拒/loop 防御）+ R2 文案与第四分支（同口径时间语义）+ R3 marker 显式化；10 回归红绿经 verifier 影子工程独立复现（8/10 红一致）。218 全绿。观察：O1 旧坏账旁路场景（终验重置后不发生）、O2 fail 后补审循环张力 |
| fx-2 | 集成层死锁 R4 修复 | committed | ddc5a84 | 上限计数（事件流重放、逐 unit、无 off-by-one）+ designer 契约漂移出口（guidance 单一出处双出口）+ 上限切断审计喂 idle 回路；4 回归影子工程 4/4 红全超时（R4b 死锁现场直接复现）。222 全绿。minor：失败汇总 N 虚高 1（观感）；上限后 designer 重派至 idle 有界（与 u7 语义一致） |

| fx-3 | 分解结构建立缺位 R5 修复 | committed | 528e9ff | R5.1 gate 收紧（先建子后提 spec，missing/mismatched 分类清单）+ R5.2 designer 第 0 步 + R5.3 兜底出口（拦截在集成等待之前，优先于 R4a）；verifier 22/22 对抗 PASS、越界适配 2 处裁决语义等价。230 全绿（行原误记于「里程碑 gate」表，2026-08-18 结构修复移入） |

## M3 = L2-F3（每 unit 独立 worktree 升级）

> 依据设计文档 `docs/rewrite/design-worktree-isolation.md`（其标题「M2」沿用 handoff 旧编号，实际排期 M3——M2 = L3 集成已收官）。波次 W1-W5 对应 unit wt-1~wt-5；依赖链 wt-1 → wt-2 → wt-3 → wt-4 → wt-5（W3/W4 设计上只依赖 W2，但领地相交于 loop.ts，按并行规则串行执行）。

| unit | 模块 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| wt-1 | W1 worktree 基建（runner/worktree.ts + getCwWorktreeHome/worktreePath/resolveProjectDir + cli CW_PROJECT_DIR） | committed | c0f9f29 | verifier PASS（sha256 aa425af6…，报告 wt1-report.md，9/9 对抗抽查 + 真实性 4 点无空洞断言）。2 偏差裁决合理（B7 worktree list 用分支名断言——/var vs /private/var symlink 实测、语义等价；B4 加强文案断言）。297 全绿（282 既有 + 15 新增）。观察：git 2.52 worktree list 输出 [cw/<branch>] 注释形态依赖 |
| wt-2 | W2 spawn 链路拆分（projectCwd 双传 + pi env 注入 + human 账本锚定 + brief/escalation 文案） | committed | 075c1e9 | 两轮交付（首版 + v2 审查返工 R-1~R-6）verifier 完整验收 PASS（sha256 de624b80…，报告 wt2-report.md：防篡改/四命令 310 全绿/真实性 5 点/对抗 6 条含空格路径全链路、双 unit 并行、在/亡格循环级）。3 披露全裁决通过（fx3 同锚适配、dist 竞态 3 连跑、reattach 无条件 prune 零字符串匹配）。分支双空间 + clean -e .cw-spawn + 四格矩阵 + 内联前缀 + 解析锚分离（R-5）落地。观察：ensure 失败 error 每轮重复输出（W3+ 去重）；T8/T9 未直测 reviewer role 前缀（cwCommand 统一，风险低） |
| wt-3 | W3 reset 语义替换（删 checkWorkspaceForDispatch → worktree reset --hard + clean -fd） | committed | e1a8b8f | verifier PASS（sha256 781430ae…，报告 wt3-report.md：纯删除证明 +2/-87 零逻辑新增、313 全绿、对抗 20/20 含项目 cwd tracked+untracked 跨 24 轮重派原样保留、SPAWN_ERROR 出口脏保留）。行为变化锁定：项目 cwd 不再被 runner 触碰（A1 防近似复活） |
| wt-4 | W4 集成汇聚与回流（子 closed → merge root 分支；集成 verify 三处锚 root 分支；孤儿清扫 + 延迟回收 + 回流指引） | committed | 917ac1e | verifier PASS（sha256 7bc77414…，报告 wt4-report.md：防篡改/321 全绿/M1-M8 真实性 5 点/对抗 8 条含冲突恢复闭环、跨 root 清扫、真实 home 零污染）。4 披露全接受（退出清尾回收、J3 排除本 rootId、branch -D 占用静默、u5b 形态适配经 A7 反证必要）。观察：真实链路首次集成分支残留常态（可达跳过 merge 即跳过 -D，无害设计权衡内） |
| wt-5 | W5 测试迁移与终验（并发污染对抗测试 + canon P7 勾验 + 残余断言复核） | committed | 2a975d7 | verifier PASS（sha256 3f6ed093…，报告 wt5-report.md：323 全绿、真实性 4 点、对抗含混卷红性实证（共享 cwd 探针双标记同 commit）与 C2 反向隔离证明、C1 flake 3 连跑稳定）。C4 zero 残留（builder 自报 46 处与 verifier 实测 89 处口径差为清单条目数 vs grep 原始数，实质无差异）。canon P7 ⛔→✅（该文档被 gitignore，更新在磁盘）。终验靶子拆为 M3 gate |
| fx-4 | spawn 产物收口 topic 目录（M3 终验观察①修复；worktree 纯化 + 三类原文副本入 evidence + 场景 4 反向断言补齐） | committed | 0642d15 | verifier PASS（sha256 f2b31528…，报告 fx4-report.md：331 全绿、T1-T5 真实性 5 点、对抗 7 条含 482 轮重派 append/覆盖写铁证、真实 home 零污染）。4 披露全接受（common.ts 公共函数、91/88 计数口径、字面量 4 文件 tsc 无缺口三重验证、幂等分支补 copy）。minor 4 项不阻断（lifecycle 注释过时、escalation 硬编码路径、幂等 copy 探针补验、密集重派语义 u7 既有）。设计 design-topic-artifacts.md v1.1（f301420） |
| fx-5 | 观察③收口：成对 unit 资源回收 + merge 点去副作用（336 全绿 = 331+5） | committed | 187f7df（事后补录） | **验收链缺口（2026-08-18 plan 审查 D1 实锤）：实现 commit 无 acceptance 基线/verifier 报告/表行，绕过防篡改机制**。fx5-acceptance.md 为事后补录（验收对象 = 187f7df 已交付行为），verifier 事后验收已 PASS（2026-08-18 补录闭环，报告 fx5-report.md：18 条对抗全过）。内容：reclaimUnit 成对唯一入口（终态 × tip 可达谓词，不可达保守保留+出声）+ merge 成功路径去 branch -D + 孤儿清扫目录+ref 双扫 + wt4「分支已删」断言迁移「保留」。设计勘误 v3.2 |

## M4 = 设计-实现一致性修复轮（2026-08-18 五角度对抗审查驱动）

> 来源：5 reviewer 对「2.0 设计文档 vs 实现」五角度对抗审查（canon 主设计 / parent / spawn+worktree / testrun / plan 完成度）。用户裁决：异源 reviewer 补实现、红阶段接自动链路、多语言适配做（~/Code 调研定案：pytest 4/4 全覆盖 + playwright ts 侧第二、jest 零使用）、其余直接修复、文档对齐全做、认知外改动授权提交（807cafa 已入）。依赖链：rv-1 → rv-4 → rv-5（loop.ts 领地串行）；mx-1 设计先行；mx-2 依赖 rv-2（testrun 领地）；doc 系列最后。

| unit | 模块 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| rv-1 | spawn/loop 健壮性（EPERM 兜底 + Ctrl-C 孤儿清理） | committed | 9023076 | verifier PASS（sha256 3449be0a…，报告 rv1-report.md：runLoopMain 外壳化重构核实零行为变化 + 红灯复核两形态命中含 EPERM 原始缺陷独立复现 + 160 次竞态加量零未捕获 + 双 SIGINT/极早期/空 inFlight 窗口对抗 5 项全过）。瑕疵不阻塞：验收 §6 文件名笔误待终验勘误；T2 单轮 EPERM 检出概率性（口径已覆盖） |
| rv-2 | engine 小修包（id 字符集 gate⑦ + marker 同源 + exec-review refs 必填 + replan 文案 + parse exitCode 落盘 + checkout 根解析） | building | <本 commit> | 审查 M4/D6/D13/D20/m6；与 rv-3 并行（领地不相交） |
| rv-3 | 契约比对强化（文档宿主排除 + 归一化比对） | committed | 9023076 | verifier PASS（sha256 bf449ea3…，报告 rv3-report.md：T1-T8 全实质 + 18 条对抗探针全过含大小写绕过/symlink 逃逸/8KB 嗅探边界）。2 裁量裁决合规（宿主判定大小写不敏感 fail-closed、文档判定先于存在性）；u8 适配仅 hidden.txt→.dat 换宿主。「≡ 冻结配对比对」归 rv-4。残余备案：contract.file 含 ../ 可逃逸 checkoutDir（基线行为，输入来自冻结可信层） |
| rv-4 | 红阶段自动接线 + 集成失败处置改进 + 契约配对化 | building | <本 commit> | 依赖 rv-1+rv-3 已满足；canon D5「三道 gate」+ 审查 A-2/A3/A-7 残余；MAX=1 语义（fx-2 时代 MAX=2 作废） |
| rv-5 | flake 转人工 + 随机性豁免（纪律②后半） | pending | — | 依赖 rv-4 |
| mx-1 | 异源 reviewer 派发机制（设计先行 + 对抗审查） | pending | — | critical A-1：spec-review 由 designer 自审 pass 违背「独立 reviewer」承诺 |
| mx-2 | pytest + playwright 适配器 + 框架显式声明（testRunner 路由） | pending | — | 依赖 rv-2；canon §6.1「显式声明 vs type 硬映射」矛盾消解 |
| doc-1 | AGENTS.md 重写 + DESIGN-LOG.md 重建 | pending | — | 审查 M11/D2：AGENTS.md 三条现状声明全失效、文档索引指向已归档文件 |
| doc-2 | canon 回写（附录 B 契约 / M1 现状注 / D5 红阶段口径 / §6.1 消矛盾） | pending | — | 依赖 rv-4/mx-1/mx-2 定型 |
| doc-3 | parent/spawn/testrun/wt 设计文档过时注回写 + fx-5 验收链补录 + fx-3 ledger 修复 + P1 探针 + 回收审计二跑 | pending | — | 审查 A-3/A-4/A-5/D1/D5/D10/D12 |

## 里程碑 gate

| gate | 内容 | 状态 |
|------|------|------|
| Phase 0 | 归档 + 脚手架 + 靶子清空 | done |
| M0 gate | A1 人肉全流程 + A3 补录攻击 | done |
| M1 gate | pi E2E（微任务 + 并行）+ 探针 P3/P4/P6/P8 | done |
| 终验 | markdown-reader 全流程无人干预 | PASS | — | 第 4 次（commit 见 final-gate-4-report）：45.1min 自然完成零人工、全树 3 unit closed、7/7 机器验证 manual=0、10 spawn（1 TIMEOUT 重派——超时机制首次真实触发）、靶子全绿（install/build/vitest/渲染/HTTP 200）。fx-2 R4a 首次现场闭环（契约漂移→2 fail 封顶→designer 仲裁→65s 恢复）；fx-3 children-first 现场证据成立。四次卡点：分解层→集成层→建子→无 |
| M3 gate | worktree 隔离全链 E2E（真实 pi 靶子无人干预） | PASS | — | 第 5 次终验（报告 m3-gate-report.md）：26min52s 零人工、9 spawn / 0 重派 / 0 TIMEOUT、全树 3 unit closed、六条通过标准机器判定 6/6（worktree 回收清单、cw-root/md-reader 干净回流、靶子 master 零污染、CW_PROJECT_DIR 无分裂账本、323 全绿）。**集成 merge 真实冲突首次现场再现并经 R4a 处置出口闭环恢复**（designer 按 fail 文案指引解决冲突 commit → 第 3 跑集成 pass → root closed；设计待验证检查点②现场验证）。观察 4 条不阻塞：① agent `git add -A` 把 .cw-spawn 产物卷入 commit 随 merge 进 root 分支（设计层缺口，回流会带产物文件，待立项 fx-4）② root closed 后 killAll 收尾无退出行（cosmetic）③ u5b-e2e 既有并发 flaky（4 次全量 2 红 2 绿，与 M3 无关，待独立跟进）④ reset/clean 对「未打靶分支」的覆盖未现场触发（wt 系单测已覆盖）。起跑态偏离已记理由（snapshotHeadCommit fail-fast → 单 README 存档 commit；--max-idle-ms 2700000 防默认值 idle 误杀竞态） |

## 事件

- 2026-08-15 Phase 0 开始：git mv src/tests/docs + 6 个根级文档 → archive/；靶子 recursive-split-e2e 已存档 README 并清空重建；新脚手架就位。
- 2026-08-15 Phase 0 完成：check:all + test（3 冒烟）+ lint 全绿；commit 88ce0a2（archive legacy implementation, scaffold rewrite）。
- 2026-08-15 u1/u3 验收基线入 git：主 agent 建共享类型契约 src/events/types.ts（canon D2/D3 投影 + 两处显式补充注明）；u1（账本+投影）与 u3（spec 五规则）并行派发 builder。
- 2026-08-15 u3 committed：builder 交付 spec-rules.ts + 13 条表驱动单测；verifier 防篡改/命令实跑/真实性抽查/8 条对抗抽查全 PASS；主 agent 复核 diff 为空 + sha256 一致后流转。
- 2026-08-15 u1 committed：builder 交付 events-log/project/fold + 26 单测 + 1 真实子进程并发 E2E（41 全绿）；verifier 17 条对抗抽查全 PASS + 锁超时实测补证 10043ms；types.ts 纯追加（33+/0-）并行契约未破坏。3 条观察项记入 u1 行。
- 2026-08-15 u2 committed：builder 交付写命令三件套 + typebox schema 链 + 28 测试；verifier 真实性抽查（gate 不入账三要素/E2E 事件全量序/cat-file 真实调用）+ 7 对抗场景零矛盾 PASS。
- 2026-08-15 u1b committed：builder 交付四只读命令 + 22 测试；verifier 17/17 对抗抽查 PASS，specGate 真接线确认（load.ts import checkSpecRules 注入 deriveStatus）。O-1 观察：--json 空账本行为不一致，裁决方向 = 恒结构化，收尾统一。
- 2026-08-15 第三波派发：契约层 src/testrun/types.ts（TestRunAdapter/EvidenceReport，canon B.2）预建；u4a（verify 干净重跑）与 u5（vitest/e2e-sh 适配器）并行。
- 2026-08-15 u5 committed：builder 交付两适配器 + registry + 14 测试（fixture 全真实生成）；verifier 17/17 对抗抽查 PASS，两处规格裁决确认自洽。
- 2026-08-15 u4a 首验 FAIL（1 major）：--timeout-ms 数值 flag 经 dispatch 全链失效（stringArg 类型门 + 静默回退默认），测试盲区=未测 CLI 层数值传递。打回修复中；u4b/u5b 验收文档已备待 u4a committed 后派发。
- 2026-08-15 u4a committed（FAIL→修复→复审 PASS 闭环）：parseTimeoutMs 本地解析 + 3 回归测试（红性验证有效）；全量 126 绿。第四波 u4b/u5b 基线入 git 后并行派发。
- 2026-08-15 u5b committed：builder 交付 human-loop + run 命令 + 19 测试（E2E 测试进程扮演人全链收敛 root closed）；verifier 4 对抗抽查 PASS，3 偏差确认合理。u4b 验收中。
- 2026-08-15 u4b committed：M0 八 unit 全闭环（u1/u1b/u2/u3/u4a/u4b/u5/u5b，全量 23 文件 164 测试绿）。verifier 5 组对抗抽查 PASS；裁量与 u4a 适配逐条确认。进入 M0 gate（A1 人肉全流程 + A3 补录攻击六路径）。
- 2026-08-15 M0 gate PASS：A1 add-capitalize root closed（145 轮 73s 收敛，六事件链完整，verify 产物落盘）；A3 六路径全拒（谎报无命令/echo ok 双杀/sed 探针隔离/假产物不信/弱验收回退留痕/改码不影响重跑）。两条语义边界备案。M1 启动：契约层 spawn/types.ts + u6a 派发。
- 2026-08-15 u6a committed（续作模式：前任用量中断留 lifecycle.ts，续任审查保留 + 补测；173 全绿）；verifier 7/7 对抗 PASS。第二波 u6b/u6c/u7 三并行派发（基线随本 commit）。
- 2026-08-15 u6c committed：pi 适配器 + 真实微调用 E2E（mimo-v2.5-pro，9.5s 首跑 / 6.5s 复跑）；verifier 4 对抗 PASS（stdout 跟随 brief 证明非缓存）。u6b 验收中、u7 开发中。
- 2026-08-15 u6b committed：human 适配器 + 6 测试；verifier 7/7 独立探针 PASS（kill 即时性 0ms、settle 幂等）。M1 进度 3/4，仅 u7 开发中。
- 2026-08-15 u7 首验 FAIL（1 major）：收尾 killAll 的 EPERM 间歇崩溃（verifier 压测 10 连跑 2 败；builder 自报「间歇已修」仅测试侧）。打回修 loop.ts（best-effort killAll + 确定性回归测试）。机制第 2 次 FAIL 路径运转。
- 2026-08-15 u7 committed（FAIL→修复→复审 PASS 闭环，全量 28 文件 196 测试绿）：M1 四 unit 全闭环（u6a/u6b/u6c/u7）。M1 gate 启动：真实 pi 微任务 + 并行 + 探针。
- 2026-08-15 M1 gate PASS：真实 pi 后端全流程首次运转（9 调用/零重派/无人干预）；微任务 2m39s、双叶重叠 6.3s、P3 零锁实证。M2 启动：u8（集成 verify）派发；u9（claude/codex/pytest 适配器）跳过——终验 pi 后端足够，py/go 无真实项目不写无真实验收的代码。
- 2026-08-16 u8 前任 builder 用量中断（五文件已落盘）；00:54 定时任务恢复后续作重派（第二次中断-续作，同 u6a 模式）。
- 2026-08-16 u8 committed（两任接力，全量 31 文件 208 测试绿）：M2 收官（u9 跳过）。集成语义闭环：子全 verified → 确定性集成（commit 可达 + 全子树验收重跑 + 契约比对）→ root verified → exec-review → closed。进入终验：markdown-reader 全流程无人干预。
- 2026-08-16 终验第 1 次 FAIL（产物全合格、状态机死锁）→ fx-1 committed（三根因修复，红绿影子工程复现）→ 靶子重置 → 终验第 2 次执行中。
- 2026-08-16 终验第 2 次 FAIL（新死锁 R4 集成层）：fx-1 全部生效（R2 现场 105s 恢复、R3 零试错、R1 未复现；两叶首次全 closed、产物全绿、9 pi 调用）；R4a 契约 async 一字节漂移无恢复出口 + R4b 审计事件喂饱 idle 计数 31 轮死循环。fx-2 基线入 git 派发。
- 2026-08-16 fx-2 committed（影子红绿 4/4 超时复现死锁现场；222 全绿）→ 靶子重置 → 终验第 3 次执行中。
- 2026-08-16 终验第 3 次 FAIL（R5 建子缺位，更上游）：pi print 模式把建子当询问点，root spec-frozen 等不存在的子 45.5min 零派发空转（idle 有界退出、零人工——兜底语义现场成立）。fx-3 基线入 git（gate 收紧先建子后提 spec + 任务书第 0 步 + 派发兜底出口）。
- 2026-08-16 fx-3 committed（verifier 22/22、230 全绿）→ 终验第 4 次 **PASS**：45.1min 零人工自然完成、7/7 机器验证 manual=0、全树 closed、靶子全绿；fx-2 R4a 恢复出口首次现场闭环（65s）；TIMEOUT 重派机制首次真实触发。重写主体完工，进入收尾（验收文档回收核查 / 文档重写 / 版本 2.0.0）。
- 2026-08-16 L2-F3 worktree 隔离升级启动（定时任务触发，cw-orchestrator 流程）：技术方案 design-worktree-isolation.md 入库（探针 P-wt1~P-wt6 已实测 ✅；D2 分支 base = root spec 冻结 commit 按推荐方案设计）；ledger 开 M3 段（wt-1~wt-5）；wt-1 验收基线入 git，builder 派发。
- 2026-08-16 wt-1 committed：builder 交付 worktree.ts（add/reset/remove + unitBranchName，Outcome 模式）+ project.ts 三函数 + cli.ts CW_PROJECT_DIR 接线 + 15 测试（A1-A4/B1-B9/C1-C2 全覆盖）；verifier PASS（防篡改/四命令/真实性 4 点/对抗 9 条含假 baseCommit 零残留、路径逃逸拒绝、相对 env 报错可操作）。297 全绿。wt-2 验收基线备料。
- 2026-08-16 wt-2 基线前勘误：设计文档 D2 引用的 SpecSubmitted.commit 字段实测不存在（types.ts:90-91 是 EvidenceSubmittedPayload.commit，时序也晚于 designer 派发）——base 口径修正为「runLoop 启动时项目 cwd HEAD 快照（run 内单次缓存）」，设计文档 D2/P-wt6/§5 已改；非 git 项目 runLoop 启动 fail-fast。波内边界调整：受影响既有断言随 W2 迁移（W5 只余对抗测试与终验）。wt-2 验收基线入 git，builder 派发。
- 2026-08-16 设计 v2 对抗审查（tech-design rubric，报告 /tmp/design-review-worktree-v2.md）：方案本体成立；6 must-fix + 7 suggestion。主 agent 裁决：MF-1 文件解析锚定分离（CW_PROJECT_DIR 只锚账本与 git 操作，--file/--brief 解析锚 process.cwd——长期方案；模板改绝对路径为短期补丁弃用）；S3 aborted 终态不采纳（产品状态机无 aborted，系两层状态混淆）；其余 S 采纳。wt-2 交付按旧口径实现需返工（R-1~R-6，wt2-acceptance.md §11），验收基线重置随本 commit；设计 v3 修复与代码返工并行派发。
- 2026-08-16 设计 v3 committed（db5e9c5）：6 MF + 7 S 全处置（S3 核实不采纳——events/types.ts 无 aborted）；修复 worker 清单外发现 §1.3 baseCommit 残留引用，主 agent 顺手修正随本 commit。
- 2026-08-16 wt-2 committed（两轮交付 310 全绿）：首版（spawn 链路 worktree 拆分 + 11 文件断言迁移）+ 返工（R-1 分支双空间 cw-root/<rootId> 与 cw/<rootId>/<unitId>、R-2 clean -e .cw-spawn、R-3 ensureUnitWorktree 四格矩阵零字符串匹配、R-4 human 内联前缀+引号、R-5 resolveAgainstCwd 锚 process.cwd（三调用点统一 + fx3 同锚适配）、R-6 断言同步）。verifier PASS（对抗 6 条含含空格路径真实 shell 执行、双 unit 并行、真实 home 零污染）。wt-3 验收基线备料。
- 2026-08-16 wt-3 验收基线入 git（纯删除波：删 checkWorkspaceForDispatch 近似链 + 项目 cwd 不再被 reset 的行为锁定），builder 派发。
- 2026-08-16 wt-3 committed（313 全绿）：loop.ts 纯删除 +2/-87（四件套 + 注释段，零逻辑新增）；verifier PASS（对抗 20/20）。项目 cwd 与 agent 工作区彻底解耦。wt-4 验收基线备料。
- 2026-08-16 wt-4 验收基线入 git（J1 merge 内聚幂等 / J2 三处锚 root 分支 / J3 孤儿清扫查全账本 / J4 延迟回收；M1-M8 条款），builder 派发。
- 2026-08-16 wt-4 committed（321 全绿 = 313+8）：步骤 0 merge 汇聚（已达跳过幂等 + 冲突 abort 收 failures 含内联前缀指引 + best-effort branch -D）+ 三处 HEAD 锚 cw-root/<rootId> + 启动孤儿清扫（全账本口径、排除本 rootId）+ 每轮延迟回收（pendingReclaim + 退出清尾）+ summary 回收清单与回流指引；u8-integrate/u8-e2e/u5b-e2e 三文件适配。verifier PASS（对抗 8 条：冲突人工解决后重跑 pass 闭环、他 root 跨 run 清扫、项目 cwd 不被触碰不回归）。wt-5 验收基线备料。
- 2026-08-16 wt-5 committed（323 全绿 = 321+2）：C1 并发污染对抗（ready-rendezvous 屏障实测重叠 430ms、账本 commit 的 git show diff 体互不含对方标记、项目 cwd 监视器全程零 violation、全链 root 集成 pass）+ C2 P7 场景（检出树三断言与 cwd 脏无关且脏保留）+ C4 zero 残留 + canon P7 勾验。verifier PASS（混卷红性 /tmp 实证：共享 cwd 下单 commit 含双标记——断言真有抓混卷能力）。M3 五 unit 全 committed，进入 M3 gate（终验靶子：真实 pi 全流程）。
- 2026-08-17 M3 gate **PASS**（终验第 5 次，26min52s 零人工）：worktree 隔离全链在真实靶子成立，集成 merge 真实冲突经 R4a 处置出口首次现场闭环（设计检查点②验证）。L2-F3 worktree 隔离升级全部完成：设计 v3（两轮对抗审查）→ wt-1~wt-5 五 unit（297→323 绿）→ 终验 PASS。遗留：fx-4 候选（.cw-spawn 产物卷入 commit 的设计缺口）、u5b-e2e 既有 flaky 独立跟进。
- 2026-08-17 收尾三线：① u5b-e2e flaky committed（8b1c1bf，根因 = 测试弱屏障撞 clean 窗口非产品缺陷，强屏障修复 + 探针 15/15 + 全量 5 连跑零红；铁证顺带坐实 fx-4 双害形态）；② 设计-实现偏离审查（报告 /tmp/design-impl-deviation.md）6 条全 minor——#2/#4/#5/#6 随 v3.1 勘误修正（fcd90d6），#1 反向断言与 #3 头注释挂 fx-4 波；③ 临时文件收口设计：全景盘点 → 讨论稿 → 用户拍板 P1-P4（topic 带 encoded 层/永久保留/spec 原文 copy/单波）→ 设计 v1（fcd90d6）→ 对抗审查 3MF+7S → v1.1（f301420：扁平布局/runTs -N 碰撞后缀/D4 扩三类副本）。fx-4 验收基线入 git，builder 派发。
- 2026-08-17 fx-4 committed（331 全绿 = 323+8）：spawn 产物迁 `~/.cw/topic/<encoded-cwd>/<runTs>-<rootId>[-N]/`（AgentSpawnRequest.artifactDir 契约、brief 覆盖写/stdout append、同秒 -N 递增）；worktree 纯化（clean 裸化删 -e、头注释 v2 口径修正）；三类原文副本 `evidence/<unitId>/attachments/<sha256>.<name>`（spec/build --file/unit brief，内容寻址幂等）；场景 4 反向断言补齐（无前缀 cw create → 分裂账本目录实证）。verifier PASS（对抗 7 条含 482 轮重派极限：append 与覆盖写语义铁证）。真实 pi 全链复跑（设计场景 5）待跑。
- 2026-08-17 fx-4 gate **PASS**（场景 5 真实复跑，13min48s 零人工，报告 fx4-gate-report.md）：24 派发产物全收口 topic 目录（之外全域零残留）；全部 agent commit 树（root 分支 326 paths）零 `.cw-spawn`——M3 §5.2 卷入缺口 by construction 关闭；append 语义现场铁证（stderr 294 = 147×2）；attachments 20/20 逐字节可重读；root 分支干净回流；两轮集成 fail（merge 冲突 + 契约未命中）经 R4a 处置 + 恢复路径①组合闭环。观察 4 条不阻塞：① agent 自发建 .gitignore 并 commit（业务行为非 cw 注入）② 收尾无退出行（同 M3 cosmetic）③ **leaf 子分支未清理（与 M3 行为差异——处置路径手动解决冲突绕过自动 merge 的 branch -D，清理条件待查，挂观察）** ④ 处置 commit 无独立 build 证据事件（最终 verify 覆盖）。
- 2026-08-18 fx-5 committed（观察③收口，336 全绿 = 331+5）：根因 = 分支删除唯一自动点内联在 merge 成功路径（integrate.ts），「冲突→人工解→重跑」路径上子 commit 已可达、走步骤 0 已达跳过，永久绕过删除（M3/fx-4 两 gate 同一现场）；且「分支已删+worktree 仍在」中间态会撞 D5 矩阵「在/亡」异常格、阻断「在其 unit 重提 build 证据」恢复路径。长期方案落地（设计 v3.2 勘误）：merge 点去资源回收副作用；worktree.ts 新增 listUnitBranchRefs/removeUnitBranch/reclaimUnit（成对回收唯一入口，谓词 = unit 终态 × 分支 tip 经 root 分支可达，不可达保守保留+出声，root 成果分支守卫）；loop.ts 回收点统一走成对（延迟回收 + 启动孤儿清扫扩目录+ref 双扫并集，ghost 目录退回原语义防误删）；wt4「merge 后分支已删」断言迁移为「保留」。fx5 测试 5 场景：成对回收/不可达保留/孤儿分支（残留现场复刻）/并行 root 不误删/冲突→人工解→重跑全链成对消失。

## 对抗审查修复（2026-08-16）

- 来源：3 reviewer 对「实现 vs 设计」对抗审查，35 条发现（12 A / 18 B / 5 C）+ 1 缺失项；用户裁决全部修复（L2-F3 例外走 handoff）。
- 波次 1（`1fc5e8c`，CLI/只读 + verify-exec + gate/适配器）：shebang、encodeCwd 碰撞、树感知 closed、closed 不可逆、孙进程 kill（detached + pgid 杀整树）、e2e-sh marker（第一列 = 验收 id 原文，废 A 前缀锚）、spec-rules isFile、red-phase patch 语义、verify 超时分档（单测 10min / e2e-real 30min）、human pid 等。
- 波次 2（`f24782d`，账本/投影语义）：verified 时序收紧（pass 的 VerifyRan 须晚于最后 spec）、锁 empty 等待（u1 观察项①收口：null 时等待而非 unlink）、submitSpec 拒 closed、幂等。
- 波次 3（`8a1f846`，runner 循环语义）：连续 2 次 TIMEOUT 转人工（单进程内存计数 + 无可派发 exit 1 汇总清单）、派发前 tracked reset --hard 近似（untracked 不动、--no-optional-locks）、wait 完成信号、frontier 单一出处（loop 消费 readonly/frontier.ts 的 computeFrontier，DISPATCH_SHAPE 映射派发形态）、退出输出落盘屏障。
- 例外：L2-F3 独立 worktree 未修——升级路线交接 `handoff-worktree-isolation.md`（本目录），用户单独处理。
- 缺失项处置：u5 JSON 配置模板兜底适配器未实现（M1 仅 TS 接口形态 human/pi）——与 u9 跳过同理，无真实需求不立项；canon 已标注待立项。
- 测试基线：273 → 282 全绿（41 文件）。
- 2026-08-18 M4 启动：五角度对抗审查（设计 vs 实现）驱动修复轮。认知外改动经用户授权提交（807cafa：错误消息可操作化 + skill 重写，tsc+受影响 31 测试验证）。~/Code 框架调研定案多语言目标 = pytest + playwright（vitest 已有）。rv-1/rv-2/rv-3 验收基线入 git，三 builder 并行派发（领地不相交：lifecycle+loop / engine 层 / contract-match）。
- 2026-08-18 rv-3 committed：builder 交付文档宿主排除（.md/.txt/.rst/.adoc + README*/CONTRIBUTING*/CHANGELOG* + docs/，封闭集合）+ 双侧空白折叠归一化 + 失败消息两态分立；verifier PASS（15 新测试 + u8 适配 1 处；18 条对抗探针：大小写绕过/深层 docs/symlink 逃逸/md+ts 并存/8KB 边界/CRLF 全过）。基线 9023076。
- 2026-08-18 ledger 结构修复（doc-3 提前项）：①fx-3 行从「里程碑 gate」表移入 M2 表（unit 行混入 gate 表的结构错位，plan 审查 D5）②M2 段加归段说明（fx-1/2/3 为终验返工波）③fx-5 补 M3 表行 + fx5-acceptance.md 事后补录（plan 审查 D1：fx-5 未走基线先行流程，验收对象 = 187f7df 已交付行为，verifier 事后验收随 doc-3）。事件流水不改动。
- 2026-08-18 rv-1 committed：builder 交付 killTree 豁免 {ESRCH,EPERM} + timer 回调 try/catch + runLoop 信号外壳（SIGINT/SIGTERM → 提示行 → killAll → exit 130/143，全出口 process.off）；verifier PASS（重构零行为变化核实、EPERM 缺陷独立复现、160 次竞态加量、对抗 5 项）。rv-4 基线入 git（依赖 rv-1+rv-3 均已 committed），builder 派发。
- 2026-08-18 doc-3 设计文档回写（worker 交付，主 agent 抽查通过）：wt 设计 v3.3（-e .cw-spawn 全语义反转注/D4 裸 clean/指引 topic 路径口径）；spawn 设计（产物 topic 迁移注/AgentSpawnRequest 契约对齐/human 完成信号账本事件口径）；testrun 设计 v6（parse 三参/marker id 全文/字段表/VerifyRanPayload/execBashTree/实参数面 + mx-2、rv-5 待回写注）；parent 设计头部 [SUPERSEDED] 终局处置声明（1.x 渐进视角已被重写取代，仅存历史价值）。.xyz-harness 三份按 gitignore 惯例仅磁盘更新不入 git；docs/rewrite/ 一份入 git。
- 2026-08-18 fx-5 事后验收 PASS（补录闭环，报告 fx5-report.md：187f7df 五文件核对 + 成对谓词逐项实证 + fx5 5/5 与 wt4 迁移 8/8 实跑 + 18 条行为对抗全过含 tip 不可达保留出声/亡在异常格/root 分支缺失保守保留）。plan 审查 D1 的验收链缺口收口。观察：fx5-2 出声断言在函数级，loop 层 stderr 出声由对抗抽查实证、套件内无直接覆盖（不阻塞）。

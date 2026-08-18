# DESIGN-LOG — 设计历史索引

> 2.0 重写的设计台账（Phase 0 归档旧版后重建，2026-08-18 doc-1）。纯索引不展开论证：每主题一行、每决策一条，出处写文档路径。事实源 = [docs/rewrite/ledger.md](./docs/rewrite/ledger.md)；1.x 时期设计史见 [archive/DESIGN-LOG.md](./archive/DESIGN-LOG.md)。

## 主题台账（时间序）

| 时间 | 主题 | 范围 | 关键 commit | 一句话结论 |
|------|------|------|------------|-----------|
| 2026-08-15 | Phase 0 重写启动 | 1.x 的 src/tests/docs + 六个根级文档归档至 archive/，新脚手架就位 | 88ce0a2 | 重写基线就位（check:all / test / lint 全绿） |
| 2026-08-15 | M0 证据地基 | u1/u1b/u2/u3/u4a/u4b/u5/u5b：事件账本 + fold 投影 + 读写命令 + spec gate + 三道 verify + vitest/e2e-sh 适配器 + human 模式 | 01fd577、552ae90、115e52c、5183fb2 | 八 unit 闭环（164 测试绿）；M0 gate PASS——人肉全流程收敛 + 补录攻击六路径全拒 |
| 2026-08-15 | M1 并行 runner | u6a/u6b/u6c/u7：AgentSpawn 契约 + human/pi 适配器 + 后端无关调度循环 | 78fa351、9c6af01 | 196 测试绿；M1 gate PASS——真实 pi 后端微任务 + 双叶并行首次运转 |
| 2026-08-16 | M2 集成 | u8：内部节点 verify（merge 子树 + 受影响验收重跑 + 契约机器比对） | 21da1e1 | 208 测试绿，集成语义闭环；u9 多语言适配器跳过（无真实项目不写无真实验收的代码，后由 M4 mx-2 定向补齐） |
| 2026-08-16 | 终验四连（fx 系列） | fx-1 终验死锁三根因 / fx-2 集成层死锁 R4 / fx-3 建子缺位 R5 三波返工 | 99f5fca、ddc5a84、528e9ff | 第 4 次终验 PASS：markdown-reader 全流程 45.1min 零人工、全树 closed、7/7 机器验证 manual=0（报告 acceptance/final-gate-4-report.md） |
| 2026-08-16 | 实现一致性对抗修复 | 3 reviewer 对「实现 vs 设计」35 条发现，三波修复（CLI/verify、账本/投影、runner 循环） | 1fc5e8c、f24782d、8a1f846 | 273→282 全绿；worktree 隔离例外走 handoff 独立立项（即 M3） |
| 2026-08-16~17 | M3 worktree 隔离 | wt-1~wt-5：每 unit 独立 worktree + 双空间分支 + 集成汇聚锚 root 分支 + 并发污染对抗测试 | c0f9f29、075c1e9、e1a8b8f、917ac1e、2a975d7 | 323 全绿；M3 gate PASS——真实 pi 全链 26min52s 零人工，集成 merge 真实冲突经处置出口现场闭环（报告 acceptance/m3-gate-report.md） |
| 2026-08-17 | fx-4 spawn 产物收口 | 产物迁 topic 目录 + worktree 纯化（删 clean -e）+ 三类原文副本入 attachments；设计 v1.1 | 0642d15、f301420 | 331 全绿；gate PASS——`add -A` 卷产物缺口 by construction 关闭（报告 acceptance/fx4-gate-report.md） |
| 2026-08-17~18 | flaky 修复 + fx-5 成对回收 | u5b-e2e flaky（弱屏障撞 clean 窗口，测试侧非产品缺陷）；fx-5 = unit 资源成对回收 + merge 点去副作用 | 8b1c1bf、187f7df | 336 全绿；fx-5 验收链缺口（无基线先行）事后补录闭环（acceptance/fx5-report.md） |
| 2026-08-18~ | M4 设计-实现一致性修复轮（**进行中**） | 五角度对抗审查驱动：rv-1 spawn 健壮性 / rv-2 engine 小修包 / rv-3 契约比对强化 / mx-2 pytest+playwright 已 committed；rv-4（红阶段默认接线 + 集成 MAX=1 + 契约配对两道）building；rv-5 / mx-1 / doc-1~3 pending | 9023076、6eb88c2、807cafa、0372b42 | 修复轮进行中，波次状态以 ledger.md M4 段为唯一权威 |

## ADR 索引

### canon 主设计八决策（D1-D8）

出处：`.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md` §3.3（该目录被 gitignore，磁盘存在）。

| 决策 | 结论 |
|------|------|
| D1 unit 形态 | 一种类型、自相似树（深度上限 2：根 + 叶）；否决四层双类型 |
| D2 状态模型 | 状态 = 证据事件投影（append-only 五事件 + fold 纯函数）；否决存储状态机 + 命令推进 |
| D3 验收地位 | 验收是一等工作单元（用例 + 命令 + 断言）；否决验收作 plan 附属字段 |
| D4 协调权 | 归 runner（确定性循环：frontier → 派发 → 等退出 → 回收 → 重算）；否决 prompt 编排 / engine 内调度 |
| D5 验证 | 三道证据型 gate（红阶段 / 名字级比对 / 干净重跑）；否决「N passed ≥ 用例数」计数启发式 |
| D6 集成 | 集成 = 内部节点的 verify（merge 子树 + 受影响验收重跑 + 跨节点契约比对）；否决只靠文件冲突检查 |
| D7 产品形态 | 独立 CLI + 薄 harness 适配；否决服务化 / 单 harness 深度集成 |
| D8 扩展哲学 | 能力缝可插（AgentSpawn / TestRun）、流程语义焊死；否决全面插件化框架 |

### worktree 隔离六决策（D1-D6）

出处：`docs/rewrite/design-worktree-isolation.md`（v3，两轮对抗审查后定稿）。

| 决策 | 结论 |
|------|------|
| D1 布局 | `~/.cw-worktrees/<encoded-cwd>/<unitId>`，env 可覆盖；否决放项目仓库内（embedded repo 不可审计） |
| D2 分支策略 | 命名双空间 `cw-root/<rootId>` 与 `cw/<rootId>/<unitId>`（ref 树冲突隔离 + 归属排查）；base = run 启动时项目 HEAD 快照 |
| D3 路径角色 | `projectCwd`（账本/git 锚，项目 cwd）与 `workdir`（agent 工作区，worktree 路径）拆分 |
| D4 reset 语义 | 每次派发前 `reset --hard` + 裸 `clean -fd`；fx-4 产物外迁后无任何 `-e` 例外条款 |
| D5 生命周期 | 存在性检测矩阵（目录 × 分支 ref）+ closed 延迟回收 + 启动孤儿清扫；fx-5 起成对回收唯一入口（终态 × tip 可达谓词） |
| D6 集成汇聚 | 子全 verified 即 merge 进 root 分支；集成 verify 三处 HEAD 消费点全部锚 root 分支引用 |

### topic 产物四拍板（P1-P4）

出处：`docs/rewrite/design-topic-artifacts.md`（v1.1；用户 2026-08-17 拍板，推荐方案全采纳）。

| 拍板 | 结论 |
|------|------|
| P1 topic 路径 | 带 encoded 层：`~/.cw/topic/<encoded-cwd>/<runTs>-<rootId>/`，秒级碰撞 `-N` 递增后缀 |
| P2 生命周期 | 永久保留，不自动清扫（账本事件不引用 topic 路径，整目录删除不影响重放） |
| P3 原文副本 | 三类一致：spec 原文 / build 产物 / unit brief 以 `<sha256>.<name>` copy 入 `evidence/<unitId>/attachments/`（内容寻址幂等） |
| P4 承载 | 单波 fx-4（契约字段与落点迁移强耦合，拆波要写两遍迁移测试） |

### 独立 reviewer 八决策（D1-D8，v1.1）

出处：`docs/rewrite/design-independent-review.md` §4（设计已定稿；mx-1 实现进行中，以交付后实态为准）。

| 决策 | 结论 |
|------|------|
| D1 隔离层级 | 结构隔离（独立 spawn/brief/派发 gate）为底线，模型异源为配置项 |
| D2 reviewer 默认模型 | 回落 builder 同款模型链（未实测模型不硬编码默认） |
| D3 fail 后维度 | 独立 `specFixPending` 维度派 designer 修 spec（fail 后必须有人修 spec） |
| D4 防活锁 | 账本重放 spec-review fail 总数 ≥2 转人工，不因新 spec 清零 |
| D5 循环成本 | 接受每 unit 多一轮 reviewer spawn；长审场景建议显式调大 `--max-idle-ms` |
| D6 role 字段 | 可选自报（审计载体非信任边界），任务书模板内嵌 |
| D7 派发 gate | 同 unit 存在任意 in-flight spawn 时本轮缓派（同时修复既有 designer→builder 竞态） |
| D8 实现排序 | mx-1 排 rv-5 之后串行进 loop.ts（rv-1 → rv-4 → rv-5 → mx-1 领地串行链） |

### exec-review 证据集扩展（rv-2 方案 C）

出处：`docs/rewrite/ledger.md` M4 rv-2 行 + `docs/rewrite/acceptance/rv2-report.md` 裁决 2。

`--evidence-refs` 合法集 = 该 unit 已入账 EvidenceSubmitted ∪ VerifyRan 的 runId：内部节点集成只写 VerifyRan，原「只认 build 证据」字面使 root 的 exec-review 必填但永无可填（死锁而非严格）；引用 fail 的 runId 可入账，但 fold 的 verified 仍需 pass VerifyRan 兜底，作弊面不扩大。

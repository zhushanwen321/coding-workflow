# Handoff：每 unit 独立 worktree 升级（M2）

> 对抗审查发现 L2-F3（高严重度）：canon 终态设计承诺「每 unit 独立 worktree」，实现停在 M1 简化（workdir = 项目 cwd 本身）。用户裁决：**不在本轮修复波次内动代码，由用户按本文档单独处理**。本文档自包含——不依赖对话上下文，接手人（人或 agent）读完即可开工。

## 1. 差距是什么

| 维度 | canon 终态承诺 | M1 实现现状 |
|------|---------------|------------|
| agent 工作区 | `~/.cw-worktrees/<unitId>` 独立 worktree（canon 数据流图，design-rewrite-architecture.md 约 324 行） | 共享项目 cwd（`src/runner/spawn/types.ts:16` 的 `workdir` 字段承接 `RunLoopOptions.cwd`） |
| 派发前清理 | 对该 unit 的 worktree `git reset --hard`（canon 约 460 行） | 近似版：无 in-flight 时对共享 cwd 的 tracked 脏改动 reset（`src/runner/loop.ts:799` `checkWorkspaceForDispatch`），untracked 不动 |
| verify 重跑 | 干净 checkout 到 mktemp 工作区（canon P7，约 348 行） | 未做干净 checkout——verify 在项目 cwd 直接重跑 |

锁定 M1 简化的位置：`src/runner/loop.ts:48`（模块头注释「M1 简化（验收文档锁定）：workdir = cwd 本身……M2 集成时升级」）与 `src/runner/loop.ts:612`（brief 里的 workdir 行）。`.cw-spawn/` 产物目录（stdout/stderr/brief）随 workdir 落在项目 cwd 下（`src/runner/loop.ts:625`、`src/runner/spawn/pi.ts:84`）。

## 2. 为什么是高严重度（不修的风险）

共享 cwd 下，并发与串行污染都真实存在，终验 PASS 含运气成分：

1. **并行污染**：maxConcurrency=3 时最多 3 个 agent 同写一个工作区。两个 builder 改同一文件 → 后提交者 `git add -A` 把前者的半成品混进自己的 commit；commit hash 进证据链后无法审计「这个 commit 到底是谁的产出」。
2. **串行污染（已被近似缓解）**：失败 builder 的未提交 tracked 半成品会进入下一轮任意 unit 的派发。`checkWorkspaceForDispatch` 只在**无 in-flight 时** reset——有 agent 在跑时只能提示不清理，窗口期内派发的 agent 仍可能读到脏工作区。
3. **verify 语义弱化**：P7 的「干净 checkout 重跑」防的是「工作区恰好被改过导致重跑结果失真」。当前重跑直接用项目 cwd，工作区状态不可控。
4. **认知外文件风险**：reset --hard 的近似实现刻意不动 untracked（防误删用户文件），代价是 untracked 半成品（如构建产物）仍会污染后续派发——独立 worktree 下无此权衡。

## 3. 升级设计要点（待决策清单）

按依赖顺序，每项给出推荐与理由。标注「长期」= 架构正确归位；「短期」= 已知妥协。

### D-W1 worktree 物理布局（推荐：`~/.cw-worktrees/<encoded-cwd>/<unitId>`）

- canon 原文只写了 `~/.cw-worktrees/<unitId>`，跨项目同名 unitId 会撞——加 `<encoded-cwd>` 一层（编码复用 `src/store/project.ts` 的 encodeCwd 产出，保持与 `~/.cw/<encoded-cwd>/` 账本目录同 key，便于归属排查）。**长期方案**。
- 备选（短期）：worktree 放项目仓库内子目录——不可取，agent 的 `git add -A` 会把 worktree 目录吞进 commit。

### D-W2 分支策略（推荐：每 unit 一分支，base = root unit 的 spec 冻结时 HEAD）

- 每 unit 一个分支 `cw/<rootId>/<unitId>`：agent 在自己分支上 commit，evidence 的 commit hash 天然可审计。**长期方案**。
- base 的选择是本 handoff 里最需要用户拍板的点：spec 冻结时的 HEAD 意味着「设计基于的代码快照」，但多子并行时各自 base 相同、集成时由内部节点 verify 的契约比对兜底一致性。备选：base = 派发时刻 HEAD（更实时但 spec 与代码可能错位）。
- 集成语义衔接：内部节点集成 verify 需要「子的 commit 集合」。共享 cwd 下隐式拿到（都在 HEAD）；独立分支后必须显式 merge/checkout 到集成工作区——canon B.1/B.2 的「干净 checkout」正好在此合流（集成 verify 也在干净 checkout 里跑）。

### D-W3 reset 语义回归精确（推荐：删近似实现，回到 canon 原文）

- 独立 worktree 后，`checkWorkspaceForDispatch` 的共享 cwd 近似（含 `--no-optional-locks` 权衡）整体删除，替换为：对该 unit 的 worktree `git reset --hard` + 可选 `git clean -fd`（此时 clean 是安全的——worktree 内不存在认知外文件）。同时 `src/runner/spawn/lifecycle.ts` 注释里的 M1 简化说明同步更新。
- 注意保留「有 in-flight 不清理」分支的等价物：同一 unit 的 worktree 同时只有一个 agent（canon：每 unit 最多 1 builder + 1 reviewer），reviewer 在跑时不清 builder 的产出——按 role 维度判断即可。

### D-W4 生命周期与清理（推荐：unit closed 后延迟清理，evidence 已保底）

- unit closed → worktree 可删（commit 已在证据链、产物在 `~/.cw/<encoded-cwd>/evidence/`）。但 debug 常需要翻看 agent 的实际工作区——推荐延迟清理（下一轮循环统一回收上一轮 closed 的 worktree），失败/转人工的 worktree 一律保留并打印路径。**长期方案**。
- 根 unit closed 的汇总输出里追加 worktree 回收清单。

### D-W5 与现有机制的交互（无需决策，实现约束）

- **CW_HOME 不变**：账本仍在 `~/.cw/<encoded-cwd>/`，worktree 只替换 agent 的工作区，不迁移任何状态。
- **brief 与 .cw-spawn**：`workdir` 换成 worktree 路径后，brief/stdout/stderr 自然跟随（都是 `join(workdir, ".cw-spawn", …)`，见 `src/runner/loop.ts:625`、`src/runner/spawn/pi.ts:84`）——不需要额外改动。
- **human 适配器**：wait() 只读账本，与 workdir 无关；但人接手时需要 cd 到 worktree——转人工指引文案（`src/runner/loop.ts` `escalationMessage`）里的路径要跟随 workdir。
- **frontier/投影零影响**：升级不改任何账本语义，282 个既有测试不应有语义性失败（可能有测试断言了 `.cw-spawn` 在项目 cwd 下——grep `tests/` 里的 `.cw-spawn` 路径断言，升级时同步）。

### D-W6 集成 verify 的干净 checkout（推荐：与 D-W2 合并实现）

- canon P7（verify 重跑在干净 checkout）在叶子 verify 与集成 verify 两处生效。实现：`git worktree add --detach <mktemp-dir> <commit-hash>` → 跑验收 → 删目录。commit hash 来自账本 EvidenceSubmitted，防「工作区现状」冒充「证据对应状态」。
- 这是 Goodhart 纪律的落地：重跑结果只信 commit，不信工作区。

## 4. 验收建议（升级完成的判据）

1. **并发污染对抗测试（新增，必须）**：两个 builder 并行、验收目标互相冲突（同文件不同改法）——各自 commit 只含各自产出（`git show --stat <hash>` 断言），互不混入。
2. **半成品清理回归（改造既有 u7b 系）**：builder 失败留 tracked+untracked 脏 → 重派时 worktree 全净（reset+clean），untracked 也清（独立 worktree 内无认知外文件顾虑）。
3. **集成干净重跑**：人为把项目 cwd 改脏 → 集成 verify 仍按账本 commit 的干净 checkout 跑，结果不受 cwd 状态影响。
4. **终验靶子重跑**：`cw run --spawn pi`（mimo-v2.5-pro）在 `/Users/zhushanwen/Code/test-repo/recursive-split-e2e/` 无人干预跑到根 closed（沿用既有终验口径，见 `test-brief.md` 存档）。
5. 全量测试绿（282+ 新增）。

## 5. 相关锚点索引

| 内容 | 位置 |
|------|------|
| canon worktree 终态（数据流图 / workdir 注释 / reset / P7） | `.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md` 约 324 / 439 / 460 / 348 行（本轮 canon 修订已加实现现状标注） |
| M1 简化锁定声明 | `src/runner/loop.ts:48`、`src/runner/loop.ts:612` |
| 近似 reset 实现（升级时删除） | `src/runner/loop.ts:799` `checkWorkspaceForDispatch` 及其调用点 `loop.ts:960` |
| workdir 契约与产物路径 | `src/runner/spawn/types.ts:16,32`、`src/runner/spawn/pi.ts:81-85` |
| 转人工指引路径 | `src/runner/loop.ts` `escalationMessage`（stdoutPath 拼接处） |
| 本轮修复波次记录 | `docs/rewrite/ledger.md`「对抗审查修复（2026-08-16）」节 |

# ADR 0014: cw store 归属与 workspace 解耦（repo 级 common-dir 键控）

## 状态

Accepted — 2026-08-09

决策来源：[docs/cw-store-workspace-decoupling.md](../cw-store-workspace-decoupling.md)（方案 A + 减法决策）

## 背景

cw-cli 用单一 `workspacePath` 同时承担两个正交职责：

1. **store 键控**——任务元数据存哪个文件（`getCwJsonPath` = `~/.cw/<encodeCwd(cwd)>/store.json`）
2. **workspace**——git/测试/文件操作在哪个目录跑（`constructCwDeps` 的 gitValidator/testRunner/fileExists 都绑 `workspacePath`）

`workspacePath = parsed.workspace ?? process.cwd()`（per-cwd）。在「cwd = repo 根 = 工作树」的单 cwd 时代无害。bare repo + worktree 模式下崩溃：ADR-0045（cw-tool 项目）用 `dirname(git-common-dir)` 试图归一化，但 `dirname(.bare)` 落到 workspace 容器（非任何 worktree），cw 在容器探测 git 失败 → store 命中失败 + git/test 跑错地方，全线失效。

根因两层：① 概念混淆（「store 归属」与「执行位置」是两个正交维度，用单一值耦合）；② 职责错层（store 归一化放在 cw-tool 调用层，bash 不经 cw-tool 永远 per-cwd，bash/cw-tool 结构性割裂）。

## 决策

1. **store 归一化下沉 cw-cli 内部**：`getCwJsonPath` 用 `git rev-parse --path-format=absolute --git-common-dir` 做 store-key（绝对路径原值，不加 dirname），同一 repo 所有 worktree 共享同一 store。归一化是 cw-cli 内部决策，bash 与 cw-tool 走同一路径，割裂消除。
2. **workspace 用 show-toplevel**：gitValidator/testRunner/fileExists 用当前 worktree 根（`git rev-parse --show-toplevel`），与 store-key 解耦。
3. **testCwd 收紧为相对仓库根**：旧契约允许绝对路径（`plan.ts:73-74` 注释 + `cli.ts:669` isAbsolute 分支），跨 worktree 共享 store 后绝对路径会错位；design/replan 入参校验拒绝绝对路径（机器检查）。
4. **不迁旧 store**：旧 per-cwd store 弃用（本项目单人使用、存量可弃，准则 8 减法优先），不做归属/N→1 合并/并发互斥/冲突仲裁。配套启动弃用 warning + minor 版本（决策 9）。
5. **探测失败降级**：非 git 目录 fallback per-cwd（保持现状行为）。
6. **`--workspace` 后向语义**：probe 基准 + 执行基准，不是 store-key（store-key 恒为 probe 出的 common-dir，非 git 目录才 fallback 回 workspace 值）。

## 后果

**正面**：
- bare repo worktree 下 cw 全线可用（store 命中 + git/test 在正确 worktree）
- bash 与 cw-tool 走同一 cw-cli 归一化，割裂消除（G2）
- 递归编排跨 worktree 任务树共享（G3，common-dir 相同 → 同一 store）

**负面 / 代价**：
- breaking change（默认 store 路径变 + testCwd 契约收紧），存量 cw 任务需重建（已确认接受，单人项目）
- 依赖 cw-tool（ADR-0045）同步删 `detectRepoWorkspace` + `--workspace` 透传（S2 协调需求，跨项目）
- S1/S2 须版本契约（peerDependencies 或能力探测），否则两 npm 包独立升级会错配回退割裂

## 与现有决策关系

- **Supersedes ADR-0045**（cw-tool 项目）的实现——`dirname(common-dir)` 算法 + 归一化放 cw-tool 调用层。继承其核心洞察：store 应 repo 级共享、用 common-dir 做标识。
- **复用 ADR-0008** 的 RepoMeta（remoteUrl/worktreePath）——弃用 warning 检测用 `getCwJsonPath(旧cwd)` 路径存在性，不做迁移归属。

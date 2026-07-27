---
name: remove-worktree
description: >-
  清理 git worktree。默认检查分支是否已合并到 main，确认安全后才删除。
  支持参数：--force（跳过合并检查，强制清理）、--skip-sync（跳过同步其他 worktree）。
  当用户说"删除worktree"、"remove worktree"、"清理worktree"、"清理分支"、"删除分支"、
  "remove-worktree"、"清理工作区"时使用此 skill。即使用户只是说"这个分支不要了"或
  "帮我清理一下"，也应考虑触发此 skill。仅用于 coding-workflow 项目。
---

# Remove Worktree

安全清理 git worktree，支持合并状态检查和同步其他 worktree。

## 脚本

本 skill 自包含，脚本内联了 workspace 操作函数，无外部 `_lib` 依赖：

```
.agents/skills/remove-worktree/remove-worktree.sh <branch-name> [--force] [--skip-sync]
```

### 参数

| 参数 | 位置/标志 | 必填 | 说明 |
|------|----------|------|------|
| `branch-name` | $1 | 是 | 要清理的分支名，如 `feat/old-feature`。`/` 自动转为 `-` 作为目录名 |
| `--force` | flag | 否 | 跳过合并检查和未提交变更检查，强制删除 |
| `--skip-sync` | flag | 否 | 跳过同步其他 worktree 到 origin/main |

### 用法示例

```bash
cd /Users/zhushanwen/Code/coding-workflow-workspace

# 安全模式：检查已合并 → 同步其他 worktree → 删除
bash .agents/skills/remove-worktree/remove-worktree.sh feat-replan-process-refactor

# 强制删除（未合并的分支）
bash .agents/skills/remove-worktree/remove-worktree.sh feat-experiment --force

# 强制删除且跳过同步
bash .agents/skills/remove-worktree/remove-worktree.sh feat-quick-test --force --skip-sync

# 只删除不同步（比如知道其他 worktree 有冲突不想处理）
bash .agents/skills/remove-worktree/remove-worktree.sh feat-done --skip-sync
```

### 脚本行为

#### 默认模式（无 --force）

1. `git fetch origin --prune` 走 refspec 获取最新远程状态
2. `git branch --merged origin/main` 检查分支是否已合并

   **依赖前提**：GitHub PR 必须使用 **Create a merge commit** 合并。如果仓库使用 Squash merge 或 Rebase merge，`git branch --merged` 会误判为"未合并"（原始 commit hash 不会进入 main）。此时需用 `--force`，或通过 `gh pr list --state merged --json headRefName` 确认 PR 状态。
3. **未合并 → 拒绝删除**，显示未合并 commits，提示使用 `--force`
4. 检查未提交变更（有变更 → 拒绝删除）
5. 同步其他 worktree：`git fetch origin && git merge --no-ff origin/main`
6. 冲突时不 abort，保留冲突状态供 AI 处理
7. 删除目标 worktree 和本地分支

#### 强制模式（--force）

1. 跳过合并检查
2. 有未提交变更时警告但仍继续（用 `git worktree remove --force` 强制删）
3. 同步其他 worktree（除非 --skip-sync）
4. 删除目标 worktree 和本地分支（`git branch -D` 强制删）

### 输出

安全模式（已合并）：
```
Workspace: /Users/zhushanwen/Code/coding-workflow-workspace

=== 检查合并状态 ===
✓ 分支 'feat-replan-process-refactor' 已合并到 origin/main

=== 同步其他 worktree 到 origin/main ===
同步 feat-other (feat/other)...
  OK: feat-other 已同步到最新 main

=== 清理 worktree feat-replan-process-refactor ===
删除 worktree 'feat-replan-process-refactor'...
删除本地分支 'feat-replan-process-refactor'...

============================================
Remove worktree 完成!
  已删除: feat-replan-process-refactor
  已同步: 1 个 worktree
  冲突: 0
============================================
```

未合并时拒绝：
```
=== 检查合并状态 ===
✗ 分支 'feat/wip' 尚未合并到 origin/main

未合并的 commits:
  a1b2c3d feat: work in progress
  e4f5g6h wip: more changes

Error: 分支未合并，拒绝删除。使用 --force 强制清理。
```

### 错误场景

| 输出 | 原因 | 解决 |
|------|------|------|
| `分支未合并，拒绝删除` | 分支未合并到 main | 确认不需要后加 `--force` |
| `worktree 有未提交变更` | 有未保存改动 | 提交或暂存后重试，或 `--force` |
| `worktree 目录不存在` | 分支名错误或已删除 | 检查 `git worktree list` |
| `未找到 workspace` | 不在 workspace 目录下 | cd 到 workspace 子目录 |

### AI 操作步骤

1. 向用户确认要清理的分支名
2. 询问是否强制删除（如果分支可能未合并）
3. **先 cd 到 workspace 根目录**（避免后续删除当前工作目录导致 bash 失败）：
   ```bash
   cd /Users/zhushanwen/Code/coding-workflow-workspace
   ```
4. 运行清理脚本：
   ```bash
   bash .agents/skills/remove-worktree/remove-worktree.sh <branch-name> [--force] [--skip-sync]
   ```
5. 确认输出包含 `"Remove worktree 完成!"`
6. 如果有 merge 冲突，处理冲突：
   - 冲突文件列表：`git diff --name-only --diff-filter=U`
   - 解决后：`git add . && git commit`
   - 放弃同步：`git merge --abort`

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 历史经验总结的规则。来自实际事故和教训，经验证有效后固化为规则 | 不允许删除或削弱，修改时只能加强 |

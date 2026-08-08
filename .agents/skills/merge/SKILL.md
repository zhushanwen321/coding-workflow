---
name: merge
description: >-
  合并分支并发布。触发词："合并"、"merge"、"发布"、"release"、
  "上线"。仅用于 coding-workflow 项目。自包含：动态定位 workspace/main worktree
  （不写死路径），main 不存在自动创建兜底，清理阶段只同步 main 不触碰其他 worktree。
---

# Merge

> **范围**：coding-workflow 的手动合并 + 发布流程。单包项目，版本管理用单一 `package.json` + `npm version`，发布由 push tag 触发的 GitHub Actions `release.yml` 自动完成（`npm publish --provenance`）。
>
> **自包含**：本 skill 自带两个脚本（`merge-helpers.sh` / `cleanup-worktree.sh`），不依赖 remove-worktree 或任何其他 skill。所有路径动态解析，不写死。

## workspace 定位（全流程前置）

本 skill 通过 `merge-helpers.sh` 动态解析路径，**全程不写死绝对路径**：

| 子命令 | 输出 | 用途 |
|--------|------|------|
| `selfcheck` | workspace root / main 分支 / main worktree（三行） | 阶段 0 前置验证 |
| `root` | workspace root 路径 | 定位 feature worktree（`$WS_ROOT/<分支名 / 换 ->`） |
| `resolve-main` | main worktree 路径（不存在则**自动创建**） | 阶段 3 需要进入 main worktree 时 |
| `sync-main` | 同步 main worktree 到 `origin/<main>` | 阶段 3.1、阶段 6 清理后 |

**main worktree 兜底机制**：`resolve-main` / `sync-main` 发现 main worktree 不存在时，会自动 `fetch origin` + `worktree add` 创建（基于 `origin/<main>`）。创建失败则明确报错退出，绝不 cd 失败后静默在错误目录继续。

**[设计约束] 只同步 main**：`sync-main` 只在 main worktree 内执行 `fetch + merge --ff-only`，**绝不遍历其他 feature worktree**。feature worktree 的同步是各分支自己的职责，merge 流程不越权触碰。

## 流程阶段

### 阶段 0: 前置确认 + 动态定位

1. 用 selfcheck 动态定位并验证 main worktree 可用（不存在会自动创建）：

```bash
bash .agents/skills/merge/merge-helpers.sh selfcheck
```

输出示例（路径动态解析，非写死）：
```
Workspace root: /path/to/coding-workflow-workspace
Main branch:    main
Main worktree:  /path/to/coding-workflow-workspace/main
✓ 自检通过
```

2. 确认其余前置条件：
   - 当前位于 **workspace root 或某 worktree 内**（selfcheck 能定位即可，无需特定起点）
   - feature 分支的 PR 已创建且为 open 状态（`gh pr view <num> --json state`）
   - 已确定版本类型（patch / minor / major）

### 阶段 1: 本地验证

在 feature worktree 内执行全量检查。feature worktree 路径 = `$WS_ROOT/<分支名中的 / 换成 ->`：

```bash
WS_ROOT=$(bash .agents/skills/merge/merge-helpers.sh root)
FEATURE_DIR="${BRANCH_NAME//\//-}"   # 例 feat/foo → feat-foo
cd "$WS_ROOT/$FEATURE_DIR"

npm run check:all   # tsc 类型检查（src + tests，比单独 check 更全）
npm run lint        # eslint src/ tests/
npm test            # vitest run（单测 + e2e）
npm run build       # tsc + 生成 schemas（确认产物可生成）
```

**[MANDATORY] 零容忍**：任何失败必须正面修复，不允许跳过。四项均 exit 0 方可继续。

本项目无 `.githooks/pre-commit`，也无 PR 上的 CI（无 `ci.yml`），本地验证是合并前唯一的质量门。

### 阶段 2: PR 合并

本项目无 `ci.yml`，PR 上不跑 CI，可直接合并。用 merge commit 合并（保护 main 历史，全局规范要求 main 必须 `--no-ff`）：

```bash
# merge commit 合并并删除远程分支（绝不用 squash）
gh pr merge <PR_NUM> --merge --delete-branch
```

### 阶段 3: 版本 bump + tag + push

**[MANDATORY] 在 main worktree 内执行**（用 `resolve-main` 动态定位，不写死）。

#### 3.1 同步 main

```bash
bash .agents/skills/merge/merge-helpers.sh sync-main
```

脚本内部：动态定位 main worktree → `git fetch origin`（**不带分支名，走 refspec**）→ `git merge --ff-only origin/<main>`。只在 main worktree 执行，不触碰其他 worktree。

**[HISTORICAL] 禁止用 `git fetch origin main`**：带显式分支参数的 fetch 只写 `FETCH_HEAD`，不更新 `refs/remotes/origin/main`，后续 `merge --ff-only origin/main` 会读到陈旧 ref 导致静默同步失败。2026-07-27 事故：`git fetch origin main` 后 origin/main 仍停在旧 commit，本地 main 碰巧等于旧 commit 被 ff-only 判为 "already up to date" 跳过，远程新 commit 完全没同步进来。根因是 bare repo 初始化时 `remote.origin.fetch` refspec 为空，已修复补 `+refs/heads/*:refs/remotes/origin/*`；此处 fetch 命令也必须走 refspec（不带分支名）。

#### 3.2 确定版本类型

根据本次变更判断版本类型（与用户确认）。判断标准：

**patch**（默认）：
- bug fix（handler 逻辑修复、guard 误判修正）
- 内部重构（不改变 exports / CLI 行为的模块拆分、类型提取）
- 文档更新（CONTEXT.md / ARCHITECTURE.md / prompts 内容调整）
- 测试补充（新增测试用例、提升覆盖率）
- 不影响 CLI 行为的改动（日志优化、错误信息文案、内部工具函数）

**minor**：
- 新增 action（状态机新增可执行动作，如 `retrospect`）
- 新增 gate（新增机器检查门，如新增一个 `code-review-gate`）
- 新增 handler（实现新的 action handler）
- CLI 新增子命令（如 `cw tree`、`cw handoff`）
- 向后兼容的能力增强（gate 检查更严格但不阻断已通过的流程、guidance 内容改进）

**major**：
- action 语义改变（已发布的 action 含义或行为发生变化，现有 agent 调用方式不兼容）
- 状态机转换规则修改（合法 transition 变更、新增/删除线性路径约束）
- CLI 参数不兼容（已有子命令参数格式变化、输出 JSON schema 变更）
- 删除已发布的 action / gate / handler（下游依赖断裂）

#### 3.3 bump 版本（在 main worktree 内）

```bash
cd "$(bash .agents/skills/merge/merge-helpers.sh resolve-main)"

CURRENT_VER=$(node -p "require('./package.json').version")
npm version <patch|minor|major> --no-git-tag-version
NEW_VER=$(node -p "require('./package.json').version")
echo "版本: $CURRENT_VER → $NEW_VER"
```

#### 3.3.5 CHANGELOG 生成

**[OPTIONAL]** 自动生成变更记录。基于 conventional commits 前缀（feat/fix/chore/docs/refactor/test）提取，追加到 `CHANGELOG.md`。

```bash
# 仍在 main worktree 内
PREV_TAG=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || echo "")
TAG="v$NEW_VER"

if [ -n "$PREV_TAG" ]; then
  RANGE="${PREV_TAG}..HEAD"
else
  RANGE="HEAD"
fi

{
  echo ""
  echo "## [$TAG] - $(date +%Y-%m-%d)"
  echo ""

  # feat
  FEATS=$(git log "$RANGE" --pretty=format:"- %s (%h)" --grep="^feat" --extended-regexp)
  if [ -n "$FEATS" ]; then
    echo "### Features"
    echo "$FEATS"
    echo ""
  fi

  # fix
  FIXES=$(git log "$RANGE" --pretty=format:"- %s (%h)" --grep="^fix" --extended-regexp)
  if [ -n "$FIXES" ]; then
    echo "### Bug Fixes"
    echo "$FIXES"
    echo ""
  fi

  # refactor
  REFACTORS=$(git log "$RANGE" --pretty=format:"- %s (%h)" --grep="^refactor" --extended-regexp)
  if [ -n "$REFACTORS" ]; then
    echo "### Refactoring"
    echo "$REFACTORS"
    echo ""
  fi

  # docs / test / chore（合并为 Miscellaneous）
  MISC=$(git log "$RANGE" --pretty=format:"- %s (%h)" --grep="^docs\|^test\|^chore" --extended-regexp)
  if [ -n "$MISC" ]; then
    echo "### Miscellaneous"
    echo "$MISC"
    echo ""
  fi
} >> CHANGELOG.md

# 检查是否真的有内容追加（排除空 header）
git diff --quiet CHANGELOG.md && echo "无 conventional commit，跳过 CHANGELOG" || echo "CHANGELOG 已更新"
```

若 CHANGELOG.md 不存在，先创建：

```bash
[ -f CHANGELOG.md ] || echo "# Changelog" > CHANGELOG.md
```

脚本无需额外依赖，纯 `git log` + `--grep` + 重定向。生成后可人工审阅再 commit。

#### 3.4 commit + tag + push

```bash
# 仍在 main worktree 内
git add -A
git commit -m "chore: bump version $CURRENT_VER → $NEW_VER" 2>/dev/null || echo "无变更需提交"
TAG="v$NEW_VER"
git tag "$TAG" 2>/dev/null || echo "Tag $TAG 已存在"
git push origin HEAD:refs/heads/main --tags
```

### 阶段 4: 等待 CI 发布完成

**[MANDATORY] npm 发布由 GitHub Actions 自动完成，禁止在本地执行 `npm publish`。**

发布流程：
1. 阶段 3.4 推送 `v*` tag → 触发 `.github/workflows/release.yml`
2. CI 执行：`npm ci` → `npm run build` → `npm test` → `npm pack --dry-run` → `npm publish --provenance`

等待 CI 完成：
```bash
gh run watch --workflow=release.yml
```

⚠️ release.yml 在发布前会跑 `npm run build` + `npm test`。如果阶段 1 的本地验证已通过，这里通常也会过。但 CI 环境与本地可能有 Node 版本差异（CI 用 node 20），出问题时优先排查 Node 版本兼容性。

### 阶段 4.5: 发布失败回滚

**[MANDATORY] 只在 CI 失败或 npm publish 产物有问题时执行。正常发布流程跳过此阶段。**

#### 场景 A: CI 失败但 tag 已推

tag 推送后 CI 构建/测试失败，版本未发布到 npm。需要清理 tag、修复后重新走 bump 流程。

```bash
cd "$(bash .agents/skills/merge/merge-helpers.sh resolve-main)"

# 1. 删除远程 tag
TAG="v$NEW_VER"
git push origin --delete "$TAG"

# 2. 删除本地 tag
git tag -d "$TAG"

# 3. 回退 bump commit（如果是纯 bump，reset 回上一个 commit）
git reset --hard HEAD~1

# 4. 修复问题（在 feature 分支修 → PR → merge，或直接在 main 修）

# 5. 重新走阶段 3.3 ~ 3.4（bump → tag → push）
```

#### 场景 B: npm publish 成功但包有问题

CI 发布成功，但包内容有误（构建产物损坏、关键文件缺失）。需在发布后 72 小时内 unpublish。

```bash
# 1. unpublish 版本（npm 限制：发布 72 小时内可 unpublish，超时不可逆）
npm unpublish @zhushanwen/coding-workflow@$NEW_VER

# 2. 删除对应 tag（防止下次 CI 再次发布同一版本）
git push origin --delete "$TAG"
git tag -d "$TAG"

# 3. 修复后重新走阶段 3.3 ~ 3.4
```

⚠️ `npm unpublish` 有时间窗口限制（72 小时），且会导致该版本号永久不可复用。发现越早操作越安全。超过窗口后只能发布修复版（新 patch），无法撤回已发布版本。

### 阶段 5: 交付物验证

确认 CI 发布成功后验证 npm registry：

```bash
NEW_VER=$(node -p "require('./package.json').version")
npm view @zhushanwen/coding-workflow@$NEW_VER version && \
  echo "  ✅ @zhushanwen/coding-workflow@$NEW_VER" || \
  echo "  ❌ MISSING: @zhushanwen/coding-workflow@$NEW_VER"
```

也可通过 GitHub Actions 页面确认：
```bash
gh run list --workflow=release.yml --limit=1
```

### 阶段 6: 清理（自包含）

用本 skill 自带的 `cleanup-worktree.sh` 清理 feature worktree。**自包含，不委托 remove-worktree skill**：

```bash
bash .agents/skills/merge/cleanup-worktree.sh <branch-name>
# 例: bash .agents/skills/merge/cleanup-worktree.sh feat-optimize-by-retrospec
```

脚本行为（自包含，workspace 函数复用同目录 `merge-helpers.sh`）：
1. 动态定位 workspace root（向上找 `.bare/`）
2. 检查分支已合并到 `origin/<main>`（未合并 → 拒绝删除，需 `--force`）
3. 检查 worktree 无未提交变更
4. 删除 feature worktree 目录 + 本地分支
5. **只同步 main worktree**（`sync-main`：fetch + merge --ff-only origin/main），**不遍历其他 feature worktree**
6. 清理指向被删 worktree 的 cw-cli dev symlink（切回 npm 版或删除）

**与原 remove-worktree 的关键差异**：去掉了"遍历同步所有 feature worktree"的逻辑——那是各分支自己的事，merge 流程不越权。只同步 main，确保本地 main 追上刚合并的远程提交。

参数：

| 参数 | 说明 |
|------|------|
| `<branch-name>` | 要清理的分支名，`/` 自动转 `-` 作为目录名 |
| `--force` | 跳过合并检查 + 未提交检查，强制删除（用 `git worktree remove --force` + `branch -D`） |

冲突处理：`sync-main` 的 ff-only 失败不阻塞清理（main 有独立 commit 的罕见情况），脚本只警告并继续。

## 项目特点

- **单包项目**：单一 `package.json`，`npm version` 直接 bump（无 changeset 独立版本）
- **发布方式**：push tag `v*` → `release.yml` 自动 `npm publish --provenance`
- **禁止本地发布**：`npm publish` 由 CI 执行（需要 `NPM_TOKEN` secret + provenance 签名），本地只做 bump + tag + push
- **无 PR CI**：本项目无 `ci.yml`，PR 不触发 CI。质量门完全依赖阶段 1 的本地验证
- **交付物**：npm registry 包（`@zhushanwen/coding-workflow`）

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
| `[HISTORICAL]` | 历史事故教训固化的规则 | 不允许删除或削弱，只能加强 |
| `[设计约束]` | 架构层面的明确边界约定 | 修改需评估对整体设计的影响 |

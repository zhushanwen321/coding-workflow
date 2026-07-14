---
name: merge
description: >-
  合并分支并发布。触发词："合并"、"merge"、"发布"、"release"、
  "上线"。仅用于 coding-workflow 项目。
---

# Merge

> **范围**：coding-workflow 的手动合并 + 发布流程。单包项目，版本管理用单一 `package.json` + `npm version`，发布由 push tag 触发的 GitHub Actions `release.yml` 自动完成（`npm publish --provenance`）。

## 流程阶段

### 阶段 0: 前置确认

- 当前位于 **workspace root**（`/Users/zhushanwen/Code/coding-workflow-workspace`），不在 feature worktree 内（阶段 6 会删 worktree）
- feature 分支的 PR 已创建且为 open 状态（`gh pr view <num> --json state`）
- 已确定版本类型（patch / minor / major）
- `main` worktree 可用（阶段 4 在 `$WS_ROOT/main` 内执行 bump/tag/push）

### 阶段 1: 本地验证

在 feature worktree 内执行全量检查：

```bash
cd /Users/zhushanwen/Code/coding-workflow-workspace/<feature-worktree>
npm run check    # tsc --noEmit 类型检查
npm run lint     # eslint src/ tests/
npm test         # vitest run（单测 + e2e）
npm run build    # tsc 编译到 dist/（确认产物可生成）
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

**[MANDATORY] 在 `main` worktree 内执行**（`cd /Users/zhushanwen/Code/coding-workflow-workspace/main`）。

#### 3.1 同步 main

```bash
cd /Users/zhushanwen/Code/coding-workflow-workspace/main
git fetch origin main
git merge --ff-only origin/main
```

#### 3.2 确定版本类型

根据本次变更判断版本类型（与用户确认）：

- **patch**（默认）：bug fix、内部重构、不影响 CLI 行为的改动
- **minor**：新增 action / 新增 gate / CLI 新增子命令、向后兼容的能力增强
- **major**：破坏性变更（action 语义改变、状态机转换规则修改、CLI 参数不兼容）

#### 3.3 bump 版本

```bash
CURRENT_VER=$(node -p "require('./package.json').version")
npm version <patch|minor|major> --no-git-tag-version
NEW_VER=$(node -p "require('./package.json').version")
echo "版本: $CURRENT_VER → $NEW_VER"
```

#### 3.4 commit + tag + push

```bash
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

### 阶段 6: 清理

用 `remove-worktree` skill 清理 feature worktree（会检查分支已合并到 main）。或手动：

```bash
cd /Users/zhushanwen/Code/coding-workflow-workspace
git worktree remove <feature-worktree>   # 删 worktree 目录
git branch -d <branch-name>               # 删本地分支（远程分支阶段 2 已删）
# 同步其他 worktree 的 main 引用
cd main && git fetch origin && git merge --ff-only origin/main
```

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

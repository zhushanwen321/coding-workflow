---
name: pull-request
description: >-
  提交 Pull Request。触发词："提交 PR"、"创建 PR"、"push"、"提交代码"、
  "pr-worktree"。仅用于 coding-workflow 项目。
---

# Pull Request

## 前提

当前在 worktree 目录中。可能有未提交的变更（会先 commit），也可能已全部 commit。

## 步骤

### 1. pre-merge 验证

```bash
# 类型检查（tsc --noEmit）
npm run check

# lint
npm run lint

# 测试（vitest run，含单测 + e2e）
npm test

# 构建检查（确认 tsc 编译不报错，产物在 dist/）
npm run build
```

**[MANDATORY] 零容忍**：任何失败都必须正面修复，不允许跳过。

本项目无 `.githooks/pre-commit`，pre-merge 验证是合并前唯一的本地质量门。三项（check / lint / test）均 exit 0 方可继续。

### 2. commit（如有未提交变更）

```bash
git status --porcelain  # 检查是否有未提交变更
```

- 若有未提交变更：用户提供 commit message（或 zcommit 生成），然后 `git add -A && git commit -m "$COMMIT_MSG"`
- 若工作树干净：跳过此步

### 3. 生成 PR title 和 body

**[MANDATORY] 自动从分支所有 commit 生成，无需用户提供。全部使用英文。**

流程：
1. 收集分支相对于 base（main）的所有 commit：
   ```bash
   git log main..HEAD --format="%s%n%b---"
   git diff main..HEAD --stat
   ```
2. 分析所有 commit message 和变更文件，总结本次 PR 的核心改动
3. 生成 PR title：
   - 格式：`fix(scope): short summary` 或 `feat(scope): short summary`（conventional commit 风格）
   - scope 常见值：`gate` / `state-machine` / `cli` / `plan-parser` / `prompts` / `store` / `dispatch`
   - 若涉及多个 scope，用最核心的那个，或用 `fix: short summary` 不带 scope
   - 简洁一行，概括整个分支的改动
4. 生成 PR body（英文）：
   - 用 `## Summary` 段落概括改动目的和内容
   - 用 `## Changes` 列表逐条列出各 commit 的关键改动（合并相关条目，不重复）
   - 包含 `## Test plan` 列出验证方式（如已有的 check/test/lint 结果）

### 4. push + 创建/更新 PR

```bash
# push（force-with-lease 安全推送）
git push origin HEAD --force-with-lease
```

判断 PR 是否已存在：
```bash
gh pr list --head $(git branch --show-current) --state open --json number,title,body
```

- **PR 不存在**：创建新 PR
  ```bash
  gh pr create --title "$PR_TITLE" --body "$PR_BODY" --base main
  ```

- **PR 已存在**：比较生成的 title/body 与现有 PR 的 title/body，仅在内容不同时更新
  ```bash
  gh pr edit $PR_NUMBER --title "$PR_TITLE" --body "$PR_BODY"
  ```

## 项目特点

- **单包项目**：验证命令用 `npm run`（非 `pnpm -r`），无子包遍历
- **无 CI workflow**：本项目无 `ci.yml`（PR 上不跑 CI），只有 tag 触发的 `release.yml`。pre-merge 验证完全依赖本地
- **无 changeset**：版本管理用单一 `package.json` + `npm version`（见 merge skill）

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |

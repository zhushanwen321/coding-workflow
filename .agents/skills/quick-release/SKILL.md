---
name: quick-release
description: >-
  coding-workflow 的快速发布流水线：简单改动（skill/docs/markdown 类，无 src/
  逻辑变更）直接走完 PR → 合并 → patch 发布全流程，触发词即全流程授权，中间零确认点。
  触发词："快速发布"、"直接发布"、"直接走完"、"quick release"、"简单改动发布"、
  "PR + merge + 发布走完"、"patch version 直接发布"。
  仅 coding-workflow worktree；仅限 markdown/skill/docs/CHANGELOG/版本号类文件改动
  （src/ 或插件包 pi-coding-workflow-extension/ 下有改动必须拒绝，转 pr-cr-fix + merge）；
  patch 默认，minor/major 需用户显式说明。不自创 git 命令，复用 merge-helpers.sh
  与 pr-cr-fix 的 PR 提交协议。
---

# Quick-Release — coding-workflow 快速发布流水线

pr-cr-fix + merge 的**轻量快车道**：只服务"简单改动直接发布"。用户说出触发词 = 全流程授权（审查、PR、合并、bump、发布一气呵成），不再逐阶段确认。

## 适用判定（MANDATORY 硬门槛，不满足即拒绝）

| 条件 | 判定 |
|------|------|
| 改动范围 | 限 markdown / skill / docs / CHANGELOG / 版本号类文件 |
| **src/ 有改动** | **拒绝走本 skill**，转 pr-cr-fix（review + PR）+ merge（发布）完整流程 |
| **插件包目录有改动** | **拒绝走本 skill**：`pi-coding-workflow-extension/` 下任何改动（含其 README/CHANGELOG——在插件包 files 白名单内、随 ext 包上 npm）随 ext 包经 `ext-v*` tag 发布，quick-release 只打 `v*` tag、永不发 ext 版（纯静默漏发），转 pr-cr-fix（review + PR）+ merge（发布，其 §3.2 有双包归属决策树） |
| **当前分支 = main**（`git log main..HEAD` 为空） | **拒绝走本 skill**：无分支 commits 可开 PR——`git push origin HEAD` 直推 origin/main 绕过 PR，随后 `gh pr create`（head==base）必败，停在「main 已推、PR 不存在」中间态；在 feature worktree（非 main 分支）内执行 |
| 版本类型 | patch（默认）；minor/major 需用户显式说明 |
| 工作位置 | coding-workflow git worktree 中 |

判定方法：先跑 `git log main..HEAD`——为空（当前在 main 分支或分支无 commits）→ 拒绝。再用 `git status --short` + `git diff --stat main...HEAD` 确认改动文件清单，逐个检查路径前缀。有任何 `src/`、`scripts/`、`tests/`、`package.json`（版本号除外）、`pi-coding-workflow-extension/`、配置类文件 → 拒绝。

## 前置：workspace 定位

复用 merge skill 的 helper（路径动态解析，不写死）：

```bash
bash .agents/skills/merge/merge-helpers.sh selfcheck
```

输出 workspace root / main 分支 / main worktree 三行，验证 main worktree 可用（不存在会自动创建）。

## 流程阶段

### 阶段 0：场景判定

1. 跑 `git status --short` 确认工作区改动
2. 跑 `git diff --stat main...HEAD`（有 commit 时）确认改动范围
3. 按「适用判定」表检查——任一硬门槛不满足 → 停手，向用户说明原因并转 pr-cr-fix + merge
4. 确认版本类型（patch 默认，无需问）

### 阶段 1：改动落源（MANDATORY，检测后按需执行）

**背景**：skill 类文件（`~/.agents/skills/*`、`~/.agents/agents/*`）是 symlink，指向 **npm 包安装目录**（`npm root -g` 下的 `@zhushanwen/coding-workflow/skills/*`）。在这些路径直接改的 skill 内容**不在 git 仓库里**，发布时会被新包覆盖丢失。发布前必须把改动同步回仓库源。

检测：

```bash
# 仓库内是否已有改动（干净 = 改动在仓库外，如 node_modules 安装版）
git status --short
# 若干净：确认 symlink 目标位置
readlink ~/.agents/skills/tech-design 2>/dev/null   # 示例：找对应 skill 的 symlink
```

仓库外有改动（node_modules 安装版）时同步回仓库源：

```bash
# 示例：tech-design skill 安装版 → 仓库源
SRC=$(readlink ~/.agents/skills/<skill> | sed 's|/skills/[^/]*$||')
# 安装版路径 = symlink 目标（即 SRC 指向的 skills/<skill>）
INSTALLED=$(readlink ~/.agents/skills/<skill>)
# 仓库源 = 当前 git 根目录的 skills/<skill>
REPO_SKILL=$(git rev-parse --show-toplevel)/skills/$(basename $INSTALLED)

cp -R "$INSTALLED/." "$REPO_SKILL/"
# 验证零差异（必须无输出）
diff -rq "$INSTALLED" "$REPO_SKILL"
```

⚠️ 只复制本次改动的文件（或整目录覆盖后 diff 验证零差异）；**禁止复制 node_modules 里的无关改动**。验证后 `git status --short` 应显示这些文件为 modified。

### 阶段 2：轻量自查（MANDATORY）

markdown 类改动不做多维 review、不跑 npm 四件套（不碰 src/，tsc/eslint/vitest 全无感）。主 agent 直接自查：

1. **diff 审读**：`git diff` 通读全部改动，确认内容正确、无笔误、无半截编辑
2. **一致性 grep**（skill/docs 类改动重点）：
   - 文件间互相引用的路径/文件名存在（`rg` 内链，逐个验证目标文件存在）
   - 计数一致（如"8 条红线""12 条准则"与实际列表条数、编号最大号一致）
   - 无残留旧术语/旧引用（如改名为 grill 机制后不应再出现 clarifications）
   - markdown 表格、代码块结构完整（`---` 分隔行数量、围栏成对）

发现任何问题 → 先修再进阶段 3。这是本流程唯一的自查门，**不允许跳过**。

### 阶段 3：commit + push + 开 PR

复用 pr-cr-fix 的 PR 提交协议，**跳过 pre-merge npm 四件套**（本 skill 硬门槛已保证无 src/ 改动）：

```bash
git add -A && git commit -m "<conventional commit>"
git push origin HEAD --force-with-lease
gh pr list --head $(git branch --show-current) --state open --json number,title,body
```

PR 不存在则创建：

```bash
gh pr create --title "<title>" --body "<body>" --base main
```

- title/body 全英文，conventional commit 风格（scope 用 `skill`/`docs`）
- body：`## Summary`（改动目的）+ `## Changes`（改动文件清单）+ `## Test plan`（说明 markdown 改动已过一致性自查，不跑 npm 四件套的原因）
- PR 已存在（如复用旧 PR）则 `gh pr edit` 更新

### 阶段 4：合并 PR（MANDATORY 用 merge commit，绝不用 squash）

```bash
gh pr merge <PR_NUM> --merge --delete-branch
```

`--merge` = merge commit（保护 main 历史完整，`git branch --merged main` 可识别）；`--delete-branch` 删远程 feature 分支。

### 阶段 5：bump patch + tag + push（MANDATORY 在 main worktree 内）

```bash
cd "$(bash .agents/skills/merge/merge-helpers.sh resolve-main)"
bash .agents/skills/merge/merge-helpers.sh sync-main    # fetch + ff-only origin/main

CURRENT_VER=$(node -p "require('./package.json').version")
npm version patch --no-git-tag-version
NEW_VER=$(node -p "require('./package.json').version")
echo "版本: $CURRENT_VER → $NEW_VER"
```

CHANGELOG 追加本版段（轻量版，不走 merge 的 git log 提取；header 格式对齐 merge §3.3.5——先写版本 header 再写条目，裸条目会挂进上一版本段；quick-release 只 bump 根包，TAG 恒为 `v` 前缀）：

```bash
{
  echo ""
  echo "## [v$NEW_VER] - $(date +%Y-%m-%d)"
  echo ""
  echo "- <改动一句话> (#$(gh pr view <PR_NUM> --json number -q .number))"
} >> CHANGELOG.md
```

commit + tag + push：

```bash
git add -A && git commit -m "chore: bump version $CURRENT_VER → $NEW_VER"
git tag "v$NEW_VER"
git push origin HEAD:refs/heads/main "v$NEW_VER"
```

> ⚠️ 禁止 `git push --tags`：会重推陈旧本地 tag、误触发发布流水线（merge skill §3.4 同款约束）——只推本次新建的显式 tag。
>
> ⚠️ 禁止 `git fetch origin main`（走 refspec 的 fetch 才更新 origin/main ref，merge skill 有 [HISTORICAL] 事故记录）——`sync-main` 已正确处理，直接用它。

### 阶段 6：等 CI 发布 + 验证 + 清理

npm 发布由 GitHub Actions 自动完成（`release.yml`：npm ci → build → test → pack → publish --provenance），**禁止本地 npm publish**：

```bash
gh run watch --workflow=release.yml
```

验证 npm registry：

```bash
npm view @zhushanwen/coding-workflow@$NEW_VER version
```

清理 feature worktree（复用 merge skill 脚本）：

```bash
bash .agents/skills/merge/cleanup-worktree.sh <branch-name>
```

**清理后确认 symlink 安装版已更新**：npm 包更新后，symlink 目标（`npm root -g` 下安装目录）内容应为新版本。**先校验 symlink 指向**：目标位于 `$(npm root -g)/@zhushanwen/coding-workflow/` 之下才做内容比对——symlink 指向本地仓库时，rg 读的是本地文件，无论 CI 发布成败都会命中（假阳性）：

```bash
LINK_TARGET=$(readlink ~/.agents/skills/<skill>)
NPM_INSTALL_PREFIX="$(npm root -g)/@zhushanwen/coding-workflow/"
case "$LINK_TARGET" in
  "$NPM_INSTALL_PREFIX"*)
    rg -n "<本次改动标记内容>" "$LINK_TARGET"   # 改动内容出现在安装版 = 发布生效
    ;;
  *)
    echo "⚠️ symlink 指向本地仓库而非 npm 安装目录，内容比对无发布验证意义，以 npm view 与 CI run 为准" >&2
    ;;
esac
```

## 关键约束 [MANDATORY]

1. **硬门槛不可绕过**：`src/` 或插件包 `pi-coding-workflow-extension/` 有改动必须拒绝转 pr-cr-fix + merge，不允许"这次先走 quick-release"
2. **改动落源不可跳过**：symlink 目标（npm 安装版）里的改动，发布前必须同步回仓库源并 diff 验证零差异
3. **合并必须 merge commit**：`gh pr merge --merge`，禁止 squash/rebase（保护 main 历史，全局规范）
4. **bump 在 main worktree**：版本号、tag、push 只在 main worktree 执行（`resolve-main` 定位），不在 feature worktree
5. **禁止本地 npm publish**：发布由 CI 完成；本地只做 bump + tag + push
6. **零确认点**：用户触发词 = 全流程授权。唯一例外——硬门槛不满足（转完整流程）或 CI 发布失败（走失败恢复）
7. **自查门不跳过**：阶段 2 一致性 grep 是 markdown 改动的质量兜底，发现残留/断链必须修完再走

## 失败恢复

| 失败 | 动作 |
|------|------|
| 硬门槛不满足（src/ 有改动） | 停手，转 pr-cr-fix（review+PR）+ merge（bump+发布） |
| 阶段 1 diff 验证有差异 | 检查复制遗漏的文件，重新同步直到 `diff -rq` 无输出 |
| 阶段 2 自查发现问题 | 修复后重跑一致性 grep，全绿再进阶段 3 |
| push 冲突 | `git fetch && git rebase` 后重试 push |
| PR 已存在 | `gh pr edit` 更新 title/body，不重复创建 |
| CI 发布失败（tag 已推） | 按 merge skill 阶段 4.5 场景 A 回滚：删远程/本地 tag（**不 reset commit**——commit 保留，下次 bump 时版本号已就位；reset 会使本地 main 与 origin 分叉）→ 修复问题 → 重新走版本 bump + tag + push |
| npm 包发布成功但有误 | 按 merge skill 阶段 4.5 场景 B：72h 内 unpublish → 删 tag → 修复 → 重新发布 |
| 清理 worktree 后会话 cwd 失效 | 正常现象（当前会话 cwd 锁在已删 worktree）。停止 bash 操作，改用绝对路径 read/edit，或新会话继续（merge skill [HISTORICAL] 教训） |

## 与 pr-cr-fix / merge 的分工

| 场景 | 走哪个 |
|------|--------|
| markdown/skill/docs 简单改动，用户授权直接发布 | **quick-release** |
| src/ 逻辑改动 + review + 发布 | pr-cr-fix（审查/修/PR）→ merge（合并/发布） |
| 只开 PR 不发布 | pr-cr-fix |
| 已有 PR，只合并 + 发布 | merge |
| 只合并不发布（无需 bump） | merge（跳过阶段 3-5） |

## 标记说明

| 标记 | 含义 |
|------|------|
| `[MANDATORY]` | 流程强制要求，不遵守会导致发布错误或流程失败 |

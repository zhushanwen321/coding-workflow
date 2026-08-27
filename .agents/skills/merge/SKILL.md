---
name: merge
description: >-
  合并分支并发布。触发词："合并"、"merge"、"发布"、"release"、
  "上线"。仅用于 coding-workflow 项目。自包含：动态定位 workspace/main worktree
  （不写死路径），main 不存在自动创建兜底，清理阶段只同步 main 不触碰其他 worktree。
---

# Merge

> **范围**：coding-workflow 的手动合并 + 发布流程。双包 monorepo（核心包 `@zhushanwen/coding-workflow` + 插件包 `@zhushanwen/pi-coding-workflow`），版本独立管理，发布由 push tag 触发的 GitHub Actions `release.yml` 自动完成（`npm publish --provenance`）。
>
> **tag 协议**：`v*` → 核心包；`ext-v*` → 插件包。双包都 bump 时两段式推送（先核心后插件）。
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

2. D9 gate 接入守卫：验证步骤依赖仓外 cw CLI，缺失/过旧时出声转人工（禁止静默回退裸跑——账本时有时无比无账本更糟）：

```bash
# D9 gate 接入守卫
command -v cw >/dev/null 2>&1 || { echo "ERROR: 未找到 cw CLI（gate wrap 接入依赖）。恢复动作：npm i -g @zhushanwen/coding-workflow 后重试"; exit 1; }
cw --help 2>&1 | grep -q "gate wrap" || { echo "ERROR: cw CLI 无 gate 域（gate wrap 命令缺失——注意 cw 版本号与 gate 域能力不对齐，能力探测是唯一可判真形态）。恢复动作：在仓工作区内 bash .agents/skills/dev-link/use-link.sh 切本地构建，或安装含 gate 域的 npm 版本"; exit 1; }
```

3. 确认其余前置条件：
   - 当前位于 **workspace root 或某 worktree 内**（selfcheck 能定位即可，无需特定起点）
   - feature 分支的 PR 已创建且为 open 状态（`gh pr view <num> --json state`）
   - 已确定版本类型（patch / minor / major）

### 阶段 1: 本地验证

在 feature worktree 内执行全量检查。feature worktree 路径 = `$WS_ROOT/<分支名中的 / 换成 ->`：

```bash
WS_ROOT=$(bash .agents/skills/merge/merge-helpers.sh root)
FEATURE_DIR="${BRANCH_NAME//\//-}"   # 例 feat/foo → feat-foo
cd "$WS_ROOT/$FEATURE_DIR"

cw gate wrap --check typecheck --base origin/main --scope src/ --scope tests/ --scope tsconfig.json --scope tsconfig.test.json --scope package.json --scope package-lock.json -- npm run check:all
cw gate wrap --check lint --base origin/main --scope src/ --scope tests/ --scope eslint.config.mjs --scope taste-lint/ --scope package.json --scope package-lock.json -- npm run lint
cw gate wrap --check test --base origin/main --scope src/ --scope tests/ --scope vitest.config.ts --scope tsconfig.json --scope package.json --scope package-lock.json -- npm test
cw gate wrap --check build --base origin/main --scope src/ --scope tsconfig.json --scope package.json --scope package-lock.json -- npm run build

# D8-canary：lint 无下游 CI 兜底，dogfood 期保留裸跑对照。撤除三条件：连续 3 次对照一致 + 一次完整发布 release.yml 绿 + npm view 新版本在；齐后在 DESIGN-LOG 记档风险接受
npm run lint
```

**[MANDATORY] 零容忍**：任何 wrap exit 0 = pass（含 hit），非 0 必须处置，不允许跳过。四条 wrap 均 exit 0 方可继续。

**wrap 三态恢复指引**：exit 0 = pass（含 hit 缓存命中）；exit 1 = check fail——修复代码后重跑同一命令（fail 永不进缓存，不会被旧 fail 拦路）；exit 2 = 环境错误（不入账，**不是代码问题**）——按 stderr 恢复动作处置：超时则 `--timeout-ms` 调大重试、base ref 解析失败则先 `git fetch`，禁止当 bug 修。

本项目无 `.githooks/pre-commit`，也无 PR 上的 CI（无 `ci.yml`），本地验证是合并前唯一的质量门。

**插件包质量门**：根 check:all / lint / test / build **不含**插件包（vitest include=`tests/**/*.test.ts`、tsconfig include=`src/**`+`tests/**`、lint=`eslint src/ tests/`）。变更涉及插件包时，额外跑插件包的检查（前置：worktree 已在根跑过 npm install，确保 hoist 的 typescript/vitest 可用）：

```bash
cd "$WS_ROOT/$FEATURE_DIR/pi-coding-workflow-extension"
npm run typecheck   # tsc --noEmit
npm test            # vitest run（installer 纯逻辑回归）
```

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

#### 3.2 确定发布范围 + 版本类型

**先判断哪些包需要 bump**（与用户确认）。四分支互斥决策树：

```
if 变更涉及 pi-coding-workflow-extension/ 且不涉及核心包资产:
    → 只 bump 插件包，打 ext-v* tag
elif 变更涉及核心包资产且不涉及 pi-coding-workflow-extension/:
    → 只 bump 核心包，打 v* tag
elif 变更同时涉及两者:
    → 两个包都 bump，两段式推送（先核心后插件，见 §3.4）
else（变更既不触及插件目录也不触及核心包资产——如纯 docs/、README、根 .md 文件）:
    → 按变更主次判断，或询问用户
```

**核心包资产**（不限于 `src/`）：`src/`、`tests/`、根 `package.json`、`tsconfig.json`、`tsconfig.test.json`、`.github/workflows/release.yml`、`vitest.config.ts`、`eslint.config.mjs`。

**然后判断版本类型**。判断标准：

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

**核心包**：
```bash
cd "$(bash .agents/skills/merge/merge-helpers.sh resolve-main)"

CURRENT_VER=$(node -p "require('./package.json').version")
npm version <patch|minor|major> --no-git-tag-version
NEW_VER=$(node -p "require('./package.json').version")
echo "核心包版本: $CURRENT_VER → $NEW_VER"
```

**插件包**（变更涉及插件包时）：
```bash
cd "$(bash .agents/skills/merge/merge-helpers.sh resolve-main)/pi-coding-workflow-extension"

CURRENT_EXT_VER=$(node -p "require('./package.json').version")
npm version <patch|minor|major> --no-git-tag-version
NEW_EXT_VER=$(node -p "require('./package.json').version")
echo "插件包版本: $CURRENT_EXT_VER → $NEW_EXT_VER"
```

两个包的版本独立管理，不联动。**例外**：核心包 major bump 时，需前置检查插件包 `dependencies` 中的 `@zhushanwen/coding-workflow` range 是否断裂，必要时同步更新。

`npm version` 在 workspace 子包内会**自动同步**根 `package-lock.json`（npm 11.6.2 探针实证），无需额外 `npm install`。

#### 3.3.5 CHANGELOG 生成

**[OPTIONAL]** 自动生成变更记录。基于 conventional commits 前缀（feat/fix/chore/docs/refactor/test）提取，追加到 `CHANGELOG.md`。

```bash
# 仍在 main worktree 内
# 核心包 CHANGELOG：只匹配 v* tag（排除 ext-v*）
PREV_TAG=$(git describe --tags --abbrev=0 --match 'v*' HEAD^ 2>/dev/null || echo "")
TAG="v$NEW_VER"

# 插件包 CHANGELOG（变更涉及插件包时）：只匹配 ext-v* tag
# PREV_TAG=$(git describe --tags --abbrev=0 --match 'ext-v*' HEAD^ 2>/dev/null || echo "")
# TAG="ext-v$NEW_EXT_VER"

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

**单包 bump 时**（只 bump 核心包或只 bump 插件包）：

```bash
# 仍在 main worktree 内
git add -A
git commit -m "chore: bump version $CURRENT_VER → $NEW_VER" 2>/dev/null || echo "无变更需提交"
# 核心包：TAG="v$NEW_VER"  插件包：TAG="ext-v$NEW_EXT_VER"
git tag "$TAG" 2>/dev/null || echo "Tag $TAG 已存在"
git push origin HEAD:refs/heads/main "$TAG"  # 只推本次新建的 tag，不用 --tags
```

**双包 bump 时**（两段式推送，确保核心包先发布成功后再推插件包）：

```bash
# 仍在 main worktree 内
# 1. commit（单 commit，包含两个 package.json 的版本变更）
git add -A
git commit -m "chore: bump core $CURRENT_VER → $NEW_VER, ext $CURRENT_EXT_VER → $NEW_EXT_VER"

# 2. 第一段：推核心包 tag
git push origin HEAD:refs/heads/main "v$NEW_VER"

# 3. 等待核心包 CI 发布成功
gh run watch --workflow=release.yml  # 或按 run-id watch

# 4. 验证核心包已发布到 registry
npm view @zhushanwen/coding-workflow@$NEW_CORE_VER version

# 5. 第二段：推插件包 tag
git push origin "ext-v$NEW_EXT_VER"

# 6. 等待插件包 CI 发布成功
gh run watch --workflow=release.yml  # 多 run 并存时用 run-id 更精确
```

**禁止 `git push origin --tags`**：会重推陈旧本地 tag 误触发流水线。改为只推本次新建的显式 tag。

### 阶段 4: 等待 CI 发布完成

**[MANDATORY] npm 发布由 GitHub Actions 自动完成，禁止在本地执行 `npm publish`。**

发布流程：
1. 阶段 3.4 推送 tag → 触发 `.github/workflows/release.yml`
2. CI 核心包 job：`npm ci` → `npm run build` → `npm test` → `npm pack --dry-run` → `npm publish --provenance`
3. CI 插件包 job：`npm install` → `npm test` → `npm pack --dry-run` → `npm publish --provenance`

等待 CI 完成：
```bash
gh run watch --workflow=release.yml
```

⚠️ 双包 bump 时有两段推送，每段触发独立 CI run。用 `gh run list --workflow=release.yml --limit=2` 查看两个 run 的 run-id，分别 watch。

⚠️ release.yml 在发布前会跑 `npm run build` + `npm test`。如果阶段 1 的本地验证已通过，这里通常也会过。但 CI 环境与本地可能有 Node 版本差异（CI 用 node 20），出问题时优先排查 Node 版本兼容性。

### 阶段 4.5: 发布失败回滚

**[MANDATORY] 只在 CI 失败或 npm publish 产物有问题时执行。正常发布流程跳过此阶段。**

**回滚原则：只删 tag，不 reset commit**。双包同 commit 双 tag 时，`git reset --hard HEAD~1` 会 reset 掉含另一包版本变更的共享 commit。接受版本跳号（下次 bump 时 package.json 版本号已就位）。

#### 场景 A: CI 失败但 tag 已推

```bash
cd "$(bash .agents/skills/merge/merge-helpers.sh resolve-main)"

# 核心包失败（第一段）
git push origin --delete v$NEW_VER
git tag -d v$NEW_VER
# 不 reset commit；插件包 tag 尚未推（两段式），本地 ext tag 保留待第二段

# 插件包失败（第二段，核心包已发布成功）
git push origin --delete ext-v$NEW_EXT_VER
git tag -d ext-v$NEW_EXT_VER
# 不 reset commit，核心包版本变更保留

# 两者都失败（第一段就失败，第二段未推）
git push origin --delete v$NEW_VER
git tag -d v$NEW_VER
# commit 保留，下次 bump 时版本号已就位
```

注：回滚后 CHANGELOG 中会留下记录从未发布版本的“幽灵条目”。这是接受的代价——下次正常发布时新条目会自然覆盖，或手动清理。

修复问题后重新走阶段 3.3 ~ 3.4。

#### 场景 B: npm publish 成功但包有问题

```bash
# 核心包
npm unpublish @zhushanwen/coding-workflow@$NEW_VER
git push origin --delete v$NEW_VER
git tag -d v$NEW_VER

# 插件包
npm unpublish @zhushanwen/pi-coding-workflow@$NEW_EXT_VER
git push origin --delete ext-v$NEW_EXT_VER
git tag -d ext-v$NEW_EXT_VER

# 修复后重新走阶段 3.3 ~ 3.4
```

⚠️ `npm unpublish` 有时间窗口限制（72 小时），且会导致该版本号永久不可复用。发现越早操作越安全。超过窗口后只能发布修复版（新 patch），无法撤回已发布版本。

### 阶段 5: 交付物验证

确认 CI 发布成功后验证 npm registry：

```bash
# 核心包
CORE_VER=$(node -p "require('./package.json').version")
npm view @zhushanwen/coding-workflow@$CORE_VER version && \
  echo "  ✅ @zhushanwen/coding-workflow@$CORE_VER" || \
  echo "  ❌ MISSING: @zhushanwen/coding-workflow@$CORE_VER"

# 插件包（变更涉及插件包时）
EXT_VER=$(node -p "require('./pi-coding-workflow-extension/package.json').version")
npm view @zhushanwen/pi-coding-workflow@$EXT_VER version && \
  echo "  ✅ @zhushanwen/pi-coding-workflow@$EXT_VER" || \
  echo "  ❌ MISSING: @zhushanwen/pi-coding-workflow@$EXT_VER"
```

也可通过 GitHub Actions 页面确认：
```bash
gh run list --workflow=release.yml --limit=2
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
4. 恢复指向被删 worktree 的全局 cw devlink：仅当 `$(npm root -g)/@zhushanwen/coding-workflow` symlink 指向本次被删的 worktree 时，`npm unlink -g` 后重装 `npm i -g @zhushanwen/coding-workflow@latest`（切回 npm 正式版即最新版；安装失败中止清理保住现场，不误伤指向其他 worktree 的并行 dev link）
5. 删除 feature worktree 目录 + 本地分支
6. **只同步 main worktree**（`sync-main`：fetch + merge --ff-only origin/main），**不遍历其他 feature worktree**
7. 清理指向被删 worktree 的 cw-cli skill symlink（切回 npm 版或删除）

**与原 remove-worktree 的关键差异**：去掉了"遍历同步所有 feature worktree"的逻辑——那是各分支自己的事，merge 流程不越权。只同步 main，确保本地 main 追上刚合并的远程提交。

参数：

| 参数 | 说明 |
|------|------|
| `<branch-name>` | 要清理的分支名，`/` 自动转 `-` 作为目录名 |
| `--force` | 跳过合并检查 + 未提交检查，强制删除（用 `git worktree remove --force` + `branch -D`） |

冲突处理：`sync-main` 的 ff-only 失败不阻塞清理（main 有独立 commit 的罕见情况），脚本只警告并继续。

### 清理后注意事项 [HISTORICAL]

**清理完成后，当前 agent 会话的 bash 工具会报 `Working directory does not exist: <被删 worktree 路径>`**——这是 worktree 目录被删除的正常结果（agent 会话的 cwd 锁死在启动目录，目录没了所有 bash 调用都会报此错）。

- 看到此报错 = 清理成功信号：**立即停止所有 bash 操作**，不要 `mkdir` 重建目录、不要 `cd` 重试、不要用 write 工具创建锚点文件来恢复 cwd——这些是错误操作，目录删除是清理流程的正常结果，不是故障
- 后续操作改用**绝对路径的 read / edit / write 工具**（不依赖会话 cwd），或在新会话 / 其他 worktree 继续
- 2026-08-08 事故：merge v1.6.0 清理 feat-design-skill worktree 后，主 agent 见 bash 报错反复尝试恢复（mkdir / cd / write .keep 共 4 次），属于无效操作，应以停止收场

## 项目特点

- **双包 monorepo**：根包 `@zhushanwen/coding-workflow` + 插件包 `@zhushanwen/pi-coding-workflow`（仓内目录 `pi-coding-workflow-extension/`），版本独立管理（无 changeset）
- **tag 协议**：`v*` → 核心包；`ext-v*` → 插件包。双包 bump 时两段式推送（先核心后插件）
- **发布方式**：push tag → `release.yml` 自动 `npm publish --provenance`（核心包 job + 插件包 job）
- **禁止本地发布**：`npm publish` 由 CI 执行（需要 `NPM_TOKEN` secret + provenance 签名），本地只做 bump + tag + push
- **无 PR CI**：本项目无 `ci.yml`，PR 不触发 CI。质量门完全依赖阶段 1 的本地验证
- **交付物**：npm registry 包（`@zhushanwen/coding-workflow` + `@zhushanwen/pi-coding-workflow`）
- **插件包发布注意**：scoped 包需 `publishConfig.access = "public"`（已在 package.json 声明）+ NPM_TOKEN 需对该包有写权限

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
| `[HISTORICAL]` | 历史事故教训固化的规则 | 不允许删除或削弱，只能加强 |
| `[设计约束]` | 架构层面的明确边界约定 | 修改需评估对整体设计的影响 |

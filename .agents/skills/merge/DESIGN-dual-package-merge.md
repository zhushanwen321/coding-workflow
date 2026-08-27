# merge skill 双包发版扩展设计（v2）

> 修正版，基于对抗式审查 v1 的 7 must-fix + 7 suggestions。

## 1. 问题

merge skill（`.agents/skills/merge/SKILL.md`）只处理核心包 `@zhushanwen/coding-workflow`
的版本 bump 和 tag push。插件包 `@zhushanwen/pi-coding-workflow`（仓内目录
`pi-coding-workflow-extension/`）的版本管理、tag 协议（`ext-v*`）和发布流程全靠手工操作。

**当前实况**：插件包 0.5.0 处于半发布态——package.json / CHANGELOG / 远程 `ext-v0.5.0`
tag 均已就位，但 npm registry 最新版本仍是 0.4.1（0.5.0 从未成功发布）。远程 `ext-v0.5.0`
tag 触发过 3 次 CI（run 32809161391 / 32808646068 / 32808200571），install/test/pack 全过，
**卡在最后一步 `npm publish` 返回 404**——NPM_TOKEN 对 `@zhushanwen/pi-coding-workflow`
无写权限。

## 2. 现状

| 组件 | 状态 | 备注 |
|------|------|------|
| release.yml | ✅ 双 job 就绪 | `publish-core`（`v*` tag）、`publish-extension`（`ext-v*` tag）；含 `workflow_dispatch` dry-run |
| 插件包 package.json | ✅ name=`@zhushanwen/pi-coding-workflow`, version=`0.5.0` | |
| 插件包 CHANGELOG.md | ✅ 已有 0.5.0 记录 | 可作后续 CHANGELOG 生成的 base |
| merge skill | ❌ 只处理核心包 | 无插件包版本管理能力 |
| merge-helpers.sh | ✅ 无需改 | 四子命令（selfcheck/root/resolve-main/sync-main）均为路径/worktree 逻辑，与包数无关 |
| 远程 ext-v0.5.0 tag | ⚠️ 存在但 CI 失败 | 3 次 tag 触发全败于 npm publish 404（缺少 repository 字段，--provenance 无法验证来源），0.5.0 从未上 registry |
| **前置条件** | ❌ **已定位根因** | 插件包 package.json 缺少 `repository` 字段，`--provenance` 发布失败。已修复（加 repository 字段）。|

## 3. 设计方案

### 3.1 变更检测（哪个包需要 bump？）

**原则**：不搞自动检测，由 agent 或用户显式指定。

理由：
- git diff 文件路径 → 包归属的映射不精确（共享文件如 AGENTS.md、根 package.json）
- 语义层面的"是否需要 bump"无法从文件变更自动推断（一个 typo fix 也改 src/，不需要 minor）
- 现有 merge flow 已经要求 agent 与用户确认版本类型，扩展到双包只是多问一句

**实现**：merge SKILL.md 阶段 3.2 增加判断逻辑（四分支互斥）：

```
if 变更涉及 pi-coding-workflow-extension/ 且不涉及核心包资产:
    → 只 bump 插件包，打 ext-v* tag
elif 变更涉及核心包资产且不涉及 pi-coding-workflow-extension/:
    → 只 bump 核心包，打 v* tag
elif 变更同时涉及两者:
    → 两个包都 bump，先核心后插件（两段式推送，见 §3.5）
else（变更既不触及插件目录也不触及核心包资产——如纯 docs/、README、根 .md 文件）:
    → 按变更主次判断，或询问用户
```

**边界声明**：核心包资产不限于 `src/`，还包括：
- `tests/`（根级测试，SKILL.md 明确"测试补充→patch"）
- 根 `package.json`、`tsconfig.json`、`tsconfig.test.json`
- `.github/workflows/release.yml`（发布行为本身）
- `vitest.config.ts`、`eslint.config.mjs`

### 3.2 版本 bump 机制

**核心包**（不变）：
```bash
cd "$(bash merge-helpers.sh resolve-main)"
npm version <patch|minor|major> --no-git-tag-version
```

**插件包**（新增）：
```bash
cd "$(bash merge-helpers.sh resolve-main)/pi-coding-workflow-extension"
npm version <patch|minor|major> --no-git-tag-version
```

**npm version × workspace lock 行为**（探针实证，npm 11.6.2）：`npm version` 在 workspace
子包内会**自动同步**根 `package-lock.json`（`packages["<子包>"].version` 字段同步更新），
随后根 `npm ci` exit=0。无需额外 `npm install` 同步。

**与全局 AGENTS.md「禁止 npm version」规则的冲突说明**：
全局规则的原始理由是“npm version 会同步改写 package-lock.json”。在本项目 workspace 场景下，
lock 改写恰为**期望行为**（子包/根包版本变更后 lock 应同步），因此本仓 workspace 内
（根包与成员包）的 `--no-git-tag-version` 用法下 `npm version` 可用。
该例外仅限本仓 workspace 内的 `--no-git-tag-version` 用法，不推广到其他项目。

两个包的版本独立管理，不联动。**例外**：核心包 major bump 时，需前置检查插件包
`dependencies` 中的 `@zhushanwen/coding-workflow: "^2.2.0"` range 是否断裂，
必要时同步更新。

### 3.3 tag 协议

| 包 | tag 格式 | 示例 |
|----|---------|------|
| 核心包 | `v<version>` | `v2.2.1` |
| 插件包 | `ext-v<version>` | `ext-v0.5.1` |

双包都 bump 时：两个 tag 指向同一 commit（一次 commit 包含两个 package.json
的版本变更）。

### 3.4 CHANGELOG

每个包维护自己的 CHANGELOG.md：
- 核心包：根目录 `CHANGELOG.md`
- 插件包：`pi-coding-workflow-extension/CHANGELOG.md`

**CHANGELOG 生成脚本必须按包加 `--match` 过滤**（探针证实：不带 `--match` 时
`git describe --tags --abbrev=0` 在双 tag 交错后会返回 `ext-v*` 作 base，range 必错）：

```bash
# 核心包 CHANGELOG
PREV_TAG=$(git describe --tags --abbrev=0 --match 'v*' HEAD^ 2>/dev/null || echo "")
TAG="v$NEW_VER"

# 插件包 CHANGELOG
PREV_TAG=$(git describe --tags --abbrev=0 --match 'ext-v*' HEAD^ 2>/dev/null || echo "")
TAG="ext-v$NEW_VER"
```

**首 tag 空 RANGE 处理**：首个 `ext-v*` tag 时 HEAD^ 无可达 ext tag → PREV_TAG 空 → RANGE=HEAD。
解决：利用已有 CHANGELOG.md 中的 0.5.0 记录作为 base，或显式指定 RANGE 为从首个 commit 到 HEAD。

**简化决策**：两个 CHANGELOG 都记录全量 commits（不过滤路径）。理由：monorepo 早期阶段，
变更量不大，全量记录更完整；路径过滤增加复杂度，收益低。后期变更量大了再加路径过滤。

### 3.5 commit + tag + push 流程（两段式）

**问题**：双 tag 一次 `git push --tags` 推出 → GitHub 为每个 tag 起独立 workflow run，
两 job 并发，"先核心后插件"的意图无机制保证。且 publish-extension 的 `npm install`
从 registry 解析 `^2.2.0` 核心包，与 publish-core 的 `npm publish` 存在 registry
可见性竞态。

**方案**：两段式推送，确保核心包先发布成功后再推插件包 tag。

```
# 在 main worktree 内

# 1. commit（单 commit，包含两个 package.json 的版本变更）
git add -A
git commit -m "chore: bump core $OLD_CORE_VER → $NEW_CORE_VER, ext $OLD_EXT_VER → $NEW_EXT_VER"

# 2. 第一段：推核心包 tag
git push origin HEAD:refs/heads/main
git push origin v$NEW_CORE_VER

# 3. 等待核心包 CI 发布成功
gh run watch --workflow=release.yml  # 或按 run-id watch

# 4. 验证核心包已发布到 registry
npm view @zhushanwen/coding-workflow@$NEW_CORE_VER version

# 5. 第二段：推插件包 tag
git push origin ext-v$NEW_EXT_VER

# 6. 等待插件包 CI 发布成功
gh run watch --workflow=release.yml  # 注意：多 run 并存时用 run-id 更精确
```

**单包 bump 时**：直接推对应 tag，无需两段式。

**commit 策略**：双包 bump 时合并为单 commit（atomic，与双 tag 同 commit 的设计自洽）。
单包 bump 时也是单 commit。

**`--tags` 问题**：禁止 `git push origin --tags`（会重推陈旧本地 tag 误触发流水线）。
改为只推本次新建的显式 tag（如上所示）。

### 3.6 回滚

**共享 commit 问题**：双包同 commit 双 tag 时，`git reset --hard HEAD~1` 会 reset 掉
含另一包版本变更的共享 commit。

**处置方案**：只删 tag，不 reset commit。接受版本跳号（下次 bump 时 package.json
版本号已就位，跳号不影响功能）。

#### 场景 A: CI 失败但 tag 已推

```bash
# 核心包失败（第一段）
git push origin --delete v$NEW_CORE_VER
git tag -d v$NEW_CORE_VER
# 不 reset commit；插件包 tag 尚未推（两段式），本地 ext tag 保留待第二段

# 插件包失败（第二段，核心包已发布成功）
git push origin --delete ext-v$NEW_EXT_VER
git tag -d ext-v$NEW_EXT_VER
# 不 reset commit，核心包版本变更保留

# 两者都失败（第一段就失败，第二段未推）
git push origin --delete v$NEW_CORE_VER
git tag -d v$NEW_CORE_VER
# commit 保留，下次 bump 时版本号已就位
```

注：回滚后 CHANGELOG 中会留下记录从未发布版本的“幽灵条目”。这是接受的代价——
下次正常发布时新条目会自然覆盖，或手动清理。

#### 场景 B: npm publish 成功但包有问题

```bash
# 核心包
npm unpublish @zhushanwen/coding-workflow@$NEW_CORE_VER
git push origin --delete v$NEW_CORE_VER
git tag -d v$NEW_CORE_VER

# 插件包
npm unpublish @zhushanwen/pi-coding-workflow@$NEW_EXT_VER
git push origin --delete ext-v$NEW_EXT_VER
git tag -d ext-v$NEW_EXT_VER
```

⚠️ `npm unpublish` 有 72 小时窗口限制。发现越早操作越安全。超过窗口后只能发布修复版。

### 3.7 SKILL.md 改动范围

| 阶段 | 改动 |
|------|------|
| 阶段 0 | 不变 |
| 阶段 1 | **扩展**：变更涉及插件包时，额外跑插件包的 typecheck + test（见下） |
| 阶段 2 | 不变（PR 合并与包数无关） |
| 阶段 3.2 | 新增：判断哪些包需要 bump（四分支互斥） |
| 阶段 3.3 | 扩展：支持插件包 `npm version` |
| 阶段 3.3.5 | 扩展：双 CHANGELOG 生成（带 `--match` 过滤） |
| 阶段 3.4 | 扩展：两段式推送（先核心后插件） |
| 阶段 4 | 扩展：按 run-id 分别 watch 双 run |
| 阶段 4.5 | 扩展：只删 tag 不 reset、双包 unpublish |
| 阶段 5 | 扩展：验证两个包都发布成功 |
| 阶段 6 | 不变 |

merge-helpers.sh 和 cleanup-worktree.sh **不需要改**（与包数无关）。

**阶段 1 扩展细节**（修正"已覆盖全量"事实错误）：

根 check:all / lint / test / build **不含**插件包（read vitest.config/tsconfig/scripts
证实）。插件包有独立的 `typecheck` 和 `test` script。变更涉及插件包时，阶段 1 增加（前置：worktree 已在根跑过 npm install，确保 hoist 的
typescript/vitest 可用）：

```bash
cd "$WS_ROOT/$FEATURE_DIR/pi-coding-workflow-extension"
npm run typecheck   # tsc --noEmit
npm test            # vitest run（installer 纯逻辑回归）
```

### 3.8 Alternatives（考虑过但没选）

| 方案 | 描述 | 否决理由 |
|------|------|---------|
| 单 push 双 tag | `git push --tags` 一次推两个 tag | 两 job 并发，核心→插件顺序无保证，registry 竞态 |
| 仅 workflow_dispatch | 不用 tag 触发，全靠手动 dispatch | 失去自动化能力，tag 是 release.yml 的原生触发方式 |
| 自动检测变更路径 | git diff 文件路径自动判断哪个包需要 bump | 路径→包归属映射不精确，语义判断无法自动化 |
| 双 commit | 核心包和插件包各一个 commit | 与双 tag 同 commit 的设计不自洽，增加复杂度 |

## 4. 验收

### 前置条件（已解决）

3 次 CI 全败于 `npm publish 404`。根因：插件包 package.json 缺少 `repository` 字段，
`--provenance` 无法验证来源（对比 xyz-agent 用 `changeset publish` 不带 provenance，
无此要求）。已修复：在 `pi-coding-workflow-extension/package.json` 添加 `repository` 字段。

### 处置当前半发布态

远程已有 `ext-v0.5.0` tag 且指向正确 commit。有两个选项：
- **选项 A（推荐）**：不删 tag，直接 `workflow_dispatch` 触发 `package=extension` 补发
  0.5.0（dispatch 不重新检查 tag，按 package.json 版本 publish）
- **选项 B**：删远程 `ext-v0.5.0` tag → bump 到 0.5.1 → 按正常流程推新 tag

### A1: workflow_dispatch dry-run 走通 ext 发布链路

```bash
gh workflow run release.yml -f package=extension -f dry-run=true
gh run watch --workflow=release.yml
```

release.yml 的 publish 条件：`github.event_name != 'workflow_dispatch' || !inputs.dry-run`
——dispatch + dry-run=true 时跳过 publish，只跑 install/test/pack。

预期：CI 的 publish-extension job 启动、npm install 成功、vitest 通过、npm pack --dry-run
输出不含核心包文件。

⚠️ **禁止用 tag push 做 dry-run 演练**：tag 触发时 publish 恒运行（dry-run 输入对 tag 路径
无效），且 0.5.0 不在 registry——权限修复后该"演练"会真的发布 0.5.0。

### A2: 双 tag 顺序验证

验证两段式推送下核心包先发布、插件包后发布：

```bash
# 1. 推核心包 tag
git push origin v$NEW_CORE_VER
# 2. 等核心包 CI 完成
gh run watch --workflow=release.yml
# 3. 验证 registry
npm view @zhushanwen/coding-workflow@$NEW_CORE_VER version
# 4. 再推插件包 tag
git push origin ext-v$NEW_EXT_VER
```

### A3: 单包回滚演练（tag 增删隔离）

验证删除一个 tag 不影响另一个。**必须用不命中 `v*`/`ext-v*` glob 的 tag 名**，
避免触发 CI 发布流水线：

```bash
# 用 drill/ 前缀（不命中 release.yml 的 on.push.tags glob）
git tag drill/v-rollback-test && git tag drill/ext-v-rollback-test
git push origin drill/v-rollback-test drill/ext-v-rollback-test
# 删插件包 drill tag
git push origin --delete drill/ext-v-rollback-test
git tag -d drill/ext-v-rollback-test
# 验证核心包 drill tag 仍在
git ls-remote --tags origin drill/v-rollback-test
# 清理
git push origin --delete drill/v-rollback-test
git tag -d drill/v-rollback-test
```

⚠️ **禁止用 `v-test-*` / `ext-v-test-*` 类 tag 名做演练**：它们命中 `v*`/`ext-v*` glob，
会真实触发两条发布流水线（tag 触发 publish 恒运行）。特定时序下可致意外真实发布。

### A4: 插件包本地质量门

验证阶段 1 扩展后的插件包检查：

```bash
cd pi-coding-workflow-extension
npm run typecheck && npm test
```

## 5. 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| agent 忘记 bump 插件包 | 插件包版本停滞 | 比较上次 `ext-v*` tag 以来是否有触及 `pi-coding-workflow-extension/` 路径的 commits（非"未提交变更"检测） |
| ext-v tag 打错版本 | CI 发布错误版本 | push 前断言 `test "ext-v$(node -p "require('./pi-coding-workflow-extension/package.json').version")" = "$TAG"` |
| 核心包 major bump 断裂插件包 range | 插件包用户解析不到新核心 | 核心 major 前置检查插件包 dependencies range 并同步更新 |
| 两段式推送中间 CI 失败 | 状态不一致（核心已发、插件未发） | 回滚已推 tag + 修复后重推（见 §3.6） |
| 双 run 并发时 gh run watch 只盯一个 | 漏掉另一个 run 的结果 | 按 run-id 分别 watch 或 `gh run list` 轮询双 run |
| --provenance 要求 repository 字段 | 缺失时 publish 404（已发生 3 次） | 已在插件包 package.json 添加 repository 字段 |

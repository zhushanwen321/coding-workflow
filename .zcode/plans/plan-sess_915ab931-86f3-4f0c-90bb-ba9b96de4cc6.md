# dev-link 项目级 Skill 方案

## 目标

在本项目 `.agents/skills/dev-link/` 放一个项目级 skill，内含两个脚本，一键切换 cw 的本地 symlink 安装与 npm 正式版安装。

## 当前安装状态（脚本设计依据）

```
cw → ~/.nvm/.../bin/cw → .../lib/node_modules/@zhushanwen/coding-workflow/dist/cli.js
                                                    ↑
                                           当前是 symlink → 本项目目录
                                           （npm link 的结果）
```

- 包名：`@zhushanwen/coding-workflow`
- npm 正式版：`0.0.1`（已发布）
- 本地项目路径：`<repo>/dist/cli.js`（需先 `npm run build`）

## 改动清单（3 个新文件）

### 1. `.agents/skills/dev-link/SKILL.md`

frontmatter + 使用说明。告诉 agent 这个 skill 的两个脚本何时用、怎么调。

```markdown
---
name: dev-link
description: >-
  Use when the user says "切换到 npm 正式版", "切换到本地开发版",
  "卸载 link 装正式版", "卸载正式版装 link", "dev-link", or wants to
  toggle the `cw` command between the published npm package and the local
  development symlink. Provides two scripts: use-npm.sh (uninstall local link,
  install published npm version) and use-link.sh (uninstall npm version,
  install local symlink for development).
---

# dev-link（cw 安装切换器）

切换 `cw` 命令在两种安装之间：

| 模式 | `cw` 指向 | 用途 |
|------|----------|------|
| npm 正式版 | npm registry 的发布包 | 测试发布版本、验证用户实际体验 |
| 本地 link | 本项目 `dist/cli.js` | 开发调试，改完即生效 |

## 两个脚本

### `use-npm.sh` — 切换到 npm 正式版

卸载本地 symlink，安装 npm 正式版。

```bash
bash .agents/skills/dev-link/use-npm.sh           # 默认 latest
bash .agents/skills/dev-link/use-npm.sh 0.0.1     # 指定版本
```

### `use-link.sh` — 切换到本地开发版

卸载 npm 正式版，`npm link` 本地项目（会先 `npm run build`）。

```bash
bash .agents/skills/dev-link/use-link.sh
```

切换后脚本会打印当前 `cw` 的指向，确认结果。
```

### 2. `.agents/skills/dev-link/use-npm.sh` — 切换到 npm 正式版

```bash
#!/usr/bin/env bash
# 切换 cw 到 npm 正式版：卸载本地 link，安装发布版
set -euo pipefail

PKG="@zhushanwen/coding-workflow"
VERSION="${1:-latest}"

echo "→ 卸载本地 link（如存在）..."
npm unlink -g "$PKG" 2>/dev/null || true

echo "→ 安装 npm 正式版 ${VERSION}..."
npm install -g "${PKG}@${VERSION}"

echo ""
echo "✓ 已切换到 npm 正式版。当前 cw 指向："
cw --version 2>/dev/null && which cw
```

**设计要点**：
- `set -euo pipefail` — 任何步骤失败立即停止
- `npm unlink -g ... || true` — 即使没安装 link 也不报错（幂等）
- 接受可选版本参数，默认 `latest`
- 最后打印 `cw --version` + `which cw` 确认结果

### 3. `.agents/skills/dev-link/use-link.sh` — 切换到本地开发版

```bash
#!/usr/bin/env bash
# 切换 cw 到本地开发版：卸载 npm 正式版，build + link 本地
set -euo pipefail

PKG="@zhushanwen/coding-workflow"
# 脚本所在仓库根目录（.agents/skills/dev-link/ 往上三级）
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

echo "→ 卸载 npm 正式版（如存在）..."
npm uninstall -g "$PKG" 2>/dev/null || true

echo "→ 构建本地 dist/..."
cd "$REPO_ROOT"
npm run build

echo "→ link 本地项目..."
npm link

echo ""
echo "✓ 已切换到本地 link。当前 cw 指向："
cw --version 2>/dev/null && which cw
```

**设计要点**：
- `REPO_ROOT` 用 `BASH_SOURCE` 相对定位，不依赖 cwd——从任何目录调都正确（对应全局规则「不假设 cwd」）
- `npm run build` 在 link 前——确保 `dist/cli.js` 是最新的
- `npm uninstall -g ... || true` — 幂等，即使装的是 npm 版也能干净切换

## 验证

1. `chmod +x` 两个脚本
2. `bash use-npm.sh` → `cw` 指向 npm 包，`npm ls -g` 显示真实版本而非 link
3. `bash use-link.sh` → `cw` 指向本地 `dist/cli.js`，`npm ls -g` 显示 `->` link
4. 两个脚本各自重复跑一次 → 幂等，不报错

## 不做的事

- **不改 package.json** — `.agents/` 不在 `files` 里，不进 npm 包，无需改动
- **不放进 skill/**（随包发布的目录）— 按你的要求放 `.agents/skills/`
- **不做版本号读取/自动 bump** — use-npm.sh 接受参数，用户自己控制
- **不提交 .agents/ 到 .gitignore** — 这是项目级 skill，应该跟仓库走，让其他开发者也能用

## 长期/短期性质

**长期方案**：`.agents/skills/` 是项目级 skill 的标准位置（与全局 `~/.agents/skills/` 对应），脚本用 `BASH_SOURCE` 定位根目录可移植。无技术债。
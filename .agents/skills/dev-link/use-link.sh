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

echo "→ 安装 skill 到 ~/.agents/skills/ 和 ~/.claude/skills/..."
bash "$REPO_ROOT/scripts/install-skill.sh"

echo ""
echo "✓ 已切换到本地 link。当前 cw 指向："
which cw
ls -la "$(which cw)"

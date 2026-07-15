#!/usr/bin/env bash
# install-skill.sh — 把 cw-cli skill 安装到 ~/.agents/skills/ 和 ~/.claude/skills/
#
# 触发场景：
#   1. npm install -g @zhushanwen/coding-workflow（postinstall 自动调用）
#   2. npm link（use-link.sh 调用）
#   3. 手动 bash scripts/install-skill.sh
#
# 安装方式：symlink（不是 copy）——指向 npm 包内的 skill/cw-cli 目录，
# npm update 后 skill 自动更新，不需要重跑此脚本。
set -euo pipefail

SKILL_NAME="cw-cli"

# 找到 skill 源目录（脚本所在仓库的 skill/cw-cli），resolve 到绝对路径无 /../
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$(cd "$SCRIPT_DIR/../skill/$SKILL_NAME" && pwd)"

if [ ! -f "$SKILL_SRC/SKILL.md" ]; then
  echo "⚠️  skill 源文件不存在: $SKILL_SRC/SKILL.md，跳过 skill 安装"
  exit 0
fi

# 目标目录（与全局 AGENTS.md 的 skill 安装规范一致）
TARGETS=(
  "$HOME/.agents/skills/$SKILL_NAME"
  "$HOME/.claude/skills/$SKILL_NAME"
)

for target in "${TARGETS[@]}"; do
  mkdir -p "$(dirname "$target")"

  # 已存在（symlink 或目录）→ 检查是否指向同一源
  if [ -e "$target" ] || [ -L "$target" ]; then
    current=""
    if [ -L "$target" ]; then
      current="$(readlink "$target")"
    fi
    if [ "$current" = "$SKILL_SRC" ]; then
      echo "✓ $target 已指向正确源，跳过"
      continue
    fi
    # 指向不同源或不是 symlink → 备份后重建
    echo "→ $target 已存在但指向不同位置，备份为 ${target}.bak"
    mv "$target" "${target}.bak" 2>/dev/null || true
  fi

  ln -s "$SKILL_SRC" "$target"
  echo "✓ $target → $SKILL_SRC"
done

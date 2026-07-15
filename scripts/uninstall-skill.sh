#!/usr/bin/env bash
# uninstall-skill.sh — 清理 cw-cli skill 的 symlink
#
# 触发场景：
#   1. npm uninstall -g @zhushanwen/coding-workflow（preuninstall 自动调用）
#   2. 手动 bash scripts/uninstall-skill.sh
#
# 只删 symlink，不删 .bak 备份（用户手动恢复用）。
set -euo pipefail

SKILL_NAME="cw-cli"

TARGETS=(
  "$HOME/.agents/skills/$SKILL_NAME"
  "$HOME/.claude/skills/$SKILL_NAME"
)

for target in "${TARGETS[@]}"; do
  if [ -L "$target" ]; then
    rm -f "$target"
    echo "✓ 已删除 symlink: $target"
  elif [ -e "$target" ]; then
    # 实体目录/文件（非 symlink）——不自动删（可能是用户的自定义 skill）
    echo "⚠️  $target 不是 symlink（可能是用户手动创建），跳过删除"
  fi
done

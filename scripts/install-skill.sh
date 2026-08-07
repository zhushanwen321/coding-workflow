#!/usr/bin/env bash
# install-skill.sh — 把 cw-cli skill 安装到 ~/.agents/skills/ 和 ~/.claude/skills/
#
# 触发场景：
#   1. npm install -g @zhushanwen/coding-workflow（postinstall 自动调用）
#   2. npm link（use-link.sh 调用）
#   3. 手动 bash scripts/install-skill.sh
#
# 安装方式：symlink（不是 copy）——指向 npm 包内的 skill/<name> 目录，
# npm update 后 skill 自动更新，不需要重跑此脚本。
set -euo pipefail

# 要安装的 skill 列表
SKILL_NAMES=("cw-cli")

# 找到 skill 源目录（脚本所在仓库的 skill/），resolve 到绝对路径无 /../
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/../skill" && pwd)"

# 目标目录（与全局 AGENTS.md 的 skill 安装规范一致）
TARGET_BASES=(
  "$HOME/.agents/skills"
  "$HOME/.claude/skills"
)

for SKILL_NAME in "${SKILL_NAMES[@]}"; do
  SKILL_SRC="$SKILL_ROOT/$SKILL_NAME"

  if [ ! -f "$SKILL_SRC/SKILL.md" ]; then
    echo "⚠️  skill 源文件不存在: $SKILL_SRC/SKILL.md，跳过 $SKILL_NAME"
    continue
  fi

  for base in "${TARGET_BASES[@]}"; do
    target="$base/$SKILL_NAME"
    mkdir -p "$base"

    # 无条件重建：无论悬空、指向别处、指向正确源，统一 rm -rf + ln -s
    rm -rf "$target"
    ln -s "$SKILL_SRC" "$target"
    echo "✓ $target → $SKILL_SRC"
  done
done

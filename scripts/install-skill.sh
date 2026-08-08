#!/usr/bin/env bash
# install-skill.sh — 把本包的 skills 和 agents 安装为 symlink
#
# 触发场景：
#   1. npm install -g @zhushanwen/coding-workflow（postinstall 自动调用）
#   2. npm link（use-link.sh 调用）
#   3. 手动 bash scripts/install-skill.sh
#
# 安装方式：symlink（非 copy）——指向 npm 包内的源目录，
# npm update 后自动更新，不需要重跑此脚本。
#
# 分发两类资产（目录扫描，新增 skill/agent 无需改本脚本）：
#   - skills：skills/<name>/（含 SKILL.md）→ ~/.agents/skills + ~/.claude/skills
#   - agents：
#       随 skill 自包含：skills/<name>/agents/*.md
#       独立（不属于任何 skill）：agents/*.md
#       → ~/.agents/agents + ~/.pi/agent/agents + ~/.claude/agents
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC_ROOT="$(cd "$SCRIPT_DIR/../skills" && pwd)"
AGENT_SRC_ROOT="$(cd "$SCRIPT_DIR/../agents" && pwd)"

# 目标目录（与全局 AGENTS.md 的 skill/agent 安装规范一致）
SKILL_TARGETS=(
  "$HOME/.agents/skills"
  "$HOME/.claude/skills"
)
# agent 需覆盖 pi 实读位置（~/.pi/agent/agents）+ 跨 harness 通用（~/.agents/agents）+ claude
AGENT_TARGETS=(
  "$HOME/.agents/agents"
  "$HOME/.pi/agent/agents"
  "$HOME/.claude/agents"
)

# agent 文件以 YAML frontmatter（---）开头；跳过 README 等说明文档
is_agent_file() {
  [ -f "$1" ] && [ "$(head -1 "$1")" = "---" ]
}

# 无条件重建 symlink（rm -rf + ln -s）
install_link() {
  local src="$1" target="$2"
  mkdir -p "$(dirname "$target")"
  rm -rf "$target"
  ln -s "$src" "$target"
  echo "✓ $target → $src"
}

# ── 分发 skills（含随 skill 自包含的 agents）──
if [ -d "$SKILL_SRC_ROOT" ]; then
  for skill_dir in "$SKILL_SRC_ROOT"/*/; do
    skill_dir="${skill_dir%/}"
    [ -f "$skill_dir/SKILL.md" ] || continue
    skill_name="$(basename "$skill_dir")"

    # skill 本体
    for base in "${SKILL_TARGETS[@]}"; do
      install_link "$skill_dir" "$base/$skill_name"
    done

    # 随 skill 自包含的 agents
    if [ -d "$skill_dir/agents" ]; then
      for agent_file in "$skill_dir"/agents/*.md; do
        is_agent_file "$agent_file" || continue
        agent_name="$(basename "$agent_file" .md)"
        for base in "${AGENT_TARGETS[@]}"; do
          install_link "$agent_file" "$base/$agent_name"
        done
      done
    fi
  done
fi

# ── 分发独立 agents（顶层 agents/*.md，不属于任何 skill）──
if [ -d "$AGENT_SRC_ROOT" ]; then
  for agent_file in "$AGENT_SRC_ROOT"/*.md; do
    is_agent_file "$agent_file" || continue
    agent_name="$(basename "$agent_file" .md)"
    for base in "${AGENT_TARGETS[@]}"; do
      install_link "$agent_file" "$base/$agent_name"
    done
  done
fi

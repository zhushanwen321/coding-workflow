#!/usr/bin/env bash
# uninstall-skill.sh — 清理本包分发的 skills 和 agents 的 symlink
#
# 触发场景：
#   1. npm uninstall -g @zhushanwen/coding-workflow（preuninstall 自动调用）
#   2. 手动 bash scripts/uninstall-skill.sh
#
# 基于源目录扫描，只删本包分发的 symlink。实体目录/文件不自动删（可能是用户自定义资产）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC_ROOT="$(cd "$SCRIPT_DIR/../skills" && pwd)"
AGENT_SRC_ROOT="$(cd "$SCRIPT_DIR/../agents" && pwd)"

SKILL_TARGETS=(
  "$HOME/.agents/skills"
  "$HOME/.claude/skills"
)
AGENT_TARGETS=(
  "$HOME/.agents/agents"
  "$HOME/.pi/agent/agents"
  "$HOME/.claude/agents"
)

# agent 文件以 YAML frontmatter（---）开头；跳过 README 等说明文档
is_agent_file() {
  [ -f "$1" ] && [ "$(head -1 "$1")" = "---" ]
}

# 跳过非 agent 文件：真实文件跳过时打 warning（避免静默），
# 未匹配的 glob 字面量（目录为空）不是真实文件，不打 warning
skip_non_agent_file() {
  local f="$1"
  if is_agent_file "$f"; then
    return 1
  fi
  [ -f "$f" ] && echo "warning: skip non-agent file: $f" >&2
  return 0
}

# 只删 symlink，实体跳过（保留用户手动创建的资产）
remove_link() {
  local target="$1"
  if [ -L "$target" ]; then
    rm -f "$target"
    echo "✓ 已删除 symlink: $target"
  elif [ -e "$target" ]; then
    echo "⚠️  $target 不是 symlink（可能是用户手动创建），跳过删除"
  fi
}

# ── 清理 skills + 随 skill 的 agents ──
if [ -d "$SKILL_SRC_ROOT" ]; then
  for skill_dir in "$SKILL_SRC_ROOT"/*/; do
    skill_dir="${skill_dir%/}"
    [ -f "$skill_dir/SKILL.md" ] || continue
    skill_name="$(basename "$skill_dir")"
    for base in "${SKILL_TARGETS[@]}"; do
      remove_link "$base/$skill_name"
    done
    if [ -d "$skill_dir/agents" ]; then
      for agent_file in "$skill_dir"/agents/*.md; do
        skip_non_agent_file "$agent_file" && continue
        agent_name="$(basename "$agent_file" .md)"
        for base in "${AGENT_TARGETS[@]}"; do
          # 与 install-skill.sh 对称：安装目标是带 .md 后缀的 symlink
          remove_link "$base/$agent_name.md"
        done
      done
    fi
  done
fi

# ── 清理独立 agents ──
if [ -d "$AGENT_SRC_ROOT" ]; then
  for agent_file in "$AGENT_SRC_ROOT"/*.md; do
    skip_non_agent_file "$agent_file" && continue
    agent_name="$(basename "$agent_file" .md)"
    for base in "${AGENT_TARGETS[@]}"; do
      # 与 install-skill.sh 对称：安装目标是带 .md 后缀的 symlink
      remove_link "$base/$agent_name.md"
    done
  done
fi

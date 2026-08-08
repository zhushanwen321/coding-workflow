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

# 重建 symlink：只覆盖「本包安装的 symlink」（悬空，或指向本次安装的源文件），
# 保护非 symlink 用户资产，以及指向别处的 symlink（含跨 skill 同名 agent 冲突：
# 目标是另一 skill 的同名 agent 文件时不静默覆盖，warning + 跳过）
install_link() {
  local src="$1" target="$2" link_dest
  mkdir -p "$(dirname "$target")"
  if [ -L "$target" ]; then
    link_dest="$(readlink "$target")"
    # 悬空 symlink（readlink 存在但目标不存在）或指向本包源文件 → 重建；
    # -ef 按 inode 判定同一文件，天然兼容旧脚本带 .. 的未规范化目标路径
    if [ -e "$target" ] && [ ! "$target" -ef "$src" ]; then
      echo "warning: skip symlink pointing elsewhere: $target → $link_dest" >&2
      return 0
    fi
  elif [ -e "$target" ]; then
    echo "⚠️  $target 不是 symlink（可能是用户手动创建），跳过"
    return 0
  fi
  rm -f "$target"
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
        skip_non_agent_file "$agent_file" && continue
        agent_name="$(basename "$agent_file" .md)"
        for base in "${AGENT_TARGETS[@]}"; do
          # pi 的 agent 发现要求文件名以 .md 结尾，目标必须保留后缀
          install_link "$agent_file" "$base/$agent_name.md"
        done
      done
    fi
  done
fi

# ── 分发独立 agents（顶层 agents/*.md，不属于任何 skill）──
if [ -d "$AGENT_SRC_ROOT" ]; then
  for agent_file in "$AGENT_SRC_ROOT"/*.md; do
    skip_non_agent_file "$agent_file" && continue
    agent_name="$(basename "$agent_file" .md)"
    for base in "${AGENT_TARGETS[@]}"; do
      # pi 的 agent 发现要求文件名以 .md 结尾，目标必须保留后缀
      install_link "$agent_file" "$base/$agent_name.md"
    done
  done
fi

#!/usr/bin/env bash
# 切换 cw 到 npm 正式版：卸载本地 link，安装发布版，
# 并把 dev link 时代残留的本包 skill/agent symlink 重建为 npm 包指向。
#
# 为什么需要重建：npm 全局卸载/重装从不执行 preuninstall 钩子（npm 11 实测），
# install-skill.sh 装的 symlink 不会被自动清理；use-link.sh 装的 symlink 指向
# 本地 repo，本地 worktree 清理后悬空、skill 静默消失。此处在 npm install
# 成功后，把本包受管路径上的残留 symlink 收敛到 npm 指向。
set -euo pipefail

PKG="@zhushanwen/coding-workflow"
VERSION="${1:-latest}"

echo "→ 卸载本地 link（如存在）..."
npm unlink -g "$PKG" 2>/dev/null || true

echo "→ 安装 npm 正式版 ${VERSION}..."
npm install -g "${PKG}@${VERSION}"

NPM_PKG_DIR="$(cd "$(npm root -g)/$PKG" 2>/dev/null && pwd -P)" || true

# ── dev link 残留 symlink 重建 ──
# 目标路径与 install-skill.sh 完全一致（本包受管路径），skill/agent 清单从
# npm 包内动态枚举，不硬编码名单。处置规则：
#   - 已指向 npm 包          → 保持不动
#   - 悬空 symlink           → 重建为 npm 指向（本地 worktree 已清理的化石）
#   - 指向本包其他 checkout  → 重建（判据：目标所属 package.json name == 本包名，
#                              覆盖任意 worktree 的 dev link 残留）
#   - 其他有效 link / 实体   → 用户自有资产，不覆盖，warning 出声
SKILL_TARGETS=(
  "$HOME/.agents/skills"
  "$HOME/.claude/skills"
)
AGENT_TARGETS=(
  "$HOME/.agents/agents"
  "$HOME/.pi/agent/agents"
  "$HOME/.claude/agents"
)

# symlink 第一跳目标规范化为绝对路径（本包安装均为绝对路径，相对形态防御性展开）
abs_link_dest() {
  local dest
  dest="$(readlink "$1")" || return 1
  case "$dest" in
    /*) ;;
    *) dest="$(dirname "$1")/$dest" ;;
  esac
  printf '%s' "$dest"
}

# 单个 package.json 的 name 字段；解析失败输出空串
pkg_name() {
  node -e 'try{const p=require(process.argv[1]);if(p&&typeof p.name==="string")process.stdout.write(p.name)}catch{}' "$1"
}

# 路径所属包的 checkout 根：向上找最近 package.json 所在目录；找不到输出空串
owner_pkg_dir() {
  local path="$1" dir
  if [ -d "$path" ]; then
    dir="$(cd "$path" && pwd -P)" || return 0
  elif [ -f "$path" ]; then
    dir="$(cd "$(dirname "$path")" && pwd -P)" || return 0
  else
    return 0
  fi
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/package.json" ]; then
      printf '%s' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
}

relink_one() {
  local src="$1" target="$2" dest owner_dir action rel
  if [ -L "$target" ]; then
    dest="$(abs_link_dest "$target" || true)"
    case "$dest" in
      "$NPM_PKG_DIR"|"$NPM_PKG_DIR"/*)
        # 注意：字符串里 ${dest} 必须用花括号——全角字符紧跟 $var 时
        # bash 5.3 会把多字节字节并入变量名扫描，set -u 下报 unbound
        echo "  = $target → ${dest}（已是 npm 指向）"
        return 0
        ;;
    esac
    if [ ! -e "$target" ]; then
      action="悬空重建"
    else
      # 本包 checkout 判定需同时满足：① 最近 package.json 的 name 是本包；
      # ② checkout 根下存在与 npm 包内相同的相对路径结构（防无关祖先
      # package.json 巧合同名，向上冒泡时可能命中）
      owner_dir="$(owner_pkg_dir "$dest")"
      rel="${src#"$NPM_PKG_DIR"/}"
      if [ -n "$owner_dir" ] && [ "$(pkg_name "$owner_dir/package.json")" = "$PKG" ] \
        && [ -e "$owner_dir/$rel" ]; then
        action="dev-link 残留重建"
      else
        echo "  ! $target → ${dest:-?}：非本包 link，不覆盖" >&2
        return 0
      fi
    fi
  elif [ -e "$target" ]; then
    echo "  ! $target 不是 symlink（可能是用户资产），跳过" >&2
    return 0
  else
    action="补装"
  fi
  mkdir -p "$(dirname "$target")"
  rm -f "$target"
  ln -s "$src" "$target"
  echo "  ✓ [$action] $target → $src"
}

# agent 文件以 YAML frontmatter（---）开头；与 install-skill.sh 判定一致
is_agent_file() {
  [ -f "$1" ] && [ "$(head -1 "$1")" = "---" ]
}

relink_pkg_assets() {
  local skill_dir skill_name agent_file agent_name src base
  if [ -d "$NPM_PKG_DIR/skills" ]; then
    for skill_dir in "$NPM_PKG_DIR/skills"/*/; do
      skill_dir="${skill_dir%/}"
      [ -f "$skill_dir/SKILL.md" ] || continue
      skill_name="$(basename "$skill_dir")"
      for base in "${SKILL_TARGETS[@]}"; do
        relink_one "$skill_dir" "$base/$skill_name"
      done
      # 随 skill 自包含的 agents
      if [ -d "$skill_dir/agents" ]; then
        for agent_file in "$skill_dir"/agents/*.md; do
          is_agent_file "$agent_file" || continue
          agent_name="$(basename "$agent_file" .md)"
          for base in "${AGENT_TARGETS[@]}"; do
            # pi 的 agent 发现要求文件名以 .md 结尾，目标保留后缀
            relink_one "$agent_file" "$base/$agent_name.md"
          done
        done
      fi
    done
  fi
  # 独立 agents（不属于任何 skill）
  if [ -d "$NPM_PKG_DIR/agents" ]; then
    for agent_file in "$NPM_PKG_DIR/agents"/*.md; do
      is_agent_file "$agent_file" || continue
      agent_name="$(basename "$agent_file" .md)"
      for base in "${AGENT_TARGETS[@]}"; do
        relink_one "$agent_file" "$base/$agent_name.md"
      done
    done
  fi
}

if [ -n "$NPM_PKG_DIR" ] && { [ -d "$NPM_PKG_DIR/skills" ] || [ -d "$NPM_PKG_DIR/agents" ]; }; then
  echo "→ 重建 dev link 时代残留的 skill/agent symlink 为 npm 指向..."
  relink_pkg_assets
else
  echo "warning: npm 包内未找到 skills/agents 目录，跳过 symlink 重建" >&2
fi

echo ""
echo "✓ 已切换到 npm 正式版。当前 cw 指向："
which cw
ls -la "$(which cw)"

#!/usr/bin/env bash
# 切换 cw 到本地开发版：卸载 npm 正式版，build + link 本地
set -euo pipefail

PKG="@zhushanwen/coding-workflow"
# 脚本所在仓库根目录（.agents/skills/dev-link/ 往上三级）。
# 先 readlink -f 解析 symlink 再上三级：本 skill 以 symlink 形态安装在
# ~/.agents/skills/dev-link（全局 AGENTS.md 的 skill 安装规范），不解析的话
# REPO_ROOT 会落到用户 HOME 目录，导致先卸载 npm 版、再在错误目录 build 失败。
SCRIPT_REAL_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$(dirname "$SCRIPT_REAL_PATH")/../../.." && pwd)"

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
# cw 可能不在当前 PATH（nvm 切换 / 非交互 shell 无 npm bin）：安装已成功，
# 指向探测失败只警告不失败，避免 set -e 把成功切换误报为 exit 1
if CW_BIN="$(command -v cw)"; then
  echo "✓ 已切换到本地 link。当前 cw 指向："
  which cw
  ls -la "$CW_BIN"
else
  echo "✓ 已切换到本地 link。"
  echo "! cw 不在当前 PATH 中（安装本身已完成）。可能原因：新装的 bin 目录未进入当前 shell PATH——新开 shell 或检查 npm prefix/bin。验证：npm ls -g ${PKG}" >&2
fi

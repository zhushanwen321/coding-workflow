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
which cw
ls -la "$(which cw)"

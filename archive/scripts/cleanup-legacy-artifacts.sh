#!/usr/bin/env bash
#
# cleanup-legacy-artifacts.sh — 清理项目根目录散落的旧格式 cw 中间产物 JSON。
#
# 背景：cw-cli 曾把中间产物（clarify/plan/design-review 等）直接写到项目根目录，
# 文件名形如 clarify.json / plan-wave1.json / dr-slice1.json。现已改为统一写到
# .cw/<slug>/<action>.json（已 gitignore）。本脚本清理迁移前的旧格式散落文件。
#
# 用法：
#   bash scripts/cleanup-legacy-artifacts.sh            # dry-run，只列出会删的文件
#   bash scripts/cleanup-legacy-artifacts.sh --force    # 真删
#
# 安全保证：
#   - 默认 dry-run，必须显式 --force 才删
#   - 只扫当前目录根，不递归（避免误删 node_modules / src 等）
#   - 白名单排除业务文件（package.json / cw.config.json / tsconfig 等）
#   - 删前逐个列出，用户可 review

set -euo pipefail

# ── 参数解析 ──────────────────────────────────────────────
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    -h|--help)
      echo "用法: bash scripts/cleanup-legacy-artifacts.sh [--force]"
      echo "  无参数 = dry-run（只列出，不删）"
      echo "  --force = 真删"
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      exit 1
      ;;
  esac
done

# ── 旧格式 cw 中间产物匹配模式 ────────────────────────────
# action 前缀（含缩写形式：dr=design-review, er=exec-review）
# 加 * 匹配后缀（如 -wave1 / -slice1 / -wave2 等）
PATTERNS=(
  "clarify*.json"
  "plan*.json"
  "dr*.json"
  "er*.json"
  "test*.json"
  "retro*.json"
  "retrospect*.json"
  "closeout*.json"
  "review*.json"
  "create*.json"
)

# ── 白名单（绝不删的业务文件）──────────────────────────────
WHITELIST=(
  "package.json"
  "package-lock.json"
  "cw.config.json"
  "tsconfig.json"
  "tsconfig.test.json"
  "tsconfig.app.json"
  "tsconfig.node.json"
)

# ── 收集待删文件 ──────────────────────────────────────────
TARGETS=()

for pattern in "${PATTERNS[@]}"; do
  # 只扫根目录（maxdepth 1），不递归
  while IFS= read -r -d '' file; do
    basename=$(basename "$file")

    # 白名单跳过
    is_whitelisted=false
    for w in "${WHITELIST[@]}"; do
      if [[ "$basename" == "$w" ]]; then
        is_whitelisted=true
        break
      fi
    done
    [[ "$is_whitelisted" == "true" ]] && continue

    # 去重（同文件可能被多个 pattern 命中）
    already=false
    for t in "${TARGETS[@]:-}"; do
      if [[ "$t" == "$file" ]]; then
        already=true
        break
      fi
    done
    [[ "$already" == "true" ]] && continue

    TARGETS+=("$file")
  done < <(find . -maxdepth 1 -name "$pattern" -type f -print0 2>/dev/null || true)
done

# ── 输出 + 执行 ───────────────────────────────────────────
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "没有发现旧格式 cw 中间产物。根目录已干净。"
  exit 0
fi

echo "发现 ${#TARGETS[@]} 个旧格式 cw 中间产物："
echo "────────────────────────────────────────"
for f in "${TARGETS[@]}"; do
  size=$(wc -c < "$f" | tr -d ' ')
  echo "  $f (${size} bytes)"
done
echo "────────────────────────────────────────"
echo ""

if [[ "$FORCE" != "true" ]]; then
  echo "[dry-run] 未实际删除。确认后加 --force 参数真删："
  echo "  bash scripts/cleanup-legacy-artifacts.sh --force"
  exit 0
fi

# 真删
deleted=0
for f in "${TARGETS[@]}"; do
  rm -f "$f"
  echo "已删除: $f"
  ((deleted++))
done
echo ""
echo "已清理 $deleted 个文件。"
echo "提示：新的 cw 中间产物统一写到 .cw/<slug>/ 目录（已 gitignore）。"

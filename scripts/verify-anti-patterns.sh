#!/usr/bin/env bash
# verify-anti-patterns.sh — 反模式验收脚本（#10 方案A）。
#
# 检查项（来自 system-architecture.md §11）：
#   1. engine 运行时 import 图无 pi 依赖
#   2. CLI 适配层未 copy-paste engine 逻辑
#   3. 无单实现 interface（RuntimeAdapter 不落地）
#   4. store/gates 行为零改动（26 个单测全绿即证，本脚本不重复）
#   5. StringEnum 替换为 Type.Union
#   6. exit code 分层契约实现
#   7. ADR-029 worktree cwd 防护逻辑
#   8. CwParamsSchema 信封在 protocol.ts
#
# 用法：bash scripts/verify-anti-patterns.sh
# 退出码：0 = 全部通过，1 = 有违规

set -euo pipefail

SRC_DIR="${1:-src}"
FAIL=0

echo "=== 反模式验收检查 ==="
echo "检查目录: $SRC_DIR"
echo ""

# ── 1. 无 pi 运行时依赖 ──────────────────────────────────────

echo "[1] 检查 engine 运行时 import 无 pi 依赖..."
PI_DEPS=$(grep -rn "@mariozechner\|@earendil-works" "$SRC_DIR/engine/" 2>/dev/null | grep -v "// " | grep -v "/*" || true)
if [ -n "$PI_DEPS" ]; then
  echo "  FAIL: 发现 pi 依赖 import:"
  echo "$PI_DEPS" | sed 's/^/    /'
  FAIL=1
else
  echo "  PASS: engine 无 pi 运行时 import"
fi

# ── 2. CLI 未 copy-paste engine 逻辑 ─────────────────────────

echo "[2] 检查 CLI 未 copy-paste 状态机/check 逻辑..."
# 检查 cli/ 目录下是否有独立的 TRANSITIONS 定义或 check 函数
CLI_SM=$(grep -rn "TRANSITIONS\s*=" "$SRC_DIR/cli/" 2>/dev/null || true)
CLI_CHECK=$(grep -rn "function check\|function runCheck" "$SRC_DIR/cli/" 2>/dev/null || true)
if [ -n "$CLI_SM" ] || [ -n "$CLI_CHECK" ]; then
  echo "  FAIL: CLI 层发现独立状态机/check 逻辑:"
  [ -n "$CLI_SM" ] && echo "$CLI_SM" | sed 's/^/    /'
  [ -n "$CLI_CHECK" ] && echo "$CLI_CHECK" | sed 's/^/    /'
  FAIL=1
else
  echo "  PASS: CLI 未 copy-paste engine 逻辑"
fi

# ── 3. 无单实现 interface ────────────────────────────────────

echo "[3] 检查无 RuntimeAdapter interface..."
ADAPTER=$(grep -rn "interface RuntimeAdapter\|interface.*Adapter" "$SRC_DIR/" 2>/dev/null || true)
if [ -n "$ADAPTER" ]; then
  echo "  FAIL: 发现 adapter interface（单实现反模式）:"
  echo "$ADAPTER" | sed 's/^/    /'
  FAIL=1
else
  echo "  PASS: 无单实现 adapter interface"
fi

# ── 5. StringEnum 替换 ──────────────────────────────────────

echo "[5] 检查 StringEnum 已替换为 Type.Union..."
# 排除注释行（只检查 import/代码引用，不检查注释说明）
STRING_ENUM=$(grep -rn "StringEnum" "$SRC_DIR/" 2>/dev/null | grep -v "^.*:\s*/[/*]" | grep -v "^.*:\s*\*" | grep -v "^.*:\s*//" || true)
if [ -n "$STRING_ENUM" ]; then
  echo "  FAIL: 发现 StringEnum 引用:"
  echo "$STRING_ENUM" | sed 's/^/    /'
  FAIL=1
else
  echo "  PASS: StringEnum 已替换"
fi

# ── 6. exit code 分层契约 ───────────────────────────────────

echo "[6] 检查 exit code 分层契约实现..."
# 检查 cli.ts 有 mapExitCode 或类似逻辑
EXIT_MAP=$(grep -n "mapExitCode\|exit(0)\|exit(1)" "$SRC_DIR/cli/cli.ts" 2>/dev/null || true)
if [ -z "$EXIT_MAP" ]; then
  echo "  FAIL: cli.ts 未发现 exit code 映射逻辑"
  FAIL=1
else
  echo "  PASS: exit code 分层契约已实现"
fi

# ── 7. ADR-029 worktree cwd 防护 ────────────────────────────

echo "[7] 检查 .cw-wt/ worktree 检测逻辑..."
WT_CHECK=$(grep -rn "\.cw-wt\|cw-wt" "$SRC_DIR/" 2>/dev/null || true)
if [ -z "$WT_CHECK" ]; then
  echo "  FAIL: 未发现 .cw-wt/ 检测逻辑"
  FAIL=1
else
  echo "  PASS: .cw-wt/ 检测逻辑存在"
fi

# ── 8. CwParamsSchema 信封在 protocol.ts ─────────────────────

echo "[8] 检查 CwParamsSchema 定义在 protocol.ts..."
SCHEMA_CLI=$(grep -n "CwParamsSchema" "$SRC_DIR/cli/protocol.ts" 2>/dev/null || true)
SCHEMA_ENGINE=$(grep -rn "CwParamsSchema" "$SRC_DIR/engine/" 2>/dev/null || true)
if [ -z "$SCHEMA_CLI" ]; then
  echo "  FAIL: protocol.ts 未定义 CwParamsSchema"
  FAIL=1
elif [ -n "$SCHEMA_ENGINE" ]; then
  echo "  FAIL: engine 层发现 CwParamsSchema（应只在 protocol.ts）:"
  echo "$SCHEMA_ENGINE" | sed 's/^/    /'
  FAIL=1
else
  echo "  PASS: CwParamsSchema 在 protocol.ts（信封下沉正确）"
fi

# ── 汇总 ─────────────────────────────────────────────────────

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== 全部通过 ==="
  exit 0
else
  echo "=== 有违规项，请修复 ==="
  exit 1
fi

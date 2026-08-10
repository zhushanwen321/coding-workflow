#!/usr/bin/env bash
# review-context.sh — 检测 cw 工作流上下文 + subagent 能力，输出 JSON 供 pr-cr-fix 决策
#
# 输出字段：
#   harness_mode      "harness" | "standalone"（是否在 cw 工作流目录下）
#   subagent_capable  true（固定；真正的能力判断由调用方 SKILL.md 根据 harness 类型决定）
#   dimensions        启用的审查维度（harness 多 plan-completeness）
#   git_root          git 仓库根目录绝对路径
#   files             变更文件列表（git diff main...HEAD --name-only）
#   primary_lang      "typescript"
set -euo pipefail

# ── 1. diff 定位（感知 worktree）──
GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")"

# 变更文件列表：git diff main...HEAD --name-only
# 无 git 或无 main 分支时降级为空（不崩）
FILES_RAW=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git rev-parse --verify main >/dev/null 2>&1; then
    FILES_RAW="$(git diff main...HEAD --name-only 2>/dev/null || true)"
  elif git rev-parse --verify master >/dev/null 2>&1; then
    # 降级：默认分支可能是 master
    FILES_RAW="$(git diff master...HEAD --name-only 2>/dev/null || true)"
  fi
fi

# ── 2. harness_mode：检测 cw 工作流上下文（store.json + WorkUnit）──
#    检测 $CW_HOME（默认 ~/.cw）下是否有当前 git_root 的 store.json，或仓库根有 .cw/
CW_HOME="${CW_HOME:-$HOME/.cw}"
# encodeCwd 规则：路径分隔符 / 和 \ → __（与 src/store/schema.ts:85 encodeCwd 一致）
ENCODED_CWD="$(printf '%s' "$GIT_ROOT" | sed 's|/|__|g; s|\\|__|g')"
STORE_JSON="$CW_HOME/$ENCODED_CWD/store.json"

if [ -f "$STORE_JSON" ] || [ -d "$GIT_ROOT/.cw" ]; then
  HARNESS_MODE="harness"
else
  HARNESS_MODE="standalone"
fi

# ── 3. dimensions：harness 模式启用 plan-completeness，standalone 裁掉 ──
if [ "$HARNESS_MODE" = "harness" ]; then
  DIMENSIONS='["project-conventions", "quality-criteria", "plan-completeness"]'
else
  DIMENSIONS='["project-conventions", "quality-criteria"]'
fi

# ── 4. subagent_capable：脚本里固定 true ──
#    真正的能力判断由调用方（pr-cr-fix 的 SKILL.md）根据 harness 类型决定，
#    脚本无法可靠检测当前是 zcode / pi / 其他 harness。
SUBAGENT_CAPABLE="true"

# ── 5. primary_lang：CW 是 TypeScript 项目 ──
PRIMARY_LANG="typescript"

# ── 6. 输出 JSON ──
# files 数组：用 jq -R 逐行读，正确转义特殊字符（空格、引号、反斜杠）
# FILES_RAW 为空时 jq -R 不产出任何行 → files 为 []
# jq 缺失时走 else 降级：手工构造等价 JSON，保证调用方（pr-cr-fix 阶段 2）总能拿到输出
if command -v jq >/dev/null 2>&1; then
  FILES_JSON="$(printf '%s' "$FILES_RAW" | grep -v '^$' | jq -R . 2>/dev/null | jq -s . 2>/dev/null || printf '[]')"

  # 用 jq 构造最终 JSON（保证字段顺序 + 合法性）
  jq -n \
    --arg harness_mode "$HARNESS_MODE" \
    --argjson subagent_capable "$SUBAGENT_CAPABLE" \
    --argjson dimensions "$DIMENSIONS" \
    --arg git_root "$GIT_ROOT" \
    --argjson files "$FILES_JSON" \
    --arg primary_lang "$PRIMARY_LANG" \
    '{
      harness_mode: $harness_mode,
      subagent_capable: $subagent_capable,
      dimensions: $dimensions,
      git_root: $git_root,
      files: $files,
      primary_lang: $primary_lang
    }'
else
  # jq 缺失降级：仅对含用户输入的两个字段（git_root / files）转义引号和反斜杠；
  # 其余字段（harness_mode / subagent_capable / dimensions / primary_lang）是固定枚举值，直接内插
  json_escape() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
  }
  FILES_LIST=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    [ -n "$FILES_LIST" ] && FILES_LIST="$FILES_LIST,"
    FILES_LIST="$FILES_LIST\"$(json_escape "$line")\""
  done < <(printf '%s\n' "$FILES_RAW")
  printf '{"harness_mode":"%s","subagent_capable":%s,"dimensions":%s,"git_root":"%s","files":[%s],"primary_lang":"%s"}\n' \
    "$HARNESS_MODE" "$SUBAGENT_CAPABLE" "$DIMENSIONS" \
    "$(json_escape "$GIT_ROOT")" "$FILES_LIST" "$PRIMARY_LANG"
fi

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

# ── 2. harness_mode：检测 cw 2.0 工作流上下文（events.log 事件账本）──
#    2.0 数据全在 $CW_HOME（默认 ~/.cw），引擎无 repo-local 数据目录；账本 key 是
#    主仓根而非 worktree 根（runner spawn 的每条 cw 命令内联 CW_PROJECT_DIR="<主仓根>"，
#    见 src/runner/spawn/human.ts）。探测候选序列（任一命中 → harness）：
#      ① CW_PROJECT_DIR env：存在时最优先，它就是账本 key 的权威来源
#      ② 主仓根：由 git 结构推导——worktree 布局下 --git-common-dir 指向主仓
#        .git/.bare（如 <workspace>/.bare），其父目录即主仓根；普通布局推导结果
#        = GIT_ROOT 本身
#      ③ GIT_ROOT 自身：兼容直接在主仓根执行的非 worktree 普通布局
CW_HOME="${CW_HOME:-$HOME/.cw}"

encode_cwd() {
  # encodeCwd 规则（与 src/store/project.ts 的 2.0 实态完全同构）：前缀把 / \ . 三字符
  # 逐一替换为 __（点号也编码，防 cwd="." 编码成特殊目录名逃逸 CW_HOME）；后缀拼
  # sha256(cwd 原文) 前 8 位小写 hex 防碰撞（纯替换是多对一映射），连接符 -。
  # TS 原型：encodeCwd = cwd.replace(/[\\/.]/g, "__") + "-" + sha256(cwd).digest("hex").slice(0, 8)
  # bash 无单步等价写法：bracket 内连写两个反斜杠的形态会整段失效（实测），拆两段逐字符替换
  local readable="${1//[\/.]/__}"
  readable="${readable//\\/__}"
  printf '%s-%s' "$readable" "$(printf '%s' "$1" | shasum -a 256 | cut -c1-8)"
}

ledger_exists() {
  # $1 = 候选项目根；非空且 $CW_HOME 下其编码目录含 events.log 判真
  [ -n "$1" ] || return 1
  [ -f "$CW_HOME/$(encode_cwd "$1")/events.log" ]
}

# 主仓根推导：--git-common-dir 的父目录。相对路径输出（普通仓的 ".git"）锚定脚本
# 运行目录解析；父目录用 pwd -P 物理化，与 --show-toplevel 的规范化形态一致
MAIN_ROOT=""
COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [ -n "$COMMON_DIR" ]; then
  case "$COMMON_DIR" in
    /*) ;;
    *) COMMON_DIR="$PWD/$COMMON_DIR" ;;
  esac
  MAIN_ROOT="$(cd "$(dirname "$COMMON_DIR")" 2>/dev/null && pwd -P || true)"
fi

if ledger_exists "${CW_PROJECT_DIR:-}"; then
  HARNESS_MODE="harness"
elif ledger_exists "$MAIN_ROOT" || ledger_exists "$GIT_ROOT"; then
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
# FILES_RAW 为空时 jq -R 不产出任何行 → files 为 []；删空行必须用 sed 而非
# grep -v：grep 对空输入 exit 1，pipefail 下误触发 || 分支，与 jq 已输出的 []
# 叠加成两份污染 FILES_JSON（argjson 解析必炸）
# jq 缺失时走 else 降级：手工构造等价 JSON，保证调用方（pr-cr-fix 阶段 2）总能拿到输出
if command -v jq >/dev/null 2>&1; then
  FILES_JSON="$(printf '%s' "$FILES_RAW" | sed '/^$/d' | jq -R . 2>/dev/null | jq -s . 2>/dev/null || printf '[]')"

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

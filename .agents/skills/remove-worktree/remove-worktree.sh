#!/bin/bash
# 清理 git worktree：检查合并状态 → 同步其他 worktree → 删除目标 worktree
# Usage: remove-worktree.sh <branch-name> [--force] [--skip-sync]
# Example: remove-worktree.sh feat/new-feature
#          remove-worktree.sh feat/old-feature --force
#          remove-worktree.sh feat/experiment --force --skip-sync
#
# 自包含脚本：workspace 操作函数内联于下方，无外部 source 依赖。
set -euo pipefail

# ---------- 内联 workspace 函数（源自全局 _lib/workspace.sh，保持本 skill 目录完整自包含） ----------

# 从当前目录向上查找 workspace 根（包含 .bare/ 的目录）
find_workspace_root() {
    local dir="$1"
    while [[ "$dir" != "/" ]]; do
        if [[ -d "$dir/.bare" ]]; then
            echo "$dir"
            return 0
        fi
        dir="$(cd "$dir/.." && pwd)"
    done
    return 1
}

# 清理 worktree + 可选删除分支（合并状态由本脚本上游检查，这里只做删除 + 干净性兜底）
remove_worktree() {
    local workspace_root="$1"
    local branch_name="$2"
    local delete_branch="${3:-false}"
    local dir_name="${branch_name//\//-}"
    local worktree_path="$workspace_root/$dir_name"

    if [[ ! -d "$worktree_path" ]]; then
        echo "Error: worktree '$dir_name' 不存在。"
        return 1
    fi

    # 检查未提交/未跟踪的更改（兜底；force 模式由调用方决定是否到达此处）
    local has_changes=false
    if ! git -C "$worktree_path" diff --quiet 2>/dev/null || \
       ! git -C "$worktree_path" diff --cached --quiet 2>/dev/null; then
        has_changes=true
    fi
    local untracked
    untracked=$(git -C "$worktree_path" ls-files --others --exclude-standard 2>/dev/null)
    if [[ -n "$untracked" ]]; then
        has_changes=true
    fi
    if $has_changes; then
        echo "Error: '$dir_name' 有未提交/未跟踪的更改，请先提交或 stash。"
        git -C "$worktree_path" status --short
        return 1
    fi

    echo "删除 worktree '$dir_name'..."
    git -C "$workspace_root/.bare" worktree remove "$worktree_path"

    if $delete_branch; then
        if git -C "$workspace_root/.bare" rev-parse --verify "$branch_name" >/dev/null 2>&1; then
            echo "删除本地分支 '$branch_name'..."
            # 非强制模式：git branch -d 安全检查失败时不 fallback 到 -D（--force 路径另用 -D），
            # 避免 --force 语义泄漏。
            if ! git -C "$workspace_root/.bare" branch -d "$branch_name" 2>/dev/null; then
                echo "错误：分支 $branch_name 未通过 git branch -d 安全检查（可能未真正合并）。" >&2
                echo "如确认要强制删除，请用 --force 参数重试。" >&2
                return 1
            fi
        fi
    fi
}

# ---------- 主流程 ----------

BRANCH_NAME="${1:?Usage: remove-worktree.sh <branch-name> [--force] [--skip-sync]}"
shift || true
FORCE=false
SKIP_SYNC=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force)      FORCE=true; shift ;;
        --skip-sync)  SKIP_SYNC=true; shift ;;
        *)            echo "Unknown option: $1"; exit 1 ;;
    esac
done

DIR_NAME="${BRANCH_NAME//\//-}"

WORKSPACE_ROOT=$(find_workspace_root "$(pwd)") || {
    echo "Error: 未找到 workspace。当前目录及其父目录中没有 .bare/。"
    exit 1
}
echo "Workspace: $WORKSPACE_ROOT"

# 立即切到 workspace root，避免当前目录后续被删除
cd "$WORKSPACE_ROOT"

WT_PATH="$WORKSPACE_ROOT/$DIR_NAME"

# 检查 worktree 是否存在
if [[ ! -d "$WT_PATH" ]]; then
    echo "Error: worktree 目录 '$DIR_NAME' 不存在。"
    echo ""
    echo "当前 worktree 列表:"
    git -C .bare worktree list 2>/dev/null || true
    exit 1
fi

# --- 合并状态检查（非 force 模式） ---
if [[ "$FORCE" != "true" ]]; then
    echo ""
    echo "=== 检查合并状态 ==="

    # fetch 走 refspec 更新 origin/main（不带分支名 + --prune）
    # [HISTORICAL] 禁止 git fetch origin <branch>：只写 FETCH_HEAD 不更新 tracking ref
    git -C .bare fetch origin --prune 2>&1 | tail -1

    MAIN_BRANCH=$(git -C .bare remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}') || true
    if [ -z "$MAIN_BRANCH" ]; then
        echo "错误：无法探测远程默认分支（git remote show origin 失败，可能离线）。" >&2
        echo "请检查网络或手动指定。" >&2
        exit 1
    fi

    # 用 fixed-string + 整行锚定匹配，避免子串误匹配（feat/foo 误匹配 feat/foo-bar）
    # 及正则元字符（. + 等）问题。先 strip 行首的标记符（git branch 输出格式）：
    #   '* ' = 当前 HEAD 分支，'+ ' = 其他 worktree checkout 的分支，'  ' = 普通分支。
    if git -C .bare branch --merged "origin/$MAIN_BRANCH" 2>/dev/null | sed 's/^[*+ ]*//' | grep -Fxq "$BRANCH_NAME"; then
        echo "✓ 分支 '$BRANCH_NAME' 已合并到 origin/$MAIN_BRANCH"
    else
        echo "✗ 分支 '$BRANCH_NAME' 尚未合并到 origin/$MAIN_BRANCH"
        echo ""
        echo "未合并的 commits:"
        git -C .bare log --oneline "origin/$MAIN_BRANCH..$BRANCH_NAME" 2>/dev/null | head -10 || echo "  (无法获取 commit 历史)"
        echo ""
        echo "Error: 分支未合并，拒绝删除。使用 --force 强制清理。"
        exit 1
    fi
else
    echo ""
    echo "=== 强制模式（跳过合并检查）==="
fi

# 检查未提交变更
DIRTY=$(cd "$WT_PATH" && git status --short 2>/dev/null) || true
if [[ -n "$DIRTY" ]]; then
    if [[ "$FORCE" != "true" ]]; then
        echo ""
        echo "Error: worktree 有未提交变更:"
        echo "$DIRTY"
        echo "使用 --force 强制删除。"
        exit 1
    else
        echo ""
        echo "Warning: worktree 有未提交变更（--force 模式下继续删除）:"
        echo "$DIRTY" | head -10
    fi
fi

# --- 同步其他 worktree ---
SYNCED=0
CONFLICTS=0
CONFLICT_WTS=""

if [[ "$SKIP_SYNC" != "true" ]]; then
    echo ""
    echo "=== 同步其他 worktree 到 origin/main ==="

    MAIN_BRANCH=$(git -C .bare remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}') || true
    if [ -z "$MAIN_BRANCH" ]; then
        echo "错误：无法探测远程默认分支（git remote show origin 失败，可能离线）。" >&2
        echo "请检查网络或手动指定。" >&2
        exit 1
    fi

    for _wt_entry in */; do
        _wt_name="${_wt_entry%/}"
        [[ "$_wt_name" == ".bare" ]] && continue
        [[ "$_wt_name" == "$DIR_NAME" ]] && continue
        [[ "$_wt_name" == "node_modules" ]] && continue
        [[ "$_wt_name" =~ ^\. ]] && continue  # 跳过隐藏目录

        _branch=""
        _branch=$(cd "$WORKSPACE_ROOT/$_wt_name" 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null) || _branch=""

        # 跳过 main/master 和空分支
        [[ "$_branch" == "main" || "$_branch" == "master" ]] && continue
        [[ -z "$_branch" ]] && continue

        echo "同步 $_wt_name ($_branch)..."

        cd "$WORKSPACE_ROOT/$_wt_name"
        # [HISTORICAL] git fetch origin（不带分支名）走 refspec，确保 origin/main 更新
        git fetch origin 2>&1 | tail -1

        if git merge --ff-only "origin/$MAIN_BRANCH" 2>/dev/null; then
            echo "  OK: $_wt_name 已同步到最新 $MAIN_BRANCH"
            SYNCED=$((SYNCED + 1))
        else
            # ff-only 失败说明 feature 分支有独立 commit（不能快进），跳过不阻塞当前删除。
            # 真正的 merge 冲突场景由人工/AI 在该 worktree 单独处理。
            echo "  警告: $_wt_name 无法快进同步（可能有独立 commit），跳过。" >&2
            CONFLICTS=$((CONFLICTS + 1))
            CONFLICT_WTS="${CONFLICT_WTS:+$CONFLICT_WTS }$_wt_name"
        fi
        cd "$WORKSPACE_ROOT"
    done
else
    echo ""
    echo "跳过同步其他 worktree (--skip-sync)"
fi

# --- 删除目标 worktree（最后执行） ---
echo ""
echo "=== 清理 worktree $BRANCH_NAME ==="
# force=true 时 remove_worktree 内部的干净性检查会拦住有变更的 worktree，
# 故 force 模式下用 git 原生命令跳过该兜底检查
if [[ "$FORCE" == "true" ]]; then
    echo "删除 worktree '$DIR_NAME'..."
    git -C "$WORKSPACE_ROOT/.bare" worktree remove --force "$WT_PATH"
    if git -C "$WORKSPACE_ROOT/.bare" rev-parse --verify "$BRANCH_NAME" >/dev/null 2>&1; then
        echo "删除本地分支 '$BRANCH_NAME'..."
        git -C "$WORKSPACE_ROOT/.bare" branch -D "$BRANCH_NAME" 2>/dev/null || true
    fi
else
    remove_worktree "$WORKSPACE_ROOT" "$BRANCH_NAME" true
fi

# --- 输出报告 ---
echo ""
echo "============================================"
echo "Remove worktree 完成!"
echo "  已删除: $BRANCH_NAME"
if [[ "$SKIP_SYNC" != "true" ]]; then
    echo "  已同步: $SYNCED 个 worktree"
    if [[ $CONFLICTS -gt 0 ]]; then
        echo "  冲突: $CONFLICTS 个 worktree（需处理）:"
        for wt in $CONFLICT_WTS; do
            echo "    - $wt"
        done
        echo ""
        echo "  冲突处理: 在冲突 worktree 中执行 git diff --name-only --diff-filter=U 查看冲突文件"
        echo "  处理完成后: git add . && git commit"
        echo "  放弃同步: git merge --abort"
    else
        echo "  冲突: 0"
    fi
fi
echo "============================================"

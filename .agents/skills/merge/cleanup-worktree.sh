#!/bin/bash
# coding-workflow merge skill —— 自包含的 worktree 清理脚本
#
# 替代原 remove-worktree skill 的清理职责，但只同步 main worktree
# （不再遍历同步其他 feature worktree——那是各分支自己的事）。
# workspace 操作函数复用同目录的 merge-helpers.sh（skill 内部依赖，自包含）。
#
# Usage: cleanup-worktree.sh <branch-name> [--force]
# Example: cleanup-worktree.sh feat-xxx
#          cleanup-worktree.sh feat-experiment --force
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$SCRIPT_DIR/merge-helpers.sh" ]]; then
    echo "Error: merge-helpers.sh 不存在于 $SCRIPT_DIR（skill 损坏）。" >&2
    exit 1
fi
# shellcheck source=merge-helpers.sh
source "$SCRIPT_DIR/merge-helpers.sh"

# ---------- 主流程 ----------

BRANCH_NAME="${1:?Usage: cleanup-worktree.sh <branch-name> [--force]}"
shift || true
FORCE=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --force) FORCE=true; shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

DIR_NAME="${BRANCH_NAME//\//-}"

WORKSPACE_ROOT=$(find_workspace_root "$(pwd)") || {
    echo "Error: 未找到 workspace（当前目录及父目录无 .bare/）。" >&2
    exit 1
}
echo "Workspace: $WORKSPACE_ROOT"

MAIN_BRANCH=$(detect_main_branch "$WORKSPACE_ROOT")
echo "Main branch: $MAIN_BRANCH"

# 立即切到 workspace root，避免当前目录后续被删除导致 bash 失败
cd "$WORKSPACE_ROOT"

WT_PATH="$WORKSPACE_ROOT/$DIR_NAME"

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
    # [HISTORICAL] fetch 不带分支名 + --prune 走 refspec，确保 origin/<main> 更新。
    # 禁止 git fetch origin <branch>：只写 FETCH_HEAD 不更新 tracking ref（2026-07-27 事故）。
    git -C .bare fetch origin --prune 2>&1 | tail -1

    # 用 fixed-string + 整行锚定匹配，避免子串误匹配（feat/foo 误匹配 feat/foo-bar）
    # 及正则元字符问题。先 strip 行首标记符（'* '=HEAD, '+ '=其他worktree, '  '=普通）。
    if git -C .bare branch --merged "origin/$MAIN_BRANCH" 2>/dev/null \
        | sed 's/^[*+ ]*//' | grep -Fxq "$BRANCH_NAME"; then
        echo "✓ 分支 '$BRANCH_NAME' 已合并到 origin/$MAIN_BRANCH"
    else
        echo "✗ 分支 '$BRANCH_NAME' 尚未合并到 origin/$MAIN_BRANCH"
        echo ""
        echo "未合并的 commits:"
        git -C .bare log --oneline "origin/$MAIN_BRANCH..$BRANCH_NAME" 2>/dev/null | head -10 \
            || echo "  (无法获取 commit 历史)"
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

# --- 恢复指向本 worktree 的全局 cw devlink 为 npm 正式版 ---
# dev-link 的 use-link.sh 会 npm link 把全局包 @zhushanwen/coding-workflow 指向
# 本 worktree；worktree 删除后该 link 悬空，cw 命令整体不可用。
# 仅处理指向本次被删 worktree 的 link（不误伤并行场景下其他有效的 dev link）。
# npm link 用相对 symlink，须先 resolve 成绝对路径再比对（删除前 target 存活，
# readlink -f 可安全展开）。
# [设计约束] 放在删除之前：先把退路修好再拆房子。npm install 从 registry 拉、
# 不依赖本地文件；失败则中止清理保住现场（worktree/分支原样，可直接重试）。
_cw_pkg="@zhushanwen/coding-workflow"
_npm_groot="$(npm root -g 2>/dev/null || true)"
_cw_pkg_link="${_npm_groot}/${_cw_pkg}"
if [ -n "$_npm_groot" ] && [ -L "$_cw_pkg_link" ]; then
    # 两侧统一物理归一化：npm link 建相对 symlink 须由 readlink -f 展开；
    # $WORKSPACE_ROOT 来自逻辑 pwd，途经 symlink 时形态不同，直接比对永不命中
    _pkg_target="$(readlink -f "$_cw_pkg_link")"
    _wt_physical="$(readlink -f "$WT_PATH")"
    case "$_pkg_target" in
        "$_wt_physical"|"$_wt_physical"/*)
            echo ""
            echo "=== 恢复 cw 全局 devlink 到 npm 正式版 ==="
            echo "dev link $_cw_pkg_link → $_pkg_target（本次将被删除）"
            npm unlink -g "$_cw_pkg" >/dev/null 2>&1 || true
            # 兜底清残留 symlink，防 EEXIST 挡住后续安装
            if [ -L "$_cw_pkg_link" ]; then rm -f "$_cw_pkg_link"; fi
            # @latest = 刚发布的新版本（阶段 4 CI 发布完成后才走到清理）
            if npm install -g "${_cw_pkg}@latest"; then
                echo "✓ cw 已切回 npm 正式版并升级到 latest"
            else
                echo "Error: npm install -g ${_cw_pkg}@latest 失败（网络或 registry 异常），已中止清理以保全现场。" >&2
                echo "恢复动作：修复后重跑本脚本；或手动执行 npm i -g ${_cw_pkg}@latest 后重跑。" >&2
                exit 1
            fi
            ;;
    esac
fi

# --- 删除目标 worktree ---
echo ""
echo "=== 清理 worktree $BRANCH_NAME ==="
if [[ "$FORCE" == "true" ]]; then
    git -C "$WORKSPACE_ROOT/.bare" worktree remove --force "$WT_PATH"
else
    git -C "$WORKSPACE_ROOT/.bare" worktree remove "$WT_PATH"
fi

# 删除本地分支
if git -C "$WORKSPACE_ROOT/.bare" rev-parse --verify "$BRANCH_NAME" >/dev/null 2>&1; then
    echo "删除本地分支 '$BRANCH_NAME'..."
    if [[ "$FORCE" == "true" ]]; then
        git -C "$WORKSPACE_ROOT/.bare" branch -D "$BRANCH_NAME" 2>/dev/null || true
    else
        # 非强制：-d 安全检查失败不 fallback 到 -D，避免 --force 语义泄漏
        if ! git -C "$WORKSPACE_ROOT/.bare" branch -d "$BRANCH_NAME" 2>/dev/null; then
            echo "错误：分支 $BRANCH_NAME 未通过 git branch -d 安全检查（可能未真正合并）。" >&2
            echo "如确认要强制删除，请用 --force 参数重试。" >&2
            exit 1
        fi
    fi
fi

# --- 只同步 main worktree（绝不触碰其他 feature worktree） ---
echo ""
echo "=== 同步 $MAIN_BRANCH worktree ==="
sync_main "$WORKSPACE_ROOT" || {
    echo "⚠ main 同步失败，但不影响本次清理结果。请稍后手动排查。" >&2
}

# --- 清理指向被删 worktree 的 cw-cli dev symlink ---
# dev-link（use-link.sh）会把 cw-cli symlink 指向 feature worktree；worktree 删除后
# 该 symlink 悬空，pi 读到悬空 link 当 skill 不存在。仅处理指向本次被删 worktree 的
# link（不误伤多 worktree 并行场景下其他仍有效的 dev link）。
_npm_root="$(npm root -g 2>/dev/null || true)"
_npm_skill="${_npm_root}/@zhushanwen/coding-workflow/skills/cw-cli"
for _skill_link in "$HOME/.agents/skills/cw-cli" "$HOME/.claude/skills/cw-cli"; do
    [ -L "$_skill_link" ] || continue
    _link_target="$(readlink "$_skill_link")"
    case "$_link_target" in
        "$WT_PATH"|"$WT_PATH"/*)
            if [ -d "$_npm_skill" ]; then
                rm -rf "$_skill_link"
                ln -s "$_npm_skill" "$_skill_link"
                echo "  → cw-cli symlink 切回 npm: $_skill_link"
            else
                rm -f "$_skill_link"
                echo "  → cw-cli dev symlink 删除（npm 包未全局安装）: $_skill_link"
            fi
            ;;
    esac
done

# --- 报告 ---
echo ""
echo "============================================"
echo "Cleanup worktree 完成!"
echo "  已删除: $BRANCH_NAME"
echo "  已同步: $MAIN_BRANCH worktree（仅 main）"
echo "  其他 feature worktree: 未触碰"
echo "============================================"

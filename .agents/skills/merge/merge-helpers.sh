#!/bin/bash
# coding-workflow merge skill —— workspace 操作函数库 + 子命令入口
#
# 自包含：不依赖其他 skill 或外部 _lib，所有函数内联于本文件。
# 同目录的 cleanup-worktree.sh 会 source 本文件复用函数（skill 内部依赖）。
#
# 设计目标：
#   1. 动态定位 workspace root 和 main worktree（不写死绝对路径）
#   2. main worktree 不存在时自动创建（兜底，避免 cd 失败后静默错目录）
#   3. 只同步 main worktree，绝不触碰其他 feature worktree
#
# 用法：
#   bash merge-helpers.sh selfcheck     # 自检：打印 workspace root / main 分支 / main worktree
#   bash merge-helpers.sh root          # 仅打印 workspace root 路径
#   bash merge-helpers.sh resolve-main  # 仅打印 main worktree 路径（不存在则自动创建）
#   bash merge-helpers.sh sync-main     # 同步 main worktree 到 origin/<main>
#   source merge-helpers.sh             # 加载函数供同目录其他脚本复用
set -euo pipefail

# ---------- 函数 ----------

# 从指定目录向上查找 workspace 根（包含 .bare/ 的目录）。
# 纯文件系统探测，不依赖 git，最稳。
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

# 探测远程默认分支名（纯本地 refs 操作，无需网络）。
# 优先 refs/remotes/origin/HEAD；否则检查 main/master 是否存在；最终默认 main。
detect_main_branch() {
    local ws_root="$1"
    local head_ref
    head_ref=$(git -C "$ws_root/.bare" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \
        | sed 's|refs/remotes/origin/||') || true
    if [[ -n "$head_ref" ]]; then
        echo "$head_ref"
        return 0
    fi
    if git -C "$ws_root/.bare" show-ref --verify --quiet refs/remotes/origin/main; then
        echo "main"
    elif git -C "$ws_root/.bare" show-ref --verify --quiet refs/remotes/origin/master; then
        echo "master"
    else
        echo "main"
    fi
}

# 定位 main worktree 路径（动态，不写死）。
# 查找顺序：
#   1. git worktree list 查分支为 <main> 的 worktree（权威）
#   2. fallback：约定目录名 = 分支名（$WS_ROOT/main），验证其确实 checkout 了 main
#   3. 兜底：自动创建 main worktree（fetch + worktree add），失败则返回非零
resolve_main_worktree() {
    local ws_root="$1"
    local main_branch
    main_branch=$(detect_main_branch "$ws_root")

    local main_wt=""
    # [1] worktree list 动态查找
    main_wt=$(git -C "$ws_root/.bare" worktree list --porcelain \
        | awk -v b="refs/heads/$main_branch" '/^worktree /{wt=$2} /^branch /{if($2==b) print wt}' \
        | head -1 || true)

    # [2] fallback：约定目录名 = 分支名
    if [[ -z "$main_wt" && -d "$ws_root/$main_branch" ]]; then
        local cur_branch
        cur_branch=$(git -C "$ws_root/$main_branch" branch --show-current 2>/dev/null || echo "")
        [[ "$cur_branch" == "$main_branch" ]] && main_wt="$ws_root/$main_branch"
    fi

    # [3] 兜底：自动创建
    if [[ -z "$main_wt" ]]; then
        echo "⚠ $main_branch worktree 不存在，尝试自动创建..." >&2
        # 先确保 bare repo 有最新的 origin/<main>
        # [HISTORICAL] fetch 不带分支名走 refspec，确保 tracking ref 更新
        git -C "$ws_root/.bare" fetch origin 2>&1 | tail -1 >&2
        if git -C "$ws_root/.bare" worktree add "$ws_root/$main_branch" \
               -b "$main_branch" "origin/$main_branch" >&2; then
            main_wt="$ws_root/$main_branch"
            echo "✓ 已创建 $main_branch worktree: $main_wt" >&2
        else
            echo "✗ 自动创建 $main_branch worktree 失败。" >&2
            echo "  请手动执行:" >&2
            echo "    git -C \"$ws_root/.bare\" worktree add \"$ws_root/$main_branch\" -b $main_branch origin/$main_branch" >&2
            return 1
        fi
    fi

    echo "$main_wt"
}

# 只同步 main worktree 到 origin/<main>。
# [设计约束] 绝不遍历其他 feature worktree 执行 fetch/merge——
#   feature worktree 的同步是各分支自己的职责，merge 流程不该越权触碰。
sync_main() {
    local ws_root="$1"
    local main_wt
    main_wt=$(resolve_main_worktree "$ws_root") || return 1
    local main_branch
    main_branch=$(detect_main_branch "$ws_root")

    echo "同步 $main_branch worktree: $main_wt"
    # [HISTORICAL] git fetch origin（不带分支名）走 refspec，确保 origin/<main> 更新。
    # 禁止 git fetch origin <branch>：只写 FETCH_HEAD 不更新 tracking ref（2026-07-27 事故）。
    git -C "$main_wt" fetch origin 2>&1 | tail -1
    if git -C "$main_wt" merge --ff-only "origin/$main_branch"; then
        echo "✓ $main_branch 已同步到最新 origin/$main_branch"
    else
        echo "✗ $main_branch 无法快进同步（本地 main 有独立 commit？）" >&2
        return 1
    fi
}

# ---------- 子命令入口（仅直接执行时生效，被 source 时不执行） ----------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    cmd="${1:-selfcheck}"
    case "$cmd" in
        selfcheck|root|resolve-main|sync-main) ;;
        *) echo "Usage: $0 [selfcheck|root|resolve-main|sync-main]" >&2; exit 1 ;;
    esac

    WS_ROOT=$(find_workspace_root "$(pwd)") || {
        echo "Error: 未找到 workspace（当前目录及其父目录均无 .bare/）。" >&2
        echo "  请 cd 到 workspace 内任一目录后重试。" >&2
        exit 1
    }

    case "$cmd" in
        selfcheck)
            echo "Workspace root: $WS_ROOT"
            MAIN_BRANCH=$(detect_main_branch "$WS_ROOT")
            echo "Main branch:    $MAIN_BRANCH"
            MAIN_WT=$(resolve_main_worktree "$WS_ROOT") || exit 1
            echo "Main worktree:  $MAIN_WT"
            echo "✓ 自检通过"
            ;;
        root)
            echo "$WS_ROOT"
            ;;
        resolve-main)
            resolve_main_worktree "$WS_ROOT"
            ;;
        sync-main)
            sync_main "$WS_ROOT"
            ;;
    esac
fi

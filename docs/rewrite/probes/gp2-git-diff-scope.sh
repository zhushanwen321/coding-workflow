#!/bin/bash
# GP2 探针：git diff --name-only H'..HEAD -- <scope> 的缓存判定语义
# 验证 design-release-pipeline.md D3 的命中判定基础：scope 内容未变 ⟺ diff 为空
# 复跑：bash docs/rewrite/probes/gp2-git-diff-scope.sh（自包含，产物在 /tmp/gp2-probe）
set -e
rm -rf /tmp/gp2-probe && mkdir -p /tmp/gp2-probe && cd /tmp/gp2-probe
git init -q && git config user.email p@p && git config user.name p
mkdir -p src/foo docs
echo a > src/foo/a.ts && echo d > docs/d.md && git add -A && git commit -qm c1
BASE=$(git rev-parse HEAD)
echo "--- 探针 1: 无改动时 diff 为空（缓存命中的判定基础）"
git diff --name-only $BASE..HEAD -- src/ | wc -l
echo "--- 探针 2: 改动 scope 外文件，scope 内 diff 仍为空"
echo d2 >> docs/d.md && git add -A && git commit -qm c2
echo "scope 内 diff 行数: $(git diff --name-only $BASE..HEAD -- src/ | wc -l | tr -d ' ')"
echo "scope 外 diff 行数: $(git diff --name-only $BASE..HEAD -- docs/ | wc -l | tr -d ' ')"
echo "--- 探针 3: 改动 scope 内文件 → 非空（缓存 miss）"
echo b >> src/foo/a.ts && git add -A && git commit -qm c3
git diff --name-only $BASE..HEAD -- src/
echo "--- 探针 4: scope 内 rename（新路径入 diff，向 miss 倒）"
git mv src/foo/a.ts src/foo/b.ts && git commit -qm c4
git diff --name-only $BASE..HEAD -- src/
echo "--- 探针 5: 多 scope 参数（空格分隔多个前缀）"
git diff --name-only $BASE..HEAD -- src/ docs/
echo "--- 探针 6: scope 单文件精确前缀"
git diff --name-only $BASE..HEAD -- src/foo/b.ts
echo "--- 探针 7: scope 不带斜杠仍按目录前缀匹配"
git diff --name-only $BASE..HEAD -- src
echo "BASE=$BASE HEAD=$(git rev-parse --short HEAD)"

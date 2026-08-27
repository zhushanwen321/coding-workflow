#!/usr/bin/env bash
# 重建 unit-basic golden 账本的生成脚本。
#
# 用法：bash tests/fixtures/golden-ledgers/unit-basic/scripts/generate.sh
# 前置条件：已 npm run build（dist/ 存在）
#
# 产出：在 /tmp 下创建临时 git 项目 + CW_HOME，跑完整 cw 命令序列，
#       产出 events.log 后复制回本目录。ReflectionRan 为手工构造（见 README）。
#
# 注意：macOS 上 /tmp 是 /private/tmp 的 symlink，Node.js process.cwd()
#       解析为 /private/tmp，encodeCwd 使用解析后路径。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$FIXTURE_DIR/../../../.." && pwd)"
CLI="node $REPO_ROOT/dist/cli.js"

# 使用 /private/tmp 避免 macOS symlink 问题
TMP_BASE="/private/tmp/cw-golden-gen-$$"
CW_HOME="$TMP_BASE/cw-home"
PROJECT_DIR="$TMP_BASE/project"

cleanup() { rm -rf "$TMP_BASE"; }
trap cleanup EXIT

mkdir -p "$CW_HOME" "$PROJECT_DIR"
cd "$PROJECT_DIR"

# 初始化 git 仓库
git init
git config user.email "golden@example.com"
git config user.name "golden"

# 项目文件
cat > brief.md << 'EOF'
# Golden Fixture
EOF

cat > test.sh << 'EOF'
#!/bin/sh
echo "A1 PASS"
echo "B1 PASS"
exit 0
EOF
chmod +x test.sh

cat > app.js << 'EOF'
module.exports = { ok: true };
EOF

# vitest 测试文件（unit 级验收用）
mkdir -p tests
cat > tests/A2.spec.ts << 'EOF'
import { describe, it, expect } from "vitest";
describe("A2 单元级冒烟", () => {
  it("A2 基础断言", () => {
    expect(true).toBe(true);
  });
});
EOF

cat > tests/B2.spec.ts << 'EOF'
import { describe, it, expect } from "vitest";
describe("B2 叶子单元级", () => {
  it("B2 基础断言", () => {
    expect(true).toBe(true);
  });
});
EOF

cat > package.json << 'EOF'
{
  "name": "golden-fixture",
  "version": "1.0.0",
  "devDependencies": {
    "vitest": "^3.2.1"
  }
}
EOF

git add -A
git commit -m "initial commit"
COMMIT_HASH=$(git rev-parse HEAD)

npm install --ignore-scripts 2>&1 | tail -1

export CW_HOME

# Step 1-2: 创建 unit
$CLI create --id root --brief brief.md
$CLI create --id leaf --brief brief.md --parent root

# Step 3-4: root spec + review
cat > spec-root.json << 'SPECEOF'
{
  "acceptance": [
    {"id": "A1", "core": true, "title": "应用可运行", "type": "e2e-real", "command": "sh test.sh"},
    {"id": "A2", "core": false, "title": "单元级冒烟", "type": "unit"}
  ],
  "contracts": [],
  "split": [{"unitId": "leaf", "dependsOn": []}]
}
SPECEOF
$CLI evidence submit --kind spec --unit root --file spec-root.json
$CLI review submit --unit root --verdict-kind spec-review --verdict pass --role reviewer --comment "spec 审查通过"

# Step 5-6: leaf spec + review
cat > spec-leaf.json << 'SPECEOF'
{
  "acceptance": [
    {"id": "B1", "core": true, "title": "叶子功能验证", "type": "e2e-real", "command": "sh test.sh"},
    {"id": "B2", "core": false, "title": "叶子单元级", "type": "unit"}
  ],
  "contracts": [],
  "split": []
}
SPECEOF
$CLI evidence submit --kind spec --unit leaf --file spec-leaf.json
$CLI review submit --unit leaf --verdict-kind spec-review --verdict pass --role reviewer --comment "叶子 spec 审查通过"

# Step 7-9: leaf build + verify + exec-review
$CLI evidence submit --kind build --unit leaf --commit "$COMMIT_HASH" --run-id "run-leaf-1" --file app.js
$CLI verify --unit leaf --no-red-phase || true
$CLI review submit --unit leaf --verdict-kind exec-review --verdict pass --evidence-refs "run-leaf-1" --comment "执行审查通过"

# Step 10-12: root build + verify + exec-review
$CLI evidence submit --kind build --unit root --commit "$COMMIT_HASH" --run-id "run-root-1" --file app.js
$CLI verify --unit root --no-red-phase || true
$CLI review submit --unit root --verdict-kind exec-review --verdict pass --evidence-refs "run-root-1" --comment "根节点执行审查通过"

# Step 13-14: 手工构造 ReflectionRan（runner 反思钩子，真实命令链无法产出）
ENCODED=$(node -e "
const { encodeCwd } = require('$REPO_ROOT/dist/store/project.js');
console.log(encodeCwd('$PROJECT_DIR'));
")
LEDGER="$CW_HOME/$ENCODED/events.log"

ROOT_SPEC_HASH=$(sed -n '3p' "$LEDGER" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['payload']['specHash'])")
LEAF_SPEC_HASH=$(sed -n '5p' "$LEDGER" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['payload']['specHash'])")

python3 -c "
import json, datetime
ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
for seq, uid, sh in [(13, 'root', '$ROOT_SPEC_HASH'), (14, 'leaf', '$LEAF_SPEC_HASH')]:
    ev = {'seq': seq, 'ts': ts, 'type': 'ReflectionRan',
          'payload': {'unitId': uid, 'specHash': sh, 'round': 1, 'revisedSpec': False}}
    print(json.dumps(ev, ensure_ascii=False, separators=(',', ':')))
" >> "$LEDGER"

# 验证
echo "=== Final status ==="
$CLI status

# 复制回 fixture 目录
cp "$LEDGER" "$FIXTURE_DIR/events.log"
echo "=== events.log 已复制到 $FIXTURE_DIR/events.log ==="

# 生成 snapshots
$CLI status > "$FIXTURE_DIR/snapshots/status.txt"
$CLI tree > "$FIXTURE_DIR/snapshots/tree.txt"
$CLI frontier --json > "$FIXTURE_DIR/snapshots/frontier.json"
$CLI report > "$FIXTURE_DIR/snapshots/report.txt"
echo "=== snapshots 已更新 ==="

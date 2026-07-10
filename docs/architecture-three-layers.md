# 三层防线：详细设计

> 配套 [architecture-review.md](./architecture-review.md)。本文档展开第二层（证据层）和第三层（数据源）的设计细节。

---

## 第二层：证据层（防偷工）

### 设计原则

**不信声明，信证据。** agent 提交的 `claimedStatus` 不再是判定依据——机器从 agent 同时提交的**执行证据**中算出真实结果。

### dev gate：commit diff 内容校验

**当前**（medium-git）：commit 存在 + 非空。

**升级后**（medium-diff）：
```
for each task in params.tasks:
  git.validate(commitHash)           // 存在性（保留）
  changedFiles = git.getChangedFiles(commitHash)  // git diff-tree --name-only
  declaredFiles = topic.waves.find(w => w.id === task.waveId).changes
  missing = declaredFiles \ changedFiles
  if missing.length > 0:
    mark wave uncommitted + report "commit 不含声明的文件: {missing}"
```

这防止 agent 提交一个无关 commit（改 README）就过 dev gate。

**新增 API**：
```ts
// gates.ts GitValidator
getChangedFiles(commitHash: string): string[] {
  const out = execFileSync("git",
    ["diff-tree", "--no-commit-id", "--name-only", "-r", commitHash],
    { cwd: this.workspacePath, encoding: "utf8" });
  return out.trim().split(/\r?\n/).filter(Boolean);
}
```

### test gate：测试报告解析（核心防线）

**当前**（mid）：信 `claimedStatus`。

**升级后**：`TestCaseSubmission` 增加 `evidencePath`，CW 解析证据判定。

**证据格式**（优先支持，零额外依赖）：
- **vitest json reporter**：`npx vitest run --reporter=json --outputFile=reports/vitest.json`
- **junit xml**（通用，CI 标准格式）：几乎所有测试框架都能产

**判定逻辑**：
```ts
interface TestCaseSubmission {
  caseId: string;
  evidencePath?: string;   // 新增：测试报告文件路径
  commitHash?: string;     // mid 保留
  // claimedStatus 删除——机器算，不信声明
}

function judgeMid(submission, deps, topic): { patch, reason } {
  if (!submission.evidencePath || !existsSync(submission.evidencePath))
    return failed("evidence required but missing");

  const report = parseTestReport(submission.evidencePath);  // junit/xml/json
  const result = report.findCase(submission.caseId);

  if (!result)         return failed(`case ${caseId} not found in evidence`);
  if (result.status === "skipped") return failed("case was skipped (not allowed)");
  if (result.status === "failed")  return failed(result.failureReason);
  return passed();
}
```

**关键设计决策**：
- `skipped` = `failed`：防 agent 标 skip 跳过 E2E
- evidence 文件不存在 = `failed`（infra 错误，不放过）
- caseId 在报告里找不到 = `failed`（防 agent 交一份不含该用例的报告）

### E2E 特别防线

在 `computeGatePassed("test")` 增加条件：

```ts
// state-machine.ts
function computeGatePassed(phase, topic): boolean {
  if (phase === "test") {
    const all = topic.testCases;
    const e2e = all.filter(c => c.layer === "e2e" || c.layer === "real");
    // 条件 1（原有）：所有用例 passed
    if (all.length === 0 || !all.every(c => c.status === "passed")) return false;
    // 条件 2（新增）：E2E/real 层用例全部 passed（防 agent 只提交 unit 用例绕过）
    if (e2e.length === 0) return false;  // 必须有 E2E 用例
    if (!e2e.every(c => c.status === "passed")) return false;
    return true;
  }
  // ...
}
```

这解决 P0 第二条：防 agent 压根不提交 E2E 用例。

---

## 第三层：数据源正本清源

### 问题

`CheckFn` 签名 `(topicDir: string) => CheckOutput` 只能读文件系统。check 脚本要验证的数据（waves/testCases/gateHistory）已在 `_cw.json` 里结构化存储，但 check 读不到，只能去解析 markdown 表格——这是 Bug 1/2/3 的根因。

### 方案

```ts
// 改前
type CheckFn = (topicDir: string) => CheckOutput;

// 改后
interface CheckContext {
  topic: CwTopic;       // 结构化数据（waves/testCases/gateHistory）
  topicDir: string;     // md 文件目录（语义检查用）
}
type CheckFn = (ctx: CheckContext) => CheckOutput;
```

### 各 check 的数据源重新划分

| check | 结构化检查（读 topic JSON） | 语义检查（读 md） |
|-------|---------------------------|-------------------|
| check-plan | Wave 依赖图无环 / 测试层 mock+real 各≥1 / 用例 ID 全映射 | 业务目标章节存在 / 无占位符 |
| check-issues | blocked_by 无幽灵依赖 / P 级一致 | 方案对比 ≥2 / 覆盖核验表 |
| check-nfr | 验收方式合法 / 回灌指针 PHANTOM | 无 ❌ 残留 |
| check-code-arch | 测试矩阵来源 B 映射（读 topic.testCases）| 骨架扫描（源码）/ grep pattern |

**效果**：Bug 1（filter 永远命中 0 行）消失——来源 B 映射直接读 `topic.testCases`，不需要解析表格。Bug 3（正则绑架）消失——用例 ID 就是 `testCase.id`，不需要正则匹配。

### 实施策略

check 函数签名改动会触及 8 个 check 文件 + gates.ts。建议：
1. 先改 `GateContext` 传入 topic（gates.ts 的 `runGate` 已有 `ctx.topic`，只是没传给 check）
2. 逐个 check 迁移结构化检查（每改一个跑测试）
3. md 表格解析代码保留但标记 deprecated，确认无 check 依赖后删除

---

## 覆盖矩阵：三层防线 vs 攻击向量

| 攻击向量 | 第一层（状态机） | 第二层（证据层） | 第三层（数据源） |
|---------|:---:|:---:|:---:|
| 跳过整个 test 阶段（created→closeout） | ✅ 防住 | — | — |
| 提交空 commit 过 dev | ❌ | ✅ diff 校验 | — |
| 谎报 E2E passed（不跑测试） | ❌ | ✅ 报告解析 | — |
| 只提交 unit 用例，跳过 E2E | ❌ | ✅ E2E 特别防线 | — |
| 标 skip 跳过 E2E | ❌ | ✅ skip=failed | — |
| 写格式正确但虚假的 plan.md 表格 | ❌ | — | ✅ 读 JSON |
| 在 test gate 无限重试 | ❌ | — | — (Phase 3 熔断) |

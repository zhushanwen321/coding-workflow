# unit-basic Golden 账本

GP-1 探针门（设计 `docs/rewrite/design-release-pipeline.md` §3.4）的 golden 基线账本。
用于泛化 EventLedger 域描述符注入后，验证 unit 域行为逐字节不变。

## 账本结构

14 条事件，覆盖全部六类事件类型。两个 unit（root + leaf，root 为内部节点，leaf 为叶子）。

| seq | type | unit | 说明 |
|-----|------|------|------|
| 1 | UnitCreated | root | 根节点创建（parentId=null） |
| 2 | UnitCreated | leaf | 叶子节点创建（parentId=root） |
| 3 | SpecSubmitted | root | root spec 入账（2 条验收：A1 e2e-real + A2 unit，split=[leaf]） |
| 4 | VerdictSubmitted | root | spec-review pass（role=reviewer） |
| 5 | SpecSubmitted | leaf | leaf spec 入账（2 条验收：B1 e2e-real + B2 unit） |
| 6 | VerdictSubmitted | leaf | spec-review pass（role=reviewer） |
| 7 | EvidenceSubmitted | leaf | leaf build 证据（runId=run-leaf-1） |
| 8 | VerifyRan | leaf | leaf verify pass（acceptanceIds=[B1,B2]） |
| 9 | VerdictSubmitted | leaf | exec-review pass → leaf closed |
| 10 | EvidenceSubmitted | root | root build 证据（runId=run-root-1） |
| 11 | VerifyRan | root | root verify pass（acceptanceIds=[A1,A2]） |
| 12 | VerdictSubmitted | root | exec-review pass → root closed |
| 13 | ReflectionRan | root | **手工构造**：root 反思记录（round=1, revisedSpec=false） |
| 14 | ReflectionRan | leaf | **手工构造**：leaf 反思记录（round=1, revisedSpec=false） |

### 关于 ReflectionRan

seq 13-14 的 ReflectionRan 事件为**手工构造**（非真实 cw 命令产出）。原因：
ReflectionRan 是 runner 反思钩子事件，由 `cw run` 循环内部长驻 spawn 的 followUp
机制产出，无法通过简单的 CLI 命令序列触发。手工构造严格遵循 `src/events/types.ts`
的 `ReflectionRanPayload` schema。

## 快照

`snapshots/` 目录包含四个只读命令的期望输出：

- `status.txt`：`cw status` 输出（两 unit 均 closed）
- `tree.txt`：`cw tree` 输出（root → leaf 树形结构）
- `frontier.json`：`cw frontier --json` 输出（全部维度空——两 unit 均已 closed）
- `report.txt`：`cw report` 输出（两 unit 的证据链汇总）

## 重建

```bash
npm run build
bash tests/fixtures/golden-ledgers/unit-basic/scripts/generate.sh
```

脚本在 `/tmp` 下创建临时 git 项目 + CW_HOME，跑完整 cw 命令序列后
将 events.log 和 snapshots 复制回本目录。

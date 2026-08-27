---
description: "spec 声明与交付核对（维度 C）。客观事实核对：spec 入账的验收条目 / contracts / split 声明的内容是否在交付 diff 中真实落地 + 分解树完整性。仅 harness 模式启用（$CW_HOME 下存在本项目根的 events.log 账本）。"
name: plan-completeness
---

# spec 声明与交付核对标准（Subagent C 用）

## 目的

本文档是 CW（coding-workflow）review 阶段的**客观事实核对标准**，供 Subagent C 使用。

与 Subagent A（项目约定）/ Subagent B（通用质量）不同，Subagent C 不做主观质量判断——
只做客观事实核对：**spec 声明的内容有没有在交付 diff 中真实落地**。

2.0 的「计划」不是存储态的计划树，而是随 `SpecSubmitted` 事件入账的 spec 声明
（`src/events/types.ts` 的 `SpecSubmittedPayload`：`acceptance: AcceptanceItem[]` /
`contracts: Contract[]` / `split: SplitEntry[]`，经 `specHash` 冻结）。本维度核对的就是
这份冻结声明与实际 git 交付之间的落差。

## 适用场景与启用条件

**仅 harness 模式启用**：`$CW_HOME/<encoded-cwd>/events.log` 存在（encoded-cwd = cwd
绝对路径中 `\ / .` 字符替换为 `__`，后接 `-` + 路径 sha256 前 8 位十六进制，
与 `src/store/project.ts` 的 `encodeCwd` 同源；探测顺序 = review-context.sh：
`CW_PROJECT_DIR` 环境变量 → git 结构推导的主仓根（worktree 场景账本 key 是主仓根
而非 worktree 根）→ git_root 自身）。
standalone（无账本上下文）时本维度被裁掉，无核对对象。

## 数据来源

| 数据 | 位置 | 说明 |
|------|------|------|
| spec 声明 | `$CW_HOME/<encoded-cwd>/events.log` 的 SpecSubmitted 事件（该 unit 最后一条为当前生效 spec） | `acceptance`（id / core / title / type / command / runner / layer）、`contracts`（provider / consumer / signature / file）、`split`（unitId / dependsOn / files） |
| 结构化投影 | `cw status --json`（只读命令，`src/readonly/status.ts`） | fold 投影的状态视图，可替代手工解析账本 |
| 项目状态账本 | `docs/rewrite/ledger.md` | cw 自身重写期的进行中波次权威 |
| 验收基线 | `docs/rewrite/acceptance/<unit>-acceptance.md` | cw 自身各 unit 的验收基线（审查 cw 自身交付时对照） |
| 实际交付 | `git diff main...HEAD --name-only`（或 `master` 降级） | 落地核对基准 |
| 证据产物 | `$CW_HOME/<encoded-cwd>/evidence/<unitId>/<runId>/`（`src/store/project.ts` 的 `evidenceDir` 布局） | EvidenceSubmitted 的 paths/sha256 指向的产物本体 |

判定结果分两档：**已落地 / 未落地（must_fix）**。

---

## Part 1: 验收条目落地核对（acceptance 声明 vs 交付 diff）

### 核对流程

1. **读当前生效 spec**：账本内该 unit 最后一条 SpecSubmitted 的 `acceptance` 数组
   （重提 spec = 新 `specHash` = 以最新声明为准）
2. **解析每条有 `command` 的条目**：从命令中提取引用的测试/脚本文件路径
   （如 `npx vitest run tests/foo.test.ts` → `tests/foo.test.ts`；`bash scripts/e2e-xxx.sh` → 脚本文件）
3. **对照实际交付**：声明的文件是否在 `git diff main...HEAD --name-only` 中（新增或修改）
4. **type 分层与实际位置相符性**：
   - `type: "unit"` / `"integration"` 的条目：命令应指向单测/集成测试文件（如 `tests/` 下
     vitest 用例）；声明指向 e2e 脚本 = 分层错位（记 should_fix）
   - `type: "e2e-real"` / `"e2e-mock"` 的条目：`command` 必非空（spec gate 规则③保证）；
     e2e-sh 适配器要求脚本 stdout 产出以验收 `id` 开头的标记行——核对 diff 中的脚本
     是否真的包含该 id 的标记输出（缺失 = 用例恒挂或恒真，记 must_fix）
   - `core: true` 的条目 type 必须为 e2e 级（规则②）——若账本中出现 core + unit 型组合，
     是 gate 漏网信号，记 must_fix 并注明「gate 漏网」

### 判定标准

| spec 声明（acceptance） | 实际交付（git diff / 脚本内容） | 判定 |
|-------------|--------------|------|
| 条目命令引用 `tests/foo.test.ts` | diff 含该文件 | **已落地** |
| 条目命令引用 `tests/foo.test.ts` | diff 不含该文件 | **未落地（must_fix）** |
| e2e 条目声明 id `A1`，命令指向脚本 | 脚本含 `A1` 标记行输出 | **已落地** |
| e2e 条目声明 id `A1`，命令指向脚本 | 脚本无 `A1` 标记行 | **未落地（must_fix）** |
| 条目声明改 3 个文件 | diff 只含其中 2 个 | **部分未落地（must_fix，缺失项单列）** |
| 命令无法解析出文件引用（如纯 CLI 调用） | — | 记「无法文件级核对」，转证据产物核对（evidence 目录），不臆断 |

**注意**：账本缺失该 unit、spec 未入账、git diff 异常时，对应条目记「无法核对」并说明原因，
不静默跳过也不臆断为已落地。

---

## Part 2: 声明修改文件落地核对（split.files + contracts.file）

### 核对流程

1. **SplitEntry.files**：内部节点 spec 的 split 条目可声明 `files`（预期触碰文件，文件冲突
   检查与受影响验收选择的输入）。逐条对照 diff——声明要碰的文件没出现在 diff 中，
   要么计划未执行，要么 files 声明过宽（后者记 should_fix）
2. **Contract.file**：契约条目声明签名应存在的文件（`src/events/types.ts` 的 `Contract.file`，
   缺省 = 集成时全树搜索）。核对 provider 交付中该文件是否真实出现且包含签名指向的实体
   （文件级核对即可，签名 hash 级比对是集成验证的职责，不重复）

---

## Part 3: 分解树完整性（split 闭环）

### 检查项

- **split 闭环**：spec.split 声明的每个 `unitId` 是否都有对应 UnitCreated 事件？
  split 列了但账本查不到 = 孤儿声明（must_fix）
- **深度上限**：`cw create` 限制分解深度 2 层（根 + 叶，`src/handlers/create.ts` 拒绝三层
  嵌套）——账本中出现三层链（孙 unit）= 不变式被破坏（must_fix）
- **split 自引用**：split 含自身 unitId 是 gate 规则⑥提交期拦截项；历史账本中若存在
  = 遗留缺陷，记 should_fix（新提交已被拦，不阻塞当前交付）
- **子 unit 进展**：split 声明的子 unit 是否至少到达 verified（`cw status --json` 投影）；
  长期停在 created 的子 unit 记 should_fix

---

## Part 4: spec 设计观察（不阻塞，should_fix / info 级）

- **dependsOn 完整性**：split 条目的 `dependsOn` 是否覆盖实际顺序约束（W2 改的文件
  import W1 新建文件但未声明依赖 = 返工风险，should_fix）
- **范围合理性**：单个叶子 unit 的验收条目 + 触碰文件过多（>5 文件）建议拆分（should_fix）
- **layer 声明位置**：`layer: "topic"` 条目出现在 split 为空的 spec = 永无执行点的真空声明
  （规则⑩提交期拦截项；历史账本出现记 should_fix）

---

## 严重度与统一档位的对应

本文档保留 must_fix / should_fix 两档，因为 Subagent C 做的是**客观事实核对**
（落地/未落地是二元事实），不像 A/B 维度做主观质量分级。它与统一档位的对应关系：

| 本文档档位 | 对应统一档位 | 含义 |
|-----------|-------------|------|
| must_fix | MUST_FIX | spec 声明的内容未落地，客观缺失 |
| should_fix | SUGGESTION | spec 设计有改进空间（依赖/范围/遗留形态），不阻塞 |

聚合器（review-aggregator.md）合并报告时，must_fix 计入 MUST_FIX 总数，should_fix 计入 SUGGESTION 总数。

## 输出格式

核对结果记入编排器指定的维度报告路径（如 `.review/run-<runId>/plan-completeness.md`），
按下面的「spec 落地核对」段格式：

```markdown
## spec 落地核对（Subagent C）

### 验收条目落地率
- 总条目数：N
- 已落地：M
- 未落地：K
- 无法核对：J（注明原因）
- **落地率：M/N = XX%**

### 未落地清单（must_fix）
| unit | spec 声明 | 缺失内容 | 严重度 |
|------|----------|---------|--------|
| u5b | e2e 条目 A1 指向 scripts/e2e-run.sh | 脚本无 A1 标记行输出 | must_fix |
| w4 | acceptance 引用 tests/w4-grep-ac.test.ts | diff 不含该文件 | must_fix |

### 分解树问题
| 类型 | unit | 问题 | 严重度 |
|------|------|------|--------|
| 孤儿声明 | root | split 声明 unitId "w9" 无 UnitCreated | must_fix |
| 漏依赖 | w2 | 改的文件 import w1 新建文件，dependsOn 未声明 | should_fix |
```

## 返回值（stdout JSON）

```json
{ "report_file": "<维度报告绝对路径>", "must_fix": N, "suggestion": N, "info": N }
```

字段与 review-aggregator.md 的聚合统计约定一致。

---

## 分工边界（重要）

本文档**只审 spec 声明与交付的事实落差**。以下不在本文档范围：

| 不审的内容 | 谁来审 |
|-----------|--------|
| 代码类型安全、错误处理、边界条件 | Subagent B（读 quality-criteria.md） |
| 项目特定约定（状态机 / Gate / CLI 契约 / 双域隔离） | Subagent A（读 project-conventions.md） |
| 代码实现质量（即使文件落地了，写得对不对） | Subagent B（文件落地只代表"改了"，不代表"改对了"） |

Subagent C 的边界：**只回答"spec 声明的用例、命令、文件有没有落地 + 分解树完整不完整"**，
不回答"落地了但实现质量如何"。

**重叠裁决**：同一缺陷最多被一个维度报告。全局优先级为 **C > A > B**，C（spec 落地）
优先级最高——因为 spec 落地是客观事实核对（文件在不在、条目做没做），最确定。
当问题同时符合 C 和 A/B 时归 C。详见 review-aggregator.md 的去重规则。

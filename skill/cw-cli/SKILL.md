---
name: cw-cli
description: >-
  Use when the user says "编码流程", "coding workflow", "开始编码", "走 CW",
  "建 topic", "create topic", "开发功能", or wants to start/advance a structured
  coding task through the cw CLI state machine. 唯一入口：bash 调 `cw create`，
  之后按返回的 nextAction.guidance 驱动全流程（create→plan→dev→test→retrospect→closeout）。
  guidance 内嵌完整阶段提示词（spec/plan/execute 方法论），不需读外部文档。
  Not for pure planning without CW. Not for design-only. 不适合纯分析/调研/设计任务——
  只有要写代码+测试的编码任务才用 CW，否则不要 cw create（会留下无意义的废弃 topic）。
---

# CW CLI（编码流程编排器）

> **唯一入口：`cw create`。** 不需要记忆任何 action 列表。
> create 之后，CLI 返回的 `nextAction.guidance` 携带完整阶段提示词（如何做 spec / 如何写 plan / 如何 execute），
> agent 按 guidance 一步步推进，直到 `nextAction.action` 为空（流程结束）。

## 什么时候该 create / 不该 create

| 场景 | 判断 | 原因 |
|------|------|------|
| 用户说"开发登录页面"、"加个导出功能" | ✅ create | 有明确目标，要写代码 + 测试 |
| 用户说"帮我分析这段架构" | ❌ 不 create | 纯分析，无代码产出，CW 的 wave/testCase 无内容可填 |
| 用户说"改个 typo"、"修一行" | ❌ 不 create | 流程开销 > 收益 |
| 用户说"调研一下 XX 方案可不可行" | ❌ 不 create | 目标不明确，无法拆 wave。先调研清楚再决定 |

**判断标准**：如果你不会走完 plan → dev → test → closeout，就不要 create。废弃 topic 污染 stats 聚合数据。

## 核心铁律

[强制] **只暴露一个入口**：只需调 `cw create`，后续全靠 `nextAction` 驱动。不记忆 action 列表。

[强制] **guidance 是唯一导航**：每次 `cw` 返回的 `nextAction.guidance` 含完整方法论（不只是"下一步调什么"，还包括"怎么做"）。按 guidance 走，不自决下一阶段。

[强制] **通过 bash 调 `cw` 命令**：agent 用 bash 工具执行 `cw <action> [flags]`，读 stdout 的 JSON。不假设有 tool 注册机制（CW 是 agent-agnostic CLI）。

[强制] **create 即承诺走完全流程**：`cw create` 后，从 plan 到 closeout 的所有编码工作必须通过 cw 命令推进。不要 create 之后用 agent harness 的 plan mode / EnterPlanMode 绕过 CW 流程——CW 有自己的 plan 阶段（cw plan），两者不兼容。发现任务不适合走 CW 时，和用户确认后放弃 topic，不要静默跳过。

## 唯一入口

```bash
cw create --slug <kebab-case-slug> --objective "<一句话业务目标>"
```

返回 JSON 含 `topicId` + `nextAction`。**记下 topicId**，后续所有调用都要传。

### 运行环境（评估分组维度，可选）

`cw create` 会自动注入运行环境元数据（agent + llm + cwVersion），用于评估指标按分组对比。默认值 `Pi / GLM-5.2`，覆盖日常场景。

切环境时两种覆盖方式（优先级：命令行 > env.json > 默认值）：

```bash
# 方式 1：命令行参数（临时覆盖）
cw create --slug <slug> --objective "<obj>" --agent "Claude Code" --llm "Sonnet-4.5"

# 方式 2：env.json（持久默认，与 _cw.json 同目录）
# ~/.cw/<encoded-cwd>/env.json
{ "agent": "Claude Code", "llm": "Sonnet-4.5" }
```

cwVersion 始终从 package.json 自动读取，不可手动指定。

## 推进流程（按 nextAction 驱动）

每次 `cw` 调用返回 `nextAction`：

```json
{
  "topicId": "cw-2026-07-11-xxx",
  "status": "planned",
  "nextAction": {
    "action": "tdd_plan",
    "guidance": "plan gate 通过。下一步：...\n\n[tdd_plan 阶段]...",
    "waves": [{ "id": "W1", "committed": false }],
    "testCases": [{ "id": "U1", "status": "pending" }],
    "alternatives": [{ "action": "replan", "guidance": "如需修改计划..." }]
  }
}
```

**ALWAYS 按 `nextAction.action` 调下一次 `cw`**。`action` 为空（undefined）= 流程结束（closed 终态）。

`alternatives` 是当前状态下**同样合法**的可选 action（不是错误处理路径）。`action` 是主推荐，`alternatives` 是补充——当场景需要时（如 dev 中途发现 plan 要追加 Wave）走 `alternatives`。

### 9 阶段流程

```
create → clarify → plan → tdd_plan → dev → review → test → retrospect → closeout
```

| nextAction.action | 你要做的 | cw 命令 |
|-------------------|---------|---------|
| `clarify` | 探索技术系统 + 澄清需求/技术 spec + 记录 ADR（advisory，可跳过） | `echo '<clarifyJson>' \| cw clarify --topicId <id>` |
| `plan` | 明确范围后产出 **dev-plan.json**（只含 waves），提交 | `echo '<devPlanJson>' \| cw plan --topicId <id>` |
| `tdd_plan` | 写测试代码（红灯）+ **test.json**（testCases + expected），提交 | `echo '<testJson>' \| cw tdd_plan --topicId <id>` |
| `dev` | 按 Wave 写实现让测试转绿，commit，提交 | `cw dev --topicId <id> --tasks '[{"waveId":"W1","commitHash":"<sha>"}]'` |
| `review` | 做 code review，产出 review.md + 结构化问题清单（stdin） | `echo '<issuesJson>' \| cw review --topicId <id> --reviewPath <path>` |
| `review_fix` | 修复 review 发现的 issue，提交修复审计 | `echo '<fixesJson>' \| cw review_fix --topicId <id>` |
| `test` | 跑测试，提交 actual 结果 | `cw test --topicId <id> --cases '[{"caseId":"U1","actual":{"text":"<结果>"}}]'` |
| `test_fix` | 修复 test 失败的 case，提交修复审计 | `echo '<fixesJson>' \| cw test_fix --topicId <id>` |
| `retrospect` | 写复盘报告（retrospect.md）+ 结构化回顾数据（retrospectData），提交 | `echo '<retrospectDataJson>' \| cw retrospect --topicId <id> --retrospect-path <path>` |
| `closeout` | 归档 topic，返回 evidence（coverage + gateHistory） | `cw closeout --topicId <id>` |
| `replan` | 修改计划（--plan 改 dev-plan / --test 改 test.json） | `echo '<devPlanJson>' \| cw replan --topicId <id> --plan` 或 `cw replan --topicId <id> --test --testJsonFile <path>` |
| `undefined` | 流程结束 | 无 |
| `assess`（人工） | closeout 后提交交付质量评估（post-closeout，不在 nextAction 导航里） | `cw assess --topicId <id> --type quality --score 4 --notes "..."` |

> 各阶段的详细方法论（如何写 dev-plan.json、如何做 clarify + ADR、如何 TDD 红灯、如何复盘、replan 的 append-only 约束等）**全部内嵌在 guidance 里**，按 nextAction 走即可获得，无需在此重复。

## gate fail 时怎么办

gate fail 时 `nextAction.action` **指回当前 action**（retry），不是下一阶段。看返回里的失败原因字段：

| 场景 | fail 原因在哪 | 怎么修 |
|------|-------------|--------|
| plan/tdd_plan/retrospect/closeout gate fail | 顶层 `mustFix` | 修 mustFix 列出的问题，重调同一 action |
| review 发现 issue（issues 非空） | `reviewIssues` | 进 review_fix：修代码 → `cw review_fix` → 复查 |
| dev gate fail（commit 不真实/缺失） | `taskResults[].reason` | 修该 Wave 的 commit，重调 `cw dev` |
| test gate fail（结果 != 预期） | `caseResults[].failureReason` | 进 test_fix：修代码 → `cw test_fix` → 重跑 test |

## post-closeout 评估（assess）

closeout 后（status=closed），设计者可手动调 `cw assess` 提交交付质量评估。**不在 nextAction 导航里**——流程主链路在 closeout 后即结束，assess 是人工触发的数据追加。

**特点**：
- progressive：可多次调用，每次追加一条评估记录（AS1, AS2...），不改 status（始终 closed）
- 不走 gate 机制（不写 gateHistory），纯数据追加
- 不进任何 guidance（closeout 的 nextAction 只提一句"可调 cw assess"）

**四种评估类型**（`--type`）：

| type | 用途 | 必填字段 |
|------|------|---------|
| `quality` | 代码质量评估（结构/类型安全/可读性） | notes（+ 可选 score 1-5） |
| `test` | 测试质量评估（覆盖率/有效性/边界） | notes（+ 可选 score 1-5） |
| `stability` | 稳定性评估（并发/异常/资源） | notes（+ 可选 score 1-5） |
| `defect` | 缺陷登记（校准 review 召回率的核心） | notes + `--defect`（severity/area/rootCause/foundInReview） |

**缺陷登记**（`type=defect`）是评估体系的核心——`foundInReview` 标记该缺陷在 review 阶段是否已被发现，积累后可算 review 召回率 = review 发现的缺陷 / 总缺陷。

```bash
# 简单评估
cw assess --topicId <id> --type quality --score 4 --notes "代码结构清晰，类型安全到位"

# 缺陷登记（校准核心）
cw assess --topicId <id> --type defect --notes "并发场景下数据丢失" \
  --defect '{"severity":"major","area":"store.ts","rootCause":"边界遗漏","foundInReview":false}'
```

**`--defect` 字段说明**：

| 字段 | 说明 |
|------|------|
| `severity` | 缺陷严重度：`blocker` / `major` / `minor` |
| `area` | 涉及的模块/功能区域（如 "store.ts"） |
| `rootCause` | 根因分类（如 "边界遗漏" / "类型错误" / "需求理解偏差"） |
| `foundInReview` | review 阶段是否已发现该问题。`true`=review 抓到但没修干净 / `false`=review 完全漏了 |

## 前置检查

[MANDATORY] 启动 CW 前：

- **`cw` 命令可用**：`which cw` 能找到。未安装 → `npm install -g @zhushanwen/coding-workflow`
- **git 仓库已初始化**：`git rev-parse --git-dir` 能跑通（dev/test 需要真实 commit）
- **workspace 可写**：交付物（plan.json / retrospect.md）落在 `<cwd>/.xyz-harness/<slug>/`

## 项目文档基建诊断（cw init，可选）

`cw create` 之前可先调 `cw init` 检测项目文档基建。topic 之前的只读诊断命令，**不进状态机**（无 topic）。

[OPTIONAL] **何时调用**：首次在某个项目用 CW 时，或 `cw create` 的 guidance 提示文档基建未就绪时。

```bash
cw init
# → JSON：{ docRoot, mainConfig, docs: [...], ready }
```

`ready=true`（必备文档全 ok 且无 stale）时可直接进 `create` 流程。`docs` 数组里每项含 `status`（ok/missing/skeleton/stale）和 `skeleton`（缺失时附骨架内容）。agent 按用户确认用 write 工具补齐缺失项——**绝不覆盖已有文档**。

## 数据存储（cwd 隔离机制）

- 状态库：`~/.cw/<encoded-cwd>/_cw.json`（per-cwd 隔离，文件锁 + 原子写）
- 运行环境配置：`~/.cw/<encoded-cwd>/env.json`（可选，agent+llm 默认值覆盖）
- 可通过 `CW_HOME` 环境变量覆盖根目录（必须是绝对路径）
- topicId 格式：`cw-{date}-{slug}`
- 跨 session 接续：调 `cw list` 找 topicId，调 `cw status --topicId <id>` 看当前进度，再按 nextAction 继续

[强制] **cwd 隔离**：CW 按 `process.cwd()` 隔离 topic，不同 cwd 路径对应不同的 `_cw.json`。

| 场景 | 原因 | 修复 |
|------|------|------|
| 跨 worktree | `feat-xxx/` 和 `main/` 是不同 cwd | 在创建 topic 的 worktree 下调 cw |
| 跨子目录 | `project/` 和 `project/src/` 是不同 cwd | 回到创建 topic 时的目录 |
| **符号链接路径** | `process.cwd()` 解析 symlink 返回**物理路径**。通过符号链接进入与通过真实路径进入，产出不同的 `_cw.json`，topic 互不可见 | 始终用同一种路径访问同一项目 |

✅ 正例：始终从 `~/Code/proj-workspace/main` 调 cw（真实物理路径）
❌ 反例：有时从 `~/Stock/proj`（符号链接 → 同一目录）调 cw，`process.cwd()` 解析为不同路径，topic 消失

**排查**：`topic not found` 时，先 `cw list` 看当前 cwd 下有没有 topic，再 `node -p "process.cwd()"` 确认实际路径。

## 只读查询命令（不触发状态变更）

| 命令 | 用途 |
|------|------|
| `cw status --topicId <id>` | 查看单个 topic 进度快照（status/gatePassed/waves/testCases） |
| `cw list` | 列出当前 cwd 下所有 topic |
| `cw stats --topicId <id>` | 评估指标（复杂度分桶/过程效率/杠杆健康度） |
| `cw stats --all` | 跨 topic 聚合（按 RuntimeEnv 分组），用于跨 agent/llm 对比 |

## 失败模式

### illegal_transition（跳阶段）

❌ 反例：create 后直接调 `cw dev`（跳过 plan/tdd_plan）→ guard 拒绝（exit=1）
✅ 正例：create → 读 `nextAction.action` → 按 action 一步步走

修复：看 `cw status` 确认当前 status，按 nextAction 重来。

### gate 反复 fail

同一 action 连续 fail 5 次后 guidance 换熔断文案（不阻断，建议找用户人工审查）。

### topic not found

cwd 不对（跨 worktree/子目录/session/符号链接）。

❌ 反例：在 `feat-xxx/` worktree 创建 topic，切到 `main/` 后调 `cw status` → not found
✅ 正例：回到创建 topic 时的目录，或用 `cw list` 在当前 cwd 重新定位

修复：`cw list` 看当前 cwd 下有哪些 topic，`node -p "process.cwd()"` 确认实际路径。

## Self-Check

[MANDATORY] 以下全部满足才算 CW 流程走完：

- [ ] 从 `cw create` 开始，没有绕过状态机
- [ ] 每次 `cw` 调用后读 `nextAction`，按它的 `action` 调下一次
- [ ] dev 阶段所有 Wave committed（nextAction.waves 全 committed=true）
- [ ] test 阶段所有 testCase passed（nextAction.testCases 全 status=passed）
- [ ] closeout 后 `nextAction.action` 为空（终态）

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [强制] | 流程不可逾越的边界（机器层强制） | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
| [OPTIONAL] | 可选步骤。根据实际情况决定是否执行 | 可根据需求调整 |

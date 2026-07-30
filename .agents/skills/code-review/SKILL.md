---
name: code-review
description: >-
  审查代码变更。触发词："review"、"审查代码"、"code review"、
  "帮我看看代码"。仅用于 coding-workflow 项目。支持区分 pi/非 pi 环境，
  多 subagent 并行多维度审查（项目约定/通用质量/plan 落地），产出
  aggregated.md 供 cr-fix 修复。非 PR 场景的审查用本 skill；PR 级
  review→fix→push 流水线用 pr-cr-fix。
---

# Code Review

## 角色

本 skill 是 **coding-workflow 的审查编排器**（review orchestrator）。它不自己审代码，
而是协调一个多维度审查流程：

1. **检测环境**：跑 `review-context.sh`，得到 harness 模式、启用维度、变更文件
2. **派审查**：根据 harness 能力派多个 subagent 并行审查各维度（路径 A），或主 Agent
   串行自查（路径 B 降级）
3. **产出报告**：聚合各维度结果为 `aggregated.md`
4. **衔接修复**：建议用户用 `cr-fix` 修复（**本 skill 自己不改代码**——审查与修复分离）

**[MANDATORY] 审查与修复分离**：code-review 只产报告，不修代码。修复是 `cr-fix` 的职责。
即使发现 must-fix，也只报告 + 建议，不直接动手改。

## 项目特点

审查前先理解被审对象——CW 是什么：

- **纯逻辑引擎**：CW 是 agent-agnostic 的状态机 + gate，不含 UI / 数据库 / 网络请求。
  审查重点是逻辑正确性和类型安全，不涉及运行时环境
- **gate 是核心价值**：gate 检查防 AI 谎报，任何 gate 逻辑的弱化（加容差、跳过检查、
  丢失记录）都是严重回归
- **schema 是契约边界**：外部输入（`store.json` 等）必须经 schema 校验。schema 与内部
  类型不同步 = 契约破裂

## 审查维度（维度文件在 `skill/review-agents/`）

本 skill 不内嵌 checklist——各维度的判定标准已迁移到独立维度文件，编排器只负责按维度
派发/自查。维度分工：

| 维度 | 维度文件 | 关注点 |
|------|---------|--------|
| 项目约定（A） | `skill/review-agents/project-conventions.md` | CW 引擎特有约定：状态机正确性 / Gate 完备性 / 引擎类型边界 / CLI 契约 |
| 通用质量（B） | `skill/review-agents/quality-criteria.md` | 跨语言通用范式：类型安全 / 错误处理 / 边界条件 / 测试有效性 |
| plan 落地（C） | `skill/review-agents/plan-completeness.md` | 客观事实核对：plan 声明的 changes/files 有没有落地 + plan 设计正确性 |

维度 C（plan 落地）只在 **harness 模式**（cw 工作流目录下，有 store.json）启用；standalone
模式裁掉，只跑 A + B。

## Step 1：环境检测

```bash
bash skill/review-agents/review-context.sh
```

读取输出的 JSON，关注以下字段：

| 字段 | 含义 | 用途 |
|------|------|------|
| `harness_mode` | `harness` / `standalone` | 决定是否启用 plan-completeness 维度（harness 启用） |
| `dimensions` | 维度列表（如 `["project-conventions", "quality-criteria"]`） | 决定派/查哪些维度 |
| `files` | 变更文件列表（`git diff main...HEAD --name-only`） | 审查范围 |
| `git_root` | git 仓库根目录绝对路径 | subagent 的 cwd |

**subagent 能力判断**（重要）：`review-context.sh` 的 `subagent_capable` 字段固定为 `true`——
脚本无法可靠检测当前 harness 类型。真正的能力判断由 **本 skill 根据 harness 类型**决定：

- 当前 harness 支持 Task 工具派 subagent（zcode / pi）→ 走 **路径 A**（并行派 reviewer）
- 不支持 → 走 **路径 B**（主 Agent 串行自查，降级路径）

## Step 2：定位 diff

与 `pull-request` skill 一致的 diff 定位方式：

```bash
git diff main...HEAD --stat
git log main..HEAD --oneline
```

确认变更范围与 `review-context.sh` 的 `files` 一致。diff 范围传给各 reviewer（reviewer 在
自己的 cwd 下跑 `git diff main...HEAD`，编排器不预读 diff 喂给 reviewer，避免上下文截断）。

## Step 3：多维度审查

根据 Step 1 的能力判断，二选一。

### 路径 A：支持 subagent（zcode / pi）→ 并行派 reviewer

为 `dimensions` 列表里的**每个维度**派一个 `general-purpose` subagent，**并行启动**
（上限 5，3 个维度可一次性并行）：

```text
agent: "general-purpose"
cwd:   <review-context.sh 输出的 git_root>
task:
  1. read skill/review-agents/<dimension>.md
  2. 完全按该维度的审查标准，审查 git diff main...HEAD 的变更
  3. 把报告写到 .review/run-<runId>/<dimension>.md
     （runId = Date.now() 的秒数；若 .review/ 不便写则写到当前目录）
  4. 按该维度定义的输出格式返回，含 must_fix / suggestion / info 计数
```

`<dimension>` 依次取 `dimensions` 列表的每一项（`project-conventions` / `quality-criteria` /
`plan-completeness`）。

**全部 reviewer 完成后**，派**第 N+1 个**串行 aggregator（依赖各维度报告，不可并行）：

```text
agent: "general-purpose"
cwd:   <git_root>
task:
  1. read skill/review-agents/review-aggregator.md
  2. 按其步骤读取各维度报告（.review/run-<runId>/<dimension>.md），去重后
     写到 .review/run-<runId>/aggregated.md
  3. 返回 JSON：{ "report_file": "<绝对路径>", "must_fix": N, "suggestion": N, "info": N }
```

### 路径 B：不支持 subagent → 主 Agent 串行自查（降级路径）

当 harness 不支持派 subagent 时，主 Agent 自己依次审查：

1. 按 `dimensions` 列表顺序，主 Agent 依次 read 每个维度文件（`skill/review-agents/<dimension>.md`）
2. 按该维度的 checklist 逐项审查 `git diff main...HEAD` 的变更
3. 主 Agent 自己按 `review-aggregator.md` 的格式汇总成 `aggregated.md`（去重、计数、排序）

**[OPTIONAL] 此路径有确认偏差风险**：主 Agent 审查自己刚写的代码，容易放过自己的问题。
**优先建议用户切到支持 subagent 的 harness（zcode / pi）走路径 A**。若只能走路径 B，在
报告里标注「降级路径（主 Agent 自查，存在确认偏差风险）」。

## Step 4：输出 + 衔接修复

**报告落点**：`.review/run-<runId>/aggregated.md`（若 `.review/` 不便写则当前目录）。

向用户输出：

1. **Summary**：`must_fix` / `suggestion` / `info` 三档计数 + 参与维度列表 + 去重数
2. **问题清单表**：按 MUST_FIX > SUGGESTION > INFO 排序，列 `文件 / 行号 / 维度 / 描述 / 修复方向`

**衔接修复**（不自动修复）：

- 若 `must_fix > 0`：
  > 审查完成，发现 N 个 must-fix。用 cr-fix 修复（`cr-fix` 或「按 review 改」），
  > 报告在 `<aggregated.md 绝对路径>`。
- 若 `must_fix == 0`：审查通过，suggestion/info 可选修复。

**[MANDATORY] 不自动修复**：code-review 只审查。即使 must-fix 很明确，也只产报告 + 建议
`cr-fix`，不自己改代码（审查与修复分离，避免审查者既当裁判又当运动员）。

## Step 5（harness 模式可选）：更新 cw 工作流

若在 cw 工作流内（`harness_mode=harness`）且当前在 `exec-review` 阶段：

- 提示用户：审查结果可**手工**填入 cw 的 exec-review input（`ExecReviewJudgment` JSON）
- **[MANDATORY] 不自动调 cw 命令**：避免与 cw 状态机冲突。是否推进状态由用户用 cw-cli
  skill 决定

standalone 模式跳过本步。

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |

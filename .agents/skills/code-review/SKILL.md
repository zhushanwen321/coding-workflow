---
name: code-review
description: >-
  审查代码变更。触发词："review"、"审查代码"、"code review"、
  "帮我看看代码"。仅用于 coding-workflow 项目。按环境分流：pi + review-fix-loop
  可用 + 调用方要 review+fix 一体 → 走 review-fix-loop workflow（维度 agent 作 batchN）；
  否则多 subagent 并行多维度审查，产出 aggregated.md 供修复阶段使用。
  非 PR 场景的审查用本 skill；PR 级 review→fix→push 流水线用 pr-cr-fix。
---

# Code Review

## 角色

本 skill 是 **coding-workflow 的审查编排器**（review orchestrator）。它不自己审代码，
而是**检测环境后决定走哪条路**，协调多维度审查：

1. **检测环境**：判断 review-fix-loop workflow 是否可用 + 调用方意图 + subagent 能力
2. **分流**：
   - **路径 A**（pi + review-fix-loop 可用 + 调用方要 review+fix 一体）：给出 review-fix-loop 调用配方（维度 agent 作 batchN），workflow 内 review+fix+重审闭环
   - **路径 B**（subagent 可用，只要 review 报告 / 或无 review-fix-loop）：并行派 reviewer + aggregator，产 `aggregated.md`
   - **路径 C**（无 subagent）：主 Agent 串行自查（降级）
3. **衔接修复**：路径 A 由 workflow 闭环；路径 B/C 只产报告，修复统一走 `pr-cr-fix` 流水线（或按报告人工修复）

## 项目特点

审查前先理解被审对象——CW 是什么：

- **纯逻辑引擎**：CW 是 agent-agnostic 的状态机 + gate，不含 UI / 数据库 / 网络请求。审查重点是逻辑正确性和类型安全
- **gate 是核心价值**：gate 检查防 AI 谎报，任何 gate 逻辑的弱化（加容差、跳过检查、丢失记录）都是严重回归
- **schema 是契约边界**：外部输入（`store.json` 等）必须经 schema 校验

## 审查维度（维度文件在 `.agents/skills/code-review/review-agents/`）

各维度判定标准在独立文件，且**已带 frontmatter 是 pi agent**（可被 review-fix-loop 直接加载，正文作 reviewer system prompt）：

| 维度 | agent 文件 | 关注点 |
|------|-----------|--------|
| 项目约定（A） | `review-agents/project-conventions.md` | CW 引擎特有约定：状态机 / Gate / 类型边界 / CLI 契约（只审 src/） |
| 通用质量（B） | `review-agents/quality-criteria.md` | 跨语言通用范式：类型安全 / 错误处理 / 边界 / 测试 |
| plan 落地（C） | `review-agents/plan-completeness.md` | plan 声明的 changes/files 落地核对（仅 harness 模式） |

维度 C 只在 **harness 模式**（有 store.json）启用；standalone 裁掉，只跑 A + B。

## Step 1：环境检测 + 分流

```bash
bash .agents/skills/code-review/review-agents/review-context.sh
```

读取 JSON（`harness_mode` / `dimensions` / `files` / `git_root`）。然后按下列顺序判断走哪条路：

| 优先级 | 条件 | 走 |
|--------|------|-----|
| 1 | available_workflows 含 `review-fix-loop` **且** 调用方明确要 review+fix 一体（如 pr-cr-fix PR 流水线） | **路径 A** |
| 2 | 当前 harness 支持派 subagent（pi / zcode） | **路径 B** |
| 3 | 都不满足 | **路径 C** |

**调用方意图判断**：路径 A 仅当调用方 task 明确要"review+fix 闭环"时触发（典型是 pr-cr-fix 阶段 2）。用户直接说"review 代码"（只要报告，不要自动 fix）→ 即使 pi 环境也走路径 B。

## Step 2：定位 diff

```bash
git diff main...HEAD --stat
git log main..HEAD --oneline
```

确认变更范围与 `review-context.sh` 的 `files` 一致。

## Step 3：按分流执行

### 路径 A：review-fix-loop workflow（pi + 调用方要 review+fix 一体）

review-fix-loop 自带「多批并行 review → aggregate → fix → 重审直到 clean」。code-review 只负责给出**调用配方**——维度 agent（现已是 pi agent）作 batchN，review-fix-loop 直接加载它们，正文（审查 checklist）作 reviewer 的 system prompt。

调用方（主 agent）执行：

```text
workflow action:run name:review-fix-loop
args:
  targetType: git-diff
  target: main...HEAD
  batch1: .agents/skills/code-review/review-agents/project-conventions.md
  batch2: .agents/skills/code-review/review-agents/quality-criteria.md
  batch3: .agents/skills/code-review/review-agents/plan-completeness.md   # 仅 harness_mode=harness；standalone 删掉此行
  fixAgent: worker                                                         # 或调用方指定（pr-cr-fix 用 worker）
  autoCommit: false                                                        # 由 pr-cr-fix 阶段 3c 统一 push
```

**本路径的特性**：
- review-fix-loop 内部闭环（review+fix+重审），code-review **不再产 aggregated.md**——workflow 内部聚合
- 「审查与修复分离」原则在此路径**放宽**：由 review-fix-loop 在 workflow 内统一完成 review+fix。这是路径 A 的设计取舍（用循环收敛换一体化效率）
- 调用方（pr-cr-fix）拿到 workflow 结果后，跳过自己的 fix 阶段，直接验证 + 推 PR

> ⚠️ review-fix-loop 的精确行为（batchN 加载 agent.md 的方式、fix 改动范围、输出格式、收敛轮数）**依赖 workflow 工具描述，落地前建议实测一次**。若 workflow 执行异常，回退路径 B。

### 路径 B：subagent 并行 review（只要报告 / 或无 review-fix-loop）

为 `dimensions` 列表里**每个维度**派一个 `general-purpose` subagent，**并行启动**（上限 5）：

```text
agent: "general-purpose"
cwd:   <review-context.sh 输出的 git_root>
task:
  1. read .agents/skills/code-review/review-agents/<dimension>.md
  2. 完全按该维度的审查标准，审查 git diff main...HEAD 的变更
  3. 把报告写到 .review/run-<runId>/<dimension>.md
     （runId = Date.now() 秒数；若 .review/ 不便写则当前目录）
  4. 按该维度输出格式返回，含 must_fix / suggestion / info 计数
```

`<dimension>` 依次取 `dimensions` 列表。**全部 reviewer 完成后**，派**第 N+1 个**串行 aggregator（依赖各维度报告，不可并行）：

```text
agent: "general-purpose"
cwd:   <git_root>
task:
  1. read .agents/skills/code-review/review-agents/review-aggregator.md
  2. 按其步骤读取各维度报告去重，写到 .review/run-<runId>/aggregated.md
  3. 返回 JSON：{ "report_file": "<绝对路径>", "must_fix": N, "suggestion": N, "info": N }
```

### 路径 C：主 Agent 串行自查（无 subagent，降级）

1. 按 `dimensions` 顺序，主 Agent 依次 read 每个维度文件
2. 按该维度 checklist 逐项审查 `git diff main...HEAD`
3. 主 Agent 自己按 `review-aggregator.md` 格式汇总成 `aggregated.md`

**[OPTIONAL] 确认偏差风险**：主 Agent 审查自己刚写的代码易放过自己的问题。报告里标注「降级路径（主 Agent 自查，存在确认偏差风险）」。

## Step 4：输出 + 衔接修复

**路径 A**：review-fix-loop 闭环后，向调用方返回 workflow 结果（含 fix 状态）。code-review 本身不再输出报告。

**路径 B/C**：
- 报告落点：`.review/run-<runId>/aggregated.md`
- 输出 Summary（must_fix/suggestion/info 计数 + 维度 + 去重数）+ 问题清单表（按 MUST_FIX > SUGGESTION > INFO 排序）
- **[MANDATORY] 不自动修复**：即使 must-fix 明确，也只产报告（审查与修复分离；修复统一走 `pr-cr-fix` 流水线）

## Step 5（harness 模式可选）：更新 cw 工作流

若 `harness_mode=harness` 且当前在 `exec-review` 阶段：提示用户审查结果可手工填入 cw 的 exec-review input。**[MANDATORY] 不自动调 cw 命令**（避免与状态机冲突）。

---

## 标记说明

| 标记 | 含义 |
|------|------|
| `[MANDATORY]` | 流程强制要求 |
| `[OPTIONAL]` | 可选步骤 |

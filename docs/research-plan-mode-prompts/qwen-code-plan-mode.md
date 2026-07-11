# Qwen Code - Planning Mode 提示词调研

## 来源

- 仓库: QwenLM/qwen-code（Google gemini-cli 的 fork，阿里维护）
- commit hash: `6d3b3479fe1886acf48cbc3e24ad6ec6595479eb`
- clone 日期: 2026-07-11，已 pull 到最新
- 关键文件:
  - `packages/core/src/core/prompts.ts`（`getPlanModeSystemReminder()`，Google LLC license，继承自 gemini-cli）
  - `packages/core/src/tools/enterPlanMode.ts`（Qwen 自研）
  - `packages/core/src/tools/exitPlanMode.ts`（Qwen 自研）
  - `packages/core/src/config/approval-mode.ts`（Google LLC license）
  - `packages/cli/src/ui/hooks/useAutoAcceptIndicator.ts`（Google LLC license，Shift+Tab 循环）
  - `packages/cli/src/ui/commands/planCommand.ts`（Qwen 自研，`/plan` 命令）
  - `packages/core/src/core/permissionFlow.ts`（`isPlanModeBlocked()`，Google LLC license）
  - `packages/core/src/plan-gate/`（Qwen 自研，Plan Approval Gate 扩展）

源码为未 minified 的 TypeScript，无需 prettier 格式化。

---

## Planning Mode System Prompt

Qwen Code 的 plan mode 提示词**不是一个静态 system prompt**，而是由两部分组成：

1. **主 system prompt 中的一条规则**（常驻，见 `prompts.ts` 第 153 行 "Core Mandates" 章节）
2. **动态注入的 `<system-reminder>`**（仅当 `ApprovalMode === PLAN` 时注入，见 `getPlanModeSystemReminder()`）

### 1. 主 System Prompt 中的 Plan Mode 规则（常驻）

位于 `packages/core/src/core/prompts.ts` 第 153 行，作为 "Core Mandates" 的一条：

```
- **Plan before uncertain work:** If the task is not yet clear enough to safely execute, do not make small speculative edits. Continue read-only investigation, make a plan in the current mode, or ask clarifying questions. Do not enter plan mode or call enter_plan_mode on your own just because the task involves planning or complexity. Use plan mode only when the user explicitly asks you to switch to plan mode, has already enabled it, or confirms they want it.
```

### 2. Plan Mode System Reminder（进入 plan mode 后每轮动态注入）

完整文本如下（来自 `packages/core/src/core/prompts.ts` 第 862–899 行，`getPlanModeSystemReminder(planOnly = false)` 函数）。

> 注：模板中 `${ToolNames.READ_FILE}` → `read_file`，`${ToolNames.GREP}` → `grep_search`，`${ToolNames.GLOB}` → `glob`，`${ToolNames.ASK_USER_QUESTION}` → `ask_user_question`，`${ToolNames.EXIT_PLAN_MODE}` → `exit_plan_mode`（实际值见 `packages/core/src/tools/tool-names.ts`）。`planOnly` 分支：SDK 模式 / subagent 上下文用 `'directly'`，正常交互模式用 `by calling the exit_plan_mode tool, which will prompt the user to confirm the plan`。

#### 默认（交互模式，`planOnly = false`）渲染结果：

```
<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received (for example, to make edits).

## Iterative Planning Workflow

You are pair-planning with the user. Explore the code to build context, ask the user questions when you hit decisions you cannot make alone, and refine your plan incrementally.

### The Loop

Repeat this cycle until the plan is complete:

1. **Explore** — Use read-only tools (read_file, grep_search, glob) to read code. Look for existing functions, utilities, and patterns to reuse. For broader or ambiguous tasks, use multiple parallel exploration passes (directly or via agents when appropriate) to understand different parts of the codebase.
2. **Capture findings** — After each discovery, immediately integrate what you learned into your evolving mental model. Do not wait until the end to synthesize.
3. **Ask the user** — When you hit an ambiguity or decision you cannot resolve from code alone, use ask_user_question. Then go back to step 1.

### First Turn

Start by quickly scanning a few key files to form an initial understanding of the task scope. Then ask the user your first round of questions if any exist. Do not explore exhaustively before engaging the user.

### Asking Good Questions

- Never ask what you could find out by reading the code
- Batch related questions together (use multi-question ask_user_question calls)
- Focus on things only the user can answer: requirements, preferences, tradeoffs, edge case priorities
- Scale depth to the task — a vague feature request needs many rounds; a focused bug fix may need one or none

### Planning Principles

- Build a global understanding of how the relevant pieces fit together before deciding on local edits. Do not jump from the first relevant file straight into a plan when the task likely spans multiple files or behaviors.
- Design an implementation approach that fits the existing codebase rather than inventing a parallel pattern.
- Reference existing functions and utilities you found that should be reused, with their file paths.
- Include a verification section describing how to test the changes end-to-end.

### When to Converge

Your plan is ready when you have addressed all ambiguities and it covers: what to change, which files to modify, what existing code to reuse (with file paths), and how to verify the changes. Present your plan by calling the exit_plan_mode tool, which will prompt the user to confirm the plan. Do NOT make any file changes or run any tools that modify the system state in any way until the user has confirmed the plan.
</system-reminder>
```

#### `planOnly = true`（SDK / subagent 上下文）的差异

仅最后一段 "When to Converge" 的收尾句不同：

```
... Present your plan directly. Do NOT make any file changes or run any tools that modify the system state in any way until the user has confirmed the plan.
```

（"by calling the exit_plan_mode tool, which will prompt the user to confirm the plan" 被替换为 "directly"，因为 SDK 调用方和普通 subagent 没有交互式 exit-plan 流程。）

### 3. enter_plan_mode 工具描述（模型可见的工具 schema description）

位于 `packages/core/src/tools/enterPlanMode.ts` 第 40–49 行：

```
Use this tool only after the user explicitly asks to switch into plan mode or confirms they want plan mode. Entering plan mode is a privilege reduction, so it does not require user confirmation at execution time.

## When to Use This Tool
Use this tool when the user has opted into plan mode for a task that should be read-only while the plan is formed, such as multi-file changes, design choices, or ambiguous requirements.

## When NOT to Use This Tool
Do not use this tool just because a task involves planning, is complex, or requires investigation. In the current mode, you can still think, inspect files, ask clarifying questions, and present a plan without switching modes.

## Important
If plan mode seems helpful but the user has not asked for it, ask first. Do NOT use this tool if the user has explicitly asked you not to use plan mode.
```

### 4. exit_plan_mode 工具描述（模型可见的工具 schema description）

位于 `packages/core/src/tools/exitPlanMode.ts` 第 47–59 行：

```
Use this tool when you are in plan mode and have finished presenting your plan and are ready to code. This will prompt the user to exit plan mode.

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)
- The plan parameter MUST contain your actual plan content — empty strings will be rejected
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

## Examples
1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.
```

---

## 切换/退出 Planning Mode 机制

### Approval Mode 体系

Plan mode 是 5 种 approval mode 之一（`packages/core/src/config/approval-mode.ts`，Google LLC license）：

| ApprovalMode 枚举值 | 含义 |
|---|---|
| `PLAN = 'plan'` | 只读计划模式，禁止任何修改 |
| `DEFAULT = 'default'` | 每次操作都需用户确认 |
| `AUTO_EDIT = 'auto-edit'` | 自动批准 edit/info 类工具 |
| `AUTO = 'auto'` | LLM 分类器自动审批，风险操作拦截 |
| `YOLO = 'yolo'` | 全部自动批准，无确认 |

### 进入 Plan Mode 的 4 种方式

1. **Shift+Tab 循环**（`packages/cli/src/ui/hooks/useAutoAcceptIndicator.ts`）
   - 按 `APPROVAL_MODES` 数组顺序循环：`Plan → Default → Auto-Edit → Auto → YOLO → Plan`
   - Windows 上 Shift+Tab 与 Tab 不可区分，Tab 也可触发
   - 状态栏显示 `⏸ plan mode`

2. **`/plan` 斜杠命令**（`packages/cli/src/ui/commands/planCommand.ts`，仅 interactive 模式）
   - `/plan` — 进入 plan mode
   - `/plan <prompt>` — 进入 plan mode 并提交该 prompt
   - `/plan exit` — 退出 plan mode，恢复之前的 approval mode（通过 `config.getPrePlanMode()`）
   - 已在 plan mode 时 `/plan <prompt>` 仅提交 prompt

3. **`/approval-mode plan` 命令**（`packages/cli/src/ui/commands/approvalModeCommand.ts`）
   - 等价于显式设置 `config.setApprovalMode(ApprovalMode.PLAN)`

4. **模型主动调用 `enter_plan_mode` 工具**（`packages/core/src/tools/enterPlanMode.ts`）
   - 工具默认 permission 为 `allow`（降权操作不需确认）
   - **YOLO 模式下的 guard**：若 `userRequested !== true`（模型自作主张），在 YOLO 模式下是 no-op，返回提示让模型继续在当前模式规划或带 `userRequested: true` 重试（防止 YOLO 用户被静默切到只读模式，issue #5970）
   - **非交互模式 guard**：headless 非 ACP 模式无法进入（exit 路径需要用户交互）
   - 进入后：reveal `exit_plan_mode` deferred 工具，让模型能直接调用
   - `config.setApprovalMode(PLAN, { enteredByModel: true })` —— 标记为模型发起，影响后续 gate 路径

### 退出 Plan Mode 的机制

核心在 `exit_plan_mode` 工具（`packages/core/src/tools/exitPlanMode.ts`），有 3 条决策路径：

**Path A — 用户手动进入 plan mode（Shift+Tab / `/plan` / dialog）**
- `getDefaultPermission()` 返回 `'ask'`
- 弹出确认 UI（`ToolPlanConfirmationDetails`，标题 "Would you like to proceed?"）
- 4 种 outcome：
  - `RestorePrevious` → 恢复 `prePlanMode`
  - `ProceedAlways` → 切到 `AUTO_EDIT`
  - `ProceedOnce` → 切到 `DEFAULT`
  - `Cancel` → 留在 `PLAN`

**Path B — 模型主动进入 + prePlanMode 是 AUTO/YOLO（autonomous 流）**
- `getDefaultPermission()` 返回 `'allow'`（`enteredByModel === true` + `isAutonomousPrePlanMode(prePlanMode)`）
- **跑 Plan Approval Gate**（`packages/core/src/plan-gate/planApprovalGate.ts`，Qwen 自研的 LLM 评审 gate）
- Gate 返回 5 种 decision：`approved` / `blocked` / `needs_user` / `cap_escalation` / `unavailable`
- `blocked` 时把 findings 回传给模型让它修订重试；`cap_escalation` 升级到用户接管；`unavailable` 降级为用户确认

**Path C — Plan-required teammate 上下文**（subagent/team 场景）
- 走 leader agent 的 `requestPlanApproval()`，leader 可 reject 或 approve 并指定 targetMode

另外 `/plan exit` 命令直接调用 `config.setApprovalMode(config.getPrePlanMode())` 退出，不经过 `exit_plan_mode` 工具。

### Plan Mode 下的工具拦截

`isPlanModeBlocked()`（`packages/core/src/core/permissionFlow.ts`）定义：plan mode 下，除 `exit_plan_mode`、`enter_plan_mode`、`ask_user_question` 和 `info` 类确认外的所有工具调用都被拦截，返回 `getPlanModeSystemReminder()` 作为 function response，并标记 `TOOL_FAILURE_KIND_PLAN_MODE_BLOCKED`。

---

## 备注

### 提示词注入逻辑

1. **常驻规则**：主 system prompt（`prompts.ts` 第 153 行）始终告诉模型"不要自作主张进入 plan mode，只在用户明确要求时使用"。
2. **动态 reminder**：`packages/core/src/core/client.ts` 第 2277–2286 行，每次发送 user query 前检查 `config.getApprovalMode() === ApprovalMode.PLAN`，若是则把 `getPlanModeSystemReminder()` push 到 `systemReminders` 数组。SDK 模式或 subagent 上下文传 `planOnly = true`。
3. **拦截时再注入**：`packages/core/src/core/coreToolScheduler.ts` 第 2453 行，当 plan mode 拦截了一个非只读工具调用，把 reminder 作为该工具的 FunctionResponse 返回给模型，强化约束。
4. **ACP / headless 入口**：`packages/cli/src/acp-integration/session/Session.ts` 第 4400 行 和 `packages/cli/src/utils/nonInteractiveHelpers.ts` 第 141 行也在各自路径注入同一个 reminder。

### 与 gemini-cli plan mode 的关系

- `packages/core/src/core/prompts.ts`、`coreToolScheduler.ts`、`permissionFlow.ts`、`config/approval-mode.ts`、`cli/src/ui/hooks/useAutoAcceptIndicator.ts` 的 license header 都是 **Copyright 2025 Google LLC** —— 这些是 gemini-cli 原有代码，qwen-code fork 后保留。Plan mode 的核心骨架（ApprovalMode 枚举含 PLAN、Shift+Tab 循环、`getPlanModeSystemReminder()` 的只读约束文案 "Plan mode is active. The user indicated that they do not want you to execute yet..."）继承自 gemini-cli。
- **Qwen 的扩展**（license 为 "Copyright 2025 Qwen"）：
  - `enter_plan_mode` / `exit_plan_mode` 作为独立 declarative tools（gemini-cli 原本没有这两个工具，退出 plan mode 靠 UI 确认）
  - **Plan Approval Gate**（`packages/core/src/plan-gate/`）—— 一个 LLM-as-judge 的自动评审 gate，在模型自主进入 plan mode 且原模式是 AUTO/YOLO 时，自动审批或打回计划，无需用户交互。这是 qwen-code 的独有增强。
  - `userRequested` 参数 + YOLO guard（issue #5970）、`enteredByModel` discriminator（issue #5574）—— 这些是 qwen 针对 autonomous 场景补的防护。
  - Plan-required teammate（team/leader 场景的 plan 审批）也是 qwen 扩展。

### 关于 "gemini-cli 继承的 plan mode 提示词"

gemini-cli 原版的 plan mode system reminder 文本（即上面第 2 节的主体文案）在 qwen-code 中**已被显著扩展**：gemini-cli 原版更简短（主要就是 "Plan mode is active... MUST NOT make any edits..." 这段只读约束）；qwen-code 在此基础上加了大段 "Iterative Planning Workflow"（The Loop / First Turn / Asking Good Questions / Planning Principles / When to Converge），把 plan mode 从"只读约束"升级为"结构化迭代规划工作流"。由于本仓库是 qwen-code fork（非 gemini-cli 上游），无法在此直接比对 gemini-cli 原版逐字差异，但 license header 明确标注了文件来源为 Google LLC。

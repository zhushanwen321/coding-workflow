# Claude Code - Plan Mode 提示词调研

## 来源

- 仓库: anthropics/claude-code（GitHub 官方仓，commit `4ca97cc7b8dfc8668dd40b7f1fb2b4ad58ac7ae3`）
- **重要说明**：该 GitHub 仓库只包含文档、示例和 issue 管理脚本，**不含可执行源码**。Claude Code 的实际实现以 **Bun 编译的 Mach-O 原生二进制**形式分发（不再是历史上的 `cli.js` minified bundle）。
- 提取对象：本地安装的二进制
  - 路径：`~/.local/share/claude/versions/2.1.169`（通过 `~/.local/bin/claude` symlink 调用）
  - 版本：`2.1.169 (Claude Code)`
  - 文件类型：Mach-O 64-bit executable arm64，约 212 MB
  - 提取方法：`strings ~/.local/share/claude/versions/2.1.169`（JS bundle 以字符串常量形式嵌在二进制内）
  - 平台二进制 npm 包：`@anthropic-ai/claude-code-darwin-arm64` 等（由 `@anthropic-ai/claude-code` 的 postinstall 安装）

> 注：二进制里的变量名是 minified 的（如 `tI`、`iP3`、`uBK`），但所有面向模型的提示词文本和工具描述都是明文字符串，可完整还原。下文用「变量名 → 实际工具名」的方式标注。

### 变量名映射表（minified 标识符 → 实际工具/常量）

| minified 变量 | 实际值 | 含义 |
|---|---|---|
| `wl` | `"EnterPlanMode"` | 进入 plan mode 的工具名 |
| `tI` / `xk` / `M0` | `"ExitPlanMode"` | 退出 plan mode 的工具名 |
| `OT` | `"AskUserQuestion"` | 向用户提问的工具名 |
| `ND` | `"Edit"` | 文件编辑工具（FileEdit） |
| `RJ` / `V1` | `"Write"` | 文件写入工具（FileWrite） |
| `X9` | `"Read"` | 文件读取工具 |
| `P9` | `"Agent"` | 子 agent 调用工具 |
| `LK` | `"Edit"` | 同 ND |
| `SR` | `"NotebookEdit"` | Jupyter notebook 编辑工具 |
| `bA` | `"ToolSearch"` | 延迟加载工具的搜索工具 |
| `V9H` | `{ agentType: "Explore", ... }` | 探索型子 agent 定义 |
| `dC6` | `{ agentType: "Plan", ... }` | 规划型子 agent 定义 |

---

## Plan Mode System Prompt

Claude Code 的 plan mode 系统提示词**不是单段静态字符串**，而是由 `lP3(H)` 函数根据上下文**动态拼接**的 `<system-reminder>` 消息（作为 user 角色的 meta 消息注入到对话流），每轮都会重新评估并按需注入。共有 **4 个变体**：

1. **Full reminder（`reminderType: "full"`）** — 主流程，5 阶段工作流，首次进入或每隔 N 轮注入
2. **Sparse reminder（`reminderType: "sparse"`）** — 精简版，中间轮次注入，避免重复占 token
3. **Subagent（`isSubAgent: true`）** — 子 agent 在 plan mode 下的简化约束
4. **Custom instructions（`customInstructions` 非空）** — 用户自定义 plan 流程时替换标准 5 阶段

另外有两个相关附件消息：
- **`plan_mode_reentry`** — 重新进入 plan mode（之前退出过，plan 文件已存在）时注入
- **`plan_mode_exit`** — 退出 plan mode 后注入一次

### 基础约束（所有变体共享的开头）

变量 `uBK`（full/subagent 主流程的开头句）：

```
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.
```

变量 `Ue8`（子 agent 变体用的开头，更严格，连 plan 文件例外都没有）：

```
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received (for example, to make edits). Instead, you should:
```

### 变体 1：Full Reminder（标准主流程，函数 `iP3(H)`）

注入条件：主 agent（非 subagent）且 `reminderType === "full"`。动态变量：
- `H.planFilePath` — plan 文件绝对路径（如 `~/.claude/plans/<slug>.md`）
- `H.planExists` — plan 文件是否已存在
- `ND.name` → `Edit`，`RJ.name` → `Write`，`tI.name` → `ExitPlanMode`，`OT` → `AskUserQuestion`
- `V9H.agentType` → `Explore`，`dC6.agentType` → `Plan`
- `EBK()` → Explore agent 最大并发数（默认 3，max/enterprise/team 套餐为 3，否则 1；可由 `CLAUDE_CODE_PLAN_V2_EXPLORE_AGENT_COUNT` 环境变量覆盖）
- `vBK()` → Plan agent 最大并发数（默认 1，max20x/enterprise/team 为 3；可由 `CLAUDE_CODE_PLAN_V2_AGENT_COUNT` 覆盖）

完整文本（`${...}` 为运行时插值，下方用占位符标注；`uBK` 为上面的基础约束句）：

```
{uBK}

## Plan File Info:
{若 planExists: "A plan file already exists at {planFilePath}. You can read it and make incremental edits using the Edit tool."
 否则:        "No plan file exists yet. You should create your plan at {planFilePath} using the Write tool."}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow
### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the Explore subagent type.
1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.
2. **Launch up to {EBK()} Explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - {EBK()} agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigating testing patterns
### Phase 2: Design
Goal: Design an implementation approach.
Launch Plan agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.
You can launch up to {vBK()} agent(s) in parallel.
**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)
{若 vBK()>1，追加：
- **Multiple agents**: Use up to {vBK()} agents for complex tasks that benefit from different perspectives
Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches
Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture
}
In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan
### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use AskUserQuestion to clarify any remaining questions with the user

### Phase 4: Final Plan
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Name the critical files to be modified. For changes that repeat a pattern across many files, describe the pattern once and list a few representative paths — do not enumerate every file or line number
- Reference existing functions and utilities you found that should be reused, with their file paths
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call ExitPlanMode
{mBK() 输出，见下方「Phase 5 收尾指令」}
NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the AskUserQuestion tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
```

> 注：源码里 Phase 编号是 1→2→3→5（跳过 4 作为独立段落，Phase 4「Final Plan」的实际文本由变量 `nP3` 单独定义并插在 Phase 3 之后、Phase 5 之前）。上面按语义顺序排列。

### Phase 5 收尾指令（函数 `mBK()`）

```
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ExitPlanMode to indicate to the user that you are done planning.
This is critical - your turn should only end with either using the AskUserQuestion tool OR calling ExitPlanMode. Do not stop unless it's for these 2 reasons
**Important:** Use AskUserQuestion ONLY to clarify requirements or choose between approaches. Use ExitPlanMode to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ExitPlanMode.
```

### 变体 2：Sparse Reminder（精简版，函数 `rP3(H)`）

注入条件：主 agent 且 `reminderType === "sparse"`（中间轮次，避免每轮重复完整 5 阶段说明）。`H.customInstructions` 决定引用哪段工作流。

```
Plan mode still active (see full instructions in conversation). Read-only except plan file ({planFilePath}). {若 customInstructions: "Follow the plan workflow described earlier." 否则: "Follow 5-phase workflow."} End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for plan approval). Never ask about plan approval via text or AskUserQuestion.
```

> Full vs Sparse 的轮次策略：由 `Y9q.FULL_REMINDER_EVERY_N_ATTACHMENTS` 控制，`(已注入的 plan_mode 计数 + 1) % N === 1` 时为 full，否则 sparse。另外若距上次 plan_mode 附件的 user 轮数 < `Y9q.TURNS_BETWEEN_ATTACHMENTS`，则本轮完全不注入（省 token）。

### 变体 3：Subagent（子 agent 在 plan mode，函数 `oP3(H)`）

注入条件：`isSubAgent === true`（当前是 Agent 工具派生的子 agent）。子 agent 不能调用 ExitPlanMode，约束更严格。

```
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received (for example, to make edits). Instead, you should:
## Plan File Info:
{若 planExists: "A plan file already exists at {planFilePath}. You can read it and make incremental edits using the Edit tool if you need to."
 否则:        "No plan file exists yet. You should create your plan at {planFilePath} using the Write tool if you need to."}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.
Answer the user's query comprehensively, using the AskUserQuestion tool if you need to ask the user clarifying questions. If you do use the AskUserQuestion, make sure to ask all clarifying questions you need to fully understand the user's intent before proceeding.
```

### 变体 4：Custom Instructions（用户自定义流程）

注入条件：`H.customInstructions`（即 `options.planModeInstructions`）非空。此时用用户提供的流程文本替换标准 5 阶段，但保留基础约束、Plan File Info 和 Phase 5 收尾指令。

```
{uBK}

## Plan File Info:
{同变体1的 planExists 分支，但措辞与变体3一致，允许 "if you need to"}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.
## Plan Workflow
{H.customInstructions —— 用户自定义的流程文本}
### Call ExitPlanMode
{mBK()}
```

### 重新进入 Plan Mode（附件 `plan_mode_reentry`）

注入条件：之前退出过 plan mode（`g3_()` 为 true）且 plan 文件已存在，再次进入时注入一次。

```
## Re-entering Plan Mode
You are returning to plan mode after having previously exited it. A plan file exists at {planFilePath} from your previous planning session.
**Before proceeding with any new planning, you should:**
1. Read the existing plan file to understand what was previously planned
2. Evaluate the user's current request against that plan
3. Decide how to proceed:
   - **Different task**: If the user's request is for a different task—even if it's similar or related—start fresh by overwriting the existing plan
   - **Same task, continuing**: If this is explicitly a continuation or refinement of the exact same task, modify the existing plan while cleaning up outdated or irrelevant sections
4. Continue on with the plan process and most importantly you should always edit the plan file one way or the other before calling ExitPlanMode
Treat this as a fresh planning session. Do not assume the existing plan is relevant without evaluating it first.
```

### 退出 Plan Mode 后（附件 `plan_mode_exit`）

注入条件：plan mode 刚结束（用户批准/拒绝了 ExitPlanMode，或手动退出），注入一次用于衔接。相关 UI/反馈文本（来自 plan 审批结果渲染）：

- 批准（无反馈）：`[Plan Approved] You can now proceed with implementation`
- 批准（带反馈）：`[Plan Approved] {feedback}`
- 批准后衔接语：`You can now proceed with implementation. Your plan mode restrictions have been lifted.`
- 拒绝（默认）：`[Plan Rejected] Please revise your plan`
- 拒绝（带反馈）：`[Plan Rejected] {feedback}`
- 拒绝后衔接语：`Please revise your plan based on the feedback and call ExitPlanMode again.`

---

## ExitPlanMode 工具

### 工具定义（minified 名 `tI`，name 常量 `xk = "ExitPlanMode"`）

| 属性 | 值 |
|---|---|
| `name` | `ExitPlanMode` |
| `searchHint` | `"present plan for approval and start coding (plan mode only)"` |
| `description()` | `"Prompts the user to exit plan mode and start coding"` |
| `shouldDefer` | `true`（延迟加载，需 ToolSearch 先加载 schema） |
| `isReadOnly()` | `false`（会改变 mode 状态） |
| `isConcurrencySafe()` | `true` |
| `requiresUserInteraction()` | `true`（非 teammate 场景需用户交互） |
| `isEnabled()` | teammate 数 > 0 且 `F8()` 时禁用，否则启用 |

**输入 schema**（`HfK`）：

```jsonc
{
  "allowedPrompts": [             // optional —— 实现该 plan 所需的权限类别（语义描述，非具体命令）
    {
      "tool": "Bash",             // enum: 目前只有 "Bash"
      "prompt": "run tests"       // 语义描述，如 "run tests"、"install dependencies"
    }
  ]
  // .passthrough() —— 允许额外字段
}
```

**内部增强 schema**（`ZAY`，由 `normalizeToolInput` 从磁盘注入，不暴露给模型）：

```jsonc
{
  "allowedPrompts": [...],
  "plan": "string (optional)",       // plan 文件内容（从磁盘读取注入）
  "planFilePath": "string (optional)" // plan 文件路径（注入）
}
```

**输出 schema**（`utO`）：

```jsonc
{
  "plan": "string | null",              // 展示给用户的 plan 内容
  "isAgent": "boolean",                 // 是否在 teammate 上下文
  "filePath": "string (optional)",      // plan 文件保存路径
  "hasTaskTool": "boolean (optional)",  // 当前上下文是否有 Agent 工具
  "planWasEdited": "boolean (optional)",// 用户是否编辑过 plan（CCR web UI 或 Ctrl+G）
  "awaitingLeaderApproval": "boolean (optional)", // teammate 场景：等待 team lead 审批
  "requestId": "string (optional)"      // plan 审批请求 ID
}
```

### ExitPlanMode 工具描述（prompt，变量 `njK`）

完整明文（这是注入给模型的工具描述）：

```
Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

## Examples
1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.
```

### ExitPlanMode 关键行为（从 `call()` 实现还原）

1. **校验**（`validateInput`）：非 teammate 场景下，若当前 mode ≠ `"plan"` 则拒绝，提示 `You are not in plan mode. To enter plan mode, call the EnterPlanMode tool first. If your plan was already approved, continue with implementation.`（遥测事件 `tengu_exit_plan_mode_called_outside_plan`）
2. **权限**（`checkPermissions`）：非 teammate 场景 `behavior: "ask"`，弹「Exit plan mode?」确认；teammate 场景直接 `allow`
3. **持久化 plan**：若输入带 `plan` 字段（CCR web UI 编辑过），写入 plan 文件
4. **Teammate 审批分支**：若是 teammate（`vz() && df_()`），读取 plan 文件，向 team-lead 发送 `plan_approval_request`，返回 `awaitingLeaderApproval: true`
5. **Mode 切换**：从 `plan` 切回 `prePlanMode`（进入 plan 前的模式，通常 `default`，也可能是 `auto`）。若 `prePlanMode === "auto"` 但 auto-mode gate 关闭，降级回 `default` 并通知
6. **权限上下文更新**：切到 auto mode 时 `stripDangerousPermissionsForAutoMode`；切到 default 时若之前剥离过危险规则则 `restoreDangerousPermissions`
7. **退出后注入** `plan_mode_exit` 附件（见上）

---

## EnterPlanMode 工具（配套，minified 名 `ch6`，name 常量 `wl = "EnterPlanMode"`）

Plan mode 的入口工具。Claude 在判断任务复杂、需要先规划时主动调用，请求用户同意进入 plan mode。

| 属性 | 值 |
|---|---|
| `name` | `EnterPlanMode` |
| `searchHint` | `"switch to plan mode to design an approach before coding"` |
| `description()` | `"Requests permission to enter plan mode for complex tasks requiring exploration and design"` |
| `shouldDefer` | `true` |
| `isReadOnly()` | `true` |
| `isConcurrencySafe()` | `true` |
| `isEnabled()` | teammate 数 > 0 且 `F8()` 时禁用 |

**输入 schema**（`ktO`）：`k.strictObject({})` —— 无参数。

**输出 schema**（`NtO`）：`{ message: string }`，描述「Confirmation that plan mode was entered」。

### EnterPlanMode 工具描述（prompt，函数 `htO()` / `FjK()`）

完整明文（`LtO()` 是其中「What Happens in Plan Mode」小节，运行时插值 `${OT}` → `AskUserQuestion`、`${M0}` → `ExitPlanMode`、`${sO}`/`${O5}`/`${X9}` → 搜索/读取工具名）：

```
Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool
**Prefer using EnterPlanMode** for implementation tasks unless they are simple. Use it when ANY of these conditions apply:
1. **New Feature Implementation**: Adding meaningful new functionality
   - Example: "Add a logout button" - where should it go? What should happen on click?
   - Example: "Add form validation" - what rules? What error messages?
2. **Multiple Valid Approaches**: The task can be solved in several different ways
   - Example: "Add caching to the API" - could use Redis, in-memory, file-based, etc.
   - Example: "Improve performance" - many optimization strategies possible
3. **Code Modifications**: Changes that affect existing behavior or structure
   - Example: "Update the login flow" - what exactly should change?
   - Example: "Refactor this component" - what's the target architecture?
4. **Architectural Decisions**: The task requires choosing between patterns or technologies
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling
   - Example: "Implement state management" - Redux vs Context vs custom solution
5. **Multi-File Changes**: The task will likely touch more than 2-3 files
   - Example: "Refactor the authentication system"
   - Example: "Add a new API endpoint with tests"
6. **Unclear Requirements**: You need to explore before understanding the full scope
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Fix the bug in checkout" - need to investigate root cause
7. **User Preferences Matter**: The implementation could reasonably go multiple ways
   - If you would use AskUserQuestion to clarify the approach, use EnterPlanMode instead
   - Plan mode lets you explore first, then present options with context

## When NOT to Use This Tool
Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research/exploration tasks (use the Agent tool with explore agent instead)

## What Happens in Plan Mode
In plan mode, you'll:
1. Thoroughly explore the codebase using {搜索工具}
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use AskUserQuestion if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

## Examples
### GOOD - Use EnterPlanMode:
User: "Add user authentication to the app"
- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)
User: "Optimize the database queries"
- Multiple approaches possible, need to profile first, significant impact
User: "Implement dark mode"
- Architectural decision on theme system, affects many components
User: "Add a delete button to the user profile"
- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates
User: "Update the error handling in the API"
- Affects multiple files, user should approve the approach

### BAD - Don't use EnterPlanMode:
User: "Fix the typo in the README"
- Straightforward, no planning needed
User: "Add a console.log to debug this function"
- Simple, obvious implementation
User: "What files handle routing?"
- Research task, not implementation planning

## Important Notes
- This tool REQUIRES user approval - they must consent to entering plan mode
- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work
- Users appreciate being consulted before significant changes are made to their codebase
```

### EnterPlanMode 调用结果（注入给模型的 tool_result）

调用成功后，返回给模型的 tool_result 内容（`mapToolResultToToolResultBlockParam`）：

```
Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.
In plan mode, you should:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Use AskUserQuestion if you need to clarify the approach
5. Design a concrete implementation strategy
6. When ready, use ExitPlanMode to present your plan for approval
Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.
```

> 注意：`EnterPlanMode` 在 agent 上下文中（`_.agentId` 存在）会抛错 `EnterPlanMode tool cannot be used in agent contexts` —— 即子 agent 不能自己进入 plan mode。

---

## 相关：Explore 与 Plan 子 Agent（plan workflow 的执行单元）

Plan mode 的 5 阶段工作流依赖两个内置子 agent 类型，通过 Agent 工具（`P9`）派生。

### Explore agent（`V9H`，Phase 1 用）

| 属性 | 值 |
|---|---|
| `agentType` | `"Explore"` |
| `model` | `"haiku"`（快速廉价；flag `tengu_quartz_heron` 开启时 `inherit`） |
| `source` / `baseDir` | `"built-in"` |
| `omitClaudeMd` | `true`（不加载 CLAUDE.md 上下文） |
| `disallowedTools` | `[Agent, ExitPlanMode, Edit, Write, NotebookEdit]`（只读） |

**whenToUse（`TNO`）**：

```
Fast read-only search agent for locating code. Use it to find files by pattern (eg. "src/components/**/*.tsx"), grep for symbols or keywords (eg. "API endpoints"), or answer "where is X defined / which files reference Y." Do NOT use it for code review, design-doc auditing, cross-file consistency checks, or open-ended analysis — it reads excerpts rather than whole files and will miss content past its read window. When calling, specify search breadth: "quick" for a single targeted lookup, "medium" for moderate exploration, or "very thorough" to search across multiple locations and naming conventions.
```

**System Prompt（`ONO()`）**：

```
You are a file search specialist for Claude Code, Anthropic's official CLI for Claude. You excel at thoroughly navigating and exploring codebases.
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents
Guidelines:
- Use {Glob 工具} for broad file pattern matching
- Use {Grep 工具} for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Use {Bash} ONLY for read-only operations (ls, git status, git log, git diff, find, grep, cat, head, tail)
- NEVER use {Bash} for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification
- Adapt your search approach based on the thoroughness level specified by the caller
- Communicate your final report directly as a regular message - do NOT attempt to create files
NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files
Complete the user's search request efficiently and report your findings clearly.
```

### Plan agent（`dC6`，Phase 2 用）

| 属性 | 值 |
|---|---|
| `agentType` | `"Plan"` |
| `model` | `"inherit"`（继承主 agent 模型） |
| `omitClaudeMd` | `true` |
| `disallowedTools` | `[Agent, ExitPlanMode, Edit, Write, NotebookEdit]`（同样只读） |

**whenToUse**：

```
Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.
```

---

## 备注

### 1. 提示词注入机制（核心架构）

Plan mode 的提示词**不是放在 system prompt 的静态部分**，而是作为**「附件（attachment）」动态注入到对话流的 user 消息中**。核心函数 `UmK()`（`getAttachments`）在每轮请求前并行计算所有附件：

```js
// 简化后的附件计算（来自 UmK）
let D = [
  $A("queued_commands", ...),
  $A("deferred_tools_delta", ...),
  $A("mcp_instructions_delta", ...),
  $A("changed_files", ...),
  $A("plan_mode", () => VM3(H, O, _, z)),       // ← plan mode 约束
  $A("plan_mode_exit", () => gmK(O, _)),        // ← 退出后衔接
  $A("auto_mode", ...),
  $A("todo_reminders", ...),
  $A("verify_plan_reminder", ...),
  // ...
];
```

附件计算函数 `VM3()`（`plan_mode`）的逻辑：
- 若当前 mode ≠ `"plan"` → 返回空（不注入）
- 若已有 plan_mode 附件且距上次 user 轮数 < `Y9q.TURNS_BETWEEN_ATTACHMENTS` → 返回空（节流，省 token）
- 否则计算 `reminderType`：`(已注入次数 + 1) % FULL_REMINDER_EVERY_N_ATTACHMENTS === 1 ? "full" : "sparse"`
- 若之前退出过 plan mode 且 plan 文件存在 → 额外推一个 `plan_mode_reentry` 附件
- 附件数据：`{ type: "plan_mode", reminderType, isSubAgent, planFilePath, planExists, customInstructions }`

附件最终由 `oqq(H)`（`case "plan_mode": return lP3(H)`）转成 `<system-reminder>` 包裹的 user meta 消息（`C3([x6({content, isMeta: true})])`）。模型看到的是 `<system-reminder>...</system-reminder>` 标签包裹的指令。

### 2. Plan 文件路径

由 `bh(agentId)` 生成，通常是 `~/.claude/plans/<slug>.md`（slug 由 `S0H(V_(), planSlugSeed)` 基于会话和种子生成）。模型被告知这是**唯一允许编辑的文件**。

### 3. Plan 文件读写工具的特殊处理

- `Write` 工具（`RJ`）在 plan mode 下对 plan 文件路径有特殊渲染：`HjK()` 检测 `file_path.startsWith(Fj())`（plan 目录前缀）时返回 `"Updated plan"` 而非 `"Write"`
- 渲染层对 plan 目录下的文件省略 diff 预览，只显示 `/plan to preview` 提示
- Plan 文件的 Write/Edit 操作不受 plan mode 的「只读」约束（因为是 plan 文件本身）

### 4. Plan Mode 与 Auto Mode 的交互

Plan mode 有个「prePlanMode」字段记录进入 plan 前的模式。退出 plan mode 时：
- 若 prePlanMode 是 `auto` 且 auto-mode gate 开启 → 切到 auto mode，剥离危险权限
- 若 prePlanMode 是 `auto` 但 gate 关闭 → 降级到 `default`，发通知 `plan exit → default · {原因}`
- 若 prePlanMode 是 `default` → 切回 default，恢复之前剥离的危险规则

### 5. Teammate 场景的特殊性

在 team（swarm）模式下：
- `EnterPlanMode` 和 `ExitPlanMode` 都可能被禁用（`isEnabled` 检查 `Hf().length > 0 && F8()`）
- Teammate 的 `ExitPlanMode` 不直接弹用户确认，而是向 team-lead 发 `plan_approval_request`，team-lead 用 `SendMessage` 工具的 `plan_approval_response` 结构化消息来批准/拒绝
- 批准后 teammate 收到 `[Plan Approved] ... You can now proceed with implementation. Your plan mode restrictions have been lifted.`

### 6. 模型选择

配置项 `Opus Plan Mode` / `Use Opus in plan mode, Sonnet otherwise`（字符串 `Opus in plan mode, else Sonnet`）—— plan mode 期间可自动切换到更强的 Opus 模型做规划，退出后切回 Sonnet 执行。这是用户可选的设置。

### 7. 提取方法学说明

由于 Claude Code 现在是 Bun 编译的原生二进制（不再是 `cli.js`），传统的「prettier 格式化 + 搜索」方法不适用。本次调研用 `strings` 提取二进制内所有可读字符串（约 39 万行），再 grep plan mode 关键词定位。minified 代码里的字符串字面量是完整保留的，因此所有提示词文本都能完整还原；变量名是 minified 的，但通过交叉引用（如 `name: wl` 配合 `wl = "EnterPlanMode"`）可还原语义。

### 8. 历史对比

早期 Claude Code（< 2.0）是单文件 `cli.js` minified bundle，可直接 `npx prettier --write --parser babel cli.js` 格式化后搜索。2.x 起改为 Bun 原生二进制分发（npm 包 `@anthropic-ai/claude-code` 只剩 wrapper + postinstall 下载器，真正二进制在平台子包如 `@anthropic-ai/claude-code-darwin-arm64`）。调研 plan mode 提示词的方法需相应调整：`strings <binary>` 替代 `prettier`。

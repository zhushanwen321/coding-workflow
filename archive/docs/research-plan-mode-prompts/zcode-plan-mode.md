# ZCode - Plan Mode (计划模式) 提示词调研

## 来源

- 应用: ZCode Desktop App (`/Applications/ZCode.app`)
- 版本: 3.3.4 (Build 2877), `dev.zcode.app`
- 厂商: 智谱 (z.ai / bigmodel)
- 核心文件: `Contents/Resources/glm/zcode.cjs`（9MB minified bundle，GLM agent 主逻辑）
- 反编译方式: `npx asar extract` 解包 `app.asar` → `prettier --parser babel` 格式化 `zcode.cjs`
- 提示词定位行号: `zcode.cjs` 第 58928–59090 行

## 模式体系

ZCode 提供四种 agent 模式（`zcode.cjs:18254`）：

| Mode ID | 名称 | 描述 |
|---------|------|------|
| `build` | Ask before changes | Ask before each file changes. |
| `edit` | Edit automatically | Edit selected files or relevant workspace files automatically. |
| **`plan`** | **Plan mode** | **Inspect the code and present a plan before editing.** |
| `yolo` | Full access | Edit and run commands with fewer confirmations. |

**Plan mode 的实现机制由四个部分组成：**

1. **运行时注入的 system reminder**（核心）—— 进入 plan mode 后每 N 轮注入
2. **EnterPlanMode 工具** —— 主动请求进入 plan mode
3. **ExitPlanMode 工具** —— 提交计划给用户审批并退出
4. **工具级权限拦截** —— plan mode 下只允许 `readOnly && !destructive` 的工具（`checkPlanMode`, `zcode.cjs:58079`）

---

## 1. 运行时 system reminder（核心提示词）

### 1.1 首次 / 完整 reminder (`Lgn`)

进入 plan mode 后首次注入，以及每 `FULL_REMINDER_EVERY_N_ATTACHMENTS=5` 轮重新注入完整版（`buildRuntimeModeReminderBody`, `zcode.cjs:59027`）：

```
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.
```

紧接其后注入 **Plan Workflow（4 阶段工作流）**：

```
## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the Explore subagent type.

1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.

2. **Launch up to 3 Explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigating testing patterns

### Phase 2: Design
Goal: Design an implementation approach.

**Guidelines:**
- Use the context gathered in Phase 1, including relevant files and code paths.
- Account for the user's requirements and constraints.
- Produce a concrete implementation plan that is detailed enough to execute.
- Consider useful perspectives for the task type:
  - New feature: simplicity vs performance vs maintainability
  - Bug fix: root cause vs workaround vs prevention
  - Refactoring: minimal change vs clean architecture

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use AskUserQuestion to clarify any remaining questions with the user

### Phase 4: Call ExitPlanMode
At the very end of your turn, once you have asked the user questions and are happy with your final plan - you should always call ExitPlanMode to indicate to the user that you are done planning.
This is critical - your turn should only end with either using the AskUserQuestion tool OR calling ExitPlanMode. Do not stop unless it's for these 2 reasons

**Important:** Use AskUserQuestion ONLY to clarify requirements or choose between approaches. Use ExitPlanMode to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ExitPlanMode.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the AskUserQuestion tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
```

> 来源: `buildPlanWorkflow()` = `Ngn()`, `zcode.cjs:58928`
> 变量替换后: `Explore` (`Ku`), `3` (`nOt`), `AskUserQuestion` (`Nf`), `ExitPlanMode` (`Ya`)

### 1.2 持续 reminder (`jgn`)

非首次注入（每 `TURNS_BETWEEN_ATTACHMENTS=5` 轮，若上一轮已有完整 reminder），精简版：

```
Plan mode still active (see full instructions earlier in conversation). Read-only. Follow 4-phase workflow. End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for plan approval). Never ask about plan approval via text or AskUserQuestion.
```

> 来源: `zcode.cjs:59086`

### 1.3 退出 plan mode reminder (`Bgn`)

用户 approve 计划、退出 plan mode 后注入：

```
## Exited Plan Mode

You have exited plan mode. You can now make edits, run tools, and take actions.
```

> 来源: `buildPlanModeExitReminderBody()` = `lOt()`, `zcode.cjs:59089`

### 注入逻辑

```js
// zcode.cjs:59027 buildRuntimeModeReminderBody
function buildRuntimeModeReminderBody(entries, mode) {
  if (mode !== "plan") return null;
  let { foundRuntimeModeReminder, humanTurnsSinceReminder } = getRuntimeModeReminderTurnCount(entries);
  // 已注入过且未过 5 轮 → 不注入
  if (foundRuntimeModeReminder && humanTurnsSinceReminder < TURNS_BETWEEN_ATTACHMENTS) return null;
  // 每 5 次注入中，第 1 次用完整版 (Lgn)，其余用精简版 (jgn)
  return ((countRuntimeModeReminders(entries) + 1) % FULL_REMINDER_EVERY_N_ATTACHMENTS === 1 ? Lgn : jgn).join("\n");
}
```

常量：`TURNS_BETWEEN_ATTACHMENTS = 5`, `FULL_REMINDER_EVERY_N_ATTACHMENTS = 5`（`zcode.cjs:59078`）

---

## 2. EnterPlanMode 工具

### 工具元信息 (`FV`, `zcode.cjs:50330`)

```json
{
  "name": "EnterPlanMode",
  "capability": "Enter read-only planning mode before implementation",
  "requiresUserInteraction": false,
  "readOnly": false,
  "destructive": false,
  "riskLevel": "low",
  "needsApproval": false,
  "permission": "plan.enter",
  "timeoutMs": 30000
}
```

### 工具描述 (`createEnterPlanModeProviderDescription` = `mSe()`, `zcode.cjs:50060`)

```
Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

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
1. Thoroughly explore the codebase using Glob, Grep, and Read
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

### 进入 plan mode 后返回给模型的 message (`formatEnterPlanModeModelContent` = `Wfn`, `zcode.cjs:50231`)

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

---

## 3. ExitPlanMode 工具

### 工具元信息 (`WAt`, `zcode.cjs:50394`)

```json
{
  "name": "ExitPlanMode",
  "capability": "Request user approval for the plan and exit planning mode before coding",
  "requiresUserInteraction": true,
  "readOnly": false,
  "destructive": false,
  "riskLevel": "low",
  "needsApproval": true,
  "permission": "plan.exit",
  "timeoutMs": 30000
}
```

### 工具描述 (`Bfn` = `ZAt[0]`, `zcode.cjs:50154`)

```
Use this tool when you are in plan mode and have finished writing your plan and are ready for user approval.

## How This Tool Works
- You should have already explored the codebase and finalized the plan you want the user to review
- This tool DOES take the plan content as the required plan parameter in ZCode
- Pass the complete plan in the plan field; the user will review that content before approving implementation
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of the plan parameter when they review it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion before finalizing your plan
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.
```

### 用户审批通过后返回给模型的 message (`formatExitPlanModeModelContent` = `Vfn`, `zcode.cjs:50242`)

```
User has approved your plan. You can now start coding. Start with updating your todo list if applicable.

## Approved Plan:
<plan 参数内容>
```

若 plan 为空：

```
User has approved exiting plan mode. You can now proceed.
```

### 错误状态（非 plan mode 下调用 ExitPlanMode）

```
You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.
```

---

## 4. 工具级权限拦截 (`checkPlanMode`, `zcode.cjs:58079`)

plan mode 下，工具执行前经过权限检查器：

```js
checkPlanMode(tool, capability) {
  // 只读且非破坏性工具 → 放行
  if (capability.readOnly && !capability.destructive) {
    return this.allow(tool, capability, "mode.plan.readOnly",
      "Plan mode allows read-only tool execution");
  }
  // 非破坏性 MCP 工具 → 放行
  if (this.isMcpToolCapability(capability) && !capability.destructive) {
    return this.allow(tool, capability, "mode.plan.mcp",
      "Plan mode allows non-destructive MCP tool execution");
  }
  // 其余 → 拒绝
  return this.deny(tool, capability, "mode.plan.nonReadOnly",
    "Plan mode only allows read-only, non-destructive tools");
}
```

**关键点**：plan mode 不依赖模型「自觉」不写文件，而是由权限层硬拦截所有非只读工具。

---

## 5. AskUserQuestion 在 plan mode 下的补充说明 (`zcode.cjs:50460`)

```
Plan mode note: To switch into plan mode, use EnterPlanMode (not this tool). Once in plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?", "Should I proceed?", or otherwise reference "the plan" in questions — the user cannot see the plan until you call ExitPlanMode for approval.
```

---

## 6. Plan 文件持久化

ExitPlanMode 被 approve 后，plan 内容会写入文件（`writeApprovedPlanFile` = `BAt`, `zcode.cjs:49989`）：

- 路径: `<workspace>/.zcode/plans/plan-<sessionId>.md`
- 后续会话恢复时，若文件存在，注入引用 reminder：

```
A plan file exists from plan mode at: <planFilePath>

Plan contents:

<planContent>

If this plan is relevant to the current work and not already complete, continue working on it.
```

> 来源: `formatPlanFileReference` = `Lfn`, `zcode.cjs:50021`

---

## 总结：ZCode Plan Mode 设计特点

1. **提示词不靠服务端下发**：尽管 ZCode 用 GLM 云端模型，plan mode 的全部提示词、工具定义、权限规则都在客户端 `zcode.cjs` 中，mode 标识随请求发送但提示词客户端组装。

2. **双工具 + reminder 组合**：EnterPlanMode（进入，不需用户确认）/ ExitPlanMode（退出，需用户确认 plan 内容）。plan mode 状态靠周期性 system reminder 维持（每 5 轮，完整版/精简版交替）。

3. **强制 4 阶段工作流**：Phase 1 理解（强制只用 Explore subagent，最多 3 个并行）→ Phase 2 设计 → Phase 3 审查 → Phase 4 调用 ExitPlanMode。每轮必须以 AskUserQuestion 或 ExitPlanMode 结束。

4. **权限硬拦截**：plan mode 下非只读工具直接 deny，不靠模型自觉。

5. **plan 持久化**：approved plan 写入 `.zcode/plans/` 目录，跨会话可恢复。

6. **设计高度借鉴 Claude Code**：ExitPlanMode/EnterPlanMode 工具名、reminder 结构、4-phase workflow 与 Claude Code 的 plan mode 高度相似，但增加了 Explore subagent 并行探测阶段。

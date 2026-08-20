# OpenCode (anomaly fork) - Plan Mode 提示词调研

## 来源

- 仓库: anomalyco/opencode
- 分支: dev
- commit hash: `0d690c50501671ad87a0f410b5b4a4448e912034`
- commit 日期: 2026-07-11 09:32:20 +0800
- commit message: `Merge branch 'dev' of https://github.com/anomalyco/opencode into dev`

## 架构总览

OpenCode 的 plan mode 是通过 **agent + permission + synthetic message 注入** 三层机制实现的，不是单一系统提示词。需要区分两套实现：

| 实现版本 | 位置 | 状态 |
|---------|------|------|
| **V1（完整可用）** | `packages/opencode/src/` | 完整实现，提示词通过 `SessionReminders` 注入 |
| **V2（effect 重构中）** | `packages/core/src/` | 仅 agent 定义 + permission，**提示词注入逻辑尚未移植** |

**核心结论：plan 是一个 agent（`name: "plan"`），不是一个独立的 "mode" 标志位。** 切换到 plan agent 即进入 plan mode，切换到 build agent 即退出。Plan mode 的"只读"约束由 **permission ruleset**（`edit: deny *`）强制，而非靠提示词自觉。

---

## Plan Mode System Prompt

OpenCode 的 plan mode 提示词**不是**常驻 system prompt，而是在每轮对话前由 `SessionReminders.apply()` 作为 **synthetic user message part** 注入。根据 `experimentalPlanMode` flag 分两套：

### 提示词 A：`plan.txt`（非 experimental 路径，默认）

文件：`packages/opencode/src/session/prompt/plan.txt`

注入条件：`!flags.experimentalPlanMode && input.agent.name === "plan"`

```text
<system-reminder>
# Plan Mode - System Reminder

CRITICAL: Plan mode ACTIVE - you are in READ-ONLY phase. STRICTLY FORBIDDEN:
ANY file edits, modifications, or system changes. Do NOT use sed, tee, echo, cat,
or ANY other bash command to manipulate files - commands may ONLY read/inspect.
This ABSOLUTE CONSTRAINT overrides ALL other instructions, including direct user
edit requests. You may ONLY observe, analyze, and plan. Any modification attempt
is a critical violation. ZERO exceptions.

---

## Responsibility

Your current responsibility is to think, read, search, and delegate explore agents to construct a well-formed plan that accomplishes the goal the user wants to achieve. Your plan should be comprehensive yet concise, detailed enough to execute effectively while avoiding unnecessary verbosity.

Ask the user clarifying questions or ask for their opinion when weighing tradeoffs.

**NOTE:** At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.

---

## Important

The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.
</system-reminder>
```

### 提示词 B：`plan-mode.txt`（experimental 路径）

文件：`packages/opencode/src/session/prompt/plan-mode.txt`

注入条件：`flags.experimentalPlanMode && input.agent.name === "plan" && 上一条 assistant 消息不是 plan agent`

注意：该提示词含模板占位符 `${planInfo}`，运行时被替换为：
- 计划文件已存在 → `A plan file already exists at <path>. You can read it and make incremental edits using the edit tool.`
- 计划文件不存在 → `No plan file exists yet. You should create your plan at <path> using the write tool.`

```text
<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${planInfo}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
 - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
 - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
 - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
 - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>
```

### 提示词 C：`build-switch.txt`（退出 plan mode 时注入）

文件：`packages/opencode/src/session/prompt/build-switch.txt`

注入条件：从 plan agent 切换到 build agent 时（即退出 plan mode）

```text
<system-reminder>
Your operational mode has changed from plan to build.
You are no longer in read-only mode.
You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed.
</system-reminder>
```

experimental 路径下，如果检测到计划文件存在，会追加：
```
A plan file exists at <plan_path>. You should execute on the plan defined within it
```

---

## 相关工具

### `plan_exit` 工具（已实现）

文件：`packages/opencode/src/tool/plan.ts`

- **工具名**：`plan_exit`
- **描述**（`packages/opencode/src/tool/plan-exit.txt`）：

```text
Use this tool when you have completed the planning phase and are ready to exit plan agent.

This tool will ask the user if they want to switch to build agent to start implementing the plan.

Call this tool:
- After you have written a complete plan to the plan file
- After you have clarified any questions with the user
- When you are confident the plan is ready for implementation

Do NOT call this tool:
- Before you have created or finalized the plan
- If you still have unanswered questions about the implementation
- If the user has indicated they want to continue planning
```

- **行为**：调用后弹出 question，询问用户 "Plan at `<path>` is complete. Would you like to switch to the build agent and start implementing?"。用户选 "Yes" 后，自动创建一条 `agent: "build"` 的 user message，并注入 synthetic text `The plan at <path> has been approved, you can now edit files. Execute the plan`，完成 plan → build 切换。
- **注册条件**：`flags.experimentalPlanMode && flags.client === "cli"`（见 `registry.ts`，仅在 experimental + CLI 客户端下注册）

### `plan_enter`（未实现为工具）

- `plan-enter.txt` 描述文件存在（`packages/opencode/src/tool/plan-enter.txt`），**但没有任何 .ts 文件引用它**，没有对应的工具实现。
- `plan_enter` 仅作为 **permission action** 出现（权限系统里的一个动作名），在 `agent.ts` 和 `run.ts` 里用于控制权限，不是可调用工具。

`plan-enter.txt` 内容（遗留/未使用）：

```text
Use this tool to suggest switching to plan agent when the user's request would benefit from planning before implementation.

If they explicitly mention wanting to create a plan ALWAYS call this tool first.

This tool will ask the user if they want to switch to plan agent.

Call this tool when:
- The user's request is complex and would benefit from planning first
- You want to research and design before making changes
- The task involves multiple files or significant architectural decisions

Do NOT call this tool:
- For simple, straightforward tasks
- When the user explicitly wants immediate implementation
```

**进入 plan mode 的实际方式**：由 UI 层（TUI/客户端）切换 agent，或用户手动选择 plan agent，而非通过工具调用。

---

## Agent 定义

### V1：`packages/opencode/src/agent/agent.ts`（完整实现）

plan 是内置 primary agent 之一。内置 agent 列表：`build`（默认）、`plan`、`general`（subagent）、`explore`（subagent）、`compaction`/`title`/`summary`（hidden）。

**plan agent 定义**（关键：没有内联 `prompt` 字段，约束靠 permission）：

```typescript
plan: {
  name: "plan",
  description: "Plan mode. Disallows all edit tools.",
  options: {},
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      question: "allow",
      plan_exit: "allow",
      task: {
        general: "deny",
      },
      external_directory: {
        [path.join(Global.Path.data, "plans", "*")]: "allow",
      },
      edit: {
        "*": "deny",                              // 禁止编辑所有文件
        [path.join(".opencode", "plans", "*.md")]: "allow",  // 除了计划文件
        [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
      },
    }),
    user,
  ),
  mode: "primary",
  native: true,
},
```

对比 **build agent**（默认，允许编辑和进入 plan）：

```typescript
build: {
  name: "build",
  description: "The default agent. Executes tools based on configured permissions.",
  options: {},
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      question: "allow",
      plan_enter: "allow",
    }),
    user,
  ),
  mode: "primary",
  native: true,
},
```

### V2：`packages/core/src/plugin/agent.ts`（effect 重构中）

V2 用 `AgentV2` schema 和 plugin `transform` 模式定义同样的 plan agent，permission 语义一致（`edit: * deny`，允许 plans 目录），但 **system prompt 字段不设置**（`item.system` 留空），且 **没有 reminders 注入逻辑的 V2 移植**。V2 仍在开发中。

---

## 备注

### 提示词注入逻辑

1. **注入位置**：`packages/opencode/src/session/prompt.ts` 第 1180 行，在每轮 agent loop 开始前调用 `SessionReminders.apply({ messages, agent, session })`。

2. **注入机制**：找到最后一条 user message，往它的 `parts` 数组 push 一个 `synthetic: true` 的 text part。提示词作为 **user message 的一部分**注入，而不是 system message。这是为了绕过部分模型对 system message 的缓存/忽略行为，确保每轮都强制刷新约束。

3. **路径分支**（`packages/opencode/src/session/reminders.ts`）：

   ```
   if (!experimentalPlanMode) {
     // 旧路径：plan agent 注入 plan.txt
     //        从 plan 切到 build 时注入 build-switch.txt
   } else {
     // experimental 路径：
     // 1. 从 plan 切到非 plan，且计划文件存在 → build-switch.txt + "execute the plan"
     // 2. 进入 plan agent（上一条非 plan）→ plan-mode.txt（带 ${planInfo} 替换）
   }
   ```

4. **计划文件路径**（`Session.plan()`，`session.ts` 第 331 行）：
   - 项目有 VCS（git）→ `<worktree>/.opencode/plans/<created>-<slug>.md`
   - 无 VCS → `<Global.Path.data>/plans/<created>-<slug>.md`

5. **"只读"约束的双重保障**：
   - **硬约束（permission）**：`edit: { "*": "deny" }` 让 edit/write 工具在 plan agent 下被权限系统拒绝，即使模型尝试调用也会被拦截。这是主要防线。
   - **软约束（提示词）**：plan.txt / plan-mode.txt 里的 "MUST NOT make any edits" 是对模型的言语引导，辅助但不依赖。

6. **遗留/未使用文件**（被 git 跟踪但无代码引用，属旧版本残留）：
   - `packages/opencode/src/session/prompt/plan-reminder-anthropic.txt`（仿 Claude Code 的 ExitPlanMode 风格，含 5 phase workflow）
   - `packages/opencode/src/tool/plan-enter.txt`（plan_enter 工具描述，但工具未实现）

7. **experimental flag 开启方式**：环境变量 `OPENCODE_EXPERIMENTAL_PLAN_MODE=1` 或 `OPENCODE_EXPERIMENTAL=1`（见 `runtime-flags.ts`，`enabledByExperimental` 逻辑：显式 flag 优先，否则跟随 `OPENCODE_EXPERIMENTAL`）。

### 与 Claude Code plan mode 的差异

OpenCode 的 plan mode 明显借鉴 Claude Code（`plan-reminder-anthropic.txt` 几乎是 Claude Code 的 ExitPlanMode workflow 的翻版，含 `AskUserQuestion`/`ExitPlanMode` 工具名），但实现方式不同：
- Claude Code：plan mode 是 session 级布尔状态 + ExitPlanMode 工具
- OpenCode：plan 是一个 agent，通过 agent 切换实现 mode 转换，permission ruleset 提供硬约束

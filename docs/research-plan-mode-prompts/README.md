# Plan Mode（计划模式）提示词调研

> 调研 7 个 coding agent CLI 的「计划模式 / 只规划不执行」机制及其注入模型的系统提示词。
> 调研日期：2026-07-11

## 调研对象

| Agent | 厂商 | 来源 | 有无 Plan Mode | 文档 |
|-------|------|------|---------------|------|
| **Claude Code** | Anthropic | 二进制反编译（`strings`） | ✅ 有（鼻祖） | [claude-code-plan-mode.md](./claude-code-plan-mode.md) |
| **ZCode** | 智谱 (z.ai) | Electron app 反编译（`asar` + `prettier`） | ✅ 有（借鉴 Claude Code） | [zcode-plan-mode.md](./zcode-plan-mode.md) |
| **Qwen Code** | 阿里 | 源码（gemini-cli fork） | ✅ 有（继承 + 扩展） | [qwen-code-plan-mode.md](./qwen-code-plan-mode.md) |
| **OpenCode** | anomaly | 源码（TypeScript） | ✅ 有（agent 切换实现） | [opencode-plan-mode.md](./opencode-plan-mode.md) |
| **Codex CLI** | OpenAI | 源码（Rust + TS） | ✅ 有（双轴：Collaboration Mode） | [codex-cli-plan-mode.md](./codex-cli-plan-mode.md) |
| **Aider** | Aider-AI | 源码（Python） | ⚠️ 近似（Architect 双模型模式） | [aider-architect-mode.md](./aider-architect-mode.md) |
| **Crush** | Charmbracelet | 源码（Go） | ❌ 无（明确反对 plan-only） | [crush-plan-mode.md](./crush-plan-mode.md) |

---

## 横向对比：Plan Mode 的三种实现范式

### 范式 A：mode 状态 + 周期性 reminder 注入（Claude Code / ZCode / Qwen Code）

这是最主流的设计。核心机制：

1. **Session 级 mode 状态**：维护一个 `plan` / `default` / `build` 等状态标志
2. **周期性 system reminder 注入**：进入 plan mode 后，每 N 轮向对话流注入 `<system-reminder>`，交替使用「完整版」和「精简版」省 token
3. **配套工具**：`EnterPlanMode`（进入）+ `ExitPlanMode`（退出并提交计划审批）
4. **工具级权限拦截**：plan mode 下拒绝非只读工具（硬约束）

| 维度 | Claude Code | ZCode | Qwen Code |
|------|------------|-------|-----------|
| 提取方式 | `strings` 二进制 | `asar` + `prettier` 反编译 | 源码直读 |
| 进入工具 | `EnterPlanMode` | `EnterPlanMode` | `enter_plan_mode` |
| 退出工具 | `ExitPlanMode`（读 plan 文件） | `ExitPlanMode`（传 plan 参数） | `exit_plan_mode` |
| plan 文件 | `~/.claude/plans/<slug>.md` | `.zcode/plans/plan-<sessionId>.md` | 无持久化 |
| 工作流阶段 | 5 阶段（Understanding→Design→Review→Final Plan→Call ExitPlanMode） | 4 阶段 | Iterative Loop（无固定阶段数） |
| 并行探索 | Explore subagent（最多 3 个） | Explore subagent（最多 3 个） | 多次并行探索 |
| Plan agent | 有（`Plan` subagent，Phase 2） | 无（自身设计） | 无 |
| reminder 节流 | 每 5 轮，full/sparse 交替 | 每 5 轮，full/sparse 交替 | 每轮注入 |
| 权限拦截 | 工具级 readOnly 检查 | 工具级 `checkPlanMode`（readOnly + !destructive） | `isPlanModeBlocked()` 拦截 |
| 自定义流程 | 支持（`customInstructions`） | 不支持 | 不支持 |

**关键结论**：ZCode 的 plan mode 高度借鉴 Claude Code（工具名、reminder 结构、4/5 阶段工作流几乎一致），但简化了 Plan subagent 层。Qwen Code 继承 gemini-cli 骨架，额外加了 **Plan Approval Gate**（LLM-as-judge 自动评审），并把工作流改为迭代式而非阶段式。

### 范式 B：Agent 切换实现 mode（OpenCode）

OpenCode 不维护 mode 状态标志，而是把 `plan` 本身定义为一个 **agent**：

- `build` agent（默认）↔ `plan` agent 切换 = 进入/退出 plan mode
- plan agent 的 permission ruleset 硬编码 `edit: { "*": "deny" }`（除 plans 目录）
- 提示词通过 **synthetic user message part** 注入（非 system message，绕过模型对 system 的缓存）
- `plan_exit` 工具触发 agent 切换回 build

这个设计让 plan mode 的「只读」约束完全由权限系统保证，提示词只是辅助。

### 范式 C：双轴正交（Codex CLI）

Codex 把「控制行为」拆成两条正交的轴：

- **Approval Policy 轴**（`untrusted` / `on-request` / `never` / `granular`）：控制命令审批粒度，通过追加 `<permissions instructions>` 段实现，不改 system prompt
- **Collaboration Mode 轴**（`Default` / `Plan`）：控制只规划 vs 直接执行，通过 `<collaboration_mode>` 标签注入完整 developer instructions

两轴可组合（如 Plan + on-request = 只规划且探索命令按需审批）。**Plan mode 的只读约束是提示词级的**——除 `update_plan` 被硬拦截，`apply_patch`/`shell` 仍可调用，靠 prompt 约束「must not perform mutating actions」。

### 近似方案：双模型 Architect 模式（Aider）

Aider 没有 mode 概念，而是用**两阶段单轮对话**实现「先规划后执行」：

1. **Architect 阶段**：用强推理模型（main_model）产出自然语言方案，**无格式约束**（`system_reminder=""`，不要求 SEARCH/REPLACE）
2. 用户确认 "Edit the files?"
3. **Editor 阶段**：新建 coder，用 editor_model（便宜/擅长格式）+ 标准 SEARCH/REPLACE 提示词，把方案翻译成可应用的编辑块

核心思想：**把"代码推理"和"代码编辑"分离**给不同模型。与 plan mode 的「只读规划」不同，architect 的产出是给人确认后直接交给第二个模型执行的，不涉及多轮迭代规划。

### 反面案例：明确反对 plan-only（Crush）

Crush **没有 plan mode，也从未有过**。它的默认 prompt 有两条直接否定 plan-only 行为的指令：

- `<critical_rules>`: "BE AUTONOMOUS: Don't ask questions - search, read, think, decide, act."
- `<proactiveness>`: "Responding with only a plan, outline, or TODO list (or any other purely verbal response) is failure; you must execute the plan via tools whenever execution is possible."

Crush 的权限控制是「autonomous by default + per-call approval」——每次修改类工具调用弹窗三选一（Allow / Allow for Session / Deny），加上 YOLO 模式（全局跳过审批）。

---

## 核心提示词文本索引

每个文档都完整提取了提示词原文（未截断）。以下是快速定位：

### 基础约束句（几乎所有 plan mode 共享的开头）

> Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools, or otherwise make any changes to the system. This supercedes any other instructions you have received.

这句话在 Claude Code、ZCode、Qwen Code（继承自 gemini-cli）中几乎逐字相同，是 plan mode 提示词的「黄金标准」。Codex 的措辞略有不同但语义一致。

### 工作流指令

| Agent | 工作流结构 | 核心要求 |
|-------|-----------|---------|
| Claude Code | 5 阶段（Understanding→Design→Review→Final Plan→ExitPlanMode） | 每轮必须以 AskUserQuestion 或 ExitPlanMode 结束 |
| ZCode | 4 阶段（Understanding→Design→Review→ExitPlanMode） | 同上，Phase 1 强制只用 Explore subagent |
| Qwen Code | Iterative Loop（Explore→Capture→Ask 循环） | 不固定阶段数，迭代直到 plan complete |
| OpenCode | 5 阶段（experimental 路径，类似 Claude Code） | 写 plan 文件 → 调 plan_exit |
| Codex | 3 阶段（环境探索→意图澄清→实现澄清） | 输出 `<proposed_plan>` 块 |
| Aider | 无工作流阶段，单轮方案输出 | architect 产出 → 用户确认 → editor 执行 |

### 退出/审批机制

| Agent | 退出方式 | 用户交互 |
|-------|---------|---------|
| Claude Code | `ExitPlanMode` 工具（读 plan 文件） | 弹窗 Approve/Reject，可带反馈 |
| ZCode | `ExitPlanMode` 工具（传 plan 参数） | "Plan" header + "Approve" 按钮 |
| Qwen Code | `exit_plan_mode` 工具 | 4 种 outcome（RestorePrevious/ProceedAlways/ProceedOnce/Cancel）|
| Qwen Code (自主) | Plan Approval Gate（LLM-as-judge） | 自动审批或打回，无需用户交互 |
| OpenCode | `plan_exit` 工具 → 切换 agent | "Would you like to switch to build agent?" |
| Codex | 用户手动 `/plan` 切换回 Default | 模型输出 `<proposed_plan>`，用户决定是否切换 |
| Aider | "Edit the files?" 确认 | auto_accept_architect 开关控制 |

---

## 提取方法学

| Agent | 代码形态 | 提取方法 |
|-------|---------|---------|
| Claude Code | Bun 编译 Mach-O 二进制（212MB） | `strings <binary>` → grep 关键词 → 交叉引用还原 minified 变量 |
| ZCode | Electron app（`app.asar` 228MB + `zcode.cjs` 9MB） | `npx asar extract` → `npx prettier --parser babel` 格式化 → grep |
| Qwen Code | 未 minified TypeScript | 直接读源码 |
| OpenCode | 未 minified TypeScript | 直接读源码 + `.txt` 提示词文件 |
| Codex CLI | Rust + TypeScript + `.md` 模板 | 直接读源码 + `collaboration-mode-templates` crate |
| Aider | Python（字符串内嵌） | 直接读 `*_prompts.py` |
| Crush | Go（`//go:embed .md.tpl`） | 直接读源码 + 模板文件 |

**Claude Code 和 ZCode 是反编译难点**：Claude Code 2.x 起从 `cli.js` 改为 Bun 原生二进制，传统的 prettier 格式化失效，需用 `strings` 提取。ZCode 的核心逻辑在 `Resources/glm/zcode.cjs` 而非 `app.asar`，需要两层解包。

---

## 调研方法

- **并行化**：主 agent 专注 ZCode 反编译（最复杂），6 个 background subagent 并行处理其他 agent CLI（claude-code / codex / opencode / qwen-code / aider / crush）
- **git 同步**：所有仓库先 `git pull --no-ff origin main`（opencode 默认分支为 `dev`）到最新
- **完整性**：每个文档都完整提取提示词原文（未截断），标注 commit hash、文件路径、行号，确保可复现

## 文件清单

```
research-plan-mode-prompts/
├── README.md                      ← 本文件（索引 + 横向对比）
├── claude-code-plan-mode.md       (539 行) 4 变体动态拼接 + EnterPlanMode/ExitPlanMode + Explore/Plan subagent
├── zcode-plan-mode.md             (391 行) 反编译 zcode.cjs，4 部分（reminder + 双工具 + 权限拦截 + plan 文件持久化）
├── qwen-code-plan-mode.md         (225 行) 继承 gemini-cli + Plan Approval Gate 扩展
├── opencode-plan-mode.md          (325 行) agent 切换范式，synthetic user message 注入
├── codex-cli-plan-mode.md         (733 行) 双轴正交，3 阶段 + <proposed_plan> 协议
├── aider-architect-mode.md        (446 行) 双模型机制，architect vs code/ask 提示词差异
└── crush-plan-mode.md             (591 行) 无 plan mode 的证据链 + 默认 system prompt 全文
```

# Plan Mode 提示词详细对比

> 基于 7 个 coding agent 的反编译/源码调研，逐维度对比各家 plan mode 提示词的设计差异。
> 数据来源见各 agent 的单独文档。

---

## 一、总览：谁有 plan mode，实现范式是什么

| Agent | 有 Plan Mode | 实现范式 | 提示词注入方式 |
|-------|:---:|---------|-------------|
| **Claude Code** | ✅ | mode 状态 + 周期 reminder | 动态拼接 `<system-reminder>` 附件，4 变体（full/sparse/subagent/custom） |
| **ZCode** | ✅ | mode 状态 + 周期 reminder（借鉴 CC） | 动态拼接 `<system-reminder>`，2 变体（full/sparse） |
| **Qwen Code** | ✅ | mode 状态 + 每轮 reminder（继承 gemini-cli） | 动态注入 `<system-reminder>`，2 套渲染（交互/SDK） |
| **OpenCode** | ✅ | **agent 切换**（plan 是一个 agent） | synthetic user message part 注入 |
| **Codex CLI** | ✅ | **双轴正交**（Collaboration Mode） | `<collaboration_mode>` 标签包裹的 developer instructions |
| **Aider** | ⚠️ 近似 | **双模型单轮**（Architect 模式） | architect 阶段 `main_system` + editor 阶段 SEARCH/REPLACE |
| **Crush** | ❌ | 无（明确反对 plan-only） | N/A |

---

## 二、基础约束句：「不准动手」怎么说

所有 plan mode 的第一步都是告诉模型「你现在只能看不能改」。但这句指令的措辞和严格程度差异很大。

### 2.1 措辞对比

**Claude Code / ZCode / Qwen Code（几乎逐字相同，来自同一源头）**

```
Plan mode is active. The user indicated that they do not want you to execute yet
-- you MUST NOT make any edits, run any non-readonly tools (including changing
configs or making commits), or otherwise make any changes to the system.
This supercedes any other instructions you have received.
```

> 这三家共享同一句话不是巧合——Qwen Code 继承自 gemini-cli（license: Google LLC），ZCode 直接照搬 Claude Code。Claude Code 是这句话的原始出处。

**关键细微差异**：Claude Code 有「(with the exception of the plan file mentioned below)」——允许写 plan 文件；ZCode 和 Qwen Code 的基础句**没有**这个例外（ZCode 靠权限层单独放行 plan 文件，Qwen Code 不持久化 plan 文件）。

**Codex（完全不同的措辞，强调模式锁定）**

```
You are in **Plan Mode** until a developer message explicitly ends it.
Plan Mode is not changed by user intent, tone, or imperative language. If a user
asks for execution while still in Plan Mode, treat it as a request to plan the
execution, not perform it.
```

> Codex 不说「不准动手」，而是说「即使用户命令你执行，你也当成规划执行来做」。这是更强的模式锁定——防止用户一句「快去改」就打破只读约束。

**OpenCode（最强硬，逐工具点名禁止）**

```
CRITICAL: Plan mode ACTIVE - you are in READ-ONLY phase. STRICTLY FORBIDDEN:
ANY file edits, modifications, or system changes. Do NOT use sed, tee, echo, cat,
or ANY other bash command to manipulate files - commands may ONLY read/inspect.
This ABSOLUTE CONSTRAINT overrides ALL other instructions, including direct user
edit requests.
```

> OpenCode 是唯一逐一点名 shell 命令（sed/tee/echo/cat）的，并且明确写「即使直接用户编辑请求也覆盖」。措辞用了大量全大写强调（CRITICAL/STRICTLY FORBIDDEN/ABSOLUTE CONSTRAINT）。

**Aider（不约束格式，只约束粒度）**

```
DO NOT show the entire updated function/file/etc!
```

> Aider 的 architect 阶段根本不禁止「描述改动」，反而要求「完整描述」——它只禁止贴整文件。因为 architect 的产出本来就是给 editor 模型看的自然语言方案。

### 2.2 约束强度排序

| 强度 | Agent | 手段 |
|:---:|-------|------|
| 🔴 最强 | **OpenCode** | 全大写 + 逐工具点名 + 「覆盖直接用户请求」 + permission 层 `edit: deny *` 硬拦截 |
| 🟠 强 | **Claude Code** | 「supersedes any other instructions」+ 工具级 readOnly 检查 + plan 文件例外 |
| 🟡 中 | **ZCode / Qwen Code** | 同 Claude Code 措辞但无 plan 文件例外（ZCode 靠权限层补） |
| 🟢 软 | **Codex** | 靠模式锁定 + 「non-mutating vs mutating」分类引导，工具层不硬拦截 |
| ⚪ 无约束 | **Aider** | architect 本就要描述改动，只禁贴整文件 |

---

## 三、工作流结构：规划分几步走

这是各家差异最大的部分——同样的目标（产出高质量计划），走法完全不同。

### 3.1 结构对比

| Agent | 阶段数 | 结构 | 核心特点 |
|-------|:---:|------|---------|
| **Claude Code** | 5 | Understanding → Design → Review → Final Plan → Call ExitPlanMode | 最完整，每个阶段有明确 subagent 配置 |
| **OpenCode** (experimental) | 5 | 同 Claude Code（几乎是翻译） | 直接照搬，但 Phase 5 改为 `plan_exit` |
| **ZCode** | 4 | Understanding → Design → Review → Call ExitPlanMode | 砍掉 Final Plan 独立阶段（合并进 Review） |
| **Codex** | 3 | 环境探索 → 意图澄清 → 实现澄清 | 无固定「写计划」步骤，聊天式收敛 |
| **Qwen Code** | 0（迭代） | Explore → Capture → Ask 循环 | 无阶段划分，循环直到 done |
| **Aider** | 0（单轮） | 无工作流 | 单轮产出方案，无迭代 |

### 3.2 各家工作流详情

**Claude Code（5 阶段，最结构化）**

```
Phase 1: Initial Understanding  ← 只用 Explore subagent，最多 3 个并行
Phase 2: Design                 ← 用 Plan subagent（独立 agent 类型），最多 1-3 个
Phase 3: Review                 ← 读关键文件 + AskUserQuestion 澄清
Phase 4: Final Plan             ← 写 plan 文件（唯一允许编辑的文件）
Phase 5: Call ExitPlanMode      ← 每轮必须以 AskUserQuestion 或 ExitPlanMode 结束
```

独特点：Phase 1 和 Phase 2 分别用**不同类型的 subagent**（Explore 只读搜索 / Plan 架构设计），并且并发数受套餐控制（免费版 1 个，Max/Enterprise 3 个）。

**ZCode（4 阶段，Claude Code 的精简版）**

```
Phase 1: Initial Understanding  ← 只用 Explore subagent，最多 3 个并行
Phase 2: Design                 ← 无 subagent（自身设计）
Phase 3: Review                 ← AskUserQuestion 澄清
Phase 4: Call ExitPlanMode      ← 同 CC Phase 5
```

差异：没有独立的 Plan subagent（Phase 2 自己做），没有 Final Plan 写文件阶段。

**Qwen Code（迭代循环，最灵活）**

```
The Loop:
1. Explore — 用 read_file/grep_search/glob 只读探索
2. Capture findings — 立即整合发现（不要等到最后）
3. Ask the user — 遇到无法从代码回答的，用 ask_user_question

First Turn: 快速扫几个关键文件形成初步理解，然后立即提问
When to Converge: 覆盖了 what to change / which files / reuse what / how to verify
```

独特点：不强制阶段顺序，强调「不要等到最后才综合」（Capture findings 独立成步）。引入了「Asking Good Questions」专项指导（不要问代码能回答的、批量问、聚焦只有用户能答的）。

**Codex（3 阶段聊天式，最对话导向）**

```
PHASE 1 — Ground in the environment (explore first, ask second)
         ← 强制「先探索后提问」，至少一次非变更探索
PHASE 2 — Intent chat (what they actually want)
         ← 持续问直到明确：goal + success criteria + audience + scope + constraints
PHASE 3 — Implementation chat (what/how we'll build)
         ← 持续问直到 spec decision complete：API/schema/data flow/edge cases/testing
```

独特点：
- 强制「先探索后提问」——除非 prompt 本身有矛盾，否则必须先探索环境再问用户
- 区分两类未知：「discoverable facts」（代码能答的，先探索）vs「preferences/tradeoffs」（代码答不了的，早问）
- 最终目标「decision complete」——计划必须完整到另一个工程师/agent 可以零决策直接执行

**OpenCode（5 阶段，experimental 路径照搬 Claude Code）**

与 Claude Code 几乎一致，差异：
- Phase 5 工具名 `plan_exit` 而非 `ExitPlanMode`
- 增量写 plan 文件（「build your plan incrementally by writing to or editing this file」）
- 非 experimental 路径（plan.txt）无工作流，只有纯只读约束

**Aider（无工作流，单轮方案）**

```
architect 模型读 change request + 代码 → 产出自然语言方案（无格式约束）
→ 用户确认 "Edit the files?"
→ editor 模型把方案翻译成 SEARCH/REPLACE 块
```

独特点：无迭代、无提问、无探索阶段。architect 是一次性产出，依赖模型自身的推理能力。

### 3.3 核心差异：探索 vs 提问的优先级

| Agent | 探索优先？ | 提问策略 |
|-------|:---:|---------|
| **Codex** | ✅ 强制 | 「先探索后提问」明文规定，区分两类未知 |
| **Qwen Code** | ✅ 引导 | 「Never ask what you could find out by reading the code」 |
| **Claude Code** | ⚠️ 隐含 | Phase 1 先探索，Phase 3 才提问，但未强制 |
| **ZCode** | ⚠️ 隐含 | 同 Claude Code |
| **OpenCode** | ❌ 未强调 | 工作流里探索和提问混在一起 |
| **Aider** | N/A | 不提问（单轮） |

> Codex 和 Qwen Code 在「先探索后提问」上做得最显式——这是减少用户负担的关键设计。Claude Code/ZCode 隐含但未强制。

---

## 四、子 agent / 并行探索：谁来干活

plan mode 的探索阶段，各家对「是否派子 agent、派几个」差异显著。

| Agent | 用子 agent？ | 类型 | 并发数 | 限制 |
|-------|:---:|------|:---:|------|
| **Claude Code** | ✅ | `Explore`（Phase 1）+ `Plan`（Phase 2） | Explore: 1-3 / Plan: 1-3 | 受套餐控制（免费 1，Max/Ent 3）；env var 可覆盖 |
| **ZCode** | ✅ | `Explore`（仅 Phase 1） | 最多 3 | 固定 3，无套餐分层 |
| **Qwen Code** | ⚠️ 可选 | 「via agents when appropriate」 | 未限定 | 主打自己直接用 read_file/grep/glob |
| **OpenCode** | ✅ | explore subagent（Phase 1）+ general agent（Phase 2） | explore ≤3 / general ≤1 | |
| **Codex** | ❌ | 自己探索（无 subagent） | N/A | 靠 shell 工具直接探索 |
| **Aider** | ❌ | 无 | N/A | 单模型单轮 |

**Claude Code 的双层 subagent 是独有设计**：Phase 1 用 `Explore`（haiku 模型，快速廉价，只读搜索）扫清全局，Phase 2 用 `Plan`（继承主模型，架构设计）出方案。两层都用 `omitClaudeMd: true`（不加载 CLAUDE.md 上下文）和只读工具集。

ZCode 照搬了 Explore 层但砍掉了 Plan 层（Phase 2 自己做设计）。

---

## 五、退出与审批：计划怎么提交、谁来批准

### 5.1 退出工具对比

| Agent | 工具名 | 如何提交计划 | 需要用户确认？ |
|-------|-------|------------|:---:|
| **Claude Code** | `ExitPlanMode` | 工具读 plan 文件（不传参） | ✅ 弹窗 Approve/Reject，可带 feedback |
| **ZCode** | `ExitPlanMode` | 工具传 `plan` 参数 | ✅ "Plan" header + "Approve" 按钮 |
| **Qwen Code** | `exit_plan_mode` | 工具传 `plan` 参数 | 视情况（见下） |
| **OpenCode** | `plan_exit` | 读 plan 文件 | ✅ "switch to build agent?" |
| **Codex** | 无退出工具 | 输出 `<proposed_plan>` 标签 | 用户手动 `/plan` 切换 |
| **Aider** | 无工具 | architect 输出自然语言 | ✅ "Edit the files?" |

**Claude Code 的独特设计**：ExitPlanMode 工具**不接受 plan 内容参数**，而是从预先写好的 plan 文件读取。这强制模型必须先写文件再退出，保证 plan 已持久化。ZCode 相反——plan 作为参数直接传。

### 5.2 Qwen Code 的三路退出决策（最复杂）

Qwen Code 的 `exit_plan_mode` 根据进入方式走不同路径：

| 进入方式 | 退出行为 | 用户参与？ |
|---------|---------|:---:|
| **用户手动进入**（Shift+Tab / `/plan`） | 弹确认 UI，4 种 outcome（RestorePrevious/ProceedAlways/ProceedOnce/Cancel） | ✅ |
| **模型自主进入 + 原模式 AUTO/YOLO** | 跑 **Plan Approval Gate**（LLM-as-judge），返回 approved/blocked/needs_user/cap_escalation | ❌ 自动 |
| **Plan-required teammate** | leader agent 审批 | 视 leader |

**Plan Approval Gate 是 Qwen Code 独有**：用一个独立的 LLM 评审 plan 质量，`blocked` 时把评审 findings 回传让模型修订重试。这是唯一支持「无用户交互自动审批」的设计，面向 autonomous 场景。

### 5.3 Codex 的 `<proposed_plan>` 协议

Codex 不用退出工具，而是约定模型把最终计划包在标签里：

```
<proposed_plan>
plan content (Markdown)
</proposed_plan>
```

规则：
- 每个 turn 最多一个 `<proposed_plan>` 块
- 只有计划完整时才输出
- 用户看到后自行决定切换模式
- 若用户继续在 Plan mode 要求修改，新的 `<proposed_plan>` 必须是完整替换

### 5.4 审批后的衔接语

**Claude Code / ZCode**（注入给模型，衔接 plan→执行）：

```
User has approved your plan. You can now start coding. Start with updating your
todo list if applicable.
## Approved Plan:
<plan 内容>
```

拒绝时：

```
[Plan Rejected] Please revise your plan based on the feedback and call ExitPlanMode again.
```

**Aider**（不注入衔接语，直接切换 coder）：

architect 输出方案 → 用户确认 → 新建 editor_coder，清空对话历史，把方案作为唯一输入 → editor 用 SEARCH/REPLACE 提示词执行。architect 上下文被回填 "I made those changes to the files."

---

## 六、只读约束的执行层：提示词 vs 权限层

这是设计哲学的根本分歧——靠模型自觉，还是靠系统硬拦？

| Agent | 提示词约束 | 权限层硬拦截 | 主防线 |
|-------|:---:|:---:|------|
| **OpenCode** | ✅（最强措辞） | ✅ `edit: { "*": "deny" }` | **权限层**（提示词辅助） |
| **Claude Code** | ✅ | ✅ 工具级 readOnly 检查 | **两者并重** |
| **ZCode** | ✅ | ✅ `checkPlanMode`（readOnly + !destructive） | **两者并重** |
| **Qwen Code** | ✅ | ✅ `isPlanModeBlocked()` 拦截非只读工具 | **两者并重** |
| **Codex** | ✅ | ⚠️ 仅 `update_plan` 硬拦截 | **提示词**（soft constraint） |
| **Aider** | ❌ | ❌ architect 本就要描述改动 | N/A |

**Codex 是唯一主要靠提示词约束的**：plan mode 下 `apply_patch` 和 `shell` 工具仍然注册可调用，靠 plan.md 里 "You must not perform mutating actions" 的分类引导（Allowed = non-mutating / Not allowed = mutating）。只有 `update_plan`（TODO 工具）被硬拒绝。

**OpenCode 是唯一权限层为主的**：plan agent 的 permission ruleset 直接 `edit: deny *`（除 plans 目录），即使模型尝试调用 edit 工具也会被权限系统拒绝。提示词里的「STRICTLY FORBIDDEN」只是辅助。

### Codex 的 mutating vs non-mutating 分类（独有）

Codex 没有笼统说「不准改」，而是给了精确分类：

**Allowed（non-mutating, plan-improving）**：
- Reading/searching files, configs, schemas, types, manifests, docs
- Static analysis, inspection, repo exploration
- Dry-run commands（不编辑 repo 文件）
- Tests/builds（可写 cache/build artifacts，如 `target/`、`.cache/`，只要不改 repo 文件）

**Not allowed（mutating, plan-executing）**：
- Editing/writing files
- Formatters/linters that rewrite files
- Patches, migrations, codegen
- Side-effectful commands whose purpose is carrying out the plan

> 这个分类比「只读」更精确——它允许跑测试（可能写 cache），只要不碰 repo 追踪的文件。其他家基本都是笼统的「只读」。

---

## 七、提示词注入机制：放哪、多久注入一次

### 7.1 注入位置

| Agent | 注入到哪 | 形式 |
|-------|---------|------|
| **Claude Code** | user 消息流的 attachment | `<system-reminder>` 包裹的 meta user 消息 |
| **ZCode** | user 消息流 | `<system-reminder>` |
| **Qwen Code** | system reminder 数组 | `<system-reminder>` |
| **OpenCode** | **最后一条 user message 的 parts** | synthetic text part（非 system！） |
| **Codex** | developer message | `<collaboration_mode>` 标签包裹 |
| **Aider** | system message 主体 | architect 的 `main_system` |

**OpenCode 的反直觉设计**：提示词不放在 system message，而是作为 user message 的 synthetic part 注入。原因：绕过部分模型对 system message 的缓存/忽略行为，确保每轮强制刷新约束。

### 7.2 注入频率（节流策略）

| Agent | 策略 | 省 token？ |
|-------|------|:---:|
| **Claude Code** | 每 5 轮评估，full/sparse 交替（`(count+1) % 5 === 1` 用 full）；距上次 < 2 轮不注入 | ✅ 最精细 |
| **ZCode** | 每 5 轮，full/sparse 交替（`(count+1) % 5 === 1` 用 full） | ✅ |
| **Qwen Code** | 每轮注入（无节流） | ❌ |
| **Codex** | 每轮注入（mode 状态常驻） | ❌ |
| **OpenCode** | 每轮注入（除非上一条 assistant 已是 plan agent） | ⚠️ 部分 |

**Claude Code 的节流最精细**：`TURNS_BETWEEN_ATTACHMENTS=5`（距上次 < 5 轮不注入）+ `FULL_REMINDER_EVERY_N_ATTACHMENTS=5`（每 5 次注入中 1 次完整版，4 次精简版）。这意味着长对话里大部分轮次不重复注入，大幅省 token。

精简版（sparse）示例（Claude Code）：

```
Plan mode still active (see full instructions in conversation). Read-only except
plan file (~/.claude/plans/xxx.md). Follow 5-phase workflow. End turns with
AskUserQuestion (for clarifications) or ExitPlanMode (for plan approval). Never
ask about plan approval via text or AskUserQuestion.
```

> 一句话替代完整版的整段 5 阶段说明，引用「see full instructions in conversation」让模型回看历史。

---

## 八、plan 文件持久化

| Agent | 是否持久化 | 路径 | 跨会话恢复？ |
|-------|:---:|------|:---:|
| **Claude Code** | ✅ | `~/.claude/plans/<slug>.md` | ✅ `plan_mode_reentry` 提示词处理 |
| **ZCode** | ✅ | `.zcode/plans/plan-<sessionId>.md` | ✅ 注入 plan 文件引用 reminder |
| **OpenCode** | ✅ (experimental) | `.opencode/plans/<created>-<slug>.md` | ✅ build-switch 时引用 |
| **Codex** | ❌ | N/A（`<proposed_plan>` 在对话流里） | ❌ |
| **Qwen Code** | ❌ | N/A | ❌ |
| **Aider** | ❌ | N/A（方案在对话里） | ❌ |

**Claude Code 的 reentry 设计最完整**：重新进入 plan mode 时，若 plan 文件已存在，注入专门提示词：

```
## Re-entering Plan Mode
You are returning to plan mode after having previously exited it. A plan file
exists at <path> from your previous planning session.
Before proceeding with any new planning, you should:
1. Read the existing plan file to understand what was previously planned
2. Evaluate the user's current request against that plan
3. Decide how to proceed:
   - Different task: start fresh by overwriting
   - Same task, continuing: modify the existing plan
4. Always edit the plan file one way or the other before calling ExitPlanMode
```

> 这解决了「用户改主意回来继续规划」的场景——其他家大多没有这个处理。

---

## 九、Aider 的独特定位：不是 plan mode，是「分工」

Aider 的 architect mode 与其他家的 plan mode 本质不同：

| 维度 | Plan Mode（CC/ZCode/Qwen/Codex/OpenCode） | Aider Architect Mode |
|------|------------------------------------------|---------------------|
| 目的 | 规划方案待用户审批后再执行 | 把推理和编辑分给两个模型 |
| 迭代 | 多轮探索 + 提问 + 修订 | 单轮，无迭代 |
| 产出 | 计划文档 / `<proposed_plan>` | 自然语言方案（给 editor 模型看） |
| 格式约束 | 无（自由文本） | 无（`system_reminder=""`） |
| 执行者 | 同一个 agent（审批后继续） | **另一个模型**（editor_model） |
| 用户角色 | 审批计划 | 确认 "Edit the files?" |

Aider 的核心论点（来自官方博客）：**把"代码推理"和"代码编辑"分离**。强推理模型（如 o1）擅长方案但不擅长精确 diff 格式；便宜模型擅长格式。组合后 benchmark 超过任一模型单独工作。

architect 的 `main_system` 角色定位也完全不同：

```
Act as an expert architect engineer and provide direction to your editor engineer.
The editor engineer will rely solely on your instructions, so make them unambiguous
and complete.
```

> 注意是「provide direction to your editor engineer」——architect 不是对用户说话，而是对下游的 editor 模型下达指令。这是双模型协作的契约。

---

## 十、Crush：为什么没有 plan mode

Crush 的默认 prompt 里有两条**直接否定** plan-only 行为的指令：

```
2. BE AUTONOMOUS: Don't ask questions - search, read, think, decide, act.
```

```
Responding with only a plan, outline, or TODO list (or any other purely verbal
response) is failure; you must execute the plan via tools whenever execution is
possible.
```

Crush 的设计哲学是 **autonomous by default + per-call approval**：
- 默认直接执行（不先规划）
- 每次修改类工具调用弹窗三选一（Allow / Allow for Session / Deny）
- YOLO 模式（`ctrl+y`）全局跳过审批

这与 plan mode 的理念正相反——plan mode 假设「先规划能避免浪费」，Crush 假设「直接做 + 逐步审批更高效」。

---

## 十一、总结：如果你要设计 plan mode，该学谁

### 按需求场景选参考

| 你的需求 | 参考 | 原因 |
|---------|------|------|
| **通用 plan mode（主流设计）** | Claude Code | 最完整、最成熟，5 阶段 + 双 subagent + 节流 |
| **轻量实现（快速跟进）** | ZCode | CC 的精简版，去掉 Plan subagent 层 |
| **autonomous 场景（无用户交互）** | Qwen Code | Plan Approval Gate 自动审批 |
| **精确控制只读边界** | Codex | mutating/non-mutating 分类比「只读」更实用 |
| **权限硬约束（不信任模型）** | OpenCode | permission ruleset 为主防线 |
| **双模型分工（推理强但格式弱）** | Aider | architect + editor 分离 |
| **不需要 plan mode** | Crush | autonomous + per-call approval |

### 优秀设计模式提炼

1. **先探索后提问**（Codex/Qwen Code）：减少用户负担，能从代码答的不问用户
2. **full/sparse 交替节流**（Claude Code）：长对话省 token，精简版引用历史
3. **plan 文件持久化 + reentry**（Claude Code）：支持跨会话继续规划
4. **mutating/non-mutating 精确分类**（Codex）：允许跑测试写 cache，比笼统「只读」更实用
5. **双层 subagent**（Claude Code）：Explore（廉价快速）+ Plan（继承主模型）分离
6. **退出工具读文件而非传参**（Claude Code）：强制 plan 先持久化再提交
7. **Plan Approval Gate**（Qwen Code）：LLM-as-judge 自动审批，面向 autonomous

### 要避免的设计

1. **每轮注入完整 reminder 不节流**（Qwen Code）：长对话 token 浪费严重
2. **只靠提示词不靠权限层**（Codex）：模型可能违反「不准 mutating」
3. **无 plan 文件持久化**（Codex/Qwen Code）：无法跨会话恢复
4. **笼统「只读」不分类**（多数家）：模型不知道跑测试算不算违规
5. **工作流阶段过多过死**（Claude Code 5 阶段）：简单任务强制走流程是负担（CC 靠 EnterPlanMode 的 when-to-use 判断来缓解）

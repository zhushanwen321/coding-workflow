# lite-plan vs 各家 Plan Mode：优化改进建议

> 基于对 7 家 coding agent plan mode 的调研（见 `COMPARISON.md`），对比当前系统的 `lite-plan` skill，提出可落地的优化建议。
>
> **前提判断**：lite-plan 与各家 plan mode **定位不同**——lite-plan 是「小功能计划生成器」（产出 plan.md + plan.json 过 CW gate），各家 plan mode 是「只读规划对话状态」（探索 + 提问 + 产出计划待审批）。两者不是同一层东西。但 lite-plan 的**规划质量**可以从各家的提示词设计中借鉴。

---

## 一、定位差异：lite-plan 是什么，各家 plan mode 是什么

| 维度 | lite-plan | 各家 plan mode（Claude Code / Codex / Qwen Code 等） |
|------|-----------|-----------------------------------------------------|
| 本质 | **计划文档生成器**（一次性产出 plan.md） | **会话状态**（进入后持续只读，多轮探索+提问） |
| 生命周期 | 单次（写完 plan.md → cw(plan) → 结束） | 持续（进入 → 探索 → 提问 → ExitPlanMode → 退出） |
| 交互模型 | 主 agent 线性执行 7 步 | 模型自主决定何时探索、何时提问、何时退出 |
| 只读约束 | 无（lite-plan 本身不改代码，靠工作流定位） | 核心（提示词 + 权限层双重强制） |
| 产出 | plan.md（7 章节）+ plan.json | 计划文档 / `<proposed_plan>` / 对话中的方案 |
| 审批 | CW plan gate（机器检查） | 用户审批（ExitPlanMode 弹窗） |
| 测试设计 | **重中之重**（4 个章节 + ensemble） | 多数家不涉及（交给执行阶段） |

**结论**：lite-plan 不能照搬 plan mode 的「只读约束」「退出工具」「reminder 节流」——这些是会话状态机制，lite-plan 是单次文档生成。**可借鉴的是规划方法论**：怎么探索、怎么提问、怎么保证计划质量。

---

## 二、lite-plan 已经做得好的地方（各家反而没有）

在提优化前，先明确 lite-plan 的既有优势——这些是各家 plan mode 普遍缺失的：

### 2.1 测试设计深度（lite-plan 碾压级优势）

lite-plan 用 4 个章节 + 4 层 ensemble 保证测试质量：
- 单测清单（AC 级可判定）+ E2E 清单（mock/real 分层）+ 覆盖率 gate
- fixture 对齐（预期值对照真实数据，不正向猜）
- 同源盲区反向自检（从数据集/调用方反推，不从功能描述正向推）
- 多路 ensemble 找漏用例 + 禁读重建三态 diff

**各家对比**：Claude Code / Codex / Qwen Code 的 plan mode **完全不涉及测试设计**——它们只规划「做什么」，测试交给执行阶段。Aider architect 连测试都不碰。lite-plan 的测试设计深度是独有的。

### 2.2 复用检查显式化

lite-plan 步骤 2 [MANDATORY] 要求先查 codebase 是否有可复用代码，判据明确（重复 ≥3 处才抽象，YAGNI）。

**各家对比**：只有 Claude Code Phase 1 提到「Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist」，但只是一句话，没有 lite-plan 的判据和 ensemble 机制。

### 2.3 范围守门

lite-plan 步骤 0 有 5 条判据自检 + ensemble 投票，防止 lite 误用 full 场景。

**各家对比**：Claude Code 的 EnterPlanMode 工具有 when-to-use / when-not-to-use 决策树，但没有 lite-plan 这种 ensemble 投票机制。

### 2.4 Wave 拆分 + 依赖推导

lite-plan 有完整的垂直切片模型 + 文件影响集依赖推导 + 并行安全性自检。

**各家对比**：各家 plan mode 都不涉及执行编排（Wave/依赖/并行），这是 lite-plan 独有的「计划→执行」桥接设计。

---

## 三、优化建议（按优先级排序）

### 🔴 P0：值得借鉴的改进

#### 3.1 引入「先探索后提问」的显式规则

**问题**：lite-plan 步骤 1 写「读代码理解现状，与用户澄清业务目标」，但没有规定**探索和提问的先后顺序**。主 agent 可能刚读了两行代码就问用户「你想怎么做」，也可能探索了半天才问。顺序不明导致提问质量不稳定。

**各家做法**：
- **Codex 最显式**：「Before asking the user any question, perform at least one targeted non-mutating exploration pass... unless no local environment/repo is available」——强制先探索后提问
- **Qwen Code**：「Never ask what you could find out by reading the code」
- **Codex 的两类未知分类**（独有，最值得借鉴）：
  - **Discoverable facts**（代码能答的）：先探索，只有「多个候选/找不到」才问用户
  - **Preferences/tradeoffs**（代码答不了的）：早问，给 2-4 个选项 + 推荐默认值

**建议**：在 lite-plan 步骤 1 增加「探索-提问优先级」规则：

```markdown
### 步骤 1：探索与澄清（先探索后提问）

[MANDATORY] 澄清问题前先探索代码。把识别到的需澄清问题二分类：

**Discoverable（代码能答的）**——不问用户，自己 grep/read 找答案：
- 「这个函数在哪」「项目用什么测试框架」「有没有类似的 X」
- 只有「多个候选都合理」或「找不到但需要」才升级问用户

**Preferences/tradeoffs（代码答不了的）**——问用户，但给选项：
- 「用方案 A 还是 B」「阈值设多少」「这个边界算不算」
- 提问时附 2-4 个选项 + 推荐默认值，不开放问

规则：主 agent 先完成一轮探索（读关键文件），识别哪些问题真的需要问用户，
再批量提问。不读代码就提问 = 把探索成本转嫁给用户。
```

**收益**：减少用户负担，提高提问质量（问的都是真问题），与 lite-plan 的「并行加速模式」天然兼容（探索后才知哪些是细节性歧义可并行）。

---

#### 3.2 引入 Codex 的「decision complete」标准

**问题**：lite-plan 的 Self-Check 检查「业务目标有可衡量成功标准」「技术改动点是文件级清单」，但没有检查**计划是否完整到可零决策执行**。plan.md 可能通过了 gate 但留下隐含决策点（「这里到时候看情况」「这个值执行时再定」），到 coding-execute 阶段 implementer 才发现要回头问。

**各家做法**：Codex 的最终目标定义——「It must be **decision complete**, where the implementer does not need to make any decisions」：

```
Once intent is stable, keep asking until the spec is decision complete:
approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes,
testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.
```

**建议**：在 lite-plan Self-Check 增加一条「decision complete」检查：

```markdown
计划完整性：
- [ ] plan.md decision complete——coding-execute 的 implementer 读 plan.md 后
      不需要做任何业务/技术决策即可开始 TDD。检查：
  - 每个技术改动点的职责明确（不写「待定」「看情况」）
  - 输入/输出的关键值已确定（不留给执行阶段猜）
  - 边界条件在测试用例里已具化（不在执行时才发现「这个 case 没考虑」）
  - 若有无法确定的决策点 → 显式标 [需用户确认] 并在 plan.md 列出，不默默留坑
```

**收益**：减少 plan→execute 的返工。plan gate 检查结构完整性，decision complete 检查语义完整性。

---

#### 3.3 强化「批量提问」规则

**问题**：lite-plan 步骤 1 的并行加速模式提到「ask_user 批量提问（1-4 个）」，但这是并行模式的附带行为，不是通用规则。非并行模式下主 agent 可能逐个提问，每轮等用户响应，效率低。

**各家做法**：
- **Qwen Code**：「Batch related questions together (use multi-question ask_user_question calls)」
- **Codex**：request_user_input 工具支持一次提多个多选题
- **Claude Code**：AskUserQuestion 工具设计就是批量提问

**建议**：把「批量提问」提升为步骤 1 的通用规则（不限并行模式）：

```markdown
[MANDATORY] 澄清问题批量提出，不逐个问。主 agent 完成探索后，把所有需澄清
问题收集起来，一次 ask_user(action='add') 批量提交（1-4 个）。每轮等用户响应
只问一个问题 = 把多轮往返成本强加给用户。
```

> 这条 lite-plan 已经在并行模式里隐含了，只需提升为通用规则。

---

### 🟡 P1：值得考虑的改进

#### 3.4 引入 Claude Code 的「reminder 节流」思路到长 plan 生成

**问题**：lite-plan 在复杂小功能（改动点 ≥3）时，会触发多个 ensemble（0b 范围 / 2b 复用 / 4b 测试 / 5b 禁读重建），加上并行加速模式的 2 路 bg subagent。主 agent 需要在多个步骤间维持上下文（步骤 1 探索结果 → 步骤 2 改动点 → 步骤 3 Wave → 步骤 4 测试），上下文容易膨胀。

**各家做法**：Claude Code 的 full/sparse 交替——完整版只在每 5 轮注入 1 次，其余 4 次用一句话精简版引用历史。这虽是会话状态机制，但思路可借鉴。

**建议**：这不是直接照搬，而是启发——lite-plan 的 ensemble 派发模板里，可以更精简地传递上下文（只传当前步骤必需的，不传完整探索结果）。当前模板已经做得不错（每个 bg subagent 只给「本路切入点材料」），可进一步检查是否有过度传参。

**收益**：边际，当前设计已较好。列为观察项。

---

#### 3.5 引入 OpenCode 的「权限层兜底」思路到 CW gate

**问题**：lite-plan 的 Self-Check 有 [MANDATORY] 预检门，但它是**提示词级**的——主 agent 可能跳过自检直接调 cw(plan)，靠 CW gate 的 machine check 兜底。这和 Codex 的「只读约束靠提示词」是同一个问题。

**各家做法**：OpenCode 的 plan mode 权限层 `edit: deny *` 是硬约束，不靠模型自觉。

**建议**：CW gate 的 machine check 已经是权限层兜底（杀结构硬伤），这个设计是对的。可强化的是——把 Self-Check 里**机器可判的项**尽量迁移到 CW gate 自动检查，减少主 agent 自觉性依赖。

当前 CW gate 已覆盖 5/7 项（结构/Wave/测试字段/覆盖率），Self-Check 里机器可判的项（如「每个改动点有对应单测」「E2E 标测试层」）可考虑纳入 gate 自动检查。

**收益**：减少「自检跳过 → gate fail → 重试」的空转轮次（lite-plan 文档已提到实测反复 fail 3 轮的教训）。

---

#### 3.6 引入 Codex 的「mutating/non-mutating 分类」到测试设计

**问题**：lite-plan 的测试分 mock/real 两层，但没区分「测试本身是否会产生副作用」。有些 real 层 E2E 可能写数据库、发请求、改文件，跑完污染环境。

**各家做法**：Codex 的 plan mode 明确分类：
- Allowed: 「Tests/builds that may write to caches or build artifacts (target/, .cache/) so long as they do not edit repo-tracked files」
- Not allowed: 「Side-effectful commands whose purpose is carrying out the plan rather than refining it」

**建议**：在 lite-plan 的 E2E 用例清单增加「副作用标注」：

```markdown
E2E 用例每条标：
- 测试层（mock/real）
- 副作用（none/cache-only/mutating）——mutating 的需标注清理策略
```

**收益**：执行期 test-runner 知道哪些用例需要环境隔离/清理，避免 E2E 互相污染。

---

### 🟢 P2：了解但不必照搬的设计

#### 3.7 Plan 文件持久化 + reentry（Claude Code）

Claude Code 的 plan 文件支持跨会话恢复，重新进入时有 reentry 提示词处理。

**对 lite-plan 的适用性**：lite-plan 的 plan.md 本身就是持久化的（`.xyz-harness/{slug}/plan.md`），CW 状态机也支持跨 session 续接。这个设计 lite-plan 已有，不需额外借鉴。

#### 3.8 Plan Approval Gate / LLM-as-judge（Qwen Code）

Qwen Code 的 Plan Approval Gate 用独立 LLM 评审计划质量，面向 autonomous 场景。

**对 lite-plan 的适用性**：lite-plan 的 5b 禁读重建已经是一种 LLM-as-judge（fresh subagent 独立审查）。Qwen 的 gate 是自动审批决策，lite-plan 的禁读重建是找 gap 补充，定位不同。暂不需照搬。

#### 3.9 双层 subagent（Claude Code Explore + Plan）

Claude Code 用 Explore（haiku 廉价快速）+ Plan（继承主模型）两种 subagent。

**对 lite-plan 的适用性**：lite-plan 的并行加速模式已用 planner + general-purpose 两种 agent 分工，思路类似。不需额外借鉴。

#### 3.10 只读约束措辞（OpenCode 全大写 + 逐工具点名）

**对 lite-plan 的适用性**：lite-plan 不是会话状态，不需要只读约束措辞。不适用。

---

## 四、不建议照搬的设计（各家也有坑）

### 4.1 Qwen Code 的每轮注入不节流

Qwen Code plan mode 每轮注入完整 reminder，长对话 token 浪费严重。lite-plan 是单次文档生成，不存在此问题，但如果未来扩展为持续规划会话，要避免这个坑（学 Claude Code 的 full/sparse 交替）。

### 4.2 Codex 的只读约束纯靠提示词

Codex 的 plan mode 下 `apply_patch`/`shell` 仍可调用，靠提示词约束「must not perform mutating actions」。这是 soft constraint，模型可能违反。lite-plan 的 CW gate machine check 是更强的约束，不应退化到纯提示词。

### 4.3 Aider 的单轮无迭代

Aider architect 是单轮产出方案，无探索/提问/迭代。这适合双模型分工场景，不适合 lite-plan（lite-plan 需要探索+澄清+测试设计，单轮做不到质量）。

---

## 五、总结：优化优先级矩阵

| 建议 | 优先级 | 改动量 | 预期收益 | 来源 |
|------|:---:|:---:|---------|------|
| 3.1 先探索后提问 + 两类未知分类 | 🔴 P0 | 中 | 减少用户负担，提问质量↑ | Codex / Qwen Code |
| 3.2 decision complete 检查 | 🔴 P0 | 小 | 减少 plan→execute 返工 | Codex |
| 3.3 批量提问通用化 | 🔴 P0 | 小 | 减少往返轮次 | Qwen Code / Codex |
| 3.4 ensemble 上下文精简 | 🟡 P1 | 小 | 边际，当前已较好 | Claude Code 节流思路 |
| 3.5 机器可判项迁入 CW gate | 🟡 P1 | 中 | 减少 gate fail 空转 | OpenCode 权限层思路 |
| 3.6 E2E 副作用标注 | 🟡 P1 | 小 | 执行期环境隔离 | Codex mutating 分类 |
| 3.7-3.10 其他 | 🟢 P2 | — | 已有或不适用 | — |

### 落地建议

**第一批（P0，立即改）**：3.1 + 3.2 + 3.3，改动集中在 lite-plan 步骤 1 和 Self-Check，不涉及 reference 文件结构变更。

**第二批（P1，后续迭代）**：3.5 需改 CW gate 机器检查逻辑（跨包改动），3.6 需改 plan-template.md 和 test-case-schema.md。

**不要改**：lite-plan 的测试设计深度（4 章节 + ensemble）、复用检查、范围守门、Wave 模型——这些是各家反而缺失的既有优势，保持。

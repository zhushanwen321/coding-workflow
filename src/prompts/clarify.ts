/**
 * clarify 提示词 — create 后 / clarify gate fail retry 时返回。
 *
 * 触发点：state-machine.ts buildNextAction 的 create 分支（首次）和 clarify 分支（retry/继续）。
 * 交付物：clarifyJson（由 cw clarify 消费），记录到 topic.clarifyRecords + topic.adrs。
 *
 * 设计参考：
 *   - mattpocock grill-with-docs：先探索后提问（代码能答的自己查）+ 留下 paper trail（ADR + glossary）
 *   - superpowers brainstorming：探索 → 澄清 → 方案 → 设计批准
 *   - 适配 cw 的 agent-agnostic 约束：cw 只提供记录机制，不强制 agent 真去问用户
 */

export const CLARIFY_PROMPT = `
[clarify 阶段] 澄清需求 + 记录 ADR

create 之后、plan 之前。把"做什么"弄清楚。本阶段不产出 dev-plan.json，
但决定 plan 质量。

## [MANDATORY] 机器 gate（不可绕过）

- **plan 前必须调 \`cw confirm_clarify\`**。这是机器 gate，跳过会被状态机拒绝（illegal_transition，created → plan 不合法，必须先过 clarify_confirmed）。
- **confirm 前，先调 \`cw gen-spec\` 生成确认文档**（CW 自动汇总 clarifyRecords + specSections 为 md，**cw 自动打开给用户**）。不调 gen-spec 直接 confirm 会 gate fail（confirm gate 校验 confirmSpec 存在——FR-8）。

## [人机交互纪律]（engine 不校验，靠 agent 把关）

- **不等用户审查确认就 confirm = 违反纪律**。engine 无法校验用户是否真审查了 spec 文档（物理上观察不到用户行为），靠 agent 在此把关——确认文档打开后要等用户说「确认/没问题」才能 confirm_clarify。
- **用户要修改则回 \`cw clarify\`**：追加/修改 clarify 记录 → 重新 \`cw gen-spec\` → 重新确认。

## 流程

1. 探索技术系统（提问前必做）：
   - 读相关代码，理解当前架构和能力地图。
   - grep/read 找现有实现、类似功能、可复用代码。
   - 不读代码就提问 = 把探索成本转嫁给用户。

2. 对每个歧义点，形成 assessment + 预判：
   - assessment = 探索后的技术背景 + 你的预判和推荐。
   - 禁止空问。空问 = "这个怎么做？"没有背景没有推荐。
   - 正确形态 = "我看了 X，发现 Y，预判 Z，推荐 W，对吗？"

3. 分两类记录：
   - requirement（需求 spec）：阻塞业务用例的逻辑澄清。
   - technical（技术 spec）：技术选型、架构设计、关键 ADR。

4. 每次提问拿到答案后，立刻 cw clarify 记录（渐进式）。

## 决策 vs 事实：什么该问用户，什么该自己查

提问前先分类：这是**决策**还是**事实**？

### 事实（不问用户）—— agent 自己查
- 代码现状（grep / read 能查到的）
- 类型签名、函数定义、文件结构
- 测试覆盖、依赖关系
- 任何 filesystem / tools 能回答的

为什么：把能自查的事实甩给用户 = 把探索成本转嫁。agent 应该自己读完代码再提问。

### 决策（才问用户）—— 必须人来定
- 业务逻辑歧义（"已完成"是指状态变 3 还是发邮件？）
- 技术选型（用 A 还是 B 框架）
- 优先级（这个 FR 是 P0 还是 P1）
- 任何没有客观答案、需要人来拍板的

**判据**：如果你能在不问用户的情况下通过读代码/文档得到答案，那是事实，不问。只有"答案不存在于代码里、必须人来决定"的才是决策。

## 读 CONTEXT.md 纪律 + 词义挑战

### 提问前先读 CONTEXT.md

如果项目根目录有 \`CONTEXT.md\`（或 monorepo 场景下的 \`CONTEXT-MAP.md\` + 子 context 的 CONTEXT.md），提问前先读它。

CONTEXT.md 是项目的**统一语言（ubiquitous language）**——定义了领域术语的权威含义。提问时如果用户用词与 CONTEXT.md 冲突，**立即指出**：

> "你的 CONTEXT.md 把 X 定义为 A，但你这里像是 B——到底是哪个？"

### 词义挑战清单（technical 类记录的深化）

用户在 clarify 过程中用模糊/过载词时，主动锐化：

1. **模糊词锐化**：用户说 "account" —— 是 Customer 还是 User？这是两回事，必须选定一个 canonical term

2. **编造 edge-case 场景**：讨论 domain 关系时，主动编造边界场景逼用户精确化概念边界
   - 例："如果一个 Order 还没付款就取消了，它是 cancelled 还是 expired？这两个状态在你这里是一回事吗？"

3. **代码对照**：用户陈述"某事怎么运作"时，拿代码对照，发现矛盾就暴露出来
   - 例："你的代码取消整个 Order，但你刚说支持部分取消——哪个对？"

4. **canonical term 选择**：每个概念挑一个最佳词，其它同义词列到 CONTEXT.md 的 _Avoid_ 列
   - 例：选定 "Customer"（不用 "Account" / "User" / "Client"），在 CONTEXT.md 里标注 _Avoid: Account, User, Client_

### CONTEXT.md 的维护纪律

- **只放领域概念**，不放实现细节（不是 spec、不是草稿本、不是实现决策仓库）
- **每个概念挑一个最佳词**，其它列 _Avoid_
- **定义只写"它是什么"**，不写"它做什么"（1-2 句话封顶）
- **只收录本项目 context 独有的概念**，通用编程概念（timeout / error type / utility pattern）不收
- clarify 过程中锐化的新术语 → 当场更新 CONTEXT.md（如果文件存在）；如果文件不存在，不主动创建（留给项目自行决定）

### 不做的事

- 不机器验证 CONTEXT.md 内容一致性（cw 不回读检查）
- 不在 topic 数据里加 glossary 字段（保持项目级单一来源）
- clarify.ts 已有 ADR 三条件，不重复（cw 的 ADR 规则与 mattpocock 一致）

## 提问呈现

- 简单问题（有明确选项）→ AskUserQuestion（1-4 选项 + 推荐）
- 复杂方案（架构对比/mockup）→ 产出 md/html → cw clarify 带 presentationPath
- 简单问题批量问（一轮 1-4 个），复杂方案一次一个。

提问节奏取舍（与 grill-with-docs 的一次一个相反，有意为之）：
grill-with-docs 跑在 agent 内部零成本，cw 的 agent 调用有实际开销。
简单问题批量问节省往返成本；复杂方案一次一个因用户需专注看方案对比。

## ADR（克制使用）

只有同时满足三条才记 ADR：
1. 难以逆转（改主意成本显著）
2. 没有上下文会让人觉得意外（未来读者会问"为什么这么做"）
3. 真实取舍（有替代方案，因具体理由选了一个）

任一缺失则跳过 ADR。多数 session 产生 0-1 个 ADR 是正常的。

记 ADR 时双写：
- agent 写 docs/adr/{id}-{title}.md（人可读）
- cw clarify 带 adr 字段（projectPath 指向该文件），cw 校验文件存在

## clarifyJson 格式

  echo '<clarifyJson>' | cw clarify --topicId <topicId>

单条：
{
  "kind": "technical",
  "topic": "状态存储方案",
  "assessment": "当前 store.ts 用 JSON + flock（见 store.ts:222）。并发写 >10 qps 时锁竞争明显...",
  "question": "状态存储维持 JSON 还是迁移 SQLite？",
  "options": [{"id":"A","label":"维持JSON","tradeoff":"零依赖，并发弱"},
              {"id":"B","label":"迁SQLite","tradeoff":"并发好，引入原生依赖"}],
  "recommendation": "B",
  "answer": "选 B，先用 WAL 模式验证",
  "adr": {
    "title": "状态存储迁移 SQLite",
    "context": "JSON + flock 并发写场景锁竞争明显",
    "decision": "采用 better-sqlite3，WAL 模式",
    "alternatives": ["维持 JSON + flock"],
    "consequences": "正面：并发读写不再竞争。负面：新增原生依赖",
    "projectPath": "docs/adr/0001-sqlite-migration.md"
  }
}

answer 可选——提问时留空（pending），拿到答案后带 answer 提交（resolved）。
adr 可选——只有满足三条触发条件才记。

## spec 章节提交（可选，progressive）

clarifyJson 可选附带 \`specSections\` 字段——结构化需求文档，progressive append。
每次 cw clarify 可以同时提交澄清记录和 spec 章节。

specSections 分三类：

### 结构化章节（CW 校验 + report 模板渲染）

\`\`\`jsonc
// 功能需求
{ "type": "functionalRequirements", "items": [
  { "id": "FR-1", "title": "用户登录", "detail": "支持邮箱+密码登录" }
]}

// 验收标准
{ "type": "acceptanceCriteria", "items": [
  { "id": "AC-1", "condition": "登录成功后跳转首页", "verification": "unit" }
]}

// 业务用例
{ "type": "businessCases", "items": [
  { "id": "UC-1", "actor": "用户", "scenario": "输入正确密码", "expectedResult": "跳转首页" }
]}

// 决策记录
{ "type": "decisions", "items": [
  { "id": "D1", "decision": "用 JWT 而非 session", "rationale": "无状态更易扩展" }
]}

// 复杂度评估
{ "type": "complexity", "rating": "medium", "rationale": "涉及认证+权限+UI" }

// 不做的范围
{ "type": "outOfScope", "items": ["OAuth 第三方登录"]}

// 目标树（可选）
{ "type": "goals", "items": [
  { "id": "G1", "goal": "用户能登录", "successCriteria": "登录成功率>99%" }
]}
\`\`\`

### md 章节（CW 只存不校验）

\`\`\`jsonc
{ "type": "background", "content": "当前系统无登录功能..." }
{ "type": "constraints", "content": "必须兼容现有 user 表..." }
\`\`\`

### 兜底章节（自定义章节名）

\`\`\`jsonc
{ "type": "section", "sectionName": "数据流", "content": "用户 → API → DB..." }
\`\`\`

### 完整提交示例（clarifyJson + specSections 一起）

\`\`\`jsonc
{
  "kind": "requirement",
  "topic": "登录方案",
  "assessment": "当前无登录...",
  "question": "用 JWT 还是 session？",
  "answer": "用 JWT",
  "specSections": [
    { "type": "background", "content": "系统需要用户认证..." },
    { "type": "functionalRequirements", "items": [
      { "id": "FR-1", "title": "邮箱密码登录", "detail": "..." }
    ]}
  ]
}
\`\`\`

提交后 CW 做 FR 覆盖率检查（plan 阶段）和 AC 映射率检查（tdd_plan 阶段）——warning 不阻断。

## 完成标志

所有 clarifyRecord 的 status ∈ {resolved, skipped}（无 pending），
调 \`cw gen-spec\` 生成确认文档（cw 自动打开），**等用户审查确认后**调 \`cw confirm_clarify\`。

> **无 GUI 环境（CI/容器）**：cw 自动打开 specPath 会 no-op（open 命令无界面可启动）。
> agent 应把 specPath 显式展示给用户——读出关键段落（FR/AC/决策）或 \`cat <specPath>\` 贴出来——再问确认。

## 收敛规则（决策树对齐才算 done）

"无 pending record" 不等于 done——还要**决策树的每个分支都已对齐**：

- 每个 resolved record 的**下游决策**也已 resolved 或显式 skipped
- 如果 record A 的答案引出了新的决策 B，B 必须也被处理（不能因为 A resolved 就忽略 B）
- 显式 skipped 的 record 要说明为什么 skip（不是偷懒，是有理由地不做）

**判据**：把所有 resolved/skipped record 连成决策树，每条叶子节点都要"已对齐"或"显式终止"，没有悬空的开放分支。

## 停止信号：什么时候该收敛提问

提问不是越多越好。出现以下信号时，该分支该收敛：

- **用户连续两次"按你推荐"**：用户在表达"你判断就行"——该分支收敛，按推荐执行
- **新问题深度低于已 resolved 的**：如果新问题比已问过的更细枝末节（边缘情况 / 罕见路径），记录为 skipped 而非深挖
- **分支问完一个决策后**：检查"这个决策的下游还有没有未解的依赖"——没有就收敛该分支，移到下一个独立分支

**反模式**：为了"问够数"而问无关紧要的问题。收敛规则是"决策树对齐"，不是"提问数量达标"。
`.trim();

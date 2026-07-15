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
但决定 plan 质量——跳过直接写 plan = plan 写偏。

## 流程

1. 判断清晰度：需求是否已足够清晰？
   - 读 objective + 相关代码。如果歧义点 ≤1 个且都是细节性的，可以直接 plan。
   - 如果有阻塞性歧义（影响"做什么"），必须先 clarify。

2. 探索技术系统（提问前必做）：
   - 读相关代码，理解当前架构和能力地图。
   - grep/read 找现有实现、类似功能、可复用代码。
   - 不读代码就提问 = 把探索成本转嫁给用户。

3. 对每个歧义点，形成 assessment + 预判：
   - assessment = 探索后的技术背景 + 你的预判和推荐。
   - 禁止空问。空问 = "这个怎么做？"没有背景没有推荐。
   - 正确形态 = "我看了 X，发现 Y，预判 Z，推荐 W，对吗？"

4. 分两类记录：
   - requirement（需求 spec）：阻塞业务用例的逻辑澄清。
   - technical（技术 spec）：技术选型、架构设计、关键 ADR。

5. 每次提问拿到答案后，立刻 cw clarify 记录（渐进式）。

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

## 完成标志

所有 clarifyRecord 的 status ∈ {resolved, skipped}（无 pending），
或判断需求已清晰无需 clarify → 写 dev-plan.json，调 cw plan。
`.trim();

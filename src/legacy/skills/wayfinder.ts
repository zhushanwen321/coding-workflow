/**
 * wayfinder skill —— 大工作的决策地图思维（检查清单降级版）。
 *
 * 源：wayfinder 的决策地图方法论（mattpocock 风格），降级为 cw 可承载的纯方法论检查清单。
 *
 * 降级声明（关键）：完整 wayfinder 依赖 issue tracker 机制（map / ticket / label / assignee /
 * native blocking / 并发 session），cw 不提供这些。本 skill 是思维部分的纯文本降级，
 * 用于在 cw 之外（issue tracker / 文档）应用 wayfinder 思维，或判断工作是否该拆成多 cw topic。
 * 完整方案见 wayfinder-positioning.md handoff。
 *
 * 不内化：tracker 机制 / subagent 并发 / 并发 session / throwaway git 分支 / 跨 skill 硬依赖。
 */

import type { SkillEntry } from "./types.js";

/** 检查清单 body（模板字符串，inline code 反引号转义）。 */
const BODY = `# wayfinder：大工作的决策地图思维（检查清单版）

## 适用判断

先问自己：**这个工作是否单 session 装不下 + 路线未清？**

- 如果装得下（单 topic 能 plan 清楚）→ 不需要 wayfinder，正常走 cw 流程
- 如果装不下 + 路线未清（"wrapped in fog"）→ 用本检查清单

## 降级声明（重要）

完整 wayfinder 依赖 issue tracker 机制（map / ticket / label / assignee / native blocking），cw **不提供这些**。本检查清单是 wayfinder 思维的**纯方法论降级版**，用于：
- 在 cw 之外（issue tracker / 文档）应用 wayfinder 思维
- 或者决定"这个工作该拆成多个 cw topic，还是用别的工具"

如果工作确实需要完整 wayfinder（多 session 协作、决策地图、frontier 计算），考虑用 GitHub Issues / Linear 等工具承载 map 和 ticket，cw 只管单个 topic 的实施。

## 核心思想检查清单

规划一个超大超雾的工作时，对照以下 7 条：

### 1. destination 是否 named？
走到 map 的尽头长什么样（spec / decision / change）？用一两行明确写出。每个 session 选下一步前都要对着 destination 定向。

### 2. 是否 breadth-first 扫过 fog？
横扫整个空间找 open decisions，**不是深挖某一根线**。先广度找全所有"需要决定的点"，再逐个深挖。深挖单个线容易错过并行的决策。

### 3. 每个决策单元是否真的是"一个决策"而非"一个构建切片"？
- 决策单元 = 解决后是一个 decision（"用 Stripe 还是 PayPal"）
- 构建切片 = 一段实现工作（"实现支付接口"）
- 如果单元是构建切片，它应该在 cw topic 里做，不是在 wayfinder map 里

### 4. 不能精确陈述的问题是否进了 "Not-yet-specified" 而非预切成 ticket？
判据：**你现在能否精确陈述这个问题——不是能否回答它**。
- 能精确陈述（即使 blocked 不能行动）→ Ticket
- 还不能精确陈述 → Not-yet-specified（fog）

不要把雾预切成 ticket 大小的块——它比 ticket 粗，一块可能 graduate 成多个 ticket 或一个都没有。

### 5. out-of-scope 的工作是否进了独立段？
destination 之外的 work **不是 fog**，是 out-of-scope。有自己的段。
- Scope 边界 = "destination 之内"
- Sharpness = "能否精确陈述"
- Scope 决定工作在不在地图上；sharpness 决定它在地图上哪个段

### 6. 是否 plan-don't-do？
默认只规划，不执行。**想直接做活的冲动通常是已到 map 边界、该 hand off 的信号**。
（可以在 destination 的 Notes 里 override 把执行带进 map，否则只产 decisions 不产 deliverables）

### 7. 是否 refer-by-name？
人类读到的一切（narration / map 的 decisions-so-far）都用**名字（title）**指代 ticket，**绝不**用裸 id / number / slug。
- \`#42, #43, #44\` 一堵墙是不可读的
- id 和 URL 不消失——名字包住它的链接，但永远在名字内部、不能代替名字

## 何时必须回 cw 流程

map 清空后（路清晰、没东西可决定了）→ **必须先折叠成 spec** 再走 cw create。
- 不要直接从 map 跳到实施——map 里的决策散在多个 ticket，需要 spec 把它们整合成连贯的功能描述
- 折叠后的 spec 作为新 cw topic 的 clarify 起点

## map 的 5 段结构（参考，用于在你自己的文档/tracker 里组织）

如果你在 issue tracker / 文档里维护 map，参考这 5 段结构：
1. **Destination**：走到尽头长什么样（spec/decision/change）
2. **Notes**：domain、本 effort 的 standing preferences
3. **Decisions so far**：已解的决策索引（每个一行 gist + link）
4. **Not yet specified**：fog of war——在 scope 内但还无法 ticket 的雾
5. **Out of scope**：被排除在 destination 之外的工作（closed，永不 graduate）

map 是**索引不是仓库**——决策只活在一处（它的 ticket / 文档），map 从不重述，只 gist + link。

## 不做的事

- 不在 cw topic 内部用 wayfinder（cw topic 是单 session 范围，不需要决策地图）
- 不依赖 tracker 机制（cw 不提供 issue / label / assignee / blocking）
- 不并发 session（cw 单进程；完整 wayfinder 的并发需要 tracker 支持）
`;

/** wayfinder skill 完整条目。 */
export const WAYFINDER_SKILL: SkillEntry = {
  name: "wayfinder",
  summary: "大工作的决策地图思维（检查清单版）",
  trigger: "replan 且工作超大超雾 / 单 session 装不下 / 用户主动调用",
  body: BODY,
};

/**
 * improve-codebase-architecture skill —— 找深化机会 + 浅模块识别 + 候选评估。
 *
 * 源：mattpocock skills 的 improve-codebase-architecture/SKILL.md，内化重写为中文，
 * 打包进 dist（agent-agnostic，不依赖本地 skill 文件）。
 *
 * 降级点（相对原文）：
 *   - HTML 报告 + Tailwind/Mermaid CDN + 浏览器打开 → markdown 输出
 *   - subagent Explore 并发调度 → 单进程顺序评估
 *   - Phase 3 grilling loop → 不内化（依赖 cw 的 clarify 阶段）
 *
 * 自创点（原文未给规则，cw 补的 v1 草案）：
 *   - Strong / Worth exploring / Speculative 徽章判定（基于 deletion test 强度 + 热区权重 + locality 收益）
 *
 * 风险：徽章判定标准未经 mattpocock 验证，要在实际 topic 中迭代校准（见 body 末尾说明）。
 *
 * hand-off：
 *   - 发现 hard bug → 调 \`cw skill diagnosing-bugs\`
 *   - 候选选定进入实施 → 走正常 cw create 流程（每个深化候选建 topic）
 */

import type { SkillEntry } from "./types.js";

/** 方法论 body（模板字符串，inline code 反引号转义）。 */
const BODY = `# improve-codebase-architecture：找深化机会 + 浅模块识别 + 候选评估

## 触发场景
- retrospect 阶段（复盘时考虑周期性深化检查）
- 用户主动调用（"想找重构机会 / 合并紧耦合模块 / 让 codebase 更可测"）
- 来自 diagnosing-bugs Phase 6 的 hand-off（修复 bug 后发现"没有好的 test seam / 调用方纠缠 / 隐藏耦合"）

明确排除：找 bug（→ cw skill diagnosing-bugs）、单次改动（不用整个架构评估）。

## 核心思想

找"浅模块"（interface 表面积 ≈ implementation 大小）并深化它们。深化 = 让 interface 变矮、implementation 变高（caller 学一点接口能驱动更多行为）。

## Part 1：探索方法论

### 用 git log 找热区

不指定方向时，walk back 一段 commit history（\`git log --oneline\`），找反复出现的文件——那些是 codebase 的热区，最值得深化。如果改动散落无明显热区，扩大范围再扫。

用户指了方向就直接用，跳过推断。

先读 CONTEXT.md（如存在）和触及区域的 ADRs，了解既有决策。

### 5 个摩擦信号（探索时记录）

有机探索代码库（不跟死板启发式），记录摩擦点：

1. **多模块跳转**：理解一个概念要在多个小模块间反复跳——说明模块边界划错了
2. **shallow 模块**：interface 几乎和 implementation 一样复杂——pass-through，没赚到 keep
3. **纯函数抽出但 bug 在调用方**：纯函数仅为可测性被抽出，但真 bug 藏在调用方式里——locality 失败，变更没集中
4. **跨 seam 泄漏**：紧耦合模块跨 seam 泄漏依赖——seam 是假的
5. **难测部分**：未测试或通过当前 interface 难测的部分——interface 形状挡住了测试

### deletion test（核心判断工具）

对怀疑 shallow 的东西问："**删掉它会集中复杂度，还是只是移动它？**"

- "集中复杂度"（删掉后复杂度在 N 个 caller 里重新冒出来）→ 它在赚自己的 keep，值得存在
- "只是移动"（删掉后复杂度消失，或只是从模块里搬到 caller 里）→ 它是 pass-through，深化候选

### shallow 模块的精确定义

interface 表面积几乎和 implementation 一样大（两个矩形几乎一样高）。深化 = 让 interface 变矮、implementation 变高。

### 词汇强制（审查时必须使用）

只用以下词表描述架构问题（不用模糊词）：

| 术语 | 含义 | 禁用替代词 |
|------|------|-----------|
| module | 任何有 interface + implementation 的东西 | component / service / unit |
| interface | caller 要正确使用模块所必须知道的一切 | API / signature |
| implementation | 模块内部代码体 | （无） |
| depth | interface 处的 leverage | （无） |
| deep/shallow | 接口 leverage 的高低 | （无） |
| seam | 不改原地代码就能改行为的地方 | boundary |
| adapter | 在 seam 处满足 interface 的具体物 | （无） |
| leverage | caller 从深度获得的——每学一单位接口获得更多能力 | （无） |
| locality | 维护者从深度获得的——变更集中在一处 | （无） |

为什么强制词表：consistent language is the whole point——模糊词（component/service/API）会稀释语义。禁用 "easier to maintain" / "cleaner code" 等空话。

## Part 2：候选评估模板

识别出深化候选后，为每个候选填一张卡（输出为 markdown，不要求 HTML）：

每候选 6 项：
1. **Files**：涉及的文件
2. **Problem**：当前问题（用上面的词表描述，含 deletion test 结论）
3. **Solution**：深化方案（interface 怎么变矮、implementation 怎么变高）
4. **Benefits**：用 leverage（caller 收益）和 locality（维护者收益）解释，测试如何改善
5. **Before-After 描述**：文字描述当前形状 vs 深化后形状（不要求画图，但要比喻清晰）
6. **Recommendation 徽章**：Strong / Worth exploring / Speculative（判定见下）

### Strong / Worth exploring / Speculative 徽章判定

基于三个维度（v1 草案，使用中如发现误判请反馈）：

- **deletion test 强度**：强（删掉复杂度重新冒出）/ 弱（只移动）
- **热区权重**：git log 里出现的频次（高/中/低）
- **locality 收益**：变更集中度提升（明显/一般/不明显）

判定：
- **Strong**：三维度都强
- **Worth exploring**：两维度强
- **Speculative**：一维度强或都是弱

### ADR 冲突规则

候选与现有 ADR 矛盾时，**只有当摩擦真实到值得重开该 ADR 才 surface 它**。卡里标记矛盾 + 重开理由（如"contradicts ADR-0007 — but worth reopening because…"）。

不要列出每个 ADR 禁止的理论重构——只列摩擦真实到值得重开的。

## Part 3：候选确定后的 grilling（简述）

用户选定一个候选后，进入 grilling 循环（决策树追问）：
- 约束、依赖、深化后模块的形状
- seam 背后是什么、哪些测试存活
- 边走边更新 CONTEXT.md（新术语沉淀）
- 用户用 load-bearing 理由拒绝候选 → 提议写 ADR（仅在理由会被未来 explorer 需要时）

详细 grilling 方法论见 cw 的 clarify 阶段（收敛规则 + 决策 vs 事实 + 停止信号）。

## 不做的事

- 不写 HTML 报告 / 不用浏览器打开 / 不依赖 CDN（cw 用 markdown 输出）
- 不并发派 subagent（cw 单进程，顺序评估）
- 不直接重构代码（只评估 + 标候选，实施走正常 cw 流程）

## hand-off 条件

- 发现 hard bug → 调 \`cw skill diagnosing-bugs\`
- 候选评估完进入实施 → 走正常 cw create 流程（每个深化候选建 topic）
`;

/** improve-codebase-architecture skill 完整条目。 */
export const IMPROVE_CODEBASE_ARCHITECTURE_SKILL: SkillEntry = {
  name: "improve-codebase-architecture",
  summary: "找深化机会 + 浅模块识别 + 候选评估",
  trigger:
    "retrospect 阶段 / 用户主动调用 / 来自 diagnosing-bugs Phase 6 的 hand-off（修复 bug 后发现架构问题）",
  body: BODY,
};

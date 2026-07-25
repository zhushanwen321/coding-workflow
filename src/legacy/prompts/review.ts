/**
 * review 提示词 — dev 全 committed 后返回，指导 agent 做代码审查 + issue tracking。
 *
 * 触发点：state-machine.ts buildNextAction 的 dev（全 committed）和 review（retry/fix loop）分支。
 * 交付物：review.md + issues（通过 stdin 传入的结构化问题清单），由 cw(review) 消费。
 *
 * review 采用 issue tracking + fix loop：
 * - agent 审查后提交 issues（must-fix/should-fix/nit）
 * - 有 must-fix issue → CW 指向 review_fix → agent 修代码 → review turn 2 复查
 * - 无 issue → CW 指向 test
 * - 最多 3 轮 review（REVIEW_TURN_LIMIT）
 *
 * 步骤 4 裁剪：原硬编码常量 REVIEW_PROMPT 改为参数化函数 buildReviewPrompt(dimensions)。
 * 按 topic.taskShape 声明的 dimensions 子集过滤维度表（delete-only 只看 design-consistency +
 * edge-case，doc-only 只看 design-consistency）。REVIEW_PROMPT 常量保留 = buildReviewPrompt(全 6 维)
 * 的返回值，向后兼容（AC-8 等价性锁定）。
 */

import type { ReviewDimension } from "../types.js";

/**
 * 维度元数据——两处维度表的统一数据源（步骤 4 抽取）。
 *
 * 主表（审查维度）用 id/name/what 三列；说明表（dimension 字段）用 id/name 两列 + 备注。
 * order 即维度在表中的展示顺序，与原硬编码一致（AC-8 等价性要求）。
 */
const ALL_REVIEW_DIMENSION_ROWS: ReadonlyArray<{
  id: ReviewDimension;
  name: string;
  what: string;
  /** 说明表第二列的展示名（主表用 name，说明表用 longerName 补备注）。 */
  longerName: string;
}> = [
  { id: "type-safety", name: "类型安全", what: "禁 any、schema 同步、CwError vs Error 边界、type-only import", longerName: "类型安全" },
  { id: "error-handling", name: "错误处理", what: "catch 不吞异常、exit code 映射、错误消息可读性", longerName: "错误处理" },
  { id: "edge-case", name: "边界条件", what: "空数组/缺字段/非法 JSON/文件不存在", longerName: "边界条件" },
  { id: "test-coverage", name: "测试质量", what: "测试能否发现真 bug（见下方「测试质量审查」专节，不只是覆盖率数字）", longerName: "测试覆盖" },
  { id: "plan-completeness", name: "plan 完成度", what: "dev-plan.json 的 changes 是否全部落地", longerName: "plan 完成度" },
  { id: "design-consistency", name: "设计一致性", what: "spec 的 FR/AC 是否被正确实现（用禁读重建法）", longerName: "设计一致性（核对 spec FR/AC，推荐禁读重建法）" },
];

/**
 * 按 dimensions 子集渲染维度表（主表，3 列：dimension/维度/审什么）。
 * 表头与原硬编码格式一致（AC-8 等价性）。
 */
function renderMainDimensionTable(dimensions: readonly ReviewDimension[]): string {
  const rows = ALL_REVIEW_DIMENSION_ROWS.filter((r) =>
    dimensions.includes(r.id),
  );
  const lines = rows.map(
    (r) => `| \`${r.id}\` | ${r.name} | ${r.what} |`,
  );
  return `| dimension | 维度 | 审什么 |\n|-----------|------|--------|\n${lines.join("\n")}`;
}

/**
 * 按 dimensions 子集渲染维度表（说明表，2 列：dimension/对应维度）。
 * 表头与原硬编码格式一致（AC-8 等价性）。
 */
function renderDimensionFieldTable(
  dimensions: readonly ReviewDimension[],
): string {
  const rows = ALL_REVIEW_DIMENSION_ROWS.filter((r) =>
    dimensions.includes(r.id),
  );
  const lines = rows.map((r) => `| \`${r.id}\` | ${r.longerName} |`);
  return `| dimension | 对应维度 |\n|-----------|----------|\n${lines.join("\n")}`;
}

/**
 * issues 参数章节的 JSON 示例——dimension 字段（步骤 4 去硬编码）。
 *
 * 原 REVIEW_PROMPT 固定用 edge-case（第一个 issue）/ error-handling（第二个 issue）演示，
 * AC-8 等价性要求全 6 维输出必须逐字节复现这两个值。但 AC-7/AC-9 又要求子集模式下不能
 * 出现未声明的维度名——所以示例维度必须从当前 dimensions 子集里取。
 *
 * 取值策略：对每个示例 slot，优先用历史固定值（edge-case → error-handling），仅当固定值
 * 不在子集时才退化为子集首项。这样：
 *   - 全 6 维：edge-case / error-handling（与原 REVIEW_PROMPT 逐字节一致）
 *   - delete-only（design-consistency + edge-case）：edge-case / edge-case（固定值 edge-case 在子集）
 *   - doc-only（design-consistency）：design-consistency / design-consistency（退化）
 */
function pickExampleDimension(
  dimensions: readonly ReviewDimension[],
  preferred: ReviewDimension,
): ReviewDimension {
  return dimensions.includes(preferred)
    ? preferred
    : (dimensions[0] ?? "type-safety");
}

function renderIssuesJsonExample(dimensions: readonly ReviewDimension[]): string {
  const firstDim = pickExampleDimension(dimensions, "edge-case");
  const secondDim = pickExampleDimension(dimensions, "error-handling");
  return `    echo '[
      {
        "severity": "must-fix",
        "dimension": "${firstDim}",
        "description": "store.ts 的 appendReviewIssues 没有做 turn 校验",
        "ref": "src/store.ts:142"
      },
      {
        "severity": "should-fix",
        "dimension": "${secondDim}",
        "description": "错误消息缺用法示例",
        "ref": "src/cli.ts:268"
      }
    ]' | cw review --topicId <topicId> --reviewPath <path>`;
}

/**
 * 禁读重建法段落——design-consistency 维度专用。
 *
 * 仅当 dimensions 含 design-consistency 时渲染整段（含第 38 行"其余维度"列表）。
 * 不含 design-consistency 时该段省略——其余维度直接读代码审查即可，无需"禁读重建"方法。
 *
 * 第 38 行的"其余维度（类型安全/错误处理/...）"列表动态生成——只列当前 dimensions 里
 * 除 design-consistency 之外的维度名，避免列出不存在的维度。
 */
function renderDesignConsistencySection(
  dimensions: readonly ReviewDimension[],
): string {
  if (!dimensions.includes("design-consistency")) {
    return "";
  }
  // 其余维度列表：当前 dimensions 减去 design-consistency，用 name 展示。
  const otherDims = ALL_REVIEW_DIMENSION_ROWS.filter(
    (r) => r.id !== "design-consistency" && dimensions.includes(r.id),
  ).map((r) => r.name);
  const otherDimsText =
    otherDims.length > 0
      ? `其余维度（${otherDims.join("/")}）直接读代码审查即可。`
      : "其余维度直接读代码审查即可。";
  // 返回值不含前导换行、以单个换行结尾——由 designBlock 拼接处统一补空行，
  // 避免 \n\n\n 多空行（AC-8 逐字节等价性：原 REVIEW_PROMPT 此处只有 1 个空行）。
  return `## 审查方法：禁读重建（design-consistency 维度专用）

design-consistency（设计一致性）维度最易漏——直接读实现容易「顺着代码思路走」，
看不出实现偏离了 spec。强制用「禁读重建」对冲：

1. 派一个 fresh subagent，**不读**实现代码
2. 只给它 spec 的 functionalRequirements + acceptanceCriteria
3. 让它从 spec 反查「实现完整性」——每个 FR/AC 对应的代码路径是否存在、行为是否正确
4. 把反查结果与实际实现 **diff**——实现遗漏/偏离 spec 的点就是审查发现

${otherDimsText}
`;
}

/**
 * buildReviewPrompt — 按 dimensions 子集生成 review 提示词（步骤 4 参数化）。
 *
 *   - dimensions 含全 6 维（full-tdd）→ 与历史 REVIEW_PROMPT 逐字节相等（AC-8 等价性）
 *   - dimensions 为子集（delete-only/doc-only）→ 维度表 + 禁读重建段落按子集过滤
 *
 * 主体内容（审查流程、severity 分级、ref 字段、review fix loop、禁止事项）不因子集变化——
 * 这些是流程纪律，与 shape 无关。只维度相关部分（两处维度表 + 禁读重建段）参数化。
 */
export function buildReviewPrompt(
  dimensions: readonly ReviewDimension[],
): string {
  const designConsistencySection = renderDesignConsistencySection(dimensions);
  const mainTable = renderMainDimensionTable(dimensions);
  const fieldTable = renderDimensionFieldTable(dimensions);
  const issuesJsonExample = renderIssuesJsonExample(dimensions);
  // m1: 「取 N 值之一」/「取以下 N 个值之一」按子集真实维度数渲染，避免 delete-only（2 维）/doc-only
  // （1 维）时文案说「6」自相矛盾。全 6 维时 N=6，与原 REVIEW_PROMPT 逐字节一致（AC-8）。
  const dimensionsCount = dimensions.length;

  // AC-8 等价性：design-consistency 段在全 6 维时位于审查流程之后、维度表之前。
  // 模板在此处前已提供 \n\n（<path> 后的空行），designBlock 需以「## 审查方法」开头、
  // 以 \n\n 结尾（与原 REVIEW_PROMPT 「其余维度」后的单个空行对齐）。renderDesignConsistencySection
  // 返回值以单个 \n 结尾，这里再补一个 \n 凑成段落后的空行。子集模式（无 design-consistency）→ 空串。
  const designBlock =
    designConsistencySection.length > 0
      ? `${designConsistencySection}\n`
      : "";

  // 第 1 步文案按是否含 design-consistency 分流——不含时去掉禁读重建法推荐，
  // 避免在子集模式下泄露未声明维度名（AC-7/AC-9）。
  const step1Suffix = dimensions.includes("design-consistency")
    ? "，推荐用禁读重建法查 design-consistency"
    : "";

  return `
[review 阶段] 代码审查 + issue tracking

所有 Wave 已 committed（dev gate 通过）。在进入 test 之前，必须审查代码。

## 审查流程

1. 做代码审查（按下方维度${step1Suffix}）
2. 把发现的问题整理成结构化 issues
3. 写 review.md（含审查结论）
4. 提交：

    echo '<issuesJson>' | cw review --topicId <topicId> --reviewPath <path>

${designBlock}## 审查维度

按以下维度审查（可用 subagent 分工，也可主 agent 自审）。dimension 字段必填，取 ${dimensionsCount} 值之一：

${mainTable}

### 测试质量审查（review 阶段是测试跑之前的最后校验窗口）

test 还没跑，test.json 已在 tdd_plan 阶段定稿。review 是用「已完成的实现」反查「测试设计」的最后机会——
test 一旦跑起来全绿，弱测试会被当成功放过。在此时审查测试设计质量：

- **盲区检查**：实现里有 N 个分支/错误处理，testCase 覆盖了几个？漏的分支在 test 阶段不会被触发
- **防线检查**：如果 testCase 全是 happy path（正常输入 → 正常输出），它们是覆盖率填充，不是 bug 防线
- **对称性检查**：成功路径有守门（如校验输入），失败路径有没有？（如「创建有校验，删除有没有」）

发现问题时的处理：
- 测试设计有盲区 → 补 case 再进 test（replan --test），而非让弱测试全绿通过
- 测试质量 OK → 在 review.md 里说明测试覆盖了哪些风险路径（证明审过而非跳过）

## issues 参数

issues 通过 stdin 传入，是 JSON 数组，每个元素是一个 issue：

${issuesJsonExample}

> 注意：severity 用 \`must-fix\` / \`should-fix\` / \`nit\`（连字符），id 由 CW 自动分配（R1, R2...），不要手填。但提交 issues stdin 时只放 must-fix / should-fix，nit 不进 issues（见下方 severity 分级）。

### severity 分级

| severity | 含义 | 行为 |
|----------|------|------|
| must-fix | 阻断性问题 | 通过 stdin issues 提交；有 must-fix → 进 review_fix 循环 |
| should-fix | 重要但不阻断 | 通过 stdin issues 提交；记录但不阻断流程 |
| nit | 风格/优化建议 | 只写 review.md，不进 issues |

> **discipline（重点）**：只有 must-fix / should-fix 进 issues stdin（机器追踪闭环）；nit 只写在 review.md 里（人可读报告）。
> 原因：nit 是风格/优化建议，进 issue tracking 会占满 turn 上限（3 轮），把真正的 must-fix 挤掉、被强制推到 test。nit 在 review.md 里提就足够让人看到。

**无问题时传空数组**：\`echo '[]' | cw review ...\`。空数组 = 审查通过，直接进 test。

### dimension 字段（必填）

FR-6 升级：原可选的 \`category\` 字段改为必填的 \`dimension\`（命名也更准确——它就是审查维度本身）。
取以下 ${dimensionsCount} 个值之一（对应代码审查维度），用于事后统计 review 盲区分布——看哪些维度漏检最多，反过来校准审查重点。

${fieldTable}

> dimension 必填——不填会被 gate 的 schema 校验拒绝（reviewIssueCheck 逐元素校验）。

### ref 字段（可选）

FR-3 泛化：原 \`file\` 字段（限代码路径）改为 \`ref\`（泛化引用）。代码审查填文件路径（如 \`"src/store.ts:142"\`）。
spec/plan 审查（spec_review/plan_review）填条目 ID（如 \`"FR-3"\` / \`"W2"\`）。三阶段共用此字段。

## review fix loop

\`\`\`
review turn 1: 发现 [R1, R2]
    ↓ CW 指向 review_fix
review_fix: 修 R1 + R2 → commit → 提交修复
    echo '[
      {"issueId":"R1","commitHash":"<sha>","resolution":"加 turn 校验"},
      {"issueId":"R2","commitHash":"<sha>","resolution":"补用法示例"}
    ]' | cw review_fix --topicId <id>
    ↓ CW 指向 review（turn 2）
review turn 2: 复查是否还有新问题
    ↓ 无新问题（echo '[]' | cw review ...）→ 进 test
    ↓ 有新问题 → 继续 review_fix（最多 3 轮）
\`\`\`

**review_fix 的 commitHash 只记录审计，不校验真实性**（不像 dev gate 做存在性+diff 校验）。
这是有意设计：review 修复是代码质量改进，不是功能实现——audit 链足够追溯。

### turn 上限

最多 3 轮 review（初始 + 2 轮 fix 复查）。达上限后 CW 强制进 test，guidance 标注未修复的 must-fix。

## 产出 review.md（必填）

review.md 是必填交付物——与 plan/tdd_plan/retrospect 的文件校验对称，不产出 review.md 一律 gate fail。它是给人类看的审查报告（落 .xyz-harness/<slug>/changes/ 目录）；issues（通过 stdin 传入）是给 CW 的机器可读结构化数据。两者都要提交，缺一不可。

review.md 内容：
- 审查范围（哪些 commit / 文件）
- 发现的问题（表格形式，含 severity + 位置）
- 评分汇总

## 提交命令

    echo '<issuesJson>' | cw review --topicId <topicId> --reviewPath <review.md>

- --reviewPath：review.md 的路径（实际必填——gate 校验文件存在 + 非空，漏传 = gate fail）。与 plan/tdd_plan/retrospect 的文件校验对称，必须写 review.md 并通过 --reviewPath 提交。
- issues：通过 stdin 传入的结构化问题清单（空数组 = 无问题，直接进 test）

gate fail（文件不存在/空）→ 重写后重调 cw(review)。

## 本阶段禁止

- [禁止] 跳过 review 直接调 cw(test)（状态机 guard 会拒绝）
- [禁止] 不传 issues（必填，空数组也行——通过 stdin 管道传）
- [禁止] review 发现 must-fix 但不修就传空 issues（先修 → review_fix → 复查）

## 完成标志

review.md 写完 + cw(review) 提交后：
- issues 为空 → 进 test
- issues 非空 → 进 review_fix → 修复后复查

## Fowler 12 smell baseline（Standards 轴补充检查清单）

以上维度是按维度找 bug。另外有一套 Fowler 经典代码坏味（code smell）baseline——即使仓库没有任何文档化规范，也始终携带这套 baseline 作为 Standards 轴的兜底检查。

写 review.md 时，对每条命中的 smell：标注 smell 名 + 引用 diff hunk + 给出"怎么修"建议。smell 默认 judgement call（见下方级别规则），不是硬违反。

### 12 smell 清单（是什么 → 怎么修）

1. **Mysterious Name**（名不达意）：变量/函数/类名不能诚实表达其作用 → 重命名；若找不到诚实的名字，说明设计本身浑浊，先改设计
2. **Duplicated Code**（重复代码）：相同逻辑形状在多个 hunk/文件重复 → 抽取共享形状，两处调用
3. **Feature Envy**（特性嫉妒）：一个方法更多地伸手进别人的数据而非自己的 → 把方法搬到它嫉妒的数据所在的对象上
4. **Data Clumps**（数据泥团）：同样的几个字段/参数总是一起出行（一个待出生的类型）→ 打包成一个类型传入
5. **Primitive Obsession**（基本类型痴迷）：用基本类型/字符串冒充领域概念（如 \`userId: string\` 而非 \`UserId\`）→ 给概念自己的小类型
6. **Repeated Switches**（重复分支）：同一个 switch/if-cascade 在变更中多处复现 → 多态替换，或两处共享一个 map
7. **Shotgun Surgery**（霰弹枪手术）：一个逻辑变更逼得在多文件散点修改 → 把"一起变的东西"聚到一个模块
8. **Divergent Change**（发散性变化）：一个文件/模块因多个不相关原因被改 → 拆分到每个模块只为一个原因变
9. **Speculative Generality**（投机性泛化）：为 spec 没有的需求加抽象/参数/hook → 删除；内联回去直到真实需求出现
10. **Message Chains**（消息链）：长的 \`a.b().c().d()\` 导航 → 在第一个对象背后用一个方法隐藏整段走查
11. **Middle Man**（中间人）：类/函数主要只转发调用 → 删掉，直接调真实目标
12. **Refused Bequest**（拒绝遗产）：子类/实现者忽略或覆写大部分继承物 → 弃用继承，改用组合

### smell 的严重级别规则

12 smell baseline **永远是 judgement call**——默认 should-fix 或 nit 级别，不强制 must-fix。

例外：当 smell 与仓库文档化规范冲突时（仓库有 CODING_STANDARDS.md / CONTRIBUTING.md / .eslintrc 等明确禁止该 smell），升为 must-fix。

### 仓库标准覆盖 baseline

如果项目有以下文件（审查前先检查是否存在）：
- \`CODING_STANDARDS.md\` / \`CONTRIBUTING.md\`
- \`AGENTS.md\` / \`CLAUDE.md\`（AI 协作规范）
- \`NFR.md\`（工程约束）
- \`.eslintrc*\` / \`tsconfig.json\` / \`biome.json\`（linter 配置）

**优先按仓库标准审查**——仓库标准 > 12 smell baseline。找到这些文件时：
- 仓库标准禁止的 → must-fix（硬违反）
- 仓库标准没说但 baseline 命中的 → should-fix 或 nit（judgement call）
- 仓库标准与 baseline 冲突时 → 按仓库标准（baseline 降级）

找不到任何仓库标准文件时：12 smell baseline 作为唯一兜底，全部 judgement call。

## 两轴报告约束（Standards vs Spec 独立呈现）

review.md 的发现必须按两个正交轴分组呈现，**禁止跨轴 rerank 选"最严重"**——一轴的 pass 不能掩盖另一轴的 fail。

### Standards 组（代码符合规范吗）
包含：上方各"代码质量"维度的发现（类型安全 / 错误处理 / 边界条件等当前 taskShape 启用的维度）+ 12 smell baseline 发现

### Spec 组（代码忠实实现 spec 吗）
包含：对照 spec（FR/AC）的发现——"实现是否忠实于 spec"维度的 spec 对照、plan 覆盖的 spec 部分、测试覆盖的 spec 契约部分（具体取当前 taskShape 启用的相关维度）

### 报告结构

review.md 末尾的总结必须是**每轴各自的发现数 + 每轴各自的最严重问题**，不是跨轴挑一个"最严重"。

正确示例：
\`\`\`
## 总结
- Standards 组：3 个发现（最严重：X 维度的 Y 问题，must-fix）
- Spec 组：1 个发现（最严重：FR-2 未实现，must-fix）
\`\`\`

错误示例（禁止）：
\`\`\`
## 总结
- 最严重问题：FR-2 未实现（跨轴 rerank，掩盖了 Standards 组的 must-fix）
\`\`\`

### 为什么禁止 rerank

Standards 全过但实现错了东西（Spec fail）是可能的；完全按 issue 做但违反项目约定（Spec pass + Standards fail）也是可能的。两轴的发现互相不可替代——rerank 会让一轴的严重问题被另一轴的表象掩盖。

## Spec 轴三看（对照 spec 审查的具体检查）

对照 spec（FR / AC）审查实现时（配合上面的"禁读重建法"），看三件事，每条都要**引用 spec 原文行**：

1. **spec 要求但缺失或部分实现**：spec 的某条 FR/AC 在 diff 里找不到对应实现，或只实现了一部分
2. **未要求的 scope creep**：diff 里有 spec 没要求的行为（额外功能 / 提前优化 / 演示性代码）
3. **看似已实现但实现错误**：spec 要求 X，diff 里有 X 的代码，但 X 的行为与 spec 描述不一致

每条发现的 issue.ref 必须指向 spec 的 AC ID（如 \`AC-3\` / \`FR-2.AC-1\`），形成 spec_review → tdd_plan → review 的契约闭环。
`.trim();
}

/**
 * REVIEW_PROMPT — 全 6 维 review 提示词（向后兼容常量）。
 *
 * 步骤 4 后等效于 buildReviewPrompt(全 6 维)。保留常量供 state-machine 的非 review 分支
 * / actions.ts 的 dimension 校验文案等场景引用。等价性由 review-prompt-dimensions.test.ts AC-8 锁定。
 */
export const REVIEW_PROMPT: string = buildReviewPrompt([
  "type-safety",
  "error-handling",
  "edge-case",
  "test-coverage",
  "plan-completeness",
  "design-consistency",
]);

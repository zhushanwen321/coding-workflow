/**
 * review-prompt-dimensions 单测 — 步骤 4：REVIEW_PROMPT 改函数 + dimensions 子集化。
 *
 * 覆盖：
 *   - AC-7: buildReviewPrompt(dimensions) 按子集过滤维度表
 *   - AC-8: full-tdd 全 6 维输出 == 原 REVIEW_PROMPT（等价性锁定，黄金快照对比）
 *   - AC-9: delete-only/doc-only review guidance 只含声明的 dimensions 子集
 *
 * AC-8 设计（修复循环论证）：原测试断言 buildReviewPrompt(全 6 维) === REVIEW_PROMPT，
 * 但 REVIEW_PROMPT 本身就是 buildReviewPrompt(全 6 维) 的返回值——恒真。这里改为内嵌
 * 步骤 4 改造前的 REVIEW_PROMPT 字面量快照 SNAPSHOT_ORIGINAL_REVIEW_PROMPT（取自 git
 * 559bc06^ 的原常量值），断言 buildReviewPrompt(全 6 维) 与该快照逐字节相等。这样
 * buildReviewPrompt 的输出若偏离原始内容（空行/JSON dimension/文案数字），测试会真正失败。
 */

import { describe, expect, it } from "vitest";

import { buildReviewPrompt } from "../src/prompts/review.js";
import { getShape } from "../src/shapes/registry.js";
import type { ReviewDimension } from "../src/types.js";

// ── AC-8: 等价性锁定（黄金快照） ──────────────────────────────────
//
// 步骤 4 改造前 src/prompts/review.ts 的 REVIEW_PROMPT 常量值（取自 git 559bc06^）。
// 这是「基准」——buildReviewPrompt(全 6 维) 必须与它逐字节相等。任何空行数量、JSON 示例
// dimension、维度表顺序的偏差都会让下面的断言失败。快照以模板字面量内嵌（反引号已转义），
// 便于人工 diff 审查。
//
// A7 修订（prompt-vs-engine 审计）：reviewPath 文案从「代码签名上可选」改为「实际必填」
// （去除内部实现细节泄露）。黄金快照同步更新——仅一行文案变化，prompt 结构未动。
const SNAPSHOT_ORIGINAL_REVIEW_PROMPT = `[review 阶段] 代码审查 + issue tracking

所有 Wave 已 committed（dev gate 通过）。在进入 test 之前，必须审查代码。

## 审查流程

1. 做代码审查（按下方维度，推荐用禁读重建法查 design-consistency）
2. 把发现的问题整理成结构化 issues
3. 写 review.md（含审查结论）
4. 提交：

    echo '<issuesJson>' | cw review --topicId <topicId> --reviewPath <path>

## 审查方法：禁读重建（design-consistency 维度专用）

design-consistency（设计一致性）维度最易漏——直接读实现容易「顺着代码思路走」，
看不出实现偏离了 spec。强制用「禁读重建」对冲：

1. 派一个 fresh subagent，**不读**实现代码
2. 只给它 spec 的 functionalRequirements + acceptanceCriteria
3. 让它从 spec 反查「实现完整性」——每个 FR/AC 对应的代码路径是否存在、行为是否正确
4. 把反查结果与实际实现 **diff**——实现遗漏/偏离 spec 的点就是审查发现

其余维度（类型安全/错误处理/边界条件/测试质量/plan 完成度）直接读代码审查即可。

## 审查维度

按以下维度审查（可用 subagent 分工，也可主 agent 自审）。dimension 字段必填，取 6 值之一：

| dimension | 维度 | 审什么 |
|-----------|------|--------|
| \`type-safety\` | 类型安全 | 禁 any、schema 同步、CwError vs Error 边界、type-only import |
| \`error-handling\` | 错误处理 | catch 不吞异常、exit code 映射、错误消息可读性 |
| \`edge-case\` | 边界条件 | 空数组/缺字段/非法 JSON/文件不存在 |
| \`test-coverage\` | 测试质量 | 测试能否发现真 bug（见下方「测试质量审查」专节，不只是覆盖率数字） |
| \`plan-completeness\` | plan 完成度 | dev-plan.json 的 changes 是否全部落地 |
| \`design-consistency\` | 设计一致性 | spec 的 FR/AC 是否被正确实现（用禁读重建法） |

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

    echo '[
      {
        "severity": "must-fix",
        "dimension": "edge-case",
        "description": "store.ts 的 appendReviewIssues 没有做 turn 校验",
        "ref": "src/store.ts:142"
      },
      {
        "severity": "should-fix",
        "dimension": "error-handling",
        "description": "错误消息缺用法示例",
        "ref": "src/cli.ts:268"
      }
    ]' | cw review --topicId <topicId> --reviewPath <path>

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
取以下 6 个值之一（对应代码审查维度），用于事后统计 review 盲区分布——看哪些维度漏检最多，反过来校准审查重点。

| dimension | 对应维度 |
|-----------|----------|
| \`type-safety\` | 类型安全 |
| \`error-handling\` | 错误处理 |
| \`edge-case\` | 边界条件 |
| \`test-coverage\` | 测试覆盖 |
| \`plan-completeness\` | plan 完成度 |
| \`design-consistency\` | 设计一致性（核对 spec FR/AC，推荐禁读重建法） |

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

每条发现的 issue.ref 必须指向 spec 的 AC ID（如 \`AC-3\` / \`FR-2.AC-1\`），形成 spec_review → tdd_plan → review 的契约闭环。`;

describe("AC-8: buildReviewPrompt 全 6 维 == 原 REVIEW_PROMPT（黄金快照等价性）", () => {
  const ALL_6_DIMENSIONS: ReviewDimension[] = [
    "type-safety",
    "error-handling",
    "edge-case",
    "test-coverage",
    "plan-completeness",
    "design-consistency",
  ];

  it("全 6 维输出与黄金快照 SNAPSHOT_ORIGINAL_REVIEW_PROMPT 逐字节相等", () => {
    // 这是真正的等价性断言——快照来自改造前的 REVIEW_PROMPT，不依赖当前实现。
    // 任何 buildReviewPrompt 的偏差（空行/JSON dimension/文案）都会让此断言失败。
    expect(buildReviewPrompt(ALL_6_DIMENSIONS)).toBe(SNAPSHOT_ORIGINAL_REVIEW_PROMPT);
  });

  it("full-tdd shape 的 dimensions 是全 6 维", () => {
    const dims = getShape("full-tdd").review.dimensions;
    expect(dims).toEqual(ALL_6_DIMENSIONS);
  });

  it("full-tdd shape 调 buildReviewPrompt == 黄金快照", () => {
    const dims = getShape("full-tdd").review.dimensions;
    expect(buildReviewPrompt(dims)).toBe(SNAPSHOT_ORIGINAL_REVIEW_PROMPT);
  });

  it("JSON 示例 dimension 固定为 edge-case（第一个）/ error-handling（第二个）", () => {
    // 单独锁定 reviewer 发现的字节差异 #2：原 JSON 示例用 edge-case/error-handling，
    // 不是 dimensions[0]。防止未来 regression 把它改回 dimensions[0]。
    const prompt = buildReviewPrompt(ALL_6_DIMENSIONS);
    expect(prompt).toContain('"dimension": "edge-case"');
    expect(prompt).toContain('"dimension": "error-handling"');
  });
});

// ── AC-7: 子集过滤 ────────────────────────────────────────

describe("AC-7: buildReviewPrompt 按子集过滤", () => {
  it("只传 type-safety → 输出含 type-safety 行，不含其他 5 维", () => {
    const prompt = buildReviewPrompt(["type-safety"]);
    expect(prompt).toContain("type-safety");
    expect(prompt).not.toContain("error-handling");
    expect(prompt).not.toContain("edge-case");
    expect(prompt).not.toContain("design-consistency");
  });

  it("传 2 个维度 → 输出含这 2 行，不含其余 4 维", () => {
    const prompt = buildReviewPrompt(["edge-case", "design-consistency"]);
    expect(prompt).toContain("edge-case");
    expect(prompt).toContain("design-consistency");
    expect(prompt).not.toContain("type-safety");
    expect(prompt).not.toContain("error-handling");
  });

  it("prompt 主体内容不因子集变化（审查流程/severity/ref 等）", () => {
    const fullPrompt = buildReviewPrompt(["type-safety"]);
    const expectedStableContent = [
      "审查流程",
      "severity",
      "must-fix",
      "review fix loop",
      "review.md",
    ];
    for (const content of expectedStableContent) {
      expect(fullPrompt).toContain(content);
    }
  });

  it("m1: 子集模式下维度数文案不硬编码 6（避免 delete-only/doc-only 自相矛盾）", () => {
    // delete-only 2 维 → 文案应说「取 2 值之一」/「取以下 2 个值之一」，不是 6。
    const deleteOnly = buildReviewPrompt(["design-consistency", "edge-case"]);
    expect(deleteOnly).toContain("取 2 值之一");
    expect(deleteOnly).toContain("取以下 2 个值之一");
    // doc-only 1 维 → 「取 1 值之一」/「取以下 1 个值之一」。
    const docOnly = buildReviewPrompt(["design-consistency"]);
    expect(docOnly).toContain("取 1 值之一");
    expect(docOnly).toContain("取以下 1 个值之一");
  });
});

// ── AC-9: delete-only/doc-only 子集 ───────────────────────

describe("AC-9: delete-only/doc-only dimensions 子集", () => {
  it("delete-only（LeanReviewPolicy）dimensions 只含 design-consistency + edge-case", () => {
    const dims = getShape("delete-only").review.dimensions;
    expect(dims).toEqual(["design-consistency", "edge-case"]);
  });

  it("delete-only buildReviewPrompt 只含声明维度行", () => {
    const dims = getShape("delete-only").review.dimensions;
    const prompt = buildReviewPrompt(dims);
    expect(prompt).toContain("design-consistency");
    expect(prompt).toContain("edge-case");
    // 不含未声明的维度
    expect(prompt).not.toContain("type-safety");
    expect(prompt).not.toContain("error-handling");
    expect(prompt).not.toContain("test-coverage");
    expect(prompt).not.toContain("plan-completeness");
  });

  it("doc-only（DocReviewPolicy）dimensions 只含 design-consistency", () => {
    const dims = getShape("doc-only").review.dimensions;
    expect(dims).toEqual(["design-consistency"]);
  });

  it("doc-only buildReviewPrompt 只含 design-consistency 行", () => {
    const dims = getShape("doc-only").review.dimensions;
    const prompt = buildReviewPrompt(dims);
    expect(prompt).toContain("design-consistency");
    expect(prompt).not.toContain("edge-case");
    expect(prompt).not.toContain("type-safety");
  });
});

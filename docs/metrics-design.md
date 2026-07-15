# CW-CLI 评估指标体系：设计

> 配套 [metrics-usage.md](./metrics-usage.md)（如何用指标做决策）。本文档只回答"指标是什么、为什么这么设计"。

---

## 核心问题

CW-CLI 的评估指标要回答的不是"cw-cli 代码质量好不好"，而是：

> **在相同的 agent 软件 + LLM 组合下，不同版本的 cw-cli 对代码质量、开发效率、测试纠错的帮助有什么差异？**

这决定了指标设计的三条约束：

1. **对目标建模，不对工具建模**——指标度量的是交付结果和过程，不是"cw 跑了几次"
2. **分组对比才有意义**——不同 agent（Pi vs Claude Code）和不同 LLM（GLM-5.2 vs Sonnet）的交付能力天然不同，跨组比较是噪音
3. **复杂度归一**——simple 任务天然比 complex 任务 firstTryPassRate 高，不归一就无法判断是 cw-cli 变好了还是任务变简单了

## 三层架构

```
第一层 交付质量     ← retrospect 自省 + assess 人工评估（post-closeout）
第二层 过程效率     ← stats computeEfficiency（gateHistory 派生）
第三层 杠杆健康度   ← stats computeLeverHealth（9 个 CW 机制 gate 的最终状态）
```

每层回答一个不同的问题：

| 层 | 回答的问题 | 数据来源 | 采集时机 |
|----|-----------|---------|---------|
| 第一层 | "交付的东西好不好？" | retrospectData + assessments | retrospect 阶段 + post-closeout |
| 第二层 | "过程顺不顺？" | gateHistory + waves + testCases | 全程自动 |
| 第三层 | "CW 的机制起作用了吗？" | gateHistory（按 gate 名分组） | 全程自动 |

### 为什么是三层而不是一层

单看"交付质量"不够——一个 topic 可能最终质量不错，但 dev 反复 fail 5 次、test 返工 3 次，说明过程低效。单看"过程效率"也不够——过程很顺但交付物有隐蔽缺陷（assess 发现），说明 CW 的 gate 没拦住。

三层是**互补的三角**：
- 第一层度量**结果**（outcome）
- 第二层度量**过程**（process）
- 第三层度量**机制**（mechanism）

只有三层都健康，才能说"CW 在这个 runtimeEnv 下运转良好"。

## 分组维度：RuntimeEnv

```typescript
interface RuntimeEnv {
  agent: string;      // "Pi" / "Claude Code" / ...
  llm: string;        // "GLM-5.2" / "Sonnet-4.5" / ...
  cwVersion: string;  // 从 package.json 自动读
}
```

**设计原则**：

- create 时注入，后续不可变——一个 topic 的 runtimeEnv 锁定其所属分组
- 优先级：命令行 `--agent`/`--llm` > env.json > 硬编码默认（Pi / GLM-5.2）
- cwVersion 始终自动读，不让人填——这是分组对比的自变量

**为什么 agent + llm 不可比**：

Pi + GLM-5.2 的 firstTryPassRate = 0.8 和 Claude Code + Sonnet-4.5 的 0.6，不代表前者更好。可能是 Pi 跑的都是 simple 任务，Claude Code 跑的都是 complex 任务。跨组比较需要先归一化（按复杂度分桶），而跨 agent+llm 的归一化没有可靠基准——你不知道能力差异有多少来自 agent、多少来自 llm、多少来自交互。

**所以**：只在同 agent + 同 llm 的不同 cwVersion 之间比较。这才是 cw-cli 改进效果的度量。

## 复杂度归一

```typescript
type ComplexityLevel = "simple" | "medium" | "complex";
```

| level | 条件 |
|-------|------|
| simple | waves ≤ 3 且 files ≤ 5 |
| complex | waves ≥ 10 或 files ≥ 15 |
| medium | 其他 |

files 从 `waves[].changes` 文本提取路径估算。阈值复用 gate.ts 的 `SCOPE_WARN_WAVES` / `SCOPE_WARN_FILES`——范围守门和复杂度评估用同一组阈值，保持一致性。

**为什么归一**：simple 任务的 firstTryPassRate 天然高于 complex。如果跨复杂度混合计算均值，cwVersion A 跑的全是 simple 任务、cwVersion B 跑的全是 complex 任务，均值对比会完全误导。

`cw stats --all` 在每个 runtimeEnv 分组内，先按复杂度分桶（simple/medium/complex），桶内再算均值。空桶也输出（topicCount=0），保证跨组对齐。

---

## 第一层：交付质量

### 数据采集

| 数据 | 采集方式 | 采集时机 |
|------|---------|---------|
| retrospectData.derived | cw 自动从 topic 派生（agent 不填） | retrospect gate pass 时 |
| retrospectData.knownRisks | agent 自省填写 | retrospect 阶段 |
| retrospectData.processIssues | agent 自省填写 | retrospect 阶段 |
| assessments[type=quality/test/stability] | 设计者人工调 `cw assess` | post-closeout |
| assessments[type=defect] | 设计者人工调 `cw assess` | post-closeout |

### derived 段（cw 自动算）

```typescript
interface RetrospectDerived {
  totalWaves: number;
  totalCases: number;
  gateFailCount: number;
  devRetryCount: number;
  testRetryCount: number;
  redLightConfirmed: boolean;
  firstTryPassRate: number;
}
```

**为什么不信任 agent 自报的 derived**：agent 可能高估自己的表现（"我觉得全程一次过"）。cw 从 gateHistory 客观计算并覆盖 agent 填的值。

### knownRisks：自省准确度的来源

```typescript
interface RetrospectKnownRisk {
  severity: "high" | "medium" | "low";
  area: string;
  description: string;
  unverified: boolean;  // 是否为未证实的假设
}
```

knownRisks 的长期价值在于**与 post-closeout defect 交叉比对**：
- 如果 post-closeout 发现的缺陷大部分**没**在 knownRisks 登记 → agent 自省流程太浅
- 如果大部分**都**在 knownRisks → 自省有效，问题在修复能力而非识别能力

这个"自省准确度"指标需要积累 N 个 topic 才有统计意义（Wave 6 工作）。

### defect.foundInReview：review 召回校准

```typescript
interface AssessmentDefect {
  severity: "blocker" | "major" | "minor";
  area: string;
  rootCause: string;
  foundInReview: boolean;  // 核心：review 阶段是否已发现
}
```

`foundInReview` 是整个评估体系的校准锚点：

- `foundInReview=true`：review 发现了但没修干净（修复执行力问题）
- `foundInReview=false`：review 完全漏了（review 识别能力问题）

积累后计算：**review 召回率 = foundInReview=true 的缺陷 / 总缺陷**。这个比率低，说明 review 阶段需要加强（可能 review prompt 不够、可能 3 轮上限太低）。

### 为什么 assess 不走 gate 机制

assess 是**纯数据追加**，不走 gate（不写 gateHistory），不改变 status（始终 closed）。

原因：gate 是**流程阻断机制**——fail 了就不能进入下一阶段。但 post-closeout 评估是对已完成交付的事后打分，不应该阻断任何东西。assess 的 progressive 语义（可多次调用）也意味着它不是一个 gate。

---

## 第二层：过程效率

### 7 项指标

```typescript
interface Efficiency {
  firstTryPass: Record<string, boolean>;  // 各 phase 首次是否 pass
  earlyInterceptionRate: number;          // dev+test fail 占总 fail 的比例
  devRetryCount: number;                  // dev fail 次数
  testRetryCount: number;                 // test fail 次数
  totalGateFails: number;                 // 全阶段 fail 总数
  lateReworkRate: number;                 // review+closeout fail 占比
  planCompletionRate: number;            // committed waves / 总 waves
  coverageFlag: boolean;                  // evidence.coverage < 0.5
}
```

### earlyInterceptionRate vs lateReworkRate

这两个指标是互补的：

- **earlyInterceptionRate** = (dev fail + test fail) / 全 fail
  - 高 = 好（问题在交付前被抓到，廉价返工）
  - 无 fail 时 = 1（全程无问题，最佳）

- **lateReworkRate** = (review fail + closeout fail) / 全 fail
  - 低 = 好（交付后才发现的问题少）
  - 无 fail 时 = 0（最佳）

设计意图：CW 的核心价值是**左移拦截**——把问题发现时机提前到 dev/test（廉价），而不是推迟到 review/closeout（昂贵）。这两个比率直接度量"拦截是否有效"。

### planCompletionRate

已 committed waves / 总 waves。未 committed 的 wave = plan 承诺未兑现。

低 planCompletionRate 意味着两种可能：
1. plan 过于乐观（plan 阶段拆分不合理）
2. dev 执行力不足（承诺了但没做完）

结合 devRetryCount 可以区分：devRetryCount 高 + planCompletionRate 低 = 执行力问题；devRetryCount 低 + planCompletionRate 低 = plan 乐观问题。

### coverageFlag

`evidence.coverage < 0.5` 时为 true。coverage 在 closeout 时计算（passed testCases / total testCases）。

这是唯一的**二值 flag**（不是比率），因为它的用途是"触发关注"而非"精确度量"。低于 50% 通过率是明确的红旗，不需要更细的梯度。

---

## 第三层：杠杆健康度

### 9 个 CW 机制杠杆

| 杠杆 | gate 名 | 度量什么 |
|------|---------|---------|
| spec 范围守门 | lite-plan-schema | plan 是否超出 SCOPE_WARN 阈值 |
| plan 结构化拆分 | lite-plan-schema | plan 是否拆成 waves |
| TDD 红灯先行 | tdd-red-light | tdd_plan 是否做了红灯确认 |
| expected 可信度 | test-json-schema | test.json 的 expected 是否可判定 |
| dev commit 锚定 | medium-git | dev 提交是否有真实 commit |
| review 存在性 | file-exists+non-empty | review 是否产出了 review.md |
| test 机器重算 | judgeByExpected | test 是否由机器按 expected 判定 |
| append-only 安全 | append-only-validator | replan 是否遵守 append-only |
| retrospect 结构化 | retrospectData 存在性 | retrospect 是否产出结构化数据 |

### 状态判定

每个杠杆的状态从 gateHistory 的**最新记录**派生：

| gateLatest 状态 | leverHealth 状态 |
|-----------------|-----------------|
| 无记录 | not-run（该杠杆未被触发） |
| 最新 pass | pass |
| 最新 fail | fail |

**特殊情况**：

- lite-plan-schema 同时承载 spec 守门和 plan 结构化——两者读同一组 gate 记录，状态相同（有意设计）
- retrospect 杠杆不查 gateHistory（gate 名与 review 共用），改查 `topic.retrospectData` 是否存在——有则 pass，无则 not-run

### 为什么是"最终状态"而非"通过率"

杠杆健康度只看最新记录（最终状态），不看通过率。原因：gate 是 progressive 的——第一次 fail 后 retry 到 pass 是正常流程。只看最终状态才能回答"这个机制最终起作用了吗？"，而不是"第一次就成功了吗？"（那是 firstTryPass 的职责）。

---

## 数据流全景

```
create（注入 runtimeEnv）
  │
  ├─ plan/tdd_plan/dev/review/test/retrospect/closeout
  │    └─ gate 判定 → gateHistory 追加记录
  │
  ├─ dev commit → changedFiles 持久化（diff-tree）
  │
  ├─ retrospect gate pass
  │    └─ retrospectData 写入（derived cw 自动算 + knownRisks/processIssues agent 填）
  │
  ├─ closeout gate pass → evidence 写入（coverage + gateHistory 快照）
  │
  └─ assess（post-closeout，可多次）
       └─ assessments 追加（含 defect.foundInReview）

cw stats --topicId <id>      → computeStats（单 topic 三层指标）
cw stats --all               → computeStatsAll（按 runtimeEnv 分组 + 复杂度分桶 + 均值）
```

所有指标计算都是**纯函数**（只读 topic 数据，无副作用，不依赖外部文件）。

---

## 已实现 vs 待实现

### 已实现（Wave 1-5）

- [x] changedFiles 持久化（Wave 1）
- [x] retrospect 结构化数据（Wave 2.1）
- [x] review.md 标准化格式（Wave 2.2）
- [x] 三层指标计算（stats.ts：complexity + efficiency + leverHealth）
- [x] 跨 topic 聚合（computeStatsAll：runtimeEnv 分组 + 复杂度分桶）
- [x] RuntimeEnv 分组维度（create 时注入）
- [x] assess post-closeout 评估（Wave 5）
- [x] defect.foundInReview 校准字段

### 待实现（Wave 6：持续迭代，需数据积累）

以下指标的数据已采集，但计算逻辑尚未实现——它们需要跨 topic 聚合才有统计意义：

| 指标 | 数据已存在 | 计算公式 | 为什么需要积累 |
|------|-----------|---------|--------------|
| review 召回率 | `assessments[type=defect].foundInReview` | Σ(foundInReview=true) / Σ(总 defect) | 单 topic 缺陷数太少 |
| 散弹枪修改指数 | `waves[].changedFiles` | avg(每 wave 的实际文件数) / avg(每 wave 声明文件数) | 需要同复杂度桶内对比 |
| 自省准确度 | `retrospectData.knownRisks` vs `assessments.defect` | 已登记 risk 覆盖实际 defect 的比例 | 需要多个有 defect 的 topic |
| assess 数据进 stats | `topic.assessments` | stats 输出应包含 assessment 汇总 | 需先积累 assess 数据 |

Wave 6 不是代码实现 Wave，而是**数据驱动的过程性工作**——积累 N 个 topic 后，根据实际数据决定哪些跨 topic 指标值得实现。

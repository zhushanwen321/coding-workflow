# 设计：独立 spec-review 派发（异源 reviewer）——信任链结构隔离

> 状态：v1.1（对抗审查修复版）。来源：2026-08-18 五角度对抗审查 critical A-1 + 用户裁决「补异源派发机制」。
> v1.1 变更：吸收设计对抗审查 MF1-MF3 + S1-S7 全部（审查报告存档于主 agent 会话；MF 摘要——①fail 后状态独立成 specFixPending 维度派 designer（v1 的 reReview 改派使 fail 后无人修 spec）②fail 计数改账本重放且不因新 spec 清零（v1 清零语义致 ping-pong 活锁）③canon 失实引用更正 + role 字段落地）。
> canon 依据：design-rewrite-architecture.md §1.3 信任链、§3.3 D3、:221（VerdictSubmitted {unitId, role, verdict, evidenceRefs} ← 独立 reviewer）、:229-233（spec-frozen 时序锚）。

## 1. 背景与现状缺陷

canon 信任链核心承诺「审查者与产出者结构隔离」。实现现状：

1. **spec-review 由 designer 自审**：designer 任务书第 3 步指令自己执行 `cw review submit --verdict-kind spec-review --verdict pass`（loop.ts designerFirstTasks）。
2. **reReview 维度同样派 designer**：现状 reReview 谓词是「created ∧ 有 spec ∧ 最后 spec 后无 pass verdict」（frontier.ts:203-206）——同时覆盖「从未审过」与「审了但 fail」两种状态，都由 designer 自审。
3. exec-review 已有独立 reviewer spawn（DISPATCH_SHAPE execReviewReady → reviewer）——reviewer 派发基建已存在，spec-review 缺接线。

## 2. 目标

spec-review 的 VerdictSubmitted 一律由独立 reviewer spawn 提交（不同进程、审查视角 brief、可选不同模型）；designer 任务书不再含任何 review submit 步骤；fail 打回循环可收敛（ping-pong 活锁有账本级出口）；verdict 带自报 role 字段可审计。

## 3. 方案

### 3.1 派发维度（MF1 修复：fail 后状态独立成维度）

frontier 维度重排（computeFrontier 的 created 态单组互斥结构内，按序判定）：

| 维度 | 精确谓词（created 态内） | 派发对象 |
|------|------------------------|---------|
| `specReviewPending` | 有 SpecSubmitted ∧ 最后 spec 后无任何 spec-review verdict | **reviewer**（新） |
| `specFixPending` | 有 SpecSubmitted ∧ 最后 spec 后最近的 spec-review verdict 是 **fail** | **designer**（任务书 = 修 spec 重提；内嵌 fail verdict 的 comment 作失败事实） |
| `reReview` | 有 SpecSubmitted ∧ 最后 spec 后无 pass（既有谓词的剩余部分——已被上两维分流后仅剩「verdict 有 pass 之前更早的 fail 但无新 spec」等历史态） | **reviewer**（改派；v1.1 注：该维度在新结构下实际不可达则删除并在代码注释说明推导） |
| `missingChildren` / `integrationDrift` 等 | 不变 | 不变 |

dimensionOf 单值映射同步重排；同 unit 的维度互斥由 created 态内 if/else 序保证。

**派发 gate（S1 采纳）**：dispatchTargets 增加守卫——同 unit 存在任意 role 的 in-flight spawn 时，本轮不派发该 unit 的新 role（等 spawn 结算，下轮 frontier 重算再派）。同时修复现状 designer→builder 转换的同类竞态。等待窗口 ≤ 一个 poll 周期（spawn 进程退出即释放，无死等路径：in-flight spawn 必然 wait() 结算或 TIMEOUT）。

### 3.2 reviewer 任务书与 designer 任务书

- designer 任务书（designerFirstTasks）：删除第 3 步自审指令；完成标志改为「spec 已提交入账」。
- **specFixPending 的 designer 任务书**（新增模板）：内嵌 reviewer fail verdict 的 comment 全文（失败事实）+ 修 spec 指令 + 重提后自然回流 specReviewPending 的说明。
- reviewer 任务书（新 brief 模板）：
  1. 读 spec 原文——**brief 内嵌 attachments 绝对路径**（S2 采纳：loop 渲染时由 attachmentsDir(cwHome, projectCwd, unitId) 计算，不依赖相对路径锚点）
  2. 按 canon D3 审查语义逐项判定
  3. 提交：`cw review submit --unit <id> --verdict-kind spec-review --verdict pass|fail --comment <依据> --role reviewer`
  4. fail 时 comment 必须逐条列出不合格项与恢复动作
- human 模式：reviewer 指令同步（human.ts designer 指令删自审步骤；reviewer 指令含 spec-review 触发点——matcher 已有 VerdictSubmitted 匹配，核对即可）。

### 3.3 失败与防活锁（MF2 修复：账本重放计数，不因新 spec 清零）

- **spec-review fail 打回循环**：fail → specFixPending → designer 修 spec → 新 SpecSubmitted → specReviewPending → reviewer 再审——正常循环。
- **防 ping-pong 活锁**：frontier 投影新增 `specReviewDeadlock`——**本 run 账本内该 unit 的 spec-review fail verdict 总数 ≥2 时**（账本重放计数，范式对齐 consecutiveIntegrationFails；**不因新 SpecSubmitted 清零**）→ loop 停止派发该 unit（specFixPending 不再出），stderr 转人工 escalation（新文案变体：两次 fail 的 comment 摘要 + 人工处置动作）。人处置后（改 brief / 人工修 spec 重提 / 人工 verdict）新事件自然重算。
- **reviewer spawn TIMEOUT/CRASH**：重派，计入既有 timeoutStreaks（unitId 键控，role 为记录字段）；连续 2 次无进展转人工（既有机制零新增）。
- **抢答可见性（S7 采纳）**：VerdictSubmitted(spec-review) 入账轮次，若该 unit 无 in-flight reviewer spawn 且非 specFixPending 流转 → loop stderr 打一行警告（不阻断，审计信号）。

### 3.4 账本与事件（MF3 修复：role 字段落地）

- `VerdictSubmittedPayload` 增可选字段 `role?: "reviewer" | "designer" | "builder" | "human"`（提交者自报；`cw review submit` 增 `--role` flag，任务书模板内嵌）。**自报可伪造**——role 是审计载体不是信任边界（canon:221 事件模型含 role 字段，实现落地为弱声明；doc-2 回写登记「实现 = 可选自报字段，canon 语义 = 独立 reviewer 的旁证之一」）。信任增强仍来自结构隔离（独立 spawn + 审查 brief + 可选异源模型），这是设计与 canon 共同承认的边界。
- 其余事件 schema 零变更；verdictKind/seq 时序数据既有。

### 3.5 异源模型链（S3 修复：对齐 pi 既有四级链，pi.ts 零改动）

```
cw run --reviewer-model <m>（handlers/run.ts 参数）
  > 进程环境 CW_REVIEWER_MODEL（runLoop 启动时读取）
  > 不设 → 不注入（reviewer spawn 回落 builder 同款模型链：
    resolvePiModel 既有 opts.model > req.env.CW_AGENT_MODEL > process.env.CW_AGENT_MODEL > default）
```

实现管线：RunLoopOptions 增 `reviewerModel?: string`；loop 组装 reviewer role 的 spawn req 时注入 `env.CW_AGENT_MODEL = reviewerModel`（复用既有四级链的 req.env 级，**pi.ts 零改动**——CW_AGENT_MODEL→--model 翻译层是唯一注入路径的 u6c 语义保持）。注：reviewer spawn 的 req.env 同时含 CW_PROJECT_DIR（既有注入）。v1 的「预留 --reviewer-spawn」删除（最小实现纪律；harness 级异源记 canon 路线图）。

## 4. 关键决策与权衡

| 决策 | 选择 | 理由 |
|------|------|------|
| D1 隔离层级 | 结构隔离（独立 spawn/brief/gate）为底线，模型异源为配置项 | 结构隔离零依赖；未实测模型不硬编码默认 |
| D2 reviewer 默认模型 | 回落 builder 同款 | 未实测硬编码是脆弱性；M4 gate 真实跑时按 pi 实测再定默认 |
| D3 fail 后维度 | specFixPending 独立维度派 designer | MF1：v1 的 reReview 改派使 fail 后无人修 spec，维度分流是唯一自洽形状 |
| D4 防活锁计数 | 账本重放 fail 总数 ≥2，不清零 | MF2：清零语义下 streak 永远到不了 2；fail verdict 是账本事件，跨进程累计物理可得（timeoutStreaks 用内存的理由不适用） |
| D5 循环成本 | 接受每 unit 多一轮 reviewer spawn；**reviewer 长审场景在 gate/文档注明建议显式调大 --max-idle-ms**（S5：reviewer 提 verdict 前零账本事件，idle 度量与 30min 默认同量级，互杀风险） | 信任链核心承诺；idle 风险显式暴露而非静默 |
| D6 role 字段 | 可选自报 + 任务书内嵌 | MF3：canon 事件模型含 role；自报可伪造但提供 A5-③ 核对的账本载体 |
| D7 派发 gate | 同 unit 任意 in-flight 时缓派 | S1：reviewer 派发的 reset 会清在飞 designer 现场；gate 同时修复既有 designer→builder 竞态 |
| D8 实现排序 | mx-1 排 rv-5 之后串行进 loop.ts | S6：loop.ts 领地串行链 rv-1 → rv-4 → rv-5 → mx-1；human-loop.ts 的 exec-review 文案补 --evidence-refs（rv-2 披露的协调项）随本 unit 一并修 |

## 5. 验收（真实场景）

- A1 human 全链：双子树项目人扮演 designer/builder/reviewer → root closed；**verdict 事件 ts 晚于 reviewer brief 文件 mtime**（S7：替代 v1 无判别力的 seq 断言）；账本中 spec-review verdict 带 role=reviewer（human 场景 role=human 亦可，锁定「非 designer 自审」）。
- A2 打回循环：reviewer fail（comment 含不合格项）→ **specFixPending 派 designer**（非 reviewer）→ 新 spec → reviewer pass → spec-frozen。断言：designer brief 全文与 human designer 指令输出**均**不含 `review submit` 字样（S4）。
- A3 防活锁：同 unit fail → designer 重提（改 1 字节）→ fail（第二次）→ **specReviewDeadlock 出现**（frontier --json）+ escalation 含两次 fail comment 摘要 + 该 unit 不再派发；对照：不重提的两连 fail 同样触发（MF2 两种形态都测）。
- A4 模型链：CW_REVIEWER_MODEL 进程环境 → reviewer spawn 的 pi 命令行含对应 --model；--reviewer-model flag 优先；都未设 → 与 builder 同 model（spawn 命令行对照断言）。
- A5 抢答警告：人为在无 in-flight reviewer 时提交 spec-review verdict → loop stderr 出现警告行（不阻断）。
- A6 真实 pi E2E（M4 gate 承载）：微任务全链含 reviewer spawn；reviewer 与 designer 的 topic brief 分别存在且内容不同；idle 参数按 D5 调大。

## 6. 下一层拆分

单 unit 承载（mx-1，排序 rv-5 之后）：src/runner/loop.ts（DISPATCH_SHAPE/三任务书/specReviewDeadlock 出口/派发 gate/抢答警告/exec-review 文案补 refs）、src/readonly/frontier.ts（specReviewPending + specFixPending + specReviewDeadlock 谓词重排）、src/runner/human-loop.ts（exec-review 文案）、src/runner/spawn/human.ts（designer 指令删自审 + reviewer 指令）、src/handlers/run.ts（--reviewer-model）、src/handlers/review-submit.ts（--role flag）、src/events/types.ts（role 可选字段）、src/handlers/spec-schema.ts（schema 同步）、tests/mx1-*.test.ts + u7/u5b 断言迁移。

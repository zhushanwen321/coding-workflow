# cw 四流程重构设计（design / dev / test / closeout）

> **当前层 → 下一层**：产品流程架构层 → 可实施的波次 unit 拆分层（§5）。不设计到函数签名。
> 口径前提（已定）：① dev 流程单测允许 mock；test 流程必须真实 E2E。② design 反思环节采用「同 session 二轮用户消息」形态（探针 P1 已实测可行，见 §3.3 D3）。

**一句话结论**：在现有「事件账本 + fold 投影 + runner 派发」地基上，把 unit 生命周期显式组织为四个流程（design / dev / test / closeout），每个流程 = 「agent 执行 + 机器/异源验收 + 打回环 + 预算转人工」——新增 1 个状态（built）、3 类事件扩展（stage / kind / assumptions）、4 个新环节（反思、code-review、test 分离、retrospect），旧账本重放逐字节兼容。

## 1. 背景目标

**SCQA**

- **S（情境）**：cw 2.0 已完成 M0-M6：append-only 事件账本 + fold 四态投影（`created → spec-frozen → verified → closed`）+ runner 按 13 个 frontier 维度派发 designer/developer/reviewer，M4 gate 四跑全链收敛零人工。
- **C（冲突）**：流程组织是「投影维度」而非「流程」——designer 一个角色 5 种任务书、13 个维度按失败类型散布（design 侧占 7 个）；dev 无质量环（exec-review 审证据链不审代码）；design 无反思（agent 首答即终答）；closeout 结构性缺失（closed 后只有资源回收，零知识沉淀）；mock 边界松（core 验收可用 e2e-mock）。
- **Q（问题）**：怎么让每个 unit 的交付过程有可理解的流程心智模型，且每个环节都有验收闭环、质量把关和知识沉淀——而不是「能收敛但过程黑盒、质量裸奔、经验蒸发」？
- **A（答案）**：四流程显式化——每层 unit 生命周期固定为 design / dev / test / closeout 四个流程，每个流程自带执行者、验收锚点、打回环与预算，通过最小事件增量落地在现有账本上。

**系统是什么**：cw（`@zhushanwen/coding-workflow`）是「agent 工作的 CI」——把超出单个 LLM 上下文半径的编码任务分解为可验证 unit，用机器证据（事件账本）判定完成。用户 `cw create` 建 root unit 后 `cw run --spawn pi`，runner 循环派发 agent 直到 root closed。本文的「layer」指 unit 树层级（深度上限 2：root + 叶）。

**设计目标**（从使用者体验倒推）：

| # | 目标 | 使用者体验 |
|---|------|-----------|
| G1 | 每 layer 只有 4 个流程 | 观察者跑 `cw status` 能直接回答「这个 unit 现在在哪个流程、卡在哪一环」 |
| G2 | 每流程 = 执行 + 验收 loop | 每个流程的产物都有明确验收方（机器或异源 reviewer），fail 有打回环，环有预算，预算尽转人工 |
| G3 | design 含 clarify / plan / 反思 / review | designer 出 spec 前强制澄清假设；spec 产出后收到「用户口吻」的固定反思提问并可能自行修订；独立 reviewer 六维审 |
| G4 | dev = TDD + 影响面单测 + 规范 review + code-simplify | developer 按测试先行迭代、只跑受影响单测（禁全量）；代码被异源 reviewer 按四维规范审；提交前过简化自查 |
| G5 | test = 真实 E2E | test 流程在干净 checkout 真实执行全部验收，core 验收必须 e2e-real（真实环境跑流程），dev 单测的 mock 不进入 test 判定 |
| G6 | closeout = retrospect + 文档更新 | unit closed 前必有 retrospect 产物入账（复盘 + 文档更新动作），root closeout 产出整树总账 |

**in-scope**：状态机与事件扩展、四流程环节定义、brief 模板重组、frontier 维度归桶、新旧账本兼容、环预算。
**out-of-scope**：分层深度放开（仍 2 层）、spawn 并发模型、多语言适配器、npm 发版流程、pi 之外的 agent harness 适配细节。

## 2. 现状与问题分析

**现状是「维度驱动」而非「流程驱动」，五个差距直指 G1-G6。**

### 2.1 现有生命周期与派发（使用者视角，锚点取自源码）

一个叶子 unit 从创建到 closed，现状实际发生（`src/runner/brief.ts` renderBrief 按维度选模板，`src/runner/loop.ts` DISPATCH_SHAPE 派发）：

```
cw create（人工） → UnitCreated
designer spawn ① ：（root 版含建子第 0 步）写 spec → SpecSubmitted
reviewer  spawn ② ：六维对抗审 spec-review → pass 则 spec-frozen；fail 则打回（环，10 代转人工）
developer spawn ③ ：3 步固定指令——实现 → commit → cw verify（红阶段+干净重跑+名字比对一体）
                  → VerifyRan pass 则 verified；fail 则隐式重派（环，buildDrift K=5 / flake 连挂 2 转人工）
reviewer  spawn ④ ：exec-review 审证据链 → pass 则 closed（环无上限无出口，仅 idle 兜底）
（root 内部节点：子全 verified → loop 直跑集成 verify，首败即转 designer）
closed 之后：worktree 回收 + 汇总输出。无 retrospect、无文档回写、无 CHANGELOG。
```

developer 的全部任务书（`brief.ts` 实现 3 步）：实现冻结验收 → `evidence submit --kind build` → `cw verify`。没有测试先行要求、没有影响面单测指令、没有规范审查、没有简化环节。

### 2.2 差距清单（调研实证，附差距-目标对照）

| # | 现状 | 差距 | 目标 |
|---|------|------|------|
| 1 | 13 个 frontier 维度按失败类型散布（design 侧 7 个、closeout 仅 1 个），无「流程」概念 | 观察者无法按流程心智模型回答「现在在哪一步」 | G1 |
| 2 | 7 个环已具备「验收+预算+转人工」雏形，但按失败类型切分；exec-review 环无预算无出口 | 环结构存在但未按流程归组；closeout 环预算缺失 | G2 |
| 3 | designer 一次 spawn 出 spec（root 含建子）；歧义靠 reviewer 事后打回；无任何自我审视机制；spec-review 六维审查强健 | clarify（事前假设声明）、反思（产出自省）缺失 | G3 |
| 4 | 红阶段只保证「验收测试有区分力」（TDD 的判定半边），不强制时序；规则⑪全量回归仅 warning；exec-review 不审代码；任何阶段无 code-simplify | dev 四环（TDD 时序 / 影响面 / 规范审 / 简化）全部缺位 | G4 |
| 5 | core 验收允许 e2e-mock（规则②只要求「e2e 级」）；manual 免机器验证；五枚举无占比约束 | test 流程未强制真实 E2E | G5 |
| 6 | closed 是终态，之后只有资源回收；ledger/CHANGELOG/经验沉淀全靠人工波次动作 | closeout 结构性缺失 | G6 |

### 2.3 根因分析

1. **状态机粒度不够**：四态里「verified」一态吞掉了「dev 验收过」和「test 验收过」两件不同的事——前者是开发者内环质量（快、可迭代），后者是交付级验证（重、一次性）。一态两义导致 dev 质量环节（规范审、简化）没有挂载点。
2. **brief 按「失败维度」组织而非按「流程阶段」组织**：任务书是「出问题了怎么修」的集合，不是「这个阶段该做什么」的集合——角色职责因此无法对齐流程。
3. **质量与知识是「人的动作」而非「机器通道」**：M0-M6 全程的波次总账、设计回写、经验沉淀由人工 agent（编排者）完成，账本没有对应事件类型，closed 后无从谈起。
4. **mock 边界没有分层语义**：验收枚举回答「用例长什么样」，但没有回答「哪一层必须真实」——dev 内环单测与交付级 E2E 共用同一套判定。

### 2.4 现状物理数据流（事件账本 → 观察者）

```
磁盘 events.log（五类事件 JSONL，append-only）
  → fold 投影（src/core/fold.ts deriveStatus：四态 + per-unit 事件折叠）
  → computeFrontier（13 维度就绪判定）
  → ① runner loop 派发（DISPATCH_SHAPE：维度 → 角色 + spawn）
    ② cw status / frontier / tree / report（人看）
spawn 产物：~/.cw/topic/<encoded-cwd>/<runTs>-<rootId>/（brief/stdout/stderr + session JSONL）
```

改造落点：事件层（新增字段/枚举）、fold 层（新态 built）、frontier 层（归桶）、brief 层（流程化模板）、loop 层（新派发形态：反思 resume、test-verify 直跑）——五层都是现有文件内的增量，无新顶层概念。

## 3. 解决方案

### 3.1 终态（使用者视角）

**一个叶子 unit 的完整四流程生命周期**（时间线叙事，含每环节验收锚点）：

```
【design 流程】created → spec-frozen
  designer spawn ①：
    步骤 0（root 版）：建子 unit（既有 children-first）
    步骤 1 clarify：通读 brief，列出全部歧义与假设 → 写入 spec.assumptions[]（每条 = 假设 + 依据 + 若错的影响）
    步骤 2 plan：拆分方案 = spec.split + 各子验收边界（既有载体，不新增机制）
    步骤 3：提交 SpecSubmitted
  反思环节（同 session 二轮）：runner 检测到最新 SpecSubmitted 无对应反思产物（specHash 锚，见 D3）→ 对同一 session
    追加用户口吻的固定反思问题（附录 A 七问）→ agent 逐问回答 + 结论
    → 若反思发现问题：自行修订 spec 重提（新 SpecSubmitted，不计打回代数）
  reviewer spawn ②：六维对抗审（既有）+ 新增第七维「assumptions 完整性」
    （关键歧义未声明假设 = must-fix）→ pass 则 spec-frozen
  环：fail → designer 修重提（10 代转人工，既有）

【dev 流程】spec-frozen → built
  developer spawn ③：
    步骤 1 TDD：先写测试（冻结验收 + 自补充单测），测试在基线树必须红（红阶段机器兜底）
    步骤 2 影响面单测：迭代期间只跑 vitest related <改动文件>（禁全量；全量只在 test 流程跑一次）
    步骤 3 code-simplify 自查：对照固定清单（降认知复杂度、不改行为）整理后 commit
    步骤 4 dev-verify：cw verify --stage dev（轻量一次性 checkout 快速内环：unit 级验收 + 红阶段，不触碰 worktree）
  reviewer spawn ④：code-review（新）——四维规范审（类型安全/错误处理/边界条件/测试有效性）
    + simplify 遗留检查 → pass 则 built
  环：任一 fail → developer 重派；build 周期预算 buildDrift K=5 照旧计数（code-review 打回的重派自然计入）

【test 流程】built → verified
  loop 直跑（不派 agent）：cw verify --stage test
    = 干净 checkout + 独立 CW_HOME + 全部验收真实执行（含 e2e-real 全流程）+ 名字比对
  环：fail → developer 重派；flake 连挂 2 / 解析失败回炉（既有机制照搬）
  mock 边界：core 验收必须 e2e-real（规则②收紧）；e2e-mock/manual 仅限非 core 条目

【closeout 流程】verified → closed
  reviewer spawn ⑤：exec-review 证据链审（既有）——环补预算：fail 连挂 ≥2 转人工（补现有无上限缺口）
  designer spawn ⑥：retrospect——产出 retrospect.md（做了什么/学到什么/给后续 unit 的建议）
    + 文档更新判断（AGENTS/CONTEXT/CHANGELOG 需要改吗？需要则改，随 evidence 提交）
    → evidence submit --kind retrospect（产物 sha256 入账）
  closed 判定 = exec-review pass ∧ retrospect 已入账 ∧ 树感知（子全 closed）
```

**四流程 × 验收总表**（G2 的落地形态）：

| 流程 | 执行者 | 验收者 | 验收锚点（账本事件） | fail 出口 | 预算/转人工 |
|------|--------|--------|---------------------|-----------|------------|
| design | designer | 异源 reviewer（六维+assumptions 维） | VerdictSubmitted(spec-review, pass) | specFixPending 修重提 | 10 代 → 转人工（既有） |
| dev | developer | 机器（dev-verify）+ 异源 reviewer（code-review） | VerifyRan(stage=dev, pass) ∧ VerdictSubmitted(code-review, pass) | 重派 developer | buildDrift K=5（hasPass 收紧为 test-pass，D10） |
| test | loop 直跑 | 机器（干净重跑三道 gate） | VerifyRan(stage=test, pass) | 重派 developer | flake 连挂 2 / 回炉 2 代（既有） |
| closeout | designer（retrospect） | 异源 reviewer（exec-review）+ 机器（retrospect 证据存在性） | VerdictSubmitted(exec-review, pass) ∧ EvidenceSubmitted(kind=retrospect) | exec-review fail 重审；两环序贯完成才 closed（同 unit in-flight gate 天然串行） | exec-review 连挂 2 → 转人工（新增） |

**失败路径示例**（带恢复指引）：code-review fail → unit 停在 spec-frozen，frontier 显示 `dev.codeReviewPending(fix)`，developer 任务书内嵌四维 fail comment 全文 → 重派修复；若 build 证据本周期 ≥5 → buildDrift 停派，stderr 输出「转人工：执行 cw report --unit <id> 查看失败链，人工修复后重跑 cw run 续接」。

### 3.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **A. 事件增量 + 状态机扩展**（本设计）：新增 built 态 + VerifyRan.stage 字段 + kind 枚举扩展 + spec.assumptions 字段，四流程 = fold/frontier/brief 的重组而非新顶层 | 高：流程语义进账本（可审计可重放），「状态不存储只计算」哲学不破；每环节验收锚点都是事件，G2 的 loop 有机器锚 | 中：事件 schema + fold + frontier + brief + loop 五层增量，约 5-6 个 unit 波次 | 旧账本兼容需逐字段缺省设计（已有 parseFailedAcceptanceIds 先例可循）；spawn 数 +2/叶（反思 resume + code-review） | ✅ **推荐** |
| B. 纯 brief/观测层组织：不加事件不加态，任务书按四流程重写 + status 输出分组 | 低：流程无账本锚点——「dev 验收过」仍是隐式的（verify 一体），code-review/retrospect 无入账载体，「流程」只是文案约定 | 低：纯模板与展示改动 | 反思环节无法与 spec-review 派发解耦（无「已反思」判据）；retrospect 产物无验收锚点，「closeout」无法被机器判定完成——G2/G6 落空 | ❌ 若用 B，§3.1 的 built/code-review/retrospect 三环节全部退化为「任务书里写了但机器不知道做没做」 |
| C. 全量新事件模型（PhaseStarted/PhaseAccepted 独立事件流） | 中：显式但冗余——phase 态可由现有事件投影得出，独立事件流引入双事实源（phase 事件 vs 派生事实打架时谁对？） | 高：事件模型重写 + 全部投影重写 + 旧账本迁移 | 破坏 append-only 单一事实源的极简性；「状态不存储只计算」哲学被侵蚀 | ❌ 若用 C，§2.4 的数据流从「一源五层」变「两源互相校验」，审查面翻倍 |

**推荐 A 的核心理由**：四流程的本质是「对既有事件序列的另一种投影 + 少量新锚点」，不是新事实源。A 让每个新环节（反思、code-review、retrospect）都有一个可重放的入账锚点，同时不推翻 M0-M6 任何已验证机制（7 个环全部复用）。

### 3.3 关键决策与权衡

**D1：状态机扩展——插入 built 态（选定）**
- **采用**：五态 `created → spec-frozen → built → verified → closed`。**built 判定（时序锚定，对齐 spec-review 的「最后 spec 后 verdict」语义）= 最新 build 证据之后存在 `VerifyRan(stage=dev, pass)`，且该 dev-verify 之后存在 code-review pass verdict**——verdict 必须晚于它所审的代码证据，旧 pass 对新代码无效。推论：test 流程 fail 重派 developer 后产生新 build 证据 → built 重新判定 → code-review 必然重审（代码变了，规范审不可继承）。verified 判定 = **built 达成 ∧ built 之后 `VerifyRan(stage=test, pass)`**（合取而非仅看 test 事件——裸跑 `cw verify`（无 stage）产生的 pass 事件无法绕过 built：无 code-review pass 则永不 verified，环在结构上不可绕过，by construction）。内部节点无 built（其 dev/test 合体 = 集成 verify，stage=test；root 纯分解无实现代码，code-review 无审查对象）。旧账本兼容由 D11 代际信号保护。
- **被否**：不新增态（方案 B）——built 无锚则 code-review 无挂载点；新增独立 phase 事件流（方案 C）——双事实源。
- **证据**：fold 现有 verified 分支只看 VerifyRan（`src/core/fold.ts` deriveStatus）；可选字段缺省重放先例 `VerifyRanPayload.parseFailedAcceptanceIds`（`src/events/types.ts` 注释明示「旧账本缺字段 = 无解析失败，重放兼容」）。
- **效果**：G1 的流程心智模型有状态锚；G4 的两个质量环节（code-review、simplify 后置审）有挂载态。

**D2：design 流程 = clarify（assumptions 字段）+ plan（既有 split）+ 反思（二轮消息）+ review（六维+1）（选定）**
- **采用**：clarify 落地为 `spec.assumptions[]`（每条：假设内容 / 依据 / 若错的影响面），designer 任务书强制步骤，reviewer 新增第七维「关键歧义未声明假设 = must-fix」。plan 不新增机制——spec.split 与各子验收边界就是 plan 产物，受 reviewer 覆盖度维审查。反思见 D3。
- **被否**：clarify 走「停派转人工问用户」——破坏零人工收敛目标，且假设声明在无人工场景是唯一诚实出口；plan 单独出文档再审——多一次 spawn 换不来额外信息（split 本身就是被审对象）。
- **证据**：现状歧义处理无机制出口（designer 任务书无澄清步骤，reviewer 以 fail comment 事后暴露——调研 A 报告 §3.2）。
- **效果**：G3 的 clarify/plan 落地；假设清单让 reviewer 的审查从「猜歧义」变「审假设」。

**D3：反思环节 = 同 session 二轮用户消息（选定）**
- **采用**：时序 = SpecSubmitted 入账后、spec-review 派发前。机制 = designer spawn① 结束时 session 已落盘（mx-3 交付：`--session-dir <topic目录> --name <unitId>-designer`）；runner 观察到新 SpecSubmitted 且该 unit 无反思记录 → 以 `pi -p --session <session文件> "<反思固定文案>"` 二轮 spawn 同一 session——agent 看到的是「用户发来的新消息」，上下文含其刚写的 spec。反思产物留痕 = session 文件追加 + spawn stdout 落 topic 目录（fx-4 机制照搬）。若反思结论要修订：agent 自行重写 spec 提交新 SpecSubmitted（无 fail verdict，天然不计打回代数——代数只由 fail verdict 驱动，`frontier.ts` specReviewFailCounts 语义）。反思的完成锚点与预算（对抗审查 MF2 修订）：① **spec 级锚点** = topic 目录产物文件 `<unitId>-reflect-<specHash>.stdout`（specHash = 被反思那版 spec 的入账锚 hash）——判定「当前最新 SpecSubmitted 是否有对应反思产物」精确可判、跨 run 稳健；打回重提的新 spec 是新 hash，需重新反思（spec 级语义）。② **半截反思不误判**：产物先写 `.tmp`，spawn settle 后原子 rename 为最终名，判定只认最终名（spawn 启动即建文件的既有行为不污染锚点）。③ **预算**：unit 级反思 ≤2 轮（**轮次按 spawn 尝试数计，含 TIMEOUT——产物未产出也计轮**，防 TIMEOUT 反复逃出预算），超出不再派反思、直接走 specReviewPending（防「反思→修订→再反思」无出口循环，显式降级语义）。④ **派发互斥**：反思 spawn 纳入 in-flight 管理（复用同 unit 缓派 gate），reflectionPending 判定序先于 specReviewPending——反思未完成时不派 reviewer。⑤ **session 定位**：pi session 文件名实测为 `<ts>_<uuid>.jsonl` 不含 --name，跨打回多 session 时 runner 以 topic 目录内 mtime 最新 + JSONL 内 name 字段校验消歧（实施期联测）。固定文案见附录 A（七问）。
- **被否**：反思清单内嵌任务书（降级路径，见 P1 探针）——agent 知道是任务书一部分，临场感弱，但机制改动最小（纯 brief 模板），作为 pi resume 形态失效时的降级；独立反思 spawn——丢设计上下文且与 reviewer 职能重叠，「自我反思」变「他人审查」。
- **证据**：**探针 P1 ✅ 已实测**（2026-08-23）：`pi -p --session <file> "问题"` 二轮消息正确续接上下文（暗号召回实验通过；审查方独立复跑亦过）；session 落盘 ✅（mx-3 交付，M4 gate 三/四跑 19×19、45×45 session 一一对应有案）；代数计数不污染 ✅（推理自 `frontier.ts` 打回代数 = fail verdict 驱动，实施期以单测锁）；session 文件名不含 --name 为实测事实（消歧见采用⑤，runner 侧定位联测 ⛔ ph-2）。
- **效果**：G3 反思落地；「以为用户在指导」的形态由 P1 探针背书。

**D4：dev 流程四环 = TDD 指令 + 影响面单测指令 + code-simplify 自查 + dev-verify（选定）**
- **采用**：developer 任务书从 3 步扩为 4 步。① TDD：先写测试后写实现——冻结验收的机器兜底 = 红阶段（dev-verify 内跑，恒真验收被拒）；自补充单测不受红阶段覆盖（红阶段只检验收条目引用的文件），其恒真风险由 code-review 测试有效性维语义兜底；② 影响面单测：迭代期间 `vitest related <改动文件> --run`（探针 P2 ✅ 实测可用，零新基建），任务书明令禁全量——全量执行点唯一性由 M5 规则⑪/topic 层既有机制兜底，任务书指令解决的是「developer 迭代期自觉性」；③ code-simplify 自查：对照固定清单（与 `.agents/skills/code-simplify` 同源：降认知复杂度、去重复、删死代码、不改行为）整理后 commit；④ `cw verify --stage dev`。mock 口径：dev 内环单测允许 mock（口径前提①），不受 e2e 限制。
- **被否**：影响面单测做成 spec gate 强制（如校验 command 形态必须 related）——影响面是 developer 迭代成本问题，不是验收语义问题，机器无法静态判定「该跑哪些」（文件集是运行时事实）；code-simplify 独立 spawn——纯自查性质，多一次 spawn 成本无验收增量。
- **证据**：红阶段机器兜底 ✅（rv-4 交付，四跑 7/7 恒真拦截）；vitest related ✅（探针 P2，vitest 4.1.10 demo 实测只跑受影响文件）；TDD 时序不可机器强制（红阶段验判定不验时序——调研 C 报告 §3.2），故 TDD 落地为任务书指令 + 判定机器兜底的组合。
- **效果**：G4 前三环落地；「先红后绿」靠指令，「测试有区分力」靠机器——时序不强制但判定不放过。

**D5：code-review = 异源 reviewer 新环节，四维 + simplify 遗留（选定）**
- **采用**：dev 流程第二个验收。触发维度 `codeReviewPending`（dev-verify pass ∧ 无 code-review pass verdict）→ 派 reviewer（异源模型链照旧：`--reviewer-model` > env > developer 同款）。审查维度四维规范（类型安全：无 any/as 断言链；错误处理：异步有 catch 且不空；边界条件：空/零/极值/并发；测试有效性：断言具体、覆盖正常+异常路径）+ simplify 遗留检查（明显的未简化形态）。verdict 入账 `VerdictSubmitted(kind=code-review)`，role 强校验 reviewer（对齐 spec-review，非 exec-review 的自报制）。fail → comment 四件套（维度/位置/问题/修法）→ developer 重派；维度子态路由与 specReviewPending/specFixPending 同构：codeReviewPending 无 pass verdict = 待审（派 reviewer），最近 verdict = fail = 待修（派 developer，任务书内嵌 fail comment）——同桶不同派发对象，附录 B 口径。**审查对象内容锚定（MF4 修订）**：任务书内嵌本次审查锚点 = build commit hash + 指引「审 `git diff <baseCommit>..<build commit>` 增量」（baseCommit = 该 unit 分支基线）——审的是证据 commit 的增量而非 worktree 当前树，developer 交证据后的未 commit 残留不进审查视野，verdict 与被审内容严格绑定。
- **被否**：规范审并入 exec-review——exec-review 在 test 之后，规范问题发现太晚（返工链变长：test 都过了才发现类型问题）；规范审做成 lint 命令机器跑——四维中测试有效性/边界条件是语义判断，机器 lint 覆盖不了（现有 eslint 已在跑，机器能管的不缺）。
- **证据**：异源 reviewer 机制 ✅（mx-1/mx-3，四跑 22/22 verdict role=reviewer）；四维清单取自 pr-cr-fix skill 的 quality-criteria（本项目 fx-7 波实战用过）。
- **效果**：G4 第四环落地；「实现能过验收但代码质量裸奔」的缺口（§2.3 根因 1）补上。

**D6：verify 拆两阶段——stage 字段 + 干净度差异（选定）**
- **采用**：`cw verify --stage dev|test`（缺省 test，兼容现有命令面）。dev = unit 级验收 + 红阶段，跑在**轻量一次性 checkout**（源 = unit worktree HEAD commit——对齐 red-phase 既有设计前提「在一次性 checkout 工作区内执行，不触碰原仓库」：不污染 developer 工作区、异常中断无脏树；成本仍远低于 test 级：无 e2e 全量、无独立 CW_HOME 全量重跑）；test = 干净 checkout + 独立 CW_HOME + 全部验收（含 e2e-real 真实执行）+ 名字比对 + 红阶段——即现有 verify 全量语义，由 loop 直跑（不派 agent，对齐集成的确定性代码形态）。`VerifyRan` 事件加可选字段 `stage: "dev"|"test"`（缺省重放 = test，旧账本语义由 D11 代际信号保护）。**绕过防线（MF3 修订）**：verified = built ∧ test-pass 的合取（D1）使裸跑 verify 产生的无 stage pass 事件无法跳过 code-review 环——结构上无绕过通道；另补温和防线：无 stage 且账本已进入新代际时 verify 入账 stderr 提示「建议显式 --stage」。
- **被否**：不拆（verify 一体）——dev 迭代每次付干净 checkout 全量成本，且 code-review 无时机插入（审完规范又跑一遍 test 才 built，环节交错）；dev 也干净 checkout——dev 环是 developer 内环，干净度由 test 环一次性兜底，内环快比内环严更优（成本与改动面成正比，M5 G1 同哲学）。
- **证据**：干净 checkout 三道 gate ✅（u4a/u4b 交付，四跑在场）；verify CLI 单命令现状（`handlers/verify.ts` runRegularVerify）。
- **效果**：G2 dev/test 各有验收锚点；G5 test = 现有最严形态整体平移。

**D7：mock 口径——core 必须 e2e-real，枚举不动（选定）**
- **采用**：规则②收紧：core 用例 type 必须 `e2e-real`（原「e2e 级含 e2e-mock」）。e2e-mock/manual 保留为非 core 条目的合法枚举（第三方不可复现环境的诚实出口，规则④保真说明 + reviewer 语义关照旧）。dev 单测（developer 自补充的测试）mock 自由，不进验收枚举体系。test 流程判定 = 全部验收在干净 checkout 真实执行，core 必然真实。**core 标记诚实性（S3 补）**：reviewer 第七维顺带审「brief 核心风险面是否都被 core 条目覆盖」（不标 core 即绕过的通道由语义审封）；第三方不可复现依赖的处置指引：core 拆到不依赖第三方的可控部分（契约层/适配层），第三方交互条目按非 core + e2e-mock + mockFidelityNote 诚实声明。
- **被否**：砍枚举——breaking 且第三方 API 场景失去诚实出口（只能造假或卡死）；仅要求 root 有 e2e-real——叶子 core 用 mock 时集成才暴露，返工链长。
- **证据**：规则②现状（spec-rules ①-⑫ 清单，core 仅要求 e2e 级）；五枚举 + mockFidelityNote 体系（`events/types.ts` AcceptanceType）。
- **效果**：G5 落地——「test 流程必须真实 E2E」由 spec gate（入账前拒）+ test-verify（真实执行）双层保证；旧账本零影响（gate 只拦新入账 spec）。

**D8：closeout = exec-review（补预算）+ retrospect 新环节（选定）**
- **采用**：exec-review 语义照旧（证据链审查，evidence-refs 强制），环补预算：fail 连挂 ≥2 → 转人工（与 flake 同构，补「无上限无出口」缺口）。retrospect = designer 复用（第六种任务书形态）：产出两件——① `retrospect.md`（本 unit：做了什么 / 验收链事实 / 学到什么 / 给后续 unit 的建议）落 topic 目录 + ② 文档更新判断（AGENTS/CONTEXT/CHANGELOG/相关 docs 是否需要跟改，需要则直接改，diff 随证据提交）。入账 `EvidenceSubmitted(kind=retrospect)`——现状事实：`EvidenceSubmittedPayload` 无 kind 字段（spec/build 区分在事件类型层面：spec → SpecSubmitted，build → EvidenceSubmitted；`--kind` 仅 CLI 参数），ph-1 落字段 `kind?: "build"|"retrospect"`（可选，旧账本缺省 = build，重放兼容，D11 同族）。closed 判定收紧：exec-review pass ∧ retrospect 证据已入账 ∧ 树感知——**收紧仅对新代际 unit 生效**（D11 unit 级代际信号：旧 unit 豁免 retrospect 前提，重放 closed 集合不变，混合账本常态兼容）。root 的 retrospect = 整树总账（各 unit 状态/事件数/转人工记录/遗留项）。
- **被否**：retrospect 独立新角色 closer——角色最小化（designer 对 unit 目标最清楚，复盘视角最完整）；文档更新全自动推送（commit 到成果分支外）——超出 cw 领地（回流主分支保持人工，现有哲学），retrospect 的文档改动限制在 unit worktree 内随分支回流。
- **证据**：EvidenceSubmitted kind 扩展先例（spec/build 两 kind 已在，schema 是 union literal，扩展是加法）；exec-review 无上限缺口（调研 A 报告 §2.5 机制层确认）。
- **效果**：G6 落地；closed 从「审完即散」变「审完 + 沉淀完」。

**D9：观测面按四流程归桶（选定）**
- **采用**：frontier 维度归桶：design = specReady/reflectionPending*/specReviewPending/specFixPending/missingChildren/specContractBroken（+deadlock 兜底）；dev = buildReady/codeReviewPending*（+buildDrift 兜底）；test = testReady*/integrationReady/integrationDrift（+flake 兜底）；closeout = execReviewPending*（原 execReviewReady 更名）/retrospectPending*（+execReviewDeadlock* 兜底）。`cw status`/`frontier`/`tree` 输出按桶分组展示（`<流程>.<维度>` 前缀），report 不变。维度判定逻辑零变化（纯展示层归组；新增维度 5（含兜底 1）+ 更名 1，见附录 B）。
- **被否**：重排 GROUP_ORDER 打散既有维度序——既有序是生命周期序，与流程桶序一致，归桶只加前缀不重排。
- **证据**：GROUP_ORDER 现状（`frontier.ts`，生命周期展示序）。
- **效果**：G1 落地——`cw status` 一眼回答「在哪个流程、卡在哪一环」。

**D10：环预算归置——新环全部挂靠既有预算（选定）**
- **采用**：code-review fail 重派 → 新 build 证据自然进 buildDrift 计数（K=5 照旧，含 code-review 打回周期）；**hasPass 豁免收紧（MF1 修订）**：buildDriftFacts 的 pass 豁免语义改为「stage=test 的 pass」（现状为任意非集成 pass——若不收紧，dev-verify 反复 pass 会使谓词永假，code-review 连续打回场景 K=5 永不可达，预算失效活锁）；test fail → flake 连挂 2 / 回炉 2 代照旧；exec-review fail 连挂 2 → 新转人工维度（唯一新增预算）；反思环预算 = unit 级 ≤2 轮（D3③），超时走 spawn TIMEOUT 既有封顶 2。
- **被否**：code-review 独立预算（如「规范打回 3 次」）——多一个预算旋钮多一套调参，buildDrift 已覆盖「本周期修不动」的语义；预算 per-unit 可配——无需求证据，不加（减法）。
- **证据**：buildDrift 计数输入 = 本 spec 周期 build 证据数（`frontier.ts` buildDriftFacts），code-review 打回必然伴随新 build 证据。
- **效果**：G2 预算闭环；预算旋钮数不增（除 exec-review 一处补缺）。

**D11：代际信号——旧语义豁免的唯一机制，unit 级粒度（选定）**
- **采用**：fold 投影时计算 **unit 级**信号 `hasNewSchemaSignal(unitId)` = 该 unit 的事件子集中出现任一新 schema 痕迹（VerifyRan.stage / VerdictSubmitted(kind=code-review) / EvidenceSubmitted(kind=retrospect) / spec.assumptions）。false = 该 unit 旧代际 → 按旧语义投影（四态、无 built、无 retrospect 前提、buildDrift 旧 hasPass）；true = 新代际 → 五态新语义。**粒度必须 unit 级而非账本级**：账本是 per-cwd 共享（`~/.cw/<encoded-cwd>/events.log`），升级后同目录开新 topic 即引入新 schema 事件——账本级信号会把同账本里的旧 closed unit（无 retrospect）复活为 retrospectPending（status 回退违反 D8 承诺，且 resume 旧 root 时对已回收 worktree 派 spawn）。unit 级信号下混合账本（旧 closed unit + 新 unit 并存）是升级后常态且行为正确：旧 unit 子集无新痕迹 → 旧语义不动；新 unit 子集有新痕迹 → 新语义。信号账本内自足（无需外部时间界线/npm 版本对齐），单次 run 内一致；MF3 绕过防线与 MF5/P3/P6 兼容判定共用此机制。
- **被否**：时间界线豁免（「上线 commit 之前入账」）——npm 分发场景用户账本与 cw 版本无锚定力，跨机器重放不严谨；账本级粒度（上述复活缺陷）。
- **证据**：可选字段缺省重放先例（parseFailedAcceptanceIds 同族）；五类事件均含 unitId，fold 已按 unit 折叠，unit 事件子集可稳定切分；SpecSubmittedPayload.specHash / EvidenceSubmittedPayload.commit 本就存在（sha256/commit 锚，零 schema 增量）。
- **效果**：S2（旧账本逐字节重放）与混合账本常态均逻辑可达；兼容与防线共用单一机制，无双事实源。
### 3.4 探针清单

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|----|-----------|------|------|-----------------|
| P1 | 同 session 二轮消息续接上下文（反思机制前提） | `pi -p --session <file> "暗号是什么"` 召回首轮暗号；runner 侧半边（spawn → session 消歧定位 → 二轮 resume）⛔ ph-2 首门联测 | ✅ 2026-08-23 实测通过（机制半边；审查方独立复跑亦过） | 降级 = 反思清单内嵌 design 任务书（D3 被否项），brief 模板预留双形态开关 |
| P2 | vitest related 只跑受影响测试 | demo 项目改动文件 → 只跑关联测试文件 | ✅ 调研 C 报告实测（demo v4.1.11；cw 本仓 4.1.10） | 降级 = 任务书指令改为「跑新增/修改的测试文件」（显式文件枚举） |
| P3 | D11 unit 级代际信号三形态：旧账本逐字节重放 / 新代际五态生效 / **混合账本（旧 closed unit + 新 unit 并存）行为正确** | 新代码 fold 重放 M4 四跑账本（.xyz-harness/m4-gate4-evidence/，96 事件）与 fixtures 存量账本对比 golden；构造含 stage 事件的新账本断言五态；构造混合账本断言旧 unit 仍 closed ∧ 新 unit 走五态 | ⛔ ph-1 波次门 | 失败 → 信号改显式代际标记事件（append 一条 generation 事件，含它 = 新语义，仍 unit 级自足） |
| P4 | code-review 连续打回场景预算可达（hasPass 收紧生效） | human 模式全链：dev-verify 恒 pass ∧ code-review fail×5 → build 证据 5 条 → K=5 停派触发 + 转人工出声 | ⛔ ph-3 波次门 | 失败 → buildDrift 谓词叠加「code-review fail 连挂 ≥3 独立触发」旁路预算 |
| P5 | 反思链三断言：修订不计打回代数 / specHash 锚点跨 run 判定 / 预算 ≤2 生效 | 单测锁代数（无 fail 重提 N 次代数恒 0）；模拟 Ctrl-C 后按 specHash 判「未反思」续派；反思第 3 轮不再派 | ⛔ ph-2 波次门 | 失败 → 反思预算改账本事件锚（新增 ReflectionRan 事件计数），放弃文件锚 |
| P6 | D11 unit 级信号下 closed 判定两侧行为：旧/混合账本重放 closed 集合不变 / 新代际缺 retrospect 不 closed | 旧账本与混合账本（旧 closed unit + 新 unit）重放断言 closed 集合不变（旧 unit 不复活）；构造新代际账本（含 stage 事件）缺 retrospect → 停在 verified（retrospectPending） | ⛔ ph-5 波次门 | 失败 → retrospect 前提降为 warning（closeout 完成度提示而非 closed 硬前提），G6 由 exec-review 任务书强制审 retrospect 存在性兜底 |

## 4. 验收（真实场景，非单测）

改动规模：大（状态机 + 事件面 + 派发链 + 新环节）。以下场景全部用真实 pi spawn + 真实账本，human 模式仅作确定性链路补充。

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|----------------|------|---------|
| S1（G1/G2/G3/G4/G6 全链） | 真实 pi 四流程全链收敛：新 topic（含 ≥1 root + ≥2 叶）`cw create` + `cw run --spawn pi` 零人工到 root closed | 跑完取账本 + topic 目录 + session 文件逐环节核 | ① 每 叶 存 在 反 思 二 轮 消 息（session JSONL 含反思文案的用户消息 + agent 回复）；② 每 叶 存 在 code-review pass verdict（role=reviewer，若历经打回则取最新 pass）；③ 每 unit 存在 retrospect 证据（kind=retrospect，sha256 可对账产物）；④ 固定采样点断言（叶 spec-frozen 后 / built 后 / verified 后各采样一次）：`cw status` 输出四流程分组；⑤ root closed ∧ exit 0 |
| S2（G2 兼容） | 旧账本重放兼容 | M4 gate 四跑账本（.xyz-harness/m4-gate4-evidence/，96 事件）+ 仓内 fixtures 存量账本在新代码 `cw status/frontier/tree/report` 重放 | 输出与改造前逐字节一致（P3/P6 的端到端形态） |
| S3（G4 成本） | dev 迭代只跑影响面 | S1 的 developer session toolCall 原文抽查 ≥2 个叶 | 迭代期命令含 `vitest related`，无全量 `vitest run` 裸形态（topic 层既有豁免除外）；test-verify 每 unit 恰 1 次全量 |
| S4（G5 收紧，负面） | core e2e-mock 毒 spec 被拒 | 真实 CLI 提交 `core:true, type:"e2e-mock"` 的 spec | 入账拒绝（fail 级），错误文案指明「core 必须 e2e-real」与恢复动作；同 spec 非核心条目 e2e-mock 放行 |
| S5（G3 反思不打代数 + 预算，负面） | 反思修订不误触发转人工且预算生效 | human 模式：designer 提 spec → 反思环节注入 → agent 重提（无 fail）×3 → 观察 specReviewDeadlock 与反思派发 | 代数恒 0，无停派；反思至多派 2 轮后照旧进 specReviewPending；对照组（reviewer fail ×2）代数 = 2 正常累计 |
| S6（G4/G2 打回环） | code-review fail → 修复 → 过审闭环 | human 模式：code-review 提交 fail（四维 comment）→ 观察重派 → developer 修复 → code-review pass → built → test-verify → verified | 全链状态单调前进；buildDrift 计数包含打回周期（P4）；不出现新死锁维度 |
| S7（G2 closeout 预算，负面） | exec-review 连挂转人工 | human 模式：exec-review fail×2 | 第 2 次后停派 + 转人工出声（恰 1 次，签名去重），人工提交 pass 后自愈续接 |
| S8（G2 环不可绕过，负面） | 裸 verify 不产生 verified | human 模式：developer 在 code-review pass 前故意跑无 --stage 的 `cw verify`（全量）且 pass | unit 不进 verified（built 未达成则合取拦截）；stderr 出现「建议显式 --stage」提示 |

单元测试仅作回归辅助（探针 P3-P6 的机器锁），不计入验收。

## 5. 下一层拆分

实施路径（六波，依赖序）：**ph-1 地基 → ph-2 design → ph-3 dev → ph-4 test → ph-5 closeout → ph-6 观测面 + 终验**。每波独立可验收、可回滚（事件字段全部可选加法，回滚 = 不读新字段）。

| unit | 内容 | justification（为什么这么拆） | 验收锚 |
|------|------|------------------------------|--------|
| ph-1 | 事件与状态机：VerifyRan.stage 字段 + EvidenceSubmittedPayload.kind 字段（现状无此字段，旧缺省 = build）+ VerdictSubmitted code-review kind 值 + spec.assumptions 字段 + fold built 态 + verified/built 判定收紧（合取防线）+ D11 unit 级代际信号 + P3 探针（含混合账本形态） | 地基先行：后续每波只消费字段/枚举，不碰 schema；兼容性单点验证（golden 重放） | S2、P3 |
| ph-2 | design 流程：assumptions 任务书步骤 + reviewer 第七维 + 反思环节（resume spawn + specHash 锚 + .tmp rename + 预算 ≤2 + in-flight 纳入 + session 消歧 + P5 探针）+ 附录 A 文案常量化；观察项：反思修订率与反思后首审打回率对比 | design 全环节一次交付（assumptions 与反思都在 designer 侧，领地集中 brief.ts + loop.ts）；P5 与 S5 同源 | S5、P1/P5 |
| ph-3 | dev 流程：developer 任务书四步 + dev-verify（--stage dev 分支）+ codeReviewPending 维度 + code-review 任务书与 verdict 强校验 + P4 探针 | dev 环节强耦合（code-review 挂 dev-verify 之后），拆开无独立价值；领地 brief.ts + verify + frontier | S6、P4 |
| ph-4 | test 流程：test-verify 直跑派发（loop 直跑形态对齐集成）+ 规则②收紧（core 必须 e2e-real）| test 拆分依赖 stage 字段（ph-1）与 built 态（ph-3 派发前提）；规则②独立可测 | S4 |
| ph-5 | closeout：retrospect 任务书（designer 第六形态）+ kind=retrospect 入账 + closed 判定收紧 + exec-review 连挂预算 + P6 探针 | closeout 三件（retrospect/预算/判定收紧）互相咬合，单拆任一件都产生中间态不一致 | S7、P6 |
| ph-6 | 观测面归桶 + 文档同步（CONTEXT 词条/AGENTS/规则清单）+ S1 终验（真实 pi 全链） | 观测面是纯展示层放最后避免与波次中间态打架；终验收口全波 | S1、S3 |

**文件改动地图**：`src/events/types.ts`（字段/枚举）、`src/handlers/spec-schema.ts`（assumptions）、`src/handlers/verify.ts` + `src/verify/*`（stage 分支）、`src/core/fold.ts`（built/verified/closed 判定）、`src/readonly/frontier.ts`（新维度 + 归桶）、`src/runner/brief.ts`（四流程模板重组）、`src/runner/loop.ts`（反思 resume 派发 + test-verify 直跑 + exec-review 预算）、`src/runner/escalations.ts`（新转人工签名）。

**待验证检查点（诚实标注）**：① pi resume 在 cw spawn 环境（CW_AGENT_MODEL 注入 + workdir 切换）下的行为与 P1 裸探针一致性——ph-2 首个实施期门，降级路径 P1 已备；② 反思环节对 spawn 总时长的影响（+1 spawn/叶，预算按现 30min/spawn 封顶不变）——ph-2 观察项；③ vitest related 在 cw 仓库真实规模（83 测试文件）下的耗时与正确性——ph-3 实施期以本项目自测（cw 用 cw 开发的 dogfooding 路径）。

## 附录 A：design 反思固定文案（七问）

> 时序：designer 提交 spec 后，以用户口吻对同一 session 追加。取自真实用户历史提问模式（可行性/长期权衡/架构合理/问题本质/全局视角/简化/客观元指令七类，与用户四问完全覆盖）。

1. 仔细考虑一下，这个方案是否能够真正实现目标？是否有隐藏的没有发现的问题？是否可能实现不了？
2. 这是长期方案还是短期方案？如果三个月后回来看这段设计，你会不会想骂人？
3. 整体架构是否合理？模块的划分是否有利于实现目标？有没有架构上不合理的地方？
4. 当前是在解决一个小问题，还是真正有架构上的问题？需要跳出来用全局视角重新审视吗？
5. 这个设计是否过度？有没有更简单的实现方式？删掉哪个部分方案依然成立？
6. 有没有更好的方案？如果没有，为什么当前这个是最优解？
7. 以上问题请逐条回答，不要谄媚不要遵从已有思路，站在客观立场评判——发现任何一条有问题，就直接修改 spec 重新提交，不要问我。

## 附录 B：frontier 维度归桶映射

| 流程桶 | 维度（现状 + 新增*） | 兜底（转人工） |
|--------|---------------------|---------------|
| design | specReady / reflectionPending* / specReviewPending / specFixPending / missingChildren / specContractBroken | specReviewDeadlock / specContractDeadlock |
| dev | buildReady / codeReviewPending*（含待审/待修两子态：无 pass verdict 派 reviewer，最近 fail 派 developer） | buildDrift（hasPass 收紧为 test-pass） |
| test | testReady* / integrationReady / integrationDrift | flakeReview |
| closeout | execReviewPending*（更名） / retrospectPending* | execReviewDeadlock*（连挂 2） |

（* = 新增或更名，共 6 处展示层变化：codeReviewPending / testReady / retrospectPending / execReviewDeadlock / reflectionPending 新增，execReviewReady→execReviewPending 更名；testReady = built ∧ 未跑 test-verify，loop 直跑形态；reflectionPending = 最新 SpecSubmitted 无对应 specHash 反思产物 ∧ 反思轮次 <2，判定序先于 specReviewPending）

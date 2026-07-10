# 架构审查报告 — cw-cli-extract mid-plan

> 审查人：独立 reviewer（上下文隔离）
> 审查材料：system-architecture.md / requirements.md / 源码 5 文件交叉验证
> 模式：refactor（engine 搬迁，行为等价）

## Verdict: APPROVED

核心架构经源码交叉验证成立——分层、Port 策略（D-A）、状态机、依赖边界、变化轴五项均无结构性缺陷。2 条 should_fix 是搭便车声明的欠设计，不阻断进入 issues.md / wave 规划。

---

## 源码交叉验证结论（5 视角）

| 视角 | 验证项 | 结论 |
|------|--------|------|
| 模型完整性 | CwTopic 聚合根 + Wave/TestCase 内实体；不变式（committed 非空不变、TestCase status pending→passed/failed） | ✅ types.ts 确认；不变式由 handler 层强制，搬迁不变 |
| 状态正交性 | §5 转换表 9 行 vs state-machine.ts TRANSITIONS | ✅ 逐行 1:1 一致；8 态全可达无死角；closed 终态无回流 |
| 分层纪律 | engine 零 pi 依赖；ActionDeps 真 seam（mock 证）；CLI 协议 Port 假设 seam | ✅ grep 确认 pi import 仅在 index.ts（adapter 层）；engine 核心 0 命中 |
| 依赖边界 | deletion test：删 CLI 协议 interface 复杂度是否集中？ | ✅ dispatch(CwParams,ActionDeps)→ActionResult 即真 seam，无需 interface（D-A 正确） |
| 变化轴 | 适配层（runtime）vs engine（业务规则）正交 | ✅ §7 拆分归位正确 |

**deletion test 验证 D-A（CLI 协议 Port 不抽象为 interface）：**
删掉 `RuntimeAdapter`/`CliProtocol` interface 后，`dispatch(params, deps)` 函数签名仍是 engine 与调用方的唯一接缝——CLI 入口和未来 MCP 入口共享同一个 `dispatch` 调用。一个实现=假设 seam，两个才升格（MCP 落地时）。判断成立，非过度设计也非伪 port。

---

## must_fix

无。

---

## should_fix

- **[F]** `system-architecture.md` §1 搭便车 + §6/§7 — **"typebox schema 单一来源下沉"搭便车声明与源码现状不符，且未设计真正的 schema 搬迁。**
  - 源码事实：JSON payload schemas（`LitePlanSchema`/`MidClarifySchema`/`MidDetailSchema`/`TestCaseSubmissionSchema`）已在 `plan-parser.ts` 单一声明，`index.ts` 仅 `import` 引用（index.ts:24-29 + DRY 注释 index.ts:20-23）。不存在"两处声明"——这些 schema 已是单源。
  - 真正待设计的是 **`CwParamsSchema` 信封**（action/topicId/slug/tier/objective/...，定义在 index.ts:47-75），它随 index.ts（pi adapter）被替换而失去落脚点，架构未指明它搬到新包何处。
  - 风险：若 protocol.ts 重声明信封，则产生真漂移风险（G3）；若不设计，实现期凭直觉放。
  - 建议：§1 搭便车修正为"`CwParamsSchema` 信封从 index.ts 下沉到 protocol.ts"；§11 grep 验收补"信封 schema 单一来源（protocol.ts 声明，index.ts 删除原声明）"。

- **[F]** `system-architecture.md` §6 + 源码 `index.ts` execute() — **ADR-029 worktree cwd 防御逻辑去向未交代，关系 G3 行为等价。**
  - 源码事实：`index.ts` execute() 内有 ADR-029 D1 防护（index.ts:163-178）——检测 `process.cwd()` 含 `/.cw-wt/` 时拒绝 fallback，强制显式传 `workspacePath` 或设 `CW_WORKSPACE_ROOT` env。这是 **pi-workflow-specific** 防御（pi workflow 的 worktree 命名约定）。
  - 通用 CLI 下需决策：保留（兼容 pi workflow 内调 CLI）/ 丢弃（非 pi agent 无此场景）/ 泛化为可配置 worktree-prefix 检测。架构对此沉默。
  - 建议：§6 或 §10 补一行决策（推荐：保留为 CLI 内置防御，`.cw-wt/` 检测逻辑随 adapter 搬迁不丢——pi 仍是首个接入方，防御价值仍在）。

---

## nit

- **[过度设计风险已规避]** `system-architecture.md` §6 Port 清单 — "CLI 协议 Port"列名为 Port，同节 Seam 判断又称"当前不抽象为 interface（假设 seam）"——同表内命名自相矛盾。建议改名"CLI 协议边界"或加注"非 interface port，`dispatch` 签名即契约"。不影响实质（D-A 已 confirmed）。

- **[F]** `system-architecture.md` §11 grep 验收清单 — grep 覆盖 pi 包 import，但未点名 `StringEnum`（`@earendil-works/pi-ai`，用于 CwParamsSchema 的 action/tier 枚举，index.ts:48/55）需替换为纯 typebox（`Type.Union([Type.Literal(...)])`）。grep 会命中但实现者可能不知替换法。建议补一句替换指引。

- **[F]** `system-architecture.md` §1 G3 + §9 泳道图 — `renderSummary`（pi TUI 专用文本，含 `MUSTFIX_SUMMARY_MAX_LEN` 截断）被 JSON 序列化替换，架构暗示（"序列化 JSON"）但未明示映射：`content[0].text`（TUI 文本）丢弃，`details: ActionResult`（结构化）直出 stdout JSON。关系行为等价声明清晰度，不影响实现正确性。建议 §9 泳道图标注"丢 content 文本，序列化 details"。

---

## 决策账本核对

| 决策 | 状态 | 审查确认 |
|------|------|---------|
| D-001 子命令+stdin/file | confirmed | 不重报 |
| D-002 ~/.cw/ 不迁移 | confirmed | 不重报 |
| D-003 bin=cw 独立包 | confirmed | 不重报 |
| D-004 engine 单测+CLI e2e | confirmed | 不重报 |
| D-005 skill 原样透传 | confirmed | 不重报（buildNextAction 返回 pi skill 名，非 pi agent 靠 guidance 文本决策，可接受） |
| D-A 不抽象 runtime port | confirmed | deletion test 验证通过，不重报 |

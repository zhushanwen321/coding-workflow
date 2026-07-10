---
verdict: CHANGES_REQUESTED
reviewer: 独立 reviewer（mid-plan 需求完整性路，与主 agent 隔离）
date: 2026-07-10
materials:
  - requirements.md（本轮审查对象）
  - CONTEXT.md（统一语言）
  - 源码：xyz-pi-extensions-workspace/main/extensions/coding-workflow/src/index.ts
  - 源码：src/cw/types.ts, src/cw/state-machine.ts, src/cw/path-encoding.ts, src/cw/actions/replan.ts
decision_ledger: D-001~D-005 均 status=confirmed，未当 gap 重报；无 [REVISIT of D-NNN]（无下游新证据推翻）
---

## Verdict: CHANGES_REQUESTED

Step 0 结构完整性：必备章节齐全（目标树/用例+AC/数据流/功能/约束/不做/UI场景/跨系统），无占位符、无空 AC。但 Step 1 认知帧审查发现 3 项阻断项（覆盖缺口 + 协议契约缺口），需补齐后才能 CONVERGED。

类型图例：F=事实需二次确认 / K=知识问用户 / D-不可逆=需 ask_user / D-可逆=agent 可改

---

## must_fix（必须修改，阻断 CONVERGED）

### M1. [D-可逆] replan action 在 UC-1~5 中无用例/AC 覆盖 — G3 等价性有验证盲区
**文件:章节** — requirements.md §2（用例）

**问题**：engine 共 9 个 action（CONTEXT.md 明列），replan 是其中独立一支，语义与现有 UC 均不重合：
- 非 single-shot：`state-machine.ts` TRANSITIONS.replan `progressive: true`，expectedStatuses `[planned, developed]`，nextStatus `planned`（append-only 回退）。UC-2 标题「推进流程（single-shot action）」不涵盖。
- 非 dev/test：UC-3 标题「提交进度（dev/test 渐进式）」明确排除。
- 独有契约：`actions/replan.ts` 头注释「append-only plan.json 同步，拒绝破坏性变更（已 committed wave / 已 passed testCase 不可删改）」，返回 replanSummary，v1 仅 lite tier。

后果：G3「100% 等价」对 replan 无任何验证路径——AC-5.2 的 lite e2e（create→plan→dev→test→retrospect→closeout）根本不经过 replan。即便 dispatch switch 机械支持 replan（G1.1 源码原样复用），CLI adapter 对 replan 入参（planJson 二次提交、append-only 校验）的行为等价无从验证。

**建议**：新增 UC-6（replan），含主流程（plan.json 追加 wave/testCase → gate 校验 append-only → 输出 nextAction）、异常流程（破坏性变更被拒 / 非 planned|developed 状态非法转换）、AC（append-only 守卫生效 + replanSummary 结构）。或显式将 replan 并入 UC-2 并补 AC，但须注明其 progressive + append-only 不同于其他 single-shot。

---

### M2. [D-可逆] exit code 契约未定义 — 输出/错误协议缺口，D-001 未覆盖
**文件:章节** — requirements.md §2 UC-2 AC-2.2 / 全局输出契约

**问题**：D-001（已确认）只覆盖**输入**协议（子命令 + 大 JSON 走 stdin/--xxx-file），未定义**输出/错误**协议的 exit code 语义。现有 AC 自相矛盾且欠定义：
- AC-2.2「exit code 反映 gate 结果」——「反映」含义模糊。若 gate-fail = 非零，则调用方 agent 无法区分「gate fail（正常重试流，改 mustFix 后重调）」与「illegal_transition（调用 bug）」（AC-2.3 也是非零），两者皆非零，agent 只能 parse stderr 文本判断，破坏「spawn + 读 stdout JSON」的 G2 契约。
- AC-1.2（slug 重复）/AC-2.3（非法转换）/AC-4.2（topic 不存在）明确非零；AC-3.2（无效 commitHash → gate fail）未提 exit code；AC-2.2 gate fail 未明确。

这是端口契约级别的歧义：gate-fail 是「程序正常返回的运行结果」还是「程序错误」？两种建模对调用方语义完全不同，必须定死。

**建议**：明确分层 exit code 方案，例如：
- `exit 0` + stdout JSON（含 `gatePassed` + `nextAction` + 可选 `mustFix`）= 程序正常，结果在 JSON 里（gate pass 或 fail 都是正常返回）
- `exit ≥1` + stderr（人类可读）= 程序错误（参数校验失败 / illegal_transition / topic not found / 内部异常）
- 据此修正 AC-2.2 措辞，删除「exit code 反映 gate 结果」的歧义，改为「gate 结果在 stdout JSON 的 gatePassed 字段，exit code 始终为 0 表示程序正常」。

---

### M3. [D-可逆] _cw.json 完整路径结构未指定 — multi-workspace 正确性悬空
**文件:章节** — requirements.md D-002 / §2 UC-4 前置条件 / CONTEXT.md

**问题**：D-002 给了 home 根（`~/.cw/`，`CW_HOME` 覆盖），但未说明是否保留 per-workspace 隔离的子目录结构。源码现状（`path-encoding.ts` + `index.ts` resolveCwDbPath）：
```
~/.pi/agent/cw/<encoded-cwd>/_cw.json     # encoded-cwd = "--" + workspacePath 去首分隔符 + 替换/为- + "--"
```
per-cwd 隔离是 multi-workspace 正确性的前提（用户主用 bare+worktree，见全局 CLAUDE.md）。若 CLI 扁平化为单一 `~/.cw/_cw.json`，多项目 topic 互相覆盖。

另 UC-4 前置条件「（list）workspacePath 下有 _cw.json」表述有误——`_cw.json` 不在 workspacePath 下（源码注释明确「不再污染项目目录」），而在 home 下的 encoded-cwd 子目录。这是事实错误，会误导实现者。

**建议**：
1. 在 D-002 或 §3 数据清单明确完整路径：`$CW_HOME/<encoded-cwd>/_cw.json`（或 `~/.cw/<encoded-cwd>/_cw.json`），声明 encodeCwd 规则原样继承（path-encoding.ts 复用，非重写）。
2. 修正 UC-4 前置条件措辞为「workspacePath 对应的 encoded-cwd 子目录下存在 _cw.json」。

---

## should_fix（建议不阻断）

### S1. [F] 人读 vs JSON 输出模式未定义
**文件:章节** — §5 UI/UX 场景 / UC-4

UC-4 Actor 含「开发者（人，调试/排查）」，但所有 AC 隐含纯 JSON 输出。开发者手动 `cw status` / `cw list` 时纯 JSON 难读。源码现有 `renderSummary()` 已产出人读摘要（`[cw] action — topicId=... status=... guidance=...`），是现成可复用资产。建议：定义 `--json` flag（默认人读 stderr 摘要 + stdout JSON，或反之），或 stdout=JSON / stderr=human 双流，让「开发者 Actor」场景可验证。

### S2. [F] env 变量契约不清（CW_HOME vs workspacePath env）
**文件:章节** — D-002 / UC-1 替代流程

D-002 用 `CW_HOME`（存储 home 覆盖）；源码用 `CW_WORKSPACE_ROOT`（workspacePath 覆盖，见 index.ts execute）。UC-1 替代流程「env 默认 process.cwd()」未明确是否存在 workspacePath env 变量。两套 env（存储 home / workspacePath）混在同一文档易混淆。建议：厘清「`CW_HOME`=存储根」与「`--workspace`/`CW_WORKSPACE`=workspacePath 覆盖」两条独立契约，明确命名（是否保留 `CW_WORKSPACE_ROOT` 或改名）。

### S3. [F] worktree cwd 安全守卫（ADR-029 D1）未提及
**文件:章节** — §6 跨系统 / UC-1

源码 index.ts execute 有 ADR-029 dataflow D1 防护：检测 cwd 含 `/.cw-wt/` 时拒绝 `process.cwd()` fallback，强制显式 workspacePath 或 `CW_WORKSPACE_ROOT`，防数据隔离坑。属 adapter 层行为（非 engine），G3 等价性不强制。但静默丢弃会让 multi-workspace 用户重踩此坑。建议：requirements 显式决定 CLI adapter 是否复制此守卫（推荐复制，成本极低）。

### S4. [F] StringEnum(pi-ai) 解耦点未显式列出
**文件:章节** — §4 功能清单 / §7 约束

index.ts `CwParamsSchema` 用 `StringEnum` from `@earendil-works/pi-ai`（action/tier 枚举）。G1 要求运行时零 pi-ai 依赖。G1.2「pi 耦合点被替换」笼统覆盖，但 StringEnum 是非显而易见的 pi-ai 耦合点（plan-parser.ts 用纯 typebox，顶层 schema 用 pi-ai StringEnum，两者来源不同）。建议：F 清单补一条「CwParamsSchema 的 StringEnum 替换为 typebox-native（Type.Union([Type.Literal(...)])）」，避免实现遗漏导致 G1 不达标。

### S5. [F] machine-check 报告写入方向未在数据流体现
**文件:章节** — §3 数据清单

数据清单 topicDir 仅标「engine 读盘 gate 检查」，但 engine 还**写** `changes/machine-check-{phase}.md`（源码 renderSummary 注释 + state-machine gateHistory report）。topicDir 是双向（读交付物 + 写检查报告）。建议：补 topicDir 写入方向 + machine-check-*.md 数据行（来源=engine gate，消费者=agent 读全文，归档=随项目目录）。

### S6. [F] stdin 异常流无 AC 覆盖
**文件:章节** — UC-2 异常流程 / F3

F3 支持 stdin 大 JSON，但无 AC 覆盖异常：空 stdin / 非法 JSON / 同时传 stdin 与 `--xxx-file`（冲突）。建议 UC-2 补异常 AC（malformed JSON → 非零 + stderr 定位错误）。

### S7. [D-可逆] mid 流程 CLI 集成测试缺口（D-004 确认后的已知残留风险，非推翻）
**文件:章节** — UC-5 AC-5.1/5.2

D-004 确认 e2e 限 lite。AC-5.1（engine 单测全绿）绕过 CLI adapter 直测 engine；AC-5.2（lite e2e）不经过 mid clarify/detail。故 mid 的 clarify.json/detail.json 经 CLI 入口的集成行为无验证路径（若 CLI adapter 对 mid JSON 解析有 bug，engine 单测抓不到）。**此为 D-004 确认 scoping 的已知后果，非推翻 D-004**。建议：风险登记（system-architecture 或后续 topic 跟踪），或 AC-5.2 补一条轻量 mid smoke（create mid → clarify 单次 → detail 单次，验证 JSON 通路，不求完整流程）。

---

## nit（可选）

### N1. UC-4 缺替代流程
其他 UC 都有主/替代/异常三流，UC-4 仅主流程（+ AC 里的边界）。建议补一条替代流程（如 `--json` 输出 / `list` 带 workspace 过滤），保持结构一致。

### N2. guidance 文本风格为 pi 专属
nextAction.guidance 含中文 + pi 具体 skill 名（「调 lite-plan skill」），对 Claude Code/其他 agent 读到有风格违和。D-005 确认透传，不需改。仅登记：若未来跨 agent 通用性成痛点，可考虑 guidance 的 i18n/neutral 化（后续 topic）。

---

## 不作为 gap 重报的已确认决策（备查）

| 决策 | 为何不当 gap |
|------|-------------|
| D-001 子命令+stdin 协议 | 输入协议已定（exit code 输出协议另算，见 M2，属 D-001 未覆盖区域而非推翻） |
| D-002 ~/.cw/ + CW_HOME | home 根已定（完整路径结构另算，见 M3，属补充非推翻） |
| D-003 独立包 @zhushanwen/coding-workflow | 无争议 |
| D-004 e2e 限 lite | 已确认（mid 残留风险见 S7，标注为后果非推翻） |
| D-005 skill 透传 | 已确认（风格违和见 N2，仅登记） |

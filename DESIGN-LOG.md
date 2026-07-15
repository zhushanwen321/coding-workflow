# 设计历史索引

> **跨主题导航**。每主题一行，coding-closeout 收尾时更新状态。
> 新人/AI 先读本表，再决定深入哪个 topic 或 ADR。

本项目（coding-workflow / CW-CLI）源自 pi 扩展抽离，后经历 lite 单轨重构、机制杠杆修复、clarify/ADR 引入、fix-loop 闭环、评估指标体系等里程碑。topic 工件存放在 `.xyz-harness/<topic>/`，长期沉淀文档存放在项目根（`ARCHITECTURE.md` / `CONTEXT.md`）与 `docs/`。

## 主题台账

| Topic | 主题 | 开始 | 归档 | 沉淀去向 | 状态 |
|-------|------|------|------|---------|------|
| metrics-eval-waves | 评估指标体系 Wave 1-5：changedFiles 持久化 + retrospect 结构化 + 三层指标 + review 3-subagent 架构 + assess post-closeout | 07-14 | — | `docs/metrics-design.md`, `docs/metrics-usage.md`, `cw assess` 动作, review 3-subagent 架构 | in-progress |
| issue-tracking-fix-loop | review_fix / test_fix loop：issue tracking + fix loop 闭环追踪（reviewIssues / testFixLog） | 07-14 | — | `.xyz-harness/issue-tracking-fix-loop/`, types.reviewIssues/testFixLog | in-progress |
| clarify-adr-mechanism | clarify 阶段 + ADR 机制：create→plan 之间的需求/技术澄清 | 07-14 | — | `cw clarify` 动作, ADR 机制（非正式，见下表） | in-progress |
| cw-mechanism-levers | CW mechanism levers 修复：4 个机制杠杆修复 + testRunner 持久化 + replan --test | 07-14 | — | `.xyz-harness/cw-engine-gate-hardening/`, gate/testRunner 改动 | in-progress |
| cw-refactor-lite | lite 单轨重构：砍 tier/clarify/detail，lite-only 推倒重建 | 07-11 | — | `.xyz-harness/cw-refactor-lite/plan.md`, `e59e15a refactor: flatten src/ to lite-only` | in-progress |
| cw-cli-extract | cw-cli-extract：CW engine 从 pi 扩展抽离为独立 npm 包 + CLI 入口 | 07-10 | 07-10 | `ARCHITECTURE.md`, `CONTEXT.md`, `.xyz-harness/cw-cli-extract/{decisions,requirements,system-architecture,non-functional-design}.md` | archived |

## 状态语义

- `in-progress` — 设计/实施中，topic 目录可读写
- `archived` — coding-closeout 已收尾，topic 目录只读，沉淀已进长期文档
- `abandoned` — 放弃，标理由（沉淀仍可能有价值，归档前提取）

## 活跃 ADR 索引

> 当前无正式 ADR（项目尚未走 full 工作流的 clarify+ADR 机制，无 `docs/adr/` 目录）。
> `cw-cli-extract` 产出过 `decisions.md`（D-001~D-006，非正式 ADR），其余里程碑留下了若干重要的非正式架构决策，列如下：

| ADR | 标题 | 状态 | 溯源 |
|-----|------|------|------|
| D-001 | CLI 协议用子命令风格（cw create --slug X）+ 大 JSON 走 stdin pipe 或 --xxx-file | confirmed | [from: cw-cli-extract] |
| D-002 | 存储路径 ~/.cw/&lt;encoded-cwd&gt;/_cw.json，env CW_HOME 可覆盖；pi 数据留 ~/.pi/ 不迁移 | confirmed | [from: cw-cli-extract] |
| D-003 | 产物为独立 npm 包 @zhushanwen/coding-workflow，bin 名 cw；engine+CLI 同包 | confirmed | [from: cw-cli-extract] |
| D-004 | 行为等价验证：保留 engine 单测原样 + 新增 CLI e2e 覆盖完整 lite 流程 | confirmed | [from: cw-cli-extract] |
| D-005 | nextAction.skill 字段原样透传，CLI 不额外处理 | confirmed | [from: cw-cli-extract] |
| D-006 | CLI adapter 继承 pi ADR-029 worktree cwd 防护 | confirmed | [from: cw-cli-extract] |
| （非正式）砍 tier 分档 | lite 单轨，不再区分 lite/mid | accepted | [from: cw-refactor-lite] |
| （非正式）单重 guard | 只 checkLinear，砍纵深防御 | accepted | [from: cw-refactor-lite] |
| （非正式）guidance 嵌提示词 | 阶段方法论直接拼入 nextAction.guidance | accepted | [from: cw-cli-extract] |
| （非正式）零 mock 测试 | 真实 CwStore + git 子进程，禁 mock 框架 | accepted | [from: cw-cli-extract] |
| （非正式）gate 熔断不阻断 | 5 次连续 fail 换文案但不 exit 非 0 | accepted | [from: cw-cli-extract] |

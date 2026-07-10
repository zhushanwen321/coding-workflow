---
topic: cw-cli-extract
created_at: 2026-07-10
---

# 决策账本 — cw-cli-extract

append-only。字段定义见 loop-skeleton.md Step 1.2 schema。

| id | decision | rationale | classification | confirmed_by | stage | source | status | superseded_by |
|----|----------|-----------|----------------|--------------|-------|--------|--------|---------------|
| D-001 | CLI 协议用子命令风格（cw create --slug X）+ 大 JSON 字段走 stdin pipe 或 --xxx-file | LLM 写子命令比构造 JSON payload 自然；stdin/文件双通道避命令行长度限制；人类可调试；exit code 映射 gate 结果。否决 JSON-RPC 式（大 JSON 超长度+转义易错）和全内联（大 plan.json 截断） | `D-不可逆` | `ask_user` | `architecture` | `[from: cw-cli-extract §10 D-C + requirements F2/F3]` | `confirmed` | |
| D-002 | 存储路径 ~/.cw/<encoded-cwd>/_cw.json，env CW_HOME 可覆盖；pi 现有数据留在 ~/.pi/agent/cw/ 不迁移 | 抽离成独立工具就该有独立数据空间；encodeCwd 逻辑复用；两工具数据隔离干净避迁移风险。否决共享 ~/.pi/（并发冲突+没真脱离 pi）和可选迁移（增迁移逻辑+冲突风险） | `D-不可逆` | `ask_user` | `architecture` | `[from: cw-cli-extract §10 D-B + requirements F5]` | `confirmed` | |
| D-003 | 产物为独立 npm 包 @zhushanwen/coding-workflow，bin 名 cw；engine+CLI 同包 | 独立包才能真正被各种 agent 复用不绑定 pi 生态；bin 名 cw 简短好记与 topicId 前缀 cw- 一致；pi 扩展未来可 depend on 此包。否决 monorepo 子包（绑定 pi 结构）和 cwflow（更长+与 topicId 前缀不一致） | `D-不可逆` | `ask_user` | `architecture` | `[from: cw-cli-extract §7 + requirements 待确认]` | `confirmed` | |
| D-004 | 行为等价验证：保留 engine 26 个单测原样 + 新增 CLI e2e 覆盖完整 lite 流程 | 单测证 engine 核心零改动（抽离后天然全绿），e2e 证 CLI 协议层（argv解析/JSON序列化/exit code）正确，覆盖互补。否决仅单测（协议层无覆盖）和迁移单测到 CLI（工作量大+定位 bug 难） | `D-不可逆` | `ask_user` | `architecture` | `[from: cw-cli-extract requirements UC-5/G3]` | `confirmed` | |
| D-005 | nextAction.skill 字段原样透传，CLI 不额外处理（不文档化映射、不剥离） | 最小行为不改 engine；pi agent 用得上 skill 映射，非 pi agent 靠 nextAction.action（机器可执行）+ guidance 文本决策忽略 skill。CW 是状态机+gate 非非 agent 教程，职责边界清晰 | `D-可逆` | `agent-opinionated` | `architecture` | `[from: cw-cli-extract §10 D-E]` | `confirmed` | |
| D-006 | CLI adapter 继承 pi 的 ADR-029 worktree cwd 防护（检测 .cw-wt/ 拒绝 fallback，强制显式 --workspace/CW_WORKSPACE_ROOT） | 成本极低（~10 行）；pi 仍是首个接入方防御价值仍在；任意 agent 都可能在 worktree 里 spawn cw，静默丢弃会重踩 _cw.json 数据隔离坑。泛化为可配置 worktree-prefix 留后续 | `D-可逆` | `agent-opinionated + reviewer HC-3 共识` | `architecture` | `[from: cw-cli-extract §10 D-F]` | `confirmed` | |

# 独立 Agent 源目录

本目录存放**不属于任何 skill 的独立 agent**，随 npm 包发布，安装时 symlink 到：

- `~/.agents/agents/`（跨 harness 通用）
- `~/.pi/agent/agents/`（pi 实际加载位置）
- `~/.claude/agents/`（claude）

## 与 `skills/<name>/agents/` 的区别

- **随 skill 自包含的 agent**（某 skill 专属）：放 `skills/<skill-name>/agents/`，随该 skill 一起分发。例：`skills/tech-design/agents/tech-design-review.md`
- **独立 agent**（不属于任何 skill）：放本目录

## 命名约束

- 文件名 `<name>.md` 必须与 frontmatter `name: <name>` 完全一致
- 不可与现有 agent 冲突

当前为空，预留。

path: flock

判断依据：ZCode Agent 工具参数 schema 无 worktree/fork/isolation/worktreePath 等隔离选项。遍历 Agent tool 的 properties（description/prompt/subagent_type/model/run_in_background）未观察到任何隔离能力。按 skill「看不到就是不支持」判定，走兜底路径 2（flock 串行）。

注意：ZCode 环境下 subagent 是否能可靠执行 flock 临界区未验证。若 worker 报告 flock 不可用，按失败恢复表降级为「主 agent 统一 commit」（worker 只改文件 + 静态自检，主 agent 收尾 git add -A && git commit）。

# 双级验收

> 阶段 5。两个 gate 串行，先廉价后昂贵；双绿才算交付。门 A 是机器可判定的客观线，门 B 回答「真实场景里这个功能好用吗」。

## Gate A：整体测试验收（subagent）

task 三段式要点：

- 全量验证命令从项目配置真实读取（AGENTS.md / package.json scripts），禁止凭记忆编命令
- **零容忍绕过**：任何 SKIP_* 类变量、test.skip、跳过的 lint 规则——发现即记为失败项而非忽略
- 覆盖矩阵：单元领地 × 实际测试用例，列出无人认领的改动区
- lint / typecheck 与测试同权
- structured-output 返回 {exit_summary, failures, uncovered, risks}

处理：failures / uncovered → 回 `flow/execute.md` 补开发补测试；确认不可修且无害的 → 用户签认后转计划 §7 残留风险。

## Gate B：端到端验收（subagent）

剧本来源 = 设计文档 §8 验收场景表逐行 + §11 待验证检查点的回填：

- 真实搭建环境：真实启动服务/进程、接真实数据源与真实流程；mock 仅当 §8 明文许可时使用
- 逐场景执行：按表内「真实流程」列操作，对照「通过标准」列核验；
  每行给 verdict = pass/fail/blocked + evidence（日志摘录/响应样本/截图路径）
- fail → 经一致性审查的处理链组修复批次，修后只重验受影响场景
- blocked → 如实报告环境/权限等原因，禁止用 mock 变通冒充通过

## 收尾

1. 双绿后向用户交付汇总：§1 目标达成对照表 + 合理偏差登记表 + 残留风险 + 覆盖概览
2. 主 agent 最终 commit（验收产物、计划文档终态）
3. [OPTIONAL] 用户指示时做产物清理（临时 worktree 删除、调试存档归置）

## 失败状态的可视边界

任一 gate 不绿时，交付口径必须是「未完成 + 差距清单」，禁止以部分通过的事实宣称整体完成。

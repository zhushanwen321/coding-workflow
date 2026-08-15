# 重写状态账本（简化版事件账本）

> 状态流转规则见 orchestration.md。每行变更由主 agent 记录（时间倒序追加在「事件」节）。
> 状态机：pending → building → built → verifying → verified → committed；失败 → rejected。

## M0 = L0 + L1（证据地基）

| unit | 模块 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| u1 | 事件模型 + 账本 + 投影 | pending | — | |
| u1b | 只读命令（status/frontier/tree/report） | pending | — | 依赖 u1 |
| u2 | 写命令（create/evidence submit/review submit） | pending | — | 依赖 u1 |
| u3 | spec gate 五规则 | pending | — | 纯函数，无依赖 |
| u4a | 干净重跑 + cw verify | pending | — | 依赖 u1,u2 |
| u4b | 三道 gate（红阶段/名字比对/重跑判定） | pending | — | 依赖 u4a |
| u5 | TestRun 缝 + vitest/e2e-sh 适配器 | pending | — | 依赖 u4 |
| u5b | human 模式 | pending | — | 依赖 u2,u4 |

## M1 = L2（并行 runner）

| unit | 模块 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| u6a | AgentSpawn 接口与生命周期 | pending | — | |
| u6b | human 适配器 | pending | — | 依赖 u6a |
| u6c | pi 适配器（CW_AGENT_MODEL → --model） | pending | — | 依赖 u6a |
| u7 | 调度循环 | pending | — | 依赖 u1b,u6a |

## M2 = L3（集成）+ 补齐

| unit | 模块 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| u8 | 内部节点 verify（merge + 契约比对） | pending | — | 依赖 u4,u7 |
| u9 | 适配器补齐（claude/codex/pytest 可选） | pending | — | 可选 |

## 里程碑 gate

| gate | 内容 | 状态 |
|------|------|------|
| Phase 0 | 归档 + 脚手架 + 靶子清空 | done |
| M0 gate | A1 人肉全流程 + A3 补录攻击 | pending |
| M1 gate | pi E2E（微任务 + 并行）+ 探针 P3/P4/P6/P8 | pending |
| 终验 | markdown-reader 全流程无人干预 | pending |

## 事件

- 2026-08-15 Phase 0 开始：git mv src/tests/docs + 6 个根级文档 → archive/；靶子 recursive-split-e2e 已存档 README 并清空重建；新脚手架就位。
- 2026-08-15 Phase 0 完成：check:all + test（3 冒烟）+ lint 全绿；commit 见 git log（archive legacy implementation, scaffold rewrite）。

# 重写状态账本（简化版事件账本）

> 状态流转规则见 orchestration.md。每行变更由主 agent 记录（时间倒序追加在「事件」节）。
> 状态机：pending → building → built → verifying → verified → committed；失败 → rejected。

## M0 = L0 + L1（证据地基）

| unit | 模块 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| u1 | 事件模型 + 账本 + 投影 | committed | 01fd577 | verifier PASS（sha256 117681da…，报告 u1-report.md，17 条对抗抽查）。观察项：① lockfile 创建-写入空窗口竞态（沿用旧实现既有机能，后续 unit 修：null 时等待而非 unlink）② E2E 交错断言低概率 flake ③ verified 判定未校验 VerifyRan 在最后 spec 之后（与验收文档字面一致，接线期收紧） |
| u1b | 只读命令（status/frontier/tree/report） | building | 见 git log | 与 u2 并行；dispatch 契约层由主 agent 预建（注册表模式，领地不相交） |
| u1b | 只读命令（status/frontier/tree/report） | pending | — | 依赖 u1 |
| u2 | 写命令（create/evidence submit/review submit） | committed | 552ae90 | verifier PASS（sha256 4ee6677e…，报告 u2-report.md，7 场景对抗零矛盾）。备案：spec 多余字段 typebox 放行、--evidence-refs "" 产生空数组键（payload 形状细微差异，报告 §5） |
| u3 | spec gate 五规则 | committed | 01fd577 | verifier PASS（sha256 91f460d…，报告 u3-report.md）；minor 观察：isResolvableOnPath 对目录 command 放行（which 不放行），退化边界，u4a verify 真跑时天然兜住 |
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
- 2026-08-15 Phase 0 完成：check:all + test（3 冒烟）+ lint 全绿；commit 88ce0a2（archive legacy implementation, scaffold rewrite）。
- 2026-08-15 u1/u3 验收基线入 git：主 agent 建共享类型契约 src/events/types.ts（canon D2/D3 投影 + 两处显式补充注明）；u1（账本+投影）与 u3（spec 五规则）并行派发 builder。
- 2026-08-15 u3 committed：builder 交付 spec-rules.ts + 13 条表驱动单测；verifier 防篡改/命令实跑/真实性抽查/8 条对抗抽查全 PASS；主 agent 复核 diff 为空 + sha256 一致后流转。
- 2026-08-15 u1 committed：builder 交付 events-log/project/fold + 26 单测 + 1 真实子进程并发 E2E（41 全绿）；verifier 17 条对抗抽查全 PASS + 锁超时实测补证 10043ms；types.ts 纯追加（33+/0-）并行契约未破坏。3 条观察项记入 u1 行。
- 2026-08-15 u2 committed：builder 交付写命令三件套 + typebox schema 链 + 28 测试；verifier 真实性抽查（gate 不入账三要素/E2E 事件全量序/cat-file 真实调用）+ 7 对抗场景零矛盾 PASS。

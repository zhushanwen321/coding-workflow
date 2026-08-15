# 重写状态账本（简化版事件账本）

> 状态流转规则见 orchestration.md。每行变更由主 agent 记录（时间倒序追加在「事件」节）。
> 状态机：pending → building → built → verifying → verified → committed；失败 → rejected。

## M0 = L0 + L1（证据地基）

| unit | 模块 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| u1 | 事件模型 + 账本 + 投影 | committed | 01fd577 | verifier PASS（sha256 117681da…，报告 u1-report.md，17 条对抗抽查）。观察项：① lockfile 创建-写入空窗口竞态（沿用旧实现既有机能，后续 unit 修：null 时等待而非 unlink）② E2E 交错断言低概率 flake ③ verified 判定未校验 VerifyRan 在最后 spec 之后（与验收文档字面一致，接线期收紧） |
| u1b | 只读命令（status/frontier/tree/report） | committed | 552ae90 | verifier PASS（sha256 23ce2763…，报告 u1b-report.md，17/17 对抗抽查）。O-1 裁决：--json 恒输出结构化空形态（收尾 polish 统一，status 空账本当前输出纯文本与 frontier 不一致） |
| u2 | 写命令（create/evidence submit/review submit） | committed | 552ae90 | verifier PASS（sha256 4ee6677e…，报告 u2-report.md，7 场景对抗零矛盾）。备案：spec 多余字段 typebox 放行、--evidence-refs "" 产生空数组键（payload 形状细微差异，报告 §5） |
| u3 | spec gate 五规则 | committed | 01fd577 | verifier PASS（sha256 91f460d…，报告 u3-report.md）；minor 观察：isResolvableOnPath 对目录 command 放行（which 不放行），退化边界，u4a verify 真跑时天然兜住 |
| u4a | 干净重跑 + cw verify | committed | 115e52c | 首验 FAIL 1 major（--timeout-ms 无有效传值形式）→ 打回修复（parseTimeoutMs 四分支、非法 exit 1 报错）→ 针对性复审 PASS（红性验证：缺陷注入恰 3 新测试红、字节级还原；行为对抗 abc/裸 flag/-5 全拒）。minor：错误消息称「正整数」但接受正小数（口径轻微出入） |
| u4b | 三道 gate（红阶段/名字比对/重跑判定） | committed | 5183fb2 | verifier PASS（sha256 2ae2c048…，报告 u4b-report.md，5 组对抗抽查）。裁量 1/2 接受（case.name 词边界、judgeRedPhase 四态）；5 处 u4a 适配确认断言强度等价。观察：vitest 型不消费进程 exitCode（规格本意）、红阶段产物前缀目录非字面子目录 |
| u5 | TestRun 缝 + vitest/e2e-sh 适配器 | committed | 115e52c | verifier PASS（sha256 fe93e5b2…，报告 u5-report.md，17/17 对抗抽查）。两处规格裁决经 verifier 确认与条款自洽（e2e-sh 多 id 命中读法、A 前缀拼回）。观察：vitest includes 子串匹配理论前缀边界、非 A 前缀标记行静默忽略（有防线兜底） |
| u5b | human 模式 | committed | 5183fb2 | verifier PASS（sha256 bb8583f1…，报告 u5b-report.md，4 条对抗抽查）。3 偏差全确认合理（spec review 无 runId 系验收文档笔误、kind 枚举补 create/spec-review、E2E unit fixture 折衷由 u5 真 fixture 兜底）。观察：同账本持续无关事件可推迟 max-idle（M0 全局粒度）；index.ts 注释行微调（必要无害） |

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
| M0 gate | A1 人肉全流程 + A3 补录攻击 | done |
| M1 gate | pi E2E（微任务 + 并行）+ 探针 P3/P4/P6/P8 | pending |
| M1 gate | pi E2E（微任务 + 并行）+ 探针 P3/P4/P6/P8 | pending |
| 终验 | markdown-reader 全流程无人干预 | pending |

## 事件

- 2026-08-15 Phase 0 开始：git mv src/tests/docs + 6 个根级文档 → archive/；靶子 recursive-split-e2e 已存档 README 并清空重建；新脚手架就位。
- 2026-08-15 Phase 0 完成：check:all + test（3 冒烟）+ lint 全绿；commit 88ce0a2（archive legacy implementation, scaffold rewrite）。
- 2026-08-15 u1/u3 验收基线入 git：主 agent 建共享类型契约 src/events/types.ts（canon D2/D3 投影 + 两处显式补充注明）；u1（账本+投影）与 u3（spec 五规则）并行派发 builder。
- 2026-08-15 u3 committed：builder 交付 spec-rules.ts + 13 条表驱动单测；verifier 防篡改/命令实跑/真实性抽查/8 条对抗抽查全 PASS；主 agent 复核 diff 为空 + sha256 一致后流转。
- 2026-08-15 u1 committed：builder 交付 events-log/project/fold + 26 单测 + 1 真实子进程并发 E2E（41 全绿）；verifier 17 条对抗抽查全 PASS + 锁超时实测补证 10043ms；types.ts 纯追加（33+/0-）并行契约未破坏。3 条观察项记入 u1 行。
- 2026-08-15 u2 committed：builder 交付写命令三件套 + typebox schema 链 + 28 测试；verifier 真实性抽查（gate 不入账三要素/E2E 事件全量序/cat-file 真实调用）+ 7 对抗场景零矛盾 PASS。
- 2026-08-15 u1b committed：builder 交付四只读命令 + 22 测试；verifier 17/17 对抗抽查 PASS，specGate 真接线确认（load.ts import checkSpecRules 注入 deriveStatus）。O-1 观察：--json 空账本行为不一致，裁决方向 = 恒结构化，收尾统一。
- 2026-08-15 第三波派发：契约层 src/testrun/types.ts（TestRunAdapter/EvidenceReport，canon B.2）预建；u4a（verify 干净重跑）与 u5（vitest/e2e-sh 适配器）并行。
- 2026-08-15 u5 committed：builder 交付两适配器 + registry + 14 测试（fixture 全真实生成）；verifier 17/17 对抗抽查 PASS，两处规格裁决确认自洽。
- 2026-08-15 u4a 首验 FAIL（1 major）：--timeout-ms 数值 flag 经 dispatch 全链失效（stringArg 类型门 + 静默回退默认），测试盲区=未测 CLI 层数值传递。打回修复中；u4b/u5b 验收文档已备待 u4a committed 后派发。
- 2026-08-15 u4a committed（FAIL→修复→复审 PASS 闭环）：parseTimeoutMs 本地解析 + 3 回归测试（红性验证有效）；全量 126 绿。第四波 u4b/u5b 基线入 git 后并行派发。
- 2026-08-15 u5b committed：builder 交付 human-loop + run 命令 + 19 测试（E2E 测试进程扮演人全链收敛 root closed）；verifier 4 对抗抽查 PASS，3 偏差确认合理。u4b 验收中。
- 2026-08-15 u4b committed：M0 八 unit 全闭环（u1/u1b/u2/u3/u4a/u4b/u5/u5b，全量 23 文件 164 测试绿）。verifier 5 组对抗抽查 PASS；裁量与 u4a 适配逐条确认。进入 M0 gate（A1 人肉全流程 + A3 补录攻击六路径）。
- 2026-08-15 M0 gate PASS：A1 add-capitalize root closed（145 轮 73s 收敛，六事件链完整，verify 产物落盘）；A3 六路径全拒（谎报无命令/echo ok 双杀/sed 探针隔离/假产物不信/弱验收回退留痕/改码不影响重跑）。两条语义边界备案。M1 启动：契约层 spawn/types.ts + u6a 派发。

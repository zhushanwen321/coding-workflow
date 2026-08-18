# fx-5 验收标准：成对 unit 资源回收（merge 点去副作用）——事后补录

> **本文件是事后补录的验收基线（流程缺口修复）：fx-5 实现已于 2026-08-18 committed（187f7df），当时未走「基线先行 + verifier 独立验收」流程（2026-08-18 plan 完成度审查 D1 发现）。本文档按已交付行为 + 设计勘误（design-worktree-isolation.md v3.2）补写验收标准；verifier 对 187f7df 已交付行为做事后独立验收（防篡改性质特殊：无先行情基线，核对对象 = 交付 commit 本身与设计勘误）。builder 与 verifier 禁止修改本文件。

## 1. 目标（来自 v3.2 勘误）

merge 点不承担资源回收副作用；worktree 与分支的回收收敛到唯一入口 `reclaimUnit`，谓词 = unit 终态 × 分支 tip 经 root 分支可达；不可达保守保留 + 出声；root 成果分支守卫。

## 2. 已交付物核对清单（187f7df，verifier 逐项对 commit）

| 文件 | 内容 |
|------|------|
| `src/runner/worktree.ts` | 新增 `listUnitBranchRefs` / `removeUnitBranch` / `reclaimUnit`（成对回收唯一入口；谓词 = unit 终态 × tip 可达；不可达或 root 分支缺 → 保守保留 + stderr 出声；root 成果分支不在自动回收范围） |
| `src/runner/integrate.ts` | merge 成功路径去资源回收副作用（不再内联 branch -D；v3.2「merge 点不删分支」） |
| `src/runner/loop.ts` | 回收点统一走成对入口（延迟回收 + 启动孤儿清扫扩「目录 + refs」双扫并集；ghost 目录退回原语义防误删） |
| `tests/fx5-unit-reclaim.test.ts` | 5 场景（成对回收 / 不可达保留 / 孤儿分支残留现场复刻 / 并行 root 不误删 / 冲突→人工解→重跑全链成对消失） |
| 设计勘误 | design-worktree-isolation.md v3.2（merge 点语义 + 成对谓词） |

## 3. 事后验收动作（verifier）

1. `git show 187f7df --stat` 与上表逐文件核对；`git show 187f7df` 抽读关键 diff（reclaimUnit 谓词、integrate 去 -D、loop 双扫）
2. `npx vitest run tests/fx5-unit-reclaim.test.ts` 全绿
3. 真实性抽查：5 场景测试断言语义核验（尤其「不可达保留 + 出声」与「并行 root 不误删」的断言强度——防只断言不炸不断言保留）
4. 行为对抗抽查（≥3 条，真实 tmp git + worktree）①不可达分支保留现场：构造 tip 不经 root 分支可达的子分支 → reclaimUnit 后分支仍在 + stderr 有声 ②「分支已删 + worktree 仍在」中间态（D5 矩阵「在/亡」异常格修复验证）③root 分支缺失（cw-root/<id> 不存在）→ 保守保留不误删
5. wt4 迁移断言核对：wt-4 报告中「merge 后分支已删」断言在 fx-5 后改判「保留」——确认 tests/wt4 系相应断言已迁移且语义正确

## 4. 通过标准

上表 5 文件齐全、fx5 测试全绿、对抗抽查全过、wt4 迁移断言语义正确 → PASS（补录闭环）。

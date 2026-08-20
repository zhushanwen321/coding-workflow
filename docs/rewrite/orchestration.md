# 重写期协调机制（简化版 engine + runner）

> 开发期（本文档有效期内），cw 重写不使用机器 runner，而是由主 agent 扮演 engine + runner 的简化版：**验收标准先行入 git（防篡改基线）→ builder subagent 开发 → verifier subagent 独立验收 → 主 agent 核对证据后流转状态并 commit**。交付的 cw 产品本身（M1 起）才是真正的 runner；本机制只是开发流程的协调约定。

## 角色

| 角色 | 执行者 | 职责 | 禁止事项 |
|------|--------|------|---------|
| engine+runner（简化版） | 主 agent | 写验收标准文档并 commit 基线；派发；核对证据；流转状态；唯一 commit 执行者 | 不亲自写/改任何 src、tests 文件（含契约层自身的修复——发现缺陷派 worker subagent 修，附验收标准） |
| builder | subagent（worker） | 按 `docs/rewrite/acceptance/<unit>-acceptance.md` 实现 + 自测 | 不 commit；不改验收文档；不越界改其他 unit 文件 |
| verifier | subagent（reviewer） | 对照验收文档逐项真实验收（跑命令、查产物），产出报告 | 不修代码；不改验收文档 |

## 每 unit 生命周期（状态账本见 ledger.md）

```
pending ──派发 builder──▶ building ──builder 自测过──▶ built
   ──派发 verifier──▶ verifying ──主 agent 核对通过──▶ verified ──commit──▶ committed
任何阶段验收失败 ──▶ rejected（附失败报告）──▶ 重新 building
```

## 防篡改机制（用户要求的核心约束）

1. **基线**：验收标准文档在派发 builder 之前由主 agent commit，形成 git 基线。
2. **锁定**：验收文档属于锁定文件——builder 与 verifier 均禁止修改；验收文档头部明示此约束。
3. **核对**：verifier 在报告中记录验收文档的 `git rev-parse HEAD` 与文件 sha256；主 agent 在流转状态前执行 `git diff <baseline>.. -- <acceptance-file>` 确认为空。
4. **终验回收**：终验阶段逐个回收全部验收文档与报告——① git diff 基线确认为空（无篡改）；② 抽查重跑每 unit 至少一条验收命令证实报告真实性；③ 报告结论与 ledger 状态一一对应。

## 并行规则

- 依赖无关节点（见 development-plan-v2 §2 依赖列）并行派发，同时运行的 subagent ≤3。
- 并行前提：unit 间交付文件不相交（共享文件如 `src/cli.ts` 接线的 unit 串行化，接线由主 agent 或后续 unit 完成）。
- subagent 一律不执行 git 写操作（add/commit/push 由主 agent 唯一执行），避免并行冲突。

## 与产品的关系

本机制是开发期脚手架，不进入产品代码（src/）；产品的 engine/runner 语义见 canon 设计文档（`.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md`）。两者刻意同构：验收标准 ≈ spec gate、verifier 报告 ≈ EvidenceReport、ledger ≈ 事件账本——开发流程本身就是产品理念的 dogfooding。

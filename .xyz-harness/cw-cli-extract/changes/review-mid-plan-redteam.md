---
reviewer: redteam-anti-overdesign
frame: 删/质疑（deletion test）
verdict_target: requirements.md + system-architecture.md + CONTEXT.md
source_verified:
  - xyz-pi-extensions-workspace/main/extensions/coding-workflow/src/index.ts (315 行)
  - 同上 src/cw/types.ts
decision_ledger_respected: D-001~D-005 + D-A (confirmed) 未当 gap 重报
---

# Review（红队·反过度设计路）

## Verdict: CHANGES_REQUESTED

定性：任务本体（engine 搬迁 + CLI 适配层新建）方向正确，分层判断（§6 Seam）到位，已 confirmed 决策无异议。但 **搭便车清单含 2 项失实**（会向 detail 注入伪需求 → 过度设计），另有若干章节对"替换薄壳"任务比例失当。阻断 2 项，收舍 7 项。

> 源码确认：`src/index.ts` 有效 pi 耦合适配层约 100 行（registerTool/execute/resolveCwDbPath/renderSummary），其余 ~200 行是 pi tool description 文案。"薄壳"成立。

---

## must_fix（阻断）

### M1. [伪需求] 搭便车表「typebox schema 单一来源下沉」事实错误
- **文件:章节**：system-architecture.md §1 搭便车表第 2 行；连带 §11 grep 第 5 条
- **为什么该删/该改**：源码证伪。`index.ts:55-66` 的 `CwParamsSchema` 对四个业务 schema **全部是引用**（`Type.Optional(LitePlanSchema)` 等，import 自 `plan-parser.ts:20/69/78/128`），`index.ts:52-54` 注释自述"单一来源（DRY）……不会漂移"。唯一内联的 `tasks`（waveId/commitHash）是 dispatch 参数、plan-parser 本就无此项。**现状已是单一来源，不存在"两处声明"**。CLI 入口照搬 `import { LitePlanSchema }` 即可，零"下沉"工作。
- **过度设计风险**：detail 若照此搭便车设计，会为不存在的问题做 schema 重组/统一导出层重构。
- **建议**：删除该搭便车项，或改述为"CLI 复用 plan-parser 导出的 schema（现状已单一来源）"。§11 grep 第 5 条同步删除或改为"CLI 参数校验 import plan-parser schema"。

### M2. [夸大] 搭便车表「nextAction 序列化规范化」动机不成立
- **文件:章节**：system-architecture.md §1 搭便车表第 3 行
- **为什么该删/该改**：`ActionResult`（types.ts）本是结构化对象；`renderSummary`（index.ts:288+）是 **pi TUI `content[0].text` 专用文本**，CLI 根本不碰它——CLI 输出 = `JSON.stringify(result)`。所谓"规范化"无的放矢。
- **过度设计风险**：detail 可能设计冗余的"序列化规范化层"。
- **建议**：改述为"CLI 输出直接 JSON.stringify(ActionResult)；renderSummary 是 pi 专属不迁移"，删"规范化"措辞。

---

## should_fix（收舍，不阻断）

| # | 文件:章节 | 为什么是噪音/比例失当 | 建议 |
|---|----------|---------------------|------|
| S1 | arch §4 核心模型表 + classDiagram | 文档自承"搬运不变，非新设计"。画搬迁模型的关联图对"替换薄壳"零信号 | 删 classDiagram，模型表压成一句"engine 模型搬迁不变，见 types.ts" |
| S2 | arch §5 状态流转转换表（9 行） | 同为搬迁不变物，是 state-machine.ts TRANSITIONS 的复述 | 压成"状态机零改动搬迁，见 state-machine.ts"，不重列转换表 |
| S3 | arch §9 泳道图 | 与 UC-3 主流程 + §6 分层图三重重复 | 删 |
| S4 | arch §8 Context Map flowchart | git/fs 是 engine 既有依赖、本轮不变；关系多为"客户-供应商/稳定"低信息 | 删 flowchart，保留关系表 |
| S5 | req 目标树 G2.2 / G3 成功标准 / UC-5 | 测试等价性同一件事在 3 处出现 | 合并：G3 保留为验收维度，删 G2.2（并入 UC-5），UC-5 作唯一定义点 |
| S6 | req UC-4（status/list） | dispatch 9 action 无 status/list，是 **CLI 层新增只读命令**，非 engine 搬迁；AC-4.1 措辞暗示搬迁 | 标注为"CLI 新增便利查询命令（loadTopic+序列化）"，与 UC-1~3 搬迁用例区分；工作量极小可保留 |
| S7 | arch §6 模块 LOC 预估（cli.ts~150/protocol~80） | 属 detail 实施细节 | 移至 detail，或标"粗估，detail 细化" |

---

## deletion test 结果摘要

| 元素 | 删了影响本轮任务完成？ | 判定 |
|------|----------------------|------|
| G1/G2/G3 主目标 | 影响（抽离/接入/等价缺一不可） | 保留 |
| UC-1/UC-2/UC-3（create/单发/渐进） | 影响（核心流转三模式） | 保留 |
| arch §6 分层图（新建 vs 搬迁分界） | 影响（本任务核心信号） | 保留 |
| §11 反模式 grep 1-4 条（pi 依赖/无 copy-paste/单实现 interface/行为零改动） | 影响（refactor 防回归网） | 保留 |
| 搭便车「存储路径参数化」 | 影响（真耦合，硬编码 ~/.pi/） | 保留（真需求） |
| D-A 不抽象 runtime port | — | 认可（正确的反过度设计决策） |
| G2.2 测试等价 | 不影响（G3/UC-5 已覆盖） | **可删** |
| UC-4 status/list | 不影响主任务（新增便利命令） | 可降级/标注 |
| UC-5（作 actor 用例） | 不影响（是 QA 活动非交付物） | 并入 G3 验收 |
| §4 classDiagram | 不影响（搬迁模型） | **可删** |
| §5 转换表 | 不影响（搬迁物复述） | **可缩** |
| §9 泳道图 | 不影响（三重重复） | **可删** |
| §8 Context Map flowchart | 不影响（低信息） | **可删** |
| 搭便车「schema 下沉」 | 不影响（伪需求） | **必删** |
| 搭便车「序列化规范化」 | 不影响（夸大） | **必改** |

---

## 结论

本轮任务的真实工作量 = 替换 ~100 行 pi 耦合层（registerTool/execute/resolveCwDbPath/renderSummary）+ 新建 ~250 行 CLI 入口（argv 路由/协议层）+ 迁移测试。**设计材料的过度集中在两处**：(a) 搭便车清单把 2 个伪需求当技术债（M1/M2，阻断——会污染 detail）；(b) 大量篇幅复述搬迁不变物（§4/§5/§8/§9，噪音——收舍）。

修正 M1/M2 后，其余 should_fix 不影响进入 detail，但建议一并收舍以提升 signal-to-noise。

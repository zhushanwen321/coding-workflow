# 架构审查：防 AI 乱跑的三层防线

> 审查日期：2026-07-10。审查对象：`@zhushanwen/coding-workflow`（cw CLI 独立包）。
> 审查目标：**防止 AI 在 coding 中乱跑、跳步、偷工，尤其不允许跳过 E2E 测试。**

---

## 一、核心结论

**当前架构防住了「跳步」，但没防住「偷工」。**

状态机很扎实（声明式转换表 + 三重 guard + gatePassed 级联），能防住 `created` 直接到 `test`。
但在执行阶段（dev/test）——AI 最容易偷懒/作弊的地方——检查恰恰最宽松。

这是**信任模型倒置**：对计划文档格式严苛（正则解析 markdown 表格），对执行结果宽松（信 agent 声明）。

---

## 二、问题清单（按严重度排序）

| # | 问题 | 严重度 | 根因 | 影响 |
|---|------|--------|------|------|
| **P0** | **test (mid) gate 信 claimedStatus，不验 E2E 真的跑过** | 🔴 致命 | `judgeMid` 只验 commit 存在 + 是 dev 后裔 + 信声明 | agent 可谎报 E2E passed，或压根不提交 E2E 用例只提交 unit 用例，test gate 照过 |
| **P0** | **computeGatePassed("test") 不区分用例层** | 🔴 致命 | `testCases.every(c => c.status === "passed")` 不要求 E2E 用例参与 | agent 只要逐个标记 passed 就过，E2E 用例可以被静默忽略 |
| **P1** | dev gate 只验 commit 存在，不验 diff 内容 | 🟠 高 | GitValidator 只做 cat-file + diff-tree 非空 | 空 commit / 无关 commit（改 README）能过 dev gate |
| **P1** | check 读 md 表格，不读已有 JSON | 🟠 高 | `CheckFn` 签名只有 `(topicDir)`，拿不到 topic 结构化数据 | Bug 1/2/3 整类问题；AI 写「格式正确内容虚假」的表格可过 |
| **P2** | mid handler 是 stub，mid check 已照搬 | 🟡 中 | clarify/detail `throw NotImplementedError` | 半成品；check 脚本无调用路径（死代码） |
| **P2** | gate 熔断只告警不阻断 | 🟡 中 | `GATE_RETRY_LIMIT=5` 后只换文案 | AI 可无限卡在某个 gate，无真正升级到人工的机制 |
| **P3** | lite test 的 judgeByExpected 对 E2E 太弱 | 🟢 低 | `actual.url === expected.url` 字符串精确相等 | 验证不了 E2E 真的在浏览器里跑（只验 URL 对得上） |

---

## 三、理想架构：三层防线

详细设计见 [architecture-three-layers.md](./architecture-three-layers.md)。

```
┌─────────────────────────────────────────────────────┐
│ 第一层：状态机（防跳步）✅ 已有                        │
│   TRANSITIONS + guard + computeGatePassed            │
│   → 防 created 直接到 test                           │
├─────────────────────────────────────────────────────┤
│ 第二层：证据层（防偷工）❌ 当前是空架子                │
│   dev:  commit diff 包含声明的文件                   │
│   test: 解析测试报告（junit/vitest json）判定 pass    │
│   E2E:  layer=e2e 的用例必须有执行证据，skip=failed   │
│   → 防 agent 谎报、虚标、不跑 E2E                     │
├─────────────────────────────────────────────────────┤
│ 第三层：数据源正本清源（防格式作弊）⚠️ 未做           │
│   check 读 topic JSON，不读 md 表格                   │
│   md 只给人类读 + LLM 语义审查                        │
│   → 消灭 md 正则整类 bug                             │
└─────────────────────────────────────────────────────┘
```

---

## 四、改造路线图

### Phase 0：E2E 防线（最高优先级，直接解决用户核心诉求）

| 改动 | 文件 | 工作量 |
|------|------|--------|
| `computeGatePassed("test")` 增加条件：layer=e2e 的用例全 passed 且全 submitted | state-machine.ts | 小 |
| `TestCaseSubmission` 增加 `evidencePath` 字段（测试报告路径） | types.ts / test.ts | 小 |
| `judgeMid` 解析 evidencePath，从中提取 caseId 对应结果；skip/缺失=failed | test.ts + 新增 report-parser.ts | 中 |
| test gate 增检：E2E 用例必须有 evidence 且证据里 ran+passed | test.ts | 中 |

### Phase 1：dev gate diff 内容校验

| 改动 | 文件 | 工作量 |
|------|------|--------|
| GitValidator 增加 `getChangedFiles(commitHash): string[]` | gates.ts | 小 |
| dev handler 校验 `wave.changes ⊆ commit diff files` | dev.ts | 小 |

### Phase 2：数据源迁移（check 读 JSON）

| 改动 | 文件 | 工作量 |
|------|------|--------|
| `CheckFn` 签名改为 `(topic, topicDir)` | gates.ts + 8 个 check | 中 |
| 结构化检查改读 topic.waves/testCases，md 只做语义检查 | 8 个 check 逐个改 | 大 |

### Phase 3：收尾

- 补 `handleClarify` / `handleDetail` 实现（mid 流程打通）
- gate 熔断达到阈值后切换为 `blocked` 状态（需人工 ask_user 解锁）

---

## 五、与 ADR-030/031 的关系

handoff 文档（`/tmp/handoff-adr-030-031-review.md`）讨论的是 pi extension 的 md→JSON 迁移。
独立包的优势：**JSON-native 基础设施已有**（action 层全 JSON + typebox 校验），Phase 2 迁移成本比 pi extension 低。

但独立包的当务之急不是 md→JSON（Phase 2），而是**证据层（Phase 0）**——这才是「防跳过 E2E」的核心。ADR-030/031 解决的是「检查可靠性」，证据层解决的是「执行真实性」，两者正交。

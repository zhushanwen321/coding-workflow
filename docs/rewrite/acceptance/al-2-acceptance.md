# al-2 验收标准：AcceptanceItem.layer 层级轴（D1）——纯声明模型层

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：验收分层与成本治理设计（现 `.tmp/design-acceptance-layering.md`，commit `2d5dcfa` 终版）§3.3 D1 + §5 波次 w2。设计目标 G5：旧账本重放兼容（spec 无 `layer` 字段 = 行为逐字节不变）。
> 波次：al-2 = 设计 w2（模型层，纯声明零行为变化；al-3 规则⑩⑪依赖本字段，串行后续）。

## 1. 目标

`AcceptanceItem` 新增可选字段 `layer?: "unit" | "topic"`，缺省 `"unit"`。语义（写进字段注释，是后续所有决策的锚）：`layer` 声明**执行层归属**——`"unit"`（缺省）= 本 unit 的 verify 路径执行；`"topic"` = 归集成层，唯一执行点 = 所属节点的集成验证。**该字段不改变任何执行器行为**（效力来自 al-3 的 gate 规则⑩ 声明位置约束 + 集成装配的既有行为）。旧 spec / 旧账本无此字段 = 行为逐字节不变（重放兼容先例：`VerifyRanPayload.parseFailedAcceptanceIds` 的「旧账本缺字段 = 无」）。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/events/types.ts` | 修改 | ① 新增 `export type AcceptanceLayer = "unit" \| "topic";`（与 `AcceptanceType` 同型的独立枚举，置于其附近）；② `AcceptanceItem` 增 `layer?: AcceptanceLayer`，注释含：执行层归属语义全文（§1 三句）、「不改变任何执行器行为」声明、「topic 条目只能声明在 split 非空的 spec——结构约束由 spec gate 规则⑩强制（al-3 交付）」 |
| `src/handlers/spec-schema.ts` | 修改 | `AcceptanceItemSchema` 增 `layer: Type.Optional(Type.Union([Type.Literal("unit"), Type.Literal("topic")]))`，注释对齐领域类型（与既有 `runner` / `nondeterministic` 字段注释风格一致） |
| `CONTEXT.md` | 修改 | ① 「验收（Acceptance）」词条字段列表加 `layer` 行（可选，缺省 unit）；② 新增词条「验收层级（layer）」——内容：执行层归属定义、topic 唯一执行点 = 所属节点集成、声明位置约束（split 非空，规则⑩）、缺省 unit 与旧账本兼容一句。**词条按终态语义书写（引用规则⑩）——规则⑩本体 al-3 交付，中间态超前一浪由 ledger 备案，al-3 收口** |
| `tests/al-2-layer-model.test.ts` | 新建 | §5 全部条款（L 系） |

## 3. 禁改清单（违反 = FAIL）

- **执行器零分支铁律**（设计 D2/D8 双重锁定）：`src/verify/`（全部，含 `run.ts`——al-1 并行领地）、`src/runner/`（全部——integrate.ts 批次装配、loop.ts、brief.ts 均零改动）、`src/core/`（fold 的 verified 公式）、`src/readonly/`（frontier）、`src/testrun/`
- `src/events/types.ts` 内：既有类型与字段**零改名改义**（文件头纪律），只做纯追加（`AcceptanceLayer` + `AcceptanceItem.layer`）；`SpecRulesResult` / gate 相关类型零改动（al-3 领地）
- `src/gates/spec-rules.ts`（al-3 领地）、`src/handlers/` 除 `spec-schema.ts` 外全部、`src/cli.ts`、`src/dispatch.ts`、`src/store/`
- `AGENTS.md` 与 `docs/` 既有文档（AGENTS.md 的「九规则」表述与 u3-acceptance 口径更新归 al-3 / D8）
- `tests/` 既有文件零改动
- `CONTEXT.md` 只加不改：既有词条文字逐字节保留，只做 §2 列明的两处追加

## 4. 形状锁定

1. **枚举独立类型**：`AcceptanceLayer` 单独 `export`（消费方 typing 用它，不内联字符串联合）。
2. **schema 与领域类型同源**：spec-schema 的 Union Literals 必须与 `AcceptanceLayer` 完全一致（两处一致性由本文件单点维护——文件头既有约定，注释互相指向）。
3. **typebox 既有行为边界（备案）**：schema 校验通过后按 Static 类型直读、额外字段不剥离——`layer` 会原样进 `SpecSubmittedPayload.acceptance[]` 入账（这正是 al-3 规则⑩的判定输入；schema 显式声明后非法值在入口被拒，不依赖 gate）。
4. **入账序列化形态**：显式声明 `layer` 才在 events.log 的 payload 里出现该键；缺省不写键（`undefined` 经 JSON.stringify 自然丢弃）——L3 锁定。
5. **不实现的清单**（设计「本设计明确不改」+ D2）：runAcceptances 不跳过 topic 条目、fold / integrate / frontier 不读 layer、verify 的 acceptanceIds 覆盖公式不变、红阶段不特殊处理。

## 5. 新增测试条款（真实子进程 + tmp + CW_HOME 隔离，零 mock；e2e 条款走 `node dist/cli.js` 完整 dispatch）

- **L1 schema 合法值入账**：真实 CLI（隔离 CW_HOME tmp 仓）提交含 `layer: "topic"` 与 `layer: "unit"` 两条验收的合法 spec → exit 0 入账；events.log 末事件 payload 的对应 acceptance 条目各含 `layer` 键且值正确。
- **L2 schema 非法值拒**：`layer: "root"` → exit 1，错误含字段路径 `/acceptance/<n>/layer`；`layer: 123` 同拒。
- **L3 缺省不写键**：不带 `layer` 的既有形态 spec → 入账 payload 的 acceptance 条目**无** `layer` 键（不是 `layer: "unit"` 字面量——缺省语义靠 absence 表达，旧账本逐字节兼容的根基）。
- **L4 旧账本重放兼容**：用**改造前代码基线产物**（fixture：本仓重写期真实账本副本或旧 spec 构造的账本，commit 进 tests/fixtures/ 或测试内构造均可，但必须是「无 layer 字段」的真实事件流）→ 改造后代码跑 `cw status` / `cw tree` / `cw report`（含 `--json` 形态）输出与基线一致（快照或关键字段断言——至少含 unit 状态、验收覆盖、事件数；「逐字节」口径按 mx5 doc-4 先例可降为结构化全字段比对，但须覆盖三命令）。
- **L5 带 layer 账本只读健康**：L1 产出的账本跑 `cw status` / `cw tree` / `cw report` → 正常输出零崩溃，spec-frozen 状态与改造前同形态（fold 不读 layer）。
- **L6 执行行为不变（D2 结构性验证）**：真实 CLI 对含 `layer: "topic"` 条目的 spec 跑 `cw verify --unit <id>`（本波 gate 尚无规则⑩，叶子 spec 带 topic 条目可入账——构造期诚实利用该窗口）→ 该条目**照常执行**（e2e-sh 型带标记行 → pass；产物在场），verify 的 pass/fail 判定与无 `layer` 字段的同命令 spec **逐结果一致**——「该字段不改变任何执行器行为」的机器实证。
- **L7 类型层编译锁定**：`npm run check:all` 过（`AcceptanceLayer` 导出 + 消费侧无 any）。

### 回归（通过命令内含）

全量 npm test 全绿——特别是 u2（spec schema 链）、u3（gate 五规则行为）、u4a/u4b（verify 语义）、u5b（只读命令）零翻红。

## 6. 通过命令

```
cd <仓库根> && npm run check:all
npx vitest run tests/al-2-layer-model.test.ts
npx eslint src/events/types.ts src/handlers/spec-schema.ts tests/al-2-layer-model.test.ts
全量 npm test → 全绿（基线 74 文件 576 用例 + al-1 新增，以实跑为准；本 unit 新增用例另计）
```

## 7. 波后验收（verifier 执行，真实场景）

取真实存量账本（本仓 `~/.cw` 或重写期 fixture 副本，无 layer 字段），改造后代码重放 `cw report --json` 全量输出与改造前（verifier 用 git stash / 基线 commit checkout 对照跑）**结构化逐字段一致**；再对 L1 产出的带 layer 账本重放同命令验证 L5。对照设计 S2 场景（三条只读命令 + 既有套件全绿）。

## 8. status

pending → building → **pending 派发**（2026-08-22 基线入 git，builder 派发）

> 本节（§8 status）由主 agent 流转更新，不属于防篡改范围；§1-§7 禁止修改。

# al-4 验收标准：端到端真实场景验收（S1 执行点唯一性 / S6 触发案例形态对照 / S4 第六维语义）

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：验收分层与成本治理设计（`.tmp/design-acceptance-layering.md`，commit `2d5dcfa` 终版）§4 S1 / S4 / S6 + §5 波次 w4。G1/G2/G3 的端到端机器实证——模型（al-2）与防线（al-3）都在位后的全链验证。
> 依赖：al-2 + al-3 committed。波次：al-4 = 设计 w4（端到端验收，M5 收官 unit）。

## 1. 目标

真实 cw CLI + 真实多包 git 仓（fixture）+ 真实子进程下验证三场景：**S1** topic 层条目只在集成执行一次（叶子 verify 路径零回归痕迹——结构结果实证）；**S6** 触发案例形态对照（无关既有挂测试让回归只在集成红一次，处置走 integrationDrift 通道而非叶子多轮全价重付）；**S4** reviewer 第六维语义真实生效（波后 manual 型——真实 pi reviewer spawn）。

fixture 仓形态（模拟 xyz-agent 触发案例）：多包结构（2+ 包各有真实 vitest 套件 + 根 lint script）+ `scripts/topic-regression.sh` wrapper（内部跑 lint + 全部包 vitest，尾部按成败输出 `R1 PASS` / `R1 FAIL` 标记行且 exit code 一致——设计 D1a 形态一）。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `tests/al-4-e2e-layer.test.ts` | 新建 | §5 A1 系（S1）+ A6 系（S6）自动化场景 |
| `tests/fixtures/`（如需共享构造器） | 新建 | 多包 fixture 仓构造（内联于测试文件亦可——builder 按既有 e2e 惯例裁量，构造器形态记入汇报） |

## 3. 禁改清单（违反 = FAIL）

- **src/ 全部零改动**（本 unit 纯验收测试——发现实现缺陷上报主 agent 裁决，不修）
- `tests/` 既有文件零改动
- `docs/rewrite/` 全部既有文档；`.tmp/design-acceptance-layering.md`
- 若 fixture 需共享文件：只允许 `tests/fixtures/` 下新增，不碰 `append-worker.js` 等既有夹具

## 4. 场景构造锁定

### fixture 仓（两场景共用基底）

- 根 `package.json`（workspaces 或直接 scripts）+ `scripts/lint.sh`（或 lint script）+ `scripts/topic-regression.sh`（wrapper：lint + 全包 vitest，成败汇总输出 `R1 PASS`/`R1 FAIL`）
- `packages/app/`：`package.json` + 真实 vitest 套件（`app.test.ts` 至少 1 用例真绿）
- `packages/lib/`：同构；**S6 场景追加** `broken.test.ts`（恒挂、与本功能无关的「既有坏测试」形态）
- fixture 仓 git init + 初始 commit（verify 需要干净 checkout 有 commit 可检出）

### topic 构造（真实 CLI 手动链）

1. `cw create --id root` → `cw create --id leaf-app --parent root` + `cw create --id leaf-lib --parent root`（fx-3 R5.1：先建子）
2. root spec：split 声明两叶 + 验收 = R1（`layer: "topic"`、`type: "e2e-real"`、`command: "bash scripts/topic-regression.sh"`）+ 至少一条 `type: "unit"` 用例（规则⑤不豁免 topic 条目——设计 D4 已知边界二）+ 各叶子一条契约（可选）
3. `cw evidence submit --kind spec`（过 gate：split 非空 + ⑩ 满足）→ `cw review submit --role reviewer --verdict pass`
4. 叶子 spec：各一条功能验收（`type: "unit"`、command 指向本叶子的 vitest 文件参数形态——避开规则⑪ warning 或如实消费 warning 均可，测试断言按实际）→ review pass
5. 叶子 build 证据（实现测试文件 commit）→ `cw verify --unit <leaf>` → `cw review submit --kind exec-review`（--evidence-refs 按契约）→ closed
6. 集成：直调 `runIntegrationVerify`（u8-integrate.test.ts 先例——import 路径与调用形态对齐）

## 5. 测试条款（真实子进程 + tmp + CW_HOME 隔离，零 mock）

### A1 系（S1：执行点唯一性）

- **A1-1 叶子 verify 零回归痕迹**：叶子 verify 产物目录（`evidence/<leaf>/verify-*/`）逐文件核对——无 R1 执行痕迹（叶 spec 无该条目 = 结构结果；R1 的 stdout/report 文件不在叶子产物集）。
- **A1-2 集成批次含 R1**：集成产物（`evidence/<root>/integrate-*/`）的 root 批次含 R1 真实执行结果（`R1.report.json` 在场、e2e-sh 标记行判定、pass）。
- **A1-3 全账本执行记录唯一**：全账本扫描——R1 的执行记录仅出现在 integrate-* 前缀的 run（无 verify-* run 覆盖 R1）。
- **A1-4 收敛闭环**：集成 pass 后 root 达 verified 形态（fold 投影或 report 断言），全链人工零干预（测试进程扮演全部角色）。

### A6 系（S6：触发案例形态对照）

- **A6-1 回归只在集成红**：lib 含 broken.test.ts → wrapper 输出 `R1 FAIL`（全绿才 PASS 语义）→ 集成 fail；断言 R1 的红仅出现在 integrate-* run 一次，叶子各轮 verify 零次执行 R1。
- **A6-2 处置走 integrationDrift**：集成 fail 后（rv-4 MAX=1 首败即转）——frontier 投影出现 integrationDrift 维度（root），或 loop 侧处置任务书渲染含契约漂移处置指引（二选一断言形态，按 u8/fx2 既有测试惯例）；**不发生**叶子侧多轮全价重跑（对照组：触发案例 5 轮 build + 6 次 verify 全价——本场景零次）。
- **A6-3 修复通道恢复**：修掉 broken.test.ts（或 wrapper 层面）后重跑集成 → pass → root verified（漂移处置出口可恢复的实证——闭环而非死局）。

### 通用

- 全链事件序断言：UnitCreated → SpecSubmitted(root 含 layer 字段原文) → … → VerifyRan(integrate-*) acceptanceIds 含 R1。
- 测试对全链耗时不设硬断言（记录输出供人工对照 S1②「耗时与功能验收同量级」）。

## 6. 通过命令

```
cd <仓库根> && npm run check:all
npx vitest run tests/al-4-e2e-layer.test.ts   （两连跑防 flaky）
npx eslint tests/al-4-e2e-layer.test.ts tests/fixtures/<新增>（如有）
全量 npm test → 全绿（基线以实跑为准；rv5 T3/T8 存量间歇竞态重跑即绿）
```

## 7. 波后验收（verifier 执行）

1. **S4 语义（manual 型，mx5-3 V3 先例）**：spawn 真实 pi reviewer（PI_OFFLINE 形态或真实调用）审「叶子 unit 层全量回归形态 spec」（构造 = S3② 形态：叶子 spec 含无文件参数 `npx vitest run` 条目）→ 人工核验 verdict comment 命中第六维（指出成本/层级问题 + 上收 root 指引）。产物落 tmp 留档。不用 LLM 输出做自动化断言（概率性输出进 e2e 会 flaky）。
2. **G6 文档核对**（设计 §4 G6 验收方式）：核对设计 §2.5 全景表每个面均有处置栏（治理 / 记档 + 触发条件，无「待定」）+ D9 触发条件均可观测——本项核对对象是设计文档本身，结论记入报告。
3. **场景重放抽查**：verifier 自选 A1/A6 各一条用不同 tmp 副本重放（不依赖 builder 的 tmp 残留）。

## 8. status

pending → building → **pending 派发**（2026-08-22 基线入 git，builder 派发；al-2 committed 0902c53 + al-3 committed 23f4163，模型与防线均在场）

> 本节（§8 status）由主 agent 流转更新，不属于防篡改范围；§1-§7 禁止修改。

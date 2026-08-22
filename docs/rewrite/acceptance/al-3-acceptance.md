# al-3 验收标准：防线层（D4 规则⑩ + D5 规则⑪ + D6 reviewer 第六维与 designer 指引 + D8 文档同步）

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：验收分层与成本治理设计（`.tmp/design-acceptance-layering.md`，commit `2d5dcfa` 终版）§3.3 D4/D5/D6/D8 + §5 波次 w3。三道防线同属「写入链治理」一个语义单元，一起交付才能闭环。
> 依赖：al-2（`AcceptanceLayer` 类型与 schema 已在场）；本 unit 在 al-2 committed 后派发。
> 波次：al-3 = 设计 w3（防线层）。

## 1. 目标

写入链的三道机器/机制防线，让「全量回归只在集成层执行」成为结构保证而非 agent 自觉：① gate 规则⑩（fail 级结构规则）——`layer === "topic"` 的条目要求 `spec.split` 非空（叶子声明 topic = 永无执行点的真空，提交期拒绝）；② gate 规则⑪（warning 级成本启发式）——unit 层条目 command 命中全量回归形态时入账继续 + stderr 警告（启发式有误杀面，硬防线在 reviewer）；③ reviewer 对抗清单五维 → 六维 + designer 任务书防下放指引 + 既有「验收五规则」文案 drift 对齐 + D8 三处文档同步。

**执行器零改动铁律不变**（设计 D2）：`src/verify/run.ts`、`src/runner/integrate.ts`、`src/core/fold.ts`、`src/readonly/frontier.ts`、`src/runner/loop.ts` 全部零改动。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/gates/spec-rules.ts` | 修改 | 规则⑩（fail 级）+ 规则⑪（warning 级）+ ⑪ 形态枚举单一事实源（§4 形状）。规则①-⑨逐字节零变更；多缺口全列不短路语义保持 |
| `src/events/types.ts` | 修改 | `SpecRulesResult` 增可选字段 `warnings?: string[]`（注释：缺省空 = 旧行为，重放兼容；warnings 不影响 ok 判定——ok 只看 failures） |
| `src/handlers/evidence-submit.ts` | 修改 | gate 通过且 warnings 非空 → stderr 打印规则⑪警告（文案要素见 §4.C），**入账继续 exit 0**；warnings 为空/缺省时输出路径与现状逐字节一致 |
| `src/runner/brief.ts` | 修改 | ① `specReviewReviewerTasks` 清单加第六维（§4.D 全文）；② `designerFirstTasks` 加防下放指引（§4.E）；③ 三处「验收五规则」文案 drift 对齐（§4.F——151/166/328 行区域） |
| `docs/rewrite/acceptance/u3-acceptance.md` | 修改（授权） | 规则口径追加⑩⑪（先例：fx-1/rv-2/mx-2/mx5-1 各自追加规则⑥-⑨；设计 D8 明确要求同步） |
| `AGENTS.md` | 修改（授权） | 「spec gate 九规则」表述 → 十一规则（⑩⑪ 一句话口径） |
| `CONTEXT.md` | 修改 | 「spec gate 九规则」词条 → 十一规则（①-⑪ 全文，⑩⑪ 描述与实现一致）；al-2 已落的「验收层级（layer）」词条中「规则⑩ al-3 交付」的中间态注记收口（若 al-2 落了该注记） |
| `tests/al-3-gate-rules.test.ts` | 新建 | §5 T / W 系条款 |
| `tests/al-3-brief-sixth-dim.test.ts` | 新建 | §5 B 系条款 |

## 3. 禁改清单（违反 = FAIL）

- **执行器零改动**：`src/verify/`（全部）、`src/runner/` 除 `brief.ts` 外全部（`loop.ts` / `integrate.ts` / `escalations.ts` / `spawn/` / `worktree.ts`）、`src/core/`、`src/readonly/`、`src/testrun/`
- `src/events/types.ts` 内只追加 `SpecRulesResult.warnings`（al-2 已交付的 `AcceptanceLayer` / `AcceptanceItem.layer` 零改动）；`src/handlers/` 除 `evidence-submit.ts` 外全部
- `src/gates/spec-rules.ts` 内规则①-⑨ 的判定逻辑与文案零变更（头注释规则清单追加⑩⑪两行属交付义务）
- `tests/` 既有文件零改动；`docs/rewrite/acceptance/` 除 `u3-acceptance.md`（授权口径追加）外零改动
- `CONTEXT.md` 除「spec gate 九规则」词条更新与 al-2 词条注记收口外，既有文字逐字节保留
- 语义锁定：`checkSpecRules` 的 `ok` 判定语义（只看 failures）零变化；无 warning 路径的 evidence-submit 输出与现状逐字节一致；brief 模板其余段落（mx5-3 锁定的 reviewer 一至五维、designer 第 0 步、其他 frontier 维度任务书）零变更

## 4. 实现形状（锁定）

### A. 规则⑩（fail 级，纯函数，判据只用 spec payload 自身）

- 判据：`spec.acceptance` 中存在 `layer === "topic"` 的条目，而 `spec.split.length === 0` → 逐条目列缺口（多条全列）。
- 语义闭环（写进代码注释）：split 非空 ⟺ 有子节点 ⟺ 有集成执行点 ⟺ topic 条目会被执行；split 为空声明 topic = 该条目永无执行点（真空）→ 提交期拒绝。与 fx-1 R1「叶子不得声明 split」/ fx-3 R5.1「split 声明的子必须已入账」两道 handler 级防线正交：⑩ 在 gate 层从另一侧收口，无绕过面。
- 错误文案（要素锁定，措辞可润）：规则编号⑩ + 条目 id + 事实（声明了 `layer: "topic"` 但本 spec 的 split 为空——叶子/无子节点 unit 没有集成执行点，topic 层条目将永不被执行）+ **两个恢复方向**：topic 层验收归有子节点的 root spec 声明（执行点是内部节点集成）——若本条是全量回归，上收 root spec 并标 `layer: "topic"`；若确属本 unit 功能验收，去掉 layer 字段按 unit 层声明。
- 已知边界写进文案（设计 D4 边界一）：单 unit topic（root 无子、split 空）不能声明 topic 层——它本就没有集成执行点，全部验收按 unit 层跑。
- 注意：规则⑤不豁免 topic 条目——root spec 上收回归后仍须至少一条 `type: "unit"` 用例（归 designer 指引提示，不属本规则文案职责）。

### B. 规则⑪（warning 级，成本启发式，纯词法判定不执行命令）

- 作用域：`layer` 未声明或 `layer === "unit"` 的条目（topic 条目不查——它已归集成层）。
- **形态枚举（单一事实源内的可扩展枚举，与 ADAPTER_FLAG_CONTRACTS 同型组织）**：
  - 形态 A（vitest 全量）：command 的空白切分 token 序列命中 ` vitest run`（vitest 前允许包管理器前缀 token：`npx` / `pnpm` / `yarn` / `bun` / `bunx` 之一或无前缀），且 `run` 之后**无位置参数**（后续 token 全部以 `-` 开头或无后续 token）→ 命中。`run` 之后存在不以 `-` 开头的 token（文件/目录参数）→ 不命中。
  - 形态 B（全仓 script）：token 序列命中包管理器 test/lint script 调用——首 token `npm` / `pnpm` / `yarn` / `bun` 之一，其后（允许 `run` 中缀）出现 script 名恰为 `test` 或 `lint`，且 **script 名之后无位置参数** → 命中。
  - 显式不枚举（诚实漏报面，写进代码注释与 reviewer 第六维兜底）：wrapper 脚本（`bash xxx.sh`——内部跑什么词法不可见，触发案例 E7 的实际形态）、script 别名封装、`make test` 等。
- warning 文案（要素锁定）分两种形态（设计 D5）：
  - **split 为空**（叶子）：规则⑪ + 条目 id + 事实（command 是全量回归形态「<命中的原文形态>」且本 unit 是叶子——叶子 verify 每轮 fix 含红阶段都会全价重跑它）+ 建议：若为全量回归，上收 root spec 并标 `layer: "topic"`（集成层唯一执行）；若确为本 unit 范围，为 command 加文件参数收窄。
  - **split 非空**（内部节点的 unit 层回归）：同上事实 + 建议改为：执行点与 topic 层相同，建议显式标 `layer: "topic"`（成本归属可审计）。
- warning 级理由（写进注释）：静态形态判定有误杀面（小仓的全量单测可能就是叶子的合理范围），硬拒会逼出规避动作（命令包进 wrapper 绕开启发式）；硬防线在 reviewer 第六维语义审。与规则⑨对 e2e/manual 的「诚实边界」哲学同款。

### C. SpecRulesResult.warnings 与 evidence-submit 打印

- `SpecRulesResult` 增 `warnings?: string[]`；`checkSpecRules` 返回 `{ ok, failures, warnings }`（warnings 无命中时为空数组或 undefined——**缺省形态 = 旧行为逐字节兼容**，消费方 `?? []` 防御）。
- `evidence-submit.ts`：gate 通过（ok）后 warnings 非空 → stderr 逐条打印（前缀含「规则⑪」与「已入账但触发成本警告」语义——spec 已入账事实先行，警告非拒绝）；入账与 exit 0 不受影响。gate fail 路径零变更（failures 输出形态不动）。
- `load.ts` / 只读命令对 SpecRulesResult 的既有消费零影响（warnings 无人消费除 evidence-submit 打印——fold 不读）。

### D. reviewer 清单第六维（specReviewReviewerTasks）

五维后追加（全文锁定，措辞可微调但要素不可缺）：

```
⑥ 验收成本与层级归属：全量回归形态是否出现在叶子 spec 的 unit 层——含裸命令
   （无文件参数的全量 vitest / 全仓 lint、test script）与封装形态（command 指向
   wrapper 脚本或 script 别名的，须追进脚本/别名内容看实际跑什么——gate 规则⑪
   的词法检查对封装形态不可见，这里是唯一语义防线）。集成口径必然重跑 root
   验收，叶子重复声明 = 每轮 fix 全价双付。此类条目 must-fix：上收 root spec
   并标 layer: "topic"；确属本 unit 范围的加文件参数收窄。wrapper 自限建议：
   回归脚本内部可自限并发（如 vitest --max-workers），避免单条命令打满全部核。
```

既有「按五维度对抗式核对清单」句改为六维度（数字与维度计数一致）；pass 时逐项显式「核过无问题」的约定句覆盖到⑥。

### E. designer 防下放指引（designerFirstTasks）

第 1 步（撰写 spec）的规则转述后追加一行：

```
   root 级回归型验收（全仓 lint / 全量 vitest 等全量回归）归 root spec 声明并标
   layer: "topic"（由集成阶段统一执行，只在集成跑一次）；子 unit spec 只声明本
   unit 的功能验收，不得复制回归条目（叶子重复声明 = 每轮 fix 全价双付）。
```

### F. 「验收五规则」drift 对齐（三处）

`brief.ts` 现有三处文案写死「验收五规则」（specFixPending 兜底 comment、修 spec 指令、designerFirstTasks 第 1 步）而 gate 实际已九规则、本波后十一规则——统一改为不写死数字的「验收规则（src/gates/spec-rules.ts）」形态（长期方案：数字每次加规则都会 drift，去掉数字一劳永逸）。

## 5. 新增测试条款（真实子进程 + tmp + CW_HOME 隔离，零 mock；e2e 条款走 `node dist/cli.js` 完整 dispatch）

### tests/al-3-gate-rules.test.ts（T / W 系）

- **T1 叶子 topic 拒入账**：真实 CLI，叶子 unit（split 空）spec 含 `layer: "topic"` 条目 → exit 1 不入账（events.log 无该 SpecSubmitted），stderr 文案含：条目 id、「split 为空」「集成执行点」「永不被执行」字样、两个恢复方向（上收 root spec 标 topic / 去 layer 按 unit 层）。
- **T2 root topic 正常入账**：root unit（子已 `cw create`，split 非空指向已建子）spec 含 `layer: "topic"` 条目 → exit 0 入账，无⑩缺口无⑪ warning。
- **T3 unit 层不受⑩**：叶子 spec `layer: "unit"` 与缺省 layer 混合 → 不触发⑩（正常入账路径）。
- **T4 多条 topic 全列**：两条 topic 条目 → 缺口逐条列出（不短路）。
- **T5 ⑩与①-⑨共存全列**：spec 同时含规则③缺口（e2e 缺 command）与⑩缺口 → 两规则缺口同列。
- **W1 叶子全量 warning + 入账**：叶子 spec 含 `npx vitest run`（无位置参数）unit 层条目 → exit 0 入账 + stderr 含规则⑪文案（「上收 root spec 并标 layer」方向 + 「加文件参数收窄」方向 + 条目 id）。
- **W2 root unit 层全量形态**：split 非空的 spec 含 `npx vitest run` unit 层条目 → exit 0 + warning 文案为「建议显式标 layer: "topic"」形态（两种 split 形态文案分流）。
- **W3 文件参数不命中**：`npx vitest run tests/foo.test.ts` → 无规则⑪输出。
- **W4 wrapper 不命中（诚实边界锁定）**：`bash scripts/regression.sh` → 无规则⑪输出（漏报面 = reviewer 第六维兜底，测试锁定不误报）。
- **W5 全仓 script 形态命中**：`pnpm run lint` 与 `npm test`（各自独立用例）→ warning。
- **W6 干净路径零污染**：合规 spec（无形态命中）→ stderr 输出与改造前同形态（无规则⑪痕迹；对照法：改造前基线产物或结构断言）。

### tests/al-3-brief-sixth-dim.test.ts（B 系）

- **B1 reviewer 第六维在场**：构造 specReviewPending 的 unit，渲染任务书（print 或直调导出——按 brief.ts 现有测试形态 mx5-3 先例）→ 输出含「验收成本与层级归属」维全文要素：裸命令、封装形态（wrapper 脚本追进内容）、must-fix 上收指引、wrapper 自限建议。
- **B2 六维度计数一致**：输出中「六维度」（或等价计数表述）与实际维度条数一致（不再写「五维度」）。
- **B3 designer 防下放指引**：designerFirstTasks 渲染输出含「归 root spec 声明并标 layer」与「不得复制回归条目」要素。
- **B4 drift 对齐**：brief.ts 全文 grep「验收五规则」零命中（三处全部更新）。
- **B5 既有维度零变更**：渲染输出中①-⑤维度文案与改造前一致（快照或关键词组断言）。

### 回归（通过命令内含）

全量 npm test 全绿——u3（gate 既有九规则）、u2（evidence-submit）、mx5-3（brief 模板分段）、u5b（只读）零翻红。

## 6. 通过命令

```
cd <仓库根> && npm run check:all
npx vitest run tests/al-3-gate-rules.test.ts tests/al-3-brief-sixth-dim.test.ts
npx eslint src/gates/spec-rules.ts src/events/types.ts src/handlers/evidence-submit.ts src/runner/brief.ts tests/al-3-*.test.ts
全量 npm test → 全绿（基线以实跑为准，新增用例另计）
```

## 7. 波后验收（verifier 执行，真实场景）

真实 CLI 三场景对照设计 §3.1：① 失败路径 1——叶子 topic 条目拒入账，stderr 文案与设计全文要素逐项核对；② 失败路径 2——叶子 `npx vitest run` warning 入账继续，exit 0；③ 成功路径——root（子已建）topic 条目正常入账。外加 reviewer 任务书真实渲染（human spawn 或 print 形态）核第六维在场与一至五维零变更。

## 8. status

pending → building → **pending 派发**（2026-08-22 基线入 git，builder 派发；al-2 已 committed 0902c53，AcceptanceLayer 在场）

> 本节（§8 status）由主 agent 流转更新，不属于防篡改范围；§1-§7 禁止修改。

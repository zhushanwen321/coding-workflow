# al-3 验收报告（防线层：规则⑩⑪ + reviewer 第六维 + designer 防下放 + D8 文档同步）

> verifier 独立验收报告（对抗式：builder 自报一律待证实）。验收日期 2026-08-22。
> 基线：commit `5852c49` 的 docs/rewrite/acceptance/al-3-acceptance.md §1-§7（§8 status 除外）。

## 总结论：**PASS**

（一处词条外三行 drift 连带的裁量观察见 §6.O1，不构成 FAIL，交主 agent 终裁记录。）

## 1. 防篡改核对

| 项 | 结果 |
|----|------|
| 验收文档 sha256 | `75a38c7d661c63b680a2ca3f57c063e18e49284c035b63ef3fbbfcf4de4ef62c` |
| `git diff 5852c49 -- docs/rewrite/acceptance/al-3-acceptance.md` | **空**（未篡改；工作区 HEAD 即 5852c49，全部交付在工作区未提交，符合 builder 不 commit 约定） |
| 改动集 ⊆ 交付清单 | 9 修改 + 2 新建测试 = 交付表 9 文件 + 主 agent 追认 2 测试修订，共 11 文件，吻合 |
| 越界扫描 | `git status` 仅上述 11 文件 + 豁免 untracked（`docs/rewrite/acceptance/al-4-acceptance.md`）；无其他越界 |

## 2. 通过命令实跑

| 命令 | 结果 |
|------|------|
| `npm run build` | 通过 |
| `npm run check:all`（check + check:tests） | 通过 |
| `npx vitest run tests/al-3-gate-rules.test.ts tests/al-3-brief-sixth-dim.test.ts` | 2 文件 18 用例全绿 |
| `npx eslint src/gates/spec-rules.ts src/events/types.ts src/handlers/evidence-submit.ts src/runner/brief.ts tests/al-3-*.test.ts` | 零输出（干净） |
| 全量 `npm test` | **78 文件 608 用例全绿，exit 0，158.8s**（rv5 T3/T8 存量竞态未出现，无归因项） |
| 定向回归：u3-spec-rules(14) / u2-evidence(15) / al-2(7) / mx5-3(10) | 全绿——既有九规则、evidence 提交、al-2 层模型、brief 模板分段零翻红 |

## 3. 两处主 agent 追认偏离的逐行深查（mx5-2「测试侧越界深查」先例口径）

### 3.1 tests/al-2-layer-model.test.ts（42 行改动）——判定：**最小必要，无掩盖回归**

- `freezeUnit` 新增可选参数 `splitChildId`：缺省不建子，既有调用点（L4 等无 topic 场景）行为不变。扩展而非改写。
- L1/L5 夹具 `split: []` → `[{ unitId: <leaf> }]` + 先 `cw create` 子：规则⑩落地后「叶子 + topic 条目」形态必然被 gate 拒，夹具改「root + 子已建 + split 非空」是继续测试同一断言对象（layer 键入账/透传）的唯一合法形态。L1 的断言区零改动（diff 之外）。
- L5 断言从 `toHaveLength(1)` + 位置索引改为 `find(u => u.unitId === "u-l5")` 定位：账本现含 2 个 unit，位置断言必然失效，find 是结构必然的等价改写。核心断言（u-l5 spec-frozen + layer 三态透传 unit/topic/缺省不注入）逐条保留。`toHaveLength(1)` 的删除是夹具形态变化的必然伴随，非断言强度削弱（其意图「与 L4 无 layer 账本同形态」仍由 find 定位断言承载）。
- **L6「逐结果一致」对照是否仍真实**：是。修订前「唯一差异 = T1 条目带不带 layer」变为「u-6a root（split 非空）/ u-6b 叶子」，引入第二差异（split）。但 `src/verify/` 全目录在禁改清单且 diff 零改动——cw verify 不读 split（split 归 handler 层 R5.1 与集成路径消费），对 verify 可见的 spec 差异仍只有 layer 键。原断言链完整保留：stdout 判定行逐行相等（`verdictLinesOf` 正则抽取 toEqual）、VerifyRan `result`/`acceptanceIds` 一致、T1.stdout 产物含标记行（「照常执行」的产物级实证）。实测绿。注释如实披露修订缘由与授权。

### 3.2 tests/mx5-3-reviewer-brief.test.ts（11 行改动）——判定：**最小必要，无掩盖回归**

- B3 快照共 6 case，diff 仅触 designer-spec-ready 与 designer-spec-fix 两个（hunk @@ -379 / @@ -415），外加备案注释块（@@ -362）。其余 4 快照（designer-missing-children / designer-integration-drift / developer-build-ready / reviewer-exec-review）零改动——与 brief.ts 改动只波及 designerFirstTasks 第 1 步与修 spec 指令两段的渲染面精确吻合。
- 快照消费是 `toBe` 逐字节断言（L555）：快照与 al-3 后 dist 真实渲染逐字节相等由全量 608 绿机器证实——若 builder 同步快照时夹带任何多余改动（改弱断言、改夹具），要么快照对不上翻红，要么渲染本身变了导致其他 toContain/toBe 断言翻红。无绕过面。
- designer-spec-ready 快照改动 = 第 1 步「验收五规则」→「验收规则」（1 行改）+ 防下放指引 3 行新增，与 brief.ts diff 中 designerFirstTasks 的输出逐字节对应；designer-spec-fix 快照改动 = 「验收五规则见」→「验收规则见」（1 行改）。未动其他断言。
- mx5-3 B1（五维标题断言）不需改的原因核实：B1 断言用五个维度标题关键词（「验收命令契约逐条核对」等），不含「五维度」计数字样（该字样仅存在于 describe/it 标题字符串，不进断言）——brief.ts 改「六维度」不触及 B1。诚实解释了为何只改两快照。

## 4. §5 条款对照表

### tests/al-3-gate-rules.test.ts（T/W 系，13 用例实跑全绿）

| 条款 | 断言实态 | 判定 |
|------|---------|------|
| T1 叶子 topic 拒入账 | exit 1 + events.log 无 SpecSubmitted（EventLedger 直读账本）+ stderr 含规则⑩/E7/split 为空/集成执行点/永不被执行/两个恢复方向（「上收 root spec 并标 layer」+「去掉 layer 字段按 unit 层声明」）；另附已知边界用例（无子 root 同拒） | PASS |
| T2 root topic 正常入账 | 子先 create + split 指向 → exit 0 + 入账 + stderr 无⑩无⑪（双负向） | PASS |
| T3 unit 层不受⑩ | layer:"unit" 与缺省混合 → exit 0 入账 | PASS |
| T4 多条 topic 全列 | `res.stderr.match(/规则⑩/g)` 计数 2 + 两 id 各在场——不短路的计数级断言 | PASS |
| T5 ⑩与①-⑨共存全列 | rule③ 与 规则⑩ 同列 + indexOf 顺序断言（③ 前 ⑩ 后，序号升序） | PASS |
| W1 叶子全量 warning+入账 | exit 0 + 入账 + 规则⑪/E7/上收方向/收窄方向/「已入账」六要素 | PASS |
| W2 root unit 层文案分流 | 「建议显式标 layer: "topic"」在场 + **not.toContain("加文件参数收窄")** 负向——两种 split 形态文案真实分流 | PASS |
| W3 文件参数不命中 | `npx vitest run tests/foo.test.ts` → not 规则⑪ | PASS |
| W4 wrapper 不命中 | `bash scripts/regression.sh` → not 规则⑪（诚实漏报面锁定） | PASS |
| W5 全仓 script 命中 | pnpm run lint 与 npm test 各自独立用例（叶一层级）| PASS |
| W6 干净路径零污染 | `expect(res.stderr).toBe("")` 结构断言（基线授权的对照法替代）+ exit 0 + 入账 + stdout「已入账」——succeed 走 stdout、成功提交 stderr 恒空是改造前既有形态，空串断言等价锁定逐字节零污染 | PASS |

### tests/al-3-brief-sixth-dim.test.ts（B 系，5 用例实跑全绿）

| 条款 | 断言实态 | 判定 |
|------|---------|------|
| B1 第六维在场 | 真实账本 + fold + writeBriefFile 渲染；维度标题/裸命令/封装形态追进/唯一语义防线/双付/must-fix 上收/收窄/wrapper 自限(--max-workers) 全要素 toContain | PASS |
| B2 六维计数一致 | 「按六维度对抗式核对清单」在场 + not「五维度」+ ①-⑥ 标记逐个在场 | PASS |
| B3 designer 防下放指引 | 「归 root spec 声明并标」/layer: "topic"/只在集成跑一次/不得复制回归条目/双付 + 第 0 步建子指令锚（fx-3 R5.2 既有） | PASS |
| B4 drift 对齐 | 源码全文 not「验收五规则」+ 三种新形态（「（src/gates/spec-rules.ts）」/「见 src/…」/「，src/…」）各自在场 + 渲染产物 not 数字形态 | PASS |
| B5 既有维度零变更 | ①-⑤ 逐维行原文 toContain（与改造前 brief.ts 逐字节同文）+ 分级约定 + 「核过无问题」+ 顺序断言 ⑤<⑥<语义关（插入不改既有段落位置）；mx5-3 侧其余 4 快照零改动（diff hunk 佐证）+ 全量 toBe 绿 | PASS |

### 回归

全量 npm test 78 文件 608 用例绿——u3 / u2 / mx5-3 / al-2 / u5b 零翻红（定向 + 全量双重实跑）。

## 5. 真实性抽查（防空洞断言）

- **T1 文案要素**：真实 CLI 实证（探针 A2b）——stderr 全文含条目 id、split 为空、集成执行点、永不被执行、两个恢复方向、已知边界句。非空洞。
- **W1/W2 分流**：探针 A5 实证叶子文案（上收 + 收窄两方向 + 形态原文内嵌「无文件参数的全量 vitest run，原文 "npx vitest run"」）；W2 测试含负向断言防两文案同时出现。分流真实。
- **W6**：`toBe("")` 空串断言 + 注释阐明等价性依据（succeed 走 stdout）。锁定成立。
- **B5**：①-⑤ 行原文断言与改造前 brief.ts 逐字节同文（对照 5852c49 版 brief.ts 核对）；mx5-3 其余 4 快照 diff 零触碰；toBe 机器级比对全绿。
- **规则①-⑨零变更**：`git diff 5852c49 -- src/gates/spec-rules.ts` 删除行恰 5 行——4 行注释（头注释「五规则」计数 1 行、⑨ 注释收尾 1 行、函数 docstring 换行重排 2 行）+ 1 行 `return { ok: failures.length === 0, failures };`（扩 warnings）。全部 failures.push 文案行零删除零修改（不在 diff 中即逐字节未动）。builder 自报逐字证实。

## 6. 行为对抗抽查（8 组，真实子进程 + tmp + CW_HOME 隔离，探针已清理）

| # | 场景 | 结果 |
|---|------|------|
| A1 | 规则⑪词法边界 12 变体 | `pnpm vitest run` HIT / `yarn vitest run` HIT / `bunx vitest run` HIT / `npx vitest run --reporter=json` HIT（flag 非位置参数）/ `npm test` HIT / `npm lint` HIT（无 run 中缀）/ `npx vitest run src` MISS（位置参数）/ `vitest run tests/foo.test.ts` MISS / `npm run test:unit` MISS（script 名非恰）/ `npm test tests/foo.test.ts` MISS（script 后位置参数）/ `npx vitest` MISS（无 run 子命令）/ `npm vitest run` MISS（npm 不在 vitest 前缀白名单，注释明示「非合法调用形态不列」）——12/12 符合 §4.B 锁定形状 |
| A2 | ⑩与 fx-3 R5.1 两道防线咬合 | split 声明 ghost-child（子未创建）→ R5.1 handler 拦（「先 cw create --id」恢复文案，规则⑩ 0 次）；split 空 + topic 条目 → ⑩ gate 拦（R5.1 0 次）——⑩管 split 空、R5.1 管 split 有声明子缺失，正交无重叠无漏洞 |
| A3 | warnings 与 ok 正交 | 同一 spec ⑪命中（npx vitest run）+ ③缺口（e2e 缺 command）→ exit 1，rule③ 1 行、规则⑪ 0 行——fail 路径零 warning 混入（warning 只在 append 成功后打印） |
| A4 | 旧账本兼容 | 无 layer 键旧形态 spec → 入账 exit 0；status/tree/report 正常，status 输出零 layer 泄漏；消费面核实：fold.ts deriveStatus 只读 `specGate(spec).ok`（L136），warnings 无任何只读消费——结构性零新行为（al-2 L4 重放测试亦绿） |
| A5 | 输出时序 + 多条 warning | stderr 首行「spec 已入账（unit …）但规则⑪ 触发成本警告（入账不受影响）」先于规则⑪条目（行 1 < 行 2）；代码层账本 append（evidence-submit.ts L199）先于 warning 打印（L212）；stdout「已入账（specHash …，seq 5）」独立走 succeed；exit 0；幂等重提照打 warning 且仍 exit 0；两条命中（vitest 形态 + lint script 形态）逐条各出 1 条 warning |
| A6 | reviewer 第六维自由文本核验 | 真实渲染全文 13 项检查全 OK：⑥ 标题、「须追进脚本/别名内容看实际跑什么」、「wrapper 自限建议」、--max-workers、「唯一语义防线」、「按六维度」、①-⑤ 在场、无「五维度」残留、顺序 ⑤<⑥<语义关 |
| A7 | topic 条目⑪作用域豁免 | root（split 非空）spec 含 `type:"unit" + layer:"topic" + command:"npx vitest run"` 条目 → exit 0、规则⑪ 0 次——⑪不查 topic 条目（已归集成层），若实现误查会翻 |
| A8 | 已知边界（⑩对无子 root） | 无子 root + topic 条目 + split 空 → exit 1 规则⑩拒（T1 第二用例 + 探针 A2b 双证）——单 unit topic 不能声明 topic 层 |

## 7. 波后场景（验收基线 §7，对照设计 .tmp/design-acceptance-layering.md §3.1）

| 场景 | 实证 | 设计要素核对 |
|------|------|-------------|
| ① 失败路径 1：叶子 topic 拒入账 | 探针 A2b 真实 CLI exit 1 不入账 | 条目 id（T1）✓「split 为空」✓「没有集成执行点」✓「永不被执行（声明即真空）」✓ 两个恢复方向（上收 root spec 标 topic / 去 layer 按 unit 层）✓——设计 §3.1 失败路径 1 全要素命中，措辞润色不缺项 |
| ② 失败路径 2：叶子 npx vitest run warning 入账 | 探针 A5 exit 0 + 入账 + warning | 「spec 已入账…警告非拒绝」+ 形态事实（含原文命令）+ 叶子双价事实 + 两建议方向——设计失败路径 2 同构 |
| ③ 成功路径：root（子已建）topic 正常入账 | 探针 A7/A10 exit 0 入账无⑩无⑪ | root split 非空 + topic 条目过 gate |
| 外加：reviewer 任务书真实渲染 | A6 真实账本 + fold + writeBriefFile | 第六维在场（全要素）+ ①-⑤ 零变更 + 六维度计数一致 |

## 8. 其他核对

- **执行器零改动铁律**：改动集不含 `src/verify/` / `src/core/` / `src/readonly/` / `src/testrun/` / `src/runner/` 除 brief.ts 外任何文件（git status 佐证）。✓
- **u3-acceptance.md**：追加「规则口径追加」一节（⑩⑪ 两行表 + 文案要素句），与 fx-1/rv-2/mx-2/mx5-1 先例同构，授权范围内。✓
- **AGENTS.md**：仅 spec gate 行九→十一规则（⑩⑪ 一句话口径），单行改动。✓
- **CONTEXT.md**：「spec gate 九规则」词条 → 十一规则（①-⑪ 全文，与实现一致——形态 A/B 描述逐项对照 spec-rules.ts 实现无误）；al-2「验收层级（layer）」词条基线版本就无「al-3 交付」中间态注记（条件不成立，零改动，逐字节核对）。✓
- **types.ts**：仅 SpecRulesResult 追加 `warnings?: string[]` + 注释；AcceptanceLayer / AcceptanceItem.layer 零触碰。✓
- **evidence-submit.ts**：warning 打印点在账本 append 成功 + 附件落盘之后、succeed 之前；空 warnings 零输出（`if (warnings.length > 0)`）；gate fail 路径（L141-149）零改动。✓

## 9. 裁量观察（非 FAIL，交主 agent 终裁记录）

- **O1 CONTEXT.md 词条外三行 drift 连带**：L32（layer 字段区引用「见 spec gate 九规则」→十一）、L93（「不在九规则内」→「不在上述规则清单内」）、L171（命令表 evidence submit 行「过九规则」→「过十一规则…⑪ warning」）。基线 §3 字面授权范围是「spec gate 九规则词条更新」；但只改词条标题会留下三处指向不存在词条名的内部引用（文档自相矛盾），三行均为「九规则」字样的必要引用同步、无新语义注入。判定：合理裁量。
- **O2 规则⑪一条 command 只出一条 warning**（多形态叠加 break）：基线未锁定此行为，实现注释已说明理由（多形态叠加无增量信息）。合理裁量。
- **O3 W5 未负向覆盖 script 别名形态**（如 npm run test:unit 不命中）：测试只锁正向两例；verifier 探针 A1e 已补证 MISS。非缺口，记录备查。

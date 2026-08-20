# mx-4 验收报告：spec 打回代数预算放宽（默认 2 → 10，可配置）

> verifier 对抗式独立验收，2026-08-19。验收基线：commit `19f2382`（mx4-acceptance.md）。
> builder 因配额中断于自验汇报前，工作区残留即交付；主 agent 初核全绿——本报告全部命令由 verifier 独立重跑证实。

## 0. 总结论：PASS（附 findings 3 项，交主 agent 裁决）

| # | 严重度 | 发现 | 位置 |
|---|--------|------|------|
| F1 | major | 红性验证组二不红：断开 loop 的 computeFrontier maxSpecRejects 传参后全部测试仍绿——dispatch 侧停派的 flag 参数化链路无测试防护（行为已分叉而测试不察，详见 §5.2） | `src/runner/loop.ts:355-368`（被测链路）/ `tests/mx3-generation-count.test.ts:292-294`（相对计数断言形态） |
| F2 | minor | `--max-spec-rejects 0.5` / `2.5` / `1e2` 被 minimist 数值强转后静默放行（非正整数），escalation 文案出现「预算 0.5 代」。验收 §4 列举三态（0/-1/abc）已正确拒绝，且与 `--max-idle-ms` 既有解析模式一致（条款自我限定「模式对齐」），但与「正整数 ≥1」总纲矛盾 | `src/handlers/run.ts:194-219`（parsePositiveIntFlag number 分支） |
| F3 | minor | mx1 T2 形态②从 `distIt` 改为裸 `it`，丢失「dist 缺席时 it.todo」守卫（验收交付物表未授权此基建变更；影响仅限 dist 缺席场景该用例报错而非跳过） | `tests/mx1-independent-review.test.ts:444` |

PASS 依据：验收文档 §2 交付物、§3 禁改、§4 口径、§5 D1-D5 条款、§6 命令全部满足；行为对抗抽查 13/13 证实（含 verifier 独立构造）；红性组一充分（6 红）。F1 不推翻条款满足性（D2 条款字面断言已满足、dispatch 侧行为正确性由探针证实），但构成测试强度缺口，建议主 agent 裁决是否要求补强。

## 1. 防篡改

| 检查 | 结果 |
|------|------|
| 基线 commit | `19f2382` = `git rev-parse HEAD`（builder 未 commit，工作区改动即交付） |
| `git diff 19f2382 -- docs/rewrite/acceptance/mx4-acceptance.md` | 空 |
| mx4-acceptance.md sha256 | `3449d664edfc576b92d56f24ffc81c253b2bd050aed8b3092d530591523c71d1` |
| 越界扫描（`git status` + `git diff 19f2382 --name-status`） | 仅领地 7 文件：`src/readonly/frontier.ts`、`src/handlers/run.ts`、`src/runner/loop.ts`、`tests/mx4-reject-budget.test.ts`（新）、`tests/mx3-generation-count.test.ts`、`tests/mx1-independent-review.test.ts`、`tests/u1b-status-frontier.test.ts`——与领地清单完全一致，无越界 |
| §3 禁改清单 diff（src/verify/、src/gates/、src/testrun/、src/store/、src/core/、src/runner/{integrate,worktree,human-loop,brief}.ts、src/runner/spawn/、src/handlers/{create,evidence-submit,review-submit,verify}.ts、src/cli.ts、src/dispatch.ts、docs/、archive/） | 全空 |
| 语义锁定①：`specReviewFailCounts` 函数体 | diff 无该函数 hunk，零变更（同代多 fail 计 1 代、重提不清零、只认 role=reviewer 保持） |
| 语义锁定②：`flakeReviewFacts`（rv-5 连挂 2） | 函数体无 hunk；diff 中仅 computeFrontier docstring 注释提及，零逻辑变更 |
| 语义锁定③：`INTEGRATION_MAX_CONSECUTIVE_FAILS = 1`（rv-4） | `src/runner/integrate.ts` 不在改动文件列表，零变更 |
| 事件 schema | `src/events/types.ts` 未动，零变更 |

## 2. 命令实跑（§6，全部 verifier 独立重跑）

| 命令 | 结果 |
|------|------|
| `npm run check` | exit 0 |
| `npm run check:tests` | exit 0 |
| `npx vitest run tests/mx4-reject-budget.test.ts tests/mx3-generation-count.test.ts tests/mx1-independent-review.test.ts tests/u5b-loop.test.ts tests/u7-loop.test.ts` | 5 文件 49 用例全绿（Duration 49.49s） |
| `npx eslint src/readonly/frontier.ts src/handlers/run.ts src/runner/loop.ts tests/mx4-reject-budget.test.ts` | exit 0，零输出 |
| 全量 `npx vitest run` | 64 文件 475 用例全绿（Duration 150.12s） |

定向组尾部：

```
 Test Files  5 passed (5)
      Tests  49 passed (49)
```

全量尾部：

```
 Test Files  64 passed (64)
      Tests  475 passed (475)
```

## 3. 条款对照（§5 D1-D5 逐条语义核验——防空洞断言）

| 条款 | 断言强度核验 | 判定 |
|------|--------------|------|
| D1 默认 10 | 9 代 → `frontier --json` 无 deadlock + 有 specFixPending；10 代 → deadlock 出现 + 默认配置 runner escalation 含「已打回 10 代」「预算 10 代」「转人工」+ 第 10 代意见在场。直写真实账本 + 真实子进程，分叉两侧（9/10）都断言。非空洞 | 满足 |
| D2 flag 参数化 | flag=2 → escalation「已打回 2 代」「预算 2 代」；同账本默认 runner → 等「派 designer」文案出现 + 1.5s 后 stderr 无转人工文案。runner vs 只读分叉另由 mx3 G2/G3 迁移断言（frontier 默认口径 not.toContain + specFixPending）补全。断言真实子进程全链 | 满足（dispatch 半链的防护缺口见 F1，不属条款字面要求） |
| D3 校验三态 | `0` → exit 1 + flag 名 + 「正整数」+「恢复动作」+「默认 10」；`-1`（minimist 拆解为裸 flag true）→ exit 1；`abc` → exit 1 + 原文回显 `--max-spec-rejects "abc"`；`1` 合法 → 真实 runner 1 代即转 + escalation「预算 1 代」 | 满足（非整数形态缺口见 F2，不在条款列举三态内） |
| D4 只读默认 | 5 代 → 文本视图 `specReviewDeadlock:\n  (无)` + `specFixPending:\n  demo` + `--json` 同口径 | 满足 |
| D5 常量锚 | `expect(SPEC_REVIEW_DEADLOCK_FAILS).toBe(10)`——import 断言单一事实源；src↔dist 一致性由 D1 走 dist 子进程的行为断言背书 | 满足 |
| 既有迁移 | mx3 G2/G3/G4 注入 `--max-spec-rejects 2` + 只读断言改默认口径 + 注释标注「mx4 迁移」；mx1 T2 形态②注入 flag 2 + assertDeadlock 只读断言改默认口径；u1b computeFrontier 直传 `maxSpecRejects: 2` | 满足 |

diff 审读补充（§2 交付物逐项）：frontier.ts 常量 2→10、注释按要求重写（MF2 活锁语义保留 + 放宽依据补入 + 「取 2 而非 3+」旧理由删除）、`computeFrontier` opts 增 `maxSpecRejects?`（缺省回落常量）、模块头/维度注释「≥2」→「≥ 阈值（默认 10）」同步——全部落实。run.ts flag 解析复用 `parsePositiveIntFlag`（与 --max-idle-ms 同源）、RunLoopOptions 传参、帮助文本（文件头 + 缺 --root 文案）同步。loop.ts RunLoopOptions 类型、computeDispatchTargets 传参、escalation 文案动态化（「已达打回代数预算 M 代」+ 已打回 N 代）、启动日志含 `max-spec-rejects=N`、assertPositive 恢复动作文案补 flag 名——全部落实。cli.ts 无 run flag 帮助面（帮助文本唯一来源在 run.ts，禁改约束下无遗漏）。

## 4. 行为对抗抽查（verifier 独立构造脚本，真实子进程 + tmp + CW_HOME 隔离，零 mock，不复用 builder 测试 helper）

抽查 1-4 为任务书规定项，P5 为扩展。构造方式：verifier 自写 `/tmp` 探针脚本，dist 产物 `EventLedger` 直写账本 + `node dist/cli.js` 真实子进程。

| # | 场景（verifier 设计） | 预期 | 实测 |
|---|----------------------|------|------|
| P1a | 9 代打回（verifier 构造，逐代 SpecSubmitted→fail）→ frontier --json | 无 deadlock、有 specFixPending | PASS |
| P1b | 追加第 10 代 → frontier --json | deadlock 取代 specFixPending | PASS |
| P2a | 3 代打回账本，只读 frontier（无 flag 概念） | specFixPending（恒默认 10） | PASS |
| P2b | 同账本 `cw run --max-spec-rejects 2`（human） | escalation 转人工，文案「已打回 3 代」+「预算 2 代」 | PASS |
| P2c | escalation 后 ≥5 轮 poll 新派发计数 | 停派（0→0） | PASS |
| P2d | 同账本默认 runner（不设 flag） | 派 designer 修 spec、2s+ 无转人工文案 | PASS |
| P3a | flag=3 + 3 代 | 转人工，文案含「已打回 3 代」「预算 3 代」（预算数值可被人工读出） | PASS |
| P3b | flag=4 + 3 代 | 不转（3 < 4 分界正确） | PASS |
| P4a | flag=1 + 1 代 | 首代即转（最严模式合法），「预算 1 代」 | PASS |
| P4b | flag=1 + 0 代打回（有 spec 无 fail） | 不误转（预算 1 不凭空触发，正常派 reviewer） | PASS |
| P5a | `--max-spec-rejects 2.5` | 应 exit 1（正整数） | **FAIL→F2**：被 minimist 数值强转（2.5 → number 2.5）绕过 `/^\d+$/` 校验，静默进入循环（探针 90s 超时 SIGTERM，code 143） |
| P5b | `--max-spec-rejects 1e2` | 应 exit 1 | **FAIL→F2**：同上，解析为 100 放行 |
| P5c | `--max-spec-rejects 0.5` + 1 代 | 应 exit 1 | **FAIL→F2**：放行为 0.5，escalation 文案出现「已达打回代数预算 0.5 代」；行为上 `failCount >= 0.5` ⇔ ≥1（首代即转，语义静默取 ceil） |
| P5d | `007` + 7 代 | （宽容行为记录） | 解析为 7，7 代 ≥ 7 转人工——前导零宽容，无危害 |
| 对照 | `--max-idle-ms 2.5`（基线既有模式） | — | 同样放行（「超过 2.5ms 无账本进展」）——证明 F2 是 parsePositiveIntFlag 既有宽松面的继承，非 mx-4 新引入逻辑；mx-4 按条款「模式对齐 --max-idle-ms」复用 |

## 5. 红性验证（两组，字节级还原）

### 5.1 组一：常量还原 2（充分红）

刀法：`src/readonly/frontier.ts` 的 `SPEC_REVIEW_DEADLOCK_FAILS = 10` → `2`（python 精确替换），`npm run build` 后跑 `tests/mx4-reject-budget.test.ts`。

结果：**6 红 3 绿**——D5（常量锚）、D1×2（9 代不转 / 10 代转）、D2（flag 分叉）、D3 的 `0` 态（错误文案「默认 10」）、D4（5 代不误报）全红；仍绿的 3 条为 D3 的 `-1`/`abc`/`1`（与默认值无关，理应绿）。红性分布与条款语义一一对应，无空洞。

### 5.2 组二：断开 loop 的 computeFrontier 传参（不红——F1）

刀法：`src/runner/loop.ts` 三处（computeFrontier 调用删 `maxSpecRejects,`、computeDispatchTargets 签名删参、runLoopMain 调用点删实参——noUnusedParameters 约束下须同步删以过 build），常量保持 10，`npm run build` 后跑 mx4 + mx3 两文件。

结果：**16 用例全绿，0 红**——未达任务书预期（「D2 的 flag 分叉断言红」）。

根因（verifier 行为探针证实）：knife2 下 dispatch 行为确实分叉——同一 2 代 + flag=2 场景，builder 版 dispatch 派发 0 次（specReviewDeadlock 组不生成 target），knife2 版派发 1 次 designer（computeFrontier 回落默认 10 → specFixPending 派 designer），随后该 spawn in-flight 触发 mx-1 S1 派发 gate 缓派。而 mx3 G2 的停派断言是**相对计数**（escalation 出声时刻的计数 vs 1.2s 后计数，`tests/mx3-generation-count.test.ts:292-294`）：knife2 版那次错误派发发生在 before 快照之前/同时，之后被派发 gate 冻结 → before == after → 断言绿；builder 版 before=0 after=0 同样绿。两种实现同绿 = 断言对「dispatch 侧是否用 flag 预算停派」不敏感。D2 自身只断言 escalation 路径（runLoopMain 的 specFails 循环，不经 computeFrontier）与默认路径，故也不红。

影响评估：当前实现行为正确（P2c 探针证实停派成立）；缺口在未来回归防护——若重构中 computeDispatchTargets 丢参（正是 knife2 模拟的事故形态），测试全绿溜过，行为分叉为「escalation 出声的同时仍派 designer」的矛盾信号。

### 5.3 还原与终态

- 组一恢复时 verifier 发生一次操作事故：误用 `git checkout -- src/readonly/frontier.ts`，将文件恢复到 HEAD（基线态，常量 2）而非 builder 未提交交付版。已通过 red 验证前记录的完整 diff（`git apply`，修正一处转写笔误后成功）+ loop.ts python 逆向替换精确重建。
- 终态校验：`git diff 19f2382 \| shasum -a 256` = `55db1861b39be03a91d2ceaf6a58185ff81b7bafd328259d9a65801fb0e0316b`、`git status --porcelain \| shasum -a 256` = `e7f148f2265c4a766b88028b47fa575baab8c00c12c4f84ae0ca0f2a26c4652a`——与红性验证开始前完全一致（字节级还原）；mx4-acceptance.md sha256 复核不变。还原后 rebuild + 定向复跑 16/16 绿。
- verifier 未做任何 git 写操作（无 add/commit/push）；探针脚本均在 /tmp，仓库唯一写入 = 本报告。

## 6. 结论

- 防篡改：通过（基线 diff 空、sha256 已录、无越界、禁改清单全空、三项语义锁定零变更）
- §6 命令：全绿（check / check:tests / 定向 49 / eslint 零输出 / 全量 475）
- §5 D1-D5：全部满足，断言非空洞（红性组一 6 红背书）
- 行为对抗抽查：任务书 4 项规定项全过 + 扩展项揭示 F2
- 红性验证：组一充分红；组二不红（F1，major，测试强度缺口）

**总结论：PASS（附 F1 major / F2 minor / F3 minor 三项 findings，交主 agent 裁决：F1 建议要求补 dispatch 侧停派的绝对计数断言或明确接受缺口；F2 建议后续 unit 收口 parsePositiveIntFlag 的整数字面校验；F3 建议恢复 distIt 或在 ledger 备注）。**

---

## 复审附录：F1/F2/F3 修复针对性复审（2026-08-19，第二轮 verifier）

> 范围仅限三项修复的证实与回归，不重复全量验收。复审起始指纹：`git diff | shasum -a 256` = `39a2dcf79b97c0a582ee3181a1b2fd3a56be6e0592ced0c2fa479f3b4b56dc56`（mx-4 首验交付 + 修复增量的合并态；复审核对的正是该指纹在复审全程零漂移）。

### 复审结论：PASS 维持（F1/F2/F3 三项修复全部证实）

### 1. 修复 diff 逐项证实

| Finding | 修复声明 | diff 证实 | 判定 |
|---------|----------|-----------|------|
| F1（major） | mx4 D2 与 mx3 G2 停派断言升级绝对计数（`countDispatches(...) === 0`，≥5 轮 poll 窗口） | `tests/mx4-reject-budget.test.ts:283-292`（escalation 后 1.2s 等待 + `countDispatches(flagged, "demo")).toBe(0)`，附断言 message「dispatch 侧同样吃注入预算」）；`tests/mx3-generation-count.test.ts:289-294`（同形态，删除原 before/after 相对计数）。注释均写明相对形态的时序掩盖根因 | 证实 |
| F2（minor） | `Number.isFinite` → `Number.isInteger`（NaN/Infinity 仍拒、1e2→100 保留） | `src/handlers/run.ts:212` 单行核心变更 + 注释同步；D3 新增三用例：`0.5/2.5 → exit 1`（mx4 测试 :364）、`1e2 合法 + 启动日志 max-spec-rejects=100 + 2 代不转`（:375）、`--max-idle-ms 0.5 → exit 1`（:391） | 证实 |
| F3（minor） | mx1:444 恢复 `distIt`（内容零变更） | `tests/mx1-independent-review.test.ts:444` 为 `distIt(...)`（守卫定义在 :62），用例正文仅注释与 `--max-spec-rejects 2` 迁移注入（首验交付已有），dist 缺席场景恢复 it.todo 守卫 | 证实 |

越界扫描：修复增量仅触及声明四文件（`src/handlers/run.ts`、`tests/mx4-reject-budget.test.ts`、`tests/mx3-generation-count.test.ts`、`tests/mx1-independent-review.test.ts`），全部在首验领地 7 文件之内。其余三文件（`src/runner/loop.ts`、`src/readonly/frontier.ts`、`tests/u1b-status-frontier.test.ts`）的 diff 与首验报告 §3 描述的交付内容逐项吻合、无修复理由的额外改动；硬证据：`src/runner/loop.ts` 当前 sha256 = `c7c8a4fefbc91936e752c2bce318c00ed584e782ecf14f557b466ef08115e9e5`，与 builder 自证红性的还原指纹前缀 `c7c8a4fe` 精确吻合——loop.ts 自 builder 红性还原后零字节改动。

### 2. 红性验证（verifier 独立复做 F1 红性）

刀法：备份 loop.ts → python 按行删除三处 `maxSpecRejects` 传参（L358 computeDispatchTargets 签名 / L365 computeFrontier 调用内 / L1331 runLoopMain 调用实参），escalation 侧（specDeadlockEscalationMessage 及 runLoopMain 的 specFails 循环）完整保留——精确复现 F1 事故形态（escalation 出声但 dispatch 侧回落默认 10）→ build 过 → 跑 mx4 + mx3 两文件。

结果：**2 红 17 绿**，红形态与任务书预期逐字一致：

```
mx-4 D2 ... → deadlock 停派 = 全程零派发（dispatch 侧同样吃注入预算）: expected 1 to be +0  (mx4-reject-budget.test.ts:292)
mx-3 G2 ... → deadlock 停派 = 全程零派发（dispatch 侧同样吃注入预算）: expected 1 to be +0  (mx3-generation-count.test.ts:300)
```

`expected 1 to be +0` = 断开后 dispatch 侧确实误派 designer 恰 1 次、被绝对计数断言捕获——F1 的测试强度缺口已闭合（首验时同刀法 16 用例全绿溜过）。其余 17 用例绿（escalation 侧未断开，D1/D3/G3/G4 不应红），红性分布正确。

还原：`cp` 备份回填 + sha256 前后比对 = `c7c8a4fefbc91936e752c2bce318c00ed584e782ecf14f557b466ef08115e9e5`（字节级一致）→ rebuild → mx4 + mx3 复跑 **19/19 绿**。

### 3. 命令实跑（复审轮）

| 命令 | 结果 |
|------|------|
| `npx vitest run tests/mx4-reject-budget.test.ts tests/mx3-generation-count.test.ts tests/mx1-independent-review.test.ts` | 3 文件 29 用例全绿 |
| 全量 `npx vitest run` | 64 文件 **478** 用例全绿（首验 475 + 修复新增 3 用例，数量吻合） |
| `npm run check` / `npm run check:tests` | 均 exit 0 |

### 4. 行为对抗（verifier 独立探针，/tmp 脚本，真实子进程 + CW_HOME 隔离，零复用 builder helper，19 项全 PASS）

| # | 场景 | 实测 |
|---|------|------|
| A | `--max-spec-rejects 0.5` / `2.5` 真实 CLI | 均 exit 1，stderr 三要素齐全：`cw run: 非法 --max-spec-rejects "0.5"：须为正整数（代）。恢复动作：如 --max-spec-rejects 3；省略则用默认 10。` |
| B | `--max-spec-rejects 1e2` 真实 runner | 启动日志含 `max-spec-rejects=100`（书写形态强转、量级整数保留）；无误转人工 |
| C | `--max-idle-ms 0.5` → exit 1 三要素；`--max-idle-ms 9000` 同 flag 整数 | 0.5 拒（`--max-idle-ms` + 正整数 + 恢复动作）；9000 正常启动 + 日志 `max-idle=9000ms`——同 flag 整数值不受收紧影响 |
| D | 回归面：`abc` / `0` / `-3` | 仍 exit 1（isInteger 收紧未放松既有拒绝面） |

### 5. 防篡改与终态一致性（复审轮复核）

- `git diff 19f2382 -- docs/rewrite/acceptance/mx4-acceptance.md` 空；sha256 = `3449d664edfc576b92d56f24ffc81c253b2bd050aed8b3092d530591523c71d1`（不变）
- 复审结束 `git diff | shasum -a 256` = `39a2dcf79b97c0a582ee3181a1b2fd3a56be6e0592ced0c2fa479f3b4b56dc56`、`git status --porcelain` 文件集与复审开始完全一致（红性 knife 的临时改动字节级还原；仓库唯一写入 = 本附录）
- 无 git 写操作；探针脚本均在 /tmp 并已清理

### 6. 改判

**总结论：PASS 维持。** F1（major）经绝对计数断言 + verifier 独立红性（2 红、expected 1 to be +0 形态）证实闭合；F2（minor）经 isInteger 收口 + 双侧行为对抗（拒面/合法面）证实闭合；F3（minor）distIt 守卫恢复证实。无新增 findings。

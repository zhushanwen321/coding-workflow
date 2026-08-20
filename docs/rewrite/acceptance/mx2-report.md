# mx-2 验收报告（verifier 独立对抗验收）

> 验收对象：pytest + playwright 适配器 + 框架显式声明路由（builder 交付 M4-mx-2）
> 验收基线：commit `6eb88c2af25c952a75c7fb6ea41556651fd8375f` 的 `docs/rewrite/acceptance/mx2-acceptance.md`
> 验收日期：2026-08-18；verifier：独立 subagent（未参与开发，builder 自报逐项实证）
> 环境：macOS darwin 24.6.0 arm64、node v24.11.1、python3.12.10 + pytest 8.3.0、playwright 1.62.1 + chromium（全真实验收）

## 1. 防篡改核对

| 检查项 | 结果 |
|--------|------|
| `git diff 6eb88c2 -- docs/rewrite/acceptance/mx2-acceptance.md` | 空（0 行） |
| 工作区 sha256 | `a5d4d2779a4db65e47660fa5bfd5ea66cccc66f4bb56ad9425c854f51a53ade5` |
| 基线 commit 内 sha256 | `a5d4d2779a4db65e47660fa5bfd5ea66cccc66f4bb56ad9425c854f51a53ade5`（一致，无篡改） |

## 2. 领地与越界扫描

mx-2 领地内改动（与验收文档 §2 交付物一一对应，无缺漏）：

- 修改：`src/events/types.ts`（+`AcceptanceItem.runner?: string`）、`src/testrun/registry.ts`（注册 pytest/playwright + `knownAdapterTypes()`）、`src/verify/run.ts`（`adapterTypeFor(type, runner?)` + 调用点透传 + hint 抑制）、`src/gates/spec-rules.ts`（规则⑧）、`src/handlers/spec-schema.ts`（typebox 可选 `runner`）、`tests/u5-e2e-sh.test.ts`（验收#8 扩容适配，既有断言 vitest/e2e-sh 保留，增量断言 pytest/playwright）
- 新建：`src/testrun/pytest.ts`、`src/testrun/playwright.ts`、`tests/mx2-pytest.test.ts`、`tests/mx2-playwright.test.ts`、`tests/mx2-runner-routing.test.ts`

越界扫描结论：

- 工作区其余改动（`src/handlers/verify.ts`、`src/verify/{red-phase,contract-match}.ts`、`src/runner/{loop,integrate}.ts`、`src/readonly/frontier.ts`、`tests/rv4*`、`tests/u4b*`、`tests/u8*`、`tests/fx2*`、`tests/rv3-contract-match.test.ts`、`tests/u1b-status-frontier.test.ts`、`tests/wt4-integration-merge.test.ts`）均在 rv-4 领地或其连锁适配范围；grep 确认后三个测试文件 diff 不含任何 runner/pytest/playwright/adapterType/knownAdapter 内容——mx-2 builder 无越界证据。
- `docs/rewrite/acceptance/rv5-acceptance.md`（untracked）为主 agent 预写的下一 unit 验收文档，非 builder 产物。
- 禁改清单核实：`src/testrun/{vitest,e2e-sh,types}.ts`、`src/verify/{checkout,name-match}.ts`、`src/cli.ts`、`src/dispatch.ts`、`src/core/`、`src/store/`、`docs/`（除本报告）、配置文件零改动；`TestRunAdapter`/`EvidenceReport` 接口零变更；事件 schema 除 `runner` 可选字段外零变更。

## 3. 通过命令实跑（验收文档 §6）

| 命令 | 结果 |
|------|------|
| `npm run check`（tsc --noEmit） | 通过（rv-4 中途态未导致类型挂） |
| `npx vitest run`（mx2 三文件 + u5-vitest + u5-e2e-sh + u4a-verify + u5b-loop） | 7 文件 79 测试全绿（mx-2 新增 30：pytest 8 + playwright 8 + routing 14） |
| `npx vitest run`（u5*/u4a* 全量 6 文件） | 55 测试全绿；**u4a-e2e 与 u5b-e2e 当前实测全绿**（派发时所述 rv-4 中途态 2+1 红已被 rv-4 后续推进消化——验收期间 rv-4 builder 并行修改了 u4a-e2e/u5b-e2e 等测试文件，实测时点即修改后版本，与 mx-2 无关） |
| `npx eslint src/testrun/ src/verify/run.ts src/gates/spec-rules.ts src/handlers/spec-schema.ts src/events/types.ts tests/mx2-*.test.ts` | 干净（0 error 0 warning） |

## 4. 条款对照表（T1-T9）

| 条款 | 测试位置 | verifier 独立复测 | 结论 |
|------|---------|------------------|------|
| T1 真实 pass/fail 判定 | mx2-pytest「T1 真实通过/失败判定」 | 独立构造 1 pass + 1 真实断言失败项目真实跑：cases=2（1 pass 1 fail）、exitCode=1、nameMatch 命中 | PASS |
| T2 翻译幂等与纪律 | mx2-pytest「T2」4 测试 | 独立复测 7 形态幂等 + `.pytest_cache` 产生/不产生对照真实跑 + `--tb=short --tb=no` 双 flag 后值覆盖实测（无 E 行 traceback） | PASS |
| T3 无区分力防线 | mx2-pytest「T3」3 测试 | echo 假命令（exit 0 零条目）抛错含恢复动作；真实空项目 exit 5 → 单条 fail case；真实 `@pytest.mark.skip` → fail + nameMatch false | PASS |
| T4 真实通过/失败判定 | mx2-playwright「T4」 | 独立真实跑（chromium headless）：cases 2（1 pass 1 fail）、exitCode=1 | PASS |
| T5 翻译与名字比对 | mx2-playwright「T5」3 测试 | 独立复测幂等 3 形态；层级拼接 name 含 file suite title（`flaky.spec.ts > flaky suite > A9 flaky case`）；词边界命中（A10/A9） | PASS |
| T6 形状防线 | mx2-playwright「T6」4 测试 | 独立复核 `{}` 抛错（顶层缺 suites）；vitest JSON 抛错；`test.skip()` → fail + nameMatch false；零 result + exit 0 抛错 | PASS |
| T7 显式优先 | mx2-runner-routing「T7」4 测试 | 独立复测四组合：`("unit","pytest")→pytest`、`("e2e-real","playwright")→playwright`、`("e2e-mock","pytest")→pytest`、`("integration","playwright")→playwright`，且 registry 全集可解析闭环 | PASS |
| T8 推导兜底回归 | mx2-runner-routing「T8」4 测试 | 纯函数逐 case + **HEAD bundle vs 工作区 dist 全链等价性实证**（见 §5-⑥） | PASS |
| T9 规则⑧ | mx2-runner-routing「T9」6 测试 | 独立复测：`jest`/`PYTEST`/`Pytest`/`""` 全被拒，消息含合法值清单 `[vitest/e2e-sh/pytest/playwright]` + 恢复动作 + 验收 id + 原值；4 合法值通过；缺省不触发；typebox 非字符串类型拒绝 | PASS |

## 5. 对抗抽查记录（6 组，全部真实子进程 + tmp + 环境隔离；脚本在 /tmp/cw-mx2-adv/，本节为输出摘录）

### ① pytest 边界行形态对抗（ENTRY_RE 放开尾部后是否误吞）

21 个单行用例全部符合预期：

- 命中（8）：`test_a.py::test_x PASSED [ 50%]`（pass）、`FAILED [100%]`（fail）、`SKIPPED (reason: no db)`（fail）、`XFAIL (strict)`（fail）、`XPASS (strict)`（fail）、`ERROR [ 50%]`（fail）、纯净行 `PASSED`（pass）、`PASSED\t尾注`（pass）
- 不命中（13）：`my test PASSED`（无 ::）、`PASSED alone`（无前缀）、`passed lowercase`、`test_a.py::test_x PASSED_EXTRA`（状态词后必须空白/行尾，`_` 不被吞）、`test_a.py::test_x`（无 STATUS）、`==== 2 passed, 1 failed in 0.1s ====`（summary）、`FAILED test_a.py::test_x - assert`（失败详情段）、`E       AssertionError: boom`（traceback）、`这是文档字符串里的中文输出 PASSED`、`中文说明 PASSED 更多中文`、`README.md::test PASSED`（非 .py）、`a b.py::test_x PASSED`（\S+ 不含空格）
- 多行混合噪声（pytest 头部 + 中文字符串 + 条目行 + FAILURES 段 + summary）：仅命中 2 条目行

### ② pytest exit code 分档对抗（真实 python3 -m pytest）

- 全过 → exit 0，cases=1 全 pass
- 1 败 → exit 1，cases=2（1 pass 1 fail）
- collect 错误（`import nonexistent_module_xyz`）→ exit 2（pytest collection error 档），cases=1 fail（条目行 `test_p.py::test_x ERROR` 命中）——exit≠0 统一 fail 语义正确
- 空项目（仅 conftest.py）→ **exit 5**，零条目行 → 单条 fail case `{name:"no-results", status:"fail"}`，不抛错
- echo 假命令 → exit 0 零条目 → 抛错，消息含「恢复动作」+ pytest 命令提示 + runner/type 路由提示

### ③ playwright flaky 重试与多 project 折叠（真实 npx playwright test + chromium）

- 真实 flaky（文件计数器：首败重过，retries:1 workers:1）：进程 exit 0、stats.flaky=1、test.status="flaky"、results=`[{failed,retry:0},{passed,retry:1}]` → 适配器折出 cases=`["fail","pass"]` 两条、nameMatch=false（M0 不认 flaky，重试后绿也不能逃逸验收）
- 同 spec 双 chromium project：tests=2 实例（每 project 一条）、各 1 result passed → cases=2 条同名全 pass、nameMatch=true（多 project 全过才过）
- 附带发现：playwright 隔离模式下模块级变量不跨 attempt 保留（需文件系统计数器才能构造 flaky）——fixture 经验，非产品问题

### ④ translate 幂等对抗

- pytest：空 command 默认全量；含 `-v` 只补余二；含 `--tb=no` 只补余二；含 `-p no:cacheprovider` 只补余二；全含原样返回；`--verbose` 长形式不追加 `-v`（includes 语义，`--verbose` 含子串 `-v`，长形式等价）
- `--tb=short --tb=no` 并存实测：argparse 后值覆盖，无 traceback 输出——translate 追加 `--tb=no` 对已含其他 `--tb=` 的 command 仍达预期效果
- playwright：已含 `--reporter=json` 原样；缺则追加；组合形式 `--reporter=json,line` 视为已有不追加；空 command 默认全量

### ⑤ 路由与规则⑧组合对抗

- `adapterTypeFor("unit","PYTEST")` 原样返回 `"PYTEST"`（确定性查找，不静默纠正）→ registry 无此项 → `runOne` 走「路由不到适配器」fail 分支显性暴露（真实 runAcceptances 全链实测）
- 规则⑧：`PYTEST`/`Pytest`/`""`/`jest` 全拒（消息含合法值清单、大小写敏感说明、恢复动作、验收 id、原值）；`pytest`/`e2e-sh` 等合法值通过；无 runner 不触发
- `adapterTypeFor("unit","")` → `"vitest"`、`("e2e-real","")` → `"e2e-sh"`（空串按未声明走推导）；空串在 spec 提交时被规则⑧拦——两道防线互补
- `runner:"e2e-sh"` + `type:"unit"` 真实执行：runAcceptances 用 e2e-sh 适配器跑 unit 型验收，marker 命中 pass（组合不限定，行为自洽）
- `knownAdapterTypes()` 顺序 `[vitest,e2e-sh,pytest,playwright]`（registry keys 派生，单一事实源）

### ⑥ 无 runner 输入的行为等价性（builder 声明「与 HEAD 逐字节一致」核实）

方法：`git archive 6eb88c2` 解包 HEAD 源码到 /tmp，esbuild bundle HEAD 的 `runAcceptances`，与工作区 dist 的 `runAcceptances` 对同一组**无 runner** fixture 各跑全链：

- fixture：e2e-real 有标记（pass）/ e2e-real 无标记（fail，e2e-sh 无区分力错误）/ unit 非 vitest JSON（fail + vitest hint）/ unit 真实 vitest 子进程 / manual（跳过）
- 结果：5 条 results 的 `{id,status,timeout,commandExit,parseError}` 全等；`reason` 归一化 tmp 路径后**字节级相等**（含 A3 的 vitest hint 全文一致——无 runner 时 hint 照常附加）；report.json 除 stderrSha256（原始 stderr 字节含各自 tmp 路径，hash 必异——归一化 stderr 内容后一致）外全等
- 补充：无 runner + 真实 vitest id 命中 → HEAD=pass CUR=pass（exitCode 同）；runner 显式声明（pytest）+ 非 pytest 产物 → parse 抛错路径的 reason **不含** vitest hint（对照：同输入无 runner → hint 附加）——builder 的 hint 抑制声明双向实证

## 6. 四处「验收文档 vs 实测」冲突的独立裁决

### 裁决 1：pytest 行格式放开尾部——**合理**

- 实测证据：pytest 8.3.0 `-v` 真实输出 `test_p.py::test_shape PASSED                                             [100%]`——STATUS 后有空格 padding + `[NN%]` 进度标记；SKIPPED/XFAIL 带 `(reason)` 尾注。验收文档正则的行尾 `$` 锚对实测输出**零命中**（若按文档实现，所有真实 pytest 验收必然落入零条目防线全部抛错）。放开尾部是功能正确性的必要修正。
- 误吞对抗：§5-① 的 21 个边界用例（含中文 docstring、print 输出、warning/traceback 行、summary、状态词边界）全部正确判定；行首 `<file>.py>::` 锚 + 状态词完整词约束使放开尾部不引入误吞。
- 残余理论风险：构造行 `test_a.py::test_x PASSED FAILED` 会取第一个状态词判 pass——真实 pytest 输出无此形态，无实际影响。
- 影响面（若判不合理才会发生）：无——实现与实测一致。

### 裁决 2：playwright status 词表按 result 级——**合理，「判定语义等价」声明成立**

- 实测证据：playwright JSON 同时含两级词表——test 级 `tests[].status`（expected/unexpected/flaky/skipped/interrupted）与 result 级 `results[].status`（passed/failed/timedOut/skipped/interrupted）。四个真实数据点全部满足折叠关系：
  - expected ⟺ results=`[passed]`（双 project 稳定用例 ×2）
  - unexpected ⟺ results=`[failed,failed]`
  - flaky ⟺ results=`[failed(retry:0), passed(retry:1)]`（真实构造）
  - skipped ⟺ results=`[skipped]`（mx2 测试 T6）
- 等价性论证：「expected ⟺ 全部 result 通过」在全部观测点成立；result 级实现（仅 `passed` 算过）与 test 级实现（仅 `expected` 算过）对同一 JSON 判定相同。result 级的增量价值：flaky 折出 `[fail,pass]` 两条，保留首次失败事实（比 test 级 `flaky→fail` 更如实），且 nameMatch 结论一致（fail）。
- 影响面：仅当 playwright 未来在 expected test 下产出非 passed result 时两实现分歧——未观测到，理论风险。

### 裁决 3：playwright name 拼接（suite 路径 + spec title）——**合理**

- 实测证据：`tests[]` 是同一 spec 在各 project 的实例（双 project run：同 spec title 下 2 个 test 实例、各 1 result）——spec.title 即用例标题，test 级无独立 title 语义。
- 折叠语义：同 spec 多 project → 多条同名 case（如 `flaky.spec.ts > multi suite > A10 stable case` ×2），任一实例 fail 即 nameMatch fail——多浏览器/多配置全过才算过，语义正确。
- 词边界命中：验收 id 出现在任一层级文本（file title / describe / spec title）即命中，分隔符 `" > "` 非词字符天然词边界（A9/A10 实测命中）。
- 影响面：无。

### 裁决 4：T3 零测试项目 exit 5——**合理，两个分支防线语义均真实成立**

- 实测证据：真实空 pytest 项目（仅 conftest.py）→ pytest exit **5**（no tests ran），非文档假设的 exit 0。「exit 0 + 零条目」在真实 pytest 生态不存在，须以假命令构造。
- 分支 1（exit≠0 + 零条目 → 单条 fail case `no-results`）：真实空项目实测成立——exit≠0 已具区分力，如实 fail 不抛错，对齐 e2e-sh「标记缺失 + exit≠0」家族语义（验收文档 §4 只锁定 exit 0 分支，此分支是家族语义的自然延伸，未违反锁定口径）。
- 分支 2（exit 0 + 零条目 → 抛错）：echo 假命令实测成立，消息含恢复动作与路由提示——防线目标场景（防「命令空转也 pass」）覆盖。
- 影响面：真实空项目用户看到的失败信息是「验收未出现在产物」（nameMatch 层）而非适配器错误（parse 层）——指引性稍弱，但判定方向正确（fail，不放过），可接受。

## 7. builder 自报逐项证实

| 自报 | 证实 |
|------|------|
| 2 新适配器（pytest/playwright） | 是（§2 领地核对 + 全部实测） |
| registry knownAdapterTypes | 是（顺序 vitest/e2e-sh/pytest/playwright，registry keys 派生） |
| AcceptanceItem.runner 字段 | 是（可选 + 注释含合法值来源/显式优先/规则⑧唯一入口） |
| adapterTypeFor(type, runner?) | 是（非空优先原样返回，空/缺省走推导） |
| 规则⑧ | 是（合法值清单 + 恢复动作 + 大小写敏感 + 缺省不校验） |
| spec-schema 同步 | 是（Type.Optional(Type.String())，非字符串类型被拒） |
| 3 测试文件 30 测试全绿 | 是（8+8+14=30，79 绿的子集） |
| vitest parse 失败 hint 在 runner 显式声明时不再附加、缺省逐字节不变 | 是（§5-⑥ 双向实证：显式不附加 / 无 runner 字节级一致） |
| u5-e2e-sh 验收#8 扩容适配 | 是（2→4 + 增量断言，既有断言保留） |

## 8. 观察项（非阻断，不构成 FAIL）

1. **minor**：playwright translate 幂等用 `includes`（文档锁定的「同 vitest 模式」）——`--reporter=json,line` 组合形式视为已有不追加，该组合的 stdout 是 line+json 混合文本，`JSON.parse` 会失败（parse 抛错带恢复动作兜底）。模式系验收文档明示沿用，不算缺陷；后续如收紧可改 token 精确匹配。
2. **minor**：`runner:""` 的双处语义——规则⑧拦截（空串不在合法集合）但 `adapterTypeFor` 把空串当缺省走推导。绕过 gate 直调 verify 的路径上空串会静默走推导且 hint 被抑制（hint 条件是 `ac.runner === undefined`，与 `adapterTypeFor` 的 `runner !== ""` 判定不一致）。实际链路 spec 提交是唯一入口，空串在 gate 已被拒，不可达；仅记录一致性瑕疵。
3. **观察**：pytest 适配器 case 的 `name` 记条目行原文（含 `[NN%]` 尾注）——nameMatch 词边界匹配验收 id 在 `file::test` 部分，尾注无影响。

## 8.5 验收期间工作区并行变化说明

验收进行中，rv-4 builder 并行推进，`tests/u4a-e2e.test.ts`、`tests/u5b-e2e.test.ts`、`tests/fx4-topic-artifacts.test.ts`、`tests/u7-e2e.test.ts`、`tests/wt5-parallel-contamination.test.ts` 新进入修改状态（验收启动时的 git status 无此五项）。复核结论：mx-2 领地全部文件（5 改 + 2 新适配器 + 3 新测试）的 diff stat 与关键内容在验收期间零变化（ENTRY_RE/PASSED/knownAdapterTypes 逐行核对一致）；mx-2 三文件复跑仍 30/30 绿。上述五文件均为 rv-4 领地连锁适配，不影响本报告结论。

## 9. 总结论

**PASS**

- 防篡改基线完好（diff 空 + sha256 一致）；mx-2 领地干净、无越界、禁改清单零触碰。
- 验收文档 §6 通过命令全绿（check / vitest 79+55 / eslint）。
- T1-T9 全部条款 PASS（测试 + verifier 独立复测双重证实）。
- 6 组对抗抽查全部通过，四处「文档 vs 实测」冲突独立裁决均为**合理**（均有真实子进程实测证据支撑）。
- 无 runner 输入的行为等价性（回归锁）在语义层与 reason 字节级实证成立。

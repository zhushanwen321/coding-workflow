# rv-2 验收报告：engine 小修包（verifier 对抗式独立验收）

> 验收人：verifier subagent（独立于 builder，自报全部待证实后实证）。
> 验收基线：commit 9023076 的 `docs/rewrite/acceptance/rv2-acceptance.md`（防篡改锁定文件）。
> 验收时间：2026-08-18 19:30-19:50（与 rv-4 builder 并行，中途态干扰已逐一归因，见 §6）。
> **总结论：PASS**（无 critical/major 发现；2 条建议级记录，不阻断）。

## 1. 防篡改与越界扫描

| 检查 | 结果 |
|------|------|
| `git diff 9023076 -- docs/rewrite/acceptance/rv2-acceptance.md` | 空（未篡改） |
| 验收文档 sha256 | `ec8ca4e623764bda5661cf3d2c12657069e0cc9a61a18445f4fd7919f33dfcbf` |
| 验收时 `git rev-parse HEAD` | `539371c` |
| 工作区变更范围 | 精确限定 rv-2 领地：7 个 src + `tests/rv2-engine-fixes.test.ts`（untracked）+ 5 个打回修复测试（fx4/u2-review/u5b-e2e/u7-e2e/wt5） |
| 基线以来其他 diff 归属 | 全部来自主 agent 已 commit：rv-1（3256bcf：loop/spawn/lifecycle/rv1 测试）、rv-3（1bbbf4d：contract-match/rv3 测试/u8）、docs（539371c 等） |

7 个 rv-2 src 文件在 `git diff 9023076 HEAD` 下均为 0 行差异（rv-1/rv-3 commit 未触碰），即工作区改动 100% 归属 rv-2 builder。

越界归因记录（非 rv-2 builder 产物，不扣分）：

- 验收期间（19:39 后）`git status` 新增 rv-4 领地工作区修改：`src/handlers/verify.ts`（红阶段默认接线）、`src/runner/integrate.ts`、`src/verify/contract-match.ts`、`src/readonly/frontier.ts`——rv-4 builder 并行开发中途态。
- untracked `docs/rewrite/acceptance/mx2-acceptance.md`、`rv5-acceptance.md`：并行 wave 待 commit 基线（验收文档属主 agent 职责），非 rv-2 交付。

## 2. 命令实跑记录

| 命令 | 环境 | 结果 |
|------|------|------|
| `npx vitest run`（rv2/u2×2/u3/u4a×2/u5×2/u5b/fx4，§6 指定范围） | 真仓库 19:36 | 10 文件 91/91 通过 |
| `npx vitest run tests/wt5-parallel-contamination.test.ts tests/u7-e2e.test.ts` | 真仓库 19:37 | 2 文件 4/4 通过 |
| `npx eslint`（7 src + rv2 测试） | 真仓库 | 零输出通过 |
| `npm run check` | 真仓库 | 1 错误，归因 rv-4 中途态（见 §6） |
| `tsc --noEmit`（HEAD + 仅 rv-2 文件，rv-4 中途态剥离的干净副本） | /tmp/rv2-check | 零错误 |
| `vitest run`（同干净副本：rv2/u2×2/u3/u4a×2/u5×2 → 81/81；u5b/fx4 → 10/10） | /tmp/rv2-check | 全绿 |

## 3. 条款对照表

| 条款 | 要求 | 证实方式 | 结论 |
|------|------|----------|------|
| T1 规则⑦拦截 | `TC 1`/`中文用例`/`.开头` 拒且消息含字符集说明；`A_1`/`TC.1`/`a-b` 过 | rv2 测试 3 用例 + 对抗 AD1 补边界（`-a`/`_x`/纯分隔符 `---...___`/空 id/首尾空格拒；连续分隔符 `A..1`/`a__b`/`X--1` 合法）与常量逐条一致 | PASS |
| T2 marker 同源 | `TC.1 PASS`/`a_2 FAIL` 正确折叠；`TC 1 PASS` 不匹配 | rv2 测试 + T2 三路同源对照（8 id corpus）+ 对抗 AD2（`A1.2 PASS` 命中；双空格/`A1 .2`/行尾空格不命中走无标记防线） | PASS |
| T3 exec-review 必填 | 无 refs fail 含 runId 清单；带真实 runId 成功 closed；不存在 runId 既有校验不回归 | rv2 测试 6 用例（dispatch 层）+ 对抗 AD4（`""`/`","`/`" , "`/`"  "` 四形态等价缺失全拒） | PASS |
| T3b 方案 C 四条 | 内部节点引用 VerifyRan runId 通过 closed；无 refs 清单 verify/集成分列；两类并存；扩展集存在性校验 | rv2 测试 4 用例 + 对抗 AD3 补「fail VerifyRan 引用」两态探针（builder 测试未覆盖此形态，见 §4②） | PASS |
| T4 replan 文案 | 不含 replan、含 cw create 恢复路径 | rv2 测试（dispatch 层，断言不含 `replan`、含 `cw create`/`不可逆`/`恢复动作`） | PASS |
| T5 parse 落盘 | `{parseError: true, commandExit: 真实 exit, reason}`；正常条目不受影响 | rv2 测试（exit 0 与 exit 3 两变体非硬编码）+ 对抗 AD7（exit 42 第三变体） | PASS |
| T6 子目录 verify | 子目录不再 clone 失败；非 git 报错含恢复动作 | rv2 测试（pkg/deep 子目录全链 pass；非 git exit 2 且无 VerifyRan 入账）+ 对抗 AD5 补 git worktree 态（cwd 的 git 根 ≠ 主仓库根，全链 pass） | PASS |
| T7 回归 | 旧 marker 集超集；既有套件绿 | rv2 测试（旧 id 形态原样识别；legacy id 过 gate；判定语义不变）+ §2 命令全绿 | PASS |
| 打回修复① fx4 | exec-review 补 refs | diff：`run-t5-1`（上方已入账 build runId），测试过 | PASS |
| 打回修复② u7-e2e | performHumanStep 补 refs | diff：`run-<unitId>-1`（与 build 分支命名一致），测试过 | PASS |
| 打回修复③ wt5 | 运行时从账本读真实 runId | diff + 实跑（见 §5 裁决 3） | PASS |
| u5b-e2e / u2-review 适配 | 必要断言适配，禁改语义禁删测试 | u5b：两处 exec-review 补真实 build runId；u2-review：「无可选字段」用例载体 exec-review→spec-review——原用例前提（exec-review 可无 refs）被本次交付合法消灭，payload 键省断言语义在新载体保持，exec-review 无 refs 行为由 rv2 T3 锁定。属 §2 授权的必要适配 | PASS |

## 4. 三项重点裁决（独立结论）

### 裁决 1：正则剥锚派生——符合「等价构造」授权，PASS

- 事实核实：`ACCEPTANCE_ID_RE.source` 含 `^$` 锚，按验收文档 §2 示例内嵌会产出 `^(^[A-Za-z0-9][A-Za-z0-9._-]*$) (PASS|FAIL)$`——分组内 `$` 断言后随 `) `，非行尾恒不匹配，marker 全军覆没。文档示例确有 bug，builder 的判定正确。
- 等价性：剥锚 `replace(/^\^/, "").replace(/\$$/, "")` 后构造的 MARKER_RE 与文档目标字面量 `/^([A-Za-z0-9][A-Za-z0-9._-]*) (PASS|FAIL)$/` 语义完全一致（字符集主体仍单点来自常量，无手写漂移）；行为级由对抗 AD2 证实（`A1.2` 命中、双空格/`A1 .2`/行尾空格不命中）。
- 锁定充分性：三层——T1 锁常量语义（非法/合法形态字面）、T2 三路同源对照（同一 id corpus 上常量 ⟺ gate 规则⑦ ⟺ marker 识别结论一致，防任一路手写漂移）、T7 锁旧合法集超集（向后兼容）。充分。
- 建议级记录（不阻断）：剥锚对「常量未来含多重锚/字符类内 `^$`」的理论脆弱性——e2e-sh.ts 已留注释锚定原因，风险可控。

### 裁决 2：方案 C 语义扩展——复核通过，三个子点均无实质问题

- ①与 §4「例外面为零」一致。该口径的语义是「没有绕过必填的后门」（无跳过 flag、空串等价缺失——对抗 AD4 四形态实证全拒），方案 C 改的是「什么算合法证据」的类型集（EvidenceSubmitted ∪ VerifyRan），未开任何后门。反向看：原字面「只认 EvidenceSubmitted」使内部节点（集成只写 VerifyRan）exec-review 必填但永无可填——那是死锁不是严格。扩展是合法证据类型完备性修正，非例外。
- ②引用 fail 的 VerifyRan runId：refs 校验确实不区分 `result`（对抗 AD3 构造 A 实证：spec-frozen unit 引用唯一 fail VerifyRan → exit 0 入账）。但这不构成新作弊面：fold 的 `closed = verified ∧ exec-review pass`，而 `verified` 需要一条 **pass** 的、覆盖全部验收 id、seq 晚于当前 spec 的 VerifyRan（fold.ts:143-171）。构造 A 中 exec-review pass 入账后状态仍 `spec-frozen`（未 verified → 不 closed）；构造 B（verified unit 引用另一条 fail runId）closed 成立，但 closed 的证据前提由 pass VerifyRan 独立保证，引用仅是指向已入账执行记录的指针——与引用 build 证据对称（EvidenceSubmitted 无成败校验，任意 runId 均可先 `evidence submit` 再引用，扩展前后作弊面等价）。真正防线在 fold verified 闸门，方案 C 未削弱它。
- ③「不区分前缀」决策边界合理：`integrate-` 前缀是 runner 层（`src/runner/integrate.ts`）实现约定，handlers 层按前缀过滤会跨层耦合命名约定（前缀改版即静默破坏 refs 合法性）；VerifyRan 事件自带 unitId 归属，按 unitId 收集是 schema 级稳定口径。
- 建议级记录：T3b 未覆盖「引用 fail VerifyRan」形态（fold 兜底使其风险≈0，本次由 AD3 补证），建议后续以 `[BUG-HUNT]` 风格补一条锁定测试固化「fail runId 可入账但不可致 closed」的分层语义。

### 裁决 3：wt5 fixture 诚实性——真实，PASS

- 代码事实：reviewer 角色运行时 `cw status --unit <id>` → 逐行定位 `verifyRuns:` 段 → 取最后一条 `- runId=` 值后引用。与 `src/readonly/status.ts` 真实输出格式（段头 + `  - runId=<id> result=...`）逐字匹配，无硬编码 runId；子进程 `console.log(... refs <lastRunId>)` 留痕可审计。
- 防线真实：`verifyRuns:` 段缺失（fixture 破损）与 runId 解析为空（refs 无从引用）两个分支均显式 `throw`，wt5 测试真实并行子进程环境（真仓库 19:37 + 干净副本）实跑通过——解析逻辑实际工作而非纸面防线。
- 转义核实：`split("\\n")` 位于生成 `wt5-worker.mjs` 的模板字符串内，落盘后为真实换行转义，非字面反斜杠 bug（同文件 `anchor + "\\n" + markerLine` 同理）。

## 5. 行为对抗抽查记录（18/18 通过，/tmp/rv2-adv 隔离目录，真实 dispatch/账本/git/子进程）

| # | 对抗点 | 预期 | 实测 |
|---|--------|------|------|
| AD1a | 空格 id 且 core 非 e2e（manual） | rule② 与 规则⑦ 同时列出（不短路） | 通过 |
| AD1b | 开头字符（`.dot`/`_under`/`-dash`/中文）、纯分隔符（`---`/`...`/`___`）、空 id、首尾空格拒；连续分隔符（`A..1`/`a__b`/`X--1`/`a.b-c_d`）与单字符（`9`）合法 | 与 ACCEPTANCE_ID_RE 逐条一致 | 通过 |
| AD2 | `A1.2 PASS` 命中；`A1.2  PASS`（双空格）/`A1 .2 PASS`（id 内空格）/`A1.2 PASS `（行尾空格）不命中走无标记防线；`P3 PASS` 对照命中 | 如左 | 通过 |
| AD3-A | spec-frozen unit 仅 fail VerifyRan，exec-review pass 引用其 runId | 入账成功但 fold 仍 spec-frozen（verified 闸门兜底不 closed） | 通过 |
| AD3-B | verified unit（pass VerifyRan 在账）另跑 fail VerifyRan，引用 fail runId | closed（closed 证据前提由 pass VerifyRan 保证） | 通过 |
| AD4 | `--evidence-refs ""` / `","` / `" , "` / `"  "` | 四形态等价缺失全拒（exit 1） | 通过 |
| AD5 | 仓库子目录 / git worktree 内（git 根 ≠ 主仓库根）/ 非 git 目录 | 前两者全链 pass；后者 exit 2 含恢复动作与 .git 指引 | 通过 |
| AD6 | spec-review 无 refs exit 0；显式带不存在 refs 仍被既有校验拒 | 可选语义零回归 | 通过 |
| AD7 | parse 失败 commandExit=42 变体 | report.json 落 `commandExit: 42`（非硬编码） | 通过 |

## 6. 并行归因：`npm run check` 单错误的因果链

真仓库 `npm run check` 报 `src/runner/loop.ts(392,5): TS2322: Type 'Contract[]' is not assignable to type 'readonly OwnedContract[]'`。归因（证据链）：

1. `loop.ts` 与 `red-phase.ts` 无任何工作区修改（`git diff` 为空，代码即已 commit 状态）。
2. `src/runner/integrate.ts` 存在 rv-4 builder 未提交修改，其中 `runIntegrationVerify` 签名由 `contracts: Contract[]` 改为 `contracts: readonly OwnedContract[]`（integrate.ts:104）——rv-4 领地交付目标（f8aaa0c baseline「contract pairing」）。
3. loop.ts:392 调用点未同步适配 → TS2322。全程仅此一条 tsc 错误。
4. 干净副本（`git archive HEAD` + 仅覆盖 rv-2 的 13 个工作区文件）`tsc --noEmit` 零错误、vitest 91/91 全绿——**rv-2 交付自身完整通过 §6 全部通过命令**。

同因连带记录：对抗抽查 AD5 首轮两例失败，根因是 rv-4 工作区修改将红阶段 verify 从 opt-in（HEAD 中 `--red-phase` 显式开启）改为默认执行 × 我的 fixture 用恒真 echo 验收（被判「无区分力」属红阶段正确行为）；修正 fixture 区分力后全绿，与 rv-2 交付无关。

## 7. 总结论

**PASS**。rv-2 全部交付物（T1-T7 + T3b + 打回修复三处）经 verifier 独立实证成立；防篡改与领地约束零违反；两项重点裁量（剥锚派生、方案 C）复核通过；`npm run check` 的唯一错误干净归因于 rv-4 builder 并行中途态。建议级记录 2 条（§4 裁决 1 剥锚脆弱性注释、裁决 2 的 T3b fail-runId 锁定测试），均不阻断验收。

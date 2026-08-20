# rv-4 验收报告：红阶段默认接线 + 集成失败处置改进 + 契约配对化

> verifier 独立对抗验收。基线：f8aaa0c 的 rv4-acceptance.md（锁定文件，sha256 见下）。
> 验收对象：工作区未提交改动（HEAD = edae57f，mx-2 committed 后的真实工作区）。
> 结论先行：**PASS**（附 2 个 minor 偏差记录，均不构成 FAIL；四项裁量全部裁决为可接受）。

## 1. 防篡改与越界扫描

- `git diff f8aaa0c -- docs/rewrite/acceptance/rv4-acceptance.md` → **空**（未篡改）。
- 验收文档 sha256：`24f76f4bd5aa32ca19977b8694703c47241c4ae5bb2d720c7e3b3d05e38b5ffd`
- 基线 commit：`f8aaa0c767c38d63aabe0320082da485c47bc91e`；验收时 HEAD：`edae57f52d5220455253c665cba0d8b6977f55e2`
- 复审前工作区 diff 基线（`git diff edae57f | sha256`）：`ffa41d31ef00b9f04b0290bbee2be9dfd208011866205b7c540e2a5fc89d558b`；红性验证后复算**逐字节一致**（见 §6）。
- `git diff edae57f --stat` 越界扫描：src 恰好 6 个文件（verify.ts / red-phase.ts / contract-match.ts / loop.ts / integrate.ts / frontier.ts），全部在 rv-4 领地；§3 禁改清单文件（src/runner/spawn/、worktree.ts、spec-rules.ts、其余 handlers、events/types.ts、core/fold.ts、testrun/、store/、verify/{run,checkout,name-match}.ts、docs/、archive/、配置）**零触碰**——MAX=1 只改 frontier.ts 常量，fold.ts 未动，属实。
- 测试改动 14 个文件（builder 自报 12，差额为 u1b-status-frontier / fx4-topic-artifacts——均为必要迁移且在验收文档 §2「等既有」开放范围内，非越界、非删测试）。3 个新测试文件在领地。`docs/rewrite/acceptance/rv5-acceptance.md` 未跟踪（主 agent 预写，豁免）；AGENTS.md / DESIGN-LOG.md 当前无工作区改动（doc-1 领地豁免）。

## 2. 通过命令实跑（验收文档 §6）

| 命令 | 结果 |
|------|------|
| `npm run check` | 通过（无输出） |
| `npm run check:tests` | 通过（无输出） |
| `npx vitest run tests/rv4-*.test.ts tests/u4b-{e2e,red-phase}.test.ts tests/u8-*.test.ts tests/fx2-integration-recovery.test.ts tests/fx3-{loop-split-dispatch,spec-split-gate}.test.ts` | **11 文件 / 52 测试全绿**（27.65s） |
| `npx eslint src/handlers/verify.ts src/verify/red-phase.ts src/verify/contract-match.ts src/runner/loop.ts src/runner/integrate.ts src/readonly/frontier.ts tests/rv4-*.test.ts` | exit 0 |
| **全量 `npx vitest run`** | **58 文件 / 428 测试全绿**（99.97s），无 mx2 中途态错误 |

全量真实总数口径：tests/ 当前恰 58 个 .test.ts（edae57f 时点 55 + 3 个 rv4 新文件，无删除；archive/tests 57 个按 vitest.config 排除）。AGENTS.md「801 个测试」为过时数字（其自身注明「以实跑为准」），与本 unit 无关。

## 3. 条款对照（T1-T9）

| 条款 | 结论 | 证据 |
|------|------|------|
| T1 恒真必死 | PASS | 测试绿（默认无 flag exit 1 + redPhase discriminative:false + stderr 恒真说明）；CLI 级独立抽查 ① 复现；红性：还原 opt-in 后默认路径用例红 |
| T2 正常测试过 | PASS | 测试绿（redPhase 逐条 discriminative:true + --red-phase 同义幂等 + 总是入账）；红性确认默认路径有判别力 |
| T3 无父 commit 跳过 | PASS | 测试绿；CLI 级抽查 ③：单 commit exit 0 + 两条机器验收均 skipped:true + stdout「A1 跳过」 |
| T4 首 fail 即 drift | PASS | 测试绿（恰 1 次集成 fail + designer 派发 + frontier --json integrationDrift 含 root、integrationReady 不含）；红性：MAX→2 后该测试红（失败点 = `toHaveLength(1)` 行） |
| T5 merge 冲突入任务书 | PASS | 测试绿；integrate 直调抽查 ⑥：mergeFailures 含冲突子 unitId + root worktree 路径；brief 含冲突原文 |
| T6 人工窗口不销毁 | PASS | 测试绿（WIP 文件存在 + 内容逐字节一致 + porcelain untracked 保留 + 恰 1 次集成 + spec-frozen）；断言强度 minor 观察见 §7 |
| T7 配对漂移拦截 | PASS | 测试绿（一字差 fail + 两侧归一化文本 + 对照证明 fail 只来自配对道）；integrate 直调抽查 ⑤ 复现（含 owner/provider 语境） |
| T8 无 provider 声明 | PASS | 测试绿（provider 集缺失 / 同 id 缺位两形态） |
| T9 一致过 + self-provider | PASS | 测试绿（空白归一化等价过、provider=owner 跳过配对、同 id 多 owner 任一命中、空契约） |

## 4. 迁移测试核对（14 文件逐 diff 审读）

| 文件 | 迁移性质 | 「rv-4 语义迁移」注释 | 断言内核 |
|------|---------|---------------------|---------|
| u4b-red-phase | standalone 废除→三道并列；无父 commit exit 2→合法跳过 | 有（5 处） | 区分力判定内核保留，仅入账/skip 断言随语义反转且正确 |
| u4b-e2e | --red-phase 同义 + 总是入账 | 有 | 判定断言保留；VerifyRan 1→2 条随新语义 |
| fx2-integration-recovery | MAX=2→1；fixture leaf 补冻结同 id 契约（fail 仍来自签名漂移） | 有（回归 1/2/3/4 各处） | 重派语义反转正确；处置链路/计数清零/closed 全链内核保留（fail,fail,pass→fail,pass） |
| u8-e2e | 契约违背路径走 drift 处置链路 | 有 | fail 留痕 + 修复 + closed 全链保留；无 builder spawn 断言保留 |
| u8-integrate / u8-contract-match / rv3-contract-match | OwnedContract 输入形态；树内语义不传 frozenByUnit | 有 | 断言全部原样（仅输入包 owned()）；rv-3 零回退锚点成立 |
| u1b-status-frontier | MAX 注释迁移（append 两条 fail 在 MAX=1/2 下同为 drift） | 有 | 断言原样 |
| wt4-integration-merge | mergeFailures 报告节 + 反向断言（报告 failures 不含 merge 文本） | 有 | 冲突/abort/分支保留断言原样 |
| u4a / u5b / u7 / wt5 / fx4 | 恒真 fixture 加 --no-red-phase 逃生口（5 处，与自报一致） | 有 | 各自锁定的链路语义断言原样 |

无删测试、无弱化断言内核；语义反转处注释齐备且方向正确。

## 5. 行为对抗抽查（真实子进程 + tmp git + CW_HOME 隔离，零 mock）

CLI 级（node dist/cli.js 子进程，16/16 通过）：
- ① 恒真全链：默认（无 flag）exit 1 + report redPhase `A1 discriminative:false` + stderr 含恒真防线说明与恢复动作；同链 `--no-red-phase` exit 0。
- ② 名字比对过仍被红阶段拦：`bash run-tests.sh`（脚本无条件 echo "B1 PASS"，patch 进父树后旧树也绿）→ 常规层 B1 pass、exit 1、stderr 含「无区分力」+「新测试在基线代码树」穿透专属文案——证明三道 gate 独立。
- ③ 单 commit 仓库：默认 verify exit 0，redPhase 两条机器验收均 `skipped:true` 且原因含「无父 commit」，stdout 摘要透明呈现。
- ④ 混合 manual：恒真机器验收照拦（exit 1），redPhase 条目集 = {A1,A2}、不含 manual M1。
- ⑧ flag 两序：`--red-phase --no-red-phase` → 关（exit 0）；`--no-red-phase --red-phase` → 开（exit 1，minimist last-wins）——§4 字面承诺被反序形态打破（裁决 2）。

integrate 直调（15/15 通过）：
- ⑤ 配对漂移：owner=root 契约与 owner=leaf 冻结版一字差（renderWidget/renderWidgets）→ integrate fail；聚合 failures 与报告 contracts.failures 均含「契约漂移」+ 两侧文本 + owner/provider 归属语境。
- ⑥ merge 冲突：双子改同一行 → mergeFailures 含冲突子 unitId（ub）+ root worktree 路径；返回值 failures（聚合视图）含 merge 文本、报告 failures 节不含（结构化分节）；恢复指引与 MAX=1 对齐；旧「集成将按新证据重试」文案全库清除。

⑦ MAX=1 残留审查（代码 + 行为双重）：`consecutiveIntegrationFails`（SpecSubmitted/pass 清零、fail +1）≥ 1 即 integrationDrift（designer、integration:false）；唯一回归 integrationReady 的路径是新 spec 提交或 pass 集成清零计数——fx-2 时代「第二次自动集成」无残留路径（fx2 回归 1 + rv4 T4/T5 行为级恰 1 次佐证）。

## 6. 红性验证（临时改动，已字节级还原）

| 临时改动 | 期望 | 实际 |
|---------|------|------|
| frontier.ts `INTEGRATION_MAX_CONSECUTIVE_FAILS` 1→2（rebuild 后跑 rv4-integration-disposal） | T4 红 | **T4/T5/T6 全红**（3 failed，失败点均在「恰 1 次集成」断言行 318/405/489；显式 flag 类用例不受影响） |
| verify.ts `redPhaseEnabled` 默认 true→opt-in（`=== true`） | T1 默认路径红 | **T1/T2/T3 默认用例全红**（3 failed），`--no-red-phase`/`--red-phase` 显式用例仍绿——精确证明「默认接线」是判别点 |

还原校验：两文件经备份回写后 `git diff edae57f | sha256` = `ffa41d31...558b`，与复审前基线**逐字节一致**；`npm run build` 通过；git status 24 项与复审前一致。

## 7. 四项裁决

1. **frozenByUnit 可选：可接受，无削弱。** 生产调用方全库仅 integrate.ts 一处（grep 确认），恒传入且由同一入参 contracts 按 owner 聚合还原（无第二数据源、无分叉口径）；不存在「真实路径省略导致漏配对」。可选语义是 rv-3 零回退锚点与 T7 对照证明（不传 = 只跑树内 → 证明主断言 fail 只来自配对道）的方法论必需，不是防线漏洞。
2. **flag 反序混写：可接受为已知边界（minor 偏差）。** 实测反序（`--no-red-phase --red-phase`）时 minimist last-wins 使红阶段保持开启，打破验收文档 §4「两者都出现以 --no-red-phase 为准」的字面承诺。但失败方向是「更严格」（多跑一道 gate），不会漏检恒真测试；且 flag 顺序信息在 minimist 折叠后已丢失，verify.ts 领地内不可修，修复点在 dispatch.ts（按机制应由主 agent 串行接线或后续 unit 处理）。建议后续补 flag 互斥校验；不构成 FAIL。
3. **failures 双视图：可接受。** `IntegrateResult.failures`（聚合 = mergeFailures + failures，含指引）服务 loop stderr 单清单消费；`IntegrateReport.failures/mergeFailures` 分节服务 drift 任务书逐节提取。两消费方各有测试锚定（loop stderr 断言、wt4 报告双断言、rv4 T5 brief 断言），旧重试文案已清除，行为实测两侧一致。minor 备注：两个同名 failures 字段语义不同（聚合 vs 非聚合），命名相似性有轻微混淆面，已在 integrate.ts 注释与 wt4 迁移注释中文档化。
4. **cli.ts HELP 未改：可接受。** HELP 中 verify 仅单行「verify 干净重跑验证（写）」，本就不含任何 flag 文案（--timeout-ms 同样不在），无「同步」对象；--no-red-phase 可发现性由 verify 缺参恢复动作、红阶段 fail stderr、builder 任务书三处保证。验收文档交付⑥的「帮助文案」实质落在 verify.ts 的 usage/错误文案（已同步），成立。

## 8. 次要观察（不阻塞）

- 自报口径误差：builder 自报「12 迁移测试」，实际 14 个测试文件有改动（u1b、fx4 未计入自报）。均为必要迁移、非越界，仅自报数量不准确。
- T6 的 WIP 形态是 untracked 新文件：对 `git clean` 类销毁检测有效，对 `git reset --hard` 还原 tracked 修改无感；但 reset 的风险路径（集成/merge 执行体）已被同文件「恰 1 次集成」断言封住，组合判定成立。后续若要更强可补 tracked 文件修改型 WIP。

## 9. 总结论

**PASS。** 验收文档 §2 交付逐项落实、§4 锁定口径全部兑现（除裁决 2 的反序混写字面边界）、§5 T1-T9 全部有真实判别力的测试且红性成立、§6 通过命令全绿、全量 428 测试无回退、防篡改与禁改清单零违反、临时改动字节级还原。

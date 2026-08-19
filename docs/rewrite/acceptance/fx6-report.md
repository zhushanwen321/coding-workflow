# fx-6 验收报告（verifier 独立验收）

> 验收对象：commit `ee1bbcb`（fix(runner): fx-6 minor cleanup），前置基线 `239537c`
> 基线文档：`docs/rewrite/acceptance/fx6-acceptance.md`（§1-§7 防篡改）
> 验收人：独立 verifier（轻量验收）｜日期：2026-08-20｜结论：**PASS（带 1 条 minor finding）**

## 总结论

**PASS**。防篡改 / 禁改 / 条款复跑 / X5 语义 / X3a / 偏离裁定 / 红性 / 静态复核全部通过。G1-G6 独立复跑全绿，红性抽查精确复现四跑异常-1 形态后恢复干净。1 条 minor finding（§findings F1：基线 §8 备案「lint warning 存量」失实，不影响通过判定）。

## 逐项判定

### 1. 防篡改 + 禁改 — PASS

- `git diff 239537c..ee1bbcb -- src/testrun/ src/verify/ src/gates/ src/events/ src/handlers/ src/core/ src/store/ src/readonly/ src/runner/spawn/ src/cli.ts src/dispatch.ts CONTEXT.md` → **空**。
- `fx6-acceptance.md` 变更仅 §8 status 一行（允许范围）；`docs/rewrite/acceptance/` 下无其他文件被改。
- 改动 6 文件与基线 §2 交付物表一一对应：`AGENTS.md`（X2）/ `src/runner/brief.ts`（X4）/ `src/runner/loop.ts`（X3+X5）/ `tests/u5b-e2e.test.ts`（X1）/ `tests/fx6-minor-cleanup.test.ts`（新建 §5 条款）/ acceptance §8 流转。

### 2. 条款复跑 — PASS

| 命令 | 结果 |
|------|------|
| `npm run check:all` | 通过（check + check:tests 零错误） |
| `npx vitest run tests/fx6-minor-cleanup.test.ts tests/rv5-flake-escalation.test.ts` | 2 文件 16/16 绿（fx6 8 + rv5 8） |
| 全量 `npm test` | 70 文件 551 用例全绿（132s，与 §8 交付声明一致） |
| `npm run lint` | exit 0（1 warning，见 F1） |

G6（rv5 套件零迁移 + 全量绿）确认：rv5-flake-escalation 8 用例原样通过，无迁移痕迹。

### 3. X5 语义审查 — PASS

- **flake 签名**：`flakeAnnounceSignature` = 排序 acceptanceId 集合 join；dedup map 按 unitId 键控 → 有效签名 = unitId + 集合。符合 §4。
- **contract 签名**：`contractAnnounceSignature` = 同款集合 + 代数二值档（`>= SPEC_CONTRACT_MAX_GENERATIONS ? "capped" : "under"`）。符合 §4「<上限 / ≥上限 只在跨越时变」。
- **spec 维度保持**：`announceManualEscalations` 第三循环完整消息文本比较原样（仅加注释显式声明「fx-6 X5 不改本维度」）；G3 回归通过。
- **消息文本零降级**：`flakeEscalationMessage` / `specContractDeadlockEscalationMessage` 函数体零改动（diff 确认），runIds 与恢复指引仍在；G1/G4 断言 `cw report --unit` / `nondeterministic` 在场。
- **签名与消息分离**：dedup map 只存签名串（`dedup.flake.set(unitId, signature)`），消息仅在重出时生成。
- **判定条件与派发排除零变更**：三个循环的过滤条件（subtreeIds / streaks.length / generations / failCount）原样；事实计算函数 `flakeReviewFacts` / `specContractFacts` / `specReviewFailCounts` 零改动；`computeDispatchTargets` 输入 = `announceManualEscalations` 返回值（L1379-1438），同源未重放。

### 4. X3a 审查 — PASS

- **结算行格式逐字节一致**：`settleFlightOutput` 的 emit 模板 `` `[runner] ${ISO} ${role} unit "${unitId}" 退出 ${describeExit(...)}` `` 与常规路径原模板逐字符相同（仅变量换绑，值同源）。
- **stopState 输入等价**：TIMEOUT 时传结算时刻重读账本（`new EventLedger(...).readAll()`），与原实现等价；非 TIMEOUT 时传入的 `events` 在函数内不被消费（条件判 TIMEOUT 为 false → null），行为等价。
- **收束行为零变更**：`reportSettledFlights` 位于收束分支 `killAll` 之前、`reclaim`/`emitExitOutput`/`return 0` 之前，顺序保持；SPAWN_ERROR → killAll → return 1 路径原样；未退出 spawn 等待 ≤ 一个空转 tick 后留给 killAll。
- **wait() 缓存主张核实**：`src/runner/spawn/lifecycle.ts:260` 与 `src/runner/spawn/human.ts:254` 均 `wait: () => (waitPromise ??= resultPromise)`，注释「已 settle 的 wait() 必先到达（微任务 vs sleep(0) macrotask）」主张属实。
- **X3 注释重复段删除**：`grep -c "verdict 的入账 ts 取自原始事件流"` = 1（原 2 次）。

### 5. X4 偏离裁定 — 成立（等义措辞）

- **mx5-3 套件零改动确认**：`tests/mx5-3-reviewer-brief.test.ts` 不在 commit 改动清单。
- **B2 锁定核实**：L138 `expect(content).toContain("恰为 json")`——基线建议句「--reporter 仅等号形态放行」不含该短语，照抄必打红 B2，偏离必要。
- **等义性**：实际措辞「规则⑨口径更严：仅等号形态 --reporter=json（值恰为 json）放行；空格形态 --reporter json 无论值一律拒」与 `src/gates/spec-rules.ts` L177-184 实现一致（等号形态且值恰 json 放行；空格形态无论值一律拒——mx5-5 S2），且比基线建议句更精确。
- **非残留澄清**：`src/runner/brief.ts:285` 仍有「与 spec gate 规则⑨同口径」——该处是 designer 回炉任务书的恢复指引标题（type 对照路由语义，指引内容与规则⑨口径一致），非 mx5-5 F1 锁定的 reviewer 清单括注，判定非残留。

### 6. 红性复验 — PASS（改后已恢复）

流程：flake 分支临时改回完整消息文本比较（`flakeEscalationMessage` + message 比较，4 行）→ `npm run build` → 跑 G1 → **红**：`expected 2 to be 1`，即 r3 追加导致重出、出声 2 次——精确复现四跑异常-1「连挂 runId 追加重出」形态。dist 版本核实（`dist/runner/loop.js` L734 为 message 比较、时间戳吻合），排除假红。随后 `git checkout -- src/runner/loop.ts` 恢复 → build 干净（TS6133 消失）→ fx6 全套 8/8 复绿 → `git diff` 零行、工作区干净（仅会话前既存 untracked `.tmp/`）。

### 7. G5 静态复核（grep 独立复跑） — PASS

- X1：`BUILDER_IMPL_DISPATCH_LINE` 在 `src/` + `tests/u5b-e2e.test.ts` 零残留（fx6 测试文件内命中为断言字符串本身）；`DEVELOPER_IMPL_DISPATCH_LINE` 在场。
- X2：`AGENTS.md` 无「≥2 转人工 / 累计 ≥2」残留；mx-1 段新口径在场（打回代数 ≥ 预算转人工——默认 10 代、`--max-spec-rejects` 可注入、mx-3 计数语义），且只改该段计数口径，其余历史记述未动。
- X3b：注释句恰出现 1 次。
- X4：新措辞在场；旧括注（含「cw 自动追加」后缀的完整串）零残留。

## 偏离备案裁定一览

| §8 备案 | 裁定 |
|---------|------|
| X4 措辞因 mx5-3 B2 锁「恰为 json」采用等义精确句 | **成立**（B2 断言核实 + 措辞与规则⑨实现一致且更精确） |
| G2 额外验证中间态（E1 计数增长不重出） | **成立**（对基线 G2 条款的增强断言，非语义偏离） |
| lint 1 warning 为 loop.ts max-lines 存量非本次引入 | **失实**（见 F1） |

## Findings

- **F1（minor，备案失实）**：基线 §8 声称 lint warning「为 loop.ts max-lines 存量非本次引入」——实测基线 `239537c` 版 `src/runner/loop.ts` 经 eslint（同项目 flat config）**零 warning**（exit 0 无输出）；当前 1038 > 1000（max-lines 口径 = 非空非注释行）为 fx-6 引入（loop.ts 物理行 1521 → 1599，净增 78）。lint 仍 exit 0，§6 通过命令不受阻，不改变 PASS 结论，但该备案陈述与事实不符，应更正为「本次引入的 warning」。
- **观察项（无需处置）**：收束路径 `reportSettledFlights` 对 TIMEOUT 结算的 stopState 基于本轮已读账本（常规路径为结算时刻重读），存在口径差异；代码注释已显式声明，且属基线 X3「收束行为零变更（只补打印行）」授权范围内的 cosmetic 补打印，非缺陷。

## 复跑环境

- 工作区：`feat-optimize-parallel-wave` @ `ee1bbcb`（验收后恢复零 diff）
- 红性改动全程未 commit / stash / push，源码已恢复

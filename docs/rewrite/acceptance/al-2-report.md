# al-2 verifier 验收报告：AcceptanceItem.layer 层级轴（纯声明模型层）

> verifier 独立验收，2026-08-22。对抗式：builder 自报逐项用真实命令与代码核实，未采信任何声明。
> 验收基线：commit `a8b5ed7` 的 docs/rewrite/acceptance/al-2-acceptance.md §1-§7（§8 为主 agent 流转区，不在验收范围）。

## 0. 总结论：**PASS**

全部条款证实（L1-L7 逐条见表 §5 对照表）；防篡改、越界扫描、四组命令实跑、真实性抽查、6 条对抗抽查、波后双账本对照全部通过。发现 1 处验收文档自身瑕疵（§7 措辞，见 §8）与 2 处测试形态备注（非失败项，见 §9）。

## 1. 防篡改

| 检查 | 结果 |
|------|------|
| `git diff a8b5ed7 -- docs/rewrite/acceptance/al-2-acceptance.md` | 空（0 行） |
| 验收文档 sha256 | `9518d08629abdbfee9a2f1c4b14e9044f52c2ec9bcc5d23e4f15999feced737b` |
| 验收时 HEAD | `a8b5ed76bdf11803fe64d548669134086d513551` |

## 2. 越界扫描

`git diff a8b5ed7 --stat` + `git status --porcelain` 全量核对，改动集：

| 文件 | 归属 | 判定 |
|------|------|------|
| `src/events/types.ts`（+20/-0） | al-2 交付 | 纯追加零删改 |
| `src/handlers/spec-schema.ts`（+8/-0） | al-2 交付 | 纯追加零删改 |
| `CONTEXT.md`（+5/-0） | al-2 交付 | 纯追加零删改 |
| `tests/al-2-layer-model.test.ts`（新增） | al-2 交付 | §2 列明 |
| `src/verify/run.ts`、`src/runner/spawn/lifecycle.ts`、`tests/al-1-nice.test.ts` | **al-1 并行豁免** | diff 内容逐行检查全为 nice 减震相关，零 layer 混入 |
| `docs/rewrite/acceptance/al-3-acceptance.md`（untracked） | 主 agent 预写豁免 | 在场不判 |

**禁改清单（§3）全部零改动**：`src/verify/`、`src/runner/`（除豁免的 lifecycle.ts al-1 领地改动）、`src/core/`、`src/readonly/`、`src/testrun/`、`src/gates/`、`src/store/`、`src/cli.ts`、`src/dispatch.ts`、`tests/` 既有文件（tracked 层面 tests/ 零改动）、AGENTS.md、docs/ 既有文档——`git diff a8b5ed7 --stat` 均未出现。执行器零分支铁律结构性满足（禁改文件未动）。**无越界**。

## 3. 命令实跑（限定范围）

| 命令 | 结果 |
|------|------|
| `npm run check:all` | 过（check + check:tests 双 tsc 零错误；`tsconfig.test.json` include `tests/**/*.ts` 确认 L7 编译哨兵真被编译） |
| `npx vitest run tests/al-2-layer-model.test.ts` | **7/7 绿**（6.44s，真实子进程） |
| `npx eslint src/events/types.ts src/handlers/spec-schema.ts tests/al-2-layer-model.test.ts` | 零输出干净 |
| 全量 `npm test` | **76 文件 590 用例全绿**，exit 0（与 builder 自报一致；含 al-1 并行中途态文件，无归因失败） |

## 4. §5 条款对照表（L1-L7）

| 条款 | 判定 | 证据 |
|------|------|------|
| L1 schema 合法值入账 | **证实** | 实跑绿：真实 CLI 提交 layer:"unit"/"topic" spec exit 0 入账，末 SpecSubmitted payload 各含 layer 键值正确；未声明条目不被注入（Object.hasOwn=false） |
| L2 schema 非法值拒 | **证实** | 实跑绿：layer:"root"/123 → exit 1 + stderr 含 `/acceptance/0/layer`（含索引路径）+ 账本不增（仍 1 条 UnitCreated） |
| L3 缺省不写键 | **证实** | 实跑绿：**原始 JSONL 行级断言真做了**（readFileSync 原文取 SpecSubmitted 行 → `not.toContain("layer")`，tests/al-2-layer-model.test.ts:296-301）+ parse 后对象 Object.hasOwn 双层断言 |
| L4 旧账本重放兼容 | **证实（按关键字段断言口径）** | 账本真实：CLI 产出的无 layer 事件流（3 事件，账本原文断言不含 layer——属验收文档允许的「旧 spec 构造的账本」路线）；三命令+--json 断言覆盖 unit 状态（spec-frozen）/验收覆盖（report `A1 e2e-real [core] ✗`、acceptance 长度）/事件数（totalEvents=3）+ 重跑逐字节稳定。「与基线一致」走文档允许的关键字段断言路线（非快照对照），真对照由 verifier 波后场景（§6）补做并证实 |
| L5 带 layer 账本只读健康 | **证实** | 实跑绿：spec-frozen 与改造前同形态、layer 键原样透传、三命令 exit 0 零崩溃 |
| L6 执行行为不变 | **证实** | 实跑绿：u-6a（topic spec）/u-6b（plain spec）双 unit 同命令，各 1 条 VerifyRan 真实入账（verifyRanOf 读账本断言），判定行 `["A1 pass","T1 pass"]` 相等、result/acceptanceIds 相等、T1.stdout 产物在场含标记行；spec gate 未拦 topic 条目（规则⑩未交付窗口）；红阶段首提交合法跳过与 `src/handlers/verify.ts:16-17` 代码事实一致 |
| L7 类型层编译锁定 | **证实** | 编译期 `AssertLayerEnumExact`（Equal 双向逐字符断言，export 类型别名被 check:tests 编译）+ 运行时 validateSpecFile 逐值探针（unit/topic 过、root/123 拒） |

## 5. 真实性抽查结论（防空洞四点）

1. **L4 对照法**：真实有效。账本由当前 CLI 按「旧 spec 形态」（无 layer 字段）构造，账本原文逐字节断言无 layer 键；断言覆盖状态/覆盖/事件数三要素而非仅"不炸"。「基线」= 改造前已知口径的关键字段值（spec-frozen/3 事件/全 ✗），非改造前产物快照——验收文档 §5 L4 明文允许「快照或关键字段断言」，取后者合规；结构性风险（改造后多输出字段）由 acceptance 条目层 `Object.hasOwn(layer)=false` 断言 + verifier 波后真对照（§6）双重封口。
2. **L6 双 unit 对照**：真实跑过。两 VerifyRan 入账、判定行过滤形态的 stdout 相等断言（`^(A1|T1) (pass|fail|manual)$`）+ 入账 result/acceptanceIds 相等 + 产物标记行在场。verifier 补产物级对照：见 §7 对抗第 6 条（A1.stdout 逐字节相同）。
3. **L3 行级断言**：真做了（原文行 + parse 后对象双层）。
4. **CONTEXT.md 只加不改**：`git diff a8b5ed7 -- CONTEXT.md` = +5/-0，两处纯追加（「验收」词条加 layer 行 + 新增「验收层级（layer）」词条），既有词条零删改。

## 6. 波后场景（§7，verifier 真实对照）

方法：`git worktree add /tmp/cw-al2-verify/baseline-wt a8b5ed7` → 基线代码 npm run build → 真实存量账本（`~/.cw/...feat-firstmate-new-session-72159923`，**160 事件 / 10 units / closed+created+spec-frozen 三态**，全文零 layer 字段）整体拷贝重定位至隔离 CW_HOME（encodeCwd 重算验证一致）→ 基线 dist 与当前 dist 各跑四命令对照 → worktree 已彻底清理（`git worktree list` 不含临时项）。

| 账本 | 命令 | 基线 vs 当前 |
|------|------|------|
| 真实无 layer（160 事件） | `status` | 逐字节一致（10 行） |
| 同上 | `status --json` | **逐字节一致** |
| 同上 | `tree` | 逐字节一致（10 行） |
| 同上 | `report` | 逐字节一致（285 行） |
| 带 layer 账本（layer:"topic"） | `status --json` / `report` | 逐字节一致（基线 schema 容忍额外字段同样透传——layer 透传非新行为，前向兼容实证） |

**结论：§7 结构化逐字段一致通过（实际达逐字节级）。**

## 7. 行为对抗抽查（6 条，真实子进程 + tmp + CW_HOME 隔离）

1. **schema 边界变体**：`layer:"Unit"`（大写）/ `layer:""`（空串）/ `layer:null` 三变体真实 CLI 提交 → **全部 exit 1**，错误含字段路径 `/acceptance/0/layer: Expected union value` + 可操作恢复动作。与 §4.2「非法值入口拒」口径一致。
2. **入账链完整性**：`layer:"topic"` 经 evidence submit → events.log 原文（`"layer":"topic"` 恰 1 处，未声明条目零注入）→ status --json fold 投影（A1=topic / A2=absent）→ 逐环节不丢不变形。
3. **重放反向泄漏**：带 layer 账本跑人可读 `status` / `tree` / `report` → **零 layer 泄漏**（grep 计数 0；与 report.ts 源码无 layer 字样互证）。
4. **幽灵注入攻击**：手工向账本追加非法 `layer:"root"` 的 SpecSubmitted → 只读命令 exit 2「孤儿事件」防御（无 crash）；注入同字段**无 layer** 幽灵对照 → 行为逐字节相同 → 失败归因孤儿事件防御，与 layer 无关，layer 不引入新崩溃面。
5. **types.ts 纪律**：`git diff a8b5ed7 -- src/events/types.ts` = +20/-0 纯追加，既有类型零改名改义（AcceptanceLayer 独立 export 置于 AcceptanceType 附近，注释含语义三句 + 不改变执行器行为 + 规则⑩ al-3 交付说明——§2① 全满足）。
6. **L6 产物级对照补强**（verifier 自构双 unit，唯一差异 = layer 键有无）：判定行 / result / acceptanceIds 完全对称；**A1.stdout 逐字节相同**；report.json 仅报告自身路径与 sha 元数据差异，判定字段零差异。

## 8. 发现的验收文档瑕疵（非 builder 失败项）

- **§7「cw report --json」命令不存在**：产品规格锁定 report 无 --json（`src/readonly/report.ts` 头注释：「人可读，无 --json——规格锁定仅 status / frontier 提供 --json」）。本验收以 `status --json`（结构化全字段）+ `report`（人可读）双形态完成对照，覆盖强度不低于原意。建议主 agent 在后续文档修订时更正该措辞。

## 9. 测试形态备注（非失败项，记录供 al-3 参考）

- L6 的 stdout 对照为「过滤判定行」形态而非全 stdout 逐字节（stdout 含 runId 等非确定内容，全量 diff 不可行）——verifier 已补产物级逐字节对照证实。
- L4「与基线一致」未内嵌改造前产物快照（文档允许关键字段断言路线）——改造前/后真对照由本报告 §6 完成，结论一致。

## 10. 环境与清理

- 对照 worktree 已 `git worktree remove` 彻底清理，结束态 `git worktree list` = bare + fix-cw-test-split + main，无临时项。
- 隔离环境 `/tmp/cw-al2-verify/`（含全部对照产物与账本副本）保留至系统自清，供主 agent 复查（重建脚本可从本报告 §6/§7 方法复原）。
- verifier 全程唯一写入 = 本报告文件；零代码/测试/文档修改，零 git add/commit/push。

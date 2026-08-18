# 验收文档终验回收核查报告（二跑 · M4 修复轮）

> 协调机制第 4 步（orchestration.md「防篡改机制」）的回收核查：① 全部 M4 验收文档 diff 基线确认为空（fx-5 按其补录口径核对）② sha256 与 verifier 报告 / ledger 记录对照 ③ 报告结论与 ledger 状态一一对应 ④ 限定范围抽样重跑验收命令证实报告真实性 ⑤ 定型态总检。
> 核查环境：HEAD 59cca38（M4 最后实现 unit mx-1 的 commit）工作树；核查时间 2026-08-19 00:57-01:03；启动时 `git status --porcelain` 为空（并行文档 agent 领地文件不在审计范围，互不影响）。全程只读，无 git 写操作；重跑前仅执行 `npm run build`（产物 dist/ 在 .gitignore，供 e2e 子进程使用，不入 git）。

## 1. 篡改核查（8 份验收文档）

方法：对每个 unit 执行 `git diff <基线commit> -- docs/rewrite/acceptance/<unit>-acceptance.md`；fx-5 为事后补录件，按 fx5-report.md §1 备案口径核对（工作区 vs HEAD 为空 + 入 git 后仅 1 个 commit 6705a71 且其后无改动）。判定标准：diff 为空 = 未篡改。

| unit | 基线 commit | diff 结果 | 判定 |
|------|------------|-----------|------|
| rv-1 | 9023076 | 0 行 | 未篡改 |
| rv-2 | 9023076 | 0 行 | 未篡改 |
| rv-3 | 9023076 | 0 行 | 未篡改 |
| rv-4 | f8aaa0c | 0 行 | 未篡改 |
| rv-5 | 0e7d4a9 | 0 行 | 未篡改 |
| mx-1 | cdbb107 | 0 行 | 未篡改 |
| mx-2 | 6eb88c2 | 0 行 | 未篡改 |
| fx-5 | 补录口径（6705a71 单 commit） | vs HEAD 0 行；`6705a71..HEAD` 0 行；`git log --follow` 仅 6705a71 一个 commit 触及 | 未篡改（补录口径成立） |

**统计：8/8 通过。**

## 2. sha256 对照

方法：`shasum -a 256` 实测 vs ledger「verifier PASS（sha256 …）」备注前缀；fx-5 vs fx5-report.md §1 表内记录值。

| unit | 实测 sha256（前 16 位） | ledger / 报告记录 | 一致 |
|------|------------------------|------------------|------|
| rv-1 | 3449be0a6ecfff60 | 3449be0a… | 一致 |
| rv-2 | ec8ca4e623764bda | ec8ca4e6… | 一致 |
| rv-3 | bf449ea3c581df31 | bf449ea3… | 一致 |
| rv-4 | 24f76f4bd5aa32ca | 24f76f4b… | 一致 |
| rv-5 | 144778cd7b972ab1 | 144778cd… | 一致 |
| mx-1 | aab62dbed334cd38 | aab62dbe… | 一致 |
| mx-2 | a5d4d2779a4db65e | a5d4d277… | 一致 |
| fx-5 | a16f42fabf16ad82 | fx5-report.md §1 记录 a16f42fabf16ad82e8522be077b58c21c6998d4b5bcf9927e413b5f6b255b9eb（全量） | 一致（字节级） |

**统计：8/8 一致。** 全量实测值：rv1 3449be0a6ecfff60e61ba7c4cbca3d2dc238cd1a918f2aa59c6bf558c62675b8；rv2 ec8ca4e623764bda5661cf3d2c12657069e0cc9a61a18445f4fd7919f33dfcbf；rv3 bf449ea3c581df31125ec777f68013511c3d1292765c9a029cb37f5612ba5863；rv4 24f76f4bd5aa32ca19977b8694703c47241c4ae5bb2d720c7e3b3d05e38b5ffd；rv5 144778cd7b972ab13128d86df4166300e6083318d5bd7f229b6ab7cd07f6220e；mx1 aab62dbed334cd387d2fc27fe9c5f95140c49c6abdfb880090b00332955e26fb；mx2 a5d4d2779a4db65e47660fa5bfd5ea66cccc66f4bb56ad9425c854f51a53ade5；fx5 a16f42fabf16ad82e8522be077b58c21c6998d4b5bcf9927e413b5f6b255b9eb。

## 3. 报告-账本对应

| unit | verifier 报告 | 报告总结论 | ledger 状态 | 一致性 |
|------|--------------|-----------|------------|--------|
| rv-1 | rv1-report.md | PASS | committed | 一致 |
| rv-2 | rv2-report.md | PASS | committed | 一致 |
| rv-3 | rv3-report.md | PASS | committed | 一致 |
| rv-4 | rv4-report.md | PASS | committed | 一致 |
| rv-5 | rv5-report.md | PASS | committed | 一致 |
| mx-1 | mx1-report.md | PASS（文首「总结论：PASS」节） | committed | 一致 |
| mx-2 | mx2-report.md | PASS | committed | 一致 |
| fx-5 | fx5-report.md | PASS（补录闭环） | committed（行内如实备案「验收链缺口→事后补录闭环」） | 一致 |

**统计：8/8 一致。** 各报告的打回 / 裁决 / 观察项（rv-2 三处打回+方案 C、rv-4 四裁决、mx-1 两轮打回、fx-5 补录缺口备案）在报告中均如实保留，无粉饰痕迹；fx-5 的非常规验收链（187f7df 先交付、6705a71 后补录基线+事后 verifier）在 ledger 与报告中双向备案，透明可溯。

## 4. 抽样重跑（8 unit 定向 + 定型态总检，2026-08-19 00:59-01:03 实跑）

| unit | 命令 | 结果 | 证实 |
|------|------|------|------|
| rv-1 | `npx vitest run tests/rv1-spawn-robustness.test.ts` | 1 文件 5/5 passed（5.40s） | rv1-report「5/5 绿」至今成立 |
| rv-2 | `npx vitest run tests/rv2-engine-fixes.test.ts` | 1 文件 24/24 passed（4.74s） | rv2-report「干净副本 91/91」中 rv-2 交付面至今成立 |
| rv-3 | `npx vitest run tests/rv3-contract-match.test.ts` | 1 文件 15/15 passed（144ms） | rv3-report「15 新测试全绿」至今成立 |
| rv-4 | `npx vitest run tests/rv4-redphase-default.test.ts tests/rv4-integration-disposal.test.ts tests/rv4-contract-pairing.test.ts` | 3 文件 15/15 passed（15.12s） | rv4-report「三组条款全绿」至今成立 |
| rv-5 | `npx vitest run tests/rv5-flake-escalation.test.ts` | 1 文件 8/8 passed（16.82s） | rv5-report「T1-T8 全绿」至今成立 |
| mx-1 | `npx vitest run tests/mx1-independent-review.test.ts tests/mx1-model-chain.test.ts` | 2 文件 14/14 passed（16.94s） | mx1-report「对抗 10 条/红性 2/3」交付面至今成立 |
| mx-2 | `npx vitest run tests/mx2-pytest.test.ts tests/mx2-playwright.test.ts tests/mx2-runner-routing.test.ts` | 3 文件 30/30 passed（4.49s） | mx2-report「30 新测试全绿」至今成立 |
| fx-5 | `npx vitest run tests/fx5-unit-reclaim.test.ts` | 1 文件 5/5 passed（4.62s） | fx5-report「fx5 5/5 绿」至今成立 |

## 5. 定型态总检

```
$ npm run check        → tsc --noEmit，exit 0
$ npm run check:tests  → tsc --noEmit -p tsconfig.test.json，exit 0
$ npx vitest run       → Test Files  61 passed (61)
                        Tests        450 passed (450)
                        Duration     117.71s
```

61 文件 / 450 用例与 mx-1 ledger 行「全量 61 文件 450 绿」及 450 用例基线一致，零回退、零 flake（并行文档 agent 不触碰代码，结果无干扰归因需求）。

## 6. 发现项清单（均非阻塞，备案移交）

1. **[勘误移交] rv1-acceptance.md §6 文件名笔误**：命令引用 `tests/u6b-human.test.ts` / `tests/u7b-timeout.test.ts`，实际文件为 `u6b-human-adapter.test.ts` / `u7b-loop-timeout-reset.test.ts`（9023076 基线时即如此，verifier 已按实际文件执行并备案）。勘误需主 agent 以显式例外备案方式修订并重记 sha256——本审计时点未勘属预期（勘了反而破坏防篡改基线）。
2. **[勘误移交] mx1-acceptance.md §2 交付物表笔误**：`src/handlers/spec-schema.ts`「role 可选字段 schema 同步」列入交付物，实际 role 校验在 `src/handlers/review-submit.ts`（isVerdictRole 类型守卫），spec-schema.ts 零改动。处置同上。
3. **[测试增强移交] mx-1 同毫秒 seq 修复缺确定性回归守护**（mx1-report §7.1 minor）：rv1 T5 仅约 1/3 概率红，若未来改回 ts 判新，CI 大概率仍绿。建议后续补确定性测试。
4. **[minor 备案] rv-4 flag 反序混写字面边界**（rv4-report §7.2 裁决 2）：`--no-red-phase --red-phase` 反序时 minimist last-wins 使红阶段保持开启，偏离验收 §4 字面承诺但方向更严格；建议 dispatch.ts 层补互斥校验。
5. **[info 备案] fx-5 出声断言函数级覆盖**（fx5-report §8）：loop 层 stderr 出声由对抗抽查实证，套件内无直接覆盖。
6. **[结构备案] fx-5 验收链非常规**：实现先于基线（187f7df → 6705a71 补录），ledger 已如实标注「验收链缺口→事后补录闭环」，本轮按补录口径核对通过；该模式不应成为后续 unit 的常规路径。

## 7. 总结论

**回收核查二跑 PASS。**

- 篡改核查：8/8 通过（7 份 diff 严格为空 + fx-5 补录口径三查全过）。
- sha256：8/8 与 ledger / 报告记录一致（fx-5 与报告全量值字节级一致）。
- 报告-账本对应：8/8 一致，打回与缺口均如实备案，无粉饰。
- 抽样重跑：8 unit 定向 116/116 全绿；定型态总检 check / check:tests exit 0、全量 61 文件 450/450 全绿，与 ledger 定型态记录零偏差。

M4 修复轮验收文档体系可信，回收放行。

# 验收文档终验回收核查报告

> 协调机制第 4 步（orchestration.md「防篡改机制」）的回收核查：① 全部验收文档 diff 基线确认为空 ② 报告结论与 ledger 状态一一对应 ③ 抽查重跑验收命令证实报告真实性。
> 核查环境：HEAD 9b719d0（终验第 4 次 PASS commit）工作树；核查日期 2026-08-16；全程只读，无 git 写操作。

## 1. 篡改核查（全量，16 份验收文档）

方法：对每个 unit 执行 `git diff <基线commit> -- docs/rewrite/acceptance/<unit>-acceptance.md`，基线 commit 取自 `docs/rewrite/ledger.md` 各行「验收基线 commit」列。判定标准：diff 为空 = 未篡改。

| unit | 基线 commit | diff 结果 | 判定 |
|------|------------|-----------|------|
| u1 | 01fd577 | 0 行 | 未篡改 |
| u1b | 552ae90 | 0 行 | 未篡改 |
| u2 | 552ae90 | 0 行 | 未篡改 |
| u3 | 01fd577 | 0 行 | 未篡改 |
| u4a | 115e52c | 0 行 | 未篡改 |
| u4b | 5183fb2 | 0 行 | 未篡改 |
| u5 | 115e52c | 0 行 | 未篡改 |
| u5b | 5183fb2 | 0 行 | 未篡改 |
| u6a | 78fa351 | 0 行 | 未篡改 |
| u6b | 9c6af01 | 0 行 | 未篡改 |
| u6c | 9c6af01 | 0 行 | 未篡改 |
| u7 | 9c6af01 | 0 行 | 未篡改 |
| u8 | 21da1e1 | 13 行（1 处注释行修订） | 未篡改（例外备案成立，见下） |
| fx-1 | 99f5fca | 0 行 | 未篡改 |
| fx-2 | ddc5a84 | 0 行 | 未篡改 |
| fx-3 | 528e9ff | 0 行 | 未篡改 |

**统计：16/16 通过（15 份 diff 严格为空；1 份为已备案例外，核对属实）。**

### u8 例外备案核对

u8-acceptance.md 是唯一有 diff 的验收文档，共 13 行 diff 输出，实际改动仅 `ContractMatchInput.contracts` 字段的**行内注释**一处：

- 原注释：`// root spec 冻结的契约`
- 现注释：`// root ∪ 各子 spec 冻结的契约集合（跨节点承诺由提供方 spec 冻结；2026-08-16 按 verifier 实证修订，原注释「root spec 冻结」与 E2E 条款矛盾）`

核对结论：接口字段签名 `contracts: Contract[]` 字节级未变，仅注释文字修订；修订由 u8 committed commit（4e3c84c）一次性引入，其后至 HEAD 无进一步改动（`git log --follow` 确认仅 1 个 commit 触及）；修订内容（contract 集合口径 = root ∪ 子）与 u8-report.md 总结论中「契约集合 root∪子口径判定成立」及 ledger u8 行备注一致。**例外备案成立，放行。**

## 2. 对应核查（ledger 状态 vs 报告结论，22 份报告）

方法：逐行核对 ledger 状态与对应 report 文件的最终结论；要求报告文件存在、结论非空、语义一致。

### 2.1 unit / fix unit（16 份）

| unit | ledger 状态 | 报告结论 | 一致性 |
|------|------------|---------|--------|
| u1 | committed | PASS | 一致 |
| u1b | committed | PASS | 一致 |
| u2 | committed | PASS | 一致 |
| u3 | committed | PASS | 一致 |
| u4a | committed（首验 FAIL→修复→复审 PASS） | 复审结论 PASS（总结论以复审为准，首验 FAIL 原样保留） | 一致 |
| u4b | committed | PASS | 一致 |
| u5 | committed | PASS | 一致 |
| u5b | committed | PASS | 一致 |
| u6a | committed | PASS | 一致 |
| u6b | committed | PASS | 一致 |
| u6c | committed | PASS | 一致 |
| u7 | committed（首验 FAIL→修复→复审 PASS） | 复审结论 PASS（首验 FAIL 口径在报告内保留） | 一致 |
| u8 | committed | PASS | 一致 |
| fx-1 | committed | PASS | 一致 |
| fx-2 | committed | PASS | 一致 |
| fx-3 | committed | PASS | 一致 |

### 2.2 milestone gate 与终验（6 份）

| 报告 | ledger 状态 | 报告结论 | 一致性 |
|------|------------|---------|--------|
| m0-gate-report.md | M0 gate done | PASS（A1 root closed + A3 六条全拒/留痕） | 一致 |
| m1-gate-report.md | M1 gate done | PASS（三场景全 PASS，零重派） | 一致 |
| final-gate-report.md | 终验第 1 次 FAIL | FAIL（状态机死锁三 unit） | 一致 |
| final-gate-2-report.md | 终验第 2 次 FAIL | FAIL（R4 集成层新死锁；fx-1 三修复现场生效） | 一致 |
| final-gate-3-report.md | 终验第 3 次 FAIL | FAIL（R5 建子缺位，更上游） | 一致 |
| final-gate-4-report.md | 终验第 4 次 PASS | PASS（45.1min 零人工、全树 closed、7/7 机器验证） | 一致 |

**统计：22/22 一致。** 3 次 FAIL 如实记录为 FAIL，无将失败粉饰为通过的痕迹；ledger 事件节叙述与各报告结论可互相印证。

## 3. 抽查重跑（5 个 unit + 全量命令）

全部在 HEAD 9b719d0 工作树实跑，2026-08-16 05:40-05:42。

| 抽查对象 | 命令 | 结果 | 证实 |
|---------|------|------|------|
| u3 | `npx vitest run tests/u3-spec-rules.test.ts` | 13/13 passed | u3-report「测试全绿」至今成立 |
| u4a + u4b | `npx vitest run tests/u4a-* tests/u4b-*`（6 文件） | 34/34 passed | u4a-report（复审）/u4b-report「全绿」至今成立 |
| fx-2 | `npx vitest run tests/fx2-integration-recovery.test.ts` | 4/4 passed | fx-2-report「4 条回归全绿」至今成立 |
| fx-3 | `npx vitest run tests/fx3-*.test.ts`（2 文件） | 8/8 passed | fx-3-report「对抗 22/22、全绿」至今成立 |
| 全量测试 | `npm test` | 38 文件 230/230 passed（40.7s） | fx-3 后 ledger「230 全绿」至今成立，零回退 |
| 类型检查 | `npm run check:all` | exit 0 | — |
| Lint | `npm run lint` | exit 0（零输出） | — |

## 4. 总结论

**回收核查 PASS。**

- 篡改核查：16/16 通过（15 空 + 1 备案例外核对属实，接口签名零改动）。
- 对应核查：22/22 一致（含 3 次终验 FAIL 的如实记录）。
- 抽查重跑：5 unit 定向抽查 + 全量 230 测试 + check:all + lint 全绿，报告「测试全绿」结论全部至今成立。

验收文档体系可信，回收放行。

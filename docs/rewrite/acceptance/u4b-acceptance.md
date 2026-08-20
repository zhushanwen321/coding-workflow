# u4b 验收标准：名字级比对接线 + 红阶段 gate

> **锁定文件**：派发基线（已入 git）。builder 与 verifier 禁止修改本文件。
>
> status: pending（pending → building → built → verifying → verified → committed / rejected）

## 目标

把 verify 判定从「exit code」升级为「case 级名字比对」（接线 u5 适配器），并交付红阶段 gate。canon 依据：§3.3 D5（三道 gate：红阶段/名字比对/干净重跑——干净重跑 u4a 已交付）、子文档 2 §4（名字级比对语义）。复用 u4a（checkout/runAcceptances/verify.ts 已 committed，可修改演进）、u5（适配器 registry）、u3（spec gate）。

## 规格锁定

### 1. 判定升级（verify.ts 默认路径改造）

- 执行验收 command 后，按验收 `type` 路由适配器：`e2e-real`/`e2e-mock` → e2e-sh 适配器；`unit`/`integration` → vitest 适配器；`manual` 不执行（语义不变）。适配器来自 `defaultRegistry()`。
- **unit/integration 用例的 command 必须产出 vitest JSON**（vitest 适配器 translate 已确保 `--reporter=json` 追加；若 command 非 vitest 兼容，parse 抛错 → 该条 fail，错误信息说明「unit/integration 验收的 command 须为 vitest 兼容命令」）——M0 能力边界（多语言适配 M2 补），spec 设计时即受此约束。
- 判定 = 名字级比对 `nameMatch(acceptance, report)`：验收 id 在 report.cases 中存在且 status=pass → 该验收 pass；缺失或 fail → fail（错误信息区分「未出现在产物」与「执行失败」）。
- EvidenceReport 与逐验收产物照旧落盘入账；VerifyRan.acceptanceIds 语义不变（机器 pass ∪ manual）。

### 2. name-match 纯函数（`src/verify/name-match.ts`）

```
nameMatch(acceptance: AcceptanceItem, report: EvidenceReport): { pass: boolean; reason: string }
```
- 单验收对单报告：cases 中存在 id 匹配且 pass → pass；存在但 fail → reason=「执行失败」；不存在 → reason=「未出现在产物（用例未运行或标记缺失）」。

### 3. 红阶段 gate（`src/verify/red-phase.ts` + verify.ts 集成）

- `cw verify --unit <id> --red-phase`：checkout **父 commit**（build evidence 的 commit 的第一父 `commit^`；无父（初始 commit）→ exit 2 附说明）→ 同一套验收逐条执行（同一适配器路由）→ **逐条期望 fail**。
- 逐条判定：该条在新树 pass 而旧树也 pass → 无区分力（`echo ok` 类假命令防线）；旧树 fail（命令不存在/文件缺失/测试失败）→ 有区分力 ✓。
- 汇总：全部有区分力 → 红阶段 pass（exit 0，stdout 逐条 `<id> 有区分力`）；任一无区分力 → exit 1（stderr 列无区分力验收 id，恢复动作指向「修测试而非修 gate」）。
- 红阶段不写 VerifyRan（它不是验证结论，是测试区分力检查；产物落盘 `red-phase/` 子目录留审计）。

## 交付物

| 文件 | 内容 |
|------|------|
| `src/verify/name-match.ts` | 纯函数（上方签名） |
| `src/verify/red-phase.ts` | 父 commit checkout + 逐条期望 fail 判定 |
| `src/handlers/verify.ts` | 改造：适配器路由 + nameMatch 判定替换 exit code 判定 + --red-phase 分支（src/verify/checkout.ts、run.ts 可按需微调，保持既有导出兼容——其测试已 committed 不得无谓破坏） |
| `tests/u4b-name-match.test.ts`、`tests/u4b-verify-upgrade.test.ts`、`tests/u4b-red-phase.test.ts` | 单测 |
| `tests/u4b-e2e.test.ts` | E2E |

## 单测验收

1. nameMatch：id 存在且 pass → pass；存在 fail → reason 含「执行失败」；缺失 → reason 含「未出现在产物」。
2. 升级判定：e2e-sh 型验收（脚本输出 `A1 PASS`）→ pass；脚本输出 `A1 FAIL` → fail 且 reason 含执行失败；脚本无标记 + exit 0 → parse 抛错 → 该条 fail（无区分力防线在 verify 层的表现）。
3. vitest 型验收：tmp 项目真实 vitest 测试（含验收 id 对应测试名——名字含 A1）→ pass；测试名不含验收 id → fail（未出现在产物）。
4. manual 语义不变；VerifyRan acceptanceIds 语义不变。
5. 红阶段：tmp git 两 commit（c1 无测试文件、c2 有测试文件+验收命令）→ --red-phase 在 c1 树上命令必挂（文件缺失）→ 有区分力 exit 0；把验收命令换成 `echo ok`（两树都过）→ 无区分力 exit 1 且 stderr 列 id。
6. 初始 commit（无父）→ exit 2 附说明。

## E2E real（tests/u4b-e2e.test.ts）

- tmp git 项目 + CLI 全链（create→spec（e2e-sh 型验收+真实脚本文件随 build commit 提交）→build→review→verify）→ exit 0 且 VerifyRan 入账；再 `verify --red-phase` → exit 0（脚本在父 commit 不存在 = 有区分力）。
- 假命令防线全链：spec 的 e2e 验收 command=`echo ok` → 常规 verify 的 parse 抛错路径 → exit 1；`--red-phase` 同样 exit 1（无区分力）。
- u4a 既有测试回归：`npx vitest run tests/u4a-verify.test.ts tests/u4a-e2e.test.ts` 若因判定升级需适配断言，允许修改这两个**测试文件**的断言使其匹配新判定语义（源码不得为迁就旧测试回退；改动在汇报中逐条列出理由）。

## 通过命令

```
npm run check:all
npm test          # u5b 并行期以 u4b 自有 + u4a 回归全绿为准
npm run lint      # u4b 领地零输出
```

## 禁改清单

`src/testrun/**`（types/vitest/e2e-sh/registry——u5 已验收，发现缺陷上报）；`src/dispatch.ts`、`src/cli.ts`、`src/events/types.ts`、`src/store/**`、`src/core/**`、`src/gates/**`、`src/readonly/**`、`src/handlers/` 既有文件（除 verify.ts 改造外）；`src/runner/**`、`src/handlers/run.ts`、`src/handlers/index.ts`（u5b 并行领地——**本 unit 不动 index.ts，verify 注册已在**）；archive/、docs/rewrite/ 其余、tests/ 既有文件（u4a 两测试文件的断言适配除外，见上）。禁 git 写操作；禁 mock；禁 any。

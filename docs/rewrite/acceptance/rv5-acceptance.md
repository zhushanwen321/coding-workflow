# rv-5 验收标准：flake 转人工 + 随机性豁免（canon 纪律②收口）

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：2026-08-18 五角度对抗审查（canon 角度 requirements gap「flake 转人工零实现」、parent 角度 M5、testrun 角度 D3/D4：纪律②「声明随机性的用例不进名字比对必过集合」零实现、§5.2「连挂 2 次的 e2e 用例标 flake 转人工（不自动豁免，防 Goodhart）」零实现）+ 用户裁决（其他直接修复）。
> 依赖：rv-2（events/types、spec-rules、verify/run 领地）+ rv-4（red-phase、frontier、loop 领地）committed 后派发。

## 1. 目标

随机性用例可显式声明并获得名字比对豁免（声明≠逃逸：执行仍跑、结果仍记录）；e2e 用例连挂 2 次转人工判定（投影计算，零新事件类型，防 Goodhart 不自动豁免）。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/events/types.ts` | +字段 | `AcceptanceItem.nondeterministic?: true`（注释：声明该用例含随机性——名字比对豁免、单次 fail 不 fail 整体；滥用防线 = spec-review 语义审查 + 永远不能自动豁免）。除该字段外零变更 |
| `src/handlers/spec-schema.ts` | 修改 | typebox schema 加可选 `nondeterministic` 布尔字段 |
| `src/verify/name-match.ts` | 修改 | `nondeterministic: true` 的验收跳过名字比对（不进必过集合；verify 结果中该条目标注 `nameSkipped: "nondeterministic"` 类语义——具体字段名随 report 结构，锁定：跳过不是 fail） |
| `src/verify/run.ts` | 修改 | 聚合判定：nondeterministic 条目照常执行、产物照常落盘，但其 fail **不计入整体 result=fail**（pass 判定只看未声明条目；声明条目全 pass 也不额外加分）；report.json 该类条目结果照录（审计完整） |
| `src/verify/red-phase.ts` | 修改 | 红阶段跳过 nondeterministic 条目（随机用例在旧树的 pass/fail 无区分力语义；报告注明 skip 原因）——在 rv-4 已接线的红阶段默认执行路径上生效 |
| `src/readonly/frontier.ts` | +维度 | `flakeReview`：当前 spec 周期内（lastSpecSeq 之后的全部 VerifyRan），某 e2e 级（e2e-real/e2e-mock）验收条目**连续 ≥2 次** fail（每次出现的 VerifyRan 中都 fail，无间隔 pass）→ 该 unit 出现 flakeReview 维度。纯投影计算（fold 数据已有逐条 result），零新事件类型 |
| `src/runner/loop.ts` | 修改 | flakeReview 出口：不再派 builder（停止打回循环），stderr escalation 指引（列出连挂用例 id、两次 fail 的 runId、人工判定动作：`cw report --unit <id>` 看产物 → 判定 flake 则修测试稳定性或声明 nondeterministic 后重提 spec；判定真 bug 则人工修复）；复用 fx-2 上限出口的审计-不喂-idle 模式 |
| `tests/rv5-flake-escalation.test.ts` | 新建 | §5 条款 |
| `tests/u4a*.test.ts`、`tests/u4b*.test.ts` | 适配 | 聚合判定语义增量的必要适配；禁改既有断言语义内核 |

## 3. 禁改清单（违反 = FAIL）

- `src/runner/spawn/`、`src/runner/{integrate,worktree,human-loop}.ts`、`src/gates/spec-rules.ts`（本 unit 不加 gate 规则——滥用防线是 spec-review 语义审查，非机器规则；注释在 types.ts 说明）、`src/handlers/{review-submit,evidence-submit,create,run}.ts`、`src/core/fold.ts`（flake 是 frontier 投影，fold 状态机零变更）、`src/testrun/`、`src/store/`、`src/verify/{checkout,contract-match}.ts`
- 事件 schema 除 `nondeterministic` 可选字段外零变更；VerifyRan payload 零变更（flake 由事件流投影）
- `docs/`、`archive/`、配置

## 4. 关键口径（锁定）

- **声明 ≠ 逃逸**：nondeterministic 条目执行照跑、产物照落盘、结果照录 report；豁免的只有两处——名字比对必过集合、单次 fail 的整体判定。连挂转人工对声明与未声明一视同仁（canon §5.2 不区分），声明不提供「免死金牌」。
- **flake 只认 e2e 级**：canon §5.2 原文口径（e2e 用例）；unit/integration 级连挂是稳定 bug，走正常 fail 打回（builder 修），不转人工。
- **连续定义**：当前 spec 周期内该条目在**每次** VerifyRan 中都 fail 且出现次数 ≥2；中间任何一次 pass 即清零（投影天然重算，无内存态）。
- **转人工不打断其他 unit**：仅该 unit 停止自动派发；root 树上其他 unit 照常。人处置后（修稳定性/声明/修 bug + 重提 spec 或新 verify pass）投影自然消失，循环自愈。
- **flakeReview 与 integrationDrift 互斥场景各自独立判定**：集成 verify 的 fail（integrate- 前缀 runId）**不参与** flake 计数（集成是全量重跑语义，随机挂由重跑覆盖）；flake 只数 unit 级 verify（非 integrate- 前缀）。
- **spec 变更即清零**：新 SpecSubmitted 后重新计数（周期锚 lastSpecSeq）。

## 5. 新增测试条款（tests/rv5-flake-escalation.test.ts，真实子进程 + tmp + CW_HOME 隔离，零 mock）

- **T1 声明豁免两处**：spec 含 1 条普通验收（pass）+ 1 条 nondeterministic 验收（脚本随机/固定 fail 但名字比对无法命中）→ verify exit 0（整体 pass）；report.json 中该条目结果照录、名字比对标注跳过。
- **T2 声明不逃逸执行**：nondeterministic 条目的 command 是真实脚本（真跑真产物）——report 中该条目有 stdout/stderr/exitCode 产物（非 skip 执行）。
- **T3 e2e 连挂转人工（核心）**：e2e-real 验收脚本固定 fail → 第一次 verify fail → 打回 → 重提（同 spec 或 builder 重提 build 后再 verify）→ 第二次 verify 同条目 fail → frontier `--json` 出现 flakeReview 维度；loop（human 模式 E2E）stderr 出现人工判定指引（含用例 id 与两次 runId），且不再派该 unit 的 builder。
- **T4 中间 pass 清零**：fail → pass → fail（同 spec 周期）→ 不出 flakeReview（连续性破坏）。
- **T5 unit 级不转人工**：unit 型验收连挂 2 次 → 无 flakeReview（正常打回路径继续）。
- **T6 集成 fail 不计数**：构造集成 verify fail（integrate- runId）两次 → 不出 flakeReview。
- **T7 spec 变更清零**：连挂 1 次后重提新 spec → 计数清零（再挂 1 次不出维度，第 2 次连续才出）。
- **T8 人工处置自愈**：T3 场景后按指引修复（修脚本稳定 pass + 重提 build + verify pass）→ flakeReview 消失、循环继续推进。

## 6. 通过命令

```
cd <仓库根> && npm run check
npx vitest run tests/rv5-flake-escalation.test.ts tests/u4a*.test.ts tests/u4b*.test.ts tests/u5b*.test.ts
npx eslint src/events/types.ts src/handlers/spec-schema.ts src/verify/ src/readonly/frontier.ts src/runner/loop.ts tests/rv5-flake-escalation.test.ts
```

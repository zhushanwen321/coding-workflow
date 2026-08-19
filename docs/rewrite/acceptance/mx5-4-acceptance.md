# mx5-4 验收标准：builder→developer 角色改名（机械全量）+ mx5-2 覆盖缺口补强

> **本文件是防篡改基线：§1-§7 禁止修改；§8 status 由主 agent 流转更新，不属于防篡改范围。**
> 依据：`docs/rewrite/design-spec-contract-replan.md` D4（用户拍板：直接改，不做兼容别名；commit `97804d5`）+ mx5-2 verifier findings R1/R2 移交。前置：mx5-2 已 verified（`a4ab0cf` 后代码态）。

## 1. 目标

角色名 `builder` 全量改为 `developer`（用户裁决：builder 名字不易理解，developer 更清晰），机械替换不改任何判定逻辑；顺带补 mx5-2 的两条测试覆盖缺口（R1/R2 facts 级反向断言）。

## 2. 交付物与出处清单（基线锁定日 2026-08-19 grep 实测，共 267 处 / 38 文件）

**src（9 文件）**：`src/runner/loop.ts`（角色字符串 + DISPATCH_SHAPE + 注释）、`src/readonly/frontier.ts`、`src/runner/brief.ts`（模板文案与注释；**模板结构与核对清单内容零变化，仅角色词替换**）、`src/runner/spawn/human.ts`、`src/events/types.ts`（role 联合类型——改名的事实核心；共享契约纪律「不得改名改义」由设计 D4 的用户拍板作例外授权，实施时在类型注释补一句授权记档）、`src/runner/spawn/types.ts`、`src/handlers/verify.ts`（注释）、`src/handlers/review-submit.ts`（VERDICT_ROLES 枚举）、`src/handlers/run.ts`（注释与错误文案）。

**tests（27 文件）**：u5b-e2e / wt4-integration-merge / fx4-topic-artifacts / u7-loop / fx1-loop-dispatch / mx4-reject-budget / fx2-integration-recovery / rv5-flake-escalation / mx3-generation-count / u6c-pi-adapter / wt5-parallel-contamination / u7b-loop-timeout-reset / mx1-model-chain / wt1-worktree / u6b-human-adapter / mx3-role-gate / mx1-independent-review / rv1-spawn-robustness / mx5-3-reviewer-brief / mx5-2-contract-replan / wt3-reset-legacy-removal / u8-e2e / wt2-dispatch-worktree / fx3-loop-split-dispatch / fx1-r2-verify-message / u7-e2e + 新建本波测试。

**文档（2 文件）**：`AGENTS.md`、`CONTEXT.md`（角色词与流程描述）。

**另**：`tests/mx5-2-contract-replan.test.ts` 增 R1/R2 断言（§5）。

## 3. 禁改清单与语义锁定（违反 = FAIL）

- **改名不改语义**：所有判定逻辑、投影算法、派发形状、模板结构逐语义不变——diff 审查视角：除角色词 `builder`→`developer` 与 R1/R2 断言新增外，任何其他变更 = FAIL。`VERDICT_ROLES` / role 联合类型新写入只收 `developer`，旧值 `builder` 拒收且错误文案含迁移指引（「--role developer」指向，设计检查点③）。
- **历史账本重放零影响**：fold 对 exec-review verdict 不比对 role、对 spec-review 只认 reviewer——历史 `role=builder` 事件折叠行为改名前后完全一致（设计 D4 已核实；实施时补一条测试：直写含 `role=builder` 历史事件的账本 → fold/只读行为与改名前语义一致——exec-review pass 照常驱动 closed、builder verdict 不驱动 spec-frozen）。
- **清扫范围边界**：`archive/`、`docs/rewrite/`（设计与验收文档的历史记述）、`.xyz-harness/`、`.tmp/`、`node_modules/` 不动——它们是历史记录不是活代码。
- `src/testrun/`、`src/verify/`、`src/gates/`（零 builder 出处，应零 diff）、`src/core/`、`src/store/`、`src/cli.ts`、`src/dispatch.ts`（零出处）。

## 4. 关键口径

- 词形边界：`builder`（含大写变体 `Builder` 若有）逐处替换；复合词（如 `reheat-builder` 类，grep 时逐处归因）不允许机械误替换产生语义漂移——实施时对 267 处逐文件归因，交付说明按文件列出「纯角色词 N 处 / 特殊形态 M 处及处理」。
- spawn 产物文件名 `<unitId>.<role>.*` 后缀随角色变（`leaf-app.builder.brief.md` → `leaf-app.developer.brief.md`）——mx-3 的 session 命名 `unitId-role` 同步。旧产物文件（历史）不改名。
- mx5-2 的 R1/R2 断言（本波顺带，条款见 §5）。

## 5. 测试条款

### tests/mx5-4-developer-rename.test.ts（新建，N 系）

- **N1 角色枚举**：`cw run` 派发链产物的角色值全为 developer（human spawn 模式跑一个最小 unit，断言任务书文件名与内容角色词）。
- **N2 旧值拒收**：`cw review submit --role builder`（exec-review 形态）→ exit 1 + 文案含「developer」迁移指引。
- **N3 历史重放**：直写账本构造 `role=builder` 的 exec-review pass → fold 照常 closed；`role=builder` 的 spec-review pass → 不驱动 spec-frozen（语义与改名前一致）。
- **N4 零残留**（= V4 机检）：`grep -rn "builder" src/ tests/ AGENTS.md CONTEXT.md` 零命中。

### tests/mx5-2-contract-replan.test.ts 增断言（R1/R2 移交）

- **R1-facts**：直写账本混合 unit（解析失败条目连挂 ×2 + 断言失败 e2e 条目连挂 ×2）→ **facts 级断言** `flakeReviewFacts` 输出不含解析失败条目、`specContractFacts`（或等价导出）不含断言失败条目（输入排除的双向直断言——不被组归属优先级掩盖；删排除逻辑后此断言必红）。
- **R2-facts**：直写账本 fail(parse) → pass → fail(parse) 同 id → **facts 级断言**该 id 连挂计数 = 1（中间解析成功清零直断言——不被 verified 粘性态掩盖；删清零逻辑后必红）。

## 6. 通过命令

```
cd <仓库根> && npm run check:all && npm run lint
npx vitest run tests/mx5-4-developer-rename.test.ts tests/mx5-2-contract-replan.test.ts
全量 npm test → 全绿
grep -rn "builder" src/ tests/ AGENTS.md CONTEXT.md → 零输出
```

## 7. 波后验收（verifier 执行，V4 场景）

抽 3 个代表性测试文件 diff 逐行审查（纯角色词替换零语义变化）；N1 真实 spawn 链复核；R1/R2 红性验证（删排除/清零逻辑 → 新断言必红）。

## 8. status

pending → building（developer 派发时由主 agent 更新）

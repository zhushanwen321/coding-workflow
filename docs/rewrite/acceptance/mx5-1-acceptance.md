# mx5-1 验收标准：spec gate 规则⑨（验收命令契约）+ VerifyRanPayload.parseFailedAcceptanceIds 提取

> **本文件是防篡改基线：developer 与 verifier 禁止修改。**
> 依据：`docs/rewrite/design-spec-contract-replan.md`（mx-5 设计，4 轮对抗审查闭环，commit `97804d5`）D1 + D2 的 mx5-1 领地部分。M4 gate 三跑实证：leaf-app 冻结 spec 5 条验收 3 条结构性不可通过（A2/A4/A5 带 `--reporter=verbose` 与 cw 自动追加的 `--reporter=json` 冲突致 JSON 解析恒挂；A3 裸 `pnpm build` 无标记行——e2e 型留回炉通道），且解析失败被 flake 启发式误分类（现场五）。

## 1. 目标

生产侧设防第一层：spec gate 新增规则⑨，对「验收命令与 testrun 适配器的输出契约冲突」做确定性静态检查（入账前拒绝）；同时把 verify 已结构化在场的解析失败信号（`AcceptanceRunResult.parseError`）提取进 `VerifyRanPayload` 新可选字段 `parseFailedAcceptanceIds`，为 mx5-2 的回炉通道提供事件级输入。**testrun 四适配器与 `src/verify/run.ts` 零改动。**

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/gates/spec-rules.ts` | 修改 | 新增规则⑨（详见 §4 形状）。规则①-⑧零变更；多缺口全列不短路语义保持（⑨的缺口与①-⑧缺口同单次提交合并全列） |
| `src/events/types.ts` | 修改 | `VerifyRanPayload` 增可选字段 `parseFailedAcceptanceIds?: string[]`，注释含：封闭枚举语义（vitest/playwright stdout 非法 JSON；e2e-sh 无标记行且 exit 0、或标记 id 与验收 id 不符——**不含** e2e-sh 无标记且 exit≠0）与「只用于投影分类，result 判定语义不变」（可抄设计文档 D2 代码块注释） |
| `src/handlers/verify.ts` | 修改 | 提交 VerifyRan 时从 `AcceptanceRunResult.parseError === true` 的条目提取 id 列表写入新字段：无解析失败时**不写该键或写 undefined**（旧账本缺字段 = 无解析失败，兼容）；`exemptNondeterministic` 豁免的条目（声明 nondeterministic 且解析失败被改写为 pass）**不入列** |
| `src/testrun/registry.ts` | 仅当需要 | 规则⑨的适配器路由（`AcceptanceItem.runner` 显式声明优先，缺省按 type 推导）必须**复用** registry 既有推导逻辑，禁止在 spec-rules.ts 复制实现——若推导函数尚未导出，允许加 `export`（仅导出，零逻辑变更） |
| `tests/mx5-1-spec-rule9.test.ts` | 新建 | §5 R 系条款（规则⑨） |
| `tests/mx5-1-parse-failed.test.ts` | 新建 | §5 P 系条款（字段提取） |

## 3. 禁改清单（违反 = FAIL）

- **四适配器零改动**：`src/testrun/{vitest,pytest,e2e-sh,playwright}.ts` 逐字节不动（translate/parse 行为是规则⑨与提取锚的实证基础）
- `src/verify/`（含 run.ts——信号源已结构化在场，不需动）、`src/core/`、`src/store/`、`src/readonly/`、`src/runner/`（全部，含 brief.ts——mx5-2/3 领地）、`src/handlers/{create,evidence-submit,review-submit,run}.ts`、`src/cli.ts`、`src/dispatch.ts`
- 既有语义锁定：规则①-⑧逐条行为零变更；`VerifyRanPayload` 既有五字段不动；verify 的 pass/fail 判定与 exit 语义（0/1/2）零变更
- `docs/rewrite/acceptance/` 全部既有文档、`docs/rewrite/design-spec-contract-replan.md`

## 4. 规则⑨形状（锁定，出处设计文档 D1）

按**最终适配器路由**分派（`AcceptanceItem.runner` 显式声明优先，缺省按 type 推导，与 testrun 执行时同一路由）：

- **vitest / playwright 型**：
  - 命令中所有 `--reporter` 取值必须**恰为 `json`**；值提取兼容 `--reporter=json` 与 `--reporter json` 两种形式；取值非 json（如 verbose）→ 缺口
  - 禁 `--outputFile`（任何形式）→ 缺口
- **pytest 型**：
  - 禁 `-q` / `--quiet`，**必须覆盖短选项合写形态**（`-qq` / `-vq` / `-qqq` 等——检查算法对短选项簇逐字符展开或等价正则，token 精确枚举不可行）
  - 其余适配器追加 flag（`--tb=no`、`-p no:cacheprovider`）不设禁
- **e2e-sh / manual 型**：**不设静态规则**（无法静态证明标记行产出——诚实边界，漏网形态由 mx5-2 回炉 + mx5-3 reviewer 清单兜底）。命令含 `--reporter=verbose` 等**不拒**
- 错误文案：逐缺口列出（验收 id + flag 名 + 取值），含恢复动作（vitest/playwright 型指明「删除该 flag——cw 自动追加正确 reporter」）；规则编号进既有规则命名序列（⑨）
- 禁令清单实现为**单一事实源内的可扩展枚举**（新冲突形态一处追加），禁止散落多个函数

## 5. 新增测试条款（真实子进程 + tmp + CW_HOME 隔离，零 mock）

### tests/mx5-1-spec-rule9.test.ts（R 系）

- **R1 vitest 型毒命令拒绝**：unit 型验收 command 含 `--reporter=verbose` → `cw evidence submit --kind spec` exit 1，文案含该验收 id、flag 名与恢复动作。
- **R2 两种形式全覆盖**：`--reporter verbose`（空格形式）同样拒绝；`--reporter=json` 与 `--reporter json`（值恰为 json）**通过**（存量夹具语义——u5 锁定的 includes 幂等）。
- **R3 outputFile 禁**：含 `--outputFile` → exit 1 列缺口。
- **R4 pytest 合写形态**：pytest 型（runner 显式声明或 type 推导）含 `-q` / `--quiet` / `-qq` / `-vq` 各自独立用例 → 全拒；裸 pytest 命令通过。
- **R5 e2e/manual 不设规则**：e2e-sh 型含 `--reporter=verbose`、manual 型任意 → 入账不因规则⑨拒绝（A3 裸 `pnpm build` 形态在 V1 对照中正常入账）。
- **R6 路由优先级**：`AcceptanceItem.runner: "pytest"` 而 type 为 unit → 按 pytest 规则查（`-q` 被拒）；缺省推导路由正确（unit/integration → vitest，e2e-real/e2e-mock → e2e-sh）。
- **R7 多缺口全列不短路**：一条 spec 同时含 A2（verbose）与 A5（outputFile）缺口 + 规则③缺口 → 三缺口全列出。
- **R8 对照组合法入账**：合规 spec（裸 vitest 命令 + `--reporter=json` + e2e 带标记行命令）exit 0 正常入账。

### tests/mx5-1-parse-failed.test.ts（P 系）

- **P1 提取锚 = parseError===true**：构造 vitest 型解析失败（命令带 `--reporter=verbose` 走到 verify——注意：规则⑨落地后正常入账路径进不来这种 spec，测试用直写账本或绕过 gate 的构造）→ VerifyRan 事件 payload 含 `parseFailedAcceptanceIds: ["<id>"]`，且该 case 照旧判 fail（result 判定零变化）。
- **P2 e2e-sh exit≠0 不入列**：e2e 型命令无标记行且 exit≠0（如 `pnpm build && node no-such.mjs`）→ no-markers fail case，事件**不含**该 id（或字段缺失）。
- **P3 e2e-sh exit 0 无标记入列**：命令如 `echo done`（exit 0 无标记）→ parseError 入列。
- **P4 豁免条目不入列**：声明 `nondeterministic: true` 的条目解析失败被豁免改写 pass → 不入列，且 VerifyRan.result 不因它变 fail。
- **P5 无解析失败不写字段**：全 pass / 断言失败（产物合法）的 VerifyRan → payload 无该键或 undefined。
- **P6 旧账本兼容**：不含新字段的既有 VerifyRan 事件 → fold/只读命令行为与现状逐字节一致（重放兼容）。

### 回归（通过命令内含）

- 存量夹具 10 文件 `-- --reporter=json` 形态零翻红（u5b/fx2/fx4/fx5/wt5 等）；mx-3/mx-4/mx-2 套件全绿；规则①-⑧既有测试零变更零红。

## 6. 通过命令

```
cd <仓库根> && npm run check:all
npx vitest run tests/mx5-1-spec-rule9.test.ts tests/mx5-1-parse-failed.test.ts
npx eslint src/gates/spec-rules.ts src/events/types.ts src/handlers/verify.ts tests/mx5-1-*.test.ts
全量 npm test → 全绿
```

## 7. 波后验收（verifier 执行，V1 场景）

真实 cw CLI（隔离 CW_HOME tmp 目录）构造三跑 leaf-app v3 同款 spec：A2/A4/A5 带 `--reporter=verbose`、A3 裸 `pnpm build`（e2e）→ 提交 exit 1，文案逐条列出 A2/A4/A5 的 flag 问题与恢复动作、**不列 A3**（e2e 无静态规则 = 诚实边界）；合规对照 spec 正常入账。

## 8. status

pending → building（developer 派发时由主 agent 更新）

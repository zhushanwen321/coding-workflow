# rv-2 验收标准：engine 小修包（id 字符集 gate + exec-review 证据强制 + 可操作性收尾）

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：2026-08-18 五角度对抗审查（canon 角度 A-13/A-17 部分项、parent 角度 M4/m6、testrun 角度 D6/D13/D20）；`design-child-testrun.md` §6.3 纪律②、标记行约定；AGENTS 全局规则「错误信息必须可操作」。
> 来源缺陷：①e2e-sh marker 正则 `[A-Za-z0-9-]+` 不认 `.`/`_`，而 spec gate 不校验 id 字符集——id 含 `.`/`_` 的 e2e 用例永远失败且报错误导为「无标记行」（vitest 路径同类 id 却可匹配，两路口径分裂）；②exec-review verdict 可零 `--evidence-refs` 直接入账成为 closed 最后一块拼图（parent 文档四处承诺「verdict 一致性校验」落空）；③`evidence-submit.ts` closed unit 拒绝文案引用不存在的 `replan` 命令；④verify parse 失败条目的 command exit code 只存内存不落盘（审计需从 stderr 文本猜）；⑤cleanCheckout 假定 cwd=仓库根，子目录运行 verify 误报 clone 失败且文案无恢复指引。

## 1. 目标

id 字符约束在入口 gate 拦截（两路适配器同源正则）；exec-review 必须引用真实证据；全部受影响错误消息形成「错误 → 恢复动作」闭环；验证环境对运行目录不敏感。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/events/types.ts` | +导出 | `export const ACCEPTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/`（注释：id 是 marker 行第一列与名字比对的锚，禁空格与中文；开头须字母数字）。**只加常量，零其他变更** |
| `src/gates/spec-rules.ts` | +规则⑦ | 逐条校验 `spec.acceptance[].id`：不匹配 `ACCEPTANCE_ID_RE` 即 fail，消息含该 id 原文、合法字符集说明（字母数字开头，可含 `.` `_ `-`）、恢复动作（改 id 后重新提交 spec） |
| `src/testrun/e2e-sh.ts` | 修改 | `MARKER_RE` 改为 `/^([A-Za-z0-9][A-Za-z0-9._-]*) (PASS\|FAIL)$/`，正则字面量从 `ACCEPTANCE_ID_RE` 派生（`new RegExp(\`^(${ACCEPTANCE_ID_RE.source}) (PASS\|FAIL)$\`)` 或等价构造）；头注释同步「id 可含 . _ -」 |
| `src/handlers/review-submit.ts` | 修改 | `verdictKind === "exec-review"` 时 `--evidence-refs` 必填且解析后 ≥1 条（缺失即 fail，消息含该 unit 已入账 runId 清单与恢复动作：`cw evidence submit --kind build --unit <id> --run-id <runId> ...` 后携带 refs 重提）；spec-review 维持可选；已存在性校验逻辑不变 |
| `src/handlers/evidence-submit.ts` | 修改 | closed unit 拒新 spec 的恢复动作文案：删除 `replan` 引用，改为 2.0 真实路径（closed 不可逆；如需变更，新建后续 unit 承接，`cw create --id <slug> --brief <路径>`） |
| `src/verify/run.ts` | 修改 | parse 抛错分支（runOne 内 catch parse 错误的路径）：在既有 stderr 追加之外，向 `<id>.report.json` 落盘 `{ parseError: true, commandExit, reason }` 最小 JSON（commandExit 来自本条命令的真实 exit code；文件与正常条目同目录同命名规则） |
| `src/verify/checkout.ts` | 修改 | cleanCheckout 用 `git rev-parse --show-toplevel`（在 ctx.cwd 执行）解析仓库根，再以仓库根为 repoDir clone；解析失败（非 git 仓库/损坏）报错含恢复动作（到仓库根运行 / 检查 .git）；成功路径行为不变（mkdtemp + clone + checkout 冻结 commit + porcelain 自证） |
| `tests/rv2-engine-fixes.test.ts` | 新建 | §5 条款 |
| `tests/u3-*.test.ts`、`tests/u5-e2e-sh.test.ts`、`tests/u4a-verify.test.ts`、`tests/u2-review-submit*.test.ts` | 适配 | 因规则⑦/marker 扩展/必填校验需要的增量用例与必要断言适配；禁改既有断言语义、禁删测试 |

## 3. 禁改清单（违反 = FAIL）

- `src/runner/` 全域、`src/core/`、`src/store/`、`src/readonly/`、`src/cli.ts`、`src/dispatch.ts`、`src/testrun/{types.ts, registry.ts, vitest.ts}`、`src/verify/{name-match.ts, red-phase.ts, contract-match.ts}`
- 事件 schema（`src/events/types.ts` 除新增常量导出外零变更）、fold 投影、账本行为
- `docs/`、`archive/`、配置文件

## 4. 关键口径（锁定）

- **规则⑦是入口约束不是追溯清洗**：只拦截新提交；既有账本（id 全部合规）不受影响。
- **两路同源**：gate 与 e2e-sh 的 id 合法集由同一常量派生，不允许两处手写正则漂移。
- **exec-review 强制的例外面为零**：不提供跳过 flag；`--evidence-refs ""` 空串等价缺失（既有空数组清洗行为保留，清洗后为空按缺失 fail）。
- **parse 失败落盘是审计增量**：不改变 parse 失败在 verify 结果中的既有判定语义（fail + reason 进 stderr），只补 `<id>.report.json` 产物。
- **checkout 根解析只影响 clone 源**：冻结 commit 的 checkout、porcelain 干净性判定、临时目录生命周期全部不变。
- 消息文案全部遵循「错误 → 权威源 → 恢复动作」结构（与既有 fail 消息风格一致）。

## 5. 新增测试条款（tests/rv2-engine-fixes.test.ts，真实账本/tmp/git/子进程，零 mock）

- **T1 规则⑦拦截**：spec 含 id `TC 1`（空格）、`中文用例`、`.开头`、`A_1`（合法）等多种形态——`TC 1`/`中文用例`/`.开头` 被拒且消息含字符集说明；`A_1`、`TC.1`、`a-b` 通过。
- **T2 marker 同源扩展**：e2e-sh 脚本输出 `TC.1 PASS` / `a_2 FAIL`——parse 正确折叠（`TC.1` pass、`a_2` fail）；`TC 1 PASS`（含空格）不匹配任何 marker（沿用无标记防线）。
- **T3 exec-review 必填**：unit verified 后 `review submit --verdict-kind exec-review --verdict pass`（无 refs）→ fail 且消息含已入账 runId 清单；带 `--evidence-refs <真实runId>` → 入账成功、fold 后 closed；带不存在 runId → 既有存在性校验 fail 不回归。
- **T4 replan 文案**：closed unit 重提 spec → 拒绝消息不含 `replan` 字样、含 `cw create` 恢复路径。
- **T5 parse 失败落盘**：构造验收 command 输出非 JSON（如 `echo not-json`）走 vitest 路由 → `<id>.report.json` 存在且 `{ parseError: true, commandExit: <真实exit>, reason: <含 parse 失败说明> }`；同 run 的正常条目 report.json 不受影响。
- **T6 子目录 verify**：tmp git 项目，从其子目录运行 verify 链（handlers 层或 runAcceptances 直调）→ 不再因 clone 源错误而环境错误；在非 git 目录运行 → 报错含恢复动作。
- **T7 回归**：u3 / u5-e2e-sh / u4a / u2-review 相关既有测试全绿。

## 6. 通过命令

```
cd <仓库根> && npm run check
npx vitest run tests/rv2-engine-fixes.test.ts tests/u3-spec-rules.test.ts tests/u5-e2e-sh.test.ts tests/u5-vitest.test.ts tests/u4a-verify.test.ts tests/u4a-e2e.test.ts tests/u2-review-submit.test.ts tests/u2-e2e.test.ts
npx eslint src/events/types.ts src/gates/spec-rules.ts src/testrun/e2e-sh.ts src/handlers/review-submit.ts src/handlers/evidence-submit.ts src/verify/run.ts src/verify/checkout.ts tests/rv2-engine-fixes.test.ts
```
（u3/u2 等具体文件名以仓库实际为准，跑全量 `npx vitest run tests/u2*.test.ts tests/u3*.test.ts tests/u4a*.test.ts tests/u5*.test.ts` 亦可）

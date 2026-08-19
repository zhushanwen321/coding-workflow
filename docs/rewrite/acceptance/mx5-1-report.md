# mx5-1 验收报告：spec gate 规则⑨ + VerifyRanPayload.parseFailedAcceptanceIds

> verifier：独立第三方（与 developer 无关），2026-08-19。全部结论以亲手复跑的机器证据为准。
> 交付 commit：`e29238e`；基线：`docs/rewrite/acceptance/mx5-1-acceptance.md`（sha256 `d919e674145a8d0e9f8a9c186799911795c4e7c5b05305766ca9b701da16db52`，验收开始与结束两次计算一致——条款区未被篡改）。

## 总结论：PASS

7 项验收全部 PASS；2 个 minor findings（测试区分力缺口 + status 行流程观察），不阻断。抽查③按任务书预期应红而实测无红，如实记录并转化为 finding-1——根因是基线 R 系条款本身未锁定「恰为 json vs 含 json 子串」边界，developer 按基线交付无过错，不构成 FAIL。

## 环境事实（影响证据归因）

- 验收时 HEAD = `9fd2c87`（mx5-3 的后续 commit，仅动 `src/runner/brief.ts` + 自有测试 + 基线 status 行）。`git diff e29238e..HEAD -- <mx5-1 交付文件 + 全部禁改路径>` 输出 0 行——mx5-1 交付物在交付 commit 后零改动，全量绿的归因成立。
- developer status 行「全量 66 文件 501 绿」与 e29238e 时点自洽（当时 tests/ 恰 66 文件）；本次全量在 HEAD 跑出 67 文件 510 用例，多出的 1 文件 9 用例是 mx5-3 的新增测试（`tests/mx5-3-reviewer-brief.test.ts`）。

## 1. 防篡改链 — PASS

- `shasum -a 256 docs/rewrite/acceptance/mx5-1-acceptance.md` = `d919e674145a8d0e9f8a9c186799911795c4e7c5b05305766ca9b701da16db52`（开始/结束两次一致）。
- `git status --porcelain` = 仅 `?? .tmp/`（untracked），工作区干净，无 developer 残留。
- `git show --stat e29238e` 文件清单：`src/events/types.ts`(+11)、`src/gates/spec-rules.ts`(+142/-1)、`src/handlers/verify.ts`(+13/-4)、`tests/mx5-1-spec-rule9.test.ts`(新建 316)、`tests/mx5-1-parse-failed.test.ts`(新建 311)、基线文档 §8 status 行(1 行)。与基线 §2 交付物表一一对应；基线预期「registry.ts 仅当需要」——实际零改动，developer 备案偏离成立（复用 `src/verify/run.ts` 已导出的 `adapterTypeFor`，见验收项 2）。基线文档仅 §8 status 流转行被更新，条款区 §1-§7 逐字节未动（`git diff d1c9685..e29238e` 确认）→ 记 finding-2（流程观察），不算多改。

## 2. 禁改清单独立复核 — PASS

- `git diff d1c9685..e29238e -- src/testrun/ src/verify/ src/core/ src/store/ src/readonly/ src/runner/ src/cli.ts src/dispatch.ts src/handlers/{create,evidence-submit,review-submit,run}.ts` → 输出为空（含 `src/handlers/evidence-submit.ts`，基线 §3 隐含的 gate 调用方）。
- `adapterTypeFor` import 核实：`src/gates/spec-rules.ts` `import { adapterTypeFor } from "../verify/run.js"`；定义在 `src/verify/run.ts:213`（u4b/mx-2 既有导出，本 unit 未加 export——run.ts 零 diff）；签名 `(type: AcceptanceType, runner?: string)` 与 spec-rules 调用 `adapterTypeFor(ac.type, ac.runner)` 一致。
- 无循环依赖：run.ts 的 import 仅 node 内置 + `../events/types.js` + `../testrun/{registry,types}.js` + `./name-match.js`，不回引 spec-rules。
- 规则①-⑧零变更：diff 中 checkSpecRules 主体（①-⑧逻辑）无改动，仅头注释与函数 doc 注释追加⑨描述。

## 3. 验收命令复跑 — PASS

| 命令 | 结果 |
|------|------|
| `npm run check:all` | 通过（check + check:tests 零错误） |
| `npx vitest run tests/mx5-1-spec-rule9.test.ts tests/mx5-1-parse-failed.test.ts` | 2 文件 23 用例全绿（16 + 7，1.55s） |
| `npx eslint <5 个交付文件>` | 零输出（干净） |
| 全量 `npm test` | **67 文件 510 用例全绿，133.57s**（含 mx5-3 新增 1 文件 9 用例；规则①-⑧既有测试与 u4a/u4b exit 语义测试全绿） |

## 4. 条款级代码审查 — PASS（实现与基线无冲突）

规则⑨形状逐条对照基线 §4：

- 路由：`ADAPTER_FLAG_CONTRACTS[adapterTypeFor(ac.type, ac.runner)]`——与 verify 执行时同一函数同一路由（单一事实源，无复制实现）。
- vitest/playwright 共用 `jsonProductContract`：`--reporter` 空格形式（下一 token 缺失或为 flag 报「取值缺失」缺口、值≠json 报缺口）与 `--reporter=` 等号形式（切片值≠json 报缺口）全覆盖；值恰为 json 通过（存量 includes 幂等）。`--outputFile` 任何形式（`--outputFile` / `--outputFile=...`）报缺口。
- pytest `noQuietContract`：`--quiet` 精确匹配 + 短选项簇 `SHORT_OPTION_CLUSTER_RE=/^-[^-]+$/` 且 `includes("q")`——簇逐字符展开的等价实现，`-q/-qq/-vq/-qqq` 全命中；`--tb=no` / `-p no:cacheprovider` 不设禁。
- e2e-sh / manual：不在契约表 → 跳过，不设静态规则；含 `--reporter=verbose` 不拒（R5 实证）。
- 文案：`规则⑨: 验收 <id> 的 command 含冲突 flag "<flag>"（值=…）。<冲突事实>恢复动作：删除该 flag——cw 会自动追加正确的 reporter。`——含验收 id + flag 名 + 取值 + 事实 + 恢复动作，编号⑨进命名序列。
- 多缺口全列：循环逐条 push 无短路，与①-⑧缺口合并输出（R7 实证序号升序）。
- 单一事实源可扩展枚举：`ADAPTER_FLAG_CONTRACTS` 单表。
- command 缺失（unit/integration 合法缺省）不触发；非法 runner 由规则⑧拦、路由结果不在表即跳过（不双重报错）。

提取逻辑对照基线 §2：

- 提取锚：`outcome.results.filter((r) => r.parseError === true && r.nameSkipped !== "nondeterministic")`（handlers/verify.ts）。豁免判定字段核实：`exemptNondeterministic`（run.ts:237-255）返回 `parseError: fail.parseError`（照录 true）+ `nameSkipped: "nondeterministic"`——豁免条目 parseError 仍为 true，排除条件必要且与 run.ts 改写逻辑一致（红性抽查②实证其区分力）。
- 无解析失败不写键：`...(parseFailedIds.length > 0 ? {...} : {})`——空数组时键不存在（P2/P5 按落盘 JSONL 字节断言）。
- result 语义零变化：result 仍由 regularFailed/redErrors 决定，新键只做投影分类（P1 解析失败照旧 fail、P4 豁免 pass、全量 u4a/u4b exit 0/1/2 语义测试全绿）。
- types.ts 注释含封闭枚举语义（不含 e2e-sh 无标记 exit≠0）+「result 判定语义不变」+ 旧账本缺字段兼容——齐备。

## 5. 测试强度审查（防假绿）— PASS（1 个 minor 缺口 → finding-1）

- R1：exit 1 + 规则⑨ + id + flag 名 + 恢复动作 + 不入账六重断言，强。
- R2：verbose 空格形式拒（断言「值=verbose」文案）+ =形式 json 过 + 空格形式 json 过，三用例独立。
- R3：outputFile 两种形式各自独立用例。
- R4：`-q`/`--quiet`/`-qq`/`-vq` 四独立用例 + 裸 pytest 对照通过。
- R5：e2e 含 verbose + manual 含三种毒 flag 均不拒，断言 `not.toContain("规则⑨")` + 入账。
- R6：路由优先级双向（`runner: "pytest"` + type unit 拒 / 同命令无 runner 过）+ 缺省推导两方向（integration→vitest 拒、e2e-real→e2e-sh 不拒）。
- R7：三缺口全列 + `indexOf` 序号升序断言（rule③ < 规则⑨A2 < 规则⑨A5）——同时含两个验收 id 的缺口断言，强。
- P1：直写账本绕过 gate（毒 spec 在规则⑨后的唯一入场形态，即 mx5-2 回炉消费场景）→ 真实 verify → 落盘字节断言 `parseFailedAcceptanceIds: ["A1"]` + `result: "fail"` + `acceptanceIds: ["A2"]`。
- P2：真实 bash 子进程 `echo boom >&2; exit 3` 跑出 exit≠0（非构造数据）→ 落盘字节断言键不存在。
- P3/P4/P5/P6：exit 0 无标记入列 / 豁免不入列且 result=pass / 全 pass 与断言失败均无键 / 旧五字段重放 `toEqual(oldRun)` 恰五键 + status=created。
- 缺口：无「取值含 json 子串但非恰 json」（如 `--reporter=json-verbose`）用例——见 finding-1。

## 6. 红性抽查（3 条，全部恢复）— ①②真红确认；③无红（转 finding-1）

1. 删 pytest 簇展开（`SHORT_OPTION_CLUSTER_RE` 条件退化为 `-q` 精确枚举）→ R4 `-qq`/`-vq` 两用例红（`2 failed`），`-q`/`--quiet` 仍绿。→ 恢复，`git status` 干净。
2. 删豁免排除条件（`&& r.nameSkipped !== "nondeterministic"` 移除）→ P4 红（tests/mx5-1-parse-failed.test.ts:225 键存在断言失败）。→ 恢复，干净。
3. 「恰为 json」放宽为「含 json」（空格与等号两形式都改为 `!value.includes("json")`）→ **R 系 16 用例全绿，无任何用例红**——与任务书预期「R1 verbose 必须红」不符：`verbose` 不含 `json` 子串，放宽后仍被拒。该方向现有测试无区分力，如实记录为 finding-1。→ 恢复，`git diff --stat` 空。

三条抽查后 `git status --porcelain` 均仅 `?? .tmp/`（与验收开始时一致），无残留改动。

## 7. V1 波后场景（基线 §7）— PASS

隔离 CW_HOME（`/tmp/cw-mx51-v1-*`，用毕已清）+ 真实 CLI 子进程（`node dist/cli.js`，完整 dispatch 路径），按三跑证据 leaf-app v3 冻结 spec 同款构造（A1 合规 e2e / A2、A4、A5 unit 带 `--reporter=verbose` / A3 裸 `pnpm build` e2e-real / A6 合规裸 vitest unit）：

- `evidence submit --kind spec` → **exit 1**，stderr 逐条列出 A2/A4/A5 缺口：

  ```
  规则⑨: 验收 A2 的 command 含冲突 flag "--reporter=verbose"（值=verbose）。vitest/playwright 适配器由 cw 自动追加 --reporter=json，…JSON 解析恒挂、验收恒判 fail。恢复动作：删除该 flag——cw 会自动追加正确的 reporter。
  规则⑨: 验收 A4 的 command 含冲突 flag "--reporter=verbose"（值=verbose）。…
  规则⑨: 验收 A5 的 command 含冲突 flag "--reporter=verbose"（值=verbose）。…
  ```

- `grep -q "A3" submit.err` → 不命中（A3 未列，e2e 诚实边界）；账本 `grep SpecSubmitted` → 不含（毒 spec 不入账）。
- 合规对照 spec（A1 e2e + A3 裸 build + A6 裸 vitest + A7 `--reporter=json`）→ **exit 0**，stdout `unit "leaf-clean" 的 spec 已入账（specHash 7477d3e6…，seq 3）`，账本 SpecSubmitted 计数恰 1。
- V1 tmp 目录已删除（`ls -d /tmp/cw-mx51-v1-*` no matches）。

## Findings

1. **[minor｜测试区分力缺口｜tests/mx5-1-spec-rule9.test.ts]** 基线 §4 锁定「取值必须恰为 json」，但 R 系无「含 json 子串但非恰 json」形态（如 `--reporter=json-verbose`、`--reporter=jsonx`）的拒录用例。红性抽查③实证：实现放宽为 `includes("json")` 后 16 用例仍全绿，防不住该回归。建议 mx5-2 或后续波次补一条用例（实现本身正确，缺口在基线测试条款设计）。
2. **[minor｜流程观察｜docs/rewrite/acceptance/mx5-1-acceptance.md]** 基线开头写「developer 与 verifier 禁止修改」，但 §8 status 行由 developer 在交付 commit 中更新（`pending → building` → 交付声明，仅此 1 行，条款区零改动，mx5-3 同款惯例）。防篡改目的未受损害，不阻断；建议后续波次把 status 行明确划出禁改范围，消除文句与惯例的张力。

## 判定一览

| # | 验收项 | 判定 |
|---|--------|------|
| 1 | 防篡改链 | PASS |
| 2 | 禁改清单独立复核 | PASS |
| 3 | 验收命令复跑 | PASS |
| 4 | 条款级代码审查 | PASS |
| 5 | 测试强度审查 | PASS（finding-1） |
| 6 | 红性抽查 | ①②真红；③无红 → finding-1（不阻断） |
| 7 | V1 波后场景 | PASS |

**总结论：PASS**（2 minor findings，供 mx5-2 与后续波次处置）。

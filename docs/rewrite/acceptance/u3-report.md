# u3 验收报告：spec gate 五规则

> verifier 独立验收产出（协调机制见 `docs/rewrite/orchestration.md`）。
> 结论先行：**PASS**。防篡改、限定命令实跑、9 条单测真实性、8 条行为对抗抽查全部通过；另记录 1 条不构成失败的实现级 minor 观察（§5）。

## 1. 防篡改检查

| 检查项 | 结果 |
|--------|------|
| 验收基线 commit | `01fd5775f2c6cdf93a604ced98efd810628a5537`（验收时 HEAD 即该 commit） |
| `git diff 01fd577 -- docs/rewrite/acceptance/u3-acceptance.md` | 输出为空——验收文档与基线逐字节一致 |
| `git status --short docs/rewrite/acceptance/u3-acceptance.md` | 无输出——工作区无改动 |
| 验收文档 sha256 | `91f460d9b404a5d58239fc6806864e2948bc4b5b6355e3f017bb617b530b5b3f` |
| 全量 `git status --short` | 仅 4 类内容：① u3 交付物 `src/gates/`（内含且仅含 `spec-rules.ts`）与 `tests/u3-spec-rules.test.ts`；② 会话前已存在的 `AGENTS.md`(M) 与 5 个 drawio 产物（派发指示明示忽略）；③ 无 u1 领地文件出现；④ 无其他任何新增/修改 |
| 禁改清单复核 | `git diff --stat HEAD -- tests/smoke.test.ts src/cli.ts src/index.ts archive/ docs/rewrite/` 为空——smoke/cli/index/archive/docs-rewrite 全部零触碰 |
| `src/events/types.ts`（u1 owner） | tracked 且无改动；`checkSpecRules` 的 `AcceptanceType`/`SpecRulesResult`/`SpecSubmittedPayload` 全部 import 自该文件——满足「只许 import，禁止修改」 |

## 2. 命令实跑（按派发限定范围）

> `npm test` 全量因 u1 并行开发不作为 u3 验收依据（派发指示）；验收时工作区无 u1 中途文件，限定命令无并行干扰。

| 命令 | 结果 |
|------|------|
| `npm run check:all` | exit 0（`tsc --noEmit` + `tsc --noEmit -p tsconfig.test.json` 均过；tsconfig.test.json include `tests/**/*.ts`，u3 测试文件确认在类型检查覆盖内） |
| `npx vitest run tests/u3-spec-rules.test.ts` | exit 0——`Test Files 1 passed (1)` / `Tests 13 passed (13)`（9 条验收用例 + 4 条边界用例） |
| `npx eslint src/gates/spec-rules.ts tests/u3-spec-rules.test.ts` | exit 0，零输出（零 error 零 warning） |

## 3. 单测验收 9 条对照（防空洞断言逐条核查）

| # | 验收条款 | 判定 | 依据 |
|---|----------|------|------|
| 1 | 合法 spec → ok=true, failures=[] | PASS | 用例含 core e2e-real（command=`node -v`）+ 非 core unit + e2e-mock（带保真说明）；断言 `expectOk=true` 且 `failures.length === 0` 双保险 |
| 2 | 空 acceptance → rule① | PASS | mustContain `rule①`；另锚定完整序列 `[rule①, rule⑤]`（空 acceptance 必然也无 unit 用例，顺带锁定不短路行为） |
| 3 | core manual → rule② 与该 id | PASS | mustContain `rule②`/`A1`/`manual`；mustNotContain ①③④⑤——精确触发、无误报 |
| 4 | e2e-real 无 command → rule③ 与该 id | PASS | mustContain `rule③`/`A1`/`缺可执行 command`；mustNotContain ②⑤ |
| 5 | 首 token 不存在 → rule③ | PASS | mustContain `no-such-bin-xyz`（仅 PATH 不可解析消息含此 token）+ mustNotContain `缺可执行 command`——真实区分「缺 command」与「command 不可执行」两种 rule③ 失败模式 |
| 6 | e2e-mock 无保真说明 → rule④ 与该 id | PASS | mustContain `rule④`/`A1`/`mock 保真说明`；mustNotContain ③⑤ |
| 7 | 无 unit 用例 → rule⑤ | PASS | mustContain `rule⑤`；mustNotContain ①②③④ |
| 8 | 多缺口升序全列出（不短路） | PASS | `ruleTags(failures)` 与 `[rule②, rule③, rule④, rule⑤]` 做数组 `toEqual` 深比较——检查完整顺序与内容，非只查长度 |
| 9 | 非 core manual 不触发 rule② | PASS | spec 含非 core manual 项且 `expectOk=true`——ok=true 要求 failures 全空，比只断言「无 rule②」更强（其他规则零误报一并锁定） |

另 4 条边界用例（command 全空白、mockFidelityNote 全空白、core e2e-mock 合法、绝对路径 command 解析）不在 9 条验收内，为实现分支的附加锁定。

## 4. 行为对抗抽查（临时脚本于 /tmp，esbuild bundle + node 直调 `checkSpecRules`，未进仓库）

| # | 场景 | 期望 | 结果 |
|---|------|------|------|
| adv1 | core 用例 type="integration"（非 e2e） | 被 rule② 拒（failure 含 id 与 type） | PASS |
| adv2 | e2e-real command="ls -la"，无其他问题 | 通过 rule③，整体 ok=true | PASS |
| adv3 | core 用例 type="unit" | rule② 拒（rule② 作用域 = 一切非 e2e） | PASS |
| adv4 | command=`./no-such-dir-xyz/bin foo`（含路径分隔符分支） | rule③ PATH 不可解析 | PASS |
| adv5 | 同一 e2e-mock 用例双缺口（command 不可解析 + 缺保真说明） | rule③ → rule④ 同 id 升序都列出 | PASS |
| adv6 | 两个 core manual 用例 | 两条 rule② 按 acceptance 顺序逐条列出 | PASS |
| adv7 | 同一输入两次调用 | 结果逐字节一致（确定性纯函数） | PASS |
| adv8 | 仅缺 unit 用例（e2e-real 带合法 command） | 只报 rule⑤，rule③ 不误报 | PASS |

过程记录（证据完整性）：adv5 首跑显示 FAIL，经查是验证脚本自身断言错误——该用例未放 unit 项，rule⑤ 理应同时出现；实现实际输出的三缺口序列（rule③, rule④, rule⑤）正确。修正脚本断言后 8/8 全绿。实现行为全程未被证伪。

## 5. 实现级观察（minor，不构成失败）

- `isResolvableOnPath` 对含路径分隔符的 command 用 `accessSync(X_OK)` 判定，目录会通过（如 `command="/tmp foo"`）；代码注释自称「与 which 行为一致」，实测 macOS `which /tmp` 返回 not found（exit 1）而 `accessSync("/tmp", X_OK)` 通过——注释表述与事实有偏差。属退化边界（正常 spec 不会写目录当 command），五规则判定语义与 9 条验收用例均不涉及，不判 fail。后续如需收紧可加 `statSync().isFile()`。

## 6. 总结论

**PASS**。理由：

1. 验收文档未被篡改（基线 diff 为空 + sha256 记录在案）；
2. 交付物恰好落在声明的两个文件（`src/gates/spec-rules.ts`、`tests/u3-spec-rules.test.ts`），禁改清单与 u1 领地零触碰；
3. 三条限定命令全绿（类型检查 / 13 测试全过 / eslint 零告警）；
4. 9 条单测验收逐条真实覆盖条款语义（含 #8 完整顺序深比较、#5 双失败模式区分）；
5. 8 条对抗抽查（含派发指定的 integration 拒绝与 `ls -la` 放行）无一证伪实现行为。

# u5 验收报告：TestRun 缝 + vitest / e2e-sh 适配器（纯函数层）

> verifier 独立验收报告（orchestration.md §角色：不修代码、不改验收文档）。
>
> **总结论：PASS**

## 1. 防篡改核对

| 项 | 结果 |
|----|------|
| 验收基线 commit | `115e52c94420ec58a81ca39a49c310436f9296e7`（feat(m0): testrun contract layer + acceptance baselines for u4a/u5） |
| `u5-acceptance.md` sha256（工作区） | `fe93e5b2e95ea3215ff9287197c2fdfa2fbae24d7b7822f847eec01aea3154bd` |
| `u5-acceptance.md` sha256（基线 blob） | `fe93e5b2e95ea3215ff9287197c2fdfa2fbae24d7b7822f847eec01aea3154bd`（一致，零篡改） |
| `git diff 115e52c -- docs/rewrite/acceptance/u5-acceptance.md` | 空 |
| 契约层与已验收 unit 零改动（`git diff 115e52c --stat -- src/testrun/types.ts src/dispatch.ts src/cli.ts src/events/types.ts src/store/ src/core/ src/gates/ src/readonly/`） | 空（exit 0，无 stat 输出） |
| `git status --short` | u5 领地 5 文件新增（`src/testrun/{vitest,e2e-sh,registry}.ts`、`tests/u5-{vitest,e2e-sh}.test.ts`）；u4a 领地豁免（`src/handlers/index.ts` M + `src/handlers/verify.ts` + `src/verify/` + `tests/u4a-verify.test.ts`）；认知外豁免（AGENTS.md M、drawio 系）。无越界 |

u4a 领地豁免复核：`src/handlers/index.ts` 的改动仅新增 `handleVerify` 接线（import `./verify.js` + commands 追加 verify 条目），与 u5 文件零关联——u5 未接线 handlers，符合验收文档「不接线 verify」约束。

## 2. 命令实跑（限定范围）

| 命令 | 结果 |
|------|------|
| `npx vitest run tests/u5-vitest.test.ts tests/u5-e2e-sh.test.ts` | **2 files / 14 tests 全绿**（Duration 3.13s） |
| `npx eslint src/testrun/vitest.ts src/testrun/e2e-sh.ts src/testrun/registry.ts tests/u5-vitest.test.ts tests/u5-e2e-sh.test.ts` | 零输出，exit 0 |
| `npm run check:all`（tsc src + tests） | 通过（u4a 中途态未导致编译失败，无需豁免记录） |

真实性旁证：三个 vitest fixture 用例单条耗时 1.0-1.1s（真实子进程跑 vitest 的量级），e2e-sh 组 663ms（真实 sh 子进程），非手写 JSON 的瞬时断言。

## 3. 单测 8 条逐项对照（真实性抽查）

| # | 验收条款 | 测试落点 | 真实性判定 |
|---|---------|---------|-----------|
| 1 | vitest fixture 真实生成（smoke ≥3 全 pass） | `tests/u5-vitest.test.ts` 验收#1：`spawnSync npx vitest run tests/smoke.test.ts --reporter=json` 真跑，stdout 落 tmp 再 parse；断言 status=0、cases ≥3、全 pass、id 恒 A1 | 满足——spawnSync 真实子进程，非手写 JSON |
| 2 | 失败用例 fixture | 验收#2：tmp 写真实测试文件（1 断言失败）+ `--root` 指向 tmp 跑真 vitest；断言 exitCode=1、fail/pass case 各 1、name 含标题；附加矛盾输入（exitCode=0 传入）以断言为准 | 满足 |
| 3 | 非法 JSON 抛错 | 验收#3：真跑默认 reporter（人类可读输出天然非 JSON）落盘 → `expect(() => parse(...)).toThrow(/不是合法 JSON/)` | 满足——真实 try/throw 断言，非调用即弃 |
| 4 | translate 不重复追加 / 默认命令 | #4a 原样返回、#4b 无 command 默认串、边界：缺 flag 追加 | 满足 |
| 5 | e2e-sh fixture 真实生成 | `tests/u5-e2e-sh.test.ts` 验收#5：tmp 写 sh 脚本（echo A1 PASS/A2 FAIL + exit 1）chmod 755 后 spawnSync 执行、stdout 落盘再 parse；断言 cases=[A1 pass, A2 fail] | 满足——真实脚本子进程 |
| 6 | 三条防线 | #6a 无标记+exit0 → `toThrow(/无标记行且 exitCode=0/)`；#6b 无标记+exit≠0 → cases=[{A1,no-markers,fail}] 不抛；#6c id 不符 → `toThrow(/A9.*A1\|A1.*A9/)` | 满足——三条分别独立用例 |
| 7 | 同 id 重复最后为准 | #7：真实脚本输出重复行 → cases=[{A1, "A1 FAIL", fail}] | 满足 |
| 8 | registry 两 key | #8：size=2、has vitest/e2e-sh、type 与 key 一致 | 满足 |

## 4. builder 两处规格歧义裁决评判

**裁决 1（「标记 id 与验收 id 不符抛错」= 无任何标记 id 命中验收 id 才抛错）**：与验收文档自洽，且是唯一自洽读法。理由：验收条款 5 的 fixture 本身就是「验收 id=A1 + 输出含 A2 标记」且预期 cases 同时含 A1/A2——若采「任何不符即抛」的严格读法，条款 5 自相矛盾。实现（`e2e-sh.ts:65` `!markers.has(acceptance.id)` 才抛）与源码注释（`e2e-sh.ts:12-14`「条目 5/6 的相容口径」）一致，且完全不命中时错误信息同时含出现 id 与期望 id（条款 6 要求满足）。**判定：相容。**

**裁决 2（标记行捕获组拼回 "A" 前缀，cases id 形如 A1）**：与验收文档自洽。理由：验收条款 5 锁定预期 `cases=[{id:"A1"},{id:"A2"}]`，而正则捕获组 `[A-Za-z0-9-]+` 不含字面 A——要同时满足两者，id 必须拼回 A 前缀（即第一列全文为 id）。实现（`e2e-sh.ts:48` `` markers.set(`A${match[1]}`) ``）与注释（`e2e-sh.ts:40-41`）一致。**判定：相容。**

## 5. 行为对抗抽查（tsx 直调 src 纯函数，共 17 条探针）

前 13 条（/tmp/u5-adversarial.ts）全部 PASS：

1. skipped/todo 断言（手写 JSON 探针）映射 fail——符合「M0 不认 skip」
2. vitest 形状不符三连：缺 testResults / 缺 assertionResults / 缺 name 来源均抛错，不降级伪造
3. fullName 缺失退 title
4. translate：已有 flag 原样、缺 flag 追加、空串 command 视为缺失走默认全量
5. e2e-sh 标记行边界（前导空格、`>` 前缀、小写、尾随空格、尾缀文本、B 前缀）全部不匹配正则——非标记行 + exit≠0 走整体 fail 分支
6. 裁决 1 行为验证：A9+A1 并存且验收 A1 时不抛错，cases 含全部标记
7. 连字符 id（A-1）重复标记最后为准；CRLF 行尾可解析
8. defaultRegistry 每次返回新 Map（调用侧增删互不污染）

后 4 条（/tmp/u5-adversarial2.ts）：

9. **真实 vitest skipped/todo fixture**（tmp 真跑 `it.skip`/`it.todo`，非手写 JSON）：exitCode=0 但 cases=[通过 pass, 跳过 fail, 待办 fail]——与验收文档「矛盾输入以断言为准、skipped/todo → fail」一致
10. `--reporter=json,verbose` 组合形式不重复追加（includes 语义，源码注释声称的行为实测成立）
11. 完全不命中抛错，信息含出现 id 与期望 id
12. 探针「B7 出现在不命中错误信息中」初判 FAIL 后修正：`B7 PASS` 按锁定正则 `^A(...)` 本就不是标记行（id 锚定 A 前缀），出现列表只含 A9 是规格内行为，非缺陷

## 6. 观察项（不构成 FAIL，记录备查）

- `vitest.ts:72` translate 用 `includes` 子串匹配判断 flag 已存在：`--reporter=json-xxx` 类前缀同名 flag 会被误判为已有（vitest 现无此类 reporter，理论边界）。
- `e2e-sh.ts:22` 非 A 前缀的 `X1 PASS` 行被静默忽略：若与合法标记混出会静默丢失该行；若独占且 exit=0 则被「无标记」防线拦截。均为锁定正则的直接推论，与验收文档一致。
- `tests/u5-vitest.test.ts:62-70` beforeAll 在 dist 缺失时自行 build——测试自带兜底，不动仓库构建配置，无越界。

## 7. 总结论

**PASS**。防篡改（sha256 一致、契约层零改动、无越界文件）、命令实跑（14 测试全绿 + lint 零输出 + check:all 通过）、单测 8 条真实性（fixture 均真实子进程生成、断言真实）、两处裁决与验收文档自洽、17 条对抗探针无一条与验收文档矛盾。

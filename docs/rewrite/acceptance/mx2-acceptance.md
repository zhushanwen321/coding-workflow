# mx-2 验收标准：pytest + playwright 适配器 + 框架显式声明路由

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：2026-08-18 五角度对抗审查（testrun D1/D2：canon §6.1「框架发现 = plan 显式声明（选）」未实现，type→适配器硬映射使多语言验收不可表达）+ 用户裁决（多语言适配做，先支持 ~/Code 用到的——调研定案：pytest 4/4 py 项目全覆盖、playwright ts 侧第二主流、vitest 已有；jest 零使用不做）。
> 环境：本机 python3.12 + pytest 8.3.0、playwright 1.62.1 + chromium 均已安装（可全真实验收）。
> 依赖：rv-2 committed 后派发（events/types.ts、gates/spec-rules.ts、testrun/e2e-sh.ts 领地接力）。

## 1. 目标

验收可显式声明测试框架（`runner` 字段覆盖 type 默认推导）；py 项目（pytest）与 playwright e2e 项目（playwright test）的验收走原生适配器机器判定——canon §6.1「适配器选择是确定性查找」落地，§6.1 与 §4/§5.1 的内部矛盾消解。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/events/types.ts` | +字段 | `AcceptanceItem.runner?: string`（可选；缺省按 type 推导。注释注明合法值来自 TestRun registry，显式声明优先——canon §6.1 裁决 A） |
| `src/testrun/registry.ts` | 修改 | defaultRegistry 注册 `pytest`、`playwright`；导出 `knownAdapterTypes(): readonly string[]`（供 gate 校验） |
| `src/testrun/pytest.ts` | 新建 | TestRunAdapter 实现：**translate** 追加 `-v --tb=no -p no:cacheprovider`（已有同名 flag 不重复加，幂等检查同 vitest 模式；cacheprovider 禁写 .pytest_cache——环境隔离纪律）；**parse** 解析行格式 `^(\S+\.py)::(\S+) (PASSED\|FAILED\|ERROR\|SKIPPED\|XFAIL\|XPASS)$`——PASSED→pass；FAILED/ERROR→fail；SKIPPED/XFAIL/XPASS→fail（M0 不认 skip 口径，与 vitest 对齐，注释注明）；无匹配行且 exit 0 → 抛错（无区分力防线，对齐 e2e-sh「无标记行且 exit 0」语义）；错误消息含恢复动作（确认 command 是 pytest 命令、或改 runner/type 路由） |
| `src/testrun/playwright.ts` | 新建 | TestRunAdapter 实现：**translate** 追加 `--reporter=json`（幂等）；**parse** 解析 playwright JSON（递归 suites → specs → tests → tests[].results[] 逐条：status expected→pass；unexpected/flaky/skipped/interrupted→fail，注释注明 skipped→fail 口径）；JSON 形状校验失败抛错绝不伪造 cases（对齐 vitest）；case 的 name 取 `suite title > spec title > test title` 拼接（名字比对锚，词边界匹配验收 id 的模式与 vitest 一致）；无 results 且 exit 0 → 抛错 |
| `src/verify/run.ts` | 修改 | `adapterTypeFor(type)` → `adapterTypeFor(type, runner?)`：runner 非空优先返回（确定性查找），空则按 type 现状推导；调用点透传 `acceptance.runner` |
| `src/gates/spec-rules.ts` | +规则⑧ | `runner` 字段存在时必须在 `knownAdapterTypes()` 集合内，否则 fail（消息含合法值清单 + 恢复动作）；缺省不校验（推导路径） |
| `src/handlers/spec-schema.ts` | 修改 | typebox schema 加可选 `runner` 字段（与领域类型同枚举校验链） |
| `tests/mx2-pytest.test.ts` | 新建 | §5 T1-T3（真实 python3 子进程 + tmp pytest 项目） |
| `tests/mx2-playwright.test.ts` | 新建 | §5 T4-T6（真实 npx playwright test + chromium + tmp playwright 项目） |
| `tests/mx2-runner-routing.test.ts` | 新建 | §5 T7-T9 |
| `tests/u5*.test.ts`、`tests/u4a*.test.ts` | 适配 | registry 扩容的路由断言增量；禁改既有断言语义 |

## 3. 禁改清单（违反 = FAIL）

- `src/runner/` 全域、`src/verify/{red-phase,checkout,name-match,contract-match}.ts`、`src/core/`、`src/store/`、`src/readonly/`、`src/cli.ts`、`src/dispatch.ts`、`src/testrun/e2e-sh.ts`（rv-2 领地已定型）、`src/testrun/vitest.ts`
- `TestRunAdapter`/`EvidenceReport` 接口零变更（canon B.2 已锁）；事件 schema 除 `runner` 可选字段外零变更
- `docs/`、`archive/`、配置文件；不安装任何 npm/pip 依赖（适配器面向「项目自带 pytest/playwright」的既有生态，cw 不引入依赖）

## 4. 关键口径（锁定）

- **显式优先、推导兜底**：`runner` 字段是唯一显式声明通道；缺省行为与现状逐字节一致（存量验收零影响——回归锁）。
- **适配器零依赖原则**：translate 只追加 flags，不注入插件（pytest 不用 pytest-json-report——外部插件不可假定；文本行解析是零依赖确定性通道）；playwright 用原生 `--reporter=json`。
- **skipped 即 fail**（两适配器统一）：M0 口径「不认 skip」防用 skip 逃逸验收；注释注明出处。
- **无区分力防线统一**：解析出零条 + exit 0 = 抛错（同 e2e-sh/vitest 家族语义）——防「命令空转也 pass」。
- **pytest 行格式锚**：`file.py::test_name STATUS`（-v 模式稳定输出）；末行 summary 行（`==== 2 passed in 0.1s ====`）不匹配条目正则、自然忽略。
- **playwright case name 拼接含层级**：名字比对按词边界匹配验收 id，层级拼接保证 id 出现在 fullName 即可命中（对齐 vitest 的 describe/it 模式）。
- **runner 值大小写敏感**（"pytest" 全小写，与 registry key 一致）；非法值由规则⑧在 spec 提交时拦（verify 侧不再二次校验——gate 是唯一入口，注释注明）。

## 5. 新增测试条款（零 mock，全部真实子进程）

### tests/mx2-pytest.test.ts（tmp 建真实 pytest 项目：conftest.py + test 文件，python3 -m pytest 真跑）
- **T1 真实通过/失败判定**：2 条测试（1 pass 1 fail，fail 用真实断言失败）→ EvidenceReport：cases 2 条、fail 条 status=fail、exitCode 非 0；名字比对：验收 id 出现在 test 函数名 → pass 命中。
- **T2 翻译幂等与纪律**：command 已含 `-v` / `--tb=no` 时不重复追加；translate 后命令含 `-p no:cacheprovider`；跑完 tmp 项目内无 `.pytest_cache` 目录。
- **T3 无区分力防线**：command 指向存在但零测试的 pytest 项目（exit 0、零条目行）→ parse 抛错（消息含恢复动作）；SKIPPED 测试（真实 skip：`@pytest.mark.skip`）→ status=fail。

### tests/mx2-playwright.test.ts（tmp 建真实 playwright 项目：playwright.config.ts + 2 个 spec（1 pass 1 fail），npx playwright test --reporter=json 真跑，chromium headless）
- **T4 真实通过/失败判定**：spec 内 1 个 pass test + 1 个 fail test（真实 expect 失败）→ cases 判定正确、exitCode 非 0。
- **T5 翻译与名字比对**：translate 幂等（已含 --reporter=json 不重复）；验收 id 出现在 test title → 词边界命中；describe/spec/test 层级拼接的 name 含全部层级文本。
- **T6 形状防线**：喂非 playwright JSON（如 `{}` 或 vitest JSON）→ parse 抛错不伪造 cases；skipped test（test.skip 真实跳过）→ fail。

### tests/mx2-runner-routing.test.ts
- **T7 显式优先**：`type: "unit"` + `runner: "pytest"` → 路由 pytest（不再强制 vitest——审查 D1 的核心缺陷修复）；`type: "e2e-real"` + `runner: "playwright"` → 路由 playwright。
- **T8 推导兜底回归**：无 runner 字段的 type 推导行为与现状一致（unit→vitest、e2e→e2e-sh）逐 case 断言。
- **T9 规则⑧**：`runner: "jest"` → spec 提交被拒、消息含合法值清单（vitest/e2e-sh/pytest/playwright）与恢复动作；`runner: "pytest"` 合法通过。

## 6. 通过命令

```
cd <仓库根> && npm run check
npx vitest run tests/mx2-pytest.test.ts tests/mx2-playwright.test.ts tests/mx2-runner-routing.test.ts tests/u5*.test.ts tests/u4a*.test.ts
npx eslint src/testrun/ src/verify/run.ts src/gates/spec-rules.ts src/handlers/spec-schema.ts src/events/types.ts tests/mx2-*.test.ts
```

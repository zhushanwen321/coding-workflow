# 项目约定审查报告（Subagent A）

- 审查范围：`git diff main...HEAD`（feat-recursive-problem-solving 分支）
- 审查维度：项目特定约定（状态机正确性 / Gate 完备性 / 引擎层类型边界 / CLI 契约）
- 审查依据：`skill/review-agents/project-conventions.md`
- 验证手段：tsc --noEmit（通过）+ vitest run 7 个相关测试文件（157 用例全过）+ 源码逐文件核查

变更概览：递归问题求解增强（C1 execute 返回 children / C2 frontier 只读命令 / C3 feature handoff FR-AC 渲染 / C4 design-review layerSpecific 字段名注入 / C5 retrospect forbidden→optional / C6 duplicate-split-slug gate + frontier lastStatusHistoryAction + 文档同步）。

---

## 子维度 1：状态机正确性 — pass

无 `WAVE_TRANSITIONS` / `PLANNING_TRANSITIONS` 改动，无新增 action 联合成员，guardWave / guardPlanning 未被触碰。本次变更未引入新推进 action（`frontier` 是只读查询，进 `READONLY_QUERIES` 而非 `ADVANCE_ACTIONS`，不经 dispatch / 不经 guard），故不触发「新增 action 未同步转换表」的 MUST_FIX 条件。

`replan` append-only 旁路（`src/rules/replan.ts`）未改；replan handler 仍走 `replan.from`（design-reviewed / executing），`to=undefined` 旁路语义不变。frontier 新增的 `lastStatusHistoryAction` 字段只是**只读派生**（从 statusHistory 末条读 action 字符串），不写 store、不改 status，不破坏 replan 不变式——`tests/frontier-dispatch-e2e.test.ts:FTC6` 覆盖了 replan 后该字段='replan' 的场景。

各 execute handler 返回的 `nextAction` 仍合法（execute → crossLayer.descend 到首个子层），`children` 字段是 ActionResult 的附加返回，不影响 nextAction 完整性。

---

## 子维度 2：Gate 完备性 — pass

C6 新增 `duplicateSplitSlug` / `featureDuplicateSplitSlug` / `epicDuplicateSplitSlug` 三个 gate（`src/rules/gates/design-review.ts`），均已正确接入三个聚合 runner：
- `runSliceDesignReviewGates`（`:580`）→ slice 12 个 gate
- `runFeatureDesignReviewGates`（`:814`）→ feature 14 个 gate
- `runEpicDesignReviewGates`（`:950`）→ epic 11 个 gate

三个 gate 都走 `runGateSafely(...)` 包装，与既有 gate 同模式，gate 结果会经 handler 短路逻辑 append 到 statusHistory（handler 层既有机制，本次未改）。gate 设计意图正确——slug 重复会导致 cw store 按 id save 时子层覆盖，机器显式校验填补了 `splitDagValid`（只查环不查重复）的盲区。

gate 失败 guidance 含具体重复 slug 列表（`report: duplicate-split-slug: ... 重复 slug（w1）`），符合「指引指向具体缺失/失败」的 SUGGESTION 期望。

覆盖测试充分：`tests/guidance-gates-spec.test.ts:GTC4/GTC5`（三 runner 各验 fail + pass）+ `tests/{slice,feature,epic}-gates.test.ts` 聚合计数已同步更新（slice 11→12 / feature 13→14 / epic 10→11）。

wave 的 `testCasesExecuted` / `testReferencesDesignReview` 精确匹配、`testsAllPass` exit code 判定、`commitExists` 校验逻辑均未触碰，无「关键检查被弱化」风险。

---

## 子维度 3：引擎层类型边界 — pass

**CwError vs CwEngineError 边界**：frontier 只读路径的两处 throw（`cli.ts:832` 缺 --root / `:836` unit not found）都用 `CwError`（预期错误），与 status/handoff 只读命令同模式（`cli.ts:796/800/812/816`），exit 1 映射正确。`mapExitCode`（`cli.ts:910`）未改，CwError/CwEngineError → exit 1、其余 → exit 2 的映射保持。

**store schema**：本次未改 `schema.ts`。`ChildInfo`（`src/handlers/types.ts`）是 ActionResult 的运行时返回字段，不是持久化 WorkUnitRecord 字段——持久化的子层 id 仍走既有的 `executeResult.childUnitIds` + `evidence.childDelivery`，schema 无需扩展。`frontier.ts` 的 `FrontierNode` / `FrontierResult` 是计算视图的输出类型，也不入 store。

**引擎层 any**：核查 `src/core/frontier.ts` / `src/core/hierarchy.ts` / `src/readonly/render.ts` / `src/rules/gates/design-review.ts` / `src/handlers/types.ts`，无裸 `any`。frontier.ts 用 `unknown` + 类型守卫（`typeof v === "string"` / `Array.isArray`）做磁盘数据降级，`as` 断言均带注释说明降级语义（与 render.ts readField/asArray 同模式）。hierarchy.ts 的 `resolveChildDependsOn` 是纯函数、零 IO，类型签名用 `ReadonlyArray<Split>` / `ChildDeliveryRecord` 精确收窄。

**import type 防循环**：frontier.ts 跨模块纯类型引用（`WorkUnitRecord` / `ChildDeliveryRecord` / `Split`）均用 `import type`；唯一运行时 import 是同层 `./hierarchy.js`（core→core，无循环风险）。render.ts 对 frontier 的引用是 `import type { FrontierResult }`（纯类型），未把 readonly↔core 的循环打进运行时。

**重复定义隐患（INFO，不阻塞）**：`WAVE_STATUS_TO_ACTION` / `PLANNING_STATUS_TO_ACTION` / `TERMINAL_STATUSES` 三张表在 `src/core/frontier.ts` 与 `src/readonly/render.ts` 各定义一份（frontier 注释已说明「core 层不能 import readonly，故重定义；若 status 枚举变化两处需同步，后续可提取到 core/status.ts」）。当前两份内容一致，但这是手维护的隐式不变式——未来 status 枚举新增时若只改一处，frontier 的 status→action 映射会与 handoff 渲染不一致，且无单测交叉校验两表同源。建议（非阻塞）补一条断言测试或真正提取到 `core/status.ts` 消除重复。

---

## 子维度 4：CLI 契约 — pass

**只读命令不写 store（关键）**：`frontier` 加入 `READONLY_QUERIES`（`cli.ts:164`），走 `runReadonly`（`:826-841`）。该分支只 `new CwStore(workspacePath)` + `store.load` + `computeFrontier`（内部仅 `load` / `findChildren`）+ `renderFrontier`（纯 JSON.stringify），**无任何 `store.save` / `appendStatusHistory` / `writeFile`**。核查 `src/cli.ts` 全文无 `.save(` 调用——store 写入只在经 dispatch 的 handler 内。frontier 严格保持只读语义，符合 `cli.ts:764-770` 的注释契约。

**exit code 映射**：`mapExitCode`（`:910`）未改。frontier 的 CwError throw（缺 --root / not found）会进 main 顶层 catch → `renderCliError` → exit 1，符合契约。

**dispatch platform-agnostic**：`src/dispatch.ts` 本次零改动，未引入 pi / claude-code / harness runtime 依赖。`computeFrontier` 的 store 依赖通过 `FrontierStore` 接口（`load` + `findChildren`）注入，CwStore 天然满足该接口，无 agent 特定耦合。

**参数解析**：`--root` 经 `flag(parsed, "root")` 解析（同时兼容 camelCase / kebab-case），缺失 → throw CwError，路径无断裂。frontier 不经 dispatch，故无「参数透传到 CwParams」要求。

**guidance 唯一导航**：frontier 是只读查询，非推进 action，**不进 nextAction.guidance**——这不违反「guidance 是唯一导航」（该约定针对推进 action 的下一步指引，只读命令是 agent 显式调用的诊断工具）。`cw-cli/SKILL.md` 已把 frontier 补入「只读命令一览」表，agent 知道何时调它。

**--help（INFO，不阻塞）**：项目本无 `--help` 子命令机制（`cli.ts` 全文无 help handler，未知 action 一律 stderr 报错 + 列合法 action 列表）。frontier 未补 --help 与既有 tree/status/list/handoff 一致——这不是本次引入的回归，属项目既有风格。新增 `--root` 参数的语义已由 `cli.ts:829` 注释 + SKILL.md 表格说明。

---

## 跨维度复核

- **零 mock 测试约定**：核查三个新测试文件（`frontier-dispatch-e2e` / `execute-children-dispatch-e2e` / `guidance-gates-spec`）均用 `createCwEnv()`（真实 CwStore + mkdtemp tmp 目录）+ stub CwDeps（依赖注入接口），无 `vi.fn` / `jest.fn` / `sinon` / `jest.mock`。grep 命中的 `mockStrategyNote` 是 design-review 的 layerSpecific 字段名，非 mock 框架调用。符合项目零 mock 硬规则。
- **文档同步**：AGENTS.md（测试数 743→801、15→16 action）、ARCHITECTURE.md（READONLY 4→5、gate 计数 slice 11→12/feature 13→14/epic 10→11、core 模块增 frontier.ts/hierarchy.ts、ActionResult 增 children?）、CONTEXT.md（15→16 action、ActionResult 增 children?）、PRODUCT.md、README.md、TEST-STRATEGY.md、cw-cli/SKILL.md（frontier 命令表 + execute --commitHash 说明 + --input 文件路径警告）均已同步，无文档与代码漂移。
- **重叠裁决**：本报告仅记项目特定约定。引擎层裸 any（项目硬规则）已在此核查（无违规）；通用 `as` 断言范式、通用边界条件归 quality-criteria.md（Subagent B）；plan 落地率归 plan-completeness.md（Subagent C）。

---

## 结论

| 子维度 | 判定 |
|--------|------|
| 状态机正确性 | pass |
| Gate 完备性 | pass |
| 引擎层类型边界 | pass（含 1 条 INFO：三张 status→action 表双处重复定义） |
| CLI 契约 | pass（含 1 条 INFO：项目本无 --help 机制） |

无 MUST_FIX、无 SUGGESTION。两条 INFO 均为可选改进，不阻塞通过。

本次递归增强严格遵守 CW 项目约定：状态机零改动、新 gate 全接入 runner 并补测试、引擎层无 any 且错误分类正确、frontier 严格只读不破坏 store 契约、dispatch 保持 agent-agnostic、文档与代码同步。整体质量高，可以合入。

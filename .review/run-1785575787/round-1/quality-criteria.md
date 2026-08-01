# 通用代码质量审查报告 — quality-criteria 维度

- 审查范围：`git diff main...HEAD`（feat-recursive-problem-solving 分支）
- 审查维度：通用范式质量（类型安全 / 错误处理 / 边界条件 / 测试有效性）
- 审查依据：`skill/review-agents/quality-criteria.md`
- 判定档位：**warn**（无 must_fix；有若干 should_fix 级别改进项）
- 工具校验：`tsc --noEmit` pass；`eslint` 改动文件 0 error；新增/改动测试 54 + 163 全 pass

> 说明：本维度只报告既不属于项目特定约定也不属于 plan 落地的通用质量问题。严重度统一映射为
> must_fix（fail）/ suggestion（warn）。本批无 fail 级问题。

---

## 汇总

| 严重度 | 数量 |
|--------|------|
| MUST_FIX | 0 |
| SUGGESTION | 5 |
| INFO | 0 |

---

## 维度 1：类型安全 — 判定 pass

### 核查结论

- 改动**无 `any`**，无 `as unknown as` 断言链。所有「放弃类型」处都有显式结构 guard 或注释。
- `src/core/frontier.ts` 对宽松 `WorkUnitRecord`（`[key:string]:unknown`）的取值全部走防御性 helper：
  - `getStringField`（`typeof v === "string"` 守卫）
  - `getScope`（白名单收窄，非预期值降级为 `"wave"`，注释说明「仅用于类型，实际不会触发」）
  - `readField<T>`（`null`/object 守卫，注释明示「仅做 null/object 降级校验，不保证 T 结构完整」）
  - `asArray<T>`（`Array.isArray` 守卫）
- `getLastStatusHistoryAction` 对 `statusHistory` 末元素做了 `null`/`object`/`typeof action === "string"` 三层守卫，无裸断言。
- `src/readonly/render.ts` 新增 `readFeatureSpec`：先 `unit.scope !== "feature"` 短路，再 `Array.isArray(raw)` 排除（feature 是容器对象，其他层是数组），最后 `typeof spec === "object"` guard，再 `as FeatureSpec`。断言有前置 guard + 注释说明「做结构 guard 而非类型断言」。
- FR/AC 渲染段用 `asArray<Record<string, unknown>>` + `asString(...)` 逐字段守卫，`acRefs` 用 `.map((a) => String(a))` 兜底非字符串值。
- `src/handlers/types.ts` 新增 `ChildInfo` 接口字段（`unitId: string` / `dependsOn: string[]`）类型明确，与实现一致。

### 唯一观察（不计为问题）

`frontier.ts` 内 `WAVE_STATUS_TO_ACTION` / `PLANNING_STATUS_TO_ACTION` / `TERMINAL_STATUSES` 与 `render.ts` 同名表同源重定义（注释已声明「core 层不能 import readonly，故重定义；若 status 枚举变化两处需同步」）。这是已有的架构约束取舍，非本次引入的类型安全问题，归项目约定维度，此处不重复报告。

---

## 维度 2：错误处理 — 判定 pass

### 核查结论

本次改动**不涉及异步操作、外部 IO、子进程**。`computeFrontier` / `resolveChildDependsOn` / `duplicateSplitSlugBySplits` / 各 `buildXxxNextAction` 均为纯同步函数。

- `src/cli.ts` 的 `frontier` 分支与既有 `status` / `handoff` 分支错误处理模式一致：`--root` 缺失 → `throw new CwError("frontier 需要 --root")`；`store.load` 返回 `null` → `throw new CwError("unit not found: ...")`。错误向上传播，未吞异常。
- `computeFrontier` 对 `root === null` 做了防御性早退（返回 `{ rootUnitId, nodes: [] }`，注释「cli 层已校验，到不了这里」），即便被绕过直调也不崩溃。
- execute handlers（epic/feature/slice）构造 `children` 时不抛——`slugToChildId.get(s.slug) ?? ""` 对缺失映射降级为空串，不产生未捕获异常。

无静默吞异常、无空 catch、无裸 await。pass。

---

## 维度 3：边界条件 — 判定 warn

### S1 [SUGGESTION] `computeFrontier` 递归收集无环检测，理论可栈溢出

- 文件：`src/core/frontier.ts` — `collectSubtree`
- 现状：`collectSubtree` 靠 `store.findChildren` 递归向下遍历，**无 visited 集合**。若 store 数据出现环（如脏数据导致 A.parentUnitId=B 且 B.parentUnitId=A，或 findChildren 实现异常返回互为父子），递归不终止，栈溢出。
- 影响评估：CW 的正常数据流不会产生环（create 时 parentUnitId 单向指父，子不会反向指回），日常场景安全。但 frontier 是面向 agent 的只读探查命令，可能被用于排查异常/半损坏的 store 状态——恰恰是环最可能出现的场景。降级为 warn 而非 must_fix，因为正常路径无风险。
- 建议：`collectSubtree` 入参加 `visited: Set<string>`，`out.push` 前判 `visited.has(id)` 跳过并（可选）记日志。与 `renderTree`（同模式遍历）可一并加固。

### S2 [SUGGESTION] `computeFrontier` 对大子树为 O(N²) 级 store 扫描

- 文件：`src/core/frontier.ts` — Pass 1 `collectSubtree` + Pass 2 类型 A
- 现状：`store.findChildren(parentUnitId)` 实现为 `data.workUnits.filter(u => u.parentUnitId === id)`（全表扫描，见 `cw-store.ts:384-387`）。`computeFrontier` 对每个节点调一次 `findChildren`（Pass 1 收集 + Pass 2 类型 A 再查一次），N 个节点 → O(N²) 次比较；类型 B 每个 wave 还多一次 `store.load(parentUnitId)`（又是 O(N) 扫描）。
- 影响评估：典型 CW 树（epic→features→slices→waves，深度 3-4，N 几十）完全无感。但 frontier 设计意图是「供递归调度器快速定位下一步」，若未来用于大型 topic（N 上百），延迟会显著上升。
- 建议：Pass 1 已遍历完整棵树拿到 `allRecords`，可一次性构建 `Map<parentUnitId, WorkUnitRecord[]>` 索引，Pass 2 类型 A 直接查 Map（O(1)），避免二次全表扫描。属性能优化，非正确性缺陷。

### S3 [SUGGESTION] Pass 2 类型 A 用 `findChildren` 而非已收集的 `childUnitIds`，存在语义双源

- 文件：`src/core/frontier.ts`
- 现状：node 上同时有 `childUnitIds`（从 `executeResult.childUnitIds` 读，Pass 1 填）和 Pass 2 用 `store.findChildren(node.unitId)` 算 blocked。两处都代表「子层」，但来源不同（一个来自 executeResult 快照，一个来自 store 实时父子外键）。
- 影响评估：正常数据下两者一致（execute 创建子 unit 时既 push `executeResult.childUnitIds` 又写 `parentUnitId`）。但若 progressive re-execute 后 `executeResult.childUnitIds` 与 store 实际子集合漂移，`childUnitIds` 输出字段与 `blockedReason` 列出的子 id 可能不一致，对消费者（递归调度器）造成困惑。
- 建议：统一数据源——要么 Pass 2 也用 `node.childUnitIds` + `store.load` 逐个查终态（与 Pass 1 一致），要么 `childUnitIds` 字段从 `findChildren` 派生。任选其一消除双源。当前 FTC1 只验证了「一致」的 happy path，未覆盖漂移场景。

---

## 维度 4：测试有效性 — 判定 warn

### S4 [SUGGESTION] 三处「聚合 gate 数量」分节注释 stale，与实际 gate 数不符

- 文件：`tests/epic-gates.test.ts:253` / `tests/feature-gates.test.ts:352`
- 现状：本次为三 runner 加了 `duplicate-split-slug` gate（slice 11→12，feature 13→14，epic 10→11），describe 标题和 `expect(...).toHaveLength(...)` 都已正确更新并全 pass。但两处分节注释仍是旧数：
  - `tests/epic-gates.test.ts:253`：`// runEpicDesignReviewGates 聚合（8 个 gate）`（实际 11）
  - `tests/feature-gates.test.ts:352`：`// runFeatureDesignReviewGates 聚合（13 个 gate）`（实际 14）
- 影响：不影响测试正确性（断言是硬编码数字），但误导维护者。`slice-gates.test.ts` 无此问题（已统一为 12）。
- 建议：把两处分节注释改为 11 / 14，与 describe 标题一致。

### S5 [SUGGESTION] execute handlers 的 children 构造逻辑三份重复，与 `resolveChildDependsOn` 同构未复用

- 文件：`src/handlers/epic/execute.ts` / `src/handlers/feature/execute.ts` / `src/handlers/slice/execute.ts`
- 现状：本次为三层 planning-execute handler 各加了一段完全相同的 children 构造逻辑（`slugToChildId` Map + `plan.split.map` + `dependsOn` 映射 + filter）。而本次**同一 PR 新建的** `src/core/hierarchy.ts` 的 `resolveChildDependsOn` 实现的是**逐字节相同的算法**（仅返回字段名 `childUnitId` vs `ChildInfo.unitId` 不同）。
- 影响评估：四份同构逻辑（resolveChildDependsOn + 3 个 handler）需同步维护，未来改 dependsOn 解析规则（如支持 slug 别名、校验缺失）要改四处，漏改即产生行为分叉。`execute-children-dispatch-e2e.test.ts` 虽覆盖了三层的 happy path，但未覆盖「解析规则变更后三处一致」这类回归。
- 建议：`resolveChildDependsOn` 返回 `{childUnitId, dependsOn}`，三个 handler 可一行 `const children = resolveChildDependsOn(unit.plan.split, unit.evidence.childDelivery).map(d => ({ unitId: d.childUnitId, dependsOn: d.dependsOn }))`。消除重复。属可维护性建议，非缺陷。

---

## 不计为问题的观察（INFO，按标准不产出条目）

- `renderFrontier` 直接 `JSON.stringify(result)` 输出原始 JSON（含 `lastStatusHistoryAction` 等），与 `renderStatus` 同模式，无敏感信息泄露风险（CW store 无密钥）。
- `subagent-guidance.ts` retrospect 从 `forbidden` 改为 `optional`：文案与 `buildSubagentGuidance` 的 optional 分支渲染一致，`tests/subagent-guidance.test.ts` 已同步更新断言并全 pass。
- `design-review` schema 注入（4 层 `layerSpecific` 字段名提示）：纯字符串拼接，wave 用「建议包含」、planning 三层用「必须包含」，措辞差异与字段 optional/required 语义一致，`guidance-gates-spec.test.ts` 覆盖了注入点条件性（非 design-review 不注入）。

---

## 覆盖说明

- 类型安全（维度 1）：逐文件核查 frontier.ts / hierarchy.ts / render.ts / execute handlers / types.ts 的所有断言与守卫。
- 错误处理（维度 2）：确认无异步/IO 新增；CLI frontier 分支错误处理与既有只读命令对齐。
- 边界条件（维度 3）：核查空树、全终态、root 不存在、wave 叶子根、replan 级联 abort 等场景，均有对应 FTC 测试覆盖；指出环检测缺失与性能/双源问题。
- 测试有效性（维度 4）：核查 5 个新增/改动测试文件的断言具体性（`toEqual` 精确结构、`toMatch` 正则、交叉验证 store.load），覆盖正常 + 异常路径；指出 stale 注释与逻辑重复。

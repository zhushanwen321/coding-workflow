# ADR 0012: 契约级加固 — guidance schema 取值 + 输入防线 + gate 可操作性

## 状态

Accepted

## 背景

cw-CLI 是 agent 唯一入口（agent 经 bash 调 `cw` 读 stdout JSON 推进流程），但三轮审查（参数完备性 / AXI 原则 / 真实 retrospect 数据）交叉验证发现三类系统性问题：guidance schema 与命令错位（agent 被迫读源码）、handler 无输入校验（crash 或静默损坏）+ create 重复覆盖（数据丢失）、3 个已确认 bug 被 agent 长期 workaround。本 ADR 记录 15 项改进中的**不可逆架构决策**（其余为可逆实现细节，见 `decisions.md` D-001~D-019）。

## 决策

### D-001：guidance schema 段取 nextAction 而非刚完成 action

- **决策**：`buildNextAction` 的 `getSchemaText(action)` 改为 `getSchemaText(nextAction)`（4 个 build 系列 NextAction 各 1 处），design-review 的 layerSpecific 特判跟随切换；终态（nextAction=undefined）跳过 schema 段；handoff 路径保持 action 取值不动。
- **为什么**：agent 在「下一步」阶段需要下一步的 schema 构造 input；当前 action 的 schema 已用过。拒绝双 schema 方案（信息过载）。
- **备选**：同时显示当前+下一步 schema——信息过载，agent 困惑。被否。
- **后果**：guidance 命令段与 schema 段同指 nextAction，消除「agent 读源码」根本缺口。
- `[from: cw-guidance-hardening §decisions.md D-001]`

### D-002 + D-015 + D-018：create 幂等 no-op + 终态特判 + 保留空态覆盖

- **决策**：slug 已存在且 status≠created（或 created 但有 fail 记录）→ 返回 existing unit 的 nextAction（`idempotent: true`），exit 0 不覆盖；aborted/closed 终态 → no-op + guidance 显式「终态不可续行，重建请用新 slug」（D-015）；status=created 且无 fail 记录（空态）→ 允许覆盖重建（D-018，用户拍板保留）。按 layer 定界（`wave:slug`），空态判定用 statusHistory 显式全量扫描。
- **为什么**：AXI §6 幂等 mutation 范式——agent 重试 create 最常见原因是「忘记已建过」，no-op 无缝续行。终态 status→action 映射为 undefined 无法构造续行 guidance，须静态提示。
- **备选**：报错 exit 1（重建需先 abort，太重）/ `--force` flag（认知负担）/ 红队建议删空态覆盖分支（用户否决，保留）。
- **后果**：重复 create 不再静默抹进度；abort 后同 slug 重建有明确指引。
- `[from: cw-guidance-hardening §decisions.md D-002/D-015/D-018]`

### D-003 + D-012 + D-016：input 校验 — typebox 全深度严格 + 34 入口

- **决策**：共享 `validateInput` 工具（新 `src/handlers/validate-input.ts`），typebox 定义 13 个 Input schema（全深度严格校验，additionalProperties:false，注入字段 abandonParentItems/changedFiles 显式声明），4 层 34 个 handler 入口统一调用，失败 → CwError exit 1（非 crash exit 2）。编译期双向 assignability 断言（`Type.Static` 互 assignable）防 schema 与 types.ts 漂移。
- **为什么**：10 个 handler 各写校验重复易漏；dispatch 层统一校验职责越界。typebox 已依赖，schema 未来可复用做 per-command --help 参数文档。
- **备选**：每 handler 手写 Array.isArray（重复易漏）/ dispatch 层校验（职责越界）/ 一级字段校验+宽松嵌套（用户否决，选全深度）。
- **后果**：`clarify {}` 不再 TypeError crash、`{"clarifications":"hello"}` 不再静默拆字。
- `[from: cw-guidance-hardening §decisions.md D-003/D-012/D-016]`

### D-004 + D-009：unknown flag 白名单 + CwError exit 1

- **决策**：per-action 白名单表（新 `src/cli-params.ts`，含全局共享 flag 基础集 + camel/kebab 双形态展开），buildParams 前校验（create 缺 layer 分支之前），未知 flag → CwError「unknown flag --unid, valid: ...」exit 1；`--help/-h` 必入白名单（per-command help 双入口复用同表）。
- **为什么**：minimist 默认静默吞 unknown flag（AXI §6c 最危险情形）。exit 1 归 CwError 参数错误（现有契约 exit 1=参数错误 / exit 2=内部异常，避免同码歧义——修订原设计的 exit 2）。
- **备选**：minimist `unknown` 回调（不区分 positional/flag）；exit 2 新增 usage-error 类别（同码歧义）。
- **后果**：拼错 flag 立即报错可操作，不再静默假成功。
- `[from: cw-guidance-hardening §decisions.md D-004/D-009]`

### D-005 + D-011：retrospect gate 报告扩展（期望全集 + 缺失子集）

- **决策**：gate 失败时 failure 报告从「缺失清单」扩展为「期望全集（含已覆盖）+ 缺失子集」字符串拼接（不新建机制）；失败率归因于 key 修复（D-006/D-013）而非报告本身。
- **为什么**：45% gate fail 根因是「agent 不知道要覆盖哪些 itemId」的信息不对称；拒绝自动填充默认值（失去逐项回顾强制力）。
- **备选**：reviewedItems 自动填充默认值——失去回顾强制力，被否。
- **后果**：agent 一次看到全部缺口，减少逐轮试错。
- `[from: cw-guidance-hardening §decisions.md D-005/D-011]`

### D-006 + D-010/D-013/D-017：3 个已确认 bug 修复

- **决策**：
  - codeSmell/followup key 用 typeof 防御（string 原样 / 对象稳定序列化），不换 index key（存量数据不失配）（D-013）
  - testRunner --testCwd 链已实机验证完整（cli.ts:821→constructCwDeps→spawnSync cwd），交付 e2e 回归测试锁定而非改链（D-010）
  - replan 路径 buildReplanGuidance 透传 schema 段（replan 后下一步是 plan）（D-017）
- **为什么**：retrospect 数据第一手证据（agent 已 workaround 内化 10+ 处提及）；`item.description ?? item` 配方对 string[] 恒 undefined 会产出更糟的 `codeSmell:undefined`。
- **备选**：改 judgments.ts 类型为对象数组 + 迁移存量（超范围）。
- **后果**：垃圾 key 不再出现，agent 可照抄 missing 清单。
- `[from: cw-guidance-hardening §decisions.md D-006/D-010/D-013/D-017]`

### D-019：issue 合并（#7 并入 #3、#11 并入 #5）+ 执行编排（#8 移 W3）

- **决策**：同文件同函数的改动合并为一个 issue（retrospect.ts 的 key 防御+报告扩展；cli-params.ts 的白名单+help），wave 内并行 implementer 文件不相交原则；#8（execute.ts）与 #6 同文件不可同 wave 并行 → 移 W3 跨 wave 串行。
- **为什么**：红队 review 发现单 wave 只装 ~10 行改动成本比 20:1 的过度编排；wave 内并行同文件必 merge 冲突（3 次 run 零冲突验证归组原则有效）。
- **后果**：3 waves 与 3 批对齐，执行无冲突。
- `[from: cw-guidance-hardening §decisions.md D-019]`

## 后果

- **正面**：15 项改进全部落地（949 tests 全绿），cw 从「勉强能用但有 hidden 陷阱」升级为「agent 可信赖的契约级 CLI」。
- **负面**：34 个 handler 入口新增 validateInput 调用（维护成本）；白名单表需随新增 action 维护（新增 action 时漏登记会误拒合法 flag——由 T2.2 表⊆代码消费键断言兜底）。
- **已知残余风险**：见 NFR.md「已知残余风险」章新增条目（白名单漏登记、schema 漂移、空态覆盖并发窗口）。

## 溯源

`[from: cw-guidance-hardening §decisions.md D-001~D-019]`

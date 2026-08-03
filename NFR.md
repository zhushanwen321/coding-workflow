# 工程约束（NFR）

> **always-current**。CW-CLI（coding-workflow）工程级非功能不变式，分 7 维度。
> 每条约束必须四件套齐全（约束/为什么/验证/例外）；缺"验证" = 空头口号，`check-init` 机器诊断会 grep 验证字段中的代码标识符（反引号包裹），找不到即标 `[STALE]`。
> 设计新功能时对照本文件评估副作用；新约束经代码验证后由 closeout 沉淀到对应维度。

## 安全

### S-1 stdin/文件 payload 上限 10MB

- **约束**：所有经 stdin 或 `--input` 传入的 payload（推进 action 的 input JSON，如 `cw plan` 的 WavePlan/SlicePlan）必须 ≤ 10MB，超出直接拒绝并报错。
- **为什么**：CW 是面向 LLM agent 的 CLI，payload 过大通常是误传（如误传 node_modules 目录扫描结果），无界输入会撑爆内存/上下文窗口。10MB 上限是工程经验值，足够覆盖任何合理的 WorkUnit plan 结构化数据。
- **验证**：`MAX_FILE_SIZE_BYTES`（src/cli.ts）
- **例外**：无

### S-2 WorkUnit 数据 per-cwd 物理隔离

- **约束**：不同工作目录（cwd）的 WorkUnit 数据必须物理隔离——`store.json` 按 cwd 编码后分目录存放（`~/.cw/<encodedCwd>/store.json`），互不可见、互不可达。
- **为什么**：多项目并行开发是常态，若 WorkUnit 跨 cwd 泄漏会导致 agent 在 A 项目看到 B 项目的状态，产生幽灵指令/串改。per-cwd 隔离是防止项目间状态污染的第一道物理边界。
- **验证**：`encodeCwd`（src/store/schema.ts，由 src/store/cw-store.ts 定位 store.json 时调用；规则见 schema.ts 注释「encodeCwd: `/` → `__`」）
- **例外**：符号链接可能解析到不同物理路径（即两个逻辑 cwd 指向同一物理目录，或反之），此时隔离边界以解析后的路径为准。文档已标注，用户对 cwd 解析行为负责。

## 业务数据安全

### D-1 store.json 原子写

- **约束**：`store.json` 的所有写操作必须原子化——write tmp → fsync → rename → fsync dir，任一阶段 crash 磁盘上文件保持完整（旧文件或新文件，无损坏中间态）。
- **为什么**：状态机推进过程中随时可能被 Ctrl-C / 进程崩溃 / 系统掉电打断。非原子写（直接覆盖主文件）在写一半时崩溃会留下截断的 JSON，下次启动 loadWorkUnit 解析失败，整个 WorkUnit 状态丢失——这是不可逆的数据损坏。原子写保证"要么旧要么新"，crash 后总能恢复到一致状态。
- **验证**：`flushToDisk`（src/store/cw-store.ts）
- **例外**：无

## 性能

### P-1 engine 是纯函数无 IO 阻塞

- **约束**：状态机 engine（dispatch）必须是纯函数——签名 `(params, deps) => ActionResult`，函数体内不做网络请求/重磁盘 IO，唯一的外部 IO 是经 `CwDeps` 注入的 git 子进程调用（store 读写、测试执行等也经 deps 注入）。所有副作用（跑测试、调 LLM）都由 caller 在 engine 之外编排。
- **为什么**：纯函数 engine 保证给定输入确定输出，可单元测试、可回放、可快照。若 engine 内部直接做网络/磁盘 IO，测试需 mock 整个环境，且并发/超时行为不可控。依赖注入（`CwDeps`）把 IO 边界显式化，engine 只负责状态计算（按 scope 路由到 4 子分派器）。
- **验证**：`dispatch`（src/dispatch.ts，签名 `dispatch(params, deps): ActionResult`；`CwDeps` 接口见 src/handlers/types.ts）
- **例外**：git diff-tree 在超大 commit 上可能慢，这是已记录的已知风险（见 RISK-2），engine 本身不阻塞，但 git 子进程的耗时无法从 engine 层消除。

## 并发控制

### C-1 跨进程文件锁

- **约束**：对 `store.json` 的写操作必须先获取跨进程文件锁——`openSync(path, "wx")`（O_EXCL 原子创建）写 lockfile，持锁期间独占写，释放后他人可获取。必须检测并打破 stale lock（持有锁的进程已退出但未释放锁文件，含 PID + 时间戳双重判定 + TOCTOU 二次指纹比对）。
- **为什么**：CW 设计为 session 级工具（单 WorkUnit 树生命周期），但同一项目可能被多个终端/agent 并发访问（如人开一个终端、agent 开一个）。无锁并发写会导致 lost update（两进程同时读-改-写，后写覆盖先写）。O_EXCL 是 POSIX 原子语义，保证锁获取本身无 race；stale lock 检测防止崩溃进程永久卡住后续写入。
- **验证**：`acquireLock`（src/store/cw-store.ts）
- **例外**：无

### C-2 replan append-only

- **约束**：replan 操作必须 append-only——plan 中标 `status="abandoned"` 的条目不可删改，只能在其后追加新条目；只有 `status="active"` 的条目允许替换或修改。
- **为什么**：abandoned 条目代表已被废弃/已纳入决策的工作记录。允许 replan 删除或改写这些等于篡改历史——agent 可能"改计划来掩盖未完成的工作"，破坏流程的可追溯性。append-only 保证计划只能向前演进，历史不可逆。
- **验证**：`checkFreeze`（src/rules/freeze.ts，WavePlan 条目 append-only 校验）+ `checkFreezePlanning`（src/rules/freeze.ts，SlicePlan 条目 append-only 校验）+ `checkFreezeFeatureSpec`（src/rules/freeze.ts，FeatureSpec 条目 append-only 校验）
- **例外**：无

## 稳定性·高可用

### R-1 gate 失败递进提示不阻断

- **约束**：gate 连续失败达到上限（5 次）后在 guidance 追加「强烈建议先 cw abort」递进文案，但**不得**以非 0 退出码阻断 agent。递进提示是"提醒人类介入"而非"卡死流程"——cw 永不阻断，只换文案引导。
- **为什么**：gate 是质量门（如 test gate 要求所有 testCase 执行通过、testReferencesDesignReview 通过），但 gate 失败可能是环境问题（测试框架报错、flaky test）而非代码问题。若 gate 失败就 exit 非 0 阻断，agent 会卡在无法自行解决的死循环。递进提示后换文案提示"已达重试上限，建议先 abort 跳出当前层重新审视"，把决策权交还人类，保证流程可继续推进。
- **验证**：`deriveFailureCount`（src/guidance/failure-hint.ts，从 statusHistory 派生同一 action 连续 fail 次数）+ `HINT_THRESHOLD_STRONG_ABORT = 5`（src/guidance/failure-hint.ts，触发强烈建议 abort 的阈值）+ `buildFailureHint`（src/guidance/failure-hint.ts，组装递进文案）
- **例外**：无

### R-2 gate fail 仅 retry 不回退 status

- **约束**：gate 失败时 unit 的 status 不前进也不回退—— ActionResult 返回 `ok=false`，status 维持原值，agent 修复后重试同一 action。不存在"fix loop 回退到上一阶段"的机制，也无 `review_fix`/`test_fix` 这类独立 action。
- **为什么**：当前模型把"发现缺陷 → 修复 → 再验证"统一为"原地 retry 同一 action"：gate fail 不改 status，agent 在 workspace 修代码后再次调同一 `cw` action。这比"回退到 dev 阶段重跑"更直接，避免引入隐藏的状态机分支和回退语义。流程的终止条件由 agent 自身预算 + R-1 的 abort 递进提示共同保证，而非硬编码轮数上限。
- **验证**：gate 函数返回 `ok=false` 不触发 `transitionStatus`（见 src/rules/gates/*.ts 的 gate 实现 + src/handlers/*.ts 的事务：gate fail 时只 append statusHistory 的 fail 记录、不调用 transition）；guard 表（`WAVE_TRANSITIONS`/`PLANNING_TRANSITIONS`，src/rules/state-machine.ts）也无 fix-loop 转换。
- **例外**：无

## 兼容性

### V-1 旧 store 向前兼容

- **约束**：加载旧版本创建的 store（缺少 `schemaVersion` / `repoMeta` 或新加的 WorkUnit 字段）必须正常工作——缺 `schemaVersion` 视为 1，未知字段以 unknown 透传不丢弃，不得抛错或拒绝整个 store。
- **为什么**：CW 的 WorkUnit 数据持久化在用户磁盘，升级 CW 版本后旧 store 必须可读可用。若新字段缺失就报错，用户升级后历史 WorkUnit 全部失效，这是不可接受的数据迁移风险。向前兼容保证"新版本读旧数据"始终成立，字段渐进式增强。
- **验证**：`schemaVersion?` 缺失时补 1（src/store/schema.ts `CwJsonFile` 注释 + `loadFileData` 实现）；`WorkUnitRecord` 以 `[key: string]: unknown` 透传未知字段（src/store/schema.ts）；`migrateLegacyV1Home`（src/store/migrate-v1.ts，把旧 `~/.v1` 迁到 `~/.cw`，按 `repoMeta.recordedAt` 合并）
- **例外**：缺少 `repoMeta` 的旧 store 在首次推进类 action 时回填（git 命令失败时降级为空串，不抛）。

### V-2 plan 经 `--input` 程序化消费

- **约束**：推进类 action 的 input payload（如 `cw plan` 的 WavePlan/SlicePlan）通过 `--input @file.json`（读文件）或 `--input -`/无 flag（读 stdin）传入，engine 不从固定路径的 `plan.json` 文件读取。input 结构按当前 WorkUnit 四层模型校验（WavePlan/SlicePlan 等），不存在"旧版双字段 plan 自动提取"的兼容逻辑。
- **为什么**：plan 等阶段产物由人或 agent 生成，通过 stdin/file 程序化消费比"约定固定路径文件"更灵活（一个 workspace 可有多份 input 文件、可经管道传入）。input 结构由当前 schema 强校验，旧的双字段结构（`waves` + `testCases`）已随模型重构移除，不保留提取兼容。
- **验证**：`readInput`（src/cli.ts，`--input @file` / `--input -` / stdin 三通道）；plan 类型校验见 src/core/plan.ts（WavePlan/SlicePlan/Plan 基类）
- **例外**：无

## 可观测性

### O-1 gate 判定留痕 statusHistory

- **约束**：gate 判定结果必须留痕——gate fail 时向 unit 的 `statusHistory` 追加一条 `StatusChange`（from 留空、to=当前 status、note 形如 `gate fail: <原因>`，不改 status）；结构化的 gate 结果（GateResult[]）随 ActionResult 返回给 caller。statusHistory 是 append-only，历史记录不可删改。
- **为什么**：gate 判定决定流程是否推进，是质量保证的关键决策点。无审计则无法回溯"为何这个 wave 被放行/为何这个 testCase 被判 fail"。append-only 的 statusHistory 提供完整决策链，用于事后复盘、归因 flaky test、向用户解释流程走向。它也是 R-1 递进提示的派生源——`deriveFailureCount` 扫描 statusHistory 中 note 含 "gate fail" 的连续记录。
- **验证**：fail 记录函数（src/handlers/internal.ts，note 形态 `gate fail: <reason>`，§5.1 派生算法按此标记扫描）；`gateResults` 字段（src/handlers/types.ts `ActionResult.gateResults: GateResult[]`）；`StatusChange` 结构（src/core/status.ts，append-only）
- **例外**：gate pass 不单独写一条 fail 记录——pass 直接 `transitionStatus` 前进（前进本身就是留痕，statusHistory 记 from→to 转换）。

### O-2 gate 失败报告列期望全集 + 缺失子集  [from: cw-guidance-hardening §non-functional-design]

- **约束**：retrospect gate 失败时 failure 报告必须包含「期望全集（含已覆盖 itemId）+ 缺失子集」两段（字符串拼接，不新建机制）；codeSmell/followup/tradeoff/risk 的 itemId 生成必须防御类型违规输入（typeof 防御，string 原样/对象稳定序列化），不得产 `[object Object]` / `followup:undefined` / `undefined` 垃圾 key。
- **为什么**：45% 的 retrospect gate fail 根因是 agent 不知道要覆盖哪些 itemId——缺失清单会让 agent 逐轮试错补漏；垃圾 key 让 agent 不敢照抄 missing 清单。列全集消除信息不对称，key 防御让清单可照抄。
- **验证**：`src/rules/gates/retrospect.ts`（139-146 key 防御 + 166-170 报告扩展 + 266-293 slice 层 tradeoff/risk id 防御）；T2.7/T2.7b 用例断言两段文案与无垃圾 key
- **例外**：无。

### O-3 unknown flag 报错列合法 flag  [from: cw-guidance-hardening §non-functional-design]

- **约束**：CLI 解析到 unknown flag 必须报 `CwError`（exit 1）且错误文案列出该 action 的合法 flag 列表（含全局共享基础集）；白名单表与 per-command help 同源（`src/cli-params.ts`）。
- **为什么**：minimist 默认静默吞 unknown flag，agent 拼错 flag 会拿到假成功或困惑报错；列合法 flag 让错误可操作（AXI §6c）。
- **验证**：`src/cli-params.ts`（FlagWhitelist + validateFlags）+ `src/cli.ts`（buildParams 前校验）；T2.1/T2.2/T2.3 用例
- **例外**：`--` positional 分隔符后的键不校验。

## 已知残余风险

> 跨主题累积。下次设计会先读这里，避免重复发现已知问题。

| ID | 风险 | 接受理由 | 监控方式 | 溯源 |
|----|------|---------|---------|------|
| RISK-1 | 跨进程文件锁高并发下未压测——stale lock 检测基于 PID + 30s 超时指纹（`openSync(path,"wx")` + pid/timestamp 比对），极端情况（如 PID 复用 + 时间戳未过期）可能误打破活锁 | CW 是 session 级工具（单 WorkUnit 树生命周期），高并发场景概率极低；误打破的后果是单次写失败重试，非数据损坏 | stale lock 打破日志（verbose 模式 `logVerbose`） | [from: cw-cli-extract] |
| RISK-2 | testRunner 大测试套件性能——`cw test` 经 `spawnSync` 实跑测试命令（默认 `npx vitest run`），超时 120s；超大/慢测试套件可能接近超时被强杀 | CW 只验测试 exit 0；慢是工程现实（测试套件规模由项目决定），120s 超时是防死循环的上限，线性退化非数据风险 | 测试耗时 / `TestRunResult` 计数 | [from: W1-changedFiles] |
| RISK-3 | flag 白名单漏登记新增 action 的合法 flag → 合法调用被误拒 | 单源提取（从 buildParams 现有 case）+ T2.2 反向断言（表 keys ⊆ 代码消费 flag 键）在新增 action 首测即暴露 | 新增 action 的 dispatch 层测试 | [from: cw-guidance-hardening §non-functional-design] |
| RISK-4 | input schema 与 types.ts 类型漂移（改 types.ts 忘改 typebox schema） | 编译期双向 assignability 断言（Type.Static 互 assignable，T2.6）+ 既有 949 测试基线在过严漂移时变红；过松漂移由行为用例兜底 | npm test 全绿 | [from: cw-guidance-hardening §non-functional-design] |
| RISK-5 | create 空态覆盖判定的跨进程并发 save 窗口 | session 级单用户工具，C-1 文件锁 + RISK-1 已接受高并发未压测；existing 分支不写、空态窗口极窄 | 无（接受） | [from: cw-guidance-hardening §non-functional-design] |

# 工程约束（NFR）

> **always-current**。CW-CLI（coding-workflow）工程级非功能不变式，分 7 维度。
> 每条约束必须四件套齐全（约束/为什么/验证/例外）；缺"验证" = 空头口号，`check-init` 机器诊断会 grep 验证字段中的代码标识符（反引号包裹），找不到即标 `[STALE]`。
> 设计新功能时对照本文件评估副作用；新约束经代码验证后由 closeout 沉淀到对应维度。

## 安全

### S-1 stdin/文件 payload 上限 10MB

- **约束**：所有经 stdin 或文件传入的 payload（plan.json / topic.json 等）必须 ≤ 10MB，超出直接拒绝并报错。
- **为什么**：CW 是面向 LLM agent 的 CLI，payload 过大通常是误传（如误传 node_modules 目录扫描结果），无界输入会撑爆内存/上下文窗口。10MB 上限是工程经验值，足够覆盖任何合理的 plan/topic 结构化数据。
- **验证**：`MAX_FILE_SIZE_BYTES`（src/cli.ts）
- **例外**：无

### S-2 topic 数据 per-cwd 物理隔离

- **约束**：不同工作目录（cwd）的 topic 数据必须物理隔离——`_cw.json` 按 cwd 编码后分目录存放，互不可见、互不可达。
- **为什么**：多项目并行开发是常态，若 topic 跨 cwd 泄漏会导致 agent 在 A 项目看到 B 项目的状态，产生幽灵指令/串改。per-cwd 隔离是防止项目间状态污染的第一道物理边界。
- **验证**：`encodeCwd`（src/path-encoding.ts，由 src/cli.ts `resolveDbPath` 调用）
- **例外**：符号链接可能解析到不同物理路径（即两个逻辑 cwd 指向同一物理目录，或反之），此时隔离边界以解析后的路径为准。文档已标注，用户对 cwd 解析行为负责。

## 业务数据安全

### D-1 _cw.json 原子写

- **约束**：`_cw.json` 的所有写操作必须原子化——write tmp → fsync → rename → fsync dir，任一阶段 crash 磁盘上文件保持完整（旧文件或新文件，无损坏中间态）。
- **为什么**：状态机推进过程中随时可能被 Ctrl-C / 进程崩溃 / 系统掉电打断。非原子写（直接覆盖主文件）在写一半时崩溃会留下截断的 JSON，下次启动 loadTopic 解析失败，整个 topic 状态丢失——这是不可逆的数据损坏。原子写保证"要么旧要么新"，crash 后总能恢复到一致状态。
- **验证**：`flushToDisk`（src/store.ts）
- **例外**：无

## 性能

### P-1 engine 是纯函数无 IO 阻塞

- **约束**：状态机 engine（dispatch）必须是纯函数——签名 `(params, deps) => ActionResult`，函数体内不做网络请求/重磁盘 IO，唯一的外部 IO 是经 `ActionDeps` 注入的 git 子进程调用。所有副作用（写文件、跑测试、调 LLM）都由 caller 在 engine 之外编排。
- **为什么**：纯函数 engine 保证给定输入确定输出，可单元测试、可回放、可快照。若 engine 内部直接做网络/磁盘 IO，测试需 mock 整个环境，且并发/超时行为不可控。依赖注入（ActionDeps）把 IO 边界显式化，engine 只负责状态计算。
- **验证**：`dispatch`（src/dispatch.ts，签名 `dispatch(params, deps): ActionResult`）
- **例外**：git diff-tree 在超大 commit（waves ≥ 10）上可能慢，这是已记录的已知风险（见 RISK-2），engine 本身不阻塞，但 git 子进程的耗时无法从 engine 层消除。

## 并发控制

### C-1 跨进程文件锁

- **约束**：对 `_cw.json` 的写操作必须先获取跨进程文件锁——lockfile + O_EXCL 原子创建，持锁期间独占写，释放后他人可获取。必须检测并打破 stale lock（持有锁的进程已退出但未释放锁文件）。
- **为什么**：CW 设计为 session 级工具，但同一项目可能被多个终端/agent 并发访问（如人开一个终端、agent 开一个）。无锁并发写会导致 lost update（两进程同时读-改-写，后写覆盖先写）。lockfile + O_EXCL 是 POSIX 原子语义，保证锁获取本身无 race；stale lock 检测防止崩溃进程永久卡住后续写入。
- **验证**：`acquireLock`（src/store.ts）
- **例外**：无

### C-2 replan append-only

- **约束**：replan 操作必须 append-only——已 committed 的 wave 和已 passed 的 testCase 不可删改，只能在其后追加。replan 仅允许替换 uncommitted 的 wave 和 unpassed 的 testCase。
- **为什么**：committed wave 代表已落盘到 git 历史的工作，passed testCase 代表已验证的验收点。允许 replan 删除这些等于篡改历史——agent 可能"改计划来掩盖未完成的工作"，破坏 TDD 流程的可追溯性。append-only 保证计划只能向前演进，历史不可逆。
- **验证**：`validateAppendOnly`（src/actions.ts）+ `replaceUncommittedWaves`（src/store.ts）+ `replaceUnpassedTestCases`（src/store.ts）
- **例外**：无

## 稳定性·高可用

### R-1 gate 熔断不阻断

- **约束**：gate 连续失败达到上限（5 次）后切换为熔断引导文案，但**不得**以非 0 退出码阻断 agent。熔断是"提醒人类介入"而非"卡死流程"。
- **为什么**：gate 是质量门（如 test gate 要求所有 testCase passed），但 gate 失败可能是环境问题（测试框架报错、flaky test）而非代码问题。若 gate 失败就 exit 非 0 阻断，agent 会卡在无法自行解决的死循环。熔断后换文案提示"已达重试上限，建议人工排查"，把决策权交还人类，保证流程可继续推进。
- **验证**：`GATE_RETRY_LIMIT`（src/state-machine.ts）
- **例外**：无

### R-2 review/test fix loop 有上限

- **约束**：review fix 循环上限 3 轮，test fix 循环上限 5 轮，达到上限后强制进入下一阶段，不允许无限循环。
- **为什么**：review/test 是"发现缺陷 → 修复 → 再验证"的循环。若无上限，agent 可能陷入无限修补（一个 flaky test 反复修不过，或 review 不断发现新问题）。设上限保证流程有终止条件，达到上限即"接受当前质量，继续向前"，避免 agent 在单个阶段耗尽预算。轮数差异（review 3 / test 5）反映 test 阶段修复成本更高、允许更多尝试。
- **验证**：`REVIEW_TURN_LIMIT`（src/state-machine.ts）+ `TEST_TURN_LIMIT`（src/state-machine.ts）
- **例外**：无

## 兼容性

### V-1 旧 topic 向后兼容

- **约束**：加载旧版本创建的 topic（缺少 `runtimeEnv` / `retrospectData` / `assessments` 等新字段）必须正常工作——缺失字段 loadTopic 时视为 undefined，统计归入 unknown 分组，不得抛错或丢弃整个 topic。
- **为什么**：CW 的 topic 数据持久化在用户磁盘，升级 CW 版本后旧 topic 必须可读可用。若新字段缺失就报错，用户升级后历史 topic 全部失效，这是不可接受的数据迁移风险。向后兼容保证"新版本读旧数据"始终成立，字段渐进式增强。
- **验证**：`computeGatePassed`（src/state-machine.ts，对缺失字段做容错计算）
- **例外**：缺少 `runtimeEnv` 的旧 topic 不参与跨 topic 的 runtimeEnv 聚合对比（因元数据缺失，对比无意义）。

### V-2 旧版 plan.json 兼容

- **约束**：旧版 plan.json（同时含 `waves` 和 `testCases` 两个字段，新版拆分）必须被兼容——`cw plan` 自动从旧结构提取 testCases，行为与新结构等价。
- **为什么**：plan.json 由人或 agent 手写，历史 plan 文件用的是旧的双字段结构。若新版拒绝旧结构，用户无法复用历史 plan，需手动迁移。自动提取保证旧 plan 无感升级，迁移成本为零。
- **验证**：`validateAppendOnly`（src/actions.ts，replan 路径兼容 legacy testCases 提取）+ `parseDevPlan`
- **例外**：无

## 可观测性

### O-1 gate 判定写审计记录

- **约束**：每次 gate 判定（无论 pass/fail）必须向 gateHistory 追加一条审计记录，包含 phase、gate 名、result、report、timestamp。gateHistory 是 append-only，历史记录不可删改。
- **为什么**：gate 判定决定流程是否推进，是质量保证的关键决策点。无审计则无法回溯"为何这个 wave 被放行/为何这个 testCase 被判 fail"。append-only 的 gateHistory 提供完整决策链，用于事后复盘、归因 flaky test、向用户解释流程走向。也是 P-1 纯函数 engine 的副作用出口——所有判定留痕。
- **验证**：`appendGateHistory`（src/store.ts）
- **例外**：无

## 已知残余风险

> 跨主题累积。下次设计会先读这里，避免重复发现已知问题。

| ID | 风险 | 接受理由 | 监控方式 | 溯源 |
|----|------|---------|---------|------|
| RISK-1 | flock 在高并发下未压测——stale lock 检测基于 PID + 时间戳，极端情况（如 PID 复用 + 时间戳未过期）可能误打破活锁 | CW 是 session 级工具，高并发场景概率极低；误打破的后果是单次写失败重试，非数据损坏 | stale lock 打破日志 | [from: cw-cli-extract] |
| RISK-2 | git diff-tree 大 commit 性能——dev gate 在 waves ≥ 10 的大 commit 上可能慢（秒级） | CW 鼓励小粒度 commit，`SCOPE_WARN_WAVES`/`SCOPE_WARN_FILES` 已预警大 scope；慢是线性退化非阻塞 | dev gate 耗时 | [from: W1-changedFiles] |

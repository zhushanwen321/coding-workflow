# al-1 验收标准：nice 减震双落点（D7）——验收命令与 agent spawn 统一降优先级

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：验收分层与成本治理设计（原 `docs/rewrite/design-acceptance-layering.md`，现移至 `.tmp/design-acceptance-layering.md`，commit `2d5dcfa` 为终版）§3.3 D7 + §5 波次 w1。设计目标 G4：验收执行从「瞬间打满全部核」降为「后台高占用」，不抢占交互负载。
> 波次：al-1 = 设计 w1（独立先行，不依赖 layer 模型）。

## 1. 目标

两个执行落点统一包 `nice -n 10`（增量语义，POSIX）：① `src/verify/run.ts` 的 `execBashTree`（覆盖叶子 verify、红阶段、集成——三者都经此函数）；② `src/runner/spawn/lifecycle.ts` 的 `spawnProcess`（runner 派发的 designer / developer / reviewer agent 进程整体降级，孙进程按 POSIX 继承全覆盖）。nice 不可解析时**降级为裸 spawn**（不报错、不警告、零语义变化——Windows 与极简容器自然落此分支）。**全部判定 / 产物 / 超时 / 回收语义零变化。**

**实施期门裁决（设计 D7 已挂 ⛔，本基线收口）**：vitest worker 上限 env 注入**不做**——已查证 vitest 3.x 官方文档（CLI 页 + config/maxWorkers 页）：maxWorkers 仅有 config file 与 CLI flag 两种设置形态，无任何官方 env 变量（`VITEST_MAX_THREADS` 系 0.x 旧物，3.x 不存在）。按设计门条件「不存在则不做」执行；「wrapper 脚本自限 worker」的建议文案归 al-3（w3）reviewer 第六维，不在本 unit。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/verify/run.ts` | 修改 | `execBashTree` 的主命令 spawn 包 `nice -n 10` + nice 预检降级（详见 §4.A）。**文件内其余函数逐字节不变**（含 `reclaimGroup` / `readSentinel` / `bashResolvable` / 等待辅助 `spawnSync`——后者是毫秒级哨兵轮询，不包）。头注释补 nice 说明（执行路径 + 降级语义） |
| `src/runner/spawn/lifecycle.ts` | 修改 | `spawnProcess` 的 `spawn(req.command, ...)` 包 `nice -n 10` + nice 预检降级（详见 §4.B）。`assertExecutableResolvable`（预检 `req.command`）与其余逻辑零变更。头注释补 nice 说明 |
| `tests/al-1-nice.test.ts` | 新建 | §5 全部条款（N / D / R 三系） |

## 3. 禁改清单（违反 = FAIL）

- `src/verify/` 除 `run.ts` 外全部（`checkout.ts` / `name-match.ts`）；`run.ts` 内除 §4.A 列明处外零变更
- `src/runner/` 除 `spawn/lifecycle.ts` 外全部（含 `spawn/types.ts` / `spawn/human.ts` / `spawn/pi.ts` / `loop.ts` / `integrate.ts` / `brief.ts` / `escalations.ts` / `worktree.ts`）；`lifecycle.ts` 内除 §4.B 列明处外零变更
- `src/events/`、`src/handlers/`、`src/gates/`、`src/core/`、`src/store/`、`src/readonly/`、`src/testrun/`、`src/cli.ts`、`src/dispatch.ts` —— al-2/al-3 领地与无关域，全部零改动
- `CONTEXT.md`、`AGENTS.md` 及 `docs/` 全部既有文档
- `tests/` 既有文件零改动（既有套件回归 = 全量 npm test）
- 语义锁定：`SpawnProcessRequest` / `SpawnHandle` / `SpawnResult` 契约（`spawn/types.ts`）零变化；`execBashTree` 签名与 `BashExecOutcome` 三态零变化；四态退出归因（EXITOK/CRASH/TIMEOUT/SPAWN_ERROR）零变化

## 4. 实现形状（锁定）

### A. 落点一：`src/verify/run.ts` 的 `execBashTree`

1. 新增模块级私有函数 `niceResolvable(env: NodeJS.ProcessEnv): boolean`——与既有 `bashResolvable` **同型**：`env.PATH` 未定义时放行（走系统默认，失败由既有异步 error 兜底）；否则按 `delimiter` 逐段查 `nice` 是否为「存在的可执行普通文件」（复用文件内既有 `isExecutableFile`）。
2. 主命令 spawn 处（现 `spawn("bash", ["-c", wrapped], {...})`）改为按预检分流：
   - nice 可解析：`spawn("nice", ["-n", "10", "bash", "-c", wrapped], {...})`——spawn 选项对象（`cwd` / `env` / `stdio` / `detached: true`）**逐字段不变**；
   - nice 不可解析：保持现形态 `spawn("bash", ["-c", wrapped], {...})`（降级，静默——不写 stderr 产物、不告警）。
3. nice 调整量 10 定义为具名常量（如 `NICE_ADJUSTMENT = 10`，模块内私有，不必导出——测试以行为断言为准，见 §5 N1）。
4. 进程组语义不变式（builder 必须在代码注释中声明）：detached 组长从 bash 变为 nice，但 nice(1) 对目标命令是 **exec 自替换**（GNU coreutils 与 BSD 实现同），pid 不变 ⟹ `pgid === pid` 与 `kill(-pgid)` 整树回收对直接子进程与孙进程的覆盖**不受影响**（§5 R1 实测锁定）。
5. 等待辅助进程（`spawnSync("bash", ["-c", "while ..."])`）与 `reclaimGroup` 的 `sleep 0.05` **不包 nice**（毫秒级轮询，无资源面；包了反而拖慢哨兵响应）。

### B. 落点二：`src/runner/spawn/lifecycle.ts` 的 `spawnProcess`

1. 新增模块级私有函数 `niceResolvable(childEnv: NodeJS.ProcessEnv): boolean`——同 A.1 形态（该文件已有平行的 `isExecutableFile`，复用之）。
2. 主 spawn 处（现 `spawn(req.command, req.args, {...})`）按预检分流：
   - nice 可解析：`spawn("nice", ["-n", "10", req.command, ...req.args], {...})`——spawn 选项对象逐字段不变（`cwd` / `env: childEnv` / stdio 双流 / `detached: true`）；
   - 不可解析：保持现形态（降级静默）。
3. `assertExecutableResolvable(req.command, ...)` 的既有预检**保持在前且零变更**——它同步抛 SPAWN_ERROR 错误是既有契约；nice 预检是另一维度（工具可用性），失败只降级不抛。
4. nice 调整量常量同 A.3（两文件各自定义；**不抽共享模块**——两处可执行预检本就平行演化，跨 verify/runner 抽公共文件引入新耦合，收益仅一个字面量。§5 N3 锁定两处值一致）。
5. 嵌套累加是**接受的行为**（设计 D7 探针已实测）：agent(ni=10) 内跑 verify 的验收命令再包一层 → ni=20，更谦卑，无害，不做去重——代码注释声明此决策。

## 5. 新增测试条款（真实子进程 + tmp + CW_HOME 隔离，零 mock）

自报 nice 值的统一手法：命令内 `ps -o ni= -p $$`（POSIX ps；bash `$$` = 主 shell pid，正是被 nice 的进程）。测试进程自身 ni=0 是常态运行假设（vitest 不降优先级起 worker）——若该假设破坏测试会假红，属可接受的诚实边界。

### N 系：nice 包裹生效

- **N1 验收命令落点**：直测导出的 `execBashTree`（fx-7 已有直测先例）——command 为 `ps -o ni= -p $$`，正常 env → outcome `done` exitCode 0，stdout 产物 trim 后恰为 `10`。
- **N2 agent spawn 落点**：直测 `spawnProcess`——`command: "bash"`，`args: ["-c", "ps -o ni= -p $$"]`，落盘 stdoutPath → `wait()` 结算 exitCode 0，stdout 文件 trim 后恰为 `10`。
- **N3 两落点值一致**：N1 与 N2 断言同一常量值 10（两文件各自实现被同一值锁定；若日后一处改动此测试不会代偿）。

### D 系：预检降级（零语义变化）

- **D1 execBashTree 降级**：构造 tmp bin 目录，内**仅** symlink 系统 `bash`（无 nice、无 ps 等），env.PATH 只指该目录 → command `echo hello`（bash 内建，无外部依赖）→ `done` exitCode 0、stdout `hello\n`、stderr 产物为空（降级静默，无 nice 相关报错）。同时验证既有 `bashResolvable` 在该 PATH 下仍放行（bash 在场）。
- **D2 spawnProcess 降级**：`req.env = { PATH: <同 D1 tmp bin> }`（覆盖 childEnv 的 PATH）→ `command: "bash"`，`args: ["-c", "echo hi"]` → wait() exitCode 0、stdout `hi\n`、stderr 落盘文件无 nice 相关报错。
- **D3 降级不影响预检抛错契约**：D2 同 env 下传 `command: "definitely-not-on-path"` → 仍按既有 `assertExecutableResolvable` 同步抛带可执行名的 Error（nice 降级不得吞掉或改变该契约）。

### R 系：语义回归锁定（nice 在场路径）

- **R1 超时整树 kill 语义**：正常 env（nice 在场），command `echo $$ > <tmp>/victim-pid; sleep 30`，timeoutMs = 500 → outcome `timeout`；轮询确认 `<tmp>/victim-pid` 内 pid 已死（`process.kill(pid, 0)` 抛 ESRCH；重试窗口 ≤2s）——nice 组长下 `kill(-pgid)` 整树回收不变式实测。
- **R2 退出码透传**：正常 env，command `exit 42` → `done` exitCode 恰 42（nice(1) exec 自替换不吞退出码）。
- **R3 哨兵与产物完整**：既有语义靠全量回归（通过命令内含全量 npm test）——`execBashTree` 的哨兵 / fd 直写 / `<id>.report.json` / sha256 链路零变化。
- **R4 agent 链路既有行为**：归入全量回归（u6a/u6b/u6c/u7 系套件全绿即覆盖四态归因 / 超时 kill / SPAWN_ERROR 路径在 nice 分流后的不变性）。

## 6. 通过命令

```
cd <仓库根> && npm run check:all
npx vitest run tests/al-1-nice.test.ts
npx eslint src/verify/run.ts src/runner/spawn/lifecycle.ts tests/al-1-nice.test.ts
全量 npm test → 全绿（基线 74 文件 576 用例，以实跑为准；新增用例另计）
```

## 7. 波后验收（verifier 执行，真实场景）

真实 CLI 链路（隔离 CW_HOME + tmp git 仓）：构造一条 e2e-sh 型验收，command = wrapper 脚本（内部 `ps -o ni= -p $$` 输出自报 + 尾部输出 `<id> PASS` 标记行）→ `node dist/cli.js` 走完整 verify → 通过标准：① 验收 pass（标记行契约不因 nice 破坏）；② `<id>.stdout` 产物内自报 ni 值恰 10；③ report.json / sha256 产物链完整。对照本设计 S5 的断言口径（孙进程继承已由设计 D7 探针实测，不在本场景重复断言）。

## 8. status

pending → building → **pending 派发**（2026-08-22 基线入 git，builder 派发）

> 本节（§8 status）由主 agent 流转更新，不属于防篡改范围；§1-§7 禁止修改。

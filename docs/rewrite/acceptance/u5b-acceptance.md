# u5b 验收标准：human 模式（cw run --spawn human 最小版）

> **锁定文件**：派发基线（已入 git）。builder 与 verifier 禁止修改本文件。
>
> status: pending（pending → building → built → verifying → verified → committed / rejected）

## 目标

交付人肉调度循环：`cw run --root <unitId> --spawn human`——打印每步人该执行的完整指令，轮询账本推进，直至 root closed。canon 依据：§3.3 D7（human 降级：打印指令清单、人执行后交证据，验证价值 100% 保留）、子文档 1 §5.1（human 适配器输出形态）。复用 u1b（loadLedger/frontier 语义）、u2（写命令）、u4a（verify）。

## 规格锁定

### `cw run --root <unitId> [--spawn human] [--poll-ms <n>] [--max-idle-ms <n>]`

- --spawn 缺省即 human（M0 唯一后端；非 human 值 → exit 1 提示 M0 仅支持 human）。
- root unit 必须存在（exit 1 可操作错误）。

**循环逻辑**（每轮：读账本 → 投影 → 找 root 子树内最需人工的一步 → 打印指令 → 等 poll → 重复）：

1. root 子树内存在 `created` unit（含 root 自身）且其尚无 spec → 打印 spec 指令组：
   - 读 brief：`cat <briefRef>`
   - 写 spec.json（给出字段骨架示例：acceptance/contracts/split）
   - `cw evidence submit --kind spec --unit <id> --file spec.json`
   - `cw review submit --unit <id> --verdict-kind spec-review --verdict pass --evidence-refs <specRunId>`（提示：spec 提交后 stdout 会带 runId 信息；无自动 reviewer 时人自任 reviewer，提示语说明这是 human 模式的信任边界）
2. 存在 `spec-frozen` unit → 打印 build 指令组：
   - 在仓库干活并 `git commit`
   - `cw evidence submit --kind build --unit <id> --commit <hash> --run-id <自拟唯一>`
   - `cw verify --unit <id>`
3. 存在 `verified` 未 closed unit → 打印 exec-review 指令：`cw review submit --unit <id> --verdict-kind exec-review --verdict pass`
4. 每轮打印当前快照一行：`[human] <timestamp> root=<id> 状态=<...> 待人工步骤=<spec|build|exec-review|无>`
5. 轮询：账本 totalEvents 变化即重算；--poll-ms 默认 5000。
6. 终止：root 达到 closed → 打印汇总（各 unit 状态 + verify 结果 + `cw report` 提示）exit 0；超过 --max-idle-ms（默认 30min）无事件变化 → exit 1 附「无进展」提示与恢复动作。Ctrl-C 天然中断（无状态残留——账本即状态）。
7. 内部节点（root）的 spec 含 split 声明子 unit 时：循环步骤 1 前先提示为每个 split 子 unit `cw create --id <slug> --brief <文件> --parent <root>`（指令组列出全部待 create 的子 unit）。

## 交付物

| 文件 | 内容 |
|------|------|
| `src/runner/human-loop.ts` | 循环主体（纯读账本 + 打印 + 轮询；不直接写账本——人通过 CLI 写） |
| `src/handlers/run.ts` | 参数解析 + 调 human-loop |
| `src/handlers/index.ts` | 追加 run 注册（只增，不动既有项） |
| `tests/u5b-loop.test.ts` | 单测（指令生成函数逐状态断言） |
| `tests/u5b-e2e.test.ts` | E2E（见下） |

## 单测验收

1. 指令生成：created 无 spec → spec 指令组含 briefRef 路径与三条命令；spec-frozen → build 指令组含 commit/evidence/verify 三步；verified 未 closed → exec-review 指令；无待办 → 空指令。
2. 快照行格式；split 子 unit 待 create 提示。
3. 终止判定：root closed → 汇总；超时路径（max-idle-ms 可注入小值测试，如 100ms）→ exit 1。

## E2E real（tests/u5b-e2e.test.ts——M0 A1 场景雏形）

- tmp git 项目 + 隔离 CW_HOME：测试进程 spawn `node dist/cli.js run --root <id> --spawn human --poll-ms 300`（后台子进程）；测试进程扮演「人」：轮询 runner stdout 文件（stdio 重定向落盘）识别指令类型 → 依次真实调 CLI（create 子 unit → 写 spec.json → evidence submit spec → review → 写代码 commit → evidence build → verify → review exec）→ 断言 runner 最终自然退出 exit 0 且输出含汇总行；账本 root 状态 closed。
- 中断路径：再跑一次 run，max-idle-ms=500 无人操作 → exit 1 且错误含「无进展」。

## 通过命令

```
npm run check:all
npm test          # u4b 并行期以 u5b 自有测试全绿为准
npm run lint      # u5b 领地零输出
```

## 禁改清单

`src/verify/**`、`src/handlers/verify.ts`、`tests/u4a-*`、`tests/u4b-*`（u4b 并行领地）；`src/dispatch.ts`、`src/cli.ts`、`src/testrun/**`、`src/events/types.ts`、`src/store/**`、`src/core/**`、`src/gates/**`、`src/readonly/**`、`src/handlers/` 既有文件（run.ts 新建 + index.ts 只追加注册行除外）；archive/、docs/rewrite/ 其余、tests/ 既有文件。禁 git 写操作；禁 mock；禁 any。

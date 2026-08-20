# u1 验收标准：事件模型 + 账本 + 投影

> **锁定文件**：本文档是派发基线（已入 git）。builder 与 verifier 均禁止修改本文件；主 agent 流转状态只改本行下方 status 字段与 ledger。
>
> status: pending（pending → building → built → verifying → verified → committed / rejected）

## 目标

交付 M0-L0 的数据地基：五类事件的 append-only JSONL 账本（文件锁短事务）、路径布局、fold 投影纯函数与语义状态派生。canon 依据：`.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md` §3.3 D2（事件投影）、§3.4（数据流）、附录 B.3（锁语义——旧实现参考 `archive/src/store/cw-store.ts`）。

## 交付物（文件级，全部新建）

| 文件 | 内容 |
|------|------|
| `src/store/project.ts` | CW_HOME 解析（env `CW_HOME`，默认 `~/.cw`）+ cwd 编码（绝对路径 `/` 与 `.` → `__`，参考旧实现 getEncodedCwd）+ 账本/证据路径函数：`ledgerPath(cwHome, cwd)` = `<home>/<encoded>/events.log`、`evidenceDir(cwHome, cwd, unitId, runId)` |
| `src/store/events-log.ts` | `EventLedger` 类：`append`（锁内：读末 seq → seq+1 → 追加 JSONL 行 + fsync）；`readAll()`；`readUnit(unitId)`；文件锁 = lockfile + `O_EXCL` 原子创建 + stale 检测（30s 阈值 + pid 指纹二次比对防 TOCTOU）+ 有界重试；写入前校验：unit 必须已 UnitCreated（UnitCreated 自身除外）、EvidenceSubmitted.runId 幂等（同 unitId+runId 已存在则拒绝） |
| `src/core/fold.ts` | `fold(events): Projection`（纯函数，把 LedgerEvent[] 折叠为 `src/events/types.ts` 的 Projection）；`deriveStatus(proj, specGate): UnitStatus`——specGate 为注入的 `(spec: SpecSubmittedPayload) => SpecRulesResult`（u3 交付完整五规则；u1 不实现规则本身）。派生规则：`created` = 存在；`spec-frozen` = 最后一条 spec 过 specGate ∧ 之后存在 verdictKind=spec-review 且 verdict=pass 的 VerdictSubmitted；`verified` = spec-frozen ∧ 最后一条 result=pass 的 VerifyRan.acceptanceIds ⊇ 该 spec 全部验收 id；`closed` = verified ∧ 存在 verdictKind=exec-review 且 verdict=pass |
| `src/events/types.ts` | **已由主 agent 建立（契约层）**。u1 是该文件 owner：允许**追加**新类型/函数签名，**禁止**修改既有定义的名与义 |
| `tests/u1-fold.test.ts` | fold 与 deriveStatus 表驱动单测 |
| `tests/u1-ledger.test.ts` | 账本单测：追加/seq 递增/幂等拒绝/孤儿事件拒绝/锁 stale |
| `tests/u1-e2e.test.ts` | 真实子进程 E2E（见下） |

## 接口契约（不得偏离）

- 类型全部 import 自 `src/events/types.ts`（本 unit 可追加，不改既有）。
- `EventLedger.append` 拒绝时抛带可操作信息的 Error（指明缺口与恢复动作，如「unit u-x 不存在，先 create」），不用返回码。
- `deriveStatus` 对 spec 的取用 = **最后一条** SpecSubmitted（重新提交 spec = 打回重审的路径）。
- 锁等待有界（总上限 10s），超时抛错（不静默重试到天荒地老）。

## 单测验收（逐条可查）

1. fold：合法完整序列（created→spec→verdict(spec-review,pass)→evidence→verify(pass,全覆盖)→verdict(exec-review,pass)）→ closed。
2. fold：spec 提交两次，投影只认最后一条（specs 长度 2，deriveStatus 用后者）。
3. fold：verify 覆盖不全（acceptanceIds 缺 A2）→ 停留 spec-frozen 而非 verified。
4. fold：replay 幂等——同一事件数组 fold 两次，两次结果 deep-equal。
5. deriveStatus 注入 gate：gate fail → spec 不冻结（停 created）；换 pass gate（同事件）→ 可冻结（fold 纯函数性，gate 是唯一外部输入）。
6. ledger：append 后 readAll 首尾 seq 连续、JSON 可解析；同 unitId+runId 二次 EvidenceSubmitted 被拒且账本不变。
7. ledger：对不存在 unit 的 SpecSubmitted 被拒（孤儿防护）。
8. ledger：锁文件 stale（手工写未来时间戳 + 死 pid）时能夺取锁继续写。

## E2E real 验收（真实子进程，非 mock）

- `tests/u1-e2e.test.ts`：fork 两个真实 node 子进程并发对**同一账本**各 append 20 条（各自先 create 不同 unit），全部完成后 readAll 满足：40 条无交错损坏（每行 JSON 可解析）、seq 全局 1..40 连续不重复、两 unit 事件各自完整（探针：并发写串行化）。
- 子进程脚本放 `tests/fixtures/`（内联 node -e 或脚本文件均可，真实进程为准）。

## 通过命令（verifier 逐条实跑）

```
npm run check:all   # tsc src+tests 零错误
npm test            # 全部测试绿（含既有 smoke 3 条）
npm run lint        # 零 error 零 warning
```

## 禁改清单

- 本验收文档、`docs/rewrite/` 其他文件、`archive/`、`tests/smoke.test.ts`、`src/cli.ts`、`src/index.ts`。
- 禁止 git 写操作（add/commit/push 由主 agent 执行）。
- 禁止引入 mock 框架（零 mock 哲学，测试用真实 fs/tmp/子进程）。

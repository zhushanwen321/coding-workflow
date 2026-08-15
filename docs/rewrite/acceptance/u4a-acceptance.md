# u4a 验收标准：干净重跑 + cw verify

> **锁定文件**：派发基线（已入 git）。builder 与 verifier 禁止修改本文件。
>
> status: pending（pending → building → built → verifying → verified → committed / rejected）

## 目标

交付验证执行框架：`cw verify --unit <id>` 在干净 checkout + 隔离环境重跑该 unit 冻结验收，产物落盘入账。canon 依据：§3.4 数据流、附录 B.4 verify 契约、子文档 2（design-child-testrun.md）五条纪律之①③④⑤。复用 u1（账本/投影）、u2（common.ts 出口）、u3（gate）、契约层 `src/testrun/types.ts`（EvidenceReport，已由主 agent 预建）。

## M0 命令规格（锁定）

### `cw verify --unit <id> [--timeout-ms <n>]`

前置：unit 存在（exit 2 附错误）；存在至少一条 SpecSubmitted 且存在至少一条 EvidenceSubmitted（commit 可 checkout）——缺失 = exit 2（环境错误：spec 或 build 证据缺失）。

流程：
1. 取**最后一条** spec（冻结验收）与最后一条 build evidence 的 commit。
2. `cleanCheckout`：`git clone --quiet <cwd 仓库> <mktempdir>/ws` + `git -C ws checkout --quiet <commit>`；clone/checkout 失败 = exit 2。checkout 后 `git status --porcelain` 必须为空（探针 P7：干净性自证）。
3. 逐验收执行（spec.acceptance 中 `type ≠ manual` 的每条）：必须**有 command**——非 manual 无 command = 该条 fail 且错误信息指明「验收 <id> 缺 command」；`spawnSync("bash", ["-c", command])`，cwd=checkout 目录，env 隔离（CW_HOME 指向独立 tmp、PATH 继承），timeout 默认 10min（--timeout-ms 覆盖，超时 kill 且该条 fail、stderr 记 timeout）。
4. manual 用例：不执行，**并入 acceptanceIds**（免机器验证语义——VerifyRanPayload.acceptanceIds = 机器判定 pass 的 ∪ manual 的）。
5. 产物落盘 `~/.cw/<encoded>/evidence/<unitId>/<runId>/`：每条验收 `<acceptId>.stdout`/`.stderr`（或 .timeout 标记）+ 总报告 `report.json`（EvidenceReport 结构：cases + exitCode + rawPath 指向自身）。
6. 判定：全 pass → result=pass，exit 0；任一 fail → result=fail，exit 1（stderr 列失败验收 id 与原因）；环境失败 → exit 2。
7. `append VerifyRan{runId（自生成，含随机性保证唯一）, reportHash = sha256(report.json 字节), result, acceptanceIds}`——**无论 pass/fail 都入账**（fail 的 verify 是打回依据，审计必需）；仅 exit 2（环境错误）不入账。
8. stdout 人可读摘要：逐条 `<id> <pass|fail|manual>` + 总结行。

### 同 commit 重跑一致性（探针 P2）

同一 unit 同一 commit 连续 verify 两次：两次 report.json 的 `cases`（id/status 序列）与 `exitCode` 逐字段全等（runId/rawPath 因目录不同天然不同，不作比对字段）。

## 交付物

| 文件 | 内容 |
|------|------|
| `src/verify/checkout.ts` | `cleanCheckout(repoDir, commit): {dir} \| {error}`（mkdtemp 由本模块管理；失败清理临时目录） |
| `src/verify/run.ts` | `runAcceptances(checkoutDir, acceptance[], evidenceBaseDir, timeoutMs)`：逐条执行 + 产物落盘，返回逐条结果（id/status/stdoutPath/stderrPath/timeout） |
| `src/handlers/verify.ts` | 上述组装 + VerifyRan 入账 + exit 语义 |
| `src/handlers/index.ts` | 追加 verify 注册（只增一行注册，不动其他命令） |
| `tests/u4a-verify.test.ts`、`tests/u4a-e2e.test.ts` | 单测 + E2E |

## 单测验收

1. checkout：真实 tmp git 仓库（init + 2 commits）→ cleanCheckout 检出第 1 个 commit → 目录内容与该 commit 一致（第 2 个 commit 的文件不存在）；git status --porcelain 为空。
2. checkout：不存在的 commit → error 返回（不抛裸异常）。
3. runAcceptances：3 条验收（真过 / 真挂 / sleep 超时——timeout-ms 给 500ms、命令 sleep 2）→ pass/fail/timeout 判定正确、产物文件存在且非空（挂的 stderr 有内容）。
4. 非 manual 无 command → fail + 错误信息含「验收 <id> 缺 command」。
5. exit 语义：全过 exit 0；有 fail exit 1 且 stderr 列失败 id；缺 spec/evidence exit 2。

## E2E real（tests/u4a-e2e.test.ts，真实子进程 + tmp git 项目 + 隔离 CW_HOME）

- tmp git 项目（含一个真实可通过的验收命令如 `node -e "process.exit(0)"` 与一条真实挂的命令）+ CLI 全流程：create → evidence submit --kind spec → evidence submit --kind build（真实 commit）→ review submit（spec-review pass）→ **`node dist/cli.js verify --unit <id>`** → exit 1（含挂的用例）；events.log 增 VerifyRan（result=fail, acceptanceIds 含 pass 的 + manual 的、不含 fail 的——若 spec 有 manual 用例）。
- 修好（换全过命令重新提交 spec+evidence+review）再 verify → exit 0 + VerifyRan(result=pass)；随后 `cw status`（真实子进程）显示该 unit verified——**四 unit 端到端首个全链场景**。
- P2：同 commit 连续两次 verify，断言两次 report.json cases/exitCode 全等。
- P7：verify 后对 checkout 临时目录断言 git status 干净（若目录已清理则改为在 runAcceptances 单测断言）。

## 通过命令

```
npm run check:all
npm test          # 并行期以 u4a 自有测试文件全绿为准
npm run lint      # u4a 领地零输出
```

## 禁改清单

`src/dispatch.ts`、`src/cli.ts`、`src/testrun/types.ts`（契约层）；`src/readonly/**`、`tests/u1b-*`（u1b 并行领地）；`src/events/types.ts`、`src/store/**`、`src/core/**`、`src/gates/**`、`src/handlers/` 既有文件（common/create/evidence-submit/review-submit/spec-schema——发现缺陷上报，不擅改；verify.ts 与 index.ts 追加行除外）；archive/、docs/rewrite/ 其余、tests/ 既有文件。禁 git 写操作；禁 mock；禁 any。

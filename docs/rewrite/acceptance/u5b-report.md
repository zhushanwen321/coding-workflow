# u5b 验收报告：human 模式（cw run --spawn human）

> verifier 独立对抗式验收。基线 commit `5183fb2`，验收时 HEAD = `5183fb2`（工作区含 u4b/u5b 未提交交付物）。
> 验收文档：`docs/rewrite/acceptance/u5b-acceptance.md`（锁定文件）。

## 总结论：PASS

19/19 测试绿；eslint 零输出；check:all 通过；防篡改零违规；3 项偏差全部评判合理；4 条行为对抗抽查全部符合验收文档。

## 1. 防篡改

| 项 | 结果 |
|----|------|
| `git diff 5183fb2 -- docs/rewrite/acceptance/u5b-acceptance.md` | 空（无篡改） |
| 工作区文件 sha256 | `bb8583f1b16335a05799c57341db24b5bc9f45046fa537bffe66133957119923` |
| 基线 commit 内同文件 sha256 | `bb8583f1b16335a05799c57341db24b5bc9f45046fa537bffe66133957119923`（一致） |

`git diff 5183fb2 --stat` 共 6 文件，逐一定性：

| 文件 | 定性 |
|------|------|
| `src/handlers/index.ts` | u5b 领地（追加 run 注册）。minor 观察：除追加 import/注册项外还更新了一行既有注释（「verify 属 u4a」→「…；run 属 u5b」），字面超出「只追加注册行」，实质必要且无害 |
| `src/handlers/verify.ts`、`src/verify/run.ts`、`tests/u4a-e2e.test.ts`、`tests/u4a-verify.test.ts` | u4b 并行豁免（非 u5b 范围） |
| `AGENTS.md` | 认知外改动（e2e 测试基建描述更新，非 u5b/u4b 领地；verifier 不动，交主 agent 判断来源） |

契约层/store/core/gates/readonly/testrun/handlers 既有文件（index.ts 之外）零改动。untracked：u5b 领地（`src/runner/human-loop.ts`、`src/handlers/run.ts`、`tests/u5b-loop.test.ts`、`tests/u5b-e2e.test.ts`）+ u4b 豁免（`src/verify/name-match.ts`、`src/verify/red-phase.ts`、`tests/u4b-*`）+ 认知外（drawio 系列产物）。u5b 领地零越界。

## 2. 命令实跑

| 命令 | 结果 |
|------|------|
| `npx vitest run tests/u5b-loop.test.ts tests/u5b-e2e.test.ts` | 2 files / **19 passed**（loop 17 + e2e 2），4.0s |
| `npx eslint src/runner/human-loop.ts src/handlers/run.ts src/handlers/index.ts tests/u5b-loop.test.ts tests/u5b-e2e.test.ts` | exit 0，零输出 |
| `npm run check:all`（tsc src + tests） | 通过，无报错（u4b 中途态未影响） |
| `npm run build` | 通过 |

全量 `npm test` 未跑：验收文档通过命令明确「u4b 并行期以 u5b 自有测试全绿为准」（u4b 测试中途态结果无判定价值）。`npm test` pretest 已含 build。

## 3. 条款对照（验收文档逐项）

**循环逻辑**
- 步骤 7（split 待 create 优先于步骤 1）：`buildStepInstruction` 中 `pendingSplitEntries` 非空即返回 create 指令组，列出全部待 create 子 unit（单测断言 2 个子 unit 全列出、briefRef 缺省时给 `<自建 brief 文件路径>` 占位）。符合。
- 步骤 1（created 无 spec → spec 指令组）：cat briefRef + spec.json 骨架（acceptance/contracts/split）+ evidence submit spec + review submit spec-review（偏差 1，见 §4）。符合（含偏差）。
- 步骤 2（spec-frozen → build 三步）：git commit / evidence submit build（--commit + --run-id）/ cw verify。符合。
- 步骤 3（verified 未 closed → exec-review）：单条 review submit 命令。符合。
- 步骤 4（快照行）：`[human] <ISO时间戳> root=<id> 状态=<status> 待人工步骤=<kind|无>`，单测三态断言。符合（kind 枚举偏差 2，见 §4）。
- 步骤 5（轮询）：totalEvents 变化即重算，--poll-ms 默认 5000（run.ts `DEFAULT_POLL_MS`）。符合。
- 步骤 6（终止）：root closed → 汇总（各 unit 状态 + lastVerify + cw report 提示）exit 0；超 max-idle-ms（默认 1800000）→ exit 1 含「无进展」+ 恢复动作。单测 + E2E 双覆盖。符合。
- root 不存在 → exit 1 可操作错误；--spawn 非 human → exit 1 提示 M0 仅支持 human。符合（单测 + 对抗实测）。

**E2E real**
- 全链：runner 真子进程（`spawn(process.execPath, [CLI_PATH, 'run', ...])`，stdio 重定向落盘）；测试进程 `spawnSync` 真实调 CLI 全部写命令（create root → spec → create 子 → 子 spec → build+commit+evidence → verify → exec-review → root build/evidence/verify → root exec-review）；两次真实 `cw verify`（impl、demo，exit 0 断言附 stdout/stderr 诊断）；`waitExit` 断言 runner 自然退出 0；stdout 含汇总（demo/impl closed lastVerify:pass）；`cw status` 真实子进程复核 root closed。无跳步、无 mock。
- 中断路径：max-idle-ms=500 无人操作 → exit 1、stderr 含「无进展」「恢复动作」；中断后账本 root 仍 created（账本即状态）。符合。

## 4. 三项偏差评判

**偏差 1：spec 指令组 review 命令不带 --evidence-refs —— 合理（验收文档笔误，实测证实）**
- 读码：`evidence submit --kind spec` 只 append `SpecSubmitted`（payload 为 specHash/acceptance/contracts/split，无 runId；stdout 也只回 specHash）；runId 仅存在于 build 形态 `EvidenceSubmitted`。`review submit` 的 `--evidence-refs` 校验每个 runId 必须已在该 unit 的 EvidenceSubmitted 中。
- 实测（verifier 真子进程）：spec 提交后立刻 `review submit --verdict-kind spec-review --verdict pass --evidence-refs whatever-run` → **exit 1**（runId 不存在，unit 无任何已入账 runId）；不带 refs → exit 0。照验收文档原命令执行必然被拒。
- `--evidence-refs` 为可选 flag，省略合法。偏差在源码头部注释显式声明（冲突表面化）。评判：builder 纠正正确。

**偏差 2：快照 kind 枚举增加 create 与 spec-review —— 合理**
- `create`：循环逻辑第 7 条要求 split 待 create 时先提示 create 指令组，快照行「待人工步骤」列需要对应的 kind 值，否则该状态在快照行中无法表达。文档枚举 `spec|build|exec-review|无` 自身没给 create 位置，属文档枚举遗漏。
- `spec-review`：防空转闭环——人执行完 `evidence submit --kind spec` 但尚未 `review submit` 时，unit 状态仍 created、已有 spec，文档三步枚举匹配不到任何指令，循环会对该 unit 空转到 max-idle。补 spec-review 指令（提示补 review，或改 spec 重提）使中间态可继续推进。两者均有单测覆盖（验收1 第 5 用例、验收2 create 用例）。评判：必要补全，非私改语义。

**偏差 3：E2E 的 unit 用例 fixture 用真实 node 进程输出 vitest JSON 形状产物 —— 合理（无验证真空）**
- E2E 被测物是 human 循环与状态机收敛，非 vitest 适配器本身。tmp repo 无 node_modules，真 vitest 需 npx 触发网络，不可得。
- 适配器真实性由 u5 领地 `tests/u5-vitest.test.ts` 保证：verifier 实跑 **6/6 passed**（真 fixture：真 vitest JSON、失败断言真实构造、默认 reporter stdout 抛错）。E2E 的 A2 command 为真实 `node -e` 进程产出合规 JSON（尾部 `-- --reporter=json` 满足 translate includes 检查）；A1（core）走真 e2e-real `node app.js` 输出 A1 PASS。验证链闭环。评判：折衷边界清晰，不掩盖问题。

## 5. 行为对抗抽查（真实子进程）

1. **--root 不存在**：`node dist/cli.js run --root ghost` → exit 1，stderr：`--root "ghost" 不存在…恢复动作：运行 cw status 查看全部 unit 确认 id，或 cw create…`。可操作。符合。
2. **--spawn pi**：root 存在前置下 → exit 1，stderr：`非法 --spawn "pi"：M0 仅支持 human…恢复动作：用 --spawn human 或省略该参数`。符合。
3. **运行中同账本写入无关 unit 事件**：runner（poll 200ms，max-idle 3000ms）跑 1s 后同账本 `cw create --id other`。结果：runner **exit 1 而非 0**，stdout 全程无「已 closed」（不误判 root closed），stderr「无进展（totalEvents 停在 2）」；退出时刻 ≈ 启动后 4s——totalEvents 变化重置了 idle 计时（3s 从写入时刻重计）。与文档「账本 totalEvents 变化即重算」字面一致。观察项（非 bug）：同账本持续高频无关事件理论上可无限推迟 max-idle 退出，属 M0 语义（totalEvents 全局粒度）的直接后果，如需收紧属后续 unit 范畴。
4. **--poll-ms 5 极小值**：跑 4s wall，进程 CPU 时间 0.37s（6.1%）——sleep 生效，无忙轮询；5509 行输出（每轮快照 + 指令组，约 800 轮）。不爆 CPU。符合。

## 6. 认知外改动清单（verifier 不动，交主 agent）

- `AGENTS.md`（M）：e2e 测试基建描述更新（tests/helpers/ 路径变更相关），非 u5b/u4b 交付物。
- 未跟踪：`wave-endstate-execution.drawio`（+png/svg/`.bkp`）：设计图产物，非代码。

## 7. 结论

PASS。u5b 领地交付与验收文档（含 3 项已披露合理偏差）一致，测试真实无跳步，防篡改零违规。上述 index.ts 注释行与 totalEvents 全局粒度两条 minor 观察不构成验收阻碍。
